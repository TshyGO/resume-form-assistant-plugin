const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const vm = require('node:vm');
async function panel(capture = { status: 'original', bytesBase64: 'eA==' }) {
  const dom = new JSDOM(fs.readFileSync('sidepanel.html', 'utf8'), { url: 'chrome-extension://own/sidepanel.html', runScripts: 'outside-only' });
  const calls = []; const handlers = {};
  let tab = { id: 1, url: 'https://mail.qq.com/cgi-bin/frame_html?sid=synthetic' };
  let result = { status: 'saved', duplicate: false };
  dom.window.chrome = {
    tabs: { query: async () => [tab], sendMessage: async (id, msg) => { calls.push({ target: 'page', id, msg }); return typeof capture === 'function' ? capture() : capture; },
      onActivated: { addListener: fn => { handlers.activate = fn; } }, onUpdated: { addListener: fn => { handlers.update = fn; } } },
    runtime: { sendMessage: async msg => { calls.push({ target: 'desktop', msg }); return msg.type === 'DESKTOP_CANDIDATES_FOR'
      ? { status: 'ok', exact: [], sameCompany: [{ applicationId: 'app', company: '某公司', title: '产品经理' }] } : typeof result === 'function' ? result() : result; } }
  };
  for (const file of ['webmail.js', 'sidepanel-mail.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext());
  const flush = () => new Promise(resolve => setImmediate(resolve)); await flush();
  return { calls, get: id => dom.window.document.getElementById(id), flush,
    async change(next) { tab = next; handlers.activate(); await flush(); }, result: value => { result = value; }, close: () => dom.window.close() };
}
test('opening a mailbox side panel reads URL metadata only; save button starts capture', async () => {
  const p = await panel(); assert.equal(p.get('mail-save').hidden, false); assert.equal(p.calls.length, 0);
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.calls[0].msg.type, 'WEBMAIL_CAPTURE');
  assert.equal(p.calls[1].msg.type, 'DESKTOP_SAVE_MAIL'); assert.equal(p.calls[1].msg.kind, 'eml');
  assert.match(p.get('mail-save-status').textContent, /已保存完整邮件/);
});
test('fallback requires a second explicit click and cancellation does not write', async () => {
  const p = await panel({ status: 'excerpt_offer', excerpt: { subject: '邀请', from: 'HR', sentTime: '昨天', body: '正文' } });
  p.get('mail-save-button').click(); await p.flush();
  assert.equal(p.get('mail-excerpt-offer').hidden, false); assert.equal(p.calls.length, 1);
  assert.equal(p.get('mail-save-label').textContent, '重试取得原件');
  p.get('mail-excerpt-cancel').click(); await p.flush(); assert.equal(p.calls.length, 1);
  assert.equal(p.get('mail-save-label').textContent, '暂不关联并保存');
  p.get('mail-save-button').click(); await p.flush(); p.get('mail-excerpt-accept').click(); await p.flush();
  const writes = p.calls.filter(c => c.target === 'desktop'); assert.equal(writes.length, 1); assert.equal(writes[0].msg.kind, 'excerpt');
  assert.match(p.get('mail-save-status').textContent, /未保存邮件原件及附件/);
});
test('changing tabs during original retrieval prevents the write', async () => {
  let resolve;
  const p = await panel(() => new Promise(r => { resolve = r; }));
  p.get('mail-save-button').click(); await p.flush();
  await p.change({ id: 2, url: 'https://mail.qq.com/' });
  resolve({ status: 'original', bytesBase64: 'eA==' }); await p.flush();
  assert.equal(p.calls.filter(c => c.target === 'desktop').length, 0); assert.match(p.get('mail-save-status').textContent, /邮件已切换/);
});
test('changing tabs clears a proposed excerpt so it cannot be saved accidentally', async () => {
  const p = await panel({ status: 'excerpt_offer', excerpt: { subject: '邀请', from: 'HR', sentTime: '', body: '正文' } });
  p.get('mail-save-button').click(); await p.flush();
  await p.change({ id: 2, url: 'https://example.test/' });
  assert.equal(p.get('mail-save').hidden, false);
  assert.equal(p.get('mail-save-button').disabled, true);
  assert.match(p.get('mail-context-hint').textContent, /支持 QQ、163、126/);
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.calls.filter(c => c.target === 'desktop').length, 0);
});
test('user can select an application and repeated save clicks create one transfer', async () => {
  const p = await panel(); p.get('mail-company').value = '某公司'; p.get('mail-find-application').click(); await p.flush();
  p.get('mail-application').querySelector('input[value="app"]').click();
  p.get('mail-save-button').click(); p.get('mail-save-button').click(); await p.flush();
  const writes = p.calls.filter(c => c.msg.type === 'DESKTOP_SAVE_MAIL');
  assert.equal(writes.length, 1); assert.equal(writes[0].msg.applicationId, 'app');
});
test('desktop failure is never presented as a saved email', async () => {
  const p = await panel(); p.result({ status: 'archive_changed' }); p.get('mail-save-button').click(); await p.flush();
  assert.match(p.get('mail-save-status').textContent, /档案已恢复或切换/); assert.doesNotMatch(p.get('mail-save-status').textContent, /已保存完整邮件/);
});
test('a detected but unreadable mail does not tell the user to open a mail again', async () => {
  const p = await panel({ status: 'unrecognized_mail' });
  p.get('mail-save-button').click(); await p.flush();
  assert.match(p.get('mail-save-status').textContent, /检测到邮件标题/);
  assert.doesNotMatch(p.get('mail-save-status').textContent, /请先在邮箱里打开/);
  assert.equal(p.calls.filter(c => c.target === 'desktop').length, 0);
});

