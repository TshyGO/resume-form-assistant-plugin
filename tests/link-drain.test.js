const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPLICATION = '77777777-7777-4777-8777-777777777777';
const IDENTITY = { archiveId: ARCHIVE, restoreEpoch: EPOCH };

const FIELDS = {
  company: '星河科技',
  title: '后端开发',
  location: '上海',
  sourceUrl: 'https://jobs.example.com/apply',
  dedupeUrl: 'https://jobs.example.com/apply'
};

// One shared storage object survives across "browser restarts": the test throws away every
// in-memory object and builds new ones over the same data, which is what a fresh service
// worker sees.
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

function fakeAlarms() {
  const created = [];
  return {
    created,
    async create(name, options) { created.push({ name, ...options }); },
    async clear() { return true; },
    onAlarm: { addListener() {} }
  };
}

async function harness({ desktop, storage = fakeStorage(), clock = { value: Date.parse('2026-09-09T00:00:00.000Z') } } = {}) {
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');
  const { createDrain } = await import('../link/drain.mjs');

  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date(clock.value);
  const sent = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sendNative = async (host, message) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    sent.push(message);
    const reply = desktop(message);
    inFlight -= 1;
    return reply;
  };

  const store = createStore({ storage, uuid });
  const deps = { store, uuid, now, sleep: async () => {}, sendNative };
  const session = createSession(deps);
  const intents = createIntents(deps);
  const outbox = createOutbox(deps);
  const alarms = fakeAlarms();
  const drain = createDrain({ session, outbox, alarms, now });

  return { drain, outbox, intents, store, storage, sent, alarms, clock, stats: () => ({ maxInFlight }) };
}

const handshakeReply = message => ({
  response: {
    protocolVersion: 1, correlationId: message.messageId, ok: true,
    payload: {
      appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 1,
      archiveId: ARCHIVE, restoreEpoch: EPOCH, capabilities: ['handshake', 'job.save']
    }
  }
});

const unavailable = message => ({
  response: {
    protocolVersion: 1, correlationId: message.messageId, ok: false,
    error: { code: 'unavailable', retryable: true, message: 'starting' }, payload: {}
  }
});

const saved = message => ({
  response: { protocolVersion: 1, correlationId: message.messageId, ok: true, resultId: APPLICATION, payload: {} }
});

async function bindOne(harnessed, { title = FIELDS.title } = {}) {
  const { intent } = await harnessed.intents.save({ fields: { ...FIELDS, title }, mode: 'ready' });
  return harnessed.outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });
}

test('the backoff ladder is the documented one and it ends', async () => {
  const { nextDelayMs } = await import('../link/drain.mjs');
  const { BACKOFF_STEPS_MS } = await import('../link/limits.mjs');

  BACKOFF_STEPS_MS.forEach((step, index) => {
    assert.equal(nextDelayMs(index + 1), step);
  });
  // Past the last step the entry waits for a person. Retrying forever hides a problem the
  // user is the only one who can fix.
  assert.equal(nextDelayMs(BACKOFF_STEPS_MS.length + 1), null);
});

test('a failed attempt schedules the next one instead of spinning', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  const { BACKOFF_STEPS_MS } = await import('../link/limits.mjs');

  await bindOne(bench);
  const entry = bench.storage.data.desktopOutbox[0];

  assert.equal(entry.attempts, 1);
  assert.equal(Date.parse(entry.nextAttemptAt), bench.clock.value + BACKOFF_STEPS_MS[0]);
});

test('an entry that is not due yet is left alone', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  await bindOne(bench);
  const before = bench.sent.length;

  await bench.drain.run();

  assert.equal(bench.sent.length, before + 1, 'only the handshake went out');
});

test('the entry is retried once its delay has passed', async () => {
  let phase = 'down';
  const bench = await harness({
    desktop: message => {
      if (message.messageType === 'handshake') return handshakeReply(message);
      return phase === 'down' ? unavailable(message) : saved(message);
    }
  });
  await bindOne(bench);
  const { BACKOFF_STEPS_MS } = await import('../link/limits.mjs');

  phase = 'up';
  bench.clock.value += BACKOFF_STEPS_MS[0];
  const result = await bench.drain.run();

  assert.equal(result.saved.length, 1);
  assert.deepEqual(bench.storage.data.desktopOutbox, []);
});

