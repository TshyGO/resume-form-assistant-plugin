// #301 填完前复核「页面仍提示无效」的字段：content.js 怎么用控件层的结果。页面的提示后来消了的算填上，
// 别的原因没填上的照旧，不再去看。控件层用替身；真实控件和北森页面上的整条流程见 beisen-form.test.js。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness");

// 开始时间、结束时间两道题。start 是开始时间这一项的填写结果；结束时间填上后，页面清掉开始时间上的提示。
// dates：两道题都是日期控件（北森的开始 / 结束时间）。startAtEnd：结束前复核开始时间时读到的结果。
async function fillPair({ start, dates = false, startAtEnd = { ok: true, reason: "" } }) {
  const formElements = [], checked = [];
  let ended = false;
  const label = (target) => target.element.getAttribute("data-label");
  const controls = { create: () => ({
    operate: async (target, value) => {
      target.element.value = value;
      if (label(target) !== "结束时间") return start;
      ended = true;
      return { ok: true, reason: "", observed: {} };
    },
    check: (target) => {
      checked.push(label(target));
      if (!ended) return { ok: false, reason: "validation_not_cleared" };
      return label(target) === "开始时间" ? startAtEnd : { ok: true, reason: "" };
    }
  }) };
  const fieldScan = fakeFieldScan();
  const scanPage = fieldScan.scanPage;
  if (dates) fieldScan.scanPage = (doc, options) => {
    const scan = scanPage(doc, options);
    scan.controls.forEach((control) => Object.assign(control, { controlKind: "date-picker", pickerType: "element" }));
    return scan;
  };
  const values = { 开始时间: "2019-09", 结束时间: "2022-06" };
  const env = loadHighlightHelpers({ formElements, fieldScan, controls,
    sendMessage: async (message) => message.type !== "AI_FILL" ? {} : { success: true,
      matches: message.formFields.map((field) => ({ fieldId: field.fieldId, value: values[field.label] })) } });
  for (const name of Object.keys(values)) {
    const input = new env.HTMLInputElement();
    input.setAttribute("data-label", name);
    formElements.push(input);
  }
  const status = { textContent: "", className: "" };
  env.helpers.setShadowRoot({ querySelector: (selector) => selector === "#resume-pro-status" ? status : null, querySelectorAll: () => [] });
  env.helpers.setCurrentStore({ templates: [{ id: "one", groups: [{ name: "教育经历",
    fields: Object.entries(values).map(([key, value]) => ({ key, value })) }] }], activeTemplateId: "one" });
  const result = await env.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  return { result, status: status.textContent, checked };
}

test("a date marked invalid until the next field is filled counts as filled, with its day-defaulted note", async () => {
  const { result, status, checked } = await fillPair({ dates: true,
    start: { ok: false, reason: "validation_not_cleared", observed: { dayDefaulted: true } } });
  assert.equal(result.filledCount, 2, status);
  assert.equal(result.unfilledCount, 0);
  assert.equal(result.outcome, "success");
  assert.equal(status, "已填写 2 个字段（1 项日期资料里只有年月，已按 1 日填写）。");
  assert.ok(checked.includes("开始时间"), JSON.stringify(checked));
});

test("a field that failed for another reason is not looked at again, even if it reads well at the end", async () => {
  const { result, status, checked } = await fillPair({ start: { ok: false, reason: "value_not_committed", observed: {} } });
  assert.equal(result.filledCount, 1);
  assert.equal(result.unfilledCount, 1);
  assert.equal(status, "已填写 1 个字段。1 项没填上：开始时间（值没有写上），请手动补上。");
  assert.deepEqual(checked, ["结束时间"]);
});

test("a field still marked invalid at the end keeps that reason", async () => {
  const { result, status } = await fillPair({ start: { ok: false, reason: "validation_not_cleared", observed: {} },
    startAtEnd: { ok: false, reason: "validation_not_cleared" } });
  assert.equal(result.filledCount, 1);
  assert.equal(status, "已填写 1 个字段。1 项没填上：开始时间（页面仍提示无效），请手动补上。");
});

test("a field the page took back before the end is recorded with what the recheck read", async () => {
  const { result, status } = await fillPair({ start: { ok: false, reason: "validation_not_cleared", observed: {} },
    startAtEnd: { ok: false, reason: "value_reverted" } });
  assert.equal(result.filledCount, 1);
  assert.equal(result.unfilledCount, 1);
  assert.equal(status, "已填写 1 个字段。1 项没填上：开始时间（值被页面退回），请手动补上。");
});
