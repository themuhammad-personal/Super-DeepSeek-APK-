// Release-identity and bundle-consistency guards.
//
// Every one of these invariants has already been violated once in this
// project's history, and each violation breaks the in-app updater or the engine
// silently on a phone, where no unit test would notice:
//
//  * the version lives in two files (package.json, build.gradle.kts) and the
//    updater compares the *release note* version with the *installed*
//    versionName, so a drift between them means updates are offered forever or
//    never at all;
//  * versionCode must stay above every previously published build, or Android
//    refuses to install the new APK over the old one;
//  * MainActivity loads the engine module by module, and a module that is
//    renamed or dropped in bds-assets but not in NATIVE_MODULES disappears from
//    the running app without a build error (the loader skips missing assets).
//
// Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../../../..');
const GRADLE = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle.kts'), 'utf8');
const MAIN = fs.readFileSync(
  path.join(ROOT, 'android/app/src/main/java/com/superdeepseek/app/MainActivity.kt'),
  'utf8'
);
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUNDLE = path.join(ROOT, 'android/app/src/main/bds-assets/bds');

const semver = PKG.version.split('.').map((n) => Number.parseInt(n, 10));
assert.equal(semver.length, 3, 'package.json version must be major.minor.patch');
assert.ok(semver.every((n) => Number.isInteger(n) && n >= 0), 'package.json version is numeric');

/** `versionName = "2.71.0"` */
const gradleVersionName = GRADLE.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
/** `versionCode = (2_710_000L + bdsBuildId)` — the base of the code, without the CI run number. */
const gradleVersionCodeBase = Number.parseInt(
  GRADLE.match(/versionCode\s*=\s*\(([\d_]+)L\s*\+\s*bdsBuildId\)/)?.[1]?.replaceAll('_', '') ?? '',
  10
);
/** `NATIVE_MODULES = listOf("sd-native.js", …, "sd-genui-panel.js")` */
const nativeModules = (() => {
  const block = MAIN.match(/NATIVE_MODULES\s*=\s*listOf\(([\s\S]*?)\)\s*\n/)?.[1];
  assert.ok(block, 'NATIVE_MODULES list not found in MainActivity.kt');
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
})();

test('the engine version is the same in package.json and build.gradle.kts', () => {
  assert.ok(gradleVersionName, 'versionName not found in build.gradle.kts');
  assert.equal(
    gradleVersionName,
    PKG.version,
    `package.json says ${PKG.version}, build.gradle.kts says ${gradleVersionName}: ` +
      'the updater would compare the installed versionName with the release note and break'
  );
});

test('versionCode keeps increasing with the version (major*1e6 + minor*1e4 + patch*1e3)', () => {
  assert.ok(
    Number.isInteger(gradleVersionCodeBase),
    'versionCode must stay `(2_710_000L + bdsBuildId)` so every CI build of a release is above the last one'
  );
  const [major, minor, patch] = semver;
  const expected = major * 1_000_000 + minor * 10_000 + patch * 1_000;
  assert.equal(
    gradleVersionCodeBase,
    expected,
    `versionCode base is ${gradleVersionCodeBase}, expected ${expected} for version ${PKG.version}: ` +
      'an APK whose versionCode is not higher refuses to install over the previous one'
  );
});

test('every engine module MainActivity loads exists in the bundle', () => {
  assert.ok(nativeModules.length >= 10, `only ${nativeModules.length} native modules found`);
  const missing = nativeModules.filter((name) => !fs.existsSync(path.join(BUNDLE, name)));
  assert.deepEqual(missing, [], `MainActivity loads modules that are not in bds-assets/bds: ${missing.join(', ')}`);
});

test('every module in the bundle is loaded (no script left behind)', () => {
  const loaded = new Set(nativeModules);
  // Loaded by other means: the base engine, styles, and pages.
  const notModules = new Set(['content.js', 'injected.js', 'content.css', 'our-skin.css', 'sd-genui.css', 'sandbox.js', 'sandbox.html']);
  const orphans = fs
    .readdirSync(BUNDLE)
    .filter((name) => name.endsWith('.js') && !loaded.has(name) && !notModules.has(name));
  assert.deepEqual(orphans, [], `engine scripts nobody loads (typo? dead file?): ${orphans.join(', ')}`);
});

test('the module load order respects its documented dependencies', () => {
  const index = (name) => nativeModules.indexOf(name);
  const pairs = [
    ['sd-agent.js', 'sd-run.js'],        // sd-run reads sd-agent's history API
    ['sd-genui-protocol.js', 'sd-genui.js'],
    ['sd-genui-host.js', 'sd-genui.js'],
    ['sd-genui.js', 'sd-genui-viewer.js'],
    ['sd-genui.js', 'sd-genui-inline.js'],
    ['sd-genui.js', 'sd-artifacts.js'],
    ['sd-genui-frame.js', 'sd-genui-mcp.js'],
  ];
  for (const [before, after] of pairs) {
    assert.ok(index(before) >= 0, `${before} is no longer loaded`);
    assert.ok(index(after) >= 0, `${after} is no longer loaded`);
    assert.ok(
      index(before) < index(after),
      `${before} must load before ${after} (it is ${index(before)} vs ${index(after)})`
    );
  }
});

test('the build docs name the current version', () => {
  const notes = fs.readFileSync(path.join(ROOT, 'BUILD-NOTES.md'), 'utf8');
  const majorMinor = `${semver[0]}.${semver[1]}`;
  assert.ok(
    notes.includes(majorMinor),
    `BUILD-NOTES.md does not mention ${majorMinor}: a maintainer following it builds a different release than the one in package.json`
  );
});

test('package-lock.json stays aligned with package.json for clean npm ci on GitHub Actions', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, PKG.version, `package-lock.json root version ${lock.version} != ${PKG.version}`);
  assert.equal(
    lock.packages?.['']?.version,
    PKG.version,
    `package-lock.json packages[""].version ${lock.packages?.['']?.version} != ${PKG.version}`
  );
});

test('every bundled JS engine script in bds-assets/bds parses cleanly as a classic WebView script', () => {
  const jsFiles = fs.readdirSync(BUNDLE).filter((name) => name.endsWith('.js')).sort();
  assert.ok(jsFiles.length >= 20, `expected >= 20 bundled JS files, found ${jsFiles.length}`);
  for (const name of jsFiles) {
    const src = fs.readFileSync(path.join(BUNDLE, name), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: name }), `${name} failed classic JS syntax parse`);
  }
});
