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
  assert.equal(fields.reliable, true);
  assert.equal(fields.sources.company.source, 'jobposting');
  assert.equal(fields.sources.location.source, 'jobposting');
});

test('a page with only a document title leaves the company blank', async () => {
  const { extractJobFields } = await load();
  // og:site_name is the job board, not the employer. Filling the company with it would be
  // the fabrication #20 forbids — and the user would confirm it without noticing.
  const doc = fakeDoc({ title: '后端开发工程师 - 招聘', meta: { 'og:site_name': '示例招聘网' } });

  const fields = extractJobFields(doc, 'https://jobs.example.com/apply');

  assert.equal(fields.company, '');
  assert.equal(fields.title, '');
  assert.equal(fields.reliable, false);
  assert.ok(fields.fragments.some(fragment => fragment.source === 'document.title' && fragment.role === 'page-title'));
});

test('og:title and a heading stay candidates and are not saved as the job title', async () => {
  const { extractJobFields } = await load();
  const doc = fakeDoc({ title: '后端开发 - 示例招聘网 - 第 1 页', meta: { 'og:title': '后端开发工程师' }, h1: '  测试开发工程师  ' });

  const fields = extractJobFields(doc, 'https://jobs.example.com/a');

  assert.equal(fields.title, '');
  assert.equal(fields.company, '');
  assert.ok(fields.fragments.some(fragment => fragment.text === '后端开发工程师' && fragment.role === 'page-title'));
  assert.ok(fields.fragments.some(fragment => fragment.text === '测试开发工程师' && fragment.source === 'h1'));
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
  assert.equal(fields.title, '');
});

