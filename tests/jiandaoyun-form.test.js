// #301 / #399 简道云外链表单：题目读取（子表单、一题多框）和日期框的操作。
// 结构照 2026-10 公开报名表渲染后的 DOM（见 fixtures/field-scan/jiandaoyun-application.html），只有虚构的文字。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const core = require("../feedback-core.js");

const isVisible = (el) => !el.closest("[hidden], [style*='display: none'], [style*='display:none']");
const JDY = fs.readFileSync(path.join(__dirname, "fixtures", "field-scan", "jiandaoyun-application.html"), "utf8");

function load(html) {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

function scan(doc) {
  return scanner.scanPage(doc, { isVisible });
}

test("Jiandaoyun subform cells take their column header, and each detail row is its own entry", () => {
  const doc = new JSDOM(JDY).window.document;
  const result = scan(doc);
  const rows = result.controls.filter((control) => control.labelSource === "table-header");
  assert.deepEqual(rows.map((control) => [control.label, control.group]), [
    ["入学时间", "教育经历 1"], ["毕业时间", "教育经历 1"], ["学校名称", "教育经历 1"], ["所学专业", "教育经历 1"], ["是否全日制", "教育经历 1"],
    ["入学时间", "教育经历 2"], ["毕业时间", "教育经历 2"], ["学校名称", "教育经历 2"], ["所学专业", "教育经历 2"], ["是否全日制", "教育经历 2"],
    // 没写题目的子表单归到紧挨着它的【工作经历】，不归到表单最上面的【个人基本信息】。
    ["工作单位", "【工作经历】"], ["职务/岗位", "【工作经历】"]
  ]);
  // 单选是 div 画的，没有 input：照样按表头取题目。
  assert.equal(rows.find((control) => control.label === "是否全日制").controlKind, "radio");
  assert.equal(result.skipped.noLabel, 0);
  for (const control of result.controls) {
    assert.equal(scanner.isBindingCurrent(control, doc, { isVisible }), true, control.label);
  }
});

test("Jiandaoyun date boxes are date pickers, in plain questions and in subform rows", () => {
  const result = scan(new JSDOM(JDY).window.document);
  const dates = result.controls.filter((control) => control.controlKind === "date-picker");
  assert.deepEqual(dates.map((control) => [control.label, control.pickerType]), [
    ["出生年月", "jiandaoyun"], ["入学时间", "jiandaoyun"], ["毕业时间", "jiandaoyun"], ["入学时间", "jiandaoyun"], ["毕业时间", "jiandaoyun"]
  ]);
  for (const control of dates) {
    assert.ok(control.root.matches(".fx-form-datetime .x-datetime"), "组件根是简道云的日期框");
  }
});

test("a phone question with an SMS code box reads as the question and the question's code part, and neither is offered", () => {
  const result = scan(new JSDOM(JDY).window.document);
  const parts = result.controls.filter((control) => control.labelSource === "item-part");
  assert.deepEqual(parts.map((control) => [control.label, control.offerable]), [["手机", false], ["手机 - 短信验证码", false]]);
  // 题目旁的说明文字不是区块标题：两个框和别的题目同属一个区块。
  assert.deepEqual(parts.map((control) => control.section), ["示例单位应聘报名", "示例单位应聘报名"]);
  // 地址的省市区是 div 画的，只有「详细地址」一个框：照旧按整道题取题目。
  assert.deepEqual(result.controls.filter((control) => control.controlKind === "textarea").map((control) => [control.label, control.labelSource]), [["户籍", "item"]]);
});

test("a div table header is used only when its row lines up: same cell kind and count, no controls, not another detail row", () => {
  const cells = (texts, cls = "t-cell") => texts.map((text) => `<div class="${cls}">${text}</div>`).join("");
  const boxes = (count) => Array.from({ length: count }, () => `<div class="t-cell"><input></div>`).join("");
  const doc = load(`
    <div class="grid a"><div class="head-row">${cells(["学校", "专业", "学历"])}</div><div class="body-row">${boxes(2)}</div></div>
    <div class="grid b"><div class="body-row">${cells(["学校", "专业"])}</div><div class="body-row">${boxes(2)}</div></div>
    <div class="grid c"><div class="head-row">${cells(["学校", "<input placeholder='筛选'>"])}</div><div class="body-row">${boxes(2)}</div></div>
    <div class="grid d"><div class="head-row">${cells(["单位", "职务"])}</div><div class="body-row">${boxes(2)}</div></div>`);
  const result = scan(doc);
  // a：表头三格、明细两格；b：上一行和这一行长得一样，是另一条明细；c：表头里有控件。都不取。
  assert.deepEqual(result.controls.filter((control) => control.labelSource === "table-header").map((control) => control.label), ["单位", "职务"]);
  assert.ok(result.controls.filter((control) => control.labelSource === "table-header").every((control) => control.root.closest(".grid.d")));
  for (const grid of ["a", "b"]) {
    assert.equal(result.controls.some((control) => control.root.closest(`.grid.${grid}`)), false, `grid ${grid}`);
  }
});

test("several boxes under one title are named title - part only when every other box has its own part name", () => {
  const doc = load(`
    <div class="item"><label class="item-label">现居地址</label><div class="ctrl"><input placeholder="请选择省"><input placeholder="市"><input placeholder="区"><textarea placeholder="详细地址"></textarea></div></div>
    <div class="item"><label class="item-label">紧急联系人</label><div class="ctrl"><input><input></div></div>
    <div class="item"><label class="item-label">证件</label><div class="ctrl"><input placeholder="号码"><select><option>身份证</option></select></div></div>
    <div class="item"><label class="item-label">起止</label><div class="ctrl"><input placeholder="开始"><label class="item-label">备注</label><input placeholder="说明"></div></div>
    <div class="item"><div class="row"><div class="title">姓名</div><input placeholder="请填写真实姓名"></div><div class="row"><input placeholder="毕业论文题目"></div></div>`);
  const result = scan(doc);
  assert.deepEqual(result.controls.filter((control) => control.labelSource === "item-part").map((control) => control.label),
    ["现居地址 - 省", "现居地址 - 市", "现居地址 - 区", "现居地址 - 详细地址"]);
  // 两个框都没有子项分不清；和下拉挤在一起的不是一题多框；框之间又有题目的是两道题；
  // 题目在第一个框自己那一行里，下一行只有占位文字的框是另一道题，不叫「姓名 - 毕业论文题目」。
  const bare = (selector) => result.controls.filter((control) => control.root.closest(selector) && control.labelSource === "item-part");
  for (const index of [2, 3, 4, 5]) assert.deepEqual(bare(`.item:nth-of-type(${index})`), [], `item ${index}`);
  assert.deepEqual(result.controls.filter((control) => control.root.closest(".item:nth-of-type(5)")).map((control) => [control.label, control.labelSource]),
    [["姓名", "item"], ["", "placeholder"]]);
});

test("a box without its own part name is the question itself only beside a code box: area code and similar first boxes stay unnamed", () => {
  const doc = load(`
    <div class="item"><label class="item-label">手机号码</label><div class="phone"><input class="area" value="+86"><input class="num" placeholder="请输入手机号码"></div></div>
    <div class="item"><label class="item-label">联系电话</label><div class="phone"><input class="area" placeholder="+86"><input class="num" placeholder="请输入手机号"></div></div>
    <div class="item"><div class="item-label">证件</div><div><input class="kind"><input class="num" placeholder="证件号码"></div></div>
    <div class="item"><label class="item-label">手机号</label><div><input class="num"><input class="code" placeholder="验证码"></div></div>`);
  const result = scan(doc);
  // 区号框被叫成「手机号码」，按手机号匹配就会把手机号填进区号框：不取，和以前一样只靠占位文字。
  for (const index of [1, 2, 3]) {
    const controls = result.controls.filter((control) => control.root.closest(`.item:nth-of-type(${index})`));
    assert.deepEqual(controls.map((control) => [control.element.className, control.label, control.labelSource]), [["num", "", "placeholder"]], `item ${index}`);
  }
  assert.equal(result.skipped.noLabel, 3);
  assert.deepEqual(result.controls.filter((control) => control.labelSource === "item-part").map((control) => control.label), ["手机号", "手机号 - 验证码"]);
});

test("cell-classed layouts without a header row keep their old labels: Element td > div.cell, label/value div grids, Vant cells", () => {
  const td = (inner) => `<td class="el-table__cell"><div class="cell">${inner}</div></td>`;
  const box = `<div class="el-input"><input class="el-input__inner"></div>`;
  const element = scan(load(`<div class="el-table"><div class="el-table__header-wrapper"><table class="el-table__header"><thead><tr>
      <th class="el-table__cell"><div class="cell">称谓</div></th><th class="el-table__cell"><div class="cell">姓名</div></th><th class="el-table__cell"><div class="cell">联系电话</div></th></tr></thead></table></div>
    <div class="el-table__body-wrapper"><table class="el-table__body"><tbody>
      <tr class="el-table__row">${td("父亲")}${td(box)}${td(box)}</tr><tr class="el-table__row">${td("母亲")}${td(box)}${td(box)}</tr></tbody></table></div></div>`));
  // td 里的 div.cell 不当 div 表格的格子：同一行前面的「父亲」不是表头，最后一列照旧读不出题目。
  assert.equal(element.controls.some((control) => control.labelSource === "table-header"), false);
  assert.equal(element.skipped.noLabel, 2);

  const grid = scan(load(`<div class="form-grid">
    <div class="grid-row info"><div class="grid-cell">申请岗位</div><div class="grid-cell">护士</div><div class="grid-cell">工作地点</div><div class="grid-cell">上海</div></div>
    <div class="grid-row"><div class="grid-cell">姓名</div><div class="grid-cell"><input></div><div class="grid-cell">电话</div><div class="grid-cell"><input></div></div>
    <div class="grid-row"><div class="grid-cell">邮箱</div><div class="grid-cell"><input></div><div class="grid-cell">学校</div><div class="grid-cell"><input></div></div></div>`));
  assert.deepEqual(grid.controls.map((control) => [control.label, control.labelSource]), [["姓名", "sibling"], ["电话", "sibling"], ["邮箱", "sibling"], ["学校", "sibling"]]);

  const vant = scan(load(`<div class="page"><div class="van-cell-group van-cell-group--inset">
      <div class="van-cell"><div class="van-cell__title">应聘岗位</div><div class="van-cell__value">护士</div></div>
      <div class="van-cell"><div class="van-cell__title">工作地点</div><div class="van-cell__value">上海</div></div></div>
    <div class="van-cell-group">
      <div class="van-cell van-field"><div class="van-cell__value van-field__value"><div class="van-field__body"><input class="van-field__control" placeholder="请输入姓名"></div></div></div>
      <div class="van-cell van-field"><div class="van-cell__value van-field__value"><div class="van-field__body"><input class="van-field__control" placeholder="请输入手机号"></div></div></div></div></div>`));
  // 上面一组只读信息行既不是表头，也不是这两个框的题目。
  assert.deepEqual(vant.controls.map((control) => [control.label, control.labelSource]), [["", "placeholder"], ["", "placeholder"]]);
});

test("entries separated by a caption line stay one numbered list", () => {
  const entry = `<div class="sc-entry"><div class="sc-item"><div class="sc-lbl">学校</div><input></div><div class="sc-item"><div class="sc-lbl">专业</div><input></div></div>`;
  for (const between of [`<div class="sc-sub">第2段</div>`, `<div class="sc-note">（如有第二学历请继续填写）</div>`]) {
    const result = scan(load(`<div class="sc-form"><div class="sc-item"><div class="sc-lbl">姓名</div><input></div><div class="sc-item"><div class="sc-lbl">邮箱</div><input></div>
      <div class="sc-sec"><div class="sc-h">教育经历</div>${entry}${between}${entry}</div></div>`));
    assert.deepEqual(result.controls.slice(2).map((control) => [control.label, control.group, control.repeatIndex]),
      [["学校", "教育经历 1", 1], ["专业", "教育经历 1", 1], ["学校", "教育经历 2", 2], ["专业", "教育经历 2", 2]], between);
  }
});

test("label sources fold the new kinds into the reported vocabulary, and picker=jiandaoyun survives the allowlist", () => {
  assert.deepEqual(core.labelSources({ sources: { item: 1, "item-part": 2, "table-header": 3 } }), [["item", 3], ["table", 3]]);
  const report = core.fillReport({ fieldCount: 1, unfilledControls: [{ label: "出生年月", reasonCode: "no_option_match", observed: { opened: "calendar" },
    control: { tag: "input", type: "text", picker: "jiandaoyun" } }] });
  assert.match(report, /^- 出生年月: input\[text\] picker=jiandaoyun opened=calendar reason=no_option_match$/m);
});

// 简道云日期框（jdy-design 的 x-datetime，外面是表单的 .fx-form-datetime）的替身，按真页面上观察到的行为写：
// - 点框打开日历（挂在 body 下的 .x-popup.x-datetime-content）。框里打字按格式逐段解析（缺的段取最小值），
//   日历跳到打的日子；打字不会把值交给表单。框里是空的或没有数字时读成 1901-01-01。
//   超出允许范围的日子是 disabled、不算选中；真组件会不会也指向它没验证过，替身按最坏的情况：指向它，收起时交出去。
// - 点日子 / 月份 / 年份格子：交给表单、收起。在框外按下鼠标：收起，把日历指着的日子交给表单。
// - 框失焦：框里改成按格式显示，日历不收起，表单里还是原来的值。框有焦点时点框不收起，失焦后再点框才收起，
//   也把日历指着的日子交给表单。
// - 点框里的清除按钮：表单里清空，日历收起；框里的字等失焦才清掉。
// - Esc：收起但不交给表单。
const TODAY = { y: 2026, m: 10, d: 31 };
function jdyDateBox({ format = "yyyy-MM-dd", min = "", max = "", value = "" } = {}) {
  const dom = new JSDOM(`<div class="fx-form"><div class="widget-list">
    <div class="fx-field"><div class="field-label"><div class="field-name">出生年月</div></div><div class="field-component"><div class="fx-form-datetime" tabindex="-1"><div class="x-datetime datetime-trigger-input has-clear"><div class="datetime-label" tabindex="0"><div class="x-input x-date-input input-normal"><div class="x-inner-wrapper"><input type="text" tabindex="-1" class="input-inner" value=""></div></div></div><i class="clear-icon"></i><i class="datetime-icon"></i></div></div></div></div>
    <div class="fx-field"><div class="field-label"><div class="field-name">姓名</div></div><div class="field-component"><input type="text" id="other"></div></div>
  </div></div>`, { runScripts: "outside-only" });
  const w = dom.window, doc = w.document;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
  const input = doc.querySelector(".fx-form-datetime input"), root = doc.querySelector(".x-datetime"), label = doc.querySelector(".datetime-label");
  const pad = (n) => String(n).padStart(2, "0");
  const key = (date) => `${date.y}-${pad(date.m)}-${pad(date.d)}`;
  const show = (date) => !date ? "" : format === "yyyy" ? `${date.y}` : format === "yyyy-MM" ? `${date.y}-${pad(date.m)}`
    : format.includes("HH") ? `${key(date)} 00:00` : key(date);
  const allowed = (date) => (!min || key(date) >= min) && (!max || key(date) <= max);
  const daysIn = (y, m) => new Date(y, m, 0).getDate();
  const parse = (text) => {
    const groups = String(text).replace(/\D+/g, " ").trim().split(" ").filter(Boolean);
    if (!groups.length) return { y: 1901, m: 1, d: 1 };
    const clamp = (raw, lo, hi) => { const n = Number(raw || 0); return n < lo || n > hi ? lo : n; };
    const y = groups[0].length === 4 ? Number(groups[0]) : 1000;
    const m = format === "yyyy" ? 1 : clamp(groups[1], 1, 12);
    const d = format === "yyyy" || format === "yyyy-MM" ? 1 : clamp(groups[2], 1, daysIn(y, m));
    return { y, m, d };
  };
  const initial = value ? parse(value) : null;
  const state = { model: initial ? show(initial) : "", pending: initial, open: false, keys: [], outside: [], commits: 0 };
  input.value = state.model;
  let popup = null;
  const mode = format === "yyyy" ? "year" : format === "yyyy-MM" ? "month" : "date";
  const render = () => {
    const view = state.pending || TODAY;
    const head = (inner) => `<div class="date-head"><div class="head-btn btn-prevy"></div>${inner}<div class="head-btn btn-nexty"></div></div>`;
    let body;
    if (mode === "year") {
      const start = Math.floor(view.y / 10) * 10 - 1;
      const years = Array.from({ length: 12 }, (_, i) => start + i);
      body = head(`<span><div class="head-btn btn-year default">${start + 1}~${start + 10}</div></span>`)
        + `<div class="date-year">${years.map((y) => `<div class="item-cell" data-y="${y}"><div class="cell-btn${state.pending && y === view.y ? " select" : ""}">${y}</div></div>`).join("")}</div>`;
    } else if (mode === "month") {
      body = head(`<span><div class="head-btn btn-year">${view.y}</div></span>`)
        + `<div class="date-month">${Array.from({ length: 12 }, (_, i) => `<div class="item-cell" data-m="${i + 1}"><div class="cell-btn${state.pending && i + 1 === view.m ? " select" : ""}">${i + 1}月</div></div>`).join("")}</div>`;
    } else {
      const days = [`<div class="day nav oday" data-d="0"><div class="td-text">30</div></div>`];
      for (let d = 1; d <= daysIn(view.y, view.m); d += 1) {
        const date = { y: view.y, m: view.m, d };
        const cls = ["day", "nav", allowed(date) ? "" : "disabled", d === view.d && allowed(date) ? "selected" : ""].filter(Boolean).join(" ");
        days.push(`<div class="${cls}" data-d="${d}"><div class="td-text">${d}</div></div>`);
      }
      days.push(`<div class="day nav oday" data-d="0"><div class="td-text">1</div></div>`);
      body = `<div class="date-head"><div class="head-btn btn-prevy"></div><div class="head-btn btn-prevm"></div><span><div class="head-btn btn-year">${view.y}</div><div class="head-btn btn-month">${view.m}月</div></span><div class="head-btn btn-nextm"></div><div class="head-btn btn-nexty"></div></div>`
        + `<div class="date-body"><div class="date-body-rows"><div class="date-body-row">${days.join("")}</div></div></div>`
        + (format.includes("HH") ? `<div class="date-time-picker"><div class="time-body"></div></div>` : "");
    }
    popup.querySelector(".picker-content").innerHTML = body;
  };
  const commit = (date) => {
    state.pending = date;
    state.model = show(date);
    state.commits += 1;
  };
  const close = (deliver) => {
    if (!state.open) return;
    state.open = false;
    popup.hidden = true;
    if (deliver && state.pending) commit(state.pending);
    input.value = show(state.pending);
  };
  const open = () => {
    if (!popup) {
      popup = doc.createElement("div");
      popup.className = "x-popup x-datetime-css-var placement-bottom-left x-datetime x-datetime-content";
      popup.innerHTML = `<div class="x-datepicker"><div class="picker-body"><div class="picker-content"></div></div><div class="date-foot"></div></div>`;
      popup.addEventListener("click", (event) => {
        const cell = event.target.closest(".day, .item-cell");
        if (!cell || cell.matches(".disabled, .oday")) return;
        const view = state.pending || TODAY;
        const date = mode === "year" ? { y: Number(cell.dataset.y), m: 1, d: 1 }
          : mode === "month" ? { y: view.y, m: Number(cell.dataset.m), d: 1 } : { y: view.y, m: view.m, d: Number(cell.dataset.d) };
        if (format.includes("HH")) { state.pending = date; render(); return; }
        commit(date);
        state.open = false;
        popup.hidden = true;
        label.focus();
        input.value = show(state.pending);
      });
      doc.body.append(popup);
    }
    state.open = true;
    popup.hidden = false;
    render();
  };
  root.addEventListener("click", () => {
    if (!state.open) open();
    else if (doc.activeElement !== input) close(true);
  });
  input.addEventListener("input", () => {
    if (!state.open) open();
    state.pending = parse(input.value);
    render();
  });
  doc.querySelector(".clear-icon").addEventListener("click", (event) => {
    event.stopPropagation();
    commit(null);
    state.open = false;
    if (popup) popup.hidden = true;
  });
  input.addEventListener("blur", () => { input.value = show(state.pending); });
  input.addEventListener("keydown", (event) => {
    state.keys.push(event.key);
    if (event.key === "Escape") { state.open = false; if (popup) popup.hidden = true; }
  });
  doc.addEventListener("mousedown", (event) => {
    if (root.contains(event.target) || popup?.contains(event.target)) return;
    state.outside.push(event.type);
    close(true);
  }, true);
  const api = w.ResumeProControls.create({ timeoutMs: 300, settleMs: 35, isVisible: (el) => !el.closest("[hidden]") });
  return {
    input, state, doc,
    popupOpen: () => Boolean(popup) && !popup.hidden,
    operate: (raw) => api.operate({ kind: "element", element: input, controlKind: "date", pickerType: "jiandaoyun" }, raw)
  };
}

test("a Jiandaoyun date box gets the date through its calendar, so the form holds it and the calendar is closed", async () => {
  const h = jdyDateBox();
  const result = await h.operate("2016-07-15");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "2016-07-15");
  assert.equal(h.state.model, "2016-07-15", "表单里有这个日期，不只是框里显示着");
  assert.equal(h.popupOpen(), false);
  assert.equal(result.observed.dayDefaulted, undefined);
  assert.deepEqual(h.state.keys, [], "不按键");
  assert.deepEqual(h.state.outside, [], "不在框外按鼠标");
});

