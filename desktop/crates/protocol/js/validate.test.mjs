import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCurrentIdentity,
  MAX_ENVELOPE_BYTES,
  payloadBodySha256,
  validateRequest,
  validateRequestBytes,
  validateResponse,
  validateResponseForRequest,
} from "./validate.mjs";

const ARCHIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EPOCH_OLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const MSG = "33333333-3333-4333-8333-333333333333";

function envelope(messageType, payload, extra = {}) {
  const value = {
    protocolVersion: 1,
    messageId: MSG,
    clientInstanceId: CLIENT,
    messageType,
    occurredAt: "2026-09-06T12:00:00.000Z",
    payload,
    ...extra,
  };
  if (messageType !== "health" && messageType !== "handshake") {
    value.archiveId = ARCHIVE;
    value.restoreEpoch = EPOCH;
  }
  return value;
}

async function jobSavePayload(extra = {}) {
  const payload = {
    sourceRestoreEpoch: EPOCH,
    company: "合成公司",
    title: "后端实习",
    ...extra,
  };
  payload.payloadSha256 = await payloadBodySha256(payload);
  return payload;
}

async function code(fn) {
  try {
    await fn();
    throw new Error("expected failure");
  } catch (e) {
    return e.code;
  }
}

test("health/handshake identity exception", async () => {
  await validateRequest(envelope("health", {}));
  await validateRequest(
    envelope("handshake", { pluginVersion: "0.3.0", minProtocolVersion: 1, maxProtocolVersion: 1 }),
  );
  assert.equal(
    await code(() => validateRequest(envelope("health", {}, { archiveId: ARCHIVE, restoreEpoch: EPOCH }))),
    "identity_not_allowed",
  );
});

test("write identity missing and SaveIntent rejected", async () => {
  const v = envelope("job.save", await jobSavePayload());
  delete v.archiveId;
  assert.equal(await code(() => validateRequest(v)), "identity_missing");
  assert.equal(await code(() => validateRequest(envelope("SaveIntent", { intentId: MSG }))), "unknown_message_type");
});

test("structure ok does not grant write when epoch is old", async () => {
  const v = envelope("job.save", await jobSavePayload());
  await validateRequest(v);
  assert.equal(
    await code(() => {
      checkCurrentIdentity(v, { archiveId: ARCHIVE, restoreEpoch: EPOCH_OLD });
    }),
    "restore_epoch_mismatch",
  );
});

test("65536/65537 UTF-8 envelope boundary", async () => {
  const base = envelope("job.save", await jobSavePayload({ location: "" }));
  const baseBytes = Buffer.from(JSON.stringify(base), "utf8");
  const v = envelope("job.save", await jobSavePayload({ location: "a".repeat(MAX_ENVELOPE_BYTES - baseBytes.length) }));
  const bytes = Buffer.from(JSON.stringify(v), "utf8");
  assert.equal(bytes.length, MAX_ENVELOPE_BYTES);
  await validateRequestBytes(bytes);
  const tooBig = Buffer.concat([bytes, Buffer.from(" ")]);
  assert.equal(tooBig.length, 65537);
  assert.equal(await code(() => validateRequestBytes(tooBig)), "payload_too_large");
});

test("Chinese company is counted as UTF-8 bytes", async () => {
  const v = envelope("job.save", await jobSavePayload());
  assert.equal(v.payload.company.length, 4);
  assert.equal(Buffer.byteLength(v.payload.company, "utf8"), 12);
  await validateRequest(v);
});

function okResponse(correlationId, payload = {}) {
  return {
    protocolVersion: 1,
    correlationId,
    ok: true,
    resultId: "55555555-5555-4555-8555-555555555555",
    payload,
  };
}

