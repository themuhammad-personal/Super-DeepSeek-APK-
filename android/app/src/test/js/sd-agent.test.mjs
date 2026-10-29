// Tests for bds/sd-agent.js (sandbox agent glue). Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/sd-agent.js'), 'utf8');

const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * sd-agent in a vm context. `speed` divides every timer delay (the agent's
 * 700 ms…6 s continuity timers then take a few ms); `listeners` collects what
 * the agent registers on `document` so tests can fire (trusted) events.
 */
function load({ info = { supported: true, enabled: true, mode: 'auto' }, history = null, href = 'https://chat.deepseek.com/a/chat/s/abc', speed = 1, fetch = null } = {}) {
  const events = new EventTarget();
  const calls = [];
  const stops = [];
  const actives = [];
  const listeners = {};
  const ctx = {
    console, clearTimeout, clearInterval, Promise,
    setTimeout: (fn, ms, ...a) => setTimeout(fn, (ms || 0) / speed, ...a),
    setInterval: (fn, ms, ...a) => { const h = setInterval(fn, (ms || 0) / speed, ...a); h.unref(); return h; },
    JSON, Math, Object, Array, String, Date, WeakMap,
    Uint8Array, TextDecoder, CustomEvent,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { language: 'en' },
    location: { href },
    document: {
      documentElement: { lang: 'en' },
      body: null,
      querySelector: () => null,
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    },
    AndroidBridge: {
      sandboxInfo: () => JSON.stringify(info),
      sandboxStop: () => { stops.push(1); return 0; },
      setStorage: () => {},
      sandboxAgentActive: (v) => { actives.push(v); },
    },
    addEventListener: (...a) => events.addEventListener(...a),
    removeEventListener: (...a) => events.removeEventListener(...a),
    dispatchEvent: (e) => {
      events.dispatchEvent(e);
      if (e.type === 'bds:request-history-msgs' && history) {
        const { sessionId } = JSON.parse(e.detail);
        setTimeout(() => events.dispatchEvent(new CustomEvent('bds:history-msgs', {
          detail: JSON.stringify({ data: { biz_data: { chat_session: { id: sessionId }, chat_messages: history } } }),
        })), 5);
      }
      return true;
    },
  };
  ctx.window = ctx;
  ctx.__sdBridgeFetch = async (payload) => { calls.push(payload); return fetch ? fetch(payload) : { ok: true, result: { content: [] } }; };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
  return { win: ctx, calls, stops, actives, fire };
}

test('parses MCP tags: body JSON, args attribute, base64Args, self-closing', () => {
  const { win } = load();
  const b64 = Buffer.from(JSON.stringify({ command: 'echo "hi"' })).toString('base64url');
  const text = [
    'Plan first.',
    '<BDS:AUTO:MCP url="sandbox" tool="write_file">{"path":"a_b.py","content":"x = \\"*y*\\"\\n"}</BDS:AUTO:MCP>',
    `<BDS:AUTO:MCP url="sandbox" tool="run" args='{"command":"ls -la"}'>`,
    `<BDS:AUTO:MCP url="sandbox://linux" tool="run" base64Args="${b64}"/>`,
  ].join('\n');
  const tags = win.__sdAgent._parseTags(text);
  assert.equal(tags.length, 3);
  assert.deepEqual(plain(win.__sdAgent._tagArgs(tags[0])), { path: 'a_b.py', content: 'x = "*y*"\n' });
  assert.deepEqual(plain(win.__sdAgent._tagArgs(tags[1])), { command: 'ls -la' });
  assert.deepEqual(plain(win.__sdAgent._tagArgs(tags[2])), { command: 'echo "hi"' });
});

test('SDS tags (the current spelling) are parsed like BDS ones', () => {
  const { win } = load();
  const tags = win.__sdAgent._parseTags('<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"echo a_b"}</SDS:AUTO:MCP>');
  assert.equal(tags.length, 1);
  assert.deepEqual(plain(win.__sdAgent._tagArgs(tags[0])), { command: 'echo a_b' });
});

