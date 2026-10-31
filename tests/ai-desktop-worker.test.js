const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'ai-worker.js'), 'utf8');
const helpers = require('../ai-helpers.js');
const BASE = {
  formFields: [{ fieldId: 'name', label: '姓名' }, { fieldId: 'school', label: '学校' }],
  resumeFields: [{ group: '基本信息', key: '姓名', value: '测试用户' }, { group: '教育背景', key: '学校', value: '大学乙' }]
};

function worker(respond = () => ({ ok: true, text: '[{"fieldId":"school","value":"大学乙"}]' }), { now = () => 0 } = {}) {
  const sent = [];
  let sequence = 0;
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers,
    ResumeProProfile: require('../profile-fields.js'),
    ResumeProFormAgent: require('../form-agent.js'),
    AbortController, TextEncoder, performance: { now },
    crypto: { randomUUID: () => `synthetic-${++sequence}` }
  });
  context.self = {
    postMessage(message) {
      sent.push(message);
      if (message.kind === 'desktop-complete') {
        Promise.resolve(respond(message)).then(reply => {
          context.self.onmessage({ data: { kind: 'desktop-result', callId: message.callId, reply } });
        });
      }
    }
  };
  vm.runInContext(source, context);
  return { context, sent, run: (input = BASE, controller) => context.handleAiFill(input, controller) };
}

