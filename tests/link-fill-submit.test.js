const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LATER_EPOCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPLICATION = '77777777-7777-4777-8777-777777777777';
const EVENT = '99999999-9999-4999-8999-999999999999';

const RAW = {
  outcome: 'partial',
  cancelled: false,
  fieldCount: 12,
  filledCount: 9,
  unconfirmedCount: 3,
  timing: { scanMs: 40, roundTripMs: 80, fillMs: 120, totalMs: 240 },
  urlRedacted: 'https://jobs.example.com/apply',
  templateName: '默认模板',
  templateVersion: '0123456789ab',
  pluginVersion: '0.4.0',
  job: { company: '星河科技', title: '后端开发', sourceUrl: 'https://jobs.example.com/apply' }
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

const PAIRED = () => fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } });

function handshake(message, epoch = EPOCH) {
  return {
    response: {
      protocolVersion: 2, correlationId: message.messageId, ok: true,
      payload: { appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 2, archiveId: ARCHIVE, restoreEpoch: epoch, capabilities: ['handshake', 'fill.submit'] }
    }
  };
}

const saved = message => ({
  response: { protocolVersion: 2, correlationId: message.messageId, ok: true, resultId: EVENT, payload: { resultKind: 'event' } }
});

const closed = () => ({ lastError: 'Error when communicating with the native messaging host.' });

/**
 * The whole worker side, wired the way link/worker.mjs wires it, over a scripted desktop.
 * `desktop(message)` answers every native message; tests switch it between phases.
 */
async function harness({ storage = PAIRED(), desktop = closed } = {}) {
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');
  const { createReconcile } = await import('../link/reconcile.mjs');
  const { createDrain } = await import('../link/drain.mjs');
  const { createFillRecords } = await import('../link/fillrecords.mjs');
  const { createRouter } = await import('../link/router.mjs');

  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date('2026-09-12T08:00:00.000Z');
  const store = createStore({ storage, uuid });
  const state = { desktop };
  const sent = [];
  const sendNative = async (host, message) => {
    sent.push(message);
    return state.desktop(message);
  };
  const deps = { store, sendNative, sleep: async () => {}, uuid, now };
  const session = createSession({ ...deps, getManifest: () => ({ version: '0.4.0' }) });
  const outbox = createOutbox(deps);
  const reconcile = createReconcile({ ...deps, outbox });
  const alarms = { async create() {}, async clear() { return true; } };
  const drain = createDrain({ session, outbox, reconcile, alarms, now });
  const fillRecords = createFillRecords(deps);
  const router = createRouter({
    session, intents: createIntents(deps), outbox, drain, reconcile, fillRecords, store,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });
  const writes = type => sent.filter(message => message.messageType === type);
  return { router, storage, sent, state, writes, outbox, reconcile, drain };
}

// A desktop that handshakes and saves every write.
const onlineDesktop = message => (message.messageType === 'handshake' ? handshake(message) : saved(message));

test('the sidebar learns whether to offer a fill record without waking the desktop', async () => {
  const paired = await harness();
  assert.deepEqual(await paired.router.handle({ type: 'DESKTOP_LINK_STATE' }), { everPaired: true });
  const fresh = await harness({ storage: fakeStorage() });
  assert.deepEqual(await fresh.router.handle({ type: 'DESKTOP_LINK_STATE' }), { everPaired: false });
  assert.equal(paired.sent.length + fresh.sent.length, 0, 'no native host was started to answer this');
});

test('a fill recorded against a chosen application becomes exactly one fill.submit', async () => {
  const { router, storage, writes } = await harness({ desktop: onlineDesktop });
  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION });

  assert.equal(result.status, 'saved');
  const [message] = writes('fill.submit');
  assert.equal(writes('fill.submit').length, 1);
  assert.equal(message.payload.applicationId, APPLICATION);
  assert.equal(message.payload.outcome, 'partial');
  assert.equal(message.payload.filledCount, 9);
  assert.equal(message.payload.unconfirmedCount, 3);
  assert.equal(message.payload.sourceRestoreEpoch, EPOCH);
  assert.match(message.payload.payloadSha256, /^[0-9a-f]{64}$/);
  // Nothing about the fill is left behind once the desktop has it.
  assert.deepEqual(storage.data.desktopFillRecords, []);
  assert.deepEqual(storage.data.desktopOutbox, []);
});

