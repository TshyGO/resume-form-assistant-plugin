// #228：content.js 接入扫描结果后的行为——一键填写和「加到我的信息」共用同一份扫描，
// 用之前都要确认题目和控件的对应关系还成立。扫描本身见 field-scan.test.js。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness");

function shadow() {
  const parts = {
    "#resume-pro-status": { textContent: "", className: "" },
    "#resume-pro-profile-offer": { hidden: true, querySelector: () => parts.offerText },
    offerText: { textContent: "" }
  };
  return { parts, root: { querySelector: (selector) => parts[selector] || null, querySelectorAll: () => [] } };
}

// 扫描替身：controls 由测试给定，staleness 由 stale 集合决定；counts 可改跳过数和字段名来源。
function scanWith(controls, stale = new Set(), counts = {}) {
  return {
    ...fakeFieldScan(),
    scanPage: () => ({ controls,
      skipped: { pageChrome: 1, popup: 0, merged: 2, siteSearch: 0, outsideForm: 0, noLabel: 3, ...counts.skipped },
      sources: counts.sources || { item: controls.length } }),
    isBindingCurrent: (binding) => !stale.has(binding.element)
  };
}

// 扫描替身在元素建好之后才定下来：content.js 加载时拿到的是这个转发对象。
function lateScanner() {
  const holder = { current: fakeFieldScan() };
  const proxy = Object.fromEntries(["scanPage", "isBindingCurrent", "hasDisplayedValue", "labelForElement"]
    .map((name) => [name, (...args) => holder.current[name](...args)]));
  return { holder, proxy };
}

function control(element, overrides = {}) {
  return { kind: "element", controlKind: "text", element, elements: [element], root: element, item: element,
    label: "", labelSource: "item", section: "", group: "", repeatIndex: 0, offerable: true, offerLabel: "",
    pickerType: "", rangePart: "", placeholder: "", ...overrides };
}

const store = {
  templates: [{ id: "t", name: "模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "测试用户" }] }] }],
  activeTemplateId: "t"
};

test('fill descriptors normalize legacy scanner names to the closed control kinds', async () => {
  const late = lateScanner(); let sent;
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async message => { sent = message; return { success: true, matches: [] }; } });
  const select = new ctx.HTMLSelectElement(), date = new ctx.HTMLInputElement();
  select.tagName = 'SELECT';
  select.options = [];
  late.holder.current = scanWith([control(select, { controlKind: 'select', label: '姓名' }), control(date, { controlKind: 'date-picker', pickerType: 'element', label: '姓名' })]);
  ctx.helpers.setCurrentStore(store); ctx.helpers.setShadowRoot(shadow().root);
  const result = await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.ok(sent, JSON.stringify(result));
  assert.deepEqual(Array.from(sent.formFields, field => field.controlKind), ['native-select', 'date']);
});

test('a failed parent blocks later fields in its cascade group', async () => {
  const late = lateScanner();
  const aiHelpers = { ...require('../ai-helpers.js'), detectCascadeGroups(fields) {
    fields.forEach((field, index) => { field.cascadeGroup = 'region'; field.cascadeLevel = index; });
  } };
  let requested = false, requestedFields;
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy, aiHelpers,
    sendMessage: async message => { requested = true; requestedFields = message.formFields; return { success: true, matches: [{ fieldId: 'field-0', value: '未知省' }, { fieldId: 'field-1', value: '深圳市' }] }; } });
  const parent = new ctx.HTMLSelectElement(), child = new ctx.HTMLSelectElement();
  parent.tagName = child.tagName = 'SELECT';
  parent.options = [{ value: '', text: '请选择' }, { value: 'gd', text: '广东省' }];
  child.options = [{ value: '', text: '请选择' }, { value: 'sz', text: '深圳市' }];
  parent.selectedIndex = child.selectedIndex = 0;
  let childEvents = 0; child.addEventListener('change', () => childEvents++);
  late.holder.current = scanWith([control(parent, { controlKind: 'select', label: '省' }), control(child, { controlKind: 'select', label: '市' })]);
  ctx.helpers.setCurrentStore({templates:[{id:'t',name:'模板',groups:[{name:'基本信息',fields:[{key:'省',value:'未知省'},{key:'市',value:'深圳市'}]}]}],activeTemplateId:'t'}); ctx.helpers.setShadowRoot(shadow().root);
  const result = await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(requested, true, JSON.stringify(result)); assert.equal(requestedFields.length, 2);
  assert.equal(result.filledCount, 0); assert.equal(childEvents, 0); assert.equal(child.selectedIndex, 0);
});

