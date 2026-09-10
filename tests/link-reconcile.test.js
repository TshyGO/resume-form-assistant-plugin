const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLD_EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NEW_EPOCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPLICATION = '77777777-7777-4777-8777-777777777777';

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
  const { createReconcile } = await import('../link/reconcile.mjs');

  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date(clock.value);
  const sent = [];
  const deps = {
    store: createStore({ storage, uuid }),
    uuid,
    now,
    sleep: async () => {},
    sendNative: async (host, message) => {
      sent.push(message);
      return desktop(message);
    }
  };
  const outbox = createOutbox(deps);
  const reconcile = createReconcile({ ...deps, outbox });
  const intents = createIntents(deps);
  return { reconcile, outbox, intents, store: deps.store, storage, sent, clock };
}

const unavailable = message => ({
  response: {
    protocolVersion: 1, correlationId: message.messageId, ok: false,
    error: { code: 'unavailable', retryable: true, message: 'starting' }, payload: {}
  }
});

// A reconcile answer must echo each requested identity exactly; D05 refuses anything else.
// `writes` is shared with staleEntry: the original send has to fail, or there would be no
// queued message left to reconcile.
const reconcileReply = (statusFor, writes = { ok: true }) => message => {
  if (message.messageType !== 'outbox.reconcile') {
    return writes.ok
      ? { response: { protocolVersion: 1, correlationId: message.messageId, ok: true, resultId: APPLICATION, payload: {} } }
      : unavailable(message);
  }
  return {
    response: {
      protocolVersion: 1,
      correlationId: message.messageId,
      ok: true,
      payload: {
        items: message.payload.items.map(item => {
          const status = statusFor(item);
          const answered = { ...item, status };
          if (status === 'applied') answered.resultId = APPLICATION;
          return answered;
        })
      }
    }
  };
};

/** Queue one bound message stamped with the old epoch, left unsent. */
async function staleEntry(bench, writes) {
  const wasOk = writes.ok;
  writes.ok = false;
  const { intent } = await bench.intents.save({ fields: FIELDS, mode: 'ready' });
  await bench.outbox.bindAndSend({
    intentId: intent.intentId,
    identity: { archiveId: ARCHIVE, restoreEpoch: OLD_EPOCH }
  });
  writes.ok = wasOk;
  return bench.storage.data.desktopOutbox.at(-1);
}

const current = { archiveId: ARCHIVE, restoreEpoch: NEW_EPOCH };

test('a restored archive pauses every message stamped with the old epoch', async () => {
  const bench = await harness({ desktop: unavailable });
  await staleEntry(bench, { ok: false });

  await bench.reconcile.pauseStale(current);

  assert.equal(bench.storage.data.desktopOutbox[0].status, 'paused');
});

test('a paused message is never sent as a write again', async () => {
  const bench = await harness({ desktop: unavailable });
  await staleEntry(bench, { ok: false });
  await bench.reconcile.pauseStale(current);
  bench.clock.value += 86_400_000;
  const before = bench.sent.filter(message => message.messageType === 'job.save').length;

  await bench.outbox.drainOnce({ identity: current });

  // The old envelope must never go out again: the desktop would refuse it, and if it did
  // not, the job would land in an archive the user never chose.
  const after = bench.sent.filter(message => message.messageType === 'job.save').length;
  assert.equal(after, before, 'nothing was sent after the pause');
});

test('a message stamped with the current epoch keeps going', async () => {
  const bench = await harness({ desktop: unavailable });
  const { intent } = await bench.intents.save({ fields: FIELDS, mode: 'ready' });
  await bench.outbox.bindAndSend({ intentId: intent.intentId, identity: current });

  await bench.reconcile.pauseStale(current);

  assert.equal(bench.storage.data.desktopOutbox[0].status, 'pending');
});

test('applied means the desktop already did it: no new event, no replay licence', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'applied', writeState) });
  await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);

  const before = bench.sent.filter(message => message.messageType === 'job.save').length;
  const report = await bench.reconcile.run(current);

  assert.equal(report.applied.length, 1);
  assert.deepEqual(bench.storage.data.desktopOutbox, []);
  const after = bench.sent.filter(message => message.messageType === 'job.save').length;
  assert.equal(after, before, 'reconcile must not re-send the write it just confirmed');
});

test('purged is not rebuilt', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'purged', writeState) });
  await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);

  await bench.reconcile.run(current);

  assert.equal(bench.storage.data.desktopOutbox[0].reconcileStatus, 'purged');
  assert.equal(bench.storage.data.desktopOutbox[0].status, 'needs_user');
});

