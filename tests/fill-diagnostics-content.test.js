// fill_failed 诊断 v1 接进 content.js 之后的行为（#215 后续）：非表单页不上报；其余失败一次上报就能看出卡在哪一步。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers } = require("./helpers/content-harness.js");
const realProbe = require("../fill-probe.js");
const core = require("../feedback-core.js");

const PRIVATE = ["张三", "13800138000", "zhangsan@example.com", "李四"];
const STORE = { templates: [{ id: "one", groups: [{ name: "基本信息", fields: [
  { key: "姓名", value: "张三" }, { key: "手机", value: "13800138000" }, { key: "邮箱", value: "zhangsan@example.com" }
] }] }], activeTemplateId: "one" };
const EMPTY = { host: "jobs.example.test", frames: { total: 0, crossOrigin: 0, frameInputs: 0 },
  custom: { total: 0, byLibrary: {} }, editButtons: 0, locked: 0, shadowHosts: 0, elements: 40 };
const refuseWrites = input => Object.defineProperty(input, "value", { get: () => "", set: () => {}, configurable: true });

async function run({ path = "/", title = "", probe = EMPTY, fields = [], hiddenInputs = 0,
  respond = () => ({ success: true, matches: [] }) } = {}) {
  const sent = [];
  const formElements = [];
  const allInputs = hiddenInputs ? [] : undefined;
  const location = { href: `https://jobs.example.test${path}?token=secret-session`, pathname: path };
  const env = loadHighlightHelpers({
    formElements, allInputs, feedback: core, location,
    fillProbe: { ...realProbe, probePage: typeof probe === "function" ? probe : () => probe },
    sendMessage: async message => { sent.push(message); return message.type === "AI_FILL" ? respond(message, location) : { ok: true }; }
  });
  env.document.title = title;
  for (const setup of fields) {
    const input = new env.HTMLInputElement();
    setup(input);
    formElements.push(input);
  }
  if (allInputs) {
    for (let index = 0; index < hiddenInputs; index += 1) allInputs.push(Object.assign(new env.HTMLInputElement(), { type: "hidden" }));
    allInputs.push(...formElements);
  }
  const status = { textContent: "", className: "", classList: { contains: () => false } };
  const text = { value: "" };
  const panel = { hidden: true, open: false, querySelector: selector => (selector === "#resume-pro-diagnostics-text" ? text : null) };
  env.helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: selector => ({
    "#resume-pro-status": status, "#resume-pro-diagnostics": panel, "#resume-pro-diagnostics-text": text
  })[selector] || null });
  env.helpers.setCurrentStore(STORE);
  const result = await env.helpers.handleAiFillClick({ currentTarget: { disabled: false } });
  const panelStatus = await env.sendPanelMessage({ type: "RESUME_PANEL_STATUS" });
  return {
    result, status, text, sent, timers: env.timers,
    aiCalls: sent.filter(message => message.type === "AI_FILL").length,
    reports: sent.filter(message => message.type === "FEEDBACK_AUTO").map(message => message.report),
    report: panelStatus?.diagnosticsReport || ""
  };
}

test("a video-interview room with nothing to fill is not reported, and the user is told it is not an application page", async () => {
  const run1 = await run({ path: "/interview/room", title: "多面视频面试工具" });
  assert.equal(run1.reports.length, 0);
  assert.equal(run1.aiCalls, 0);
  assert.match(run1.result.error, /不是网申填写页/);
  // 这句提示要留在屏幕上，不像普通失败 2.4 秒后消失。
  assert.equal(run1.timers.filter(timer => timer.delay === 2400 && !timer.cleared).length, 0);
  assert.match(run1.text.value, /错误类别：page_not_supported；失败阶段：扫描/);
  assert.match(run1.text.value, /本地匹配：未执行；AI 匹配：未执行/);
  assert.match(run1.report, /^error_category: page_not_supported$/m);
  assert.match(run1.report, /^page_type: unknown$/m);
  assert.match(run1.report, /^page_type_reason: none$/m);
});

