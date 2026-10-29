import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// The protocol file is a browser IIFE attaching to `window`; shim it for Node ESM.
globalThis.window = globalThis;
await import(pathToFileURL(new URL('../../main/bds-assets/bds/sd-genui-protocol.js', import.meta.url).pathname));
const P = globalThis.__sdGenUIProtocol;

test('protocol exposes versioned validate/stream/document surface', () => {
  assert.ok(P && P.version === 1);
  assert.equal(typeof P.validate, 'function');
  assert.equal(typeof P.Stream, 'function');
  assert.equal(typeof P.documentFor, 'function');
  assert.ok(P.limits.payload > 1024 && P.limits.stream > 1024 && P.limits.blocks >= 4);
});

test('validate accepts every supported content kind and normalizes the contract', () => {
  const ui = P.validate(JSON.stringify({ version: 1, id: 'saved-calculator', kind: 'ui', title: 'Saved calculator', revision: 4, payload: { spec: { version: 1, components: [] } } }));
  assert.equal(ui.ok, true, ui.error);
  assert.equal(ui.block.kind, 'ui');
  assert.equal(ui.block.revision, 4);
  assert.equal(ui.block.presentation, 'inline');
  const svg = P.validate(JSON.stringify({ version: 1, id: 'moon', kind: 'svg', payload: { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>' } }));
  assert.equal(svg.ok, true, svg.error);
  const app = P.validate(JSON.stringify({ version: 1, id: 'snake-1', kind: 'html-app', payload: { html: '<main>hi</main>', css: 'body{margin:0}', js: 'document.title="x"' } }));
  assert.equal(app.ok, true, app.error);
  assert.deepEqual(Object.keys(app.block.payload).sort(), ['css', 'html', 'js', 'source']);
  const mcpHome = P.validate(JSON.stringify({ version: 1, id: 'weather-home', kind: 'mcp-app', payload: { serverUrl: 'https://mcp.example.com/mcp', resourceUri: 'ui://weather/home', view: 'home' } }));
  assert.equal(mcpHome.ok, true, mcpHome.error);
  assert.equal(mcpHome.block.payload.view, 'home');
  const mcpTop = P.validate(JSON.stringify({ version: 1, id: 'weather-top', kind: 'mcp-app', view: 'home', payload: { serverUrl: 'https://mcp.example.com/mcp', resourceUri: 'ui://weather/home' } }));
  assert.equal(mcpTop.ok, true, mcpTop.error);
  assert.equal(mcpTop.block.payload.view, 'home', 'top-level view is normalized');
  const mcpApp = P.validate(JSON.stringify({ version: 1, id: 'weather-app', kind: 'mcp-app', payload: { serverUrl: 'https://mcp.example.com/mcp', resourceUri: 'https://mcp.example.com/app.html' } }));
  assert.equal(mcpApp.ok, true, mcpApp.error);
  assert.equal(mcpApp.block.payload.view, 'app');
  const tr = P.validate(JSON.stringify({ version: 1, id: 'tool-out', kind: 'tool-result', payload: { name: 'get_forecast', result: { days: [{ t: 22 }] } } }));
  assert.equal(tr.ok, true, tr.error);
  assert.equal(tr.block.payload.name, 'get_forecast');
});

test('validate rejects malformed or hostile contracts', () => {
  for (const raw of [
    'null',
    JSON.stringify({ version: 2, id: 'x', kind: 'ui', payload: { spec: {} } }),
    JSON.stringify({ version: 1, id: '<img>', kind: 'ui', payload: { spec: {} } }),
    JSON.stringify({ version: 1, id: 'x', kind: 'evil', payload: {} }),
    JSON.stringify({ version: 1, id: 'x', kind: 'ui', payload: { spec: {} }, revision: 0 }),
    JSON.stringify({ version: 1, id: 'x', kind: 'ui', payload: { spec: {} }, presentation: 'popup' }),
    JSON.stringify({ version: 1, id: 'x', kind: 'ui', payload: [] }),
  ]) {
    const r = P.validate(raw);
    assert.equal(r.ok, false, 'should reject: ' + raw.slice(0, 60));
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  }
  const proto = P.validate('{"version":1,"id":"x","kind":"ui","payload":{"spec":{}},"__proto__":{"polluted":1}}');
  assert.equal(proto.ok, false, 'reserved keys rejected');
});

test('validate rejects unsafe MCP URIs even at the protocol layer', () => {
  const bad = (resourceUri, serverUrl = 'https://mcp.example.com/mcp') => P.validate(JSON.stringify({ version: 1, id: 'x', kind: 'mcp-app', payload: { serverUrl, resourceUri } })).ok === false;
  assert.equal(bad('javascript:alert(1)'), true);
  assert.equal(bad('ui://host/../../etc/passwd'), true);
  assert.equal(bad('http://plain.example/app.html'), true);
  assert.equal(bad('https://user:pass@host/x'), true);
  assert.equal(bad('ui://weather/home', 'ftp://mcp.example.com'), true);
  assert.equal(bad('ui://'), true);
  assert.equal(P.validate(JSON.stringify({ version: 1, id: 'x', kind: 'mcp-app', payload: { serverUrl: 'https://mcp.example.com/mcp', resourceUri: 'ui://weather/home' } })).ok, true);
});

test('Stream assembles split fenced blocks and honors budgets', () => {
  const s = new P.Stream();
  const block = JSON.stringify({ version: 1, id: 'x', kind: 'ui', payload: { spec: { version: 1, components: [] } } });
  const frame = 'Here you go:\n```sds-genui\n' + block + '\n```\nDone.';
  s.push(frame.slice(0, 20), false);
  s.push(frame.slice(20), true);
  assert.equal(s.done, true);
  assert.equal(s.parts.length, 3, 'text, visual, text');
  assert.equal(s.parts[0].type, 'text');
  assert.equal(s.parts[1].type, 'visual');
  assert.equal(s.parts[1].result.ok, true, s.parts[1].result && s.parts[1].result.error);
  assert.equal(s.parts[1].result.block.id, 'x');
  assert.equal(s.parts[2].type, 'text');
  const tooBig = new P.Stream();
  assert.throws(() => tooBig.push('x'.repeat(P.limits.stream + 10), true), /Stream size limit/);
  assert.equal(tooBig.done, true);
});

test('documentFor builds CSP-wrapped offline application documents', () => {
  const app = P.validate(JSON.stringify({ version: 1, id: 'a1', kind: 'html-app', payload: { html: '<main>hi</main>', css: 'body{margin:0}', js: 'document.title="x"' } })).block;
  const staticDoc = P.documentFor(app, false);
  assert.ok(staticDoc.includes("Content-Security-Policy"));
  assert.ok(staticDoc.includes("connect-src 'none'"));
  assert.ok(!staticDoc.includes('<script>document.title'), 'static preview never embeds app JS');
  const runDoc = P.documentFor(app, true);
  assert.ok(runDoc.includes('document.title="x"'), 'run document contains app JS');
  assert.ok(runDoc.includes("connect-src 'none'"), 'run document stays offline');
  assert.throws(() => P.documentFor({ kind: 'ui' }, true), /Not an application/);
});

test('M5: external resources are curated, https-only and non-private', () => {
  assert.equal(typeof P.allowedExternalUrl, 'function');
  assert.equal(P.allowedExternalUrl('https://cdn.jsdelivr.net/npm/x@1/chart.js'), true);
  assert.equal(P.allowedExternalUrl('https://unpkg.com/lib.js'), true);
  assert.equal(P.allowedExternalUrl('https://upload.wikimedia.org/wikipedia/commons/1/1.png'), true);
  // subdomains of curated hosts only
  assert.equal(P.allowedExternalUrl('https://evil-cdn.jsdelivr.net.attacker.tld/x.js'), false);
  // wrong schemes
  assert.equal(P.allowedExternalUrl('http://cdn.jsdelivr.net/x.js'), false);
  assert.equal(P.allowedExternalUrl('javascript:alert(1)'), false);
  assert.equal(P.allowedExternalUrl('data:text/html,x'), false);
  // private / loopback / raw IP targets (SSRF class)
  assert.equal(P.allowedExternalUrl('https://127.0.0.1/admin'), false);
  assert.equal(P.allowedExternalUrl('https://10.0.0.5/x.png'), false);
  assert.equal(P.allowedExternalUrl('https://192.168.1.10/x.png'), false);
  assert.equal(P.allowedExternalUrl('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(P.allowedExternalUrl('https://172.16.0.1/x'), false);
  assert.equal(P.allowedExternalUrl('https://localhost/x.png'), false);
  assert.equal(P.allowedExternalUrl('https://intranet.internal/x.png'), false);
  // credentials in URL
  assert.equal(P.allowedExternalUrl('https://user:pass@cdn.jsdelivr.net/x.js'), false);
  // custom host list support
  assert.equal(P.allowedExternalUrl('https://images.example.com/a.png', ['images.example.com']), true);
  assert.equal(P.allowedExternalUrl('https://cdn.jsdelivr.net/x.js', ['images.example.com']), false);
});
