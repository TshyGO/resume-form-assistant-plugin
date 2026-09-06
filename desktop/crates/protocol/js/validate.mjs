import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envelopeSchema,
  payloadSchema,
  responseSchema,
  validateSchema,
} from "./schema-lite.mjs";
import { isUtcTimestamp } from "./time.mjs";

const rules = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "rules.json"), "utf8"),
);

export const MAX_ENVELOPE_BYTES = rules.maxEnvelopeBytes;
export const MAX_RECONCILE_ITEMS = rules.maxReconcileItems;
export const MAX_CHUNK_COUNT = rules.maxChunkCount;
export const MAX_SNAPSHOT_BYTES = rules.maxSnapshotBytes;

const FORBIDDEN_KEYS = ["apikey", "api_key", "api-key", "authorization", "cookie", "set-cookie", "password", "otp", "token", "secret"];

function fail(code, message, layer = "structure") {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.retryable = code === "unavailable";
  err.layer = layer;
  return err;
}

function utf8Len(text) {
  return Buffer.byteLength(text, "utf8");
}

function walkSecrets(value) {
  if (Array.isArray(value)) {
    value.forEach(walkSecrets);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase();
      if (FORBIDDEN_KEYS.some((f) => key === f || key.replaceAll("_", "-") === f)) {
        throw fail("secret_forbidden", `forbidden key ${k}`, "secrets");
      }
      walkSecrets(v);
    }
    return;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    const apiKeyLike = lower
      .split(/[^a-z0-9\-_]+/)
      .some((token) => token.startsWith("sk-") && token.length >= 20);
    if (apiKeyLike || lower.includes("bearer ")) {
      throw fail("secret_forbidden", "payload looks like a secret", "secrets");
    }
  }
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadBodySha256(payload) {
  const copy = { ...payload };
  delete copy.payloadSha256;
  return sha256Hex(Buffer.from(canonicalJson(copy), "utf8"));
}

export function decodeStandardBase64(text) {
  if (typeof text !== "string" || /\s/.test(text)) {
    throw fail("invalid_payload", "bytesBase64 must not contain whitespace");
  }
  const buf = Buffer.from(text, "base64");
  if (buf.length === 0 && text.length > 0) {
    throw fail("invalid_payload", "bytesBase64 is not strict standard Base64");
  }
  if (buf.toString("base64") !== text) {
    throw fail("invalid_payload", "bytesBase64 is not strict standard Base64");
  }
  return buf;
}

export function validateRequestBytes(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  if (buf.length > MAX_ENVELOPE_BYTES) {
    throw fail(
      "payload_too_large",
      `envelope is ${buf.length} UTF-8 bytes; max is ${MAX_ENVELOPE_BYTES} (complete JSON, not raw chunk)`,
      "size",
    );
  }
  let value;
  try {
    value = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw fail("invalid_payload", `invalid JSON: ${e.message}`);
  }
  return validateRequest(value);
}

