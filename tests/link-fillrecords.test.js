const test = require('node:test');
const assert = require('node:assert/strict');

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const name of (Array.isArray(keys) ? keys : [keys])) if (name in data) out[name] = data[name];
      return out;
    },
    async set(values) { Object.assign(data, values); }
  };
}

// What content.js hands over when a fill ends: its own counters and timings, the page URL
// already redacted, the template label. Nothing else.
const RAW = {
  outcome: 'success',
  cancelled: false,
  fieldCount: 12,
  filledCount: 10,
  unconfirmedCount: 0,
  timing: { scanMs: 40.4, roundTripMs: 80.6, fillMs: 120.2, totalMs: 241.9 },
  urlRedacted: 'https://jobs.example.com/apply?utm_source=mail',
  templateName: '默认模板',
  templateVersion: '0123456789ab',
  pluginVersion: '0.4.0',
  job: { company: '星河科技', title: '后端开发', sourceUrl: 'https://jobs.example.com/apply' }
};

async function load() {
  return import('../link/fillrecords.mjs');
}

async function makeRecords(storage = fakeStorage()) {
  const { createStore } = await import('../link/store.mjs');
  const { createFillRecords } = await load();
  let minted = 0;
  const store = createStore({ storage, uuid: () => 'client-1' });
  const records = createFillRecords({
    store,
    uuid: () => `record-${++minted}`,
    now: () => new Date('2026-09-12T08:00:00.000Z')
  });
  return { records, store, storage };
}

test('fill outcomes map onto the protocol vocabulary, cancellation included', async () => {
  const { buildFillPayload } = await load();
  const outcome = raw => buildFillPayload({ ...RAW, ...raw }).outcome;
  assert.equal(outcome({ outcome: 'success' }), 'completed');
  assert.equal(outcome({ outcome: 'partial' }), 'partial');
  assert.equal(outcome({ outcome: 'failed', filledCount: 0 }), 'failed');
  assert.equal(outcome({ outcome: 'failed', cancelled: true, filledCount: 0 }), 'cancelled');
  // Cancelling only drops the AI wait; what local matching already wrote stays written.
  assert.equal(outcome({ outcome: 'success', cancelled: true, filledCount: 3 }), 'partial');
  // A failure after some fields were written did write them; "failed" would hide that.
  assert.equal(outcome({ outcome: 'failed', filledCount: 2 }), 'partial');
});

test('the payload carries counts, timings and labels and nothing else', async () => {
  const { buildFillPayload } = await load();
  const payload = buildFillPayload({
    ...RAW,
    matches: [{ fieldId: 'f1', value: '张三' }],
    values: ['张三'],
    aiConfig: { apiKey: 'sk-synthetic' },
    prompt: 'synthetic prompt'
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    'durationsMs', 'fieldCount', 'filledCount', 'outcome', 'pluginVersion',
    'templateName', 'templateVersion', 'unconfirmedCount', 'urlRedacted'
  ]);
  assert.deepEqual(payload.durationsMs, { scan: 40, match: 81, fill: 120, total: 242 });
  const text = JSON.stringify(payload);
  for (const leak of ['张三', 'sk-synthetic', 'synthetic prompt', 'fieldId']) {
    assert.equal(text.includes(leak), false, `${leak} leaked`);
  }
});

test('the URL is redacted again on the worker side', async () => {
  const { buildFillPayload } = await load();
  const payload = buildFillPayload({
    ...RAW,
    urlRedacted: 'https://jobs.example.com/apply?access_token=abc&code=42&utm_source=mail#frag'
  });
  assert.equal(payload.urlRedacted, 'https://jobs.example.com/apply?utm_source=mail');
});

test('counts and timings are clamped to what the protocol accepts', async () => {
  const { buildFillPayload } = await load();
  const payload = buildFillPayload({
    ...RAW,
    fieldCount: 20000,
    filledCount: -3,
    unconfirmedCount: 1.7,
    timing: { scanMs: null, roundTripMs: Number.NaN, fillMs: 9e9, totalMs: 5 }
  });
  assert.equal(payload.fieldCount, 10000);
  assert.equal(payload.filledCount, 0);
  assert.equal(payload.unconfirmedCount, 2);
  assert.deepEqual(payload.durationsMs, { fill: 3600000, total: 5 });
});

test('a missing template name falls back rather than failing the record', async () => {
  const { buildFillPayload } = await load();
  assert.equal(buildFillPayload({ ...RAW, templateName: '   ' }).templateName, '未命名模板');
  assert.equal(buildFillPayload({ ...RAW, templateName: 'x'.repeat(300) }).templateName.length, 200);
  assert.equal('templateVersion' in buildFillPayload({ ...RAW, templateVersion: '' }), false);
});

