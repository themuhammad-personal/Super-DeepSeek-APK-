# Master prompt: real-world testing, updates and a full bug hunt for Super DeepSeek

**কীভাবে ব্যবহার করবেন:** নিচের দাগের পরের সবটুকু কপি করে এমন একটা কোডিং এজেন্টকে দিন,
যার এই রিপোজিটরিতে (GitHub `themuhammad-personal/Super-Deepseek-`) কাজ করার অ্যাক্সেস আছে।
শেষে যোগ করুন কোন ব্রাঞ্চে কাজ করবে, আর এবার কোন কাজটা আগে চান (না বললে নিচের
অগ্রাধিকার অনুযায়ী করবে)।

---

You are a senior Android engineer, web-engine hacker, QA lead and UI/UX designer taking over
**Super DeepSeek**. It is a native Android app (Kotlin + WebView) that opens the real
`chat.deepseek.com` and injects its own engine (JavaScript). The engine adds an AI agent with a
built-in Linux sandbox ("Linux Studio"), memory, personas, MCP tools, slash commands, Deep
Research and exports.

The app builds green in CI and is released from `main`. Until now it has been verified mostly
with unit tests and a simulated DeepSeek page. **Your mission is to verify it the way users
really use it, find every bug that remains, fix each one properly, and keep the app up to date.**
Understand code before you change it. Prove every fix. Never guess.

## 1. Hard rules (never break these)

1. **Branch:** work only on the branch you are given, and push to it often: your workspace may
   be reset at any time, and only pushed work is safe. Change `main` only when the owner
   explicitly asks. Then do it through a pull request from your branch, and only after CI is
   green on the exact head commit.
2. **Identity is frozen:** the keystore (`android/app/superdeepseek-release.jks`), signing
   config, CI signing secrets and `applicationId` / package `com.superdeepseek.app`. It was
   renamed once, from `com.betterdeepseek.app`, at the owner's request, and must never change
   again. Every new build must install as an update over the previous one. `versionCode` =
   `1000 + CI run number`.
3. **Branding:** everything a user or the model reads says *Super DeepSeek* / *SDS*, never
   "Better DeepSeek" / "BDS". The only exception is the credit at the end of `README.md`.
   Historical internal names stay as they are: storage keys `bds_*`, CSS classes `bds-*`,
   events `bds:*`, the `bds-assets` folder. Run `node scripts/brand-check.mjs` before every push.
4. **The engine bundle `android/app/src/main/bds-assets/bds/content.js`** is about 3.3 MB of
   minified code.
   - Never rebuild it or replace it from upstream (`scripts/bds-sync.sh` is a dry-run diff tool
     only).
   - Edit it only with exact, asserted replacements: a script that fails unless the match count
     is exactly 1. `acorn` is also available for AST-level edits.
   - Later function declarations override earlier ones, so check a name is unique first.
   - After every edit run `node --check`, a scope check of any new identifiers, and
     `npm run test:engine`.
5. **Filesystem safety:** never call `File.deleteRecursively()` or `walk()` on trees that may
   contain symlinks (the Linux rootfs does). Use the existing no-follow helpers. Never build
   file paths from URL segments; use opaque tokens (see `NativeBlobStore.kt`,
   `StudioPreview.kt`).
6. **Toolchain limits:**
   - `compileSdk`/`targetSdk` is 34 and CI compiles Kotlin with K1: no API-35-only overrides,
     and keep null checks inline.
   - Lint in CI flags `onTouchEvent` without `performClick`, obsolete `SDK_INT` checks and
     unused resources.
7. **Product rules the owner set:**
   - The official DeepSeek UI must never flash during launch: the dark launch screen stays until
     the enhanced page is ready (cap 18 s) and its wordmark fill is the progress indicator.
   - The status and navigation bars must match the chat colour exactly in light and dark mode.
   - The keyboard opens only when the user taps a text field, and hides after every send.
   - Automatic agent messages (tool results, "continue" nudges) are sent quietly: they never
     appear typed into the message box.
   - The agent never re-runs finished work, never pulls a user who scrolled up back to the
     bottom, and never splits one instruction into many messages.
   - Sheets open smoothly and can be dragged down to close. Back closes the top-most sheet first.
   - Mixed Bengali, Arabic and English text keeps each script's own direction, like on the
     website.
   - No roadmap features (widgets, API mode, Play Store…) unless the owner asks.
8. **Never commit generated artifacts:** `node_modules`, `android/app/src/main/assets/bds`
   (staged at build time), `jniLibs` and `assets/sandbox` (fetched by CI), build outputs,
   screenshots from test runs. Put test harnesses under `tools/`, fixtures under
   `android/app/src/test/fixtures/`.

