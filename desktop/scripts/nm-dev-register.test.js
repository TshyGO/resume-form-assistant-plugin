import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HOST_NAME,
  manifestFor,
  readReceipt,
  register,
  targetsFor,
  unregister,
} from "./nm-dev-register.mjs";

/// A filesystem and registry that live in memory, so these tests never touch the browser
/// configuration of the machine they run on.
function fakeIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  const registry = new Map();
  return {
    files,
    registry,
    exists: (file) => files.has(file),
    read: (file) => files.get(file),
    write: (file, value) => files.set(file, `${JSON.stringify(value, null, 2)}\n`),
    remove: (file) => files.delete(file),
    readRegistry: (key) => registry.get(key) ?? null,
    writeRegistry: (key, value) => registry.set(key, value),
    deleteRegistry: (key) => registry.delete(key),
  };
}

const WINDOWS = {
  platform: "win32",
  home: "C:\\Users\\dev",
  localAppData: "C:\\Users\\dev\\AppData\\Local",
};
const MAC = { platform: "darwin", home: "/Users/dev", localAppData: "" };
const ID = "abcdefghijklmnopabcdefghijklmnop";
const BINARY_WIN = "C:\\Program Files\\Resume Pro\\resume-pro-desktop.exe";
const BINARY_MAC = "/Applications/Resume Pro.app/Contents/MacOS/resume-pro-desktop";

function receiptFile(env) {
  const io = fakeIo();
  register({ ...env, binaryPath: env.platform === "win32" ? BINARY_WIN : BINARY_MAC, extensionIds: [ID] }, io);
  return [...io.files.keys()].find((f) => f.endsWith("receipt.json"));
}

test("a manifest names only the extensions that were asked for", () => {
  const manifest = manifestFor(BINARY_WIN, [ID], "win32");
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, "stdio");
  assert.equal(manifest.path, BINARY_WIN);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
});

test("a wildcard or malformed origin is refused rather than written", () => {
  // A manifest is what decides who may start the host. Anything that is not an id would
  // either be rejected by the browser or, worse, widen who can reach the archive.
  assert.throws(() => manifestFor(BINARY_WIN, ["*"], "win32"), /not an extension id/);
  assert.throws(
    () => manifestFor(BINARY_WIN, ["chrome-extension://*/"], "win32"),
    /not an extension id/,
  );
  assert.throws(() => manifestFor(BINARY_WIN, [], "win32"), /at least one extension id/);
});

test("the host path must be absolute", () => {
  // A relative path resolves against the browser's working directory, not the developer's.
  assert.throws(
    () => manifestFor("resume-pro-desktop.exe", [ID], "win32"),
    /must be absolute/,
  );
});

test("Windows registration writes both browser keys and points them at the manifest", () => {
  const io = fakeIo();
  const result = register({ ...WINDOWS, binaryPath: BINARY_WIN, extensionIds: [ID] }, io);
  assert.equal(result.applied, true);
  assert.equal(result.planned.length, 2);
  for (const target of result.planned) {
    assert.equal(io.registry.get(target.registryKey), target.manifestPath);
    assert.equal(JSON.parse(io.files.get(target.manifestPath)).path, BINARY_WIN);
  }
  // Chrome must not be reached through Edge's fallback to the Chromium key: each browser
  // gets its own registration.
  assert.ok([...io.registry.keys()].some((k) => k.includes("Google\\Chrome")));
  assert.ok([...io.registry.keys()].some((k) => k.includes("Microsoft\\Edge")));
});

test("macOS registration writes the two user-level directories and no registry", () => {
  const io = fakeIo();
  const result = register({ ...MAC, binaryPath: BINARY_MAC, extensionIds: [ID] }, io);
  assert.equal(result.planned.length, 2);
  assert.equal(io.registry.size, 0);
  const written = [...io.files.keys()];
  assert.ok(written.some((f) => f.includes("/Google/Chrome/NativeMessagingHosts/")));
  assert.ok(written.some((f) => f.includes("/Microsoft Edge/NativeMessagingHosts/")));
});

