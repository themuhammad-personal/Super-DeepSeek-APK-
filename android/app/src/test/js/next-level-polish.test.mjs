// Regression & feature tests for the 5 Next-Level Native Polish deliverables:
// 1. Rich Agent Run Card unified diffs (+N/-M), live step timer & sandbox output quick-actions (sd-run.js)
// 2. Live Foreground Notification bridge status & Haptics preference toggle (sd-agent.js)
// 3. Tactile rate-limited haptics & Offline connectivity guard banner (sd-native.js)
// 4. Device-side PDF text/FlateDecode, WAV/MP4 media headers & PNG/JPEG image inspection (sd-files.js)
// 5. Native bds-inspect-media bridge merge + OCR summary & invalid-stub safety (sd-files.js)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BDS = path.join(here, '../../main/bds-assets/bds');
const SRC_RUN = fs.readFileSync(path.join(BDS, 'sd-run.js'), 'utf8');
const SRC_AGENT = fs.readFileSync(path.join(BDS, 'sd-agent.js'), 'utf8');
const SRC_NATIVE = fs.readFileSync(path.join(BDS, 'sd-native.js'), 'utf8');
const SRC_FILES = fs.readFileSync(path.join(BDS, 'sd-files.js'), 'utf8');

const plain = (v) => JSON.parse(JSON.stringify(v));

function makeEl(tag, doc) {
  const classes = new Set();
  const el = {
    tagName: String(tag || 'DIV').toUpperCase(),
    id: '',
    _className: '',
    _text: '',
    innerHTML: '',
    hidden: false,
    isConnected: true,
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    get className() { return this._className; },
    set className(v) {
      this._className = String(v || '');
      classes.clear();
      this._className.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent || '').join('');
    },
    set textContent(v) {
      this._text = String(v == null ? '' : v);
      this.children = [];
    },
    get lastChild() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
    classList: {
      add(...cs) { cs.forEach((c) => classes.add(c)); el._className = [...classes].join(' '); },
      remove(...cs) { cs.forEach((c) => classes.delete(c)); el._className = [...classes].join(' '); },
      toggle(c, force) {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        el._className = [...classes].join(' ');
        return on;
      },
      contains(c) { return classes.has(c); },
    },
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    querySelector(sel) {
      const match = (node) => {
        if (sel.startsWith('#')) return node.id === sel.slice(1);
        return node.tagName === String(sel).toUpperCase();
      };
      for (const c of this.children) {
        if (match(c)) return c;
        const sub = c.querySelector && c.querySelector(sel);
        if (sub) return sub;
      }
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    contains(target) {
      if (target === this) return true;
      return this.children.some((c) => c === target || (c.contains && c.contains(target)));
    },
  };
  el.ownerDocument = doc;
  return el;
}

function fastTimeout(fn, ms, ...a) {
  return setTimeout(fn, Math.min(Math.floor((ms || 0) / 50), 10), ...a);
}
function unrefInterval(fn, ms, ...a) {
  const h = setInterval(fn, ms, ...a);
  if (h && typeof h.unref === 'function') h.unref();
  return h;
}

