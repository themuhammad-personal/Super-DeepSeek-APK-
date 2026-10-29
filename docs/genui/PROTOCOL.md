# Super DeepSeek Generative UI — protocol (engine v3, app 2.70.1)

The model's system prompt cannot be controlled and native tool calling is
unreliable, so Generative UI travels **inside ordinary markdown** as fenced code
blocks with a language label. Markdown renderers drop unknown XML tags, but they
always keep fenced code verbatim. That is why the protocol uses fenced blocks
and not tags.

## Three surfaces (the ChatGPT / Claude pattern)

| What the user needs | Surface | Fence |
|---|---|---|
| Facts, short answers | prose (markdown tables are fine) | — |
| An explanation, a process, a comparison, a trend, numbers to explore | **inline visual**: drawn into the answer like a figure, with no card or border; streams while written; sized to its content | ` ```sds-visual ` |
| A small fixed widget (calculator, stats, table) | **inline widget**: validated JSON turned into DOM nodes | ` ```sds-ui ` |
| A deliverable to keep, edit or download — including any explicitly requested file (app, game, site, document, source/config/data file, long code, diagram) | **artifact**: a compact card in the message that opens the Claude-style viewer | ` ```sds-genui ` |
| An MCP tool that declares a UI | **MCP App**: shown inline under the tool call | (automatic) |

The old `<SDS:VISUALIZER>` tag is deprecated in the prompt. If the model still
uses it, the 600 px legacy card is hidden and its content is rendered inline by
the new renderer. The legacy HTML preview panel is redirected to the artifact
viewer. Toggle: `modules.legacyVisualizer`.

## ` ```sds-visual ` — inline visuals

```text
title: How DNS resolution works      (optional first line)
<style>…</style>                     short, first
<svg viewBox="0 0 400 H" width="100%">…</svg> and/or HTML
<script>…</script>                   last; runs when the block is complete
```

* Rendered in a sandboxed `<iframe sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock">`.
  The frame has **no `allow-same-origin`**, so it gets an opaque origin with no
  access to the chat page, its cookies or its storage.
* The host injects the chat font, light/dark CSS variables (`--color-text-*`,
  `--color-background-*`, `--color-border-tertiary`, `--accent`), pre-styled
  controls, helper classes (`.card .grid .row .metric .label .muted`) and SVG
  classes (`t ts th`, `.box`, `.arr` with an automatic arrowhead, colour
  ramps `c-blue … c-gray`).
* `html[data-theme]` follows the chat theme live.
* While streaming, the markup is applied progressively with scripts stripped.
  When the block is complete it is loaded once, with scripts enabled.
* Height follows the content through a ResizeObserver. The cap is 1800 px,
  and runaway growth is clamped.
* Actions under the visual (icon row): Expand (viewer), Copy code, Download
  (standalone HTML/SVG), Save as artifact, Show code.
* `sendPrompt(text)` asks a follow-up in the chat. A tap inside the frame
  sends it directly (at most 4 per minute). Any other call shows a "Send to
  chat" confirmation. `openLink(url)` always asks first.
* Raw ` ```svg ` (and ` ```xml ` that is an SVG) uses the same inline renderer.

## ` ```sds-genui ` — artifacts

```text
id: stable-kebab-id          required, ^[A-Za-z][A-Za-z0-9_-]{0,63}$
kind: html-app | react | document | code | mermaid | svg | ui | tool-result | mcp-app
title: Short human title
revision: 1                  optional
presentation: inline         optional: render html-app/svg/mermaid inline instead of a card
language: python             code only
name / view                  tool-result only
server / resource            mcp-app only (https:// server, ui:// resource)
---
<body>
```

The JSON envelope (`{"version":1,"id":…,"kind":…,"payload":{…}}`) is still
accepted. Both forms pass through the **same** `validate()` gate in
`sd-genui-protocol.js`. Aliases: `html|app → html-app`, `markdown|md|doc →
document`, `jsx|tsx → react`, `diagram → mermaid`.

| kind | Body | Card / viewer preview |
|---|---|---|
| html-app | complete single-file HTML; CDN libraries allowed | live, sandboxed |
| react | one JSX file with `export default` (React 18, recharts, lucide-react, d3, three, chart.js, framer-motion, lodash; Tailwind) | Babel standalone + import map from esm.sh |
| document | markdown | rendered markdown |
| code | the source file | code view with line numbers and highlighting |
| mermaid | mermaid source | mermaid 11, `securityLevel: strict` |
| svg | one `<svg>` | live |
| ui, tool-result, mcp-app | as before | rendered **inline**, never as a card |

