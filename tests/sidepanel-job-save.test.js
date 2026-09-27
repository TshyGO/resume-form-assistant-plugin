// #172: "保存岗位到桌面端" lives on the native side panel's 填写 view, and the whole review
// happens there. These tests run the real sidepanel.js against the real content.js message
// listener, so the panel's clicks travel the same path they do in Chrome and Edge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  read, tick, settle, USER_AGENTS, RELIABLE_JOB, UNRELIABLE_JOB, loadPage, element, openPanel
} = require('./helpers/sidepanel-harness.js');

test('the 填写 view shows the save-job button itself, not only inside the ··· menu', () => {
  const html = read('sidepanel.html');
  const fillView = html.slice(html.indexOf('id="fill-view"'), html.indexOf('id="fields-view"'));
  const menu = html.slice(html.indexOf('class="dock-tools__menu"'), html.indexOf('</details>'));
  assert.match(fillView, /<button[^>]*id="job-save-button"[^>]*>保存岗位到桌面端<\/button>/);
  assert.doesNotMatch(menu, /保存岗位到桌面端/, 'the ··· menu no longer hides the entry');
  assert.doesNotMatch(menu, /data-advanced="save"/);
  // The review form: editable company, title and location, a read-only URL, confirm and cancel.
  assert.match(fillView, /<input id="job-save-company"[^>]*required/);
  assert.match(fillView, /<input id="job-save-title"[^>]*required/);
  assert.match(fillView, /<input id="job-save-location"/);
  assert.match(fillView, /<input id="job-save-url"[^>]*readonly/);
  assert.match(fillView, /id="job-save-confirm" type="submit">确定保存</);
  assert.match(fillView, /id="job-save-cancel" type="button">取消</);
});

test('clicking the button shows company, title and redacted URL in the panel, and saves only on confirm', async () => {
  const panel = await openPanel();
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.button.disabled, false);
  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.button.hidden, true);
  assert.equal(panel.company.value, '星河科技');
  assert.equal(panel.title.value, '后端开发工程师');
  assert.equal(panel.location.value, '');
  assert.equal(panel.url.value, 'https://jobs.example.com/123', 'the URL is the redacted one, not the address bar');
  assert.equal(panel.saves().length, 0, 'nothing is written before confirming');
  assert.equal(panel.pageMessages.some(message => message.type === 'RESUME_PANEL_ADVANCED'), false, 'the old page overlay is not used');

  // The user corrects the title; a status poll meanwhile must not undo the edit.
  panel.title.value = 'Java 后端开发工程师';
  panel.location.value = '杭州';
  await panel.poll();
  assert.equal(panel.title.value, 'Java 后端开发工程师');
  // The URL field is read-only and is never read back: changing it does nothing.
  panel.url.value = 'https://jobs.example.com/123?token=secret';

  await panel.submit();
  assert.equal(panel.saves().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.saves()[0].fields)), {
    company: '星河科技', title: 'Java 后端开发工程师', location: '杭州',
    sourceUrl: 'https://jobs.example.com/123', dedupeUrl: 'https://jobs.example.com/123'
  });
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.get('job-save-result').hidden, false);
  assert.match(panel.get('job-save-result-text').textContent, /桌面已保存/);
  assert.equal(panel.page.storageWrites.length, 0, 'the draft never reaches extension storage');

  await panel.click('job-save-dismiss');
  assert.equal(panel.get('job-save-result').hidden, true);
  assert.equal(panel.button.hidden, false);
});

test('cancel in the panel saves nothing', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  await panel.click('job-save-cancel');
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.saves().length, 0);
  assert.equal(panel.page.desktopCalls.some(message => /^DESKTOP_(SAVE_JOB|BIND)$/.test(message.type)), false);
});

