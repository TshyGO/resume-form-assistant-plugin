// fill_failed 诊断载荷 v1（#215 后续）：一次上报就能看出失败卡在哪一步，且只含结构和计数。
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../feedback-core.js");

test("url paths keep only common route words; names, ids, tokens and non-ASCII segments become :id", () => {
  assert.equal(core.pathTemplate("/atsc/apply/12345"), "/:id/apply/:id");
  assert.equal(core.pathTemplate("/u/zhangsan"), "/u/:id");
  assert.equal(core.pathTemplate("/people/john-doe/resume"), "/:id/:id/resume");
  assert.equal(core.pathTemplate("/candidate/my-resume/edit"), "/candidate/my-resume/edit");
  assert.equal(core.pathTemplate("/campus/myResume/apply.html"), "/campus/myResume/apply.html");
  assert.equal(core.pathTemplate("/v2/apply"), "/v2/apply");
  assert.equal(core.pathTemplate("/resume/abc/edit"), "/resume/:id/edit");
  assert.equal(core.pathTemplate("/resume/5f3a9c2e8b/edit"), "/resume/:id/edit");
  assert.equal(core.pathTemplate("/job/abc123def/apply"), "/job/:id/apply");
  assert.equal(core.pathTemplate("/u/a%40b.com/profile"), "/u/:id/profile");
  assert.equal(core.pathTemplate("/%E5%BC%A0%E4%B8%89/resume"), "/:id/resume");
  assert.equal(core.pathTemplate("/apply/abcdefghijklmnopqrstu"), "/apply/:id");
  assert.equal(core.pathTemplate("/apply/%E0%A4%A"), "/apply/:id");
  assert.equal(core.pathTemplate("/v2/apply/"), "/v2/apply");
  assert.equal(core.pathTemplate("/m/s/p/c/u/en/my/app/i/j"), "/m/s/p/c/u/en/my/app/:more");
  assert.equal(core.pathTemplate(""), "/");
  assert.equal(core.pathTemplate(undefined), "/");
});

test("an empty page is page_not_supported unless it looks like an application form", () => {
  const empty = { scanned: true, fieldCount: 0, frames: { crossOrigin: 0, frameInputs: 0 } };
  assert.deepEqual(core.fillCategory({ ...empty, pageType: "unknown" }), { category: "page_not_supported", stage: "scan" });
  // 看不出是表单页，但有跨域框架：申请表可能就嵌在里面，判断不了就照常上报。
  assert.deepEqual(core.fillCategory({ ...empty, pageType: "unknown", frames: { crossOrigin: 1, frameInputs: 0 } }),
    { category: "iframe_blocked", stage: "scan" });
  assert.deepEqual(core.fillCategory({ ...empty, pageType: "application_form" }), { category: "no_fields_found", stage: "scan" });
  assert.deepEqual(core.fillCategory({ ...empty, pageType: "application_form", frames: { crossOrigin: 2, frameInputs: 0 } }),
    { category: "iframe_blocked", stage: "scan" });
  assert.deepEqual(core.fillCategory({ ...empty, pageType: "application_form", frames: { crossOrigin: 0, frameInputs: 3 } }),
    { category: "iframe_blocked", stage: "scan" });
  // 页面探测不可用：判断不了是不是表单页，照旧当成没找到字段上报。
  assert.deepEqual(core.fillCategory({ ...empty, pageType: null, frames: null }), { category: "no_fields_found", stage: "scan" });
  assert.deepEqual(core.fillCategory({ scanned: false, fieldCount: 0 }), { category: "unknown", stage: "scan" });
});

