(function (root) {
  'use strict';
  if (root.__sdGenUI && root.__sdGenUI.version === 1) return;

  var MAX_SPEC_CHARS = 25000;
  var MAX_COMPONENTS = 40;
  var MAX_TEXT = 2400;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var COLORS = ['#818cf8', '#2dd4bf', '#f59e0b', '#f472b6', '#60a5fa', '#a3e635', '#fb7185', '#c084fc'];

  var ICON_PATHS = {
    sparkles: ['M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z','M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z','M5 2l.5 1.5L7 4l-1.5.5L5 6l-.5-1.5L3 4l1.5-.5L5 2z'],
    'trending-up': ['M3 17l6-6 4 4 8-8','M15 7h6v6'],
    wallet: ['M4 6.5A2.5 2.5 0 0 1 6.5 4H20v14H6.5A2.5 2.5 0 0 1 4 15.5z','M4 7H2v10a3 3 0 0 0 3 3h15','M20 10h-4a2 2 0 0 0 0 4h4','M16 12h.01'],
    calendar: ['M8 2v4','M16 2v4','M3 9h18','M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z','M8 13h.01','M12 13h.01','M16 13h.01','M8 17h.01','M12 17h.01'],
    clock: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z','M12 6v6l4 2'],
    'shield-check': ['M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z','M9 12l2 2 4-4'],
    target: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z','M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0z','M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'],
    zap: ['M13 2L3 14h8l-1 8 11-13h-8z'],
    leaf: ['M20 4c-9 0-15 4-15 11a5 5 0 0 0 5 5c7 0 11-6 10-16z','M4 21c3-6 7-9 12-12'],
    rocket: ['M4.5 16.5c-1.5 1.3-2 4.5-2 4.5s3.2-.5 4.5-2','M9 15l-3-3c2-5 7-8 14-9 0 7-4 12-9 14l-2-2z','M14 10h.01','M5 10H2l3-5 5 0','M14 19v3l5-3v-5'],
    heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8z'],
    lightbulb: ['M9 18h6','M10 22h4','M8 14c-1.3-1-2-2.5-2-4a6 6 0 0 1 12 0c0 1.5-.7 3-2 4l-1 2h-6z'],
    users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2','M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z','M22 21v-2a4 4 0 0 0-3-3.9','M16 3.1a4 4 0 0 1 0 7.8'],
    'book-open': ['M12 7v14','M3 18V5a1 1 0 0 1 1-1h4a4 4 0 0 1 4 4 4 4 0 0 1 4-4h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-4a4 4 0 0 0-4 2 4 4 0 0 0-4-2H4a1 1 0 0 1-1-1z'],
    globe: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z','M2 12h20','M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z'],
    code: ['M8 17l-5-5 5-5','M16 7l5 5-5 5','M14 4l-4 16'],
    star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z'],
    lock: ['M5 11h14v10H5z','M8 11V7a4 4 0 0 1 8 0v4','M12 15v2'],
    activity: ['M22 12h-4l-3 8L9 4l-3 8H2'],
    'check-circle': ['M22 11.1V12a10 10 0 1 1-5.9-9.1','M22 4L12 14l-3-3'],
    info: ['M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z','M12 11v5','M12 7h.01'],
    'alert-triangle': ['M10.3 3.9L1.8 18.3A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.7L13.7 3.9a2 2 0 0 0-3.4 0z','M12 9v4','M12 17h.01'],
    compass: ['M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z','M16.2 7.8l-2.7 5.7-5.7 2.7 2.7-5.7z'],
    coffee: ['M4 8h13v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z','M17 10h2a2 2 0 1 1 0 4h-2','M2 22h20','M7 4l1 2','M12 3l1 3'],
    'graduation-cap': ['M2 10l10-5 10 5-10 5z','M6 12v5c4 3 8 3 12 0v-5','M22 10v6'],
    music: ['M9 18V5l12-2v13','M9 18a3 3 0 1 1-3-3c1.7 0 3 .8 3 3z','M21 16a3 3 0 1 1-3-3c1.7 0 3 .8 3 3z'],
    image: ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z','M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z','M22 15l-5-5L5 20']
  };
  var ACCENTS = ['violet', 'teal', 'amber', 'rose', 'blue', 'lime'];

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function cleanText(value, max) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/\u0000/g, '').slice(0, max || MAX_TEXT);
  }
  function numberInRange(value, fallback, min, max) {
    var number = Number(value);
    if (!Number.isFinite(number)) number = fallback;
    return Math.min(max, Math.max(min, number));
  }
  function choose(value, list, fallback) {
    return list.indexOf(value) >= 0 ? value : fallback;
  }
  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(value);
  }

  // A small arithmetic parser keeps model-authored formulas away from dynamic code execution.
  function tokenizeFormula(source) {
    var input = String(source || '');
    if (!input.trim() || input.length > 160) throw new Error('Empty or oversized formula');
    var tokens = [];
    var index = 0;
    while (index < input.length) {
      var remaining = input.slice(index);
      var whitespace = /^\s+/.exec(remaining);
      if (whitespace) { index += whitespace[0].length; continue; }
      var numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(remaining);
      if (numeric) {
        tokens.push({ type: 'number', value: Number(numeric[0]) });
        index += numeric[0].length;
        continue;
      }
      var name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(remaining);
      if (name) {
        tokens.push({ type: 'name', value: name[0] });
        index += name[0].length;
        continue;
      }
      var ch = input.charAt(index);
      if ('+-*/%^(),'.indexOf(ch) >= 0) {
        tokens.push({ type: 'symbol', value: ch });
        index++;
        continue;
      }
      throw new Error('Unsupported formula token');
    }
    return tokens;
  }

  function evaluateFormula(source, state) {
    var tokens = tokenizeFormula(source);
    var position = 0;
    state = isObject(state) ? state : {};
    function peek(value) {
      var token = tokens[position];
      return !!token && (value === undefined || token.value === value);
    }
    function take(value) {
      if (!peek(value)) throw new Error('Unexpected formula token');
      return tokens[position++];
    }
    function finite(value) {
      if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new Error('Formula result out of range');
      return value;
    }
    function expression() {
      var value = term();
      while (peek('+') || peek('-')) {
        var operator = tokens[position++].value;
        var right = term();
        value = finite(operator === '+' ? value + right : value - right);
      }
      return value;
    }
    function term() {
      var value = unary();
      while (peek('*') || peek('/') || peek('%')) {
        var operator = tokens[position++].value;
        var right = unary();
        if ((operator === '/' || operator === '%') && right === 0) throw new Error('Division by zero');
        value = finite(operator === '*' ? value * right : operator === '/' ? value / right : value % right);
      }
      return value;
    }
    function unary() {
      if (peek('+')) { position++; return unary(); }
      if (peek('-')) { position++; return finite(-unary()); }
      return power();
    }
    function power() {
      var value = primary();
      if (peek('^')) {
        position++;
        value = finite(Math.pow(value, unary()));
      }
      return value;
    }
    function primary() {
      if (peek('(')) {
        position++;
        var grouped = expression();
        take(')');
        return grouped;
      }
      var token = tokens[position++];
      if (!token) throw new Error('Missing formula value');
      if (token.type === 'number') return finite(token.value);
      if (token.type !== 'name') throw new Error('Expected formula value');
      if (peek('(')) {
        position++;
        var args = [];
        if (!peek(')')) {
          args.push(expression());
          while (peek(',')) { position++; args.push(expression()); }
        }
        take(')');
        var functions = {
          abs: function (a) { return Math.abs(a[0]); },
          ceil: function (a) { return Math.ceil(a[0]); },
          floor: function (a) { return Math.floor(a[0]); },
          max: function (a) { return Math.max.apply(Math, a); },
          min: function (a) { return Math.min.apply(Math, a); },
          pow: function (a) { return Math.pow(a[0], a[1]); },
          round: function (a) { return Math.round(a[0]); },
          sqrt: function (a) { return Math.sqrt(a[0]); }
        };
        if (!Object.prototype.hasOwnProperty.call(functions, token.value)) throw new Error('Function is not allowed');
        var validCount = token.value === 'min' || token.value === 'max' ? args.length >= 1 :
          token.value === 'pow' ? args.length === 2 : args.length === 1;
        if (!validCount) throw new Error('Wrong number of formula arguments');
        return finite(functions[token.value](args));
      }
      if (token.value === 'pi') return Math.PI;
      if (token.value === 'e') return Math.E;
      if (!Object.prototype.hasOwnProperty.call(state, token.value)) throw new Error('Unknown formula variable');
      var variable = state[token.value];
      if (typeof variable === 'boolean') return variable ? 1 : 0;
      if (typeof variable === 'number' && Number.isFinite(variable)) return finite(variable);
      if (typeof variable === 'string' && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(variable)) return finite(Number(variable));
      throw new Error('Formula variable is not numeric');
    }
    var result = expression();
    if (position !== tokens.length) throw new Error('Extra formula tokens');
    return finite(result);
  }

  function verifyFormula(source, state) {
    if (source === undefined || source === null || source === '') return;
    if (typeof source !== 'string') throw new Error('Formula must be text');
    evaluateFormula(source, state);
  }

  function sanitizeComponent(input, ids, defaultAccent) {
    if (!isObject(input)) throw new Error('Component must be an object');
    var type = cleanText(input.type, 32);
    var out = { type: type };
    out.span = choose(input.span, ['full', 'half'], 'auto');
    if (type === 'comparison') {
      out.title = cleanText(input.title, 140);
      if (!Array.isArray(input.items) || input.items.length < 2 || input.items.length > 3) throw new Error('Comparison needs 2–3 options');
      out.items = input.items.map(function (item) {
        if (!isObject(item)) throw new Error('Comparison option must be an object');
        return {
          eyebrow: cleanText(item.eyebrow, 80),
          title: cleanText(item.title || item.name, 140),
          description: cleanText(item.description || item.text, 240),
          price: typeof item.price === 'number' && Number.isFinite(item.price) ? item.price : cleanText(item.price, 120),
          period: cleanText(item.period, 80),
          badge: cleanText(item.badge, 100),
          highlighted: item.highlighted === true,
          features: Array.isArray(item.features) ? item.features.slice(0, 8).map(function (feature) { return cleanText(feature, 160); }) : []
        };
      });
    } else if (type === 'hero') {
      out.eyebrow = cleanText(input.eyebrow, 90);
      out.title = cleanText(input.title, 180);
      out.subtitle = cleanText(input.subtitle, 320);
      out.value = typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : cleanText(input.value, 160);
      out.formula = cleanText(input.formula, 160);
      out.format = choose(input.format, ['number', 'integer', 'currency', 'percent'], 'number');
      out.currency = /^[A-Z]{3}$/.test(input.currency || '') ? input.currency : 'USD';
      out.footnote = cleanText(input.footnote, 180);
      out.badge = cleanText(input.badge, 80);
      out.icon = choose(input.icon, Object.keys(ICON_PATHS), 'sparkles');
      out.accent = choose(input.accent, ACCENTS, defaultAccent || 'violet');
    } else if (type === 'callout') {
      out.tone = choose(input.tone, ['info', 'success', 'warning', 'danger', 'tip'], 'info');
      out.title = cleanText(input.title, 140);
      out.text = cleanText(input.text, 700);
      out.icon = choose(input.icon, Object.keys(ICON_PATHS), input.tone === 'warning' ? 'alert-triangle' : 'info');
    } else if (type === 'list') {
      out.title = cleanText(input.title, 140);
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 12) throw new Error('List needs 1–12 items');
      out.items = input.items.map(function (item) {
        if (typeof item === 'string') return { title: cleanText(item, 160), text: '', icon: 'check-circle' };
        if (!isObject(item)) throw new Error('List item must be text or an object');
        return { title: cleanText(item.title || item.label, 160), text: cleanText(item.text || item.description, 240), icon: choose(item.icon, Object.keys(ICON_PATHS), 'check-circle') };
      });
    } else if (type === 'steps') {
      out.title = cleanText(input.title, 140);
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 10) throw new Error('Steps needs 1–10 items');
      out.items = input.items.map(function (item) {
        if (!isObject(item)) throw new Error('Step must be an object');
        return { title: cleanText(item.title, 140), text: cleanText(item.text || item.description, 240), status: choose(item.status, ['done', 'active', 'upcoming'], 'upcoming') };
      });
    } else if (type === 'timeline') {
      out.title = cleanText(input.title, 140);
      if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 10) throw new Error('Timeline needs 1–10 events');
      out.events = input.events.map(function (event) {
        if (!isObject(event)) throw new Error('Timeline event must be an object');
        return { date: cleanText(event.date, 80), title: cleanText(event.title, 140), text: cleanText(event.text || event.description, 240), tone: choose(event.tone, ['neutral', 'info', 'success', 'warning'], 'neutral') };
      });
    } else if (type === 'quote') {
      out.text = cleanText(input.text || input.quote, 1000);
      out.attribution = cleanText(input.attribution, 140);
      out.role = cleanText(input.role, 160);
    } else if (type === 'icon') {
      out.name = choose(input.name, Object.keys(ICON_PATHS), 'sparkles');
      out.label = cleanText(input.label, 120);
      out.size = choose(input.size, ['sm', 'md', 'lg'], 'md');
      out.tone = choose(input.tone, ['neutral', 'info', 'success', 'warning', 'danger'], 'neutral');
    } else if (type === 'divider') {
      out.label = cleanText(input.label, 100);
    } else if (type === 'text') {
      out.text = cleanText(input.text, MAX_TEXT);
      out.tone = choose(input.tone, ['normal', 'secondary', 'strong'], 'normal');
    } else if (type === 'stat') {
      out.label = cleanText(input.label, 100);
      out.value = typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : cleanText(input.value, 180);
      out.formula = cleanText(input.formula, 160);
      out.format = choose(input.format, ['number', 'integer', 'currency', 'percent'], 'number');
      out.currency = /^[A-Z]{3}$/.test(input.currency || '') ? input.currency : 'USD';
      out.caption = cleanText(input.caption, 240);
    } else if (type === 'badge') {
      out.label = cleanText(input.label, 120);
      out.tone = choose(input.tone, ['neutral', 'info', 'success', 'warning', 'danger'], 'neutral');
    } else if (type === 'progress') {
      out.label = cleanText(input.label, 120);
      out.value = numberInRange(input.value, 0, 0, 1e12);
      out.formula = cleanText(input.formula, 160);
      out.max = numberInRange(input.max, 100, 0.000001, 1e12);
      out.format = choose(input.format, ['number', 'integer', 'currency', 'percent'], 'percent');
    } else if (type === 'slider') {
      out.id = input.id;
      if (!validId(out.id) || ids[out.id]) throw new Error('Control IDs must be unique identifiers');
      ids[out.id] = true;
      out.label = cleanText(input.label, 120);
      out.min = numberInRange(input.min, 0, -1e9, 1e9);
      out.max = numberInRange(input.max, 100, -1e9, 1e9);
      if (out.max <= out.min) throw new Error('Slider max must be greater than min');
      out.step = numberInRange(input.step, 1, 0.000001, Math.max(0.000001, out.max - out.min));
      out.value = numberInRange(input.value, out.min, out.min, out.max);
      out.format = choose(input.format, ['number', 'integer', 'currency', 'percent'], 'number');
      out.currency = /^[A-Z]{3}$/.test(input.currency || '') ? input.currency : 'USD';
    } else if (type === 'select') {
      out.id = input.id;
      if (!validId(out.id) || ids[out.id]) throw new Error('Control IDs must be unique identifiers');
      ids[out.id] = true;
      out.label = cleanText(input.label, 120);
      if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 20) throw new Error('Select needs 1–20 options');
      out.options = input.options.map(function (option) { return cleanText(option, 120); });
      if (out.options.some(function (option) { return !option; })) throw new Error('Select options cannot be empty');
      out.value = out.options.indexOf(cleanText(input.value, 120)) >= 0 ? cleanText(input.value, 120) : out.options[0];
    } else if (type === 'toggle') {
      out.id = input.id;
      if (!validId(out.id) || ids[out.id]) throw new Error('Control IDs must be unique identifiers');
      ids[out.id] = true;
      out.label = cleanText(input.label, 120);
      out.value = input.value === true;
    } else if (type === 'chart') {
      out.kind = choose(input.kind, ['bar', 'line', 'pie', 'donut'], 'bar');
      out.title = cleanText(input.title, 160);
      out.description = cleanText(input.description, 240);
      if (!Array.isArray(input.data) || input.data.length < 1 || input.data.length > 24) throw new Error('Chart needs 1–24 points');
      out.data = input.data.map(function (point) {
        if (!isObject(point)) throw new Error('Chart point must be an object');
        return {
          label: cleanText(point.label, 70) || 'Item',
          value: numberInRange(point.value, 0, -1e12, 1e12),
          formula: cleanText(point.formula, 160)
        };
      });
    } else if (type === 'table') {
      if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 8) throw new Error('Table needs 1–8 columns');
      out.columns = input.columns.map(function (column) { return cleanText(column, 80); });
      if (!Array.isArray(input.rows) || input.rows.length > 20) throw new Error('Table supports up to 20 rows');
      out.rows = input.rows.map(function (row) {
        if (!Array.isArray(row) || row.length > out.columns.length) throw new Error('Table row does not fit its columns');
        var cells = row.map(function (cell) { return cleanText(cell, 240); });
        while (cells.length < out.columns.length) cells.push('');
        return cells;
      });
    } else if (type === 'diagram') {
      out.title = cleanText(input.title, 140);
      out.description = cleanText(input.description, 240);
      if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 12) throw new Error('Diagram needs 2–12 nodes');
      var diagramIds = Object.create(null);
      var diagramPositions = Object.create(null);
      out.nodes = input.nodes.map(function (node, index) {
        if (!isObject(node)) throw new Error('Diagram node must be an object');
        var id = cleanText(node.id, 32);
        if (!validId(id) || diagramIds[id]) throw new Error('Diagram node IDs must be unique identifiers');
        diagramIds[id] = true;
        var column = Number.isFinite(Number(node.column)) ? Math.max(0, Math.min(3, Math.round(Number(node.column)))) : index % 4;
        var row = Number.isFinite(Number(node.row)) ? Math.max(0, Math.min(2, Math.round(Number(node.row)))) : Math.floor(index / 4);
        var position = column + ':' + row;
        if (diagramPositions[position]) {
          var found = false;
          for (var slot = 0; slot < 12; slot++) {
            var candidateColumn = slot % 4;
            var candidateRow = Math.floor(slot / 4);
            var candidatePosition = candidateColumn + ':' + candidateRow;
            if (!diagramPositions[candidatePosition]) {
              column = candidateColumn;
              row = candidateRow;
              position = candidatePosition;
              found = true;
              break;
            }
          }
          if (!found) throw new Error('Diagram nodes cannot overlap');
        }
        diagramPositions[position] = true;
        return {
          id: id,
          title: cleanText(node.title || node.label, 100),
          text: cleanText(node.text || node.description, 100),
          kind: choose(node.kind, ['neutral', 'primary', 'success', 'warning', 'danger'], 'neutral'),
          column: column,
          row: row
        };
      });
      if (!Array.isArray(input.edges) || input.edges.length > 20) throw new Error('Diagram supports up to 20 connections');
      out.edges = input.edges.map(function (edge) {
        if (!isObject(edge)) throw new Error('Diagram connection must be an object');
        var from = cleanText(edge.from, 32);
        var to = cleanText(edge.to, 32);
        if (!diagramIds[from] || !diagramIds[to] || from === to) throw new Error('Diagram connection refers to an unknown node');
        return { from: from, to: to, label: cleanText(edge.label, 50) };
      });
    } else if (type === 'button') {
      out.label = cleanText(input.label, 120);
      if (input.action !== 'copy') throw new Error('Only the copy action is available');
      out.action = 'copy';
      out.value = cleanText(input.value, 800);
    } else {
      throw new Error('Unsupported UI component: ' + type);
    }
    return out;
  }

  function parseSpec(input) {
    try {
      var data = input;
      if (typeof input === 'string') {
        if (input.length > MAX_SPEC_CHARS) throw new Error('UI specification is too large');
        data = JSON.parse(input);
      }
      if (!isObject(data) || data.version !== 1 || !Array.isArray(data.components)) {
        throw new Error('Expected version 1 and a components array');
      }
      if (data.components.length < 1 || data.components.length > MAX_COMPONENTS) throw new Error('Component count is out of range');
      var ids = Object.create(null);
      var chosenAccent = choose(data.accent, ACCENTS, 'violet');
      var chosenLayout = choose(data.layout, ['grid', 'stack', 'dashboard'], 'grid');
      var spec = {
        version: 1,
        title: cleanText(data.title, 120),
        description: cleanText(data.description, 300),
        theme: choose(data.theme, ['aurora', 'editorial', 'glass', 'midnight'], 'aurora'),
        layout: chosenLayout,
        accent: chosenAccent,
        components: data.components.map(function (component) { return sanitizeComponent(component, ids, chosenAccent); })
      };
      var state = Object.create(null);
      spec.components.forEach(function (component) {
        if (component.type === 'slider' || component.type === 'select' || component.type === 'toggle') state[component.id] = component.value;
      });
      spec.components.forEach(function (component) {
        if (component.formula) verifyFormula(component.formula, state);
        if (component.type === 'chart') component.data.forEach(function (point) {
          if (point.formula) verifyFormula(point.formula, state);
        });
      });
      return { ok: true, spec: spec };
    } catch (error) {
      return { ok: false, error: cleanText(error && error.message, 180) || 'Invalid UI specification' };
    }
  }

  function formatValue(value, format, currency) {
    var number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return value === undefined || value === null || value === '' ? '—' : cleanText(value, 160);
    try {
      if (format === 'currency') return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(number);
      if (format === 'integer') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(number);
      if (format === 'percent') return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number) + '%';
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number);
    } catch (_) {
      return String(format === 'integer' ? Math.round(number) : Math.round(number * 100) / 100) + (format === 'percent' ? '%' : '');
    }
  }
  function templateText(value, state) {
    return cleanText(value, MAX_TEXT).replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,31})\s*\}\}/g, function (_, key) {
      if (!Object.prototype.hasOwnProperty.call(state, key)) return '';
      var value = state[key];
      return typeof value === 'boolean' ? (value ? 'On' : 'Off') : formatValue(value, 'number');
    });
  }
  function valueOf(component, state) {
    if (component.formula) {
      try { return evaluateFormula(component.formula, state); } catch (_) { return null; }
    }
    return component.value;
  }
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) {
      var value = String(text);
      node.textContent = value;
      if (/\{\{\s*[A-Za-z][A-Za-z0-9_]{0,31}\s*\}\}/.test(value)) node.setAttribute('data-sd-genui-template', value);
    }
    return node;
  }
  function svgElement(tag, attrs, text) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function iconNode(name, size, className) {
    var paths = ICON_PATHS[name] || ICON_PATHS.sparkles;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 20));
    svg.setAttribute('height', String(size || 20));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    paths.forEach(function (d) { svg.appendChild(svgElement('path', { d: d })); });
    return svg;
  }
  function appendIcon(target, name, size, className) {
    var svg = iconNode(name, size, className);
    target.appendChild(svg);
    return svg;
  }

  function chartValues(component, state) {
    return component.data.map(function (point) {
      var value = point.formula ? valueOf({ formula: point.formula }, state) : point.value;
      return { label: point.label, value: Number.isFinite(value) ? value : 0 };
    });
  }
  function renderChart(target, component, state) {
    var values = chartValues(component, state);
    var svg = svgElement('svg', {
      viewBox: component.kind === 'pie' || component.kind === 'donut' ? '0 0 320 210' : '0 0 360 220',
      role: 'img', 'aria-label': component.title || 'Data chart',
      class: 'sd-genui-chart-svg', preserveAspectRatio: 'xMidYMid meet'
    });
    if (component.kind === 'pie' || component.kind === 'donut') {
      var positive = values.map(function (point) { return Math.max(0, point.value); });
      var total = positive.reduce(function (sum, number) { return sum + number; }, 0) || 1;
      var angle = -Math.PI / 2;
      var cx = 95, cy = 100, radius = 72;
      values.forEach(function (point, index) {
        var slice = positive[index] / total * Math.PI * 2;
        if (slice <= 0) return;
        var end = angle + slice;
        var x1 = cx + radius * Math.cos(angle), y1 = cy + radius * Math.sin(angle);
        var x2 = cx + radius * Math.cos(end), y2 = cy + radius * Math.sin(end);
        var arc = slice > Math.PI ? 1 : 0;
        var innerRadius = component.kind === 'donut' ? 39 : 0;
        var path = innerRadius > 0
          ? 'M ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 ' + arc + ' 1 ' + x2 + ' ' + y2 + ' L ' + (cx + innerRadius * Math.cos(end)) + ' ' + (cy + innerRadius * Math.sin(end)) + ' A ' + innerRadius + ' ' + innerRadius + ' 0 ' + arc + ' 0 ' + (cx + innerRadius * Math.cos(angle)) + ' ' + (cy + innerRadius * Math.sin(angle)) + ' Z'
          : 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 ' + arc + ' 1 ' + x2 + ' ' + y2 + ' Z';
        svg.appendChild(svgElement('path', { d: path, fill: COLORS[index % COLORS.length], stroke: 'currentColor', 'stroke-opacity': 0.15, 'stroke-width': 1 }));
        angle = end;
      });
      values.slice(0, 8).forEach(function (point, index) {
        var y = 38 + index * 21;
        svg.appendChild(svgElement('rect', { x: 184, y: y - 8, width: 9, height: 9, rx: 2, fill: COLORS[index % COLORS.length] }));
        svg.appendChild(svgElement('text', { x: 199, y: y, class: 'sd-genui-chart-label' }, point.label.slice(0, 13)));
        svg.appendChild(svgElement('text', { x: 199, y: y + 10, class: 'sd-genui-chart-value' }, formatValue(point.value, 'number')));
      });
      target.replaceChildren(svg);
      return;
    }

    var left = 35, right = 12, top = 16, bottom = 53;
    var width = 360 - left - right, height = 220 - top - bottom;
    var numbers = values.map(function (point) { return point.value; });
    var min = Math.min(0, Math.min.apply(Math, numbers));
    var max = Math.max(1, Math.max.apply(Math, numbers));
    var range = max - min || 1;
    for (var grid = 0; grid <= 4; grid++) {
      var y = top + height * grid / 4;
      var tick = max - range * grid / 4;
      svg.appendChild(svgElement('line', { x1: left, y1: y, x2: 360 - right, y2: y, class: 'sd-genui-chart-grid' }));
      svg.appendChild(svgElement('text', { x: left - 5, y: y + 3, 'text-anchor': 'end', class: 'sd-genui-chart-tick' }, formatValue(tick, 'number')));
    }
    var zeroY = top + max / range * height;
    if (component.kind === 'bar') {
      var slot = width / values.length;
      values.forEach(function (point, index) {
        var barWidth = Math.max(3, Math.min(34, slot * 0.58));
        var x = left + slot * index + (slot - barWidth) / 2;
        var valueY = top + (max - point.value) / range * height;
        svg.appendChild(svgElement('rect', {
          x: x, y: Math.min(zeroY, valueY), width: barWidth,
          height: Math.max(1, Math.abs(zeroY - valueY)), rx: 4,
          fill: COLORS[index % COLORS.length]
        }));
        if (values.length <= 10) svg.appendChild(svgElement('text', {
          x: x + barWidth / 2, y: 205, 'text-anchor': 'middle', class: 'sd-genui-chart-label'
        }, point.label.slice(0, 10)));
      });
    } else {
      var d = '';
      values.forEach(function (point, index) {
        var x = left + (values.length === 1 ? width / 2 : width * index / (values.length - 1));
        var y = top + (max - point.value) / range * height;
        d += (index ? ' L ' : 'M ') + x + ' ' + y;
        if (values.length <= 10) svg.appendChild(svgElement('text', {
          x: x, y: 205, 'text-anchor': 'middle', class: 'sd-genui-chart-label'
        }, point.label.slice(0, 10)));
      });
      svg.appendChild(svgElement('path', { d: d, fill: 'none', stroke: COLORS[0], 'stroke-width': 2.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      values.forEach(function (point, index) {
        var x = left + (values.length === 1 ? width / 2 : width * index / (values.length - 1));
        var y = top + (max - point.value) / range * height;
        svg.appendChild(svgElement('circle', { cx: x, cy: y, r: 3.5, fill: COLORS[0] }));
      });
    }
    target.replaceChildren(svg);
  }

  function renderDiagram(target, component, scope) {
    var nodeWidth = 132, nodeHeight = 76;
    var positions = Object.create(null);
    var maxRow = 0;
    component.nodes.forEach(function (node) {
      var x = 16 + node.column * 154;
      var y = 18 + node.row * 96;
      positions[node.id] = { x: x, y: y, cx: x + nodeWidth / 2, cy: y + nodeHeight / 2, column: node.column, row: node.row };
      maxRow = Math.max(maxRow, node.row);
    });
    var svgHeight = 48 + maxRow * 96 + nodeHeight;
    var svg = svgElement('svg', {
      viewBox: '0 0 640 ' + svgHeight,
      role: 'img',
      'aria-label': component.title || 'Diagram',
      class: 'sd-genui-diagram-svg',
      preserveAspectRatio: 'xMidYMid meet'
    });
    var defs = svgElement('defs');
    var markerId = 'sd-genui-diagram-arrow-' + scope.instanceId;
    var marker = svgElement('marker', {
      id: markerId, markerWidth: 7, markerHeight: 7, refX: 5.5, refY: 3.5,
      orient: 'auto', markerUnits: 'strokeWidth'
    });
    marker.appendChild(svgElement('path', { d: 'M0,0 L7,3.5 L0,7 Z', class: 'sd-genui-diagram-arrowhead' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    var edgeLabels = [];
    component.edges.forEach(function (edge) {
      var from = positions[edge.from], to = positions[edge.to];
      if (!from || !to) return;
      var horizontal = Math.abs(to.cx - from.cx) >= Math.abs(to.cy - from.cy);
      var x1, y1, x2, y2, midX, midY, path;
      if (horizontal) {
        var directionX = to.cx >= from.cx ? 1 : -1;
        x1 = from.cx + directionX * (nodeWidth / 2);
        x2 = to.cx - directionX * (nodeWidth / 2);
        y1 = from.cy;
        y2 = to.cy;
        midX = (x1 + x2) / 2;
        midY = (y1 + y2) / 2;
        path = 'M ' + x1 + ' ' + y1 + ' L ' + midX + ' ' + y1 + ' L ' + midX + ' ' + y2 + ' L ' + x2 + ' ' + y2;
      } else {
        var directionY = to.cy >= from.cy ? 1 : -1;
        x1 = from.cx;
        x2 = to.cx;
        y1 = from.cy + directionY * (nodeHeight / 2);
        y2 = to.cy - directionY * (nodeHeight / 2);
        midX = (x1 + x2) / 2;
        midY = (y1 + y2) / 2;
        path = 'M ' + x1 + ' ' + y1 + ' L ' + x1 + ' ' + midY + ' L ' + x2 + ' ' + midY + ' L ' + x2 + ' ' + y2;
      }
      svg.appendChild(svgElement('path', {
        d: path, class: 'sd-genui-diagram-edge', 'marker-end': 'url(#' + markerId + ')'
      }));
      if (edge.label) {
        edgeLabels.push({
          x: midX,
          y: Math.max(from.y + nodeHeight, to.y + nodeHeight) + 12,
          text: edge.label.slice(0, 22)
        });
      }
    });
    component.nodes.forEach(function (node) {
      var position = positions[node.id];
      var group = svgElement('g', { class: 'sd-genui-diagram-node', 'data-kind': node.kind });
      group.appendChild(svgElement('rect', {
        x: position.x, y: position.y, width: nodeWidth, height: nodeHeight, rx: 10,
        class: 'sd-genui-diagram-node-bg'
      }));
      var titleLines = [];
      var words = String(node.title || node.id).split(/\s+/);
      var line = '';
      words.forEach(function (word) {
        var next = line ? line + ' ' + word : word;
        if (next.length > 19 && line) { titleLines.push(line); line = word; }
        else line = next;
      });
      if (line) titleLines.push(line);
      if (titleLines.length > 2) titleLines = [titleLines[0], titleLines.slice(1).join(' ').slice(0, 18) + '…'];
      titleLines.forEach(function (titleLine, lineIndex) {
        group.appendChild(svgElement('text', {
          x: position.cx, y: position.y + (titleLines.length === 1 ? 32 : 25 + lineIndex * 13),
          'text-anchor': 'middle', class: 'sd-genui-diagram-node-title'
        }, titleLine));
      });
      if (node.text) {
        var label = node.text.length > 23 ? node.text.slice(0, 22) + '…' : node.text;
        group.appendChild(svgElement('text', {
          x: position.cx, y: position.y + 59, 'text-anchor': 'middle', class: 'sd-genui-diagram-node-copy'
        }, label));
      }
      svg.appendChild(group);
    });
    edgeLabels.forEach(function (label) {
      svg.appendChild(svgElement('text', {
        x: label.x, y: label.y, 'text-anchor': 'middle', class: 'sd-genui-diagram-edge-label'
      }, label.text));
    });
    target.replaceChildren(svg);
  }

  function isBangla() {
    try {
      var engine = root.__sdEngine;
      var language = engine && typeof engine.locale === 'function' ? engine.locale() : '';
      return String(language || (root.navigator && root.navigator.language) || '').toLowerCase().indexOf('bn') === 0;
    } catch (_) { return false; }
  }
  function copyText(value) {
    var text = String(value || '');
    try {
      if (root.navigator && root.navigator.clipboard && typeof root.navigator.clipboard.writeText === 'function') {
        return root.navigator.clipboard.writeText(text);
      }
    } catch (_) {}
    return new Promise(function (resolve, reject) {
      var input;
      try {
        input = element('textarea', 'sd-genui-copy-buffer');
        input.value = text;
        input.setAttribute('readonly', 'readonly');
        document.body.appendChild(input);
        input.select();
        var copied = document.execCommand && document.execCommand('copy');
        input.remove();
        if (copied) resolve(); else reject(new Error('Copy is not available'));
      } catch (error) {
        if (input && input.parentNode) input.parentNode.removeChild(input);
        reject(error);
      }
    });
  }

  function buildComponent(component, index, scope) {
    var card = element('section', 'sd-genui-item sd-genui-item-' + component.type);
    card.setAttribute('data-sd-genui-index', String(index));
    if (component.span === 'full' || component.span === 'half') card.classList.add('sd-genui-span-' + component.span);
    if (component.type === 'comparison') {
      if (component.title) card.appendChild(element('h3', 'sd-genui-section-title', component.title));
      var compareGrid = element('div', 'sd-genui-comparison-grid');
      component.items.forEach(function (option) {
        var panel = element('article', 'sd-genui-compare-card' + (option.highlighted ? ' sd-genui-compare-featured' : ''));
        if (option.eyebrow) panel.appendChild(element('div', 'sd-genui-compare-eyebrow', option.eyebrow));
        if (option.badge) panel.appendChild(element('span', 'sd-genui-compare-badge', option.badge));
        panel.appendChild(element('h4', 'sd-genui-compare-title', option.title));
        if (option.description) panel.appendChild(element('p', 'sd-genui-compare-description', option.description));
        if (option.price !== '') {
          var priceLine = element('div', 'sd-genui-compare-price-line');
          priceLine.appendChild(element('span', 'sd-genui-compare-price', option.price));
          if (option.period) priceLine.appendChild(element('span', 'sd-genui-compare-period', option.period));
          panel.appendChild(priceLine);
        }
        if (option.features.length) {
          var featureList = element('ul', 'sd-genui-compare-features');
          option.features.forEach(function (feature) {
            var featureRow = element('li', '');
            var check = element('span', 'sd-genui-compare-check');
            appendIcon(check, 'check-circle', 15);
            featureRow.appendChild(check);
            featureRow.appendChild(element('span', 'sd-genui-compare-feature', feature));
            featureList.appendChild(featureRow);
          });
          panel.appendChild(featureList);
        }
        compareGrid.appendChild(panel);
      });
      card.appendChild(compareGrid);
    } else if (component.type === 'hero') {
      card.setAttribute('data-accent', component.accent);
      var heroTop = element('div', 'sd-genui-hero-top');
      var heroIcon = element('span', 'sd-genui-hero-icon');
      appendIcon(heroIcon, component.icon, 28);
      heroTop.appendChild(heroIcon);
      if (component.eyebrow) heroTop.appendChild(element('span', 'sd-genui-eyebrow', component.eyebrow));
      if (component.badge) heroTop.appendChild(element('span', 'sd-genui-hero-badge', component.badge));
      card.appendChild(heroTop);
      if (component.title) card.appendChild(element('h3', 'sd-genui-hero-title', component.title));
      if (component.subtitle) card.appendChild(element('p', 'sd-genui-hero-subtitle', component.subtitle));
      if (component.value !== '' || component.formula) {
        var heroValue = element('div', 'sd-genui-hero-value', '');
        heroValue.setAttribute('data-sd-genui-value', 'hero');
        card.appendChild(heroValue);
      }
      if (component.footnote) card.appendChild(element('div', 'sd-genui-hero-footnote', component.footnote));
    } else if (component.type === 'callout') {
      card.setAttribute('data-tone', component.tone);
      var calloutIcon = element('span', 'sd-genui-callout-icon');
      appendIcon(calloutIcon, component.icon, 21);
      card.appendChild(calloutIcon);
      var calloutBody = element('div', 'sd-genui-callout-body');
      if (component.title) calloutBody.appendChild(element('div', 'sd-genui-callout-title', component.title));
      calloutBody.appendChild(element('div', 'sd-genui-callout-text', component.text));
      card.appendChild(calloutBody);
    } else if (component.type === 'list') {
      if (component.title) card.appendChild(element('h3', 'sd-genui-section-title', component.title));
      var listItems = element('div', 'sd-genui-list');
      component.items.forEach(function (entry) {
        var row = element('div', 'sd-genui-list-row');
        var mark = element('span', 'sd-genui-list-icon');
        appendIcon(mark, entry.icon, 17);
        row.appendChild(mark);
        var copy = element('div', 'sd-genui-list-copy');
        copy.appendChild(element('div', 'sd-genui-list-item-title', entry.title));
        if (entry.text) copy.appendChild(element('div', 'sd-genui-caption', entry.text));
        row.appendChild(copy);
        listItems.appendChild(row);
      });
      card.appendChild(listItems);
    } else if (component.type === 'steps') {
      if (component.title) card.appendChild(element('h3', 'sd-genui-section-title', component.title));
      var stepsList = element('div', 'sd-genui-steps');
      component.items.forEach(function (step, stepIndex) {
        var row = element('div', 'sd-genui-step sd-genui-step-' + step.status);
        row.appendChild(element('span', 'sd-genui-step-number', step.status === 'done' ? '✓' : String(stepIndex + 1)));
        var body = element('div', 'sd-genui-step-body');
        body.appendChild(element('div', 'sd-genui-list-item-title', step.title));
        if (step.text) body.appendChild(element('div', 'sd-genui-caption', step.text));
        row.appendChild(body);
        stepsList.appendChild(row);
      });
      card.appendChild(stepsList);
    } else if (component.type === 'timeline') {
      if (component.title) card.appendChild(element('h3', 'sd-genui-section-title', component.title));
      var timeline = element('div', 'sd-genui-timeline');
      component.events.forEach(function (event) {
        var row = element('div', 'sd-genui-timeline-event sd-genui-timeline-' + event.tone);
        row.appendChild(element('span', 'sd-genui-timeline-dot'));
        var body = element('div', 'sd-genui-timeline-body');
        if (event.date) body.appendChild(element('div', 'sd-genui-timeline-date', event.date));
        body.appendChild(element('div', 'sd-genui-list-item-title', event.title));
        if (event.text) body.appendChild(element('div', 'sd-genui-caption', event.text));
        row.appendChild(body);
        timeline.appendChild(row);
      });
      card.appendChild(timeline);
    } else if (component.type === 'quote') {
      card.appendChild(element('span', 'sd-genui-quote-mark', '“'));
      card.appendChild(element('blockquote', 'sd-genui-quote-text', component.text));
      if (component.attribution || component.role) {
        var attribution = element('div', 'sd-genui-quote-attribution');
        if (component.attribution) attribution.appendChild(element('span', 'sd-genui-quote-name', component.attribution));
        if (component.role) attribution.appendChild(element('span', 'sd-genui-quote-role', component.role));
        card.appendChild(attribution);
      }
    } else if (component.type === 'icon') {
      card.classList.add('sd-genui-icon-card', 'sd-genui-icon-' + component.size, 'sd-genui-tone-' + component.tone);
      var iconHolder = element('span', 'sd-genui-icon-holder');
      appendIcon(iconHolder, component.name, component.size === 'lg' ? 34 : component.size === 'sm' ? 17 : 24);
      card.appendChild(iconHolder);
      if (component.label) card.appendChild(element('span', 'sd-genui-icon-label', component.label));
    } else if (component.type === 'divider') {
      card.classList.add('sd-genui-divider');
      if (component.label) card.appendChild(element('span', 'sd-genui-divider-label', component.label));
    } else if (component.type === 'text') {
      card.classList.add('sd-genui-text-' + component.tone);
      card.setAttribute('data-sd-genui-template', component.text);
      card.textContent = templateText(component.text, scope.state);
    } else if (component.type === 'stat') {
      card.appendChild(element('div', 'sd-genui-kicker', component.label));
      card.appendChild(element('div', 'sd-genui-stat-value', ''));
      var statValue = card.lastChild;
      statValue.setAttribute('data-sd-genui-value', '1');
      if (component.caption) {
        var caption = element('div', 'sd-genui-caption', component.caption);
        caption.setAttribute('data-sd-genui-template', component.caption);
        card.appendChild(caption);
      }
    } else if (component.type === 'badge') {
      card.appendChild(element('span', 'sd-genui-badge sd-genui-tone-' + component.tone, component.label));
    } else if (component.type === 'progress') {
      var row = element('div', 'sd-genui-progress-label');
      row.appendChild(element('span', '', component.label));
      row.appendChild(element('span', 'sd-genui-progress-value', ''));
      card.appendChild(row);
      var track = element('div', 'sd-genui-progress-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', component.label || 'Progress');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(component.max));
      track.appendChild(element('div', 'sd-genui-progress-fill'));
      card.appendChild(track);
    } else if (component.type === 'slider') {
      var sliderId = 'sd-genui-control-' + scope.instanceId + '-' + component.id;
      var head = element('div', 'sd-genui-control-head');
      var label = element('label', '', component.label);
      label.setAttribute('for', sliderId);
      head.appendChild(label);
      head.appendChild(element('output', 'sd-genui-control-value', formatValue(scope.state[component.id], component.format, component.currency)));
      card.appendChild(head);
      var slider = element('input', 'sd-genui-slider');
      slider.type = 'range';
      slider.id = sliderId;
      slider.min = String(component.min);
      slider.max = String(component.max);
      slider.step = String(component.step);
      slider.value = String(scope.state[component.id]);
      slider.setAttribute('data-sd-genui-control', component.id);
      slider.addEventListener('input', function () {
        scope.state[component.id] = Number(slider.value);
        updateSurface(scope);
      });
      card.appendChild(slider);
      var bounds = element('div', 'sd-genui-bounds');
      bounds.appendChild(element('span', '', formatValue(component.min, component.format, component.currency)));
      bounds.appendChild(element('span', '', formatValue(component.max, component.format, component.currency)));
      card.appendChild(bounds);
    } else if (component.type === 'select') {
      var selectId = 'sd-genui-control-' + scope.instanceId + '-' + component.id;
      var selectLabel = element('label', 'sd-genui-control-label', component.label);
      selectLabel.setAttribute('for', selectId);
      card.appendChild(selectLabel);
      var select = element('select', 'sd-genui-select');
      select.id = selectId;
      select.setAttribute('data-sd-genui-control', component.id);
      component.options.forEach(function (option) {
        var node = element('option', '', option);
        node.value = option;
        if (option === scope.state[component.id]) node.selected = true;
        select.appendChild(node);
      });
      select.addEventListener('change', function () {
        scope.state[component.id] = select.value;
        updateSurface(scope);
      });
      card.appendChild(select);
    } else if (component.type === 'toggle') {
      var toggleId = 'sd-genui-control-' + scope.instanceId + '-' + component.id;
      var toggleLabel = element('label', 'sd-genui-toggle');
      var toggle = element('input', '');
      toggle.type = 'checkbox';
      toggle.id = toggleId;
      toggle.checked = !!scope.state[component.id];
      toggle.setAttribute('data-sd-genui-control', component.id);
      toggle.addEventListener('change', function () {
        scope.state[component.id] = !!toggle.checked;
        updateSurface(scope);
      });
      toggleLabel.appendChild(toggle);
      toggleLabel.appendChild(element('span', '', component.label));
      card.appendChild(toggleLabel);
    } else if (component.type === 'chart') {
      if (component.title) card.appendChild(element('h3', 'sd-genui-chart-title', component.title));
      if (component.description) card.appendChild(element('p', 'sd-genui-caption', component.description));
      var plot = element('div', 'sd-genui-chart-plot');
      card.appendChild(plot);
      renderChart(plot, component, scope.state);
    } else if (component.type === 'table') {
      var wrap = element('div', 'sd-genui-table-wrap');
      var table = element('table', 'sd-genui-table');
      var thead = element('thead', '');
      var header = element('tr', '');
      component.columns.forEach(function (column) { header.appendChild(element('th', '', column)); });
      thead.appendChild(header);
      table.appendChild(thead);
      var body = element('tbody', '');
      component.rows.forEach(function (row) {
        var tr = element('tr', '');
        row.forEach(function (cell) {
          var td = element('td', '');
          td.setAttribute('data-sd-genui-template', cell);
          td.textContent = templateText(cell, scope.state);
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
      table.appendChild(body);
      wrap.appendChild(table);
      card.appendChild(wrap);
    } else if (component.type === 'diagram') {
      if (component.title) card.appendChild(element('h3', 'sd-genui-section-title', component.title));
      if (component.description) card.appendChild(element('p', 'sd-genui-caption', component.description));
      var diagramWrap = element('div', 'sd-genui-diagram-wrap');
      card.appendChild(diagramWrap);
      renderDiagram(diagramWrap, component, scope);
    } else if (component.type === 'button') {
      var button = element('button', 'sd-genui-button', component.label);
      button.type = 'button';
      var status = element('span', 'sd-genui-button-status', '');
      button.addEventListener('click', function () {
        copyText(templateText(component.value, scope.state)).then(function () {
          status.textContent = isBangla() ? 'কপি হয়েছে' : 'Copied';
        }).catch(function () {
          status.textContent = isBangla() ? 'কপি করা যায়নি' : 'Copy failed';
        });
      });
      card.appendChild(button);
      card.appendChild(status);
    }
    return card;
  }

  function initialState(spec) {
    var state = Object.create(null);
    spec.components.forEach(function (component) {
      if (component.type === 'slider' || component.type === 'select' || component.type === 'toggle') state[component.id] = component.value;
    });
    return state;
  }
  function updateSurface(scope) {
    if (!scope || !scope.surface || !scope.surface.isConnected) return;
    scope.spec.components.forEach(function (component, index) {
      var card = scope.surface.querySelector('[data-sd-genui-index="' + index + '"]');
      if (!card) return;
      if (component.type === 'text') {
        card.textContent = templateText(component.text, scope.state);
      } else if (component.type === 'hero') {
        var heroOutput = card.querySelector('[data-sd-genui-value="hero"]');
        if (heroOutput) {
          var heroValue = valueOf(component, scope.state);
          heroOutput.textContent = component.formula || typeof heroValue === 'number'
            ? formatValue(heroValue, component.format, component.currency)
            : templateText(heroValue, scope.state);
          heroOutput.hidden = heroValue === '' || heroValue === null || heroValue === undefined;
        }
      } else if (component.type === 'stat') {
        var output = card.querySelector('[data-sd-genui-value]');
        if (output) {
          var value = valueOf(component, scope.state);
          output.textContent = component.formula ? formatValue(value, component.format, component.currency) :
            (typeof value === 'number' ? formatValue(value, component.format, component.currency) : templateText(value, scope.state));
        }
        var caption = card.querySelector('.sd-genui-caption');
        if (caption) caption.textContent = templateText(component.caption, scope.state);
      } else if (component.type === 'progress') {
        var raw = valueOf(component, scope.state);
        var value = Number.isFinite(raw) ? raw : 0;
        var percent = Math.max(0, Math.min(100, value / component.max * 100));
        var fill = card.querySelector('.sd-genui-progress-fill');
        var track = card.querySelector('.sd-genui-progress-track');
        var label = card.querySelector('.sd-genui-progress-value');
        if (fill) fill.style.width = percent + '%';
        if (track) track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(component.max, value))));
        if (label) label.textContent = formatValue(value, component.format, component.currency);
      } else if (component.type === 'chart') {
        var plot = card.querySelector('.sd-genui-chart-plot');
        if (plot) renderChart(plot, component, scope.state);
      } else if (component.type === 'table') {
        var cells = card.querySelectorAll('[data-sd-genui-template]');
        for (var i = 0; i < cells.length; i++) cells[i].textContent = templateText(cells[i].getAttribute('data-sd-genui-template') || '', scope.state);
      }
      var dynamicTextNodes = card.querySelectorAll('[data-sd-genui-template]');
      for (var dynamicIndex = 0; dynamicIndex < dynamicTextNodes.length; dynamicIndex++) {
        var templateValue = dynamicTextNodes[dynamicIndex].getAttribute('data-sd-genui-template') || '';
        dynamicTextNodes[dynamicIndex].textContent = templateText(templateValue, scope.state);
      }
    });
    var controls = scope.surface.querySelectorAll('[data-sd-genui-control]');
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      var id = control.getAttribute('data-sd-genui-control');
      var component = scope.spec.components.find(function (item) { return item.id === id; });
      if (!component) continue;
      if (component.type === 'slider') {
        control.value = String(scope.state[id]);
        var output = control.parentNode && control.parentNode.querySelector('.sd-genui-control-value');
        if (output) output.textContent = formatValue(scope.state[id], component.format, component.currency);
      } else if (component.type === 'select' && control.value !== scope.state[id]) {
        control.value = String(scope.state[id]);
      } else if (component.type === 'toggle') {
        control.checked = !!scope.state[id];
      }
    }
  }

  var instanceCount = 0;
  function renderSpec(spec) {
    instanceCount++;
    var scope = { instanceId: String(instanceCount), spec: spec, state: initialState(spec), surface: null };
    var surface = element('div', 'sd-genui-surface');
    surface.setAttribute('data-theme', spec.theme || 'aurora');
    surface.setAttribute('data-layout', spec.layout || 'grid');
    surface.setAttribute('data-accent', spec.accent || 'violet');
    surface.classList.add('sd-genui-layout-' + (spec.layout || 'grid'));
    if (spec.title) surface.appendChild(element('h2', 'sd-genui-title', spec.title));
    if (spec.description) surface.appendChild(element('p', 'sd-genui-description', spec.description));
    var grid = element('div', 'sd-genui-grid');
    spec.components.forEach(function (component, index) { grid.appendChild(buildComponent(component, index, scope)); });
    surface.appendChild(grid);
    scope.surface = surface;
    surface.__sdGenUIScope = scope;
    return surface;
  }

  function legacyBlocks() {
    var out = [], messages = document.querySelectorAll('.ds-message');
    for (var i = 0; i < messages.length; i++) {
      var codes = messages[i].querySelectorAll('pre code.language-sds-ui, pre code.lang-sds-ui, code.language-sds-ui, code.lang-sds-ui');
      for (var j = 0; j < codes.length; j++) {
        var pre = codes[j].closest ? codes[j].closest('pre') : codes[j].parentNode;
        if (pre) out.push({ lang: 'sds-ui', code: codes[j], pre: pre, container: pre, text: codes[j].textContent || '' });
      }
    }
    return out;
  }
  function scanOnce() {
    if (!document || !document.body) return;
    var host = root.__sdGenUIHost;
    if (host && !host.enabled()) return;
    // Host adapter understands DeepSeek's `.md-code-block` banner DOM as well as
    // plain `pre > code.language-sds-ui`; the legacy query is the fallback.
    var blocks = host ? host.codeBlocks(document).filter(function (b) { return b.lang === 'sds-ui'; }) : legacyBlocks();
    for (var j = 0; j < blocks.length; j++) {
      var block = blocks[j], code = block.code, container = block.container;
      if (code.getAttribute('data-sd-genui-rendered') === '1' && code.__sdGenUISource === block.text) continue;
      if (!container || !container.parentNode) continue;
      var parsed = parseSpec(block.text);
      if (!parsed.ok) {
        // Streaming: the claim skeleton stands in. Once the block is final and
        // still invalid, a quiet error card replaces it (code behind a toggle).
        var st = code.__sdGenUIWait || (code.__sdGenUIWait = { text: null, at: 0 });
        if (st.text !== block.text) { st.text = block.text; st.at = Date.now(); }
        var isFinal = host && (host.followed(block) || Date.now() - st.at > 1600);
        if (!isFinal) { if (host && host.isClaimed && host.isClaimed(container)) scheduleScan(1700); continue; }
        if (code.__sdGenUIError === block.text) continue;
        code.__sdGenUIError = block.text;
        var A = root.__sdArtifacts;
        if (A && A.errorCard && host && host.isClaimed && host.isClaimed(container)) {
          if (code.__sdGenUIErrEl) code.__sdGenUIErrEl.remove();
          var ec = A.errorCard({ title: 'Couldn’t display this widget', detail: parsed.error || 'Invalid widget specification', container: container,
            fix: 'The sds-ui widget above could not be rendered (' + (parsed.error || 'invalid JSON') + '). Please send it again as one valid JSON ```sds-ui block.' });
          container.parentNode.insertBefore(ec, container);
          code.__sdGenUIErrEl = ec;
          container.setAttribute('data-sd-hidden', 'artifact');
          host.claimDone(container);
        }
        continue;
      }
      if (code.__sdGenUIErrEl) { code.__sdGenUIErrEl.remove(); code.__sdGenUIErrEl = null; }
      try {
        if (code.__sdGenUISurface) code.__sdGenUISurface.remove();
        var surface = renderSpec(parsed.spec);
        surface.setAttribute('data-sd-genui', '1');
        container.parentNode.insertBefore(surface, container);
        updateSurface(surface.__sdGenUIScope);
        container.setAttribute('data-sd-genui-hidden', '1');
        container.setAttribute('aria-hidden', 'true');
        if (host && host.claimDone) host.claimDone(container);
        code.setAttribute('data-sd-genui-rendered', '1');
        code.__sdGenUISource = block.text;
        code.__sdGenUISurface = surface;
      } catch (error) {
        console.warn('[SDS GenUI] Could not render UI specification', error);
      }
    }
  }
  function scan() {
    var host = root.__sdGenUIHost;
    if (host) host.guard('inline-widgets', scanOnce); else scanOnce();
  }
  function teardown() {
    var nodes = document.querySelectorAll('.sd-genui-surface[data-sd-genui="1"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    var hidden = document.querySelectorAll('[data-sd-genui-hidden]');
    for (var k = 0; k < hidden.length; k++) { hidden[k].removeAttribute('data-sd-genui-hidden'); hidden[k].removeAttribute('aria-hidden'); }
    var codes = document.querySelectorAll('[data-sd-genui-rendered]');
    for (var c = 0; c < codes.length; c++) { codes[c].removeAttribute('data-sd-genui-rendered'); codes[c].__sdGenUISurface = null; }
  }
  var observer = null;
  var scanTimer = null;
  var scanAt = 0;
  function scheduleScan(ms) {
    ms = typeof ms === 'number' ? ms : 180;
    if (scanTimer !== null) { if (Date.now() + ms >= scanAt) return; clearTimeout(scanTimer); }
    scanAt = Date.now() + ms;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scan();
    }, ms);
  }
  function start() {
    if (observer || !document || !document.body || typeof MutationObserver !== 'function') return;
    scan();
    observer = new MutationObserver(function () { scheduleScan(); });
    var hst = root.__sdGenUIHost; if (hst && hst.onClaim) hst.onClaim(function () { scheduleScan(16); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  root.__sdGenUI = {
    version: 1,
    parseSpec: parseSpec,
    evaluateFormula: evaluateFormula,
    formatValue: formatValue,
    renderSpec: renderSpec,
    updateSurface: updateSurface,
    scan: scan,
    teardown: teardown,
    start: start
  };
  if (root.addEventListener) root.addEventListener('sd-genui:config', function (e) { if (e.detail && e.detail.enabled === false) teardown(); else scheduleScan(); });
  if (document && document.body) start();
})(window);