test('not_found does not authorise a rewrite', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);
  const before = bench.sent.filter(message => message.messageType === 'job.save').length;

  await bench.reconcile.run(current);

  // "This backup holds no receipt" is not "this never happened". Rewriting on that basis is
  // how a restore turns into a duplicate.
  assert.equal(bench.storage.data.desktopOutbox[0].status, 'needs_user');
  assert.equal(bench.storage.data.desktopOutbox[0].reconcileStatus, 'not_found');
  const after = bench.sent.filter(message => message.messageType === 'job.save').length;
  assert.equal(after, before, 'not_found must not trigger a rewrite');
});

test('conflict and unverifiable both stop for the user', async () => {
  for (const status of ['conflict', 'unverifiable']) {
    const writeState = { ok: true };
    const bench = await harness({ desktop: reconcileReply(() => status, writeState) });
    await staleEntry(bench, writeState);
    await bench.reconcile.pauseStale(current);

    await bench.reconcile.run(current);

    assert.equal(bench.storage.data.desktopOutbox[0].status, 'needs_user', status);
    assert.equal(bench.storage.data.desktopOutbox[0].reconcileStatus, status);
  }
});

test('reconcile batches stay within the protocol limit', async () => {
  const { MAX_RECONCILE_ITEMS } = await import('../link/protocol/validate.mjs');
  const writeState = { ok: false };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  for (let i = 0; i < MAX_RECONCILE_ITEMS + 1; i += 1) {
    const { intent } = await bench.intents.save({ fields: { ...FIELDS, title: `岗位 ${i}` }, mode: 'ready' });
    await bench.outbox.bindAndSend({
      intentId: intent.intentId,
      identity: { archiveId: ARCHIVE, restoreEpoch: OLD_EPOCH }
    });
  }
  await bench.reconcile.pauseStale(current);

  await bench.reconcile.run(current);

  const batches = bench.sent.filter(message => message.messageType === 'outbox.reconcile');
  assert.equal(batches.length, 2);
  assert.ok(batches.every(batch => batch.payload.items.length <= MAX_RECONCILE_ITEMS));
});

test('the reconcile envelope uses the current identity and the items keep the old one', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const entry = await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);

  await bench.reconcile.run(current);

  const batch = bench.sent.find(message => message.messageType === 'outbox.reconcile');
  assert.equal(batch.restoreEpoch, NEW_EPOCH);
  assert.equal(batch.payload.items[0].sourceRestoreEpoch, OLD_EPOCH);
  assert.equal(batch.payload.items[0].messageId, entry.messageId);
});

test('discarding a paused message drops it and the fields behind it', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const entry = await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);
  await bench.reconcile.run(current);

  await bench.reconcile.resolve(entry.messageId, { choice: 'discard' });

  assert.deepEqual(bench.storage.data.desktopOutbox, []);
  assert.deepEqual(bench.storage.data.desktopSaveIntents, []);
});

test('saving again mints one new identity and records the old one', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const entry = await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);
  await bench.reconcile.run(current);

  const result = await bench.reconcile.resolve(entry.messageId, { choice: 'resave', identity: current });

  assert.equal(result.status, 'saved');
  const write = bench.sent.filter(message => message.messageType === 'job.save').at(-1);
  assert.notEqual(write.messageId, entry.messageId);
  assert.equal(write.payload.sourceRestoreEpoch, NEW_EPOCH);
});

test('a retry after saving again does not mint a third identity', async () => {
  let allowWrite = false;
  const bench = await harness({
    desktop: message => {
      if (message.messageType === 'outbox.reconcile') return reconcileReply(() => 'not_found')(message);
      if (!allowWrite) return unavailable(message);
      return { response: { protocolVersion: 1, correlationId: message.messageId, ok: true, resultId: APPLICATION, payload: {} } };
    }
  });
  const entry = await staleEntry(bench, { ok: false });
  await bench.reconcile.pauseStale(current);
  await bench.reconcile.run(current);

  // The conversion is persisted before it is sent, so a failed send retries the new identity
  // rather than creating yet another one.
  await bench.reconcile.resolve(entry.messageId, { choice: 'resave', identity: current });
  const minted = bench.storage.data.desktopOutbox[0].messageId;
  allowWrite = true;
  bench.clock.value += 60_000;
  await bench.outbox.drainOnce({ identity: current });

  const writes = bench.sent.filter(message => message.messageType === 'job.save');
  const identities = new Set(writes.map(message => message.messageId));
  assert.deepEqual([...identities].sort(), [entry.messageId, minted].sort());
});

