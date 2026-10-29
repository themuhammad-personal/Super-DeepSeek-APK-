// Unit tests for the Generative UI v2 modules: header-format protocol, prompt
// modules/config/compliance analysis, host adapter helpers, tool visuals and
// artifact normalization. DOM-free (node:vm); browser behaviour is covered by
// scripts/genui-browser-check.mjs.
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
  const window = {
    navigator: { language: 'en' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    ...extra
  };
  window.window = window;
  const ctx = vm.createContext({ window, globalThis: window, document: { body: null }, console, setTimeout, clearTimeout, TextEncoder, btoa, atob, URL });
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return { window, store };
}

test('protocol: header format converts to the same validated envelope', () => {
  const { window } = load(['sd-genui-protocol.js']);
  const P = window.__sdGenUIProtocol;
  const r = P.parseBlock('id: emi\nkind: html-app\ntitle: EMI\nrevision: 3\n---\n<!doctype html><html><head><title>x</title><style>b{c:d}</style></head><body><main>m</main><script src="https://cdn.x/y.js"></script><script>go()</script></body></html>');
  assert.equal(r.ok, true, r.error);
  // v3: header-format apps keep the complete document verbatim (CDN scripts included) for the live viewer.
  assert.deepEqual(JSON.parse(JSON.stringify(r.block.payload)).source.slice(0, 15), '<!doctype html>');
  assert.equal(r.block.payload.html, '');
  assert.equal(r.block.revision, 3);
  assert.equal(P.parseBlock('{"version":1,"id":"a","kind":"svg","payload":{"svg":"<svg></svg>"}}').ok, true, 'JSON envelope still accepted');
});

test('protocol: header format rejects hostile or ambiguous input through the one gate', () => {
  const { window } = load(['sd-genui-protocol.js']);
  const P = window.__sdGenUIProtocol;
  // Lenient on authoring slips (Phase 4): first duplicate wins, kind inferred, id repaired.
  assert.equal(P.parseBlock('id: a\nid: b\nkind: svg\n---\n<svg/>').block.id, 'a');
  assert.equal(P.parseBlock('id: a\n---\n<svg/>').block.kind, 'svg');
  assert.equal(P.parseBlock('id: 1bad\nkind: svg\n---\n<svg/>').block.id, 'a-1bad');
  assert.equal(P.parseBlock('title: My Page\n<!doctype html><html><body>x</body></html>').block.kind, 'html-app');
  assert.equal(P.parseBlock('kind: website\ntitle: T\n---\n<div>x</div>').block.kind, 'html-app');
  assert.equal(P.parseBlock('kind: python\ntitle: T\n---\nprint(1)').block.payload.language, 'python');
  assert.equal(P.parseBlock('{"id":"9 x","kind":"html","html":"<b>x</b>"}').ok, true, 'JSON envelope repaired');
  // ...but never on security: these still fail at the one gate.
  assert.equal(P.parseBlock('id: s\nkind: svg\n---\n').ok, false);
  assert.match(P.parseBlock('id: m\nkind: mcp-app\nserver: http://10.0.0.1/mcp\nresource: ui://x').error, /MCP server URL/);
  assert.match(P.parseBlock('id: m\nkind: mcp-app\nserver: https://ok.example/mcp\nresource: file:///etc/passwd').error, /MCP resource URI/);
  assert.match(P.parseBlock('id: t\nkind: tool-result\nview: hologram\n---\n{}').error, /tool-result view/);
  assert.match(P.parseBlock('id: u\nkind: ui\n---\n{"__proto__":{"x":1}}').error, /Reserved key|Invalid component/);
  assert.equal(P.parseBlock('id: a\nkind: svg\nfuture-key: 1\n---\n<svg></svg>').ok, true, 'unknown keys ignored for forward compatibility');
});

test('protocol: Stream seals header-format blocks only at a closing fence', () => {
  const { window } = load(['sd-genui-protocol.js']);
  const s = new window.__sdGenUIProtocol.Stream();
  let parts = s.push('Intro\n```sds-genui\nid: s\nkind: svg\n---\n<svg viewBox="0 0 1 1">');
  assert.equal(parts.filter((p) => p.type === 'visual').length, 0);
  parts = s.push('</svg>\n```\nOutro', true);
  const v = parts.filter((p) => p.type === 'visual');
  assert.equal(v.length, 1);
  assert.equal(v[0].result.ok, true);
});

