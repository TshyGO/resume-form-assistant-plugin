// #400：顶层是导航壳、表单在同源 iframe 里（人事考试网、标签页式后台）。一键填写进看得见、够大的同源框架扫描和填写，
// 写入、核对、高亮、提交同步和焦点跟踪在框架元素上都要能用；扫不出字段时提示表单在内嵌框架里，不再说先点「编辑」。
// 夹具都是合成的，不含任何个人资料。
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const probeApi = require("../fill-probe.js");
const core = require("../feedback-core.js");
const deep = require("../deep-analysis.js");
const { openFramedPage, installLayout, formState, FORM, FILLED, EMPTY_FORM, EXTENSION_ID } = require("./helpers/frame-page.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 人事考试网那样：顶层 38 个输入框都藏着，还有两个「编辑」。
const SHELL = `<nav><a>首页</a><a>报名</a><a>编辑</a><a>编辑</a></nav><div style="display:none">${"<input>".repeat(38)}</div>`;
const lines = (text) => String(text || "").split("\n");

// --- 哪些框架会被扫描 ----------------------------------------------------------

async function framePage(body, contents = {}) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url: "https://hr.example.test/admin/index" });
  const win = dom.window;
  installLayout(win);
  await wait(5);
  for (const [id, html] of Object.entries(contents)) {
    const doc = win.document.getElementById(id).contentDocument;
    installLayout(doc.defaultView);
    doc.body.innerHTML = html;
    await wait(5);
  }
  const isVisible = (el) => {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  return { win, doc: win.document, isVisible, ids: (found) => found.map((entry) => entry.frame.id) };
}

test("only visible, large enough same-origin frames in reach of the viewport are entered", async () => {
  const page = await framePage(`
    <iframe id="shown"></iframe>
    <div style="display:none"><iframe id="tab-hidden"></iframe></div>
    <iframe id="attr-hidden" hidden></iframe>
    <iframe id="zero" data-w="0" data-h="0"></iframe>
    <iframe id="narrow" data-w="99" data-h="300"></iframe>
    <iframe id="short" data-w="300" data-h="49"></iframe>
    <iframe id="parked-left" data-left="-9999"></iframe>
    <iframe id="parked-right" data-left="5000"></iframe>
    <iframe id="above" data-top="-9999"></iframe>
    <iframe id="below-fold" data-top="2000"></iframe>
    <iframe id="cross"></iframe>`);
  Object.defineProperty(page.doc.getElementById("cross"), "contentDocument", { get: () => null });
  const found = scanner.frameDocuments(page.doc, { isVisible: page.isVisible });
  assert.deepEqual(page.ids(found), ["shown", "below-fold"]);
  assert.ok(found.every((entry) => entry.depth === 1 && entry.doc === entry.frame.contentDocument));
});

test("frames are entered two levels deep, not three, and a frame that throws on access is skipped", async () => {
  const page = await framePage(`<iframe id="a"></iframe><iframe id="blocked"></iframe>`);
  Object.defineProperty(page.doc.getElementById("blocked"), "contentDocument", { get() { throw new Error("SecurityError"); } });
  const a = page.doc.getElementById("a").contentDocument;
  installLayout(a.defaultView);
  a.body.innerHTML = `<iframe id="b"></iframe>`;
  await wait(5);
  const b = a.getElementById("b").contentDocument;
  installLayout(b.defaultView);
  b.body.innerHTML = `<iframe id="c"></iframe>`;
  await wait(5);
  const found = scanner.frameDocuments(page.doc, { isVisible: page.isVisible });
  assert.deepEqual(found.map((entry) => [entry.frame.id, entry.depth]), [["a", 1], ["b", 2]]);
  // parent 是装着这个框架的文档：一键填写只在外层扫不到字段时才进它里面的框架。
  assert.deepEqual(found.map((entry) => entry.parent), [page.doc, a]);
  assert.deepEqual(page.ids(scanner.frameDocuments(page.doc, { isVisible: page.isVisible, exclude: (el) => el.id === "a" })), []);
});

