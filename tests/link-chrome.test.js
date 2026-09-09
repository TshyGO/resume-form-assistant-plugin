const test = require('node:test');
const assert = require('node:assert/strict');

// A stand-in for the two chrome APIs the desktop link touches, with the callback shape and
// the lastError convention MV3 actually uses.
function fakeChrome({ reply, error } = {}) {
  const sent = [];
  return {
    sent,
    runtime: {
      lastError: undefined,
      sendNativeMessage(hostName, message, callback) {
        sent.push({ hostName, message });
        this.lastError = error ? { message: error } : undefined;
        callback(error ? undefined : reply);
        this.lastError = undefined;
      }
    },
    storage: {
      local: {
        _data: {},
        async get(keys) {
          const out = {};
          for (const name of (Array.isArray(keys) ? keys : [keys])) {
            if (name in this._data) out[name] = this._data[name];
          }
          return out;
        },
        async set(values) { Object.assign(this._data, values); }
      }
    }
  };
}

test('a native reply is handed back as a response', async () => {
  const { nativeSender } = await import('../link/chrome.mjs');
  const api = fakeChrome({ reply: { ok: true } });

  const result = await nativeSender(api)('com.resumepro.desktop', { messageType: 'health' });

  assert.deepEqual(result, { response: { ok: true } });
  assert.equal(api.sent[0].hostName, 'com.resumepro.desktop');
});

test('a port failure is handed back as lastError instead of throwing', async () => {
  const { nativeSender } = await import('../link/chrome.mjs');
  // lastError is only readable inside the callback; reading it later gives undefined, and a
  // failure that reads as an empty reply would look like a malformed response instead of a
  // closed port.
  const api = fakeChrome({ error: 'Specified native messaging host not found.' });

  const result = await nativeSender(api)('com.resumepro.desktop', { messageType: 'health' });

  assert.equal(result.lastError, 'Specified native messaging host not found.');
  assert.equal(result.response, undefined);
});

test('the storage adapter reads back what it wrote', async () => {
  const { storageAdapter } = await import('../link/chrome.mjs');
  const storage = storageAdapter(fakeChrome());

  await storage.set({ desktopOutbox: [{ messageId: 'm' }] });

  assert.deepEqual(await storage.get(['desktopOutbox']), { desktopOutbox: [{ messageId: 'm' }] });
});