test('a ">" inside a quoted attribute does not end the tag', () => {
  const { win } = load();
  const tags = win.__sdAgent._parseTags(`<BDS:AUTO:MCP url="sandbox" tool="run" args='{"command":"echo 1 > f"}'></BDS:AUTO:MCP>`);
  assert.equal(tags.length, 1);
  assert.deepEqual(plain(win.__sdAgent._tagArgs(tags[0])), { command: 'echo 1 > f' });
});

test('picks the raw args of the matching sandbox call, newest reply first', () => {
  const { win } = load();
  const older = '<BDS:AUTO:MCP url="sandbox" tool="run">{"command":"old"}</BDS:AUTO:MCP>';
  const newer = [
    '<BDS:AUTO:MCP url="https://other.example/mcp" tool="run">{"command":"not sandbox"}</BDS:AUTO:MCP>',
    '<BDS:AUTO:MCP url="sandbox" tool="write_file">{"path":"x"}</BDS:AUTO:MCP>',
    '<BDS:AUTO:MCP url="sandbox" tool="run">{"command":"pytest -k \\"a_b\\""}</BDS:AUTO:MCP>',
  ].join('\n');
  const raw = win.__sdAgent._pickRawArgs([newer, older], 'run', { command: 'pytest -k "ab"' });
  assert.deepEqual(plain(raw), { command: 'pytest -k "a_b"' });
  assert.equal(win.__sdAgent._pickRawArgs([newer], 'edit_file', {}), null);
});

test('assistant texts skip thinking fragments and user messages', () => {
  const { win } = load();
  const texts = win.__sdAgent._assistantTexts([
    { role: 'USER', content: 'hi' },
    { role: 'ASSISTANT', fragments: [{ type: 'THINK', content: 'hmm' }, { type: 'RESPONSE', content: 'answer' }] },
    { role: 'ASSISTANT', content: 'plain' },
  ]);
  assert.deepEqual(plain(texts), ['plain', 'answer']);
});

test('sandbox calls get their exact arguments from the chat history', async () => {
  const history = [
    { role: 'USER', content: 'make it' },
    { role: 'ASSISTANT', content: 'Writing.\n<BDS:AUTO:MCP url="sandbox" tool="write_file">{"path":"my_app.py","content":"print(\\"__main__\\")\\n"}</BDS:AUTO:MCP>' },
  ];
  const { win, calls } = load({ history });
  // What the engine read from the rendered Markdown: underscores and escapes lost.
  const mangled = { path: 'myapp.py', content: 'print("main")\n' };
  const reply = await win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'sandbox', toolName: 'write_file', args: mangled });
  assert.equal(reply.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), { path: 'my_app.py', content: 'print("__main__")\n' });
});

test('falls back to the engine args when the history has no match', async () => {
  const { win, calls } = load({ history: [{ role: 'ASSISTANT', content: 'no tags here' }] });
  await win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'sandbox://linux', toolName: 'run', args: { command: 'ls' } });
  assert.deepEqual(plain(calls[0].args), { command: 'ls' });
});

test('ask mode fails closed when the confirmation UI is unavailable', async () => {
  // load() intentionally has no document.body, reproducing a page state where
  // the ask-mode approval sheet cannot be mounted.
  const { win, calls } = load({
    info: { supported: true, enabled: true, mode: 'ask' },
    speed: 1000,
  });
  const reply = await win.__sdBridgeFetch({
    type: 'bds-mcp-call',
    serverUrl: 'sandbox',
    toolName: 'run',
    args: { command: 'echo should-not-run' },
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Confirmation UI unavailable/);
  assert.equal(calls.length, 0, 'the sandbox bridge must not receive a call without approval UI');
});

test('other bridge messages pass straight through', async () => {
  const { win, calls } = load();
  await win.__sdBridgeFetch({ type: 'bds-fetch-url', url: 'https://x' });
  await win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'https://mcp.example', toolName: 't', args: {} });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].serverUrl, 'https://mcp.example');
});

test('after Stop, sandbox calls are refused without reaching the device', async () => {
  const { win, calls, stops } = load();
  win.__sdAgent.stop(true);
  assert.equal(stops.length, 1);
  assert.equal(win.__sdAgentStopped, true);
  const reply = await win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'sandbox', toolName: 'run', args: { command: 'ls' } });
  assert.equal(reply.ok, false);
  assert.equal(calls.length, 0);
});

