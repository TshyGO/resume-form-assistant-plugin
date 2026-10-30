// #301 #399 #405 文本框写入后的核对和写入被拒时的诊断。
// - 简道云的「出生年月」不是认得出的日期组件，按文本框填；组件失焦后按自己的格式改写（1998-06 → 1998-06-01）或清空，
//   原来逐字比较报「值被页面退回」。像日期的文本框改为按年月日比较，占位提示写明格式时先按它换写法。
//   简道云那样失焦后日历还开着、要点日子才交给表单的，照旧算没写上。
// - 钉钉表单的数字框收到带单位的字被拒：type=number 先取出能放心写的数字，取不出的报 format_mismatch；
//   inputmode=numeric 只是键盘提示，先照原样写，页面没收下再这样处理。
// - 写入被拒时诊断多带固定词：框里剩下的（after）、1 秒内有没有冒出弹层（overlay）、输入框的 inputmode。
//   整页都写不上时只为前 3 个框多等，按停止马上停。
// - 这些整理只用在一键填写上，侧栏和字段卡片的手动写入照原样写。
// 按 manifest 的顺序在 jsdom 里加载全部 content script，页面组件的行为用事件处理函数模拟。夹具里只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const core = require("../feedback-core.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;

// jsdom 不排版：隐藏的元素没有框，其余给一个默认的框。
function layout(w) {
  const rectOf = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const css = w.getComputedStyle(node);
      if (node.hidden || css.display === "none" || css.visibility === "hidden") return null;
    }
    return { top: 10, left: 10, width: 300, height: 30, right: 310, bottom: 40, x: 10, y: 10, toJSON() { return this; } };
  };
  const empty = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return this; } };
  w.Element.prototype.getBoundingClientRect = function () { return rectOf(this) || empty; };
  w.Element.prototype.getClientRects = function () { const rect = rectOf(this); return rect ? [rect] : []; };
  w.Element.prototype.scrollIntoView = function () {};
  for (const side of ["Width", "Height"]) {
    Object.defineProperty(w.HTMLElement.prototype, `offset${side}`, { configurable: true,
      get() { return rectOf(this) ? (side === "Width" ? 300 : 30) : 0; } });
  }
}

// 一道题：<label for> 加输入框。attrs 原样写进 input。
const item = (id, label, attrs = "") => `<div class="form-item"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;

// resume：[[题目, 值]]，模板和 AI 替身的回答都按它来。测试结束时关掉窗口，停下页面上的定时器。
function page(t, body, resume = []) {
  const dom = new JSDOM(`<!doctype html><html><body><form>${body}</form></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "https://forms.example.test/f/demo" });
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
  const reports = [];
  const fill = (message) => {
    const matches = message.formFields.filter((field) => answers[field.label] !== undefined)
      .map((field) => ({ fieldId: field.fieldId, value: answers[field.label] }));
    return { success: true, matches, diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: matches.length, promptBytes: 100, errorCode: "none" } };
  };
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.4.4" }),
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === "FEEDBACK_AUTO") { reports.push(message.report.diagnostics); return null; }
        return message.type === "DESKTOP_RESUME_READ" ? { status: "ok", data }
          : ["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type) ? { ready: true }
          : message.type === "AI_FILL" ? fill(message) : {};
      } },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} } }
  };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  const helpers = w.ResumeProHighlightTest;
  // 页面自己的处理在 0 毫秒的定时器里，等 10 毫秒足够；弹层看 80 毫秒，测试不用等满 1 秒。
  helpers.setTextCommitWaitMs(10);
  helpers.setOverlayWindowMs?.(80);
  // 日历收起动画按 200 毫秒等。
  helpers.setCalendarCloseMs?.(200);
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null },
    fill: { disabled: false, textContent: "" } };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": { hidden: true, open: false },
    "#resume-pro-diagnostics-text": ui.diag, "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-ai-fill": ui.fill };
  helpers.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  const input = (id) => w.document.getElementById(id);
  return {
    w, doc: w.document, ui, reports, input,
    // 按一键填写的方式单独填一个框：返回是否填上，原因码看 reason()。
    set: (id, value) => helpers.setElementValue({ kind: "element", element: input(id), controlKind: "text" }, value,
      undefined, undefined, undefined, { fill: true }),
    reason: (id) => helpers.textFillFailureReason(input(id)),
    run: () => helpers.handleAiFillClick({ currentTarget: ui.fill }),
    unfilledLine: () => (reports.at(-1) || "").split("\n").filter((line) => line.startsWith("- "))
  };
}

