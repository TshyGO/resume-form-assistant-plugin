const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const webmail = require('../webmail.js');
const transport = require('../gmail-download.js');
const ID = '18abcdef12345678';
const START = `https://mail.google.com/mail/u/0/?view=att&th=${ID}&attid=0&disp=comp&safe=1&zw`;
const FINAL = `https://mail-attachment.googleusercontent.com/attachment/u/0/?view=att&th=${ID}&attid=0&disp=comp&safe=1&zw&saddbat=synthetic`;
const RAW = Buffer.from('From: hr@example.test\r\nTo: applicant@example.test\r\nSubject: Test\r\nMessage-ID: <download@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nOriginal bytes\r\n');
function response(body = RAW, url = FINAL, options) {
  const value = new Response(body, options); Object.defineProperty(value, 'url', { value: url }); return value;
}

test('download context accepts only the observed Google read-only whole-message route', () => {
  assert.equal(transport.requestContext(START.replace('/u/0/', '/u/0')).url, START);
  for (const bad of [START.replace('https:', 'http:'), START.replace('mail.google.com', 'mail.google.com.evil.test'), START.replace('mail.google.com', 'mail.google.com:444'), START.replace('attid=0', 'attid=1'), START+'&act=send', START+'&authuser=1', START+'&th=other', START.replace('view=att', 'view=om'), START.replace(`th=${ID}`, 'th=unknown')]) assert.equal(transport.requestContext(bad), null, bad);
});
test('final response is bound to the original account, mail ID and whole-message mode', () => {
  const context = transport.requestContext(START);
  assert.equal(transport.finalMatches(FINAL, context), true);
  assert.equal(transport.finalMatches(START, context), true);
  for (const bad of [FINAL.replace('/u/0/', '/u/1/'), FINAL.replace(ID, '18abcdef12345679'), FINAL.replace('attid=0', 'attid=0.1'), FINAL.replace('disp=comp','disp=inline'), FINAL.replace('mail-attachment.googleusercontent.com','other.googleusercontent.com'), FINAL.replace('mail-attachment.googleusercontent.com','evil.test'), FINAL+'&act=delete']) assert.equal(transport.finalMatches(bad, context), false, bad);
});
test('CSP child permits only the exact Google origins, including on automatic redirects', () => {
  const doc = new JSDOM(fs.readFileSync('gmail-download.html', 'utf8')).window.document;
  const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  const directive = policy.split(';').map(x=>x.trim()).find(x=>x.startsWith('connect-src '));
  assert.deepEqual(directive.split(/\s+/).slice(1).sort(), ['https://mail.google.com','https://mail.googlemail.com','https://mail-attachment.googleusercontent.com'].sort());
  assert.match(policy, /default-src 'none'/); assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /\*|unsafe-inline|unsafe-eval|data:/);
  assert.deepEqual([...doc.scripts].map(s=>s.getAttribute('src')), ['webmail.js','gmail-download.js']);
});
test('download follows Google-owned delivery redirects and preserves MIME bytes without a Cookie header', async () => {
  let count = 0;
  const got = await transport.fetchOriginal(START, async (url, options) => {
    count++; assert.equal(url, START); assert.equal(options.credentials,'include'); assert.equal(options.redirect,'follow'); assert.equal(options.headers,undefined);
    assert.ok(options.signal instanceof AbortSignal); return response();
  }, webmail);
  assert.equal(count,1); assert.equal(got.status,'original'); assert.deepEqual(Buffer.from(got.bytesBase64,'base64'), RAW);
  assert.doesNotMatch(JSON.stringify(got), /synthetic|saddbat|googleusercontent/);
});
test('unknown final resources are rejected before any response body is read', async () => {
  let read = false;
  const got = await transport.fetchOriginal(START, async () => ({ok:true,url:'https://evil.test/file',get body(){read=true;throw new Error('must not read');}}), webmail);
  assert.equal(got.status,'unavailable'); assert.equal(read,false);
});
test('HTML fragments and server exceptions cannot become originals or disclose raw errors', async () => {
  assert.equal((await transport.fetchOriginal(START,async()=>response('<pre>\nFrom: x\nSubject: y\n\nText</pre>'),webmail)).status,'unavailable');
  const got=await transport.fetchOriginal(START,async()=>{throw new Error('synthetic-private-url');},webmail);
  assert.deepEqual(got,{status:'unavailable'});
});
test('streamed limits and request deadlines terminate the download', async () => {
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(webmail.MAX_BYTES+1));},cancel(){cancelled=true;}});
  assert.equal((await transport.fetchOriginal(START,async()=>response(stream),webmail)).status,'too_large'); assert.equal(cancelled,true);
  const got=await transport.fetchOriginal(START,(_url,options)=>new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('aborted')));}),webmail,1);
  assert.equal(got.status,'unavailable');
});
function bridge(result, settings = {}) {
  const listeners=new Set(), calls=[]; let removed=0, appended=0;
  const frame={hidden:false,src:'',remove(){removed++;},contentWindow:{postMessage(data,origin){
    calls.push({data,origin});
    for(const listener of [...listeners]) {
      listener({source:{},origin,data:{type:'GMAIL_DOWNLOAD_RESULT',id:data.id,...result}});
      listener({source:frame.contentWindow,origin:'https://evil.test',data:{type:'GMAIL_DOWNLOAD_RESULT',id:data.id,...result}});
      listener({source:frame.contentWindow,origin,data:{type:'GMAIL_DOWNLOAD_RESULT',id:'wrong',...result}});
      listener({source:frame.contentWindow,origin,data:{type:'GMAIL_DOWNLOAD_RESULT',id:data.id,...result}});
    }
  }}};
  const env={location:{origin:'chrome-extension://own'},crypto:{randomUUID:()=> 'request-id'},chrome:{runtime:{getURL:path=>'chrome-extension://own/'+path}},
    addEventListener(_type,fn){listeners.add(fn);},removeEventListener(_type,fn){listeners.delete(fn);},
    document:{createElement:()=>frame,body:{appendChild(){appended++;if(settings.failAppend)throw new Error('detached');queueMicrotask(()=>frame.onload());}}}};
  return {env,frame,calls,listeners,removed:()=>removed,appended:()=>appended};
}
test('private frame bridge verifies sender/origin/request and releases its frame and listener', async () => {
  const mock=bridge({status:'original',bytesBase64:RAW.toString('base64')});
  const got=await transport.download(START,mock.env);
  assert.equal(got.status,'original'); assert.equal(mock.frame.hidden,true); assert.equal(mock.frame.src,'chrome-extension://own/gmail-download.html');
  assert.equal(mock.calls.length,1); assert.equal(mock.calls[0].origin,'chrome-extension://own');
  assert.equal(mock.removed(),1); assert.equal(mock.listeners.size,0);
});
test('frame failures and invalid packets clean up; untrusted input creates no frame', async () => {
  const detached=bridge({}, {failAppend:true}); assert.equal((await transport.download(START,detached.env)).status,'unavailable'); assert.equal(detached.removed(),1); assert.equal(detached.listeners.size,0);
  const bad=bridge({status:'original'}); assert.equal((await transport.download(START,bad.env)).status,'unavailable'); assert.equal(bad.removed(),1);
  const external=bridge({}); assert.equal((await transport.download('https://evil.test',external.env)).status,'unavailable'); assert.equal(external.appended(),0);
});
test('source resolution rechecks before and after download and only keeps a fallback for explicit confirmation', async () => {
  const source={status:'gmail_source',originals:[START],target:'target',fallback:'excerpt_offer',excerpt:{subject:'test',body:'body'}};
  let calls=0; const checks=[];
  assert.equal((await transport.resolveSource(source,async()=>{calls++;},async()=>false)).status,'changed'); assert.equal(calls,0);
  const got=await transport.resolveSource(source,async()=>({status:'unavailable'}),async consume=>{checks.push(consume);return true;});
  assert.equal(got.status,'excerpt_offer'); assert.deepEqual(checks,[false,false]); assert.equal(got.target,'target');
  let turn=0;
  assert.equal((await transport.resolveSource(source,async()=>({status:'original',bytesBase64:'eA=='}),async()=>++turn===1)).status,'changed');
  const consumed=[];
  const clipped=await transport.resolveSource({...source,fallback:'message_clipped',excerpt:undefined},async()=>({status:'unavailable'}),async consume=>{consumed.push(consume);return true;});
  assert.equal(clipped.status,'message_clipped'); assert.deepEqual(consumed,[false,false,true]); assert.equal(clipped.excerpt,undefined);
  let checksBeforeConsume = 0;
  const changed = await transport.resolveSource({...source,fallback:'message_clipped'},async()=>({status:'unavailable'}),async()=>++checksBeforeConsume < 3);
  assert.equal(changed.status,'changed', 'a switch during final consumption must not show an earlier mail’s error');
});