test('the sandbox server is offered only when supported and enabled', () => {
  assert.equal(load().win.__sdSandboxServers().length, 1);
  assert.equal(load().win.__sdSandboxServers()[0].serverUrl, 'sandbox://linux');
  assert.equal(load({ info: { supported: false } }).win.__sdSandboxServers().length, 0);
  assert.equal(load({ info: { supported: true, enabled: false } }).win.__sdSandboxServers().length, 0);
});

test('sandbox URL detection', () => {
  const { win } = load();
  const f = win.__sdAgent._isSandboxUrl;
  assert.equal(f('sandbox'), true);
  assert.equal(f('Sandbox://linux'), true);
  assert.equal(f('[sandbox](sandbox://linux)'), true);
  assert.equal(f('https://sandbox.example.com'), false);
});

test('the app is told while the agent works, and when it stops', async () => {
  const { win, actives } = load();
  assert.deepEqual(actives, [false], 'a fresh page clears any stale flag');
  await win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'sandbox', toolName: 'run', args: { command: 'ls' } });
  assert.equal(actives.at(-1), true);
  win.__sdAgent.stop(true);
  assert.equal(actives.at(-1), false);
  assert.deepEqual(actives, [false, true, false], 'reported only on changes');
});

test('tool-call spinners stop once a later message exists, or when all is idle', async () => {
  const { win } = load();
  const m1 = { id: 1, contains(x) { return x === this; } };
  const m2 = { id: 2, contains(x) { return x === this; } };
  const card = (msg) => {
    const cls = new Set(['bds-mcp-loading']);
    return { classList: { add: (c) => cls.add(c), has: (c) => cls.has(c) }, closest: () => msg, cls };
  };
  const old = card(m1);
  const current = card(m2);
  win.document.querySelectorAll = (sel) => {
    if (sel.startsWith('.bds-mcp-loading')) return [old, current].filter((c) => !c.cls.has('sd-done') && !c.cls.has('sd-stopped'));
    if (sel === '.ds-message') return [m1, m2];
    return [];
  };
  // A call is still running for the last message: only the older card is done.
  const running = win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'https://other.example/mcp', toolName: 't', args: {} });
  assert.equal(win.__sdAgent._sweepCards(), 1);
  assert.ok(old.cls.has('sd-done'));
  assert.ok(!current.cls.has('sd-done'));
  await running;
  // Finished, but still inside the idle grace period.
  assert.equal(win.__sdAgent._sweepCards(), 1);
  // Later: idle → done.
  const realNow = win.Date.now;
  win.Date.now = () => realNow() + 10000;
  try {
    assert.equal(win.__sdAgent._sweepCards(), 0);
  } finally {
    win.Date.now = realNow;
  }
  assert.ok(current.cls.has('sd-done'));
});

const mcpResult = (tool) => '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for ' + tool + ' @ sandbox://linux\n[SDS:AUTO_MCP_RESULT]\n{}\n[/SDS:AUTO_MCP_RESULT]\n</SuperDeepSeek>';

test('continuity: replies that announce more work are recognised', () => {
  const { win } = load();
  const u = win.__sdAgent._looksUnfinished;
  assert.equal(u('Files are written. Now I will run the tests:'), true);
  assert.equal(u("Let me check the output"), true);
  assert.equal(u('এখন টেস্ট চালাচ্ছি।'), true);
  assert.equal(u('Done! The app is in Downloads/app.zip.'), false);
  assert.equal(u('Should I also add dark mode?'), false);
  assert.equal(u('কাজ শেষ। ফাইলটি Downloads-এ আছে।'), false);
  assert.equal(u('Summary:\n```\nnext: x\n```\nAll tests pass.'), false);
});