// --- 页面线索和提示 ------------------------------------------------------------

test("the probe counts inputs in same-origin frames one level further down too", async () => {
  const page = await framePage(`<iframe id="form"></iframe><div style="display:none"><iframe id="hidden-tab"></iframe></div><iframe id="shell"></iframe>`, {
    form: `<input><input type="submit"><input type="file"><div style="display:none"><input></div>`,
    "hidden-tab": "<input><input>",
    shell: `<iframe id="inner"></iframe>`
  });
  const inner = page.doc.getElementById("shell").contentDocument.getElementById("inner").contentDocument;
  installLayout(inner.defaultView);
  inner.body.innerHTML = "<textarea></textarea><select></select>";
  const frames = probeApi.probePage(page.doc, { href: "https://hr.example.test/admin" }).frames;
  // 隐藏页签里的框架没有尺寸，不算；第二层框架里的输入框算进来。
  assert.deepEqual(frames, { total: 3, crossOrigin: 0, frameInputs: 6 });
});

test("when the fill read a frame and could not title a form's worth of its inputs, the empty-page hint names the frame, not the 编辑 button", () => {
  const EMPTY = { host: "", frames: { total: 0, crossOrigin: 0, frameInputs: 0 },
    custom: { total: 0, byLibrary: {} }, editButtons: 0, locked: 0, shadowHosts: 0 };
  const framed = { ...EMPTY, editButtons: 2, frames: { total: 1, crossOrigin: 0, frameInputs: 58 } };
  assert.equal(probeApi.emptyPageHint(framed, { form: true, deepAvailable: true, frameUntitled: 20 }),
    "表单在网页的内嵌框架里，一键填写没认出字段。可以试试下方的「深度分析本页」。");
  assert.equal(probeApi.emptyPageHint(framed, { form: true, frameUntitled: 3 }), "表单在网页的内嵌框架里，一键填写没认出字段。可以把侧栏的「填写诊断」复制给我们。");
  // 框架里只有一两个认不出的框（搜索框、客服输入框），或者没有一键填写的扫描结果（深度分析的空结果提示）：还是先说「编辑」。
  assert.match(probeApi.emptyPageHint(framed, { form: true, frameUntitled: 2 }), /先点网页上的「编辑」/);
  assert.match(probeApi.emptyPageHint(framed), /先点网页上的「编辑」/);
});

test("zero fields with inputs in a same-origin frame and with only a cross-origin frame are told apart", () => {
  const empty = { scanned: true, fieldCount: 0, pageType: "application_form" };
  assert.deepEqual(core.fillCategory({ ...empty, frames: { crossOrigin: 0, frameInputs: 58 } }), { category: "iframe_same_origin", stage: "scan" });
  assert.deepEqual(core.fillCategory({ ...empty, frames: { crossOrigin: 1, frameInputs: 0 } }), { category: "iframe_cross_origin", stage: "scan" });
  assert.deepEqual(core.fillCategory({ ...empty, frames: { crossOrigin: 2, frameInputs: 4 } }), { category: "iframe_same_origin", stage: "scan" });
  for (const category of ["iframe_same_origin", "iframe_cross_origin"]) {
    assert.equal(core.diagnostics(`[错误]\nerror_category: ${category}`), `[错误]\nerror_category: ${category}`);
  }
  assert.equal(core.diagnostics("[错误]\nerror_category: iframe_blocked"), "[错误]");
});

test("a form the fill already read from a frame no longer pushes 深度分析本页", () => {
  const probe = { frames: { total: 1, crossOrigin: 0, frameInputs: 7 }, custom: { total: 0 }, shadowHosts: 0, editButtons: 0 };
  const summary = { fieldCount: 6, unfilledCount: 0, unconfirmedCount: 0, probe, diagnostics: { errorCode: "none" } };
  assert.equal(deep.offerLevel({ ...summary, stats: { frameFields: 6 } }), "secondary");
  assert.equal(deep.offerLevel({ ...summary, stats: { frameFields: 0 } }), "prominent");
});

