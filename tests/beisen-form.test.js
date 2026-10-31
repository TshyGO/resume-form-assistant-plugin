// #301 北森 2022 版网申表单（*.zhiye.com）上的整条一键填写：0.4.4 在这类页面上报了「页面仍提示无效」
// （validation_not_cleared）、「等待选项更新超时」（options_timeout）和「选项存在歧义」（ambiguous_option）。
// 页面结构见 helpers/beisen-form.js。按 manifest 的顺序在 jsdom 里加载全部 content script，AI 用按题目名回答的替身。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { ETHNIC, textItem, wireForm, selectItem, wireSelect } = require("./helpers/beisen-form.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
const DEGREE = ["博士研究生", "硕士研究生", "本科及以上", "大专及以上", "本科", "大专", "高中", "初中"];

// jsdom 不排版：元素的位置取自己或最近的祖先上的 data-rect，没有就给一个默认的框；隐藏的元素没有框。
function layout(w) {
  const rectOf = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const css = w.getComputedStyle(node);
      if (node.hidden || node.getAttribute("aria-hidden") === "true" || css.display === "none" || css.visibility === "hidden") return null;
    }
    const spec = el.closest("[data-rect]")?.getAttribute("data-rect");
    const [top, left, width, height] = spec ? spec.split(",").map(Number) : [10, 10, 300, 30];
    return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; } };
  };
  const empty = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return this; } };
  w.Element.prototype.getBoundingClientRect = function () { return rectOf(this) || empty; };
  w.Element.prototype.getClientRects = function () { const rect = rectOf(this); return rect ? [rect] : []; };
  w.Element.prototype.scrollIntoView = function () {};
  for (const side of ["Width", "Height"]) {
    Object.defineProperty(w.HTMLElement.prototype, `offset${side}`, { configurable: true,
      get() { return rectOf(this)?.[side.toLowerCase()] || 0; } });
  }
}

// resume：[[题目, 值]]，模板里的项和 AI 替身的回答都按它来。测试结束时关掉窗口，停下页面上的定时器。
function page(t, body, resume) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://demo.zhiye.example/form" });
  const w = dom.window;
  t.after(() => w.close());
  layout(w);
  // 不自动插入侧栏：只测填写流程。
  Object.defineProperty(w.document, "readyState", { get: () => "loading", configurable: true });
  const listen = w.document.addEventListener.bind(w.document);
  w.document.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  w.confirm = () => true;
  const answers = Object.fromEntries(resume);
  const template = { id: "t", name: "虚构模板", groups: [{ name: "基本信息", fields: resume.map(([key, value]) => ({ key, value })) }] };
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: resume.length }], activeTemplate: template,
    profile: { values: {}, family: [], custom: [] }, profileRevision: 0 };
  const fill = (message) => {
    const matches = message.formFields.filter((field) => answers[field.label] !== undefined)
      .map((field) => ({ fieldId: field.fieldId, value: answers[field.label] }));
    return { success: true, matches, diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: matches.length, errorCode: "none" } };
  };
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.4.4" }),
      onMessage: { addListener() {} },
      sendMessage: async (message) => message.type === "DESKTOP_RESUME_READ" ? { status: "ok", data }
        : ["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type) ? { ready: true }
        : message.type === "AI_FILL" ? fill(message) : {} },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} } }
  };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    fill: { disabled: false, textContent: "" } };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": { hidden: true, open: false },
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-ai-fill": ui.fill };
  const helpers = w.ResumeProHighlightTest;
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  return { doc: w.document, ui, run: () => helpers.handleAiFillClick({ currentTarget: ui.fill }) };
}

test("Beisen start/end pair: a start time marked invalid until the end time is filled counts as filled", async (t) => {
  // 页面上已有旧的结束时间 2019/06：先填开始时间 2019/09，页面在开始时间上标错；填完结束时间 2022/06，两边的提示都清掉。
  const p = page(t, textItem("start", "开始时间", 100) + textItem("end", "结束时间", 200, { value: "2019/06" }),
    [["开始时间", "2019/09"], ["结束时间", "2022/06"]]);
  const form = wireForm(p.doc, { start: { required: true }, end: { required: true } }, { linkage: [["start", "end"]] });
  const result = await p.run();
  assert.ok(form.shown.includes("start:开始时间必须早于结束时间"), JSON.stringify(form.shown));
  assert.deepEqual([form.input("start").value, form.errorOf("start"), form.input("end").value, form.errorOf("end")], ["2019/09", "", "2022/06", ""]);
  assert.equal(result.filledCount, 2, p.ui.diag.value);
  assert.equal(result.unfilledCount, 0);
  assert.equal(p.ui.status.textContent, "已填写 2 个字段。");
});

test("Beisen phone: a number the page's own rule keeps rejecting is still 页面仍提示无效, and is left as written", async (t) => {
  const p = page(t, textItem("phone", "手机号码", 100), [["手机号码", "+86 13800138000"]]);
  const form = wireForm(p.doc, { phone: { required: true, pattern: "^1[3456789]\\d{9}$", message: "请输入11位手机号" } });
  const result = await p.run();
  assert.equal(form.input("phone").value, "+86 13800138000");
  assert.equal(form.errorOf("phone"), "请输入11位手机号");
  assert.equal(result.filledCount, 0);
  assert.equal(result.unfilledCount, 1);
  assert.equal(p.ui.status.textContent, "已填写 0 个字段。1 项没填上：手机号码（页面仍提示无效），请手动补上。");
  assert.match(p.ui.diag.value, /手机号码：input\[text\]｜页面仍提示无效/);
});