### File-first generation

If the user asks to create, write, save, export, or download a file, return the deliverable as a `sds-genui` artifact; do not substitute prose or an inline-only visual. Use the requested filename (including extension) as its title when possible. Use `kind: code` with `language:` for downloadable text/source/data/config formats such as CSV, TSV, JSON, YAML, TOML, XML, SQL, HTML, Python, TypeScript, Kotlin, Jupyter JSON and config files; use `document` for Markdown; reserve `html-app` for a runnable/interactive app. The viewer exports actual source formats; it does not synthesize true binary PDF, DOCX, XLSX or PPTX files. For those, provide a clearly labelled print-ready/source artifact and state its actual download format.

**Card** (claude.ai): icon tile, title, "type · version", and a download
button. While the block streams, the card shows a spinner and "Generating…".
Tapping the card during streaming opens the viewer on the Code tab, which
shows the source as it streams.

**Viewer**: full screen on phones; a right-hand split panel at 960 px or more,
where the chat reflows to the left. The header has:

* Close.
* The title, with a "type · vN" version picker.
* A Preview | Code segmented control.
* Copy, plus a menu: Download (.html/.jsx/.md/.svg/…), Download as PNG (svg),
  Download as HTML (react/mermaid/visual), Share, Open in full screen (native
  isolated activity), Re-run, Edit with AI…, Generative UI settings.

If the preview errors, the viewer shows "Fix with AI". Android Back closes the
viewer.

**Versions**: the same `id` in the same chat creates a new version of one
artifact. Identical content is deduplicated. Limits: 12 versions per artifact,
40 artifacts, 900 KB of storage (`sd_genui_artifacts_v2`, native storage). A
**library** of saved artifacts is available in *Generative UI settings →
Artifacts* (open / delete).

## Lenient parsing (2.70)

Models get the format slightly wrong all the time; the parser repairs instead
of failing. Security checks in `validate()` stay strict.

* Headers end at the first non-`key: value` line, or at a line starting with
  `<`; the `---` separator is optional. Duplicate headers: the first wins.
* `kind` is resolved through aliases, then code-language names (`python` →
  `code`), then inferred from the body (`<svg` → svg, `<!doctype`/`<html` →
  html-app, `graph TD` → mermaid, `export default` → react, else document).
* Invalid ids are slugged; a missing title is taken from `<title>` or the first
  `#` heading. Broken JSON envelopes are repaired where unambiguous.
* Only an unrecoverable body (e.g. `kind: ui` with JSON that cannot be
  parsed) is an error — shown as a quiet error card with **Show code** and
  **Ask to fix**, never as raw code.

## Streaming, loading and failure behaviour

* Rendering is driven by the rendered markdown DOM. It supports both DeepSeek's
  `.md-code-block` + banner shape and the generic `pre > code.language-x` shape.
* **No raw-code flash (claim layer).** A MutationObserver callback runs as a
  microtask, before the next paint. Every code block in one of our languages
  is hidden right there (`data-sd-hidden="claim"`), and a skeleton with the
  geometry of the final surface (`.sd-skel`: artifact-card height for
  artifacts, 168 px for visuals) takes its place. The renderer then hands over
  or gives the block back. Raw ```` ```html ```` / ```` ```svg ```` are claimed
  only once their content proves they are ours (complete document / `<svg`);
  short snippets stay code.
* Old chats: a block in a message that is not the last one is final at once,
  so reopened chats render immediately without the 1.6 s wait.
* Inline frames only ever grow while streaming (no jump back) and are held
  for up to 1.4 s until the first real size arrives.
* A block is final when more markdown follows it, or after 1.6 s without
  changes. A visibly complete body (`</svg>`, `</html>`) also counts.
* If a typed artifact is malformed or its renderer throws, the engine first tries a non-executable, downloadable source-only code artifact within protocol size limits. The fallback uses a block-specific ID and cannot overwrite a working artifact's kind or version history. Only when that fallback cannot be safely stored does an error card appear with **Show code** and **Ask to fix**. The fallback never executes generated code. Each code block keeps its own state, so DOM mutations never duplicate cards.
* Kill switch: disabling Generative UI removes every surface and skeleton and
  restores the original code blocks; enabling it again re-renders.
* `guard()` circuit breaker: a module that throws repeatedly is switched off
  for the session, and the chat keeps working.
* Watchdog: if a frame does not boot within 6 s (for example, the host page
  CSP blocks scripts inside `srcdoc`), the surface shows "could not start
  here", with **Open full screen**. That opens the native isolated viewer.

