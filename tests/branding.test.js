const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("the extension and desktop use one visible name without changing their identities", () => {
  const manifest = readJson("manifest.json");
  const tauri = readJson("desktop/src-tauri/tauri.conf.json");
  assert.equal(manifest.name, "网申快填");
  assert.equal(manifest.action.default_title, "网申快填");
  assert.match(manifest.description, /简历一键快填与投递管理/);
  assert.equal(tauri.productName, "网申快填");
  assert.equal(tauri.app.windows[0].title, "网申快填");
  assert.equal(tauri.identifier, "com.resumepro.desktop");
  assert.equal(tauri.bundle.windows.wix.upgradeCode, "975d2f79-b2ff-5bf3-9070-0c2642944e04");
});

test("every browser icon declared in the manifest has the expected PNG dimensions", () => {
  const manifest = readJson("manifest.json");
  for (const [size, path] of Object.entries(manifest.icons)) {
    const png = readFileSync(resolve(root, path));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", path);
    assert.equal(png.readUInt32BE(16), Number(size), path);
    assert.equal(png.readUInt32BE(20), Number(size), path);
    assert.equal(manifest.action.default_icon[size], path);
  }
});
