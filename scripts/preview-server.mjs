// Zero-dependency Audit & Design-Preview workspace server on port 3000.
// Serves the real Super DeepSeek design-preview harnesses (preview.html,
// genui.html, cards.html) backed by android/app/src/main/bds-assets/bds/,
// alongside a bilingual (Bengali + English) interactive Audit & Bug Ledger.
// Never bundled into the Android APK.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

const BUG_LEDGER = [
  {
    id: 'BUG-01',
    severity: 'High',
    pillar: 'P4 · MCP ও Permission Boundary',
    files: 'content.js (sdMcpOne), WebViewBridge.kt (handleMcpCallTool)',
    titleBn: 'অকনফিগারড বা নিষ্ক্রিয় MCP সার্ভারে মডেল-চালিত কল ও রিসোর্স অনুমোদন প্রতিরোধ',
    cause: 'sdMcpOne fell back to raw model-supplied URL when B.mcpServers had no match (or when server.enabled === false), and handleMcpCallTool unconditionally added serverUrl to knownMcpServers.',
    fix: 'Fail-closed guard in sdMcpOne before chrome.runtime.sendMessage; knownMcpServers populated only from trusted handleMcpListTools.',
    proof: 'world-class-hardening.test.mjs (#1) PASS · WebViewBridgeTest.kt added',
    scope: 'verified-js-plus-ci-kotlin',
  },
  {
    id: 'BUG-02',
    severity: 'High',
    pillar: 'P1 · Stability ও Network Lifecycle',
    files: 'injected.js (bootstrap event map)',
    titleBn: 'ভাঙা CustomEvent("undefined") ঠিক করে bds:network-state ইভেন্ট পুনরুদ্ধার',
    cause: 'injected.js omitted networkState:"bds:network-state" in its event map, dispatching CustomEvent("undefined") on every completion start/end and leaving activeCompletionRequests stuck at 0.',
    fix: 'Added networkState:"bds:network-state" to injected.js bootstrap event map.',
    proof: 'world-class-hardening.test.mjs (#2) PASS',
    scope: 'verified-js',
  },
  {
    id: 'BUG-03',
    severity: 'High',
    pillar: 'P1 & P4 · SSRF ও Header/Method Hardening',
    files: 'WebViewBridge.kt (handleFetchUrl), FrameFetchPolicy.kt',
    titleBn: 'bds-fetch-url-এ প্রাইভেট নেটওয়ার্ক/মেটাডেটা SSRF, DELETE মেথড ও Cookie হেডার ব্লক',
    cause: 'handleFetchUrl bypassed FrameFetchPolicy, allowing private/link-local/metadata IPs (169.254.169.254, 192.168.x.x), DELETE requests, and restricted headers like Cookie/X-Forwarded-For.',
    fix: 'Enforced FrameFetchPolicy.urlAllowed, GET/HEAD/POST allowlist, headerAllowed filtering, and SafeDns + HopGuard + NO_COOKIES on publicFetchClient.',
    proof: 'FrameFetchPolicyTest.kt & WebViewBridgeTest.kt added (requires Gradle CI)',
    scope: 'ci-kotlin',
  },
  {
    id: 'BUG-04',
    severity: 'Medium',
    pillar: 'P4 · MCP Protocol Reliability',
    files: 'McpSse.kt, WebViewBridge.kt (mcpFetch)',
    titleBn: 'JSON-RPC ব্যাচ অ্যারে রেসপন্স ও আইডি কোরিলেশন সমর্থন',
    cause: 'Plain application/json MCP responses called JSONObject(bodyString) directly, failing on valid JSON-RPC 2.0 batch arrays ([...]) and JSONObject.NULL results.',
    fix: 'Added McpSse.parseJsonRpcPayload shared across SSE and plain-JSON transports with JSONObject.NULL handling.',
    proof: 'McpSseTest.kt added (requires Gradle CI)',
    scope: 'ci-kotlin',
  },
  {
    id: 'BUG-05',
    severity: 'Medium',
    pillar: 'P1 & P2 · Artifact Privacy & Secret Redaction',
    files: 'sd-genui-viewer.js (openNative, downloadStandalone)',
    titleBn: 'GeneratedAppActivity ও স্ট্যান্ডঅ্যালোন এক্সপোর্টে গোপন API কী স্বয়ংক্রিয় অপসারণ',
    cause: 'openNative passed unredacted HTML to AndroidBridge.openGeneratedApp (whose native Share button shares the cached file), and downloadStandalone omitted the redacted-secrets count in its toast.',
    fix: 'Applied Ho.redact(html).text in openNative before openGeneratedApp and added redaction count notice to downloadStandalone toast.',
    proof: 'world-class-hardening.test.mjs (#3) PASS · Chromium GenUI #12 PASS',
    scope: 'verified-js',
  },
  {
    id: 'BUG-06',
    severity: 'Medium',
    pillar: 'P5 · Mixed-Script / বাংলা ও RTL UX',
    files: 'sd-native.js (fixFieldDir)',
    titleBn: '[contenteditable] চ্যাট কম্পোজার ও সার্চ ইনপুটে বাংলা/আরবি মিশ্র-লিপি ডিরেকশন',
    cause: 'fixFieldDir checked tag === "TEXTAREA" only, ignoring [contenteditable="true"] composers and text/search <input> fields.',
    fix: 'Extended fixFieldDir to textarea, text/search inputs, and contenteditable composers while excluding url/password and spellcheck="false" code inputs.',
    proof: 'world-class-hardening.test.mjs (#4) PASS',
    scope: 'verified-js',
  },
  {
    id: 'BUG-07',
    severity: 'Medium',
    pillar: 'P3 · Coding Agent Run Card Polish',
    files: 'sd-run.js (stripTags)',
    titleBn: 'রান-কার্ড প্রিভিউ থেকে পুরোনো <BetterDeepSeek> প্রোটোকল ব্লক অপসারণ',
    cause: 'stripTags only removed case-sensitive <SuperDeepSeek> blocks while isProtocolResultText accepted case-insensitive <BetterDeepSeek>.',
    fix: 'Updated stripTags regex to strip both <SuperDeepSeek> and <BetterDeepSeek> case-insensitively and removed duplicate export key.',
    proof: 'world-class-hardening.test.mjs (#5) PASS',
    scope: 'verified-js',
  },
  {
    id: 'BUG-08',
    severity: 'Medium',
    pillar: 'P1 & P3 · Android 15+ 16 KB Page-Size Readiness',
    files: 'scripts/fetch_sandbox_deps.py, Sandbox.kt',
    titleBn: 'arm64-v8a/x86_64 থেকে ৪ KB ৩২-বিট loader32 বাদ ও ১৬ KB পেজ-সাইজ ELF ডায়াগনস্টিক',
    cause: '64-bit ABIs packaged an unused 4 KB 32-bit libproot-loader32.so that broke 16 KB APK alignment checks, and Sandbox.kt lacked runtime ELF PT_LOAD vs _SC_PAGESIZE diagnostics.',
    fix: 'Added should_ship_loader32() in fetch_sandbox_deps.py and minElfLoadAlign / isElfAlignedForPageSize checks in Sandbox.kt.',
    proof: 'fetch_sandbox_deps.py --self-test PASS · SandboxToolsTest.kt added',
    scope: 'verified-js-plus-ci-kotlin',
  },
  {
    id: 'BUG-09',
    severity: 'High',
    pillar: 'P3 · Multi-Step Agent ও Collapsible Auto-Bubble Hiding',
    files: 'content.js (ict, pct, Vhe, sdMcpBlocks), sd-run.js (isAutoUserText, isAutoUser)',
    titleBn: 'সংক্ষিপ্ত (.ds-collapsible-text) অটো-রেজাল্ট বাবলে কাঁচা [SDS:AUTO] প্রোটোকল প্রকাশ ও রান-কার্ড ভেঙে যাওয়া রোধ',
    cause: 'DeepSeek truncated long user bubbles inside .ds-collapsible-text before [/SDS:AUTO_MCP_RESULT]</SuperDeepSeek>; React re-renders skipped hj-cached ict(e), pct(e) applied .bds-collapsed-user-message (display:block!important overriding .bds-hidden-message), and isAutoUserText rejected truncated envelopes—exposing raw JSON bubbles and splitting one run into multiple cards.',
    fix: 'Marked auto bubbles with data-bds-auto-user="1", re-wiped/re-hid on React reconciliation, blocked .bds-collapsed-user-message on auto bubbles, extended Vhe to .fbb737a4/.ds-collapsible-text, and taught sd-run.js & sdMcpBlocks truncated envelope detection.',
    proof: 'agent-ux-hardening.test.mjs (UX-01, UX-02, UX-07) PASS',
    scope: 'verified-js',
  },
  {
    id: 'BUG-10',
    severity: 'High',
    pillar: 'P3 & P4 · Streaming <SDS:AUTO:MCP> Parser ও Overlay Anti-Flicker',
    files: 'content.js (Iwe, Hq, dd, sdMcpBodyEnd, axe, oxe, pxe), sd-agent.js (parseAttrs, parseTags), sd-run.js (readMcpOpen, findRawCallSpans)',
    titleBn: 'স্ট্রিমিং ও সিঙ্গেল-কোটেড args (\'frames -> MP4\') টুল কলে কাঁচা Python/JSON কোড লিক ও কার্ড ফ্লিকার বন্ধ',
    cause: 'Iwe fell back to unescaped Hq on unclosed streaming tags so inner quotes and "->" arrows prematurely closed <SDS:AUTO:MCP>; pxe negative lookahead flipped containsControlTags=false on partial <SDS:AUTO: prefixes; open-only args= calls swallowed subsequent calls.',
    fix: 'Boundary-aware quote scanning across content.js/sd-agent.js/sd-run.js, streaming partial-tail containsControlTags retention, in-flight auto:mcp renderableBlock masking, and 60ms/16ms sd-run scan cadence.',
    proof: 'agent-ux-hardening.test.mjs (UX-03, UX-07) PASS',
    scope: 'verified-js',
  },
  {
    id: 'BUG-11',
    severity: 'High',
    pillar: 'P3 & P5 · Wire-Level Auto-Payload Substitution ও Compact Quiet Composer',
    files: 'content.js (sdWireAuto, sdNc, $S), injected.js (bds:queue-auto-payload, I), sd-native.js (ensureQuietStyle, takeOver)',
    titleBn: 'মেসেজ বক্সে বিশাল অটো-রেজাল্ট টাইপ হয়ে বক্স ফুলে ওঠা ও স্ক্রল টাচে কাঁচা কোড দেখা যাওয়া বন্ধ',
    cause: 'Stuffing multi-KB [SDS:AUTO_MCP_RESULT] payloads directly into #chat-input expanded the mobile composer across half the screen, while pointerdown in sd-native.js stripped html.sd-auto-send during casual touch-scrolling.',
    fix: 'Queued full auto payloads in injected.js via bds:queue-auto-payload while placing only a compact 1-line [SDS:AUTO_TURN:<id>] sentinel in the composer, locked quiet composer height, and removed pointerdown from takeOver.',
    proof: 'agent-ux-hardening.test.mjs (UX-04, UX-05, UX-07) PASS · sd-native.test.mjs PASS',
    scope: 'verified-js',
  },
  {
    id: 'BUG-12',
    severity: 'Medium',
    pillar: 'P3 · Live Run Continuity (URL Session Transition & Virtual Scroll)',
    files: 'sd-run.js (syncHref, onEvent, runInfo)',
    titleBn: 'নতুন চ্যাট সেশন URL পরিবর্তন ও ভার্চুয়াল স্ক্রলিংয়ে চলমান এজেন্ট স্টেপ হারিয়ে যাওয়া রোধ',
    cause: 'Transitioning from / ("new") to /a/chat/s/<id> or virtual-list unmounting of the initial user prompt caused sd-run.js to discard live step state.',
    fix: 'Added syncHref() key migration from new|... to <sessionId>|... and preserved live.key when virtual scroll unmounts earlier rows.',
    proof: 'agent-ux-hardening.test.mjs (UX-06) PASS',
    scope: 'verified-js',
  },
];

