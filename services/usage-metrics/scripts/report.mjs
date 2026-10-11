import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { liveStatistics, validateStatisticsWindow, StatisticsInputError } from '../src/statistics.mjs';
import { downloadReport } from '../src/downloads.mjs';

// Read-only maintainer CLI. Wrangler owns authentication; no public admin HTTP API.
try {
  const { values } = parseArgs({ options: { local: { type: 'boolean' }, remote: { type: 'boolean' }, config: { type: 'string' }, date: { type: 'string' }, window: { type: 'string' } } });
  if (Boolean(values.local) === Boolean(values.remote)) throw new Error('Select exactly one environment');
  const observedAt = new Date();
  const date = values.date ?? observedAt.toISOString().slice(0, 10);
  const days = Number(values.window ?? 30);
  // Reject bad arguments before reading config or invoking any remote/local database tool.
  validateStatisticsWindow(date, days, observedAt);
  const config = values.config ?? 'wrangler.json';
  if (values.remote) {
    const settings = JSON.parse(readFileSync(config, 'utf8'));
    if (!values.config || !settings.d1_databases?.find(binding => binding.binding === 'DB' && /^[0-9a-f-]{36}$/i.test(binding.database_id) && binding.database_id !== '00000000-0000-0000-0000-000000000000')) throw new Error('Remote environment is not configured');
  }
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  function statement(sql, params = []) {
    return {
      bind(...values) { return statement(sql, values); },
      sql() {
        let index = 0;
        const formatted = sql.replace(/\?/g, () => {
          const value = params[index++];
          if (typeof value === 'number' && Number.isFinite(value)) return String(value);
          if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
          throw new Error('Invalid query parameter');
        });
        if (index !== params.length) throw new Error('Invalid query parameter count');
        return formatted;
      },
      async all() { return (await execute([this]))[0]; },
    };
  }
  async function execute(statements) {
    const command = statements.map(item => item.sql()).join(';');
    const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', values.local ? '--local' : '--remote', '--config', config, '--command', command, '--json'], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    if (result.status !== 0) throw new Error('Query failed');
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows) || rows.length !== statements.length || rows.some(row => row.success !== true || !Array.isArray(row.results))) throw new Error('Invalid query response');
    return rows;
  }
  const db = { prepare: statement, batch: execute };
  const report = await liveStatistics(db, date, days, observedAt);
  report.downloads = await downloadReport(db);
  report.note = 'Enabled-statistics installation sample; the current UTC day is incomplete. Counts are approximate.';
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const hints = {
    invalid_date: '报表日期无效：请使用实际存在的 YYYY-MM-DD 日期。未生成报表。\n',
    invalid_window: '版本统计窗口无效：--window 仅支持 7 或 30。未生成报表。\n',
    outside_retained_history: '日期超出可重算范围：请使用今天及前 15 个 UTC 日。未生成报表。\n',
  };
  process.stderr.write(error instanceof StatisticsInputError && Object.hasOwn(hints, error.code)
    ? hints[error.code] : 'Metrics report failed. Check environment, config, migrations and date/window arguments. No report was emitted.\n');
  process.exitCode = 1;
}
