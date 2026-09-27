// #178: the whole "留档到桌面" path in one process — the native side panel (sidepanel.js),
// the page controller (content.js) and the worker's desktop link (link/router.mjs and its
// real queue, fill records, staging and uploads) — over a scripted desktop.
//
// Messages travel the way Chrome carries them: the panel reaches the page with
// chrome.tabs.sendMessage, and both reach the worker with chrome.runtime.sendMessage.
// Nothing between them is mocked except the native host and the DOM.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

const root = path.join(__dirname, "..", "..");
const ARCHIVE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EVENT = "99999999-9999-4999-8999-999999999999";
const EXTENSION_ID = "diagjmploldedipjdenmecmjokckelkl";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) await tick();
}

// Waits for asynchronous work (hashing a snapshot, a chain of messages) without guessing how
// many turns of the event loop it takes.
async function until(check, { timeout = 3000, what = "condition" } = {}) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  const listeners = [];
  return {
    data,
    listeners,
    async get(keys) {
      const out = {};
      for (const name of (Array.isArray(keys) ? keys : [keys])) if (name in data) out[name] = structuredClone(data[name]);
      return out;
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
      const changes = Object.fromEntries(Object.keys(values).map((key) => [key, { newValue: values[key] }]));
      for (const listener of listeners) listener(changes, "local");
    }
  };
}

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); },
    async list() { return [...map.values()].map((value) => structuredClone(value)); }
  };
}

function reply(message, payload, resultId) {
  const response = { protocolVersion: 2, correlationId: message.messageId, ok: true, payload };
  if (resultId !== undefined) response.resultId = resultId;
  return { response };
}

/**
 * A desktop with applications. `mode`: "online", "closed" (paired before, not answering),
 * "not_paired". `gate`, when set, holds candidate lookups until it resolves.
 */
function createDesktop(applications = []) {
  const desktop = {
    mode: "online",
    applications: [...applications],
    events: [],
    chunks: [],
    lookups: 0,
    gate: null,
    async answer(message) {
      if (desktop.mode === "closed") return { lastError: "Error when communicating with the native messaging host." };
      if (desktop.mode === "not_paired") {
        return { response: { protocolVersion: 2, correlationId: message.messageId, ok: false, error: { code: "identity_not_allowed", retryable: false, message: "not paired" }, payload: {} } };
      }
      if (message.messageType === "handshake") {
        return reply(message, { appVersion: "0.1.0", minProtocolVersion: 1, maxProtocolVersion: 2, archiveId: ARCHIVE, restoreEpoch: EPOCH, capabilities: ["handshake"] });
      }
      if (message.messageType === "application.queryCandidates") {
        desktop.lookups += 1;
        if (desktop.gate) await desktop.gate;
        const rows = desktop.applications.filter((app) => app.company === message.payload.company);
        const view = (app) => ({ applicationId: app.id, company: app.company, title: app.title, stage: app.stage });
        return reply(message, {
          exact: rows.filter((app) => app.title === message.payload.title).map(view),
          sameCompany: rows.filter((app) => app.title !== message.payload.title).map(view)
        });
      }
      if (message.messageType === "fill.submit") {
        desktop.events.push(message);
        return reply(message, { resultKind: "event" }, EVENT);
      }
      if (message.messageType === "snapshot.chunk") {
        desktop.chunks.push(message);
        const p = message.payload;
        const done = desktop.chunks.filter((item) => item.payload.snapshotId === p.snapshotId).length;
        return reply(message, { ackKind: done >= p.chunkCount ? "snapshot" : "chunk", snapshotId: p.snapshotId, chunkIndex: p.chunkIndex, chunkCursor: done }, message.messageId);
      }
      return { lastError: "Error when communicating with the native messaging host." };
    }
  };
  return desktop;
}