test('a retry keeps the original message id across the whole ladder', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  const { BACKOFF_STEPS_MS } = await import('../link/limits.mjs');
  await bindOne(bench);
  const original = bench.sent.at(-1).messageId;

  for (const step of BACKOFF_STEPS_MS) {
    bench.clock.value += step;
    await bench.drain.run();
  }

  const writes = bench.sent.filter(message => message.messageType === 'job.save');
  assert.ok(writes.length > 1);
  assert.ok(writes.every(message => message.messageId === original), 'a new id would be a new application');
});

test('an exhausted ladder stops and asks for a person', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  const { BACKOFF_STEPS_MS } = await import('../link/limits.mjs');
  await bindOne(bench);

  for (const step of BACKOFF_STEPS_MS) {
    bench.clock.value += step;
    await bench.drain.run();
  }
  const writesSoFar = bench.sent.filter(message => message.messageType === 'job.save').length;
  bench.clock.value += 86_400_000;
  await bench.drain.run();

  assert.equal(bench.storage.data.desktopOutbox[0].status, 'stalled');
  assert.equal(
    bench.sent.filter(message => message.messageType === 'job.save').length,
    writesSoFar,
    'a stalled entry waits for the user, it is not retried'
  );
});

test('a manual retry sends a stalled entry again without a new identity', async () => {
  let phase = 'down';
  const bench = await harness({
    desktop: message => {
      if (message.messageType === 'handshake') return handshakeReply(message);
      return phase === 'down' ? unavailable(message) : saved(message);
    }
  });
  const { BACKOFF_STEPS_MS } = await import('../link/limits.mjs');
  await bindOne(bench);
  const original = bench.sent.at(-1).messageId;
  for (const step of BACKOFF_STEPS_MS) {
    bench.clock.value += step;
    await bench.drain.run();
  }

  phase = 'up';
  const result = await bench.drain.retryNow(bench.storage.data.desktopOutbox[0].messageId);

  assert.equal(result.status, 'saved');
  assert.equal(bench.sent.at(-1).messageId, original);
});

test('cancelling a queued write stops it reaching the desktop', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  await bindOne(bench);
  const { messageId } = bench.storage.data.desktopOutbox[0];

  await bench.drain.cancel(messageId);
  bench.clock.value += 86_400_000;
  const before = bench.sent.filter(message => message.messageType === 'job.save').length;
  await bench.drain.run();

  assert.deepEqual(bench.storage.data.desktopOutbox, []);
  assert.equal(bench.sent.filter(message => message.messageType === 'job.save').length, before);
});

test('the queue survives a browser restart and keeps draining', async () => {
  const storage = fakeStorage();
  const first = await harness({
    desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)),
    storage
  });
  await bindOne(first);
  const original = storage.data.desktopOutbox[0].messageId;

  // Everything in memory is gone; only chrome.storage.local survives.
  const restarted = await harness({
    desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : saved(message)),
    storage,
    clock: { value: Date.parse('2026-09-09T01:00:00.000Z') }
  });
  const result = await restarted.drain.run();

  assert.equal(result.saved.length, 1);
  assert.equal(restarted.sent.at(-1).messageId, original);
  assert.deepEqual(storage.data.desktopOutbox, []);
  assert.deepEqual(storage.data.desktopSaveIntents, []);
});

test('two queued writes go out one at a time', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : saved(message)) });
  await bindOne(bench, { title: '后端开发' });
  await bindOne(bench, { title: '测试开发' });

  await bench.drain.run();

  // Parallel sends race for the same cold start and the host answers all but one of them
  // with `unavailable` for no reason at all.
  assert.equal(bench.stats().maxInFlight, 1);
});

test('a closed desktop schedules another look instead of failing the queue', async () => {
  let reachable = true;
  const bench = await harness({
    desktop: message => {
      if (!reachable) return { lastError: 'Error when communicating with the native messaging host.' };
      return message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message);
    }
  });
  await bindOne(bench);
  await bench.store.setPairing({ archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 });
  bench.alarms.created.length = 0;

  // The desktop goes away with work still queued.
  reachable = false;
  bench.clock.value += 60_000;
  const result = await bench.drain.run();

  assert.equal(result.mode, 'unavailable');
  assert.ok(bench.alarms.created.length > 0, 'nothing would ever wake the worker again');
});

