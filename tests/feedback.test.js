const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../feedback-core.js');

async function fixture(options = {}) {
  const { createFeedback, STORAGE_KEY } = await import('../link/feedback.mjs');
  const data = options.data || {};
  const calls = [];
  let time = 1800000000000;
  const service = createFeedback({
    storage: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) },
    now: () => time, version: '0.4.1', os: 'macOS / Edge 140', timeoutMs: 20,
    fetchImpl: options.fetchImpl || (async (url, request) => { calls.push({ url, ...request, payload: JSON.parse(request.body) }); return new Response(JSON.stringify({ ok: true, id: 'test-123' })); })
  });
  return { service, data, calls, key: STORAGE_KEY, advance: ms => { time += ms; } };
}
const crash = { kind: 'exception', name: 'TypeError', source: 'error', stack: 'content.js:100:2', message: 'Secret name and resume data' };

test('new installs default on with a notice; opt out deletes identity', async () => {
  const f = await fixture();
  assert.deepEqual(await f.service.status(), { consent: true, noticeSeen: false });
  const initialId = f.data[f.key].anonymousId;
  assert.match(initialId, /^[0-9a-f-]{36}$/);
  const restart = await fixture({ data: f.data });
  assert.deepEqual(await restart.service.status(), { consent: true, noticeSeen: false });
  assert.equal(f.data[f.key].anonymousId, initialId);
  await f.service.automatic({ ...crash, stack: 'content.js:9:1' }); assert.equal(f.calls.length, 1);
  f.calls.length = 0;
  await f.service.setConsent(false); await f.service.automatic(crash); assert.equal(f.calls.length, 0);
  await f.service.setConsent(true); const id = f.data[f.key].anonymousId; assert.match(id, /^[0-9a-f-]{36}$/);
  await f.service.automatic(crash, 'c.liepin.com'); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.calls[0].payload).includes('Secret'));
  assert.match(f.calls[0].payload.user_description, /网站: c.liepin.com/);
  await f.service.setConsent(false); assert.equal(f.data[f.key].anonymousId, null);
  await f.service.setConsent(true); assert.notEqual(f.data[f.key].anonymousId, id);
});

test('50 simultaneous repeats only send once, including after worker restart', async () => {
  const f = await fixture(); await f.service.setConsent(true);
  await Promise.all(Array.from({ length: 50 }, () => f.service.automatic(crash)));
  assert.equal(f.calls.length, 1);
  const restarted = await fixture({ data: f.data });
  await restarted.service.automatic(crash); assert.equal(restarted.calls.length, 0);
  f.advance(24 * 3600000 + 1); await f.service.automatic(crash); assert.equal(f.calls.length, 2);
});

test('all auto categories share five per hour limit; fill dedup is host and type', async () => {
  const f = await fixture(); await f.service.setConsent(true);
  for (let i = 0; i < 4; i++) await f.service.automatic({ ...crash, stack: `content.js:${i}:1` });
  await f.service.automatic({ kind: 'fill_failed' }, 'c.liepin.com');
  await f.service.automatic({ kind: 'fill_partial' }, 'c.liepin.com');
  assert.equal(f.calls.length, 5);
  f.advance(3600001);
  await f.service.automatic({ kind: 'fill_failed' }, 'c.liepin.com'); assert.equal(f.calls.length, 5);
  await f.service.automatic({ kind: 'fill_partial' }, 'c.liepin.com'); assert.equal(f.calls.length, 6);
});

test('429 and 5xx suppress automatic reports for one hour; failures are not retried', async () => {
  for (const status of [429, 500, 503]) {
    let count = 0;
    const f = await fixture({ fetchImpl: async () => { count++; return new Response('', { status }); } });
    await f.service.setConsent(true);
    await f.service.automatic(crash);
    await f.service.automatic({ ...crash, stack: 'content.js:200:1' }); assert.equal(count, 1);
    f.advance(3600001);
    await f.service.automatic({ ...crash, stack: 'content.js:200:1' }); assert.equal(count, 2);
  }
});