// --- 一键填写 ------------------------------------------------------------------

test("#400 shell page: the form in the visible frame is scanned and filled, the hidden second frame is left alone", async () => {
  const page = await openFramedPage({ top: `${SHELL}<iframe id="main"></iframe><div style="display:none"><iframe id="other"></iframe></div>`,
    frames: { main: FORM, other: FORM } });
  const result = await page.fill();
  assert.equal(result.outcome, "success", result.error);
  assert.equal(result.filledCount, 6);
  assert.deepEqual(formState(page.frame("main")), FILLED);
  assert.deepEqual(formState(page.frame("other")), EMPTY_FORM);
  // 字段编号带框架序号；下拉和单选的选项照常交给匹配。
  // 发给匹配的请求是网页里的对象：按 JSON 复制一份再比较。
  const sent = JSON.parse(JSON.stringify(page.aiRequests[0].formFields));
  assert.deepEqual(sent.map((field) => field.fieldId), ["frame1-field-0", "frame1-field-1", "frame1-field-radio-2", "frame1-field-3", "frame1-field-4", "frame1-field-5"]);
  assert.deepEqual(sent.find((field) => field.label === "学历").options, ["请选择", "本科", "硕士"]);
  assert.deepEqual(sent.find((field) => field.label === "性别").options, ["男", "女"]);
  assert.equal(sent.find((field) => field.label === "出生日期").inputType, "date");
  // 诊断漏斗把框架里的输入框算进来：页面上 38 个看不见的 + 框架里 7 个。
  const status = await page.status();
  assert.equal(status.status, "已填写 6 个字段。");
  for (const line of ["dom_inputs: 45", "visible_fields: 7", "candidates: 6", "filled: 6", "drop_reasons: invisible=38,grouped=1",
    "same_origin_iframe_inputs: 7", "error_category: none"]) {
    assert.ok(lines(status.diagnosticsReport).includes(line), `${line}\n${status.diagnosticsReport}`);
  }
  assert.ok(lines(status.diagnostics).includes("同源框架：扫描 1 个，其中的字段 6 个"), status.diagnostics);
  assert.deepEqual(page.reports, []);
});

test("a form two frames down is filled; one three frames down is not entered", async () => {
  const two = await openFramedPage({ top: `<iframe id="outer"></iframe>`,
    frames: { outer: { html: `<nav><a>菜单</a></nav><iframe id="inner"></iframe>`, frames: { inner: FORM } } } });
  const result = await two.fill();
  assert.equal(result.filledCount, 6, result.error);
  assert.deepEqual(formState(two.frame("outer", "inner")), FILLED);
  assert.ok(two.aiRequests[0].formFields.every((field) => field.fieldId.startsWith("frame2-")));

  const three = await openFramedPage({ top: `<iframe id="a"></iframe>`,
    frames: { a: { html: `<iframe id="b"></iframe>`, frames: { b: { html: `<iframe id="c"></iframe>`, frames: { c: FORM } } } } } });
  const deeper = await three.fill();
  assert.equal(deeper.fieldCount, 0);
  assert.deepEqual(formState(three.frame("a", "b", "c")), EMPTY_FORM);
});

test("a tab-style admin page fills only the iframe of the tab on show", async () => {
  const page = await openFramedPage({ top: `<ul class="layui-tab-title"><li>首页</li><li class="layui-this">报名信息</li><li>附件</li></ul>
    <div class="layui-tab-content">
      <div class="layui-tab-item" style="display:none"><iframe id="t1"></iframe></div>
      <div class="layui-tab-item layui-show"><iframe id="t2"></iframe></div>
      <div class="layui-tab-item" style="display:none"><iframe id="t3"></iframe></div>
    </div><iframe id="parked" data-left="-9999"></iframe>`,
  frames: { t1: FORM, t2: FORM, t3: FORM, parked: FORM } });
  const result = await page.fill();
  assert.equal(result.filledCount, 6, result.error);
  assert.equal(page.aiRequests[0].formFields.length, 6);
  assert.deepEqual(formState(page.frame("t2")), FILLED);
  for (const id of ["t1", "t3", "parked"]) assert.deepEqual(formState(page.frame(id)), EMPTY_FORM, id);
});

