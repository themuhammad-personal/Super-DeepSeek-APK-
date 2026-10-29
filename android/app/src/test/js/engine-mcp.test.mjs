// MCP tool calls in content.js: every call in one reply is answered with ONE
// message (so results never interleave with the next reply), and the chat
// renders every result card of such a combined message.
// Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/content.js'), 'utf8');

function slice(from, to) {
  const a = CONTENT.indexOf(from);
  const b = CONTENT.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `engine code moved: ${from}`);
  return CONTENT.slice(a, b);
}

const MCP = slice('let BW=Promise.resolve(),sdMcpQ=null;', 'function sdMcpSb(e){')
  + slice('function sdMcpSb(e){', 'async function sdMcpRun(')
  + slice('async function sdMcpRun(', '}function ') + '}';

function setup({ results = {}, inlineMax = 8000, mcpServers = [{ name: 'x', serverUrl: 'https://x.example/mcp', enabled: true }] } = {}) {
  const sent = [];
  const calls = [];
  const ctx = {
    console: { log() {}, error() {} }, setTimeout, Promise, JSON, Math, Object, Array, String, Number, Error, Blob, File, Set,
    B: { mcpServers, settings: { mcpInlineMaxChars: inlineMax } },
    vb: new Set(),
    tCe: (e) => e,
    SW: (e) => e,
    dt() {},
    q_e: (r) => r.text,
    nc: async (text, label) => { sent.push({ kind: 'text', text, label }); return true; },
    ml: async (file, text) => { sent.push({ kind: 'file', text, name: file.name, body: await file.text() }); return true; },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(msg, cb) {
          calls.push(msg.toolName);
          const r = results[msg.toolName];
          setTimeout(() => (r instanceof Error ? cb({ ok: false, error: r.message }) : cb({ ok: true, result: { text: r ?? 'ok:' + msg.toolName } })), 1);
        },
      },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(MCP + ';window.nCe=nCe;window.sdMcpBlocks=sdMcpBlocks;', ctx);
  return { ctx, sent, calls };
}

const blocks = (text) => [...text.matchAll(/\[SDS:AUTO_MCP_(RESULT|ERROR)\]\n(.*)\n/g)].map((m) => ({ kind: m[1], ...JSON.parse(m[2]) }));

test('one call → one quiet sandbox result, same format as before', async () => {
  const { ctx, sent } = setup();
  await ctx.nCe('sandbox://linux', 'run', { command: 'ls' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'text');
  assert.equal(sent[0].label, 'Sandbox result');
  assert.match(sent[0].text, /^<SuperDeepSeek>\n\[SDS:AUTO\] MCP Result for run @ sandbox:\/\/linux\n\[SDS:AUTO_MCP_RESULT\]\n/);
  assert.match(sent[0].text, /\n\[\/SDS:AUTO_MCP_RESULT\]\n<\/SuperDeepSeek>$/);
  assert.equal(blocks(sent[0].text)[0].content, 'ok:run');
});

test('several calls in one reply → run in order, answered by ONE message', async () => {
  const { ctx, sent, calls } = setup({ results: { read_file: new Error('no such file') } });
  const p = [
    ctx.nCe('sandbox://linux', 'write_file', { path: 'a', content: '1' }),
    ctx.nCe('sandbox://linux', 'read_file', { path: 'b' }),
    ctx.nCe('sandbox://linux', 'run', { command: 'node a' }),
  ];
  await Promise.all(p);
  assert.deepEqual(calls, ['write_file', 'read_file', 'run']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].label, 'Tool results');
  const b = blocks(sent[0].text);
  assert.deepEqual(b.map((x) => [x.kind, x.toolName]), [['RESULT', 'write_file'], ['ERROR', 'read_file'], ['RESULT', 'run']]);
  assert.equal(b[1].error, 'no such file');
  assert.equal((sent[0].text.match(/<SuperDeepSeek>/g) || []).length, 1);
});