test("a year-month box (出生年月) is filled at month precision, from a month or a full date", async () => {
  for (const raw of ["1999-05", "1999.5", "1999年5月12日"]) {
    const h = jdyDateBox({ format: "yyyy-MM" });
    const result = await h.operate(raw);
    assert.equal(result.ok, true, `${raw}: ${JSON.stringify(result)}`);
    assert.equal(h.state.model, "1999-05", raw);
    assert.equal(h.popupOpen(), false, raw);
  }
});

test("a year box takes a bare year; a month-only resume date in a day calendar picks the 1st and says so", async () => {
  const year = jdyDateBox({ format: "yyyy" });
  assert.equal((await year.operate("2019")).ok, true);
  assert.equal(year.state.model, "2019");

  const day = jdyDateBox();
  const result = await day.operate("2018-03");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(day.state.model, "2018-03-01");
  assert.equal(result.observed.dayDefaulted, true);
});

test("a date the form does not allow fails, keeps the old value and closes the calendar it opened, without a key", async () => {
  // 收起日历会把日历指着的日子交给表单：先写回原来的字，日历指回原来的日子再收。
  const h = jdyDateBox({ min: "2000-01-01", value: "2005-05-05" });
  const result = await h.operate("1990-01-01");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_option_match");
  assert.equal(h.state.model, "2005-05-05");
  assert.equal(h.input.value, "2005-05-05");
  assert.equal(h.popupOpen(), false);
  assert.deepEqual(h.state.keys, []);
  assert.deepEqual(h.state.outside, []);

  // 原来是空的：写回空字会被读成 1901-01-01，改点清除按钮，表单里还是空的，框里的字也清掉。
  const empty = jdyDateBox({ min: "2000-01-01" });
  const failed = await empty.operate("1990-01-01");
  assert.equal(failed.reason, "no_option_match");
  assert.equal(empty.state.model, "");
  assert.equal(empty.input.value, "");
  assert.equal(empty.popupOpen(), false);
  assert.deepEqual(empty.state.keys, []);
  assert.deepEqual(empty.state.outside, []);
});

test("impossible or too coarse dates fail before the calendar is touched; date-time boxes are left alone", async () => {
  for (const [raw, format] of [["2024-13", "yyyy-MM-dd"], ["1998-02-30", "yyyy-MM-dd"], ["至今", "yyyy-MM-dd"], ["2019", "yyyy-MM"]]) {
    const h = jdyDateBox({ format });
    const result = await h.operate(raw);
    assert.equal(result.reason, "invalid_date", `${raw} → ${format}`);
    assert.equal(h.state.model, "");
    assert.equal(h.popupOpen(), false, raw);
  }
  const timed = jdyDateBox({ format: "yyyy-MM-dd HH:mm", value: "2020-01-02" });
  const result = await timed.operate("2016-07-15");
  assert.equal(result.reason, "unsupported_control");
  assert.equal(timed.state.model, "2020-01-02 00:00");
  assert.equal(timed.popupOpen(), false);
  assert.deepEqual(timed.state.keys, []);
});
