// #172: "确认已投递" is finished entirely in the native side panel. Clicking it never queries
// the desktop by itself — it first opens the same identification-and-review step "保存岗位到
// 桌面端" uses (local read, AI only when unsure), so the user can fix a wrong company/title
// before anything leaves the page. Only "查找对应申请" queries the desktop, and only with what
// the user confirmed. The user says they already applied on the job site; the plugin only
// moves the chosen application's stage. It never clicks or submits anything on the site, never
// picks an application for the user, and never says "已确认投递" before the desktop persisted it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { read, settle, RELIABLE_JOB, UNRELIABLE_JOB, openPanel } = require('./helpers/sidepanel-harness.js');

const KINGFA = { company: '金发科技', title: '研发工程师', sourceUrl: 'https://jobs.example.com/123', dedupeUrl: 'https://jobs.example.com/123', reliable: true };
const MISREAD = {
  // A noisy page whose local read settles on "公安" — a real string that has shown up in the
  // wild — while the actual employer is "金发科技". The reliability rules (#172 "补充") already
  // keep a bare "公安" from being trusted, so this is exactly the "identified wrong, user fixes
  // it" case the new review step exists for.
  company: '公安', title: '研发工程师', reliable: false, confidence: 'uncertain', assistReasons: ['company_weak_evidence'],
  sourceUrl: 'https://jobs.example.com/456', dedupeUrl: 'https://jobs.example.com/456', fragments: []
};
const NOTHING = {
  company: '', title: '', reliable: false, confidence: 'invalid', assistReasons: ['missing_company', 'missing_title'],
  sourceUrl: 'https://jobs.example.com/789', dedupeUrl: 'https://jobs.example.com/789', fragments: []
};
const APP_A = { applicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', company: '金发科技', title: '研发工程师', stage: 'saved' };
const APP_B = { applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', company: '金发科技', title: '工艺工程师', stage: 'filling' };

const ok = (exact = [], sameCompany = []) => ({ status: 'ok', exact, sameCompany });
// A desktop that knows the two applications and persists a confirmation.
const desktopWith = (candidates, { confirm = () => ({ status: 'saved', messageId: 'm-1' }) } = {}) => (message) => {
  if (message.type === 'DESKTOP_CANDIDATES_FOR') return candidates;
  if (message.type === 'DESKTOP_CONFIRM_SUBMIT') return confirm(message);
  return {};
};

async function openConfirmPanel(options = {}) {
  return openPanel({ extraction: KINGFA, ...options });
}

const button = panel => panel.get('submit-confirm-button');
const visible = (panel, id) => panel.get(id).hidden === false;
const choices = panel => panel.get('submit-confirm-candidates').children || [];
const resultText = panel => panel.get('submit-confirm-result-text').textContent;
const reviewCompany = panel => panel.get('submit-confirm-company');
const reviewTitle = panel => panel.get('submit-confirm-title');

function typeInto(input, value) {
  input.value = value;
  input.listeners.input?.({ target: input });
}

async function submitReview(panel) {
  await panel.get('submit-confirm-form').listeners.submit({ preventDefault() {} });
  await settle();
}

// Opens the panel, waits for the review form (identification is synchronous for a reliable
// or clearly-invalid local read with no fragments), edits company/title when given, and
// submits "查找对应申请".
async function openAndQuery(options, { company, title } = {}) {
  const panel = await openConfirmPanel(options);
  await panel.click('submit-confirm-button');
  assert.equal(visible(panel, 'submit-confirm-form'), true, 'the review form opens first');
  if (company !== undefined) typeInto(reviewCompany(panel), company);
  if (title !== undefined) typeInto(reviewTitle(panel), title);
  await submitReview(panel);
  return panel;
}

async function pick(panel, index) {
  const child = choices(panel)[index];
  await panel.get('submit-confirm-candidates').listeners.click({ target: child });
  await settle();
}
const currentConfirmId = panel => panel.page.deliver({ type: 'RESUME_PANEL_STATUS' }).then(status => status.submitConfirm.confirmId);

// --- the entry ---------------------------------------------------------------------------------

test('"确认已投递" is a visible button in the 填写 view beside the save-job button, not only in the ··· menu', () => {
  const html = read('sidepanel.html');
  const fillView = html.slice(html.indexOf('id="fill-view"'), html.indexOf('id="fields-view"'));
  const menu = html.slice(html.indexOf('class="dock-tools__menu"'), html.indexOf('</details>'));
  assert.match(fillView, /<button[^>]*id="submit-confirm-button"[^>]*>确认已投递<\/button>/);
  const saveAt = fillView.indexOf('id="job-save-button"');
  const submitAt = fillView.indexOf('id="submit-confirm-button"');
  assert.ok(saveAt > 0 && submitAt > saveAt && submitAt - saveAt < 600, 'placed right after the save-job button');
  assert.doesNotMatch(menu, /data-advanced="submit"/);
  assert.doesNotMatch(menu, /data-advanced="save"/);
  assert.doesNotMatch(menu, /确认已投递/);
  // The review form: editable company/title, a read-only URL, "查找对应申请" and "取消".
  assert.match(fillView, /<input id="submit-confirm-company"[^>]*required/);
  assert.match(fillView, /<input id="submit-confirm-title"[^>]*required/);
  assert.match(fillView, /<input id="submit-confirm-url"[^>]*readonly/);
  assert.match(fillView, /id="submit-confirm-query" type="submit">查找对应申请</);
  assert.match(fillView, /id="submit-confirm-review-cancel" type="button">取消</);
});

test('clicking it opens no page overlay: no RESUME_PANEL_ADVANCED, no is-legacy-open, no old UI', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  const classes = new Set();
  let overlayOpened = 0;
  panel.page.hooks.setShadowRoot({
    querySelector(selector) {
      if (selector === '#resume-pro-ai-fill') return { disabled: false, textContent: '一键 AI 填写' };
      if (selector === '.resume-pro') {
        return { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) }, querySelector: () => null };
      }
      if (selector === '#resume-pro-confirm-submit') return { click() { overlayOpened += 1; } };
      return null;
    }
  });
  await panel.click('submit-confirm-button');
  await submitReview(panel);
  await pick(panel, 0);

  assert.equal(panel.pageMessages.some(message => message.type === 'RESUME_PANEL_ADVANCED'), false);
  assert.equal(classes.has('is-legacy-open'), false, 'the old overlay is never opened for this');
  assert.equal(overlayOpened, 0);

  // A stray "submit"/"save" advanced message no longer reaches the overlay either.
  for (const action of ['submit', 'save']) {
    const stray = await panel.page.deliver({ type: 'RESUME_PANEL_ADVANCED', action });
    assert.equal(stray.ok, false, action);
  }
  assert.equal(overlayOpened, 0);
  assert.equal(classes.has('is-legacy-open'), false);
});

