// The sidebar state helpers are pure and covered in sidebar-state.test.js. What these
// tests cover is the content-script half: reading the live DOM, deciding whether a write
// is even needed, and applying a change that arrived from another tab.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SIDEBAR_ID = "resume-pro-sidebar";
const SIDEBAR_WIDTH = 280;
const SIDEBAR_HEIGHT = 420;

// Values read out of the content script come from another VM realm, so their
// prototypes differ from this file's. Compare their structure instead.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createStyle() {
  const values = new Map();
  const style = {
    setProperty(name, value) {
      values.set(name, String(value));
    },
    removeProperty(name) {
      values.delete(name);
    }
  };

  for (const name of ["left", "top", "right"]) {
    Object.defineProperty(style, name, {
      get() {
        return values.get(name) ?? "";
      },
      set(value) {
        values.set(name, String(value));
      },
      enumerable: true
    });
  }

  return style;
}

function createClassList() {
  const values = new Set();
  return {
    add(value) {
      values.add(value);
    },
    remove(value) {
      values.delete(value);
    },
    contains(value) {
      return values.has(value);
    },
    toggle(value, force) {
      const shouldAdd = force === undefined ? !values.has(value) : Boolean(force);
      if (shouldAdd) values.add(value);
      else values.delete(value);
      return shouldAdd;
    }
  };
}

