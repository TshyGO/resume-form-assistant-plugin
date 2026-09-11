const test = require('node:test');
const assert = require('node:assert/strict');

// A Map standing in for the extension-origin IndexedDB object store. Values are cloned on the
// way in and out, the way structured clone does for IDB, so a test cannot pass by holding a
// reference the real store would never hand back.
function fakeKv({ failPut = false, corrupt = false } = {}) {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) {
      if (failPut) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
      const copy = structuredClone(value);
      if (corrupt && copy.bytes) new Uint8Array(copy.bytes)[0] ^= 0xff;
      map.set(key, copy);
    },
    async delete(key) { map.delete(key); },
    async list() { return [...map.values()].map(value => structuredClone(value)); }
  };
}

const DAY = 24 * 60 * 60 * 1000;

async function snapshotOf(size, fill = 1) {
  const { planChunks, sha256Hex } = await import('../link/snapshot.mjs');
  const bytes = new Uint8Array(size).fill(fill);
  return {
    bytes,
    sha256: await sha256Hex(bytes),
    byteSize: size,
    templateName: '默认模板',
    templateVersion: 'abcdef012345',
    omittedFieldCount: 0,
    chunks: await planChunks(bytes)
  };
}

async function makeStaging(kv = fakeKv(), clock = { value: Date.parse('2026-09-12T08:00:00.000Z') }) {
  const { createStaging } = await import('../link/staging.mjs');
  let minted = 0;
  const staging = createStaging({
    kv,
    now: () => new Date(clock.value),
    uuid: () => `66666666-6666-4666-8666-${String(++minted).padStart(12, '0')}`
  });
  return { staging, kv, clock };
}

test('staged bytes come back exactly, chunk by chunk', async () => {
  const { staging } = await makeStaging();
  const snapshot = await snapshotOf(70000, 7);
  const result = await staging.stage(snapshot);
  assert.equal(result.status, 'staged');
  const { record } = result;
  assert.equal(record.chunkCount, 3);
  assert.equal(record.sha256, snapshot.sha256);
  assert.equal(record.binding, null);
  assert.deepEqual(record.chunks.map(chunk => chunk.chunkMessageId), [null, null, null]);

  const pieces = [];
  for (let index = 0; index < record.chunkCount; index += 1) {
    pieces.push(Buffer.from(await staging.readChunk(record.snapshotId, index)));
  }
  assert.deepEqual(Buffer.concat(pieces), Buffer.from(snapshot.bytes));
});

test('the staged record keeps only metadata the queue needs, plus the bytes', async () => {
  const { staging } = await makeStaging();
  const { record } = await staging.stage(await snapshotOf(10));
  assert.deepEqual(Object.keys(record).sort(), [
    'binding', 'byteSize', 'bytes', 'chunkCount', 'chunks', 'createdAt', 'sha256',
    'snapshotId', 'templateName', 'templateVersion'
  ]);
  assert.equal(record.createdAt, '2026-09-12T08:00:00.000Z');
});

test('the twenty-first snapshot is refused and the first twenty are untouched', async () => {
  const { staging, kv } = await makeStaging();
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await staging.stage(await snapshotOf(10, i))).status, 'staged');
  }
  const before = [...kv.map.keys()];
  const refused = await staging.stage(await snapshotOf(10, 99));
  assert.deepEqual(refused, { status: 'full', reason: 'count' });
  assert.deepEqual([...kv.map.keys()], before);
});

test('staging stops at 20 MiB in total rather than evicting older snapshots', async () => {
  const { staging, kv } = await makeStaging();
  const big = await snapshotOf(2 * 1024 * 1024 - 1);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await staging.stage(big)).status, 'staged', `snapshot ${i}`);
  }
  const refused = await staging.stage(await snapshotOf(64));
  assert.deepEqual(refused, { status: 'full', reason: 'bytes' });
  assert.equal(kv.map.size, 10);
  const usage = await staging.usage();
  assert.equal(usage.count, 10);
  assert.equal(usage.bytes, 10 * (2 * 1024 * 1024 - 1));
});

test('a store that refuses the write is reported as unavailable, never thrown', async () => {
  const { staging } = await makeStaging(fakeKv({ failPut: true }));
  const result = await staging.stage(await snapshotOf(10));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'QuotaExceededError');
});

test('bytes that do not read back identically are not claimed as staged', async () => {
  const { staging, kv } = await makeStaging(fakeKv({ corrupt: true }));
  const result = await staging.stage(await snapshotOf(10));
  assert.deepEqual(result, { status: 'unavailable', reason: 'readback_mismatch' });
  assert.equal(kv.map.size, 0, 'the unverifiable copy is removed again');
});

test('a store that cannot even be listed is unavailable too', async () => {
  const kv = fakeKv();
  kv.list = async () => { throw new Error('InvalidStateError'); };
  const { staging } = await makeStaging(kv);
  assert.equal((await staging.stage(await snapshotOf(10))).status, 'unavailable');
});

test('update changes a record in place and remove deletes it', async () => {
  const { staging } = await makeStaging();
  const { record } = await staging.stage(await snapshotOf(10));
  await staging.update(record.snapshotId, current => ({ ...current, binding: { applicationId: 'app-1' } }));
  assert.deepEqual((await staging.get(record.snapshotId)).binding, { applicationId: 'app-1' });
  await staging.remove(record.snapshotId);
  assert.equal(await staging.get(record.snapshotId), null);
  assert.equal(await staging.readChunk(record.snapshotId, 0), null);
});

test('a snapshot is expired after thirty days, never before', async () => {
  const { staging, clock } = await makeStaging();
  const { record } = await staging.stage(await snapshotOf(10));
  clock.value += 29 * DAY;
  assert.equal(staging.isExpired(record), false);
  clock.value += 2 * DAY;
  assert.equal(staging.isExpired(record), true);
  assert.ok(await staging.get(record.snapshotId), 'expiry never deletes on its own');
});
