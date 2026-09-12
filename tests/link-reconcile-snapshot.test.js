const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESTORED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPLICATION = '77777777-7777-4777-8777-777777777777';
const EVENT = '99999999-9999-4999-8999-999999999999';

const RAW = {
  outcome: 'success', cancelled: false, fieldCount: 5, filledCount: 5, unconfirmedCount: 0,
  timing: { scanMs: 1, roundTripMs: 2, fillMs: 3, totalMs: 6 },
  urlRedacted: 'https://jobs.example.com/apply', templateName: '合成模板', pluginVersion: '0.4.0',
  job: { company: '星河科技', title: '后端开发', sourceUrl: 'https://jobs.example.com/apply' }
};

function template(fields = 300) {
  return {
    name: '合成模板',
    groups: [{ name: '经历', fields: Array.from({ length: fields }, (_, i) => ({ key: `项目${i}`, value: `合成经历描述${i} `.repeat(30) })) }]
  };
}

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

function fakeKv() {
  const map = new Map();
  const kv = {
    map,
    onDelete: null,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { if (kv.onDelete) await kv.onDelete(key); map.delete(key); },
    async list() { return [...map.values()].map(value => structuredClone(value)); }
  };
  return kv;
}

const closed = () => ({ lastError: 'Error when communicating with the native messaging host.' });
const reply = (message, payload, resultId) => ({
  response: { protocolVersion: 1, correlationId: message.messageId, ok: true, ...(resultId ? { resultId } : {}), payload }
});

/** A desktop whose epoch can be moved, that answers reconcile with a scripted status per chunk. */
function desktop() {
  const model = { epoch: EPOCH, writes: true, reconcileBatches: [], statusFor: () => 'not_found', chunks: [], fills: [] };
  model.answer = message => {
    if (message.messageType === 'handshake') {
      return reply(message, { appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 1, archiveId: ARCHIVE, restoreEpoch: model.epoch, capabilities: ['handshake'] });
    }
    if (message.messageType === 'outbox.reconcile') {
      model.reconcileBatches.push(message.payload.items);
      return reply(message, {
        items: message.payload.items.map(item => {
          const status = model.statusFor(item);
          return { ...item, status, ...(status === 'applied' ? { resultId: item.messageId } : {}) };
        })
      });
    }
    if (!model.writes) return closed();
    if (message.messageType === 'fill.submit') {
      model.fills.push(message);
      return reply(message, { resultKind: 'event' }, EVENT);
    }
    if (message.messageType === 'snapshot.chunk') {
      model.chunks.push(message);
      const p = message.payload;
      const last = p.chunkIndex === p.chunkCount - 1;
      return reply(message, { ackKind: last ? 'snapshot' : 'chunk', snapshotId: p.snapshotId, chunkIndex: p.chunkIndex, chunkCursor: p.chunkIndex + 1 }, message.messageId);
    }
    return closed();
  };
  return model;
}

async function worker({ storage, kv, model, clock = { value: Date.parse('2026-09-12T08:00:00.000Z') }, alarms = { async create() {}, async clear() { return true; } } }) {
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');
  const { createReconcile } = await import('../link/reconcile.mjs');
  const { createDrain } = await import('../link/drain.mjs');
  const { createFillRecords } = await import('../link/fillrecords.mjs');
  const { createStaging } = await import('../link/staging.mjs');
  const { createUploads } = await import('../link/uploads.mjs');
  const { createRouter } = await import('../link/router.mjs');

  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date(clock.value);
  const store = createStore({ storage, uuid });
  const sent = [];
  const deps = {
    store, uuid, now, sleep: async () => {},
    sendNative: async (host, message) => {
      sent.push({ message, kvKeys: [...kv.map.keys()] });
      return model.answer(message);
    }
  };
  const staging = createStaging({ kv, now, uuid });
  const uploads = createUploads({ ...deps, staging });
  const session = createSession(deps);
  const outbox = createOutbox({ ...deps, uploads });
  const reconcile = createReconcile({ ...deps, outbox, uploads });
  const drain = createDrain({ session, outbox, reconcile, alarms, now });
  const fillRecords = createFillRecords(deps);
  const router = createRouter({
    session, intents: createIntents(deps), outbox, drain, reconcile, fillRecords, store, uploads,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });
  return { router, drain, sent, clock, uploads };
}

const PAIRED = () => fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } });

/** A fill with a snapshot, bound while the desktop refused writes, then the desktop is restored. */
async function queuedThenRestored({ fields = 300, alarms } = {}) {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  model.writes = false;
  const w = await worker({ storage, kv, model, ...(alarms ? { alarms } : {}) });
  await w.router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template(fields) });
  model.epoch = RESTORED;
  model.writes = true;
  return { storage, kv, model, ...w };
}

