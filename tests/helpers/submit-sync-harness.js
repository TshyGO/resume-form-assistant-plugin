// #173 提交前同步用的最小 DOM 环境：有真实的焦点语义（blur 只对当前焦点元素生效）、
// 文档级捕获监听、以及会记录 click / submit / requestSubmit 调用的按钮和表单。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class DomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.inputType = init.inputType || "";
    this.data = init.data;
  }
}
class DomFocusEvent extends DomEvent {}
class DomInputEvent extends DomEvent {}

function createSubmitHarness() {
  const counters = { click: 0, submit: 0, requestSubmit: 0, preventDefault: 0, stopPropagation: 0 };
  const documentListeners = { capture: new Map(), bubble: new Map() };
  const documentAddCalls = [];
  const pendingTimers = new Set();

  class HTMLElement {
    constructor(tagName = "DIV") {
      this.tagName = tagName;
      this.children = [];
      this.parentElement = null;
      this.attributes = {};
      this.listeners = new Map();
      this.events = [];
      this.hidden = false;
      this.style = {};
      this.textContent = "";
      this.id = "";
      this.className = "";
      this.isConnected = true;
      this.disabled = false;
      this.readOnly = false;
      this.focusOptions = [];
    }

    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") this.id = String(value);
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    contains(node) {
      for (let current = node; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    }

    addEventListener(type, listener) {
      const list = this.listeners.get(type) || [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    dispatchEvent(event) {
      this.events.push(event);
      const chain = [this];
      if (event.bubbles) {
        for (let parent = this.parentElement; parent; parent = parent.parentElement) chain.push(parent);
      }
      for (const node of chain) {
        for (const listener of node.listeners.get(event.type) || []) {
          listener({ ...event, target: this, currentTarget: node });
        }
      }
      return true;
    }

    focus(options) {
      this.focusOptions.push(options);
      const previous = document.activeElement;
      if (previous === this) return;
      if (previous) previous.blur();
      document.activeElement = this;
      this.dispatchEvent(new DomEvent("focus", { bubbles: false }));
      this.dispatchEvent(new DomEvent("focusin", { bubbles: true }));
    }

    blur() {
      if (document.activeElement !== this) return;
      document.activeElement = null;
      this.dispatchEvent(new DomEvent("blur", { bubbles: false }));
      this.dispatchEvent(new DomEvent("focusout", { bubbles: true }));
    }

    click() {
      counters.click += 1;
    }
  }

  class HTMLInputElement extends HTMLElement {
    constructor() {
      super("INPUT");
      this.type = "text";
      this.name = "";
      this._value = "";
    }

    get value() {
      return this._value;
    }

    set value(next) {
      this._value = String(next ?? "").replace(/[\r\n]/g, "");
    }
  }

  class HTMLTextAreaElement extends HTMLElement {
    constructor() {
      super("TEXTAREA");
      this._value = "";
    }

    get value() {
      return this._value;
    }

    set value(next) {
      this._value = String(next ?? "").replace(/\r\n?/g, "\n");
    }
  }

  class HTMLSelectElement extends HTMLElement {
    constructor() {
      super("SELECT");
      this.value = "";
    }
  }

  class HTMLFormElement extends HTMLElement {
    constructor() {
      super("FORM");
    }

    submit() {
      counters.submit += 1;
    }

    requestSubmit() {
      counters.requestSubmit += 1;
    }
  }

  const body = new HTMLElement("BODY");
  const documentElement = new HTMLElement("HTML");
  const document = {
    readyState: "loading",
    body,
    documentElement,
    activeElement: null,
    addEventListener(type, listener, options) {
      const phase = options === true || options?.capture ? "capture" : "bubble";
      documentAddCalls.push({ type, phase });
      const list = documentListeners[phase].get(type) || [];
      list.push(listener);
      documentListeners[phase].set(type, list);
    },
    getElementById(id) {
      const stack = [body];
      while (stack.length) {
        const node = stack.shift();
        if (node.id === id || node.getAttribute?.("id") === id) return node;
        stack.push(...(node.children || []));
      }
      return null;
    },
    contains() {
      return true;
    },
    createElement() {
      return new HTMLElement();
    }
  };
  const window = {
    top: null,
    setTimeout(fn, ms) {
      const handle = setTimeout(() => {
        pendingTimers.delete(handle);
        fn();
      }, ms);
      pendingTimers.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      pendingTimers.delete(handle);
      clearTimeout(handle);
    },
    addEventListener() {},
    getComputedStyle(node) {
      return { display: node.style.display || "block", visibility: node.style.visibility || "visible" };
    }
  };
  window.top = window;

  const statusElement = { textContent: "", className: "" };
  const diagnosticsPanel = { hidden: true, open: false };
  const diagnosticsText = { value: "" };
  const shadowParts = {
    "#resume-pro-status": statusElement,
    "#resume-pro-diagnostics": diagnosticsPanel,
    "#resume-pro-diagnostics-text": diagnosticsText
  };

  const context = {
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    Event: DomEvent,
    FocusEvent: DomFocusEvent,
    InputEvent: DomInputEvent,
    HTMLElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLFormElement,
    document,
    window,
    chrome: { runtime: { getManifest: () => ({ version: "0.4.1" }), onMessage: { addListener() {} } } },
    self: { __RESUME_PRO_TEST__: true }
  };
  context.globalThis = context;
  window.document = document;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "content.js"), "utf8"), context);
  const api = context.self.ResumeProHighlightTest;
  api.setShadowRoot({ querySelector: (selector) => shadowParts[selector] || null });
  api.setTextCommitWaitMs(0);

  // 模拟用户真实操作：先跑文档级捕获监听（插件），再跑目标及其祖先上的监听（网站）。
  function fire(target, type, init = {}) {
    const event = {
      type,
      bubbles: true,
      isTrusted: true,
      button: 0,
      target,
      defaultPrevented: false,
      composedPath: () => [target],
      preventDefault() {
        counters.preventDefault += 1;
        this.defaultPrevented = true;
      },
      stopPropagation() {
        counters.stopPropagation += 1;
      },
      ...init
    };
    for (const listener of documentListeners.capture.get(type) || []) listener(event);
    for (let node = target; node; node = node.parentElement) {
      for (const listener of node.listeners.get(type) || []) listener({ ...event, currentTarget: node });
    }
    return event;
  }

  const mouseClick = (target) => {
    fire(target, "pointerdown");
    fire(target, "mousedown");
    fire(target, "pointerup");
    return fire(target, "click");
  };

  return {
    ...api,
    // vm 里造出来的数组来自另一个 realm，转成本 realm 的数组才能 deepStrictEqual。
    fillSessionControls: () => [...api.fillSessionControls()],
    HTMLElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLFormElement,
    body,
    document,
    counters,
    documentAddCalls,
    pendingTimers,
    statusElement,
    diagnosticsPanel,
    diagnosticsText,
    fire,
    mouseClick
  };
}

module.exports = { createSubmitHarness };
