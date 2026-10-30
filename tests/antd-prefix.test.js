// #301 飞书招聘（*.jobs.feishu.cn、小米 mioffice）的 antd 改了类名前缀：ConfigProvider prefixCls="atsx"，
// 整套类名换成 atsx-select、atsx-picker、atsx-form-item 这样。插件要和默认的 ant- 一样扫描、选下拉、填日期、读题目；
// arco、Element、iView、Semi、Vant 和自研的 xx-select 不能因此被当成 antd。
// 替身按 2026-10-31 在 Chromium 里跑真 antd 5.21.6、4.24.16（prefixCls="atsx"）看到的结构写。只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { openFramedPage, installLayout } = require("./helpers/frame-page.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = ["antd-prefix.js", "ai-helpers.js", "custom-controls.js", "control-adapters.js", "field-scan.js", "fill-probe.js", "page-outline.js"];
// antd 的 0×0 辅助列表（role=listbox）不算看得见：jsdom 里用 data-w / data-h 标出它的大小。
const isVisible = (el) => !el.closest("[hidden], [data-h='0']");
const ANSWERS = { 姓名: "测试用户", 手机号码: "13800138000", 邮箱: "user@example.test", 最高学历: "本科", 毕业院校: "示例大学",
  毕业时间: "2024-06", 性别: "女" };
const EDUCATION = ["大专", "本科", "硕士", "博士"];
// jsdom 里的数组、对象属于页面的 realm：换成本地的再比较。
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- antd 4 / 5 的结构，p 是类名前缀 ---------------------------------------------

const item = (p, id, label, control) => `<div class="${p}-form-item"><div class="${p}-row ${p}-form-item-row">`
  + `<div class="${p}-col ${p}-form-item-label"><label for="${id}" class="${p}-form-item-required" title="${label}">${label}</label></div>`
  + `<div class="${p}-col ${p}-form-item-control"><div class="${p}-form-item-control-input"><div class="${p}-form-item-control-input-content">`
  + `${control}</div></div></div></div></div>`;
const input = (p, id) => `<input placeholder="请输入" id="${id}" aria-required="true" class="${p}-input ${p}-input-outlined" type="text" value="">`;
const select = (p, id, selected = "") => `<div class="${p}-select ${p}-select-outlined ${p}-select-in-form-item ${p}-select-single ${p}-select-show-arrow">`
  + `<div class="${p}-select-selector"><span class="${p}-select-selection-search"><input type="search" id="${id}" autocomplete="off"`
  + ` class="${p}-select-selection-search-input" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-owns="${id}_list"`
  + ` aria-autocomplete="list" aria-controls="${id}_list" readonly unselectable="on" value=""></span>`
  + (selected ? `<span class="${p}-select-selection-item" title="${selected}">${selected}</span>` : `<span class="${p}-select-selection-placeholder">请选择</span>`)
  + `</div><span class="${p}-select-arrow" unselectable="on" aria-hidden="true"><span role="img" aria-label="down" class="anticon anticon-down ${p}-select-suffix"></span></span></div>`;
// antd 4 的日期框只读，antd 5 的能打字。
const picker = (p, id, readOnly = false) => `<div class="${p}-picker ${p}-picker-outlined"><div class="${p}-picker-input">`
  + `<input${readOnly ? " readonly" : ""} autocomplete="off" size="12" id="${id}" placeholder="请选择月份" value="">`
  + `<span class="${p}-picker-suffix"><span role="img" aria-label="calendar" class="anticon anticon-calendar"></span></span></div></div>`;
// antd 5 换了前缀也照样带 ant-wave-target。
const radios = (p, id, choices) => `<div class="${p}-radio-group ${p}-radio-group-outline" id="${id}">${choices.map((choice) => `<label class="${p}-radio-wrapper ${p}-radio-wrapper-in-form-item">`
  + `<span class="${p}-radio ant-wave-target"><input class="${p}-radio-input" type="radio" value="${choice}"><span class="${p}-radio-inner"></span></span><span>${choice}</span></label>`).join("")}</div>`;
const form = (p, { readOnlyPicker = false } = {}) => `<form class="${p}-form ${p}-form-vertical">`
  + item(p, "name", "姓名", input(p, "name")) + item(p, "phone", "手机号码", input(p, "phone")) + item(p, "email", "邮箱", input(p, "email"))
  + item(p, "education", "最高学历", select(p, "education")) + item(p, "school", "毕业院校", input(p, "school"))
  + item(p, "graduation", "毕业时间", picker(p, "graduation", readOnlyPicker)) + item(p, "gender", "性别", radios(p, "gender", ["男", "女"]))
  + "</form>";

