// #408 扫描出错不再拖垮整页：飞书招聘这类 antd 表单把字段名写进 id，表单里有个字段叫 id 时，
// 浏览器里 form.id 就是那个输入框（表单的具名属性盖过内置属性），扫描读它当字符串就抛错，一键填写 6 毫秒就失败。
// 夹具都是合成的，只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const core = require("../feedback-core.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const ORIGIN = "chrome-extension://test-extension/";

// antd 表单（不给 Form 起名字时，输入框的 id 就是字段名）。
function item(name, label) {
  return `<div class="ant-form-item"><div class="ant-row ant-form-item-row">
    <div class="ant-col ant-form-item-label"><label for="${name}" class="ant-form-item-required" title="${label}">${label}</label></div>
    <div class="ant-col ant-form-item-control"><div class="ant-form-item-control-input"><div class="ant-form-item-control-input-content">
      <input id="${name}" class="ant-input" type="text" value="">
    </div></div></div>
  </div></div>`;
}
const FIELDS = [["name", "姓名"], ["id", "证件号码"], ["email", "邮箱"], ["school", "毕业院校"]];
const FORM = `<form id="apply" class="ant-form ant-form-vertical">${FIELDS.map(([name, label]) => item(name, label)).join("")}</form>`;

// jsdom 没有表单的具名属性。照浏览器（[LegacyOverrideBuiltIns]）把表单里控件的 id、name 盖到表单的同名内置属性上：
// <input id="id"> 让 form.id 变成这个输入框，<input id="name"> 让 form.name 变成它。
function shadowFormProperties(doc) {
  for (const form of doc.querySelectorAll("form")) {
    for (const el of Array.from(form.elements)) {
      for (const key of [el.getAttribute("id"), el.getAttribute("name")]) {
        if (key && key in form) Object.defineProperty(form, key, { configurable: true, get: () => el });
      }
    }
  }
}

// 让一个元素在读某个属性时抛错，模拟网页改过的 DOM。
function throwOn(el, property) {
  const win = el.ownerDocument.defaultView;
  Object.defineProperty(el, property, { configurable: true, get() { throw new win.TypeError("boom from the page"); } });
}

const isVisible = (el) => !el.closest("[hidden]");
const labels = (result) => result.controls.map((control) => control.label);

function antdDoc(extra = "") {
  const doc = new JSDOM(`<!doctype html><html><body><main>${FORM}${extra}</main></body></html>`).window.document;
  shadowFormProperties(doc);
  return doc;
}

test("an antd form with a field named id is scanned: the form's id is read as an attribute", () => {
  const doc = antdDoc();
  const form = doc.getElementById("apply");
  assert.equal(form.id, doc.querySelector("input#id"), "the fixture shadows form.id the way a browser does");
  const result = scanner.scanPage(doc, { isVisible });
  assert.deepEqual(labels(result), ["姓名", "证件号码", "邮箱", "毕业院校"]);
  assert.equal(result.skipped.scanError, 0);
  // 深度分析的页面大纲用同一套判断。
  assert.deepEqual(scanner.outlineControls(doc, { isVisible }).map((control) => control.label), ["姓名", "证件号码", "邮箱", "毕业院校"]);
});

test("a site header whose id names it is still page chrome, read through the attribute", () => {
  const doc = new JSDOM(`<!doctype html><html><body><div id="navbar"><input placeholder="搜索职位"></div>${FORM}</body></html>`).window.document;
  shadowFormProperties(doc);
  const result = scanner.scanPage(doc, { isVisible });
  assert.deepEqual(labels(result), ["姓名", "证件号码", "邮箱", "毕业院校"]);
  assert.equal(result.skipped.pageChrome, 1);
});

test("a control whose title cannot be read is skipped and counted; the rest of the page is scanned", () => {
  const doc = antdDoc();
  throwOn(doc.querySelector("input#email"), "labels");
  const result = scanner.scanPage(doc, { isVisible });
  assert.deepEqual(labels(result), ["姓名", "证件号码", "毕业院校"]);
  assert.equal(result.skipped.scanError, 1);
  assert.deepEqual(scanner.outlineControls(doc, { isVisible }).map((control) => control.label), ["姓名", "证件号码", "毕业院校"]);
});