const upload = storage => storage.data.desktopOutbox.find(entry => entry.messageType === 'snapshot.upload');
const fill = storage => storage.data.desktopOutbox.find(entry => entry.messageType === 'fill.submit');

test('after a restore, the snapshot upload and its fill are paused and nothing is written', async () => {
  const { storage, model, drain, sent } = await queuedThenRestored();
  const before = sent.length;
  await drain.run();
  assert.notEqual(upload(storage).status, 'pending');
  assert.notEqual(fill(storage).status, 'pending');
  const writes = sent.slice(before).map(item => item.message.messageType).filter(type => type === 'snapshot.chunk' || type === 'fill.submit');
  assert.deepEqual(writes, [], 'walkthrough 10.21 counter-example 4: no old chunk is replayed');
  assert.equal(model.chunks.length, 0);
});

test('every chunk of a paused snapshot is asked about by its full old identity, 32 at a time', async () => {
  const { snapshotChunkIdentitySha256 } = await import('../link/protocol/validate.mjs');
  const { storage, model, drain } = await queuedThenRestored({ fields: 2000 });
  const entry = upload(storage);
  assert.ok(entry.chunkCount > 32, `needs more than one batch (got ${entry.chunkCount})`);
  await drain.run();

  const chunkItems = model.reconcileBatches.flat().filter(item => item.snapshotId);
  assert.ok(model.reconcileBatches.every(batch => batch.length <= 32));
  assert.equal(chunkItems.length, entry.chunkCount);
  const byIndex = new Map(chunkItems.map(item => [item.chunkIndex, item]));
  for (const chunk of entry.chunks) {
    const item = byIndex.get(chunk.chunkIndex);
    assert.equal(item.messageId, chunk.chunkMessageId);
    assert.equal(item.sourceRestoreEpoch, EPOCH);
    assert.equal(item.snapshotId, entry.snapshotId);
    assert.equal(item.payloadSha256, await snapshotChunkIdentitySha256({
      sourceRestoreEpoch: EPOCH, snapshotId: entry.snapshotId, applicationId: APPLICATION,
      chunkIndex: chunk.chunkIndex, chunkCount: entry.chunkCount, chunkSha256: chunk.chunkSha256,
      snapshotSha256: entry.sha256, byteSize: entry.byteSize
    }));
  }
});

test('no reconcile answer lets the plugin act on a snapshot by itself — not even applied', async () => {
  for (const status of ['applied', 'not_found', 'conflict', 'unverifiable', 'purged']) {
    const { storage, kv, model, drain } = await queuedThenRestored();
    model.statusFor = () => status;
    await drain.run();
    const entry = upload(storage);
    assert.equal(entry.status, 'needs_user', status);
    assert.equal(entry.reconcileStatus, status, status);
    assert.equal(kv.map.size, 1, `${status}: the staged copy is kept until the user decides`);
    assert.equal(model.chunks.length, 0, status);
  }
});

test('a mix of answers is summarised by the one that most needs a person', async () => {
  const { storage, model, drain } = await queuedThenRestored();
  model.statusFor = item => (item.chunkIndex === 1 ? 'conflict' : 'applied');
  await drain.run();
  assert.equal(upload(storage).reconcileStatus, 'conflict');
});

