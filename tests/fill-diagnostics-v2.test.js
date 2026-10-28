// #301 诊断补全：填写入口和网页焦点、AI 档位、没填上的下拉弹层计数、通用下拉计数、AI 请求失败也上报。
// 新增的每一项都是计数、时长或固定词表里的词；后台 diagnostics() 再过一遍，对不上的整行丢掉。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness.js");
const realProbe = require("../fill-probe.js");
const core = require("../feedback-core.js");

const lineOf = (report, key) => (report.match(new RegExp(`^${key}: (.*)$`, "m")) || [])[1];
const BASE = { path: "/campus/apply", pageType: { type: "application_form", reason: "url" }, readyAtScan: true,
  scanMs: 10, totalMs: 20, stats: null, probe: null, fieldCount: 2, matched: 2, filledCount: 2, unfilledCount: 0,
  unconfirmedCount: 0, requested: true, category: "none", stage: "none",
  diagnostics: { ruleMatches: 1, aiFields: 1, aiMatches: 1, promptBytes: 200, apiMs: 900, errorCode: "none" } };

// ---- feedback-core: every new key, its accepted values, and what gets dropped ----

test("[填写] says how a fill started and whether the page had focus; anything else reads as '-'", () => {
  for (const entry of ["panel", "deep", "recipe", "assist", "other"]) {
    for (const pageFocused of [true, false]) {
      const report = core.fillReport({ ...BASE, entry, pageFocused });
      assert.match(report, new RegExp(`^\\[填写\\]\\nentry: ${entry}\\npage_focused: ${pageFocused}$`, "m"));
      assert.equal(core.diagnostics(report), report);
    }
  }
  const odd = core.fillReport({ ...BASE, entry: "sidebar", pageFocused: "yes" });
  assert.equal(lineOf(odd, "entry"), "-");
  assert.equal(lineOf(odd, "page_focused"), "-");
});

test("ai_tier names the tier the AI ran on, and only when it was called", () => {
  const tierOf = diagnostics => lineOf(core.fillReport({ ...BASE, diagnostics: { ...BASE.diagnostics, ...diagnostics } }), "ai_tier");
  assert.equal(tierOf({}), "default", "a request without a tier always runs on the daily tier");
  assert.equal(tierOf({ tierRequested: "strong", tierUsed: "strong" }), "strong");
  assert.equal(tierOf({ tierRequested: "strong", tierUsed: "default" }), "default", "the tier actually used wins");
  assert.equal(tierOf({ tierRequested: "strong" }), "strong", "asked for, not confirmed");
  assert.equal(tierOf({ tierUsed: "gpt-4o" }), "default");
  assert.equal(tierOf({ promptBytes: 0, tierRequested: "strong" }), "-", "not called");
  assert.equal(lineOf(core.fillReport({ ...BASE, diagnostics: null, requested: true }), "ai_tier"), "-", "no answer at all");
  // A catch-up that called the AI counts as a call; catch-ups never ask for a tier.
  assert.equal(lineOf(core.fillReport({ ...BASE, diagnostics: { ...BASE.diagnostics, promptBytes: 0 }, grown: { aiCalled: true } }), "ai_tier"), "default");
});

test("unfilled selects say whether their popup opened and how many options it had, counts only", () => {
  const report = core.fillReport({ ...BASE, unfilledControls: [
    { label: "学历", reasonCode: "options_not_rendered", observed: { opened: "none", options: 5 }, control: { tag: "input", type: "text", readOnly: true } },
    { label: "学校", reasonCode: "no_option_match", observed: { opened: "listbox", options: 4 }, control: { tag: "input", type: "text" } },
    { label: "专业", reasonCode: "no_option_match", observed: { opened: "component", options: 999 }, control: { tag: "div" } },
    { label: "毕业时间", reasonCode: "invalid_date", observed: { opened: "calendar", options: 31 }, control: { tag: "input", type: "text" } },
    { label: "性别", reasonCode: "no_option_match", observed: { opened: "dropdown", options: 2 }, control: { tag: "div" } }
  ] });
  assert.match(report, /^- 学历: input\[text\] readonly opened=none reason=options_not_rendered$/m, "never opened: no option count");
  assert.match(report, /^- 学校: input\[text\] opened=listbox options=4 reason=no_option_match$/m);
  assert.match(report, /^- 专业: div opened=component options=200 reason=no_option_match$/m, "capped at 200");
  assert.match(report, /^- 毕业时间: input\[text\] opened=calendar reason=invalid_date$/m, "a calendar has no option count");
  assert.match(report, /^- 性别: div reason=no_option_match$/m, "an unknown popup kind is left out");
  assert.equal(core.diagnostics(report), report);
});

