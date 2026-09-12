const test = require('node:test');
const assert = require('node:assert/strict');

const TEMPLATE = {
  id: 'tpl-1',
  name: '默认模板',
  groups: [
    { name: '基本信息', fields: [{ key: '姓名', value: '张三' }, { key: '邮箱', value: 'demo@example.com' }] },
    { name: '求职意向', fields: [{ key: '期望薪资', value: '20k' }, { key: '证件号码', value: '110101199001011234' }] }
  ]
};

const at = iso => () => new Date(iso);

async function load() {
  return import('../link/snapshot.mjs');
}

test('the same template always serialises to the same bytes', async () => {
  const { buildSnapshot } = await load();
  const a = await buildSnapshot(TEMPLATE, { now: at('2026-09-12T08:00:00.000Z') });
  const b = await buildSnapshot(structuredClone(TEMPLATE), { now: at('2026-09-12T08:00:00.000Z') });
  assert.deepEqual(Buffer.from(a.bytes), Buffer.from(b.bytes));
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.byteSize, a.bytes.length);
});

test('the snapshot is the v1 document with the template name and a content version', async () => {
  const { buildSnapshot } = await load();
  const snapshot = await buildSnapshot(TEMPLATE, { now: at('2026-09-12T08:00:00.000Z') });
  const doc = JSON.parse(Buffer.from(snapshot.bytes).toString('utf8'));
  assert.equal(doc.format, 'resume-pro.snapshot');
  assert.equal(doc.formatVersion, 1);
  assert.equal(doc.templateName, '默认模板');
  assert.equal(doc.capturedAt, '2026-09-12T08:00:00.000Z');
  assert.match(doc.templateVersion, /^[0-9a-f]{12}$/);
  assert.equal(snapshot.templateVersion, doc.templateVersion);
  assert.equal(snapshot.templateName, '默认模板');
  assert.deepEqual(doc.groups[0].fields[0], { key: '姓名', value: '张三' });
  assert.equal(doc.omittedFieldCount, 0);
});

test('changing a value changes both the digest and the template version', async () => {
  const { buildSnapshot } = await load();
  const v1 = await buildSnapshot(TEMPLATE, { now: at('2026-09-12T08:00:00.000Z') });
  const edited = structuredClone(TEMPLATE);
  edited.groups[0].fields[0].value = '李四';
  const v2 = await buildSnapshot(edited, { now: at('2026-09-12T08:00:00.000Z') });
  assert.notEqual(v1.sha256, v2.sha256);
  assert.notEqual(v1.templateVersion, v2.templateVersion);
});

test('the capture time is not part of the template version', async () => {
  const { buildSnapshot } = await load();
  const morning = await buildSnapshot(TEMPLATE, { now: at('2026-09-12T08:00:00.000Z') });
  const evening = await buildSnapshot(TEMPLATE, { now: at('2026-09-12T20:00:00.000Z') });
  assert.equal(morning.templateVersion, evening.templateVersion);
  assert.notEqual(morning.sha256, evening.sha256);
});

test('fields that look like credentials are dropped and counted, never stored', async () => {
  const { buildSnapshot } = await load();
  const template = structuredClone(TEMPLATE);
  template.groups[0].fields.push(
    { key: '登录密码', value: 'hunter2-synthetic' },
    { key: '短信验证码', value: '481516' },
    { key: 'API Key', value: 'sk-synthetic-000' },
    { key: 'access_token', value: 'tok-synthetic' },
    { key: 'Password', value: 'pw-synthetic' }
  );
  const snapshot = await buildSnapshot(template, { now: at('2026-09-12T08:00:00.000Z') });
  const text = Buffer.from(snapshot.bytes).toString('utf8');
  for (const secret of ['hunter2-synthetic', '481516', 'sk-synthetic-000', 'tok-synthetic', 'pw-synthetic', '登录密码']) {
    assert.ok(!text.includes(secret), `${secret} leaked into the snapshot`);
  }
  assert.equal(snapshot.omittedFieldCount, 5);
  assert.equal(JSON.parse(text).omittedFieldCount, 5);
});

