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

test('extract_job passes the plugin schema and an older desktop rejecting it reads as too old', async () => {
  const accepted = await harness({ respond: request => reply(request, { status: 'ok', text: '{}' }) });
  assert.deepEqual(await accepted.ai.complete({ purpose: 'extract_job', system: 's', user: '[]' }), { ok: true, text: '{}' });
  assert.equal(accepted.sent[0].request.payload.purpose, 'extract_job');

  // A 0.4.1 desktop only knows fill and plan, so its schema rejects the payload.
  const old = await harness({ respond: request => failure(request, 'invalid_payload') });
  assert.deepEqual(await old.ai.complete({ purpose: 'extract_job', system: 's', user: '[]' }), { ok: false, reason: 'incompatible' });
  // fill and plan predate every v2 desktop; a rejection there is not about the version.
  assert.deepEqual(await old.ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: false, reason: 'unavailable' });

  // A purpose this plugin's own schema does not know never leaves the plugin.
  const local = await harness({ respond: () => { throw new Error('sent'); } });
  assert.deepEqual(await local.ai.complete({ purpose: 'debug', system: 's', user: 'u' }), { ok: false, reason: 'unavailable' });
  assert.equal(local.sent.length, 0);
});

test('a tier is sent only when asked for, and the tier the desktop used comes back', async () => {
  const plain = await harness({ respond: request => reply(request, { status: 'ok', text: '[]' }) });
  assert.deepEqual(await plain.ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: true, text: '[]' });
  // Every desktop up to 0.4.2 rejects an unknown key, so a plain fill must not carry one.
  assert.equal('tier' in plain.sent[0].request.payload, false);

  const strong = await harness({ respond: request => reply(request, { status: 'ok', text: '[]', tier: 'default' }) });
  assert.deepEqual(await strong.ai.complete({ purpose: 'fill', tier: 'strong', system: 's', user: 'u' }), { ok: true, text: '[]', tier: 'default' });
  assert.equal(strong.sent[0].request.payload.tier, 'strong');

  const analyze = await harness({ respond: request => reply(request, { status: 'failed', reason: 'timeout', tier: 'strong' }) });
  assert.deepEqual(await analyze.ai.complete({ purpose: 'analyze', system: 's', user: 'u' }), { ok: false, reason: 'timeout', tier: 'strong' });
});

test('a desktop older than tiers reads as too old for analyze or a tier, not for a plain fill', async () => {
  const old = await harness({ respond: request => failure(request, 'invalid_payload') });
  assert.deepEqual(await old.ai.complete({ purpose: 'analyze', system: 's', user: 'u' }), { ok: false, reason: 'incompatible' });
  assert.deepEqual(await old.ai.complete({ purpose: 'fill', tier: 'strong', system: 's', user: 'u' }), { ok: false, reason: 'incompatible' });
  assert.deepEqual(await old.ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: false, reason: 'unavailable' });

  // What an old host actually sends: its validator refuses the envelope before any version
  // can be trusted, so the error comes back as protocolVersion 1 (nm.rs response_for_with).
  const oldHost = await harness({ respond: request => ({ response: { protocolVersion: 1, correlationId: request.messageId, ok: false, payload: {},
    error: { code: 'invalid_payload', retryable: false, message: 'synthetic' } } }) });
  assert.deepEqual(await oldHost.ai.complete({ purpose: 'analyze', system: 's', user: 'u' }), { ok: false, reason: 'incompatible' });
  assert.deepEqual(await oldHost.ai.complete({ purpose: 'fill', tier: 'strong', system: 's', user: 'u' }), { ok: false, reason: 'incompatible' });

  // A tier this plugin does not know never leaves the plugin.
  const local = await harness({ respond: () => { throw new Error('sent'); } });
  assert.deepEqual(await local.ai.complete({ purpose: 'fill', tier: 'turbo', system: 's', user: 'u' }), { ok: false, reason: 'unavailable' });
  assert.equal(local.sent.length, 0);

  // A response that carries a tier the request never asked for is refused, not trusted.
  const stray = await harness({ respond: request => reply(request, { status: 'ok', text: '[]', tier: 'strong' }) });
  assert.deepEqual(await stray.ai.complete({ purpose: 'fill', system: 's', user: 'u' }), { ok: false, reason: 'unavailable' });
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