test("a control whose section cannot be read is skipped and counted", () => {
  // 单独一张表单放在最后，它就是「备注」所在的表单项：只有「备注」找区块时会读到这个属性。
  const doc = antdDoc(`<form id="extra" class="ant-form">${item("note", "备注")}</form>`);
  throwOn(doc.getElementById("extra"), "previousElementSibling");
  const result = scanner.scanPage(doc, { isVisible });
  assert.deepEqual(labels(result), ["姓名", "证件号码", "邮箱", "毕业院校"]);
  assert.equal(result.skipped.scanError, 1);
  assert.deepEqual(scanner.outlineControls(doc, { isVisible }).map((control) => control.label), ["姓名", "证件号码", "邮箱", "毕业院校"]);
});

test("the report counts skipped controls as scan_error and carries the scan_exception code, both in the closed vocabulary", () => {
  const counted = core.fillReport({ fieldCount: 3, stats: { domInputs: 4, visible: 4, scanError: 1 } });
  assert.match(counted, /^drop_reasons: scan_error=1$/m);
  assert.equal(core.diagnostics(counted), counted);
  const crashed = core.fillReport({ fieldCount: 0, diagnostics: { errorCode: "scan_exception" }, category: "unknown", stage: "scan" });
  assert.match(crashed, /^error_code: scan_exception$/m);
  assert.match(crashed, /^ai_called: false$/m);
  assert.equal(core.diagnostics(crashed), crashed);
  assert.equal(core.fillFailure({ fieldCount: 0, filledCount: 0, unfilledCount: 0, unconfirmedCount: 0, category: "unknown",
    errorCode: "scan_exception" }), "fill_failed");
});

// --- 整条一键填写：按 manifest 的顺序加载全部 content script（带文件名，出错位置才认得出是本扩展的） ---

// jsdom 不排版：没藏起来的元素一律给一个框。
function layout(w) {
  const box = { top: 10, left: 10, width: 300, height: 30, right: 310, bottom: 40, x: 10, y: 10, toJSON() { return this; } };
  const empty = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return this; } };
  const shown = (el) => !el.closest("[hidden]");
  w.Element.prototype.getBoundingClientRect = function () { return shown(this) ? box : empty; };
  w.Element.prototype.getClientRects = function () { return shown(this) ? [box] : []; };
  w.Element.prototype.scrollIntoView = function () {};
}