test("failures after the scan name the stage, and a service failure is not called a match failure", () => {
  const base = { scanned: true, fieldCount: 4, pageType: "application_form" };
  const failedMatch = { ...base, failedStage: "match", responded: true };
  assert.deepEqual(core.fillCategory({ ...base, failedStage: "match", responded: false }), { category: "unknown", stage: "match" });
  assert.deepEqual(core.fillCategory({ ...failedMatch, errorCode: "timeout" }), { category: "timeout", stage: "match" });
  for (const errorCode of ["network", "auth", "not_paired", "unavailable", "http_502", "bad_response"]) {
    assert.deepEqual(core.fillCategory({ ...failedMatch, errorCode }), { category: "service_error", stage: "match" }, errorCode);
  }
  for (const errorCode of ["none", "no_context", "secret_only", "no_resume_fields", undefined]) {
    assert.deepEqual(core.fillCategory({ ...failedMatch, errorCode }), { category: "match_failed", stage: "match" }, String(errorCode));
  }
  assert.deepEqual(core.fillCategory({ ...base, failedStage: "fill" }), { category: "unknown", stage: "fill" });
  assert.deepEqual(core.fillCategory({ ...base, matched: 0, filledCount: 0, unfilledCount: 0 }), { category: "match_failed", stage: "match" });
  assert.deepEqual(core.fillCategory({ ...base, matched: 3, filledCount: 0, unfilledCount: 3 }), { category: "fill_rejected", stage: "fill" });
  assert.deepEqual(core.fillCategory({ ...base, matched: 3, filledCount: 2, unfilledCount: 1 }), { category: "fill_rejected", stage: "fill" });
  assert.deepEqual(core.fillCategory({ ...base, matched: 3, filledCount: 3, unfilledCount: 0 }), { category: "none", stage: "none" });
});

test("pages that are not application forms are never reported automatically", () => {
  const empty = { fieldCount: 0, filledCount: 0, unfilledCount: 0 };
  assert.equal(core.fillFailure({ ...empty, category: "page_not_supported" }), null);
  for (const category of ["no_fields_found", "iframe_blocked", undefined]) {
    assert.equal(core.fillFailure({ ...empty, category }), "fill_failed", String(category));
  }
});

const IFRAME_PAGE = {
  path: "/atsc/apply/12345",
  pageType: { type: "application_form", reason: "url" },
  readyAtScan: true,
  scanMs: 12.4, roundTripMs: null, fillMs: null, totalMs: 15.2,
  stats: { domInputs: 14, visible: 0, typeHidden: 3, nonFillable: 1, disabled: 2, invisible: 8, grouped: 0, outOfScope: 0 },
  fieldCount: 0, matched: null, filledCount: 0, unfilledCount: 0, unconfirmedCount: 0, unsyncedCount: 0, requested: false,
  probe: { frames: { total: 2, crossOrigin: 2, frameInputs: 0 }, custom: { total: 0, byLibrary: {} },
    editButtons: 0, locked: 3, shadowHosts: 1, elements: 830 },
  category: "iframe_blocked", stage: "scan",
  diagnostics: null,
  unfilledControls: []
};

test("the v1 block answers why a page had no fields, section by section", () => {
  assert.equal(core.fillReport(IFRAME_PAGE), [
    "[页面]",
    "url_path: /:id/apply/:id",
    "page_type: application_form",
    "page_type_reason: url",
    "dom_ready_at_scan: true",
    "scan_duration_ms: 12",
    "",
    "[字段漏斗]",
    "dom_inputs: 14",
    "visible_fields: 0",
    "candidates: 0",
    "matched: -",
    "filled: 0",
    "drop_reasons: type_hidden=3,non_fillable=1,disabled=2,invisible=8",
    "label_sources: -",
    "offer_skipped: -",
    "",
    "[页面结构]",
    "dom_elements: 830",
    "iframes_total: 2",
    "iframes_cross_origin: 2",
    "same_origin_iframe_inputs: 0",
    "shadow_roots_with_inputs: 1",
    "custom_controls: 0",
    "custom_libraries: -",
    "readonly_or_disabled: 3",
    "edit_buttons: 0",
    "",
    "[错误]",
    "error_category: iframe_blocked",
    "first_failing_stage: scan",
    "error_code: -",
    "",
    "[匹配]",
    "local_matches: -",
    "ai_fields: -",
    "ai_called: false",
    "ai_matches: -",
    "ai_latency_ms: -",
    "resume_fields: -",
    "resume_candidates: -",
    "prompt_bytes: -",
    "",
    "[性能]",
    "timings_ms: scan=12,match=-,fill=-,total=15"
  ].join("\n"));
});

