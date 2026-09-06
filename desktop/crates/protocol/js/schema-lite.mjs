import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUtcTimestamp } from "./time.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

export function envelopeSchema() {
  return loadJson("schemas/request-envelope.json");
}

export function responseSchema() {
  return loadJson("schemas/response-envelope.json");
}

const PAYLOAD_FILES = {
  health: "schemas/payloads/health.json",
  handshake: "schemas/payloads/handshake.json",
  "application.queryCandidates": "schemas/payloads/query-candidates.json",
  "job.save": "schemas/payloads/job-save.json",
  "fill.submit": "schemas/payloads/fill-submit.json",
  "snapshot.chunk": "schemas/payloads/snapshot-chunk.json",
  "submit.confirm": "schemas/payloads/submit-confirm.json",
  "outbox.reconcile": "schemas/payloads/outbox-reconcile.json",
};

export function payloadSchema(messageType) {
  const file = PAYLOAD_FILES[messageType];
  return file ? loadJson(file) : null;
}

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
