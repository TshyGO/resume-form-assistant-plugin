const test = require("node:test");
const assert = require("node:assert/strict");
const { createSubmitHarness } = require("./helpers/submit-sync-harness");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (element, type) => element.events.filter((event) => event.type === type).length;
const focusTypes = new Set(["focus", "focusin", "blur", "focusout"]);

function makeButton(h, { tag = "BUTTON", type, text = "", role, disabled = false } = {}) {
  const button = tag === "INPUT" ? new h.HTMLInputElement() : new h.HTMLElement(tag);
  if (type) button.setAttribute("type", type);
  if (role) button.setAttribute("role", role);
  if (tag === "INPUT") button.value = text; else button.textContent = text;
  button.disabled = disabled;
  return button;
}

// 一个「点提交才整表校验」的网站：内部表单模型只在页面拿到焦点之后的 blur 里才更新。
// 插件填写时页面还没接管焦点（pageFocused=false），所以模型是空的，DOM 里却已经显示了值。
function buildSite(h, { syncOnBlur = true } = {}) {
  const site = { model: {}, pageFocused: false, log: [], errors: {} };
  const form = new h.HTMLFormElement();
  const name = new h.HTMLInputElement();
  const phone = new h.HTMLInputElement();
  phone.type = "tel";
  const email = new h.HTMLInputElement();
  email.type = "email";
  const bio = new h.HTMLTextAreaElement();
  const submit = makeButton(h, { type: "submit", text: "预览并提交" });
  const inputs = { name, phone, email, bio };
  for (const [key, control] of Object.entries(inputs)) {
    form.appendChild(control);
    control.addEventListener("blur", () => {
      site.log.push(`blur:${key}`);
      if (syncOnBlur && site.pageFocused) site.model[key] = control.value;
    });
  }
  form.appendChild(submit);
  h.body.appendChild(form);
  submit.addEventListener("pointerdown", () => site.log.push("site-pointerdown"));
  submit.addEventListener("click", () => {
    site.log.push("site-click");
    for (const [key, control] of Object.entries(inputs)) {
      const bad = !site.model[key];
      site.errors[key] = bad;
      control.setAttribute("aria-invalid", bad ? "true" : "false");
    }
  });
  return { site, form, submit, ...inputs };
}

async function fillSession(h, pairs) {
  const session = h.beginFillSession();
  for (const [control, value] of pairs) {
    assert.equal(await h.setElementValue(control, value), true);
    assert.equal(h.recordFilledTextControl(session, control), true);
  }
  return session;
}

test("text、tel、email、textarea 填写成功后被当前会话记录", async () => {
  const h = createSubmitHarness();
  const { name, phone, email, bio } = buildSite(h);
  await fillSession(h, [[name, "张三"], [phone, "13800138000"], [email, "a@b.c"], [bio, "项目经历"]]);
  assert.deepEqual(h.fillSessionControls(), [name, phone, email, bio]);
});