test('an empty company or title is refused in the panel with a clear prompt', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  panel.company.value = '   ';
  await panel.submit();
  assert.equal(panel.saves().length, 0);
  assert.equal(panel.get('job-save-error').hidden, false);
  assert.equal(panel.get('job-save-error').textContent, '请补全公司名称后再保存。');
  assert.equal(panel.company.attributes['aria-invalid'], 'true');
  assert.equal(panel.company.focused, true);
  assert.equal(panel.form.hidden, false);

  await panel.poll();
  assert.equal(panel.get('job-save-error').hidden, false, 'status polling keeps the local validation prompt');
  assert.equal(panel.get('job-save-error').textContent, '请补全公司名称后再保存。');

  panel.company.value = '星河科技';
  panel.company.listeners.input({ target: panel.company });
  assert.equal(panel.get('job-save-error').hidden, true, 'editing the required field clears the local prompt');
});

test('a double click on confirm saves once', async () => {
  let release;
  const panel = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? new Promise(resolve => { release = () => resolve({ status: 'saved' }); }) : {} });
  await panel.click('job-save-button');
  const submit = panel.get('job-save-form').listeners.submit;
  const first = submit({ preventDefault() {} });
  await tick();
  assert.equal(panel.get('job-save-confirm').disabled, true);
  assert.equal(panel.get('job-save-confirm').textContent, '正在保存…');
  await submit({ preventDefault() {} });
  await panel.poll();
  await submit({ preventDefault() {} });
  release();
  await first;
  await settle();
  assert.equal(panel.saves().length, 1);
});

test('AI recognition shows progress and a cancel button in the panel; a late answer is ignored', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  assert.equal(panel.get('job-save-progress').hidden, false);
  assert.equal(panel.get('job-save-progress-text').textContent, '正在识别岗位…');
  assert.match(panel.get('job-save-progress-count').textContent, /发送 2 段页面文字/);
  assert.match(panel.get('job-save-fragments').innerHTML, /研发工程师-化工工艺研究方向/);
  assert.equal(panel.get('job-save-stop').textContent, '取消识别');
  assert.equal(panel.form.hidden, true);

  await panel.click('job-save-stop');
  assert.equal(panel.page.ai.cancelled.length, 1);
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.form.hidden, false, 'the user can finish by hand');
  assert.equal(panel.company.value, '金发科技股份有限公司');
  assert.equal(panel.title.value, '');

  panel.title.value = '工艺工程师';
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: 'wrong', title: 'wrong' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.company.value, '金发科技股份有限公司', 'a late AI answer does not refill the form');
  assert.equal(panel.title.value, '工艺工程师');
  assert.equal(panel.saves().length, 0);
});

test('cancelling the whole save during recognition keeps the form closed when the AI answers late', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  const draftId = JSON.parse(JSON.stringify(panel.page.hooks.panelJobSnapshot())).draftId;
  await panel.page.deliver({ type: 'RESUME_PANEL_SAVE_CANCEL', draftId, scope: 'draft' });
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '金发科技股份有限公司', title: '研发工程师' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.saves().length, 0);
});

test('an offline desktop is shown as pending sync in the panel, not as saved', async () => {
  const panel = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? { status: 'queued', mode: 'unavailable', intent: { intentId: 'i-1' } } : {} });
  await panel.click('job-save-button');
  await panel.submit();
  const text = panel.get('job-save-result-text').textContent;
  assert.match(text, /待同步/);
  assert.doesNotMatch(text, /桌面已保存/);
  assert.equal(panel.get('job-save-result').className, 'job-card is-pending');

  const unpaired = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? { status: 'not_queued', mode: 'not_paired', extensionId: 'diagjmploldedipjdenmecmjokckelkl' } : {} });
  await unpaired.click('job-save-button');
  await unpaired.submit();
  assert.match(unpaired.get('job-save-result-text').textContent, /这次没有保存/);
  assert.equal(unpaired.get('job-save-copy-id').hidden, false);
});