test('saving again uploads the same bytes under a new snapshot identity, persisted before sending', async () => {
  const { storage, kv, model, drain, router, sent } = await queuedThenRestored();
  await drain.run();
  const old = upload(storage);
  const oldIds = old.chunks.map(chunk => chunk.chunkMessageId);

  const first = await router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'resave' });
  assert.equal(first.status, 'queued');
  assert.equal(first.uploadQueued, true, 'the worker starts the new upload once the sidebar has its answer');
  const again = await router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'resave' });
  assert.equal(again.status, 'rejected', 'a second click finds nothing left to resave');

  const replacement = upload(storage);
  assert.notEqual(replacement.snapshotId, old.snapshotId, 'the desktop refuses a snapshot id under a new epoch');
  assert.equal(replacement.sourceRestoreEpoch, RESTORED);
  assert.equal(replacement.sha256, old.sha256, 'same bytes');
  assert.ok(replacement.chunks.every(chunk => !oldIds.includes(chunk.chunkMessageId)));
  assert.equal(replacement.previousIdentity.snapshotId, old.snapshotId);
  assert.deepEqual(replacement.previousIdentity.chunkMessageIds, oldIds);
  assert.equal(replacement.previousIdentity.sourceRestoreEpoch, EPOCH);
  assert.deepEqual([...kv.map.keys()], [replacement.snapshotId], 'the old copy is gone, the new one is staged');

  // Its fill event was paused by the same restore, and the snapshot waits for that event.
  await drain.run();
  assert.equal(sent.filter(item => item.message.messageType === 'snapshot.chunk').length, 0, 'no chunk before its event');
  const event = await router.handle({ type: 'DESKTOP_RESOLVE', messageId: fill(storage).messageId, choice: 'resave' });
  assert.equal(event.status, 'saved');

  await drain.run();
  const eventAt = sent.findIndex(item => item.message.messageType === 'fill.submit' && item.message.payload.sourceRestoreEpoch === RESTORED);
  const firstChunk = sent.findIndex(item => item.message.messageType === 'snapshot.chunk');
  assert.ok(eventAt >= 0 && firstChunk > eventAt, 'the event first, then the chunks');
  const chunkSends = sent.filter(item => item.message.messageType === 'snapshot.chunk');
  assert.ok(chunkSends.length > 0);
  for (const item of chunkSends) {
    assert.equal(item.message.payload.snapshotId, replacement.snapshotId);
    assert.equal(item.message.payload.sourceRestoreEpoch, RESTORED);
    assert.ok(item.kvKeys.includes(replacement.snapshotId), 'staged under the new id before the first send');
  }
  assert.equal(model.chunks.at(-1).payload.snapshotSha256, old.sha256);
});

test('a paused fill still in the queue is re-pointed at the resaved snapshot', async () => {
  const { storage, drain, router } = await queuedThenRestored();
  await drain.run();
  const old = upload(storage);
  await router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'resave' });
  assert.equal(fill(storage).payload.snapshotId, upload(storage).snapshotId);
});

test('discarding a paused snapshot deletes the copy and keeps nothing of it', async () => {
  const { storage, kv, drain, router } = await queuedThenRestored();
  await drain.run();
  const old = upload(storage);
  const result = await router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'discard' });
  assert.equal(result.status, 'discarded');
  assert.equal(upload(storage), undefined);
  assert.equal(kv.map.size, 0);
});

test('a snapshot whose copy is gone cannot be saved again, only discarded', async () => {
  const { storage, kv, drain, router } = await queuedThenRestored();
  await drain.run();
  kv.map.clear();
  const old = upload(storage);
  const result = await router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'resave' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'bytes_lost');
});

test('two clicks on "重新上传" at once stage one replacement, not two', async () => {
  const { storage, kv, drain, router } = await queuedThenRestored();
  await drain.run();
  const old = upload(storage);
  const results = await Promise.all([
    router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'resave' }),
    router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'resave' })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['queued', 'rejected']);
  assert.equal(storage.data.desktopOutbox.filter(entry => entry.messageType === 'snapshot.upload').length, 1);
  assert.equal(kv.map.size, 1, 'one staged copy, under the one new id');
});

test('a snapshot whose reconciliation went unanswered is asked about again later', async () => {
  const created = [];
  const alarms = { async create(name, info) { created.push(info); }, async clear() { return true; } };
  const { storage, model, drain } = await queuedThenRestored({ alarms });
  const answer = model.answer;
  model.answer = message => (message.messageType === 'outbox.reconcile' ? { lastError: 'Native host has exited.' } : answer(message));
  await drain.run();
  assert.equal(upload(storage).status, 'paused');
  assert.ok(created.length > 0, 'an alarm brings the next pass');

  model.answer = answer;
  await drain.run();
  assert.equal(upload(storage).status, 'needs_user');
});

test('a resave whose old copy cannot be deleted yet never resurrects the old upload', async () => {
  const { storage, kv, model, drain, router } = await queuedThenRestored();
  await drain.run();
  const old = upload(storage);
  kv.onDelete = async () => { throw new Error('transient'); };
  const result = await router.handle({ type: 'DESKTOP_RESOLVE', messageId: old.messageId, choice: 'resave' });
  assert.equal(result.status, 'queued');
  kv.onDelete = null;

  const again = await worker({ storage, kv, model });
  await again.uploads.repair();
  const uploads = storage.data.desktopOutbox.filter(entry => entry.messageType === 'snapshot.upload' && entry.status !== 'discarding');
  assert.equal(uploads.length, 1, 'only the replacement');
  assert.notEqual(uploads[0].snapshotId, old.snapshotId);
  assert.equal(kv.map.has(old.snapshotId), false, 'the old copy is gone by now');
});