test("select、password、file、验证码、日期、单选、复选不会被记录", () => {
  const h = createSubmitHarness();
  const session = h.beginFillSession();
  const make = (type, extra = {}) => {
    const input = new h.HTMLInputElement();
    input.type = type;
    Object.assign(input, extra);
    return input;
  };
  const controls = [
    new h.HTMLSelectElement(),
    make("password"),
    make("file"),
    make("text", { name: "captcha" }),
    make("text", { id: "sms-verify-code" }),
    make("date"),
    make("radio"),
    make("checkbox"),
    make("number"),
    make("hidden"),
    new h.HTMLElement()
  ];
  const otp = make("text");
  otp.setAttribute("placeholder", "请输入验证码");
  controls.push(otp);
  const oneTime = make("text");
  oneTime.setAttribute("autocomplete", "one-time-code");
  controls.push(oneTime);
  const captchaArea = new h.HTMLTextAreaElement();
  captchaArea.name = "captcha";
  controls.push(captchaArea);
  const labelledArea = new h.HTMLTextAreaElement();
  const captchaLabel = new h.HTMLElement("LABEL");
  captchaLabel.textContent = "短信验证码";
  labelledArea.labels = [captchaLabel];
  controls.push(labelledArea);
  const labelledInput = make("text");
  const ariaLabel = new h.HTMLElement("SPAN");
  ariaLabel.id = "verify-label";
  ariaLabel.textContent = "图形验证码";
  h.body.appendChild(ariaLabel);
  labelledInput.setAttribute("aria-labelledby", "verify-label");
  controls.push(labelledInput);
  const disguisedPassword = make("text");
  const passwordLabel = new h.HTMLElement("LABEL");
  passwordLabel.textContent = "登录密码";
  disguisedPassword.labels = [passwordLabel];
  controls.push(disguisedPassword);
  for (const control of controls) {
    assert.equal(h.recordFilledTextControl(session, control), false);
  }
  const ordinaryArea = new h.HTMLTextAreaElement();
  ordinaryArea.name = "notepad";
  assert.equal(h.recordFilledTextControl(session, ordinaryArea), true, "ordinary textarea still participates");
  const ordinaryInput = make("text", { name: "desktopExperience" });
  assert.equal(h.recordFilledTextControl(session, ordinaryInput), true, "otp must be a token, not an arbitrary substring");
  assert.deepEqual(h.fillSessionControls(), [ordinaryArea, ordinaryInput]);
});

test("用户第一次点「预览并提交」：同步发生在 pointerdown，早于网站的点击处理", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"]]);
  s.site.pageFocused = true;
  s.site.log.length = 0;

  h.mouseClick(s.submit);

  assert.deepEqual(s.site.log, ["blur:name", "blur:phone", "site-pointerdown", "site-click"]);
});

test("网站第一次整表校验就能读到插件填的值，不再标红", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"], [s.email, "a@b.c"], [s.bio, "简介"]]);
  s.site.pageFocused = true;
  assert.deepEqual(s.site.model, {});

  h.mouseClick(s.submit);

  assert.deepEqual(s.site.model, { name: "张三", phone: "13800138000", email: "a@b.c", bio: "简介" });
  assert.deepEqual(s.site.errors, { name: false, phone: false, email: false, bio: false });
});

test("对照：不做提交前同步，同一个网站会把这些字段标红", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  s.site.pageFocused = true;
  h.endFillSession();

  h.mouseClick(s.submit);

  assert.equal(s.name.value, "张三");
  assert.equal(s.site.errors.name, true);
});

test("用户改过的值：点下一步只同步新值，不会恢复旧值", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.phone, "13800138000"]]);
  s.site.pageFocused = true;
  s.phone.value = "13900139000";
  const before = s.phone.events.length;

  h.mouseClick(s.submit);

  assert.equal(s.phone.value, "13900139000");
  assert.equal(s.site.model.phone, "13900139000");
  const added = s.phone.events.slice(before).map((event) => event.type);
  assert.equal(added.every((type) => focusTypes.has(type)), true);
});

test("用户清空字段：插件不补内容，网站照常标红", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"], [s.email, "a@b.c"]]);
  s.site.pageFocused = true;
  s.email.value = "";
  const before = s.email.events.length;

  h.mouseClick(s.submit);

  assert.equal(s.email.value, "");
  assert.equal(s.email.events.length, before);
  assert.equal(s.site.errors.email, true);
  assert.equal(s.site.errors.name, false);
});

test("已断开或被网页替换的节点被跳过，不报错也不操作", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"]]);
  s.name.isConnected = false;
  const before = s.name.events.length;

  assert.doesNotThrow(() => h.mouseClick(s.submit));

  assert.equal(s.name.events.length, before);
  assert.equal(count(s.phone, "blur"), 2);
  assert.deepEqual(h.fillSessionControls(), [s.phone]);
});

test("disabled 与 readonly 字段被跳过", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"], [s.email, "a@b.c"]]);
  s.name.disabled = true;
  s.phone.readOnly = true;

  h.mouseClick(s.submit);

  assert.equal(count(s.name, "blur"), 1);
  assert.equal(count(s.phone, "blur"), 1);
  assert.equal(count(s.email, "blur"), 2);
});

