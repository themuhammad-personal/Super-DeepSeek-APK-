/* Super DeepSeek — MCP Apps host (spec io.modelcontextprotocol/ui, 2026-01-26).
 *
 * When a tool the chat calls declares `_meta.ui.resourceUri`, its UI resource
 * (text/html;profile=mcp-app) is read natively and rendered inline under the
 * tool call — the ChatGPT apps pattern — in a sandboxed opaque-origin frame
 * with the resource's declared CSP only. This page is the host: it speaks the
 * View ⇄ Host JSON-RPC dialect over postMessage, forwards tools/call and
 * resources/read to the same server (with in-page consent for tool calls) and
 * never hands credentials to the View (keys stay native).
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIMcp && root.__sdGenUIMcp.version === 1) return;
  var doc = root.document;
  var PROTOCOL = '2026-01-26', MIME = 'text/html;profile=mcp-app';
  function H() { return root.__sdGenUIHost || null; }
  function F() { return root.__sdGenUIFrame || null; }
  function V() { return root.__sdGenUIViewer || null; }
  function bn() { try { return (doc.documentElement.lang || root.navigator.language || '').toLowerCase().indexOf('bn') === 0; } catch (_) { return false; } }
  function t(en, b) { return bn() ? b : en; }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function hostOf(u) { try { return new URL(u).host; } catch (_) { return String(u || '').slice(0, 60); } }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /* ---------------- tool registry (from the page's own tools/list) ---------------- */
  var tools = Object.create(null);     // serverUrl -> { name -> tool }
  var resources = Object.create(null); // serverUrl|uri -> Promise<{ok,text,meta}>
  function uiOf(tool) {
    var m = tool && tool._meta;
    if (!m || typeof m !== 'object') return null;
    var ui = m.ui && typeof m.ui === 'object' ? m.ui : null;
    var uri = (ui && ui.resourceUri) || m['ui/resourceUri'] || m['openai/outputTemplate'];
    if (typeof uri !== 'string' || !/^ui:\/\//.test(uri) || uri.length > 900) return null;
    return { resourceUri: uri, visibility: visOf(tool), openai: !(ui && ui.resourceUri) && !m['ui/resourceUri'] && !!m['openai/outputTemplate'] };
  }
  function visOf(tool) {
    var m = tool && tool._meta, ui = m && m.ui && typeof m.ui === 'object' ? m.ui : null;
    return ui && Array.isArray(ui.visibility) ? ui.visibility.filter(function (v) { return typeof v === 'string'; }) : null;
  }
  /** Spec: a tool whose visibility is ["app"] exists for its UI only and is hidden from the model. */
  function appOnly(tool) { var v = visOf(tool); return !!(v && v.length && v.indexOf('model') < 0); }
  /** Calls a View may make without asking: tools built for the UI (app-only) and
   *  tools the server marks read-only and non-destructive. Anything else asks once. */
  function autoAllowed(tool) {
    var a = tool && tool.annotations;
    if (appOnly(tool)) return !(a && a.destructiveHint === true && a.readOnlyHint !== true);
    if (a && a.readOnlyHint === true && a.destructiveHint !== true) return true;
    var m = tool && tool._meta;
    return !!(m && m['openai/widgetAccessible'] === true && a && a.readOnlyHint === true);
  }
  var GRANTS_KEY = 'sd_mcp_app_grants_v1';
  function grants() { try { var g = JSON.parse(root.localStorage.getItem(GRANTS_KEY) || '{}'); return g && typeof g === 'object' ? g : {}; } catch (_) { return {}; } }
  function grant(serverUrl, name) { try { var g = grants(); g[hostOf(serverUrl) + '|' + name] = Date.now(); var k = Object.keys(g); if (k.length > 300) delete g[k[0]]; root.localStorage.setItem(GRANTS_KEY, JSON.stringify(g)); } catch (_) {} }
  function granted(serverUrl, name) { return !!grants()[hostOf(serverUrl) + '|' + name]; }
  function remember(serverUrl, list, fromStore) {
    if (!serverUrl || !Array.isArray(list)) return;
    var map = tools[serverUrl] = Object.create(null);
    list.slice(0, 400).forEach(function (tl) { if (tl && typeof tl.name === 'string') map[tl.name] = tl; });
    if (!fromStore) setTimeout(saveRegistry, 0);
  }
  function toolFor(serverUrl, name) { var m = tools[serverUrl]; return m ? m[name] || null : null; }
  function known(serverUrl) { return !!tools[serverUrl]; }

  var rawFetch = null;
  function call(payload) {
    var f = rawFetch || root.__sdBridgeFetch;
    if (typeof f !== 'function') return Promise.resolve({ ok: false, error: 'Native bridge unavailable' });
    return Promise.resolve(f(payload)).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }
  function readResource(serverUrl, uri) {
    var k = serverUrl + '|' + uri;
    if (!resources[k]) {
      resources[k] = call({ type: 'bds-mcp-read-resource', serverUrl: serverUrl, resourceUri: uri }).then(function (r) {
        if (!r || !r.ok) { delete resources[k]; }
        return r || { ok: false, error: 'No response' };
      });
    }
    return resources[k];
  }

  function install() {
    var inner = root.__sdBridgeFetch;
    if (typeof inner !== 'function' || inner.__sdMcpWrapped) return false;
    rawFetch = inner;
    var wrapped = function (payload) {
      var p = inner(payload);
      if (!payload || typeof payload !== 'object') return p;
      if (payload.type === 'bds-mcp-list-tools') {
        return Promise.resolve(p).then(function (r) {
          try {
            if (r && r.ok && Array.isArray(r.tools)) {
              remember(String(payload.serverUrl || ''), r.tools);
              if (!payload.__sdAll) { var shown = r.tools.filter(function (tl) { return !appOnly(tl); }); if (shown.length !== r.tools.length) r = Object.assign({}, r, { tools: shown }); }
            }
          } catch (_) {}
          return r;
        });
      }
      if (payload.type === 'bds-mcp-call' && !payload.__sdFromApp) {
        return Promise.resolve(p).then(function (r) {
          try { onToolResult(String(payload.serverUrl || ''), String(payload.toolName || ''), payload.args || {}, r); } catch (e) { try { console.warn('[SDS mcp]', e); } catch (_) {} }
          return r;
        });
      }
      return p;
    };
    wrapped.__sdMcpWrapped = true;
    wrapped.__sdAgentWrapped = inner.__sdAgentWrapped;
    root.__sdBridgeFetch = wrapped;
    return true;
  }

  /* ---------------- anchoring in the chat ---------------- */
  function anchorFor(toolName) {
    var cards = doc.querySelectorAll('.bds-mcp-loading');
    for (var i = cards.length - 1; i >= 0; i--) {
      var tt = cards[i].querySelector('.bds-mcp-loading-title');
      if (tt && toolName && tt.textContent.indexOf(toolName) >= 0) return cards[i];
    }
    if (cards.length) return cards[cards.length - 1];
    var msgs = doc.querySelectorAll((H() && H().config().selectors.message) || '.ds-message');
    var last = msgs[msgs.length - 1];
    if (last) { var md = last.querySelector((H() && H().config().selectors.markdown) || '.ds-markdown'); return { into: md || last }; }
    return null;
  }
  function place(node, anchor) {
    if (!anchor) return false;
    if (anchor.into) { anchor.into.appendChild(node); return true; }
    if (!anchor.parentNode) return false;
    anchor.parentNode.insertBefore(node, anchor.nextSibling);
    return true;
  }

  function onToolResult(serverUrl, toolName, args, reply) {
    var Ho = H(); if (!Ho || !Ho.config().enabled) return;
    var known0 = toolFor(serverUrl, toolName);
    var resultUi = reply && reply.ok ? uiOf(reply.result) : null;
    if ((!known0 || known0.inputSchema === undefined) && !resultUi) {
      // No (fresh) definition in this session: fetch the list once, then decide.
      ensureTool(serverUrl, toolName).then(function () { showToolResult(serverUrl, toolName, args, reply); });
      return;
    }
    showToolResult(serverUrl, toolName, args, reply);
  }
  function showToolResult(serverUrl, toolName, args, reply) {
    var tool = toolFor(serverUrl, toolName), ui = uiOf(tool);
    // Spec: the tool definition declares the UI. Some deployed servers (MCP-UI era)
    // only put `_meta.ui.resourceUri` on the CallToolResult; accept that too. The
    // resource is still read natively from the same server and must be ui://.
    if (!ui && reply && reply.ok) ui = uiOf(reply.result);
    if (!ui) return;
    var result = reply && reply.ok ? reply.result : { isError: true, content: [{ type: 'text', text: String(reply && reply.error || 'Tool call failed') }] };
    var info = tool || { name: toolName };
    var title = (info.title || (info.annotations && info.annotations.title) || info.name);
    var app = mount({ serverUrl: serverUrl, resourceUri: ui.resourceUri, tool: info, args: args, result: result, title: title, openai: ui.openai });
    if (!place(app.el, anchorFor(toolName))) return;
    app.anchorTool = toolName;
    app.start();
    var ck = chatKey();
    if (ck) {
      var rs = ''; try { rs = JSON.stringify(result); } catch (_) {}
      app.key = ck + '|' + toolName + '|' + Date.now();
      saveView({ key: app.key, chat: ck, msg: messageIndexOf(app.el), server: serverUrl, uri: ui.resourceUri, toolName: toolName, title: title, openai: ui.openai,
        tool: { name: info.name, title: info.title, description: clip(info.description, 600) }, args: args, result: rs.length <= VIEW_RESULT_MAX ? result : { content: [{ type: 'text', text: 'Result too large to keep.' }] }, at: Date.now() });
    }
  }

  /* ---------------- OpenAI Apps SDK compatibility ----------------
   * Servers written for ChatGPT apps serve `text/html+skybridge` templates that
   * talk to `window.openai` instead of the MCP Apps postMessage dialect. This
   * shim provides that object inside the frame and maps it onto the same
   * host methods (tools/call with consent, ui/message, ui/open-link,
   * ui/request-display-mode). Injected only for such templates: apps that
   * support both protocols would otherwise pick the shim over MCP Apps. */
  function openaiShim(g) {
    var id = 0, pending = {}, globals = g || {};
    function rq(method, params) {
      return new Promise(function (res, rej) {
        var i = 'oai' + (++id); pending[i] = { res: res, rej: rej };
        parent.postMessage({ jsonrpc: '2.0', id: i, method: method, params: params || {} }, '*');
      });
    }
    var api = {
      callTool: function (name, args) { return rq('tools/call', { name: String(name), arguments: args || {} }); },
      sendFollowUpMessage: function (o) { return rq('ui/message', { role: 'user', content: [{ type: 'text', text: String(o && o.prompt || '') }] }); },
      openExternal: function (o) { return rq('ui/open-link', { url: String(o && o.href || '') }); },
      requestDisplayMode: function (o) { return rq('ui/request-display-mode', { mode: String(o && o.mode || 'inline') }); },
      setWidgetState: function (st) { api.widgetState = st; parent.postMessage({ jsonrpc: '2.0', method: 'openai/setWidgetState', params: { state: st } }, '*'); return Promise.resolve(); },
      requestClose: function () { return rq('ui/request-display-mode', { mode: 'inline' }); },
      notifyIntrinsicHeight: function () {}
    };
    function apply(n) { for (var k in n) if (Object.prototype.hasOwnProperty.call(n, k)) api[k] = n[k]; }
    apply(globals);
    window.openai = api;
    window.addEventListener('message', function (e) {
      if (e.source !== parent) return;
      var m = e.data; if (!m || m.jsonrpc !== '2.0') return;
      if (m.id && pending[m.id] && !m.method) { var q = pending[m.id]; delete pending[m.id]; if (m.error) q.rej(new Error(m.error.message || 'Error')); else q.res(m.result); return; }
      if (m.method === 'openai/set_globals' && m.params && m.params.globals) {
        apply(m.params.globals);
        try { window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: m.params.globals } })); } catch (_) {}
      }
    });
  }

  /* ---------------- registry persistence ----------------
   * content.js lists a server's tools when it needs them, not necessarily in
   * this page session. A tool call can therefore arrive before any tools/list
   * reply was seen; the registry is persisted (UI-relevant fields only) and
   * refreshed on demand. */
  var REG_KEY = 'sd_mcp_tool_registry_v1';
  function saveRegistry() {
    try {
      var out = {};
      Object.keys(tools).slice(-12).forEach(function (srv) {
        out[srv] = Object.keys(tools[srv]).slice(0, 200).map(function (n) {
          var tl = tools[srv][n]; return { name: tl.name, title: tl.title, description: clip(tl.description, 400), annotations: tl.annotations, _meta: tl._meta, inputSchema: undefined };
        });
      });
      var s = JSON.stringify(out); if (s.length < 400000) root.localStorage.setItem(REG_KEY, s);
    } catch (_) {}
  }
  function loadRegistry() {
    try { var r = JSON.parse(root.localStorage.getItem(REG_KEY) || '{}'); Object.keys(r).forEach(function (srv) { if (!tools[srv] && Array.isArray(r[srv])) remember(srv, r[srv], true); }); } catch (_) {}
  }
  function ensureTool(serverUrl, name) {
    var tl = toolFor(serverUrl, name);
    if (tl && tl.inputSchema !== undefined) return Promise.resolve(tl);
    return call({ type: 'bds-mcp-list-tools', serverUrl: serverUrl, __sdAll: true }).then(function (r) {
      if (r && r.ok && Array.isArray(r.tools)) remember(serverUrl, r.tools);
      return toolFor(serverUrl, name) || tl;
    });
  }

  /* ---------------- views across chat revisits ----------------
   * Revisiting a chat does not call the tool again, so the result each view
   * was mounted with is kept per chat and the view is restored next to the
   * tool's result card (or at the message it was shown in). */
  var VIEWS_KEY = 'sd_mcp_views_v1', VIEW_RESULT_MAX = 300000;
  function chatKey() { try { var m = root.location.pathname.match(/\/(?:a\/chat\/s|chat\/s|s)\/([A-Za-z0-9_-]{6,80})/); return m ? m[1] : ''; } catch (_) { return ''; } }
  function loadViews() { try { var v = JSON.parse(root.localStorage.getItem(VIEWS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
  function saveView(rec) {
    try {
      var list = loadViews().filter(function (x) { return x.key !== rec.key; });
      list.push(rec);
      while (list.length > 60 || JSON.stringify(list).length > 1500000) list.shift();
      root.localStorage.setItem(VIEWS_KEY, JSON.stringify(list));
    } catch (_) {}
  }
  function messageIndexOf(node) {
    var sel = (H() && H().config().selectors.message) || '.ds-message', msgs = doc.querySelectorAll(sel);
    for (var i = 0; i < msgs.length; i++) if (msgs[i].contains(node)) return i;
    return msgs.length - 1;
  }
  var restoring = false;
  function restoreViews() {
    var ck = chatKey(); if (!ck || restoring) return;
    var mine = loadViews().filter(function (v) { return v.chat === ck; });
    if (!mine.length) return;
    var sel = (H() && H().config().selectors.message) || '.ds-message', msgs = doc.querySelectorAll(sel);
    if (!msgs.length) return;
    restoring = true;
    try {
      mine.forEach(function (v) {
        if (apps.some(function (a) { return a.key === v.key; })) return;
        var msg = msgs[Math.min(v.msg, msgs.length - 1)]; if (!msg || v.msg >= msgs.length) return;
        var md = msg.querySelector((H() && H().config().selectors.markdown) || '.ds-markdown') || msg;
        var app = mount({ serverUrl: v.server, resourceUri: v.uri, tool: v.tool || { name: v.toolName }, args: v.args || {}, result: v.result, title: v.title, openai: v.openai, restored: true });
        app.key = v.key;
        var card = null, cards = msg.querySelectorAll('.bds-mcp-loading, .bds-mcp-result-card');
        for (var i = cards.length - 1; i >= 0; i--) if (cards[i].textContent.indexOf(v.toolName) >= 0) { card = cards[i]; break; }
        if (card && card.parentNode) card.parentNode.insertBefore(app.el, card.nextSibling); else md.appendChild(app.el);
        ensureTool(v.server, v.toolName).then(function () { app.start(); });
      });
    } finally { restoring = false; }
  }
  var lastChat = '';
  setInterval(function () { var ck = chatKey(); if (ck !== lastChat) { lastChat = ck; setTimeout(restoreViews, 900); setTimeout(restoreViews, 3000); } }, 700);

  /* ---------------- app view ---------------- */
  var apps = [];
  function mount(o) {
    var Fr = F(), Vw = V();
    var wrap = el('div', 'sd-mcp');
    wrap.setAttribute('data-sd-owned', 'mcp');
    var head = el('div', 'sd-mcp-head');
    var badge = el('span', 'sd-mcp-badge'); if (Vw) badge.appendChild(Vw.icon('plug', 14));
    var name = el('span', 'sd-mcp-name', o.title || t('MCP app', 'MCP অ্যাপ'));
    var host = el('span', 'sd-mcp-host', hostOf(o.serverUrl));
    var spacer = el('span', 'sd-mcp-spacer');
    head.append(badge, name, host, spacer);
    var stage = el('div', 'sd-mcp-stage sd-vis-loading');
    var note = el('div', 'sd-vis-note'); note.hidden = true;
    wrap.append(head, stage, note);
    var app = { el: wrap, o: o, ctrl: null, initialized: false, granted: Object.create(null), mode: 'inline', modelContext: null, sends: [] };
    apps.push(app);

    function showNote(ic, text, actions) {
      note.textContent = ''; note.hidden = false;
      if (Vw) note.appendChild(Vw.icon(ic, 15));
      note.appendChild(el('span', 'sd-vis-note-text', text));
      (actions || []).forEach(function (a) {
        var b = el('button', 'sd-chip' + (a.primary ? ' sd-chip-primary' : ''), a.label); b.type = 'button';
        b.addEventListener('click', function (e) { note.hidden = true; a.fn(e); });
        note.appendChild(b);
      });
      if (!actions || !actions.length) { if (Vw) note.appendChild(Vw.iconButton('x', t('Dismiss', 'বন্ধ'), function () { note.hidden = true; }, 'sd-ib-sm')); }
    }
    function fail(msg) {
      stage.classList.remove('sd-vis-loading');
      stage.textContent = '';
      var box = el('div', 'sd-mcp-error');
      if (Vw) box.appendChild(Vw.icon('alert', 16));
      box.appendChild(el('span', null, msg));
      var retry = el('button', 'sd-chip', t('Retry', 'আবার চেষ্টা')); retry.type = 'button';
      retry.addEventListener('click', function () { delete resources[o.serverUrl + '|' + o.resourceUri]; app.start(); });
      box.appendChild(retry);
      stage.appendChild(box);
    }
    function setMode(mode) {
      app.mode = mode === 'fullscreen' ? 'fullscreen' : 'inline';
      // CSS-only switch: moving the iframe would reload the View.
      wrap.classList.toggle('sd-mcp-full', app.mode === 'fullscreen');
      doc.documentElement.classList.toggle('sd-viewer-open', app.mode === 'fullscreen');
      if (app.ctrl) {
        app.ctrl.frame.style.height = app.mode === 'fullscreen' ? '' : (app.height || 320) + 'px';
        if (app.initialized) notify('ui/notifications/host-context-changed', { displayMode: app.mode, containerDimensions: dims() });
        pushGlobals({ displayMode: app.mode, maxHeight: app.mode === 'fullscreen' ? root.innerHeight : 1800 });
      }
      fullBtn.replaceChildren(Vw ? Vw.icon(app.mode === 'fullscreen' ? 'x' : 'expand', 16) : doc.createTextNode('⤢'));
      fullBtn.title = app.mode === 'fullscreen' ? t('Exit full screen', 'ফুল স্ক্রিন থেকে বের হোন') : t('Full screen', 'ফুল স্ক্রিন');
      fullBtn.setAttribute('aria-label', fullBtn.title);
    }
    var fullBtn = Vw ? Vw.iconButton('expand', t('Full screen', 'ফুল স্ক্রিন'), function () { setMode(app.mode === 'fullscreen' ? 'inline' : 'fullscreen'); }) : el('button');
    var reloadBtn = Vw ? Vw.iconButton('refresh', t('Reload', 'রিলোড'), function () { app.start(); }) : el('button');
    head.append(reloadBtn, fullBtn);

    function dims() {
      var w = 0; try { w = Math.round(stage.getBoundingClientRect().width); } catch (_) {}
      return app.mode === 'fullscreen' ? { width: root.innerWidth, height: root.innerHeight } : { width: w || undefined, maxHeight: 1800 };
    }
    function context() {
      var Frm = F();
      return {
        toolInfo: o.tool ? { tool: { name: o.tool.name, title: o.tool.title, description: clip(o.tool.description, 2000), inputSchema: o.tool.inputSchema } } : undefined,
        theme: Frm ? Frm.theme() : 'light',
        displayMode: app.mode,
        availableDisplayModes: ['inline', 'fullscreen'],
        containerDimensions: dims(),
        locale: (root.navigator && root.navigator.language) || 'en',
        timeZone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return undefined; } })(),
        platform: 'mobile',
        deviceCapabilities: { touch: true, hover: false },
        userAgent: 'Super DeepSeek'
      };
    }
    function openaiGlobals() {
      var Frm = F(), res = o.result && typeof o.result === 'object' ? o.result : {};
      return {
        toolInput: o.args || {}, toolOutput: res.structuredContent !== undefined ? res.structuredContent : null, toolResponseMetadata: res._meta || null,
        widgetState: app.widgetState || null, theme: Frm ? Frm.theme() : 'light', displayMode: app.mode, maxHeight: app.mode === 'fullscreen' ? root.innerHeight : 1800,
        locale: (root.navigator && root.navigator.language) || 'en', safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
        userAgent: { device: { type: 'mobile' }, capabilities: { hover: false, touch: true } }
      };
    }
    function pushGlobals(part) { if (app.openai && app.ctrl) app.ctrl.postRpc({ jsonrpc: '2.0', method: 'openai/set_globals', params: { globals: part } }); }
    function reply(id, result) { if (app.ctrl) app.ctrl.postRpc({ jsonrpc: '2.0', id: id, result: result || {} }); }
    function error(id, code, message) { if (app.ctrl) app.ctrl.postRpc({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }
    function notify(method, params) { if (app.ctrl && app.initialized) app.ctrl.postRpc({ jsonrpc: '2.0', method: method, params: params || {} }); }

    function consentTool(name, args, tl) {
      return new Promise(function (ok) {
        if (app.granted[name] || autoAllowed(tl) || granted(o.serverUrl, name)) return ok(true);
        showNote('plug', t('This app wants to run “', 'এই অ্যাপ চালাতে চায় “') + name + '” ' + clip(JSON.stringify(args || {}), 120), [
          { label: t('Allow', 'অনুমতি দিন'), primary: true, fn: function () { app.granted[name] = true; ok(true); } },
          { label: t('Always allow', 'সবসময় অনুমতি'), fn: function () { app.granted[name] = true; grant(o.serverUrl, name); ok(true); } },
          { label: t('Deny', 'না'), fn: function () { ok(false); } }
        ]);
      });
    }
    function onRpc(m) {
      if (!m || typeof m !== 'object') return;
      var id = m.id, method = typeof m.method === 'string' ? m.method : '', params = m.params && typeof m.params === 'object' ? m.params : {};
      var hasId = id !== undefined && id !== null && (typeof id === 'string' || typeof id === 'number') && String(id).length <= 80;
      if (!method) return; // responses to host requests are not used
      switch (method) {
        case 'ui/initialize':
          if (!hasId) return;
          reply(id, {
            protocolVersion: PROTOCOL,
            hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, message: { text: {} }, updateModelContext: { text: {} }, sandbox: { csp: app.csp || {} } },
            hostInfo: { name: 'Super DeepSeek', version: '2.60' },
            hostContext: context()
          });
          return;
        case 'ui/notifications/initialized':
          if (app.initialized) return;
          app.initialized = true;
          notify('ui/notifications/tool-input', { arguments: o.args || {} });
          if (o.result !== undefined) notify('ui/notifications/tool-result', o.result);
          return;
        case 'ping': if (hasId) reply(id, {}); return;
        case 'ui/notifications/size-changed': {
          var h = Number(params.height);
          if (app.mode === 'inline' && isFinite(h) && h > 0) { app.height = Math.max(60, Math.min(1800, Math.round(h))); app.ctrl.frame.style.height = app.height + 'px'; stage.classList.remove('sd-vis-loading'); }
          return;
        }
        case 'ui/request-display-mode':
          if (!hasId) return;
          setMode(params.mode === 'fullscreen' ? 'fullscreen' : 'inline');
          reply(id, { mode: app.mode });
          return;
        case 'ui/open-link': {
          if (!hasId) return;
          var u; try { u = new URL(String(params.url || '')); } catch (_) { error(id, -32602, 'Invalid URL'); return; }
          if (u.protocol !== 'https:' && u.protocol !== 'http:') { error(id, -32602, 'Only http(s) links'); return; }
          showNote('share', t('Open link: ', 'লিংক খুলুন: ') + u.host, [
            { label: t('Open', 'খুলুন'), primary: true, fn: function () { try { root.open(u.href, '_blank', 'noopener'); } catch (_) {} reply(id, {}); } },
            { label: t('Cancel', 'বাতিল'), fn: function () { error(id, -32000, 'User declined'); } }
          ]);
          return;
        }
        case 'ui/message': {
          if (!hasId) return;
          var c = params.content, text = '';
          if (Array.isArray(c)) c.forEach(function (x) { if (x && x.type === 'text') text += (text ? '\n' : '') + String(x.text || ''); });
          else if (c && c.type === 'text') text = String(c.text || '');
          text = text.slice(0, 4000);
          if (!text.trim()) { error(id, -32602, 'Empty message'); return; }
          var Ho = H(), tapped = Date.now() - (app.ctrl.lastTap || 0) < 4000, now = Date.now();
          app.sends = app.sends.filter(function (x) { return now - x < 60000; });
          var send = function (ev) {
            var r = Ho ? Ho.sendPrompt(text, { label: 'From MCP app', submit: true, event: ev, frameTap: !ev }) : { ok: false, error: 'Unavailable' };
            if (r.ok) reply(id, {}); else { error(id, -32000, r.error); showNote('alert', r.error); }
          };
          if (tapped && app.sends.length < 4) { app.sends.push(now); send(null); }
          else showNote('send', t('Send to chat: ', 'চ্যাটে পাঠাবেন: ') + '“' + clip(text, 90) + '”', [
            { label: t('Send', 'পাঠান'), primary: true, fn: function (e) { send(e); } },
            { label: t('Cancel', 'বাতিল'), fn: function () { error(id, -32000, 'User declined'); } }
          ]);
          return;
        }
        case 'openai/setWidgetState':
          try { var ws = JSON.stringify(params.state); if (ws && ws.length < 60000) app.widgetState = params.state; } catch (_) {}
          return;
        case 'ui/update-model-context':
          app.modelContext = params;
          if (hasId) reply(id, {});
          return;
        case 'notifications/message':
          try { console.info('[MCP app]', clip(JSON.stringify(params), 400)); } catch (_) {}
          return;
        case 'tools/call': {
          if (!hasId) return;
          var nm = String(params.name || ''), targs = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
          var tl = toolFor(o.serverUrl, nm), vis = tl ? visOf(tl) : null;
          if (!tl) { error(id, -32602, 'Unknown tool'); return; }
          if (vis && vis.indexOf('app') < 0) { error(id, -32601, 'Tool is not available to apps'); return; }
          consentTool(nm, targs, tl).then(function (yes) {
            if (!yes) { error(id, -32000, 'User denied the tool call'); return; }
            var Ho = H(); var lid = Ho && Ho.ledger.record({ type: 'tool', title: nm, detail: hostOf(o.serverUrl) + ' · from app', state: 'running' });
            call({ type: 'bds-mcp-call', serverUrl: o.serverUrl, toolName: nm, args: targs, __sdFromApp: true }).then(function (r) {
              if (Ho && lid) Ho.ledger.update(lid, { state: r && r.ok ? 'done' : 'failed', endedAt: Date.now() });
              if (r && r.ok) reply(id, r.result || {}); else error(id, -32000, String(r && r.error || 'Tool call failed'));
            });
          });
          return;
        }
        case 'resources/read': {
          if (!hasId) return;
          var uri = String(params.uri || '');
          if (!/^ui:\/\//.test(uri)) { error(id, -32602, 'Only ui:// resources'); return; }
          readResource(o.serverUrl, uri).then(function (r) {
            if (r && r.ok) reply(id, { contents: [{ uri: uri, mimeType: r.mimeType, text: r.text, _meta: r.meta }] });
            else error(id, -32000, String(r && r.error || 'Read failed'));
          });
          return;
        }
        case 'resources/list': case 'tools/list':
          if (hasId) error(id, -32601, 'Not supported'); return;
        default:
          if (hasId) error(id, -32601, 'Method not found');
      }
    }

    app.start = function () {
      if (app.ctrl) { app.ctrl.destroy(); app.ctrl = null; }
      app.initialized = false; stage.textContent = ''; stage.classList.add('sd-vis-loading');
      if (!Fr) { fail(t('App renderer unavailable.', 'অ্যাপ রেন্ডারার পাওয়া যায়নি।')); return; }
      readResource(o.serverUrl, o.resourceUri).then(function (r) {
        if (!wrap.isConnected && !app.pendingMount) return;
        if (!r || !r.ok) { fail(t('Could not load the app: ', 'অ্যাপ লোড হয়নি: ') + clip(r && r.error || 'unknown error', 160)); return; }
        if (r.mimeType && r.mimeType.indexOf('text/html') !== 0) { fail(t('Unsupported app type: ', 'অসমর্থিত অ্যাপ টাইপ: ') + clip(r.mimeType, 60)); return; }
        var ui = (r.meta && r.meta.ui) || {};
        var csp = ui.csp || {};
        app.csp = { connectDomains: Fr.cleanDomains(csp.connectDomains), resourceDomains: Fr.cleanDomains(csp.resourceDomains) };
        wrap.classList.toggle('sd-mcp-bordered', ui.prefersBorder !== false);
        var ctrl = Fr.create({ kind: 'mcp', mode: 'inline', title: o.title, initialHeight: 320 });
        app.ctrl = ctrl; app.height = 320;
        ctrl.on('rpc', onRpc);
        ctrl.on('size', function (h) { app.height = h; stage.classList.remove('sd-vis-loading'); });
        ctrl.on('theme', function (th) { notify('ui/notifications/host-context-changed', { theme: th }); pushGlobals({ theme: th }); });
        ctrl.on('link', function (url) { onRpc({ jsonrpc: '2.0', id: '__link' + Date.now(), method: 'ui/open-link', params: { url: url } }); });
        ctrl.on('prompt', function (text) { onRpc({ jsonrpc: '2.0', id: '__msg' + Date.now(), method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: text }] } }); });
        stage.appendChild(ctrl.frame);
        app.openai = !!(o.openai || /skybridge/i.test(r.mimeType || ''));
        ctrl.load(r.text, { csp: app.csp, shim: app.openai ? '(' + openaiShim.toString() + ')(' + JSON.stringify(openaiGlobals()).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ');' : '' });
        setTimeout(function () { stage.classList.remove('sd-vis-loading'); }, 2500);
        var Ho = H(); if (Ho) Ho.ledger.record({ type: 'mcp-app', title: o.title, detail: hostOf(o.serverUrl) + ' · ' + o.resourceUri, state: 'rendered', endedAt: Date.now() });
      });
    };
    app.destroy = function () {
      try { if (app.initialized) notify('ui/resource-teardown', {}); } catch (_) {}
      if (app.ctrl) app.ctrl.destroy();
      wrap.remove();
      apps.splice(apps.indexOf(app), 1);
    };
    app.exitFull = function () { if (app.mode === 'fullscreen') { setMode('inline'); return true; } return false; };
    return app;
  }

  /** sds-genui kind: mcp-app (model-declared). Only servers the page already uses. */
  function mountDeclared(container, p) {
    var Vw = V();
    if (!p || !known(p.serverUrl)) {
      var n = el('div', 'sd-mcp-error');
      if (Vw) n.appendChild(Vw.icon('plug', 16));
      n.appendChild(el('span', null, t('MCP app from ', 'MCP অ্যাপ: ') + hostOf(p && p.serverUrl) + t(' — this server is not in your MCP settings (or was not used in this session yet), so it was not contacted.', ' — এই সার্ভার আপনার MCP সেটিংসে নেই (বা এই সেশনে ব্যবহার হয়নি), তাই যোগাযোগ করা হয়নি।')));
      container.appendChild(n);
      return null;
    }
    var app = mount({ serverUrl: p.serverUrl, resourceUri: p.resourceUri, title: p.title, args: {}, result: undefined });
    container.appendChild(app.el);
    app.start();
    return app;
  }

  // Re-attach app views a host re-render detached; close full screen on back.
  setInterval(function () {
    apps.slice().forEach(function (a) {
      if (a.el.isConnected) return;
      if (a.anchorTool !== undefined && place(a.el, anchorFor(a.anchorTool))) return;
      if (a.anchorTool !== undefined && !a.el.isConnected) { /* chat changed: drop */ a.destroy(); }
    });
  }, 1500);
  var prevBack = root.__sdHandleBack;
  root.__sdHandleBack = function () {
    for (var i = 0; i < apps.length; i++) if (apps[i].exitFull()) return true;
    return typeof prevBack === 'function' ? prevBack() : false;
  };

  loadRegistry();
  if (!install()) {
    var tries = 0, iv = setInterval(function () { if (install() || ++tries > 40) clearInterval(iv); }, 250);
  }

  root.__sdGenUIMcp = {
    version: 1, MIME: MIME, PROTOCOL: PROTOCOL,
    uiOf: uiOf, remember: remember, known: known, toolFor: toolFor,
    onToolResult: onToolResult, mountDeclared: mountDeclared, apps: function () { return apps.slice(); },
    appOnly: appOnly, autoAllowed: autoAllowed, openaiShim: openaiShim, restoreViews: restoreViews, chatKey: chatKey,
    _reset: function () { tools = Object.create(null); resources = Object.create(null); }
  };
})(window);
