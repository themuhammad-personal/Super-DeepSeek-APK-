import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '..', '..', 'main', 'bds-assets', 'bds', 'sd-genui-svg.js'), 'utf8');
const context = vm.createContext({
  window: {}, document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {} }) },
  navigator: { userAgent: 'node-test' }, console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, isNaN, parseFloat, parseInt,
});
context.window = context;
vm.runInContext(code, context);
const svg = context.__sdGenUISvg;
assert.ok(svg && typeof svg.parse === 'function' && typeof svg.serialize === 'function' && typeof svg.build === 'function', 'API surface');

test('parse accepts a clean SVG and rebuilds a sanitized tree', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#5b8def"/></svg>');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.root.name, 'svg');
});

test('script and event handlers are stripped', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" onload="alert(1)"><script>alert(1)</script><rect width="4" height="4" onclick="x()"/></svg>');
  assert.equal(r.ok, true, r.error);
  const out = svg.serialize(r.root);
  assert.ok(!out.includes('script'), 'no script tag');
  assert.ok(!out.includes('onload'), 'no event attributes');
  assert.ok(!out.includes('onclick'), 'no event attributes on children');
});

test('non-SVG documents fail closed', () => {
  assert.equal(svg.parse('<html><body>x</body></html>').ok, false);
  assert.equal(svg.parse('hello world').ok, false);
  assert.equal(svg.parse('').ok, false);
  assert.equal(svg.parse(null).ok, false);
});

test('oversized drawings are refused with a reason', () => {
  const huge = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' + '<rect width="1" height="1"/>'.repeat(4000) + '</svg>';
  const r = svg.parse(huge);
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 3);
  const long = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' + '<!--' + 'x'.repeat(300000) + '--></svg>';
  assert.equal(svg.parse(long).ok, false);
});

test('external references are removed', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><image href="https://evil.example/x.png"/><rect width="2" height="2" fill="url(#grad)"/><foreignObject><div>x</div></foreignObject></svg>');
  assert.equal(r.ok, true, r.error);
  const out = svg.serialize(r.root);
  assert.ok(!out.includes('evil.example'), 'no external image href');
  assert.ok(!out.includes('foreignObject'), 'no foreignObject');
});

test('javascript: URLs are removed', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><a href="javascript:alert(1)"><text>x</text></a></svg>');
  assert.equal(r.ok, true, r.error);
  assert.ok(!svg.serialize(r.root).toLowerCase().includes('javascript:'));
});

test('serialization is deterministic', () => {
  const input = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>';
  const a = svg.serialize(svg.parse(input).root);
  const b = svg.serialize(svg.parse(input).root);
  assert.equal(a, b);
  assert.ok(a.startsWith('<svg'));
});

test('build creates an inline element for chat rendering', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="4" height="4"/></svg>');
  const doc = {
    createElementNS: (ns, name) => ({ ns, name, attrs: {}, kids: [], setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); } }),
    createTextNode: (text) => ({ text }),
  };
  const el = svg.build(doc, r.root, true);
  assert.ok(el);
  assert.equal(el.name, 'svg');
  assert.equal(el.attrs.style, 'display:block;width:100%;height:auto;max-height:78vh');
  assert.equal(el.kids.length, 1);
  assert.equal(el.kids[0].name, 'rect');
});

test('unknown tags and attributes are dropped', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><evil tag="1" evil-attr="2"/><rect width="2" height="2" evil-attr="3"/></svg>');
  assert.equal(r.ok, true, r.error);
  const out = svg.serialize(r.root);
  assert.ok(!out.includes('evil'), 'unknown tags gone');
  assert.ok(!out.includes('evil-attr'), 'unknown attrs gone');
});

test('nested structure depth is bounded', () => {
  let inner = '<rect width="1" height="1"/>';
  for (let i = 0; i < 400; i++) inner = `<g>${inner}</g>`;
  const r = svg.parse(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${inner}</svg>`);
  assert.equal(r.ok, false);
});

test('animate elements keep only SMIL-safe attributes', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4"><animate attributeName="r" from="4" to="8" dur="1s" repeatCount="indefinite"/></circle></svg>');
  assert.equal(r.ok, true, r.error);
  const out = svg.serialize(r.root);
  assert.ok(out.includes('animate'), 'animation survives');
  assert.ok(out.includes('attributeName'), 'presentation SMIL attr kept');
});

test('namespaced attributes like xlink:href are validated', () => {
  const r = svg.parse('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16"><use xlink:href="#p"/></svg>');
  assert.equal(r.ok, true, r.error);
  const out = svg.serialize(r.root);
  assert.ok(!out.includes('javascript:'));
});

test('parse enforces a character budget before deep work', () => {
  const giant = '<svg xmlns="http://www.w3.org/2000/svg">' + '<!--' + 'a'.repeat(500000) + '--><rect/></svg>';
  const r = svg.parse(giant);
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});
