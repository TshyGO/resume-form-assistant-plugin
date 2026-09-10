const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const FIELDS = {
  company: '星河科技',
  title: '后端开发',
  location: '上海',
  sourceUrl: 'https://jobs.example.com/apply',
  dedupeUrl: 'https://jobs.example.com/apply'
};

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const name of (Array.isArray(keys) ? keys : [keys])) if (name in data) out[name] = data[name];
      return out;
    },
    async set(values) { Object.assign(data, values); }
  };
}

function handshakeReply(message) {
  return {
    response: {
      protocolVersion: 1,
      correlationId: message.messageId,
      ok: true,
      payload: {
        appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 1,
        archiveId: ARCHIVE, restoreEpoch: EPOCH, capabilities: ['handshake', 'job.save']
      }
    }
  };
}

async function makeRouter({ reply = () => ({ lastError: 'Error when communicating with the native messaging host.' }), storage = fakeStorage() } = {}) {
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');
  const { createDrain } = await import('../link/drain.mjs');
  const { createRouter } = await import('../link/router.mjs');

  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date('2026-09-09T00:00:00.000Z');
  const store = createStore({ storage, uuid });
  const sent = [];
  const sendNative = async (host, message) => {
    sent.push(message);
    return reply(message);
  };
  const session = createSession({ store, sendNative, sleep: async () => {}, uuid, now });
  const intents = createIntents({ store, uuid, now });
  const outbox = createOutbox({ store, sendNative, sleep: async () => {}, uuid, now });
  const alarms = { created: [], async create(name, options) { this.created.push({ name, ...options }); }, async clear() { return true; } };
  const drain = createDrain({ session, outbox, alarms, now });
  const router = createRouter({ session, intents, outbox, drain, extensionId: 'abcdefghijklmnopabcdefghijklmnop' });
  return { router, storage, sent };
}

test('an unknown message is left for the other listeners', async () => {
  const { router } = await makeRouter();

  assert.equal(await router.handle({ type: 'ENSURE_AI_HOST' }), null);
  assert.equal(await router.handle({}), null);
  assert.equal(await router.handle(undefined), null);
});

test('saving while the desktop is closed answers pending, never saved', async () => {
  const { router } = await makeRouter({
    storage: fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } })
  });

  const result = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  assert.equal(result.status, 'queued');
  assert.equal(result.mode, 'unavailable');
  // The one thing this reply must never be able to say.
  assert.equal(JSON.stringify(result).includes('saved'), false);
});

test('saving with no desktop ever paired reports the pairing instructions with the extension id', async () => {
  const { router, storage } = await makeRouter();

  const result = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  assert.equal(result.status, 'not_queued');
  assert.equal(result.mode, 'never_paired');
  assert.equal(result.extensionId, 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal('desktopSaveIntents' in storage.data, false);
});

test('an unpaired but installed desktop is reported as unpaired, with the id to paste', async () => {
  const { router } = await makeRouter({
    reply: message => ({
      response: {
        protocolVersion: 1, correlationId: message.messageId, ok: false,
        error: { code: 'identity_not_allowed', retryable: false, message: 'origin is not paired' },
        payload: {}
      }
    })
  });

  const result = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  assert.equal(result.mode, 'not_paired');
  assert.equal(result.extensionId, 'abcdefghijklmnopabcdefghijklmnop');
});

test('the queue can be listed and one entry removed', async () => {
  const { router } = await makeRouter({
    storage: fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } })
  });
  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  const listed = await router.handle({ type: 'DESKTOP_LIST_QUEUE' });
  assert.equal(listed.intents.length, 1);

  await router.handle({ type: 'DESKTOP_REMOVE_INTENT', intentId: saved.intent.intentId });
  assert.equal((await router.handle({ type: 'DESKTOP_LIST_QUEUE' })).intents.length, 0);
});

test('a duplicate save is reported as such rather than silently ignored', async () => {
  const { router } = await makeRouter({
    storage: fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } })
  });

  await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });
  const again = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  assert.equal(again.status, 'duplicate');
  assert.equal(again.recent, true);
});

