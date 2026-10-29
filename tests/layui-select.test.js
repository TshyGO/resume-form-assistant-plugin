// #301 layui 下拉（海尔 maker.haier.net 用 layui 2.3.0）：隐藏原生 select，旁边渲染 .layui-form-select，
// 选项列表 dl 在组件根里面，点输入框才显示。DOM 和事件照 layui 2.3.0 form.js 的渲染写（真实 Chromium 里抓下的 DOM 一致）：
// 只读写法的输入框带 readonly，lay-search 写法不带；禁用时根带 layui-select-disabled、输入框带 layui-disabled。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");

const OPTIONS = [["", "请选择"], ["1", "大专"], ["2", "本科"], ["3", "硕士"], ["4", "博士"], ["5", "其他", true]];
function layui({ disabled = false, search = false, value = "" } = {}) {
  const shown = value ? OPTIONS.find(([key]) => key === value)[1] : "";
  const dom = new JSDOM(`<style>select{display:none}.layui-form-select{position:relative}
.layui-form-select dl{display:none;position:absolute;top:42px}.layui-form-selected dl{display:block}</style>
<form class="layui-form"><div class="layui-form-item"><label class="layui-form-label">姓名</label><div class="layui-input-block"><input type="text" name="name" class="layui-input"></div></div>
<div class="layui-form-item"><label class="layui-form-label">学历</label><div class="layui-input-block">
<select name="edu"${disabled ? " disabled" : ""}>${OPTIONS.map(([key, text]) => `<option value="${key}"${key === value ? " selected" : ""}>${text}</option>`).join("")}</select>
<div class="${search ? "" : "layui-unselect "}layui-form-select${disabled ? " layui-select-disabled" : ""}"><div class="layui-select-title"><input type="text" placeholder="请选择" value="${shown}"${search ? "" : " readonly"} class="layui-input${search ? "" : " layui-unselect"}${disabled ? " layui-disabled" : ""}"><i class="layui-edge"></i></div>
<dl class="layui-anim layui-anim-upbit">${OPTIONS.map(([key, text, off], index) => `<dd lay-value="${key}" class="${[index ? "" : "layui-select-tips", off ? "layui-disabled" : "", key && key === value ? "layui-this" : ""].join(" ").trim()}">${text}</dd>`).join("")}</dl></div>
</div></div></form>`, { runScripts: "outside-only" });
  const w = dom.window, doc = w.document;
  for (const file of ["ai-helpers.js", "custom-controls.js", "control-adapters.js"]) w.eval(fs.readFileSync(file, "utf8"));
  const select = doc.querySelector("select"), root = doc.querySelector(".layui-form-select");
  const title = root.querySelector(".layui-select-title"), input = title.querySelector("input");
  if (!disabled) {
    // 点标题区域展开或收起；点别处（不在标题里）全部收起；点选项写输入框和原生 select。
    title.addEventListener("click", () => root.classList.toggle("layui-form-selected"));
    doc.addEventListener("click", (event) => { if (!event.target.parentElement?.classList.contains("layui-select-title")) root.classList.remove("layui-form-selected"); });
    for (const dd of root.querySelectorAll("dd")) dd.addEventListener("click", (event) => {
      if (dd.classList.contains("layui-disabled")) return;
      input.value = dd.classList.contains("layui-select-tips") ? "" : dd.textContent;
      select.value = dd.getAttribute("lay-value");
      root.classList.remove("layui-form-selected");
      event.stopPropagation();
    });
  }
  const isVisible = (el) => { for (let node = el; node; node = node.parentElement) if (w.getComputedStyle(node).display === "none") return false; return true; };
  const api = w.ResumeProControls.create({ timeoutMs: 160, settleMs: 35, isVisible });
  const binding = scanner.scanPage(doc, { isVisible }).controls.find((control) => control.label === "学历");
  const target = { kind: "element", element: input, elements: [input], root, controlKind: "custom-select", binding };
  return { w, doc, select, root, input, isVisible, api, binding, target };
}

// content.js 的写入前复查：组件状态加组件根里显示的文字（fillValueSnapshot 的 custom-select 分支），和批准时一样才写。
function guarded(h) {
  const snapshot = () => JSON.stringify([h.w.ResumeProCustomControls.snapshot(h.target), scanner.displayedStateForGuard(h.binding, { isVisible: h.isVisible })]);
  const approved = snapshot();
  const guard = { refused: 0 };
  guard.options = { isCurrent: () => true, beforeWrite: (userEdited = false) => {
    if (!userEdited && snapshot() === approved) return true;
    guard.refused += 1;
    return false;
  } };
  return guard;
}

test("a layui select is scanned as one custom select rooted at .layui-form-select and handled as layui", () => {
  const h = layui();
  assert.equal(h.binding.controlKind, "custom-select");
  assert.equal(h.binding.element, h.input);
  assert.equal(h.binding.root, h.root);
  assert.equal(h.w.ResumeProCustomControls.describe(h.target).library, "layui");
});

test("layui options inside the component root are picked and the hidden select follows", async () => {
  const h = layui();
  const result = await h.api.operate(h.target, "本科");
  assert.equal(result.ok, true, result.reason);
  assert.equal(h.input.value, "本科");
  assert.equal(h.select.value, "2");
  assert.equal(h.root.classList.contains("layui-form-selected"), false);
  assert.equal(h.api.check(h.target).ok, true);
});

test("an already open layui list is used without clicking it shut", async () => {
  const h = layui();
  h.input.click();
  assert.equal(h.root.classList.contains("layui-form-selected"), true);
  assert.equal((await h.api.operate(h.target, "硕士")).ok, true);
  assert.equal(h.select.value, "3");
});

test("the layui hint row, a disabled option and a missing value are not selected", async () => {
  const h = layui();
  assert.equal((await h.api.operate(h.target, "请选择")).reason, "no_option_match");
  assert.equal((await h.api.operate(h.target, "其他")).reason, "no_option_match");
  assert.equal((await h.api.operate(h.target, "高中")).reason, "no_option_match");
  assert.equal(h.input.value, "");
  assert.equal(h.select.value, "");
});

test("a disabled layui select is reported as disabled", async () => {
  const h = layui({ disabled: true });
  assert.equal((await h.api.operate(h.target, "本科")).reason, "control_disabled");
});

for (const search of [false, true]) {
  test(`opening the layui list does not trip the host overwrite guard${search ? " (lay-search)" : ""}`, async () => {
    const h = layui({ search });
    const guard = guarded(h);
    const result = await h.api.operate(h.target, "本科", guard.options);
    assert.equal(guard.refused, 0, "the plugin's own open list is not a user edit");
    assert.equal(result.ok, true, result.reason);
    assert.equal(h.select.value, "2");
  });
}

test("an approved layui value is overwritten under the guard", async () => {
  const h = layui({ value: "3" });
  assert.equal(h.w.ResumeProCustomControls.hasExistingValue(h.target), true);
  const guard = guarded(h);
  const result = await h.api.operate(h.target, "本科", guard.options);
  assert.equal(guard.refused, 0);
  assert.equal(result.ok, true, result.reason);
  assert.equal(h.select.value, "2");
});

test("the open layui list is not read as the field's shown value", () => {
  const h = layui();
  h.input.click();
  assert.deepEqual(scanner.displayedStateForGuard(h.binding, { isVisible: h.isVisible }), []);
  assert.equal(scanner.hasDisplayedValue(h.binding, { isVisible: h.isVisible }), false);
});
