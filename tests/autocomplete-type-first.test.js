// #301 联想框先打字再从建议里选：51job 的 el-autocomplete（#404）、大易 hotjob 的学校库和专业库（#407）、
// SuccessFactors 的 YUI 联想框（#377）。替身照各自的行为写：只在点了建议时记下值，失焦时没选就还原。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");

// 宿主替身：文本框按 content.js 的 runTextLifecycle 写（聚焦、写值、input、change、失焦），核对比较框里的字。
function load(html, options = {}) {
  const dom = new JSDOM(`<form>${html}</form>`, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const visible = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hidden || w.getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  const api = w.ResumeProControls.create({
    timeoutMs: 300, settleMs: 35, isVisible: visible,
    normalizeText: (el, value) => String(value ?? ""),
    runTextLifecycle: async (el, value, sequential, guard, didWrite) => {
      el.focus(); await tick();
      if (!guard()) return false;
      didWrite(); el.value = value;
      el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true }));
      await tick();
      if (!guard()) return false;
      el.blur();
      return true;
    },
    waitTextCommit: () => new Promise((resolve) => setTimeout(resolve, 10)),
    inspectText: (el, expected, committed) => el.value === expected ? { ok: true, reason: "" }
      : { ok: false, reason: committed ? "value_reverted" : "value_not_committed" },
    replayFocusBlur: async () => {}, prefersSequential: () => false,
    dispatchTextInput: (el) => el.dispatchEvent(new w.Event("input", { bubbles: true })),
    ...options
  });
  return { w, doc: w.document, api };
}

// 普通扫描得到的控件，和一键填写拿到的一样。
function scanned(doc, label) {
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls.find((item) => item.label === label);
  assert.ok(control, `scanned ${label}`);
  return { kind: "element", element: control.element, elements: control.elements, root: control.root, controlKind: control.controlKind, hints: {} };
}

// 51job 简历页的 el-autocomplete（Element UI 2）：聚焦时没有建议，打字后防抖再异步取建议；只有点了建议才写进表单的值，
// 失焦时框里换回表单的值（没选就还原）。建议框按 Tab、点页面别处收起。hot：聚焦时给的热门列表。
function job51({ schools = ["北京大学", "北京大学医学部", "北京交通大学"], hot = [], debounce = 20, fetchMs = 30, options } = {}) {
  const h = load(`<div class="el-form-item"><label class="el-form-item__label">学校</label><div class="el-form-item__content">
    <div class="el-autocomplete" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-owns="sugg-list">
      <div class="el-input"><input class="el-input__inner" type="text" autocomplete="off" role="textbox" aria-autocomplete="list" aria-controls="id"></div></div></div></div>
    <div class="el-autocomplete-suggestion el-popper" role="region" hidden><div class="el-scrollbar"><ul id="sugg-list" role="listbox" class="el-autocomplete-suggestion__list"></ul></div></div>`, options);
  const { doc } = h;
  const root = doc.querySelector(".el-autocomplete"), input = doc.querySelector("input"), popper = doc.querySelector(".el-autocomplete-suggestion");
  const state = { model: "", shown: [], activated: false, picks: [], keys: [] };
  const render = () => {
    const open = state.activated && state.shown.length > 0;
    root.setAttribute("aria-expanded", String(open));
    popper.hidden = !open;
    const list = popper.querySelector("ul");
    list.innerHTML = "";
    state.shown.forEach((text, index) => {
      const item = doc.createElement("li"); item.setAttribute("role", "option"); item.id = `sugg-${index}`; item.textContent = text;
      item.addEventListener("click", () => {
        state.picks.push(text); state.keys.push("pick"); state.model = text; input.value = text;
        Promise.resolve().then(() => { state.shown = []; render(); });
      });
      list.append(item);
    });
  };
  let timer = null;
  const fetchFor = (query) => {
    clearTimeout(timer);
    const key = (text) => text.toLowerCase().replace(/\s+/g, "");
    timer = setTimeout(() => setTimeout(() => { state.shown = query ? schools.filter((text) => key(text).includes(key(query))) : hot.slice(); render(); }, fetchMs), debounce);
  };
  input.addEventListener("focus", () => { state.activated = true; fetchFor(input.value === state.model ? "" : input.value); });
  input.addEventListener("input", () => fetchFor(input.value));
  input.addEventListener("blur", () => { if (input.value !== state.model) input.value = state.model; });
  for (const type of ["keydown", "keyup"]) input.addEventListener(type, (event) => state.keys.push(`${type}:${event.keyCode}`));
  input.addEventListener("keydown", (event) => { if (event.key === "Tab") { state.activated = false; render(); } });
  return { ...h, root, input, popper, state, target: scanned(doc, "学校") };
}