## MCP Apps (spec `io.modelcontextprotocol/ui`, 2026-01-26)

* The engine's own MCP client lists tools. The native `initialize` advertises
  `capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes = ["text/html;profile=mcp-app"]`.
* When a called tool declares `_meta.ui.resourceUri` (or the deprecated
  `_meta["ui/resourceUri"]`) with `ui://…`, the resource is read **natively**
  (`bds-mcp-read-resource`, so the key never leaves native code). The app is
  then mounted inline right after the tool's execution card.
* Compatibility: some deployed servers put `_meta.ui.resourceUri` only on the
  `CallToolResult` (not on the tool definition). That is accepted too; the
  resource is still read natively from the same server and must be `ui://`.
  Live check against a real public server: `npm run genui:mcp-live`.
* The frame CSP is the spec default plus only the clean `https://` origins
  declared in `_meta.ui.csp.connectDomains/resourceDomains`. Wildcards, IPs,
  localhost, `.local`, `.internal` and plain http are dropped.
* Lifecycle: `ui/initialize` → result (hostInfo "Super DeepSeek",
  hostCapabilities, hostContext: theme, styles, toolInfo, displayMode,
  containerDimensions) → `ui/notifications/initialized` → `tool-input` →
  `tool-result`. Also supported: `size-changed`, `host-context-changed`
  (theme), `ui/open-link` (confirm), `ui/message` (tap or confirm, rate
  limited), `ui/request-display-mode` (inline ↔ fullscreen; Back exits),
  `ui/update-model-context`, `notifications/message`, `ping`,
  `resource-teardown`.
* Requests from the app:
  * `tools/call` needs **in-page consent** per tool. A tool whose
    `visibility` excludes `"app"` is refused. Every call is written to the
    execution ledger.
  * `resources/read` is limited to `ui://`.