const later = (fn) => setTimeout(fn, 0);
// 受控组件的写法：框里的字以组件状态为准，状态变了就重画。
function controlled(el, { onInput = (value) => value, onBlur = (value) => value, async = false } = {}) {
  let state = el.value;
  const render = () => { el.value = state; };
  el.addEventListener("input", () => { state = onInput(el.value); render(); });
  el.addEventListener("blur", () => {
    const apply = () => { state = onBlur(state); render(); };
    if (async) later(apply); else apply();
  });
  return { get state() { return state; } };
}
const toIsoDay = (value) => {
  const hit = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(value);
  return hit ? `${hit[1]}-${hit[2].padStart(2, "0")}-01` : value;
};

// ---- #399 日期样式的文本框 ----

test("#399 出生年月: the page rewrites 1998-06 to 1998-06-01 on blur, and that counts as written", async (t) => {
  const p = page(t, item("birth", "出生年月"));
  controlled(p.input("birth"), { onBlur: toIsoDay });
  assert.equal(await p.set("birth", "1998-06"), true, p.reason("birth"));
  assert.equal(p.input("birth").value, "1998-06-01");
});

test("#399 出生年月: a rewrite a moment after blur (1998.06 → 1998-06-01) also counts as written", async (t) => {
  const p = page(t, item("birth", "出生年月"));
  controlled(p.input("birth"), { onBlur: toIsoDay, async: true });
  assert.equal(await p.set("birth", "1998.06"), true, p.reason("birth"));
  assert.equal(p.input("birth").value, "1998-06-01");
});

test("#399 equal dates only: another month or day, or a box that is not about a date, is still a rejected write", async (t) => {
  const p = page(t, item("birth", "出生年月") + item("start", "入学时间") + item("note", "备注") + item("day", "出生日期"));
  controlled(p.input("birth"), { onBlur: () => "1998-07-01", async: true });
  controlled(p.input("start"), { onBlur: () => "2016-09-02" });
  controlled(p.input("note"), { onBlur: toIsoDay });
  controlled(p.input("day"), { onBlur: () => "1998-06-15" });
  assert.equal(await p.set("birth", "1998-06"), false);
  assert.equal(p.reason("birth"), "value_reverted");
  assert.equal(await p.set("start", "2016-09"), false, "the page picked day 2, not the 1st");
  assert.equal(p.reason("start"), "value_not_committed");
  assert.equal(await p.set("note", "1998-06"), false, "备注 is not a date box");
  assert.equal(await p.set("day", "1998-06"), false, "a day the resume never had");
});

test("#399 a box that only keeps the month (1998-06-15 → 1998-06) counts as written", async (t) => {
  const p = page(t, item("birth", "出生年月"));
  controlled(p.input("birth"), { onBlur: (value) => value.slice(0, 7) });
  assert.equal(await p.set("birth", "1998-06-15"), true, p.reason("birth"));
  assert.equal(p.input("birth").value, "1998-06");
});

test("#399 the placeholder's date format is used before writing; a day the resume lacks becomes the 1st", async (t) => {
  const cases = [
    ['placeholder="YYYY-MM-DD"', "1998-06", "1998-06-01"],
    ['placeholder="请输入，格式 yyyy/mm/dd"', "1998年6月15日", "1998/06/15"],
    ['placeholder="YYYY年MM月"', "1998-06-15", "1998年06月"],
    ['placeholder="YYYY.MM"', "1998年6月", "1998.06"],
    ['placeholder="YYYYMM"', "1998-06", "199806"],
    ['placeholder="例：2020.9"', "1998-06", "1998.6"],
    ['placeholder="如 2020-09"', "1998年6月", "1998-06"],
    // 认不出格式，或资料不是一个日期的，照原样写。
    ['placeholder="MM/DD/YYYY"', "1998-06", "1998-06"],
    ['placeholder="yyyy-mm-dd hh:mm"', "1998-06", "1998-06"],
    ['placeholder="2019.09-2023.06"', "1998-06", "1998-06"],
    ['placeholder="YYYY-MM"', "至今", "至今"],
    ['placeholder="YYYY-MM"', "1998.06-2002.07", "1998.06-2002.07"]
  ];
  const p = page(t, cases.map(([attrs], index) => item(`f${index}`, "毕业时间", attrs)).join(""));
  for (const [index, [attrs, value, written]] of cases.entries()) {
    assert.equal(await p.set(`f${index}`, value), true, `${attrs}: ${p.reason(`f${index}`)}`);
    assert.equal(p.input(`f${index}`).value, written, attrs);
  }
});

