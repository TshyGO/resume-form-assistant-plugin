// AntD 4 日期选择器（rc-picker 2.x）的月份面板替身：点输入框打开，点年份按钮换成十年一屏的年份面板，
// 点年份回到月份面板，点月份写进输入框并收起。和 rc-picker 一样，在输入框上按 Esc、输入框失焦（焦点已不在日历里）、
// 在外面按下鼠标都会收起，值不变。表单放在一个按 Esc 关闭的对话框里（AntD Modal 的 Esc 由外层的 keydown 处理）。
// 真组件的验收见 fixtures/control-adapters/antd-v4.html。只有虚构的值。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");

// pageFocused: false 时像在侧栏里点的一键填写：网页没有焦点，blur() 只把焦点移走，不派发失焦事件。
function monthPicker({ year = 2001, pageFocused = true } = {}) {
  const dom = new JSDOM(`<div class="ant-modal-wrap" role="dialog"><form><label>出生年月 <span class="ant-picker"><span class="ant-picker-input"><input readonly placeholder="请选择月份"></span></span></label></form></div>`,
    { runScripts: "outside-only" });
  const w = dom.window, doc = w.document;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const input = doc.querySelector("input"), picker = doc.querySelector(".ant-picker");
  const outside = [], keys = [], dialog = [];
  if (!pageFocused) {
    let blurred = false;
    Object.defineProperty(doc, "activeElement", { configurable: true, get: () => (blurred ? doc.body : input) });
    input.focus = () => { blurred = false; };
    input.blur = () => { blurred = true; };
  }
  let dropdown = null, view = "month", shown = year;
  const cell = (title, text) => `<td title="${title}" class="ant-picker-cell ant-picker-cell-in-view"><div class="ant-picker-cell-inner">${text}</div></td>`;
  const header = (label) => `<div class="ant-picker-header"><button type="button" class="ant-picker-header-super-prev-btn"></button>`
    + `<div class="ant-picker-header-view">${label}</div><button type="button" class="ant-picker-header-super-next-btn"></button></div>`;
  const yearContent = () => {
    const decade = Math.floor(shown / 10) * 10;
    const years = Array.from({ length: 12 }, (_, i) => decade - 1 + i);
    return header(`${decade}-${decade + 9}`) + `<div class="ant-picker-body"><table><tbody><tr>${years.map((y) => cell(y, y)).join("")}</tr></tbody></table></div>`;
  };
  const render = () => {
    const panel = dropdown.querySelector(".ant-picker-panel");
    if (view === "year") {
      panel.innerHTML = `<div class="ant-picker-year-panel">${yearContent()}</div>`;
      return;
    }
    const months = Array.from({ length: 12 }, (_, i) => cell(`${shown}-${String(i + 1).padStart(2, "0")}`, `${i + 1}月`)).join("");
    panel.innerHTML = `<div class="ant-picker-month-panel">${header(`<button type="button" class="ant-picker-year-btn">${shown}</button>`)}`
      + `<div class="ant-picker-body"><table><tbody><tr>${months}</tr></tbody></table></div></div>`;
  };
  const close = () => dropdown?.classList.add("ant-picker-dropdown-hidden");
  const open = () => {
    if (!dropdown) {
      dropdown = doc.createElement("div");
      dropdown.className = "ant-picker-dropdown";
      dropdown.innerHTML = `<div class="ant-picker-panel-container"><div class="ant-picker-panel"></div></div>`;
      dropdown.addEventListener("click", (event) => {
        const target = event.target;
        if (target.closest(".ant-picker-year-btn")) { view = "year"; render(); return; }
        const step = target.closest(".ant-picker-header-super-prev-btn") ? -10 : target.closest(".ant-picker-header-super-next-btn") ? 10 : 0;
        // 年份面板翻页时面板还是同一个元素，只换里面的内容。
        if (step && view === "year") { shown += step; dropdown.querySelector(".ant-picker-year-panel").innerHTML = yearContent(); return; }
        const td = target.closest("td[title]");
        if (!td) return;
        if (view === "year") { shown = Number(td.title); view = "month"; render(); return; }
        input.value = td.title; close();
      });
      doc.body.append(dropdown);
    }
    view = "month"; shown = input.value ? Number(input.value.slice(0, 4)) : year;
    render();
    dropdown.classList.remove("ant-picker-dropdown-hidden");
  };
  input.addEventListener("mousedown", open);
  // rc-picker 2.x 看 e.which，React 由 keyCode 算出；React 的 onBlur 认的是 focusout。
  input.addEventListener("keydown", (event) => { keys.push(event.key); if (event.keyCode === 27) close(); });
  // 在日历里按下鼠标后，rc-picker 到下一帧才复位 preventBlur，这期间的第一次失焦不收起。
  let preventBlur = false;
  doc.addEventListener("mousedown", (event) => {
    if (!dropdown?.contains(event.target)) return;
    preventBlur = true;
    w.setTimeout(() => { preventBlur = false; }, 16);
  }, true);
  input.addEventListener("focusout", () => {
    if (preventBlur) { preventBlur = false; return; }
    if (!picker.contains(doc.activeElement) && !dropdown?.contains(doc.activeElement)) close();
  });
  doc.querySelector(".ant-modal-wrap").addEventListener("keydown", (event) => { if (event.keyCode === 27) dialog.push("closed"); });
  const away = (event) => {
    if (picker.contains(event.target) || dropdown?.contains(event.target)) return;
    outside.push(event.type);
    if (event.type === "mousedown") close();
  };
  for (const type of ["mousedown", "click"]) doc.addEventListener(type, away, true);
  const api = w.ResumeProControls.create({ timeoutMs: 300, settleMs: 35, isVisible: (el) => !el.closest("[hidden]") });
  return {
    input, outside, keys, dialog,
    open: () => Boolean(dropdown) && !dropdown.classList.contains("ant-picker-dropdown-hidden"),
    operate: (value) => api.operate({ kind: "element", element: input, pickerType: "antd" }, value)
  };
}

test("an AntD month picker fills a month through its panels", async () => {
  const h = monthPicker();
  const result = await h.operate("2024-05");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.input.value, "2024-05");
  assert.equal(h.open(), false);
  assert.deepEqual(h.keys, [], "a filled month needs no key");
  assert.deepEqual(h.outside, []);
});

test("a month the AntD picker cannot show fails and closes the picker by leaving it, never with Esc", async () => {
  // 没有 13 月：点开的日历原来一直开着，挡住后面的字段。现在让输入框失焦收起它，组件里的值不变。
  // 不按 Esc：它会冒泡到外层对话框，AntD Modal 按 Esc 就关了，表单里没保存的内容跟着没了。
  for (const pageFocused of [true, false]) {
    const h = monthPicker({ pageFocused });
    const result = await h.operate("2024-13");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_option_match");
    assert.equal(h.open(), false, `pageFocused=${pageFocused}: the picker it opened is closed`);
    assert.deepEqual(h.keys, [], "no key is pressed");
    assert.deepEqual(h.dialog, [], "the dialog around the form stays open");
    assert.equal(h.input.value, "");
    assert.deepEqual(h.outside, [], "nothing outside the picker is pressed or clicked");
  }
});
