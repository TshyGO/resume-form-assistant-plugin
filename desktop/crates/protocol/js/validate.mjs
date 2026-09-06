import {
  envelopeSchema,
  payloadSchema,
  responsePayloadSchema,
  responseSchema,
  validateSchema,
  RULES,
} from "./schema-lite.mjs";
import { isUtcTimestamp } from "./time.mjs";

export const MAX_ENVELOPE_BYTES = RULES.maxEnvelopeBytes;
export const MAX_RECONCILE_ITEMS = RULES.maxReconcileItems;
export const MAX_CHUNK_COUNT = RULES.maxChunkCount;
export const MAX_SNAPSHOT_BYTES = RULES.maxSnapshotBytes;

const FORBIDDEN_KEYS = ["apikey", "api_key", "api-key", "authorization", "cookie", "set-cookie", "password", "otp", "token", "secret"];
const URL_FIELD_KEYS = new Set(["sourceurl", "source_url", "urlredacted", "url_redacted", "dedupeurl", "dedupe_url", "url"]);
const SECRET_QUERY_KEYS = new Set(RULES.urlSecretQueryKeys || []);
const URL_ALLOWLIST = RULES.urlAllowlist || [];
const RETRYABLE_CODES = new Set(RULES.retryableErrorCodes || ["unavailable"]);
const CHUNK_IDENTITY_KEYS = [
  "sourceRestoreEpoch",
  "snapshotId",
  "applicationId",
  "chunkIndex",
  "chunkCount",
  "chunkSha256",
  "snapshotSha256",
  "byteSize",
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function fail(code, message, layer = "structure") {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.retryable = code === "unavailable";
  err.layer = layer;
  return err;
}

export function utf8Len(text) {
  return textEncoder.encode(text).byteLength;
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

function percentDecodeTimes(input, times) {
  let current = input.replaceAll("+", " ");
  for (let i = 0; i < times; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function normalizeParamName(raw) {
  return percentDecodeTimes(raw, 3).toLowerCase().replaceAll("-", "_");
}

function valueMatches(value, pattern) {
  const match = pattern.match(/^\^REQ\[0-9\]\{(\d+),(\d+)\}\$$/);
  if (!match) return false;
  const min = Number(match[1]);
  const max = Number(match[2]);
  return (
    value.startsWith("REQ") &&
    value.length >= 3 + min &&
    value.length <= 3 + max &&
    [...value.slice(3)].every((ch) => ch >= "0" && ch <= "9")
  );
}

function isAllowlisted(host, path, param, value) {
  return URL_ALLOWLIST.some(
    (rule) =>
      rule.host.toLowerCase() === host &&
      path.startsWith(rule.pathPrefix) &&
      rule.param.toLowerCase() === param &&
      valueMatches(value, rule.valuePattern),
  );
}

function queryHasSecret(query, host, path) {
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? "" : pair.slice(eq + 1);
    const name = normalizeParamName(rawName);
    const value = percentDecodeTimes(rawValue, 3);
    if (!SECRET_QUERY_KEYS.has(name)) continue;
    if (isAllowlisted(host, path, name, value)) continue;
    return true;
  }
  return false;
}

export function checkUrl(raw) {
  if (!raw) return;
  if (!raw.startsWith("https://") || raw.includes(" ")) {
    throw fail("secret_forbidden", "URL must be https without credentials", "secrets");
  }
  const rest = raw.slice("https://".length);
  // Keep encoded delimiters in their component; split only literal boundaries.
  const boundary = rest.search(/[/?#]/);
  const authority = boundary === -1 ? rest : rest.slice(0, boundary);
  const pathQueryFrag = boundary === -1 ? "" : rest.slice(boundary);
  if (authority.includes("@")) {
    throw fail("secret_forbidden", "URL userinfo is not allowed", "secrets");
  }
  const host = (authority.split(":")[0] || "").toLowerCase();
  const hash = pathQueryFrag.indexOf("#");
  const pathQuery = hash === -1 ? pathQueryFrag : pathQueryFrag.slice(0, hash);
  const fragment = hash === -1 ? "" : pathQueryFrag.slice(hash + 1);
  const q = pathQuery.indexOf("?");
  const path = q === -1 ? pathQuery : pathQuery.slice(0, q);
  const query = q === -1 ? "" : pathQuery.slice(q + 1);
  if (fragment && queryHasSecret(fragment, host, path)) {
    throw fail("secret_forbidden", "URL fragment contains a credential parameter", "secrets");
  }
  if (query && queryHasSecret(query, host, path)) {
    throw fail("secret_forbidden", "URL query contains a credential parameter", "secrets");
  }
}

function walkUrls(value) {
  if (Array.isArray(value)) {
    value.forEach(walkUrls);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase().replaceAll("-", "_");
      if (URL_FIELD_KEYS.has(key) && typeof v === "string") checkUrl(v);
      walkUrls(v);
    }
  }
}

export async function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

export async function payloadBodySha256(payload) {
  const copy = { ...payload };
  delete copy.payloadSha256;
  return sha256Hex(textEncoder.encode(canonicalJson(copy)));
}

export async function snapshotChunkIdentitySha256(payload) {
  const identity = {};
  for (const key of CHUNK_IDENTITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      throw fail("invalid_payload", `snapshot.chunk missing ${key} for identity digest`);
    }
    identity[key] = payload[key];
  }
  return sha256Hex(textEncoder.encode(canonicalJson(identity)));
}

function bytesToBinary(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

export function decodeStandardBase64(text) {
  if (typeof text !== "string" || /\s/.test(text)) {
    throw fail("invalid_payload", "bytesBase64 must not contain whitespace");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw fail("invalid_payload", "bytesBase64 is not strict standard Base64");
  }
  let binary;
  try {
    binary = atob(text);
  } catch {
    throw fail("invalid_payload", "bytesBase64 is not strict standard Base64");
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (btoa(bytesToBinary(bytes)) !== text) {
    throw fail("invalid_payload", "bytesBase64 is not strict standard Base64");
  }
  return bytes;
}

export async function validateRequestBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : textEncoder.encode(typeof bytes === "string" ? bytes : textDecoder.decode(bytes));
  if (buf.length > MAX_ENVELOPE_BYTES) {
    throw fail(
      "payload_too_large",
      `envelope is ${buf.length} UTF-8 bytes; max is ${MAX_ENVELOPE_BYTES} (complete JSON, not raw chunk)`,
      "size",
    );
  }
  let value;
  try {
    value = JSON.parse(textDecoder.decode(buf));
  } catch (e) {
    throw fail("invalid_payload", `invalid JSON: ${e.message}`);
  }
  return validateRequest(value);
}

export async function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail("invalid_payload", "request must be an object");
  }
  const type = value.messageType;
  if (type === "SaveIntent" || type === "saveIntent" || type === "save.intent") {
    throw fail("unknown_message_type", "SaveIntent is a plugin-local object, not a Native Messaging messageType");
  }
  if (typeof type === "string" && !RULES.messageTypes.includes(type)) {
    throw fail("unknown_message_type", `unknown messageType ${type}`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "protocolVersion")) {
    if (!Number.isInteger(value.protocolVersion)) {
      throw fail("invalid_payload", "protocolVersion must be an integer");
    }
    if (value.protocolVersion < RULES.minProtocolVersion || value.protocolVersion > RULES.maxProtocolVersion) {
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
  if (RULES.identityForbidden.includes(type) && (hasArchive || hasEpoch)) {
    throw fail("identity_not_allowed", `${type} must not carry archiveId/restoreEpoch`, "identity");
  }
  if (RULES.identityRequired.includes(type) && (!hasArchive || !hasEpoch)) {
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
  walkUrls(value.payload);
  if (RULES.writeTypes.includes(type) && type !== "snapshot.chunk") {
    const actual = await payloadBodySha256(value.payload);
    if (value.payload.payloadSha256 !== actual) {
      throw fail("invalid_payload", "payloadSha256 does not match the payload body");
    }
  }
  if (type === "fill.submit") {
    const hasSnapshot = typeof value.payload.snapshotId === "string";
    const hasSha = typeof value.payload.sha256 === "string";
    if (hasSnapshot !== hasSha) {
      throw fail("invalid_payload", "fill.submit snapshotId and sha256 must be supplied together");
    }
    const { fieldCount, filledCount, unconfirmedCount } = value.payload;
    if (Number.isInteger(fieldCount) && Number.isInteger(filledCount) && Number.isInteger(unconfirmedCount)) {
      if (filledCount + unconfirmedCount > fieldCount) {
        throw fail("invalid_payload", "filledCount + unconfirmedCount exceeds fieldCount");
      }
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
    if ((await sha256Hex(decoded)) !== value.payload.chunkSha256) {
      throw fail("invalid_payload", "chunkSha256 does not match decoded bytes");
    }
    await snapshotChunkIdentitySha256(value.payload);
    if (value.payload.chunkCount === 1) {
      if (decoded.length !== value.payload.byteSize || (await sha256Hex(decoded)) !== value.payload.snapshotSha256) {
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
      maxProtocolVersion < RULES.minProtocolVersion ||
      minProtocolVersion > RULES.maxProtocolVersion ||
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
  if (Object.prototype.hasOwnProperty.call(value, "protocolVersion")) {
    if (!Number.isInteger(value.protocolVersion)) {
      throw fail("invalid_payload", "protocolVersion must be an integer");
    }
    if (value.protocolVersion < RULES.minProtocolVersion || value.protocolVersion > RULES.maxProtocolVersion) {
      throw fail("protocol_incompatible", "protocolVersion outside supported range");
    }
  }
  validateSchema(value, responseSchema());
  if (Array.isArray(value.payload)) throw fail("invalid_payload", "payload must be an object");
  if (value.ok) {
    if (value.error) throw fail("invalid_payload", "ok:true response must not include error");
    if (RULES.writeTypes.includes(requestType) && typeof value.resultId !== "string") {
      throw fail("invalid_payload", "ok:true write response requires resultId");
    }
    const payloadSchemaForType = responsePayloadSchema(requestType);
    if (payloadSchemaForType) validateSchema(value.payload, payloadSchemaForType);
    if (requestType === "handshake") {
      const { minProtocolVersion, maxProtocolVersion } = value.payload;
      if (
        maxProtocolVersion < RULES.minProtocolVersion ||
        minProtocolVersion > RULES.maxProtocolVersion ||
        minProtocolVersion > maxProtocolVersion
      ) {
        throw fail("protocol_incompatible", "handshake response protocol ranges do not overlap");
      }
    }
    if (requestType === "snapshot.chunk") {
      if (value.payload.ackKind !== "chunk" && value.payload.ackKind !== "snapshot") {
        throw fail("invalid_payload", "snapshot.chunk ACK must set payload.ackKind to chunk or snapshot");
      }
      if (value.payload.ackKind === "snapshot" && typeof value.payload.snapshotId !== "string") {
        throw fail("invalid_payload", "ackKind snapshot requires snapshotId");
      }
    }
    if (requestType === "outbox.reconcile") {
      for (const item of value.payload.items) {
        if (item.status === "applied" && !item.resultId) {
          throw fail("invalid_payload", "reconcile applied item requires resultId");
        }
        if (item.status !== "applied" && item.resultId) {
          throw fail("invalid_payload", "reconcile non-applied item must not include resultId");
        }
      }
    }
    walkUrls(value.payload);
  } else if (value.resultId) {
    throw fail("invalid_payload", "ok:false response must not include resultId");
  } else {
    const expected = RETRYABLE_CODES.has(value.error?.code);
    if (value.error?.retryable !== expected) {
      throw fail("invalid_payload", "error.retryable does not match error.code");
    }
  }
  return value;
}

export function checkCurrentIdentity(req, current) {
  if (RULES.identityForbidden.includes(req.messageType)) return;
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
  if (RULES.writeTypes.includes(req.messageType) && req.payload.sourceRestoreEpoch !== current.restoreEpoch) {
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