// 下拉：在选择框上按下鼠标展开，弹层挂在 body 下；0×0 的辅助列表只放当前项前后两条，真选项在 rc-virtual-list 里。
// 日历（月份）：在输入框上按下鼠标展开；点年份按钮换成年份面板，点年份回到月份面板，点月份写进输入框并收起。
// 记下页面自己收下的选择。
function wire(doc, p) {
  const picked = [];
  for (const root of doc.querySelectorAll(`.${p}-select`)) {
    const selector = root.querySelector(`.${p}-select-selector`), combo = root.querySelector("input");
    let dropdown = null;
    const close = () => { dropdown.hidden = true; dropdown.classList.add(`${p}-select-dropdown-hidden`); combo.setAttribute("aria-expanded", "false"); };
    const choose = (text) => {
      picked.push(`${combo.id}=${text}`);
      root.querySelector(`.${p}-select-selection-placeholder`)?.remove();
      let shown = root.querySelector(`.${p}-select-selection-item`);
      if (!shown) { shown = doc.createElement("span"); shown.className = `${p}-select-selection-item`; selector.append(shown); }
      shown.title = text; shown.textContent = text;
      close();
    };
    selector.addEventListener("mousedown", () => {
      if (!dropdown) {
        dropdown = doc.createElement("div");
        dropdown.innerHTML = `<div><div role="listbox" id="${combo.id}_list" data-w="0" data-h="0" style="height: 0px; width: 0px; overflow: hidden;">`
          + EDUCATION.slice(0, 2).map((text, i) => `<div aria-label="${text}" role="option" id="${combo.id}_list_${i}" aria-selected="false">${text}</div>`).join("")
          + `</div><div class="rc-virtual-list"><div class="rc-virtual-list-holder"><div><div class="rc-virtual-list-holder-inner">`
          + EDUCATION.map((text) => `<div aria-selected="false" class="${p}-select-item ${p}-select-item-option" title="${text}">`
            + `<div class="${p}-select-item-option-content">${text}</div><span class="${p}-select-item-option-state" unselectable="on" aria-hidden="true"></span></div>`).join("")
          + "</div></div></div></div></div>";
        dropdown.querySelectorAll(`.${p}-select-item-option`).forEach((node) => node.addEventListener("click", () => choose(node.title)));
        doc.body.append(dropdown);
      }
      dropdown.className = `${p}-select-dropdown ${p}-select-dropdown-placement-bottomLeft`;
      dropdown.hidden = false;
      combo.setAttribute("aria-expanded", "true");
    });
  }
  for (const root of doc.querySelectorAll(`.${p}-picker`)) {
    const field = root.querySelector("input");
    let dropdown = null, view = "month", shown = 2026;
    const cell = (title, text) => `<td title="${title}" class="${p}-picker-cell ${p}-picker-cell-in-view"><div class="${p}-picker-cell-inner">${text}</div></td>`;
    const header = (label) => `<div class="${p}-picker-header"><button type="button" class="${p}-picker-header-super-prev-btn"></button>`
      + `<div class="${p}-picker-header-view">${label}</div><button type="button" class="${p}-picker-header-super-next-btn"></button></div>`;
    const render = () => {
      const panel = dropdown.querySelector(`.${p}-picker-panel`);
      if (view === "year") {
        const decade = Math.floor(shown / 10) * 10;
        const years = Array.from({ length: 12 }, (_, i) => decade - 1 + i);
        panel.innerHTML = `<div class="${p}-picker-year-panel">${header(`${decade}-${decade + 9}`)}<div class="${p}-picker-body"><table><tbody><tr>`
          + `${years.map((year) => cell(year, year)).join("")}</tr></tbody></table></div></div>`;
        return;
      }
      const months = Array.from({ length: 12 }, (_, i) => cell(`${shown}-${String(i + 1).padStart(2, "0")}`, `${i + 1}月`)).join("");
      panel.innerHTML = `<div class="${p}-picker-month-panel">${header(`<button type="button" class="${p}-picker-year-btn">${shown}</button>`)}`
        + `<div class="${p}-picker-body"><table><tbody><tr>${months}</tr></tbody></table></div></div>`;
    };
    field.addEventListener("mousedown", () => {
      if (!dropdown) {
        dropdown = doc.createElement("div");
        dropdown.innerHTML = `<div class="${p}-picker-panel-container ${p}-picker-month-panel-container"><div class="${p}-picker-panel-layout"><div>`
          + `<div class="${p}-picker-panel"></div></div></div></div>`;
        dropdown.addEventListener("click", (event) => {
          const target = event.target;
          if (target.closest(`.${p}-picker-year-btn`)) { view = "year"; render(); return; }
          const step = target.closest(`.${p}-picker-header-super-prev-btn`) ? -10 : target.closest(`.${p}-picker-header-super-next-btn`) ? 10 : 0;
          if (step && view === "year") { shown += step; render(); return; }
          const td = target.closest("td[title]");
          if (!td) return;
          if (view === "year") { shown = Number(td.title); view = "month"; render(); return; }
          picked.push(`${field.id}=${td.title}`);
          field.value = td.title;
          dropdown.classList.add(`${p}-picker-dropdown-hidden`);
        });
        doc.body.append(dropdown);
      }
      dropdown.className = `${p}-picker-dropdown ${p}-picker-dropdown-placement-bottomLeft`;
      view = "month"; shown = field.value ? Number(field.value.slice(0, 4)) : 2026;
      render();
    });
  }
  return picked;
}

