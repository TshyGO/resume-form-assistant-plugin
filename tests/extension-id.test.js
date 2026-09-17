"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const STORE_ID = "diagjmploldedipjdenmecmjokckelkl";
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

/** Chrome maps the first 16 bytes of SHA-256(SPKI DER) to a-p. */
function extensionIdFromPublicKey(key) {
  const der = Buffer.from(key, "base64");
  const digest = crypto.createHash("sha256").update(der).digest();
  return [...digest.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

test("manifest 公钥固定了商店扩展 ID", () => {
  assert.ok(manifest.key, "manifest.json 必须带商店公钥");
  const der = Buffer.from(manifest.key, "base64");
  const publicKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  assert.equal(publicKey.asymmetricKeyType, "rsa");
  assert.equal(extensionIdFromPublicKey(manifest.key), STORE_ID);
});

test("Rust host 白名单与商店材料写的是同一个 ID", () => {
  const rust = fs.readFileSync(
    path.join(ROOT, "desktop", "src-tauri", "src", "nm_register.rs"),
    "utf8",
  );
  assert.match(rust, new RegExp(`STORE_EXTENSION_ID[^\\n]*${STORE_ID}`));
  const listing = fs.readFileSync(path.join(ROOT, "docs", "store-listing.md"), "utf8");
  assert.match(listing, new RegExp(STORE_ID));
});
