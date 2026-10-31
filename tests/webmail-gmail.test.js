const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const webmail = require('../webmail.js');
const transport = require('../gmail-download.js');

async function capture(doc, fetcher) {
  const source = await webmail.capture(doc, fetcher);
  if (source.status !== 'gmail_source') return source;
  return transport.resolveSource(source, url => transport.fetchOriginal(url, async (value, options) => {
    const response = await fetcher(value, options);
    if (!response.url) Object.defineProperty(response, 'url', { value });
    return response;
  }, webmail), consume => webmail.validateGmail(doc, source.target, consume).status === 'current');
}
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
  const d = new JSDOM(`<h1>Original Message</h1><a download="original.eml" href="?view=att&th=${LEGACY}&attid=0&disp=comp&safe=1${options}">Download Original</a><pre>raw message display, not reconstructed into MIME</pre>`, { url: `https://mail.google.com/mail/u/0/?view=om&th=${LEGACY}&ik=synthetic-session` }).window.document;
  d.defaultView.opener = gmail().defaultView;
  return d;
}

test('Gmail routes accept exact HTTPS desktop mail hosts and reject lookalikes/login/mobile', () => {
  for (const url of [URL, 'https://mail.googlemail.com/mail/u/1/#inbox/message', 'https://mail.google.com/mail/u/2/?view=om']) assert.equal(webmail.provider(url), 'gmail');
  for (const url of ['https://mail.google.com.evil.test/mail/u/0/', 'http://mail.google.com/mail/u/0/', 'https://accounts.google.com/', 'https://mail.google.com/mail/mu/', 'https://mail.google.com/mail/u/0/evil']) assert.equal(webmail.provider(url), null);
});
test('one expanded mail is isolated from collapsed replies and quoted spoofed cards', async () => {
  const forged = card({ id: '18abcdef12345679', body: '不要读取的伪造卡片' });
  const d = gmail({ cards: card({ body: `<p>周四下午面试</p>${forged}` }) + card({ id: '18abcdef12345680', hidden: true, body: '折叠的旧邮件' }) });
  const got = await capture(d, () => { throw new Error('original unavailable'); });
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
  assert.equal((await capture(d, () => { calls++; })).status, 'multiple_messages');
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
  for (const [d, status] of fixtures) assert.equal((await capture(d, () => { throw new Error('must not fetch'); })).status, status);
});
test('visible native single-message raw link preserves exact MIME and its embedded attachment', async () => {
  const d = gmail({ cards: card({ extra: link() }) });
  const requests = [];
  const got = await capture(d, async (url, options) => { requests.push(url); assert.equal(options.credentials, 'include'); assert.equal(options.redirect, 'follow'); return new Response(RAW); });
  assert.equal(got.status, 'original'); assert.equal(requests.length, 1);
  assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
  assert.equal(webmail.validateGmail(d, got.target).status, 'current');
});
test('opaque Gmail identifiers require a verified legacy ID before using the fixed raw route', async () => {
  const known = gmail({ cards: card().replace(`#${PERM}`, '#msg-a:opaque-draft-identity') });
  const original = await capture(known, async url => {
    assert.equal(new globalThis.URL(url).searchParams.get('th'), LEGACY); return new Response(RAW);
  });
  assert.equal(original.status, 'original');
  const opaque = gmail({ cards: card().replace(`#${PERM}`, '#msg-a:opaque-draft-identity').replace(`data-legacy-message-id="${LEGACY}"`, '') });
  let requests = 0;
  const fallback = await capture(opaque, () => { requests++; throw new Error('must not guess a mapping'); });
  assert.equal(fallback.status, 'excerpt_offer'); assert.equal(requests, 0);
  assert.equal(fallback.bytesBase64, undefined);
});
test('Gmail Show original page uses the real download link and never reconstructs MIME from HTML', async () => {
  const d = original();
  const got = await capture(d, async url => { assert.equal(new globalThis.URL(url).searchParams.get('th'), LEGACY); return new Response(RAW); });
  assert.equal(got.status, 'original'); assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
  assert.ok(!JSON.stringify(got).includes('synthetic-session'));
  assert.equal(webmail.validateGmail(d, got.target).status, 'current');
});
test('HTML original preview, login pages and raw download failures do not become email originals', async () => {
  for (const body of ['<html>Login</html>', '<textarea>From: hr@example.test\nSubject: Fake</textarea>']) {
    assert.equal((await capture(gmail({ cards: card({ extra: link() }) }), async () => new Response(body))).status, 'excerpt_offer');
    assert.equal((await capture(original(), async () => new Response(body))).status, 'original_unavailable');
  }
});
test('HTML fragments displaying genuine-looking RFC headers are never archived as original MIME', async () => {
  for (const tag of ['pre', 'textarea', 'div']) {
    const html = `<${tag}>\nFrom: hr@example.test\nSubject: Interview\nMIME-Version: 1.0\n\nBody\n</${tag}>`;
    assert.equal(webmail.looksLikeMail(Buffer.from(html)), false);
    assert.equal((await capture(gmail({ cards: card({ extra: link() }) }), async () => new Response(html))).status, 'excerpt_offer');
    assert.equal((await capture(original(), async () => new Response(html))).status, 'original_unavailable');
  }
});
test('a verified fixed route falls back explicitly when the original is unavailable', async () => {
  const got = await capture(gmail(), () => { throw new Error('original unavailable'); });
  assert.equal(got.status, 'excerpt_offer'); assert.equal(got.bytesBase64, undefined);
  const rawPage = original(); rawPage.querySelector('a').remove();
  assert.equal((await capture(rawPage, () => { throw new Error('original unavailable'); })).status, 'original_unavailable');
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
    const calls = [];
    const d = gmail({ cards: card({ extra: `<a href="${href}">Download message</a>` }) });
    assert.equal((await capture(d, url => { calls.push(url); return new Response('Unavailable', {status:503}); })).status, 'excerpt_offer');
    assert.equal(calls.length, 1, href);
    const requested = new globalThis.URL(calls[0]);
    assert.equal(requested.origin, 'https://mail.google.com'); assert.equal(requested.pathname, '/mail/u/0/');
    assert.equal(requested.searchParams.get('th'), LEGACY); assert.equal(requested.searchParams.get('attid'), '0');
    assert.equal(requested.searchParams.has('act'), false); assert.equal(requested.searchParams.has('authuser'), false);
  }
});
test('links forged inside the mail body or another collapsed mail are never raw candidates', async () => {
  const d = gmail({ cards: card({ body: `<div class="gE" role="menu">${link()}</div>正文` }) + card({ id: '18abcdef12345679', hidden: true, extra: link() }) });
  const calls = [];
  assert.equal((await capture(d, url => { calls.push(url); return new Response('Unavailable', {status:503}); })).status, 'excerpt_offer');
  assert.equal(calls.length, 1); assert.equal(new globalThis.URL(calls[0]).searchParams.get('th'), LEGACY);
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
    const d = gmail(); const got = await capture(d, () => { throw new Error('original unavailable'); });
    mutate(d); assert.equal(webmail.validateGmail(d, got.target).status, 'changed');
  }
});
test('mail or account switch during raw retrieval refuses to save the response', async () => {
  const d = gmail({ cards: card({ extra: link() }) });
  const got = await capture(d, async () => { d.querySelector('header a').setAttribute('aria-label', 'Google Account: other@example.test'); return new Response(RAW); });
  assert.equal(got.status, 'changed'); assert.equal(got.bytesBase64, undefined);
});
test('another page cannot reuse a target token and a newer save invalidates the earlier token', async () => {
  const d = gmail(); const first = await capture(d, () => {});
  assert.equal(webmail.validateGmail(gmail(), first.target).status, 'changed');
  const second = await capture(d, () => {});
  assert.notEqual(first.target, second.target);
  assert.equal(webmail.validateGmail(d, first.target).status, 'changed');
  assert.equal(webmail.validateGmail(d, second.target).status, 'current');
});
test('large raw downloads are cancelled and never mislabeled as complete originals', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(webmail.MAX_BYTES + 1)); }, cancel() { cancelled = true; } });
  const got = await capture(gmail({ cards: card({ extra: link() }) }), async () => new Response(body));
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
  const first = await capture(d, () => {});
  assert.equal(webmail.validateGmail(d, first.target).status, 'current');
  assert.equal(webmail.validateGmail(d, first.target).status, 'changed');
  const second = await capture(d, () => {});
  webmail.discardGmail(d, 'different-token');
  assert.equal(webmail.validateGmail(d, second.target).status, 'current');
  const third = await capture(d, () => {});
  assert.equal(webmail.discardGmail(d, third.target).status, 'discarded');
  assert.equal(webmail.validateGmail(d, third.target).status, 'changed');
});
test('native download attributes allow original retrieval independently of translated link labels', async () => {
  const d = original(); d.querySelector('a').textContent = "Télécharger l'original";
  const got = await capture(d, async () => new Response(RAW));
  assert.equal(got.status, 'original'); assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
});