test("#399 a component that clears a date not in its YYYY-MM-DD format keeps the converted date; the status says the day was set to the 1st", async (t) => {
  const p = page(t, item("birth", "出生年月", 'placeholder="YYYY-MM-DD"'), [["出生年月", "1998-06"]]);
  controlled(p.input("birth"), { onBlur: (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""), async: true });
  const result = await p.run();
  assert.equal(p.input("birth").value, "1998-06-01");
  assert.equal(result.filledCount, 1, p.ui.diag.value);
  assert.equal(p.ui.status.textContent, "已填写 1 个字段（1 项日期资料里只有年月，已按 1 日填写）。");
});

test("#399 a later field's focus resetting an earlier date box is caught by the final check, with what the box held", async (t) => {
  const p = page(t, item("birth", "出生年月") + item("name", "姓名"), [["出生年月", "1998-06"], ["姓名", "张三"]]);
  controlled(p.input("birth"), { onBlur: toIsoDay });
  p.input("name").addEventListener("focus", () => { p.input("birth").value = ""; });
  const result = await p.run();
  assert.equal(result.filledCount, 1);
  assert.deepEqual(p.unfilledLine(), ["- 出生年月: input[text] after=empty reason=value_reverted"]);
});

test("#399 an amount example in the placeholder is not a date format: 2010.5 stays 2010.5", async (t) => {
  const p = page(t, item("pay", "期望月薪", 'placeholder="如：2000.50"') + item("pay2", "期望月薪", 'placeholder="如：2010.5"'));
  assert.equal(await p.set("pay", "2010.5"), true, p.reason("pay"));
  assert.equal(p.input("pay").value, "2010.5");
  assert.equal(await p.set("pay2", "2010.5"), true, p.reason("pay2"));
  assert.equal(p.input("pay2").value, "2010.5");
});

// 简道云式日期框：聚焦弹出日历，失焦后把框里的字改写成 YYYY-MM-DD，日历不收起；表单的值要点日子或在别处按下鼠标才有。
// closeAfterMs：失焦后过一会儿才收起（收起动画）；不给就一直开着。classes：日历外层和里面一层的类名。
function calendarBox(p, id, { closeAfterMs = null, classes = ["x-popup x-datetime-content", "x-datepicker"] } = {}) {
  const el = p.input(id);
  let popup = null;
  el.addEventListener("focus", () => {
    if (popup) return;
    popup = p.doc.createElement("div");
    popup.className = classes[0];
    popup.innerHTML = `<div class='${classes[1]}'></div>`;
    p.doc.body.append(popup);
  });
  el.addEventListener("blur", () => {
    el.value = toIsoDay(el.value);
    if (closeAfterMs !== null) setTimeout(() => { popup?.remove(); popup = null; }, closeAfterMs);
  });
}

test("#399 a date box whose calendar stays open after blur is still a rejected write when only the same date is shown", async (t) => {
  const p = page(t, item("birth", "出生年月") + item("start", "入学时间") + item("leave", "离校时间"));
  calendarBox(p, "birth");
  calendarBox(p, "start", { closeAfterMs: 0 });
  calendarBox(p, "leave", { closeAfterMs: 80 });
  // 日历还开着：框里显示 1998-06-01，可表单没收下，和原来一样报没写上。
  assert.equal(await p.set("birth", "1998-06"), false);
  assert.equal(p.reason("birth"), "value_reverted");
  assert.equal(p.input("birth").value, "1998-06-01");
  // 日历随失焦收起的，或收起动画放完就关上的，改写成同一天算写上。
  assert.equal(await p.set("start", "2016-09"), true, p.reason("start"));
  assert.equal(p.input("start").value, "2016-09-01");
  assert.equal(await p.set("leave", "2020-06"), true, p.reason("leave"));
  assert.equal(p.input("leave").value, "2020-06-01");
});

test("#399 a calendar known only by datepicker or Calendar in its class names, with no role, is also seen as kept open", async (t) => {
  const p = page(t, item("birth", "出生年月") + item("start", "入学时间"));
  calendarBox(p, "birth", { classes: ["x-datetime-content", "x-datepicker"] });
  calendarBox(p, "start", { classes: ["Calendar_panel__k3x", "Calendar_days__p2"] });
  assert.equal(await p.set("birth", "1998-06"), false);
  assert.equal(p.reason("birth"), "value_reverted");
  assert.equal(await p.set("start", "2016-09"), false);
  assert.equal(p.reason("start"), "value_reverted");
});