test('the envelope the plugin builds passes the vendored validator', async () => {
  const { validateRequest } = await import('../link/protocol/validate.mjs');
  const { router, writes } = await harness({ desktop: onlineDesktop });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION });
  await validateRequest(writes('fill.submit')[0]);
});

test('with the desktop closed the fill waits as a record, and nothing claims it was archived', async () => {
  const { router, storage, writes } = await harness();
  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });

  assert.equal(result.status, 'recorded');
  assert.equal(result.mode, 'unavailable');
  assert.equal(writes('fill.submit').length, 0);
  assert.equal(storage.data.desktopFillRecords.length, 1);
  assert.equal(storage.data.desktopFillRecords[0].status, 'pending_bind');
});

test('a profile that never paired keeps nothing', async () => {
  const { router, storage } = await harness({ storage: fakeStorage() });
  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });
  assert.equal(result.status, 'not_recorded');
  assert.equal('desktopFillRecords' in storage.data, false);
  assert.equal('desktopOutbox' in storage.data, false);
});

test('a waiting record is bound later from the pending list and sent once', async () => {
  const { router, storage, state, writes } = await harness();
  const { record } = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });

  state.desktop = onlineDesktop;
  const bound = await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  assert.equal(bound.status, 'saved');
  assert.equal(writes('fill.submit').length, 1);
  assert.deepEqual(storage.data.desktopFillRecords, []);
});

test('binding the same record twice queues it once', async () => {
  const { router, writes, storage } = await harness({ desktop: onlineDesktop });
  const { record } = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });

  const results = await Promise.all([
    router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION }),
    router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['duplicate', 'saved']);
  assert.equal(writes('fill.submit').length, 1, 'two clicks, one event');
  assert.deepEqual(storage.data.desktopOutbox, []);
  assert.deepEqual(storage.data.desktopFillRecords, []);
});

test('a record already sent cannot be bound again by a sidebar drawn before it went', async () => {
  const { router, writes } = await harness({ desktop: onlineDesktop });
  const { record } = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });
  await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  const again = await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  assert.equal(again.status, 'rejected');
  assert.equal(again.reason, 'unknown_record');
  assert.equal(writes('fill.submit').length, 1);
});

test('the same messageId is resent until the desktop answers, and the event is written once', async () => {
  const { router, state, storage, writes } = await harness({
    desktop: message => (message.messageType === 'handshake' ? handshake(message) : closed())
  });
  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION });
  assert.equal(result.status, 'pending');
  const [entry] = storage.data.desktopOutbox;
  assert.equal(entry.messageType, 'fill.submit');
  assert.equal(storage.data.desktopFillRecords[0].status, 'bound');

  state.desktop = onlineDesktop;
  const retried = await router.handle({ type: 'DESKTOP_RETRY', messageId: entry.messageId });
  assert.equal(retried.status, 'saved');
  const ids = writes('fill.submit').map(message => message.messageId);
  assert.deepEqual([...new Set(ids)], [entry.messageId], 'every attempt reused the one messageId');
  assert.deepEqual(storage.data.desktopOutbox, []);
  assert.deepEqual(storage.data.desktopFillRecords, []);
});

test('cancelling a queued fill puts the record back so another application can be chosen', async () => {
  const { router, storage } = await harness({
    desktop: message => (message.messageType === 'handshake' ? handshake(message) : closed())
  });
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION });
  const [entry] = storage.data.desktopOutbox;
  await router.handle({ type: 'DESKTOP_CANCEL', messageId: entry.messageId });
  assert.deepEqual(storage.data.desktopOutbox, []);
  assert.equal(storage.data.desktopFillRecords[0].status, 'pending_bind');
  assert.equal(storage.data.desktopFillRecords[0].applicationId, null);
});

