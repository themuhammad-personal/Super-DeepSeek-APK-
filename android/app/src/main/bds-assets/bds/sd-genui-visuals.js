/* Super DeepSeek — structured visuals for tool / MCP results.
 *
 * Turns a JSON tool result into one of four presentations — table, chart,
 * cards (record), json (raw) — by building an sds-ui spec and handing it to
 * the existing validated schema renderer (sd-genui.js). No HTML strings, no
 * execution; untrusted values only ever become text nodes.
 */
(function (root) {
  'use strict';
  if (root.__sdGenUIVisuals) return;
  var MAX_ROWS = 20, MAX_COLS = 6, MAX_POINTS = 24, MAX_CARDS = 12;

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function scalar(v) { return v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0; }
  function text(v, n) {
    var s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    n = n || 160;
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
  function humanize(k) { return text(String(k).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), 40); }

  /** Unwraps an MCP CallToolResult ({content:[…], structuredContent, isError}). */
  function unwrap(result) {
    var r = result, error = false, images = [], notes = [];
    if (isObj(r) && (Array.isArray(r.content) || r.structuredContent !== undefined)) {
      error = r.isError === true;
      if (r.structuredContent !== undefined) {
        (r.content || []).forEach(function (c) { if (c && c.type === 'image') images.push(c); });
        return { value: r.structuredContent, error: error, images: images, notes: notes };
      }
      var texts = [];
      r.content.forEach(function (c) {
        if (!c || typeof c !== 'object') return;
        if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
        else if (c.type === 'image') images.push(c);
        else if (c.type === 'resource' && c.resource && typeof c.resource.text === 'string') texts.push(c.resource.text);
        else if (c.type === 'resource_link' && c.uri) notes.push('Resource: ' + text(c.uri, 200));
      });
      var joined = texts.join('\n').trim();
      var parsed = joined;
      if (/^[\[{]/.test(joined)) { try { parsed = JSON.parse(joined); } catch (_) { parsed = joined; } }
      return { value: parsed, error: error, images: images, notes: notes };
    }
    return { value: r, error: false, images: images, notes: notes };
  }

  function rowsOf(v) {
    if (Array.isArray(v) && v.length && v.every(isObj)) return v;
    if (isObj(v)) {
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) {
        var x = v[keys[i]];
        if (Array.isArray(x) && x.length && x.every(isObj)) return x;
      }
    }
    return null;
  }
  function columnsOf(rows) {
    var cols = [];
    rows.slice(0, 50).forEach(function (r) { Object.keys(r).forEach(function (k) { if (cols.indexOf(k) < 0 && cols.length < MAX_COLS) cols.push(k); }); });
    return cols;
  }
  /** Picks a label column + numeric columns for charting. */
  function chartShape(rows, cols) {
    var label = null, numeric = [];
    cols.forEach(function (c) {
      var vals = rows.map(function (r) { return r[c]; });
      if (vals.every(isNum)) numeric.push(c);
      else if (!label && vals.every(function (x) { return typeof x === 'string' || isNum(x); })) label = c;
    });
    if (!numeric.length || rows.length < 2) return null;
    return { label: label, numeric: numeric.slice(0, 2) };
  }

  function infer(value, requested) {
    var rows = rowsOf(value);
    if (requested && requested !== 'auto') return requested;
    if (Array.isArray(value) && value.length > 1 && value.every(isNum)) return 'chart';
    if (isObj(value) && Object.keys(value).some(function (k) { return scalar(value[k]); })) return 'cards';
    if (rows) return 'table';
    if (isObj(value)) return 'cards';
    return 'json';
  }

  /** Returns {spec, view, csv:{columns,rows}|null, error, images, notes, value}. */
  function plan(result, opts) {
    opts = opts || {};
    var u = unwrap(result), value = u.value, view = infer(value, opts.view), components = [], csv = null;
    var title = opts.title || (opts.name ? humanize(opts.name) : 'Tool result');
    if (u.error) components.push({ type: 'callout', tone: 'danger', title: 'The tool reported an error', text: text(typeof value === 'string' ? value : JSON.stringify(value), 600), icon: 'alert-triangle' });
    var rows = rowsOf(value);

    if (view === 'chart') {
      var data = [];
      if (Array.isArray(value) && value.every(isNum)) data = value.slice(0, MAX_POINTS).map(function (n, i) { return { label: String(i + 1), value: n }; });
      else if (rows) {
        var cols = columnsOf(rows), shape = chartShape(rows, cols);
        if (shape) data = rows.slice(0, MAX_POINTS).map(function (r, i) { return { label: text(shape.label ? r[shape.label] : i + 1, 24), value: r[shape.numeric[0]] }; });
        if (shape) components.push({ type: 'text', text: humanize(shape.numeric[0]) + (shape.label ? ' by ' + humanize(shape.label) : ''), tone: 'secondary' });
      } else if (isObj(value)) {
        Object.keys(value).forEach(function (k) { if (isNum(value[k]) && data.length < MAX_POINTS) data.push({ label: humanize(k), value: value[k] }); });
      }
      if (data.length >= 2) components.push({ type: 'chart', kind: data.length > 8 ? 'line' : 'bar', title: title, data: data });
      else view = rows ? 'table' : isObj(value) ? 'cards' : 'json';
    }

    if (view === 'table' || (view === 'chart' && rows)) {
      if (rows) {
        var c2 = columnsOf(rows);
        csv = { columns: c2, rows: rows.map(function (r) { return c2.map(function (c) { return r[c]; }); }) };
        components.push({ type: 'table', columns: c2.map(humanize), rows: rows.slice(0, MAX_ROWS).map(function (r) { return c2.map(function (c) { return text(r[c], 80); }); }) });
        if (rows.length > MAX_ROWS) components.push({ type: 'text', text: 'Showing ' + MAX_ROWS + ' of ' + rows.length + ' rows. Export CSV for all rows.', tone: 'secondary' });
        if (view === 'table') {
          var shape2 = chartShape(rows.slice(0, MAX_POINTS), c2);
          if (shape2 && rows.length >= 3) components.push({ type: 'chart', kind: rows.length > 8 ? 'line' : 'bar', title: humanize(shape2.numeric[0]), data: rows.slice(0, MAX_POINTS).map(function (r, i) { return { label: text(shape2.label ? r[shape2.label] : i + 1, 24), value: r[shape2.numeric[0]] }; }) });
        }
      } else view = isObj(value) ? 'cards' : 'json';
    }

    if (view === 'cards') {
      if (isObj(value)) {
        var keys = Object.keys(value), shown = 0;
        keys.forEach(function (k) {
          var v = value[k];
          if (shown >= MAX_CARDS) return;
          if (scalar(v)) { components.push({ type: 'stat', label: humanize(k), value: isNum(v) ? v : text(v, 60), span: 'half' }); shown++; }
        });
        var nestedRows = rowsOf(value);
        if (nestedRows && !rows) rows = nestedRows;
        if (nestedRows) {
          var c3 = columnsOf(nestedRows);
          csv = { columns: c3, rows: nestedRows.map(function (r) { return c3.map(function (c) { return r[c]; }); }) };
          components.push({ type: 'table', columns: c3.map(humanize), rows: nestedRows.slice(0, MAX_ROWS).map(function (r) { return c3.map(function (c) { return text(r[c], 80); }); }) });
          var shape3 = chartShape(nestedRows.slice(0, MAX_POINTS), c3);
          if (shape3 && nestedRows.length >= 3) components.push({ type: 'chart', kind: nestedRows.length > 8 ? 'line' : 'bar', title: humanize(shape3.numeric[0]), data: nestedRows.slice(0, MAX_POINTS).map(function (r, i) { return { label: text(shape3.label ? r[shape3.label] : i + 1, 24), value: r[shape3.numeric[0]] }; }) });
        }
        if (!shown && !nestedRows) view = 'json';
      } else view = 'json';
    }

    if (view === 'json' && !components.some(function (c) { return c.type === 'callout'; })) {
      components.push({ type: 'text', text: text(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 2400) });
    }
    u.notes.forEach(function (n) { components.push({ type: 'text', text: n, tone: 'secondary' }); });
    var spec = { version: 1, theme: 'editorial', layout: view === 'cards' ? 'dashboard' : 'stack', accent: u.error ? 'rose' : 'blue', components: components.slice(0, 40) };
    return { spec: spec, view: view, csv: csv, error: u.error, images: u.images, value: value };
  }

  /** Renders into a container element. Returns the plan (for export). */
  function render(target, result, opts) {
    var G = root.__sdGenUI, p = plan(result, opts);
    if (!G) throw Error('Renderer unavailable');
    var parsed = G.parseSpec(p.spec);
    if (!parsed.ok) throw Error(parsed.error);
    var surface = G.renderSpec(parsed.spec);
    surface.classList.add('sd-genui-tool-visual');
    surface.setAttribute('data-view', p.view);
    target.appendChild(surface);
    if (G.updateSurface && surface.__sdGenUIScope) G.updateSurface(surface.__sdGenUIScope);
    // MCP image content: only data: images with a raster MIME type are shown.
    p.images.slice(0, 4).forEach(function (img) {
      if (!img || typeof img.data !== 'string' || !/^image\/(png|jpeg|gif|webp)$/.test(img.mimeType || '') || img.data.length > 800000) return;
      var el = root.document.createElement('img');
      el.className = 'sd-genui-tool-image'; el.alt = 'Tool image'; el.loading = 'lazy';
      el.src = 'data:' + img.mimeType + ';base64,' + img.data.replace(/[^A-Za-z0-9+/=]/g, '');
      target.appendChild(el);
    });
    return p;
  }

  root.__sdGenUIVisuals = { version: 1, unwrap: unwrap, plan: plan, render: render, views: ['auto', 'table', 'chart', 'cards', 'json'] };
})(typeof window !== 'undefined' ? window : globalThis);
