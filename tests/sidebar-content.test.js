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
function loadContentScript({ width = 1200, height = 900, desktopReply = null } = {}) {
  const writes = [];
  const listeners = { document: {}, window: {}, storageChanged: [], runtimeMessage: [] };
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
      onMessage: { addListener(handler) { listeners.runtimeMessage.push(handler); } },
      sendMessage: async message => desktopReply ? desktopReply(message) : message.type === 'DESKTOP_RESUME_READ'
        ? { status: 'ok', data: { templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 0 } }
        : ({})
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
    location: { href: 'https://jobs.example.test/apply' },
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
    self: { __RESUME_PRO_TEST__: true, ResumeProResumeData: require('../resume-data.js'), ResumeProProfile: require('../profile-fields.js') }
  };
  context.setTimeout = setTimeout;
  context.clearTimeout = clearTimeout;
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
    context,
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

test("native side panel status exposes pending offers and diagnostics", () => {
  const { hooks, listeners } = loadContentScript();
  const profileOffer = { hidden: false, querySelector: () => ({ textContent: "还有 2 个字段空着" }) };
  const fillOffer = {
    hidden: false,
    querySelector(selector) {
      return selector === "#resume-pro-fill-record-snapshot"
        ? { disabled: false } : { textContent: "是否留档到桌面" };
    }
  };
  hooks.setShadowRoot({
    querySelector(selector) {
      return ({
        "#resume-pro-ai-fill": { disabled: false, textContent: "一键 AI 填写" },
        "#resume-pro-profile-offer": profileOffer,
        "#resume-pro-fill-record": fillOffer,
        "#resume-pro-diagnostics": { hidden: false, querySelector: () => ({ value: "网页字段：3" }) }
      })[selector] || null;
    }
  });

  let response;
  const handled = listeners.runtimeMessage[0]({ type: "RESUME_PANEL_STATUS" }, {}, (value) => { response = value; });
  assert.equal(handled, false);
  assert.equal(response.ready, true);
  assert.equal(response.profileOffer, "还有 2 个字段空着");
  assert.equal(response.fillOffer, "是否留档到桌面");
  assert.equal(response.snapshotAvailable, true);
  assert.equal(response.diagnostics, "网页字段：3");

  listeners.runtimeMessage[0]({ type: "RESUME_PANEL_OFFER", action: "profileSkip" }, {}, () => {});
  assert.equal(profileOffer.hidden, true);
});

test("native side panel fill command rereads the desktop before invoking the page controller", async () => {
  const { hooks, listeners } = loadContentScript();
  let clicks = 0;
  hooks.setShadowRoot({
    querySelector(selector) {
      return selector === "#resume-pro-ai-fill"
        ? { hidden: false, disabled: false, click() { clicks += 1; } }
        : null;
    }
  });
  let reply;
  const handled = listeners.runtimeMessage[0]({ type: "RESUME_PANEL_FILL" }, {}, (value) => { reply = value; });
  assert.equal(handled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reply.ok, true);
  assert.equal(clicks, 1);
});

test('adding unanswered fields retries one desktop profile conflict with the new revision', async () => {
  const updates = [];
  let revision = 0;
  const { hooks } = loadContentScript({ desktopReply: async message => {
    if (message.type === 'DESKTOP_RESUME_READ') return { status: 'ok', data: {
      templates: [], activeTemplate: null,
      profile: { values: {}, family: [], custom: [] }, profileRevision: revision
    } };
    if (message.type === 'DESKTOP_RESUME_UPDATE') {
      updates.push(message);
      if (updates.length === 1) { revision = 1; return { status: 'conflict' }; }
      return { status: 'ok' };
    }
    return { status: 'ok' };
  } });
  const card = { hidden: false };
  hooks.setShadowRoot({ querySelector: selector => ({ '#resume-pro-profile-offer': card })[selector] || null });
  hooks.setProfileOffer({
    labels: ['期望薪资'], fields: [],
    candidates: [{ label: '期望薪资', entry: { kind: 'element', element: { isConnected: true, value: '' } } }]
  });
  await hooks.addUnansweredToProfile();
  assert.deepEqual(updates.map(item => item.expectedRevision), [0, 1]);
  assert.equal(card.hidden, true);
});

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

