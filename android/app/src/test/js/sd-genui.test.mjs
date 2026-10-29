import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bds = path.join(here, '../../main/bds-assets/bds');
const SOURCE = fs.readFileSync(path.join(bds, 'sd-genui.js'), 'utf8');
const CSS = fs.readFileSync(path.join(bds, 'sd-genui.css'), 'utf8');
const INJECTED = fs.readFileSync(path.join(bds, 'injected.js'), 'utf8');

function loadApi() {
  const window = { navigator: { language: 'en' } };
  const context = vm.createContext({ window, document: { body: null }, console });
  vm.runInContext(SOURCE, context, { filename: 'sd-genui.js' });
  return window.__sdGenUI;
}

function calculatorSpec() {
  return {
    version: 1,
    theme: 'glass',
    layout: 'dashboard',
    accent: 'teal',
    title: 'Compound growth',
    components: [
      { type: 'slider', id: 'principal', label: 'Principal', min: 1000, max: 50000, step: 500, value: 10000, format: 'currency' },
      { type: 'slider', id: 'rate', label: 'Annual return', min: 0, max: 15, step: 0.5, value: 7, format: 'percent' },
      { type: 'slider', id: 'years', label: 'Years', min: 1, max: 40, step: 1, value: 20, format: 'integer' },
      { type: 'stat', label: 'Future value', formula: 'principal * pow(1 + rate / 100, years)', format: 'currency' },
      { type: 'chart', kind: 'line', title: 'Growth', data: [
        { label: 'Start', formula: 'principal' },
        { label: 'Future', formula: 'principal * pow(1 + rate / 100, years)' }
      ] }
    ]
  };
}

test('parses a calculator with configurable premium layout and evaluates formulas', () => {
  const ui = loadApi();
  const parsed = ui.parseSpec(JSON.stringify(calculatorSpec()));
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.spec.theme, 'glass');
  assert.equal(parsed.spec.layout, 'dashboard');
  assert.equal(parsed.spec.accent, 'teal');
  assert.match(SOURCE, /sd-genui-layout-.*spec\.layout/);
  const state = { principal: 10000, rate: 7, years: 20 };
  assert.equal(ui.evaluateFormula('principal * pow(1 + rate / 100, years)', state), 10000 * Math.pow(1.07, 20));
  assert.equal(ui.evaluateFormula('max(4, round(3.6)) + sqrt(16)', state), 8);
  assert.equal(ui.formatValue(7, 'percent'), '7%');
});

test('parses visual composition blocks, curated icons and donut charts', () => {
  const ui = loadApi();
  const parsed = ui.parseSpec({
    version: 1,
    theme: 'editorial',
    accent: 'rose',
    components: [
      { type: 'hero', eyebrow: 'Overview', title: 'A premium dashboard', subtitle: 'Key insight', value: 42, format: 'integer', icon: 'trending-up', accent: 'teal' },
      { type: 'callout', tone: 'success', title: 'On track', text: 'All checks pass.', icon: 'check-circle' },
      { type: 'list', title: 'Highlights', items: [{ title: 'First', text: 'Detail', icon: 'star' }, 'Second'] },
      { type: 'steps', title: 'Workflow', items: [{ title: 'Plan', status: 'done' }, { title: 'Build', status: 'active' }] },
      { type: 'timeline', title: 'Timeline', events: [{ date: 'Today', title: 'Started', tone: 'success' }] },
      { type: 'quote', text: 'A useful principle', attribution: 'Team', role: 'Product' },
      { type: 'icon', name: 'rocket', label: 'Launch', size: 'lg' },
      { type: 'divider', label: 'Details' },
      { type: 'chart', kind: 'donut', title: 'Mix', data: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }] },
      { type: 'comparison', title: 'Choose a plan', items: [{ title: 'Basic', price: 0, features: ['Core features'] }, { title: 'Plus', price: 12, period: '/ month', highlighted: true, badge: 'Recommended', features: ['Everything in Basic', 'Priority support'] }] },
      { type: 'diagram', title: 'Request flow', description: 'How a request moves through the system', nodes: [{ id: 'client', title: 'Client', text: 'Starts request', kind: 'primary', column: 0, row: 0 }, { id: 'api', title: 'API', text: 'Validates request', kind: 'neutral', column: 1, row: 0 }, { id: 'store', title: 'Database', text: 'Returns data', kind: 'success', column: 2, row: 0 }], edges: [{ from: 'client', to: 'api', label: 'HTTPS' }, { from: 'api', to: 'store', label: 'Query' }] }
    ]
  });
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.spec.components[0].icon, 'trending-up');
  assert.equal(parsed.spec.components[1].tone, 'success');
  assert.equal(parsed.spec.components[2].items.length, 2);
  assert.equal(parsed.spec.components[8].kind, 'donut');
  assert.equal(parsed.spec.components[9].items.length, 2);
  assert.equal(parsed.spec.components[9].items[1].highlighted, true);
  assert.equal(parsed.spec.components[10].type, 'diagram');
  assert.equal(parsed.spec.components[10].nodes.length, 3);
  assert.equal(parsed.spec.components[10].edges[0].from, 'client');
  assert.match(SOURCE, /sd-genui-diagram-svg/);
  assert.match(CSS, /sd-genui-diagram-node-bg/);
  assert.match(SOURCE, /data-sd-genui-template/);
  assert.match(CSS, /sd-genui-compare-featured/);
  const inheritedAccent = ui.parseSpec({ version: 1, accent: 'rose', components: [{ type: 'hero', title: 'Inherits theme accent' }] });
  assert.equal(inheritedAccent.ok, true);
  assert.equal(inheritedAccent.spec.components[0].accent, 'rose');
  const fallback = ui.parseSpec({ version: 1, theme: 'external-css', accent: 'url()', components: [{ type: 'icon', name: '<script>', label: '<img>' }] });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.spec.theme, 'aurora');
  assert.equal(fallback.spec.accent, 'violet');
  assert.equal(fallback.spec.components[0].name, 'sparkles');
  assert.equal(fallback.spec.components[0].label, '<img>');
});