test("#399 a popup with date only inside another word (candidate, update, validate) is not taken for a calendar", async (t) => {
  // 入学时间：日历随失焦收起，同时冒出几个一直开着的建议框、提示层，类名里的 date 只是别的词的一部分。
  const p = page(t, item("start", "入学时间") + item("leave", "离校时间") + item("grad", "毕业时间"));
  calendarBox(p, "start", { closeAfterMs: 0 });
  p.input("start").addEventListener("blur", () => {
    for (const name of ["candidate-suggest", "update-tooltip", "validate-popup", "isUpdateModal"]) {
      const node = p.doc.createElement("div");
      node.className = name;
      p.doc.body.append(node);
    }
  });
  assert.equal(await p.set("start", "2016-09"), true, p.reason("start"));
  assert.equal(p.input("start").value, "2016-09-01");
  // date、datetime 单独成词的，laydate 这类，还算日历：外层只叫 x-popup x-datetime-content、里面没有日历字样的也一样。
  calendarBox(p, "leave", { classes: ["x-popup x-datetime-content", "x-panel"] });
  calendarBox(p, "grad", { classes: ["layui-laydate", "layui-laydate-main"] });
  assert.equal(await p.set("leave", "2020-06"), false);
  assert.equal(p.reason("leave"), "value_reverted");
  assert.equal(await p.set("grad", "2020-06"), false);
  assert.equal(p.reason("grad"), "value_reverted");
});

test("a suggestion list with date inside a word of its class name is reported as a list", async (t) => {
  const p = page(t, item("city", "当前城市", 'value="北京"'), [["当前城市", "上海"]]);
  controlled(p.input("city"), { onBlur: () => "北京" });
  p.input("city").addEventListener("input", () => {
    if (p.doc.querySelector(".candidate-suggest")) return;
    const list = p.doc.createElement("ul");
    list.className = "candidate-suggest";
    list.innerHTML = "<li>上海</li>";
    p.doc.body.append(list);
  });
  await p.run();
  assert.deepEqual(p.unfilledLine(), ["- 当前城市: input[text] after=previous overlay=list reason=value_not_committed"]);
});

test("#399 the report for such a date box says the text was changed and a calendar came up", async (t) => {
  const p = page(t, item("birth", "出生年月"), [["出生年月", "1998-06"]]);
  calendarBox(p, "birth");
  const result = await p.run();
  assert.equal(result.filledCount, 0);
  assert.deepEqual(p.unfilledLine(), ["- 出生年月: input[text] after=other overlay=other reason=value_reverted"]);
});

// ---- #405 数字框 ----

test("#405 type=number: 175cm is written as 175; nothing safe to take out is not written at all", async (t) => {
  const p = page(t, item("height", "身高", 'type="number"') + item("salary", "期望薪资", 'type="number"'));
  assert.equal(await p.set("height", "175cm"), true, p.reason("height"));
  assert.equal(p.input("height").value, "175");
  let focused = false;
  p.input("salary").addEventListener("focus", () => { focused = true; });
  assert.equal(await p.set("salary", "10k-15k"), false);
  assert.equal(p.reason("salary"), "format_mismatch");
  assert.equal(p.input("salary").value, "");
  assert.equal(focused, false, "the box is left alone");
});

test("#405 inputmode=numeric box that drops non-digits: 175cm goes in as 175, 10k-15k is not turned into 1015", async (t) => {
  const p = page(t, item("height", "身高", 'inputmode="numeric"') + item("salary", "期望薪资", 'inputmode="numeric"'));
  for (const id of ["height", "salary"]) controlled(p.input(id), { onInput: (value) => value.replace(/\D/g, "") });
  assert.equal(await p.set("height", "175cm"), true, p.reason("height"));
  assert.equal(p.input("height").value, "175");
  assert.equal(await p.set("salary", "10k-15k"), false);
  assert.equal(p.reason("salary"), "format_mismatch");
  assert.equal(p.input("salary").value, "");
});