// --- step one: identify, then review (never a query yet) ---------------------------------------

test('a reliable local read opens the review form pre-filled, and queries nothing yet', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  assert.equal(panel.get('submit-confirm-progress').hidden, true);
  assert.equal(panel.get('submit-confirm-choice').hidden, true);
  assert.equal(reviewCompany(panel).value, '金发科技');
  assert.equal(reviewTitle(panel).value, '研发工程师');
  assert.equal(panel.candidateQueries().length, 0, 'nothing is queried before "查找对应申请"');
  assert.equal(panel.saves().length, 0);
});

test('the source URL is the page\'s own redacted value; a forged one in the query message is ignored', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  const urlInput = panel.get('submit-confirm-url');
  assert.equal(urlInput.value, 'https://jobs.example.com/123');
  // The static HTML's own `readonly` is covered by the markup test above; the input is never
  // read back regardless — the message sent is built from company/title only, and the page
  // fills in its own sourceUrl. A message that also carries a `sourceUrl` (however it got
  // there) cannot change what is actually sent to the desktop.
  const confirmId = await currentConfirmId(panel);
  const reply = await panel.page.deliver({
    type: 'RESUME_PANEL_SUBMIT_QUERY', confirmId, company: '金发科技', title: '研发工程师', sourceUrl: 'https://evil.example.com/x'
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(panel.candidateQueries().map(m => Object.keys(m.fields).sort()), [['company', 'sourceUrl', 'title']]);
  assert.equal(panel.candidateQueries()[0].fields.sourceUrl, 'https://jobs.example.com/123');
});

test('an uncertain local read ("公安") goes to AI with progress and a cancel button, and only queries after the user reviews', async () => {
  const panel = await openConfirmPanel({ extraction: UNRELIABLE_JOB, desktop: desktopWith(ok([APP_A])) });
  // The click's own promise does not resolve until draftJobFields() has an answer (it awaits
  // the AI fully), so it is fired without awaiting here — exactly like job-save's own AI tests.
  const clicking = panel.get('submit-confirm-button').listeners.click({});
  await settle();
  assert.equal(visible(panel, 'submit-confirm-progress'), true);
  assert.equal(panel.page.ai.sent.length, 1);
  assert.equal(panel.get('submit-confirm-form').hidden, true);
  assert.equal(panel.candidateQueries().length, 0, 'AI runs before any query, never after one');
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '金发科技股份有限公司', title: '研发工程师' } });
  await clicking;
  await settle();
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  assert.equal(reviewCompany(panel).value, '金发科技股份有限公司');
  assert.equal(panel.candidateQueries().length, 0);
});