test('a possible duplicate is chosen in the panel: link the existing job or save a new one', async () => {
  const exact = [{ applicationId: 'app-1', company: '星河科技', title: '后端开发工程师', stage: '' }];
  const desktop = message => {
    if (message.type === 'DESKTOP_SAVE_JOB') return { status: 'needs_choice', intent: { intentId: 'intent-3' }, exact };
    if (message.type === 'DESKTOP_BIND') return { status: 'saved' };
    return {};
  };
  const panel = await openPanel({ desktop });
  await panel.click('job-save-button');
  await panel.submit();
  assert.equal(panel.get('job-save-choice').hidden, false);
  assert.equal(panel.form.hidden, true);
  const [row] = panel.get('job-save-candidates').children;
  assert.equal(row.textContent, '关联已有：星河科技 · 后端开发工程师');
  await panel.get('job-save-candidates').listeners.click({ target: row });
  await settle();
  const binds = panel.page.desktopCalls.filter(message => message.type === 'DESKTOP_BIND');
  assert.deepEqual(JSON.parse(JSON.stringify(binds)), [{ type: 'DESKTOP_BIND', intentId: 'intent-3', applicationId: 'app-1' }]);
  assert.equal(panel.get('job-save-choice').hidden, true);
  assert.match(panel.get('job-save-result-text').textContent, /桌面已保存/);

  const other = await openPanel({ desktop });
  await other.click('job-save-button');
  await other.submit();
  await other.click('job-save-new');
  const newBind = other.page.desktopCalls.filter(message => message.type === 'DESKTOP_BIND');
  assert.equal(newBind.length, 1);
  assert.equal(newBind[0].applicationId, null);

  const later = await openPanel({ desktop });
  await later.click('job-save-button');
  await later.submit();
  await later.click('job-save-later');
  assert.equal(later.page.desktopCalls.some(message => message.type === 'DESKTOP_BIND'), false);
  assert.match(later.get('job-save-result-text').textContent, /尚未写入桌面/);
});

test('Chrome and Edge run the same save flow and send the same messages', async () => {
  const run = async browser => {
    const panel = await openPanel({ browser });
    await panel.click('job-save-button');
    panel.title.value = 'Java 后端开发工程师';
    await panel.submit();
    return {
      page: panel.pageMessages.filter(message => message.type !== 'RESUME_PANEL_STATUS')
        .map(message => ({ ...message, draftId: message.draftId ? 'draft' : undefined })),
      desktop: JSON.parse(JSON.stringify(panel.saves())),
      result: panel.get('job-save-result-text').textContent
    };
  };
  const chrome = await run('chrome');
  const edge = await run('edge');
  assert.deepEqual(edge, chrome);
  assert.equal(chrome.desktop.length, 1);
  // Neither half branches on the browser.
  for (const file of ['sidepanel.js', 'content.js']) {
    assert.doesNotMatch(read(file), /userAgent|Edg\//, `${file} must not special-case a browser`);
  }
});

test('the panel never submits the job application page', () => {
  const panel = read('sidepanel.js');
  const saveMessages = [...panel.matchAll(/type: "(RESUME_PANEL_[A-Z_]+)"/g)].map(([, type]) => type);
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_DRAFT'));
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_CONFIRM'));
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_CANCEL'));
  assert.ok(saveMessages.includes('RESUME_PANEL_SAVE_CHOICE'));
  const content = read('content.js');
  const section = content.slice(content.indexOf('// --- Saving a job from the native side panel'), content.indexOf('function setDesktopStatus('));
  assert.ok(section.length > 500);
  assert.doesNotMatch(section, /\.submit\(|requestSubmit|\.click\(\)|chrome\.storage/, 'the side panel path only reads the page and talks to the desktop');
});

// --- Review follow-ups on #175 ---------------------------------------------------------------

test('after cancelling recognition the panel is usable at once, before the AI has answered', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  await panel.click('job-save-stop');

  // The AI has not answered yet; the draft request is still waiting on it.
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.get('job-save-confirm').disabled, false);
  assert.equal(panel.get('job-save-confirm').textContent, '确定保存');
  assert.equal(panel.get('job-save-cancel').disabled, false);
  assert.equal(panel.company.disabled, false);

  panel.title.value = '工艺工程师';
  await panel.submit();
  assert.equal(panel.saves().length, 1);
  assert.equal(panel.saves()[0].fields.title, '工艺工程师');

  // The late answer to the cancelled recognition neither reopens the form nor locks the panel.
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: 'wrong', title: 'wrong' } });
  await clicking;
  await settle();
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.get('job-save-result').hidden, false);
  assert.equal(panel.button.disabled, false, 'the old draft request no longer holds the panel busy');
  assert.equal(panel.saves().length, 1);
});

