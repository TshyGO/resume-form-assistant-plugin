const test = require('node:test');
const assert = require('node:assert/strict');

// A fake chrome with the pieces installDesktopLink touches, plus a way to invoke the
// listener it registered the way the browser would.
function fakeChrome({ nativeError = 'Specified native messaging host not found.' } = {}) {
  const listeners = [];
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
