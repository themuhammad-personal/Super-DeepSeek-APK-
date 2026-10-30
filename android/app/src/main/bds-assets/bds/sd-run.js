/*
 * Super DeepSeek — one card per agent run (2.71.0).
 *
 * The agent loop is a chain of DeepSeek web turns: the user's message, a reply
 * with tool calls, an automatic message with the results, the next reply, …
 * Shown as they are, every step is a pair of chat messages. Like ChatGPT and
 * Claude, a run is shown here as ONE answer instead:
 *  - the user's message stays, followed by the first reply with one run card
 *    in place of its tool-call cards, and the final answer;
 *  - the automatic result messages and the replies in between are hidden;
 *  - the card shows the live step, the last steps and Stop while it runs, and
 *    "Worked for … · N steps" when done;
 *  - tapping the card opens a bottom drawer with every step: what ran where,
 *    its input and output, how long it took, and the model's notes in between.
 *
 * Nothing is removed: messages are only hidden with an attribute, and when a
 * message cannot be recognised nothing is hidden (the chat looks as before).
 * Live step data comes from the engine (window.__sdRunEvent, content.js);
 * older runs are rebuilt from the chat history when the drawer opens.
 *
 * Plain ES2017, no dependencies. Loaded after sd-agent.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__sdRun) return;

  var MAX_OUT = 20000;        // output kept per live step (characters)
  var MAX_IN = 6000;          // input shown per step
  var MAX_NOTE = 1200;        // model note shown between steps
  var MAX_LIVE_STEPS = 400;
  var SHOW_LAST = 3;          // finished steps listed on a running card
  var STORE_KEY = 'sd_run_v1';
  var STORE_MAX = 60;         // runs whose timings are remembered
  var SCAN_MS = 60;
  var AUTO_RE = /\[[BS]DS:AUTO/;

  // ── Small helpers ──────────────────────────────────────────────────────────

  function isBn() {
    try {
      var e = window.__sdEngine;
      var l = e && typeof e.locale === 'function' ? String(e.locale() || '') : '';
      return String(l || document.documentElement.lang || navigator.language || '').toLowerCase().indexOf('bn') === 0;
    } catch (_) { return false; }
  }
  function t(en, bn) { return isBn() ? bn : en; }

  function num(n) {
    if (!isBn()) return String(n);
    var d = '০১২৩৪৫৬৭৮৯';
    return String(n).replace(/[0-9]/g, function (c) { return d[+c]; });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function hash(s) {
    var h = 5381;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function cap(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '\n… [' + (s.length - n) + ' more characters]' : s;
  }

  /** 0.4s · 12s · 1m 12s · 1h 3m */
  function fmtDur(ms) {
    if (!(ms >= 0) || !isFinite(ms)) return '';
    if (ms < 1000) return num((Math.max(ms, 100) / 1000).toFixed(1)) + t('s', 'সে');
    var s = Math.round(ms / 1000);
    if (s < 60) return num(s) + t('s', 'সে');
    var m = Math.floor(s / 60);
    if (m < 60) return num(m) + t('m ', 'মি ') + num(s % 60) + t('s', 'সে');
    return num(Math.floor(m / 60)) + t('h ', 'ঘ ') + num(m % 60) + t('m', 'মি');
  }

  /** Same idea as the engine's call summary: the command, or the path. */
  function callSummary(tool, args) {
    try {
      var a = args || {};
      var s;
      if (typeof a.command === 'string') s = a.command;
      else if (typeof a.path === 'string') {
        s = a.path + (typeof a.content === 'string' ? ' (' + a.content.length + ' chars)' : typeof a.old_text === 'string' ? ' (edit)' : '');
      } else if (typeof a.call === 'string') s = a.call;
      else s = JSON.stringify(a);
      s = String(s == null ? '' : s);
      if (s === '{}') s = '';
      return s.length > 300 ? s.slice(0, 300) + '…' : s;
    } catch (_) { return ''; }
  }

  function isSandbox(url) { return /^sandbox/i.test(String(url || '')); }

  function isAttrQuoteClose(s, afterQuote) {
    var rest = s.slice(afterQuote);
    return /^\s*(?:\/?>|\/\s*$|$)/.test(rest) ||
      /^\s+[A-Za-z0-9_:-]+\s*(?:=|\/?>|$)/.test(rest) ||
      /^\s*[A-Za-z0-9_:-]+\s*=/.test(rest);
  }

  /** Parse only real attribute names; text inside quoted values is never an attribute. */
  function parseAttrMeta(attrs) {
    var s = String(attrs || '');
    var i = 0;
    var hasTool = false;
    var hasArgs = false;
    while (i < s.length) {
      while (i < s.length && /[\s/]/.test(s[i])) i++;
      var keyStart = i;
      while (i < s.length && /[A-Za-z0-9_:-]/.test(s[i])) i++;
      if (i === keyStart) { i++; continue; }
      var key = s.slice(keyStart, i).toLowerCase();
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] !== '=') {
        if (i < s.length) i++;
        continue;
      }
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (key === 'tool' || key === 'toolname' || key === 'name') hasTool = true;
      if (key === 'args' || key === 'base64args') hasArgs = true;
      if (i >= s.length) break;
      var q = s[i];
      if (q === '"' || q === "'") {
        i++;
        while (i < s.length) {
          if (s[i] === '\\') { i += 2; continue; }
          if (s[i] === q && isAttrQuoteClose(s, i + 1)) { i++; break; }
          i++;
        }
      } else {
        while (i < s.length && !/[\s/]/.test(s[i])) i++;
      }
    }
    return { hasTool: hasTool, hasArgs: hasArgs };
  }

  function hasToolAttribute(attrs) {
    return parseAttrMeta(attrs).hasTool;
  }

  function readMcpOpen(s, start, prefixLength) {
    var i = start + prefixLength;
    var quote = null;
    for (; i < s.length; i++) {
      var c = s[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote && isAttrQuoteClose(s, i + 1)) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (i >= s.length) {
      var partialAttrs = s.slice(start + prefixLength);
      var partialMeta = parseAttrMeta(partialAttrs);
      var looksLikeStreamingTag = partialMeta.hasTool ||
        /^\s*(?:$|[A-Za-z0-9_:-]*$|(?:url|server|serverurl|tool|toolname|name|args|base64args)\s*(?:=|$))/i.test(partialAttrs);
      if (!looksLikeStreamingTag) return null;
      return {
        start: start,
        tagEnd: s.length,
        end: s.length,
        attrs: partialAttrs,
        valid: true,
        hasArgs: partialMeta.hasArgs,
        streamingOpen: true,
        selfClosing: false
      };
    }
    var attrs = s.slice(start + prefixLength, i);
    var meta = parseAttrMeta(attrs);
    return {
      start: start,
      tagEnd: i,
      end: i + 1,
      attrs: attrs,
      valid: meta.hasTool,
      hasArgs: meta.hasArgs,
      streamingOpen: false,
      selfClosing: /\/\s*$/.test(attrs)
    };
  }

  function findNextMcpOpen(s, from) {
    var re = /<[BS]DS:(?:AUTO:)?MCP\b/gi;
    re.lastIndex = from;
    var m;
    while ((m = re.exec(s))) {
      var open = readMcpOpen(s, m.index, m[0].length);
      if (!open) return null;
      if (open.valid) return open;
      re.lastIndex = open.end;
    }
    return null;
  }

  /**
   * Scan a body for its first real close or a later call opener. Tool bodies are
   * JSON, so delimiter-looking text inside double-quoted JSON strings is data,
   * not a tag boundary. Escape sequences are respected.
   */
  function findMcpBoundary(s, from) {
    var inString = false;
    var escaped = false;
    var close = /<\/[BS]DS:(?:AUTO:)?MCP\s*>/gi;
    var open = /<[BS]DS:(?:AUTO:)?MCP\b/gi;
    for (var i = from; i < s.length; i++) {
      var c = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c !== '<') continue;
      close.lastIndex = i;
      var cm = close.exec(s);
      if (cm && cm.index === i) return { type: 'close', start: i, end: i + cm[0].length };
      open.lastIndex = i;
      var om = open.exec(s);
      if (om && om.index === i) {
        var next = readMcpOpen(s, i, om[0].length);
        if (!next) return null;
        if (next.valid) return { type: 'next', start: i, end: next.end };
        i = next.end - 1;
      }
    }
    return null;
  }

  /**
   * Find real MCP call spans. A streamed call without a close consumes its current
   * body, but stops before the next valid call opener so calls remain independent.
   * Attribute names inside quoted values are ignored.
   */
  function findRawCallSpans(text) {
    var s = String(text || '');
    var re = /<[BS]DS:(?:AUTO:)?MCP\b/gi;
    var spans = [];
    var m;
    while ((m = re.exec(s))) {
      var open = readMcpOpen(s, m.index, m[0].length);
      if (!open) break;
      if (!open.valid) {
        re.lastIndex = open.end;
        continue;
      }
      var end = open.end;
      if (open.streamingOpen) {
        end = s.length;
      } else if (!open.selfClosing) {
        if (open.hasArgs) {
          var closeOnly = /^\s*(?:<\/[BS]DS:(?:AUTO:)?MCP\s*>|<\/?(?:[BS]DS:[A-Za-z0-9_:]*|[BS]DS|[BS]D|[BS])?\s*$)/i.exec(s.slice(open.end));
          if (closeOnly) end = open.end + closeOnly[0].length;
        } else {
          var boundary = findMcpBoundary(s, open.end);
          if (boundary && boundary.type === 'close') end = boundary.end;
          else if (boundary && boundary.type === 'next') end = boundary.start;
          else end = s.length;
        }
      }
      spans.push({ start: open.start, end: end });
      re.lastIndex = end;
    }
    return spans;
  }

  function rawCallCount(text) { return findRawCallSpans(text).length; }

  function isProtocolResultText(text) {
    var tx = String(text || '').trim();
    return /^<(?:SuperDeepSeek|BetterDeepSeek)>\s*[\s\S]*?\[(?:SDS|BDS):AUTO_MCP_(RESULT|ERROR)\][\s\S]*?\[\/(?:SDS|BDS):AUTO_MCP_\1\]\s*<\/(?:SuperDeepSeek|BetterDeepSeek)>$/i.test(tx);
  }

  function isAutoUserText(text, role) {
    var tx = String(text || '').trim();
    var r = String(role || '').toLowerCase();
    // Assistant replies are auto protocol traffic only when the whole message
    // is the structured result/error envelope, not because it quotes a marker.
    if (r === 'assistant') return isProtocolResultText(tx);
    if (r !== 'user') return false;
    return isProtocolResultText(tx) ||
      /^(?:<(?:SuperDeepSeek|BetterDeepSeek)>\s*)?\[[BS]DS:AUTO(?:\s|\]|_|:)/i.test(tx) ||
      /^<(?:SuperDeepSeek|BetterDeepSeek)>[\s\S]{0,160}\[[BS]DS:AUTO_MCP_(?:RESULT|ERROR)\]/i.test(tx) ||
      /\bmcp_results?(?:_[A-Za-z0-9_.-]+)?\.txt\b/i.test(tx);
  }

  /** Normalise protocol messages before grouping, independent of DOM role selectors. */
  function classifyMessage(role, text, loadingCalls, forceAuto) {
    var auto = !!forceAuto || isAutoUserText(text, role);
    if (auto) role = 'user';
    var calls = role === 'assistant'
      ? Math.max(Number(loadingCalls) || 0, rawCallCount(text))
      : 0;
    return { role: role, auto: auto, calls: calls };
  }

  function serverLabel(url) {
    if (!url || isSandbox(url)) return t('Linux sandbox', 'লিনাক্স স্যান্ডবক্স');
    var m = String(url).match(/^[a-z]+:\/\/([^/?#]+)/i);
    return m ? m[1] : String(url);
  }

  /** Result / error blocks of an automatic message, in order. */
  function parseResults(text) {
    var out = [];
    var re = /\[[BS]DS:AUTO_MCP_(RESULT|ERROR)\]\s*([\s\S]*?)\s*\[\/[BS]DS:AUTO_MCP_\1\]/g;
    var m;
    var s = String(text || '');
    while ((m = re.exec(s))) {
      var err = m[1] === 'ERROR';
      var j = {};
      try { j = JSON.parse(m[2]) || {}; } catch (_) { j = {}; }
      out.push({
        error: err,
        toolName: String(j.toolName || ''),
        serverName: String(j.serverName || j.serverUrl || ''),
        call: typeof j.call === 'string' ? j.call : '',
        args: j.args && typeof j.args === 'object' ? j.args : null,
        content: String(err ? (j.error || '') : (j.content || '')),
      });
    }
    return out;
  }

  /** The prose of a reply without its tool calls and engine wrappers. */
  function stripTags(text) {
    var raw = String(text || '');
    var spans = findRawCallSpans(raw);
    for (var i = spans.length - 1; i >= 0; i--) {
      raw = raw.slice(0, spans[i].start) + raw.slice(spans[i].end);
    }
    var s = raw
      .replace(/<\/[BS]DS:(?:AUTO:)?MCP\s*>/gi, '')
      .replace(/<(?:SuperDeepSeek|BetterDeepSeek)>[\s\S]*?(?:<\/(?:SuperDeepSeek|BetterDeepSeek)>|$)/gi, '')
      .replace(/<[BS]DS:[A-Za-z0-9_:]*$/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return s.length > MAX_NOTE ? s.slice(0, MAX_NOTE) + '…' : s;
  }

  // ── Grouping (pure) ────────────────────────────────────────────────────────

  /**
   * `list`: the chat in order, as { role: 'user'|'assistant', auto, calls }.
   * Returns the agent runs:
   *   { user, host, final, assistants, autos, hidden, calls, last }
   * (indexes into `list`; user is -1 when the run's start is not rendered).
   * A run is an agent run when it has an automatic message or a tool call.
   * Visible: the user's message, the first reply (host, carries the card) and
   * the final reply (the last one, when it has no call). Hidden: the rest.
   */
  function groupRuns(list) {
    var runs = [];
    var cur = null;
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      if (m.role === 'user' && !m.auto) {
        cur = { user: i, assistants: [], autos: [] };
        runs.push(cur);
        continue;
      }
      if (!cur) { cur = { user: -1, assistants: [], autos: [] }; runs.push(cur); }
      if (m.role === 'user') cur.autos.push(i);
      else if (m.role === 'assistant') cur.assistants.push(i);
    }
    var out = [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var calls = 0;
      run.assistants.forEach(function (k) { calls += Number(list[k].calls) || 0; });
      if (!run.autos.length && !calls) continue;
      if (!run.assistants.length) continue;   // nothing to carry the card
      var host = run.assistants[0];
      var lastA = run.assistants[run.assistants.length - 1];
      var lastAuto = run.autos.length ? run.autos[run.autos.length - 1] : -1;
      var final = lastA !== host && !(Number(list[lastA].calls) > 0) && lastA > lastAuto ? lastA : -1;
      var hidden = run.autos.slice();
      run.assistants.forEach(function (k) { if (k !== host && k !== final) hidden.push(k); });
      hidden.sort(function (a, b) { return a - b; });
      out.push({ user: run.user, host: host, final: final, assistants: run.assistants, autos: run.autos,
        hidden: hidden, calls: calls, last: r === runs.length - 1 });
    }
    return out;
  }

  /** The current branch of a chat's raw messages (regenerations leave others). */
  function branch(messages) {
    if (!Array.isArray(messages) || !messages.length) return [];
    var byId = {};
    var hasLinks = false;
    var top = null;
    messages.forEach(function (m) {
      if (!m || m.message_id == null) return;
      byId[m.message_id] = m;
      if (m.parent_id != null) hasLinks = true;
      if (!top || Number(m.message_id) > Number(top.message_id)) top = m;
    });
    if (!hasLinks || !top) return messages.slice();
    var chain = [];
    var seen = {};
    for (var m = top; m && !seen[m.message_id]; m = m.parent_id != null ? byId[m.parent_id] : null) {
      seen[m.message_id] = 1;
      chain.push(m);
    }
    return chain.reverse();
  }

  /**
   * Agent runs rebuilt from raw history: [{ userText, turns: [{ note, calls }] }]
   * with calls { tool, server, args, result: { error, content } | null }.
   * `api` supplies messageText / parseTags / tagArgs (sd-agent.js).
   */
  function historyRuns(messages, api) {
    var out = [];
    var cur = null;
    branch(messages).forEach(function (m) {
      var role = String((m && m.role) || '').toUpperCase();
      var text = api.messageText(m) || '';
      if (role === 'USER') {
        if (AUTO_RE.test(text)) {
          if (!cur || !cur.turns.length) return;
          var turn = cur.turns[cur.turns.length - 1];
          parseResults(text).forEach(function (res) {
            var c = null;
            for (var i = 0; i < turn.calls.length && !c; i++) if (!turn.calls[i].result && turn.calls[i].tool === res.toolName) c = turn.calls[i];
            for (var j = 0; j < turn.calls.length && !c; j++) if (!turn.calls[j].result) c = turn.calls[j];
            if (!c) {
              c = { tool: res.toolName, server: res.serverName, args: res.args || (res.call ? { call: res.call } : {}), result: null };
              turn.calls.push(c);
            }
            c.result = { error: res.error, content: res.content };
          });
        } else {
          cur = { userText: text, turns: [] };
          out.push(cur);
        }
        return;
      }
      if (role !== 'ASSISTANT' || !cur) return;
      var tags = [];
      try { tags = api.parseTags(text) || []; } catch (_) { tags = []; }
      cur.turns.push({
        note: stripTags(text),
        calls: tags.map(function (tag) {
          var a = tag.attrs || {};
          var args = null;
          try { args = api.tagArgs(tag); } catch (_) { args = null; }
          return { tool: String(a.tool || a.name || ''), server: String(a.url || a.server || ''), args: args || {}, result: null };
        }),
      });
    });
    return out.filter(function (r) { return r.turns.some(function (tn) { return tn.calls.length; }); });
  }

  /** The history run for a rendered run: by its text, else by position from the end. */
  function matchRun(hruns, userText, fromEnd) {
    var want = norm(userText).slice(0, 60);
    if (want) {
      for (var i = hruns.length - 1; i >= 0; i--) if (norm(hruns[i].userText).indexOf(want) >= 0) return hruns[i];
    }
    var k = hruns.length - 1 - (fromEnd || 0);
    return k >= 0 && k < hruns.length ? hruns[k] : null;
  }

  // ── Remembered timings ─────────────────────────────────────────────────────

  function loadStore() {
    try { var v = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
  }
  var store = loadStore();
  var saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        var keys = Object.keys(store);
        if (keys.length > STORE_MAX) {
          keys.sort(function (a, b) { return (store[b].u || 0) - (store[a].u || 0); });
          keys.slice(STORE_MAX).forEach(function (k) { delete store[k]; });
        }
        window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
      } catch (_) {}
    }, 800);
  }
  function remember(run) {
    if (!run || !run.key || /\|live$/.test(run.key)) return;
    store[run.key] = {
      u: Date.now(), t0: run.t0, t1: run.t1,
      steps: run.steps.slice(-MAX_LIVE_STEPS).map(function (s) {
        return { tool: s.tool, server: s.server, call: s.call, ok: s.ok, ms: s.t1 ? s.t1 - s.t0 : null, saved: s.saved || null, stopped: !!s.stopped };
      }),
    };
    saveSoon();
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function sessionId() {
    var m = String(location.href || '').match(/\/chat\/s\/([^/?#]+)/);
    return m ? m[1] : 'new';
  }

  /** Chat messages, like the engine's own list (g1 in content.js). */
  function messageEls() {
    var list = document.querySelectorAll('div.ds-message._63c77b1');
    if (!list.length) list = document.querySelectorAll('div.ds-message');
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.closest('#bds-root, .bds-host-wrapper, .sd-run-card, #sd-run-sheet')) continue;
      if (out.length && out[out.length - 1].contains(el)) continue;
      out.push(el);
    }
    return out;
  }

  /** The engine's role test (W_ in content.js). */
  function roleOf(el) {
    if (el.classList.contains('d29f3d7d')) return 'user';
    if (el.closest('div._4f9bf79._43c05b5')) return 'assistant';
    if (el.closest('div._9663006')) return 'user';
    var r = el.getAttribute('data-message-author-role');
    return r ? String(r).toLowerCase() : 'assistant';
  }

  /**
   * Read text for protocol detection while ignoring rendered code examples and
   * our own activity UI. Hidden raw-call spans remain part of the source text.
   */
  function collectTextEntries(root, out, hiddenParent) {
    if (!root) return;
    if (root.nodeType === 3) {
      if (root.nodeValue) out.push({ node: root, hidden: hiddenParent || null });
      return;
    }
    if (root.nodeType !== 1) return;
    var tag = String(root.tagName || '').toUpperCase();
    if (tag === 'PRE' || tag === 'CODE' || tag === 'SCRIPT' || tag === 'STYLE') return;
    if (root.id === 'sd-run-sheet' ||
        (root.classList && (
          root.classList.contains('sd-run-card') ||
          root.classList.contains('bds-overlay-host') ||
          root.classList.contains('bds-message-overlay') ||
          root.classList.contains('bds-mcp-loading') ||
          root.classList.contains('bds-mcp-result-card') ||
          root.classList.contains('bds-mcp-error-card')
        ))) return;
    var hidden = root.hasAttribute && root.hasAttribute('data-sd-run-raw-hidden') ? root : hiddenParent;
    var children = root.childNodes;
    if (!children || !children.length) return;
    for (var i = 0; i < children.length; i++) collectTextEntries(children[i], out, hidden);
  }

  function protocolText(root) {
    var entries = [];
    collectTextEntries(root, entries, null);
    // Empty means only excluded code/examples; never classify those through textContent.
    return entries.map(function (e) { return e.node.nodeValue || ''; }).join('');
  }

  function visibleText(el) {
    var parts = el && el.querySelectorAll ? el.querySelectorAll('.fbb737a4, .ds-markdown, .ds-collapsible-text') : [];
    var s = '';
    for (var i = 0; i < parts.length; i++) if (!parts[i].closest('.bds-hidden-message')) s += parts[i].textContent || '';
    return norm(s);
  }

  /** An automatic message of the engine (tool results, an agent nudge). */
  function isAutoUser(el, role, text) {
    if (!el) return false;
    role = role || roleOf(el);
    if (el.hasAttribute && el.hasAttribute('data-bds-auto-user')) return true;
    if (el.querySelector && el.querySelector('.bds-mcp-result-card, .bds-mcp-error-card')) return true;
    if (isAutoUserText(text == null ? protocolText(el) : text, role)) return true;
    // A nudge is wiped by the engine's sanitiser, leaving nothing visible.
    var hiddenSelfOrChild = (el.classList && el.classList.contains('bds-hidden-message')) ||
      !!(el.querySelector && el.querySelector('.bds-hidden-message'));
    return role === 'user' && hiddenSelfOrChild && !visibleText(el);
  }

  function userText(el) {
    var p = el.querySelector('.fbb737a4') || el.querySelector('.ds-markdown') || el;
    return norm(p.textContent || '').slice(0, 300);
  }

  /** The message's row in the chat list (its outermost own wrapper). */
  var rowCache = new WeakMap();
  function rowOf(msg) {
    var c = rowCache.get(msg);
    if (c && c.isConnected && c.contains(msg)) return c;
    var row = msg;
    for (var i = 0; i < 6; i++) {
      var p = row.parentElement;
      if (!p || p === document.body || p.matches('main, [role="main"]')) break;
      var n = p.querySelectorAll('.ds-message').length;
      if (n !== 1) break;
      row = p;
    }
    rowCache.set(msg, row);
    return row;
  }

  /**
   * Hide exact raw-call text spans, not whole paragraphs. This preserves adjacent
   * prose, fenced code examples, and calls whose tag is split between text nodes.
   * The selected text stays in reversible span wrappers in the original DOM.
   */
  var hiddenRawNodes = new Set();

  function restoreHiddenRawNode(node) {
    if (!node) return;
    if (node.removeAttribute) node.removeAttribute('data-sd-run-raw-hidden');
    var parent = node.parentNode;
    if (!parent || String(node.tagName || '').toUpperCase() !== 'SPAN') return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  function hideRawCallBlocks(host, nextHidden) {
    if (!host || !host.querySelectorAll) return;
    var entries = [];
    collectTextEntries(host, entries, null);
    if (!entries.length) return;

    var full = '';
    entries.forEach(function (entry) {
      entry.start = full.length;
      full += entry.node.nodeValue || '';
      entry.end = full.length;
    });
    var calls = findRawCallSpans(full);
    if (!calls.length) return;

    var operations = [];
    calls.forEach(function (call) {
      entries.forEach(function (entry) {
        var start = Math.max(call.start, entry.start);
        var end = Math.min(call.end, entry.end);
        if (end <= start) return;
        if (entry.hidden) nextHidden.add(entry.hidden);
        else operations.push({
          node: entry.node,
          start: start - entry.start,
          end: end - entry.start,
          absoluteStart: start
        });
      });
    });
    // Split from right to left so earlier offsets in a shared text node remain valid.
    operations.sort(function (a, b) { return b.absoluteStart - a.absoluteStart; });
    operations.forEach(function (op) {
      var node = op.node;
      var parent = node && node.parentNode;
      if (!parent || typeof node.splitText !== 'function' || !document.createElement) return;
      var value = String(node.nodeValue || '');
      if (op.start < 0 || op.end > value.length || op.start >= op.end) return;
      if (op.end < value.length) node.splitText(op.end);
      var segment = op.start > 0 ? node.splitText(op.start) : node;
      var wrapper = document.createElement('span');
      wrapper.setAttribute('data-sd-run-raw-hidden', '');
      wrapper.setAttribute('aria-hidden', 'true');
      segment.parentNode.replaceChild(wrapper, segment);
      wrapper.appendChild(segment);
      nextHidden.add(wrapper);
    });
  }

  function generating() {
    return !!document.querySelector('.ds-icon-stop-circle, .ds-icon-stop');
  }
  function agentActive() {
    try { return !!(window.__sdAgent && window.__sdAgent.isActive()); } catch (_) { return false; }
  }

  // ── Live steps (from content.js) ───────────────────────────────────────────

  var live = null;          // { key, t0, t1, steps, byId }
  var lastRunKey = null;    // key of the newest rendered run (set by scan)
  var lastHref = String((typeof location !== 'undefined' && location.href) || '');

  function sidFromHref(h) {
    var m = String(h || '').match(/\/chat\/s\/([^/?#]+)/);
    return m ? m[1] : 'new';
  }

  function syncHref() {
    var curHref = String((typeof location !== 'undefined' && location.href) || '');
    if (curHref === lastHref) return;
    var prevSid = sidFromHref(lastHref);
    var nextSid = sidFromHref(curHref);
    lastHref = curHref;
    if (prevSid === nextSid) return;
    closeDrawer();
    if (live && prevSid === 'new' && nextSid !== 'new' && live.key && live.key.indexOf('new|') === 0) {
      live.key = nextSid + live.key.slice(3);
      remember(live);
      return;
    }
    live = null;
  }

  function keyFor(text) { return sessionId() + '|' + hash(norm(text).slice(0, 300)); }

  function currentKey() {
    var els = messageEls();
    for (var i = els.length - 1; i >= 0; i--) {
      if (roleOf(els[i]) === 'user' && !isAutoUser(els[i], 'user')) return keyFor(userText(els[i]));
    }
    return sessionId() + '|live';
  }

  function onEvent(d) {
    if (!d || typeof d !== 'object') return;
    syncHref();
    if (d.phase === 'start') {
      var sid = sessionId();
      var key = currentKey();
      if (!live) {
        live = { key: key, t0: d.at || Date.now(), t1: 0, steps: [], byId: {} };
      } else if (live.key !== key) {
        if (key === sid + '|live' && live.key.indexOf(sid + '|') === 0) {
          // User message unmounted by virtual scroll during the same session run.
        } else if (live.key === sid + '|live' && key.indexOf(sid + '|') === 0) {
          live.key = key;
        } else {
          live = { key: key, t0: d.at || Date.now(), t1: 0, steps: [], byId: {} };
        }
      }
      if (live.steps.length >= MAX_LIVE_STEPS) return;
      var a = '';
      try { a = JSON.stringify(d.args || {}, null, 2); } catch (_) { a = ''; }
      var s = { id: d.id, tool: String(d.tool || ''), server: String(d.server || ''), call: String(d.call || ''),
        input: cap(a, MAX_IN), t0: d.at || Date.now(), t1: 0, ok: null, output: '', saved: null, stopped: false };
      live.steps.push(s);
      live.byId[d.id] = s;
    } else if (d.phase === 'end') {
      var st = live && live.byId[d.id];
      if (!st) return;
      st.t1 = d.at || Date.now();
      st.ok = !!d.ok;
      st.stopped = !!d.stopped;
      st.output = cap(d.output, MAX_OUT);
      st.saved = d.saved || null;
      live.t1 = st.t1;
    } else return;
    remember(live);
    scheduleScan(true);
  }

  function pendingLive() {
    return !!(live && live.steps.some(function (s) { return !s.t1; }));
  }

  // ── The card ───────────────────────────────────────────────────────────────

  function runInfo(run, els) {
    var host = els[run.host];
    var sid = sessionId();
    var uText = run.user >= 0 ? userText(els[run.user]) : '';
    var key = run.user >= 0 ? keyFor(uText) : null;
    var lv = live && ((key && live.key === key) ||
      (run.last && live.key && live.key.indexOf(sid + '|') === 0 && (!key || live.key === sid + '|live'))) ? live : null;
    if (lv && key && lv.key === sid + '|live') { lv.key = key; remember(lv); }
    var meta = !lv && key ? store[key] : null;
    var steps = lv ? lv.steps : meta && Array.isArray(meta.steps) ? meta.steps : [];
    var running = run.last && ((lv && pendingLive()) || agentActive() || generating());
    var stopped = !running && run.last && !!window.__sdAgentStopped;
    var n = Math.max(steps.length, run.calls);
    var failed = steps.filter(function (s) { return s.ok === false && !s.stopped; }).length;
    var t0 = lv ? lv.t0 : meta && meta.t0;
    var t1 = lv ? lv.t1 : meta && meta.t1;
    return { run: run, host: host, key: key, userText: uText, steps: steps, live: !!lv, running: running,
      stopped: stopped, count: n, failed: failed, t0: t0 || 0, t1: t1 || 0 };
  }

  function stepMs(s) {
    if (s.ms != null) return s.ms;
    return s.t1 && s.t0 ? s.t1 - s.t0 : null;
  }

  function stepIcon(s) {
    if (s.stopped) return 'stop';
    if (s.ok === true) return 'ok';
    if (s.ok === false) return 'err';
    return 'run';
  }

  function cardHtml(info) {
    var st = info.running ? 'running' : info.stopped ? 'stopped' : 'done';
    var steps = info.count === 1 ? t('1 step', '১টি ধাপ') : t(info.count + ' steps', num(info.count) + 'টি ধাপ');
    var title;
    var meta = [steps];
    if (info.running) {
      title = t('Working', 'কাজ চলছে');
      if (info.t0) meta.push(fmtDur(Date.now() - info.t0));
    } else if (info.stopped) {
      title = t('Stopped', 'থামানো হয়েছে');
    } else if (info.t0 && info.t1 > info.t0) {
      title = t('Worked for ', 'কাজ করেছে ') + fmtDur(info.t1 - info.t0);
    } else {
      title = t('Worked', 'কাজ সম্পন্ন');
    }
    if (info.failed) meta.push(t(info.failed + ' failed', num(info.failed) + 'টি ব্যর্থ'));
    var h = '<div class="sd-run-head"><span class="sd-run-ic" data-s="' + st + '"></span>' +
      '<span class="sd-run-title">' + esc(title) + '</span>' +
      '<span class="sd-run-meta">' + esc(meta.join(' · ')) + '</span>' +
      (info.running ? '<button type="button" class="sd-run-stop"><i></i>' + esc(t('Stop', 'থামান')) + '</button>' : '') +
      '<span class="sd-run-chev" aria-hidden="true"></span></div>';
    if (info.running) {
      var cur = null;
      for (var i = info.steps.length - 1; i >= 0; i--) if (!info.steps[i].t1 && info.steps[i].ok == null) { cur = info.steps[i]; break; }
      h += '<div class="sd-run-now">' + (cur
        ? '<b>' + esc(cur.tool) + '</b><span>' + esc(cur.call || serverLabel(cur.server)) + '</span>'
        : '<span>' + esc(t('Thinking about the next step…', 'পরের ধাপ ভাবছে…')) + '</span>') + '</div>';
      var done = info.steps.filter(function (s) { return s !== cur; }).slice(-SHOW_LAST);
      if (done.length) {
        h += '<ul class="sd-run-last">' + done.map(function (s) {
          var ms = stepMs(s);
          return '<li><span class="sd-run-si" data-s="' + stepIcon(s) + '"></span><b>' + esc(s.tool) + '</b><span>' +
            esc(s.call || '') + '</span>' + (ms != null ? '<em>' + esc(fmtDur(ms)) + '</em>' : '') + '</li>';
        }).join('') + '</ul>';
      }
    }
    return { state: st, html: h };
  }

  var cards = new Set();
  function ensureCard(info) {
    var host = info.host;
    var card = null;
    for (var i = 0; i < host.children.length; i++) {
      if (host.children[i].classList && host.children[i].classList.contains('sd-run-card')) { card = host.children[i]; break; }
    }
    if (!card) {
      card = document.createElement('div');
      card.className = 'sd-run-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.addEventListener('click', onCardClick);
      card.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onCardClick.call(card, ev); } });
      host.appendChild(card);
    }
    var c = cardHtml(info);
    if (card.__sdHtml !== c.html) { card.innerHTML = c.html; card.__sdHtml = c.html; }
    card.setAttribute('data-state', c.state);
    card.setAttribute('aria-label', norm(card.textContent));
    card.__sdInfo = info;
    cards.add(card);
    observeCard(card);
    return card;
  }

  function onCardClick(ev) {
    var info = this.__sdInfo;
    if (!info) return;
    if (ev && ev.target && ev.target.closest && ev.target.closest('.sd-run-stop')) {
      ev.preventDefault();
      ev.stopPropagation();
      try { if (window.__sdAgent) window.__sdAgent.stop(); } catch (_) {}
      scheduleScan(true);
      return;
    }
    openDrawer(info);
  }

  // The floating Stop chip of sd-agent is redundant while a running card is
  // on screen; it comes back when the card scrolls away.
  var io = null;
  var visibleCards = new Set();
  function observeCard(card) {
    if (card.__sdObserved) return;
    card.__sdObserved = true;
    if (typeof IntersectionObserver !== 'function') return;
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) visibleCards.add(e.target); else visibleCards.delete(e.target); });
        syncChip();
      });
    }
    io.observe(card);
  }
  function syncChip() {
    var on = false;
    visibleCards.forEach(function (c) { if (c.isConnected && c.getAttribute('data-state') === 'running') on = true; });
    document.documentElement.classList.toggle('sd-run-card-visible', on);
  }

  // ── Scan ───────────────────────────────────────────────────────────────────

  var hiddenRows = new Set();
  var hostEls = new Set();
  var anyRunning = false;

  function scan() {
    syncHref();
    if (disabled()) { reset(); return; }
    var els = messageEls();
    var list = els.map(function (el) {
      var role = roleOf(el);
      var text = protocolText(el);
      var auto = isAutoUser(el, role, text);
      return classifyMessage(role, text,
        role === 'assistant' ? el.querySelectorAll('.bds-mcp-loading').length : 0, auto);
    });
    var runs = groupRuns(list);
    var nextHidden = new Set();
    var nextRawHidden = new Set();
    var nextHosts = new Set();
    var seen = new Set();
    var realAfter = 0;
    anyRunning = false;
    var realIdx = [];
    list.forEach(function (m, i) { if (m.role === 'user' && !m.auto) realIdx.push(i); });
    runs.forEach(function (run) {
      run.hidden.forEach(function (k) { nextHidden.add(rowOf(els[k])); });
      var info = runInfo(run, els);
      realAfter = run.user >= 0 ? realIdx.length - 1 - realIdx.indexOf(run.user) : 0;
      info.fromEnd = realAfter;
      var host = els[run.host];
      host.setAttribute('data-sd-run-host', '');
      nextHosts.add(host);
      hideRawCallBlocks(host, nextRawHidden);
      seen.add(ensureCard(info));
      if (info.running) anyRunning = true;
      if (run.last) lastRunKey = info.key;
    });
    hiddenRows.forEach(function (r) { if (!nextHidden.has(r)) r.removeAttribute('data-sd-run-hidden'); });
    nextHidden.forEach(function (r) { if (!r.hasAttribute('data-sd-run-hidden')) r.setAttribute('data-sd-run-hidden', ''); });
    hiddenRows = nextHidden;
    hiddenRawNodes.forEach(function (node) { if (!nextRawHidden.has(node)) restoreHiddenRawNode(node); });
    nextRawHidden.forEach(function (node) { if (!node.hasAttribute('data-sd-run-raw-hidden')) node.setAttribute('data-sd-run-raw-hidden', ''); });
    hiddenRawNodes = nextRawHidden;
    hostEls.forEach(function (h) { if (!nextHosts.has(h)) h.removeAttribute('data-sd-run-host'); });
    hostEls = nextHosts;
    cards.forEach(function (c) {
      if (!seen.has(c)) { if (io) io.unobserve(c); visibleCards.delete(c); c.remove(); cards.delete(c); }
    });
    syncChip();
    refreshDrawer();
    if (anyRunning) tickSoon();
  }

  function reset() {
    hiddenRows.forEach(function (r) { r.removeAttribute('data-sd-run-hidden'); });
    hiddenRows = new Set();
    hiddenRawNodes.forEach(function (node) { restoreHiddenRawNode(node); });
    hiddenRawNodes = new Set();
    hostEls.forEach(function (h) { h.removeAttribute('data-sd-run-host'); });
    hostEls = new Set();
    cards.forEach(function (c) { c.remove(); });
    cards = new Set();
    document.documentElement.classList.remove('sd-run-card-visible');
  }

  function disabled() {
    try { return window.localStorage.getItem('sd_run_off') === '1'; } catch (_) { return false; }
  }

  var scanTimer = null;
  function scheduleScan(soon) {
    if (scanTimer) return;
    scanTimer = setTimeout(function () { scanTimer = null; try { scan(); } catch (e) { console.warn('[SD run]', e); } }, soon ? 16 : SCAN_MS);
  }
  var tickTimer = null;
  function tickSoon() {
    if (tickTimer) return;
    tickTimer = setTimeout(function () { tickTimer = null; scheduleScan(true); }, 1000);
  }

  function ours(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('.sd-run-card, #sd-run-sheet'));
  }

  // ── The drawer ─────────────────────────────────────────────────────────────

  var drawer = null;   // { el, body, info, hist, loading }

  function openDrawer(info) {
    closeDrawer(true);
    var wrap = document.createElement('div');
    wrap.id = 'sd-run-sheet';
    var panel = document.createElement('div');
    panel.className = 'sd-run-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = '<div class="sd-run-ph"><div class="sd-run-pt"><h3></h3><p></p></div>' +
      '<button type="button" class="sd-run-close" aria-label="' + esc(t('Close', 'বন্ধ')) + '"></button></div>' +
      '<div class="sd-run-pb"></div>';
    wrap.appendChild(panel);
    wrap.addEventListener('click', function (ev) {
      if (ev.target === wrap || (ev.target.closest && ev.target.closest('.sd-run-close'))) closeDrawer();
    });
    document.body.appendChild(wrap);
    drawer = { el: wrap, body: panel.querySelector('.sd-run-pb'), info: info, hist: null, loading: true };
    renderDrawer();
    loadHistory(drawer);
  }

  function closeDrawer(now) {
    if (!drawer) return;
    var el = drawer.el;
    drawer = null;
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function loadHistory(d) {
    var api = window.__sdAgent;
    if (!api || typeof api.history !== 'function' || typeof api._parseTags !== 'function') { d.loading = false; renderDrawer(); return; }
    Promise.resolve().then(function () { return api.history(); }).then(function (msgs) {
      if (drawer !== d) return;
      if (msgs) {
        var hr = historyRuns(msgs, { messageText: api.messageText, parseTags: api._parseTags, tagArgs: api._tagArgs });
        d.hist = matchRun(hr, d.info.userText, d.info.fromEnd);
      }
      d.loading = false;
      renderDrawer();
    }, function () { if (drawer === d) { d.loading = false; renderDrawer(); } });
  }

  /** Refresh an open drawer with the newest card data (live runs). */
  function refreshDrawer() {
    if (!drawer) return;
    var c = null;
    cards.forEach(function (x) { if (x.__sdInfo && drawer.info && x.__sdInfo.key && x.__sdInfo.key === drawer.info.key) c = x; });
    if (!c) return;
    var wasRunning = drawer.info.running;
    drawer.info = c.__sdInfo;
    if (wasRunning && !drawer.info.running) { drawer.loading = true; loadHistory(drawer); }
    renderDrawer();
  }

  /**
   * Timeline for the drawer: [{ note } | { step }]. History supplies exact
   * inputs, outputs and notes; live/remembered data adds timings and status.
   */
  function timeline(info, hist) {
    var items = [];
    var timed = info.steps || [];
    var k = 0;
    var take = function (tool) {
      var s = timed[k];
      if (s && (!tool || !s.tool || s.tool === tool)) { k++; return s; }
      return null;
    };
    if (hist) {
      var turns = hist.turns;
      for (var i = 0; i < turns.length; i++) {
        var tn = turns[i];
        var isFinal = i === turns.length - 1 && !tn.calls.length;
        if (tn.note && !isFinal) items.push({ note: tn.note });
        tn.calls.forEach(function (c) {
          var s = take(c.tool) || {};
          var res = c.result;
          items.push({ step: {
            tool: c.tool || s.tool, server: c.server || s.server, call: callSummary(c.tool, c.args) || s.call || '',
            input: cap(JSON.stringify(c.args || {}, null, 2), MAX_IN),
            output: s.output || (res ? cap(res.content, MAX_OUT) : ''),
            ok: res ? !res.error : s.ok != null ? s.ok : null,
            stopped: !!s.stopped, saved: s.saved || null, ms: stepMs(s),
          } });
        });
      }
    }
    for (; k < timed.length; k++) {
      var s2 = timed[k];
      items.push({ step: { tool: s2.tool, server: s2.server, call: s2.call, input: s2.input || '', output: s2.output || '',
        ok: s2.ok, stopped: !!s2.stopped, saved: s2.saved || null, ms: stepMs(s2) } });
    }
    return items;
  }

  function renderDrawer() {
    if (!drawer) return;
    var info = drawer.info;
    var items = timeline(info, drawer.hist);
    var steps = items.filter(function (x) { return x.step; });
    var n = Math.max(steps.length, info.count);
    var servers = {};
    steps.forEach(function (x) { servers[serverLabel(x.step.server)] = 1; });
    var sub = [n === 1 ? t('1 step', '১টি ধাপ') : t(n + ' steps', num(n) + 'টি ধাপ')];
    if (info.t0 && (info.t1 > info.t0 || info.running)) sub.push(fmtDur((info.running ? Date.now() : info.t1) - info.t0));
    var sv = Object.keys(servers);
    if (sv.length) sub.push(sv.join(', '));
    var fails = steps.filter(function (x) { return x.step.ok === false && !x.step.stopped; }).length;
    if (fails) sub.push(t(fails + ' failed', num(fails) + 'টি ব্যর্থ'));
    var el = drawer.el;
    el.querySelector('.sd-run-pt h3').textContent = info.running ? t('Working…', 'কাজ চলছে…') : t('Activity', 'কার্যক্রম');
    el.querySelector('.sd-run-pt p').textContent = sub.join(' · ');

    // Keep open <details> open across refreshes.
    var open = {};
    var old = drawer.body.querySelectorAll('details[open]');
    for (var i = 0; i < old.length; i++) open[old[i].getAttribute('data-i')] = 1;
    var si = 0;
    var html = items.map(function (x) {
      if (x.note) return '<p class="sd-run-note">' + esc(x.note) + '</p>';
      var s = x.step;
      var idx = si++;
      var ic = s.stopped ? 'stop' : s.ok === true ? 'ok' : s.ok === false ? 'err' : 'run';
      var ms = s.ms != null ? fmtDur(s.ms) : '';
      return '<details class="sd-run-step" data-i="' + idx + '"' + (open[idx] ? ' open' : '') + '><summary>' +
        '<span class="sd-run-si" data-s="' + ic + '"></span><b>' + esc(s.tool) + '</b><span class="sd-run-call">' + esc(s.call) + '</span>' +
        (ms ? '<em>' + esc(ms) + '</em>' : '') + '</summary><div class="sd-run-sd">' +
        '<div class="sd-run-kv">' + esc(t('Where', 'কোথায়')) + ': <span>' + esc(serverLabel(s.server)) + '</span></div>' +
        '<div class="sd-run-lb">' + esc(t('Input', 'ইনপুট')) + '</div><pre>' + esc(s.input || s.call || '—') + '</pre>' +
        '<div class="sd-run-lb">' + esc(s.ok === false ? t('Error', 'ত্রুটি') : t('Output', 'আউটপুট')) + '</div><pre>' +
        esc(s.output || (s.ok == null && !s.stopped ? t('Running…', 'চলছে…') : s.stopped ? t('Stopped by you.', 'আপনি থামিয়েছেন।') : '—')) + '</pre>' +
        (s.saved ? '<div class="sd-run-kv">' + esc(t('Full output saved at', 'পূর্ণ আউটপুট সেভ আছে')) + ': <code>' + esc(s.saved) + '</code></div>' : '') +
        '</div></details>';
    }).join('');
    if (drawer.loading) html += '<p class="sd-run-hint">' + esc(t('Loading details…', 'বিস্তারিত আনা হচ্ছে…')) + '</p>';
    else if (!items.length) html += '<p class="sd-run-hint">' + esc(t('No details were recorded for this run.', 'এই কাজের কোনো বিস্তারিত পাওয়া যায়নি।')) + '</p>';
    if (drawer.body.__sdHtml !== html) { drawer.body.innerHTML = html; drawer.body.__sdHtml = html; }
  }

  // ── Style ──────────────────────────────────────────────────────────────────

  var CSS = [
    '[data-sd-run-hidden]{display:none!important}',
    '[data-sd-run-raw-hidden]{display:none!important}',
    '[data-sd-run-host] .bds-mcp-loading{display:none!important}',
    'html.sd-run-card-visible #sd-agent-chip{display:none!important}',
    '.sd-run-card{margin:10px 0 4px;padding:10px 12px;border-radius:14px;border:1px solid var(--bds-border,rgba(127,127,127,.25));',
    'background:var(--bds-bg-panel,transparent);color:var(--bds-text-primary,inherit);font:14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;',
    'cursor:pointer;-webkit-tap-highlight-color:transparent;max-width:100%;box-sizing:border-box;user-select:none}',
    '.sd-run-card:active{background:var(--bds-bg-hover,rgba(127,127,127,.1))}',
    '.sd-run-card:focus-visible{outline:2px solid var(--bds-accent,#5b7bff);outline-offset:2px}',
    '.sd-run-head{display:flex;align-items:center;gap:8px;min-height:24px}',
    '.sd-run-title{font-weight:600;white-space:nowrap}',
    '.sd-run-meta{color:var(--bds-text-secondary,#8e8ea0);font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '.sd-run-chev{flex:none;width:7px;height:7px;border:solid var(--bds-text-secondary,#8e8ea0);border-width:0 2px 2px 0;transform:rotate(-45deg);margin:0 4px 0 2px}',
    '.sd-run-ic,.sd-run-si{flex:none;position:relative;width:14px;height:14px;border-radius:50%;box-sizing:border-box}',
    '.sd-run-ic[data-s="running"],.sd-run-si[data-s="run"]{border:2px solid var(--bds-border,rgba(127,127,127,.3));border-top-color:var(--bds-accent,#5b7bff);animation:sd-run-spin .9s linear infinite}',
    '.sd-run-ic[data-s="done"],.sd-run-si[data-s="ok"]{background:#22c55e}',
    '.sd-run-ic[data-s="done"]::after,.sd-run-si[data-s="ok"]::after{content:"";position:absolute;left:4.5px;top:2px;width:3px;height:6px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}',
    '.sd-run-si[data-s="err"]{background:var(--bds-danger,#ef4444)}',
    '.sd-run-si[data-s="err"]::after{content:"!";position:absolute;inset:0;color:#fff;font:700 10px/14px system-ui,sans-serif;text-align:center}',
    '.sd-run-ic[data-s="stopped"],.sd-run-si[data-s="stop"]{border-radius:3px;width:11px;height:11px;margin:1.5px;background:var(--bds-text-secondary,#8e8ea0)}',
    '@keyframes sd-run-spin{to{transform:rotate(360deg)}}',
    '.sd-run-stop{flex:none;display:flex;align-items:center;gap:6px;border:0;border-radius:999px;padding:6px 11px;',
    'background:var(--bds-bg-hover,rgba(127,127,127,.14));color:var(--bds-text-primary,inherit);font:600 12px/1 system-ui,sans-serif;cursor:pointer}',
    '.sd-run-stop i{width:8px;height:8px;border-radius:2px;background:var(--bds-danger,#ef4444);display:block}',
    '.sd-run-now{display:flex;gap:8px;align-items:baseline;margin:8px 0 0;padding:7px 9px;border-radius:9px;background:var(--bds-bg-elevated,rgba(127,127,127,.08));',
    'font:12.5px/1.35 ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;min-width:0}',
    '.sd-run-now b,.sd-run-last b,.sd-run-step summary b{flex:none;font-weight:600}',
    '.sd-run-now span:not(.sd-run-si),.sd-run-last li span:not(.sd-run-si),.sd-run-call{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bds-text-secondary,#8e8ea0)}',
    '.sd-run-last{list-style:none;margin:6px 0 0;padding:0}',
    '.sd-run-last li{display:flex;align-items:center;gap:8px;padding:3px 2px;font:12.5px/1.35 ui-monospace,Menlo,Consolas,monospace;min-width:0}',
    '.sd-run-last li span:not(.sd-run-si){flex:1}',
    '.sd-run-last em,.sd-run-step summary em{flex:none;font-style:normal;color:var(--bds-text-tertiary,#8e8ea0);font-size:11.5px}',
    '#sd-run-sheet{position:fixed;inset:0;z-index:2147482999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45);animation:sd-run-fade .2s ease}',
    '#sd-run-sheet .sd-run-panel{width:100%;max-width:680px;max-height:86vh;display:flex;flex-direction:column;box-sizing:border-box;',
    'border-radius:18px 18px 0 0;background:var(--bds-bg-panel,#1e1f23);color:var(--bds-text-primary,#ececec);',
    'border:1px solid var(--bds-border,#3a3b3f);border-bottom:0;box-shadow:var(--bds-shadow,0 12px 40px rgba(0,0,0,.4));',
    'padding-bottom:env(safe-area-inset-bottom,0px);font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;animation:sd-run-rise .3s cubic-bezier(.16,1,.3,1)}',
    '#sd-run-sheet .sd-run-panel::before{content:"";display:block;flex:none;width:40px;height:4px;border-radius:999px;background:var(--bds-border-hover,rgba(127,127,127,.4));margin:8px auto 2px}',
    '.sd-run-ph{display:flex;align-items:flex-start;gap:12px;padding:8px 16px 10px;border-bottom:1px solid var(--bds-border,rgba(127,127,127,.2))}',
    '.sd-run-pt{flex:1;min-width:0}.sd-run-pt h3{margin:0;font-size:16px;font-weight:600}',
    '.sd-run-pt p{margin:2px 0 0;color:var(--bds-text-secondary,#8e8ea0);font-size:13px}',
    '.sd-run-close{flex:none;position:relative;width:32px;height:32px;border:0;border-radius:50%;background:var(--bds-bg-hover,rgba(127,127,127,.14));cursor:pointer}',
    '.sd-run-close::before,.sd-run-close::after{content:"";position:absolute;left:9px;top:15px;width:14px;height:2px;border-radius:1px;background:var(--bds-text-primary,#ececec);transform:rotate(45deg)}',
    '.sd-run-close::after{transform:rotate(-45deg)}',
    '.sd-run-pb{overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:8px 12px 16px}',
    '.sd-run-note{margin:10px 4px 4px;color:var(--bds-text-secondary,#8e8ea0);font-size:13px;white-space:pre-wrap;word-break:break-word}',
    '.sd-run-step{border-radius:10px;margin:2px 0}',
    '.sd-run-step[open]{background:var(--bds-bg-elevated,rgba(127,127,127,.08))}',
    '.sd-run-step summary{display:flex;align-items:center;gap:8px;padding:8px 6px;list-style:none;cursor:pointer;font:13px/1.35 ui-monospace,Menlo,Consolas,monospace;min-width:0}',
    '.sd-run-step summary::-webkit-details-marker{display:none}',
    '.sd-run-call{flex:1}',
    '.sd-run-sd{padding:0 8px 10px}',
    '.sd-run-kv{font-size:12px;color:var(--bds-text-secondary,#8e8ea0);margin:2px 0 6px;word-break:break-all}',
    '.sd-run-kv span,.sd-run-kv code{color:var(--bds-text-primary,inherit)}',
    '.sd-run-lb{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--bds-text-secondary,#8e8ea0);margin:8px 0 4px}',
    '.sd-run-sd pre{margin:0;max-height:38vh;overflow:auto;padding:8px 10px;border-radius:8px;background:var(--bds-bg-input,rgba(0,0,0,.25));',
    'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;user-select:text}',
    '.sd-run-hint{margin:14px 6px;color:var(--bds-text-secondary,#8e8ea0);font-size:13px;text-align:center}',
    '@keyframes sd-run-rise{from{transform:translate3d(0,100%,0)}to{transform:none}}',
    '@keyframes sd-run-fade{from{opacity:0}to{opacity:1}}',
    '@media (prefers-reduced-motion:reduce){#sd-run-sheet,#sd-run-sheet .sd-run-panel,.sd-run-ic,.sd-run-si{animation:none!important}}',
  ].join('\n');

  function installCss() {
    if (document.getElementById('sd-run-css')) return;
    var st = document.createElement('style');
    st.id = 'sd-run-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  function start() {
    installCss();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          if (!ours(records[i].target)) { scheduleScan(false); return; }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    // The page is a single-page app: a chat switch changes the URL only.
    setInterval(function () {
      syncHref();
      if (anyRunning) scheduleScan(false);
    }, 1000);
    scheduleScan(true);
  }

  window.__sdRunEvent = onEvent;
  window.__sdRun = {
    version: 1,
    rescan: function () { scheduleScan(true); },
    setEnabled: function (on) {
      try { if (on) window.localStorage.removeItem('sd_run_off'); else window.localStorage.setItem('sd_run_off', '1'); } catch (_) {}
      scheduleScan(true);
    },
    // Exposed for tests.
    _groupRuns: groupRuns,
    _historyRuns: historyRuns,
    _branch: branch,
    _matchRun: matchRun,
    _parseResults: parseResults,
    _rawCallCount: rawCallCount,
    _findRawCallSpans: findRawCallSpans,
    _protocolText: protocolText,
    _hideRawCallBlocks: hideRawCallBlocks,
    _restoreHiddenRawNode: restoreHiddenRawNode,
    _isProtocolResultText: isProtocolResultText,
    _isAutoUserText: isAutoUserText,
    _isAutoUserEl: isAutoUser,
    _classifyMessage: classifyMessage,
    _stripTags: stripTags,
    _callSummary: callSummary,
    _fmtDur: fmtDur,
    _timeline: timeline,
    _cardHtml: cardHtml,
    _syncHref: syncHref,
    _live: function () { return live; },
  };

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
