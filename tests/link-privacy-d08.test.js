const test = require('node:test');
const assert = require('node:assert/strict');

// D08 acceptance 5: sensitive fields, URL tokens and configuration keys never reach events,
// logs or backups. On the plugin side that means: nothing that leaves for the desktop, and
// nothing D08 writes to its own storage, may contain any of these synthetic values.
const SECRETS = {
  password: 'hunter2-synthetic-pw',
  otp: '481516-synthetic',
  apiKey: 'sk-synthetic-apikey-000',
  urlToken: 'tok-synthetic-url-999',
  fieldValue: 'value-typed-into-the-page-synthetic',
  aiMatch: 'ai-returned-value-synthetic',
  prompt: 'prompt-text-synthetic'
};

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPLICATION = '77777777-7777-4777-8777-777777777777';

const TEMPLATE = {
  name: '合成模板',
  groups: [
    { name: '基本信息', fields: [{ key: '姓名', value: '合成姓名' }, { key: '登录密码', value: SECRETS.password }] },
    { name: '账号', fields: [{ key: '短信验证码', value: SECRETS.otp }, { key: 'API Key', value: SECRETS.apiKey }] }
  ]
};

// What a careless caller might hand over. Everything beyond the counters must be dropped.
const RAW = {
  outcome: 'partial', cancelled: false, fieldCount: 6, filledCount: 4, unconfirmedCount: 1,
  timing: { scanMs: 1, roundTripMs: 2, fillMs: 3, totalMs: 6 },
  urlRedacted: `https://jobs.example.com/apply?access_token=${SECRETS.urlToken}&code=${SECRETS.urlToken}&role=backend`,
  templateName: '合成模板', templateVersion: '0123456789ab', pluginVersion: '0.4.0',
  job: { company: '星河科技', title: '后端开发', sourceUrl: `https://jobs.example.com/apply?token=${SECRETS.urlToken}` },
  values: [SECRETS.fieldValue],
  matches: [{ fieldId: 'f1', value: SECRETS.aiMatch }],
  aiConfig: { apiKey: SECRETS.apiKey, apiUrl: 'https://api.example.com' },
  prompt: SECRETS.prompt
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

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); },
    async list() { return [...map.values()].map(value => structuredClone(value)); }
  };
}

test('no synthetic secret reaches the wire, chrome.storage or IndexedDB', async () => {
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

  // The plugin's own template lives in chrome.storage under a key D08 never touches; it is
  // left out of the scan below on purpose — it is the user's data, not something D08 wrote.
  const storage = fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 }, templates: [TEMPLATE] });
  const kv = fakeKv();
  const wire = [];
  const reply = (message, payload, resultId) => ({ response: { protocolVersion: 1, correlationId: message.messageId, ok: true, ...(resultId ? { resultId } : {}), payload } });
  const sendNative = async (host, message) => {
    wire.push(message);
    if (message.messageType === 'handshake') {
      return reply(message, { appVersion: '0.1.0', minProtocolVersion: 1, maxProtocolVersion: 1, archiveId: ARCHIVE, restoreEpoch: EPOCH, capabilities: ['handshake'] });
    }
    if (message.messageType === 'fill.submit') return reply(message, { resultKind: 'event' }, '99999999-9999-4999-8999-999999999999');
    if (message.messageType === 'snapshot.chunk') {
      const p = message.payload;
      const done = p.chunkIndex === p.chunkCount - 1;
      return reply(message, { ackKind: done ? 'snapshot' : 'chunk', snapshotId: p.snapshotId, chunkIndex: p.chunkIndex, chunkCursor: p.chunkIndex + 1 }, message.messageId);
    }
    return { lastError: 'closed' };
  };
  let minted = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date('2026-09-12T08:00:00.000Z');
  const store = createStore({ storage, uuid });
  const deps = { store, sendNative, sleep: async () => {}, uuid, now };
  const staging = createStaging({ kv, now, uuid });
  const uploads = createUploads({ ...deps, staging });
  const session = createSession(deps);
  const outbox = createOutbox({ ...deps, uploads });
  const reconcile = createReconcile({ ...deps, outbox, uploads });
  const drain = createDrain({ session, outbox, reconcile, alarms: { async create() {}, async clear() { return true; } }, now });
  const router = createRouter({
    session, intents: createIntents(deps), outbox, drain, reconcile, fillRecords: createFillRecords(deps), store, uploads,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });

  // Recorded while the desktop cannot take writes, inspected, then bound and uploaded.
  await router.handle({ type: 'DESKTOP_RECORD_FILL', raw: RAW, snapshotTemplate: TEMPLATE });
  const stagedWhileWaiting = await kv.list();
  const storedWhileWaiting = JSON.stringify(storage.data);
  const [record] = storage.data.desktopFillRecords;
  await router.handle({ type: 'DESKTOP_BIND_FILL', recordId: record.recordId, applicationId: APPLICATION });
  await drain.run();

  const decodedChunks = wire
    .filter(message => message.messageType === 'snapshot.chunk')
    .map(message => Buffer.from(message.payload.bytesBase64, 'base64').toString('utf8'))
    .join('');
  const stagedText = stagedWhileWaiting.map(item => new TextDecoder().decode(item.bytes)).join('');
  const d08Storage = JSON.stringify({ ...JSON.parse(storedWhileWaiting), templates: undefined });

  const places = {
    'the wire (every envelope)': JSON.stringify(wire),
    'the snapshot bytes sent': decodedChunks,
    'the snapshot bytes staged in IndexedDB': stagedText,
    'the fill record and queue in chrome.storage': d08Storage
  };
  for (const [where, text] of Object.entries(places)) {
    for (const [what, secret] of Object.entries(SECRETS)) {
      assert.equal(text.includes(secret), false, `${what} reached ${where}`);
    }
  }

  // And the things that should be there, are: the upload happened and kept the ordinary field.
  assert.match(decodedChunks, /合成姓名/);
  assert.ok(wire.some(message => message.messageType === 'fill.submit'));
  assert.match(JSON.stringify(wire.find(message => message.messageType === 'fill.submit').payload), /role=backend/);
});
