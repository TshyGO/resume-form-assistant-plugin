// #189：侧栏上「保存到我的信息」的候选列表——展示、勾选、一次点击保存、失败与重复点击。
// 页面那边怎么读值、怎么写桌面见 profile-save-content.test.js；这里把页面当成给快照、收请求的一方。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  const listeners = {};
  return {
    listeners, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '', className: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, listener) { listeners[type] = listener; },
    querySelectorAll() { return []; },
    querySelector() { return { textContent: '' }; }
  };
}

const store = () => ({
  templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 0
});

async function harness({ desktop = { status: 'ok', data: store() } } = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const calls = [];
  let page = { ready: true };
  let poll;
  const offerButtons = ['profileAdd', 'profileSkip', 'profileDismiss'].map(action => {
    const button = element();
    button.dataset.offer = action;
    elements.set({ profileAdd: 'profile-offer-save', profileSkip: 'profile-offer-skip', profileDismiss: 'profile-offer-dismiss' }[action], button);
    return button;
  });
  const document = {
    hidden: false, activeElement: null, getElementById: get,
    querySelectorAll: selector => selector === '[data-offer]' ? offerButtons : [],
    querySelector: () => ({ click() {}, open: false }),
    addEventListener() {}
  };
  const chrome = {
    runtime: {
      id: 'diagjmploldedipjdenmecmjokckelkl',
      sendMessage: async message => {
        calls.push(message);
        if (message.type === 'DESKTOP_RESUME_READ') return desktop;
        if (message.type === 'DESKTOP_OPEN_VIEW') return { status: 'ok' };
        return {};
      }
    },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    tabs: {
      query: async () => [{ id: 9 }],
      sendMessage: async (id, message) => { calls.push({ tabId: id, ...message }); return typeof page === 'function' ? page(message) : page; },
      create: async () => {},
      onActivated: { addListener() {} }, onUpdated: { addListener() {} }
    }
  };
  const context = vm.createContext({
    document, chrome, navigator: { clipboard: { writeText: async () => {} } },
    self: { ResumeProProfile: require('../profile-fields.js'), ResumeProResumeData: require('../resume-data.js'), ResumeProCompose: require('../sidepanel-compose.js') },
    setTimeout: () => 1, clearTimeout() {}, setInterval: listener => { poll = listener; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8'), context);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  const ui = {
    get, calls, tick, save: offerButtons[0], skip: offerButtons[1], dismiss: offerButtons[2],
    groups: get('profile-offer-groups'),
    setPage: value => { page = value; },
    async refresh() { await tick(); await poll(); await tick(); },
    tick_: tick,
    // 点勾选框 / 分组的「全选」：和浏览器一样先改状态再触发事件。
    toggle(id, checked) {
      return ui.groups.listeners.change({ target: { closest: () => ({ dataset: { profileId: id }, checked }) } });
    },
    toggleGroup(kind) {
      return ui.groups.listeners.click({ target: { closest: () => ({ dataset: { profileGroup: kind } }) } });
    },
    sent: () => calls.filter(item => item.type === 'RESUME_PANEL_OFFER')
  };
  return ui;
}

const offer = (extra = {}) => ({
  epoch: 'e1', version: 1, saving: false, summary: '可保存到我的信息：已填 2 项，待补 1 项',
  filled: [
    { id: '兴趣爱好', key: '兴趣爱好', value: '摄影', completes: false, jobSpecific: false, defaultSelected: true },
    { id: '你为什么想加入', key: '你为什么想加入', value: '热爱', completes: false, jobSpecific: true, defaultSelected: false }
  ],
  pending: [{ id: '期望薪资', key: '期望薪资', unreadable: false, defaultSelected: false }],
  conflicts: [], notes: [], same: 0, hidden: 0, result: null, ...extra
});

test('candidates show names and values; reusable filled items start ticked, job-specific and empty ones do not, and the button counts', async () => {
  const ui = await harness();
  ui.setPage({ ready: true, profileOffer: offer() });
  await ui.refresh();

  const html = ui.groups.innerHTML;
  assert.equal(ui.get('profile-offer').hidden, false);
  assert.equal(ui.get('profile-offer-text').textContent, '可保存到我的信息：已填 2 项，待补 1 项');
  assert.match(html, /兴趣爱好[\s\S]*摄影/);
  assert.match(html, /可能只适用于当前岗位，默认不勾选/);
  assert.match(html, /data-profile-id="兴趣爱好" checked/);
  assert.doesNotMatch(html, /data-profile-id="你为什么想加入" checked/);
  assert.doesNotMatch(html, /data-profile-id="期望薪资" checked/);
  assert.match(html, /待补充（1）/);
  assert.equal(ui.save.textContent, '保存 1 项到我的信息');
  assert.equal(ui.save.disabled, false);

  await ui.toggle('期望薪资', true);
  assert.equal(ui.save.textContent, '保存 2 项到我的信息');
  await ui.toggle('兴趣爱好', false);
  await ui.toggle('期望薪资', false);
  assert.equal(ui.save.textContent, '保存 0 项到我的信息');
  assert.equal(ui.save.disabled, true, 'nothing ticked, nothing to save');
  await ui.toggleGroup('filled');
  assert.equal(ui.save.textContent, '保存 2 项到我的信息');
});

test('what the user ticked survives the status polls, and an item that shows up later follows its default', async () => {
  const ui = await harness();
  ui.setPage({ ready: true, profileOffer: offer() });
  await ui.refresh();
  await ui.toggle('兴趣爱好', false);

  ui.setPage({ ready: true, profileOffer: offer({ filled: [
    ...offer().filled,
    { id: '特长', key: '特长', value: '钢琴', completes: false, jobSpecific: false, defaultSelected: true }
  ] }) });
  await ui.refresh();

  assert.doesNotMatch(ui.groups.innerHTML, /data-profile-id="兴趣爱好" checked/, 'the untick was not undone');
  assert.match(ui.groups.innerHTML, /data-profile-id="特长" checked/);
  assert.equal(ui.save.textContent, '保存 1 项到我的信息');

  // 另一次一键填写给出的是新的候选：旧的勾选不带过去。
  ui.setPage({ ready: true, profileOffer: offer({ version: 2 }) });
  await ui.refresh();
  assert.match(ui.groups.innerHTML, /data-profile-id="兴趣爱好" checked/);
});

test('one click sends exactly the ticked items with what the user saw; a conflict is replaced only when ticked', async () => {
  const ui = await harness();
  const conflict = { id: '特长', key: '特长', value: '绘画', existing: '钢琴', defaultSelected: false };
  ui.setPage(message => message.type === 'RESUME_PANEL_OFFER'
    ? { ok: false, saved: 0, profileOffer: offer({ conflicts: [conflict] }) }
    : { ready: true, profileOffer: offer({ conflicts: [conflict] }) });
  await ui.refresh();
  assert.match(ui.groups.innerHTML, /桌面：钢琴/);
  assert.match(ui.groups.innerHTML, /网页：绘画/);

  await ui.save.listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent()[0].selected)), [{ id: '兴趣爱好', key: '兴趣爱好', kind: 'filled' }]);
  assert.equal(ui.sent()[0].version, 1);

  await ui.toggle('特长', true);
  await ui.toggle('期望薪资', true);
  await ui.save.listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.sent()[1].selected)), [
    { id: '兴趣爱好', key: '兴趣爱好', kind: 'filled' },
    { id: '期望薪资', key: '期望薪资', kind: 'pending' },
    { id: '特长', key: '特长', kind: 'conflict', replaceOf: '钢琴' }
  ]);
});

