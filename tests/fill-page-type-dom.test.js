// #301：扫描到 0 个字段时页面怎么分类、提示什么、报不报、深度分析入口多显眼。
// 用 jsdom 搭小页面，跑真实的 field-scan、probePage、pageType、emptyPageHint、fillCategory、fillFailure、offerLevel，
// 按 content.js 的接法串起来。夹具都是合成的，不含任何个人资料。
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const scanner = require("../field-scan.js");
const probeApi = require("../fill-probe.js");
const core = require("../feedback-core.js");
const deep = require("../deep-analysis.js");

// jsdom 不排版：hidden、行内 display:none / visibility:hidden 的祖先（含 Shadow DOM 宿主）算看不见，
// 其余框架默认 600×800、别的元素 300×32；data-w / data-h 可以改尺寸。
function hiddenByAncestors(el) {
  for (let cur = el; cur; cur = cur.parentElement || cur.getRootNode?.().host || null) {
    if (cur.nodeType !== 1) continue;
    if (cur.hasAttribute("hidden")) return true;
    if (/display:none|visibility:hidden/.test((cur.getAttribute("style") || "").replace(/\s+/g, ""))) return true;
  }
  return false;
}
function installLayout(win) {
  win.Element.prototype.getBoundingClientRect = function () {
    if (hiddenByAncestors(this)) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    const frame = this.tagName === "IFRAME";
    const w = Number(this.getAttribute("data-w")) || (frame ? 600 : 300);
    const h = this.hasAttribute("data-h") ? Number(this.getAttribute("data-h")) : (frame ? 800 : 32);
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h };
  };
  win.Element.prototype.getClientRects = function () {
    return hiddenByAncestors(this) ? [] : [this.getBoundingClientRect()];
  };
}

// content.js scanStats 的计数部分（只数顶层文档）。
function scanStats(doc, isVisible) {
  const all = Array.from(doc.querySelectorAll("input, select, textarea"));
  let typeHidden = 0;
  let nonFillable = 0;
  for (const el of all) {
    const type = el.tagName === "INPUT" ? String(el.type || "").toLowerCase() : "";
    if (type === "hidden") typeHidden += 1;
    else if (["file", "button", "submit", "reset", "image"].includes(type)) nonFillable += 1;
  }
  return { domInputs: all.length, typeHidden, nonFillable, visible: all.filter(isVisible).length };
}

function classify({ href, title, body, setup }) {
  const dom = new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, { url: href });
  const win = dom.window;
  const doc = win.document;
  installLayout(win);
  setup?.(doc);
  // content.js isVisible
  const isVisible = el => {
    const style = win.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const fieldCount = scanner.scanPage(doc, { isVisible, exclude: () => false }).controls.length;
  const probe = probeApi.probePage(doc, { href });
  const url = new URL(href);
  const type = probeApi.pageType({ pathname: url.pathname, hash: url.hash, title: doc.title, probe, stats: scanStats(doc, isVisible) });
  const result = { fields: fieldCount, pageType: `${type.type}/${type.reason}` };
  if (fieldCount === 0) {
    const hint = probeApi.emptyPageHint(probe, { notForm: type.type === "unknown", form: type.type === "application_form", deepAvailable: true });
    const { category } = core.fillCategory({ scanned: true, fieldCount, pageType: type.type, frames: probe.frames, failedStage: "scan",
      responded: false, matched: null, filledCount: 0, unfilledCount: 0, unconfirmedCount: 0 });
    Object.assign(result, {
      category, hint,
      report: core.fillFailure({ assisted: false, cancelled: false, overwriteDeclined: false, fieldCount, filledCount: 0,
        unfilledCount: 0, unconfirmedCount: 0, editHint: Boolean(hint) && probe.editButtons > 0, category }),
      offer: deep.offerLevel({ fieldCount, probe, pageType: type, diagnostics: {} })
    });
  }
  return result;
}

