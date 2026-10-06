const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const scanner = require('../field-scan.js');

function harness(html, options = {}) {
  const dom = new JSDOM(`<form>${html}</form>`, { runScripts: 'outside-only' });
  const w = dom.window;
  for (const file of ['ai-helpers.js', 'custom-controls.js', 'control-adapters.js']) {
    if (fs.existsSync(file)) w.eval(fs.readFileSync(file, 'utf8'));
  }
  const api = w.ResumeProControls.create({ timeoutMs: 160, settleMs: 35,
    isVisible: el => !el.closest('[hidden]'), ...options });
  const el = w.document.querySelector('[role="combobox"]');
  return { w, el, api, target: { kind: 'element', element: el, root: el, controlKind: 'custom-select' } };
}
function addOptions(h, choices = ['本科', '硕士']) {
  const list = h.w.document.createElement('div');
  list.id = 'choices'; list.setAttribute('role', 'listbox');
  for (const text of choices) {
    const item = h.w.document.createElement('div'); item.setAttribute('role', 'option');
    item.textContent = text;
    item.onclick = () => { h.el.textContent = text; h.el.setAttribute('aria-expanded', 'false'); item.setAttribute('aria-selected', 'true'); list.hidden = true; };
    list.append(item);
  }
  h.w.document.body.append(list);
  return list;
}
const button = '<label id="question">学历</label><button type="button" role="combobox" aria-labelledby="question" aria-controls="choices" aria-expanded="false">请选择</button>';

test('scanner keeps a button ARIA combobox as one logical titled field', () => {
  const h = harness(button);
  const result = scanner.scanPage(h.w.document, { isVisible: () => true });
  assert.equal(result.controls.length, 1);
  assert.equal(result.controls[0].controlKind, 'custom-select');
  assert.equal(result.controls[0].label, '学历');
  assert.equal(scanner.isBindingCurrent(result.controls[0], h.w.document), true);
});
test('ARIA portal delayed options commit through clicks and survive final check', async () => {
  const h = harness(button);
  h.el.onclick = () => { h.el.setAttribute('aria-expanded', 'true'); setTimeout(() => addOptions(h), 25); };
  const result = await h.api.operate(h.target, '硕士');
  assert.equal(result.ok, true); assert.equal(h.el.textContent, '硕士');
  assert.equal(h.api.check(h.target).ok, true);
  h.el.textContent = '请选择'; assert.equal(h.api.check(h.target).reason, 'value_reverted');
});
test('ARIA owns locates its popup despite another visible portal', async () => {
  const h = harness(button.replace('aria-controls', 'aria-owns'));
  const other = h.w.document.createElement('div'); other.setAttribute('role', 'listbox'); other.innerHTML = '<div role="option">硕士</div>'; h.w.document.body.append(other);
  let unrelated = 0; other.onclick = () => unrelated++;
  h.el.onclick = () => addOptions(h);
  assert.equal((await h.api.operate(h.target, '硕士')).ok, true); assert.equal(unrelated, 0);
});
test('duplicate exact custom options fail closed without changing native resolver', async () => {
  const h = harness(button); let clicked = 0;
  h.el.onclick = () => { const list = addOptions(h, ['硕士', '硕士']); list.onclick = () => clicked++; };
  const result = await h.api.operate(h.target, '硕士');
  assert.equal(result.reason, 'ambiguous_option'); assert.equal(clicked, 0);
  assert.equal(h.w.ResumeProAIHelpers.findSelectOptionIndex(['硕士', '硕士'], '硕士'), 0);
});
test('disabled and placeholder entries are ignored; negation protection remains', async () => {
  const h = harness(button);
  h.el.onclick = () => { const list = addOptions(h, ['请选择', '硕士', '非全日制']); list.children[1].setAttribute('aria-disabled', 'true'); };
  assert.equal((await h.api.operate(h.target, '全日制')).reason, 'no_option_match');
  assert.equal(h.el.textContent, '请选择');
});
test('custom selection reverted by blur cannot report success', async () => {
  const h = harness(button); h.el.onclick = () => addOptions(h);
  h.el.onblur = () => setTimeout(() => { h.el.textContent = '请选择'; }, 10);
  const result = await h.api.operate(h.target, '硕士');
  assert.equal(result.ok, false); assert.equal(result.reason, 'value_reverted');
});
test('cancellation during option wait leaves the selection untouched', async () => {
  let current = true; const h = harness(button);
  h.el.onclick = () => { setTimeout(() => { current = false; }, 10); setTimeout(() => addOptions(h), 40); };
  const result = await h.api.operate(h.target, '硕士', { isCurrent: () => current });
  assert.equal(result.reason, 'cancelled'); assert.equal(h.el.textContent, '请选择');
});
test('missing options has a bounded and distinct failure', async () => {
  const h = harness(button); const start = Date.now();
  assert.equal((await h.api.operate(h.target, '硕士')).reason, 'options_not_rendered');
  assert.ok(Date.now() - start < 1500);
});