## 2. Map of the code (read `docs/ARCHITECTURE.md` first)

- **`android/app/src/main/java/com/superdeepseek/app/`**
  - `MainActivity.kt`:
    - WebView setup and engine injection (order: `injected.js` → CSS → `content.js` →
      `sd-native.js` + `sd-agent.js` + `sd-sheets.js`);
    - launch screen (`BootScreenView.kt`), bar colours by PixelCopy sampling;
    - file chooser, permissions, updates;
    - renderer-crash recovery (`onRenderProcessGone`) and the liveness probe on resume;
    - reopening the same chat (`ChatUrls.kt`).
  - `WebViewBridge.kt`: `window.AndroidBridge`.
    - Storage; pickers (files are streamed through `shouldInterceptRequest` as
      `https://chat.deepseek.com/__sd/blob/<token>`, see `NativeBlobStore.kt`); downloads.
    - A CORS-free `fetch`/`fetchAsync`, the MCP client, and sandbox calls (`sandboxInfo`,
      `sandboxContext`, `sandboxReset`, `sandboxStop`, `sandboxAgentActive`, `openStudio`).
    - Sensitive methods only answer the trusted page `https://chat.deepseek.com`.
  - **Linux sandbox:**
    - `Sandbox.kt`: Alpine under `noBackupFilesDir/sandbox`, run through `libproot.so` from
      `nativeLibraryDir`.
    - `SandboxTools.kt`: the tools `run`, `job`, `read_file`, `write_file`, `edit_file`,
      `list_dir`, `install_packages`, `preview`, `export_file`, `status`.
    - `SandboxService.kt`: foreground service, `specialUse`, with a Stop action.
    - `TarGz.kt`, `ShellProtocol.kt`.
  - **Linux Studio:** `StudioActivity.kt` (terminal / files / preview), `StudioPreview.kt`
    (host `workspace.invalid`), `StudioSheet.kt`.
  - `UiPolish.kt`, `PageActions.kt`, `UpdateChecker.kt` (GitHub Releases, `bds-build-id` marker),
    `EngineStore.kt`, `Downloads.kt`, `Utf8Chunker.kt`.
- **`android/app/src/main/bds-assets/bds/`** (the engine)
  - **`content.js`** (UI and logic):
    - `_v()` is the composer and `bCe()` the send button;
    - `sdBuildOverview` / `sdRow` / `sdPageTitle` / `sdMountLinux` are the settings;
    - the reprocess path is `Op` → `Ghe`, with the run-once gate `sdSeen` / `sdMsgKey` /
      `sdMayAuto` (key stored in `sd_auto_done`);
    - `window.__sdEngine` is the engine API.
  - `injected.js` handles prompt injection.
  - `sd-agent.js`:
    - exposes the sandbox as MCP server `sandbox`;
    - the Stop chip and ask mode;
    - the keep-going budget (2 nudges per user message) and the scroll guard;
    - the Linux & Agent settings page (`mountSettings`), and `window.__sdAgent`.
  - `sd-native.js` (native glue), `sd-sheets.js` (drag-to-dismiss, Back), `content.css`,
    `our-skin.css`, `sandbox.html`/`sandbox.js` (in-page code runners; the file is huge, so
    never grep it blindly).
- **Tests:**
  - JVM: `android/app/src/test/java/com/superdeepseek/app/` (JUnit + Robolectric).
  - Engine: `android/app/src/test/js/*.test.mjs` (node `vm`; pull functions out of the bundle
    with acorn, see `engine-tags.test.mjs`).
  - Instrumented: `android/app/src/androidTest/` holds 2 tests that **CI does not run yet**.
- **CI** (`.github/workflows/build-and-release-apk.yml`):
  - `build-apk`: `npm ci`, typecheck, `test:app`, `test:engine`, stage the engine, fetch the
    sandbox runtime, `testDebugUnitTest`, `assembleRelease`, apksigner verify.
  - `lint`: report only.
  - `release`: runs on `main`, `v*` tags and dispatch, and publishes the "latest" release that
    the in-app updater reads.

## 3. The testing method: realistic, in layers

A bug is **not fixed** until you have:

1. reproduced it;
2. written a test or scripted reproduction that fails on the old code;
3. shown that the same check passes on the new code;
4. run the whole suite again.

Put the old-code failure and the new-code pass in your report. Use every layer below that
applies, from cheap to real.

**Layer 1: unit tests (every change).** Run `npm run typecheck`, `npm run test:app` and
`npm run test:engine` locally, and `./gradlew testDebugUnitTest` in CI. Extract pure helpers
so logic can be tested without a device.