test("51job autocomplete with no suggestions on focus: the name is typed, then the same-named suggestion is picked", async () => {
  // #404：聚焦后没有建议，原来等满 2 秒报没有发现选项，改按文本框写，失焦就被还原，报 value_not_committed。
  const h = job51();
  assert.equal(h.target.controlKind, "custom-select");
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["北京大学"]);
  assert.equal(h.state.model, "北京大学");
  assert.equal(h.input.value, "北京大学");
  assert.equal(h.popper.hidden, true, "the suggestions are closed");
  const beforePick = h.state.keys.slice(0, h.state.keys.indexOf("pick"));
  assert.ok(beforePick.includes("keydown:0") && beforePick.includes("keyup:0"), h.state.keys.join());
  assert.ok(!beforePick.some((key) => /:(?:9|13|27|3[3-9]|40)$/.test(key)), "no Tab, Enter, Esc or arrow key before the pick");
  assert.equal(h.api.check(h.target).ok, true);
});

test("51job autocomplete: a suggestion that only contains the typed name is not picked", async () => {
  const h = job51({ schools: ["北京大学医学部", "北京大学深圳研究生院"] });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual(h.state.picks, []);
  assert.equal(h.state.model, "");
});

test("51job autocomplete showing a longer name on focus: it is not picked, and the typed name finds the same-named school", async () => {
  // 评审复现：聚焦时的热门列表里只有「北京大学医学部」，原来会点它并算填上。
  const h = job51({ hot: ["北京大学医学部", "清华大学"] });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["北京大学"]);
  assert.equal(h.state.model, "北京大学");
});

test("51job autocomplete with only longer names, on focus and after typing: nothing is picked and the field reads as not written", async () => {
  const h = job51({ hot: ["北京大学医学部", "清华大学"], schools: ["北京大学医学部"] });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, "value_not_committed");
  assert.deepEqual(h.state.picks, []);
  assert.equal(h.state.model, "");
});

test("51job autocomplete: a Latin name differing only in case and spaces counts as the same suggestion", async () => {
  const h = job51({ schools: ["Peking University", "Peking University Health Science Center"] });
  const result = await h.api.operate(h.target, "peking  university");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["Peking University"]);
});

test("51job autocomplete with real waits: a picked suggestion takes well under the old 2 s wait", async () => {
  // 0.4.4 上每个这样的框先等满 2 秒，再按文本框写，还是没填上（整页 53 秒）。
  const h = job51({ debounce: 300, fetchMs: 100, options: { timeoutMs: 2000, settleMs: 250 } });
  const started = Date.now();
  const result = await h.api.operate(h.target, "北京交通大学");
  const took = Date.now() - started;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(took < 2000, `took ${took}ms`);
});