test('the resaved message remembers what it came from', async () => {
  const writeState = { ok: false };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const entry = await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);
  await bench.reconcile.run(current);

  await bench.reconcile.resolve(entry.messageId, { choice: 'resave', identity: current });

  const replacement = bench.storage.data.desktopOutbox[0];
  assert.equal(replacement.previousIdentity.messageId, entry.messageId);
  assert.equal(replacement.previousIdentity.sourceRestoreEpoch, OLD_EPOCH);
});

test('associating binds the paused fields to an application the user names', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const entry = await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);
  await bench.reconcile.run(current);

  await bench.reconcile.resolve(entry.messageId, {
    choice: 'associate',
    applicationId: '99999999-9999-4999-8999-999999999999',
    identity: current
  });

  const write = bench.sent.filter(message => message.messageType === 'job.save').at(-1);
  assert.equal(write.payload.applicationId, '99999999-9999-4999-8999-999999999999');
});

test('reconciliation leaves intents alone so they get fresh candidates', async () => {
  const writeState = { ok: true };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);

  await bench.reconcile.run(current);

  // An intent carries no epoch, so there is nothing to reconcile. It goes back through
  // candidate selection against the archive that exists now.
  assert.equal(bench.storage.data.desktopSaveIntents.length, 1);
  assert.equal(bench.sent.some(message => message.messageType === 'application.queryCandidates'), false);
});

test('a manual retry cannot revive a paused message', async () => {
  const { createSession } = await import('../link/session.mjs');
  const { createDrain } = await import('../link/drain.mjs');
  const writeState = { ok: false };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const entry = await staleEntry(bench, writeState);
  await bench.reconcile.pauseStale(current);

  const drain = createDrain({
    session: createSession({
      store: bench.store,
      sendNative: async () => ({ lastError: 'unreachable' }),
      sleep: async () => {},
      uuid: () => '00000000-0000-4000-8000-00000000ffff',
      now: () => new Date(bench.clock.value)
    }),
    outbox: bench.outbox,
    alarms: { created: [], async create() {}, async clear() { return true; } },
    now: () => new Date(bench.clock.value)
  });
  const before = bench.sent.filter(message => message.messageType === 'job.save').length;

  // The sidebar hides retry for a paused row, but the message path takes any messageId. A
  // revived paused entry goes out under an epoch the desktop has already replaced.
  const result = await drain.retryNow(entry.messageId);

  assert.equal(bench.storage.data.desktopOutbox[0].status, 'paused');
  assert.equal(bench.sent.filter(message => message.messageType === 'job.save').length, before);
  assert.equal(result.status, 'rejected');
});

test('saving again is refused for a message that is not paused', async () => {
  const writeState = { ok: false };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const entry = await staleEntry(bench, writeState);
  // Never paused: this entry is still on the normal retry ladder.

  const result = await bench.reconcile.resolve(entry.messageId, { choice: 'resave', identity: current });

  assert.equal(result.status, 'rejected');
  assert.equal(bench.storage.data.desktopOutbox.length, 1);
  assert.equal(bench.storage.data.desktopOutbox[0].messageId, entry.messageId);
});

test('a snapshot chunk reconciles on its chunk identity, not its payload body', async () => {
  const { snapshotChunkIdentitySha256 } = await import('../link/protocol/validate.mjs');
  const writeState = { ok: false };
  const bench = await harness({ desktop: reconcileReply(() => 'not_found', writeState) });
  const chunkPayload = {
    snapshotId: '44444444-4444-4444-8444-444444444444',
    applicationId: APPLICATION,
    chunkIndex: 0,
    chunkCount: 1,
    chunkSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    snapshotSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    byteSize: 5,
    bytesBase64: 'aGVsbG8='
  };
  await bench.store.updateOutbox(() => [{
    messageId: '55555555-5555-4555-8555-555555555555',
    intentId: null,
    clientInstanceId: '00000000-0000-4000-8000-000000000001',
    messageType: 'snapshot.chunk',
    archiveId: ARCHIVE,
    sourceRestoreEpoch: OLD_EPOCH,
    payload: chunkPayload,
    status: 'paused',
    attempts: 0,
    nextAttemptAt: null
  }]);

  await bench.reconcile.run(current);

  // D05 stores a chunk's receipt digest as the immutable chunk identity. Sending the payload
  // body digest instead makes the desktop answer conflict or not_found for chunks it holds.
  const batch = bench.sent.find(message => message.messageType === 'outbox.reconcile');
  const expected = await snapshotChunkIdentitySha256({ ...chunkPayload, sourceRestoreEpoch: OLD_EPOCH });
  assert.equal(batch.payload.items[0].payloadSha256, expected);
});