test('network error, HTTP errors, timeout and oversized/malformed replies return safe results', async () => {
  const variants = [
    async () => { throw new Error('secret response'); },
    async () => new Response('secret', { status: 403 }),
    async () => new Response('x'.repeat(5000)),
    async () => new Response('invalid'),
    (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('abort'))))
  ];
  for (const fetchImpl of variants) {
    const f = await fixture({ fetchImpl }); await f.service.setConsent(true);
    const result = await f.service.automatic(crash);
    assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('manual feedback works while opted out, sends exact preview, and enforces 60 seconds', async () => {
  const f = await fixture(); await f.service.setConsent(false);
  const preview = f.service.preview({ description: '功能按钮不可用' });
  assert.equal((await f.service.manual({}, '', preview)).ok, true);
  assert.deepEqual(f.calls[0].payload, preview);
  assert.equal(f.calls[0].credentials, 'omit'); assert.equal(f.calls[0].redirect, 'error');
  assert.equal(f.data[f.key].anonymousId, null);
  assert.equal((await f.service.manual({ description: 'again' })).reason, 'cooldown');
  f.advance(60000); assert.equal((await f.service.manual({ description: 'again' })).ok, true);
});

test('redaction removes contact, credentials, URLs and OS user paths', () => {
  const raw = '姓名：张三\nmail a@example.com phone +86 138-1234-5678 ID 110105199001011234\nhttps://host.test/path?key=secret C:\\Users\\张三\\file /Users/alice/file /home/bob/file Bearer password123 sk-123456789abcdef';
  const result = core.redact(raw);
  for (const secret of ['张三', 'a@example.com', '138', '110105', 'host.test', 'alice', 'bob', 'password123', '123456789abcdef']) assert.ok(!result.includes(secret), secret);
});

test('diagnostics reject raw content/attributes while retaining counts and known control structure', () => {
  const input = '网申快填 v0.4.1\n结果：部分完成；错误类别：http\n网页字段：5；成功填写：2；没填上：1\n页面：https://example.com/resume?secret=123\n- 张三：input[text] role=textbox data-secret=secret｜敏感内容\n- 姓名：input[text]\nAPI key: secret\n简历全文';
  const out = core.diagnostics(input);
  assert.match(out, /网页字段：5/); assert.match(out, /姓名：input\[text\]/); assert.match(out, /字段名已隐藏/);
  for (const secret of ['张三','secret','example.com','敏感内容','简历全文']) assert.ok(!out.includes(secret));
});

test('foreign page errors are excluded; extension frames drop messages, paths and function names', () => {
  const origin = 'chrome-extension://example/';
  assert.equal(core.exception({ stack: 'Error secret\n at https://c.liepin.com/app.js:1:2' }, origin).stack, '');
  const result = core.exception({ name: 'TypeError', message: 'resume', stack: `TypeError: resume\n at privateName (${origin}content.js:10:2)\n at https://host/a:2:3` }, origin);
  assert.equal(result.stack, 'content.js:10:2'); assert.ok(!JSON.stringify(result).includes('resume'));
});

test('fill auto triggers and exclusions', () => {
  const base = { fieldCount: 3, filledCount: 3, unfilledCount: 0 };
  assert.equal(core.fillFailure(base), null);
  assert.equal(core.fillFailure({ ...base, fieldCount: 0, filledCount: 0 }), 'fill_failed');
  assert.equal(core.fillFailure({ ...base, filledCount: 0, editHint: true }), 'fill_failed');
  assert.equal(core.fillFailure({ ...base, filledCount: 2, unfilledCount: 1 }), 'fill_partial');
  for (const key of ['assisted','cancelled','overwriteDeclined']) assert.equal(core.fillFailure({ ...base, fieldCount: 0, [key]: true }), null);
});

test('router rejects foreign senders and binds exact previews to one privileged document', async () => {
  const { installFeedback } = await import('../link/feedback.mjs');
  const originalFetch = global.fetch;
  const calls = []; const data = {}; let listener;
  global.fetch = async (_url, req) => { calls.push(JSON.parse(req.body)); return new Response('{"ok":true,"id":"router-test"}'); };
  try {
    const origin = 'chrome-extension://test/';
    const api = {
      runtime: { id: 'test', getURL: p => origin + p, getManifest: () => ({ version: '0.4.1' }), onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) } },
      tabs: { get: async () => ({ url: 'https://c.liepin.com/resume?private=value' }) }
    };
    installFeedback(api);
    const page = { id: 'test', url: origin + 'sidepanel.html', documentId: 'doc-a' };
    const content = { id: 'test', url: 'https://c.liepin.com/resume?private=value', tab: { id: 1 } };
    const message = (body, sender = page) => new Promise(resolve => listener(body, sender, resolve));
    assert.equal((await message({ type: 'FEEDBACK_CONSENT', enabled: true }, content)).ok, false);
    assert.equal((await message({ type: 'FEEDBACK_CONSENT', enabled: true }, { ...page, id: 'other' })).ok, false);
    assert.equal((await message({ type: 'FEEDBACK_NOTICE_SEEN' }, content)).ok, false);
    await message({ type: 'FEEDBACK_CONSENT', enabled: false });
    await message({ type: 'FEEDBACK_AUTO', report: crash }, content); assert.equal(calls.length, 0);
    await message({ type: 'FEEDBACK_CONSENT', enabled: true });
    await message({ type: 'FEEDBACK_AUTO', report: { ...crash, stack: '' } }, content); assert.equal(calls.length, 0);
    await message({ type: 'FEEDBACK_AUTO', report: crash }, content); assert.equal(calls.length, 1);
    assert.match(calls[0].user_description, /网站: c.liepin.com/);
    assert.ok(!JSON.stringify(calls[0]).includes('private'));
    const stolen = await message({ type: 'FEEDBACK_PREVIEW', description: '按钮不可用', tabId: 1 });
    assert.equal((await message({ type: 'FEEDBACK_SEND', token: stolen.token }, { ...page, documentId: 'doc-b' })).ok, false);
    const draft = await message({ type: 'FEEDBACK_PREVIEW', description: '按钮不可用', tabId: 1 });
    assert.equal((await message({ type: 'FEEDBACK_SEND', token: draft.token, description: 'unreviewed' })).ok, true);
    assert.deepEqual(calls[1], draft.payload);
    assert.equal((await message({ type: 'FEEDBACK_SEND', token: draft.token })).ok, false);
    api.tabs.get = async () => { throw new Error('tab closed'); };
    const closed = await message({ type: 'FEEDBACK_PREVIEW', description: '仍能反馈', tabId: 1 });
    assert.equal(closed.ok, true);
    assert.ok(!closed.payload.user_description.includes('网站:'));
  } finally { global.fetch = originalFetch; }
});

