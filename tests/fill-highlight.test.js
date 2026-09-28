const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadHighlightHelpers } = require("./helpers/content-harness.js");

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

test("AI fill loop records only successfully filled text inputs, and each new fill starts a fresh session", async () => {
  const formElements = [];
  let matches = [{ fieldId: "field-0", value: "测试用户" }, { fieldId: "field-1", value: "13800138000" }];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements,
    confirm: () => true,
    sendMessage: async () => ({ success: true, matches })
  });
  const name = new HTMLInputElement();
  name.name = "fullName";
  const phone = new HTMLInputElement();
  phone.name = "phone";
  phone.type = "tel";
  const password = new HTMLInputElement();
  password.name = "pwd";
  password.type = "password";
  formElements.push(name, phone, password);
  helpers.setCurrentStore({
    templates: [{ id: "template-1", name: "默认模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }],
    activeTemplateId: "template-1",
    aiConfig: { apiUrl: "https://example.test", model: "test-model", apiKey: "test-key" }
  });

  await helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });
  assert.deepEqual([...helpers.fillSessionControls()], [name, phone]);

  matches = [{ fieldId: "field-0", value: "新的姓名" }];
  await helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });
  assert.deepEqual([...helpers.fillSessionControls()], [name]);
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

for (const accept of [false, true]) {
  test(`ordinary fill asks before overwriting edits made during AI wait; accept=${accept}`, async () => {
    const formElements = [];
    const confirmations = [];
    let finish;
    const { helpers, HTMLInputElement } = loadHighlightHelpers({
      formElements,
      confirm: text => { confirmations.push(text); return accept; },
      sendMessage: () => new Promise(resolve => { finish = resolve; })
    });
    for (const name of ['name', 'school']) {
      const input = new HTMLInputElement();
      input.name = name;
      formElements.push(input);
    }
    helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '姓名', value: '模板姓名' }] }] }], activeTemplateId: 'one' });
    const button = { disabled: false };
    const pending = helpers.handleAiFillClick({ currentTarget: button });
    await new Promise(resolve => setImmediate(resolve));
    formElements[1].value = '等待期间手动输入';
    finish({ success: true, matches: [{ fieldId: 'field-0', value: '模板姓名' }, { fieldId: 'field-1', value: '模板学校' }] });
    await pending;
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], /1 个已有内容/);
    assert.match(confirmations[0], /可能覆盖你手动修改/);
    assert.ok(!confirmations[0].includes('等待期间手动输入'));
    assert.deepEqual(formElements.map(el => el.value), accept ? ['模板姓名', '模板学校'] : ['', '等待期间手动输入']);
    assert.equal(button.disabled, false);
    if (!accept) assert.ok(formElements.every(el => el.dispatchedEvents.length === 0));
  });
}

test('ordinary empty-page fill does not ask for overwrite confirmation', async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements, confirm: () => { throw new Error('empty field must not ask'); },
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '新值' }] })
  });
  formElements.push(new HTMLInputElement());
  helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '姓名', value: '新值' }] }] }], activeTemplateId: 'one' });
  await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(formElements[0].value, '新值');
});

for (const changedValue of ['确认后又改了', '']) {
  test(`later fields changed after confirmation are protected, including clearing: ${JSON.stringify(changedValue)}`, async () => {
    const formElements = [];
    const { helpers, HTMLInputElement } = loadHighlightHelpers({
      formElements, confirm: () => true,
      sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '新姓名' }, { fieldId: 'field-1', value: '新学校' }] })
    });
    const first = new HTMLInputElement();
    const second = new HTMLInputElement();
    second.value = '确认过的旧值';
    first.dispatchEvent = () => { second.value = changedValue; return true; };
    formElements.push(first, second);
    helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '姓名', value: '新姓名' }] }] }], activeTemplateId: 'one' });
    await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
    assert.equal(first.value, '新姓名');
    assert.equal(second.value, changedValue);
    assert.equal(second.dispatchedEvents.length, 0);
  });
}