test('a save whose outcome cannot be worked out leaves the saving state instead of freezing the panel', async () => {
  const boom = () => { throw new Error('copy failed'); };
  const panel = await openPanel({ copyOverride: { describeBindResult: boom, describeSaveResult: boom } });
  await panel.click('job-save-button');
  await panel.submit();
  assert.equal(panel.saves().length, 1, 'the write itself happened once');
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.get('job-save-result').hidden, false);
  assert.match(panel.get('job-save-result-text').textContent, /没能确认保存结果/);
  assert.doesNotMatch(panel.get('job-save-result-text').textContent, /桌面已保存/);
  await panel.click('job-save-dismiss');
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.button.disabled, false);

  // The same when the duplicate choice is written.
  const exact = [{ applicationId: 'app-1', company: '星河科技', title: '后端开发工程师', stage: '' }];
  const other = await openPanel({
    copyOverride: { describeBindResult: boom },
    desktop: message => message.type === 'DESKTOP_SAVE_JOB'
      ? { status: 'needs_choice', intent: { intentId: 'intent-9' }, exact } : { status: 'saved' }
  });
  await other.click('job-save-button');
  await other.submit();
  await other.click('job-save-new');
  assert.equal(other.page.desktopCalls.filter(message => message.type === 'DESKTOP_BIND').length, 1);
  assert.equal(other.get('job-save-choice').hidden, true);
  assert.match(other.get('job-save-result-text').textContent, /没能确认保存结果/);
});

test('a single-page site switching job under an open draft discards the draft and saves nothing', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false);
  panel.page.location.href = 'https://jobs.example.com/999';

  // Confirming right away, before any status poll, must not write the old job.
  await panel.submit();
  assert.equal(panel.saves().length, 0);
  assert.match(panel.toast(), /作废/);
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.button.hidden, false);

  // The next click starts a fresh draft for the new page.
  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false);
  await panel.submit();
  assert.equal(panel.saves().length, 1);
});

test('the panel drops a draft on its own when the page address changes, and stops a running recognition', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  assert.equal(panel.get('job-save-progress').hidden, false);
  panel.page.location.href = 'https://kingfa.zhiye.com/apply?job=43';
  await panel.poll();
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.button.hidden, false);
  assert.match(panel.toast(), /作废/);
  assert.equal(panel.page.ai.cancelled.length, 1, 'the AI request for the old page is cancelled');

  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: 'wrong', title: 'wrong' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.form.hidden, true, 'a late AI answer for the old page does not reopen a form');
  assert.equal(panel.saves().length, 0);
});

test('an answer that comes back after switching tabs is not drawn on the new tab', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  panel.setTab(9);
  await panel.poll();
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '金发科技股份有限公司', title: '研发工程师' } });
  await clicking;
  await settle();
  assert.equal(panel.form.hidden, true, 'tab 9 has no draft of its own');
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.saves().length, 0);
});

// --- #175 second round: tabs, address changes, force, location, AI re-recognition -----------

const RELIABLE_WITH_FRAGMENTS = {
  ...RELIABLE_JOB, confidence: 'reliable',
  fragments: [
    { id: 1, source: 'jobposting-company', role: 'company', text: '星河科技' },
    { id: 2, source: 'jobposting-title', role: 'job-title', text: '后端开发工程师' }
  ]
};
const currentDraftId = panel => JSON.parse(JSON.stringify(panel.page.hooks.panelJobSnapshot())).draftId;

test('switching from tab A (waiting on the AI) to tab B frees B at once and A never draws over B', async () => {
  const panel = await openPanel({ extraction: UNRELIABLE_JOB });
  await panel.addPage(8, { extraction: RELIABLE_JOB });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  assert.equal(panel.get('job-save-progress').hidden, false, 'tab A is recognising');

  panel.setTab(8);
  await panel.poll();
  assert.equal(panel.button.disabled, false, 'B does not wait for A\'s request to time out');
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.form.hidden, true);

  // A's AI finally answers; B's panel does not change.
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '金发科技股份有限公司', title: '研发工程师' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.form.hidden, true);
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.button.disabled, false);

  // And B can run its own save.
  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.company.value, '星河科技');
  assert.equal(panel.saves().length, 0);
});

