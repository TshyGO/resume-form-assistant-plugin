const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHighlightHelpers(options = {}) {
  let desktopData = null;
  const timers = [];
  const clearedTimers = [];
  const clipboardWrites = [];
  const desktopMessages = [];
  const documentListeners = {};
  const storageWrites = [];
  let panelMessageListener = null;

  class ClassList {
    constructor() {
      this.values = new Set();
    }

    add(value) {
      this.values.add(value);
    }

    remove(value) {
      this.values.delete(value);
    }

    contains(value) {
      return this.values.has(value);
    }

    toggle(value, force) {
      const shouldAdd = force === undefined ? !this.values.has(value) : Boolean(force);
      if (shouldAdd) {
        this.values.add(value);
      } else {
        this.values.delete(value);
      }
      return shouldAdd;
    }
  }

  class HTMLElement {
    constructor() {
      this.classList = new ClassList();
      this.labels = [];
      this.parentElement = null;
      this.textContent = "";
      this.value = "";
      this.type = "text";
      this.disabled = false;
      this.readOnly = false;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.isConnected = true;
      this.id = "";
      this.name = "";
      this.dataset = {};
      this.attributes = {};
      this.previousElementSibling = null;
      this.offsetWidth = 100;
      this.scrollCalls = [];
      this.dispatchedEvents = [];
      this.rect = { top: 0, left: 0, bottom: 32, right: 240, width: 240, height: 32 };
    }

    getAttribute(name) {
      return this.attributes[name] ?? this[name] ?? null;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    closest() {
      return null;
    }

    getBoundingClientRect() {
      return this.rect;
    }

    scrollIntoView(options) {
      this.scrollCalls.push(options);
      if (typeof this.afterScroll === "function") {
        this.afterScroll();
      }
    }

    dispatchEvent(event) {
      this.dispatchedEvents.push(event);
      return true;
    }

    focus() {
      document.activeElement = this;
    }

    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
  }

  class HTMLInputElement extends HTMLElement {
    constructor() {
      super();
      this.tagName = "INPUT";
    }
  }
  class HTMLLabelElement extends HTMLElement {
    constructor() {
      super();
      this.tagName = "LABEL";
    }
  }

  const styleElements = [];
  const document = {
    readyState: "loading",
    activeElement: null,
    documentElement: { clientHeight: 600, clientWidth: 800 },
    head: {
      appendChild(element) {
        styleElements.push(element);
      }
    },
    addEventListener(type, listener) {
      (documentListeners[type] ||= []).push(listener);
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("input:not")) {
        return options.formElements || [];
      }
      return [];
    },
    createElement(tagName) {
      return { tagName: tagName.toUpperCase(), id: "", textContent: "" };
    },
    getElementById(id) {
      return styleElements.find((element) => element.id === id) || null;
    },
    contains(element) {
      return element?.isConnected !== false;
    }
  };

  const window = {
    innerHeight: 600,
    innerWidth: 800,
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    },
    setTimeout(callback, delay) {
      const id = timers.length + 1;
      timers.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    }
  };
  window.top = window;
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLSelectElement extends HTMLElement {}

  const context = {
    console,
    performance: options.performance || performance,
    CSS: { escape: (value) => String(value) },
    Event: class {},
    FocusEvent: class {},
    MouseEvent: class {},
    HTMLElement,
    HTMLInputElement,
    HTMLLabelElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    chrome: {
      ...(options.storageSpy ? {
        storage: Object.fromEntries(["local", "session", "sync"].map((area) => [area, {
          get: async () => ({}),
          set: async (value) => { storageWrites.push({ area, value }); },
          remove: async () => {}
        }]))
      } : {}),
      runtime: {
        id: 'test-extension',
        getManifest: () => ({ version: "0.2.1" }),
        onMessage: { addListener(listener) { panelMessageListener = listener; } },
        sendMessage: async message => message.type === 'DESKTOP_RESUME_READ'
          ? { status: 'ok', data: desktopData }
          : (desktopMessages.push(message), message.type === 'DESKTOP_OPEN_VIEW'
            ? { status: 'ok' } : options.sendMessage ? options.sendMessage(message) : { success: true, matches: [] })
      }
    },
    crypto: { randomUUID: () => "test-id" },
    document,
    navigator: { clipboard: { writeText: async (value) => { clipboardWrites.push(value); } } },
    self: { __RESUME_PRO_TEST__: true, ResumeProFormAgent: options.formAgent,
      ResumeProResumeData: require('../resume-data.js'), ResumeProProfile: require('../profile-fields.js'),
      ResumeProAIClient: { send: options.sendMessage || (async () => ({ success: true, matches: [] })),
        cancel: requestId => options.sendMessage({ type: 'CANCEL_AI_FILL', requestId }) } },
    window
  };

  context.globalThis = context;
  context.self.window = window;
  context.window.document = document;
  window.confirm = options.confirm || (() => false);
  window.setInterval = (callback, delay) => {
    const id = window.setTimeout(callback, delay);
    return id;
  };
  window.clearInterval = window.clearTimeout;

  const contentJs = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInNewContext(contentJs, context);
  context.self.ResumeProHighlightTest.setTextCommitWaitMs(0);
  const helpers = context.self.ResumeProHighlightTest;
  const setCurrentStore = helpers.setCurrentStore;
  helpers.setCurrentStore = store => {
    const activeTemplate = store.activeTemplate || store.templates?.find(template => template.id === store.activeTemplateId) || store.templates?.[0] || null;
    desktopData = {
      templates: (store.templates || []).map(template => ({ id: template.id, name: template.name || '模板', fieldCount: template.groups?.flatMap(group => group.fields).length || 0 })),
      activeTemplate, profile: store.profile || { values: {}, family: [], custom: [] }, profileRevision: store.profileRevision || 0
    };
    setCurrentStore({ ...store, activeTemplate });
  };

  return {
    helpers,
    window,
    timers,
    clearedTimers,
    clipboardWrites,
    desktopMessages,
    styleElements,
    documentListeners,
    storageWrites,
    HTMLElement,
    HTMLInputElement,
    HTMLLabelElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    document,
    // Delivers a message the way chrome.runtime does, and resolves with its response
    // after the same JSON round trip a real message goes through.
    sendPanelMessage(message, sender = { id: "test-extension" }) {
      return new Promise((resolve) => {
        const respond = (response) => resolve(response === undefined ? undefined : JSON.parse(JSON.stringify(response)));
        const keepOpen = panelMessageListener(JSON.parse(JSON.stringify(message)), sender, respond);
        if (!keepOpen) setImmediate(() => resolve(undefined));
      });
    },
    fireDocumentEvent(type, event) {
      (documentListeners[type] || []).forEach((listener) => listener(event));
    }
  };
}

