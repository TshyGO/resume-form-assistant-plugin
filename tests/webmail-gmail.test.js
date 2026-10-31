const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const webmail = require('../webmail.js');
const LEGACY = '18abcdef12345678';
const PERM = `msg-f:${BigInt(`0x${LEGACY}`)}`;
const URL = 'https://mail.google.com/mail/u/0/#inbox/thread-example';
const RAW = Buffer.from('From: HR <hr@example.test>\r\nTo: applicant@example.test\r\nSubject: Interview\r\nDate: Fri, 30 Oct 2026 08:00:00 +0000\r\nMessage-ID: <gmail-test@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=demo\r\n\r\n--demo\r\nContent-Type: text/plain\r\n\r\nInterview Thursday\r\n--demo\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="guide.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n--demo--\r\n');
function card({ id = LEGACY, body = '周四下午面试', hidden = false, extra = '', sender = 'hr@example.test' } = {}) {
  return `<div class="adn ads" data-message-id="#msg-f:${BigInt(`0x${id}`)}" data-legacy-message-id="${id}"><div class="gE"><span class="gD" email="${sender}">HR</span><span class="g3" title="2026-10-30 16:00">16:00</span>${extra}</div><div class="a3s aiL" ${hidden ? 'style="display:none"' : ''}>${body}</div></div>`;
}
function gmail({ cards = card(), path = URL, extra = '', profile = 'Google 账号：测试用户 (applicant@example.test)' } = {}) {
  return new JSDOM(`<header role="banner"><a href="https://accounts.google.com/SignOutOptions?service=mail" aria-label="${profile}"></a></header><main role="main"><h2 class="hP">星河科技面试安排</h2>${cards}</main>${extra}`, { url: path }).window.document;
}
function link(id = LEGACY, options = '') { return `<a href="?view=att&th=${id}&attid=0&disp=comp&safe=1${options}">Download message</a>`; }
function original(options = '') {
  return new JSDOM(`<h1>Original Message</h1><a download="original.eml" href="?view=att&th=${LEGACY}&attid=0&disp=comp&safe=1${options}">Download Original</a><pre>raw message display, not reconstructed into MIME</pre>`, { url: `https://mail.google.com/mail/u/0/?view=om&th=${LEGACY}&ik=synthetic-session` }).window.document;
}