test('removing a waiting record deletes it and sends nothing', async () => {
  const { router, storage, sent } = await harness();
  const { record } = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });
  const before = sent.length;
  await router.handle({ type: 'DESKTOP_REMOVE_FILL', recordId: record.recordId });
  assert.deepEqual(storage.data.desktopFillRecords, []);
  assert.equal(sent.length, before);
});

test('the pending list shows waiting records next to the queue', async () => {
  const { router } = await harness();
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });
  const listed = await router.handle({ type: 'DESKTOP_LIST_QUEUE' });
  assert.equal(listed.fillRecords.length, 1);
  assert.deepEqual(listed.intents, []);
  assert.deepEqual(listed.outbox, []);
});

test('after a restore, an applied fill leaves no record behind and a discarded one neither', async () => {
  for (const [status, choice] of [['applied', null], ['not_found', 'discard']]) {
    const { router, storage, state, drain } = await harness({
      desktop: message => (message.messageType === 'handshake' ? handshake(message) : closed())
    });
    await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION });
    const [entry] = storage.data.desktopOutbox;
    assert.equal(entry.sourceRestoreEpoch, EPOCH);

    // The desktop comes back restored: a new epoch, and a reconcile answer for the old write.
    state.desktop = message => {
      if (message.messageType === 'handshake') return handshake(message, LATER_EPOCH);
      if (message.messageType === 'outbox.reconcile') {
        return {
          response: {
            protocolVersion: 2, correlationId: message.messageId, ok: true,
            payload: { items: message.payload.items.map(item => ({ ...item, status, ...(status === 'applied' ? { resultId: EVENT } : {}) })) }
          }
        };
      }
      return closed();
    };
    await drain.run();

    if (choice) {
      assert.equal(storage.data.desktopOutbox[0].status, 'needs_user', 'not_found stops for the user');
      await router.handle({ type: 'DESKTOP_RESOLVE', messageId: entry.messageId, choice });
    }
    assert.deepEqual(storage.data.desktopOutbox, [], status);
    assert.deepEqual(storage.data.desktopFillRecords, [], status);
    assert.deepEqual(storage.data.desktopFillReceipts, [
      { recordId: entry.recordId, outcome: status === 'applied' ? 'saved' : 'discarded' }
    ]);
  }
});

test('a fill bound days later still says when it happened', async () => {
  const { router, state, writes } = await harness();
  const endedAt = '2026-09-09T10:00:00.000Z';
  const { record } = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: { ...RAW, endedAt } });
  state.desktop = onlineDesktop;
  await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  assert.equal(writes('fill.submit')[0].occurredAt, endedAt);

  // A time from the future, or none, falls back to when the record was made.
  const other = await harness();
  const { record: later } = await other.router.handle({ type: 'DESKTOP_RECORD_FILL', raw: { ...RAW, endedAt: '2027-01-01T00:00:00.000Z' } });
  assert.equal(later.occurredAt, '2026-09-12T08:00:00.000Z');
});

test('choosing an application while the desktop is closed leaves the record waiting, and says so', async () => {
  const { router, storage } = await harness();
  const { record } = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW });
  const result = await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  assert.equal(result.status, 'recorded', 'not "pending": nothing was queued');
  assert.equal(storage.data.desktopFillRecords[0].status, 'pending_bind');
});

test('a record already bound cannot be deleted from a sidebar drawn before the bind', async () => {
  const { router, storage } = await harness({ desktop: message => (message.messageType === 'handshake' ? handshake(message) : closed()) });
  const { record } = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, applicationId: APPLICATION });
  assert.equal(storage.data.desktopFillRecords[0].status, 'bound');
  const result = await router.handle({ type: 'DESKTOP_REMOVE_FILL', recordId: record.recordId });
  assert.equal(result.ok, false);
  assert.equal(storage.data.desktopFillRecords.length, 1);
  assert.equal(storage.data.desktopOutbox.filter(entry => entry.messageType === 'fill.submit').length, 1);
});

// --- #178: one finished fill, one record -----------------------------------------------

const FILL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

