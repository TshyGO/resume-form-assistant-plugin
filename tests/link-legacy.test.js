const test = require('node:test');
const assert = require('node:assert/strict');
const profileApi = require('../profile-fields.js');

const load = () => import('../link/legacy.mjs');
const IDENTITY = { archiveId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', restoreEpoch: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const KEY = 'sk-synthetic-legacy-key';

function fakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const out = {};
      for (const key of (Array.isArray(keys) ? keys : [keys])) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of keys) delete data[key]; }
  };
}

/** Plays the desktop side of legacy.import: stages parts, answers status from `verdict`. */
function fakeDesktop() {
  const desktop = { sent: [], imports: new Map(), verdict: null, refuse: null, active: null };
  desktop.send = async envelope => {
    desktop.sent.push(structuredClone(envelope));
    const ok = payload => ({ status: 'ok', response: { ok: true, payload } });
    if (envelope.messageType === 'ui.open') return ok({ opened: true });
    const { importId, kind, index, body } = envelope.payload;
    const refused = desktop.refuse?.(envelope);
    if (refused) return refused;
    if (kind === 'manifest') {
      if (desktop.active && desktop.active !== importId) return { status: 'fatal', code: 'conflict' };
      desktop.active = importId;
      if (!desktop.imports.has(importId)) desktop.imports.set(importId, { total: body.total, parts: new Map() });
    } else if (kind !== 'status') {
      desktop.imports.get(importId).parts.set(index, body);
    }
    const entry = desktop.imports.get(importId);
    const received = entry.parts.size;
    const state = desktop.verdict?.state ?? (received === entry.total ? 'awaiting_confirmation' : 'receiving');
    return ok({ state, received, total: entry.total, ...(desktop.verdict?.aiConfigDropped ? { aiConfigDropped: true } : {}) });
  };
  return desktop;
}

function harness({ data = {}, mode = 'ready', desktop = fakeDesktop() } = {}) {
  let sequence = 0;
  const storage = fakeStorage(data);
  const alarms = { created: [], cleared: [], async create(name, options) { this.created.push({ name, ...options }); }, async clear(name) { this.cleared.push(name); } };
  const probes = { count: 0 };
  const deps = {
    session: { probe: async () => { probes.count += 1; return mode === 'ready' ? { mode, identity: IDENTITY } : { mode, identity: null }; } },
    store: { clientInstanceId: async () => '11111111-1111-4111-8111-111111111111' },
    storage, alarms, profileApi, probes,
    sendNative: async () => { throw new Error('the fake send is used instead'); },
    sleep: async () => {},
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    now: () => new Date('2026-09-25T00:00:00.000Z'),
    getManifest: () => ({ version: '0.4.1' }),
    send: desktop.send
  };
  return { deps, storage, alarms, desktop, probes };
}

const template = (id, name, fields = [['姓名', '测试用户']]) => ({
  id, name, groups: [{ name: '基本信息', fields: fields.map(([key, value]) => ({ key, value })) }]
});
const OLD = {
  templates: [template('t1', '校招简历'), template('t2', '实习简历')],
  activeTemplateId: 't2',
  profile: { values: { fullName: '测试用户' }, family: [], custom: [{ key: '邮箱密码', value: 'x' }] },
  aiConfig: { apiUrl: 'https://api.example.com/v1/chat/completions', model: 'm-1', apiKey: KEY }
};

test('no old data means no probe and no native message', async () => {
  const { createLegacy } = await load();
  const h = harness({ data: { aiConfig: { apiUrl: 'https://api.example.com/v1', model: 'm', apiKey: '' } } });
  const legacy = createLegacy(h.deps);
  assert.equal(await legacy.run(), null);
  assert.equal(h.probes.count, 0);
  assert.equal(h.desktop.sent.length, 0);
});