test('QQ, 163 and 126 excerpt proposals survive desktop failures and retry without recapture', async t => {
  for (const url of ['https://mail.qq.com/', 'https://mail.163.com/', 'https://mail.126.com/']) {
    for (const failure of [{status:'unavailable'}, () => {throw new Error('desktop disconnected');}]) {
      const p = await panel({status:'excerpt_offer', excerpt:{subject:'Synthetic',from:'HR',sentTime:'',body:'Body'}}); t.after(p.close);
      await p.change({id:1,url});
      p.get('mail-save-button').click(); await p.flush();
      p.result(failure);
      p.get('mail-excerpt-accept').click(); await p.flush();
      assert.equal(p.get('mail-excerpt-offer').hidden, false);
      assert.match(p.get('mail-save-status').textContent, /再次点击「保存网页摘录」重试/);
      assert.doesNotMatch(p.get('mail-save-status').textContent, /重新读取/);
      p.result({status:'saved'});
      p.get('mail-excerpt-accept').click(); await p.flush();
      assert.equal(p.calls.filter(c=>c.msg.type==='WEBMAIL_CAPTURE').length,1);
      assert.equal(p.calls.filter(c=>c.msg.type==='DESKTOP_SAVE_MAIL').length,2);
      assert.equal(p.get('mail-excerpt-offer').hidden,true);
      assert.match(p.get('mail-save-status').textContent,/已保存网页摘录/);
    }
  }
});
test('archive changes clear unbound excerpt proposals rather than offering a retry against the old archive', async t => {
  const p = await panel({status:'excerpt_offer',excerpt:{subject:'Synthetic',body:'Body'}}); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  p.result({status:'archive_changed'});
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.get('mail-excerpt-offer').hidden,true);
  assert.match(p.get('mail-save-status').textContent,/档案已恢复或切换/);
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.calls.filter(c=>c.msg.type==='DESKTOP_SAVE_MAIL').length,1);
});
test('a desktop failure after changing tabs cannot revive the previous non-Gmail excerpt', async t => {
  const p = await panel({status:'excerpt_offer',excerpt:{subject:'Synthetic',body:'Body'}}); t.after(p.close);
  p.get('mail-save-button').click(); await p.flush();
  let fail;
  p.result(()=>new Promise((_,reject)=>{fail=reject;}));
  p.get('mail-excerpt-accept').click(); await p.flush();
  await p.change({id:2,url:'https://mail.163.com/'});
  fail(new Error('desktop disconnected')); await p.flush();
  assert.equal(p.get('mail-excerpt-offer').hidden,true);
  p.get('mail-excerpt-accept').click(); await p.flush();
  assert.equal(p.calls.filter(c=>c.msg.type==='DESKTOP_SAVE_MAIL').length,1);
});