test('a page with nothing recognizable still opens an editable review (never an empty-candidate query)', async () => {
  const panel = await openConfirmPanel({ extraction: NOTHING, desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  assert.equal(reviewCompany(panel).value, '');
  assert.equal(reviewTitle(panel).value, '');
  assert.match(panel.get('submit-confirm-note').textContent, /核对|补全|手动/);
  assert.equal(panel.candidateQueries().length, 0);
});

// --- editing before the query ("公安" → "金发科技") ----------------------------------------------

test('the user can edit company and title on the review form', async () => {
  const panel = await openConfirmPanel({ extraction: MISREAD, desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  assert.equal(reviewCompany(panel).value, '公安');
  typeInto(reviewCompany(panel), '金发科技');
  assert.equal(reviewCompany(panel).value, '金发科技');
});

test('the query uses the edited company, not the page\'s misread one, and creates nothing', async () => {
  const panel = await openAndQuery({ extraction: MISREAD, desktop: desktopWith(ok([APP_A])) }, { company: '金发科技' });
  assert.equal(panel.candidateQueries().length, 1);
  assert.equal(panel.candidateQueries()[0].fields.company, '金发科技');
  assert.notEqual(panel.candidateQueries()[0].fields.company, '公安');
  assert.equal(panel.saves().length, 0, 'editing company/title never creates a job or an application');
  assert.equal(panel.confirms().length, 0);
  assert.equal(visible(panel, 'submit-confirm-choice'), true);
});

test('querying only ever sends DESKTOP_CANDIDATES_FOR, never DESKTOP_SAVE_JOB', async () => {
  const panel = await openAndQuery({ extraction: MISREAD, desktop: desktopWith(ok([APP_A])) }, { company: '金发科技' });
  const kinds = panel.page.desktopCalls.map(m => m.type).filter(t => t !== 'DESKTOP_LIST_QUEUE');
  assert.deepEqual(kinds, ['DESKTOP_CANDIDATES_FOR']);
});

// --- required fields ----------------------------------------------------------------------------

test('company or title empty: no query is sent and a required-field prompt shows', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  typeInto(reviewCompany(panel), '   ');
  await submitReview(panel);
  assert.equal(panel.candidateQueries().length, 0);
  assert.equal(panel.get('submit-confirm-error').hidden, false);
  assert.equal(panel.get('submit-confirm-error').textContent, '请补全公司名称后再查找。');
  assert.equal(reviewCompany(panel).attributes['aria-invalid'], 'true');
  assert.equal(visible(panel, 'submit-confirm-form'), true, 'stays on the review form');

  await panel.poll();
  assert.equal(panel.get('submit-confirm-error').hidden, false, 'polling keeps the local validation prompt');
});

test('editing a required field clears only that field\'s red border', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  typeInto(reviewCompany(panel), '');
  typeInto(reviewTitle(panel), '');
  await submitReview(panel);
  assert.equal(reviewCompany(panel).attributes['aria-invalid'], 'true');
  assert.equal(reviewTitle(panel).attributes['aria-invalid'], 'true');
  assert.equal(panel.get('submit-confirm-error').textContent, '请补全公司名称和岗位名称后再查找。');

  typeInto(reviewCompany(panel), '金');
  assert.equal(reviewCompany(panel).attributes['aria-invalid'], undefined);
  assert.equal(reviewTitle(panel).attributes['aria-invalid'], 'true');
  assert.equal(panel.get('submit-confirm-error').textContent, '请补全岗位名称后再查找。');

  typeInto(reviewTitle(panel), '研');
  assert.equal(reviewTitle(panel).attributes['aria-invalid'], undefined);
  assert.equal(panel.get('submit-confirm-error').hidden, true);
});

// --- choosing -----------------------------------------------------------------------------------

test('even one candidate needs the user to pick it: nothing is confirmed by itself', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A])) });
  assert.equal(visible(panel, 'submit-confirm-choice'), true);
  assert.equal(choices(panel).length, 1);
  await panel.poll();
  await panel.poll();
  assert.equal(panel.confirms().length, 0, 'the plugin never chooses the application');
  assert.equal(panel.get('submit-confirm-result').hidden, true);
});

test('every candidate shows company, title and stage, and never the application id', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A], [APP_B, { ...APP_A }])) });
  const labels = choices(panel).map(choice => choice.textContent);
  assert.deepEqual(labels, ['金发科技 · 研发工程师（已保存）', '金发科技 · 工艺工程师（填写中）'], 'the same application is not offered twice');
  const shown = [...labels, panel.get('submit-confirm-progress-text').textContent, panel.get('submit-confirm-result-text').textContent].join('\n');
  assert.doesNotMatch(shown, /aaaaaaaa|bbbbbbbb|[0-9a-f]{8}-[0-9a-f]{4}/i);
  const status = await panel.page.deliver({ type: 'RESUME_PANEL_STATUS' });
  assert.deepEqual(status.submitConfirm.candidates.map(item => item.label), labels);
});

test('an application id the desktop did not offer is refused and nothing is sent', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A])) });
  const confirmId = await currentConfirmId(panel);
  for (const forged of ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', '', null, undefined, APP_A.applicationId.toUpperCase(), { applicationId: APP_A.applicationId }]) {
    const reply = await panel.page.deliver({ type: 'RESUME_PANEL_SUBMIT_CHOICE', confirmId, applicationId: forged });
    assert.equal(reply.ok, false, `refused: ${JSON.stringify(forged)}`);
  }
  assert.equal(panel.confirms().length, 0);
  const stale = await panel.page.deliver({ type: 'RESUME_PANEL_SUBMIT_CHOICE', confirmId: 'other', applicationId: APP_A.applicationId });
  assert.equal(stale.ok, false);
  assert.equal(panel.confirms().length, 0);
});