test('a failed save shows the real reason, keeps every candidate and tick, and can be retried', async () => {
  const ui = await harness();
  const failure = { kind: 'error', text: '没有保存：桌面程序已退出或暂时没有响应。候选还在，连上后再点保存。', hint: '', details: [], saved: 0 };
  let failing = true;
  ui.setPage(message => {
    const body = offer({ result: failing ? failure : null });
    return message.type === 'RESUME_PANEL_OFFER' ? { ok: false, saved: 0, profileOffer: body } : { ready: true, profileOffer: body };
  });
  await ui.refresh();
  await ui.toggle('期望薪资', true);
  const readsBefore = ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length;

  await ui.save.listeners.click();

  assert.match(ui.get('profile-offer-result').innerHTML, /桌面程序已退出或暂时没有响应/);
  assert.doesNotMatch(ui.get('profile-offer-result').innerHTML, /已保存/);
  assert.equal(ui.get('profile-offer-result').className, 'profile-result is-error');
  assert.equal(ui.get('profile-offer-view').hidden, true, 'no "view my info" after a failure');
  assert.equal(ui.get('profile-offer-dismiss').hidden, false);
  assert.match(ui.groups.innerHTML, /data-profile-id="期望薪资" checked/, 'the tick is still there');
  assert.equal(ui.save.disabled, false, 'the user can retry');
  assert.equal(ui.calls.filter(item => item.type === 'DESKTOP_RESUME_READ').length, readsBefore, 'nothing was saved, so no desktop refresh is claimed');

  failing = false;
  await ui.save.listeners.click();
  assert.equal(ui.sent().length, 2);
});