test('a record takes the id the page minted for the fill, and a second request for it adds nothing', async () => {
  const { router, storage, writes } = await harness();
  const first = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, recordId: FILL_ID });
  assert.equal(first.status, 'recorded');
  assert.equal(first.record.recordId, FILL_ID);
  const again = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, recordId: FILL_ID, applicationId: APPLICATION });
  assert.equal(again.status, 'duplicate');
  assert.equal(again.record.recordId, FILL_ID);
  assert.equal(storage.data.desktopFillRecords.length, 1);
  assert.equal(writes('fill.submit').length, 0, 'a repeated request never binds on its own');
});

test('two requests for the same fill racing each other still make one record and one fill.submit', async () => {
  const { router, storage, writes } = await harness({ desktop: onlineDesktop });
  const results = await Promise.all([
    router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, recordId: FILL_ID, applicationId: APPLICATION }),
    router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, recordId: FILL_ID, applicationId: APPLICATION })
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['duplicate', 'saved']);
  assert.equal(writes('fill.submit').length, 1);
  assert.deepEqual(storage.data.desktopFillRecords, []);
});

test('a fill already saved remains a duplicate after its record is removed and the worker restarts', async () => {
  const first = await harness({ desktop: onlineDesktop });
  const request = { type: 'DESKTOP_RECORD_FILL', raw: RAW, recordId: FILL_ID, applicationId: APPLICATION };
  assert.equal((await first.router.handle(request)).status, 'saved');
  assert.deepEqual(first.storage.data.desktopFillRecords, []);
  assert.equal(first.writes('fill.submit')[0].messageId, FILL_ID, 'the desktop uses the fill id as its replay identity');
  assert.deepEqual(first.storage.data.desktopFillReceipts, [{ recordId: FILL_ID, outcome: 'saved' }]);

  const sentBefore = first.sent.length;
  const repeated = await first.router.handle(request);
  assert.deepEqual(repeated, { status: 'duplicate', receipt: { recordId: FILL_ID, outcome: 'saved' } });
  assert.equal(first.sent.length, sentBefore, 'a late request does not even start the native host');

  const restarted = await harness({ storage: first.storage, desktop: onlineDesktop });
  assert.equal((await restarted.router.handle(request)).status, 'duplicate');
  assert.equal(restarted.sent.length, 0, 'the persisted receipt survives a new router');
  assert.deepEqual(first.storage.data.desktopFillRecords, []);
});

test('a late request cannot recreate a fill while its completed record is being removed', async () => {
  const { router, storage, state, writes } = await harness({
    desktop: message => (message.messageType === 'handshake' ? handshake(message) : closed())
  });
  const request = { type: 'DESKTOP_RECORD_FILL', raw: RAW, recordId: FILL_ID, applicationId: APPLICATION };
  assert.equal((await router.handle(request)).status, 'pending');
  const messageId = storage.data.desktopOutbox[0].messageId;
  const get = storage.get.bind(storage);
  let signalRead;
  const readStarted = new Promise(resolve => { signalRead = resolve; });
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  let held = false;
  storage.get = async keys => {
    if (!held && keys.includes('desktopFillRecords')) {
      held = true;
      signalRead();
      await readGate;
    }
    return get(keys);
  };

  const late = router.handle(request);
  await readStarted;
  state.desktop = onlineDesktop;
  assert.equal((await router.handle({ type: 'DESKTOP_RETRY', messageId })).status, 'saved');
  assert.deepEqual(storage.data.desktopFillRecords, []);
  const writesBeforeLateAnswer = writes('fill.submit').length;
  releaseRead();
  const result = await late;
  assert.equal(result.status, 'duplicate');
  assert.equal(result.receipt?.outcome, 'saved');
  assert.equal(writes('fill.submit').length, writesBeforeLateAnswer, 'the late request makes no new attempt');
  assert.deepEqual([...new Set(writes('fill.submit').map(message => message.messageId))], [FILL_ID]);
  assert.deepEqual(storage.data.desktopFillRecords, []);
});

test('an id that is not a UUID is not trusted: the record gets its own', async () => {
  const { router } = await harness();
  const result = await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, recordId: '../../etc' });
  assert.equal(result.status, 'recorded');
  assert.match(result.record.recordId, /^[0-9a-f-]{36}$/);
  assert.notEqual(result.record.recordId, '../../etc');
});
