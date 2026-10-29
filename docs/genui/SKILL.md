# GenUI + Artifacts — Toolchain & Workflow (beta)

Everything below is **project-local knowledge** from the Deepseek app's own
Generative UI work. It mirrors the `docs/skills/` agent-skill format used
upstream so future sessions can reuse the validated workflow.

## Identity

* **Name:** Deepseek Generative UI / Artifacts
* **Version:** 1.0.0 (beta) — milestones **M1–M4** complete, Phase D in progress.
* **Trigger:** when a request needs charts, diagrams, tables, calculators,
  interactive tools, offline mini-applications, Artifacts, **MCP Apps / resources,
  raw tool results**, external library previews, or distinct generated surfaces.

## What the engine is

A self-contained, offline-first runtime in `bds-assets/bds/`:

| File | Role |
| --- | --- |
| `sd-genui-protocol.js` | Spec/block detection (flat `ui` cards vs versioned artifacts, `mcp-app`, `tool-result`, `html-app`), export classification, SVG validation, trusted-UI URL allowlist |
| `sd-genui-svg.js` | Inline/animated SVG validation + sanitization + motion capability report |
| `sd-genui.js` | Schema UI (charts/tables/forms), spec block extraction, surface update, artifact actions (run/save/export/share, versioned edits), `__sdsGenUI.updateSurface()` |
| `sd-artifacts.js` | Artifact manager: draft/saved actions, native Share, export menu (HTML/SVG/JSON + honest PNG fallback), expandable `sds-artifact` viewer with history/edit/version + reset, contextual artifact diff surface |
| `sd-genui.css` | Mobile-first system (cards, chips, tables, forms, sliders, artifact raw cards, editable surface, diff surface, motion/reduced-motion) |

## Output ladder — **multi-block first**

Plain answers for plain questions. For visual tasks emit **one or more blocks
in one answer**, with prose between them:

1. **Prose** — no block.
2. **Inline SVG** — fenced ` ```svg ` for illustrations, animated SVG,
   diagrams, logos (validated + sanitized).
3. **Schema UI** — fenced ` ```sds-ui ` with `state`, `blocks[]`, `view`/`actions`.
4. **Saved artifacts** — versioned contracts:
   * `{kind:'svg', payload:{svg}}` saved illustrations, `{kind:'ui', payload:{spec}}` saved components
   * `{kind:'html-app', payload:{html,css,js}}` complete offline HTML/CSS/JS apps
   * `{kind:'tool-result', payload:{name,result}}` raw inspected tool results
   * `{kind:'mcp-app', view:'home'|'app', serverUrl, resourceUri}` configured MCP apps/resources
   * Text/JSON/JS optional custom-`text` artifacts (shared/exported only; honest labels).

## Design checklist (apply to every generated UI)

[ ] Identify the main user action and information hierarchy first.
[ ] Mobile-first layout; readable type scale; consistent spacing scale.
[ ] Restrained palette; high contrast; light/dark; `prefers-reduced-motion`.
[ ] 44px touch targets; semantic labels; focus states; error/empty states.
[ ] Composition follows the task — not every output is a card grid.
[ ] Every control has working logic (EMI zero-rate, Snake touch/score/restart…).
[ ] Label illustrative data. Test responsive layouts at 390×844 and 1280×720.

## Safety checklist (non-negotiable)

[ ] Generated JS never runs in the chat WebView (static DOM preview only).
[ ] Run opens an isolated native viewer with no bridge and `connect-src 'none'`.
[ ] Inline sandbox preview uses `sandbox=""`; URLs/images allowlisted.
[ ] Files/credentials never enter generated code, exports or shares.
[ ] Envelope strips `__proto__`/`constructor`; absolute parse budgets.
[ ] MCP Apps: only spec View methods relay; per-call native consent; credentials stay native.

## Workflow

1. **Analyze + discover** — read `SKILL.md`, `docs/genui/`, existing `bds-assets/bds/`.
2. **Choose type(s)** — svg / sds-ui / html-app / tool-result / mcp-app; multi-block.
3. **Build spec-first** — one thing per block, state only in the contract.
4. **Validate** — `cd android && ./gradlew testDebugUnitTest`; JS: `npm run test:engine` (from the repo root).
5. **Prove in-browser** — `scripts/genui-browser-check.mjs` (Chromium/Playwright, 390×844 + 1280×720).
6. **Package** — `assembleDebug`/`assembleRelease`; legacy `.apk` only (honest labels).

## Canonical prompts

* **Flash chart:** "Show a flash sales chart…"
* **EMI calculator:** "Build an interactive EMI calculator…" (handles zero-rate, live updates)
* **Swipe Snake:** "Build a swipe-controlled Snake game…" (2048 grid, score, restart)
* **Saved app + versioned edit:** "Create a savings tracker app…" then "update the artifact for interest rates"
* **Multi-block:** "Build a fitness dashboard with SVG chart and interactive tracker"
* **MCP app:** "Show the Weather home from the configured MCP server" / "Show my configured server's homepage"
* **Raw tool result:** "Show the raw result of the last tool call"
* **External library:** "Preview lightweight-charts showing one illustrative BTC/USD series"

## MCP Apps host (v3, replaces the old McpAppActivity)

* `sd-genui-mcp.js` is the in-page MCP Apps host (spec 2026-01-26). Tools that declare
  `_meta.ui.resourceUri` render **inline under their tool call** in an opaque-origin
  sandboxed frame. The resource is read natively (`bds-mcp-read-resource`), so keys stay native.
* Full `ui/*` lifecycle, consent per tool for app-originated `tools/call`, `visibility` respected,
  `resources/read` limited to `ui://`, declared CSP domains only (cleaned), ledger entries.
* `McpAppPolicy.kt` is still used natively for URI/server validation. `McpAppActivity` and
  `WebViewBridge.openMcpApp` were removed.

## M5 additions — controlled external resources (NEW)

* `P.allowedExternalUrl(url[, hosts])` — https-only, no credentials/userinfo, no raw IPs,
  no localhost/.local/.internal, curated default hosts (jsDelivr, unpkg, cdnjs, raw.githubusercontent,
  wikimedia, unsplash, fonts.gstatic). Subdomain-safe matching only.
* Inline chat previews may show external images **only** through this allowlist (src/srcset);
  generated frames and the full-screen viewer may load libraries only from the CDN allowlist
  (cdnjs, jsDelivr, unpkg, esm.sh, cdn.tailwindcss.com, Google Fonts) — GET only, no cookies.

## Known limitations (honest)

* Not validated on a physical Android device or on the live chat.deepseek.com page. srcdoc
  frames inherit the host page CSP; if it blocks inline scripts, surfaces show the
  "could not start here → Open full screen" fallback instead of rendering inline.
* PNG export is offered for SVG only.
* Live-model compliance with the v3 prompt has not been measured.