test('prompt: hidden guidance is wrapped, modular and honours frequency + kill switch', () => {
  const { window } = load(['sd-genui-protocol.js', 'sd-genui-prompt.js']);
  const P = window.__sdGenUIPrompt;
  const app = P.build('Build me a snake game app', { chat: 'a', isFirst: true });
  assert.match(app, /^<SuperDeepSeek>\n/);
  assert.match(app, /<\/SuperDeepSeek>$/);
  assert.match(app, /sds-genui — artifacts/);
  assert.match(app, /<SDS:VISUALIZER> tag is deprecated/, 'legacy visualizer is steered away');
  assert.doesNotMatch(app, /sds-ui component spec/, 'only relevant modules are injected');
  const chart = P.build('Compare these budgets in a chart', { chat: 'b' });
  assert.match(chart, /sds-visual — inline visuals/, 'explanations/charts go inline');
  assert.match(chart, /viewBox="0 0 400 H"/, 'phone-readable SVG width');
  assert.equal(P.build('What is 2+2?', { chat: 'c' }), '', 'auto mode skips non-visual turns');
  P.setConfig({ frequency: 'every_n', interval: 3 }); P._resetTurns();
  const seq = [1, 2, 3, 4, 5].map(() => !!P.build('hi', { chat: 'd' }));
  assert.deepEqual(seq, [true, false, false, true, false]);
  P.setConfig({ frequency: 'off' }); assert.equal(P.build('Build a chart', { chat: 'e' }), '');
  P.setConfig({ frequency: 'always', enabled: false }); assert.equal(P.build('Build a chart', { chat: 'f' }), '');
  P.setConfig({ enabled: true, inject: false }); assert.equal(P.build('Build a chart', { chat: 'g' }), '');
});

test('prompt: config is normalized, persisted and selector overrides are sanitized', () => {
  const { window, store } = load(['sd-genui-prompt.js']);
  const P = window.__sdGenUIPrompt;
  const c = P.setConfig({ frequency: 'bogus', interval: 999, modules: { core: false, apps: false }, selectors: { composer: 'x{}</style>', message: '.chat .msg' } });
  assert.equal(c.frequency, 'auto');
  assert.equal(c.interval, 20);
  assert.equal(c.modules.core, true, 'core contract cannot be disabled');
  assert.equal(c.modules.apps, false);
  assert.equal(c.selectors.composer, 'textarea');
  assert.equal(c.selectors.message, '.chat .msg');
  assert.ok(store.get(P.KEY).includes('.chat .msg'));
});

test('prompt: analyze() measures compliance honestly (typed, raw, invalid, unclosed)', () => {
  const { window } = load(['sd-genui-protocol.js', 'sd-genui-svg.js', 'sd-genui.js', 'sd-genui-prompt.js']);
  const A = window.__sdGenUIPrompt.analyze;
  const good = A('Here:\n```sds-genui\nid: a\nkind: svg\n---\n<svg viewBox="0 0 2 2"><rect width="2" height="2"/></svg>\n```\n');
  assert.equal(good.typed, 1); assert.equal(good.typedValid, 1); assert.equal(good.compliant, true);
  const bad = A('```sds-genui\nid: a\nkind: ui\n---\n{not json\n```\n');
  assert.equal(bad.compliant, false); assert.equal(bad.typedValid, 0);
  const raw = A('```html\n<!doctype html><html><body><p>x</p></body></html>\n```\n');
  assert.equal(raw.typed, 0); assert.equal(raw.rawFallback, 1); assert.equal(raw.rawRenderable, 1); assert.equal(raw.compliant, false);
  assert.equal(A('Plain answer without visuals.').visual, 0);
  assert.equal(A('```sds-genui\nid: a\nkind: svg\n---\n<svg>').unclosed, 1);
});

test('host: redaction removes common secret shapes and keeps ordinary text', () => {
  const { window } = load(['sd-genui-host.js']);
  const H = window.__sdGenUIHost;
  const r = H.redact('sk-proj-abcdefghijklmnopqrstuv ghp_abcdefghijklmnopqrstuvwxyz1234 AKIAABCDEFGHIJKLMNOP {"apiKey":"s3cr3t-value"} Authorization: Bearer abc.def.ghijklmnop tokens: 5000 -----BEGIN PRIVATE KEY-----\nMIIx\n-----END PRIVATE KEY-----');
  assert.doesNotMatch(r.text, /abcdefghijklmnopqrstuv|ABCDEFGHIJKLMNOP|s3cr3t-value|ghijklmnop|MIIx/);
  assert.match(r.text, /tokens: 5000/);
  assert.ok(r.count >= 6);
});

