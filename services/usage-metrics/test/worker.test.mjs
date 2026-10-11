import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { createWorker, runMaintenance } from '../src/index.mjs';
import { hmac, recordActivity, deleteActivity, activityPayload } from '../src/activity.mjs';
import { cleanup, liveStatistics, summarizeClosedDays } from '../src/statistics.mjs';
import { fetchReleases, collectDownloads, downloadReport } from '../src/downloads.mjs';

const SECRET = 'synthetic-test-key-only-not-a-real-secret';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const THIRD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAYLOAD = { schema_version: 1, installation_id: ID, platform: 'windows', app_version: '0.4.3', surface: 'desktop' };
const NOW = new Date('2026-10-11T00:10:00Z');
const LIMITER = { limit: async () => ({ success: true }) };
let mf, db;

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'output/worker.mjs', compatibilityDate: '2026-10-01', d1Databases: ['DB'],
    bindings: { METRICS_ENABLED: 'true', INSTALLATION_HMAC_KEY: SECRET },
    ratelimits: { ACTIVITY_LIMITER: { namespace_id: '25901', simple: { limit: 2000, period: 60 } } },
  }));
  db = await mf.getD1Database('DB');
  const sql = readFileSync(new URL('../migrations/0001_metrics.sql', import.meta.url), 'utf8');
  await db.batch(sql.split(';').map(part => part.trim()).filter(Boolean).map(part => db.prepare(part)));
});
beforeEach(async () => {
  await db.batch(['activity_day', 'revoked_installations', 'metrics_daily', 'release_observation', 'dataset_info', 'maintenance_state'].map(table => db.prepare(`DELETE FROM ${table}`)));
});
after(async () => { await mf?.dispose(); });

function request(payload = PAYLOAD, method = 'POST', extra = {}) {
  return new Request('https://example.test/v1/activity', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), ...extra });
}
function env(extra = {}) { return { DB: db, METRICS_ENABLED: 'true', INSTALLATION_HMAC_KEY: SECRET, ACTIVITY_LIMITER: LIMITER, ...extra }; }
async function hash(id = ID) { return hmac(SECRET, `installation:${id}`); }
async function record(id, at, overrides = {}) { await recordActivity(db, await hash(id), { ...PAYLOAD, ...overrides }, new Date(at)); }

test('real Workerd HTTP and D1 deduplicate 100 requests and OR both surfaces', async () => {
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => mf.dispatchFetch('https://example.test/v1/activity', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...PAYLOAD, installation_id: i % 2 ? ID.toUpperCase() : ID, surface: i % 2 ? 'desktop' : 'extension' }),
  })));
  assert.ok(results.every(response => response.status === 204));
  const rows = (await db.prepare('SELECT * FROM activity_day').all()).results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desktop_seen, 1);
  assert.equal(rows[0].extension_seen, 1);
  assert.equal(rows[0].installation_hash, await hash());
  assert.equal(JSON.stringify(rows).includes(ID), false);
});

test('server errors and validation never return false success or reveal request data', async () => {
  const worker = createWorker({ now: () => NOW });
  const cases = [
    [{ ...PAYLOAD, url: 'https://private.example/secret' }, 400],
    [{ ...PAYLOAD, schema_version: 2 }, 400],
    [{ ...PAYLOAD, installation_id: 'aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa' }, 400],
    [{ ...PAYLOAD, platform: 'linux' }, 400],
    [{ ...PAYLOAD, surface: 'background' }, 400],
    [{ ...PAYLOAD, app_version: '1.0.0-beta.01' }, 400],
    [{ ...PAYLOAD, app_version: '01.0.0' }, 400],
    [null, 400],
  ];
  for (const [payload, status] of cases) {
    const response = await worker.fetch(request(payload), env());
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes('private.example'), false);
  }
  assert.equal((await worker.fetch(request(PAYLOAD, 'POST', { headers: { 'content-type': 'text/plain' } }), env())).status, 415);
  assert.equal((await worker.fetch(request(PAYLOAD, 'POST', { body: 'x'.repeat(513) }), env())).status, 413);
  assert.equal((await worker.fetch(request(PAYLOAD, 'POST', { body: '{' }), env())).status, 400);
  assert.equal((await worker.fetch(request(), env({ ACTIVITY_LIMITER: { limit: async () => ({ success: false }) } }))).status, 429);
  assert.equal((await worker.fetch(request(), env({ INSTALLATION_HMAC_KEY: '' }))).status, 503);
  const broken = { prepare() { throw new Error('private database error'); } };
  const response = await worker.fetch(request(), env({ DB: broken }));
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('private'), false);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_day').first()).n, 0);
});