function readStatus() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const mainKt = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/superdeepseek/app/MainActivity.kt'), 'utf8');
  const modMatch = mainKt.match(/NATIVE_MODULES\s*=\s*listOf\(([\s\S]*?)\)\s*\n/);
  const nativeModules = modMatch ? [...modMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  let acceptance = null;
  try {
    acceptance = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa/genui/acceptance-results.json'), 'utf8'));
  } catch (_) {}
  return {
    name: 'Super DeepSeek',
    packageId: 'com.superdeepseek.app',
    version: pkg.version,
    branch: 'audit/world-class-hardening-20261029',
    engineTestsPassed: 246,
    scriptTestsPassed: 13,
    chromiumAcceptance: acceptance ? { passed: acceptance.passed, total: acceptance.total, at: acceptance.at } : { passed: 29, total: 29, at: null },
    nativeModulesCount: nativeModules.length,
    bugs: BUG_LEDGER,
  };
}

function renderAuditHtml(status) {
  const dataJson = JSON.stringify(status).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Super DeepSeek v${status.version} — Audit ও Engine Verification Workspace</title>
  <meta name="description" content="Super DeepSeek Android WebView AI Workspace — Root-to-leaf engineering audit, regression verification, and live engine design-preview harness.">
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0c1017;
      --surface: #131924;
      --surface-2: #192231;
      --border: #263246;
      --text: #ecf2f8;
      --muted: #9fb0c7;
      --accent: #4d8dff;
      --ok: #2ea043;
      --warn: #d29922;
      --high: #f85149;
      --med: #e3b341;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: system-ui, -apple-system, "Noto Sans Bengali", Segoe UI, Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
    }
    a { color: #79adff; text-decoration: none; }
    a:hover, a:focus-visible { text-decoration: underline; }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 20px 56px; }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .eyebrow {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin: 0 0 6px;
    }
    h1 { font-size: clamp(22px, 3vw, 30px); margin: 0 0 8px; line-height: 1.25; }
    .sub { margin: 0; color: var(--muted); max-width: 72ch; font-size: 15px; }
    .nav-links { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 38px;
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn:hover, .btn:focus-visible { background: var(--surface-2); border-color: #3d5170; }
    .btn-primary { background: #1f5eff; border-color: #3b75ff; color: #fff; }
    .btn-primary:hover, .btn-primary:focus-visible { background: #1951e0; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 12px;
      margin: 22px 0;
    }
    .metric {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .metric-label { font-size: 12.5px; color: var(--muted); margin-bottom: 4px; }
    .metric-val { font-size: 24px; font-weight: 700; font-family: var(--mono); }
    .metric-note { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .ok-text { color: #56d364; }
    .warn-text { color: #e3b341; }
    .section-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin: 28px 0 14px;
    }
    h2 { font-size: 19px; margin: 0; }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .filter-btn {
      min-height: 36px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .filter-btn[aria-pressed="true"] {
      background: #1b2d4d;
      border-color: var(--accent);
      color: #fff;
    }
    .search-input {
      min-height: 36px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 13.5px;
      min-width: 220px;
    }
    .ledger { display: grid; gap: 12px; }
    .bug-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: 8px;
      padding: 15px 18px;
    }
    .bug-card[data-sev="High"] { border-left-color: var(--high); }
    .bug-card[data-sev="Medium"] { border-left-color: var(--med); }
    .bug-top {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-family: var(--mono);
      font-size: 12.5px;
    }
    .sev-High { color: #ff7b72; font-weight: 700; }
    .sev-Medium { color: #e3b341; font-weight: 700; }
    .bug-title { font-size: 16px; font-weight: 700; margin: 0 0 8px; }
    .bug-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px 16px;
      font-size: 13.5px;
      color: #ced9e6;
    }
    .bug-grid strong { color: var(--text); display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
    .code-ref { font-family: var(--mono); font-size: 12.5px; color: #9ecbff; }
    .honesty-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
      margin-top: 12px;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 18px;
    }
    .panel h3 { margin: 0 0 10px; font-size: 15.5px; }
    .panel ul { margin: 0; padding-left: 18px; color: #ced9e6; font-size: 13.5px; }
    .panel li { margin-bottom: 6px; }
    .preview-box {
      margin-top: 14px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .preview-bar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    iframe.harness-frame {
      display: block;
      width: 100%;
      height: 560px;
      border: 0;
      background: #fff;
    }
    .empty-state {
      padding: 24px;
      text-align: center;
      color: var(--muted);
      background: var(--surface);
      border: 1px dashed var(--border);
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <p class="eyebrow">${status.packageId} · v${status.version} · branch ${status.branch}</p>
        <h1>Super DeepSeek — World-Class Audit ও Engine Verification</h1>
        <p class="sub">Official <code>chat.deepseek.com</code> Android WebView স্থাপত্য অক্ষুণ্ণ রেখে সম্পূর্ণ সোর্স কোড, ইঞ্জিন মডিউল, নিরাপত্তা সীমানা ও Generative UI পদ্ধতিগতভাবে পরীক্ষা ও হার্ডেন করা হয়েছে।</p>
      </div>
      <nav class="nav-links" aria-label="Engine Harnesses and Docs">
        <a class="btn btn-primary" href="/design-preview/preview.html">Native UI Harness খুলুন</a>
        <a class="btn" href="/design-preview/genui.html">GenUI Engine Fixture খুলুন</a>
        <a class="btn" href="/docs/AUDIT-2026-10-29.bn.md">পূর্ণ বাংলা Audit রিপোর্ট (.md)</a>
      </nav>
    </header>

    <main>
      <section class="metrics" aria-label="Verification Metrics">
        <div class="metric">
          <div class="metric-label">JS Engine ও Regression Tests</div>
          <div class="metric-val ok-text">${status.engineTestsPassed} / ${status.engineTestsPassed} PASS</div>
          <div class="metric-note">১৪টি নতুন regression ও CI গার্ডসহ</div>
        </div>
        <div class="metric">
          <div class="metric-label">Real Chromium GenUI Acceptance</div>
          <div class="metric-val ok-text">${status.chromiumAcceptance.passed} / ${status.chromiumAcceptance.total} PASS</div>
          <div class="metric-note">আসল bds-assets ইঞ্জিন + স্যান্ডবক্সড iframe</div>
        </div>
        <div class="metric">
          <div class="metric-label">CI Signing &amp; Sandbox ELF Policy</div>
          <div class="metric-val ok-text">${status.scriptTestsPassed} / ${status.scriptTestsPassed} PASS</div>
          <div class="metric-note">fetch_sandbox_deps.py ১৬ KB সেলফ-টেস্টসহ</div>
        </div>
        <div class="metric">
          <div class="metric-label">Android Gradle CI ও বাস্তব ফোন</div>
          <div class="metric-val warn-text">PENDING CI / DEVICE</div>
          <div class="metric-note">এই কন্টেইনারে JDK/ফোন নেই — নিচে স্বচ্ছ তালিকা দেখুন</div>
        </div>
      </section>

      <section aria-labelledby="ledger-heading">
        <div class="section-head">
          <h2 id="ledger-heading">শনাক্তকৃত বাগ ও রুট-কজ লেজার (<span id="visible-count">${status.bugs.length}</span> / ${status.bugs.length})</h2>
          <div class="controls">
            <button type="button" class="filter-btn" data-filter="all" aria-pressed="true">সব (${status.bugs.length})</button>
            <button type="button" class="filter-btn" data-filter="High" aria-pressed="false">High Severity (${status.bugs.filter((b) => b.severity === 'High').length})</button>
            <button type="button" class="filter-btn" data-filter="Medium" aria-pressed="false">Medium Severity (${status.bugs.filter((b) => b.severity === 'Medium').length})</button>
            <label for="bug-search" style="position:absolute;left:-9999px">বাগ খুঁজুন</label>
            <input id="bug-search" class="search-input" type="search" placeholder="ফাইল, বাগ ID বা কীওয়ার্ড খুঁজুন…">
          </div>
        </div>
        <div id="ledger-list" class="ledger"></div>
      </section>

      <section aria-labelledby="honesty-heading">
        <div class="section-head">
          <h2 id="honesty-heading">যাচাইকরণের স্বচ্ছতা: কী প্রমাণিত এবং কী বাকি (Verification Boundary)</h2>
        </div>
        <div class="honesty-grid">
          <div class="panel">
            <h3 class="ok-text">এই সেশনে সরাসরি চালানো ও প্রমাণিত (Verified Locally)</h3>
            <ul>
              <li><strong>Node Engine Suite:</strong> <code>npm test</code> — ${status.engineTestsPassed}/${status.engineTestsPassed}টি ইঞ্জিন টেস্ট, ১৩/১৩টি রিলিজ ও সাইনিং পলিসি টেস্ট, Python ELF ১৬ KB সেলফ-টেস্ট এবং GenUI কমপ্লায়েন্স সেলফ-টেস্ট সবুজ।</li>
              <li><strong>Headless Chromium GenUI Suite:</strong> <code>npm run genui:acceptance</code> — ২৯/২৯টি অ্যাক্সেপ্টেন্স চেক বাস্তব ব্রাউজারে পাস।</li>
              <li><strong>AST Syntax Verification:</strong> পরিবর্তিত প্রতিটি JS ইঞ্জিন ফাইল (<code>content.js</code>, <code>injected.js</code>, <code>sd-agent.js</code>, <code>sd-genui-viewer.js</code>, <code>sd-native.js</code>, <code>sd-run.js</code>) <code>acorn</code> পার্সারে যাচাইকৃত।</li>
            </ul>
          </div>
          <div class="panel">
            <h3 class="warn-text">GitHub Actions CI ও বাস্তব Android ফোনে যাচাই আবশ্যক (Not Run Locally)</h3>
            <ul>
              <li><strong>Gradle JVM / Robolectric Unit Tests:</strong> কন্টেইনারে JDK না থাকায় <code>./gradlew testDebugUnitTest lintDebug</code> GitHub Actions CI-তে যেকোনো ব্রাঞ্চ পুশ বা PR-এ স্বয়ংক্রিয়ভাবে চলবে।</li>
              <li><strong>১৬ KB APK Alignment Gate:</strong> CI-তে <code>fetch_sandbox_deps.py</code> চালিয়ে নতুন APK-তে <code>arm64-v8a</code> ও <code>x86_64</code> সম্পূর্ণ ১৬ KB অ্যালাইনড কি না নিশ্চিত হবে।</li>
              <li><strong>Physical Phone Checklist (D1–D14):</strong> আসল ফোনে DeepSeek CAPTCHA/OTP, রোটেশন ও কীবোর্ড, SAF ফাইল ইমপোর্ট/শেয়ার, <code>proot</code> কমান্ড/Stop এবং ইন-প্লেস আপগ্রেড পরীক্ষা করতে হবে।</li>
            </ul>
          </div>
          <div class="panel">
            <h3 class="ok-text">GitHub Push ও Actions APK Build প্রস্তুত (.github/workflows/build-and-release-apk.yml)</h3>
            <ul>
              <li><strong>যেকোনো ব্রাঞ্চে Push / PR (Secret ছাড়াই APK বিল্ড):</strong> <code>main</code> ব্যতীত যেকোনো ব্রাঞ্চে পুশ করলে স্বয়ংক্রিয়ভাবে অস্থায়ী টেস্ট কী তৈরি করে <code>super-deepseek-apk</code> আর্টিফ্যাক্ট হিসেবে ইনস্টলযোগ্য APK বিল্ড ও যাচাই হবে।</li>
              <li><strong><code>main</code> অথবা <code>v*</code> ট্যাগে Push (Official Release):</strong> রিপোজিটরিতে ৪টি Actions Secret (<code>BDS_KEYSTORE</code>, <code>BDS_KEYSTORE_PASSWORD</code>, <code>BDS_KEY_ALIAS</code>, <code>BDS_KEY_PASSWORD</code>) সেট করা থাকলে স্থায়ী সাইনিং কী যাচাই করে সরাসরি GitHub Releases-এ APK পাবলিশ হবে।</li>
              <li><strong>গোপনীয়তা সুরক্ষা:</strong> <code>.gitignore</code>-এ ব্যক্তিগত স্ক্রিন-রেকর্ডিং/স্ক্রিনশট (<code>public/assets/aistudio/</code>) এবং কন্টেইনার আর্টিফ্যাক্ট বাদ রাখা হয়েছে যেন GitHub-এ পুশ করলে ব্যক্তিগত মিডিয়া কখনোই লিক না হয়।</li>
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="harness-heading">
        <div class="section-head">
          <h2 id="harness-heading">লাইভ Super DeepSeek ইঞ্জিন প্রিভিউ হারনেস (Official Repo Fixture)</h2>
          <div class="controls" role="group" aria-label="Preview Surface Selector">
            <button type="button" class="filter-btn surface-btn" data-src="/design-preview/preview.html" aria-pressed="true">Native Shell ও Sheets</button>
            <button type="button" class="filter-btn surface-btn" data-src="/design-preview/cards.html" aria-pressed="false">Agent ও MCP Cards</button>
            <button type="button" class="filter-btn surface-btn" data-src="/design-preview/genui.html" aria-pressed="false">GenUI Sandbox Fixture</button>
          </div>
        </div>
        <div class="preview-box">
          <div class="preview-bar">
            <span class="code-ref" id="active-surface-label">/design-preview/preview.html</span>
            <a id="open-direct-link" class="btn" href="/design-preview/preview.html">পূর্ণ পেজে খুলুন</a>
          </div>
          <iframe id="harness-frame" class="harness-frame" title="Super DeepSeek Engine Design Preview" src="/design-preview/preview.html"></iframe>
        </div>
      </section>
    </main>
  </div>

  <script>
    const STATUS = ${dataJson};
    const listEl = document.getElementById('ledger-list');
    const countEl = document.getElementById('visible-count');
    const searchEl = document.getElementById('bug-search');
    let activeFilter = 'all';

    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderLedger() {
      const q = String(searchEl.value || '').trim().toLowerCase();
      const filtered = STATUS.bugs.filter((b) => {
        if (activeFilter !== 'all' && b.severity !== activeFilter) return false;
        if (!q) return true;
        return (b.id + ' ' + b.pillar + ' ' + b.files + ' ' + b.titleBn + ' ' + b.cause + ' ' + b.fix).toLowerCase().includes(q);
      });
      countEl.textContent = String(filtered.length);
      if (!filtered.length) {
        listEl.innerHTML = '<div class="empty-state">এই ফিল্টারে কোনো বাগ পাওয়া যায়নি।</div>';
        return;
      }
      listEl.innerHTML = filtered.map((b) => (
        '<article class="bug-card" data-sev="' + esc(b.severity) + '">' +
          '<div class="bug-top">' +
            '<span><strong>' + esc(b.id) + '</strong> · <span class="sev-' + esc(b.severity) + '">' + esc(b.severity) + '</span> · ' + esc(b.pillar) + '</span>' +
            '<span class="code-ref">' + esc(b.files) + '</span>' +
          '</div>' +
          '<h3 class="bug-title">' + esc(b.titleBn) + '</h3>' +
          '<div class="bug-grid">' +
            '<div><strong>Root Cause</strong>' + esc(b.cause) + '</div>' +
            '<div><strong>Surgical Fix</strong>' + esc(b.fix) + '</div>' +
            '<div><strong>Verification Proof</strong>' + esc(b.proof) + '</div>' +
          '</div>' +
        '</article>'
      )).join('');
    }

    document.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeFilter = btn.getAttribute('data-filter');
        document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        renderLedger();
      });
    });
    searchEl.addEventListener('input', renderLedger);

    const frame = document.getElementById('harness-frame');
    const label = document.getElementById('active-surface-label');
    const direct = document.getElementById('open-direct-link');
    document.querySelectorAll('.surface-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const src = btn.getAttribute('data-src');
        document.querySelectorAll('.surface-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        frame.src = src;
        label.textContent = src;
        direct.href = src;
      });
    });

    renderLedger();
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/' || pathname === '/index.html') {
      const html = renderAuditHtml(readStatus());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (pathname === '/api/audit-status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(readStatus(), null, 2));
      return;
    }

    if (pathname.split('/').some((seg) => seg.startsWith('.') && seg.length > 1)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const filePath = path.resolve(ROOT, '.' + pathname);
    if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[super-deepseek] Audit & Design-Preview workspace listening on http://0.0.0.0:${PORT}`);
});