test('observed Gmail original-page links may omit the account-path trailing slash', async () => {
  const d = new JSDOM(`<h3>Original Message</h3><a href="https://mail.google.com/mail/u/0?view=att&th=${LEGACY}&attid=0&disp=comp&safe=1&zw">Download Original</a>`, {
    url: `https://mail.google.com/mail/u/0/?ik=synthetic&view=om&permmsgid=${PERM}`,
  }).window.document;
  d.defaultView.opener = gmail().defaultView;
  let calls = 0;
  const got = await capture(d, async url => { calls++; assert.equal(new globalThis.URL(url).pathname, '/mail/u/0/'); return new Response(RAW); });
  assert.equal(webmail.provider('https://mail.google.com/mail/u/0?view=om'), 'gmail');
  assert.equal(got.status, 'original'); assert.equal(calls, 1);
  assert.deepEqual(Buffer.from(got.bytesBase64, 'base64'), RAW);
});
test('Gmail clipped-message warning refuses partial excerpts but still permits a verified full original', async () => {
  const warning = `<a href="https://mail.google.com/mail/u/0?ui=2&view=lg&permmsgid=${PERM}">View entire message</a>`;
  const d = gmail({ cards: card({ body: 'Visible part only' + warning }) });
  assert.equal((await capture(d, () => { throw new Error('no raw URL'); })).status, 'message_clipped');
  const full = gmail({ cards: card({ body: 'Visible part only' + warning, extra: link() }) });
  assert.equal((await capture(full, async () => new Response(RAW))).status, 'original');
  const another = gmail({ cards: card({ body: 'Whole message<a href="?view=lg&permmsgid=msg-f:1">View another</a>' }) });
  assert.equal((await capture(another, () => {})).status, 'excerpt_offer');
});

