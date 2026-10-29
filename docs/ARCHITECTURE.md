# Architecture

Super DeepSeek is a native Android shell around the **official** DeepSeek web chat.
Instead of re-implementing DeepSeek's private API, it loads `chat.deepseek.com` in a
WebView and injects the Super DeepSeek engine, which adds every feature on top of the
real page. The protocol, sign-in, anti-bot checks and model behaviour stay exactly
what DeepSeek ships.

```
┌──────────────────────────── MainActivity ───────────────────────────┐
│ system splash ─▶ BootScreenView (native launch screen, see below)   │
│                                                                     │
│ officialWebView ──▶ https://chat.deepseek.com/                      │
│   onPageFinished ─▶ injectBdsScripts():                             │
│        1. injected.js   network hooks (prompt injection, tool tags) │
│        2. content.css   engine styles  (style#bds-css)              │
│        3. content.js    engine UI + logic (Svelte)                  │
│        4. NATIVE_MODULES sd-native … sd-genui-* (one script each)   │
│        5. UiPolish      hides out-of-scope features, signals ready  │
│   shouldInterceptRequest ─▶ https://bds-asset.local/bds/* from APK  │
│                                                                     │
│ AndroidBridge (WebViewBridge) — JS ⇄ native                         │
│   storage · file/camera picker · downloads · haptics · MCP fetch    │
│   locale/theme · update checks (UpdateChecker)                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Layers

| Layer | Where | Responsibility |
|---|---|---|
| Native shell | `android/app/src/main/java/com/superdeepseek/app/` | WebView setup, splash/boot overlay, insets, back handling, file chooser, external links |
| Bridge | `WebViewBridge.kt` | `window.AndroidBridge`: persistent storage, native pickers, blob downloads, haptics, CORS-free fetch for MCP/web tools |
| Engine | `android/app/src/main/bds-assets/bds/` | `content.js` (existing UI), `injected.js` (network hooks; delegates the GenUI prompt to `sd-genui-prompt.js`), `sd-genui*.js` + `sd-artifacts.js` + `sd-genui.css` (Generative UI, see below), `sandbox.*` (isolated code runners) |
| Polish | `UiPolish.kt` | Small, unit-tested DOM sweep: hides voice / Deep Code entries and repairs raw labels |
| Updates | `UpdateChecker.kt` | Polls this repository's GitHub Releases (stable or beta channel) and installs the signed APK |

The application id and Kotlin package are `com.superdeepseek.app`. Earlier builds
used `com.betterdeepseek.app`; Android treats the new
id as a different app, so it installs next to the old one and cannot read its data. Settings move
over with the engine's own Export → Import (README, "Coming from an older build?"). Keep the new id and the keystore unchanged from
now on, or updates break again.

## The engine bundle

The engine is a patched, pre-built bundle committed to the repo. It began as the
open-source [better-deepseek](https://github.com/EdgeTypE/better-deepseek) extension and
now carries this project's own UI, mobile layouts, Bengali translations and fixes, so
**never overwrite it with an upstream build**. `scripts/bds-sync.sh` can diff it against
upstream in dry-run mode.

Things inside the bundle that deliberately keep their original names:

- the parser still accepts the old `<BetterDeepSeek>` context wrapper and `BDS:` tool tags
  found in older conversations (new messages use `<SuperDeepSeek>` and `SDS:`); stored
  skills, memories and custom prompts are renamed once on first start
  (`sdsRebrandStored`);
- storage keys (`bds_*`) and CSS classes (`bds-*`), so user data survives updates;
- the third-party DeepSeek Harness *Better DeepSeek Bridge* plugin and its endpoints.

## Generative UI

`sd-genui.js` is the allowlisted, schema-driven UI layer. Relevant prompts receive an `sds-ui` JSON contract from `injected.js`; a throttled observer validates complete blocks, then replaces only validated blocks with responsive DOM components. It supports four visual themes (`aurora`, `editorial`, `glass`, `midnight`), six accents, grid/stack/dashboard layouts, curated SVG icons, hero panels, KPI/stat cards, callouts, badges, progress, sliders, selectors/toggles, bar/line/pie/donut charts, validated node-and-edge system diagrams, plan-comparison cards, tables, lists, numbered steps, timelines, quotes, dividers and copy buttons. Explicit visual requests instruct the model to return a valid `sds-ui` block; task-aware guidance maps diagrams, steps, comparisons and calculators to matching components. Text bindings also refresh throughout nested components when controls change.

Interactions recalculate bound text, formulas, progress and charts locally. Formula evaluation uses a small arithmetic parser; generated JavaScript, arbitrary markup and remote images are not executed or inserted. Input length, component count and table/chart sizes are capped, and text is rendered as text. Invalid/incomplete blocks remain visible as code. The existing minified `content.js` bundle is not rebuilt or overwritten. Because rendering hooks into the official site's message/code-block DOM, compatibility still depends on DeepSeek's markup.


## Linux sandbox and the agent

| Piece | Where | Role |
|---|---|---|
| `Sandbox.kt` | native | Alpine minirootfs under `noBackupFilesDir/sandbox`, run through `libproot.so` from `nativeLibraryDir` (Termux proot + its libraries, fetched and SHA-checked by `scripts/fetch_sandbox_deps.py` in CI) |
| `SandboxTools.kt` | native | The MCP-shaped tools: `run`, `job`, `read_file`, `write_file`, `edit_file`, `list_dir`, `install_packages`, `preview`, `export_file`, `status` |
| `SandboxService.kt` | native | Foreground service (`specialUse`) with a Stop action, kept while a command runs **or** the agent loop is active (`AndroidBridge.sandboxAgentActive`) |
| `StudioActivity.kt` | native | Linux Studio: terminal, files (viewer with Preview / Ask the AI / Share / Save), preview, settings; shows the AI's commands and file writes live |
| `StudioPreview.kt` | native | Preview of workspace files at `https://workspace.invalid/<guest path>` (served by `shouldInterceptRequest`, never a real host): folders, HTML with relative assets, Markdown (safe renderer), images, video, audio |
| `StudioSheet.kt` | native | Studio's bottom sheets: slide up, drag down (or fling, tap outside, Back) to dismiss |
| `ShellProtocol.kt` | native | Studio terminal ↔ shell: end-of-command markers (exit code, folder), Run/Stop state |
| `sd-agent.js` | engine | Exposes the sandbox to the engine as MCP server `sandbox`, re-reads exact tool arguments from the chat history, the Stop chip, the "ask" mode, continuity (re-scans a finished reply for missed tool calls and nudges a reply that stopped mid-task, at most twice per user message; switchable), the scroll guard (never pulls a reader who scrolled up back to the bottom), the live sandbox state line in the MCP prompt (`promptContext()` ← `AndroidBridge.sandboxContext()`), and the **Linux & Agent** settings page — its own row on the Advanced settings overview (content.js `sdBuildOverview` → page `linux` → `sdMountLinux` → `__sdAgent.mountSettings`, `#sd-linux-page`; prefs `sd_sandbox_enabled` / `sd_sandbox_mode` / `sd_agent_autocontinue`, shared with Linux Studio; the engine language is mirrored to `sd_ui_locale` so Studio follows it) |
| `sd-run.js` | engine | **One card per agent run** (2.71.0). Groups the chat into runs (a real user message → replies with tool calls ↔ automatic result messages → final reply), hides the automatic messages and the replies in between (`data-sd-run-hidden`, nothing is removed; unrecognised messages are never hidden), mounts one `.sd-run-card` in the first reply in place of its `.bds-mcp-loading` cards (live step, last 3 steps, Stop while running; "Worked for … · N steps" when done) and opens the activity drawer `#sd-run-sheet` (every step: where, input, output, time, saved path, plus the model's notes in between). Live data: `window.__sdRunEvent` (start/end per call, from content.js `sdMcpOne`); timings are remembered per run in `localStorage` `sd_run_v1`; details of older runs come from the chat history (`__sdAgent.history()`). Kill switch: `localStorage.sd_run_off = '1'` / `__sdRun.setEnabled(false)` |
| `sd-sheets.js` | engine | The engine's bottom sheets (+ menu, projects, settings drawer) follow the finger: drag down or fling to dismiss. Our own sheets (`ours: true`: the agent's confirm / step-cap sheet, the run drawer) are closed by Back without leaving the chat |