test('ordinary resume fields that merely resemble secrets are kept', async () => {
  const { isSecretFieldName } = await load();
  for (const name of ['期望薪资', '证件号码', '手机号码', '邮箱', 'Hotpot 爱好', '工作地点', 'Photo']) {
    assert.equal(isSecretFieldName(name), false, name);
  }
  for (const name of ['密码', '支付口令', '邮箱验证码', 'OTP', 'apikey', 'API-Key', 'Cookie', 'refresh_token', 'client secret']) {
    assert.equal(isSecretFieldName(name), true, name);
  }
});

test('a template with nothing left to keep is refused rather than stored empty', async () => {
  const { buildSnapshot } = await load();
  const onlySecrets = { name: '空', groups: [{ name: '账号', fields: [{ key: '密码', value: 'x' }] }] };
  assert.deepEqual(await buildSnapshot(onlySecrets), { error: 'empty' });
  assert.deepEqual(await buildSnapshot({ name: '空', groups: [] }), { error: 'empty' });
  assert.deepEqual(await buildSnapshot(null), { error: 'empty' });
});

test('the 2 MiB product limit is enforced on the serialised bytes', async () => {
  const { buildSnapshot, MAX_SNAPSHOT_BYTES } = await load();
  assert.equal(MAX_SNAPSHOT_BYTES, 2097152);

  const sized = extra => ({ name: 'big', groups: [{ name: 'g', fields: [{ key: 'k', value: 'x'.repeat(extra) }] }] });
  const probe = await buildSnapshot(sized(0), { now: at('2026-09-12T08:00:00.000Z') });
  const overhead = probe.byteSize;

  const exact = await buildSnapshot(sized(MAX_SNAPSHOT_BYTES - overhead), { now: at('2026-09-12T08:00:00.000Z') });
  assert.equal(exact.byteSize, MAX_SNAPSHOT_BYTES);

  const over = await buildSnapshot(sized(MAX_SNAPSHOT_BYTES - overhead + 1), { now: at('2026-09-12T08:00:00.000Z') });
  assert.equal(over.error, 'too_large');
  assert.equal(over.byteSize, MAX_SNAPSHOT_BYTES + 1);
});

test('chunks are 32 KiB, cover the bytes exactly and carry their own digests', async () => {
  const { planChunks, CHUNK_BYTES, sha256Hex } = await load();
  assert.equal(CHUNK_BYTES, 32768);
  const bytes = new Uint8Array(CHUNK_BYTES * 2 + 100).map((_, i) => i % 251);
  const chunks = await planChunks(bytes);
  assert.deepEqual(chunks.map(c => c.chunkIndex), [0, 1, 2]);
  assert.deepEqual(chunks.map(c => c.end - c.start), [CHUNK_BYTES, CHUNK_BYTES, 100]);
  const rebuilt = Buffer.concat(chunks.map(c => Buffer.from(bytes.subarray(c.start, c.end))));
  assert.deepEqual(rebuilt, Buffer.from(bytes));
  for (const chunk of chunks) {
    assert.equal(chunk.chunkSha256, await sha256Hex(bytes.subarray(chunk.start, chunk.end)));
  }
});

test('a maximal chunk still fits a valid snapshot.chunk envelope', async () => {
  const { planChunks, encodeBase64, CHUNK_BYTES, sha256Hex } = await load();
  const { validateRequest, utf8JsonLen, MAX_ENVELOPE_BYTES } = await import('../link/protocol/validate.mjs');
  const bytes = new Uint8Array(CHUNK_BYTES * 2).map((_, i) => (i * 7) % 256);
  const [first] = await planChunks(bytes);
  const envelope = {
    protocolVersion: 1,
    messageId: '33333333-3333-4333-8333-333333333333',
    clientInstanceId: '11111111-1111-4111-8111-111111111111',
    messageType: 'snapshot.chunk',
    occurredAt: '2026-09-12T08:00:00.000Z',
    payload: {
      sourceRestoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      snapshotId: '66666666-6666-4666-8666-666666666666',
      applicationId: '77777777-7777-4777-8777-777777777777',
      chunkIndex: 0,
      chunkCount: 2,
      chunkSha256: first.chunkSha256,
      snapshotSha256: await sha256Hex(bytes),
      byteSize: bytes.length,
      bytesBase64: encodeBase64(bytes.subarray(first.start, first.end))
    },
    archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  };
  assert.ok(utf8JsonLen(envelope) <= MAX_ENVELOPE_BYTES, `envelope is ${utf8JsonLen(envelope)} bytes`);
  await validateRequest(envelope);
});