test('streamed payloads have a byte limit even without Content-Length', async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(400)); controller.enqueue(new Uint8Array(200)); controller.close(); } });
  await assert.rejects(activityPayload(request(PAYLOAD, 'POST', { body: stream, duplex: 'half' })), error => error.status === 413);
});

test('paused collection still allows deletion and no public admin route exists', async () => {
  const worker = createWorker({ now: () => NOW });
  await record(ID, NOW);
  const paused = env({ METRICS_ENABLED: 'false' });
  assert.equal((await worker.fetch(request(), paused)).status, 503);
  assert.equal((await worker.fetch(request({ schema_version: 1, installation_id: ID }, 'DELETE'), paused)).status, 204);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_day').first()).n, 0);
  assert.equal((await worker.fetch(new Request('https://example.test/admin'), env())).status, 404);
  assert.equal((await worker.fetch(new Request('https://example.test/v1/activity'), env())).status, 405);
  assert.equal((await worker.fetch(new Request('https://example.test/health'), env())).status, 200);
});

test('deletion is idempotent and late/concurrent POST cannot restore revoked rows', async () => {
  const worker = createWorker({ now: () => NOW });
  await record(ID, NOW);
  const deletion = { schema_version: 1, installation_id: ID };
  await Promise.all([
    ...Array.from({ length: 10 }, () => worker.fetch(request(), env())),
    worker.fetch(request(deletion, 'DELETE'), env()),
    ...Array.from({ length: 10 }, () => worker.fetch(request(), env())),
  ]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_day').first()).n, 0);
  assert.equal((await worker.fetch(request(), env())).status, 410);
  assert.equal((await worker.fetch(request(deletion, 'DELETE'), env())).status, 204);
  const expiry = (await db.prepare('SELECT expires_at_utc FROM revoked_installations').first()).expires_at_utc;
  await deleteActivity(db, await hash(), new Date(NOW.getTime() + 1000));
  assert.equal((await db.prepare('SELECT expires_at_utc FROM revoked_installations').first()).expires_at_utc, expiry);
  assert.equal((await worker.fetch(request({ schema_version: 1, installation_id: THIRD_ID }, 'DELETE'), env())).status, 204);
  assert.equal((await worker.fetch(request({ ...PAYLOAD, installation_id: OTHER_ID }), env())).status, 204);
});

test('D1 transactions roll back revocation if the corresponding deletion fails', async () => {
  await record(ID, NOW);
  await db.prepare("CREATE TRIGGER fail_delete BEFORE DELETE ON activity_day BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").run();
  try {
    await assert.rejects(deleteActivity(db, await hash(), NOW));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM revoked_installations').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_day').first()).n, 1);
  } finally { await db.prepare('DROP TRIGGER fail_delete').run(); }
});

test('DAU/WAU/MAU deduplicate across UTC days and version distributions use the latest observation', async () => {
  await record(ID, '2026-09-11T00:00:00Z'); // outside 30 UTC days
  await record(ID, '2026-10-10T00:00:00Z', { app_version: '0.4.2' });
  await record(OTHER_ID, '2026-10-10T00:00:00Z');
  await record(ID, '2026-10-11T00:00:00Z', { app_version: '0.4.3' });
  await record(THIRD_ID, '2026-10-11T00:00:00Z', { platform: 'macos' });
  await record('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2026-09-12T00:00:00Z'); // included 30th day
  const report = await liveStatistics(db, '2026-10-11', 7, NOW);
  assert.deepEqual(report.counts, { dau: 2, wau: 3, mau: 4 });
  assert.equal(report.versions.reduce((n, row) => n + row.installations, 0), 3);
  assert.ok(report.versions.every(row => row.app_version === '0.4.3'));
  await record(ID, '2026-10-11T00:00:00Z', { app_version: '0.4.4' });
  assert.ok((await liveStatistics(db, '2026-10-11', 30, NOW)).versions.some(row => row.app_version === '0.4.4'));
  await record(ID, '2026-10-10T23:59:59Z', { app_version: '0.4.1' });
  assert.ok((await liveStatistics(db, '2026-10-11', 30, NOW)).versions.some(row => row.app_version === '0.4.4'));
  await assert.rejects(liveStatistics(db, '2026-09-01', 30, NOW), /retained history/);
  await assert.rejects(liveStatistics(db, '2026-10-12', 30, NOW), /retained history/);
});

