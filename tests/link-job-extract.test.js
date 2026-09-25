const test = require('node:test');
const assert = require('node:assert/strict');

const loadExtract = () => import('../link/extract.mjs');
const loadAssist = () => import('../link/job-extract.mjs');
const loadFlow = () => import('../link/save-flow.mjs');

const RAW_URL = 'https://kingfa.zhiye.com/form?access_token=abc&job=42';
const PHONE = '13800138000';
const RESUME = 'secret-resume-marker';

function element({ tag = 'div', className = '', text = '', attrs = {} }) {
  return {
    tagName: tag.toUpperCase(),
    className,
    textContent: text,
    getAttribute: name => attrs[name] ?? null,
    querySelector() { return null; }
  };
}

function page() {
  const nodes = [
    element({ className: 'company-name', text: '示例公司' }),
    element({ tag: 'p', className: 'job-name', text: '你正在投递职位：工艺工程师' }),
    element({ tag: 'p', className: 'preference', text: '意向工作地点：广州' }),
    element({ tag: 'input', attrs: { value: PHONE }, text: PHONE }),
    element({ tag: 'article', className: 'resume', text: `本人简历 ${RESUME}` })
  ];
  const match = (selector, node) => selector.split(',').some(part => {
    const sel = part.trim();
    if (sel === node.tagName.toLowerCase()) return true;
    const classMatch = sel.match(/^\[class\*="([^"]+)"\]$/);
    return Boolean(classMatch && node.className.includes(classMatch[1]));
  });
  return {
    title: '示例公司',
    querySelectorAll(selector) {
      if (selector.includes('ld+json')) {
        return [{ textContent: JSON.stringify({
          '@type': 'JobPosting',
          hiringOrganization: { name: '金发科技股份有限公司' },
          jobLocation: { address: { addressLocality: '意向工作地点' } }
        }) }];
      }
      return nodes.filter(node => match(selector, node));
    },
    querySelector(selector) {
      const property = selector.match(/property="([^"]+)"/)?.[1];
      if (property === 'og:title') return { getAttribute: () => '研发工程师-化工工艺研究方向' };
      return null;
    }
  };
}

const FRAGMENTS = [
  { id: 1, source: 'jobposting-company', role: 'company', text: '金发科技股份有限公司' },
  { id: 2, source: 'beisen-apply-title', role: 'job-title', text: '你正在投递职位：研发工程师-化工工艺研究方向' }
];

// Stands in for the desktop's ai.complete. Like the real one, it answers `cancelled` once
// the caller's signal fires and records every request it was asked to send.
function desktop(answer) {
  const calls = [];
  const complete = request => {
    calls.push(request);
    if (request.signal?.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' });
    return new Promise(resolve => {
      request.signal?.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }), { once: true });
      if (answer !== undefined) Promise.resolve(typeof answer === 'function' ? answer(request) : answer).then(resolve);
    });
  };
  return { calls, complete };
}

test('the desktop gets only allowlisted fragments and an evidenced job comes back', async () => {
  const { extractJobFields } = await loadExtract();
  const { requestJobExtract } = await loadAssist();
  const fields = extractJobFields(page(), RAW_URL);
  assert.equal(fields.reliable, false);
  const { calls, complete } = desktop(() => ({ ok: true, text: JSON.stringify({
    company: '金发科技股份有限公司',
    title: '研发工程师-化工工艺研究方向',
    location: '广州',
    companyFragment: fields.fragments.find(item => item.text === '金发科技股份有限公司').id,
    titleFragment: fields.fragments.find(item => item.text === '研发工程师-化工工艺研究方向').id,
    locationFragment: fields.fragments.find(item => item.text === '研发工程师-化工工艺研究方向').id
  }) }));
  const result = await requestJobExtract({ complete, fragments: fields.fragments });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, 'extract_job');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['purpose', 'signal', 'system', 'user']);
  const body = calls[0].system + calls[0].user;
  assert.equal(body.includes(PHONE), false);
  assert.equal(body.includes(RESUME), false);
  assert.equal(body.includes(RAW_URL), false);
  assert.equal(body.includes('access_token'), false);
  assert.equal(body.includes('广州'), false);
  assert.equal(body.includes('本人简历'), false);
  assert.match(calls[0].user, /金发科技股份有限公司/);
  assert.match(calls[0].user, /研发工程师-化工工艺研究方向/);
  assert.equal(result.status, 'manual');
  assert.equal(result.reason, 'location_no_evidence');
  assert.equal(result.fields.company, '金发科技股份有限公司');
  assert.equal(result.fields.title, '研发工程师-化工工艺研究方向');
  assert.equal(result.fields.location, '');
  assert.equal(result.reliable, false);
});

