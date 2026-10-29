# Build instructions (Super DeepSeek 2.72 — SDK 36 toolchain)

Toolchain: JDK 17, Gradle 8.13, AGP 8.13.2, Kotlin 2.3.21, Android SDK platform 36 +
build-tools 36.0.0, Node 20+ (22 in CI).
The version lives in `package.json` and in `android/app/build.gradle.kts`
(`versionName`; `versionCode` is `major*1e6 + minor*1e4 + patch*1e3 + CI build id`).
`npm run test:engine` fails if the two disagree or if a release bump skips the
versionCode step — see `repo-consistency.test.mjs`.

1. `npm ci`
2. `npm test`                         — engine unit tests + compliance-harness self-test
3. `npx playwright install chromium && npm run genui:acceptance`   — Chromium/Playwright GenUI acceptance checks (the runner prints the current count)
4. `npm run android:stage-engine`     — copies `android/app/src/main/bds-assets/bds` → `android/app/src/main/assets/bds` (REQUIRED)
5. `python3 scripts/fetch_sandbox_deps.py` — optional Linux sandbox runtime
6. `cd android && ./gradlew testDebugUnitTest` then `./gradlew assembleRelease` (separately on machines with ≤ 2 GB RAM)

Signing: the permanent release key is **not** in the repository (`*.jks` is git-ignored).
Publishable builds on `main`, `v*` tags, and workflow dispatch with `publish=true` require all
four Actions secrets: `BDS_KEYSTORE` (base64 of `superdeepseek-release.jks`),
`BDS_KEYSTORE_PASSWORD`, `BDS_KEY_ALIAS`, and `BDS_KEY_PASSWORD`. If any is missing, the release
build fails rather than publishing an APK signed with a different key. All user-facing releases
must use the same permanent identity so they update installed copies.

Pull-request and manual non-publishing checks use a newly generated, short-lived signing key;
those APK artifacts are test-only and will **not** update an installed app. CI explicitly refuses
to fall back to a debug or hard-coded key for a release. For local builds, put the release key at
`android/app/superdeepseek-release.jks`; local-only builds without it may use the debug identity.
To configure Actions, add each secret under Settings → Secrets and variables → Actions. Set
`BDS_KEYSTORE` to the output of `base64 -w0 superdeepseek-release.jks`.

Release QA checklist and status/evidence rules: `docs/RELEASE-READINESS.md`.

Low-memory machines (2 GB): tests with `./gradlew --no-daemon --max-workers=1 "-Dorg.gradle.jvmargs=-Xmx448m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC" -Pkotlin.compiler.execution.strategy=in-process -PtestMaxHeap=560m testDebugUnitTest`; release alone with `-Xmx760m`. `GRADLE_OPTS` does not size the build daemon — use `-Dorg.gradle.jvmargs`.

Live MCP check: `npm run genui:mcp-live -- https://mcp.quran.ai interactive_study '{"surah":1}'`.
