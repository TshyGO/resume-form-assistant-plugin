// #213 follow-up: where the feedback UI sits. Chrome and Edge load these same files, so the
// order here is what both browsers show. Behaviour is covered in desktop/src/feedback-plugin.test.tsx.
const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers/sidepanel-harness.js');

const sidepanel = read('sidepanel.html');
const fillView = sidepanel.slice(sidepanel.indexOf('id="fill-view"'), sidepanel.indexOf('id="fields-view"'));
const fieldsView = sidepanel.slice(sidepanel.indexOf('id="fields-view"'), sidepanel.indexOf('</main>'));
const at = (html, marker) => { const index = html.indexOf(marker); assert.notEqual(index, -1, marker); return index; };

test('the template and 一键 AI 填写 come first; the notice only follows the fill controls', () => {
  const main = sidepanel.slice(at(sidepanel, '<main class="dock-main">'), at(sidepanel, 'id="fill-view"'));
  assert.ok(!main.includes('feedback'), 'nothing is mounted above the fill view');
  assert.ok(at(fillView, 'id="template-select"') < at(fillView, 'id="fill-button"'));
  assert.ok(at(fillView, 'id="fill-button"') < at(fillView, 'id="feedback-notice-root"'));
  assert.ok(at(fillView, 'class="safety-note"') < at(fillView, 'id="feedback-notice-root"'));
  assert.equal(sidepanel.split('id="feedback-notice-root"').length, 2);
});

test('manual feedback follows the fill result and diagnostics, with the automatic line after it', () => {
  assert.ok(at(fillView, 'id="fill-result"') < at(fillView, 'id="feedback-manual-root"'));
  assert.ok(at(fillView, 'id="fill-diagnostics"') < at(fillView, 'id="feedback-manual-root"'));
  assert.ok(at(fillView, 'id="feedback-manual-root"') < at(fillView, 'id="feedback-auto-root"'));
  assert.match(fillView, /<div id="feedback-auto-root" data-variant="compact"><\/div>/);
  const ui = read('feedback-ui.js');
  assert.match(ui, /id="feedback-expand" aria-expanded="false" aria-controls="feedback-form">展开</);
  assert.match(ui, /<form id="feedback-form" hidden>/, 'folded by default');
});

test('the status page keeps the automatic switch and manual feedback in separate sections', () => {
  const popup = read('popup.html');
  assert.ok(at(popup, 'id="feedback-notice-root"') < at(popup, 'id="feedback-auto-root"'));
  assert.ok(at(popup, 'id="feedback-auto-root"') < at(popup, 'id="feedback-manual-root"'));
  assert.ok(!popup.includes('id="feedback-root"'));
  const ui = read('feedback-ui.js');
  assert.match(ui, /<h2 id="feedback-auto-title">自动错误报告<\/h2>/);
  assert.match(ui, /<h2 id="feedback-manual-title">手动反馈问题<\/h2>/);
  assert.doesNotMatch(ui, /自动上报|匿名错误报告/, 'one name for the automatic feature');
});

test('the duplicated 常用字段 list is gone; the 简历字段 tab and manual add/replace/remove stay', () => {
  assert.ok(!sidepanel.includes('常用字段'));
  assert.ok(!sidepanel.includes('quick-fields'));
  assert.ok(!read('sidepanel.js').includes('quick-fields'));
  assert.match(sidepanel, /data-tab="fields"[^>]*>简历字段<\/button>/);
  assert.match(fieldsView, /id="field-search"/);
  assert.match(fieldsView, /id="field-groups"/);
  assert.match(fieldsView, /「添加」在光标处插入，「替换」覆盖整个输入框，「删除」只去掉这个字段/);
  // A pointer from the 填写 page to the field tab, not a second list.
  assert.match(fillView, /<button id="show-fields"[^>]*>简历字段<\/button>/);
  assert.match(read('sidepanel.js'), /getElementById\("show-fields"\)\.addEventListener\("click"/);
});