test('while a save is on its way the button is busy and a second click does not send another request', async () => {
  const ui = await harness();
  const saved = { kind: 'success', text: '已保存 1 项，下次填写可用。', hint: '', details: [], saved: 1 };
  const after = () => offer({ filled: [], pending: [], result: saved });
  let release;
  let done = false;
  ui.setPage(message => message.type === 'RESUME_PANEL_OFFER'
    ? new Promise(resolve => { release = () => { done = true; resolve({ ok: true, saved: 1, profileOffer: after() }); }; })
    : { ready: true, profileOffer: done ? after() : offer() });
  await ui.refresh();

  const first = ui.save.listeners.click();
  await ui.tick();
  assert.equal(ui.save.textContent, '正在保存…');
  assert.equal(ui.save.disabled, true);
  await ui.save.listeners.click();
  release();
  await first;

  assert.equal(ui.sent().length, 1);
  assert.match(ui.get('profile-offer-result').innerHTML, /已保存 1 项，下次填写可用/);
  assert.equal(ui.get('profile-offer-view').hidden, false);
  // 候选全部处理完之后，只剩结果和「知道了」，不再有保存按钮。
  assert.equal(ui.save.hidden, true);
});

test('values from the page are escaped before they reach the panel markup', async () => {
  const ui = await harness();
  ui.setPage({ ready: true, profileOffer: offer({ filled: [
    { id: 'x', key: '<b>字段</b>', value: '<img src=x onerror="alert(1)">', completes: false, jobSpecific: false, defaultSelected: true }
  ], pending: [] }) });
  await ui.refresh();
  assert.doesNotMatch(ui.groups.innerHTML, /<img|<b>/);
  assert.match(ui.groups.innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('long values are shortened on screen but not cut in the tooltip', async () => {
  const ui = await harness();
  const value = '很长的内容'.repeat(30);
  ui.setPage({ ready: true, profileOffer: offer({ filled: [{ id: 'x', key: '自我介绍', value, completes: false, jobSpecific: false, defaultSelected: true }], pending: [] }) });
  await ui.refresh();
  assert.match(ui.groups.innerHTML, /…<\/span>/);
  assert.ok(ui.groups.innerHTML.includes(`title="${value}"`));
});

test('the result can be dismissed, the saved items can be opened on the desktop, and an unreadable field says so', async () => {
  const ui = await harness();
  const result = { kind: 'success', text: '已保存 1 项，下次填写可用。', hint: '其中 1 项只存了字段名，可稍后到桌面「我的信息」补充内容。', details: [], saved: 1 };
  let dismissed = false;
  ui.setPage(message => {
    if (message.type === 'RESUME_PANEL_OFFER') { dismissed = true; return { ok: true, profileOffer: null }; }
    return { ready: true, profileOffer: dismissed ? null : offer({ result, pending: [{ id: '语言证书', key: '语言证书', unreadable: true, defaultSelected: false }] }) };
  });
  await ui.refresh();
  assert.match(ui.get('profile-offer-result').innerHTML, /其中 1 项只存了字段名/);
  assert.match(ui.groups.innerHTML, /网页上已有内容但读不准，只保存字段名/);

  await ui.get('profile-offer-view').listeners.click();
  assert.ok(ui.calls.some(item => item.type === 'DESKTOP_OPEN_VIEW' && item.view === 'resume'));

  await ui.dismiss.listeners.click();
  assert.ok(ui.sent().some(item => item.action === 'profileDismiss'));
  assert.equal(ui.get('profile-offer').hidden, true);
});

test('with the desktop not reachable the save button is disabled instead of pretending to work', async () => {
  const ui = await harness({ desktop: { status: 'unavailable' } });
  ui.setPage({ ready: true, profileOffer: offer() });
  await ui.refresh();
  assert.equal(ui.get('profile-offer').hidden, false);
  assert.equal(ui.save.disabled, true);
  assert.equal(ui.calls.some(item => item.type === 'RESUME_PANEL_OFFER'), false);
});
