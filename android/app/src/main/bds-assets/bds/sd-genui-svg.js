/* SVG allowlist adapted from this repository feat/free-form-genui; MIT.
 * No HTML execution. Filters disabled; bounded nesting before recursive traversal. */
(function (root) {
  'use strict';
  if (root.__sdGenUISvg) return;

  var MAX_SVG_CHARS = 60000;
  var MAX_HTML_CHARS = 120000;
  var MAX_ATTR = 4000;
  var MAX_PATH_ATTR = 24000;
  var MAX_NODES = 1500;
  var MAX_PARSE_NODES = 6000;
  var MAX_DEPTH = 24;
  var MAX_TEXT = 600;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var EXT_MARK = '[SDS:GENUI_FREE]';
  var SETTLE_SVG_MS = 400;
  var SETTLE_HTML_DONE_MS = 350;
  var SETTLE_HTML_IDLE_MS = 2500;
  var READY_TIMEOUT_MS = 2500;

  // ---------------------------------------------------------------------------------------------
  // Allowlists
  // ---------------------------------------------------------------------------------------------
  var ELEMENT_LIST = ('svg g defs symbol use title desc path rect circle ellipse line polyline polygon text tspan textPath ' +
    'linearGradient radialGradient stop clipPath mask pattern marker filter feBlend feColorMatrix feComposite feFlood ' +
    'feGaussianBlur feMerge feMergeNode feMorphology feOffset feDropShadow feTurbulence feDisplacementMap ' +
    'feComponentTransfer feFuncR feFuncG feFuncB feFuncA animate animateTransform animateMotion set mpath').split(' ');
  var ELEMENTS = Object.create(null);
  ELEMENT_LIST.forEach(function (name) { ELEMENTS[name.toLowerCase()] = name; });
  var TEXT_ELEMENTS = { text: 1, tspan: 1, textpath: 1, title: 1, desc: 1 };
  var HREF_ELEMENTS = { use: 1, textpath: 1, mpath: 1, lineargradient: 1, radialgradient: 1, pattern: 1 };
  var ANIM_ELEMENTS = { animate: 1, animatetransform: 1, animatemotion: 1, set: 1 };

  var ATTR_LIST = ('x y x1 x2 y1 y2 cx cy r rx ry width height d points transform viewBox preserveAspectRatio dx dy rotate ' +
    'textLength lengthAdjust fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin ' +
    'stroke-dasharray stroke-dashoffset stroke-miterlimit opacity color font-family font-size font-weight font-style ' +
    'text-anchor dominant-baseline alignment-baseline letter-spacing word-spacing text-decoration visibility display ' +
    'clip-path clip-rule mask filter marker-start marker-mid marker-end stop-color stop-opacity offset gradientUnits ' +
    'gradientTransform spreadMethod fx fy fr patternUnits patternContentUnits patternTransform clipPathUnits maskUnits ' +
    'maskContentUnits markerWidth markerHeight markerUnits refX refY orient filterUnits primitiveUnits in in2 result ' +
    'stdDeviation mode type values operator k1 k2 k3 k4 flood-color flood-opacity baseFrequency numOctaves seed scale ' +
    'xChannelSelector yChannelSelector radius tableValues slope intercept amplitude exponent mix-blend-mode paint-order ' +
    'transform-origin transform-box shape-rendering vector-effect pathLength ' +
    'from to by keyTimes keySplines calcMode begin dur end repeatCount repeatDur min max additive accumulate path keyPoints').split(' ');
  var ATTRS = Object.create(null);
  ATTR_LIST.forEach(function (name) { ATTRS[name.toLowerCase()] = name; });
  var ANIM_TARGETS = { x: 1, y: 1, cx: 1, cy: 1, r: 1, rx: 1, ry: 1, width: 1, height: 1, opacity: 1, fill: 1, stroke: 1,
    'stroke-width': 1, 'stroke-opacity': 1, 'fill-opacity': 1, 'stroke-dashoffset': 1, 'stroke-dasharray': 1, transform: 1,
    d: 1, points: 1, offset: 1, 'stop-color': 1, 'stop-opacity': 1, stddeviation: 1, x1: 1, x2: 1, y1: 1, y2: 1, dx: 1, dy: 1,
    rotate: 1, 'font-size': 1, 'letter-spacing': 1, fx: 1, fy: 1, 'flood-color': 1, values: 1, scale: 1, basefrequency: 1 };
  var STYLE_PROPS = { fill: 1, stroke: 1, 'stroke-width': 1, 'stroke-linecap': 1, 'stroke-linejoin': 1, 'stroke-dasharray': 1,
    'stroke-dashoffset': 1, 'stroke-opacity': 1, 'fill-opacity': 1, opacity: 1, 'font-family': 1, 'font-size': 1,
    'font-weight': 1, 'font-style': 1, 'text-anchor': 1, 'letter-spacing': 1, 'dominant-baseline': 1, 'stop-color': 1,
    'stop-opacity': 1, 'mix-blend-mode': 1, filter: 1, 'clip-path': 1, mask: 1, transform: 1, 'transform-origin': 1,
    'transform-box': 1, display: 1, visibility: 1, 'paint-order': 1 };

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // ---------------------------------------------------------------------------------------------
  // Tolerant markup parser (no DOMParser: no parser differentials, works on truncated streams)
  // ---------------------------------------------------------------------------------------------
  function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (match, entity) {
      var lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      var code = lower.charAt(1) === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      if (!isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) return '';
      return String.fromCodePoint(code);
    });
  }

  function parseMarkup(source) {
    var s = String(source || '');
    var lowered = s.toLowerCase();
    var n = s.length;
    var i = 0;
    var rootList = [];
    var stack = [];
    var count = 0;
    var tooBig = false;

    function container() { return stack.length ? stack[stack.length - 1].kids : rootList; }
    function addText(raw, isCdata) {
      if (!stack.length) return;
      var value = isCdata ? raw : decodeEntities(raw);
      if (value) container().push({ text: value });
    }
    function closeTag(name) {
      for (var k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === name) { stack.length = k; return; }
      }
    }

    while (i < n && !tooBig) {
      var lt = s.indexOf('<', i);
      if (lt < 0) { addText(s.slice(i)); break; }
      if (lt > i) addText(s.slice(i, lt));
      i = lt;
      if (s.substr(i, 4) === '<!--') {
        var endComment = s.indexOf('-->', i + 4);
        i = endComment < 0 ? n : endComment + 3;
        continue;
      }
      if (s.substr(i, 9) === '<![CDATA[') {
        var endCdata = s.indexOf(']]>', i + 9);
        addText(s.slice(i + 9, endCdata < 0 ? n : endCdata), true);
        i = endCdata < 0 ? n : endCdata + 3;
        continue;
      }
      var next = s.charAt(i + 1);
      if (next === '!' || next === '?') {
        var endDecl = s.indexOf('>', i);
        i = endDecl < 0 ? n : endDecl + 1;
        continue;
      }
      if (next === '/') {
        var endClose = s.indexOf('>', i);
        if (endClose < 0) break;
        closeTag(s.slice(i + 2, endClose).trim().toLowerCase().replace(/^svg:/, ''));
        i = endClose + 1;
        continue;
      }
      var nameMatch = /^<([A-Za-z][\w:.-]*)/.exec(s.slice(i, i + 80));
      if (!nameMatch) { addText('<'); i++; continue; }
      var j = i + nameMatch[0].length;
      var attrs = Object.create(null);
      var selfClose = false;
      var closed = false;
      while (j < n) {
        while (j < n && /\s/.test(s.charAt(j))) j++;
        var c = s.charAt(j);
        if (c === '>') { j++; closed = true; break; }
        if (c === '/' && s.charAt(j + 1) === '>') { selfClose = true; j += 2; closed = true; break; }
        if (c === '/') { j++; continue; }
        var attrMatch = /^[^\s=>\/"']+/.exec(s.slice(j, j + 120));
        if (!attrMatch) { j++; continue; }
        var attrName = attrMatch[0];
        j += attrName.length;
        while (j < n && /\s/.test(s.charAt(j))) j++;
        var value = '';
        if (s.charAt(j) === '=') {
          j++;
          while (j < n && /\s/.test(s.charAt(j))) j++;
          var quote = s.charAt(j);
          if (quote === '"' || quote === "'") {
            var endQuote = s.indexOf(quote, j + 1);
            if (endQuote < 0) { j = n; break; }
            value = s.slice(j + 1, endQuote);
            j = endQuote + 1;
          } else {
            var bare = /^[^\s>]+/.exec(s.slice(j, j + MAX_PATH_ATTR));
            value = bare ? bare[0] : '';
            j += value.length;
          }
        }
        attrs[attrName] = decodeEntities(value.slice(0, MAX_PATH_ATTR + 1));
      }
      if (!closed) break; // truncated tag at the end of a partial stream
      i = j;
      var tagName = nameMatch[1].toLowerCase().replace(/^svg:/, '');
      if (tagName === 'script' || tagName === 'style') {
        if (!selfClose) {
          var endRaw = lowered.indexOf('</' + tagName, i);
          if (endRaw < 0) { i = n; } else {
            var endRawTag = s.indexOf('>', endRaw);
            i = endRawTag < 0 ? n : endRawTag + 1;
          }
        }
        continue;
      }
      var node = { name: tagName, attrs: attrs, kids: [] };
      container().push(node);
      count++;
      if (count > MAX_PARSE_NODES) { tooBig = true; break; }
      if (!selfClose) { if (stack.length >= MAX_DEPTH) return { ok: false, error: 'Drawing nesting limit' }; stack.push(node); }
    }
    if (tooBig) return { ok: false, error: 'Drawing has too many elements' };
    return { ok: true, nodes: rootList };
  }

  function findSvgRoot(nodes) {
    for (var k = 0; k < nodes.length; k++) {
      var node = nodes[k];
      if (!node || node.text !== undefined) continue;
      if (node.name === 'svg') return node;
      var inner = findSvgRoot(node.kids);
      if (inner) return inner;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // SVG sanitizer
  // ---------------------------------------------------------------------------------------------
  var SAFE_URL_REF = /url\(\s*(['"]?)#([A-Za-z][\w-]*)\1\s*\)/gi;

  function safeValue(raw, prefix, maxLength) {
    var value = String(raw);
    if (value.length > (maxLength || MAX_ATTR)) return null;
    if (/javascript:|vbscript:|data:|[<>]|\/\*|expression\s*\(|@import|\\/i.test(value)) return null;
    if (/url\s*\(/i.test(value)) {
      var stripped = value.replace(SAFE_URL_REF, '');
      if (/url\s*\(/i.test(stripped)) return null;
      value = value.replace(SAFE_URL_REF, function (_, quote, id) { return 'url(#' + prefix + id + ')'; });
    }
    return value;
  }

  function sanitizeStyle(raw, prefix) {
    var out = [];
    String(raw).split(';').forEach(function (part) {
      var index = part.indexOf(':');
      if (index < 1) return;
      var property = part.slice(0, index).trim().toLowerCase();
      if (!STYLE_PROPS[property]) return;
      var cleaned = safeValue(part.slice(index + 1).trim(), prefix);
      if (cleaned !== null && cleaned !== '') out.push(property + ':' + cleaned);
    });
    return out.join(';');
  }

  function cleanAttributes(elementName, attrs, prefix) {
    var out = Object.create(null);
    Object.keys(attrs).forEach(function (rawName) {
      var lower = rawName.toLowerCase();
      if (lower === 'xlink:href') lower = 'href';
      if (lower.indexOf('on') === 0 || lower.indexOf('xmlns') === 0 || lower.indexOf('xml:') === 0) return;
      var raw = attrs[rawName];
      if (lower === 'id') {
        if (/^[A-Za-z][\w-]{0,40}$/.test(raw)) out.id = prefix + raw;
        return;
      }
      if (lower === 'href') {
        if (!ANIM_ELEMENTS[elementName] && HREF_ELEMENTS[elementName] && /^#[A-Za-z][\w-]{0,40}$/.test(raw)) out.href = '#' + prefix + raw.slice(1);
        return;
      }
      if (lower === 'style') {
        var style = sanitizeStyle(raw, prefix);
        if (style) out.style = style;
        return;
      }
      if (lower === 'attributename') {
        if (ANIM_ELEMENTS[elementName] && ANIM_TARGETS[String(raw).trim().toLowerCase()]) out.attributeName = String(raw).trim();
        return;
      }
      var canonical = ATTRS[lower];
      if (!canonical) return;
      var value = safeValue(raw, prefix, canonical === 'd' || canonical === 'path' || canonical === 'points' ? MAX_PATH_ATTR : MAX_ATTR);
      if (value !== null) out[canonical] = value;
    });
    return out;
  }

  function sanitizeSvg(nodes, prefix) {
    var rootNode = findSvgRoot(nodes);
    if (!rootNode) return { ok: false, error: 'No <svg> element found' };
    var count = 0;
    var overflow = false;
    prefix = prefix || '';

    function clean(node, depth) {
      if (overflow) return null;
      if (node.text !== undefined) return null;
      var canonical = ELEMENTS[node.name];
      if (!canonical || depth > MAX_DEPTH || /^(?:filter|fe)/i.test(canonical)) return null;
      count++;
      if (count > MAX_NODES) { overflow = true; return null; }
      var attrs = cleanAttributes(node.name, node.attrs, prefix);
      if (ANIM_ELEMENTS[node.name] && !attrs.attributeName && node.name !== 'animatemotion') return null;
      if (node.name === 'use' && !attrs.href) return null;
      var out = { name: canonical, attrs: attrs, kids: [] };
      var textBudget = MAX_TEXT;
      node.kids.forEach(function (child) {
        if (child.text !== undefined) {
          if (!TEXT_ELEMENTS[node.name] || textBudget <= 0) return;
          var text = child.text.replace(/\u0000/g, '').slice(0, textBudget);
          textBudget -= text.length;
          if (text) out.kids.push({ text: text });
          return;
        }
        var cleaned = clean(child, depth + 1);
        if (cleaned) out.kids.push(cleaned);
      });
      return out;
    }

    var cleanedRoot = clean(rootNode, 0);
    if (overflow) return { ok: false, error: 'Drawing has too many elements' };
    if (!cleanedRoot) return { ok: false, error: 'Unsupported drawing' };
    var attrs = cleanedRoot.attrs;
    var width = parseFloat(attrs.width);
    var height = parseFloat(attrs.height);
    var box = String(attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0 || box.some(function(v){return Math.abs(v)>100000;})) {
      attrs.viewBox = isFinite(width) && isFinite(height) && width > 0 && height > 0 ? '0 0 ' + width + ' ' + height : '0 0 400 300';
    }
    delete attrs.width;
    delete attrs.height;
    delete attrs.style;
    delete attrs.id;
    attrs.preserveAspectRatio = attrs.preserveAspectRatio || 'xMidYMid meet';
    attrs.role = 'img';
    return { ok: true, root: cleanedRoot };
  }

  function escapeText(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(value) {
    return escapeText(value).replace(/"/g, '&quot;');
  }
  function svgToString(node) {
    if (node.text !== undefined) return escapeText(node.text);
    var attrs = Object.keys(node.attrs).map(function (key) { return ' ' + key + '="' + escapeAttr(node.attrs[key]) + '"'; }).join('');
    return '<' + node.name + attrs + '>' + node.kids.map(svgToString).join('') + '</' + node.name + '>';
  }

  var svgCounter = 0;
  function parseAndSanitizeSvg(source, prefix) {
    var text = String(source || '');
    if (text.length > MAX_SVG_CHARS) return { ok: false, error: 'Drawing is too large' };
    var parsed = parseMarkup(text);
    if (!parsed.ok) return parsed;
    return sanitizeSvg(parsed.nodes, prefix);
  }

  function buildSvgElement(doc, node, isRoot) {
    var element = doc.createElementNS(SVG_NS, node.name);
    Object.keys(node.attrs).forEach(function (key) {
      if (key === 'href') element.setAttribute('href', node.attrs[key]);
      else element.setAttribute(key, node.attrs[key]);
    });
    if (isRoot) element.setAttribute('style', 'display:block;width:100%;height:auto;max-height:78vh');
    node.kids.forEach(function (child) {
      if (child.text !== undefined) element.appendChild(doc.createTextNode(child.text));
      else element.appendChild(buildSvgElement(doc, child, false));
    });
    return element;
  }

  // ---------------------------------------------------------------------------------------------

  root.__sdGenUISvg = { parse: parseAndSanitizeSvg, serialize: svgToString, build: buildSvgElement };
})(window);