test("the allowlist keeps the new values and drops anything else, including resume text and URLs", () => {
  const forged = [
    "[填写]", "entry: panel", "entry: https://evil.example/?name=张三", "entry: 13800138000", "page_focused: true", "page_focused: 张三",
    "[匹配]", "ai_tier: strong", "ai_tier: gpt-4o-mini", "ai_tier: 张三的简历",
    "[页面结构]", "custom_libraries: generic=3,other=1", "custom_libraries: beisen=3", "custom_controls: 4",
    "[未填字段]",
    "- 学历: input[text] opened=listbox options=12 reason=no_option_match",
    "- 学校: input[text] opened=张三 options=201 options=-1 opened=https://evil.example options=13800138000 opened=示例大学",
    "- （字段名已隐藏）: div opened=none"
  ].join("\n");
  assert.equal(core.diagnostics(forged), [
    "[填写]", "entry: panel", "page_focused: true",
    "", "[匹配]", "ai_tier: strong",
    "", "[页面结构]", "custom_libraries: generic=3,other=1", "custom_controls: 4",
    "", "[未填字段]",
    "- 学历: input[text] opened=listbox options=12 reason=no_option_match",
    "- 学校: input[text]",
    "- （字段名已隐藏）: div opened=none"
  ].join("\n"));
});

test("custom selects handled on the generic path count as custom controls of the library 'generic'", () => {
  const probe = { frames: { total: 0, crossOrigin: 0, frameInputs: 0 }, custom: { total: 1, byLibrary: { antd: 1 } },
    editButtons: 0, locked: 0, shadowHosts: 0, elements: 300 };
  const report = core.fillReport({ ...BASE, probe, genericCustom: 26 });
  assert.equal(lineOf(report, "custom_controls"), "27");
  assert.equal(lineOf(report, "custom_libraries"), "antd=1,generic=26");
  assert.equal(lineOf(core.fillReport({ ...BASE, probe }), "custom_libraries"), "antd=1", "nothing generic: unchanged");
  assert.equal(lineOf(core.fillReport({ ...BASE, probe: null, genericCustom: 3 }), "custom_controls"), "-", "no probe: unknown, as before");
});

test("fill-probe counts only generic roots it did not already count", () => {
  const { JSDOM } = require("jsdom");
  const { document } = new JSDOM(`<div class="phoenix-select" id="a"><input></div>
    <div class="phoenix-select" id="b"><input></div>
    <div role="combobox" id="c"><input></div>
    <div class="ant-select"><div id="d"><input></div></div>
    <div id="e"><input role="combobox"></div>`).window;
  const roots = ["a", "b", "c", "d", "e", "a"].map(id => document.getElementById(id));
  assert.equal(realProbe.uncountedControls(roots), 2, "a and b; c, d and e are already custom controls to the probe; a twice is one");
  assert.equal(realProbe.uncountedControls([null, {}, undefined]), 0);
});

test("read-only inputs inside generic selects leave readonly_or_disabled; disabled ones and other locked inputs stay", () => {
  const { JSDOM } = require("jsdom");
  const { window } = new JSDOM(`<div class="phoenix-select" id="a"><input readonly></div>
    <div class="phoenix-select" id="b"><input readonly><input readonly></div>
    <input readonly id="c">
    <div class="phoenix-select" id="d"><input readonly disabled></div>
    <div class="ant-select" id="e"><input readonly></div>`);
  window.HTMLElement.prototype.getClientRects = () => [{}];
  const { document } = window;
  const probe = realProbe.probePage(document, { href: "https://jobs.example.test/apply" });
  assert.equal(probe.locked, 5, "the probe counts every read-only input outside library controls, and every disabled one");
  const roots = ["a", "b", "c", "d", "e"].map(id => document.getElementById(id));
  assert.equal(realProbe.uncountedLocked(roots), 4, "a, b twice and c (a root that is itself the input); not d's disabled input or e's");
  assert.equal(realProbe.uncountedLocked([null, {}]), 0);
  const report = core.fillReport({ ...BASE, probe, genericCustom: 4, genericLocked: 1 });
  assert.equal(lineOf(report, "readonly_or_disabled"), "4");
  assert.equal(lineOf(core.fillReport({ ...BASE, probe, genericLocked: 9 }), "readonly_or_disabled"), "0", "never below zero");
  assert.equal(lineOf(core.fillReport({ ...BASE, probe: { ...probe, locked: undefined }, genericLocked: 1 }), "readonly_or_disabled"), "-");
});

