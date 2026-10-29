// Reproduce the async asset-load race using the exact probe and claim builder
// embedded in DeepSeekPageSurface.kt. The claim script must fail closed if the
// live page changes after the initial "chat" classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const kotlinPath = path.resolve(here, '../../main/java/com/superdeepseek/app/DeepSeekPageSurface.kt');
const kotlin = fs.readFileSync(kotlinPath, 'utf8');

const probeMatch = kotlin.match(/internal val DEEPSEEK_PAGE_SURFACE_PROBE_JS = """([\s\S]*?)"""\.trimIndent\(\)/);
assert.ok(probeMatch, 'production page-surface probe is present');

function trimIndent(raw) {
  const lines = raw.split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const indents = lines.filter(line => line.trim()).map(line => line.match(/^\s*/)[0].length);
  const margin = Math.min(...indents);
  return lines.map(line => line.slice(Math.min(margin, line.match(/^\s*/)[0].length))).join('\n');
}

const probeScript = trimIndent(probeMatch[1]);
const claimMatch = kotlin.match(/internal fun buildDeepSeekEngineClaimScript\(documentToken: String\): String =([\s\S]*?)\n\ninternal const val DEEPSEEK_PAGE_POLL_MS/);
assert.ok(claimMatch, 'production atomic claim builder is present');

function buildProductionClaimScript(documentToken) {
  const strings = [...claimMatch[1].matchAll(/"([^"]*)"/g)].map(match => match[1]);
  assert.ok(strings.length >= 5, 'claim builder keeps the expected string fragments');
  return strings
    .map(part => part
      .replace('$DEEPSEEK_PAGE_SURFACE_PROBE_JS', probeScript)
      .replace('\u0024{JSONObject.quote(documentToken)}', JSON.stringify(documentToken)))
    .join('');
}

function createPage(surface = 'chat', documentToken = '1000') {
  const state = { surface, documentToken };
  const rect = () => ({ width: 320, height: 160 });
  const node = (properties = {}) => ({
    id: '',
    className: '',
    getAttribute: () => '',
    getBoundingClientRect: rect,
    closest: () => null,
    ...properties,
  });
  const challenge = node({
    id: 'captcha-widget',
    className: 'captcha-container',
    getAttribute: name => name === 'src'
      ? 'https://newassets.hcaptcha.com/captcha/v1/hcaptcha.html'
      : '',
  });
  const composer = node({ id: 'chat-input' });
  const email = node({
    type: 'email',
    getAttribute: name => name === 'autocomplete' ? 'email' : '',
  });
  const window = {
    __sdEngineInjected: undefined,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    performance: {
      get timeOrigin() { return Number(state.documentToken); },
      get timing() { return { navigationStart: Number(state.documentToken) }; },
    },
  };
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector.startsWith('iframe[src]')) return state.surface === 'auth' ? [challenge] : [];
      if (selector.startsWith('textarea#chat-input')) return state.surface === 'chat' ? [composer] : [];
      if (selector === 'input, textarea') return state.surface === 'auth' ? [email] : [];
      return [];
    },
  };
  const sandbox = { window, document, location: { pathname: '/chat' } };
  return { state, window, sandbox };
}

test('chat-to-CAPTCHA transition during asset loading never claims or injects the engine', () => {
  const page = createPage('chat', '1000');
  const firstProbe = vm.runInNewContext(probeScript, page.sandbox);
  assert.equal(firstProbe.surface, 'chat');
  assert.equal(firstProbe.documentToken, '1000');

  // Simulate the exact race: assets are still loading, and the SPA shows CAPTCHA.
  page.state.surface = 'auth';
  const result = vm.runInNewContext(buildProductionClaimScript(firstProbe.documentToken), page.sandbox);

  assert.equal(result, 'auth');
  assert.equal(page.window.__sdEngineInjected, undefined, 'auth surface must not be marked/injected');
});

test('a full navigation invalidates the old document token, even if the new page has a composer', () => {
  const page = createPage('chat', '1000');
  const firstProbe = vm.runInNewContext(probeScript, page.sandbox);
  page.state.documentToken = '2000';

  const result = vm.runInNewContext(buildProductionClaimScript(firstProbe.documentToken), page.sandbox);
  assert.equal(result, 'stale');
  assert.equal(page.window.__sdEngineInjected, undefined, 'stale token must not claim the new document');
});

test('the current chat document is claimed once and then recognized as already injected', () => {
  const page = createPage('chat', '1000');
  const script = buildProductionClaimScript('1000');

  assert.equal(vm.runInNewContext(script, page.sandbox), 'claimed');
  assert.equal(page.window.__sdEngineInjected, true);
  assert.equal(vm.runInNewContext(script, page.sandbox), 'already');
});