async function createWorker({ storage, kv, desktop }) {
  const { createStore } = await import("../../link/store.mjs");
  const { createSession } = await import("../../link/session.mjs");
  const { createIntents } = await import("../../link/intents.mjs");
  const { createOutbox } = await import("../../link/outbox.mjs");
  const { createReconcile } = await import("../../link/reconcile.mjs");
  const { createDrain } = await import("../../link/drain.mjs");
  const { createFillRecords } = await import("../../link/fillrecords.mjs");
  const { createStaging } = await import("../../link/staging.mjs");
  const { createUploads } = await import("../../link/uploads.mjs");
  const { createRouter } = await import("../../link/router.mjs");

  const uuid = () => nodeCrypto.randomUUID();
  const now = () => new Date();
  const store = createStore({ storage, uuid });
  const sent = [];
  const sendNative = async (host, message) => {
    sent.push(message);
    return desktop.answer(message);
  };
  const deps = { store, sendNative, sleep: async () => {}, uuid, now };
  const staging = createStaging({ kv, now, uuid });
  const uploads = createUploads({ ...deps, staging });
  const session = createSession({ ...deps, getManifest: () => ({ version: "0.4.1" }) });
  const outbox = createOutbox({ ...deps, uploads });
  const reconcile = createReconcile({ ...deps, outbox, uploads });
  const drain = createDrain({ session, outbox, reconcile, alarms: { async create() {}, async clear() { return true; } }, now });
  const fillRecords = createFillRecords(deps);
  const router = createRouter({
    session, intents: createIntents(deps), outbox, drain, reconcile, fillRecords, store, uploads,
    extensionId: EXTENSION_ID
  });
  const handled = [];
  return {
    router, drain, sent, handled,
    async handle(message) {
      handled.push(structuredClone(message));
      const result = await router.handle(message);
      if (result?.uploadQueued) drain.run().catch(() => {});
      return result;
    }
  };
}

// --- the page ------------------------------------------------------------------------------

function createPage({ worker, job, href = "https://jobs.example.test/apply" }) {
  const listeners = { runtimeMessage: [] };
  const card = {
    hidden: true,
    summary: { textContent: "" },
    option: { checked: true, disabled: false },
    querySelector(selector) {
      if (selector === "#resume-pro-fill-record-summary") return card.summary;
      if (selector === "#resume-pro-fill-record-snapshot") return card.option;
      return null;
    }
  };
  // The page overlay's candidate box: native-panel archiving must never open it.
  const legacyCandidates = { hidden: true, scrollIntoView() {} };
  const legacyPanel = { classList: { values: new Set(), add(v) { this.values.add(v); }, remove(v) { this.values.delete(v); }, contains(v) { return this.values.has(v); } } };
  const shadowRoot = {
    querySelector(selector) {
      return ({
        "#resume-pro-ai-fill": { disabled: false, hidden: false, textContent: "一键 AI 填写" },
        "#resume-pro-fill-record": card,
        "#resume-pro-candidates": legacyCandidates,
        ".resume-pro": legacyPanel
      })[selector] || null;
    }
  };
  const location = { href };
  const document = {
    readyState: "loading",
    body: { appendChild() {} },
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const window = {
    innerWidth: 1200, innerHeight: 900, addEventListener() {}, setTimeout, clearTimeout,
    getComputedStyle() { return { display: "block", visibility: "visible" }; }
  };
  window.top = window;
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (name) => `chrome-extension://${EXTENSION_ID}/${name}`,
      getManifest: () => ({ version: "0.4.1" }),
      onMessage: { addListener(handler) { listeners.runtimeMessage.push(handler); } },
      sendMessage: async (message) => {
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data: { templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 0 } };
        return worker.handle(message);
      }
    },
    storage: { local: { async get() { return {}; }, async set() {} }, onChanged: { addListener() {} } }
  };
  const context = {
    console, chrome, document, location, window,
    navigator: { clipboard: { writeText: async () => {} } },
    crypto: { randomUUID: () => nodeCrypto.randomUUID(), getRandomValues: (array) => nodeCrypto.getRandomValues(array) },
    structuredClone,
    CSS: { escape: (value) => String(value) },
    Event: class {}, MouseEvent: class {}, FocusEvent: class {}, HTMLElement: class {}, HTMLInputElement: class {},
    HTMLSelectElement: class {}, HTMLTextAreaElement: class {}, HTMLLabelElement: class {},
    self: { __RESUME_PRO_TEST__: true, ResumeProResumeData: require("../../resume-data.js"), ResumeProProfile: require("../../profile-fields.js") },
    setTimeout, clearTimeout
  };
  context.globalThis = context;
  context.self.window = window;
  window.document = document;
  vm.runInNewContext(fs.readFileSync(path.join(root, "sidebar-state.js"), "utf8"), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), context);
  const hooks = context.self.ResumeProHighlightTest;
  hooks.setShadowRoot(shadowRoot);
  const page = {
    hooks, card, legacyCandidates, legacyPanel, location, job,
    received: [],
    async ready() {
      const [copy, fillrecords, snapshot] = await Promise.all([
        import("../../link/copy.mjs"), import("../../link/fillrecords.mjs"), import("../../link/snapshot.mjs")
      ]);
      hooks.setDesktopModules({
        copy, fillrecords, snapshot,
        extract: { extractJobFields: () => ({ ...page.job }) },
        saveFlow: {}
      });
      return page;
    },
    // What content.js does at the end of every AI fill.
    async finishFill(raw = {}, template = TEMPLATE()) {
      await hooks.offerFillRecord({
        outcome: "success", cancelled: false, fieldCount: 5, filledCount: 5, unconfirmedCount: 0,
        timing: { scanMs: 1, roundTripMs: 2, fillMs: 3, totalMs: 6 }, templateName: "测试模板",
        endedAt: new Date().toISOString(), ...raw
      }, template);
    },
    // chrome.tabs.sendMessage to this page, answered by content.js's own listener.
    deliver(message) {
      page.received.push(structuredClone(message));
      return new Promise((resolve) => {
        let answered = false;
        const keepOpen = listeners.runtimeMessage[0](message, { id: EXTENSION_ID }, (value) => { answered = true; resolve(value); });
        if (!keepOpen && !answered) resolve(undefined);
      });
    }
  };
  return page;
}