test('choosing an application sends one confirmation and only a persisted reply says 已确认投递', async () => {
  let release;
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A], [APP_B]), { confirm: () => new Promise(resolve => { release = () => resolve({ status: 'saved', messageId: 'm-1' }); }) }) });
  const picking = pick(panel, 0);
  await settle();
  await settle();
  assert.equal(panel.get('submit-confirm-progress-text').textContent, '正在确认投递……');
  assert.equal(panel.confirms().length, 1);
  assert.equal(panel.get('submit-confirm-result').hidden, true, 'nothing is claimed while the desktop has not answered');
  assert.equal(panel.get('submit-confirm-stop').hidden, true, 'a confirmation on its way cannot be recalled');
  release();
  await picking;
  await settle();

  assert.deepEqual(panel.confirms().map(message => message.applicationId), [APP_A.applicationId]);
  assert.equal(visible(panel, 'submit-confirm-result'), true);
  assert.equal(resultText(panel), '已确认投递：金发科技 · 研发工程师');
  assert.match(panel.get('submit-confirm-result-hint').textContent, /没有提交招聘网站/);
  assert.equal(panel.get('submit-confirm-choice').hidden, true);
  await panel.poll();
  assert.equal(panel.confirms().length, 1);
  assert.equal(resultText(panel), '已确认投递：金发科技 · 研发工程师');
  await panel.click('submit-confirm-dismiss');
  assert.equal(panel.get('submit-confirm-result').hidden, true);
  assert.equal(button(panel).hidden, false);
});

test('a double click on a candidate sends the confirmation once', async () => {
  let release;
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A]), { confirm: () => new Promise(resolve => { release = () => resolve({ status: 'saved' }); }) }) });
  const child = choices(panel)[0];
  const list = panel.get('submit-confirm-candidates');
  const first = list.listeners.click({ target: child });
  const second = list.listeners.click({ target: child });
  await settle();
  release();
  await Promise.all([first, second]);
  await settle();
  assert.equal(panel.confirms().length, 1);
  const confirmId = await currentConfirmId(panel);
  const again = await panel.page.deliver({ type: 'RESUME_PANEL_SUBMIT_CHOICE', confirmId, applicationId: APP_A.applicationId });
  assert.equal(again.ok, false);
  assert.equal(panel.confirms().length, 1);
});

test('a double click on "查找对应申请" queries once', async () => {
  let release;
  const panel = await openConfirmPanel({
    desktop: (message) => message.type === 'DESKTOP_CANDIDATES_FOR' ? new Promise(resolve => { release = () => resolve(ok([APP_A])); }) : {}
  });
  await panel.click('submit-confirm-button');
  const form = panel.get('submit-confirm-form');
  const first = form.listeners.submit({ preventDefault() {} });
  const second = form.listeners.submit({ preventDefault() {} });
  await settle();
  await settle();
  assert.equal(panel.candidateQueries().length, 1);
  release();
  await Promise.all([first, second]);
  await settle();
  assert.equal(panel.candidateQueries().length, 1);
});

test('cancelling from the review form before querying changes nothing and creates nothing', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A, APP_B])) });
  await panel.click('submit-confirm-button');
  await panel.click('submit-confirm-review-cancel');
  assert.equal(panel.get('submit-confirm-form').hidden, true);
  assert.equal(panel.get('submit-confirm-choice').hidden, true);
  assert.equal(panel.get('submit-confirm-result').hidden, true);
  assert.equal(button(panel).hidden, false);
  assert.equal(panel.candidateQueries().length, 0);
  assert.equal(panel.confirms().length, 0);
  assert.equal(panel.saves().length, 0);
  assert.equal(panel.pageMessages.some(message => message.type === 'RESUME_PANEL_ADVANCED'), false);
});

test('cancelling after candidates appear changes nothing on the desktop and opens nothing else', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A, APP_B])) });
  await panel.click('submit-confirm-cancel');
  assert.equal(panel.get('submit-confirm-choice').hidden, true);
  assert.equal(panel.get('submit-confirm-result').hidden, true);
  assert.equal(button(panel).hidden, false);
  assert.equal(panel.confirms().length, 0);
  assert.equal(panel.saves().length, 0);
  assert.equal(panel.page.desktopCalls.some(message => /^DESKTOP_(SAVE_JOB|BIND|CONTINUE_SAVE)$/.test(message.type)), false);
  assert.match(panel.toast(), /桌面上没有任何变化/);
  const late = await panel.page.deliver({ type: 'RESUME_PANEL_SUBMIT_CHOICE', confirmId: 'x', applicationId: APP_A.applicationId });
  assert.equal(late.ok, false);
  assert.equal(panel.confirms().length, 0);
});

// --- "返回修改" -----------------------------------------------------------------------------------

test('"返回修改" from the candidate list reopens the review form with what was queried, and queries nothing new by itself', async () => {
  const panel = await openAndQuery({ extraction: MISREAD, desktop: desktopWith(ok([APP_A])) }, { company: '金发科技' });
  assert.equal(visible(panel, 'submit-confirm-choice'), true);
  await panel.click('submit-confirm-back');
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  assert.equal(reviewCompany(panel).value, '金发科技');
  assert.equal(panel.get('submit-confirm-choice').hidden, true);
  assert.equal(panel.candidateQueries().length, 1, 'going back does not re-query');
  // Editing again and re-querying works normally.
  typeInto(reviewTitle(panel), '工艺工程师');
  await submitReview(panel);
  assert.equal(panel.candidateQueries().length, 2);
  assert.equal(panel.candidateQueries()[1].fields.title, '工艺工程师');
});

test('"返回修改" from a no-candidate or blocked result also reopens the review form', async () => {
  const empty = await openAndQuery({ desktop: desktopWith(ok()) });
  await empty.click('submit-confirm-result-back');
  assert.equal(visible(empty, 'submit-confirm-form'), true);
  assert.equal(empty.get('submit-confirm-result').hidden, true);

  const blocked = await openAndQuery({ desktop: desktopWith({ status: 'not_installed' }) });
  await blocked.click('submit-confirm-result-back');
  assert.equal(visible(blocked, 'submit-confirm-form'), true);
});