test('a fill record is kept only for a profile that can ever reach a desktop', async () => {
  for (const mode of ['not_installed', 'never_paired', 'not_paired']) {
    const { records, storage } = await makeRecords();
    const result = await records.create({ raw: RAW, mode });
    assert.deepEqual(result, { status: 'not_recorded', reason: mode });
    assert.equal('desktopFillRecords' in storage.data, false, mode);
  }
  for (const mode of ['ready', 'unavailable', 'incompatible']) {
    const { records, storage } = await makeRecords();
    const result = await records.create({ raw: RAW, mode });
    assert.equal(result.status, 'recorded', mode);
    assert.equal(storage.data.desktopFillRecords.length, 1);
  }
});

test('a record holds the fill, a job hint for finding candidates, and no identity', async () => {
  const { records } = await makeRecords();
  const { record } = await records.create({ raw: RAW, mode: 'unavailable' });
  assert.equal(record.recordId, 'record-1');
  assert.equal(record.clientInstanceId, 'client-1');
  assert.equal(record.status, 'pending_bind');
  assert.equal(record.applicationId, null);
  assert.equal(record.createdAt, '2026-09-12T08:00:00.000Z');
  assert.equal(record.fill.outcome, 'completed');
  assert.deepEqual(record.job, { company: '星河科技', title: '后端开发', sourceUrl: 'https://jobs.example.com/apply' });
  for (const forbidden of ['messageId', 'restoreEpoch', 'sourceRestoreEpoch', 'archiveId']) {
    assert.equal(forbidden in record, false, forbidden);
  }
});

test('the hundred-and-first record is refused and the rest are untouched', async () => {
  const { records, storage } = await makeRecords();
  for (let i = 0; i < 100; i += 1) {
    assert.equal((await records.create({ raw: RAW, mode: 'unavailable' })).status, 'recorded');
  }
  const refused = await records.create({ raw: RAW, mode: 'unavailable' });
  assert.deepEqual(refused, { status: 'rejected', reason: 'queue_full' });
  assert.equal(storage.data.desktopFillRecords.length, 100);
});

test('claiming, unbinding and removing a record', async () => {
  const { records, storage } = await makeRecords();
  const { record } = await records.create({ raw: RAW, mode: 'ready' });
  const claimed = await records.claim(record.recordId, 'app-1');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.record.recordId, record.recordId);
  // A second claim is a double click, not a second decision.
  assert.deepEqual(await records.claim(record.recordId, 'app-1'), { status: 'duplicate' });
  assert.deepEqual(await records.claim('no-such-record', 'app-1'), { status: 'unknown' });
  assert.deepEqual(
    { status: storage.data.desktopFillRecords[0].status, applicationId: storage.data.desktopFillRecords[0].applicationId },
    { status: 'bound', applicationId: 'app-1' }
  );
  await records.unbind(record.recordId);
  assert.equal(storage.data.desktopFillRecords[0].status, 'pending_bind');
  assert.equal(storage.data.desktopFillRecords[0].applicationId, null);
  await records.remove(record.recordId);
  assert.deepEqual(storage.data.desktopFillRecords, []);
});

test('the fill records key is the only new key and the plugin keys are untouched', async () => {
  const { KEYS, RESERVED_KEYS } = await import('../link/store.mjs');
  assert.equal(KEYS.fillRecords, 'desktopFillRecords');
  assert.equal(RESERVED_KEYS.includes('desktopFillRecords'), false);

  const reserved = { templates: [{ id: 't' }], activeTemplateId: 't', aiConfig: { apiKey: 'k' } };
  const { records, storage } = await makeRecords(fakeStorage(structuredClone(reserved)));
  await records.create({ raw: RAW, mode: 'unavailable' });
  for (const key of Object.keys(reserved)) assert.deepEqual(storage.data[key], reserved[key]);
});

test('a page URL too long for a candidate lookup is not kept as the hint', async () => {
  // queryCandidates caps sourceUrl at 2,000 characters. A longer hint would make every
  // lookup invalid, and a record with a company name would then have no way to be bound.
  const { records } = await makeRecords();
  const long = `https://jobs.example.com/apply?role=${'a'.repeat(2100)}`;
  const { record } = await records.create({ raw: { ...RAW, job: { ...RAW.job, sourceUrl: long } }, mode: 'unavailable' });
  assert.equal(record.job.company, '星河科技');
  assert.equal(record.job.sourceUrl, '');
});