// Element UI 2.15 的 el-autocomplete 本身（v-model 随打字更新，允许直接输入），照 autocomplete.vue 写：聚焦时取一次建议，
// 取建议时先弹出只有加载图标的建议框；每次回来的结果都直接换上，不管先后；点建议后下一拍清空建议；Tab 收起，之后回来的结果不再显示。
// sync：fetch-suggestions 同步回调（Element 文档的写法），不出加载图标，空字时给全部建议。
function elementStandard({ cities = ["广州市", "深圳市", "北京市", "上海市"], debounce = 30, fetchMs = 60, sync = false, options } = {}) {
  const h = load(`<div class="el-form-item"><label class="el-form-item__label">所在城市</label><div class="el-form-item__content">
    <div class="el-autocomplete" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-owns="city-list">
      <div class="el-input"><input class="el-input__inner" type="text" autocomplete="off" role="textbox" aria-autocomplete="list" aria-controls="id"></div></div></div></div>
    <div class="el-autocomplete-suggestion el-popper" role="region" hidden><div class="el-scrollbar"><ul id="city-list" role="listbox" class="el-autocomplete-suggestion__list"></ul></div></div>`, options);
  const { doc } = h;
  const root = doc.querySelector(".el-autocomplete"), input = doc.querySelector("input"), popper = doc.querySelector(".el-autocomplete-suggestion");
  const list = popper.querySelector("ul");
  const state = { activated: false, loading: false, suggestions: [], picks: [] };
  const render = () => {
    const open = (state.suggestions.length > 0 || state.loading) && state.activated;
    root.setAttribute("aria-expanded", String(open));
    popper.hidden = !open;
    list.innerHTML = state.loading ? `<li><i class="el-icon-loading"></i></li>` : "";
    if (state.loading) return;
    for (const text of state.suggestions) {
      const item = doc.createElement("li"); item.setAttribute("role", "option"); item.textContent = text;
      item.addEventListener("click", () => { state.picks.push(text); input.value = text; Promise.resolve().then(() => { state.suggestions = []; render(); }); });
      list.append(item);
    }
  };
  const getData = (query) => {
    if (sync) { state.suggestions = cities.filter((city) => !query || city.includes(query)); render(); return; }
    state.loading = true; render();
    setTimeout(() => { state.loading = false; state.suggestions = cities.filter((city) => !query || city.includes(query)); render(); }, fetchMs);
  };
  let timer = null;
  const debounced = (query) => { clearTimeout(timer); timer = setTimeout(() => getData(query), debounce); };
  input.addEventListener("focus", () => { state.activated = true; debounced(input.value); });
  input.addEventListener("input", () => debounced(input.value));
  input.addEventListener("keydown", (event) => { if (event.key === "Tab") { state.activated = false; render(); } });
  return { ...h, input, popper, state, target: scanned(doc, "所在城市") };
}

test("standard Element autocomplete loading on focus: the same-named city is picked and the late typed suggestions stay closed", async () => {
  // 真机（element-ui 2.15.14）：聚焦那次的结果先到、选中以后，插件打字引起的那次结果才到，建议框又弹出来。
  const h = elementStandard();
  const result = await h.api.operate(h.target, "深圳市");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["深圳市"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.popper.hidden, true, "the suggestions are closed");
  assert.equal(h.input.value, "深圳市");
});

test("standard Element autocomplete listing everything on focus: a longer name is not picked, the wanted name is typed", async () => {
  // 评审复现（Element 文档的写法，空字时给全部建议）：要填「北京大学」，原来点了「北京大学医学部」并算填上。
  const h = elementStandard({ cities: ["北京大学医学部", "北京交通大学", "清华大学"], sync: true });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, []);
  assert.equal(h.input.value, "北京大学");
});

test("standard Element autocomplete: a value with no suggestion is typed in without waiting the full 2 s for one", async () => {
  const h = elementStandard({ debounce: 300, fetchMs: 150, options: { timeoutMs: 2000, settleMs: 250 } });
  const started = Date.now();
  const result = await h.api.operate(h.target, "湖南省长沙市");
  const took = Date.now() - started;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "湖南省长沙市");
  assert.deepEqual(h.state.picks, []);
  assert.ok(took < 2500, `took ${took}ms`);
});

