// #301 P4a：这个标签页做过「保存岗位到桌面端」时，手动反馈的预览带 [岗位]：公司和岗位从哪来、还缺哪个、
// 有没有请 AI 识别和它的结果码、最后怎么结束。只有固定的词，不含公司、岗位、网页片段或网址；没做过就没有这一段，
// 自动报告也不带。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { openPanel, settle, RELIABLE_JOB, UNRELIABLE_JOB } = require('./helpers/sidepanel-harness.js');
const core = require('../feedback-core.js');

// What extract.mjs reports: 北森 gave the company by its site rule, the title is missing.
const BEISEN_JOB = { ...UNRELIABLE_JOB,
  sources: { company: { value: '金发科技股份有限公司', source: 'beisen-company', reliable: true }, title: null, location: null } };
const POSTING_JOB = { ...RELIABLE_JOB, sources: { company: { value: '星河科技', source: 'jobposting', reliable: true },
  title: { value: '后端开发工程师', source: 'jobposting', reliable: true }, location: null } };
const JOB_TEXT = ['金发科技', '研发工程师', '化工工艺', '你正在投递', '星河科技', '后端开发', 'job=42', 'token=secret', 'jobs.example.com/123'];
const block = lines => ['[岗位]', ...lines].join('\n');

// The side panel's 手动反馈问题 (the real feedback-ui.js, in jsdom) against the real worker router; the page
// answers RESUME_PANEL_STATUS from the real content.js. Only a preview is made: nothing is sent.
async function preview(panel) {
  const { installFeedback } = await import('../link/feedback.mjs');
  const origin = 'chrome-extension://test/';
  let listener;
  const data = {};
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('nothing may be sent from a preview'); };
  try {
    installFeedback({
      runtime: { id: 'test', getURL: p => origin + p, getManifest: () => ({ version: '0.4.4' }), onMessage: { addListener: fn => { listener = fn; } } },
      storage: { local: { get: async () => structuredClone(data), set: async value => Object.assign(data, structuredClone(value)) } },
      tabs: { get: async () => ({ url: 'https://kingfa.zhiye.com/apply?job=42' }) },
      management: { getSelf: async () => ({ installType: 'normal' }) }
    });
    const { window } = new JSDOM('<div id="feedback-notice-root" hidden></div><div id="feedback-manual-root"></div>'
      + '<div id="feedback-auto-root" data-variant="compact"></div>', { runScripts: 'outside-only' });
    const sender = { id: 'test', url: `${origin}sidepanel.html`, documentId: 'doc-1' };
    window.chrome = {
      runtime: { sendMessage: message => new Promise(resolve => listener(message, sender, resolve)) },
      tabs: { query: async () => [{ id: 7 }], sendMessage: async (_tabId, message) => panel.page.deliver(message),
        onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
      storage: { onChanged: { addListener() {} } }
    };
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'feedback-core.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'feedback-ui.js'), 'utf8'));
    const $ = id => window.document.getElementById(id);
    $('feedback-expand').click();
    $('feedback-description').value = '保存岗位时岗位名没读出来';
    $('feedback-preview-button').click();
    for (let i = 0; i < 100 && $('feedback-preview').hidden; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal($('feedback-preview').hidden, false, $('feedback-status').textContent);
    return { payload: JSON.parse($('feedback-preview').textContent), status: $('feedback-status').textContent };
  } finally {
    global.fetch = originalFetch;
  }
}

const jobSection = text => (text.match(/\[岗位\][\s\S]*?(?=\n\n|$)/) || [''])[0];

test('a saved job flow puts closed [岗位] codes into the manual-feedback preview, and nothing of the job itself', async () => {
  const panel = await openPanel({ extraction: BEISEN_JOB, feedback: true });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  panel.page.ai.answer({ status: 'ok', reason: 'ok', reliable: true, fields: { company: '金发科技股份有限公司', title: '研发工程师-化工工艺研究方向' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.title.value, '研发工程师-化工工艺研究方向');
  await panel.submit();
  assert.equal(panel.saves().length, 1);

  const { payload, status } = await preview(panel);
  assert.equal(status, '请核对预览，确认后发送。');
  assert.equal(jobSection(payload.user_description), block([
    'job_company_source: site_rule', 'job_title_source: ai', 'job_missing: none',
    'job_ai_called: true', 'job_ai_code: ok', 'job_end: saved'
  ]));
  assert.match(payload.user_description, /^install: normal$/m);
  for (const text of JOB_TEXT) assert.ok(!JSON.stringify(payload).includes(text), text);
});

test('a cancelled job flow is recorded as cancelled, with the cancelled recognition and the field still missing', async () => {
  const panel = await openPanel({ extraction: BEISEN_JOB, feedback: true });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  await panel.click('job-save-stop');
  assert.equal(panel.form.hidden, false);
  // A late answer to the cancelled recognition changes nothing.
  panel.page.ai.answer({ status: 'ok', reason: 'ok', reliable: true, fields: { company: '晚到的公司', title: '晚到的岗位' } });
  await clicking;
  await panel.click('job-save-cancel');
  assert.equal(panel.saves().length, 0);

  const { payload } = await preview(panel);
  assert.equal(jobSection(payload.user_description), block([
    'job_company_source: site_rule', 'job_title_source: none', 'job_missing: title',
    'job_ai_called: true', 'job_ai_code: cancelled', 'job_end: cancelled'
  ]));
  for (const text of [...JOB_TEXT, '晚到']) assert.ok(!JSON.stringify(payload).includes(text), text);
});

test('without a job flow in this tab the preview has no [岗位]', async () => {
  const panel = await openPanel({ feedback: true });
  const { payload, status } = await preview(panel);
  assert.doesNotMatch(payload.user_description, /岗位\]|job_/);
  assert.equal(status, '未附上填写诊断。请核对预览，确认后发送。');
});

test('the page keeps how the flow ended: still open, navigated away, a write that failed, and AI failure codes', async () => {
  const report = async page => (await page.deliver({ type: 'RESUME_PANEL_STATUS' })).diagnosticsReport;

  const open = await openPanel({ extraction: POSTING_JOB, feedback: true });
  await open.click('job-save-button');
  assert.equal(await report(open.page), block([
    'job_company_source: structured', 'job_title_source: structured', 'job_missing: none',
    'job_ai_called: false', 'job_ai_code: -', 'job_end: open'
  ]));
  // 确定保存 with the title emptied is refused; the user leaves it missing.
  const { draftId } = JSON.parse(JSON.stringify(open.page.hooks.panelJobSnapshot()));
  const refusedEmpty = await open.page.deliver({ type: 'RESUME_PANEL_SAVE_CONFIRM', draftId, company: '星河科技', title: '' });
  assert.equal(refusedEmpty.ok, false);
  assert.match(await report(open.page), /^job_missing: title$/m);
  // A single-page site swaps the job under the open draft.
  open.page.location.href = 'https://jobs.example.com/999';
  await open.poll();
  assert.match(await report(open.page), /^job_end: navigated$/m);

  const refused = await openPanel({ extraction: POSTING_JOB, feedback: true,
    desktop: message => message.type === 'DESKTOP_SAVE_JOB' ? { status: 'rejected', reason: 'invalid_payload' } : {} });
  await refused.click('job-save-button');
  await refused.submit();
  assert.match(await report(refused.page), /^job_end: failed$/m);

  const offline = await openPanel({ extraction: POSTING_JOB, feedback: true,
    desktop: message => message.type === 'DESKTOP_SAVE_JOB' ? { status: 'queued', mode: 'unavailable', intent: { intentId: 'i-1' } } : {} });
  await offline.click('job-save-button');
  await offline.submit();
  assert.match(await report(offline.page), /^job_end: queued$/m);

  const timedOut = await openPanel({ extraction: BEISEN_JOB, feedback: true });
  const clicking = timedOut.get('job-save-button').listeners.click();
  await settle();
  timedOut.page.ai.answer({ status: 'manual', reason: 'timeout', reliable: false, fields: { company: '', title: '', location: '' } });
  await clicking;
  const text = await report(timedOut.page);
  assert.match(text, /^job_ai_code: timeout$/m);
  assert.match(text, /^job_missing: title$/m);
  assert.match(text, /^job_end: open$/m);
});

test('the [岗位] block keeps closed words only and never reaches an automatic report', async () => {
  for (const companySource of ['structured', 'site_rule', 'page_title', 'ai', 'none']) {
    assert.match(core.jobReport({ companySource }), new RegExp(`^job_company_source: ${companySource}$`, 'm'));
  }
  for (const end of ['open', 'saved', 'queued', 'failed', 'unknown', 'cancelled', 'navigated']) {
    assert.match(core.jobReport({ end }), new RegExp(`^job_end: ${end}$`, 'm'));
  }
  for (const aiCode of ['ok', 'timeout', 'cancelled', 'no_evidence', 'missing_both', 'not_configured', 'http_429', 'internal']) {
    assert.match(core.jobReport({ aiCalled: true, aiCode }), new RegExp(`^job_ai_code: ${aiCode}$`, 'm'));
  }
  // Hostile values: company names, URLs, provider text and anything else fall back to a safe word.
  assert.equal(core.jobReport({ companySource: '金发科技股份有限公司', titleSource: 'https://evil.example/?t=1', missingCompany: 'yes',
    missingTitle: true, aiCalled: true, aiCode: 'upstream said 张三 13800138000', end: 'saved to https://evil.example' }), block([
    'job_company_source: none', 'job_title_source: none', 'job_missing: title',
    'job_ai_called: true', 'job_ai_code: other', 'job_end: open'
  ]));
  assert.equal(core.jobReport(null), '');
  // Forged lines are dropped by the allowlist; without `manual` the whole section goes.
  const forged = block(['job_company_source: 金发科技', 'job_title_source: ai', 'job_ai_code: 你正在投递职位：研发工程师',
    'job_end: https://evil.example', 'job_missing: company,title', 'job_note: 研发工程师']);
  assert.equal(core.diagnostics(forged, { manual: true }), block(['job_title_source: ai', 'job_missing: company,title']));
  assert.equal(core.diagnostics(forged), '');
  assert.equal(core.diagnostics(`[错误]\nerror_category: timeout\n\n${forged}`), '[错误]\nerror_category: timeout');
});