test("an existing registration this script did not write is skipped, not replaced", () => {
  // The developer may already have a real host installed. An unregister cannot put back a
  // file it never saw, so replacing one would break their setup with no way back.
  const [chrome] = targetsFor({ ...WINDOWS, browsers: ["chrome"] });
  const io = fakeIo({ [chrome.manifestPath]: '{"name":"someone.elses.host"}\n' });
  const result = register(
    { ...WINDOWS, browsers: ["chrome"], binaryPath: BINARY_WIN, extensionIds: [ID] },
    io,
  );
  assert.equal(result.planned.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(io.files.get(chrome.manifestPath), '{"name":"someone.elses.host"}\n');
});

test("unregister removes exactly what register added", () => {
  const io = fakeIo();
  register({ ...WINDOWS, binaryPath: BINARY_WIN, extensionIds: [ID] }, io);
  const manifests = [...io.files.keys()].filter((f) => !f.endsWith("receipt.json"));
  assert.equal(manifests.length, 2);

  const result = unregister(WINDOWS, io);
  assert.equal(result.removed.length, 2);
  assert.equal(result.left.length, 0);
  for (const file of manifests) {
    assert.equal(io.files.has(file), false);
  }
  assert.equal(io.registry.size, 0, "the keys this script added are gone");
});

test("a registry key that pointed somewhere before is restored, not deleted", () => {
  // Deleting it would silently remove a registration that existed before this script ran.
  const [chrome] = targetsFor({ ...WINDOWS, browsers: ["chrome"] });
  const io = fakeIo();
  io.registry.set(chrome.registryKey, "C:\\Other\\manifest.json");
  register({ ...WINDOWS, browsers: ["chrome"], binaryPath: BINARY_WIN, extensionIds: [ID] }, io);
  assert.equal(io.registry.get(chrome.registryKey), chrome.manifestPath);

  unregister(WINDOWS, io);
  assert.equal(io.registry.get(chrome.registryKey), "C:\\Other\\manifest.json");
});

test("a manifest edited after registration is left alone", () => {
  // Something else owns it now. Removing it would destroy a file this script did not
  // produce, which is the failure the receipt exists to prevent.
  const io = fakeIo();
  register({ ...WINDOWS, browsers: ["chrome"], binaryPath: BINARY_WIN, extensionIds: [ID] }, io);
  const [chrome] = targetsFor({ ...WINDOWS, browsers: ["chrome"] });
  io.files.set(chrome.manifestPath, '{"name":"edited by hand"}\n');

  const result = unregister(WINDOWS, io);
  assert.equal(result.removed.length, 0);
  assert.equal(result.left.length, 1);
  assert.match(result.left[0].reason, /changed after it was registered/);
  assert.ok(io.files.has(chrome.manifestPath));
});

test("unregistering twice is not an error", () => {
  const io = fakeIo();
  register({ ...WINDOWS, binaryPath: BINARY_WIN, extensionIds: [ID] }, io);
  unregister(WINDOWS, io);
  const second = unregister(WINDOWS, io);
  assert.equal(second.removed.length, 0);
  assert.equal(second.left.length, 0);
});

test("a dry run reports what it would do and changes nothing", () => {
  const io = fakeIo();
  const result = register(
    { ...WINDOWS, binaryPath: BINARY_WIN, extensionIds: [ID], dryRun: true },
    io,
  );
  assert.equal(result.applied, false);
  assert.equal(result.planned.length, 2);
  assert.equal(io.files.size, 0);
  assert.equal(io.registry.size, 0);
});

test("registering the same target twice does not lose the original registry value", () => {
  // The second run must not record the first run's own value as what was there before,
  // or unregister would restore a path back into the key it was supposed to clear.
  const [chrome] = targetsFor({ ...WINDOWS, browsers: ["chrome"] });
  const io = fakeIo();
  const options = {
    ...WINDOWS,
    browsers: ["chrome"],
    binaryPath: BINARY_WIN,
    extensionIds: [ID],
  };
  register(options, io);
  register(options, io);
  unregister(WINDOWS, io);
  assert.equal(io.registry.has(chrome.registryKey), false);
});

test("the receipt records the digest of what was written", () => {
  const io = fakeIo();
  register({ ...WINDOWS, browsers: ["chrome"], binaryPath: BINARY_WIN, extensionIds: [ID] }, io);
  const file = [...io.files.keys()].find((f) => f.endsWith("receipt.json"));
  const receipt = JSON.parse(io.files.get(file));
  const [chrome] = targetsFor({ ...WINDOWS, browsers: ["chrome"] });
  const expected = createHash("sha256")
    .update(io.files.get(chrome.manifestPath), "utf8")
    .digest("hex");
  assert.equal(receipt.entries[0].sha256, expected);
});

test("an unsupported platform is refused rather than guessed at", () => {
  assert.throws(() => targetsFor({ platform: "linux", home: "/home/dev" }), /unsupported platform/);
});

test("an unknown browser name is refused", () => {
  assert.throws(() => targetsFor({ ...WINDOWS, browsers: ["safari"] }), /unknown browser/);
});

test("a missing receipt reads as empty rather than throwing", () => {
  assert.deepEqual(readReceipt("/no/such/receipt.json"), { entries: [] });
  assert.ok(receiptFile(WINDOWS).endsWith("ResumePro\\dev-nm\\receipt.json"));
});
