const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE_DIR = path.join(__dirname, '..', 'docs', 'desktop-mvp', 'acceptance', 'fixtures', 'd14-v1');
const dataset = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'dataset.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'expected-results.json'), 'utf8'));

const ARCHIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT = '99999999-9999-4999-8999-999999999999';

function fixture(list, logicalId) {
  return dataset[list].find(item => item.logicalId === logicalId);
}

function template(logicalId) {
  const source = fixture('templates', logicalId);
  return {
    name: source.name,
    groups: [{
      name: 'D14',
      fields: Object.entries(source.fields).map(([key, value]) => ({
        key,
        value: Array.isArray(value) ? value.join(', ') : String(value)
      }))
    }]
  };
}

function jobFields(logicalId) {
  const job = fixture('jobs', logicalId);
  return {
    company: job.company,
    title: job.title,
    location: job.location,
    // URL token stripping belongs before the link boundary; this journey starts with the
    // already redacted URL that the real sidebar supplies.
    sourceUrl: job.url.replace(/\?.*$/, ''),
    dedupeUrl: job.url.replace(/\?.*$/, '')
  };
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const out = {};
      for (const key of (Array.isArray(keys) ? keys : [keys])) if (key in data) out[key] = data[key];
      return out;
    },
    async set(values) { Object.assign(data, values); }
  };
}

function fakeKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? structuredClone(map.get(key)) : undefined; },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async delete(key) { map.delete(key); },
    async list() { return [...map.values()].map(value => structuredClone(value)); }
  };
}

function reply(message, payload = {}, resultId = message.messageId) {
  return {
    response: {
      protocolVersion: 2,
      correlationId: message.messageId,
      ok: true,
      resultId,
      payload
    }
  };
}

function closed() {
  return { lastError: 'Error when communicating with the native messaging host.' };
}

function desktopModel() {
  const applicationIds = dataset.applications.map(item => item.fixtureUuid);
  const state = {
    online: false,
    applications: new Map(),
    events: [],
    uploads: new Map(),
    sent: []
  };

  state.answer = message => {
    state.sent.push(message);
    if (!state.online) return closed();
    if (message.messageType === 'handshake') {
      return reply(message, {
        appVersion: '0.1.0',
        minProtocolVersion: 1,
        maxProtocolVersion: 2,
        archiveId: ARCHIVE,
        restoreEpoch: EPOCH,
        capabilities: ['handshake', 'job.save', 'fill.submit', 'snapshot.chunk', 'submit.confirm']
      });
    }
    if (message.messageType === 'application.queryCandidates') {
      const rows = [...state.applications.values()].filter(app => app.company === message.payload.company);
      const exact = rows.filter(app => app.title === message.payload.title);
      const sameCompany = rows.filter(app => app.title !== message.payload.title);
      const view = app => ({ applicationId: app.id, company: app.company, title: app.title, stage: app.stage });
      return reply(message, { exact: exact.map(view), sameCompany: sameCompany.map(view) });
    }
    if (message.messageType === 'job.save') {
      const id = message.payload.applicationId ?? applicationIds[state.applications.size];
      const existing = state.applications.get(id);
      state.applications.set(id, {
        id,
        company: message.payload.company,
        title: message.payload.title,
        stage: existing?.stage ?? 'saved'
      });
      return reply(message, { resultKind: 'application' }, id);
    }
    if (message.messageType === 'fill.submit') {
      state.events.push({ type: 'fill.submit', applicationId: message.payload.applicationId });
      return reply(message, { resultKind: 'event' }, EVENT);
    }
    if (message.messageType === 'submit.confirm') {
      const app = state.applications.get(message.payload.applicationId);
      if (app && app.stage !== 'submitted') {
        app.stage = 'submitted';
        state.events.push({ type: 'submit.confirm', applicationId: app.id });
      }
      return reply(message, { resultKind: 'event' }, EVENT);
    }
    if (message.messageType === 'snapshot.chunk') {
      const p = message.payload;
      const upload = state.uploads.get(p.snapshotId) ?? { count: p.chunkCount, chunks: new Map() };
      state.uploads.set(p.snapshotId, upload);
      upload.chunks.set(p.chunkIndex, Buffer.from(p.bytesBase64, 'base64'));
      let cursor = 0;
      while (upload.chunks.has(cursor)) cursor += 1;
      const ackKind = cursor === upload.count ? 'snapshot' : 'chunk';
      return reply(message, { ackKind, snapshotId: p.snapshotId, chunkIndex: p.chunkIndex, chunkCursor: cursor });
    }
    return closed();
  };

  state.snapshotBytes = snapshotId => {
    const upload = state.uploads.get(snapshotId);
    return Buffer.concat([...upload.chunks.keys()].sort((a, b) => a - b).map(index => upload.chunks.get(index)));
  };
  return state;
}