test('broken structured data does not break extraction', async () => {
  const { extractJobFields } = await load();
  const doc = fakeDoc({ jsonLd: ['{ not json at all'], title: '后端开发' });

  const fields = extractJobFields(doc, 'https://jobs.example.com/a');

  assert.equal(fields.title, '');
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

function element({ tag = 'div', className = '', text = '', attrs = {}, value = undefined }) {
  return {
    tagName: tag.toUpperCase(),
    className,
    textContent: text,
    getAttribute: name => attrs[name] ?? null,
    querySelector(selector) {
      if (selector.includes('input') && tag === 'input') return this;
      return null;
    },
    get value() {
      if (value !== undefined) throw new Error('form value was read');
      return '';
    }
  };
}

function richDoc({ title = '', meta = {}, elements = [], jsonLd = [] } = {}) {
  const nodes = elements;
  const match = (selector, node) => selector.split(',').some(part => {
    const sel = part.trim();
    if (sel === node.tagName.toLowerCase()) return true;
    const classMatch = sel.match(/^\[class\*="([^"]+)"\]$/);
    if (classMatch) return node.className.includes(classMatch[1]);
    if (sel === 'img[alt]') return node.tagName === 'IMG' && node.getAttribute('alt');
    return false;
  });
  return {
    title,
    querySelectorAll(selector) {
      if (selector.includes('ld+json')) {
        return jsonLd.map(entry => ({ textContent: JSON.stringify(entry) }));
      }
      return nodes.filter(node => match(selector, node));
    },
    querySelector(selector) {
      const property = selector.match(/property="([^"]+)"/)?.[1];
      if (property) return property in meta ? { getAttribute: () => meta[property] } : null;
      if (selector === 'h1') return nodes.find(node => node.tagName === 'H1') ?? null;
      return null;
    }
  };
}

test('a Beisen apply form reads the labelled company and the full job name, not the page title', async () => {
  const { extractJobFields } = await load();
  const doc = richDoc({
    title: '金发科技股份有限公司',
    meta: { 'og:title': '金发科技股份有限公司' },
    elements: [
      element({ className: 'company-name', text: '金发科技股份有限公司' }),
      element({ tag: 'p', className: 'job-name', text: '你正在投递职位：研发工程师-化工工艺研究方向' }),
      element({ tag: 'p', className: 'preference', text: '意向工作地点：上海' }),
      element({ tag: 'input', className: 'phone', attrs: { name: 'mobile' }, value: '13800138000' }),
      element({ tag: 'article', className: 'resume', text: '本人简历 secret-resume-marker' })
    ]
  });

  const fields = extractJobFields(doc, 'https://kingfa.zhiye.com/form?access_token=abc&job=42');

  assert.equal(fields.company, '金发科技股份有限公司');
  assert.equal(fields.title, '研发工程师-化工工艺研究方向');
  assert.equal(fields.location, '');
  assert.equal(fields.reliable, true);
  assert.equal(fields.sources.company.source, 'beisen-company');
  assert.equal(fields.sources.title.source, 'beisen-apply-title');
  assert.equal(fields.sources.location, null);
  assert.equal(fields.sourceUrl.includes('access_token'), false);
  assert.equal(JSON.stringify(fields.fragments).includes('13800138000'), false);
  assert.equal(JSON.stringify(fields.fragments).includes('secret-resume-marker'), false);
  assert.equal(JSON.stringify(fields.fragments).includes('上海'), false);
  assert.equal(JSON.stringify(fields.fragments).includes('access_token'), false);
});

test('a Beisen apply page can read the employer from the only short company line', async () => {
  const { extractJobFields } = await load();
  const doc = richDoc({
    title: '招聘',
    elements: [
      element({ tag: 'span', text: '金发科技股份有限公司' }),
      element({ tag: 'span', text: '你正在投递职位：研发工程师-化工工艺研究方向' }),
      element({ tag: 'span', text: '意向工作地点：上海' })
    ]
  });

  const fields = extractJobFields(doc, 'https://kingfa.zhiye.com/campus/apply');

  assert.equal(fields.company, '金发科技股份有限公司');
  assert.equal(fields.title, '研发工程师-化工工艺研究方向');
  assert.equal(fields.location, '');
  assert.equal(fields.reliable, true);
});

test('an avatar alt and a later resume employer cannot become the posting company', async () => {
  const { extractJobFields } = await load();
  const doc = richDoc({
    title: '招聘',
    elements: [
      element({ tag: 'img', attrs: { alt: '用户头像' } }),
      element({ tag: 'span', text: '你正在投递职位：工艺工程师' }),
      element({ tag: 'span', text: '药明康德有限公司' })
    ]
  });

  const fields = extractJobFields(doc, 'https://kingfa.zhiye.com/form');
  assert.equal(fields.company, '');
  assert.equal(fields.title, '工艺工程师');
  assert.equal(fields.reliable, false);
  assert.equal(fields.fragments.some(fragment => fragment.text === '用户头像' || fragment.text === '药明康德有限公司'), false);
});

test('a Beisen page title can identify the employer without trusting image alt', async () => {
  const { extractJobFields } = await load();
  const doc = richDoc({
    title: '金发科技股份有限公司',
    elements: [
      element({ tag: 'img', attrs: { alt: '用户头像' } }),
      element({ tag: 'span', text: '你正在投递职位：工艺工程师' })
    ]
  });

  const fields = extractJobFields(doc, 'https://kingfa.zhiye.com/form');
  assert.equal(fields.company, '金发科技股份有限公司');
  assert.equal(fields.title, '工艺工程师');
  assert.equal(fields.reliable, true);
});

test('the same Beisen wording on an unknown site is not treated as a labelled job', async () => {
  const { extractJobFields } = await load();
  const doc = richDoc({
    elements: [
      element({ className: 'company-name', text: '金发科技股份有限公司' }),
      element({ tag: 'p', className: 'job-name', text: '你正在投递职位：研发工程师-化工工艺研究方向' })
    ]
  });

  const fields = extractJobFields(doc, 'https://jobs.example.com/apply');

  assert.equal(fields.company, '');
  assert.equal(fields.title, '');
  assert.equal(fields.reliable, false);
});

test('a Beisen company and a different JobPosting company are a conflict, not a guess', async () => {
  const { extractJobFields } = await load();
  const doc = richDoc({
    elements: [
      element({ className: 'company-name', text: '金发科技股份有限公司' }),
      element({ tag: 'p', className: 'job-name', text: '你正在投递职位：研发工程师-化工工艺研究方向' })
    ],
    jsonLd: [{ '@type': 'JobPosting', title: '研发工程师-化工工艺研究方向', hiringOrganization: { name: '另一家公司' } }]
  });

  const fields = extractJobFields(doc, 'https://kingfa.zhiye.com/form');

  assert.equal(fields.company, '');
  assert.equal(fields.title, '研发工程师-化工工艺研究方向');
  assert.equal(fields.reliable, false);
  assert.ok(fields.assistReasons.includes('company_conflict'));
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
  assert.equal(seen.includes('body'), false);
  assert.ok(seen.every(selector => !/article|resume|cookie|form/.test(selector)), seen.join('\n'));
});
