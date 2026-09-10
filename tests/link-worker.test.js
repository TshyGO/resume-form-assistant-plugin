const test = require('node:test');
const assert = require('node:assert/strict');

// A fake chrome with the pieces installDesktopLink touches, plus a way to invoke the
// listener it registered the way the browser would.
function fakeChrome({ nativeError = 'Specified native messaging host not found.' } = {}) {
  const listeners = [];
  listeners.alarm = null;
  return {
    listeners,
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      lastError: undefined,
      onMessage: { addListener: fn => listeners.push(fn) },
      sendNativeMessage(hostName, message, callback) {
        this.lastError = { message: nativeError };
        callback(undefined);
        this.lastError = undefined;
      }
    },
    alarms: {
      created: [],
      fired: [],
      async create(name, options) { this.created.push({ name, ...options }); },
      async clear() { return true; },
      onAlarm: { addListener(fn) { listeners.alarm = fn; } }
    },
    storage: {
      local: {
        _data: {},
        async get(keys) {
          const out = {};
          for (const name of (Array.isArray(keys) ? keys : [keys])) if (name in this._data) out[name] = this._data[name];
          return out;
        },
        async set(values) { Object.assign(this._data, values); }
      }
    },
    // Invoke the registered listener the way the browser does and resolve what it answered.
    dispatch(message) {
      return new Promise(resolve => {
        const kept = listeners.map(fn => fn(message, {}, resolve));
        if (!kept.some(Boolean)) resolve(undefined);
      });
    }
  };
}

const PAIRED = { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', at: 1 };
// A write still waiting to go out. Without queued work the drain deliberately does nothing:
// probing spawns a native host, and per D06 the host starts the desktop application.
const QUEUED_WRITE = [{
  messageId: '55555555-5555-4555-8555-555555555555',
  intentId: null,
  clientInstanceId: '11111111-1111-4111-8111-111111111111',
  messageType: 'job.save',
  archiveId: PAIRED.archiveId,
  sourceRestoreEpoch: PAIRED.restoreEpoch,
  payload: { company: '合成公司', title: '后端实习' },
  status: 'pending',
  attempts: 0,
  nextAttemptAt: '2020-01-01T00:00:00.000Z',
  lastError: null
}];

test('the desktop listener answers a probe', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const api = fakeChrome();
  installDesktopLink(api);

  const result = await api.dispatch({ type: 'DESKTOP_PROBE' });

  assert.equal(result.mode, 'not_installed');
  assert.equal(result.extensionId, 'abcdefghijklmnopabcdefghijklmnop');
});

test('the desktop listener keeps the message channel open for its async answer', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const api = fakeChrome();
  installDesktopLink(api);

  // Returning anything but true here closes the port before the handshake resolves, and the
  // sidebar silently receives undefined.
  assert.equal(api.listeners[0]({ type: 'DESKTOP_PROBE' }, {}, () => {}), true);
});

test('the desktop listener does not answer messages it does not own', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const api = fakeChrome();
  installDesktopLink(api);

  // ENSURE_AI_HOST and TOGGLE_MANAGER belong to the existing worker. Claiming them here
  // would break the offscreen AI host.
  assert.equal(api.listeners[0]({ type: 'ENSURE_AI_HOST' }, {}, () => {}), false);
  assert.equal(api.listeners[0]({ type: 'TOGGLE_MANAGER' }, {}, () => {}), false);
});

test('a failure inside the desktop link answers an error instead of hanging the sidebar', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const api = fakeChrome();
  api.storage.local.get = async () => { throw new Error('storage is unavailable'); };
  installDesktopLink(api);

  const result = await api.dispatch({ type: 'DESKTOP_PROBE' });

  assert.equal(result.error, true);
  assert.equal(typeof result.code, 'string');
});

test('the worker wakes the queue when its alarm fires', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const { ALARM_NAME } = await import('../link/drain.mjs');
  const api = fakeChrome();
  api.storage.local._data.desktopPairing = PAIRED;
  api.storage.local._data.desktopOutbox = QUEUED_WRITE;
  installDesktopLink(api);

  // Without this the queue only moves when the user happens to open a page again, which is
  // exactly the case the offline queue exists for.
  assert.equal(typeof api.listeners.alarm, 'function');
  api.listeners.alarm({ name: ALARM_NAME });
  // onAlarm is fire-and-forget in the browser too, so the test waits the same way the
  // browser does: it lets the work finish on its own.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(api.alarms.created.length > 0);
});

test('an alarm that belongs to someone else is ignored', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const api = fakeChrome();
  installDesktopLink(api);
  await new Promise(resolve => setTimeout(resolve, 0));
  const before = api.alarms.created.length;

  api.listeners.alarm({ name: 'someone-elses-alarm' });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(api.alarms.created.length, before);
});

test('a queued write is retried when the worker starts', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const api = fakeChrome();
  api.storage.local._data.desktopPairing = PAIRED;
  api.storage.local._data.desktopOutbox = QUEUED_WRITE;
  installDesktopLink(api);

  // A cold worker has no timers left over from its previous life; the queue has to be picked
  // up on startup or it waits for an alarm that was never rescheduled.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(api.alarms.created.length > 0);
});

test('a worker with nothing queued neither probes nor sets an alarm', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const api = fakeChrome();
  api.storage.local._data.desktopPairing = PAIRED;
  installDesktopLink(api);

  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(api.alarms.created.length, 0, 'nothing to do, so nothing to wake for');
});