test("match and fill drops are counted separately, and ai_called tells 'not called' from 'called without result'", () => {
  const report = core.fillReport({
    ...IFRAME_PAGE, category: "fill_rejected", stage: "fill", requested: true,
    stats: { domInputs: 9, visible: 8, typeHidden: 1, nonFillable: 0, disabled: 0, invisible: 0, grouped: 2, outOfScope: 0 },
    fieldCount: 6, matched: 3, filledCount: 1, unfilledCount: 2, roundTripMs: 2300.6, fillMs: 410, totalMs: 2730,
    diagnostics: { ruleMatches: 2, aiFields: 4, aiMatches: 1, apiMs: 2100.2, promptBytes: 812, resumeFields: 20,
      candidateFields: 5, secretFormFields: 1, skippedNoContext: 1, errorCode: "none" },
    probe: { ...IFRAME_PAGE.probe, custom: { total: 3, byLibrary: { antd: 2, 其他: 1 } } },
    unfilledControls: [
      { label: "姓名", reasonCode: "value_reverted", control: { tag: "input", type: "text", role: "textbox", readOnly: true, library: "antd" } },
      { label: "张三的学校", reasonCode: "", control: { tag: "select", type: "" } }
    ]
  });
  assert.match(report, /^drop_reasons: type_hidden=1,grouped=2,secret=1,no_resume_mapping=1,ai_unmatched=1,not_written=2$/m);
  assert.match(report, /^ai_called: true$/m);
  assert.match(report, /^ai_latency_ms: 2100$/m);
  assert.match(report, /^custom_libraries: antd=2,other=1$/m);
  assert.match(report, /^timings_ms: scan=12,match=2301,fill=410,total=2730$/m);
  assert.match(report, /^\[未填字段\]\n- 姓名: input\[text\] role=textbox readonly lib=antd reason=value_reverted\n- （字段名已隐藏）: select$/m);
  assert.ok(!report.includes("张三"));

  const notCalled = core.fillReport({ ...IFRAME_PAGE, requested: true,
    diagnostics: { ruleMatches: 6, aiFields: 0, aiMatches: 0, apiMs: 0, promptBytes: 0, errorCode: "none" } });
  assert.match(notCalled, /^ai_called: false$/m);
  assert.match(notCalled, /^ai_latency_ms: -$/m);
  // 请求发出去了但没收到回复（例如通道断开）：不知道 AI 有没有被调用。
  assert.match(core.fillReport({ ...IFRAME_PAGE, requested: true }), /^ai_called: -$/m);
});

const V1_KEYS = ["url_path", "page_type", "page_type_reason", "dom_ready_at_scan", "scan_duration_ms",
  "dom_inputs", "visible_fields", "candidates", "matched", "filled", "drop_reasons", "label_sources", "offer_skipped",
  "dom_elements", "iframes_total", "iframes_cross_origin", "same_origin_iframe_inputs", "shadow_roots_with_inputs",
  "custom_controls", "custom_libraries", "readonly_or_disabled", "edit_buttons",
  "error_category", "first_failing_stage", "error_code",
  "local_matches", "ai_fields", "ai_called", "ai_matches", "ai_latency_ms", "resume_fields", "resume_candidates", "prompt_bytes",
  "timings_ms"];

test("fields the AI never saw are not counted as AI misses", () => {
  const base = { ...IFRAME_PAGE, fieldCount: 3, matched: 0, requested: true, stats: null };
  assert.deepEqual(core.fillDrops({ ...base, diagnostics: { errorCode: "no_resume_fields", secretFormFields: 0 } }),
    [["no_resume_mapping", 3]]);
  assert.deepEqual(core.fillDrops({ ...base, diagnostics: { errorCode: "input_too_large", ruleMatches: 1, aiFields: 2,
    promptBytes: 0, aiMatches: 0, skippedNoContext: 0 } }), [["not_sent", 2]]);
  assert.deepEqual(core.fillDrops({ ...base, diagnostics: { errorCode: "none", ruleMatches: 1, aiFields: 2,
    promptBytes: 200, aiMatches: 1, skippedNoContext: 0 } }), [["ai_unmatched", 1]]);
  // AI 或桌面服务出错：送出去的字段没拿到结果，不算 AI 没匹配上。
  assert.deepEqual(core.fillDrops({ ...base, diagnostics: { errorCode: "unavailable", ruleMatches: 0, aiFields: 3,
    promptBytes: 300, aiMatches: 0, skippedNoContext: 0 } }), [["no_result", 3]]);
  assert.deepEqual(core.fillDrops({ ...base, diagnostics: { errorCode: "http_502", ruleMatches: 1, aiFields: 2,
    promptBytes: 300, aiMatches: 0, skippedNoContext: 0 } }), [["no_result", 2]]);
  // 请求发出去了但没收到回复：字段不能从漏斗里消失。
  assert.deepEqual(core.fillDrops({ ...base, diagnostics: {} }), [["no_result", 3]]);
  assert.deepEqual(core.fillDrops({ ...base, requested: false, diagnostics: {} }), []);
  // 只有一部分字段送了 AI：AI 未匹配的数量以 aiFields 为上限，其余算没送 AI。
  assert.deepEqual(core.fillDrops({ ...base, diagnostics: { errorCode: "none", ruleMatches: 0, aiFields: 1,
    promptBytes: 50, aiMatches: 0, skippedNoContext: 0 } }), [["ai_unmatched", 1], ["not_sent", 2]]);
});

