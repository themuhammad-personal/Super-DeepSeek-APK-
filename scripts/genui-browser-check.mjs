// Generative UI acceptance suite (v3) — real Chromium against the real engine
// assets in a DeepSeek-shaped fixture with a mocked native bridge and a mocked
// MCP transport. This is NOT Android WebView validation and NOT live-model testing.
//
//   node scripts/genui-browser-check.mjs            # all acceptance checks
//   CHROMIUM_PATH=/path/to/chrome node scripts/...  # custom browser
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa/genui');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const defaultShell = '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';
const executablePath = process.env.CHROMIUM_PATH || (!fs.existsSync(chromium.executablePath()) && fs.existsSync(defaultShell) ? defaultShell : undefined);
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await fsp.mkdir(OUT, { recursive: true });

const results = [];
async function fresh(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: opts.height || 844 }, colorScheme: opts.dark ? 'dark' : 'light' });
  // Offline by design: CDN requests from generated frames are answered locally so
  // the suite is deterministic (Chart.js etc. are not needed by these fixtures).
  await ctx.route(/^https:\/\//, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* offline stub */' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/design-preview/${opts.file || 'genui.html'}${opts.query || ''}`);
  if (opts.dark) await page.evaluate(() => document.body.classList.add('dark'));
  return { ctx, page, errors };
}
const ONLY = process.env.GENUI_ONLY ? new RegExp(process.env.GENUI_ONLY) : null;
async function test(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t0 }); console.log('ok   ', name); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t0, error: String(e && e.stack || e).slice(0, 1200) }); console.log('FAIL ', name, '\n', e); }
}
const calls = (page, m) => page.evaluate((m) => window.__bridgeCalls.filter((c) => c.m === m), m);
const settle = (page, ms = 250) => page.waitForTimeout(ms);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const shot = (page, name, full = true) => page.screenshot({ path: path.join(OUT, name), fullPage: full });
const viewerMenu = async (page, item) => {
  await page.locator('#sd-viewer .sd-copy-more').click();
  await page.locator('#sd-viewer .sd-menu:not(.sd-ver-menu)').getByRole('menuitem', { name: item }).click();
};

const APP = [
  'id: tip-calc', 'kind: html-app', 'title: Tip calculator', '---',
  '<!doctype html><html><head><title>t</title><style>main{padding:16px}button{min-height:44px}</style></head>',
  '<body><main><h1>Split the bill</h1><button id="b">Count: 0</button></main>',
  '<script>var n=0;document.getElementById("b").onclick=function(){this.textContent="Count: "+(++n)}</script></body></html>'
].join('\n');
const APP_V2 = APP.replace('Split the bill', 'Split the bill v2').replace('Count: 0', 'Total: 0');
const VIS = [
  'title: How a request flows',
  '<svg viewBox="0 0 400 260" width="100%"><g class="c-blue"><rect x="120" y="10" width="160" height="56" rx="10"/><text class="th" x="200" y="43" text-anchor="middle">Browser</text></g>',
  '<g class="c-teal"><rect x="120" y="100" width="160" height="56" rx="10"/><text class="th" x="200" y="133" text-anchor="middle">Server</text></g>',
  '<g class="c-purple"><rect x="120" y="190" width="160" height="56" rx="10"/><text class="th" x="200" y="223" text-anchor="middle">Database</text></g>',
  '<line class="arr" x1="200" y1="66" x2="200" y2="100"/><line class="arr" x1="200" y1="156" x2="200" y2="190"/></svg>',
  '<div class="row"><button id="ask" onclick="sendPrompt(\'Explain the server step\')">Explain server ↗</button></div>',
  '<script>document.getElementById("ask").dataset.ok="1";window.__parentReachable=(function(){try{return !!parent.document}catch(e){return false}})();document.body.dataset.parent=String(window.__parentReachable)</script>'
].join('\n');
const UI = JSON.stringify({ version: 1, title: 'Loan explorer', components: [
  { type: 'slider', id: 'principal', label: 'Principal', min: 1000, max: 500000, step: 1000, value: 100000, format: 'currency', currency: 'BDT' },
  { type: 'slider', id: 'rate', label: 'Rate %', min: 1, max: 20, step: 1, value: 10 },
  { type: 'stat', label: 'Monthly · 12 months', formula: 'principal * (rate / 1200) * pow(1 + rate / 1200, 12) / (pow(1 + rate / 1200, 12) - 1)', format: 'currency', currency: 'BDT' }
] });

