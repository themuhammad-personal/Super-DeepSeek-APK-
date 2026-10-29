// Tests for bds/sd-files.js (on-device conversion of files the chat's upload refuses).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/sd-files.js'), 'utf8');

function load(accept, options = {}) {
  const listeners = [];
  const win = {
    TextDecoder, Blob, File, Response, DecompressionStream, Uint8Array, Promise, Event,
    FileReader: options.FileReader,
    console: options.console || console,
    setTimeout: options.setTimeout || setTimeout,
    document: options.document || { documentElement: { lang: 'en' }, addEventListener: (t, f, c) => listeners.push([t, f, c]) },
    navigator: { language: 'en' },
    __sdEngine: options.engine,
    // Same contract as sd-native's acceptsFile: an empty list accepts everything.
    __sdNative: { _acceptsFile: (acc, f) => { const l = (acc || '').split(',').map((s) => s.trim()).filter(Boolean); return !l.length || l.some((a) => f.name.toLowerCase().endsWith(a)); } },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(SRC, win);
  return { F: win.__sdFiles, listeners };
}

// Minimal ZIP writer (deflate) — enough to build docx/xlsx/pptx/odt/epub fixtures.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries, store = false) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = store ? raw : zlib.deflateRawSync(raw);
    const nb = Buffer.from(name, 'utf8'), crc = crc32(raw), method = store ? 0 : 8;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const file = (buf, name, type = '') => new File([buf], name, { type });

test('docx: paragraphs, tabs and tables become plain text', async () => {
  const { F } = load();
  const doc = '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world &amp; co</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>';
  const r = await F.extract(file(zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': doc }), 'a.docx'));
  assert.equal(r.kind, 'Word document');
  assert.equal(r.text, 'Hello\tworld & co\nSecond');
});

test('xlsx: shared strings, numbers and inline strings become TSV per sheet, columns kept', async () => {
  const { F } = load();
  const r = await F.extract(file(zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sales" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><t>Qty</t></si><si><r><t>Te</t></r><r><t>a</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>note</t></is></c></row></sheetData></worksheet>',
  }), 'b.xlsx'));
  assert.equal(r.kind, 'spreadsheet');
  assert.equal(r.text, '## Sheet: Sales\nItem\tQty\nTea\t\t42\n\tnote');
});

test('pptx: slides in numeric order (slide10 after slide2)', async () => {
  const { F } = load();
  const s = (t) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  const r = await F.extract(file(zip({ 'ppt/presentation.xml': '<x/>', 'ppt/slides/slide10.xml': s('Ten'), 'ppt/slides/slide2.xml': s('Two'), 'ppt/slides/slide1.xml': s('One') }), 'c.pptx'));
  assert.equal(r.text, '## Slide 1\nOne\n\n## Slide 2\nTwo\n\n## Slide 3\nTen');
});

test('odt and epub (spine order, html stripped)', async () => {
  const { F } = load();
  const odt = await F.extract(file(zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:text><text:h>Title</text:h><text:p>Body<text:s text:c="2"/>text</text:p></office:text>' }, true), 'd.odt'));
  assert.equal(odt.kind, 'OpenDocument');
  assert.equal(odt.text, 'Title\nBody  text');
  const ep = await F.extract(file(zip({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    'OEBPS/book.opf': '<package><metadata><dc:title>My Book</dc:title></metadata><manifest><item id="b" href="ch2.xhtml"/><item id="a" href="ch1.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
    'OEBPS/ch1.xhtml': '<html><head><style>p{}</style></head><body><h1>One</h1><p>First</p></body></html>',
    'OEBPS/ch2.xhtml': '<html><body><p>Second</p></body></html>',
  }), 'e.epub'));
  assert.equal(ep.kind, 'e-book');
  assert.equal(ep.text, '# My Book\n\n# One\nFirst\n\nSecond');
});

test('generic archive: listing plus readable inner files; binaries and junk folders skipped', async () => {
  const { F } = load();
  const r = await F.extract(file(zip({ 'src/main.py': 'print("hi")\n', 'bin/app.exe': Buffer.from([0, 1, 2, 3, 0, 0, 9]), 'node_modules/x/index.js': 'junk', 'docs/': '' }), 'proj.zip'));
  assert.equal(r.kind, 'archive');
  assert.match(r.text, /# Archive: proj\.zip/);
  assert.match(r.text, /- src\/main\.py \(12 B\)/);
  assert.match(r.text, /## File: src\/main\.py\n```py\nprint\("hi"\)/);
  assert.doesNotMatch(r.text, /## File: bin\/app\.exe/);
  assert.doesNotMatch(r.text, /## File: node_modules/);
});

test('rtf, unknown text and opaque binary', async () => {
  const { F } = load();
  const rtf = await F.extract(file(Buffer.from('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello \\b bold\\b0\\par caf\\\'e9 \\u8211? done}'), 'f.rtf'));
  assert.equal(rtf.text, 'Hello bold\ncafé – done');
  const txt = await F.extract(file(Buffer.from('key = value\n'), 'settings.conf'));
  assert.equal(txt.kind, 'text');
  const bin = await F.extract(file(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]), Buffer.from('GLIBC_2.17 readable-string'), Buffer.from([0, 0])]), 'tool.bin'));
  assert.equal(bin.kind, 'binary');
  assert.match(bin.text, /First bytes \(hex\): 7f 45 4c 46/);
  assert.match(bin.text, /GLIBC_2\.17 readable-string/);
});

test('large text is split into noted parts at line breaks', async () => {
  const { F } = load();
  const line = 'x'.repeat(99) + '\n';
  const parts = F.partsOf('big.log', line.repeat(40000), 'text'); // 4,000,000 chars
  assert.equal(parts.length, 3);
  assert.deepEqual([...parts].map((p) => p.name), ['big.log.part1.txt', 'big.log.part2.txt', 'big.log.part3.txt']);
  const first = await parts[0].text();
  assert.match(first, /^\[big\.log — text, part 1 of 3\]\n\n/);
  assert.ok(first.endsWith('\n') || first.endsWith('x'));
  assert.equal(F.partsOf('small.md', 'hi', 'text')[0].name, 'small.md.txt');
});

test('convertAll: accepted files untouched, refused ones converted, audio/video refused with a note', async () => {
  const { F } = load();
  const pdf = file(Buffer.from('%PDF-1.4'), 'paper.pdf', 'application/pdf');
  const odt = file(zip({ mimetype: 'x', 'content.xml': '<text:p>Hi</text:p>' }, true), 'note.odt');
  const mp4 = file(Buffer.from('....'), 'clip.mp4', 'video/mp4');
  const progress = [];
  const r = await F.convertAll([pdf, odt, mp4], { accept: '.pdf,.txt' }, { onProgress: (p) => progress.push([p.current, p.phase, p.completed]) });
  assert.equal(r.cancelled, false);
  assert.deepEqual(progress, [
    ['paper.pdf', 'reading', 0], ['paper.pdf', 'ready', 1],
    ['note.odt', 'reading', 1], ['note.odt', 'ready', 2],
    ['clip.mp4', 'reading', 2], ['clip.mp4', 'ready', 3],
  ]);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[0], pdf);
  assert.equal(r.files[1].name, 'note.odt.txt');
  assert.equal(await r.files[1].text(), 'Hi');
  assert.ok(r.notes.some((n) => /clip\.mp4: audio and video are not supported/.test(n)));
  assert.ok(r.notes.some((n) => /note\.odt → read on device/.test(n)));
});

test('file preparation shows accessible localized progress and Stop aborts attachment', async () => {
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = {}; this.parentNode = null;
      this.classList = { add() {}, remove() {} };
    }
    append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    removeChild(node) { this.children = this.children.filter((x) => x !== node); node.parentNode = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  const created = [], messages = [], listeners = [], readers = [];
  class Reader {
    readAsArrayBuffer(blob) { this.blob = blob; readers.push(this); }
    abort() { this.aborted = true; if (this.onabort) this.onabort(); }
  }
  const body = new Element('body');
  const document = {
    body, documentElement: { lang: 'en' },
    addEventListener: (t, f, c) => listeners.push([t, f, c]),
    createElement: (tag) => { const el = new Element(tag); created.push(el); return el; },
  };
  load(undefined, {
    document, FileReader: Reader, engine: { locale: () => 'bn-BD', toast: (m) => messages.push(m) },
    console: { info: (...args) => messages.push(args.join(' ')), warn() {} },
  });
  const original = file(Buffer.from('placeholder'), 'notes.unsupported');
  const dispatched = [];
  const input = {
    tagName: 'INPUT', type: 'file', multiple: true, accept: '.pdf', files: [original],
    hasAttribute: () => false, closest: () => null,
    dispatchEvent: (e) => { dispatched.push(e); return true; },
  };
  listeners[0][1]({ target: input, stopImmediatePropagation() {}, stopPropagation() {} });
  await Promise.resolve();
  assert.equal(readers.length, 1, 'the file read is cancellable while pending');
  const card = created.find((e) => e.className === 'sd-files-progress');
  assert.ok(card, 'the user gets a visible progress card');
  assert.equal(card.attributes.role, 'status');
  assert.equal(card.attributes['aria-live'], 'polite');
  assert.match(card.children[1].children[0].textContent, /প্রস্তুত হচ্ছে 1 \/ 1/);
  assert.equal(card.children[1].children[1].textContent, 'notes.unsupported');
  assert.equal(card.children[1].children[2].value, 0);
  assert.equal(card.children[2].textContent, 'থামান');
  card.children[2].listeners.click();
  assert.equal(card.parentNode, null, 'Stop immediately dismisses progress');
  assert.equal(readers[0].aborted, true, 'Stop aborts the underlying file read');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(input.files, [original]);
  assert.equal(dispatched.length, 0, 'cancelled files are never handed to the chat');
  assert.match(messages.join(' '), /থামানো হয়েছে। কোনো ফাইল যুক্ত হয়নি/);
});

test('failed DataTransfer setup keeps and replays the user’s original file selection', async () => {
  const logs = [];
  const { listeners } = load(undefined, { console: { info: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) } });
  const original = file(Buffer.from('hello world'), 'notes.unsupported');
  const dispatched = [];
  const input = {
    tagName: 'INPUT', type: 'file', multiple: true, accept: '.pdf', files: [original],
    hasAttribute: () => false, closest: () => null,
    dispatchEvent: (e) => { dispatched.push(e); return true; },
  };
  listeners[0][1]({ target: input, stopImmediatePropagation() {}, stopPropagation() {} });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(input.files, [original], 'the selection was not overwritten');
  assert.equal(dispatched.length, 1, 'the page receives a replacement change event');
  assert.equal(dispatched[0].type, 'change');
  assert.match(logs.join(' '), /original selection was kept/);
});

test('a newer selection invalidates an older asynchronous conversion', async () => {
  const { listeners } = load(undefined, { console: { info() {}, warn() {} } });
  let finishRead, readStarted = false;
  const older = file(Buffer.from('placeholder'), 'older.unsupported');
  older.arrayBuffer = () => { readStarted = true; return new Promise((resolve) => { finishRead = resolve; }); };
  const newer = file(Buffer.from('%PDF-1.4'), 'newer.pdf', 'application/pdf');
  const dispatched = [];
  const input = {
    tagName: 'INPUT', type: 'file', multiple: true, accept: '.pdf', files: [older],
    hasAttribute: () => false, closest: () => null,
    dispatchEvent: (e) => { dispatched.push(e); return true; },
  };
  let firstStopped = false;
  listeners[0][1]({ target: input, stopImmediatePropagation() { firstStopped = true; }, stopPropagation() {} });
  await Promise.resolve();
  assert.equal(readStarted, true, 'the first file read is pending');
  assert.equal(firstStopped, true);
  input.files = [newer];
  let secondStopped = false;
  listeners[0][1]({ target: input, stopImmediatePropagation() { secondStopped = true; }, stopPropagation() {} });
  assert.equal(secondStopped, false, 'the accepted newer selection continues to the page');
  finishRead(new Uint8Array(Buffer.from('older contents')).buffer);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(input.files, [newer], 'the stale conversion cannot overwrite a newer selection');
  assert.equal(dispatched.length, 0, 'the stale conversion is not replayed');
});

test('a capture-phase change listener is installed on the document', () => {
  const { listeners } = load();
  assert.ok(listeners.some(([type, , capture]) => type === 'change' && capture === true));
});

test('Office/EPUB XML members share one bounded unpacked-byte budget', async () => {
  const { F } = load('.pdf');
  const entry = Buffer.alloc(1024 * 1024);
  const archive = zip({ 'part-a.xml': entry, 'part-b.xml': entry });
  const entries = F._zipEntries(archive);
  const full = await F._zipReadMany(archive, entries, 2 * entry.length);
  assert.equal(full.bytes, 2 * entry.length);
  await assert.rejects(F._zipReadMany(archive, entries, entry.length + entry.length / 2), /too large when unpacked/);
});

test('zip bombs are stopped while inflating: the declared size is not trusted', async () => {
  const { F } = load('.pdf');
  // 40 MB of zeros deflates to ~40 KB. The central directory is rewritten to claim 100 bytes.
  const bomb = Buffer.alloc(40 * 1024 * 1024);
  const z = zip({ 'notes.txt': bomb, 'readme.md': '# hello' });
  const cdir = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), z.length - 22);
  let p = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  for (; p >= 0 && p <= cdir; p = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p + 4)) z.writeUInt32LE(100, p + 24);
  const r = await F.extract(new File([z], 'bomb.zip'));
  assert.match(r.text, /# hello/, 'the honest file is still read');
  assert.doesNotMatch(r.text, /## File: notes\.txt/, 'the bomb is skipped, not unpacked');
  assert.match(r.text, /inner files not included/);
  // A docx whose document.xml unpacks past the per-part cap fails cleanly instead of exhausting memory.
  const fat = zip({ 'word/document.xml': Buffer.alloc(33 * 1024 * 1024, 0x20) });
  await assert.rejects(F.extract(new File([fat], 'fat.docx')), /too large when unpacked/);
});

