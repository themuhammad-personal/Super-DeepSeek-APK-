/*
 * Super DeepSeek — agent glue for the built-in Linux sandbox (loaded after
 * sd-native.js).
 *
 * The sandbox is exposed to the engine as an MCP server named "sandbox"
 * (url sandbox://linux) that the native side implements. The engine then
 * does the agent loop by itself: the model writes
 *   <SDS:AUTO:MCP url="sandbox" tool="run">{"command":"…"}</SDS:AUTO:MCP>
 * the engine calls the tool and sends the result back as the next message.
 *
 * This file adds what the loop needs on a phone:
 *  - __sdSandboxServers()   the server entry, when the sandbox is available.
 *  - exact arguments        the engine reads tool calls from the rendered
 *    chat, where Markdown eats backslashes, underscores and asterisks — fatal
 *    for code. Before a sandbox call runs, the raw text of the reply is taken
 *    from the chat history API and the call's arguments are re-read from it.
 *  - Stop                   a chip that is visible while the agent works;
 *    it kills every sandbox process and stops the loop until the user
 *    writes again.
 *  - "ask" mode             optional confirmation before each command.
 *
 * Plain ES2017, no dependencies.
 */
(function () {
  'use strict';
  if (window.__sdAgent && window.__sdAgent.version) return;

  var SERVER = { name: 'sandbox', serverUrl: 'sandbox://linux', enabled: true, apiKey: '' };
  var IDLE_MS = 10000;
  var HISTORY_TIMEOUT_MS = 5000;
  // Ask mode must fail closed if the page cannot show its approval UI.
  var CONFIRMATION_UNAVAILABLE = {};

  function bridge() { return window.AndroidBridge || null; }

  /** The app's language: the engine's own setting first, then the page / phone. */
  function isBn() {
    try {
      var e = window.__sdEngine;
      var l = e && typeof e.locale === 'function' ? String(e.locale() || '') : '';
      return String(l || document.documentElement.lang || navigator.language || '').toLowerCase().indexOf('bn') === 0;
    } catch (_) { return false; }
  }

  function t(en, bn) { return isBn() ? bn : en; }

  function toast(message) {
    try {
      var e = window.__sdEngine;
      if (e && typeof e.toast === 'function') { e.toast(message); return; }
    } catch (_) {}
    console.info('[SD]', message);
  }

  /** "sandbox", "sandbox://linux" or a Markdown link to either. */
  function isSandboxUrl(u) {
    var s = String(u || '').trim();
    var m = s.match(/^\[[^\]]*\]\(([^)]+)\)$/);
    if (m) s = m[1];
    s = s.toLowerCase();
    return s === 'sandbox' || s.indexOf('sandbox:') === 0;
  }

  // ── Availability ───────────────────────────────────────────────────────────

  var infoCache = null;
  var infoAt = 0;

  function info() {
    if (infoCache && Date.now() - infoAt < 5000) return infoCache;
    var v = {};
    try {
      var b = bridge();
      v = JSON.parse(b && typeof b.sandboxInfo === 'function' ? b.sandboxInfo() : '{}') || {};
    } catch (_) { v = {}; }
    infoCache = v;
    infoAt = Date.now();
    return v;
  }

  function sandboxServers() {
    var i = info();
    return i.supported && i.enabled !== false ? [Object.assign({}, SERVER)] : [];
  }

  function mode() {
    var i = info();
    return i.mode === 'ask' ? 'ask' : 'auto';
  }

  // ── Exact arguments from the raw reply ─────────────────────────────────────

  function parseAttrs(raw) {
    var a = {};
    var re = /([A-Za-z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    var m;
    while ((m = re.exec(raw))) a[m[1]] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
    return a;
  }

  /** Every <SDS:AUTO:MCP …>body</SDS:AUTO:MCP> (or self-closing) tag, in order. */
  function parseTags(text) {
    var out = [];
    var s = String(text || '');
    var re = /<[BS]DS:(?:AUTO:)?MCP\b/gi;
    var m;
    while ((m = re.exec(s))) {
      var i = m.index + m[0].length;
      var q = null;
      for (; i < s.length; i++) {
        var c = s[i];
        if (q) { if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      if (i >= s.length) break;
      var attrsRaw = s.slice(m.index + m[0].length, i);
      var selfClosing = /\/\s*$/.test(attrsRaw);
      if (selfClosing) attrsRaw = attrsRaw.replace(/\/\s*$/, '');
      var body = '';
      var end = i + 1;
      if (!selfClosing) {
        var close = /<\/[BS]DS:(?:AUTO:)?MCP\s*>/gi;
        close.lastIndex = i + 1;
        var cm = close.exec(s);
        if (cm) { body = s.slice(i + 1, cm.index); end = cm.index + cm[0].length; }
      }
      out.push({ attrs: parseAttrs(attrsRaw), body: body });
      re.lastIndex = end;
    }
    return out;
  }

  function b64urlDecode(v) {
    var s = String(v || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    if (!s) return null;
    s += '='.repeat((4 - s.length % 4) % 4);
    try {
      var bin = atob(s);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (_) { return null; }
  }

  function parseJsonObject(text) {
    var s = String(text || '').trim();
    if (!s) return null;
    // Tolerate a ```json fence around the body.
    var f = s.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
    if (f) s = f[1].trim();
    try {
      var v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (_) { return null; }
  }

  function tagArgs(tag) {
    var a = tag.attrs || {};
    var b64 = a.base64Args || a.base64args;
    if (b64) {
      var dec = parseJsonObject(b64urlDecode(b64));
      if (dec) return dec;
    }
    if (a.args) {
      var v = parseJsonObject(a.args);
      if (v) return v;
    }
    return parseJsonObject(tag.body);
  }

  /** How well raw args match the (possibly mangled) args the engine read. */
  function similarity(raw, seen) {
    if (!seen || typeof seen !== 'object') return 0;
    var score = 0;
    Object.keys(raw).forEach(function (k) {
      if (!(k in seen)) return;
      score += 1;
      if (JSON.stringify(raw[k]) === JSON.stringify(seen[k])) score += 2;
    });
    return score;
  }

  /** The raw args for (toolName, seenArgs) from the reply texts, newest first. */
  function pickRawArgs(texts, toolName, seenArgs) {
    for (var ti = 0; ti < texts.length; ti++) {
      var best = null;
      var bestScore = -1;
      parseTags(texts[ti]).forEach(function (tag) {
        var a = tag.attrs || {};
        if (String(a.tool || a.toolName || '') !== toolName) return;
        if (!isSandboxUrl(a.url || a.serverUrl || '')) return;
        var args = tagArgs(tag);
        if (!args) return;
        var s = similarity(args, seenArgs);
        if (s > bestScore) { best = args; bestScore = s; }
      });
      if (best) return best;
    }
    return null;
  }

  function messageText(m) {
    if (!m || typeof m !== 'object') return '';
    if (Array.isArray(m.fragments) && m.fragments.length) {
      return m.fragments
        .filter(function (f) { return f && typeof f.content === 'string' && !/THINK/i.test(String(f.type || '')); })
        .map(function (f) { return f.content; })
        .join('\n');
    }
    return typeof m.content === 'string' ? m.content : '';
  }

  /** Raw texts of the last few assistant replies, newest first. */
  function assistantTexts(messages, limit) {
    var out = [];
    for (var i = messages.length - 1; i >= 0 && out.length < (limit || 3); i--) {
      var m = messages[i];
      if (String((m && m.role) || '').toUpperCase() !== 'ASSISTANT') continue;
      var text = messageText(m);
      if (text) out.push(text);
    }
    return out;
  }

  function sessionId() {
    var m = String(location.href || '').match(/\/chat\/s\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  /** Chat history through the engine's own hook (it adds the auth header). */
  function requestHistory(sid) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = null;
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('bds:history-msgs', on);
        resolve(v);
      }
      function on(ev) {
        var d = ev && ev.detail;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { return; } }
        var bd = d && d.data && d.data.biz_data;
        if (!bd || !bd.chat_session || bd.chat_session.id !== sid) return;
        finish(Array.isArray(bd.chat_messages) ? bd.chat_messages : null);
      }
      timer = setTimeout(function () { finish(null); }, HISTORY_TIMEOUT_MS);
      window.addEventListener('bds:history-msgs', on);
      try {
        window.dispatchEvent(new CustomEvent('bds:request-history-msgs', { detail: JSON.stringify({ sessionId: sid }) }));
      } catch (_) { finish(null); }
    });
  }

  function exactArgs(payload) {
    var sid = sessionId();
    if (!sid) return Promise.resolve(payload);
    return requestHistory(sid).then(function (messages) {
      if (!messages) return payload;
      var raw = pickRawArgs(assistantTexts(messages, 3), String(payload.toolName || ''), payload.args);
      return raw ? Object.assign({}, payload, { args: raw }) : payload;
    }, function () { return payload; });
  }

  // ── Agent activity, Stop ───────────────────────────────────────────────────

  var state = { pending: 0, active: false, lastActivity: 0, label: '' };
  window.__sdAgentStopped = false;

  function describe(p) {
    var a = (p && p.args) || {};
    var first = function (s) { return String(s || '').split('\n')[0].slice(0, 70); };
    switch (p && p.toolName) {
      case 'run': return (a.background ? '⏵ ' : '$ ') + first(a.command);
      case 'write_file': return t('Writing ', 'লিখছে ') + first(a.path);
      case 'edit_file': return t('Editing ', 'এডিট করছে ') + first(a.path);
      case 'read_file': return t('Reading ', 'পড়ছে ') + first(a.path);
      case 'list_dir': return t('Listing ', 'দেখছে ') + first(a.path || '~/workspace');
      case 'install_packages': return t('Installing ', 'ইনস্টল করছে ') + [].concat(a.packages || []).join(' ').slice(0, 60);
      case 'preview': return t('Opening preview', 'প্রিভিউ খুলছে');
      default: return t('Working…', 'কাজ করছে…');
    }
  }

  function generating() {
    try {
      var e = window.__sdEngine;
      if (e && typeof e.isGenerating === 'function') return !!e.isGenerating();
    } catch (_) {}
    return !!document.querySelector('.ds-icon-stop-circle, .ds-icon-stop');
  }

  var pollTimer = null;

  function ensurePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (generating()) state.lastActivity = Date.now();
      if (state.active && state.pending === 0 && Date.now() - state.lastActivity > IDLE_MS) {
        state.active = false;
        render();
      }
      if (!state.active) { clearInterval(pollTimer); pollTimer = null; }
    }, 1000);
  }

  function beginCall(payload) {
    // Nudges are counted per instruction of the user, not per tool call: a
    // model that answers a nudge by redoing work must not earn new nudges.
    flow.calls++;
    state.pending++;
    state.active = true;
    state.lastActivity = Date.now();
    state.label = describe(payload);
    render();
    ensurePoll();
  }

  function endCall() {
    state.pending = Math.max(0, state.pending - 1);
    state.lastActivity = Date.now();
    render();
  }

  function clickOfficialStop() {
    var icon = document.querySelector('.ds-icon-stop-circle, .ds-icon-stop');
    if (!icon) return;
    var btn = icon.closest('[role="button"], button') || icon;
    try { btn.click(); } catch (_) {}
  }

  function stopAgent(silent) {
    window.__sdAgentStopped = true;
    try { var b = bridge(); if (b && typeof b.sandboxStop === 'function') b.sandboxStop(); } catch (_) {}
    clickOfficialStop();
    state.active = false;
    state.pending = 0;
    render();
    if (!silent) toast(t('Agent stopped. Write a message to continue.', 'এজেন্ট থামানো হয়েছে। চালিয়ে যেতে একটি মেসেজ লিখুন।'));
  }

  function resume() {
    flow.nudges = 0;
    flow.base = flow.calls;
    cap.n = 0;
    cap.next = STEP_CAP;
    if (window.__sdAgentStopped) window.__sdAgentStopped = false;
  }

  function isComposer(el) {
    return !!(el && el.closest && el.closest('textarea, [contenteditable="true"], [role="textbox"]') &&
      !el.closest('#bds-root, #sd-agent-chip, #sd-agent-confirm'));
  }

  function installResumeListeners() {
    // Only the user's own typing or tapping re-arms the loop; the engine's
    // automatic messages dispatch untrusted events.
    document.addEventListener('input', function (ev) { if (ev.isTrusted && isComposer(ev.target)) resume(); }, true);
    document.addEventListener('keydown', function (ev) {
      if (!ev.isTrusted || ev.key !== 'Enter' || !isComposer(ev.target)) return;
      resume();
      if (!ev.shiftKey) userSent();
    }, true);
    document.addEventListener('click', function (ev) {
      if (!ev.isTrusted || !ev.target || !ev.target.closest) return;
      var btn = ev.target.closest('[role="button"], button');
      if (!btn || !btn.querySelector) return;
      if (btn.querySelector('.ds-icon-send')) { resume(); userSent(); }
      // The user stopped a reply by hand: no automatic "continue" after it.
      else if (btn.querySelector('.ds-icon-stop-circle, .ds-icon-stop')) flow.nudges = MAX_NUDGES;
    }, true);
  }

  // ── Scroll: the reader's position wins ───────────────────────────────────
  //
  // DeepSeek jumps to the bottom of the chat whenever a message is sent,
  // including the agent's automatic ones, so a user reading further up was
  // pulled down again and again. Once the user has scrolled away from the
  // bottom, a jump that no touch, wheel, click or key of the user caused is
  // undone. The user's own actions (sending, the scroll-down arrow, flinging
  // down) always go through, and following the reply resumes as soon as the
  // user is back at the bottom.

  var USER_WINDOW_MS = 1200;
  var MOMENTUM_GAP_MS = 150;
  var NEAR_BOTTOM_PX = 96;
  var guard = { touching: false, moved: false, dragged: false, lastInput: 0, states: null, fix: null, epoch: 0 };

  /** The user sent a message: they want to follow the reply, wherever they were. */
  function userSent() { guard.epoch++; }

  function guardScroller(ev) {
    var tg = ev && ev.target;
    if (!tg || tg === document || tg === window) return document.scrollingElement || document.documentElement || null;
    return tg.nodeType === 1 ? tg : null;
  }

  function guardSkips(el) {
    if (!el || !el.closest || el.clientHeight < 160) return true;
    return !!el.closest('#bds-root, #bds-drawer, .bds-attach-dropdown, .bds-project-panel, #sd-agent-confirm, ' +
      '#sd-agent-chip, textarea, [contenteditable="true"], pre, [role="dialog"]');
  }

  function guardUserActive() {
    var idle = Date.now() - guard.lastInput;
    if (guard.touching && idle > 8000) guard.touching = false;   // a lost touchend
    return guard.touching || idle < USER_WINDOW_MS;
  }

  function onGuardScroll(ev) {
    var el = guardScroller(ev);
    if (!guard.states || guardSkips(el)) return;
    var now = Date.now();
    var top = el.scrollTop;
    var nearBottom = el.scrollHeight - el.clientHeight - top <= NEAR_BOTTOM_PX;
    var st = guard.states.get(el);
    // A new chat starts at its own bottom: nothing carries over.
    if (!st || st.url !== location.href || st.epoch !== guard.epoch) {
      st = { url: location.href, epoch: guard.epoch, away: false, top: top, last: 0, user: false };
      guard.states.set(el, st);
    }
    var gap = now - st.last;
    st.last = now;
    if (guard.fix && guard.fix.el === el) {
      var ours = Math.abs(top - guard.fix.top) < 2;
      guard.fix = null;
      if (ours) return;
    }
    // Touch, wheel, click or key of the user, and the fling that follows it.
    // A drag or a fling moves the view a little per frame: one big jump down
    // during or right after it is still somebody else's.
    var byUser = guardUserActive() || (st.user && gap < MOMENTUM_GAP_MS);
    if (byUser && (guard.touching || guard.dragged) && top - st.top > el.clientHeight * 0.75) byUser = false;
    if (byUser) {
      st.user = true;
      st.away = !nearBottom;
      st.top = top;
      return;
    }
    st.user = false;
    if (!st.away) { st.top = top; return; }
    var jump = top - st.top;
    if (jump > 0 && (nearBottom || jump > el.clientHeight * 0.6)) {
      guard.fix = { el: el, top: st.top };
      el.scrollTop = st.top;
      return;
    }
    // Small moves (content above changing size) and moves up are kept; the
    // frames of one animated jump are measured from where it started.
    if (jump < 0 || gap >= MOMENTUM_GAP_MS) st.top = top;
  }

  function touchY(ev) {
    var t = ev && ev.touches && ev.touches[0];
    return t && typeof t.clientY === 'number' ? t.clientY : 0;
  }

  function installScrollGuard() {
    if (typeof WeakMap !== 'function' || guard.states) return;
    guard.states = new WeakMap();
    var mark = function (ev) {
      if (!ev.isTrusted) return;
      if (ev.type === 'wheel') guard.dragged = true;
      else if (ev.type === 'keydown' || ((ev.type === 'mousedown' || ev.type === 'pointerdown') && !guard.touching)) guard.dragged = false;
      // Typing a character is not a scroll of the user; Enter, arrows and pages are.
      if (ev.type === 'keydown' && typeof ev.key === 'string' && ev.key.length === 1) return;
      guard.lastInput = Date.now();
    };
    document.addEventListener('touchstart', function (ev) {
      if (!ev.isTrusted) return;
      guard.touching = true;
      guard.moved = false;
      guard.dragged = false;
      guard.startY = touchY(ev);
      guard.lastInput = Date.now();
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', function (ev) {
      if (!ev.isTrusted || guard.moved) return;
      // Beyond the touch slop: a drag, not a shaky tap.
      if (Math.abs(touchY(ev) - guard.startY) > 10) guard.moved = guard.dragged = true;
    }, { capture: true, passive: true });
    var release = function (ev) {
      if (!ev.isTrusted) return;
      guard.touching = !!(ev.touches && ev.touches.length);
      // A tap (the scroll-down arrow, a link) may jump anywhere; a drag may not.
      guard.dragged = guard.moved;
      guard.lastInput = Date.now();
    };
    document.addEventListener('touchend', release, { capture: true, passive: true });
    document.addEventListener('touchcancel', release, { capture: true, passive: true });
    ['touchmove', 'wheel', 'pointerdown', 'mousedown', 'keydown'].forEach(function (type) {
      document.addEventListener(type, mark, { capture: true, passive: true });
    });
    document.addEventListener('scroll', onGuardScroll, { capture: true, passive: true });
  }

  // ── Continuity: never leave a task half done ──────────────────────────────
  //
  // 1. The engine looks at a reply's tool calls only when the DOM of that reply
  //    changes. When the last change lands while the stop button is still
  //    showing, the calls were never run and the agent just stood still. After
  //    every reply the engine is asked to look again (idempotent: each call is
  //    handled once per message).
  // 2. In the middle of a tool chain, a reply that ends without a tool call but
  //    announces more work ("Now I'll run the tests:") or carries a tool tag the
  //    engine could not read, gets one quiet, invisible nudge to continue.

  var flow = { calls: 0, base: 0, nudges: 0, was: false, timers: [] };
  var MAX_NUDGES = 2;
  var REPROCESS_AT = [700, 2900, 5200];
  var NUDGE_AT = 6200;

  function reprocess() {
    try { var e = window.__sdEngine; if (e && typeof e.reprocess === 'function') e.reprocess(); } catch (_) {}
  }

  /** Last line of the prose, without code blocks. */
  function tailLine(text) {
    var s = String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/<[BS]DS:[\s\S]*$/i, ' ');
    var lines = s.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    return lines.length ? lines[lines.length - 1].slice(-300) : '';
  }

  // Closings and success lines: the reply is a finished answer. Missing a
  // stalled reply costs one "continue" from the user; nudging a finished one
  // makes the model redo the work, so every doubt means "finished".
  var CLOSING = /\b(let me know|feel free|if you(?:'d| would)? (?:like|need|want|have)|hope (?:this|that|it) helps|happy coding|enjoy|anything else|all set|you can now|summary)\b/i;
  var CLOSING_BN = /(জানাবেন|জানান|বলবেন|বলুন|আশা করি|প্রয়োজনে|দরকার হলে|সম্পন্ন|শেষ হয়েছে|তৈরি হয়েছে|সারসংক্ষেপ)/;
  var DONE = /(✅|✔|🎉|\b(?:done|finished|complete|completed|succeeded|successfully|all tests pass(?:ed)?)\b)/i;

  /** The reply (before any tool tag) ends with a code block. */
  function endsWithBlock(text) {
    var s = String(text || '').replace(/<[BS]DS:[\s\S]*$/i, '').trim();
    return /```\s*$/.test(s);
  }

  /** The reply announces more work instead of finishing or asking. */
  function looksUnfinished(text) {
    if (endsWithBlock(text)) return false;
    var l = tailLine(text).replace(/[*_`~]+/g, '').trim();
    if (!l || /[?？]\s*$/.test(l)) return false;
    if (CLOSING.test(l) || CLOSING_BN.test(l) || DONE.test(l)) return false;
    if (/(:|：|…|\.\.\.)\s*$/.test(l)) return true;
    if (/\b(let me|let's|i'll|i will|i am going to|i'm going to|now i|next,? i|going to)\b/i.test(l)) return true;
    return /(করছি|করব|করবো|করা যাক|দেখি|দেখা যাক|দেখছি|চালাচ্ছি|চালাই|লিখছি|শুরু করছি|ঠিক করছি)\s*[।.:…!]*\s*$/.test(l);
  }

  function isToolResultMessage(m) {
    var text = messageText(m);
    return /\[[BS]DS:AUTO_MCP_(RESULT|ERROR)\]|\[[BS]DS:AUTO\] Agent continue/.test(text);
  }

  /** What to tell the model, or null when the reply is fine as it is. */
  function nudgeFor(messages) {
    if (!messages || messages.length < 2) return null;
    var last = messages[messages.length - 1];
    if (String((last && last.role) || '').toUpperCase() !== 'ASSISTANT') return null;
    var prev = null;
    for (var i = messages.length - 2; i >= 0; i--) {
      if (String((messages[i] && messages[i].role) || '').toUpperCase() === 'USER') { prev = messages[i]; break; }
    }
    if (!prev || !isToolResultMessage(prev)) return null;
    var text = messageText(last);
    var tags = parseTags(text).filter(function (tag) {
      var a = tag.attrs || {};
      return isSandboxUrl(a.url || a.serverUrl || '');
    });
    if (tags.length) {
      var bad = tags.filter(function (tag) { return !tagArgs(tag); });
      if (!bad.length) return null;
      return 'Your last tool call could not be read: its arguments must be one valid JSON object. ' +
        'Send the tool call again with valid JSON (escape quotes and newlines inside strings, or use base64Args).';
    }
    if (!looksUnfinished(text)) return null;
    return 'Your last reply ended without a tool call. If steps of the task remain, continue now with the next tool call. ' +
      'If the task is complete, reply with one short line saying so and no tool call. Never repeat work that is already done.';
  }

  function sendNudge(body) {
    var e = window.__sdEngine;
    if (!e || typeof e.sendQuiet !== 'function') return;
    flow.nudges++;
    e.sendQuiet(['<SuperDeepSeek>', '[SDS:AUTO] Agent continue', body, '</SuperDeepSeek>'].join('\n'), 'Agent continue');
  }

  function maybeNudge(callsAtEnd) {
    if (flow.calls !== callsAtEnd || flow.nudges >= MAX_NUDGES || window.__sdAgentStopped || !autoContinue()) return;
    // Only inside a task the agent works on for the current instruction.
    if (flow.calls === flow.base) return;
    if (state.pending || mcpPending || generating() || !sandboxServers().length) return;
    var sid = sessionId();
    if (!sid) return;
    requestHistory(sid).then(function (messages) {
      if (flow.calls !== callsAtEnd || window.__sdAgentStopped || state.pending || mcpPending || generating()) return;
      var body = nudgeFor(messages);
      if (body) sendNudge(body);
    });
  }

  function onReplyEnd() {
    var callsAtEnd = flow.calls;
    REPROCESS_AT.forEach(function (ms) { flow.timers.push(setTimeout(reprocess, ms)); });
    flow.timers.push(setTimeout(function () { maybeNudge(callsAtEnd); }, NUDGE_AT));
  }

  function watchReplies() {
    setInterval(function () {
      syncLocale();
      var g = generating();
      if (g && flow.timers.length) { flow.timers.forEach(clearTimeout); flow.timers = []; }
      if (flow.was && !g) onReplyEnd();
      flow.was = g;
    }, 500);
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  var STYLE = [
    '#sd-agent-chip{position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 58px);',
    'z-index:2147483000;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);box-sizing:border-box;',
    'padding:6px 6px 6px 12px;border-radius:999px;background:rgba(28,28,32,.94);color:#f1f1f3;',
    'font:500 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.28);',
    '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08)}',
    '#sd-agent-chip[hidden]{display:none}',
    '#sd-agent-chip .sd-spin{flex:none;width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.25);',
    'border-top-color:#8ab4ff;animation:sd-spin .9s linear infinite}',
    '#sd-agent-chip .sd-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-size:12px;opacity:.92}',
    '#sd-agent-chip button{flex:none;display:flex;align-items:center;gap:6px;border:0;border-radius:999px;',
    'padding:7px 12px;background:rgba(255,255,255,.12);color:#fff;font:600 12px/1 system-ui,sans-serif}',
    '#sd-agent-chip button:active{background:rgba(255,255,255,.2)}',
    '#sd-agent-chip button i{width:9px;height:9px;border-radius:2px;background:#ff6b6b;display:block}',
    '@keyframes sd-spin{to{transform:rotate(360deg)}}',
    '#sd-agent-confirm{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-end;justify-content:center;',
    'background:rgba(0,0,0,.45)}',
    '#sd-agent-confirm .sd-card{width:100%;max-width:560px;box-sizing:border-box;margin:0 8px calc(env(safe-area-inset-bottom,0px) + 8px);',
    'padding:16px;border-radius:18px;background:var(--bds-bg-panel,#1e1f23);color:var(--bds-text-primary,#ececec);',
    'border:1px solid var(--bds-border,#3a3b3f);box-shadow:var(--bds-shadow,0 12px 40px rgba(0,0,0,.4));',
    'font:14px/1.4 system-ui,sans-serif}',
    '#sd-agent-confirm h3{margin:0 0 8px;font-size:15px;font-weight:600}',
    '#sd-agent-confirm pre{margin:0 0 14px;max-height:40vh;overflow:auto;padding:10px;border-radius:10px;',
    'background:var(--bds-bg-elevated,#2a2b30);color:var(--bds-text-primary,#ececec);',
    'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}',
    '#sd-agent-confirm .sd-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
    '#sd-agent-confirm button{border:0;border-radius:12px;padding:10px 14px;font:600 13px/1 system-ui,sans-serif;',
    'background:var(--bds-bg-hover,rgba(255,255,255,.08));color:var(--bds-text-primary,#ececec)}',
    '#sd-agent-confirm button.sd-primary{background:#4d6bfe;color:#fff}',
    // Tool cards in the chat: the spinner stops once the call is over.
    '.bds-mcp-loading.sd-done,.bds-mcp-loading.sd-stopped{animation:none!important}',
    '.bds-mcp-loading.sd-done{border-left-color:#22c55e!important}',
    '.bds-mcp-loading.sd-stopped{border-left-color:#8e8ea0!important}',
    '.sd-done .bds-mcp-loading-spinner,.sd-stopped .bds-mcp-loading-spinner{animation:none!important;',
    'border-color:transparent!important;position:relative}',
    '.sd-done .bds-mcp-loading-spinner::after{content:"";position:absolute;left:5px;top:1px;width:5px;height:10px;',
    'border:solid #22c55e;border-width:0 2px 2px 0;transform:rotate(45deg)}',
    '.sd-stopped .bds-mcp-loading-spinner::after{content:"";position:absolute;left:3px;top:3px;width:10px;height:10px;',
    'border-radius:2px;background:#8e8ea0}'
  ].join('');

  var chip = null;

  function ensureChip() {
    if (chip && document.body && document.body.contains(chip)) return chip;
    if (!document.body) return null;
    if (!document.getElementById('sd-agent-style')) {
      var st = document.createElement('style');
      st.id = 'sd-agent-style';
      st.textContent = STYLE;
      (document.head || document.documentElement).appendChild(st);
    }
    chip = document.createElement('div');
    chip.id = 'sd-agent-chip';
    chip.setAttribute('role', 'status');
    chip.hidden = true;
    var spin = document.createElement('span');
    spin.className = 'sd-spin';
    var label = document.createElement('span');
    label.className = 'sd-label';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.appendChild(document.createElement('i'));
    btn.appendChild(document.createTextNode(t('Stop', 'থামান')));
    btn.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); stopAgent(false); });
    label.addEventListener('click', function () {
      try { var b = bridge(); if (b && typeof b.openStudio === 'function') b.openStudio(); } catch (_) {}
    });
    chip.appendChild(spin);
    chip.appendChild(label);
    chip.appendChild(btn);
    document.body.appendChild(chip);
    return chip;
  }

  var reportedActive = false;

  /** Tells the app while the agent works, so it stays protected in the background. */
  function reportActive() {
    if (reportedActive === state.active) return;
    reportedActive = state.active;
    try { var b = bridge(); if (b && typeof b.sandboxAgentActive === 'function') b.sandboxAgentActive(!!state.active); } catch (_) {}
  }

  function render() {
    reportActive();
    var c = ensureChip();
    if (!c) return;
    c.hidden = !state.active;
    var label = c.querySelector('.sd-label');
    if (label) label.textContent = state.pending > 0 ? state.label : t('Agent is working…', 'এজেন্ট কাজ করছে…');
  }

  function confirmCall(payload) {
    return new Promise(function (resolve) {
      if (!document.body) return resolve(CONFIRMATION_UNAVAILABLE);
      ensureChip();
      var old = document.getElementById('sd-agent-confirm');
      if (old) old.remove();
      var a = payload.args || {};
      var detail = payload.toolName === 'run' ? String(a.command || '')
        : payload.toolName === 'write_file' ? (a.path + '\n\n' + String(a.content || '').slice(0, 1500))
        : JSON.stringify(a, null, 2).slice(0, 2000);
      var wrap = document.createElement('div');
      wrap.id = 'sd-agent-confirm';
      var card = document.createElement('div');
      card.className = 'sd-card';
      var h = document.createElement('h3');
      h.textContent = t('Allow in the Linux sandbox?', 'লিনাক্স স্যান্ডবক্সে চালাতে দেবেন?') + ' — ' + payload.toolName;
      var pre = document.createElement('pre');
      pre.textContent = detail;
      var row = document.createElement('div');
      row.className = 'sd-row';
      function button(text, cls, value) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        if (cls) b.className = cls;
        b.addEventListener('click', function () { wrap.remove(); resolve(value); });
        row.appendChild(b);
      }
      button(t('Skip', 'বাদ দিন'), '', 'skip');
      button(t('Always allow', 'সবসময় অনুমতি'), '', 'always');
      button(t('Run', 'চালান'), 'sd-primary', 'run');
      card.appendChild(h);
      card.appendChild(pre);
      card.appendChild(row);
      wrap.appendChild(card);
      document.body.appendChild(wrap);
    });
  }

  // ── "Linux Studio" entry in the + sheet ────────────────────────────────────

  var STUDIO_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="bds-item-icon svelte-1y27tjy">' +
    '<rect x="2" y="4" width="20" height="16" rx="2"></rect><polyline points="6 9 10 12 6 15"></polyline>' +
    '<line x1="12" y1="15" x2="17" y2="15"></line></svg>';

  function addStudioItem() {
    var sheet = document.querySelector('.bds-attach-dropdown');
    if (!sheet || sheet.querySelector('#sd-studio-item')) return;
    var first = sheet.querySelector('.bds-attach-item');
    if (!first || !first.parentNode) return;
    if (!info().supported) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'sd-studio-item';
    btn.className = 'bds-attach-item svelte-1y27tjy';
    btn.innerHTML = '<span class="bds-item-icon-box svelte-1y27tjy">' + STUDIO_ICON + '</span> ' +
      '<span class="bds-item-content svelte-1y27tjy"><span class="bds-item-title svelte-1y27tjy"></span> ' +
      '<span class="bds-item-desc svelte-1y27tjy"></span></span>';
    btn.querySelector('.bds-item-title').textContent = 'Linux Studio';
    btn.querySelector('.bds-item-desc').textContent = t('Terminal, files and app previews of the AI sandbox',
      'AI স্যান্ডবক্সের টার্মিনাল, ফাইল ও অ্যাপ প্রিভিউ');
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var close = document.querySelector('.bds-sheet-close') || document.querySelector('.bds-attach-backdrop');
      if (close) { try { close.click(); } catch (_) {} }
      try { var b = bridge(); if (b && typeof b.openStudio === 'function') b.openStudio(); } catch (_) {}
    });
    first.parentNode.insertBefore(btn, first);
  }

  function watchSheet() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { queued = false; addStudioItem(); adoptLinuxPage(); }, 50);
    }).observe(document.body, { childList: true, subtree: true });
  }


  // ── Preferences shared with the app ────────────────────────────────────────
  //
  // The same keys the native side reads (Linux Studio's ⋮ menu shows them too),
  // so a switch flipped in either place is the one setting.

  var PREF_ENABLED = 'sd_sandbox_enabled';
  var PREF_MODE = 'sd_sandbox_mode';
  var PREF_CONTINUE = 'sd_agent_autocontinue';
  var PREF_LOCALE = 'sd_ui_locale';

  function pref(key, def) {
    try {
      var b = bridge();
      var v = b && typeof b.getStorage === 'function' ? b.getStorage(key) : null;
      return v === null || v === undefined || v === '' ? def : String(v);
    } catch (_) { return def; }
  }

  function setPref(key, value) {
    try { var b = bridge(); if (b && typeof b.setStorage === 'function') b.setStorage(key, String(value)); } catch (_) {}
    infoCache = null;
  }

  function autoContinue() { return pref(PREF_CONTINUE, '1') !== '0'; }

  var lastLocale = null;

  /** Linux Studio speaks the app's language, not only the phone's. */
  function syncLocale() {
    var e = window.__sdEngine;
    var l = e && typeof e.locale === 'function' ? String(e.locale() || '') : '';
    if (!l || l === lastLocale) return;
    lastLocale = l;
    if (pref(PREF_LOCALE, '') !== l) setPref(PREF_LOCALE, l);
  }

  // ── What the AI knows about its Linux right now ────────────────────────────

  function context() {
    try {
      var b = bridge();
      return JSON.parse(b && typeof b.sandboxContext === 'function' ? b.sandboxContext() : '{}') || {};
    } catch (_) { return {}; }
  }

  /** Lines for the tool instructions (injected.js); [] when there is no sandbox. */
  function promptContext(c) {
    c = c || context();
    if (!c.supported || c.enabled === false) return [];
    var parts = [];
    parts.push(c.installed ? 'Linux is set up and ready.'
      : 'Linux is not set up yet: the first call installs it automatically (about a minute), so do not worry about a slow first call.');
    if (c.mode === 'ask') parts.push('The user approves every call by hand, so a call can be declined; then ask them or take another way.');
    var jobs = Array.isArray(c.jobs) ? c.jobs : [];
    if (jobs.length) {
      parts.push('Running background jobs: ' + jobs.map(function (j) {
        return String(j.id) + ' `' + String(j.command || '').slice(0, 120) + '`';
      }).join('; ') + '.');
    }
    var ws = Array.isArray(c.workspace) ? c.workspace.map(String) : [];
    if (c.installed) {
      parts.push(ws.length ? '/root/workspace contains: ' + ws.join(', ') +
        (Number(c.workspaceCount) > ws.length ? ', … (' + c.workspaceCount + ' entries)' : '') + '.'
        : '/root/workspace is empty.');
    }
    if (typeof c.freeMb === 'number' && c.freeMb >= 0 && c.freeMb < 500) parts.push('Only ' + c.freeMb + ' MB of storage is free.');
    return ['Sandbox state when this message was sent: ' + parts.join(' '), RUN_RULES];
  }

  // ── Settings → "Linux & Agent" ─────────────────────────────────────────────
  //
  // Its own entry on the settings overview: content.js adds the row and an
  // empty page (sdLinuxPg → mountSettings), this fills the page in the same
  // grouped style as the overview. Before, the controls were a card pushed
  // into whatever settings page was open, between unrelated cards.
  // Switches apply at once; they are native preferences shared with Linux
  // Studio's ⋮ menu.

  var SVG_HEAD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">';
  var ICONS = {
    linux: '<rect x="2" y="4" width="20" height="16" rx="2"></rect><polyline points="6 9 10 12 6 15"></polyline>' +
      '<line x1="12" y1="15" x2="17" y2="15"></line>',
    power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line>',
    ask: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',
    loop: '<polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>',
    studio: '<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
    reset: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>' +
      '<path d="M10 11v6"></path><path d="M14 11v6"></path>',
    chev: '<polyline points="9 18 15 12 9 6"></polyline>'
  };

  var page = { el: null, timer: null, resetArmed: 0 };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function icon(name, cls) {
    var s = el('span', cls || 'bds-set-ico');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = SVG_HEAD + (ICONS[name] || '') + '</svg>';
    return s;
  }

  function section(root, title) {
    var g = el('div', 'bds-set-group');
    if (title) g.appendChild(el('div', 'bds-set-sec', title));
    var list = el('div', 'bds-set-list');
    g.appendChild(list);
    root.appendChild(g);
    return list;
  }

  /** A row like the overview's: icon, title, hint, then a switch or a chevron. */
  function row(list, o) {
    var r = el(o.onClick ? 'button' : 'div', 'bds-set-row' + (o.danger ? ' sd-danger' : ''));
    if (o.onClick) r.type = 'button';
    if (o.key) r.setAttribute('data-sd-key', o.key);
    r.appendChild(icon(o.icon));
    var tx = el('span', 'bds-set-txt');
    tx.appendChild(el('span', 'bds-set-title', o.title));
    if (o.sub) tx.appendChild(el('span', 'bds-set-sub', o.sub));
    r.appendChild(tx);
    if (typeof o.isOn === 'boolean') {
      var sw = el('span', 'bds-set-switch' + (o.isOn ? ' bds-on' : ''));
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(o.isOn));
      sw.setAttribute('aria-label', o.title);
      r.appendChild(sw);
    } else if (o.chevron) {
      r.appendChild(icon('chev', 'bds-set-chev'));
    } else if (o.dot) {
      var dot = el('span', 'sd-dot');
      dot.setAttribute('data-state', o.dot);
      r.appendChild(dot);
    }
    if (o.onClick) {
      r.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); o.onClick(r); });
    }
    list.appendChild(r);
    return r;
  }

  function statusText(i) {
    if (!i.supported) return t('Not available on this phone', 'এই ফোনে নেই');
    if (i.enabled === false) return t('Off · the AI works without Linux', 'বন্ধ · AI লিনাক্স ছাড়া কাজ করবে');
    if (i.installing) {
      return t('Setting up Linux…', 'লিনাক্স প্রস্তুত হচ্ছে…') +
        (typeof i.progress === 'number' && i.progress > 0 ? ' ' + Math.round(i.progress * 100) + '%' : '');
    }
    var bits = [t('On', 'চালু')];
    bits.push(i.installed ? ('Alpine ' + (i.version || '')).trim() : t('sets itself up on first use', 'প্রথম ব্যবহারে নিজেই প্রস্তুত হবে'));
    if (i.mode === 'ask') bits.push(t('asks before each command', 'প্রতিটি কমান্ডের আগে জিজ্ঞেস করে'));
    if (i.active > 0) bits.push(t(i.active + ' running', i.active + 'টি চলছে'));
    return bits.join(' · ');
  }

  /** The value shown on the overview row. */
  function statusShort(i) {
    i = i || info();
    if (!i.supported) return '';
    if (i.enabled === false) return t('Off', 'বন্ধ');
    if (i.active > 0 || state.active) return t('Working', 'কাজ চলছে');
    return t('On', 'চালু');
  }

  function dotState(i) {
    return !i.supported || i.enabled === false ? 'off'
      : i.installing || !i.installed ? 'wait' : (i.active > 0 || state.active) ? 'busy' : 'on';
  }

  function openStudio() {
    try { var b = bridge(); if (b && typeof b.openStudio === 'function') b.openStudio(); } catch (_) {}
  }

  /**
   * One line about the engine self-check (sd-health.js): whether the page the
   * engine rides on still looks the way it expects. Empty when the module did
   * not run (an older build, or before the first check).
   */
  function healthState() {
    try {
      var h = window.__sdHealth;
      if (!h || typeof h.report !== 'function') return { text: '', ok: null };
      var r = h.report();
      if (!r) return { text: t('not checked yet', 'এখনো যাচাই হয়নি'), ok: null };
      var text = r.ok
        ? t('All page checks pass', 'সব পেজ-চেক ঠিক আছে')
        : t((r.failed.length || 0) + ' page checks failed', (r.failed.length || 0) + 'টি পেজ-চেক ব্যর্থ');
      if (r.modules && r.modules.length) {
        text += t(' · ' + r.modules.length + ' modules missing', ' · ' + r.modules.length + 'টি মডিউল নেই');
      }
      return { text: text, ok: !!r.ok };
    } catch (_) { return { text: '', ok: null }; }
  }

  function fillPage(host, i) {
    host.textContent = '';
    var on = i.enabled !== false;
    var head = section(host, '');
    var status = row(head, { icon: 'linux', title: t('Linux on this phone', 'এই ফোনে লিনাক্স'), sub: statusText(i), dot: dotState(i) });
    status.classList.add('sd-status');

    var box = section(host, t('Sandbox', 'স্যান্ডবক্স'));
    row(box, {
      key: PREF_ENABLED, icon: 'power', isOn: on,
      title: t('Linux sandbox for the AI', 'AI-এর জন্য লিনাক্স স্যান্ডবক্স'),
      sub: t('The AI can run code, install packages and build whole projects in its own Linux on this phone.',
        'AI এই ফোনে নিজের লিনাক্সে কোড চালাতে, প্যাকেজ ইনস্টল করতে ও পুরো প্রজেক্ট বানাতে পারবে।'),
      onClick: function () { setPref(PREF_ENABLED, on ? '0' : '1'); updateCard(); }
    });

    if (on) {
      var agent = section(host, t('Agent', 'এজেন্ট'));
      var ask = i.mode === 'ask';
      row(agent, {
        key: PREF_MODE, icon: 'ask', isOn: ask,
        title: t('Ask before each command', 'প্রতিটি কমান্ডের আগে জিজ্ঞেস করুন'),
        sub: t('Off: the agent works on its own and Stop is always there.', 'বন্ধ থাকলে এজেন্ট নিজেই কাজ করে, আর থামানোর বোতাম সবসময় থাকে।'),
        onClick: function () { setPref(PREF_MODE, ask ? 'auto' : 'ask'); updateCard(); }
      });
      var cont = autoContinue();
      row(agent, {
        key: PREF_CONTINUE, icon: 'loop', isOn: cont,
        title: t('Keep going until the task is done', 'কাজ শেষ না হওয়া পর্যন্ত চালিয়ে যাক'),
        sub: t('When a reply stops in the middle of a task, the app quietly asks the AI to continue (at most twice per message you send).',
          'কাজের মাঝপথে উত্তর থেমে গেলে অ্যাপ চুপচাপ AI-কে চালিয়ে যেতে বলে (আপনার প্রতিটি মেসেজে সর্বোচ্চ দুবার)।'),
        onClick: function () { setPref(PREF_CONTINUE, cont ? '0' : '1'); updateCard(); }
      });
    }

    var tools = section(host, t('Tools', 'টুলস'));
    row(tools, {
      icon: 'studio', chevron: true,
      title: t('Open Linux Studio', 'লিনাক্স স্টুডিও খুলুন'),
      sub: t('Terminal, files and preview', 'টার্মিনাল, ফাইল ও প্রিভিউ'),
      onClick: openStudio
    });
    if (i.active > 0 || state.active) {
      row(tools, {
        icon: 'stop', title: t('Stop everything', 'সব থামান'),
        sub: t('Stops the agent and every running command', 'এজেন্ট ও চলমান সব কমান্ড থামায়'),
        onClick: function () { stopAgent(false); updateCard(); }
      });
    }
    if (i.installed && !i.installing) {
      var armed = Date.now() - page.resetArmed < 4000;
      row(tools, {
        icon: 'reset', danger: true,
        title: armed ? t('Tap again: delete all', 'আবার চাপুন: সব মুছবে') : t('Reset Linux…', 'লিনাক্স রিসেট…'),
        sub: t('Deletes Linux and every file in /root/workspace', 'লিনাক্স ও /root/workspace-এর সব ফাইল মুছে যাবে'),
        onClick: function () {
          if (Date.now() - page.resetArmed >= 4000) {
            page.resetArmed = Date.now();
            updateCard();
            setTimeout(updateCard, 4100);
            return;
          }
          page.resetArmed = 0;
          try { var b = bridge(); if (b && typeof b.sandboxReset === 'function') b.sandboxReset(); } catch (_) {}
          toast(t('Resetting Linux… your workspace files are being deleted.', 'লিনাক্স রিসেট হচ্ছে… ওয়ার্কস্পেসের ফাইল মুছে ফেলা হচ্ছে।'));
          infoCache = null;
          updateCard();
          setTimeout(updateCard, 1500);
        }
      });
    }

    // Generative UI settings live in a contextual sheet (sd-genui-panel.js);
    // this row is its entry point next to the other AI-tool settings.
    if (window.__sdGenUIPanel) {
      var gen = section(host, t('Generative UI', 'জেনারেটিভ UI'));
      var gcfg = window.__sdGenUIPrompt ? window.__sdGenUIPrompt.getConfig() : { enabled: true };
      row(gen, {
        icon: 'ask', chevron: true,
        title: t('Visual answers & artifacts', 'ভিজুয়াল উত্তর ও আর্টিফ্যাক্ট'),
        sub: (gcfg.enabled ? t('On', 'চালু') : t('Off', 'বন্ধ')) + ' · ' + t('kill switch, guidance frequency, diagnostics, activity log', 'কিল সুইচ, নির্দেশনার ফ্রিকোয়েন্সি, ডায়াগনস্টিক, কার্যক্রম লগ'),
        onClick: function () { window.__sdGenUIPanel.open(); }
      });
    }

    // Engine self-check (sd-health.js): the page it rides on can change under
    // us at any deploy, so the state is one tap away next to the other tools.
    var hs = healthState();
    if (hs.text) {
      var diag = section(host, t('Diagnostics', 'ডায়াগনস্টিকস'));
      row(diag, {
        icon: 'loop', chevron: true,
        title: t('Engine health', 'ইঞ্জিনের স্বাস্থ্য'),
        sub: hs.text,
        onClick: function () { try { window.__sdHealth.open(); } catch (_) {} }
      });
    }

    var foot = [];
    if (i.installed) foot.push(t('Files: ', 'ফাইল: ') + (i.workspace || '/root/workspace'));
    if (typeof i.freeBytes === 'number' && i.freeBytes >= 0) foot.push(t('Free: ', 'খালি: ') + Math.round(i.freeBytes / 1048576) + ' MB');
    if (!i.supported && i.reason) foot.push(String(i.reason));
    if (foot.length) host.appendChild(el('p', 'sd-foot', foot.join(' · ')));
  }

  /** Refreshes the page (and the overview row) with the current state. */
  function updateCard(fresh) {
    var ovr = document.querySelector && document.querySelector('#bds-drawer .bds-set-row[data-bds-page="linux"] .bds-set-val');
    // A freshly mounted page is filled before the engine attaches it.
    var host = page.el && (fresh === true || page.el.isConnected) ? page.el : null;
    if (!ovr && !host) return;
    infoCache = null;
    var i = info();
    if (ovr && ovr.textContent !== statusShort(i)) ovr.textContent = statusShort(i);
    if (!host) return;
    // Rebuilding the rows while one is being pressed would eat the tap.
    var sig = JSON.stringify([i.enabled, i.mode, i.installed, i.installing, i.active > 0 || state.active, autoContinue(),
      Date.now() - page.resetArmed < 4000, isBn(), i.supported, healthState().text]);
    if (host.getAttribute('data-sig') !== sig) { fillPage(host, i); host.setAttribute('data-sig', sig); return; }
    var line = statusText(i);
    var sub = host.querySelector('.sd-status .bds-set-sub');
    if (sub && sub.textContent !== line) sub.textContent = line;
    var dot = host.querySelector('.sd-status .sd-dot');
    if (dot) dot.setAttribute('data-state', dotState(i));
  }

  var PAGE_STYLE = '#sd-linux-page .bds-set-sub,#sd-linux-page .bds-set-title{white-space:normal;overflow:visible}' +
    '#sd-linux-page .sd-status{cursor:default}' +
    '#sd-linux-page .sd-status .bds-set-ico{color:#22c55e}' +
    '#sd-linux-page .sd-danger .bds-set-title,#sd-linux-page .sd-danger .bds-set-ico{color:#ef4444}' +
    '#sd-linux-page .sd-dot{flex:none;width:9px;height:9px;margin-right:4px;border-radius:50%;background:#8e8ea0}' +
    '#sd-linux-page .sd-dot[data-state="on"]{background:#22c55e}' +
    '#sd-linux-page .sd-dot[data-state="busy"]{background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:sd-pulse 1.6s infinite}' +
    '#sd-linux-page .sd-dot[data-state="wait"]{background:#f59e0b}' +
    '@keyframes sd-pulse{70%{box-shadow:0 0 0 6px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}' +
    '#sd-linux-page .sd-foot{margin:-8px 0 0;padding:0 6px;font-size:11.5px;line-height:1.4;color:var(--bds-text-tertiary);word-break:break-all}';

  /** Fills the "Linux & Agent" settings page the engine created. */
  function mountSettings(host) {
    if (!host || !document.createElement) return;
    if (!document.getElementById('sd-linux-style')) {
      var st = document.createElement('style');
      st.id = 'sd-linux-style';
      st.textContent = PAGE_STYLE;
      (document.head || document.documentElement).appendChild(st);
    }
    host.id = 'sd-linux-page';
    host.removeAttribute('data-sig');
    page.el = host;
    updateCard(true);
    // Live status (setup progress, running jobs) while the page is open.
    if (!page.timer) page.timer = setInterval(function () {
      if (!page.el || !page.el.isConnected) { clearInterval(page.timer); page.timer = null; return; }
      updateCard();
    }, 2500);
  }

  /** A page the engine rendered before this script was ready. */
  function adoptLinuxPage() {
    var host = document.querySelector && document.querySelector('#bds-drawer .sd-linux-page');
    if (host && host !== page.el) mountSettings(host);
  }

  // ── The sandbox call path ──────────────────────────────────────────────────

  function stoppedReply() {
    return { ok: false, error: 'Stopped by the user.' };
  }

  function sandboxCall(payload, inner) {
    if (window.__sdAgentStopped) return Promise.resolve(stoppedReply());
    beginCall(payload);
    return exactArgs(payload)
      .then(function (p) {
        state.label = describe(p);
        render();
        if (mode() !== 'ask') return p;
        return confirmCall(p).then(function (choice) {
          if (choice === CONFIRMATION_UNAVAILABLE) return choice;
          if (choice === 'skip') return null;
          if (choice === 'always') {
            setPref(PREF_MODE, 'auto');
            updateCard();
          }
          return p;
        });
      })
      .then(function (p) {
        if (p === CONFIRMATION_UNAVAILABLE) return { ok: false, error: 'Confirmation UI unavailable; action was not run.' };
        if (!p) return { ok: false, error: 'The user declined this action. Ask them or try another approach.' };
        if (window.__sdAgentStopped) return stoppedReply();
        return inner(p);
      })
      .then(function (reply) { endCall(); return reply; },
        function (err) { endCall(); return { ok: false, error: String((err && err.message) || err) }; });
  }

  // ── Tool cards: stop the spinner when the call is over ─────────────────────
  //
  // The engine draws a spinning card for every tool call in a reply and never
  // updates it; the result arrives as the next message. A card is finished
  // once a later message exists, or when nothing is running any more.

  var mcpPending = 0;
  var mcpLastEnd = 0;
  var CARD_IDLE_MS = 4000;

  function trackMcp(promise) {
    mcpPending++;
    var done = function () { mcpPending = Math.max(0, mcpPending - 1); mcpLastEnd = Date.now(); sweepSoon(); };
    return Promise.resolve(promise).then(function (v) { done(); return v; }, function (e) { done(); throw e; });
  }

  function messageOf(el) {
    return (el.closest && el.closest('.ds-message')) || null;
  }

  function lastMessage() {
    var all = document.querySelectorAll('.ds-message');
    return all.length ? all[all.length - 1] : null;
  }

  function sweepCards() {
    if (!document.querySelectorAll) return 0;
    var cards = document.querySelectorAll('.bds-mcp-loading:not(.sd-done):not(.sd-stopped)');
    if (!cards.length) return 0;
    var last = lastMessage();
    var idle = mcpPending === 0 && !generating() && Date.now() - Math.max(mcpLastEnd, state.lastActivity || 0) > CARD_IDLE_MS;
    var left = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var msg = messageOf(card);
      var superseded = !!(msg && last && msg !== last && !msg.contains(last));
      if (superseded || idle) card.classList.add(window.__sdAgentStopped && !superseded ? 'sd-stopped' : 'sd-done');
      else left++;
    }
    return left;
  }

  var sweepTimer = null;
  function sweepSoon() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(function tick() {
      sweepTimer = null;
      if (sweepCards() > 0) sweepTimer = setTimeout(tick, 1500);
    }, 300);
  }

  function watchCards() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes && records[i].addedNodes.length) { sweepSoon(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true });
    sweepSoon();
  }

  // ── Token savers (2.71.0) ──────────────────────────────────────────────────
  // T5: one line of rules in the tool instructions. Steps are shown to the
  // user as one progress card, so prose between calls is wasted tokens.
  var RUN_RULES = 'Between tool calls the user sees only a progress card, not your text: keep any text before calls to one short line and save explanations for the final summary. ' +
    'Do not print whole big files or long logs; when a result says the full output was saved in the sandbox, read only the part you need with read_file (offset_line, max_lines) instead of running the command again.';

  // T6: after every STEP_CAP tool calls in one instruction the user is asked
  // whether to continue (each step is another DeepSeek turn).
  var STEP_CAP = 25;
  var cap = { n: 0, next: STEP_CAP, asking: null };

  /** null = go on now; otherwise a promise of true (continue) / false (stop). */
  function capGate() {
    cap.n++;
    if (cap.n <= cap.next) return null;
    if (!cap.asking) {
      cap.asking = askContinue(cap.n - 1).then(function (go) {
        cap.asking = null;
        if (go) cap.next += STEP_CAP;
        else stopAgent(false);
        return go;
      });
    }
    return cap.asking;
  }

  function askContinue(done) {
    return new Promise(function (resolve) {
      if (!document.body || typeof document.createElement !== 'function') return resolve(true);
      var old = document.getElementById('sd-agent-confirm');
      if (old) old.remove();
      var wrap = document.createElement('div');
      wrap.id = 'sd-agent-confirm';
      wrap.className = 'sd-cap';
      var card = document.createElement('div');
      card.className = 'sd-card';
      var h = document.createElement('h3');
      h.textContent = t('The agent has run ' + done + ' steps. Continue?', 'এজেন্ট ' + done + 'টি ধাপ চালিয়েছে। চালিয়ে যাব?');
      var p = document.createElement('p');
      p.textContent = t('Every step is another DeepSeek reply. Continue for up to ' + STEP_CAP + ' more steps, or stop here.',
        'প্রতিটি ধাপে DeepSeek আবার উত্তর দেয়। আরও সর্বোচ্চ ' + STEP_CAP + 'টি ধাপ চালাতে পারেন, অথবা এখানেই থামাতে পারেন।');
      var row = document.createElement('div');
      row.className = 'sd-row';
      function button(text, cls, value) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        if (cls) b.className = cls;
        b.addEventListener('click', function () { wrap.remove(); resolve(value); });
        row.appendChild(b);
      }
      // The first button is what Back / dragging the sheet down presses (sd-sheets).
      button(t('Stop', 'থামান'), '', false);
      button(t('Continue', 'চালিয়ে যান'), 'sd-primary', true);
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(row);
      wrap.appendChild(card);
      document.body.appendChild(wrap);
    });
  }

  // T3: a big tool output is saved in the sandbox so only its head and tail go
  // back to the model. Uses the unwrapped bridge: an app-internal write, never
  // reachable through a payload flag. Returns the path, or null (then the old
  // behaviour applies: the output is attached as a file).
  var SAVE_DIR = '/tmp/sd-out/';
  var SAVE_TIMEOUT_MS = 8000;
  var rawFetch = null;
  var saveSeq = 0;
  function saveOutput(full, tool) {
    try {
      var i = info();
      if (!rawFetch || window.__sdAgentStopped) return Promise.resolve(null);
      if (!i.supported || i.enabled === false || !i.installed || i.installing || mode() === 'ask') return Promise.resolve(null);
      if (tool === 'read_file' || typeof full !== 'string' || !full) return Promise.resolve(null);
      var name = Date.now().toString(36) + (++saveSeq).toString(36) + '-' + String(tool || 'out').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40) + '.txt';
      var path = SAVE_DIR + name;
      var timer = null;
      var write = Promise.resolve()
        .then(function () {
          return rawFetch({ type: 'bds-mcp-call', serverUrl: SERVER.serverUrl, apiKey: '', toolName: 'write_file', args: { path: path, content: full } });
        })
        .then(function (r) { return r && r.ok && !(r.result && r.result.isError) ? path : null; }, function () { return null; });
      var late = new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, SAVE_TIMEOUT_MS); });
      return Promise.race([write, late]).then(function (v) { clearTimeout(timer); return v; });
    } catch (_) { return Promise.resolve(null); }
  }

  function install() {
    var inner = window.__sdBridgeFetch;
    if (typeof inner === 'function' && !inner.__sdAgentWrapped) {
      rawFetch = inner;
      var wrapped = function (payload) {
        if (payload && payload.type === 'bds-mcp-call') {
          var run = function () { return trackMcp(isSandboxUrl(payload.serverUrl) ? sandboxCall(payload, inner) : inner(payload)); };
          var gate = capGate();
          if (!gate) return run();
          return gate.then(function (go) { return go ? run() : stoppedReply(); });
        }
        return inner(payload);
      };
      wrapped.__sdAgentWrapped = true;
      window.__sdBridgeFetch = wrapped;
    }
    installResumeListeners();
    installScrollGuard();
    watchReplies();
    // A fresh page has no running loop (clears a flag left by a reload/crash).
    try { var b = bridge(); if (b && typeof b.sandboxAgentActive === 'function') b.sandboxAgentActive(false); } catch (_) {}
    if (document.body) { watchSheet(); watchCards(); }
    else document.addEventListener('DOMContentLoaded', function () { watchSheet(); watchCards(); });
  }

  install();

  window.__sdSandboxServers = sandboxServers;
  window.__sdSaveOutput = saveOutput;
  window.__sdAgent = {
    version: 1,
    stop: stopAgent,
    isActive: function () { return state.active; },
    /** From native: sandbox activity outside a tool call (Studio, jobs, reset). */
    refresh: function () { infoCache = null; updateCard(); },
    /** For the tool instructions (injected.js): the sandbox's live state. */
    promptContext: function () { try { return promptContext(); } catch (_) { return []; } },
    /** For the settings overview: whether this phone can run the sandbox, and a one-word state. */
    supported: function () { try { return !!info().supported; } catch (_) { return false; } },
    statusShort: function () { try { return statusShort(); } catch (_) { return ''; } },
    /** Fills the "Linux & Agent" settings page (content.js sdLinuxPg). */
    mountSettings: mountSettings,
    /** Raw messages of the open chat (for the run drawer, sd-run.js); null when unknown. */
    history: function () { var sid = sessionId(); return sid ? requestHistory(sid) : Promise.resolve(null); },
    messageText: messageText,
    stepCap: function () { return { done: cap.n, next: cap.next }; },
    // Exposed for tests.
    _parseTags: parseTags,
    _tagArgs: tagArgs,
    _pickRawArgs: pickRawArgs,
    _assistantTexts: assistantTexts,
    _isSandboxUrl: isSandboxUrl,
    _sweepCards: sweepCards,
    _looksUnfinished: looksUnfinished,
    _healthState: healthState,
    _nudgeFor: nudgeFor,
    _promptContext: promptContext,
    _statusText: statusText,
    _statusShort: statusShort,
    _scrollGuard: guard,
  };
})();
