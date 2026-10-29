/* Super DeepSeek — artifact store + Claude-style artifact viewer.
 *
 * Pattern (claude.ai artifacts): a compact card in the message opens a dedicated
 * viewer — full screen on phones, a side panel on wide screens. Header: close,
 * title with version selector, Preview | Code toggle, Copy with a menu (download,
 * share, full screen, edit with AI, re-run). Every edit is a new version.
 *
 * Trusted page code only; generated content is shown through sd-genui-frame.js
 * (sandboxed, opaque origin) or as text/DOM built with textContent.
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIViewer && root.__sdGenUIViewer.version === 1) return;
  var doc = root.document;
  function H() { return root.__sdGenUIHost || null; }
  function F() { return root.__sdGenUIFrame || null; }
  function bn() { try { var l = (doc.documentElement.lang || root.navigator.language || '').toLowerCase(); return l.indexOf('bn') === 0; } catch (_) { return false; } }
  function t(en, b) { return bn() ? b : en; }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }

  /* ---------------- icons (lucide-style strokes) ---------------- */
  var ICONS = {
    x: 'M18 6 6 18M6 6l12 12', eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    code: 'm16 18 6-6-6-6M8 6l-6 6 6 6', copy: 'M9 9h11v11H9zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    check: 'M20 6 9 17l-5-5', chevron: 'm6 9 6 6 6-6', download: 'M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
    share: 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13', expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5', sparkle: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    more: 'M5 12h.01M12 12h.01M19 12h.01', file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
    image: 'M4 4h16v16H4zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-5-5L4 20', app: 'M3 5h18v14H3zM3 9h18M7 7h.01M10 7h.01',
    diagram: 'M6 3h4v4H6zM14 17h4v4h-4zM14 3h4v4h-4zM8 7v4a2 2 0 0 0 2 2h6v4M16 7v6', terminal: 'm4 17 6-5-6-5M12 19h8', table: 'M3 4h18v16H3zM3 10h18M3 15h18M9 4v16',
    plug: 'M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5', alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18.3A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0z',
    back: 'm15 18-6-6 6-6', send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z'
  };
  function icon(name, size) {
    var NS = 'http://www.w3.org/2000/svg', s = doc.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', String(size || 18)); s.setAttribute('height', String(size || 18));
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    var p = doc.createElementNS(NS, 'path'); p.setAttribute('d', ICONS[name] || ICONS.file); s.appendChild(p);
    return s;
  }
  function iconButton(name, label, fn, cls) {
    var b = el('button', 'sd-ib' + (cls ? ' ' + cls : '')); b.type = 'button';
    b.setAttribute('aria-label', label); b.title = label; b.appendChild(icon(name));
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(e, b); });
    return b;
  }

  /* ---------------- kinds ---------------- */
  var EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', html: 'html', css: 'css', json: 'json', jsonl: 'jsonl', json5: 'json5', java: 'java', kotlin: 'kt', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', swift: 'swift', bash: 'sh', shell: 'sh', sh: 'sh', sql: 'sql', yaml: 'yaml', yml: 'yml', toml: 'toml', ini: 'ini', env: 'env', dotenv: 'env', properties: 'properties', conf: 'conf', config: 'conf', csv: 'csv', tsv: 'tsv', graphql: 'graphql', gql: 'gql', proto: 'proto', protobuf: 'proto', dockerfile: 'dockerfile', makefile: 'makefile', ipynb: 'ipynb', ps1: 'ps1', powershell: 'ps1', mermaid: 'mmd', svg: 'svg', jsx: 'jsx', tsx: 'tsx', markdown: 'md', md: 'md', xml: 'xml', dart: 'dart', lua: 'lua', r: 'r', scala: 'scala', perl: 'pl', haskell: 'hs', elixir: 'ex', zig: 'zig', groovy: 'groovy', gradle: 'gradle', kts: 'kts', bat: 'bat', batch: 'bat', log: 'log', diff: 'diff', txt: 'txt' };
  function describe(kind, payload) {
    payload = payload || {};
    switch (kind) {
      case 'html-app': return { label: t('Interactive artifact', 'ইন্টারঅ্যাকটিভ আর্টিফ্যাক্ট'), short: 'HTML', icon: 'app', preview: true, lang: 'html', ext: 'html', mime: 'text/html' };
      case 'react': return { label: t('Interactive artifact', 'ইন্টারঅ্যাকটিভ আর্টিফ্যাক্ট'), short: 'React', icon: 'app', preview: true, lang: 'jsx', ext: 'jsx', mime: 'text/plain' };
      case 'svg': return { label: t('Image', 'ছবি'), short: 'SVG', icon: 'image', preview: true, lang: 'xml', ext: 'svg', mime: 'image/svg+xml' };
      case 'mermaid': return { label: t('Diagram', 'ডায়াগ্রাম'), short: 'Mermaid', icon: 'diagram', preview: true, lang: 'mermaid', ext: 'mmd', mime: 'text/plain' };
      case 'document': return { label: t('Document', 'ডকুমেন্ট'), short: 'MD', icon: 'file', preview: true, lang: 'markdown', ext: 'md', mime: 'text/plain' };
      case 'ui': return { label: t('Interactive widget', 'ইন্টারঅ্যাকটিভ উইজেট'), short: 'UI', icon: 'app', preview: true, lang: 'json', ext: 'json', mime: 'application/json' };
      case 'visual': return { label: t('Visual', 'ভিজুয়াল'), short: 'HTML', icon: 'image', preview: true, lang: 'html', ext: 'html', mime: 'text/html' };
      case 'mcp-app': return { label: t('MCP app', 'MCP অ্যাপ'), short: 'MCP', icon: 'plug', preview: true, lang: 'html', ext: 'html', mime: 'text/html' };
      default: {
        var l = String(payload.language || 'text').toLowerCase();
        return { label: t('Code', 'কোড'), short: l ? l.toUpperCase() : 'TEXT', icon: 'terminal', preview: false, lang: l, ext: EXT[l] || 'txt', mime: 'text/plain' };
      }
    }
  }
  /** The text shown in the Code tab / copied / downloaded. */
  function sourceOf(v) {
    var p = v.payload || {};
    switch (v.kind) {
      case 'html-app': return p.source || composeHtml(p);
      case 'svg': return p.svg || '';
      case 'document': return p.markdown || '';
      case 'code': return p.code || '';
      case 'mermaid': case 'react': case 'visual': case 'mcp-app': return p.source || '';
      case 'ui': try { return JSON.stringify(p.spec, null, 2); } catch (_) { return ''; }
      default: return p.source || '';
    }
  }
  function composeHtml(p) {
    var parts = [];
    if (p.css) parts.push('<style>\n' + p.css + '\n</style>');
    parts.push(p.html || '');
    if (p.js) parts.push('<script>\n' + p.js + '\n<\/script>');
    return parts.join('\n');
  }
  function frameKind(kind) { return kind === 'html-app' ? 'html' : kind === 'visual' ? 'visual' : kind; }

  /* ---------------- store (versions) ---------------- */
  var KEY = 'sd_genui_artifacts_v2', MAX_RECORDS = 40, MAX_VERSIONS = 12, MAX_BYTES = 900000;
  var records = null, listeners = Object.create(null), persistTimer = null;
  function sget(k) { try { var b = root.AndroidBridge; return b && b.getStorage ? b.getStorage(k) : root.localStorage.getItem(k); } catch (_) { return null; } }
  function sset(k, v) { try { var b = root.AndroidBridge; if (b && b.setStorage) b.setStorage(k, v); else root.localStorage.setItem(k, v); } catch (_) {} }
  function hash(s) { var n = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { n ^= s.charCodeAt(i); n = Math.imul(n, 16777619); } return (n >>> 0).toString(36) + s.length.toString(36); }
  function chatKey() { var m = /\/s\/([A-Za-z0-9_-]{4,80})/.exec(String(root.location && root.location.pathname || '')); return m ? m[1] : 'chat'; }
  function load() {
    if (records) return records;
    records = Object.create(null);
    try {
      var raw = JSON.parse(sget(KEY) || 'null');
      if (raw && raw.version === 2 && Array.isArray(raw.items)) raw.items.forEach(function (r) { if (r && typeof r.key === 'string' && Array.isArray(r.versions)) records[r.key] = r; });
    } catch (_) {}
    return records;
  }
  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      var items = Object.keys(load()).map(function (k) { return records[k]; }).sort(function (a, b) { return b.updated - a.updated; }).slice(0, MAX_RECORDS);
      var out = [], bytes = 0;
      for (var i = 0; i < items.length; i++) {
        var s = JSON.stringify(items[i]);
        if (bytes + s.length > MAX_BYTES) continue;
        bytes += s.length; out.push(items[i]);
      }
      sset(KEY, JSON.stringify({ version: 2, items: out }));
    }, 500);
  }
  /** Adds a version unless identical content already exists. Returns { record, index }. */
  function upsert(id, v) {
    load();
    var key = chatKey() + ':' + id;
    var r = records[key];
    var src = sourceOf(v), h = hash(v.kind + '\u0000' + src);
    if (!r) r = records[key] = { key: key, id: id, chat: chatKey(), versions: [], created: Date.now(), updated: Date.now() };
    var idx = -1;
    for (var i = 0; i < r.versions.length; i++) if (r.versions[i].hash === h) { idx = i; break; }
    if (idx < 0) {
      r.versions.push({ kind: v.kind, title: v.title || 'Artifact', payload: v.payload, revision: v.revision || r.versions.length + 1, hash: h, at: Date.now() });
      if (r.versions.length > MAX_VERSIONS) r.versions.splice(0, r.versions.length - MAX_VERSIONS);
      idx = r.versions.length - 1;
      r.updated = Date.now();
      persist();
      notify(key);
    }
    r.title = r.versions[r.versions.length - 1].title;
    r.kind = r.versions[r.versions.length - 1].kind;
    return { record: r, index: idx };
  }
  function getRecord(key) { return load()[key] || null; }
  function listRecords() { load(); return Object.keys(records).map(function (k) { return records[k]; }).sort(function (a, b) { return b.updated - a.updated; }); }
  function removeRecord(key) { load(); delete records[key]; persist(); notify(key); }
  function subscribe(key, fn) { (listeners[key] = listeners[key] || []).push(fn); return function () { listeners[key] = (listeners[key] || []).filter(function (f) { return f !== fn; }); }; }
  function notify(key) { (listeners[key] || []).slice().forEach(function (fn) { try { fn(); } catch (_) {} }); }

  /* ---------------- code highlighting ---------------- */
  var KW = {
    js: 'await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async true false null undefined',
    py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self',
    c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected new delete this true false null fun val var package import interface extends implements override namespace using template typename func go type struct map chan defer select range fn let mut impl pub use mod match',
    sql: 'select from where and or not insert into values update set delete create table drop alter join left right inner outer on group by order having limit offset as distinct null is in like primary key foreign references index'
  };
  function family(lang) {
    lang = String(lang || '').toLowerCase();
    if (/^(html|xml|svg|xhtml|vue)$/.test(lang)) return 'markup';
    if (lang === 'css' || lang === 'scss' || lang === 'less') return 'css';
    if (lang === 'json') return 'json';
    if (/^(py|python|rb|ruby|sh|bash|shell|zsh|yaml|yml|r|toml|ini|mermaid)$/.test(lang)) return 'hash';
    if (lang === 'sql') return 'sql';
    if (lang === 'markdown' || lang === 'md') return 'md';
    return 'js';
  }
  function tokenRe(fam) {
    switch (fam) {
      case 'markup': return /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][\w:.-]*)|(\s[A-Za-z_:][\w:.-]*)(?==)|("[^"]*"|'[^']*')|(\/?>)|(&[#\w]+;)/g;
      case 'css': return /(\/\*[\s\S]*?\*\/)|("[^"\n]*"|'[^'\n]*')|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b)|([\w-]+)(?=\s*:[^;{]*[;}])|(@[\w-]+)|([.#]?[A-Za-z_][\w-]*)(?=[^{}]*\{)/g;
      case 'json': return /("(?:[^"\\\n]|\\.)*")(?=\s*:)|("(?:[^"\\\n]|\\.)*")|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g;
      case 'hash': return /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)(?=\s*\()|(\b[A-Za-z_]\w*\b)/g;
      case 'sql': return /(--[^\n]*)|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)(?=\s*\()|(\b[A-Za-z_]\w*\b)/g;
      case 'md': return /(^#{1,6} [^\n]*)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(^\s*[-*+] |^\s*\d+\. )|(\[[^\]\n]*\]\([^)\n]*\))/gm;
      default: return /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)(?=\s*\()|(<\/?[A-Z][\w.]*|<\/?[a-z][\w-]*(?=[\s>/]))|(\b[A-Za-z_$][\w$]*\b)/g;
    }
  }
  var CLASSES = {
    markup: ['c', 'tag', 'attr', 'str', 'tag', 'num'], css: ['c', 'str', 'num', 'attr', 'kw', 'tag'], json: ['attr', 'str', 'num', 'kw'],
    hash: ['c', 'str', 'num', 'fn', 'id'], sql: ['c', 'str', 'num', 'fn', 'id'], md: ['kw', 'str', 'tag', 'num', 'fn'], js: ['c', 'str', 'num', 'fn', 'tag', 'id']
  };
  function highlight(code, lang) {
    var fam = family(lang), re = tokenRe(fam), cls = CLASSES[fam], frag = doc.createDocumentFragment();
    var kw = fam === 'hash' ? KW.py : fam === 'sql' ? KW.sql : (/^(c|cpp|java|kotlin|kt|go|rust|rs|swift|cs|csharp|dart)$/.test(String(lang)) ? KW.c : KW.js);
    var kwSet = Object.create(null); kw.split(' ').forEach(function (w) { kwSet[w] = 1; kwSet[w.toUpperCase()] = fam === 'sql' ? 1 : kwSet[w.toUpperCase()]; });
    var s = String(code), last = 0, m, guard = 0;
    if (s.length > 200000) { frag.appendChild(doc.createTextNode(s)); return frag; }
    while ((m = re.exec(s)) && guard++ < 60000) {
      if (m[0] === '') { re.lastIndex++; continue; }
      var gi = 1; while (gi < m.length && m[gi] === undefined) gi++;
      var c = cls[gi - 1] || '';
      if (c === 'id') { if (!kwSet[m[0]]) continue; c = 'kw'; }
      if (m.index > last) frag.appendChild(doc.createTextNode(s.slice(last, m.index)));
      var sp = el('span', 'sd-hl-' + c); sp.textContent = m[0]; frag.appendChild(sp);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
    return frag;
  }
  function codeView(code, lang) {
    var wrap = el('div', 'sd-code'), gutter = el('div', 'sd-code-gutter'), pre = el('pre', 'sd-code-pre'), c = el('code');
    var lines = String(code).split('\n').length;
    var nums = []; for (var i = 1; i <= lines; i++) nums.push(i);
    gutter.textContent = nums.join('\n'); gutter.setAttribute('aria-hidden', 'true');
    c.appendChild(highlight(code, lang)); pre.appendChild(c);
    wrap.append(gutter, pre);
    return wrap;
  }

  /* ---------------- markdown (documents) — DOM built with textContent only ---------------- */
  function inline(target, text) {
    var re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(~~[^~]+~~)/g, last = 0, m;
    text = String(text);
    while ((m = re.exec(text))) {
      if (m.index > last) target.appendChild(doc.createTextNode(text.slice(last, m.index)));
      var tok = m[0], n;
      if (m[1]) n = el('code', null, tok.slice(1, -1));
      else if (m[2]) { n = el('strong'); inline(n, tok.slice(2, -2)); }
      else if (m[3]) { n = el('em'); inline(n, tok.slice(1, -1)); }
      else if (m[4]) { n = el('a', null, /^\[([^\]]+)\]/.exec(tok)[1]); n.href = m[5]; n.target = '_blank'; n.rel = 'noopener noreferrer'; }
      else if (m[6]) n = el('del', null, tok.slice(2, -2));
      target.appendChild(n); last = m.index + tok.length;
    }
    if (last < text.length) target.appendChild(doc.createTextNode(text.slice(last)));
  }
  function markdown(src) {
    var out = el('div', 'sd-md'), lines = String(src).replace(/\r/g, '').split('\n'), i = 0;
    function isTableSep(l) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l); }
    function cells(l) { return l.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); }); }
    while (i < lines.length) {
      var l = lines[i];
      if (!l.trim()) { i++; continue; }
      var fm = /^```\s*([\w+#.-]*)/.exec(l);
      if (fm) {
        var buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        var pre = el('pre', 'sd-md-pre'), code = el('code'); code.appendChild(highlight(buf.join('\n'), fm[1])); pre.appendChild(code); out.appendChild(pre);
        continue;
      }
      var hm = /^(#{1,6})\s+(.*)$/.exec(l);
      if (hm) { var h = el('h' + hm[1].length); inline(h, hm[2]); out.appendChild(h); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { out.appendChild(el('hr')); i++; continue; }
      if (/^\s*>/.test(l)) {
        var q = el('blockquote'), qb = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) qb.push(lines[i++].replace(/^\s*>\s?/, ''));
        var qp = el('p'); inline(qp, qb.join(' ')); q.appendChild(qp); out.appendChild(q); continue;
      }
      if (/\|/.test(l) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var tw = el('div', 'sd-md-table'), table = el('table'), thead = el('thead'), tr = el('tr');
        cells(l).forEach(function (c) { var th = el('th'); inline(th, c); tr.appendChild(th); });
        thead.appendChild(tr); table.appendChild(thead);
        var tb = el('tbody'); i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          var r = el('tr'); cells(lines[i++]).forEach(function (c) { var td = el('td'); inline(td, c); r.appendChild(td); }); tb.appendChild(r);
        }
        table.appendChild(tb); tw.appendChild(table); out.appendChild(tw); continue;
      }
      var lm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
      if (lm) {
        var ordered = /\d/.test(lm[2]), list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          var m2 = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m2) { if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && list.lastChild) { list.lastChild.appendChild(doc.createTextNode(' ')); inline(list.lastChild, lines[i].trim()); i++; continue; } break; }
          var li = el('li'), task = /^\[([ xX])\]\s+(.*)$/.exec(m2[3]);
          if (task) { var cb = el('input'); cb.type = 'checkbox'; cb.disabled = true; cb.checked = task[1] !== ' '; li.appendChild(cb); li.appendChild(doc.createTextNode(' ')); inline(li, task[2]); }
          else inline(li, m2[3]);
          list.appendChild(li); i++;
        }
        out.appendChild(list); continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      var p = el('p'); inline(p, para.join(' ')); out.appendChild(p);
    }
    return out;
  }

  /* ---------------- viewer ---------------- */
  var current = null; // { key, rec, index, mode, ctrl, root, unsub, live }
  function isWide() { try { return root.innerWidth >= 960; } catch (_) { return false; } }
  function toast(text) {
    var old = doc.getElementById('sd-toast'); if (old) old.remove();
    var n = el('div', 'sd-toast', text); n.id = 'sd-toast'; n.setAttribute('role', 'status');
    doc.body.appendChild(n);
    setTimeout(function () { n.classList.add('sd-out'); setTimeout(function () { n.remove(); }, 300); }, 1800);
  }
  function copyText(text) {
    return new Promise(function (ok, no) {
      function legacy() {
        try { var ta = el('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; doc.body.appendChild(ta); ta.select(); var r = doc.execCommand('copy'); ta.remove(); if (r) ok(); else no(Error('Copy failed')); } catch (e) { no(e); }
      }
      try { if (root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(text).then(ok, legacy); else legacy(); } catch (_) { legacy(); }
    });
  }
  var EXT_FAMILY = { md:'markdown',markdown:'markdown',js:'javascript',javascript:'javascript',ts:'typescript',typescript:'typescript',py:'python',python:'python',kt:'kotlin',kotlin:'kotlin',sh:'shell',bash:'shell',shell:'shell',yaml:'yaml',yml:'yaml',gql:'graphql',graphql:'graphql',proto:'protobuf',protobuf:'protobuf',ps1:'powershell',powershell:'powershell',pl:'perl',perl:'perl',hs:'haskell',haskell:'haskell',ex:'elixir',elixir:'elixir',csv:'csv',tsv:'tsv',json:'json',jsonl:'jsonl',json5:'json5',toml:'toml',ini:'ini',xml:'xml',html:'html',htm:'html',css:'css',sql:'sql',ipynb:'ipynb',dockerfile:'dockerfile',makefile:'makefile',env:'env',properties:'properties',conf:'conf',gradle:'gradle',kts:'kts',diff:'diff',log:'log',txt:'txt',pdf:'pdf',docx:'docx',xlsx:'xlsx',pptx:'pptx' };
  var SAFE_EXT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
  function fileName(title, ext) {
    var raw = String(title || 'artifact').trim(), extension = String(ext || 'txt').replace(/^\./, '').toLowerCase() || 'txt';
    raw = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[ .]+$/g, '');
    if (!raw) raw = 'artifact';
    if (extension === 'dockerfile' && /^dockerfile$/i.test(raw)) return 'Dockerfile';
    if (extension === 'makefile' && /^makefile$/i.test(raw)) return 'Makefile';
    if (extension === 'env' && /^\.env(?:\.[a-z0-9_-]+)?$/i.test(raw)) return raw;
    var dot = raw.lastIndexOf('.'), suffix = dot > 0 ? raw.slice(dot + 1).toLowerCase() : '';
    if (suffix && SAFE_EXT.test(suffix) && EXT_FAMILY[suffix] && EXT_FAMILY[suffix] === (EXT_FAMILY[extension] || extension)) return raw;
    if (suffix && SAFE_EXT.test(suffix) && (EXT[suffix] || ['pdf','docx','xlsx','pptx','exe','apk','zip'].indexOf(suffix) >= 0)) raw = dot > 0 ? raw.slice(0, dot) : raw;
    return (raw || 'artifact') + '.' + extension;
  }

  function versionData(rec, index) { return rec.versions[Math.max(0, Math.min(rec.versions.length - 1, index))]; }

  function buildFrameFor(v, mode) {
    var Fr = F(); if (!Fr) return null;
    var ctrl = Fr.create({ kind: frameKind(v.kind), mode: mode, title: v.title });
    return ctrl;
  }

  function close() {
    if (!current) return;
    var c = current; current = null;
    try { if (c.ctrl) c.ctrl.destroy(); } catch (_) {}
    try { if (c.unsub) c.unsub(); } catch (_) {}
    c.root.classList.add('sd-closing'); c.root.removeAttribute('id'); c.root.setAttribute('aria-hidden', 'true');
    doc.documentElement.classList.remove('sd-viewer-open', 'sd-viewer-split');
    setTimeout(function () { c.root.remove(); }, 180);
  }

  /** Opens the viewer. src: { key } for stored artifacts, or { live: {kind,title,payload}, key? } for transient content. */
  function open(src, opts) {
    opts = opts || {};
    close();
    var rec = src.key ? getRecord(src.key) : null;
    if (!rec && src.live) rec = { key: src.key || ('live:' + Date.now()), id: 'live', versions: [src.live], live: true };
    if (!rec || !rec.versions.length) return null;
    var index = typeof opts.version === 'number' ? opts.version : rec.versions.length - 1;
    var wide = isWide();
    var overlay = el('div', 'sd-viewer' + (wide ? ' sd-viewer-wide' : ''));
    overlay.id = 'sd-viewer'; overlay.setAttribute('data-sd-owned', 'viewer'); overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', wide ? 'false' : 'true');
    var panel = el('div', 'sd-viewer-panel');
    var header = el('div', 'sd-viewer-head');
    var body = el('div', 'sd-viewer-body');
    var status = el('div', 'sd-viewer-status'); status.hidden = true;
    panel.append(header, body, status);
    overlay.appendChild(panel);
    current = { key: rec.key, rec: rec, index: index, mode: opts.mode || 'preview', root: overlay, body: body, header: header, status: status, streamingText: null, userPicked: false, onEdit: opts.onEdit };

    function v() { return versionData(current.rec, current.index); }
    function info() { return describe(v().kind, v().payload); }

    // --- header ---
    var closeBtn = iconButton('x', t('Close', 'বন্ধ'), close, 'sd-viewer-close');
    var titleWrap = el('div', 'sd-viewer-titles');
    var title = el('div', 'sd-viewer-title');
    var verBtn = el('button', 'sd-viewer-ver'); verBtn.type = 'button';
    titleWrap.append(title, verBtn);
    var seg = el('div', 'sd-seg'); seg.setAttribute('role', 'tablist');
    var segPrev = el('button', 'sd-seg-btn'); segPrev.type = 'button'; segPrev.setAttribute('role', 'tab'); segPrev.title = t('Preview', 'প্রিভিউ'); segPrev.setAttribute('aria-label', segPrev.title); segPrev.appendChild(icon('eye', 16));
    var segCode = el('button', 'sd-seg-btn'); segCode.type = 'button'; segCode.setAttribute('role', 'tab'); segCode.title = t('Code', 'কোড'); segCode.setAttribute('aria-label', segCode.title); segCode.appendChild(icon('code', 16));
    seg.append(segPrev, segCode);
    var copyGroup = el('div', 'sd-copy-group');
    var copyBtn = el('button', 'sd-copy-btn'); copyBtn.type = 'button';
    copyBtn.append(icon('copy', 15), el('span', null, t('Copy', 'কপি')));
    var menuBtn = iconButton('chevron', t('More actions', 'আরও'), function () { toggleMenu(); }, 'sd-copy-more');
    copyGroup.append(copyBtn, menuBtn);
    var menu = el('div', 'sd-menu'); menu.hidden = true; menu.setAttribute('role', 'menu');
    var verMenu = el('div', 'sd-menu sd-ver-menu'); verMenu.hidden = true; verMenu.setAttribute('role', 'menu');
    header.append(closeBtn, titleWrap, seg, copyGroup, menu, verMenu);

    segPrev.addEventListener('click', function () { current.userPicked = true; setMode('preview'); });
    segCode.addEventListener('click', function () { current.userPicked = true; setMode('code'); });
    copyBtn.addEventListener('click', function () {
      copyText(current.streamingText != null ? current.streamingText : sourceOf(v())).then(function () {
        copyBtn.classList.add('sd-done'); copyBtn.lastChild.textContent = t('Copied', 'কপি হয়েছে');
        setTimeout(function () { copyBtn.classList.remove('sd-done'); copyBtn.lastChild.textContent = t('Copy', 'কপি'); }, 1600);
      }, function () { toast(t('Copy failed', 'কপি ব্যর্থ')); });
    });
    verBtn.addEventListener('click', function (e) { e.stopPropagation(); if (current.rec.versions.length > 1) toggleVerMenu(); });
    overlay.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) menu.hidden = true;
      if (!verMenu.contains(e.target) && e.target !== verBtn && !verBtn.contains(e.target)) verMenu.hidden = true;
      if (e.target === overlay && !wide) close();
    });

    function menuItem(target, ic, label, fn) {
      var b = el('button', 'sd-menu-item'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.append(icon(ic, 16), el('span', null, label));
      b.addEventListener('click', function (e) { e.stopPropagation(); target.hidden = true; fn(); });
      target.appendChild(b); return b;
    }
    function toggleMenu() {
      verMenu.hidden = true;
      if (!menu.hidden) { menu.hidden = true; return; }
      menu.textContent = '';
      var i = info(), vv = v(), name = fileName(vv.title, i.ext), Ho = H();
      menuItem(menu, 'download', t('Download', 'ডাউনলোড') + ' (.' + i.ext + ')', function () { download(vv, i.ext, i.mime); });
      if (vv.kind === 'svg') menuItem(menu, 'image', t('Download as PNG', 'PNG হিসেবে ডাউনলোড'), function () { downloadPng(vv); });
      if (vv.kind === 'mermaid' || vv.kind === 'react' || vv.kind === 'visual') menuItem(menu, 'download', t('Download as HTML', 'HTML হিসেবে ডাউনলোড'), function () { downloadStandalone(vv); });
      menuItem(menu, 'share', t('Share', 'শেয়ার'), function () {
        if (!Ho) return;
        try { var r = Ho.shareText(sourceOf(vv), i.mime === 'image/svg+xml' ? 'image/svg+xml' : (i.mime === 'text/html' ? 'text/html' : 'text/plain'), name, vv.title); if (r && r.redacted) toast(r.redacted + ' ' + t('secret(s) removed', 'গোপন তথ্য সরানো হয়েছে')); } catch (_) { toast(t('Share unavailable', 'শেয়ার করা যাচ্ছে না')); }
      });
      if (i.preview && vv.kind !== 'document' && vv.kind !== 'ui') menuItem(menu, 'expand', t('Open in full screen', 'ফুল স্ক্রিনে খুলুন'), function () { openNative(vv); });
      if (i.preview && vv.kind !== 'document') menuItem(menu, 'refresh', t('Re-run', 'আবার চালান'), function () { render(true); });
      if (!current.rec.live) menuItem(menu, 'sparkle', t('Edit with AI…', 'AI দিয়ে এডিট…'), function () { editWithAi(); });
      menuItem(menu, 'settings', t('Generative UI settings', 'জেনারেটিভ UI সেটিংস'), function () { close(); if (root.__sdGenUIPanel) root.__sdGenUIPanel.open(); });
      menu.hidden = false;
    }
    function toggleVerMenu() {
      menu.hidden = true;
      if (!verMenu.hidden) { verMenu.hidden = true; return; }
      verMenu.textContent = '';
      for (var k = current.rec.versions.length - 1; k >= 0; k--) (function (k) {
        var item = menuItem(verMenu, k === current.index ? 'check' : 'file', t('Version ', 'ভার্সন ') + (k + 1) + (k === current.rec.versions.length - 1 ? t(' · latest', ' · সর্বশেষ') : ''), function () { current.index = k; refreshHeader(); render(true); });
        if (k === current.index) item.classList.add('sd-active');
      })(k);
      verMenu.hidden = false;
    }
    function refreshHeader() {
      var vv = v(), i = info(), n = current.rec.versions.length;
      title.textContent = vv.title || 'Artifact';
      verBtn.textContent = '';
      verBtn.appendChild(el('span', null, (current.streamingText != null ? t('Generating…', 'তৈরি হচ্ছে…') : i.label + ' · ' + i.short) + (n > 1 ? ' · v' + (current.index + 1) : '')));
      if (n > 1) verBtn.appendChild(icon('chevron', 14));
      verBtn.disabled = n < 2;
      seg.hidden = !i.preview;
      segPrev.classList.toggle('sd-on', current.mode === 'preview'); segPrev.setAttribute('aria-selected', String(current.mode === 'preview'));
      segCode.classList.toggle('sd-on', current.mode === 'code'); segCode.setAttribute('aria-selected', String(current.mode === 'code'));
    }
    function setMode(m) { if (current.mode === m) return; current.mode = m; refreshHeader(); render(false); }

    function render(force) {
      var vv = v(), i = info();
      if (!i.preview) current.mode = 'code';
      if (current.ctrl && (force || current.mode !== 'preview')) { current.ctrl.destroy(); current.ctrl = null; }
      body.textContent = '';
      body.className = 'sd-viewer-body sd-mode-' + current.mode;
      status.hidden = true;
      if (current.streamingText != null) {
        body.appendChild(codeView(current.streamingText, i.lang));
        body.scrollTop = body.scrollHeight;
        return;
      }
      if (current.mode === 'code') { body.appendChild(codeView(sourceOf(vv), i.lang)); return; }
      if (vv.kind === 'document') { var md = markdown(sourceOf(vv)); body.appendChild(md); return; }
      if (vv.kind === 'ui' && root.__sdGenUI) {
        try {
          var parsed = root.__sdGenUI.parseSpec(vv.payload.spec);
          if (!parsed.ok) throw Error(parsed.error);
          var surface = root.__sdGenUI.renderSpec(parsed.spec); var pad = el('div', 'sd-viewer-pad'); pad.appendChild(surface); body.appendChild(pad);
          root.__sdGenUI.updateSurface(surface.__sdGenUIScope);
        } catch (e) { body.appendChild(el('div', 'sd-viewer-error', String(e.message || e))); }
        return;
      }
      if (vv.kind === 'mcp-app' && opts.mountMcp) { opts.mountMcp(body); return; }
      var ctrl = buildFrameFor(vv, 'fullscreen');
      if (!ctrl) { body.appendChild(codeView(sourceOf(vv), i.lang)); return; }
      current.ctrl = ctrl;
      ctrl.frame.classList.add('sd-viewer-frame');
      ctrl.on('error', function (msg) { showStatus('alert', t('The artifact reported an error: ', 'আর্টিফ্যাক্টে ত্রুটি: ') + msg, t('Fix with AI', 'AI দিয়ে ঠিক করুন'), function (e) { fixWithAi(msg, e); }); });
      ctrl.on('prompt', function (text, tapped) { promptFromFrame(text, tapped, showStatus); });
      ctrl.on('link', function (url, tapped) { linkFromFrame(url, showStatus); });
      body.appendChild(ctrl.frame);
      var booted = false;
      ctrl.on('boot', function () { booted = true; });
      ctrl.load(vv.kind === 'svg' ? vv.payload.svg : sourceOf(vv));
      setTimeout(function () {
        if (booted || !current || current.ctrl !== ctrl) return;
        showStatus('alert', t('The preview could not start here (blocked by the page).', 'প্রিভিউ এখানে চালু হয়নি (পেজ ব্লক করেছে)।'), t('Open full screen', 'ফুল স্ক্রিনে খুলুন'), function () { openNative(vv); });
      }, 6000);
    }
    function showStatus(ic, text, action, fn) {
      status.textContent = ''; status.hidden = false;
      status.append(icon(ic, 16), el('span', 'sd-viewer-status-text', text));
      if (action) { var b = el('button', 'sd-chip', action); b.type = 'button'; b.addEventListener('click', function (e) { fn(e); status.hidden = true; }); status.appendChild(b); }
      status.appendChild(iconButton('x', t('Dismiss', 'বন্ধ'), function () { status.hidden = true; }, 'sd-ib-sm'));
    }
    function editWithAi() {
      var vv = v(), Ho = H(); if (!Ho) return;
      var text = t('Update the artifact "', 'আর্টিফ্যাক্ট "') + (vv.title || current.rec.id) + t('" (id: ', '" (id: ') + current.rec.id + t(', version ', ', ভার্সন ') + (current.index + 1) + t('). Keep the same id and return the complete new version. Change: ', ')। একই id রেখে সম্পূর্ণ নতুন ভার্সন দাও। পরিবর্তন: ');
      close();
      var r = Ho.sendPrompt(text, { label: 'Edit artifact' });
      if (!r.ok) toast(r.error);
    }
    function fixWithAi(msg, e) {
      var vv = v(), Ho = H(); if (!Ho) return;
      var text = 'The artifact "' + (vv.title || current.rec.id) + '" (id: ' + current.rec.id + ') shows this error: ' + msg + '\nFix it and return the complete corrected version with the same id.';
      close();
      var r = Ho.sendPrompt(text, { label: 'Fix artifact', submit: true, event: e });
      if (!r.ok) toast(r.error);
    }

    current.refresh = function () { refreshHeader(); render(true); };
    current.stream = function (text, done) {
      if (done) {
        current.streamingText = null;
        current.rec = getRecord(current.key) || current.rec;
        current.index = current.rec.versions.length - 1;
        if (!current.userPicked && info().preview) current.mode = 'preview';
        refreshHeader(); render(true);
        return;
      }
      var first = current.streamingText == null;
      current.streamingText = text;
      if (first) { current.mode = 'code'; refreshHeader(); }
      render(false);
    };
    if (!rec.live) current.unsub = subscribe(rec.key, function () {
      if (!current || current.key !== rec.key) return;
      var fresh = getRecord(rec.key); if (!fresh) { close(); return; }
      var wasLatest = current.index === current.rec.versions.length - 1;
      current.rec = fresh;
      if (wasLatest && current.streamingText == null) { current.index = fresh.versions.length - 1; refreshHeader(); render(true); } else refreshHeader();
    });
    if (opts.streamingText != null) current.streamingText = opts.streamingText;
    refreshHeader();
    doc.body.appendChild(overlay);
    doc.documentElement.classList.add('sd-viewer-open');
    if (wide) doc.documentElement.classList.add('sd-viewer-split'); // Claude split view: chat reflows to the left
    render(true);
    try { closeBtn.focus({ preventScroll: true }); } catch (_) {}
    return current;
  }

  /* ---------------- exports ---------------- */
  function standaloneHtml(v) {
    var Fr = F(); if (!Fr) return sourceOf(v);
    // Standalone file: host boot/CSP stripped by building with the full-screen mode;
    // the boot script is harmless outside a frame (posts to itself).
    return Fr.buildDocument({ kind: frameKind(v.kind), source: v.kind === 'svg' ? v.payload.svg : sourceOf(v), mode: 'fullscreen', channel: 'standalone' });
  }
  function download(v, ext, mime) {
    var Ho = H(); if (!Ho) return;
    var text = sourceOf(v);
    if (v.kind === 'html-app' && !(F() && F().isFullDocument(text))) text = standaloneHtml(v);
    var r = Ho.exportText(text, mime === 'text/html' ? 'text/html' : (mime === 'image/svg+xml' ? 'image/svg+xml' : (mime === 'application/json' ? 'application/json' : 'text/plain')), fileName(v.title, ext));
    toast((r && r.via === 'native' ? t('Saved to Downloads', 'ডাউনলোডসে সংরক্ষিত') : t('Download started', 'ডাউনলোড শুরু হয়েছে')) + (r && r.redacted ? ' · ' + r.redacted + t(' secret(s) removed', 'টি গোপন তথ্য সরানো') : ''));
  }
  function downloadStandalone(v) {
    var Ho = H(); if (!Ho) return;
    var r = Ho.exportText(standaloneHtml(v), 'text/html', fileName(v.title, 'html'));
    toast((r && r.via === 'native' ? t('Saved to Downloads', 'ডাউনলোডসে সংরক্ষিত') : t('Download started', 'ডাউনলোড শুরু হয়েছে')) + (r && r.redacted ? ' · ' + r.redacted + t(' secret(s) removed', 'টি গোপন তথ্য সরানো') : ''));
  }
  function downloadPng(v) {
    var Ho = H(); if (!Ho || !Ho.svgToPng) return;
    var svg = v.payload.svg;
    try { var S = root.__sdGenUISvg; if (S && S.parse) { var s = S.parse(svg, 'png'); if (!s || !s.ok) throw Error(s && s.error || 'Invalid SVG'); svg = S.serialize(s.root || s.node || s.svg); } } catch (e) { toast(String(e.message || e)); return; }
    Ho.svgToPng(svg, 2048).then(function (b64) { Ho.downloadBase64(b64, 'image/png', fileName(v.title, 'png')); toast(t('PNG saved', 'PNG সংরক্ষিত')); }, function (e) { toast(String(e.message || e)); });
  }
  function openNative(v) {
    var b = root.AndroidBridge;
    if (!b || typeof b.openGeneratedApp !== 'function') { toast(t('Full screen viewer unavailable here', 'ফুল স্ক্রিন ভিউয়ার পাওয়া যায়নি')); return; }
    var Ho = H(), html = standaloneHtml(v);
    if (Ho && typeof Ho.redact === 'function') html = Ho.redact(html).text;
    try { if (!b.openGeneratedApp(html)) toast(t('Could not open', 'খোলা যায়নি')); } catch (_) { toast(t('Could not open', 'খোলা যায়নি')); }
  }

  /* Frame → host requests (shared with inline visuals). */
  function promptFromFrame(text, tapped, show) {
    var Ho = H(); if (!Ho) return;
    var short = text.length > 90 ? text.slice(0, 89) + '…' : text;
    show('send', t('Send to chat: ', 'চ্যাটে পাঠাবেন: ') + '“' + short + '”', t('Send', 'পাঠান'), function (e) {
      var r = Ho.sendPrompt(text, { label: 'From visual', submit: true, event: e });
      if (!r.ok) toast(r.error);
    });
  }
  function linkFromFrame(url, show) {
    var u; try { u = new URL(url); } catch (_) { return; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
    show('share', t('Open link: ', 'লিংক খুলুন: ') + u.host, t('Open', 'খুলুন'), function () { try { root.open(u.href, '_blank', 'noopener'); } catch (_) {} });
  }

  // Android back closes the viewer first.
  var prevBack = root.__sdHandleBack;
  root.__sdHandleBack = function () {
    if (current) { close(); return true; }
    return typeof prevBack === 'function' ? prevBack() : false;
  };
  if (doc) doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && current) close(); });

  root.__sdGenUIViewer = {
    version: 1,
    open: open, close: close,
    current: function () { return current; },
    isOpen: function () { return !!current; },
    describe: describe, sourceOf: sourceOf, frameKind: frameKind,
    highlight: highlight, codeView: codeView, markdown: markdown,
    icon: icon, iconButton: iconButton, toast: toast, copyText: copyText, fileName: fileName,
    download: download, downloadPng: downloadPng, downloadStandalone: downloadStandalone, openNative: openNative, standaloneHtml: standaloneHtml,
    promptFromFrame: promptFromFrame, linkFromFrame: linkFromFrame,
    store: { upsert: upsert, get: getRecord, list: listRecords, remove: removeRecord, subscribe: subscribe, chatKey: chatKey, hash: hash, _reset: function () { records = null; } }
  };
})(window);