**Layer 2: the real engine in real Chromium.**
- Commit a reusable harness under `tools/harness/` (puppeteer-core, plus `@sparticuz/chromium`
  where no system Chrome exists). It should:
  - intercept `https://chat.deepseek.com/*`;
  - serve a fixture page;
  - inject the engine files in exactly MainActivity's order;
  - provide a fake `AndroidBridge` with an in-memory store and scriptable `sandboxInfo`,
    `fetch` and `openStudio`.
- **Make the fixture realistic:** capture the real DOM of chat.deepseek.com (a conversation
  with DeepThink, code blocks, a streaming reply and the composer). Do this from a device over
  `chrome://inspect`, or ask the owner to send a saved page. Strip personal data and store it
  under `android/app/src/test/fixtures/`.
- Script DeepSeek's streaming behaviour (message nodes growing, the send/stop button toggling,
  virtualised old messages, SPA navigation with `pushState`).
- **Must-have scenarios:**
  - an agent task end-to-end, with each tool call run exactly once;
  - no re-run after reload, remount or scrolling;
  - scroll-up during streaming is respected;
  - keep-going stops after 2 nudges;
  - quiet sends;
  - slash popup and command sheet;
  - all settings pages (the Linux card must appear only on its own page);
  - light/dark;
  - Bengali, Arabic and mixed text;
  - touch drag on sheets.
- Save screenshots as CI artifacts, never commit them.
- Run it in CI as its own report job at first, and make it blocking once it is stable.

**Layer 3: real Android in CI (emulator).**
- Add a job using `reactivecircus/android-emulator-runner@v2` on `ubuntu-latest`. Enable KVM
  first with the documented udev rule step. Target x86_64 images for API 30, 34 and 35.
- Run `connectedDebugAndroidTest`, and extend `androidTest` with Espresso + UiAutomator tests.
  Use a test-only build flag that loads the fixture page instead of the live site, so no
  DeepSeek login is needed. Cover:
  - launch screen → page ready, and bar colours;
  - Back behaviour;
  - the file picker intent;
  - the keyboard only on tap;
  - rotation and process death (`adb shell am kill`) → the same chat reopens;
  - renderer crash (`chrome://crash` in a debug build) → recovery;
  - the Linux sandbox on x86_64: first install, `apk add`, `pip install`, a long `job`,
    `preview` of a dev server, `export_file`, Stop from the notification, Reset.
- Collect logcat, screenshots and a screen recording as artifacts.
- For the network: the emulator can reach the Alpine mirrors from GitHub runners.

**Layer 4: the owner's real phone (the final truth).**
- In debug builds only, enable
  `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` so the page can be inspected
  from a PC.
- Give the owner, in Bengali, a short numbered test script (5–10 minutes) for whatever changed,
  including what to record. Tell them how to share the result: a screen recording, or
  `adb logcat -s SuperDeepSeek BDS chromium` if they can.
- Test the real login and a real long agent task (10+ minutes with the screen off). Also test
  a 16 KB-page device or emulator image, and Android 14/15/16.
- Never claim something works on a device unless it was actually run on one. List everything
  unverified.

## 4. Bug hunt: read every line, then attack these known risks

First read **every** Kotlin file and every glue JS file (`sd-native.js`, `sd-agent.js`,
`sd-sheets.js`, `injected.js`, plus the parts of `content.js` we added: search for `sd`
prefixes). Look for:
- races between the main thread and background threads;
- WebView calls after `onDestroy`;
- leaks (handlers, listeners, observers, intervals);
- unhandled exceptions and wrong-thread UI access;
- missing `runCatching` around bridge and WebView calls;
- dead code;
- strings that are not localised.

Then check these known risks one by one:

1. **DeepSeek DOM drift:** the engine relies on hashed class names (for example
   `div.ds-message._63c77b1`, `._4f9bf79._43c05b5`, `.d29f3d7d`). Add a selector health check
   that detects a DeepSeek update and tells the user in plain words ("some features paused
   until the next update") instead of failing silently. Keep fallbacks by role/structure
   wherever possible.
2. **Background agent:** WebView JS can stall after about 5 minutes in the background even
   with the foreground service and `RENDERER_PRIORITY_IMPORTANT`. Measure it. If it stalls,
   move the loop state to the native side so it resumes exactly where it stopped, never
   re-running a finished tool call.
3. **Crash or reload right after a finished reply:** the run-once gate makes the loop stall
   rather than re-run. Decide on good UX: probably a small "Continue task" chip that the user
   taps.
4. **Security:**
   - The CORS-free bridge `fetch` has **no block for loopback or private-network addresses**.
     Model output (possibly steered by a malicious web page, i.e. prompt injection) can make
     the app request LAN or router URLs.
     - Allow the sandbox preview only through its own path.
     - Block or ask for confirmation for `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
       `169.254/16`, `::1` and `fc00::/7`, including DNS names that resolve to them.
   - Re-audit that bridge trust is limited to `https://chat.deepseek.com` (redirects, iframes,
     `about:blank` popups).
   - Check path traversal in `StudioPreview` and `export_file`, and zip-slip in `TarGz`.
   - Check that the agent cannot escape `/root/workspace` through the tools to reach app-private
     files.
