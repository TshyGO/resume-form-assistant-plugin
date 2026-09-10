const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LATER_EPOCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPLICATION = '77777777-7777-4777-8777-777777777777';
const IDENTITY = { archiveId: ARCHIVE, restoreEpoch: EPOCH };

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

async function harness({ desktop, storage = fakeStorage(), clock = { value: Date.parse('2026-09-09T00:00:00.000Z') } } = {}) {
  const { createStore } = await import('../link/store.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');

  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date(clock.value);
  const store = createStore({ storage, uuid });
  const sent = [];
  const outbox = createOutbox({
    store,
    uuid,
    now,
    sleep: async () => {},
    sendNative: async (host, message) => {
      sent.push({ message, storageAtSendTime: JSON.parse(JSON.stringify(storage.data)) });
      return desktop(message);
    }
  });
  const intents = createIntents({ store, uuid, now });
  return { outbox, intents, store, storage, sent, clock };
}

const savedReply = (message, resultId = APPLICATION) => ({
  response: { protocolVersion: 1, correlationId: message.messageId, ok: true, resultId, payload: {} }
});

const errorReply = (message, code, retryable = false) => ({
  response: {
    protocolVersion: 1, correlationId: message.messageId, ok: false,
    error: { code, retryable, message: 'synthetic' }, payload: {}
  }
});

async function queuedIntent(intents) {
  const { intent } = await intents.save({ fields: FIELDS, mode: 'ready' });
  return intent;
}

test('candidates come back in two layers', async () => {
  const { outbox } = await harness({
    desktop: message => ({
      response: {
        protocolVersion: 1, correlationId: message.messageId, ok: true,
        payload: {
          exact: [{ applicationId: APPLICATION, company: '星河科技', title: '后端开发', stage: 'saved' }],
          sameCompany: [{ applicationId: '88888888-8888-4888-8888-888888888888', company: '星河科技', title: '测试开发' }]
        }
      }
    })
  });

  const result = await outbox.queryCandidates({ identity: IDENTITY, fields: FIELDS });

  assert.equal(result.status, 'ok');
  assert.equal(result.exact.length, 1);
  assert.equal(result.sameCompany.length, 1);
});

test('a candidate query asks for nothing but the three hint fields', async () => {
  const { outbox, sent } = await harness({
    desktop: message => ({
      response: { protocolVersion: 1, correlationId: message.messageId, ok: true, payload: { exact: [], sameCompany: [] } }
    })
  });

  await outbox.queryCandidates({ identity: IDENTITY, fields: FIELDS });

  // Reading is not writing: a query carries no source epoch and no digest, and D05 refuses
  // the message if it does. It also must not turn into a way to pull the archive down.
  assert.deepEqual(Object.keys(sent[0].message.payload).sort(), ['company', 'sourceUrl', 'title']);
});

test('a closed desktop makes candidates unavailable rather than empty', async () => {
  const { outbox } = await harness({ desktop: message => errorReply(message, 'unavailable', true) });

  const result = await outbox.queryCandidates({ identity: IDENTITY, fields: FIELDS });

  // An empty candidate list means "no existing application matches", which would push the
  // user into creating a duplicate.
  assert.notEqual(result.status, 'ok');
  assert.equal(result.status, 'retryable');
});

test('the outbox entry is on disk before anything is sent', async () => {
  const { outbox, intents, sent } = await harness({ desktop: savedReply });
  const intent = await queuedIntent(intents);

  await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  // If the worker dies between the send and the reply, the entry has to be there to retry
  // with the same messageId. Sending first is how a job gets written twice.
  const queued = sent[0].storageAtSendTime.desktopOutbox;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].messageId, sent[0].message.messageId);
});

test('a persisted save clears the intent and reports the application it created', async () => {
  const { outbox, intents, storage } = await harness({ desktop: savedReply });
  const intent = await queuedIntent(intents);

  const result = await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  assert.equal(result.status, 'saved');
  // For job.save the desktop's resultId is the application it wrote; D06's own tests feed it
  // straight back as the applicationId of a later fill.submit.
  assert.equal(result.applicationId, APPLICATION);
  assert.deepEqual(storage.data.desktopSaveIntents, []);
  assert.deepEqual(storage.data.desktopOutbox, []);
});

