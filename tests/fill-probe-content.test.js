// #206：content.js 接入页面探测后的行为。探测模块本身见 fill-probe.test.js。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers } = require("./helpers/content-harness.js");
const realProbe = require("../fill-probe.js");

const STORE = { templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }], activeTemplateId: "one" };
const LIEPIN_VIEW = { host: "c.liepin.com", frames: { total: 0, crossOrigin: 0, frameInputs: 0 },
  custom: { total: 0, byLibrary: {} }, editButtons: 3, locked: 0, shadowHosts: 0 };
const EDIT_HINT = "这个页面可能还在查看状态：请先点网页上的「编辑」，等输入框出现后再一键填写。";
const NO_CONTEXT = "简历里没有能对应这些网页字段的资料，已跳过 AI 填写。";
const EMPTY_PAGE = "当前页面没有可填写的表单字段。";
const boom = () => { throw new Error("boom"); };
const THROWING = { ...realProbe, probePage: boom, describeControl: boom, formatReport: boom, emptyPageHint: boom };
const VIEW_PROBE = { ...realProbe, probePage: () => LIEPIN_VIEW };
// 页面不接受写入：值始终是空的。
const refuseWrites = input => Object.defineProperty(input, "value", { get: () => "", set: () => {}, configurable: true });
// 侧栏里的诊断框和一键填写按钮。
function diagnosticsShadow() {
  const text = { value: "" };
  const fill = { disabled: false };
  return { text, fill, shadow: {
    querySelectorAll: () => [],
    querySelector: selector => ({
      "#resume-pro-diagnostics": { hidden: true, open: false },
      "#resume-pro-diagnostics-text": text,
      "#resume-pro-ai-fill": fill
    })[selector] || null
  } };
}
const EDUCATION_STORE = { templates: [{ id: "one", groups: [{ name: "教育", fields: [{ key: "学历", value: "本科" }] }] }], activeTemplateId: "one" };
// 没消失的 2.4 秒状态定时器：提示要常驻时，这个数应当是 0。
const fadingTimers = timers => timers.filter(timer => timer.delay === 2400 && !timer.cleared).length;

test("an empty page with an edit button tells the user to click 编辑 first and sends nothing to AI", async () => {
  const sent = [];
  const { helpers } = loadHighlightHelpers({
    formElements: [],
    fillProbe: { ...realProbe, probePage: () => LIEPIN_VIEW },
    sendMessage: async message => { sent.push(message); return { success: true, matches: [] }; }
  });
  helpers.setCurrentStore(STORE);
  const result = await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(result.error, `当前页面没有可填写的表单字段。${EDIT_HINT}`);
  assert.equal(sent.filter(message => message.type === "AI_FILL").length, 0);
});

test("a probe that throws never blocks filling", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements,
    fillProbe: THROWING,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "测试用户" }] })
  });
  const input = new HTMLInputElement();
  formElements.push(input);
  helpers.setCurrentStore(STORE);
  const result = await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(input.value, "测试用户");
  assert.equal(result.filledCount, 1);
});

test("a probe that throws at every call site still ends the run, keeps the base diagnostics and frees the button", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements, fillProbe: THROWING,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "本科" }] })
  });
  const input = new HTMLInputElement();
  input.name = "degree";
  refuseWrites(input);
  formElements.push(input);
  const { text, fill, shadow } = diagnosticsShadow();
  helpers.setShadowRoot(shadow);
  helpers.setCurrentStore(EDUCATION_STORE);
  const first = await helpers.handleAiFillClick({ currentTarget: fill });
  assert.equal(first.filledCount, 0);
  assert.notEqual(first.error, "busy");
  // 探测行没了，原来的诊断照常写出。
  assert.match(text.value, /^网申快填 v/);
  assert.match(text.value, /网页字段：1；成功填写：0；没填上：1/);
  assert.ok(!text.value.includes("页面："));
  // finally 里放掉了忙碌状态：再点一次不会被当成还在填写。
  assert.equal(fill.disabled, false);
  const second = await helpers.handleAiFillClick({ currentTarget: fill });
  assert.notEqual(second.error, "busy");
  assert.equal(second.outcome, "partial");
});