test("a failed AI request is the first failure: timeout or service_error at the match stage, never fill_rejected", () => {
  const written = { scanned: true, fieldCount: 3, pageType: "application_form", responded: true, matched: 2, filledCount: 2, unfilledCount: 0, unconfirmedCount: 0 };
  assert.deepEqual(core.fillCategory({ ...written, errorCode: "timeout" }), { category: "timeout", stage: "match" });
  for (const errorCode of ["network", "unavailable", "not_paired", "auth", "http_502"]) {
    assert.deepEqual(core.fillCategory({ ...written, errorCode }), { category: "service_error", stage: "match" }, errorCode);
  }
  // Local writes failed too: the category still names the request.
  assert.deepEqual(core.fillCategory({ ...written, filledCount: 1, unfilledCount: 1, errorCode: "timeout" }), { category: "timeout", stage: "match" });
  // A catch-up's failure counts when the first round had none; a first-round code is never replaced.
  assert.deepEqual(core.fillCategory({ ...written, errorCode: "none", catchUpCode: "timeout" }), { category: "timeout", stage: "match" });
  assert.deepEqual(core.fillCategory({ ...written, errorCode: "none", catchUpCode: "http_503" }), { category: "service_error", stage: "match" });
  assert.deepEqual(core.fillCategory({ ...written, errorCode: "no_context", catchUpCode: "timeout" }), { category: "none", stage: "none" });
  // Not request failures.
  for (const errorCode of ["none", "cancelled", "no_context", "input_too_large", "secret_only", "no_resume_fields"]) {
    assert.deepEqual(core.fillCategory({ ...written, errorCode }), { category: "none", stage: "none" }, errorCode);
  }
});

test("a failed AI request is reported even when everything matched got written; exclusions stay", () => {
  const base = { fieldCount: 3, unfilledCount: 0, unconfirmedCount: 0 };
  assert.equal(core.fillFailure({ ...base, filledCount: 2, category: "timeout" }), "fill_partial");
  assert.equal(core.fillFailure({ ...base, filledCount: 0, category: "service_error" }), "fill_failed");
  assert.equal(core.fillFailure({ ...base, filledCount: 2, category: "none" }), null, "nothing failed");
  assert.equal(core.fillFailure({ ...base, filledCount: 0, category: "match_failed" }), null, "answered, matched nothing: unchanged");
  for (const key of ["assisted", "cancelled", "overwriteDeclined"]) {
    assert.equal(core.fillFailure({ ...base, filledCount: 1, category: "timeout", [key]: true }), null, key);
  }
  assert.equal(core.fillFailure({ fieldCount: 0, filledCount: 0, unfilledCount: 0, category: "page_not_supported" }), null);
});

// ---- content.js: what a real fill records and sends ----

const PRIVATE = ["张伟测试", "13912345678", "zhangwei.test@example.com", "110101199003077777", "示例大学", "示例科技有限公司",
  "高级测试工程师", "示例市示例路88号", "secret-session", "token=", "upstream said"];
const STORE = { templates: [{ id: "one", name: "张伟测试的模板", groups: [{ name: "基本信息", fields: [
  { key: "姓名", value: "张伟测试" }, { key: "手机", value: "13912345678" }, { key: "邮箱", value: "zhangwei.test@example.com" },
  { key: "身份证号", value: "110101199003077777" }, { key: "学校", value: "示例大学" }, { key: "学历", value: "本科" },
  { key: "现居住地", value: "示例市示例路88号" }, { key: "工作单位", value: "示例科技有限公司" }
] }] }], activeTemplateId: "one" };
const EMPTY = { host: "jobs.example.test", frames: { total: 0, crossOrigin: 0, frameInputs: 0 },
  custom: { total: 0, byLibrary: {} }, editButtons: 0, locked: 0, shadowHosts: 0, elements: 40 };
const diag = (extra = {}) => ({ ruleMatches: 0, aiFields: 1, aiMatches: 0, promptBytes: 300, apiMs: 5, resumeFields: 8,
  candidateFields: 2, errorCode: "none", secretFormFields: 0, skippedNoContext: 0, ...extra });
const TIMEOUT = "日常模型等了 120 秒没有返回，可在桌面设置换模型后重试。";