test('AI fill keeps local rules and parses only desktop response text', async () => {
  const env = worker();
  const result = await env.run({ ...BASE, aiConfig: { apiKey: 'should-never-leave' } });
  assert.equal(result.success, true);
  assert.equal(result.matches.length, 2);
  assert.equal(env.sent[0].purpose, 'fill');
  assert.equal(typeof env.sent[0].system, 'string');
  assert.ok(env.sent[0].user.includes('学校'));
  assert.ok(!JSON.stringify(env.sent).includes('should-never-leave'));
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test('a fill without a tier sends none and adds nothing to the diagnostics', async () => {
  const env = worker();
  const result = await env.run();
  assert.equal(env.sent.find(item => item.kind === 'desktop-complete').tier, undefined);
  assert.equal('tierRequested' in result.diagnostics, false);
  assert.equal('tierUsed' in result.diagnostics, false);
});

test('a strong re-match asks for the tier and records the tier the desktop used', async () => {
  const env = worker(() => ({ ok: true, text: '[{"fieldId":"school","value":"大学乙"}]', tier: 'default' }));
  const result = await env.run({ ...BASE, tier: 'strong' });
  assert.equal(env.sent.find(item => item.kind === 'desktop-complete').tier, 'strong');
  assert.equal(result.diagnostics.tierRequested, 'strong');
  assert.equal(result.diagnostics.tierUsed, 'default');

  const unknown = worker();
  await unknown.run({ ...BASE, tier: 'turbo' });
  assert.equal(unknown.sent.find(item => item.kind === 'desktop-complete').tier, undefined, 'an unknown tier is dropped, not forwarded');

  const old = worker(() => ({ ok: false, reason: 'incompatible' }));
  const failed = await old.run({ ...BASE, tier: 'strong' });
  assert.match(failed.warning, /用强模型重新匹配需要更新桌面程序/);
  assert.equal('tierUsed' in failed.diagnostics, false);
  const daily = await old.run({ ...BASE, tier: 'default' });
  assert.match(daily.warning, /桌面程序版本太旧/, 'an explicit daily tier is not about the strong model');
});

test('a strong provider without a key is named as the problem, not the current provider', async () => {
  const env = worker(() => ({ ok: false, reason: 'not_configured', tier: 'strong' }));
  const result = await env.run({ ...BASE, tier: 'strong' });
  assert.match(result.warning, /强模型那条服务商还没有 Key/);
  assert.doesNotMatch(result.warning, /当前服务商没有 Key/);
  assert.equal(result.openView, 'settings-ai');
  // Nothing configured at all is still the general message.
  const none = worker(() => ({ ok: false, reason: 'not_configured' }));
  assert.match((await none.run({ ...BASE, tier: 'strong' })).warning, /桌面还没有配置 AI 服务商/);
});

test('oversized form prompts are split beneath the UTF-8 user budget', async () => {
  const env = worker(() => ({ ok: true, text: '[]' }));
  const input = {
    formFields: Array.from({ length: 24 }, (_, i) => ({ fieldId: `f${i}`, label: `问题${i}` + '甲'.repeat(1000) })),
    resumeFields: [{ group: '自定义', key: '说明', value: '乙'.repeat(2000) }]
  };
  await env.run(input);
  const calls = env.sent.filter(item => item.kind === 'desktop-complete');
  assert.ok(calls.length > 1);
  const budget = vm.runInContext('AI_USER_BUDGET', env.context);
  const { buildEnvelope } = await import('../link/envelope.mjs');
  for (const call of calls) {
    assert.ok(Buffer.byteLength(JSON.stringify(call.user)) <= budget);
    const envelope = await buildEnvelope({
      messageType: 'ai.complete', messageId: '33333333-3333-4333-8333-333333333333',
      clientInstanceId: '11111111-1111-4111-8111-111111111111',
      payload: { purpose: call.purpose, system: call.system, user: call.user }
    });
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 65536);
  }
});

test('quote-heavy fields are split using their escaped wire length', async () => {
  const env = worker(() => ({ ok: true, text: '[]' }));
  await env.run({
    formFields: Array.from({ length: 12 }, (_, i) => ({ fieldId: `q${i}`, label: `问题${i}`, options: Array.from({ length: 35 }, () => '"\\'.repeat(18)) })),
    resumeFields: [{ group: '自定义', key: '说明', value: '合成资料' }]
  });
  const calls = env.sent.filter(item => item.kind === 'desktop-complete');
  assert.ok(calls.length > 1);
  const budget = vm.runInContext('AI_USER_BUDGET', env.context);
  for (const call of calls) assert.ok(Buffer.byteLength(JSON.stringify(call.user)) <= budget);
});

test('password and verification fields never enter any AI prompt', async () => {
  const env = worker(() => ({ ok: true, text: '[]' }));
  const result = await env.run({
    formFields: [
      { fieldId: 'password-field', label: '登录密码', inputType: 'password' },
      { fieldId: 'captcha-field', label: '验证码' },
      { fieldId: 'school', label: '学校' }
    ],
    resumeFields: [...BASE.resumeFields, { group: '自定义', key: '登录密码', value: 'synthetic-secret' }]
  });
  const prompts = env.sent.filter(item => item.kind === 'desktop-complete').map(item => item.user).join('\n');
  assert.ok(prompts.includes('学校'));
  assert.ok(!prompts.includes('登录密码'));
  assert.ok(!prompts.includes('验证码'));
  assert.ok(!prompts.includes('synthetic-secret'));
  assert.ok(result.diagnostics.skippedSecret >= 3);
});

test('an oversized lone candidate is skipped instead of prompting AI without resume context', async () => {
  const env = worker(() => { throw new Error('AI must not receive an empty candidate batch'); });
  const result = await env.run({
    formFields: [{ fieldId: 'school', label: '学校', inputType: 'select', options: ['大学甲', '大学乙'] }],
    resumeFields: [{ group: '教育背景', key: '学校', value: '合成资料'.repeat(20_000) }]
  });
  assert.equal(env.sent.filter(item => item.kind === 'desktop-complete').length, 0);
  assert.ok(result.diagnostics.skippedOversized > 0);
  assert.match(result.warning, /内容太多/);
});

test('a failed request replaces an earlier skip code, so the diagnostics name the failure', async () => {
  const input = {
    formFields: [{ fieldId: 'school', label: '学校', inputType: 'select', options: ['大学甲', '大学乙'] }, { fieldId: 'intro', label: '个人简介' }],
    resumeFields: [{ group: '教育背景', key: '学校', value: '合成资料'.repeat(20_000) }, { group: '其他', key: '自我评价', value: '合成评价' }]
  };
  const timeout = worker(() => ({ ok: false, reason: 'timeout' }));
  const failed = await timeout.run(input);
  assert.equal(timeout.sent.filter(item => item.kind === 'desktop-complete').length, 1);
  assert.ok(failed.diagnostics.skippedOversized > 0);
  assert.equal(failed.diagnostics.errorCode, 'timeout');
  assert.match(failed.warning, /内容太多/, 'both warnings are still shown');
  const garbled = await worker(() => ({ ok: true, text: 'not json' })).run(input);
  assert.equal(garbled.diagnostics.errorCode, 'bad_response');
  // An answered request leaves the skip code as it was.
  const answered = await worker(() => ({ ok: true, text: '[]' })).run(input);
  assert.equal(answered.diagnostics.errorCode, 'input_too_large');
});

test('desktop failure reasons produce distinct Chinese guidance', async () => {
  const cases = [
    ['not_configured', '桌面还没有配置 AI 服务商'], ['credential_unavailable', '系统凭据库'],
    ['auth', 'HTTP 401/403'], ['rate_limited', '限流'], ['timeout', '长时间没有返回'],
    ['network', '连不上'], ['http', 'HTTP 502'], ['bad_response', '无法使用'],
    ['input_too_large', '内容太多'], ['response_too_large', '内容过长'],
    ['secret_in_prompt', '像密码'], ['cancelled', '取消'],
    ['not_installed', '安装'], ['unavailable', '连接'], ['incompatible', '更新桌面']
  ];
  for (const [reason, phrase] of cases) {
    const env = worker(() => ({ ok: false, reason, httpStatus: reason === 'http' ? 502 : undefined }));
    const result = await env.run({ ...BASE, formFields: [BASE.formFields[1]] });
    assert.match(result.warning, new RegExp(phrase), reason);
    if (reason === 'not_configured') assert.equal(result.openView, 'settings-ai');
  }
});

test('a timeout says which tier, which host and how long it waited', async () => {
  let clock = 0;
  const now = () => clock;
  const strong = worker(() => { clock += 245_400; return { ok: false, reason: 'timeout', tier: 'strong', host: 'api.deepseek.com' }; }, { now });
  const result = await strong.run({ ...BASE, formFields: [BASE.formFields[1]], tier: 'strong' });
  assert.match(result.warning, /^强模型（api\.deepseek\.com）等了 245 秒没有完成字段匹配。/);
  assert.match(result.warning, /不带深度思考的模型/);
  assert.equal(result.diagnostics.errorCode, 'timeout');

  clock = 0;
  const daily = worker(() => { clock += 120_000; return { ok: false, reason: 'timeout', host: 'api.example.com' }; }, { now });
  const plain = await daily.run({ ...BASE, formFields: [BASE.formFields[1]] });
  // #299：日常档只说等了多久、可以换模型，秒数是插件自己量的。
  assert.equal(plain.warning, '日常模型等了 120 秒没有返回，可在桌面设置换模型后重试。');
  clock = 0;
  const named = worker(() => { clock += 95_600; return { ok: false, reason: 'timeout', tier: 'default', host: 'api.example.com' }; }, { now });
  const early = await named.run({ ...BASE, formFields: [BASE.formFields[1]], tier: 'default' });
  assert.equal(early.warning, '日常模型等了 96 秒没有返回，可在桌面设置换模型后重试。');
});

// #402：日常档超时按桌面记下的阶段（#299）说不同的话；旧桌面不给阶段，仍是原来那句。强档不变。
test('a daily-tier timeout says where the request stopped', async () => {
  const cases = [
    ['connect', '日常模型等了 120 秒还没连上服务商（api.example.com），请检查网络或代理。'],
    ['first_byte', '日常模型等了 120 秒没有回复，服务商可能太忙或模型太慢，可以稍后重试，或在桌面设置换模型。'],
    ['body', '日常模型的服务商已经响应，但等了 120 秒还没收到完整结果，可能是模型太慢或网络慢，可以稍后重试，或在桌面设置换模型。'],
    ['dns', '日常模型等了 120 秒没有返回，可在桌面设置换模型后重试。'],
    [undefined, '日常模型等了 120 秒没有返回，可在桌面设置换模型后重试。']
  ];
  for (const [timeoutStage, warning] of cases) {
    let clock = 0;
    const env = worker(() => { clock += 120_000; return { ok: false, reason: 'timeout', host: 'api.example.com', timeoutStage }; }, { now: () => clock });
    const result = await env.run({ ...BASE, formFields: [BASE.formFields[1]] });
    assert.equal(result.warning, warning, String(timeoutStage));
  }
  let clock = 0;
  const strong = worker(() => { clock += 200_000; return { ok: false, reason: 'timeout', tier: 'strong', host: 'api.example.com', timeoutStage: 'body' }; },
    { now: () => clock });
  const result = await strong.run({ ...BASE, formFields: [BASE.formFields[1]], tier: 'strong' });
  assert.match(result.warning, /^强模型（api\.example\.com）等了 200 秒没有完成字段匹配。/);
});

// #402：网页先填用的本地匹配和 worker 的 ruleMatches 是同一份口径：像密码的字段和资料都不参与。
test('the local matches a page fills first are the worker\'s rule matches', async () => {
  const profile = require('../profile-fields.js');
  const input = {
    formFields: [{ fieldId: 'name', label: '姓名' }, { fieldId: 'pwd', label: '登录密码', inputType: 'password' },
      { fieldId: 'mail', label: '邮箱', inputType: 'email' }, { fieldId: 'school', label: '学校' }, { fieldId: 'phone', label: '手机号码' }],
    resumeFields: [{ group: '基本信息', key: '姓名', value: '测试用户' }, { group: '基本信息', key: '邮箱', value: 'tester@example.com' },
      { group: '基本信息', key: '手机号码', value: 'token: abc123' }, { group: '教育背景', key: '学校', value: '大学乙' }]
  };
  const env = worker(() => ({ ok: true, text: '[]' }));
  const result = await env.run(input);
  const local = helpers.localRuleMatches(input.formFields, input.resumeFields, profile);
  assert.deepEqual(local, [{ fieldId: 'name', value: '测试用户' }, { fieldId: 'mail', value: 'tester@example.com' }]);
  assert.equal(result.diagnostics.ruleMatches, local.length);
  const fromWorker = JSON.parse(JSON.stringify(result.matches));
  assert.deepEqual(fromWorker.filter(match => local.some(item => item.fieldId === match.fieldId)), local);
  assert.equal(result.diagnostics.secretFormFields, 1);
});

// 手机排在身份证号前、或者反过来，网页先填和 worker 都不能把一个号码填进另一个框。
test('the page\'s local matches and the worker keep a mobile and an ID number apart', async () => {
  const profile = require('../profile-fields.js');
  const phone = { group: '基本信息', key: '手机', value: '13800138000' };
  const id = { group: '基本信息', key: '身份证号', value: '110101199003071234' };
  const formFields = [{ fieldId: 'name', label: '姓名' }, { fieldId: 'id', label: '证件号码' },
    { fieldId: 'phone', label: '手机号码' }, { fieldId: 'school', label: '学校' }];
  const expected = [{ fieldId: 'name', value: '测试用户' }, { fieldId: 'id', value: id.value }, { fieldId: 'phone', value: phone.value }];
  for (const order of [[phone, id], [id, phone]]) {
    const input = { formFields, resumeFields: [{ group: '基本信息', key: '姓名', value: '测试用户' }, ...order,
      { group: '教育背景', key: '学校', value: '大学乙' }] };
    const env = worker(() => ({ ok: true, text: '[]' }));
    const result = await env.run(input);
    assert.deepEqual(helpers.localRuleMatches(input.formFields, input.resumeFields, profile), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), expected);
    assert.equal(result.diagnostics.ruleMatches, 3);
    assert.doesNotMatch(env.sent.find(item => item.kind === 'desktop-complete').user, /证件号码|手机号码/);
  }
});

