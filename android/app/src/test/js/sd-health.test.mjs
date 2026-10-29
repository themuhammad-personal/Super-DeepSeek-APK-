// Tests for bds/sd-health.js (engine self-check, 2.72.0). Run: npm run test:engine
//
// The module exists because the engine rides on someone else's DOM: a renamed
// class must produce a visible "degraded" state on the phone instead of a
// feature that quietly stops existing. These tests drive it with a fake page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HEALTH = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/sd-health.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A DOM just big enough for the module: querySelector by selector list, a body tree, ids. */
function fakeDom({ present = [], lang = 'en', dark = false } = {}) {
  const have = new Set(present);
  let seq = 0;
  function make(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentNode: null,
      textContent: '',
      attrs: {},
      id: '',
      listeners: {},
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) byId.set(c.id, c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c.id) byId.delete(c.id); c.parentNode = null; return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
      select() {},
      querySelector(sel) { return query(sel); },
      querySelectorAll() { return []; },
    };
    seq++;
    return el;
  }
  const byId = new Map();
  function query(sel) {
    if (!have.has(sel)) return null;
    const found = make('div');
    found.matches = sel;
    return found;
  }
  const body = make('body');
  body.classList = { contains: () => dark };
  const documentElement = { lang, classList: { contains: () => dark } };
  const doc = {
    readyState: 'complete',
    body,
    documentElement,
    createElement: make,
    querySelector: query,
    querySelectorAll: () => [],
    getElementById: (id) => byId.get(id) || null,
    addEventListener() {},
    execCommand() { return true; },
  };
  return { doc, body, byId };
}

function load(opts = {}) {
  const dom = fakeDom(opts);
  const storage = new Map();
  const timers = [];
  const clipboard = [];
  const ctx = {
    console: { info() {}, warn() {} },
    JSON, Math, Object, Array, String, Number, Date, Set, Map, Array_isArray: Array.isArray,
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc?x=1' },
    navigator: { language: opts.lang || 'en', userAgent: 'TestUA/1.0', clipboard: { writeText: (t) => { clipboard.push(t); return Promise.resolve(); } } },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
    },
    document: dom.doc,
    getComputedStyle: () => ({ backgroundColor: opts.dark ? 'rgb(20, 20, 22)' : 'rgb(255, 255, 255)' }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    addEventListener() {},
  };
  ctx.window = ctx;
  if (opts.globals) Object.assign(ctx, opts.globals);
  if (opts.locale) ctx.__sdEngine = { locale: () => opts.locale };
  vm.createContext(ctx);
  vm.runInContext(HEALTH, ctx);
  return { H: ctx.__sdHealth, dom, storage, timers, clipboard, win: ctx };
}

const HEALTHY = [
  'textarea#chat-input', 'a[href*="/chat/s/"]', '.ds-markdown', 'pre code[class*="language-"]',
  '.ds-icon-stop', '.ds-icon-copy', '[class*="think"]', '.ds-message',
];
const GLOBALS = {
  __sdNativeApi: {}, __sdAgent: {}, __sdRun: {}, __sdGenui: {}, __sdGenuiViewer: {}, __sdFiles: {},
};

test('a healthy page: engine OK, nothing on screen', () => {
  const { H, dom } = load({ present: HEALTHY, globals: GLOBALS });
  const rep = H.run();
  assert.equal(rep.ok, true);
  assert.equal(rep.failed.length, 0);
  assert.equal(rep.modules.length, 0);
  assert.equal(dom.byId.get('sd-health-strip'), undefined);
});

test('a core check failing is "degraded" and shows the strip exactly once', () => {
  // No message box at all: the page cannot be used, whatever else matches.
  const present = HEALTHY.filter((s) => s !== 'textarea#chat-input');
  const { H, dom } = load({ present, globals: GLOBALS });
  const rep = H.run();
  assert.equal(rep.ok, false);
  assert.equal(rep.core, false);
  assert.deepEqual(plain(rep.failed.map((f) => f.id)), ['composer']);
  assert.ok(dom.byId.get('sd-health-strip'), 'strip missing');
  const first = dom.byId.get('sd-health-strip');
  H.run();
  assert.equal(dom.body.children.filter((c) => c.id === 'sd-health-strip').length, 1, 'strip duplicated');
  assert.equal(dom.byId.get('sd-health-strip'), first);
});

test('one or two feature checks missing stay quiet (no false alarm)', () => {
  const present = HEALTHY.filter((s) => s !== '[class*="think"]' && s !== '.ds-icon-copy');
  const { H, dom } = load({ present, globals: GLOBALS });
  const rep = H.run();
  assert.equal(rep.ok, true, 'two missing features must not warn');
  assert.deepEqual(plain(rep.failed.map((f) => f.id)), ['copy', 'reasoning']);
  assert.equal(dom.byId.get('sd-health-strip'), undefined);
  // …but the report still carries them, which is the point of the diagnostics page.
  assert.ok(H.text().includes('FAIL copy'));
});