test("a hint that throws is dropped, not raised, and the button is freed", async () => {
  // 空页面：提示那一步出错，仍是原来那句。
  for (const fillProbe of [THROWING, { ...VIEW_PROBE, emptyPageHint: boom }]) {
    const empty = await runOnViewPage({ success: true, matches: [] }, { fillProbe, fields: 0 });
    assert.equal(empty.result.error, EMPTY_PAGE);
    assert.notEqual((await empty.again()).error, "busy");
  }
  // 查看状态页、扫描到字段但一个都没填上：提示出错时退回普通的「已填写 0 个字段。」。
  const view = await runOnViewPage({ success: true, matches: [] }, { fillProbe: { ...VIEW_PROBE, emptyPageHint: boom } });
  assert.equal(view.status.textContent, "已填写 0 个字段。");
  assert.notEqual((await view.again()).error, "busy");
  const failed = await runOnViewPage({ success: false, error: NO_CONTEXT, matches: [], diagnostics: { errorCode: "no_context" } },
    { fillProbe: { ...VIEW_PROBE, emptyPageHint: boom } });
  assert.equal(failed.result.error, NO_CONTEXT);
  assert.notEqual((await failed.again()).error, "busy");
});

test("diagnostics list the host and the structure of a field the page refused, never its value or path", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements, fillProbe: realProbe,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "本科" }] })
  });
  const input = new HTMLInputElement();
  input.name = "degree";
  refuseWrites(input);
  formElements.push(input);
  const { text, fill, shadow } = diagnosticsShadow();
  helpers.setShadowRoot(shadow);
  helpers.setCurrentStore(EDUCATION_STORE);
  await helpers.handleAiFillClick({ currentTarget: fill });
  assert.match(text.value, /页面：jobs\.example\.test/);
  assert.match(text.value, /没填上的字段（控件结构）：\n- degree：input\[text\]/);
  assert.ok(!text.value.includes("本科"));
  assert.ok(!text.value.includes("/apply"));
});

// 猎聘这类查看状态的页面：页头搜索框之类会被扫描到，但一个都没填上。
async function runOnViewPage(response, { fillProbe = VIEW_PROBE, fields = 1, refuse = false, assisted = null } = {}) {
  const formElements = [];
  const status = { textContent: "", className: "" };
  const { helpers, HTMLInputElement, timers } = loadHighlightHelpers({ formElements, fillProbe, sendMessage: async () => response });
  const inputs = Array.from({ length: fields }, () => {
    const input = new HTMLInputElement();
    input.name = "keyword";
    if (refuse) refuseWrites(input);
    formElements.push(input);
    return input;
  });
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: selector => (selector === "#resume-pro-status" ? status : null) });
  helpers.setCurrentStore(STORE);
  const button = { disabled: false };
  const again = () => helpers.handleAiFillClick({ currentTarget: button }, assisted);
  const result = await again();
  return { result, status, input: inputs[0], timers, again };
}

test("a view page with one irrelevant field and no AI matches still tells the user to click 编辑", async () => {
  const { result, status } = await runOnViewPage({ success: true, matches: [], diagnostics: { errorCode: "none" } });
  assert.equal(status.textContent, `已填写 0 个字段。${EDIT_HINT}`);
  assert.match(status.className, /is-error/);
  assert.equal(result.filledCount, 0);
});

test("the edit hint follows the no_context warning, and only that or a no-match failure", async () => {
  const noContext = await runOnViewPage({ success: false, error: NO_CONTEXT, matches: [], diagnostics: { errorCode: "no_context" } });
  assert.equal(noContext.result.error, `${NO_CONTEXT}${EDIT_HINT}`);
  const noMatch = await runOnViewPage({ success: false, error: "AI 没有匹配到字段。", matches: [], diagnostics: { errorCode: "none" } });
  assert.equal(noMatch.result.error, `AI 没有匹配到字段。${EDIT_HINT}`);
  const auth = await runOnViewPage({ success: false, error: "接口认证失败", matches: [], diagnostics: { errorCode: "auth" } });
  assert.equal(auth.result.error, "接口认证失败");
});

test("the edit hint is left out when the page has no edit button or something was filled", async () => {
  const plain = await runOnViewPage({ success: true, matches: [] }, { fillProbe: { ...realProbe, probePage: () => ({ ...LIEPIN_VIEW, editButtons: 0 }) } });
  assert.equal(plain.status.textContent, "已填写 0 个字段。");
  const filled = await runOnViewPage({ success: true, matches: [{ fieldId: "field-0", value: "测试用户" }] });
  assert.equal(filled.input.value, "测试用户");
  assert.equal(filled.status.textContent, "已填写 1 个字段。");
  const noProbe = await runOnViewPage({ success: true, matches: [] }, { fillProbe: null });
  assert.equal(noProbe.status.textContent, "已填写 0 个字段。");
});

