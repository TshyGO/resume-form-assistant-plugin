const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const webmail = require('../webmail.js');
const RAW = Buffer.from('From: hr@example.test\r\nSubject: Invitation\r\nMessage-ID: <synthetic@example.test>\r\nContent-Type: multipart/mixed; boundary=test\r\n\r\n--test\r\nContent-Type: text/plain\r\n\r\nHello\r\n--test\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="guide.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--test--\r\n');
// Structural details transcribed from the user's DevTools screenshots. Values are synthetic.
function reader({ host = 'mail.163.com', prefix = '101', mid = 'demo', session = true } = {}) {
  const origin = `https://${host}`;
  const doc = new JSDOM(`<div class="frame-main-cont-body nui-scroll"><div class="tR0" role="list">
    <div id="${prefix}_dvReadHeadInfo" class="sI0 nui-bg-light"><div class="rB0">
    <h1 id="${prefix}_h1Subject" class="nui-fIBlock py0" title="邮件标题" role="listitem">面试邀请</h1>
    </div><span class="nui-addr-email" email="hr@example.test">HR</span></div>
    <iframe></iframe></div></div>`, { url: `${origin}/js6/main.jsp${session ? '?sid=synthetic' : ''}` }).window.document;
  const frame = doc.querySelector('iframe');
  const url = `${origin}/js6/read/readhtml3.jsp?mid=${mid}&userType=browser&moduleName=read`;
  frame.src = url;
  const content = new JSDOM('<template id="contentTemplate">ignored</template><div id="content" class="netease_mail_readhtml netease_mail_readhtml_webmail"><div data-nds-name="main"><div>测试同学，你好</div><div>明天面试</div></div></div>', { url }).window.document;
  Object.defineProperty(frame, 'contentDocument', { configurable: true, value: content });
  return { doc, frame, content };
}
for (const host of ['mail.163.com', 'mail.126.com']) test(`${host} js6 heading + readhtml3 iframe retrieves exact MIME using main-page session`, async () => {
  const { doc } = reader({ host });
  let requests = 0;
  const result = await webmail.capture(doc, async (url, options) => {
    requests++;
    const u = new URL(url);
    assert.equal(u.origin, `https://${host}`);
    assert.equal(u.pathname, '/js6/read/readdata.jsp');
    assert.equal(u.searchParams.get('mid'), 'demo');
    assert.equal(u.searchParams.get('sid'), 'synthetic');
    assert.equal(u.searchParams.get('mode'), 'download');
    assert.equal(u.searchParams.has('part'), false);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    return new Response(RAW);
  });
  assert.equal(requests, 1);
  assert.equal(result.status, 'original');
  assert.deepEqual(Buffer.from(result.bytesBase64, 'base64'), RAW);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});
test('js6 excerpt reads only the selected content, and waits for separate confirmation', async () => {
  const { doc } = reader({ session: false });
  let called = false;
  const result = await webmail.capture(doc, () => { called = true; });
  assert.equal(called, false);
  assert.equal(result.status, 'excerpt_offer');
  assert.equal(result.excerpt.subject, '面试邀请');
  assert.equal(result.excerpt.from, 'hr@example.test');
  assert.match(result.excerpt.body, /测试同学，你好\n明天面试/);
  assert.doesNotMatch(result.excerpt.body, /ignored/);
  assert.equal(result.bytesBase64, undefined);
});
test('the frame itself supplies its URL even when selected directly, or only its loaded document has the URL', async () => {
  const { doc, frame } = reader();
  frame.removeAttribute('src');
  const ctx = webmail.opened(doc, 'netease');
  assert.equal(ctx.body, frame);
  const urls = webmail.rawCandidates(ctx, 'netease');
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('mid'), 'demo');
});
test('two separate visible panes are rejected instead of mixing a heading with another body', async () => {
  const a = reader(); const b = reader({ prefix: '202', mid: 'other' });
  a.doc.body.appendChild(b.doc.querySelector('.frame-main-cont-body'));
  let called = false;
  const result = await webmail.capture(a.doc, () => { called = true; });
  assert.equal(result.status, 'unrecognized_mail');
  assert.equal(called, false);
  b.frame.closest('.frame-main-cont-body').hidden = true;
  assert.equal((await webmail.capture(a.doc, async () => new Response(RAW))).status, 'original');
});
test('a heading and a body in separate panes cannot form a message', async () => {
  const { doc, frame } = reader();
  const otherPane = doc.createElement('div'); otherPane.className = 'frame-main-cont-body';
  otherPane.appendChild(frame); doc.body.appendChild(otherPane);
  assert.equal((await webmail.capture(doc, () => assert.fail('must not fetch'))).status, 'unrecognized_mail');
});
test('same-looking messages with different IDs are detected as changed during retrieval', async () => {
  const { doc, frame, content } = reader();
  const result = await webmail.capture(doc, async () => {
    const url = new URL(content.location.href); url.searchParams.set('mid', 'other');
    content.defaultView.history.replaceState({}, '', url);
    frame.src = url.href;
    return new Response(RAW);
  });
  assert.equal(result.status, 'changed');
});
test('a still-navigating iframe with conflicting requested/loaded IDs is not captured', async () => {
  const { doc, frame } = reader();
  frame.src = frame.src.replace('mid=demo', 'mid=other');
  assert.equal((await webmail.capture(doc, () => assert.fail('must not fetch'))).status, 'unrecognized_mail');
});
test('cross-origin and unreadable iframe documents never provide a readable mail', async () => {
  for (const inaccessible of [true, false]) {
    const { doc, frame } = reader();
    if (inaccessible) Object.defineProperty(frame, 'contentDocument', { value: null });
    else Object.defineProperty(frame, 'contentDocument', { value: new JSDOM('<div id="content" class="netease_mail_readhtml">body</div>', { url: 'https://evil.test/js6/read/readhtml3.jsp?mid=demo' }).window.document });
    assert.equal((await webmail.capture(doc, () => assert.fail('must not fetch'))).status, 'unrecognized_mail');
  }
});
test('an email-authored download toolbar is never used for original retrieval', async () => {
  const { doc, content } = reader();
  content.querySelector('#content').insertAdjacentHTML('beforeend', '<div role="toolbar"><a href="/js6/read/readdata.jsp?mid=evil&sid=synthetic&mode=download">下载邮件</a></div>');
  const urls = [];
  await webmail.capture(doc, async url => { urls.push(url); return new Response(RAW); });
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('mid'), 'demo');
});
test('failed download is an excerpt offer, rather than a false original or an open-mail prompt', async () => {
  const { doc } = reader();
  const result = await webmail.capture(doc, async () => new Response('<html>Login</html>'));
  assert.equal(result.status, 'excerpt_offer');
  assert.equal(result.bytesBase64, undefined);
});
test('stale toolbar links for other emails are ignored when the selected body is itself an iframe', async () => {
  const { doc } = reader();
  doc.querySelector('.frame-main-cont-body').insertAdjacentHTML('afterbegin', '<div class="nui-toolbar"><a href="/js6/read/readdata.jsp?mid=old&sid=synthetic&mode=download">下载邮件</a></div>');
  const urls = [];
  await webmail.capture(doc, async url => { urls.push(url); return new Response(RAW); });
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('mid'), 'demo');
});
test('a lookalike message document at an unrelated path is rejected', async () => {
  const { doc, frame, content } = reader();
  content.defaultView.history.replaceState({}, '', '/unrelated?mid=demo');
  frame.src = content.location.href;
  assert.equal((await webmail.capture(doc, () => assert.fail('must not fetch'))).status, 'unrecognized_mail');
});
