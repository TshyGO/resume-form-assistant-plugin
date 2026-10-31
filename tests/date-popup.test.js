// #301 日期框和残留弹层（#418 南航、#417 智联、北森、hotjob 的上报）：
// - ant-design-vue 1.x 的日历过一拍才把框里打的字交给日历，同一拍回车提交的是今天。
// - 上一个下拉、联想框、日历没收起或正在退场，下一个控件点开时不能把它当成自己的弹层。
// - 库下拉失败后收起自己的弹层：AntD 可搜索的下拉焦点在搜索框里；Element 的下拉失焦不收。
// - 日期写法：分隔符两边带空格的单个日期，一段起止按题目取开始或结束。
// 页面组件按排查时在真组件上看到的行为写替身。只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const helpers = require("../ai-helpers.js");
const core = require("../feedback-core.js");

const visible = (el) => !el.closest("[hidden]");
function load(html, options = {}) {
  const dom = new JSDOM(`<form>${html}</form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 300, settleMs: 35, isVisible: visible, ...options });
  return { w, doc: w.document, api };
}
function scanned(doc, label) {
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls.find((item) => item.label === label);
  assert.ok(control, `scanned ${label}`);
  return { kind: "element", element: control.element, elements: control.elements, root: control.root, controlKind: control.controlKind, binding: control, hints: {} };
}
const pad = (n) => String(n).padStart(2, "0");

// ant-design-vue 1.x / antd 3 的 DatePicker（span.ant-calendar-picker，扫描时是通用下拉）：点框打开挂在 body 下的日历，
// 日历上面有能打字的日期框。今天固定为 2026-10-22。
// lag：打的字过多久才交给日历（Vue 2 要过一拍，antd 3 的 React 是同步的，给 null）。
// 回车提交的是日历当前的日子，没选过是今天。english：年月标题是 Oct 2026，插件认不出。
function antCalendar({ label = "出生日期", lag = 0, english = false, value = "" } = {}) {
  const h = load(`<div class="ant-form-item"><div class="ant-form-item-label"><label title="${label}">${label}</label></div>
    <div class="ant-form-item-control"><span class="ant-calendar-picker"><div><input readonly placeholder="请选择日期" class="ant-calendar-picker-input ant-input" value="${value}"></div></span></div></div>`);
  const { doc } = h;
  const field = doc.querySelector(".ant-calendar-picker-input");
  let layer = null, year = 2026, month = 10, picked = value || null;
  const enters = [], times = {};
  const draw = () => {
    const days = new Date(year, month, 0).getDate();
    const sel = picked && picked.startsWith(`${year}-${pad(month)}`) ? Number(picked.slice(8)) : 0;
    layer.querySelector(".ant-calendar-header").innerHTML = english
      ? `<span class="ant-calendar-my-select">${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1]} ${year}</span>`
      : `<a class="ant-calendar-prev-year-btn"></a><a class="ant-calendar-prev-month-btn"></a><span class="ant-calendar-my-select"><a class="ant-calendar-year-select">${year}年</a><a class="ant-calendar-month-select">${month}月</a></span><a class="ant-calendar-next-month-btn"></a><a class="ant-calendar-next-year-btn"></a>`;
    layer.querySelector("tbody").innerHTML = `<tr>${Array.from({ length: days }, (_, i) => `<td class="ant-calendar-cell${i + 1 === sel ? " ant-calendar-selected-day" : ""}"><div class="ant-calendar-date">${i + 1}</div></td>`).join("")}</tr>`;
  };
  const take = (text) => {
    const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!hit || !layer) return;
    picked = text; year = Number(hit[1]); month = Number(hit[2]); draw();
  };
  field.addEventListener("click", () => {
    if (layer) return;
    if (picked) { year = Number(picked.slice(0, 4)); month = Number(picked.slice(5, 7)); }
    layer = doc.createElement("div");
    layer.innerHTML = `<div class="ant-calendar-picker-container"><div class="ant-calendar"><div class="ant-calendar-panel">
      <div class="ant-calendar-input-wrap"><div class="ant-calendar-date-input-wrap"><input class="ant-calendar-input" placeholder="请选择日期" value="${picked || ""}"></div></div>
      <div class="ant-calendar-date-panel"><div class="ant-calendar-header"></div><div class="ant-calendar-body"><table><tbody></tbody></table></div></div></div></div></div>`;
    const input = layer.querySelector(".ant-calendar-input");
    input.addEventListener("input", () => { times.typed = Date.now(); const text = input.value; if (lag === null) take(text); else setTimeout(() => take(text), lag); });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      times.enter = Date.now();
      const chosen = picked || "2026-10-22";
      enters.push(chosen);
      field.value = chosen; layer.remove(); layer = null;
    });
    layer.addEventListener("click", (event) => {
      const cell = event.target.closest("td");
      if (!cell) return;
      field.value = `${year}-${pad(month)}-${pad(cell.textContent.trim())}`; layer.remove(); layer = null;
    });
    doc.body.append(layer);
    draw();
  });
  return { ...h, field, enters, times, layer: () => layer, target: scanned(doc, label) };
}

test("ant-design-vue 1.x: Enter waits until the calendar has taken the typed date, so the form gets it and not today", async () => {
  for (const lag of [0, 40]) {
    const h = antCalendar({ lag });
    assert.equal(h.target.controlKind, "custom-select");
    const result = await h.api.operate(h.target, "2002-05-12");
    assert.equal(result.ok, true, `lag ${lag}: ${JSON.stringify(result)}`);
    assert.equal(h.field.value, "2002-05-12", `lag ${lag}`);
    assert.deepEqual(h.enters, ["2002-05-12"], `lag ${lag}`);
  }
});

test("ant-design-vue 1.x: a date in the month the calendar already shows still waits for the typed day", async () => {
  const h = antCalendar({ lag: 40 });
  const result = await h.api.operate(h.target, "2026-10-15");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.field.value, "2026-10-15");
});

// 页面很忙，日历过了等待上限（约 0.3 秒）还没接住打的字：这时回车交出的是日历原来指着的日子，不回车，改在日历里逐级点。
test("ant-design-vue 1.x: a calendar that has not taken the typed date by the end of the wait gets no Enter", async () => {
  const h = antCalendar({ lag: 450 });
  const result = await h.api.operate(h.target, "2002-05-12");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.field.value, "2002-05-12");
  assert.deepEqual(h.enters, [], "没有回车");
});

// 英文标题（Oct 2026）认不出年月、日历又过一拍才接住打的字：不马上回车，等日历上的字变了（换成 May 2026、选中 12 日）再回车。
test("ant-design-vue 1.x with a header the plugin cannot read still waits for the calendar before Enter", async () => {
  for (const date of ["2026-05-12", "2002-05-12"]) {
    const h = antCalendar({ lag: 40, english: true });
    const result = await h.api.operate(h.target, date);
    assert.equal(result.ok, true, `${date}: ${JSON.stringify(result)}`);
    assert.equal(h.field.value, date);
    assert.deepEqual(h.enters, [date]);
  }
});

// 网页把所有弹层都放进一个一直在、自己有大小、浮在页面上的空外壳里：点开前记浮层时不算它，里面新画的日历照样认。
test("a calendar drawn into an empty floating container that is always there is still the field's own", async () => {
  const h = antCalendar({ lag: 0 });
  const host = h.doc.createElement("div");
  host.className = "app-popup-container";
  host.style.position = "absolute";
  h.doc.body.append(host);
  h.doc.body.append = (node) => host.append(node);
  const result = await h.api.operate(h.target, "2002-05-12");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.field.value, "2002-05-12");
});

test("antd 3 (React) takes the typed date at once and is not slowed down", async () => {
  const h = antCalendar({ lag: null });
  const result = await h.api.operate(h.target, "2002-05-12");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.field.value, "2002-05-12");
  // 等日历跟上最多 0.3 秒；同步更新的不用等满。
  assert.ok(h.times.enter - h.times.typed < 150, `Enter ${h.times.enter - h.times.typed}ms after typing`);
});

test("a calendar that commits another date on Enter is reported as having changed the field, not as merely not chosen", async () => {
  // 标题认不出（Oct 2026），日历过 0.5 秒才收下打的字，等满了也没变：只好回车，回车交出的是今天。
  const h = antCalendar({ lag: 500, english: true });
  const result = await h.api.operate(h.target, "2002-05-12");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "selection_not_committed");
  assert.equal(h.field.value, "2026-10-22");
  assert.equal(result.observed.after, "other");
  assert.equal(result.observed.popupRole, "calendar");
});

test("a calendar that leaves the original date in place is not reported as changed", async () => {
  // 日历过 0.5 秒才收下打的字，等不到：回车交出的是原来的日子。
  const h = antCalendar({ lag: 500, english: true, value: "2001-01-01" });
  const result = await h.api.operate(h.target, "2002-05-12");
  assert.equal(result.ok, false);
  assert.equal(h.field.value, "2001-01-01");
  assert.equal(result.observed.after, undefined);
});

// ---- 残留弹层 ----

// 上一个下拉选不上，弹层还开着；点开日期时它开始退场（改 class），和日历同时在变。
function leavingDropdown(doc, classes = "ant-select-dropdown ant-select-dropdown--single") {
  const stale = doc.createElement("div");
  stale.className = classes;
  stale.innerHTML = `<div><ul role="listbox" class="ant-select-dropdown-menu"><li role="option" class="ant-select-dropdown-menu-item">是</li><li role="option" class="ant-select-dropdown-menu-item">否</li></ul></div>`;
  doc.body.append(stale);
  return stale;
}

test("a date picker opened while the last field's dropdown is still leaving picks its own calendar", async () => {
  const h = antCalendar({ label: "可到岗日期", lag: null });
  const stale = leavingDropdown(h.doc);
  h.field.addEventListener("click", () => setTimeout(() => stale.classList.add("slide-up-leave"), 10));
  const result = await h.api.operate(h.target, "2026-07-01");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.field.value, "2026-07-01");
});

// Element UI 2 只读日期框：聚焦就打开日历（挂在 body 下，按年 → 月 → 日点）。
function elementDate(label = "入学时间", { inside = null } = {}) {
  const h = load(`<div class="el-form-item"><label class="el-form-item__label">${label}</label><div class="el-form-item__content">
    <div class="el-date-editor el-input"><input class="el-input__inner" readonly placeholder="选择日期"></div></div></div>`);
  const { doc } = h;
  const input = doc.querySelector(".el-input__inner");
  let panel = null, year = 2026, month = 10, view = "date";
  const months = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  const draw = () => {
    const days = new Date(year, month, 0).getDate();
    panel.innerHTML = `<div class="el-date-picker__header"><span class="el-date-picker__header-label year">${view === "year" ? `${Math.floor(year / 10) * 10} 年 - ${Math.floor(year / 10) * 10 + 9} 年` : `${year} 年`}</span>
      ${view === "date" ? `<span class="el-date-picker__header-label month">${month} 月</span>` : ""}</div>
      ${view === "date" ? `<table class="el-date-table"><tr>${Array.from({ length: days }, (_, i) => `<td class="available"><span>${i + 1}</span></td>`).join("")}</tr></table>` : ""}
      ${view === "year" ? `<table class="el-year-table"><tr>${Array.from({ length: 10 }, (_, i) => `<td><a class="cell">${Math.floor(year / 10) * 10 + i}</a></td>`).join("")}</tr></table>` : ""}
      ${view === "month" ? `<table class="el-month-table"><tr>${months.map((m) => `<td><a class="cell">${m}月</a></td>`).join("")}</tr></table>` : ""}`;
  };
  input.addEventListener("focus", () => {
    if (panel) return;
    panel = doc.createElement("div"); panel.className = "el-picker-panel el-date-picker el-popper";
    panel.addEventListener("click", (event) => {
      const el = event.target;
      if (el.matches(".year")) view = "year";
      else if (el.closest(".el-year-table")) { year = Number(el.textContent); view = "month"; }
      else if (el.closest(".el-month-table")) { month = months.indexOf(el.textContent.replace("月", "")) + 1; view = "date"; }
      else if (el.closest(".el-date-table")) { input.value = `${year}-${pad(month)}-${pad(el.textContent)}`; panel.remove(); panel = null; return; }
      else return;
      draw();
    });
    (inside ? doc.querySelector(inside) : doc.body).append(panel); draw();
  });
  const control = scanner.scanPage(doc, { isVisible: () => true }).controls.find((item) => item.label === label);
  return { ...h, input, panel: () => panel, target: { kind: "element", element: control.element, root: control.root, controlKind: "date", pickerType: "element", binding: control, hints: {} } };
}

test("a read-only Element date ignores a select dropdown the field before left open", async () => {
  // #417 智联：上一个可搜下拉没选成、下拉没收，Element 的定位脚本随后改它的 style。原来把它当成日期的弹层，报 unsupported_control。
  const h = elementDate();
  const stale = leavingDropdown(h.doc, "el-select-dropdown el-popper");
  stale.querySelectorAll("li").forEach((li) => { li.className = "el-select-dropdown__item"; });
  h.input.addEventListener("focus", () => setTimeout(() => { stale.style.top = "120px"; }, 10));
  const result = await h.api.operate(h.target, "2021-09-01");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "2021-09-01");
});

test("a read-only Element date ignores another date's calendar still open next to it", async () => {
  const h = elementDate();
  const stale = h.doc.createElement("div");
  stale.className = "el-picker-panel el-date-picker el-popper";
  stale.innerHTML = `<div class="el-date-picker__header"><span class="el-date-picker__header-label">2026 年</span><span class="el-date-picker__header-label">10 月</span></div>
    <table class="el-date-table"><tr>${Array.from({ length: 31 }, (_, i) => `<td class="available"><span>${i + 1}</span></td>`).join("")}</tr></table>`;
  let staleClicks = 0;
  stale.addEventListener("click", () => { staleClicks += 1; });
  h.doc.body.append(stale);
  const result = await h.api.operate(h.target, "2021-09-01");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "2021-09-01");
  assert.equal(staleClicks, 0, "nothing is clicked in the other calendar");
});

test("a page section marked as a listbox around the form does not hide the calendar opened inside it", async () => {
  const h = elementDate("入学时间", { inside: ".shell" });
  const form = h.doc.querySelector("form");
  const shell = h.doc.createElement("div");
  shell.className = "shell"; shell.setAttribute("role", "listbox");
  form.replaceWith(shell); shell.append(form);
  const result = await h.api.operate(h.target, "2021-09-01");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "2021-09-01");
});

test("a text box retried through its suggestions ignores a list the field before left open", async () => {
  // hotjob 学校库：普通文本框，打字后贴着它冒出建议框。上一题的下拉还开着、这时开始退场。
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const h = load(`<div class="ant-form-item"><div class="ant-form-item-label"><label title="毕业院校">毕业院校</label></div>
    <div class="ant-form-item-control"><input class="ant-input" type="text"></div></div>`, {
    normalizeText: (el, value) => String(value ?? ""),
    runTextLifecycle: async (el, value, sequential, guard, didWrite) => {
      el.focus(); await tick(); if (!guard()) return false;
      didWrite(); el.value = value; el.dispatchEvent(new h.w.Event("input", { bubbles: true })); await tick();
      el.blur(); return true;
    },
    waitTextCommit: () => new Promise((resolve) => setTimeout(resolve, 10)),
    inspectText: (el, expected, committed) => el.value === expected ? { ok: true, reason: "" } : { ok: false, reason: committed ? "value_reverted" : "value_not_committed" },
    replayFocusBlur: async () => {}, prefersSequential: () => false, dispatchTextInput: () => {}
  });
  const { doc } = h;
  const input = doc.querySelector("input");
  let model = "", box = null;
  input.addEventListener("input", () => {
    const query = input.value;
    setTimeout(() => {
      box?.remove(); box = null;
      if (!query || doc.activeElement !== input) return;
      box = doc.createElement("div"); box.className = "school-suggest";
      box.innerHTML = `<div class="row"><span>北京大学</span></div><div class="row"><span>北京大学医学部</span></div>`;
      box.querySelectorAll(".row").forEach((row) => row.addEventListener("click", () => { model = row.textContent; input.value = model; box.remove(); box = null; }));
      doc.body.append(box);
    }, 20);
  });
  input.addEventListener("blur", () => { box?.remove(); box = null; input.value = model; });
  const stale = leavingDropdown(doc);
  stale.querySelector("li").textContent = "北京大学";
  // 打字的同时它开始退场（class 变了），比建议框先动：插件不能把它当成建议框点。
  input.addEventListener("keydown", () => stale.classList.add("slide-up-leave"));
  const result = await h.api.operate(scanned(doc, "毕业院校"), "北京大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(input.value, "北京大学");
});

// ---- 库下拉失败后收起自己的弹层 ----

// AntD 3 / ant-design-vue 1.x 可搜索的下拉：点开后焦点在搜索框里；搜索框失焦 10ms 后收起（rc-select 的失焦计时器）。
function antdSearchable() {
  const h = load(`<div class="ant-form-item"><div class="ant-form-item-label"><label title="是否服从调剂">是否服从调剂</label></div>
    <div class="ant-form-item-control"><div class="ant-select ant-select-enabled ant-select-show-search"><div class="ant-select-selection ant-select-selection--single" role="combobox"
    aria-autocomplete="list" aria-haspopup="true" aria-controls="menu-9" aria-expanded="false" tabindex="0"><div class="ant-select-selection__rendered">
    <div class="ant-select-selection__placeholder">请选择</div><div class="ant-select-search ant-select-search--inline"><div class="ant-select-search__field__wrap">
    <input autocomplete="off" class="ant-select-search__field" value=""></div></div></div></div></div></div></div>`);
  const { doc } = h;
  const root = doc.querySelector(".ant-select"), combo = root.querySelector("[role=combobox]"), search = root.querySelector("input");
  const dropdown = doc.createElement("div");
  dropdown.className = "ant-select-dropdown ant-select-dropdown--single"; dropdown.hidden = true;
  dropdown.innerHTML = `<div id="menu-9"><ul role="listbox" class="ant-select-dropdown-menu"></ul></div>`;
  doc.body.append(dropdown);
  const draw = () => {
    const query = search.value;
    dropdown.querySelector("ul").innerHTML = ["是", "否"].filter((text) => !query || text.includes(query))
      .map((text) => `<li role="option" class="ant-select-dropdown-menu-item">${text}</li>`).join("")
      || `<li role="option" aria-disabled="true" class="ant-select-dropdown-menu-item ant-select-dropdown-menu-item-disabled">暂无数据</li>`;
  };
  root.addEventListener("click", () => { dropdown.hidden = false; combo.setAttribute("aria-expanded", "true"); draw(); search.focus(); });
  search.addEventListener("input", draw);
  search.addEventListener("blur", () => setTimeout(() => { dropdown.hidden = true; combo.setAttribute("aria-expanded", "false"); }, 10));
  return { ...h, dropdown, search, target: scanned(doc, "是否服从调剂") };
}

test("a failed searchable AntD 3 select loses focus from its search box, so its dropdown closes before the next field", async () => {
  const h = antdSearchable();
  const result = await h.api.operate(h.target, "服从");
  assert.equal(result.ok, false);
  assert.notEqual(h.doc.activeElement, h.search, "the search box is left");
  assert.equal(h.dropdown.hidden, true, "the dropdown has closed");
});

// Element UI 2：el-select 失焦不收，点外面（document 上按下、松开）收；它自己输入框外层的 Esc 收起并不再往外传。
// el-cascader 的 Esc 往外传到 window（对话框在那里收 Esc）。
function elementSelect({ cascader = false, dialog = false } = {}) {
  const control = cascader
    ? `<div class="el-cascader"><div class="el-input"><input class="el-input__inner" readonly placeholder="请选择"></div></div>`
    : `<div class="el-select"><div class="el-input"><input class="el-input__inner" readonly placeholder="请选择"></div></div>`;
  const field = `<div class="el-form-item"><label class="el-form-item__label">年级排名</label><div class="el-form-item__content">${control}</div></div>`;
  const h = load(dialog ? `<div class="el-dialog__wrapper"><div role="dialog" aria-modal="true" class="el-dialog"><div class="el-dialog__body">${field}</div></div></div>` : field);
  const { doc, w } = h;
  const root = doc.querySelector(cascader ? ".el-cascader" : ".el-select"), wrap = root.querySelector(".el-input");
  const dropdown = doc.createElement("div");
  dropdown.className = cascader ? "el-popper el-cascader__dropdown" : "el-select-dropdown el-popper"; dropdown.hidden = true;
  dropdown.innerHTML = cascader
    ? `<div class="el-cascader-panel"><div class="el-cascader-menu"><ul class="el-cascader-menu__list"><li class="el-cascader-node"><span class="el-cascader-node__label">前10%</span></li><li class="el-cascader-node"><span class="el-cascader-node__label">前30%</span></li></ul></div></div>`
    : `<ul class="el-select-dropdown__list"><li class="el-select-dropdown__item"><span>前10%</span></li><li class="el-select-dropdown__item"><span>前30%</span></li></ul>`;
  doc.body.append(dropdown);
  const seen = { escapes: 0, dialogClosed: 0 };
  w.addEventListener("keydown", (event) => { if (event.key === "Escape") { seen.escapes += 1; if (dialog) seen.dialogClosed += 1; } });
  (cascader ? root : wrap).addEventListener("click", () => { dropdown.hidden = false; });
  (cascader ? root : wrap).addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    dropdown.hidden = true;
    if (!cascader) event.stopPropagation();
  });
  let down = null;
  doc.addEventListener("mousedown", (event) => { down = event.target; });
  doc.addEventListener("mouseup", (event) => {
    const inside = (el) => root.contains(el) || dropdown.contains(el);
    if (down && !inside(down) && !inside(event.target)) dropdown.hidden = true;
  });
  const scan = scanner.scanPage(doc, { isVisible: () => true }).controls.find((item) => item.label === "年级排名");
  return { ...h, dropdown, seen, target: { kind: "element", element: scan.element, elements: scan.elements, root: scan.root, controlKind: scan.controlKind, binding: scan, hints: {} } };
}

test("a failed Element UI el-select closes its dropdown with Esc on its own box", async () => {
  const h = elementSelect();
  const result = await h.api.operate(h.target, "前15%");
  assert.equal(result.reason, "no_option_match");
  assert.equal(h.dropdown.hidden, true, "the dropdown has closed");
  assert.equal(h.seen.escapes, 0, "the Esc did not go past the select");
});

test("a failed Element UI el-select inside a dialog sends no Esc and is closed with a press next to it", async () => {
  const h = elementSelect({ dialog: true });
  const result = await h.api.operate(h.target, "前15%");
  assert.equal(result.reason, "no_option_match");
  assert.equal(h.dropdown.hidden, true, "the dropdown has closed");
  assert.equal(h.seen.escapes, 0);
  assert.equal(h.seen.dialogClosed, 0);
});

test("a failed Element UI el-cascader inside a dialog keeps the dialog open and closes its dropdown", async () => {
  const h = elementSelect({ cascader: true, dialog: true });
  const result = await h.api.operate(h.target, "前15%");
  assert.equal(result.ok, false);
  assert.equal(h.seen.dialogClosed, 0, "the dialog is still open");
  assert.equal(h.dropdown.hidden, true, "the dropdown has closed");
});

// ---- 日期写法 ----

// 北森日期题：phoenix-select 当触发框，点开日历，按年 → 月 → 日点。
function beisenDate(label) {
  const h = load(`<div class="form-item"><label class="form-item__text">${label}</label><div class="form-item__control">
    <div class="phoenix-select phoenix-select--editable"><ul class="phoenix-select__content"><li class="phoenix-select__selected"></li><li class="phoenix-select__inputWrapper"><input class="phoenix-select__input"></li></ul></div></div></div>`);
  const { doc } = h;
  const root = doc.querySelector(".phoenix-select"), shown = root.querySelector(".phoenix-select__selected");
  let layer = null, year = 2026, month = 10, panel = "date";
  const draw = () => {
    const days = new Date(year, month, 0).getDate();
    const body = panel === "date" ? `<table><tbody><tr>${Array.from({ length: days }, (_, i) => `<td class="phoenix-calendar-cell" data-day="${i + 1}"><div class="phoenix-calendar-date">${i + 1}</div></td>`).join("")}</tr></tbody></table>`
      : panel === "month" ? `<table><tbody><tr>${Array.from({ length: 12 }, (_, i) => `<td data-month="${i + 1}"><a>${i + 1}月</a></td>`).join("")}</tr></tbody></table>`
      : `<table><tbody><tr>${Array.from({ length: 10 }, (_, i) => `<td data-year="${Math.floor(year / 10) * 10 + i}"><a>${Math.floor(year / 10) * 10 + i}</a></td>`).join("")}</tr></tbody></table>`;
    layer.innerHTML = `<div class="phoenix-date-picker"><div class="phoenix-calendar-header"><a class="phoenix-calendar-prev-year-btn"></a><span class="phoenix-calendar-year-select">${year}年</span>${panel === "date" ? `<span class="phoenix-calendar-month-select">${month}月</span>` : ""}<a class="phoenix-calendar-next-year-btn"></a></div>${body}</div>`;
  };
  root.addEventListener("click", () => {
    if (layer) return;
    layer = doc.createElement("div"); layer.className = "phoenix-unmodeled-layer";
    layer.addEventListener("click", (event) => {
      const el = event.target, cls = String(el.className || "");
      if (/prev-year/.test(cls)) year -= panel === "year" ? 10 : 1;
      else if (/next-year/.test(cls)) year += panel === "year" ? 10 : 1;
      else if (/year-select/.test(cls)) panel = "year";
      else if (/month-select/.test(cls)) panel = "month";
      else if (el.closest("td[data-year]")) { year = Number(el.closest("td").dataset.year); panel = "month"; }
      else if (el.closest("td[data-month]")) { month = Number(el.closest("td").dataset.month); panel = "date"; }
      else if (el.closest("td[data-day]")) { shown.textContent = `${year}-${pad(month)}-${pad(el.closest("td").dataset.day)}`; layer.remove(); layer = null; return; }
      else return;
      draw();
    });
    doc.body.append(layer); draw();
  });
  return { ...h, shown, target: scanned(doc, label) };
}

test("a date value the calendar cannot use is reported with the calendar it opened", async () => {
  const h = beisenDate("在校时间");
  const result = await h.api.operate(h.target, "2019.09-2023.06");
  assert.equal(result.reason, "invalid_date");
  assert.equal(result.observed.popupRole, "calendar");
});

test("a single date with spaces around its separators is read as that date", () => {
  assert.equal(helpers.normalizeDateValue("2019 - 09", "month"), "2019-09");
  assert.equal(helpers.normalizeDateValue("2019. 09", "month"), "2019-09");
  assert.equal(helpers.normalizeDateValue("2019 / 9 / 1", "date"), "2019-09-01");
  assert.equal(helpers.normalizeDateValue("2019 . 09 . 01 08:30", "datetime-local"), "2019-09-01T08:30");
  // 两个日期仍然不是一个日期。
  assert.equal(helpers.normalizeDateValue("2019 - 09 - 2023 - 06", "month"), "2019 - 09 - 2023 - 06");
});

test("a Beisen date given as 2019 - 09 is chosen", async () => {
  const h = beisenDate("开始时间");
  const result = await h.api.operate(h.target, "2019 - 09");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.shown.textContent, "2019-09-01");
  assert.equal(result.observed.dayDefaulted, true);
});

test("a span of two dates gives the start or the end only when the question says which", () => {
  const pick = helpers.rangeDateValue;
  assert.equal(pick("2019.09-2023.06", "开始时间"), "2019.09");
  assert.equal(pick("2019.09 - 2023.06", "入学时间"), "2019.09");
  assert.equal(pick("2019年09月至2023年06月", "入职时间"), "2019年09月");
  assert.equal(pick("2019.09-2023.06", "结束时间"), "2023.06");
  assert.equal(pick("2019.09~2023.06", "毕业时间"), "2023.06");
  assert.equal(pick("2019-09-01 至 2023-06-30", "截止日期"), "2023-06-30");
  assert.equal(pick("2019-2023", "离职年份"), "2023");
  assert.equal(pick("2019.09-2023.06", "在校时间（开始）"), "2019.09");
  assert.equal(pick("2019.09-2023.06", "Start date"), "2019.09");
  // 没写、两样都写了：原样交回，由日期控件报日期不对。
  assert.equal(pick("2019.09-2023.06", "在校时间"), "2019.09-2023.06");
  assert.equal(pick("2019.09-2023.06", "起止时间"), "2019.09-2023.06");
  // 不是正好两个日期的不动。
  assert.equal(pick("2019.09", "开始时间"), "2019.09");
  assert.equal(pick("2019.09-至今", "开始时间"), "2019.09-至今");
  assert.equal(pick("2019.09-2023.06（全日制）", "开始时间"), "2019.09-2023.06（全日制）");
  assert.equal(pick("2019.09-2021.06-2023.06", "开始时间"), "2019.09-2021.06-2023.06");
  assert.equal(pick("", "开始时间"), "");
});

test("a Beisen start or end date given a span takes the start or the end; an unnamed one stays invalid", async () => {
  const start = beisenDate("开始时间");
  const first = await start.api.operate(start.target, "2019.09-2023.06");
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(start.shown.textContent, "2019-09-01");
  const end = beisenDate("结束时间");
  const second = await end.api.operate(end.target, "2019.09-2023.06");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(end.shown.textContent, "2023-06-01");
  const both = beisenDate("起止时间");
  assert.equal((await both.api.operate(both.target, "2019.09-2023.06")).reason, "invalid_date");
});

test("an Element read-only date and a native month box given a span take the side their question names", async () => {
  const h = elementDate("毕业时间");
  const result = await h.api.operate(h.target, "2019.09.01-2023.06.30");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "2023-06-30");
  const native = load(`<label for="m">入学年月</label><input id="m" type="month">`);
  const box = native.doc.querySelector("input");
  const done = await native.api.operate({ kind: "element", element: box, root: box, controlKind: "text", binding: { label: "入学年月" }, hints: {} }, "2019.09-2023.06");
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(box.value, "2019-09");
});

// ---- 一键填写里：回车写成了别的日期 ----

test("the fill report and the side panel say a date picker left another date in the field", async (t) => {
  const ROOT = path.join(__dirname, "..");
  const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_scripts[0].js;
  const dom = new JSDOM(`<!doctype html><html><body><form><div class="ant-form-item"><div class="ant-form-item-label"><label title="毕业时间">毕业时间</label></div>
    <div class="ant-form-item-control"><span class="ant-calendar-picker"><div><input readonly placeholder="请选择日期" class="ant-calendar-picker-input ant-input"></div></span></div></div></form></body></html>`,
  { runScripts: "outside-only", pretendToBeVisual: true, url: "https://forms.example.test/apply" });
  const w = dom.window, doc = w.document;
  t.after(() => w.close());
  const box = { top: 10, left: 10, width: 300, height: 30, right: 310, bottom: 40, x: 10, y: 10, toJSON() { return this; } };
  const none = { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return this; } };
  const shownNode = (el) => { for (let node = el; node && node.nodeType === 1; node = node.parentElement) if (node.hidden) return false; return true; };
  w.Element.prototype.getBoundingClientRect = function () { return shownNode(this) ? box : none; };
  w.Element.prototype.getClientRects = function () { return shownNode(this) ? [box] : []; };
  w.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(doc, "readyState", { get: () => "loading", configurable: true });
  const listen = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, ...rest) => (type === "DOMContentLoaded" ? undefined : listen(type, ...rest));
  w.__RESUME_PRO_TEST__ = true;
  w.confirm = () => true;
  const reports = [];
  const data = { templates: [{ id: "t", name: "虚构模板", fieldCount: 1 }],
    activeTemplate: { id: "t", name: "虚构模板", groups: [{ name: "基本信息", fields: [{ key: "毕业时间", value: "2024-07-01" }] }] },
    profile: { values: {}, family: [], custom: [] }, profileRevision: 0 };
  w.chrome = {
    runtime: { id: "test-extension", getURL: (file) => `chrome-extension://test-extension/${file}`, getManifest: () => ({ version: "0.4.4" }), onMessage: { addListener() {} },
      sendMessage: async (message) => {
        if (message.type === "FEEDBACK_AUTO") { reports.push(message.report.diagnostics); return null; }
        if (message.type === "DESKTOP_RESUME_READ") return { status: "ok", data };
        if (["ENSURE_AI_HOST", "AI_HOST_READY"].includes(message.type)) return { ready: true };
        if (message.type !== "AI_FILL") return {};
        const matches = message.formFields.filter((field) => field.label === "毕业时间").map((field) => ({ fieldId: field.fieldId, value: "2024-07-01" }));
        return { success: true, matches, diagnostics: { ruleMatches: 0, aiFields: message.formFields.length, aiMatches: matches.length, promptBytes: 100, errorCode: "none" } };
      } },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } }
  };
  for (const file of SCRIPTS) w.eval(fs.readFileSync(path.join(ROOT, file), "utf8"));
  // 和上面 antCalendar 的 english 一样：标题认不出，回车交出今天。
  const field = doc.querySelector(".ant-calendar-picker-input");
  let layer = null;
  field.addEventListener("click", () => {
    if (layer) return;
    layer = doc.createElement("div");
    layer.innerHTML = `<div class="ant-calendar-picker-container"><div class="ant-calendar"><div class="ant-calendar-input-wrap"><input class="ant-calendar-input" value=""></div>
      <div class="ant-calendar-header"><span class="ant-calendar-my-select">Oct 2026</span></div>
      <table><tbody><tr>${Array.from({ length: 31 }, (_, i) => `<td><div class="ant-calendar-date">${i + 1}</div></td>`).join("")}</tr></tbody></table></div></div>`;
    layer.querySelector("input").addEventListener("keydown", (event) => { if (event.key === "Enter") { field.value = "2026-10-22"; layer.remove(); layer = null; } });
    doc.body.append(layer);
  });
  const helpersOf = w.ResumeProHighlightTest;
  helpersOf.setTextCommitWaitMs(10);
  const ui = { status: { textContent: "", className: "" }, diag: { value: "" }, cancel: { hidden: true, disabled: false, onclick: null }, fill: { disabled: false, textContent: "" } };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-diagnostics": { hidden: true, open: false }, "#resume-pro-diagnostics-text": ui.diag,
    "#resume-pro-cancel-fill": ui.cancel, "#resume-pro-ai-fill": ui.fill };
  helpersOf.setShadowRoot({ querySelectorAll: () => [], querySelector: (selector) => parts[selector] || null });
  const result = await helpersOf.handleAiFillClick({ currentTarget: ui.fill });
  assert.equal(result.filledCount, 0);
  assert.equal(field.value, "2026-10-22");
  const lines = (reports.at(-1) || "").split("\n").filter((line) => line.startsWith("- "));
  assert.deepEqual(lines, ["- 毕业时间: input[text] readonly lib=antd opened=calendar after=other reason=selection_not_committed"]);
  assert.equal(core.diagnostics(reports.at(-1)), reports.at(-1));
  assert.match(`${ui.status.textContent}\n${ui.diag.value}`, /毕业时间（选成了别的日期）/);
});
