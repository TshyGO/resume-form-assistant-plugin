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

function worker(respond = () => ({ ok: true, text: '[{"fieldId":"school","value":"大学乙"}]' })) {
  const sent = [];
  let sequence = 0;
  const context = vm.createContext({
    importScripts() {}, ResumeProAIHelpers: helpers,
    ResumeProProfile: require('../profile-fields.js'),
    ResumeProFormAgent: require('../form-agent.js'),
    AbortController, TextEncoder, performance: { now: () => 0 },
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

test('resume parsing directs the user to the desktop resume page', async () => {
  const env = worker();
  const result = await env.context.handleParseResume({ content: 'synthetic' });
  assert.equal(result.success, false);
  assert.equal(result.error, '简历解析已搬到桌面程序的「简历」页。');
  assert.equal(result.openView, 'resume');
  assert.equal(env.sent.length, 0);
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
