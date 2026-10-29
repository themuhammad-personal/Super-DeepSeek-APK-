// Tests for bds/sd-run.js (one card per agent run, 2.71.0). Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BDS = path.join(here, '../../main/bds-assets/bds');
const RUN = fs.readFileSync(path.join(BDS, 'sd-run.js'), 'utf8');
const AGENT = fs.readFileSync(path.join(BDS, 'sd-agent.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

/** sd-agent + sd-run in a vm without a page (body is null: nothing is scanned). */
function load({ lang = 'en' } = {}) {
  const storage = {};
  const ctx = {
    console, setTimeout, clearTimeout, Promise, JSON, Math, Object, Array, String, Number, Date, WeakMap, Set,
    Uint8Array, TextDecoder, CustomEvent, isFinite,
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref(); return h; },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { language: lang },
    location: { href: 'https://chat.deepseek.com/a/chat/s/abc' },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } },
    document: {
      documentElement: { lang, classList: { toggle() {}, remove() {}, add() {} } },
      body: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    AndroidBridge: { sandboxInfo: () => JSON.stringify({ supported: true, enabled: true, mode: 'auto' }), sandboxAgentActive() {} },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  };
  ctx.window = ctx;
  ctx.__sdBridgeFetch = async () => ({ ok: true, result: {} });
  vm.createContext(ctx);
  vm.runInContext(AGENT, ctx);
  vm.runInContext(RUN, ctx);
  return { win: ctx, R: ctx.__sdRun, storage };
}

const U = { role: 'user', auto: false, calls: 0 };
const R = { role: 'user', auto: true, calls: 0 };
const A = (calls = 0) => ({ role: 'assistant', auto: false, calls });

test('a finished run: one visible reply with the card, the final answer, the rest hidden', () => {
  const { R: run } = load();
  const g = plain(run._groupRuns([U, A(2), R, A(1), R, A(0)]));
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].user, g[0].host, g[0].final], [0, 1, 5]);
  assert.deepEqual(g[0].hidden, [2, 3, 4]);
  assert.equal(g[0].calls, 3);
  assert.equal(g[0].last, true);
});

test('a running run: the card is on the first reply, nothing else yet', () => {
  const { R: run } = load();
  let g = plain(run._groupRuns([U, A(1)]));
  assert.deepEqual([g[0].host, g[0].final, g[0].hidden], [1, -1, []]);
  // Results arrived, the next reply is still being written (no call yet): it shows.
  g = plain(run._groupRuns([U, A(1), R, A(0)]));
  assert.deepEqual([g[0].host, g[0].final, g[0].hidden], [1, 3, [2]]);
  // …and once it has a call it goes behind the card.
  g = plain(run._groupRuns([U, A(1), R, A(1)]));
  assert.deepEqual([g[0].host, g[0].final, g[0].hidden], [1, -1, [2, 3]]);
});

test('raw MCP calls count as run steps and automatic results ignore DOM role mismatches', () => {
  const { R: run } = load();
  const raw = '<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"ls"}</SDS:AUTO:MCP>';
  assert.equal(run._rawCallCount(raw), 1);
  assert.equal(run._rawCallCount('ordinary assistant prose'), 0);
  const message = plain(run._classifyMessage('assistant', raw, 0, false));
  assert.deepEqual(message, { role: 'assistant', auto: false, calls: 1 });

  const result = '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox://linux\n' +
    '[SDS:AUTO_MCP_RESULT]\n{"toolName":"run","content":"ok"}\n' +
    '[/SDS:AUTO_MCP_RESULT]\n</SuperDeepSeek>';
  const auto = plain(run._classifyMessage('assistant', result, 0, false));
  assert.deepEqual(auto, { role: 'user', auto: true, calls: 0 });

  const g = plain(run._groupRuns([
    { role: 'user', auto: false, calls: 0 },
    message,
    auto,
    { role: 'assistant', auto: false, calls: 0 },
  ]));
  assert.equal(g.length, 1);
  assert.equal(g[0].calls, 1);
  assert.deepEqual(g[0].hidden, [2]);
  assert.equal(g[0].final, 3);
});

