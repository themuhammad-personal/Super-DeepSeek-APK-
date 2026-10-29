# Generative UI — readiness report (2.72.0, 2026-10-28)

**Status:** automated suites passed for the reviewed main commit below. This is not a physical-device or live-model sign-off. The public MCP check in historical notes was not repeated on this main commit.

**Not yet verified:**

* On a physical Android device.
* Against the live chat.deepseek.com page.
* Live-model compliance with the v3 prompt (not measured).

Read "Not verified" before relying on anything here.

## What changed in 2.72.0

| Area | Change |
|---|---|
| Engine self-check | `sd-health.js` (new): probes the page contract (each check lists alternative selectors) and the globals every native module installs. A failed core check or 3+ failed feature checks show a dismissible strip; the report is one tap to copy; the last 20 runs are kept locally. *Linux & Agent → Diagnostics* shows the state. Bengali and English. |
| Toolchain | AGP 8.5.2 → 8.13.2, Gradle 8.7 → 8.13, Kotlin 1.9.24 → 2.3.21, compileSdk/targetSdk 34 → 36, build-tools 36.0.0, Robolectric 4.13 → 4.17. androidx on the newest lines that still build on SDK 36 (`androidx.webkit` 1.11.0 → 1.14.0). |
| 16 KB page sizes | `fetch_sandbox_deps.py` measures `p_align` of every shipped library and reports per-ABI readiness; CI annotates each library that is still 4 KB aligned. It never blocks a build. |
| Release identity | `repo-consistency.test.mjs` (new): `package.json` ↔ `versionName`, the `versionCode` ladder, the engine module list vs the bundle, and the version named in the build docs. |
| File-preparation safety | Accessible English/Bengali progress and Stop; active reads/inflation abort, partial results are discarded, newer selections supersede stale work, and setup failures replay the original selection. |
| Android stability CI | Instrumented coverage now runs on API 30, 34, and 35. Edge-to-edge checks verify window configuration and contrast-scrim policy; inset-padding behavior has deterministic coverage in `KeyboardInsetTest` (avoiding timing-sensitive reads from an emulator window surface). Failure excerpts are surfaced in Actions annotations. |

