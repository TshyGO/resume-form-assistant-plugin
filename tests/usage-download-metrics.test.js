const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const load = () => import('../desktop/scripts/usage-metrics/downloads.mjs');
const asset = (id = 1, count = 100, name = 'wangshen-kuaitian_0.4.3_x64-setup.exe') => ({ id, download_count: count, name, state: 'uploaded' });
const release = (assets = [asset()], tag = 'desktop-v0.4.3', extra = {}) => ({ id: 10, tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-09T00:00:00Z', assets, ...extra });
const before = '2026-10-10T00:10:00Z';
const after = '2026-10-11T00:10:00Z';

test('classifies actual desktop and extension packages while excluding checksums', async () => {
  const { createDownloadSnapshot } = await load();
  const snapshot = createDownloadSnapshot([
    release([asset(), asset(2, 15, 'wangshen-kuaitian_0.4.3_aarch64.dmg'), asset(3, 9, 'wangshen-kuaitian-plugin-0.4.2.zip'), asset(4, 4, 'package.exe.sha256'), asset(5, 3, 'notes.txt')]),
    release([asset(6, 12, 'wangshen-kuaitian-v0.4.2-chrome.zip')], 'v0.4.2', { id: 11 }),
    release([asset(7, 4, 'resume-pro-plugin-0.4.0-beta.3.zip')], 'desktop-v0.4.0-beta.3', { id: 12 }),
  ], after);
  assert.deepEqual(snapshot.assets.map(a => a.artifact_kind), ['windows-exe', 'macos-dmg', 'plugin-zip', 'other', 'plugin-zip', 'plugin-zip']);
  assert.equal(snapshot.assets[4].release_family, 'extension');
  assert.equal(snapshot.assets[5].release_channel, 'prerelease');
});

test('drafts and unfinished uploads are not counted, and prerelease flag is respected', async () => {
  const { createDownloadSnapshot } = await load();
  const snapshot = createDownloadSnapshot([release([], 'v0.4.3', { draft: true }), release([{ ...asset(1), state: 'starter' }, asset(2)], 'desktop-v0.4.3', { prerelease: true })], after);
  assert.equal(snapshot.assets.length, 1);
  assert.equal(snapshot.assets[0].release_channel, 'prerelease');
});

test('recognizes historical names but does not treat unrelated ZIPs as plugin packages', async () => {
  const { createDownloadSnapshot } = await load();
  const snapshot = createDownloadSnapshot([
    release([asset(1, 4, 'resume-pro-v0.3.1.zip'), asset(2, 2, 'docs.zip'), asset(3, 1, 'resume-pro-plugin-not-a-version.zip')], 'v0.3.1'),
    release([asset(4, 6, '_0.4.1-beta.1_x64-setup.exe'), asset(5, 6, 'Resume.Pro.Desktop_0.4.0-beta.3_aarch64.dmg'), asset(6, 1, 'package.exe.SHA256')], 'desktop-v0.4.1-beta.1', { id: 11 }),
  ], after);
  assert.deepEqual(snapshot.assets.map(a => a.artifact_kind), ['plugin-zip', 'other', 'other', 'windows-exe', 'macos-dmg']);
});

test('snapshots minimize raw API metadata and leave the input unmodified', async () => {
  const { createDownloadSnapshot } = await load();
  const input = [release([{ ...asset(), uploader: { login: 'fixture author' }, browser_download_url: 'https://example.com/file' }], 'desktop-v0.4.3', { body: 'fixture release notes' })];
  const copy = structuredClone(input);
  const serialized = JSON.stringify(createDownloadSnapshot(input, after));
  assert.equal(serialized.includes('fixture author'), false);
  assert.equal(serialized.includes('example.com'), false);
  assert.equal(serialized.includes('fixture release notes'), false);
  assert.deepEqual(input, copy);
});

test('first observation is a baseline, never fabricated daily downloads', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const result = compareDownloadSnapshots(null, createDownloadSnapshot([release()], after));
  assert.equal(result.rows[0].status, 'baseline');
  assert.equal(result.rows[0].download_count, 100);
  assert.equal(result.rows[0].increment, null);
});

test('observations cannot predate publication, including timezone offsets and empty releases', async () => {
  const { createDownloadSnapshot } = await load();
  for (const assets of [[asset()], []]) {
    for (const observed of ['2026-10-08T00:10:00Z', '2026-10-09T07:59:59.999+08:00']) {
      assert.throws(() => createDownloadSnapshot([release(assets)], observed), /publication.*observation/);
    }
  }
  assert.equal(createDownloadSnapshot([release()], '2026-10-09T08:00:00+08:00').observed_at, '2026-10-09T00:00:00.000Z');
  assert.equal(createDownloadSnapshot([release()], '2026-10-09T00:00:00.001Z').assets.length, 1);
});

test('loaded current and previous snapshots cannot fabricate pre-publication intervals', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const previous = createDownloadSnapshot([release()], before);
  const current = createDownloadSnapshot([release([asset(1, 108)])], after);
  const impossiblePrevious = { ...previous, observed_at: '2026-10-07T00:10:00.000Z', date_utc: '2026-10-07' };
  const impossibleCurrent = { ...current, observed_at: '2026-10-08T00:10:00.000Z', date_utc: '2026-10-08' };
  assert.throws(() => compareDownloadSnapshots(impossiblePrevious, current), /publication.*observation/);
  assert.throws(() => compareDownloadSnapshots(null, impossibleCurrent), /publication.*observation/);
  assert.throws(() => compareDownloadSnapshots(impossiblePrevious, impossibleCurrent), /publication.*observation/);
});