test('raw call spans support name= and preserve prose around a call', () => {
  const { win, R: run } = load();
  const raw = 'I will execute it: <SDS:AUTO:MCP url="sandbox" ' +
    'name="run">{"command":"echo one"}</SDS:AUTO:MCP> done.';
  const spans = plain(run._findRawCallSpans(raw));
  assert.equal(spans.length, 1);
  assert.equal(raw.slice(spans[0].start, spans[0].end),
    '<SDS:AUTO:MCP url="sandbox" name="run">{"command":"echo one"}</SDS:AUTO:MCP>');
  assert.equal(run._rawCallCount('<SDS:AUTO:MCP name="run"/>'), 1);
  assert.equal(raw.slice(0, spans[0].start), 'I will execute it: ');
  assert.equal(raw.slice(spans[0].end), ' done.');

  const text = (value) => {
    const n = { nodeType: 3, nodeValue: value, parentNode: null };
    Object.defineProperty(n, 'textContent', { get() { return this.nodeValue; } });
    n.splitText = function (offset) {
      const tail = text(this.nodeValue.slice(offset));
      this.nodeValue = this.nodeValue.slice(0, offset);
      const siblings = this.parentNode.childNodes;
      siblings.splice(siblings.indexOf(this) + 1, 0, tail);
      tail.parentNode = this.parentNode;
      return tail;
    };
    return n;
  };
  const el = (tag, children = []) => {
    const node = {
      nodeType: 1, tagName: tag, id: '', parentNode: null, childNodes: [], attrs: {},
      classList: { contains: () => false },
      hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; },
      querySelectorAll: () => [],
      appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; },
      replaceChild(next, old) {
        const i = this.childNodes.indexOf(old);
        if (i < 0) throw new Error('old child not found');
        this.childNodes[i] = next; next.parentNode = this; old.parentNode = null; return old;
      },
      insertBefore(next, ref) {
        // Validate the reference before any no-op or node move, as the DOM does.
        const i = this.childNodes.indexOf(ref);
        if (i < 0) throw new Error('reference child not found');
        if (next === ref) return next;
        const oldParent = next.parentNode;
        if (oldParent && Array.isArray(oldParent.childNodes)) {
          const oldIndex = oldParent.childNodes.indexOf(next);
          if (oldIndex >= 0) oldParent.childNodes.splice(oldIndex, 1);
        }
        const destinationIndex = this.childNodes.indexOf(ref);
        this.childNodes.splice(destinationIndex, 0, next);
        next.parentNode = this;
        return next;
      },
      removeChild(child) {
        const i = this.childNodes.indexOf(child);
        if (i >= 0) this.childNodes.splice(i, 1);
        child.parentNode = null; return child;
      },
    };
    Object.defineProperty(node, 'textContent', { get() { return this.childNodes.map(c => c.textContent).join(''); } });
    Object.defineProperty(node, 'firstChild', { get() { return this.childNodes[0] || null; } });
    children.forEach(child => node.appendChild(child));
    return node;
  };
  // A tool tag split across sibling paragraphs, with ordinary text on both sides
  // and a fenced code example that must not be hidden or counted.
  const first = el('P', [text(' <SDS:AUTO:MCP url="sandbox" ')]);
  const second = el('P', [text('name="run">{"command":"ls"}</SDS:AUTO:MCP> ')]);
  const before = text('Before. ');
  const after = text('After.');
  const example = el('PRE', [text('<SDS:AUTO:MCP url="sandbox" tool="example"/>')]);
  const host = el('DIV', [before, first, second, after, example]);
  host.querySelectorAll = () => [];
  win.document.createElement = (tag) => el(tag.toUpperCase());

  // Fake insertBefore should not mutate the DOM when validation fails or when
  // a node is inserted immediately before itself.
  const destination = el('DIV', [text('keep'), text('ref')]);
  const movingParent = el('DIV', [text('move')]);
  const moving = movingParent.firstChild;
  const invalidRef = el('P', [text('not a destination child')]);
  const beforeInvalid = movingParent.textContent;
  assert.throws(() => destination.insertBefore(moving, invalidRef), /reference child not found/);
  assert.equal(movingParent.textContent, beforeInvalid);
  assert.equal(movingParent.firstChild, moving);
  assert.throws(() => destination.insertBefore(invalidRef, invalidRef), /reference child not found/);
  const firstDestinationNode = destination.firstChild;
  assert.equal(destination.insertBefore(firstDestinationNode, firstDestinationNode), firstDestinationNode);
  assert.equal(destination.firstChild, firstDestinationNode);
  assert.equal(destination.textContent, 'keepref');
  assert.equal(run._protocolText(host), 'Before.  <SDS:AUTO:MCP url="sandbox" name="run">{"command":"ls"}</SDS:AUTO:MCP> After.');
  assert.equal(run._protocolText(el('DIV', [example])), '', 'fenced code-only examples are excluded from protocol detection');
  const hidden = new Set();
  run._hideRawCallBlocks(host, hidden);
  assert.equal(hidden.size, 2, 'both DOM text segments of the split call are wrapped');
  assert.equal(host.textContent, 'Before.  <SDS:AUTO:MCP url="sandbox" name="run">{"command":"ls"}</SDS:AUTO:MCP> After.<SDS:AUTO:MCP url="sandbox" tool="example"/>');
  assert.equal([...hidden].every(n => n.hasAttribute('data-sd-run-raw-hidden')), true);
  hidden.forEach(n => run._restoreHiddenRawNode(n));
  assert.equal(host.textContent, 'Before.  <SDS:AUTO:MCP url="sandbox" name="run">{"command":"ls"}</SDS:AUTO:MCP> After.<SDS:AUTO:MCP url="sandbox" tool="example"/>');
  assert.equal(first.childNodes.filter(n => n.tagName === 'SPAN').length, 0, 'restore unwraps first paragraph spans');
  assert.equal(second.childNodes.filter(n => n.tagName === 'SPAN').length, 0, 'restore unwraps second paragraph spans');
});

