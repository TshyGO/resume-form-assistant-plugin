import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkCurrentIdentity,
  MAX_ENVELOPE_BYTES,
  payloadBodySha256,
  validateRequest,
  validateRequestBytes,
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