test("a layui select inside a frame is opened and picked like on the top page", async () => {
  const LAYUI = `<style>select{display:none}.layui-form-select dl{display:none}.layui-form-selected dl{display:block}</style>
<form class="layui-form"><div class="layui-form-item"><label class="layui-form-label">姓名</label><div class="layui-input-block"><input type="text" name="name" class="layui-input"></div></div>
<div class="layui-form-item"><label class="layui-form-label">学历</label><div class="layui-input-block"><select name="edu"><option value="">请选择</option><option value="1">大专</option><option value="2">本科</option></select>
<div class="layui-unselect layui-form-select"><div class="layui-select-title"><input type="text" placeholder="请选择" value="" readonly class="layui-input layui-unselect"><i class="layui-edge"></i></div>
<dl class="layui-anim layui-anim-upbit"><dd lay-value="" class="layui-select-tips">请选择</dd><dd lay-value="1">大专</dd><dd lay-value="2">本科</dd></dl></div></div></div></form>`;
  const page = await openFramedPage({ top: `<iframe id="main"></iframe>`, frames: { main: LAYUI }, values: { 姓名: "测试用户", 学历: "本科" } });
  // 照 layui 2.3.0 form.js：点标题展开或收起，点别处收起，点选项写输入框和原生 select。
  const doc = page.frame("main");
  const root = doc.querySelector(".layui-form-select");
  const title = root.querySelector(".layui-select-title");
  const shown = title.querySelector("input");
  const select = doc.querySelector("select");
  title.addEventListener("click", () => root.classList.toggle("layui-form-selected"));
  doc.addEventListener("click", (event) => { if (!event.target.parentElement?.classList.contains("layui-select-title")) root.classList.remove("layui-form-selected"); });
  for (const dd of root.querySelectorAll("dd")) {
    dd.addEventListener("click", (event) => {
      shown.value = dd.classList.contains("layui-select-tips") ? "" : dd.textContent;
      select.value = dd.getAttribute("lay-value");
      root.classList.remove("layui-form-selected");
      event.stopPropagation();
    });
  }
  const result = await page.fill();
  assert.equal(result.filledCount, 2, result.error);
  assert.equal(shown.value, "本科");
  assert.equal(select.value, "2");
  assert.equal(doc.querySelector("input[name=name]").value, "测试用户");
});

test("a frame whose inputs the scan cannot title says the form is in a frame, not 先点「编辑」, and reports iframe_same_origin", async () => {
  const page = await openFramedPage({ top: `${SHELL}<iframe id="main"></iframe>`, frames: { main: "<div><input><input><textarea></textarea></div>" } });
  const result = await page.fill();
  assert.equal(result.fieldCount, 0);
  assert.equal(result.error, "没找到可填写的输入框。表单在网页的内嵌框架里，一键填写没认出字段。可以试试下方的「深度分析本页」。");
  assert.equal(page.reports.length, 1);
  for (const line of ["error_category: iframe_same_origin", "dom_inputs: 41", "visible_fields: 3", "drop_reasons: invisible=38,no_label=3"]) {
    assert.ok(lines(page.reports[0].diagnostics).includes(line), `${line}\n${page.reports[0].diagnostics}`);
  }
});

// 查看状态的页面（有「编辑」），旁边一个看得见的同源框架里只有站内搜索框：提示、结局和上报都和以前一样。
const SEARCH_FRAME = `<div class="header"><input type="search" placeholder="搜索职位、公司"><button>搜索</button></div>`;

