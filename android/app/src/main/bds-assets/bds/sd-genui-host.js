/* Super DeepSeek — Generative UI host adapter.
 *
 * One place for everything that touches the host page (chat.deepseek.com) or
 * the native bridge, so renderers stay small and testable:
 *  - configurable selectors + code-block discovery for both DOM shapes
 *    (DeepSeek `.md-code-block` + banner, and plain `pre > code.language-x`)
 *  - diagnose(): what the adapter can see right now (for support/debugging)
 *  - secret redaction, bounded persistent execution ledger
 *  - sendPrompt(): user-initiated composer fill with duplicate-dispatch guard
 *  - guard(): per-module failure circuit so one broken UI never breaks chat
 *  - iframe watchdog (CSP-blocked frames fall back to the isolated viewer)
 *  - export / native share / SVG→PNG / CSV helpers, always redacted
 * No generated content can reach this API: generated HTML runs only in
 * sandboxed frames or the bridge-free native viewer.
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIHost && root.__sdGenUIHost.version === 1) return;
  var doc = root.document;

  function cfg() {
    try { if (root.__sdGenUIPrompt) return root.__sdGenUIPrompt.getConfig(); } catch (_) {}
    return { enabled: true, inject: true, frequency: 'auto', interval: 3, fallbackRenderer: true, modules: {}, selectors: { message: '.ds-message', markdown: '.ds-markdown', composer: 'textarea' } };
  }
  function enabled() { return cfg().enabled !== false; }
  function bridge() { return root.AndroidBridge || null; }
  function sget(k) {
    try { var b = bridge(); if (b && typeof b.getStorage === 'function') return b.getStorage(k); return root.localStorage ? root.localStorage.getItem(k) : null; } catch (_) { return null; }
  }
  function sset(k, v) {
    try { var b = bridge(); if (b && typeof b.setStorage === 'function') { b.setStorage(k, v); return true; } if (root.localStorage) { root.localStorage.setItem(k, v); return true; } } catch (_) {}
    return false;
  }
  function hash(s) { var n = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { n ^= s.charCodeAt(i); n = Math.imul(n, 16777619); } return (n >>> 0).toString(36); }
  function now() { return Date.now(); }

  /* ---------------- selectors & code blocks ---------------- */
  var LANG_RE = /^[a-z0-9][a-z0-9_+.-]{0,31}$/i;
  function safeQueryAll(scope, selector) { try { return Array.prototype.slice.call(scope.querySelectorAll(selector)); } catch (_) { return []; } }
  function langFromClass(node) {
    if (!node || !node.className || typeof node.className !== 'string') return '';
    var m = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+.-]+)/.exec(node.className);
    return m ? m[1].toLowerCase() : '';
  }
  function langFromBanner(container) {
    var banner = container.querySelector('.md-code-block-banner') || container.querySelector('[class*="code-block-banner"]');
    if (!banner) return '';
    var spans = banner.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
      var t = (spans[i].textContent || '').trim().toLowerCase();
      if (t && LANG_RE.test(t) && spans[i].children.length === 0) return t;
    }
    var first = (banner.textContent || '').trim().split(/\s+/)[0].toLowerCase();
    return LANG_RE.test(first) ? first : '';
  }
  /** All rendered fenced code blocks inside assistant markdown. */
  function codeBlocks(scope) {
    scope = scope || doc;
    if (!scope || !scope.querySelectorAll) return [];
    var c = cfg(), out = [], seen = [];
    var messages = safeQueryAll(scope, c.selectors.message);
    if (!messages.length && scope !== doc) messages = [scope];
    messages.forEach(function (message) {
      safeQueryAll(message, '.md-code-block, pre').forEach(function (node) {
        var container = node.classList && node.classList.contains('md-code-block') ? node : (node.closest && node.closest('.md-code-block')) || node;
        if (seen.indexOf(container) >= 0) return;
        seen.push(container);
        var pre = container.tagName === 'PRE' ? container : container.querySelector('pre');
        if (!pre) return;
        var code = pre.querySelector('code');
        var lang = langFromClass(code) || langFromClass(pre) || (container !== pre ? langFromBanner(container) : '');
        if (!lang) return;
        out.push({ lang: lang, text: (code || pre).textContent || '', pre: pre, code: code || pre, container: container, message: message });
      });
    });
    return out;
  }
  /** True when the markdown has rendered something after this block, i.e. the fence closed. */
  function followed(block) {
    try {
      var msgs = doc.querySelectorAll(cfg().selectors.message);
      if (block.message && msgs.length && msgs[msgs.length - 1] !== block.message && block.message.compareDocumentPosition(msgs[msgs.length - 1]) & 4) return true;
    } catch (_) {}
    var n = block.container;
    while (n && n !== block.message) {
      var sib = n.nextElementSibling;
      while (sib) {
        if (!(sib.hasAttribute && sib.hasAttribute('data-sd-owned')) && !(sib.classList && (sib.classList.contains('sd-artifact') || sib.classList.contains('sd-genui-surface')))) return true;
        sib = sib.nextElementSibling;
      }
      n = n.parentElement;
    }
    return false;
  }


  /* ---------------- synchronous claim (no raw-code flash) ----------------
   * Renderers scan on a short timer; without this the page would paint the
   * raw fenced code first and swap it a moment later (and old chats would
   * flash every block). MutationObserver callbacks run as microtasks, before
   * the next paint: a block in one of our languages is hidden right there and
   * a skeleton that matches the final surface takes its place. The renderer
   * then hands over (claimDone) or gives the block back (unclaim). */
  var CLAIM = { 'sds-visual': 'visual', 'sds-widget': 'visual', 'visual': 'visual', 'show-widget': 'visual',
    'sds-genui': 'artifact', 'sds-artifact': 'artifact', 'sds-svg': 'artifact', 'sds-html': 'artifact',
    'sds-ui': 'ui', 'svg': 'svg', 'xml': 'svg', 'html': 'html', 'htm': 'html' };
  var claimed = typeof WeakMap === 'function' ? new WeakMap() : null, claimHooks = [];
  function claimLabel(kind) {
    var b = false; try { b = (doc.documentElement.lang || root.navigator.language || '').toLowerCase().indexOf('bn') === 0; } catch (_) {}
    if (kind === 'artifact' || kind === 'html') return b ? 'আর্টিফ্যাক্ট তৈরি হচ্ছে' : 'Creating artifact';
    if (kind === 'ui') return b ? 'উইজেট তৈরি হচ্ছে' : 'Building widget';
    return b ? 'ভিজুয়াল তৈরি হচ্ছে' : 'Creating visual';
  }
  function skeleton(kind) {
    var n = doc.createElement('div');
    n.className = 'sd-skel sd-skel-' + kind;
    n.setAttribute('data-sd-owned', 'claim');
    n.setAttribute('role', 'status');
    n.setAttribute('aria-live', 'polite');
    var dot = doc.createElement('span'); dot.className = 'sd-skel-dot';
    var label = doc.createElement('span'); label.className = 'sd-skel-label'; label.textContent = claimLabel(kind);
    var row = doc.createElement('div'); row.className = 'sd-skel-row'; row.append(dot, label);
    n.appendChild(row);
    if (kind !== 'artifact' && kind !== 'html') { for (var i = 0; i < 3; i++) { var l = doc.createElement('div'); l.className = 'sd-skel-line'; n.appendChild(l); } }
    return n;
  }
  /** Does the block's current text belong to us for a conditional language? true / false / null (undecided). */
  function conditionalMatch(kind, lang, text) {
    var head = String(text || '').replace(/^\s+/, '').slice(0, 64).toLowerCase();
    if (kind === 'svg') {
      if (cfg().fallbackRenderer === false) return false;
      if (!head) return lang === 'svg' ? null : null;
      if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(head)) return true;
      if ('<svg'.indexOf(head) === 0 || '<?xml'.indexOf(head) === 0 || /^<\?xml[^>]*$/.test(head) || /^<!--/.test(head)) return null;
      return false;
    }
    if (kind === 'html') {
      if (cfg().fallbackRenderer === false) return false;
      if (!head) return null;
      if (/^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype html|<html[\s>])/.test(head)) return true;
      if ('<!doctype html'.indexOf(head) === 0 || '<html'.indexOf(head) === 0 || /^<!--/.test(head)) return null;
      return false;
    }
    return true;
  }
  function claimContainer(container, message) {
    if (!claimed || claimed.get(container) === 'no' || claimed.get(container) === 'done') return;
    var st = claimed.get(container);
    if (st && st.skel) { // already claimed: keep the skeleton next to the block
      if (st.cond) {
        var pre0 = container.tagName === 'PRE' ? container : container.querySelector('pre');
        var m0 = conditionalMatch(st.kind, st.lang, pre0 && pre0.textContent);
        if (m0 === false) { unclaim(container); claimed.set(container, 'no'); return; }
      }
      if (!st.skel.isConnected && container.parentNode && container.getAttribute('data-sd-hidden') === 'claim') container.parentNode.insertBefore(st.skel, container.nextSibling);
      return;
    }
    var pre = container.tagName === 'PRE' ? container : container.querySelector('pre');
    var code = pre && pre.querySelector('code');
    var lang = langFromClass(code) || langFromClass(pre) || (container !== pre ? langFromBanner(container) : '');
    if (!lang) return; // banner not rendered yet: decide on a later mutation
    var kind = CLAIM[lang];
    if (!kind) { claimed.set(container, 'no'); return; }
    var cond = kind === 'svg' || kind === 'html';
    if (cond) {
      var m = conditionalMatch(kind, lang, pre ? pre.textContent : '');
      if (m === false) { claimed.set(container, 'no'); return; }
      if (m === null) return;
    }
    if (container.hasAttribute('data-sd-hidden') || container.hasAttribute('data-sd-genui-hidden')) { claimed.set(container, 'done'); return; }
    var sk = skeleton(kind === 'svg' ? 'visual' : kind);
    container.setAttribute('data-sd-hidden', 'claim');
    if (container.parentNode) container.parentNode.insertBefore(sk, container.nextSibling);
    claimed.set(container, { skel: sk, kind: kind, lang: lang, cond: cond, at: now() });
    for (var i = 0; i < claimHooks.length; i++) { try { claimHooks[i](container); } catch (_) {} }
  }
  /** A renderer took the block over: drop the skeleton, keep the source hidden. */
  function claimDone(container) {
    if (!claimed || !container) return;
    var st = claimed.get(container);
    if (st && st.skel) st.skel.remove();
    if (container.getAttribute('data-sd-hidden') === 'claim') container.setAttribute('data-sd-hidden', 'rendered');
    claimed.set(container, 'done');
  }
  /** The block is not ours after all (snippet, disabled): show it as code. */
  function unclaim(container) {
    if (!claimed || !container) return;
    var st = claimed.get(container);
    if (st && st.skel) st.skel.remove();
    if (container.getAttribute('data-sd-hidden') === 'claim') container.removeAttribute('data-sd-hidden');
    claimed.set(container, 'no');
  }
  function isClaimed(container) { var st = claimed && claimed.get(container); return !!(st && st.skel); }
  var CODE_SEL = '.md-code-block, pre';
  function claimScan(node) {
    if (!node || node.nodeType !== 1) return;
    var msgSel = cfg().selectors.message;
    var list = [];
    if (node.matches && node.matches(CODE_SEL)) list.push(node);
    else if (node.closest) { var up = node.closest(CODE_SEL); if (up) list.push(up); }
    if (node.querySelectorAll && node.firstElementChild) { var inner = node.querySelectorAll(CODE_SEL); for (var i = 0; i < inner.length; i++) list.push(inner[i]); }
    for (var j = 0; j < list.length; j++) {
      var c = list[j];
      var container = c.classList && c.classList.contains('md-code-block') ? c : (c.closest && c.closest('.md-code-block')) || c;
      if (container.closest && container.closest('[data-sd-owned],#sd-viewer')) continue;
      var message = null; try { message = container.closest(msgSel); } catch (_) {}
      if (!message) continue;
      claimContainer(container, message);
    }
  }
  function onClaimMutations(records) {
    if (!enabled()) return;
    try {
      for (var i = 0; i < records.length; i++) {
        var r = records[i], tg = r.target;
        if (tg && tg.nodeType === 3) tg = tg.parentNode;
        if (!tg || tg.nodeType !== 1) continue;
        if (r.type === 'childList' && r.addedNodes.length) {
          for (var k = 0; k < r.addedNodes.length; k++) { var a = r.addedNodes[k]; claimScan(a.nodeType === 3 ? a.parentNode : a); }
        } else if (r.type === 'characterData' || r.type === 'childList') {
          var up = tg.closest && tg.closest(CODE_SEL); if (up) claimScan(up);
        }
      }
    } catch (_) {}
  }
  var claimStarted = false;
  function startClaim() {
    if (claimStarted || !doc || !doc.body || !root.MutationObserver || !claimed) return;
    claimStarted = true;
    new root.MutationObserver(onClaimMutations).observe(doc.body, { childList: true, subtree: true, characterData: true });
    try { claimScan(doc.body); } catch (_) {}
    if (root.addEventListener) root.addEventListener('sd-genui:config', function (e) {
      if (e.detail && e.detail.enabled === false) {
        // Kill switch: give every block back to the page.
        try {
          doc.querySelectorAll('.sd-skel').forEach(function (n) { n.remove(); });
          doc.querySelectorAll('[data-sd-hidden="claim"],[data-sd-hidden="rendered"]').forEach(function (n) { n.removeAttribute('data-sd-hidden'); });
        } catch (_) {}
        claimed = new WeakMap();
      } else { try { claimScan(doc.body); } catch (_) {} }
    });
    // Orphan skeletons (host re-render removed the block) are swept.
    setInterval(function () {
      try { doc.querySelectorAll('.sd-skel').forEach(function (n) { var p = n.previousElementSibling; if (!p || p.getAttribute('data-sd-hidden') !== 'claim') n.remove(); }); } catch (_) {}
    }, 2000);
  }

  /* ---------------- redaction ---------------- */
  var SECRET_RULES = [
    [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, 'sk-•••'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'gh_•••'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_•••'],
    [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA•••'],
    [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza•••'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox•••'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt•••'],
    [/(\bBearer\s+)[A-Za-z0-9._~+\/=-]{12,}/gi, '$1•••'],
    [/((?:["']?)(?:api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd|authorization)(?:["']?)\s*[:=]\s*)(["']?)([^"'\s,;}{]{4,})\2/gi, '$1$2•••$2'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]']
  ];
  function redact(text) {
    var s = String(text == null ? '' : text), count = 0;
    SECRET_RULES.forEach(function (rule) {
      s = s.replace(rule[0], function () {
        count++;
        var args = arguments;
        return rule[1].replace(/\$(\d)/g, function (_, i) { return args[Number(i)] || ''; });
      });
    });
    return { text: s, count: count };
  }

  /* ---------------- execution ledger ---------------- */
  var LEDGER_KEY = 'sd_exec_ledger_v1', LEDGER_MAX = 120;
  var ledgerItems = null;
  function ledgerLoad() {
    if (ledgerItems) return ledgerItems;
    try { var raw = sget(LEDGER_KEY); var v = raw && raw.length < 400000 ? JSON.parse(raw) : null; ledgerItems = v && Array.isArray(v.items) ? v.items.slice(0, LEDGER_MAX) : []; } catch (_) { ledgerItems = []; }
    return ledgerItems;
  }
  var ledgerTimer = null;
  function ledgerPersist() {
    if (ledgerTimer) return;
    ledgerTimer = setTimeout(function () { ledgerTimer = null; sset(LEDGER_KEY, JSON.stringify({ version: 1, items: ledgerLoad().slice(0, LEDGER_MAX) })); }, 400);
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  var ledger = {
    record: function (entry) {
      var items = ledgerLoad();
      var e = {
        id: 'x' + now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: clip(entry.type || 'event', 24), title: clip(redact(entry.title || '').text, 120),
        detail: clip(redact(entry.detail || '').text, 400), state: clip(entry.state || 'running', 16),
        startedAt: entry.startedAt || now(), endedAt: entry.endedAt || null, key: entry.key ? clip(entry.key, 80) : undefined
      };
      items.unshift(e);
      if (items.length > LEDGER_MAX) items.length = LEDGER_MAX;
      ledgerPersist();
      return e.id;
    },
    update: function (id, patch) {
      var items = ledgerLoad();
      for (var i = 0; i < items.length; i++) if (items[i].id === id) {
        if (patch.state) items[i].state = clip(patch.state, 16);
        if (patch.detail !== undefined) items[i].detail = clip(redact(patch.detail).text, 400);
        if (patch.endedAt) items[i].endedAt = patch.endedAt;
        ledgerPersist();
        return true;
      }
      return false;
    },
    find: function (key) { var items = ledgerLoad(); for (var i = 0; i < items.length; i++) if (items[i].key === key) return items[i]; return null; },
    list: function () { return ledgerLoad().slice(); },
    clear: function () { ledgerItems = []; sset(LEDGER_KEY, JSON.stringify({ version: 1, items: [] })); },
    exportJson: function () { return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: ledgerLoad() }, null, 2); }
  };

  /* ---------------- module guard (circuit breaker + timing) ---------------- */
  var health = Object.create(null);
  function guard(name, fn, fallback) {
    var h = health[name] || (health[name] = { calls: 0, failures: 0, consecutive: 0, open: false, slow: 0, lastError: '' });
    if (h.open || !enabled()) return fallback;
    var t0 = now();
    try {
      var r = fn();
      h.calls++; h.consecutive = 0;
      if (now() - t0 > 50) h.slow++;
      return r;
    } catch (e) {
      h.calls++; h.failures++; h.consecutive++;
      h.lastError = clip(e && e.message || e, 200);
      // Five consecutive failures: stop this module for the session; chat keeps working.
      if (h.consecutive >= 5) { h.open = true; try { console.warn('[SDS GenUI] module disabled after repeated failures:', name, h.lastError); } catch (_) {} }
      return fallback;
    }
  }

  /* ---------------- iframe watchdog ---------------- */
  // Host pages may forbid frames via CSP (frame-src / child-src). Chromium then
  // fires a standard `securitypolicyviolation` event; every frame we watch gets
  // the isolated-viewer fallback instead of a broken box. A load timeout covers
  // engines that fail silently.
  var watched = [], frameBlocked = false;
  if (doc && doc.addEventListener) doc.addEventListener('securitypolicyviolation', function (e) {
    var d = String(e.effectiveDirective || e.violatedDirective || '');
    if (!/^(frame-src|child-src|default-src)/.test(d)) return;
    if (d.indexOf('default-src') === 0 && !/^(about|data|blob)/.test(String(e.blockedURI || ''))) return;
    frameBlocked = true;
    watched.forEach(function (w) { if (!w.blocked) { w.blocked = true; try { w.onBlocked('csp'); } catch (_) {} } });
  });
  // srcdoc frames inherit the host page's CSP. If the host forbids inline styles
  // (or frames), previews would render broken. A one-time probe with constant,
  // script-free content measures this deterministically. allow-same-origin is
  // used ONLY for this probe (no scripts, our own markup) so the parent can read it.
  var probeState = 'idle', probeWaiters = [];
  function probePreview(cb) {
    if (probeState === 'ok' || probeState === 'blocked') { cb(probeState); return; }
    probeWaiters.push(cb);
    if (probeState === 'running' || !doc || !doc.body) return;
    probeState = 'running';
    var f = doc.createElement('iframe'), finished = false;
    f.setAttribute('sandbox', 'allow-same-origin'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
    f.style.cssText = 'position:absolute;width:80px;height:40px;left:-9999px;top:0;border:0;visibility:hidden';
    function finish(state) {
      if (finished) return; finished = true;
      probeState = state; try { f.remove(); } catch (_) {}
      var w = probeWaiters; probeWaiters = [];
      w.forEach(function (fn) { try { fn(state); } catch (_) {} });
    }
    f.addEventListener('load', function () {
      try {
        var d = f.contentDocument, n = d && d.getElementById('p');
        finish(n && Math.round(n.getBoundingClientRect().width) === 37 ? 'ok' : 'blocked');
      } catch (_) { finish('ok'); }
    }, { once: true });
    setTimeout(function () { finish(frameBlocked ? 'blocked' : 'ok'); }, 2500);
    f.srcdoc = '<!doctype html><style>#p{display:block;width:37px;height:3px}</style><div id="p"></div>';
    doc.body.appendChild(f);
  }
  /** Calls onBlocked(reason) if the frame is blocked by CSP or never loads. */
  function watchFrame(frame, ms, onBlocked) {
    var w = { frame: frame, blocked: false, loaded: false, onBlocked: onBlocked };
    function block(reason) { if (!w.blocked) { w.blocked = true; try { onBlocked(reason); } catch (_) {} } }
    if (frameBlocked) { setTimeout(function () { block('csp'); }, 0); return; }
    watched.push(w);
    probePreview(function (state) { if (state === 'blocked') block('csp'); });
    frame.addEventListener('load', function () { w.loaded = true; }, { once: true });
    setTimeout(function () { if (!w.loaded) block('timeout'); }, ms || 3000);
    // Violation reports are async; keep listening for a while after load.
    setTimeout(function () { watched = watched.filter(function (x) { return x !== w; }); }, 10000);
  }

  /* ---------------- sendPrompt (user-initiated only) ---------------- */
  var lastSend = { hash: '', at: 0 };
  function composer() {
    var sel = cfg().selectors.composer;
    // Never our own editors; visible = has layout boxes (offsetParent is null for position:fixed).
    var all = safeQueryAll(doc, sel).filter(function (n) { return !(n.closest && n.closest('.sd-artifact,#sd-genui-panel,#sd-viewer,[data-sd-owned]')); });
    var list = all.filter(function (n) { return !n.disabled && n.getClientRects && n.getClientRects().length > 0; });
    return list[list.length - 1] || all[0] || null;
  }
  function sendPrompt(text, opts) {
    opts = opts || {};
    if (!enabled()) return { ok: false, error: 'Generative UI is turned off' };
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Empty prompt' };
    if (text.length > 8000) return { ok: false, error: 'Prompt too long' };
    var r = redact(text);
    if (r.count) return { ok: false, error: 'Prompt contains what looks like a secret; not inserted' };
    var h = hash(text);
    if (lastSend.hash === h && now() - lastSend.at < 4000) return { ok: false, error: 'Duplicate request ignored' };
    var input = composer();
    if (!input) return { ok: false, error: 'Composer not found (check selectors in Generative UI settings)' };
    var proto = input.tagName === 'TEXTAREA' ? root.HTMLTextAreaElement && root.HTMLTextAreaElement.prototype : root.HTMLInputElement && root.HTMLInputElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, text); else input.value = text;
    input.dispatchEvent(new root.Event('input', { bubbles: true }));
    try { input.focus(); } catch (_) {}
    lastSend = { hash: h, at: now() };
    var submitted = false;
    // Submitting is only allowed from a trusted user gesture on host UI.
    if (opts.submit === true && ((opts.event && opts.event.isTrusted) || opts.frameTap === true)) {
      input.dispatchEvent(new root.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      submitted = true;
    }
    ledger.record({ type: 'prompt', title: opts.label || 'Prompt prepared', detail: clip(text, 200), state: submitted ? 'sent' : 'drafted', endedAt: now() });
    return { ok: true, submitted: submitted };
  }

  /* ---------------- export / share / png / csv ---------------- */
  function b64(text) {
    var bytes = new root.TextEncoder().encode(text), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return root.btoa(bin);
  }
  function safeName(name) { return String(name || 'artifact').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'artifact'; }
  function downloadBase64(base64, mime, name) {
    var b = bridge();
    if (b && typeof b.downloadBlob === 'function') { b.downloadBlob(base64, mime, safeName(name)); return 'native'; }
    var a = doc.createElement('a'); a.href = 'data:' + mime + ';base64,' + base64; a.download = safeName(name); a.click();
    return 'browser';
  }
  /** Redacts secrets, then downloads. Returns {redacted:n, via}. */
  function exportText(text, mime, name) {
    var r = redact(text);
    return { redacted: r.count, via: downloadBase64(b64(r.text), mime, name) };
  }
  function shareBase64(base64, mime, name, title) {
    var b = bridge();
    if (b && typeof b.shareFile === 'function') { return b.shareFile(base64, mime, safeName(name), String(title || name).slice(0, 80)) ? 'native' : 'failed'; }
    if (root.navigator && typeof root.navigator.share === 'function' && typeof root.File === 'function') {
      try {
        var bin = root.atob(base64), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        root.navigator.share({ files: [new root.File([arr], safeName(name), { type: mime })], title: title || name }).catch(function () {});
        return 'web';
      } catch (_) {}
    }
    downloadBase64(base64, mime, name);
    return 'download';
  }
  function shareText(text, mime, name, title) {
    var r = redact(text);
    return { redacted: r.count, via: shareBase64(b64(r.text), mime, name, title) };
  }
  /** Rasterizes sanitized SVG markup to a PNG (base64, no prefix). */
  function svgToPng(svgMarkup, maxSide) {
    return new Promise(function (resolve, reject) {
      var markup = String(svgMarkup);
      if (!/^<svg[\s>]/i.test(markup)) return reject(Error('Not an SVG'));
      if (!/xmlns=/.test(markup.slice(0, 200))) markup = '<svg xmlns="http://www.w3.org/2000/svg"' + markup.slice(4);
      var vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(markup);
      var w = vb ? Number(vb[1]) : Number((/\swidth\s*=\s*["']?([\d.]+)/i.exec(markup) || [])[1]) || 800;
      var hgt = vb ? Number(vb[2]) : Number((/\sheight\s*=\s*["']?([\d.]+)/i.exec(markup) || [])[1]) || 600;
      var side = maxSide || 1600, scale = Math.min(4, side / Math.max(w, hgt));
      var img = new root.Image();
      var timer = setTimeout(function () { reject(Error('PNG render timed out')); }, 6000);
      img.onload = function () {
        clearTimeout(timer);
        try {
          var c = doc.createElement('canvas'); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(hgt * scale));
          var ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png').split(',')[1]);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { clearTimeout(timer); reject(Error('SVG could not be rasterized')); };
      img.src = 'data:image/svg+xml;base64,' + b64(markup);
    });
  }
  function csvCell(v) {
    var s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula-injection guard
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(columns, rows) {
    var lines = [columns.map(csvCell).join(',')];
    rows.forEach(function (r) { lines.push((Array.isArray(r) ? r : columns.map(function (c) { return r[c]; })).map(csvCell).join(',')); });
    return '\ufeff' + lines.join('\r\n');
  }

  /* ---------------- execution cards (engine MCP calls + sandbox agent) ---------------- */
  // Decorates existing engine cards with state + elapsed time via data attributes
  // only (no structural DOM changes inside Svelte-owned nodes), and records each
  // call in the ledger.
  var execTracked = typeof WeakMap === 'function' ? new WeakMap() : null;
  function fmtElapsed(ms) { var s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
  function scanExecCards() {
    if (!doc || !execTracked) return;
    safeQueryAll(doc, '.bds-mcp-loading').forEach(function (card) {
      var t = execTracked.get(card);
      var title = (card.querySelector('.bds-mcp-loading-title') || {}).textContent || 'Tool call';
      var server = (card.querySelector('.bds-mcp-loading-server') || {}).textContent || '';
      var args = (card.querySelector('.bds-mcp-loading-args') || {}).textContent || '';
      var finished = card.classList.contains('sd-done') ? 'done' : card.classList.contains('sd-stopped') ? 'stopped' : '';
      if (!t) {
        var key = 'card-' + hash(title + '|' + server + '|' + args);
        var existing = ledger.find(key);
        t = { start: existing ? existing.startedAt : now(), id: existing ? existing.id : ledger.record({ type: 'tool', title: title, detail: (server ? server + ' · ' : '') + args, key: key }), state: existing ? existing.state : 'running' };
        execTracked.set(card, t);
        card.setAttribute('data-sd-exec', '1');
      }
      var state = finished || (now() - t.start > 120000 ? 'slow' : 'running');
      if (card.getAttribute('data-sd-exec-state') !== state) card.setAttribute('data-sd-exec-state', state);
      if (!t.end) card.setAttribute('data-sd-elapsed', fmtElapsed(now() - t.start));
      if (finished && !t.end) { t.end = now(); ledger.update(t.id, { state: finished, endedAt: t.end }); card.setAttribute('data-sd-elapsed', fmtElapsed(t.end - t.start)); }
    });
  }
  var execTimer = null;
  function startExecWatch() {
    if (execTimer || !doc || !doc.body) return;
    execTimer = setInterval(function () { guard('exec-cards', scanExecCards); }, 1000);
  }

  /* ---------------- diagnostics ---------------- */
  function diagnose() {
    var c = cfg(), blocks = codeBlocks(doc), byLang = {};
    blocks.forEach(function (b) { byLang[b.lang] = (byLang[b.lang] || 0) + 1; });
    var b = bridge();
    return {
      at: new Date().toISOString(),
      enabled: c.enabled, inject: c.inject, frequency: c.frequency, fallbackRenderer: c.fallbackRenderer,
      selectors: c.selectors,
      found: {
        messages: safeQueryAll(doc, c.selectors.message).length,
        markdown: safeQueryAll(doc, c.selectors.markdown).length,
        codeBlocks: blocks.length,
        byLang: byLang,
        composer: !!composer(),
        artifacts: safeQueryAll(doc, '.sd-art').length,
        inlineVisuals: safeQueryAll(doc, '.sd-vis').length,
        mcpApps: safeQueryAll(doc, '.sd-mcp').length,
        legacyVisualizers: safeQueryAll(doc, '.bds-visualizer-card').length,
        inlineWidgets: safeQueryAll(doc, '.sd-genui-surface[data-sd-genui="1"]').length,
        execCards: safeQueryAll(doc, '.bds-mcp-loading').length
      },
      modules: {
        protocol: !!root.__sdGenUIProtocol, svg: !!root.__sdGenUISvg, renderer: !!root.__sdGenUI,
        artifacts: !!root.__sdArtifacts, visuals: !!root.__sdGenUIVisuals, prompt: !!root.__sdGenUIPrompt,
        frame: !!root.__sdGenUIFrame, viewer: !!root.__sdGenUIViewer, inline: !!root.__sdGenUIInline, mcp: !!root.__sdGenUIMcp
      },
      bridge: b ? {
        openGeneratedApp: typeof b.openGeneratedApp === 'function', shareFile: typeof b.shareFile === 'function',
        downloadBlob: typeof b.downloadBlob === 'function'
      } : null,
      health: JSON.parse(JSON.stringify(health)),
      ledgerEntries: ledgerLoad().length
    };
  }

  root.__sdGenUIHost = {
    version: 1,
    config: cfg, enabled: enabled, hash: hash,
    codeBlocks: codeBlocks, followed: followed, composer: composer,
    redact: redact, ledger: ledger, guard: guard, health: function () { return JSON.parse(JSON.stringify(health)); },
    watchFrame: watchFrame, probePreview: probePreview, sendPrompt: sendPrompt, diagnose: diagnose,
    exportText: exportText, shareText: shareText, shareBase64: shareBase64, downloadBase64: downloadBase64,
    svgToPng: svgToPng, toCsv: toCsv, b64: b64, safeName: safeName,
    scanExecCards: scanExecCards, startExecWatch: startExecWatch,
    claimDone: claimDone, unclaim: unclaim, isClaimed: isClaimed, claimScan: claimScan,
    onClaim: function (fn) { if (typeof fn === 'function') claimHooks.push(fn); }
  };
  if (doc && doc.body) { startClaim(); startExecWatch(); }
  else if (doc) doc.addEventListener('DOMContentLoaded', function () { startClaim(); startExecWatch(); });
})(typeof window !== 'undefined' ? window : globalThis);
