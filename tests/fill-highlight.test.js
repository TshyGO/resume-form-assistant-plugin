const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHighlightHelpers(options = {}) {
  const timers = [];
  const clearedTimers = [];

  class ClassList {
    constructor() {
      this.values = new Set();
    }

    add(value) {
      this.values.add(value);
    }

    remove(value) {
      this.values.delete(value);
    }

    contains(value) {
      return this.values.has(value);
    }
  }

  class HTMLElement {
    constructor() {
      this.classList = new ClassList();
      this.labels = [];
      this.parentElement = null;
      this.textContent = "";
      this.value = "";
      this.type = "text";
      this.disabled = false;
      this.id = "";
      this.name = "";
      this.previousElementSibling = null;
      this.offsetWidth = 100;
      this.scrollCalls = [];
      this.dispatchedEvents = [];
      this.rect = { top: 0, left: 0, bottom: 32, right: 240, width: 240, height: 32 };
    }

    getAttribute(name) {
      return this[name] || null;
    }

    closest() {
      return null;
    }

    getBoundingClientRect() {
      return this.rect;
    }

    scrollIntoView(options) {
      this.scrollCalls.push(options);
      if (typeof this.afterScroll === "function") {
        this.afterScroll();
      }
    }

    dispatchEvent(event) {
      this.dispatchedEvents.push(event);
      return true;
    }
  }

  class HTMLInputElement extends HTMLElement {
    constructor() {
      super();
      this.tagName = "INPUT";
    }
  }
  class HTMLLabelElement extends HTMLElement {
    constructor() {
      super();
      this.tagName = "LABEL";
    }
  }

  const styleElements = [];
  const document = {
    readyState: "loading",
    documentElement: { clientHeight: 600, clientWidth: 800 },
    head: {
      appendChild(element) {
        styleElements.push(element);
      }
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("input:not")) {
        return options.formElements || [];
      }
      return [];
    },
    createElement(tagName) {
      return { tagName: tagName.toUpperCase(), id: "", textContent: "" };
    },
    getElementById(id) {
      return styleElements.find((element) => element.id === id) || null;
    }
  };

  const window = {
    innerHeight: 600,
    innerWidth: 800,
    getComputedStyle() {
      return { display: "block", visibility: "visible" };
    },
    setTimeout(callback, delay) {
      const id = timers.length + 1;
      timers.push({ id, callback, delay, cleared: false });
      return id;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
      const timer = timers.find((entry) => entry.id === id);
      if (timer) timer.cleared = true;
    }
  };
  window.top = window;

  const context = {
    console,
    performance,
    CSS: { escape: (value) => String(value) },
    Event: class {},
    FocusEvent: class {},
    MouseEvent: class {},
    HTMLElement,
    HTMLInputElement,
    HTMLLabelElement,
    HTMLTextAreaElement: class HTMLTextAreaElement extends HTMLElement {},
    HTMLSelectElement: class HTMLSelectElement extends HTMLElement {},
    chrome: {
      runtime: {
        getManifest: () => ({ version: "0.2.1" }),
        onMessage: { addListener() {} },
        sendMessage: options.sendMessage || (async () => ({ success: true, matches: [] }))
      }
    },
    crypto: { randomUUID: () => "test-id" },
    document,
    navigator: {},
    self: { __RESUME_PRO_TEST__: true },
    window
  };

  context.globalThis = context;
  context.self.window = window;
  context.window.document = document;
  window.setInterval = (callback, delay) => {
    const id = window.setTimeout(callback, delay);
    return id;
  };
  window.clearInterval = window.clearTimeout;

  const contentJs = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInNewContext(contentJs, context);

  return {
    helpers: context.self.ResumeProHighlightTest,
    window,
    timers,
    clearedTimers,
    styleElements,
    HTMLElement,
    HTMLInputElement,
    HTMLLabelElement
  };
}

test("injects highlight styles into the page document", () => {
  const { helpers, styleElements } = loadHighlightHelpers();

  helpers.injectFieldHighlightStyles();

  assert.equal(styleElements.length, 1);
  assert.equal(styleElements[0].id, "resume-pro-field-highlight-styles");
  assert.match(styleElements[0].textContent, /\.resume-pro__field-highlight/);
});

test("off-screen fields scroll into view before the highlight animation starts", () => {
  const { helpers, timers, HTMLElement } = loadHighlightHelpers();
  const field = new HTMLElement();
  field.rect = { top: 900, left: 0, bottom: 932, right: 240 };

  helpers.highlightFilledField(field, "");

  assert.equal(field.scrollCalls.length, 1);
  assert.equal(field.scrollCalls[0].block, "center");
  assert.equal(field.scrollCalls[0].behavior, "smooth");
  assert.equal(field.classList.contains("resume-pro__field-highlight"), false);

  const firstPollTimer = timers.find((timer) => timer.delay === 100);
  assert.ok(firstPollTimer);
  firstPollTimer.callback();
  assert.equal(field.classList.contains("resume-pro__field-highlight"), false);

  field.rect = { top: 100, left: 0, bottom: 132, right: 240 };
  const secondPollTimer = timers.find((timer) => timer.id !== firstPollTimer.id && timer.delay === 100);
  assert.ok(secondPollTimer);
  secondPollTimer.callback();

  assert.equal(field.classList.contains("resume-pro__field-highlight"), true);
});

