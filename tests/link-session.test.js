const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const name of (Array.isArray(keys) ? keys : [keys])) {
        if (name in data) out[name] = data[name];
      }
      return out;
    },
    async set(values) { Object.assign(data, values); }
  };
}

function handshakeReply(over = {}) {
  return message => ({
    response: {
      protocolVersion: 1,
      correlationId: message.messageId,
      ok: true,
      payload: {
        appVersion: '0.1.0',
        minProtocolVersion: 1,
        maxProtocolVersion: 1,
        archiveId: ARCHIVE,
        restoreEpoch: EPOCH,
        capabilities: ['health', 'handshake', 'job.save', 'application.queryCandidates', 'outbox.reconcile'],
        ...over
      }
    }
  });
}

async function makeSession({ reply, storage = fakeStorage() }) {
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const sent = [];
  const store = createStore({ storage, uuid: () => '11111111-1111-4111-8111-111111111111' });
  const session = createSession({
    store,
    sendNative: async (hostName, message) => {
      sent.push(message);
      return typeof reply === 'function' ? reply(message) : reply;
    },
    sleep: async () => {},
    uuid: () => '33333333-3333-4333-8333-333333333333',
    now: () => new Date('2026-09-09T00:00:00.000Z')
  });
  return { session, sent, storage, store };
}

test('a successful handshake reports ready and hands back the current identity', async () => {
  const { session, storage } = await makeSession({ reply: handshakeReply() });

  const probe = await session.probe();

  assert.equal(probe.mode, 'ready');
  assert.deepEqual(probe.identity, { archiveId: ARCHIVE, restoreEpoch: EPOCH });
  assert.equal(storage.data.desktopPairing.archiveId, ARCHIVE);
});

test('the handshake itself carries no archive identity', async () => {
  const { session, sent } = await makeSession({ reply: handshakeReply() });

  await session.probe();

  assert.equal('archiveId' in sent[0], false);
  assert.equal('restoreEpoch' in sent[0], false);
});

test('a desktop speaking only a future protocol is incompatible and is not remembered as paired', async () => {
  const { session, storage } = await makeSession({
    reply: handshakeReply({ minProtocolVersion: 2, maxProtocolVersion: 3 })
  });

  const probe = await session.probe();

  assert.equal(probe.mode, 'incompatible');
  // Recording pairing here would let the queue claim the desktop is usable and start
  // promoting intents into bound messages it can never send.
  assert.equal('desktopPairing' in storage.data, false);
});

test('a handshake that gets past transport validation with no shared version is still incompatible', async () => {
  // The D05 validator rejects a non-overlapping range before probe() sees it, so this branch
  // is only reachable if the validator and session.mjs ever disagree. It must still answer
  // `incompatible` rather than throw.
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const storage = fakeStorage();
  const session = createSession({
    store: createStore({ storage, uuid: () => '11111111-1111-4111-8111-111111111111' }),
    send: async message => ({
      status: 'ok',
      response: handshakeReply({ minProtocolVersion: 2, maxProtocolVersion: 3 })(message).response,
      resultId: null
    }),
    uuid: () => '33333333-3333-4333-8333-333333333333',
    now: () => new Date('2026-09-09T00:00:00.000Z')
  });

  assert.deepEqual(await session.probe(), { mode: 'incompatible', identity: null });
  assert.equal('desktopPairing' in storage.data, false);
});

test('a desktop that rejects the handshake outright is incompatible', async () => {
  const { session } = await makeSession({
    reply: message => ({
      response: {
        protocolVersion: 1,
        correlationId: message.messageId,
        ok: false,
        error: { code: 'protocol_incompatible', retryable: false, message: 'no shared protocol version' },
        payload: {}
      }
    })
  });

  assert.equal((await session.probe()).mode, 'incompatible');
});

test('no host registration reports not installed', async () => {
  const { session } = await makeSession({ reply: { lastError: 'Specified native messaging host not found.' } });

  assert.equal((await session.probe()).mode, 'not_installed');
});

test('an unpaired extension is told to pair, not to install', async () => {
  const { session } = await makeSession({
    reply: message => ({
      response: {
        protocolVersion: 1,
        correlationId: message.messageId,
        ok: false,
        error: { code: 'identity_not_allowed', retryable: false, message: 'origin is not paired' },
        payload: {}
      }
    })
  });

  const probe = await session.probe();

  assert.equal(probe.mode, 'not_paired');
  assert.notEqual(probe.mode, 'not_installed');
});

test('a previously paired profile whose desktop is closed reports unavailable', async () => {
  const { session } = await makeSession({
    storage: fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } }),
    reply: message => ({
      response: {
        protocolVersion: 1,
        correlationId: message.messageId,
        ok: false,
        error: { code: 'unavailable', retryable: true, message: 'the application is starting' },
        payload: {}
      }
    })
  });

  assert.equal((await session.probe()).mode, 'unavailable');
});

test('a profile that never paired stays never_paired even when the port merely fails', async () => {
  // The difference matters: `unavailable` may persist a SaveIntent, `never_paired` may not.
  const { session } = await makeSession({
    reply: { lastError: 'Error when communicating with the native messaging host.' }
  });

  assert.equal((await session.probe()).mode, 'never_paired');
});

test('a stored pairing is not accepted as an identity for writes', async () => {
  const { session } = await makeSession({
    storage: fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } }),
    reply: { lastError: 'Error when communicating with the native messaging host.' }
  });

  const probe = await session.probe();

  assert.equal(probe.mode, 'unavailable');
  assert.equal(probe.identity, null, 'only a fresh handshake yields an identity');
});

test('a profile that has paired before is never told to install the desktop', async () => {
  // §5.2.3 lists "host failed to start" under *previously paired, desktop unavailable*, which
  // keeps the intent — and §9 forbids telling a user who has paired that nothing is
  // installed. A broken or stale registration reads as "not installed" from the browser, and
  // taking that at face value throws away fields the user just confirmed.
  const { session } = await makeSession({
    storage: fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } }),
    reply: { lastError: 'Specified native messaging host not found.' }
  });

  const probe = await session.probe();

  assert.equal(probe.mode, 'unavailable');
  assert.notEqual(probe.mode, 'not_installed');
});

test('a profile that never paired is still told the desktop is missing', async () => {
  const { session } = await makeSession({ reply: { lastError: 'Specified native messaging host not found.' } });

  assert.equal((await session.probe()).mode, 'not_installed');
});
