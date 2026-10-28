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
    now: () => time, version: '0.4.1', os: 'macOS / Edge 140', timeoutMs: 20, install: options.install,
    fetchImpl: options.fetchImpl || (async (url, request) => { calls.push({ url, ...request, payload: JSON.parse(request.body) }); return new Response(JSON.stringify({ ok: true, id: 'test-123' })); })
  });
  return { service, data, calls, key: STORAGE_KEY, advance: ms => { time += ms; } };
}
const crash = { kind: 'exception', name: 'TypeError', source: 'error', stack: 'content.js:100:2', message: 'Secret name and resume data' };

test('new installs send and store nothing until the user agrees; opt out deletes identity', async () => {
  const f = await fixture();
  assert.deepEqual(await f.service.status(), { consent: false, decided: false });
  assert.equal((await f.service.automatic({ ...crash, stack: 'content.js:9:1' }, 'c.liepin.com')).reason, 'suppressed');
  assert.equal(f.calls.length, 0);
  // No identity and no dedup record: an error from before the choice leaves nothing to send later.
  assert.equal(f.data[f.key], undefined);
  const restart = await fixture({ data: f.data });
  assert.deepEqual(await restart.service.status(), { consent: false, decided: false });
  assert.deepEqual(await f.service.setConsent(true), { consent: true, decided: true });
  assert.equal(f.calls.length, 0);
  const id = f.data[f.key].anonymousId; assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(f.data[f.key].consentVersion, (await import('../link/feedback.mjs')).CONSENT_VERSION);
  await f.service.automatic(crash, 'c.liepin.com'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.anonymous_id, id);
  assert.ok(!JSON.stringify(f.calls[0].payload).includes('Secret'));
  assert.match(f.calls[0].payload.user_description, /^host: c\.liepin\.com$/m);
  assert.deepEqual(await f.service.setConsent(false), { consent: false, decided: true });
  assert.equal(f.data[f.key].anonymousId, null);
  await f.service.automatic({ ...crash, stack: 'content.js:300:1' }); assert.equal(f.calls.length, 1);
  assert.deepEqual(await (await fixture({ data: f.data })).service.status(), { consent: false, decided: true });
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

test('code errors stop at five an hour; fill reports have their own twenty and dedup by host and type', async () => {
  const f = await fixture(); await f.service.setConsent(true);
  for (let i = 0; i < 6; i++) await f.service.automatic({ ...crash, stack: `content.js:${i}:1` });
  assert.equal(f.calls.length, 5);
  // A long application session: every site is new, and code errors used up their own budget only.
  for (let i = 0; i < 22; i++) await f.service.automatic({ kind: 'fill_partial' }, `site${i}.example.com`);
  assert.equal(f.calls.length, 25);
  await f.service.automatic({ kind: 'fill_failed' }, 'c.liepin.com'); assert.equal(f.calls.length, 25);
  f.advance(3600001);
  await f.service.automatic({ kind: 'fill_failed' }, 'c.liepin.com'); assert.equal(f.calls.length, 26);
  await f.service.automatic({ kind: 'fill_failed' }, 'c.liepin.com'); assert.equal(f.calls.length, 26);
  await f.service.automatic({ kind: 'fill_partial' }, 'c.liepin.com'); assert.equal(f.calls.length, 27);
  await f.service.automatic({ kind: 'fill_partial' }, 'site0.example.com'); assert.equal(f.calls.length, 27);
  await f.service.automatic({ ...crash, stack: 'content.js:99:1' }); assert.equal(f.calls.length, 28);
  // State saved before this split has no fill bucket (or a damaged one); it reads as empty.
  for (const fillHourly of [undefined, null, 'x']) {
    const saved = { ...f.data[f.key], fillHourly };
    if (fillHourly === undefined) delete saved.fillHourly;
    const old = await fixture({ data: { feedbackStateV1: saved } });
    await old.service.automatic({ kind: 'fill_partial' }, 'new.example.com'); assert.equal(old.calls.length, 1);
  }
});

test('a failed AI request and fields the page did not take keep separate daily slots per site', async () => {
  // #301 U1: a failed AI request is reported even when every local match got written. A timeout or an
  // outage that comes first must not hold back that day's report of fields the site did not take.
  let offline = true;
  const sent = [];
  const f = await fixture({ fetchImpl: async (_url, request) => {
    if (offline) throw new TypeError('Failed to fetch');
    sent.push(JSON.parse(request.body)); return new Response(JSON.stringify({ ok: true, id: 'x' }));
  } });
  await f.service.setConsent(true);
  const report = category => ({ kind: 'fill_partial', diagnostics: `[错误]\nerror_category: ${category}` });
  // Offline: the AI request failed, and so did the report. It still takes its slot.
  assert.equal((await f.service.automatic(report('service_error'), 'jobs.example.test')).reason, 'network');
  offline = false; f.advance(3600000);
  assert.equal((await f.service.automatic(report('fill_rejected'), 'jobs.example.test')).ok, true);
  for (const category of ['timeout', 'service_error', 'fill_rejected', 'match_failed']) {
    assert.equal((await f.service.automatic(report(category), 'jobs.example.test')).reason, 'suppressed', category);
  }
  assert.equal(sent.length, 1);
  // The other way round, on another site: a timeout first, then fields not taken.
  assert.equal((await f.service.automatic(report('timeout'), 'c.liepin.com')).ok, true);
  assert.equal((await f.service.automatic(report('fill_rejected'), 'c.liepin.com')).ok, true);
  assert.deepEqual(sent.map(body => body.user_description.match(/^error_category: (.*)$/m)[1]), ['fill_rejected', 'timeout', 'fill_rejected']);
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

test('reports carry the v1 block: the worker writes [来源], the page only supplies allowlisted sections', async () => {
  const f = await fixture(); await f.service.setConsent(true);
  const page = core.fillReport({ path: '/apply/12345', fieldCount: 0, filledCount: 0, category: 'no_fields_found', stage: 'scan' });
  await f.service.automatic({ kind: 'fill_failed', diagnostics: `${page}\n[来源]\nhost: evil.example\napp_version: 9.9.9\npage_title: 张三的简历` }, 'c.liepin.com');
  const text = f.calls[0].payload.user_description;
  assert.ok(text.startsWith(`--- 诊断信息 v1 ---\n[来源]\napp_version: 0.4.1\nos: macOS / Edge 140\nhost: c.liepin.com\n\n[页面]\nurl_path: /apply/:id\n`), text);
  for (const forged of ['evil.example', '9.9.9', '张三', 'page_title']) assert.ok(!text.includes(forged), forged);
  assert.equal(f.service.preview({ description: '按钮不可用' }).user_description,
    '按钮不可用\n--- 诊断信息 v1 ---\n[来源]\napp_version: 0.4.1\nos: macOS / Edge 140');
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
    await message({ type: 'FEEDBACK_AUTO', report: crash }, content); assert.equal(calls.length, 0);
    assert.deepEqual(await message({ type: 'FEEDBACK_STATUS' }), { consent: false, decided: false });
    assert.equal((await message({ type: 'FEEDBACK_CONSENT', enabled: true }, content)).ok, false);
    assert.equal((await message({ type: 'FEEDBACK_CONSENT', enabled: true }, { ...page, id: 'other' })).ok, false);
    // Folding a notice is no longer a message at all, so it cannot stand in for a choice.
    assert.equal((await message({ type: 'FEEDBACK_NOTICE_SEEN' })).ok, false);
    assert.deepEqual(await message({ type: 'FEEDBACK_STATUS' }), { consent: false, decided: false });
    await message({ type: 'FEEDBACK_CONSENT', enabled: false });
    await message({ type: 'FEEDBACK_AUTO', report: crash }, content); assert.equal(calls.length, 0);
    await message({ type: 'FEEDBACK_CONSENT', enabled: true });
    await message({ type: 'FEEDBACK_AUTO', report: { ...crash, stack: '' } }, content); assert.equal(calls.length, 0);
    await message({ type: 'FEEDBACK_AUTO', report: crash }, content); assert.equal(calls.length, 1);
    assert.match(calls[0].user_description, /^host: c\.liepin\.com$/m);
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
    assert.ok(!closed.payload.user_description.includes('host:'));
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


test('upgrades treat earlier default grants as undecided and keep every opt-out', async () => {
  const { CONSENT_VERSION } = await import('../link/feedback.mjs');
  const undecided = { consent: false, decided: false };
  const cases = [
    // Written by the default-on builds: never shown, folded with 「知道了」, or switched on by hand.
    // The last two look the same in storage, so none of them proves a choice.
    [{ consent: true, noticeSeen: false, anonymousId: 'old-id' }, undecided],
    [{ consent: true, noticeSeen: true, anonymousId: 'old-id' }, undecided],
    [{ consent: true, anonymousId: 'old-id' }, undecided],
    [{ consent: true, consentVersion: CONSENT_VERSION + 1, anonymousId: 'old-id' }, undecided],
    [{ consent: null, noticeSeen: false }, undecided],
    [{ consent: false, noticeSeen: true, anonymousId: null }, { consent: false, decided: true }],
    [{ consent: false }, { consent: false, decided: true }],
    [{ consent: true, consentVersion: CONSENT_VERSION, anonymousId: 'granted-id' }, { consent: true, decided: true }]
  ];
  for (const [stored, expected] of cases) {
    const label = JSON.stringify(stored);
    const f = await fixture({ data: { feedbackStateV1: stored } });
    assert.deepEqual(await f.service.status(), expected, label);
    await f.service.automatic(crash);
    assert.equal(f.calls.length, expected.consent ? 1 : 0, label);
    if (expected.consent) assert.equal(f.calls[0].payload.anonymous_id, 'granted-id');
    else assert.ok(!JSON.stringify(f.data).includes('old-id'), label);
    assert.deepEqual(await (await fixture({ data: f.data })).service.status(), expected, label);
  }
});
test('storage failures never turn automatic reports on', async () => {
  const { createFeedback } = await import('../link/feedback.mjs');
  let requests = 0;
  const options = { fetchImpl: async () => { requests++; }, version: 'test', os: 'test' };
  const broken = createFeedback({ ...options, storage: { get: async () => ({}), set: async () => { throw new Error('disk'); } } });
  assert.equal((await broken.automatic(crash)).reason, 'suppressed');
  await assert.rejects(broken.setConsent(true), /disk/);
  assert.equal((await broken.automatic(crash)).reason, 'suppressed');
  // An old default grant whose downgrade cannot be written is still treated as undecided.
  const legacy = createFeedback({ ...options, storage: { get: async () => ({ feedbackStateV1: { consent: true, anonymousId: 'old-id' } }), set: async () => { throw new Error('disk'); } } });
  assert.deepEqual(await legacy.status(), { consent: false, decided: false });
  assert.equal((await legacy.automatic(crash)).reason, 'suppressed');
  const unreadable = createFeedback({ ...options, storage: { get: async () => { throw new Error('read'); }, set: async () => {} } });
  await assert.rejects(unreadable.automatic(crash), /read/);
  assert.equal(requests, 0);
});
test('an install or update that leaves the choice open shows it right away; a made choice is not asked again', async () => {
  const { installFeedback, CONSENT_VERSION } = await import('../link/feedback.mjs');
  const cases = [
    ['install', undefined, true],
    ['update', undefined, true],
    // 0.4.1 had no reports; an earlier test build's default grant is no choice either.
    ['update', { consent: true, noticeSeen: true, anonymousId: 'old-id' }, true],
    ['update', { consent: false }, false],
    ['update', { consent: true, consentVersion: CONSENT_VERSION, anonymousId: 'granted-id' }, false],
    ['chrome_update', undefined, false]
  ];
  for (const [reason, stored, opens] of cases) {
    const data = stored ? { feedbackStateV1: stored } : {};
    const opened = []; let onInstalled;
    installFeedback({
      runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0.4.2' }),
        onMessage: { addListener: () => {} }, onInstalled: { addListener: fn => { onInstalled = fn; } } },
      storage: { local: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) } },
      tabs: { create: async ({ url }) => { opened.push(url); } }
    });
    onInstalled({ reason });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(opened, opens ? ['chrome-extension://test/popup.html'] : [], `${reason} ${JSON.stringify(stored)}`);
  }
});

// #301：告知版本升到 2（自动报告多了安装方式、填写入口和网页焦点、AI 档位、下拉弹层计数，AI 请求失败也上报）。
test('a grant given under the version-1 notice is asked again: nothing is sent until the user agrees; an opt-out stays', async () => {
  const { CONSENT_VERSION, installFeedback } = await import('../link/feedback.mjs');
  assert.equal(CONSENT_VERSION, 2);
  const v1 = { consent: true, consentVersion: 1, anonymousId: 'v1-id', recent: {}, hourly: [], fillHourly: [] };
  const f = await fixture({ data: { feedbackStateV1: structuredClone(v1) } });
  // Marked as renewed, so the choice can say the notice changed.
  const renewed = { consent: false, decided: false, renewed: true };
  assert.deepEqual(await f.service.status(), renewed);
  await f.service.automatic(crash, 'c.liepin.com');
  await f.service.automatic({ kind: 'fill_partial', diagnostics: '[错误]\nerror_category: timeout' }, 'c.liepin.com');
  assert.equal(f.calls.length, 0, 'nothing is sent on the old grant');
  assert.ok(!JSON.stringify(f.data).includes('v1-id'), 'the old installation id is gone');
  assert.deepEqual(await (await fixture({ data: f.data })).service.status(), renewed, 'still undecided after a restart');
  // An update that leaves the version-1 grant behind opens the choice right away.
  const opened = []; let onInstalled;
  const stored = { feedbackStateV1: structuredClone(v1) };
  installFeedback({
    runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, getManifest: () => ({ version: '0.4.5' }),
      onMessage: { addListener: () => {} }, onInstalled: { addListener: fn => { onInstalled = fn; } } },
    storage: { local: { get: async () => structuredClone(stored), set: async value => Object.assign(stored, structuredClone(value)) } },
    tabs: { create: async ({ url }) => { opened.push(url); } }
  });
  onInstalled({ reason: 'update' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(opened, ['chrome-extension://test/popup.html']);
  // Agreeing to the current notice starts sending again, under a new id.
  assert.deepEqual(await f.service.setConsent(true), { consent: true, decided: true });
  assert.equal(f.data[f.key].consentVersion, 2);
  assert.equal('renewed' in f.data[f.key], false, 'a made choice clears the mark');
  await f.service.automatic(crash, 'c.liepin.com');
  assert.equal(f.calls.length, 1);
  assert.notEqual(f.calls[0].payload.anonymous_id, 'v1-id');
  // Opting out under version 1 stays an opt-out.
  for (const optOut of [{ consent: false, consentVersion: 0, anonymousId: null }, { consent: false, consentVersion: 1 }, { consent: false }]) {
    const out = await fixture({ data: { feedbackStateV1: optOut } });
    assert.deepEqual(await out.service.status(), { consent: false, decided: true }, JSON.stringify(optOut));
    await out.service.automatic(crash, 'c.liepin.com');
    assert.equal(out.calls.length, 0);
  }
});

test('[来源] carries the install type for automatic and manual reports; an unknown, failed or slow lookup leaves it out', async () => {
  for (const type of ['normal', 'development', 'sideload', 'admin', 'other']) {
    const f = await fixture({ install: async () => type });
    await f.service.setConsent(true);
    await f.service.automatic(crash, 'c.liepin.com');
    assert.match(f.calls[0].payload.user_description, new RegExp(`\\[来源\\]\\napp_version: 0\\.4\\.1\\nos: macOS / Edge 140\\ninstall: ${type}\\nhost: c\\.liepin\\.com`));
    await f.service.ready();
    assert.match(f.service.preview({ description: '按钮不可用' }).user_description, new RegExp(`^install: ${type}$`, 'm'));
  }
  const never = new Promise(() => {});
  for (const install of [async () => 'store', async () => '张三 https://evil.example', () => undefined,
    () => { throw new Error('no management'); }, async () => { throw new Error('getSelf failed'); }, () => never]) {
    const f = await fixture({ install });
    await f.service.setConsent(true);
    await f.service.automatic(crash, 'c.liepin.com');
    assert.equal(f.calls.length, 1, 'the report still goes out');
    const text = f.calls[0].payload.user_description;
    assert.doesNotMatch(text, /install:|张三|evil|store/);
    assert.match(text, /^os: macOS \/ Edge 140\nhost: c\.liepin\.com$/m);
  }
  // A page cannot supply it.
  const f = await fixture({ install: async () => 'normal' });
  await f.service.setConsent(true);
  await f.service.automatic({ kind: 'fill_failed', diagnostics: '[来源]\ninstall: development\n[错误]\nerror_category: unknown' }, 'c.liepin.com');
  assert.equal(f.calls[0].payload.user_description.match(/^install: .*$/gm).join(), 'install: normal');
});

test('an error from before a choice is dropped, even while the install type is still being looked up', async () => {
  // automatic() waits for the install type (up to a second) before it reads the choice. A choice made
  // in that time came after the error, so the report belongs to the earlier choice and is not sent.
  const slow = () => new Promise(resolve => setTimeout(resolve, 50, 'normal'));
  const later = () => new Promise(resolve => setTimeout(resolve, 2));
  const cases = {
    'undecided, then agreed': [{}, async s => { await s.setConsent(true); }],
    'a version-1 grant asked again, then agreed': [{ feedbackStateV1: { consent: true, consentVersion: 1, anonymousId: 'v1-id' } },
      async s => { await s.setConsent(true); }],
    'agreed, then turned off and on': [null, async s => { await s.setConsent(false); await s.setConsent(true); }]
  };
  for (const [name, [data, choose]] of Object.entries(cases)) {
    const f = await fixture({ install: slow, data: data || {} });
    if (!data) await f.service.setConsent(true);
    const auto = f.service.automatic(crash, 'c.liepin.com');
    await later();
    await choose(f.service);
    assert.equal((await auto).reason, 'suppressed', name);
    assert.equal(f.calls.length, 0, name);
    await f.service.automatic({ ...crash, stack: 'content.js:7:1' }, 'c.liepin.com');
    assert.equal(f.calls.length, 1, `${name}: errors after the choice are sent`);
  }
  // A choice made before the error still counts: the report waits for the lookup and carries it.
  const f = await fixture({ install: slow });
  await f.service.setConsent(true);
  assert.equal((await f.service.automatic(crash, 'c.liepin.com')).ok, true);
  assert.match(f.calls[0].payload.user_description, /^install: normal$/m);
});

test('the router reads the install type from chrome.management.getSelf, and goes on without it', async () => {
  const { installFeedback } = await import('../link/feedback.mjs');
  const originalFetch = global.fetch;
  try {
    for (const [management, line] of [[{ getSelf: async () => ({ id: 'x', installType: 'development', name: '网申快填' }) }, /^install: development$/m],
      [undefined, null], [{ getSelf: async () => { throw new Error('denied'); } }, null]]) {
      const calls = []; const data = {}; let listener;
      global.fetch = async (_url, req) => { calls.push(JSON.parse(req.body)); return new Response('{"ok":true,"id":"r"}'); };
      const origin = 'chrome-extension://test/';
      installFeedback({
        runtime: { id: 'test', getURL: p => origin + p, getManifest: () => ({ version: '0.4.5' }), onMessage: { addListener: fn => { listener = fn; } } },
        storage: { local: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) } },
        tabs: { get: async () => ({ url: 'https://c.liepin.com/resume' }) },
        ...(management ? { management } : {})
      });
      const page = { id: 'test', url: `${origin}sidepanel.html`, documentId: 'doc' };
      const message = (body, sender = page) => new Promise(resolve => listener(body, sender, resolve));
      await message({ type: 'FEEDBACK_CONSENT', enabled: true });
      await message({ type: 'FEEDBACK_AUTO', report: crash }, { id: 'test', url: 'https://c.liepin.com/resume', tab: { id: 1 } });
      const draft = await message({ type: 'FEEDBACK_PREVIEW', description: '按钮不可用', tabId: 1 });
      for (const text of [calls[0].user_description, draft.payload.user_description]) {
        if (line) assert.match(text, line); else assert.doesNotMatch(text, /install:/);
      }
    }
  } finally { global.fetch = originalFetch; }
});

test('automatic reports never carry the job flow [岗位]; a manual preview keeps it', async () => {
  const job = core.jobReport({ companySource: 'structured', titleSource: 'ai', missingCompany: false, missingTitle: false, aiCalled: true, aiCode: 'ok', end: 'saved' });
  const fill = core.fillReport({ path: '/apply', fieldCount: 0, filledCount: 0, category: 'no_fields_found', stage: 'scan' });
  const f = await fixture(); await f.service.setConsent(true);
  await f.service.automatic({ kind: 'fill_failed', diagnostics: `${fill}\n\n${job}` }, 'c.liepin.com');
  const sent = f.calls[0].payload.user_description;
  assert.match(sent, /^error_category: no_fields_found$/m);
  assert.doesNotMatch(sent, /岗位|job_/);
  const preview = f.service.preview({ description: '保存岗位时没读出岗位名', diagnostics: `${fill}\n\n${job}` }).user_description;
  assert.ok(preview.endsWith(`\n\n${job}`), preview);
});

test('a choice brought back by a new notice says the report contents changed; a first choice does not', async () => {
  const { JSDOM } = require('jsdom');
  const fs = require('node:fs');
  const path = require('node:path');
  const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const mount = async (variant, status) => {
    const { window } = new JSDOM(variant === 'compact'
      ? '<div id="feedback-notice-root" hidden></div><div id="feedback-manual-root"></div><div id="feedback-auto-root" data-variant="compact"></div>'
      : '<div id="feedback-auto-root"></div>', { runScripts: 'outside-only' });
    window.chrome = {
      runtime: { sendMessage: async message => message.type === 'FEEDBACK_STATUS' ? status
        : message.type === 'FEEDBACK_CONSENT' ? { consent: message.enabled, decided: true } : { ok: false } },
      tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      storage: { onChanged: { addListener() {} } }
    };
    window.eval(read('feedback-core.js'));
    window.eval(read('feedback-ui.js'));
    await new Promise(resolve => setTimeout(resolve, 10));
    return window.document.getElementById('feedback-renewed');
  };
  for (const variant of ['compact', 'status']) {
    const renewed = await mount(variant, { consent: false, decided: false, renewed: true });
    assert.equal(renewed.hidden, false, variant);
    assert.equal(renewed.textContent, '报告内容有更新，需要重新选择。');
    assert.equal((await mount(variant, { consent: false, decided: false })).hidden, true, `${variant}: a first choice`);
    assert.equal((await mount(variant, { consent: true, decided: true })).hidden, true, `${variant}: already chosen`);
  }
  const renewed = await mount('status', { consent: false, decided: false, renewed: true });
  renewed.ownerDocument.getElementById('feedback-enable').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(renewed.hidden, true, 'gone once chosen');
});
