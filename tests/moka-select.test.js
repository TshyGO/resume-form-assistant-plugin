// #301 Moka 申请表的真实结构（2026-10-29 对晶科、唯捷创芯两份公开申请页只读渲染所见，类名照抄）：
// 一行是 apply-field（下拉行的类名带 select_info-* 或 Select-*），题目在 div.title-*；下拉的外框是包着输入框的
// <label class="sd-Input-container sd-Select-container">，已选文字在外框里的 span.sd-Input-display-value，输入框是空的，
// 选好后占位文字变成空。弹层两种挂法：sd-Dropdown 不挂到 body 时画在外框旁边的 <span> 槽位里（position: fixed，
// 两份表都是这样），挂到 body 时在 body 下（10-11 真机见过）。起止时间的年、月是同一个 <span> 里的两个下拉，选了年页面会把空着的月带成 1。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness");

const FRAME = (placeholder, frameClass = "select_info no-adaptive-tooltip") => `<div class="sd-Dropdown-container-1CigZ" style="width: 100%;">
  <label class="sd-Input-container-2S_vM sd-Select-container-1Eq4x ${frameClass} sd-Input-lg-3X8ma" style="width: 100%;"><span class="sd-Input-display-value-RwqDy sd-Input-display-value-spacing-2BKCS"></span><input type="text" class="sd-Input-input-10L0t sd-Input-common-input-1XimE sd-Input-has-addon-3djHe" placeholder="${placeholder}" autocomplete="nope" maxlength="-1" value=""><span class="sd-Input-addon-1Dv-z sd-Select-addon-26oV3"><div class="sd-Input-shadow-2mn0F"></div><span class="sd-Icon-container-1EGHG sd-Icon-iconcaretDown-juEqC sd-Select-icon-Bs6XN"></span></span></label><span></span></div>`;
const ROW = (title, rowClass, placeholder = "请选择") => `<div class="apply-field-Q2iJ7AtQGX ${rowClass} apply-filed-padding-gvR51AnKq6"><div class="title-IWWQ0Xa4L7"><span><span>${title}</span></span></div>
  <div class="ctrl-CICMG4Fr4_"><div class="sd-Tooltip-container-2B2OE w-full-mRUtzMQLHs">${FRAME(placeholder)}</div>
  <div style="margin-top: 0px;"><div class="describe-GCCjupJ4ID"></div></div></div></div>`;
const NAME_ROW = `<div class="apply-field-Q2iJ7AtQGX string_info-UOJxKN5mtC apply-filed-padding-gvR51AnKq6"><div class="title-IWWQ0Xa4L7"><span><span>姓名</span></span></div>
  <div class="ctrl-CICMG4Fr4_"><label class="sd-Input-container-2S_vM string_info no-adaptive-tooltip sd-Input-lg-3X8ma"><input type="text" class="sd-Input-input-10L0t sd-Input-common-input-1XimE" placeholder="姓名" maxlength="255" value=""></label></div></div>`;
// 唯捷创芯的起止时间：年、月占位文字是「年 / Year」「月 / Month」，题目不在这一行里。
const RANGE = `<div class="apply-field-Q2iJ7AtQGX date_info-nCj8tT_zjw apply-filed-padding-gvR51AnKq6 full-width-field-_9KdqB6mcu"><div class="ctrl-CICMG4Fr4_">
  <div class="month-range-select date_info wrapper-Wilqy7sjl0"><label class="label-ZJNsc2aXvx"></label>
  <span><div class="item-CNFmjn2r6y">${FRAME("年 / Year", "no-adaptive-tooltip")}</div><div class="item-CNFmjn2r6y">${FRAME("月 / Month", "no-adaptive-tooltip")}</div></span>
  <span class="till-QjTOI37re2">-<br></span>
  <span><div class="item-CNFmjn2r6y">${FRAME("年 / Year", "no-adaptive-tooltip")}</div><div class="item-CNFmjn2r6y">${FRAME("月 / Month", "no-adaptive-tooltip")}</div></span>
  </div></div></div>`;

