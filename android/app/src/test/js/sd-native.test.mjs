// Tests for bds/sd-native.js (the page-side native glue). Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/sd-native.js'), 'utf8');

function load({ blobs = {}, bridge = {} } = {}) {
  const fetched = [];
  const released = [];
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Date, Uint8Array,
    Blob, File, URL,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { language: 'en' },
    document: { documentElement: { lang: 'en' }, querySelector: () => null, querySelectorAll: () => [] },
    location: { pathname: '/', host: 'chat.deepseek.com', search: '' },
    fetch: async (url) => {
      fetched.push(url);
      if (!(url in blobs)) return { ok: false, status: 404 };
      const b = blobs[url];
      return { ok: true, status: 200, blob: async () => b, text: async () => b.text() };
    },
    AndroidBridge: { releaseBlob: (p) => released.push(p), ...bridge },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { win: ctx, fetched, released };
}

const P = (t) => '/__sd/blob/' + t.padEnd(32, '0');

test('resolves text and binary blob entries into Files', async () => {
  const { win, released } = load({
    blobs: {
      [P('a')]: new Blob(['hello π'], { type: 'text/plain' }),
      [P('b')]: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/pdf' }),
    },
  });
  const res = await win.__sdResolvePickedBlobs({
    files: [
      { name: 'src/notes.md', content: '', blob: P('a'), text: true, mime: 'text/plain', size: 8 },
      { name: 'doc.pdf', content: '', encoding: 'base64', blob: P('b'), mime: 'application/pdf', size: 3 },
    ],
    skipped: [],
    folderName: 'x',
  });
  assert.equal(res.files.length, 2);
  assert.equal(res.folderName, 'x');
  const [t, b] = res.files;
  assert.equal(t.content, 'hello π');
  assert.equal(t.encoding, null);
  assert.equal(t.name, 'src/notes.md', 'relative path kept for folder context');
  assert.equal(t.file.name, 'notes.md');
  assert.equal(t.file.type, 'text/plain');
  assert.equal(b.encoding, 'base64', 'binary entries keep their marker');
  assert.equal(b.file.type, 'application/pdf');
  assert.equal(b.file.size, 3);
  assert.equal(b.blob, undefined);
  assert.deepEqual(released.sort(), [P('a'), P('b')].sort());
});

test('unreadable blobs move to skipped instead of failing the pick', async () => {
  const { win } = load({ blobs: { [P('a')]: new Blob(['x']) } });
  const res = await win.__sdResolvePickedBlobs({
    files: [
      { name: 'ok.txt', blob: P('a'), text: true },
      { name: 'gone.txt', blob: P('c'), text: true },
    ],
    skipped: [{ name: 'big.bin', reason: 'too-large' }],
  });
  const plain = (v) => JSON.parse(JSON.stringify(v)); // values from the vm realm
  assert.deepEqual(plain(res.files.map((f) => f.name)), ['ok.txt']);
  assert.deepEqual(plain(res.skipped), [
    { name: 'big.bin', reason: 'too-large' },
    { name: 'gone.txt', reason: 'unreadable' },
  ]);
});

test('legacy inline entries pass through untouched', async () => {
  const { win, fetched } = load();
  const q = { files: [{ name: 'a.txt', content: 'hi' }], skipped: [] };
  assert.equal(await win.__sdResolvePickedBlobs(q), q);
  assert.equal(fetched.length, 0);
});

test('pool keeps order and caps concurrency', async () => {
  const { win } = load();
  let inFlight = 0;
  let peak = 0;
  const out = await win.__sdNative._pool([5, 1, 4, 2, 3, 0, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n * 3));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(Array.from(out), [50, 10, 40, 20, 30, 0, 60, 70]);
  assert.ok(peak <= 3);
});

test('accept matching and text renaming', () => {
  const { win } = load();
  const acc = win.__sdNative._acceptsFile;
  const f = (n, t) => new File(['x'], n, { type: t });
  assert.ok(acc('', f('a.rs', 'text/plain')));
  assert.ok(acc('.pdf,.txt', f('a.TXT', 'text/plain')));
  assert.ok(acc('image/*', f('a.png', 'image/png')));
  assert.ok(!acc('.pdf,.txt', f('a.rs', 'text/plain')));

  const input = { accept: '.pdf,.txt' };
  const renamed = win.__sdAdaptUpload(f('main.rs', 'text/plain'), input);
  assert.equal(renamed.name, 'main.rs.txt');
  assert.equal(renamed.type, 'text/plain');
  const bin = f('x.bin', 'application/octet-stream');
  assert.equal(win.__sdAdaptUpload(bin, input), bin, 'binaries are not disguised');
  const ok = f('a.pdf', 'application/pdf');
  assert.equal(win.__sdAdaptUpload(ok, input), ok);
});

