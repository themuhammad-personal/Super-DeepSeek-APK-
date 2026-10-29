// T4 (2.71.0): automatic messages (tool results, agent nudges) are not user
// turns: they do not advance the injection counter and get no injected
// context (system prompt, memories, project RAG, skills, GenUI hints).
// Run: npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, '../../main/bds-assets/bds/injected.js'), 'utf8');
const a = SRC.indexOf('function I(e,t){');
const b = SRC.indexOf('function ', a + 20);
assert.ok(a > 0 && b > a, 'function I found');
const FN_I = SRC.slice(a, b);

function setup(frequency = 'always', interval = 3) {
  const injectCalls = [];
  const ctx = {
    console: { warn() {}, log() {} }, JSON, String, Number, Array, Object, CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail; } },
    window: { dispatchEvent() {} },
    ee: () => null, te: () => 'chat1', N: () => null, A: () => '', ne: () => null, C() {}, Te: () => null,
    B: (x) => x,
    O: (g, r, t, l) => { injectCalls.push({ g, l, count: t.sessionUserMsgCounts[r] }); return l ? 'SYS' : 'CTX'; },
  };
  vm.createContext(ctx);
  vm.runInContext(FN_I + ';this.I=I;', ctx);
  const state = { config: { systemPromptInjectionFrequency: frequency, systemPromptInjectionInterval: interval } };
  let id = 0;
  const send = (prompt) => {
    id++;
    const payload = { prompt, message_id: id, parent_message_id: id === 1 ? null : id - 1 };
    return ctx.I(payload, state).payload.prompt;
  };
  return { send, injectCalls, state };
}

const AUTO = '<SuperDeepSeek>\n[SDS:AUTO] MCP Result for run @ sandbox://linux\n[SDS:AUTO_MCP_RESULT]\n{"content":"docx chart memory"}\n[/SDS:AUTO_MCP_RESULT]\n</SuperDeepSeek>';

test('a tool result gets no injected context, even with "always"', () => {
  const { send, injectCalls } = setup('always');
  assert.equal(send('build me an app'), 'SYS\n\nbuild me an app');
  assert.equal(send(AUTO), AUTO);
  assert.equal(send('[SDS:AUTO] Agent continue'), '[SDS:AUTO] Agent continue');
  assert.equal(send('[BDS:AUTO_MCP_RESULT] old prefix'), '[BDS:AUTO_MCP_RESULT] old prefix');
  assert.equal(send('thanks, now add tests'), 'SYS\n\nthanks, now add tests');
  assert.equal(injectCalls.length, 2);
});

test('tool results do not advance the "every N messages" counter', () => {
  const { send, state } = setup('every_x', 2);
  assert.equal(send('one'), 'SYS\n\none');          // first message
  for (let i = 0; i < 5; i++) send(AUTO);
  assert.equal(state.sessionUserMsgCounts.chat1, 1);
  assert.equal(send('two'), 'CTX\n\ntwo');          // user message 2: (2-1)%2 != 0
  send(AUTO);
  assert.equal(send('three'), 'SYS\n\nthree');      // user message 3: (3-1)%2 == 0
  assert.equal(state.sessionUserMsgCounts.chat1, 3);
});

test('"first" still injects only into the first message of a chat', () => {
  const { send } = setup('first');
  assert.equal(send('hello'), 'SYS\n\nhello');
  assert.equal(send(AUTO), AUTO);
  assert.equal(send('next'), 'CTX\n\nnext');
});
