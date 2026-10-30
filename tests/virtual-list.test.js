// #301 虚拟列表只画出看得见的十来项：「唯一包含」只在画出来的几项里唯一，同名的一项可能还在屏外。
// 替身按 2026-10-31 在 Chromium 里跑真 antd 4.24.16 / 5.21.6、Element Plus 2.8.8 看到的结构写：
// antd 不管长短都套着 rc-virtual-list，超过一屏（8 项）才在虚拟滚动，这时多出 .rc-virtual-list-scrollbar；
// el-select-v2 的列表在 .el-vl__wrapper > .el-vl__window 里，选项绝对定位。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");

const visible = (el) => !el.closest("[hidden]");
function load(control) {
  const dom = new JSDOM(`<form><div class="form-item"><label>毕业院校</label>${control}</div></form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: visible });
  return { w, doc: w.document, api };
}
// 一百所学校：要的「北京大学」排在第 61 项，第一屏里只有「北京大学医学部」。
const SCHOOLS = Array.from({ length: 100 }, (_, i) => i === 0 ? "北京大学医学部" : i === 60 ? "北京大学" : `示例大学${String(i).padStart(3, "0")}`);

// AntD 4/5 Select：showSearch 时输入框能打字，按选项文字筛选（antd 默认的 filterOption）。一屏画 10 项。
function antd(choices, { search = false } = {}) {
  const h = load(`<div class="ant-select ant-select-single${search ? " ant-select-show-search" : ""}"><div class="ant-select-selector">
    <span class="ant-select-selection-search"><input type="search" autocomplete="off" class="ant-select-selection-search-input" role="combobox"
      aria-haspopup="listbox" aria-owns="rc_select_0_list" aria-autocomplete="list" aria-controls="rc_select_0_list" aria-expanded="false"${search ? "" : " readonly"}></span>
    <span class="ant-select-selection-placeholder">请选择</span></div></div>`);
  const { doc } = h;
  const root = doc.querySelector(".ant-select"), input = root.querySelector("input");
  const picked = [], searches = [];
  let dropdown = null;
  const choose = (text) => {
    picked.push(text);
    root.querySelector(".ant-select-selection-placeholder")?.remove();
    const item = doc.createElement("span"); item.className = "ant-select-selection-item"; item.title = text; item.textContent = text;
    root.querySelector(".ant-select-selector").append(item);
    input.value = ""; dropdown.hidden = true; input.setAttribute("aria-expanded", "false");
  };
  const render = () => {
    const items = choices.filter((text) => text.includes(input.value));
    if (!dropdown) {
      dropdown = doc.createElement("div"); dropdown.className = "ant-select-dropdown ant-select-dropdown-placement-bottomLeft";
      doc.body.append(dropdown);
    }
    dropdown.hidden = false; input.setAttribute("aria-expanded", "true");
    const virtual = items.length > 8;
    dropdown.innerHTML = `<div><div role="listbox" id="rc_select_0_list" style="height: 0px; width: 0px; overflow: hidden;">${items.slice(0, 2)
      .map((text, index) => `<div aria-label="${text}" role="option" id="rc_select_0_list_${index}">${text}</div>`).join("")}</div>
      <div class="rc-virtual-list" style="position: relative;"><div class="rc-virtual-list-holder" style="max-height: 256px; overflow-y: hidden;">
      <div${virtual ? ` style="height: ${items.length * 32}px; position: relative; overflow: hidden;"` : ""}><div class="rc-virtual-list-holder-inner"></div></div></div>
      ${virtual ? '<div class="rc-virtual-list-scrollbar rc-virtual-list-scrollbar-vertical"><div class="rc-virtual-list-scrollbar-thumb"></div></div>' : ""}</div></div>`;
    const inner = dropdown.querySelector(".rc-virtual-list-holder-inner");
    for (const text of items.slice(0, 10)) {
      const item = doc.createElement("div"); item.className = "ant-select-item ant-select-item-option"; item.title = text;
      item.innerHTML = `<div class="ant-select-item-option-content">${text}</div>`;
      item.addEventListener("click", () => choose(text));
      inner.append(item);
    }
  };
  root.querySelector(".ant-select-selector").addEventListener("click", () => render());
  input.addEventListener("input", () => { searches.push(input.value); setTimeout(render, 10); });
  const target = { kind: "element", element: input, elements: [input], root, controlKind: "custom-select", hints: {} };
  return { ...h, target, picked, searches };
}

test("AntD 4/5 virtual list: a longer name on the first screen is not taken for the wanted one off screen", async () => {
  const h = antd(SCHOOLS);
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.picked, [], "北京大学医学部 is not chosen");
});

test("AntD 4/5 virtual list with search: the wanted name is searched for and the same name is chosen", async () => {
  const h = antd(SCHOOLS, { search: true });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.picked, ["北京大学"]);
  assert.deepEqual(h.searches, ["北京大学"]);
});

test("AntD 4/5 virtual list with search: two longer names on the first screen lead to a search, not ambiguous_option", async () => {
  const schools = ["北京大学医学部", "北京大学深圳研究生院", ...SCHOOLS.slice(2)];
  const h = antd(schools, { search: true });
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.picked, ["北京大学"]);
});

test("AntD 4/5 virtual list: the same name on the first screen is chosen as before, without searching", async () => {
  const h = antd(SCHOOLS, { search: true });
  const result = await h.api.operate(h.target, "示例大学003");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.picked, ["示例大学003"]);
  assert.deepEqual(h.searches, []);
});

test("AntD 4/5 short list (no virtual scrolling): a unique partial match is still chosen", async () => {
  const h = antd(["大专", "本科", "硕士研究生", "博士研究生", "其他"]);
  const result = await h.api.operate(h.target, "大学本科");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.picked, ["本科"]);
});

// Element Plus el-select-v2：根和 el-select 一样是 .el-select，选中的文字在 .el-select__placeholder 里。一屏画 11 项。
function selectV2(choices) {
  const h = load(`<div class="el-select"><div class="el-select__wrapper"><div class="el-select__selection">
    <div class="el-select__selected-item el-select__input-wrapper is-hidden"><input aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false"
      class="el-select__input" role="combobox" readonly type="text"></div>
    <div class="el-select__selected-item el-select__placeholder is-transparent"><span>请选择</span></div></div></div></div>`);
  const { doc } = h;
  const root = doc.querySelector(".el-select"), input = root.querySelector("input");
  const picked = [];
  let popper = null;
  root.querySelector(".el-select__wrapper").addEventListener("click", () => {
    if (!popper) {
      popper = doc.createElement("div"); popper.className = "el-popper is-pure is-light el-select__popper";
      popper.innerHTML = `<div class="el-select-dropdown"><div class="el-vl__wrapper"><div class="el-vl__window el-select-dropdown__list" style="position: relative; overflow-y: scroll; height: 274px;">
        <div style="height: ${choices.length * 34}px; width: 100%;">${choices.slice(0, 11).map((text, i) => `<li class="el-select-dropdown__item" style="position: absolute; top: ${i * 34}px; height: 34px;"><span>${text}</span></li>`).join("")}</div></div>
        <div role="presentation" class="el-virtual-scrollbar"><div class="el-scrollbar__thumb"></div></div></div></div>`;
      popper.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
        picked.push(li.textContent);
        const shown = root.querySelector(".el-select__placeholder");
        shown.classList.remove("is-transparent"); shown.innerHTML = `<span>${li.textContent}</span>`;
        popper.hidden = true; input.setAttribute("aria-expanded", "false");
      }));
      doc.body.append(popper);
    }
    popper.hidden = false; input.setAttribute("aria-expanded", "true");
  });
  const target = { kind: "element", element: input, elements: [input], root, controlKind: "custom-select", hints: {} };
  return { ...h, target, picked };
}

test("Element Plus el-select-v2: a longer name on the first screen is not taken for the wanted one off screen", async () => {
  const h = selectV2(SCHOOLS);
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.picked, []);
});

test("Element Plus el-select-v2: the same name on the first screen is chosen", async () => {
  const h = selectV2(SCHOOLS);
  const result = await h.api.operate(h.target, "示例大学005");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.picked, ["示例大学005"]);
});

// jsdom 没有排版：box(el) 给出元素的排版位置和高度（滚动层另给内容高度），没给的都是 0。
// 看到的大小（getBoundingClientRect）一律是 0，和弹层打开动画从 scale(0) 起的那一刻一样。
function stubLayout(w, box) {
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return box(this)?.height ?? 0; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetTop", { configurable: true, get() { return box(this)?.top ?? 0; } });
  Object.defineProperty(w.Element.prototype, "scrollHeight", { configurable: true, get() { return box(this)?.scrollHeight ?? box(this)?.height ?? 0; } });
  Object.defineProperty(w.Element.prototype, "clientHeight", { configurable: true, get() { return box(this)?.clientHeight ?? box(this)?.height ?? 0; } });
}

test("AntD 4/5 nine options (virtual scrolling, but all drawn): a unique partial match is still chosen while the popup opens from scale(0)", async () => {
  // 真 antd：9 项超过一屏（256px）就有虚拟滚动条，但 9 项全画出来了；刚画出时弹层是 scale(0)、看到的大小为 0。
  const h = antd(["选项一", "选项二", "选项三", "选项四", "选项五", "选项六", "选项七", "选项八", "本科"]);
  stubLayout(h.w, (el) => {
    const item = el.closest?.(".ant-select-item-option");
    if (item) return { top: Array.from(item.parentElement.children).indexOf(item) * 32, height: 32 };
    if (el.matches?.(".rc-virtual-list-holder")) return { top: 0, height: 256, scrollHeight: 288, clientHeight: 256 };
    return null;
  });
  const result = await h.api.operate(h.target, "大学本科");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.picked, ["本科"]);
});

// 没有虚拟列表类名时按排版判断（真浏览器里都按这个）：给 Element UI 2 结构的下拉补上高度。
// 选项每项 34px，滚动层高 274px，列表上下各 6px 内边距。rendered 是画出来的项数（自己做的虚拟列表只画前 10 项）。
function elementUi(choices, rendered) {
  const h = load(`<div class="el-select"><div class="el-input el-input--suffix"><input type="text" readonly autocomplete="off" placeholder="请选择" class="el-input__inner"></div></div>`);
  const { w, doc } = h;
  const root = doc.querySelector(".el-select"), input = root.querySelector("input");
  const picked = [];
  let dropdown = null;
  root.querySelector(".el-input").addEventListener("click", () => {
    if (!dropdown) {
      dropdown = doc.createElement("div"); dropdown.className = "el-select-dropdown el-popper";
      dropdown.innerHTML = `<div class="el-scrollbar"><div class="el-select-dropdown__wrap el-scrollbar__wrap" style="overflow-y: scroll;"><ul class="el-select-dropdown__list">${choices.slice(0, rendered)
        .map((text) => `<li class="el-select-dropdown__item"><span>${text}</span></li>`).join("")}</ul></div></div>`;
      dropdown.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => { picked.push(li.textContent); input.value = li.textContent; dropdown.hidden = true; }));
      doc.body.append(dropdown);
    }
    dropdown.hidden = false;
  });
  // 排版：滚动层从 100px 起；第 i 项在 106 + 34i。滚动内容高 = 全部选项 + 上下内边距。
  const box = (el) => {
    const item = el.closest?.(".el-select-dropdown__item");
    if (item) { const top = 106 + Array.from(item.parentElement.children).indexOf(item) * 34; return { top, height: 34 }; }
    if (el.matches?.(".el-select-dropdown__wrap")) return { top: 100, height: 274, scrollHeight: choices.length * 34 + 12, clientHeight: 274 };
    return null;
  };
  stubLayout(w, box);
  const target = { kind: "element", element: input, elements: [input], root, controlKind: "custom-select", hints: {} };
  return { ...h, target, picked };
}

test("a list taller than what it drew is not complete even without a virtual-list class name", async () => {
  const h = elementUi(SCHOOLS, 10);
  const result = await h.api.operate(h.target, "北京大学");
  assert.equal(result.reason, "no_option_match", JSON.stringify(result));
  assert.deepEqual(h.picked, []);
});

test("a long list that drew every option still takes a unique partial match", async () => {
  const choices = SCHOOLS.map((text, i) => i === 60 ? "本科" : text);
  const h = elementUi(choices, choices.length);
  const result = await h.api.operate(h.target, "大学本科");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.picked, ["本科"]);
});