test('a reliable desktop answer is kept as the job to review', async () => {
  const { requestJobExtract } = await loadAssist();
  const { complete } = desktop({ ok: true, text: '```json\n' + JSON.stringify({
    company: '金发科技股份有限公司', title: '研发工程师-化工工艺研究方向', location: '',
    companyFragment: 1, titleFragment: 2, locationFragment: null
  }) + '\n```' });
  const result = await requestJobExtract({ complete, fragments: FRAGMENTS });
  assert.equal(result.status, 'ok');
  assert.equal(result.reliable, true);
  assert.deepEqual(result.fields, { company: '金发科技股份有限公司', title: '研发工程师-化工工艺研究方向', location: '' });
});

test('a model answer with no page evidence does not become fields', async () => {
  const { judgeSuggestion } = await loadAssist();
  const fragments = [
    { id: 1, source: 'jobposting-company', role: 'company', text: '金发科技股份有限公司' },
    { id: 2, source: 'og:title', role: 'page-title', text: '研发工程师-化工工艺研究方向' }
  ];
  const judged = judgeSuggestion({
    company: '腾讯',
    title: '金发科技股份有限公司',
    location: '上海',
    companyFragment: 1,
    titleFragment: 1,
    locationFragment: 2
  }, fragments);

  assert.equal(judged.status, 'manual');
  assert.equal(judged.reliable, false);
  assert.equal(judged.fields.company, '');
  assert.equal(judged.fields.title, '');
  assert.equal(judged.fields.location, '');
});

test('a company without evidence is dropped alone; title and location with evidence stay', async () => {
  const { judgeSuggestion } = await loadAssist();
  const fragments = [
    { id: 1, source: 'jobposting-company', role: 'company', text: '金发科技股份有限公司' },
    { id: 2, source: 'jobposting-title', role: 'job-title', text: '研发工程师' },
    { id: 3, source: 'jobposting-location', role: 'job-location', text: '广州' }
  ];
  const judged = judgeSuggestion({
    company: '腾讯', title: '研发工程师', location: '广州',
    companyFragment: 1, titleFragment: 2, locationFragment: 3
  }, fragments);
  assert.equal(judged.reason, 'no_evidence');
  assert.deepEqual(judged.fields, { company: '', title: '研发工程师', location: '广州' });
});

test('an apply label cannot become part of the saved job title', async () => {
  const { judgeSuggestion } = await loadAssist();
  const fragments = [
    { id: 1, source: 'beisen-company', role: 'company', text: '金发科技股份有限公司' },
    { id: 2, source: 'beisen-apply-title', role: 'job-title', text: '你正在投递职位：研发工程师-化工工艺研究方向' }
  ];
  const result = judgeSuggestion({
    company: '金发科技股份有限公司',
    title: '你正在投递职位：研发工程师-化工工艺研究方向',
    location: '', companyFragment: 1, titleFragment: 2, locationFragment: null
  }, fragments);
  assert.equal(result.status, 'manual');
  assert.equal(result.fields.title, '');
});

test('a page title without local company evidence still gets the desktop AI chance', async () => {
  const { nextSaveStep } = await loadFlow();
  const result = nextSaveStep({
    reliable: false, company: '', title: '',
    fragments: [{ id: 1, source: 'document.title', role: 'page-title', text: '招聘岗位' }]
  });
  assert.equal(result.action, 'assist');
});

test('AI may identify a standalone company page title, but not a mixed recruiting title', async () => {
  const { judgeSuggestion } = await loadAssist();
  const fragments = [
    { id: 1, source: 'document.title', role: 'page-title', text: '金发科技股份有限公司' },
    { id: 2, source: 'h1', role: 'page-title', text: '工艺工程师' }
  ];
  const proposed = {
    company: '金发科技股份有限公司', title: '工艺工程师', location: '',
    companyFragment: 1, titleFragment: 2, locationFragment: null
  };
  assert.equal(judgeSuggestion(proposed, fragments).status, 'ok');

  const mixed = [{ ...fragments[0], text: '工艺工程师 - 金发科技股份有限公司' }, fragments[1]];
  const rejected = judgeSuggestion({ ...proposed, company: mixed[0].text }, mixed);
  assert.equal(rejected.status, 'manual');
  assert.equal(rejected.fields.company, '');
});