test("点普通按钮、关闭、删除按钮不触发同步", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  const baseline = count(s.name, "blur");
  for (const button of [
    makeButton(h, { type: "button", text: "更多" }),
    makeButton(h, { type: "button", text: "关闭" }),
    makeButton(h, { type: "button", text: "删除" }),
    makeButton(h, { type: "submit", text: "取消" }),
    makeButton(h, { role: "button", tag: "DIV", text: "上一步" })
  ]) {
    s.form.appendChild(button);
    h.mouseClick(button);
  }
  h.mouseClick(s.name);
  h.fire(h.body, "keydown", { key: "Enter" });

  assert.equal(count(s.name, "blur"), baseline);
});

test("提交类按钮识别规则", () => {
  const h = createSubmitHarness();
  const inForm = (button) => {
    const form = new h.HTMLFormElement();
    form.appendChild(button);
    return button;
  };
  const yes = [
    makeButton(h, { type: "submit" }),
    makeButton(h, { tag: "INPUT", type: "submit", text: "确定" }),
    makeButton(h, { type: "button", text: "预览" }),
    makeButton(h, { type: "button", text: "下一步" }),
    makeButton(h, { type: "button", text: "提交" }),
    makeButton(h, { type: "button", text: "保存并继续" }),
    makeButton(h, { type: "button", text: "预览并提交" }),
    makeButton(h, { type: "button", text: "Submit application" }),
    makeButton(h, { type: "button", text: "Next" }),
    makeButton(h, { tag: "INPUT", type: "button", text: "提交申请" }),
    makeButton(h, { tag: "A", text: "下一步" }),
    makeButton(h, { tag: "DIV", role: "button", text: "提交" }),
    inForm(makeButton(h, { text: "Save" }))
  ];
  const no = [
    makeButton(h, { type: "button", text: "更多" }),
    makeButton(h, { type: "button", text: "关闭" }),
    makeButton(h, { type: "button", text: "删除" }),
    makeButton(h, { type: "button", text: "取消提交" }),
    makeButton(h, { type: "button", text: "上一步" }),
    makeButton(h, { type: "button", text: "添加一条经历" }),
    makeButton(h, { type: "submit", text: "取消" }),
    makeButton(h, { type: "submit", text: "提交", disabled: true }),
    makeButton(h, { text: "Save" }),
    makeButton(h, { tag: "DIV", text: "提交" }),
    makeButton(h, { tag: "SPAN", role: "tab", text: "下一步" }),
    makeButton(h, { type: "button", text: "这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的说明文字，里面提到了提交和预览" })
  ];
  const ariaDisabled = makeButton(h, { type: "submit", text: "提交" });
  ariaDisabled.setAttribute("aria-disabled", "true");
  no.push(ariaDisabled);
  yes.forEach((button, index) => assert.equal(h.isSubmitTrigger(button), true, `应识别 #${index}`));
  no.forEach((button, index) => assert.equal(h.isSubmitTrigger(button), false, `不应识别 #${index}`));
});

test("点在按钮内部的文字上，找最近的按钮判断", () => {
  const h = createSubmitHarness();
  const submit = makeButton(h, { type: "submit", text: "提交" });
  const label = new h.HTMLElement("SPAN");
  submit.appendChild(label);
  assert.equal(h.findSubmitTrigger(label), submit);

  const ordinary = makeButton(h, { type: "button", text: "更多" });
  const wrapper = makeButton(h, { tag: "DIV", role: "button", text: "提交" });
  wrapper.appendChild(ordinary);
  const inner = new h.HTMLElement("SPAN");
  ordinary.appendChild(inner);
  assert.equal(h.findSubmitTrigger(inner), null);
  assert.equal(h.findSubmitTrigger(new h.HTMLElement()), null);
});

