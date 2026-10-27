// #273: the side panel's template field editor, driven through the real sidepanel.html markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fields = require('../template-fields.js');
const profileApi = require('../profile-fields.js');
const { create } = require('../sidepanel-template-editor.js');

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const html = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.html'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };
async function waitFor(predicate, description) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function template(groups = [
  { name: '基本信息', fields: [{ key: '姓名', value: '测试用户' }, { key: '电话', value: '13800000000' }] },
  { name: '教育经历', fields: [{ key: '学校', value: '示例大学' }] }
]) {
  return { id: ID, name: '校招简历', groups };
}

function store(active = template(), { profile, templates } = {}) {
  return {
    templates: templates || [{ id: ID, name: '校招简历', fieldCount: 3 }, { id: OTHER, name: '实习简历', fieldCount: 1 }],
    activeTemplateId: active?.id || '',
    activeTemplate: active,
    profile: profile || { values: {}, family: [], custom: [{ key: '电话', value: '13900000000' }] },
    profileRevision: 1
  };
}

function setup({ answers = [], reloads = [], fieldsApi = fields } = {}) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const sent = [];
  const toasts = [];
  const openStates = [];
  let current = store();
  const editor = create({
    doc, fields: fieldsApi, profileApi,
    send: async message => {
      sent.push(structuredClone(message));
      if (message.type === 'DESKTOP_OPEN_VIEW') return { status: 'ok' };
      return answers.length ? answers.shift() : { status: 'ok' };
    },
    reload: async () => { if (reloads.length) current = reloads.shift(); return current; },
    groupIcon: () => '',
    toast: text => toasts.push(text),
    onOpenChange: open => openStates.push(open)
  });
  const $ = id => doc.getElementById(id);
  const foot = action => doc.querySelector(`#te-foot [data-te-action="${action}"]`);
  const row = key => [...doc.querySelectorAll('.te-row')].find(node => node.querySelector('.te-key').value === key);
  const type = (node, value) => { node.value = value; node.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const choose = (node, value) => { node.value = value; node.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const click = node => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const submit = () => $('te-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, doc, editor, sent, toasts, openStates, $, foot, row, type, choose, click, submit, open: () => editor.open(current), setStore: value => { current = value; } };
}

test('opening names the template, lists fields by category and starts with nothing to save', async () => {
  const ui = setup();
  await ui.open();
  assert.equal(ui.$('template-editor').hidden, false);
  assert.equal(ui.$('te-desc').textContent, '正在编辑「校招简历」');
  assert.match(ui.$('te-form').textContent, /修改只作用于这份模板/);
  const groups = [...ui.doc.querySelectorAll('.te-group')].map(node => node.dataset.category);
  assert.deepEqual(groups, ['基本信息', '教育经历']);
  assert.equal(ui.doc.querySelectorAll('.te-row').length, 3);
  assert.equal(ui.foot('save').disabled, true);
  assert.deepEqual(ui.openStates, [true]);
});

test('edit, recategorize, add into a new category, confirm a delete, then save only this template', async () => {
  const ui = setup();
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), '测试用户乙');
  ui.choose(ui.row('学校').querySelector('.te-category'), '基本信息');
  // 添加字段 with a brand-new category.
  ui.click(ui.$('te-add-toggle'));
  ui.choose(ui.$('te-add-category'), '__new__');
  assert.equal(ui.$('te-add-new-category-row').hidden, false);
  ui.$('te-add-new-category').value = '求职意向';
  ui.$('te-add-key').value = '期望城市';
  ui.$('te-add-value').value = '示例城市';
  ui.click(ui.$('te-add-submit'));
  assert.ok(ui.toasts.at(-1).includes('「求职意向」'));
  // Delete asks first, names the template, and says 我的信息 still has 电话.
  ui.click(ui.row('电话').querySelector('.te-remove'));
  const confirm = ui.row('电话').querySelector('.te-confirm');
  assert.match(confirm.textContent, /从「校招简历」删除「电话」？只影响这份模板/);
  assert.match(confirm.textContent, /「我的信息」里还有同名字段/);
  ui.click(confirm.querySelector('[data-te-remove-confirm]'));
  assert.equal(ui.row('电话'), undefined);
  assert.match(ui.$('te-fallback').textContent, /已删除或改名的「电话」在「我的信息」里仍有同名内容/);
  assert.equal(ui.$('te-fallback').hidden, false);
  // 教育经历 is now empty: it stays visible but is not saved.
  assert.match(ui.$('te-warnings').textContent, /没有字段的分类不会保存：「教育经历」/);

  assert.equal(ui.foot('save').disabled, false);
  ui.submit();
  await settle();
  const update = ui.sent.find(message => message.type === 'DESKTOP_RESUME_UPDATE');
  assert.equal(update.op, 'saveTemplate');
  assert.equal(update.templateId, ID);
  assert.equal(update.baseSha256, await fields.contentSha256(template().groups));
  assert.deepEqual(update.groups, [
    { name: '基本信息', fields: [{ key: '姓名', value: '测试用户乙' }, { key: '学校', value: '示例大学' }] },
    { name: '求职意向', fields: [{ key: '期望城市', value: '示例城市' }] }
  ]);
  assert.equal(ui.$('te-result').hidden, false);
  assert.match(ui.$('te-result-text').textContent, /共 3 个字段。填写、搜索和复制会使用新内容/);
  assert.match(ui.$('te-result').textContent, /之前下载或导入过的 Excel 不会自动更新/);
  assert.match(ui.$('te-result').textContent, /不含「我的信息」/);
  ui.click(ui.$('te-result-export'));
  await settle();
  assert.deepEqual(ui.sent.at(-1), { type: 'DESKTOP_OPEN_VIEW', view: 'resume' });
  ui.click(ui.$('te-result-done'));
  assert.equal(ui.$('template-editor').hidden, true);
});