test("injects highlight styles into the page document", () => {
  const { helpers, styleElements } = loadHighlightHelpers();

  helpers.injectFieldHighlightStyles();

  assert.equal(styleElements.length, 1);
  assert.equal(styleElements[0].id, "resume-pro-field-highlight-styles");
  assert.match(styleElements[0].textContent, /\.resume-pro__field-highlight/);
});

test("native side panel field action fills the focused page input without replacing existing text", async () => {
  const { helpers, HTMLElement, HTMLInputElement, clipboardWrites } = loadHighlightHelpers();
  const chip = new HTMLElement();
  chip.dataset.chipId = "one:0:0";
  chip.dataset.value = "张三";
  helpers.setShadowRoot({
    querySelector: () => null,
    querySelectorAll: (selector) => selector === ".resume-pro__chip" ? [chip] : []
  });
  const input = new HTMLInputElement();
  helpers.setLastFocusedField(input);

  const first = await helpers.handlePanelFieldAction({ chipId: "one:0:0", mode: "fill" });
  assert.equal(first.ok, true);
  assert.equal(input.value, "张三");
  assert.deepEqual(clipboardWrites, [], "a successful fill should leave the user's clipboard alone");

  input.value = "已有内容";
  const second = await helpers.handlePanelFieldAction({ chipId: "one:0:0", mode: "fill" });
  assert.equal(second.ok, false);
  assert.equal(second.needsChoice, true, "a filled text box asks for an explicit add or replace");
  assert.equal(second.needsCopy, undefined, "composing never falls back to the clipboard");
  assert.match(second.message, /已有内容/);
  assert.equal(input.value, "已有内容");
  assert.deepEqual(clipboardWrites, [], "the page bridge leaves copying to the focused side panel");

  const nonTextInput = new HTMLInputElement();
  nonTextInput.type = "week";
  nonTextInput.value = "2026-W12";
  helpers.setLastFocusedField(nonTextInput);
  const nonTextResult = await helpers.handlePanelFieldAction({ chipId: "one:0:0", mode: "fill" });
  assert.equal(nonTextResult.ok, false);
  assert.equal(nonTextResult.needsCopy, true);
  assert.match(nonTextResult.message, /已有内容/);
  assert.equal(nonTextInput.value, "2026-W12", "a filled non-text control must not be overwritten");
  assert.deepEqual(clipboardWrites, []);

  const missing = await helpers.handlePanelFieldAction({ chipId: "missing", mode: "fill" });
  assert.equal(missing.ok, false);
});

test("native side panel can address a saved 我的信息 field by its group and key", async () => {
  const { helpers, HTMLElement, HTMLInputElement } = loadHighlightHelpers();
  const chip = new HTMLElement();
  chip.dataset.chipId = "profile:补充字段:期望薪资";
  chip.dataset.value = "面议";
  helpers.setShadowRoot({
    querySelector: () => null,
    querySelectorAll: (selector) => selector === ".resume-pro__chip" ? [chip] : []
  });
  const input = new HTMLInputElement();
  helpers.setLastFocusedField(input);
  const result = await helpers.handlePanelFieldAction({ chipId: "profile:补充字段:期望薪资", mode: "fill" });
  assert.equal(result.ok, true);
  assert.equal(input.value, "面议");
});

test('a trusted side panel supplies its current value when hidden page chips are stale', async () => {
  const { helpers, HTMLInputElement } = loadHighlightHelpers();
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: () => null });
  const input = new HTMLInputElement();
  helpers.setLastFocusedField(input);
  const result = await helpers.handlePanelFieldAction({ chipId: 'new:0:0', value: '桌面新值', mode: 'fill' }, { id: 'test-extension' });
  assert.equal(result.ok, true);
  assert.equal(input.value, '桌面新值');
  const other = await helpers.handlePanelFieldAction({ chipId: 'new:0:0', value: '不可信', mode: 'fill' }, { id: 'other-extension' });
  assert.equal(other.ok, false);
});

test("off-screen fields scroll into view before the highlight animation starts", () => {
  const { helpers, timers, HTMLElement } = loadHighlightHelpers();
  const field = new HTMLElement();
  field.rect = { top: 900, left: 0, bottom: 932, right: 240 };

  helpers.highlightFilledField(field, "");

  assert.equal(field.scrollCalls.length, 1);
  assert.equal(field.scrollCalls[0].block, "center");
  assert.equal(field.scrollCalls[0].behavior, "smooth");
  assert.equal(field.classList.contains("resume-pro__field-highlight"), false);

  const firstPollTimer = timers.find((timer) => timer.delay === 100);
  assert.ok(firstPollTimer);
  firstPollTimer.callback();
  assert.equal(field.classList.contains("resume-pro__field-highlight"), false);

  field.rect = { top: 100, left: 0, bottom: 132, right: 240 };
  const secondPollTimer = timers.find((timer) => timer.id !== firstPollTimer.id && timer.delay === 100);
  assert.ok(secondPollTimer);
  secondPollTimer.callback();

  assert.equal(field.classList.contains("resume-pro__field-highlight"), true);
});

test("AI fill loop highlights fields after successful writes", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements,
    sendMessage: async () => ({
      success: true,
      matches: [{ fieldId: "field-0", value: "测试用户" }]
    })
  });
  const input = new HTMLInputElement();
  input.name = "fullName";
  input.rect = { top: 0, left: 0, bottom: 32, right: 240, width: 240, height: 32 };
  formElements.push(input);

  helpers.setCurrentStore({
    templates: [{ id: "template-1", name: "默认模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }],
    activeTemplateId: "template-1",
    aiConfig: { apiUrl: "https://example.test", model: "test-model", apiKey: "test-key" }
  });

  await helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });

  assert.equal(input.value, "测试用户");
  assert.equal(input.classList.contains("resume-pro__field-highlight"), true);
});