// 简历按真实顺序合并（模板在前、「我的信息」在后），模板里的微信、QQ 不能填进证件号码。
test('the page\'s local matches and the worker do not take a WeChat or QQ number for the ID number', async () => {
  const profile = require('../profile-fields.js');
  const formFields = [{ fieldId: 'name', label: '姓名' }, { fieldId: 'phone', label: '手机号码' },
    { fieldId: 'id', label: '证件号码' }, { fieldId: 'school', label: '学校' }];
  const mine = profile.profileToResumeFields({ values: { idNumber: '110101199003071234' } });
  const expected = [{ fieldId: 'name', value: '测试用户' }, { fieldId: 'phone', value: '13800138000' }, { fieldId: 'id', value: '110101199003071234' }];
  for (const other of [{ key: '微信', value: '13800138000' }, { key: 'QQ', value: '123456789' }]) {
    const resumeFields = profile.mergeResumeFields([{ group: '基本信息', key: '姓名', value: '测试用户' },
      { group: '基本信息', key: '手机', value: '13800138000' }, { group: '基本信息', ...other },
      { group: '教育背景', key: '学校', value: '大学乙' }], mine);
    const env = worker(() => ({ ok: true, text: '[]' }));
    const result = await env.run({ formFields, resumeFields });
    assert.deepEqual(helpers.localRuleMatches(formFields, resumeFields, profile), expected, other.key);
    assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), expected, other.key);
  }
});

