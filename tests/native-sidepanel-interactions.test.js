// #174: the native side panel's field rows — three fixed actions, selected state and
// the visual hierarchy. Page-side composition itself is covered in fill-highlight.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Compose = require('../sidepanel-compose.js');
const root = path.join(__dirname, '..');
const TEMPLATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NAME = `${TEMPLATE}:0:0`;
const SCHOOL = `${TEMPLATE}:0:1`;
const data = () => ({
  templates: [{ id: TEMPLATE, name: '桌面模板', fieldCount: 2 }],
  activeTemplate: { id: TEMPLATE, name: '桌面模板', groups: [{ name: '基本信息', fields: [{ key: '姓名', value: '测试用户' }, { key: '学校', value: '大学乙' }] }] },
  profile: { values: {}, family: [], custom: [] }, profileRevision: 1
});

function element() {
  const listeners = {};
  return {
    listeners, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, listener) { listeners[type] = listener; },
    querySelectorAll() { return []; },
    querySelector() { return { textContent: '' }; }
  };
}

// The panel renders rows with innerHTML. This container reads them back into row objects
// (chip id, its three buttons in order, selected class, aria-pressed) so the real render and
// the real applyTargetState run against something with the same shape as the DOM.
function rowContainer() {
  const container = element();
  let renderedFrom = null;
  let rows = [];
  const parse = (html) => html.split('<div class="field-row ').slice(1).map((segment) => {
    const buttons = [...segment.matchAll(/<button [^>]*data-action="(\w+)"[^>]*?(disabled)?>([^<]*)<\/button>/g)]
      .map((match) => ({ dataset: { action: match[1] }, label: match[3], disabled: Boolean(match[2]) }));
    const fill = { pressed: null, setAttribute(name, value) { if (name === 'aria-pressed') this.pressed = value; } };
    const classes = new Set();
    return {
      dataset: { chipId: segment.match(/data-chip-id="([^"]+)"/)[1] }, buttons, fill, classes,
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      querySelector: () => fill,
      querySelectorAll: () => buttons
    };
  });
  container.querySelectorAll = (selector) => {
    if (selector !== '.field-row') return [];
    if (renderedFrom !== container.innerHTML) { renderedFrom = container.innerHTML; rows = parse(renderedFrom); }
    return rows;
  };
  return container;
}

