// #189：「加到我的信息」带上网页已填内容。content.js 这一半：候选连着网页上的控件、点击时现读现校验、
// 写桌面、失败时不丢候选、成功后重读桌面。纯规则见 profile-fields.test.js，侧栏画面见 sidepanel-profile-save.test.js。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness");

const plain = (value) => JSON.parse(JSON.stringify(value));

function shadow() {
  const parts = {
    "#resume-pro-status": { textContent: "", className: "" },
    "#resume-pro-profile-offer": { hidden: true, querySelector: () => parts.offerText },
    offerText: { textContent: "" }
  };
  return { parts, root: { querySelector: (selector) => parts[selector] || null, querySelectorAll: () => [] } };
}

function lateScanner() {
  const holder = { current: fakeFieldScan(), stale: new Set() };
  const proxy = Object.fromEntries(["scanPage", "isBindingCurrent", "hasDisplayedValue", "labelForElement"]
    .map((name) => [name, (...args) => holder.current[name](...args)]));
  return { holder, proxy };
}

function control(element, overrides = {}) {
  return { kind: "element", controlKind: "text", element, elements: [element], root: element, item: element,
    label: "", labelSource: "item", section: "", group: "", repeatIndex: 0, offerable: true, offerLabel: "",
    pickerType: "", rangePart: "", placeholder: "", ...overrides };
}

const TEMPLATE = { id: "t", name: "模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] };

// 一个带桌面的页面：桌面档案和 revision 在 desktop 里，写入成功才落地；update 可以换成任意回复。
function page({ profile = { values: {}, family: [], custom: [] }, update = null, desktopRead = null, matches = [], customControls } = {}) {
  const late = lateScanner();
  const desktop = { profile, revision: 0 };
  const updates = [];
  let reads = 0;
  let ctx;
  const persist = () => ctx.helpers.setCurrentStore({ templates: [TEMPLATE], activeTemplateId: "t", profile: desktop.profile, profileRevision: desktop.revision });
  ctx = loadHighlightHelpers({
    formElements: [], fieldScan: late.proxy, customControls,
    desktopRead: desktopRead && (() => desktopRead(desktop)) || (() => { reads += 1; return { status: "ok", data: {
      templates: [{ id: "t", name: "模板", fieldCount: 1 }], activeTemplate: TEMPLATE, profile: desktop.profile, profileRevision: desktop.revision } }; }),
    sendMessage: async (message) => {
      if (message.type !== "DESKTOP_RESUME_UPDATE") return { success: true, matches };
      updates.push(plain(message));
      const reply = update ? await update(message, desktop) : { status: "ok" };
      if (reply.status === "ok") { desktop.profile = message.profile; desktop.revision += 1; }
      return reply;
    }
  });
  persist();
  const ui = shadow();
  ctx.helpers.setShadowRoot(ui.root);
  return { ctx, late, desktop, updates, ui, reads: () => reads, persist,
    snapshot: () => plain(ctx.helpers.panelProfileSnapshot()),
    scan(controls, stale = new Set()) {
      late.holder.current = { ...fakeFieldScan(),
        scanPage: () => ({ controls, skipped: { pageChrome: 0, popup: 0, merged: 0, siteSearch: 0, outsideForm: 0, noLabel: 0 }, sources: {} }),
        isBindingCurrent: (binding) => !stale.has(binding.element) };
    },
    fill: () => ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } }),
    save: (selected, extra = {}) => ctx.helpers.addUnansweredToProfile({ selected, ...extra }) };
}

const filled = (id, key = id) => ({ id, key: key, kind: "filled" });