test('preparation keeps the current template first and only sends what the desktop accepts', async () => {
  const { prepareLegacy, MAX_TEMPLATES } = await load();
  const huge = template('big', '超大模板', [['自我评价', '甲'.repeat(9000)]]);
  const many = Array.from({ length: MAX_TEMPLATES + 1 }, (_, i) => template(`n${i}`, `模板${i}`));
  const prepared = prepareLegacy({
    templates: [...many, huge, { id: 'empty', name: '空', groups: [{ name: 'x', fields: [{ key: '', value: 'y' }] }] }, template('t-active', '名'.repeat(120))],
    activeTemplateId: 't-active',
    profile: { values: { note: '密码：abc' }, family: [], custom: [] },
    aiConfig: { apiUrl: '', model: '', apiKey: KEY }
  }, profileApi);
  const templates = prepared.parts.filter(part => part.kind === 'template');
  assert.equal(templates.length, MAX_TEMPLATES);
  assert.equal(templates[0].body.wasActive, true, 'the current template goes first');
  assert.equal([...templates[0].body.name].length, 100);
  assert.deepEqual(prepared.skipped.templates.map(item => item.reason).sort(), ['over_limit', 'over_limit', 'too_large']);
  assert.equal(prepared.parts.some(part => part.kind === 'profile'), false, 'a profile of only secrets is not sent');
  assert.equal(prepared.skipped.profileSecrets, 1);
  assert.equal(prepared.parts.some(part => part.kind === 'aiConfig'), false, 'no address, no AI part');
  assert.equal(prepared.keepAiConfig, true, 'but the key is kept for the user');
  assert.deepEqual(prepared.parts.map(part => part.index), prepared.parts.map((_, i) => i + 1));
});

test('a full send stages every part, keeps the key out of state, and opens the resume page', async () => {
  const { createLegacy, STATE_KEY } = await load();
  const { payloadBodySha256 } = await import('../link/protocol/validate.mjs');
  const h = harness({ data: OLD });
  const state = await createLegacy(h.deps).run();
  assert.equal(state.phase, 'waiting');
  const legacy = h.desktop.sent.filter(item => item.messageType === 'legacy.import');
  const manifest = legacy[0].payload.body;
  assert.equal(manifest.pluginVersion, '0.4.1');
  assert.equal(manifest.total, 4, 'two templates, profile, AI config');
  for (const part of legacy.slice(1, 1 + manifest.total)) {
    const declared = manifest.parts.find(item => item.index === part.payload.index);
    assert.equal(declared.sha256, await payloadBodySha256(part.payload.body));
  }
  const withKey = legacy.filter(item => JSON.stringify(item).includes(KEY));
  assert.deepEqual(withKey.map(item => item.payload.kind), ['aiConfig']);
  assert.equal(JSON.stringify(h.storage.data[STATE_KEY]).includes(KEY), false);
  assert.equal(h.storage.data[STATE_KEY].skipped.profileSecrets, 1);
  assert.ok(h.desktop.sent.some(item => item.messageType === 'ui.open' && item.payload.view === 'resume'));
  assert.equal(h.storage.data.templates.length, 2, 'nothing is deleted before the desktop says imported');
});

test('a restarted worker resends the same parts under the same importId', async () => {
  const { createLegacy, STATE_KEY } = await load();
  const desktop = fakeDesktop();
  let calls = 0;
  desktop.refuse = envelope => (envelope.payload.kind === 'profile' && ++calls === 1 ? { status: 'unavailable' } : null);
  const h = harness({ data: OLD, desktop });
  const first = await createLegacy(h.deps).run();
  assert.equal(first.phase, 'sending');
  assert.ok(h.alarms.created.length > 0, 'a retry is scheduled');
  const importId = h.storage.data[STATE_KEY].importId;
  const digests = JSON.stringify(h.storage.data[STATE_KEY].parts);

  desktop.refuse = null;
  const second = await createLegacy(h.deps).run();
  assert.equal(second.phase, 'waiting');
  assert.equal(h.storage.data[STATE_KEY].importId, importId);
  assert.equal(JSON.stringify(h.storage.data[STATE_KEY].parts), digests);
});

test('another import in progress waits; a refused batch stops without deleting anything', async () => {
  const { createLegacy, STATE_KEY } = await load();
  const busy = fakeDesktop();
  busy.active = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const waiting = harness({ data: OLD, desktop: busy });
  assert.equal((await createLegacy(waiting.deps).run()).phase, 'sending');
  assert.ok(waiting.alarms.created.length > 0);

  const refusing = fakeDesktop();
  refusing.refuse = () => ({ status: 'fatal', code: 'invalid_payload', message: '模板太大（超过 24 KB），请拆成几个模板。' });
  const h = harness({ data: OLD, desktop: refusing });
  const state = await createLegacy(h.deps).run();
  assert.equal(state.phase, 'failed');
  assert.match(h.storage.data[STATE_KEY].error, /模板太大/);
  assert.equal(h.storage.data.templates.length, 2);
  assert.ok(h.storage.data.aiConfig.apiKey);
});

