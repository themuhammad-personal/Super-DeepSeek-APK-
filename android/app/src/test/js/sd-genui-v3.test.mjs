// Unit tests for the Generative UI v3 modules (live frames, inline visuals,
// artifact store/viewer, MCP Apps host). DOM-free via node:vm; real browser
// behaviour is covered by scripts/genui-browser-check.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bds = path.join(here, '../../main/bds-assets/bds');
const read = (f) => fs.readFileSync(path.join(bds, f), 'utf8');

function load(files, extra = {}) {
  const store = new Map();
  const timers = [];
  const window = {
    navigator: { language: 'en' },
    location: { pathname: '/a/chat/s/abcd1234' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 2 ** 32) >>> 0; return a; } },
    ...extra
  };
  window.window = window;
  const document = { body: null, documentElement: { lang: 'en', getAttribute: () => null, classList: { contains: () => false } }, querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} };
  window.document = document;
  const fakeTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const ctx = vm.createContext({
    window, globalThis: window, document, console, setTimeout, clearTimeout,
    setInterval: fakeTimer, clearInterval: () => {}, TextEncoder, btoa, atob, URL, WeakMap, Uint32Array, Math, JSON, Date
  });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return { window, store, timers };
}

test('frame: CSP for generated surfaces denies frames/objects/forms and limits hosts to the library CDNs', () => {
  const { window } = load(['sd-genui-frame.js']);
  const F = window.__sdGenUIFrame;
  const doc = F.buildDocument({ kind: 'visual', source: '<p>hi</p>', theme: 'dark', channel: 'c1' });
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/i.exec(doc);
  assert.ok(csp, 'meta CSP present');
  for (const d of ["default-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(csp[1].includes(d), d);
  assert.ok(!/connect-src[^;]*\*/.test(csp[1]), 'no wildcard connect');
  assert.ok(csp[1].includes('https://cdn.jsdelivr.net'), 'chart libraries load');
  assert.match(doc, /<html data-theme="dark">/);
  assert.match(doc, /<div id="sds-root"><p>hi<\/p><\/div>/);
  assert.equal(F.sandbox.includes('allow-same-origin'), false, 'opaque origin');
  assert.equal(F.sandbox.includes('allow-top-navigation'), false);
  assert.equal(F.sandbox.includes('allow-popups'), false);
});

test('frame: complete documents keep their markup; <base> is stripped and the host head is injected', () => {
  const { window } = load(['sd-genui-frame.js']);
  const F = window.__sdGenUIFrame;
  const src = '<!doctype html><html lang="en"><head><base href="https://evil.example/"><title>T</title></head><body><main id="m">x</main></body></html>';
  assert.equal(F.isFullDocument(src), true);
  assert.equal(F.isFullDocument('<div>frag</div>'), false);
  const out = F.buildDocument({ kind: 'html', source: src, theme: 'light' });
  assert.doesNotMatch(out, /<base/i);
  assert.match(out, /<main id="m">x<\/main>/);
  assert.match(out, /<head[^>]*><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/i, 'CSP is the first thing in <head>');
  assert.match(out, /<html data-theme="light" lang="en">/);
});

test('frame: MCP CSP only allows declared, clean https origins (spec default when omitted)', () => {
  const { window } = load(['sd-genui-frame.js']);
  const F = window.__sdGenUIFrame;
  assert.deepEqual(Array.from(F.cleanDomains(['https://api.example.com', 'http://insecure.example', 'https://*.wild.example', 'https://10.0.0.1', 'https://localhost', 'https://x.local', 'https://user:pw@a.example', 'https://ok.example/path', 'https://API.example.com/'])), ['https://api.example.com']);
  const none = F.buildDocument({ kind: 'mcp', source: '<p>app</p>', csp: {} });
  assert.match(none, /connect-src 'none'/);
  assert.doesNotMatch(none, /cdn\.jsdelivr/);
  const some = F.buildDocument({ kind: 'mcp', source: '<p>app</p>', csp: { connectDomains: ['https://api.example.com', 'http://bad.example'], resourceDomains: ['https://cdn.example.com'] } });
  assert.match(some, /connect-src https:\/\/api\.example\.com;/);
  assert.match(some, /script-src 'unsafe-inline' https:\/\/cdn\.example\.com;/);
  assert.doesNotMatch(some, /bad\.example/);
});

test('frame: model text cannot break out of the srcdoc scripts (react/mermaid sources are escaped)', () => {
  const { window } = load(['sd-genui-frame.js']);
  const F = window.__sdGenUIFrame;
  const evil = 'export default function App(){return <div>{"</script><script>parent.x=1</script>"}</div>}';
  const r = F.buildDocument({ kind: 'react', source: evil });
  assert.equal(r.includes('</script><script>parent.x=1'), false, 'closing tag escaped inside JSON');
  const m = F.buildDocument({ kind: 'mermaid', source: 'graph TD\nA["</pre><script>x()</script>"]-->B' });
  assert.equal(m.includes('<script>x()</script>'), false, 'mermaid source is HTML-escaped');
  assert.match(m, /securityLevel:"strict"/);
});

test('inline: parseVisual reads the optional title header and falls back to headings', () => {
  const { window } = load(['sd-genui-frame.js', 'sd-genui-inline.js']);
  const P = window.__sdGenUIInline.parseVisual;
  assert.deepEqual(JSON.parse(JSON.stringify(P('title: How DNS works\n<svg viewBox="0 0 400 200"></svg>'))), { title: 'How DNS works', body: '<svg viewBox="0 0 400 200"></svg>' });
  assert.equal(P('id: a\ntitle: Loan\n---\n<div>x</div>').title, 'Loan');
  assert.equal(P('id: a\ntitle: Loan\n---\n<div>x</div>').body, '<div>x</div>');
  assert.equal(P('<h2>Compound interest</h2><div></div>').title, 'Compound interest');
  assert.equal(P('<div></div>').title, 'Visual');
});

test('artifact normalization honors explicit inline presentation in JSON envelopes and header boundaries', () => {
  const { window } = load(['sd-genui-protocol.js', 'sd-artifacts.js']);
  const A = window.__sdArtifacts;
  const svg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  const inline = A.normalize('sds-genui', JSON.stringify({ version: 1, id: 'inline-svg', kind: 'svg', title: 'Inline chart', presentation: 'inline', payload: { svg } }), true);
  assert.equal(inline.ok, true);
  assert.equal(inline.inline, true, 'JSON envelope presentation is honored');
  const card = A.normalize('sds-genui', JSON.stringify({ version: 1, id: 'card-svg', kind: 'svg', title: 'Card chart', payload: { svg } }), true);
  assert.equal(card.inline, false, 'omitting presentation keeps the default artifact card');
  const header = A.normalize('sds-genui', 'id: header-svg\nkind: svg\ntitle: Header SVG\npresentation: inline\n---\n' + svg, true);
  assert.equal(header.inline, true, 'header format keeps inline presentation');
  const leadingBlankHeader = A.normalize('sds-genui', '\n\nid: leading-blank\nkind: svg\ntitle: Leading Blank\npresentation: "inline"\n---\n' + svg, true);
  assert.equal(leadingBlankHeader.inline, true, 'leading blank lines and quoted inline values follow protocol header parsing');
  const bodyMention = A.normalize('sds-genui', 'id: body-note\nkind: document\ntitle: Notes\n\nThe phrase presentation: inline is ordinary document text.', true);
  assert.equal(bodyMention.inline, false, 'body text must not be interpreted as a header');
});

test('viewer store: versions per chat + id, identical content deduplicated, persisted and bounded', async () => {
  const { window, store } = load(['sd-genui-frame.js', 'sd-genui-viewer.js']);
  const S = window.__sdGenUIViewer.store;
  const a = S.upsert('loan-calc', { kind: 'html-app', title: 'Loan', payload: { source: '<p>1</p>' } });
  assert.equal(a.record.key, 'abcd1234:loan-calc');
  assert.equal(a.index, 0);
  assert.equal(S.upsert('loan-calc', { kind: 'html-app', title: 'Loan', payload: { source: '<p>1</p>' } }).index, 0, 'same content = same version');
  const b = S.upsert('loan-calc', { kind: 'html-app', title: 'Loan v2', payload: { source: '<p>2</p>' } });
  assert.equal(b.index, 1);
  assert.equal(b.record.title, 'Loan v2');
  for (let i = 0; i < 20; i++) S.upsert('loan-calc', { kind: 'html-app', title: 'L', payload: { source: '<p>v' + i + '</p>' } });
  assert.equal(S.get('abcd1234:loan-calc').versions.length, 12, 'version history bounded');
  await new Promise((r) => setTimeout(r, 650));
  const saved = JSON.parse(store.get('sd_genui_artifacts_v2'));
  assert.equal(saved.version, 2);
  assert.equal(saved.items[0].key, 'abcd1234:loan-calc');
  S._reset();
  assert.equal(S.list().length, 1, 'reloads from storage');
  S.remove('abcd1234:loan-calc');
  assert.equal(S.list().length, 0);
});

test('viewer: describe/sourceOf/frameKind cover every artifact kind', () => {
  const { window } = load(['sd-genui-frame.js', 'sd-genui-viewer.js']);
  const V = window.__sdGenUIViewer;
  assert.equal(V.frameKind('html-app'), 'html');
  assert.equal(V.frameKind('react'), 'react');
  assert.equal(V.frameKind('mermaid'), 'mermaid');
  assert.equal(V.frameKind('svg'), 'svg');
  assert.equal(V.sourceOf({ kind: 'html-app', payload: { source: '<!doctype html><p>x</p>' } }), '<!doctype html><p>x</p>');
  assert.match(V.sourceOf({ kind: 'html-app', payload: { html: '<p>x</p>', css: 'p{}', js: 'go()' } }), /<style>\s*p\{\}\s*<\/style>[\s\S]*<p>x<\/p>[\s\S]*go\(\)/);
  assert.equal(V.sourceOf({ kind: 'svg', payload: { svg: '<svg/>' } }), '<svg/>');
  assert.equal(V.sourceOf({ kind: 'react', payload: { source: 'export default 1' } }), 'export default 1');
  for (const [language, ext] of [['csv', 'csv'], ['tsv', 'tsv'], ['jsonl', 'jsonl'], ['toml', 'toml'], ['graphql', 'graphql'], ['ipynb', 'ipynb'], ['dockerfile', 'dockerfile'], ['makefile', 'makefile']]) assert.equal(V.describe('code', { language }).ext, ext, language);
  assert.equal(V.fileName('report.csv', 'csv'), 'report.csv');
  assert.equal(V.fileName('README.md', 'md'), 'README.md');
  assert.equal(V.fileName('notes.markdown', 'md'), 'notes.markdown');
  assert.equal(V.fileName('my.data.csv', 'csv'), 'my.data.csv');
  assert.equal(V.fileName('MY.DATA.CSV', 'csv'), 'MY.DATA.CSV');
  assert.equal(V.fileName('Quarterly Report', 'csv'), 'Quarterly Report.csv');
  assert.equal(V.fileName('config.pdf', 'md'), 'config.md');
  assert.equal(V.fileName('Node.js', 'js'), 'Node.js');
  assert.equal(V.fileName('../report.csv', 'csv'), 'report.csv');
  assert.equal(V.fileName('Dockerfile', 'dockerfile'), 'Dockerfile');
  assert.equal(V.fileName('.env', 'env'), '.env');
});

test('protocol: common data/config labels normalize to non-executable code artifacts', () => {
  const { window } = load(['sd-genui-protocol.js']), P = window.__sdGenUIProtocol;
  for (const language of ['csv','tsv','jsonl','json5','ini','env','dotenv','properties','conf','config','graphql','gql','proto','protobuf','dockerfile','makefile','ipynb','txt','log','diff','ps1','powershell']) {
    const r = P.parseBlock('id: output-file\nkind: ' + language + '\ntitle: output.' + language + '\n---\nvalue = 1');
    assert.equal(r.ok, true, language + ': ' + r.error);
    assert.equal(r.block.kind, 'code', language);
    assert.equal(r.block.payload.language, language);
  }
});

test('prompt: explicit file requests select artifact guidance in auto mode (English + Bengali)', () => {
  const { window } = load(['sd-genui-prompt.js']), P = window.__sdGenUIPrompt;
  P.resetConfig();
  for (const request of ['Create a file named config.yaml','Generate a CSV spreadsheet with example rows','Write a Python script and save it as cleanup.py','একটি README.md ফাইল তৈরি করো']) {
    P._resetTurns();
    assert.equal(P.shouldInject(request, {}, P.getConfig()), true, request);
    const prompt = P.build(request);
    assert.match(prompt, /sds-genui — artifacts/);
    assert.match(prompt, /File-first contract/);
    assert.ok(P.selectModules(request, P.getConfig(), {}).includes('apps'));
  }
  for (const request of ['Save the query as schema.graphql', 'Export this schema as service.proto']) {
    P._resetTurns();
    assert.equal(P.shouldInject(request, {}, P.getConfig()), true, request + ' should recognize a filename-based request');
  }
  P._resetTurns();
  const nodePrompt = P.build('How does Node.js work?', { chat: 'node' });
  assert.doesNotMatch(nodePrompt, /sds-genui — artifacts/, 'a framework-name mention must not select the artifact module');
  assert.equal(P.selectModules('How does Node.js work?', P.getConfig(), {}).includes('apps'), false);
  for (const request of ['Make this text more formal', 'write a python function', 'কোড লিখে দাও']) {
    P._resetTurns();
    assert.equal(P.shouldInject(request, {}, P.getConfig()), false, request + ' must not force artifact guidance');
  }
  P.setConfig({ frequency: 'every_n', interval: 4 }); P._resetTurns();
  P.build('hi', { chat: 'every' });
  assert.equal(P.build('Please save the query as schema.graphql', { chat: 'every' }).includes('File-first contract'), true);
  P.resetConfig();
});

test('mcp: uiOf follows the 2026-01-26 MCP Apps spec (nested + deprecated flat key, ui:// only)', () => {
  const { window } = load(['sd-genui-host.js', 'sd-genui-frame.js', 'sd-genui-mcp.js']);
  const M = window.__sdGenUIMcp;
  assert.equal(M.MIME, 'text/html;profile=mcp-app');
  assert.deepEqual(JSON.parse(JSON.stringify(M.uiOf({ _meta: { ui: { resourceUri: 'ui://w/app.html', visibility: ['app'] } } }))), { resourceUri: 'ui://w/app.html', visibility: ['app'], openai: false });
  // OpenAI Apps SDK template key; app-only tools hidden + auto-allowed; destructive app-only still asks.
  assert.equal(M.uiOf({ _meta: { 'openai/outputTemplate': 'ui://pizza/list.html' } }).openai, true);
  assert.equal(M.appOnly({ _meta: { ui: { visibility: ['app'] } } }), true);
  assert.equal(M.appOnly({ _meta: { ui: { visibility: ['model', 'app'] } } }), false);
  assert.equal(M.autoAllowed({ _meta: { ui: { visibility: ['app'] } } }), true);
  assert.equal(M.autoAllowed({ _meta: { ui: { visibility: ['app'] } }, annotations: { destructiveHint: true } }), false);
  assert.equal(M.autoAllowed({ annotations: { readOnlyHint: true } }), true);
  assert.equal(M.autoAllowed({ name: 'send_email' }), false);
  assert.equal(M.uiOf({ _meta: { 'ui/resourceUri': 'ui://w/old.html' } }).resourceUri, 'ui://w/old.html');
  assert.equal(M.uiOf({ _meta: { ui: { resourceUri: 'https://evil.example/app.html' } } }), null);
  assert.equal(M.uiOf({ name: 'plain' }), null);
  M.remember('https://mcp.example.com/mcp', [{ name: 'get_weather', _meta: { ui: { resourceUri: 'ui://w/app.html' } } }, { bogus: 1 }]);
  assert.equal(M.known('https://mcp.example.com/mcp'), true);
  assert.equal(M.toolFor('https://mcp.example.com/mcp', 'get_weather').name, 'get_weather');
  assert.equal(M.toolFor('https://mcp.example.com/mcp', 'nope'), null);
});

test('v3 modules are registered natively in dependency order and loaded by both fixtures', () => {
  const main = fs.readFileSync(path.join(here, '../../main/java/com/superdeepseek/app/MainActivity.kt'), 'utf8');
  const order = ['sd-genui-host.js', 'sd-genui-frame.js', 'sd-genui.js', 'sd-genui-viewer.js', 'sd-genui-inline.js', 'sd-artifacts.js', 'sd-genui-mcp.js', 'sd-genui-panel.js'];
  let last = -1;
  for (const f of order) { const i = main.indexOf('"' + f + '"'); assert.ok(i > last, f + ' after previous'); last = i; }
  for (const fx of ['design-preview/genui.html', 'design-preview/genui-csp.html']) {
    const html = fs.readFileSync(path.join(here, '../../../../../', fx), 'utf8');
    for (const f of ['sd-genui-frame.js', 'sd-genui-viewer.js', 'sd-genui-inline.js', 'sd-genui-mcp.js']) assert.ok(html.includes(f), fx + ' loads ' + f);
  }
});

test('frame: loop guard rewrites while/do-while/for conditions, keeps code valid, skips strings, comments, regex, for-in/of', () => {
  const { window } = load(['sd-genui-host.js', 'sd-genui-frame.js']);
  const F = window.__sdGenUIFrame, P = F.protectLoops;
  assert.equal(P('while(true){}'), 'while(__sdLoop(1)&&(true)){}');
  assert.equal(P('do{x++}while(x<5);'), 'do{x++}while(__sdLoop(1)&&(x<5));');
  assert.equal(P('for(let i=0;i<9;i++){}'), 'for(let i=0;__sdLoop(1)&&(i<9);i++){}');
  assert.equal(P('for(;;){}'), 'for(;__sdLoop(1);){}');
  for (const same of ['for(const k in o){}', 'for (const v of a) {}', 'a.for(1); o.while = 2;', 'var s="while(1)", r=/for(;;)/g, t=`while(${x})`;', '// while(1)\n/* for(;;) */ x=1', 'async function f(){ for await (const x of y){} }'])
    assert.equal(P(same), same);
  const nested = P('for (let i = 0; i < n; i++) for (let j = 0;; j++) { while (a && (b || c)) break; }');
  assert.match(nested, /__sdLoop\(1\)&&\( i < n\)/); assert.match(nested, /__sdLoop\(2\)/); assert.match(nested, /__sdLoop\(3\)&&\(a && \(b \|\| c\)\)/);
  for (const src of ['while(true){}', 'for(;;){}', 'label: while (a && (b || c)) { break label; }', 'const f = () => { let s = `${[1,2].map(x => { for (let i=0;i<x;i++); return x; })}`; return s; }'])
    assert.doesNotThrow(() => new Function(P(src)), src);
  // Documents: inline classic/module scripts are guarded; external and data scripts are not.
  const doc = F.protectDocumentScripts('<script>while(1){}</script><script src="https://cdn.jsdelivr.net/x.js">while(1){}</script><script type="application/json">{"while(1)":1}</script><script type="module">for(;;){}</script>');
  assert.match(doc, /<script>while\(__sdLoop\(1\)&&\(1\)\)\{\}<\/script>/);
  assert.match(doc, /src="https:\/\/cdn\.jsdelivr\.net\/x\.js">while\(1\)\{\}/);
  assert.match(doc, /"while\(1\)":1/);
  assert.match(doc, /type="module">for\(;__sdLoop\(1\);\)/);
  // Built surfaces define the runtime before author code; MCP apps are left untouched.
  const html = F.buildDocument({ kind: 'html', source: '<!doctype html><html><head></head><body><script>while(true){}</script></body></html>' });
  assert.ok(html.indexOf('window.__sdLoop=') > 0 && html.indexOf('window.__sdLoop=') < html.indexOf('while(__sdLoop(1)'));
  assert.match(F.buildDocument({ kind: 'visual', source: '<script>for(;;){}</script>' }), /for\(;__sdLoop\(1\);\)/);
  assert.match(F.buildDocument({ kind: 'react', source: 'export default function A(){return null}' }), /function protectLoops/);
  assert.match(F.buildDocument({ kind: 'mcp', source: '<script>while(true){}</script>' }), /<script>while\(true\)\{\}<\/script>/);
});

test('frame: loop runtime stops a loop that keeps the thread busy past the limit and reports once', () => {
  const { window } = load(['sd-genui-host.js', 'sd-genui-frame.js']);
  const F = window.__sdGenUIFrame;
  const html = F.buildDocument({ kind: 'visual', source: '<p>x</p>' });
  const src = html.match(/window\.__sdLoop=\(([\s\S]*?)\)\(post,(\d+)\);/);
  assert.ok(src, 'runtime embedded'); assert.equal(Number(src[2]), F.loopLimitMs);
  const posts = [];
  const guard = new Function('post', 'limit', 'return (' + src[1] + ')(post, limit);')((m) => posts.push(m), 50);
  const t0 = Date.now(); let n = 0;
  while (guard(1)) { n++; if (Date.now() - t0 > 2000) break; }
  assert.ok(Date.now() - t0 < 1000, 'stopped near the limit'); assert.ok(n > 0);
  assert.equal(posts.length, 1); assert.equal(posts[0].type, 'error'); assert.match(posts[0].message, /loop/i);
  assert.equal(guard(1), false, 'a stopped loop stays stopped while it keeps spinning');
});