test('later field focus changing an earlier binding removes that earlier success', async () => {
  const late = lateScanner(), stale = new Set();
  const ctx = loadHighlightHelpers({formElements:[],fieldScan:late.proxy,
    sendMessage:async()=>({success:true,matches:[{fieldId:'field-0',value:'测试用户'},{fieldId:'field-1',value:'18888888888'}]})});
  const name = new ctx.HTMLInputElement(), phone = new ctx.HTMLInputElement();
  phone.focus = () => { stale.add(name); ctx.document.activeElement = phone; };
  late.holder.current = scanWith([control(name,{label:'姓名'}),control(phone,{label:'电话'})],stale);
  ctx.helpers.setCurrentStore(store);ctx.helpers.setShadowRoot(shadow().root);
  const result=await ctx.helpers.handleAiFillClick({currentTarget:{disabled:false,textContent:''}});
  assert.equal(name.value,'测试用户');assert.equal(phone.value,'18888888888');
  assert.equal(result.filledCount,1);assert.equal(result.unconfirmedCount,1);
});
test('existing opaque displayed selections retain the scanner overwrite protection', async () => {
  const late = lateScanner(); let confirms=0;
  const ctx=loadHighlightHelpers({formElements:[],fieldScan:late.proxy,
    customControls:{snapshot:()=>'{"selection":[],"query":null}',hasExistingValue:()=>false},
    confirm:()=>{confirms++;return false;},
    sendMessage:async()=>({success:true,matches:[{fieldId:'field-0',value:'硕士'}]})});
  const input=new ctx.HTMLInputElement();input.readOnly=true;
  late.holder.current={...scanWith([control(input,{label:'学历',controlKind:'custom-select'})]),hasDisplayedValue:()=>true};
  ctx.helpers.setCurrentStore(store);ctx.helpers.setShadowRoot(shadow().root);
  await ctx.helpers.handleAiFillClick({currentTarget:{disabled:false,textContent:''}});
  assert.equal(confirms,1);assert.equal(input.value,'');
});

test("the profile offer lists only reliably titled fields, by their section-qualified names", async () => {
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [] }) });
  const [award, practice, placeholderOnly] = [0, 1, 2].map(() => new ctx.HTMLInputElement());
  late.holder.current = scanWith([
    control(award, { label: "备注", section: "求职意向", offerLabel: "求职意向-备注" }),
    control(practice, { label: "备注", section: "附加信息", offerLabel: "附加信息-备注" }),
    control(placeholderOnly, { label: "", labelSource: "placeholder", offerable: false, placeholder: "请输入手机号码" })
  ]);
  const ui = shadow();
  ctx.helpers.setShadowRoot(ui.root);
  ctx.helpers.setCurrentStore(store);

  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });

  assert.equal(ui.parts["#resume-pro-profile-offer"].hidden, false);
  assert.equal(ui.parts.offerText.textContent, "可保存到我的信息：已填 0 项，待补 2 项");
  const offer = JSON.parse(JSON.stringify(ctx.helpers.panelProfileSnapshot()));
  assert.deepEqual(offer.pending.map((item) => item.key), ["求职意向-备注", "附加信息-备注"]);
  assert.doesNotMatch(JSON.stringify(offer), /手机号码|请输入/);
});

test("fields inside an experience section are not offered, and the diagnostics count them", async () => {
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [] }) });
  const [school, rank, salary] = [0, 1, 2].map(() => new ctx.HTMLInputElement());
  late.holder.current = scanWith([
    control(school, { label: "所在实验室名称", section: "教育经历", offerLabel: "所在实验室名称" }),
    control(rank, { label: "班级排名", section: "教育经历", offerLabel: "班级排名" }),
    control(salary, { label: "期望薪资（元/月）", section: "求职意向", offerLabel: "期望薪资（元/月）" })
  ]);
  const ui = shadow();
  const diagnostics = { "#resume-pro-diagnostics": { hidden: true }, "#resume-pro-diagnostics-text": { value: "" } };
  ctx.helpers.setShadowRoot({ querySelector: (selector) => ui.parts[selector] || diagnostics[selector] || null, querySelectorAll: () => [] });
  ctx.helpers.setCurrentStore(store);

  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });

  assert.equal(ui.parts.offerText.textContent, "可保存到我的信息：已填 0 项，待补 2 项");
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.helpers.panelProfileSnapshot())).pending.map((item) => item.key), ["班级排名", "期望薪资（元/月）"]);
  assert.match(diagnostics["#resume-pro-diagnostics-text"].value, /经历类区块 1$/m);
});