test("AI fill loop highlights fields after successful writes", async () => {
  const formElements = [];
  const { helpers, HTMLInputElement } = loadHighlightHelpers({
    formElements,
    sendMessage: async () => ({
      success: true,
      matches: [{ fieldId: "field-0", value: "测试用户" }]
    })
  });
  const input = new HTMLInputElement();
  input.name = "fullName";
  input.rect = { top: 0, left: 0, bottom: 32, right: 240, width: 240, height: 32 };
  formElements.push(input);

  helpers.setCurrentStore({
    templates: [{ id: "template-1", name: "默认模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }],
    activeTemplateId: "template-1",
    aiConfig: { apiUrl: "https://example.test", model: "test-model", apiKey: "test-key" }
  });

  await helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });

  assert.equal(input.value, "测试用户");
  assert.equal(input.classList.contains("resume-pro__field-highlight"), true);
});

test("radio fields highlight an externally associated label when available", () => {
  const { helpers, HTMLInputElement, HTMLLabelElement } = loadHighlightHelpers();
  const radio = new HTMLInputElement();
  const label = new HTMLLabelElement();
  label.textContent = "男";
  radio.labels = [label];
  radio.value = "male";

  const targets = helpers.getHighlightTargets({ kind: "radio", elements: [radio] }, "男");

  assert.equal(targets.length, 1);
  assert.equal(targets[0], label);
});

test("repeated highlights clear the previous cleanup timer", () => {
  const { helpers, timers, clearedTimers, HTMLElement } = loadHighlightHelpers();
  const field = new HTMLElement();

  helpers.highlightFilledField(field, "");
  helpers.highlightFilledField(field, "");

  assert.equal(field.classList.contains("resume-pro__field-highlight"), true);
  assert.equal(timers.filter((timer) => timer.delay === 2800).length, 2);
  assert.deepEqual(clearedTimers, [1]);
});

for (const outcome of ["success", "partial", "failure", "transport"]) {
  test(`AI progress and timers clean up after ${outcome}, repeated clicks are ignored`, async () => {
    let finish;
    let calls = 0;
    const formElements = [];
    const { helpers, timers, HTMLInputElement } = loadHighlightHelpers({
      formElements,
      sendMessage: () => { calls++; return new Promise((resolve, reject) => { finish = outcome === "transport" ? reject : resolve; }); }
    });
    formElements.push(new HTMLInputElement());
    helpers.setCurrentStore({
      templates: [{ id: "one", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试" }] }] }],
      activeTemplateId: "one", aiConfig: { apiKey: "key", apiUrl: "https://example.test", model: "test" }
    });
    const button = { disabled: false, textContent: "" };
    const pending = helpers.handleAiFillClick({ currentTarget: button });
    assert.equal(button.disabled, true);
    assert.match(button.textContent, /AI 匹配中.*0s/);
    await helpers.handleAiFillClick({ currentTarget: button });
    assert.equal(calls, 1);
    const timer = timers.find((item) => item.delay === 1000);
    assert.ok(timer);
    timer.callback();
    finish(outcome === "transport" ? new Error("connection closed") : {
      success: outcome !== "failure", warning: outcome === "partial" ? "AI 超时" : "",
      error: "AI 请求失败", matches: []
    });
    await pending;
    assert.equal(timer.cleared, true);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "一键 AI 填写");
  });
}

test("diagnostic summary only exposes allowlisted counts, durations and errors", () => {
  const { helpers } = loadHighlightHelpers();
  const summary = helpers.formatFillDiagnostics({
    scanMs: 100, roundTripMs: 1000, fillMs: null, totalMs: 1100,
    fieldCount: 2, filledCount: 0, outcome: "failed",
    diagnostics: { errorCode: "secret-key", apiKey: "secret-key", apiMs: 900, ruleMatches: 1, resumeFields: "private-name" }
  });
  assert.match(summary, /0.10 s/);
  assert.match(summary, /1.10 s/);
  assert.match(summary, /未执行 \/ 未取得/);
  assert.ok(!summary.includes("secret-key"));
  assert.ok(!summary.includes("private-name"));
});

test("highlight styles are not duplicated in content.css", () => {
  const contentCss = fs.readFileSync(path.join(__dirname, "..", "content.css"), "utf8");

  assert.doesNotMatch(contentCss, /\.resume-pro__field-highlight\b/);
  assert.doesNotMatch(contentCss, /@keyframes\s+resume-pro-field-highlight\b/);
});