// 常量选择器题目只有一道：填 value，返回填写结果和弹层里点过、搜过的。
async function choose(t, label, value, options, selected = "") {
  const p = page(t, selectItem("f1", label, 100, { selected }), [[label, value]]);
  const select = wireSelect(p.doc, "f1", options);
  const result = await p.run();
  return { result, diag: p.ui.diag.value, ...select };
}

test("Beisen constant selector opened before its dictionary has loaded: the option is picked once the list arrives", async (t) => {
  // 字典第一次点开时才拉：左侧只有加载图标，右侧「已选」栏已经画出来。原来报「等待选项更新超时」。
  const run = await choose(t, "民族", "回族", { choices: ETHNIC, loadMs: 600 });
  assert.equal(run.shown(), "回族", run.diag);
  assert.deepEqual(run.events, ["radio:回族", "ok"]);
  assert.deepEqual(run.searches, []);
  assert.equal(run.result.filledCount, 1);
});

test("Beisen constant selector still loading: a value below the first screen is searched for once the list is there", async (t) => {
  const run = await choose(t, "民族", "土家族", { choices: ETHNIC, loadMs: 600 });
  assert.equal(run.shown(), "土家族", run.diag);
  // #429 搜的是「土家族」「土家」两种写法共有的「土家」（ai-helpers.js 的 optionSearchText）。
  assert.deepEqual(run.searches, ["土家"]);
  assert.equal(run.result.filledCount, 1);
});

test("Beisen constant selector still loading, with the current choice listed in the 已选 pane: the new value is picked", async (t) => {
  const run = await choose(t, "民族", "回族", { choices: ETHNIC, loadMs: 600 }, "汉族");
  assert.equal(run.shown(), "回族", run.diag);
  assert.deepEqual(run.events, ["radio:回族", "ok"]);
  assert.equal(run.result.filledCount, 1);
});

test("Beisen school name searched on the server, opened before its dictionary has loaded: the school is picked", async (t) => {
  // #301 kotei.zhiye.com：学校名称是两级字典，搜索交给后台。原来结果回来之前就报「没有匹配的选项」；
  // 结果回来后又点了文字、没点单选圈，报「选项选择未提交」。
  const run = await choose(t, "学校名称", "示例大学", { tree: { 北京市: ["北京示例学院", "首都示例大学"], 湖北省: ["示例大学", "江汉示例学院"] },
    loadMs: 600, searchMs: 300 });
  assert.equal(run.shown(), "示例大学", run.diag);
  assert.deepEqual(run.events, ["radio:示例大学", "ok"]);
  assert.deepEqual(run.searches, ["示例大学"]);
  assert.equal(run.result.filledCount, 1);
});

test("textless elements named lazyloading or loading-done are not a loading list, so the search still finishes", async (t) => {
  // 加载图标只认类名以 loading 结尾、不带文字的（psd_page-loading）。一直留在弹层里的懒加载图片、
  // 「加载完成」标记当成加载中，搜索后就一直等不到列表好。
  const run = await choose(t, "民族", "土家族", { choices: ETHNIC, extra: `<img class="avatar lazyloading" alt=""><span class="loading-done"></span>` });
  assert.equal(run.shown(), "土家族", run.diag);
  assert.deepEqual(run.searches, ["土家"]);
  assert.equal(run.result.filledCount, 1);
});

test("a loading icon faded out with opacity 0 but still mounted is not a loading list, so the search still finishes", async (t) => {
  const extra = `<div class="list-loading" style="opacity:0"><i class="spin"></i></div>`
    + `<div style="opacity:0"><span class="mask-loading"></span></div>`;
  const run = await choose(t, "民族", "土家族", { choices: ETHNIC, extra });
  assert.equal(run.shown(), "土家族", run.diag);
  assert.deepEqual(run.searches, ["土家"]);
  assert.equal(run.result.filledCount, 1);
});

test("Beisen search results split by the highlight are read as whole options, so 大专 is not ambiguous", async (t) => {
  // react-highlight-words：「大专及以上」成了 <mark>大专</mark><span>及以上</span>，原来多读出一个「大专」，报选项存在歧义。
  const run = await choose(t, "最高学历", "大专", { choices: DEGREE, rows: 3 });
  assert.equal(run.shown(), "大专", run.diag);
  assert.deepEqual(run.events, ["radio:大专", "ok"]);
  assert.deepEqual(run.searches, ["大专"]);
  assert.equal(run.result.filledCount, 1);
});

for (const [label, choices, value, option] of [["最高学历", ["博士研究生", "硕士研究生", "本科", "大专", "高中"], "大学本科", "本科"],
  ["政治面貌", ["党员", "预备党员", "共青团员", "群众"], "中共党员", "党员"]]) {
  test(`a resume value longer than the option (${value}) still picks ${option} without searching`, async (t) => {
    const run = await choose(t, label, value, { choices });
    assert.equal(run.shown(), option, run.diag);
    assert.deepEqual(run.searches, []);
    assert.equal(run.result.filledCount, 1);
  });
}