test("Shadow DOM 的事件路径可以找到跨边界的提交按钮", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  const inner = new h.HTMLElement("SPAN");
  const shadowHost = makeButton(h, { tag: "DIV", role: "button", text: "下一步" });

  h.fire(inner, "pointerdown", { composedPath: () => [inner, shadowHost, h.body] });

  assert.equal(count(s.name, "blur"), 2);
});

test("一次鼠标操作（pointerdown + click）只同步一次；再次点击可以再同步", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  s.site.pageFocused = true;

  h.mouseClick(s.submit);
  assert.equal(count(s.name, "blur"), 2);

  h.mouseClick(s.submit);
  assert.equal(count(s.name, "blur"), 3);
});

test("键盘 Enter / 空格触发按钮时同步一次，并把焦点留在按钮上", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  s.site.pageFocused = true;
  s.submit.focus();

  h.fire(s.submit, "keydown", { key: "Enter" });
  h.fire(s.submit, "click", { detail: 0 });
  assert.equal(count(s.name, "blur"), 2);
  assert.equal(h.document.activeElement, s.submit);

  h.fire(s.submit, "keydown", { key: " " });
  h.fire(s.submit, "keyup", { key: " " });
  h.fire(s.submit, "click", { detail: 0 });
  assert.equal(count(s.name, "blur"), 3);
  assert.equal(h.document.activeElement, s.submit);
});

test("按住 Enter 的连发、组合键、其他按键不重复同步", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  h.fire(s.submit, "keydown", { key: "Enter", repeat: true });
  h.fire(s.submit, "keydown", { key: "Enter", ctrlKey: true });
  h.fire(s.submit, "keydown", { key: "Enter", isComposing: true });
  h.fire(s.submit, "keydown", { key: "a" });
  assert.equal(count(s.name, "blur"), 1);
});

test("回车触发的隐式提交（没有前置手势的 click）也同步一次", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  s.site.pageFocused = true;

  h.fire(s.submit, "click", { detail: 0 });

  assert.equal(count(s.name, "blur"), 2);
  assert.equal(s.site.model.name, "张三");
});

test("脚本构造的事件（isTrusted 为 false）不当作用户提交操作", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  for (const type of ["pointerdown", "click"]) h.fire(s.submit, type, { isTrusted: false });
  h.fire(s.submit, "keydown", { key: "Enter", isTrusted: false });
  assert.equal(count(s.name, "blur"), 1);
});

test("同步前后焦点位置不变，聚焦时不滚动页面", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"]]);
  const other = new h.HTMLInputElement();
  h.body.appendChild(other);
  other.focus();

  h.fire(s.submit, "pointerdown");

  assert.equal(h.document.activeElement, other);
  assert.equal(s.name.focusOptions.every((options) => options?.preventScroll === true), true);
});

test("按钮所属表单优先：只同步该表单里的字段；不在表单里的按钮才看全部字段", async () => {
  const h = createSubmitHarness();
  const a = buildSite(h);
  const b = buildSite(h);
  await fillSession(h, [[a.name, "甲"], [b.name, "乙"]]);

  h.mouseClick(b.submit);
  assert.equal(count(a.name, "blur"), 1);
  assert.equal(count(b.name, "blur"), 2);

  const loose = makeButton(h, { type: "button", text: "下一步" });
  h.body.appendChild(loose);
  h.mouseClick(loose);
  assert.equal(count(a.name, "blur"), 2);
  assert.equal(count(b.name, "blur"), 3);
});

test("同步与最终检查绝不调用 click / submit / requestSubmit，也不拦截事件", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  const session = await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"]]);
  h.counters.click = 0;

  const events = [];
  events.push(h.mouseClick(s.submit));
  s.submit.focus();
  events.push(h.fire(s.submit, "keydown", { key: "Enter" }), h.fire(s.submit, "click"));
  await h.finalSyncFillSession(session);

  assert.deepEqual(
    { click: h.counters.click, submit: h.counters.submit, requestSubmit: h.counters.requestSubmit },
    { click: 0, submit: 0, requestSubmit: 0 }
  );
  assert.equal(h.counters.preventDefault, 0);
  assert.equal(h.counters.stopPropagation, 0);
  assert.equal(events.every((event) => event.defaultPrevented === false), true);
  assert.equal(s.site.log.filter((entry) => entry === "site-click").length, 2);
});

