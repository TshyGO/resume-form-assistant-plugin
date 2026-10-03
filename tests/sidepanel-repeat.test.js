// #188: AI 辅助新增条目 runs entirely from the native side panel. The first half drives
// sidepanel.js; the second drives the page controller in content.js with the real
// form-agent against a synthetic section, so no click happens before 确认新增.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const agent = require('../form-agent.js');
const Compose = require('../sidepanel-compose.js');
const { loadHighlightHelpers } = require('./helpers/content-harness.js');

const root = path.join(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const TEMPLATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// ---- side panel ---------------------------------------------------------------------

function element() {
  const listeners = {};
  const classes = new Set();
  return {
    listeners, classes, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', children: [],
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); } },
    addEventListener(type, listener) { listeners[type] = listener; },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return []; },
    querySelector() { return { textContent: '' }; }
  };
}

async function sidePanel() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const calls = [];
  const state = { tabId: 9, repeat: null, statusFor: null, repeatReply: null };
  const listeners = {};
  let poll;
  const chrome = {
    runtime: {
      id: 'diagjmploldedipjdenmecmjokckelkl',
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        calls.push(message);
        return message.type === 'DESKTOP_RESUME_READ' ? { status: 'ok', data: {
          templates: [{ id: TEMPLATE, name: '桌面模板', fieldCount: 1 }],
          activeTemplate: { id: TEMPLATE, name: '桌面模板', groups: [{ name: '教育经历', fields: [{ key: '学校1', value: '甲大学' }] }] },
          profile: { values: {}, family: [], custom: [] }, profileRevision: 1
        } } : { status: 'ok' };
      }
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: state.tabId }],
      sendMessage: async (id, message) => {
        calls.push(JSON.parse(JSON.stringify({ tabId: id, ...message })));
        if (message.type === 'RESUME_PANEL_STATUS') {
          if (state.statusFor) return state.statusFor(id);
          return { ready: true, repeat: state.repeat };
        }
        if (message.type === 'RESUME_PANEL_REPEAT') return state.repeatReply ? state.repeatReply(message) : { ok: true };
        if (message.type === 'RESUME_PANEL_TARGET') return { ok: true, targetAvailable: false };
        return { ok: true };
      },
      create: async () => {},
      onActivated: { addListener(listener) { listeners.activated = listener; } },
      onUpdated: { addListener() {} }
    }
  };
  const documentStub = {
    hidden: false, getElementById: get, querySelectorAll: () => [],
    querySelector: () => ({ click() {}, open: false }), addEventListener() {},
    createElement: (tagName) => ({ tagName: tagName.toUpperCase(), textContent: '' })
  };
  const context = vm.createContext({
    document: documentStub, chrome,
    navigator: { clipboard: { writeText: async () => {} } },
    self: { ResumeProProfile: require('../profile-fields.js'), ResumeProResumeData: require('../resume-data.js'), ResumeProCompose: Compose },
    setTimeout: () => 1, clearTimeout() {}, setInterval: (listener) => { poll = listener; }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8'), context);
  await tick();
  await poll();
  await tick();
  const repeatCalls = () => calls.filter((call) => call.type === 'RESUME_PANEL_REPEAT');
  const click = async (id) => { get(id).listeners.click(); await tick(); await tick(); };
  return { get, calls, state, listeners, repeatCalls, click, poll: async () => { await poll(); await tick(); } };
}

const view = (phase, extra = {}) => ({
  phase, requestId: 'req-1', message: '', plan: [], added: 0, progress: null,
  canConfirm: phase === 'preview', canCancel: phase === 'preview',
  canStop: ['scanning', 'planning', 'executing', 'filling'].includes(phase), ...extra
});

test('the entry sits on the 填写 page next to 一键 AI 填写, not in the ··· menu', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
  const fillView = html.slice(html.indexOf('id="fill-view"'), html.indexOf('id="fields-view"'));
  const menu = html.slice(html.indexOf('dock-tools__menu'), html.indexOf('</details>'));
  assert.match(fillView, /<button class="repeat-button" id="repeat-button" type="button">AI 辅助新增条目<\/button>/);
  assert.ok(fillView.indexOf('id="repeat-button"') > fillView.indexOf('id="fill-button"'));
  assert.ok(fillView.indexOf('id="repeat-button"') < fillView.indexOf('id="feedback-notice-root"'), 'next to the fill button, above the feedback notice');
  assert.ok(!menu.includes('辅助新增'));
  assert.ok(!html.includes('data-advanced="repeat"'));
  assert.match(html, /id="repeat-message"[^>]*role="status"[^>]*aria-live="polite"/);
  const panelJs = fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8');
  assert.ok(!/confirm\(/.test(panelJs.replace(/repeatAction\("confirm"\)/g, '')), 'no window.confirm in the side panel');
});

test('starting sends RESUME_PANEL_REPEAT start once, never the old advanced path', async () => {
  const ui = await sidePanel();
  assert.equal(ui.get('repeat-button').disabled, false);
  const reply = deferred();
  ui.state.repeatReply = () => reply.promise;
  ui.get('repeat-button').listeners.click();
  ui.get('repeat-button').listeners.click();
  await tick();
  assert.equal(ui.get('repeat-button').disabled, true, 'disabled while the start is in flight');
  reply.resolve({ ok: true, requestId: 'req-1' });
  await tick(); await tick();
  assert.deepEqual(ui.repeatCalls().map(({ tabId, action, requestId }) => ({ tabId, action, requestId })), [{ tabId: 9, action: 'start', requestId: undefined }]);
  assert.equal(ui.calls.filter((call) => call.type === 'RESUME_PANEL_ADVANCED').length, 0);
});

test('scanning and planning show progress and 停止, which carries the requestId', async () => {
  const ui = await sidePanel();
  ui.state.repeat = view('scanning', { message: '正在检查网页中可以安全新增的经历…' });
  await ui.poll();
  assert.equal(ui.get('repeat-card').hidden, false);
  assert.equal(ui.get('repeat-message').textContent, '正在检查网页中可以安全新增的经历…');
  ui.state.repeat = view('planning', { message: 'AI 正在规划需要新增的条目…' });
  await ui.poll();
  assert.equal(ui.get('repeat-message').textContent, 'AI 正在规划需要新增的条目…');
  assert.equal(ui.get('repeat-stop').hidden, false);
  assert.equal(ui.get('repeat-confirm').hidden, true);
  assert.equal(ui.get('repeat-dismiss').hidden, true);
  assert.equal(ui.get('fill-button').disabled, true, 'no normal fill while assisted add runs');
  assert.equal(ui.get('repeat-button').disabled, true);
  await ui.click('repeat-stop');
  assert.deepEqual(ui.repeatCalls().map(({ action, requestId }) => ({ action, requestId })), [{ action: 'stop', requestId: 'req-1' }]);
});

test('the preview lists each group in Chinese; 确认新增 fires once even on a double click', async () => {
  const ui = await sidePanel();
  ui.state.repeat = view('preview', { message: '计划新增以下条目：', plan: [{ domain: 'education', count: 2 }, { domain: 'projects', count: 1 }] });
  await ui.poll();
  assert.deepEqual(ui.get('repeat-plan').children.map((row) => row.textContent), ['教育经历：2 条', '项目经历：1 条']);
  assert.equal(ui.get('repeat-plan').hidden, false);
  assert.equal(ui.get('repeat-confirm').hidden, false);
  assert.equal(ui.get('repeat-cancel').hidden, false);
  assert.equal(ui.get('repeat-stop').hidden, true);
  const reply = deferred();
  ui.state.repeatReply = () => reply.promise;
  ui.get('repeat-confirm').listeners.click();
  ui.get('repeat-confirm').listeners.click();
  await tick();
  assert.equal(ui.get('repeat-confirm').disabled, true);
  reply.resolve({ ok: true });
  await tick(); await tick();
  assert.deepEqual(ui.repeatCalls().map(({ action, requestId }) => ({ action, requestId })), [{ action: 'confirm', requestId: 'req-1' }]);
});

test('cancel sends the shown requestId; terminal states offer 知道了 and no stop', async () => {
  const ui = await sidePanel();
  ui.state.repeat = view('preview', { message: '计划新增以下条目：', plan: [{ domain: 'education', count: 2 }] });
  await ui.poll();
  await ui.click('repeat-cancel');
  assert.deepEqual(ui.repeatCalls().map(({ action, requestId }) => ({ action, requestId })), [{ action: 'cancel', requestId: 'req-1' }]);
  ui.state.repeat = view('stopped', { message: '已停止。已经新增的 1 条空记录会保留，请在网页中核对。', added: 1 });
  await ui.poll();
  assert.equal(ui.get('repeat-message').textContent, '已停止。已经新增的 1 条空记录会保留，请在网页中核对。');
  assert.equal(ui.get('repeat-stop').hidden, true);
  assert.equal(ui.get('repeat-dismiss').hidden, false);
  assert.equal(ui.get('fill-button').disabled, false, 'normal fill is available again');
  ui.state.repeat = view('failed', { message: '未识别到可安全新增的分组，请先手动新增条目，再一键填写。' });
  await ui.poll();
  assert.ok(ui.get('repeat-card').classes.has('is-error'));
});

test('page data is cut to the fixed shape: unknown groups, big plans and markup never render', async () => {
  const ui = await sidePanel();
  ui.state.repeat = view('preview', { message: '<img src=x onerror=alert(1)>', plan: [{ domain: 'education', count: 3, label: '<b>x</b>' }, { domain: 'projects', count: 3 }] });
  await ui.poll();
  assert.equal(ui.get('repeat-plan').children.length, 0, 'a plan over 5 is not shown');
  assert.equal(ui.get('repeat-confirm').hidden, true, 'and cannot be confirmed');
  assert.equal(ui.get('repeat-card').innerHTML, '', 'text only, never innerHTML');
  assert.equal(ui.get('repeat-message').textContent, '<img src=x onerror=alert(1)>');
  ui.state.repeat = view('preview', { plan: [{ domain: 'selector', count: 1 }, { domain: 'education', count: 1 }] });
  await ui.poll();
  assert.deepEqual(ui.get('repeat-plan').children.map((row) => row.textContent), ['教育经历：1 条']);
  ui.state.repeat = view('preview', { requestId: 'bad id;', plan: [{ domain: 'education', count: 1 }] });
  await ui.poll();
  assert.equal(ui.get('repeat-confirm').hidden, true, 'no usable requestId, nothing to confirm');
  ui.state.repeat = { ...view('preview'), phase: 'navigate' };
  await ui.poll();
  assert.equal(ui.get('repeat-card').hidden, true);
});

test('switching tabs clears the card, and a status answer from the old tab is dropped', async () => {
  const ui = await sidePanel();
  ui.state.repeat = view('preview', { message: '计划新增以下条目：', plan: [{ domain: 'education', count: 2 }] });
  await ui.poll();
  assert.equal(ui.get('repeat-card').hidden, false);
  // A poll for tab 9 is in flight when the user moves to tab 10.
  const late = deferred();
  ui.state.statusFor = (id) => (id === 9 ? late.promise : { ready: true, repeat: null });
  const pending = ui.poll();
  await tick();
  ui.state.tabId = 10;
  ui.listeners.activated({ tabId: 10 });
  await tick();
  assert.equal(ui.get('repeat-card').hidden, true);
  late.resolve({ ready: true, repeat: view('preview', { message: '旧标签页的计划', plan: [{ domain: 'education', count: 2 }] }) });
  await pending;
  await tick(); await tick();
  assert.equal(ui.get('repeat-card').hidden, true, 'tab 9\'s plan never shows on tab 10');
  assert.notEqual(ui.get('repeat-message').textContent, '旧标签页的计划');
  // An action still aimed at tab 9 is refused by the panel itself.
  ui.state.tabId = 11;
  ui.state.statusFor = null;
  ui.state.repeat = view('preview', { plan: [{ domain: 'education', count: 1 }] });
  await ui.poll();
  ui.state.tabId = 12;
  await ui.click('repeat-confirm');
  assert.equal(ui.repeatCalls().length, 0);
});

test('switching the template in the panel invalidates the page\'s plan first', async () => {
  const ui = await sidePanel();
  ui.get('template-select').value = TEMPLATE;
  await ui.get('template-select').listeners.change();
  const order = ui.calls.map((call) => call.type === 'RESUME_PANEL_REPEAT' ? `repeat:${call.action}` : call.op || call.type);
  assert.ok(order.indexOf('repeat:invalidate') >= 0);
  assert.ok(order.indexOf('repeat:invalidate') < order.indexOf('setActiveTemplate'));
});

// ---- page controller ------------------------------------------------------------------

const templateStore = (records = 3) => ({
  templates: [{ id: TEMPLATE, name: '模板', groups: [{ name: '教育经历', fields: Array.from({ length: records }, (_, i) => ({ key: `学校${i + 1}`, value: `大学${i + 1}` })) }] }],
  activeTemplateId: TEMPLATE
});

// One 教育经历 section with one filled row and a single safe 新增 button.
function repeatPage({ effect = 'add', onClick = null, plan = () => ({ success: true, plan: [{ id: 'add-0', count: 2 }] }),
  fill = (message) => ({ success: true, matches: message.formFields.map((field) => ({ fieldId: field.fieldId, value: `AI-${field.fieldId}` })) }) } = {}) {
  const location = { href: 'https://jobs.example.test/apply' };
  const inputs = [];
  const sent = [];
  let confirms = 0;
  const submits = { form: 0, request: 0 };
  const form = { submit() { submits.form++; }, requestSubmit() { submits.request++; } };
  const legacy = { classList: new Set() };
  const harness = loadHighlightHelpers({
    formElements: inputs,
    location,
    randomUUID: (() => { let n = 0; return () => `req-${++n}`; })(),
    confirm: () => { confirms++; return true; },
    formAgent: { ...agent, collect: (_document, fields) => agent.collect(fx.document, fields) },
    sendMessage: async (message) => {
      sent.push(message);
      if (message.type === 'AI_PLAN_REPEAT') return plan(message);
      if (message.type === 'CANCEL_AI_FILL') return { cancelled: true };
      if (message.type === 'AI_FILL') return fill(message);
      return { status: 'ok' };
    }
  });
  const { helpers, HTMLInputElement, timers } = harness;
  const rows = [];
  const addRow = (value = '') => {
    const input = new HTMLInputElement();
    input.value = value;
    input.form = form;
    input.getClientRects = () => [1];
    inputs.push(input);
    rows.push({ isConnected: true, getClientRects: () => [1], parentElement: { closest: () => null }, querySelector: () => input,
      contains: (el) => el === input });
  };
  addRow('用户已填的第一段');
  const heading = { textContent: '教育经历', isConnected: true };
  let clicks = 0;
  const scope = {
    isConnected: true,
    querySelector: () => heading,
    contains: (el) => el === button || inputs.includes(el),
    querySelectorAll: (selector) => selector === 'fieldset' ? rows : selector.startsWith('button') ? [button] : inputs
  };
  const button = {
    tagName: 'BUTTON', textContent: '新增教育经历', disabled: false, isConnected: true,
    getClientRects: () => [1], getAttribute: (name) => name === 'type' ? 'button' : null,
    closest: (selector) => selector.startsWith('#') ? null : scope,
    click() {
      clicks++;
      if (effect === 'many') { addRow(); addRow(); } else if (effect !== 'none') addRow();
      if (effect === 'change') inputs[0].value = '网页改写';
      if (onClick) onClick(clicks);
    }
  };
  // Other sections the page may render later; each has its own safe 新增 button.
  const extra = [];
  const addSection = (title = '教育经历') => {
    const own = { isConnected: true, getClientRects: () => [1], parentElement: { closest: () => null }, querySelector: () => inputs[0] };
    const sectionHeading = { textContent: title, isConnected: true };
    const section = { isConnected: true, querySelector: () => sectionHeading, contains: (el) => el === other,
      querySelectorAll: (selector) => selector === 'fieldset' ? [own] : selector.startsWith('button') ? [other] : [] };
    const other = { ...button, textContent: `新增${title}`, closest: (selector) => selector.startsWith('#') ? null : section, click() {} };
    extra.push(other);
  };
  const fx = { document: { querySelectorAll: () => [button, ...extra] } };
  const fillButton = { disabled: false, textContent: '一键 AI 填写' };
  helpers.setShadowRoot({ querySelector: (selector) => ({ '#resume-pro-ai-fill': fillButton, '.resume-pro': legacy })[selector] || null });
  helpers.setCurrentStore(templateStore());
  const ask = (message) => harness.sendPanelMessage({ type: 'RESUME_PANEL_REPEAT', ...message });
  const status = async () => (await harness.sendPanelMessage({ type: 'RESUME_PANEL_STATUS' })).repeat;
  // Runs the page's own short timers (field commit checks) until the controller settles.
  const settle = async (done) => {
    for (let i = 0; i < 400; i++) {
      await tick();
      for (const timer of timers) {
        if (!timer.cleared && timer.delay < 1000) { timer.cleared = true; timer.callback(); }
      }
      if (done(await status())) return;
    }
    throw new Error('controller did not settle');
  };
  return { ...harness, helpers, location, inputs, rows, sent, heading, button, legacy, submits, ask, status, settle, fillButton,
    clicks: () => clicks, confirms: () => confirms, addRow, addSection,
    aiCalls: (type) => sent.filter((message) => message.type === type) };
}

const settled = (phase) => (repeat) => repeat.phase === phase;

test('scan → plan → preview without touching the page; AI sees only the candidate summary', async () => {
  const reply = deferred();
  const page = repeatPage({ plan: () => reply.promise });
  const started = await page.ask({ action: 'start' });
  assert.equal(started.ok, true);
  await page.settle(settled('planning'));
  const planning = await page.status();
  assert.equal(planning.message, 'AI 正在规划需要新增的条目…');
  assert.equal(planning.canStop, true);
  const [request] = page.aiCalls('AI_PLAN_REPEAT');
  assert.deepEqual(request.candidates, [{ id: 'add-0', domain: 'education', label: '新增教育经历', current: 1, target: 3 }]);
  assert.deepEqual(Object.keys(request).sort(), ['candidates', 'requestId', 'type']);
  reply.resolve({ success: true, plan: [{ id: 'add-0', count: 2 }] });
  await page.settle(settled('preview'));
  const preview = await page.status();
  assert.deepEqual(preview.plan, [{ domain: 'education', count: 2 }]);
  assert.equal(preview.message, '计划新增以下条目：');
  assert.deepEqual([preview.canConfirm, preview.canCancel, preview.canStop], [true, true, false]);
  assert.equal(page.clicks(), 0, 'no click before 确认新增');
  assert.equal(page.rows.length, 1);
  assert.equal(page.confirms(), 0, 'window.confirm is never used');
  assert.equal(page.legacy.classList.size, 0, 'the old page UI is not opened');
});

test('confirm adds one row per click, fills only the new rows, never submits', async () => {
  const progress = [];
  let page;
  page = repeatPage({ onClick: () => { progress.push(page.helpers.describeRepeat().message); } });
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  const { requestId } = await page.status();
  const [first, second] = await Promise.all([page.ask({ action: 'confirm', requestId }), page.ask({ action: 'confirm', requestId })]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'a double click cannot run the plan twice');
  await page.settle(settled('completed'));
  assert.equal(page.clicks(), 2);
  assert.deepEqual(progress, ['正在新增教育经历 1/2…', '正在新增教育经历 2/2…']);
  const [fill] = page.aiCalls('AI_FILL');
  assert.deepEqual(Array.from(fill.formFields, (field) => field.fieldId), ['field-1', 'field-2'], 'only the two new rows are sent');
  assert.deepEqual(page.inputs.map((input) => input.value), ['用户已填的第一段', 'AI-field-1', 'AI-field-2']);
  const done = await page.status();
  assert.equal(done.added, 2);
  assert.match(done.message, /^已新增教育经历 2 条，并完成新字段填写/);
  assert.deepEqual(page.submits, { form: 0, request: 0 });
  assert.equal(page.confirms(), 0);
  assert.equal(page.legacy.classList.size, 0);
});

test('an empty field in an existing row is not sent to AI or filled', async () => {
  const page = repeatPage();
  page.inputs[0].value = '';
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  await page.ask({ action: 'confirm', requestId: (await page.status()).requestId });
  await page.settle(settled('completed'));
  const [fill] = page.aiCalls('AI_FILL');
  assert.deepEqual(Array.from(fill.formFields, (field) => field.fieldId), ['field-1', 'field-2']);
  assert.deepEqual(page.inputs.map((input) => input.value), ['', 'AI-field-1', 'AI-field-2']);
});

test('a second start while one runs is refused and plans only once', async () => {
  const reply = deferred();
  const page = repeatPage({ plan: () => reply.promise });
  const [a, b] = await Promise.all([page.ask({ action: 'start' }), page.ask({ action: 'start' })]);
  assert.deepEqual([a.ok, b.ok], [true, false]);
  await page.settle(settled('planning'));
  assert.equal(page.aiCalls('AI_PLAN_REPEAT').length, 1);
  const fill = await page.sendPanelMessage({ type: 'RESUME_PANEL_FILL' });
  assert.equal(fill.ok, false, 'normal fill waits for assisted add');
  reply.resolve({ success: false, error: 'x' });
});

test('stop during planning cancels the AI request and ignores its late answer', async () => {
  const reply = deferred();
  const page = repeatPage({ plan: () => reply.promise });
  await page.ask({ action: 'start' });
  await page.settle(settled('planning'));
  const { requestId } = await page.status();
  assert.equal((await page.ask({ action: 'stop', requestId: 'someone-else' })).ok, false, 'an old requestId cannot stop this run');
  assert.equal((await page.ask({ action: 'stop', requestId })).ok, true);
  assert.deepEqual(page.aiCalls('CANCEL_AI_FILL').map((message) => message.requestId), [requestId]);
  reply.resolve({ success: true, plan: [{ id: 'add-0', count: 2 }] });
  await tick(); await tick();
  const after = await page.status();
  assert.equal(after.phase, 'stopped');
  assert.equal(after.message, '已停止，未新增任何条目。');
  assert.equal((await page.ask({ action: 'confirm', requestId })).ok, false);
  assert.equal(page.clicks(), 0);
});

test('cancel at the preview leaves the page untouched and the plan cannot be confirmed later', async () => {
  const page = repeatPage();
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  const { requestId } = await page.status();
  assert.equal((await page.ask({ action: 'cancel', requestId })).ok, true);
  assert.equal((await page.status()).message, '已取消，网页没有变化。');
  assert.equal((await page.ask({ action: 'confirm', requestId })).ok, false);
  await tick();
  assert.equal(page.clicks(), 0);
  assert.equal(page.aiCalls('AI_FILL').length, 0);
});

test('no safe candidate: a clear message, no AI call, no old UI', async () => {
  const page = repeatPage();
  page.helpers.setCurrentStore(templateStore(1));
  await page.ask({ action: 'start' });
  await page.settle(settled('failed'));
  assert.equal((await page.status()).message, '未识别到可安全新增的分组，请先手动新增条目，再一键填写。');
  assert.equal(page.aiCalls('AI_PLAN_REPEAT').length, 0);
  assert.equal(page.legacy.classList.size, 0);
  assert.equal(page.clicks(), 0);
});

for (const [name, plan] of [
  ['an id that was not a candidate', [{ id: 'add-9', count: 2 }]],
  ['a duplicate id', [{ id: 'add-0', count: 2 }, { id: 'add-0', count: 2 }]],
  ['an extra selector field', [{ id: 'add-0', count: 2, selector: '#submit' }]],
  ['code', [{ id: 'add-0', count: 2, code: 'form.submit()' }]],
  ['a submit action', [{ id: 'add-0', count: 2, action: 'submit' }]],
  ['the wrong count', [{ id: 'add-0', count: 1 }]],
  ['a non-integer count', [{ id: 'add-0', count: 1.5 }]],
  ['a string count', [{ id: 'add-0', count: '2' }]],
  ['no array', { id: 'add-0', count: 2 }]
]) {
  test(`an AI plan with ${name} is rejected and nothing is clicked`, async () => {
    const page = repeatPage({ plan: () => ({ success: true, plan }) });
    await page.ask({ action: 'start' });
    await page.settle(settled('failed'));
    assert.match((await page.status()).message, /未执行新增/);
    assert.equal(page.clicks(), 0);
  });
}

test('a plan over five rows in total is rejected by validatePlan', () => {
  const candidates = [
    { id: 'add-0', domain: 'education', current: 1, target: 4 },
    { id: 'add-1', domain: 'projects', current: 0, target: 3 }
  ];
  assert.throws(() => agent.validatePlan([{ id: 'add-0', count: 3 }, { id: 'add-1', count: 3 }], candidates), /最多新增 5 条/);
});

for (const [name, change, expected] of [
  ['the desktop template changed', (page) => page.helpers.setCurrentStore({ ...templateStore(), templates: [{ ...templateStore().templates[0], groups: [{ name: '教育经历', fields: [{ key: '学校1', value: '别的大学' }] }] }] }), /模板已变化/],
  ['the side panel switched template', (page) => page.ask({ action: 'invalidate' }), /模板已切换/],
  ['the address changed (SPA job switch)', (page) => { page.location.href = 'https://jobs.example.test/other-job'; }, /网页地址已变化/],
  ['the page\'s rows changed', (page) => page.addRow('用户手动加的一段'), /网页分组已变化/],
  ['the tab went to the background', (page) => { page.document.hidden = true; }, /已切换到其他标签页/]
]) {
  test(`the preview is void once ${name}`, async () => {
    const page = repeatPage();
    await page.ask({ action: 'start' });
    await page.settle(settled('preview'));
    const { requestId } = await page.status();
    await change(page);
    const confirmed = await page.ask({ action: 'confirm', requestId });
    if (confirmed.ok) await page.settle((repeat) => !['executing', 'filling'].includes(repeat.phase));
    const after = await page.status();
    page.document.hidden = false;
    assert.equal(after.phase, 'stopped');
    assert.match(after.message, expected);
    assert.equal(page.clicks(), 0);
    assert.equal(page.aiCalls('AI_FILL').length, 0);
  });
}

test('stop during execution keeps the rows already added and says how many', async () => {
  let page;
  page = repeatPage({ onClick: (n) => { if (n === 1) page.ask({ action: 'stop', requestId: page.helpers.describeRepeat().requestId }); } });
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  await page.ask({ action: 'confirm', requestId: (await page.status()).requestId });
  await page.settle(settled('stopped'));
  const after = await page.status();
  assert.equal(page.clicks(), 1, 'no further click after 停止');
  assert.equal(after.added, 1);
  assert.equal(after.message, '已停止。已经新增的 1 条空记录会保留，请在网页中核对。');
  assert.equal(page.rows.length, 2, 'the added row is not deleted');
  assert.equal(page.aiCalls('AI_FILL').length, 0, 'and nothing is filled');
});

for (const [effect, pattern, added] of [
  ['many', /一次新增了多个条目/, 2],
  ['change', /改变了已有字段/, 1]
]) {
  test(`execution stops at once when a click ${effect === 'many' ? 'adds several rows' : 'changes an existing field'}`, async () => {
    const page = repeatPage({ effect });
    await page.ask({ action: 'start' });
    await page.settle(settled('preview'));
    await page.ask({ action: 'confirm', requestId: (await page.status()).requestId });
    await page.settle(settled('failed'));
    const after = await page.status();
    assert.equal(page.clicks(), 1);
    assert.match(after.message, pattern);
    assert.equal(after.added, added, 'the real number of rows the page gained');
    assert.match(after.message, new RegExp(`已经新增的 ${added} 条空记录会保留`));
    assert.equal(page.aiCalls('AI_FILL').length, 0);
  });
}

test('stop while filling ends the fill before it writes', async () => {
  // Hold the AI_FILL answer so 停止 lands while the fill waits for it.
  const fillReply = deferred();
  const page = repeatPage({ fill: () => fillReply.promise });
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  const { requestId } = await page.status();
  await page.ask({ action: 'confirm', requestId });
  await page.settle(() => page.aiCalls('AI_FILL').length === 1);
  assert.equal((await page.ask({ action: 'stop', requestId })).ok, true);
  assert.equal(page.aiCalls('CANCEL_AI_FILL').length, 1, 'the fill\'s AI wait is cancelled');
  const [fillRequest] = page.aiCalls('AI_FILL');
  fillReply.resolve({ success: true, matches: fillRequest.formFields.map((field) => ({ fieldId: field.fieldId, value: 'late' })) });
  await page.settle((repeat) => repeat.phase !== 'filling');
  const after = await page.status();
  assert.equal(after.phase, 'stopped');
  assert.equal(after.added, 2);
  assert.match(after.message, /已停止填写。已经新增的 2 条空记录会保留/);
  assert.deepEqual(page.inputs.map((input) => input.value), ['用户已填的第一段', '', ''], 'no new row was written after 停止');
});

test('an address change while planning ends the run instead of leaving it "in progress"', async () => {
  const reply = deferred();
  const page = repeatPage({ plan: () => reply.promise });
  await page.ask({ action: 'start' });
  await page.settle(settled('planning'));
  const { requestId } = await page.status();
  // An SPA moves to another job: no tab switch, no page event, only the address changes.
  page.location.href = 'https://jobs.example.test/other-job';
  const after = await page.status();
  assert.equal(after.phase, 'stopped');
  assert.equal(after.message, '网页地址已变化，计划已失效，请重新预览。');
  assert.equal(after.canStop, false);
  assert.deepEqual(page.aiCalls('CANCEL_AI_FILL').map((message) => message.requestId), [requestId]);
  reply.resolve({ success: true, plan: [{ id: 'add-0', count: 2 }] });
  await tick(); await tick();
  assert.equal((await page.status()).phase, 'stopped', 'the late plan does not come back as a preview');
  assert.equal(page.clicks(), 0);
  assert.equal((await page.ask({ action: 'start' })).ok, true, 'nothing stays busy: a new run can start');
});

test('a late plan for a run that went stale on its own also ends it with the reason', async () => {
  const reply = deferred();
  const page = repeatPage({ plan: () => reply.promise });
  await page.ask({ action: 'start' });
  await page.settle(settled('planning'));
  page.location.href = 'https://jobs.example.test/other-job';
  // No status poll in between: the AI answer itself finds the run stale.
  reply.resolve({ success: true, plan: [{ id: 'add-0', count: 2 }] });
  await tick(); await tick();
  const repeat = page.helpers.describeRepeat();
  assert.equal(repeat.phase, 'stopped');
  assert.equal(repeat.message, '网页地址已变化，计划已失效，请重新预览。');
  assert.equal(page.clicks(), 0);
});

test('another group appearing between two clicks stops before the next click', async () => {
  let page;
  page = repeatPage({ onClick: (n) => { if (n === 1) page.addSection('教育经历'); } });
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  await page.ask({ action: 'confirm', requestId: (await page.status()).requestId });
  await page.settle(settled('failed'));
  const after = await page.status();
  assert.equal(page.clicks(), 1, 'the second planned click never happens');
  assert.equal(after.added, 1);
  assert.equal(after.message, '网页分组已变化，已停止。已经新增的 1 条空记录会保留，请在网页中核对。');
  assert.equal(page.aiCalls('AI_FILL').length, 0);
});

test('the rows this plan adds itself do not count as a change', async () => {
  const page = repeatPage();
  page.addSection('项目经历');
  page.helpers.setCurrentStore({ ...templateStore(), templates: [{ ...templateStore().templates[0], groups: [
    ...templateStore().templates[0].groups,
    { name: '项目经历', fields: [{ key: '项目名称1', value: '甲' }, { key: '项目名称2', value: '乙' }] }
  ] }] });
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  const preview = await page.status();
  assert.deepEqual(preview.plan, [{ domain: 'education', count: 2 }], 'the untouched 项目经历 candidate is not in this plan');
  await page.ask({ action: 'confirm', requestId: preview.requestId });
  await page.settle(settled('completed'));
  assert.equal(page.clicks(), 2);
});

test('a stop after some fields were written says how many, not "空记录"', async () => {
  let page;
  page = repeatPage({ onClick: () => {
    const input = page.inputs[page.inputs.length - 1];
    let value = '';
    Object.defineProperty(input, 'value', { configurable: true, get: () => value, set: (next) => {
      value = next;
      if (next) page.helpers.handlePanelRepeat({ action: 'stop', requestId: page.helpers.describeRepeat().requestId });
    } });
  } });
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  await page.ask({ action: 'confirm', requestId: (await page.status()).requestId });
  await page.settle(settled('stopped'));
  const after = await page.status();
  assert.equal(after.added, 2);
  assert.equal(after.message, '已停止填写。已新增的 2 条记录会保留，其中 1 项已填写，请在网页中核对。');
  assert.deepEqual(page.inputs.map((input) => input.value), ['用户已填的第一段', 'AI-field-1', ''], 'nothing written after 停止');
});

test('a stop while the fill is still preparing sends nothing to the AI', async () => {
  let page;
  let stopped = false;
  // The first time the fill's field scan looks at a new row, the user presses 停止: filling has
  // begun, but no AI request exists yet that the stop could cancel.
  page = repeatPage({ onClick: () => {
    const input = page.inputs[page.inputs.length - 1];
    Object.defineProperty(input, 'type', { configurable: true, get() {
      if (!stopped && page.helpers.describeRepeat().phase === 'filling') {
        stopped = true;
        page.helpers.handlePanelRepeat({ action: 'stop', requestId: page.helpers.describeRepeat().requestId });
      }
      return 'text';
    } });
  } });
  await page.ask({ action: 'start' });
  await page.settle(settled('preview'));
  await page.ask({ action: 'confirm', requestId: (await page.status()).requestId });
  await page.settle((repeat) => ['completed', 'stopped', 'failed'].includes(repeat.phase));
  const after = await page.status();
  assert.equal(stopped, true, 'the stop landed during preparation');
  assert.equal(after.phase, 'stopped');
  assert.equal(page.aiCalls('AI_FILL').length, 0, 'no resume fields leave after 停止');
  assert.equal(after.message, '已停止填写。已经新增的 2 条空记录会保留，请在网页中核对。');
  assert.deepEqual(page.inputs.map((input) => input.value), ['用户已填的第一段', '', '']);
});

test('知道了 clears the finished run, its requestId included; the status has no unused fields', async () => {
  const page = repeatPage();
  page.helpers.setCurrentStore(templateStore(1));
  await page.ask({ action: 'start' });
  await page.settle(settled('failed'));
  const { requestId } = await page.status();
  assert.equal((await page.ask({ action: 'dismiss' })).ok, true);
  const idle = await page.status();
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.requestId, '');
  assert.deepEqual(Object.keys(idle).sort(), ['added', 'canCancel', 'canConfirm', 'canStop', 'message', 'phase', 'plan', 'requestId']);
  assert.equal((await page.ask({ action: 'stop', requestId })).ok, false);
});

test('with the native side panel the page\'s old button never reaches window.confirm', async () => {
  const page = repeatPage();
  page.helpers.setNativeSidePanel(true);
  await page.helpers.handleRepeatFillClick({ currentTarget: { disabled: false } });
  assert.equal(page.confirms(), 0);
  assert.equal(page.aiCalls('AI_PLAN_REPEAT').length, 0);
  assert.equal(page.clicks(), 0);
});

test('the old advanced repeat path is gone', async () => {
  const page = repeatPage();
  const result = await page.sendPanelMessage({ type: 'RESUME_PANEL_ADVANCED', action: 'repeat' });
  assert.equal(result.ok, false);
  assert.equal(page.legacy.classList.size, 0);
  assert.equal(page.clicks(), 0);
});