function saveJobPage(hooks) {
  const inputs = Object.fromEntries([
    '#resume-pro-save-company', '#resume-pro-save-title', '#resume-pro-save-location',
    '#resume-pro-save-url', '#resume-pro-save-note'
  ].map(key => [key, { value: '', textContent: '' }]));
  const openAi = { hidden: true };
  const form = { hidden: true, querySelector: key => key === '#resume-pro-save-open-ai' ? openAi : inputs[key] ?? null };
  const saveButton = { disabled: false };
  const assistNote = { textContent: '' };
  const assistItems = [];
  const assistList = { set textContent(value) { assistItems.length = 0; }, appendChild(item) { assistItems.push(item.textContent); } };
  const assistPanel = {
    hidden: true,
    querySelector: key => key === '#resume-pro-job-assist-note' ? assistNote : assistList,
    querySelectorAll: () => assistItems.map(text => ({ textContent: text }))
  };
  hooks.setShadowRoot({
    querySelector(selector) {
      return {
        '#resume-pro-save-form': form,
        '#resume-pro-save-job': saveButton,
        '#resume-pro-job-assist': assistPanel
      }[selector] ?? null;
    }
  });
  return { inputs, openAi, form, assistNote, assistItems, assistPanel };
}

const UNRELIABLE_JOB = {
  company: '金发科技股份有限公司', title: '', location: '',
  sourceUrl: 'https://kingfa.zhiye.com/apply?job=42', dedupeUrl: 'https://kingfa.zhiye.com/apply?job=42',
  reliable: false, assistReasons: ['missing_title'],
  fragments: [
    { id: 1, source: 'beisen-company', role: 'company', text: '金发科技股份有限公司' },
    { id: 2, source: 'beisen-apply-title', role: 'job-title', text: '你正在投递职位：研发工程师-化工工艺研究方向' }
  ]
};

test("an unreliable extraction asks the desktop AI with the fragments only, then waits for the user", async () => {
  const { hooks, context } = loadContentScript();
  const page = saveJobPage(hooks);
  context.document.createElement = () => ({ textContent: '' });
  // A leftover plugin AI config must not be read or sent anywhere.
  hooks.setCurrentStore({ aiConfig: { apiUrl: 'https://ai.example.test', model: 'demo', apiKey: 'sk-test' } });
  const saveFlow = await import('../link/save-flow.mjs');
  const copy = await import('../link/copy.mjs');
  hooks.setDesktopModules({ extract: { extractJobFields: () => UNRELIABLE_JOB }, saveFlow, copy });
  const sent = [];
  let answer;
  context.self.ResumeProAIClient = {
    send: message => {
      sent.push(message);
      return new Promise(resolve => { answer = resolve; });
    },
    cancel: async () => ({ cancelled: true })
  };
  const saves = [];
  context.chrome.runtime.sendMessage = async message => {
    saves.push(message);
    return { status: 'saved' };
  };

  const recognition = hooks.handleSaveJobClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.assistPanel.hidden, false);
  assert.equal(page.assistNote.textContent, copy.describeJobAssist({}).text);
  assert.deepEqual(page.assistItems, [
    '1. 公司名称：金发科技股份有限公司',
    '2. 职位标题：你正在投递职位：研发工程师-化工工艺研究方向'
  ]);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['fragments', 'requestId', 'type']);
  assert.equal(sent[0].type, 'AI_EXTRACT_JOB');
  assert.deepEqual(sent[0].fragments, UNRELIABLE_JOB.fragments);

  answer({ status: 'ok', reason: 'ok', reliable: true, fields: {
    company: '金发科技股份有限公司', title: '研发工程师-化工工艺研究方向', location: ''
  } });
  await recognition;
  assert.equal(page.assistPanel.hidden, true);
  assert.equal(page.form.hidden, false);
  assert.equal(page.inputs['#resume-pro-save-title'].value, '研发工程师-化工工艺研究方向');
  assert.equal(page.inputs['#resume-pro-save-url'].value, UNRELIABLE_JOB.sourceUrl);
  assert.equal(page.inputs['#resume-pro-save-note'].textContent, copy.describeReviewSave());
  assert.equal(page.openAi.hidden, true);
  assert.equal(saves.length, 0, 'nothing reaches the desktop before the user confirms');
});