try {
  await test('00 no raw-code flash: our blocks are hidden before the first paint, skeleton → surface; snippets stay code; old chats render at once; errors never show raw code', async () => {
    const { ctx, page, errors } = await fresh();
    const r = await page.evaluate(async () => {
      const out = {};
      const md = fx.message();
      // Banner first, empty body (how DeepSeek starts a fence), then text streams in.
      const pre = fx.block(md, 'sds-visual', '');
      await Promise.resolve();
      const c = pre.closest('.md-code-block');
      out.hiddenAtOnce = getComputedStyle(c).display === 'none';
      out.skeleton = !!(c.nextElementSibling && c.nextElementSibling.classList.contains('sd-skel'));
      fx.stream(pre, 'title: Bars\n<div style="height:80px;background:#4d6bfe">bars</div>');
      await Promise.resolve();
      out.stillHidden = getComputedStyle(c).display === 'none';
      // A raw ```html snippet is code the user asked for: never claimed.
      const snip = fx.block(md, 'html', '<button class="x">Click</button>');
      await Promise.resolve();
      out.snippetVisible = getComputedStyle(snip.closest('.md-code-block')).display !== 'none';
      // A raw complete document is claimed immediately.
      const doc = fx.block(md, 'html', '<!doctype html><html><body><h1>Doc</h1></body></html>');
      await Promise.resolve();
      out.docHidden = getComputedStyle(doc.closest('.md-code-block')).display === 'none';
      fx.para(md, 'after');
      return out;
    });
    assert.deepEqual(r, { hiddenAtOnce: true, skeleton: true, stillHidden: true, snippetVisible: true, docHidden: true });
    await page.locator('.sd-vis iframe').first().waitFor({ timeout: 6000 });
    await page.waitForFunction(() => document.querySelectorAll('.sd-skel').length === 0, null, { timeout: 6000 });
    // Old chat: a block in an earlier message is final at once (no 1.5 s stability wait).
    const t0 = Date.now();
    await page.evaluate(() => { const a = fx.message(); fx.block(a, 'sds-genui', 'id: old-one\nkind: document\ntitle: Old notes\n---\n# Old\ntext'); fx.message(); });
    await page.locator('.sd-art', { hasText: 'Old notes' }).waitFor({ timeout: 3000 });
    assert.ok(Date.now() - t0 < 1200, 'old-chat block rendered in ' + (Date.now() - t0) + 'ms');
    // Broken typed output becomes a source-only artifact; raw code stays hidden until opened.
    await page.evaluate(() => { const a = fx.message(); window.__brokenArtifactSource = fx.block(a, 'sds-genui', 'id: broken\nkind: ui\ntitle: Broken\n---\n{not json').closest('.md-code-block'); fx.para(a, 'x'); });
    const fallback = page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'Broken' }).last();
    await fallback.waitFor({ timeout: 4000 });
    const hidden = await page.evaluate(() => {
      const source = window.__brokenArtifactSource;
      return !!source && getComputedStyle(source).display === 'none';
    });
    assert.equal(hidden, true, 'raw code stays hidden behind the source-only artifact');
    assert.match(await fallback.locator('.sd-art-sub').textContent() || '', /Source only/);
    await fallback.click();
    await page.locator('#sd-viewer .sd-code').waitFor({ timeout: 4000 });
    assert.match(await page.locator('#sd-viewer .sd-code').textContent() || '', /\{not json/);
    await shot(page, '00-claim.png');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('01 html-app artifact → Claude-style card; viewer runs it live in an opaque sandbox; Code tab; full screen', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate((src) => { const md = fx.message(); fx.para(md, 'Here is your app.'); fx.block(md, 'sds-genui', src); fx.para(md, 'Done.'); }, APP);
    const card = page.locator('.sd-art[data-kind="html-app"]');
    await card.waitFor();
    assert.match(await card.locator('.sd-art-title').textContent(), /Tip calculator/);
    assert.equal(await page.locator('.md-code-block[data-sd-hidden="artifact"]').count(), 1, 'source block hidden behind the card');
    assert.equal(await card.locator('iframe').count(), 0, 'cards are compact: no preview inside the message');
    await shot(page, '01-card-mobile.png');
    await card.click();
    const viewer = page.locator('#sd-viewer');
    await viewer.waitFor();
    const frame = viewer.locator('iframe.sd-frame');
    await frame.waitFor();
    const sandbox = await frame.getAttribute('sandbox');
    assert.ok(sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'), sandbox);
    const fl = page.frameLocator('#sd-viewer iframe.sd-frame');
    await fl.locator('#b').click();
    assert.equal(await fl.locator('#b').textContent(), 'Count: 1', 'app script runs in the viewer');
    await shot(page, '01-viewer-preview.png', false);
    await viewer.getByRole('tab', { name: 'Code' }).click();
    await viewer.locator('.sd-code').waitFor();
    assert.match(await viewer.locator('.sd-code').textContent(), /Split the bill/);
    await shot(page, '01-viewer-code.png', false);
    await viewerMenu(page, 'Open in full screen');
    const opened = await calls(page, 'openGeneratedApp');
    assert.equal(opened.length, 1);
    assert.match(opened[0].html, /Content-Security-Policy/);
    assert.match(opened[0].html, /frame-src 'none'/);
    assert.match(opened[0].html, /textContent="Count: "/);
    assert.equal(await page.evaluate(() => window.__sdHandleBack()), true, 'Android back closes the viewer');
    assert.equal(await page.locator('#sd-viewer').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('02 JSON envelope in classic markdown DOM still works (svg artifact card + preview)', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => { const md = fx.message(); fx.classic(md, 'sds-genui', JSON.stringify({ version: 1, id: 'moon', kind: 'svg', title: 'Moon', payload: { svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="gold"/></svg>' } })); });
    const card = page.locator('.sd-art[data-kind="svg"]');
    await card.waitFor();
    await card.click();
    await page.frameLocator('#sd-viewer iframe.sd-frame').locator('circle').waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('02b JSON envelope honors explicit inline presentation instead of opening an artifact card', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => { const md = fx.message(); window.__inlinePre = fx.classic(md, 'sds-genui', JSON.stringify({ version: 1, id: 'inline-moon', kind: 'svg', title: 'Inline Moon', presentation: 'inline', payload: { svg: '<svg viewBox="0 0 10 10" width="100%"><circle cx="5" cy="5" r="4" fill="gold"/></svg>' } })); });
    const inline = page.locator('.sd-inline[data-kind="svg"]');
    await inline.waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.sd-art').count(), 0, 'explicit inline content is not stored as a card');
    const frame = page.locator('.sd-inline[data-kind="svg"] iframe.sd-frame');
    await frame.contentFrame().locator('circle').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => {
      const stage = document.querySelector('.sd-inline[data-kind="svg"] .sd-vis-stage');
      const frame = stage && stage.querySelector('iframe.sd-frame');
      return !!stage && !stage.classList.contains('sd-vis-loading') && !!frame &&
        frame.getBoundingClientRect().height > 30 && getComputedStyle(frame).opacity !== '0';
    }, null, { timeout: 5000 });
    const svg = frame.contentFrame().locator('#sds-root svg[viewBox]').first();
    let box = null, svgBox = null, contained = false;
    // SVG auto-height can settle after the frame's first boot/ResizeObserver tick.
    // Wait for the host resize to catch up instead of screenshotting a transient crop.
    for (let attempt = 0; attempt < 40; attempt++) {
      box = await frame.boundingBox();
      svgBox = await svg.boundingBox();
      contained = !!box && !!svgBox && svgBox.y + svgBox.height <= box.y + box.height + 2;
      if (contained) break;
      await page.waitForTimeout(75);
    }
    assert.ok(box && box.height > 30, 'inline SVG frame must have visible layout height');
    assert.ok(svgBox && svgBox.width > 30 && svgBox.height > 30, 'SVG must have a visible content box');
    assert.ok(contained, 'inline frame must eventually contain the full SVG; frame=' + JSON.stringify(box) + ' svg=' + JSON.stringify(svgBox));
    assert.deepEqual(errors, []);
    await shot(page, '02b-json-inline-presentation.png');
    // The same live code block may be revised by the model: inline → card must
    // clear the previous inline choice rather than leave stale state behind.
    await page.evaluate(() => {
      window.__inlinePre.textContent = JSON.stringify({ version: 1, id: 'inline-moon', kind: 'svg', title: 'Card Moon', payload: { svg: '<svg viewBox="0 0 10 10" width="100%"><circle cx="5" cy="5" r="4" fill="navy"/></svg>' } });
    });
    await page.locator('.sd-art[data-kind="svg"]').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('.sd-inline[data-kind="svg"]'), null, { timeout: 5000 });
    assert.equal(await page.locator('.sd-art[data-kind="svg"]').count(), 1, 'updated envelope without presentation returns to card mode');
    await ctx.close();
  });

  await test('02c streaming JSON switches to inline without leaving a busy card or transient viewer', async () => {
    const { ctx, page, errors } = await fresh();
    const beforeInline = '{"version":1,"kind":"svg","title":"Streaming Moon","payload":{"svg":"<svg viewBox=\\"0 0 10 10\\"';
    const duringInline = '{"version":1,"id":"stream-moon","kind":"svg","title":"Streaming Moon","presentation":"inline","payload":{"svg":"<svg viewBox=\\"0 0 10 10\\" width=\\"100%\\">';
    await page.evaluate((initial) => {
      window.__streamMd = fx.message();
      window.__streamPre = fx.block(window.__streamMd, 'sds-genui', initial);
    }, beforeInline);
    const busy = page.locator('.sd-art.sd-art-busy');
    await busy.waitFor({ timeout: 5000 });
    await busy.click();
    await page.locator('#sd-viewer .sd-code').waitFor({ timeout: 5000 });
    await page.evaluate((partial) => { window.__streamPre.textContent = partial; }, duringInline);
    await page.waitForFunction(() => !document.querySelector('.sd-art') && !document.querySelector('#sd-viewer'), null, { timeout: 5000 });
    await page.evaluate(() => {
      window.__streamPre.textContent = JSON.stringify({ version: 1, id: 'stream-moon', kind: 'svg', title: 'Streaming Moon', presentation: 'inline', payload: { svg: '<svg viewBox="0 0 10 10" width="100%"><circle cx="5" cy="5" r="4" fill="teal"/></svg>' } });
      fx.para(window.__streamMd, 'completed');
    });
    const inline = page.locator('.sd-inline[data-kind="svg"]');
    await inline.waitFor({ timeout: 5000 });
    const frame = inline.locator('iframe.sd-frame');
    await frame.contentFrame().locator('circle').waitFor({ timeout: 5000 });
    await page.waitForFunction(() => {
      const stage = document.querySelector('.sd-inline[data-kind="svg"] .sd-vis-stage');
      const frame = stage && stage.querySelector('iframe.sd-frame');
      return !!stage && !stage.classList.contains('sd-vis-loading') && !!frame && frame.getBoundingClientRect().height > 30;
    }, null, { timeout: 5000 });
    const svg = frame.contentFrame().locator('#sds-root svg[viewBox]').first();
    let frameBox = null, svgBox = null, contained = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      frameBox = await frame.boundingBox();
      svgBox = await svg.boundingBox();
      contained = !!frameBox && !!svgBox && svgBox.y + svgBox.height <= frameBox.y + frameBox.height + 2;
      if (contained) break;
      await page.waitForTimeout(75);
    }
    assert.ok(contained, 'streamed inline frame must contain the full SVG; frame=' + JSON.stringify(frameBox) + ' svg=' + JSON.stringify(svgBox));
    assert.equal(await page.locator('.sd-art').count(), 0);
    assert.equal(await page.locator('#sd-viewer').count(), 0);
    assert.deepEqual(errors, []);
    await shot(page, '02c-stream-inline-presentation.png');
    await ctx.close();
  });

  await test('02d renderer failure becomes a source-only downloadable artifact', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      delete window.__sdGenUI;
      const md = fx.message();
      fx.classic(md, 'sds-genui', JSON.stringify({ version: 1, id: 'fallback-widget', kind: 'ui', title: 'Fallback Widget', payload: { spec: { version: 1, components: [] } } }));
    });
    const card = page.locator('.sd-art[data-kind="code"]');
    await card.waitFor({ timeout: 5000 });
    assert.match(await card.locator('.sd-art-title').textContent() || '', /Fallback Widget/);
    assert.match(await card.locator('.sd-art-sub').textContent() || '', /source only/i);
    assert.equal(await page.locator('.sd-art-error').count(), 0);
    await card.click();
    await page.locator('#sd-viewer .sd-code').waitFor({ timeout: 5000 });
    assert.match(await page.locator('#sd-viewer .sd-code').textContent() || '', /components/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('02e malformed typed output remains downloadable as source instead of only an error card', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'sds-genui', 'id: broken-widget\nkind: ui\ntitle: Broken Widget\n---\n{not valid JSON');
      fx.para(md, 'done');
    });
    const card = page.locator('.sd-art[data-kind="code"]');
    await card.waitFor({ timeout: 7000 });
    assert.match(await card.locator('.sd-art-title').textContent() || '', /Broken Widget/);
    assert.match(await card.locator('.sd-art-sub').textContent() || '', /source only/i);
    assert.equal(await page.locator('.sd-art-error').count(), 0);
    await card.click();
    await page.locator('#sd-viewer .sd-code').waitFor({ timeout: 5000 });
    assert.match(await page.locator('#sd-viewer .sd-code').textContent() || '', /not valid JSON/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('02f id-less malformed blocks get isolated source-only artifacts', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'sds-genui', 'kind: ui\ntitle: First Broken Spec\n---\n{first: invalid');
      fx.para(md, 'between');
      fx.block(md, 'sds-genui', 'kind: ui\ntitle: Second Broken Spec\n---\n{second: invalid');
      fx.para(md, 'done');
    });
    const first = page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'First Broken Spec' });
    const second = page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'Second Broken Spec' });
    await first.waitFor(); await second.waitFor();
    assert.equal(await page.locator('.sd-art[data-kind="code"]').count(), 2);
    const keys = await page.evaluate(() => window.__sdGenUIViewer.store.list().filter(r => r.kind === 'code').map(r => r.key));
    assert.equal(new Set(keys).size, 2, 'source-only records must not collide');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('02g source fallback does not overwrite a prior working artifact version', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'sds-genui', 'id: stable-app\nkind: html-app\ntitle: Working App\n---\n<!doctype html><html><head><title>Working</title></head><body><h1>Working app</h1></body></html>');
      fx.para(md, 'next');
      fx.block(md, 'sds-genui', 'id: stable-app\nkind: ui\ntitle: Broken Revision\n---\n{not valid JSON');
      fx.para(md, 'done');
    });
    await page.locator('.sd-art[data-kind="html-app"]').filter({ hasText: 'Working App' }).waitFor();
    await page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'Broken Revision' }).waitFor();
    const recs = await page.evaluate(() => window.__sdGenUIViewer.store.list().map(r => ({ key: r.key, kind: r.kind, title: r.title, versions: r.versions.length })));
    assert.ok(recs.some(r => r.kind === 'html-app' && r.title === 'Working App' && r.key.endsWith(':stable-app')), JSON.stringify(recs));
    assert.ok(recs.some(r => r.kind === 'code' && r.title === 'Broken Revision' && r.key.includes(':stable-app-source-')), JSON.stringify(recs));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('02h uppercase streaming ID moves from transient viewer to source-only fallback', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      window.__streamBadMd = md;
      fx.block(md, 'sds-genui', 'id: My-Widget\nkind: svg\ntitle: Streaming broken SVG\n---\n');
    });
    const busy = page.locator('.sd-art.sd-art-busy');
    await busy.waitFor({ timeout: 4000 });
    await busy.click();
    await page.locator('#sd-viewer .sd-code').waitFor({ timeout: 4000 });
    await page.evaluate(() => fx.para(window.__streamBadMd, 'seal malformed block'));
    const card = page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'Streaming broken SVG' });
    await card.waitFor({ timeout: 7000 });
    await page.locator('#sd-viewer .sd-code').waitFor({ timeout: 5000 });
    assert.match(await page.locator('#sd-viewer .sd-code').textContent() || '', /Streaming broken SVG/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('02i preview circuit resets when Generative UI is toggled off and on', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      window.__failedPreviewMd = md;
      window.__savedGenUIForReset = window.__sdGenUI;
      delete window.__sdGenUI;
      for (let i = 0; i < 5; i++) {
        fx.classic(md, 'sds-genui', JSON.stringify({
          version: 1, id: 'breaker-' + i, kind: 'ui', title: 'Broken Preview ' + i,
          payload: { spec: { version: 1, components: [] } }
        }));
      }
      fx.para(md, 'finish broken preview batch');
    });
    await page.locator('.sd-art[data-kind="code"]').nth(4).waitFor({ timeout: 7000 });
    await page.evaluate(() => {
      const P = window.__sdGenUIPrompt;
      P.setConfig({ enabled: false });
      // Keep the deliberately broken historical fixtures from immediately
      // re-tripping the circuit when the feature is re-enabled.
      if (window.__failedPreviewMd) window.__failedPreviewMd.remove();
      window.__sdGenUI = window.__savedGenUIForReset;
      P.setConfig({ enabled: true });
      const md = fx.message();
      fx.classic(md, 'sds-genui', JSON.stringify({
        version: 1, id: 'after-reset', kind: 'html-app', title: 'After Reset',
        payload: { html: '<!doctype html><html><head><title>After Reset</title></head><body><h1>Ready</h1></body></html>' }
      }));
      fx.para(md, 'finish after reset');
    });
    await page.locator('.sd-art[data-kind="html-app"]').filter({ hasText: 'After Reset' }).waitFor({ timeout: 7000 });
    assert.equal(await page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'After Reset' }).count(), 0, 're-enabled GenUI should render a valid artifact normally');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('03 streaming: card shows "Generating…", viewer streams code, then exactly one card and live preview', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => { window.__md = fx.message(); window.__pre = fx.block(window.__md, 'sds-genui', ''); });
    const chunks = APP.match(/[\s\S]{1,50}/g);
    let sawBusy = false, openedWhileStreaming = false;
    for (let i = 0; i < chunks.length; i++) {
      await page.evaluate((c) => { window.__pre.textContent += c; }, chunks[i]);
      await page.waitForTimeout(60);
      if (await page.locator('.sd-art.sd-art-busy').count()) {
        sawBusy = true;
        if (!openedWhileStreaming && i > 4) { await page.locator('.sd-art').click(); openedWhileStreaming = true; await page.locator('#sd-viewer .sd-code').waitFor(); }
      }
    }
    assert.equal(sawBusy, true, 'generating state visible while streaming');
    assert.equal(openedWhileStreaming, true);
    await page.evaluate(() => fx.para(window.__md, 'Closing prose after the fence.'));
    await page.locator('.sd-art[data-kind="html-app"]:not(.sd-art-busy)').waitFor();
    await page.frameLocator('#sd-viewer iframe.sd-frame').locator('#b').waitFor({ timeout: 5000 });
    for (let i = 0; i < 4; i++) { await page.evaluate(() => fx.para(window.__md, 'more')); await settle(page, 60); }
    await settle(page, 400);
    assert.equal(await page.locator('.sd-art').count(), 1, 'no duplicate cards');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('04 malformed block → source-only card; unknown kinds are inferred; later blocks still render', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'sds-genui', 'id: broken\nkind: ui\ntitle: Broken UI\n---\n{"components": [oops');
      fx.para(md, 'between');
      fx.block(md, 'sds-genui', 'id: rocket\nkind: rocket-ship\ntitle: Rocket\n---\n<div><p>x</p></div>');
      fx.para(md, 'mid');
      fx.block(md, 'sds-genui', 'id: ok-svg\nkind: svg\ntitle: Fine\n---\n<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
      fx.para(md, 'after');
    });
    const source = page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'Broken UI' });
    await source.waitFor();
    assert.match(await source.locator('.sd-art-sub').textContent() || '', /source only/i);
    assert.equal(await page.locator('.sd-art-error').count(), 0);
    assert.equal(await page.locator('.md-code-block').first().isVisible(), false, 'raw code never shown by default');
    await page.locator('.sd-art', { hasText: 'Rocket' }).waitFor();
    await page.locator('.sd-art[data-kind="svg"]').waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('05 raw ```html document → artifact card (fallback renderer); short snippets stay code', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'html', '<!DOCTYPE html>\n<html><head><title>Pomodoro</title><style>body{font-family:sans-serif}</style></head><body><h1>Focus</h1><script>document.title="x"</script></body></html>');
      fx.para(md, 'And a snippet:');
      fx.block(md, 'html', '<button class="btn">Click</button>');
      fx.para(md, 'end');
    });
    const card = page.locator('.sd-art[data-kind="html-app"]');
    await card.waitFor();
    assert.match(await card.locator('.sd-art-title').textContent(), /Pomodoro/);
    await settle(page, 300);
    assert.equal(await page.locator('.sd-art').count(), 1, 'snippet must not become a card');
    assert.equal(await page.locator('.md-code-block').nth(1).isVisible(), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('06 raw ```svg renders inline inside a sandboxed frame; its scripts cannot reach the chat page', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      window.__pwned = 0;
      const md = fx.message();
      fx.block(md, 'svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="try{parent.__pwned=1}catch(e){}"><script>try{parent.__pwned=2}catch(e){}</script><circle cx="50" cy="50" r="40" fill="teal"/></svg>');
      fx.para(md, 'end');
    });
    const vis = page.locator('.sd-vis');
    await vis.waitFor();
    const sb = await vis.locator('iframe').getAttribute('sandbox');
    assert.ok(!sb.includes('allow-same-origin'));
    await page.frameLocator('.sd-vis iframe').locator('circle').waitFor();
    await settle(page, 400);
    assert.equal(await page.evaluate(() => window.__pwned), 0, 'opaque origin: no access to the parent');
    assert.equal(await page.locator('.sd-art').count(), 0, 'inline, not a card');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('07 ```sds-visual renders inline like ChatGPT/Claude visuals: auto height, theme, actions, sendPrompt', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate((vis) => { const md = fx.message(); fx.para(md, 'Here is how it flows:'); fx.block(md, 'sds-visual', vis); fx.para(md, 'The server does the work.'); }, VIS);
    const vis = page.locator('.sd-vis');
    await vis.waitFor();
    const fl = page.frameLocator('.sd-vis iframe');
    await fl.locator('#ask[data-ok="1"]').waitFor({ timeout: 5000 });
    assert.equal(await fl.locator('body').getAttribute('data-parent'), 'false', 'frame cannot touch the chat page');
    await page.waitForFunction(() => { const f = document.querySelector('.sd-vis iframe'); return f && parseInt(f.style.height, 10) > 150; }, null, { timeout: 5000 });
    assert.equal(await page.locator('.md-code-block[data-sd-hidden="inline"]').count(), 1);
    for (const label of ['Expand', 'Copy code', 'Download', 'Save as artifact', 'Show code']) assert.equal(await vis.getByRole('button', { name: label }).count(), 1, label);
    assert.equal(await fl.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await fl.locator('#sds-defs marker#sds-arrow').count(), 1, 'host arrowhead marker for .arr lines');
    const svgBox = await fl.locator('#sds-root svg').first().boundingBox(), rowBox = await fl.locator('.row').boundingBox();
    assert.ok(rowBox.y >= svgBox.y + svgBox.height - 1, 'HTML after an <svg> flows below it (not squeezed beside it)');
    assert.equal(await noOverflow(page), true, 'no horizontal overflow at 390px');
    await shot(page, '07-inline-visual-mobile.png');
    await fl.locator('#ask').click();
    await page.waitForFunction(() => /Explain the server step/.test(document.getElementById('composer').value) || !!document.querySelector('.sd-vis .sd-vis-note:not([hidden])'), null, { timeout: 3000 });
    if (!/Explain the server step/.test(await page.locator('#composer').inputValue())) {
      await vis.locator('.sd-vis-note .sd-chip').click();
      assert.match(await page.locator('#composer').inputValue(), /Explain the server step/);
    }
    await vis.getByRole('button', { name: 'Show code' }).click();
    assert.equal(await page.locator('.md-code-block[data-sd-hidden]').count(), 0, 'Show code reveals the source');
    await vis.getByRole('button', { name: 'Expand' }).click();
    await page.frameLocator('#sd-viewer iframe.sd-frame').locator('#ask').waitFor();
    await page.evaluate(() => window.__sdHandleBack());
    // sds-ui widgets still render inline with live formulas.
    await page.evaluate((ui) => { const md = fx.message(); fx.block(md, 'sds-ui', ui); }, UI);
    await page.locator('.sd-genui-surface[data-sd-genui="1"]').waitFor();
    const before = await page.locator('.sd-genui-stat-value').first().textContent();
    await page.locator('input[type=range]').first().fill('300000');
    await page.locator('input[type=range]').first().dispatchEvent('input');
    assert.notEqual(before, await page.locator('.sd-genui-stat-value').first().textContent());
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('08 tool-result renders inline as a structured table/chart, not as a card', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'sds-genui', 'id: forecast\nkind: tool-result\ntitle: Weekly forecast\nname: get_weather\n---\n' + JSON.stringify({ city: 'Dhaka', unit: 'celsius', days: [{ day: 'Mon', high: 31, low: 25 }, { day: 'Tue', high: 32, low: 26 }, { day: 'Wed', high: 30, low: 25 }] }));
      fx.para(md, 'end');
    });
    const inline = page.locator('.sd-inline[data-kind="tool-result"]');
    await inline.locator('.sd-genui-table').waitFor();
    assert.equal(await page.locator('.sd-art').count(), 0);
    assert.deepEqual(errors, []);
    await shot(page, '08-tool-result.png');
    await ctx.close();
  });

  await test('09 MCP Apps: tool UI mounts after the exec card, full ui/* lifecycle, consent for app tool calls, declared app block', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(async () => {
      await window.__sdBridgeFetch({ type: 'bds-mcp-list-tools', serverUrl: 'https://mcp.example.com/mcp' });
      const md = fx.message(); fx.para(md, 'Checking weather');
      const c = document.createElement('div'); c.className = 'bds-mcp-loading sd-done';
      const tt = document.createElement('div'); tt.className = 'bds-mcp-loading-title'; tt.textContent = 'get_weather'; c.appendChild(tt); md.appendChild(c);
      await window.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'https://mcp.example.com/mcp', toolName: 'get_weather', args: { city: 'Dhaka' } });
    });
    const app = page.locator('.sd-mcp');
    await app.waitFor();
    assert.equal(await page.evaluate(() => { const a = document.querySelector('.sd-mcp'); return !!a.previousElementSibling && a.previousElementSibling.classList.contains('bds-mcp-loading'); }), true, 'anchored after the exec card');
    const fl = page.frameLocator('.sd-mcp iframe');
    await fl.locator('#city', { hasText: 'Dhaka' }).waitFor({ timeout: 6000 });
    assert.equal(await fl.locator('body').getAttribute('data-host'), 'Super DeepSeek');
    assert.match(await fl.locator('#ctx').textContent(), /"city":"Dhaka"/, 'tool-input delivered');
    const reads = await page.evaluate(() => window.__mcpCalls.filter((c) => c.type === 'bds-mcp-read-resource').length);
    assert.equal(reads, 1);
    const sb = await app.locator('iframe').getAttribute('sandbox');
    assert.ok(!sb.includes('allow-same-origin'));
    const srcdoc = await app.locator('iframe').getAttribute('srcdoc');
    assert.match(srcdoc, /connect-src https:\/\/api\.weather\.example;/, 'declared connect domain allowed');
    assert.doesNotMatch(srcdoc, /evil\.local|\*\.bad/, 'invalid declared domains dropped');
    // App-originated tools/call → in-page consent → result back to the app.
    await fl.locator('#r').click();
    await app.locator('.sd-vis-note .sd-chip-primary').waitFor();
    await app.locator('.sd-vis-note .sd-chip-primary').click();
    await fl.locator('body[data-refreshed="1"]').waitFor({ timeout: 4000 });
    assert.equal(await fl.locator('#temp').textContent(), '29°C');
    const appCalls = await page.evaluate(() => window.__mcpCalls.filter((c) => c.type === 'bds-mcp-call').length);
    assert.equal(appCalls, 2);
    assert.equal(await page.locator('.sd-mcp').count(), 1, 'app-originated calls do not mount another view');
    await shot(page, '09-mcp-app.png');
    // Declared mcp-app block mounts the same host; unsafe references are refused.
    await page.evaluate(() => { const md = fx.message(); fx.block(md, 'sds-genui', 'id: weather-home\nkind: mcp-app\ntitle: Weather\nserver: https://mcp.example.com/mcp\nresource: ui://weather/app.html'); fx.para(md, 'x'); });
    await page.locator('.sd-inline[data-kind="mcp-app"] .sd-mcp').waitFor();
    await page.evaluate(() => { const md = fx.message(); fx.block(md, 'sds-genui', 'id: bad\nkind: mcp-app\ntitle: Unsafe Resource\nserver: http://127.0.0.1/mcp\nresource: javascript:alert(1)'); fx.para(md, 'x'); });
    const unsafe = page.locator('.sd-art[data-kind="code"]').filter({ hasText: 'Unsafe Resource' });
    await unsafe.waitFor();
    assert.match(await unsafe.locator('.sd-art-sub').textContent() || '', /source only/i);
    assert.equal(await page.locator('.sd-art-error').count(), 0, 'unsafe URI stays source-only and is not mounted');
    await unsafe.click();
    await page.locator('#sd-viewer .sd-code').waitFor();
    assert.match(await page.locator('#sd-viewer .sd-code').textContent() || '', /javascript:alert/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('09b MCP Apps: a UI declared only on the tool RESULT (real deployed servers) still mounts; non-ui:// is refused', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(async () => {
      const S = 'https://mcp.example.com/mcp';
      await window.__sdBridgeFetch({ type: 'bds-mcp-list-tools', serverUrl: S });
      const md = fx.message();
      for (const name of ['bad_dash', 'legacy_dash']) {
        const c = document.createElement('div'); c.className = 'bds-mcp-loading sd-done';
        const tt = document.createElement('div'); tt.className = 'bds-mcp-loading-title'; tt.textContent = name; c.appendChild(tt); md.appendChild(c);
        await window.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: S, toolName: name, args: {} });
      }
    });
    await page.locator('.sd-mcp').waitFor();
    assert.equal(await page.locator('.sd-mcp').count(), 1, 'only the ui:// result mounts');
    await page.frameLocator('.sd-mcp iframe').locator('#city', { hasText: 'Chattogram' }).waitFor();
    const reads = await page.evaluate(() => window.__mcpCalls.filter((c) => c.type === 'bds-mcp-read-resource').map((c) => c.resourceUri));
    assert.deepEqual(reads, ['ui://weather/app.html']);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('09d MCP: app-only tools hidden from the model + auto-allowed; OpenAI Apps SDK (skybridge) templates get window.openai', async () => {
    const { ctx, page, errors } = await fresh();
    const listed = await page.evaluate(async () => {
      const r = await window.__sdBridgeFetch({ type: 'bds-mcp-list-tools', serverUrl: 'https://mcp.example.com/mcp' });
      const md = fx.message();
      const c = document.createElement('div'); c.className = 'bds-mcp-loading sd-done';
      const tt = document.createElement('div'); tt.className = 'bds-mcp-loading-title'; tt.textContent = 'pizza_list'; c.appendChild(tt); md.appendChild(c);
      await window.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'https://mcp.example.com/mcp', toolName: 'pizza_list', args: { city: 'Dhaka' } });
      return r.tools.map((t) => t.name);
    });
    assert.ok(!listed.includes('prefs_read'), 'app-only tool hidden from the model list');
    assert.ok(listed.includes('pizza_list') && listed.includes('refresh_forecast'));
    const fl = page.frameLocator('.sd-mcp iframe');
    await fl.locator('#l li', { hasText: 'Luigi' }).waitFor({ timeout: 6000 });
    assert.match(await fl.locator('#meta').textContent(), /total:2 input:\{"city":"Dhaka"\} theme:(light|dark)/);
    // app-only call: no consent prompt, result delivered.
    await fl.locator('#pref', { hasText: 'unit:C' }).waitFor({ timeout: 4000 });
    assert.equal(await page.locator('.sd-mcp .sd-vis-note:not([hidden])').count(), 0, 'no consent for app-only tool');
    await fl.locator('#fs').click();
    await page.locator('.sd-mcp.sd-mcp-full').waitFor({ timeout: 3000 });
    await fl.locator('#mode', { hasText: 'mode:fullscreen' }).waitFor({ timeout: 3000 });
    assert.equal(await page.evaluate(() => window.__sdHandleBack()), true, 'back exits full screen');
    await shot(page, '09d-skybridge.png');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('09c endless loops in generated code are stopped: the chat stays responsive and the surface reports the error', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'sds-visual', 'title: Loop\n<p id="p">start</p>\n<script>var n=0;while(true){n++}document.getElementById("p").textContent="after "+(n>0);</script>');
      fx.para(md, 'x');
      const md2 = fx.message();
      fx.block(md2, 'sds-genui', 'id: loop-app\nkind: html-app\ntitle: Loop app\n---\n<!doctype html><html><head></head><body><b id="o">0</b><script>for(;;){} document.getElementById("o").textContent="survived";</script></body></html>');
      fx.para(md2, 'y');
    });
    const t0 = Date.now();
    await page.frameLocator('.sd-vis iframe').first().locator('#p', { hasText: 'after true' }).waitFor({ timeout: 15000 });
    // The host page keeps running timers: it was blocked for at most ~LOOP_MS per loop.
    const lag = await page.evaluate(() => new Promise((r) => { const a = performance.now(); setTimeout(() => r(performance.now() - a), 10); }));
    assert.ok(lag < 500, 'host timers responsive after the loop (lag ' + Math.round(lag) + 'ms)');
    assert.ok(Date.now() - t0 < 15000);
    await page.locator('.sd-vis-note', { hasText: /loop/i }).first().waitFor({ timeout: 5000 });
    await page.locator('.sd-art').first().click();
    await page.frameLocator('#sd-viewer iframe').locator('#o', { hasText: 'survived' }).waitFor({ timeout: 15000 });
    await page.keyboard.press('Escape').catch(() => {});
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('15 web access: fetch()/sdFetch from a visual asks once per website, then fetches natively; private hosts never prompt; images retried', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message();
      fx.block(md, 'sds-visual', 'title: Weather live\n<div id="t">…</div><div id="p">…</div><img id="im" src="https://img.example.org/img.png" width="4" height="4">' +
        '<script>fetch("https://api.example.org/now?city=Dhaka").then(function(r){return r.json()}).then(function(j){document.getElementById("t").textContent="temp:"+j.temp+" "+j.method;' +
        'return fetch("http://192.168.1.1/admin").then(function(){document.getElementById("p").textContent="LEAK"},function(e){document.getElementById("p").textContent="blocked"})})</script>');
      fx.para(md, 'x');
    });
    const sheet = page.locator('.sd-net:not(.sd-out)');
    await sheet.waitFor({ timeout: 8000 });
    assert.equal(await sheet.count(), 1, 'one consent sheet at a time');
    assert.match(await sheet.textContent(), /api\.example\.org|img\.example\.org/);
    await settle(page, 450);
    await shot(page, '15-web-consent.png');
    // Approve every site that asks (data + image), always.
    for (let i = 0; i < 3 && await page.locator('.sd-net:not(.sd-out)').count(); i++) { await page.locator('.sd-net:not(.sd-out) .sd-chip-primary').first().click(); await settle(page, 400); }
    assert.equal(await page.locator('.sd-net:not(.sd-out)').count(), 0, 'no more prompts once both sites are allowed');
    const fl = page.frameLocator('.sd-vis iframe');
    await fl.locator('#t', { hasText: 'temp:31 GET' }).waitFor({ timeout: 6000 });
    await fl.locator('#p', { hasText: 'blocked' }).waitFor({ timeout: 6000 });
    await fl.locator('#im').evaluate((n) => n.src.slice(0, 15)).then((src) => assert.equal(src, 'data:image/png;', 'blocked image retried through the host'));
    const calls = await page.evaluate(() => window.__mcpCalls.filter((c) => c.type === 'bds-frame-fetch').map((c) => c.url));
    assert.ok(calls.some((u) => u.startsWith('https://api.example.org/now')), 'fetched natively');
    assert.ok(!calls.some((u) => /192\.168/.test(u)), 'private address never reached the bridge');
    const grants = await page.evaluate(() => Object.keys(window.__sdGenUIFrame.web.grants()));
    assert.ok(grants.includes('api.example.org'));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('16 uploads: files the chat input refuses are converted on the device before the page sees them; accepted files pass untouched; audio/video refused', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      window.__sdNative = window.__sdNative || {};
      window.__sdNative._acceptsFile = (acc, f) => acc.split(',').some((a) => f.name.toLowerCase().endsWith(a.trim()));
      const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'ds-upload'; i.accept = '.pdf,.txt,.md,.py';
      document.body.appendChild(i);
      window.__seen = [];
      // the page's own listener (stands in for DeepSeek's upload handler)
      i.addEventListener('change', async () => { for (const f of i.files) window.__seen.push({ name: f.name, head: (await f.text()).slice(0, 60) }); });
    });
    await page.addScriptTag({ path: path.join(ROOT, 'android/app/src/main/bds-assets/bds/sd-files.js') });
    // A stored (uncompressed) .odt: mimetype + content.xml.
    const zip = (entries) => { const L = [], C = []; let off = 0; for (const [n, c] of Object.entries(entries)) { const d = Buffer.from(c), nb = Buffer.from(n);
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(nb.length, 26);
      const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
      L.push(lh, nb, d); C.push(ch, nb); off += 30 + nb.length + d.length; }
      const cd = Buffer.concat(C), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(C.length / 2, 8); e.writeUInt16LE(C.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16); return Buffer.concat([...L, cd, e]); };
    await page.setInputFiles('#ds-upload', [
      { name: 'paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') },
      { name: 'minutes.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer: zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:text><text:h>Minutes</text:h><text:p>Budget approved</text:p></office:text>' }) },
      { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.from('0000') },
    ]);
    await page.waitForFunction(() => window.__seen.length >= 2, null, { timeout: 5000 });
    await settle(page, 300);
    const seen = await page.evaluate(() => window.__seen);
    assert.deepEqual(seen.map((x) => x.name), ['paper.pdf', 'minutes.odt.txt'], 'page saw the pdf untouched and the odt as text; the video was dropped');
    assert.equal(seen[1].head, 'Minutes\nBudget approved');
    // The page's listener ran once (for the converted set), not for the raw selection.
    assert.equal(seen.length, 2);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('10 hidden prompt v3: wrapped for the bubble cleaner, decision matrix, frequency and kill switch', async () => {
    const { ctx, page, errors } = await fresh();
    const r = await page.evaluate(() => {
      const P = window.__sdGenUIPrompt; P._resetTurns();
      const app = P.build('Build me an interactive EMI calculator app', { chat: 'c1', isFirst: true });
      const explain = P.build('Explain how DNS resolution works with a diagram', { chat: 'c4' });
      const plain = P.build('What is the capital of France?', { chat: 'c1' });
      P.setConfig({ frequency: 'always' }); P._resetTurns();
      const always = P.build('hello', { chat: 'c2' });
      P.setConfig({ enabled: false }); P._resetTurns();
      const off = P.build('Build me a chart', { chat: 'c3' });
      P.resetConfig();
      return { app, explain, plain, always, off, version: P.version };
    });
    assert.equal(r.version, 3);
    assert.match(r.app, /^<SuperDeepSeek>\n[\s\S]*<\/SuperDeepSeek>$/);
    assert.match(r.app, /```sds-genui/);
    assert.match(r.explain, /```sds-visual/);
    assert.match(r.explain, /<SDS:VISUALIZER> tag is deprecated/);
    assert.equal(r.plain, '');
    assert.match(r.always, /Generative UI/);
    assert.equal(r.off, '');
    const cleaned = (r.app + '  Build me an EMI app').replace(/(?:<|&lt;)(?:Better|Super)DeepSeek(?:>|&gt;)[\s\S]*?(?:<|&lt;)\/(?:Better|Super)DeepSeek(?:>|&gt;)/gi, '').trim();
    assert.equal(cleaned, 'Build me an EMI app');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('11 kill switch removes every rendered surface and restores the code blocks; re-enable renders again', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate((a) => { const md = fx.message(); fx.block(md, 'sds-ui', a[0]); fx.block(md, 'sds-genui', a[1]); fx.block(md, 'sds-visual', a[2]); fx.para(md, 'x'); }, [UI, APP, VIS]);
    await page.locator('.sd-art').waitFor();
    await page.locator('.sd-vis').waitFor();
    await page.locator('.sd-genui-surface[data-sd-genui="1"]').waitFor();
    await page.evaluate(() => window.__sdGenUIPrompt.setConfig({ enabled: false }));
    await settle(page, 400);
    assert.equal(await page.locator('.sd-art, .sd-vis, .sd-genui-surface[data-sd-genui="1"]').count(), 0);
    assert.equal(await page.locator('.md-code-block:visible').count(), 3);
    await page.evaluate(() => window.__sdGenUIPrompt.setConfig({ enabled: true }));
    await page.locator('.sd-art').waitFor();
    await page.locator('.sd-vis').waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  await test('12 strict host CSP: inline visual and viewer fall back to the isolated full-screen viewer; exports redact secrets', async () => {
    const { ctx, page, errors } = await fresh({ file: 'genui-csp.html' });
    const secretApp = APP.replace('<h1>Split the bill</h1>', '<h1>Split the bill</h1><p>key sk-abcdefghijklmnopqrstuvwxyz123456</p>');
    await page.evaluate((a) => { const md = fx.message(); fx.block(md, 'sds-visual', a[0]); fx.block(md, 'sds-genui', a[1]); fx.para(md, 'x'); }, [VIS, secretApp]);
    const note = page.locator('.sd-vis .sd-vis-note:not([hidden])');
    await note.waitFor({ timeout: 9000 });
    assert.match(await note.textContent(), /could not start here/);
    await note.locator('.sd-chip').click();
    assert.equal((await calls(page, 'openGeneratedApp')).length, 1, 'fallback opens the native isolated viewer');
    await page.locator('.sd-art').click();
    const st = page.locator('#sd-viewer .sd-viewer-status:not([hidden])');
    await st.waitFor({ timeout: 9000 });
    assert.match(await st.textContent(), /could not start here/);
    await page.evaluate(() => window.__sdHandleBack());
    await page.locator('.sd-art .sd-art-dl').click();
    const dl = (await calls(page, 'downloadBlob')).pop();
    const html = Buffer.from(dl.b64, 'base64').toString('utf8');
    assert.doesNotMatch(html, /sk-abcdefghijklmnop/, 'secret removed from the export');
    assert.match(html, /Split the bill/);
    assert.deepEqual(errors, []);
    await shot(page, '12-csp-fallback.png');
    await ctx.close();
  });

  for (const [label, opts] of [['mobile light', { width: 390, height: 844 }], ['desktop dark', { width: 1280, height: 900, dark: true }]]) {
    await test('13 artifact lifecycle (' + label + '): versions, version picker, reload restore, library, share, PNG, edit with AI, settings', async () => {
      const { ctx, page, errors } = await fresh(opts);
      await page.evaluate((a) => {
        const md = fx.message(); fx.block(md, 'sds-genui', a[0]); fx.para(md, 'v1');
        const md2 = fx.message(); fx.block(md2, 'sds-genui', a[1]); fx.para(md2, 'v2');
        const md3 = fx.message(); fx.block(md3, 'sds-genui', 'id: sunset\nkind: svg\ntitle: The quiet hour\n---\n<svg viewBox="0 0 60 36"><rect width="60" height="36" fill="#443064"/><circle cx="30" cy="20" r="6" fill="#ffdb9e"/></svg>'); fx.para(md3, 'end');
      }, [APP, APP_V2]);
      await page.waitForFunction(() => document.querySelectorAll('.sd-art:not(.sd-art-busy)').length === 3);
      const subs = await page.locator('.sd-art[data-kind="html-app"] .sd-art-sub').allTextContents();
      assert.match(subs[1], /Version 2/, 'same id ⇒ new version');
      await shot(page, `13-cards-${opts.dark ? 'dark' : 'light'}.png`);
      await page.locator('.sd-art[data-kind="html-app"]').nth(1).click();
      const viewer = page.locator('#sd-viewer');
      await viewer.waitFor();
      if (opts.width >= 960) assert.equal(await page.locator('.sd-viewer-wide').count(), 1, 'side panel on wide screens');
      await page.frameLocator('#sd-viewer iframe.sd-frame').locator('h1', { hasText: 'v2' }).waitFor();
      if (opts.dark) assert.equal(await page.frameLocator('#sd-viewer iframe.sd-frame').locator('html').getAttribute('data-theme'), 'dark');
      await viewer.locator('.sd-viewer-ver').click();
      await viewer.locator('.sd-ver-menu').getByRole('menuitem', { name: /Version 1/ }).click();
      await page.frameLocator('#sd-viewer iframe.sd-frame').locator('h1', { hasText: /^Split the bill$/ }).waitFor();
      await shot(page, `13-viewer-${opts.dark ? 'dark' : 'light'}.png`, false);
      await viewerMenu(page, 'Edit with AI…');
      assert.match(await page.locator('#composer').inputValue(), /tip-calc/);
      assert.equal(await page.locator('#sd-viewer').count(), 0);
      // svg: share + PNG
      await page.locator('.sd-art[data-kind="svg"]').click();
      await viewerMenu(page, 'Share');
      assert.equal((await calls(page, 'shareFile')).pop().mime, 'image/svg+xml');
      await viewerMenu(page, 'Download as PNG');
      await page.waitForFunction(() => window.__bridgeCalls.some((c) => c.m === 'downloadBlob' && c.mime === 'image/png'));
      const png = (await calls(page, 'downloadBlob')).find((c) => c.mime === 'image/png');
      assert.equal(Buffer.from(png.b64, 'base64').subarray(1, 4).toString(), 'PNG');
      // settings + artifact library survive a reload
      await page.reload();
      if (opts.dark) await page.evaluate(() => document.body.classList.add('dark'));
      await page.evaluate(() => window.__sdGenUIPanel.open());
      await page.locator('#sd-genui-panel').waitFor();
      const lib = page.locator('#sd-genui-panel .sd-p-art');
      assert.equal(await lib.count(), 2, 'library lists stored artifacts after reload');
      await page.getByRole('button', { name: 'Run diagnostics' }).click();
      const diag = JSON.parse(await page.locator('#sd-genui-panel .sd-p-out').textContent());
      assert.equal(diag.modules.viewer && diag.modules.inline && diag.modules.mcp && diag.modules.frame, true);
      await shot(page, `13-panel-${opts.dark ? 'dark' : 'light'}.png`, false);
      await lib.first().getByRole('button', { name: 'Open' }).click();
      await page.locator('#sd-viewer').waitFor();
      assert.equal(await page.evaluate(() => window.__sdHandleBack()), true);
      assert.equal(await noOverflow(page), true);
      assert.deepEqual(errors, []);
      await ctx.close();
    });
  }

  await test('14 legacy <SDS:VISUALIZER> output no longer takes over: rendered inline by the new renderer; legacy preview panel → viewer', async () => {
    const { ctx, page, errors } = await fresh();
    await page.evaluate(() => {
      const md = fx.message(); fx.para(md, 'Old-style visual:');
      const card = document.createElement('div'); card.className = 'bds-visualizer-card';
      const body = document.createElement('div'); body.className = 'bds-visualizer-body';
      const f = document.createElement('iframe'); f.className = 'bds-visualizer-frame'; f.style.height = '600px';
      body.appendChild(f); card.appendChild(body); md.appendChild(card);
      f.setAttribute('srcdoc', '<!doctype html><html><head><title>Legacy chart</title></head><body><h2 id="lg">Legacy chart</h2></body></html>');
    });
    const vis = page.locator('.sd-vis');
    await vis.waitFor();
    assert.equal(await page.locator('.bds-visualizer-card[data-sd-hidden="legacy"]').count(), 1, 'old 600px card hidden');
    await page.frameLocator('.sd-vis iframe').locator('#lg').waitFor();
    assert.doesNotMatch(await page.locator('iframe.bds-visualizer-frame').getAttribute('srcdoc'), /Legacy chart/, 'old frame blanked');
    await page.evaluate(() => {
      const p = document.createElement('div'); p.className = 'bds-preview-panel';
      const close = document.createElement('button'); close.className = 'bds-preview-close'; close.onclick = () => p.remove(); p.appendChild(close);
      const f = document.createElement('iframe'); f.className = 'bds-preview-frame'; p.appendChild(f); document.body.appendChild(p);
      f.setAttribute('srcdoc', '<!doctype html><html><head><title>Legacy app</title></head><body><button id="go">go</button></body></html>');
    });
    await page.locator('#sd-viewer').waitFor();
    await page.frameLocator('#sd-viewer iframe.sd-frame').locator('#go').waitFor();
    assert.equal(await page.locator('.bds-preview-panel').count(), 0, 'legacy panel closed');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
} finally {
  await browser.close();
  server.close();
}
const passed = results.filter((r) => r.ok).length;
await fsp.writeFile(path.join(OUT, 'acceptance-results.json'), JSON.stringify({ at: new Date().toISOString(), environment: 'Chromium (Playwright) + engine fixture; not Android WebView, not live model', passed, total: results.length, results }, null, 2));
console.log(`\n${passed}/${results.length} acceptance checks passed`);
if (passed !== results.length) process.exit(1);
