const test = require('node:test');
const assert = require('node:assert/strict');

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

const FIELDS = {
  company: '星河科技',
  title: '后端开发',
  location: '上海',
  sourceUrl: 'https://jobs.example.com/apply',
  dedupeUrl: 'https://jobs.example.com/apply'
};

async function makeIntents({ storage = fakeStorage(), clock = { value: 1000 } } = {}) {
  const { createStore } = await import('../link/store.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  let minted = 0;
  const store = createStore({ storage, uuid: () => 'client-1' });
  const intents = createIntents({
    store,
    uuid: () => `intent-${++minted}`,
    now: () => new Date(clock.value)
  });
  return { intents, store, storage, clock };
}

test('a save while the desktop is closed is queued as a pending intent', async () => {
  const { intents, storage } = await makeIntents();

  const result = await intents.save({ fields: FIELDS, mode: 'unavailable' });

  assert.equal(result.status, 'queued');
  assert.equal(result.intent.status, 'pending_desktop');
  assert.equal(storage.data.desktopSaveIntents.length, 1);
});

test('a queued intent has no message id, application id or epoch', async () => {
  const { intents } = await makeIntents();

  const { intent } = await intents.save({ fields: FIELDS, mode: 'unavailable' });

  // §8.10 freezes this: an intent is not a message. Any of these fields would mean the
  // plugin had already committed to an archive it never spoke to.
  assert.equal('messageId' in intent, false);
  assert.equal('applicationId' in intent, false);
  assert.equal('restoreEpoch' in intent, false);
  assert.equal('sourceRestoreEpoch' in intent, false);
});

test('a profile that never paired queues nothing', async () => {
  const { intents, storage } = await makeIntents();

  const result = await intents.save({ fields: FIELDS, mode: 'never_paired' });

  assert.equal(result.status, 'not_queued');
  assert.equal(result.reason, 'never_paired');
  assert.equal('desktopSaveIntents' in storage.data, false);
});

test('an extension with no host registration queues nothing', async () => {
  const { intents, storage } = await makeIntents();

  const result = await intents.save({ fields: FIELDS, mode: 'not_installed' });

  assert.equal(result.status, 'not_queued');
  assert.equal('desktopSaveIntents' in storage.data, false);
});

test('an installed but unpaired desktop queues nothing and says so', async () => {
  const { intents, storage } = await makeIntents();

  const result = await intents.save({ fields: FIELDS, mode: 'not_paired' });

  assert.equal(result.status, 'not_queued');
  assert.equal(result.reason, 'not_paired');
  assert.equal('desktopSaveIntents' in storage.data, false);
});

test('an incompatible desktop still keeps the intent', async () => {
  const { intents } = await makeIntents();
  // §5.2.3: the intent is kept and the user is asked to upgrade. It is simply never promoted
  // into a bound message.
  const result = await intents.save({ fields: FIELDS, mode: 'incompatible' });

  assert.equal(result.status, 'queued');
  assert.equal(result.intent.status, 'pending_desktop');
});

test('a reachable desktop queues the intent ready for binding', async () => {
  const { intents } = await makeIntents();

  const result = await intents.save({ fields: FIELDS, mode: 'ready' });

  assert.equal(result.status, 'queued');
  assert.equal(result.intent.status, 'pending_bind');
});

test('a second click on the same posting does not queue a second intent', async () => {
  const { intents, storage } = await makeIntents();

  await intents.save({ fields: FIELDS, mode: 'unavailable' });
  const second = await intents.save({ fields: FIELDS, mode: 'unavailable' });

  assert.equal(second.status, 'duplicate');
  assert.equal(storage.data.desktopSaveIntents.length, 1);
});

test('a differently spelled company is still the same posting', async () => {
  const { intents, storage } = await makeIntents();

  await intents.save({ fields: FIELDS, mode: 'unavailable' });
  const second = await intents.save({
    fields: { ...FIELDS, company: '星河科技有限公司', title: ' 后端开发 ' },
    mode: 'unavailable'
  });

  assert.equal(second.status, 'duplicate');
  assert.equal(storage.data.desktopSaveIntents.length, 1);
});

test('the user can deliberately save the same posting again', async () => {
  const { intents, storage } = await makeIntents();
  // Walkthrough 10.4: applying to the same posting a second time is two applications when
  // the user says so.
  await intents.save({ fields: FIELDS, mode: 'unavailable' });
  const again = await intents.save({ fields: FIELDS, mode: 'unavailable', force: true });

  assert.equal(again.status, 'queued');
  assert.equal(storage.data.desktopSaveIntents.length, 2);
  assert.notEqual(storage.data.desktopSaveIntents[0].intentId, storage.data.desktopSaveIntents[1].intentId);
});

test('a different posting at the same company queues separately', async () => {
  const { intents, storage } = await makeIntents();

  await intents.save({ fields: FIELDS, mode: 'unavailable' });
  const other = await intents.save({ fields: { ...FIELDS, title: '测试开发' }, mode: 'unavailable' });

  assert.equal(other.status, 'queued');
  assert.equal(storage.data.desktopSaveIntents.length, 2);
});

test('a full queue refuses new work instead of dropping old work', async () => {
  const { intents, storage } = await makeIntents();
  const { MAX_INTENTS } = await import('../link/limits.mjs');

  for (let i = 0; i < MAX_INTENTS; i += 1) {
    await intents.save({ fields: { ...FIELDS, title: `岗位 ${i}` }, mode: 'unavailable' });
  }
  const overflow = await intents.save({ fields: { ...FIELDS, title: '再来一个' }, mode: 'unavailable' });

  assert.equal(overflow.status, 'rejected');
  assert.equal(overflow.reason, 'queue_full');
  assert.equal(storage.data.desktopSaveIntents.length, MAX_INTENTS);
  assert.equal(storage.data.desktopSaveIntents[0].fields.title, '岗位 0', 'the oldest intent is still there');
});

test('a save with no company or no title is refused before it reaches the queue', async () => {
  const { intents } = await makeIntents();

  const noCompany = await intents.save({ fields: { ...FIELDS, company: '  ' }, mode: 'unavailable' });
  const noTitle = await intents.save({ fields: { ...FIELDS, title: '' }, mode: 'unavailable' });

  assert.equal(noCompany.status, 'rejected');
  assert.equal(noCompany.reason, 'missing_fields');
  assert.equal(noTitle.status, 'rejected');
});

test('deleting an intent removes exactly that one', async () => {
  const { intents, storage } = await makeIntents();
  const first = await intents.save({ fields: FIELDS, mode: 'unavailable' });
  await intents.save({ fields: { ...FIELDS, title: '测试开发' }, mode: 'unavailable' });

  await intents.remove(first.intent.intentId);

  assert.equal(storage.data.desktopSaveIntents.length, 1);
  assert.equal(storage.data.desktopSaveIntents[0].fields.title, '测试开发');
});

test('the last successful handshake is recorded on the intent as a hint only', async () => {
  const storage = fakeStorage({ desktopPairing: { archiveId: 'aaaa', restoreEpoch: 'bbbb', at: 1 } });
  const { intents } = await makeIntents({ storage });

  const { intent } = await intents.save({ fields: FIELDS, mode: 'unavailable' });

  assert.equal(intent.lastSeenArchiveId, 'aaaa');
  assert.equal('lastSeenRestoreEpoch' in intent, false, 'an epoch on an intent would read as a stamp');
});

test('two clicks handled at the same time still produce one intent', async () => {
  const { intents, storage } = await makeIntents();
  // The service worker handles sidebar messages concurrently. Reading the queue, deciding it
  // holds no duplicate and appending have to be one step: as three separate steps both saves
  // read an empty queue, both decide they are new, and #20's "重复点击不重复建档" is broken by
  // nothing more than timing.
  const [first, second] = await Promise.all([
    intents.save({ fields: FIELDS, mode: 'unavailable' }),
    intents.save({ fields: FIELDS, mode: 'unavailable' })
  ]);

  assert.equal(storage.data.desktopSaveIntents.length, 1);
  assert.deepEqual([first.status, second.status].sort(), ['duplicate', 'queued']);
});

test('a race cannot push the queue past its limit', async () => {
  const { intents, storage } = await makeIntents();
  const { MAX_INTENTS } = await import('../link/limits.mjs');
  for (let i = 0; i < MAX_INTENTS - 1; i += 1) {
    await intents.save({ fields: { ...FIELDS, title: `岗位 ${i}` }, mode: 'unavailable' });
  }

  const results = await Promise.all([
    intents.save({ fields: { ...FIELDS, title: 'A' }, mode: 'unavailable' }),
    intents.save({ fields: { ...FIELDS, title: 'B' }, mode: 'unavailable' }),
    intents.save({ fields: { ...FIELDS, title: 'C' }, mode: 'unavailable' })
  ]);

  assert.equal(storage.data.desktopSaveIntents.length, MAX_INTENTS);
  assert.equal(results.filter(result => result.status === 'rejected').length, 2);
});
