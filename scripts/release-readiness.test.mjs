import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [packageJson, gradle, workflow, readme, buildNotes, readiness] = await Promise.all([
  read('../package.json').then(JSON.parse),
  read('../android/app/build.gradle.kts'),
  read('../.github/workflows/build-and-release-apk.yml'),
  read('../README.md'),
  read('../BUILD-NOTES.md'),
  read('../docs/RELEASE-READINESS.md'),
]);

test('release application ID and version stay aligned with package metadata', () => {
  const applicationId = gradle.match(/applicationId\s*=\s*"([^"]+)"/)?.[1];
  const namespace = gradle.match(/namespace\s*=\s*"([^"]+)"/)?.[1];
  const versionName = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(applicationId, 'com.superdeepseek.app');
  assert.equal(namespace, applicationId);
  assert.equal(versionName, packageJson.version);
});

test('release remains gated on APK build and the complete emulator matrix', () => {
  assert.match(workflow, /needs:\s*\[build-apk, android-instrumented-tests\]/);
  assert.match(workflow, /api-level:\s*\[30, 34, 35\]/);
  assert.match(workflow, /name: Android Emulator Tests \(API \$\{\{ matrix\.api-level \}\}\)/);
});

test('publishable APK gate verifies manifest, versionCode, checksum, signer, and sandbox payload', () => {
  const match = workflow.match(/- name: Gate publishable APK identity, checksum, signature, and sandbox([\s\S]*?)(?=\n      - name: Upload APK Artifact)/);
  assert.ok(match, 'publish-only artifact gate must exist before upload');
  const gate = match[1];
  for (const required of [
    'sha256sum --check "$APK_PATH.sha256"',
    'aapt dump badging "$APK_PATH"',
    'com.superdeepseek.app',
    'versionName',
    'versionCode',
    'assets/sandbox/rootfs.json',
    'libproot',
    'libtalloc',
    'EXPECTED_CERT_SHA256',
    '75ebff1ca33e27e8f14d98122dc5e6db811a1c77f37133b7bbbd24cd75ba3803',
    'apksigner verify --verbose --print-certs "$APK_PATH"',
  ]) assert.ok(gate.includes(required), `missing release invariant: ${required}`);
  assert.ok(match[0].includes('inputs.publish == true') && match[0].includes('refs/heads/main'));
});

test('GitHub-generated source archives track the latest tag without duplicate source bundles', () => {
  const releaseStart = workflow.indexOf('  release:');
  const releaseBlock = workflow.slice(releaseStart);
  const actionStart = releaseBlock.indexOf('- uses: softprops/action-gh-release@v3');
  const syncStart = releaseBlock.indexOf('- name: Sync latest tag with release commit and remove redundant source archives');
  assert.ok(releaseStart >= 0 && actionStart >= 0 && syncStart > actionStart,
    'tag sync and legacy-asset cleanup must run after the release assets are published');

  const releaseConfig = releaseBlock.slice(actionStart, syncStart);
  assert.ok(releaseConfig.includes('Source code (zip)') && releaseConfig.includes('Source code (tar.gz)'),
    'release notes must direct users to the automatic GitHub source archives');
  assert.ok(!releaseConfig.includes('super-deepseek-source-v*.zip'),
    'the release must not upload a duplicate standalone source ZIP');
  assert.doesNotMatch(workflow, /Package source archive for the exact release commit/,
    'the standalone source packaging step must be removed');

  assert.ok(releaseBlock.includes('group: super-deepseek-release-${{ github.ref }}') &&
    releaseBlock.includes('cancel-in-progress: false'),
    'release publishing must be serialized to avoid overlapping latest updates');
  assert.ok(releaseBlock.includes('Confirm main release is not superseded') &&
    releaseBlock.includes('commits/main') &&
    releaseBlock.includes("steps.release_freshness.outputs.current == 'true'"),
    'stale main commits must be skipped before they can update the release');

  const sync = releaseBlock.slice(syncStart);
  assert.ok(sync.includes("if: steps.rel_cfg.outputs.tag == 'latest' && steps.release_freshness.outputs.current == 'true'"));
  assert.ok(sync.includes('git/refs/tags/latest'));
  assert.ok(sync.includes('-f sha="$GITHUB_SHA"') && sync.includes('-F force=true'),
    'latest tag must be force-updated to the tested release commit');
  assert.ok(sync.includes('git/ref/tags/latest') && sync.includes('tag_sha" != "$GITHUB_SHA"'),
    'the updated tag must be verified against the release commit');
  assert.ok(sync.includes('repos/${GITHUB_REPOSITORY}/releases') &&
    sync.includes('.tag_name == "latest" or (.tag_name | startswith("v"))'),
    'cleanup must include latest and historical version-tagged releases');
  assert.ok(sync.includes('super-deepseek-source-v[^/]+\\\\.zip'),
    'cleanup must only target the old named source ZIP and its checksum');
  assert.ok(sync.includes('--method DELETE') && sync.includes('delete_failed=true'),
    'cleanup must continue attempting other stale assets even if a deletion fails');
});
test('published release still requires permanent signing material, never a test key', () => {
  assert.match(workflow, /Prepare permanent release signing key[\s\S]*?BDS_KEYSTORE: \$\{\{ secrets\.BDS_KEYSTORE \}\}/);
  assert.match(workflow, /needs:\s*\[build-apk, android-instrumented-tests\]/);
  assert.match(workflow, /for name in BDS_KEYSTORE BDS_KEYSTORE_PASSWORD BDS_KEY_ALIAS BDS_KEY_PASSWORD/);
});

