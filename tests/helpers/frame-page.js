// #400 顶层是导航壳、表单在同源 iframe 里的页面：按 manifest 的顺序把内容脚本注入 jsdom 顶层（侧栏只在顶层），
// 框架内容由测试写进各个 iframe 的文档。桌面、AI 和存储都是替身；AI 按字段名从 values 里取值。夹具都是合成的。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const SCRIPTS = manifest.content_scripts.find((entry) => entry.js?.includes("content.js")).js;
const SOURCES = Object.fromEntries(SCRIPTS.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 简历里的值，按网页上的字段名取。
const VALUES = { 姓名: "测试用户", 学历: "本科", 性别: "女", 出生日期: "1998-06-01", 个人简介: "喜欢写代码", 服从: "是" };

// 文本、原生下拉、单选、日期、文本域、复选。
const FORM = `<form class="info">
  <div class="row"><label for="xm">姓名</label><input id="xm" name="xm"></div>
  <div class="row"><label for="xl">学历</label><select id="xl" name="xl"><option value="">请选择</option><option value="1">本科</option><option value="2">硕士</option></select></div>
  <div class="row"><div class="label">性别</div><span class="opts"><label><input type="radio" name="xb" value="1">男</label><label><input type="radio" name="xb" value="2">女</label></span></div>
  <div class="row"><label for="cs">出生日期</label><input id="cs" type="date"></div>
  <div class="row"><label for="jl">个人简介</label><textarea id="jl"></textarea></div>
  <div class="row"><span>是否服从调剂</span><label><input type="checkbox" id="tj">服从</label></div>
  <button type="button" id="next">下一步</button>
</form>`;

// jsdom 不排版：自己或祖先 hidden、display:none、visibility:hidden（行内或样式表里的）算看不见；框架默认 800×600，
// 别的元素 300×32；data-w / data-h / data-left / data-top 可以改。位置相对元素自己的视口。
function hiddenByAncestors(el) {
  const view = el.ownerDocument.defaultView;
  for (let cur = el; cur; cur = cur.parentElement) {
    if (cur.hasAttribute("hidden")) return true;
    const style = view.getComputedStyle(cur);
    if (style.display === "none" || style.visibility === "hidden") return true;
  }
  return false;
}
function installLayout(win) {
  win.Element.prototype.getBoundingClientRect = function () {
    if (hiddenByAncestors(this)) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    const frame = this.tagName === "IFRAME" || this.tagName === "FRAME";
    const width = this.hasAttribute("data-w") ? Number(this.getAttribute("data-w")) : (frame ? 800 : 300);
    const height = this.hasAttribute("data-h") ? Number(this.getAttribute("data-h")) : (frame ? 600 : 32);
    const left = Number(this.getAttribute("data-left")) || 0;
    const top = Number(this.getAttribute("data-top")) || 0;
    return { width, height, top, left, right: left + width, bottom: top + height, x: left, y: top };
  };
  win.Element.prototype.getClientRects = function () {
    return hiddenByAncestors(this) ? [] : [this.getBoundingClientRect()];
  };
}

// frames：{ iframe 的 id: 内容 }，内容是 HTML，或 { html, frames } 再往下一层。
async function fillFrames(doc, frames, windows) {
  for (const [id, spec] of Object.entries(frames || {})) {
    const element = doc.getElementById(id);
    for (let i = 0; i < 100 && !element.contentDocument?.body; i += 1) await wait(1);
    const inner = element.contentDocument;
    installLayout(inner.defaultView);
    windows.push(inner.defaultView);
    inner.body.innerHTML = typeof spec === "string" ? spec : spec.html;
    await wait(5);
    if (typeof spec === "object") await fillFrames(inner, spec.frames, windows);
  }
}

async function openFramedPage({ top, frames = {}, url = "https://bm.example.test/pages/personalCenter.html", values = VALUES } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>个人中心</title></head><body>${top}</body></html>`,
    { url, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  for (let i = 0; win.document.readyState !== "complete" && i < 200; i += 1) await wait(1);
  installLayout(win);
  const windows = [win];
  await fillFrames(win.document, frames, windows);

  const reports = [];
  const aiRequests = [];
  const listeners = [];
  const template = { id: "t", name: "测试模板", groups: [{ name: "基本信息", fields: Object.entries(values).map(([key, value]) => ({ key, value })) }] };
  win.chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (name) => ORIGIN + name,
      getManifest: () => ({ version: "0.4.4" }),
      sendMessage: async (message) => {
        if (message.type === "FEEDBACK_AUTO") { reports.push(message.report); return null; }
        if (message.type === "DESKTOP_RESUME_READ") {
          return { status: "ok", data: { templates: [{ id: "t", name: template.name, fieldCount: template.groups[0].fields.length }],
            activeTemplate: template, profile: { values: {}, family: [], custom: [] }, profileRevision: 0 } };
        }
        if (message.type === "ENSURE_AI_HOST" || message.type === "AI_HOST_READY") return { ready: true };
        if (message.type === "AI_FILL") {
          aiRequests.push(message);
          const matches = message.formFields.filter((field) => values[field.label]).map((field) => ({ fieldId: field.fieldId, value: values[field.label] }));
          return { success: true, matches, diagnostics: { errorCode: matches.length ? "none" : "no_context", ruleMatches: matches.length,
            aiFields: 0, aiMatches: 0, promptBytes: 0, resumeFields: Object.keys(values).length, candidateFields: matches.length } };
        }
        return null;
      },
      onMessage: { addListener: (listener) => listeners.push(listener) }
    },
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} }
    }
  };
  win.fetch = async () => ({ ok: true, status: 200, text: async () => ".resume-pro { display: none; }" });
  win.CSSStyleSheet = class { replaceSync(text) { this.text = text; } };
  win.confirm = () => true;
  win.__RESUME_PRO_TEST__ = true;
  const context = dom.getInternalVMContext();
  for (const file of SCRIPTS) new vm.Script(SOURCES[file], { filename: ORIGIN + file }).runInContext(context);
  await wait(30);
  const hooks = win.ResumeProHighlightTest;
  hooks.setTextCommitWaitMs(0);

  const panel = (message, sender = { id: EXTENSION_ID }) => new Promise((resolve) => {
    const keepOpen = listeners[0](message, sender, resolve);
    if (!keepOpen) setImmediate(() => resolve(undefined));
  });
  // 按 id 找元素：顶层没有就到各层框架里找。
  const find = (id) => windows.map((w) => w.document.getElementById(id)).find(Boolean) || null;
  const frame = (...ids) => {
    let doc = win.document;
    for (const id of ids) doc = doc.getElementById(id).contentDocument;
    return doc;
  };
  return {
    win, windows, hooks, reports, aiRequests, panel, find, frame,
    fill: () => hooks.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } }),
    status: () => panel({ type: "RESUME_PANEL_STATUS" })
  };
}

// 一份表单在某个文档里填成了什么样（只看控件状态）。
function formState(doc) {
  const radio = Array.from(doc.querySelectorAll("input[name=xb]")).find((el) => el.checked);
  return {
    姓名: doc.getElementById("xm").value,
    学历: doc.getElementById("xl").selectedOptions[0]?.text || "",
    性别: radio ? radio.parentElement.textContent.trim() : "",
    出生日期: doc.getElementById("cs").value,
    个人简介: doc.getElementById("jl").value,
    服从: doc.getElementById("tj").checked
  };
}

const FILLED = { 姓名: "测试用户", 学历: "本科", 性别: "女", 出生日期: "1998-06-01", 个人简介: "喜欢写代码", 服从: true };
const EMPTY_FORM = { 姓名: "", 学历: "请选择", 性别: "", 出生日期: "", 个人简介: "", 服从: false };

module.exports = { openFramedPage, installLayout, formState, FORM, VALUES, FILLED, EMPTY_FORM, EXTENSION_ID };