test('multi-select prompts even when its first selected value is empty', async () => {
  const formElements = [];
  let prompted = false;
  const ctx = loadHighlightHelpers({ formElements,
    confirm: () => { prompted = true; return false; },
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: 'B' }] })
  });
  const select = new ctx.HTMLSelectElement();
  Object.assign(select, { tagName: 'SELECT', multiple: true, value: '', options: [
    { value: '', text: '请选择', selected: true }, { value: 'A', text: 'A', selected: true }
  ] });
  formElements.push(select);
  ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '项', value: 'B' }] }] }], activeTemplateId: 'one' });
  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(prompted, true);
  assert.equal(select.dispatchedEvents.length, 0);
});

test('changing single-select selection with duplicate values stops subsequent writes', async () => {
  const formElements = [];
  const ctx = loadHighlightHelpers({ formElements, confirm: () => true, aiHelpers: { findSelectOptionIndex: () => 0 },
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '新姓名' }, { fieldId: 'field-1', value: 'A' }] })
  });
  const first = new ctx.HTMLInputElement();
  const select = new ctx.HTMLSelectElement();
  Object.assign(select, { tagName: 'SELECT', value: 'same', selectedIndex: 0, options: [
    { value: 'same', text: 'A' }, { value: 'same', text: 'B' }
  ] });
  first.dispatchEvent = () => { select.selectedIndex = 1; return true; };
  formElements.push(first, select);
  ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '姓名', value: '新姓名' }] }] }], activeTemplateId: 'one' });
  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(first.value, '新姓名');
  assert.equal(select.selectedIndex, 1);
  assert.equal(select.dispatchedEvents.length, 0);
});

test('a change during the date picker delay survives and stops later fields', async () => {
  const formElements = [];
  const ctx = loadHighlightHelpers({ formElements, confirm: () => true,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '2026-01-01' }, { fieldId: 'field-1', value: '新姓名' }] })
  });
  const picker = new ctx.HTMLInputElement();
  picker.value = '2025-01-01';
  const later = new ctx.HTMLInputElement();
  formElements.push(picker, later);
  const container = new ctx.HTMLElement();
  container.querySelectorAll = () => [picker];
  const query = ctx.document.querySelectorAll;
  ctx.document.querySelectorAll = selector => selector === '.ant-picker' ? [container] : query(selector);
  ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '日期', value: '2026-01-01' }] }] }], activeTemplateId: 'one' });
  const pending = ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  await new Promise(resolve => setImmediate(resolve));
  const timer = ctx.timers.find(timer => timer.delay === 150 && !timer.cleared);
  assert.ok(timer, 'picker is waiting before writing');
  picker.value = '2027-02-02';
  const eventsBefore = picker.dispatchedEvents.length;
  timer.callback();
  await pending;
  assert.equal(picker.value, '2027-02-02');
  assert.equal(picker.dispatchedEvents.length, eventsBefore);
  assert.equal(later.value, '');
});

test('a text value changed by focus is rechecked before the delayed write', async () => {
  const formElements = [];
  const ctx = loadHighlightHelpers({ formElements, confirm: () => true,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '模板值' }] })
  });
  const input = new ctx.HTMLInputElement();
  input.value = '旧值';
  input.focus = () => { ctx.document.activeElement = input; input.value = '聚焦后新值'; };
  formElements.push(input);
  ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '姓名', value: '模板值' }] }] }], activeTemplateId: 'one' });
  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(input.value, '聚焦后新值');
  assert.equal(input.dispatchedEvents.length, 0);
});