async function fill({ path = "/campus/apply", title = "", fields = [], respond, focused, viaPanel = false, assisted = null, deep = null,
  controls, customControls, fieldScan, confirm, onCancelButton } = {}) {
  const sent = [];
  const formElements = [];
  const location = { href: `https://jobs.example.test${path}?token=secret-session`, pathname: path };
  const env = loadHighlightHelpers({
    formElements, feedback: core, location, controls, customControls, fieldScan, confirm,
    fillProbe: { ...realProbe, probePage: () => EMPTY },
    sendMessage: async message => {
      sent.push(message);
      if (message.type === "CANCEL_AI_FILL") return { cancelled: true };
      return message.type === "AI_FILL" ? respond(message, ui) : { ok: true };
    }
  });
  env.document.title = title;
  if (typeof focused === "boolean") env.document.hasFocus = () => focused;
  for (const setup of fields) {
    const input = new env.HTMLInputElement();
    setup(input, env);
    formElements.push(input);
  }
  let running = null;
  const button = { disabled: false, textContent: "", click() { running = env.helpers.handleAiFillClick({ currentTarget: button }); } };
  const ui = { status: { textContent: "", className: "", classList: { contains: () => false } }, text: { value: "" },
    cancel: { hidden: true, disabled: false, onclick: null } };
  const panel = { hidden: true, open: false, querySelector: selector => (selector === "#resume-pro-diagnostics-text" ? ui.text : null) };
  env.helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: selector => ({
    "#resume-pro-status": ui.status, "#resume-pro-diagnostics": panel, "#resume-pro-diagnostics-text": ui.text,
    "#resume-pro-ai-fill": button, "#resume-pro-cancel-fill": ui.cancel
  })[selector] || null });
  env.helpers.setCurrentStore(STORE);
  let result;
  if (viaPanel) {
    const reply = await env.sendPanelMessage({ type: "RESUME_PANEL_FILL" });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    result = await running;
  } else {
    result = await env.helpers.handleAiFillClick({ currentTarget: button }, assisted, deep);
  }
  const status = await env.sendPanelMessage({ type: "RESUME_PANEL_STATUS" });
  return {
    result, sent, ui,
    reports: sent.filter(message => message.type === "FEEDBACK_AUTO").map(message => message.report),
    report: status?.diagnosticsReport || ""
  };
}

const named = (name, label = name) => (input) => { input.name = name; input.setAttribute("data-label", label); };
const refuseWrites = input => Object.defineProperty(input, "value", { get: () => "", set: () => {}, configurable: true });

test("a fill started from the side panel records entry=panel and the page's focus at that moment", async () => {
  const respond = () => ({ success: true, matches: [], diagnostics: diag() });
  const panel = await fill({ viaPanel: true, focused: false, fields: [named("hobby")], respond });
  assert.equal(lineOf(panel.report, "entry"), "panel");
  assert.equal(lineOf(panel.report, "page_focused"), "false");
  const direct = await fill({ focused: true, fields: [named("hobby")], respond });
  assert.equal(lineOf(direct.report, "entry"), "other", "not started by the side panel");
  assert.equal(lineOf(direct.report, "page_focused"), "true");
  const unknown = await fill({ fields: [named("hobby")], respond });
  assert.equal(lineOf(unknown.report, "page_focused"), "-", "a document without hasFocus()");
});

test("deep analysis, recipe runs and 辅助新增 each record their own entry", async () => {
  const respond = () => ({ success: true, matches: [], diagnostics: diag() });
  const deep = await fill({ fields: [named("hobby")], respond, deep: { fields: null, tier: "strong", maxCalls: 6, report: {} } });
  assert.equal(lineOf(deep.report, "entry"), "deep");
  const recipe = await fill({ fields: [named("hobby")], respond, deep: { mode: "recipe", fields: null, report: {} } });
  assert.equal(lineOf(recipe.report, "entry"), "recipe");
  const assist = await fill({ fields: [named("hobby")], respond,
    assisted: { scopes: [{ contains: () => true, isConnected: true }], quiet: true } });
  assert.equal(lineOf(assist.report, "entry"), "assist");
});

