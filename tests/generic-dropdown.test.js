// #224 通用下拉路径：深度分析把普通输入框认成下拉（北森 phoenix、Moka sd 这类没有 ARIA 的自研组件）时，
// 控件操作器只认点开后新出现、贴着控件的弹层，按原文唯一匹配条目，点选后读回组件显示的文字核验。
// 合成组件按 2026-10-11 真机看到的结构写：弹层挂在 body 下，条目是只含一段文字的 div，选项「男/Male」这样中英双语。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");

function harness({ choices = ["男/Male", "女/Female"], onPick, searchable = false, twoPopups = false } = {}) {
  const dom = new JSDOM(`<form><div class="item"><label>性别</label>
    <label class="sd-Select-container select"><input class="sd-Input-input" placeholder="请选择 / Please select"></label></div>
    <div class="err" hidden></div></form>`, { runScripts: "outside-only" });
  const w = dom.window;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: (el) => !el.closest("[hidden]") });
  const doc = w.document;
  const input = doc.querySelector("input");
  const root = doc.querySelector(".sd-Select-container");
  const clicks = [];
  const open = (list) => {
    const popup = doc.createElement("div");
    popup.className = "sd-Dropdown-dropdown";
    for (const text of list) {
      const item = doc.createElement("div");
      item.className = "sd-Menu-content-item";
      item.innerHTML = `<div class="option-label">${text}</div>`;
      item.addEventListener("click", () => { clicks.push(text); (onPick || ((t) => { input.value = t; }))(text); popup.remove(); });
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
  const target = { kind: "element", element: input, elements: [input], root, controlKind: "custom-select", genericPopup: true, hints: {} };
  return { w, doc, api, input, root, target, clicks };
}

test("a Moka-style dropdown without ARIA: the new popup next to it is used and the bilingual option is chosen", async () => {
  const h = harness();
  const result = await h.api.operate(h.target, "男");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["男/Male"]);
  assert.equal(h.input.value, "男/Male");
  assert.equal(h.api.check(h.target).ok, true);
});

test("a component that shows only the Chinese part after selecting is accepted too", async () => {
  const h = harness({ onPick: (text) => { h.input.value = text.split("/")[0]; } });
  assert.equal((await h.api.operate(h.target, "女")).ok, true);
  assert.equal(h.input.value, "女");
});

test("no matching option fails without clicking anything, and a tried search is put back", async () => {
  const h = harness({ choices: ["汉族", "回族"] });
  const result = await h.api.operate(h.target, "苗族");
  assert.equal(result.ok, false);
  // 通用路径找不到时会试着在下拉自己的输入框里搜一次；搜不到同样失败，搜索词恢复原样。
  assert.ok(["no_option_match", "options_timeout"].includes(result.reason), result.reason);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.input.value, "");
});

test("two popups appearing at once is ambiguous: nothing is chosen", async () => {
  const h = harness({ twoPopups: true });
  const result = await h.api.operate(h.target, "男");
  assert.equal(result.reason, "ambiguous_popup");
  assert.deepEqual(h.clicks, []);
});

test("a component that rolls back the choice is not counted as filled", async () => {
  const h = harness({ onPick: () => { h.input.value = ""; } });
  const result = await h.api.operate(h.target, "男");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "selection_not_committed");
});

test("a type-to-search dropdown (school, major) gets the value typed, then the matching suggestion is picked", async () => {
  const h = harness({ searchable: true, choices: ["示例理工大学", "示例师范大学"] });
  const result = await h.api.operate(h.target, "示例理工大学");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ["示例理工大学"]);
});

test("a type-to-search dropdown with no matching suggestion restores what was in the box", async () => {
  const h = harness({ searchable: true, choices: ["示例师范大学"] });
  h.input.value = "";
  const result = await h.api.operate(h.target, "示例理工大学");
  assert.equal(result.ok, false);
  assert.equal(h.input.value, "", "the typed query is put back");
  assert.deepEqual(h.clicks, []);
});

test("cascaders stay unsupported on the generic path: no guessing which column is which", async () => {
  const h = harness();
  const result = await h.api.operate({ ...h.target, controlKind: "cascader" }, "广东省 / 深圳市");
  assert.equal(result.reason, "unsupported_control");
  assert.deepEqual(h.clicks, []);
});

test("controls without the deep-analysis flag never take the generic path", async () => {
  const h = harness();
  const { genericPopup, ...plain } = h.target;
  const result = await h.api.operate(plain, "男");
  assert.equal(result.ok, false);
  assert.deepEqual(h.clicks, [], "the ARIA path does not pick from an unassociated popup");
});