// 大易 hotjob 学校库：antd 输入框加自研的建议框（挂在 body 下，没有 ARIA），打字只是搜索；点了一项才记下，
// 失焦时框里换回记下的值、收起建议框。tip：没选时在表单项里显示校验提示（role=alert）。
function hotjob({ schools = ["北京大学", "北京大学医学部", "北京交通大学"], tip = false, fetchMs = 30 } = {}) {
  const h = load(`<div class="ant-row ant-form-item"><div class="ant-col ant-form-item-label"><label title="学校">学校</label></div>
    <div class="ant-col ant-form-item-control"><div class="ant-form-item-control-input"><div class="ant-form-item-control-input-content">
      <input class="ant-input" type="text" placeholder="请输入学校"></div></div><div class="explain-slot"></div></div></div>
    <div class="ant-row ant-form-item"><div class="ant-col ant-form-item-label"><label title="姓名">姓名</label></div>
    <div class="ant-col ant-form-item-control"><input class="ant-input" type="text"></div></div>`);
  const { doc } = h;
  const input = doc.querySelector("input");
  const state = { model: "", picks: [], dropdown: null };
  const close = () => { state.dropdown?.remove(); state.dropdown = null; };
  const showTip = (on) => {
    const slot = doc.querySelector(".explain-slot");
    slot.innerHTML = on ? `<div class="ant-form-item-explain ant-form-item-explain-connected"><div role="alert" class="ant-form-item-explain-error">请从列表中选择学校</div></div>` : "";
  };
  let timer = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    if (tip) showTip(input.value !== state.model);
    const query = input.value;
    timer = setTimeout(() => {
      close();
      if (!query || doc.activeElement !== input) return;
      const box = doc.createElement("div");
      box.className = "school-suggest";
      for (const text of schools.filter((school) => school.includes(query))) {
        const row = doc.createElement("div"); row.className = "school-suggest-row"; row.innerHTML = `<span>${text}</span>`;
        row.addEventListener("click", () => { state.picks.push(text); state.model = text; input.value = text; close(); if (tip) showTip(false); });
        box.append(row);
      }
      doc.body.append(box);
      state.dropdown = box;
    }, fetchMs);
  });
  input.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  input.addEventListener("blur", () => { clearTimeout(timer); close(); input.value = state.model; });
  return { ...h, input, state, target: scanned(doc, "学校") };
}

test("hotjob school box (plain text field): a refused value is typed again and the same-named suggestion is picked", async () => {
  // #407：学校、专业是普通文本框，写进去失焦就被还原，报 value_not_committed。
  const h = hotjob();
  assert.equal(h.target.controlKind, "text");
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["北京大学"]);
  assert.equal(h.input.value, "北京大学");
  assert.equal(h.state.dropdown, null, "the suggestions are closed");
  assert.equal(h.api.check(h.target).ok, true);
});

test("hotjob school box: a validation tip shown while typing is not taken for the suggestions", async () => {
  const h = hotjob({ tip: true });
  const result = await h.api.operate(h.target, "北京交通大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["北京交通大学"]);
});

test("hotjob school box: suggestions without the same name are not clicked, the box is restored and the reason says so", async () => {
  const h = hotjob({ schools: ["北京大学医学部", "北京大学深圳研究生院"] });
  // 表单在一个按 Esc 就关的对话框里（AntD Modal）：收起建议框不能按 Esc（#395）。
  const escapes = [];
  h.doc.addEventListener("keydown", (event) => { if (event.key === "Escape") escapes.push(event.target); });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.state.picks, []);
  assert.equal(h.input.value, "");
  assert.equal(h.state.dropdown, null, "the suggestions are closed");
  assert.notEqual(h.doc.activeElement, h.input);
  assert.equal(escapes.length, 0, "no Esc that a dialog around the form would close on");
});

test("hotjob school box: with only a validation tip and no suggestions the field still reads as not written", async () => {
  const h = hotjob({ schools: [], tip: true });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.reason, "value_not_committed", JSON.stringify(result));
  assert.equal(h.input.value, "");
});

test("a text box that only takes text typed with key events is filled on the second try", async () => {
  // 只在按键之后才记下框里的字（失焦时换回记下的值）：第一次写入没有按键，被还原；带按键再打一次就收下了。
  const h = load(`<div class="item"><label>英文名</label><input></div>`);
  const input = h.doc.querySelector("input");
  let model = "", keyed = false;
  input.addEventListener("keydown", () => { keyed = true; });
  input.addEventListener("input", () => { if (keyed) model = input.value; keyed = false; });
  input.addEventListener("blur", () => { input.value = model; });
  const result = await h.api.operate(scanned(h.doc, "英文名"), "Lily");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(model, "Lily");
  assert.equal(input.value, "Lily");
});