test('search waits for the updated live options rather than treating the query as selection', async () => {
  const h = harness('<label for="search">学校</label><input id="search" role="combobox" aria-controls="choices" aria-autocomplete="list" aria-expanded="false">', { timeoutMs: 500 });
  const list = h.w.document.createElement('div'); list.id = 'choices'; list.setAttribute('role', 'listbox'); list.hidden = true;
  h.w.document.body.append(list);
  h.el.onclick = () => { list.hidden = false; h.el.setAttribute('aria-expanded', 'true'); };
  h.el.oninput = () => setTimeout(() => {
    list.innerHTML = '<div role="option">北京大学</div>';
    list.firstChild.onclick = () => { h.el.value = '北京大学'; h.el.setAttribute('aria-expanded', 'false'); list.hidden = true; };
  }, 35);
  assert.equal((await h.api.operate(h.target, '北京大学')).ok, true);
  assert.equal(h.el.getAttribute('aria-expanded'), 'false');
});
test('a rejected searchable option is not accepted merely because the query matches', async () => {
  const h = harness('<input role="combobox" aria-controls="choices" aria-autocomplete="list" aria-expanded="false">', { timeoutMs: 250 });
  const list = h.w.document.createElement('div'); list.id = 'choices'; list.setAttribute('role', 'listbox'); list.hidden = true; h.w.document.body.append(list);
  h.el.onclick = () => { list.hidden = false; h.el.setAttribute('aria-expanded', 'true'); };
  h.el.oninput = () => { list.innerHTML = '<div role="option">北京大学</div>'; };
  assert.equal((await h.api.operate(h.target, '北京大学')).reason, 'selection_not_committed');
});
test('scanner deduplicates framework container and combobox, distinguishes cascaders', () => {
  const h = harness('<label id="q">籍贯</label><div class="el-cascader" role="combobox"><input role="combobox" aria-labelledby="q"></div>');
  const result = scanner.scanPage(h.w.document, { isVisible: () => true });
  assert.equal(result.controls.length, 1); assert.equal(result.controls[0].controlKind, 'cascader');
});
test('a cascader waits for each child column and commits only the complete path', async () => {
  const h = harness('<label id="q">籍贯</label><div class="el-cascader"><input role="combobox" aria-labelledby="q" aria-controls="choices"></div>', { timeoutMs: 250 });
  h.el = h.w.document.querySelector('input'); h.target.element = h.el; h.target.controlKind = 'cascader'; h.target.root = h.el.parentElement;
  h.target.root.onclick = () => {
    const popup = h.w.document.createElement('div'); popup.id = 'choices'; popup.className = 'el-cascader__dropdown';
    popup.innerHTML = '<div class="el-cascader-menu"><div class="el-cascader-node"><span class="el-cascader-node__label">广东省</span></div></div>';
    popup.firstChild.firstChild.onclick = () => setTimeout(() => {
      const column = h.w.document.createElement('div'); column.className = 'el-cascader-menu'; column.innerHTML = '<div class="el-cascader-node"><span class="el-cascader-node__label">深圳市</span></div>';
      column.firstChild.onclick = () => { h.el.value = '广东省 / 深圳市'; popup.hidden = true; };
      popup.append(column);
    }, 25);
    h.w.document.body.append(popup);
  };
  assert.equal((await h.api.operate(h.target, '广东省 / 深圳市')).ok, true);
});
test('a failed cascader parent never clicks a child', async () => {
  const h = harness('<div class="el-cascader"><input role="combobox" aria-controls="choices"></div>');
  h.target.controlKind = 'cascader'; h.target.root = h.el.parentElement; let childClicks = 0;
  h.target.root.onclick = () => {
    const popup = h.w.document.createElement('div'); popup.id = 'choices'; popup.className = 'el-cascader__dropdown';
    popup.innerHTML = '<div class="el-cascader-menu"><div class="el-cascader-node">北京市</div></div><div class="el-cascader-menu"><div class="el-cascader-node">深圳市</div></div>';
    popup.lastChild.onclick = () => childClicks++; h.w.document.body.append(popup);
  };
  assert.equal((await h.api.operate(h.target, '广东省 / 深圳市')).reason, 'no_option_match');
  assert.equal(childClicks, 0);
});

test('a rejected parent click cannot reuse a stale child column', async () => {
  const h = harness('<div class="el-cascader"><input role="combobox" aria-controls="choices"></div>');
  h.target.controlKind = 'cascader'; h.target.root = h.el.parentElement; let childClicks = 0;
  h.target.root.onclick = () => {
    const popup = h.w.document.createElement('div'); popup.id = 'choices'; popup.className = 'el-cascader__dropdown';
    popup.innerHTML = '<div class="el-cascader-menu"><div class="el-cascader-node">广东省</div></div><div class="el-cascader-menu"><div class="el-cascader-node">深圳市</div></div>';
    popup.lastChild.onclick = () => childClicks++; h.w.document.body.append(popup);
  };
  assert.equal((await h.api.operate(h.target, '广东省 / 深圳市')).reason, 'cascade_timeout');
  assert.equal(childClicks, 0);
});

test('combobox semantics never authorize a submit button', async () => {
  const h = harness(button.replace('type="button"', 'type="submit"')); let submitted = 0;
  h.el.form.onsubmit = event => { submitted++; event.preventDefault(); };
  assert.equal((await h.api.operate(h.target, '硕士')).reason, 'unsupported_control');
  assert.equal(submitted, 0);
});
test('Element committed display is read independently of its empty search input', () => {
  const h = harness('<div class="el-select"><input role="combobox" readonly><div class="el-select__selected-item el-select__input-wrapper is-hidden"></div><div class="el-select__selected-item el-select__placeholder">硕士</div></div>');
  h.target.root = h.el.parentElement;
  assert.equal(h.w.ResumeProCustomControls.snapshot(h.target), '["硕士"]');
  h.el.value = 'search'; assert.equal(h.w.ResumeProCustomControls.snapshot(h.target), '["硕士"]');
});