// 分组名里有「证件」「手机」：排在前面的准考证号、微信不能填进证件号码和手机。
test('the page\'s local matches and the worker do not fill an admission ticket or WeChat number by its group name', async () => {
  const profile = require('../profile-fields.js');
  const formFields = [{ fieldId: 'name', label: '姓名' }, { fieldId: 'id', label: '证件号码' },
    { fieldId: 'phone', label: '手机号码' }, { fieldId: 'school', label: '学校' }];
  const resumeFields = [{ group: '基本信息', key: '姓名', value: '测试用户' },
    { group: '证件信息', key: '准考证号', value: '110105123456' }, { group: '证件信息', key: '身份证号', value: '110101199003071234' },
    { group: '手机与微信', key: '微信', value: '13911112222' }, { group: '手机与微信', key: '手机', value: '13800138000' },
    { group: '教育背景', key: '学校', value: '大学乙' }];
  const expected = [{ fieldId: 'name', value: '测试用户' }, { fieldId: 'id', value: '110101199003071234' }, { fieldId: 'phone', value: '13800138000' }];
  const env = worker(() => ({ ok: true, text: '[]' }));
  const result = await env.run({ formFields, resumeFields });
  assert.deepEqual(helpers.localRuleMatches(formFields, resumeFields, profile), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(result.matches)), expected);
});