test("a field whose title binding went stale during matching is not written", async () => {
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: "field-0", value: "测试用户" }, { fieldId: "field-1", value: "测试用户" }] }) });
  const [moved, kept] = [0, 1].map(() => new ctx.HTMLInputElement());
  late.holder.current = scanWith([control(moved, { label: "姓名" }), control(kept, { label: "姓名拼音" })], new Set([moved]));
  const ui = shadow();
  ctx.helpers.setShadowRoot(ui.root);
  ctx.helpers.setCurrentStore(store);

  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });

  assert.equal(moved.value, "");
  assert.equal(kept.value, "测试用户");
  assert.match(ui.parts["#resume-pro-status"].textContent, /1 项没填上：姓名（页面已变化）/);
});

test("saving to 我的信息 re-checks the binding: a control that moved since the scan is reported, kept as a candidate, and never written", async () => {
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy });
  const element = new ctx.HTMLInputElement();
  element.value = "2 万";
  const stale = new Set([element]);
  late.holder.current = scanWith([], stale);
  ctx.helpers.setShadowRoot(shadow().root);
  ctx.helpers.setProfileOffer({
    candidates: [{ label: "期望薪资", entry: { kind: "element", element, binding: { element } } }]
  });
  const selected = [{ id: "期望薪资", key: "期望薪资", kind: "filled" }];

  const reply = await ctx.helpers.addUnansweredToProfile({ selected });

  assert.equal(ctx.desktopMessages.some((message) => message.type === "DESKTOP_RESUME_UPDATE"), false);
  assert.equal(reply.ok, false);
  const result = JSON.parse(JSON.stringify(reply.profileOffer.result));
  assert.equal(result.kind, "info");
  assert.match(result.details.join(), /所在的网页内容已经变化/);

  // 候选没有丢：控件对回题目之后，同一项又能保存，值是它此刻的值。
  stale.clear();
  element.value = "3 万";
  const snapshot = JSON.parse(JSON.stringify(ctx.helpers.panelProfileSnapshot()));
  assert.deepEqual(snapshot.filled.map((item) => [item.key, item.value]), [["期望薪资", "3 万"]]);
});

test("diagnostics carry scan skips and label sources in the v1 block, and survive the feedback allowlist", async () => {
  const feedback = require("../feedback-core.js");
  const allInputs = [];
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], allInputs, fieldScan: late.proxy, feedback,
    sendMessage: async () => ({ success: true, matches: [] }) });
  const input = () => new ctx.HTMLInputElement();
  const [school, rank, salary] = [input(), input(), input()];
  // 页面上：一个隐藏框，三个进了匹配，其余看得见的被扫描跳过（页头 1、对不上题目 3），剩下 2 个并进了同一个控件。
  allInputs.push(Object.assign(input(), { type: "hidden" }), school, rank, salary, ...Array.from({ length: 6 }, input));
  late.holder.current = scanWith([
    control(school, { label: "所在实验室名称", section: "教育经历", offerLabel: "所在实验室名称", labelSource: "explicit" }),
    control(rank, { label: "班级排名", section: "教育经历", offerLabel: "班级排名", labelSource: "table-header" }),
    control(salary, { label: "期望薪资（元/月）", section: "求职意向", offerLabel: "期望薪资（元/月）", labelSource: "item-text" })
  ], new Set(), { skipped: { ambiguous: 2 }, sources: { explicit: 1, "table-header": 1, "item-text": 1 } });
  const ui = shadow();
  // 侧栏读状态时要看状态条的样式，并从诊断面板里取文字。
  ui.parts["#resume-pro-status"].classList = { contains: () => false };
  const text = { value: "" };
  const diagnostics = { "#resume-pro-diagnostics-text": text,
    "#resume-pro-diagnostics": { hidden: true, querySelector: (selector) => (selector === "#resume-pro-diagnostics-text" ? text : null) } };
  ctx.helpers.setShadowRoot({ querySelector: (selector) => ui.parts[selector] || diagnostics[selector] || null, querySelectorAll: () => [] });
  ctx.helpers.setCurrentStore(store);

  await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });
  const report = (await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" }))?.diagnosticsReport || "";

  assert.match(report, /^dom_inputs: 10$/m);
  assert.match(report, /^visible_fields: 9$/m);
  assert.match(report, /^candidates: 3$/m);
  assert.match(report, /^drop_reasons: type_hidden=1,grouped=2,page_chrome=1,no_label=3(?:,|$)/m);
  assert.match(report, /^label_sources: explicit=1,item=1,table=1$/m);
  assert.match(report, /^offer_skipped: ambiguous=2,entry=1$/m);
  assert.equal(feedback.diagnostics(report), report);
  assert.doesNotMatch(report, /实验室|排名|薪资/);
  assert.match(text.value, /^丢弃原因：隐藏输入框 1、并入同一控件 2、页头导航 1、对不上题目 3/m);
  assert.match(text.value, /^字段名来源：明确关联 1、表单项 1、表格 1$/m);
  assert.match(text.value, /^「加到我的信息」没问：同名找不到区块 2；经历类区块 1$/m);
});

