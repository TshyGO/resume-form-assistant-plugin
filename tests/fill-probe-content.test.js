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
  const boom = () => { throw new Error("boom"); };
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements,
    fillProbe: { ...realProbe, probePage: boom, describeControl: boom, formatReport: boom },
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "测试用户" }] })
  });
  const input = new HTMLInputElement();
  formElements.push(input);
  helpers.setCurrentStore(STORE);
  const result = await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  assert.equal(input.value, "测试用户");
  assert.equal(result.filledCount, 1);
});

test("diagnostics list the host and the structure of a field the page refused, never its value or path", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements, fillProbe: realProbe,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "本科" }] })
  });
  const input = new HTMLInputElement();
  input.name = "degree";
  // 页面不接受写入：值始终是空的。
  Object.defineProperty(input, "value", { get: () => "", set: () => {}, configurable: true });
  formElements.push(input);
  const text = { value: "" };
  const fill = { disabled: false };
  helpers.setShadowRoot({
    querySelectorAll: () => [],
    querySelector: selector => ({
      "#resume-pro-diagnostics": { hidden: true, open: false },
      "#resume-pro-diagnostics-text": text,
      "#resume-pro-ai-fill": fill
    })[selector] || null
  });
  helpers.setCurrentStore({ templates: [{ id: "one", groups: [{ name: "教育", fields: [{ key: "学历", value: "本科" }] }] }], activeTemplateId: "one" });
  await helpers.handleAiFillClick({ currentTarget: fill });
  assert.match(text.value, /页面：jobs\.example\.test/);
  assert.match(text.value, /没填上的字段（控件结构）：\n- degree：input\[text\]/);
  assert.ok(!text.value.includes("本科"));
  assert.ok(!text.value.includes("/apply"));
});

// 猎聘这类查看状态的页面：页头搜索框之类会被扫描到，但一个都没填上。
async function runOnViewPage(response, { fillProbe = { ...realProbe, probePage: () => LIEPIN_VIEW } } = {}) {
  const formElements = [];
  const status = { textContent: "", className: "" };
  const { helpers, HTMLInputElement } = loadHighlightHelpers({ formElements, fillProbe, sendMessage: async () => response });
  const input = new HTMLInputElement();
  input.name = "keyword";
  formElements.push(input);
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: selector => (selector === "#resume-pro-status" ? status : null) });
  helpers.setCurrentStore(STORE);
  const result = await helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  return { result, status, input };
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

test("a field name that overlaps the value being filled is hidden in the diagnostics", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements, fillProbe: realProbe,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "本科" }] })
  });
  const input = new HTMLInputElement();
  // 兜底规则从旁边取来的页面文字，恰好是这个控件当前选中的值。
  input.attributes["data-label"] = "本科";
  Object.defineProperty(input, "value", { get: () => "", set: () => {}, configurable: true });
  formElements.push(input);
  const text = { value: "" };
  const fill = { disabled: false };
  helpers.setShadowRoot({
    querySelectorAll: () => [],
    querySelector: selector => ({
      "#resume-pro-diagnostics": { hidden: true, open: false },
      "#resume-pro-diagnostics-text": text,
      "#resume-pro-ai-fill": fill
    })[selector] || null
  });
  helpers.setCurrentStore({ templates: [{ id: "one", groups: [{ name: "教育", fields: [{ key: "学历", value: "本科" }] }] }], activeTemplateId: "one" });
  await helpers.handleAiFillClick({ currentTarget: fill });
  assert.ok(text.value.includes("- （字段名已隐藏）：input[text]"), text.value);
  assert.ok(!text.value.includes("本科"), text.value);
});