test('Stop signal cancels an in-flight ZIP inflation reader', async () => {
  const { F } = load();
  const archive = zip({ 'large.xml': Buffer.alloc(8 * 1024 * 1024) });
  const entries = F._zipEntries(archive);
  let cancelled = false;
  const subscribers = [];
  const signal = () => cancelled;
  signal.subscribe = (fn) => { subscribers.push(fn); return () => {}; };
  const pending = F._zipReadMany(archive, entries, 16 * 1024 * 1024, signal);
  await Promise.resolve();
  cancelled = true;
  subscribers.forEach((fn) => fn());
  await assert.rejects(pending, /cancelled/);
});

test('large binary summaries yield to the WebView event loop between scan chunks', async () => {
  let yields = 0;
  const { F } = load('.pdf', { setTimeout: (fn, delay) => { yields++; return setTimeout(fn, delay); } });
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  const r = await F.extract(file(bytes, 'opaque.bin', 'application/octet-stream'));
  assert.equal(r.kind, 'binary');
  assert.match(r.text, /# Binary file: opaque\.bin/);
  assert.ok(yields >= 7, `expected a timer yield per 256 KiB chunk, got ${yields}`);
});

test('very large text files: only the first 24 MB is read, with a note', async () => {
  const { F } = load('.pdf');
  const line = 'log line 0123456789 abcdefghijklmnopqrstuvwxyz\n';
  const big = new File([line.repeat(Math.ceil((26 * 1024 * 1024) / line.length))], 'server.log');
  const r = await F.extract(big);
  assert.equal(r.kind, 'text');
  assert.ok(r.text.length <= 24 * 1024 * 1024 + 400, 'bounded read');
  assert.match(r.text, /Only the first 24\.0 MB of this 26\.0 MB file was read/);
});

test('UTF-16 text files (Windows Notepad) are read as text, not as binary strings', async () => {
  const { F } = load('.pdf');
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello দুনিয়া\r\nline 2', 'utf16le')]);
  const r = await F.extract(new File([le], 'notes.ini'));
  assert.equal(r.kind, 'text');
  assert.match(r.text, /Hello দুনিয়া/);
});

test('an empty accept on the chat upload falls back to the formats DeepSeek takes; other inputs keep "accept everything"', async () => {
  const { F } = load();
  const chat = { accept: '', multiple: true, hasAttribute: () => false };
  const folder = { accept: '', multiple: true, hasAttribute: (n) => n === 'webkitdirectory' };
  const single = { accept: '', multiple: false, hasAttribute: () => false };
  assert.match(F._acceptOf(chat), /\.pdf/);
  assert.equal(F._acceptOf(folder), '');
  assert.equal(F._acceptOf(single), '');
  assert.equal(F._acceptOf({ accept: '.json', multiple: true, hasAttribute: () => false }), '.json');
  const pdf = file(Buffer.from('%PDF-1.4'), 'paper.pdf', 'application/pdf');
  const png = file(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'shot.png', 'image/png');
  const odt = file(zip({ mimetype: 'x', 'content.xml': '<text:p>Hi</text:p>' }, true), 'note.odt');
  const r = await F.convertAll([pdf, png, odt], chat);
  assert.equal(r.files[0], pdf);
  assert.equal(r.files[1], png);
  assert.equal(r.files[2].name, 'note.odt.txt');
  const keep = await F.convertAll([odt], folder);
  assert.equal(keep.files[0], odt);
});