test('MCP span parser rejects quoted fake attributes and separates incomplete calls', () => {
  const { R: run } = load();
  const quoted = '<SDS:AUTO:MCP url="sandbox" note="tool=run"/>';
  assert.equal(run._rawCallCount(quoted), 0, 'quoted text is not an attribute');
  const first = '<SDS:AUTO:MCP url="sandbox" tool="run">partial output';
  assert.equal(run._rawCallCount(first), 1);
  assert.deepEqual(plain(run._findRawCallSpans(first)), [{ start: 0, end: first.length }]);

  const second = '<SDS:AUTO:MCP url="sandbox" name="job">done</SDS:AUTO:MCP>';
  const both = first + second;
  const spans = plain(run._findRawCallSpans(both));
  assert.equal(spans.length, 2);
  assert.equal(both.slice(spans[0].start, spans[0].end), first);
  assert.equal(both.slice(spans[1].start, spans[1].end), second);
});

test('encoded closing-tag text inside a call body does not terminate the span', () => {
  const { R: run } = load();
  // This is what textContent exposes after the browser decodes &lt; and &gt;.
  const raw = '<SDS:AUTO:MCP url="sandbox" tool="write_file">' +
    '{"content":"literal </SDS:AUTO:MCP> text"}</SDS:AUTO:MCP>';
  const spans = plain(run._findRawCallSpans(raw));
  assert.equal(spans.length, 1);
  assert.equal(raw.slice(spans[0].start, spans[0].end), raw);
});

test('assistant examples and filenames are not automatic results without the protocol envelope', () => {
  const { R: run } = load();
  assert.equal(run._isAutoUserText('Final: saved as mcp_results_run.txt', 'assistant'), false);
  assert.equal(run._isAutoUserText('Example marker [SDS:AUTO_MCP_RESULT]', 'assistant'), false);
  assert.equal(run._isAutoUserText('[SDS:AUTO_MCP_RESULT]{"content":"ok"}[/SDS:AUTO_MCP_RESULT]', 'assistant'), false);
  assert.equal(run._isAutoUserText('<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox\n' +
    '[SDS:AUTO_MCP_RESULT]\n{"content":"ok"}\n[/SDS:AUTO_MCP_RESULT]\n</SuperDeepSeek>', 'assistant'), true);
  assert.equal(run._isAutoUserText('<BetterDeepSeek>\n[BDS:AUTO] MCP Result for run @ sandbox\n' +
    '[BDS:AUTO_MCP_RESULT]\n{"content":"ok"}\n[/BDS:AUTO_MCP_RESULT]\n</BetterDeepSeek>', 'assistant'), true);
});

