/* Super DeepSeek — Generative UI prompt modules, user configuration and
 * output-compliance analysis. Pure: no DOM access, no network, no execution.
 *
 * The hidden prompt is wrapped in <SuperDeepSeek>…</SuperDeepSeek> so the
 * engine's existing user-bubble cleaner removes it from the visible message.
 * Model compliance is never assumed: analyze() measures what a response
 * actually contained, and the renderers keep raw text visible on failure.
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIPrompt && root.__sdGenUIPrompt.version === 3) return;

  var KEY = 'sd_genui_config_v1';
  var FREQUENCIES = ['auto', 'always', 'every_n', 'first', 'off'];
  var MODULE_NAMES = ['core', 'visual', 'schema', 'apps', 'svg', 'mcp'];
  var DEFAULTS = {
    version: 1,
    enabled: true,            // master kill switch: renderers + prompt
    inject: true,             // hidden prompt injection on/off
    frequency: 'auto',        // auto = only when the request benefits from visuals
    interval: 3,              // used by every_n
    fallbackRenderer: true,   // render complete raw ```html / ```svg blocks
    modules: { core: true, visual: true, schema: true, apps: true, svg: true, mcp: true },
    selectors: { message: '.ds-message', markdown: '.ds-markdown', composer: 'textarea' }
  };

  /* Intent detection. English + Bangla. Kept compatible with the previous
   * single regex in injected.js so behaviour does not regress. */
  var INTENT = {
    any: /(chart|graph|visuali[sz]|visual|illustrat|diagram|infographic|poster|\bui\b|interface|screen|website|web ?page|prototype|layout|calculator|calculate|estimate|compar|budget|projection|scenario|trend|statistic|dashboard|quiz|planner|schedule|design|mockup|wireframe|roadmap|itinerary|workflow|architecture|timeline|checklist|report|summary|data|ranking|lesson|recipe|fitness|nutrition|explain|how to|how does|why does|overview|breakdown|walkthrough|guide|pros and cons|advantages|benefits|difference|mind map|flowchart|framework|step-by-step|steps to|strategy|routine|study|presentation|pitch|proposal|features|portfolio|resume|\bcv\b|profile|menu|meal|travel|evaluation|matrix|review|curriculum|workout|exercise|game|app\b|widget|artifact|interactive|simulat|animation|svg|html|table|tracker|converter|form\b|ব্যাখ্যা|কীভাবে|কেন|ভিজুয়াল|দেখাও|ইনফোগ্রাফিক|ডায়াগ্রাম|পোস্টার|মকআপ|ইন্টারঅ্যাকটিভ|ইউআই|ইন্টারফেস|স্ক্রিন|নকশা|বানাও|তৈরি কর|আঁকো|প্রোটোটাইপ|ওয়্যারফ্রেম|চিত্র|মানচিত্র|প্রবাহচিত্র|সুবিধা|অসুবিধা|পার্থক্য|গাইড|শেখার|পড়াশোনা|রুটিন|ভ্রমণ|খাবার|ব্যায়াম|উপস্থাপনা|প্রস্তাব|বৈশিষ্ট্য|প্রোফাইল|জীবনবৃত্তান্ত|মেনু|তালিকা|চার্ট|গ্রাফ|হিসাব|ক্যালকুলেটর|তুলনা|বাজেট|পরিকল্পনা|পরিসংখ্যান|ডিজাইন|সময়রেখা|ধাপ|চেকলিস্ট|প্রতিবেদন|সারাংশ|গেম|অ্যাপ|সিমুলেশন|টেবিল|ট্র্যাকার)/i,
    schema: /(chart|graph|calculat|estimate|compar|budget|projection|scenario|trend|statistic|dashboard|kpi|table|ranking|matrix|timeline|steps|checklist|planner|schedule|roadmap|pros and cons|diagram|flowchart|architecture|report|summary|data|emi|loan|interest|চার্ট|গ্রাফ|হিসাব|ক্যালকুলেটর|তুলনা|বাজেট|পরিসংখ্যান|টেবিল|সময়রেখা|ধাপ|চেকলিস্ট|ডায়াগ্রাম|প্রতিবেদন|সারাংশ|পরিকল্পনা)/i,
    apps: /(game|app\b|application|interactive|simulat|animation|prototype|website|web ?page|landing|screen|\bui\b|interface|mockup|wireframe|widget|tool\b|tracker|converter|form\b|quiz|timer|clock|todo|to-do|canvas|html|গেম|অ্যাপ|ইন্টারঅ্যাকটিভ|সিমুলেশন|প্রোটোটাইপ|ওয়েবসাইট|স্ক্রিন|ইউআই|ইন্টারফেস|মকআপ|ওয়্যারফ্রেম|ট্র্যাকার|কুইজ|টাইমার)/i,
    svg: /(svg|illustrat|drawing|draw|poster|logo|icon|infographic|scene|artwork|vector|map\b|আঁকো|চিত্র|পোস্টার|লোগো|আইকন|ইনফোগ্রাফিক|মানচিত্র)/i,
    mcp: /(mcp|tool result|server|connector|integration|api result|weather|stock|search result|এমসিপি|সার্ভার|টুল)/i,
    edit: /(artifact|revision|edit (the|this|my)|update (the|this)|change (the|this)|fix (the|this)|আর্টিফ্যাক্ট|এডিট|পরিবর্তন কর|ঠিক কর)/i,
    file: /(?:\b(?:create|make|write|generate|produce|prepare|draft|save|export|download|build)\b[\s\S]{0,60}\b(?:(?:a|an|the|new|my|your)\s+)*(?:file|document|report|resume|cv|spreadsheet|workbook|csv spreadsheet|tsv spreadsheet|slide deck|slides|presentation|readme|changelog|config(?:uration)? file|manifest file|code file|source file|text file|python file|javascript file|typescript file|kotlin file|java file|shell file|bash file|powershell file|html file|css file|json file|yaml file|xml file|sql file|csv file|tsv file|graphql file|protobuf file|proto file|pdf|docx|xlsx|pptx|ipynb|dockerfile|makefile|env file)\b|(?:\b(?:save|export|download|create|make|write|generate|prepare|draft)\b[\s\S]{0,80}\b(?:as|to|named|called)\s*["']?[\w.-]+\.(?:txt|md|markdown|json|jsonl|json5|csv|tsv|yaml|yml|toml|ini|xml|html|htm|css|js|ts|jsx|tsx|py|java|kt|sh|sql|pdf|docx|xlsx|pptx|ipynb|graphql|gql|proto|protobuf|dockerfile|makefile|env|properties|conf|gradle|kts|ps1|diff|log)\b)|(?:তৈরি|বানাও|বানিয়ে|লিখে|সেভ|ডাউনলোড|এক্সপোর্ট)[\s\S]{0,70}(?:ফাইল|ডকুমেন্ট|নথি|রিপোর্ট|স্প্রেডশিট|ওয়ার্কবুক|স্লাইড|প্রেজেন্টেশন|স্ক্রিপ্ট ফাইল|কোড ফাইল|কনফিগ ফাইল|রিডমি|পিডিএফ|ওয়ার্ড|এক্সেল|গ্রাফকিউএল|প্রোটোবাফ)|(?:ফাইল|ডকুমেন্ট|নথি|রিপোর্ট|স্প্রেডশিট|ওয়ার্কবুক|স্লাইড|প্রেজেন্টেশন|স্ক্রিপ্ট ফাইল|কোড ফাইল|কনফিগ ফাইল|রিডমি|পিডিএফ|ওয়ার্ড|এক্সেল|গ্রাফকিউএল|প্রোটোবাফ)[\s\S]{0,70}(?:তৈরি|বানাও|বানিয়ে|লিখে|সেভ|ডাউনলোড|এক্সপোর্ট))/i,
  };

  var MODULES = {
    core: [
      '## Generative UI (Super DeepSeek host, protocol v2)',
      'This chat renders typed fenced code blocks as live UI inside your answer. Pick the lightest form that helps; most answers stay prose.',
      'Decide per request:',
      '- Facts, short answers, opinions → prose only (markdown tables/lists are fine).',
      '- Explain a concept, process, structure, comparison, trend, or let the user explore numbers → an inline visual: ```sds-visual (HTML/SVG drawn into the answer, like a figure). Put 1–3 sentences of prose before it and the explanation after it.',
      '- Simple calculator/dashboard/table/timeline from fixed components → ```sds-ui (validated JSON widget).',
      '- A standalone deliverable the user will keep, reuse, edit or download (app, game, website, document, long code file, diagram, poster) → an artifact: ```sds-genui with headers. It appears as a card the user opens in a side viewer.',
      '- If the user explicitly asks to create, write, save, export or download a file, ALWAYS return it as a ```sds-genui artifact—even plain text, source code, configuration, JSON, CSV or other data. Use the requested filename in the title when possible. Never replace an explicitly requested file with prose or only an inline visual.',
      'The old <SDS:VISUALIZER> tag is deprecated in this app: use ```sds-visual instead (it streams, matches the chat theme and resizes itself). Do not wrap visuals in any other tag.',
      'Rules: close every fence; never put secrets, API keys, tokens or personal data in blocks; never invent factual numbers — label illustrative values as examples; do not claim you ran or tested anything you did not.'
    ].join('\n'),
    visual: [
      '## ```sds-visual — inline visuals (render as part of the answer)',
      'Body: optional first line `title: Short title`, then an HTML fragment (no <html>/<head>/<body>) or one <svg>. Order: <style> first (short), then markup, then <script> last — the block streams while you write and scripts run when it is complete.',
      'The host provides: transparent background, the chat font, light/dark CSS variables (--color-text-primary/secondary/tertiary, --color-background-primary/secondary/tertiary, --color-border-tertiary, --color-text-info/success/warning/danger, --accent, --border-radius-md/lg), pre-styled button, input, select, range sliders, table, and helper classes .card .grid .row .metric .label .muted. SVG classes: text.t (14px), text.ts (12px secondary), text.th (14px medium), .box>rect (neutral box), .arr (arrow line), and colour ramps c-blue c-teal c-purple c-coral c-pink c-green c-amber c-red c-gray on <g> or shapes (fill + stroke + text colour adapt to the theme).',
      'Design (follow strictly): flat, no outer card or border around the whole visual, no page background, no drop shadows or gradients, generous whitespace. Font weights 400 and 500 only; sentence case; at most 2–3 colours with meaning. Text 14–16px, labels 12px. SVG: most readers are on a phone, so use viewBox="0 0 400 H" with width="100%" (flows run top-to-bottom, at most 3 boxes per row, labels ≤ 18 characters per line), text never overlaps shapes, arrows end at box edges, ≤ 12 nodes. Charts: use Chart.js from https://cdn.jsdelivr.net/npm/chart.js (or plain SVG) with maintainAspectRatio:false inside a div of fixed height. Interactive controls must change something visible; show live numbers with tabular figures.',
      'Interaction: call sendPrompt("question") from a button to ask a follow-up in the chat; links use openLink(url). Live web data: `await fetch("https://public-api.example/...")` (or sdFetch) works for public http(s) APIs and pages — the user approves each website once, no cookies are sent, private/local addresses are refused; show a loading state and a friendly error state, and only fetch when live data is the point. Images from any public site: <img src> works (the host proxies it) or `img.src = await sdImage(url)`. No localStorage reliance, no alert(). Allowed CDNs: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh. Keep under 25 KB.'
    ].join('\n'),
    apps: [
      '## ```sds-genui — artifacts (cards that open in a viewer with Preview | Code)',
      'Format: header lines, a line `---`, then the body:',
      '```sds-genui',
      'id: stable-kebab-id',
      'kind: html-app | react | document | code | mermaid | svg',
      'title: Short human title',
      'language: python   (only for kind code)',
      '---',
      '<body>',
      '```',
      'Bodies: html-app = complete single-file HTML document for a runnable/interactive app (inline <style>/<script>; CDN libraries allowed from cdnjs/jsdelivr/unpkg/esm.sh); react = one JSX file with `export default function App()`; document = Markdown; code = a downloadable source/data/config file; mermaid = Mermaid diagram source; svg = one complete <svg> with viewBox.',
      'File-first contract: every file request uses a ```sds-genui artifact. Use the exact requested filename, including extension, as `title`; use `kind: code` with `language: csv|tsv|json|jsonl|json5|yaml|toml|ini|xml|sql|python|javascript|typescript|kotlin|java|html|css|jsx|tsx|ipynb|env|dockerfile|makefile` for downloadable text/source/data files, `kind: document` for Markdown, `kind: html-app` only for a runnable app, and `kind: svg` or `kind: mermaid` for a diagram the user wants to keep. Do not claim true binary PDF, DOCX, XLSX, or PPTX files were created; where binary export is unavailable, provide a clearly labelled print-ready HTML/Markdown or CSV source artifact and state its actual format.',
      'Updating: to change an artifact, reuse the same id and return the complete new version (never a diff); the viewer keeps every version. One artifact per message unless asked for more. Keep prose outside the block short.',
      'App design: mobile-first (360px+), clear hierarchy and one primary action, system-ui type scale 14/16/20/28, 8px spacing grid, one accent colour, WCAG AA contrast, 44px touch targets, labelled controls, empty/error states, light + dark via prefers-color-scheme, honour prefers-reduced-motion. Games need touch controls, score and restart. Under 120 KB.'
    ].join('\n'),
    schema: [
      '## ```sds-ui component spec (inline widgets)',
      'Body: valid JSON {"version":1,"layout":"grid|stack|dashboard","accent":"violet|teal|amber|rose|blue|lime","title":"…","description":"…","components":[…]}. Double-quoted strings, no comments, no trailing commas.',
      'Compose 3–7 purposeful components with a clear hierarchy. stack = narrative, grid = related items, dashboard = KPIs. Component span: full|half.',
      'Types: hero {eyebrow,title,subtitle,value,formula,format,currency,footnote,badge,icon,accent}; text {text,tone}; stat {label,value,formula,format,currency,caption}; badge {label,tone}; progress {label,value,formula,max,format}; slider {id,label,min,max,step,value,format,currency}; select {id,label,options,value}; toggle {id,label,value}; chart {kind:bar|line|pie|donut,title,description,data:[{label,value|formula}]}; table {columns,rows}; callout {tone,title,text,icon}; list {title,items}; steps {title,items:[{title,text,status:done|active|upcoming}]}; comparison {title,items:[2–3 {title,description,price,period,badge,features,highlighted}]}; timeline {title,events:[{date,title,text,tone}]}; diagram {title,description,nodes:[{id,title,text,kind,column 0–3,row 0–2}],edges:[{from,to,label}]}; quote {text,attribution,role}; icon {name,label,size,tone}; divider {label}; button {label,action:"copy",value}.',
      'Formats: number|integer|percent|currency. Formulas are arithmetic only over control ids: + - * / % ^ ( ) min max pow sqrt abs round floor ceil. Use {{controlId}} in text for live values. Every control must affect a formula, text or chart. Limits: 40 components, 24 chart points, 20 table rows, 12 list items, 12 diagram nodes, 20 edges.'
    ].join('\n'),
    svg: [
      '## SVG',
      'Illustrations and diagrams that belong in the explanation go in ```sds-visual as one <svg viewBox="0 0 400 H" width="100%">. Posters, logos and icons the user wants to keep are an artifact (kind: svg). No scripts, no event handlers, no external images or fonts. Under 60 KB.'
    ].join('\n'),
    mcp: [
      '## MCP results',
      'Apps that a configured MCP tool provides (tools with a UI) render automatically under the tool call — do not re-describe the whole UI. To present plain structured tool data, use ```sds-genui with `kind: tool-result`, header `name:` (tool name), optional `view: table|chart|cards|json`, body = the JSON result as returned (redact secrets). To show a configured server\'s app explicitly use `kind: mcp-app` with headers `server:` (the configured server URL) and `resource:` (ui:// URI) and no body.'
    ].join('\n')
  };

  /* ---------- configuration ---------- */
  function storageGet(key) {
    try {
      if (root.AndroidBridge && typeof root.AndroidBridge.getStorage === 'function') return root.AndroidBridge.getStorage(key);
      if (root.localStorage) return root.localStorage.getItem(key);
    } catch (_) {}
    return null;
  }
  function storageSet(key, value) {
    try {
      if (root.AndroidBridge && typeof root.AndroidBridge.setStorage === 'function') { root.AndroidBridge.setStorage(key, value); return true; }
      if (root.localStorage) { root.localStorage.setItem(key, value); return true; }
    } catch (_) {}
    return false;
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function cleanSelector(value, fallback) {
    if (typeof value !== 'string') return fallback;
    var s = value.trim();
    // Selectors only: no braces/at-rules/script-like content, bounded length.
    if (!s || s.length > 160 || /[{}<>;@\\]/.test(s)) return fallback;
    return s;
  }
  function normalize(input) {
    var cfg = clone(DEFAULTS);
    if (!input || typeof input !== 'object') return cfg;
    ['enabled', 'inject', 'fallbackRenderer'].forEach(function (k) { if (typeof input[k] === 'boolean') cfg[k] = input[k]; });
    if (FREQUENCIES.indexOf(input.frequency) >= 0) cfg.frequency = input.frequency;
    var n = Number(input.interval);
    if (Number.isFinite(n)) cfg.interval = Math.min(20, Math.max(2, Math.round(n)));
    if (input.modules && typeof input.modules === 'object') {
      MODULE_NAMES.forEach(function (m) { if (typeof input.modules[m] === 'boolean') cfg.modules[m] = input.modules[m]; });
    }
    cfg.modules.core = true; // the protocol contract is never optional when injecting
    if (input.selectors && typeof input.selectors === 'object') {
      Object.keys(DEFAULTS.selectors).forEach(function (k) { cfg.selectors[k] = cleanSelector(input.selectors[k], DEFAULTS.selectors[k]); });
    }
    return cfg;
  }
  var cached = null;
  function getConfig() {
    if (cached) return clone(cached);
    var parsed = null;
    try { var raw = storageGet(KEY); if (raw && raw.length < 20000) parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    cached = normalize(parsed);
    return clone(cached);
  }
  function setConfig(patch) {
    var current = getConfig();
    var next = normalize(Object.assign({}, current, patch || {}, {
      modules: Object.assign({}, current.modules, (patch && patch.modules) || {}),
      selectors: Object.assign({}, current.selectors, (patch && patch.selectors) || {})
    }));
    cached = next;
    storageSet(KEY, JSON.stringify(next));
    try { if (root.dispatchEvent && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('sd-genui:config', { detail: clone(next) })); } catch (_) {}
    return clone(next);
  }
  function resetConfig() { cached = null; storageSet(KEY, JSON.stringify(DEFAULTS)); return getConfig(); }

  /* ---------- injection decision ---------- */
  var turnCounts = Object.create(null);
  function selectModules(text, cfg, ctx) {
    var s = String(text || '');
    var picked = ['core'];
    var hasMcp = !!(ctx && ctx.mcpConfigured);
    if (cfg.modules.visual && INTENT.any.test(s)) picked.push('visual');
    if (cfg.modules.schema && INTENT.schema.test(s)) picked.push('schema');
    if (cfg.modules.apps && (INTENT.apps.test(s) || INTENT.file.test(s))) picked.push('apps');
    if (cfg.modules.svg && INTENT.svg.test(s)) picked.push('svg');
    if (cfg.modules.mcp && (hasMcp || INTENT.mcp.test(s))) picked.push('mcp');
    // A visual request with no specific module still benefits from the schema renderer.
    if (picked.length === 1 && cfg.modules.visual) picked.push('visual');
    return picked;
  }
  function shouldInject(text, ctx, cfg) {
    cfg = cfg || getConfig();
    if (!cfg.enabled || !cfg.inject || cfg.frequency === 'off') return false;
    var chat = (ctx && ctx.chat) || 'default';
    var count = (turnCounts[chat] = (turnCounts[chat] || 0) + 1);
    var s = String(text || '');
    switch (cfg.frequency) {
      case 'always': return true;
      case 'first': return !!(ctx && ctx.isFirst) || count === 1;
      case 'every_n': return count === 1 || (count - 1) % cfg.interval === 0 || INTENT.edit.test(s) || INTENT.file.test(s);
      default: return INTENT.any.test(s) || INTENT.file.test(s) || INTENT.edit.test(s);
    }
  }
  /** Returns the hidden prompt for this turn or '' when nothing should be injected. */
  function build(text, ctx) {
    var cfg = getConfig();
    if (!shouldInject(text, ctx, cfg)) return '';
    var parts = selectModules(text, cfg, ctx).map(function (m) { return MODULES[m]; });
    return '<SuperDeepSeek>\n' + parts.join('\n\n') + '\n</SuperDeepSeek>';
  }

  /* ---------- compliance analysis (used by tests and scripts/genui-compliance.mjs) ---------- */
  var FENCE_RE = /^```([A-Za-z0-9_+.-]*)[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*(?:\r?\n|$)/gm;
  var OPEN_RE = /^```([A-Za-z0-9_+.-]*)[^\S\r\n]*\r?\n/gm;
  function analyze(text, deps) {
    var src = String(text || '');
    var P = (deps && deps.protocol) || root.__sdGenUIProtocol;
    var G = (deps && deps.genui) || root.__sdGenUI;
    var S = (deps && deps.svg) || root.__sdGenUISvg;
    var blocks = [], m;
    FENCE_RE.lastIndex = 0;
    var closedCount = 0;
    while ((m = FENCE_RE.exec(src))) {
      closedCount++;
      var lang = m[1].toLowerCase(), body = m[2], entry = { lang: lang, ok: null, typed: false, error: '' };
      if (lang === 'sds-genui' || lang === 'sds-artifact') {
        entry.typed = true;
        var r = P && P.parseBlock ? P.parseBlock(body) : (P ? P.validate(body) : { ok: false, error: 'protocol unavailable' });
        entry.ok = !!r.ok; entry.error = r.ok ? '' : r.error; entry.kind = r.ok ? r.block.kind : '';
        entry.format = /^\s*\{/.test(body) ? 'json' : 'headers';
      } else if (lang === 'sds-visual') {
        entry.typed = true;
        var vb = body.replace(/^\s*title\s*:[^\n]*\n(?:\s*---\s*\n)?/i, '').trim();
        entry.ok = vb.length > 0 && /<[a-z]/i.test(vb) && !/<script\b(?![\s\S]*<\/script>)/i.test(vb);
        entry.error = entry.ok ? '' : 'empty or unclosed visual'; entry.kind = 'visual';
      } else if (lang === 'sds-ui') {
        entry.typed = true;
        var u = G && G.parseSpec ? G.parseSpec(body) : { ok: false, error: 'renderer unavailable' };
        entry.ok = !!u.ok; entry.error = u.ok ? '' : u.error; entry.kind = 'ui';
      } else if (lang === 'sds-svg' || lang === 'svg') {
        entry.typed = lang === 'sds-svg';
        var sv = S ? S.parse(body.trim(), 'cmp-') : { ok: /<svg[\s>][\s\S]*<\/svg>\s*$/i.test(body.trim()), error: 'svg sanitizer unavailable' };
        entry.ok = !!sv.ok; entry.error = sv.ok ? '' : sv.error; entry.kind = 'svg';
      } else if (lang === 'sds-html' || lang === 'html') {
        entry.typed = lang === 'sds-html';
        entry.ok = /<\/(html|body|main|div|section|canvas|svg)>\s*$/i.test(body.trim()) || /<\/html>/i.test(body);
        entry.error = entry.ok ? '' : 'incomplete HTML document'; entry.kind = 'html-app';
      } else {
        continue;
      }
      blocks.push(entry);
    }
    OPEN_RE.lastIndex = 0;
    var opens = 0; while (OPEN_RE.exec(src)) opens++;
    var typed = blocks.filter(function (b) { return b.typed; });
    var raw = blocks.filter(function (b) { return !b.typed; });
    return {
      blocks: blocks,
      visual: blocks.length,
      typed: typed.length,
      typedValid: typed.filter(function (b) { return b.ok; }).length,
      rawFallback: raw.length,
      rawRenderable: raw.filter(function (b) { return b.ok; }).length,
      // Opening fences that never closed (truncated output) — a key failure mode.
      unclosed: Math.max(0, opens - 2 * closedCount) > 0 ? 1 : 0,
      compliant: typed.length > 0 && typed.every(function (b) { return b.ok; })
    };
  }

  root.__sdGenUIPrompt = {
    version: 3,
    KEY: KEY,
    defaults: clone(DEFAULTS),
    frequencies: FREQUENCIES.slice(),
    moduleNames: MODULE_NAMES.slice(),
    modules: MODULES,
    intent: INTENT,
    getConfig: getConfig,
    setConfig: setConfig,
    resetConfig: resetConfig,
    normalize: normalize,
    selectModules: selectModules,
    shouldInject: shouldInject,
    build: build,
    analyze: analyze,
    _resetTurns: function () { turnCounts = Object.create(null); cached = null; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
