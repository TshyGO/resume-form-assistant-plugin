const test = require("node:test");
const assert = require("node:assert/strict");
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

function createHarness({ inputEvent = true } = {}) {
  class HTMLElement {
    constructor() {
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

    addEventListener(type, listener) {
      const list = this.listeners.get(type) || [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    dispatchEvent(event) {
      this.events.push(event);
      const chain = [this];
      if (event.bubbles) {
        let parent = this.parentElement;
        while (parent) {
          chain.push(parent);
          parent = parent.parentElement;
        }
      }
      for (const node of chain) {
        for (const listener of node.listeners.get(event.type) || []) {
          listener({ ...event, target: this, currentTarget: node });
        }
      }
      return true;
    }

    focus() {
      this.dispatchEvent(new DomEvent("focus", { bubbles: false }));
      this.dispatchEvent(new DomEvent("focusin", { bubbles: true }));
    }

    blur() {
      this.dispatchEvent(new DomEvent("blur", { bubbles: false }));
      this.dispatchEvent(new DomEvent("focusout", { bubbles: true }));
    }
  }

  class HTMLInputElement extends HTMLElement {
    constructor() {
      super();
      this.type = "text";
      this.name = "";
      this._value = "";
    }

    get value() {
      return this._value;
    }

    set value(next) {
      const value = String(next ?? "");
      if (this.type === "email" || this.type === "url") {
        this._value = value.replace(/[\r\n]/g, "").replace(/^[\t\f ]+|[\t\f ]+$/g, "");
      } else if (this.type === "number" && value && !Number.isFinite(Number(value))) {
        this._value = "";
      } else {
        this._value = value.replace(/[\r\n]/g, "");
      }
    }
  }

  class HTMLTextAreaElement extends HTMLElement {
    constructor() {
      super();
      this._value = "";
    }

    get value() {
      return this._value;
    }

    set value(next) {
      this._value = String(next ?? "").replace(/\r\n?/g, "\n");
    }
  }

  class HTMLSelectElement extends HTMLElement {}

  const body = new HTMLElement();
  const document = {
    readyState: "loading",
    body,
    documentElement: new HTMLElement(),
    activeElement: null,
    addEventListener() {},
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
    setTimeout,
    clearTimeout,
    getComputedStyle(node) {
      return { display: node.style.display || "block", visibility: node.style.visibility || "visible" };
    }
  };
  window.top = window;
  const context = {
    console,
    setTimeout,
    clearTimeout,
    Event: DomEvent,
    FocusEvent: DomFocusEvent,
    HTMLElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    document,
    window,
    chrome: { runtime: { getManifest: () => ({ version: "0.4.0" }), onMessage: { addListener() {} } } },
    self: { __RESUME_PRO_TEST__: true }
  };
  if (inputEvent) context.InputEvent = DomInputEvent;
  context.globalThis = context;
  context.window.document = document;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context);
  return {
    setElementValue: context.self.ResumeProHighlightTest.setElementValue,
    reason: context.self.ResumeProHighlightTest.textFillFailureReason,
    HTMLElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    body
  };
}

function fieldBox(HTMLElement, HTMLInputElement, body, { errorClass = "el-form-item__error", errorText = "请填写移动电话" } = {}) {
  const item = new HTMLElement();
  item.className = "form-item";
  const input = new HTMLInputElement();
  const error = new HTMLElement();
  error.className = errorClass;
  error.textContent = errorText;
  error.id = "phone-error";
  item.appendChild(input);
  item.appendChild(error);
  body.appendChild(item);
  return { item, input, error };
}

test("聚焦后再写值，失焦时清除必填提示", async () => {
  const { setElementValue, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  input.type = "tel";
  let valueAtFocus = null;
  input.addEventListener("focus", () => {
    valueAtFocus = input.value;
    if (!input.value) input.setAttribute("aria-invalid", "true");
  });
  input.addEventListener("blur", () => {
    input.setAttribute("aria-invalid", input.value ? "false" : "true");
  });

  assert.equal(await setElementValue(input, "13800138000"), true);
  assert.equal(valueAtFocus, "");
  assert.equal(input.getAttribute("aria-invalid"), "false");
});

test("受控表单聚焦后重渲染不会清掉尚未发 input 的值", async () => {
  const { setElementValue, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  let valueAtInput = null;
  input.addEventListener("focus", () => {
    setTimeout(() => {
      // 框架在 focus 事件后按旧 state 重绘受控输入框。
      input.value = "";
    }, 0);
  });
  input.addEventListener("input", () => {
    valueAtInput = input.value;
  });

  assert.equal(await setElementValue(input, "测试用户"), true);
  assert.equal(valueAtInput, "测试用户");
  assert.equal(input.value, "测试用户");
});

test("第一次失焦还留着红字时，再补一次点入再点出", async () => {
  const { setElementValue, HTMLElement, HTMLInputElement, body } = createHarness();
  const { input, error } = fieldBox(HTMLElement, HTMLInputElement, body);
  input.type = "tel";
  input.setAttribute("aria-invalid", "true");
  let blurs = 0;
  input.addEventListener("blur", () => {
    blurs += 1;
    if (blurs >= 2) {
      input.setAttribute("aria-invalid", "false");
      error.hidden = true;
    }
  });

  assert.equal(await setElementValue(input, "13800138000"), true);
  assert.equal(blurs >= 2, true);
  assert.equal(error.hidden, true);
});

test("blur 校验会在自动填写后清掉必填提示", async () => {
  const { setElementValue, reason, HTMLElement, HTMLInputElement, body } = createHarness();
  const { input, error } = fieldBox(HTMLElement, HTMLInputElement, body);
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", "phone-error");
  input.addEventListener("blur", () => {
    if (input.value) {
      input.setAttribute("aria-invalid", "false");
      error.hidden = true;
    }
  });

  assert.equal(await setElementValue(input, "13800138000"), true);
  assert.equal(input.value, "13800138000");
  assert.equal(error.hidden, true);
  assert.equal(input.getAttribute("aria-invalid"), "false");
  assert.equal(reason(input), "");
  assert.deepEqual(input.events.map((event) => event.type), ["focus", "focusin", "input", "change", "blur", "focusout"]);
  assert.equal(input.events.some((event) => event.type === "keydown"), false);
  assert.equal(input.events.find((event) => event.type === "input").inputType, "insertText");
});

test("父容器的 focusout 能收到 blur", async () => {
  const { setElementValue, HTMLElement, HTMLInputElement, body } = createHarness();
  const item = new HTMLElement();
  item.className = "form-item";
  const input = new HTMLInputElement();
  item.appendChild(input);
  body.appendChild(item);
  let focusoutValue = "";
  item.addEventListener("focusout", () => {
    focusoutValue = input.value;
    item.className = "form-item";
  });
  item.className = "form-item has-error";

  assert.equal(await setElementValue(input, "测试用户"), true);
  assert.equal(focusoutValue, "测试用户");
});

test("input 与 change 仍能看到写入后的值", async () => {
  const { setElementValue, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  input.type = "email";
  let onInput = "";
  let onChange = "";
  input.addEventListener("input", (event) => {
    onInput = `${event.inputType}:${input.value}`;
  });
  input.addEventListener("change", () => {
    onChange = input.value;
  });

  assert.equal(await setElementValue(input, "a@b.c"), true);
  assert.equal(onInput, "insertText:a@b.c");
  assert.equal(onChange, "a@b.c");
});

test("延迟回滚不能记成成功", async () => {
  const { setElementValue, reason, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  input.type = "text";
  input.addEventListener("blur", () => {
    setTimeout(() => {
      input.value = "";
    }, 50);
  });

  assert.equal(await setElementValue(input, "保留不住"), false);
  assert.equal(input.value, "");
  assert.equal(reason(input), "value_reverted");
});

test("blur 后仍是 aria-invalid 时不能记成成功，其他字段的错误不算在这个框上", async () => {
  const { setElementValue, reason, HTMLElement, HTMLInputElement, body } = createHarness();
  const phone = fieldBox(HTMLElement, HTMLInputElement, body);
  const email = fieldBox(HTMLElement, HTMLInputElement, body, { errorText: "请填写邮箱" });
  email.input.type = "email";
  phone.input.type = "tel";
  phone.input.setAttribute("aria-invalid", "true");
  phone.input.addEventListener("blur", () => {
    phone.error.hidden = true;
  });

  assert.equal(await setElementValue(phone.input, "13800138000"), false);
  assert.equal(phone.input.value, "13800138000");
  assert.equal(reason(phone.input), "validation_not_cleared");

  email.input.addEventListener("blur", () => {
    email.input.setAttribute("aria-invalid", "false");
    email.error.hidden = true;
  });
  email.input.setAttribute("aria-invalid", "true");
  assert.equal(await setElementValue(email.input, "a@b.c"), true);
  assert.equal(email.error.hidden, true);
  assert.equal(phone.error.hidden, true);
});

test("text、tel、email、textarea 都走同一套焦点提交", async () => {
  const { setElementValue, HTMLInputElement, HTMLTextAreaElement } = createHarness();
  const tel = new HTMLInputElement();
  tel.type = "tel";
  const email = new HTMLInputElement();
  email.type = "email";
  const text = new HTMLInputElement();
  const area = new HTMLTextAreaElement();
  for (const [control, value] of [[tel, "13800138000"], [email, "a@b.c"], [text, "南京"], [area, "项目经历"]]) {
    let blurred = false;
    control.addEventListener("blur", () => {
      blurred = true;
    });
    assert.equal(await setElementValue(control, value), true);
    assert.equal(control.value, value);
    assert.equal(blurred, true);
    assert.equal(control.events.filter((event) => event.type === "input").length, 1);
  }
});

test("没有 InputEvent 时仍能填写，并且普通文本失败后不会逐字重试", async () => {
  const harness = createHarness({ inputEvent: false });
  const input = new harness.HTMLInputElement();
  input.addEventListener("input", () => {
    input.value = "";
  });

  assert.equal(await harness.setElementValue(input, "南京大学"), false);
  assert.equal(harness.reason(input), "value_not_committed");
  assert.equal(input.events.filter((event) => event.type === "input").length, 1);
  assert.equal(input.events.find((event) => event.type === "input").inputType, "");
});

test("电话框拒绝一次性写入时才逐字再试一次", async () => {
  const { setElementValue, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  input.type = "tel";
  input.addEventListener("input", (event) => {
    if (String(event.data || "").length > 1) input.value = "";
  });

  assert.equal(await setElementValue(input, "138"), true);
  assert.equal(input.value, "138");
  const chunks = input.events.filter((event) => event.type === "input").map((event) => event.data);
  assert.deepEqual(chunks, ["138", "", "1", "3", "8"]);
});

test("逐字重试失败后恢复字段原值", async () => {
  const { setElementValue, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  input.type = "tel";
  input.value = "原号码";
  input.addEventListener("input", (event) => {
    if (event.data !== "原号码") input.value = "";
  });

  assert.equal(await setElementValue(input, "138"), false);
  assert.equal(input.value, "原号码");
});

test("逐字已写入但页面仍报错时保留内容供手动核对", async () => {
  const { setElementValue, reason, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  input.type = "tel";
  input.setAttribute("aria-invalid", "true");
  input.addEventListener("input", (event) => {
    if (String(event.data || "").length > 1) input.value = "";
  });

  assert.equal(await setElementValue(input, "138"), false);
  assert.equal(input.value, "138");
  assert.equal(reason(input), "validation_not_cleared");
});

test("聚焦后被页面替换的输入节点不能算填写成功", async () => {
  const { setElementValue, reason, HTMLInputElement } = createHarness();
  const input = new HTMLInputElement();
  input.addEventListener("focus", () => {
    setTimeout(() => { input.isConnected = false; }, 0);
  });

  assert.equal(await setElementValue(input, "测试用户"), false);
  assert.equal(reason(input), "element_disconnected");
});

test("只剩框架错误类、没有错误文案时记成状态未同步", async () => {
  const { setElementValue, reason, HTMLElement, HTMLInputElement, body } = createHarness();
  const item = new HTMLElement();
  item.className = "ant-form-item ant-form-item-has-error";
  const input = new HTMLInputElement();
  item.appendChild(input);
  body.appendChild(item);

  assert.equal(await setElementValue(input, "13800138000"), false);
  assert.equal(reason(input), "framework_state_unsynced");
});

test("CSS 隐藏的错误文案及其祖先不使已填写字段失败", async () => {
  const { setElementValue, reason, HTMLElement, HTMLInputElement, body } = createHarness();
  const { input, error } = fieldBox(HTMLElement, HTMLInputElement, body);
  error.style.display = "none";
  assert.equal(await setElementValue(input, "测试用户"), true);
  assert.equal(reason(input), "");

  error.style.display = "block";
  const wrapper = new HTMLElement();
  wrapper.style.visibility = "hidden";
  const item = error.parentElement;
  item.children = item.children.filter((node) => node !== error);
  item.appendChild(wrapper);
  wrapper.appendChild(error);
  assert.equal(await setElementValue(input, "测试用户"), true);
  assert.equal(reason(input), "");
});

test("单输入框页面不把其他区域的错误归给当前字段", async () => {
  const { setElementValue, HTMLElement, HTMLInputElement, body } = createHarness();
  const form = new HTMLElement();
  const field = new HTMLElement();
  const input = new HTMLInputElement();
  const unrelated = new HTMLElement();
  unrelated.className = "error";
  unrelated.textContent = "其他内容仍有错误";
  field.appendChild(input);
  form.appendChild(field);
  form.appendChild(unrelated);
  body.appendChild(form);

  assert.equal(await setElementValue(input, "测试用户"), true);
});

test("按浏览器规范化后的文本值判断提交，非法数字仍失败", async () => {
  const { setElementValue, reason, HTMLInputElement, HTMLTextAreaElement } = createHarness();
  const text = new HTMLInputElement();
  const email = new HTMLInputElement();
  email.type = "email";
  const area = new HTMLTextAreaElement();
  const number = new HTMLInputElement();
  number.type = "number";

  assert.equal(await setElementValue(text, "甲\n乙"), true);
  assert.equal(text.value, "甲乙");
  assert.equal(await setElementValue(email, "  a@b.c \n"), true);
  assert.equal(email.value, "a@b.c");
  assert.equal(await setElementValue(area, "甲\r\n乙"), true);
  assert.equal(area.value, "甲\n乙");
  assert.equal(await setElementValue(number, "not a number"), false);
  assert.equal(reason(number), "value_not_committed");
});

test("week、range、color 输入仍可沿用原有的直接写值路径", async () => {
  const { setElementValue, HTMLInputElement } = createHarness();
  for (const [type, value] of [["week", "2026-W39"], ["range", "42"], ["color", "#123456"]]) {
    const input = new HTMLInputElement();
    input.type = type;
    assert.equal(await setElementValue(input, value), true);
    assert.equal(input.value, value);
    assert.deepEqual(input.events.map((event) => event.type), ["input", "change"]);
  }
});