test("an application page whose form sits in a cross-origin frame is reported as iframe_blocked", async () => {
  const { reports } = await run({ path: "/campus/apply/2024", probe: { ...EMPTY, frames: { total: 1, crossOrigin: 1, frameInputs: 0 } } });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, "fill_failed");
  const block = reports[0].diagnostics;
  for (const line of ["error_category: iframe_blocked", "first_failing_stage: scan", "iframes_cross_origin: 1",
    "url_path: /campus/apply/:id", "page_type: application_form", "page_type_reason: url", "ai_called: false",
    "dom_ready_at_scan: false"]) {
    assert.ok(block.split("\n").includes(line), `${line}\n${block}`);
  }
  assert.match(block, /^timings_ms: scan=\d+,match=-,fill=-,total=\d+$/m);
  assert.ok(!block.includes("secret-session"));
});

test("a page with no form signals but a cross-origin frame is still reported, as iframe_blocked", async () => {
  const { reports, result } = await run({ path: "/jobs/1970", probe: { ...EMPTY, frames: { total: 1, crossOrigin: 1, frameInputs: 0 } } });
  assert.equal(reports.length, 1);
  assert.match(reports[0].diagnostics, /^error_category: iframe_blocked$/m);
  assert.match(reports[0].diagnostics, /^page_type: unknown$/m);
  assert.match(result.error, /内嵌框架/);
});

test("a page whose only visible inputs are disabled is reported, even without form words in the address", async () => {
  const { reports } = await run({ path: "/quick/go", probe: { ...EMPTY, locked: 2 } });
  assert.equal(reports.length, 1);
  assert.match(reports[0].diagnostics, /^error_category: no_fields_found$/m);
  assert.match(reports[0].diagnostics, /^page_type_reason: structure$/m);
  assert.match(reports[0].diagnostics, /^readonly_or_disabled: 2$/m);
});

test("an application page whose inputs are all hidden is reported as no_fields_found with the drop reasons", async () => {
  const { reports } = await run({ path: "/campus/apply", hiddenInputs: 3 });
  assert.equal(reports.length, 1);
  const block = reports[0].diagnostics;
  assert.match(block, /^error_category: no_fields_found$/m);
  assert.match(block, /^dom_inputs: 3$/m);
  assert.match(block, /^visible_fields: 0$/m);
  assert.match(block, /^candidates: 0$/m);
  assert.match(block, /^drop_reasons: type_hidden=3$/m);
});

test("when the page probe breaks, an empty page is still reported because it may be a form", async () => {
  const { reports } = await run({ probe: () => { throw new Error("boom"); } });
  assert.equal(reports.length, 1);
  assert.match(reports[0].diagnostics, /^error_category: no_fields_found$/m);
  assert.match(reports[0].diagnostics, /^page_type: -$/m);
});

test("a match failure names the match stage and whether the AI was actually called", async () => {
  const { reports, report, text } = await run({ path: "/apply", fields: [input => { input.name = "hobby"; }],
    respond: () => ({ success: true, matches: [], diagnostics: { ruleMatches: 0, aiFields: 1, aiMatches: 0, promptBytes: 320,
      apiMs: 812.4, resumeFields: 3, candidateFields: 2, errorCode: "none", secretFormFields: 0, skippedNoContext: 0 } }) });
  // 自动上报的条件不变：没写坏、也没有漏填的字段时不上报；诊断照样记下来，手动反馈会附上。
  assert.equal(reports.length, 0);
  for (const line of ["error_category: match_failed", "first_failing_stage: match", "ai_called: true", "ai_latency_ms: 812",
    "candidates: 1", "matched: 0", "drop_reasons: ai_unmatched=1"]) {
    assert.ok(report.split("\n").includes(line), `${line}\n${report}`);
  }
  assert.match(text.value, /错误类别：match_failed；失败阶段：匹配/);
});

