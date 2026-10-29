/* Super DeepSeek — inline visuals (ChatGPT / Claude "visual in the answer" pattern).
 *
 * ```sds-visual blocks, complete raw ```svg blocks and the legacy
 * <SDS:VISUALIZER> cards render INSIDE the message flow: no card chrome, a
 * transparent sandboxed frame that grows to its content, streamed while the
 * model writes (scripts run once the block is complete), and a quiet action
 * row (expand · copy · save as artifact · download · code).
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIInline && root.__sdGenUIInline.version === 1) return;
  var doc = root.document;
  function H() { return root.__sdGenUIHost || null; }
  function F() { return root.__sdGenUIFrame || null; }
  function V() { return root.__sdGenUIViewer || null; }
  function bn() { try { return (doc.documentElement.lang || root.navigator.language || '').toLowerCase().indexOf('bn') === 0; } catch (_) { return false; } }
  function t(en, b) { return bn() ? b : en; }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }

  var VISUAL_LANGS = ['sds-visual', 'sds-widget', 'visual', 'show-widget'];
  var STABLE_MS = 1500;

  /* ---------------- parsing ---------------- */
  /** sds-visual: optional "title: …" header lines ended by --- ; body is HTML/SVG. */
  function parseVisual(text) {
    var s = String(text || '').replace(/\r/g, ''), title = '', body = s;
    var m = /^\s*((?:[a-z][a-z-]{0,20}\s*:[^\n]*\n){1,6})\s*---\s*\n/i.exec(s);
    if (m) {
      body = s.slice(m[0].length);
      var tm = /^\s*title\s*:\s*(.+)$/im.exec(m[1]); if (tm) title = tm[1].trim().slice(0, 120);
    } else {
      var tl = /^\s*title\s*:\s*([^\n<]{1,120})\n/i.exec(s);
      if (tl) { title = tl[1].trim(); body = s.slice(tl[0].length); }
    }
    if (!title) {
      var h = /<title>([^<]{1,120})<\/title>/i.exec(body) || /<h[1-3][^>]*>([^<]{1,120})<\/h[1-3]>/i.exec(body) || /aria-label="([^"]{1,120})"/i.exec(body);
      title = h ? h[1].trim() : t('Visual', 'ভিজুয়াল');
    }
    return { title: title, body: body.replace(/^\s+/, '') };
  }
  function looksSvg(text) { return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text); }
  function svgComplete(text) { return /<\/svg\s*>\s*$/i.test(text); }

  /* ---------------- the inline visual component ---------------- */
  /**
   * create({ kind:'visual'|'svg'|'html'|'mermaid', title, onCode }) → view
   * view.el, view.stream(text), view.finish(text), view.destroy()
   */
  function createView(opts) {
    var Fr = F(), Vw = V();
    var wrap = el('div', 'sd-vis');
    wrap.setAttribute('data-sd-owned', 'inline');
    var stage = el('div', 'sd-vis-stage sd-vis-loading');
    var note = el('div', 'sd-vis-note'); note.hidden = true;
    var bar = el('div', 'sd-vis-bar');
    wrap.append(stage, note, bar);
    var state = { kind: opts.kind || 'visual', title: opts.title || t('Visual', 'ভিজুয়াল'), source: '', final: false, sends: [] };
    var ctrl = Fr ? Fr.create({ kind: state.kind === 'html' ? 'visual' : state.kind, mode: 'inline', title: state.title, initialHeight: 1 }) : null;
    if (ctrl) {
      stage.appendChild(ctrl.frame);
      ctrl.on('size', function (h) { if (h > 30) stage.classList.remove('sd-vis-loading'); });
      ctrl.on('boot', function () { state.booted = true; if (state.final) setTimeout(function () { stage.classList.remove('sd-vis-loading'); }, 1500); });
      ctrl.on('error', function (msg) { if (!state.final) return; showNote('alert', t('This visual hit an error: ', 'ভিজুয়ালে ত্রুটি: ') + msg, t('Fix', 'ঠিক করুন'), function (e) { fix(msg, e); }); });
      ctrl.on('prompt', function (text, tapped) { onPrompt(text, tapped); });
      ctrl.on('link', function (url) { if (Vw) Vw.linkFromFrame(url, showNote); });
    } else {
      stage.classList.remove('sd-vis-loading');
      stage.appendChild(el('div', 'sd-vis-fallback', t('Visual renderer unavailable.', 'ভিজুয়াল রেন্ডারার পাওয়া যায়নি।')));
    }
    function showNote(ic, text, action, fn, sticky) {
      note.textContent = ''; note.hidden = false;
      if (Vw) note.appendChild(Vw.icon(ic, 15));
      note.appendChild(el('span', 'sd-vis-note-text', text));
      if (action) { var b = el('button', 'sd-chip', action); b.type = 'button'; b.addEventListener('click', function (e) { if (!sticky) note.hidden = true; fn(e); }); note.appendChild(b); }
      if (Vw) note.appendChild(Vw.iconButton('x', t('Dismiss', 'বন্ধ'), function () { note.hidden = true; }, 'sd-ib-sm'));
    }
    function onPrompt(text, tapped) {
      var Ho = H(); if (!Ho) return;
      var now = Date.now();
      state.sends = state.sends.filter(function (x) { return now - x < 60000; });
      if (tapped && state.sends.length < 4) {
        state.sends.push(now);
        var r = Ho.sendPrompt(text, { label: 'From visual', submit: true, frameTap: true });
        if (!r.ok) showNote('alert', r.error);
        return;
      }
      if (Vw) Vw.promptFromFrame(text, false, showNote);
    }
    function fix(msg, e) {
      var Ho = H(); if (!Ho) return;
      var r = Ho.sendPrompt('The visual "' + state.title + '" failed with: ' + msg + '\nPlease send a corrected version.', { label: 'Fix visual', submit: true, event: e });
      if (!r.ok && Vw) Vw.toast(r.error);
    }
    function liveVersion() { return { kind: state.kind === 'svg' ? 'svg' : (state.kind === 'mermaid' ? 'mermaid' : 'visual'), title: state.title, payload: state.kind === 'svg' ? { svg: state.source } : { source: state.source } }; }
    // Action row — icons only, like the hover actions under a ChatGPT/Claude visual.
    if (Vw) {
      bar.append(
        Vw.iconButton('expand', t('Expand', 'বড় করে দেখুন'), function () { Vw.open({ live: liveVersion(), key: 'visual:' + Vw.store.hash(state.source) }); }),
        Vw.iconButton('copy', t('Copy code', 'কোড কপি'), function (e, b) { Vw.copyText(state.source).then(function () { flash(b); }, function () { Vw.toast(t('Copy failed', 'কপি ব্যর্থ')); }); }),
        Vw.iconButton('download', t('Download', 'ডাউনলোড'), function () {
          var v = liveVersion();
          if (v.kind === 'svg') Vw.download(v, 'svg', 'image/svg+xml'); else Vw.downloadStandalone(v);
        }),
        Vw.iconButton('file', t('Save as artifact', 'আর্টিফ্যাক্ট হিসেবে সংরক্ষণ'), function () {
          var v = liveVersion(), id = 'visual-' + Vw.store.hash(state.source).slice(0, 10);
          var res = Vw.store.upsert(id, { kind: v.kind === 'visual' ? 'html-app' : v.kind, title: state.title, payload: v.kind === 'visual' ? { html: '', css: '', js: '', source: state.source } : v.payload });
          Vw.toast(t('Saved to artifacts', 'আর্টিফ্যাক্টে সংরক্ষিত'));
          Vw.open({ key: res.record.key });
        })
      );
      if (opts.onCode) bar.appendChild(Vw.iconButton('code', t('Show code', 'কোড দেখুন'), function (e, b) { var on = opts.onCode(); b.classList.toggle('sd-on', !!on); }));
    }
    function flash(b) { b.classList.add('sd-done'); setTimeout(function () { b.classList.remove('sd-done'); }, 1200); }
    bar.hidden = true;
    return {
      el: wrap, state: state, ctrl: ctrl,
      setTitle: function (s) { if (s) { state.title = s; if (ctrl) ctrl.frame.title = s; } },
      stream: function (text) {
        state.source = text;
        if (!ctrl || state.final) return;
        if (state.kind === 'mermaid') return; // mermaid renders once complete
        if (!/</.test(text)) return;
        ctrl.stream(state.kind === 'svg' ? '<div style="display:flex;justify-content:center">' + text + '</div>' : text);
      },
      finish: function (text) {
        if (state.final && text === state.source) return;
        state.final = true; state.source = text; state.booted = false;
        bar.hidden = false;
        if (ctrl) {
          ctrl.load(text);
          // Watchdog: a host CSP that blocks frame scripts means no boot message.
          clearTimeout(state.watch);
          state.watch = setTimeout(function () {
            if (state.booted || !wrap.isConnected) return;
            stage.classList.remove('sd-vis-loading');
            showNote('alert', t('This visual could not start here (blocked by the page). ', 'এখানে ভিজুয়ালটি চালু হয়নি (পেজ ব্লক করেছে)। '), t('Open full screen', 'ফুল স্ক্রিনে খুলুন'), function () { if (Vw) Vw.openNative(liveVersion()); }, true);
          }, 6000);
        }
      },
      destroy: function () { try { if (ctrl) ctrl.destroy(); } catch (_) {} wrap.remove(); }
    };
  }

  /* ---------------- code-block scanning ---------------- */
  var states = new WeakMap(), pending = null;
  function hideBlock(container, on) {
    if (on) container.setAttribute('data-sd-hidden', 'inline');
    else container.removeAttribute('data-sd-hidden');
  }
  function stateFor(block) {
    var s = states.get(block.container);
    if (!s) { s = { text: null, changedAt: 0, view: null, done: false, skip: false }; states.set(block.container, s); }
    return s;
  }
  function mount(block, s, kind, title) {
    var codeShown = false;
    s.view = createView({
      kind: kind, title: title,
      onCode: function () { codeShown = !codeShown; hideBlock(block.container, !codeShown); return codeShown; }
    });
    block.container.parentNode.insertBefore(s.view.el, block.container.nextSibling);
    hideBlock(block.container, true);
    var Ho = H(); if (Ho && Ho.claimDone) Ho.claimDone(block.container);
  }
  function scanOnce() {
    var Ho = H(); if (!Ho || !doc.body) return;
    var config = Ho.config(); if (!config.enabled) return;
    var now = Date.now(), waiting = false;
    Ho.codeBlocks(doc).forEach(function (block) {
      var lang = String(block.lang || '').toLowerCase();
      var isVisual = VISUAL_LANGS.indexOf(lang) >= 0;
      var isSvg = !isVisual && config.fallbackRenderer !== false && (lang === 'svg' || (lang === 'xml' && looksSvg(block.text)));
      if (!isVisual && !isSvg) return;
      var s = stateFor(block);
      if (s.skip) return;
      if (s.view && !s.view.el.isConnected) {
        // Host re-rendered around us: put the view back after its block.
        if (block.container.parentNode) { block.container.parentNode.insertBefore(s.view.el, block.container.nextSibling); hideBlock(block.container, true); }
      }
      var text = block.text;
      if (s.text !== text) { s.text = text; s.changedAt = now; }
      var final = Ho.followed(block) || now - s.changedAt >= STABLE_MS;
      Ho.guard('inline', function () {
        if (isSvg) {
          if (!looksSvg(text)) { if (text.trim().length > 12) { s.skip = true; if (Ho.unclaim) Ho.unclaim(block.container); } return; }
          var src = text.replace(/^\s*<\?xml[^>]*>\s*/i, '').replace(/^(?:\s*<!--[\s\S]*?-->)*\s*/, '').trim();
          if (!s.view) mount(block, s, 'svg', (/<title>([^<]{1,80})<\/title>/i.exec(src) || [])[1] || t('Image', 'ছবি'));
          if (svgComplete(src)) s.view.finish(src);
          else { s.view.stream(src); if (!final) waiting = true; else s.view.finish(src); }
          return;
        }
        var p = parseVisual(text);
        if (!p.body.trim()) { if (!final) waiting = true; return; }
        // Decide the kind only once there is enough text (mermaid vs HTML/SVG).
        if (!s.view && !final && !/</.test(p.body) && p.body.trim().length < 60) { waiting = true; return; }
        var kind = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph)\b/.test(p.body) ? 'mermaid' : 'visual'; // svg-only bodies render fine as visuals; kind is fixed at mount (mid-stream)
        if (!s.view) mount(block, s, kind, p.title);
        s.view.setTitle(p.title);
        if (final) s.view.finish(p.body.trim());
        else { s.view.stream(p.body); waiting = true; }
      });
    });
    if (waiting) schedule(STABLE_MS + 80);
  }

  /* ---------------- legacy <SDS:VISUALIZER> takeover ---------------- */
  // content.js renders the old tag as a 600px bordered card with an iframe whose
  // srcdoc it sets through setAttribute. We capture that document, blank the old
  // frame and show the same content inline with the new renderer instead.
  var legacy = new WeakMap();
  function legacyEnabled() { var Ho = H(); try { return !!(Ho && Ho.config().enabled && Ho.config().modules.legacyVisualizer !== false); } catch (_) { return false; } }
  function takeOverVisualizer(frame, source) {
    var card = frame.closest && frame.closest('.bds-visualizer-card');
    if (!card || !card.parentNode) return false;
    var rec = legacy.get(card);
    if (!rec) {
      rec = { view: createView({ kind: 'visual', title: t('Visual', 'ভিজুয়াল') }) };
      legacy.set(card, rec);
      card.parentNode.insertBefore(rec.view.el, card.nextSibling);
      card.setAttribute('data-sd-hidden', 'legacy');
    }
    var title = (/<title>([^<]{1,80})<\/title>/i.exec(source) || [])[1];
    if (title) rec.view.setTitle(title);
    rec.view.finish(source);
    return true;
  }
  function takeOverPreview(frame, source) {
    var Vw = V(); if (!Vw) return false;
    setTimeout(function () {
      var panel = frame.closest && frame.closest('.bds-preview-panel, .bds-preview-backdrop');
      var closeBtn = panel && (panel.querySelector('.bds-preview-close') || (panel.closest('.bds-preview-backdrop') || panel).querySelector('.bds-preview-close'));
      try { if (closeBtn) closeBtn.click(); } catch (_) {}
      var title = (/<title>([^<]{1,80})<\/title>/i.exec(source) || [])[1] || t('Preview', 'প্রিভিউ');
      Vw.open({ live: { kind: 'html-app', title: title, payload: { html: '', css: '', js: '', source: source } } });
    }, 0);
    return true;
  }
  var BLANK = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
  function patchSetAttribute() {
    var IF = root.HTMLIFrameElement; if (!IF || IF.prototype.__sdPatched) return;
    var orig = root.Element.prototype.setAttribute;
    Object.defineProperty(IF.prototype, '__sdPatched', { value: true });
    IF.prototype.setAttribute = function (name, value) {
      try {
        if (String(name).toLowerCase() === 'srcdoc' && this.classList && legacyEnabled()) {
          var src = String(value == null ? '' : value);
          if (this.classList.contains('bds-visualizer-frame') && src.length > 20) {
            var self = this;
            this.__sdLegacySrc = src;
            setTimeout(function () { if (!takeOverVisualizer(self, src)) orig.call(self, 'srcdoc', src); }, 0);
            return orig.call(this, 'srcdoc', BLANK);
          }
          if (this.classList.contains('bds-preview-frame') && src.length > 20) {
            takeOverPreview(this, src);
            return orig.call(this, 'srcdoc', BLANK);
          }
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    };
  }
  function sweepLegacy() {
    if (!legacyEnabled()) return;
    doc.querySelectorAll('.bds-visualizer-card iframe.bds-visualizer-frame').forEach(function (f) {
      var card = f.closest('.bds-visualizer-card');
      if (legacy.get(card)) {
        var rec = legacy.get(card);
        if (!rec.view.el.isConnected && card.parentNode) card.parentNode.insertBefore(rec.view.el, card.nextSibling);
        return;
      }
      var src = f.__sdLegacySrc || f.getAttribute('srcdoc');
      if (src && src.length > 20 && src !== BLANK) { f.setAttribute('srcdoc', src); }
    });
  }

  function scan() { var Ho = H(); if (Ho) Ho.guard('inline-scan', function () { scanOnce(); sweepLegacy(); }); }
  var pendingAt = 0;
  function schedule(ms) {
    ms = ms || 160;
    if (pending !== null) { if (Date.now() + ms >= pendingAt) return; clearTimeout(pending); }
    pendingAt = Date.now() + ms;
    pending = setTimeout(function () { pending = null; scan(); }, ms);
  }
  (function hook() { var Ho = H(); if (Ho && Ho.onClaim) Ho.onClaim(function () { schedule(16); }); })();
  function teardown() {
    doc.querySelectorAll('.sd-vis').forEach(function (n) { n.remove(); });
    doc.querySelectorAll('[data-sd-hidden="inline"],[data-sd-hidden="legacy"]').forEach(function (n) { n.removeAttribute('data-sd-hidden'); });
    states = new WeakMap(); legacy = new WeakMap();
  }

  patchSetAttribute();
  if (doc && doc.body) {
    scan();
    new root.MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var tg = records[i].target; if (tg && tg.nodeType === 3) tg = tg.parentNode;
        if (tg && tg.closest && tg.closest('[data-sd-owned],#sd-viewer')) continue;
        schedule(); return;
      }
    }).observe(doc.body, { childList: true, subtree: true, characterData: true });
  }
  if (root.addEventListener) root.addEventListener('sd-genui:config', function (e) { if (e.detail && e.detail.enabled === false) teardown(); else schedule(); });

  root.__sdGenUIInline = { version: 1, scan: scan, teardown: teardown, createView: createView, parseVisual: parseVisual };
})(window);
