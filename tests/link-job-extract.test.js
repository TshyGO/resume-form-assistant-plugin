const test = require('node:test');
const assert = require('node:assert/strict');

const loadExtract = () => import('../link/extract.mjs');
const loadAssist = () => import('../link/job-extract.mjs');
const loadFlow = () => import('../link/save-flow.mjs');

const KEY = 'sk-test-secret-key';
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

function jsonResponse(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return { choices: [{ message: { content } }] }; }
  };
}

test('a configured assist sends only allowlisted fragments and keeps an evidenced job', async () => {
  const { extractJobFields } = await loadExtract();
  const { requestJobExtract } = await loadAssist();
  const fields = extractJobFields(page(), RAW_URL);
  assert.equal(fields.reliable, false);
  const calls = [];
  const result = await requestJobExtract({
    aiConfig: { apiUrl: 'https://ai.example.test/v1/chat/completions?token=drop', model: 'demo-model', apiKey: KEY },
    fragments: fields.fragments,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(JSON.stringify({
        company: '金发科技股份有限公司',
        title: '研发工程师-化工工艺研究方向',
        location: '广州',
        companyFragment: fields.fragments.find(item => item.text === '金发科技股份有限公司').id,
        titleFragment: fields.fragments.find(item => item.text === '研发工程师-化工工艺研究方向').id,
        locationFragment: fields.fragments.find(item => item.text === '研发工程师-化工工艺研究方向').id
      }));
    }
  });

  assert.equal(calls.length, 1);
  const body = calls[0].init.body;
  assert.equal(body.includes(KEY), false);
  assert.equal(body.includes(PHONE), false);
  assert.equal(body.includes(RESUME), false);
  assert.equal(body.includes(RAW_URL), false);
  assert.equal(body.includes('access_token'), false);
  assert.equal(body.includes('广州'), false);
  assert.equal(body.includes('本人简历'), false);
  assert.match(body, /金发科技股份有限公司/);
  assert.match(body, /研发工程师-化工工艺研究方向/);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(result.status, 'manual');
  assert.equal(result.fields.company, '金发科技股份有限公司');
  assert.equal(result.fields.title, '研发工程师-化工工艺研究方向');
  assert.equal(result.fields.location, '');
  assert.equal(result.reliable, false);
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

test('format errors, cancellation, timeout and network failure each ask once and then stop', async () => {
  const { requestJobExtract } = await loadAssist();
  const fragments = [
    { id: 1, source: 'jobposting-company', role: 'company', text: '金发科技股份有限公司' },
    { id: 2, source: 'beisen-apply-title', role: 'job-title', text: '你正在投递职位：研发工程师-化工工艺研究方向' }
  ];
  const config = { apiUrl: 'https://ai.example.test/v1/chat/completions', model: 'demo-model', apiKey: KEY };

  const formatCalls = [];
  const format = await requestJobExtract({
    aiConfig: config,
    fragments,
    fetchImpl: async (url, init) => {
      formatCalls.push(init.body);
      return jsonResponse('当然，公司是腾讯');
    }
  });
  assert.equal(formatCalls.length, 1);
  assert.equal(format.reason, 'format');
  assert.equal(format.fields.company, '');

  let networkCalls = 0;
  const network = await requestJobExtract({
    aiConfig: config,
    fragments,
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('offline');
    }
  });
  assert.equal(networkCalls, 1);
  assert.equal(network.reason, 'network');

  let httpCalls = 0;
  const http = await requestJobExtract({
    aiConfig: config,
    fragments,
    fetchImpl: async () => {
      httpCalls += 1;
      return jsonResponse('', 500);
    }
  });
  assert.equal(httpCalls, 1);
  assert.equal(http.reason, 'network');

  const controller = new AbortController();
  let cancelCalls = 0;
  const pending = requestJobExtract({
    aiConfig: config,
    fragments,
    signal: controller.signal,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      cancelCalls += 1;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelCalls, 1);
  assert.equal(cancelled.reason, 'cancelled');

  let timeoutCalls = 0;
  const timed = await requestJobExtract({
    aiConfig: config,
    fragments,
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      timeoutCalls += 1;
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })
  });
  assert.equal(timeoutCalls, 1);
  assert.equal(timed.reason, 'timeout');

  let skipped = 0;
  const missing = await requestJobExtract({
    aiConfig: { apiUrl: '', model: '', apiKey: '' },
    fragments,
    fetchImpl: async () => { skipped += 1; return jsonResponse('{}'); }
  });
  assert.equal(skipped, 0);
  assert.equal(missing.reason, 'unconfigured');
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

  let calls = 0;
  await requestJobExtract({
    aiConfig: { apiUrl: 'https://ai.example.test/v1', model: 'demo', apiKey: KEY },
    fragments: [
      { id: 1, source: 'resume', role: 'company', text: RESUME },
      { id: 2, source: 'document.title', role: 'page-title', text: RAW_URL }
    ],
    fetchImpl: async () => { calls += 1; return jsonResponse('{}'); }
  });
  assert.equal(calls, 0);

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