test('trusted publishing refs protect the permanent signer and treat tags as data', () => {
  const trustedPublishCondition = "if: (github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))) || (github.event_name == 'workflow_dispatch' && inputs.publish == true && github.ref == 'refs/heads/main')";

  const permanentKeyStart = workflow.indexOf('- name: Prepare permanent release signing key');
  const temporaryKeyStart = workflow.indexOf('- name: Prepare temporary signing key', permanentKeyStart);
  const permanentKey = workflow.slice(permanentKeyStart, temporaryKeyStart);
  assert.ok(permanentKeyStart >= 0 && temporaryKeyStart > permanentKeyStart && permanentKey.includes(trustedPublishCondition),
    'permanent signing must independently enforce the trusted-event/ref condition');

  const apkGateStart = workflow.indexOf('- name: Gate publishable APK identity, checksum, signature, and sandbox');
  const uploadApkStart = workflow.indexOf('- name: Upload APK Artifact', apkGateStart);
  const apkGate = workflow.slice(apkGateStart, uploadApkStart);
  assert.ok(apkGateStart >= 0 && uploadApkStart > apkGateStart && apkGate.includes(trustedPublishCondition),
    'the APK gate must independently enforce the trusted-event/ref condition');

  const releaseStart = workflow.indexOf('  release:');
  const releaseJob = workflow.slice(releaseStart);
  assert.ok(releaseStart >= 0 && releaseJob.includes(trustedPublishCondition),
    'the release job itself must block PR and untrusted-ref publication');
  assert.ok(workflow.includes('permissions:' + String.fromCharCode(10) + '  contents: read'),
    'build and test jobs must receive only read access to repository contents');
  assert.ok(releaseJob.includes('permissions:' + String.fromCharCode(10) + '      contents: write'),
    'write access must be scoped to the release-publishing job');

  const historyGuardStart = workflow.indexOf('- name: Verify release commit is on trusted main history');
  const historyGuardEnd = workflow.indexOf('- name: Prepare permanent release signing key', historyGuardStart);
  const historyGuard = workflow.slice(historyGuardStart, historyGuardEnd);
  assert.ok(historyGuardStart >= 0 && historyGuardEnd > historyGuardStart && historyGuard.includes('git merge-base --is-ancestor "$GITHUB_SHA" FETCH_HEAD'),
    'tag/manual release history must be checked before secrets are exposed');

  const releaseConfigStart = workflow.indexOf('- id: rel_cfg');
  const releaseActionStart = workflow.indexOf('- uses: softprops/action-gh-release@v3', releaseConfigStart);
  const releaseConfig = workflow.slice(releaseConfigStart, releaseActionStart);
  assert.ok(releaseConfigStart >= 0 && releaseActionStart > releaseConfigStart, 'release configuration step must exist');
  assert.ok(releaseConfig.includes('if [[ "$GITHUB_REF" == refs/tags/v* ]]'),
    'tag checks must use environment data instead of interpolating ref text into shell source');
  assert.ok(!releaseConfig.includes('${{ github.ref') && !releaseConfig.includes('${{ github.ref_name'),
    'untrusted ref values must not be interpolated into shell source; workflow-level if conditions are allowed');
});
test('README and build notes do not freeze changing Chromium acceptance totals', () => {
  for (const [name, doc] of [['README.md', readme], ['BUILD-NOTES.md', buildNotes]]) {
    assert.doesNotMatch(doc, /\b\d+\s+(?:Generative UI |GenUI )?acceptance checks\b/i, name);
    assert.match(doc, /RELEASE-READINESS\.md/, name);
  }
});

test('release checklist covers every requested regression family and redaction policy', () => {
  for (const phrase of [
    'CAPTCHA', 'OTP', 'chat reply', 'restart/session restore', 'Rotation',
    'keyboard', 'Back', 'GenUI', 'Preview', 'Code', 'oversized files',
    'agent progress', 'Stop', 'Linux sandbox', 'MCP failure', 'Deep Research',
    'Bengali', 'RTL', '16 KB', 'SHA-256', 'certificate', 'Mandatory log redaction',
    'PASS', 'FAIL', 'BLOCKED', 'NOT TESTED',
  ]) assert.ok(readiness.toLowerCase().includes(phrase.toLowerCase()), `checklist is missing: ${phrase}`);
});