// answers：{ 题目: 值 }，模板和 AI 替身都按它来。setup 在加载脚本前改页面。
function page(t, { body = `<main>${FORM}</main>`, answers, setup }) {
  const dom = new JSDOM(`<!doctype html><html><head><title>投递简历</title></head><body>${body}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://demo.jobs.example.test/campus/position/apply" });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  shadowFormProperties(w.document);
  setup?.(w.document);
  // 不自动插入侧栏：只测填写流程。
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  w.confirm = () => true;
  const template = { id: "t", name: "虚构模板", groups: [{ name: "基本信息", fields: Object.entries(answers).map(([key, value]) => ({ key, value })) }] };
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: Object.keys(answers).length }], activeTemplate: template,
    profile: { values: {}, family: [], custom: [] }, profileRevision: 0 };
  const requests = [];
  const reports = [];
  const fill = (message) => {
    requests.push(Array.from(message.formFields, (field) => field.label));
    const matches = message.formFields.filter((field) => answers[field.label] !== undefined)
      .map((field) => ({ fieldId: field.fieldId, value: answers[field.label] }));
    return { success: true, matches, diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: matches.length, errorCode: "none" } };
  };
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => ORIGIN + file, getManifest: () => ({ version: "0.4.4" }),
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === "FEEDBACK_AUTO") { reports.push(message.report); return null; }
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        return message.type === "AI_FILL" ? fill(message) : {};
      } },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} } }
  };
  const context = dom.getInternalVMContext();
  for (const file of SCRIPTS) new vm.Script(fs.readFileSync(path.join(ROOT, file), "utf8"), { filename: ORIGIN + file }).runInContext(context);
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    fill: { disabled: false, textContent: "" } };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": { hidden: true, open: false },
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-ai-fill": ui.fill };
  const helpers = w.ResumeProHighlightTest;
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  return { w, doc: w.document, ui, requests, reports, helpers, run: () => helpers.handleAiFillClick({ currentTarget: ui.fill }) };
}

const ANSWERS = { 姓名: "测试用户", 证件号码: "A1234567", 邮箱: "user@example.test", 毕业院校: "示例大学" };
const value = (p, id) => p.doc.getElementById(id).value;

test("一键填写 on an antd form with a field named id scans every field and fills it", async (t) => {
  const p = page(t, { answers: ANSWERS });
  const result = await p.run();
  assert.deepEqual(p.requests, [["姓名", "证件号码", "邮箱", "毕业院校"]], p.ui.status.textContent);
  assert.deepEqual(["name", "id", "email", "school"].map((id) => value(p, id)), ["测试用户", "A1234567", "user@example.test", "示例大学"]);
  assert.equal(result.filledCount, 4, p.ui.diag.value);
  assert.equal(p.ui.status.textContent, "已填写 4 个字段。");
  assert.deepEqual(p.reports, []);
});

test("一键填写 skips only the control that cannot be read, fills the rest and counts it in the diagnostics", async (t) => {
  const p = page(t, { answers: ANSWERS, setup: (doc) => throwOn(doc.querySelector("input#email"), "labels") });
  const result = await p.run();
  assert.deepEqual(p.requests, [["姓名", "证件号码", "毕业院校"]], p.ui.status.textContent);
  assert.equal(result.filledCount, 3, p.ui.diag.value);
  assert.equal(value(p, "email"), "");
  assert.match(p.ui.diag.value, /丢弃原因：.*读取出错 1/);
  assert.match(p.w.ResumeProFeedback.fillReport(p.helpers.getFillSession().summary), /^drop_reasons: (?:.*,)?scan_error=1(?:,.*)?$/m);
});

test("a scan that throws before it is done is reported with its type and place, says so in Chinese, and keeps the page structure", async (t) => {
  // 扫描整页时就会读到的属性抛错：不是哪一个控件的事，整个扫描都做不下去。
  const p = page(t, { answers: ANSWERS, setup: (doc) => throwOn(doc.querySelector("input#school"), "tagName") });
  const result = await p.run();
  assert.deepEqual(p.requests, []);
  assert.equal(result.outcome, "failed");
  assert.equal(p.ui.status.textContent, "读这个页面的表单时出错了。可以试试下方的「深度分析本页」。");
  assert.doesNotMatch(p.ui.status.textContent + p.ui.diag.value, /boom|TypeError: /);
  // 代码异常报告：错误类型和本扩展代码的位置，没有异常原文。
  const exception = p.reports.find((report) => report.kind === "exception");
  assert.ok(exception, JSON.stringify(p.reports));
  assert.equal(exception.name, "TypeError");
  assert.match(exception.stack, /^field-scan\.js:\d+:\d+(?:\n[a-z-]+\.js:\d+:\d+)*$/);
  assert.doesNotMatch(JSON.stringify(exception), /boom/);
  // 填写诊断：扫描阶段、错误码 scan_exception，页面结构是补跑探测得到的。
  const failed = p.reports.find((report) => report.kind === "fill_failed");
  assert.ok(failed, JSON.stringify(p.reports));
  const lines = Object.fromEntries(failed.diagnostics.split("\n").filter((line) => line.includes(": ")).map((line) => line.split(": ")));
  assert.equal(lines.error_category, "unknown");
  assert.equal(lines.first_failing_stage, "scan");
  assert.equal(lines.error_code, "scan_exception");
  assert.equal(lines.page_type, "application_form");
  assert.equal(lines.dom_inputs, "4");
  assert.equal(lines.visible_fields, "4");
  assert.equal(lines.candidates, "0");
  assert.equal(lines.drop_reasons, "-");
  assert.match(lines.dom_elements, /^\d+$/);
  assert.match(lines.scan_duration_ms, /^\d+$/);
  assert.match(p.ui.diag.value, /扫描出错：TypeError（field-scan\.js:\d+:\d+）/);
  assert.match(p.ui.diag.value, /错误码：scan_exception/);
});
