// #256 #275 #296：内容脚本按 manifest 顺序注入真实 DOM（jsdom）后的启动。
// 覆盖页面上名为 module 的元素或框架、XML/SVG 文档、content.css 读取失败、侧栏状态读不到、
// 重复注入、辅助脚本缺失。夹具里没有任何简历内容或个人资料。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const SCRIPTS = manifest.content_scripts.find((entry) => entry.js?.includes("content.js")).js;
const SOURCES = Object.fromEntries(SCRIPTS.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
// Every helper global content.js reads, taken from its own source.
const USED_GLOBALS = [...new Set(SOURCES["content.js"].match(/\bResumePro[A-Z][A-Za-z]*/g))]
  .filter((name) => name !== "ResumeProHighlightTest").sort();
const FORM_PAGE = '<!doctype html><html><head><title>申请</title></head><body><form><label>姓名 <input name="name"></label></form></body></html>';
const SIDEBAR_ID = "resume-pro-sidebar";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What a cross-origin frame named "module" is to a content script: any property access throws.
function crossOriginFrame(win) {
  const deny = () => {
    throw new win.DOMException("Blocked a frame from accessing a cross-origin frame.", "SecurityError");
  };
  return new Proxy({}, {
    get: deny, set: deny, has: deny, defineProperty: deny, deleteProperty: deny,
    getOwnPropertyDescriptor: deny, ownKeys: deny, getPrototypeOf: deny, setPrototypeOf: deny
  });
}

// Injects the content scripts the way Chrome does at document_idle: each file on its own, so one
// that throws does not stop the next.
async function openPage({ html = FORM_PAGE, contentType = "text/html", setup, scripts = SCRIPTS, runs = 1,
  storageGet = async () => ({}), cssFails = false } = {}) {
  const dom = new JSDOM(html, { url: "https://jobs.example.test/apply", contentType, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window;
  for (let i = 0; win.document.readyState !== "complete" && i < 200; i += 1) await wait(1);
  const reports = [];
  const listeners = [];
  const rejections = [];
  const thrown = [];
  win.chrome = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (name) => ORIGIN + name,
      sendMessage: async (message) => {
        if (message.type === "FEEDBACK_AUTO") reports.push(message.report);
        return null;
      },
      onMessage: { addListener: (listener) => listeners.push(listener) }
    },
    storage: {
      local: { get: storageGet, set: async () => {} },
      onChanged: { addListener() {} }
    }
  };
  win.fetch = async () => {
    if (cssFails) throw new win.TypeError("Failed to fetch");
    return { text: async () => ".resume-pro { display: none; }" };
  };
  // jsdom has no constructable stylesheets.
  win.CSSStyleSheet = class { replaceSync(text) { this.text = text; } };
  setup?.(win);
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const context = dom.getInternalVMContext();
    for (let run = 0; run < runs; run += 1) {
      for (const file of scripts) {
        try {
          new vm.Script(SOURCES[file], { filename: ORIGIN + file }).runInContext(context);
        } catch {
          thrown.push(file);
        }
      }
    }
    await wait(30);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return {
    win,
    reports,
    rejections,
    thrown,
    listeners,
    hosts: () => win.document.querySelectorAll(`#${SIDEBAR_ID}`).length,
    missing: () => USED_GLOBALS.filter((name) => !win[name]),
    status: () => new Promise((resolve) => listeners[0]({ type: "RESUME_PANEL_STATUS" }, { id: EXTENSION_ID }, resolve))
  };
}

function assertStarted(page) {
  assert.deepEqual(page.thrown, [], "no content script throws at the top level");
  assert.deepEqual(page.missing(), [], "every helper global content.js reads is defined");
  assert.deepEqual(page.rejections, [], "no unhandled rejection");
  assert.equal(page.hosts(), 1);
}

test("an ordinary form page starts up and shows as connected", async () => {
  const page = await openPage();
  assertStarted(page);
  assert.equal((await page.status()).ready, true);
  assert.deepEqual(page.reports, []);
});

for (const [name, options] of [
  ["an element with id=module", { html: FORM_PAGE.replace("<body>", '<body><div id="module"></div>') }],
  ["a same-origin iframe named module", { html: FORM_PAGE.replace("</form>", '</form><iframe name="module"></iframe>') }],
  ["a cross-origin iframe named module", { setup: (win) => {
    Object.defineProperty(win, "module", { value: crossOriginFrame(win), configurable: true, writable: true });
  } }]
]) {
  test(`#275: ${name} does not keep any helper global from being defined`, async () => {
    const page = await openPage(options);
    assertStarted(page);
    assert.equal((await page.status()).ready, true);
    assert.deepEqual(page.reports, []);
  });
}

test("#275: the scripts with a CommonJS export still export their api under Node", () => {
  const exporting = SCRIPTS.filter((file) => SOURCES[file].includes("module.exports ="));
  assert.equal(exporting.length, 12);
  for (const file of exporting) {
    assert.ok(Object.keys(require(path.join(root, file))).length > 0, `${file} exports its api`);
  }
  assert.equal(typeof require("../sidebar-state.js").normalize, "function");
});

for (const [name, contentType, html] of [
  ["an RSS feed", "application/rss+xml", '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>'],
  ["an SVG image", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>'],
  ["XHTML served as XML", "text/xml",
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><form><input name="a"/></form></body></html>']
]) {
  test(`#296: ${name} gets no controller and sends no report`, async () => {
    const page = await openPage({ html, contentType });
    assert.deepEqual(page.thrown, []);
    assert.deepEqual(page.rejections, []);
    assert.equal(page.win.document.getElementById(SIDEBAR_ID), null);
    assert.equal((await page.status()).ready, false);
    assert.deepEqual(page.reports, []);
  });
}

test("#256: when content.css cannot be read the host is hidden and the page still works", async () => {
  const page = await openPage({ cssFails: true });
  assertStarted(page);
  assert.equal(page.win.document.getElementById(SIDEBAR_ID).style.display, "none");
  assert.equal((await page.status()).ready, true);
  assert.deepEqual(page.reports, []);
});

test("a storage read that never answers does not hold up startup", async () => {
  const page = await openPage({ storageGet: () => new Promise(() => {}) });
  assertStarted(page);
  assert.equal((await page.status()).ready, true);
});

test("a storage read that fails starts the controller in its default place", async () => {
  const page = await openPage({ storageGet: async () => { throw new Error("IO error"); } });
  assertStarted(page);
  const host = page.win.document.getElementById(SIDEBAR_ID);
  assert.equal(host.style.left, "");
  assert.equal(host.style.right, "24px");
  assert.equal((await page.status()).ready, true);
  assert.deepEqual(page.reports, []);
});

test("a saved place read after startup is applied to the controller", async () => {
  let answer;
  const page = await openPage({ storageGet: () => new Promise((resolve) => { answer = resolve; }) });
  assertStarted(page);
  const host = page.win.document.getElementById(SIDEBAR_ID);
  assert.equal(host.style.left, "");
  answer({ resumeProSidebarUiState: { collapsed: true, left: 100, top: 120 } });
  await wait(5);
  assert.equal(host.style.left, "100px");
  assert.equal(host.style.top, "120px");
  assert.equal(host.style.right, "auto");
});

test("running the scripts twice in one page builds one controller", async () => {
  const page = await openPage({ runs: 2 });
  assertStarted(page);
  assert.equal((await page.status()).ready, true);
});

test("a missing helper leaves the page not ready and is reported once, without its message", async () => {
  const page = await openPage({ scripts: SCRIPTS.filter((file) => file !== "field-scan.js") });
  assert.deepEqual(page.rejections, []);
  assert.equal(page.hosts(), 0);
  assert.equal((await page.status()).ready, false);
  assert.equal(page.reports.length, 1);
  const [report] = page.reports;
  assert.equal(report.kind, "exception");
  assert.equal(report.name, "TypeError");
  assert.match(report.stack, /^content\.js:\d+:\d+/);
  assert.doesNotMatch(JSON.stringify(report), /ResumePro|not loaded/);
});

test("startup checks for every helper, not only the one #275 lost", async () => {
  for (const file of SCRIPTS.slice(0, -1)) {
    const page = await openPage({ scripts: SCRIPTS.filter((name) => name !== file) });
    assert.deepEqual(page.rejections, [], file);
    assert.equal(page.hosts(), 0, file);
    assert.equal((await page.status()).ready, false, file);
    // Without feedback-core.js there is nothing to report with.
    assert.equal(page.reports.length, file === "feedback-core.js" ? 0 : 1, file);
  }
});

test("a failure after the controller is built never shows as connected", async () => {
  const page = await openPage({ setup: (win) => {
    const add = win.addEventListener.bind(win);
    win.addEventListener = (type, ...rest) => {
      if (type === "resize") throw new win.TypeError("resize listener refused");
      return add(type, ...rest);
    };
  } });
  assert.deepEqual(page.rejections, []);
  assert.equal(page.hosts(), 1);
  assert.equal((await page.status()).ready, false);
  assert.equal(page.reports.length, 1);
  assert.match(page.reports[0].stack, /^content\.js:\d+:\d+/);
});