test("a view-mode page still says 先点「编辑」 when a visible frame holds only a site search box", async () => {
  const page = await openFramedPage({ top: `<div class="resume"><h2>基本信息</h2><span class="btn">编辑</span><p>示例</p></div><iframe id="f"></iframe>`,
    frames: { f: SEARCH_FRAME } });
  const result = await page.fill();
  assert.equal(result.fieldCount, 0);
  assert.match(result.error, /^没找到可填写的输入框。这个页面可能还在查看状态：请先点网页上的「编辑」/);
  assert.equal(page.reports.length, 1);
  assert.ok(lines(page.reports[0].diagnostics).includes("error_category: iframe_same_origin"), page.reports[0].diagnostics);
});

test("a view-mode page still says 先点「编辑」 when the only field the fill found is in a small frame", async () => {
  const page = await openFramedPage({ top: `<div class="resume"><h2>基本信息</h2><span class="btn">编辑</span><p>示例</p></div><iframe id="f" data-w="320" data-h="200"></iframe>`,
    frames: { f: `<div class="row"><label for="ly">留言内容</label><textarea id="ly"></textarea></div>` } });
  const result = await page.fill();
  assert.equal(result.outcome, "failed");
  assert.match((await page.status()).status, /这个页面可能还在查看状态：请先点网页上的「编辑」/);
  assert.equal(page.frame("f").getElementById("ly").value, "");
});

test("a view-mode page with a field the resume cannot answer keeps 先点「编辑」, the failed outcome and its report next to a search frame", async () => {
  const page = await openFramedPage({ top: `<div class="resume"><h2>基本信息</h2><span class="btn">编辑</span>
      <div class="row"><label for="bz">备注说明</label><input id="bz"></div></div><iframe id="f"></iframe>`,
  frames: { f: SEARCH_FRAME } });
  const result = await page.fill();
  assert.equal(result.outcome, "failed");
  assert.deepEqual(Array.from(page.aiRequests[0].formFields, (field) => field.fieldId), ["field-0"]);
  assert.match((await page.status()).status, /^已填写 0 个字段。这个页面可能还在查看状态：请先点网页上的「编辑」/);
  assert.deepEqual(page.reports.map((report) => report.kind), ["fill_failed"]);
  for (const line of ["error_category: match_failed", "edit_buttons: 1"]) {
    assert.ok(lines(page.reports[0].diagnostics).includes(line), `${line}\n${page.reports[0].diagnostics}`);
  }
});

// 表单旁边挂着的同源留言框：表单在顶层时、表单本身在框架里时都不碰。
const MESSAGE_BOX = `<div class="kefu"><h3>在线留言</h3>
  <div class="row"><label for="ly-name">姓名</label><input id="ly-name"></div>
  <div class="row"><label for="ly-tel">手机号</label><input id="ly-tel" type="tel"></div>
  <div class="row"><label for="ly-msg">留言内容</label><textarea id="ly-msg"></textarea></div>
  <button type="button">提交留言</button></div>`;
const WITH_PHONE = { 姓名: "测试用户", 学历: "本科", 性别: "女", 出生日期: "1998-06-01", 个人简介: "喜欢写代码", 服从: "是", 手机号: "13800000000" };
const untouched = (doc) => ["ly-name", "ly-tel", "ly-msg"].every((id) => doc.getElementById(id).value === "");

test("a message box frame next to a top-page form is neither scanned nor filled", async () => {
  const top = await openFramedPage({ top: `${FORM}<iframe id="kf" data-w="320" data-h="400"></iframe>`, url: "https://jobs.example.test/campus/apply/1",
    frames: { kf: MESSAGE_BOX }, values: WITH_PHONE });
  const onTop = await top.fill();
  assert.equal(onTop.filledCount, 6, onTop.error);
  assert.deepEqual(Array.from(top.aiRequests[0].formFields, (field) => field.fieldId), ["field-0", "field-1", "field-radio-2", "field-3", "field-4", "field-5"]);
  assert.ok(untouched(top.frame("kf")));
  assert.ok(!(await top.status()).diagnostics.includes("同源框架："));
});