test('bridge fetch: async reply inline and via blob', async () => {
  let calls = [];
  const blobs = { [P('r')]: new Blob([JSON.stringify({ ok: true, html: 'big' })]) };
  const { win } = load({ blobs, bridge: { fetchAsync: (body, id) => calls.push({ body, id }) } });
  const p1 = win.__sdBridgeFetch({ type: 'bds-fetch-url', url: 'https://e.com' });
  const p2 = win.__sdBridgeFetch({ type: 'bds-fetch-url', url: 'https://f.com' });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].body), { type: 'bds-fetch-url', url: 'https://e.com' });
  win.__sdBridgeReply(calls[1].id, null, P('r'));
  win.__sdBridgeReply(calls[0].id, JSON.stringify({ ok: true, status: 200 }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(await p1)), { ok: true, status: 200 });
  assert.deepEqual(JSON.parse(JSON.stringify(await p2)), { ok: true, html: 'big' });
  // Unknown / repeated ids are ignored.
  win.__sdBridgeReply(calls[0].id, '{}', null);
  win.__sdBridgeReply('nope', '{}', null);
});

test('bridge fetch falls back to the blocking call on old native sides', async () => {
  const { win } = load({ bridge: { fetch: (body) => JSON.stringify({ echo: JSON.parse(body).type }) } });
  assert.deepEqual(JSON.parse(JSON.stringify(await win.__sdBridgeFetch({ type: 't' }))), { echo: 't' });
});

test('bridge fetch reports malformed replies', async () => {
  let id;
  const { win } = load({ bridge: { fetchAsync: (_b, i) => { id = i; } } });
  const p = win.__sdBridgeFetch({});
  win.__sdBridgeReply(id, 'not json', null);
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /parse/i);
});

test('loads once per document', () => {
  const { win } = load();
  const first = win.__sdNative;
  vm.runInContext(SRC, win);
  assert.equal(win.__sdNative, first);
});

test('skip messages name the files and the reasons', () => {
  const { win } = load();
  const msg = win.__sdSkipMessage([
    { name: 'dir/big.iso', reason: 'too-large' },
    { name: 'x.bin', reason: 'unreadable' },
  ], 3);
  assert.equal(msg, 'Not attached (2/5): big.iso — over the size limit; x.bin — could not be read');
  const many = win.__sdSkipMessage([1, 2, 3, 4, 5].map((n) => ({ name: n + '.zip', reason: 'weird' })), 0);
  assert.match(many, /^Not attached: 1\.zip — weird; 2\.zip — weird; 3\.zip — weird \(\+2\)$/);
  assert.equal(win.__sdSkipMessage([], 1), '');
});

// ── Keyboard guard ───────────────────────────────────────────────────────────