test("a text box the page simply refuses gets one more try and keeps its old reason", async () => {
  const h = load(`<div class="item"><label>邮编</label><input></div>`);
  const input = h.doc.querySelector("input");
  input.addEventListener("blur", () => { input.value = ""; });
  const result = await h.api.operate(scanned(h.doc, "邮编"), "100871");
  assert.equal(result.reason, "value_not_committed");
  assert.equal(input.value, "");
});

test("a text box the page rewrites into another value is not tried again", async () => {
  // 改了格式（不是还原）的框不是只认建议的联想框：不再打字、不等建议。
  const h = load(`<div class="item"><label>编号</label><input></div>`);
  const input = h.doc.querySelector("input");
  let keys = 0;
  input.addEventListener("keydown", () => { keys += 1; });
  input.addEventListener("blur", () => { input.value = `${input.value.toUpperCase()}-X`; });
  const result = await h.api.operate(scanned(h.doc, "编号"), "ab12");
  assert.equal(result.reason, "value_not_committed");
  assert.equal(keys, 0, "no second typing");
});

// SuccessFactors 的 juic.SFLegacyAutoComplete（改自 YUI 2 AutoComplete），照 2026-10 公开页的脚本写：
// 聚焦、点击都不查询；keyup 后停一会儿按框里的字查询，最多列 10 条，先高亮第一条；点 li 才算选中，
// 选中后框里换成这一项、建议框收起、aria-expanded=false。force（forceSelection）：失焦时没选就清空，关掉就留着打的字。
// Tab、回车选中高亮的那一条。aria：关掉就是原版 YUI 2，输入框上没有 ARIA。
function yui({ countries = ["Germany", "Georgia", "Ghana"], aria = true, force = true, value = "" } = {}) {
  const items = Array.from({ length: 10 }, (_, index) => `<li role="option" id="YUIListItem${index}" style="display:none"></li>`).join("");
  const h = load(`<div class="row"><label for="country">Country</label>
    <div class="yui-ac"><input id="country" type="text" class="yui-ac-input" ${aria ? 'role="combobox" aria-expanded="false"' : ""} autocomplete="off" value="${value}">
      <div id="country-box" class="yui-ac-container"><div class="yui-ac-content" style="display:none"><div class="yui-ac-hd" style="display:none"></div>
        <div class="yui-ac-bd"><ul role="listbox">${items}</ul></div><div class="yui-ac-ft" style="display:none"></div></div></div></div></div>`);
  const { doc } = h;
  const input = doc.querySelector("input"), content = doc.querySelector(".yui-ac-content"), list = Array.from(doc.querySelectorAll("li"));
  const state = { focused: false, selected: false, open: false, highlighted: null, queries: [], picks: [] };
  const toggle = (open) => { state.open = open; content.style.display = open ? "" : "none"; if (aria) input.setAttribute("aria-expanded", String(open)); if (!open) state.highlighted = null; };
  const select = (li) => { state.selected = true; state.picks.push(li.textContent); input.value = li.textContent; toggle(false); };
  const ignored = (code) => [9, 13, 16, 17, 18, 19, 20, 27, 33, 34, 35, 36, 37, 38, 39, 40, 44, 45, 229].includes(code);
  let timer = null;
  input.addEventListener("focus", () => { state.focused = true; });
  input.addEventListener("keydown", (event) => {
    if (event.keyCode === 27) return toggle(false);
    if ([9, 13].includes(event.keyCode)) { if (state.highlighted) select(state.highlighted); else toggle(false); return; }
    state.selected = false;
  });
  input.addEventListener("keyup", (event) => {
    if (ignored(event.keyCode)) return;
    const query = input.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.queries.push(query);
      if (!query) return toggle(false);
      const found = countries.filter((name) => name.toLowerCase().startsWith(query.toLowerCase().slice(0, 2))).slice(0, 10);
      if (!state.focused) return;
      list.forEach((li, index) => { li.textContent = found[index] || ""; li.style.display = found[index] ? "" : "none"; });
      state.highlighted = found.length ? list[0] : null;
      toggle(found.length > 0);
    }, 20);
  });
  doc.querySelector(".yui-ac-container").addEventListener("click", (event) => { const li = event.target.closest("li"); if (li) select(li); });
  input.addEventListener("blur", () => {
    if (force && !state.selected) input.value = "";
    toggle(false); state.focused = false;
  });
  return { ...h, input, content, state, target: scanned(doc, "Country") };
}