test("#405 what counts as a number safe to take out", async (t) => {
  // inputmode 的框照原样写，页面把数字以外的字滤掉了才取数字：这里的 inputmode 框都按这样的受控组件做。
  const cases = [
    // [题目, 属性, 资料, 写进去的；null 表示不写]
    ["身高", 'type="number"', "175 cm", "175"],
    ["体重", 'type="number"', "65.5公斤", "65.5"],
    ["身高（cm）", 'type="number"', "175厘米", "175"],
    ["期望月薪（元/月）", 'inputmode="decimal"', "8000元/月", "8000"],
    ["期望月薪", 'type="number"', "¥8,000", "8000"],
    ["工作年限", 'inputmode="numeric"', "3年", "3"],
    ["年龄", 'type="number"', "２５岁", "25"],
    ["身高", 'type="number"', "175", "175"],
    // 题目写明了别的单位：取出的数字意思变了。
    ["身高（m）", 'type="number"', "175cm", null],
    ["期望月薪（千元）", 'type="number"', "8000元", null],
    ["实习时长（周）", 'inputmode="numeric"', "6个月", null],
    // 括号里除了单位还有别的话。
    ["身高（m，必填）", 'type="number"', "175cm", null],
    ["期望月薪（千元、税前）", 'type="number"', "8000元", null],
    ["身高（cm，选填）", 'type="number"', "175cm", "175"],
    // 范围、倍数、几个数、文字。
    ["期望月薪", 'type="number"', "20万", null],
    ["期望月薪", 'type="number"', "8000-10000", null],
    ["工作年限", 'inputmode="numeric"', "3年以上", null],
    ["GPA", 'inputmode="decimal"', "3.8/4.0", null],
    ["期望月薪", 'inputmode="numeric"', "面议", null],
    ["专业排名", 'type="number"', "前10%", null]
  ];
  const p = page(t, cases.map(([label, attrs], index) => item(`f${index}`, label, attrs)).join(""));
  for (const [index, [, attrs]] of cases.entries()) {
    if (attrs.startsWith("inputmode")) controlled(p.input(`f${index}`), { onInput: (value) => value.replace(/[^\d.]/g, "") });
  }
  for (const [index, [label, attrs, value, written]] of cases.entries()) {
    const ok = await p.set(`f${index}`, value);
    assert.equal(ok, written !== null, `${label} ${value}: ${p.reason(`f${index}`)}`);
    if (written === null) {
      assert.equal(p.reason(`f${index}`), "format_mismatch", `${label} ${value}`);
      assert.equal(p.input(`f${index}`).value, "", `${label} ${value}`);
    } else assert.equal(p.input(`f${index}`).value, written, `${label} ${value}`);
  }
});

test("#405 a pay period or a unit the question names that the resume does not match is not taken out", async (t) => {
  const cases = [
    // [题目, 属性, 资料, 写进去的；null 表示不写]
    // 资料是按年的，题目要按月（或反过来）。
    ["期望月薪", 'type="number"', "8000元/年", null],
    ["期望年薪", 'type="number"', "8000元/月", null],
    ["期望薪资（元/月）", 'type="number"', "96000元/年", null],
    ["期望月薪", 'inputmode="numeric"', "8000/年", null],
    // 题目写的是规则表外的单位。
    ["期望月薪（美元）", 'type="number"', "8000元", null],
    ["期望月薪（单位：港币）", 'type="number"', "¥8,000", null],
    ["身高（英寸）", 'type="number"', "175cm", null],
    ["体重（lb）", 'inputmode="decimal"', "65kg", null],
    // 对得上的，题目没写周期、括号里不是单位的，照取。
    ["期望月薪", 'type="number"', "8000元/月", "8000"],
    ["期望年薪（元/年）", 'type="number"', "96000元/年", "96000"],
    ["期望薪资", 'type="number"', "8000元/月", "8000"],
    ["期望月薪（税前）", 'type="number"', "8000元", "8000"],
    ["身高（选填）", 'type="number"', "175cm", "175"]
  ];
  const p = page(t, cases.map(([label, attrs], index) => item(`f${index}`, label, attrs)).join(""));
  for (const [index, [, attrs]] of cases.entries()) {
    if (attrs.startsWith("inputmode")) controlled(p.input(`f${index}`), { onInput: (value) => value.replace(/[^\d.]/g, "") });
  }
  for (const [index, [label, attrs, value, written]] of cases.entries()) {
    const ok = await p.set(`f${index}`, value);
    assert.equal(ok, written !== null, `${label} ${value}: ${p.reason(`f${index}`)}`);
    if (written === null) {
      assert.equal(p.reason(`f${index}`), "format_mismatch", `${label} ${value}`);
      assert.equal(p.input(`f${index}`).value, "", `${label} ${value}`);
    } else assert.equal(p.input(`f${index}`).value, written, `${label} ${value}`);
  }
});

