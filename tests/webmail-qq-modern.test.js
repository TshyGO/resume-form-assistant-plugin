const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const webmail = require('../webmail.js');
const source = fs.readFileSync(require.resolve('../link/qq-export.mjs'), 'utf8');
const RAW = Buffer.from('From: hr@example.test\r\nSubject: Interview\r\nMessage-ID: <modern@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=demo\r\n\r\n--demo\r\nContent-Type: text/plain\r\n\r\nTest\r\n--demo\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--demo--\r\n');
async function fixture({ url = 'https://wx.mail.qq.com/home/index?sid=synthetic#/list/1', nativeUrl = '/read/readmail?func=3&mailid=ZL_test&sid=synthetic', throwExport = false } = {}) {
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
  const {createQQExporter} = await import('../link/qq-export.mjs');
  const sender = {id:'own',url,tab:{id:1},frameId:0,documentId:'doc'};
  const injections = [];
  const api = {runtime:{id:'own'},scripting:{executeScript:async options=>{
    injections.push(options);
    const result = await vm.runInContext(`(${options.func.toString()})(${JSON.stringify(options.args[0])})`,dom.getInternalVMContext());
    return [{frameId:0,documentId:'doc',result}];
  }}};
  const request = createQQExporter(api);
  return { dom, doc, w, api, sender, injections, request, capture:fetcher=>webmail.capture(doc,fetcher,message=>request(message,sender)), originalOpen, counts: () => ({ opens, menus, exports }) };
}
test('QQ modern native export supplies the current mail id without opening a tab or saving a download', async () => {
  const f = await fixture(); assert.deepEqual(f.counts(), { opens: 0, menus: 0, exports: 0 });
  const seen = [];
  const result = await f.capture(async (url, options) => {
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
  const f = await fixture({ nativeUrl }); let downloads = 0;
  const result = await f.capture(async () => { downloads++; return new Response(RAW); });
  assert.equal(result.status, 'excerpt_offer'); assert.equal(downloads, 0); assert.equal(f.w.open, f.originalOpen);
});
test('login/error HTML from the actual new endpoint still needs explicit excerpt confirmation', async () => {
  const f = await fixture(); const result = await f.capture(async () => new Response('<html>Please login</html>'));
  assert.equal(result.status, 'excerpt_offer'); assert.equal(result.bytesBase64, undefined);
});
test('changing the current message during the new export download rejects the result', async () => {
  const f = await fixture(); const result = await f.capture(async () => {
    f.doc.querySelector('.mail-detail-subject').textContent = 'Another message'; return new Response(RAW);
  });
  assert.equal(result.status, 'changed');
});
for (const phase of ['export', 'download']) {
  for (const change of ['route', 'reading-nodes', 'mail-id']) {
    test(`QQ modern rejects identical rendered mail after ${change} changes during ${phase}`, async t => {
      const f = await fixture(); t.after(() => f.dom.window.close());
      const switchMail = () => {
        if (change === 'route') f.w.history.replaceState(null, '', '#/list/2');
        if (change === 'reading-nodes') {
          const body = f.doc.querySelector('.mail-detail-content'); body.replaceWith(body.cloneNode(true));
        }
        if (change === 'mail-id') f.doc.querySelector('.mail-list-page-reader-body').setAttribute('data-mailid', 'different');
      };
      if (phase === 'export') f.doc.querySelector('.more-btn').addEventListener('click', switchMail);
      let fetches = 0;
      const result = await f.capture(async () => {
        fetches++; if (phase === 'download') switchMail(); return new Response(RAW);
      });
      assert.equal(result.status, 'changed');
      assert.equal(fetches, phase === 'export' ? 0 : 1);
      assert.equal(f.w.open, f.originalOpen);
    });
  }
}
test('QQ modern content body cannot supply a forged native export menu', async () => {
  const f = await fixture();
  const fake = f.doc.createElement('div'); fake.className = 'xmail-ui-panel';
  fake.innerHTML = '<div class="xmail-ui-panel-item">导出为 eml 文件</div>';
  fake.firstElementChild.addEventListener('click', () => { throw new Error('body control was clicked'); });
  f.doc.querySelector('.mail-detail-content').appendChild(fake);
  const result = await f.capture(async () => new Response(RAW));
  assert.equal(result.status, 'original'); assert.equal(f.counts().exports, 1);
});
test('no private React/store state or idle page-world listener is installed', () => {
  assert.doesNotMatch(source, /__react|memoizedProps|webpackChunk/);
  assert.doesNotMatch(source, /addEventListener|qq-export-request|qq-export-response/);
  const manifest = JSON.parse(fs.readFileSync('manifest.json','utf8'));
  assert.equal(manifest.content_scripts.some(script=>script.world==='MAIN'),false);
  assert.ok(manifest.permissions.includes('scripting'));
});
test('QQ modern hook restores window.open even when the native handler throws', async () => {
  const f = await fixture();
  // Replace this fixture's one export handler with a throwing .click implementation.
  f.doc.querySelector('.more-btn').addEventListener('click', () => {
    f.doc.querySelector('.xmail-ui-panel-item').click = () => { throw new Error('synthetic'); };
  });
  const result = await f.capture(async () => new Response(RAW));
  assert.equal(result.status, 'excerpt_offer'); assert.equal(f.w.open, f.originalOpen);
});
test('two different native mail ids during one export are rejected as ambiguous', async () => {
  const f = await fixture();
  f.doc.querySelector('.more-btn').addEventListener('click', () => {
    f.doc.querySelector('.xmail-ui-panel-item').click = () => {
      f.w.open('/read/readmail?func=3&mailid=one&sid=synthetic');
      f.w.open('/read/readmail?func=3&mailid=two&sid=synthetic');
    };
  });
  let fetches = 0;
  const result = await f.capture(async () => { fetches++; return new Response(RAW); });
  assert.equal(result.status, 'excerpt_offer'); assert.equal(fetches, 0); assert.equal(f.w.open, f.originalOpen);
});
test('forged DOM export replies cannot decide which original is downloaded', async t=>{
  const f=await fixture();t.after(()=>f.dom.window.close());
  const forge=()=>f.doc.dispatchEvent(new f.w.CustomEvent('resumepro:qq-export-response',{detail:JSON.stringify({nonce:'forged',status:'ok',mailId:'other-mail'})}));
  f.doc.addEventListener('resumepro:qq-export-request',forge);forge();
  f.doc.querySelector('.more-btn').addEventListener('click',forge);
  const ids=[];const result=await f.capture(async url=>{ids.push(new URL(url).searchParams.get('mailid'));return new Response(RAW)});
  assert.equal(result.status,'original');assert.deepEqual(ids,['ZL_test']);
  assert.deepEqual(f.injections[0].target,{tabId:1,documentIds:['doc']});assert.equal(f.injections[0].world,'MAIN');
});
test('browser-mediated export refuses other callers and results from another document',async t=>{
  const f=await fixture();t.after(()=>f.dom.window.close());
  for(const changed of [{id:'other'},{frameId:1},{documentId:''},{url:'https://evil.test/'},{tab:undefined},{url:'chrome-extension://own/sidepanel.html'}]){
    assert.equal((await f.request({stamp:'x'},{...f.sender,...changed})).status,'forbidden');
  }
  assert.equal(f.injections.length,0);
  f.api.scripting.executeScript=async()=>[{frameId:0,documentId:'new-document',result:{status:'ok',mailId:'other'}}];
  assert.equal((await f.capture(async()=>{throw new Error('must not fetch')})).status,'excerpt_offer');
});
test('browser export rejects a changed initial reading snapshot before clicking a native menu',async t=>{
  const f=await fixture();t.after(()=>f.dom.window.close());
  const result=await f.request({stamp:'stale snapshot'},f.sender);
  assert.equal(result.status,'changed');assert.equal(f.counts().menus,0);
});
test('concurrent exports share one document gate and a browser failure releases it',async t=>{
  const f=await fixture();t.after(()=>f.dom.window.close());
  let reject;let injections=0;
  f.api.scripting.executeScript=()=>{injections++;return new Promise((_,fail)=>{reject=fail})};
  const first=f.request({stamp:'x'},f.sender);
  assert.equal((await f.request({stamp:'x'},f.sender)).status,'unavailable');assert.equal(injections,1);
  reject(new Error('document navigated'));assert.equal((await first).status,'unavailable');
  f.api.scripting.executeScript=async()=>[{frameId:0,documentId:'doc',result:{status:'ok',mailId:'valid'}}];
  assert.deepEqual(await f.request({stamp:'x'},f.sender),{status:'ok',mailId:'valid'});
});