test("a status that carries a hint stays on screen, while other failures still fade after 2.4 seconds", async () => {
  const viewEmpty = await runOnViewPage({ success: true, matches: [] }, { fields: 0 });
  assert.equal(viewEmpty.result.error, `${EMPTY_PAGE}${EDIT_HINT}`);
  assert.equal(fadingTimers(viewEmpty.timers), 0);
  const noContext = await runOnViewPage({ success: false, error: NO_CONTEXT, matches: [], diagnostics: { errorCode: "no_context" } });
  assert.equal(noContext.result.error, `${NO_CONTEXT}${EDIT_HINT}`);
  assert.equal(fadingTimers(noContext.timers), 0);
  // 没有提示的失败照旧几秒后消失。
  const auth = await runOnViewPage({ success: false, error: "接口认证失败", matches: [], diagnostics: { errorCode: "auth" } });
  assert.equal(fadingTimers(auth.timers), 1);
  const plainEmpty = await runOnViewPage({ success: true, matches: [] }, { fields: 0, fillProbe: { ...VIEW_PROBE, probePage: () => ({ ...LIEPIN_VIEW, editButtons: 0 }) } });
  assert.equal(plainEmpty.result.error, EMPTY_PAGE);
  assert.equal(fadingTimers(plainEmpty.timers), 1);
});

test("scanned but none filled on a view page also stays on screen", async () => {
  const view = await runOnViewPage({ success: true, matches: [] });
  assert.equal(fadingTimers(view.timers), 0);
  // 页面没有「编辑」按钮时是普通的「已填写 0 个字段。」，照旧几秒后消失。
  const plain = await runOnViewPage({ success: true, matches: [] }, { fillProbe: { ...VIEW_PROBE, probePage: () => ({ ...LIEPIN_VIEW, editButtons: 0 }) } });
  assert.equal(fadingTimers(plain.timers), 1);
});

test("a view page where the one matched field refuses its value keeps the unfilled note and the AI warning before the hint", async () => {
  const { status, result } = await runOnViewPage({ success: true, warning: "某警告。", matches: [{ fieldId: "field-0", value: "测试用户" }] }, { refuse: true });
  assert.equal(status.textContent,
    "已填写 0 个字段。1 项没填上：keyword（值没有写上），请手动补上。某警告。这个页面可能还在查看状态：请先点网页上的「编辑」，等输入框出现后再一键填写。");
  assert.match(status.className, /is-error/);
  assert.equal(result.filledCount, 0);
  assert.equal(result.outcome, "partial");
});

test("an assisted run never shows the click-编辑 hint, however it ends", async () => {
  const assisted = () => ({ scopes: [{ isConnected: true, contains: () => true }] });
  const empty = await runOnViewPage({ success: true, matches: [] }, { assisted: assisted() });
  assert.equal(empty.status.textContent, "辅助填写：已验证 0 项。");
  const failed = await runOnViewPage({ success: false, error: NO_CONTEXT, matches: [], diagnostics: { errorCode: "no_context" } }, { assisted: assisted() });
  assert.equal(failed.result.error, NO_CONTEXT);
  // 页面上一个字段都没有：辅助新增也只报原来那句。
  const noFields = await runOnViewPage({ success: true, matches: [] }, { assisted: assisted(), fields: 0 });
  assert.equal(noFields.result.error, EMPTY_PAGE);
});

// 兜底规则从旁边取来的页面文字，可能恰好就是这个控件当前选中的值：大小写、空白、全角写法不同也要认出来。
for (const [label, value, hidden] of [
  ["本科", "本科", true], ["Java", "java", true], ["本 科", "本科", true], ["男", "男", true],
  ["男\u3000", "男", true], ["男\u00A0", "男", true], ["ＪＡＶＡ", "Java", true], ["学历：本科", "本科", true],
  ["性别", "男", false], ["最高学历", "本科", false]
]) {
  test(`the field name ${JSON.stringify(label)} against the value ${JSON.stringify(value)} is ${hidden ? "hidden" : "kept"} in the diagnostics`, async () => {
    const formElements = [];
    const { helpers, HTMLInputElement } = loadHighlightHelpers({
      formElements, fillProbe: realProbe,
      sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value }] })
    });
    const input = new HTMLInputElement();
    input.attributes["data-label"] = label;
    refuseWrites(input);
    formElements.push(input);
    const { text, fill, shadow } = diagnosticsShadow();
    helpers.setShadowRoot(shadow);
    helpers.setCurrentStore(EDUCATION_STORE);
    await helpers.handleAiFillClick({ currentTarget: fill });
    if (hidden) {
      assert.ok(text.value.includes("- （字段名已隐藏）：input[text]"), text.value);
      assert.ok(!text.value.includes(label.trim()) && !text.value.includes(value), text.value);
    } else {
      assert.ok(text.value.includes(`- ${label}：input[text]`), text.value);
    }
  });
}
