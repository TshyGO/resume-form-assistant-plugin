import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  envelopeSchema,
  payloadSchema,
  responsePayloadSchema,
  responseSchema,
  validateSchema,
} from "./schema-lite.mjs";
import {
  MAX_ENVELOPE_BYTES,
  validateRequest,
  validateRequestBytes,
  validateResponse,
} from "./validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));

function load(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function schemaRequest(value) {
  validateSchema(value, envelopeSchema());
  if (typeof value.messageType === "string") {
    const payload = payloadSchema(value.messageType);
    if (payload) validateSchema(value.payload, payload);
  }
}

function schemaResponse(value, requestType) {
  validateSchema(value, responseSchema());
  if (value.ok) {
    const payload = responsePayloadSchema(requestType);
    if (payload) validateSchema(value.payload, payload);
  }
}

function codeOf(fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new Error("use codeOfAsync");
    }
    return null;
  } catch (e) {
    return e.code || "invalid_payload";
  }
}

async function codeOfAsync(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e.code || "invalid_payload";
  }
}

for (const entry of catalog.requests) {
  test(`catalog request ${entry.id}`, async () => {
    const value = load(entry.path);
    const schemaCode = codeOf(() => schemaRequest(value));
    if (entry.schema === "accept") assert.equal(schemaCode, null, `${entry.id} schema`);
    else assert.notEqual(schemaCode, null, `${entry.id} schema should reject`);
    const protocolCode = await codeOfAsync(() => validateRequest(value));
    if (entry.protocol.accept) assert.equal(protocolCode, null, `${entry.id} protocol`);
    else assert.equal(protocolCode, entry.protocol.code, `${entry.id} protocol`);
  });
}

for (const entry of catalog.responses) {
  test(`catalog response ${entry.id}`, () => {
    const value = load(entry.path);
    const schemaCode = codeOf(() => schemaResponse(value, entry.requestType));
    if (entry.schema === "accept") assert.equal(schemaCode, null, `${entry.id} schema`);
    else assert.notEqual(schemaCode, null, `${entry.id} schema should reject`);
    const protocolCode = codeOf(() => validateResponse(value, entry.requestType));
    if (entry.protocol.accept) assert.equal(protocolCode, null, `${entry.id} protocol`);
    else assert.equal(protocolCode, entry.protocol.code, `${entry.id} protocol`);
  });
}

test("65536/65537 UTF-8 envelope boundary", async () => {
  const { payloadBodySha256 } = await import("./validate.mjs");
  const base = load("requests/job-save-ok.json");
  delete base.payload.payloadSha256;
  base.payload.location = "";
  base.payload.payloadSha256 = await payloadBodySha256(base.payload);
  const baseBytes = Buffer.from(JSON.stringify(base), "utf8");
  delete base.payload.payloadSha256;
  base.payload.location = "a".repeat(MAX_ENVELOPE_BYTES - baseBytes.length);
  base.payload.payloadSha256 = await payloadBodySha256(base.payload);
  const bytes = Buffer.from(JSON.stringify(base), "utf8");
  assert.equal(bytes.length, MAX_ENVELOPE_BYTES);
  await validateRequestBytes(bytes);
  const tooBig = Buffer.concat([bytes, Buffer.from(" ")]);
  assert.equal(tooBig.length, 65537);
  assert.equal(await codeOfAsync(() => validateRequestBytes(tooBig)), "payload_too_large");
});

test("previously rejected JS cases are now rejected", async () => {
  assert.equal(await codeOfAsync(() => validateRequest(load("requests/missing-protocolVersion.json"))), "invalid_payload");
  assert.equal(await codeOfAsync(() => validateRequest(load("requests/protocolVersion-string.json"))), "invalid_payload");
  assert.equal(await codeOfAsync(() => validateRequest(load("requests/job-save-missing-company.json"))), "invalid_payload");
  assert.equal(await codeOfAsync(() => validateRequest(load("requests/job-save-url-token.json"))), "secret_forbidden");
  assert.equal(codeOf(() => validateResponse(load("responses/handshake-empty-payload.json"), "handshake")), "invalid_payload");
  assert.equal(codeOf(() => validateResponse(load("responses/protocolVersion-2.json"), "job.save")), "protocol_incompatible");
  assert.equal(codeOf(() => validateResponse(load("responses/conflict-retryable-true.json"), "job.save")), "invalid_payload");
});

test("browser entry has no node: imports", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "validate.mjs"), "utf8");
  const lite = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema-lite.mjs"), "utf8");
  assert.equal(src.includes("node:"), false);
  assert.equal(lite.includes("node:"), false);
});