// #299：首字节耗时记这次几批请求里最慢的一次，超时停在哪一步记超时那一批的；桌面没给就都不记。
test('the diagnostics keep the slowest first byte and where a timeout stopped', async () => {
  const fields = Array.from({ length: 20 }, (_, i) => ({ fieldId: `f${i}`, label: `项目${i}` + '甲'.repeat(1000) }));
  let calls = 0;
  const env = worker(() => (++calls === 1
    ? { ok: true, text: '[]', firstByteMs: 2400 }
    : { ok: false, reason: 'timeout', host: 'api.example.com', firstByteMs: 900, timeoutStage: 'body' }));
  const result = await env.run({ formFields: fields, resumeFields: BASE.resumeFields });
  assert.equal(calls, 2);
  assert.equal(result.diagnostics.firstByteMs, 2400);
  assert.equal(result.diagnostics.timeoutStage, 'body');

  const waiting = await worker(() => ({ ok: false, reason: 'timeout', timeoutStage: 'first_byte' })).run();
  assert.equal(waiting.diagnostics.timeoutStage, 'first_byte');
  assert.equal('firstByteMs' in waiting.diagnostics, false);

  // An older desktop sends neither; nothing made up takes their place.
  const old = await worker(() => ({ ok: false, reason: 'timeout' })).run();
  assert.equal('firstByteMs' in old.diagnostics, false);
  assert.equal('timeoutStage' in old.diagnostics, false);
});

test('a later batch failure keeps matches already returned by the desktop', async () => {
  let calls = 0;
  const env = worker(() => (++calls === 1
    ? { ok: true, text: '[{"fieldId":"f0","value":"大学乙"}]' }
    : { ok: false, reason: 'network' }));
  const fields = Array.from({ length: 20 }, (_, i) => ({ fieldId: `f${i}`, label: `项目${i}` + '甲'.repeat(1000) }));
  const result = await env.run({ formFields: fields, resumeFields: BASE.resumeFields });
  assert.ok(calls > 1);
  assert.equal(result.success, true);
  assert.ok(result.matches.some(item => item.fieldId === 'f0'));
  assert.match(result.warning, /连不上/);
});

test('candidate subsets for one page field produce at most one fill match', async () => {
  let calls = 0;
  const env = worker(() => ({ ok: true, text: JSON.stringify([{ fieldId: 'single', value: `结果${++calls}` }]) }));
  const result = await env.run({
    formFields: [{ fieldId: 'single', label: '自我评价', inputType: 'text' }],
    resumeFields: Array.from({ length: 30 }, (_, i) => ({ group: '自定义', key: `资料${i}`, value: '甲'.repeat(1800) }))
  });
  assert.ok(calls > 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].value, '结果1');
  assert.equal(result.diagnostics.aiMatches, 1);
});

