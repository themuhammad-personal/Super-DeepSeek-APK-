# Super DeepSeek for Android

The native shell of Super DeepSeek. It opens `https://chat.deepseek.com` in a WebView,
injects the Super DeepSeek engine on every page load and exposes a small native bridge:
storage, file pickers, downloads, haptics and updates. The overall design is described
in [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

## Build

From the repository root:

```bash
npm ci
npm run android:stage-engine     # copies bds-assets/bds into app/src/main/assets/bds
cd android
./gradlew testDebugUnitTest      # JVM unit tests
./gradlew assembleDebug          # → app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease        # → signed with app/superdeepseek-release.jks
```

`app/src/main/assets/` is generated (gitignored): edit the engine in
`app/src/main/bds-assets/bds/` and stage it again.

## Signing and updates

Every release is signed with the same keystore (`app/superdeepseek-release.jks`). The
`BDS_KEYSTORE_PASSWORD`, `BDS_KEY_ALIAS` and `BDS_KEY_PASSWORD` environment variables
override the defaults. Keep the keystore, `applicationId` (`com.superdeepseek.app`)
and signing config unchanged from now on. They are what let a new APK install as an update over
an existing one. (Earlier builds used `com.betterdeepseek.app`. The new id installs as a
separate app next to the old one.) `versionCode` is `1000 + build id` and always increases in CI.

## Source map

| File | Responsibility |
|---|---|
| `MainActivity.kt` | WebView setup, engine injection (`onPageFinished`), boot overlay, file pickers, Back handling |
| `WebViewBridge.kt` | The `AndroidBridge` JavaScript interface (storage, pickers, fetch, downloads, haptics, theme, sandbox) |
| `UiPolish.kt` | Mobile layout polish script injected after the engine |
| `UpdateChecker.kt` | GitHub Releases update check (new version or newer CI build), size/sha256-verified download |
| `Sandbox.kt`, `SandboxTools.kt`, `SandboxService.kt`, `TarGz.kt` | The built-in Linux sandbox (proot + Alpine), its agent tools and the foreground service |
| `StudioActivity.kt` | Linux Studio: terminal, file browser and preview |
| `Downloads.kt` | Where Android 8–9 downloads go (shared Downloads, or the app's own folder without the permission) |
| `Utf8Chunker.kt` | Streams process output as UTF-8 without breaking characters split between reads |
| `src/main/bds-assets/bds/` | The engine bundle: `injected.js`, `content.js`, `content.css`, sandbox pages |
| `src/test/` | Unit tests: bridge, pickers, navigation and link routing, keyboard insets, user agent, polish script, updates |

The Kotlin package and the application id are `com.superdeepseek.app`. The
app name, theme (`Theme.SuperDeepSeek`) and all user-facing text say Super DeepSeek.
