const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TEMPLATE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const data = () => ({
  templates: [{ id: TEMPLATE, name: '桌面模板', fieldCount: 2 }],
  activeTemplate: { id: TEMPLATE, name: '桌面模板', groups: [{ name: '基本信息', fields: [{ key: '姓名', value: '测试用户' }, { key: '登录密码', value: 'synthetic-secret' }] }] },
  profile: { values: {}, family: [], custom: [] }, profileRevision: 2
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

async function harness(initial = { status: 'ok', data: data() }) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const documentEvents = {};
  const tabEvents = {};
  const calls = [];
  const copied = [];
  let response = initial;
  let pageResponse = { ready: true, ok: true, message: '已填入' };
  let poll;
  const document = {
    hidden: false,
    getElementById: get,
    querySelectorAll: () => [],
    querySelector: () => ({ click() {}, open: false }),
    addEventListener(type, listener) { documentEvents[type] = listener; }
  };
  const chrome = {
    runtime: {
      id: 'diagjmploldedipjdenmecmjokckelkl',
      sendMessage: async message => {
        calls.push(message);
        if (message.type === 'DESKTOP_RESUME_READ') return response;
        if (message.type === 'DESKTOP_RESUME_UPDATE') return { status: 'ok' };
        if (message.type === 'DESKTOP_OPEN_VIEW') return { status: 'ok' };
        return {};
      }
    },
    tabs: {
      query: async () => [{ id: 9 }],
      sendMessage: async (id, message) => { calls.push({ tabId: id, ...message }); return pageResponse; },
      create: async options => { calls.push({ createdTab: options.url }); },
      onActivated: { addListener(listener) { tabEvents.activated = listener; } },
      onUpdated: { addListener(listener) { tabEvents.updated = listener; } }
    }
  };
  const context = vm.createContext({
    document, chrome, navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
    self: { ResumeProProfile: require('../profile-fields.js'), ResumeProResumeData: require('../resume-data.js') },
    setTimeout: () => 1, clearTimeout() {}, setInterval: listener => { poll = listener; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, calls, copied, document, documentEvents, tabEvents, setResponse: value => { response = value; }, setPageResponse: value => { pageResponse = value; }, poll: () => poll(), tick: () => new Promise(resolve => setImmediate(resolve)) };
}

test('initial native side panel reads desktop summary and active fields', async () => {
  const ui = await harness();
  assert.equal(ui.calls[0].type, 'DESKTOP_RESUME_READ');
  assert.match(ui.get('template-select').innerHTML, /桌面模板 · 2 个字段/);
  assert.match(ui.get('field-groups').innerHTML, /测试用户/);
  assert.equal(ui.get('fill-button').disabled, false);
  assert.equal(ui.get('desktop-connection').hidden, true);
  assert.ok(!ui.get('quick-fields').innerHTML.includes('synthetic-secret'));
});

test('visibility and tab activation reread; the status poll does not', async () => {
  const ui = await harness();
  const count = () => ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length;
  const before = count();
  await ui.poll();
  assert.equal(count(), before);
  ui.documentEvents.visibilitychange();
  await ui.tick();
  assert.equal(count(), before + 1);
  ui.tabEvents.activated();
  await ui.tick();
  assert.equal(count(), before + 2);
});

test('template switch writes desktop then rereads, and field action carries snapshot value', async () => {
  const ui = await harness();
  ui.get('template-select').value = TEMPLATE;
  await ui.get('template-select').listeners.change();
  assert.ok(ui.calls.some(item => item.type === 'DESKTOP_RESUME_UPDATE' && item.op === 'setActiveTemplate' && item.templateId === TEMPLATE));
  assert.ok(ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length >= 2);
  await ui.get('field-groups').listeners.click({ target: { closest: selector => selector === '[data-chip-id]' ? { dataset: { chipId: `${TEMPLATE}:0:0` } } : null } });
  assert.ok(ui.calls.some(item => item.type === 'RESUME_PANEL_FIELD' && item.value === '测试用户'));
});

test('all desktop downgrade states disable data and show an actionable message', async () => {
  for (const mode of ['not_installed', 'not_paired', 'never_paired', 'incompatible', 'unavailable']) {
    const ui = await harness({ status: mode });
    assert.equal(ui.get('fill-button').disabled, true, mode);
    assert.equal(ui.get('template-select').disabled, true, mode);
    assert.equal(ui.get('desktop-connection').hidden, false, mode);
    assert.ok(ui.get('desktop-connection-text').textContent, mode);
    assert.ok(ui.get('desktop-connection-action').textContent, mode);
  }
  const empty = await harness({ status: 'ok', data: { templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 0 } });
  assert.equal(empty.get('fill-button').disabled, true);
  assert.match(empty.get('desktop-connection-text').textContent, /还没有简历/);
});

test('footer opens desktop, and missing desktop offers the download URL', async () => {
  const ready = await harness();
  await ready.get('open-manager').listeners.click();
  assert.ok(ready.calls.some(item => item.type === 'DESKTOP_OPEN_VIEW' && item.view === 'home'));
  const missing = await harness({ status: 'not_installed' });
  await missing.get('open-manager').listeners.click();
  assert.ok(missing.calls.some(item => item.createdTab?.includes('/releases?')));
  const unpaired = await harness({ status: 'not_paired' });
  await unpaired.get('desktop-connection-action').listeners.click();
  assert.deepEqual(unpaired.copied, ['diagjmploldedipjdenmecmjokckelkl']);
});

test('a desktop not-configured response exposes the AI settings action', async () => {
  const ui = await harness();
  ui.setPageResponse({ ready: true, status: '桌面还没有配置 AI 服务商，或当前服务商没有 Key。', statusKind: 'error' });
  ui.poll();
  await ui.tick();
  assert.equal(ui.get('desktop-connection').hidden, false);
  assert.equal(ui.get('desktop-connection-action').dataset.kind, 'settings-ai');
  await ui.get('desktop-connection-action').listeners.click();
  assert.ok(ui.calls.some(item => item.type === 'DESKTOP_OPEN_VIEW' && item.view === 'settings-ai'));
});

test('the side panel does not access the four old local data keys', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');
  assert.doesNotMatch(source, /chrome\.storage/);
});