test('a status answer from tab A that arrives after switching to B is ignored', async () => {
  const panel = await openPanel();
  await panel.addPage(8, { extraction: RELIABLE_JOB });
  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false, 'tab A has a draft open');

  const release = panel.holdNextStatus(7);
  const polling = panel.poll();
  await settle();
  panel.setTab(8);
  release();
  await polling;
  await settle();
  assert.equal(panel.form.hidden, true, 'A\'s draft is not drawn on B');
  assert.equal(panel.button.hidden, false);
  assert.equal(panel.button.disabled, false);
  // The answer was thrown away and B was asked again, so the panel follows B, not A.
  assert.ok(panel.pageMessages.filter(message => message.type === 'RESUME_PANEL_STATUS').length >= 2);
});

test('a status poll started before a click cannot clear the new draft it overtook', async () => {
  const panel = await openPanel();
  const release = panel.holdNextStatus(7);
  const polling = panel.poll();
  await settle();

  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false, 'the click opened a new review draft');
  const draftId = currentDraftId(panel);

  release();
  await polling;
  await settle();

  assert.equal(panel.form.hidden, false, 'the old null status did not clear the new form');
  assert.equal(currentDraftId(panel), draftId);
  assert.equal(panel.company.value, '星河科技');
});

test('after the page address changes, a finished result stays truthful but can no longer save the old job again', async () => {
  let saves = 0;
  const panel = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? (++saves === 1 ? { status: 'duplicate' } : { status: 'saved' }) : {} });
  await panel.click('job-save-button');
  await panel.submit();
  assert.equal(panel.get('job-save-again').hidden, false, 'a duplicate offers "save again"');
  const draftId = currentDraftId(panel);

  panel.page.location.href = 'https://jobs.example.com/999';
  const reply = await panel.page.deliver({ type: 'RESUME_PANEL_SAVE_CONFIRM', draftId, force: true });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /核对岗位信息/);
  assert.equal(panel.saves().length, 1, 'the old job was not written again');

  // The completed result remains true; only its unsafe action is removed.
  await panel.poll();
  assert.equal(panel.get('job-save-result').hidden, false);
  assert.match(panel.get('job-save-result-text').textContent, /待同步|已经有一条/);
  assert.equal(panel.get('job-save-again').hidden, true);
  assert.match(panel.get('job-save-result-hint').textContent, /网页已经切换/);
});

test('an AI request is not sent when the job was cancelled while the modules were loading', async () => {
  const page = loadPage({ extraction: UNRELIABLE_JOB, desktop: () => ({}), userAgent: USER_AGENTS.chrome });
  await page.ready();
  let current = true;
  const outcome = await page.hooks.runJobAssist(UNRELIABLE_JOB.fragments, {}, {
    isCurrent: () => current,
    // The user cancels right as recognition starts, before anything has left the page.
    onAssistStart: () => { current = false; }
  });
  assert.equal(outcome.action, 'ignore');
  assert.equal(page.ai.sent.length, 0, 'send was never called');
});

test('a "force" sent with an ordinary confirm cannot skip the duplicate check', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  const draftId = currentDraftId(panel);
  const reply = await panel.page.deliver({ type: 'RESUME_PANEL_SAVE_CONFIRM', draftId, company: '星河科技', title: '后端开发工程师', force: true });
  assert.equal(reply.ok, true);
  assert.equal(panel.saves().length, 1);
  assert.equal(panel.saves()[0].force, false, 'the desktop still runs its duplicate check');

  // Only "save again" after the duplicate warning is allowed to force.
  let count = 0;
  const other = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? (++count === 1 ? { status: 'duplicate' } : { status: 'saved' }) : {} });
  await other.click('job-save-button');
  await other.submit();
  assert.equal(other.saves()[0].force, false);
  await other.click('job-save-again');
  assert.equal(other.saves().length, 2);
  assert.equal(other.saves()[1].force, true);
});