test("#405 an inputmode=numeric box that turns the number away too gets back what it held before", async (t) => {
  // 身高：页面滤掉数字以外的字，失焦后又清空。175cm 照原样写、再写 175，都没收下：框里恢复成原来的 180，不留空。
  const p = page(t, item("height", "身高", 'inputmode="numeric" value="180"'));
  controlled(p.input("height"), { onInput: (value) => value.replace(/\D/g, ""), onBlur: () => "" });
  assert.equal(await p.set("height", "175cm"), false);
  assert.equal(p.reason("height"), "value_not_committed");
  assert.equal(p.input("height").value, "180");
});

test("#405 inputmode only hints the keyboard: a date or an ID number in such a box is written as before; a phone loses its spacing", async (t) => {
  const p = page(t, item("birth", "出生年月", 'inputmode="numeric"') + item("id", "证件号码", 'inputmode="numeric"')
    + item("phone", "手机号", 'type="number"'));
  assert.equal(await p.set("birth", "1998-06"), true, p.reason("birth"));
  assert.equal(p.input("birth").value, "1998-06");
  assert.equal(await p.set("id", "11010519491231002X"), true, p.reason("id"));
  assert.equal(p.input("id").value, "11010519491231002X");
  assert.equal(await p.set("phone", "+86 138-0013-8000"), true, p.reason("phone"));
  assert.equal(p.input("phone").value, "13800138000");
});

test("#405 inputmode boxes that take any text keep what main wrote: phone with dashes, letters, ranges, spaces", async (t) => {
  const cases = [["联系方式", "138-0013-8000"], ["联系电话", "+86 13800138000"], ["学号", "2016A0123"], ["在校时间", "2016.09-2020.06"],
    ["邮政编码", "100 080"], ["身高", "175cm"]];
  const p = page(t, cases.map(([label], index) => item(`f${index}`, label, 'inputmode="numeric"')).join(""));
  for (const [index, [label, value]] of cases.entries()) {
    assert.equal(await p.set(`f${index}`, value), true, `${label}: ${p.reason(`f${index}`)}`);
    assert.equal(p.input(`f${index}`).value, value, label);
  }
});

test("#405 an inputmode=numeric box that turns the text away without dropping letters keeps its text and the reason it gave", async (t) => {
  // 证件号码：页面按 6-8-4 分段显示。离校时间：只收 YYYY-MM-DD，别的失焦后清空。都不是滤掉数字以外的字。
  const p = page(t, item("cert", "证件号码", 'inputmode="numeric"') + item("leave", "离校时间", 'inputmode="numeric"'));
  controlled(p.input("cert"), { onInput: (value) => value.replace(/\s/g, "").replace(/^(\d{6})(\d{8})(\w{4})$/, "$1 $2 $3") });
  controlled(p.input("leave"), { onBlur: (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""), async: true });
  assert.equal(await p.set("cert", "11010519491231002X"), false);
  assert.equal(p.reason("cert"), "value_not_committed");
  assert.equal(p.input("cert").value, "110105 19491231 002X");
  assert.equal(await p.set("leave", "2020-06"), false);
  assert.equal(p.reason("leave"), "value_reverted");
});

test("#405 联系方式 in a box that keeps only digits counts as the same phone number", async (t) => {
  // id、name 里没有 phone、tel 这类词，只靠题目认出是电话。
  const p = page(t, item("contact", "联系方式", 'inputmode="numeric"'));
  controlled(p.input("contact"), { onInput: (value) => value.replace(/\D/g, "") });
  assert.equal(await p.set("contact", "138-0013-8000"), true, p.reason("contact"));
  assert.equal(p.input("contact").value, "13800138000");
});

test("#405 the status names a number box it did not write", async (t) => {
  const p = page(t, item("salary", "期望薪资", 'inputmode="numeric"'), [["期望薪资", "10k-15k"]]);
  controlled(p.input("salary"), { onInput: (value) => value.replace(/\D/g, "") });
  const result = await p.run();
  assert.equal(result.unfilledCount, 1);
  assert.equal(p.ui.status.textContent, "已填写 0 个字段。1 项没填上：期望薪资（只能填数字），请手动补上。");
  assert.deepEqual(p.unfilledLine(), ["- （字段名已隐藏）: input[text] inputmode=numeric reason=format_mismatch"]);
});

// ---- 写入被拒时的诊断 ----