function loadRunAndAgent({ lang = 'en' } = {}) {
  const storage = {};
  const statusCalls = [];
  const activeCalls = [];
  const ctx = {
    console, clearTimeout, clearInterval, Promise, JSON, Math, Object, Array, String, Number, Date, WeakMap, Set,
    Uint8Array, TextDecoder, CustomEvent, isFinite,
    setTimeout: fastTimeout,
    setInterval: unrefInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { language: lang },
    location: { href: 'https://chat.deepseek.com/a/chat/s/polish1' },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    document: {
      documentElement: { lang, classList: { toggle() {}, remove() {}, add() {} } },
      body: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    AndroidBridge: {
      sandboxInfo: () => JSON.stringify({ supported: true, enabled: true, mode: 'auto' }),
      sandboxAgentStatus: (active, step, label) => statusCalls.push({ active, step, label }),
      sandboxAgentActive: (active) => activeCalls.push(active),
      getStorage: (k) => (k in storage ? storage[k] : null),
      setStorage: (k, v) => { storage[k] = String(v); },
    },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  };
  ctx.window = ctx;
  ctx.__sdBridgeFetch = async () => ({ ok: true, result: { content: [] } });
  vm.createContext(ctx);
  vm.runInContext(SRC_AGENT, ctx);
  vm.runInContext(SRC_RUN, ctx);
  return { win: ctx, R: ctx.__sdRun, A: ctx.__sdAgent, statusCalls, activeCalls, storage };
}

test('NL-01: sd-run computes unified diff hunks and +N/-M stats while ignoring /tmp/sd-out scratch paths', () => {
  const { R } = loadRunAndAgent();
  const editDiff = plain(R._stepDiffStats('edit_file', {
    path: '/root/workspace/app.py',
    old_text: 'fps = 15\nwidth = 640\nheight = 360\n',
    new_text: 'fps = 30\nwidth = 1280\nheight = 720\ncodec = "libx264"\n',
  }));
  assert.equal(editDiff.kind, 'edit');
  assert.equal(editDiff.path, '/root/workspace/app.py');
  assert.equal(editDiff.added, 4);
  assert.equal(editDiff.removed, 3);
  assert.ok(editDiff.lines.some((l) => l.t === 'add' && l.s.includes('codec = "libx264"')));
  assert.ok(editDiff.lines.some((l) => l.t === 'del' && l.s.includes('fps = 15')));

  const writeDiff = plain(R._stepDiffStats('write_file', {
    path: '/root/workspace/hello.sh',
    content: '#!/bin/sh\necho "hello"\n',
  }));
  assert.equal(writeDiff.kind, 'write');
  assert.equal(writeDiff.added, 2);
  assert.equal(writeDiff.removed, 0);

  const scratch = R._stepDiffStats('write_file', {
    path: '/tmp/sd-out/step-1.log',
    content: 'ignored internal output\n',
  });
  assert.equal(scratch, null);
});

test('NL-02: sd-run detects generated sandbox media/server URLs and renders quick-actions + live step timer', () => {
  const { R } = loadRunAndAgent();
  const step1 = {
    tool: 'edit_file',
    server: 'sandbox://linux',
    call: '/root/workspace/render.py (edit)',
    args: { path: '/root/workspace/render.py', old_text: 'a\n', new_text: 'b\nc\n' },
    diff: R._stepDiffStats('edit_file', { path: '/root/workspace/render.py', old_text: 'a\n', new_text: 'b\nc\n' }),
    ok: true,
    t0: Date.now() - 5000,
    t1: Date.now() - 3000,
    output: 'Edited /root/workspace/render.py',
  };
  const step2 = {
    tool: 'run',
    server: 'sandbox://linux',
    call: 'python3 render.py && python3 -m http.server 8080',
    args: { command: 'python3 render.py -o /root/workspace/village.mp4' },
    ok: true,
    t0: Date.now() - 3000,
    t1: Date.now() - 500,
    output: 'Saved /root/workspace/village.mp4 (420 KB)\nServing HTTP on http://127.0.0.1:8080/index.html',
  };
  step2.outs = plain(R._detectStepOutputs(step2));
  assert.ok(step2.outs.some((o) => o.kind === 'file' && o.path === '/root/workspace/village.mp4' && o.previewable === true));
  assert.ok(step2.outs.some((o) => o.kind === 'url' && o.url === 'http://127.0.0.1:8080/index.html'));

  const doneCard = R._cardHtml({
    running: false,
    stopped: false,
    count: 2,
    failed: 0,
    t0: Date.now() - 8000,
    t1: Date.now(),
    steps: [step1, step2],
  });
  assert.equal(doneCard.state, 'done');
  assert.match(doneCard.html, /sd-run-ds/);
  assert.match(doneCard.html, /\+2/);
  assert.match(doneCard.html, /-1/);
  assert.match(doneCard.html, /data-act="preview-file"[^>]*data-path="\/root\/workspace\/village\.mp4"/);
  assert.match(doneCard.html, /data-act="export-file"[^>]*data-path="\/root\/workspace\/village\.mp4"/);
  assert.match(doneCard.html, /data-act="studio"/);

  const liveStep = {
    tool: 'run',
    server: 'sandbox://linux',
    call: 'ffmpeg -i frames/%03d.png village.mp4',
    t0: Date.now() - 12000,
    t1: 0,
    ok: null,
  };
  const runningCard = R._cardHtml({
    running: true,
    stopped: false,
    count: 2,
    failed: 0,
    t0: Date.now() - 15000,
    t1: 0,
    steps: [step1, liveStep],
  });
  assert.equal(runningCard.state, 'running');
  assert.match(runningCard.html, /<em>1[123]s<\/em>/);
});

test('NL-03: sd-agent reports live step + label to AndroidBridge.sandboxAgentStatus and exposes Haptic toggle', async () => {
  const { win, A, statusCalls } = loadRunAndAgent();
  assert.ok(statusCalls.some((s) => s.active === false && s.step === 0));

  // Trigger a live sandbox tool call through the wrapped __sdBridgeFetch and verify step 1 status is reported.
  await win.__sdBridgeFetch({
    type: 'bds-mcp-call',
    serverUrl: 'sandbox://linux',
    apiKey: '',
    toolName: 'run',
    args: { command: 'pytest -q' },
  });
  assert.ok(statusCalls.some((s) => s.active === true && s.step === 1 && String(s.label).includes('pytest -q')));

  // Mount the Linux & Agent settings page and verify the Haptic feedback switch row is rendered.
  win.document.createElement = (tag) => makeEl(tag, win.document);
  win.document.head = makeEl('head', win.document);
  win.document.getElementById = () => null;
  const host = makeEl('div', win.document);
  A.mountSettings(host);
  host.isConnected = false; // allows page.timer cleanup if it ticks

  const allNodes = [];
  const walk = (n) => { allNodes.push(n); (n.children || []).forEach(walk); };
  walk(host);
  const hapticRow = allNodes.find((n) => n.getAttribute && n.getAttribute('data-sd-key') === 'sd_haptics_enabled');
  assert.ok(hapticRow, 'Haptic feedback row should be mounted with data-sd-key="sd_haptics_enabled"');
  assert.match(hapticRow.textContent, /Haptic feedback/);
});

test('NL-04: sd-native rate-limits window.__sdHaptic, honors sd_haptics_enabled=0, and toggles #sd-net-pill offline banner', () => {
  const haptics = [];
  const storage = {};
  const doc = {
    documentElement: { lang: 'en', classList: { toggle() {}, add() {}, remove() {} } },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById(id) {
      return this.body ? this.body.querySelector('#' + id) : null;
    },
  };
  doc.createElement = (tag) => makeEl(tag, doc);
  doc.head = makeEl('head', doc);
  doc.body = makeEl('body', doc);

  const ctx = {
    console, Promise, JSON, Math, Object, Array, String, Date, Uint8Array,
    setTimeout: fastTimeout, clearTimeout,
    Blob, File, URL,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { language: 'en', onLine: true },
    document: doc,
    location: { pathname: '/', host: 'chat.deepseek.com', search: '' },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    AndroidBridge: {
      performHaptic: (kind) => haptics.push(kind),
      getStorage: (k) => (k in storage ? storage[k] : null),
      releaseBlob() {},
    },
    addEventListener() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC_NATIVE, ctx);

  assert.equal(ctx.__sdHaptic('tick'), true);
  assert.equal(ctx.__sdHaptic('tick'), false, 'second immediate call within 45ms should be rate-limited');
  assert.deepEqual(haptics, ['tick']);

  storage.sd_haptics_enabled = '0';
  assert.equal(ctx.__sdHaptic('heavy'), false, 'disabled preference mutes haptics');
  assert.deepEqual(haptics, ['tick']);

  ctx.__sdNative._setOnlineState(false);
  const pill = doc.getElementById('sd-net-pill');
  assert.ok(pill, '#sd-net-pill banner should be mounted when offline');
  assert.equal(pill.hidden, false);
  assert.equal(pill.getAttribute('data-show'), '1');
  assert.match(pill.textContent, /Offline/i);

  ctx.__sdNative._setOnlineState(true);
  assert.equal(pill.hidden, true);
  assert.equal(pill.getAttribute('data-show'), '0');
});

function buildWavFixture({ sampleRate = 16000, channels = 2, bitsPerSample = 16, seconds = 2 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const dataSize = byteRate * seconds;
  const buf = Buffer.alloc(44 + 64); // header + small sample slice while declaring data chunk size
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return new Uint8Array(buf);
}

function buildMp4Fixture({ width = 1280, height = 720, timescale = 1000, duration = 5400 } = {}) {
  const ftyp = Buffer.alloc(20);
  ftyp.writeUInt32BE(20, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('mp42', 8, 'ascii');

  const mvhd = Buffer.alloc(8 + 24);
  mvhd.writeUInt32BE(mvhd.length, 0);
  mvhd.write('mvhd', 4, 'ascii');
  mvhd[8] = 0; // version 0
  mvhd.writeUInt32BE(timescale, 8 + 12);
  mvhd.writeUInt32BE(duration, 8 + 16);

  const tkhd = Buffer.alloc(8 + 84);
  tkhd.writeUInt32BE(tkhd.length, 0);
  tkhd.write('tkhd', 4, 'ascii');
  tkhd[8] = 0; // version 0
  tkhd.writeUInt32BE(width << 16, 8 + 76);
  tkhd.writeUInt32BE(height << 16, 8 + 80);

  const trak = Buffer.alloc(8 + tkhd.length);
  trak.writeUInt32BE(trak.length, 0);
  trak.write('trak', 4, 'ascii');
  tkhd.copy(trak, 8);

  const moov = Buffer.alloc(8 + mvhd.length + trak.length);
  moov.writeUInt32BE(moov.length, 0);
  moov.write('moov', 4, 'ascii');
  mvhd.copy(moov, 8);
  trak.copy(moov, 8 + mvhd.length);

  return new Uint8Array(Buffer.concat([ftyp, moov]));
}

test('NL-05: sd-files extracts PDF FlateDecode streams, WAV/MP4 binary metadata, and PNG/JPEG dimensions on device', async () => {
  const win = {
    TextDecoder, Blob, File, Response, DecompressionStream, Uint8Array, Promise, Event,
    console, setTimeout,
    document: { documentElement: { lang: 'en' }, addEventListener() {} },
    navigator: { language: 'en' },
    __sdNative: { _acceptsFile: () => false },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC_FILES, win);
  const F = win.__sdFiles;

  // 1. PDF with FlateDecode stream
  const contentStream = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 712 Td (Super DeepSeek PDF Layer) Tj T* [(Fast ) -20 (Offline )] TJ ET', 'latin1'));
  const pdfHead = Buffer.from(
    '%PDF-1.7\n1 0 obj << /Type /Pages /Count 3 >> endobj\n2 0 obj << /Title (Quarterly Spec) /Author (Rafi) >> endobj\n3 0 obj << /Filter /FlateDecode /Length ' +
    contentStream.length + ' >>\nstream\n',
    'latin1'
  );
  const pdfTail = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1');
  const pdfBytes = new Uint8Array(Buffer.concat([pdfHead, contentStream, pdfTail]));
  const pdfOut = await F._extractPdf(pdfBytes, 'spec.pdf');
  assert.equal(pdfOut.kind, 'PDF document');
  assert.match(pdfOut.text, /PDF version: 1\.7/);
  assert.match(pdfOut.text, /Pages: 3/);
  assert.match(pdfOut.text, /Title: Quarterly Spec/);
  assert.match(pdfOut.text, /Super DeepSeek PDF Layer/);
  assert.match(pdfOut.text, /Fast Offline/);

  // 2. WAV + MP4 metadata
  const wavMeta = plain(F._extractMediaMetadata(buildWavFixture({ sampleRate: 44100, channels: 2, seconds: 3 }), 'voice.wav', 'audio/wav'));
  assert.equal(wavMeta.kind, 'audio');
  assert.equal(wavMeta.sampleRate, 44100);
  assert.equal(wavMeta.channels, 2);
  assert.equal(wavMeta.durationMs, 3000);

  const mp4Meta = plain(F._extractMediaMetadata(buildMp4Fixture({ width: 1920, height: 1080, duration: 7500 }), 'demo.mp4', 'video/mp4'));
  assert.equal(mp4Meta.kind, 'video');
  assert.equal(mp4Meta.width, 1920);
  assert.equal(mp4Meta.height, 1080);
  assert.equal(mp4Meta.durationMs, 7500);

  // 3. PNG + JPEG image headers
  const png = Buffer.alloc(24);
  png[0] = 0x89; png.write('PNG\r\n\x1a\n', 1, 'binary');
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20);
  assert.deepEqual(plain(F._extractImageInfo(new Uint8Array(png))), { format: 'PNG', width: 800, height: 600 });
});

test('NL-06: sd-files merges native bds-inspect-media OCR & metadata while still rejecting 4-byte invalid AV stubs', async () => {
  const bridgeCalls = [];
  const win = {
    TextDecoder, Blob, File, Response, DecompressionStream, Uint8Array, Promise, Event,
    console, setTimeout,
    document: { documentElement: { lang: 'en' }, addEventListener() {} },
    navigator: { language: 'en' },
    __sdNative: { _acceptsFile: (acc, f) => String(acc || '').includes(path.extname(f.name)) },
    __sdBridgeFetch: async (payload) => {
      bridgeCalls.push(payload.type);
      if (payload.name === 'receipt.png') {
        return {
          ok: true,
          meta: { kind: 'image', format: 'PNG', width: 1080, height: 1440 },
          ocrText: 'Total Due: BDT 1,450.00',
        };
      }
      if (payload.name === 'village.mp4') {
        return {
          ok: true,
          meta: { kind: 'video', frameRate: 30, bitrateBps: 2400000, title: 'Village Sunrise' },
          ocrText: '',
        };
      }
      return { ok: false };
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC_FILES, win);
  const F = win.__sdFiles;

  const pngBuf = Buffer.alloc(24);
  pngBuf[0] = 0x89; pngBuf.write('PNG\r\n\x1a\n', 1, 'binary');
  pngBuf.writeUInt32BE(13, 8); pngBuf.write('IHDR', 12, 'ascii');
  pngBuf.writeUInt32BE(1080, 16); pngBuf.writeUInt32BE(1440, 20);

  const validMp4 = buildMp4Fixture({ width: 1280, height: 720, duration: 4000 });
  const invalidStub = new File([new Uint8Array([0, 0, 0, 24])], 'clip.mp4', { type: 'video/mp4' });

  const input = { getAttribute: () => '.txt' };
  const res = await F.convertAll([
    new File([pngBuf], 'receipt.png', { type: 'image/png' }),
    new File([validMp4], 'village.mp4', { type: 'video/mp4' }),
    invalidStub,
  ], input);

  assert.equal(res.files.length, 2, 'valid PNG and valid MP4 become .txt summaries while invalid 4-byte stub is rejected');
  const receiptTxt = await res.files[0].text();
  assert.match(receiptTxt, /1080 × 1440 px/);
  assert.match(receiptTxt, /Total Due: BDT 1,450\.00/);

  const videoTxt = await res.files[1].text();
  assert.match(videoTxt, /Title: Village Sunrise/);
  assert.match(videoTxt, /Frame rate: 30 fps/);
  assert.match(videoTxt, /1280 × 720 px/);
  assert.ok(res.notes.some((n) => n.includes('clip.mp4: audio and video are not supported')));
  assert.ok(bridgeCalls.includes('bds-inspect-media'));
});