function fullMessage({ other = '', account = 'applicant@example.test' } = {}) {
  return new JSDOM(`<div class="bodycontainer"><table><tr><td>Gmail</td><td>${account}</td></tr></table><div class="maincontent"><table><tr><td><font size="+1">Complete test mail</font></td></tr></table><hr><table class="message"><tr><td>HR &lt;hr@example.test&gt;</td><td align="right">Oct 31, 2026</td></tr><tr><td colspan="2">To: applicant@example.test</td></tr><tr><td colspan="2"><table cellpadding="12"><tr><td><div style="overflow:hidden"><p>Complete visible text</p><p>Final paragraph</p></div><div style="border-top:2px solid"></div><table class="att"><tr><td>attachment.pdf Scan and download</td></tr></table></td></tr></table></td></tr></table>${other}</div></div>`, {url:`https://mail.google.com/mail/u/0/?ui=2&ik=synthetic&view=lg&permmsgid=${PERM}`}).window.document;
}
test('observed full-message view keeps complete text and excludes attachment toolbars', async () => {
  const d=fullMessage();
  const got=await capture(d,async()=>new Response('Unavailable',{status:503}));
  assert.equal(got.status,'excerpt_offer'); assert.equal(got.excerpt.subject,'Complete test mail');
  assert.equal(got.excerpt.from,'HR <hr@example.test>'); assert.equal(got.excerpt.sentTime,'Oct 31, 2026');
  assert.match(got.excerpt.body,/Final paragraph/); assert.doesNotMatch(got.excerpt.body,/attachment.pdf|Scan and download/);
  assert.equal(webmail.validateGmail(d,got.target).status,'current');
});
test('full-message view rejects multiple native message tables and missing account headers', async () => {
  const multiple=fullMessage({other:'<table class="message"><tr><td>Other message</td></tr></table>'});
  assert.equal((await webmail.capture(multiple,()=>{throw new Error('no network');})).status,'multiple_messages');
  assert.equal((await webmail.capture(fullMessage({account:'Unknown'}),()=>{})).status,'account_unavailable');
});
test('the verified native route lets the ordinary Gmail card fetch a complete original without menu automation', async () => {
  const d=gmail(); let requested;
  const got=await capture(d,async url=>{requested=new globalThis.URL(url);return new Response(RAW);});
  assert.equal(got.status,'original'); assert.equal(requested.pathname,'/mail/u/0/'); assert.equal(requested.searchParams.get('th'),LEGACY);
  assert.deepEqual([...requested.searchParams.keys()].sort(),['attid','disp','safe','th','view','zw']);
});