function load(body) {
  const dom = new JSDOM(`<form><div class="apply-fields">${NAME_ROW}${body}</div></form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  // 槽位、弹层都算看得见：写入前复查不能靠真机上槽位宽 0 才看不见弹层。
  const isVisible = (el) => !el.closest("[hidden]");
  const api = w.ResumeProControls.create({ timeoutMs: 300, settleMs: 35, isVisible });
  return { w, doc: w.document, api, isVisible };
}

function scanned(doc, predicate) {
  return scanner.scanPage(doc, { isVisible: () => true }).controls.find(predicate) || null;
}

// 和 sd-Select 一样：点外框打开弹层，点选项把文字写进 display-value、去掉占位文字、收起弹层。
// inBody：sd-Dropdown 挂到 body 的写法。
function mokaSelect(doc, input, choices, { inBody = false } = {}) {
  const frame = input.closest("label");
  const container = frame.parentElement, slot = frame.nextElementSibling;
  const display = frame.querySelector("[class*='display-value']");
  let popup = null;
  container.addEventListener("click", () => {
    if (popup?.isConnected) return;
    popup = doc.createElement("div");
    popup.className = "sd-Dropdown-dropdown-GmA2d";
    popup.setAttribute("style", "position: fixed; top: 48px; left: 0px;");
    popup.innerHTML = `<div class="sd-Select-menu-36GjT">${choices.map((text) => `<div class="sd-Menu-content-item-3BOhl"><div class="option-label-p2BzR">${text}</div></div>`).join("")}</div>`;
    popup.querySelectorAll("[class*='sd-Menu-content-item']").forEach((item) => item.addEventListener("click", (event) => {
      event.stopPropagation();
      display.textContent = item.textContent;
      input.placeholder = "";
      popup.remove();
    }));
    (inBody ? doc.body : slot).append(popup);
  });
  return { frame, container, display };
}

// 一键填写拿到的字段，和 content.js 的写入前复查（fillValueSnapshot 的 custom-select 分支：组件状态加组件根里显示的文字）。
function fillTarget(h, binding) {
  const target = { kind: "element", element: binding.element, elements: binding.elements, root: binding.root, controlKind: binding.controlKind, binding, hints: {} };
  const snapshot = () => JSON.stringify([h.w.ResumeProCustomControls.snapshot(target), scanner.displayedStateForGuard(binding, { isVisible: h.isVisible })]);
  const approved = snapshot();
  const guard = { refused: 0 };
  guard.options = { isCurrent: () => true, beforeWrite: (userEdited = false) => {
    if (!userEdited && snapshot() === approved) return true;
    guard.refused += 1;
    return false;
  } };
  return { target, guard };
}

for (const rowClass of ["select_info-zjdod05hST", "Select-oqOV0aGogs"]) {
  test(`a Moka dropdown row (${rowClass.split("-")[0]}) keeps its question title and a component-sized root`, () => {
    const { doc } = load(ROW("性别", rowClass));
    const control = scanned(doc, (item) => item.controlKind === "custom-select");
    assert.ok(control, "the dropdown is scanned as a fillable field");
    assert.equal(control.label, "性别");
    assert.equal(control.labelSource, "item");
    assert.ok(control.root.className.startsWith("sd-Dropdown-container"), control.root.className);
  });
}

for (const [title, rowClass, chosen] of [["是否最高学历", "bool_info-Rk2u0xq9Vb", "是"], ["性别", "select_info-zjdod05hST", "男/Male"]]) {
  test(`a choice shown inside the Moka frame is not read as the title: ${title}`, () => {
    const h = load(ROW(title, rowClass));
    h.doc.querySelector(".apply-field-Q2iJ7AtQGX:last-child [class*='display-value']").textContent = chosen;
    h.doc.querySelector(".apply-field-Q2iJ7AtQGX:last-child input").placeholder = "";
    const control = scanned(h.doc, (item) => item.controlKind === "custom-select");
    assert.equal(control?.label, title);
    // 往框里打字时组件清空显示的已选值：题目不变，对应关系仍然成立。
    control.root.querySelector("[class*='display-value']").textContent = "";
    assert.equal(scanner.isBindingCurrent(control, h.doc, { isVisible: () => true }), true);
  });
}

test("a placeholder-only Moka year select stays bound once choosing removes its placeholder", () => {
  const { doc } = load(RANGE);
  const year = scanned(doc, (item) => item.placeholder === "年 / Year");
  assert.equal(year.labelSource, "placeholder");
  year.root.querySelector("[class*='display-value']").textContent = "2019";
  year.element.placeholder = "";
  assert.equal(scanner.isBindingCurrent(year, doc, { isVisible: () => true }), true);
});

test("a placeholder-only text box whose placeholder disappears is no longer taken as the same field", () => {
  // 上面那条只放宽给下拉；文本框的占位文字没了，可能是页面重画后换了字段。
  const { doc } = load(`<div class="apply-field-Q2iJ7AtQGX string_info-UOJxKN5mtC"><div class="ctrl-CICMG4Fr4_">
    <label class="sd-Input-container-2S_vM string_info"><input type="text" class="sd-Input-input-10L0t" placeholder="毕业论文题目" value=""></label></div></div>`);
  const field = scanned(doc, (item) => item.placeholder === "毕业论文题目");
  assert.equal(field.controlKind, "text");
  assert.equal(field.labelSource, "placeholder");
  field.element.placeholder = "";
  assert.equal(scanner.isBindingCurrent(field, doc, { isVisible: () => true }), false);
});

test("the generic path picks from a Moka popup inside the component root without tripping the write guard", async () => {
  const h = load(ROW("是否最高学历", "bool_info-Rk2u0xq9Vb"));
  const binding = scanned(h.doc, (item) => item.label === "是否最高学历");
  assert.equal(binding?.controlKind, "custom-select");
  const { display } = mokaSelect(h.doc, binding.element, ["是", "否"]);
  const { target, guard } = fillTarget(h, binding);
  const result = await h.api.operate(target, "否", guard.options);
  assert.equal(guard.refused, 0, "the plugin's own open popup is not a user edit");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(display.textContent, "否");
  assert.equal(binding.root.querySelector("[class*='sd-Dropdown-dropdown']"), null, "the popup has closed");
});

test("a Moka dropdown without a matching choice is closed with Esc on its own input, and the page gets no click", async () => {
  // 离线复刻上：Esc 发到组件自己的输入框（失焦后也行）能收起弹层，发到 body 不行；body 上只有 click 能收起。
  const h = load(ROW("是否最高学历", "bool_info-Rk2u0xq9Vb"));
  const binding = scanned(h.doc, (item) => item.label === "是否最高学历");
  const { container } = mokaSelect(h.doc, binding.element, ["是", "否"]);
  const open = () => binding.root.querySelector("[class*='sd-Dropdown-dropdown']");
  container.addEventListener("keydown", (event) => { if (event.key === "Escape") open()?.remove(); });
  let outsideClicks = 0;
  h.doc.addEventListener("click", (event) => { if (!container.contains(event.target)) { outsideClicks += 1; open()?.remove(); } });
  const { target, guard } = fillTarget(h, binding);
  const result = await h.api.operate(target, "不确定", guard.options);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(guard.refused, 0);
  assert.equal(outsideClicks, 0, "no click outside the dropdown");
  assert.equal(open(), null, "the popup has closed");
});

// Esc 后弹层的收法：fadeMs 为 0 时立刻移除，否则先加淡出的类、fadeMs 后才移除，这期间一直连着、看得见。
async function failWithEsc(fadeMs) {
  const h = load(ROW("是否最高学历", "bool_info-Rk2u0xq9Vb"));
  const binding = scanned(h.doc, (item) => item.label === "是否最高学历");
  const { container } = mokaSelect(h.doc, binding.element, ["是", "否"]);
  const open = () => binding.root.querySelector("[class*='sd-Dropdown-dropdown']");
  container.addEventListener("keydown", (event) => {
    const leaving = event.key === "Escape" ? open() : null;
    if (!leaving || leaving.classList.contains("fade-leave")) return;
    if (!fadeMs) { leaving.remove(); return; }
    leaving.classList.add("fade-leave");
    setTimeout(() => leaving.remove(), fadeMs);
  });
  const presses = [];
  for (const type of ["pointerdown", "mousedown"]) h.doc.body.addEventListener(type, (event) => { if (event.target === h.doc.body) presses.push(type); });
  const { target, guard } = fillTarget(h, binding);
  const result = await h.api.operate(target, "不确定", guard.options);
  return { result, presses, refused: guard.refused, left: open() };
}

test("a Moka popup that fades out after Esc is left to finish, and the page gets no press", async () => {
  // 真机（2026-10-29 晶科、唯捷创芯离线复刻）：Esc 后 sd-Dropdown 先淡出，120ms 时还看得见，约 500ms 才移除。
  // 原来 120ms 一到就再在页面空白处按一下。
  const at = await failWithEsc(0);
  const fading = await failWithEsc(300);
  assert.equal(fading.result.ok, false, JSON.stringify(fading.result));
  assert.equal(fading.result.reason, at.result.reason, "the failure reason does not depend on how the popup leaves");
  assert.equal(fading.refused, 0);
  assert.deepEqual(fading.presses, [], "nothing is pressed on the page while the popup fades");
  assert.equal(fading.left, null, "the popup has gone");
});

for (const inBody of [false, true]) {
  test(`a Moka 性别 row is filled through its popup ${inBody ? "mounted in body" : "inside the component root"}`, async () => {
    const h = load(ROW("性别", "select_info-zjdod05hST"));
    const binding = scanned(h.doc, (item) => item.label === "性别");
    assert.ok(binding, "the dropdown is scanned with its title");
    const { display } = mokaSelect(h.doc, binding.element, ["男/Male", "女/Female"], { inBody });
    const { target, guard } = fillTarget(h, binding);
    const result = await h.api.operate(target, "女", guard.options);
    assert.equal(guard.refused, 0);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(display.textContent, "女/Female");
    // 已选值读得到：之后的写入前复查和覆盖确认都看得到它。
    assert.deepEqual(Array.from(h.w.ResumeProCustomControls.readSelection(target).texts), ["女/Female"]);
    assert.equal(h.w.ResumeProCustomControls.hasExistingValue(target), true);
  });
}

test("an open Moka popup is not read as the row's shown value, and the shown value still is", () => {
  const h = load(ROW("是否最高学历", "bool_info-Rk2u0xq9Vb"));
  const binding = scanned(h.doc, (item) => item.label === "是否最高学历");
  const { display } = mokaSelect(h.doc, binding.element, ["是", "否"]);
  const target = { kind: "element", element: binding.element, root: binding.root, controlKind: "custom-select" };
  binding.element.click();
  assert.ok(binding.root.querySelector("[class*='sd-Dropdown-dropdown']"), "the popup is open inside the root");
  assert.deepEqual(scanner.displayedStateForGuard(binding, { isVisible: h.isVisible }), []);
  assert.deepEqual(Array.from(h.w.ResumeProCustomControls.readSelection(target).texts), []);
  display.textContent = "是";
  assert.deepEqual(scanner.displayedStateForGuard(binding, { isVisible: h.isVisible }), ["是"]);
  assert.deepEqual(Array.from(h.w.ResumeProCustomControls.readSelection(target).texts), ["是"]);
});

// 一键填写本身（content.js）：页面上的年、月、日期由替身代替，只看 content.js 怎么对待页面自己带出的月。
function rangeFill({ flat = false } = {}) {
  const shown = new Map();
  const late = { current: fakeFieldScan() };
  const sent = [];
  const ctx = loadHighlightHelpers({ formElements: [],
    fieldScan: Object.fromEntries(["scanPage", "isBindingCurrent", "hasDisplayedValue", "labelForElement"].map((name) => [name, (...args) => late.current[name](...args)])),
    customControls: {
      snapshot: (entry) => JSON.stringify({ selection: shown.get(entry.element) ? [shown.get(entry.element)] : [], query: "" }),
      hasExistingValue: (entry) => Boolean(shown.get(entry.element)),
      readSelection: (entry) => ({ texts: shown.get(entry.element) ? [shown.get(entry.element)] : [], cascade: false })
    },
    controls: { create: () => ({
      operate: async (target, value, options) => {
        if (options.beforeWrite && !options.beforeWrite()) return { ok: false, reason: "value_changed", observed: {} };
        options.onWrite?.();
        shown.set(target.element, String(value));
        // 选了年，页面把同一组里还空着的月带成 1。
        if (target.element === year && !shown.get(month)) shown.set(month, "1");
        return { ok: true, reason: "", observed: {} };
      },
      check: (target) => ({ ok: Boolean(shown.get(target.element)), reason: "", observed: {} })
    }) },
    sendMessage: async (message) => {
      sent.push(message);
      return message.type === "AI_FILL" ? { success: true, matches: [{ fieldId: "field-0", value: "2019" }, { fieldId: "field-1", value: "9" }, { fieldId: "field-2", value: "统招" }] } : { ok: true };
    } });
  const [year, month, other] = [0, 1, 2].map(() => new ctx.HTMLInputElement());
  // 年、月各自的表单项挂在同一个 <span> 里；flat：三个下拉挂在同一层（扁平表单）。
  const members = flat ? [year, month, other] : [year, month];
  const pair = { contains: (node) => members.includes(node) };
  const field = (element, label, placeholder) => ({ kind: "element", controlKind: "custom-select", element, elements: [element], root: element,
    item: { parentElement: members.includes(element) ? pair : null }, label, labelSource: label ? "item" : "placeholder", section: "教育经历", group: "教育经历",
    repeatIndex: 0, offerable: Boolean(label), offerLabel: label, pickerType: "", rangePart: "", placeholder });
  const controls = [field(year, "", "年 / Year"), field(month, "", "月 / Month"), field(other, "培养方式", "请选择")];
  late.current = { ...fakeFieldScan(), scanPage: () => ({ controls, skipped: { pageChrome: 0, popup: 0, merged: 0, siteSearch: 0, outsideForm: 0, noLabel: 0 }, sources: { item: 3 } }),
    isBindingCurrent: () => true };
  const status = { textContent: "", className: "" };
  ctx.helpers.setShadowRoot({ querySelector: (selector) => (selector === "#resume-pro-status" ? status : null), querySelectorAll: () => [] });
  ctx.helpers.setCurrentStore({ templates: [{ id: "t", name: "模板", groups: [{ name: "教育经历", fields: [{ key: "入学时间", value: "2019-09" }] }] }], activeTemplateId: "t" });
  const run = async () => ({ result: await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } }), status });
  return { run, shown, year, month, other, sent };
}

test("a month the page fills after the plugin picks its year is still written, and the fill goes on", async () => {
  const h = rangeFill();
  const { result, status } = await h.run();
  assert.notEqual(result.overwriteDeclined, true, status.textContent);
  assert.equal(h.shown.get(h.year), "2019");
  assert.equal(h.shown.get(h.month), "9");
  assert.equal(h.shown.get(h.other), "统招");
  assert.equal(result.filledCount, 3, JSON.stringify(result));
  assert.doesNotMatch(status.textContent, /字段内容已变化|检测到字段内容变化/);
});

test("outside a year/month pair a field the page changes during another choice still stops the fill", async () => {
  const h = rangeFill({ flat: true });
  const { result, status } = await h.run();
  assert.equal(result.overwriteDeclined, true, JSON.stringify(result));
  assert.equal(h.shown.get(h.month), "1", "the month the page set is kept");
  assert.equal(h.shown.get(h.other), undefined);
  assert.match(status.textContent, /字段内容/);
});
