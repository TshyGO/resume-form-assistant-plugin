// #301 通用下拉失败收尾：控件在对话框、抽屉里时不按 Esc，也不在页面上按，只在对话框里、控件旁边按下、松开。
// 对话框替身按各组件库关对话框的方式写：AntD Modal 在外层 .ant-modal-wrap 的 keydown 上收 Esc（#395 真机会关），
// Element UI 2 的 PopupManager 在 window 上、Element Plus 在 document 上听 Esc；自研抽屉在 document 上按下时点了外面就关。
// 弹层两种：北森式（Esc 不管用，在外面按下才关）、Moka 式（只认控件上的 Esc）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");

const FIELD = `<div class="form-item"><label class="form-item__text">民族</label><div class="form-item__content">
  <div class="phoenix-select"><ul class="phoenix-select__content"><li class="phoenix-select__selected"></li>
  <li class="phoenix-select__inputWrapper"><input class="phoenix-select__input"></li></ul></div></div></div>`;
// 每种对话框：外壳 HTML（表单放在 {form} 处）和它自己收 Esc、点外面的方式。
const DIALOGS = {
  "AntD Modal": {
    html: `<div class="ant-modal-root"><div class="ant-modal-mask"></div><div tabindex="-1" class="ant-modal-wrap" role="dialog">
      <div role="document" class="ant-modal"><div class="ant-modal-content"><div class="ant-modal-body">{form}</div></div></div></div></div>`,
    wire(doc, close) { doc.querySelector(".ant-modal-wrap").addEventListener("keydown", (event) => { if (event.keyCode === 27) close(); }); }
  },
  "Element UI el-dialog": {
    html: `<div class="el-dialog__wrapper"><div role="dialog" aria-modal="true" aria-label="填写信息" class="el-dialog">
      <div class="el-dialog__body">{form}</div></div></div>`,
    wire(doc, close) { doc.defaultView.addEventListener("keydown", (event) => { if (event.keyCode === 27) close(); }); }
  },
  "Element Plus el-dialog": {
    html: `<div class="el-overlay"><div class="el-overlay-dialog"><div class="el-dialog" role="dialog" aria-modal="true">
      <div class="el-dialog__body">{form}</div></div></div></div>`,
    wire(doc, close) { doc.addEventListener("keydown", (event) => { if (event.code === "Escape") close(); }); }
  },
  "a drawer that closes on a press outside it": {
    html: `<div class="apply-side-drawer" style="position: fixed; top: 0; right: 0; bottom: 0;"><div class="apply-side-drawer__body">{form}</div></div>`,
    wire(doc, close) {
      const drawer = doc.querySelector(".apply-side-drawer");
      doc.addEventListener("mousedown", (event) => { if (!drawer.contains(event.target)) close(); });
    }
  },
  // 抽屉自己不是 fixed，浮在 fixed 的遮罩里；在 document 上听 Esc。
  "a drawer inside a fixed mask": {
    html: `<div class="apply-mask" style="position: fixed; top: 0; right: 0; bottom: 0; left: 0;"><div class="apply-drawer">{form}</div></div>`,
    wire(doc, close) { doc.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); }); }
  }
};