test("the longest valid lines still pass the allowlist instead of being dropped whole", () => {
  const big = 999999;
  const report = core.fillReport({ ...IFRAME_PAGE,
    path: "/campus/application/personalInformation/education/experience/attachment/preview/confirm/submit",
    stats: { domInputs: big, visible: big, typeHidden: big, nonFillable: big, disabled: big, invisible: big, grouped: big, outOfScope: big,
      popup: big, pageChrome: big, siteSearch: big, outsideForm: big, noLabel: big,
      sources: { explicit: big, item: big, table: big, sibling: big, placeholder: big }, offerSkipped: { ambiguous: big, entry: big } },
    fieldCount: big, matched: big, filledCount: big, unfilledCount: big, unconfirmedCount: big, unsyncedCount: big, requested: true,
    diagnostics: { ruleMatches: 1, aiFields: big, aiMatches: 1, promptBytes: 10, apiMs: 1, secretFormFields: 1, skippedNoContext: 1, errorCode: "none" },
    probe: { ...IFRAME_PAGE.probe, custom: { total: big, byLibrary: Object.fromEntries(
      ["antd", "element", "arco", "iview", "semi", "vant", "layui", "mui", "其他"].map(name => [name, big])) } } });
  const drops = /^drop_reasons: (.*)$/m.exec(report);
  assert.ok(drops && drops[1].split(",").length === 17, report);
  assert.match(report, /^label_sources: (?:[a-z]+=999999,){4}placeholder=999999$/m);
  assert.match(report, /^offer_skipped: ambiguous=999999,entry=999999$/m);
  assert.match(report, /^custom_libraries: (?:[a-z]+=999999,){8}other=999999$/m);
  assert.match(report, /^url_path: \/campus\/application\/personalInformation\/education\/experience\/attachment\/preview\/confirm\/:more$/m);
});

test("every v1 key survives the allowlist, including when the probe and scan stats are missing", () => {
  for (const input of [IFRAME_PAGE, { ...IFRAME_PAGE, pageType: null, probe: null, stats: null, readyAtScan: null, path: undefined }]) {
    const report = core.fillReport(input);
    assert.equal(core.diagnostics(report), report);
    for (const key of V1_KEYS) assert.match(report, new RegExp(`^${key}: `, "m"), key);
  }
});

test("the allowlist drops unknown keys, free text, spoofed origin lines and the old Chinese lines", () => {
  const forged = [
    "[来源]", "host: evil.example", "app_version: 9.9.9",
    "[页面]", "url_path: /apply/zhangsan@example.com", "url_path: /u/zhangsan", "url_path: /apply/:id",
    "page_title: 张三的简历", "page_type: application_form",
    "[错误]", "error_category: no_fields_found", "error_category: 张三", "error_code: sk-secret",
    "console_errors: [\"Uncaught TypeError: token=abc\"]",
    "dom_inputs: 14", "dom_inputs: 13800138000",
    "drop_reasons: hidden=3", "drop_reasons: type_hidden=3,secret=1",
    "[未填字段]", "- 张三: input[text] data-x=13800138000", "- 姓名: input[text] onclick=steal()",
    "网页字段：5；成功填写：2；没填上：1"
  ].join("\n");
  const out = core.diagnostics(forged);
  assert.equal(out, [
    "[页面]", "url_path: /apply/:id", "page_type: application_form",
    "", "[错误]", "error_category: no_fields_found", "dom_inputs: 14", "drop_reasons: type_hidden=3,secret=1",
    "", "[未填字段]", "- （字段名已隐藏）: input[text]", "- 姓名: input[text]"
  ].join("\n"));
});