test('same asset 100 to 108 yields eight interval download requests', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const result = compareDownloadSnapshots(createDownloadSnapshot([release()], before), createDownloadSnapshot([release([asset(1, 108)])], after));
  assert.equal(result.rows[0].increment, 8);
  assert.equal(result.rows[0].status, 'adjacent_day');
  assert.equal(result.from_observed_at, '2026-10-10T00:10:00.000Z');
});

test('replacement attachment has a new baseline and missing old asset, not a negative delta', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const result = compareDownloadSnapshots(createDownloadSnapshot([release()], before), createDownloadSnapshot([release([asset(2, 3)])], after));
  assert.deepEqual(result.rows.map(a => [a.asset_id, a.status, a.increment]), [[1, 'missing_asset', null], [2, 'new_asset', null]]);
});

test('counter decrease and metadata changes are anomalies, not downloads', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const previous = createDownloadSnapshot([release([asset(), asset(2)])], before);
  const current = createDownloadSnapshot([release([asset(1, 99), asset(2, 105, 'renamed.exe')])], after);
  assert.deepEqual(compareDownloadSnapshots(previous, current).rows.map(a => [a.status, a.increment]), [['count_decreased', null], ['metadata_changed', null]]);
});

test('missed snapshots yield a labelled multi-day interval, never one-day downloads', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const result = compareDownloadSnapshots(createDownloadSnapshot([release()], before), createDownloadSnapshot([release([asset(1, 108)])], '2026-10-13T00:10:00Z'));
  assert.equal(result.elapsed_utc_days, 3);
  assert.equal(result.rows[0].status, 'gap');
  assert.equal(result.rows[0].increment, 8);
});

test('same-day observations stay distinct from daily intervals', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const result = compareDownloadSnapshots(createDownloadSnapshot([release()], before), createDownloadSnapshot([release([asset(1, 101)])], '2026-10-10T00:11:00Z'));
  assert.equal(result.rows[0].status, 'same_day');
  assert.equal(result.rows[0].increment, 1);
});

test('unchanged counters yield a real zero increment rather than an unknown value', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const result = compareDownloadSnapshots(createDownloadSnapshot([release()], before), createDownloadSnapshot([release()], after));
  assert.equal(result.rows[0].increment, 0);
  assert.equal(result.rows[0].status, 'adjacent_day');
});

test('timezone, year boundary and leap-day calculations use UTC dates', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  assert.equal(createDownloadSnapshot([], '2026-01-01T07:59:59+08:00').date_utc, '2025-12-31');
  for (const [a, b] of [['2025-12-31T00:10:00Z', '2026-01-01T00:10:00Z'], ['2024-02-28T00:10:00Z', '2024-02-29T00:10:00Z']]) {
    const boundaryRelease = release([asset()], 'desktop-v0.4.3', { published_at: a });
    assert.equal(compareDownloadSnapshots(createDownloadSnapshot([boundaryRelease], a), createDownloadSnapshot([boundaryRelease], b)).elapsed_utc_days, 1);
  }
});

test('invalid or partial input and duplicate IDs fail instead of producing fake zeroes', async () => {
  const { createDownloadSnapshot } = await load();
  for (const input of [{ message: 'rate limited' }, [release(undefined, 'v0.4.3', { assets: null })], [release([asset(1, -1)])], [release([asset(1, '100')])], [release([asset(), asset()])], [release(), release([asset(2)])], [release([{ ...asset(), state: 'unknown' }])]]) {
    assert.throws(() => createDownloadSnapshot(input, after));
  }
  assert.throws(() => createDownloadSnapshot([], '2026-10-11'));
});

