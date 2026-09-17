const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sidebarState = require("../sidebar-state.js");

test("sidebar state preserves a valid fixed position and collapsed mode", () => {
  assert.deepEqual(sidebarState.normalize({ collapsed: true, left: 240, top: 128 }), {
    collapsed: true,
    left: 240,
    top: 128
  });
});

test("sidebar state rejects partial and non-finite saved positions", () => {
  assert.deepEqual(sidebarState.normalize({ collapsed: true, left: 240 }), {
    collapsed: true,
    left: null,
    top: null
  });
  assert.deepEqual(sidebarState.normalize({ left: Infinity, top: 20 }), {
    collapsed: false,
    left: null,
    top: null
  });
  assert.deepEqual(sidebarState.normalize(null), {
    collapsed: false,
    left: null,
    top: null
  });
  assert.deepEqual(sidebarState.normalize(undefined), {
    collapsed: false,
    left: null,
    top: null
  });
});

test("restored sidebar remains inside a smaller viewport", () => {
  assert.deepEqual(
    sidebarState.constrain(
      { collapsed: true, left: 1200, top: 900 },
      { width: 160, height: 60 },
      { width: 800, height: 600 }
    ),
    { collapsed: true, left: 628, top: 528 }
  );
});

test("an unsaved default position remains anchored to the default right side", () => {
  assert.deepEqual(
    sidebarState.constrain(
      { collapsed: false, left: null, top: null },
      { width: 300, height: 500 },
      { width: 800, height: 600 }
    ),
    { collapsed: false, left: null, top: null }
  );
});

test("a sidebar larger than the viewport starts at the viewport origin", () => {
  assert.deepEqual(
    sidebarState.constrain(
      { collapsed: false, left: 400, top: 300 },
      { width: 900, height: 700 },
      { width: 800, height: 600 }
    ),
    { collapsed: false, left: 0, top: 0 }
  );
});

test("a sidebar that barely fits gives up the margin without overflowing", () => {
  assert.deepEqual(
    sidebarState.constrain(
      { collapsed: false, left: 400, top: 300 },
      { width: 790, height: 595 },
      { width: 800, height: 600 }
    ),
    { collapsed: false, left: 10, top: 5 }
  );
});

test("normalized sidebar states can be compared before writing", () => {
  assert.equal(sidebarState.equal(
    { collapsed: true, left: 120, top: 80 },
    { collapsed: true, left: 120, top: 80 }
  ), true);
  assert.equal(sidebarState.equal(
    { collapsed: true, left: 120, top: 80 },
    { collapsed: false, left: 120, top: 80 }
  ), false);
});

test("the sidebar state helper loads before the content script", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts.find((entry) => entry.js?.includes("content.js"))?.js ?? [];

  assert.ok(scripts.indexOf("sidebar-state.js") < scripts.indexOf("content.js"));
});

test("a failed storage read falls back without blocking sidebar initialization", async () => {
  const fallback = await sidebarState.readOrDefault({
    async get() {
      throw new Error("storage unavailable");
    }
  });

  assert.deepEqual(fallback, { collapsed: false, left: null, top: null });
});

test("an empty storage read returns the default sidebar state", async () => {
  assert.deepEqual(await sidebarState.read({ async get() { return {}; } }), {
    collapsed: false,
    left: null,
    top: null
  });
});

test("sidebar state round-trips through extension storage for the next page", async () => {
  const data = {};
  const writes = [];
  const storage = {
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(values) {
      writes.push(values);
      Object.assign(data, values);
    }
  };

  await sidebarState.write(storage, { collapsed: true, left: 360, top: 144 });
  assert.deepEqual(writes, [{
    [sidebarState.STORAGE_KEY]: { collapsed: true, left: 360, top: 144 }
  }]);
  assert.deepEqual(await sidebarState.read(storage), {
    collapsed: true,
    left: 360,
    top: 144
  });
});

test("invalid values are normalized before writing extension storage", async () => {
  const writes = [];
  await sidebarState.write({
    async set(value) {
      writes.push(value);
    }
  }, { collapsed: true, left: Infinity, top: 20 });

  assert.deepEqual(writes, [{
    [sidebarState.STORAGE_KEY]: { collapsed: true, left: null, top: null }
  }]);
});