// --- nothing to choose --------------------------------------------------------------------------

test('no candidate: says so, offers to save the job, return to edit, and to cancel — creates nothing', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok()) });
  assert.equal(visible(panel, 'submit-confirm-result'), true);
  assert.equal(resultText(panel), '桌面里还没有这家公司的投递记录。');
  assert.equal(panel.get('submit-confirm-save').hidden, false);
  assert.equal(panel.get('submit-confirm-result-back').hidden, false);
  assert.equal(panel.get('submit-confirm-dismiss').textContent, '取消');
  assert.equal(panel.get('submit-confirm-choice').hidden, true, 'no empty candidate list');
  assert.equal(panel.saves().length, 0);
  assert.equal(panel.confirms().length, 0);

  await panel.click('submit-confirm-dismiss');
  assert.equal(panel.get('submit-confirm-result').hidden, true);
  assert.equal(panel.saves().length + panel.confirms().length, 0);
});

test('no candidate → save the job in the panel → then the application still has to be chosen and confirmed', async () => {
  let saved = false;
  const panel = await openConfirmPanel({
    desktop: (message) => {
      if (message.type === 'DESKTOP_CANDIDATES_FOR') return saved ? ok([{ ...APP_A }]) : ok();
      if (message.type === 'DESKTOP_SAVE_JOB') { saved = true; return { status: 'saved' }; }
      if (message.type === 'DESKTOP_CONFIRM_SUBMIT') return { status: 'saved', messageId: 'm-2' };
      return {};
    }
  });
  await panel.click('submit-confirm-button');
  await submitReview(panel);
  await panel.click('submit-confirm-save');

  // The job-save review of #175: company, title and address are checked before anything is written.
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.company.value, '金发科技');
  assert.equal(panel.title.value, '研发工程师');
  assert.equal(panel.get('submit-confirm-result').hidden, true);
  assert.equal(panel.saves().length, 0, 'saving waits for 确定保存');
  assert.equal(panel.confirms().length, 0);
  assert.equal(panel.pageMessages.some(message => message.type === 'RESUME_PANEL_ADVANCED'), false);

  await panel.submit();
  assert.equal(panel.saves().length, 1);
  assert.match(panel.get('job-save-result-text').textContent, /桌面已保存/);
  assert.equal(panel.confirms().length, 0, 'saving a job is not confirming a submission');

  await panel.click('job-save-dismiss');
  await panel.click('submit-confirm-button');
  await submitReview(panel);
  assert.equal(choices(panel).length, 1);
  assert.equal(panel.confirms().length, 0, 'the application is still chosen by the user');
  await pick(panel, 0);
  assert.equal(panel.confirms().length, 1);
  assert.equal(resultText(panel), '已确认投递：金发科技 · 研发工程师');
});

test('a page whose company cannot be told still opens the (blank) review, and the desktop is never asked', async () => {
  const panel = await openConfirmPanel({ extraction: NOTHING, desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  assert.equal(panel.get('submit-confirm-choice').hidden, true);
  assert.equal(choices(panel).length, 0);
  assert.equal(panel.candidateQueries().length, 0, 'the desktop is not asked about an unknown company');
  assert.equal(panel.confirms().length, 0);
});

// --- the desktop cannot be reached (only reachable once a query is actually sent) ---------------

test('each way the desktop can be missing has its own wording and none of them claims a queue', async () => {
  const cases = [
    ['not_installed', /没有找到桌面程序，这次没有确认投递/],
    ['not_paired', /还没有配对这个插件，这次没有确认投递/],
    ['never_paired', /还没有和桌面程序配对过，这次没有确认投递/],
    ['incompatible', /版本和插件对不上，这次没有确认投递/],
    ['unavailable', /桌面暂时连不上，这次没有确认投递/],
    ['retryable', /桌面暂时连不上，这次没有确认投递/]
  ];
  for (const [status, pattern] of cases) {
    const panel = await openAndQuery({ desktop: desktopWith({ status }) });
    assert.match(resultText(panel), pattern, status);
    assert.doesNotMatch(resultText(panel), /已排进|已记为待同步|已经进入/, status);
    assert.equal(panel.get('submit-confirm-choice').hidden, true, `${status}: no empty candidate list`);
    assert.equal(panel.confirms().length, 0, status);
    if (status === 'not_paired' || status === 'never_paired') assert.equal(panel.get('submit-confirm-copy-id').hidden, false, status);
  }
});

test('a desktop that never answers the lookup is "not confirmed", never an empty candidate list', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(new Promise(() => {})) });
  panel.page.hooks.setPanelJobWriteTimeoutMs(10);
  await panel.click('submit-confirm-button');
  await submitReview(panel);
  await new Promise(resolve => setTimeout(resolve, 40));
  await panel.poll();
  assert.match(resultText(panel), /这次没有确认投递/);
  assert.notEqual(resultText(panel), '桌面里还没有这家公司的投递记录。');
  assert.equal(panel.confirms().length, 0);
});