test('rejects unknown components, duplicate controls and oversized specs', () => {
  const ui = loadApi();
  assert.equal(ui.parseSpec({ version: 1, components: [{ type: 'html', value: '<script>alert(1)</script>' }] }).ok, false);
  assert.equal(ui.parseSpec({ version: 1, components: [{ type: 'diagram', nodes: [{ id: 'only', title: 'Only' }, { id: 'other', title: 'Other' }], edges: [{ from: 'only', to: 'missing' }] }] }).ok, false);
  assert.equal(ui.parseSpec({ version: 1, components: [
    { type: 'slider', id: 'amount', label: 'Amount', min: 0, max: 10, value: 5 },
    { type: 'toggle', id: 'amount', label: 'Duplicate', value: true }
  ] }).ok, false);
  assert.equal(ui.parseSpec(' '.repeat(25001)).ok, false);
  assert.equal(ui.parseSpec({ version: 1, components: [{ type: 'timeline', events: Array.from({ length: 11 }, (_, index) => ({ title: String(index) })) }] }).ok, false);
});

test('formula evaluation refuses arbitrary JavaScript, unknown values and division by zero', () => {
  const ui = loadApi();
  assert.throws(() => ui.evaluateFormula('globalThis.process.exit(1)', {}));
  assert.throws(() => ui.evaluateFormula('secret + 1', {}));
  assert.throws(() => ui.evaluateFormula('10 / 0', {}));
  assert.equal(ui.parseSpec({ version: 1, components: [
    { type: 'stat', label: 'Bad formula', formula: 'window.location' }
  ] }).ok, false);
});

test('renderer, theme styles and prompt use an allowlist instead of dynamic code execution', () => {
  assert.match(SOURCE, /language-sds-ui/);
  assert.match(SOURCE, /data-sd-genui-hidden/);
  assert.doesNotMatch(SOURCE, /\beval\s*\(|new Function|innerHTML\s*=/);
  assert.match(SOURCE, /ICON_PATHS/);
  assert.match(CSS, /data-theme=midnight/);
  assert.match(CSS, /sd-genui-item-hero/);
  assert.match(SOURCE, /component\.value !== '' \|\| component\.formula/);
  assert.match(CSS, /sd-genui-item-hero\[data-accent=teal\]/);
  assert.match(INJECTED, /SDS GenUI v1/);
  assert.match(INJECTED, /Supported component types/);
  assert.match(INJECTED, /Premium visual direction/);
  assert.ok(INJECTED.includes('diagram {title,description,nodes'));
  assert.ok(INJECTED.includes('visual design|visual aid|illustrate|diagram|infographic|poster'));
  assert.ok(INJECTED.includes('app screen|screen design|mobile screen|website design|web page design|prototype|layout'));
  assert.ok(INJECTED.includes('ইউআই|ইন্টারফেস|স্ক্রিন|নকশা|বানাও|তৈরি কর|আঁকো|প্রোটোটাইপ'));
  assert.match(INJECTED, /explicitly asks you to design, visualize, draw, map, diagram/);
  assert.match(INJECTED, /NEVER invent factual numbers, sources, outcomes or progress/);
  assert.doesNotThrow(() => new Function(INJECTED), 'injected.js must parse as one complete script');
  assert.match(INJECTED, /explainer\|how to\|how does/);
  assert.match(INJECTED, /3–7 component composition/);
  assert.match(INJECTED, /comparison \{title,items\}/);
});
