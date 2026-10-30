// Regression tests for Multi-Step Coding Agent, Sandbox & MCP UX Hardening:
//  1. Truncated/collapsed .ds-collapsible-text [SDS:AUTO] user bubbles & wiped nudges
//  2. Streaming unclosed <SDS:AUTO:MCP ...> tags, quotes + '->' arrows inside args='...',
//     and orphan closing </SDS:AUTO:MCP> tags (sd-run.js, sd-agent.js, content.js)
//  3. Wire-level auto-payload substitution (content.js + injected.js) keeping composer compact
//  4. Quiet composer lock & touch-scroll resilience (sd-native.js)
//  5. Live step persistence across 'new' -> session ID URL transitions & virtual scroll (sd-run.js)
// Run: npm run test:engine

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const here = path.dirname(fileURLToPath(import.meta.url));
const BDS = path.join(here, '../../main/bds-assets/bds');
const RUN_SRC = fs.readFileSync(path.join(BDS, 'sd-run.js'), 'utf8');
const AGENT_SRC = fs.readFileSync(path.join(BDS, 'sd-agent.js'), 'utf8');
const NATIVE_SRC = fs.readFileSync(path.join(BDS, 'sd-native.js'), 'utf8');
const INJECTED_SRC = fs.readFileSync(path.join(BDS, 'injected.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(BDS, 'content.js'), 'utf8');

const plain = (v) => JSON.parse(JSON.stringify(v));

function loadAgentAndRun({ lang = 'bn', href = 'https://chat.deepseek.com/a/chat/s/vid123' } = {}) {
  const storage = {};
  const rootClasses = new Set();
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, Boolean, Date, RegExp, Map, WeakMap, Set,
    Uint8Array, TextDecoder, CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail; } }, isFinite,
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref(); return h; },
    clearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { language: lang },
    location: { href },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    document: {
      documentElement: {
        lang,
        classList: {
          toggle(c, on) { if (on === undefined ? !rootClasses.has(c) : on) rootClasses.add(c); else rootClasses.delete(c); },
          remove(c) { rootClasses.delete(c); },
          add(c) { rootClasses.add(c); },
          contains: (c) => rootClasses.has(c),
        },
      },
      body: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    AndroidBridge: {
      sandboxInfo: () => JSON.stringify({ supported: true, enabled: true, mode: 'auto' }),
      sandboxAgentActive() {},
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  };
  ctx.window = ctx;
  ctx.__sdBridgeFetch = async () => ({ ok: true, result: {} });
  vm.createContext(ctx);
  vm.runInContext(AGENT_SRC, ctx);
  vm.runInContext(RUN_SRC, ctx);
  return { win: ctx, R: ctx.__sdRun, A: ctx.__sdAgent, storage, rootClasses };
}

