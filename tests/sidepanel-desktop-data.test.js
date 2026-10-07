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

async function harness(initial = { status: 'ok', data: data() }, { legacy = null } = {}) {
  let legacyState = legacy;
  let storageListener = null;
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const documentEvents = {};
  const tabEvents = {};
  const calls = [];
  const copied = [];
  let response = initial;
  let updateResult = { status: 'ok' };
  let pageResponse = { ready: true, ok: true, message: '已填入' };
  let poll;
  const profileAdd = element();
  profileAdd.dataset.offer = 'profileAdd';
  const document = {
    hidden: false,
    getElementById: get,
    querySelectorAll: selector => selector === '[data-offer]' ? [profileAdd] : [],
    querySelector: () => ({ click() {}, open: false }),
    addEventListener(type, listener) { documentEvents[type] = listener; }
  };
  const chrome = {
    runtime: {
      id: 'diagjmploldedipjdenmecmjokckelkl',
      sendMessage: async message => {
        calls.push(message);
        if (message.type === 'DESKTOP_RESUME_READ') return response;
        if (message.type === 'DESKTOP_RESUME_UPDATE') return updateResult;
        if (message.type === 'DESKTOP_OPEN_VIEW') return { status: 'ok' };
        return {};
      }
    },
    storage: {
      local: { get: async () => ({ legacyImport: legacyState }) },
      onChanged: { addListener(listener) { storageListener = listener; } }
    },
    tabs: {
      query: async () => [{ id: 9 }],
      sendMessage: async (id, message) => { calls.push({ tabId: id, ...message }); return typeof pageResponse === 'function' ? pageResponse(message) : pageResponse; },
      create: async options => { calls.push({ createdTab: options.url }); },
      onActivated: { addListener(listener) { tabEvents.activated = listener; } },
      onUpdated: { addListener(listener) { tabEvents.updated = listener; } }
    }
  };
  const context = vm.createContext({
    document, chrome, navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
    self: { ResumeProProfile: require('../profile-fields.js'), ResumeProResumeData: require('../resume-data.js'), ResumeProCompose: require('../sidepanel-compose.js') },
    setTimeout: () => 1, clearTimeout() {}, setInterval: listener => { poll = listener; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, profileAdd, calls, copied, document, documentEvents, tabEvents,
    setResponse: value => { response = value; }, setUpdateResult: value => { updateResult = value; },
    setPageResponse: value => { pageResponse = value; }, poll: () => poll(), tick: () => new Promise(resolve => setImmediate(resolve)),
    setLegacy: value => { legacyState = value; storageListener?.({ legacyImport: { newValue: value } }, 'local'); } };
}

test('initial native side panel reads desktop summary and active fields', async () => {
  const ui = await harness();
  assert.equal(ui.calls[0].type, 'DESKTOP_RESUME_READ');
  assert.match(ui.get('template-select').innerHTML, /桌面模板 · 2 个字段/);
  assert.match(ui.get('field-groups').innerHTML, /测试用户/);
  assert.equal(ui.get('fill-button').disabled, false);
  assert.equal(ui.get('desktop-connection').hidden, true);
  assert.equal(ui.get('quick-fields').innerHTML, '', 'the fill view no longer repeats common fields');
});

test('native side panel hides a secret-looking value under an ordinary field name', async () => {
  const payload = data();
  payload.activeTemplate.groups[0].fields = [
    { key: '备注', value: '密码：synthetic-secret' },
    { key: '学校', value: '大学乙' }
  ];
  const ui = await harness({ status: 'ok', data: payload });
  assert.ok(!ui.get('field-groups').innerHTML.includes('synthetic-secret'));
  assert.ok(ui.get('field-groups').innerHTML.includes('大学乙'));
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

test('an open side panel picks up a profile field saved in the desktop', async () => {
  const ui = await harness();
  const updated = data();
  updated.profile.custom = [{ key: '自定义地点', value: '示例城市' }];
  updated.profileRevision += 1;
  ui.setResponse({ status: 'ok', data: updated });

  assert.doesNotMatch(ui.get('field-groups').innerHTML, /自定义地点/);
  for (let i = 0; i < 4; i += 1) {
    ui.poll();
    await ui.tick();
  }

  assert.match(ui.get('field-groups').innerHTML, /自定义地点/);
  assert.match(ui.get('field-groups').innerHTML, /示例城市/);
  assert.ok(ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length >= 2);
});

test('a failed periodic reread keeps visible fields until an explicit connection check', async () => {
  const ui = await harness();
  ui.setResponse({ status: 'unavailable' });
  for (let i = 0; i < 4; i += 1) {
    ui.poll();
    await ui.tick();
  }

  assert.match(ui.get('field-groups').innerHTML, /测试用户/);
  assert.equal(ui.get('desktop-connection').hidden, true);
  ui.documentEvents.visibilitychange();
  await ui.tick();
  assert.doesNotMatch(ui.get('field-groups').innerHTML, /测试用户/);
  assert.equal(ui.get('desktop-connection').hidden, false);
});

test('a desktop reread does not re-enable AI while the page is busy', async () => {
  const ui = await harness();
  ui.setPageResponse({ ready: true, busy: true, phase: 'AI 匹配中' });
  ui.poll();
  await ui.tick();
  assert.equal(ui.get('fill-button').disabled, true);
  ui.documentEvents.visibilitychange();
  await ui.tick();
  assert.equal(ui.get('fill-button').disabled, true);
});

test('template switch writes desktop then rereads, and field action carries snapshot value', async () => {
  const ui = await harness();
  ui.get('template-select').value = TEMPLATE;
  await ui.get('template-select').listeners.change();
  assert.ok(ui.calls.some(item => item.type === 'DESKTOP_RESUME_UPDATE' && item.op === 'setActiveTemplate' && item.templateId === TEMPLATE));
  assert.ok(ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length >= 2);
  await ui.get('field-groups').listeners.click({ target: { closest: selector => selector === 'button[data-chip-id]' ? { dataset: { chipId: `${TEMPLATE}:0:0` } } : null } });
  assert.ok(ui.calls.some(item => item.type === 'RESUME_PANEL_FIELD' && item.value === '测试用户'));
});

test('a template removed on desktop is reported and the native panel rereads', async () => {
  const ui = await harness();
  ui.setUpdateResult({ status: 'missing_template' });
  ui.get('template-select').value = TEMPLATE;
  await ui.get('template-select').listeners.change();
  assert.match(ui.get('panel-toast').textContent, /已经删掉/);
  assert.ok(ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length >= 2);
});

test('saving to my information sends the ticked items, rereads the desktop, and does not force the desktop open', async () => {
  const ui = await harness();
  const offer = (result = null) => ({ epoch: 'e1', version: 1, saving: false, summary: '可保存到我的信息：已填 1 项，待补 0 项',
    filled: [{ id: '兴趣爱好', key: '兴趣爱好', value: '摄影', completes: false, jobSpecific: false, defaultSelected: true }],
    pending: [], conflicts: [], notes: [], same: 0, hidden: 0, result });
  // 页面把结果留在快照里，直到用户点「知道了」：保存之后的状态轮询看到的也是它。
  let result = null;
  ui.setPageResponse(message => {
    if (message.type === 'RESUME_PANEL_OFFER') {
      result = { kind: 'success', text: '已保存 1 项，下次填写可用。', hint: '', details: [], saved: 1 };
      return { ok: true, saved: 1, profileOffer: offer(result) };
    }
    return { ready: true, profileOffer: offer(result) };
  });
  await ui.tick();
  await ui.poll();
  await ui.tick();
  assert.equal(ui.get('profile-offer').hidden, false);
  assert.match(ui.get('profile-offer-groups').innerHTML, /兴趣爱好/);
  assert.equal(ui.get('profile-offer-save').textContent, '保存 1 项到我的信息');
  const reads = () => ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length;
  const before = reads();

  await ui.profileAdd.listeners.click();

  const sent = ui.calls.find(item => item.type === 'RESUME_PANEL_OFFER' && item.action === 'profileAdd');
  assert.deepEqual(JSON.parse(JSON.stringify(sent.selected)), [{ id: '兴趣爱好', key: '兴趣爱好', kind: 'filled' }]);
  assert.equal(sent.version, 1);
  assert.equal(reads(), before + 1, 'the panel follows the desktop after a confirmed save');
  assert.equal(ui.calls.some(item => item.type === 'DESKTOP_OPEN_VIEW'), false);
  assert.match(ui.get('profile-offer-result').innerHTML, /已保存 1 项，下次填写可用/);
  assert.equal(ui.get('profile-offer-view').hidden, false);
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
  assert.ok(missing.calls.some(item => item.createdTab === 'https://19991107.xyz/tools/wangshen-kuaitian/download/'));
  const unpaired = await harness({ status: 'not_paired' });
  await unpaired.get('desktop-connection-action').listeners.click();
  assert.deepEqual(unpaired.copied, ['diagjmploldedipjdenmecmjokckelkl']);
});

test('an unavailable desktop offers an explicit open rather than another background probe', async () => {
  const ui = await harness({ status: 'unavailable' });
  assert.equal(ui.get('desktop-connection-action').textContent, '打开桌面');
  ui.calls.length = 0;
  await ui.get('desktop-connection-action').listeners.click();
  assert.equal(ui.calls[0].type, 'DESKTOP_OPEN_VIEW');
  assert.equal(ui.calls[0].view, 'home');
  assert.ok(ui.calls.some(call => call.type === 'DESKTOP_RESUME_READ'));
});

test('a desktop not-configured response exposes the AI settings action', async () => {
  const ui = await harness();
  ui.setPageResponse({ ready: true, status: '请查看 AI 设置。', statusKind: 'error', openView: 'settings-ai' });
  ui.poll();
  await ui.tick();
  assert.equal(ui.get('desktop-connection').hidden, false);
  assert.equal(ui.get('desktop-connection-action').dataset.kind, 'settings-ai');
  await ui.get('desktop-connection-action').listeners.click();
  assert.ok(ui.calls.some(item => item.type === 'DESKTOP_OPEN_VIEW' && item.view === 'settings-ai'));
});

test('a job recognition running in the page shows in the panel with a cancel button', async () => {
  const ui = await harness();
  assert.equal(ui.get('job-assist').hidden, true, 'nothing is shown until the page reports a recognition');
  ui.setPageResponse({ ready: true, jobAssist: { fragments: 3 } });
  ui.poll();
  await ui.tick();
  assert.equal(ui.get('job-assist').hidden, false);
  assert.equal(ui.get('job-assist-text').textContent, '正在用桌面的 AI 识别岗位，发送的 3 段页面文字列在网页上。');

  ui.setPageResponse({ ready: true, ok: true, jobAssist: null });
  await ui.get('job-assist-cancel').listeners.click();
  const cancel = ui.calls.find(item => item.type === 'RESUME_PANEL_ADVANCED');
  assert.deepEqual({ tabId: cancel.tabId, action: cancel.action }, { tabId: 9, action: 'cancel-assist' });
  assert.equal(ui.get('panel-toast').textContent, '已取消识别，请在网页表单里手动补全。');
  assert.equal(ui.get('job-assist').hidden, true);
});

test('the side panel does not access the four old local data keys', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');
  // The only local key the panel may read is the migration state (#130 PR 5).
  const reads = [...source.matchAll(/chrome\.storage\.local\.(\w+)\(([^)]*)\)/g)];
  assert.ok(reads.length > 0);
  for (const [, method, args] of reads) {
    assert.equal(method, 'get');
    assert.equal(args.trim(), '["legacyImport"]');
  }
  assert.doesNotMatch(source, /["'](templates|activeTemplateId|aiConfig|profile)["']/);
});

test('the panel says so while old plugin data is on its way to the desktop', async () => {
  const ui = await harness(undefined, { legacy: { phase: 'waiting' } });
  await ui.tick();
  assert.equal(ui.get('legacy-hint').hidden, false);
  assert.ok(ui.calls.some(call => call.type === 'DESKTOP_LEGACY_STATUS'), 'opening the panel nudges the migration');
  ui.setLegacy({ phase: 'imported' });
  await ui.tick();
  assert.equal(ui.get('legacy-hint').hidden, true);
  await ui.get('legacy-hint-open').listeners.click();
  assert.ok(ui.calls.some(call => call.type === 'DESKTOP_OPEN_VIEW' && call.view === 'resume'));
});