test("a first-round AI timeout is reported even though the local match was written", async () => {
  const { reports, report, result } = await fill({ viaPanel: true, focused: false, fields: [named("name", "姓名"), named("hobby", "爱好")],
    respond: message => ({ success: true, matches: [{ fieldId: message.formFields[0].fieldId, value: "张伟测试" }], warning: TIMEOUT, error: TIMEOUT,
      diagnostics: diag({ ruleMatches: 1, aiFields: 1, errorCode: "timeout", apiMs: 120000 }) }) });
  assert.equal(result.filledCount, 1);
  assert.equal(result.unfilledCount, 0, "nothing failed to write");
  assert.deepEqual(reports.map(item => item.kind), ["fill_partial"]);
  const block = reports[0].diagnostics;
  assert.equal(lineOf(block, "error_category"), "timeout");
  assert.equal(lineOf(block, "first_failing_stage"), "match");
  assert.equal(lineOf(block, "error_code"), "timeout");
  assert.equal(lineOf(block, "ai_tier"), "default");
  assert.equal(lineOf(block, "entry"), "panel");
  assert.equal(block, report, "the manual-feedback block says the same");
});

test("an AI service failure with nothing written is reported as fill_failed, and failed local writes do not hide it", async () => {
  const failed = await fill({ fields: [named("hobby")],
    respond: () => ({ success: false, error: "无法连接桌面程序", matches: [], diagnostics: diag({ errorCode: "http_502" }) }) });
  assert.deepEqual(failed.reports.map(item => item.kind), ["fill_failed"]);
  assert.equal(lineOf(failed.reports[0].diagnostics, "error_category"), "service_error");
  assert.equal(lineOf(failed.reports[0].diagnostics, "first_failing_stage"), "match");
  assert.equal(lineOf(failed.reports[0].diagnostics, "error_code"), "http_502");

  const refused = await fill({ fields: [input => { named("name", "姓名")(input); refuseWrites(input); }, named("hobby")],
    respond: message => ({ success: true, matches: [{ fieldId: message.formFields[0].fieldId, value: "张伟测试" }], warning: TIMEOUT,
      diagnostics: diag({ ruleMatches: 1, errorCode: "timeout" }) }) });
  assert.deepEqual(refused.reports.map(item => item.kind), ["fill_failed"]);
  assert.equal(lineOf(refused.reports[0].diagnostics, "error_category"), "timeout", "not fill_rejected");
  assert.equal(lineOf(refused.reports[0].diagnostics, "error_code"), "timeout");
  assert.match(refused.reports[0].diagnostics, /^drop_reasons: .*not_written=1/m);
});

test("no AI-failure report for an assisted, deep, cancelled or overwrite-declined fill", async () => {
  const timedOut = message => ({ success: true, matches: [{ fieldId: message.formFields[0].fieldId, value: "张伟测试" }], warning: TIMEOUT,
    diagnostics: diag({ ruleMatches: 1, errorCode: "timeout" }) });
  // 辅助新增写完要等页面一拍（假定时器不走），这里让 AI 超时、一项都没匹配上。
  const assisted = await fill({ fields: [named("name", "姓名")],
    respond: () => ({ success: false, matches: [], warning: TIMEOUT, error: TIMEOUT, diagnostics: diag({ errorCode: "timeout" }) }),
    assisted: { scopes: [{ contains: () => true, isConnected: true }], quiet: true } });
  assert.equal(lineOf(assisted.report, "error_category"), "timeout");
  assert.equal(assisted.reports.length, 0, "assisted");
  const deep = await fill({ fields: [named("name", "姓名")], respond: timedOut, deep: { fields: null, tier: "strong", maxCalls: 6, report: {} } });
  assert.equal(deep.reports.length, 0, "deep");
  // The user pressed cancel while waiting; the answer that came back says the provider timed out.
  const cancelled = await fill({ fields: [named("name", "姓名")], respond: async (message, ui) => { await ui.cancel.onclick(); return timedOut(message); } });
  assert.equal(cancelled.reports.length, 0, "cancelled");
  assert.equal(lineOf(cancelled.report, "error_category"), "timeout");
  // An existing value and 取消 on the overwrite question: nothing is written, nothing is reported.
  const declined = await fill({ fields: [input => { named("name", "姓名")(input); input.value = "旧内容"; }], respond: timedOut, confirm: () => false });
  assert.equal(declined.result.overwriteDeclined, true);
  assert.equal(declined.reports.length, 0, "overwrite declined");
});

test("a page that is not an application form stays unreported", async () => {
  const { reports, report } = await fill({ path: "/interview/room", title: "视频面试", fields: [] });
  assert.equal(reports.length, 0);
  assert.equal(lineOf(report, "error_category"), "page_not_supported");
});

