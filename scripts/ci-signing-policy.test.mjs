import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/build-and-release-apk.yml', import.meta.url), 'utf8');
const gradle = await readFile(new URL('../android/app/build.gradle.kts', import.meta.url), 'utf8');

test('the Arena working branch runs CI without enabling publication', () => {
  assert.ok(workflow.includes('      - "arena/**"'));
  assert.ok(workflow.includes("github.event_name == 'push' && github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/tags/v')"));
  assert.ok(workflow.includes("if: (github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v'))) || (github.event_name == 'workflow_dispatch' && inputs.publish == true && github.ref == 'refs/heads/main')"));
});

test('CI runs connected Android tests across the stability-plan API matrix', () => {
  assert.ok(workflow.includes('  android-instrumented-tests:'));
  assert.ok(workflow.includes('uses: reactivecircus/android-emulator-runner@v2'));
  assert.ok(workflow.includes('Enable KVM for hardware-accelerated emulator'));
  assert.ok(workflow.includes('api-level: [30, 34, 35]'));
  assert.ok(workflow.includes('api-level: ${{ matrix.api-level }}'));
  assert.ok(workflow.includes("./gradlew --no-daemon connectedDebugAndroidTest --stacktrace --info 2>&1 | tee /tmp/android-instrumented.log"));
  assert.ok(workflow.includes('Annotate Android instrumentation failures'));
  assert.ok(workflow.includes("echo \"::error::$line\""));
  assert.ok(workflow.includes('Summarize Android instrumentation result'));
  assert.ok(workflow.includes('tail -180 /tmp/android-instrumented.log'));
  assert.ok(workflow.includes('name: android-instrumented-test-reports'));
  assert.ok(workflow.includes('cp -r android/app/src/main/bds-assets/bds android/app/src/main/assets/bds'));
});

test('publishable workflows require all permanent signing secrets', () => {
  assert.match(workflow, /Prepare permanent release signing key[\s\S]*?BDS_KEYSTORE: \$\{\{ secrets\.BDS_KEYSTORE \}\}/);
  for (const secret of ['BDS_KEYSTORE', 'BDS_KEYSTORE_PASSWORD', 'BDS_KEY_ALIAS', 'BDS_KEY_PASSWORD']) {
    assert.ok(workflow.includes(`secrets.${secret}`));
  }
  assert.match(workflow, /for name in BDS_KEYSTORE BDS_KEYSTORE_PASSWORD BDS_KEY_ALIAS BDS_KEY_PASSWORD/);
  assert.match(workflow, /base64 --decode > ci-release\.jks/);
  assert.doesNotMatch(workflow, /Generating fallback release keystore/);
  assert.doesNotMatch(workflow, /secrets\.BDS_KEYSTORE_PASSWORD \|\| 'superdeepseek'/);
});

test('non-publishing checks use an ephemeral randomized key only', () => {
  assert.match(workflow, /Prepare temporary signing key for non-publishing checks/);
  assert.match(workflow, /password=\$\(openssl rand -hex 24\)/);
  assert.match(workflow, /BDS_KEY_ALIAS=ci-test-only/);
  assert.match(workflow, /workflow_dispatch.*inputs\.publish != true/);
});

test('CI builds fail closed if their explicitly prepared key or credentials are missing', () => {
  assert.match(workflow, /BDS_REQUIRE_RELEASE_SIGNING: 'true'/);
  assert.match(gradle, /val requireCiSigning = System\.getenv\("BDS_REQUIRE_RELEASE_SIGNING"\) == "true"/);
  assert.match(gradle, /if \(requireCiSigning && \(releaseKeystore == null \|\| !releaseKeystore\.exists\(\)\)\)[\s\S]*?throw org\.gradle\.api\.GradleException/);
  assert.match(gradle, /if \(requireCiSigning && \(envStorePass\.isNullOrEmpty\(\) \|\| envAlias\.isNullOrEmpty\(\) \|\| envKeyPass\.isNullOrEmpty\(\)\)\)[\s\S]*?throw org\.gradle\.api\.GradleException/);
});