test('a form that is rebuilt after one answer keeps going on the rebuilt fields and still counts the earlier one', async () => {
  // #269 智联真机：选完「学位」后整张教育经历表单被删掉重建。旧字段都不在了，
  // 要按区块、题目和同名序号找回新字段：没填的接着填，填过的按新字段显示的内容核对。
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '学士' }, { fieldId: 'field-1', value: '本科' }] }) });
  const oldDegree = new ctx.HTMLInputElement(), oldEdu = new ctx.HTMLInputElement();
  const newDegree = new ctx.HTMLInputElement(), newEdu = new ctx.HTMLInputElement();
  const stale = new Set();
  const fields = (degree, edu) => [control(degree, { label: '学位', section: '教育经历' }), control(edu, { label: '学历', section: '教育经历' })];
  let rebuilt = false;
  const dispatch = oldDegree.dispatchEvent.bind(oldDegree);
  oldDegree.dispatchEvent = (event) => {
    const answer = dispatch(event);
    if (!rebuilt && oldDegree.value === '学士') {
      // 页面重建：新「学位」带着刚填的值，旧的两个字段从页面上移除。
      newDegree.value = oldDegree.value; oldDegree.isConnected = oldEdu.isConnected = false;
      stale.add(oldDegree); stale.add(oldEdu); rebuilt = true;
    }
    return answer;
  };
  const scanner = scanWith(fields(oldDegree, oldEdu), stale);
  late.holder.current = { ...scanner, scanPage: (...args) => ({ ...scanner.scanPage(...args), controls: rebuilt ? fields(newDegree, newEdu) : fields(oldDegree, oldEdu) }) };
  ctx.helpers.setCurrentStore({ templates: [{ id: 't', name: '模板', groups: [{ name: '教育经历', fields: [{ key: '学位', value: '学士' }, { key: '学历', value: '本科' }] }] }], activeTemplateId: 't' });
  ctx.helpers.setShadowRoot(shadow().root);
  const result = await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(rebuilt, true, JSON.stringify({ result, old: oldDegree.value, events: oldDegree.dispatchedEvents.map(e => e.type), oldEdu: oldEdu.value }));
  assert.equal(newEdu.value, '本科', 'the rebuilt 学历 is filled');
  assert.equal(oldEdu.value, '', 'the removed 学历 is left alone');
  assert.equal(result.filledCount, 2, JSON.stringify(result));
  assert.equal(result.unfilledCount, 0);
});

test('a rebuilt form whose field now holds something else is not written', async () => {
  // 重建后的字段内容和批准时不一样（页面带出了别的值，或用户改过）：不能当成同一个空字段接着写。
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '学士' }, { fieldId: 'field-1', value: '本科' }] }) });
  const oldDegree = new ctx.HTMLInputElement(), oldEdu = new ctx.HTMLInputElement();
  const newDegree = new ctx.HTMLInputElement(), newEdu = new ctx.HTMLInputElement();
  const stale = new Set();
  const fields = (degree, edu) => [control(degree, { label: '学位', section: '教育经历' }), control(edu, { label: '学历', section: '教育经历' })];
  let rebuilt = false;
  const dispatch = oldDegree.dispatchEvent.bind(oldDegree);
  oldDegree.dispatchEvent = (event) => {
    const answer = dispatch(event);
    if (!rebuilt && oldDegree.value === '学士') {
      newDegree.value = oldDegree.value; newEdu.value = '大专'; oldDegree.isConnected = oldEdu.isConnected = false;
      stale.add(oldDegree); stale.add(oldEdu); rebuilt = true;
    }
    return answer;
  };
  const scanner = scanWith(fields(oldDegree, oldEdu), stale);
  late.holder.current = { ...scanner, scanPage: (...args) => ({ ...scanner.scanPage(...args), controls: rebuilt ? fields(newDegree, newEdu) : fields(oldDegree, oldEdu) }) };
  ctx.helpers.setCurrentStore({ templates: [{ id: 't', name: '模板', groups: [{ name: '教育经历', fields: [{ key: '学位', value: '学士' }, { key: '学历', value: '本科' }] }] }], activeTemplateId: 't' });
  ctx.helpers.setShadowRoot(shadow().root);
  const result = await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(rebuilt, true);
  assert.equal(newEdu.value, '大专', 'the rebuilt field keeps what the page put there');
  assert.equal(result.filledCount, 1, JSON.stringify(result));
});