test("response must correlate with the request that asked for it", async () => {
  const req = envelope("job.save", await jobSavePayload());
  validateResponseForRequest(okResponse(req.messageId), req);
  const foreign = okResponse("99999999-9999-4999-8999-999999999999");
  assert.equal(await code(() => validateResponseForRequest(foreign, req)), "invalid_payload");
  // The structural entry point never sees the request, so it still accepts it.
  validateResponse(foreign, "job.save");
});

test("snapshot ACK cursor is bounded by the request chunkCount", async () => {
  // The request asks for chunk 0 of 2, so only an ACK for chunk 0 answers it; index
  // matching is covered by its own test below.
  const req = envelope("snapshot.chunk", { chunkIndex: 0, chunkCount: 2 });
  const ack = (payload) => okResponse(req.messageId, { ackKind: "chunk", ...payload });
  validateResponseForRequest(ack({ chunkIndex: 0, chunkCursor: 1 }), req);
  validateResponseForRequest(ack({ chunkIndex: 0, chunkCursor: 2 }), req);
  assert.equal(
    await code(() => validateResponseForRequest(ack({ chunkIndex: 0, chunkCursor: 3 }), req)),
    "invalid_payload",
  );
  assert.equal(
    await code(() => validateResponseForRequest(ack({ chunkIndex: 2, chunkCursor: 1 }), req)),
    "invalid_payload",
  );
});

function reconcileReq(items) {
  return envelope("outbox.reconcile", { items });
}
const RESULT_ID = "55555555-5555-4555-8555-555555555555";
const RECON_ITEM = {
  clientInstanceId: CLIENT,
  messageId: MSG,
  sourceRestoreEpoch: EPOCH,
  payloadSha256: "1ea8fcf15e56dd83a5e7f8e9adb0c34b94bc28fd5c1b51400ecf597d1f5cc8c4",
};

test("snapshot ACK identity must match the chunk that was requested", async () => {
  const req = envelope("snapshot.chunk", {
    snapshotId: "66666666-6666-4666-8666-666666666666",
    chunkIndex: 1,
    chunkCount: 2,
  });
  const ack = (payload) => okResponse(req.messageId, payload);
  validateResponseForRequest(ack({ ackKind: "chunk", chunkIndex: 1, chunkCursor: 2 }), req);
  assert.equal(
    await code(() => validateResponseForRequest(ack({ ackKind: "chunk", chunkIndex: 0, chunkCursor: 1 }), req)),
    "invalid_payload",
  );
  // A complete ACK releases the plugin's IndexedDB copy, so its snapshot must match.
  validateResponseForRequest(
    ack({ ackKind: "snapshot", snapshotId: req.payload.snapshotId, chunkIndex: 1, chunkCursor: 2 }),
    req,
  );
  assert.equal(
    await code(() =>
      validateResponseForRequest(
        ack({ ackKind: "snapshot", snapshotId: "99999999-9999-4999-8999-999999999999", chunkIndex: 1, chunkCursor: 2 }),
        req,
      ),
    ),
    "invalid_payload",
  );
  assert.equal(
    await code(() => validateResponseForRequest(ack({ ackKind: "snapshot", chunkIndex: 1, chunkCursor: 2 }), req)),
    "invalid_payload",
  );
});

test("reconcile results must echo exactly the items that were asked about", async () => {
  const req = reconcileReq([RECON_ITEM]);
  const res = (items) => okResponse(req.messageId, { items });
  validateResponseForRequest(res([{ ...RECON_ITEM, status: "applied", resultId: RESULT_ID }]), req);
  assert.equal(
    await code(() =>
      validateResponseForRequest(
        res([{ ...RECON_ITEM, messageId: "99999999-9999-4999-8999-999999999999", status: "applied", resultId: RESULT_ID }]),
        req,
      ),
    ),
    "invalid_payload",
  );
  assert.equal(
    await code(() =>
      validateResponseForRequest(
        res([{ ...RECON_ITEM, status: "applied", resultId: RESULT_ID }, { ...RECON_ITEM, status: "purged" }]),
        req,
      ),
    ),
    "invalid_payload",
  );
});