test('a confirmation the desktop only queued is said to be queued, not confirmed', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A]), { confirm: () => ({ status: 'pending', messageId: 'm-9' }) }) });
  await pick(panel, 0);
  assert.match(resultText(panel), /已排进待同步队列/);
  assert.doesNotMatch(resultText(panel), /已确认投递/);
});

test('a confirmation that could not even be queued is not called queued or confirmed', async () => {
  for (const reply of [
    { status: 'pending', mode: 'unavailable' },
    { status: 'pending', mode: 'not_installed' },
    { status: 'failed', code: 'previously_purged' },
    { status: 'rejected', reason: 'queue_full' }
  ]) {
    const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A]), { confirm: () => reply }) });
    await pick(panel, 0);
    assert.doesNotMatch(resultText(panel), /已确认投递|已排进待同步队列/, JSON.stringify(reply));
    assert.equal(panel.confirms().length, 1, 'no automatic resend');
  }
});

test('no reply to the confirmation is "unknown": not success, and it is not sent a second time', async () => {
  for (const confirm of [() => new Promise(() => {}), () => { throw new Error('port closed'); }, () => undefined]) {
    const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A]), { confirm }) });
    panel.page.hooks.setPanelJobWriteTimeoutMs(10);
    await pick(panel, 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    await panel.poll();
    assert.equal(resultText(panel), '没能确认结果，请到桌面端查看这条申请的当前状态。');
    assert.doesNotMatch(resultText(panel), /已确认投递/);
    assert.equal(panel.get('submit-confirm-result').className.includes('is-success'), false);
    await panel.poll();
    assert.equal(panel.confirms().length, 1);
  }
});

// --- pages, tabs and late answers ----------------------------------------------------------------

test('when the page changes mid-review, the draft is dropped and cannot be queried', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  await panel.click('submit-confirm-button');
  const confirmId = await currentConfirmId(panel);
  panel.page.location.href = 'https://jobs.example.com/999';
  await panel.poll();
  assert.equal(panel.get('submit-confirm-form').hidden, true, 'the old draft is gone');
  const reply = await panel.page.deliver({ type: 'RESUME_PANEL_SUBMIT_QUERY', confirmId, company: '金发科技', title: '研发工程师' });
  assert.equal(reply.ok, false);
  assert.equal(panel.candidateQueries().length, 0);
  assert.match(panel.toast(), /作废/);
});

test('when the page changes after candidates were offered, they are dropped and cannot be confirmed', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A])) });
  const confirmId = await currentConfirmId(panel);
  assert.equal(choices(panel).length, 1);

  panel.page.location.href = 'https://jobs.example.com/999';
  await panel.poll();
  assert.equal(panel.get('submit-confirm-choice').hidden, true, 'the old candidates are gone');
  const reply = await panel.page.deliver({ type: 'RESUME_PANEL_SUBMIT_CHOICE', confirmId, applicationId: APP_A.applicationId });
  assert.equal(reply.ok, false);
  assert.equal(panel.confirms().length, 0);
  assert.match(panel.toast(), /作废/);

  const other = await panel.addPage(9);
  panel.setTab(9);
  await panel.poll();
  assert.equal(panel.get('submit-confirm-choice').hidden, true);
  assert.equal(panel.get('submit-confirm-result').hidden, true);
  assert.equal(other.desktopCalls.filter(message => message.type === 'DESKTOP_CONFIRM_SUBMIT').length, 0);
});

test('a lookup that finishes on tab A after switching to tab B never draws on B', async () => {
  let release;
  const panel = await openConfirmPanel({
    desktop: (message) => message.type === 'DESKTOP_CANDIDATES_FOR' ? new Promise(resolve => { release = () => resolve(ok([APP_A])); }) : {}
  });
  await panel.addPage(9);
  await panel.click('submit-confirm-button');
  const querying = panel.get('submit-confirm-form').listeners.submit({ preventDefault() {} });
  await settle();
  panel.setTab(9);
  await panel.poll();
  release();
  await querying;
  await settle();
  await panel.poll();
  assert.equal(panel.get('submit-confirm-choice').hidden, true, 'tab 9 has no question of its own');
  assert.equal(panel.get('submit-confirm-progress').hidden, true);
  assert.equal(button(panel).disabled, false, "tab 9's button is free at once");
  assert.equal(panel.confirms().length, 0);
});

test('cancelling while the desktop is asked returns to the review form at once, and candidates that arrive late are ignored', async () => {
  let release;
  const panel = await openConfirmPanel({
    desktop: (message) => message.type === 'DESKTOP_CANDIDATES_FOR' ? new Promise(resolve => { release = () => resolve(ok([APP_A, APP_B])); }) : {}
  });
  await panel.click('submit-confirm-button');
  const querying = panel.get('submit-confirm-form').listeners.submit({ preventDefault() {} });
  await settle();
  await settle();
  assert.equal(visible(panel, 'submit-confirm-progress'), true);
  await panel.click('submit-confirm-stop');
  assert.equal(panel.get('submit-confirm-progress').hidden, true);
  // Cancelling a query goes back to the (still open) review, not all the way to idle — the
  // entry button stays out of the way, but the fields are editable again at once.
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  assert.equal(reviewCompany(panel).disabled, false, 'the panel is usable again before the desktop answers');

  release();
  await querying;
  await settle();
  await panel.poll();
  assert.equal(panel.get('submit-confirm-choice').hidden, true, 'a late answer does not reopen the list');
  assert.equal(choices(panel).length, 0);
  assert.equal(panel.confirms().length, 0);
  assert.equal(visible(panel, 'submit-confirm-form'), true, 'the late answer does not replace the review either');

  // Querying again from here works normally.
  const requerying = panel.get('submit-confirm-form').listeners.submit({ preventDefault() {} });
  await settle();
  release();
  await requerying;
  await settle();
  assert.equal(visible(panel, 'submit-confirm-choice'), true);
});

