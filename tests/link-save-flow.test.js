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

test('an unreliable result with page fragments asks the desktop AI first', async () => {
  const { nextSaveStep } = await load();
  const step = nextSaveStep({
    company: '金发科技股份有限公司', title: '', reliable: false,
    assistReasons: ['missing_title', 'site_title_only'],
    fragments: [{ id: 1, source: 'h1', role: 'page-title', text: '金发科技股份有限公司' }]
  });
  assert.equal(step.action, 'assist');
  assert.deepEqual(step.fragments, [{ id: 1, source: 'h1', role: 'page-title', text: '金发科技股份有限公司' }]);
  assert.deepEqual(step.reasons, ['missing_title', 'site_title_only']);
  assert.equal(step.fields.company, '金发科技股份有限公司');
});

test('the panel gets exactly the fragments that will be sent', async () => {
  const { nextSaveStep } = await load();
  const { allowFragments } = await import('../link/job-extract.mjs');
  const fragments = [
    { id: 1, source: 'jobposting-company', role: 'company', text: '星河科技股份有限公司' },
    { id: 2, source: 'document.title', role: 'page-title', text: 'Cookie 设置 - 星河科技' },
    { id: 3, source: 'h1', role: 'page-title', text: '工艺工程师' },
    { id: 4, source: 'resume', role: 'company', text: '不该出现的来源' }
  ];
  const step = nextSaveStep({ company: '星河科技股份有限公司', title: '', reliable: false, fragments });
  assert.equal(step.action, 'assist');
  assert.deepEqual(step.fragments.map(item => item.id), [1, 3]);
  assert.deepEqual(step.fragments, allowFragments(fragments), 'the worker filters with the same function');
});

test('when every fragment is filtered out, the form opens without asking the AI', async () => {
  const { nextSaveStep } = await load();
  const step = nextSaveStep({
    company: '', title: '', reliable: false, assistReasons: ['missing_company'],
    fragments: [{ id: 1, source: 'document.title', role: 'page-title', text: '联系 hr@example.com' }]
  });
  assert.equal(step.action, 'form');
  assert.equal(step.reason, 'missing_company');
});

test('every fragment source the extractor can produce is allowed and has a label', async () => {
  // extract.mjs, the allowlist here and the labels in copy.mjs each name the sources. A
  // source added to one and not the others would be dropped silently or shown unlabeled.
  const fs = require('node:fs');
  const path = require('node:path');
  const { allowFragments } = await load();
  const { describeJobAssist } = await import('../link/copy.mjs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'link', 'extract.mjs'), 'utf8');
  const body = source.slice(source.indexOf('function buildFragments'), source.indexOf('function pageHost'));
  const pairs = [...body.matchAll(/push\('([^']+)', '([^']+)'/g)].map(match => [match[1], match[2]]);
  assert.ok(pairs.length >= 8, 'buildFragments was not found');
  for (const [name, role] of pairs) {
    const fragment = { id: 1, source: name, role, text: '星河科技' };
    assert.equal(allowFragments([fragment]).length, 1, `${name} (${role}) is dropped before sending`);
    const [line] = describeJobAssist({ fragments: [fragment] }).fragments;
    assert.equal(line.includes('页面片段'), false, `${name} has no label in copy.mjs`);
  }
});

test('with nothing to send, the form opens with the first uncertainty as the reason', async () => {
  const { nextSaveStep } = await load();
  const step = nextSaveStep({
    company: '金发科技股份有限公司', title: '', reliable: false,
    assistReasons: ['missing_title', 'site_title_only'], fragments: []
  });
  assert.equal(step.action, 'form');
  assert.equal(step.reason, 'missing_title');
  assert.equal(step.fields.company, '金发科技股份有限公司');
});

test('the disclosure lists the fragments and nothing about an AI address or model', async () => {
  const { assistDisclosure } = await load();
  const disclosure = assistDisclosure([{ id: 1, source: 'h1', role: 'page-title', text: '工艺工程师', extra: 'x' }]);
  assert.deepEqual(disclosure, { fragments: [{ id: 1, source: 'h1', text: '工艺工程师' }] });
});

test('a reliable AI answer is reviewed with the locally redacted URLs', async () => {
  const { afterAssist } = await load();
  const fallback = {
    company: '', title: '', location: '',
    sourceUrl: 'https://jobs.example.test/apply?job=42', dedupeUrl: 'https://jobs.example.test/apply?job=42'
  };
  const step = afterAssist({
    status: 'ok', reliable: true,
    fields: { company: ' 金发科技股份有限公司 ', title: '研发工程师', location: '广州', sourceUrl: 'https://evil.test' }
  }, fallback);
  assert.equal(step.action, 'commit');
  assert.deepEqual(step.fields, {
    company: '金发科技股份有限公司', title: '研发工程师', location: '广州',
    sourceUrl: fallback.sourceUrl, dedupeUrl: fallback.dedupeUrl
  });
});

test('a failed or partial AI answer opens the form with what is known', async () => {
  const { afterAssist } = await load();
  const fallback = { company: '金发科技股份有限公司', title: '', location: '', sourceUrl: '', dedupeUrl: '' };
  const failed = afterAssist({ status: 'manual', reason: 'not_configured', reliable: false, fields: {} }, fallback);
  assert.equal(failed.action, 'form');
  assert.equal(failed.reason, 'not_configured');
  assert.equal(failed.fields.company, '金发科技股份有限公司');

  const same = afterAssist({
    status: 'manual', reason: 'missing_title', reliable: false,
    fields: { company: '金发科技股份有限公司', title: '金发科技股份有限公司' }
  }, fallback);
  assert.equal(same.fields.title, '', 'a company name never lands in the title field');
});

test('a reliable flag without both fields still asks the user', async () => {
  const { nextSaveStep } = await load();
  assert.equal(nextSaveStep({ company: '星河科技', title: '', reliable: true }).action, 'form');
  assert.equal(nextSaveStep(null).reason, 'manual');
});
