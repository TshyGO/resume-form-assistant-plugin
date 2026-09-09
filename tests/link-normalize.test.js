const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../link/normalize.mjs');

test('a company folds its legal suffix away', async () => {
  const { normalizeCompany } = await load();

  assert.equal(normalizeCompany('星河科技有限公司'), normalizeCompany('星河科技'));
  assert.equal(normalizeCompany('星河科技股份有限公司'), normalizeCompany('星河科技'));
});

test('two different companies do not fold into one', async () => {
  const { normalizeCompany } = await load();
  // Over-folding is worse than under-folding here: it silently offers the wrong existing
  // application as a binding candidate.
  assert.notEqual(normalizeCompany('星河科技有限公司'), normalizeCompany('星海科技有限公司'));
  assert.notEqual(normalizeCompany('北京星河'), normalizeCompany('上海星河'));
});

test('full-width characters and stray spacing fold', async () => {
  const { normalizeCompany } = await load();

  assert.equal(normalizeCompany('　星河ＡＩ　'), normalizeCompany('星河AI'));
});

test('a latin company folds its suffix and case', async () => {
  const { normalizeCompany } = await load();

  assert.equal(normalizeCompany('Example, Inc.'), normalizeCompany('example'));
  assert.equal(normalizeCompany('Example Co., Ltd.'), normalizeCompany('Example'));
});

test('a title collapses internal whitespace without folding meaning', async () => {
  const { normalizeTitle } = await load();

  assert.equal(normalizeTitle('  后端　 开发  '), normalizeTitle('后端 开发'));
  assert.notEqual(normalizeTitle('后端开发'), normalizeTitle('测试开发'));
});

test('the triple is the same posting seen twice', async () => {
  const { normalizeTriple } = await load();
  const a = normalizeTriple({ company: '星河科技有限公司', title: '后端开发 ', dedupeUrl: 'https://jobs.example.com/apply' });
  const b = normalizeTriple({ company: '星河科技', title: '后端开发', dedupeUrl: 'https://jobs.example.com/apply' });

  assert.equal(a, b);
});

test('the same company hiring for two roles gives two triples', async () => {
  const { normalizeTriple } = await load();
  // Walkthrough 10.1: two roles at one company are two applications, never one.
  const backend = normalizeTriple({ company: '星河科技', title: '后端开发', dedupeUrl: 'https://jobs.example.com/a' });
  const qa = normalizeTriple({ company: '星河科技', title: '测试开发', dedupeUrl: 'https://jobs.example.com/b' });

  assert.notEqual(backend, qa);
});

test('field boundaries cannot be shifted to fake a match', async () => {
  const { normalizeTriple } = await load();
  // Without a separator "星河" + "科技后端" and "星河科技" + "后端" produce the same key, and
  // the dedupe check would then refuse to save a genuinely different posting.
  const a = normalizeTriple({ company: '星河', title: '科技后端' });
  const b = normalizeTriple({ company: '星河科技', title: '后端' });

  assert.notEqual(a, b);
});

test('a missing URL still produces a usable triple', async () => {
  const { normalizeTriple } = await load();

  const withoutUrl = normalizeTriple({ company: '星河科技', title: '后端开发', dedupeUrl: null });

  assert.equal(typeof withoutUrl, 'string');
  assert.equal(withoutUrl, normalizeTriple({ company: '星河科技', title: '后端开发' }));
});

test('normalising does not touch the strings the user confirmed', async () => {
  const { normalizeTriple } = await load();
  // §7: the original strings are always kept; normalisation exists only for comparison.
  const fields = { company: '星河科技有限公司', title: ' 后端  开发 ', dedupeUrl: 'https://jobs.example.com/apply' };
  const snapshot = JSON.stringify(fields);

  normalizeTriple(fields);

  assert.equal(JSON.stringify(fields), snapshot);
});