function load(shell) {
  const dom = new JSDOM(`<div class="page">${shell.replace("{form}", `<form>${FIELD}</form>`)}</div>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: (el) => !el.closest("[hidden]") });
  const doc = w.document;
  const root = doc.querySelector(".phoenix-select"), input = root.querySelector("input");
  const target = { kind: "element", element: input, elements: [input], root, controlKind: "custom-select", hints: {} };
  // 插件派发的按键、页面上的按下和点击都记下来（捕获阶段，页面自己的处理拦不住）。
  const seen = { escapes: 0, bodyPresses: 0, clicks: [], presses: [] };
  w.addEventListener("keydown", (event) => { if (event.key === "Escape") seen.escapes += 1; }, true);
  for (const type of ["pointerdown", "mousedown"]) doc.addEventListener(type, (event) => {
    seen.presses.push(event.target);
    if (event.target === doc.body) seen.bodyPresses += 1;
  }, true);
  doc.addEventListener("click", (event) => seen.clicks.push(event.target), true);
  return { w, doc, api, root, input, target, seen };
}

// closeBy：outside 是北森式，esc 是 Moka 式。点开的弹层挂在 body 下。
function wirePopup(h, choices, closeBy) {
  let layer = null;
  h.root.addEventListener("click", () => {
    if (layer) return;
    layer = h.doc.createElement("div");
    layer.className = "common-unmodeled-layer";
    layer.innerHTML = `<div class="list">${choices.map((text) => `<div class="list-item-container"><span class="item-text-label">${text}</span></div>`).join("")}</div>`;
    h.doc.body.append(layer);
  });
  const close = () => { layer?.remove(); layer = null; };
  if (closeBy === "outside") h.doc.addEventListener("mousedown", (event) => { if (layer && !layer.contains(event.target) && !h.root.contains(event.target)) close(); }, true);
  else h.root.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  return { open: () => layer };
}

for (const [name, dialog] of Object.entries(DIALOGS)) {
  test(`a failed dropdown in ${name} keeps the dialog open and closes its popup with a press inside the dialog`, async () => {
    const h = load(dialog.html);
    let closed = 0;
    dialog.wire(h.doc, () => { closed += 1; });
    const popup = wirePopup(h, ["汉族", "回族"], "outside");
    const result = await h.api.operate(h.target, "苗族");
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(closed, 0, "the dialog is still open");
    assert.equal(h.seen.escapes, 0, "no Esc is sent");
    assert.equal(h.seen.bodyPresses, 0, "nothing is pressed on the page outside the dialog");
    assert.deepEqual(h.seen.clicks.filter((el) => !h.root.contains(el)), [], "no click outside the dropdown");
    assert.equal(popup.open(), null, "the popup has closed");
    const spot = h.seen.presses.find((el) => !h.root.contains(el));
    assert.ok(spot?.closest(".form-item"), "the press lands next to the control");
  });
}

test("a Moka-style popup that only takes Esc is left open inside a dialog, and the dialog stays", async () => {
  const h = load(DIALOGS["AntD Modal"].html);
  let closed = 0;
  DIALOGS["AntD Modal"].wire(h.doc, () => { closed += 1; });
  const popup = wirePopup(h, ["是", "否"], "esc");
  const result = await h.api.operate(h.target, "不确定");
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(closed, 0);
  assert.equal(h.seen.escapes, 0);
  assert.equal(h.seen.bodyPresses, 0);
  assert.ok(popup.open(), "a popup that cannot be closed without Esc stays open");
});

for (const closeBy of ["esc", "outside"]) {
  test(`outside a dialog the closing is as before (${closeBy === "esc" ? "Moka" : "Beisen"}): Esc on the control, then a press on the page`, async () => {
    // 页面状态类名（modal-open）、外层布局里带 drawer 的类名都不是对话框。
    const h = load(`<div class="drawer-layout"><main class="content">{form}</main></div>`);
    h.doc.body.className = "modal-open";
    const popup = wirePopup(h, ["是", "否"], closeBy);
    const result = await h.api.operate(h.target, "不确定");
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(h.seen.escapes, 1, "Esc on the control");
    // Esc 收起了就不再按；Esc 不管用的过 0.6 秒在页面空白处按下。
    if (closeBy === "esc") assert.equal(h.seen.bodyPresses, 0);
    else assert.ok(h.seen.bodyPresses >= 1, "then a press on the page");
    assert.equal(popup.open(), null);
  });
}

// 页面骨架不是对话框：daisyUI 的 drawer、drawer-content，Angular Material 的 mat-drawer-container、mat-drawer-content
// 包着整页（都不是 fixed）；外层带 modal-isOpen 这种驼峰状态类名。Moka 式弹层照旧靠控件上的 Esc 收起。
const SHELLS = {
  "daisyUI drawer layout": `<div class="drawer lg:drawer-open"><input id="nav" type="checkbox" class="drawer-toggle"><div class="drawer-content">{form}</div>
    <div class="drawer-side"><label for="nav" class="drawer-overlay"></label><ul class="menu"></ul></div></div>`,
  "Angular Material sidenav layout": `<div class="mat-drawer-container mat-sidenav-container"><div class="mat-drawer mat-sidenav"></div>
    <div class="mat-drawer-content mat-sidenav-content">{form}</div></div>`,
  "a wrapper with a camelCase state class": `<div class="app modal-isOpen"><main>{form}</main></div>`
};
for (const [name, shell] of Object.entries(SHELLS)) {
  test(`${name} is not a dialog: a Moka-style popup still gets Esc on the control`, async () => {
    const h = load(shell);
    const popup = wirePopup(h, ["是", "否"], "esc");
    const result = await h.api.operate(h.target, "不确定");
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(h.seen.escapes, 1, "Esc on the control");
    assert.equal(popup.open(), null, "the popup has closed");
  });
}

test("a read-only date box in an Element UI dialog that cannot take the date sends no Esc", async () => {
  // 只读日期框（control-adapters.js 交给 custom-controls 的日历路径）失败也走同一个收尾。
  const shell = DIALOGS["Element UI el-dialog"].html.replace("{form}", `<form><div class="form-item"><label>入学时间</label>
    <div class="el-date-editor el-input"><input class="el-input__inner" readonly placeholder="请选择日期"></div></div></form>`);
  const dom = new JSDOM(`<div class="page">${shell}</div>`, { runScripts: "outside-only" });
  const w = dom.window, doc = w.document;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: (el) => !el.closest("[hidden]") });
  let closed = 0, escapes = 0, layer = null;
  w.addEventListener("keydown", (event) => { if (event.keyCode === 27) { escapes += 1; closed += 1; } });
  const input = doc.querySelector("input");
  input.addEventListener("focus", () => {
    if (layer) return;
    layer = doc.createElement("div");
    // 今天以后的日子不能选：要的 28 日选不了。
    const days = Array.from({ length: 31 }, (_, i) => `<td class="${i + 1 > 22 ? "disabled" : "available"}"><span>${i + 1}</span></td>`).join("");
    layer.innerHTML = `<div class="el-picker-panel el-date-picker"><div class="header"><span class="el-date-picker__header-label">2026 年</span>
      <span class="el-date-picker__header-label">10 月</span></div><table><tbody><tr>${days}</tr></tbody></table></div>`;
    doc.body.append(layer);
  });
  doc.addEventListener("mousedown", (event) => { if (layer && !layer.contains(event.target) && event.target !== input) { layer.remove(); layer = null; } }, true);
  const target = { kind: "element", element: input, root: input.parentElement, controlKind: "date", pickerType: "element", hints: {} };
  const result = await api.operate(target, "2026-10-28");
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(escapes, 0, "no Esc reaches the window");
  assert.equal(closed, 0, "the dialog is still open");
  assert.equal(layer, null, "the calendar was closed by the press inside the dialog");
});