// Custom selects the scan found on the generic path (北森): the control layer is a stand-in that
// reports what control-adapters.js / custom-controls.js put into result.observed.
function genericSelects(outcomes) {
  const scan = fakeFieldScan();
  return {
    fieldScan: { ...scan, scanPage: (doc, options) => {
      const result = scan.scanPage(doc, options);
      result.controls.forEach(control => { control.controlKind = "custom-select"; });
      return result;
    } },
    customControls: { describe: entry => ({ library: "generic", root: entry.element, el: entry.element }),
      hasExistingValue: () => false, snapshot: () => "", readSelection: () => ({ texts: [] }) },
    controls: { create: () => ({ operate: async entry => outcomes[entry.element.name], check: () => ({ ok: true }) }) }
  };
}

test("unfilled custom selects tell 'never opened' from 'opened with N options', and generic selects count as custom controls", async () => {
  const stubs = genericSelects({
    degree: { ok: false, reason: "options_not_rendered", observed: { controlKind: "custom-select", connected: true, rolledBack: false } },
    school: { ok: false, reason: "no_option_match", observed: { controlKind: "custom-select", library: "generic", popupRole: "listbox", optionCount: 4 } },
    city: { ok: false, reason: "no_option_match", observed: { controlKind: "custom-select", library: "generic", popupRole: "tree", optionCount: 260 } }
  });
  const { reports } = await fill({ ...stubs, fields: [named("degree", "学历"), named("school", "学校"), named("city", "现居住地")],
    respond: message => ({ success: true, matches: message.formFields.map((field, index) => ({ fieldId: field.fieldId, value: ["本科", "示例大学", "示例市"][index] })),
      diagnostics: diag({ ruleMatches: 3, aiFields: 0, promptBytes: 0 }) }) });
  assert.deepEqual(reports.map(item => item.kind), ["fill_failed"]);
  const block = reports[0].diagnostics;
  assert.match(block, /^- 学历: input\[text\] opened=none reason=options_not_rendered$/m);
  assert.match(block, /^- 学校: input\[text\] opened=listbox options=4 reason=no_option_match$/m);
  assert.match(block, /^- 现居住地: input\[text\] opened=tree options=200 reason=no_option_match$/m);
  assert.equal(lineOf(block, "custom_controls"), "3");
  assert.equal(lineOf(block, "custom_libraries"), "generic=3");
  assert.equal(lineOf(block, "ai_tier"), "-", "the rules matched everything; the AI was not called");
});

test("a fill on a page full of personal data leaves none of it in the report, the panel block or the sent payload", async () => {
  const stubs = genericSelects({
    张伟测试: { ok: false, reason: "no_option_match", observed: { controlKind: "custom-select", popupRole: "listbox", optionCount: 3,
      library: "generic", options: ["示例大学", "张伟测试"], text: "13912345678" } },
    phone: { ok: true, observed: { controlKind: "text" } }
  });
  const { reports, report } = await fill({ ...stubs,
    path: "/apply/zhangwei/13912345678/示例科技有限公司", title: "张伟测试的简历 - 示例科技有限公司 高级测试工程师",
    fields: [named("张伟测试", "张伟测试的学校"), (input) => { named("phone", "手机 13912345678")(input); input.placeholder = "zhangwei.test@example.com"; }],
    respond: message => ({ success: true, warning: `upstream said 张伟测试 13912345678 https://evil.example/?token=1`,
      matches: [{ fieldId: message.formFields[0].fieldId, value: "示例大学" }, { fieldId: message.formFields[1].fieldId, value: "13912345678" }],
      diagnostics: diag({ ruleMatches: 1, errorCode: "timeout", aiFields: 1 }) }) });
  assert.equal(reports.length, 1);
  const { createFeedback } = await import("../link/feedback.mjs");
  const data = {}; const bodies = [];
  const worker = createFeedback({ storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    version: "0.4.4", os: "Windows / Chrome 140", install: () => "development",
    fetchImpl: async (_url, request) => { bodies.push(request.body); return new Response('{"ok":true,"id":"x"}'); } });
  await worker.setConsent(true);
  await worker.automatic(reports[0], "jobs.example.test");
  assert.equal(bodies.length, 1);
  const sentBody = JSON.parse(bodies[0]).user_description;
  for (const text of [JSON.stringify(reports), report, sentBody]) {
    for (const value of PRIVATE) assert.ok(!text.includes(value), `${value} leaked`);
  }
  assert.match(sentBody, /^- （字段名已隐藏）: input\[text\] opened=listbox options=3 reason=no_option_match$/m);
  assert.match(sentBody, /^install: development$/m);
});