// #269 智联真机：选完「学历」后表单才长出「专业」「研究方向」等字段。选完等页面安静再扫一次，
// 新出现的空字段先在本地匹配当场填，本地匹配不上的这一轮结束后交给 AI 补填。
function grownForm({ newLabel, newValue = '', resume, aiMore = [] }) {
  const late = lateScanner();
  const requests = [];
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy, aiHelpers: require('../ai-helpers.js'),
    sendMessage: async (message) => {
      if (message.type !== 'AI_FILL') return { success: true, matches: [] };
      requests.push(message);
      return requests.length === 1 ? { success: true, matches: [{ fieldId: 'field-0', value: '本科' }] }
        : { success: true, matches: aiMore.map((value, index) => ({ fieldId: message.formFields[index].fieldId, value })) };
    } });
  const edu = new ctx.HTMLSelectElement(); edu.tagName = 'SELECT';
  edu.options = [{ value: '', text: '请选择' }, { value: 'bk', text: '本科' }]; edu.selectedIndex = 0;
  const grown = new ctx.HTMLInputElement(); grown.value = newValue;
  const base = [control(edu, { controlKind: 'select', label: '学历', section: '教育经历' })];
  const scanner = scanWith(base);
  late.holder.current = { ...scanner, scanPage: (...args) => ({ ...scanner.scanPage(...args),
    controls: edu.selectedIndex === 1 ? [...base, control(grown, { label: newLabel, section: '教育经历' })] : base }) };
  ctx.helpers.setCurrentStore({ templates: [{ id: 't', name: '模板', groups: [{ name: '教育经历', fields: [{ key: '学历', value: '本科' }, ...resume] }] }], activeTemplateId: 't' });
  const view = shadow();
  ctx.helpers.setShadowRoot(view.root);
  return { ctx, requests, grown, view };
}

test('a field that appears after a choice and matches locally is filled in the same round without another AI call', async () => {
  const h = grownForm({ newLabel: '专业', resume: [{ key: '专业', value: '示例工程' }] });
  const result = await h.ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(h.grown.value, '示例工程');
  assert.equal(result.filledCount, 2, JSON.stringify(result));
  assert.equal(h.requests.length, 1, 'no extra AI request for a locally matched field');
  assert.match(h.view.parts['#resume-pro-status'].textContent, /新出现的字段补填 1 项/);
});

test('a new field the local rules cannot match is sent to AI once after the round, alone', async () => {
  const h = grownForm({ newLabel: '研究方向', resume: [{ key: '研究课题', value: '示例方向' }], aiMore: ['示例方向'] });
  const result = await h.ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.stringify(h.requests[1].formFields.map((field) => field.label)), JSON.stringify(['研究方向']));
  assert.equal(h.grown.value, '示例方向');
  assert.equal(result.filledCount, 2, JSON.stringify(result));
});

test('a new field whose name appears more than once in the resume is left to AI', async () => {
  const h = grownForm({ newLabel: '专业', resume: [{ key: '专业', value: '示例工程' }, { key: '专业', value: '示例管理' }], aiMore: ['示例管理'] });
  const result = await h.ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(h.requests.length, 2);
  assert.equal(h.grown.value, '示例管理');
  assert.equal(result.filledCount, 2);
});

test('a field that appears already filled is left as it is', async () => {
  const h = grownForm({ newLabel: '专业', newValue: '页面带出的值', resume: [{ key: '专业', value: '示例工程' }] });
  const result = await h.ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(h.grown.value, '页面带出的值');
  assert.equal(result.filledCount, 1);
  assert.equal(h.requests.length, 1);
});

