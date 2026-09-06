import { isUtcTimestamp } from "./time.mjs";
import { SCHEMA_DATA } from "./schema-data.mjs";

export function envelopeSchema() {
  return SCHEMA_DATA.envelope;
}

export function responseSchema() {
  return SCHEMA_DATA.response;
}

const PAYLOAD_KEYS = {
  health: "health",
  handshake: "handshake",
  "application.queryCandidates": "query-candidates",
  "job.save": "job-save",
  "fill.submit": "fill-submit",
  "snapshot.chunk": "snapshot-chunk",
  "submit.confirm": "submit-confirm",
  "outbox.reconcile": "outbox-reconcile",
};

const RESPONSE_PAYLOAD_KEYS = {
  health: "health",
  handshake: "handshake",
  "application.queryCandidates": "query-candidates",
  "job.save": "write",
  "fill.submit": "write",
  "submit.confirm": "write",
  "snapshot.chunk": "snapshot-chunk",
  "outbox.reconcile": "outbox-reconcile",
};

export function payloadSchema(messageType) {
  const key = PAYLOAD_KEYS[messageType];
  return key ? SCHEMA_DATA.payloads[key] : null;
}

export function responsePayloadSchema(messageType) {
  const key = RESPONSE_PAYLOAD_KEYS[messageType];
  return key ? SCHEMA_DATA.responses[key] : null;
}

export const RULES = SCHEMA_DATA.rules;

function fail(message) {
  const err = new Error(`invalid_payload: ${message}`);
  err.code = "invalid_payload";
  err.layer = "structure";
  err.retryable = false;
  return err;
}

function isUuid(value) {
  const parts = value.split("-");
  return (
    parts.length === 5 &&
    parts[0].length === 8 &&
    parts[1].length === 4 &&
    parts[2].length === 4 &&
    parts[3].length === 4 &&
    parts[4].length === 12 &&
    [...value].every((c) => /[0-9a-fA-F-]/.test(c))
  );
}

function syntacticTimestamp(value) {
  if (typeof value !== "string" || !value.endsWith("Z") || value.length < 20) return false;
  const m = value.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?Z$/);
  return Boolean(m);
}

function patternMatches(value, pattern) {
  if (pattern.includes("[0-9a-fA-F]{8}-")) return isUuid(value);
  if (pattern === "^[0-9a-f]{64}$") return /^[0-9a-f]{64}$/.test(value);
  if (pattern.includes("T[0-9]{2}:[0-9]{2}:[0-9]{2}")) return syntacticTimestamp(value);
  throw fail(`unsupported schema pattern ${pattern}`);
}

export function validateSchema(instance, schema) {
  if (schema.type === "object") {
    if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
      throw fail("value must be an object");
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) {
        if (!(key in properties)) throw fail(`unexpected field ${key}`);
      }
    }
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(instance, key)) {
        throw fail(`missing field ${key}`);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(instance, key)) {
        validateSchema(instance[key], sub);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(instance)) throw fail("value must be an array");
    if (schema.minItems != null && instance.length < schema.minItems) throw fail("array too short");
    if (schema.maxItems != null && instance.length > schema.maxItems) throw fail("array too long");
    if (schema.items) {
      for (const item of instance) validateSchema(item, schema.items);
    }
  } else if (schema.type === "string") {
    if (typeof instance !== "string") throw fail("value must be a string");
    if (schema.minLength != null && [...instance].length < schema.minLength) throw fail("string too short");
    if (schema.maxLength != null && [...instance].length > schema.maxLength) throw fail("string too long");
    if (schema.pattern && !patternMatches(instance, schema.pattern)) throw fail("string does not match pattern");
  } else if (schema.type === "integer") {
    if (!Number.isInteger(instance)) throw fail("value must be an integer");
    if (schema.minimum != null && instance < schema.minimum) throw fail("integer below minimum");
    if (schema.maximum != null && instance > schema.maximum) throw fail("integer above maximum");
  } else if (schema.type === "boolean") {
    if (typeof instance !== "boolean") throw fail("value must be a boolean");
  }
  if (schema.enum && !schema.enum.some((v) => Object.is(v, instance) || v === instance)) {
    throw fail("value is not in enum");
  }
}

export { isUtcTimestamp };