test("不点预览、下一步或提交时，插件绝不会自行提交网页", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  const session = await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"]]);
  let submitEvents = 0;
  s.form.addEventListener("submit", () => { submitEvents += 1; });

  await h.finalSyncFillSession(session);
  h.mouseClick(s.name);
  h.fire(s.name, "keydown", { key: "Enter" });
  await sleep(30);

  assert.equal(submitEvents, 0);
  assert.equal(s.site.log.includes("site-click"), false);
  assert.deepEqual(
    { click: h.counters.click, submit: h.counters.submit, requestSubmit: h.counters.requestSubmit },
    { click: 0, submit: 0, requestSubmit: 0 }
  );
});

test("全部填完后的最终同步：只补 focus → blur，不写值", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  const session = await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"]]);
  s.site.pageFocused = true;
  s.phone.value = "13900139000";
  const inputsBefore = count(s.name, "input") + count(s.phone, "input");
  const changesBefore = count(s.name, "change") + count(s.phone, "change");

  await h.finalSyncFillSession(session);

  assert.equal(count(s.name, "blur"), 2);
  assert.equal(count(s.phone, "blur"), 2);
  assert.equal(s.phone.value, "13900139000");
  assert.equal(count(s.name, "input") + count(s.phone, "input"), inputsBefore);
  assert.equal(count(s.name, "change") + count(s.phone, "change"), changesBefore);
});

test("用户正在别的输入框里操作时，最终同步不抢焦点", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  const session = await fillSession(h, [[s.name, "张三"]]);
  const other = new h.HTMLInputElement();
  h.body.appendChild(other);
  other.focus();

  await h.finalSyncFillSession(session);

  assert.equal(h.document.activeElement, other);
  assert.equal(count(s.name, "blur"), 1);
});

test("新的一键填写会清掉上一次的记录", async () => {
  const h = createSubmitHarness();
  const s = buildSite(h);
  const first = await fillSession(h, [[s.name, "张三"]]);
  const second = h.beginFillSession();

  assert.notEqual(first, second);
  assert.deepEqual(h.fillSessionControls(), []);
  h.mouseClick(s.submit);
  assert.equal(count(s.name, "blur"), 1);
});

test("校验后插件填的框仍被标为无效：提示未同步并写进诊断，结果不再是全部成功", async () => {
  const h = createSubmitHarness();
  h.setSubmitCheckDelayMs(10);
  const s = buildSite(h, { syncOnBlur: false });
  const session = await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"]]);
  session.summary = { scanMs: 1, roundTripMs: 1, fillMs: 1, totalMs: 3, fieldCount: 2, filledCount: 2, unfilledCount: 0, outcome: "success", diagnostics: {} };
  s.site.pageFocused = true;
  s.name.setAttribute("aria-invalid", "true");

  h.mouseClick(s.submit);
  await sleep(40);

  assert.equal(s.name.value, "张三");
  assert.equal(h.statusElement.textContent, "页面仍认为部分内容无效，请检查内容或手动点击字段确认");
  assert.match(h.statusElement.className, /is-error/);
  assert.equal(h.textFillFailureReason(s.name), "framework_state_unsynced");
  assert.match(h.diagnosticsText.value, /页面表单状态未同步：2/);
  assert.match(h.diagnosticsText.value, /结果：部分完成/);
});