test('a field whose repeat number shifts because a same-named field appeared is not treated as new', async () => {
  // CodeRabbit（PR #329）：两段教育经历都有「专业」。第 1 段选完学历后多出一个「专业」，第 2 段原有的「专业」
  // 序号随之变化。只看序号会把它当新字段再填一次，第二次写入时被当成用户改过，整次填写停下。
  const late = lateScanner();
  const requests = [];
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy, aiHelpers: require('../ai-helpers.js'),
    sendMessage: async (message) => {
      if (message.type !== 'AI_FILL') return { success: true, matches: [] };
      requests.push(message);
      return requests.length === 1 ? { success: true, matches: [{ fieldId: 'field-0', value: '本科' }, { fieldId: 'field-1', value: '示例管理' }] }
        : { success: true, matches: message.formFields.map((field) => ({ fieldId: field.fieldId, value: '示例工程' })) };
    } });
  const edu = new ctx.HTMLSelectElement(); edu.tagName = 'SELECT';
  edu.options = [{ value: '', text: '请选择' }, { value: 'bk', text: '本科' }]; edu.selectedIndex = 0;
  const second = new ctx.HTMLInputElement(), grown = new ctx.HTMLInputElement();
  const before = [control(edu, { controlKind: 'select', label: '学历', section: '教育经历' }),
    control(second, { label: '专业', section: '教育经历', repeatIndex: 0, repeatCount: 1 })];
  const after = [before[0], control(grown, { label: '专业', section: '教育经历', repeatIndex: 1, repeatCount: 2 }),
    control(second, { label: '专业', section: '教育经历', repeatIndex: 2, repeatCount: 2 })];
  const scanner = scanWith(before);
  late.holder.current = { ...scanner, scanPage: (...args) => ({ ...scanner.scanPage(...args), controls: edu.selectedIndex === 1 ? after : before }) };
  ctx.helpers.setCurrentStore({ templates: [{ id: 't', name: '模板', groups: [{ name: '教育经历', fields: [{ key: '学历', value: '本科' }, { key: '专业', value: '示例工程' }, { key: '专业', value: '示例管理' }] }] }], activeTemplateId: 't' });
  ctx.helpers.setShadowRoot(shadow().root);
  const result = await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(result.overwriteDeclined, false, JSON.stringify(result));
  assert.equal(second.value, '示例管理');
  assert.equal(grown.value, '示例工程');
  assert.equal(result.filledCount, 3, JSON.stringify(result));
  assert.equal(JSON.stringify(requests[1].formFields.map((field) => field.label)), JSON.stringify(['专业']));
});

test('a field replaced right after the write that now shows something else is not retried or overwritten', async () => {
  // 审查 A1：写完立刻被页面换掉，新字段里既不是填写前的空值、也不是刚写的值（可能是用户刚改的）：不碰，按未确认。
  const late = lateScanner();
  const ctx = loadHighlightHelpers({ formElements: [], fieldScan: late.proxy,
    sendMessage: async () => ({ success: true, matches: [{ fieldId: 'field-0', value: '学士' }] }) });
  const oldDegree = new ctx.HTMLInputElement(), newDegree = new ctx.HTMLInputElement();
  const stale = new Set();
  const fields = (degree) => [control(degree, { label: '学位', section: '教育经历' })];
  let rebuilt = false;
  const dispatch = oldDegree.dispatchEvent.bind(oldDegree);
  oldDegree.dispatchEvent = (event) => {
    const answer = dispatch(event);
    if (!rebuilt && oldDegree.value === '学士') {
      newDegree.value = '硕士'; oldDegree.isConnected = false; stale.add(oldDegree); rebuilt = true;
    }
    return answer;
  };
  const scanner = scanWith(fields(oldDegree), stale);
  late.holder.current = { ...scanner, scanPage: (...args) => ({ ...scanner.scanPage(...args), controls: rebuilt ? fields(newDegree) : fields(oldDegree) }) };
  ctx.helpers.setCurrentStore({ templates: [{ id: 't', name: '模板', groups: [{ name: '教育经历', fields: [{ key: '学位', value: '学士' }] }] }], activeTemplateId: 't' });
  ctx.helpers.setShadowRoot(shadow().root);
  const result = await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: '' } });
  assert.equal(rebuilt, true);
  assert.equal(newDegree.value, '硕士', 'what the rebuilt field shows is kept');
  assert.equal(result.filledCount, 0, JSON.stringify(result));
  assert.equal(result.unconfirmedCount, 1);
});
