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

// `ancestors` are the elements around this one, nearest first, each `{ tag, attrs, text }`;
// they answer `closest()` the way a real page would (the element itself counts first).
function element({ tag = 'div', className = '', text = '', attrs = {}, value = undefined, ancestors = [] }) {
  const matches = (candidate, part) => {
    const role = part.match(/^\[role="([^"]+)"\]$/);
    if (role) return candidate.attrs?.role === role[1];
    const flag = part.match(/^\[([\w-]+)="([^"]+)"\]$/);
    if (flag) return candidate.attrs?.[flag[1]] === flag[2];
    return candidate.tag === part;
  };
  return {
    tagName: tag.toUpperCase(),
    className,
    textContent: text,
    closest(selector) {
      const parts = selector.split(',').map(part => part.trim());
      const chain = [{ tag, attrs, text }, ...ancestors];
      const found = chain.find(candidate => parts.some(part => matches(candidate, part)));
      return found ? { tagName: found.tag.toUpperCase(), textContent: found.text ?? '' } : null;
    },
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

test('a Beisen tenant-name div before the apply summary identifies the employer', async () => {
  const { extractJobFields } = await load();
  const doc = richDoc({
    title: '招聘',
    elements: [
      element({ className: 'tenant-name', text: '金发科技股份有限公司' }),
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

// --- #175: a wrong local read must not be trusted, so the desktop AI gets asked ------------

function beisenPage(companyText, { tag = 'div', className = 'company-name' } = {}) {
  return richDoc({
    title: '招聘',
    elements: [
      element({ tag, className, text: companyText }),
      element({ tag: 'span', text: '你正在投递职位：研发工程师-聚合方向' })
    ]
  });
}

test('single characters, numbers, placeholders and menu or button text are never a reliable company', async () => {
  const { extractJobFields } = await load();
  const junk = ['金', '1', 'l', '请选择', '请输入公司', '12345', '2024', '首页', '登录', '立即投递', '社会招聘', '校园招聘', 'Global Jobs', '提交', '取消'];
  for (const text of junk) {
    const fields = extractJobFields(beisenPage(text), 'https://kingfa.zhiye.com/form');
    assert.equal(fields.reliable, false, `${text} must not be reliable`);
    assert.notEqual(fields.confidence, 'reliable', text);
    assert.equal(fields.company, '', `${text} must not be offered as the company`);
    assert.ok(fields.assistReasons.includes('missing_company'), text);
    assert.equal(fields.fragments.some(fragment => fragment.text === text), false, `${text} is not sent to the AI either`);
  }
});

test('interactive controls, generic organisation words and company counts never become reliable employers', async () => {
  const { extractJobFields } = await load();
  for (const [text, options] of [
    ['访问公司', { tag: 'button' }],
    ['金发科技股份有限公司', { tag: 'button' }],
    ['公司', {}],
    ['集团有限公司', {}],
    ['12 家公司', {}]
  ]) {
    const fields = extractJobFields(beisenPage(text, options), 'https://kingfa.zhiye.com/form');
    assert.equal(fields.reliable, false, `${text} must not skip AI`);
    assert.notEqual(fields.confidence, 'reliable', text);
  }
});

test('a short name with no organisation shape is only a candidate for the AI, never a settled company', async () => {
  const { extractJobFields } = await load();
  const { nextSaveStep } = await import('../link/save-flow.mjs');
  // "星河": a plausible short name, but no organisation shape. ("公安", the example this test
  // used to carry, is now page noise outright — see the test below.)
  const fields = extractJobFields(beisenPage('星河'), 'https://kingfa.zhiye.com/form');
  assert.equal(fields.confidence, 'uncertain');
  assert.equal(fields.reliable, false);
  assert.ok(fields.assistReasons.includes('company_weak_evidence'));
  assert.equal(fields.sources.company.reliable, false);
  // It is shown to the AI as a fragment, and the flow asks the AI instead of committing.
  assert.ok(fields.fragments.some(fragment => fragment.text === '星河'));
  assert.equal(nextSaveStep(fields).action, 'assist');
});

// #172 补充 lists "公安" and "招聘" among the page words that must never be a company or a
// job. Before, "公安" from a page selector was only weak, but the same word in a JobPosting
// went straight to the strong bucket, and a bare "招聘" title was accepted on either path —
// either could make the local read "reliable" and skip the AI.
test('"公安" and a bare "招聘" are page noise on every path, so they never let the local read skip the AI', async () => {
  const { extractJobFields } = await load();
  const { nextSaveStep } = await import('../link/save-flow.mjs');

  const selector = extractJobFields(beisenPage('公安'), 'https://kingfa.zhiye.com/form');
  assert.equal(selector.company, '');
  assert.notEqual(selector.confidence, 'reliable');
  assert.equal(selector.fragments.some(fragment => fragment.text === '公安'), false, 'not even sent to the AI');

  const posting = extractJobFields(fakeDoc({
    jsonLd: [{ '@type': 'JobPosting', title: '研发工程师', hiringOrganization: { name: '公安' } }]
  }), 'https://jobs.example.com/a');
  assert.equal(posting.company, '');
  assert.equal(posting.reliable, false);
  assert.notEqual(nextSaveStep(posting).action, 'commit');

  const bareTitle = extractJobFields(fakeDoc({
    jsonLd: [{ '@type': 'JobPosting', title: '招聘', hiringOrganization: { name: '星河科技' } }]
  }), 'https://jobs.example.com/a');
  assert.equal(bareTitle.title, '');
  assert.equal(bareTitle.reliable, false);
  assert.notEqual(nextSaveStep(bareTitle).action, 'commit');

  const applyTitle = extractJobFields(richDoc({
    title: '招聘',
    elements: [
      element({ className: 'company-name', text: '金发科技股份有限公司' }),
      element({ tag: 'span', text: '你正在投递职位：招聘' })
    ]
  }), 'https://kingfa.zhiye.com/form');
  assert.equal(applyTitle.title, '');
  assert.equal(applyTitle.reliable, false);

  // Real names that merely contain the words still read normally.
  const bureau = extractJobFields(fakeDoc({
    jsonLd: [{ '@type': 'JobPosting', title: '招聘专员', hiringOrganization: { name: '上海市公安局' } }]
  }), 'https://jobs.example.com/a');
  assert.equal(bureau.company, '上海市公安局');
  assert.equal(bureau.title, '招聘专员');
});

test('a company that reads like a job, or a job that reads like a company, is not reliable', async () => {
  const { extractJobFields } = await load();
  assert.equal(extractJobFields(beisenPage('研发工程师'), 'https://kingfa.zhiye.com/form').company, '');

  const doc = richDoc({
    title: '金发科技股份有限公司',
    elements: [element({ tag: 'span', text: '你正在投递职位：金发科技股份有限公司' })]
  });
  const same = extractJobFields(doc, 'https://kingfa.zhiye.com/form');
  assert.equal(same.reliable, false, 'company and job with the same text');
  assert.equal(same.confidence, 'invalid');

  const employerAsJob = extractJobFields(richDoc({
    title: '招聘',
    elements: [
      element({ className: 'company-name', text: '金发科技股份有限公司' }),
      element({ tag: 'span', text: '你正在投递职位：某某科技有限公司' })
    ]
  }), 'https://kingfa.zhiye.com/form');
  assert.equal(employerAsJob.reliable, false);
  assert.ok(employerAsJob.assistReasons.includes('title_suspicious'));

  for (const title of ['南京大学', '星河研究院', '示例银行', 'Example Corp']) {
    const suspicious = extractJobFields(richDoc({
      title: '招聘',
      elements: [
        element({ className: 'company-name', text: '金发科技股份有限公司' }),
        element({ tag: 'span', text: `你正在投递职位：${title}` })
      ]
    }), 'https://kingfa.zhiye.com/form');
    assert.equal(suspicious.reliable, false, `${title} looks like an organisation, not a job`);
    assert.ok(suspicious.assistReasons.includes('title_suspicious'));
  }
});

test('junk in a JobPosting is dropped as well', async () => {
  const { extractJobFields } = await load();
  const fields = extractJobFields(fakeDoc({
    jsonLd: [{ '@type': 'JobPosting', title: '请选择', hiringOrganization: { name: '1' } }]
  }), 'https://jobs.example.com/apply');
  assert.equal(fields.company, '');
  assert.equal(fields.title, '');
  assert.equal(fields.confidence, 'invalid');
  assert.equal(fields.reliable, false);
});

test('a page with clear company and job evidence is reliable and needs no AI', async () => {
  const { extractJobFields } = await load();
  const { nextSaveStep } = await import('../link/save-flow.mjs');
  for (const doc of [
    richDoc({
      title: '招聘',
      elements: [
        element({ className: 'company-name', text: '金发科技股份有限公司' }),
        element({ tag: 'span', text: '你正在投递职位：研发工程师-聚合方向' })
      ]
    }),
    fakeDoc({ jsonLd: [{ '@type': 'JobPosting', title: '后端开发工程师', hiringOrganization: { name: '星河科技' } }] })
  ]) {
    const fields = extractJobFields(doc, 'https://kingfa.zhiye.com/form');
    assert.equal(fields.confidence, 'reliable');
    assert.equal(fields.reliable, true);
    assert.equal(nextSaveStep(fields).action, 'commit');
  }
});

test('nothing usable is "invalid"; something read but not trusted is "uncertain"', async () => {
  const { extractJobFields } = await load();
  assert.equal(extractJobFields(fakeDoc({}), 'https://jobs.example.com/a').confidence, 'invalid');
  const titleOnly = extractJobFields(fakeDoc({
    jsonLd: [{ '@type': 'JobPosting', title: '后端开发工程师' }]
  }), 'https://jobs.example.com/a');
  assert.equal(titleOnly.confidence, 'uncertain');
});

// --- #175 review: a company name inside a link is still a company name ----------------------

const withAncestors = (text, ancestors, options = {}) => richDoc({
  title: '招聘',
  elements: [
    element({ tag: 'span', className: 'company-name', text, ancestors, ...options }),
    element({ tag: 'span', text: '你正在投递职位：研发工程师-聚合方向' })
  ]
});

test('a company name inside a link is kept: only navigation or action text makes a link interface', async () => {
  const { extractJobFields } = await load();
  const inLink = extractJobFields(
    withAncestors('金发科技股份有限公司', [{ tag: 'a', text: '金发科技股份有限公司', attrs: { href: '/company' } }]),
    'https://kingfa.zhiye.com/form'
  );
  assert.equal(inLink.company, '金发科技股份有限公司');
  assert.equal(inLink.reliable, true);
  assert.equal(inLink.confidence, 'reliable');

  const roleLink = extractJobFields(
    withAncestors('金发科技股份有限公司', [{ tag: 'div', text: '金发科技股份有限公司', attrs: { role: 'link' } }]),
    'https://kingfa.zhiye.com/form'
  );
  assert.equal(roleLink.company, '金发科技股份有限公司');

  // The link itself may carry the company class.
  const selfLink = extractJobFields(richDoc({
    title: '招聘',
    elements: [
      element({ tag: 'a', className: 'company-name', text: '金发科技股份有限公司', attrs: { href: '/company' } }),
      element({ tag: 'span', text: '你正在投递职位：研发工程师-聚合方向' })
    ]
  }), 'https://kingfa.zhiye.com/form');
  assert.equal(selfLink.company, '金发科技股份有限公司');
});

test('links whose own text is a menu or action label are still filtered, and the button wording is not loosened', async () => {
  const { extractJobFields } = await load();
  for (const label of ['首页', '登录', '访问公司', '查看详情', '访问官网', '立即投递', '职位列表', '关于我们']) {
    const nested = extractJobFields(
      withAncestors(label, [{ tag: 'a', text: label, attrs: { href: '/x' } }]),
      'https://kingfa.zhiye.com/form'
    );
    assert.equal(nested.company, '', `${label} inside a link is not a company`);
    assert.equal(nested.reliable, false, label);
    assert.equal(nested.fragments.some(fragment => fragment.text === label), false, `${label} is not sent to the AI either`);

    const self = extractJobFields(richDoc({
      title: '招聘',
      elements: [
        element({ tag: 'a', className: 'company-name', text: label, attrs: { href: '/x' } }),
        element({ tag: 'span', text: '你正在投递职位：研发工程师-聚合方向' })
      ]
    }), 'https://kingfa.zhiye.com/form');
    assert.equal(self.company, '', `${label} as a link is not a company`);
  }
});

test('buttons, navigation, form controls and hidden nodes stay filtered even around a real company name', async () => {
  const { extractJobFields } = await load();
  for (const ancestors of [
    [{ tag: 'button', text: '金发科技股份有限公司' }],
    [{ tag: 'nav', text: '金发科技股份有限公司' }],
    [{ tag: 'div', text: '金发科技股份有限公司', attrs: { role: 'button' } }],
    [{ tag: 'div', text: '金发科技股份有限公司', attrs: { role: 'menuitem' } }],
    [{ tag: 'div', text: '金发科技股份有限公司', attrs: { role: 'navigation' } }],
    [{ tag: 'div', text: '金发科技股份有限公司', attrs: { 'aria-hidden': 'true' } }],
    // A link that is itself inside a button or navigation is still interface.
    [{ tag: 'a', text: '金发科技股份有限公司' }, { tag: 'nav', text: '金发科技股份有限公司' }]
  ]) {
    const fields = extractJobFields(withAncestors('金发科技股份有限公司', ancestors), 'https://kingfa.zhiye.com/form');
    assert.equal(fields.company, '', JSON.stringify(ancestors));
    assert.equal(fields.reliable, false);
  }
  for (const tag of ['button', 'input', 'select', 'option', 'textarea', 'nav']) {
    const fields = extractJobFields(beisenPage('金发科技股份有限公司', { tag }), 'https://kingfa.zhiye.com/form');
    assert.equal(fields.company, '', tag);
  }
});

// --- this round: an English suffix must be its own word ("Zinc" is not "Z" + "Inc") -----------

test('a company literally named "Zinc" is not silently dropped: it is offered as weak evidence for the AI, not thrown away', async () => {
  const { extractJobFields } = await load();
  const fields = extractJobFields(beisenPage('Zinc'), 'https://kingfa.zhiye.com/form');
  // Before this fix, "inc" matched the tail of "Zinc" with no separator, the one-letter stem
  // "Z" failed the plausibility bar, and the company fell out of both the strong and the weak
  // bucket — the page's own company name never even reached the AI as a fragment.
  assert.equal(fields.company, 'Zinc');
  assert.equal(fields.confidence, 'uncertain');
  assert.equal(fields.reliable, false);
  assert.ok(fields.assistReasons.includes('company_weak_evidence'));
  assert.ok(fields.fragments.some(fragment => fragment.text === 'Zinc'), 'sent to the AI rather than disappearing');
});

test('"Example Inc/Inc./Ltd/Corp/GmbH" are still recognised as company suffixes and settle without AI', async () => {
  const { extractJobFields } = await load();
  for (const name of ['Example Inc', 'Example Inc.', 'Example Ltd', 'Example Corp', 'Example GmbH']) {
    const fields = extractJobFields(beisenPage(name), 'https://kingfa.zhiye.com/form');
    assert.equal(fields.company, name, name);
    assert.equal(fields.confidence, 'reliable', name);
    assert.equal(fields.reliable, true, name);
  }
});

test('a compound English word with no separator before the suffix ("Buildcorp") is weak evidence, not an accepted "name + corp" split', async () => {
  const { extractJobFields } = await load();
  const fields = extractJobFields(beisenPage('Buildcorp'), 'https://kingfa.zhiye.com/form');
  // Before this fix, stripping "corp" left the plausible stem "Build", so the whole compound
  // was accepted as reliable on the strength of a suffix the page never actually separated out.
  assert.equal(fields.company, 'Buildcorp');
  assert.equal(fields.confidence, 'uncertain');
  assert.equal(fields.reliable, false);
});

test('an English suffix inside an ordinary word is still not a suffix match, whatever the case', async () => {
  const { extractJobFields } = await load();
  for (const name of ['zinc', 'ZINC', 'Vinci']) {
    const fields = extractJobFields(beisenPage(name), 'https://kingfa.zhiye.com/form');
    assert.notEqual(fields.confidence, 'reliable', name);
  }
  // A real separator before the suffix still settles it, lower-case included.
  const separated = extractJobFields(beisenPage('incredible corp'), 'https://kingfa.zhiye.com/form');
  assert.equal(separated.confidence, 'reliable');
});