test('a 2 MiB snapshot needs at most 64 chunks, well inside the protocol limit', async () => {
  const { planChunks } = await load();
  const chunks = await planChunks(new Uint8Array(2097152));
  assert.equal(chunks.length, 64);
});

test('the template version a fill record carries is the one its snapshot would carry', async () => {
  const { buildSnapshot, templateVersionOf } = await load();
  const snapshot = await buildSnapshot(TEMPLATE, { now: at('2026-09-12T08:00:00.000Z') });
  assert.equal(await templateVersionOf(TEMPLATE), snapshot.templateVersion);
  const withSecret = structuredClone(TEMPLATE);
  withSecret.groups[0].fields.push({ key: '登录密码', value: 'x' });
  // Secret fields never enter the snapshot, so they do not change its version either.
  assert.equal(await templateVersionOf(withSecret), snapshot.templateVersion);
  assert.equal(await templateVersionOf({ name: 'empty', groups: [] }), null);
});

test('camelCase and Chinese credential names are recognised too', async () => {
  const { isSecretFieldName } = await load();
  for (const name of ['apiKey', 'accessToken', 'clientSecret', 'otpCode', 'userPassword', 'API 密钥', '访问令牌', '私钥']) {
    assert.equal(isSecretFieldName(name), true, name);
  }
  for (const name of ['Tokyo', 'hotPot', 'tokenizer', 'photoUrl', '钥匙扣']) {
    assert.equal(isSecretFieldName(name), false, name);
  }
});

test('a credential pasted into an innocuous field is dropped by its value', async () => {
  const { buildSnapshot, isSecretFieldValue } = await load();
  const leaky = {
    name: '导入的模板',
    groups: [{
      name: '其他',
      fields: [
        { key: '备注', value: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' },
        { key: '补充', value: 'password: hunter2' },
        { key: '链接', value: 'https://example.com/cb?access_token=abcdef123456' },
        { key: '工具', value: 'sk-abcdefghijklmnopqrstuvwxyz012345' },
        { key: '个人简介', value: '熟悉 token 化与 API Key 管理平台开发，会配置 Cookie 策略' },
        { key: '邮箱', value: 'demo@example.com' }
      ]
    }]
  };
  const snapshot = await buildSnapshot(leaky, { now: at('2026-09-12T08:00:00.000Z') });
  const text = Buffer.from(snapshot.bytes).toString('utf8');
  for (const secret of ['abcdefghijklmnopqrstuvwxyz0123', 'hunter2', 'abcdef123456', 'sk-abcdefghijklmnopqrstuvwxyz012345']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(snapshot.omittedFieldCount, 4);
  assert.match(text, /API Key 管理平台/);
  assert.match(text, /demo@example\.com/);
  assert.equal(isSecretFieldValue('20k'), false);
});

test('plural credential labels and credential groups are dropped too', async () => {
  const { buildSnapshot, isSecretFieldName } = await load();
  for (const name of ['Passwords', 'API Keys', 'Cookies', 'Secrets', 'accessTokens', 'OTPs']) {
    assert.equal(isSecretFieldName(name), true, name);
  }
  const sheet = {
    name: '导入的表',
    groups: [
      { name: 'API Keys', fields: [{ key: 'OpenAI', value: 'opaque-synthetic-credential' }, { key: 'Anthropic', value: 'another-opaque-one' }] },
      { name: '基本信息', fields: [{ key: '姓名', value: '合成' }] }
    ]
  };
  const snapshot = await buildSnapshot(sheet, { now: at('2026-09-12T08:00:00.000Z') });
  const text = Buffer.from(snapshot.bytes).toString('utf8');
  assert.equal(text.includes('opaque-synthetic-credential'), false);
  assert.equal(text.includes('API Keys'), false);
  assert.equal(snapshot.omittedFieldCount, 2);
  assert.match(text, /合成/);
});