test('UX-01: truncated .ds-collapsible-text [SDS:AUTO] user bubbles & [SDS:AUTO_TURN] sentinels classify as auto user messages and do not split runs', () => {
  const { R } = loadAgentAndRun();

  // Exact truncated text from Screenshot 2 (11:38) & Screenshot 3 (11:33) — cut off before [/SDS:AUTO_MCP_RESULT]</SuperDeepSeek>
  const truncatedRunBubble =
    '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox\n[SDS:AUTO_MCP_RESULT]\n' +
    '{"serverName":"sandbox","toolName":"run","call":"cd /root/workspace/village && python3';
  const truncatedInstallBubble =
    '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for install_packages @ sandbox\n[SDS:AUTO_MCP_RESULT]\n' +
    '{"serverName":"sandbox","toolName":"install_packages","call":"{\\"packages\\":[\\"ffmpeg\\",\\"python3\\",\\"';
  const wireSentinel = '<SuperDeepSeek>[SDS:AUTO_TURN:t_981a] Sandbox result</SuperDeepSeek>';

  assert.equal(R._isAutoUserText(truncatedRunBubble, 'user'), true, 'truncated collapsible run result must be detected as auto user');
  assert.equal(R._isAutoUserText(truncatedInstallBubble, 'user'), true, 'truncated collapsible install_packages result must be detected as auto user');
  assert.equal(R._isAutoUserText(wireSentinel, 'user'), true, 'compact wire sentinel must be detected as auto user');

  // Ordinary human message with injected system prompt must NEVER be classified as auto user
  const humanWithSysPrompt =
    '<SuperDeepSeek>\nYou are a helpful assistant.\n</SuperDeepSeek>\n\nগ্রামের দৃশ্যের অ্যানিমেটেড ভিডিও (MP4) বানিয়ে দাও';
  assert.equal(R._isAutoUserText(humanWithSysPrompt, 'user'), false, 'real user prompt must remain human turn');

  // Full 4-step conversation with truncated collapsible bubbles must group into ONE single run card
  const msgs = [
    R._classifyMessage('user', 'গ্রামের দৃশ্যের অ্যানিমেটেড ভিডিও (MP4) বানিয়ে দাও', 0, false),
    R._classifyMessage('assistant', 'শুরু করছি।\n<SDS:AUTO:MCP url="sandbox" tool="install_packages">{"packages":["ffmpeg"]}</SDS:AUTO:MCP>', 0, false),
    R._classifyMessage('user', truncatedInstallBubble, 0, false),
    R._classifyMessage('assistant', '<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"python3 render.py"}</SDS:AUTO:MCP>', 0, false),
    R._classifyMessage('user', truncatedRunBubble, 0, false),
    R._classifyMessage('assistant', 'আপনার গ্রামের দৃশ্যের অ্যানিমেটেড ভিডিও তৈরি হয়েছে!', 0, false),
  ];
  const runs = plain(R._groupRuns(msgs));
  assert.equal(runs.length, 1, 'must produce exactly ONE unified run card');
  assert.deepEqual(runs[0].hidden, [2, 3, 4], 'all intermediate auto bubbles and tool replies must be hidden');
  assert.equal(runs[0].host, 1);
  assert.equal(runs[0].final, 5);
});

test('UX-02: wiped user message carrying .bds-hidden-message on the message root itself is recognised as auto user', () => {
  const { R } = loadAgentAndRun();
  assert.equal(typeof R._isAutoUserEl, 'function', 'exposes _isAutoUserEl for root-class verification');
  const wipedEl = {
    classList: { contains: (c) => c === 'bds-hidden-message' },
    hasAttribute: () => false,
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    childNodes: [],
  };
  assert.equal(R._isAutoUserEl(wipedEl, 'user', ''), true, 'message root with .bds-hidden-message and no visible text is an auto nudge');
});

