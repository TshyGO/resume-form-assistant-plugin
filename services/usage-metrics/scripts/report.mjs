import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { liveStatistics } from '../src/statistics.mjs';
import { downloadReport } from '../src/downloads.mjs';

// Read-only maintainer CLI. Wrangler owns authentication; no public admin HTTP API.
try {
  const { values } = parseArgs({ options: { local: { type: 'boolean' }, remote: { type: 'boolean' }, config: { type: 'string' }, date: { type: 'string' }, window: { type: 'string' } } });
  if (Boolean(values.local) === Boolean(values.remote)) throw new Error('Select exactly one environment');
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
  const report = await liveStatistics(db, values.date ?? new Date().toISOString().slice(0, 10), Number(values.window ?? 30));
  report.downloads = await downloadReport(db);
  report.note = 'Enabled-statistics installation sample; the current UTC day is incomplete. Counts are approximate.';
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  process.stderr.write('Metrics report failed. Check environment, config, migrations and date/window arguments. No report was emitted.\n');
  process.exitCode = 1;
}