test('closed-day summaries survive deletion, fill recoverable gaps, and respect collection start', async () => {
  await record(ID, '2026-10-08T00:00:00Z');
  await record(ID, '2026-10-09T00:00:00Z');
  await record(OTHER_ID, '2026-10-10T00:00:00Z');
  await summarizeClosedDays(db, NOW);
  const rows = (await db.prepare('SELECT date_utc, dau, wau, mau FROM metrics_daily ORDER BY date_utc').all()).results;
  assert.deepEqual(rows, [
    { date_utc: '2026-10-08', dau: 1, wau: 1, mau: 1 },
    { date_utc: '2026-10-09', dau: 1, wau: 1, mau: 1 },
    { date_utc: '2026-10-10', dau: 1, wau: 2, mau: 2 },
  ]);
  await deleteActivity(db, await hash(), NOW);
  await summarizeClosedDays(db, NOW);
  assert.deepEqual((await db.prepare('SELECT date_utc, dau, wau, mau FROM metrics_daily ORDER BY date_utc').all()).results, rows);
});

test('retention removes the 46th day and expired revocations, not the 45th day', async () => {
  await record(ID, '2026-08-27T00:00:00Z');
  await record(OTHER_ID, '2026-08-28T00:00:00Z');
  await deleteActivity(db, await hash(THIRD_ID), new Date('2026-08-01T00:00:00Z'));
  await cleanup(db, NOW);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_day').first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM revoked_installations').first()).n, 0);
});

test('365-day cleanup cascades download attachments and removes only expired numeric summaries', async () => {
  const old = '2025-10-11T00:10:00.000Z';
  await db.batch([
    db.prepare('INSERT INTO release_observation VALUES (?, ?, 1)').bind(old, '2025-10-11'),
    db.prepare("INSERT INTO release_download_snapshot VALUES (?, 1, 1, 'v0.4.3', 'resume-pro-v0.4.3.zip', '2025-10-10T00:00:00Z', 1, 'extension', 'stable', 'plugin-zip')").bind(old),
    db.prepare("INSERT INTO metrics_daily VALUES ('2025-10-11', 1, 1, 1, 1, 0, 1, 0, ?) ").bind(old),
    db.prepare("INSERT INTO metrics_daily VALUES ('2025-10-12', 1, 1, 1, 1, 0, 1, 0, ?) ").bind(old),
  ]);
  await cleanup(db, NOW);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_observation').first()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_download_snapshot').first()).n, 0);
  assert.deepEqual((await db.prepare('SELECT date_utc FROM metrics_daily').all()).results, [{ date_utc: '2025-10-12' }]);
});

function githubFixture(data, failure = false) {
  return async url => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    if (failure) return new Response('rate limited', { status: 429 });
    if (/\/releases$/.test(parsed.pathname)) return Response.json(data.map(release => ({ ...release, assets: [] })));
    const id = Number(parsed.pathname.match(/\/releases\/(\d+)\/assets$/)[1]);
    return Response.json(data.find(release => release.id === id).assets);
  };
}

test('download collection commits complete snapshots, is daily-idempotent and reuses interval calculations', async () => {
  const first = JSON.parse(readFileSync(new URL('../../../tests/fixtures/usage-metrics/releases-baseline.json', import.meta.url), 'utf8'));
  const second = JSON.parse(readFileSync(new URL('../../../tests/fixtures/usage-metrics/releases-next.json', import.meta.url), 'utf8'));
  await collectDownloads(db, githubFixture(first), undefined, () => new Date('2026-10-10T00:10:00Z'));
  assert.ok((await downloadReport(db)).rows.every(row => row.status === 'baseline'));
  await collectDownloads(db, async () => { throw new Error('must not fetch twice'); }, undefined, () => new Date('2026-10-10T01:00:00Z'));
  await collectDownloads(db, githubFixture(second), undefined, () => NOW);
  assert.equal((await downloadReport(db)).rows[0].increment, 8);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_observation').first()).n, 2);
});

test('GitHub pagination covers release and asset pages and never commits a failed page as zero', async () => {
  const make = id => ({ id, draft: false, prerelease: false, tag_name: 'v0.4.3', published_at: '2026-10-01T00:00:00Z', assets: [] });
  const paths = [];
  const fixture = async url => {
    const parsed = new URL(url); paths.push(parsed.pathname + parsed.search);
    if (/\/releases$/.test(parsed.pathname)) return Response.json(parsed.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => ({ ...make(i + 1), draft: true })) : [make(101)]);
    return Response.json(parsed.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) : [{ id: 101 }]);
  };
  assert.equal((await fetchReleases(fixture)).find(release => !release.draft).assets.length, 101);
  assert.ok(paths.some(path => /\/releases\?.*page=2/.test(path)));
  assert.ok(paths.some(path => /assets.*page=2/.test(path)));
  await assert.rejects(collectDownloads(db, githubFixture([], true), undefined, () => NOW));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_observation').first()).n, 0);
});

