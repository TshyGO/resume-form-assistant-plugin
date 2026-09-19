const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ACCEPTANCE = path.join(ROOT, 'docs', 'desktop-mvp', 'acceptance');
const FIXTURES = path.join(ACCEPTANCE, 'fixtures', 'd14-v1');
const JOURNEYS = Array.from({ length: 8 }, (_, index) => `J${String(index + 1).padStart(2, '0')}`);
const FAULTS = Array.from({ length: 13 }, (_, index) => `F${String(index + 1).padStart(2, '0')}`);
const CASES = [...JOURNEYS, ...FAULTS];

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(...segments), 'utf8'));
}

test('D14 report template contains every case exactly once and claims no result', () => {
  const report = readJson(ACCEPTANCE, 'report-template.json');
  const ids = report.cases.map((entry) => entry.id);

  assert.deepEqual(ids, CASES);
  assert.equal(new Set(ids).size, CASES.length);
  assert.ok(report.cases.every((entry) => entry.status === 'NOT_RUN'));
  assert.ok(report.cases.every((entry) => entry.evidence.length === 0));
  assert.equal(report.review.decision, 'NOT_REVIEWED');
});

test('D14 case catalog and expected results cover the same journeys and faults', () => {
  const catalog = fs.readFileSync(path.join(ACCEPTANCE, 'cases.md'), 'utf8');
  const expected = readJson(FIXTURES, 'expected-results.json');

  for (const id of CASES) {
    const rows = catalog.match(new RegExp(`^\\| ${id} \\|`, 'gm')) || [];
    assert.equal(rows.length, 1, `${id} must have exactly one catalog row`);
  }
  assert.deepEqual(Object.keys(expected.journeys), JOURNEYS);
  assert.deepEqual(Object.keys(expected.faults), FAULTS);
});

test('d14-v1 has the required ambiguity, template history and hostile inputs', () => {
  const dataset = readJson(FIXTURES, 'dataset.json');
  const jobs = Object.fromEntries(dataset.jobs.map((job) => [job.logicalId, job]));
  const templates = Object.fromEntries(dataset.templates.map((template) => [template.logicalId, template]));

  assert.equal(dataset.fixtureVersion, 'd14-v1');
  assert.equal(jobs['job-a'].company, jobs['job-b'].company);
  assert.notEqual(jobs['job-a'].title, jobs['job-b'].title);
  assert.notEqual(jobs['job-a'].company, jobs['job-c'].company);
  assert.match(templates['template-v1'].fields.summary, /D14-V1-SNAPSHOT-MARKER/);
  assert.match(templates['template-v2'].fields.summary, /D14-V2-CURRENT-MARKER/);
  assert.ok(dataset.notices.some((notice) => notice.requiresUserChoice));
  assert.ok(dataset.notices.some((notice) => notice.historyOnly));
  assert.ok(dataset.notices.some((notice) => notice.mustNotChangeFormalState));
  assert.ok(dataset.notices.some((notice) => notice.kind === 'interview_cancelled'));
  assert.ok(dataset.modelResponses.some((response) => response.mode === 'timeout'));
  assert.ok(dataset.modelResponses.some((response) => response.logicalId === 'model-invalid-json'));
  assert.ok(dataset.attachments.every((attachment) => attachment.executable !== true));
  assert.ok(dataset.actor.email.endsWith('.test'));

  const replyClasses = new Set([
    'auto_ack', 'assessment_invite', 'interview_invite', 'action_required',
    'offer', 'reject', 'other', 'unknown'
  ]);
  for (const notice of dataset.notices.filter((item) => item.expectedReplyClass)) {
    assert.ok(replyClasses.has(notice.expectedReplyClass), `${notice.logicalId} must use the D11 enum`);
  }
  const ambiguous = dataset.modelResponses.find((response) => response.logicalId === 'model-valid-ambiguous');
  assert.deepEqual(ambiguous.value.candidates, ['c1', 'c2']);
  assert.equal(ambiguous.value.replyClass, 'action_required');
  assert.equal(ambiguous.value.sendMode, 'unknown');
});

test('D14 dependencies and artifacts start unsigned and unregistered', () => {
  const dependencies = readJson(ACCEPTANCE, 'dependencies.json');
  const artifacts = readJson(ACCEPTANCE, 'candidate-artifacts.json');
  const report = readJson(ACCEPTANCE, 'report-template.json');

  assert.deepEqual(dependencies.dependencies.map((entry) => entry.id), ['D08', 'D11', 'D13']);
  assert.ok(dependencies.dependencies.every((entry) => entry.signedOff === false));
  assert.ok(dependencies.dependencies.every((entry) => entry.acceptanceEvidence.length === 0));
  assert.equal(artifacts.status, 'NOT_REGISTERED');
  assert.equal(artifacts.desktop.sha256, null);
  assert.equal(artifacts.extension.sha256, null);
  assert.ok(report.dependencies.every((entry) => entry.signedOff === false));
  assert.ok(report.dependencies.every((entry) => entry.signedOffBy === null));
  assert.ok(report.dependencies.every((entry) => entry.signedOffAt === null));
});