test("SuccessFactors YUI autocomplete: the name is typed with key events, then the same-named item is clicked", async () => {
  // #377：聚焦、点击都不打开建议框，原来报 options_not_rendered。
  const h = yui();
  assert.equal(h.target.controlKind, "custom-select");
  assert.equal(h.w.ResumeProCustomControls.describe(h.target).library, "yui");
  const result = await h.api.operate(h.target, "Ghana");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["Ghana"]);
  assert.deepEqual(h.state.queries, ["Ghana"]);
  assert.equal(h.input.value, "Ghana");
  assert.equal(h.input.getAttribute("aria-expanded"), "false");
  assert.equal(h.content.style.display, "none");
  assert.equal(h.api.check(h.target).ok, true);
});

test("SuccessFactors YUI autocomplete: without the same name nothing is picked and the box is put back", async () => {
  const h = yui({ countries: ["Germany", "Georgia", "Ghana"] });
  const escapes = [];
  h.doc.addEventListener("keydown", (event) => { if (event.key === "Escape") escapes.push(event.target); });
  const result = await h.api.operate(h.target, "Gernsey");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.state.picks, [], "the highlighted first item is not taken by Tab or Enter");
  assert.equal(h.input.value, "");
  assert.equal(h.content.style.display, "none");
  assert.equal(escapes.length, 0);
});

test("SuccessFactors YUI autocomplete already showing the wanted value: it is picked again, so leaving the box does not clear it", async () => {
  // forceSelection：这次没选过就失焦会清空框里的字，已经填着的也一样。
  const h = yui({ value: "Germany" });
  const result = await h.api.operate(h.target, "Germany");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["Germany"]);
  assert.equal(h.input.value, "Germany");
});

test("a plain YUI 2 autocomplete without ARIA that takes typed text stays a text box and keeps a value not in its list", async () => {
  // 原版 YUI 2 默认 forceSelection=false，允许直接输入：和 main 一样按文本框写。
  const h = yui({ aria: false, force: false });
  assert.equal(h.target.controlKind, "text");
  const result = await h.api.operate(h.target, "Munich");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "Munich");
  assert.deepEqual(h.state.picks, []);
});

test("a plain YUI 2 autocomplete without ARIA that forces a selection gets the same-named item on the second try", async () => {
  const h = yui({ aria: false });
  assert.equal(h.target.controlKind, "text");
  const result = await h.api.operate(h.target, "Georgia");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.state.picks, ["Georgia"]);
  assert.equal(h.input.value, "Georgia");
});

test("fill diagnostics name YUI and UI5 controls, and the report keeps them", () => {
  const probe = require("../fill-probe.js");
  const core = require("../feedback-core.js");
  const { doc } = load(`<div class="yui-ac"><input class="yui-ac-input" role="combobox"></div>
    <div class="sapMInput"><input class="sapMInputBaseInner" role="combobox"></div>`);
  const [yuiInput, ui5Input] = doc.querySelectorAll("input");
  assert.equal(probe.describeControl({ kind: "element", element: yuiInput }).library, "yui");
  assert.equal(probe.describeControl({ kind: "element", element: ui5Input }).library, "ui5");
  const report = core.fillReport({ fieldCount: 2, probe: { host: "", frames: { total: 0, crossOrigin: 0, frameInputs: 0 }, custom: { total: 2, byLibrary: { yui: 1, ui5: 1 } },
    editButtons: 0, locked: 0, shadowHosts: 0, elements: 10 },
  unfilledControls: [{ label: "学校", reasonCode: "no_option_match", control: { tag: "input", type: "text", role: "combobox", library: "yui" } }] });
  assert.match(report, /^custom_libraries: yui=1,ui5=1$/m);
  assert.match(report, /^- 学校: input\[text\] role=combobox lib=yui reason=no_option_match$/m);
});