test('cancelling identification (during "assist") returns to the review form with what the user had, and sends no query', async () => {
  const panel = await openConfirmPanel({ extraction: UNRELIABLE_JOB, desktop: desktopWith(ok([APP_A])) });
  // The click's own promise does not resolve until draftJobFields() has an answer, so it is
  // fired without awaiting; "取消识别" (interrupt: true) has to get through while it is still
  // pending, and does — going through the panel itself, exactly like clicking it for real.
  const clicking = panel.get('submit-confirm-button').listeners.click({});
  await settle();
  assert.equal(visible(panel, 'submit-confirm-progress'), true);
  await panel.click('submit-confirm-stop');
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  assert.equal(reviewCompany(panel).value, '金发科技股份有限公司');
  assert.equal(panel.page.ai.cancelled.length, 1);
  assert.equal(panel.candidateQueries().length, 0);
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '晚到的公司', title: '晚到的岗位' } });
  await clicking.catch(() => {});
  await settle();
  assert.equal(reviewCompany(panel).value, '金发科技股份有限公司', 'the late AI answer does not reopen or overwrite the review');
});

test('a status poll that left before a click cannot clear the question the click opened', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  const release = panel.holdNextStatus(7);
  const polling = panel.poll();
  await settle();
  await panel.click('submit-confirm-button');
  assert.equal(visible(panel, 'submit-confirm-form'), true);
  release();
  await polling;
  await settle();
  assert.equal(visible(panel, 'submit-confirm-form'), true, "the older, empty snapshot did not win");
  assert.equal(reviewCompany(panel).value, '金发科技');
});

test('an old finished result does not overwrite a newer question', async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A])) });
  await pick(panel, 0);
  assert.equal(resultText(panel), '已确认投递：金发科技 · 研发工程师');
  await panel.click('submit-confirm-button');
  assert.equal(visible(panel, 'submit-confirm-form'), true, 'a new question replaces the old result');
  assert.equal(panel.get('submit-confirm-result').hidden, true);
  await panel.poll();
  assert.equal(visible(panel, 'submit-confirm-form'), true);
});

test('the two questions are never open together: a save review hides 确认已投递 and back', async () => {
  const panel = await openConfirmPanel({ desktop: desktopWith(ok([APP_A])) });
  await panel.click('job-save-button');
  assert.equal(button(panel).hidden, true);
  await panel.click('job-save-cancel');
  assert.equal(button(panel).hidden, false);
  await panel.click('submit-confirm-button');
  assert.equal(panel.button.hidden, true, 'the save-job button waits while the review/choice is open');
  await panel.click('submit-confirm-review-cancel');
  assert.equal(panel.button.hidden, false);
});

test('the submit-confirm button stays hidden while any of its own result cards are shown', async () => {
  for (const [desktop, pickIt] of [
    [desktopWith(ok([APP_A])), true],
    [desktopWith(ok()), false],
    [desktopWith({ status: 'not_installed' }), false]
  ]) {
    const panel = await openAndQuery({ desktop });
    if (pickIt) await pick(panel, 0);
    assert.equal(button(panel).hidden, true, JSON.stringify(desktop));
  }
});

test('a page that is not connected turns the button off', async () => {
  const panel = await openConfirmPanel();
  panel.setTab(42);
  await panel.poll();
  assert.equal(button(panel).disabled, true);
  assert.match(button(panel).title, /无法确认投递/);
});

// --- the plugin never touches the job site ---------------------------------------------------------