test('UX-03: streaming unclosed <SDS:AUTO:MCP ...> opening tag & quotes/arrows (-> MP4) inside args=\'...\' are hidden and parsed accurately', () => {
  const { R, A } = loadAgentAndRun();

  // 1. Streaming mid-opening-tag BEFORE '>' arrives (exact Video 00:00–00:02 bug!)
  const streamingOpen =
    'চমৎকার! আমি এখন স্ক্রিপ্ট লিখছি।\n\n' +
    '<SDS:AUTO:MCP url="sandbox" tool="write_file" args=\'{"path":"/root/workspace/village/render.py","content":"import os\\nprint(\'frames -> MP4\')\\nif x > 0:\\n';
  const spans1 = plain(R._findRawCallSpans(streamingOpen));
  assert.equal(spans1.length, 1, 'in-flight unclosed opening tag must already be captured as a raw call span');
  assert.equal(streamingOpen.slice(0, spans1[0].start).trim(), 'চমৎকার! আমি এখন স্ক্রিপ্ট লিখছি।');
  assert.equal(spans1[0].end, streamingOpen.length, 'must hide all streaming tool bytes to end of message');
  assert.equal(R._stripTags(streamingOpen), 'চমৎকার! আমি এখন স্ক্রিপ্ট লিখছি।');

  // 2. Completed call with single quotes AND '->' inside single-quoted args='...' + closing </SDS:AUTO:MCP>
  const completedWithQuotesAndArrow =
    'দিয়ে চালাই।\n\n' +
    '<SDS:AUTO:MCP url="sandbox" tool="write_file" args=\'{"path":"/root/workspace/village/render.py","content":"print(\'frames -> MP4\')\\n"}\'></SDS:AUTO:MCP>' +
    '\nপরবর্তী অংশ।';
  const spans2 = plain(R._findRawCallSpans(completedWithQuotesAndArrow));
  assert.equal(spans2.length, 1);
  assert.equal(
    completedWithQuotesAndArrow.slice(0, spans2[0].start) + completedWithQuotesAndArrow.slice(spans2[0].end),
    'দিয়ে চালাই।\n\n\nপরবর্তী অংশ।'
  );

  // sd-agent parseTags + tagArgs must also extract the full JSON without breaking on inner single quotes or '->'
  const parsed = plain(A._parseTags(completedWithQuotesAndArrow));
  assert.equal(parsed.length, 1);
  const args = plain(A._tagArgs(parsed[0]));
  assert.deepEqual(args, {
    path: '/root/workspace/village/render.py',
    content: "print('frames -> MP4')\n",
  });

  // 3. Open-only args='...' call followed by a body-JSON call must NOT swallow the second call
  const mixedBatch =
    '<SDS:AUTO:MCP url="sandbox" tool="write_file" args=\'{"path":"a.py","content":"x = 1"}\'>\n' +
    '<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"python3 a.py"}</SDS:AUTO:MCP>';
  const batchTags = plain(A._parseTags(mixedBatch));
  assert.equal(batchTags.length, 2, 'both calls in a mixed args= + body batch must be parsed');
  assert.deepEqual(plain(A._tagArgs(batchTags[0])), { path: 'a.py', content: 'x = 1' });
  assert.deepEqual(plain(A._tagArgs(batchTags[1])), { command: 'python3 a.py' });
});

test('UX-04: wire-level auto-payload queue expands compact [SDS:AUTO_TURN] sentinel in injected.js fetch & XHR while keeping composer compact', async () => {
  const listeners = new Map();
  let capturedFetchBody = null;
  const rootAttrs = new Map();
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    JSON, String, Number, Boolean, Array, Object, Map, Set, Date, Math, Promise, RegExp, Error, URL, URLSearchParams, Headers,
    Request: class Request {},
    encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = String(type); this.detail = init ? init.detail : undefined; }
    },
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      cookie: '',
      documentElement: {
        setAttribute: (k, v) => rootAttrs.set(k, String(v)),
        getAttribute: (k) => rootAttrs.get(k) || null,
      },
      querySelector: () => null,
    },
    location: { href: 'https://chat.deepseek.com/a/chat/s/s1', pathname: '/a/chat/s/s1' },
    XMLHttpRequest: function XMLHttpRequest() {},
    fetch: async (_url, init) => {
      capturedFetchBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        clone() { return this; },
        text: async () => '{}',
        json: async () => ({}),
      };
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return true;
    },
  };
  ctx.XMLHttpRequest.prototype = { open() {}, send() {}, setRequestHeader() {}, addEventListener() {} };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(INJECTED_SRC, ctx);

  assert.equal(rootAttrs.get('data-bds-auto-wire'), '1', 'injected.js advertises wire auto-payload readiness on <html>');

  const fullResult =
    '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox\n[SDS:AUTO_MCP_RESULT]\n' +
    JSON.stringify({ serverName: 'sandbox', toolName: 'run', call: 'python3 render.py', content: 'Frame 1..120 rendered -> village.mp4\n'.repeat(80) }) +
    '\n[/SDS:AUTO_MCP_RESULT]\n</SuperDeepSeek>';

  ctx.dispatchEvent(new ctx.CustomEvent('bds:queue-auto-payload', {
    detail: JSON.stringify({ id: 'tok_village_1', payload: fullResult }),
  }));

  const sentinel = '<SuperDeepSeek>[SDS:AUTO_TURN:tok_village_1] Sandbox result</SuperDeepSeek>';
  await ctx.fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: sentinel, chat_session_id: 's1', parent_message_id: 2 }),
  });

  assert.ok(capturedFetchBody, 'fetch intercepted');
  assert.equal(capturedFetchBody.prompt, fullResult, 'wire body receives the full multi-KB MCP result instead of the compact composer sentinel');
});

