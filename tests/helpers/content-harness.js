// The content script in a vm with just enough DOM and chrome.* for its tested paths.
// Shared by fill-highlight.test.js and sidepanel-repeat.test.js.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 填写流程测试用的扫描替身：假 DOM 没有树结构，每个表单控件按旧规则各算一个字段（单选按 name 合并）。
// 真实的扫描、取名和跳过规则在 field-scan.test.js 里用 jsdom 测。
function fakeFieldScan() {
  const labelOf = (element) => String(element.getAttribute?.("data-label")
    || (element.labels || []).map((label) => label.textContent || "").join(" / ")
    || element.getAttribute?.("aria-label") || "").trim();
  return {
    scanPage(doc, scanOptions = {}) {
      const elements = Array.from(doc.querySelectorAll("input:not([type='hidden']), textarea, select"))
        .filter((element) => (!scanOptions.isVisible || scanOptions.isVisible(element)) && !scanOptions.exclude?.(element));
      const controls = [];
      const radios = new Map();
      elements.forEach((element, index) => {
        if (element.type === "radio") {
          const name = element.name || `__radio__${index}`;
          if (!radios.has(name)) {
            radios.set(name, []);
            controls.push({ kind: "radio", controlKind: "radio", element, elements: radios.get(name) });
          }
          radios.get(name).push(element);
          return;
        }
        controls.push({ kind: "element", controlKind: element.tagName === "SELECT" ? "select" : "text", element, elements: [element] });
      });
      [[".ant-picker", "antd"], [".el-date-editor", "element"], ["[class*='date-picker']", "generic"]].forEach(([selector, pickerType]) => {
        Array.from(doc.querySelectorAll(selector)).forEach((container) => {
          Array.from(container.querySelectorAll("input:not([type='hidden']):not([disabled])")).forEach((inner) => {
            const control = controls.find((candidate) => candidate.element === inner);
            if (control) Object.assign(control, { controlKind: "date-picker", pickerType, pickerRoot: container });
          });
        });
      });
      controls.forEach((control) => {
        const label = labelOf(control.element);
        Object.assign(control, {
          root: control.pickerRoot || control.element, item: control.element, label, labelSource: label ? "explicit" : "placeholder",
          section: "", group: "", repeatIndex: 0, offerable: Boolean(label), offerLabel: label, pickerType: control.pickerType || "", rangePart: "",
          placeholder: control.element.getAttribute?.("placeholder") || ""
        });
      });
      return { controls, skipped: { pageChrome: 0, popup: 0, merged: 0, siteSearch: 0, outsideForm: 0, noLabel: 0 }, sources: {} };
    },
    isBindingCurrent: () => true,
    hasDisplayedValue: () => false,
    labelForElement: labelOf
  };
}

