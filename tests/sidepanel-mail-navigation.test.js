const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const read = name => fs.readFileSync(name, 'utf8');
const emptyStore = { templates: [], activeTemplate: null, profile: { values: {}, family: [], custom: [] }, profileRevision: 1 };
async function panel({ url = 'https://mail.163.com/js6/main.jsp?sid=synthetic', desktop = { status: 'ok', data: emptyStore }, capture = { status: 'original', bytesBase64: 'eA==' }, query = { status: 'ok', exact: [{ applicationId: 'app', company: '示例公司', title: '前端工程师' }], sameCompany: [] } } = {}) {
  const dom = new JSDOM(read('sidepanel.html'), { url: 'chrome-extension://own/sidepanel.html', runScripts: 'outside-only' });
  const win = dom.window, doc = win.document;
  win.setInterval = () => 0;
  const handlers = { activate: [], update: [] };
  let tab = { id: 1, url };
  let store = desktop;
  const calls = [];
  win.chrome = {
    runtime: { id: 'own', getURL: file => `chrome-extension://own/${file}`, getManifest: () => ({ version: 'test' }),
      sendMessage: async message => {
        calls.push({ target: 'desktop', ...message });
        if (message.type === 'DESKTOP_RESUME_READ') return store;
        if (message.type === 'DESKTOP_SAVE_MAIL') return { status: 'saved' };
        if (message.type === 'DESKTOP_CANDIDATES_FOR') return typeof query === 'function' ? query(message) : query;
        return { status: 'ok' };
      } },
    tabs: { query: async () => [tab], sendMessage: async (id, message) => {
      calls.push({ target: 'page', id, ...message });
      if (message.type === 'WEBMAIL_CAPTURE') return capture?.status === 'excerpt_offer' ? {target:'synthetic-target',...capture} : capture;
      if (message.type === 'WEBMAIL_CHECK' || message.type === 'WEBMAIL_VALIDATE') return {status:'current'};
      if (message.type === 'WEBMAIL_DISCARD') return {status:'discarded'};
      return { ready: true, ok: true, targetAvailable: false };
    }, onActivated: { addListener: fn => handlers.activate.push(fn) }, onUpdated: { addListener: fn => handlers.update.push(fn) } },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } }
  };
  for (const file of ['profile-fields.js', 'resume-data.js', 'sidepanel-compose.js', 'webmail.js', 'sidepanel-mail.js', 'sidepanel.js']) vm.runInContext(read(file), dom.getInternalVMContext());
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  return { dom, doc, get: id => doc.getElementById(id), calls, flush,
    async change(next) { tab = next; handlers.activate.forEach(fn => fn()); await flush(); },
    async pageComplete() { handlers.update.forEach(fn => fn(tab.id, { status: 'complete' })); await flush(); },
    desktop(value) { store = value; }, close() { win.close(); } };
}
test('fixed third mail tab keeps one-click fill primary and never auto-selects for a mailbox', async t => {
  const p = await panel(); t.after(() => p.close());
  assert.deepEqual([...p.doc.querySelectorAll('[role=tab]')].map(n => n.dataset.tab), ['fill', 'fields', 'mail']);
  assert.equal(p.get('tab-fill').getAttribute('aria-selected'), 'true');
  assert.equal(p.get('mail-view').hidden, true);
  assert.equal(p.get('fill-button').closest('[role=tabpanel]').id, 'fill-view');
  assert.equal(p.get('mail-save').closest('[role=tabpanel]').id, 'mail-view');
  assert.equal(p.get('mail-save-button').classList.contains('fill-button'), false);
  assert.equal(p.calls.some(c => c.type === 'WEBMAIL_CAPTURE'), false);
  p.get('tab-mail').click(); await p.flush();
  assert.equal(p.get('mail-view').hidden, false);
  assert.equal(p.get('fill-view').hidden, true);
  assert.equal(p.get('desktop-connection').hidden, true, 'saving needs no resume template');
  assert.equal(p.get('open-manager').textContent, '打开桌面');
  p.get('open-manager').click(); await p.flush();
  assert.ok(p.calls.some(c => c.type === 'DESKTOP_OPEN_VIEW' && c.view === 'home'));
  assert.equal(p.calls.some(c => c.type === 'WEBMAIL_CAPTURE'), false, 'view switches and opening desktop never read mail');
  p.get('tab-fill').click();
  assert.equal(p.get('desktop-connection').hidden, false, 'fill still explains missing resume data');
  await p.change({ id: 2, url: 'https://wx.mail.qq.com/home/index?sid=synthetic' });
  assert.equal(p.get('tab-fill').getAttribute('aria-selected'), 'true');
});
test('tablist keyboard order cycles through all three panels with one tab stop', async t => {
  const p = await panel(); t.after(() => p.close());
  p.get('tab-fill').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(p.doc.activeElement, p.get('tab-mail'));
  assert.equal(p.get('mail-view').hidden, false);
  assert.equal(p.doc.querySelectorAll('.dock-tabs button[tabindex="0"]').length, 1);
  p.get('tab-mail').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(p.doc.activeElement, p.get('tab-fill'));
  p.get('tab-fill').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(p.doc.activeElement, p.get('tab-mail'));
  p.get('tab-mail').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.equal(p.doc.activeElement, p.get('tab-fill'));
});
test('unsupported pages keep the tab visible, explain how to use mail, and cannot capture or search', async t => {
  const p = await panel({ url: 'https://jobs.example.test/apply' }); t.after(() => p.close());
  p.get('tab-mail').click();
  assert.equal(p.get('mail-view').hidden, false);
  for (const id of ['mail-save-button', 'mail-find-application', 'mail-company', 'mail-application']) assert.equal(p.get(id).disabled, true);
  assert.match(p.get('mail-context-hint').textContent, /支持 QQ、163、126/);
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.calls.some(c => c.type === 'WEBMAIL_CAPTURE' || c.type === 'DESKTOP_CANDIDATES_FOR'), false);
  await p.change({ id: 2, url: 'https://mail.163.com/js6/main.jsp?sid=synthetic' });
  assert.equal(p.get('tab-mail').getAttribute('aria-selected'), 'true', 'page updates do not jump between sections');
  assert.equal(p.get('mail-save-button').disabled, false);
  assert.equal(p.get('mail-context-title').textContent, '163 邮箱');
  assert.equal(p.get('mail-context-domain').textContent, 'mail.163.com');
  assert.equal(p.get('mail-view').textContent.includes('sid=synthetic'), false);
});
test('switching sections preserves an explicit excerpt offer and optional application selection', async t => {
  const p = await panel({ capture: { status: 'excerpt_offer', excerpt: { subject: '测试通知', from: 'HR', sentTime: '', body: '正文' } } }); t.after(() => p.close());
  p.get('tab-mail').click();
  assert.equal(p.get('mail-association').tagName, 'SECTION');
  assert.equal(p.get('mail-association').querySelector('summary'), null);
  p.get('mail-association').open = true;
  p.get('mail-company').value = '示例公司';
  p.get('mail-find-application').click(); await p.flush();
  p.get('mail-application').querySelector('input[value="app"]').click();
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.get('mail-excerpt-offer').hidden, false);
  p.get('tab-fields').click(); p.get('tab-mail').click(); await p.flush();
  assert.equal(p.get('mail-excerpt-offer').hidden, false);
  assert.equal(p.get('mail-company').value, '示例公司');
  assert.equal(p.get('mail-application').querySelector('input:checked').value, 'app');
  assert.equal(p.calls.filter(c => c.type === 'WEBMAIL_CAPTURE').length, 1);
  assert.equal(p.calls.some(c => c.type === 'DESKTOP_SAVE_MAIL'), false);
  p.get('mail-excerpt-accept').click(); await p.flush();
  const saves = p.calls.filter(c => c.type === 'DESKTOP_SAVE_MAIL');
  assert.equal(saves.length, 1); assert.equal(saves[0].applicationId, 'app');
  assert.equal(p.get('mail-save-status').dataset.tone, 'ok');
});
test('mail connection warning offers recovery without resume or AI prerequisites', async t => {
  const p = await panel({ desktop: { status: 'unavailable' } }); t.after(() => p.close());
  p.get('tab-mail').click();
  assert.equal(p.get('desktop-connection').hidden, false);
  assert.match(p.get('desktop-connection-text').textContent, /打开桌面/);
  assert.doesNotMatch(p.get('desktop-connection-text').textContent, /简历|模板|AI/);
});
test('Enter immediately reveals company and role choices, but never selects or saves one automatically', async t => {
  const first = { applicationId: 'first', company: '星河科技', title: '前端工程师' };
  const second = { applicationId: 'second', company: '星河科技', title: '测试工程师' };
  const p = await panel({ query: { status: 'ok', exact: [first], sameCompany: [first, second] } }); t.after(() => p.close());
  p.get('tab-mail').click(); p.get('mail-association').open = true;
  p.get('mail-company').value = '星河科技';
  p.get('mail-company').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
  await p.flush();
  assert.equal(p.calls.filter(c => c.type === 'DESKTOP_CANDIDATES_FOR').length, 1);
  assert.match(p.get('mail-application-status').textContent, /找到 2 条申请/);
  assert.match(p.get('mail-application').textContent, /星河科技/);
  assert.match(p.get('mail-application').textContent, /前端工程师/);
  assert.match(p.get('mail-application').textContent, /测试工程师/);
  assert.equal(p.get('mail-application').querySelectorAll('input[type=radio]').length, 3);
  assert.equal(p.get('mail-application').querySelector('input:checked').value, '');
  assert.equal(p.calls.some(c => c.type === 'DESKTOP_SAVE_MAIL' || c.type === 'WEBMAIL_CAPTURE'), false);
  p.get('mail-application').querySelector('input[value="first"]').click();
  assert.match(p.get('mail-destination').textContent, /将关联到：星河科技 · 前端工程师/);
  assert.equal(p.get('mail-association-state').textContent, '已选择');
  p.get('mail-association').open = false;
  assert.match(p.get('mail-destination').textContent, /星河科技 · 前端工程师/);
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.calls.find(c => c.type === 'DESKTOP_SAVE_MAIL').applicationId, 'first');
});
test('IME confirmation and repeated Enter while a lookup is pending cannot issue extra lookups', async t => {
  let finish;
  const p = await panel({ query: () => new Promise(resolve => { finish = resolve; }) }); t.after(() => p.close());
  p.get('mail-company').value = '星河科技';
  p.get('mail-company').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  await p.flush(); assert.equal(p.calls.some(c => c.type === 'DESKTOP_CANDIDATES_FOR'), false);
  const enter = () => p.get('mail-company').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
  enter(); enter(); await p.flush();
  assert.equal(p.calls.filter(c => c.type === 'DESKTOP_CANDIDATES_FOR').length, 1);
  assert.match(p.get('mail-application-status').textContent, /正在查找/);
  finish({ status: 'ok', exact: [], sameCompany: [] }); await p.flush();
  assert.match(p.get('mail-application-status').textContent, /未找到/);
  assert.equal(p.get('mail-find-application').disabled, false);
});
test('changing company text or choosing not to associate clears the visible selection and the saved target', async t => {
  const p = await panel(); t.after(() => p.close());
  p.get('mail-company').value = '示例公司'; p.get('mail-find-application').click(); await p.flush();
  p.get('mail-application').querySelector('input[value="app"]').click();
  p.get('mail-application').querySelector('input[value=""]').click();
  assert.match(p.get('mail-destination').textContent, /当前不关联/);
  p.get('mail-application').querySelector('input[value="app"]').click();
  p.get('mail-company').value = '另一家公司'; p.get('mail-company').dispatchEvent(new p.dom.window.Event('input'));
  assert.equal(p.get('mail-application').querySelectorAll('input').length, 1);
  assert.match(p.get('mail-application-status').textContent, /公司名称已更改/);
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.calls.find(c => c.type === 'DESKTOP_SAVE_MAIL').applicationId, null);
});
test('query failure is shown beside search, and a retry can reveal results without reading mail', async t => {
  let failed = true;
  const p = await panel({ query: () => {
    if (failed) throw new Error('offline');
    return { status: 'ok', exact: [], sameCompany: [{ applicationId: 'app', company: '星河科技', title: '<img src=x onerror=alert(1)>' }] };
  } }); t.after(() => p.close());
  p.get('mail-company').value = '星河科技'; p.get('mail-find-application').click(); await p.flush();
  assert.equal(p.get('mail-application-status').dataset.tone, 'error');
  assert.match(p.get('mail-application-status').textContent, /无法读取桌面申请/);
  assert.equal(p.get('mail-save-status').hidden, true);
  failed = false; p.get('mail-find-application').click(); await p.flush();
  assert.match(p.get('mail-application-status').textContent, /找到 1 条申请/);
  assert.ok(p.get('mail-application').textContent.includes('<img src=x onerror=alert(1)>'));
  assert.equal(p.get('mail-application').querySelector('img'), null);
  assert.equal(p.calls.some(c => c.type === 'WEBMAIL_CAPTURE'), false);
});
test('late lookup results cannot populate the application list on another browser page', async t => {
  let finish;
  const p = await panel({ query: () => new Promise(resolve => { finish = resolve; }) }); t.after(() => p.close());
  p.get('mail-company').value = '星河科技'; p.get('mail-find-application').click(); await p.flush();
  await p.change({ id: 2, url: 'https://mail.126.com/js6/main.jsp?sid=synthetic' });
  finish({ status: 'ok', exact: [], sameCompany: [{ applicationId: 'old', company: '星河科技', title: '旧页面结果' }] }); await p.flush();
  assert.equal(p.get('mail-company').value, '');
  assert.equal(p.get('mail-application').querySelectorAll('input').length, 1);
  assert.ok(!p.get('mail-application').textContent.includes('旧页面结果'));
  assert.match(p.get('mail-destination').textContent, /当前不关联/);
});
test('excerpt confirmation uses the currently visible application selection', async t => {
  const p = await panel({ capture: { status: 'excerpt_offer', excerpt: { subject: '测试通知', from: 'HR', sentTime: '', body: '正文' } } }); t.after(() => p.close());
  p.get('mail-save-button').click(); await p.flush();
  p.get('mail-company').value = '示例公司'; p.get('mail-find-application').click(); await p.flush();
  p.get('mail-application').querySelector('input[value="app"]').click();
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.calls.find(c => c.type === 'DESKTOP_SAVE_MAIL').applicationId, 'app');
});
test('a same-address page-complete notification does not discard an in-flight lookup', async t => {
  let finish;
  const p = await panel({ query: () => new Promise(resolve => { finish = resolve; }) }); t.after(() => p.close());
  p.get('mail-company').value = '星河科技'; p.get('mail-find-application').click(); await p.flush();
  await p.pageComplete();
  finish({ status: 'ok', exact: [], sameCompany: [{ applicationId: 'app', company: '星河科技', title: '前端工程师' }] }); await p.flush();
  assert.match(p.get('mail-application-status').textContent, /找到 1 条申请/);
  assert.match(p.get('mail-application').textContent, /前端工程师/);
});
test('association is always visible, jobs precede skip, and the same card states the save action', async t => {
  const p = await panel(); t.after(() => p.close());
  p.get('tab-mail').click();
  assert.equal(p.get('mail-association').tagName, 'SECTION');
  assert.equal(p.get('mail-association').querySelector('summary'), null);
  assert.equal(p.get('mail-save-label').textContent, '暂不关联并保存');
  assert.equal(p.get('mail-save-button').closest('.card'), p.get('mail-association').closest('.card'));
  assert.ok(p.get('mail-save-button').closest('.view-scroll'));
  p.get('mail-company').value = '示例公司'; p.get('mail-find-application').click(); await p.flush();
  assert.deepEqual([...p.get('mail-application').querySelectorAll('input')].map(input => input.value), ['app', '']);
  p.get('mail-application').querySelector('input[value="app"]').click();
  assert.equal(p.get('mail-save-label').textContent, '保存并关联');
  p.get('mail-application').querySelector('input[value=""]').click();
  assert.equal(p.get('mail-save-label').textContent, '暂不关联并保存');
});
test('search completion restores keyboard focus without stealing it after switching to fill', async t => {
  let finish;
  const p = await panel({ query: () => new Promise(resolve => { finish = resolve; }) }); t.after(() => p.close());
  p.get('tab-mail').click(); p.get('mail-company').value = '星河科技'; p.get('mail-company').focus();
  const enter = () => p.get('mail-company').dispatchEvent(new p.dom.window.KeyboardEvent('keydown', {key:'Enter'}));
  enter(); p.get('mail-company').blur();
  finish({status:'ok',exact:[],sameCompany:[]}); await p.flush();
  assert.equal(p.doc.activeElement, p.get('mail-company'));
  enter(); p.get('tab-fill').focus(); p.get('tab-fill').click();
  finish({status:'ok',exact:[],sameCompany:[]}); await p.flush();
  assert.equal(p.doc.activeElement, p.get('tab-fill'));
});