async function harness(model) {
  const { createStore } = await import('../link/store.mjs');
  const { createSession } = await import('../link/session.mjs');
  const { createIntents } = await import('../link/intents.mjs');
  const { createOutbox } = await import('../link/outbox.mjs');
  const { createReconcile } = await import('../link/reconcile.mjs');
  const { createDrain } = await import('../link/drain.mjs');
  const { createFillRecords } = await import('../link/fillrecords.mjs');
  const { createStaging } = await import('../link/staging.mjs');
  const { createUploads } = await import('../link/uploads.mjs');
  const { createRouter } = await import('../link/router.mjs');

  const storage = fakeStorage({ desktopPairing: { archiveId: ARCHIVE, restoreEpoch: EPOCH, at: 1 } });
  const kv = fakeKv();
  let minted = 0;
  const uuid = () => `d1400000-0000-4000-8000-${String(++minted).padStart(12, '0')}`;
  const now = () => new Date(dataset.generatedFrom.baseInstant);
  const store = createStore({ storage, uuid });
  const sendNative = async (host, message) => model.answer(message);
  const deps = { store, sendNative, sleep: async () => {}, uuid, now };
  const staging = createStaging({ kv, now, uuid });
  const uploads = createUploads({ ...deps, staging });
  const session = createSession({ ...deps, getManifest: () => ({ version: '0.4.0' }) });
  const outbox = createOutbox({ ...deps, uploads });
  const reconcile = createReconcile({ ...deps, outbox });
  const drain = createDrain({
    session,
    outbox,
    reconcile,
    alarms: { async create() {}, async clear() { return true; } },
    now
  });
  const fillRecords = createFillRecords(deps);
  const router = createRouter({
    session,
    intents: createIntents(deps),
    outbox,
    drain,
    reconcile,
    fillRecords,
    store,
    uploads,
    extensionId: 'abcdefghijklmnopabcdefghijklmnop'
  });
  return { router, drain, storage, kv };
}

test('D14 T2: offline job and v1 fill become one application, immutable snapshot, then explicit submission', async () => {
  const model = desktopModel();
  const { router, drain, storage, kv } = await harness(model);
  const jobA = jobFields('job-a');

  const savedOffline = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: jobA });
  assert.equal(savedOffline.status, 'queued');
  assert.equal(savedOffline.mode, 'unavailable');

  const raw = {
    outcome: 'success',
    cancelled: false,
    fieldCount: 5,
    filledCount: 5,
    unconfirmedCount: 0,
    timing: { scanMs: 1, roundTripMs: 2, fillMs: 3, totalMs: 6 },
    urlRedacted: jobA.sourceUrl,
    templateName: fixture('templates', 'template-v1').name,
    pluginVersion: '0.4.0',
    job: { company: jobA.company, title: jobA.title, sourceUrl: jobA.sourceUrl }
  };
  const fillOffline = await router.handle({
    type: 'DESKTOP_RECORD_FILL',
    raw,
    snapshotTemplate: template('template-v1')
  });
  assert.equal(fillOffline.status, 'recorded');
  assert.equal(fillOffline.mode, 'unavailable');
  assert.equal(kv.map.size, 1, 'the original v1 snapshot is staged before the desktop returns');

  // The user edits the live template before reconnecting. Only the staged v1 bytes may move.
  const currentTemplate = template('template-v2');
  assert.match(JSON.stringify(currentTemplate), new RegExp(expected.logicalEntities.currentTemplateMarker));

  model.online = true;
  const boundJob = await router.handle({
    type: 'DESKTOP_BIND',
    intentId: savedOffline.intent.intentId
  });
  assert.equal(boundJob.status, 'saved');
  const applicationA = boundJob.applicationId;

  const waiting = await router.handle({ type: 'DESKTOP_LIST_QUEUE' });
  const boundFill = await router.handle({
    type: 'DESKTOP_BIND_FILL',
    recordId: waiting.fillRecords[0].recordId,
    applicationId: applicationA
  });
  assert.equal(boundFill.status, 'saved');
  await drain.run();

  assert.equal(model.applications.size, expected.journeys.J02.applicationCreates);
  const fillEvents = model.events.filter(item => item.type === 'fill.submit');
  assert.equal(fillEvents.length, expected.journeys.J02.fillEvents);
  assert.ok(
    fillEvents.every(item => item.applicationId === applicationA),
    'the offline fill must bind to the selected application'
  );
  assert.equal(model.uploads.size, expected.journeys.J02.snapshots);
  assert.equal(model.applications.get(applicationA).stage, expected.journeys.J03.stageBeforeExplicitSubmission);

  const [snapshotId] = model.uploads.keys();
  const snapshot = model.snapshotBytes(snapshotId).toString('utf8');
  assert.match(snapshot, new RegExp(expected.journeys.J02.snapshotContains));
  assert.doesNotMatch(snapshot, new RegExp(expected.journeys.J02.snapshotExcludes));
  assert.equal(kv.map.size, 0, 'the staged copy is removed only after the complete snapshot ACK');
  assert.deepEqual(storage.data.desktopFillRecords, []);

  await router.handle({ type: 'DESKTOP_CONFIRM_SUBMIT', applicationId: applicationA });
  await router.handle({ type: 'DESKTOP_CONFIRM_SUBMIT', applicationId: applicationA });
  assert.equal(model.applications.get(applicationA).stage, 'submitted');
  assert.equal(
    model.events.filter(item => item.type === 'submit.confirm').length,
    expected.journeys.J03.explicitSubmissionEvents,
    'a repeated explicit confirmation must not create a second business event'
  );
});

test('D14 T2: same-company postings are created separately and an exact repeat waits for a choice', async () => {
  const model = desktopModel();
  model.online = true;
  const { router } = await harness(model);

  const savedA = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: jobFields('job-a') });
  const savedB = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: jobFields('job-b') });

  assert.equal(savedA.status, 'saved');
  assert.equal(savedB.status, 'saved');
  assert.notEqual(savedA.applicationId, savedB.applicationId);
  assert.equal(model.applications.size, expected.logicalEntities.sameCompanyAmbiguity.length);
  assert.deepEqual(
    [...model.applications.values()].map(item => item.title).sort(),
    [jobFields('job-a').title, jobFields('job-b').title].sort()
  );

  const repeat = await router.handle({ type: 'DESKTOP_SAVE_JOB', fields: jobFields('job-a') });
  assert.equal(repeat.status, 'needs_choice');
  assert.deepEqual(repeat.exact.map(item => item.applicationId), [savedA.applicationId]);
  assert.equal(model.applications.size, expected.logicalEntities.sameCompanyAmbiguity.length);
});
