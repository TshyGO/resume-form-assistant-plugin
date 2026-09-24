const test = require('node:test');
const assert = require('node:assert/strict');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const IDENTITY = { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

function fakePortApi() {
  const events = { message: null, disconnect: null };
  const port = {
    posted: [], disconnects: 0,
    onMessage: { addListener(fn) { events.message = fn; } },
    onDisconnect: { addListener(fn) { events.disconnect = fn; } },
    postMessage(message) { this.posted.push(message); },
    disconnect() { this.disconnects += 1; }
  };
  const runtime = { lastError: null, connectNative(host) { runtime.host = host; return port; } };
  return { runtime, port, events };
}

test('one native port returns one response and disconnects', async () => {
  const { nativePort } = await import('../link/chrome.mjs');
  const api = fakePortApi();
  const pending = nativePort(api)('com.resumepro.desktop', { messageType: 'ai.complete' });
  assert.equal(api.runtime.host, 'com.resumepro.desktop');
  assert.equal(api.port.posted.length, 1);
  api.events.message({ ok: true });
  assert.deepEqual(await pending, { response: { ok: true } });
  assert.equal(api.port.disconnects, 1);
});

test('abort closes the native port and ignores a late response', async () => {
  const { nativePort } = await import('../link/chrome.mjs');
  const api = fakePortApi();
  const controller = new AbortController();
  const pending = nativePort(api)('com.resumepro.desktop', {}, { signal: controller.signal });
  controller.abort();
  api.events.message({ ok: true });
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(api.port.disconnects, 1);
});

test('a missing host on disconnect keeps the browser error', async () => {
  const { nativePort } = await import('../link/chrome.mjs');
  const api = fakePortApi();
  const pending = nativePort(api)('com.resumepro.desktop', {});
  api.runtime.lastError = { message: 'Specified native messaging host not found.' };
  api.events.disconnect();
  assert.deepEqual(await pending, { lastError: 'Specified native messaging host not found.' });
});

async function harness({ mode = 'ready', respond } = {}) {
  const { createAi } = await import('../link/ai.mjs');
  const sent = [];
  const ai = createAi({
    session: { probe: async () => ({ mode, identity: mode === 'ready' ? IDENTITY : null }) },
    store: { clientInstanceId: async () => CLIENT },
    port: async (_host, request, options) => {
      sent.push({ request, options });
      return respond(request);
    },
    uuid: () => MESSAGE,
    now: () => new Date('2026-09-24T00:00:00.000Z')
  });
  return { ai, sent };
}

const reply = (request, payload) => ({ response: { protocolVersion: 2, correlationId: request.messageId, ok: true, payload } });
const failure = (request, code) => ({ response: { protocolVersion: 2, correlationId: request.messageId, ok: false, error: { code, retryable: false, message: 'synthetic' }, payload: {} } });

test('ai.complete sends v2 without archive identity and returns text', async () => {
  const { ai, sent } = await harness({ respond: request => reply(request, { status: 'ok', text: 'answer' }) });
  assert.deepEqual(await ai.complete({ purpose: 'fill', system: 'system', user: 'user' }), { ok: true, text: 'answer' });
  assert.equal(sent[0].request.protocolVersion, 2);
  assert.equal(sent[0].request.messageType, 'ai.complete');
  assert.equal('archiveId' in sent[0].request, false);
});

test('provider failures retain their structured reason, status and safe host', async () => {
  const { ai } = await harness({ respond: request => reply(request, { status: 'failed', reason: 'auth', httpStatus: 401, host: 'api.example.com' }) });
  assert.deepEqual(await ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: false, reason: 'auth', httpStatus: 401, host: 'api.example.com' });
});

test('protocol errors and missing host map to stable UI reasons', async () => {
  for (const [code, expected] of [['secret_forbidden', 'secret_in_prompt'], ['payload_too_large', 'input_too_large'], ['protocol_incompatible', 'incompatible']]) {
    const { ai } = await harness({ respond: request => failure(request, code) });
    assert.deepEqual(await ai.complete({ purpose: 'plan', system: 's', user: 'u' }), { ok: false, reason: expected });
  }
  const { ai } = await harness({ respond: () => ({ lastError: 'Specified native messaging host not found.' }) });
  assert.deepEqual(await ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: false, reason: 'not_installed' });
});

test('abort returns cancelled and disconnected desktop returns unavailable', async () => {
  const controller = new AbortController();
  const { ai } = await harness({ respond: () => { controller.abort(); return { cancelled: true }; } });
  assert.deepEqual(await ai.complete({ purpose: 'fill', system: 's', user: 'u', signal: controller.signal }), { ok: false, reason: 'cancelled' });
  const other = await harness({ respond: () => ({ lastError: 'Port closed.' }) });
  assert.deepEqual(await other.ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: false, reason: 'unavailable' });
});

test('a desktop mode other than ready sends no AI request', async () => {
  const { ai, sent } = await harness({ mode: 'not_paired', respond: () => { throw new Error('sent'); } });
  assert.deepEqual(await ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: false, reason: 'not_paired' });
  assert.equal(sent.length, 0);
});