test("a message box frame inside the frame that holds the form is left alone too", async () => {
  const framed = await openFramedPage({ top: `<iframe id="main"></iframe>`,
    frames: { main: { html: `${FORM}<iframe id="kf" data-w="320" data-h="400"></iframe>`, frames: { kf: MESSAGE_BOX } } }, values: WITH_PHONE });
  const inFrame = await framed.fill();
  assert.equal(inFrame.filledCount, 6, inFrame.error);
  assert.ok(framed.aiRequests[0].formFields.every((field) => field.fieldId.startsWith("frame1-")));
  assert.deepEqual(formState(framed.frame("main")), FILLED);
  assert.ok(untouched(framed.frame("main", "kf")));
});

// 选完下拉、单选、复选后等页面安静：只等刚选的控件所在的文档。别的文档一直在变时，原来每个选择都要等满 1.5 秒
// （这里 3 个选择类控件，至少多等 4.5 秒）。
async function timedFill(page, tick) {
  const timer = tick.win.setInterval(() => tick.node().classList.toggle("on"), 100);
  try {
    const start = Date.now();
    const result = await page.fill();
    return { filled: result.filledCount, ms: Date.now() - start, error: result.error };
  } finally {
    tick.win.clearInterval(timer);
  }
}

test("a busy frame next to a top-page form does not hold up the wait after each choice", async () => {
  const top = await openFramedPage({ top: `${FORM}<iframe id="ticker" data-w="600" data-h="120"></iframe>`, url: "https://jobs.example.test/campus/apply/1",
    frames: { ticker: `<div id="slide">公告</div>` } });
  const busyFrame = await timedFill(top, { win: top.frame("ticker").defaultView, node: () => top.frame("ticker").getElementById("slide") });
  assert.equal(busyFrame.filled, 6, busyFrame.error);
  assert.ok(busyFrame.ms < 4000, `form on top, busy frame: ${busyFrame.ms}ms`);
});

test("a busy navigation shell does not hold up the wait after each choice in the frame's form", async () => {
  const shell = await openFramedPage({ top: `<div id="clock">10:00</div><iframe id="main"></iframe>`, frames: { main: FORM } });
  const busyShell = await timedFill(shell, { win: shell.win, node: () => shell.win.document.getElementById("clock") });
  assert.equal(busyShell.filled, 6, busyShell.error);
  assert.ok(busyShell.ms < 4000, `form in a frame, busy shell: ${busyShell.ms}ms`);
});

// 零字段等待（#301）：点了一键填写之后，装表单的框架才插进来、或第二层框架才换成表单页。框架加载完都要再扫一次。
// 页面上没有别的线索（没有「编辑」、框架里还没有输入框），网址像网申页，才会等。
async function fillWhileWaiting(page, during) {
  const button = { disabled: false, textContent: "" };
  const filling = page.hooks.handleAiFillClick({ currentTarget: button });
  for (let i = 0; i < 400 && button.textContent !== "正在等待网页加载..."; i += 1) await wait(5);
  assert.equal(button.textContent, "正在等待网页加载...");
  await during();
  return filling;
}

