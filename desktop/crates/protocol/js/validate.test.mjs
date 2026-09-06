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

function jobSavePayload(extra = {}) {
  const payload = {
    sourceRestoreEpoch: EPOCH,
    company: "合成公司",
    title: "后端实习",
    ...extra,
  };
  payload.payloadSha256 = payloadBodySha256(payload);
  return payload;
}

function code(fn) {
  try {
    fn();
    throw new Error("expected failure");
  } catch (e) {
    return e.code;
  }
}

test("health/handshake identity exception", () => {
  validateRequest(envelope("health", {}));
  validateRequest(
    envelope("handshake", { pluginVersion: "0.3.0", minProtocolVersion: 1, maxProtocolVersion: 1 }),
  );
  assert.equal(
    code(() => validateRequest(envelope("health", {}, { archiveId: ARCHIVE, restoreEpoch: EPOCH }))),
    "identity_not_allowed",
  );
});

test("write identity missing and SaveIntent rejected", () => {
  const v = envelope("job.save", jobSavePayload());
  delete v.archiveId;
  assert.equal(code(() => validateRequest(v)), "identity_missing");
  assert.equal(code(() => validateRequest(envelope("SaveIntent", { intentId: MSG }))), "unknown_message_type");
});

test("structure ok does not grant write when epoch is old", () => {
  const v = envelope("job.save", jobSavePayload());
  validateRequest(v);
  assert.equal(
    code(() => checkCurrentIdentity(v, { archiveId: ARCHIVE, restoreEpoch: EPOCH_OLD })),
    "restore_epoch_mismatch",
  );
});

test("65536/65537 UTF-8 envelope boundary", () => {
  const base = envelope("job.save", jobSavePayload({ location: "" }));
  const baseBytes = Buffer.from(JSON.stringify(base), "utf8");
  const v = envelope("job.save", jobSavePayload({ location: "a".repeat(MAX_ENVELOPE_BYTES - baseBytes.length) }));
  const bytes = Buffer.from(JSON.stringify(v), "utf8");
  assert.equal(bytes.length, MAX_ENVELOPE_BYTES);
  validateRequestBytes(bytes);
  const tooBig = Buffer.concat([bytes, Buffer.from(" ")]);
  assert.equal(tooBig.length, 65537);
  assert.equal(code(() => validateRequestBytes(tooBig)), "payload_too_large");
});

test("Chinese company is counted as UTF-8 bytes", () => {
  const v = envelope("job.save", jobSavePayload());
  assert.equal(v.payload.company.length, 4);
  assert.equal(Buffer.byteLength(v.payload.company, "utf8"), 12);
  validateRequest(v);
});
