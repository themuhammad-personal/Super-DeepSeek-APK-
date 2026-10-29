/*
 * Super DeepSeek — uploads for (almost) every file type.
 *
 * Hybrid design (user decision, Phase 4):
 *  - A file the chat's own upload accepts (PDF, Office, images, text, code…)
 *    goes to DeepSeek unchanged: its server-side parser is the best reader.
 *  - Anything it would refuse is turned into readable text ON THE DEVICE and
 *    uploaded as `<name>.txt`: OpenDocument (odt/ods/odp), EPUB, RTF, ZIP-style
 *    archives (listing + the readable files inside), Office files when the
 *    input does not list them, unknown text formats, and — as a last resort —
 *    a strings/metadata summary for opaque binaries. Huge text is split into
 *    parts with a note at the top of each part.
 *  - Audio and video are refused with a clear message (out of scope).
 *
 * Works for every path that fills the chat's <input type=file>: DeepSeek's own
 * upload button, the + sheet's "Upload file", and Android shares. A capture
 * listener on `document` sees the `change` event before the page does, swaps
 * the files, and re-dispatches it. Nothing leaves the device except what is
 * uploaded through the chat's normal upload.
 *
 * Plain ES2017, no dependencies.
 */
(function () {
  'use strict';
  if (window.__sdFiles) return;

  var PART_CHARS = 1500000;          // ~1.5 MB of text per uploaded part
  var MAX_PARTS = 12;
  var MAX_INPUT = 100 * 1024 * 1024; // same ceiling as the native picker
  var ZIP_TEXT_BUDGET = 6000000;     // chars of inner files read from one archive
  var ZIP_ENTRY_MAX = 4 * 1024 * 1024;   // inner file of a generic archive (unpacked)
  var DOC_PART_MAX = 32 * 1024 * 1024;   // one XML part of docx/xlsx/pptx/odt/epub (unpacked)
  var DOC_TOTAL_MAX = 48 * 1024 * 1024; // aggregate XML read from one Office/EPUB container
  var TEXT_READ_MAX = 24 * 1024 * 1024;  // bytes of a plain/binary file read at all (12 parts × 1.5 M chars ≈ 18 MB)
  var AV_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma|amr|aiff?|mid|midi|ape|mka|mp4|m4v|mov|avi|mkv|webm|wmv|flv|3gp|3g2|mpeg|mpg|mts|m2ts|vob|ogv)$/i;
  var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?|ico|svg)$/i;
  var ARCHIVE_EXT = /\.(zip|jar|war|apk|aab|xpi|crx|ipa|nupkg|whl|sketch|xd|kmz|cbz|vsix|mcpack)$/i;

  function isBn() {
    try {
      var e = window.__sdEngine;
      var locale = e && typeof e.locale === 'function' ? String(e.locale() || '') : '';
      return String(locale || document.documentElement.lang || navigator.language || '').toLowerCase().indexOf('bn') === 0;
    } catch (_) { return false; }
  }
  function t(en, bn) { return isBn() ? bn : en; }
  function toast(msg) {
    try {
      var e = window.__sdEngine;
      if (e && typeof e.toast === 'function') { e.toast(msg); return; }
      var v = window.__sdGenUIViewer;
      if (v && typeof v.toast === 'function') { v.toast(msg); return; }
    } catch (_) {}
    console.info('[SD files]', msg);
  }
  function extOf(name) {
    var n = String(name || '').toLowerCase(), d = n.lastIndexOf('.');
    return d > 0 ? n.slice(d) : '';
  }
  // What the chat's upload takes when its input does not say (an empty `accept`):
  // the formats DeepSeek's web chat documents — PDF, Word, Excel/CSV, PowerPoint,
  // plain text / Markdown, common code and data files, and images. Anything else
  // (odt, epub, rtf, zip, …) is converted. A text file that is converted only gains
  // a .txt name; its content is unchanged, so a too-short list costs nothing.
  var CHAT_DEFAULT_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.markdown,.json,.xml,.html,.htm,' +
    '.py,.js,.ts,.jsx,.tsx,.java,.kt,.c,.h,.cpp,.hpp,.cs,.go,.rs,.rb,.php,.swift,.css,.sql,.sh,.yaml,.yml,' +
    '.jpg,.jpeg,.png,.gif,.webp,.bmp';
  function isChatUpload(input) {
    // DeepSeek's own composer input (the engine finds it the same way). Folder pickers
    // and the engine's own inputs (which declare `accept`) are never given the default.
    return !!(input && input.multiple && !(input.hasAttribute && input.hasAttribute('webkitdirectory')));
  }
  function acceptOf(input) {
    var a = input ? String(input.accept || '').trim() : '';
    return a || (isChatUpload(input) ? CHAT_DEFAULT_ACCEPT : '');
  }
  function accepts(accept, file) {
    var N = window.__sdNative;
    if (N && typeof N._acceptsFile === 'function') return N._acceptsFile(accept, file);
    return !String(accept || '').trim();
  }
  function isAV(file) { return /^(audio|video)\//i.test(file.type || '') || AV_EXT.test(file.name || ''); }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'; }
  function checkCancelled(isCancelled) { if (isCancelled && isCancelled()) throw new Error('cancelled'); }

  // ── text detection ─────────────────────────────────────────────────────────
  function looksText(bytes) {
    if (!bytes.length) return true;
    var n = Math.min(bytes.length, 65536), bad = 0;
    for (var i = 0; i < n; i++) {
      var b = bytes[i];
      if (b === 0) return false;
      if (b < 7 || (b > 13 && b < 32 && b !== 27)) bad++;
    }
    if (bad / n > 0.02) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n - (n < bytes.length ? 4 : 0))); return true; }
    catch (_) { return bad === 0; }
  }
  function decode(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch (_) { return ''; }
  }
  function entities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, function (m, g) {
      g = g.toLowerCase();
      if (g === 'amp') return '&'; if (g === 'lt') return '<'; if (g === 'gt') return '>';
      if (g === 'quot') return '"'; if (g === 'apos') return "'"; if (g === 'nbsp') return ' ';
      var c = g.charAt(1) === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(c); } catch (_) { return m; }
    });
  }
  function tidy(s) { return s.replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
  function htmlText(h) {
    h = h.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|table)>/gi, '\n')
      .replace(/<h([1-6])\b[^>]*>/gi, function (m, n) { return '\n' + '######'.slice(0, +n) + ' '; })
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '');
    return tidy(entities(h));
  }

  // ── minimal ZIP reader (central directory + deflate-raw) ───────────────────
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function isZip(b) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) ; }
  function zipEntries(b) {
    var eocd = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) { if (u32(b, i) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error('not a zip archive');
    var count = u16(b, eocd + 10), off = u32(b, eocd + 16), out = [];
    if (off === 0xffffffff) throw new Error('zip64 archives are not supported');
    var dec = new TextDecoder('utf-8');
    for (var k = 0; k < count && off + 46 <= b.length; k++) {
      if (u32(b, off) !== 0x02014b50) break;
      var method = u16(b, off + 10), csize = u32(b, off + 20), usize = u32(b, off + 24);
      var nlen = u16(b, off + 28), xlen = u16(b, off + 30), clen = u16(b, off + 32), local = u32(b, off + 42);
      var name = dec.decode(b.subarray(off + 46, off + 46 + nlen));
      out.push({ name: name, method: method, csize: csize, usize: usize, local: local, dir: /\/$/.test(name) });
      off += 46 + nlen + xlen + clen;
    }
    return out;
  }
  // Streams the inflate and stops at `max` unpacked bytes. The sizes an archive
  // declares are not trusted: a zip bomb lies about them, and an unbounded
  // inflate would take the whole WebView (and the chat) down with it.
  function inflateRaw(data, max, isCancelled) {
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('this WebView cannot unzip'));
    var reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    var chunks = [], total = 0;
    function cancelReader() { try { var p = reader.cancel(); if (p && p.catch) p.catch(function () {}); } catch (_) {} }
    var unsubscribe = isCancelled && isCancelled.subscribe ? isCancelled.subscribe(cancelReader) : null;
    function pump() {
      if (isCancelled && isCancelled()) { cancelReader(); return Promise.reject(new Error('cancelled')); }
      return reader.read().then(function (r) {
        if (isCancelled && isCancelled()) throw new Error('cancelled');
        if (r.done) {
          var out = new Uint8Array(total), o = 0;
          chunks.forEach(function (c) { out.set(c, o); o += c.length; });
          return out;
        }
        total += r.value.length;
        if (total > max) {
          cancelReader();
          throw new Error('too large when unpacked');
        }
        chunks.push(r.value);
        return pump();
      });
    }
    return pump().then(function (out) { if (unsubscribe) unsubscribe(); return out; }, function (e) { if (unsubscribe) unsubscribe(); throw e; });
  }
  function zipRead(b, e, max, isCancelled) {
    if (isCancelled && isCancelled()) return Promise.reject(new Error('cancelled'));
    if (u32(b, e.local) !== 0x04034b50) return Promise.reject(new Error('bad zip entry'));
    var start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
    var data = b.subarray(start, start + e.csize);
    max = max || DOC_PART_MAX;
    if (e.method === 0) return data.length > max ? Promise.reject(new Error('too large')) : Promise.resolve(data);
    if (e.method === 8) return inflateRaw(data, max, isCancelled);
    return Promise.reject(new Error('compression method ' + e.method));
  }
  function zipReadMany(b, entries, maxTotal, isCancelled) {
    var total = 0, out = [];
    return entries.reduce(function (p, e) {
      return p.then(function () {
        checkCancelled(isCancelled);
        var remain = maxTotal - total;
        if (remain <= 0) throw new Error('too large when unpacked');
        return zipRead(b, e, Math.min(DOC_PART_MAX, remain), isCancelled).then(function (bytes) {
          total += bytes.length;
          out.push(bytes);
        });
      });
    }, Promise.resolve()).then(function () { return { bytes: total, entries: out }; });
  }
  function zipTextsOf(b, entries, names, maxTotal, isCancelled) {
    var selected = names.map(function (name) { return entries.find(function (e) { return e.name === name; }); }).filter(Boolean);
    return zipReadMany(b, selected, maxTotal, isCancelled).then(function (r) {
      var i = 0;
      return {
        bytes: r.bytes,
        texts: names.map(function (name) { return entries.some(function (e) { return e.name === name; }) ? decode(r.entries[i++]) : ''; }),
      };
    });
  }
  function zipTextOf(b, entries, name, isCancelled) {
    var e = entries.find(function (x) { return x.name === name; });
    return e ? zipRead(b, e, DOC_PART_MAX, isCancelled).then(decode) : Promise.resolve('');
  }

  // ── format extractors (each returns markdown-ish plain text) ───────────────
  function wordXml(x) {
    return tidy(entities(x
      .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]+>/g, '')));
  }
  function docx(b, en, isCancelled) {
    var parts = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'];
    return zipTextsOf(b, en, parts, DOC_TOTAL_MAX, isCancelled).then(function (r) {
      return r.texts.map(wordXml).filter(Boolean).join('\n\n---\n\n');
    });
  }
  function colIndex(ref) { var m = /^([A-Z]+)/.exec(ref || ''), n = 0; if (!m) return -1; for (var i = 0; i < m[1].length; i++) n = n * 26 + m[1].charCodeAt(i) - 64; return n - 1; }
  function xlsx(b, en, isCancelled) {
    return zipTextsOf(b, en, ['xl/sharedStrings.xml', 'xl/workbook.xml'], DOC_TOTAL_MAX, isCancelled).then(function (book) {
      var shared = [];
      (book.texts[0].match(/<si>[\s\S]*?<\/si>/g) || []).forEach(function (si) { shared.push(entities((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(function (x) { return x.replace(/<[^>]+>/g, ''); }).join(''))); });
      var names = (book.texts[1].match(/<sheet\b[^>]*name="([^"]*)"/g) || []).map(function (s) { return entities(/name="([^"]*)"/.exec(s)[1]); });
      var sheets = en.filter(function (e) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name); })
        .sort(function (a, c) { return parseInt(a.name.replace(/\D/g, ''), 10) - parseInt(c.name.replace(/\D/g, ''), 10); });
      return zipTextsOf(b, en, sheets.map(function (s) { return s.name; }), DOC_TOTAL_MAX - book.bytes, isCancelled).then(function (sheetData) {
        return sheetData.texts.map(function (x, i) {
          var rows = [];
          (x.match(/<row\b[\s\S]*?<\/row>/g) || []).forEach(function (row) {
            var cells = [];
            (row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).forEach(function (c) {
              var ref = (/\br="([A-Z]+\d+)"/.exec(c) || [])[1], typ = (/\bt="(\w+)"/.exec(c) || [])[1];
              var v = (/<v>([\s\S]*?)<\/v>/.exec(c) || [])[1], val = '';
              if (typ === 's' && v != null) val = shared[+v] || '';
              else if (typ === 'inlineStr') val = entities(((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]) || '');
              else if (v != null) val = entities(v);
              var ci = colIndex(ref); if (ci < 0) ci = cells.length;
              while (cells.length < ci) cells.push('');
              cells[ci] = String(val).replace(/[\t\n\r]+/g, ' ');
            });
            if (cells.some(Boolean)) rows.push(cells.join('\t'));
          });
          return '## Sheet: ' + (names[i] || 'Sheet' + (i + 1)) + '\n' + rows.join('\n');
        }).join('\n\n');
      });
    });
  }
  function pptx(b, en, isCancelled) {
    var slides = en.filter(function (e) { return /^ppt\/slides\/slide\d+\.xml$/.test(e.name); })
      .sort(function (a, c) { return parseInt(a.name.replace(/\D/g, ''), 10) - parseInt(c.name.replace(/\D/g, ''), 10); });
    return zipTextsOf(b, en, slides.map(function (s) { return s.name; }), DOC_TOTAL_MAX, isCancelled).then(function (r) {
      return r.texts.map(function (x, i) {
        var paras = (x.match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map(function (p) { return entities((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map(function (q) { return q.replace(/<[^>]+>/g, ''); }).join('')); }).filter(Boolean);
        return '## Slide ' + (i + 1) + '\n' + paras.join('\n');
      }).join('\n\n');
    });
  }
  function odf(b, en, isCancelled) {
    return zipTextOf(b, en, 'content.xml', isCancelled).then(function (x) {
      return tidy(entities(x
        .replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
        .replace(/<text:s(?: text:c="(\d+)")?\/>/g, function (m, n) { return ' '.repeat(+n || 1); })
        .replace(/<draw:page\b[^>]*draw:name="([^"]*)"[^>]*>/g, '\n## $1\n')
        .replace(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>/g, '\n## $1\n')
        .replace(/<\/text:(p|h)>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n')
        .replace(/<[^>]+>/g, '')));
    });
  }
  function epub(b, en, isCancelled) {
    return zipTextsOf(b, en, ['META-INF/container.xml'], DOC_TOTAL_MAX, isCancelled).then(function (container) {
      var opfPath = (/full-path="([^"]+)"/.exec(container.texts[0]) || [])[1] || '';
      return zipTextsOf(b, en, [opfPath], DOC_TOTAL_MAX - container.bytes, isCancelled).then(function (packageData) {
        var opf = packageData.texts[0];
        var base = opfPath.indexOf('/') >= 0 ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
        var items = {};
        (opf.match(/<item\b[^>]*>/g) || []).forEach(function (it) { var id = (/\bid="([^"]+)"/.exec(it) || [])[1], href = (/\bhref="([^"]+)"/.exec(it) || [])[1]; if (id && href) items[id] = base + decodeURIComponent(href); });
        var order = (opf.match(/<itemref\b[^>]*idref="([^"]+)"/g) || []).map(function (r) { return items[/idref="([^"]+)"/.exec(r)[1]]; }).filter(Boolean);
        if (!order.length) order = en.filter(function (e) { return /\.x?html?$/i.test(e.name); }).map(function (e) { return e.name; }).sort();
        var title = entities(((/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf) || [])[1]) || '');
        return zipTextsOf(b, en, order, DOC_TOTAL_MAX - container.bytes - packageData.bytes, isCancelled).then(function (chapters) {
          return (title ? '# ' + title + '\n\n' : '') + chapters.texts.map(htmlText).filter(Boolean).join('\n\n');
        });
      });
    });
  }
  function archive(b, en, name, isCancelled) {
    var files = en.filter(function (e) { return !e.dir; });
    var lines = ['# Archive: ' + name, '', files.length + ' files, ' + fmtSize(files.reduce(function (s, e) { return s + e.usize; }, 0)) + ' uncompressed', '', '## Contents'];
    files.slice(0, 2000).forEach(function (e) { lines.push('- ' + e.name + ' (' + fmtSize(e.usize) + ')'); });
    if (files.length > 2000) lines.push('- … ' + (files.length - 2000) + ' more');
    var budget = ZIP_TEXT_BUDGET, out = [], skipped = 0;
    var queue = files.filter(function (e) { return e.usize > 0 && e.usize <= ZIP_ENTRY_MAX && !IMAGE_EXT.test(e.name) && !AV_EXT.test(e.name) && !/(^|\/)(\.git|node_modules|__MACOSX)\//.test(e.name); });
    return queue.reduce(function (p, e) {
      return p.then(function () {
        checkCancelled(isCancelled);
        if (budget <= 0) { skipped++; return; }
        return zipRead(b, e, ZIP_ENTRY_MAX, isCancelled).then(function (bytes) {
          if (!looksText(bytes)) return;
          var s = decode(bytes); if (s.length > budget) { s = s.slice(0, budget) + '\n… (truncated)'; }
          budget -= s.length;
          out.push('\n## File: ' + e.name + '\n```' + extOf(e.name).slice(1) + '\n' + s + '\n```');
        }, function () { skipped++; });
      });
    }, Promise.resolve()).then(function () {
      if (skipped) lines.push('', '(' + skipped + ' inner files not included: size budget or unreadable)');
      return lines.join('\n') + '\n' + out.join('\n');
    });
  }
  function rtf(s) {
    var depth = 0, skip = [], out = '', i = 0, n = s.length;
    while (i < n) {
      var ch = s.charAt(i);
      if (ch === '{') { depth++; skip.push(skip.length ? skip[skip.length - 1] : false); i++; continue; }
      if (ch === '}') { depth--; skip.pop(); i++; continue; }
      if (ch === '\\') {
        var m = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(s.slice(i, i + 40));
        if (!m) { i++; continue; }
        i += m[0].length;
        var on = skip.length && skip[skip.length - 1];
        if (m[1]) {
          var w = m[1];
          if (/^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|themedata|datastore|xmlnstbl|listtable|listoverridetable|generator|\*)$/.test(w)) { if (skip.length) skip[skip.length - 1] = true; }
          else if (!on && (w === 'par' || w === 'line' || w === 'row')) out += '\n';
          else if (!on && (w === 'tab' || w === 'cell')) out += '\t';
          else if (!on && w === 'u' && m[2]) { out += String.fromCharCode((+m[2] + 65536) % 65536); if (s.charAt(i) === '?') i++; }
        } else if (m[3] && !on) out += String.fromCharCode(parseInt(m[3], 16));
        else if (m[4] === '*') { if (skip.length) skip[skip.length - 1] = true; }
        else if (m[4] && !on && '{}\\'.indexOf(m[4]) >= 0) out += m[4];
        continue;
      }
      if (!(skip.length && skip[skip.length - 1]) && ch !== '\r' && ch !== '\n') out += ch;
      i++;
    }
    return tidy(out);
  }
  function binarySummary(bytes, file, isCancelled) {
    var head = Array.prototype.map.call(bytes.subarray(0, 32), function (x) { return ('0' + x.toString(16)).slice(-2); }).join(' ');
    var strs = [], cur = '', total = 0, i = 0, chunkSize = 256 * 1024;
    function scanChunk() {
      checkCancelled(isCancelled);
      var end = Math.min(bytes.length, i + chunkSize);
      for (; i < end && total < 400000; i++) {
        var c = bytes[i];
        if (c >= 32 && c < 127) cur += String.fromCharCode(c);
        else { if (cur.length >= 6) { strs.push(cur); total += cur.length; } cur = ''; }
      }
      if (i < bytes.length && total < 400000) {
        // This runs in the WebView main world. Yield between chunks so a large
        // opaque upload cannot monopolize the chat UI while its strings are scanned.
        return new Promise(function (resolve) { window.setTimeout(resolve, 0); }).then(scanChunk);
      }
      if (cur.length >= 6) strs.push(cur);
      return ['# Binary file: ' + file.name, '', '- Size: ' + fmtSize(file.size), '- Type: ' + (file.type || 'unknown'), '- First bytes (hex): ' + head, '',
        'This format cannot be read as text on the device. Below are the readable strings found inside it (like the `strings` tool).', '', '## Strings', strs.join('\n')].join('\n');
    }
    return Promise.resolve().then(scanChunk);
  }

  /** file → { text, kind } describing the file in plain text. */
  function readBlob(blob, isCancelled) {
    if (typeof FileReader !== 'function') return blob.arrayBuffer().then(function (ab) { checkCancelled(isCancelled); return ab; });
    return new Promise(function (resolve, reject) {
      var reader = new FileReader(), settled = false, unsubscribe = null;
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        reader.onload = reader.onerror = reader.onabort = null;
        fn(value);
      }
      function cancel() { try { reader.abort(); } catch (_) {} finish(reject, new Error('cancelled')); }
      reader.onload = function () { if (isCancelled && isCancelled()) cancel(); else finish(resolve, reader.result); };
      reader.onerror = function () { finish(reject, reader.error || new Error('file read failed')); };
      reader.onabort = function () { finish(reject, new Error('cancelled')); };
      if (isCancelled && isCancelled.subscribe) unsubscribe = isCancelled.subscribe(cancel);
      if (isCancelled && isCancelled()) { cancel(); return; }
      try { reader.readAsArrayBuffer(blob); } catch (e) { finish(reject, e); }
    });
  }
  function readBytes(file, isCancelled) {
    // Archives need their central directory at the end, so they are read whole
    // (≤ 100 MB). Anything else only needs as much text as can be uploaded.
    if (file.size <= TEXT_READ_MAX) return readBlob(file, isCancelled).then(function (ab) { return { b: new Uint8Array(ab), cut: false }; });
    return readBlob(file.slice(0, 8), isCancelled).then(function (h) {
      if (isZip(new Uint8Array(h))) return readBlob(file, isCancelled).then(function (ab) { return { b: new Uint8Array(ab), cut: false }; });
      return readBlob(file.slice(0, TEXT_READ_MAX), isCancelled).then(function (ab) { return { b: new Uint8Array(ab), cut: true }; });
    });
  }
  function utf16(b) {
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
    return '';
  }
  function extract(file, isCancelled) {
    return readBytes(file, isCancelled).then(function (rb) {
      checkCancelled(isCancelled);
      return extractBytes(file, rb.b, isCancelled).then(function (r) {
        if (rb.cut && r.text) r.text += '\n\n[' + t('Only the first ' + fmtSize(TEXT_READ_MAX) + ' of this ' + fmtSize(file.size) + ' file was read.', 'এই ' + fmtSize(file.size) + ' ফাইলের শুধু প্রথম ' + fmtSize(TEXT_READ_MAX) + ' পড়া হয়েছে।') + ']';
        return r;
      });
    });
  }
  function extractBytes(file, b, isCancelled) {
    return Promise.resolve().then(function () {
      checkCancelled(isCancelled);
      var ext = extOf(file.name), wide = utf16(b);
      if (wide) {
        var w = '';
        try { w = new TextDecoder(wide).decode(b.subarray(2)); } catch (_) {}
        if (w) return { text: w, kind: 'text' };
      }
      if (isZip(b)) {
        var en = zipEntries(b), has = function (n) { return en.some(function (e) { return e.name === n; }); };
        if (has('word/document.xml')) return docx(b, en, isCancelled).then(function (s) { return { text: s, kind: 'Word document' }; });
        if (has('xl/workbook.xml')) return xlsx(b, en, isCancelled).then(function (s) { return { text: s, kind: 'spreadsheet' }; });
        if (has('ppt/presentation.xml')) return pptx(b, en, isCancelled).then(function (s) { return { text: s, kind: 'presentation' }; });
        if (has('content.xml') && has('mimetype')) return odf(b, en, isCancelled).then(function (s) { return { text: s, kind: 'OpenDocument' }; });
        if (has('META-INF/container.xml')) return epub(b, en, isCancelled).then(function (s) { return { text: s, kind: 'e-book' }; });
        return archive(b, en, file.name, isCancelled).then(function (s) { return { text: s, kind: 'archive' }; });
      }
      if (ext === '.rtf' || /^\{\\rtf/.test(decode(b.subarray(0, 8)))) return { text: rtf(decode(b)), kind: 'RTF document' };
      if (looksText(b)) {
        var s = decode(b);
        if (/\.(x?html?|xht)$/i.test(file.name)) return { text: s, kind: 'web page' };
        return { text: s, kind: 'text' };
      }
      return binarySummary(b, file, isCancelled).then(function (text) { return { text: text, kind: 'binary' }; });
    });
  }

  function partsOf(name, text, kind) {
    var base = name.replace(/\.txt$/i, '');
    if (text.length <= PART_CHARS) return [new File([text], base + '.txt', { type: 'text/plain' })];
    var out = [], total = Math.min(MAX_PARTS, Math.ceil(text.length / PART_CHARS));
    for (var i = 0, pos = 0; i < total; i++) {
      var end = Math.min(text.length, pos + PART_CHARS);
      if (end < text.length) { var nl = text.lastIndexOf('\n', end); if (nl > pos + PART_CHARS * 0.6) end = nl; }
      var note = '[' + name + ' — ' + kind + ', part ' + (i + 1) + ' of ' + total + (i === total - 1 && end < text.length ? '; the rest was cut because the file is very large' : '') + ']\n\n';
      out.push(new File([note + text.slice(pos, end)], base + '.part' + (i + 1) + '.txt', { type: 'text/plain' }));
      pos = end;
    }
    return out;
  }

  /** Files the input would refuse → converted Files. Reports per-file progress and honors Stop. */
  function convertAll(list, input, options) {
    options = options || {};
    var accept = acceptOf(input), notes = [], out = [], completed = 0, cancelled = false;
    function stopped() { return !!(options.isCancelled && options.isCancelled()); }
    if (options.isCancelled && options.isCancelled.subscribe) stopped.subscribe = options.isCancelled.subscribe;
    function report(file, phase) {
      if (!options.onProgress) return;
      try { options.onProgress({ total: list.length, completed: completed, current: file.name, phase: phase }); } catch (_) {}
    }
    return list.reduce(function (p, f) {
      return p.then(function () {
        if (stopped()) { cancelled = true; return; }
        report(f, 'reading');
        function finish() { completed++; report(f, 'ready'); }
        if (isAV(f)) { notes.push(t(f.name + ': audio and video are not supported', f.name + ': অডিও ও ভিডিও সমর্থিত নয়')); finish(); return; }
        if (f.size > MAX_INPUT) { notes.push(t(f.name + ': larger than 100 MB', f.name + ': ১০০ MB-এর বেশি')); finish(); return; }
        if (accepts(accept, f)) { out.push(f); finish(); return; }
        return extract(f, stopped).then(function (r) {
          if (stopped()) { cancelled = true; return; }
          var text = String(r.text || '').trim();
          if (!text) { notes.push(t(f.name + ': no readable text found', f.name + ': পড়ার মতো লেখা পাওয়া যায়নি')); finish(); return; }
          var parts = partsOf(f.name, text, r.kind);
          parts.forEach(function (x) { out.push(x); });
          notes.push(parts.length > 1
            ? t(f.name + ' → text, split into ' + parts.length + ' parts', f.name + ' → টেক্সট, ' + parts.length + ' ভাগে')
            : t(f.name + ' → read on device as text', f.name + ' → ডিভাইসে টেক্সট হিসেবে পড়া হয়েছে'));
          finish();
        }, function (e) {
          if (stopped() || (e && e.message === 'cancelled')) { cancelled = true; return; }
          notes.push(t(f.name + ': could not be read (' + (e && e.message || e) + ')', f.name + ': পড়া যায়নি (' + (e && e.message || e) + ')'));
          finish();
        });
      });
    }, Promise.resolve()).then(function () { return { files: out, notes: notes, cancelled: cancelled || stopped() }; });
  }

  function needsWork(f, input) { return isAV(f) || f.size > MAX_INPUT || !accepts(acceptOf(input), f); }

  // ── the change-event hand-off ──────────────────────────────────────────────
  var ours = typeof WeakSet === 'function' ? new WeakSet() : null;
  var pendingChanges = typeof WeakMap === 'function' ? new WeakMap() : null, activeTasks = typeof WeakMap === 'function' ? new WeakMap() : null, changeSequence = 0;
  function progressCard(total, onStop) {
    var root = null, title = null, detail = null, bar = null, closed = false;
    try {
      root = document.createElement('div'); root.className = 'sd-files-progress'; root.setAttribute('role', 'status'); root.setAttribute('aria-live', 'polite');
      var spin = document.createElement('span'); spin.className = 'sd-spin'; spin.setAttribute('aria-hidden', 'true');
      var body = document.createElement('div'); body.className = 'sd-files-progress-main';
      title = document.createElement('div'); title.className = 'sd-files-progress-title'; title.textContent = t('Preparing files…', 'ফাইল প্রস্তুত হচ্ছে…');
      detail = document.createElement('div'); detail.className = 'sd-files-progress-detail';
      bar = document.createElement('progress'); bar.className = 'sd-files-progress-bar'; bar.max = Math.max(1, total); bar.value = 0;
      bar.setAttribute('aria-label', t('File preparation progress', 'ফাইল প্রস্তুতির অগ্রগতি'));
      body.append(title, detail, bar);
      var stop = document.createElement('button'); stop.type = 'button'; stop.className = 'sd-chip sd-files-progress-stop'; stop.textContent = t('Stop', 'থামান');
      stop.addEventListener('click', onStop);
      root.append(spin, body, stop);
      (document.body || document.documentElement).appendChild(root);
    } catch (_) { root = null; }
    return {
      update: function (p) {
        if (closed || !root) return;
        var itemNo = p.phase === 'ready' ? p.completed : p.completed + 1;
        title.textContent = p.phase === 'ready'
          ? t('Prepared ' + p.completed + ' of ' + p.total, 'প্রস্তুত হয়েছে ' + p.completed + ' / ' + p.total)
          : t('Preparing ' + itemNo + ' of ' + p.total, 'প্রস্তুত হচ্ছে ' + itemNo + ' / ' + p.total);
        detail.textContent = p.current;
        bar.max = Math.max(1, p.total); bar.value = p.completed;
        bar.setAttribute('aria-valuetext', t(itemNo + ' of ' + p.total + ': ' + p.current, p.total + '-এর মধ্যে ' + itemNo + ': ' + p.current));
      },
      close: function () { closed = true; if (root && root.parentNode) root.parentNode.removeChild(root); }
    };
  }
  function onChange(e) {
    var input = e.target;
    if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return;
    if (ours && ours.has(e)) return;
    var previous = activeTasks && activeTasks.get(input);
    if (previous) previous.stop(false, false);
    var token = ++changeSequence;
    if (pendingChanges) pendingChanges.set(input, token);
    if (input.closest && input.closest('#bds-root, .bds-attach-wrapper, [data-sd-owned]')) return;
    var list = input.files ? Array.prototype.slice.call(input.files) : [];
    if (!list.length || !list.some(function (f) { return needsWork(f, input); })) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    var task = { cancelled: false, stop: null, progress: null, cancelListeners: [] };
    task.progress = progressCard(list.length, function () { task.stop(true, true); });
    task.stop = function (notify, invalidate) {
      if (task.cancelled) return;
      task.cancelled = true;
      task.cancelListeners.slice().forEach(function (cancel) { try { cancel(); } catch (_) {} });
      task.cancelListeners.length = 0;
      task.progress.close();
      if (activeTasks && activeTasks.get(input) === task) activeTasks.delete(input);
      if (invalidate && pendingChanges) pendingChanges.set(input, ++changeSequence);
      if (notify) toast(t('Stopped. No files were attached; select them again when ready.', 'থামানো হয়েছে। কোনো ফাইল যুক্ত হয়নি; প্রস্তুত হলে আবার নির্বাচন করুন।'));
    };
    if (activeTasks) activeTasks.set(input, task);
    function replayChange() {
      var ev = new Event('change', { bubbles: true });
      if (ours) ours.add(ev);
      input.dispatchEvent(ev);
    }
    function isCurrent() { return !task.cancelled && (!pendingChanges || pendingChanges.get(input) === token); }
    function isCancelled() { return !isCurrent(); }
    isCancelled.subscribe = function (cancel) {
      if (isCancelled()) { cancel(); return function () {}; }
      task.cancelListeners.push(cancel);
      return function () { task.cancelListeners = task.cancelListeners.filter(function (x) { return x !== cancel; }); };
    };
    function finish() {
      task.progress.close();
      if (activeTasks && activeTasks.get(input) === task) activeTasks.delete(input);
    }
    function keepOriginals() {
      if (!isCurrent()) return;
      finish();
      toast(t('Could not prepare files; the original selection was kept.', 'ফাইল প্রস্তুত করা যায়নি; মূল নির্বাচন রাখা হয়েছে।'));
      try { replayChange(); } catch (err) { console.warn('[SD files] could not replay original selection', err); }
    }
    convertAll(list, input, {
      isCancelled: isCancelled,
      onProgress: function (p) { if (isCurrent()) task.progress.update(p); },
    }).then(function (r) {
      if (!isCurrent()) return;
      finish();
      if (r.cancelled) return;
      if (r.notes.length) toast(r.notes.slice(0, 3).join(' · ') + (r.notes.length > 3 ? ' …' : ''));
      if (!r.files.length) return;
      try {
        var dt = new DataTransfer();
        r.files.forEach(function (f) { dt.items.add(f); });
        input.files = dt.files;
      } catch (err) { keepOriginals(); return; }
      try { replayChange(); } catch (err) { console.warn('[SD files] could not dispatch prepared files', err); }
    }, function (err) {
      if (!isCurrent()) return;
      console.warn('[SD files] file preparation failed', err);
      keepOriginals();
    });
  }
  document.addEventListener('change', onChange, true);

  window.__sdFiles = { version: 1, extract: extract, convertAll: convertAll, partsOf: partsOf, _zipEntries: zipEntries, _zipReadMany: zipReadMany, _rtf: rtf, _looksText: looksText, _isAV: isAV, _acceptOf: acceptOf };
})();