test("a desktop without AI settings opens the form with the reason and a settings button, once", async () => {
  const { hooks, context } = loadContentScript();
  const page = saveJobPage(hooks);
  context.document.createElement = () => ({ textContent: '' });
  const saveFlow = await import('../link/save-flow.mjs');
  const copy = await import('../link/copy.mjs');
  hooks.setDesktopModules({ extract: { extractJobFields: () => UNRELIABLE_JOB }, saveFlow, copy });
  let calls = 0;
  context.self.ResumeProAIClient = {
    send: async () => {
      calls += 1;
      return {
        status: 'manual', reason: 'not_configured', reliable: false,
        fields: { company: '', title: '', location: '' },
        note: '桌面还没有配置 AI 服务商，或当前服务商没有 Key。', openView: 'settings-ai'
      };
    },
    cancel: async () => ({ cancelled: false })
  };

  await hooks.handleSaveJobClick();
  assert.equal(calls, 1, 'a failed recognition is not retried');
  assert.equal(page.form.hidden, false);
  assert.equal(page.inputs['#resume-pro-save-company'].value, '金发科技股份有限公司');
  assert.equal(page.inputs['#resume-pro-save-title'].value, '');
  assert.equal(page.inputs['#resume-pro-save-note'].textContent,
    '桌面还没有配置 AI 服务商，或当前服务商没有 Key。请手动补全后再保存。');
  assert.equal(page.openAi.hidden, false);

  // Another failure without a settings link hides the button again.
  page.form.hidden = true;
  context.self.ResumeProAIClient.send = async () => {
    calls += 1;
    return { status: 'manual', reason: 'timeout', reliable: false, fields: {} };
  };
  await hooks.handleSaveJobClick();
  assert.equal(calls, 2);
  assert.equal(page.inputs['#resume-pro-save-note'].textContent, copy.describeManualSave('timeout'));
  assert.equal(page.openAi.hidden, true);
});

test("the native side panel sees a running recognition and can cancel it", async () => {
  const { hooks, context, listeners } = loadContentScript();
  const page = saveJobPage(hooks);
  context.document.createElement = () => ({ textContent: '' });
  const saveFlow = await import('../link/save-flow.mjs');
  const copy = await import('../link/copy.mjs');
  hooks.setDesktopModules({ extract: { extractJobFields: () => UNRELIABLE_JOB }, saveFlow, copy });
  let answer;
  const cancelled = [];
  context.self.ResumeProAIClient = {
    send: message => new Promise(resolve => { answer = resolve; }),
    cancel: async requestId => { cancelled.push(requestId); return { cancelled: true }; }
  };
  // Replies are built inside the script's own realm; compare them as plain data.
  const ask = message => {
    let reply;
    listeners.runtimeMessage[0](message, {}, value => { reply = value; });
    return JSON.parse(JSON.stringify(reply));
  };

  const recognition = hooks.handleSaveJobClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ask({ type: 'RESUME_PANEL_STATUS' }).jobAssist, { fragments: 2 });

  assert.deepEqual(ask({ type: 'RESUME_PANEL_ADVANCED', action: 'cancel-assist' }), { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled.length, 1, 'the desktop call is closed');
  assert.equal(page.assistPanel.hidden, true);
  assert.equal(page.form.hidden, false);
  assert.equal(page.inputs['#resume-pro-save-note'].textContent, copy.describeManualSave('cancelled'));
  assert.equal(ask({ type: 'RESUME_PANEL_STATUS' }).jobAssist, null);
  assert.deepEqual(ask({ type: 'RESUME_PANEL_ADVANCED', action: 'cancel-assist' }), { ok: false, error: '识别已经结束了。' });

  answer({ status: 'ok', reliable: true, fields: { company: 'wrong', title: 'wrong' } });
  await recognition;
  assert.equal(page.inputs['#resume-pro-save-company'].value, UNRELIABLE_JOB.company, 'a late reply changes nothing');
});