test('a page without the helper turns the button off and says why on screen', async () => {
  const panel = await openPanel();
  assert.equal(panel.get('job-save-hint').hidden, true, 'no hint while the page is supported');
  panel.setTab(9);
  await panel.poll();
  assert.equal(panel.button.disabled, true);
  assert.notEqual(panel.button.title, '');
  assert.equal(panel.get('job-save-hint').hidden, false);
});

test('the visible location can be edited and the confirmed value is saved', async () => {
  const panel = await openPanel({ extraction: { ...RELIABLE_JOB, location: '上海' } });
  await panel.click('job-save-button');
  assert.equal(panel.location.value, '上海');
  panel.location.value = '杭州';
  await panel.submit();
  assert.equal(panel.saves().length, 1);
  assert.equal(panel.saves()[0].fields.location, '杭州');
});

test('a reliable read skips the AI entirely', async () => {
  const panel = await openPanel({ extraction: RELIABLE_WITH_FRAGMENTS });
  await panel.click('job-save-button');
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.get('job-save-progress').hidden, true);
  assert.equal(panel.page.ai.sent.length, 0, 'no fragments were sent');
  assert.equal(panel.company.value, '星河科技');
});

test('an uncertain read asks the AI with progress and a cancel button, without being asked', async () => {
  const uncertain = { ...RELIABLE_WITH_FRAGMENTS, reliable: false, confidence: 'uncertain', company: '公安' };
  const panel = await openPanel({ extraction: uncertain });
  const clicking = panel.get('job-save-button').listeners.click();
  await settle();
  await panel.poll();
  assert.equal(panel.page.ai.sent.length, 1);
  assert.equal(panel.get('job-save-progress').hidden, false);
  assert.equal(panel.get('job-save-stop').textContent, '取消识别');
  assert.equal(panel.form.hidden, true, 'the doubtful company is not offered as if it were settled');
  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '星河科技', title: '后端开发工程师' } });
  await clicking;
  await panel.poll();
  assert.equal(panel.company.value, '星河科技');
  assert.equal(panel.saves().length, 0);
});

test('"AI 重新识别" on a reviewed draft shows progress and a cancel button, then refreshes the fields for review', async () => {
  const panel = await openPanel({ extraction: RELIABLE_WITH_FRAGMENTS });
  await panel.click('job-save-button');
  assert.equal(panel.get('job-save-reassist').disabled, false);

  const reassisting = panel.get('job-save-reassist').listeners.click({ target: panel.get('job-save-reassist') });
  await settle();
  await panel.poll();
  assert.equal(panel.page.ai.sent.length, 1);
  assert.equal(panel.page.ai.sent[0].type, 'AI_EXTRACT_JOB');
  assert.equal(panel.get('job-save-progress').hidden, false);
  assert.equal(panel.get('job-save-stop').textContent, '取消识别');
  assert.equal(panel.form.hidden, true);
  assert.match(panel.get('job-save-fragments').innerHTML, /后端开发工程师/);

  panel.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '新星科技', title: 'Java 后端开发工程师' } });
  await reassisting;
  await panel.poll();
  assert.equal(panel.form.hidden, false);
  assert.equal(panel.company.value, '新星科技');
  assert.equal(panel.title.value, 'Java 后端开发工程师');
  assert.equal(panel.url.value, 'https://jobs.example.com/123', 'the address is the page\'s redacted one');
  assert.equal(panel.saves().length, 0, 'nothing is saved until the user confirms again');

  await panel.submit();
  assert.equal(panel.saves().length, 1);
  assert.equal(panel.saves()[0].fields.company, '新星科技');
});