test("a rejected write says what the box was left with and whether a popup came up, never the text itself", async (t) => {
  const p = page(t, item("birth", "出生年月") + item("city", "当前城市", 'value="北京"') + item("school", "学校"),
    [["出生年月", "1998-06"], ["当前城市", "上海"], ["学校", "示例大学"]]);
  // 出生年月：失焦后被清空，什么也没弹出。
  controlled(p.input("birth"), { onBlur: () => "", async: true });
  // 当前城市：打字时冒出建议列表，失焦后退回原来的「北京」。
  const city = controlled(p.input("city"), { onBlur: () => "北京" });
  p.input("city").addEventListener("input", () => {
    if (p.doc.querySelector(".city-suggest")) return;
    const list = p.doc.createElement("ul");
    list.className = "city-suggest";
    list.setAttribute("role", "listbox");
    list.innerHTML = "<li role='option'>上海</li>";
    p.doc.body.append(list);
  });
  // 学校：失焦后换成别的字，同时弹出一个对话框。
  controlled(p.input("school"), { onBlur: () => "（请从列表选择）" });
  p.input("school").addEventListener("blur", () => {
    const dialog = p.doc.createElement("div");
    dialog.className = "notice-modal";
    dialog.setAttribute("role", "dialog");
    dialog.textContent = "请从列表选择";
    p.doc.body.append(dialog);
  });
  const result = await p.run();
  assert.equal(result.filledCount, 0);
  assert.equal(city.state, "北京");
  const lines = p.unfilledLine();
  assert.deepEqual(lines, [
    "- 出生年月: input[text] after=empty overlay=none reason=value_reverted",
    "- 当前城市: input[text] after=previous overlay=list reason=value_not_committed",
    "- 学校: input[text] after=other overlay=other reason=value_not_committed"
  ]);
  for (const words of ["1998", "北京", "上海", "示例大学", "请从列表选择"]) assert.ok(!p.reports.at(-1).includes(words), words);
  assert.equal(core.diagnostics(p.reports.at(-1)), p.reports.at(-1));
});

test("popup class words are matched whatever their case", async (t) => {
  const p = page(t, item("city", "当前城市", 'value="北京"'), [["当前城市", "上海"]]);
  controlled(p.input("city"), { onBlur: () => "北京" });
  p.input("city").addEventListener("input", () => {
    if (p.doc.querySelector(".CitySuggest_list__q1")) return;
    const list = p.doc.createElement("ul");
    list.className = "CitySuggest_list__q1";
    list.innerHTML = "<li>上海</li>";
    p.doc.body.append(list);
  });
  await p.run();
  assert.deepEqual(p.unfilledLine(), ["- 当前城市: input[text] after=previous overlay=list reason=value_not_committed"]);
});

test("a popup seen in an earlier fill is not reported for the same box when this fill did not watch it", async (t) => {
  // 第一次按文本框填：打字冒出建议列表，失焦后被清空。第二次页面把它包成了日期组件，按日期框填，又被退回。
  const p = page(t, '<div class="form-item"><label for="birth">出生日期</label><span id="wrap"><input id="birth"></span></div>',
    [["出生日期", "1998-06-15"]]);
  controlled(p.input("birth"), { onBlur: () => "", async: true });
  p.input("birth").addEventListener("input", () => {
    if (p.doc.querySelector(".birth-suggest")) return;
    const list = p.doc.createElement("ul");
    list.className = "birth-suggest";
    list.setAttribute("role", "listbox");
    p.doc.body.append(list);
  });
  const lines = () => p.unfilledLine().map((line) => line.replace(/^- [^:]+: /, ""));
  await p.run();
  assert.deepEqual(lines(), ["input[text] after=empty overlay=list reason=value_reverted"]);
  p.doc.getElementById("wrap").className = "my-datepicker";
  await p.run();
  assert.deepEqual(lines(), ["input[text] picker=generic reason=value_reverted"]);
});

test("a popup the next field opens is not put down to the box rejected before it", async (t) => {
  const p = page(t, item("birth", "出生年月") + item("school", "学校"), [["出生年月", "1998-06"], ["学校", "示例大学"]]);
  controlled(p.input("birth"), { onBlur: () => "", async: true });
  p.input("school").addEventListener("focus", () => {
    const list = p.doc.createElement("div");
    list.className = "school-dropdown";
    list.textContent = "示例大学";
    p.doc.body.append(list);
  });
  await p.run();
  assert.deepEqual(p.unfilledLine(), ["- 出生年月: input[text] after=empty overlay=none reason=value_reverted"]);
});

