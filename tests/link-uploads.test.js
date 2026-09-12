const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPLICATION = '77777777-7777-4777-8777-777777777777';
const EVENT = '99999999-9999-4999-8999-999999999999';
const DAY = 24 * 60 * 60 * 1000;

const RAW = {
  outcome: 'success', cancelled: false, fieldCount: 5, filledCount: 5, unconfirmedCount: 0,
  timing: { scanMs: 1, roundTripMs: 2, fillMs: 3, totalMs: 6 },
  urlRedacted: 'https://jobs.example.com/apply', templateName: '合成模板', pluginVersion: '0.4.0',
  job: { company: '星河科技', title: '后端开发', sourceUrl: 'https://jobs.example.com/apply' }
};

// Big enough for three 32 KiB chunks.
function template(value = '经历') {
  return {
    name: '合成模板',
    groups: [{ name: '经历', fields: Array.from({ length: 300 }, (_, i) => ({ key: `项目${i}`, value: `${value}${i} `.repeat(30) })) }]
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

function fakeKv({ failPut = false } = {}) {
  const map = new Map();
  const kv = {
    map,
    onDelete: null,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) {
      if (kv.failPut) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      map.set(key, structuredClone(value));
    },
    async delete(key) { if (kv.onDelete) await kv.onDelete(key); map.delete(key); },
    async list() { return [...map.values()].map(value => structuredClone(value)); }
  };
  kv.failPut = failPut;
  return kv;
}

const closed = () => ({ lastError: 'Error when communicating with the native messaging host.' });

function reply(message, payload, resultId = message.messageId) {
  return { response: { protocolVersion: 1, correlationId: message.messageId, ok: true, resultId, payload } };
}

/**
 * The desktop's side of D08, by the protocol's own rules: a chunk is kept under the id it
 * first arrived with (a new id for the same chunk is a conflict), the cursor counts
 * consecutive chunks from zero, and only a complete set earns ackKind: snapshot.
 */
function desktop({ online = true, dropCompleteAcks = 0, failCompletions = 0 } = {}) {
  const model = { online, dropCompleteAcks, failCompletions, uploads: new Map(), events: [], chunkMessages: [] };
  model.answer = message => {
    if (!model.online) return closed();
    if (message.messageType === 'handshake') {
      return reply(message, { appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 1, archiveId: ARCHIVE, restoreEpoch: EPOCH, capabilities: ['handshake'] }, undefined);
    }
    if (message.messageType === 'fill.submit') {
      model.events.push(message);
      return reply(message, { resultKind: 'event' }, EVENT);
    }
    if (message.messageType === 'snapshot.chunk') {
      model.chunkMessages.push(message);
      const p = message.payload;
      const upload = model.uploads.get(p.snapshotId) ?? { chunks: new Map(), ids: new Map(), count: p.chunkCount, complete: false };
      model.uploads.set(p.snapshotId, upload);
      const known = upload.ids.get(p.chunkIndex);
      if (known && known !== message.messageId) {
        return { response: { protocolVersion: 1, correlationId: message.messageId, ok: false, error: { code: 'conflict', retryable: false, message: 'reminted' }, payload: {} } };
      }
      upload.ids.set(p.chunkIndex, message.messageId);
      upload.chunks.set(p.chunkIndex, Buffer.from(p.bytesBase64, 'base64'));
      let cursor = 0;
      while (upload.chunks.has(cursor)) cursor += 1;
      if (cursor === upload.count && model.failCompletions > 0) {
        // Every chunk is durable but the snapshot file could not be written (PR 2's
        // "snapshot directory not writable" case): only the chunk ACK is true.
        model.failCompletions -= 1;
        return reply(message, { ackKind: 'chunk', snapshotId: p.snapshotId, chunkIndex: p.chunkIndex, chunkCursor: cursor });
      }
      if (cursor === upload.count) {
        upload.complete = true;
        if (model.dropCompleteAcks > 0) {
          model.dropCompleteAcks -= 1;
          return closed();
        }
        return reply(message, { ackKind: 'snapshot', snapshotId: p.snapshotId, chunkIndex: p.chunkIndex, chunkCursor: cursor });
      }
      return reply(message, { ackKind: 'chunk', snapshotId: p.snapshotId, chunkIndex: p.chunkIndex, chunkCursor: cursor });
    }
    return closed();
  };
  model.bytesOf = snapshotId => {
    const upload = model.uploads.get(snapshotId);
    return Buffer.concat([...upload.chunks.keys()].sort((a, b) => a - b).map(key => upload.chunks.get(key)));
  };
  return model;
}

/** One service-worker lifetime over persistent storage. Build another to simulate a restart. */
async function worker({ storage, kv, model, clock = { value: Date.parse('2026-09-12T08:00:00.000Z') } }) {
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
  const prefix = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const uuid = () => `${prefix}-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date(clock.value);
  const store = createStore({ storage, uuid });
  const sent = [];
  const sendNative = async (host, message) => {
    sent.push(message);
    return model.answer(message);
  };
  const deps = { store, sendNative, sleep: async () => {}, uuid, now };
  const staging = createStaging({ kv, now, uuid });
  const uploads = createUploads({ ...deps, staging });
  const session = createSession(deps);
  const outbox = createOutbox({ ...deps, uploads });
  const reconcile = createReconcile({ ...deps, outbox });
  const drain = createDrain({ session, outbox, reconcile, alarms: { async create() {}, async clear() { return true; } }, now });
  const fillRecords = createFillRecords(deps);
  const router = createRouter({
    session, intents: createIntents(deps), outbox, drain, reconcile, fillRecords, store, uploads,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });
  return { router, drain, uploads, staging, sent, clock };
}

const PAIRED = () => fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } });

async function snapshotSha(tpl) {
  const { buildSnapshot } = await import('../link/snapshot.mjs');
  return (await buildSnapshot(tpl, { now: () => new Date('2026-09-12T08:00:00.000Z') })).sha256;
}

// --- recording with a snapshot --------------------------------------------------------

test('a recorded fill with a snapshot stages the bytes before anything else', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop({ online: false });
  const { router } = await worker({ storage, kv, model });

  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template() });
  assert.equal(result.status, 'recorded');
  const [record] = storage.data.desktopFillRecords;
  assert.equal(record.snapshot.staging, 'idb');
  assert.equal(record.snapshot.chunkCount, 3);
  assert.equal(kv.map.size, 1);
  assert.equal(kv.map.get(record.snapshot.snapshotId).sha256, record.snapshot.sha256);
  // Metadata only in chrome.storage.local; the bytes are in IndexedDB alone.
  assert.equal(JSON.stringify(storage.data).includes('项目1'), false);
});

test('a staging failure keeps the fill record and says why there is no snapshot', async () => {
  for (const [kv, tpl, issue] of [
    [fakeKv({ failPut: true }), template(), 'staging_unavailable'],
    [fakeKv(), { name: 'huge', groups: [{ name: 'g', fields: [{ key: 'k', value: 'x'.repeat(2 * 1024 * 1024 + 10) }] }] }, 'too_large']
  ]) {
    const storage = PAIRED();
    const { router } = await worker({ storage, kv, model: desktop({ online: false }) });
    const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: tpl });
    assert.equal(result.status, 'recorded', issue);
    assert.equal(result.snapshotIssue, issue);
    assert.equal(storage.data.desktopFillRecords[0].snapshot, null);
  }
});

test('a record kept without a snapshot stages nothing', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const { router } = await worker({ storage, kv, model: desktop({ online: false }) });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });
  assert.equal(kv.map.size, 0);
  assert.equal(storage.data.desktopFillRecords[0].snapshot, null);
});

test('a profile that never paired stages nothing either', async () => {
  const kv = fakeKv();
  // No pairing on record and no desktop answering: the never-paired mode.
  const { router } = await worker({ storage: fakeStorage(), kv, model: desktop({ online: false }) });
  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template() });
  assert.equal(result.status, 'not_recorded');
  assert.equal(kv.map.size, 0);
});

// --- uploading ------------------------------------------------------------------------

test('binding uploads the original bytes chunk by chunk after the fill event', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  const { router, drain, sent } = await worker({ storage, kv, model });

  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  assert.equal(result.status, 'saved');
  await drain.run();

  const fill = model.events[0];
  const snapshotId = fill.payload.snapshotId;
  assert.match(snapshotId, /^[0-9a-f-]{36}$/);
  assert.equal(fill.payload.sha256, await snapshotSha(template()));
  const firstChunk = sent.findIndex(message => message.messageType === 'snapshot.chunk');
  const fillAt = sent.findIndex(message => message.messageType === 'fill.submit');
  assert.ok(fillAt < firstChunk, 'the event goes first, the chunks after it');

  assert.equal(model.uploads.get(snapshotId).complete, true);
  assert.equal((await import('node:crypto')).createHash('sha256').update(model.bytesOf(snapshotId)).digest('hex'), fill.payload.sha256);
  // Complete ACK: the IndexedDB copy and the queue entry are both gone.
  assert.equal(kv.map.size, 0);
  assert.deepEqual(storage.data.desktopOutbox, []);
});

test('every chunk has its own id, none shared with the fill event', async () => {
  const storage = PAIRED();
  const model = desktop();
  const { router, drain } = await worker({ storage, kv: fakeKv(), model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  await drain.run();
  const ids = model.chunkMessages.map(message => message.messageId);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids.includes(model.events[0].messageId), false);
});

test('every chunk envelope passes the vendored validator', async () => {
  const { validateRequest } = await import('../link/protocol/validate.mjs');
  const storage = PAIRED();
  const model = desktop();
  const { router, drain } = await worker({ storage, kv: fakeKv(), model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  await drain.run();
  for (const message of model.chunkMessages) await validateRequest(message);
});

test('walkthrough 10.14: a restart mid-upload resumes with the same ids and the same bytes', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  let first = await worker({ storage, kv, model });
  await first.router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template('第一版') });
  const queued = storage.data.desktopOutbox.find(item => item.messageType === 'snapshot.upload');
  assert.ok(queued.chunkCount >= 3, `the scenario needs a third chunk to interrupt (got ${queued.chunkCount})`);

  // The desktop answers two chunks, then disappears.
  const answer = model.answer;
  let chunks = 0;
  model.answer = message => {
    if (message.messageType === 'snapshot.chunk' && ++chunks > 2) return closed();
    return answer(message);
  };
  await first.drain.run();
  const [entry] = storage.data.desktopOutbox;
  assert.equal(entry.chunkCursor, 2);
  const idOfChunk2 = entry.chunks[2].chunkMessageId;
  const triedBefore = first.sent.filter(message => message.messageType === 'snapshot.chunk' && message.payload.chunkIndex === 2);
  assert.ok(triedBefore.length >= 1 && triedBefore.every(message => message.messageId === idOfChunk2));

  // The worker is evicted (all memory gone) and the user edits the template meanwhile.
  model.answer = answer;
  first = null;
  const second = await worker({ storage, kv, model, clock: { value: Date.parse('2026-09-12T08:05:00.000Z') } });
  await second.uploads.repair();
  await second.drain.run();

  const sentAfter = second.sent.filter(message => message.messageType === 'snapshot.chunk' && message.payload.chunkIndex === 2);
  assert.ok(sentAfter.length >= 1, 'chunk 2 was sent again after the restart');
  assert.ok(sentAfter.every(message => message.messageId === idOfChunk2), 'the resumed chunk was not re-minted');
  assert.equal(second.sent.some(message => message.messageType === 'snapshot.chunk' && message.payload.chunkIndex < 2), false,
    'chunks the desktop already acknowledged were not sent again');
  const snapshotId = model.events[0].payload.snapshotId;
  assert.equal(model.uploads.get(snapshotId).complete, true);
  const digest = (await import('node:crypto')).createHash('sha256').update(model.bytesOf(snapshotId)).digest('hex');
  assert.equal(digest, await snapshotSha(template('第一版')), 'the v1 bytes arrived, not v2');
  assert.equal(kv.map.size, 0);
});

test('walkthrough 10.10: confirmed offline, template changed, uploaded later as the original', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop({ online: false });
  const { router, drain } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template('第一版') });
  const [record] = storage.data.desktopFillRecords;

  model.online = true;
  const bound = await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  assert.equal(bound.status, 'saved');
  await drain.run();
  const digest = (await import('node:crypto')).createHash('sha256').update(model.bytesOf(record.snapshot.snapshotId)).digest('hex');
  assert.equal(digest, await snapshotSha(template('第一版')));
});

test('a lost complete ACK keeps the copy until a resend is answered with one', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  // Two: the transport retries a failed send once on its own, so one lost reply is not enough
  // to reach the queue.
  const model = desktop({ dropCompleteAcks: 2 });
  const { router, drain, clock } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });

  kv.onDelete = async () => {
    // Deleting the staged bytes is only allowed once the entry says the desktop has it all.
    assert.equal(storage.data.desktopOutbox[0].status, 'completed');
  };
  await drain.run();
  assert.equal(kv.map.size, 1, 'no complete ACK arrived, so the copy stays');
  assert.equal(storage.data.desktopOutbox.length, 1);

  clock.value += 10 * 60 * 1000;
  await drain.run();
  assert.equal(kv.map.size, 0);
  assert.deepEqual(storage.data.desktopOutbox, []);
  const lastChunks = model.chunkMessages.filter(message => message.payload.chunkIndex === 2);
  assert.equal(lastChunks.length, 3, 'two lost answers, then the resend that got one');
  assert.equal(new Set(lastChunks.map(message => message.messageId)).size, 1, 'always under its own id');
});

test('a chunk ACK that skips ahead does not move the cursor past a gap', async () => {
  const { applyChunkAck } = await import('../link/uploads.mjs');
  const entry = {
    chunkCount: 3, chunkCursor: 0,
    chunks: [0, 1, 2].map(chunkIndex => ({ chunkIndex, chunkMessageId: `c${chunkIndex}`, chunkSha256: 'x', acked: false }))
  };
  const afterTwo = applyChunkAck(entry, 2, 0);
  assert.equal(afterTwo.chunkCursor, 0);
  const afterZero = applyChunkAck(afterTwo, 0, 1);
  assert.equal(afterZero.chunkCursor, 1);
  // The desktop is the durable truth: a cursor behind what we believed means resend from it.
  const believed = applyChunkAck(applyChunkAck(entry, 0, 1), 1, 2);
  assert.equal(applyChunkAck(believed, 2, 1).chunkCursor, 1);
});

test('a crash between writing the chunk ids and queueing the upload is repaired with those ids', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  const { router, drain } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  // Lose the queued upload as if the worker died right after the IndexedDB write.
  storage.data.desktopOutbox = storage.data.desktopOutbox.filter(entry => entry.messageType !== 'snapshot.upload');
  const staged = [...kv.map.values()][0];
  const mintedIds = staged.chunks.map(chunk => chunk.chunkMessageId);
  assert.ok(mintedIds.every(Boolean));

  const again = await worker({ storage, kv, model });
  await again.uploads.repair();
  await again.drain.run();
  assert.deepEqual(model.chunkMessages.map(message => message.messageId), mintedIds);
  void drain;
});

test('an upload whose bytes vanished stops and says so instead of regenerating them', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop({ online: false });
  const { router, uploads, drain } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template() });
  const [record] = storage.data.desktopFillRecords;
  model.online = true;
  await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  kv.map.clear(); // the user cleared site data, or IndexedDB was evicted
  await uploads.repair();
  await drain.run();
  const entry = storage.data.desktopOutbox.find(item => item.messageType === 'snapshot.upload');
  assert.equal(entry.status, 'bytes_lost');
  assert.equal(model.chunkMessages.length, 0);
});

test('cancelling the queued fill drops its snapshot too and hands the record back', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  model.answer = (answer => message => (message.messageType === 'handshake' ? answer(message) : closed()))(model.answer);
  const { router } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  const fill = storage.data.desktopOutbox.find(entry => entry.messageType === 'fill.submit');
  await router.handle({ type: 'DESKTOP_CANCEL', messageId: fill.messageId });
  assert.deepEqual(storage.data.desktopOutbox, []);
  assert.equal(kv.map.size, 0);
  const [record] = storage.data.desktopFillRecords;
  assert.equal(record.status, 'pending_bind');
  assert.equal(record.snapshot, null);
});

test('deleting a waiting record deletes its staged snapshot', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const { router } = await worker({ storage, kv, model: desktop({ online: false }) });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template() });
  const [record] = storage.data.desktopFillRecords;
  await router.handle({ type: 'DESKTOP_REMOVE_FILL', recordId: record.recordId });
  assert.equal(kv.map.size, 0);
});

test('a snapshot older than thirty days is listed for the user and never deleted for age', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const { router, uploads, clock } = await worker({ storage, kv, model: desktop({ online: false }) });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template() });
  const snapshotId = storage.data.desktopFillRecords[0].snapshot.snapshotId;

  clock.value += 29 * DAY;
  assert.deepEqual((await router.handle({ type: 'DESKTOP_LIST_QUEUE' })).expiredSnapshots, []);
  clock.value += 2 * DAY;
  assert.deepEqual((await router.handle({ type: 'DESKTOP_LIST_QUEUE' })).expiredSnapshots, [snapshotId]);
  await uploads.repair();
  assert.equal(kv.map.size, 1, 'repair never removes a snapshot the user was not asked about');

  await router.handle({ type: 'DESKTOP_DROP_SNAPSHOT', snapshotId });
  assert.equal(kv.map.size, 0);
  assert.equal(storage.data.desktopFillRecords[0].snapshot, null, 'the fill itself is kept');
});

test('a staged snapshot nobody references is cleaned up once it is clearly abandoned', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const { uploads, staging, clock } = await worker({ storage, kv, model: desktop({ online: false }) });
  const { buildSnapshot, planChunks } = await import('../link/snapshot.mjs');
  const built = await buildSnapshot(template());
  built.chunks = await planChunks(built.bytes);
  await staging.stage(built); // staged, then the worker died before the record was written
  await uploads.repair();
  assert.equal(kv.map.size, 1, 'too recent: a record may still be on its way');
  clock.value += 2 * 60 * 60 * 1000;
  await uploads.repair();
  assert.equal(kv.map.size, 0);
});

test('every chunk acknowledged but no complete ACK: the last chunk is resent to finish it', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop({ failCompletions: 1 });
  const { router, drain } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  await drain.run();
  const snapshotId = model.events[0].payload.snapshotId;
  assert.equal(model.uploads.get(snapshotId).complete, true);
  const last = model.uploads.get(snapshotId).count - 1;
  assert.equal(model.chunkMessages.filter(message => message.payload.chunkIndex === last).length, 2);
  assert.equal(kv.map.size, 0);
  assert.deepEqual(storage.data.desktopOutbox, []);
});

// --- review follow-ups ----------------------------------------------------------------

// A desktop that takes the fill event but drops every chunk: the upload stays queued.
function chunksNeverArrive(model) {
  const answer = model.answer;
  model.answer = message => (message.messageType === 'snapshot.chunk' ? closed() : answer(message));
  return () => { model.answer = answer; };
}

test('a snapshot the user gave up on is never sent, even when deleting the copy failed', async () => {
  for (const how of ['drop', 'cancel']) {
    const storage = PAIRED();
    const kv = fakeKv();
    const model = desktop();
    const restore = chunksNeverArrive(model);
    const { router } = await worker({ storage, kv, model });
    await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
    const upload = storage.data.desktopOutbox.find(entry => entry.messageType === 'snapshot.upload');
    assert.ok(upload, how);

    kv.onDelete = async () => { throw Object.assign(new Error('transient'), { name: 'UnknownError' }); };
    if (how === 'drop') await router.handle({ type: 'DESKTOP_DROP_SNAPSHOT', snapshotId: upload.snapshotId });
    else await router.handle({ type: 'DESKTOP_CANCEL', messageId: upload.messageId });
    assert.equal(kv.map.size, 1, `${how}: the copy is still there`);

    // Next worker start: the binding is still in IndexedDB, but the user's decision stands.
    kv.onDelete = null;
    restore();
    const again = await worker({ storage, kv, model });
    await again.uploads.repair();
    await again.drain.run();
    assert.equal(model.chunkMessages.length, 0, `${how}: nothing was sent`);
    assert.equal(kv.map.size, 0, `${how}: the copy is gone now`);
    assert.equal(storage.data.desktopOutbox.some(entry => entry.messageType === 'snapshot.upload'), false, how);
  }
});

test('a bind refused for a full queue leaves no binding for repair to send', async () => {
  const { MAX_OUTBOX } = await import('../link/limits.mjs');
  const filler = Array.from({ length: MAX_OUTBOX }, (_, i) => ({
    messageId: `filler-${i}`, messageType: 'job.save', payload: {}, status: 'stalled', nextAttemptAt: null, attempts: 9
  }));
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop({ online: false });
  const { router } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template() });
  const [record] = storage.data.desktopFillRecords;
  storage.data.desktopOutbox = filler;
  model.online = true;

  const result = await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  assert.equal(result.status, 'rejected');
  assert.equal([...kv.map.values()][0].binding, null);

  storage.data.desktopOutbox = [];
  const again = await worker({ storage, kv, model });
  await again.uploads.repair();
  await again.drain.run();
  assert.equal(model.chunkMessages.length, 0);
  assert.equal(storage.data.desktopFillRecords[0].status, 'pending_bind');
  assert.ok(storage.data.desktopFillRecords[0].snapshot, 'the snapshot is still there to bind later');
});

test('the snapshot waits until its fill event has been accepted', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  const answer = model.answer;
  let refuseEvents = true;
  model.answer = message => (message.messageType === 'fill.submit' && refuseEvents ? closed() : answer(message));
  const { router, drain, sent, clock } = await worker({ storage, kv, model });

  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  await drain.run();
  assert.equal(model.chunkMessages.length, 0, 'no chunk while the event is backing off');

  refuseEvents = false;
  clock.value += 60 * 60 * 1000;
  await drain.run();
  await drain.run();
  const fillAt = sent.findIndex(message => message.messageType === 'fill.submit' && model.events.includes(message));
  const firstChunk = sent.findIndex(message => message.messageType === 'snapshot.chunk');
  assert.ok(fillAt >= 0 && firstChunk > fillAt, 'the accepted event comes before any chunk');
  assert.equal(kv.map.size, 0, 'and the snapshot then completes');
});

test('an upload held behind a failed fill event does not keep the desktop awake', async () => {
  const { waitsForFill } = await import('../link/drain.mjs');
  const fill = { messageId: 'f', messageType: 'fill.submit', recordId: 'r1', status: 'failed' };
  const upload = { messageId: 's', messageType: 'snapshot.upload', recordId: 'r1', status: 'pending', nextAttemptAt: '2026-09-12T08:00:00.000Z' };
  assert.equal(waitsForFill(upload, [fill, upload]), true);
  assert.equal(waitsForFill(upload, [upload]), false);
  assert.equal(waitsForFill(fill, [fill, upload]), false);

  const { createDrain } = await import('../link/drain.mjs');
  let probes = 0;
  const alarms = [];
  const drain = createDrain({
    session: { async probe() { probes += 1; return { mode: 'unavailable' }; } },
    outbox: { async list() { return [fill, upload]; } },
    alarms: { async create(name, info) { alarms.push(info); }, async clear() { return true; } },
    now: () => new Date('2026-09-12T09:00:00.000Z')
  });
  const result = await drain.run();
  assert.equal(result.mode, 'idle');
  assert.equal(probes, 0, 'nothing it can send, so no host start');
  assert.equal(alarms.length, 0);
});

// --- review follow-ups, second round ---------------------------------------------------

// The worker died after prepare() wrote the binding and before fill.submit was queued.
async function interruptedBind() {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  const restore = chunksNeverArrive(model);
  const answer = model.answer;
  model.answer = message => (message.messageType === 'fill.submit' ? closed() : answer(message));
  const { router, clock } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  storage.data.desktopOutbox = [];
  model.answer = answer;
  restore();
  return { storage, kv, model, clock };
}

test('a bind cut off before its event was queued is handed back, never sent as a bare snapshot', async () => {
  const { storage, kv, model, clock } = await interruptedBind();
  clock.value += 10 * 60 * 1000;
  const again = await worker({ storage, kv, model, clock });
  await again.uploads.repair();
  await again.drain.run();
  assert.equal(model.chunkMessages.length, 0);
  assert.equal(storage.data.desktopFillRecords[0].status, 'pending_bind');
  assert.ok(storage.data.desktopFillRecords[0].snapshot, 'the snapshot is kept for the next bind');
  assert.equal([...kv.map.values()][0].binding, null);
});

test('a bind still in progress is not mistaken for an interrupted one', async () => {
  const { storage, kv, model, clock } = await interruptedBind();
  const again = await worker({ storage, kv, model, clock });
  await again.uploads.repair();
  assert.equal(storage.data.desktopFillRecords[0].status, 'bound');
  assert.ok([...kv.map.values()][0].binding, 'left alone');
  assert.equal(storage.data.desktopOutbox.length, 0, 'and not rebuilt into an upload either');
});

test('a fill with a snapshot needs two free places in the queue, or it is not bound at all', async () => {
  const { MAX_OUTBOX } = await import('../link/limits.mjs');
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop({ online: false });
  const { router } = await worker({ storage, kv, model });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: template() });
  const [record] = storage.data.desktopFillRecords;
  storage.data.desktopOutbox = Array.from({ length: MAX_OUTBOX - 1 }, (_, i) => ({
    messageId: `filler-${i}`, messageType: 'job.save', payload: {}, status: 'stalled', nextAttemptAt: null, attempts: 9
  }));
  model.online = true;
  const result = await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'queue_full');
  assert.equal(storage.data.desktopOutbox.length, MAX_OUTBOX - 1);
  assert.equal(storage.data.desktopFillRecords[0].status, 'pending_bind');
  assert.equal([...kv.map.values()][0].binding, null);
});

test('a completed upload whose copy still cannot be deleted keeps its entry until it can', async () => {
  const storage = PAIRED();
  const kv = fakeKv();
  const model = desktop();
  const { router, drain } = await worker({ storage, kv, model });
  kv.onDelete = async () => { throw new Error('transient'); };
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION, snapshotTemplate: template() });
  await drain.run();
  assert.equal(storage.data.desktopOutbox[0].status, 'completed');

  const again = await worker({ storage, kv, model });
  await again.uploads.repair();
  assert.equal(storage.data.desktopOutbox.length, 1, 'still there: the copy is');
  kv.onDelete = null;
  const sentBefore = model.chunkMessages.length;
  const third = await worker({ storage, kv, model });
  await third.uploads.repair();
  await third.drain.run();
  assert.equal(model.chunkMessages.length, sentBefore, 'nothing resent');
  assert.equal(storage.data.desktopOutbox.length, 0);
  assert.equal(kv.map.size, 0);
});
