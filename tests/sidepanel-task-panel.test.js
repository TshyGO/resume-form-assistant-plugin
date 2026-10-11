// #261: the side panel's multi-step flows share one task panel over the 填写 page. The panel
// only arranges the flows' own controls; these tests pin which flow is in front, what its
// header offers as the way out, and that the page underneath is out of reach meanwhile.
const test = require('node:test');
const assert = require('node:assert/strict');
const { read, openPanel } = require('./helpers/sidepanel-harness.js');

const html = read('sidepanel.html');
const between = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test('every multi-step flow sits in the one task panel; the entries stay on the 填写 page', () => {
  const panel = between('<section id="task-panel"', '<div id="feedback-preview-root">');
  const home = between('<div class="view-scroll" id="fill-home">', '<section id="task-panel"');
  for (const id of ['repeat-card', 'job-save-progress', 'job-save-form', 'job-save-choice', 'job-save-result',
    'submit-confirm-progress', 'submit-confirm-form', 'submit-confirm-choice', 'submit-confirm-result', 'fill-offer']) {
    assert.match(panel, new RegExp(`id="${id}"`), id);
    assert.doesNotMatch(home, new RegExp(`id="${id}"`), id);
  }
  for (const id of ['template-select', 'fill-button', 'repeat-button', 'job-save-button', 'submit-confirm-button', 'queue-center', 'profile-offer', 'fill-diagnostics', 'feedback-manual-root']) {
    assert.match(home, new RegExp(`id="${id}"`), id);
  }
  // A readable title that can take the focus, one explicit way out, and a body that scrolls on its own.
  assert.match(panel, /<h2 id="task-title" tabindex="-1">/);
  assert.match(panel, /<button id="task-exit" class="task-exit" type="button" hidden>/);
  assert.match(panel, /class="task-body" id="task-body"/);
  assert.equal(html.split('id="task-panel"').length, 2, 'one panel');
});

test('the header has no ··· menu: the page has no advanced controls left to fold', () => {
  assert.doesNotMatch(html, /dock-tools|data-advanced=|收起网页高级控件/);
});

test('the 填写指引 card folds with a labelled toggle that controls its body', () => {
  assert.match(html, /<button id="guide-toggle"[^>]*aria-expanded="true" aria-controls="guide-body" aria-label="收起填写指引"/);
  assert.match(html, /<div id="guide-body" class="guide-body">/);
  const source = read('sidepanel.js');
  assert.match(source, /localStorage\?\.setItem\(GUIDE_KEY/, 'the choice is remembered');
});

test('the pages keep Manifest V3 rules: no inline scripts or handlers', () => {
  for (const file of ['sidepanel.html', 'popup.html']) {
    const page = read(file);
    assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>/, file);
    assert.doesNotMatch(page, /\son[a-z]+=/i, file);
    assert.doesNotMatch(page, /<script[^>]*src="https?:/, file);
  }
});

test('saving a job opens the panel at its review step and 取消 there is the flow’s own cancel', async () => {
  const panel = await openPanel();
  const task = panel.get('task-panel');
  assert.equal(task.hidden, true);
  await panel.click('job-save-button');
  assert.equal(task.hidden, false);
  assert.equal(panel.get('task-flow-job').hidden, false);
  for (const other of ['task-flow-submit', 'task-flow-repeat', 'task-flow-archive']) assert.equal(panel.get(other).hidden, true, other);
  assert.equal(panel.get('task-title').textContent, '核对岗位信息');
  assert.equal(panel.get('task-title').focused, true, 'the keyboard starts at the title');
  assert.equal(panel.get('fill-home').inert, true, 'the 填写 page is out of reach');
  assert.equal(panel.get('task-exit').textContent, '取消');
  assert.equal(panel.get('task-exit').hidden, false);
  assert.match(panel.get('task-steps').innerHTML, /<li class="is-done">读取岗位<\/li><li aria-current="step">核对信息<\/li><li>保存结果<\/li>/);
  assert.equal(panel.saves().length, 0, 'opening the panel writes nothing');

  await panel.click('job-save-cancel');
  assert.equal(task.hidden, true);
  assert.equal(panel.get('fill-home').inert, false);
  assert.equal(panel.saves().length, 0);
});

test('while a save is on its way the panel offers no way out, and the result offers 返回', async () => {
  let release;
  const panel = await openPanel({ desktop: message => message.type === 'DESKTOP_SAVE_JOB' ? new Promise(resolve => { release = resolve; }) : { status: 'ok' } });
  await panel.click('job-save-button');
  const saving = panel.submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.get('task-exit').hidden, true, 'nothing pretends to stop a write already sent');
  assert.match(panel.get('task-desc').textContent, /正在保存到桌面/);
  release({ status: 'saved', applicationId: 'app-1' });
  await saving;
  await panel.poll();
  assert.equal(panel.get('task-panel').hidden, false);
  assert.equal(panel.get('task-exit').textContent, '返回');
  assert.match(panel.get('task-steps').innerHTML, /<li aria-current="step">保存结果<\/li>/);
  await panel.click('job-save-dismiss');
  assert.equal(panel.get('task-panel').hidden, true);
  assert.equal(panel.saves().length, 1);
});

test('the job summary shows only the job read on this page, and goes when the tab moves to another page of the same site', async () => {
  const panel = await openPanel();
  panel.setUrl('https://jobs.example.com/job/a?from=list#apply');
  await panel.poll();
  assert.equal(panel.get('job-summary').hidden, true, 'nothing is claimed before the page returns a job');
  await panel.click('job-save-button');
  await panel.click('job-save-cancel');
  assert.equal(panel.get('job-summary').hidden, false);
  assert.equal(panel.get('job-summary-title').textContent, '后端开发工程师');
  assert.equal(panel.get('job-summary-badge').hidden, false);
  // Only the #fragment changed: still the same page.
  panel.setUrl('https://jobs.example.com/job/a?from=list#top');
  await panel.poll();
  assert.equal(panel.get('job-summary').hidden, false);
  // Same site, another job page.
  panel.setUrl('https://jobs.example.com/job/b');
  await panel.poll();
  assert.equal(panel.get('job-summary').hidden, true);
  assert.equal(panel.get('job-summary-badge').hidden, true);
});

test('the field rows no longer reveal a whole value on hover', () => {
  const compose = require('../sidepanel-compose.js');
  const row = compose.renderRow({ chipId: 't:0:0', key: '身份证号', value: '110101199001011234' }, 'group');
  assert.doesNotMatch(row, /title=/);
});