test("a page that refuses every text only holds up the first 3 boxes to watch for popups", async (t) => {
  const labels = ["问题一", "问题二", "问题三", "问题四", "问题五", "问题六"];
  const p = page(t, labels.map((label, index) => item(`f${index}`, label)).join(""), labels.map((label) => [label, "示例答案"]));
  for (const index of labels.keys()) controlled(p.input(`f${index}`), { onBlur: () => "", async: true });
  p.reports.length = 0;
  await p.run();
  // 前 3 个看满了窗口，没有弹层报 none；后面的到下一个字段开始就停，没看到弹层不报 overlay。
  assert.deepEqual(p.unfilledLine().map((line) => line.replace(/^- [^:]+: /, "")), [
    "input[text] after=empty overlay=none reason=value_reverted",
    "input[text] after=empty overlay=none reason=value_reverted",
    "input[text] after=empty overlay=none reason=value_reverted",
    "input[text] after=empty reason=value_reverted",
    "input[text] after=empty reason=value_reverted",
    "input[text] after=empty reason=value_reverted"
  ]);
});

test("pressing stop while a rejected box is being watched ends the fill at once", async (t) => {
  const p = page(t, item("birth", "出生年月") + item("name", "姓名"), [["出生年月", "1998-06"], ["姓名", "张三"]]);
  p.w.ResumeProHighlightTest.setOverlayWindowMs(5000);
  controlled(p.input("birth"), { onBlur: () => "", async: true });
  let stoppedAt = 0;
  p.input("birth").addEventListener("blur", () => setTimeout(() => { stoppedAt = Date.now(); p.ui.cancel.onclick?.(); }, 50));
  await p.run();
  assert.ok(stoppedAt > 0, "stop was pressed");
  assert.ok(Date.now() - stoppedAt < 1500, `stopped after ${Date.now() - stoppedAt}ms`);
  assert.equal(p.input("name").value, "", "nothing written after stop");
});

// ---- 手动写入不整理 ----

test("adding then removing a date chip by hand leaves the box empty, not -01", async (t) => {
  const p = page(t, item("grad", "毕业时间", 'placeholder="YYYY-MM-DD"'));
  const helpers = p.w.ResumeProHighlightTest;
  const box = p.input("grad");
  assert.equal(await helpers.applyChipValue(box, "2020-06", "add", { start: 0, end: 0 }), true);
  assert.equal(box.value, "2020-06");
  assert.equal(await helpers.applyChipValue(box, "2020-06", "remove", { start: 7, end: 7 }), true);
  assert.equal(box.value, "");
});

test("a value put in by hand goes into a number-keyboard box as it is", async (t) => {
  const p = page(t, item("phone", "联系电话", 'inputmode="numeric"') + item("height", "身高", 'type="number"'));
  const helpers = p.w.ResumeProHighlightTest;
  assert.equal(await helpers.setElementValue(p.input("phone"), "+86 13800138000"), true);
  assert.equal(p.input("phone").value, "+86 13800138000");
  // type=number 自己清掉写不进的字：手动写入不替用户取数字，照旧报没写上。
  assert.equal(await helpers.setElementValue(p.input("height"), "175cm"), false);
  assert.equal(helpers.textFillFailureReason(p.input("height")), "value_not_committed");
});

test("the allowlist keeps the new words and drops anything else a page could put there", () => {
  const report = core.fillReport({ fieldCount: 2, unfilledControls: [
    { label: "出生年月", reasonCode: "value_reverted", observed: { after: "previous", overlay: "list" }, control: { tag: "input", type: "text", inputMode: "decimal" } },
    { label: "手机", reasonCode: "value_not_committed", observed: { after: "1998-06", overlay: "calendar" }, control: { tag: "input", type: "number", inputMode: "13800138000" } }
  ] });
  assert.match(report, /^- 出生年月: input\[text\] inputmode=decimal after=previous overlay=list reason=value_reverted$/m);
  assert.match(report, /^- 手机: input\[number\] reason=value_not_committed$/m);
  const forged = ["[未填字段]",
    "- 出生年月: input[text] inputmode=numeric after=empty overlay=other reason=format_mismatch",
    "- 学校: input[text] after=示例大学 overlay=张三 inputmode=13800138000 after=https://evil.example overlay=listbox inputmode=Numeric reason=value_reverted"
  ].join("\n");
  assert.equal(core.diagnostics(forged), ["[未填字段]",
    "- 出生年月: input[text] inputmode=numeric after=empty overlay=other reason=format_mismatch",
    "- 学校: input[text] reason=value_reverted"].join("\n"));
});