test('a big single sandbox result is attached as a file; in a batch it is truncated inline', async () => {
  const big = 'x'.repeat(50);
  let { ctx, sent } = setup({ results: { run: big }, inlineMax: 10 });
  await ctx.nCe('sandbox://linux', 'run', { command: 'cat' });
  assert.equal(sent[0].kind, 'file');
  assert.equal(sent[0].body, big);
  assert.match(blocks(sent[0].text)[0].content, /full content in attached file/);

  ({ ctx, sent } = setup({ results: { run: big }, inlineMax: 10 }));
  await Promise.all([ctx.nCe('sandbox://linux', 'run', { command: 'cat' }), ctx.nCe('sandbox://linux', 'status', {})]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'text');
  // Head (40%) + tail (60%) are kept, the middle is replaced by a note.
  const c = blocks(sent[0].text)[0].content;
  assert.match(c, /^x{4}\n\n\.\.\.\[40 chars omitted \u2014 re-run with less output/);
  assert.match(c, /\]\.\.\.\n\nx{6}$/);
});

test('Stop drops sandbox results; an identical external call is not repeated', async () => {
  let { ctx, sent } = setup();
  ctx.__sdAgentStopped = true;
  await ctx.nCe('sandbox://linux', 'run', { command: 'ls' });
  assert.equal(sent.length, 0);

  ({ ctx, sent } = setup());
  await ctx.nCe('https://x.example/mcp', 'search', { q: 1 });
  await ctx.nCe('https://x.example/mcp', 'search', { q: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'file');
});

test('later batches wait for the earlier one', async () => {
  const { ctx, sent } = setup();
  const a = ctx.nCe('sandbox://linux', 'run', { command: '1' });
  await new Promise((r) => setTimeout(r, 0));
  const b = ctx.nCe('sandbox://linux', 'run', { command: '2' });
  await Promise.all([a, b]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => blocks(s.text)[0].call), ['1', '2']);
});

test('renderer parses every result and error card of a combined message', () => {
  const { ctx } = setup();
  const msg = [
    '<SuperDeepSeek>',
    '[SDS:AUTO] MCP Result for run @ sandbox://linux', '[SDS:AUTO_MCP_RESULT]',
    JSON.stringify({ serverName: 'sandbox://linux', toolName: 'run', args: { command: 'ls' }, content: 'a\nb' }),
    '[/SDS:AUTO_MCP_RESULT]', '',
    '[SDS:AUTO] MCP call failed for read_file @ sandbox://linux', '[SDS:AUTO_MCP_ERROR]',
    JSON.stringify({ serverName: 'sandbox://linux', toolName: 'read_file', args: {}, error: 'nope' }),
    '[/SDS:AUTO_MCP_ERROR]',
    '</SuperDeepSeek>',
  ].join('\n');
  const b = JSON.parse(JSON.stringify(ctx.sdMcpBlocks(msg)));
  assert.deepEqual(b.map((x) => [x.name, x.attrs.toolName, x.content]), [
    ['auto:mcp_result', 'run', 'a\nb'],
    ['auto:mcp_error', 'read_file', 'nope'],
  ]);
  assert.equal(b[0].attrs.args, '{"command":"ls"}');
  assert.equal(ctx.sdMcpBlocks('hello').length, 0);
});

test('results carry a short call summary instead of echoing the full arguments', async () => {
  const { ctx, sent } = setup();
  const long = 'y'.repeat(5000);
  await Promise.all([
    ctx.nCe('sandbox://linux', 'write_file', { path: 'app/a.py', content: long }),
    ctx.nCe('sandbox://linux', 'edit_file', { path: 'app/a.py', old_text: 'y', new_text: 'z' }),
    ctx.nCe('sandbox://linux', 'status', {}),
  ]);
  const b = blocks(sent[0].text);
  assert.deepEqual(b.map((x) => x.call), ['app/a.py (5000 chars)', 'app/a.py (edit)', '{}']);
  assert.ok(b.every((x) => !('args' in x)));
  assert.ok(!sent[0].text.includes(long));
});