test("the zero-field wait rescans when a frame inserted after it began, at the top or inside a frame, finishes loading", async () => {
  for (const nested of [false, true]) {
    const page = await openFramedPage(nested
      ? { top: `<iframe id="outer"></iframe>`, url: "https://bm.example.test/apply/index",
        frames: { outer: `<nav><a>菜单</a></nav><div id="slot"></div>` } }
      : { top: `<nav><a>首页</a></nav><div id="slot"></div>`, url: "https://bm.example.test/apply/index" });
    const host = nested ? page.frame("outer") : page.win.document;
    const result = await fillWhileWaiting(page, async () => {
      host.getElementById("slot").innerHTML = `<iframe id="main"></iframe>`;
      // 插进来 300ms 后扫过一次，那时表单页还没回来。
      await wait(450);
      const frame = host.getElementById("main");
      const inner = frame.contentDocument;
      installLayout(inner.defaultView);
      inner.body.innerHTML = FORM;
      frame.dispatchEvent(new frame.ownerDocument.defaultView.Event("load"));
    });
    assert.equal(result.filledCount, 6, `${nested ? "nested" : "top"}: ${result.error}`);
    assert.deepEqual(formState(host.getElementById("main").contentDocument), FILLED);
  }
});

test("the zero-field wait rescans when a second-level frame that was already there navigates to the form", async () => {
  const page = await openFramedPage({ top: `<iframe id="outer"></iframe>`, url: "https://bm.example.test/apply/index",
    frames: { outer: { html: `<nav><a>菜单</a></nav><iframe id="inner"></iframe>`, frames: { inner: "" } } } });
  const frame = page.frame("outer").getElementById("inner");
  // 框架换页就是换了一份文档：jsdom 不会真的跳转，这里让框架交出另一份装着表单的文档，再发 load。
  const next = new JSDOM(`<!doctype html><html><head></head><body>${FORM}</body></html>`, { url: "https://bm.example.test/apply/form", pretendToBeVisual: true });
  installLayout(next.window);
  const result = await fillWhileWaiting(page, async () => {
    await wait(100);
    Object.defineProperty(frame, "contentDocument", { configurable: true, get: () => next.window.document });
    frame.dispatchEvent(new frame.ownerDocument.defaultView.Event("load"));
  });
  assert.equal(result.filledCount, 6, result.error);
  assert.deepEqual(formState(next.window.document), FILLED);
});

// 页面结构那几行（自定义控件、只读或禁用输入框）和页面探测一样只算顶层：框架里扫到的北森式下拉不加进自定义控件，
// 它的只读输入框也不从顶层的只读框里减掉。
test("page-structure counts stay top-page only when the form with a generic select is in a frame", async () => {
  const page = await openFramedPage({ top: `<div class="toolbar"><input readonly></div><iframe id="main"></iframe>`,
    frames: { main: `<div class="item"><label>民族</label><div class="phoenix-select phoenix-select--editable"><ul class="phoenix-select__content">
      <li class="phoenix-select__inputWrapper"><input class="phoenix-select__input" readonly></li></ul></div></div>` } });
  const result = await page.fill();
  assert.equal(result.fieldCount, 1, result.error);
  assert.equal(page.aiRequests[0].formFields[0].fieldId, "frame1-field-0");
  const report = lines((await page.status()).diagnosticsReport);
  for (const line of ["readonly_or_disabled: 1", "custom_controls: 0"]) assert.ok(report.includes(line), `${line}\n${report.join("\n")}`);
});

test("a password box and a native radio group in a frame are judged by the frame's own element types", async () => {
  const page = await openFramedPage({ top: `<iframe id="main"></iframe>`,
    frames: { main: `${FORM}<div class="row"><label for="pw">密码</label><input id="pw" type="password"></div>` } });
  const doc = page.frame("main");
  const password = doc.getElementById("pw");
  const refused = await page.hooks.operateControl({ kind: "element", element: password, elements: [password], root: password, controlKind: "text" }, "不该写进来");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "unsupported_control");
  assert.equal(password.value, "");
  const radios = Array.from(doc.querySelectorAll("input[name=xb]"));
  const picked = await page.hooks.operateControl({ kind: "radio", elements: radios, root: radios[0].closest(".opts"), controlKind: "radio" }, "女");
  assert.equal(picked.ok, true, picked.reason);
  assert.equal(radios[1].checked, true);
});