test('D14 T2 maps the shared fixture to every deterministic business layer', () => {
  const mapping = fs.readFileSync(path.join(ACCEPTANCE, 't2-business-regression.md'), 'utf8');
  for (const target of [
    'tests/d14-business-regression.test.js',
    'desktop/crates/ai-extract/tests/d14_business_regression.rs',
    'desktop/src/ai/d14-business-regression.test.ts',
    'desktop/crates/archive-store/tests/d14_business_regression.rs',
  ]) {
    assert.match(mapping, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(fs.existsSync(path.join(ROOT, ...target.split('/'))), `${target} must exist`);
  }
  assert.match(mapping, /不能替代 T4\/T5 的真实安装和浏览器证据/);
});

test('D14 T3 maps every fault to exact tests without pretending OS evidence ran', () => {
  const matrix = readJson(ACCEPTANCE, 't3-fault-matrix.json');
  assert.equal(matrix.status, 'AUTOMATION_COMPLETE_REAL_OS_PENDING');
  assert.deepEqual(matrix.cases.map((entry) => entry.id), FAULTS);
  assert.ok(matrix.cases.every((entry) => entry.deterministicTests.length > 0));
  assert.ok(matrix.cases.every((entry) => entry.deterministicTests.every((name) => name.includes('::'))));
  for (const entry of matrix.cases) {
    for (const reference of entry.deterministicTests) {
      const [file, name] = reference.split('::');
      const absolute = path.join(ROOT, ...file.split('/'));
      assert.ok(fs.existsSync(absolute), `${entry.id} references missing file ${file}`);
      assert.match(fs.readFileSync(absolute, 'utf8'), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${entry.id} references missing test ${reference}`);
    }
  }
  assert.ok(matrix.cases.slice(0, 12).every((entry) => entry.automationStatus === 'COVERED'));
  assert.equal(matrix.cases[12].automationStatus, 'PARTIAL');
  assert.ok(matrix.cases[12].remainingEvidence.length >= 5);
});

test('D14 T4 harness binds candidate bytes without pre-approving browser journeys', () => {
  const guide = fs.readFileSync(path.join(ACCEPTANCE, 't4-windows-browser.md'), 'utf8');
  const harnessPath = path.join(ROOT, 'desktop', 'scripts', 'd14_acceptance_check.py');
  const harness = fs.readFileSync(harnessPath, 'utf8');

  assert.ok(fs.existsSync(path.join(ROOT, 'desktop', 'scripts', 'd14_acceptance_check_test.py')));
  for (const browser of ['chrome', 'edge']) {
    assert.match(guide, new RegExp(`--browser ${browser}`));
  }
  for (const command of ['prepare', 'inspect-installed', 'installed-smoke', 'verify']) {
    assert.match(harness, new RegExp(`commands\\.add_parser\\(\"${command}\"`));
  }
  assert.match(harness, /refusing to overwrite evidence/);
  assert.match(harness, /J01-J08 were not auto-promoted/);
  assert.match(guide, /开发注册[\s\S]*不能替代/);
  assert.match(guide, /所有 case 保持 `NOT_RUN`/);

  const report = readJson(ACCEPTANCE, 'report-template.json');
  assert.ok(report.cases.every((entry) => entry.status === 'NOT_RUN'));
});

test('D14 T5 lifecycle evidence starts NOT_RUN and T6 gate fails closed by construction', () => {
  const t5 = readJson(ACCEPTANCE, 't5-report-template.json');
  const gate = readJson(ACCEPTANCE, 'release-gate-template.json');
  assert.equal(t5.phase, 'T5');
  assert.equal(t5.checks.length, 16);
  assert.equal(new Set(t5.checks.map((entry) => entry.id)).size, 16);
  assert.ok(t5.checks.every((entry) => entry.status === 'NOT_RUN'));
  assert.ok(t5.checks.every((entry) => entry.evidence.length === 0));
  assert.equal(t5.review.decision, 'NOT_REVIEWED');
  assert.equal(gate.candidateManifest, null);
  assert.equal(gate.reports.chrome, null);
  assert.equal(gate.reports.edge, null);
  assert.equal(gate.reports.t5, null);
  assert.equal(gate.review.decision, 'NOT_REVIEWED');
  for (const target of [
    'desktop/scripts/d14_t5_check.py',
    'desktop/scripts/d14_t5_check_test.py',
    'desktop/scripts/check-release-acceptance.mjs',
    'desktop/scripts/check-release-acceptance.test.mjs',
    'docs/desktop-mvp/acceptance/t5-lifecycle.md',
    'docs/desktop-mvp/acceptance/t6-release-gate.md',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, ...target.split('/'))), `${target} must exist`);
  }
});

test('d14-v1 committed JSON is exactly the deterministic generator output', () => {
  const generator = path.join(FIXTURES, 'generate.mjs');
  const result = spawnSync(process.execPath, [generator, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /fixtures are current/);
});