test("cancelling job recognition allows immediate manual save and ignores a late AI reply", async () => {
  const { hooks, context } = loadContentScript();
  const inputs = Object.fromEntries([
    '#resume-pro-save-company', '#resume-pro-save-title', '#resume-pro-save-location',
    '#resume-pro-save-url', '#resume-pro-save-note'
  ].map(key => [key, { value: '', textContent: '' }]));
  const form = { hidden: true, querySelector: key => inputs[key] ?? null };
  const saveButton = { disabled: false };
  const assistNote = { textContent: '' };
  const assistList = { textContent: '', appendChild() {} };
  const assistPanel = {
    hidden: true,
    querySelector: key => key === '#resume-pro-job-assist-note' ? assistNote : assistList
  };
  hooks.setShadowRoot({
    querySelector(selector) {
      return {
        '#resume-pro-save-form': form,
        '#resume-pro-save-job': saveButton,
        '#resume-pro-job-assist': assistPanel
      }[selector] ?? null;
    }
  });
  const fields = { company: '', title: '', location: '', sourceUrl: '', dedupeUrl: '' };
  hooks.setDesktopModules({
    extract: { extractJobFields: () => fields },
    saveFlow: {
      nextSaveStep: () => ({ action: 'assist', fields, fragments: [] }),
      assistDisclosure: () => ({ fragments: [] }),
      afterAssist: () => ({ action: 'commit', fields: { ...fields, company: 'wrong' } })
    },
    copy: {
      describeJobAssist: () => ({ text: 'AI 正在识别', fragments: [] }),
      describeManualSave: () => '请手动填写',
      describeBindResult: () => ({ tone: 'success', text: '桌面已保存' })
    }
  });
  let resolveAi;
  let aiCalls = 0;
  context.self.ResumeProAIClient = {
    send: () => {
      aiCalls += 1;
      return new Promise(resolve => { resolveAi = resolve; });
    },
    cancel: () => Promise.reject(new Error('cancel response unavailable'))
  };
  const saves = [];
  context.chrome.runtime.sendMessage = async message => {
    saves.push(message);
    return { status: 'saved' };
  };

  const recognition = hooks.handleSaveJobClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hooks.getSaveInteractionState().extractInFlight, true);
  hooks.cancelJobAssist();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(form.hidden, false);
  assert.equal(saveButton.disabled, false);
  inputs['#resume-pro-save-company'].value = '星河科技';
  inputs['#resume-pro-save-title'].value = '工艺工程师';
  await hooks.handleSaveJobClick();
  assert.equal(aiCalls, 1, 'the open manual form must not restart extraction');
  assert.equal(inputs['#resume-pro-save-title'].value, '工艺工程师');
  await hooks.submitSaveForm({ force: false });
  assert.equal(saves.length, 1);
  assert.equal(saves[0].fields.title, '工艺工程师');

  resolveAi({ status: 'ok', fields: { company: 'wrong', title: 'wrong' } });
  await recognition;
  assert.equal(form.hidden, true, 'a late AI reply must not reopen the completed form');
  assert.equal(hooks.getSaveInteractionState().saveInFlight, false);
});

