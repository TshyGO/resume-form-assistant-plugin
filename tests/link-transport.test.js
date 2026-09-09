const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const RESULT = '55555555-5555-4555-8555-555555555555';

async function jobSave() {
  const { buildEnvelope } = await import('../link/envelope.mjs');
  return buildEnvelope({
    messageType: 'job.save',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: { company: '合成公司', title: '后端实习' },
    identity: { archiveId: ARCHIVE, restoreEpoch: EPOCH },
    sourceRestoreEpoch: EPOCH
  });
}

// The transport speaks to a fake port that answers from a script, so every branch below is
// the real classification code reading real reply shapes.
function port(...replies) {
  const calls = [];
  const send = async (hostName, message) => {
    calls.push({ hostName, message });
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1];
    return typeof reply === 'function' ? reply() : reply;
  };
  return { send, calls };
}

const deps = extra => ({ sleep: async () => {}, ...extra });

test('a persisted write comes back as ok with its resultId', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port({ response: { protocolVersion: 1, correlationId: MESSAGE, ok: true, resultId: RESULT, payload: {} } });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.equal(result.status, 'ok');
  assert.equal(result.resultId, RESULT);
  assert.equal(wire.calls[0].hostName, 'com.resumepro.desktop');
});

test('a missing host registration reads as not installed', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port({ lastError: 'Specified native messaging host not found.' });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.equal(result.status, 'not_installed');
  assert.equal(wire.calls.length, 1, 'a missing host is not a transient failure');
});

test('an unpaired extension reads as not paired, never as not installed', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port({
    response: {
      protocolVersion: 1, correlationId: MESSAGE, ok: false,
      error: { code: 'identity_not_allowed', retryable: false, message: 'origin is not paired' },
      payload: {}
    }
  });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.equal(result.status, 'not_paired');
});

test('an unrecognised port error is retried rather than reported as not installed', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  // Chrome rewords its native messaging errors between versions. Guessing "not installed"
  // from an unknown string tells the user to reinstall a desktop they already have.
  const wire = port({ lastError: 'Error when communicating with the native messaging host.' });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.equal(result.status, 'retryable');
  assert.equal(wire.calls.length, 2, 'the cold start retry ran');
});

test('a cold start that answers unavailable succeeds on the retry', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port(
    {
      response: {
        protocolVersion: 1, correlationId: MESSAGE, ok: false,
        error: { code: 'unavailable', retryable: true, message: 'the application is starting' },
        payload: {}
      }
    },
    { response: { protocolVersion: 1, correlationId: MESSAGE, ok: true, resultId: RESULT, payload: {} } }
  );

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.equal(result.status, 'ok');
  assert.equal(wire.calls.length, 2);
});

test('unavailable twice stays retryable and is not escalated to the user', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port({
    response: {
      protocolVersion: 1, correlationId: MESSAGE, ok: false,
      error: { code: 'unavailable', retryable: true, message: 'the application is starting' },
      payload: {}
    }
  });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.equal(result.status, 'retryable');
  assert.equal(result.code, 'unavailable');
  assert.equal(wire.calls.length, 2, 'the transport retries a cold start exactly once');
});

test('a fatal protocol code is not retried', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port({
    response: {
      protocolVersion: 1, correlationId: MESSAGE, ok: false,
      error: { code: 'restore_epoch_mismatch', retryable: false, message: 'not the current archive identity' },
      payload: {}
    }
  });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.equal(result.status, 'fatal');
  assert.equal(result.code, 'restore_epoch_mismatch');
  assert.equal(wire.calls.length, 1);
});

test('a reply correlated to a different request is never taken as success', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  // Two writes can be in flight across separate host processes. Accepting a reply by shape
  // alone would record this resultId against the wrong outbox entry.
  const wire = port({
    response: {
      protocolVersion: 1,
      correlationId: '99999999-9999-4999-8999-999999999999',
      ok: true, resultId: RESULT, payload: {}
    }
  });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.notEqual(result.status, 'ok');
  assert.equal(result.status, 'retryable');
});

test('a verdict the validator reaches on its own is fatal, not retryable', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const { buildEnvelope } = await import('../link/envelope.mjs');
  const handshake = await buildEnvelope({
    messageType: 'handshake',
    messageId: MESSAGE,
    clientInstanceId: CLIENT,
    payload: { pluginVersion: '0.3.0', minProtocolVersion: 1, maxProtocolVersion: 1 }
  });
  // The vendored validator decides protocol compatibility itself. Flattening that verdict
  // into "unreadable reply" would make the queue retry a desktop it can never talk to.
  const wire = port({
    response: {
      protocolVersion: 1, correlationId: MESSAGE, ok: true,
      payload: {
        appVersion: '9.0.0', minProtocolVersion: 2, maxProtocolVersion: 3,
        archiveId: ARCHIVE, restoreEpoch: EPOCH, capabilities: ['handshake']
      }
    }
  });

  const result = await sendOnce(handshake, deps({ sendNative: wire.send }));

  assert.equal(result.status, 'fatal');
  assert.equal(result.code, 'protocol_incompatible');
  assert.equal(wire.calls.length, 1);
});

test('a failed write claiming a resultId is rejected', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port({
    response: {
      protocolVersion: 1, correlationId: MESSAGE, ok: false, resultId: RESULT,
      error: { code: 'conflict', retryable: false, message: 'digest does not match' },
      payload: {}
    }
  });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.notEqual(result.status, 'ok');
});

test('the transport never reports success without a resultId for a write', async () => {
  const { sendOnce } = await import('../link/transport.mjs');
  const wire = port({ response: { protocolVersion: 1, correlationId: MESSAGE, ok: true, payload: {} } });

  const result = await sendOnce(await jobSave(), deps({ sendNative: wire.send }));

  assert.notEqual(result.status, 'ok');
});