test("用户处理完成后会清除旧的未同步错误和字段失败记录", async () => {
  const h = createSubmitHarness();
  h.setSubmitCheckDelayMs(10);
  const s = buildSite(h, { syncOnBlur: false });
  const session = await fillSession(h, [[s.name, "张三"]]);
  session.summary = { fieldCount: 1, filledCount: 1, unfilledCount: 0, outcome: "success", diagnostics: {} };
  s.site.pageFocused = true;

  h.mouseClick(s.submit);
  await sleep(40);
  assert.equal(h.textFillFailureReason(s.name), "framework_state_unsynced");
  assert.match(h.statusElement.className, /is-error/);

  s.name.addEventListener("blur", () => { s.site.model.name = s.name.value; });
  h.mouseClick(s.submit);
  await sleep(40);
  assert.equal(h.textFillFailureReason(s.name), "");
  assert.equal(h.statusElement.textContent, "页面表单状态已同步。");
  assert.match(h.statusElement.className, /is-success/);
  assert.doesNotMatch(h.diagnosticsText.value, /页面表单状态未同步/);
  assert.match(h.diagnosticsText.value, /结果：完成/);
});

test("浏览器原生格式校验失败属于内容错误，不谎称表单状态未同步", async () => {
  const h = createSubmitHarness();
  h.setSubmitCheckDelayMs(10);
  const s = buildSite(h, { syncOnBlur: false });
  const session = await fillSession(h, [[s.email, "不是邮箱"]]);
  session.summary = { fieldCount: 1, filledCount: 1, unfilledCount: 0, outcome: "success", diagnostics: {} };
  s.site.pageFocused = true;
  s.email.validity = { valid: false };

  h.mouseClick(s.submit);
  await sleep(40);

  assert.equal(s.site.errors.email, true);
  assert.equal(h.statusElement.textContent, "");
  assert.equal(h.textFillFailureReason(s.email), "");
  assert.doesNotMatch(h.diagnosticsText.value, /页面表单状态未同步：[1-9]/);
});

test("真正为空或用户改错的字段，网站标红是真实错误，不算未同步", async () => {
  const h = createSubmitHarness();
  h.setSubmitCheckDelayMs(10);
  const s = buildSite(h);
  const session = await fillSession(h, [[s.name, "张三"], [s.phone, "13800138000"], [s.email, "a@b.c"]]);
  session.summary = { fieldCount: 3, filledCount: 3, unfilledCount: 0, outcome: "success", diagnostics: {} };
  s.site.pageFocused = true;
  s.email.value = "";
  s.phone.value = "12345";
  s.phone.addEventListener("blur", () => {
    s.site.model.phone = "";
  });

  h.mouseClick(s.submit);
  await sleep(40);

  assert.equal(s.site.errors.email, true);
  assert.equal(s.site.errors.phone, true);
  assert.equal(h.statusElement.textContent, "");
  assert.doesNotMatch(h.diagnosticsText.value, /页面表单状态未同步/);
});

test("重复点击不会重复注册监听器，也不会积累定时器", async () => {
  const h = createSubmitHarness();
  h.setSubmitCheckDelayMs(30);
  const s = buildSite(h);
  for (let round = 0; round < 3; round += 1) {
    s.name.setAttribute("aria-invalid", "false");
    await fillSession(h, [[s.name, "张三"]]);
    h.mouseClick(s.submit);
    h.mouseClick(s.submit);
    h.mouseClick(s.submit);
  }

  assert.deepEqual(
    h.documentAddCalls.filter((call) => call.type !== "DOMContentLoaded").map((call) => `${call.phase}:${call.type}`).sort(),
    ["capture:click", "capture:keydown", "capture:pointerdown"]
  );
  assert.equal(h.pendingTimers.size, 1);
  await sleep(60);
  assert.equal(h.pendingTimers.size, 0);
});

test("结束会话后不再同步，也不留下定时器", async () => {
  const h = createSubmitHarness();
  h.setSubmitCheckDelayMs(30);
  const s = buildSite(h);
  await fillSession(h, [[s.name, "张三"]]);
  h.mouseClick(s.submit);
  assert.equal(h.pendingTimers.size, 1);

  h.endFillSession();

  assert.equal(h.pendingTimers.size, 0);
  h.mouseClick(s.submit);
  assert.equal(count(s.name, "blur"), 2);
});
