// Live MCP Apps check against a REAL remote MCP server (needs network; not run in CI).
//
//   node scripts/mcp-live-check.mjs [serverUrl] [toolName]
//
// Default server: https://mcpplaygroundonline.com/mcp-app-server (public test server,
// tool get_mcp_app_demo, no auth). The page uses the shipped engine modules through the
// design-preview fixture. Only the native bridge is replaced: Node performs the same
// JSON-RPC calls WebViewBridge.kt makes (initialize → tools/list / tools/call /
// resources/read over Streamable HTTP) and hands back the same {ok, …} shapes.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa/genui');
const SERVER = process.argv[2] || 'https://mcpplaygroundonline.com/mcp-app-server';
const TOOL = process.argv[3] || 'get_mcp_app_demo';
const ARGS = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const WAIT_MS = Number(process.env.MCP_LIVE_WAIT || 4000);

/* ---- minimal Streamable HTTP client (mirrors executeMcpJsonRpc) ---- */
let session = null, nextId = 1;
async function rpc(method, params, isNotification) {
  const body = { jsonrpc: '2.0', method, params: params || {} };
  if (!isNotification) body.id = nextId++;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(SERVER, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const sid = res.headers.get('mcp-session-id'); if (sid) session = sid;
  if (isNotification) return null;
  const text = await res.text();
  let msg = null;
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { const m = JSON.parse(line.slice(5)); if (m.id === body.id) msg = m; } catch {}
    }
  } else msg = JSON.parse(text);
  if (!msg) throw new Error(`no JSON-RPC reply for ${method} (HTTP ${res.status})`);
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  return msg.result;
}
let ready = null;
function init() {
  return ready || (ready = rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
    clientInfo: { name: 'Super DeepSeek (live check)', version: '2.60' },
  }).then(async (r) => { await rpc('notifications/initialized', {}, true); return r; }));
}
const log = [];
async function nativeBridge(payload) {
  log.push(payload.type + (payload.toolName ? ':' + payload.toolName : '') + (payload.resourceUri ? ':' + payload.resourceUri : ''));
  try {
    await init();
    if (payload.type === 'bds-mcp-list-tools') { const r = await rpc('tools/list', {}); return { ok: true, tools: r.tools || [] }; }
    if (payload.type === 'bds-mcp-call') { const r = await rpc('tools/call', { name: payload.toolName, arguments: payload.args || {} }); return { ok: true, result: r }; }
    if (payload.type === 'bds-mcp-read-resource') {
      if (!/^ui:\/\//.test(payload.resourceUri || '')) return { ok: false, error: 'Only ui:// resources' };
      const r = await rpc('resources/read', { uri: payload.resourceUri });
      const c = (r.contents || [])[0] || {};
      const text = typeof c.text === 'string' ? c.text : (c.blob ? Buffer.from(c.blob, 'base64').toString('utf8') : '');
      return { ok: !!text, mimeType: c.mimeType || 'text/html', text, meta: c._meta || {}, error: text ? undefined : 'Empty resource' };
    }
    return { ok: false, error: 'unsupported' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/* ---- static server for the fixture ---- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await fsp.mkdir(OUT, { recursive: true });
let ok = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.exposeFunction('__nodeMcp', nativeBridge);
  // Replace the fixture's mock bridge (its first assignment) with the live one, but let
  // the engine wrap it afterwards exactly as it wraps sd-native's bridge in the app.
  await page.addInitScript(() => {
    let value = function (p) { return window.__nodeMcp(JSON.parse(JSON.stringify(p))); };
    let first = true;
    Object.defineProperty(window, '__sdBridgeFetch', { configurable: true, get() { return value; }, set(v) { if (first) { first = false; return; } value = v; } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/design-preview/genui.html`);
  await page.evaluate(async ({ server, tool, args }) => {
    const lt = await window.__sdBridgeFetch({ type: 'bds-mcp-list-tools', serverUrl: server });
    window.__liveTools = lt;
    const md = fx.message();
    const c = document.createElement('div'); c.className = 'bds-mcp-loading sd-done';
    const tt = document.createElement('div'); tt.className = 'bds-mcp-loading-title'; tt.textContent = tool; c.appendChild(tt); md.appendChild(c);
    window.__liveCall = await window.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: server, toolName: tool, args });
  }, { server: SERVER, tool: TOOL, args: ARGS });
  const tools = await page.evaluate(() => window.__liveTools);
  assert.equal(tools.ok, true, 'tools/list: ' + tools.error);
  console.log('tools shown to the model (' + tools.tools.length + '):', tools.tools.map((t) => t.name).join(', '));
  assert.ok(!tools.tools.some((t) => { const v = t._meta && t._meta.ui && t._meta.ui.visibility; return Array.isArray(v) && v.length && !v.includes('model'); }), 'app-only tools are hidden from the model');
  const call = await page.evaluate(() => window.__liveCall);
  assert.equal(call.ok, true, 'tools/call: ' + call.error);
  await page.locator('.sd-mcp').waitFor({ timeout: 15000 });
  const frame = page.locator('.sd-mcp iframe');
  await frame.waitFor({ timeout: 20000 });
  await page.waitForTimeout(WAIT_MS);
  const box = await frame.boundingBox();
  const state = await page.evaluate(() => { const a = document.querySelector('.sd-mcp'); return { text: a.innerText.slice(0, 300), cls: a.className }; });
  console.log('mounted:', JSON.stringify(state), 'frame', box && Math.round(box.width) + 'x' + Math.round(box.height));
  const inner = await page.frameLocator('.sd-mcp iframe').locator('body').innerText({ timeout: 8000 }).catch((e) => 'ERR ' + e.message);
  console.log('frame text:', inner.replace(/\s+/g, ' ').slice(0, 300));
  await page.screenshot({ path: path.join(OUT, 'mcp-live.png'), fullPage: true });
  assert.ok(box && box.height > 40, 'frame has content height');
  assert.ok(!/^ERR/.test(inner) && inner.trim().length > 0, 'frame rendered text');
  const notes = await page.locator('.sd-mcp .sd-vis-note:not([hidden])').allInnerTexts();
  console.log('consent/notes visible:', JSON.stringify(notes));
  if (process.env.MCP_EXPECT_NO_CONSENT) assert.deepEqual(notes, [], 'app-only/read-only calls need no consent');
  assert.deepEqual(errors, []);
  console.log('bridge calls:', log.join(' | '));
  ok = true;
  console.log('PASS live MCP App rendered from', SERVER);
} catch (e) {
  console.log('bridge calls:', log.join(' | '));
  console.log('FAIL', e);
} finally {
  await browser.close(); server.close();
  process.exitCode = ok ? 0 : 1;
}
