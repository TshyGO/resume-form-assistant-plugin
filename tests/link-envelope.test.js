const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OLD_EPOCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const IDENTITY = { archiveId: ARCHIVE, restoreEpoch: EPOCH };

async function load() {
  return {
    envelope: await import('../link/envelope.mjs'),
    validate: await import('../link/protocol/validate.mjs')
  };
}

test('handshake carries no archive identity and passes D05 validation', async () => {
  const { envelope, validate } = await load();

  const message = await envelope.buildEnvelope({
    messageType: 'handshake',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: { pluginVersion: '0.3.0', minProtocolVersion: 1, maxProtocolVersion: 1 },
    identity: IDENTITY
  });

  assert.equal('archiveId' in message, false);
  assert.equal('restoreEpoch' in message, false);
  assert.equal(message.protocolVersion, 1);
  await validate.validateRequest(message);
});

test('job.save stamps the bound source epoch, not the current one', async () => {
  const { envelope, validate } = await load();

  const message = await envelope.buildEnvelope({
    messageType: 'job.save',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: { company: '合成公司', title: '后端实习' },
    identity: IDENTITY,
    sourceRestoreEpoch: OLD_EPOCH
  });

  // The envelope proves who is talking now; the payload records which archive the user
  // was bound to when they chose. Backfilling the payload with `current` is exactly the
  // silent replay D01 forbids.
  assert.equal(message.restoreEpoch, EPOCH);
  assert.equal(message.payload.sourceRestoreEpoch, OLD_EPOCH);
  await validate.validateRequest(message);
});

test('job.save digest covers the payload without the digest field', async () => {
  const { envelope, validate } = await load();

  const message = await envelope.buildEnvelope({
    messageType: 'job.save',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: { company: '合成公司', title: '后端实习' },
    identity: IDENTITY,
    sourceRestoreEpoch: EPOCH
  });

  const body = { ...message.payload };
  delete body.payloadSha256;
  assert.equal(message.payload.payloadSha256, await validate.payloadBodySha256(body));
});

test('queryCandidates gets archive identity but no write-only payload fields', async () => {
  const { envelope, validate } = await load();

  const message = await envelope.buildEnvelope({
    messageType: 'application.queryCandidates',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: { company: '合成公司' },
    identity: IDENTITY
  });

  assert.equal(message.archiveId, ARCHIVE);
  assert.equal('sourceRestoreEpoch' in message.payload, false);
  assert.equal('payloadSha256' in message.payload, false);
  await validate.validateRequest(message);
});

test('outbox.reconcile passes validation with a batch of prior identities', async () => {
  const { envelope, validate } = await load();

  const message = await envelope.buildEnvelope({
    messageType: 'outbox.reconcile',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: {
      items: [{
        clientInstanceId: CLIENT,
        messageId: MESSAGE,
        sourceRestoreEpoch: OLD_EPOCH,
        payloadSha256: '1ea8fcf15e56dd83a5e7f8e9adb0c34b94bc28fd5c1b51400ecf597d1f5cc8c4'
      }]
    },
    identity: IDENTITY
  });

  await validate.validateRequest(message);
});

test('an identity-required message without a handshake refuses to be built', async () => {
  const { envelope } = await load();

  await assert.rejects(
    () => envelope.buildEnvelope({
      messageType: 'application.queryCandidates',
      messageId: MESSAGE,
      clientInstanceId: CLIENT,
      payload: { company: '合成公司' },
      identity: null
    }),
    error => error.code === 'identity_missing'
  );
});

test('a write without a bound source epoch refuses to be built', async () => {
  const { envelope } = await load();

  await assert.rejects(
    () => envelope.buildEnvelope({
      messageType: 'job.save',
      messageId: MESSAGE,
      clientInstanceId: CLIENT,
      payload: { company: '合成公司', title: '后端实习' },
      identity: IDENTITY
    }),
    error => error.code === 'invalid_payload'
  );
});

test('an oversized envelope fails locally instead of hitting the wire', async () => {
  const { envelope } = await load();

  await assert.rejects(
    () => envelope.buildEnvelope({
      messageType: 'job.save',
      messageId: MESSAGE,
      clientInstanceId: CLIENT,
      payload: { company: '合成公司', title: 'x'.repeat(70000) },
      identity: IDENTITY,
      sourceRestoreEpoch: EPOCH
    }),
    error => error.code === 'payload_too_large'
  );
});

test('occurredAt is the UTC subset D05 accepts', async () => {
  const { envelope, validate } = await load();

  const message = await envelope.buildEnvelope({
    messageType: 'health',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: {},
    now: () => new Date('2026-09-09T04:05:06.700Z')
  });

  assert.equal(message.occurredAt, '2026-09-09T04:05:06.700Z');
  await validate.validateRequest(message);
});

test('snapshot.chunk carries the source epoch but no payload digest', async () => {
  const { envelope, validate } = await load();
  const bytes = new TextEncoder().encode('hello');
  const chunkSha256 = await validate.sha256Hex(bytes);

  const message = await envelope.buildEnvelope({
    messageType: 'snapshot.chunk',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: {
      snapshotId: '44444444-4444-4444-8444-444444444444',
      applicationId: '77777777-7777-4777-8777-777777777777',
      chunkIndex: 0,
      chunkCount: 1,
      chunkSha256,
      snapshotSha256: chunkSha256,
      byteSize: bytes.length,
      bytesBase64: 'aGVsbG8='
    },
    identity: IDENTITY,
    sourceRestoreEpoch: EPOCH
  });

  // The chunk payload schema is additionalProperties:false and declares no payloadSha256;
  // a chunk's receipt digest is the immutable chunk identity, computed separately. Adding
  // the field here makes every snapshot chunk D08 ever sends fail as invalid_payload.
  assert.equal(message.payload.sourceRestoreEpoch, EPOCH);
  assert.equal('payloadSha256' in message.payload, false);
  await validate.validateRequest(message);
});