// 插件脚本放进 jsdom 的 window（改前的代码没有 antd-prefix.js，有就加载）。
function load(body) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of SCRIPTS) {
    const source = path.join(ROOT, file);
    if (fs.existsSync(source)) w.eval(fs.readFileSync(source, "utf8"));
  }
  return { w, doc: w.document, scan: () => w.ResumeProFieldScan.scanPage(w.document, { isVisible }).controls };
}

const control = (controls, label) => {
  const found = controls.find((entry) => entry.label === label);
  assert.ok(found, `scanned ${label}: ${controls.map((entry) => entry.label).join("、")}`);
  return found;
};
const targetOf = (found) => ({ kind: found.kind, element: found.element, elements: found.elements, root: found.root,
  controlKind: found.controlKind, pickerType: found.pickerType, hints: {} });
// 换回默认前缀比较：同一张表在两种前缀下扫出的结果。
const shape = (controls) => Array.from(controls, (entry) => ({ label: entry.label, kind: entry.controlKind, picker: entry.pickerType || "",
  root: String(entry.root.getAttribute("class") || entry.root.tagName).replace(/\batsx-/g, "ant-") }));

// --- 认前缀 ---------------------------------------------------------------------

test("the prefix is read from antd's own structure: a select's selector, or a form item's control-input-content", () => {
  const bySelect = load(`<div>${select("atsx", "edu")}</div>`);
  assert.deepEqual(plain(bySelect.w.ResumeProAntdPrefix.prefixes(bySelect.doc)), ["ant", "atsx"]);
  const byItem = load(item("atsx", "name", "姓名", input("atsx", "name")));
  assert.deepEqual(plain(byItem.w.ResumeProAntdPrefix.prefixes(byItem.doc.getElementById("name"))), ["ant", "atsx"]);
  const other = load(form("ant"));
  assert.deepEqual(plain(other.w.ResumeProAntdPrefix.prefixes(other.doc)), ["ant"]);
});

test("selectors keep the default prefix and add the page's own; a page with only ant- gets the same selector back", () => {
  const { w, doc } = load(form("atsx"));
  const antd = w.ResumeProAntdPrefix;
  assert.equal(antd.css(doc, ".ant-select, .el-select, [role=\"listbox\"]"), ".ant-select, .atsx-select, .el-select, [role=\"listbox\"]");
  assert.equal(antd.css(doc, ".ant-picker-month-panel td[title=\"2024-06\"]"),
    ".ant-picker-month-panel td[title=\"2024-06\"], .atsx-picker-month-panel td[title=\"2024-06\"]");
  assert.equal(antd.css(doc, ".el-select__selected-item:not(.el-select__input-wrapper), .el-select__tags-text"),
    ".el-select__selected-item:not(.el-select__input-wrapper), .el-select__tags-text");
  assert.equal(antd.token(doc.body, "atsx-select"), "ant-select");
  assert.equal(antd.token(doc.body, "arco-select"), "arco-select");
  assert.equal(antd.has(doc.querySelector(".atsx-select"), "ant-select"), true);
  const other = load(form("ant"));
  const selector = ".ant-select, .ant-cascader, .el-select";
  assert.equal(other.w.ResumeProAntdPrefix.css(other.doc, selector), selector);
});

// 只读页面：认前缀、扫描、读已选值都不改网页上的类名、样式和结构。
test("working out the prefix and scanning leave the page as it was", () => {
  const { w, doc, scan } = load(form("atsx"));
  const before = doc.documentElement.outerHTML;
  w.ResumeProAntdPrefix.prefixes(doc);
  const controls = scan();
  w.ResumeProCustomControls.readSelection(targetOf(control(controls, "最高学历")));
  w.ResumeProFillProbe.probePage(doc);
  assert.equal(doc.documentElement.outerHTML, before);
});