test('partial local success still opens desktop AI settings when AI is not configured', async () => {
  const formElements = [];
  const { helpers, desktopMessages, HTMLInputElement } = loadHighlightHelpers({
    formElements,
    sendMessage: async () => ({ success: true, matches: [], warning: '桌面还没有配置 AI 服务商。', openView: 'settings-ai' })
  });
  formElements.push(new HTMLInputElement());
  helpers.setCurrentStore({
    templates: [{ id: 'one', groups: [{ name: '基本信息', fields: [{ key: '姓名', value: '测试用户' }] }] }],
    activeTemplateId: 'one'
  });
  await helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.ok(desktopMessages.some(message => message.type === 'DESKTOP_OPEN_VIEW' && message.view === 'settings-ai'));
});

test("radio fields highlight an externally associated label when available", () => {
  const { helpers, HTMLInputElement, HTMLLabelElement } = loadHighlightHelpers();
  const radio = new HTMLInputElement();
  const label = new HTMLLabelElement();
  label.textContent = "男";
  radio.labels = [label];
  radio.value = "male";

  const targets = helpers.getHighlightTargets({ kind: "radio", elements: [radio] }, "男");

  assert.equal(targets.length, 1);
  assert.equal(targets[0], label);
});

test("repeated highlights clear the previous cleanup timer", () => {
  const { helpers, timers, clearedTimers, HTMLElement } = loadHighlightHelpers();
  const field = new HTMLElement();

  helpers.highlightFilledField(field, "");
  helpers.highlightFilledField(field, "");

  assert.equal(field.classList.contains("resume-pro__field-highlight"), true);
  assert.equal(timers.filter((timer) => timer.delay === 2800).length, 2);
  assert.deepEqual(clearedTimers, [1]);
});

for (const outcome of ["success", "partial", "failure", "transport"]) {
  test(`AI progress and timers clean up after ${outcome}, repeated clicks are ignored`, async () => {
    let finish;
    let calls = 0;
    const formElements = [];
    const { helpers, timers, HTMLInputElement } = loadHighlightHelpers({
      formElements,
      sendMessage: () => { calls++; return new Promise((resolve, reject) => { finish = outcome === "transport" ? reject : resolve; }); }
    });
    formElements.push(new HTMLInputElement());
    helpers.setCurrentStore({
      templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试" }] }] }],
      activeTemplateId: "one", aiConfig: { apiKey: "key", apiUrl: "https://example.test", model: "test" }
    });
    const button = { disabled: false, textContent: "" };
    const pending = helpers.handleAiFillClick({ currentTarget: button });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(button.disabled, true);
    assert.match(button.textContent, /AI 匹配中.*0s/);
    await helpers.handleAiFillClick({ currentTarget: button });
    assert.equal(calls, 1);
    const timer = timers.find((item) => item.delay === 1000);
    assert.ok(timer);
    timer.callback();
    finish(outcome === "transport" ? new Error("connection closed") : {
      success: outcome !== "failure", warning: outcome === "partial" ? "AI 超时" : "",
      error: "AI 请求失败", matches: []
    });
    await pending;
    assert.equal(timer.cleared, true);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "一键 AI 填写");
  });
}

test("90-second reminder does not cancel; manual button sends matching request and cleans up", async () => {
  let clock = 0;
  let finish;
  const messages = [];
  const formElements = [];
  const { helpers, timers, HTMLInputElement } = loadHighlightHelpers({
    formElements, performance: { now: () => clock },
    sendMessage: (message) => {
      messages.push(message);
      if (message.type === "CANCEL_AI_FILL") {
        finish({ success: true, warning: "已取消 AI 等待", matches: [], diagnostics: { errorCode: "cancelled" } });
        return Promise.resolve({ cancelled: true });
      }
      return new Promise(resolve => { finish = resolve; });
    }
  });
  const cancel = { hidden: true }, hint = { hidden: true };
  helpers.setShadowRoot({ querySelector: (selector) => ({ "#resume-pro-cancel-fill": cancel, "#resume-pro-wait-hint": hint })[selector] });
  formElements.push(new HTMLInputElement());
  helpers.setCurrentStore({ templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试" }] }] }],
    activeTemplateId: "one", aiConfig: { apiKey: "key", apiUrl: "https://example.test", model: "test" } });
  const button = { disabled: false };
  const pending = helpers.handleAiFillClick({ currentTarget: button });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancel.hidden, false);
  const timer = timers.find(item => item.delay === 1000);
  clock = 90000;
  timer.callback();
  assert.equal(messages.length, 1);
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /不会.*自动取消/);
  assert.match(hint.textContent, /通常.*上游/);
  clock = 120000;
  timer.callback();
  assert.equal(messages.length, 1);
  assert.match(button.textContent, /120s/);
  await cancel.onclick();
  await pending;
  assert.equal(messages[1].type, "CANCEL_AI_FILL");
  assert.equal(messages[1].requestId, messages[0].requestId);
  assert.equal(timer.cleared, true);
  assert.equal(cancel.hidden, true);
  assert.equal(cancel.onclick, null);
  assert.equal(hint.hidden, true);
  assert.equal(button.disabled, false);
});

test("assisted filling excludes existing and unrelated values, including user edits during API wait", async () => {
  const formElements = [];
  let sent;
  const { helpers, HTMLInputElement } = loadHighlightHelpers({ formElements, sendMessage: async message => {
    sent = message;
    formElements[1].value = "用户在等待时输入";
    return { success: true, matches: [{ fieldId: 'field-1', value: 'AI 不应覆盖' }] };
  } });
  for (let i = 0; i < 3; i++) {
    const input = new HTMLInputElement();
    input.isConnected = true;
    input.value = i === 0 ? '已有内容' : '';
    formElements.push(input);
  }
  helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '论文', fields: [{ key: '论文1标题', value: '合成' }] }] }], activeTemplateId: 'one', aiConfig: { apiKey: 'key', apiUrl: 'https://example.test', model: 'test' } });
  await helpers.handleAiFillClick({ currentTarget: { disabled: false } }, { scopes: [{ isConnected: true, contains: el => formElements.slice(0, 2).includes(el) }] });
  assert.equal(sent.formFields.length, 1);
  assert.equal(sent.formFields[0].fieldId, 'field-1');
  assert.deepEqual(formElements.map(el => el.value), ['已有内容', '用户在等待时输入', '']);
});