// A sidebar-shaped DOM: one host in fixed positioning plus the shadow contents the
// state code reaches for. Measuring mirrors the real CSS, so "the anchor was frozen
// to pixels" and "the anchor still follows the right edge" are distinguishable.
function loadContentScript({ width = 1200, height = 900 } = {}) {
  const writes = [];
  const listeners = { document: {}, window: {}, storageChanged: [] };
  const collapseButton = {
    textContent: "",
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
  const sidebar = {
    classList: createClassList(),
    querySelector(selector) {
      return selector === ".resume-pro__collapse" ? collapseButton : null;
    }
  };
  const shadowRoot = {
    querySelector(selector) {
      return selector === ".resume-pro" ? sidebar : null;
    }
  };
  const host = {
    id: SIDEBAR_ID,
    style: createStyle(),
    getBoundingClientRect() {
      const left = host.style.left === ""
        ? window.innerWidth - SIDEBAR_WIDTH - Number.parseFloat(host.style.right || "0")
        : Number.parseFloat(host.style.left);
      const top = host.style.top === "" ? 0 : Number.parseFloat(host.style.top);
      return {
        left,
        top,
        width: SIDEBAR_WIDTH,
        height: SIDEBAR_HEIGHT,
        right: left + SIDEBAR_WIDTH,
        bottom: top + SIDEBAR_HEIGHT
      };
    }
  };
  const document = {
    readyState: "loading",
    body: { appendChild() {} },
    addEventListener(type, handler) {
      (listeners.document[type] ||= []).push(handler);
    },
    getElementById(id) {
      return id === SIDEBAR_ID ? host : null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type, handler) {
      (listeners.window[type] ||= []).push(handler);
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    }
  };
  window.top = window;

  const chrome = {
    runtime: {
      getURL: (name) => `chrome-extension://test/${name}`,
      onMessage: { addListener() {} },
      sendMessage: async () => ({})
    },
    storage: {
      local: {
        async get() {
          return {};
        },
        async set(values) {
          writes.push(values);
        }
      },
      onChanged: {
        addListener(handler) {
          listeners.storageChanged.push(handler);
        }
      }
    }
  };

  const context = {
    console,
    chrome,
    document,
    window,
    navigator: { clipboard: { writeText: async () => {} } },
    crypto: { randomUUID: () => "test-id" },
    CSS: { escape: (value) => String(value) },
    Event: class {},
    MouseEvent: class {},
    FocusEvent: class {},
    HTMLElement: class {},
    HTMLInputElement: class {},
    HTMLSelectElement: class {},
    HTMLTextAreaElement: class {},
    HTMLLabelElement: class {},
    self: { __RESUME_PRO_TEST__: true }
  };
  context.globalThis = context;
  context.self.window = window;
  context.window.document = document;

  const root = path.join(__dirname, "..");
  vm.runInNewContext(fs.readFileSync(path.join(root, "sidebar-state.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), context);

  const hooks = context.self.ResumeProHighlightTest;
  hooks.setShadowRoot(shadowRoot);

  return {
    hooks,
    host,
    sidebar,
    collapseButton,
    writes,
    listeners,
    resizeViewport(nextWidth, nextHeight) {
      window.innerWidth = nextWidth;
      window.innerHeight = nextHeight;
    }
  };
}

test("an untouched sidebar keeps following the right edge when the window widens", () => {
  const { hooks, host, resizeViewport } = loadContentScript();
  hooks.setSidebarUiState({ collapsed: false, left: null, top: null });
  hooks.applySidebarUiState();

  assert.equal(host.style.left, "", "the default must not be frozen into a pixel offset");
  assert.equal(host.style.right, "24px");
  assert.equal(host.getBoundingClientRect().left, 896);

  resizeViewport(1600, 900);
  hooks.constrainSidebarToViewport();

  assert.equal(host.style.left, "");
  assert.equal(host.getBoundingClientRect().left, 1296, "the sidebar should track the new right edge");
  assert.deepEqual(plain(hooks.getSidebarUiState()), { collapsed: false, left: null, top: null });
});

test("a restored position is clamped and the collapsed mode is applied", () => {
  const { hooks, host, sidebar, collapseButton } = loadContentScript();
  hooks.setSidebarUiState({ collapsed: true, left: 1200, top: 900 });
  hooks.applySidebarUiState();

  assert.deepEqual(plain(hooks.getSidebarUiState()), { collapsed: true, left: 908, top: 468 });
  assert.equal(host.style.left, "908px");
  assert.equal(host.style.right, "auto");
  assert.equal(sidebar.classList.contains("is-collapsed"), true);
  assert.equal(collapseButton.textContent, "+");
  assert.equal(collapseButton.attributes["aria-expanded"], "false");
});

test("persisting an unchanged position does not write to extension storage", () => {
  const { hooks, host, writes } = loadContentScript();
  host.style.left = "200px";
  host.style.top = "150px";
  host.style.right = "auto";
  hooks.setSidebarUiState({ collapsed: false, left: 200, top: 150 });

  hooks.persistSidebarUiState();
  assert.equal(writes.length, 0, "an idle call must not touch storage or fire every other tab");

  host.style.left = "260px";
  host.style.top = "210px";
  hooks.persistSidebarUiState();
  assert.deepEqual(plain(writes), [{
    resumeProSidebarUiState: { collapsed: false, left: 260, top: 210 }
  }]);

  hooks.persistSidebarUiState();
  assert.equal(writes.length, 1, "the same position must not be written twice");
});

test("a mouseup outside a drag writes nothing, while a real drag persists once", () => {
  const { hooks, host, writes } = loadContentScript();
  hooks.setSidebarUiState({ collapsed: false, left: null, top: null });

  hooks.stopDrag();
  assert.equal(writes.length, 0);

  host.style.left = "320px";
  host.style.top = "240px";
  host.style.right = "auto";
  hooks.setDragging(true);
  hooks.stopDrag();

  assert.equal(hooks.readSidebarUiState().left, 320);
  assert.deepEqual(plain(writes), [{
    resumeProSidebarUiState: { collapsed: false, left: 320, top: 240 }
  }]);
});

test("a change from another tab is applied, but never one from another storage area", async () => {
  const { hooks, host, sidebar, listeners } = loadContentScript();
  hooks.bindStorageSync();
  const [onChanged] = listeners.storageChanged;
  assert.equal(typeof onChanged, "function");

  await onChanged({ resumeProSidebarUiState: { newValue: { collapsed: true, left: 500, top: 300 } } }, "local");
  assert.equal(host.style.left, "500px");
  assert.equal(sidebar.classList.contains("is-collapsed"), true);

  await onChanged({ resumeProSidebarUiState: { newValue: { collapsed: false, left: 20, top: 20 } } }, "sync");
  assert.equal(host.style.left, "500px", "only chrome.storage.local carries the sidebar state");

  hooks.setDragging(true);
  await onChanged({ resumeProSidebarUiState: { newValue: { collapsed: false, left: 30, top: 30 } } }, "local");
  assert.equal(host.style.left, "500px", "a sync echo must not fight the pointer mid-drag");
  assert.equal(sidebar.classList.contains("is-collapsed"), true);
});

test("a normalized state is what gets stored, even after a failed read left it empty", async () => {
  const { hooks, host, writes } = loadContentScript();
  host.style.left = "120px";
  host.style.top = "80px";
  host.style.right = "auto";
  hooks.setSidebarUiState(null);

  hooks.persistSidebarUiState();

  assert.deepEqual(plain(writes), [{
    resumeProSidebarUiState: { collapsed: false, left: 120, top: 80 }
  }]);
});
