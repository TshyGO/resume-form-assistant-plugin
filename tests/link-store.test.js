const test = require('node:test');
const assert = require('node:assert/strict');

// A stand-in for chrome.storage.local with the same async get/set shape. Writes are
// recorded so a test can prove which keys were touched.
function fakeStorage(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const name of names) {
        if (name in data) out[name] = data[name];
      }
      return out;
    },
    async set(values) {
      writes.push(values);
      Object.assign(data, values);
    }
  };
}

test('the client instance id is minted once and then reused', async () => {
  const { createStore } = await import('../link/store.mjs');
  const storage = fakeStorage();
  let minted = 0;
  const store = createStore({ storage, uuid: () => `id-${++minted}` });

  const first = await store.clientInstanceId();
  const second = await store.clientInstanceId();

  assert.equal(first, 'id-1');
  assert.equal(second, 'id-1');
  assert.equal(minted, 1);
});

test('a client instance id survives being read from storage by a fresh worker', async () => {
  const { createStore, KEYS } = await import('../link/store.mjs');
  const storage = fakeStorage({ [KEYS.clientInstanceId]: 'already-here' });
  const store = createStore({ storage, uuid: () => 'should-not-be-used' });

  assert.equal(await store.clientInstanceId(), 'already-here');
});

test('concurrent queue updates do not lose entries', async () => {
  const { createStore } = await import('../link/store.mjs');
  const storage = fakeStorage();
  const store = createStore({ storage, uuid: () => 'client' });

  // Two sidebar clicks can land in the same worker turn. A plain read-modify-write drops
  // one of them, and a dropped queue entry is a silently lost job the user was told was
  // pending.
  await Promise.all([
    store.updateIntents(list => [...list, { intentId: 'a' }]),
    store.updateIntents(list => [...list, { intentId: 'b' }])
  ]);

  const intents = await store.getIntents();
  assert.deepEqual(intents.map(item => item.intentId).sort(), ['a', 'b']);
});

test('the desktop link never writes a key the rest of the extension owns', async () => {
  const { createStore, KEYS, RESERVED_KEYS } = await import('../link/store.mjs');
  const storage = fakeStorage();
  const store = createStore({ storage, uuid: () => 'client' });

  await store.clientInstanceId();
  await store.updateIntents(list => [...list, { intentId: 'a' }]);
  await store.updateOutbox(list => [...list, { messageId: 'm' }]);
  await store.setPairing({ archiveId: 'a', restoreEpoch: 'b', at: 1 });

  const touched = storage.writes.flatMap(write => Object.keys(write));
  for (const key of touched) {
    assert.ok(
      Object.values(KEYS).includes(key),
      `${key} is not one of the four keys D01 allocated to the desktop link`
    );
    assert.equal(RESERVED_KEYS.includes(key), false, `${key} belongs to the existing plugin`);
  }
});

test('pairing is remembered as a hint with no authority to submit', async () => {
  const { createStore } = await import('../link/store.mjs');
  const storage = fakeStorage();
  const store = createStore({ storage, uuid: () => 'client' });

  await store.setPairing({ archiveId: 'a', restoreEpoch: 'b', appVersion: '0.1.0', at: 7 });
  const pairing = await store.getPairing();

  assert.equal(pairing.archiveId, 'a');
  assert.equal(await store.hasEverPaired(), true);
});

test('an extension that never reached the desktop reports no pairing', async () => {
  const { createStore } = await import('../link/store.mjs');
  const store = createStore({ storage: fakeStorage(), uuid: () => 'client' });

  assert.equal(await store.hasEverPaired(), false);
  assert.deepEqual(await store.getIntents(), []);
  assert.deepEqual(await store.getOutbox(), []);
});
