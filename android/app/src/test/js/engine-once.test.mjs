// Tool calls in content.js run exactly once. A reply's calls run only when the
// chat is live in this page, the reply is really the newest message, and the
// same call of the same message was not handled before (by content, across
// re-created elements and reloads). Before, opening an old chat, reloading,
// or DeepSeek re-creating a message element ran finished work again.
// Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/content.js'), 'utf8');

function slice(from, to) {
  const a = CONTENT.indexOf(from);
  const b = CONTENT.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `engine code moved: ${from}`);
  return CONTENT.slice(a, b);
}

const HELPERS = slice('var sdGen=!1,sdLiveSessions=new Set', 'window.__sdEngine=Object.assign(');
const T6 = slice('function T6(e){', 'const xwe=');
const GHE = slice('function Ghe(e,t=-1,n=null,r=null){', 'function Wlt(e){');

/** The helpers with a fake page: a message list, a stop button and storage. */
function setup({ storage = new Map(), href = 'https://chat.deepseek.com/a/chat/s/abc' } = {}) {
  const page = { generating: false, href, texts: new Map(), roles: new Map(), below: 0, now: 1_000_000 };
  const listeners = {};
  const ctx = {
    console, JSON, Math, String, Array, Set,
    Date: { now: () => page.now },
    window: {},
    location: { get href() { return page.href; } },
    setInterval: () => 1,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
    },
    Wu: () => page.generating,
    eF: () => { const m = page.href.match(/\/chat\/s\/([^/]+)/); return m ? m[1] : 'default'; },
    W_: (n) => page.roles.get(n) || 'assistant',
    Kwe: (n) => ({ plain: page.texts.get(n) || '', rich: '' }),
    getComputedStyle: (n) => ({ overflowY: n.scroller ? 'auto' : 'visible' }),
    document: {
      body: { tag: 'body' }, documentElement: { tag: 'html' },
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${T6}\n${HELPERS}\nthis.api={sdLiveTick,sdMayAuto,sdSeen,sdMsgKey,sdAtEnd,live:sdLiveSessions};`, ctx);
  // A scroll container with the message list inside.
  const scroller = { scroller: true, scrollHeight: 5000, clientHeight: 700, scrollTop: 0, parentElement: ctx.document.body,
    getBoundingClientRect: () => ({ top: 0 }) };
  const msg = (role, text) => {
    const n = { parentElement: scroller, getBoundingClientRect: () => ({ bottom: 5000 - page.below }) };
    page.roles.set(n, role);
    page.texts.set(n, text);
    return n;
  };
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn({ type, ...ev }));
  return { api: ctx.api, page, msg, storage, ctx, fire };
}

test('Ghe asks the gate before any automatic request and checks every kind of call', () => {
  assert.ok(GHE.includes('if(u&&_&&(sdGen=Wu(),sdGen||sdMayAuto(e,t,n)))if(!sdGen){const sdM=sdMsgKey(a,t,n);'));
  for (const kind of ['web', 'github', 'twitter', 'youtube', 'search', 'mcp', 'file', 'dirsearch', 'dirlist']) {
    assert.ok(GHE.includes(`sdSeen(sdM,"${kind}",`), `${kind} calls are remembered`);
  }
  // Every "not handled yet" check of the auto requests goes through sdSeen.
  const checks = GHE.match(/c\.auto\w+Handled\.has\((\w)\)\|\|/g) || [];
  assert.equal(checks.length, 9);
  assert.equal((GHE.match(/\.has\(\w\)\|\|sdSeen\(sdM,/g) || []).length, 9);
});

test('an old chat never runs its last calls; a chat becomes live once a reply is generated in it', () => {
  const { api, page, msg } = setup();
  const n = [msg('user', 'build it'), msg('assistant', 'Starting <SDS:AUTO:MCP …>')];
  assert.equal(api.sdMayAuto(n[1], 1, n), false, 'opened, nothing generated here');
  page.generating = true;
  api.sdLiveTick();
  page.generating = false;
  assert.equal(api.sdMayAuto(n[1], 1, n), true);
  // Another chat is not live because this one is.
  page.href = 'https://chat.deepseek.com/a/chat/s/other';
  assert.equal(api.sdMayAuto(n[1], 1, n), false);
});

test("the user's own send makes the chat live too (even if the stop button is not recognised)", () => {
  const { api, page, msg, fire } = setup();
  const n = [msg('user', 'go'), msg('assistant', 'b <SDS…>')];
  const composer = { closest: (sel) => (sel.includes('#bds-root') ? null : sel.includes('textarea') ? {} : null) };
  // Automatic sends (untrusted events) and Shift+Enter do not count.
  fire('keydown', { isTrusted: false, key: 'Enter', target: composer });
  fire('keydown', { isTrusted: true, key: 'Enter', shiftKey: true, target: composer });
  api.sdLiveTick();
  assert.equal(api.sdMayAuto(n[1], 1, n), false);
  fire('keydown', { isTrusted: true, key: 'Enter', target: composer });
  page.now += 5000;
  api.sdLiveTick();
  assert.equal(api.sdMayAuto(n[1], 1, n), true);
  // A tap on the send button works the same; the window closes after 30 s.
  const other = setup();
  const m = [other.msg('user', 'go'), other.msg('assistant', 'b')];
  const send = { querySelector: (sel) => (sel === '.ds-icon-send' ? {} : null) };
  other.fire('click', { isTrusted: true, target: { closest: (sel) => (sel.includes('#bds-root') ? null : send) } });
  other.page.now += 31000;
  other.api.sdLiveTick();
  assert.equal(other.api.sdMayAuto(m[1], 1, m), false);
});

test('a reply followed by a user message (its results) never runs again', () => {
  const { api, page, msg } = setup();
  page.generating = true; api.sdLiveTick(); page.generating = false;
  const n = [msg('user', 'a'), msg('assistant', 'b <SDS…>'), msg('user', '[SDS:AUTO] MCP Result …')];
  assert.equal(api.sdMayAuto(n[1], 1, n), false);
  const m = [msg('user', 'a'), msg('assistant', 'b <SDS…>'), msg('assistant', 'c')];
  assert.equal(api.sdMayAuto(m[1], 1, m), true, 'only a user message blocks');
});

test('an older reply that is merely the last rendered element (virtualised list) does not run', () => {
  const { api, page, msg } = setup();
  page.generating = true; api.sdLiveTick(); page.generating = false;
  const n = [msg('user', 'a'), msg('assistant', 'b')];
  page.below = 300;                                   // composer padding below the real last message
  assert.equal(api.sdAtEnd(n[1]), true);
  assert.equal(api.sdMayAuto(n[1], 1, n), true);
  page.below = 4000;                                  // a spacer standing in for newer messages
  assert.equal(api.sdAtEnd(n[1]), false);
  assert.equal(api.sdMayAuto(n[1], 1, n), false);
});

test('a call of a message is handled once, by content: re-created elements and reloads do not repeat it', () => {
  const storage = new Map();
  const first = setup({ storage });
  const n = [first.msg('user', '[results of step 1]'), first.msg('assistant', 'Running tests <SDS:AUTO:MCP run npm test>')];
  const key = first.api.sdMsgKey('Running tests <SDS:AUTO:MCP run npm test>', 1, n);
  const call = 'sandbox|run|{"command":"npm test"}';
  assert.equal(first.api.sdSeen(key, 'mcp', call), false, 'first time: run it');
  assert.equal(first.api.sdSeen(key, 'mcp', call), true, 'same element again');
  // DeepSeek re-creates both elements with the same content.
  const again = [first.msg('user', '[results of step 1]'), first.msg('assistant', 'Running tests <SDS:AUTO:MCP run npm test>')];
  assert.equal(first.api.sdSeen(first.api.sdMsgKey('Running tests <SDS:AUTO:MCP run npm test>', 1, again), 'mcp', call), true);
  // The page reloads (renderer restart): remembered in storage.
  const second = setup({ storage });
  const n2 = [second.msg('user', '[results of step 1]'), second.msg('assistant', 'Running tests <SDS:AUTO:MCP run npm test>')];
  assert.equal(second.api.sdSeen(second.api.sdMsgKey('Running tests <SDS:AUTO:MCP run npm test>', 1, n2), 'mcp', call), true);
  // Other kinds of request and other calls of the same message are separate.
  assert.equal(second.api.sdSeen(key, 'web', call), false);
  assert.equal(second.api.sdSeen(key, 'mcp', 'sandbox|run|{"command":"ls"}'), false);
});

test('the same reply text in a new turn (after different results) runs again', () => {
  const { api, msg } = setup();
  const text = '<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"npm test"}</SDS:AUTO:MCP>';
  const t1 = [msg('user', 'results: 2 failing'), msg('assistant', text)];
  const t2 = [msg('user', 'results: file written'), msg('assistant', text)];
  const call = 'sandbox|run|{"command":"npm test"}';
  assert.equal(api.sdSeen(api.sdMsgKey(text, 1, t1), 'mcp', call), false);
  assert.equal(api.sdSeen(api.sdMsgKey(text, 1, t2), 'mcp', call), false);
  // Chats are separate too.
  assert.notEqual(api.sdMsgKey(text, 1, t1), (() => { const o = setup({ href: 'https://chat.deepseek.com/a/chat/s/zzz' }); return o.api.sdMsgKey(text, 1, [o.msg('user', 'results: 2 failing'), o.msg('assistant', text)]); })());
});

test('the memory is bounded and survives broken storage', () => {
  const storage = new Map();
  const { api } = setup({ storage });
  for (let i = 0; i < 450; i++) api.sdSeen('m', 'mcp', 'call ' + i);
  const saved = JSON.parse(storage.get('sd_auto_done'));
  assert.equal(saved.length, 400);
  assert.equal(api.sdSeen('m', 'mcp', 'call 449'), true);
  // Garbage in storage: start empty, never throw.
  const bad = setup({ storage: new Map([['sd_auto_done', '{not json']]) });
  assert.equal(bad.api.sdSeen('m', 'mcp', 'x'), false);
  assert.equal(bad.api.sdSeen('m', 'mcp', 'x'), true);
  // Storage that throws (quota, privacy mode): still once per page.
  const o = setup();
  o.ctx.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(o.api.sdSeen('q', 'mcp', 'y'), false);
  assert.equal(o.api.sdSeen('q', 'mcp', 'y'), true);
});