// Values and labels of a template the fill used. The side panel must never see them.
const TEMPLATE = () => ({
  id: "tpl-1", name: "测试模板",
  groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "机密姓名甲" }, { key: "手机", value: "13800000000" }] }]
});

// --- the side panel --------------------------------------------------------------------------

function element(id) {
  const listeners = {};
  const classes = new Set();
  return {
    id, listeners, dataset: {}, hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", className: "",
    checked: true, attributes: {},
    classList: { toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains: (name) => classes.has(name) },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, listener) { listeners[type] = listener; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    click() { this.clicked = (this.clicked || 0) + 1; }
  };
}

// Buttons in rendered HTML, read back as { attrs, label, disabled }.
function buttonsIn(html) {
  return [...String(html).matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]));
    return { attrs, label: match[2], disabled: /\sdisabled(\s|$)/.test(` ${match[1]} `) };
  });
}

async function createPanel({ pages, worker, storage }) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const toasts = [];
  // Every message type the panel sent to the page, in order.
  const pageMessages = [];
  const state = { tabId: 1, poll: null, activated: null };
  get("panel-toast");
  const copy = await import("../../link/copy.mjs");
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (name) => `chrome-extension://${EXTENSION_ID}/${name}`,
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === "DESKTOP_RESUME_READ") {
          return { status: "ok", data: { templates: [{ id: "tpl-1", name: "测试模板", fieldCount: 2 }], activeTemplate: TEMPLATE(), profile: { values: {}, family: [], custom: [] }, profileRevision: 1 } };
        }
        if (message.type === "DESKTOP_LEGACY_STATUS" || message.type === "DESKTOP_OPEN_VIEW") return {};
        return worker.handle(message);
      }
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener(listener) { storage.listeners.push(listener); } } },
    tabs: {
      query: async () => [{ id: state.tabId }],
      sendMessage: async (id, message) => {
        const page = pages[id];
        if (!page) throw new Error("no page");
        if (message.type === "RESUME_PANEL_TARGET") return { ok: true, targetAvailable: false };
        pageMessages.push(message.type);
        return page.deliver(message);
      },
      create: async () => {},
      onActivated: { addListener(listener) { state.activated = listener; } },
      onUpdated: { addListener() {} }
    }
  };
  // The page overlay's tools. The side panel must never reach for them (#178): counted here.
  const overlayTools = { clicked: 0, click() { this.clicked += 1; } };
  const documentStub = {
    hidden: false, getElementById: (id) => get(id), querySelectorAll: () => [],
    querySelector: (selector) => (selector.startsWith("[data-advanced") ? overlayTools : { click() {}, open: false }),
    addEventListener() {}
  };
  const context = vm.createContext({
    document: documentStub, chrome, console,
    navigator: { clipboard: { writeText: async () => {} } },
    self: {
      ResumeProProfile: require("../../profile-fields.js"), ResumeProResumeData: require("../../resume-data.js"),
      ResumeProCompose: require("../../sidepanel-compose.js"), ResumeProQueue: require("../../sidepanel-queue.js"),
      ResumeProLinkCopy: copy
    },
    setTimeout: (fn) => { toasts.push(get("panel-toast").textContent); return 1; },
    clearTimeout() {},
    setInterval: (listener) => { state.poll = listener; }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "sidepanel.js"), "utf8"), context);
  await settle();
  await state.poll();
  await settle();

  const card = () => ({
    hidden: get("fill-offer").hidden,
    className: get("fill-offer").className,
    title: get("fill-offer-title").hidden ? "" : get("fill-offer-title").textContent,
    text: get("fill-offer-text").hidden ? "" : get("fill-offer-text").textContent,
    hint: get("fill-offer-hint").hidden ? "" : get("fill-offer-hint").textContent,
    snapshotLine: get("fill-offer-snapshot-state").hidden ? "" : get("fill-offer-snapshot-state").textContent,
    checkbox: !get("fill-offer-check").hidden,
    extensionId: get("fill-offer-extension-id").hidden ? "" : get("fill-offer-extension-id").textContent,
    actions: buttonsIn(get("fill-offer-actions").innerHTML).map((b) => ({ action: b.attrs["data-archive"], label: b.label, disabled: b.disabled })),
    candidates: get("fill-offer-candidates").hidden ? [] : buttonsIn(get("fill-offer-candidates").innerHTML).map((b) => ({ applicationId: b.attrs["data-application-id"], label: b.label, disabled: b.disabled })),
    html: [get("fill-offer-title").textContent, get("fill-offer-text").textContent, get("fill-offer-hint").textContent, get("fill-offer-candidates").innerHTML, get("fill-offer-actions").innerHTML].join("\n")
  });

  const panel = {
    get, toasts, state, card, overlayTools, pageMessages,
    async poll() { await state.poll(); await settle(); },
    // Clicks without waiting for the answer; the caller decides when to settle.
    clickArchive(action) {
      const button = card().actions.find((item) => item.action === action);
      if (!button) throw new Error(`no ${action} button; have ${card().actions.map((item) => item.action)}`);
      get("fill-offer-actions").listeners.click({ target: { closest: (selector) => (selector === "[data-archive]" ? { dataset: { archive: action }, disabled: button.disabled } : null) } });
    },
    // A second click that lands before the card was redrawn: the button is still enabled.
    clickArchiveAgain(action) {
      get("fill-offer-actions").listeners.click({ target: { closest: (selector) => (selector === "[data-archive]" ? { dataset: { archive: action }, disabled: false } : null) } });
    },
    async waitCard(check, what) {
      await until(() => check(card()), { what });
    },
    clickCandidate(applicationId) {
      const button = card().candidates.find((item) => item.applicationId === applicationId);
      if (!button) throw new Error(`no candidate ${applicationId}`);
      get("fill-offer-candidates").listeners.click({ target: { closest: (selector) => (selector === "[data-application-id]" ? { dataset: { applicationId }, disabled: button.disabled } : null) } });
    },
    // A second click on a candidate that lands before the card was redrawn.
    clickCandidateAgain(applicationId) {
      get("fill-offer-candidates").listeners.click({ target: { closest: (selector) => (selector === "[data-application-id]" ? { dataset: { applicationId }, disabled: false } : null) } });
    },
    async switchTab(tabId) {
      state.tabId = tabId;
      state.activated?.();
      await settle();
      await panel.poll();
    },
    queue() {
      return {
        count: get("queue-count").textContent,
        open: !get("queue-body").hidden,
        html: get("queue-list").innerHTML,
        rows: String(get("queue-list").innerHTML).split('<div class="queue-row').slice(1).map((segment) => ({
          key: (segment.match(/data-key="([^"]+)"/) || [])[1],
          focused: segment.startsWith(" is-focused"),
          text: segment.slice(segment.indexOf(">") + 1).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
          buttons: buttonsIn(segment).map((b) => ({ action: b.attrs["data-queue-action"], label: b.label, applicationId: b.attrs["data-application-id"], disabled: b.disabled, snapshotId: b.attrs["data-snapshot-id"] }))
        }))
      };
    },
    async clickQueue(key, action, extra = {}) {
      const button = { dataset: { key, queueAction: action, ...extra }, disabled: false };
      await get("queue-list").listeners.click({ target: { closest: (selector) => (selector === "[data-queue-action]" ? button : null) } });
      await settle();
    },
    async toggleQueue() {
      get("queue-toggle").listeners.click();
      await settle();
    }
  };
  return panel;
}

async function createStack({ applications = [], job = { company: "金发科技股份有限公司", title: "研发工程师", sourceUrl: "https://jobs.example.test/apply" }, paired = true, mode = "online" } = {}) {
  const storage = fakeStorage(paired ? { desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } } : {});
  const kv = fakeKv();
  const desktop = createDesktop(applications);
  desktop.mode = mode;
  const worker = await createWorker({ storage, kv, desktop });
  const page = await createPage({ worker, job }).ready();
  const pages = { 1: page };
  const panel = await createPanel({ pages, worker, storage });
  return {
    storage, kv, desktop, worker, page, pages, panel,
    createPage: (options) => createPage({ worker, ...options }).ready(),
    // A side panel opened afresh (the old one closed), over the same worker and storage.
    openPanel: (openPages = pages) => createPanel({ pages: openPages, worker, storage })
  };
}

module.exports = { createStack, settle, tick, until, TEMPLATE, EXTENSION_ID, buttonsIn };