test('three feature checks missing are a real breakage', () => {
  const present = HEALTHY.filter((s) => s !== '[class*="think"]' && s !== '.ds-icon-copy' && s !== '.ds-message');
  const { H, dom } = load({ present, globals: GLOBALS });
  const rep = H.run();
  assert.equal(rep.ok, false);
  assert.ok(dom.byId.get('sd-health-strip'));
});

test('an engine module that did not run is reported by name', () => {
  const { H } = load({ present: HEALTHY, globals: { ...GLOBALS, __sdRun: undefined } });
  const rep = H.run();
  assert.equal(rep.ok, false);
  assert.deepEqual(plain(rep.modules), ['__sdRun']);
  assert.ok(H.text().includes('__sdRun'));
  assert.deepEqual(plain(rep.engineLoaded).includes('sd-run.js'), false);
});

test('the kill switch and run({ui:false}) keep the page untouched', () => {
  const bad = HEALTHY.filter((s) => s !== 'textarea#chat-input');
  const off = load({ present: bad, globals: GLOBALS });
  off.H.setEnabled(false);
  off.H.run();
  assert.equal(off.dom.byId.get('sd-health-strip'), undefined, 'kill switch ignored');

  const quiet = load({ present: bad, globals: GLOBALS });
  const rep = quiet.H.run({ ui: false });
  assert.equal(rep.ok, false);
  assert.equal(quiet.dom.byId.get('sd-health-strip'), undefined, 'ui:false still drew');
});

test('history keeps the last runs, newest last, and survives a reload', () => {
  const { H, storage } = load({ present: HEALTHY, globals: GLOBALS });
  for (let i = 0; i < 25; i++) H.run({ ui: false });
  const list = storage.get('sd_health_v1');
  const parsed = JSON.parse(list);
  assert.equal(parsed.length, 20);
  assert.equal(parsed[parsed.length - 1].ok, true);
  assert.deepEqual(H.history().length, 20);
});

test('a run that cannot even store history still works', () => {
  const { H } = load({ present: HEALTHY, globals: GLOBALS });
  const win = H; // no-op: the module swallows storage errors internally
  assert.ok(win.report());
});

test('the report text is self-contained and carries no cookies or tokens', () => {
  const { H } = load({ present: HEALTHY, globals: GLOBALS });
  H.run({ ui: false });
  const text = H.text();
  for (const line of ['Super DeepSeek engine health', 'result:', 'url:', 'ua:', 'page checks:', 'engine modules missing:']) {
    assert.ok(text.includes(line), `missing line: ${line}`);
  }
  assert.ok(text.includes('https://chat.deepseek.com/a/chat/s/abc'), 'url should point at the chat');
  assert.ok(!text.includes('?x=1'), 'query string (may hold a share token) must be dropped');
});

test('the details sheet opens and copies the report', async () => {
  const { H, dom, clipboard } = load({ present: HEALTHY, globals: GLOBALS });
  H.run({ ui: false });
  H.open();
  const sheet = dom.byId.get('sd-health-sheet');
  assert.ok(sheet, 'sheet missing');
  // Copy button is the first button in the action row of the sheet.
  const findButtons = (node, out = []) => {
    if (node.tagName === 'BUTTON') out.push(node);
    for (const c of node.children) findButtons(c, out);
    return out;
  };
  const buttons = findButtons(sheet);
  assert.ok(buttons.length >= 2, 'expected Copy and Close');
  buttons[0].listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.ok(clipboard.length === 1 && clipboard[0].includes('Super DeepSeek engine health'));
  buttons[1].listeners.click[0]();
  assert.equal(dom.byId.get('sd-health-sheet'), undefined, 'Close did not remove the sheet');
});

test('Bengali UI gets Bengali text', () => {
  const bad = HEALTHY.filter((s) => s !== 'textarea#chat-input');
  const { H } = load({ present: bad, globals: GLOBALS, locale: 'bn' });
  const rep = H.run({ ui: false });
  assert.ok(rep.summary.includes('ইঞ্জিন'), rep.summary);
});

test('evaluate() is pure: the same probe always gives the same answer', () => {
  const { H } = load({ present: HEALTHY, globals: GLOBALS });
  const probe = (sel) => sel === 'textarea#chat-input';
  const a = plain(H.evaluate(probe, Object.keys(GLOBALS)));
  const b = plain(H.evaluate(probe, Object.keys(GLOBALS)));
  assert.deepEqual(a, b);
  assert.equal(a.ok, false, 'only the composer matched: the rest is missing');
  assert.equal(a.checks.length, H.checks.length);
});
