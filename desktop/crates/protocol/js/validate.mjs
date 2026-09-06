import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rules = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "rules.json"), "utf8"),
);

export const MAX_ENVELOPE_BYTES = rules.maxEnvelopeBytes;
export const MAX_RECONCILE_ITEMS = rules.maxReconcileItems;

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const FORBIDDEN_KEYS = ["apikey", "api_key", "api-key", "authorization", "cookie", "password", "otp", "token", "secret"];

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
      if (FORBIDDEN_KEYS.some((f) => key === f || key.includes(f))) {
        throw fail("secret_forbidden", `forbidden key ${k}`, "secrets");
      }
      walkSecrets(v);
    }
    return;
  }
  if (typeof value === "string" && (value.includes("sk-") || value.toLowerCase().includes("bearer "))) {
    throw fail("secret_forbidden", "payload looks like a secret", "secrets");
  }
}

function requireUuid(obj, key) {
  const v = obj[key];
  if (typeof v !== "string" || !UUID.test(v)) {
    throw fail("invalid_payload", `${key} must be a UUID`);
  }
  return v;
}

export function validateRequestBytes(bytes) {
  if (bytes.length > MAX_ENVELOPE_BYTES) {
    throw fail(
      "payload_too_large",
      `envelope is ${bytes.length} UTF-8 bytes; max is ${MAX_ENVELOPE_BYTES} (complete JSON, not raw chunk)`,
      "size",
    );
  }
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  let value;
  try {
    value = JSON.parse(text);
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
  if (!rules.messageTypes.includes(type)) {
    throw fail("unknown_message_type", `unknown messageType ${type}`);
  }
  if (value.protocolVersion < rules.minProtocolVersion || value.protocolVersion > rules.maxProtocolVersion) {
    throw fail("protocol_incompatible", "protocolVersion outside supported range");
  }
  requireUuid(value, "messageId");
  requireUuid(value, "clientInstanceId");
  if (typeof value.occurredAt !== "string" || !TIME.test(value.occurredAt)) {
    throw fail("invalid_payload", "occurredAt must be UTC RFC3339 (...Z)");
  }
  if (!value.payload || typeof value.payload !== "object") {
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
  if (hasArchive) requireUuid(value, "archiveId");
  if (hasEpoch) requireUuid(value, "restoreEpoch");
  if (rules.writeTypes.includes(type)) {
    requireUuid(value.payload, "sourceRestoreEpoch");
    if (type === "snapshot.chunk") {
      if (typeof value.payload.chunkSha256 !== "string" || !SHA.test(value.payload.chunkSha256)) {
        throw fail("invalid_payload", "chunkSha256 must be lowercase hex SHA-256");
      }
      if (value.payload.chunkIndex < 0 || value.payload.chunkIndex >= value.payload.chunkCount) {
        throw fail("invalid_payload", "chunkIndex must be in 0..chunkCount");
      }
    } else if (typeof value.payload.payloadSha256 !== "string" || !SHA.test(value.payload.payloadSha256)) {
      throw fail("invalid_payload", "payloadSha256 must be lowercase hex SHA-256");
    }
  }
  if (type === "outbox.reconcile") {
    const items = value.payload.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_RECONCILE_ITEMS) {
      throw fail("invalid_payload", `outbox.reconcile items must be 1..${MAX_RECONCILE_ITEMS}`);
    }
    for (const item of items) {
      if (item.clientInstanceId !== value.clientInstanceId) {
        throw fail("invalid_payload", "outbox.reconcile items must use the caller clientInstanceId");
      }
    }
  }
  if (type === "handshake") {
    const { minProtocolVersion, maxProtocolVersion } = value.payload;
    if (
      maxProtocolVersion < rules.minProtocolVersion ||
      minProtocolVersion > rules.maxProtocolVersion ||
      minProtocolVersion > maxProtocolVersion
    ) {
      throw fail("protocol_incompatible", "handshake protocol ranges do not overlap");
    }
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