test('Gmail routes accept exact HTTPS desktop mail hosts and reject lookalikes/login/mobile', () => {
  for (const url of [URL, 'https://mail.googlemail.com/mail/u/1/#inbox/message', 'https://mail.google.com/mail/u/2/?view=om']) assert.equal(webmail.provider(url), 'gmail');
  for (const url of ['https://mail.google.com.evil.test/mail/u/0/', 'http://mail.google.com/mail/u/0/', 'https://accounts.google.com/', 'https://mail.google.com/mail/mu/', 'https://mail.google.com/mail/u/0/evil']) assert.equal(webmail.provider(url), null);
});
test('one expanded mail is isolated from collapsed replies and quoted spoofed cards', async () => {
  const forged = card({ id: '18abcdef12345679', body: '不要读取的伪造卡片' });
  const d = gmail({ cards: card({ body: `<p>周四下午面试</p>${forged}` }) + card({ id: '18abcdef12345680', hidden: true, body: '折叠的旧邮件' }) });
  const got = await webmail.capture(d, () => { throw new Error('no link means no network'); });
  assert.equal(got.status, 'excerpt_offer');
  assert.equal(got.excerpt.subject, '星河科技面试安排');
  assert.equal(got.excerpt.from, 'hr@example.test');
  assert.ok(!got.excerpt.body.includes('折叠的旧邮件'));
  assert.equal(got.excerpt.sentTime, '2026-10-30 16:00');
  assert.ok(got.target && !got.target.includes('example.test'));
  assert.equal(webmail.validateGmail(d, got.target).status, 'current');
});
test('multiple expanded emails are rejected instead of silently picking the latest', async () => {
  let calls = 0;
  const d = gmail({ cards: card() + card({ id: '18abcdef12345679', body: '另一封邮件' }) });
  assert.equal((await webmail.capture(d, () => { calls++; })).status, 'multiple_messages');
  assert.equal(calls, 0);
});
test('inbox, loading mail, missing account and conflicting identities produce no fetch', async () => {
  const fixtures = [
    [new JSDOM('<main>收件箱列表</main>', { url: URL }).window.document, 'open_mail'],
    [gmail({ cards: '' }), 'unrecognized_mail'],
    [gmail({ profile: '未知账户' }), 'account_unavailable'],
    [gmail({ cards: card().replace(PERM, 'msg-f:1') }), 'unrecognized_mail'],
    [gmail({ cards: card().replace('data-message-id', 'unknown-message-id').replace('data-legacy-message-id', 'unknown-legacy-id') }), 'unrecognized_mail'],
  ];
  for (const [d, status] of fixtures) assert.equal((await webmail.capture(d, () => { throw new Error('must not fetch'); })).status, status);
});
test('visible native single-message raw link preserves exact MIME and its embedded attachment', async () => {
  const d = gmail({ cards: card({ extra: link() }) });
  const requests = [];
  const got = await webmail.capture(d, async (url, options) => { requests.push(url); assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); return new Response(RAW); });
  assert.equal(got.status, 'original'); assert.equal(requests.length, 1);
  assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
  assert.equal(webmail.validateGmail(d, got.target).status, 'current');
});
test('Gmail Show original page uses the real download link and never reconstructs MIME from HTML', async () => {
  const d = original();
  const got = await webmail.capture(d, async url => { assert.equal(new globalThis.URL(url).searchParams.get('th'), LEGACY); return new Response(RAW); });
  assert.equal(got.status, 'original'); assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
  assert.ok(!JSON.stringify(got).includes('synthetic-session'));
  assert.equal(webmail.validateGmail(d, got.target).status, 'current');
});
test('HTML original preview, login pages and raw download failures do not become email originals', async () => {
  for (const body of ['<html>Login</html>', '<textarea>From: hr@example.test\nSubject: Fake</textarea>']) {
    assert.equal((await webmail.capture(gmail({ cards: card({ extra: link() }) }), async () => new Response(body))).status, 'excerpt_offer');
    assert.equal((await webmail.capture(original(), async () => new Response(body))).status, 'original_unavailable');
  }
});
test('missing raw links use explicit excerpt fallback without constructing internal endpoints', async () => {
  const got = await webmail.capture(gmail(), () => { throw new Error('no guessed endpoints'); });
  assert.equal(got.status, 'excerpt_offer'); assert.equal(got.bytesBase64, undefined);
  const rawPage = original(); rawPage.querySelector('a').remove();
  assert.equal((await webmail.capture(rawPage, () => { throw new Error('no guessed endpoints'); })).status, 'original_unavailable');
});
test('download links are bound to the exact account and message, and cannot execute other actions', async () => {
  const bad = [
    `https://mail.google.com/mail/u/1/?view=att&th=${LEGACY}&attid=0&disp=comp`,
    `https://evil.test/mail/u/0/?view=att&th=${LEGACY}&attid=0&disp=comp`,
    `?view=att&th=18abcdef12345679&attid=0&disp=comp`,
    `?view=att&th=${LEGACY}&attid=1&disp=comp`,
    `?view=att&th=${LEGACY}&attid=0&disp=comp&authuser=other@example.test`,
    `?view=att&th=${LEGACY}&attid=0&disp=comp&act=send`,
    `?view=att&th=${LEGACY}&attid=0&disp=comp&th=18abcdef12345679`,
    `?view=om&permmsgid=msg-f:123`,
  ];
  for (const href of bad) {
    let calls = 0;
    const d = gmail({ cards: card({ extra: `<a href="${href}">Download message</a>` }) });
    assert.equal((await webmail.capture(d, () => { calls++; })).status, 'excerpt_offer'); assert.equal(calls, 0, href);
  }
});
test('links forged inside the mail body or another collapsed mail are never raw candidates', async () => {
  const d = gmail({ cards: card({ body: `<div class="gE" role="menu">${link()}</div>正文` }) + card({ id: '18abcdef12345679', hidden: true, extra: link() }) });
  let calls = 0;
  assert.equal((await webmail.capture(d, () => { calls++; })).status, 'excerpt_offer'); assert.equal(calls, 0);
});
test('account changes, message IDs and DOM replacement invalidate a proposed excerpt even at the same URL', async () => {
  const mutations = [
    d => d.querySelector('header a').setAttribute('aria-label', 'Google Account: other@example.test'),
    d => d.querySelector('.adn').setAttribute('data-legacy-message-id', '18abcdef12345679'),
    d => { d.querySelector('.a3s').outerHTML = '<div class="a3s aiL">周四下午面试</div>'; },
    d => { d.querySelector('.a3s').textContent = '时间变更'; },
    d => d.defaultView.history.replaceState({}, '', '/mail/u/1/#inbox/thread-example'),
  ];
  for (const mutate of mutations) {
    const d = gmail(); const got = await webmail.capture(d, () => { throw new Error('no raw link'); });
    mutate(d); assert.equal(webmail.validateGmail(d, got.target).status, 'changed');
  }
});
test('mail or account switch during raw retrieval refuses to save the response', async () => {
  const d = gmail({ cards: card({ extra: link() }) });
  const got = await webmail.capture(d, async () => { d.querySelector('header a').setAttribute('aria-label', 'Google Account: other@example.test'); return new Response(RAW); });
  assert.equal(got.status, 'changed'); assert.equal(got.bytesBase64, undefined);
});
test('another page cannot reuse a target token and a newer save invalidates the earlier token', async () => {
  const d = gmail(); const first = await webmail.capture(d, () => {});
  assert.equal(webmail.validateGmail(gmail(), first.target).status, 'changed');
  const second = await webmail.capture(d, () => {});
  assert.notEqual(first.target, second.target);
  assert.equal(webmail.validateGmail(d, first.target).status, 'changed');
  assert.equal(webmail.validateGmail(d, second.target).status, 'current');
});
test('large raw downloads are cancelled and never mislabeled as complete originals', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(webmail.MAX_BYTES + 1)); }, cancel() { cancelled = true; } });
  const got = await webmail.capture(gmail({ cards: card({ extra: link() }) }), async () => new Response(body));
  assert.equal(got.status, 'excerpt_offer'); assert.equal(got.reason, 'too_large'); assert.equal(cancelled, true);
});
test('Gmail adapter installation does not inspect mail before an explicit side-panel request', () => {
  let listener;
  const context = { URL: globalThis.URL, chrome: { runtime: { id: 'own', getURL: file => `chrome-extension://own/${file}`, onMessage: { addListener: fn => { listener = fn; } } } } };
  context.self = context; context.window = context; context.top = context; context.location = { href: URL };
  Object.defineProperty(context, 'document', { get() { throw new Error('pre-read'); } });
  vm.runInNewContext(fs.readFileSync(require.resolve('../webmail.js'), 'utf8'), context);
  assert.equal(typeof listener, 'function');
  let reply;
  assert.equal(listener({ type: 'WEBMAIL_VALIDATE', target: 'x' }, { id: 'own', url: URL }, value => { reply = value; }), false);
  assert.equal(reply.status, 'forbidden');
});

test('accepting or cancelling a Gmail proposal releases its one-use target snapshot', async () => {
  const d = gmail();
  const first = await webmail.capture(d, () => {});
  assert.equal(webmail.validateGmail(d, first.target).status, 'current');
  assert.equal(webmail.validateGmail(d, first.target).status, 'changed');
  const second = await webmail.capture(d, () => {});
  webmail.discardGmail(d, 'different-token');
  assert.equal(webmail.validateGmail(d, second.target).status, 'current');
  const third = await webmail.capture(d, () => {});
  assert.equal(webmail.discardGmail(d, third.target).status, 'discarded');
  assert.equal(webmail.validateGmail(d, third.target).status, 'changed');
});
test('native download attributes allow original retrieval independently of translated link labels', async () => {
  const d = original(); d.querySelector('a').textContent = "Télécharger l'original";
  const got = await webmail.capture(d, async () => new Response(RAW));
  assert.equal(got.status, 'original'); assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
});