test("the model tier line appears only when a tier was asked for, and the report never carries it", async () => {
  const base = { ruleMatches: 0, aiFields: 1, aiMatches: 0, promptBytes: 300, apiMs: 5, resumeFields: 3, candidateFields: 1, errorCode: "none" };
  const plain = await run({ path: "/apply", fields: [input => { input.name = "hobby"; }],
    respond: () => ({ success: true, matches: [], diagnostics: base }) });
  assert.doesNotMatch(plain.text.value, /模型档位/);
  for (const [requested, used, label] of [["strong", "strong", "强"], ["strong", "default", "强模型未设置，已退回日常"],
    ["default", "default", "日常"], ["strong", undefined, "未取得"]]) {
    const { text, report } = await run({ path: "/apply", fields: [input => { input.name = "hobby"; }],
      respond: () => ({ success: true, matches: [], diagnostics: { ...base, tierRequested: requested, ...(used ? { tierUsed: used } : {}) } }) });
    assert.ok(text.value.split("\n").includes(`模型档位：${label}`), text.value);
    assert.doesNotMatch(report, /tier/);
  }
});

test("a desktop or AI service failure is a service_error, not a match failure", async () => {
  const { report } = await run({ path: "/apply", fields: [input => { input.name = "hobby"; }],
    respond: () => ({ success: false, error: "无法连接桌面程序", matches: [], diagnostics: { ruleMatches: 0, aiFields: 1, aiMatches: 0,
      promptBytes: 300, apiMs: 5, resumeFields: 3, candidateFields: 1, errorCode: "unavailable" } }) });
  assert.match(report, /^error_category: service_error$/m);
  assert.match(report, /^error_code: unavailable$/m);
  assert.match(report, /^drop_reasons: no_result=1$/m);
});

test("the report describes the page that was scanned, even if the page navigates during the fill, and both channels agree", async () => {
  const { reports, report } = await run({ path: "/apply", fields: [input => { input.name = "name"; refuseWrites(input); }],
    respond: (_message, location) => {
      location.pathname = "/jobs/list";
      return { success: true, matches: [{ fieldId: "field-0", value: "张三" }],
        diagnostics: { ruleMatches: 1, aiFields: 0, aiMatches: 0, promptBytes: 0, apiMs: 0, resumeFields: 3, candidateFields: 0, errorCode: "none" } };
    } });
  assert.equal(reports.length, 1);
  assert.match(reports[0].diagnostics, /^url_path: \/apply$/m);
  assert.equal(reports[0].diagnostics, report);
});

test("a page that refuses every write is reported as fill_rejected without any name, phone or e-mail value", async () => {
  const { reports, report } = await run({ path: "/apply", fields: [
    input => { input.name = "name"; refuseWrites(input); },
    input => { input.name = "phone"; input.type = "tel"; refuseWrites(input); },
    input => { input.name = "email"; input.type = "email"; refuseWrites(input); },
    input => { input.name = "contact"; input.value = "李四"; }
  ], respond: () => ({ success: true, matches: [
    { fieldId: "field-0", value: "张三" }, { fieldId: "field-1", value: "13800138000" }, { fieldId: "field-2", value: "zhangsan@example.com" }
  ], diagnostics: { ruleMatches: 3, aiFields: 1, aiMatches: 0, promptBytes: 0, apiMs: 0, resumeFields: 3, candidateFields: 0, errorCode: "none" } }) });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].kind, "fill_failed");
  const block = reports[0].diagnostics;
  assert.match(block, /^error_category: fill_rejected$/m);
  assert.match(block, /^first_failing_stage: fill$/m);
  assert.match(block, /^matched: 3$/m);
  // 第 4 个字段本地没匹配上，也没送 AI（promptBytes 为 0）。
  assert.match(block, /^drop_reasons: not_sent=1,not_written=3$/m);
  assert.match(block, /^\[未填字段\]$/m);
  for (const value of PRIVATE) {
    assert.ok(!JSON.stringify(reports).includes(value), value);
    assert.ok(!report.includes(value), value);
  }
});