test('imported clears exactly what went over; unsent templates are parked for the CSV', async () => {
  const { createLegacy, UNMIGRATED_KEY } = await load();
  const huge = template('big', '超大模板', [['自我评价', '甲'.repeat(9000)]]);
  const h = harness({ data: { ...OLD, templates: [...OLD.templates, huge] } });
  const legacy = createLegacy(h.deps);
  await legacy.run();
  h.desktop.verdict = { state: 'imported' };
  const state = await legacy.run();
  assert.equal(state.phase, 'imported');
  for (const key of ['templates', 'activeTemplateId', 'profile', 'aiConfig']) assert.equal(key in h.storage.data, false, key);
  assert.deepEqual(h.storage.data[UNMIGRATED_KEY].map(item => item.name), ['超大模板']);
  assert.equal((await legacy.status()).unmigratedTemplates, 1);
  assert.ok(h.alarms.cleared.length > 0);
});

test('imported without the AI config keeps the old key', async () => {
  const { createLegacy } = await load();
  const h = harness({ data: OLD });
  const legacy = createLegacy(h.deps);
  await legacy.run();
  h.desktop.verdict = { state: 'imported', aiConfigDropped: true };
  assert.equal((await legacy.run()).phase, 'imported_ai_dropped');
  assert.equal('templates' in h.storage.data, false);
  assert.equal(h.storage.data.aiConfig.apiKey, KEY);
  assert.equal((await legacy.status()).hasOldKey, true);
  await legacy.dropOldKey();
  assert.equal('aiConfig' in h.storage.data, false);
});

test('rejected keeps everything and is not resent until the user asks', async () => {
  const { createLegacy, STATE_KEY } = await load();
  const h = harness({ data: OLD });
  const legacy = createLegacy(h.deps);
  await legacy.run();
  const firstId = h.storage.data[STATE_KEY].importId;
  h.desktop.verdict = { state: 'rejected' };
  assert.equal((await legacy.run()).phase, 'rejected');
  const sentBefore = h.desktop.sent.length;
  assert.equal((await legacy.run()).phase, 'rejected');
  assert.equal(h.desktop.sent.length, sentBefore, 'no automatic resend');
  assert.equal(h.storage.data.templates.length, 2);

  h.desktop.verdict = null;
  h.desktop.active = null;
  await legacy.resend();
  assert.notEqual(h.storage.data[STATE_KEY].importId, firstId);
  assert.equal(h.storage.data[STATE_KEY].phase, 'waiting');
});

test('an expired batch is retried once with a new importId, then left to the user', async () => {
  const { createLegacy, STATE_KEY } = await load();
  const h = harness({ data: OLD });
  const legacy = createLegacy(h.deps);
  await legacy.run();
  const ids = [h.storage.data[STATE_KEY].importId];
  h.desktop.verdict = { state: 'expired' };
  assert.equal((await legacy.run()).phase, 'expired');
  h.desktop.verdict = null;
  h.desktop.active = null;
  await legacy.run();
  ids.push(h.storage.data[STATE_KEY].importId);
  assert.notEqual(ids[0], ids[1]);
  h.desktop.verdict = { state: 'expired' };
  await legacy.run();
  const sentBefore = h.desktop.sent.length;
  assert.equal((await legacy.run()).phase, 'expired');
  assert.equal(h.desktop.sent.length, sentBefore, 'the second expiry stops the automatic retries');
  assert.equal(h.storage.data.templates.length, 2);
});

test('discarding removes the old data and the parked templates', async () => {
  const { createLegacy, UNMIGRATED_KEY } = await load();
  const h = harness({ data: { ...OLD, [UNMIGRATED_KEY]: [template('x', 'x')] } });
  const legacy = createLegacy(h.deps);
  await legacy.discard();
  for (const key of ['templates', 'activeTemplateId', 'profile', 'aiConfig', UNMIGRATED_KEY]) assert.equal(key in h.storage.data, false, key);
  assert.equal((await legacy.status()).phase, 'discarded');
  assert.equal(await legacy.run().then(state => state.phase), 'discarded');
  assert.equal(h.probes.count, 0);
});

test('a desktop that is not ready is not sent anything', async () => {
  const { createLegacy } = await load();
  const h = harness({ data: OLD, mode: 'not_installed' });
  assert.equal(await createLegacy(h.deps).run(), null);
  assert.equal(h.desktop.sent.length, 0);
});

test('CSV has the three desktop columns, a BOM, and RFC 4180 quoting', async () => {
  const { templatesToCsv } = await load();
  const csv = templatesToCsv([template('a', 'a', [['自我评价', '第一行\n第二行, 含 "引号"'], ['姓名', '测试用户']])]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.slice(1), '一级分类,字段名,值\r\n基本信息,自我评价,"第一行\n第二行, 含 ""引号"""\r\n基本信息,姓名,测试用户\r\n');
});
