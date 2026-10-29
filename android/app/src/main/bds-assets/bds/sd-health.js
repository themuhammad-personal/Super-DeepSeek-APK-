/*
 * Super DeepSeek — engine self-check (2.72.0).
 *
 * WHY: the whole engine rides on chat.deepseek.com's DOM. The page owner can
 * rename one hashed class (`_9663006`, `fbb737a4`, …) and a feature silently
 * disappears: no crash, no log the user will ever find, no report. The app has
 * no telemetry by design, so the failure has to announce itself on the device.
 *
 * WHAT: a tiny, dependency-free probe that runs a few seconds after the page
 * settles, checks the selectors and engine globals the features stand on, and
 *
 *  - logs one line to the console (visible over `adb logcat`, and in the
 *    Diagnostics report),
 *  - keeps the last runs in localStorage `sd_health_v1`,
 *  - shows a quiet, dismissible strip ONLY when the page is really broken:
 *    a core check failed, or at least MISSING_BANNER_LIMIT feature checks did,
 *  - lets the user copy the whole report (no personal data: selectors, engine
 *    module names, user agent, timings) into an issue.
 *
 * Each check lists alternative selectors ("any of"), so a partial DeepSeek
 * change does not raise a false alarm: the check passes while ANY alternative
 * still matches. Core checks describe a page that cannot be used at all;
 * feature checks describe what this app adds (code blocks, stop button, …).
 *
 * Nothing here writes to the page except the strip and its own sheet; every
 * element it creates carries `data-sd-owned` so the engine's selectors skip it.
 *
 * Kill switch: `localStorage.sd_health_off = '1'` or `__sdHealth.setEnabled(false)`.
 * Plain ES2017, no dependencies. Loaded last, so the other modules can be seen.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__sdHealth) return;

  var STORE_KEY = 'sd_health_v1';
  var STORE_MAX = 20;          // runs remembered (oldest dropped)
  var SETTLE_MS = 4000;        // after page load / module load
  var RECHECK_MS = 1500;       // retry spacing when nothing was usable yet
  var RECHECK_TRIES = 3;       // a fresh sign-in page needs a moment
  var MISSING_BANNER_LIMIT = 3; // feature checks failed before we speak up

  // ── Page contract ─────────────────────────────────────────────────────────
  // `any`: at least one of these must match. `must`: the engine needs it.
  var CHECKS = [
    { id: 'composer', core: true, label: ['message box', 'মেসেজ বক্স'],
      any: ['textarea#chat-input', 'textarea[placeholder]', 'div[contenteditable="true"]'] },
    { id: 'history', core: true, label: ['chat history', 'চ্যাট হিস্টোরি'],
      any: ['a[href*="/chat/s/"]', '[class*="history"]', '[class*="sidebar"]'] },
    { id: 'messages', core: false, label: ['message list', 'মেসেজ তালিকা'],
      any: ['.ds-message', 'div[class*="_9663006"]'] },
    { id: 'markdown', core: false, label: ['answer formatting', 'উত্তরের ফরম্যাট'],
      any: ['.ds-markdown', '[class*="markdown"]'] },
    { id: 'code-block', core: false, label: ['code blocks', 'কোড ব্লক'],
      any: ['pre code[class*="language-"]', 'pre code', '.md-code-block'] },
    { id: 'stop', core: false, label: ['stop button', 'স্টপ বাটন'],
      any: ['.ds-icon-stop-circle', '.ds-icon-stop', '[class*="stop"]'] },
    { id: 'copy', core: false, label: ['copy button', 'কপি বাটন'],
      any: ['.ds-icon-copy', '.ds-icon-regenerate', 'div[role="button"] svg'] },
    { id: 'reasoning', core: false, label: ['thinking panel', 'থিংকিং প্যানেল'],
      any: ['[class*="think"]', '[class*="reason"]'] },
  ];

  // Engine globals each native module installs. A module that failed to run on
  // a changed page leaves its global missing — the cheapest possible detector.
  var MODULES = [
    ['sd-native.js', '__sdNativeApi'],
    ['sd-agent.js', '__sdAgent'],
    ['sd-run.js', '__sdRun'],
    ['sd-genui.js', '__sdGenui'],
    ['sd-genui-viewer.js', '__sdGenuiViewer'],
    ['sd-files.js', '__sdFiles'],
  ];

  function has(selector) {
    try { return !!document.querySelector(selector); } catch (_) { return false; }
  }

  function globals(names) {
    var missing = [];
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      var ok = false;
      try { ok = !!window[n]; } catch (_) { ok = false; }
      if (!ok) missing.push(n);
    }
    return missing;
  }

  function isBn() {
    try {
      var e = window.__sdEngine;
      var l = e && typeof e.locale === 'function' ? String(e.locale() || '') : '';
      return String(l || document.documentElement.lang || navigator.language || '').toLowerCase().indexOf('bn') === 0;
    } catch (_) { return false; }
  }
  function t(en, bn) { return isBn() ? bn : en; }

  function enabled() {
    try { return localStorage.getItem('sd_health_off') !== '1'; } catch (_) { return true; }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (_) { return ''; }
  }

  // ── Evaluation (pure: `probe(selector)` decides, so tests can drive it) ───

  /** @returns {{ok:boolean, core:boolean, failed:Array, checks:Array, modules:Array}} */
  function evaluate(probe, moduleNames, present) {
    var checks = [];
    var failed = [];
    for (var i = 0; i < CHECKS.length; i++) {
      var c = CHECKS[i];
      var matched = null;
      for (var j = 0; j < c.any.length; j++) {
        if (probe(c.any[j])) { matched = c.any[j]; break; }
      }
      var row = { id: c.id, core: !!c.core, label: c.label, ok: !!matched, matched: matched };
      checks.push(row);
      if (!matched) failed.push(row);
    }
    var coreFailed = failed.some(function (f) { return f.core; });
    var missingModules = globals(moduleNames || []);
    // "present" lets a caller say "the page works, it is simply empty" — e.g.
    // the first message has not been sent yet, so no message list exists.
    var ok = !coreFailed && failed.length < MISSING_BANNER_LIMIT;
    if (missingModules.length) ok = false;
    return {
      ok: ok,
      core: !coreFailed,
      failed: failed,
      checks: checks,
      modules: missingModules,
      present: present !== false,
    };
  }

  function summary(state) {
    if (state.ok) return t('Engine OK', 'ইঞ্জিন ঠিক আছে');
    var parts = [];
    if (state.failed.length) parts.push(state.failed.length + '/' + state.checks.length);
    if (state.modules.length) parts.push(t('modules: ', 'মডিউল: ') + state.modules.length);
    return t('Engine degraded (', 'ইঞ্জিন দুর্বল (') + parts.join(', ') + ')';
  }

  function reportText(rep) {
    var lines = [];
    lines.push('Super DeepSeek engine health');
    lines.push('time: ' + rep.time);
    lines.push('result: ' + rep.summary);
    lines.push('url: ' + rep.url);
    lines.push('ua: ' + rep.ua);
    lines.push('');
    lines.push('page checks:');
    for (var i = 0; i < rep.checks.length; i++) {
      var c = rep.checks[i];
      lines.push('  ' + (c.ok ? 'ok   ' : 'FAIL ') + c.id + (c.core ? ' (core)' : '') +
        (c.ok ? ' via ' + c.matched : ' — ' + (c.any || []).join(' | ')));
    }
    lines.push('');
    lines.push('engine modules missing: ' + (rep.modules.length ? rep.modules.join(', ') : 'none'));
    lines.push('engine loaded: ' + rep.engineLoaded.join(', '));
    return lines.join('\n');
  }

  // ── Running ──────────────────────────────────────────────────────────────

  var state = { last: null, tries: 0, timer: null, banner: null };

  function run(opts) {
    var moduleNames = [];
    for (var i = 0; i < MODULES.length; i++) moduleNames.push(MODULES[i][1]);
    var st = evaluate(has, moduleNames);
    var engineLoaded = [];
    for (var k = 0; k < MODULES.length; k++) {
      if (globals([MODULES[k][1]]).length === 0) engineLoaded.push(MODULES[k][0]);
    }
    // Keep the selector list on the rows so the report can show what was tried.
    for (var c = 0; c < st.checks.length; c++) st.checks[c].any = CHECKS[c].any;

    var rep = {
      time: nowIso(),
      url: String(location && location.href || '').split('?')[0],
      ua: String(navigator && navigator.userAgent || ''),
      summary: summary(st),
      ok: st.ok,
      core: st.core,
      checks: st.checks,
      failed: st.failed,
      modules: st.modules,
      engineLoaded: engineLoaded,
      bridge: !!(window.AndroidBridge && typeof window.AndroidBridge.getStorage === 'function'),
    };

    state.last = rep;
    remember(rep);

    try {
      var line = '[SDS] ' + rep.summary;
      if (rep.ok) console.info(line); else console.warn(line + ' — open + → Linux & Agent → Diagnostics, or __sdHealth.copy()');
    } catch (_) {}

    if (!opts || opts.ui !== false) {
      if (enabled() && !rep.ok) showBanner(rep); else hideBanner();
    }
    return rep;
  }

  function runWhenSettled() {
    state.tries = 0;
    schedule(SETTLE_MS, true);
  }

  function schedule(ms, allowRetry) {
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      var rep = run();
      // A page that is not even usable yet (still loading the chat, or a sign-in
      // form) is retried a couple of times before the strip appears.
      if (!rep.core && allowRetry && state.tries < RECHECK_TRIES) {
        state.tries++;
        schedule(RECHECK_MS, true);
      }
    }, ms);
  }

  function remember(rep) {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) list = [];
      list.push({
        time: rep.time, ok: rep.ok, summary: rep.summary,
        failed: rep.failed.map(function (f) { return f.id; }),
        modules: rep.modules, url: rep.url,
      });
      while (list.length > STORE_MAX) list.shift();
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  function history() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  // ── UI: a quiet strip, and a sheet with the report ────────────────────────

  function dark() {
    try {
      if (document.documentElement.classList.contains('dark') || document.body.classList.contains('dark')) return true;
      var bg = getComputedStyle(document.body).backgroundColor || '';
      var m = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      if (m) return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 128;
    } catch (_) {}
    return false;
  }

  function el(tag, style, text) {
    var e = document.createElement(tag);
    e.setAttribute('data-sd-owned', 'health');
    if (style) e.setAttribute('style', style);
    if (text != null) e.textContent = text;
    return e;
  }

  function hideBanner() {
    if (state.banner && state.banner.parentNode) state.banner.parentNode.removeChild(state.banner);
    state.banner = null;
  }

  function showBanner(rep) {
    if (document.getElementById('sd-health-strip')) { return; }
    if (!document.body) return;
    var isDark = dark();
    var bg = isDark ? '#241f1c' : '#fff7ed';
    var fg = isDark ? '#f6e7d8' : '#7c2d12';
    var line = isDark ? 'rgba(255,255,255,.14)' : 'rgba(124,45,18,.18)';
    var strip = el('div',
      'position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483000;' +
      'display:flex;gap:8px;align-items:center;box-sizing:border-box;padding:10px 12px;border-radius:14px;' +
      'background:' + bg + ';color:' + fg + ';border:1px solid ' + line + ';' +
      'font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.18)');
    strip.id = 'sd-health-strip';
    strip.setAttribute('role', 'status');

    var text = el('div',
      'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap');
    text.textContent = rep.summary;

    var more = el('button',
      'flex:none;border:0;border-radius:9px;padding:6px 10px;background:' + (isDark ? '#3a322c' : '#fde3cc') +
      ';color:inherit;font:inherit;font-weight:600', t('Details', 'বিস্তারিত'));
    more.type = 'button';
    more.addEventListener('click', function (e) { e.stopPropagation(); openSheet(); });

    var close = el('button',
      'flex:none;border:0;background:transparent;color:inherit;font:16px/1 system-ui;padding:4px 6px', '×');
    close.type = 'button';
    close.setAttribute('aria-label', t('Dismiss', 'বন্ধ করুন'));
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      hideBanner();
      // Dismissed for this page load only: the next launch checks again.
    });

    strip.appendChild(text);
    strip.appendChild(more);
    strip.appendChild(close);
    document.body.appendChild(strip);
    state.banner = strip;
  }

  function openSheet() {
    if (document.getElementById('sd-health-sheet')) return;
    var isDark = dark();
    var rep = state.last || run({ ui: false });
    var bg = isDark ? '#1b1c20' : '#ffffff';
    var fg = isDark ? '#e8e8ea' : '#1b1c20';
    var soft = isDark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.07)';

    var back = el('div',
      'position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;' +
      'align-items:flex-end;justify-content:center');
    back.id = 'sd-health-sheet';
    back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });

    var card = el('div',
      'width:100%;max-width:680px;max-height:80vh;overflow:auto;box-sizing:border-box;' +
      'background:' + bg + ';color:' + fg + ';border-radius:18px 18px 0 0;padding:16px 16px 22px;' +
      'font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif');

    var title = el('div', 'font-size:15px;font-weight:700;margin-bottom:2px',
      t('Engine diagnostics', 'ইঞ্জিন ডায়াগনস্টিকস'));
    var sub = el('div', 'opacity:.7;margin-bottom:12px', rep.summary);
    card.appendChild(title);
    card.appendChild(sub);

    for (var i = 0; i < rep.checks.length; i++) {
      var c = rep.checks[i];
      var row = el('div',
        'display:flex;gap:8px;align-items:baseline;padding:7px 0;border-top:1px solid ' + soft);
      var dot = el('span', 'flex:none;font-weight:700;color:' + (c.ok ? '#16a34a' : '#dc2626'), c.ok ? '✓' : '✕');
      var body = el('div', 'flex:1;min-width:0');
      body.appendChild(el('div', 'font-weight:600', (c.label && c.label[isBn() ? 1 : 0]) || c.id));
      body.appendChild(el('div', 'opacity:.62;font-family:ui-monospace,monospace;font-size:11.5px;word-break:break-all',
        (c.any || []).join('  |  ')));
      row.appendChild(dot);
      row.appendChild(body);
      card.appendChild(row);
    }

    if (rep.modules.length) {
      card.appendChild(el('div', 'margin-top:12px;font-weight:600', t('Modules that did not load', 'যে মডিউল লোড হয়নি')));
      card.appendChild(el('div', 'font-family:ui-monospace,monospace;font-size:11.5px;opacity:.8;word-break:break-all',
        rep.modules.join(', ')));
    }

    var actions = el('div', 'display:flex;gap:8px;margin-top:16px');
    var copy = el('button',
      'flex:1;border:0;border-radius:11px;padding:11px;background:#4d6bfe;color:#fff;font:inherit;font-weight:600',
      t('Copy report', 'রিপোর্ট কপি করুন'));
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var text = reportText(state.last || rep);
      var done = function () { copy.textContent = t('Copied', 'কপি হয়েছে'); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text); done(); });
        } else { legacyCopy(text); done(); }
      } catch (_) { legacyCopy(text); done(); }
    });
    var close = el('button',
      'flex:1;border:0;border-radius:11px;padding:11px;background:' + soft + ';color:inherit;font:inherit;font-weight:600',
      t('Close', 'বন্ধ'));
    close.type = 'button';
    close.addEventListener('click', function () { back.remove(); });
    actions.appendChild(copy);
    actions.appendChild(close);
    card.appendChild(actions);

    back.appendChild(card);
    document.body.appendChild(back);
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('data-sd-owned', 'health');
      ta.setAttribute('style', 'position:fixed;left:-9999px;top:0');
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (_) {}
  }

  // ── Public surface ───────────────────────────────────────────────────────

  window.__sdHealth = {
    version: '2.72.0',
    checks: CHECKS,
    run: function (opts) { return run(opts); },
    report: function () { return state.last || run({ ui: false }); },
    text: function () { return reportText(state.last || run({ ui: false })); },
    copy: function () {
      var text = reportText(state.last || run({ ui: false }));
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
        else legacyCopy(text);
      } catch (_) { legacyCopy(text); }
      return text;
    },
    history: history,
    open: openSheet,
    setEnabled: function (on) {
      try { localStorage.setItem('sd_health_off', on ? '0' : '1'); } catch (_) {}
      if (!on) hideBanner();
    },
    evaluate: evaluate,       // tests
    _summary: summary,        // tests
    _reportText: reportText,  // tests
  };

  // Wait for the page to settle, then look. Cheap: one pass over ~15 selectors.
  if (document.readyState === 'complete') runWhenSettled();
  else window.addEventListener('load', runWhenSettled, { once: true });
  // Coming back to a long-lived page (the WebView was in the background) is
  // exactly when DeepSeek has deployed a new build under us.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.last && state.last.ok && enabled()) schedule(800, false);
  });
})();
