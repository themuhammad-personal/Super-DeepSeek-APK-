# Toolchain

What the Android shell is built with, why those versions, and how to move them
without leaving the project unable to ship a fix.

The engine runs on a live website, so a release is also the only repair
mechanism: a toolchain that breaks the build blocks repairs. Move in
**supported-line steps**, one step per pull request, with CI green in between.

| Piece | Version | Notes |
|---|---|---|
| JDK | 17 | AGP 8.13 and 9.x both require 17 |
| Gradle | 8.13 | the minimum (and default) for AGP 8.13 |
| Android Gradle plugin | 8.13.2 | last 8.x line; supports API 36.1 and Kotlin 2.3 |
| Kotlin | 2.3.21 | `compilerOptions` block, not the removed `kotlinOptions` |
| compileSdk / targetSdk | 36 / 36 | Android 16; Play requires 36 for updates since 2026-08-31 |
| minSdk | 26 | Android 8.0 |
| build-tools | 36.0.0 | CI installs it; `apksigner` is taken from here |
| Node | 20+ (22 in CI) | tests and the Generative UI harness |
| Robolectric | 4.17 | first line that can run on API 36 |

## Version identity

The version lives in **two** files and must match: `package.json` (`version`)
and `android/app/build.gradle.kts` (`versionName`). The in-app updater compares
the release-note version with the installed `versionName`, so a drift either
offers the same update forever or never offers one at all.

`versionCode` is `major*1e6 + minor*1e4 + patch*1e3 + CI build id`
(2.72.0 → `2_720_000`). It must stay above every published build, or Android
refuses to install the new APK over the old one.

`npm run test:engine` fails when either rule is broken
(`android/app/src/test/js/repo-consistency.test.mjs`).

## Why not AGP 9.x yet

AGP 9.x also moves the project to Gradle 9.6 and makes the new Variant API
mandatory (AGP 10). That is a separate change with its own risks, and the
androidx releases that *require* compileSdk 37 are the only thing pulling it.
Until then the dependencies stay on the newest lines that build on SDK 36 —
they are pinned, not "latest", in `android/app/build.gradle.kts`. Do not take
Android Lint's "a newer version is available" advice blindly: it does not know
about `minCompileSdk`.

## 16 KB page sizes

Android 15+ devices may use 16 KB memory pages. A 64-bit library whose
`PT_LOAD` segments are only 4 KB aligned fails to load there, and Google Play
stops accepting such updates from **2027-02-01**.

- `scripts/fetch_sandbox_deps.py` measures `p_align` of every library it ships
  and prints `16 KB page size: OK` / `NOT READY (<libraries>)` per ABI.
  `python3 scripts/fetch_sandbox_deps.py --self-test` checks the reader.
- CI turns each misaligned library into a warning annotation.
- The libraries are **upstream** (Termux proot + talloc). Fixing them means
  taking a Termux build that was linked with `-Wl,-z,max-page-size=16384`, or
  rebuilding proot + talloc from source with the NDK; do not patch the ELF by
  hand.

**Where it stands:** CI measures the 32-bit ABIs (`x86`, `armeabi-v7a`) and
`libproot-loader32.so` at `0x1000` — they are not 16 KB ready. The report is
per run and per library in the step summary, because GitHub caps the visible
annotations at ten. 32-bit phones are not affected by 16 KB pages (the feature
is 64-bit only); what matters is `arm64-v8a`, and Termux links for 4 KB pages,
so treat the Linux sandbox on a 16 KB-page phone as **untested**.

To test it: an Android 15+ emulator image with a 16 KB page size (Android Studio
calls it "16 KB Page Size" in the AVD list, or `-page-size 16384` for
`avdmanager`), then *Linux & Agent → Linux on this phone*; a failed `exec` of
`libproot.so` in `logcat` is the failure mode. Do not raise `minSdk` or hide the
sandbox without this test.

The report never blocks a build: an app that cannot be built cannot be fixed.

## Moving the toolchain

1. Read the AGP release notes for the target line (compatibility table:
   Gradle, build-tools, JDK, max API).
2. Bump Gradle first, then AGP + Kotlin, in `android/build.gradle.kts` and
   `android/gradle/wrapper/gradle-wrapper.properties`.
3. Raise `compileSdk`/`targetSdk` and build-tools in **both** the module and
   `.github/workflows/build-and-release-apk.yml` (SDK install list and the
   `apksigner` path).
4. Expect `checkDebugAarMetadata` to fail first when the androidx versions are
   ahead of the compileSdk: that error means "this AAR needs a newer SDK", not
   "your code is wrong".
5. Then behaviour changes: edge-to-edge and predictive back are already handled
   (`WindowCompat.setDecorFitsSystemWindows(window, false)`,
   `OnBackPressedDispatcher`), so re-read the platform behaviour changes for
   anything else that touches a WebView host.
6. Bump the version and update `package.json`, `BUILD-NOTES.md` and this file.

## Verification

`npm test` (engine tests + sandbox-dependency self-test + CI signing-policy tests +
compliance harness), then CI: `./gradlew testDebugUnitTest` (283 Robolectric tests),
the Chromium acceptance suite, `assembleRelease` with a signature check, and
`connectedDebugAndroidTest` on an API 35 x86_64 emulator. Emulator coverage is
not a substitute for five minutes on a real phone; see `docs/genui/TEST-GUIDE.bn.md`.

## Release signing policy

Publishable builds (`main`, `v*` tags, or workflow dispatch with `publish=true`)
require the permanent keystore and all four Actions secrets:
`BDS_KEYSTORE`, `BDS_KEYSTORE_PASSWORD`, `BDS_KEY_ALIAS`, and `BDS_KEY_PASSWORD`.
If any are missing, CI fails closed instead of generating or using a fallback key.
Pull-request and non-publishing manual builds use a temporary randomized key; their
APK artifacts are for testing only and cannot update an installed release. Local
builds remain possible without CI secrets. The policy is guarded by
`scripts/ci-signing-policy.test.mjs`.