for (const stopped of [false, true]) {
  test(`assisted preparation does not execute after ${stopped ? 'stop' : 'declined preview'}`, async () => {
    let finish, executions = 0;
    const formAgent = {
      collect: () => ({ candidates: [{ id: 'add-0', label: '新增论文' }] }),
      validatePlan: plan => plan,
      execute: () => { executions++; }
    };
    const { helpers, timers } = loadHighlightHelpers({ formAgent, confirm: () => false,
      sendMessage: message => message.type === 'CANCEL_AI_FILL' ? Promise.resolve({ cancelled: true }) : new Promise(resolve => { finish = resolve; }) });
    const button = { disabled: false }, fillButton = { disabled: false }, cancel = {}, hint = {};
    helpers.setShadowRoot({ querySelector: selector => ({ '#resume-pro-ai-fill': fillButton, '#resume-pro-cancel-fill': cancel, '#resume-pro-wait-hint': hint })[selector] });
    helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '论文', fields: [{ key: '论文1标题', value: '合成' }] }] }], activeTemplateId: 'one', aiConfig: { apiKey: 'key', apiUrl: 'https://example.test', model: 'test' } });
    const pending = helpers.handleRepeatFillClick({ currentTarget: button });
    await new Promise(resolve => setImmediate(resolve));
    if (stopped) cancel.onclick();
    finish({ success: true, plan: [{ id: 'add-0', count: 2 }] });
    await pending;
    assert.equal(executions, 0);
    assert.equal(button.disabled, false);
    assert.equal(fillButton.disabled, false);
    assert.equal(cancel.hidden, true);
    assert.equal(cancel.onclick, null);
    assert.equal(timers.find(t => t.delay === 1000).cleared, true);
  });
}

test('assisted add releases the fill button when collection fails before AI starts', async () => {
  let calls = 0;
  const formAgent = { collect() { calls += 1; throw new Error('synthetic'); } };
  const { helpers } = loadHighlightHelpers({ formAgent });
  const fillButton = { disabled: false };
  helpers.setShadowRoot({ querySelector: selector => selector === '#resume-pro-ai-fill' ? fillButton : null });
  helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本信息', fields: [{ key: '姓名', value: '测试' }] }] }], activeTemplateId: 'one' });
  const button = { disabled: false };
  await helpers.handleRepeatFillClick({ currentTarget: button });
  assert.equal(fillButton.disabled, false);
  await helpers.handleRepeatFillClick({ currentTarget: button });
  assert.equal(calls, 2, 'a failed collection must not leave the busy guard set');
});

test('assisted add stops before AI fill when the desktop template changes during execution', async () => {
  const sent = [];
  let helpers;
  const formAgent = {
    collect: () => ({ candidates: [{ id: 'add-0', label: '新增论文' }] }),
    validatePlan: plan => plan,
    execute: () => {
      helpers.setCurrentStore({ templates: [{ id: 'two', groups: [{ name: '新模板', fields: [{ key: '学校', value: '大学乙' }] }] }], activeTemplateId: 'two' });
      return { scopes: [] };
    }
  };
  ({ helpers } = loadHighlightHelpers({ formAgent, confirm: () => true,
    sendMessage: async message => { sent.push(message); return { success: true, plan: [{ id: 'add-0', count: 1 }] }; } }));
  const fillButton = { disabled: false }, cancel = {}, hint = { hidden: true };
  helpers.setShadowRoot({ querySelector: selector => ({ '#resume-pro-ai-fill': fillButton, '#resume-pro-cancel-fill': cancel, '#resume-pro-wait-hint': hint })[selector] || null });
  helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '论文', fields: [{ key: '论文1标题', value: '合成' }] }] }], activeTemplateId: 'one' });
  await helpers.handleRepeatFillClick({ currentTarget: { disabled: false } });
  assert.equal(sent.filter(message => message.type === 'AI_PLAN_REPEAT').length, 1);
  assert.equal(sent.filter(message => message.type === 'AI_FILL').length, 0);
  assert.equal(fillButton.disabled, false);
});

test("diagnostic summary only exposes allowlisted counts, durations and errors", () => {
  const { helpers } = loadHighlightHelpers();
  const summary = helpers.formatFillDiagnostics({
    scanMs: 100, roundTripMs: 1000, fillMs: null, totalMs: 1100,
    fieldCount: 2, filledCount: 0, unfilledCount: 1, outcome: "failed",
    diagnostics: { errorCode: "secret-key", apiKey: "secret-key", apiMs: 900, ruleMatches: 1, resumeFields: "private-name" }
  });
  assert.match(summary, /没填上：1/);
  assert.match(summary, /0.10 s/);
  assert.match(summary, /1.10 s/);
  assert.match(summary, /未执行 \/ 未取得/);
  assert.ok(!summary.includes("secret-key"));
  assert.ok(!summary.includes("private-name"));
});

test("chip text can be added at the caret, replaced, and removed", () => {
  const { helpers } = loadHighlightHelpers();

  const empty = helpers.composeChipText("", "A", "add", { start: 0, end: 0 });
  assert.equal(empty.value, "A");
  assert.equal(empty.caret, 1);

  const appended = helpers.composeChipText("A", "B", "add", { start: 1, end: 1 });
  assert.equal(appended.value, "AB");
  assert.equal(appended.caret, 2);

  const inserted = helpers.composeChipText("AB", "C", "add", { start: 1, end: 1 });
  assert.equal(inserted.value, "ACB");
  assert.equal(inserted.caret, 2);

  const replaced = helpers.composeChipText("AB", "C", "replace", { start: 1, end: 1 });
  assert.equal(replaced.value, "C");
  assert.equal(replaced.caret, 1);

  const removed = helpers.composeChipText("AB", "A", "remove", { start: 2, end: 2 });
  assert.equal(removed.value, "B");
  assert.equal(removed.caret, 0);
});

