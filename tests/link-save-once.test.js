const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EPOCH_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

function fields(title, company = '星河科技') {
  return {
    company,
    title,
    location: '',
    sourceUrl: 'https://jobs.example.com/apply',
    dedupeUrl: 'https://jobs.example.com/apply'
  };
}

function handshake(message, epoch = EPOCH) {
  return {
    response: {
      protocolVersion: 1,
      correlationId: message.messageId,
      ok: true,
      payload: {
        appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 1,
        archiveId: ARCHIVE, restoreEpoch: epoch, capabilities: ['handshake', 'job.save']
      }
    }
  };
}

async function harness(answer) {
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');
  const { createDrain } = await import('../link/drain.mjs');
  const { createReconcile } = await import('../link/reconcile.mjs');
  const { createRouter } = await import('../link/router.mjs');
  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date('2026-09-09T00:00:00.000Z');
  const storage = fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } });
  const sent = [];
  const sendNative = async (_host, message) => {
    sent.push(message);
    return answer(message);
  };
  const store = createStore({ storage, uuid });
  const session = createSession({ store, sendNative, sleep: async () => {}, uuid, now });
  const intents = createIntents({ store, uuid, now });
  const outbox = createOutbox({ store, sendNative, sleep: async () => {}, uuid, now });
  const alarms = { created: [], async create() {}, async clear() { return true; } };
  const reconcile = createReconcile({ store, outbox, uuid, now, sendNative, sleep: async () => {} });
  const drain = createDrain({ session, outbox, reconcile, alarms, now });
  const router = createRouter({ session, intents, outbox, drain, reconcile, extensionId: 'abcdefghijklmnopabcdefghijklmnop' });
  return { router, drain, storage, sent };
}

function desktop() {
  const applications = [];
  let epoch = EPOCH;
  let jobDelay = null;
  return {
    applications,
    setEpoch(next) { epoch = next; },
    holdJob() {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      jobDelay = gate;
      return release;
    },
    answer(message) {
      if (message.messageType === 'handshake') return handshake(message, epoch);
      if (message.messageType === 'application.queryCandidates') {
        const exact = applications.filter(item => item.company === message.payload.company && item.title === message.payload.title);
        const sameCompany = applications.filter(item => item.company === message.payload.company && item.title !== message.payload.title);
        const view = item => ({ applicationId: item.id, company: item.company, title: item.title, stage: item.stage });
        return { response: { protocolVersion: 1, correlationId: message.messageId, ok: true, payload: { exact: exact.map(view), sameCompany: sameCompany.map(view) } } };
      }
      if (message.messageType === 'job.save') {
        const respond = () => {
          const id = message.payload.applicationId ?? `77777777-7777-4777-8777-${String(applications.length + 1).padStart(12, '0')}`;
          if (!applications.some(item => item.id === id)) {
            applications.push({ id, company: message.payload.company, title: message.payload.title, stage: 'saved' });
          }
          return { response: { protocolVersion: 1, correlationId: message.messageId, ok: true, resultId: id, payload: { resultKind: 'application' } } };
        };
        if (jobDelay) {
          const gate = jobDelay;
          jobDelay = null;
          return gate.then(respond);
        }
        return respond();
      }
      if (message.messageType === 'outbox.reconcile') {
        return {
          response: {
            protocolVersion: 1, correlationId: message.messageId, ok: true,
            payload: { items: message.payload.items.map(item => ({ ...item, status: 'not_found' })) }
          }
        };
      }
      return { response: { protocolVersion: 1, correlationId: message.messageId, ok: false, error: { code: 'unavailable', retryable: true, message: 'down' }, payload: {} } };
    }
  };
}

test('one online save persists a new saved application without a second confirmation', async () => {
  const model = desktop();
  const { router, storage, sent } = await harness(message => model.answer(message));

  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });

  assert.equal(saved.status, 'saved');
  assert.equal(saved.applicationId, model.applications[0].id);
  assert.equal(model.applications[0].stage, 'saved');
  assert.equal(sent.filter(message => message.messageType === 'job.save').length, 1);
  assert.equal(sent.some(message => message.messageType === 'submit.confirm'), false);
  assert.deepEqual(storage.data.desktopSaveIntents, []);
  assert.deepEqual(storage.data.desktopOutbox, []);
});