// 类名后缀像、结构不是 antd 4/5 的，都不算：arco 有 arco-picker-input，arco-vue、iView 有 X-form-item-label，
// iView、Semi 有 X-select-selection，Element、arco-vue、iView、Semi 有 X-select-dropdown。
const LOOKALIKES = {
  arco: `<div class="arco-row arco-form-item"><div class="arco-col arco-form-label-item"><label for="edu">最高学历</label></div>
    <div class="arco-col arco-form-item-wrapper"><div class="arco-form-item-control-wrapper"><div class="arco-form-item-control"><div class="arco-form-item-control-children">
    <div role="combobox" aria-haspopup="listbox" aria-expanded="false" class="arco-select arco-select-single"><div class="arco-select-view">
    <input id="edu" class="arco-select-view-input" readonly value=""><span class="arco-select-view-value">请选择</span></div></div></div></div></div></div></div>
    <div class="arco-row arco-form-item"><div class="arco-col arco-form-label-item"><label for="day">毕业时间</label></div>
    <div class="arco-col arco-form-item-wrapper"><div class="arco-form-item-control-wrapper"><div class="arco-form-item-control"><div class="arco-form-item-control-children">
    <div class="arco-picker arco-picker-size-default"><div class="arco-picker-input"><input id="day" placeholder="请选择日期" value=""></div>
    <div class="arco-picker-suffix"></div></div></div></div></div></div></div>`,
  "arco-vue": `<div class="arco-row arco-form-item"><div class="arco-col arco-form-item-label-col"><label class="arco-form-item-label">最高学历</label></div>
    <div class="arco-col arco-form-item-wrapper-col"><div class="arco-form-item-content-wrapper"><div class="arco-form-item-content">
    <span class="arco-select-view-single arco-select arco-select-view"><input class="arco-select-view-input" readonly placeholder="请选择"></span></div></div></div></div>`,
  iview: `<div class="ivu-form-item"><label class="ivu-form-item-label">最高学历</label><div class="ivu-form-item-content">
    <div class="ivu-select ivu-select-single"><div tabindex="0" class="ivu-select-selection"><div><span class="ivu-select-placeholder">请选择</span>
    <input type="text" readonly placeholder="请选择" class="ivu-select-input"></div></div><div class="ivu-select-dropdown" hidden></div></div></div></div>`,
  semi: `<div class="semi-form-field"><label class="semi-form-field-label"><div class="semi-form-field-label-text">最高学历</div></label>
    <div class="semi-form-field-main"><div class="semi-select semi-select-single" role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0">
    <div class="semi-select-selection"><input class="semi-input" readonly placeholder="请选择"></div></div></div></div>`,
  element: `<div class="el-form-item"><label class="el-form-item__label">最高学历</label><div class="el-form-item__content">
    <div class="el-select"><div class="el-input el-input--suffix"><input type="text" readonly placeholder="请选择" class="el-input__inner"></div></div></div></div>`,
  vant: `<div class="van-cell van-field"><div class="van-cell__title van-field__label"><label>最高学历</label></div>
    <div class="van-cell__value van-field__value"><div class="van-field__body"><input type="text" readonly class="van-field__control" placeholder="请选择"></div></div></div>`,
  // 自研的：xx-select 里是 xx-select-trigger，题目是 xx-form-item-label。
  "xx-select": `<div class="xx-form-item"><div class="xx-form-item-label">最高学历</div><div class="xx-form-item-control"><div class="xx-form-item-control-input">
    <div class="xx-select"><div class="xx-select-trigger"><input class="xx-select-input" readonly placeholder="请选择"></div></div></div></div></div>`
};
const LIBRARY = { arco: "arco", "arco-vue": "arco", iview: "iview", semi: "semi", element: "element", vant: "vant", "xx-select": "" };

for (const [name, html] of Object.entries(LOOKALIKES)) {
  test(`${name} is not taken for antd`, () => {
    const { w, doc, scan } = load(`<form>${html}</form>`);
    assert.deepEqual(plain(w.ResumeProAntdPrefix?.prefixes(doc) ?? ["ant"]), ["ant"]);
    const controls = scan();
    assert.ok(controls.length > 0, "the lookalike form is scanned");
    for (const found of controls) {
      assert.notEqual(found.pickerType, "antd", `${found.label} is no antd picker`);
      if (["custom-select", "cascader"].includes(found.controlKind)) {
        assert.notEqual(w.ResumeProCustomControls.describe(targetOf(found)).library, "antd", `${found.label} is no antd select`);
      }
      assert.equal(w.ResumeProFillProbe.describeControl({ kind: "element", element: found.element }).library, LIBRARY[name]);
    }
  });
}

// 类名里有冒号这类拼不进选择器的字符（Tailwind 的 md:x-select-selector）：不当前缀，也不让选择器出错。
test("a class that cannot go into a selector is never taken for a prefix", () => {
  const { w, doc } = load(`<div class="md:x-select"><div class="md:x-select-selector"></div></div>${form("ant")}`);
  assert.deepEqual(plain(w.ResumeProAntdPrefix.prefixes(doc)), ["ant"]);
  assert.doesNotThrow(() => doc.querySelectorAll(w.ResumeProAntdPrefix.css(doc, ".ant-select")));
});

// 前缀和网站自己的类名撞上（prefixCls="app"，页头是 app-header）：原来的类名照样比，页头还是页头。
test("a site's own class names still count when the antd prefix happens to match them", () => {
  const { w, doc, scan } = load(`<div class="app-header"><label>城市 <input id="city"></label></div><main>${form("app")}</main>`);
  assert.deepEqual(plain(w.ResumeProAntdPrefix?.prefixes(doc) ?? ["ant", "app"]), ["ant", "app"]);
  const labels = Array.from(scan(), (entry) => entry.label);
  assert.ok(labels.includes("最高学历"), labels.join("、"));
  assert.ok(!labels.includes("城市"), "the header is page chrome");
});