test('binding to an existing application sends that id and keeps it', async () => {
  const { outbox, intents, sent } = await harness({ desktop: savedReply });
  const intent = await queuedIntent(intents);

  const result = await outbox.bindAndSend({
    intentId: intent.intentId,
    applicationId: '99999999-9999-4999-8999-999999999999',
    identity: IDENTITY
  });

  assert.equal(sent[0].message.payload.applicationId, '99999999-9999-4999-8999-999999999999');
  assert.equal(result.applicationId, '99999999-9999-4999-8999-999999999999');
});

test('the source epoch is stamped at bind time and never refreshed', async () => {
  const { outbox, intents, storage, sent, clock } = await harness({
    desktop: message => errorReply(message, 'unavailable', true)
  });
  const intent = await queuedIntent(intents);
  await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  // The desktop was restored between attempts. The envelope must follow the new identity,
  // the payload must not: rewriting it would replay this job into a different archive.
  clock.value += 60_000;
  await outbox.drainOnce({ identity: { archiveId: ARCHIVE, restoreEpoch: LATER_EPOCH } });

  assert.equal(storage.data.desktopOutbox[0].sourceRestoreEpoch, EPOCH);
  assert.equal(sent.at(-1).message.payload.sourceRestoreEpoch, EPOCH);
});

test('an unanswered send leaves the job pending, not saved', async () => {
  const { outbox, intents, storage } = await harness({
    desktop: message => errorReply(message, 'unavailable', true)
  });
  const intent = await queuedIntent(intents);

  const result = await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  assert.equal(result.status, 'pending');
  assert.equal(storage.data.desktopOutbox.length, 1);
  assert.equal(storage.data.desktopOutbox[0].status, 'pending');
  assert.equal(storage.data.desktopSaveIntents.length, 1, 'the intent stays until the write is persisted');
});

test('a retry reuses the message id and the replay resolves to one application', async () => {
  let calls = 0;
  const { outbox, intents, storage, sent, clock } = await harness({
    desktop: message => {
      calls += 1;
      // First attempt: the reply is lost. Second: the desktop recognises the identity and
      // returns the original resultId without writing anything new.
      return calls <= 2 ? errorReply(message, 'unavailable', true) : savedReply(message);
    }
  });
  const intent = await queuedIntent(intents);

  await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });
  const first = sent[0].message.messageId;
  clock.value += 60_000;
  const result = await outbox.drainOnce({ identity: IDENTITY });

  assert.equal(sent.at(-1).message.messageId, first, 'a new id would create a second application');
  assert.equal(result.saved.length, 1);
  assert.deepEqual(storage.data.desktopOutbox, []);
  assert.deepEqual(storage.data.desktopSaveIntents, []);
});

test('a protocol refusal marks the entry failed instead of retrying it forever', async () => {
  const { outbox, intents, storage } = await harness({
    desktop: message => errorReply(message, 'previously_purged')
  });
  const intent = await queuedIntent(intents);

  const result = await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'previously_purged');
  assert.equal(storage.data.desktopOutbox[0].status, 'failed');
  assert.equal(storage.data.desktopOutbox[0].lastError, 'previously_purged');
});

test('a full outbox refuses a new binding and keeps the intent', async () => {
  const { MAX_OUTBOX } = await import('../link/limits.mjs');
  const full = Array.from({ length: MAX_OUTBOX }, (unused, index) => ({
    messageId: `m-${index}`, status: 'pending', messageType: 'job.save'
  }));
  const { outbox, intents, storage } = await harness({
    desktop: savedReply,
    storage: fakeStorage({ desktopOutbox: full })
  });
  const intent = await queuedIntent(intents);

  const result = await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'queue_full');
  assert.equal(storage.data.desktopOutbox.length, MAX_OUTBOX);
  assert.equal(storage.data.desktopSaveIntents.length, 1);
});

test('binding an intent that is already gone does not invent one', async () => {
  const { outbox } = await harness({ desktop: savedReply });

  const result = await outbox.bindAndSend({ intentId: 'no-such-intent', identity: IDENTITY });

  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'unknown_intent');
});

test('a write is never sent without a fresh handshake identity', async () => {
  const { outbox, intents, sent } = await harness({ desktop: savedReply });
  const intent = await queuedIntent(intents);

  const result = await outbox.bindAndSend({ intentId: intent.intentId, identity: null });

  assert.equal(result.status, 'rejected');
  assert.equal(sent.length, 0);
});