test('rate limiting stops later prompt batches', async () => {
  let calls = 0;
  const env = worker(() => { calls += 1; return { ok: false, reason: 'rate_limited' }; });
  const result = await env.run({
    formFields: Array.from({ length: 20 }, (_, i) => ({ fieldId: `f${i}`, label: `问题${i}` + '甲'.repeat(1000) })),
    resumeFields: [{ group: '自定义', key: '说明', value: '合成资料' }]
  });
  assert.equal(calls, 1);
  assert.match(result.warning, /限流/);
});

test('cancelling forwards a desktop cancel and retains local matches', async () => {
  const env = worker(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = env.run(BASE, controller);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.ok(env.sent.some(item => item.kind === 'desktop-cancel'));
  assert.equal(result.matches.length, 1);
  assert.match(result.warning, /取消/);
});

test('repeat planner sends only candidates and validates the desktop text', async () => {
  const env = worker(() => ({ ok: true, text: '[{"id":"add-0","count":2}]' }));
  const candidates = [{ id: 'add-0', domain: 'papers', label: '新增论文', current: 1, target: 3 }];
  const result = await env.context.handleRepeatPlan({ candidates, resumeFields: BASE.resumeFields }, new AbortController());
  assert.equal(result.success, true);
  assert.equal(result.plan[0].count, 2);
  assert.equal(env.sent[0].purpose, 'plan');
  assert.ok(!env.sent[0].user.includes('测试用户'));
});

test('repeat planner omits sensitive candidate labels', async () => {
  const env = worker(() => ({ ok: true, text: '[]' }));
  await env.context.handleRepeatPlan({ candidates: [
    { id: 'secret', label: '新增验证码', current: 0, target: 1 },
    { id: 'safe', label: '新增论文', current: 0, target: 1 }
  ] }, new AbortController());
  assert.ok(env.sent[0].user.includes('新增论文'));
  assert.ok(!env.sent[0].user.includes('验证码'));
});

test('repeat planner exposes a structured desktop AI settings action', async () => {
  const env = worker(() => ({ ok: false, reason: 'not_configured' }));
  await assert.rejects(
    () => env.context.handleRepeatPlan({ candidates: [{ id: 'safe', label: '新增论文', current: 0, target: 1 }] }, new AbortController()),
    error => error.openView === 'settings-ai' && error.message.includes('桌面还没有配置 AI 服务商')
  );
});

test('the worker no longer parses resumes; the host does not forward the request', () => {
  assert.equal(source.includes('PARSE_RESUME'), false);
  const host = fs.readFileSync(path.join(__dirname, '..', 'ai-host.js'), 'utf8');
  assert.equal(host.includes('PARSE_RESUME'), false);
});

test('a desktop or provider connection failure stops later batches; a bad batch does not', async () => {
  const fields = Array.from({ length: 20 }, (_, i) => ({ fieldId: `f${i}`, label: `问题${i}` + '甲'.repeat(1000) }));
  for (const reason of ['unavailable', 'not_paired', 'never_paired', 'network', 'timeout']) {
    let calls = 0;
    const env = worker(() => { calls += 1; return { ok: false, reason }; });
    await env.run({ formFields: fields, resumeFields: [{ group: '自定义', key: '说明', value: '合成资料' }] });
    assert.equal(calls, 1, `${reason} must not be retried batch by batch`);
  }
  let calls = 0;
  const env = worker(() => { calls += 1; return { ok: false, reason: 'bad_response' }; });
  await env.run({ formFields: fields, resumeFields: [{ group: '自定义', key: '说明', value: '合成资料' }] });
  assert.ok(calls > 1, 'a malformed answer for one batch still lets the next batch try');
});

test('AI fill diagnostics count secret form fields on their own and name the early failures', async () => {
  const env = worker();
  const password = { fieldId: 'pw', label: '登录', inputType: 'password' };
  const secretOnly = await env.run({ ...BASE, formFields: [password] });
  assert.equal(secretOnly.success, false);
  assert.equal(secretOnly.diagnostics.errorCode, 'secret_only');
  assert.equal(secretOnly.diagnostics.secretFormFields, 1);
  const noResume = await env.run({ ...BASE, resumeFields: [] });
  assert.equal(noResume.success, false);
  assert.equal(noResume.diagnostics.errorCode, 'no_resume_fields');
  const mixed = await env.run({ ...BASE, formFields: [...BASE.formFields, password] });
  assert.equal(mixed.diagnostics.secretFormFields, 1);
  assert.equal(env.sent.filter(item => item.kind === 'desktop-complete').length, 1);
});
