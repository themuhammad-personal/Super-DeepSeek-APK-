/* Super DeepSeek — live sandboxed frames for Generative UI.
 *
 * Every model-authored HTML/SVG/React/Mermaid surface (inline visuals, Claude-style
 * artifacts, MCP Apps) runs in an <iframe sandbox="allow-scripts …"> WITHOUT
 * allow-same-origin: an opaque origin with no access to the chat page, its
 * cookies or storage. The native bridge is token-gated (BridgeGate.kt), so the
 * object Android injects into every frame is useless inside these frames.
 *
 * Host ⇄ frame traffic is postMessage only. The host accepts a message only when
 * `event.source` is the frame's own contentWindow; everything the frame asks for
 * (send a prompt, open a link, MCP tool calls) is validated and user-gated by the
 * trusted page.
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIFrame && root.__sdGenUIFrame.version === 1) return;
  var doc = root.document;

  var CDN_SCRIPT = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://esm.sh', 'https://cdn.tailwindcss.com'];
  var IMG_HOSTS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://upload.wikimedia.org', 'https://images.unsplash.com', 'https://raw.githubusercontent.com'];
  var SANDBOX = 'allow-scripts allow-forms allow-modals allow-pointer-lock';
  var MAX_INLINE_HEIGHT = 1800;

  function cspFor(kind, extra) {
    if (kind === 'mcp') {
      // MCP Apps spec 2026-01-26: restrictive default + only the domains the resource declared.
      var res = (extra && extra.resourceDomains) || [], con = (extra && extra.connectDomains) || [];
      var r = res.join(' '), c = con.join(' ');
      return "default-src 'none'; script-src 'unsafe-inline' " + r + "; style-src 'unsafe-inline' " + r + "; img-src data: blob: " + r +
        "; font-src data: " + r + "; media-src data: blob: " + r + "; connect-src " + (c || "'none'") + "; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    }
    var s = CDN_SCRIPT.join(' ');
    return "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: " + s +
      "; style-src 'unsafe-inline' " + s + " https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com " + s +
      "; img-src data: blob: " + IMG_HOSTS.join(' ') + "; media-src data: blob:; connect-src " + s +
      "; worker-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  }
  /** Only plain https origins (no paths, wildcards, credentials, local hosts) survive. */
  function cleanDomains(list) {
    var out = [];
    (Array.isArray(list) ? list : []).slice(0, 16).forEach(function (d) {
      var m = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{1,5})?\/?$/i.exec(String(d || '').trim());
      if (!m) return;
      var host = m[1].toLowerCase();
      if (/^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) return;
      var o = String(d).trim().replace(/\/$/, '').toLowerCase();
      if (out.indexOf(o) < 0) out.push(o);
    });
    return out;
  }

  /* ---------------- theme ---------------- */
  function theme() {
    try {
      var b = doc.body, h = doc.documentElement;
      if (b && b.classList.contains('dark')) return 'dark';
      if (b && b.classList.contains('light')) return 'light';
      var t = h && h.getAttribute('data-theme'); if (t === 'dark' || t === 'light') return t;
      if (h && h.classList.contains('dark')) return 'dark';
      return root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (_) { return 'light'; }
  }

  /* Design system shared by every generated surface (Claude/OpenGenerativeUI
   * pattern): transparent background, theme variables, pre-styled controls and
   * SVG colour ramps that work in light and dark. */
  var DESIGN_CSS = [
    ':root{--font-sans:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali","Noto Sans",sans-serif;--font-serif:Georgia,"Times New Roman",serif;--font-mono:ui-monospace,"SF Mono","Fira Code",Menlo,monospace;',
    '--border-radius-md:8px;--border-radius-lg:12px;--border-radius-xl:16px;',
    '--color-background-primary:#ffffff;--color-background-secondary:#f5f6f8;--color-background-tertiary:#eceef2;',
    '--color-background-info:#e8efff;--color-background-danger:#fcebeb;--color-background-success:#eaf3de;--color-background-warning:#faeeda;',
    '--color-text-primary:#1b1c1f;--color-text-secondary:#5f636b;--color-text-tertiary:#8e929a;',
    '--color-text-info:#3b5bdb;--color-text-danger:#a32d2d;--color-text-success:#3b6d11;--color-text-warning:#854f0b;',
    '--color-border-primary:rgba(0,0,0,.4);--color-border-secondary:rgba(0,0,0,.24);--color-border-tertiary:rgba(0,0,0,.12);',
    '--color-border-info:#3b5bdb;--color-border-danger:#a32d2d;--color-border-success:#3b6d11;--color-border-warning:#854f0b;--accent:#4d6bfe;',
    '--p:var(--color-text-primary);--s:var(--color-text-secondary);--t:var(--color-text-tertiary);--bg2:var(--color-background-secondary);--b:var(--color-border-tertiary);color-scheme:light}',
    ':root[data-theme=dark]{--color-background-primary:#1d1e21;--color-background-secondary:#26272b;--color-background-tertiary:#303136;',
    '--color-background-info:#1c2b55;--color-background-danger:#501313;--color-background-success:#173404;--color-background-warning:#412402;',
    '--color-text-primary:#ececee;--color-text-secondary:#a4a7ae;--color-text-tertiary:#7c8088;',
    '--color-text-info:#8fa6ff;--color-text-danger:#f09595;--color-text-success:#97c459;--color-text-warning:#ef9f27;',
    '--color-border-primary:rgba(255,255,255,.4);--color-border-secondary:rgba(255,255,255,.24);--color-border-tertiary:rgba(255,255,255,.12);',
    '--color-border-info:#8fa6ff;--color-border-danger:#f09595;--color-border-success:#97c459;--color-border-warning:#ef9f27;--accent:#7b93ff;color-scheme:dark}',
    '*,*::before,*::after{box-sizing:border-box}html{background:transparent;-webkit-text-size-adjust:100%}',
    'body{margin:0;font-family:var(--font-sans);font-size:16px;line-height:1.6;color:var(--color-text-primary);background:transparent;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}',
    'h1,h2,h3,h4{line-height:1.3;margin:0 0 .5em;font-weight:500}h1{font-size:22px}h2{font-size:18px}h3{font-size:16px}p{margin:0 0 .75em}',
    'button{font:inherit;font-size:14px;min-height:36px;padding:6px 14px;border:.5px solid var(--color-border-secondary);border-radius:var(--border-radius-md);background:transparent;color:var(--color-text-primary);cursor:pointer;transition:background .15s,transform .1s;touch-action:manipulation}',
    'button:hover{background:var(--color-background-secondary)}button:active{transform:scale(.98)}button:disabled{opacity:.5;cursor:default}',
    'button.primary,.btn-primary{background:var(--color-text-primary);color:var(--color-background-primary);border-color:transparent}',
    'input[type=text],input[type=number],input[type=email],input[type=search],input[type=date],input[type=time],input:not([type]),textarea,select{font:inherit;font-size:14px;min-height:36px;padding:6px 12px;border:.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-md);background:var(--color-background-primary);color:var(--color-text-primary);max-width:100%}',
    'input:focus,textarea:focus,select:focus{outline:none;border-color:var(--color-border-primary);box-shadow:0 0 0 3px rgba(77,107,254,.15)}textarea{min-height:80px;resize:vertical}',
    'input::placeholder,textarea::placeholder{color:var(--color-text-tertiary)}',
    'input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:4px;background:var(--color-border-tertiary);border-radius:2px;outline:none;margin:12px 0}',
    'input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:var(--color-background-primary);border:.5px solid var(--color-border-secondary);box-shadow:0 1px 3px rgba(0,0,0,.18);cursor:pointer}',
    'input[type=checkbox],input[type=radio]{width:16px;height:16px;accent-color:var(--accent)}',
    'a{color:var(--color-text-info);text-decoration:none}a:hover{text-decoration:underline}',
    'table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:.5px solid var(--color-border-tertiary)}th{font-weight:500;color:var(--color-text-secondary)}',
    'code,pre{font-family:var(--font-mono);font-size:13px}svg,canvas,img,video{max-width:100%}svg{overflow:visible}',
    '#sds-root>svg[viewBox],#sds-root>div>svg[viewBox]{display:block;max-width:620px;margin:0 auto;height:auto}',
    'svg text.t{font:400 14px var(--font-sans);fill:var(--p)}svg text.ts{font:400 12px var(--font-sans);fill:var(--s)}svg text.th{font:500 14px var(--font-sans);fill:var(--p)}',
    'svg .box>rect,svg .box>circle,svg .box>ellipse{fill:var(--bg2);stroke:var(--b)}svg .node{cursor:pointer}svg .node:hover{opacity:.85}',
    'svg .arr{stroke:var(--s);stroke-width:1.5;fill:none}svg .arr:not([marker-end]){marker-end:url(#sds-arrow)}#sds-defs{position:absolute;width:0;height:0;overflow:hidden}svg .leader{stroke:var(--t);stroke-width:.5;stroke-dasharray:4 4;fill:none}',
    '.card{background:var(--color-background-secondary);border-radius:var(--border-radius-lg);padding:14px 16px}.muted{color:var(--color-text-secondary)}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}',
    '.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}.metric{font-size:24px;font-weight:500}.label{font-size:12px;color:var(--color-text-secondary)}',
    '@keyframes sdsIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}.sds-enter{animation:sdsIn .35s ease-out both}',
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}'
  ];
  var RAMPS = {
    purple: ['#EEEDFE', '#534AB7', '#3C3489', '#3C3489', '#AFA9EC', '#CECBF6'], teal: ['#E1F5EE', '#0F6E56', '#085041', '#085041', '#5DCAA5', '#9FE1CB'],
    coral: ['#FAECE7', '#993C1D', '#712B13', '#712B13', '#F0997B', '#F5C4B3'], pink: ['#FBEAF0', '#993556', '#72243E', '#72243E', '#ED93B1', '#F4C0D1'],
    gray: ['#F1EFE8', '#5F5E5A', '#444441', '#444441', '#B4B2A9', '#D3D1C7'], blue: ['#E6F1FB', '#185FA5', '#0C447C', '#0C447C', '#85B7EB', '#B5D4F4'],
    green: ['#EAF3DE', '#3B6D11', '#27500A', '#27500A', '#97C459', '#C0DD97'], amber: ['#FAEEDA', '#854F0B', '#633806', '#633806', '#EF9F27', '#FAC775'],
    red: ['#FCEBEB', '#A32D2D', '#791F1F', '#791F1F', '#F09595', '#F7C1C1']
  };
  Object.keys(RAMPS).forEach(function (k) {
    var r = RAMPS[k], sel = 'svg .c-' + k + '>rect,svg .c-' + k + '>circle,svg .c-' + k + '>ellipse,svg .c-' + k + '>path,svg rect.c-' + k + ',svg circle.c-' + k + ',svg ellipse.c-' + k + ',svg path.c-' + k;
    DESIGN_CSS.push(sel + '{fill:' + r[0] + ';stroke:' + r[1] + '}svg .c-' + k + ' text{fill:' + r[2] + '}svg .c-' + k + ' text.ts{fill:' + r[1] + '}.c-' + k + ':not(svg *){background:' + r[0] + ';color:' + r[2] + '}');
    DESIGN_CSS.push(':root[data-theme=dark] ' + sel.split(',').join(',:root[data-theme=dark] ') + '{fill:' + r[3] + ';stroke:' + r[4] + '}:root[data-theme=dark] svg .c-' + k + ' text{fill:' + r[5] + '}:root[data-theme=dark] svg .c-' + k + ' text.ts{fill:' + r[4] + '}:root[data-theme=dark] .c-' + k + ':not(svg *){background:' + r[3] + ';color:' + r[5] + '}');
  });
  var DESIGN = DESIGN_CSS.join('\n');

  /* Runs first inside every frame. Untrusted code can override anything here;
   * it is a convenience layer (sizing, errors, storage shim), not a security
   * boundary — the sandbox and the host-side checks are. */

  /* ---------------- loop guard ----------------
   * Android WebView runs a srcdoc frame on the chat page's main thread, so a
   * synchronous endless loop in generated code would freeze the whole chat (the
   * sandbox isolates data, not CPU). Inline scripts of generated surfaces are
   * therefore rewritten so every `while (…)` / `do … while (…)` condition and
   * every classic `for (;…;)` condition first calls __sdLoop(id). A loop that has
   * kept the thread busy for LOOP_MS is stopped (its condition becomes false)
   * and an error is reported, so the surface shows "Fix with AI" and the chat
   * keeps working. for-in/for-of, recursion and inline event-handler attributes
   * are not rewritten. Both functions are self-contained because they are also
   * serialized into React frames (applied to Babel's output). */
  var LOOP_MS = 2000;
  function loopRuntime(post, limit) {
    var runs = {}, warned = false;
    return function (id) {
      var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(), r = runs[id];
      if (!r || now - r.l > 60) r = runs[id] = { t: now, l: now, stop: false }; else r.l = now;
      if (r.stop) return false;
      if (now - r.t > limit) {
        r.stop = true;
        if (!warned) { warned = true; try { post({ type: 'error', message: 'A loop ran for more than ' + Math.round(limit / 1000) + ' s and was stopped to keep the chat responsive.' }); } catch (e) {} }
        return false;
      }
      return true;
    };
  }
  function protectLoops(src) {
    src = String(src == null ? '' : src);
    if (src.length > 600000 || !/\b(?:while|for)\b/.test(src)) return src;
    var n = src.length, edits = [], loopId = 0;
    var BEFORE_REGEX = /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
    function isId(c) { return !!c && /[A-Za-z0-9_$\u0080-\uffff]/.test(c); }
    function skipString(i) { var q = src[i]; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; else if (src[i] === '\n') return i; i++; } return i + 1; }
    function skipComment(i) { if (src[i + 1] === '/') { var e = src.indexOf('\n', i); return e < 0 ? n : e; } var c = src.indexOf('*/', i + 2); return c < 0 ? n : c + 2; }
    function skipRegex(i) { i++; var cls = false; while (i < n) { var c = src[i]; if (c === '\\') { i += 2; continue; } if (c === '\n') return i; if (cls) { if (c === ']') cls = false; } else if (c === '[') cls = true; else if (c === '/') { i++; break; } i++; } while (i < n && isId(src[i])) i++; return i; }
    function skipTemplate(i) { i++; while (i < n) { var c = src[i]; if (c === '\\') { i += 2; continue; } if (c === '`') return i + 1; if (c === '$' && src[i + 1] === '{') { i = skipBalanced(i + 1, '{', '}'); continue; } i++; } return n; }
    // From an opening bracket at i, return the index just past its partner. Regex
    // literals inside are treated as division (rare inside loop headers).
    function skipBalanced(i, open, close) {
      var depth = 0;
      while (i < n) {
        var c = src[i];
        if (c === '"' || c === "'") { i = skipString(i); continue; }
        if (c === '`') { i = skipTemplate(i); continue; }
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(i); continue; }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return i + 1; }
        i++;
      }
      return n;
    }
    function topLevelSemicolons(a, b) {
      var out = [], depth = 0, i = a;
      while (i < b) {
        var c = src[i];
        if (c === '"' || c === "'") { i = skipString(i); continue; }
        if (c === '`') { i = skipTemplate(i); continue; }
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(i); continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ';' && depth === 0) out.push(i);
        i++;
      }
      return out;
    }
    function nextSig(i) { while (i < n) { var c = src[i]; if (/\s/.test(c)) { i++; continue; } if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipComment(i); continue; } return i; } return n; }
    var i = 0, prevSig = '', prevWord = '';
    while (i < n) {
      var c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '"' || c === "'") { i = skipString(i); prevSig = 'a'; prevWord = ''; continue; }
      if (c === '`') { i = skipTemplate(i); prevSig = 'a'; prevWord = ''; continue; }
      if (c === '/') {
        if (src[i + 1] === '/' || src[i + 1] === '*') { i = skipComment(i); continue; }
        var regexOk = prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || (prevWord && BEFORE_REGEX.test(prevWord));
        if (regexOk) { i = skipRegex(i); prevSig = 'a'; prevWord = ''; continue; }
        i++; prevSig = '/'; prevWord = ''; continue;
      }
      if (isId(c)) {
        var s0 = i; while (i < n && isId(src[i])) i++;
        var w = src.slice(s0, i), dotted = prevSig === '.' && src[s0 - 1] === '.';
        if (!dotted && !/[0-9]/.test(w[0]) && (w === 'while' || w === 'for')) {
          var p = nextSig(i);
          if (w === 'for' && src.slice(p, p + 5) === 'await') p = -1;
          if (p >= 0 && src[p] === '(') {
            var end = skipBalanced(p, '(', ')'), id = ++loopId;
            if (w === 'while') {
              if (src.slice(p + 1, end - 1).trim()) { edits.push([p + 1, '__sdLoop(' + id + ')&&(']); edits.push([end - 1, ')']); }
            } else {
              var semis = topLevelSemicolons(p + 1, end - 1);
              if (semis.length === 2) {
                if (src.slice(semis[0] + 1, semis[1]).trim()) { edits.push([semis[0] + 1, '__sdLoop(' + id + ')&&(']); edits.push([semis[1], ')']); }
                else edits.push([semis[0] + 1, '__sdLoop(' + id + ')']);
              }
            }
          }
        }
        prevSig = 'a'; prevWord = w; continue;
      }
      prevSig = c; prevWord = ''; i++;
    }
    if (!edits.length) return src;
    edits.sort(function (a, b) { return b[0] - a[0]; });
    var out = src;
    edits.forEach(function (e) { out = out.slice(0, e[0]) + e[1] + out.slice(e[0]); });
    return out;
  }
  /** Rewrite the inline classic/module scripts of an HTML document. */
  function protectDocumentScripts(html) {
    return String(html).replace(/(<script\b)([^>]*)>([\s\S]*?)(<\/script\s*>)/gi, function (m, open, attrs, body, close) {
      if (/\bsrc\s*=/i.test(attrs)) return m;
      var type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
      if (type && !/^(?:module|text\/javascript|application\/javascript|javascript)$/i.test(type)) return m;
      return open + attrs + '>' + protectLoops(body) + close;
    });
  }

  /* ---------------- web access for generated content ----------------
   * Frames have no network of their own (CSP). sdFetch() — and fetch() for
   * any http(s) URL outside the CDN list — goes frame → host page → per-site
   * consent → native SSRF-safe fetch without cookies. Failing <img> loads
   * from other sites are retried the same way. Serialized into each frame. */
  function fetchRuntime(post, cdn) {
    var seq = 0, pend = {};
    function b64ToBytes(b) { var bin = atob(b), n = bin.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return u; }
    function abs(u) { try { var x = new URL(String(u), document.baseURI && /^https?:/.test(document.baseURI) ? document.baseURI : undefined); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } }
    function sdFetch(input, init) {
      init = init || {};
      var url = abs(typeof input === 'string' ? input : (input && input.url) || String(input));
      if (!url) return Promise.reject(new TypeError('sdFetch: only absolute http(s) URLs'));
      var req = input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.method === 'string' ? input : null;
      var method = String(init.method || (req && req.method) || 'GET').toUpperCase();
      var headers = {};
      try { var h = new Headers(init.headers || (req && req.headers) || {}); h.forEach(function (v, k) { headers[k] = v; }); } catch (e) {}
      // The body as text, the way the browser would encode it (FormData gets its multipart
      // boundary, URLSearchParams / Blob their type). A Request's own body is read too.
      var raw = init.body, bodyP;
      if (raw == null && req && method !== 'GET' && method !== 'HEAD') bodyP = req.clone().text().then(function (t) { return { text: t }; });
      else if (raw == null || typeof raw === 'string') bodyP = Promise.resolve({ text: raw });
      else {
        var native0 = (typeof FormData !== 'undefined' && raw instanceof FormData) || (typeof Blob !== 'undefined' && raw instanceof Blob) ||
          (typeof URLSearchParams !== 'undefined' && raw instanceof URLSearchParams) || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw);
        if (native0) {
          var enc; try { enc = new Response(raw); } catch (e) { enc = null; }
          bodyP = enc ? enc.text().then(function (t) { return { text: t, type: enc.headers.get('content-type') }; }) : Promise.resolve({ text: String(raw) });
        } else { var j; try { j = JSON.stringify(raw); } catch (e) { j = String(raw); } bodyP = Promise.resolve({ text: j, type: 'application/json' }); }
      }
      var id = 'f' + (++seq);
      return bodyP.then(function (b) {
        if (b.type && !headers['content-type']) headers['content-type'] = b.type;
        var body = b.text;
        return new Promise(function (res, rej) {
        pend[id] = function (d) {
          if (!d.status && !d.ok) { rej(new TypeError('Failed to fetch: ' + (d.error || 'network error'))); return; }
          var bytes = d.base64 != null ? b64ToBytes(d.base64) : (d.text != null ? d.text : '');
          var r;
          try { r = new Response(d.status === 204 || d.status === 304 ? null : bytes, { status: d.status || 200, headers: { 'content-type': d.contentType || 'text/plain' } }); }
          catch (e) { r = new Response(bytes, { status: 200, headers: { 'content-type': d.contentType || 'text/plain' } }); }
          try { Object.defineProperty(r, 'url', { value: d.url || url }); } catch (e) {}
          res(r);
        };
        post({ type: 'fetch', id: id, url: url, method: method, headers: headers, body: body == null ? '' : String(body).slice(0, 262144) });
        });
      });
    }
    function sdImage(url) {
      return sdFetch(url).then(function (r) { return r.blob(); }).then(function (b) {
        return new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { ok(fr.result); }; fr.readAsDataURL(b); });
      });
    }
    var native = window.fetch;
    function viaCdn(u) { for (var i = 0; i < cdn.length; i++) if (u.indexOf(cdn[i] + '/') === 0) return true; return false; }
    window.sdFetch = sdFetch; window.sdImage = sdImage;
    window.fetch = function (input, init) {
      var u = abs(typeof input === 'string' ? input : (input && input.url) || '');
      if (u && !viaCdn(u)) return sdFetch(input, init);
      return native ? native.apply(this, arguments) : Promise.reject(new TypeError('fetch unavailable'));
    };
    // <img src="https://…"> blocked by the frame CSP: retry through the host once.
    window.addEventListener('error', function (e) {
      var t = e.target;
      if (!t || t.tagName !== 'IMG' || t.__sdTried) return;
      var src = abs(t.getAttribute('src') || '');
      if (!src || viaCdn(src)) return;
      t.__sdTried = true;
      sdImage(src).then(function (d) { t.src = d; }, function () {});
    }, true);
    return { resolve: function (d) { var f = pend[d.id]; if (f) { delete pend[d.id]; f(d); } } };
  }

  function bootScript(channel, mode, kind) {
    return '(function(){var CH=' + JSON.stringify(channel) + ',MODE=' + JSON.stringify(mode) + ',KIND=' + JSON.stringify(kind || 'visual') + ';' +
      'function post(m){m.__sds=CH;try{parent.postMessage(m,"*")}catch(e){}}' +
      'window.__sdLoop=(' + loopRuntime.toString() + ')(post,' + LOOP_MS + ');' +
      (kind === 'mcp' ? '' : 'var NET=(' + fetchRuntime.toString() + ')(post,' + JSON.stringify(CDN_SCRIPT) + ');') +
      'function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}' +
      'try{window.localStorage.getItem("x")}catch(e){try{Object.defineProperty(window,"localStorage",{value:mem()});Object.defineProperty(window,"sessionStorage",{value:mem()})}catch(_){}}' +
      'var errs=0;window.addEventListener("error",function(e){if(errs++>5)return;post({type:"error",message:String(e.message||"Script error").slice(0,300),line:e.lineno||0})});' +
      'window.addEventListener("unhandledrejection",function(e){if(errs++>5)return;var r=e.reason;post({type:"error",message:String(r&&r.message||r).slice(0,300)})});' +
      'window.sendPrompt=function(t){post({type:"prompt",text:String(t==null?"":t).slice(0,4000)})};' +
      'window.openLink=function(u){post({type:"link",url:String(u||"").slice(0,2000)})};' +
      'document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();if(/^https?:/i.test(a.href))window.openLink(a.href)},true);' +
      'var last=-1,grow=0,lastT=0;function size(){if(MODE!=="inline")return;var b=document.body,d=document.documentElement;if(!b||!d)return;var h=Math.ceil(Math.max(d.offsetHeight,d.scrollHeight,b.offsetHeight,b.scrollHeight));' +
      'var root=document.getElementById("sds-root");if(root){var nodes=root.querySelectorAll("svg,canvas,img,video,iframe");for(var i=0;i<nodes.length;i++){var r=nodes[i].getBoundingClientRect();if(r.width>0&&r.height>0)h=Math.max(h,Math.ceil(r.bottom+(window.scrollY||0)+6))}}' +
      'if(Math.abs(h-last)<2)return;var now=Date.now();if(h>last){grow=(now-lastT<400)?grow+1:0;lastT=now;if(grow>12)return}last=h;post({type:"size",height:h})}' +
      'function defs(){if(KIND==="mcp"||document.getElementById("sds-defs")||!document.body)return;var ns="http://www.w3.org/2000/svg",s=document.createElementNS(ns,"svg");s.id="sds-defs";s.setAttribute("aria-hidden","true");s.innerHTML=\'<defs><marker id="sds-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" style="stroke:var(--s)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>\';document.body.appendChild(s)}' +
      'function watch(){defs();size();try{new ResizeObserver(size).observe(document.documentElement);document.body&&new ResizeObserver(size).observe(document.body)}catch(e){setInterval(size,500)}}' +
      'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",watch);else watch();window.addEventListener("load",function(){size();setTimeout(size,300);setTimeout(size,1200)});' +
      'function strip(h){var i=h.lastIndexOf("<");if(i>h.lastIndexOf(">"))h=h.slice(0,i);return h.replace(/<script\\b[\\s\\S]*?(<\\/script\\s*>|$)/gi,"").replace(/\\son[a-z]+\\s*=\\s*("[^"]*"|\'[^\']*\'|[^\\s>]+)/gi,"")}' +
      'window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.__sds!==CH)return;' +
      'if(d.type==="theme"){document.documentElement.setAttribute("data-theme",d.theme==="dark"?"dark":"light")}' +
      'else if(d.type==="fetch-result"){if(typeof NET!=="undefined")NET.resolve(d)}' +
      'else if(d.type==="stream"){var r=document.getElementById("sds-root");if(!r)return;var n=r.children.length;r.innerHTML=strip(String(d.html||""));for(var i=n;i<r.children.length;i++)r.children[i].classList.add("sds-enter");size()}' +
      '});post({type:"boot"})})();';
  }

  function escScript(s) { return String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--'); }
  function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function jsonForScript(v) { return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

  function head(opts) {
    var mode = opts.mode || 'inline';
    var extraCss = mode === 'inline' ? 'html,body{min-height:0!important;height:auto!important}body{padding:2px 1px 6px}' : 'html,body{min-height:100%}body{padding:16px}';
    if (opts.kind === 'mcp') extraCss = mode === 'inline' ? 'html,body{min-height:0!important;height:auto!important}' : '';
    return '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + cspFor(opts.kind, opts.csp) + '">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">' +
      '<script>' + bootScript(opts.channel || 'x', mode, opts.kind) + '<\/script>' +
      (opts.shim ? '<script>' + escScript(String(opts.shim)) + '<\/script>' : '') +
      (opts.kind === 'mcp' ? '' : '<style>' + DESIGN + '\n' + extraCss + '</style>') +
      (opts.kind === 'mcp' && extraCss ? '<style>' + extraCss + '</style>' : '');
  }
  function isFullDocument(s) { return /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(String(s || '')); }

  /** Inject the host head into a complete document without rewriting the author's markup. */
  function wrapDocument(source, opts) {
    var src = String(source || ''), th = opts.theme || theme();
    if (isFullDocument(src)) {
      src = src.replace(/<base\b[^>]*>/gi, '');
      var h = head(opts);
      if (/<head[^>]*>/i.test(src)) src = src.replace(/<head[^>]*>/i, function (m) { return m + h; });
      else if (/<html[^>]*>/i.test(src)) src = src.replace(/<html[^>]*>/i, function (m) { return m + '<head>' + h + '</head>'; });
      else src = h + src;
      return src.replace(/<html(?=[\s>])/i, '<html data-theme="' + th + '"');
    }
    return '<!doctype html><html data-theme="' + th + '"><head>' + head(opts) + '</head><body><div id="sds-root">' + src + '</div></body></html>';
  }

  var REACT_IMPORTS = {
    'react': 'https://esm.sh/react@18.3.1', 'react/': 'https://esm.sh/react@18.3.1/',
    'react-dom': 'https://esm.sh/react-dom@18.3.1?external=react',
    'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client?external=react',
    'recharts': 'https://esm.sh/recharts@2.12.7?external=react,react-dom', 'lucide-react': 'https://esm.sh/lucide-react@0.383.0?external=react',
    'lodash': 'https://esm.sh/lodash@4.17.21', 'd3': 'https://esm.sh/d3@7.9.0', 'three': 'https://esm.sh/three@0.160.0',
    'mathjs': 'https://esm.sh/mathjs@12.4.2', 'papaparse': 'https://esm.sh/papaparse@5.4.1', 'chart.js': 'https://esm.sh/chart.js@4.4.3', 'chart.js/auto': 'https://esm.sh/chart.js@4.4.3/auto',
    'framer-motion': 'https://esm.sh/framer-motion@11.2.10?external=react,react-dom', 'clsx': 'https://esm.sh/clsx@2.1.1'
  };
  function reactDocument(source, opts) {
    var th = opts.theme || theme();
    return '<!doctype html><html data-theme="' + th + '"><head>' + head(opts) +
      '<script type="importmap">' + jsonForScript({ imports: REACT_IMPORTS }) + '<\/script>' +
      '<script src="https://cdn.tailwindcss.com"><\/script><script>try{tailwind.config={darkMode:["class","[data-theme=dark]"]}}catch(e){}<\/script>' +
      '<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"><\/script>' +
      '</head><body><div id="sds-root"><div class="muted" style="font-size:14px;padding:8px 0">Loading…</div></div>' +
      '<script>window.__SDS_SRC=' + jsonForScript(String(source || '')) + '<\/script>' +
      '<script type="module">' + escScript(
        'const root=document.getElementById("sds-root");' +
        'try{if(!window.Babel)throw new Error("Babel could not be loaded (offline?)");' +
        'let src=window.__SDS_SRC;if(!/export\\s+default/.test(src)){const m=src.match(/(?:function|const|class)\\s+([A-Z][A-Za-z0-9_]*)/);if(m)src+="\\nexport default "+m[1]+";"}' +
        'const out=(' + protectLoops.toString() + ')(Babel.transform(src,{presets:[["react",{runtime:"automatic"}]],filename:"artifact.jsx"}).code);' +
        'const url=URL.createObjectURL(new Blob([out],{type:"text/javascript"}));' +
        'const [mod,React,client]=await Promise.all([import(url),import("react"),import("react-dom/client")]);' +
        'const C=mod.default;if(typeof C!=="function"&&typeof C!=="object")throw new Error("The component has no default export");' +
        'root.innerHTML="";client.createRoot(root).render(React.createElement(C));' +
        '}catch(e){root.innerHTML="";const p=document.createElement("pre");p.style.cssText="white-space:pre-wrap;color:var(--color-text-danger);font-size:13px";p.textContent=String(e&&e.message||e);root.appendChild(p);window.dispatchEvent(new ErrorEvent("error",{message:String(e&&e.message||e)}))}'
      ) + '<\/script></body></html>';
  }
  function mermaidDocument(source, opts) {
    var th = opts.theme || theme();
    return '<!doctype html><html data-theme="' + th + '"><head>' + head(opts) + '<style>#sds-root{display:flex;justify-content:center}.mermaid svg{max-width:100%;height:auto}</style></head>' +
      '<body><div id="sds-root"><pre class="mermaid" style="background:none;font-family:inherit">' + escHtml(source) + '</pre></div>' +
      '<script type="module">' + escScript('import m from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";' +
        'm.initialize({startOnLoad:false,securityLevel:"strict",theme:' + JSON.stringify(th === 'dark' ? 'dark' : 'neutral') + ',fontFamily:"system-ui,sans-serif"});' +
        'try{await m.run({querySelector:".mermaid"})}catch(e){window.dispatchEvent(new ErrorEvent("error",{message:String(e&&e.message||e)}))}') +
      '<\/script></body></html>';
  }
  function streamingDocument(opts) {
    return '<!doctype html><html data-theme="' + (opts.theme || theme()) + '"><head>' + head(opts) + '</head><body><div id="sds-root"></div></body></html>';
  }

  /** The complete srcdoc for a surface. kind: visual | html | svg | react | mermaid | mcp. */
  function buildDocument(opts) {
    opts = opts || {};
    var kind = opts.kind || 'visual', src = String(opts.source == null ? '' : opts.source);
    if (opts.streaming) return streamingDocument(opts);
    if (kind === 'react') return reactDocument(src, opts);
    if (kind === 'mermaid') return mermaidDocument(src, opts);
    if (kind === 'svg') return wrapDocument('<div style="display:flex;justify-content:center">' + protectDocumentScripts(src) + '</div>', opts);
    if (kind === 'mcp') return wrapDocument(src, { kind: 'mcp', mode: opts.mode, channel: opts.channel, theme: opts.theme, shim: opts.shim, csp: { resourceDomains: cleanDomains(opts.csp && opts.csp.resourceDomains), connectDomains: cleanDomains(opts.csp && opts.csp.connectDomains) } });
    return wrapDocument(protectDocumentScripts(src), opts);
  }

  /* ---------------- web access broker (host side) ---------------- */
  var web = (function () {
    var KEY = 'sd_fetch_grants_v1', denied = Object.create(null), asking = Object.create(null);
    var PRIVATE = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.corp|\d+\.\d+\.\d+\.\d+|\[.*\])$/i;
    function grants() { try { var g = JSON.parse(root.localStorage.getItem(KEY) || '{}'); return g && typeof g === 'object' ? g : {}; } catch (_) { return {}; } }
    function always(host) { try { var g = grants(); g[host] = Date.now(); root.localStorage.setItem(KEY, JSON.stringify(g)); } catch (_) {} }
    function bn() { try { return (doc.documentElement.lang || root.navigator.language || '').toLowerCase().indexOf('bn') === 0; } catch (_) { return false; } }
    function tt(en, b) { return bn() ? b : en; }
    function publicIp(h) { var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h); if (!m) return false; var a = +m[1], b = +m[2]; return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)); }
    function hostAllowedSyntax(u) {
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
      if (u.port && ['80', '443', '8080', '8443'].indexOf(u.port) < 0) return false;
      var h = u.hostname.toLowerCase();
      if (h.indexOf('.') < 0) return false;
      if (PRIVATE.test(h)) return publicIp(h);
      return true;
    }
    var queue = Promise.resolve();
    function ask(ctrl, host) {
      if (asking[host]) return asking[host];
      // One sheet at a time: later sites wait for the earlier answer.
      var p = queue.then(function () { return grants()[host] ? 'ok' : denied[host] ? 'deny' : show(ctrl, host); });
      queue = p.catch(function () {});
      asking[host] = p;
      p.then(function () { delete asking[host]; }, function () { delete asking[host]; });
      return p;
    }
    function show(ctrl, host) {
      return new Promise(function (resolve) {
        var sheet = doc.createElement('div'); sheet.className = 'sd-net'; sheet.setAttribute('data-sd-owned', 'net'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'false');
        var card = doc.createElement('div'); card.className = 'sd-net-card';
        var ic = doc.createElement('div'); ic.className = 'sd-net-icon';
        ic.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
        var tx = doc.createElement('div'); tx.className = 'sd-net-text';
        var t1 = doc.createElement('div'); t1.className = 'sd-net-title';
        var nm = (ctrl.opts && ctrl.opts.title) || tt('This visual', 'এই ভিজুয়াল');
        t1.textContent = tt('“' + nm + '” wants to access ', '“' + nm + '” এই সাইটে যেতে চায়: ');
        var hb = doc.createElement('b'); hb.textContent = host; t1.appendChild(hb);
        var t2 = doc.createElement('div'); t2.className = 'sd-net-sub';
        t2.textContent = tt('Only public data is fetched — without your cookies or logins.', 'শুধু পাবলিক তথ্য আনা হবে — আপনার কুকি বা লগইন ছাড়া।');
        tx.append(t1, t2);
        var row = doc.createElement('div'); row.className = 'sd-net-actions';
        function btn(label, cls, val) { var b = doc.createElement('button'); b.type = 'button'; b.className = 'sd-chip ' + cls; b.textContent = label; b.addEventListener('click', function () { close(); resolve(val); }); return b; }
        row.append(btn(tt('Deny', 'না'), '', 'deny'), btn(tt('Allow once', 'একবার'), '', 'once'), btn(tt('Always allow', 'সবসময়'), 'sd-chip-primary', 'always'));
        card.append(ic, tx, row); sheet.appendChild(card);
        function close() { sheet.classList.add('sd-out'); sheet.removeAttribute('role'); setTimeout(function () { sheet.remove(); }, 180); }
        (doc.body || doc.documentElement).appendChild(sheet);
        setTimeout(function () { if (sheet.isConnected && !sheet.classList.contains('sd-out')) { close(); resolve('timeout'); } }, 120000);
      });
    }
    function reply(ctrl, d, r) { ctrl.post({ type: 'fetch-result', id: d.id, ok: !!r.ok, status: r.status || 0, url: r.url, contentType: r.contentType || '', text: r.text, base64: r.base64, error: r.error, truncated: !!r.truncated }); }
    function request(ctrl, d) {
      if (!d || typeof d.id !== 'string' || d.id.length > 24) return;
      var now = Date.now();
      ctrl._net = ctrl._net || { times: [], once: Object.create(null), active: 0, open: 0, wait: [] };
      var st = ctrl._net;
      st.times = st.times.filter(function (x) { return now - x < 60000; });
      // At most 6 run at once; up to 32 may be open (running, queued or waiting for consent).
      if (st.times.length >= 60 || st.open >= 32) { reply(ctrl, d, { error: 'Too many requests from this visual' }); return; }
      var u; try { u = new URL(String(d.url || '')); } catch (_) { reply(ctrl, d, { error: 'Invalid URL' }); return; }
      if (!hostAllowedSyntax(u)) { reply(ctrl, d, { error: 'Only public http(s) websites can be reached' }); return; }
      var method = String(d.method || 'GET').toUpperCase();
      if (['GET', 'HEAD', 'POST'].indexOf(method) < 0) { reply(ctrl, d, { error: 'Method not allowed' }); return; }
      var host = u.hostname.toLowerCase();
      if (denied[host]) { reply(ctrl, d, { error: 'Access to ' + host + ' was denied' }); return; }
      var ok = grants()[host] || st.once[host];
      st.open++;
      function finish(r) { st.open--; reply(ctrl, d, r); }
      // Runs now if fewer than 6 are in flight, else when one finishes (requests that queued
      // up behind a consent sheet must not all fire at once — nor fail: they wait their turn).
      function dispatch() {
        if (st.active >= 6) { st.wait.push(dispatch); return; }
        var bridge = root.__sdBridgeFetch;
        if (typeof bridge !== 'function') { finish({ error: 'Web access is unavailable here' }); return; }
        var t2 = Date.now(); st.times = st.times.filter(function (x) { return t2 - x < 60000; });
        if (st.times.length >= 60) { finish({ error: 'Too many requests from this visual' }); return; }
        st.times.push(t2); st.active++;
        var Ho = root.__sdGenUIHost, lid = Ho && Ho.ledger && Ho.ledger.record({ type: 'fetch', title: host, detail: method + ' ' + u.pathname.slice(0, 80), state: 'running' });
        var call; try { call = Promise.resolve(bridge({ type: 'bds-frame-fetch', url: u.href, method: method, headers: d.headers && typeof d.headers === 'object' ? d.headers : {}, body: typeof d.body === 'string' ? d.body : '' })); }
        catch (e) { call = Promise.reject(e); }
        call.then(function (r) { r = r || {}; if (Ho && lid) Ho.ledger.update(lid, { state: r.ok ? 'done' : 'failed', endedAt: Date.now() }); finish(r); },
                  function (e) { if (Ho && lid) Ho.ledger.update(lid, { state: 'failed', endedAt: Date.now() }); finish({ error: String(e && e.message || e) }); })
          .then(function () { st.active--; var next = st.wait.shift(); if (next) next(); });
      }
      Promise.resolve(ok ? 'ok' : ask(ctrl, host)).then(function (v) {
        if (v === 'deny' || v === 'timeout') { if (v === 'deny') denied[host] = true; finish({ error: 'Access to ' + host + ' was denied' }); return; }
        if (v === 'always') always(host);
        if (v === 'once') st.once[host] = true;
        dispatch();
      }, function (e) { finish({ error: String(e && e.message || e) }); });
    }
    return { request: request, grants: grants, revokeAll: function () { try { root.localStorage.removeItem(KEY); } catch (_) {} denied = Object.create(null); }, hostAllowedSyntax: hostAllowedSyntax };
  })();

  /* ---------------- live controllers ---------------- */
  var controllers = [];
  var seq = 0;
  function channelId() { seq++; var r = ''; try { var a = new Uint32Array(2); root.crypto.getRandomValues(a); r = a[0].toString(36) + a[1].toString(36); } catch (_) { r = Math.random().toString(36).slice(2); } return 'sds' + seq + r; }

  function onMessage(e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    for (var i = 0; i < controllers.length; i++) {
      var c = controllers[i];
      if (!c.frame || e.source !== c.frame.contentWindow) continue;
      // Exact source match is the trust anchor; the channel id guards against
      // a stale message from a previous document in the same frame.
      if (d.__sds === c.channel) c._handle(d);
      else if (c.opts.kind === 'mcp' && (d.jsonrpc === '2.0' || typeof d.method === 'string')) c._rpc(d);
      return;
    }
  }
  if (root.addEventListener) root.addEventListener('message', onMessage);

  // A tap inside a frame moves focus into it: the page window blurs and the
  // iframe becomes activeElement. Used as the user-gesture signal for frames.
  if (root.addEventListener) root.addEventListener('blur', function () {
    setTimeout(function () {
      var a = doc.activeElement;
      for (var i = 0; i < controllers.length; i++) if (controllers[i].frame === a) controllers[i].lastTap = Date.now();
    }, 0);
  });

  function Controller(opts) {
    this.opts = opts;
    this.channel = channelId();
    this.lastTap = 0;
    this.height = 0;
    this.handlers = {};
    var f = doc.createElement('iframe');
    f.className = 'sd-frame';
    f.setAttribute('sandbox', SANDBOX);
    f.setAttribute('allow', "clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'");
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('title', opts.title || 'Generated content');
    f.setAttribute('loading', 'eager');
    if (opts.mode !== 'fullscreen') f.style.height = (opts.initialHeight || 120) + 'px';
    this.frame = f;
    controllers.push(this);
  }
  Controller.prototype.on = function (name, fn) { this.handlers[name] = fn; return this; };
  Controller.prototype._emit = function (name, a, b) { var h = this.handlers[name]; if (h) { try { return h(a, b); } catch (err) { try { console.warn('[SDS frame]', name, err); } catch (_) {} } } };
  Controller.prototype._handle = function (d) {
    switch (d.type) {
      case 'boot': this.booted = true; this._emit('boot'); if (this._pendingStream != null) { this.post({ type: 'stream', html: this._pendingStream }); this._pendingStream = null; } break;
      case 'size': {
        var h = Number(d.height);
        if (!isFinite(h) || h < 0) return;
        h = Math.max(24, Math.min(this.opts.maxHeight || MAX_INLINE_HEIGHT, Math.round(h)));
        if (this.opts.mode === 'fullscreen' || Math.abs(h - this.height) < 2) break;
        // Grow-only while streaming and briefly after the final reload, so the
        // answer below never jumps up and down; a real shrink lands afterwards.
        var self = this;
        if (h < this.height && (this.streamingLoaded || Date.now() < this.holdUntil)) {
          this._pendingH = h; clearTimeout(this._shrinkT);
          this._shrinkT = setTimeout(function () { if (self._pendingH != null && !self.streamingLoaded) { var ph = self._pendingH; self._pendingH = null; self.height = ph; self.frame.style.height = ph + 'px'; self._emit('size', ph); } }, Math.max(80, (this.holdUntil || 0) - Date.now() + 80));
          break;
        }
        this._pendingH = null;
        this.height = h; this.frame.style.height = h + 'px'; this._emit('size', h);
        break;
      }
      case 'error': this._emit('error', String(d.message || 'Script error').slice(0, 300)); break;
      case 'fetch': if (this.opts.kind !== 'mcp') web.request(this, d); break;
      case 'prompt': if (typeof d.text === 'string' && d.text.trim()) this._emit('prompt', d.text.slice(0, 4000), Date.now() - this.lastTap < 4000); break;
      case 'link': if (typeof d.url === 'string') this._emit('link', d.url.slice(0, 2000), Date.now() - this.lastTap < 4000); break;
    }
  };
  Controller.prototype._rpc = function (d) { this._emit('rpc', d); };
  Controller.prototype.post = function (msg) {
    try { if (this.frame.contentWindow) { if (this.opts.kind !== 'mcp' || msg.__sds) msg.__sds = this.channel; this.frame.contentWindow.postMessage(msg, '*'); } } catch (_) {}
  };
  Controller.prototype.postRpc = function (msg) { try { if (this.frame.contentWindow) this.frame.contentWindow.postMessage(msg, '*'); } catch (_) {} };
  /** Streaming: one boot document, then partial HTML (scripts stripped) pushed in. */
  Controller.prototype.stream = function (html) {
    if (!this.streamingLoaded) {
      this.streamingLoaded = true; this.booted = false;
      this.frame.srcdoc = buildDocument({ kind: this.opts.kind, streaming: true, channel: this.channel, mode: this.opts.mode, theme: theme() });
    }
    if (this.booted) this.post({ type: 'stream', html: String(html || '') });
    else this._pendingStream = String(html || '');
  };
  /** Final document with scripts. A fresh channel invalidates the old document. */
  Controller.prototype.load = function (source, extra) {
    this.channel = channelId(); this.booted = false; this.streamingLoaded = false;
    this.holdUntil = Date.now() + 1400;
    var o = {}; for (var k in this.opts) o[k] = this.opts[k];
    if (extra) for (var j in extra) o[j] = extra[j];
    o.source = source; o.channel = this.channel; o.theme = theme();
    this.source = source;
    this.frame.srcdoc = buildDocument(o);
  };
  Controller.prototype.setTheme = function (t) { if (this.opts.kind === 'mcp') this._emit('theme', t); else this.post({ type: 'theme', theme: t }); };
  Controller.prototype.destroy = function () {
    var i = controllers.indexOf(this); if (i >= 0) controllers.splice(i, 1);
    try { this.frame.removeAttribute('srcdoc'); this.frame.src = 'about:blank'; } catch (_) {}
    if (this.frame.parentNode) this.frame.parentNode.removeChild(this.frame);
  };

  function create(opts) { return new Controller(opts || {}); }
  function sweep() {
    // Frames removed from the DOM by the host page (re-render, navigation).
    for (var i = controllers.length - 1; i >= 0; i--) { var c = controllers[i]; if (c.frame && !c.frame.isConnected && c.attachedOnce) controllers.splice(i, 1); else if (c.frame && c.frame.isConnected) c.attachedOnce = true; }
  }
  // Theme follows the page live (no reload of running frames).
  var lastTheme = null;
  // Host-side UI (viewer, cards, menus) styles itself from this attribute.
  function mark(t) { try { if (doc.documentElement.getAttribute('data-sd-theme') !== t) doc.documentElement.setAttribute('data-sd-theme', t); } catch (_) {} }
  function themeTick() {
    var t = theme();
    if (t !== lastTheme) { lastTheme = t; mark(t); controllers.forEach(function (c) { c.setTheme(t); }); }
    sweep();
  }
  if (doc && typeof MutationObserver === 'function') {
    var start = function () {
      lastTheme = theme(); mark(lastTheme);
      var mo = new MutationObserver(themeTick);
      if (doc.body) mo.observe(doc.body, { attributes: true, attributeFilter: ['class'] });
      mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
      setInterval(sweep, 5000);
    };
    if (doc.body) start(); else doc.addEventListener('DOMContentLoaded', start);
  }

  root.__sdGenUIFrame = {
    version: 1,
    web: web,
    theme: theme,
    design: function () { return DESIGN; },
    csp: cspFor,
    cleanDomains: cleanDomains,
    buildDocument: buildDocument,
    isFullDocument: isFullDocument,
    create: create,
    controllers: function () { return controllers.slice(); },
    sandbox: SANDBOX,
    _fetchRuntime: fetchRuntime,
    protectLoops: protectLoops,
    protectDocumentScripts: protectDocumentScripts,
    loopLimitMs: LOOP_MS
  };
})(window);