test('the confirmation path never clicks, submits or interferes with the job site', () => {
  const content = read('content.js');
  const from = content.indexOf('// --- Confirming a submission from the native side panel');
  const section = content.slice(from, content.indexOf('function setDesktopStatus(', from));
  assert.ok(section.length > 1000);
  const code = section.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.click\(|\.submit\(|requestSubmit|dispatchEvent|preventDefault|stopPropagation|stopImmediatePropagation|addEventListener|chrome\.storage|querySelector/);
  assert.match(section, /DESKTOP_CANDIDATES_FOR/);
  assert.match(section, /DESKTOP_CONFIRM_SUBMIT/);

  const panel = read('sidepanel.js');
  const panelFrom = panel.indexOf('// --- 确认已投递');
  const panelSection = panel.slice(panelFrom, panel.indexOf('elements.jobStop.addEventListener', panelFrom)).replace(/\/\/.*$/gm, '');
  assert.ok(panelSection.length > 500);
  assert.doesNotMatch(panelSection, /RESUME_PANEL_ADVANCED|stopPropagation|stopImmediatePropagation/);
  // The one preventDefault in this section is the panel's own review form (never reaching the
  // job site — sidepanel.js has no access to it at all, only messages to content.js).
  const preventDefaults = panelSection.match(/preventDefault/g) || [];
  assert.equal(preventDefaults.length, 1, "preventDefault appears exactly once: the panel's own review form");
  assert.match(panelSection, /submitForm\.addEventListener\("submit", async \(event\) => \{\s*event\.preventDefault\(\);/);
});

test("the site's own events are left alone: a confirmation registers no listener and stops no event", async () => {
  const panel = await openAndQuery({ desktop: desktopWith(ok([APP_A])) });
  await pick(panel, 0);
  const calls = panel.page.desktopCalls.map(message => message.type);
  assert.deepEqual(calls.filter(type => type !== 'DESKTOP_LIST_QUEUE'), ['DESKTOP_CANDIDATES_FOR', 'DESKTOP_CONFIRM_SUBMIT']);
});

// --- rendering is escaped ---------------------------------------------------------------------------

test('a candidate whose id or label carries HTML characters cannot leave its attribute or element', async () => {
  const nasty = { applicationId: 'x" onmouseover="alert(1)" data-x=\'<b>&', company: '<img src=x onerror=alert(1)>', title: 'A & B "C" \'D\'', stage: '<i>' };
  const panel = await openAndQuery({ desktop: desktopWith(ok([nasty])) });
  const html = panel.get('submit-confirm-candidates').innerHTML;
  assert.doesNotMatch(html, /<img|<b>|<i>|onmouseover="alert/, 'no raw markup or extra attribute survives');
  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) assert.ok(html.includes(entity), `${entity} is used`);
  assert.equal(choices(panel).length, 1, 'one button, not several');
  assert.equal(html.includes('data-application-id="'), true);
  const confirmId = await currentConfirmId(panel);
  const forged = await panel.page.deliver({ type: 'RESUME_PANEL_SUBMIT_CHOICE', confirmId, applicationId: 'x' });
  assert.equal(forged.ok, false);
  assert.equal(panel.confirms().length, 0);
});

test('job-save fragments and candidates are escaped for & < > " \' as well', async () => {
  const fragments = [
    { id: 1, source: 'beisen-company', role: 'company', text: 'A&B <script>x</script> "q" \'s\'' },
    { id: 2, source: 'beisen-apply-title', role: 'job-title', text: '研发工程师' }
  ];
  const panel = await openPanel({
    extraction: { company: '', title: '', location: '', reliable: false, assistReasons: ['missing_company'], sourceUrl: 'https://jobs.example.com/1', dedupeUrl: 'https://jobs.example.com/1', fragments },
    desktop: () => ({ status: 'saved' })
  });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  const html = panel.get('job-save-fragments').innerHTML;
  panel.page.ai.answer({ status: 'manual', reason: 'cancelled', reliable: false, fields: {} });
  await clicking;
  assert.ok(html.length > 0);
  assert.doesNotMatch(html, /<script|<\/script/);
  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) assert.ok(html.includes(entity), `${entity} is used in the fragments`);
});

test('the shared escape function turns all five characters into entities', () => {
  const source = read('sidepanel.js');
  // The line end after the terminating `;` is what bounds this match: escapeHtml's own
  // replacements are HTML entities like "&amp;" and "&quot;", which end in `;` themselves,
  // so `;` alone would stop the match mid-string. `\r?\n` also survives a Windows checkout,
  // where this file is normalized to CRLF.
  const match = source.match(/const escapeHtml = \(value\) => [\s\S]*?;\r?\n/);
  assert.ok(match, 'escapeHtml is defined once in the panel');
  const escapeHtml = new Function(`${match[0]}; return escapeHtml;`)();
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
});

test('the linked user guide distinguishes unpaired, pending and unknown save results', () => {
  assert.match(read('README.md'), /docs\/user-guide\.md/);
  const readme = read('docs/user-guide.md');
  assert.doesNotMatch(readme, /保存岗位和确认投递会留在待同步队列里/);
  assert.match(readme, /未安装或未配对：这次没有保存岗位，也不进入待同步/);
  assert.match(readme, /没有回包（结果未知）：让你到桌面或待同步列表核对，不声称已保存、已排队或已确认/);
  assert.doesNotMatch(readme, /「更多工具」里的「确认已投递」/);
});

test('no candidate → "保存岗位到桌面端" opens the save form with what the user corrected, not a fresh page read', async () => {
  const panel = await openAndQuery({ extraction: MISREAD, desktop: desktopWith(ok()) }, { company: '金发科技' });
  assert.equal(resultText(panel), '桌面里还没有这家公司的投递记录。');
  const aiBefore = panel.page.ai.sent.length;
  await panel.click('submit-confirm-save');
  // The page still says "公安"; the form keeps the user's "金发科技" and does not ask the AI again.
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.company.value, '金发科技');
  assert.equal(panel.title.value, '研发工程师');
  assert.equal(panel.url.value, 'https://jobs.example.com/456');
  assert.equal(panel.page.ai.sent.length, aiBefore);
  assert.equal(panel.saves().length, 0, 'still nothing written before 确定保存');
  await panel.submit();
  assert.equal(panel.saves().length, 1);
  assert.equal(panel.saves()[0].fields.company, '金发科技');
  assert.equal(panel.saves()[0].fields.dedupeUrl, 'https://jobs.example.com/456', 'URLs still come from the page draft');
});