test('continuity: nudge only inside a tool chain', () => {
  const { win } = load();
  const n = win.__sdAgent._nudgeFor;
  const chain = (reply) => [
    { role: 'USER', content: 'build it' },
    { role: 'ASSISTANT', content: 'x' },
    { role: 'USER', content: mcpResult('run') },
    { role: 'ASSISTANT', content: reply },
  ];
  assert.match(n(chain('Now I will install the packages:')), /without a tool call/);
  assert.equal(n(chain('All done, tests pass.')), null);
  assert.equal(n([{ role: 'USER', content: 'hi' }, { role: 'ASSISTANT', content: 'Let me think:' }]), null);
  assert.equal(n(chain('<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"ls"}</SDS:AUTO:MCP>')), null);
  assert.match(n(chain('<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"echo "x""}</SDS:AUTO:MCP>')), /valid JSON/);
  assert.equal(n([...chain('ok'), { role: 'USER', content: 'thanks' }]), null);
});

test('continuity: after a reply the engine re-checks it and an unfinished chain is nudged once', async () => {
  const history = [
    { role: 'USER', content: 'make an app' },
    { role: 'USER', content: mcpResult('write_file') },
    { role: 'ASSISTANT', content: 'Written. Now I will run it:' },
  ];
  const { win } = load({ history });
  // The agent has worked on this instruction (one sandbox call went through).
  await win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'sandbox', toolName: 'write_file', args: { path: 'a', content: '' } });
  let gen = true;
  const reprocessed = [];
  const sent = [];
  win.__sdEngine = {
    isGenerating: () => gen,
    reprocess: () => reprocessed.push(Date.now()),
    sendQuiet: (text, label) => { sent.push({ text, label }); },
  };
  await new Promise((r) => setTimeout(r, 700));
  gen = false;
  await new Promise((r) => setTimeout(r, 7600));
  assert.ok(reprocessed.length >= 3, 'engine asked to look at the reply again');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].label, 'Agent continue');
  assert.match(sent[0].text, /^<SuperDeepSeek>\n\[SDS:AUTO\] Agent continue\n[\s\S]*<\/SuperDeepSeek>$/);
});

test('prompt context: live sandbox state for the tool instructions', () => {
  const { win } = load();
  const pc = (c) => plain(win.__sdAgent._promptContext(c));
  assert.deepEqual(pc({ supported: false }), []);
  assert.deepEqual(pc({ supported: true, enabled: false }), []);
  const fresh = pc({ supported: true, enabled: true, installed: false, mode: 'auto', jobs: [], workspace: [] });
  assert.equal(fresh.length, 2);
  assert.match(fresh[0], /not set up yet/);
  // T5: the run rules ride along with the instructions.
  assert.match(fresh[1], /progress card/);
  assert.match(fresh[1], /read_file \(offset_line, max_lines\)/);
  assert.doesNotMatch(fresh[0], /workspace/);
  const busy = pc({
    supported: true, enabled: true, installed: true, mode: 'ask', freeMb: 120,
    jobs: [{ id: 'job1', command: 'python3 -m http.server 8000' }],
    workspace: ['site/', 'notes.md'], workspaceCount: 30,
  })[0];
  assert.match(busy, /set up and ready/);
  assert.match(busy, /approves every call/);
  assert.match(busy, /job1 `python3 -m http\.server 8000`/);
  assert.match(busy, /site\/, notes\.md, … \(30 entries\)/);
  assert.match(busy, /Only 120 MB/);
  const empty = pc({ supported: true, enabled: true, installed: true, workspace: [], workspaceCount: 0 })[0];
  assert.match(empty, /\/root\/workspace is empty/);
  // Garbage from the bridge never throws.
  assert.deepEqual(plain(win.__sdAgent.promptContext()), []);
});

test('settings status line follows the sandbox state', () => {
  const { win } = load();
  const s = win.__sdAgent._statusText;
  assert.match(s({ supported: false }), /Not available/);
  assert.match(s({ supported: true, enabled: false }), /^Off/);
  assert.match(s({ supported: true, installing: true, progress: 0.42 }), /Setting up Linux… 42%/);
  assert.match(s({ supported: true, installed: true, version: '3.20.3', mode: 'ask', active: 2 }), /^On · Alpine 3\.20\.3 · asks before each command · 2 running$/);
  assert.match(s({ supported: true, installed: false }), /sets itself up on first use/);
});