test("chip addition writes the combined value and restores the caret", async () => {
  const { helpers, HTMLInputElement } = loadHighlightHelpers();
  const input = new HTMLInputElement();
  input.value = "AB";
  input.selectionStart = 1;
  input.selectionEnd = 1;

  const filled = await helpers.applyChipValue(input, "C", "add", { start: 1, end: 1 });

  assert.equal(filled, true);
  assert.equal(input.value, "ACB");
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 2);
  // input、change，以及这个测试桩没有 blur() 时补上的 blur 事件。
  assert.equal(input.dispatchedEvents.length, 3);
});

test("a nonempty input waits for add or replace, while a selected chip is removed directly", async () => {
  const { helpers, timers, HTMLElement, HTMLInputElement } = loadHighlightHelpers();
  const menu = new HTMLElement();
  menu.hidden = true;
  menu.style = {};
  menu.rect = { top: 0, left: 0, bottom: 44, right: 116, width: 116, height: 44 };
  const status = new HTMLElement();
  status.className = "resume-pro__status";
  const chipA = new HTMLElement();
  chipA.dataset.value = "A";
  chipA.textContent = "字段 A";
  const chipB = new HTMLElement();
  chipB.dataset.value = "B";
  chipB.textContent = "字段 B";
  helpers.setShadowRoot({
    querySelector(selector) {
      return ({
        "#resume-pro-chip-actions": menu,
        "#resume-pro-status": status
      })[selector] || null;
    },
    querySelectorAll(selector) {
      return selector === ".resume-pro__chip" ? [chipA, chipB] : [];
    }
  });

  const input = new HTMLInputElement();
  input.value = "A";
  input.selectionStart = 1;
  input.selectionEnd = 1;
  helpers.setLastFocusedField(input);

  await helpers.handleFieldChipClick(chipB);
  assert.equal(menu.hidden, false);
  assert.equal(input.value, "A");

  await helpers.handleChipAction("add");
  assert.equal(menu.hidden, true);
  assert.equal(input.value, "AB");

  input.value = "A";
  input.selectionStart = 1;
  input.selectionEnd = 1;
  await helpers.handleFieldChipClick(chipB);
  await helpers.handleChipAction("replace");
  assert.equal(input.value, "B");

  input.selectionStart = 0;
  input.selectionEnd = 0;
  await helpers.handleFieldChipClick(chipA);
  await helpers.handleChipAction("add");
  assert.equal(input.value, "AB");

  await helpers.handleFieldChipClick(chipA);
  assert.equal(input.value, "B");
  assert.equal(chipA.textContent, "字段 A");
  assert.equal(chipB.textContent, "字段 B");
  assert.equal(status.className, "resume-pro__status");
  assert.equal(status.textContent, "");
  assert.equal(timers.length, 0);
});

test("chips deepen when their values occur in the focused input", () => {
  const { helpers, HTMLElement, HTMLInputElement } = loadHighlightHelpers();
  const buttons = ["A", "B", "C"].map((value) => {
    const button = new HTMLElement();
    button.dataset.value = value;
    return button;
  });
  const input = new HTMLInputElement();
  input.value = "ABC";
  helpers.setShadowRoot({
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === ".resume-pro__chip" ? buttons : [];
    }
  });
  helpers.setLastFocusedField(input);

  helpers.syncChipSelectionState();
  assert.deepEqual(buttons.map((button) => button.classList.contains("is-in-field")), [true, true, true]);

  input.value = "BC";
  helpers.syncChipSelectionState();
  assert.deepEqual(buttons.map((button) => button.classList.contains("is-in-field")), [false, true, true]);
  assert.equal(buttons[0].attributes["aria-pressed"], "false");
});

test("chips with identical values keep independent selected states", async () => {
  const { helpers, HTMLElement, HTMLInputElement } = loadHighlightHelpers();
  const menu = new HTMLElement();
  menu.hidden = true;
  menu.style = {};
  menu.rect = { top: 0, left: 0, bottom: 44, right: 116, width: 116, height: 44 };
  const chipA = new HTMLElement();
  chipA.dataset.chipId = "field-a";
  chipA.dataset.value = "相同内容";
  const chipC = new HTMLElement();
  chipC.dataset.chipId = "field-c";
  chipC.dataset.value = "相同内容";
  helpers.setShadowRoot({
    querySelector(selector) {
      return selector === "#resume-pro-chip-actions" ? menu : null;
    },
    querySelectorAll(selector) {
      return selector === ".resume-pro__chip" ? [chipA, chipC] : [];
    }
  });
  const input = new HTMLInputElement();
  helpers.setLastFocusedField(input);

  await helpers.handleFieldChipClick(chipA);
  assert.equal(input.value, "相同内容");
  assert.equal(chipA.classList.contains("is-in-field"), true);
  assert.equal(chipC.classList.contains("is-in-field"), false);

  await helpers.handleFieldChipClick(chipC);
  assert.equal(menu.hidden, false);
  assert.equal(input.value, "相同内容");

  await helpers.handleChipAction("replace");
  assert.equal(chipA.classList.contains("is-in-field"), false);
  assert.equal(chipC.classList.contains("is-in-field"), true);

  const secondInput = new HTMLInputElement();
  helpers.setLastFocusedField(secondInput);
  await helpers.handleFieldChipClick(chipC);
  assert.equal(secondInput.value, "相同内容");
  assert.equal(chipA.classList.contains("is-in-field"), false);
  assert.equal(chipC.classList.contains("is-in-field"), true);
});

