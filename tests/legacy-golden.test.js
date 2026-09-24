// The plugin and the desktop never run together in CI. This pins what the plugin sends for
// a 0.4.0 store (tests/fixtures/legacy-0.4.0-storage.json) to a golden file that the Rust
// side replays through the real legacy.import handler (plugin_bridge.rs). Change either
// side and one of the two tests goes red.
//
// Regenerate after an intended change: UPDATE_GOLDEN=1 node --test tests/legacy-golden.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const profileApi = require('../profile-fields.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const GOLDEN = path.join(FIXTURES, 'legacy-import-0.4.0.json');

test('a 0.4.0 store produces the golden legacy.import payloads', async () => {
  const { createLegacy } = await import('../link/legacy.mjs');
  const data = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'legacy-0.4.0-storage.json'), 'utf8'));
  const store = structuredClone(data);
  const sent = [];
  let sequence = 0;
  const legacy = createLegacy({
    session: { probe: async () => ({ mode: 'ready', identity: { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }) },
    store: { clientInstanceId: async () => '11111111-1111-4111-8111-111111111111' },
    storage: {
      async get(keys) { const out = {}; for (const key of keys) if (key in store) out[key] = structuredClone(store[key]); return out; },
      async set(values) { Object.assign(store, structuredClone(values)); },
      async remove(keys) { for (const key of keys) delete store[key]; }
    },
    alarms: { async create() {}, async clear() {} },
    profileApi,
    sendNative: async () => { throw new Error('unused'); },
    sleep: async () => {},
    uuid: () => `c0ffee00-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    now: () => new Date('2026-09-25T00:00:00.000Z'),
    getManifest: () => ({ version: '0.4.1' }),
    send: async envelope => {
      if (envelope.messageType === 'legacy.import') sent.push(envelope.payload);
      const total = sent[0]?.body?.total ?? 1;
      return { status: 'ok', response: { ok: true, payload: envelope.messageType === 'ui.open' ? { opened: true } : { state: 'receiving', received: 0, total } } };
    }
  });
  await legacy.run();
  const payloads = sent.filter(payload => payload.kind !== 'status');

  if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, JSON.stringify(payloads, null, 2) + '\n');
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(payloads, golden);

  // What the golden file must say, independently of how it was produced.
  const kinds = golden.map(payload => payload.kind);
  assert.deepEqual(kinds, ['manifest', 'template', 'template', 'profile', 'aiConfig']);
  assert.equal(golden[1].body.wasActive, true, 'the current template is sent first');
  assert.equal(JSON.stringify(golden[3]).includes('synthetic-not-migrated'), false);
  assert.equal(golden.filter(payload => JSON.stringify(payload).includes('sk-synthetic-golden-key')).length, 1);
});