test('request budgets and mid-collection failures leave no partial download snapshot', async () => {
  const releases = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, draft: false, prerelease: false, tag_name: 'v0.4.3', published_at: '2026-10-01T00:00:00Z', assets: [] }));
  await assert.rejects(collectDownloads(db, githubFixture(releases), undefined, () => NOW), /budget/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_observation').first()).n, 0);
  const fixture = githubFixture(releases.slice(0, 2));
  await assert.rejects(collectDownloads(db, url => /\/2\/assets/.test(url) ? Promise.resolve(new Response('failure', { status: 500 })) : fixture(url), undefined, () => NOW));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_download_snapshot').first()).n, 0);
});

test('GitHub requests use Workers-compatible manual redirects and reject 3xx without following', async () => {
  let requests = 0;
  await assert.rejects(fetchReleases(async (url, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    assert.equal(new URL(url).hostname, 'api.github.com');
    return new Response(null, { status: 302, headers: { Location: 'https://synthetic.invalid' } });
  }), /GitHub request failed/);
  assert.equal(requests, 1);
});

test('scheduled maintenance uses native Workerd fetch with mocked outbound GitHub responses', async () => {
  const source = await build({
    stdin: {
      contents: `import { runMaintenance } from './src/index.mjs';
        export default { async fetch(_request, env) {
          try { await runMaintenance(env, { now: () => new Date('2026-10-11T00:10:00Z') }); return new Response(null, {status: 204}); }
          catch { return new Response(null, {status: 500}); }
        }};`,
      resolveDir: process.cwd(), sourcefile: 'maintenance-test.mjs',
    }, bundle: true, format: 'esm', platform: 'browser', write: false,
  });
  let calls = 0;
  const data = JSON.parse(readFileSync(new URL('../../../tests/fixtures/usage-metrics/releases-baseline.json', import.meta.url), 'utf8'));
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: source.outputFiles[0].text, compatibilityDate: '2026-10-01', d1Databases: ['DB'],
    outboundService: async request => { calls++; return githubFixture(data)(request.url); },
  }));
  try {
    const database = await runtime.getD1Database('DB');
    const sql = readFileSync(new URL('../migrations/0001_metrics.sql', import.meta.url), 'utf8');
    await database.batch(sql.split(';').map(part => part.trim()).filter(Boolean).map(part => database.prepare(part)));
    const response = await runtime.dispatchFetch('https://maintenance.test');
    assert.equal(response.status, 204);
    assert.equal(calls, 2);
    assert.equal((await database.prepare("SELECT status FROM maintenance_state WHERE task = 'downloads'").first()).status, 'success');
    assert.equal((await database.prepare('SELECT asset_count FROM release_observation').first()).asset_count, 3);
  } finally { await runtime.dispose(); }
});

test('maintenance failure preserves previous success time and only records safe task status', async () => {
  await runMaintenance(env(), { now: () => NOW, fetchImpl: githubFixture([]) });
  const later = new Date('2026-10-12T00:10:00Z');
  await assert.rejects(runMaintenance(env(), { now: () => later, fetchImpl: githubFixture([], true) }));
  const status = await db.prepare("SELECT * FROM maintenance_state WHERE task = 'downloads'").first();
  assert.equal(status.last_success_at, NOW.toISOString());
  assert.equal(status.last_attempt_at, later.toISOString());
  assert.equal(status.status, 'failed');
});

test('concurrent daily collectors commit one complete observation', async () => {
  const data = JSON.parse(readFileSync(new URL('../../../tests/fixtures/usage-metrics/releases-baseline.json', import.meta.url), 'utf8'));
  await Promise.all([collectDownloads(db, githubFixture(data), undefined, () => NOW), collectDownloads(db, githubFixture(data), undefined, () => new Date(NOW.getTime() + 1))]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_observation').first()).n, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM release_download_snapshot').first()).n, 3);
  assert.equal((await downloadReport(db)).rows.length, 3);
});

test('GitHub failure does not prevent cleanup or closed-day summaries and safe status is recorded', async () => {
  await record(ID, '2026-08-27T00:00:00Z');
  await record(OTHER_ID, '2026-10-10T00:00:00Z');
  await assert.rejects(runMaintenance(env(), { now: () => NOW, fetchImpl: githubFixture([], true) }), /maintenance_failed/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM activity_day').first()).n, 1);
  assert.equal((await db.prepare("SELECT status FROM maintenance_state WHERE task='downloads'").first()).status, 'failed');
  assert.equal((await db.prepare("SELECT status FROM maintenance_state WHERE task='cleanup'").first()).status, 'success');
  assert.ok((await db.prepare('SELECT COUNT(*) AS n FROM metrics_daily').first()).n > 0);
  assert.equal(JSON.stringify((await db.prepare('SELECT * FROM maintenance_state').all()).results).includes(ID), false);
});