test('a race cannot push the bound queue past its limit', async () => {
  const { MAX_OUTBOX } = await import('../link/limits.mjs');
  const nearlyFull = Array.from({ length: MAX_OUTBOX - 1 }, (unused, index) => ({
    messageId: `m-${index}`, status: 'pending', messageType: 'job.save'
  }));
  const { outbox, intents, storage } = await harness({
    desktop: message => errorReply(message, 'unavailable', true),
    storage: fakeStorage({ desktopOutbox: nearlyFull })
  });
  const first = await intents.save({ fields: FIELDS, mode: 'ready' });
  const second = await intents.save({ fields: { ...FIELDS, title: '测试开发' }, mode: 'ready' });

  // Checking the size and appending have to be one step, or two binds in the same worker
  // turn both see room for one.
  const results = await Promise.all([
    outbox.bindAndSend({ intentId: first.intent.intentId, identity: IDENTITY }),
    outbox.bindAndSend({ intentId: second.intent.intentId, identity: IDENTITY })
  ]);

  assert.equal(storage.data.desktopOutbox.length, MAX_OUTBOX);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('double-clicking bind produces one application, not two', async () => {
  const { outbox, intents, sent, storage } = await harness({ desktop: savedReply });
  const intent = await queuedIntent(intents);

  // Two DESKTOP_BIND messages from one double-click, handled in the same worker turn. Two
  // entries would mean two messageIds, and two messageIds mean the desktop cannot see the
  // second as a replay — it writes a second application for one posting.
  const results = await Promise.all([
    outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY }),
    outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY })
  ]);

  const writes = sent.filter(item => item.message.messageType === 'job.save');
  assert.equal(new Set(writes.map(item => item.message.messageId)).size, 1);
  assert.equal(results.filter(result => result.status === 'saved').length, 1);
  assert.equal(results.filter(result => result.status === 'duplicate').length, 1);
  assert.deepEqual(storage.data.desktopOutbox, []);
});

test('an intent that is already queued is not bound a second time later', async () => {
  const { outbox, intents, storage } = await harness({
    desktop: message => errorReply(message, 'unavailable', true)
  });
  const intent = await queuedIntent(intents);
  await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  const again = await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  assert.equal(again.status, 'duplicate');
  assert.equal(storage.data.desktopOutbox.length, 1);
});

// --- submit.confirm --------------------------------------------------------

test('confirming a submission is a queued write like any other', async () => {
  const { outbox, storage, sent } = await harness({ desktop: savedReply });

  const result = await outbox.confirmSubmit({ applicationId: APPLICATION, identity: IDENTITY });

  assert.equal(result.status, 'saved');
  assert.equal(sent[0].message.messageType, 'submit.confirm');
  assert.equal(sent[0].message.payload.applicationId, APPLICATION);
  assert.deepEqual(storage.data.desktopOutbox, []);
});

test('a submit confirmation carries nothing but the application it names', async () => {
  const { outbox, sent } = await harness({ desktop: savedReply });

  await outbox.confirmSubmit({ applicationId: APPLICATION, identity: IDENTITY });

  // D05 freezes this payload at three fields. `via` and `note` are D03's internal columns and
  // must not appear on the wire.
  assert.deepEqual(
    Object.keys(sent[0].message.payload).sort(),
    ['applicationId', 'payloadSha256', 'sourceRestoreEpoch']
  );
});

test('a confirmation that cannot be delivered waits in the queue', async () => {
  const { outbox, storage } = await harness({ desktop: message => errorReply(message, 'unavailable', true) });

  const result = await outbox.confirmSubmit({ applicationId: APPLICATION, identity: IDENTITY });

  assert.equal(result.status, 'pending');
  assert.equal(storage.data.desktopOutbox[0].messageType, 'submit.confirm');
  assert.equal(storage.data.desktopOutbox[0].sourceRestoreEpoch, EPOCH);
});

test('confirming a submission does not touch any intent', async () => {
  const { outbox, intents, storage } = await harness({ desktop: savedReply });
  await queuedIntent(intents);

  await outbox.confirmSubmit({ applicationId: APPLICATION, identity: IDENTITY });

  // Confirming a submission is unrelated to saving a posting, and unrelated to whether the
  // AI fill worked. It must not consume a pending intent.
  assert.equal(storage.data.desktopSaveIntents.length, 1);
});