test("replacement clears a previously selected chip even when its value prefixes the new chip", async () => {
  const { helpers, HTMLElement, HTMLInputElement } = loadHighlightHelpers();
  const menu = new HTMLElement();
  menu.hidden = true;
  menu.style = {};
  menu.rect = { top: 0, left: 0, bottom: 44, right: 116, width: 116, height: 44 };
  const chips = [
    ["field-a", "产品"],
    ["field-b", "经理"],
    ["field-c", "产品设计师"]
  ].map(([chipId, value]) => {
    const chip = new HTMLElement();
    chip.dataset.chipId = chipId;
    chip.dataset.value = value;
    return chip;
  });
  helpers.setShadowRoot({
    querySelector(selector) {
      return selector === "#resume-pro-chip-actions" ? menu : null;
    },
    querySelectorAll(selector) {
      return selector === ".resume-pro__chip" ? chips : [];
    }
  });
  const input = new HTMLInputElement();
  input.value = "产品经理";
  input.selectionStart = input.value.length;
  input.selectionEnd = input.value.length;
  helpers.setLastFocusedField(input);
  helpers.syncChipSelectionState();
  assert.deepEqual(chips.map((chip) => chip.classList.contains("is-in-field")), [true, true, false]);

  await helpers.handleFieldChipClick(chips[2]);
  await helpers.handleChipAction("replace");

  assert.equal(input.value, "产品设计师");
  assert.deepEqual(chips.map((chip) => chip.classList.contains("is-in-field")), [false, false, true]);
});

test("highlight styles are not duplicated in content.css", () => {
  const contentCss = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");

  assert.doesNotMatch(contentCss, /\.resume-pro__field-highlight\b/);
  assert.doesNotMatch(contentCss, /@keyframes\s+resume-pro-field-highlight\b/);
});

// ---- #174: the native side panel composes fields the way the old page overlay did ----

const Compose = require("../sidepanel-compose.js");
const ownerChips = (pairs) => pairs.map(([chipId, value]) => ({ chipId, value }));
const AB = ownerChips([["a", "A"], ["b", "B"], ["c", "C"]]);

function textInput(ctx, value = "", caret = value.length) {
  const input = new ctx.HTMLInputElement();
  input.value = value;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  return input;
}

const queryTarget = (ctx, chips = AB) => ctx.sendPanelMessage({ type: "RESUME_PANEL_TARGET", chips });
const composeAction = (ctx, mode, chipId, chips = AB) => ctx.sendPanelMessage({
  type: "RESUME_PANEL_FIELD", mode, chipId, value: chips.find((chip) => chip.chipId === chipId).value, chips
});
const rowsOf = (state, chips = AB) => Object.fromEntries(chips.map((chip) => [chip.chipId, Compose.rowState(Compose.normalizeTargetState(state), chip.chipId)]));

test("no web target: nothing is selected and no action can run", async () => {
  const ctx = loadHighlightHelpers();
  const state = await queryTarget(ctx);
  assert.equal(state.targetAvailable, false);
  assert.equal(state.composable, false);
  assert.deepEqual(state.selectedChipIds, []);
  for (const row of Object.values(rowsOf(state))) {
    assert.deepEqual(row, { selected: false, add: false, replace: false, remove: false });
  }
});

test("an empty text box only allows add", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.setLastFocusedField(textInput(ctx, ""));
  const state = await queryTarget(ctx);
  assert.equal(state.empty, true);
  for (const row of Object.values(rowsOf(state))) {
    assert.deepEqual(row, { selected: false, add: true, replace: false, remove: false });
  }
});

test("action availability follows the field, not only the text box", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.setLastFocusedField(textInput(ctx, "A"));
  const rows = rowsOf(await queryTarget(ctx));
  // A is already the whole box: adding it again or replacing with it changes nothing.
  assert.deepEqual(rows.a, { selected: true, add: false, replace: false, remove: true });
  // B is absent: it can be added or replace the box, but there is nothing to remove.
  assert.deepEqual(rows.b, { selected: false, add: true, replace: true, remove: false });
});

test("add, replace and remove produce A+B, B and A through the panel protocol", async () => {
  const ctx = loadHighlightHelpers();
  const input = textInput(ctx, "A");
  ctx.helpers.setLastFocusedField(input);

  const added = await composeAction(ctx, "add", "b");
  assert.equal(added.ok, true);
  assert.equal(input.value, "AB");
  let state = await queryTarget(ctx);
  assert.deepEqual([...state.selectedChipIds].sort(), ["a", "b"], "both fields are selected");

  const removed = await composeAction(ctx, "remove", "b");
  assert.equal(removed.ok, true);
  assert.equal(input.value, "A");
  state = await queryTarget(ctx);
  assert.deepEqual(state.selectedChipIds, ["a"], "only the removed field returns to normal");

  const replaced = await composeAction(ctx, "replace", "b");
  assert.equal(replaced.ok, true);
  assert.equal(input.value, "B");
  state = await queryTarget(ctx);
  assert.deepEqual(state.selectedChipIds, ["b"]);
  assert.equal(Compose.rowState(Compose.normalizeTargetState(state), "b").replace, false, "replacing again would change nothing");
  const again = await composeAction(ctx, "replace", "b");
  assert.equal(again.ok, false);
  assert.equal(input.value, "B");
});

test("a field already in the box cannot be added twice, and a missing one cannot be removed", async () => {
  const ctx = loadHighlightHelpers();
  const input = textInput(ctx, "AB");
  ctx.helpers.setLastFocusedField(input);
  const twice = await composeAction(ctx, "add", "b");
  assert.equal(twice.ok, false);
  assert.match(twice.error, /已包含/);
  const missing = await composeAction(ctx, "remove", "c");
  assert.equal(missing.ok, false);
  const onEmpty = textInput(ctx, "");
  ctx.helpers.setLastFocusedField(onEmpty);
  const replaceEmpty = await composeAction(ctx, "replace", "a");
  assert.equal(replaceEmpty.ok, false);
  assert.equal(input.value, "AB");
  assert.equal(onEmpty.value, "");
});

test("editing the text by hand recalculates the selected fields", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.bindFocusTracking();
  const input = textInput(ctx, "AB");
  ctx.helpers.setLastFocusedField(input);
  assert.deepEqual([...(await queryTarget(ctx)).selectedChipIds].sort(), ["a", "b"]);
  await composeAction(ctx, "remove", "a");
  assert.deepEqual((await queryTarget(ctx)).selectedChipIds, ["b"]);

  input.value = "AC";
  ctx.fireDocumentEvent("input", { target: input });
  assert.deepEqual([...(await queryTarget(ctx)).selectedChipIds].sort(), ["a", "c"]);
  input.value = "";
  ctx.fireDocumentEvent("input", { target: input });
  const cleared = await queryTarget(ctx);
  assert.deepEqual(cleared.selectedChipIds, []);
  assert.equal(cleared.empty, true);
});

