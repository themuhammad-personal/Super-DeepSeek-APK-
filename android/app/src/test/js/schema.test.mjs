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
  const context = vm.createContext({ window, document: { body: null }, console, Math, JSON });
  vm.runInContext(SOURCE, context, { filename: 'sd-genui.js' });
  return window.__sdGenUI;
}

test('formula engine handles the zero-rate loan case exactly', () => {
  const ui = loadApi();
  assert.ok(ui && ui.version === 1);
  // Zero annual rate must reduce to principal / periods — no NaN, no Infinity.
  const emi = ui.evaluateFormula('principal / (years * 12)', { principal: 120000, years: 2 });
  assert.equal(emi, 5000);
  const zeroGuard = ui.parseSpec({ version: 1, components: [
    { type: 'slider', id: 'principal', label: 'Principal', min: 0, max: 1000000, step: 1000, value: 120000 },
    { type: 'slider', id: 'years', label: 'Years', min: 1, max: 40, step: 1, value: 2 },
    { type: 'stat', label: 'Payment', formula: 'principal / (years * 12)', format: 'currency' }
  ] });
  assert.equal(zeroGuard.ok, true, zeroGuard.error);
});

test('format values are deterministic and safe', () => {
  const ui = loadApi();
  assert.equal(ui.formatValue(7, 'percent'), '7%');
  assert.equal(ui.formatValue(2167.1, 'currency'), '$2,167.10');
  assert.equal(ui.formatValue(0, 'integer'), '0');
});

test('injected prompt carries the full Generative UI contract', () => {
  // Regression guard: this block was silently lost in a workspace restore once.
  assert.ok(INJECTED.includes('Generative UI preparation and output selection'), 'prompt extension present');
  assert.ok(INJECTED.includes('Custom application contract'), 'artifact contract documented');
  assert.ok(INJECTED.includes('MUST include one or more visual blocks'), 'multi-block instruction present');
  assert.ok(INJECTED.includes('mcp-app'), 'MCP app contract documented');
  assert.ok(INJECTED.includes('tool-result'), 'tool-result contract documented');
  assert.ok(INJECTED.includes('html-app'), 'offline app contract documented');
  assert.ok(!INJECTED.includes('MUST include ONE fenced code block'), 'old single-block wording gone');
});

test('stylesheet covers inline visuals, artifact cards/viewer, reduced motion and dark theme', () => {
  assert.ok(CSS.includes('prefers-reduced-motion:reduce'), 'reduced motion');
  for (const sel of ['.sd-vis{', '.sd-art{', '.sd-viewer{', '.sd-viewer-head', '.sd-seg', '.sd-code-gutter', '.sd-mcp{', '.sd-menu{', '[data-sd-hidden]']) assert.ok(CSS.includes(sel), sel);
  assert.ok(CSS.includes(':root[data-sd-theme=dark]'), 'host-theme driven dark tokens');
  assert.ok(CSS.includes('.sd-files-progress{') && CSS.includes('.sd-files-progress-stop'), 'file preparation progress and Stop styles');
  assert.ok(!CSS.includes('.sd-artifact-'), 'old card-in-card artifact styles removed');
});

test('runtime refuses prototype pollution and never executes spec content', () => {
  const PROTO = fs.readFileSync(path.join(bds, 'sd-genui-protocol.js'), 'utf8');
  assert.ok(PROTO.includes('__proto__'), 'reserved-key guard present in protocol');
  assert.ok(!/\.innerHTML\s*=\s*spec/.test(SOURCE), 'spec objects never assigned to innerHTML');
  const FRAME = fs.readFileSync(path.join(bds, 'sd-genui-frame.js'), 'utf8');
  assert.ok(!/allow-same-origin/.test(FRAME.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'generated frames never get allow-same-origin');
  const ui = loadApi();
  const bad = ui.parseSpec({ version: 1, components: [{ type: 'slider', id: 'a', label: 'A', min: 0, max: 1, value: 0 }, { type: 'stat', label: 'x', formula: 'globalThis.process' }] });
  assert.equal(bad.ok, false, 'formula cannot reach globals');
});