test('filename fallback applies only to user messages, not assistant prose', () => {
  const { R: run } = load();
  assert.deepEqual(plain(run._classifyMessage('assistant', 'The full output is in mcp_results_run.txt.', 0, false)),
    { role: 'assistant', auto: false, calls: 0 });
  assert.deepEqual(plain(run._classifyMessage('user', 'mcp_results_run.txt', 0, false)),
    { role: 'user', auto: true, calls: 0 });
  const result = '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox\n' +
    '[SDS:AUTO_MCP_RESULT]\n{"content":"ok"}\n[/SDS:AUTO_MCP_RESULT]\n</SuperDeepSeek>';
  assert.deepEqual(plain(run._classifyMessage('assistant', result, 0, false)),
    { role: 'user', auto: true, calls: 0 });
});

test('plain chats are left alone', () => {
  const { R: run } = load();
  assert.deepEqual(plain(run._groupRuns([U, A(0), U, A(0)])), []);
  assert.deepEqual(plain(run._groupRuns([])), []);
  assert.deepEqual(plain(run._groupRuns([U])), []);
});

test('an agent nudge and a run whose start scrolled out of the list', () => {
  const { R: run } = load();
  let g = plain(run._groupRuns([U, A(0), R, A(1), R, A(0)]));
  assert.deepEqual([g[0].host, g[0].final, g[0].hidden], [1, 5, [2, 3, 4]]);
  g = plain(run._groupRuns([R, A(1), R, A(0), U, A(0)]));
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].user, g[0].host, g[0].final, g[0].hidden, g[0].last], [-1, 1, 3, [0, 2], false]);
});

test('two runs in one chat: only the newest is "last"', () => {
  const { R: run } = load();
  const g = plain(run._groupRuns([U, A(1), R, A(0), U, A(0), U, A(1), R, A(0)]));
  assert.deepEqual(g.map((x) => [x.user, x.host, x.final, x.last]), [[0, 1, 3, false], [6, 7, 9, true]]);
});

const res = (kind, o) => `[SDS:AUTO_MCP_${kind}]\n${JSON.stringify(o)}\n[/SDS:AUTO_MCP_${kind}]`;
const autoMsg = (...blocks) => '<SuperDeepSeek>\n' + blocks.join('\n\n') + '\n</SuperDeepSeek>';

test('history: calls, results, errors and notes of a run are rebuilt', () => {
  const { win, R: run } = load();
  const api = { messageText: win.__sdAgent.messageText, parseTags: win.__sdAgent._parseTags, tagArgs: win.__sdAgent._tagArgs };
  const msgs = [
    { message_id: 1, parent_id: null, role: 'USER', content: 'SYSTEM PROMPT\n\nbuild a tiny app' },
    { message_id: 2, parent_id: 1, role: 'ASSISTANT', fragments: [{ type: 'THINK', content: 'hmm' }, { type: 'RESPONSE', content:
      'Creating the files.\n<SDS:AUTO:MCP url="sandbox" tool="write_file">{"path":"a.py","content":"print(1)\\n"}</SDS:AUTO:MCP>\n<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"python3 a.py"}</SDS:AUTO:MCP>' }] },
    { message_id: 3, parent_id: 2, role: 'USER', content: autoMsg(
      res('RESULT', { serverName: 'sandbox://linux', toolName: 'write_file', call: 'a.py (9 chars)', content: 'Wrote a.py' }),
      res('ERROR', { serverName: 'sandbox://linux', toolName: 'run', call: 'python3 a.py', error: 'exit 1' })) },
    { message_id: 4, parent_id: 3, role: 'ASSISTANT', content: 'Fixing.\n<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"python3 a.py"}</SDS:AUTO:MCP>' },
    { message_id: 5, parent_id: 4, role: 'USER', content: autoMsg(res('RESULT', { serverName: 'sandbox://linux', toolName: 'run', call: 'python3 a.py', content: '1' })) },
    { message_id: 6, parent_id: 5, role: 'ASSISTANT', content: 'Done: a.py prints 1.' },
    { message_id: 7, parent_id: 6, role: 'USER', content: 'thanks' },
    { message_id: 8, parent_id: 7, role: 'ASSISTANT', content: 'You are welcome.' },
  ];
  const h = plain(run._historyRuns(msgs, api));
  assert.equal(h.length, 1);
  assert.match(h[0].userText, /build a tiny app/);
  assert.equal(h[0].turns.length, 3);
  assert.equal(h[0].turns[0].note, 'Creating the files.');
  assert.deepEqual(h[0].turns[0].calls.map((c) => [c.tool, c.result.error, c.result.content]),
    [['write_file', false, 'Wrote a.py'], ['run', true, 'exit 1']]);
  assert.deepEqual(h[0].turns[0].calls[1].args, { command: 'python3 a.py' });
  assert.equal(h[0].turns[2].note, 'Done: a.py prints 1.');
  assert.equal(h[0].turns[2].calls.length, 0);

  // Timeline: notes between steps, not the final answer (it is in the chat).
  const tl = plain(run._timeline({ steps: [] }, h[0]));
  assert.deepEqual(tl.map((x) => (x.note ? 'note:' + x.note : x.step.tool + ':' + x.step.ok)),
    ['note:Creating the files.', 'write_file:true', 'run:false', 'note:Fixing.', 'run:true']);
  assert.equal(tl[1].step.call, 'a.py (9 chars)');
  assert.match(tl[2].step.input, /"command": "python3 a.py"/);
});

