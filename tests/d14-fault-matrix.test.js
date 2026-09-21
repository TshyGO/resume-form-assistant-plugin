const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'docs', 'desktop-mvp', 'acceptance', 'fixtures', 'd14-v1');
const dataset = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'dataset.json'), 'utf8'));

function fixture(list, logicalId) {
  return dataset[list].find(item => item.logicalId === logicalId);
}

test('D14 F11: every fixture marker is removed at its plugin boundary', async () => {
  const { redactUrl } = await import('../link/redact.mjs');
  const { buildSnapshot } = await import('../link/snapshot.mjs');
  const notice = fixture('notices', 'notice-bare-code');
  const redacted = redactUrl(notice.sourceUrl);

  assert.equal(redacted.sourceUrl, 'https://jobs.d14.example.test/apply?role=platform');
  assert.equal(redacted.dedupeUrl, 'https://jobs.d14.example.test/apply?role=platform');

  const source = fixture('templates', 'template-v1');
  const snapshot = await buildSnapshot({
    name: source.name,
    groups: [{
      name: 'D14',
      fields: Object.entries(source.fields).map(([key, value]) => ({
        key,
        value: Array.isArray(value) ? value.join(', ') : String(value)
      }))
    }]
  }, { now: () => new Date(dataset.generatedFrom.baseInstant) });
  const bytes = new TextDecoder().decode(snapshot.bytes);

  for (const marker of dataset.syntheticMarkers) {
    assert.equal(bytes.includes(marker), false, `${marker} reached immutable snapshot bytes`);
    assert.equal(redacted.sourceUrl.includes(marker), false, `${marker} survived URL redaction`);
    assert.equal(redacted.dedupeUrl.includes(marker), false, `${marker} survived dedupe URL redaction`);
  }
  assert.match(bytes, /D14-V1-SNAPSHOT-MARKER/, 'ordinary resume content must still be archived');
});

test('D14 F11: the reviewed plugin release contains no fixture or forbidden marker', async () => {
  const release = await import('../desktop/scripts/check-plugin-release-allowlist.js');
  const { PLUGIN_ARCHIVE_OPERANDS } = await import('../desktop/scripts/pack-plugin.js');
  const leaves = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...PLUGIN_ARCHIVE_OPERANDS],
    { cwd: ROOT, encoding: 'utf8' }
  ).trim().split(/\r?\n/).filter(Boolean);

  release.assertPluginOnlyArchive(leaves);
  assert.ok(leaves.length > 0);
  assert.equal(
    leaves.some(name => /(?:^|\/)(?:docs|tests|desktop)(?:\/|$)/.test(name.replaceAll('\\', '/'))),
    false,
    'development evidence and fixtures must not enter the plugin ZIP'
  );

  for (const name of leaves) {
    const bytes = fs.readFileSync(path.join(ROOT, name));
    for (const marker of dataset.syntheticMarkers) {
      assert.equal(bytes.includes(marker), false, `${marker} reached release file ${name}`);
    }
  }
});