test('settings overview value and page API', () => {
  const { win } = load();
  const s = win.__sdAgent._statusShort;
  assert.equal(s({ supported: false }), '');
  assert.equal(s({ supported: true, enabled: false }), 'Off');
  assert.equal(s({ supported: true, active: 1 }), 'Working');
  assert.equal(s({ supported: true, installed: true }), 'On');
  for (const k of ['supported', 'statusShort', 'mountSettings']) assert.equal(typeof win.__sdAgent[k], 'function', k);
});

test('the engine locale decides the language of the agent UI', () => {
  const { win } = load();
  win.__sdEngine = { locale: () => 'bn' };
  assert.match(win.__sdAgent._statusText({ supported: true, enabled: false }), /^বন্ধ/);
  win.__sdEngine = { locale: () => 'en' };
  assert.match(win.__sdAgent._statusText({ supported: true, enabled: false }), /^Off/);
});

// ── The agent loop must end: no nudge loops, no re-done work ───────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const unfinishedChain = [
  { role: 'USER', content: 'make an app' },
  { role: 'USER', content: mcpResult('run') },
  { role: 'ASSISTANT', content: 'Written. Now I will run it:' },
];

/** One agent turn: a sandbox call, then a reply that streams and ends. */
async function agentTurn(win, engine) {
  await win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'sandbox', toolName: 'run', args: { command: 'ls' } });
  engine.gen = true;
  await wait(90);
  engine.gen = false;
  await wait(650);
}

function fakeEngine(win) {
  const engine = { gen: false, sent: [] };
  win.__sdEngine = {
    isGenerating: () => engine.gen,
    reprocess() {},
    sendQuiet: (text, label) => { engine.sent.push({ text, label }); },
  };
  return engine;
}

test('continuity: nudges are counted per instruction; tool calls in between never refill them', async () => {
  const { win, fire } = load({ history: unfinishedChain, speed: 20 });
  const engine = fakeEngine(win);
  await agentTurn(win, engine);
  assert.equal(engine.sent.length, 1);
  // The model answered the nudge by working again and stalled again.
  await agentTurn(win, engine);
  assert.equal(engine.sent.length, 2);
  // Before, every tool call reset the budget: an endless redo loop.
  await agentTurn(win, engine);
  await agentTurn(win, engine);
  assert.equal(engine.sent.length, 2, 'at most two nudges per instruction');
  // Automatic (untrusted) typing does not count as a new instruction …
  const composer = { closest: (sel) => (sel.startsWith('textarea') ? {} : null) };
  fire('input', { isTrusted: false, target: composer });
  await agentTurn(win, engine);
  assert.equal(engine.sent.length, 2);
  // … the user's own typing does.
  fire('input', { isTrusted: true, target: composer });
  await agentTurn(win, engine);
  assert.equal(engine.sent.length, 3);
});

test('continuity: no nudge when the agent did no work for the current instruction', async () => {
  const { win } = load({ history: unfinishedChain, speed: 20 });
  const engine = fakeEngine(win);
  engine.gen = true;
  await wait(90);
  engine.gen = false;
  await wait(650);
  assert.equal(engine.sent.length, 0);
});

test('continuity: finished replies are never taken for unfinished ones', () => {
  const { win } = load();
  const u = win.__sdAgent._looksUnfinished;
  // Closings that used to trigger a nudge ("let me", a trailing ":" before a code block).
  assert.equal(u('The app is ready. Let me know if you want any changes.'), false);
  assert.equal(u('Feel free to ask if anything is unclear.'), false);
  assert.equal(u('Run it with:\n```bash\npython3 app.py\n```'), false);
  assert.equal(u('Everything works:\n```\n$ npm test\n3 passing\n```\n'), false);
  assert.equal(u('আর কিছু লাগলে জানাবেন।'), false);
  assert.equal(u('কাজ সম্পন্ন হয়েছে, নিচে সারসংক্ষেপ:'), false);
  assert.equal(u('All tests pass ✅ You can now open the preview:'), false);
  assert.equal(u('If you want, I can also add a dark mode…'), false);
  // Real stalls are still recognised.
  assert.equal(u('Files are written. Now I will run the tests:'), true);
  assert.equal(u("Next, I'll install Flask…"), true);
  assert.equal(u('এখন টেস্ট চালাচ্ছি।'), true);
});