test("after a fill, filled and empty unmatched fields are candidates; a value typed afterwards is picked up and saved as it is now", async () => {
  const p = page({ matches: [{ fieldId: "field-0", value: "测试用户" }] });
  const [name, hobby, salary, code, why] = Array.from({ length: 5 }, () => new p.ctx.HTMLInputElement());
  hobby.value = "摄影";
  why.value = "因为热爱这份工作";
  p.scan([
    control(name, { label: "姓名", offerLabel: "姓名" }), control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" }),
    control(salary, { label: "期望薪资", offerLabel: "期望薪资" }), control(code, { label: "短信验证码", offerLabel: "短信验证码" }),
    control(why, { label: "你为什么想加入我们", offerLabel: "你为什么想加入我们" })
  ]);

  await p.fill();

  let offer = p.snapshot();
  assert.equal(offer.summary, "可保存到我的信息：已填 2 项，待补 1 项");
  assert.deepEqual(offer.filled.map((item) => [item.key, item.value, item.defaultSelected]), [["兴趣爱好", "摄影", true], ["你为什么想加入我们", "因为热爱这份工作", false]]);
  assert.deepEqual(offer.pending.map((item) => item.key), ["期望薪资"]);
  assert.equal(JSON.stringify(offer).includes("测试用户"), false, "fields the resume already answered are not candidates");
  assert.equal(p.ui.parts["#resume-pro-profile-offer"].hidden, false);

  // 一键填写之后用户才手动补值：候选里立刻是最新值。
  salary.value = "2 万 / 月";
  offer = p.snapshot();
  assert.deepEqual(offer.filled.map((item) => item.key), ["兴趣爱好", "期望薪资", "你为什么想加入我们"], "listed in page order");
  assert.equal(offer.pending.length, 0);

  // 点保存之前又改了一次：写进桌面的是点击那一刻的值，不是一键填写时或上次看到的值。
  hobby.value = "摄影、徒步";
  const reply = await p.save([filled("兴趣爱好"), filled("期望薪资")], { version: p.ctx.helpers.getProfileOfferVersion() });

  assert.equal(reply.ok, true);
  assert.deepEqual(p.desktop.profile.custom, [{ key: "兴趣爱好", value: "摄影、徒步" }, { key: "期望薪资", value: "2 万 / 月" }]);
  assert.equal(p.desktop.revision, 1);
  assert.equal(reply.profileOffer.result.text, "已保存 2 项，下次填写可用。");
  assert.deepEqual(plain(reply.profileOffer.result.savedItems), [
    { key: "兴趣爱好", value: "摄影、徒步", kind: "filled" },
    { key: "期望薪资", value: "2 万 / 月", kind: "filled" }
  ]);
  // 已保存的不再是候选；没勾选的岗位相关回答还在，网页上的输入一个字都没动。
  assert.deepEqual(reply.profileOffer.filled.map((item) => item.key), ["你为什么想加入我们"]);
  assert.deepEqual([hobby.value, salary.value, why.value], ["摄影、徒步", "2 万 / 月", "因为热爱这份工作"]);
  assert.deepEqual([hobby, salary, why].map((element) => element.dispatchedEvents.length), [0, 0, 0], "saving never fires events on the page's inputs");
});

test("a failed write is reported as a failure, nothing is claimed saved, and every candidate is still there for a retry", async () => {
  let attempt = 0;
  const p = page({ update: async () => (++attempt === 1 ? { status: "unavailable" } : { status: "ok" }) });
  const [hobby, salary] = [new p.ctx.HTMLInputElement(), new p.ctx.HTMLInputElement()];
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" }), control(salary, { label: "期望薪资", offerLabel: "期望薪资" })]);
  await p.fill();
  const selected = [filled("兴趣爱好"), { id: "期望薪资", key: "期望薪资", kind: "pending" }];

  const failed = await p.save(selected);

  assert.equal(failed.ok, false);
  assert.equal(failed.saved, 0);
  assert.equal(failed.profileOffer.result.kind, "error");
  assert.match(failed.profileOffer.result.text, /桌面程序已退出或暂时没有响应/);
  assert.match(failed.profileOffer.result.text, /候选还在/);
  assert.doesNotMatch(failed.profileOffer.result.text, /已保存/);
  assert.deepEqual(p.desktop.profile.custom, [], "the desktop never confirmed, so nothing is stored");
  assert.deepEqual([failed.profileOffer.filled.length, failed.profileOffer.pending.length], [1, 1]);

  const retried = await p.save(selected);
  assert.equal(retried.ok, true);
  assert.deepEqual(p.desktop.profile.custom, [{ key: "兴趣爱好", value: "摄影" }, { key: "期望薪资", value: "" }]);
  assert.match(retried.profileOffer.result.text, /^已保存 2 项/);
});