test('UX-05: sd-native quiet composer does NOT cancel sd-auto-send on accidental touch/pointerdown scroll, only on real typing', () => {
  const docListeners = new Map();
  const rootClasses = new Set(['sd-auto-send']);
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Date, Uint8Array, RegExp, Blob, File, URL,
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { language: 'bn' },
    document: {
      documentElement: {
        lang: 'bn',
        classList: {
          contains: (c) => rootClasses.has(c),
          remove: (c) => rootClasses.delete(c),
          add: (c) => rootClasses.add(c),
        },
      },
      head: { appendChild() {} },
      body: {},
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', style: {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      },
    },
    location: { pathname: '/', host: 'chat.deepseek.com', search: '' },
    fetch: async () => ({ ok: false, status: 404 }),
    AndroidBridge: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(NATIVE_SRC, ctx);

  const textarea = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    readOnly: false,
    disabled: false,
    hasAttribute: () => false,
    closest: () => null,
  };

  // Finger touch / pointerdown while scrolling over the bottom composer must NOT strip sd-auto-send!
  for (const fn of docListeners.get('pointerdown') || []) {
    fn({ isTrusted: true, target: textarea });
  }
  assert.equal(rootClasses.has('sd-auto-send'), true, 'touch/pointerdown during scroll must NOT unmask raw auto-send text');

  // Genuine user typing (beforeinput) immediately hands composer back to the user
  for (const fn of docListeners.get('beforeinput') || []) {
    fn({ isTrusted: true, target: textarea });
  }
  assert.equal(rootClasses.has('sd-auto-send'), false, 'real typing immediately releases sd-auto-send');
});

test('UX-06: live run steps survive new-chat URL assignment (/ -> /a/chat/s/<id>) and virtualized user-message unmounting', () => {
  const { win, R } = loadAgentAndRun({ href: 'https://chat.deepseek.com/' });

  // Start step 1 while still on https://chat.deepseek.com/ ('new')
  win.__sdRunEvent({
    phase: 'start',
    id: 1,
    server: 'sandbox://linux',
    tool: 'write_file',
    call: 'village/render.py (1200 chars)',
    args: { path: 'village/render.py', content: '...' },
    at: 1000,
  });
  assert.equal(plain(R._live()).steps.length, 1);

  // DeepSeek assigns session URL /a/chat/s/new_sid_42 mid-run
  win.location.href = 'https://chat.deepseek.com/a/chat/s/new_sid_42';
  R._syncHref();
  const afterUrl = plain(R._live());
  assert.ok(afterUrl, 'live state must NOT be wiped when a new chat receives its session URL');
  assert.equal(afterUrl.steps.length, 1);
  assert.match(afterUrl.key, /^new_sid_42\|/);

  // Complete step 1 and start step 2 when user message has scrolled out of virtual list
  win.__sdRunEvent({ phase: 'end', id: 1, ok: true, output: 'Wrote village/render.py', at: 1800 });
  win.__sdRunEvent({ phase: 'start', id: 2, server: 'sandbox://linux', tool: 'run', call: 'python3 village/render.py', args: { command: 'python3 village/render.py' }, at: 2000 });
  assert.equal(plain(R._live()).steps.length, 2, 'step 2 appends to the same live run even when virtual scroll unmounts user row');
});