test("save again after a duplicate resends the confirmed fields, including the redacted URLs", async () => {
  const { hooks, context } = loadContentScript();
  const inputs = Object.fromEntries([
    '#resume-pro-save-company', '#resume-pro-save-title', '#resume-pro-save-location',
    '#resume-pro-save-url', '#resume-pro-save-note'
  ].map(key => [key, { value: '', textContent: '' }]));
  const form = { hidden: true, querySelector: key => inputs[key] ?? null };
  const buttons = [];
  const statusBox = {
    textContent: '', className: '', classList: { add() {} },
    appendChild(node) { if (node.tag === 'button') buttons.push(node); }
  };
  context.document.createElement = tag => ({
    tag, textContent: '', className: '', listeners: {},
    addEventListener(type, handler) { this.listeners[type] = handler; }
  });
  hooks.setShadowRoot({
    querySelector(selector) {
      return {
        '#resume-pro-save-form': form,
        '#resume-pro-save-job': { disabled: false },
        '#resume-pro-desktop-status': statusBox
      }[selector] ?? null;
    }
  });
  const saveFlow = await import('../link/save-flow.mjs');
  const copy = await import('../link/copy.mjs');
  hooks.setDesktopModules({
    extract: {
      extractJobFields: () => ({
        company: '星河科技', title: '工艺工程师', location: '', reliable: true,
        sourceUrl: 'https://jobs.example.test/apply/7', dedupeUrl: 'https://jobs.example.test/apply/7'
      })
    },
    saveFlow,
    copy
  });
  const sent = [];
  context.chrome.runtime.sendMessage = async message => {
    if (message?.type !== 'DESKTOP_SAVE_JOB') return { intents: [], outbox: [], fillRecords: [] };
    sent.push(message);
    return sent.length === 1 ? { status: 'duplicate' } : { status: 'saved' };
  };

  await hooks.handleSaveJobClick();
  await hooks.submitSaveForm({ force: false });
  assert.equal(form.hidden, true, 'a duplicate closes the form');
  const again = buttons.find(button => button.textContent === '再存一次');
  assert.ok(again, 'the duplicate offers saving again');
  await again.listeners.click();

  assert.equal(sent.length, 2);
  assert.equal(sent[1].force, true);
  assert.equal(sent[1].fields.sourceUrl, 'https://jobs.example.test/apply/7');
  assert.equal(sent[1].fields.dedupeUrl, 'https://jobs.example.test/apply/7');
  assert.equal(sent[1].fields.company, '星河科技');
});

test("a full outbound queue reports the retained intent instead of claiming nothing was kept", async () => {
  const { hooks } = loadContentScript();
  const copy = await import('../link/copy.mjs');
  const result = hooks.describeCommit(copy, {
    status: 'rejected', reason: 'queue_full', intent: { intentId: 'intent-1' }
  });
  assert.match(result.text, /岗位已留在待同步列表/);
  assert.match(result.text, /还没有写入桌面/);
});

test("a bound write failure closes the save form and points to the retained queue entry", async () => {
  const { hooks } = loadContentScript();
  const form = { hidden: false };
  hooks.setShadowRoot({ querySelector: selector => selector === '#resume-pro-save-form' ? form : null });
  const copy = await import('../link/copy.mjs');

  hooks.presentSaveResult(copy, {
    status: 'failed', code: 'invalid_payload', intent: { intentId: 'intent-1' }
  });

  assert.equal(form.hidden, true);
  const described = hooks.describeCommit(copy, {
    status: 'failed', code: 'invalid_payload', intent: { intentId: 'intent-1' }
  });
  assert.match(described.text, /待同步列表/);
});

test('the page reads the desktop only while its own panel is on screen', async () => {
  const reads = [];
  const { hooks } = loadContentScript({ desktopReply: async message => {
    if (message.type === 'DESKTOP_RESUME_READ') reads.push(message);
    return { status: 'ok', data: { templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 0 } };
  } });
  const classes = new Set();
  const panel = { classList: { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name) } };
  hooks.setShadowRoot({ querySelector: selector => selector === '.resume-pro' ? panel : null });

  assert.equal(await hooks.refreshVisibleStore(), false);
  assert.equal(reads.length, 0, 'a hidden panel (native side panel in use) must not start the native host');
  classes.add('is-legacy-open');
  // This bare shadow root has no panel markup to render into; only the read matters here.
  await hooks.refreshVisibleStore().catch(() => {});
  assert.equal(reads.length, 1);
});

test('loading a page does not read the desktop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const init = source.slice(source.indexOf('async function init()'), source.indexOf('function inPageUiVisible()'));
  assert.ok(init.length > 0);
  assert.equal(init.includes('StorageService.getState'), false);
  assert.equal(init.includes('DESKTOP_RESUME_READ'), false);
});