**Latest reviewed main verification:** [Actions run #109](https://github.com/themuhammad-personal/Super-Deepseek-/actions/runs/40732707579), commit `8894cf49fceff8c779c0fa9c0d06f5dbd37bfc45`, succeeded. The run reported 232 engine/Node tests, 29/29 Chromium GenUI acceptance checks, 5 script-policy tests, Kotlin/Robolectric `BUILD SUCCESSFUL`, and 5/5 instrumentation tests on each of API 30, 34, and 35. It built, signature-checked, checksumed, and published the latest APK. Physical-device, live-site/model, and current live MCP verification remain separate.

## What changed in 2.70.1 (full review of 2.70.0)

| Area | Bug found | Fix |
|---|---|---|
| Updater | The stable channel never offered an update: the continuous release is tagged `latest`, so no version could be read from the tag. | The version is read from the release notes (`**Version:**` line), never the title; tested against the real release. Repository pointer → `Super-Deepseek-`. |
| Uploads | A zip bomb (forged sizes) could unpack without limit and exhaust the WebView's memory. Multiple Office/EPUB parts could also inflate in parallel beyond the per-part cap. | Inflate streams with hard caps (4 MB per generic archive entry, 32 MB per Office/EPUB part, 48 MB total per container), serially for multi-part documents. |
| Uploads | A 100 MB text file was decoded in full (~200 MB string). | Non-archives are read up to 24 MB, with a note. |
| Uploads | UTF-16 files (Windows Notepad) were treated as binary. | Byte-order mark detected, decoded as text. |
| Uploads | With no `accept` list on the chat input nothing was converted, so odt/epub/rtf/zip reached DeepSeek as is. | DeepSeek's documented formats are assumed for the chat input only. |
| Web access | Requests queued behind the consent sheet skipped the 6-concurrent cap and all fired at once; a 7th parallel request simply failed. | At most 6 run at once and the rest wait their turn (up to 32 open, 60/min), like a browser. |
| Web access | `fetch(new Request(url, {method:'POST', body}))` was sent as a GET without its body; `FormData`/`Blob` bodies became `{}`. | Method, headers and body of a Request are kept; FormData, URLSearchParams and Blob are encoded as the browser would (with their Content-Type). |
| Web access (native) | With a proxy or a local VPN/proxy app on the phone, the proxy resolved the target itself, so the private-address DNS filter could be bypassed. | Visual fetches never use a proxy. |
| Web access (native) | IPv6 addresses wrapping a private IPv4 address (NAT64 `64:ff9b::/96`, 6to4, Teredo) were not recognised. | The embedded IPv4 address is judged, so DNS64 on IPv6-only mobile networks still reaches public sites; Teredo, discard and TEST-NET ranges are blocked. |
| MCP Apps | After an app restart, an MCP app in an old chat showed "Unknown MCP server" until that server was used again. | The list of servers the page used is persisted (URLs only, never keys); unknown URLs are still refused. |
| Full-screen viewer | Its labels were hard-coded English. | String resources in all six app languages (no test: layout labels). |
| CI | Actions on the deprecated Node 20 runtime; `ubuntu-latest` is moving to 26.04. | Node 24 majors, runner pinned to `ubuntu-24.04`. |

Every behaviour fix has a test that fails on the old code (JS 159 in total, Kotlin +4), except the proxy switch (one builder line, reviewed).

## What changed in 2.70 (after testing 2.60.1)

| 2.60.1 problem | 2.70 |
|---|---|
| Raw code flashed before cards / visuals appeared (first render, streaming, old chats) | **Claim layer**: our blocks are hidden inside the MutationObserver microtask — before the first paint — and a skeleton with the final surface's geometry takes their place (artifact-card height for artifacts, 168 px for visuals). Old chats render at once (no 1.6 s wait for blocks that are not in the last message). |
| Visual blocks jumped while generating | Inline frames only grow while streaming; the first real size is awaited (≤ 1.4 s); skeleton → loading box → surface share one geometry; no entrance animations on cards that re-mount. |
| Errors showed raw code | **Lenient parser** (headers without `---`, missing/odd kind inferred, slugged ids, titles from `<title>`/`#`, repaired JSON envelopes). Only unrecoverable bodies fail, and they show a quiet error card (**Show code** / **Ask to fix**), never raw code. |
| MCP viewer ≤ 20 %: quran.ai connected but its reader did not show | Real-server compatibility: 8 MB resources (was 160 KB), robust streamable-HTTP/SSE parser (`McpSse.kt`), `_meta.ui.resourceUri` on results, OpenAI Apps SDK templates (`openai/outputTemplate`, `text/html+skybridge`, `window.openai`), app-only tools hidden from the model and auto-allowed (unless destructive), views restored on reload. Live: quran.ai reader, Excalidraw, MCP playground all render. |
| No web access from visuals | `fetch()` / `sdFetch()` / `sdImage()` in visuals and artifacts, **consent once per website**, no cookies, private networks always blocked (JS + native DNS + every redirect hop). |
| Upload formats and limits | `sd-files.js`: accepted files go to DeepSeek unchanged; refused ones are converted to text on-device (Office/OpenDocument, EPUB, RTF, archives, unknown text, binary summary); huge text is split into noted parts; audio/video are refused. Input limit 100 MB. |
| Upload preparation | `sd-files.js`: conversion has accessible, app-language progress and a Stop control; Stop aborts active `FileReader` and ZIP inflation, rejects partial attachment, and newer selections supersede stale work. Setup failures replay the original selection with an explicit message. |
| Cards not premium | New design layer: artifact card (kind-tinted tile, 16 px radius, quiet elevation), skeletons, error card, consent sheet, MCP header, viewer, sds-ui widgets — plus the content.js todo / question & info / chart / file cards and the + sheet / settings icon tiles, restyled with page theme tokens only (light + dark). |

## Verified (evidence you can re-run)

Release-wide workflow, device-only checklist and log redaction policy: [`docs/RELEASE-READINESS.md`](../RELEASE-READINESS.md).

| Gate | Result | Command |
|---|---|---|
| Engine unit + contract tests | **232 / 232 pass in main CI run #109**; dated snapshot only, so the current runner output remains authoritative | `npm run test:engine` |
| Compliance harness self-test | pass (synthetic fixtures only — not model compliance) | `npm run test:compliance-harness` |
| Generative UI acceptance (Chromium, 390×844 light + 1280×900 dark, strict-CSP fixture) | **29 / 29 checks pass in main CI run #109**; fixtures use a mocked bridge, not the live site or Android WebView | `npm run genui:acceptance` |
| Android emulator instrumentation | **5 / 5 pass on each of API 30, 34, and 35** in run #109; current tests cover cookies and edge-to-edge/system bars only | `./gradlew connectedDebugAndroidTest` in the Actions API matrix |
| 16 KB page-size Linux sandbox | **FAIL / BLOCKED**: run #109 reports 4 KB-aligned native libraries for several ABIs, including `libproot-loader32.so` in `arm64-v8a`; do not claim 16 KB readiness | `python3 scripts/fetch_sandbox_deps.py` (alignment report) |
| Kotlin unit tests (Robolectric) | pass in the latest Actions run | `./gradlew testDebugUnitTest` |
| Release APK | build, signature validity, checksum generation, and publication pass in run #109; certificate continuity and actual manifest identity were not independently confirmed by that run | `./gradlew assembleRelease` + Actions run #109 |
| Live MCP App, `https://mcp.quran.ai` `interactive_study {"surah":1}` | **Previously verified**: 17 model-visible tools, resource `ui://interactive_study_v450.html` (2.3 M chars) read, reader rendered inline (Sūrat al-Fātiḥah), app-only tools called without consent prompts. Not rerun in this sandbox. | `npm run genui:mcp-live -- https://mcp.quran.ai interactive_study '{"surah":1}'` |

New acceptance checks in 2.70 (`scripts/genui-browser-check.mjs`, screenshots
in `qa/genui/`):

* **00** no raw-code flash: blocks hidden before first paint, skeleton →
  surface; snippets stay code; old chats render at once (< 1.2 s); errors never
  show raw code.
* **04** malformed block → quiet error card (code behind a toggle); unknown
  kinds inferred; later blocks still render.
* **09d** MCP app-only tools hidden + auto-allowed; skybridge templates get
  `window.openai`.
* **11** kill switch removes every surface and skeleton and restores the code
  blocks; re-enable renders again.
* **15** web access: consent once per website (one sheet at a time), then the
  native fetch; private hosts never prompt and never reach the bridge; blocked
  `<img>` retried through the host.
* **16** uploads: refused files converted on the device before the page sees
  them; accepted files untouched; audio/video refused.

## Not verified (honest gaps)

* **Live chat.deepseek.com CSP.** srcdoc frames inherit the host page CSP.
  If DeepSeek blocks inline scripts, the 6 s watchdog shows "could not start
  here → Open full screen" (verified with a strict-CSP fixture). Check on the
  device with *Generative UI settings → Run diagnostics*.
* **DeepSeek's real upload input.** `sd-files.js` decides by the input's
  `accept` list; the exact list on the live page and DeepSeek's server-side
  size limits were not observable here. What DeepSeek accepts is uploaded as
  is; its own limits still apply.
* **Native web fetch on a device.** `bds-frame-fetch` (OkHttp, SafeDns,
  HopGuard) is unit-tested for the policy; the end-to-end consent → render path
  ran in Chromium with a mocked bridge. No real network call went through the
  Kotlin path here.
* **MCP Apps through the Kotlin transport on a device.** The engine side ran
  against real servers with Node standing in for `WebViewBridge`; the 8 MB
  native resource path (quran.ai's 2.3 MB reader) is covered by unit tests
  only.
* **Design on the real page.** The content.js card restyle was reviewed in
  the design harness (`design-preview/cards.html`, real Svelte styles), not on
  the live page next to DeepSeek's own UI.
* **Android System WebView** specifics (share sheet, Keystore on hardware,
  back gesture, low-end performance) ran only in Robolectric / desktop
  Chromium. `DecompressionStream('deflate-raw')` (used to unzip uploads) needs
  WebView 103+.
* **Model compliance** with the v3 prompt: not measured. Collect real
  responses and run `npm run genui:compliance`.

## Release

* Same signing key as 2.50/2.60/2.70.0, so it **updates those builds in place**
  (logins and settings stay). versionCode: `2_701_000 + CI run number`.
* **2.70.1 = GitHub Actions Continuous Build #8** (commit `0cf4eba`, release tag
  `latest`): `super-deepseek-latest.apk`, 8,470,852 bytes, versionName `2.70.1`,
  versionCode `2701008`, APK Signature Scheme v2 verified, signer certificate SHA-256
  `75:eb:ff:1c:a3:3e:27:e8:f1:4d:98:12:2d:c5:e6:db:81:1a:1c:77:f3:71:33:b7:bb:bd:24:cd:75:ba:38:03`.
  APK SHA-256 `8b5b63f2919ab06fcdb2850ce4905a6dc1d58c833f1173ccb5f89dd83ab4ce92`
  (matches the digest GitHub reports). Packaged `assets/bds/sd-files.js` and
  `sd-genui-frame.js` are byte-identical to the source; the viewer strings are in the
  resource table (en, bn, fa, ru, tr, zh-CN).
* In CI for that build: JS 159/159, acceptance 21/21, Kotlin unit tests passed,
  lint report only (`OldTargetApi`, 11 newer-dependency notices; `SetTextI18n` fixed).
* Updating from 2.70.0 needs one manual install: 2.70.0 checked the old repository
  and could not read a version from the `latest` tag. 2.70.1 onwards updates itself.