test('UX-07: content.js pxe, sdMcpBlocks, sdWireAuto, ict & pct prevent streaming flicker, raw code leaks, and collapsed bubble exposure', () => {
  const ast = acorn.parse(CONTENT_SRC, { ecmaVersion: 'latest' });
  const iife = ast.body.find((n) => n.type === 'ExpressionStatement' && n.end - n.start > 1e6);
  const decls = new Map();
  for (const n of iife.expression.callee.body.body) {
    if (n.type === 'FunctionDeclaration') decls.set(n.id.name, CONTENT_SRC.slice(n.start, n.end));
    else if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) {
        if (d.id.type === 'Identifier' && d.init) decls.set(d.id.name, `${n.kind} ${CONTENT_SRC.slice(d.start, d.end)};`);
      }
    }
  }

  function contentFn(name, extraCtx = {}) {
    const have = new Set([name]);
    let code = decls.get(name);
    assert.ok(code, `content.js symbol missing: ${name}`);
    let fn = null;
    const build = () => {
      const ctx = vm.createContext({
        console,
        JSON, Math, Object, Array, String, Number, Boolean, Date, RegExp, Map, WeakMap, Set, WeakSet,
        NodeFilter: { SHOW_TEXT: 4 },
        Wg: (f) => f(),
        CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
        window: { dispatchEvent: () => true },
        document: {
          documentElement: { getAttribute: () => '1' },
          querySelector: () => null,
          createTreeWalker: () => ({ nextNode: () => null }),
        },
        navigator: { language: 'bn' },
        ...extraCtx,
      });
      ctx.window.document = ctx.document;
      fn = vm.runInContext(`${code};${name}`, ctx);
    };
    build();
    return (...args) => {
      for (let i = 0; i < 200; i++) {
        try {
          return fn(...args);
        } catch (e) {
          const m = /^(\S+) is not defined/.exec(e.message);
          if (!m || !decls.has(m[1]) || have.has(m[1])) throw e;
          have.add(m[1]);
          code = `${decls.get(m[1])}\n${code}`;
          build();
        }
      }
      throw new Error(`could not resolve ${name}`);
    };
  }

  const pxe = contentFn('pxe');

  // 1. Partial streaming prefix (<SDS:AUTO: and <SDS:AUTO:MC) keeps containsControlTags=true (no overlay flicker)
  for (const partial of ['শুরু করছি।\n<SDS:AUTO:', 'শুরু করছি।\n<SDS:AUTO:MC', 'শুরু করছি।\n<SDS:']) {
    const r = plain(pxe(partial));
    assert.equal(r.containsControlTags, true, `partial token must keep overlay alive: ${partial}`);
    assert.equal(r.visibleText.trim(), 'শুরু করছি।', 'partial tag tail must be stripped from visibleText');
  }

  // 2. Streaming unclosed <SDS:AUTO:MCP ... args='{"content":"print(\'frames -> MP4\')...'> emits 1 streaming auto:mcp block & zero raw code
  const streamingCall =
    'দিয়ে চালাই।\n' +
    '<SDS:AUTO:MCP url="sandbox" tool="write_file" args=\'{"path":"/root/workspace/village/render.py","content":"print(\'frames -> MP4\')\\n';
  const rs = plain(pxe(streamingCall));
  assert.equal(rs.containsControlTags, true);
  assert.equal(rs.autoRequests.mcpCalls.length, 0, 'unclosed streaming call must not execute prematurely');
  assert.equal(rs.renderableBlocks.length, 1, 'streaming call must render an in-flight auto:mcp card');
  assert.equal(rs.renderableBlocks[0].name, 'auto:mcp');
  assert.ok(!rs.visibleText.includes('frames -> MP4') && !rs.visibleText.includes('SDS:AUTO'), 'zero raw code leaked into visibleText');

  // 3. Completed mixed args= + body-JSON batch parses both calls and renders both cards
  const mixed =
    '<SDS:AUTO:MCP url="sandbox" tool="write_file" args=\'{"path":"v.py","content":"print(\'a -> b\')"}\'></SDS:AUTO:MCP>\n' +
    '<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"python3 v.py"}</SDS:AUTO:MCP>';
  const rm = plain(pxe(mixed));
  assert.equal(rm.autoRequests.mcpCalls.length, 2);
  assert.deepEqual(rm.autoRequests.mcpCalls[0].args, { path: 'v.py', content: "print('a -> b')" });
  assert.deepEqual(rm.autoRequests.mcpCalls[1].args, { command: 'python3 v.py' });
  assert.equal(rm.renderableBlocks.filter((b) => b.name === 'auto:mcp').length, 2);

  // 4. sdMcpBlocks recovers truncated collapsible [SDS:AUTO_MCP_RESULT] cleanly
  const sdMcpBlocks = contentFn('sdMcpBlocks');
  const truncBlocks = plain(sdMcpBlocks(
    '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox\n[SDS:AUTO_MCP_RESULT]\n' +
    '{"serverName":"sandbox","toolName":"run","call":"cd /root/workspace/village && python3'
  ));
  assert.equal(truncBlocks.length, 1);
  assert.equal(truncBlocks[0].name, 'auto:mcp_result');
  assert.equal(truncBlocks[0].attrs.serverName, 'sandbox');
  assert.equal(truncBlocks[0].attrs.toolName, 'run');

  // 5. sdWireAuto queues multi-KB payload and returns compactcomposer sentinel
  const dispatched = [];
  const sdWireAuto = contentFn('sdWireAuto', {
    window: { dispatchEvent: (ev) => { dispatched.push(ev); return true; } },
  });
  const bigAuto =
    '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox\n[SDS:AUTO_MCP_RESULT]\n' +
    '{"serverName":"sandbox","toolName":"run","content":"' + 'x'.repeat(2000) + '"}\n[/SDS:AUTO_MCP_RESULT]\n</SuperDeepSeek>';
  const compact = sdWireAuto(bigAuto, 'MCP Result');
  assert.match(compact, /^<SuperDeepSeek>\[SDS:AUTO_TURN:[^\]]+\] MCP Result<\/SuperDeepSeek>$/);
  assert.ok(compact.length < 120, 'composer text stays compact (<120 chars)');
  assert.equal(dispatched.length, 1);
  assert.equal(JSON.parse(dispatched[0].detail).payload, bigAuto);

  // 6. ict marks data-bds-auto-user="1", wipes .ds-collapsible-text, re-wipes on React re-render, and pct skips .bds-collapsed-user-message
  const attrs = new Map();
  const classes = new Set();
  const collapsible = { textContent: '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox\n[SDS:AUTO_MCP_RESULT]\n{"serverName":"sandbox"' };
  const msgEl = {
    get textContent() { return collapsible.textContent; },
    set textContent(v) { collapsible.textContent = v; },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) || null,
    hasAttribute: (k) => attrs.has(k),
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    querySelector: (sel) => (sel.includes('ds-collapsible-text') ? collapsible : null),
    querySelectorAll: (sel) => (sel.includes('ds-collapsible-text') ? [collapsible] : []),
  };
  const ict = contentFn('ict', { B: { settings: { systemPromptAutoHide: true } } });
  ict(msgEl);
  assert.equal(attrs.get('data-bds-auto-user'), '1');
  assert.equal(classes.has('bds-hidden-message'), true);
  assert.equal(collapsible.textContent, '');

  // Simulate React re-rendering text back into the same DOM element and removing hidden class
  collapsible.textContent = '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox';
  classes.delete('bds-hidden-message');
  ict(msgEl);
  assert.equal(classes.has('bds-hidden-message'), true, 're-hides even when WeakSet already saw element');
  assert.equal(collapsible.textContent, '', 're-wipes React-restored collapsible text');

  const pct = contentFn('pct', { B: { settings: { collapseLongUserMessages: true } } });
  pct(msgEl);
  assert.equal(classes.has('bds-collapsed-user-message'), false, 'pct never adds display:block!important collapsed class to auto-user bubble');
});