export function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("invalid_payload", "request must be an object");
  }
  const type = value.messageType;
  if (type === "SaveIntent" || type === "saveIntent" || type === "save.intent") {
    throw fail("unknown_message_type", "SaveIntent is a plugin-local object, not a Native Messaging messageType");
  }
  if (typeof type === "string" && !rules.messageTypes.includes(type)) {
    throw fail("unknown_message_type", `unknown messageType ${type}`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "protocolVersion")) {
    if (!Number.isInteger(value.protocolVersion)) {
      throw fail("invalid_payload", "protocolVersion must be an integer");
    }
    if (value.protocolVersion < rules.minProtocolVersion || value.protocolVersion > rules.maxProtocolVersion) {
      throw fail("protocol_incompatible", "protocolVersion outside supported range");
    }
  }
  try {
    validateSchema(value, envelopeSchema());
  } catch (e) {
    if (e.code) throw e;
    throw fail("invalid_payload", e.message);
  }
  if (!isUtcTimestamp(value.occurredAt)) {
    throw fail("invalid_payload", "occurredAt must be a real UTC RFC3339 timestamp (...Z)");
  }
  if (Array.isArray(value.payload) || !value.payload || typeof value.payload !== "object") {
    throw fail("invalid_payload", "payload must be an object");
  }
  walkSecrets(value.payload);
  const hasArchive = Object.prototype.hasOwnProperty.call(value, "archiveId");
  const hasEpoch = Object.prototype.hasOwnProperty.call(value, "restoreEpoch");
  if (rules.identityForbidden.includes(type) && (hasArchive || hasEpoch)) {
    throw fail("identity_not_allowed", `${type} must not carry archiveId/restoreEpoch`, "identity");
  }
  if (rules.identityRequired.includes(type) && (!hasArchive || !hasEpoch)) {
    throw fail("identity_missing", `${type} requires archiveId and restoreEpoch`, "identity");
  }
  const schema = payloadSchema(type);
  if (schema) {
    try {
      validateSchema(value.payload, schema);
    } catch (e) {
      if (e.code) throw e;
      throw fail("invalid_payload", e.message);
    }
  }
  if (rules.writeTypes.includes(type) && type !== "snapshot.chunk") {
    const actual = payloadBodySha256(value.payload);
    if (value.payload.payloadSha256 !== actual) {
      throw fail("invalid_payload", "payloadSha256 does not match the payload body");
    }
  }
  if (type === "snapshot.chunk") {
    if (value.payload.chunkIndex >= value.payload.chunkCount) {
      throw fail("invalid_payload", "chunkIndex must be in 0..chunkCount");
    }
    const decoded = decodeStandardBase64(value.payload.bytesBase64);
    if (decoded.length === 0 || decoded.length > value.payload.byteSize) {
      throw fail("invalid_payload", "decoded chunk length is empty or exceeds snapshot byteSize");
    }
    if (sha256Hex(decoded) !== value.payload.chunkSha256) {
      throw fail("invalid_payload", "chunkSha256 does not match decoded bytes");
    }
    if (value.payload.chunkCount === 1) {
      if (decoded.length !== value.payload.byteSize || sha256Hex(decoded) !== value.payload.snapshotSha256) {
        throw fail("invalid_payload", "single-chunk snapshot hash or length mismatch");
      }
    }
  }
  if (type === "outbox.reconcile") {
    for (const item of value.payload.items) {
      if (item.clientInstanceId !== value.clientInstanceId) {
        throw fail("invalid_payload", "outbox.reconcile items must use the caller clientInstanceId");
      }
    }
  }
  if (type === "handshake") {
    const { minProtocolVersion, maxProtocolVersion } = value.payload;
    if (
      !Number.isInteger(minProtocolVersion) ||
      !Number.isInteger(maxProtocolVersion) ||
      maxProtocolVersion < rules.minProtocolVersion ||
      minProtocolVersion > rules.maxProtocolVersion ||
      minProtocolVersion > maxProtocolVersion
    ) {
      throw fail("protocol_incompatible", "handshake protocol ranges do not overlap");
    }
  }
  return value;
}

export function validateResponse(value, requestType) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("invalid_payload", "response must be an object");
  }
  validateSchema(value, responseSchema());
  if (Array.isArray(value.payload)) throw fail("invalid_payload", "payload must be an object");
  if (value.ok) {
    if (value.error) throw fail("invalid_payload", "ok:true response must not include error");
    if (rules.writeTypes.includes(requestType) && typeof value.resultId !== "string") {
      throw fail("invalid_payload", "ok:true write response requires resultId");
    }
    if (requestType === "snapshot.chunk" && value.payload.ackKind !== "chunk" && value.payload.ackKind !== "snapshot") {
      throw fail("invalid_payload", "snapshot.chunk ACK must set payload.ackKind to chunk or snapshot");
    }
  } else if (value.resultId) {
    throw fail("invalid_payload", "ok:false response must not include resultId");
  }
  return value;
}

export function checkCurrentIdentity(req, current) {
  if (rules.identityForbidden.includes(req.messageType)) return;
  if (!current) {
    throw fail("unavailable", "desktop current archive pointer is not available", "business");
  }
  if (req.archiveId !== current.archiveId || req.restoreEpoch !== current.restoreEpoch) {
    throw fail(
      "restore_epoch_mismatch",
      "envelope archiveId/restoreEpoch is not the current archive identity; the host must not rewrite it",
      "business",
    );
  }
  if (rules.writeTypes.includes(req.messageType) && req.payload.sourceRestoreEpoch !== current.restoreEpoch) {
    throw fail(
      "restore_epoch_mismatch",
      "sourceRestoreEpoch is not the current epoch; do not replay — use outbox.reconcile",
      "business",
    );
  }
}

export function utf8JsonLen(value) {
  return utf8Len(JSON.stringify(value));
}

export function originAllowed(origin, allowed) {
  if (!origin || origin.includes("*")) return false;
  return allowed.some((item) => item === origin && !item.includes("*"));
}
