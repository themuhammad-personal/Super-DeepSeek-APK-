// Generative UI compliance harness.
//
// Measures how real model responses follow the GenUI protocol, using the SAME
// parser/validators the app ships (sd-genui-protocol / sd-genui / svg
// sanitizer / prompt.analyze). It never invents numbers: with zero real
// samples it reports "not measured".
//
//   npm run genui:compliance                     # docs/genui/compliance/samples
//   node scripts/genui-compliance.mjs <dir>      # any folder of .md/.txt samples
//   node scripts/genui-compliance.mjs --self-test  # harness check on synthetic fixtures
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BDS = path.join(ROOT, 'android/app/src/main/bds-assets/bds');
const selfTest = process.argv.includes('--self-test');
const dirArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const DIR = selfTest ? path.join(ROOT, 'scripts/fixtures/compliance') : path.resolve(dirArg || path.join(ROOT, 'docs/genui/compliance/samples'));
const OUT = path.join(ROOT, 'docs/genui/compliance');

function engine() {
  const window = { navigator: { language: 'en' } };
  window.window = window;
  const ctx = vm.createContext({ window, globalThis: window, document: { body: null }, console, URL });
  for (const f of ['sd-genui-protocol.js', 'sd-genui-svg.js', 'sd-genui.js', 'sd-genui-prompt.js']) vm.runInContext(fs.readFileSync(path.join(BDS, f), 'utf8'), ctx, { filename: f });
  return window.__sdGenUIPrompt;
}
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const meta = {};
  if (!m) return { meta, body: text };
  m[1].split(/\r?\n/).forEach((line) => { const kv = /^([A-Za-z_]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line); if (kv) meta[kv[1].toLowerCase()] = kv[2]; });
  return { meta, body: text.slice(m[0].length) };
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + '%' : 'n/a');

const P = engine();
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /\.(md|txt)$/i.test(f) && f.toLowerCase() !== 'readme.md').sort() : [];
const rows = [];
for (const f of files) {
  const { meta, body } = frontMatter(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (meta.synthetic === 'true' && !selfTest) continue;
  const a = P.analyze(body);
  rows.push({ file: f, prompt: meta.prompt || '', expect: meta.expect === 'prose' ? 'prose' : 'visual', ...a, blocks: a.blocks.map((b) => ({ lang: b.lang, ok: b.ok, kind: b.kind, error: b.error, format: b.format })) });
}
const visualExpected = rows.filter((r) => r.expect === 'visual');
const proseExpected = rows.filter((r) => r.expect === 'prose');
const allTyped = rows.reduce((n, r) => n + r.typed, 0);
const allTypedValid = rows.reduce((n, r) => n + r.typedValid, 0);
const summary = {
  measuredAt: new Date().toISOString(),
  source: selfTest ? 'SYNTHETIC FIXTURES (harness self-test — not model compliance)' : DIR,
  samples: rows.length,
  visualExpected: visualExpected.length,
  proseExpected: proseExpected.length,
  usedTypedProtocol: visualExpected.filter((r) => r.typed > 0).length,
  fullyCompliant: visualExpected.filter((r) => r.compliant).length,
  renderableAnyway: visualExpected.filter((r) => r.typedValid > 0 || r.rawRenderable > 0).length,
  rawFallbackOnly: visualExpected.filter((r) => r.typed === 0 && r.rawFallback > 0).length,
  noVisual: visualExpected.filter((r) => r.visual === 0).length,
  truncated: rows.filter((r) => r.unclosed).length,
  typedBlocks: allTyped,
  typedBlocksValid: allTypedValid,
  proseFalsePositives: proseExpected.filter((r) => r.visual > 0).length
};
const errors = {};
rows.forEach((r) => r.blocks.forEach((b) => { if (!b.ok) errors[b.error] = (errors[b.error] || 0) + 1; }));

if (selfTest) {
  // Harness correctness on hand-written fixtures; these are NOT model numbers.
  assert.equal(summary.samples, 5);
  assert.equal(summary.usedTypedProtocol, 2); // the truncated block never closed, so it is not a usable typed block
  assert.equal(summary.fullyCompliant, 1);
  assert.equal(summary.rawFallbackOnly, 1);
  assert.equal(summary.renderableAnyway, 2);
  assert.equal(summary.truncated, 1);
  assert.equal(summary.proseFalsePositives, 0);
  console.log('compliance harness self-test passed', JSON.stringify(summary));
  process.exit(0);
}

const md = [
  '# Generative UI compliance report',
  '',
  `Measured: ${summary.measuredAt}  `,
  `Samples folder: \`${path.relative(ROOT, DIR) || DIR}\``,
  ''
];
if (!rows.length) {
  md.push('**Not measured.** There are no real model samples yet, so no compliance number is claimed.', '', 'See `docs/genui/compliance/samples/README.md` for how to collect samples, then re-run `npm run genui:compliance`.');
} else {
  md.push(
    '| Metric | Value |', '|---|---|',
    `| Samples (visual expected / prose expected) | ${summary.samples} (${summary.visualExpected} / ${summary.proseExpected}) |`,
    `| Visual requests that used the typed protocol | ${summary.usedTypedProtocol} (${pct(summary.usedTypedProtocol, summary.visualExpected)}) |`,
    `| Visual requests fully compliant (all typed blocks valid) | ${summary.fullyCompliant} (${pct(summary.fullyCompliant, summary.visualExpected)}) |`,
    `| Visual requests that render anyway (typed or raw fallback) | ${summary.renderableAnyway} (${pct(summary.renderableAnyway, summary.visualExpected)}) |`,
    `| Raw \`html\`/\`svg\` only (fallback renderer) | ${summary.rawFallbackOnly} |`,
    `| Visual requests with no visual block | ${summary.noVisual} |`,
    `| Typed blocks valid / total | ${summary.typedBlocksValid} / ${summary.typedBlocks} (${pct(summary.typedBlocksValid, summary.typedBlocks)}) |`,
    `| Truncated (unclosed fence) responses | ${summary.truncated} |`,
    `| Prose requests that got a visual anyway | ${summary.proseFalsePositives} |`,
    '', '## Failure reasons', '',
    ...(Object.keys(errors).length ? Object.entries(errors).sort((a, b) => b[1] - a[1]).map(([e, n]) => `- ${n} × ${e}`) : ['- none']),
    '', '## Per sample', '', '| File | Expect | Typed (valid) | Raw | Compliant |', '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.file} | ${r.expect} | ${r.typed} (${r.typedValid}) | ${r.rawFallback} | ${r.compliant ? 'yes' : 'no'} |`),
    '', `Small samples are noisy: with n=${summary.visualExpected} visual samples, treat percentages as rough estimates.`
  );
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'REPORT.md'), md.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ summary, errors, rows }, null, 2));
console.log(md.join('\n'));
