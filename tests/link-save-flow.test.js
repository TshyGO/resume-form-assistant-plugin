const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../link/save-flow.mjs');

test('a reliable company and title go to review as extracted', async () => {
  const { nextSaveStep } = await load();
  const step = nextSaveStep({
    company: ' 金发科技股份有限公司 ', title: '研发工程师', location: '', reliable: true,
    sourceUrl: 'https://jobs.example.test/a', dedupeUrl: 'https://jobs.example.test/a',
    fragments: [{ id: 1, source: 'h1', text: 'x' }]
  });
  assert.equal(step.action, 'commit');
  assert.deepEqual(step.fields, {
    company: '金发科技股份有限公司', title: '研发工程师', location: '',
    sourceUrl: 'https://jobs.example.test/a', dedupeUrl: 'https://jobs.example.test/a'
  });
  assert.equal('fragments' in step.fields, false, 'page snippets never ride along with the save');
});

test('anything less opens the form with the first uncertainty as the reason', async () => {
  const { nextSaveStep } = await load();
  const step = nextSaveStep({
    company: '金发科技股份有限公司', title: '', reliable: false,
    assistReasons: ['missing_title', 'site_title_only'],
    fragments: [{ id: 1, source: 'h1', text: '金发科技股份有限公司' }]
  });
  assert.equal(step.action, 'form');
  assert.equal(step.reason, 'missing_title');
  assert.equal(step.fields.company, '金发科技股份有限公司');
});

test('a reliable flag without both fields still asks the user', async () => {
  const { nextSaveStep } = await load();
  assert.equal(nextSaveStep({ company: '星河科技', title: '', reliable: true }).action, 'form');
  assert.equal(nextSaveStep(null).reason, 'manual');
});