test("a filled field in a frame is highlighted with styles placed in the frame's own document", async () => {
  const page = await openFramedPage({ top: `<iframe id="main"></iframe>`, frames: { main: FORM } });
  await page.fill();
  const doc = page.frame("main");
  assert.ok(doc.getElementById("resume-pro-field-highlight-styles"), "the highlight style is injected into the frame");
  assert.ok(doc.getElementById("xm").classList.contains("resume-pro__field-highlight"));
});

test("clicking 下一步 inside the frame replays focus and blur on the text the fill wrote there", async () => {
  const page = await openFramedPage({ top: `<iframe id="main"></iframe>`, frames: { main: FORM } });
  const doc = page.frame("main");
  // 记下内容脚本给框架文档挂的监听：jsdom 造不出 isTrusted 的点击，下面用这些监听收一次「真实」点击。
  const captured = {};
  const add = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, listener, options) => { (captured[type] ||= []).push(listener); return add(type, listener, options); };
  page.hooks.setSubmitCheckDelayMs(0);
  await page.fill();
  assert.ok(captured.pointerdown?.length, "the frame document gets the submit-sync listener");
  const name = doc.getElementById("xm");
  const intro = doc.getElementById("jl");
  const focused = [];
  name.addEventListener("focus", () => focused.push("姓名"));
  intro.addEventListener("focus", () => focused.push("个人简介"));
  const next = doc.getElementById("next");
  const gesture = { type: "pointerdown", isTrusted: true, button: 0, target: next, composedPath: () => [next, next.parentElement, doc.body, doc.documentElement, doc] };
  for (const listener of captured.pointerdown) listener(gesture);
  assert.deepEqual(focused.sort(), ["个人简介", "姓名"]);
});

test("focus moving into a frame is followed: the side panel sees the frame's input and writes into it", async () => {
  const page = await openFramedPage({ top: `<iframe id="main"></iframe>`, frames: { main: FORM } });
  const doc = page.frame("main");
  const name = doc.getElementById("xm");
  name.focus();
  // Chrome：焦点进了框架，顶层 window 收到 blur，activeElement 是框架元素。jsdom 不发这个事件，这里补上。
  assert.equal(page.win.document.activeElement.id, "main");
  page.win.dispatchEvent(new page.win.Event("blur"));
  await wait(5);
  const target = await page.panel({ type: "RESUME_PANEL_TARGET", chips: [{ chipId: "c1", value: "测试用户" }] });
  assert.equal(target.targetAvailable, true);
  assert.equal(target.composable, true);
  const filled = await page.panel({ type: "RESUME_PANEL_FIELD", mode: "fill", chipId: "c1", value: "测试用户" }, { id: EXTENSION_ID });
  assert.equal(filled.ok, true, filled.error);
  assert.equal(name.value, "测试用户");
  // 之后框架里的焦点直接收得到。
  doc.getElementById("jl").focus();
  const again = await page.panel({ type: "RESUME_PANEL_TARGET", chips: [] });
  assert.equal(again.targetAvailable, true);
  assert.equal(doc.activeElement.id, "jl");
});

test("a form on the top page is filled as before, with plain field ids and no frame line", async () => {
  const page = await openFramedPage({ top: FORM, url: "https://jobs.example.test/campus/apply/1" });
  const result = await page.fill();
  assert.equal(result.filledCount, 6, result.error);
  assert.deepEqual(formState(page.win.document), FILLED);
  assert.deepEqual(Array.from(page.aiRequests[0].formFields, (field) => field.fieldId), ["field-0", "field-1", "field-radio-2", "field-3", "field-4", "field-5"]);
  const status = await page.status();
  assert.ok(!status.diagnostics.includes("同源框架："), status.diagnostics);
  assert.ok(lines(status.diagnosticsReport).includes("dom_inputs: 7"), status.diagnosticsReport);
  assert.ok(page.win.document.getElementById("xm").classList.contains("resume-pro__field-highlight"));
});