test("a change made to a text box that is not focused is not remembered as stale field identity", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.bindFocusTracking();
  const first = textInput(ctx, "");
  const second = textInput(ctx, "");
  ctx.helpers.setLastFocusedField(first);
  await queryTarget(ctx);
  ctx.helpers.setLastFocusedField(second);
  first.value = "A";
  ctx.fireDocumentEvent("input", { target: first });
  ctx.helpers.setLastFocusedField(first);
  assert.deepEqual((await queryTarget(ctx)).selectedChipIds, ["a"]);
});

test("switching text boxes follows the new box and never reuses the old cursor", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.bindFocusTracking();
  const first = textInput(ctx, "AB", 1);
  const second = textInput(ctx, "XY", 2);
  ctx.fireDocumentEvent("focusin", { target: first });
  // Neither box can report a cursor from here on (an email input, or a page that reset it).
  first.selectionStart = first.selectionEnd = null;
  second.selectionStart = second.selectionEnd = null;

  ctx.fireDocumentEvent("focusin", { target: second });
  assert.deepEqual((await queryTarget(ctx)).selectedChipIds, [], "the new box holds none of the fields");
  assert.equal((await composeAction(ctx, "add", "c")).ok, true);
  assert.equal(second.value, "XYC", "no saved cursor for this box: append, not index 1 of the other box");
  assert.equal(first.value, "AB");

  ctx.fireDocumentEvent("focusin", { target: first });
  assert.equal((await composeAction(ctx, "add", "c")).ok, true);
  assert.equal(first.value, "ACB", "the first box kept its own cursor");
  assert.equal(first.selectionStart, 2, "the cursor sits after the inserted field");
});

test("AB with the cursor at index 1 becomes ACB and the cursor lands after C", async () => {
  const ctx = loadHighlightHelpers();
  const input = textInput(ctx, "AB", 1);
  ctx.helpers.setLastFocusedField(input);
  const result = await composeAction(ctx, "add", "c");
  assert.equal(result.ok, true);
  assert.equal(input.value, "ACB");
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 2);
});

test("an unusable cursor falls back to the end of the text", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.bindFocusTracking();
  const input = textInput(ctx, "AB", 2);
  ctx.fireDocumentEvent("focusin", { target: input });
  // The saved cursor (2) no longer fits the shorter text, and the box reports none.
  input.value = "A";
  input.selectionStart = input.selectionEnd = null;
  assert.deepEqual({ ...ctx.helpers.resolveTextSelection(input) }, { start: 1, end: 1 });
  const noCursor = textInput(ctx, "AB");
  noCursor.selectionStart = noCursor.selectionEnd = null;
  ctx.helpers.setLastFocusedField(noCursor);
  assert.equal((await composeAction(ctx, "add", "c")).ok, true);
  assert.equal(noCursor.value, "ABC");
});

test("a contenteditable keeps its cursor after the page selection is gone", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.bindFocusTracking();
  const editable = new ctx.HTMLElement();
  editable.isContentEditable = true;
  editable.textContent = "AB";
  editable.contains = (node) => node === editable;
  Object.defineProperty(editable, "firstChild", { get: () => ({ nodeType: 3, textContent: editable.textContent, nextSibling: null }) });
  let live = { start: 1, end: 1 };
  ctx.window.getSelection = () => ({
    get rangeCount() { return live ? 1 : 0; },
    getRangeAt: () => ({
      commonAncestorContainer: editable, startContainer: editable, startOffset: live.start, endContainer: editable, endOffset: live.end,
      cloneRange() {
        return { limit: 0, selectNodeContents() {}, setEnd(_node, offset) { this.limit = offset; }, toString() { return editable.textContent.slice(0, this.limit); } };
      }
    }),
    removeAllRanges() { live = null; },
    addRange(range) { live = { start: range.offset, end: range.offset }; }
  });
  ctx.document.createRange = () => ({ setStart(_node, offset) { this.offset = offset; }, collapse() {} });

  ctx.fireDocumentEvent("focusin", { target: editable });
  // The user clicked the native side panel: the page's selection is gone.
  live = null;
  ctx.fireDocumentEvent("focusout", { target: editable });

  const result = await composeAction(ctx, "add", "c");
  assert.equal(result.ok, true);
  assert.equal(editable.textContent, "ACB");
  assert.deepEqual(live, { start: 2, end: 2 }, "the caret follows the inserted field");
});

test("replace and remove leave the cursor in the box they acted on", async () => {
  const ctx = loadHighlightHelpers();
  const other = textInput(ctx, "KEEP", 2);
  const input = textInput(ctx, "AB", 2);
  ctx.helpers.setLastFocusedField(input);
  await composeAction(ctx, "remove", "a");
  assert.equal(input.value, "B");
  assert.equal(input.selectionStart, 0);
  await composeAction(ctx, "replace", "c");
  assert.equal(input.value, "C");
  assert.equal(input.selectionStart, 1);
  assert.equal(other.value, "KEEP");
  assert.equal(other.selectionStart, 2);
});

test("identical, repeated and overlapping values do not select or remove the wrong field", async () => {
  const ctx = loadHighlightHelpers();
  const same = ownerChips([["x", "相同内容"], ["y", "相同内容"]]);
  const input = textInput(ctx, "");
  ctx.helpers.setLastFocusedField(input);

  assert.equal((await composeAction(ctx, "add", "x", same)).ok, true);
  assert.deepEqual((await queryTarget(ctx, same)).selectedChipIds, ["x"], "the twin with the same value stays unselected");
  const twin = await composeAction(ctx, "remove", "y", same);
  assert.equal(twin.ok, false, "y was never added, so it cannot be removed");
  assert.equal(input.value, "相同内容");
  assert.equal((await composeAction(ctx, "remove", "x", same)).ok, true);
  assert.equal(input.value, "");

  const overlap = ownerChips([["p", "产品"], ["m", "经理"], ["pm", "产品经理"]]);
  const box = textInput(ctx, "");
  ctx.helpers.setLastFocusedField(box);
  assert.equal((await composeAction(ctx, "add", "pm", overlap)).ok, true);
  assert.deepEqual((await queryTarget(ctx, overlap)).selectedChipIds, ["pm"], "the shorter fields inside it are not selected");
  assert.equal((await composeAction(ctx, "remove", "p", overlap)).ok, false);
  assert.equal(box.value, "产品经理");

  const repeated = ownerChips([["r", "ab"]]);
  const twice = textInput(ctx, "ab-ab", 5);
  ctx.helpers.setLastFocusedField(twice);
  assert.equal((await composeAction(ctx, "remove", "r", repeated)).ok, true);
  assert.equal(twice.value, "ab-", "the occurrence nearest the cursor goes");
});