function loadWithDom() {
  const listeners = {};
  class HTMLElement {
    constructor(tag) { this.tagName = tag; this.nodeType = 1; this.attrs = {}; this.focused = 0; this.lastOpts = null; }
    hasAttribute(n) { return n in this.attrs; }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    removeAttribute(n) { delete this.attrs[n]; }
    closest(sel) { return sel.includes('data-sd-silent-im') ? (this.hasAttribute('data-sd-silent-im') ? this : null) : this; }
    blur() { if (doc.activeElement === this) doc.activeElement = null; }
    focus(opts) { this.focused++; this.lastOpts = opts; doc.activeElement = this; }
  }
  const set = new Set();
  const rootClasses = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  const doc = {
    activeElement: null,
    documentElement: { lang: 'en', classList: rootClasses, appendChild: () => {} },
    head: null,
    createElement: (tag) => ({ tagName: tag }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Date, Uint8Array,
    Blob, File, URL, HTMLElement,
    navigator: { language: 'en' },
    document: doc,
    location: { pathname: '/', host: 'chat.deepseek.com', search: '' },
    AndroidBridge: {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const fire = (type, target, trusted = true, extra = {}) => (listeners[type] || []).forEach((fn) => fn({ type, target, isTrusted: trusted, ...extra }));
  return { win: ctx, HTMLElement, doc, fire };
}

test('a focus() nobody tapped for does not open the keyboard', () => {
  const { HTMLElement } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  box.focus();
  assert.equal(box.focused, 1, 'still focused (the engine needs that to type)');
  assert.equal(box.getAttribute('inputmode'), 'none');
  assert.equal(box.lastOpts.preventScroll, true, 'and the page does not jump');
});

test('after a real touch, focus() behaves normally', () => {
  const { HTMLElement, fire } = loadWithDom();
  const button = new HTMLElement('DIV');
  const box = new HTMLElement('TEXTAREA');
  fire('pointerdown', button);
  box.focus();
  assert.equal(box.getAttribute('inputmode'), null);
});

test('untrusted (scripted) events do not count as a touch', () => {
  const { HTMLElement, fire } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  fire('pointerdown', box, false);
  box.focus();
  assert.equal(box.getAttribute('inputmode'), 'none');
});

test('tapping a silenced field gives the keyboard back and keeps its own inputmode', () => {
  const { HTMLElement, fire, doc } = loadWithDom();
  const box = new HTMLElement('INPUT');
  box.type = 'text';
  box.setAttribute('inputmode', 'numeric');
  box.focus();
  assert.equal(box.getAttribute('inputmode'), 'none');
  fire('pointerdown', box);
  assert.equal(box.getAttribute('inputmode'), 'numeric');
  fire('click', box);
  assert.equal(doc.activeElement, box);
  assert.equal(box.focused, 2, 're-focused inside the tap so the keyboard shows');
});

test('leaving a silenced field restores it', () => {
  const { HTMLElement, fire } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  box.focus();
  fire('focusout', box);
  assert.equal(box.getAttribute('inputmode'), null);
  assert.equal(box.hasAttribute('data-sd-silent-im'), false);
});

test('buttons and read-only fields are not touched', () => {
  const { HTMLElement, win } = loadWithDom();
  const button = new HTMLElement('BUTTON');
  button.focus();
  assert.equal(button.getAttribute('inputmode'), null);
  const ro = new HTMLElement('TEXTAREA');
  ro.readOnly = true;
  assert.equal(win.__sdNative._isTextField(ro), false);
  const check = new HTMLElement('INPUT');
  check.type = 'checkbox';
  assert.equal(win.__sdNative._isTextField(check), false);
});

test('allowKeyboard() lets the next focus open the keyboard', () => {
  const { HTMLElement, win } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  win.__sdNative.allowKeyboard();
  box.focus();
  assert.equal(box.getAttribute('inputmode'), null);
});

test('typing in the composer shows the text again even while an engine send retries', () => {
  const { HTMLElement, doc, fire } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  doc.documentElement.classList.add('sd-auto-send');
  fire('keydown', box, false);
  assert.equal(doc.documentElement.classList.contains('sd-auto-send'), true, 'scripted keys do not count');
  fire('keydown', box);
  assert.equal(doc.documentElement.classList.contains('sd-auto-send'), false);
});

// ── Keyboard hides after every send ──────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('sending (tap on send, composer empties) closes the keyboard, every time', async () => {
  const { HTMLElement, fire, doc } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  const send = new HTMLElement('DIV');
  box.contains = (n) => n === box;
  for (let round = 1; round <= 3; round++) {
    fire('pointerdown', box);
    box.focus();
    box.value = 'message ' + round;
    assert.equal(box.getAttribute('inputmode'), null, 'the tapped field has its keyboard');
    fire('pointerdown', send);
    box.value = ''; // the page sent it
    await wait(120);
    assert.equal(doc.activeElement, null, `round ${round}: field blurred, keyboard gone`);
    // The page focuses the composer again after sending: silently.
    box.focus();
    assert.equal(box.getAttribute('inputmode'), 'none', `round ${round}: refocus keeps the keyboard closed`);
    fire('focusout', box);
    doc.activeElement = null;
  }
});

test('a tap elsewhere that sends nothing leaves the keyboard alone', async () => {
  const { HTMLElement, fire, doc } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  const other = new HTMLElement('DIV');
  box.contains = (n) => n === box;
  fire('pointerdown', box);
  box.focus();
  box.value = 'draft';
  fire('pointerdown', other);
  await wait(120);
  assert.equal(doc.activeElement, box);
});

test('going straight back into the field after sending keeps its keyboard', async () => {
  const { HTMLElement, fire, doc } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  const send = new HTMLElement('DIV');
  box.contains = (n) => n === box;
  fire('pointerdown', box);
  box.focus();
  box.value = 'hi';
  fire('pointerdown', send);
  fire('pointerdown', box); // before the poll noticed the send
  box.value = '';
  await wait(120);
  assert.equal(doc.activeElement, box);
});

test('Enter that sends closes the keyboard; Shift+Enter does not', async () => {
  const { HTMLElement, fire, doc } = loadWithDom();
  const box = new HTMLElement('TEXTAREA');
  box.contains = (n) => n === box;
  fire('pointerdown', box);
  box.focus();
  box.value = 'line';
  fire('keydown', box, true, { key: 'Enter', shiftKey: true });
  box.value = 'line\n';
  await wait(120);
  assert.equal(doc.activeElement, box, 'a new line, not a send');
  fire('keydown', box, true, { key: 'Enter' });
  box.value = '';
  await wait(120);
  assert.equal(doc.activeElement, null);
});

// ── Mixed Arabic + Bengali direction ─────────────────────────────────────────

test('a paragraph is right-to-left only when it starts in Arabic and is mostly Arabic', () => {
  const { win } = load();
  const dir = win.__sdNative._scriptDir;
  assert.equal(dir('hello world'), '');
  assert.equal(dir('আমি ভাত খাই'), '');
  assert.equal(dir('قُلْ هُوَ اللَّهُ أَحَدٌ'), 'rtl');
  assert.equal(dir('الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ (সূরা ফাতিহা, আয়াত ২)'), 'rtl');
  // Opens with an Arabic phrase, goes on in Bengali: a Bengali sentence.
  assert.equal(dir('بِسْمِ اللَّهِ — এর অর্থ হলো (পরম করুণাময় আল্লাহর নামে) শুরু করছি।'), 'ltr');
  // Bengali label before an Arabic verse.
  assert.equal(dir('আয়াত: (قُلْ هُوَ اللَّهُ أَحَدٌ) — [১১২:১]'), 'ltr');
  // Bengali vowel signs are marks: words are counted, not letters.
  assert.equal(dir('দোয়াটি কী (رَبِّ زِدْنِي عِلْمًا) এর অর্থ?'), 'ltr');
});
