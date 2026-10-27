const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const webmail = require('../webmail.js');
const source = fs.readFileSync(require.resolve('../webmail-qq-main.js'), 'utf8');
const RAW = Buffer.from('From: hr@example.test\r\nSubject: Interview\r\nMessage-ID: <modern@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=demo\r\n\r\n--demo\r\nContent-Type: text/plain\r\n\r\nTest\r\n--demo\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--demo--\r\n');
function fixture({ url = 'https://wx.mail.qq.com/home/index?sid=synthetic#/list/1', nativeUrl = '/read/readmail?func=3&mailid=ZL_test&sid=synthetic', throwExport = false } = {}) {
  const dom = new JSDOM('<div class="mail-list-page-reader-body"><div class="mail-detail-subject">Interview</div><div class="mail-detail-basic"><div class="mail-detail-basic-action-bar"><button class="more-btn">更多操作</button></div></div><div class="mail-detail-content">Test</div></div>', { url, runScripts: 'outside-only' });
  const w = dom.window, doc = w.document;
  let opens = 0, menus = 0, exports = 0;
  const originalOpen = () => { opens++; };
  w.open = originalOpen;
  doc.querySelector('.more-btn').addEventListener('click', () => {
    menus++;
    const panel = doc.createElement('div'); panel.className = 'xmail-ui-panel';
    panel.innerHTML = '<div class="xmail-ui-panel-item">导出为 eml 文件</div><div class="xmail-ui-panel-item">删除</div>';
    panel.firstElementChild.addEventListener('click', () => {
      exports++; w.open(nativeUrl, '_blank'); panel.remove();
      if (throwExport) throw new Error('synthetic export failure');
    });
    doc.body.appendChild(panel);
  });
  vm.runInContext(source, dom.getInternalVMContext());
  return { dom, doc, w, originalOpen, counts: () => ({ opens, menus, exports }) };
}
test('QQ modern native export supplies the current mail id without opening a tab or saving a download', async () => {
  const f = fixture(); assert.deepEqual(f.counts(), { opens: 0, menus: 0, exports: 0 });
  const seen = [];
  const result = await webmail.capture(f.doc, async (url, options) => {
    seen.push(new URL(url)); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    return new Response(RAW);
  });
  assert.equal(result.status, 'original'); assert.deepEqual(Buffer.from(result.bytesBase64, 'base64'), RAW);
  assert.equal(seen.length, 1); assert.equal(seen[0].pathname, '/read/readmail');
  assert.equal(seen[0].searchParams.get('func'), '3'); assert.equal(seen[0].searchParams.get('mailid'), 'ZL_test');
  assert.equal(seen[0].searchParams.get('sid'), 'synthetic');
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
  assert.deepEqual(f.counts(), { opens: 0, menus: 1, exports: 1 }); assert.equal(f.w.open, f.originalOpen);
});
for (const [name, nativeUrl] of [
  ['external origin', 'https://evil.test/read/readmail?func=3&mailid=bad&sid=synthetic'],
  ['wrong session', '/read/readmail?func=3&mailid=bad&sid=other'],
  ['display-text endpoint', '/read/readmail?func=5&mailid=bad&sid=synthetic'],
  ['unrelated action', '/mgr/mailmgr?func=3&mailid=bad&sid=synthetic'],
]) test(`QQ modern export refuses ${name}`, async () => {
  const f = fixture({ nativeUrl }); let downloads = 0;
  const result = await webmail.capture(f.doc, async () => { downloads++; return new Response(RAW); });
  assert.equal(result.status, 'excerpt_offer'); assert.equal(downloads, 0); assert.equal(f.w.open, f.originalOpen);
});
test('login/error HTML from the actual new endpoint still needs explicit excerpt confirmation', async () => {
  const f = fixture(); const result = await webmail.capture(f.doc, async () => new Response('<html>Please login</html>'));
  assert.equal(result.status, 'excerpt_offer'); assert.equal(result.bytesBase64, undefined);
});
test('changing the current message during the new export download rejects the result', async () => {
  const f = fixture(); const result = await webmail.capture(f.doc, async () => {
    f.doc.querySelector('.mail-detail-subject').textContent = 'Another message'; return new Response(RAW);
  });
  assert.equal(result.status, 'changed');
});
test('QQ modern content body cannot supply a forged native export menu', async () => {
  const f = fixture();
  const fake = f.doc.createElement('div'); fake.className = 'xmail-ui-panel';
  fake.innerHTML = '<div class="xmail-ui-panel-item">导出为 eml 文件</div>';
  fake.firstElementChild.addEventListener('click', () => { throw new Error('body control was clicked'); });
  f.doc.querySelector('.mail-detail-content').appendChild(fake);
  const result = await webmail.capture(f.doc, async () => new Response(RAW));
  assert.equal(result.status, 'original'); assert.equal(f.counts().exports, 1);
});
test('no private React/store state is traversed and idle installation reads no mail DOM', () => {
  assert.doesNotMatch(source, /__react|memoizedProps|webpackChunk/);
  let listener;
  const context = { window: null, document: { addEventListener(type, fn) { listener = fn; } } };
  context.window = context;
  vm.runInNewContext(source, context); assert.equal(typeof listener, 'function');
});
test('QQ modern hook restores window.open even when the native handler throws', async () => {
  const f = fixture();
  // Replace this fixture's one export handler with a throwing .click implementation.
  f.doc.querySelector('.more-btn').addEventListener('click', () => {
    f.doc.querySelector('.xmail-ui-panel-item').click = () => { throw new Error('synthetic'); };
  });
  const result = await webmail.capture(f.doc, async () => new Response(RAW));
  assert.equal(result.status, 'excerpt_offer'); assert.equal(f.w.open, f.originalOpen);
});
test('two different native mail ids during one export are rejected as ambiguous', async () => {
  const f = fixture();
  f.doc.querySelector('.more-btn').addEventListener('click', () => {
    f.doc.querySelector('.xmail-ui-panel-item').click = () => {
      f.w.open('/read/readmail?func=3&mailid=one&sid=synthetic');
      f.w.open('/read/readmail?func=3&mailid=two&sid=synthetic');
    };
  });
  let fetches = 0;
  const result = await webmail.capture(f.doc, async () => { fetches++; return new Response(RAW); });
  assert.equal(result.status, 'excerpt_offer'); assert.equal(fetches, 0); assert.equal(f.w.open, f.originalOpen);
});