test('invalid calendar dates and 24:00 are not silently normalized into another day', async () => {
  const { createDownloadSnapshot } = await load();
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-11T24:00:00Z', '2026-10-11T00:00:00', '2026-10-11T00:00:00+25:00']) {
    assert.throws(() => createDownloadSnapshot([], value));
  }
});

test('tampered snapshots and non-increasing timestamps cannot be compared', async () => {
  const { createDownloadSnapshot, compareDownloadSnapshots } = await load();
  const previous = createDownloadSnapshot([release()], before);
  const current = createDownloadSnapshot([release()], after);
  assert.throws(() => compareDownloadSnapshots(current, previous));
  assert.throws(() => compareDownloadSnapshots(current, current));
  assert.throws(() => compareDownloadSnapshots(previous, { ...current, date_utc: '2026-10-12' }));
  assert.throws(() => compareDownloadSnapshots({ ...previous, repository: 'another/repo' }, current));
  assert.throws(() => compareDownloadSnapshots(previous, { ...current, assets: [...current.assets, ...current.assets] }));
  assert.throws(() => compareDownloadSnapshots(previous, { ...current, assets: current.assets.map(a => ({ ...a, artifact_kind: 'other' })) }));
});

test('CLI reuses its own previous output and the documented fixtures yield eight downloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-downloads-roundtrip-'));
  try {
    const command = resolve(__dirname, '../desktop/scripts/usage-metrics/snapshot.mjs');
    const baseline = resolve(__dirname, 'fixtures/usage-metrics/releases-baseline.json');
    const next = resolve(__dirname, 'fixtures/usage-metrics/releases-next.json');
    const previous = join(dir, 'previous.json');
    const first = spawnSync(process.execPath, [command, '--input', baseline, '--at', before], { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(previous, first.stdout);
    const second = spawnSync(process.execPath, [command, '--input', next, '--previous', previous, '--at', after], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).report.rows.map(a => [a.artifact_kind, a.increment]), [['windows-exe', 8], ['macos-dmg', 0], ['plugin-zip', 0]]);
    writeFileSync(previous, JSON.stringify(JSON.parse(first.stdout).snapshot));
    const standalone = spawnSync(process.execPath, [command, '--input', next, '--previous', previous, '--at', after], { encoding: 'utf8' });
    assert.equal(standalone.status, 0, standalone.stderr);
    assert.equal(standalone.stdout, second.stdout);
    for (const invalid of [null, {}, JSON.parse(first.stdout).report]) {
      writeFileSync(previous, JSON.stringify(invalid));
      const failed = spawnSync(process.execPath, [command, '--input', next, '--previous', previous, '--at', after], { encoding: 'utf8' });
      assert.equal(failed.status, 1);
      assert.equal(failed.stdout, '');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI accepts paginated gh JSON and keeps errors out of report output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-downloads-'));
  try {
    const input = join(dir, 'releases.json');
    const command = resolve(__dirname, '../desktop/scripts/usage-metrics/snapshot.mjs');
    writeFileSync(input, JSON.stringify([[release()], [release([asset(2)], 'v0.4.3', { id: 11 })]]));
    const run = spawnSync(process.execPath, [command, '--input', input, '--at', after], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).snapshot.assets.length, 2);
    writeFileSync(input, '{"message":"secret fixture error"}');
    const failed = spawnSync(process.execPath, [command, '--input', input], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.equal(failed.stderr.includes('secret fixture error'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI emits no report for pre-publication observations or malformed historical timelines', async () => {
  const { createDownloadSnapshot } = await load();
  const dir = mkdtempSync(join(tmpdir(), 'usage-downloads-publication-'));
  try {
    const command = resolve(__dirname, '../desktop/scripts/usage-metrics/snapshot.mjs');
    const input = resolve(__dirname, 'fixtures/usage-metrics/releases-next.json');
    const previousFile = join(dir, 'previous.json');
    const snapshot = createDownloadSnapshot([release()], before);
    snapshot.observed_at = '2026-10-07T00:10:00.000Z';
    snapshot.date_utc = '2026-10-07';
    writeFileSync(previousFile, JSON.stringify({ snapshot, report: {} }));
    const runs = [
      spawnSync(process.execPath, [command, '--input', input, '--at', '2026-10-08T00:10:00Z'], { encoding: 'utf8' }),
      spawnSync(process.execPath, [command, '--input', input, '--previous', previousFile, '--at', after], { encoding: 'utf8' }),
    ];
    for (const result of runs) {
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /No report was emitted/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