The engine does the agent loop itself: the model writes
`<SDS:AUTO:MCP url="sandbox" tool="run">{…}</SDS:AUTO:MCP>`, the engine calls the tool and
sends the result back as the next message. For long tasks the app keeps the renderer at
foreground priority, reloads a page that stops answering after the app returns
(`probePageLiveness`), and after a renderer crash or process restore reopens the same
conversation (`ChatUrls`).

## Slash commands

Typing `/` in the composer opens the command popup.

- Choosing an item only **fills the composer** (`/help `, `/export `…); nothing runs yet.
- A command runs when it is **sent** — Enter on a keyboard, or the send button, which
  is intercepted in the capture phase before DeepSeek's own handler.
- Unknown `/text` is sent to the AI unchanged.
- `/new` and `/compress` switch chats through DeepSeek's own new-chat control, so the
  page is never reloaded (a reload would briefly show the un-enhanced official page).

## Page lifecycle

The engine injection attempt is tied to `onPageFinished` of `chat.deepseek.com`, but a live
chat-surface and document-identity gate is rechecked immediately before the injection claim.
Navigation invalidates pending probes/assets; sign-in, CAPTCHA, loading, and unknown surfaces
fail closed. In-app navigation (DeepSeek is a single-page app) keeps a valid engine alive; a
full reload re-probes the new document before injecting.