test('a big output saved in the sandbox goes inline as head + tail with the saved path', async () => {
  const big = 'a'.repeat(20) + 'MIDDLE' + 'b'.repeat(30);
  const saved = [];
  let { ctx, sent } = setup({ results: { run: big }, inlineMax: 10 });
  ctx.__sdSaveOutput = async (full, tool) => { saved.push([full, tool]); return '/tmp/sd-out/k1-run.txt'; };
  await ctx.nCe('sandbox://linux', 'run', { command: 'cat big' });
  assert.deepEqual(saved, [[big, 'run']]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'text');
  const c = blocks(sent[0].text)[0].content;
  assert.match(c, /^a{4}\n/);
  assert.match(c, /full output saved in the sandbox at \/tmp\/sd-out\/k1-run\.txt; read the part you need with read_file/);
  assert.match(c, /b{6}$/);
  assert.ok(!c.includes('MIDDLE'));

  // Saving failed → the old behaviour: the full output is attached as a file.
  ({ ctx, sent } = setup({ results: { run: big }, inlineMax: 10 }));
  ctx.__sdSaveOutput = async () => null;
  await ctx.nCe('sandbox://linux', 'run', { command: 'cat big' });
  assert.equal(sent[0].kind, 'file');
  assert.equal(sent[0].body, big);

  // A throwing saver never breaks the call.
  ({ ctx, sent } = setup({ results: { run: big }, inlineMax: 10 }));
  ctx.__sdSaveOutput = () => { throw new Error('boom'); };
  await ctx.nCe('sandbox://linux', 'run', { command: 'cat big' });
  assert.equal(sent[0].kind, 'file');

  // Small outputs are never saved.
  ({ ctx, sent } = setup());
  let n = 0;
  ctx.__sdSaveOutput = async () => { n++; return '/x'; };
  await ctx.nCe('sandbox://linux', 'run', { command: 'ls' });
  assert.equal(n, 0);
});

test('every call reports start and end to the run card', async () => {
  const ev = [];
  const { ctx } = setup({ results: { read_file: new Error('no such file') } });
  ctx.__sdRunEvent = (d) => ev.push(JSON.parse(JSON.stringify(d)));
  await Promise.all([
    ctx.nCe('sandbox://linux', 'run', { command: 'ls -la' }),
    ctx.nCe('sandbox://linux', 'read_file', { path: 'x' }),
  ]);
  assert.deepEqual(ev.map((e) => [e.phase, e.tool]), [['start', 'run'], ['end', 'run'], ['start', 'read_file'], ['end', 'read_file']]);
  assert.equal(ev[0].call, 'ls -la');
  assert.equal(ev[0].id, ev[1].id);
  assert.equal(ev[2].id, ev[3].id);
  assert.notEqual(ev[0].id, ev[2].id);
  assert.equal(ev[1].ok, true);
  assert.equal(ev[1].output, 'ok:run');
  assert.equal(ev[3].ok, false);
  assert.equal(ev[3].output, 'no such file');
  assert.ok(ev.every((e) => typeof e.at === 'number'));
});

test('a failing run-card listener never breaks a call', async () => {
  const { ctx, sent } = setup();
  ctx.__sdRunEvent = () => { throw new Error('ui broke'); };
  await ctx.nCe('sandbox://linux', 'run', { command: 'ls' });
  assert.equal(blocks(sent[0].text)[0].content, 'ok:run');
});

test('renderer shows the call summary of new results and the args of old ones', () => {
  const { ctx } = setup();
  const one = (o) => JSON.parse(JSON.stringify(ctx.sdMcpBlocks('[SDS:AUTO_MCP_RESULT]\n' + JSON.stringify(o) + '\n[/SDS:AUTO_MCP_RESULT]')))[0];
  assert.equal(one({ serverName: 's', toolName: 'run', call: 'ls', content: 'x' }).attrs.args, '{"call":"ls"}');
  assert.equal(one({ serverName: 's', toolName: 'run', args: { command: 'ls' }, content: 'x' }).attrs.args, '{"command":"ls"}');
  assert.equal(one({ serverName: 's', toolName: 'run', content: 'x' }).attrs.args, '{}');
});

test('Stop at the step cap sends nothing back, also for an external server', async () => {
  const ev = [];
  const { ctx, sent } = setup({ results: { search: new Error('Stopped by the user.') } });
  ctx.__sdRunEvent = (d) => ev.push(JSON.parse(JSON.stringify(d)));
  ctx.__sdAgentStopped = true;
  await ctx.nCe('https://x.example/mcp', 'search', { q: 1 });
  assert.equal(sent.length, 0);
  assert.deepEqual(ev.map((e) => [e.phase, e.stopped || false]), [['start', false], ['end', true]]);
  // A real error of an external server still goes back to the model.
  const b = setup({ results: { search: new Error('rate limited') } });
  b.ctx.__sdAgentStopped = true;
  await b.ctx.nCe('https://x.example/mcp', 'search', { q: 2 });
  assert.equal(b.sent.length, 1);
});