test('cancel with changes asks first; discarding sends nothing, continuing keeps the draft', async () => {
  const ui = setup();
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-key'), '中文姓名');
  ui.click(ui.foot('cancel'));
  assert.ok(ui.foot('discard'));
  ui.click(ui.foot('resume'));
  assert.equal(ui.row('中文姓名').querySelector('.te-key').value, '中文姓名');
  ui.click(ui.$('te-exit'));
  ui.click(ui.foot('discard'));
  assert.equal(ui.$('template-editor').hidden, true);
  assert.equal(ui.sent.length, 0);
  // Reopening starts from the saved template, not the abandoned draft.
  await ui.open();
  assert.ok(ui.row('姓名'));
  // Without changes, cancel just closes.
  ui.click(ui.foot('cancel'));
  assert.equal(ui.$('template-editor').hidden, true);
});

test('a secret-looking field, an empty name, or deleting everything never reaches the desktop', async () => {
  const ui = setup();
  await ui.open();
  ui.type(ui.row('电话').querySelector('.te-key'), '邮箱密码');
  ui.type(ui.row('姓名').querySelector('.te-key'), ' ');
  ui.submit();
  await settle();
  assert.equal(ui.sent.length, 0);
  assert.equal(ui.$('te-problems').hidden, false);
  const invalid = [...ui.doc.querySelectorAll('[aria-invalid="true"]')];
  assert.equal(invalid.length, 2);
  assert.match(ui.doc.querySelector('.te-row__error').textContent, /不能为空|密码或验证码/);
  // Each delete re-renders the list, so look the next button up afresh.
  while (ui.doc.querySelector('.te-remove')) {
    ui.click(ui.doc.querySelector('.te-remove'));
    ui.click(ui.doc.querySelector('[data-te-remove-confirm]'));
  }
  ui.submit();
  await settle();
  assert.equal(ui.sent.length, 0);
  assert.match(ui.$('te-problems').textContent, /至少要保留一个字段/);
});

test('a failed save keeps every edit and says so', async () => {
  const ui = setup({ answers: [{ status: 'unavailable' }, { status: 'rejected' }, { status: 'ok' }] });
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), '保存失败也不丢');
  ui.submit();
  await settle();
  assert.match(ui.$('te-problems').textContent, /没能保存到桌面.*修改还在/);
  assert.equal(ui.row('姓名').querySelector('.te-value').value, '保存失败也不丢');
  ui.submit();
  await settle();
  assert.match(ui.$('te-problems').textContent, /版本较旧/);
  ui.submit();
  await settle();
  assert.equal(ui.$('te-result').hidden, false);
  assert.equal(ui.sent.filter(message => message.op === 'saveTemplate').every(message => message.groups[0].fields[0].value === '保存失败也不丢'), true);
});

test('a conflict keeps the draft; overwriting is explicit and uses the newest content as its base', async () => {
  const newer = template([{ name: '基本信息', fields: [{ key: '姓名', value: '桌面端改的' }] }]);
  const ui = setup({ answers: [{ status: 'conflict' }, { status: 'ok' }], reloads: [store(newer), store(newer)] });
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), '插件端改的');
  ui.submit();
  await waitFor(() => ui.foot('overwrite'), 'conflict choices');
  assert.equal(ui.$('te-notice').hidden, false);
  assert.match(ui.$('te-notice-text').textContent, /已在别处修改.*没有保存.*你的修改还在/);
  assert.ok(ui.foot('load-latest') && ui.foot('overwrite'));
  assert.equal(ui.row('姓名').querySelector('.te-value').value, '插件端改的');
  ui.click(ui.foot('overwrite'));
  await settle();
  const saves = ui.sent.filter(message => message.op === 'saveTemplate');
  assert.equal(saves.length, 2);
  assert.equal(saves[1].baseSha256, await fields.contentSha256(newer.groups));
  assert.equal(saves[1].groups[0].fields[0].value, '插件端改的');
  assert.equal(ui.$('te-result').hidden, false);
});