test('history follows the current branch after a regeneration', () => {
  const { R: run } = load();
  const msgs = [
    { message_id: 1, parent_id: null, role: 'USER', content: 'q' },
    { message_id: 2, parent_id: 1, role: 'ASSISTANT', content: 'old answer' },
    { message_id: 3, parent_id: 1, role: 'ASSISTANT', content: 'new answer' },
  ];
  assert.deepEqual(plain(run._branch(msgs)).map((m) => m.message_id), [1, 3]);
  assert.deepEqual(plain(run._branch([{ role: 'USER' }, { role: 'ASSISTANT' }])).length, 2);
});

test('the rendered run is matched to its history by text, else by position', () => {
  const { R: run } = load();
  const h = [{ userText: 'SYS\n\nfirst task please' }, { userText: 'second task' }, { userText: 'third task' }];
  assert.equal(run._matchRun(h, 'first   task please', 0).userText, h[0].userText);
  assert.equal(run._matchRun(h, '', 1).userText, 'second task');
  assert.equal(run._matchRun(h, 'unknown text', 0).userText, 'third task');
  assert.equal(run._matchRun(h, '', 5), null);
});

test('live steps carry timings and full output; extra live steps follow the history', () => {
  const { R: run } = load();
  const hist = { turns: [{ note: '', calls: [{ tool: 'run', server: 'sandbox://linux', args: { command: 'ls' }, result: { error: false, content: 'a…[cut]…z' } }] }] };
  const steps = [
    { tool: 'run', server: 'sandbox://linux', call: 'ls', t0: 1000, t1: 2500, ok: true, output: 'a b c … z (full)', saved: '/tmp/sd-out/x-run.txt' },
    { tool: 'status', server: 'sandbox://linux', call: '', t0: 3000, t1: 0, ok: null, output: '' },
  ];
  const tl = plain(run._timeline({ steps }, hist));
  assert.equal(tl.length, 2);
  assert.equal(tl[0].step.ms, 1500);
  assert.equal(tl[0].step.output, 'a b c … z (full)');
  assert.equal(tl[0].step.saved, '/tmp/sd-out/x-run.txt');
  assert.equal(tl[1].step.tool, 'status');
  assert.equal(tl[1].step.ok, null);
  // No history at all: the live steps alone.
  assert.equal(plain(run._timeline({ steps }, null)).length, 2);
});

test('engine events build the live run', () => {
  const { win, R: run } = load();
  win.__sdRunEvent({ phase: 'start', id: 1, server: 'sandbox://linux', tool: 'run', call: 'npm test', args: { command: 'npm test' }, at: 100 });
  let l = plain(run._live());
  assert.equal(l.steps.length, 1);
  assert.equal(l.steps[0].ok, null);
  win.__sdRunEvent({ phase: 'end', id: 1, ok: false, output: 'x'.repeat(30000), at: 900 });
  win.__sdRunEvent({ phase: 'end', id: 99, ok: true, at: 950 });   // unknown id: ignored
  l = plain(run._live());
  assert.equal(l.steps[0].ok, false);
  assert.equal(l.steps[0].t1, 900);
  assert.ok(l.steps[0].output.length < 20100);
  assert.match(l.steps[0].output, /more characters\]$/);
  win.__sdRunEvent(null);
  win.__sdRunEvent({ phase: 'weird' });
  assert.equal(plain(run._live()).steps.length, 1);
});