test('continuity: the nudge never claims the task is unfinished', () => {
  const { win } = load();
  const body = win.__sdAgent._nudgeFor([
    { role: 'USER', content: 'x' }, { role: 'USER', content: mcpResult('run') },
    { role: 'ASSISTANT', content: 'Now I will run the tests:' },
  ]);
  assert.doesNotMatch(body, /not finished/);
  assert.match(body, /If the task is complete, reply with one short line/);
  assert.match(body, /Never repeat work that is already done/);
});

// ── Scroll guard ──────────────────────────────────────────────────────────

function scrollSetup() {
  const env = load();
  let clock = 1_000_000;
  env.win.Date = { now: () => clock };
  const el = {
    nodeType: 1, clientHeight: 600, scrollHeight: 6000, top: 5400, writes: 0,
    closest: () => null,
    get scrollTop() { return this.top; },
    set scrollTop(v) { this.top = v; this.writes++; },
  };
  const scroll = () => env.fire('scroll', { target: el });
  const later = (ms) => { clock += ms; };
  const userScroll = (to) => {
    env.fire('touchstart', { isTrusted: true });
    el.top = to; scroll();
    env.fire('touchend', { isTrusted: true, touches: [] });
  };
  return { ...env, el, scroll, later, userScroll };
}

test('scroll guard: an automatic jump to the bottom never pulls a reading user down', () => {
  const { el, scroll, later, userScroll } = scrollSetup();
  scroll();                                   // at the bottom
  el.top = 5400; later(2000); scroll();
  assert.equal(el.writes, 0, 'at the bottom the chat follows freely');
  userScroll(3000);
  later(2000);
  el.top = 5400; scroll();                    // DeepSeek scrolls down after an automatic send
  assert.equal(el.top, 3000, 'the jump is undone');
  scroll();                                   // the scroll event of our own correction
  assert.equal(el.top, 3000);
  later(500);
  el.top = 4900; scroll();                    // a big jump short of the bottom (> 60% of the view)
  assert.equal(el.top, 3000);
  scroll();
  later(500);
  el.top = 3060; scroll();                    // content above grew a little
  assert.equal(el.top, 3060, 'small shifts are kept');
  later(500);
  el.top = 1000; scroll();                    // content removed: moves up are kept
  assert.equal(el.top, 1000);
});

test('scroll guard: the user always wins (own scrolls, taps, sends, other chats)', () => {
  const { win, el, scroll, later, userScroll, fire } = scrollSetup();
  scroll();
  userScroll(3000);
  later(2000);
  // A tap (e.g. the scroll-down arrow) lets the following jump through.
  fire('pointerdown', { isTrusted: true, type: 'pointerdown' });
  el.top = 5400; scroll();
  assert.equal(el.top, 5400);
  // Back at the bottom: the chat follows again.
  later(2000);
  el.top = 5400; scroll();
  assert.equal(el.top, 5400);
  // Reading higher up, the user sends a message: the late jump to the reply goes through.
  userScroll(2000);
  later(2000);
  const send = { querySelector: (sel) => (sel === '.ds-icon-send' ? {} : null) };
  fire('click', { isTrusted: true, target: { closest: () => send } });
  later(3000);
  el.top = 5400; scroll();
  assert.equal(el.top, 5400);
  // Typing is not a scroll of the user.
  userScroll(2500);
  later(2000);
  fire('keydown', { isTrusted: true, type: 'keydown', key: 'a', target: { closest: () => null } });
  el.top = 5400; scroll();
  assert.equal(el.top, 2500);
  // Another chat starts at its own bottom.
  win.location.href = 'https://chat.deepseek.com/a/chat/s/other';
  later(2000);
  el.top = 5400; scroll();
  assert.equal(el.top, 5400);
});