function loadHighlightHelpers(options = {}) {
  let desktopData = null;
  const timers = [];
  const clearedTimers = [];
  const clipboardWrites = [];
  const desktopMessages = [];
  const documentListeners = {};
  const storageWrites = [];
  let panelMessageListener = null;

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

    toggle(value, force) {
      const shouldAdd = force === undefined ? !this.values.has(value) : Boolean(force);
      if (shouldAdd) {
        this.values.add(value);
      } else {
        this.values.delete(value);
      }
      return shouldAdd;
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
      this.readOnly = false;
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.isConnected = true;
      this.id = "";
      this.name = "";
      this.dataset = {};
      this.attributes = {};
      this.previousElementSibling = null;
      this.offsetWidth = 100;
      this.scrollCalls = [];
      this.dispatchedEvents = [];
      this.listeners = {};
      this.rect = { top: 0, left: 0, bottom: 32, right: 240, width: 240, height: 32 };
    }

    getAttribute(name) {
      return this.attributes[name] ?? this[name] ?? null;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
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

    addEventListener(type, listener) { (this.listeners[type] ||= new Set()).add(listener); }
    removeEventListener(type, listener) { this.listeners[type]?.delete(listener); }
    dispatchEvent(event) {
      for (const listener of this.listeners[event.type] || []) listener(event);
      this.dispatchedEvents.push(event);
      return true;
    }

    focus() {
      document.activeElement = this;
    }

    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
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
    activeElement: null,
    documentElement: { clientHeight: 600, clientWidth: 800 },
    head: {
      appendChild(element) {
        styleElements.push(element);
      }
    },
    addEventListener(type, listener) {
      (documentListeners[type] ||= []).push(listener);
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("input:not")) {
        return options.formElements || [];
      }
      // 诊断漏斗数页面上全部输入框（含隐藏的）；不传就和可填的那批一样。
      if (selector === "input, select, textarea") {
        return options.allInputs || options.formElements || [];
      }
      return [];
    },
    createElement(tagName) {
      return { tagName: tagName.toUpperCase(), id: "", textContent: "" };
    },
    getElementById(id) {
      return styleElements.find((element) => element.id === id) || null;
    },
    contains(element) {
      return element?.isConnected !== false;
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
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLSelectElement extends HTMLElement {}

  const context = {
    console,
    setTimeout,
    // showStatus 直接调用全局 clearTimeout：假定时器（数字 id）走 window 的记录，测试才看得到哪些被清掉了；
    // 上面全局 setTimeout 仍是 Node 真实的，它返回的对象要交给真实的 clearTimeout。
    clearTimeout: id => (typeof id === "number" ? window.clearTimeout(id) : clearTimeout(id)),
    performance: options.performance || performance,
    CSS: { escape: (value) => String(value) },
    Event: class {},
    FocusEvent: class {},
    MouseEvent: class {},
    HTMLElement,
    HTMLInputElement,
    HTMLLabelElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    chrome: {
      ...(options.storageSpy ? {
        storage: Object.fromEntries(["local", "session", "sync"].map((area) => [area, {
          get: async () => ({}),
          set: async (value) => { storageWrites.push({ area, value }); },
          remove: async () => {}
        }]))
      } : {}),
      runtime: {
        id: 'test-extension',
        getURL: path => 'chrome-extension://test-extension/' + path,
        getManifest: () => ({ version: "0.2.1" }),
        onMessage: { addListener(listener) { panelMessageListener = listener; } },
        sendMessage: async message => message.type === 'DESKTOP_RESUME_READ'
          ? { status: 'ok', data: desktopData }
          : (desktopMessages.push(message), message.type === 'DESKTOP_OPEN_VIEW'
            ? { status: 'ok' } : options.sendMessage ? options.sendMessage(message) : { success: true, matches: [] })
      }
    },
    crypto: { randomUUID: options.randomUUID || (() => "test-id") },
    location: options.location || { href: "https://jobs.example.test/apply", pathname: "/apply" },
    document,
    navigator: { clipboard: { writeText: async (value) => { clipboardWrites.push(value); } } },
    self: { __RESUME_PRO_TEST__: true, ResumeProFormAgent: options.formAgent, ResumeProAIHelpers: options.aiHelpers,
      ResumeProFillProbe: options.fillProbe, ResumeProFeedback: options.feedback,
      ResumeProFieldScan: options.fieldScan || fakeFieldScan(),
      ResumeProCustomControls: options.customControls,
      ResumeProResumeData: require('../../resume-data.js'), ResumeProProfile: require('../../profile-fields.js'),
      ResumeProAIClient: { send: options.sendMessage || (async () => ({ success: true, matches: [] })),
        cancel: requestId => options.sendMessage({ type: 'CANCEL_AI_FILL', requestId }) } },
    window
  };

  context.globalThis = context;
  context.self.window = window;
  context.window.document = document;
  window.confirm = options.confirm || (() => false);
  window.setInterval = (callback, delay) => {
    const id = window.setTimeout(callback, delay);
    return id;
  };
  window.clearInterval = window.clearTimeout;

  const contentJs = fs.readFileSync(path.join(__dirname, "..", "..", "content.js"), "utf8");
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "control-adapters.js"), "utf8"), context);
  vm.runInNewContext(contentJs, context);
  context.self.ResumeProHighlightTest.setTextCommitWaitMs(0);
  const helpers = context.self.ResumeProHighlightTest;
  const setCurrentStore = helpers.setCurrentStore;
  helpers.setCurrentStore = store => {
    const activeTemplate = store.activeTemplate || store.templates?.find(template => template.id === store.activeTemplateId) || store.templates?.[0] || null;
    desktopData = {
      templates: (store.templates || []).map(template => ({ id: template.id, name: template.name || '模板', fieldCount: template.groups?.flatMap(group => group.fields).length || 0 })),
      activeTemplate, profile: store.profile || { values: {}, family: [], custom: [] }, profileRevision: store.profileRevision || 0
    };
    setCurrentStore({ ...store, activeTemplate });
  };

  return {
    helpers,
    window,
    timers,
    clearedTimers,
    clipboardWrites,
    desktopMessages,
    styleElements,
    documentListeners,
    storageWrites,
    HTMLElement,
    HTMLInputElement,
    HTMLLabelElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    document,
    // Delivers a message the way chrome.runtime does, and resolves with its response
    // after the same JSON round trip a real message goes through.
    sendPanelMessage(message, sender = { id: "test-extension" }) {
      return new Promise((resolve) => {
        const respond = (response) => resolve(response === undefined ? undefined : JSON.parse(JSON.stringify(response)));
        const keepOpen = panelMessageListener(JSON.parse(JSON.stringify(message)), sender, respond);
        if (!keepOpen) setImmediate(() => resolve(undefined));
      });
    },
    fireDocumentEvent(type, event) {
      (documentListeners[type] || []).forEach((listener) => listener(event));
    }
  };
}

module.exports = { loadHighlightHelpers, fakeFieldScan };
