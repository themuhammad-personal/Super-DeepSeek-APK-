/* Super DeepSeek — Generative UI settings sheet (contextual, not navigation).
 * Opened from an artifact's More menu or the existing "Linux & Agent" settings
 * page. Holds the kill switch, injection frequency, prompt modules, fallback
 * renderer, selector overrides, diagnostics and the execution ledger.
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIPanel) return;
  var doc = root.document;
  function bn() {
    try { return /^bn/i.test((doc.documentElement.lang || '') + '') || /^bn/i.test(root.navigator.language || ''); } catch (_) { return false; }
  }
  function t(en, b) { return bn() ? b : en; }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function P() { return root.__sdGenUIPrompt; }
  function H() { return root.__sdGenUIHost; }

  function close() { var p = doc.getElementById('sd-genui-panel'); if (p) p.remove(); }
  function row(list, title, sub, control) {
    var r = el('label', 'sd-p-row'), tx = el('span', 'sd-p-txt');
    tx.append(el('span', 'sd-p-title', title));
    if (sub) tx.append(el('span', 'sd-p-sub', sub));
    r.append(tx, control); list.appendChild(r); return r;
  }
  function toggle(checked, onChange) {
    var c = doc.createElement('input'); c.type = 'checkbox'; c.checked = !!checked; c.setAttribute('role', 'switch');
    c.addEventListener('change', function () { onChange(c.checked); });
    return c;
  }
  function section(sheet, title) { sheet.appendChild(el('div', 'sd-p-sec', title)); var l = el('div', 'sd-p-list'); sheet.appendChild(l); return l; }
  function btn(bar, label, fn, primary) { var b = el('button', 'sd-p-btn' + (primary ? ' sd-p-primary' : ''), label); b.type = 'button'; b.addEventListener('click', fn); bar.appendChild(b); return b; }
  function time(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }

  function open() {
    if (!P() || !H()) return false;
    close();
    var cfg = P().getConfig();
    var overlay = el('div'); overlay.id = 'sd-genui-panel';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Generative UI settings');
    var sheet = el('div', 'sd-p-sheet');
    overlay.appendChild(sheet);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    sheet.append(el('div', 'sd-p-grab'), el('h2', '', t('Generative UI', 'জেনারেটিভ UI')),
      el('p', 'sd-p-lead', t('Visual answers, artifacts and tool views rendered safely inside chat. Generated code never touches your session or native features.',
        'চ্যাটের ভেতরে নিরাপদে ভিজুয়াল উত্তর, আর্টিফ্যাক্ট ও টুল ভিউ। জেনারেট করা কোড আপনার সেশন বা নেটিভ ফিচার ছুঁতে পারে না।')));
    function set(patch) { cfg = P().setConfig(patch); }

    var main = section(sheet, t('General', 'সাধারণ'));
    row(main, t('Generative UI', 'জেনারেটিভ UI'), t('Master switch. Off restores plain code blocks everywhere.', 'মূল সুইচ। বন্ধ করলে সব জায়গায় সাধারণ কোড ব্লক দেখাবে।'), toggle(cfg.enabled, function (v) { set({ enabled: v }); }));
    row(main, t('Render raw HTML / SVG', 'সাধারণ HTML / SVG রেন্ডার'), t('Complete ```html documents become artifacts and ```svg drawings show inline.', 'সম্পূর্ণ ```html ডকুমেন্ট আর্টিফ্যাক্ট হবে এবং ```svg ছবি ইনলাইনে দেখাবে।'), toggle(cfg.fallbackRenderer, function (v) { set({ fallbackRenderer: v }); }));

    var inj = section(sheet, t('Hidden design guidance', 'লুকানো ডিজাইন নির্দেশনা'));
    row(inj, t('Add guidance to requests', 'অনুরোধে নির্দেশনা যোগ'), t('Never shown in your message bubble.', 'আপনার মেসেজ বাবলে কখনো দেখাবে না।'), toggle(cfg.inject, function (v) { set({ inject: v }); }));
    var freq = doc.createElement('select');
    [['auto', t('Auto — visual requests only', 'অটো — শুধু ভিজুয়াল অনুরোধে')], ['always', t('Every message', 'প্রতিটি মেসেজে')], ['every_n', t('Every N messages', 'প্রতি N মেসেজে')], ['first', t('First message only', 'শুধু প্রথম মেসেজে')], ['off', t('Off', 'বন্ধ')]].forEach(function (o) {
      var op = doc.createElement('option'); op.value = o[0]; op.textContent = o[1]; if (cfg.frequency === o[0]) op.selected = true; freq.appendChild(op);
    });
    freq.addEventListener('change', function () { set({ frequency: freq.value }); });
    row(inj, t('Frequency', 'কত ঘন ঘন'), '', freq);
    var n = doc.createElement('input'); n.type = 'number'; n.min = '2'; n.max = '20'; n.value = String(cfg.interval);
    n.addEventListener('change', function () { set({ interval: Number(n.value) }); n.value = String(cfg.interval); });
    row(inj, t('N (for every N)', 'N (প্রতি N-এর জন্য)'), '', n);
    var names = { visual: t('Inline visuals (diagrams, charts, explainers)', 'ইনলাইন ভিজুয়াল (ডায়াগ্রাম, চার্ট, ব্যাখ্যা)'), schema: t('Widgets (charts, tables, calculators)', 'উইজেট (চার্ট, টেবিল, ক্যালকুলেটর)'), apps: t('Artifacts (apps, documents, code)', 'আর্টিফ্যাক্ট (অ্যাপ, ডকুমেন্ট, কোড)'), svg: t('Illustrations (SVG)', 'ইলাস্ট্রেশন (SVG)'), mcp: t('MCP / tool result views', 'MCP / টুল ফলাফল ভিউ') };
    Object.keys(names).forEach(function (m) {
      row(inj, names[m], '', toggle(cfg.modules[m], function (v) { var mods = {}; mods[m] = v; set({ modules: mods }); }));
    });

    var Vw = root.__sdGenUIViewer;
    if (Vw) {
      var lib = section(sheet, t('Artifacts', 'আর্টিফ্যাক্ট'));
      var recs = Vw.store.list().slice(0, 20);
      if (!recs.length) lib.appendChild(el('p', 'sd-p-lead', t('Artifacts you create appear here.', 'আপনার তৈরি আর্টিফ্যাক্ট এখানে দেখাবে।')));
      recs.forEach(function (r) {
        var last = r.versions[r.versions.length - 1], info = Vw.describe(last.kind, last.payload);
        var item = el('div', 'sd-p-row sd-p-art'), tx = el('span', 'sd-p-txt');
        tx.append(el('span', 'sd-p-title', last.title || r.id), el('span', 'sd-p-sub', info.label + ' · ' + info.short + (r.versions.length > 1 ? ' · ' + r.versions.length + t(' versions', ' ভার্সন') : '')));
        var openB = el('button', 'sd-p-btn', t('Open', 'খুলুন')); openB.type = 'button';
        openB.addEventListener('click', function () { close(); Vw.open({ key: r.key }); });
        var del = Vw.iconButton('x', t('Delete', 'মুছুন'), function () { Vw.store.remove(r.key); item.remove(); });
        item.append(tx, openB, del); lib.appendChild(item);
      });
    }

    var Fr = root.__sdGenUIFrame;
    if (Fr && Fr.web) {
      var net = section(sheet, t('Web access from visuals', 'ভিজুয়াল থেকে ওয়েব অ্যাক্সেস'));
      var hosts = Object.keys(Fr.web.grants()).sort();
      net.appendChild(el('p', 'sd-p-lead', hosts.length
        ? t('Visuals may load public data from these sites without asking. No cookies or logins are ever sent; private network addresses are always blocked.', 'ভিজুয়াল এই সাইটগুলো থেকে জিজ্ঞাসা ছাড়াই পাবলিক তথ্য আনতে পারে। কুকি বা লগইন কখনো পাঠানো হয় না; প্রাইভেট নেটওয়ার্ক সবসময় ব্লক।')
        : t('When a visual wants live data from a website, you will be asked once per site.', 'কোনো ভিজুয়াল ওয়েবসাইট থেকে লাইভ তথ্য চাইলে প্রতি সাইটে একবার জিজ্ঞাসা করা হবে।')));
      hosts.forEach(function (h) { var item = el('div', 'sd-p-row sd-p-art'), tx = el('span', 'sd-p-txt'); tx.append(el('span', 'sd-p-title', h)); item.append(tx); net.appendChild(item); });
      if (hosts.length) { var nb = el('div', 'sd-p-btns'); btn(nb, t('Forget all sites', 'সব সাইট ভুলে যান'), function () { Fr.web.revokeAll(); net.querySelectorAll('.sd-p-art').forEach(function (n) { n.remove(); }); nb.remove(); }); net.appendChild(nb); }
    }

    var adv = section(sheet, t('Page adapter', 'পেজ অ্যাডাপ্টার'));
    ['message', 'markdown', 'composer'].forEach(function (k) {
      var i = doc.createElement('input'); i.type = 'text'; i.value = cfg.selectors[k]; i.spellcheck = false; i.setAttribute('aria-label', k + ' selector');
      i.addEventListener('change', function () { var s = {}; s[k] = i.value; set({ selectors: s }); i.value = cfg.selectors[k]; });
      row(adv, k.charAt(0).toUpperCase() + k.slice(1), t('CSS selector used to find it on the page', 'পেজে খুঁজতে ব্যবহৃত CSS সিলেক্টর'), i);
    });
    var tools = el('div', 'sd-p-btns'), out = el('pre', 'sd-p-out');
    btn(tools, t('Run diagnostics', 'ডায়াগনস্টিক চালান'), function () { out.textContent = JSON.stringify(H().diagnose(), null, 2); }, true);
    btn(tools, t('Copy report', 'রিপোর্ট কপি'), function () {
      var text = H().redact(JSON.stringify(H().diagnose(), null, 2)).text;
      if (root.navigator.clipboard) root.navigator.clipboard.writeText(text).catch(function () {});
      out.textContent = text;
    });
    btn(tools, t('Reset defaults', 'ডিফল্টে ফেরত'), function () { cfg = P().resetConfig(); open(); });
    sheet.append(tools, out);

    sheet.appendChild(el('div', 'sd-p-sec', t('Activity', 'কার্যক্রম')));
    var log = el('div', 'sd-p-log');
    function drawLog() {
      log.textContent = '';
      var items = H().ledger.list().slice(0, 30);
      if (!items.length) log.appendChild(el('p', 'sd-p-lead', t('No activity yet.', 'এখনো কোনো কার্যক্রম নেই।')));
      items.forEach(function (it) {
        var r = el('div', 'sd-p-log-item'), d = el('span', 'sd-p-dot'); d.setAttribute('data-state', it.state);
        var tx = el('span', 'sd-p-log-t', it.type + ' · ' + it.title + (it.detail ? ' — ' + it.detail : ''));
        tx.title = tx.textContent;
        r.append(d, tx, el('span', 'sd-p-log-time', time(it.startedAt)));
        log.appendChild(r);
      });
    }
    drawLog();
    var lbar = el('div', 'sd-p-btns');
    btn(lbar, t('Export log', 'লগ এক্সপোর্ট'), function () { H().exportText(H().ledger.exportJson(), 'application/json', 'genui-activity.json'); });
    btn(lbar, t('Clear log', 'লগ মুছুন'), function () { H().ledger.clear(); drawLog(); });
    btn(lbar, t('Close', 'বন্ধ'), close, true);
    sheet.append(log, lbar);
    doc.body.appendChild(overlay);
    try { sheet.querySelector('input,select,button').focus(); } catch (_) {}
    return true;
  }
  doc && doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  var back = root.__sdHandleBack;
  root.__sdHandleBack = function () {
    if (doc.getElementById('sd-genui-panel')) { close(); return true; }
    return typeof back === 'function' ? back.apply(this, arguments) : false;
  };
  root.__sdGenUIPanel = { open: open, close: close };
})(window);