test('a failed, unsure or cancelled re-recognition keeps the draft the user was editing, and saves nothing', async () => {
  // Failure: the AI gives up.
  const failed = await openPanel({ extraction: RELIABLE_WITH_FRAGMENTS });
  await failed.click('job-save-button');
  failed.title.value = '我改过的岗位名称';
  const failing = failed.get('job-save-reassist').listeners.click({ target: failed.get('job-save-reassist') });
  await settle();
  failed.page.ai.answer({ status: 'manual', reason: 'timeout', reliable: false, fields: {} });
  await failing;
  await failed.poll();
  assert.equal(failed.form.hidden, false, 'the draft is still there');
  assert.equal(failed.company.value, '星河科技');
  assert.equal(failed.title.value, '我改过的岗位名称', 'the user\'s edit survives');
  assert.notEqual(failed.get('job-save-note').textContent, '', 'a plain explanation is shown');
  assert.equal(failed.saves().length, 0);

  // Unsure: the AI offers something it does not trust; it must not replace the user's text.
  const unsure = await openPanel({ extraction: RELIABLE_WITH_FRAGMENTS });
  await unsure.click('job-save-button');
  unsure.title.value = '我改过的岗位名称';
  const asking = unsure.get('job-save-reassist').listeners.click({ target: unsure.get('job-save-reassist') });
  await settle();
  unsure.page.ai.answer({ status: 'ok', reliable: false, fields: { company: '猜的公司', title: '猜的岗位' } });
  await asking;
  await unsure.poll();
  assert.equal(unsure.company.value, '星河科技');
  assert.equal(unsure.title.value, '我改过的岗位名称');
  assert.equal(unsure.saves().length, 0);

  // Cancelled: back to the edited draft, and the late answer is ignored.
  const cancelled = await openPanel({ extraction: RELIABLE_WITH_FRAGMENTS });
  await cancelled.click('job-save-button');
  cancelled.title.value = '我改过的岗位名称';
  const running = cancelled.get('job-save-reassist').listeners.click({ target: cancelled.get('job-save-reassist') });
  await settle();
  await cancelled.poll();
  await cancelled.click('job-save-stop');
  assert.equal(cancelled.page.ai.cancelled.length, 1);
  assert.equal(cancelled.form.hidden, false);
  assert.equal(cancelled.title.value, '我改过的岗位名称');
  cancelled.page.ai.answer({ status: 'ok', reliable: true, fields: { company: '晚到的公司', title: '晚到的岗位' } });
  await running;
  await cancelled.poll();
  assert.equal(cancelled.company.value, '星河科技');
  assert.equal(cancelled.title.value, '我改过的岗位名称', 'a late answer does not overwrite it');
  assert.equal(cancelled.saves().length, 0);
});

// --- #175 review: cancelled recognition must not come back to life --------------------------------

test('a recognition cancelled before the modules finished loading never shows progress or sends anything', async () => {
  const page = loadPage({ extraction: UNRELIABLE_JOB, desktop: () => ({}), userAgent: USER_AGENTS.chrome });
  await page.ready();
  const events = [];
  const outcome = await page.hooks.runJobAssist(UNRELIABLE_JOB.fragments, {}, {
    isCurrent: () => false,
    onAssistStart: () => events.push('start'),
    onAssistEnd: () => events.push('end')
  });
  assert.equal(outcome.action, 'ignore');
  assert.deepEqual(events, [], 'the old overlay\'s "正在识别" panel is not raised for a job nobody waits for');
  assert.equal(page.ai.sent.length, 0);
});

test('if the job stops being current right after progress is shown, the progress is taken down again', async () => {
  const page = loadPage({ extraction: UNRELIABLE_JOB, desktop: () => ({}), userAgent: USER_AGENTS.chrome });
  await page.ready();
  let current = true;
  const events = [];
  const outcome = await page.hooks.runJobAssist(UNRELIABLE_JOB.fragments, {}, {
    isCurrent: () => current,
    onAssistStart: (_described, requestId) => { events.push(['start', requestId]); current = false; },
    onAssistEnd: requestId => events.push(['end', requestId])
  });
  assert.equal(outcome.action, 'ignore');
  assert.equal(events.length, 2);
  assert.equal(events[0][0], 'start');
  assert.deepEqual(events[1], ['end', events[0][1]], 'the same request that raised the progress ends it');
  assert.equal(page.ai.sent.length, 0);
});

// --- #175 review: required-field red borders ------------------------------------------------------