test('after a conflict the newest content can be loaded instead, replacing the draft', async () => {
  const newer = template([{ name: '基本信息', fields: [{ key: '姓名', value: '桌面端改的' }] }]);
  const ui = setup({ answers: [{ status: 'conflict' }], reloads: [store(newer)] });
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), '插件端改的');
  ui.submit();
  // The conflict choices appear only after the asynchronous content digest finishes.
  await waitFor(() => ui.foot('load-latest'), 'load latest button');
  ui.click(ui.foot('load-latest'));
  await waitFor(() => ui.toasts.at(-1) === '已载入最新内容。', 'latest content to finish loading');
  assert.equal(ui.row('姓名').querySelector('.te-value').value, '桌面端改的');
  assert.equal(ui.$('te-notice').hidden, true);
  assert.equal(ui.foot('save').disabled, true);
});

test('a template deleted elsewhere cannot be saved, and the editor says so', async () => {
  const ui = setup({ answers: [{ status: 'conflict' }], reloads: [store(null, { templates: [{ id: OTHER, name: '实习简历', fieldCount: 1 }] })] });
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), 'x');
  ui.submit();
  await settle();
  assert.match(ui.$('te-notice-text').textContent, /已在别处删除/);
  assert.equal(ui.foot('overwrite'), null);
  ui.click(ui.foot('discard'));
  assert.equal(ui.$('template-editor').hidden, true);
});

test('while editing, a desktop update or a template switch is announced without touching the draft', async () => {
  const ui = setup();
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), '草稿');
  await ui.editor.observe(store());
  assert.equal(ui.$('te-notice').hidden, true, 'nothing changed elsewhere');
  await ui.editor.observe(store(template([{ name: '基本信息', fields: [{ key: '姓名', value: '桌面端改的' }] }])));
  assert.match(ui.$('te-notice-text').textContent, /刚在别处（例如桌面端）更新过/);
  assert.equal(ui.row('姓名').querySelector('.te-value').value, '草稿');
  const switched = store({ id: OTHER, name: '实习简历', groups: [{ name: '组', fields: [{ key: 'k', value: 'v' }] }] });
  await ui.editor.observe(switched);
  assert.match(ui.$('te-notice-text').textContent, /当前模板已切换为「实习简历」。你仍在编辑「校招简历」/);
});

test('a conflict whose re-read fails keeps editing instead of offering stale choices', async () => {
  // The desktop said "conflict", then the side panel could not read the newest data.
  const ui = setup({ answers: [{ status: 'conflict' }, { status: 'ok' }], reloads: [null, store()] });
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), '插件端改的');
  ui.submit();
  await settle();
  assert.match(ui.$('te-problems').textContent, /暂时读不到最新内容。修改还在/);
  assert.equal(ui.foot('load-latest'), null, 'no "load newest" built from the pre-edit data');
  assert.equal(ui.foot('overwrite'), null);
  assert.equal(ui.$('te-notice').hidden, true);
  assert.equal(ui.row('姓名').querySelector('.te-value').value, '插件端改的');
  // Trying again later works normally.
  ui.submit();
  await settle();
  assert.equal(ui.$('te-result').hidden, false);
});

test('loading the newest content replaces draft and base together, or not at all', async () => {
  const newer = template([{ name: '基本信息', fields: [{ key: '姓名', value: '桌面端改的' }] }]);
  let failDigest = false;
  const flaky = { ...fields, contentSha256: async groups => { if (failDigest) throw new Error('no digest'); return fields.contentSha256(groups); } };
  const ui = setup({ answers: [{ status: 'conflict' }], reloads: [store(newer)], fieldsApi: flaky });
  await ui.open();
  ui.type(ui.row('姓名').querySelector('.te-value'), '插件端改的');
  ui.submit();
  await waitFor(() => ui.foot('load-latest'), 'load latest button');
  failDigest = true;
  ui.click(ui.foot('load-latest'));
  await settle();
  assert.equal(ui.toasts.at(-1), '无法载入最新内容，修改还在。');
  assert.equal(ui.row('姓名').querySelector('.te-value').value, '插件端改的', 'the draft is untouched');
  assert.ok(ui.foot('load-latest'), 'still choosing');
  // Closing the panel while the digest is computed leaves nothing half-applied.
  failDigest = false;
  ui.click(ui.foot('load-latest'));
  ui.editor.close();
  await settle();
  assert.equal(ui.editor.state.draft, null);
  assert.equal(ui.$('template-editor').hidden, true);
});