test('the scheduled alarm respects the browser minimum', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  const { MIN_ALARM_DELAY_MS } = await import('../link/limits.mjs');
  await bindOne(bench);
  await bench.store.setPairing({ archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 });

  await bench.drain.run();

  const alarm = bench.alarms.created.at(-1);
  assert.ok(alarm.delayInMinutes * 60_000 >= MIN_ALARM_DELAY_MS, JSON.stringify(alarm));
});

test('a restored archive is noticed before anything is sent', async () => {
  const { createReconcile } = await import('../link/reconcile.mjs');
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');
  const { createDrain } = await import('../link/drain.mjs');

  const NEW_EPOCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const storage = fakeStorage();
  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const clock = { value: Date.parse('2026-09-09T00:00:00.000Z') };
  const now = () => new Date(clock.value);
  const sent = [];
  let epoch = EPOCH;
  const sendNative = async (host, message) => {
    sent.push(message);
    if (message.messageType === 'handshake') {
      return {
        response: {
          protocolVersion: 1, correlationId: message.messageId, ok: true,
          payload: {
            appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 1,
            archiveId: ARCHIVE, restoreEpoch: epoch, capabilities: ['handshake', 'job.save']
          }
        }
      };
    }
    if (message.messageType === 'outbox.reconcile') {
      return {
        response: {
          protocolVersion: 1, correlationId: message.messageId, ok: true,
          payload: { items: message.payload.items.map(item => ({ ...item, status: 'not_found' })) }
        }
      };
    }
    return unavailable(message);
  };

  const store = createStore({ storage, uuid });
  const deps = { store, uuid, now, sleep: async () => {}, sendNative };
  const outbox = createOutbox(deps);
  const drain = createDrain({
    session: createSession(deps),
    outbox,
    reconcile: createReconcile({ ...deps, outbox }),
    alarms: fakeAlarms(),
    now
  });
  const intents = createIntents(deps);

  const { intent } = await intents.save({ fields: FIELDS, mode: 'ready' });
  await outbox.bindAndSend({ intentId: intent.intentId, identity: IDENTITY });

  epoch = NEW_EPOCH;
  clock.value += 3_600_000;
  await drain.run();

  // The pause has to happen inside the same pass, before the drain looks for due entries.
  assert.equal(storage.data.desktopOutbox[0].status, 'needs_user');
  assert.equal(storage.data.desktopOutbox[0].reconcileStatus, 'not_found');
});

test('an empty queue does not wake the worker or start the desktop', async () => {
  const bench = await harness({ desktop: () => ({ lastError: 'Error when communicating with the native messaging host.' }) });
  await bench.store.setPairing({ archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 });

  await bench.drain.run();
  await bench.drain.run();

  // Probing spawns a native host, and per D06 the host starts the application on demand.
  // Doing that on a timer with nothing queued restarts a desktop the user deliberately
  // closed, over and over, for no work at all.
  assert.equal(bench.sent.length, 0, 'nothing to send, so nothing should have been sent');
  assert.equal(bench.alarms.created.length, 0, 'nothing to do later, so nothing to wake for');
});

test('a queued write still schedules a look even when the desktop is closed', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  await bindOne(bench);
  bench.alarms.created.length = 0;

  await bench.drain.run();

  assert.ok(bench.alarms.created.length > 0, 'work is queued, so something has to come back for it');
});

test('entries that are only waiting for the user do not keep the worker awake', async () => {
  const bench = await harness({ desktop: message => (message.messageType === 'handshake' ? handshakeReply(message) : unavailable(message)) });
  const { BACKOFF_STEPS_MS } = await import('../link/limits.mjs');
  await bindOne(bench);
  for (const step of BACKOFF_STEPS_MS) {
    bench.clock.value += step;
    await bench.drain.run();
  }
  assert.equal(bench.storage.data.desktopOutbox[0].status, 'stalled');

  bench.alarms.created.length = 0;
  bench.sent.length = 0;
  bench.clock.value += 86_400_000;
  await bench.drain.run();

  assert.equal(bench.sent.length, 0);
  assert.equal(bench.alarms.created.length, 0);
});