test('format errors, desktop failures, cancellation and timeout each ask once and then stop', async () => {
  const { requestJobExtract } = await loadAssist();

  const format = desktop({ ok: true, text: '当然，公司是腾讯' });
  const formatted = await requestJobExtract({ complete: format.complete, fragments: FRAGMENTS });
  assert.equal(format.calls.length, 1);
  assert.equal(formatted.reason, 'format');
  assert.equal(formatted.fields.company, '');

  for (const reason of ['not_configured', 'unavailable', 'incompatible', 'timeout']) {
    const failed = desktop({ ok: false, reason });
    const result = await requestJobExtract({ complete: failed.complete, fragments: FRAGMENTS });
    assert.equal(failed.calls.length, 1, reason);
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, reason);
    assert.deepEqual(result.failure, { reason });
  }

  const http = desktop({ ok: false, reason: 'http', httpStatus: 502, host: 'api.example.test' });
  const httpResult = await requestJobExtract({ complete: http.complete, fragments: FRAGMENTS });
  assert.deepEqual(httpResult.failure, { reason: 'http', httpStatus: 502 });

  let thrown = 0;
  const broken = await requestJobExtract({
    complete: async () => { thrown += 1; throw new Error('port closed'); },
    fragments: FRAGMENTS
  });
  assert.equal(thrown, 1);
  assert.equal(broken.reason, 'unavailable');

  const controller = new AbortController();
  const waiting = desktop();
  const pending = requestJobExtract({ complete: waiting.complete, fragments: FRAGMENTS, signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  assert.equal(waiting.calls.length, 1);
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal('failure' in cancelled, false);

  const slow = desktop();
  const timed = await requestJobExtract({ complete: slow.complete, fragments: FRAGMENTS, timeoutMs: 20 });
  assert.equal(slow.calls.length, 1);
  assert.equal(slow.calls[0].signal.aborted, true, 'the desktop call is closed when the wait runs out');
  assert.equal(timed.reason, 'timeout');
  assert.equal('failure' in timed, false);

  const early = desktop({ ok: true, text: '{}' });
  const aborted = new AbortController();
  aborted.abort();
  const skipped = await requestJobExtract({ complete: early.complete, fragments: FRAGMENTS, signal: aborted.signal });
  assert.equal(skipped.reason, 'cancelled');
  assert.equal(early.calls.length, 0);
});

test('a forbidden fragment never reaches the request, and a reliable local job skips assist', async () => {
  const { allowFragments, requestJobExtract } = await loadAssist();
  const { nextSaveStep, afterAssist } = await loadFlow();
  const allowed = allowFragments([
    { id: 1, source: 'resume', role: 'company', text: RESUME },
    { id: 2, source: 'jobposting-company', role: 'company', text: `见 ${RAW_URL}` },
    { id: 3, source: 'jobposting-title', role: 'job-title', text: '研发工程师-化工工艺研究方向' }
  ]);
  assert.deepEqual(allowed.map(item => item.id), [3]);

  const { calls, complete } = desktop({ ok: true, text: '{}' });
  const nothing = await requestJobExtract({
    complete,
    fragments: [
      { id: 1, source: 'resume', role: 'company', text: RESUME },
      { id: 2, source: 'document.title', role: 'page-title', text: RAW_URL }
    ]
  });
  assert.equal(calls.length, 0);
  assert.equal(nothing.reason, 'no_fragments');

  const step = nextSaveStep({
    reliable: true,
    company: '金发科技股份有限公司',
    title: '研发工程师-化工工艺研究方向',
    location: '',
    sourceUrl: 'https://kingfa.zhiye.com/form?job=42',
    dedupeUrl: 'https://kingfa.zhiye.com/form?job=42',
    fragments: []
  });
  assert.equal(step.action, 'commit');
  assert.equal(step.fields.location, '');

  const corrected = afterAssist({ status: 'manual', reason: 'format', fields: { company: '', title: '', location: '' } }, {
    company: '金发科技股份有限公司',
    title: '',
    location: '',
    sourceUrl: 'https://kingfa.zhiye.com/form?job=42',
    dedupeUrl: 'https://kingfa.zhiye.com/form?job=42'
  });
  assert.equal(corrected.action, 'form');
  assert.equal(corrected.fields.company, '金发科技股份有限公司');
  assert.equal(corrected.fields.title, '');
  assert.equal(corrected.fields.location, '');
  assert.equal(corrected.reason, 'format');
});
