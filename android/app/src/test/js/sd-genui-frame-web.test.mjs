// Web access from visuals: the host-side broker (concurrency, queueing) and the
// frame-side fetch runtime (Request objects, bodies). The consent sheet itself is
// covered by the Playwright acceptance check 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/sd-genui-frame.js'), 'utf8');

function load({ granted = [] } = {}) {
  const store = { sd_fetch_grants_v1: JSON.stringify(Object.fromEntries(granted.map((h) => [h, 1]))) };
  const win = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: { language: 'en' },
    URL, Promise, Date, JSON, Object, Array, String, Number, Math, Error, TypeError, setTimeout, clearTimeout,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  return win;
}

const tick = () => new Promise((r) => setImmediate(r));

test('web broker: at most 6 requests run at once; the rest wait their turn instead of failing', async () => {
  const win = load({ granted: ['api.example.com'] });
  const calls = [], release = [];
  win.__sdBridgeFetch = (p) => { calls.push(p); return new Promise((ok) => release.push(() => ok({ ok: true, status: 200, text: 'x' }))); };
  const replies = [];
  const ctrl = { post: (m) => replies.push(m), opts: {} };
  for (let i = 0; i < 10; i++) win.__sdGenUIFrame.web.request(ctrl, { id: 'r' + i, url: 'https://api.example.com/item/' + i, method: 'GET' });
  await tick(); await tick();
  assert.equal(calls.length, 6, 'only 6 in flight');
  assert.equal(replies.length, 0, 'nobody failed');
  release.shift()(); await tick(); await tick(); await tick();
  assert.equal(calls.length, 7, 'a finished request lets the next one start');
  while (release.length) { release.shift()(); await tick(); await tick(); await tick(); }
  assert.equal(calls.length, 10);
  assert.equal(replies.length, 10);
  assert.ok(replies.every((r) => r.ok && r.status === 200));
});

test('web broker: a burst beyond the open-request cap is refused, not queued forever', async () => {
  const win = load({ granted: ['api.example.com'] });
  win.__sdBridgeFetch = () => new Promise(() => {});
  const replies = [];
  const ctrl = { post: (m) => replies.push(m), opts: {} };
  for (let i = 0; i < 40; i++) win.__sdGenUIFrame.web.request(ctrl, { id: 'b' + i, url: 'https://api.example.com/' + i });
  await tick(); await tick();
  assert.equal(replies.length, 8);
  assert.ok(replies.every((r) => /Too many requests/.test(r.error)));
});

test('web broker: private hosts never reach the bridge', async () => {
  const win = load({ granted: [] });
  let called = 0; win.__sdBridgeFetch = () => { called++; return Promise.resolve({ ok: true }); };
  const replies = [];
  const ctrl = { post: (m) => replies.push(m), opts: {} };
  for (const u of ['http://localhost/x', 'http://192.168.1.1/', 'http://10.0.0.5/', 'http://printer.local/', 'https://example.com:22/']) {
    win.__sdGenUIFrame.web.request(ctrl, { id: 'p' + replies.length, url: u });
  }
  await tick();
  assert.equal(called, 0);
  assert.equal(replies.length, 5);
});

function runtime() {
  const posted = [];
  const win = { addEventListener() {}, document: { baseURI: 'about:srcdoc' }, fetch: () => Promise.reject(new Error('native fetch must not be used')) };
  const ctx = { window: win, document: win.document, URL, Headers, Request, Response, FormData, Blob, URLSearchParams, ArrayBuffer, Uint8Array, atob, FileReader: class {}, Promise, JSON, String, Object, TypeError };
  vm.createContext(ctx);
  const frame = load();
  const net = vm.runInContext('(' + frame.__sdGenUIFrame._fetchRuntime.toString() + ')', ctx)((m) => posted.push(m), ['https://cdn.jsdelivr.net']);
  return { win, net, posted };
}

test('frame fetch: a Request object keeps its method, headers and body', async () => {
  const { win, net, posted } = runtime();
  const p = win.fetch(new Request('https://api.example.com/v1/items', { method: 'POST', headers: { 'x-api-key': 'k' }, body: '{"a":1}' }));
  await tick(); await tick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].method, 'POST');
  assert.equal(posted[0].body, '{"a":1}');
  assert.equal(posted[0].headers['x-api-key'], 'k');
  net.resolve({ id: posted[0].id, ok: true, status: 201, text: 'done', contentType: 'text/plain' });
  const r = await p;
  assert.equal(r.status, 201);
  assert.equal(await r.text(), 'done');
});

test('frame fetch: FormData and URLSearchParams bodies are encoded like the browser would', async () => {
  const { win, posted } = runtime();
  const fd = new FormData(); fd.append('q', 'quran'); fd.append('page', '2');
  win.fetch('https://api.example.com/search', { method: 'POST', body: fd });
  win.sdFetch('https://api.example.com/form', { method: 'POST', body: new URLSearchParams({ a: '1', b: 'x y' }) });
  await tick(); await tick(); await tick();
  assert.equal(posted.length, 2);
  const multi = posted.find((m) => m.url.endsWith('/search'));
  assert.match(multi.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(multi.body, /name="q"\r\n\r\nquran/);
  const form = posted.find((m) => m.url.endsWith('/form'));
  assert.equal(form.body, 'a=1&b=x+y');
  assert.match(form.headers['content-type'], /application\/x-www-form-urlencoded/);
});

test('frame fetch: CDN URLs still use the frame\'s own fetch', async () => {
  const { win, posted } = runtime();
  await assert.rejects(win.fetch('https://cdn.jsdelivr.net/npm/x.js'), /native fetch must not be used/);
  assert.equal(posted.length, 0);
});