test('typing in a required field clears only that field\'s red border, and the next submit judges both again', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  panel.company.value = '';
  panel.title.value = '';
  await panel.submit();
  assert.equal(panel.company.attributes['aria-invalid'], 'true');
  assert.equal(panel.title.attributes['aria-invalid'], 'true');
  assert.equal(panel.get('job-save-error').textContent, '请补全公司名称和岗位名称后再保存。');

  panel.company.value = '星';
  panel.company.listeners.input({ target: panel.company });
  assert.equal(panel.company.attributes['aria-invalid'], undefined, 'the company border is gone');
  assert.equal(panel.title.attributes['aria-invalid'], 'true', 'the still-empty title keeps its border');
  assert.equal(panel.get('job-save-error').hidden, false);
  assert.equal(panel.get('job-save-error').textContent, '请补全岗位名称后再保存。', 'the prompt names what is still missing');

  panel.title.value = '后';
  panel.title.listeners.input({ target: panel.title });
  assert.equal(panel.title.attributes['aria-invalid'], undefined);
  assert.equal(panel.get('job-save-error').hidden, true);

  // Emptied again, then submitted: both are judged afresh.
  panel.title.value = '  ';
  await panel.submit();
  assert.equal(panel.title.attributes['aria-invalid'], 'true');
  assert.notEqual(panel.company.attributes['aria-invalid'], 'true');
  assert.equal(panel.saves().length, 0);
});

test('editing the title does not clear the company\'s border', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  panel.company.value = '';
  panel.title.value = '';
  await panel.submit();
  panel.title.value = '后端';
  panel.title.listeners.input({ target: panel.title });
  assert.equal(panel.company.attributes['aria-invalid'], 'true');
  assert.equal(panel.title.attributes['aria-invalid'], undefined);
  assert.equal(panel.get('job-save-error').textContent, '请补全公司名称后再保存。');
});

test('a new draft starts with no red border left over from the last one', async () => {
  const panel = await openPanel();
  await panel.click('job-save-button');
  panel.company.value = '';
  await panel.submit();
  assert.equal(panel.company.attributes['aria-invalid'], 'true');
  await panel.click('job-save-cancel');
  await panel.click('job-save-button');
  assert.equal(panel.company.attributes['aria-invalid'], undefined);
  assert.equal(panel.title.attributes['aria-invalid'], undefined);
});

// --- #175 review: "unknown" wording is one fixed sentence for old and new UI ----------------------

test('an unknown bind or save is worded the same by the page overlay and the side panel, and claims neither saved nor queued', async () => {
  const copy = await import('../link/copy.mjs');
  const fixed = copy.describeBindResult({ status: 'unknown' });
  assert.equal(fixed.text, '没能确认保存结果，请到桌面或待同步列表核对后再操作。');
  assert.equal(fixed.text, copy.UNKNOWN_SAVE_TEXT);
  assert.doesNotMatch(fixed.text, /桌面已保存|已经排进|已记为待同步|自动重试/);
  assert.notEqual(fixed.tone, 'success');

  const page = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB' ? new Promise(() => {}) : {} });
  page.page.hooks.setPanelJobWriteTimeoutMs(10);
  await page.click('job-save-button');
  await page.submit();
  await new Promise(resolve => setTimeout(resolve, 30));
  await page.poll();
  assert.equal(page.get('job-save-result-text').textContent, fixed.text, 'the side panel says exactly the same sentence');
});

// The desktop sends an application's stage as its code ("saved"). The duplicate-job list used
// to print that code verbatim ("（saved）") while "确认已投递" showed "（已保存）" for the same
// application; both lists now use the one Chinese label.
test('a possible duplicate shows the stage by its Chinese name, not the desktop code', async () => {
  const exact = [
    { applicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', company: '星河科技', title: '后端开发工程师', stage: 'saved' },
    { applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', company: '星河科技', title: '后端开发工程师', stage: 'submitted' }
  ];
  const panel = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB'
    ? { status: 'needs_choice', intent: { intentId: 'intent-1' }, exact } : {} });
  await panel.click('job-save-button');
  await panel.submit();
  const html = panel.get('job-save-candidates').innerHTML;
  assert.match(html, /星河科技 · 后端开发工程师（已保存）/);
  assert.match(html, /星河科技 · 后端开发工程师（已投递）/);
  assert.doesNotMatch(html, /saved|submitted/);
});
