import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createDownloadSnapshot, compareDownloadSnapshots, DownloadInputError } from './downloads.mjs';

try {
  const { values } = parseArgs({
    options: { input: { type: 'string' }, previous: { type: 'string' }, at: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write('Usage: node desktop/scripts/usage-metrics/snapshot.mjs --input releases.json [--previous snapshot.json] [--at ISO-timestamp]\n');
  } else {
    if (!values.input) throw new Error('--input is required');
    const raw = JSON.parse(readFileSync(values.input, 'utf8'));
    // gh api --paginate --slurp yields an array of pages. A flat list also works.
    if (!Array.isArray(raw)) throw new Error('Release input must be an array');
    const snapshot = createDownloadSnapshot(raw.flat(), values.at ?? new Date().toISOString());
    let previous = null;
    if (values.previous !== undefined) {
      const saved = JSON.parse(readFileSync(values.previous, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid previous snapshot');
      // Accept our own {snapshot, report} output as well as a standalone snapshot.
      previous = saved.snapshot ?? saved;
    }
    const report = compareDownloadSnapshots(previous, snapshot);
    process.stdout.write(`${JSON.stringify({ snapshot, report }, null, 2)}\n`);
  }
} catch (error) {
  // Do not echo potentially sensitive file contents or arbitrary exception text.
  const hints = { invalid_asset_id: '附件编号无效：请检查附件 ID 是否为正的安全整数。未生成报表。\n',
    invalid_asset_count: '附件下载次数无效：请检查下载次数是否为非负的安全整数。未生成报表。\n' };
  process.stderr.write(error instanceof DownloadInputError && Object.hasOwn(hints, error.code)
    ? hints[error.code] : 'Download snapshot failed: check input, previous snapshot and timestamp. No report was emitted.\n');
  process.exitCode = 1;
}
