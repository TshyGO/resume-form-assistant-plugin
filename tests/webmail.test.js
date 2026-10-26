const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const webmail = require('../webmail.js');
const RAW = Buffer.from('From: hr@example.test\r\nTo: user@example.test\r\nSubject: Interview\r\nDate: Mon, 26 Oct 2026 08:00:00 +0000\r\nMessage-ID: <invitation@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=demo\r\n\r\n--demo\r\nContent-Type: text/plain\r\n\r\nInterview tomorrow\r\n--demo\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="guide.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--demo--\r\n');
function qq(extra = '') {
  return new JSDOM(`<h1 id="subject">面试邀请</h1><span id="fromaddr">hr@example.test</span><span id="mail_date">2026-10-26</span><div id="mailContentContainer">明天面试${extra}</div>`, { url: 'https://mail.qq.com/cgi-bin/readmail?sid=synthetic&mailid=demo&t=mail' }).window.document;
}
function netease() {
  return new JSDOM('<div class="nui-read-header"><h1 class="nui-read-title">面试邀请</h1><span class="nui-addr-email">hr@example.test</span><span class="nui-read-time">2026-10-26</span></div><div class="nui-toolbar"><a href="/js6/read/readdata.jsp?sid=synthetic&mid=demo&mode=download">下载邮件</a></div><div class="nui-read-body">明天面试</div>', { url: 'https://mail.163.com/js6/main.jsp?sid=synthetic' }).window.document;
}
for (const [name, make] of [['QQ', qq], ['163', netease], ['126', () => {
  const d = netease(); d.defaultView.history.replaceState({}, '', d.location.href); return new JSDOM(d.documentElement.outerHTML, { url: 'https://mail.126.com/js6/main.jsp?sid=synthetic' }).window.document;
}]]) test(`${name}: keeps exact original bytes including MIME attachment`, async () => {
  let requests = 0;
  const got = await webmail.capture(make(), async (url, options) => {
    requests++; assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
    assert.ok(url.startsWith('https://mail.'));
    return new Response(RAW, { headers: { 'content-type': 'message/rfc822' } });
  });
  assert.equal(got.status, 'original'); assert.equal(requests, 1);
  assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
  assert.ok(!JSON.stringify(got).includes('synthetic'));
});
test('rejects lookalike domains, insecure pages and unsupported providers', () => {
  for (const url of ['https://mail.qq.com.evil.test', 'http://mail.qq.com', 'https://163.com.evil.test', 'https://mail.google.com']) assert.equal(webmail.provider(url), null);
});
test('mail list is not guessed to be an opened message and sends no network request', async () => {
  const d = new JSDOM('<div>收件箱</div>', { url: 'https://mail.qq.com' }).window.document;
  let called = false;
  assert.equal((await webmail.capture(d, () => { called = true; })).status, 'open_mail'); assert.equal(called, false);
});
test('login page and failed original retrieval offer an explicitly labelled excerpt', async () => {
  const got = await webmail.capture(qq(), async () => new Response('<html>Login</html>'));
  assert.equal(got.status, 'excerpt_offer'); assert.equal(got.excerpt.subject, '面试邀请'); assert.equal(got.excerpt.body, '明天面试');
  assert.equal(got.bytesBase64, undefined);
});
test('mail change while original download is running cannot archive the previous/new mix', async () => {
  const d = qq();
  const got = await webmail.capture(d, async () => {
    d.querySelector('#subject').textContent = '另一封信'; return new Response(RAW);
  });
  assert.equal(got.status, 'changed');
});
test('original links in the email body and attachment-only URLs are ignored', async () => {
  const d = netease(); d.querySelector('.nui-toolbar a').setAttribute('href', '/js6/read/readdata.jsp?sid=synthetic&mid=demo&mode=download&part=2');
  d.querySelector('.nui-read-body').innerHTML = '<div class="nui-toolbar"><a href="https://evil.test/x">下载邮件</a></div>正文';
  let called = false;
  const got = await webmail.capture(d, () => { called = true; });
  assert.equal(called, false); assert.equal(got.status, 'excerpt_offer');
});
test('oversized streamed original is cancelled and never silently truncated', async () => {
  const d = qq(); let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(webmail.MAX_BYTES + 1)); }, cancel() { cancelled = true; } });
  const got = await webmail.capture(d, async () => new Response(body));
  assert.equal(got.status, 'excerpt_offer'); assert.equal(got.reason, 'too_large'); assert.equal(cancelled, true);
});
test('same-origin QQ mail iframe is recognized; cross-origin and hidden panes are ignored', async () => {
  const d = new JSDOM('<iframe id="mainFrame"></iframe>', { url: 'https://mail.qq.com/' }).window.document;
  Object.defineProperty(d.querySelector('iframe'), 'contentDocument', { value: qq() });
  assert.equal((await webmail.capture(d, async () => new Response(RAW))).status, 'original');
});
test('loading the content adapter installs a listener without inspecting the document', () => {
  let listener;
  const context = { URL, self: null, chrome: { runtime: { id: 'own', getURL: p => `chrome-extension://own/${p}`, onMessage: { addListener: l => { listener = l; } } } } };
  context.self = context; context.window = context; context.top = context; context.location = { href: 'https://mail.qq.com' };
  Object.defineProperty(context, 'document', { get() { throw new Error('read before click'); } });
  vm.runInNewContext(fs.readFileSync(require.resolve('../webmail.js'), 'utf8'), context);
  assert.equal(typeof listener, 'function');
  let answer;
  assert.equal(listener({ type: 'WEBMAIL_CAPTURE' }, { id: 'own', url: 'https://mail.qq.com/' }, r => { answer = r; }), false);
  assert.equal(answer.status, 'forbidden');
});
test('a stale toolbar download for a different message is never used', async () => {
  const d = qq();
  const toolbar = d.createElement('div'); toolbar.id = 'toolbar'; toolbar.innerHTML = '<a href="/cgi-bin/readmail?sid=synthetic&mailid=old&t=download">下载邮件</a>'; d.body.prepend(toolbar);
  const requests = [];
  const got = await webmail.capture(d, async url => { requests.push(url); return new Response(RAW); });
  assert.equal(got.status, 'original'); assert.equal(requests.length, 1); assert.equal(new URL(requests[0]).searchParams.get('mailid'), 'demo');
});
test('two visible reading panes are ambiguous and trigger no original download', async () => {
  const d = netease(); const another = d.createElement('div'); another.className = 'nui-read-body'; another.textContent = '另一封'; d.body.appendChild(another);
  let called = false;
  assert.equal((await webmail.capture(d, () => { called = true; })).status, 'open_mail'); assert.equal(called, false);
});