const HINT = {
  edit: "这个页面可能还在查看状态：请先点网页上的「编辑」，等输入框出现后再一键填写。",
  // #301：不再说「看起来不是网申填写页」，只说下一步。
  notForm: "请打开申请表后再试。",
  notFormFrame: "请打开申请表后再试。如果申请表就在这个页面的内嵌框架里，插件暂时读不到。",
  custom: "这个网页用的输入控件一键填写暂时识别不了。可以试试下方的「深度分析本页」。",
  // #301：网申页上没有任何线索时原来不给提示。
  loading: "请等网页加载完，或先点开要填写的部分，再试一次。"
};

const LOADING = `<div id="main-container"><div class="spin">加载中</div></div>`;
const FORM = `<form><p>如确认报名面试，请填写以下信息</p><label>姓名<input name="n"></label><label>手机号码<input name="m"></label><label>邮箱<input name="e"></label></form>`;
const crossOrigin = doc => doc.querySelectorAll("iframe[data-xo]").forEach(frame => Object.defineProperty(frame, "contentDocument", { get: () => null }));
const shadow = mode => doc => {
  doc.querySelector("x-apply").attachShadow({ mode }).innerHTML
    = "<label>First name<input></label><label>Last name<input></label><label>Email<input type=email></label>";
};
// 猎聘 atsc 网申表的查看态：分区的编辑入口是没有文字的 SVG 图标。
const SVG_EDIT = `<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>`;
const section = (name, filled) => `<div class="resume-form-section"><div class="resume-form-section-header"><span>${name}</span>`
  + `${filled ? "" : "<span>待完善/Unfinished</span>"}<div>${SVG_EDIT}</div></div><div>${filled ? "<span>某大学</span>" : ""}</div></div>`;
const wikiSections = Array.from({ length: 6 }, (_, i) => `<h2>Section ${i}<span><span>[</span><a href="/w/index.php?action=edit&amp;section=${i}">edit</a><span>]</span></span></h2><p>text</p>`).join("");

