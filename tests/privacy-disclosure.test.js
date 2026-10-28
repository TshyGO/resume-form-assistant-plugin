// #301：报告里能出现的每一项都要写在隐私政策「错误报告与手动反馈」那一节里，告知也要提到这次新增的内容。
// 新加一个诊断键而没有在这里指到政策里的说法，这个测试就失败：要么补政策，要么补这张表。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../feedback-core.js");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const policy = read("docs/privacy-policy.md");
const section = policy.slice(policy.indexOf("## 错误报告与手动反馈"), policy.indexOf("## 可选手动云备份与恢复"));

// Each key the page may put into a report, and the words the policy uses for it.
const KEYS = {
  url_path: "网址路径", page_type: "是否判断为网申填写页", page_type_reason: "判断依据", dom_ready_at_scan: "扫描时页面是否已加载完",
  scan_duration_ms: "扫描耗时", entry: "这次从哪里开始", page_focused: "开始时网页是否在前台",
  dom_inputs: "页面上的输入框", visible_fields: "可见可填", candidates: "进入匹配", matched: "匹配到", filled: "填上的数量",
  drop_reasons: "各步丢掉的数量和原因", label_sources: "字段名的取法", offer_skipped: "「加到我的信息」没问的数量",
  dom_elements: "页面元素总数", iframes_total: "内嵌框架", iframes_cross_origin: "其中跨域的数量", same_origin_iframe_inputs: "同源框架里的输入框",
  shadow_roots_with_inputs: "含输入框的 Shadow DOM", custom_controls: "自定义控件", custom_libraries: "组件库",
  readonly_or_disabled: "只读或禁用输入框", edit_buttons: "「编辑」按钮",
  error_category: "错误类别", first_failing_stage: "失败阶段", error_code: "错误码",
  local_matches: "本地和 AI 各匹配了几个", ai_fields: "送 AI 的字段数", ai_called: "是否调用了 AI", ai_tier: "所用模型档位",
  ai_matches: "本地和 AI 各匹配了几个", ai_latency_ms: "AI 耗时", resume_fields: "简历字段", resume_candidates: "候选字段",
  prompt_bytes: "提示词字节数", timings_ms: "各阶段耗时", unlisted: "其余只计数",
  job_company_source: "公司和岗位名分别从哪里读到", job_title_source: "公司和岗位名分别从哪里读到", job_missing: "还缺哪一项",
  job_ai_called: "是否调用了 AI 识别", job_ai_code: "结果码", job_end: "这次保存怎样结束"
};
const SECTIONS = { 页面: "- 页面：", 填写: "- 填写方式：", 字段漏斗: "- 字段计数：", 页面结构: "- 页面结构：", 错误: "错误类别、失败阶段和错误码",
  匹配: "- 匹配：", 性能: "- 各阶段耗时", 未填字段: "- 没填上的字段", 岗位: "岗位流程的固定代码" };
// [未填字段] tokens: control structure, the reason code, the popup and whether it had any option.
const TOKENS = { tag: "标签名", type: "类型", role: "role", popup: "控件结构", readonly: "控件结构", picker: "控件结构", lib: "组件库",
  reason: "失败原因码", opened: "弹层有没有出现", options: "里面有没有选项（不含选项个数" };
// The worker's [来源] lines.
const SOURCE = { app_version: "版本", os: "系统", install: "安装方式", host: "域名" };

test("every diagnostic key and section is named in the privacy policy", () => {
  assert.notEqual(section.length, 0);
  assert.deepEqual(Object.keys(KEYS).sort(), [...core.VALUE_KEYS].sort(), "a key was added or removed: map it to the policy's words");
  assert.deepEqual(Object.keys(SECTIONS).sort(), [...core.SECTION_NAMES].sort());
  for (const [key, words] of Object.entries({ ...KEYS, ...SECTIONS, ...TOKENS, ...SOURCE })) {
    assert.ok(section.includes(words), `${key}: the policy does not say 「${words}」`);
  }
});

test("the worker's [来源] lines and the unfilled-control tokens are the ones listed above", async () => {
  const { createFeedback } = await import("../link/feedback.mjs");
  const data = {};
  const worker = createFeedback({ storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    version: "0.4.5", os: "Windows / Chrome 140", install: () => "normal", fetchImpl: async () => new Response("{}") });
  await worker.ready();
  const text = worker.preview({ description: "" }, "jobs.example.test").user_description;
  const source = text.slice(text.indexOf("[来源]") + 5).trim().split("\n").map(line => line.split(":")[0]);
  assert.deepEqual(source, Object.keys(SOURCE));
  const report = core.fillReport({ fieldCount: 1, unfilledControls: [{ label: "学历", reasonCode: "no_option_match", observed: { opened: "listbox", hasOptions: true },
    control: { tag: "input", type: "text", role: "combobox", readOnly: true, picker: "antd", library: "antd", popup: "listbox" } }] });
  const tokens = report.split("\n").find(line => line.startsWith("- 学历: ")).slice(7).split(" ")
    .map(token => /^[a-z]+\[/.test(token) ? ["tag", "type"] : token.split("=")[0]).flat();
  assert.deepEqual([...new Set(tokens)].sort(), Object.keys(TOKENS).sort());
  // Every keyed token CONTROL_TOKEN accepts (role=, lib=, opened=...), read from its source, so a
  // token that only some other input produces is caught too.
  const definition = read("feedback-core.js").match(/const CONTROL_TOKEN = new RegExp\(([\s\S]*?)\);\r?\n/)[1];
  const keyed = [...definition.matchAll(/(?:\(\?:([a-z|]+)\)|\b([a-z]+))=/g)].flatMap(match => (match[1] || match[2]).split("|"));
  assert.ok(keyed.includes("opened") && keyed.includes("lib"), keyed.join());
  assert.deepEqual([...new Set(keyed)].sort(), Object.keys(TOKENS).filter(key => !["tag", "type", "readonly"].includes(key)).sort());
});

test("the notice names what reports now carry, and when they are sent", () => {
  const ui = read("feedback-ui.js");
  const notice = ui.slice(ui.indexOf("const explanation"), ui.indexOf("if (compact && noticeRoot)"));
  for (const words of ["AI 请求失败", "安装方式", "从哪里开始填写", "网页当时是否在前台", "有没有弹出、里面有没有选项", "模型档位",
    "保存岗位的过程", "不含公司和岗位名"]) {
    assert.ok(notice.includes(words), words);
  }
  // Whether a list had options, never how many (#301): neither text speaks of a number of options.
  for (const [name, text] of [["notice", notice], ["policy", section]]) {
    assert.doesNotMatch(text, /几个选项|选项的?数量|项数/, name);
  }
  // The policy says the same about when a report is sent and that the user is asked again.
  for (const words of ["AI 请求失败", "即使匹配到的字段都填上了也会上报", "报告内容增加时，之前的同意同样不算数，会重新询问"]) {
    assert.ok(section.includes(words), words);
  }
});
