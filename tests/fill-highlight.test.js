const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHighlightHelpers(options = {}) {
  const timers = [];
  const clearedTimers = [];

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
    addEventListener() {},
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
    HTMLTextAreaElement: class HTMLTextAreaElement extends HTMLElement {},
    HTMLSelectElement: class HTMLSelectElement extends HTMLElement {},
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.2.1" }),
        onMessage: { addListener() {} },
        sendMessage: options.sendMessage || (async () => ({ success: true, matches: [] }))
      }
    },
    crypto: { randomUUID: () => "test-id" },
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    self: { __RESUME_PRO_TEST__: true, ResumeProFormAgent: options.formAgent,
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

  return {
    helpers: context.self.ResumeProHighlightTest,
    window,
    timers,
    clearedTimers,
    styleElements,
    HTMLElement,
    HTMLInputElement,
    HTMLLabelElement
  };
}

test("injects highlight styles into the page document", () => {
  const { helpers, styleElements } = loadHighlightHelpers();

  helpers.injectFieldHighlightStyles();

  assert.equal(styleElements.length, 1);
  assert.equal(styleElements[0].id, "resume-pro-field-highlight-styles");
  assert.match(styleElements[0].textContent, /\.resume-pro__field-highlight/);
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

test("diagnostic summary only exposes allowlisted counts, durations and errors", () => {
  const { helpers } = loadHighlightHelpers();
  const summary = helpers.formatFillDiagnostics({
    scanMs: 100, roundTripMs: 1000, fillMs: null, totalMs: 1100,
    fieldCount: 2, filledCount: 0, outcome: "failed",
    diagnostics: { errorCode: "secret-key", apiKey: "secret-key", apiMs: 900, ruleMatches: 1, resumeFields: "private-name" }
  });
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
  assert.equal(input.dispatchedEvents.length, 2);
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