* Calls made from the app never mount a second view.
* A declared ` ```sds-genui kind: mcp-app ` block mounts the same host inline.

## Web access from visuals and artifacts (2.70)

Generated code has no network of its own (frame CSP). Inside visuals and
artifact previews:

* `fetch(url, init)` for any absolute `http(s)` URL outside the CDN list, and
  `sdFetch(url, init)`, return a real `Response`. `sdImage(url)` returns a
  `data:` URL. An `<img>` from any other site that the CSP blocked is retried
  through the same path automatically.
* Frame → host `{type:'fetch'}` → **consent once per website**: "“Title”
  wants to access example.com" with *Deny* (for this session), *Allow once*
  (this surface) or *Always allow* (stored in `sd_fetch_grants_v1`; listed and
  revocable in *Generative UI settings → Web access from visuals*). One sheet
  at a time; an unanswered sheet expires after 2 minutes.
* Host checks before asking: http/https only, ports 80/443/8080/8443, no
  credentials in the URL, no dotless/`.local`/`.internal`/`.lan`/`.home`/
  `.corp`/localhost hosts, no private IP literals; GET/HEAD/POST only; at most
  60 requests per minute and 6 in flight per surface — further requests wait
  their turn (up to 32 open per surface) instead of failing. (2.70.1)
* A `Request` object keeps its method, headers and body; `FormData`,
  `URLSearchParams`, `Blob` and typed-array bodies are encoded as the browser
  would, with their `Content-Type`; a plain object is sent as JSON. (2.70.1)
* Native `bds-frame-fetch` (`FrameFetchPolicy.kt`) re-checks everything: DNS
  answers are filtered (private, loopback, link-local, CGNAT, multicast,
  reserved, `fc00::/7`, `fe80::/10`, IPv4-mapped, documentation ranges) and
  every hop — redirects included — is re-validated (`HopGuard`). IPv4 inside
  NAT64/6to4 addresses is judged as IPv4; no proxy is ever used (2.70.1). **No cookies,
  no cache, no page credentials**; `Cookie`, `Origin`, `Referer`, `Host`,
  `Sec-*`, `Proxy-*` and `X-Forwarded-*` headers are dropped. Limits: 20 s,
  8 MB response (truncated flag), 256 KB request body. Every request is
  written to the execution ledger.
* MCP Apps do **not** get this path: they keep the spec CSP
  (`connectDomains`).

## Uploads (2.70)

`sd-files.js` listens for `change` on the chat's `<input type=file>` in the
capture phase (before the page), so it covers DeepSeek's own upload button,
the + sheet's *Upload file* and Android shares alike:

* Files the input accepts (PDF, Office, images, text, code…) pass through
  unchanged — DeepSeek parses them server-side. If the chat's upload input
  declares no `accept` list, the formats DeepSeek's web chat documents are
  assumed (PDF, doc/docx, xls/xlsx/csv, ppt/pptx, txt/md, common code and data
  files, jpg/png/gif/webp/bmp); folder pickers and the engine's own inputs are
  never given that default. (2.70.1)
* Refused files are converted to text **on the device** and uploaded as
  `<name>.txt`: OpenDocument (odt/ods/odp), EPUB (spine order), RTF,
  docx/xlsx/pptx when the input does not list them, ZIP-style archives
  (listing + readable inner files, 6 M chars budget), unknown text formats,
  and a strings/metadata summary for opaque binaries. Text over 1.5 M chars
  is split into up to 12 noted parts. UTF-16 text (with a byte-order mark) is
  read as text. When conversion takes time, an accessible, app-language progress
  card shows the current file and offers **Stop**; stopping aborts active reads /
  inflation and never attaches a partial selection. Preparation failures keep
  and replay the original selection with a message.
* Unpacking is capped while it streams, never trusting the sizes an archive
  declares: 4 MB per file inside a generic archive; 32 MB per Office/EPUB XML
  part and 48 MB aggregate per Office/EPUB container. A zip bomb is refused
  with a note, not unpacked. Files over 24 MB that are not archives are read
  only up to 24 MB (more could not be uploaded anyway), with a note saying so.
  (2.70.1)
* Audio and video are refused with a message. Native picking streams files up
  to 100 MB (text and binary alike); DeepSeek's own server-side limits still
  apply to what it accepts.

## Execution and security model

| Surface | Where generated code runs | Network | Native bridge |
|---|---|---|---|
| `sds-ui` widget | nowhere: schema → DOM; formulas use a tiny arithmetic parser | none | none |
| Inline visual / artifact preview | sandboxed opaque-origin iframe (srcdoc) | CDN libraries (`cdnjs`, `jsdelivr`, `unpkg`, `esm.sh`, `cdn.tailwindcss.com`; fonts); other public sites only via the consented, cookie-less `sdFetch` path above | **gated**: the object Android injects into every frame rejects calls without the page token (`BridgeGate.kt`) |
| MCP App | sandboxed opaque-origin iframe | only domains the resource declared | gated (as above); tool calls go through the host with consent |
| Open in full screen | `GeneratedAppActivity`: a separate WebView with no JS interface. Native code answers every subrequest with 403, except https GETs to the same CDN list. Navigation is blocked. The activity has a 10-minute lifetime | CDN GETs only | none |

* **Loop guard.** On Android a srcdoc frame shares the chat page's main thread,
  so the sandbox isolates data but not CPU. Inline scripts of generated
  surfaces (visual, html-app, svg; React after Babel) are rewritten so every
  `while`/`do…while` condition and classic `for(;;)` condition first calls
  `__sdLoop(id)`. A loop that keeps the thread busy for 2 s is stopped and the
  surface shows the error with "Fix with AI". Not covered: recursion (throws on
  its own), `for…in/of`, inline `on*=` attributes, external scripts and MCP
  Apps (server code is not rewritten).
* Frame → host messages are accepted only when `event.source` is that frame's
  own `contentWindow` (plus a per-frame channel id).
* Credentials: MCP keys are held natively (memory + Android Keystore AES-GCM,
  excluded from backups). JavaScript can only ask whether a key is stored.
* Exports and shares pass through secret redaction first (API keys, tokens,
  JWTs, private keys, `password=`…). In CSV, cells starting with `= + - @`
  are neutralized.

## Hidden prompt (v3)

`sd-genui-prompt.js` builds the guidance that `injected.js` appends to the
outgoing request. The guidance is wrapped in
`<SuperDeepSeek>…</SuperDeepSeek>`, which the engine's existing cleaner strips
from the visible user bubble.

* Modules: `core` (always on; the decision matrix above), `visual`, `schema`,
  `apps`, `svg`, `mcp`. They are chosen per request by intent.
* Frequency: `auto` (default) · `always` · `every_n` · `first` · `off`.
* There is also a master kill switch.

Compliance is **measured, not assumed**. `npm run genui:compliance` analyses
real saved responses with the shipped validators. No live number has been
recorded yet.

## Host adapter

`window.__sdGenUIHost` is available to the trusted page only:

* `codeBlocks()`, `diagnose()`.
* `sendPrompt(text, {submit, event, frameTap})`: refuses duplicates within
  4 s and secret-looking text.
* `ledger`, `redact()`, `exportText()`/`shareText()`, `svgToPng()`,
  `toCsv()`, `guard()`.

Selectors for message, markdown and composer are configurable in settings.