// 期望值是 #301 之前的行为：零字段的分类边界先锁住，后面的改动在这里逐行更新。
const CASES = [
  // 猎聘 atsc（路由和标题取自公开页面包）
  { name: "A1 atsc / SPA shell", href: "https://atsc.liepin.com/", title: "多面", body: `<div id="main-container"></div>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "A2 atsc / rendered title, empty DOM", href: "https://atsc.liepin.com/", title: "多面视频面试工具", body: `<div id="main-container"></div>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "A3 atsc interview room", href: "https://atsc.liepin.com/interview-room/ai/11/22/start", title: "多面AI面试",
    body: `<div id="main-container"><h2>欢迎参加AI面试</h2><video></video><button>开始面试</button></div>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "A4 atsc /ats/apply-form still loading", href: "https://atsc.liepin.com/ats/apply-form/abc", title: "多面", body: LOADING,
    expect: { fields: 0, pageType: "application_form/url", category: "no_fields_found", report: "fill_failed", hint: HINT.loading, offer: "prominent" } },
  { name: "A5 atsc interview sign-up still loading", href: "https://atsc.liepin.com/interview/invite/sign/789", title: "多面AI面试", body: LOADING,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "A6 atsc sign-up rendered", href: "https://atsc.liepin.com/interview/invite/sign/789", title: "多面AI面试", body: FORM,
    expect: { fields: 3, pageType: "application_form/structure" } },
  { name: "A7 atsc login rendered", href: "https://atsc.liepin.com/index", title: "多面视频面试工具",
    body: `<div class="login"><input placeholder="请输入手机号码"><input placeholder="请输入验证码"><button>验证码登录</button></div>`,
    expect: { fields: 2, pageType: "unknown/none" } },
  // 加载中的单页应用
  { name: "B1 SPA loading, neutral hash route", href: "https://hr.example.test/#/home", title: "某集团校园招聘", body: `<div id="app"></div>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "B2 SPA loading, hash route #/apply", href: "https://hr.example.test/#/apply/123", title: "某集团校园招聘", body: `<div id="app"></div>`,
    expect: { fields: 0, pageType: "application_form/url", category: "no_fields_found", report: "fill_failed", hint: HINT.loading, offer: "prominent" } },
  { name: "B3 SPA loading, title 填写申请表", href: "https://hr.example.test/p/9", title: "填写申请表", body: LOADING,
    expect: { fields: 0, pageType: "application_form/title", category: "no_fields_found", report: "fill_failed", hint: HINT.loading, offer: "prominent" } },
  // 入口按钮
  { name: "C1 job page behind 开始申请", href: "https://hr.example.test/position/detail/123", title: "前端工程师",
    body: `<main><h1>前端工程师</h1><p>岗位职责</p><button>开始申请</button></main>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "C2 view mode with 编辑", href: "https://hr.example.test/candidate/home", title: "个人中心",
    body: `<section><h3>教育经历</h3><span>某大学</span><a>编辑</a></section>`,
    expect: { fields: 0, pageType: "application_form/edit_button", category: "no_fields_found", report: "fill_failed", hint: HINT.edit, offer: "prominent" } },
  // #301：「去填写」算编辑入口。
  { name: "C3 view mode with 待完善 / 去填写", href: "https://hr.example.test/candidate/home", title: "个人中心",
    body: `<section><h3>教育经历</h3><span class="tag">待完善</span><a>去填写</a></section>`,
    expect: { fields: 0, pageType: "application_form/edit_button", category: "no_fields_found", report: "fill_failed", hint: HINT.edit, offer: "prominent" } },
  { name: "C4 view mode with plain English Edit", href: "https://jobs.example.test/candidate/home", title: "Candidate Home",
    body: `<section><h3>Education</h3><button>Edit</button><button aria-label="Edit education"></button></section>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  // Shadow DOM
  { name: "D1 inputs only in a closed shadow root", href: "https://jobs.example.test/careers/job/123", title: "Software Engineer",
    body: "<x-apply></x-apply>", setup: shadow("closed"),
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "D2 inputs in an open shadow root", href: "https://jobs.example.test/careers/job/123", title: "Software Engineer",
    body: "<x-apply></x-apply>", setup: shadow("open"),
    expect: { fields: 0, pageType: "application_form/structure", category: "no_fields_found", report: "fill_failed", hint: HINT.custom, offer: "prominent" } },
  // 框架
  { name: "E1 sized cross-origin iframe", href: "https://hr.example.test/job/1", title: "招聘",
    body: `<iframe src="https://ats.other.test/form" data-xo="1"></iframe>`, setup: crossOrigin,
    expect: { fields: 0, pageType: "unknown/none", category: "iframe_blocked", report: "fill_failed", hint: HINT.notFormFrame, offer: "none" } },
  { name: "E2 cross-origin iframe not sized yet", href: "https://hr.example.test/job/1", title: "招聘",
    body: `<iframe src="https://ats.other.test/form" data-xo="1" data-h="0"></iframe>`, setup: crossOrigin,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "E3 blank same-origin iframe", href: "https://hr.example.test/job/1", title: "招聘", body: "<iframe></iframe>",
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  // 自绘输入框
  { name: "F1 role=textbox divs", href: "https://hr.example.test/p/2", title: "某公司",
    body: `<div><span>姓名</span><div role="textbox" tabindex="0"></div><span>电话</span><div role="textbox" tabindex="0"></div></div>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "F2 contenteditable editor", href: "https://hr.example.test/p/2", title: "某公司",
    body: `<div><span>自我介绍</span><div contenteditable="true"></div></div>`,
    expect: { fields: 0, pageType: "application_form/structure", category: "no_fields_found", report: "fill_failed", hint: HINT.custom, offer: "prominent" } },
  // 看不见或没有题目的输入框
  { name: "G1 two visible unlabeled inputs", href: "https://hr.example.test/p/3", title: "某公司", body: "<div><input><input></div>",
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "G2 three inputs in a collapsed panel", href: "https://hr.example.test/p/3", title: "某公司",
    body: `<div style="display:none"><label>姓名<input></label><label>电话<input></label><label>邮箱<input></label></div>`,
    expect: { fields: 0, pageType: "application_form/structure", category: "no_fields_found", report: "fill_failed", hint: HINT.loading, offer: "prominent" } },
  { name: "G3 two inputs in a collapsed panel", href: "https://hr.example.test/p/3", title: "某公司",
    body: `<div style="display:none"><label>姓名<input></label><label>电话<input></label></div>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  // atsc 网申表、双语按钮、上传步骤、隐藏的登录弹窗
  { name: "X1 atsc /ats/apply-form/ view mode with icon-only edit", href: "https://atsc.liepin.com/ats/apply-form/", title: "填写申请表",
    body: `<div id="main-container"><h2>填写申请表</h2>${section("基本信息", false)}${section("教育经历", true)}${section("实习经历", false)}<button><span>提交</span></button></div>`,
    expect: { fields: 0, pageType: "application_form/url", category: "no_fields_found", report: "fill_failed", hint: HINT.loading, offer: "prominent" } },
  // #301：中英双语的「编辑 / Edit」算编辑入口。
  { name: "X2 view page with bilingual 编辑 / Edit", href: "https://app.example.test/candidate/home", title: "个人中心",
    body: `<section><h3>教育经历 Education</h3><span>某大学</span><button><span>编辑 / Edit</span></button></section><section><h3>工作经历</h3><button>编辑 / Edit</button></section>`,
    expect: { fields: 0, pageType: "application_form/edit_button", category: "no_fields_found", report: "fill_failed", hint: HINT.edit, offer: "prominent" } },
  { name: "X3 upload step with a file input, neutral path", href: "https://hr.example.test/p/step1", title: "某集团校园招聘",
    body: `<main><h2>上传简历</h2><input type="file" accept=".pdf"><button>下一步</button></main>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "X4 upload step with a file input, apply path", href: "https://hr.example.test/campus/apply/123", title: "某集团校园招聘",
    body: `<main><h2>上传简历</h2><input type="file"><button>下一步</button></main>`,
    expect: { fields: 0, pageType: "application_form/url", category: "no_fields_found", report: "fill_failed", hint: HINT.loading, offer: "prominent" } },
  { name: "X5 job page with a hidden two-input login modal", href: "https://www.example-jobs.test/job/123", title: "前端工程师-某公司",
    body: `<main><h1>前端工程师</h1><button>立即沟通</button></main><div style="display:none"><input placeholder="手机号"><input placeholder="验证码"></div>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "X6 atsc apply form, one section in edit mode", href: "https://atsc.liepin.com/ats/apply-form/edit/base-1", title: "填写申请表",
    body: `<div id="main-container">${section("教育经历", true)}<form><div><label>学校名称<input></label></div><div><label>专业<input></label></div><button>取消/Cancel</button><button>保存/Save</button></form></div>`,
    expect: { fields: 2, pageType: "application_form/url" } },
  // 带英文 edit 字样的非网申页：不能被当成查看态的申请表
  { name: "W1 wiki article with [edit] links", href: "https://en.wikipedia.test/wiki/Some_topic", title: "Some topic - Wikipedia",
    body: `<header><form role="search"><input type="search" placeholder="Search Wikipedia" aria-label="Search"></form></header><main>${wikiSections}</main>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } },
  { name: "W2 code page with Edit buttons", href: "https://code.example.test/owner/repo/blob/main/README.md", title: "repo/README.md at main",
    body: `<main><div><button aria-label="Edit this file"></button><a>Edit</a><button>Edit</button></div><article><p>readme</p></article></main>`,
    expect: { fields: 0, pageType: "unknown/none", category: "page_not_supported", report: null, hint: HINT.notForm, offer: "none" } }
];

for (const fixture of CASES) {
  test(`zero-field classification: ${fixture.name}`, () => {
    assert.deepEqual(classify(fixture), fixture.expect);
  });
}

test("the atsc shell and interview room stay unsupported, unreported and without a deep-analysis offer", () => {
  for (const name of ["A1", "A2", "A3"]) {
    const result = classify(CASES.find(fixture => fixture.name.startsWith(name)));
    assert.equal(result.category, "page_not_supported", name);
    assert.equal(result.report, null, name);
    assert.equal(result.offer, "none", name);
  }
});

test("no zero-field hint asks the user to click an apply or submit button", () => {
  for (const fixture of CASES) {
    const { hint = "" } = classify(fixture);
    assert.doesNotMatch(hint, /立即申请|投递|提交/, fixture.name);
  }
});
