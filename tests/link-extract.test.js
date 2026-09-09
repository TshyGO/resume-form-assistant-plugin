const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../link/extract.mjs');

// A minimal stand-in for the four things extraction reads from a page.
function fakeDoc({ jsonLd = [], meta = {}, h1 = null, title = '' } = {}) {
  return {
    title,
    querySelectorAll(selector) {
      if (selector.includes('ld+json')) {
        return jsonLd.map(entry => ({ textContent: typeof entry === 'string' ? entry : JSON.stringify(entry) }));
      }
      return [];
    },
    querySelector(selector) {
      const property = selector.match(/property="([^"]+)"/)?.[1];
      if (property) return property in meta ? { getAttribute: () => meta[property] } : null;
      if (selector === 'h1') return h1 === null ? null : { textContent: h1 };
      return null;
    }
  };
}

test('a JobPosting fills company, title and location', async () => {
  const { extractJobFields } = await load();
  const doc = fakeDoc({
    jsonLd: [{
      '@type': 'JobPosting',
      title: '后端开发工程师',
      hiringOrganization: { '@type': 'Organization', name: '星河科技' },
      jobLocation: { address: { addressLocality: '上海' } }
    }]
  });

  const fields = extractJobFields(doc, 'https://jobs.example.com/apply');

  assert.equal(fields.company, '星河科技');
  assert.equal(fields.title, '后端开发工程师');
  assert.equal(fields.location, '上海');
});

test('a page with only a document title leaves the company blank', async () => {
  const { extractJobFields } = await load();
  // og:site_name is the job board, not the employer. Filling the company with it would be
  // the fabrication #20 forbids — and the user would confirm it without noticing.
  const doc = fakeDoc({ title: '后端开发工程师 - 招聘', meta: { 'og:site_name': '示例招聘网' } });

  const fields = extractJobFields(doc, 'https://jobs.example.com/apply');

  assert.equal(fields.company, '');
  assert.equal(fields.title, '后端开发工程师 - 招聘');
});

test('og:title is preferred over the document title', async () => {
  const { extractJobFields } = await load();
  const doc = fakeDoc({ title: '后端开发 - 示例招聘网 - 第 1 页', meta: { 'og:title': '后端开发工程师' } });

  assert.equal(extractJobFields(doc, 'https://jobs.example.com/a').title, '后端开发工程师');
});

test('a heading is used when there is no structured data at all', async () => {
  const { extractJobFields } = await load();

  const fields = extractJobFields(fakeDoc({ h1: '  测试开发工程师  ' }), 'https://jobs.example.com/a');

  assert.equal(fields.title, '测试开发工程师');
});

test('the URL arrives already redacted', async () => {
  const { extractJobFields } = await load();

  const fields = extractJobFields(fakeDoc({}), 'https://jobs.example.com/apply?access_token=abc&job=42');

  assert.equal(fields.sourceUrl, 'https://jobs.example.com/apply?job=42');
  assert.equal(fields.dedupeUrl, 'https://jobs.example.com/apply?job=42');
});

test('an http page contributes no URL and no error', async () => {
  const { extractJobFields } = await load();

  const fields = extractJobFields(fakeDoc({ title: '后端开发' }), 'http://jobs.example.com/apply');

  assert.equal(fields.sourceUrl, '');
  assert.equal(fields.title, '后端开发');
});

test('broken structured data does not break extraction', async () => {
  const { extractJobFields } = await load();
  const doc = fakeDoc({ jsonLd: ['{ not json at all'], title: '后端开发' });

  const fields = extractJobFields(doc, 'https://jobs.example.com/a');

  assert.equal(fields.title, '后端开发');
  assert.equal(fields.company, '');
});

test('a JobPosting nested in an @graph is still found', async () => {
  const { extractJobFields } = await load();
  const doc = fakeDoc({
    jsonLd: [{ '@graph': [{ '@type': 'WebPage' }, { '@type': 'JobPosting', title: '数据分析', hiringOrganization: { name: '星河科技' } }] }]
  });

  const fields = extractJobFields(doc, 'https://jobs.example.com/a');

  assert.equal(fields.company, '星河科技');
  assert.equal(fields.title, '数据分析');
});

test('a hiring organisation given as a bare string is read', async () => {
  const { extractJobFields } = await load();
  const doc = fakeDoc({ jsonLd: [{ '@type': 'JobPosting', title: '后端', hiringOrganization: '星河科技' }] });

  assert.equal(extractJobFields(doc, 'https://jobs.example.com/a').company, '星河科技');
});

test('extraction reads nothing beyond the four fields it reports', async () => {
  const { extractJobFields } = await load();
  const seen = [];
  const doc = fakeDoc({ title: '后端开发' });
  const watched = {
    ...doc,
    get body() { seen.push('body'); return null; },
    querySelectorAll(selector) { seen.push(selector); return doc.querySelectorAll(selector); },
    querySelector(selector) { seen.push(selector); return doc.querySelector(selector); }
  };

  extractJobFields(watched, 'https://jobs.example.com/a');

  // #20: no page HTML, no browsing history, nothing the user did not ask to save.
  assert.equal(seen.includes('body'), false);
  assert.ok(seen.every(selector => /ld\+json|og:|^h1$/.test(selector)), seen.join(', '));
});