test("password, one-time-code, captcha, file and non-text targets cannot compose", async () => {
  const ctx = loadHighlightHelpers();
  const blocked = [];
  const password = textInput(ctx, "");
  password.type = "password";
  blocked.push(password);
  const otpAutocomplete = textInput(ctx, "");
  otpAutocomplete.setAttribute("autocomplete", "one-time-code");
  blocked.push(otpAutocomplete);
  const captchaByName = textInput(ctx, "");
  captchaByName.name = "captcha_code";
  blocked.push(captchaByName);
  const codeByLabel = textInput(ctx, "");
  codeByLabel.setAttribute("data-label", "短信验证码");
  blocked.push(codeByLabel);
  const secretByLabel = textInput(ctx, "");
  secretByLabel.setAttribute("aria-label", "登录密码");
  blocked.push(secretByLabel);
  const file = textInput(ctx, "");
  file.type = "file";
  blocked.push(file);
  const checkbox = textInput(ctx, "");
  checkbox.type = "checkbox";
  blocked.push(checkbox);
  blocked.push(new ctx.HTMLSelectElement());

  for (const target of blocked) {
    ctx.helpers.setLastFocusedField(target);
    const state = await queryTarget(ctx);
    assert.equal(state.targetAvailable, true);
    assert.equal(state.composable, false, `${target.type || "select"} must not compose`);
    assert.deepEqual(state.selectedChipIds, []);
    for (const mode of ["add", "replace", "remove"]) {
      assert.equal((await composeAction(ctx, mode, "a")).ok, false);
    }
    if (target.value !== undefined) assert.equal(target.value, "");
  }
  // The legacy quick path must not write a resume value into a secret or file target either.
  for (const target of [password, otpAutocomplete, captchaByName, codeByLabel, secretByLabel, file]) {
    ctx.helpers.setLastFocusedField(target);
    const quick = await ctx.sendPanelMessage({ type: "RESUME_PANEL_FIELD", mode: "fill", chipId: "a", value: "A" });
    assert.equal(quick.ok, false);
    assert.equal(target.value, "");
  }
  // An ordinary box whose name merely contains those letters is not caught.
  const footprint = textInput(ctx, "");
  footprint.name = "footprint";
  ctx.helpers.setLastFocusedField(footprint);
  assert.equal((await queryTarget(ctx)).composable, true);
});

test("a filled text box asks for an explicit button, an empty one takes the field", async () => {
  const ctx = loadHighlightHelpers();
  const input = textInput(ctx, "");
  ctx.helpers.setLastFocusedField(input);
  const quick = await ctx.sendPanelMessage({ type: "RESUME_PANEL_FIELD", mode: "fill", chipId: "a", value: "A" });
  assert.equal(quick.ok, true);
  assert.equal(input.value, "A");
  const filled = await ctx.sendPanelMessage({ type: "RESUME_PANEL_FIELD", mode: "fill", chipId: "b", value: "B" });
  assert.equal(filled.ok, false);
  assert.equal(filled.needsChoice, true);
  assert.equal(input.value, "A");
  assert.deepEqual(ctx.clipboardWrites, []);
});

test("the target state has only booleans and chip ids, and nothing is stored", async () => {
  const ctx = loadHighlightHelpers({ storageSpy: true });
  const secretText = "SECRET-PAGE-TEXT-9271";
  const input = textInput(ctx, `${secretText}A`);
  ctx.helpers.setLastFocusedField(input);
  const state = await queryTarget(ctx);
  const text = JSON.stringify(state);
  assert.ok(!text.includes(secretText), "the page's own text is never returned");
  assert.deepEqual(Object.keys(state).sort(), ["actions", "composable", "empty", "ok", "selectedChipIds", "targetAvailable"]);
  for (const actions of Object.values(state.actions)) {
    assert.deepEqual(Object.keys(actions).sort(), ["add", "remove", "replace"]);
    assert.ok(Object.values(actions).every((value) => typeof value === "boolean"));
  }
  const acted = await composeAction(ctx, "add", "b");
  assert.ok(!JSON.stringify(acted).includes(secretText));
  assert.deepEqual(ctx.storageWrites, [], "the cursor and field identity live in page memory only");
});

test("the page tells an open panel that the target changed, without any data", async () => {
  const ctx = loadHighlightHelpers();
  ctx.helpers.bindFocusTracking();
  const input = textInput(ctx, "A");
  ctx.helpers.setLastFocusedField(input);
  ctx.fireDocumentEvent("input", { target: input });
  assert.equal(ctx.timers.length, 0, "a closed panel is not messaged");

  await queryTarget(ctx);
  ctx.fireDocumentEvent("input", { target: input });
  ctx.fireDocumentEvent("selectionchange", { target: input });
  assert.equal(ctx.timers.length, 1, "bursts of events collapse into one notice");
  ctx.timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.desktopMessages.filter((message) => message.type === "RESUME_TARGET_CHANGED"))), [{ type: "RESUME_TARGET_CHANGED" }]);
});

test("only this extension can drive the compose protocol with its own field list", async () => {
  const ctx = loadHighlightHelpers();
  const input = textInput(ctx, "A");
  ctx.helpers.setLastFocusedField(input);
  const foreign = await ctx.sendPanelMessage({ type: "RESUME_PANEL_FIELD", mode: "replace", chipId: "b", value: "B", chips: AB }, { id: "other-extension" });
  assert.equal(foreign, undefined);
  assert.equal(input.value, "A");
  const unknown = await ctx.sendPanelMessage({ type: "RESUME_PANEL_FIELD", mode: "explode", chipId: "b", value: "B" });
  assert.equal(unknown.ok, false);
});