test('the same company with a different title creates a second application and never merges', async () => {
  const model = desktop();
  const { router } = await harness(message => model.answer(message));

  const first = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });
  const second = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('测试开发') });

  assert.equal(first.status, 'saved');
  assert.equal(second.status, 'saved');
  assert.notEqual(first.applicationId, second.applicationId);
  assert.deepEqual(model.applications.map(item => item.title).sort(), ['后端开发', '测试开发']);
});

test('an exact repeat asks, and choosing new or existing does not fork a retry into two rows', async () => {
  const model = desktop();
  const { router, sent } = await harness(message => model.answer(message));
  const first = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });

  const again = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });

  assert.equal(again.status, 'needs_choice');
  assert.equal(again.exact[0].applicationId, first.applicationId);
  assert.equal(model.applications.length, 1);
  assert.equal(sent.filter(message => message.messageType === 'job.save').length, 1);

  const existing = await router.handle({ type: 'DESKTOP_BIND', intentId: again.intent.intentId, applicationId: first.applicationId });
  assert.equal(existing.status, 'saved');
  assert.equal(existing.applicationId, first.applicationId);
  assert.equal(model.applications.length, 1);

  const third = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });
  const created = await router.handle({ type: 'DESKTOP_BIND', intentId: third.intent.intentId, applicationId: null });
  assert.equal(created.status, 'saved');
  assert.notEqual(created.applicationId, first.applicationId);
  assert.equal(model.applications.length, 2);
});

test('a second click while the first save is in flight does not write a second application', async () => {
  const model = desktop();
  const release = model.holdJob();
  const { router, sent } = await harness(message => model.answer(message));

  const first = router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });
  while (!sent.some(message => message.messageType === 'job.save')) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const second = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });
  assert.equal(second.status, 'duplicate');
  release();
  const saved = await first;

  assert.equal(saved.status, 'saved');
  assert.equal(model.applications.length, 1);
  assert.equal(sent.filter(message => message.messageType === 'job.save').length, 1);
});

test('an offline save stays pending and does not claim the desktop has it', async () => {
  const { router, storage, sent } = await harness(() => ({ lastError: 'Error when communicating with the native messaging host.' }));

  const saved = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });

  assert.equal(saved.status, 'queued');
  assert.equal(saved.mode, 'unavailable');
  assert.equal(saved.intent.status, 'pending_desktop');
  assert.equal(sent.some(message => message.messageType === 'job.save'), false);
  assert.equal(JSON.stringify(saved).includes('"saved"'), false);
  assert.equal(storage.data.desktopOutbox, undefined);
});

test('a queued save is not replayed as success after the archive epoch changes', async () => {
  const model = desktop();
  let jobUnavailable = true;
  const { router, drain, storage } = await harness(message => {
    if (message.messageType === 'job.save' && jobUnavailable) {
      return { response: { protocolVersion: 1, correlationId: message.messageId, ok: false, error: { code: 'unavailable', retryable: true, message: 'down' }, payload: {} } };
    }
    return model.answer(message);
  });

  const pending = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: fields('后端开发') });
  assert.equal(pending.status, 'pending');
  assert.equal(storage.data.desktopOutbox[0].sourceRestoreEpoch, EPOCH);
  assert.equal(model.applications.length, 0);

  model.setEpoch(EPOCH_2);
  jobUnavailable = false;
  const drained = await drain.run();
  assert.notEqual(drained.saved?.length, 1);
  const retry = await router.handle({ type: 'DESKTOP_RETRY', messageId: storage.data.desktopOutbox[0].messageId });
  assert.notEqual(retry.status, 'saved');
  assert.equal(model.applications.length, 0);
  assert.equal(storage.data.desktopOutbox.length, 1);
});
