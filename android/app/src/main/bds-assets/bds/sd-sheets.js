/*
 * Super DeepSeek — bottom sheets that behave like real phone sheets.
 *
 * The engine's sheets (+ menu, project panel, settings, slash-command help)
 * and our own confirm sheet slide up when they open. This file adds what they
 * were missing:
 *  - drag down to dismiss: the sheet follows the finger (the backdrop fades
 *    with it) and closes past a distance or on a quick flick, otherwise it
 *    springs back. A drag only starts at the top of the sheet's content, so
 *    scrolling a long list is never hijacked.
 *  - closing slides the sheet down instead of cutting it away: taps on the
 *    close button or the backdrop, and hardware Back, run the slide first.
 *  - the settings sheet, which used to just appear, slides up as well.
 *
 * Plain ES2017, no dependencies. Loaded after sd-agent.js.
 */
(function () {
  'use strict';
  if (window.__sdSheets) return;

  var OUT_MS = 210;
  var BACK_MS = 280;
  var SLOP = 8;

  /**
   * Known sheets. `root` finds the sheet, `backdrop` its dim layer and
   * `close` the element whose click closes it.
   */
  var KINDS = [
    {
      sel: '.bds-attach-dropdown',
      backdrop: function (s) { return prevMatching(s, '.bds-attach-backdrop'); },
      close: function (s) { return s.querySelector('.bds-sheet-close') || prevMatching(s, '.bds-attach-backdrop'); },
    },
    {
      sel: '.bds-project-panel',
      backdrop: function (s) { return prevMatching(s, '.bds-attach-backdrop'); },
      close: function (s) { return s.querySelector('.bds-pp-close') || prevMatching(s, '.bds-attach-backdrop'); },
    },
    {
      sel: '#bds-drawer.bds-open',
      mobileOnly: true,
      backdrop: function () { return document.querySelector('.bds-drawer-backdrop'); },
      close: function () { return document.getElementById('bds-close') || document.querySelector('.bds-drawer-backdrop'); },
      // On a settings sub-page Back steps back inside the sheet; it only
      // slides away from the overview.
      backStaysInside: function (s) {
        var b = s.querySelector('.bds-drawer-header .bds-back-btn');
        return !!(b && b.getClientRects().length);
      },
    },
    {
      sel: '.bds-cmd-help-overlay .bds-help-modal',
      mobileOnly: true,
      backdrop: function (s) { return s.closest('.bds-cmd-help-overlay'); },
      close: function (s) { return s.querySelector('.bds-help-close,[aria-label="Close"]') || s.closest('.bds-cmd-help-overlay'); },
      backdropIsParent: true,
    },
    {
      sel: '#sd-agent-confirm .sd-card',
      backdrop: function (s) { return s.parentElement; },
      close: function (s) { return s.querySelector('button'); },
      backdropIsParent: true,
      ours: true,
    },
    {
      // The agent's activity drawer (sd-run.js).
      sel: '#sd-run-sheet .sd-run-panel',
      backdrop: function (s) { return s.parentElement; },
      close: function (s) { return s.querySelector('.sd-run-close'); },
      backdropIsParent: true,
      ours: true,
    },
  ];

  function prevMatching(el, sel) {
    for (var n = el.previousElementSibling, i = 0; n && i < 4; n = n.previousElementSibling, i++) {
      if (n.matches && n.matches(sel)) return n;
    }
    var p = el.parentElement;
    return p ? p.querySelector(':scope > ' + sel) : null;
  }

  function reducedMotion() {
    try { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
  }

  function mobile() { return (window.innerWidth || 0) < 768; }

  function shown(el) {
    if (!el || !el.isConnected || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  /** The open sheet `el` belongs to, as { el, kind }, or null. */
  function sheetOf(el) {
    if (!el || !el.closest) return null;
    for (var i = 0; i < KINDS.length; i++) {
      var k = KINDS[i];
      if (k.mobileOnly && !mobile()) continue;
      var s = el.closest(k.sel);
      if (s && shown(s)) return { el: s, kind: k };
    }
    return null;
  }

  /** Every open sheet, topmost (last in the document) first. */
  function openSheets() {
    var out = [];
    KINDS.forEach(function (k) {
      if (k.mobileOnly && !mobile()) return;
      var list = document.querySelectorAll(k.sel);
      for (var i = 0; i < list.length; i++) if (shown(list[i])) out.push({ el: list[i], kind: k });
    });
    out.sort(function (a, b) {
      var z = function (x) { return parseInt(getComputedStyle(x.el).zIndex, 10) || 0; };
      var d = z(b) - z(a);
      if (d) return d;
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
    });
    return out;
  }

  // ── Moving a sheet ─────────────────────────────────────────────────────────

  function setOffset(sheet, dy, animateMs, ease) {
    var s = sheet.el.style;
    s.transition = animateMs ? 'transform ' + animateMs + 'ms ' + ease : 'none';
    s.transform = dy ? 'translate3d(0,' + dy + 'px,0)' : '';
    s.animation = 'none';
    var b = sheet.kind.backdrop(sheet.el);
    if (b && !sheet.kind.backdropIsParent) {
      var h = Math.max(1, sheet.el.getBoundingClientRect().height);
      b.style.transition = animateMs ? 'opacity ' + animateMs + 'ms ' + ease : 'none';
      b.style.opacity = dy ? String(Math.max(0, 1 - dy / h)) : '';
    } else if (b && sheet.kind.backdropIsParent) {
      // The dim layer is the sheet's parent: fade only its colour.
      var hh = Math.max(1, sheet.el.getBoundingClientRect().height);
      b.style.transition = animateMs ? 'background-color ' + animateMs + 'ms ' + ease : 'none';
      b.style.backgroundColor = dy ? 'rgba(0,0,0,' + (0.45 * Math.max(0, 1 - dy / hh)).toFixed(3) + ')' : '';
    }
  }

  /**
   * Drops the inline offset. After a spring-back the open animation stays
   * off (clearing it would replay the slide-up); after a close it is
   * restored, so a sheet that is only hidden animates again next time.
   */
  function clearOffset(sheet, closed) {
    var s = sheet.el.style;
    s.transition = ''; s.transform = '';
    if (closed) s.animation = '';
    var b = sheet.kind.backdrop(sheet.el);
    if (b) { b.style.transition = ''; b.style.opacity = ''; b.style.backgroundColor = ''; }
  }

  var bypass = false;
  var closing = typeof WeakSet === 'function' ? new WeakSet() : null;

  /** Slides the sheet down, then runs `then` (which really closes it). */
  function slideOut(sheet, fromDy, then) {
    if (closing && closing.has(sheet.el)) return;
    if (closing) closing.add(sheet.el);
    var h = sheet.el.getBoundingClientRect().height + 24;
    var finish = function () {
      bypass = true;
      try { then(); } catch (_) {}
      bypass = false;
      // A sheet that stays in the DOM (settings is only hidden) must not
      // reopen shifted down.
      setTimeout(function () {
        if (closing) closing.delete(sheet.el);
        clearOffset(sheet, true);
      }, 60);
    };
    if (reducedMotion()) { finish(); return; }
    if (fromDy) setOffset(sheet, fromDy, 0, '');
    // Next frame, so the start position is committed before the transition.
    requestAnimationFrame(function () {
      setOffset(sheet, h, OUT_MS, 'cubic-bezier(.4,0,1,1)');
      setTimeout(finish, OUT_MS);
    });
  }

  function closeSheet(sheet, fromDy) {
    var c = sheet.kind.close(sheet.el);
    slideOut(sheet, fromDy || 0, function () {
      if (c && c.isConnected) c.click();
    });
  }

  // ── Taps on close / backdrop ───────────────────────────────────────────────

  function onClickCapture(ev) {
    if (bypass) return;
    if (suppressClickUntil && Date.now() < suppressClickUntil) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      return;
    }
    var t = ev.target;
    if (!t || !t.closest || reducedMotion()) return;
    var sheets = openSheets();
    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i];
      var c = sh.kind.close(sh.el);
      var b = sh.kind.backdrop(sh.el);
      var onClose = c && (t === c || (c.contains(t) && c !== b));
      // A tap on the dim layer itself (not on the sheet inside it).
      var onBackdrop = b && (t === b);
      // The confirm sheet's buttons carry answers; they close it themselves.
      if (sh.kind.sel === '#sd-agent-confirm .sd-card') continue;
      if (!onClose && !onBackdrop) continue;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      var target = onClose ? c : b;
      slideOut(sh, 0, function () { if (target.isConnected) target.click(); });
      return;
    }
  }

  // ── Drag to dismiss ────────────────────────────────────────────────────────

  var drag = null;
  var suppressClickUntil = 0;

  /** True when something between `t` and the sheet can still scroll up. */
  function scrolledInside(t, sheetEl) {
    for (var n = t; n && n.nodeType === 1; n = n.parentElement) {
      if (n.scrollTop > 0) {
        var oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') return true;
      }
      if (n === sheetEl) break;
    }
    return false;
  }

  function isField(t) {
    return !!(t.closest && t.closest('input[type="range"], textarea, select, [contenteditable="true"], .bds-no-sheet-drag'));
  }

  function onTouchStart(ev) {
    if (drag || !ev.touches || ev.touches.length !== 1) { drag = null; return; }
    var t = ev.target;
    var sh = sheetOf(t);
    if (!sh || isField(t)) return;
    if (closing && closing.has(sh.el)) return;
    var p = ev.touches[0];
    drag = {
      sheet: sh, x0: p.clientX, y0: p.clientY, dy: 0, active: false,
      blocked: scrolledInside(t, sh.el), samples: [{ y: p.clientY, t: Date.now() }],
    };
  }

  function onTouchMove(ev) {
    if (!drag || !ev.touches || ev.touches.length !== 1) return;
    var p = ev.touches[0];
    var dx = p.clientX - drag.x0;
    var dy = p.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      // Up, sideways, or inside content that still scrolls: not ours.
      if (drag.blocked || dy <= 0 || Math.abs(dy) < Math.abs(dx) * 1.2 || scrolledInside(ev.target, drag.sheet.el)) {
        drag = null;
        return;
      }
      drag.active = true;
      drag.y0 = p.clientY; // start from here: no jump by the slop
      dy = 0;
    }
    if (ev.cancelable) ev.preventDefault();
    drag.dy = Math.max(0, dy);
    drag.samples.push({ y: p.clientY, t: Date.now() });
    if (drag.samples.length > 12) drag.samples.shift();
    setOffset(drag.sheet, drag.dy, 0, '');
  }

  function onTouchEnd() {
    var d = drag;
    drag = null;
    if (!d || !d.active) return;
    suppressClickUntil = Date.now() + 350;
    // Speed over the last ~120 ms of the gesture.
    var last = d.samples[d.samples.length - 1];
    var first = d.samples[0];
    for (var i = d.samples.length - 2; i >= 0 && last.t - d.samples[i].t <= 120; i--) first = d.samples[i];
    var dt = Math.max(1, last.t - first.t);
    var v = (last.y - first.y) / dt; // px per ms, down is positive
    var h = d.sheet.el.getBoundingClientRect().height;
    var far = d.dy > Math.min(h * 0.3, 200);
    var flick = v > 0.5 && d.dy > 24;
    if (far || flick) {
      closeSheet(d.sheet, d.dy);
    } else {
      setOffset(d.sheet, 0, BACK_MS, 'cubic-bezier(.2,.9,.3,1)');
      setTimeout(function () { if (!drag) clearOffset(d.sheet); }, BACK_MS + 20);
    }
  }

  // ── Back ───────────────────────────────────────────────────────────────────

  function wrapBack() {
    var inner = window.__sdHandleBack;
    if (typeof inner !== 'function' || inner.__sdSheets) return;
    var wrapped = function () {
      try {
        var top = openSheets()[0];
        // Our own sheets (the agent's "Allow?" / "Continue?" sheet, the
        // activity drawer): the engine knows nothing about them, so Back only
        // closes them (it presses the first button / close) and never leaves
        // the chat behind them.
        if (top && top.kind.ours) {
          closeSheet(top, 0);
          return true;
        }
        if (!reducedMotion()) {
          var dd = document.querySelector('.bds-cmd-dropdown');
          if (top && !(dd && shown(dd)) && !(top.kind.backStaysInside && top.kind.backStaysInside(top.el))) {
            slideOut(top, 0, function () { inner(); });
            return true;
          }
        }
      } catch (_) {}
      return inner();
    };
    wrapped.__sdSheets = true;
    window.__sdHandleBack = wrapped;
  }

  // ── Opening ────────────────────────────────────────────────────────────────

  var CSS = [
    '@keyframes sd-sheet-rise{from{transform:translate3d(0,100%,0)}to{transform:none}}',
    '@keyframes sd-sheet-fade{from{opacity:0}to{opacity:1}}',
    '@media (max-width:767px){#bds-drawer.bds-open.sd-sheet-in{animation:sd-sheet-rise .32s cubic-bezier(.16,1,.3,1)}}',
    '#sd-agent-confirm{animation:sd-sheet-fade .2s ease}',
    '#sd-agent-confirm .sd-card{animation:sd-sheet-rise .3s cubic-bezier(.16,1,.3,1)}',
    // A visible grab handle on our confirm sheet, like the engine's sheets.
    '#sd-agent-confirm .sd-card::before{content:"";display:block;width:40px;height:4px;border-radius:999px;',
    'background:var(--bds-border-hover,rgba(255,255,255,.22));margin:-6px auto 12px}',
    '@media (prefers-reduced-motion:reduce){#bds-drawer.sd-sheet-in,#sd-agent-confirm,#sd-agent-confirm .sd-card{animation:none!important}}',
  ].join('\n');

  function installCss() {
    if (document.getElementById('sd-sheets-css')) return;
    var st = document.createElement('style');
    st.id = 'sd-sheets-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /** The settings sheet is shown by a class switch: replay the rise each time. */
  function watchDrawer() {
    if (typeof MutationObserver !== 'function') return;
    var wasOpen = false;
    var check = function () {
      var d = document.getElementById('bds-drawer');
      var open = !!(d && d.classList.contains('bds-open'));
      if (open && !wasOpen && d) {
        d.classList.remove('sd-sheet-in');
        void d.offsetWidth; // restart the animation
        d.classList.add('sd-sheet-in');
      }
      wasOpen = open;
    };
    new MutationObserver(check).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
    check();
  }

  function install() {
    installCss();
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
    wrapBack();
    // content.js defines __sdHandleBack in its tail; wrap it once it exists.
    var tries = 0;
    var t = setInterval(function () {
      wrapBack();
      if ((window.__sdHandleBack && window.__sdHandleBack.__sdSheets) || ++tries > 40) clearInterval(t);
    }, 250);
    if (document.body) watchDrawer();
    else document.addEventListener('DOMContentLoaded', watchDrawer);
  }

  install();

  window.__sdSheets = {
    version: 1,
    // Exposed for tests.
    _sheetOf: sheetOf,
    _openSheets: openSheets,
  };
})();
