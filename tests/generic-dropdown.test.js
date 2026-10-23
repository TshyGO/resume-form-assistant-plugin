// #269 通用下拉路径：不是已适配的组件库、组件上也没有任何 ARIA 标记的下拉（北森 phoenix、Moka sd 这类自研组件），
// 普通一键填写和深度分析都走这一条：只认点开后新出现、贴着控件的弹层，按原文唯一匹配条目，点选后读回组件显示的文字核验。
// 合成组件按 2026-10-11 真机看到的结构写：弹层挂在 body 下，条目是只含一段文字的 div/span，Moka 选项「男/Male」中英双语。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");

function load(html) {
  const dom = new JSDOM(`<form>${html}</form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: (el) => !el.closest("[hidden]") });
  return { w, doc: w.document, api };
}

// 普通扫描得到的控件，和一键填写拿到的一样。
function scanned(doc, label) {
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls.find((item) => item.label === label);
  assert.ok(control, `scanned ${label}`);
  return { kind: "element", element: control.element, elements: control.elements, root: control.root, controlKind: control.controlKind, hints: {} };
}

function moka({ choices = ["男/Male", "女/Female"], onPick, searchable = false, twoPopups = false, keepOpen = false } = {}) {
  const h = load(`<div class="item"><label class="title">性别</label>
    <label class="sd-Input-container-3Fx sd-Select-container-9Qa select"><input class="sd-Input-input-7Kd" placeholder="请选择 / Please select"></label></div>
    <div class="err" hidden></div>`);
  const { doc } = h;
  const input = doc.querySelector("input");
  const clicks = [];
  const open = (list) => {
    const popup = doc.createElement("div");
    popup.className = "sd-Dropdown-dropdown-2Lm";
    for (const text of list) {
      const item = doc.createElement("div");
      item.className = "sd-Menu-content-item-5Rt";
      item.innerHTML = `<div class="option-label-8Hn">${text}</div>`;
      item.addEventListener("click", () => {
        clicks.push(text); (onPick || ((t) => { input.value = t; }))(text);
        if (!keepOpen) popup.remove();
      });
      popup.append(item);
    }
    doc.body.append(popup);
    return popup;
  };
  if (searchable) {
    input.addEventListener("input", () => { if (input.value) open(choices.filter((text) => text.includes(input.value))); });
  } else {
    input.addEventListener("click", () => {
      open(choices);
      if (twoPopups) open(choices);
      // 页面自己的校验提示也会在点开时出现：不能被当成弹层。
      const error = doc.querySelector(".err"); error.hidden = false; error.textContent = "请选择性别";
    });
  }
  return { ...h, input, clicks, target: scanned(doc, "性别") };
}

// 北森新版 phoenix-select：弹层挂在 body 下，自带搜索框，选项文字在 span.item-text-label 里；选中的文字显示在组件里，输入框保持空。
function beisen(choices = ["汉族", "回族", "满族"], firstScreen = 3) {
  const h = load(`<div class="form-item"><label class="form-item__text">民族</label><div class="form-item__content">
    <div class="phoenix-select phoenix-select--editable phoenix-select--large"><ul class="phoenix-select__content">
      <li class="phoenix-select__selected"></li>
      <li class="phoenix-select__inputWrapper"><input class="phoenix-select__input phoenix-select__input--large phoenix-select__input--unText"></li>
    </ul></div></div></div>`);
  const { doc } = h;
  const root = doc.querySelector(".phoenix-select");
  const clicks = [];
  root.addEventListener("click", () => {
    const layer = doc.createElement("div");
    layer.innerHTML = `<div><div class="common-unmodeled-layer common-unmodeled-layer-placement-bottomLeft"><div class="common-unmodeled-layer__layerContent">
      <div class="constant-main-selector-container"><div class="phoenix-input"><input class="phoenix-input__input"></div>
      <div class="constant-main-layer-container"><div class="list"></div></div></div></div></div></div>`;
    const list = layer.querySelector(".list");
    const search = layer.querySelector("input");
    const render = () => {
      list.innerHTML = "";
      const shown = search.value ? choices.filter((choice) => choice.includes(search.value)) : choices.slice(0, firstScreen);
      for (const text of shown) {
        const item = doc.createElement("div");
        item.className = "list-item-container";
        // 真机（2026-10-21 金发）：点击处理挂在里层的 span.item-text-label 上，外层的行不响应。
        const row = doc.createElement("div");
        item.innerHTML = `<span class="item-text-label no-hover"><span><span>${text}</span></span></span>`;
        item.querySelector(".item-text-label").addEventListener("click", () => { clicks.push(text); root.querySelector(".phoenix-select__selected").textContent = text; layer.remove(); });
        row.append(item);
        list.append(row);
      }
    };
    search.addEventListener("input", render);
    render();
    doc.body.append(layer);
    // Esc 不管用，点页面空白处才关（同真机）。
    const outside = (event) => { if (!layer.contains(event.target) && !root.contains(event.target)) { layer.remove(); doc.removeEventListener("mousedown", outside, true); } };
    doc.addEventListener("mousedown", outside, true);
  });
  return { ...h, root, clicks, target: scanned(doc, "民族") };
}

test("the ordinary scan reads Beisen phoenix-select and Moka sd-Select as one dropdown each", () => {
  const b = beisen();
  assert.equal(b.target.controlKind, "custom-select");
  assert.ok(b.target.root.classList.contains("phoenix-select"));
  const m = moka();
  assert.equal(m.target.controlKind, "custom-select");
  assert.ok(m.target.root.classList.contains("select"));
  assert.equal(m.w.ResumeProCustomControls.describe(m.target).library, "generic");
});

test("class words that do not mean a select box keep a text field a text field", () => {
  const { doc } = load(`<div class="item"><label>城市</label><div class="select-none"><input></div></div>
    <div class="item"><label>学校</label><div class="school-autocomplete"><input></div></div>`);
  const kinds = Object.fromEntries(scanner.scanPage(doc, { isVisible: () => true }).controls.map((item) => [item.label, item.controlKind]));
  assert.deepEqual(kinds, { 城市: "text", 学校: "text" });
});

test("Beisen: the new layer next to the component is used and the shown text confirms the choice", async () => {
  const h = beisen();
  const result = await h.api.operate(h.target, "回族");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["回族"]);
  assert.equal(h.api.check(h.target).ok, true);
  h.root.querySelector(".phoenix-select__selected").textContent = "";
  assert.equal(h.api.check(h.target).reason, "value_reverted");
});

test("Beisen: an option outside the first screen is found through the layer's own search box", async () => {
  const h = beisen(["汉族", "回族", "满族", "蒙古族"], 3);
  const typedInto = [];
  h.doc.addEventListener("input", (event) => typedInto.push(event.target.className), true);
  const result = await h.api.operate(h.target, "蒙古族");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["蒙古族"]);
  assert.deepEqual(typedInto.filter((name) => name.includes("phoenix-select__input")), [], "the component's own input is left alone");
  assert.ok(typedInto.some((name) => name.includes("phoenix-input__input")), "the layer's search box was used");
});

test("Moka: the bilingual option is chosen by its Chinese part", async () => {
  const h = moka();
  const result = await h.api.operate(h.target, "男");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["男/Male"]);
  assert.equal(h.input.value, "男/Male");
  assert.equal(h.api.check(h.target).ok, true);
});

test("a component that shows only the Chinese part after selecting is accepted too", async () => {
  const h = moka({ onPick: (text) => { h.input.value = text.split("/")[0]; } });
  assert.equal((await h.api.operate(h.target, "女")).ok, true);
  assert.equal(h.input.value, "女");
});

test("no matching option fails without clicking anything, and a tried search is put back", async () => {
  const h = moka({ choices: ["汉族", "回族"] });
  const result = await h.api.operate(h.target, "苗族");
  assert.equal(result.ok, false);
  assert.ok(["no_option_match", "options_timeout"].includes(result.reason), result.reason);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.input.value, "");
});

test("two popups appearing at once is ambiguous: nothing is chosen", async () => {
  const h = moka({ twoPopups: true });
  const result = await h.api.operate(h.target, "男");
  assert.equal(result.reason, "ambiguous_popup");
  assert.deepEqual(h.clicks, []);
});

test("a component that rolls back the choice is not counted as filled", async () => {
  const h = moka({ onPick: () => { h.input.value = ""; } });
  const result = await h.api.operate(h.target, "男");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "selection_not_committed");
});

test("a type-to-search dropdown (school, major) gets the value typed, then the matching suggestion is picked", async () => {
  const h = moka({ searchable: true, choices: ["示例理工大学", "示例师范大学"] });
  const result = await h.api.operate(h.target, "示例理工大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["示例理工大学"]);
});

test("typed text that only looks right is not a selection while the suggestions stay open", async () => {
  // 点了建议但组件没收起弹层、框里还是我们打的字：分不清是搜索词还是选中值，不算成功。
  const h = moka({ searchable: true, keepOpen: true, choices: ["示例理工大学"], onPick: () => {} });
  const result = await h.api.operate(h.target, "示例理工大学");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "selection_not_committed");
});

test("a type-to-search dropdown with no matching suggestion restores what was in the box", async () => {
  const h = moka({ searchable: true, choices: ["示例师范大学"] });
  const result = await h.api.operate(h.target, "示例理工大学");
  assert.equal(result.ok, false);
  assert.equal(h.input.value, "", "the typed query is put back");
  assert.deepEqual(h.clicks, []);
});

test("dates are not picked from a generic popup: calendar cells cannot be told apart", async () => {
  const h = moka({ choices: ["2001", "2002", "5", "1"] });
  const result = await h.api.operate(h.target, "2001-05-01");
  assert.equal(result.reason, "unsupported_control");
  assert.deepEqual(h.clicks, []);
});

test("cascaders stay unsupported on the generic path: no guessing which column is which", async () => {
  const h = moka();
  const result = await h.api.operate({ ...h.target, controlKind: "cascader" }, "广东省 / 深圳市");
  assert.equal(result.reason, "unsupported_control");
  assert.deepEqual(h.clicks, []);
});

test("an ARIA combobox keeps the ARIA rules: an unmarked popup it does not point to is never used", async () => {
  const h = moka();
  h.input.setAttribute("role", "combobox");
  h.input.setAttribute("aria-controls", "missing-list");
  assert.equal(h.w.ResumeProCustomControls.describe(h.target).library, "aria");
  const result = await h.api.operate(h.target, "男");
  assert.equal(result.ok, false);
  assert.deepEqual(h.clicks, [], "the ARIA path does not pick from an unassociated popup");
});

test("Beisen: a failed choice closes the layer it opened, so the next field starts clean", async () => {
  const h = beisen(["汉族", "回族"]);
  const result = await h.api.operate(h.target, "苗族");
  assert.equal(result.ok, false);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.doc.querySelector(".common-unmodeled-layer"), null, "the layer is closed after the failure");
});

test("a calendar opened from a select-like box is refused without clicking a cell", async () => {
  const h = load(`<div class="form-item"><label class="form-item__text">发布时间</label><div class="form-item__content">
    <div class="phoenix-select phoenix-select--editable"><ul class="phoenix-select__content"><li class="phoenix-select__inputWrapper"><input class="phoenix-select__input"></li></ul></div></div></div>`);
  const clicks = [];
  const root = h.doc.querySelector(".phoenix-select");
  root.addEventListener("click", () => {
    const layer = h.doc.createElement("div");
    layer.className = "common-unmodeled-layer";
    layer.innerHTML = `<div class="phoenix-date-picker"><div>2026年</div><div>10月</div>${Array.from({ length: 31 }, (_, i) => `<div class="cell">${i + 1}</div>`).join("")}<div class="cell">2023</div></div>`;
    layer.addEventListener("click", (event) => clicks.push(event.target.textContent));
    h.doc.body.append(layer);
  });
  const result = await h.api.operate(scanned(h.doc, "发布时间"), "2023");
  assert.equal(result.reason, "unsupported_control");
  assert.deepEqual(clicks, []);
});

test("Element UI: an input whose readonly flag flips while open keeps the same guard snapshot and reads its label", async () => {
  // 2026-10-21 智联真机：Element UI 下拉点开时输入框变成只读、收起后又可编辑。快照不能因此变化，
  // 否则写入前复查会当成用户改了字段，整次填写停下。
  const h = load(`<div class="el-form-item"><label>学历</label><div class="el-select"><div class="el-input"><input class="el-input__inner" placeholder="请选择您的学历"></div></div></div>`);
  const input = h.doc.querySelector("input");
  const target = scanned(h.doc, "学历");
  const controls = h.w.ResumeProCustomControls;
  const before = controls.snapshot(target);
  input.readOnly = true;
  assert.equal(controls.snapshot(target), before, "opening the dropdown is not a user edit");
  input.readOnly = false;
  input.value = "本科";
  assert.equal(JSON.stringify(controls.readSelection(target).texts), JSON.stringify(["本科"]), "the label shown in the editable input is the selection");
});

test("Element UI filterable select: opening it moves the label into the placeholder, and the guard snapshot stays the same", () => {
  // 2026-10-21 智联真机：已有「学士」的下拉一展开，输入框清空、变成可编辑，「学士」挪到占位提示里。
  const h = load(`<div class="el-form-item"><label>学位</label><div class="el-select"><div class="el-input"><input class="el-input__inner" readonly placeholder="请选择您的学位" value="学士"></div></div></div>`);
  const input = h.doc.querySelector("input");
  const target = scanned(h.doc, "学位");
  const controls = h.w.ResumeProCustomControls;
  const closed = controls.snapshot(target);
  input.readOnly = false; input.value = ""; input.placeholder = "学士";
  assert.equal(controls.snapshot(target), closed, "the open state shows the same selection");
  input.readOnly = true; input.value = "学士"; input.placeholder = "请选择您的学位";
  assert.equal(controls.snapshot(target), closed);
  // 没选过的下拉展开时占位提示不变：仍然是空的选择。
  input.value = ""; const empty = controls.snapshot(target);
  input.readOnly = false;
  assert.equal(controls.snapshot(target), empty);
});

test("Beisen radio-and-confirm picker: the radio icon is clicked, then the layer's single 确定 commits", async () => {
  // 2026-10-21 金发真机（民族、政治面貌）：选项前面是 SVG 单选圈，只有点圈才算勾上（「已选 1/1」），
  // 点文字不算；勾上后要点底部「确定」，组件里才显示所选文字。SVG 没有 click()。
  const h = load(`<div class="form-item"><label class="form-item__text">民族</label><div class="form-item__content">
    <div class="phoenix-select phoenix-select--editable"><ul class="phoenix-select__content"><li class="phoenix-select__selected"></li>
    <li class="phoenix-select__inputWrapper"><input class="phoenix-select__input"></li></ul></div></div></div>`);
  const root = h.doc.querySelector(".phoenix-select");
  const events = [];
  root.addEventListener("click", () => {
    let picked = "";
    const layer = h.doc.createElement("div");
    layer.className = "common-unmodeled-layer";
    layer.innerHTML = `<div class="phoenix-input"><input class="phoenix-input__input"></div><div class="list">${["汉族", "回族", "满族"].map((text) => `<div><div class="list-item-container"><span class="icon-container"><svg class="RadioUnchecked"><path d="M0 0"></path></svg></span><span class="item-text-label"><span><span>${text}</span></span></span></div></div>`).join("")}</div>
      <div class="selected">已选 0/1</div><div class="footer"><div class="phoenix-button"><div class="phoenix-button__content">取消</div></div><div class="phoenix-button"><div class="phoenix-button__content">确定</div></div></div>`;
    layer.querySelectorAll(".list-item-container").forEach((row) => {
      row.querySelector("svg").addEventListener("click", () => { picked = row.textContent.trim(); events.push(`radio:${picked}`); layer.querySelector(".selected").textContent = "已选 1/1"; });
      row.querySelector(".item-text-label").addEventListener("click", () => events.push("text"));
    });
    const [cancel, ok] = layer.querySelectorAll(".phoenix-button__content");
    cancel.addEventListener("click", () => { events.push("cancel"); layer.remove(); });
    ok.addEventListener("click", () => { events.push("ok"); if (picked) root.querySelector(".phoenix-select__selected").textContent = picked; layer.remove(); });
    h.doc.body.append(layer);
  });
  const target = scanned(h.doc, "民族");
  const result = await h.api.operate(target, "回族");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(events, ["radio:回族", "ok"]);
  assert.equal(h.api.check(target).ok, true);
});

// 文本框的写入流程替身：照真实流程写值、派发事件，核对时比较框里的字。
function textDeps(w) {
  return {
    normalizeText: (el, value) => String(value ?? ""),
    runTextLifecycle: async (el, value, sequential, guard, didWrite) => {
      if (!guard()) return false;
      didWrite(); el.value = value;
      el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true }));
      return true;
    },
    waitTextCommit: async () => {},
    inspectText: (el, expected) => ({ ok: el.value === expected, reason: el.value === expected ? "" : "value_not_committed" }),
    replayFocusBlur: async () => {}, prefersSequential: () => false, dispatchTextInput: () => {}
  };
}

test("Element autocomplete (school name): with no matching suggestion the name is typed in like a text box", async () => {
  // 2026-10-21 智联真机：学校名称是 el-autocomplete，允许直接输入；建议里没有时原来报「没有发现选项」。
  const h = load(`<div class="el-form-item"><label>学校名称</label><div class="el-autocomplete" role="combobox" aria-haspopup="listbox" aria-owns="sugg">
    <div class="el-input"><input class="el-input__inner" role="textbox" aria-autocomplete="list" aria-controls="sugg" placeholder="请填写学校全称"></div></div></div>
    <div id="sugg" role="listbox" hidden></div>`);
  const api = h.w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: (el) => !el.closest("[hidden]"), ...textDeps(h.w) });
  const result = await api.operate(scanned(h.doc, "学校名称"), "示例理工大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.doc.querySelector("input").value, "示例理工大学");
});

test("a searchable ARIA combobox that is not an autocomplete never gets free text", async () => {
  const h = load(`<div class="item"><label>学历</label><input role="combobox" aria-controls="opts" aria-autocomplete="list"></div><div id="opts" role="listbox" hidden></div>`);
  const api = h.w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: (el) => !el.closest("[hidden]"), ...textDeps(h.w) });
  const result = await api.operate(scanned(h.doc, "学历"), "本科");
  assert.equal(result.ok, false);
  assert.equal(h.doc.querySelector("input").value, "");
});

function phoenixRadios() {
  // 2026-10-22 金发真机：性别是 div 拼的单选组，没有 input；点 div.phoenix-radio 选中，选中后带 --checked。
  const h = load(`<div class="form-item"><label class="form-item__text">性别</label><div class="form-item__control"><div class="phoenix-radio-group">
    ${["男", "女"].map((text) => `<div class="phoenix-radio-group__radioItem"><div class="phoenix-radio phoenix-radio--withLabel"><div class="phoenix-radio__wrapper">
      <div class="phoenix-radio__circle-wrapper"><div class="phoenix-radio__circle"></div><div class="phoenix-radio__dot"></div></div>
      <span class="phoenix-radio__radio-text">${text}</span></div></div></div>`).join("")}</div></div></div>
    <div class="form-item"><label class="form-item__text">姓名</label><div class="form-item__control"><input class="phoenix-input__input"></div></div>`);
  const clicks = [];
  h.doc.querySelectorAll(".phoenix-radio").forEach((radio) => radio.addEventListener("click", () => {
    clicks.push(radio.textContent.trim());
    h.doc.querySelectorAll(".phoenix-radio").forEach((other) => other.classList.toggle("phoenix-radio--checked", other === radio));
  }));
  return { ...h, clicks };
}

test("Beisen div radio group: scanned as one radio question whose options are the two divs", () => {
  const h = phoenixRadios();
  const controls = scanner.scanPage(h.doc, { isVisible: () => true }).controls;
  const radio = controls.find((control) => control.label === "性别");
  assert.equal(radio.kind, "radio");
  assert.equal(radio.custom, true);
  assert.deepEqual(radio.elements.map((el) => el.textContent.trim()), ["男", "女"]);
  assert.equal(controls.find((control) => control.controlKind === "text").label, "姓名", "the next question keeps its own title");
});

test("Beisen div radio group: the option is clicked and only its own --checked state counts", async () => {
  const h = phoenixRadios();
  const control = scanner.scanPage(h.doc, { isVisible: () => true }).controls.find((item) => item.label === "性别");
  const target = { kind: "radio", elements: control.elements, root: control.root, controlKind: "radio" };
  const result = await h.api.operate(target, "女");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["女"]);
  assert.equal(h.api.check(target).ok, true);
  assert.equal((await h.api.operate(target, "未知")).reason, "no_option_match");
});

test("Beisen div radio group: a component that ignores the click is not counted", async () => {
  const h = phoenixRadios();
  h.doc.querySelectorAll(".phoenix-radio").forEach((radio) => radio.replaceWith(radio.cloneNode(true)));
  const control = scanner.scanPage(h.doc, { isVisible: () => true }).controls.find((item) => item.label === "性别");
  const result = await h.api.operate({ kind: "radio", elements: control.elements, root: control.root, controlKind: "radio" }, "男");
  assert.equal(result.ok, false);
});

// #269 日历：北森 phoenix（选到日、带输入框；或只选到月）和 Element（只读框，按 年 → 月 → 日 逐级点）。
// 合成日历按 2026-10-22 真机看到的结构写，今天固定为 2026-10-22。
function calendarHost({ kind = "phoenix-day", typing = true, futureDisabled = false, disabledAttr = false } = {}) {
  const h = load(`<div class="form-item"><label class="form-item__text">日期</label><div class="form-item__control">
    ${kind === "element" ? `<div class="el-date-editor el-input"><input class="el-input__inner" readonly placeholder="请选择日期"></div>`
      : `<div class="phoenix-select phoenix-select--editable"><ul class="phoenix-select__content"><li class="phoenix-select__selected"></li><li class="phoenix-select__inputWrapper"><input class="phoenix-select__input"></li></ul></div>`}
    </div></div>`);
  const { doc } = h;
  const commit = (text) => {
    if (kind === "element") doc.querySelector(".el-date-editor input").value = text;
    else doc.querySelector(".phoenix-select__selected").textContent = text;
    layer?.remove(); layer = null;
  };
  let layer = null, year = 2026, month = 10, panel = kind === "phoenix-month" ? "month" : "date";
  const clicks = [];
  const render = () => {
    const dayCells = () => {
      const first = new Date(year, month - 1, 1).getDay() || 7, days = new Date(year, month, 0).getDate();
      const cells = [];
      for (let i = 1; i < first; i++) cells.push(`<td class="prev-month"><span>${28 + i}</span></td>`);
      for (let d = 1; d <= days; d++) {
        const future = futureDisabled && (year > 2026 || (year === 2026 && (month > 10 || (month === 10 && d > 22))));
        cells.push(disabledAttr ? `<td class="available" data-day="${d}" ${future ? "disabled" : ""}><span>${d}</span></td>`
          : `<td class="${future ? "disabled" : "available"}" data-day="${d}"><span>${d}</span></td>`);
      }
      return `<table><tbody><tr>${cells.join("")}</tr></tbody></table>`;
    };
    const head = kind === "element"
      ? `<button class="el-date-picker__prev-btn el-icon-d-arrow-left"></button><button class="el-date-picker__prev-btn el-icon-arrow-left"></button><span class="el-date-picker__header-label year">${year} 年</span><span class="el-date-picker__header-label month">${month} 月</span><button class="el-date-picker__next-btn el-icon-arrow-right"></button><button class="el-date-picker__next-btn el-icon-d-arrow-right"></button>`
      : `<a class="phoenix-calendar-prev-year-btn"></a><span class="phoenix-calendar-year-select">${year}${panel === "month" ? "" : "年"}</span>${panel === "date" ? `<span class="phoenix-calendar-month-select">${month}月</span>` : ""}<a class="phoenix-calendar-next-year-btn"></a>`;
    const body = panel === "date" ? dayCells()
      : panel === "month" ? `<table><tbody><tr>${Array.from({ length: 12 }, (_, i) => `<td data-month="${i + 1}"><a>${kind === "element" ? ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"][i] : i + 1}月</a></td>`).join("")}</tr></tbody></table>`
      : `<table><tbody><tr>${Array.from({ length: 10 }, (_, i) => `<td data-year="${2020 + i - (2020 - Math.floor(year / 10) * 10)}"><a>${Math.floor(year / 10) * 10 + i}</a></td>`).join("")}</tr></tbody></table>`;
    const input = kind === "phoenix-day" && typing ? `<input class="phoenix-calendar-input" value="${year}-${String(month).padStart(2, "0")}-01">` : "";
    layer.innerHTML = `<div class="${kind === "element" ? "el-picker-panel el-date-picker" : "phoenix-date-picker"}">${input}<div class="header">${head}</div>${body}</div>`;
  };
  const open = () => {
    if (layer) return;
    layer = doc.createElement("div"); layer.className = "common-unmodeled-layer";
    layer.addEventListener("click", (event) => {
      const el = event.target, cls = String(el.className || "");
      clicks.push(el.textContent.trim() || cls);
      if (/prev-btn el-icon-d-arrow|prev-year/.test(cls)) year -= panel === "year" ? 10 : 1;
      else if (/next-btn el-icon-d-arrow|next-year/.test(cls)) year += panel === "year" ? 10 : 1;
      else if (/prev-btn el-icon-arrow-left/.test(cls)) { month -= 1; if (!month) { month = 12; year -= 1; } }
      else if (/next-btn el-icon-arrow-right/.test(cls)) { month += 1; if (month > 12) { month = 1; year += 1; } }
      else if (/year/.test(cls) && /header-label|year-select/.test(cls)) panel = "year";
      else if (/month-select/.test(cls)) panel = "month";
      else if (el.closest("td[data-year]")) { year = Number(el.closest("td").dataset.year || el.textContent); panel = kind === "phoenix-month" || kind === "element" || kind === "phoenix-day" ? "month" : "date"; }
      else if (el.closest("td[data-month]")) { month = Number(el.closest("td").dataset.month); if (kind === "phoenix-month") return commit(`${year}-${String(month).padStart(2, "0")}`); panel = "date"; }
      else if (el.closest("td.available")) return commit(`${year}-${String(month).padStart(2, "0")}-${String(el.closest("td").dataset.day).padStart(2, "0")}`);
      else return;
      render();
    });
    layer.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const value = layer.querySelector("input").value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) { clicks.push(`typed:${value}`); commit(value); }
    });
    doc.body.append(layer); render();
  };
  const trigger = kind === "element" ? doc.querySelector(".el-date-editor input") : doc.querySelector(".phoenix-select");
  trigger.addEventListener(kind === "element" ? "focus" : "click", open);
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls[0];
  const target = kind === "element"
    ? { kind: "element", element: control.element, root: control.root, controlKind: "date", pickerType: "element", hints: {} }
    : { kind: "element", element: control.element, elements: control.elements, root: control.root, controlKind: control.controlKind, hints: {} };
  const shown = () => kind === "element" ? doc.querySelector(".el-date-editor input").value : doc.querySelector(".phoenix-select__selected").textContent;
  return { ...h, target, clicks, shown };
}

test("Beisen day calendar with its own date box: the date is typed and confirmed with Enter", async () => {
  const h = calendarHost({ kind: "phoenix-day" });
  const result = await h.api.operate(h.target, "2001-05-01");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.shown(), "2001-05-01");
  assert.deepEqual(h.clicks, ["typed:2001-05-01"]);
});

test("Beisen day calendar without a date box: year, month and day are clicked in turn", async () => {
  const h = calendarHost({ kind: "phoenix-day", typing: false });
  const result = await h.api.operate(h.target, "2019-07-15");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.shown(), "2019-07-15");
});

test("Beisen month calendar: the year arrows reach the year, then the month is clicked", async () => {
  const h = calendarHost({ kind: "phoenix-month" });
  const result = await h.api.operate(h.target, "2023-07");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.shown(), "2023-07");
  assert.equal(result.observed.dayDefaulted, undefined);
});

test("Element date picker (read-only box): only year and month known, so the 1st is chosen and reported", async () => {
  const h = calendarHost({ kind: "element", futureDisabled: true });
  const result = await h.api.operate(h.target, "2023-07");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.shown(), "2023-07-01");
  assert.equal(result.observed.dayDefaulted, true);
});

test("a day the calendar does not allow (future) is not chosen", async () => {
  const h = calendarHost({ kind: "element", futureDisabled: true });
  const result = await h.api.operate(h.target, "2026-10-28");
  assert.equal(result.ok, false);
  assert.equal(h.shown(), "");
});

test("a field container marked with an error class keeps its title", () => {
  // 2026-10-22 金发真机：校验后给整行加 first-error-field，原来连题目一起被当成错误提示跳过。
  const { doc } = load(`<div class="fields-col first-error-field"><div class="form-item"><label class="form-item__text">出生日期</label>
    <div class="phoenix-select"><ul class="phoenix-select__content"><li class="phoenix-select__inputWrapper"><input class="phoenix-select__input"></li></ul></div>
    <span class="form-item__error">必填</span></div></div>`);
  assert.deepEqual(scanner.scanPage(doc, { isVisible: () => true }).controls.map((control) => control.label), ["出生日期"]);
});

test("a read-only display box stacked on a date picker is not a separate field, so the title stays with the picker", () => {
  // 2026-10-22 智联真机「离职时间」：只读显示框和真正的日期框叠在同一位置，上面盖着遮罩。
  const { w, doc } = load(`<div class="el-form-item"><label class="el-form-item__label">离职时间</label><div class="el-form-item__content">
    <div class="apply-form-date-now"><div class="apply-form-date-now__inner"><div class="apply-form-date-now__mask"></div>
      <div class="el-input apply-form-date-now__ipt"><input class="el-input__inner overlay" readonly placeholder="请选择离职时间"></div></div>
      <div class="el-date-editor el-input"><input class="el-input__inner real" readonly placeholder="请选择离职时间"></div></div></div></div>`);
  const rect = { left: 28, top: 453, width: 308, height: 30, right: 336, bottom: 483, x: 28, y: 453 };
  w.HTMLElement.prototype.getBoundingClientRect = function () { return this.tagName === "INPUT" ? rect : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; };
  const controls = scanner.scanPage(doc, { isVisible: () => true }).controls;
  assert.equal(controls.length, 1);
  assert.equal(controls[0].label, "离职时间");
  assert.equal(controls[0].controlKind, "date-picker");
  assert.ok(controls[0].element.classList.contains("real"));
});

test("Element: picking the month that the hidden day table already shows still moves on to the day", async () => {
  // 2026-10-22 智联真机：Element 的日/年/月三张表都在页面里，只切换显示。日历停在 2023 年 9 月、要填 2022-09：
  // 选完 2022 后隐藏的日期表已经换成 2022 年 9 月，再点「九月」只是切回日期表、整块文字不变。
  const h = load(`<div class="el-form-item"><label>入学时间</label><div class="el-date-editor el-input"><input class="el-input__inner" readonly></div></div>`);
  const { doc } = h;
  const input = doc.querySelector("input");
  let year = 2023, month = 9, view = "date", panel = null;
  const months = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  const draw = () => {
    const days = new Date(year, month, 0).getDate();
    panel.innerHTML = `<div class="el-date-picker__header"><span class="el-date-picker__header-label year">${view === "year" ? "2020 年 - 2029 年" : `${year} 年`}</span>
      <span class="el-date-picker__header-label month" ${view === "date" ? "" : "hidden"}>${month} 月</span></div>
      <table class="el-date-table" ${view === "date" ? "" : "hidden"}><tr>${Array.from({ length: days }, (_, i) => `<td class="available"><span>${i + 1}</span></td>`).join("")}</tr></table>
      <table class="el-year-table" ${view === "year" ? "" : "hidden"}><tr>${Array.from({ length: 10 }, (_, i) => `<td><a class="cell">${2020 + i}</a></td>`).join("")}</tr></table>
      <table class="el-month-table" ${view === "month" ? "" : "hidden"}><tr>${months.map((m) => `<td><a class="cell">${m}月</a></td>`).join("")}</tr></table>`;
  };
  input.addEventListener("focus", () => {
    if (panel) return;
    panel = doc.createElement("div"); panel.className = "el-picker-panel el-date-picker el-popper";
    panel.addEventListener("click", (event) => {
      const el = event.target;
      if (el.matches(".year")) view = "year";
      else if (el.closest(".el-year-table")) { year = Number(el.textContent); view = "month"; }
      else if (el.closest(".el-month-table")) { month = months.indexOf(el.textContent.replace("月", "")) + 1; view = "date"; }
      else if (el.closest(".el-date-table")) { input.value = `${year}-${String(month).padStart(2, "0")}-${String(el.textContent).padStart(2, "0")}`; panel.remove(); panel = null; return; }
      else return;
      // 只改显示：先把标题和日期表换成新年月，表都留在页面里。
      draw();
    });
    doc.body.append(panel); draw();
  });
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls[0];
  const result = await h.api.operate({ kind: "element", element: control.element, root: control.root, controlKind: "date", pickerType: "element", hints: {} }, "2022-09");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(input.value, "2022-09-01");
});

test("same year, other month, and no month arrows: the month title opens the month table", async () => {
  // CodeRabbit（PR #329）：北森日历只有年份箭头，同年换月原来找不到「下一月」就失败。
  const h = calendarHost({ kind: "phoenix-day", typing: false });
  const result = await h.api.operate(h.target, "2026-03-05");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.shown(), "2026-03-05");
});

test("a day marked unavailable only by a disabled attribute is not clicked", async () => {
  const h = calendarHost({ kind: "element", futureDisabled: true, disabledAttr: true });
  const result = await h.api.operate(h.target, "2026-10-28");
  assert.equal(result.ok, false);
  assert.equal(h.shown(), "");
});

test("buttons and counters in a picker layer are not options: a value spelled like a button is not matched to it", async () => {
  const h = load(`<div class="form-item"><label class="form-item__text">结果</label><div class="phoenix-select"><ul class="phoenix-select__content"><li class="phoenix-select__inputWrapper"><input class="phoenix-select__input"></li></ul></div></div>`);
  const root = h.doc.querySelector(".phoenix-select");
  const events = [];
  root.addEventListener("click", () => {
    const layer = h.doc.createElement("div");
    layer.innerHTML = `<div class="list"><div><span class="item-text-label">待定</span></div><div><span class="item-text-label">通过</span></div></div>
      <div class="selected">已选 0/1</div><div class="phoenix-button"><div class="phoenix-button__content">确定</div></div>`;
    layer.addEventListener("click", (event) => events.push(event.target.textContent.trim()));
    h.doc.body.append(layer);
  });
  const result = await h.api.operate(scanned(h.doc, "结果"), "确定");
  assert.equal(result.ok, false);
  assert.ok(!events.includes("确定"), JSON.stringify(events));
});

test("a box seen as a dropdown that never opens anything is reported, not typed into and counted", async () => {
  // 审查 B5/A7（第二轮）：没弹出列表就按文本框打字，组件没选中、框里却留着字，会被当成填上（假成功）。现在如实报没填上。
  const h = load(`<div class="item"><label>备注</label><div class="form-select-wrap"><input class="plain"></div></div>`);
  const api = h.w.ResumeProControls.create({ timeoutMs: 150, settleMs: 35, isVisible: (el) => !el.closest("[hidden]"), ...textDeps(h.w) });
  const target = scanned(h.doc, "备注");
  assert.equal(target.controlKind, "custom-select");
  const result = await api.operate(target, "按时到岗");
  assert.equal(result.ok, false);
  assert.equal(h.doc.querySelector("input").value, "", "the trial text is put back");
});

test("options that load a moment after opening are waited for instead of jumping to the search box", async () => {
  // 2026-10-22 金发真机：页面刚打开时第一次点开「民族」，选项还在加载，原来立刻改去搜索框输入，等不到就失败。
  const h = beisen();
  const root = h.root;
  const original = root.cloneNode(true);
  root.replaceWith(original);
  const searched = [];
  original.addEventListener("click", () => {
    const layer = h.doc.createElement("div");
    layer.innerHTML = `<div class="common-unmodeled-layer"><div class="phoenix-input"><input class="phoenix-input__input"></div><div class="list"><div class="hint">请在左侧选择内容</div><div class="hint">暂未选择</div></div><div class="footer"><div class="phoenix-button__content">取消</div><div class="phoenix-button__content">确定</div></div></div>`;
    layer.querySelector("input").addEventListener("input", (event) => searched.push(event.target.value));
    h.doc.body.append(layer);
    setTimeout(() => {
      layer.querySelector(".list").innerHTML = ["汉族", "回族", "满族"].map((text) => `<div class="list-item-container"><span class="item-text-label">${text}</span></div>`).join("");
      layer.querySelectorAll(".list-item-container").forEach((row) => row.addEventListener("click", () => {
        original.querySelector(".phoenix-select__selected").textContent = row.textContent.trim(); layer.remove();
      }));
    }, 60);
  });
  const target = scanned(h.doc, "民族");
  const result = await h.api.operate(target, "回族");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(searched, [], "the search box is not used while the list is still loading");
});

test("a dropdown already showing the wanted value is not opened again", async () => {
  // 2026-10-22 金发真机：民族已是「汉族」时再填「汉族」，「勾选 + 确定」式弹层右侧「已选」栏又列出一个「汉族」，
  // 原来点开后分不清两个同名选项，报「选项存在歧义」。显示的就是要填的值时不用点开。
  const h = beisen();
  h.root.querySelector(".phoenix-select__selected").textContent = "回族";
  const result = await h.api.operate(h.target, "回族");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, []);
  assert.equal(h.doc.querySelector(".common-unmodeled-layer"), null, "nothing was opened");
});

test("a covering element with words on it is never clicked; the box itself is clicked instead", async () => {
  // 审查 B6：盖在输入框上的若是写着「提交」之类的元素，不点它。
  const h = moka();
  const cover = h.doc.createElement("div"); cover.textContent = "提交";
  let coverClicks = 0; cover.addEventListener("click", () => coverClicks++);
  h.input.parentElement.append(cover);
  h.input.getBoundingClientRect = () => ({ left: 10, top: 10, width: 200, height: 30, right: 210, bottom: 40 });
  h.doc.elementFromPoint = () => cover;
  const result = await h.api.operate(h.target, "男");
  assert.equal(coverClicks, 0);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("a dropdown root that also holds the title and the placeholder reads as empty", () => {
  // 审查 B7：外层类名带 select 的整行被当成组件根，里面的题目「学历」和「请选择」不是已选值。
  const h = load(`<div class="form-select-row"><label class="row-label">学历</label><div class="row-placeholder">请选择</div><input class="row-input"></div>`);
  const input = h.doc.querySelector("input");
  const target = { kind: "element", element: input, root: h.doc.querySelector(".form-select-row"), controlKind: "custom-select" };
  assert.equal(h.w.ResumeProCustomControls.hasExistingValue(target), false);
  assert.equal(JSON.stringify(h.w.ResumeProCustomControls.readSelection(target).texts), "[]");
});

test("a list of 1-30 without a year/month title is a dropdown, not a calendar", async () => {
  // 审查 A10：「班级排名」这类数字下拉原来会被当成日历而报不支持。
  const h = moka({ choices: Array.from({ length: 30 }, (_, i) => String(i + 1)) });
  const result = await h.api.operate(h.target, "5");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["5"]);
});

test("a div radio group whose options are long sentences is still one question", () => {
  // 审查 A11：选项超过 20 字时原来整组都不认。
  const long = "是，我已经仔细阅读并同意以上全部条款、隐私说明与背景调查授权";
  assert.ok(long.length > 20 && long.length <= 40);
  const { doc } = load(`<div class="form-item"><label class="form-item__text">声明</label><div class="phoenix-radio-group">
    ${[long, "否，暂不同意"].map((text) => `<div class="phoenix-radio-group__radioItem"><div class="phoenix-radio"><span class="phoenix-radio__circle"></span><span class="phoenix-radio__radio-text">${text}</span></div></div>`).join("")}</div></div>`);
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls.find((item) => item.label === "声明");
  assert.equal(control?.kind, "radio");
  assert.equal(control.elements.length, 2);
});

test("Element: typing into an open filterable select changes the guard snapshot, so the write-before check sees it", () => {
  // 审查 A8/B10：展开时打字原来被认为看不出来。实际已选值从「学士」变成打的字，快照不同，写入前复查会停下。
  const h = load(`<div class="el-form-item"><label>学位</label><div class="el-select"><div class="el-input"><input class="el-input__inner" readonly placeholder="请选择您的学位" value="学士"></div></div></div>`);
  const input = h.doc.querySelector("input");
  const target = scanned(h.doc, "学位");
  const controls = h.w.ResumeProCustomControls;
  const closed = controls.snapshot(target);
  input.readOnly = false; input.value = ""; input.placeholder = "学士";
  assert.equal(controls.snapshot(target), closed, "opening by the plugin is not an edit");
  input.value = "硕";
  assert.notEqual(controls.snapshot(target), closed, "the user's typing is an edit");
});

test("a neighbouring yes/no question whose style changes when the dropdown opens is never taken as its popup", async () => {
  // 审查 B11（第三轮）：点开下拉时，紧挨着的另一道「是/否」单选题因为校验样式变化被记下，原来可能被当成弹层、点到别的题。
  const h = load(`<div class="item"><label class="title">是否党员</label>
    <label class="sd-Select-container-9Qa select"><input class="sd-Input-input-7Kd"></label></div>
    <div class="item adjust"><label class="title">是否接受调剂</label><div class="phoenix-radio-group">
      <div class="phoenix-radio-group__radioItem"><div class="phoenix-radio yes"><span class="phoenix-radio__circle"></span><span>是</span></div></div>
      <div class="phoenix-radio-group__radioItem"><div class="phoenix-radio"><span class="phoenix-radio__circle"></span><span>否</span></div></div></div></div>`);
  const input = h.doc.querySelector(".sd-Input-input-7Kd");
  const neighbour = h.doc.querySelector(".adjust");
  let neighbourClicks = 0;
  neighbour.addEventListener("click", () => neighbourClicks++);
  input.addEventListener("click", () => {
    neighbour.classList.add("is-active");
    setTimeout(() => {
      const popup = h.doc.createElement("div");
      popup.className = "sd-Dropdown-dropdown-2Lm";
      popup.innerHTML = `<div class="opt">是</div><div class="opt">否</div>`;
      popup.querySelectorAll(".opt").forEach((opt) => opt.addEventListener("click", () => { input.value = opt.textContent; popup.remove(); }));
      h.doc.body.append(popup);
    }, 60);
  });
  const result = await h.api.operate(scanned(h.doc, "是否党员"), "是");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(input.value, "是");
  assert.equal(neighbourClicks, 0, "the neighbouring question is untouched");
});