async function panel({ target = { ok: true, targetAvailable: false } } = {}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, id === 'quick-fields' || id === 'field-groups' ? rowContainer() : element());
    return elements.get(id);
  };
  const calls = [];
  const copied = [];
  const runtimeListeners = [];
  const state = { tabId: 9, target, field: { ok: true, message: '已添加到网页输入框。' }, targetResponder: null };
  let poll;
  const chrome = {
    runtime: {
      id: 'diagjmploldedipjdenmecmjokckelkl',
      onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
      sendMessage: async (message) => {
        calls.push(message);
        return message.type === 'DESKTOP_RESUME_READ' ? { status: 'ok', data: data() } : { status: 'ok' };
      }
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: state.tabId }],
      sendMessage: async (id, message) => {
        calls.push(JSON.parse(JSON.stringify({ tabId: id, ...message })));
        if (message.type === 'RESUME_PANEL_STATUS') return { ready: true };
        if (message.type === 'RESUME_PANEL_TARGET') return state.targetResponder ? state.targetResponder() : state.target;
        if (message.type === 'RESUME_PANEL_FIELD') return state.field;
        return { ok: true };
      },
      create: async () => {},
      onActivated: { addListener(listener) { state.activated = listener; } },
      onUpdated: { addListener() {} }
    }
  };
  const documentStub = {
    hidden: false, getElementById: get, querySelectorAll: () => [],
    querySelector: () => ({ click() {}, open: false }), addEventListener() {}
  };
  const context = vm.createContext({
    document: documentStub, chrome,
    navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
    self: { ResumeProProfile: require('../profile-fields.js'), ResumeProResumeData: require('../resume-data.js'), ResumeProCompose: Compose },
    setTimeout: () => 1, clearTimeout() {}, setInterval: (listener) => { poll = listener; }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sidepanel.js'), 'utf8'), context);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await tick();
  await poll();
  await tick();
  const rows = () => [...get('quick-fields').querySelectorAll('.field-row'), ...get('field-groups').querySelectorAll('.field-row')];
  const row = (container, chipId) => get(container).querySelectorAll('.field-row').find((item) => item.dataset.chipId === chipId);
  const buttonState = (item) => Object.fromEntries(item.buttons.map((button) => [button.dataset.action, !button.disabled]));
  return { get, calls, copied, state, poll: async () => { await poll(); await tick(); }, tick, rows, row, buttonState, runtimeListeners, chrome,
    click: async (container, chipId, action) => {
      const item = row(container, chipId);
      const button = action ? item.buttons.find((candidate) => candidate.dataset.action === action) : { dataset: { chipId }, disabled: false };
      const target = { closest: (selector) => selector === 'button[data-chip-id]' ? { dataset: { chipId, ...(action ? { action } : {}) }, disabled: button.disabled } : null };
      await get(container).listeners.click({ target });
      await tick();
    } };
}

const composable = (extra = {}) => ({ ok: true, targetAvailable: true, composable: true, empty: false, selectedChipIds: [], actions: {}, ...extra });
const allow = (add, replace, remove) => ({ add, replace, remove });

test('every field row, quick or grouped, always has the same three fixed buttons and no copy button', async () => {
  const ui = await panel();
  assert.equal(ui.rows().length, 3, 'one quick row (the preferred 姓名) and two grouped rows');
  for (const item of ui.rows()) {
    assert.deepEqual(item.buttons.map((button) => button.dataset.action), ['add', 'replace', 'remove']);
    assert.deepEqual(item.buttons.map((button) => button.label), ['添加', '替换', '删除']);
  }
  for (const id of ['quick-fields', 'field-groups']) {
    const html = ui.get(id).innerHTML;
    assert.ok(!html.includes('复制'), 'no copy button');
    assert.ok(!html.includes('field-row__copy'));
    assert.ok(!html.includes('quick-row'), 'quick fields use the same row as grouped ones');
  }
});

test('with no web target all three buttons are present but disabled, and nothing is selected', async () => {
  const ui = await panel({ target: { ok: true, targetAvailable: false } });
  for (const item of ui.rows()) {
    assert.deepEqual(ui.buttonState(item), { add: false, replace: false, remove: false });
    assert.equal(item.classes.has('is-in-field'), false);
    assert.equal(item.fill.pressed, 'false');
  }
});

test('a target that cannot compose keeps every button disabled even if it claims actions', async () => {
  const ui = await panel({ target: { ok: true, targetAvailable: true, composable: false, selectedChipIds: [NAME], actions: { [NAME]: allow(true, true, true) } } });
  for (const item of ui.rows()) {
    assert.deepEqual(ui.buttonState(item), { add: false, replace: false, remove: false });
    assert.equal(item.classes.has('is-in-field'), false);
  }
});

test('an empty box enables only add; a filled one follows the page per field', async () => {
  const ui = await panel({ target: composable({ empty: true, actions: { [NAME]: allow(true, false, false), [SCHOOL]: allow(true, false, false) } }) });
  for (const item of ui.rows()) assert.deepEqual(ui.buttonState(item), { add: true, replace: false, remove: false });

  ui.state.target = composable({ selectedChipIds: [NAME], actions: { [NAME]: allow(false, true, true), [SCHOOL]: allow(true, true, false) } });
  await ui.poll();
  assert.deepEqual(ui.buttonState(ui.row('field-groups', NAME)), { add: false, replace: true, remove: true });
  assert.deepEqual(ui.buttonState(ui.row('field-groups', SCHOOL)), { add: true, replace: true, remove: false });
  assert.deepEqual(ui.buttonState(ui.row('quick-fields', NAME)), { add: false, replace: true, remove: true }, 'a quick row behaves like its grouped twin');
});

test('selected rows follow the page: A, then A+B, then only A, then none', async () => {
  const ui = await panel({ target: composable({ selectedChipIds: [NAME] }) });
  const selected = () => ui.rows().filter((item) => item.classes.has('is-in-field')).map((item) => item.dataset.chipId);
  assert.deepEqual(selected(), [NAME, NAME], 'the quick row and grouped row of the field');
  assert.equal(ui.row('field-groups', NAME).fill.pressed, 'true');
  assert.equal(ui.row('field-groups', SCHOOL).fill.pressed, 'false');

  ui.state.target = composable({ selectedChipIds: [NAME, SCHOOL] });
  await ui.poll();
  assert.deepEqual(selected().sort(), [NAME, NAME, SCHOOL].sort());

  ui.state.target = composable({ selectedChipIds: [NAME] });
  await ui.poll();
  assert.equal(ui.row('field-groups', SCHOOL).classes.has('is-in-field'), false, 'removing B releases only B');
  assert.equal(ui.row('field-groups', NAME).classes.has('is-in-field'), true);

  ui.state.target = { ok: true, targetAvailable: false };
  await ui.poll();
  assert.deepEqual(selected(), [], 'no valid target clears every selection');
});

test('an add button sends the operation with the panel’s own value and never copies', async () => {
  const ui = await panel({ target: composable({ empty: true, actions: { [NAME]: allow(true, false, false) } }) });
  ui.calls.length = 0;
  await ui.click('field-groups', NAME, 'add');
  const sent = ui.calls.find((call) => call.type === 'RESUME_PANEL_FIELD');
  assert.equal(sent.mode, 'add');
  assert.equal(sent.chipId, NAME);
  assert.equal(sent.value, '测试用户');
  assert.deepEqual(sent.chips.map((chip) => Object.keys(chip).sort()), [['chipId', 'value'], ['chipId', 'value']]);
  assert.deepEqual(ui.copied, []);
  assert.match(ui.get('panel-toast').textContent, /已添加/);
  const after = ui.calls.slice(ui.calls.indexOf(sent) + 1);
  assert.ok(after.some((call) => call.type === 'RESUME_PANEL_TARGET'), 'state is recalculated once the operation finished');
});

test('replace and remove are sent as their own modes', async () => {
  const ui = await panel({ target: composable({ selectedChipIds: [NAME], actions: { [NAME]: allow(false, true, true) } }) });
  await ui.click('quick-fields', NAME, 'replace');
  await ui.click('quick-fields', NAME, 'remove');
  const modes = ui.calls.filter((call) => call.type === 'RESUME_PANEL_FIELD').map((call) => call.mode);
  assert.deepEqual(modes, ['replace', 'remove']);
});

test('a refused operation is reported as a failure and is not turned into a copy', async () => {
  const ui = await panel({ target: composable({ actions: { [NAME]: allow(true, true, false) } }) });
  ui.state.field = { ok: false, error: '网页输入框已包含这个字段。' };
  await ui.click('field-groups', NAME, 'add');
  assert.equal(ui.get('panel-toast').textContent, '网页输入框已包含这个字段。');
  assert.deepEqual(ui.copied, []);
});

test('a disabled button never reaches the page', async () => {
  const ui = await panel({ target: composable({ actions: { [NAME]: allow(false, true, true) } }) });
  ui.calls.length = 0;
  await ui.click('field-groups', NAME, 'add');
  assert.equal(ui.calls.some((call) => call.type === 'RESUME_PANEL_FIELD'), false);
});

test('the row body is the quick path: the page decides, and asking for a button is not a copy', async () => {
  const ui = await panel({ target: composable({ empty: true, actions: { [NAME]: allow(true, false, false) } }) });
  await ui.click('quick-fields', NAME);
  assert.equal(ui.calls.filter((call) => call.type === 'RESUME_PANEL_FIELD').at(-1).mode, 'fill');
  ui.state.field = { ok: false, needsChoice: true, message: '网页输入框已有内容，请点击「添加」或「替换」。' };
  await ui.click('field-groups', SCHOOL);
  assert.match(ui.get('panel-toast').textContent, /已有内容/);
  assert.deepEqual(ui.copied, []);
});

test('a non-text control that refuses the quick fill still gets the honest copy fallback', async () => {
  const ui = await panel({ target: { ok: true, targetAvailable: true, composable: false } });
  ui.state.field = { ok: false, needsCopy: true, message: '网页控件已有内容；请先核对，再粘贴复制的字段。' };
  await ui.click('quick-fields', NAME);
  assert.deepEqual(ui.copied, ['测试用户']);
  assert.match(ui.get('panel-toast').textContent, /字段内容已复制/);
});

test('the panel asks with chip ids and its own values only, never page text', async () => {
  const ui = await panel();
  const asked = ui.calls.filter((call) => call.type === 'RESUME_PANEL_TARGET').at(-1);
  assert.deepEqual(Object.keys(asked).sort(), ['chips', 'tabId', 'type']);
  assert.deepEqual(asked.chips, [{ chipId: NAME, value: '测试用户' }, { chipId: SCHOOL, value: '大学乙' }]);
});

test('a target-changed notice from the current tab refreshes the state; others are ignored', async () => {
  const ui = await panel({ target: composable({ selectedChipIds: [] }) });
  const listener = ui.runtimeListeners[0];
  const asked = () => ui.calls.filter((call) => call.type === 'RESUME_PANEL_TARGET').length;
  const before = asked();
  ui.state.target = composable({ selectedChipIds: [NAME] });
  listener({ type: 'RESUME_TARGET_CHANGED' }, { id: 'someone-else', tab: { id: 9 } });
  listener({ type: 'RESUME_TARGET_CHANGED' }, { id: ui.chrome.runtime.id, tab: { id: 77 } });
  await ui.tick();
  assert.equal(asked(), before, 'a notice from another extension or tab does nothing');
  listener({ type: 'RESUME_TARGET_CHANGED' }, { id: ui.chrome.runtime.id, tab: { id: 9 } });
  await ui.tick();
  assert.equal(asked(), before + 1);
  assert.equal(ui.row('field-groups', NAME).classes.has('is-in-field'), true, 'selection updated without waiting for the poll');
});

test('switching web pages drops the previous page’s selection at once', async () => {
  const ui = await panel({ target: composable({ selectedChipIds: [NAME], actions: { [NAME]: allow(false, true, true) } }) });
  assert.equal(ui.row('field-groups', NAME).classes.has('is-in-field'), true);
  ui.state.target = { ok: true, targetAvailable: false };
  ui.state.tabId = 10;
  await ui.state.activated();
  await ui.tick();
  for (const item of ui.rows()) {
    assert.equal(item.classes.has('is-in-field'), false);
    assert.deepEqual(ui.buttonState(item), { add: false, replace: false, remove: false });
  }
});

test('a slow, outdated answer cannot overwrite a newer one', async () => {
  const ui = await panel({ target: composable() });
  const slow = composable({ selectedChipIds: [NAME] });
  let releaseSlow;
  ui.state.targetResponder = () => new Promise((resolve) => { releaseSlow = () => resolve(slow); });
  ui.runtimeListeners[0]({ type: 'RESUME_TARGET_CHANGED' }, { id: ui.chrome.runtime.id, tab: { id: 9 } });
  await ui.tick();
  ui.state.targetResponder = async () => composable({ selectedChipIds: [SCHOOL] });
  ui.runtimeListeners[0]({ type: 'RESUME_TARGET_CHANGED' }, { id: ui.chrome.runtime.id, tab: { id: 9 } });
  await ui.tick();
  releaseSlow();
  await ui.tick();
  assert.equal(ui.row('field-groups', SCHOOL).classes.has('is-in-field'), true);
  assert.equal(ui.row('field-groups', NAME).classes.has('is-in-field'), false);
});

test('the panel keeps only the documented fields of a page answer', () => {
  const state = Compose.normalizeTargetState({
    ok: true, targetAvailable: true, composable: true, empty: false, selectedChipIds: ['a', 7, ''],
    actions: { a: { add: 'yes', replace: true, remove: 1, text: 'PAGE-TEXT' } },
    value: 'PAGE-TEXT', text: 'PAGE-TEXT'
  });
  assert.deepEqual(Object.keys(state).sort(), ['actions', 'composable', 'empty', 'selectedChipIds', 'targetAvailable']);
  assert.deepEqual([...state.selectedChipIds], ['a']);
  assert.deepEqual(state.actions.get('a'), { add: false, replace: true, remove: false });
  assert.ok(!JSON.stringify([...state.actions]).includes('PAGE-TEXT'));
  assert.equal(Compose.normalizeTargetState({ ok: false, error: 'x' }).targetAvailable, false);
  assert.equal(Compose.normalizeTargetState(undefined).composable, false);
});

test('rendered rows escape field text and keep the same structure for any value', () => {
  const html = Compose.renderRow({ chipId: 'x:"1"', key: '<b>键</b>', value: '值&"\'' }, 'group');
  assert.ok(!html.includes('<b>键'));
  assert.match(html, /data-chip-id="x:&quot;1&quot;"/);
  assert.equal((html.match(/data-action="/g) || []).length, 3);
  assert.ok((html.match(/ disabled>/g) || []).length === 3, 'buttons render disabled until the page says otherwise');
});

test('the side panel loads the compose module before its own script', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.indexOf('sidepanel-compose.js') >= 0);
  assert.ok(scripts.indexOf('sidepanel-compose.js') < scripts.indexOf('sidepanel.js'));
  assert.ok(!html.includes('无法写入时可复制'));
});

// ---- visual hierarchy -------------------------------------------------------------

function styleRules() {
  const css = fs.readFileSync(path.join(root, 'sidepanel.css'), 'utf8');
  const rules = new Map();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = Object.fromEntries(match[2].split(';').map((item) => item.split(/:(.*)/s).map((part) => part?.trim())).filter(([name, value]) => name && value));
    for (const selector of match[1].split(',').map((item) => item.trim())) {
      rules.set(selector, { ...(rules.get(selector) || {}), ...declarations });
    }
  }
  const vars = rules.get(':root');
  const resolve = (value) => String(value || '').replace(/var\((--[\w-]+)\)/g, (_, name) => vars[name]);
  return { rules, resolve, rule: (selector) => rules.get(selector) || {} };
}

function luminance(hex) {
  const channels = hex.replace('#', '').match(/../g).map((part) => parseInt(part, 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('group titles are tinted and bold, while the expanded body stays white', () => {
  const { rule, resolve } = styleRules();
  const title = rule('.field-group summary');
  const body = rule('.field-group__body');
  assert.equal(resolve(title.background), '#e9f3f0');
  assert.equal(resolve(body.background), '#fff');
  assert.notEqual(resolve(title.background), resolve(body.background));
  assert.ok(Number(title['font-weight']) >= 700);
  assert.ok(parseInt(title['font-size']) > parseInt(rule('.field-group small')['font-size']) || rule('.field-group small').color, 'the count is secondary text');
  assert.notEqual(rule('.field-group small').color, undefined);
});

test('child fields are indented and carry a guide line', () => {
  const { rule } = styleRules();
  const child = rule('.field-group__body .field-row');
  assert.ok(parseInt(child['padding-left']) > parseInt(rule('.field-row')['padding'].split(' ')[3]), 'indented past a plain row');
  assert.notEqual(child['border-left-color'], undefined);
  assert.notEqual(child['border-left-color'], 'transparent');
});

test('the expand arrow rotates when the group is open', () => {
  const { rule } = styleRules();
  assert.equal(rule('.field-group__chevron').display, 'inline-block');
  assert.ok(rule('.field-group__chevron').transition);
  assert.equal(rule('.field-group[open] .field-group__chevron').transform, 'rotate(90deg)');
});

test('a field already in the box is deeper than hover and keeps readable text', () => {
  const { rule, resolve } = styleRules();
  const hover = resolve(rule('.field-row:hover').background);
  const selected = resolve(rule('.field-row.is-in-field').background);
  const selectedHover = resolve(rule('.field-row.is-in-field:hover').background);
  assert.notEqual(selected, hover);
  assert.ok(luminance(selected) < luminance(hover), 'darker than hover');
  assert.ok(luminance(selectedHover) < luminance(selected), 'and still responds to hover');
  const vars = rule(':root');
  assert.ok(contrast(vars['--ink'], selected) >= 7, 'field name');
  assert.ok(contrast(vars['--ink'], selectedHover) >= 7);
  assert.ok(contrast(rule('.field-row.is-in-field .row-value').color, selectedHover) >= 4.5, 'field value');
  assert.equal(resolve(rule('.field-row.is-in-field')['border-left-color']), vars['--accent'], 'a non-colour cue as well');
});

test('the three action buttons take a fixed column that cannot shift or overflow', () => {
  const { rule } = styleRules();
  const actions = rule('.field-row__actions');
  assert.equal(actions.display, 'grid');
  assert.match(actions['grid-template-columns'], /repeat\(3, \d+px\)/);
  assert.equal(actions.flex, 'none');
  assert.ok(rule('.field-row__fill')['min-width'] === '0', 'the field text shrinks first');
  assert.notEqual(rule('.field-row__action:disabled').color, rule('.field-row__action').color, 'disabled looks disabled');
  assert.equal(rule('.field-row__action:disabled').cursor, 'not-allowed');
});