test('scroll guard: the agent UI and small or editable scrollers are left alone', () => {
  const { win, fire } = scrollSetup();
  const g = win.__sdAgent._scrollGuard;
  assert.ok(g.states, 'installed');
  const inside = { nodeType: 1, clientHeight: 600, scrollHeight: 6000, top: 0, closest: (sel) => (sel.includes('#bds-root') ? {} : null),
    get scrollTop() { return this.top; }, set scrollTop(v) { throw new Error('must not write ' + v); } };
  fire('scroll', { target: inside });
  inside.top = 5400;
  fire('scroll', { target: inside });
  const tiny = { nodeType: 1, clientHeight: 80, scrollHeight: 900, top: 0, closest: () => null,
    get scrollTop() { return this.top; }, set scrollTop(v) { throw new Error('must not write ' + v); } };
  fire('scroll', { target: tiny });
  tiny.top = 820;
  fire('scroll', { target: tiny });
});

// ── 2.71.0: output saving and the step cap ──────────────────────────────────

/** A tiny DOM: enough for the confirm sheet (buttons are clicked by text). */
function fakeDom(win) {
  const appended = [];
  const el = (tag) => {
    const e = { tagName: tag, children: [], textContent: '', className: '', id: '', listeners: {},
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      remove() { const i = appended.indexOf(this); if (i >= 0) appended.splice(i, 1); },
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] };
    return e;
  };
  win.document.createElement = el;
  win.document.getElementById = (id) => appended.find((e) => e.id === id) || null;
  win.document.querySelectorAll = () => [];
  win.document.body = { appendChild(c) { appended.push(c); return c; }, contains: () => true };
  win.document.head = { appendChild() {} };
  win.document.createTextNode = (text) => ({ nodeType: 3, textContent: text });
  win.document.documentElement.appendChild = () => {};
  win.document.documentElement.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  const buttons = () => {
    const out = [];
    const walk = (e) => { if (e.tagName === 'button') out.push(e); (e.children || []).forEach(walk); };
    appended.forEach(walk);
    return out;
  };
  const click = (text) => { const b = buttons().find((x) => x.textContent === text); assert.ok(b, 'button ' + text); b.listeners.click(); };
  const heading = () => { let h = ''; const walk = (e) => { if (e.tagName === 'h3') h = e.textContent; (e.children || []).forEach(walk); }; appended.forEach(walk); return h; };
  return { appended, click, heading };
}

test('a big output is saved in /tmp/sd-out through the unwrapped bridge', async () => {
  const { win, calls } = load({ info: { supported: true, enabled: true, installed: true, mode: 'auto' } });
  const p = await win.__sdSaveOutput('line\n'.repeat(5000), 'run');
  assert.match(p, /^\/tmp\/sd-out\/[a-z0-9]+-run\.txt$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'write_file');
  assert.equal(calls[0].serverUrl, 'sandbox://linux');
  assert.equal(calls[0].args.path, p);
  assert.equal(calls[0].args.content.length, 25000);
  // Unique names, odd tool names are made safe.
  const q = await win.__sdSaveOutput('x', '../evil tool');
  assert.notEqual(q, p);
  assert.match(q, /^\/tmp\/sd-out\/[a-z0-9]+-\.\._evil_tool\.txt$/);
  assert.ok(!q.slice('/tmp/sd-out/'.length).includes('/'));
});

test('output saving is skipped when it could surprise the user', async () => {
  const cases = [
    { info: { supported: true, enabled: true, installed: false, mode: 'auto' } },   // would install Linux
    { info: { supported: true, enabled: true, installed: true, mode: 'ask' } },     // every call is approved by hand
    { info: { supported: true, enabled: false, installed: true, mode: 'auto' } },
    { info: { supported: false } },
  ];
  for (const c of cases) {
    const { win, calls } = load(c);
    assert.equal(await win.__sdSaveOutput('x'.repeat(100), 'run'), null);
    assert.equal(calls.length, 0);
  }
  const { win, calls } = load({ info: { supported: true, enabled: true, installed: true, mode: 'auto' } });
  assert.equal(await win.__sdSaveOutput('x', 'read_file'), null);  // the file already exists
  win.__sdAgentStopped = true;
  assert.equal(await win.__sdSaveOutput('x', 'run'), null);
  assert.equal(calls.length, 0);
});