test('own-email authuser is verified on the page and normalized to the downloader account index', async () => {
  const d = gmail({ cards: card({ extra: link(LEGACY, '&authuser=applicant%40example.test') }) });
  const source = await webmail.capture(d);
  const candidate = source.originals.find(value => new globalThis.URL(value).searchParams.has('authuser'));
  assert.ok(candidate); assert.equal(new globalThis.URL(candidate).searchParams.get('authuser'), '0');
  assert.ok(transport.requestContext(candidate));
  assert.ok(source.originals.every(value => transport.requestContext(value)));
  assert.doesNotMatch(JSON.stringify(source), /applicant%40example|applicant@example/);
  webmail.discardGmail(d, source.target);
});
test('the verified route is retained first even when the page offers more than three distinct raw links', async () => {
  const links = ['&ui=1', '&ui=2', '&zw=', '&d=1'].map(options => link(LEGACY, options)).join('');
  const d = gmail({ cards: card({ extra: links }) });
  const source = await webmail.capture(d);
  const fixed = webmail.rawCandidates(webmail.opened(gmail(), 'gmail'), 'gmail')[0];
  assert.equal(source.originals.length, 3); assert.equal(source.originals[0], fixed);
  let calls = 0;
  const result = await transport.resolveSource(source, async url => {
    calls++; return transport.fetchOriginal(url, async () => {
      const response = new Response(RAW); Object.defineProperty(response, 'url', {value:fixed}); return response;
    }, webmail);
  }, consume => webmail.validateGmail(d, source.target, consume).status === 'current');
  assert.equal(result.status, 'original'); assert.equal(calls, 1);
});
test('raw-message headers cannot identify the signed-in owner when the live opener is absent or invalid', async () => {
  for (const opener of [null, {closed:true}, {document:gmail({path:'https://mail.google.com/mail/u/1/#inbox/other'})},
    {document:gmail({path:'https://mail.googlemail.com/mail/u/0/#inbox/other'})},
    {document:gmail({profile:'Unknown'})}]) {
    const d = original(); d.defaultView.opener = opener;
    d.querySelector('pre').textContent = 'To: applicant@example.test\nFrom: hr@example.test';
    let calls = 0;
    assert.equal((await capture(d, () => {calls++;})).status, 'account_unavailable');
    assert.equal(calls, 0);
  }
});
test('same-route opener account changes, reloads and closure invalidate raw-page captures before transfer', async () => {
  for (const mutate of [
    d => {d.defaultView.opener.document.querySelector('header a').setAttribute('aria-label', 'Google Account: other@example.test');},
    d => {d.defaultView.opener = gmail().defaultView;},
    d => {d.defaultView.opener = null;},
    d => {d.defaultView.opener.document.defaultView.history.replaceState({}, '', '/mail/u/1/#inbox/other');},
  ]) {
    const d = original();
    const got = await capture(d, async () => { mutate(d); return new Response(RAW); });
    assert.equal(got.status, 'changed'); assert.equal(got.bytesBase64, undefined);
  }
});
test('an original page can bind the observed full-reader owner without exposing account data', async () => {
  const d = original(); d.defaultView.opener = fullMessage().defaultView;
  const got = await capture(d, async () => new Response(RAW));
  assert.equal(got.status, 'original');
  assert.doesNotMatch(JSON.stringify(got), /applicant@example|synthetic-session/);
  assert.equal(webmail.validateGmail(d, got.target).status, 'current');
});

