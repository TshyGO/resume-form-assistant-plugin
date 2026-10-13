import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { liveStatistics } from '../src/statistics.mjs';

const NOW = new Date('2026-10-11T00:10:00Z');

test('all invalid calendar dates have the same safe input error before any database access', async () => {
  let calls = 0;
  const db = { prepare() { calls++; throw new Error('database reached'); }, batch() { calls++; throw new Error('database reached'); } };
  for (const date of ['2026-02-30', '2026-13-01', '2026-00-01', '2026-10-00', '2026-10-32', '2026-1-01', 'synthetic-private-value', undefined, ['2026-10-11']]) {
    await assert.rejects(liveStatistics(db, date, 30, NOW), error =>
      error.name === 'StatisticsInputError' && error.code === 'invalid_date' && error.message === 'Invalid statistics window');
  }
  assert.equal(calls, 0);
});

test('report CLI gives only whitelisted date/window hints before opening remote configuration', () => {
  const script = fileURLToPath(new URL('../scripts/report.mjs', import.meta.url));
  for (const [options, hint] of [
    [['--date', '2026-13-01'], '报表日期无效'],
    [['--date', '2026-02-30'], '报表日期无效'],
    [['--date', 'synthetic-private-date'], '报表日期无效'],
    [['--window', 'synthetic-private-window'], '版本统计窗口无效'],
    [['--date', '0001-01-01'], '日期超出可重算范围'],
  ]) {
    const result = spawnSync(process.execPath, [script, '--remote', '--config', 'synthetic-private-config', ...options], {
      encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: 'synthetic-private-token' },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(hint));
    assert.doesNotMatch(result.stderr, /synthetic-private|RangeError|Invalid time value|wrangler/i);
  }
  const generic = spawnSync(process.execPath, [script, '--remote', '--config', 'synthetic-private-config'], { encoding: 'utf8' });
  assert.equal(generic.status, 1);
  assert.match(generic.stderr, /Check environment, config/);
  assert.doesNotMatch(generic.stderr, /synthetic-private/);
});