test('a probe reports the mode without saving anything', async () => {
  const { router, storage } = await makeRouter({ reply: handshakeReply });

  const result = await router.handle({ type: 'DESKTOP_PROBE' });

  assert.equal(result.mode, 'ready');
  assert.equal('desktopSaveIntents' in storage.data, false);
});

// --- binding ---------------------------------------------------------------

const APPLICATION = '77777777-7777-4777-8777-777777777777';

function desktopThatAnswers(message) {
  if (message.messageType === 'handshake') return handshakeReply(message);
  if (message.messageType === 'application.queryCandidates') {
    return {
      response: {
        protocolVersion: 1, correlationId: message.messageId, ok: true,
        payload: {
          exact: [{ applicationId: APPLICATION, company: '星河科技', title: '后端开发', stage: 'saved' }],
          sameCompany: []
        }
      }
    };
  }
  return {
    response: { protocolVersion: 1, correlationId: message.messageId, ok: true, resultId: APPLICATION, payload: {} }
  };
}

test('candidates are fetched for a queued intent', async () => {
  const { router } = await makeRouter({ reply: desktopThatAnswers });
  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  const result = await router.handle({ type: 'DESKTOP_CANDIDATES', intentId: saved.intent.intentId });

  assert.equal(result.status, 'ok');
  assert.equal(result.exact[0].applicationId, APPLICATION);
});

test('binding to a new application reports the desktop save', async () => {
  const { router, storage } = await makeRouter({ reply: desktopThatAnswers });
  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  const result = await router.handle({ type: 'DESKTOP_BIND', intentId: saved.intent.intentId });

  assert.equal(result.status, 'saved');
  assert.equal(result.applicationId, APPLICATION);
  assert.deepEqual(storage.data.desktopSaveIntents, []);
});

test('a bind while the desktop went away stays pending', async () => {
  const { router, storage } = await makeRouter({
    reply: message => message.messageType === 'handshake'
      ? handshakeReply(message)
      : {
          response: {
            protocolVersion: 1, correlationId: message.messageId, ok: false,
            error: { code: 'unavailable', retryable: true, message: 'starting' }, payload: {}
          }
        }
  });
  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });

  const result = await router.handle({ type: 'DESKTOP_BIND', intentId: saved.intent.intentId });

  assert.equal(result.status, 'pending');
  assert.equal(storage.data.desktopSaveIntents.length, 1);
  assert.equal(storage.data.desktopOutbox.length, 1);
});

test('the queue listing includes bound messages, not only intents', async () => {
  const { router } = await makeRouter({
    reply: message => message.messageType === 'handshake'
      ? handshakeReply(message)
      : {
          response: {
            protocolVersion: 1, correlationId: message.messageId, ok: false,
            error: { code: 'unavailable', retryable: true, message: 'starting' }, payload: {}
          }
        }
  });
  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });
  await router.handle({ type: 'DESKTOP_BIND', intentId: saved.intent.intentId });

  const listed = await router.handle({ type: 'DESKTOP_LIST_QUEUE' });

  assert.equal(listed.outbox.length, 1);
  assert.equal(listed.outbox[0].messageType, 'job.save');
});

test('a stalled write can be retried and cancelled from the sidebar', async () => {
  const { router, storage } = await makeRouter({
    reply: message => message.messageType === 'handshake'
      ? handshakeReply(message)
      : {
          response: {
            protocolVersion: 1, correlationId: message.messageId, ok: false,
            error: { code: 'unavailable', retryable: true, message: 'starting' }, payload: {}
          }
        }
  });
  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: FIELDS });
  await router.handle({ type: 'DESKTOP_BIND', intentId: saved.intent.intentId });
  const { messageId } = storage.data.desktopOutbox[0];

  const retried = await router.handle({ type: 'DESKTOP_RETRY', messageId });
  assert.equal(retried.status, 'pending');

  await router.handle({ type: 'DESKTOP_CANCEL', messageId });
  assert.deepEqual(storage.data.desktopOutbox, []);
});