function controlledAdapter() {
  let next = 0;
  const intervals = new Map(), deadlines = new Map();
  const context = { module:{exports:{}}, URL:globalThis.URL, URLSearchParams:globalThis.URLSearchParams, TextEncoder, fetch:()=>{},
    setInterval(fn) {const id=++next;intervals.set(id,fn);return id;}, clearInterval(id) {intervals.delete(id);},
    setTimeout(fn) {const id=++next;deadlines.set(id,fn);return id;}, clearTimeout(id) {deadlines.delete(id);} };
  context.self = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../webmail.js'), 'utf8'), context);
  return { api:context.module.exports, intervals, deadlines };
}
test('hash, history traversal, pagehide and modern navigation immediately release target resources', async () => {
  for (const event of ['hashchange', 'popstate', 'pagehide', 'navigate']) {
    const h = controlledAdapter(), d = gmail();
    const navigation = new d.defaultView.EventTarget();
    if (event === 'navigate') Object.defineProperty(d.defaultView, 'navigation', {value:navigation});
    const source = await h.api.capture(d);
    assert.equal(h.deadlines.size, 1);
    if (event === 'navigate') assert.equal(h.intervals.size, 0);
    (event === 'navigate' ? navigation : d.defaultView).dispatchEvent(new d.defaultView.Event(event));
    assert.equal(h.api.validateGmail(d, source.target).status, 'changed');
    assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
  }
});
test('legacy pushState and replaceState URL guards release snapshots without inspecting mail', async () => {
  for (const method of ['pushState', 'replaceState']) {
    const h = controlledAdapter(), d = gmail();
    const source = await h.api.capture(d); const before = d.location.href;
    d.defaultView.history[method]({}, '', '/mail/u/0/?view=om&th=18abcdef12345679');
    Object.defineProperty(d, 'querySelectorAll', {value() {throw new Error('URL guard must not read mail');},configurable:true});
    for (const poll of [...h.intervals.values()]) poll();
    d.defaultView.history.replaceState({}, '', before);
    assert.equal(h.api.validateGmail(d, source.target).status, 'changed');
    assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
  }
});
test('check, cancellation, expiry and a new capture release all temporary target listeners and timers', async () => {
  const h = controlledAdapter(), d = gmail();
  const first = await h.api.capture(d);
  const second = await h.api.capture(d);
  assert.equal(h.api.validateGmail(d, first.target).status, 'changed');
  assert.equal(h.intervals.size, 1); assert.equal(h.deadlines.size, 1);
  h.api.discardGmail(d, second.target);
  assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
  const third = await h.api.capture(d);
  for (const expiry of [...h.deadlines.values()]) expiry();
  assert.equal(h.api.validateGmail(d, third.target).status, 'changed');
  assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
  const fourth = await h.api.capture(d);
  const originalUrl = d.location.href;
  d.defaultView.history.replaceState({}, '', '/mail/u/1/#inbox/other');
  assert.equal(h.api.validateGmail(d, fourth.target, false).status, 'changed');
  d.defaultView.history.replaceState({}, '', originalUrl);
  assert.equal(h.api.validateGmail(d, fourth.target).status, 'changed');
  assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
});