test("each desktop refusal has its own honest message, and none of them drops the candidates", async () => {
  const cases = [
    ["secret", /像密码或验证码/], ["input_too_large", /太大/], ["invalid_payload", /没有接受这次保存/],
    ["not_paired", /尚未与这个插件配对/], ["incompatible", /版本太旧/], ["something_else", /暂时无法保存/]
  ];
  for (const [status, pattern] of cases) {
    const p = page({ update: async () => ({ status }) });
    const hobby = new p.ctx.HTMLInputElement();
    hobby.value = "摄影";
    p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
    await p.fill();
    const reply = await p.save([filled("兴趣爱好")]);
    assert.equal(reply.profileOffer.result.kind, "error", status);
    assert.match(reply.profileOffer.result.text, pattern, status);
    assert.equal(reply.profileOffer.filled.length, 1, status);
  }
});

test("a revision conflict is retried once against the fresh desktop profile; a second one is reported", async () => {
  let calls = 0;
  const p = page({ update: async (message, desktop) => {
    calls += 1;
    if (calls === 1) { desktop.revision += 1; desktop.profile = { values: {}, family: [], custom: [{ key: "别处加的", value: "x" }] }; return { status: "conflict" }; }
    return { status: "ok" };
  } });
  const hobby = new p.ctx.HTMLInputElement();
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
  await p.fill();
  const reply = await p.save([filled("兴趣爱好")]);
  assert.deepEqual(p.updates.map((message) => message.expectedRevision), [0, 1]);
  assert.deepEqual(p.desktop.profile.custom, [{ key: "别处加的", value: "x" }, { key: "兴趣爱好", value: "摄影" }], "what the other writer added survives");
  assert.equal(reply.ok, true);

  const stubborn = page({ update: async (message, desktop) => { desktop.revision += 1; return { status: "conflict" }; } });
  const other = new stubborn.ctx.HTMLInputElement();
  other.value = "摄影";
  stubborn.scan([control(other, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
  await stubborn.fill();
  const second = await stubborn.save([filled("兴趣爱好")]);
  assert.equal(second.ok, false);
  assert.match(second.profileOffer.result.text, /刚在别处改过/);
  assert.equal(second.profileOffer.filled.length, 1);
});

test("a desktop that cannot be read at click time is a real failure with the candidates kept", async () => {
  let up = true;
  const p = page({ desktopRead: (desktop) => up
    ? { status: "ok", data: { templates: [], activeTemplate: TEMPLATE, profile: desktop.profile, profileRevision: desktop.revision } }
    : { status: "unavailable" } });
  const hobby = new p.ctx.HTMLInputElement();
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
  await p.fill();
  up = false;
  const reply = await p.save([filled("兴趣爱好")]);
  assert.equal(reply.ok, false);
  assert.equal(p.updates.length, 0);
  assert.match(reply.profileOffer.result.text, /桌面程序已退出或暂时没有响应/);
  assert.equal(reply.profileOffer.filled.length, 1);
});

test("clicking twice does not write twice, and saving the same items again adds no second row", async () => {
  const p = page();
  const hobby = new p.ctx.HTMLInputElement();
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
  await p.fill();

  const [first, second] = await Promise.all([p.save([filled("兴趣爱好")]), p.save([filled("兴趣爱好")])]);
  assert.deepEqual([first.ok, second.ok], [true, false]);
  assert.match(second.error, /正在保存/);
  assert.equal(p.updates.length, 1);

  // 候选已经因为「桌面里有了相同内容」消失，没有候选可存时就不再发写入。
  const third = await p.save([filled("兴趣爱好")]);
  assert.equal(third.ok, false);
  assert.equal(p.updates.length, 1);
  assert.deepEqual(p.desktop.profile.custom, [{ key: "兴趣爱好", value: "摄影" }]);
});

test("a different value already on the desktop is shown as a conflict and only replaced when asked, with the value the user saw", async () => {
  const p = page({ profile: { values: {}, family: [], custom: [{ key: "特长", value: "钢琴" }, { key: "驾照", value: "" }] } });
  const [skill, license] = [new p.ctx.HTMLInputElement(), new p.ctx.HTMLInputElement()];
  skill.value = "绘画";
  license.value = "C1";
  p.scan([control(skill, { label: "特长", offerLabel: "特长" }), control(license, { label: "驾照", offerLabel: "驾照" })]);
  await p.fill();

  const offer = p.snapshot();
  assert.deepEqual(offer.conflicts.map((item) => [item.key, item.existing, item.value]), [["特长", "钢琴", "绘画"]]);
  assert.deepEqual(offer.filled.map((item) => [item.key, item.completes]), [["驾照", true]], "an empty pending row on the desktop is completed, not duplicated");
  assert.match(offer.summary, /另有 1 项与桌面已有内容不同/);

  const kept = await p.save([filled("驾照"), { id: "特长", key: "特长", kind: "conflict" }]);
  assert.deepEqual(p.desktop.profile.custom, [{ key: "特长", value: "钢琴" }, { key: "驾照", value: "C1" }]);
  assert.equal(kept.profileOffer.result.kind, "partial");
  assert.match(kept.profileOffer.result.details.join(), /需要勾选「替换」/);

  const replaced = await p.save([{ id: "特长", key: "特长", kind: "conflict", replaceOf: "钢琴" }]);
  assert.equal(replaced.ok, true);
  assert.deepEqual(p.desktop.profile.custom, [{ key: "特长", value: "绘画" }, { key: "驾照", value: "C1" }]);
});

test("a secret-looking value is refused with its reason while the safe items are still saved, and it is never listed", async () => {
  const p = page();
  const [note, hobby] = [new p.ctx.HTMLInputElement(), new p.ctx.HTMLInputElement()];
  note.value = "登录密码：abc123";
  hobby.value = "摄影";
  p.scan([control(note, { label: "补充信息", offerLabel: "补充信息" }), control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
  await p.fill();
  const offer = p.snapshot();
  assert.equal(JSON.stringify(offer).includes("abc123"), false);
  assert.deepEqual(offer.filled.map((item) => item.key), ["兴趣爱好"]);
  assert.match(offer.notes.join(), /「补充信息」的内容像密码或验证码/);

  // 即便请求里硬带上这一项（旧侧栏、手工构造的消息），写入前也会再拦一次，并且不把其它项报成「全部成功」。
  const reply = await p.save([filled("补充信息"), filled("兴趣爱好")]);
  assert.deepEqual(p.desktop.profile.custom, [{ key: "兴趣爱好", value: "摄影" }]);
  assert.equal(reply.profileOffer.result.kind, "partial");
  assert.match(reply.profileOffer.result.text, /已保存 1 项.*另有 1 项没保存/);
  assert.equal(JSON.stringify(p.updates).includes("abc123"), false);
});

test("controls are read as the user sees them: option text, radio label, and custom selections; unreadable ones are not guessed", async () => {
  const p = page({ customControls: {
    readSelection: (entry) => entry.element.selection,
    hasExistingValue: (entry) => entry.element.selection === null || entry.element.selection?.texts.length > 0
  } });
  const select = new p.ctx.HTMLSelectElement();
  select.tagName = "SELECT";
  select.options = [{ value: "", text: "请选择" }, { value: "01", text: "本科", selected: true }, { value: "02", text: "硕士" }];
  select.selectedIndex = 1;
  const yes = new p.ctx.HTMLInputElement(), no = new p.ctx.HTMLInputElement();
  Object.assign(yes, { type: "radio", checked: true, labels: [{ textContent: " 是 " }] });
  Object.assign(no, { type: "radio", labels: [{ textContent: "否" }] });
  const opaque = new p.ctx.HTMLInputElement(), region = new p.ctx.HTMLInputElement(), missing = new p.ctx.HTMLInputElement();
  opaque.selection = null;
  region.selection = { texts: ["广东省", "深圳市"], cascade: true };
  missing.selection = { texts: [], cascade: false };
  const entries = (list) => list.map(([label, entry]) => ({ label, inputType: "text", matched: false, entry }));
  p.ctx.helpers.offerUnansweredFields(entries([
    ["学历层次", { kind: "element", element: select, controlKind: "native-select" }],
    ["是否接受出差", { kind: "radio", elements: [yes, no] }],
    ["意向城市", { kind: "element", element: region, controlKind: "cascader" }],
    ["语言证书", { kind: "element", element: opaque, controlKind: "custom-select" }],
    ["驾驶类型", { kind: "element", element: missing, controlKind: "custom-select" }]
  ]));

  const offer = p.snapshot();
  assert.deepEqual(offer.filled.map((item) => [item.key, item.value]), [["学历层次", "本科"], ["是否接受出差", "是"], ["意向城市", "广东省/深圳市"]]);
  assert.deepEqual(offer.pending.map((item) => [item.key, item.unreadable]), [["语言证书", true], ["驾驶类型", false]]);
});

test("a control that disappeared or whose title changed is reported, kept as a candidate, and written under no name", async () => {
  const p = page();
  const [moved, gone] = [new p.ctx.HTMLInputElement(), new p.ctx.HTMLInputElement()];
  moved.value = "摄影";
  gone.value = "徒步";
  const stale = new Set();
  p.scan([control(moved, { label: "兴趣爱好", offerLabel: "兴趣爱好" }), control(gone, { label: "特长", offerLabel: "特长" })], stale);
  await p.fill();

  stale.add(moved);       // 重渲染后同一个位置换了题目
  gone.isConnected = false; // 这个控件已经不在页面上
  const reply = await p.save([filled("兴趣爱好"), filled("特长")]);

  assert.equal(reply.ok, false);
  assert.equal(p.updates.length, 0);
  assert.equal(reply.profileOffer.result.kind, "info");
  assert.equal(reply.profileOffer.result.details.length, 2);
  assert.match(reply.profileOffer.result.details[0], /所在的网页内容已经变化/);

  stale.clear();
  gone.isConnected = true;
  assert.deepEqual(p.snapshot().filled.map((item) => item.key), ["兴趣爱好", "特长"], "the candidates were never dropped");
});

test("a request about an older offer is refused instead of saving something the user did not see", async () => {
  const p = page();
  const hobby = new p.ctx.HTMLInputElement();
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
  await p.fill();
  const reply = await p.save([filled("兴趣爱好")], { version: p.ctx.helpers.getProfileOfferVersion() - 1 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /候选已经更新/);
  assert.equal(p.updates.length, 0);
});

test("the panel messages round-trip: save, dismiss the result, and skip", async () => {
  const p = page();
  const [hobby, salary] = [new p.ctx.HTMLInputElement(), new p.ctx.HTMLInputElement()];
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" }), control(salary, { label: "期望薪资", offerLabel: "期望薪资" })]);
  await p.fill();
  const version = p.ctx.helpers.getProfileOfferVersion();

  const saved = await p.ctx.sendPanelMessage({ type: "RESUME_PANEL_OFFER", action: "profileAdd", version, selected: [filled("兴趣爱好")] });
  assert.equal(saved.ok, true);
  assert.equal(saved.profileOffer.result.saved, 1);
  assert.deepEqual(saved.profileOffer.pending.map((item) => item.key), ["期望薪资"]);

  const dismissed = await p.ctx.sendPanelMessage({ type: "RESUME_PANEL_OFFER", action: "profileDismiss" });
  assert.equal(dismissed.profileOffer, null, "completing the save hides the whole card");
  salary.value = "29000";
  assert.deepEqual(p.snapshot().filled.map((item) => item.key), ["期望薪资"], "a new answer brings the card back");

  await p.ctx.sendPanelMessage({ type: "RESUME_PANEL_OFFER", action: "profileSkip" });
  assert.equal(p.snapshot(), null);
});

test("saving shows a result until the user fills another unanswered field on the page", async () => {
  const p = page();
  const [hobby, salary] = [new p.ctx.HTMLInputElement(), new p.ctx.HTMLInputElement()];
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" }), control(salary, { label: "期望薪资", offerLabel: "期望薪资" })]);
  await p.fill();
  const saved = await p.save([filled("兴趣爱好")]);
  assert.equal(saved.profileOffer.result.saved, 1);
  assert.deepEqual(saved.profileOffer.pending.map((item) => item.key), ["期望薪资"]);

  salary.value = "29000";
  const next = p.snapshot();
  assert.equal(next.result, null, "a new answer brings back the save suggestion automatically");
  assert.deepEqual(next.filled.map((item) => [item.key, item.value]), [["期望薪资", "29000"]]);
});

test("a new fill replaces the previous offer and its result", async () => {
  const p = page();
  const hobby = new p.ctx.HTMLInputElement();
  hobby.value = "摄影";
  p.scan([control(hobby, { label: "兴趣爱好", offerLabel: "兴趣爱好" })]);
  await p.fill();
  const firstVersion = p.snapshot().version;
  await p.save([filled("兴趣爱好")]);
  assert.equal(p.snapshot().result.saved, 1);

  const skill = new p.ctx.HTMLInputElement();
  skill.value = "绘画";
  p.scan([control(skill, { label: "特长", offerLabel: "特长" })]);
  await p.fill();
  const next = p.snapshot();
  assert.equal(next.result, null);
  assert.ok(next.version > firstVersion, "a save request made for the old offer would now be refused");
  assert.deepEqual(next.filled.map((item) => item.key), ["特长"]);
});