test('an initially empty select can load a placeholder and complete its option retry', async () => {
  const formElements = [];
  const ctx = loadHighlightHelpers({ formElements, aiHelpers: require('../ai-helpers.js'),
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: 'A' }] })
  });
  const select = new ctx.HTMLSelectElement();
  Object.assign(select, { tagName: 'SELECT', value: '', selectedIndex: -1, options: [] });
  formElements.push(select);
  ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '选项', value: 'A' }] }] }], activeTemplateId: 'one' });
  const pending = ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  setTimeout(() => {
    select.options = [{ value: '', text: '请选择' }, { value: 'A', text: 'A' }];
    select.selectedIndex = 0;
  }, 20);
  await pending;
  assert.equal(select.value, 'A');
  assert.equal(select.selectedIndex, 1);
});

for (const mode of ['retry', 'rollback', 'user-edit']) {
  test(`text retry distinguishes framework rejection from user input: ${mode}`, async () => {
    const formElements = [];
    const ctx = loadHighlightHelpers({ formElements, confirm: () => true,
      sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '13800000000' }] })
    });
    const input = new ctx.HTMLInputElement();
    input.type = 'tel';
    input.value = '13900000000';
    let rejected = false;
    const dispatch = input.dispatchEvent.bind(input);
    input.dispatchEvent = event => {
      if (input.value === '13800000000' && (!rejected || mode === 'rollback')) {
        rejected = true;
        input.value = mode === 'user-edit' ? '13700000000' : '';
        if (mode === 'user-edit') dispatch({ type: 'input', isTrusted: true });
      }
      return dispatch(event);
    };
    formElements.push(input);
    ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '电话', value: '13800000000' }] }] }], activeTemplateId: 'one' });
    await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
    assert.equal(input.value, mode === 'retry' ? '13800000000' : mode === 'rollback' ? '13900000000' : '13700000000');
    assert.ok(Object.values(input.listeners).every(listeners => listeners.size === 0), 'temporary listeners are removed');
  });
}

test('multi-select with only an empty placeholder does not ask for overwrite', async () => {
  const formElements = [];
  const ctx = loadHighlightHelpers({ formElements, aiHelpers: require('../ai-helpers.js'),
    confirm: () => { throw new Error('placeholder is not a real selection'); },
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: 'A' }] })
  });
  const select = new ctx.HTMLSelectElement();
  Object.assign(select, { tagName: 'SELECT', multiple: true, value: '', selectedIndex: 0, options: [
    { value: '', text: '请选择', selected: true }, { value: 'A', text: 'A', selected: false }
  ] });
  formElements.push(select);
  ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '选项', value: 'A' }] }] }], activeTemplateId: 'one' });
  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(select.value, 'A');
  assert.equal(select.selectedIndex, 1);
});

for (const disconnected of [false, true]) {
  test(`radio groups require confirmation for non-first selection and stop on detached options: detached=${disconnected}`, async () => {
    const formElements = [];
    let finish;
    let confirmations = 0;
    const ctx = loadHighlightHelpers({ formElements,
      aiHelpers: { findSelectOptionIndex: () => 1 },
      confirm: () => { confirmations += 1; return false; },
      sendMessage: () => new Promise(resolve => { finish = resolve; })
    });
    const first = new ctx.HTMLInputElement();
    const second = new ctx.HTMLInputElement();
    Object.assign(first, { type: 'radio', name: 'group', value: 'A', checked: false });
    Object.assign(second, { type: 'radio', name: 'group', value: 'B', checked: !disconnected, click() {} });
    formElements.push(first, second);
    ctx.helpers.setCurrentStore({ templates: [{ id: 'one', groups: [{ name: '基本', fields: [{ key: '选项', value: 'B' }] }] }], activeTemplateId: 'one' });
    const pending = ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
    await new Promise(resolve => setImmediate(resolve));
    if (disconnected) first.isConnected = false;
    finish({ success: true, matches: [{ fieldId: 'field-radio-0', value: 'B' }] });
    await pending;
    assert.equal(confirmations, disconnected ? 0 : 1);
    assert.equal(second.checked, !disconnected);
    assert.equal(second.dispatchedEvents.length, 0);
  });
}
