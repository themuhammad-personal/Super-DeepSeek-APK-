// The engine's native picker path (content.js: Py → _j) with the native blob
// hand-off (sd-native.js). Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bds = path.join(here, '../../main/bds-assets/bds');
const CONTENT = fs.readFileSync(path.join(bds, 'content.js'), 'utf8');
const NATIVE = fs.readFileSync(path.join(bds, 'sd-native.js'), 'utf8');

function slice(from, to) {
  const a = CONTENT.indexOf(from);
  const b = CONTENT.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `engine code moved: ${from}`);
  return CONTENT.slice(a, b);
}

// Tp, the timeouts, $l, Py and _j — self-contained in the bundle.
const PICKER = slice('function Tp(){', 'function Gct(');

function setup(blobs, onPick) {
  const target = new EventTarget();
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Date, Number, Uint8Array,
    Blob, File, URL, CustomEvent, Error,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    crypto: { randomUUID: () => 'id1' },
    navigator: { language: 'en' },
    document: {
      documentElement: { lang: 'en' }, visibilityState: 'visible',
      addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    fetch: async (url) => (url in blobs
      ? { ok: true, status: 200, blob: async () => blobs[url] }
      : { ok: false, status: 404 }),
  };
  ctx.window = ctx;
  ctx.AndroidBridge = {
    releaseBlob() {},
    pickFiles(mode, id) { setTimeout(() => onPick(mode, id, ctx), 0); },
  };
  vm.createContext(ctx);
  vm.runInContext(NATIVE, ctx);
  vm.runInContext(PICKER + ';window.Py=Py;window._j=_j;', ctx);
  return ctx;
}

function deliver(ctx, id, payload) {
  const data = JSON.stringify(payload);
  const name = '__bds_native_files_picked_' + id;
  const chunks = [data.slice(0, 10), data.slice(10)];
  chunks.forEach((c, seq) => ctx.dispatchEvent(new CustomEvent(name, { detail: { v: 2, kind: 'chunk', seq, total: chunks.length, data: c } })));
}

const P = (t) => '/__sd/blob/' + t.padEnd(32, '0');

test('picked blobs arrive as real Files through _j', async () => {
  const blobs = {
    [P('a')]: new Blob(['fn main() {}']),
    [P('b')]: new Blob([new Uint8Array([37, 80, 68, 70])]),
  };
  const ctx = setup(blobs, (mode, id, c) => deliver(c, id, {
    files: [
      { name: 'main.rs', content: '', blob: P('a'), text: true, mime: 'text/plain', size: 12 },
      { name: 'paper.pdf', content: '', encoding: 'base64', blob: P('b'), mime: 'application/pdf', size: 4 },
    ],
    skipped: [{ name: 'huge.iso', reason: 'too-large' }],
  }));
  const res = await ctx.Py('files');
  assert.equal(res.files.length, 2);
  assert.equal(res.skipped.length, 1);
  const f1 = ctx._j(res.files[0]);
  const f2 = ctx._j(res.files[1]);
  assert.equal(f1.name, 'main.rs');
  assert.equal(await f1.text(), 'fn main() {}');
  assert.equal(f2.type, 'application/pdf');
  assert.equal(f2.size, 4);
  assert.equal(res.files[0].content, 'fn main() {}', 'text content is available to folder/project callers');
});

test('old inline payloads still work', async () => {
  const ctx = setup({}, (mode, id, c) => deliver(c, id, {
    files: [
      { name: 'a.txt', content: 'hi' },
      { name: 'b.png', content: Buffer.from([1, 2]).toString('base64'), encoding: 'base64', mime: 'image/png' },
    ],
  }));
  const res = await ctx.Py('files+images');
  const [a, b] = res.files.map((f) => ctx._j(f));
  assert.equal(await a.text(), 'hi');
  assert.equal(b.size, 2);
  assert.equal(b.type, 'image/png');
});

test('cancel resolves as cancelled', async () => {
  const ctx = setup({}, (mode, id, c) => deliver(c, id, { error: 'cancelled' }));
  const res = await ctx.Py('files');
  assert.equal(res.cancelled, true);
});
