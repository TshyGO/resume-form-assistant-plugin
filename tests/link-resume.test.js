const test = require('node:test');
const assert = require('node:assert/strict');

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEMPLATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROFILE = { values: {}, family: [], custom: [] };

async function harness({ mode = 'ready', answer = () => ({ ok: true, payload: {} }) } = {}) {
  const { createResume } = await import('../link/resume.mjs');
  const sent = [];
  const resume = createResume({
    session: { probe: async () => ({ mode, identity: mode === 'ready' ? { archiveId: ARCHIVE, restoreEpoch: EPOCH } : null }) },
    store: { clientInstanceId: async () => '11111111-1111-4111-8111-111111111111' },
    sendNative: async (_host, request) => {
      sent.push(request);
      const result = answer(request);
      return { response: {
        protocolVersion: request.protocolVersion, correlationId: request.messageId,
        ...result
      } };
    },
    sleep: async () => {},
    uuid: () => '33333333-3333-4333-8333-333333333333',
    now: () => new Date('2026-09-24T00:00:00.000Z')
  });
  return { resume, sent };
}

test('ready resume.read sends v2 with identity and returns desktop data', async () => {
  const data = { templates: [], activeTemplate: null, profile: PROFILE, profileRevision: 0 };
  const { resume, sent } = await harness({ answer: () => ({ ok: true, payload: data }) });
  assert.deepEqual(await resume.read(), { status: 'ok', data });
  assert.equal(sent[0].messageType, 'resume.read');
  assert.equal(sent[0].protocolVersion, 2);
  assert.equal(sent[0].archiveId, ARCHIVE);
  assert.deepEqual(sent[0].payload, {});
});

test('a disconnected desktop never receives a resume request', async () => {
  const { resume, sent } = await harness({ mode: 'not_paired' });
  assert.deepEqual(await resume.read(), { status: 'not_paired' });
  assert.deepEqual(sent, []);
});

test('setActiveTemplate and saveProfile send their exact operations', async () => {
  const { resume, sent } = await harness({ answer: () => ({ ok: true, payload: { activeTemplateId: TEMPLATE, profileRevision: 4 } }) });
  assert.equal((await resume.setActiveTemplate(TEMPLATE)).status, 'ok');
  assert.deepEqual(sent[0].payload, { op: 'setActiveTemplate', templateId: TEMPLATE });
  assert.equal((await resume.saveProfile(PROFILE, 3)).status, 'ok');
  assert.deepEqual(sent[1].payload, { op: 'saveProfile', profile: PROFILE, expectedRevision: 3 });
});

test('update errors become retry decisions for the sidebar', async () => {
  for (const [code, expected] of [['invalid_payload', 'missing_template'], ['conflict', 'conflict'], ['secret_forbidden', 'secret']]) {
    const { resume } = await harness({ answer: () => ({ ok: false, error: { code, retryable: false, message: 'synthetic' }, payload: {} }) });
    const result = code === 'invalid_payload' ? await resume.setActiveTemplate(TEMPLATE) : await resume.saveProfile(PROFILE, 3);
    assert.equal(result.status, expected);
  }
});

test('a response that fails request correlation is unavailable', async () => {
  const { resume } = await harness({ answer: () => ({ correlationId: '99999999-9999-4999-8999-999999999999', ok: true, payload: { templates: [], activeTemplate: null, profile: PROFILE, profileRevision: 0 } }) });
  assert.deepEqual(await resume.read(), { status: 'unavailable' });
});

test('local envelope overflow returns an actionable profile status without sending', async () => {
  const { resume, sent } = await harness();
  const oversized = { values: { bio: '甲'.repeat(30_000) }, family: [], custom: [] };
  assert.equal((await resume.saveProfile(oversized, 0)).status, 'input_too_large');
  assert.equal(sent.length, 0);
});

test('ui.open probes mode but sends no archive identity', async () => {
  const { resume, sent } = await harness({ answer: () => ({ ok: true, payload: { opened: true } }) });
  assert.deepEqual(await resume.openView('settings-ai'), { status: 'ok', opened: true });
  assert.equal(sent[0].messageType, 'ui.open');
  assert.equal('archiveId' in sent[0], false);
  assert.deepEqual(sent[0].payload, { view: 'settings-ai' });
});