// #400 同源框架里的元素按框架自己的文档算前缀。
test("a same-origin frame's prefix is worked out from the frame's own document", async () => {
  const { w, doc } = load(`<main><h2>首页</h2><iframe id="apply"></iframe></main>`);
  const frame = doc.getElementById("apply");
  for (let i = 0; i < 100 && !frame.contentDocument?.body; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const inner = frame.contentDocument;
  inner.body.innerHTML = form("atsx");
  const antd = w.ResumeProAntdPrefix;
  assert.deepEqual(plain(antd.prefixes(doc.body)), ["ant"]);
  assert.deepEqual(plain(antd.prefixes(inner.getElementById("education"))), ["ant", "atsx"]);
  assert.equal(antd.css(doc.body, ".ant-picker"), ".ant-picker");
  assert.equal(antd.css(inner.body, ".ant-picker"), ".ant-picker, .atsx-picker");
  const controls = w.ResumeProFieldScan.scanPage(inner, { isVisible }).controls;
  assert.equal(control(controls, "毕业时间").pickerType, "antd");
});

// --- 扫描、读题目、选下拉、填日期 -------------------------------------------------

test("an atsx- form is scanned like the same form with ant-: titles, kinds, roots and the antd picker", () => {
  for (const readOnlyPicker of [false, true]) {
    const atsx = load(form("atsx", { readOnlyPicker })).scan();
    const main = load(form("ant", { readOnlyPicker })).scan();
    assert.deepEqual(shape(atsx), shape(main), `antd ${readOnlyPicker ? 4 : 5} picker`);
    assert.equal(control(atsx, "最高学历").controlKind, "custom-select");
    assert.ok(control(atsx, "最高学历").root.classList.contains("atsx-select"));
    assert.equal(control(atsx, "毕业时间").controlKind, "date-picker");
    assert.equal(control(atsx, "毕业时间").pickerType, "antd");
  }
});

test("an atsx- select is opened and picked from its own options", async () => {
  const { w, doc, scan } = load(form("atsx"));
  const picked = wire(doc, "atsx");
  const found = control(scan(), "最高学历");
  assert.equal(w.ResumeProCustomControls.describe(targetOf(found)).library, "antd");
  const api = w.ResumeProControls.create({ timeoutMs: 300, settleMs: 35, isVisible });
  const result = await api.operate(targetOf(found), "本科");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(picked, ["education=本科"]);
  assert.equal(result.observed.library, "antd");
  assert.equal(doc.querySelector(".atsx-select-selection-item").textContent, "本科");
});

test("the choice shown in an atsx- select is read back", () => {
  const { w, scan } = load(item("atsx", "education", "最高学历", select("atsx", "education", "硕士")));
  const found = control(scan(), "最高学历");
  assert.deepEqual(plain(w.ResumeProCustomControls.readSelection(targetOf(found))), { texts: ["硕士"], cascade: false });
  assert.equal(w.ResumeProCustomControls.hasExistingValue(targetOf(found)), true);
});

test("an atsx- month picker (antd 4 and 5) is filled through its calendar", async () => {
  for (const readOnlyPicker of [false, true]) {
    const { w, doc, scan } = load(form("atsx", { readOnlyPicker }));
    const picked = wire(doc, "atsx");
    const found = control(scan(), "毕业时间");
    assert.equal(found.pickerType, "antd");
    const api = w.ResumeProControls.create({ timeoutMs: 300, settleMs: 35, isVisible });
    const result = await api.operate({ ...targetOf(found), controlKind: "date" }, "2024-06");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(picked, ["graduation=2024-06"]);
    assert.equal(doc.getElementById("graduation").value, "2024-06");
    assert.equal(result.observed.library, "antd");
    assert.ok(doc.querySelector(".atsx-picker-dropdown").classList.contains("atsx-picker-dropdown-hidden"));
  }
});

// 诊断里的 lib= 和页面结构里的组件库计数照记 antd（feedback-core.js 的白名单不用加词）。
test("diagnostics name an atsx- control's library antd", () => {
  const { w, doc, scan } = load(form("atsx"));
  installLayout(w);
  const found = control(scan(), "最高学历");
  assert.equal(w.ResumeProFillProbe.describeControl({ kind: "element", element: found.element }).library, "antd");
  assert.deepEqual(plain(w.ResumeProFillProbe.probePage(doc).custom.byLibrary), { antd: 1 });
  assert.equal(w.ResumeProPageOutline.libraryOf(found.element), "antd");
});

// --- 整条一键填写：按 manifest 的顺序加载全部 content script，AI 用按题目名回答的替身 --------------

function shownValues(doc, p) {
  const value = (id) => doc.getElementById(id).value;
  return { 姓名: value("name"), 手机号码: value("phone"), 邮箱: value("email"),
    最高学历: doc.querySelector(`.${p}-select-selection-item`)?.textContent || "", 毕业院校: value("school"), 毕业时间: value("graduation"),
    性别: Array.from(doc.querySelectorAll("#gender input")).find((radio) => radio.checked)?.value || "" };
}

async function fillPage(p, { framed = false } = {}) {
  const page = await openFramedPage(framed
    ? { top: `<nav><a>首页</a></nav><iframe id="apply"></iframe>`, frames: { apply: `<main>${form(p)}</main>` }, values: ANSWERS }
    : { top: `<main><h2>基本信息</h2>${form(p)}</main>`, url: "https://demo.jobs.example.test/campus/position/apply", values: ANSWERS });
  const doc = framed ? page.frame("apply") : page.win.document;
  const picked = wire(doc, p);
  const result = await page.fill();
  return { result: { filledCount: result.filledCount, unfilledCount: result.unfilledCount, fieldCount: result.fieldCount },
    picked, values: shownValues(doc, p), labels: page.aiRequests.flatMap((request) => request.formFields.map((field) => field.label)) };
}

test("一键填写 fills an atsx- form the same way as the ant- form, also inside a same-origin frame", async () => {
  for (const framed of [false, true]) {
    const main = await fillPage("ant", { framed });
    assert.deepEqual(main.picked, ["education=本科", "graduation=2024-06"], `ant- ${framed ? "framed" : "top"}`);
    assert.equal(main.values.最高学历, "本科");
    const atsx = await fillPage("atsx", { framed });
    assert.deepEqual(atsx, main, framed ? "inside the frame" : "on the page");
  }
});

// 填完表单项还标着出错（只剩类名、没有提示文字）：和 ant- 一样算框架状态没同步。
// 输入框直接放在标红的表单项里（同 text-fill-lifecycle.test.js）；旁边一道完整的题让页面认得出前缀。
test("an atsx- form item still marked has-error after writing is reported like an ant- one", async () => {
  const reasons = {};
  for (const p of ["ant", "atsx"]) {
    const page = await openFramedPage({ top: `<form class="${p}-form">${item(p, "school", "毕业院校", input(p, "school"))}`
      + `<div class="${p}-form-item ${p}-form-item-has-error"><label for="name">姓名</label>${input(p, "name")}</div></form>` });
    const field = page.win.document.getElementById("name");
    const outcome = await page.hooks.operateControl({ kind: "element", element: field, elements: [field], root: field, controlKind: "text" }, "测试用户");
    reasons[p] = outcome.reason;
  }
  assert.equal(reasons.ant, "framework_state_unsynced");
  assert.deepEqual(reasons, { ant: "framework_state_unsynced", atsx: "framework_state_unsynced" });
});

// --- 表单晚出来、带时间的日期框、联想输入框 -----------------------------------------

// antd 5 的级联：rc-select 的外壳，根上同时有 X-select 和 X-cascader。
const cascader = (p, id) => `<div class="${p}-select ${p}-cascader ${p}-select-outlined ${p}-select-in-form-item ${p}-select-single ${p}-select-show-arrow">`
  + `<div class="${p}-select-selector"><span class="${p}-select-selection-search"><input type="search" id="${id}" autocomplete="off"`
  + ` class="${p}-select-selection-search-input" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-owns="${id}_list"`
  + ` aria-autocomplete="list" aria-controls="${id}_list" readonly unselectable="on" value=""></span>`
  + `<span class="${p}-select-selection-placeholder">请选择</span></div></div>`;

// 一键填写在表单出来之前点下去：零字段那一轮先探测过页面，那时只有 ant。表单紧接着才画出来（不到 1 秒）。
function lateForm() {
  const page = load("<main><p>加载中</p></main>");
  installLayout(page.w);
  page.w.ResumeProFillProbe.probePage(page.doc);
  assert.deepEqual(plain(page.w.ResumeProAntdPrefix.prefixes(page.doc)), ["ant"]);
  page.doc.querySelector("main").innerHTML = form("atsx").replace("</form>", `${item("atsx", "city", "期望城市", cascader("atsx", "city"))}</form>`);
  return page;
}

test("a form drawn right after the page was first looked at is scanned as atsx- antd at once", () => {
  const { w, scan } = lateForm();
  const controls = scan();
  assert.equal(control(controls, "毕业时间").pickerType, "antd");
  assert.equal(control(controls, "期望城市").controlKind, "cascader");
  assert.equal(w.ResumeProCustomControls.describe(targetOf(control(controls, "最高学历"))).library, "antd");
});

test("diagnostics taken right after the form appeared count its selects as antd", () => {
  const { w, doc } = lateForm();
  assert.deepEqual(plain(w.ResumeProFillProbe.probePage(doc).custom.byLibrary), { antd: 2 });
});

test("a select operated right after the form appeared is opened as an atsx- antd select", async () => {
  const { w, doc } = lateForm();
  const picked = wire(doc, "atsx");
  const root = doc.querySelector(".atsx-select:not(.atsx-cascader)"), field = root.querySelector("input");
  const api = w.ResumeProControls.create({ timeoutMs: 300, settleMs: 35, isVisible });
  const result = await api.operate({ kind: "element", element: field, elements: [field], root, controlKind: "custom-select", hints: {} }, "本科");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(picked, ["education=本科"]);
  assert.equal(result.observed.library, "antd");
});

// 2026-10-31 在 Chromium 里看到的 antd 5.21.6：TimePicker、带时间的 DatePicker 的框能打字，打的字合乎格式时失焦就收下；
// 弹层是 X-picker-time-panel，或 X-picker-datetime-panel 里一个日期面板加一个时间面板，下面有「确定」。
// antd 4.24.16 打的字失焦时不收（要点「确定」），这里不照它写。替身失焦就收起；框里的字合乎格式就收下，不合就换回原来的。
const TIMED = { time: { label: "可面试时间", placeholder: "请选择时间", format: /^\d{2}:\d{2}$/, value: "14:30" },
  arrive: { label: "到岗时间", placeholder: "请选择日期", format: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, value: "2025-01-02 09:00" } };
const timedPicker = (p, id, readOnly = false) => `<div class="${p}-picker ${p}-picker-outlined"><div class="${p}-picker-input">`
  + `<input${readOnly ? " readonly" : ""} autocomplete="off" size="10" id="${id}" placeholder="${TIMED[id].placeholder}" value="">`
  + `<span class="${p}-picker-suffix"><span role="img" aria-label="clock-circle" class="anticon anticon-clock-circle"></span></span></div></div>`;
function wireTimed(doc, p, picked) {
  const column = (type) => `<ul class="${p}-picker-time-panel-column" data-type="${type}">${["00", "01", "02"].map((text, i) => `<li class="${p}-picker-time-panel-cell" data-value="${i}">`
    + `<div class="${p}-picker-time-panel-cell-inner">${text}</div></li>`).join("")}</ul>`;
  const timePanel = `<div class="${p}-picker-time-panel"><div class="${p}-picker-content">${column("hour")}${column("minute")}</div></div>`;
  const datePanel = `<div class="${p}-picker-date-panel"><div class="${p}-picker-header"><button type="button" class="${p}-picker-header-super-prev-btn"></button>`
    + `<div class="${p}-picker-header-view"><button type="button" class="${p}-picker-month-btn">Oct</button><button type="button" class="${p}-picker-year-btn">2026</button></div>`
    + `<button type="button" class="${p}-picker-header-super-next-btn"></button></div><div class="${p}-picker-body"><table class="${p}-picker-content"><tbody><tr>`
    + `<td title="2026-10-01" class="${p}-picker-cell ${p}-picker-cell-in-view"><div class="${p}-picker-cell-inner">1</div></td></tr></tbody></table></div></div>`;
  for (const [id, spec] of Object.entries(TIMED)) {
    const field = doc.getElementById(id);
    if (!field) continue;
    let dropdown = null, committed = "";
    field.addEventListener("mousedown", () => {
      if (!dropdown) {
        dropdown = doc.createElement("div");
        const kind = id === "time" ? "time" : "datetime";
        dropdown.innerHTML = `<div class="${p}-picker-panel-container ${p}-picker-${kind}-panel-container"><div class="${p}-picker-panel-layout"><div><div class="${p}-picker-panel">`
          + (kind === "time" ? timePanel : `<div class="${p}-picker-datetime-panel">${datePanel}${timePanel}</div>`)
          + `<div class="${p}-picker-footer"><ul class="${p}-picker-ranges"><li class="${p}-picker-ok"><button type="button" class="${p}-btn ${p}-btn-primary ${p}-btn-sm">OK</button></li></ul></div>`
          + "</div></div></div></div>";
        doc.body.append(dropdown);
      }
      dropdown.className = `${p}-picker-dropdown ${p}-picker-dropdown-placement-bottomLeft`;
      dropdown.hidden = false;
    });
    field.addEventListener("focusout", () => {
      if (dropdown) { dropdown.hidden = true; dropdown.classList.add(`${p}-picker-dropdown-hidden`); }
      if (spec.format.test(field.value) && field.value !== committed) { committed = field.value; picked.push(`${id}=${committed}`); }
      else field.value = committed;
    });
  }
}

// antd 5 的 AutoComplete：根上有 X-select-auto-complete，框能打字，选中的建议直接写进框里，没有 X-select-selection-item。
// 替身：在选择框上按下鼠标展开建议，打字时只留下包含框里文字的建议，一条都没有就收起；点建议写进框里并收起。
const JOBS = ["前端工程师", "后端工程师"];
const autoComplete = (p, id) => `<div class="${p}-select ${p}-select-outlined ${p}-select-in-form-item ${p}-select-auto-complete ${p}-select-single ${p}-select-show-search">`
  + `<div class="${p}-select-selector"><span class="${p}-select-selection-search"><input type="search" id="${id}" autocomplete="off"`
  + ` class="${p}-select-selection-search-input" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-owns="${id}_list"`
  + ` aria-autocomplete="list" aria-controls="${id}_list" value=""></span><span class="${p}-select-selection-placeholder">请输入</span></div></div>`;
function wireAutoComplete(doc, p, picked) {
  for (const root of doc.querySelectorAll(`.${p}-select-auto-complete`)) {
    const selector = root.querySelector(`.${p}-select-selector`), field = root.querySelector("input");
    let dropdown = null;
    const show = () => {
      const list = JOBS.filter((text) => text.includes(field.value));
      if (!dropdown) { dropdown = doc.createElement("div"); doc.body.append(dropdown); }
      dropdown.className = `${p}-select-dropdown ${p}-select-dropdown-placement-bottomLeft`;
      dropdown.innerHTML = `<div><div role="listbox" id="${field.id}_list" data-w="0" data-h="0"></div><div class="rc-virtual-list"><div class="rc-virtual-list-holder"><div><div class="rc-virtual-list-holder-inner">`
        + list.map((text) => `<div aria-selected="false" class="${p}-select-item ${p}-select-item-option" title="${text}"><div class="${p}-select-item-option-content">${text}</div></div>`).join("")
        + "</div></div></div></div></div>";
      dropdown.querySelectorAll(`.${p}-select-item-option`).forEach((node) => node.addEventListener("click", () => {
        field.value = node.title;
        picked.push(`${field.id}=${node.title}`);
        root.querySelector(`.${p}-select-selection-placeholder`)?.remove();
        dropdown.hidden = true;
        field.setAttribute("aria-expanded", "false");
      }));
      dropdown.hidden = !list.length;
      field.setAttribute("aria-expanded", String(Boolean(list.length)));
    };
    selector.addEventListener("mousedown", show);
    field.addEventListener("input", show);
  }
}

const timedForm = (p, { readOnly = false } = {}) => `<form class="${p}-form ${p}-form-vertical">`
  + item(p, "name", "姓名", input(p, "name")) + item(p, "time", TIMED.time.label, timedPicker(p, "time", readOnly))
  + item(p, "arrive", TIMED.arrive.label, timedPicker(p, "arrive", readOnly)) + item(p, "job", "期望职位", autoComplete(p, "job"))
  + item(p, "intent", "意向岗位", autoComplete(p, "intent")) + "</form>";

// 期望职位在建议里，意向岗位（测试工程师）不在：AutoComplete 本来就能填建议里没有的字。
async function fillTimed(p) {
  const values = { 姓名: "测试用户", 可面试时间: TIMED.time.value, 到岗时间: TIMED.arrive.value, 期望职位: "前端工程师", 意向岗位: "测试工程师" };
  const page = await openFramedPage({ top: `<main><h2>基本信息</h2>${timedForm(p)}</main>`, url: "https://demo.jobs.example.test/campus/position/apply", values });
  const doc = page.win.document;
  const picked = [];
  wireTimed(doc, p, picked);
  wireAutoComplete(doc, p, picked);
  const result = await page.fill();
  const value = (id) => doc.getElementById(id).value;
  const openPopups = Array.from(doc.querySelectorAll(`.${p}-picker-dropdown, .${p}-select-dropdown`)).filter((node) => !node.hidden).length;
  return { result: { filledCount: result.filledCount, unfilledCount: result.unfilledCount, fieldCount: result.fieldCount }, picked: picked.sort(),
    values: { time: value("time"), arrive: value("arrive"), job: value("job"), intent: value("intent") }, openPopups };
}

test("time and date-time pickers that take typing, and AutoComplete boxes, are filled with ant- and atsx- alike", async () => {
  const main = await fillTimed("ant");
  assert.deepEqual(main, { result: { filledCount: 5, unfilledCount: 0, fieldCount: 5 },
    picked: ["arrive=2025-01-02 09:00", "job=前端工程师", "time=14:30"],
    values: { time: "14:30", arrive: "2025-01-02 09:00", job: "前端工程师", intent: "测试工程师" }, openPopups: 0 });
  assert.deepEqual(await fillTimed("atsx"), main);
});

// 框是只读的（inputReadOnly）：不往里写字，也不去点格子，报控件暂不支持，日历收起。
test("a read-only time picker is left untouched and reported unsupported", async () => {
  for (const p of ["ant", "atsx"]) {
    const page = await openFramedPage({ top: `<main>${timedForm(p, { readOnly: true })}</main>` });
    const doc = page.win.document;
    const picked = [];
    wireTimed(doc, p, picked);
    const found = page.win.ResumeProFieldScan.scanPage(doc, { isVisible }).controls.find((entry) => entry.label === "可面试时间");
    assert.equal(found?.pickerType, "antd", p);
    const outcome = await page.hooks.operateControl(found, "14:30");
    assert.equal(outcome.reason, "unsupported_control", `${p}: ${JSON.stringify(outcome)}`);
    assert.equal(doc.getElementById("time").value, "");
    assert.deepEqual(picked, []);
    assert.ok(doc.querySelector(`.${p}-picker-dropdown`).hidden, `${p}: the calendar is closed`);
  }
});
