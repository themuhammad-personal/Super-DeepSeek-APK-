/*
 * Super DeepSeek — native glue (injected after content.js).
 *
 * Connects the Android side to the engine without touching its internals more
 * than a few one-line hooks in content.js:
 *
 *  - __sdResolvePickedBlobs(result)  picked files arrive as same-origin blob
 *    paths (/__sd/blob/<token>, served natively from the ContentResolver
 *    stream). They are fetched here in parallel and turned into real File
 *    objects (entry.file) — no Base64, no JSON chunks, no size blow-up.
 *  - __sdBridgeFetch(payload)        non-blocking AndroidBridge.fetch.
 *  - __sdAdaptUpload(file, input)    renames text files the chat's file input
 *    would refuse (unknown code/config extensions) to .txt.
 *  - __sdNative.receive(json)        shares, launcher shortcuts, deep links.
 *
 * Plain ES2017, no dependencies; loaded once per document.
 */
(function () {
  'use strict';
  if (window.__sdNative && window.__sdNative.version) return;

  var BLOB_PREFIX = '/__sd/blob/';
  var POOL = 6;
  var FETCH_TIMEOUT_MS = 180000;
  var SANDBOX_TIMEOUT_MS = 32 * 60 * 1000;

  function bridge() { return window.AndroidBridge || null; }

  function engine() { return window.__sdEngine || null; }

  function toast(message) {
    try {
      var e = engine();
      if (e && typeof e.toast === 'function') { e.toast(message); return; }
    } catch (_) {}
    console.info('[SD]', message);
  }

  /** The app's language: the engine's own setting first, then the page / phone. */
  function isBn() {
    try {
      var e = window.__sdEngine;
      var l = e && typeof e.locale === 'function' ? String(e.locale() || '') : '';
      return String(l || document.documentElement.lang || navigator.language || '').toLowerCase().indexOf('bn') === 0;
    } catch (_) { return false; }
  }

  function t(en, bn) { return isBn() ? bn : en; }

  // ── Keyboard: only the user opens it ─────────────────────────────────────
  //
  // The engine and the chat page focus text fields by themselves (after every
  // automatic message, when a question panel appears, when a sheet closes…).
  // On a phone every such focus() popped the soft keyboard and the screen
  // jumped up and down while the agent worked. A focus() that does not follow
  // a real touch or key press now focuses without the keyboard
  // (inputmode="none"); the keyboard comes back as soon as the user taps it.

  var GESTURE_MS = 1000;
  var SILENT = 'data-sd-silent-im';
  var NO_ATTR = '__none__';
  var lastGestureAt = 0;

  function allowKeyboard() { lastGestureAt = Date.now(); }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (tag === 'INPUT') {
      var type = String(el.type || 'text').toLowerCase();
      return !el.readOnly && !el.disabled &&
        ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].indexOf(type) >= 0;
    }
    return !!el.isContentEditable;
  }

  function unsilence(el) {
    if (!el || typeof el.hasAttribute !== 'function' || !el.hasAttribute(SILENT)) return;
    var orig = el.getAttribute(SILENT);
    el.removeAttribute(SILENT);
    if (orig === NO_ATTR) el.removeAttribute('inputmode'); else el.setAttribute('inputmode', orig);
  }

  function installFocusGuard() {
    var proto = typeof HTMLElement === 'function' ? HTMLElement.prototype : null;
    if (!proto || proto.focus.__sdGuard || typeof document.addEventListener !== 'function') return;
    var nativeFocus = proto.focus;
    var guarded = function (_opts) {
      try {
        if (isTextField(this) && document.activeElement !== this && Date.now() - lastGestureAt > GESTURE_MS) {
          if (!this.hasAttribute(SILENT)) {
            this.setAttribute(SILENT, this.hasAttribute('inputmode') ? this.getAttribute('inputmode') : NO_ATTR);
            this.setAttribute('inputmode', 'none');
          }
          return nativeFocus.call(this, { preventScroll: true });
        }
      } catch (_) {}
      return nativeFocus.apply(this, arguments);
    };
    guarded.__sdGuard = true;
    proto.focus = guarded;

    function gesture(ev) { if (ev && ev.isTrusted) lastGestureAt = Date.now(); }
    ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach(function (type) {
      document.addEventListener(type, gesture, true);
    });
    document.addEventListener('focusout', function (ev) { unsilence(ev.target); }, true);
    // A tap on a silenced field gives it its keyboard back.
    document.addEventListener('pointerdown', function (ev) {
      if (!ev.isTrusted || !ev.target || typeof ev.target.closest !== 'function') return;
      var field = ev.target.closest('[' + SILENT + ']');
      if (!field) return;
      unsilence(field);
      field.__sdReopen = true;
    }, true);
    document.addEventListener('click', function (ev) {
      if (!ev.isTrusted || !ev.target || typeof ev.target.closest !== 'function') return;
      var field = ev.target.closest('textarea, input, [contenteditable]');
      if (!field || !field.__sdReopen) return;
      field.__sdReopen = false;
      if (document.activeElement === field) {
        try { field.blur(); nativeFocus.call(field, { preventScroll: true }); } catch (_) {}
      }
    }, true);

    // After every send the keyboard goes away. The send button is a tap
    // outside the field, so the field kept focus (and the keyboard) — only
    // the very first message of a chat, whose page is rebuilt, used to drop
    // it. A tap (or Enter) while the field holds text that then empties the
    // field is a send: blur it, and forget the tap so the page's own refocus
    // after sending stays silent.
    document.addEventListener('pointerdown', function (ev) {
      if (!ev.isTrusted) return;
      var a = document.activeElement;
      if (!isTextField(a)) return;
      if (ev.target === a || (typeof a.contains === 'function' && ev.target && a.contains(ev.target))) {
        lastFieldTapAt = Date.now();
        return;
      }
      if (ev.target && isTextField(ev.target)) { lastFieldTapAt = Date.now(); return; }
      watchSend(a);
    }, true);
    document.addEventListener('keydown', function (ev) {
      if (!ev.isTrusted || !isTextField(ev.target)) return;
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) watchSend(ev.target);
    }, true);
  }

  var SEND_WATCH_MS = 1500;
  var SEND_POLL_MS = 50;
  var lastFieldTapAt = 0;
  var sendWatch = 0;

  function fieldText(el) {
    try {
      var tag = String(el.tagName || '').toUpperCase();
      return String((tag === 'TEXTAREA' || tag === 'INPUT' ? el.value : el.textContent) || '').trim();
    } catch (_) { return ''; }
  }

  function watchSend(field) {
    if (!field || !fieldText(field)) return;
    var id = ++sendWatch;
    var started = Date.now();
    (function poll() {
      if (id !== sendWatch) return;
      // The user went back into a field meanwhile: that keyboard is theirs.
      if (lastFieldTapAt >= started) return;
      var gone = field.isConnected === false;
      if (gone || !fieldText(field)) {
        sendWatch++;
        lastGestureAt = 0;
        var a = document.activeElement;
        var target = gone ? a : field;
        try { if (target && isTextField(target) && document.activeElement === target) target.blur(); } catch (_) {}
        return;
      }
      if (Date.now() - started < SEND_WATCH_MS) setTimeout(poll, SEND_POLL_MS);
    })();
  }

  installFocusGuard();

  // The page may already have focused the composer on load, before this ran.
  (function silenceInitialFocus() {
    try {
      var el = document.activeElement;
      if (!isTextField(el) || Date.now() - lastGestureAt <= GESTURE_MS || el.hasAttribute(SILENT)) return;
      el.setAttribute(SILENT, el.hasAttribute('inputmode') ? el.getAttribute('inputmode') : NO_ATTR);
      el.setAttribute('inputmode', 'none');
      el.blur();
      el.focus({ preventScroll: true });
    } catch (_) {}
  })();

  // Automatic messages are written into the composer and sent by the engine
  // (sdQuiet in content.js marks <html> meanwhile): keep that text from
  // flashing in the composer and from resizing it.
  (function injectQuietStyle() {
    try {
      if (!document.createElement || document.getElementById('sd-quiet-style')) return;
      var st = document.createElement('style');
      st.id = 'sd-quiet-style';
      st.textContent =
        'html.sd-auto-send textarea#chat-input,html.sd-auto-send .ds-textarea textarea,html.sd-auto-send [data-sd-quiet]{' +
        'color:transparent!important;-webkit-text-fill-color:transparent!important;' +
        'caret-color:transparent!important;height:2.4em!important;min-height:0!important;max-height:2.6em!important;overflow:hidden!important;resize:none!important}' +
        'html.sd-auto-send .ds-textarea,html.sd-auto-send [data-sd-quiet-box]{max-height:56px!important;min-height:0!important;overflow:hidden!important}' +
        'html.sd-auto-send [data-sd-quiet]::placeholder{color:transparent!important}' +
        'html.sd-auto-send [data-sd-quiet-box]::after{content:attr(data-sd-quiet-box);position:absolute;' +
        'left:var(--sdq-l,0);top:var(--sdq-t,0);width:var(--sdq-w,100%);height:var(--sdq-h,100%);' +
        'box-sizing:border-box;padding:var(--sdq-p,0);display:flex;align-items:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;' +
        'font-size:13.5px;font-weight:500;line-height:1.4;color:var(--bds-text-secondary,currentColor);opacity:.72;pointer-events:none;' +
        'animation:sd-quiet-pulse 1.6s ease-in-out infinite}' +
        '@keyframes sd-quiet-pulse{0%,100%{opacity:.42}50%{opacity:.78}}';
      (document.head || document.documentElement).appendChild(st);
      watchQuiet();
      // Only genuine typing/pasting hands the composer back to the user;
      // accidental touch/pointerdown while scrolling over the bottom bar must
      // never unmask an in-flight automatic result payload.
      if (typeof document.addEventListener === 'function') {
        var takeOver = function (ev) {
          if (!ev || !ev.isTrusted || !isTextField(ev.target)) return;
          if (ev.type === 'keydown' && ev.key != null) {
            var k = String(ev.key);
            if (k.length > 1 && k !== 'Backspace' && k !== 'Delete' && k !== 'Enter' && k !== 'Process' && k !== 'Unidentified') return;
          }
          var root = document.documentElement;
          if (root && root.classList && root.classList.contains('sd-auto-send')) root.classList.remove('sd-auto-send');
        };
        ['keydown', 'beforeinput', 'paste'].forEach(function (type) { document.addEventListener(type, takeOver, true); });
      }
    } catch (_) {}
  })();

  // While an engine message is on its way, the composer shows one calm line
  // ("Sending results to the AI…") in place of the raw engine text. The mark
  // follows the composer even if the page rebuilds it mid-send.
  var quiet = { field: null, box: null, boxPos: false, timer: 0 };

  function quietComposer() {
    try {
      var c = composer();
      return c && c.nodeType === 1 ? c : null;
    } catch (_) { return null; }
  }

  function unmarkQuiet() {
    try {
      if (quiet.field) quiet.field.removeAttribute('data-sd-quiet');
      if (quiet.box) {
        quiet.box.removeAttribute('data-sd-quiet-box');
        if (quiet.boxPos) quiet.box.style.position = '';
        ['--sdq-l', '--sdq-t', '--sdq-w', '--sdq-h', '--sdq-p'].forEach(function (k) { quiet.box.style.removeProperty(k); });
      }
    } catch (_) {}
    quiet.field = null; quiet.box = null; quiet.boxPos = false;
  }

  function markQuiet() {
    var c = quietComposer();
    if (!c) { unmarkQuiet(); return; }
    if (c !== quiet.field) {
      unmarkQuiet();
      quiet.field = c;
      c.setAttribute('data-sd-quiet', '');
      var box = c.parentElement;
      if (box && box.style) {
        quiet.box = box;
        var cs = typeof getComputedStyle === 'function' ? getComputedStyle(box) : null;
        if (cs && cs.position === 'static') { box.style.position = 'relative'; quiet.boxPos = true; }
        box.setAttribute('data-sd-quiet-box', t('Sending results to the AI…', 'AI-কে ফলাফল পাঠানো হচ্ছে…'));
      }
    }
    try {
      var b = quiet.box;
      if (b) {
        var fcs = typeof getComputedStyle === 'function' ? getComputedStyle(c) : null;
        b.style.setProperty('--sdq-l', c.offsetLeft + 'px');
        b.style.setProperty('--sdq-t', c.offsetTop + 'px');
        b.style.setProperty('--sdq-w', c.offsetWidth + 'px');
        b.style.setProperty('--sdq-h', c.offsetHeight + 'px');
        if (fcs) b.style.setProperty('--sdq-p', fcs.paddingTop + ' ' + fcs.paddingRight + ' ' + fcs.paddingBottom + ' ' + fcs.paddingLeft);
      }
    } catch (_) {}
  }

  function syncQuiet() {
    var root = document.documentElement;
    var on = !!(root && root.classList && root.classList.contains('sd-auto-send'));
    if (on) {
      markQuiet();
      if (!quiet.timer) quiet.timer = setTimeout(function tick() { quiet.timer = 0; syncQuiet(); }, 300);
    } else {
      if (quiet.timer) { clearTimeout(quiet.timer); quiet.timer = 0; }
      unmarkQuiet();
    }
  }

  function watchQuiet() {
    try {
      if (typeof MutationObserver !== 'function' || !document.documentElement) return;
      new MutationObserver(syncQuiet).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      syncQuiet();
    } catch (_) {}
  }

  // ── Mixed-script text direction ───────────────────────────────────────────
  //
  // A reply that mixes Arabic with Bengali (or English) gives every paragraph
  // the direction of the script it is written in — not blindly that of its
  // first letter. "بسم الله — এর অর্থ (পরম করুণাময়ের নামে)" is a Bengali
  // sentence and stays left-to-right with its brackets in place; an Arabic
  // verse followed by a short Bengali note reads right-to-left. Paragraphs split by line breaks
  // decide line by line (CSS in our-skin.css), and bold/italic/link runs are
  // isolated so their own brackets never swap sides.

  var BIDI_ATTR = 'data-sd-bidi';
  var RTL_WORD = null;
  var ANY_WORD = null;
  try {
    RTL_WORD = new RegExp('^[\\p{M}]*[\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}]', 'u');
    ANY_WORD = new RegExp('[\\p{L}\\p{M}]+', 'gu');
  } catch (_) {
    RTL_WORD = /^[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
    ANY_WORD = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u0669\u066E-\u06FF\u0700-\u08FF\u0900-\u0DFF\u3040-\u9FFF\uAC00-\uD7AF\uFB1D-\uFDFF\uFE70-\uFEFF]+/g;
  }
  var BIDI_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd';
  var BIDI_SKIP = 'pre, code, .md-code-block, .katex, math, svg, button, [role="button"]';

  /**
   * '' when there is no right-to-left word at all; else 'rtl' only for a
   * paragraph that starts in a right-to-left script and is mostly written in
   * it, 'ltr' for everything else. A Bengali line quoting Arabic — or opening
   * with an Arabic phrase and going on in Bengali — reads left-to-right.
   * Words are counted, not letters: Bengali spells vowels as marks.
   */
  function scriptDir(text) {
    var words = String(text || '').match(ANY_WORD) || [];
    var rtl = 0;
    var first = '';
    for (var i = 0; i < words.length; i++) {
      var r = RTL_WORD.test(words[i]);
      if (r) rtl++;
      if (!first) first = r ? 'rtl' : 'ltr';
    }
    if (!rtl) return '';
    var ltr = words.length - rtl;
    return first === 'rtl' && rtl > ltr ? 'rtl' : 'ltr';
  }

  /** The element's prose, without code, formulas or buttons inside it. */
  function proseText(el) {
    try {
      if (typeof document.createTreeWalker !== 'function') return String(el.textContent || '');
      var out = '';
      var w = document.createTreeWalker(el, 4);
      var n;
      while ((n = w.nextNode())) {
        var pe = n.parentElement;
        if (pe && pe !== el && typeof pe.closest === 'function') {
          var skip = pe.closest(BIDI_SKIP);
          if (skip && el.contains(skip)) continue;
        }
        out += n.nodeValue;
      }
      return out;
    } catch (_) { return String((el && el.textContent) || ''); }
  }

  function hasLineBreaks(el, text) {
    try {
      if (el.querySelector && el.querySelector('br')) return true;
      if (text.indexOf('\n') < 0) return false;
      var ws = typeof getComputedStyle === 'function' ? getComputedStyle(el).whiteSpace : '';
      return /pre/.test(ws || '');
    } catch (_) { return false; }
  }

  function applyDir(el) {
    try {
      if (!el || el.nodeType !== 1) return;
      var ours = el.hasAttribute(BIDI_ATTR);
      if (!ours && el.hasAttribute('dir')) return; // the page set it: leave it
      var text = proseText(el);
      var d = scriptDir(text);
      var want = !d ? '' : (hasLineBreaks(el, text) ? 'lines' : d);
      if (!want) {
        if (ours) { el.removeAttribute(BIDI_ATTR); el.removeAttribute('dir'); }
        return;
      }
      if (el.getAttribute(BIDI_ATTR) === want) return;
      el.setAttribute(BIDI_ATTR, want);
      if (want === 'lines') el.removeAttribute('dir'); else el.setAttribute('dir', want);
    } catch (_) {}
  }

  /** Plain-text containers of a message that has no Markdown (the user's own bubbles). */
  function plainBubbles(msg) {
    var out = [];
    try {
      if (msg.querySelector('.ds-markdown')) return out;
      var all = msg.querySelectorAll('div, span, p');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el.firstChild || (el.closest && el.closest(BIDI_SKIP + ', [class*="bds-"], [class*="sd-"]'))) continue;
        var textOnly = true;
        for (var c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 1 && c.tagName !== 'BR') { textOnly = false; break; }
        }
        if (textOnly && String(el.textContent || '').trim()) out.push(el);
      }
    } catch (_) {}
    return out;
  }

  function fixDirections(scope) {
    try {
      var root = scope || document;
      if (!root.querySelectorAll) return;
      var md = [];
      if (root.matches && root.matches('.ds-markdown')) md.push(root);
      md = md.concat(Array.prototype.slice.call(root.querySelectorAll('.ds-markdown')));
      md.forEach(function (m) {
        var blocks = m.querySelectorAll(BIDI_BLOCKS);
        for (var i = 0; i < blocks.length; i++) {
          if (blocks[i].closest && blocks[i].closest(BIDI_SKIP)) continue;
          applyDir(blocks[i]);
        }
      });
      var msgs = [];
      if (root.matches && root.matches('.ds-message')) msgs.push(root);
      msgs = msgs.concat(Array.prototype.slice.call(root.querySelectorAll('.ds-message')));
      msgs.forEach(function (msg) { plainBubbles(msg).forEach(applyDir); });
    } catch (_) {}
  }

  /** The composer (textarea, text/search input, or contenteditable) follows what is typed into it. */
  function fixFieldDir(el) {
    try {
      if (!el || el.nodeType !== 1) return;
      var tag = String(el.tagName || '').toUpperCase();
      var field = el;
      if (tag === 'INPUT') {
        var type = String(el.type || 'text').toLowerCase();
        if (type !== '' && type !== 'text' && type !== 'search') return;
      } else if (tag !== 'TEXTAREA') {
        var ce = el.closest ? el.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"][contenteditable]') : null;
        field = ce || (el.isContentEditable ? el : null);
        if (!field) return;
      }
      if (field.readOnly || field.disabled || field.getAttribute('spellcheck') === 'false') return;
      var ours = field.hasAttribute(BIDI_ATTR);
      if (!ours && field.hasAttribute('dir')) return;
      var d = scriptDir(fieldText(field));
      if (!d) { if (ours) { field.removeAttribute(BIDI_ATTR); field.removeAttribute('dir'); } return; }
      field.setAttribute(BIDI_ATTR, d);
      field.setAttribute('dir', d);
    } catch (_) {}
  }

  (function watchDirections() {
    try {
      if (typeof MutationObserver !== 'function' || typeof document.addEventListener !== 'function') return;
      var pending = null;
      var timer = 0;
      var flush = function () {
        timer = 0;
        var scopes = pending;
        pending = null;
        if (scopes === 'all') { fixDirections(document); return; }
        scopes.forEach(function (sc) { fixDirections(sc); });
      };
      var queue = function (node) {
        if (pending === 'all') return;
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        var scope = el && el.closest ? (el.closest('.ds-message') || el.closest('.ds-markdown')) : null;
        if (!scope) {
          // A whole conversation (re)rendered: anything with messages in it.
          if (el && el.querySelector && el.querySelector('.ds-message, .ds-markdown')) pending = 'all';
          return;
        }
        if (!pending) pending = [];
        if (pending.indexOf(scope) < 0) pending.push(scope);
      };
      var start = function () {
        if (!document.body) return false;
        new MutationObserver(function (list) {
          for (var i = 0; i < list.length; i++) {
            queue(list[i].target);
            var added = list[i].addedNodes || [];
            for (var j = 0; j < added.length; j++) queue(added[j]);
          }
          if (pending && !timer) timer = setTimeout(flush, 120);
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
        fixDirections(document);
        return true;
      };
      if (!start()) document.addEventListener('DOMContentLoaded', start);
      document.addEventListener('input', function (ev) { fixFieldDir(ev.target); }, true);
    } catch (_) {}
  })();

  // ── Picked files ───────────────────────────────────────────────────────────

  /** Run fn over items with at most `limit` in flight; results keep their order. */
  function pool(items, limit, fn) {
    var results = new Array(items.length);
    var next = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return Promise.resolve()
        .then(function () { return fn(items[i], i); })
        .then(function (r) { results[i] = r; }, function (err) { results[i] = { __error: err }; })
        .then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  function isBlobPath(p) { return typeof p === 'string' && p.indexOf(BLOB_PREFIX) === 0; }

  function fetchBlob(path) {
    return fetch(path, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('blob ' + r.status);
      return r.blob();
    });
  }

  function release(path) {
    try { var b = bridge(); if (b && typeof b.releaseBlob === 'function') b.releaseBlob(path); } catch (_) {}
  }

  /** One entry {name, mime, blob, text, ...} → the same entry with file (and content for text). */
  function resolveEntry(entry) {
    if (!entry || !isBlobPath(entry.blob)) return Promise.resolve(entry);
    var path = entry.blob;
    return fetchBlob(path).then(function (b) {
      var name = String(entry.name || 'file');
      var baseName = name.split('/').pop() || name;
      var type = entry.text ? 'text/plain' : (entry.mime || b.type || 'application/octet-stream');
      var file = new File([b], baseName, { type: type });
      var out = Object.assign({}, entry, { file: file, size: b.size });
      delete out.blob;
      release(path);
      if (!entry.text) return out;
      return b.text().then(function (text) {
        out.content = text;
        out.encoding = null;
        return out;
      });
    });
  }

  /**
   * The engine's picker result → the same result with every blob entry
   * resolved. Entries that cannot be read move to `skipped` (reason
   * "unreadable") instead of failing the whole pick.
   */
  function resolvePickedBlobs(result) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.files)) return Promise.resolve(result);
    var files = result.files;
    if (!files.some(function (f) { return f && isBlobPath(f.blob); })) return Promise.resolve(result);
    return pool(files, POOL, resolveEntry).then(function (resolved) {
      var ok = [];
      var skipped = Array.isArray(result.skipped) ? result.skipped.slice() : [];
      resolved.forEach(function (r, i) {
        if (r && r.__error) {
          console.warn('[SD] picked file unreadable', files[i] && files[i].name, r.__error);
          skipped.push({ name: (files[i] && files[i].name) || 'file', reason: 'unreadable' });
        } else if (r) {
          ok.push(r);
        }
      });
      return Object.assign({}, result, { files: ok, skipped: skipped });
    });
  }

  // ── Upload adaptation ──────────────────────────────────────────────────────

  function extOf(name) {
    var n = String(name || '').toLowerCase();
    var slash = n.lastIndexOf('/');
    if (slash >= 0) n = n.slice(slash + 1);
    var dot = n.lastIndexOf('.');
    return dot > 0 ? n.slice(dot) : '';
  }

  /** Whether `file` passes an <input accept="..."> list (empty accept = anything). */
  function acceptsFile(accept, file) {
    var list = String(accept || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    if (list.length === 0) return true;
    var ext = extOf(file && file.name);
    var type = String((file && file.type) || '').toLowerCase();
    return list.some(function (a) {
      if (a === '*' || a === '*/*') return true;
      if (a.charAt(0) === '.') return a === ext;
      if (a.slice(-2) === '/*') return type.indexOf(a.slice(0, -1)) === 0;
      return a === type;
    });
  }

  var textLike = /^text\//;

  /**
   * A text file whose extension the chat's input does not list is still text:
   * send it as name.ext.txt (the model sees the original name in it) instead
   * of having the upload refused.
   */
  function adaptUpload(file, input) {
    try {
      if (!(file instanceof File) || !input) return file;
      if (acceptsFile(input.accept, file)) return file;
      if (!textLike.test(file.type || '')) return file;
      return new File([file], file.name + '.txt', { type: 'text/plain', lastModified: file.lastModified });
    } catch (_) {
      return file;
    }
  }

  // ── Non-blocking bridge fetch ──────────────────────────────────────────────

  var pending = Object.create(null);
  var seq = 0;

  function parseReply(json) {
    if (typeof json !== 'string' || json.length === 0) return { ok: false, error: 'Empty response from AndroidBridge.fetch' };
    try { return JSON.parse(json); }
    catch (e) { return { ok: false, error: 'Failed to parse AndroidBridge.fetch response: ' + (e && e.message) }; }
  }

  function bridgeFetch(payload) {
    var b = bridge();
    if (!b) return Promise.resolve({ ok: false, error: '[SDS] window.AndroidBridge is not available.' });
    var body = JSON.stringify(payload || {});
    if (typeof b.fetchAsync !== 'function') {
      // Older native side: the blocking call.
      return Promise.resolve(parseReply(b.fetch(body)));
    }
    return new Promise(function (resolve) {
      var id = 'f' + (++seq) + '_' + Math.random().toString(36).slice(2, 8);
      // Sandbox commands may legitimately run for up to 30 minutes; the
      // native side always answers (it enforces the command's own timeout).
      var ms = /^sandbox/i.test(String((payload && payload.serverUrl) || '')) ? SANDBOX_TIMEOUT_MS : FETCH_TIMEOUT_MS;
      var timer = setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        resolve({ ok: false, error: 'Timed out waiting for AndroidBridge.fetch' });
      }, ms);
      pending[id] = function (reply) { clearTimeout(timer); resolve(reply); };
      try {
        b.fetchAsync(body, id);
      } catch (e) {
        delete pending[id];
        clearTimeout(timer);
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  /** Called by the native side: an inline JSON reply, or a blob path for large ones. */
  function bridgeReply(id, json, blobPath) {
    var done = pending[id];
    if (!done) return;
    delete pending[id];
    if (isBlobPath(blobPath)) {
      fetch(blobPath, { cache: 'no-store' })
        .then(function (r) { return r.text(); })
        .then(function (text) { done(parseReply(text)); }, function (e) {
          done({ ok: false, error: 'Reply unreadable: ' + ((e && e.message) || e) });
        });
      return;
    }
    done(parseReply(json));
  }

  // ── Actions from Android (shares, shortcuts, deep links) ───────────────────

  function composer() {
    var sel = ['textarea#chat-input', '.ds-textarea textarea', 'textarea[placeholder]', '[role="textbox"][contenteditable]'];
    for (var i = 0; i < sel.length; i++) {
      var el = document.querySelector(sel[i]);
      if (el) return el;
    }
    return null;
  }

  function setComposerText(text) {
    var e = engine();
    if (e && typeof e.setComposer === 'function') {
      try { if (e.setComposer(text)) return true; } catch (_) {}
    }
    var el = composer();
    if (!el) return false;
    el.focus();
    if ('value' in el) {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, text); else el.value = text;
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function fileInput() {
    var e = engine();
    if (e && typeof e.fileInput === 'function') {
      try { var i = e.fileInput(); if (i) return i; } catch (_) {}
    }
    var all = document.querySelectorAll('input[type="file"]');
    for (var k = 0; k < all.length; k++) {
      var el = all[k];
      if (!el.disabled && !el.closest('#bds-root, .bds-attach-wrapper')) return el;
    }
    return null;
  }

  function attachFiles(files) {
    var input = fileInput();
    if (!input || files.length === 0) return false;
    var dt = new DataTransfer();
    if (input.files) for (var i = 0; i < input.files.length; i++) dt.items.add(input.files[i]);
    files.forEach(function (f) { dt.items.add(adaptUpload(f, input)); });
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /** Wait until `test()` is truthy (polling), or give up after `ms`. */
  function waitFor(test, ms) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var v = null;
        try { v = test(); } catch (_) {}
        if (v) return resolve(v);
        if (Date.now() - start > ms) return resolve(null);
        setTimeout(poll, 150);
      })();
    });
  }

  function newChat() {
    return new Promise(function (resolve) {
      var e = engine();
      if (e && typeof e.newChat === 'function') {
        var settled = false;
        var finish = function () { if (!settled) { settled = true; resolve(); } };
        try { e.newChat(finish); } catch (_) { finish(); }
        setTimeout(finish, 2500);
        return;
      }
      if (location.pathname !== '/') location.href = 'https://chat.deepseek.com/';
      resolve();
    });
  }

  var REASONS = {
    'too-large': ['over the size limit', 'আকার সীমার বেশি'],
    'unreadable': ['could not be read', 'পড়া যায়নি'],
    'binary': ['not a text file', 'টেক্সট ফাইল নয়'],
    'unsupported-type': ['unsupported type', 'অসমর্থিত ধরন'],
    'image-requires-vision': ['images need a vision model', 'ছবির জন্য ভিশন মডেল দরকার'],
    'image-cap-exceeded': ['too many images', 'অনেক বেশি ছবি'],
    'file-cap-exceeded': ['too many files', 'অনেক বেশি ফাইল'],
  };

  function reasonText(reason) {
    var r = REASONS[reason];
    return r ? t(r[0], r[1]) : String(reason || '');
  }

  /**
   * One line saying which files were not attached and why, e.g.
   * "Not attached (2 of 5): big.iso — over the size limit; x.bin — could not be read".
   */
  function skippedMessage(skipped, attachedCount) {
    if (!skipped || skipped.length === 0) return '';
    var shown = skipped.slice(0, 3).map(function (s) {
      var name = String(s.name || 'file').split('/').pop();
      return name + ' — ' + reasonText(s.reason);
    }).join('; ');
    var more = skipped.length > 3 ? ' (+' + (skipped.length - 3) + ')' : '';
    var count = typeof attachedCount === 'number' && attachedCount > 0
      ? ' (' + skipped.length + '/' + (skipped.length + attachedCount) + ')' : '';
    return t('Not attached', 'সংযুক্ত হয়নি') + count + ': ' + shown + more;
  }

  function receiveShare(action) {
    var text = String(action.text || '');
    var entries = Array.isArray(action.files) ? action.files : [];
    return newChat()
      .then(function () { return waitFor(composer, 8000); })
      .then(function () { return resolvePickedBlobs({ files: entries, skipped: action.skipped || [] }); })
      .then(function (res) {
        var files = (res.files || []).map(function (f) {
          if (f.file instanceof File) return f.file;
          // Inline (small, pre-blob) entries.
          if (f.encoding === 'base64') {
            var bin = atob(String(f.content || ''));
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new File([bytes], f.name || 'file', { type: f.mime || 'application/octet-stream' });
          }
          return new File([String(f.content || '')], f.name || 'file.txt', { type: 'text/plain' });
        });
        if (files.length && !attachFiles(files)) toast(t('Could not attach the shared files.', 'শেয়ার করা ফাইল সংযুক্ত করা যায়নি।'));
        if (text) setComposerText(text);
        var msg = skippedMessage(res.skipped, files.length);
        if (msg) toast(msg);
      });
  }

  function openLink(url) {
    var u;
    try { u = new URL(url); } catch (_) { return; }
    if (u.host !== location.host) return;
    if (u.pathname === location.pathname && u.search === location.search) return;
    var target = u.pathname + u.search;
    var link = document.querySelector('a[href="' + CSS.escape(target) + '"]') ||
      document.querySelector('a[href="' + CSS.escape(u.href) + '"]');
    if (link) { link.click(); return; }
    location.assign(u.href);
  }

  function receiveShortcut(name) {
    if (name === 'new_chat') return newChat();
    if (name === 'deep_research') {
      return newChat().then(function () {
        var e = engine();
        if (e && typeof e.setDeepResearch === 'function') {
          try {
            e.setDeepResearch(true);
            toast(t('Deep Research is on — type your question.', 'ডিপ রিসার্চ চালু — প্রশ্ন লিখুন।'));
          } catch (err) { console.warn('[SD] deep research toggle failed', err); }
        }
        var c = composer();
        // Opened from a launcher shortcut: the user asked to type.
        allowKeyboard();
        if (c) c.focus();
      });
    }
    return Promise.resolve();
  }

  function receive(json) {
    var action;
    try { action = typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return; }
    if (!action || typeof action !== 'object') return;
    var run;
    if (action.type === 'share') run = receiveShare(action);
    else if (action.type === 'shortcut') run = receiveShortcut(String(action.action || ''));
    else if (action.type === 'open') run = Promise.resolve(openLink(String(action.url || '')));
    if (run && run.catch) run.catch(function (e) { console.error('[SD] native action failed', e); });
  }

  window.__sdResolvePickedBlobs = resolvePickedBlobs;
  window.__sdAdaptUpload = adaptUpload;
  window.__sdBridgeFetch = bridgeFetch;
  window.__sdBridgeReply = bridgeReply;
  window.__sdSkipMessage = skippedMessage;
  window.__sdNative = {
    _scriptDir: scriptDir,
    _fixDirections: fixDirections,
    _fixFieldDir: fixFieldDir,
    version: 1,
    receive: receive,
    allowKeyboard: allowKeyboard,
    // Exposed for tests.
    _acceptsFile: acceptsFile,
    _isTextField: isTextField,
    _pool: pool,
  };
})();