test('a failed, erroring, throwing or hanging save returns null', async () => {
  const info = { supported: true, enabled: true, installed: true, mode: 'auto' };
  const replies = [
    () => ({ ok: false, error: 'disk full' }),
    () => ({ ok: true, result: { isError: true, content: [{ type: 'text', text: 'Sandbox error' }] } }),
    () => { throw new Error('bridge gone'); },
    () => new Promise(() => {}),   // never answers: the 8 s timeout wins
  ];
  for (const fetch of replies) {
    const { win, calls } = load({ info, fetch, speed: 1000 });
    assert.equal(await win.__sdSaveOutput('x'.repeat(10), 'run'), null);
    assert.equal(calls.length, 1);
  }
});

test('step cap: after 25 calls the user is asked; Continue allows 25 more', async () => {
  const { win, calls } = load({ info: { supported: true, enabled: true, installed: true, mode: 'auto' } });
  const dom = fakeDom(win);
  const call = (n) => win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'https://x.example/mcp', apiKey: '', toolName: 't' + n, args: {} });
  for (let i = 1; i <= 25; i++) await call(i);
  assert.equal(calls.length, 25);
  assert.equal(dom.appended.length, 0);
  const p26 = call(26);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, 25, 'the 26th call waits for the answer');
  assert.match(dom.heading(), /25 steps\. Continue\?/);
  dom.click('Continue');
  const r = await p26;
  assert.equal(r.ok, true);
  assert.equal(calls.length, 26);
  for (let i = 27; i <= 50; i++) await call(i);
  assert.equal(calls.length, 50);
  assert.equal(dom.appended.length, 0);
  const p51 = call(51);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(dom.heading(), /50 steps/);
  dom.click('Stop');
  const r51 = await p51;
  assert.equal(r51.ok, false);
  assert.match(r51.error, /Stopped by the user/);
  assert.equal(calls.length, 50);
  assert.equal(win.__sdAgentStopped, true);
});

test('step cap: a new instruction of the user starts the count again', async () => {
  const { win, calls, fire } = load({ info: { supported: true, enabled: true, installed: true, mode: 'auto' } });
  fakeDom(win);
  const call = () => win.__sdBridgeFetch({ type: 'bds-mcp-call', serverUrl: 'https://x.example/mcp', apiKey: '', toolName: 't', args: {} });
  for (let i = 0; i < 20; i++) await call();
  assert.equal(plain(win.__sdAgent.stepCap()).done, 20);
  const box = { closest: (sel) => (/textarea/.test(sel) ? box : null) };
  fire('input', { isTrusted: true, target: box });
  assert.deepEqual(plain(win.__sdAgent.stepCap()), { done: 0, next: 25 });
  for (let i = 0; i < 25; i++) await call();
  assert.equal(calls.length, 45);
});

test('history of the open chat is available to the run drawer', async () => {
  const history = [{ role: 'USER', content: 'hi' }, { role: 'ASSISTANT', fragments: [{ type: 'THINK', content: 'x' }, { type: 'RESPONSE', content: 'ok' }] }];
  const { win } = load({ history });
  const h = await win.__sdAgent.history();
  assert.equal(h.length, 2);
  assert.equal(win.__sdAgent.messageText(h[1]), 'ok');
  const off = load({ href: 'https://chat.deepseek.com/' });
  assert.equal(await off.win.__sdAgent.history(), null);
});

test('the settings page reports the engine self-check state', () => {
  const { win } = load();
  // No health module (older build): no diagnostics row at all.
  assert.equal(win.__sdAgent._healthState().text, '');

  win.__sdHealth = { report: () => ({ ok: true, failed: [], modules: [] }) };
  assert.ok(/All page checks pass/.test(win.__sdAgent._healthState().text));

  win.__sdHealth = { report: () => ({ ok: false, failed: [{ id: 'composer' }, { id: 'copy' }], modules: ['__sdRun'] }) };
  const st = win.__sdAgent._healthState();
  assert.equal(st.ok, false);
  assert.ok(/2 page checks failed/.test(st.text), st.text);
  assert.ok(/1 modules missing/.test(st.text), st.text);

  // A health module that throws must never break the settings page.
  win.__sdHealth = { report: () => { throw new Error('boom'); } };
  assert.deepEqual(plain(win.__sdAgent._healthState()), { text: '', ok: null });
});
