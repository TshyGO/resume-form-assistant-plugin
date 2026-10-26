const test = require('node:test');
const assert = require('node:assert/strict');
const ID = '11111111-1111-4111-8111-111111111111';
const identity = { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
async function client(overrides = {}) {
  const { createMail } = await import('../link/mail.mjs');
  const sent = []; let probes = 0;
  const { validateRequest } = await import('../link/protocol/validate.mjs');
  const mail = createMail({ session: { probe: async () => { probes++; return { mode: 'ready', identity, capabilities: ['mail.import'] }; } },
    store: { clientInstanceId: async () => ID }, uuid: () => ID, now: () => new Date('2026-10-26T00:00:00Z'),
    send: async msg => { await validateRequest(msg); sent.push(msg); return { status: 'ok', response: { payload: { status: msg.payload.chunkIndex + 1 === msg.payload.chunkCount ? 'saved' : 'chunk', uploadId: ID, chunkIndex: msg.payload.chunkIndex, evidenceId: ID, duplicate: false } } }; }, ...overrides });
  return { mail, sent, probes: () => probes };
}
test('large originals use bounded snapshot chunk planning without the 2 MiB snapshot content limit', async () => {
  const c = await client(); const bytes = Buffer.alloc(3 * 1024 * 1024, 'a');
  assert.equal((await c.mail.save({ kind: 'eml', bytesBase64: bytes.toString('base64') })).status, 'saved');
  assert.equal(c.probes(), 1); assert.equal(c.sent.length, 96);
  assert.deepEqual(Buffer.concat(c.sent.map(m => Buffer.from(m.payload.bytesBase64, 'base64'))), bytes);
  for (const m of c.sent) { assert.equal(m.protocolVersion, 4); assert.equal(m.archiveId, identity.archiveId); assert.equal(m.restoreEpoch, identity.restoreEpoch); assert.ok(Buffer.byteLength(JSON.stringify(m)) < 65536); }
});
test('an old desktop is explained before sending any mail bytes', async () => {
  const c = await client({ session: { probe: async () => ({ mode: 'ready', identity, capabilities: ['job.save'] }) } });
  assert.equal((await c.mail.save({ kind: 'eml', bytesBase64: Buffer.from('mail').toString('base64') })).status, 'incompatible'); assert.equal(c.sent.length, 0);
});
test('archive restoration stops the transfer and never re-probes to silently rebind', async () => {
  const c = await client({ send: async () => ({ status: 'fatal', code: 'restore_epoch_mismatch' }) });
  assert.equal((await c.mail.save({ kind: 'eml', bytesBase64: Buffer.alloc(70000, 'x').toString('base64') })).status, 'archive_changed'); assert.equal(c.probes(), 1);
});
test('an interim ACK cannot be mistaken for durable evidence', async () => {
  const c = await client({ send: async () => ({ status: 'ok', response: { payload: { status: 'chunk', uploadId: ID, chunkIndex: 0 } } }) });
  assert.equal((await c.mail.save({ kind: 'eml', bytesBase64: Buffer.from('mail').toString('base64') })).status, 'unavailable');
});
test('excerpt bytes retain their explicit kind and chosen application', async () => {
  const c = await client(); const excerpt = { subject: '面试', from: 'hr@example.test', sentTime: '昨天', body: '正文' };
  assert.equal((await c.mail.save({ kind: 'excerpt', excerpt, applicationId: ID })).status, 'saved');
  assert.equal(c.sent[0].payload.kind, 'excerpt'); assert.equal(c.sent[0].payload.applicationId, ID);
  assert.deepEqual(JSON.parse(Buffer.from(c.sent[0].payload.bytesBase64, 'base64')), excerpt);
});
test('mail writes are accepted only from this extension native side panel', async () => {
  const { installDesktopLink } = await import('../link/worker.mjs');
  const listeners = [];
  const api = { runtime: { id: 'own', getURL: p => `chrome-extension://own/${p}`, getManifest: () => ({ version: '0.4.4' }), onMessage: { addListener: l => listeners.push(l) } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    alarms: { onAlarm: { addListener() {} }, clear: async () => {} } };
  installDesktopLink(api);
  for (const sender of [{}, { id: 'other', url: api.runtime.getURL('sidepanel.html') }, { id: 'own', url: 'https://mail.qq.com/', tab: { id: 1 } }, { id: 'own', url: api.runtime.getURL('popup.html') }]) {
    let answer; for (const listener of listeners) listener({ type: 'DESKTOP_SAVE_MAIL', kind: 'eml', bytesBase64: 'eA==' }, sender, r => { answer = r; });
    assert.equal(answer.status, 'forbidden');
  }
});
