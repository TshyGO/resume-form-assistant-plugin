const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The extension cannot load files from outside its own root, so the D05 validator is
// vendored into link/protocol/. This test is the lock: change the source and the plugin
// suite goes red until the copy is refreshed. There is deliberately no second
// implementation of the protocol rules in this repository.
const SOURCE_DIR = path.join(__dirname, '..', 'desktop', 'crates', 'protocol', 'js');
const VENDOR_DIR = path.join(__dirname, '..', 'link', 'protocol');
const FILES = ['validate.mjs', 'schema-lite.mjs', 'schema-data.mjs', 'time.mjs'];

for (const file of FILES) {
  test(`vendored ${file} is byte-identical to the D05 source`, () => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, file));
    const vendored = fs.readFileSync(path.join(VENDOR_DIR, file));
    assert.deepEqual(vendored, source);
  });
}

test('the vendored validator imports nothing outside its own directory', () => {
  for (const file of FILES) {
    const text = fs.readFileSync(path.join(VENDOR_DIR, file), 'utf8');
    const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('./'),
        `${file} imports ${specifier}; the service worker can only resolve siblings`
      );
    }
  }
});

test('the vendored validator runs under the browser globals the service worker has', async () => {
  const validate = await import('../link/protocol/validate.mjs');
  assert.equal(validate.MAX_ENVELOPE_BYTES, 65536);
  assert.equal(validate.MAX_RECONCILE_ITEMS, 32);
  // Digests come from Web Crypto, which the service worker and node both expose globally.
  assert.equal(
    await validate.sha256Hex(new TextEncoder().encode('')),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});