test('disabling aborts active automatic reports and blocks subsequent attempts', async () => {
  let started; const signalReady = new Promise(resolve => { started = resolve; });
  const f = await fixture({ fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    started(); signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  await f.service.setConsent(true);
  const sending = f.service.automatic(crash); await signalReady;
  await f.service.setConsent(false);
  assert.equal((await sending).ok, false);
  assert.equal((await f.service.automatic({ ...crash, stack: 'content.js:200:1' })).reason, 'suppressed');
});


test('manual redaction removes quoted JSON tokens and Basic credentials before preview', async () => {
  const f = await fixture();
  for (const description of ['{"authToken":"privateCredential"}', '{"token":"privateCredential"}', 'Basic privateCredential', 'access_token=privateCredential', '{"apiKey":"privateCredential"}', "'password': 'privateCredential'"]) {
    const preview = f.service.preview({ description });
    assert.ok(!preview.user_description.includes('privateCredential'), description);
  }
});

test('content hooks reject synthetic events, filename-only errors and extension URLs embedded in messages', () => {
  const vm = require('node:vm'); const fs = require('node:fs'); const handlers = {}; const reports = [];
  const context = { addEventListener: (name, fn) => { handlers[name] = fn; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../feedback-core.js'), 'utf8'), context);
  const origin = 'chrome-extension://example/';
  context.ResumeProFeedback.install(report => reports.push(report), { origin, requireOwn: true });
  const makeOwnError = vm.runInContext('(message, stack) => { const error = new Error(message); error.stack = stack; return error; }', context);
  const own = makeOwnError('failure', `Error: failure\n at test (${origin}content.js:1:2)`);
  handlers.error({ isTrusted: false, error: own, filename: origin + 'content.js', lineno: 1, colno: 2 });
  handlers.error({ isTrusted: true, filename: origin + 'content.js', lineno: 1, colno: 2 });
  handlers.unhandledrejection({ isTrusted: false, reason: own });
  const message = `pretend\n at ${origin}content.js:1:2`;
  handlers.error({ isTrusted: true, error: { name: 'Error', message, stack: `Error: ${message}\n at https://page.test/app.js:1:2` } });
  assert.equal(reports.length, 0);
  const foreign = new Error('forged'); foreign.stack = own.stack;
  handlers.error({ isTrusted: true, error: foreign, filename: origin + 'content.js' });
  handlers.unhandledrejection({ isTrusted: true, reason: foreign });
  handlers.error({ isTrusted: true, error: own, filename: 'https://page.test/app.js' });
  assert.equal(reports.length, 0);
  handlers.error({ isTrusted: true, error: own, filename: origin + 'content.js' }); assert.equal(reports.length, 1);
  assert.equal(reports[0].stack, 'content.js:1:2');
});

test('manual redaction removes whole sensitive headers and common unlabelled tokens', () => {
  for (const raw of ['Cookie: a=privateOne; b=privateTwo', 'Authorization: Basic privateOne; extra=privateTwo', 'ghp_abcdefghijklmnopqr', 'xoxb-abcdefghijklmno', 'eyJabcdefghij.abcdefghijk.abcdefghijk']) {
    const safe = core.redact(raw);
    assert.ok(!/privateOne|privateTwo|abcdefghijkl/.test(safe), raw);
  }
});

test('the real AI worker leaves uncaught errors to its host and reports rejections once', () => {
  const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
  const handlers = {}; const messages = [];
  const self = { location: { href: 'chrome-extension://test/ai-worker.js' }, addEventListener: (name, fn) => { handlers[name] = fn; }, postMessage: message => messages.push(message) };
  const context = vm.createContext({ self, console, URL, TextEncoder, AbortController, setTimeout, clearTimeout });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ai-worker.js'), 'utf8'), context);
  assert.equal(handlers.error, undefined);
  handlers.unhandledrejection({ reason: { name: 'TypeError', message: 'private', stack: 'TypeError: private\n at chrome-extension://test/ai-worker.js:10:2' } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'feedback-error');
  assert.equal(messages[0].report.stack, 'ai-worker.js:10:2');
});


test('notice acknowledgement persists without overriding another page opt-out', async () => {
  const f = await fixture();
  await f.service.status();
  assert.deepEqual(await f.service.acknowledgeNotice(), { consent: true, noticeSeen: true });
  await f.service.setConsent(false);
  assert.deepEqual(await f.service.acknowledgeNotice(), { consent: false, noticeSeen: true });
  const restart = await fixture({ data: f.data });
  await restart.service.automatic(crash);
  assert.equal(restart.calls.length, 0);
  assert.equal((await restart.service.status()).consent, false);
});
test('migration preserves prior explicit choices and enables only undecided installations', async () => {
  for (const previous of [true, false, null]) {
    const f = await fixture({ data: { feedbackStateV1: { consent: previous, anonymousId: previous === true ? 'existing-id' : null } } });
    assert.deepEqual(await f.service.status(), { consent: previous !== false, noticeSeen: previous !== null });
    if (previous === false) assert.equal(f.data[f.key].anonymousId, null);
    if (previous === true) assert.equal(f.data[f.key].anonymousId, 'existing-id');
  }
});
test('default initialization cannot send when preferences cannot be persisted', async () => {
  const { createFeedback } = await import('../link/feedback.mjs');
  let requests = 0;
  const service = createFeedback({ storage: { get: async () => ({}), set: async () => { throw new Error('disk'); } }, fetchImpl: async () => { requests++; }, version: 'test', os: 'test' });
  await assert.rejects(service.automatic(crash), /disk/);
  assert.equal(requests, 0);
});