## Launch screen

`BootScreenView` is a single native view drawn on the Canvas, in the chat's own dark
palette: the page's dark background colour (measured on an earlier run and remembered,
see below) with a soft vignette, a slow star field and an occasional faint shooting star,
the app icon with a faint brand-blue glow, and the Sora wordmark. The wordmark **is the
progress indicator**: its letters rise in dim, then fill with light from left to right
while the page loads, with a soft blue glow on the moving edge. The fill approaches 92%
and waits; it only completes when the page is ready. It is timed from its own frame
clock, so it plays even when the user has turned system animations off. The system
splash hands over on the first frame (same colour, icon in the same place).

The screen is released only when the enhanced page is really on screen, never on a
timer alone:

1. `onPageFinished` injects the engine and starts polling `READY_PROBE_JS` every 300 ms.
   The probe needs the engine CSS (`style#bds-css`), a fully-run `content.js`
   (`window.__sdHandleBack`) and a visible composer or sign-in field.
2. The probe must pass **and** `AndroidBridge.onUiPolished()` must have fired, or 3 s must
   have passed since `onPageFinished` if the polish signal never comes.
3. The wordmark fills to the end, a light sweeps across it and the screen fades into
   the chat. A minimum intro of 2 s keeps a fast (cached) launch from cutting the
   animation short.

The hard cap is 18 s (`BOOT_FORCE_DISMISS_MS`), so a stalled network can never trap the
user on the launch screen.

## System bars

The WebView stays inside the safe area (the root layout is padded by the status and
navigation bar insets), so DeepSeek's header buttons keep their position. The strips
behind the bars take the page's own colour, and the bar icons switch between light and
dark for contrast.

The colour is **measured on screen**: `PixelCopy` copies a 2 dp strip just inside the
top and the bottom edge of the page, and the dominant colour of each strip
(`dominantColor`) becomes the status bar and the navigation bar colour (opaque, with the
system contrast scrims turned off). Reading computed CSS is not exact enough, because
DeepSeek paints its header with gradient fade bands and layered surfaces. The bars are
measured again after every touch (drawers, sheets and navigation change the page),
after a light/dark switch (`AndroidBridge.reportTheme()`, which also recolours the bars
at once) and on resume. While the launch screen covers the page, a CSS estimate
(`PAGE_BG_PROBE_JS`) is used and the bars stay transparent over the launch scene.

The measured dark page colour is stored (`sd_ui` preferences), and the next launch
screen is built on it, so the launch screen and the chat share exactly the same
background. It is only stored at trustworthy moments: the fresh page right after the
launch screen, or just after a switch to dark, and never after a touch (an open sheet's
dim scrim must not be mistaken for the page colour).

## Back button

`MainActivity` asks the engine first: it evaluates `window.__sdHandleBack()` (defined at
the end of `content.js`). The helper closes the topmost engine surface — command popup,
dialog, help sheet, or steps a drawer subpage back to the overview — and returns `true`.
Only when it returns `false` does the WebView navigate back (or the app move to the
background on the first page).

## Generative UI

Engine modules, each evaluated as its own script (`MainActivity.NATIVE_MODULES`) so a
failure in one cannot stop the others:

| Module | Role |
|---|---|
| `sd-genui-protocol.js` | fenced-block protocol: header + JSON formats, one `validate()` gate, kinds html-app/react/document/code/mermaid/svg/ui/tool-result/mcp-app |
| `sd-genui-svg.js` | SVG allowlist sanitizer (PNG export path) |
| `sd-genui-prompt.js` | hidden prompt v3 (decision matrix: prose / inline visual / widget / artifact), config, `analyze()` compliance |
| `sd-genui-host.js` | host adapter: code-block discovery, diagnostics, redaction, ledger, `sendPrompt`, circuit breaker, export/share/PNG/CSV |
| `sd-genui-frame.js` | live sandboxed frames (opaque origin, CSP, host design tokens, streaming, auto-height, `sendPrompt`/`openLink`, React/Mermaid documents) |
| `sd-genui.js` | `sds-ui` schema renderer (inline widgets) |
| `sd-genui-viewer.js` | Claude-style artifact viewer (Preview/Code, versions, copy/download/share/full screen/edit with AI) + versioned artifact store |
| `sd-genui-inline.js` | inline visuals (` ```sds-visual `, raw svg) + legacy `<SDS:VISUALIZER>` / preview-panel takeover |
| `sd-genui-visuals.js` | tool/MCP result → table / chart / cards / json |
| `sd-artifacts.js` | artifact cards in messages (streaming "Generating…", fallback renderer for raw html, inline kinds) |
| `sd-genui-mcp.js` | MCP Apps host (spec 2026-01-26), inline under tool calls |
| `sd-genui-panel.js` | contextual settings sheet + artifact library + diagnostics + activity log |

Native side: `BridgeGate` (token-gates the `AndroidBridge` object Android injects into every
frame, so sandboxed frames cannot use it), `WebViewBridge.openGeneratedApp` → `GeneratedAppActivity`
(no bridge, CDN-GET-only network), `shareFile`, MCP fetch incl. `bds-mcp-read-resource`,
`mcpCredentialStatus/Forget` backed by `SecureCredentialStore` (Android Keystore AES-GCM),
`GeneratedApps` (bounded cache files).
Full protocol and threat model: [genui/PROTOCOL.md](genui/PROTOCOL.md).

## Engine self-check (2.72.0)

The engine rides on chat.deepseek.com's DOM: about thirty hashed class names and
a handful of stable ones. When DeepSeek deploys a redesign, a feature disappears
without an error, and the app has no telemetry by design, so the failure would
never be noticed. `sd-health.js` (loaded last) is the detector:

- it probes the page contract — composer, chat history, message list, markdown,
  code blocks, stop button, copy button, reasoning panel — where every check
  lists **alternative selectors**, so a partial change stays quiet;
- it probes the globals each native module installs (`__sdAgent`, `__sdRun`,
  `__sdGenui`, …), so a module that failed to run on a changed page is named;
- a **core** check failing (composer or history) or **3+** feature checks
  failing shows a dismissible strip; one or two missing features stay silent;
- the report (selectors, module names, user agent, URL without its query string)
  is copied with one tap, and the last 20 runs live in `localStorage.sd_health_v1`;
- *Advanced settings → Linux & Agent → Diagnostics* shows the same state and
  opens the report.

Kill switch: `localStorage.sd_health_off = '1'` or `__sdHealth.setEnabled(false)`.
The check never modifies the page beyond its own (tagged `data-sd-owned`) strip.

## Tests

- Kotlin unit tests: `android/app/src/test/java/…` (`./gradlew testDebugUnitTest`), run in CI.
- Engine/repository tests: `npm test` runs the Node engine suite, script-policy/release-readiness
  checks, and synthetic compliance-harness self-test; CI runs these separately so each result is
  visible. `repo-consistency.test.mjs` guards the version ladder and engine bundle/module contract.
- Generative UI acceptance: `npm run genui:acceptance` runs Playwright Chromium against
  `design-preview/genui.html` / `genui-csp.html` with a mocked bridge. The runner prints the
  current check count; screenshots are uploaded as the `genui-acceptance` artifact.
- CI (`.github/workflows/build-and-release-apk.yml`) builds APKs for checks and publishes only
  for configured release refs after the APK build and complete API 30/34/35 emulator matrix pass.
  The publishable APK gate checks package/version/versionCode, checksum, the pinned signer-certificate
  fingerprint, and the sandbox rootfs manifest plus native `proot`/`talloc` libraries. Instrumented
  tests currently cover cookie policy and system-bar/edge-to-edge behavior; the emulator job does
  not replace physical-device verification.
- The release checklist and current evidence are maintained in
  [`docs/RELEASE-READINESS.md`](RELEASE-READINESS.md).

The APK's only web assets are the engine files staged from `android/app/src/main/bds-assets/bds`;
the official site is the chat surface. (The earlier React SPA was removed in 2.50.)

## Token savers of the agent loop (2.71.0)

Every agent step is still one hidden DeepSeek web turn (there is no other way
on the web app), so 2.71.0 shrinks what each turn carries:

| | Where | What |
|---|---|---|
| T1 | content.js `sdMcpOne` | Results carry `call` (a ≤300-char summary: the command, or the path + size) instead of echoing the full `args` (a `write_file` used to send its whole content back) |
| T2/T3 | content.js `sdHT`, sd-agent.js `__sdSaveOutput` | An output over `mcpInlineMaxChars` (8000) keeps its head (40%) and tail (60%); the full text is saved in the sandbox at `/tmp/sd-out/<id>-<tool>.txt` through the unwrapped bridge and the model is told to `read_file` the part it needs. Not saved (old behaviour, file attachment) when Linux is not installed, in "ask" mode, for `read_file`, after Stop, or when the write fails / takes over 8 s |
| T4 | injected.js `I()` | Automatic messages (`[SDS:AUTO` / `[BDS:AUTO`) do not advance the injection counter and get no injected context (system prompt, memories, project RAG, skills, GenUI hints) |
| T5 | sd-agent.js `RUN_RULES` | One rule line in the tool instructions: short prose between calls, read saved outputs instead of re-running |
| T6 | sd-agent.js `capGate` | After every 25 tool calls of one instruction the user is asked whether to continue (Stop = Back = the first button) |