test('host: CSV export quotes properly and neutralizes formula injection', () => {
  const { window } = load(['sd-genui-host.js']);
  const csv = window.__sdGenUIHost.toCsv(['name', 'note'], [{ name: '=SUM(A1)', note: 'a,"b"' }, ['+1', '@x']]);
  assert.equal(csv, '\ufeffname,note\r\n\'=SUM(A1),"a,""b"""\r\n\'+1,\'@x');
});

test('host: ledger is bounded, redacted and persisted', async () => {
  const { window, store } = load(['sd-genui-host.js']);
  const L = window.__sdGenUIHost.ledger;
  for (let i = 0; i < 130; i++) L.record({ type: 'tool', title: 'call ' + i, detail: 'apiKey=supersecretvalue' });
  const items = L.list();
  assert.equal(items.length, 120);
  assert.equal(items[0].title, 'call 129');
  assert.doesNotMatch(JSON.stringify(items), /supersecretvalue/);
  assert.ok(L.update(items[0].id, { state: 'done', endedAt: 1 }));
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(JSON.parse(store.get('sd_exec_ledger_v1')).items.length === 120);
});

test('host: guard() opens a circuit after repeated failures instead of breaking chat', () => {
  const { window } = load(['sd-genui-host.js']);
  const H = window.__sdGenUIHost;
  for (let i = 0; i < 6; i++) assert.equal(H.guard('flaky', () => { throw new Error('boom'); }, 'fallback'), 'fallback');
  assert.equal(H.health().flaky.open, true);
  let ran = false;
  H.guard('flaky', () => { ran = true; });
  assert.equal(ran, false, 'open circuit stops the module');
  assert.equal(H.guard('healthy', () => 42), 42);
});

test('visuals: four presentations from real-world tool result shapes', () => {
  const { window } = load(['sd-genui.js', 'sd-genui-visuals.js']);
  const V = window.__sdGenUIVisuals, G = window.__sdGenUI;
  const cases = [
    [[{ name: 'a', score: 3 }, { name: 'b', score: 5 }, { name: 'c', score: 9 }], 'table'],
    [[1, 4, 2, 8], 'chart'],
    [{ temp: 30, ok: true }, 'cards'],
    ['plain text', 'json'],
    [{ content: [{ type: 'text', text: '{"rows":[{"d":"x","v":1},{"d":"y","v":2}]}' }] }, 'table'],
    [{ content: [{ type: 'text', text: 'failed' }], isError: true }, 'json']
  ];
  for (const [input, view] of cases) {
    const p = V.plan(input, { name: 'tool' });
    assert.equal(p.view, view, JSON.stringify(input));
    const parsed = G.parseSpec(p.spec);
    assert.equal(parsed.ok, true, parsed.error);
  }
  assert.equal(V.plan({ content: [{ type: 'text', text: 'x' }], isError: true }).spec.components[0].tone, 'danger');
  assert.equal(V.plan([{ a: 1 }, { a: 2 }], { view: 'json' }).view, 'json', 'explicit view wins');
  const big = V.plan(Array.from({ length: 40 }, (_, i) => ({ i, v: i * 2 })));
  assert.equal(big.csv.rows.length, 40, 'CSV keeps every row even when the table is truncated');
});

test('artifacts + renderers: no dynamic code execution or HTML injection into the chat DOM', () => {
  for (const f of ['sd-artifacts.js', 'sd-genui-host.js', 'sd-genui-visuals.js', 'sd-genui-panel.js', 'sd-genui-prompt.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(|document\.write|insertAdjacentHTML|outerHTML\s*=/, f);
  }
  // Chat-side modules build DOM with createElement/textContent only; model markup
  // goes exclusively into sandboxed frames (srcdoc) built by sd-genui-frame.js.
  for (const f of ['sd-artifacts.js', 'sd-genui-viewer.js', 'sd-genui-inline.js', 'sd-genui-mcp.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /\beval\s*\(|new Function\s*\(|document\.write|insertAdjacentHTML|outerHTML\s*=|\.innerHTML\s*=/, f);
  }
  const frame = read('sd-genui-frame.js');
  assert.match(frame, /allow-scripts/);
  assert.doesNotMatch(frame.replace(/\/\*[\s\S]*?\*\//g, ''), /'allow-same-origin|allow-same-origin'/);
});

test('injected.js delegates to the prompt module and wraps its fallback', () => {
  const src = read('injected.js');
  assert.match(src, /window\.__sdGenUIPrompt;if\(__g&&typeof __g\.build=="function"\)/);
  assert.ok(src.includes('u.push("<SuperDeepSeek>\\n## Generative UI preparation and output selection'));
  assert.doesNotThrow(() => new Function(src));
});
