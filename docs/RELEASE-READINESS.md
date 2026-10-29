# Integration QA ও Release Readiness

**Scope:** regression verification ও documentation. Feature implementation rewrite নয়।  
**Snapshot date:** 2026-10-28 (UTC); সব evidence commit-specific, পরের build-এ নিজে থেকে প্রযোজ্য নয়।  
**Reviewed main:** `8894cf49fceff8c779c0fa9c0d06f5dbd37bfc45`  
**Latest reviewed CI:** [workflow run #109](https://github.com/themuhammad-personal/Super-Deepseek-/actions/runs/40732707579)  
**Latest release:** [`latest` — Super DeepSeek 2.72.0 / build 109](https://github.com/themuhammad-personal/Super-Deepseek-/releases/tag/latest)

## Status rules

- **PASS** — এই report-এ উল্লেখ করা নির্দিষ্ট evidence-এ পাস; সব platform-এ পাস বোঝায় না।
- **FAIL** — বর্তমান CI বা reproduction-এ প্রত্যাশিত অবস্থা পূরণ হয়নি।
- **BLOCKED** — release sign-off-এর আগে সিদ্ধান্ত, fix বা evidence দরকার।
- **NOT TESTED** — এই review-তে test চালানো হয়নি; অনুমান করে PASS নয়।

## Current evidence snapshot

| Area | Status | Evidence / boundary |
|---|---|---|
| Main CI / APK build | **PASS** | Run #109 completed successfully; build, engine, script-policy, Chromium acceptance, Android unit tests, signature verification, and release publishing steps succeeded. |
| Engine / Node tests | **PASS** | The run log reports `# tests 232` after `node --test android/app/src/test/js/*.test.mjs`. This count is a snapshot from run #109, not a permanent expected count. |
| Script/signing-policy tests | **PASS** | Node test runner reports `# tests 5`; sandbox-dependency ELF page-size reader self-test also reports pass. |
| Generative UI Chromium acceptance | **PASS** | Run #109 prints `29/29 acceptance checks passed`. Uses Playwright + synthetic page/bridge fixtures, not the live DeepSeek site, actual Android WebView, or a live model. |
| Robolectric/Kotlin unit tests | **PASS** | `testDebugUnitTest` completed with `BUILD SUCCESSFUL`; the reviewed job excerpt did not provide a trustworthy aggregate test count, so none is stated. |
| Android emulator instrumentation | **PASS** | API 30: 5/5; API 34: 5/5; API 35: 5/5. Current instrumentation is narrow: cookie policy and system-bar/edge-to-edge checks only. |
| APK signature validity | **PASS** | Run #109's `apksigner verify --verbose` succeeded (v2 scheme reported valid). This does **not** alone prove certificate continuity with a previously installed APK. |
| APK checksum | **PASS** | CI `sha256sum` output and the GitHub release asset SHA-256 digest both match `fe9c885414cc40baaaae221ebe9f3d9724b3ec6d32a8be5b181245541c76394f`. |
| Release notes | **PASS** | Release body states version `2.72.0`, build `109`, and commit `8894cf49fceff8c779c0fa9c0d06f5dbd37bfc45`, matching reviewed main/run. The stable `latest` release's API `published_at` remains an older timestamp because this release object is reused; use run/commit/build metadata to identify the payload. |
| APK manifest, checksum, signer and sandbox release gate | **NOT TESTED on reviewed main run** | Run #109 did not print the actual compiled APK's `aapt dump badging` identity or certificate digest. This branch adds a publish-only gate for applicationId, versionName/versionCode, SHA-256, pinned signer fingerprint and required sandbox payload; its result awaits branch CI. |
| Linux sandbox runtime payload | **PASS (present in APK listing)** | Run #109 log lists `libproot.so` and `libtalloc.so` for the packaged ABIs. The new publish-only gate also requires `assets/sandbox/rootfs.json`. |
| 16 KB memory-page compatibility for Linux sandbox | **FAIL / BLOCKED** | Current CI's ELF alignment report says the shipped `libproot-loader32.so` is only 4 KB aligned for `arm64-v8a` and `x86_64`; it reports four 4 KB-aligned libraries for `armeabi-v7a` and `x86`. Do not advertise the Linux sandbox as 16 KB-ready until the binary dependency/alignment issue is fixed and rechecked. |
| Physical-device sign-off | **BLOCKED** | This task did not operate a phone. Owner-reported results below are retained as reported evidence, not as independent reproduction. |

### Owner-reported physical-phone evidence

The project owner previously reported on 2026-10-28 that **CAPTCHA, login, chat reply, and app restart/session restore worked** on a real phone. These are marked **PASS (owner-reported)** below and were not re-run by this task. Do not extend that evidence to OTP, rotation, keyboard, Back, file sharing, sandbox, MCP, or other scenarios.

## Regression checklist — automated vs physical device

### Automated Chromium / Node / Robolectric / emulator

| Check | Status | What the evidence covers / next action |
|---|---|---|
| Engine injection once-only and chat-surface/document timing guard | **PASS** | Node contract/race tests included in the passing engine suite. Real live-site/WebView timing still needs physical verification. |
| GenUI inline visual/widget rendering, artifact lifecycle and Preview/Code, version picker, Edit with AI, share/export, CSP fallback | **PASS (fixture scope)** | The Chromium acceptance fixture passed 29/29 in run #109. Do not treat this as proof that every live model answer renders correctly. |
| Synthetic uploads/conversion, rejected media, export secret redaction | **PASS (fixture scope)** | Chromium acceptance exercises selected file-conversion and export cases. Native Storage Access Framework URI grants, Android Sharesheet, and large-file behavior need device tests. |
| MCP response-ID correlation and fail-closed paths | **PASS (unit/fixture scope)** | Parser/bridge unit tests cover mismatched response IDs and local MockWebServer; this is not a live remote-server reliability test. |
| Agent run-card grouping, streamed-call containment, approval UI fail-closed behavior | **PASS (unit/fixture scope)** | Included regressions exist in source/tests and latest main CI is green; a long-running live job and Stop latency remain device checks. |
| Release workflow dependency on build + complete emulator matrix | **PASS** | Run #109 confirms API 30/34/35 jobs and Publish Release all succeeded. |
| Package name/version/versionCode, SHA-256, pinned signing identity and sandbox manifest | **BLOCKED pending this branch CI** | New publish-only verification step is proposed in this branch; do not claim its result until PR checks finish. |
| Real live Deep Research citations/progress/cancel; live MCP timeout/auth/permission handling | **NOT TESTED** | No real external service was intentionally failed or timed out during this review. |

### Physical-device checklist

| ID | Scenario | Status | PASS criteria |
|---|---|---|---|
| D1 | CAPTCHA → login → normal chat reply | **PASS (owner-reported)** | CAPTCHA stays in official DeepSeek page; login completes; one user message produces one reply. Re-run once on the release candidate if the release is to be signed off independently. |
| D2 | OTP / verification-code path | **NOT TESTED** | Enter code manually; no repeated submit, code leakage, or stuck loading state. Never put the code in logs/screenshots. |
| D3 | App force-stop/restart and session restore | **PASS (owner-reported)** | Same account and conversation return without a fresh login loop or duplicate engine UI. |
| D4 | Rotation / resize, open keyboard, Back behavior | **NOT TESTED** | Rotate with chat open; focus composer; Back hides keyboard before leaving chat; open sheet/dialog closes before navigating away; no clipped composer. |
| D5 | Background ↔ foreground / reconnect / renderer recovery | **NOT TESTED** | Resume returns to live chat, stale requests do not double-inject, and renderer recovery does not lose the conversation. |
| D6 | GenUI inline visuals/widgets; artifact Preview ↔ Code, edit, copy, export/share | **NOT TESTED on device** | Render a chart/widget and one downloadable artifact in both light/dark; Preview/Code agree, Edit with AI returns to composer, and exported bytes/file extension are valid. |
| D7 | File import/export/share; invalid and oversized files | **NOT TESTED on device** | Try a small text file, supported document, invalid/binary file, and a large file; app stays responsive, failure is explicit, cancellation discards partial data, share/export filenames and MIME types are correct. Do not use private user documents. |
| D8 | Agent progress, background job and Stop | **NOT TESTED** | Run a long safe command; progress is visible, Stop cancels execution promptly, no duplicate job remains after resume. |
| D9 | Linux sandbox available/missing state | **NOT TESTED** | With runtime available, `uname -a` and a workspace file operation work; with sandbox disabled/unavailable, UI reports the state and tools fail visibly rather than hanging. |
| D10 | MCP failure / timeout / permission denied | **NOT TESTED** | Use a disposable mock or test server; timeout and 401/403 are surfaced, unrelated JSON-RPC IDs are rejected, and authorization headers/keys are never displayed. |
| D11 | Deep Research progress/cancel/citations | **NOT TESTED** | A multi-source research run shows progress, citations open the cited source, Stop cancels fetching, and partial/cancelled results are labelled honestly. |
| D12 | Bengali, Arabic/Persian RTL, mixed script, light/dark, narrow screen | **NOT TESTED on device** | Test `বাংলা English 123`, Arabic/Persian RTL and mixed paragraphs at a narrow viewport in light/dark; no clipped controls, wrong text direction, horizontal overflow, or unreadable contrast. Chromium viewport checks are not device sign-off. |
| D13 | Upgrade identity / package / signing continuity | **NOT TESTED on device** | Install over a trusted prior release signed by the same key; Android updates in place, package is `com.superdeepseek.app`, and sign-in/data behavior follows documented migration policy. Do not uninstall the existing working app just to test. |
| D14 | Android 15+ 16 KB page-size sandbox | **FAIL / BLOCKED** | CI alignment report is currently not ready; test only after dependency alignment is fixed. Do not state that Linux works on 16 KB-page devices until verified. |

## Reproduction and evidence collection

1. Record the candidate APK's release URL, version, build number, commit SHA, file size, and SHA-256. Never identify a build from the `latest` tag alone.
2. On a QA workstation with Android build-tools installed, run:
   ```sh
   sha256sum --check super-deepseek-latest.apk.sha256
   apksigner verify --verbose --print-certs super-deepseek-latest.apk
   aapt dump badging super-deepseek-latest.apk
   unzip -Z1 super-deepseek-latest.apk | grep -E 'assets/sandbox/rootfs.json|lib/.*/lib(proot|talloc)\.so'
   ```
   Compare the certificate SHA-256 with a trusted previously installed release before calling upgrade identity PASS.
3. For device logs, capture a bounded window around the reproduction only (for example, `adb logcat -v threadtime -T '2 minutes ago'` where supported) and attach the corresponding app diagnostics report. Record device model, Android version, page-size mode, app version/build and exact taps.
4. Reproduce once from a clean test account/session where feasible; for login tests, never paste a password, OTP, CAPTCHA answer, cookie or token into a bug report.

### Mandatory log redaction

Before sharing logs, screenshots, diagnostics, HAR/network records or MCP traces, redact passwords, OTPs, CAPTCHA answers, cookies, `Authorization` headers, API/MCP keys, session tokens, emails/account identifiers, private chat text, local file contents and URLs containing credentials or secret query parameters. Keep only minimal synthetic prompts, timestamps, error class, HTTP status, test ID and sanitized stack trace. Do not enable new telemetry or upload raw user content to diagnose an issue.

## Release recommendation

**Current recommendation: BLOCKED for unconditional release sign-off.** The latest main CI run and release build passed, but that is not sufficient to mark all requested regressions green. Resolve or explicitly accept/document the 16 KB-page Linux sandbox limitation, let this branch's new APK-manifest/sandbox/signer-identity release gate pass, verify certificate continuity against the documented previous release, and complete the pending physical-device checks for OTP/lifecycle/files/agent/MCP/Deep Research/localization. Do not turn a **NOT TESTED** item into PASS based on an emulator or a synthetic Chromium fixture.

## Reviewed repository state

- Main: `8894cf49fceff8c779c0fa9c0d06f5dbd37bfc45`; default branch `main`.
- Open PRs: none. Open issues: none.
- Recent merged PRs relevant to this report: [#2 login/CAPTCHA isolation](https://github.com/themuhammad-personal/Super-Deepseek-/pull/2), [#3 engine document gate](https://github.com/themuhammad-personal/Super-Deepseek-/pull/3), [#7 MCP response correlation](https://github.com/themuhammad-personal/Super-Deepseek-/pull/7), [#8 GenUI/source fallback](https://github.com/themuhammad-personal/Super-Deepseek-/pull/8), [#10 release emulator gate](https://github.com/themuhammad-personal/Super-Deepseek-/pull/10).
- Workflow run #109: [Build & Release Android APK](https://github.com/themuhammad-personal/Super-Deepseek-/actions/runs/40732707579).