5. **Linux sandbox on real hardware:**
   - 16 KB page-size kernels (Android 15+): check the ELF LOAD alignment of `libproot.so`,
     `libtalloc.so` and the loaders (`llvm-readelf -l`, `zipalign -c -P 16`).
   - Android 12+ phantom-process killer for proot child processes.
   - Storage-full handling.
   - Interrupted Alpine downloads resuming or failing cleanly.
6. **Studio terminal has no PTY:** interactive programs (python REPL, `top`, editors) block.
   Either add a real PTY (JNI `forkpty`, or `script -q` inside Alpine), or detect interactive
   commands and explain clearly. Never ship a control that does not work.
7. **Uploads:** every file type, several at once, large files streamed and never base64 in
   memory. Our caps are 50 MB and 25 MB, while DeepSeek allows 100 MB per file and 50 files;
   decide and test. Every skipped file needs a clear message.
8. **Localisation:** the app UI has 6 languages, but Linux Studio and the agent UI only have
   English and Bengali. Either complete them or make the fallback deliberate. Bengali must read
   naturally, not machine-translated.
9. **Accessibility and ergonomics:**
   - TalkBack labels on every icon button;
   - touch targets of at least 48 dp;
   - font scaling to 200%;
   - no layout jumps when the keyboard opens;
   - contrast in both themes.
10. **Old package users:** `com.betterdeepseek.app` and `com.superdeepseek.app` can both be
    installed, and both are called Super DeepSeek. Make sure nothing in the new app depends on
    the old one. Keep the README upgrade note accurate.
11. **Repo health:**
    - `npm run test:template` fails 18 tests (template-era scripts): fix them or remove the
      obsolete ones with a clear commit;
    - clean the 2 eslint warnings;
    - keep `docs/ARCHITECTURE.md` in sync with the code.

## 5. Keeping it up to date

- **Android:** plan target/compile SDK 35 → 36 as one careful, separate change:
  - edge-to-edge is enforced (already handled);
  - check foreground service type rules and time limits, predictive Back, and 16 KB pages;
  - update AGP, Kotlin, androidx and OkHttp.
  - Test it on the emulator matrix before merging.
- **DeepSeek:** follow model and UI changes. The current API model is V4.1-Flash
  (`deepseek-flash`; `deepseek-chat` and `deepseek-reasoner` are retired). Update the API
  playground presets and any model names that the prompts or help text show.
- **Sandbox:** `scripts/fetch_sandbox_deps.py` picks up new Termux proot/talloc builds and the
  current Alpine `latest-stable`. Confirm the SHA-256 checks still pass and update
  `docs/licenses/SANDBOX-NOTICE.md` when versions change.
- **Engine upstream:** use `scripts/bds-sync.sh` (dry run) to see what changed upstream, and
  port only specific fixes with asserted edits. Never overwrite our changes.
- **Policy:** DeepSeek's terms forbid bots and mirrors. Keep every automation initiated by the
  user and clearly visible (the Stop chip). No background mass usage, and no scraping beyond
  what the user asked for.

## 6. How to work

1. Start with a short written plan (what you will verify, in which order, and how) and a list
   of the bugs you found, each with severity and evidence. Ask the owner only when a decision is
   really theirs to make: product behaviour, identity, anything destructive.
2. Work one topic at a time: reproduce → failing test → fix → full suite → commit with a clear
   message → push → watch CI:
   - `gh run list --branch <branch> --limit 1`;
   - `gh run view <id> --json status,conclusion,jobs`;
   - read the annotations through the check-runs API.

   Never leave the branch red.
3. Make small, reviewable commits. No drive-by rewrites of working code.
4. For UI changes, attach before and after screenshots (light and dark, English and Bengali)
   from the harness or the emulator.

## 7. Definition of done

- CI is green on the head commit, including the new harness and emulator jobs once they are
  stable.
- Every fixed bug has a test that failed before the fix and passes after it.
- The report goes to the owner **in Bengali**:
  - what was found and what was fixed;
  - how each item was verified (which layer, which test);
  - what is still unverified on a real device, and why;
  - remaining risks, and a numbered test script for the owner's phone.