test('card: running shows the current step, the last 3 and Stop; done is one line', () => {
  const { R: run } = load();
  const now = Date.now();
  const s = (tool, call, ok, t0, t1) => ({ tool, call, ok, t0, t1 });
  const running = plain(run._cardHtml({
    running: true, stopped: false, count: 5, failed: 1, t0: now - 42000, t1: 0,
    steps: [s('write_file', 'a.py', true, 1, 2), s('run', 'a', false, 2, 3), s('run', 'b', true, 3, 4), s('run', 'c', true, 4, 5), s('run', '<img src=x onerror=alert(1)>', null, 5, 0)],
  }));
  assert.equal(running.state, 'running');
  assert.match(running.html, /Working/);
  assert.match(running.html, /5 steps · 4\ds · 1 failed/);
  assert.match(running.html, /class="sd-run-stop"/);
  assert.match(running.html, /sd-run-now"><b>run<\/b><span>&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal((running.html.match(/<li>/g) || []).length, 3);
  assert.ok(!running.html.includes('<img'));

  const done = plain(run._cardHtml({ running: false, stopped: false, count: 8, failed: 0, t0: 1000, t1: 73000, steps: [] }));
  assert.equal(done.state, 'done');
  assert.match(done.html, /Worked for 1m 12s/);
  assert.match(done.html, /8 steps/);
  assert.ok(!done.html.includes('sd-run-stop'));
  assert.ok(!done.html.includes('<li>'));

  const stopped = plain(run._cardHtml({ running: false, stopped: true, count: 1, failed: 0, t0: 0, t1: 0, steps: [] }));
  assert.match(stopped.html, /Stopped/);
  assert.match(stopped.html, /1 step</);
});

test('card text follows the app language', () => {
  const { R: run } = load({ lang: 'bn' });
  const h = plain(run._cardHtml({ running: false, stopped: false, count: 12, failed: 0, t0: 1000, t1: 6000, steps: [] })).html;
  assert.match(h, /কাজ করেছে ৫সে/);
  assert.match(h, /১২টি ধাপ/);
});

test('helpers: results, prose, call summaries, durations', () => {
  const { R: run } = load();
  const r = plain(run._parseResults(autoMsg(
    res('RESULT', { serverName: 's', toolName: 'run', call: 'ls', content: 'x' }),
    res('ERROR', { serverName: 's', toolName: 'read_file', args: { path: 'p' }, error: 'nope' }),
    '[SDS:AUTO_MCP_RESULT]\nnot json\n[/SDS:AUTO_MCP_RESULT]')));
  assert.deepEqual(r.map((x) => [x.error, x.toolName, x.content]), [[false, 'run', 'x'], [true, 'read_file', 'nope'], [false, '', '']]);
  assert.deepEqual(r[1].args, { path: 'p' });
  assert.equal(run._stripTags('Plan.\n<SDS:AUTO:MCP url="sandbox" tool="run">{"command":"ls"}</SDS:AUTO:MCP>\n<SDS:AUTO:MCP url="sandbox" tool="status"/>'), 'Plan.');
  assert.equal(run._stripTags('Half <SDS:AUTO:MCP url="sandbox" tool="run">{"comm'), 'Half');
  assert.equal(run._callSummary('write_file', { path: 'a', content: 'abc' }), 'a (3 chars)');
  assert.equal(run._callSummary('edit_file', { path: 'a', old_text: 'x' }), 'a (edit)');
  assert.equal(run._callSummary('status', {}), '');
  assert.equal(run._callSummary('x', { call: 'given' }), 'given');
  assert.equal(run._fmtDur(50), '0.1s');
  assert.equal(run._fmtDur(12400), '12s');
  assert.equal(run._fmtDur(3725000), '1h 2m');
  assert.equal(run._fmtDur(NaN), '');
});
