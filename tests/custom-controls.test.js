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
    list.firstChild.onclick = () => { h.el.value = '北京大学'; h.el.setAttribute('aria-valuetext','北京大学'); list.firstChild.setAttribute('aria-selected', 'true'); h.el.setAttribute('aria-expanded', 'false'); list.hidden = true; };
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
      column.firstChild.onclick = () => { h.el.value = '广东省 / 深圳市'; column.firstChild.classList.add('is-checked'); popup.hidden = true; };
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
  assert.deepEqual(JSON.parse(h.w.ResumeProCustomControls.snapshot(h.target)).selection, ['硕士']);
  h.el.value = 'search'; assert.deepEqual(JSON.parse(h.w.ResumeProCustomControls.snapshot(h.target)).selection, ['硕士']);
});

test('Element filterable remote options are searched without a model hint', async () => {
  const h = harness('<div class="el-select"><div class="el-select__wrapper is-filterable"><input role="combobox" aria-controls="choices" aria-autocomplete="none"></div></div>', { timeoutMs: 500 });
  h.target.root = h.el.closest('.el-select');
  const list = h.w.document.createElement('div'); list.id = 'choices'; list.setAttribute('role', 'listbox'); list.hidden = true; h.w.document.body.append(list);
  h.target.root.onclick = () => { list.hidden = false; };
  h.el.oninput = () => setTimeout(() => {
    list.innerHTML = '<div role="option">北京大学</div>';
    list.firstChild.onclick = () => {
      const label = h.w.document.createElement('span'); label.className = 'el-select__selected-item'; label.textContent = '北京大学';
      h.target.root.append(label); h.el.value = ''; list.hidden = true;
    };
  }, 35);
  assert.equal((await h.api.operate(h.target, '北京大学')).ok, true);
  assert.deepEqual(JSON.parse(h.w.ResumeProCustomControls.snapshot(h.target)).selection, ['北京大学']);
});

test('ordinary failed search restores only its temporary query and blurs its own input', async () => {
  const h = harness('<input role="combobox" aria-controls="choices" aria-autocomplete="list">', { timeoutMs: 250 });
  const list = h.w.document.createElement('div'); list.id = 'choices'; list.setAttribute('role', 'listbox'); list.hidden = true; h.w.document.body.append(list);
  h.el.onclick = () => { list.hidden = false; };
  h.el.oninput = () => { list.innerHTML = '<div role="option">其他大学</div>'; };
  h.el.onblur = () => { list.hidden = true; };
  assert.equal((await h.api.operate(h.target, '北京大学')).reason, 'no_option_match');
  assert.equal(h.el.value, ''); assert.equal(list.hidden, true);
});
test('cancelled search does not revert the query or steal focus for cleanup', async () => {
  let current = true; const h = harness('<input role="combobox" aria-controls="choices" aria-autocomplete="list">');
  const list = h.w.document.createElement('div'); list.id = 'choices'; list.setAttribute('role', 'listbox'); h.w.document.body.append(list);
  h.el.oninput = () => { current = false; }; let blurs = 0; h.el.onblur = () => blurs++;
  assert.equal((await h.api.operate(h.target, '北京大学', { isCurrent: () => current })).reason, 'cancelled');
  assert.equal(h.el.value, '北京大学'); assert.equal(blurs, 0);
});

test('committed custom display does not hide a validation error after blur', async () => {
  const h = harness(button, { inspectText: el => el.getAttribute('aria-invalid') === 'true'
    ? { ok: false, reason: 'validation_not_cleared' } : { ok: true } });
  h.el.onclick = () => addOptions(h); h.el.onblur = () => h.el.setAttribute('aria-invalid', 'true');
  assert.equal((await h.api.operate(h.target, '硕士')).reason, 'validation_not_cleared');
  assert.equal(h.el.textContent, '硕士');
});

test('duplicate visible popup ids are refused instead of selecting the first row', async () => {
  const h = harness(button); let writes = 0;
  h.el.onclick = () => { addOptions(h); addOptions(h); };
  assert.equal((await h.api.operate(h.target, '硕士', { onWrite: () => writes++ })).reason, 'ambiguous_popup');
  assert.equal(writes, 0); assert.equal(h.el.textContent, '请选择');
});
test('custom option commitment on mousedown is accounted before a simultaneous cancel', async () => {
  let current = true, writes = 0; const h = harness(button);
  h.el.onclick = () => { const list = addOptions(h); list.lastChild.onmousedown = () => { h.el.textContent = '硕士'; current = false; }; };
  assert.equal((await h.api.operate(h.target, '硕士', { isCurrent: () => current, onWrite: () => writes++ })).reason, 'cancelled');
  assert.equal(writes, 1); assert.equal(h.el.textContent, '硕士');
});

test('closing a popup after clicking cannot turn a query into a committed selection', async () => {
  const h = harness('<input role="combobox" aria-controls="choices" aria-autocomplete="list" aria-expanded="false">', { timeoutMs: 250 });
  const list = h.w.document.createElement('div'); list.id = 'choices'; list.setAttribute('role', 'listbox'); list.hidden = true; h.w.document.body.append(list);
  h.el.onclick = () => { list.hidden = false; h.el.setAttribute('aria-expanded', 'true'); };
  h.el.oninput = () => { list.innerHTML = '<div role="option" aria-selected="false">北京大学</div>'; list.firstChild.onclick = () => { list.hidden = true; h.el.setAttribute('aria-expanded', 'false'); }; };
  assert.equal((await h.api.operate(h.target, '北京大学')).reason, 'selection_not_committed');
  const state = JSON.parse(h.w.ResumeProCustomControls.snapshot(h.target));
  assert.equal(state.selection, null); assert.equal(state.query, '北京大学');
  assert.equal(h.w.ResumeProCustomControls.hasExistingValue(h.target), true, 'protect user-visible input without calling it a selection');
});

test('editable ARIA commitment can be proved by an owned hidden value after popup removal', async () => {
  const h = harness('<div class="custom-select"><input role="combobox" aria-controls="choices" aria-autocomplete="list"><input type="hidden" value=""></div>', { timeoutMs: 300 });
  h.target.root = h.el.parentElement; const hidden = h.target.root.querySelector('input[type="hidden"]');
  const list = h.w.document.createElement('div'); list.id = 'choices'; list.setAttribute('role', 'listbox'); list.hidden = true; h.w.document.body.append(list);
  h.target.root.onclick = () => { list.hidden = false; };
  h.el.oninput = () => { list.innerHTML = '<div role="option" data-value="master">硕士</div>'; list.firstChild.onclick = () => { hidden.value = 'master'; list.remove(); }; };
  assert.equal((await h.api.operate(h.target, '硕士')).ok, true);
  assert.deepEqual(JSON.parse(h.w.ResumeProCustomControls.snapshot(h.target)).selection, ['master']);
  assert.equal(h.api.check(h.target).ok, true);
});

test('scanner recognizes a readonly ARIA tree combobox as a cascader', () => {
  const h = harness('<label id="q">籍贯</label><input role="combobox" readonly aria-labelledby="q" aria-haspopup="tree" aria-controls="choices">');
  const result = scanner.scanPage(h.w.document);
  assert.equal(result.controls.length, 1); assert.equal(result.controls[0].controlKind, 'cascader');
});
test('ARIA tree cascader waits for nested groups without treating child names as parent labels', async () => {
  const h = harness('<input role="combobox" readonly aria-haspopup="tree" aria-controls="choices">', { timeoutMs: 250 });
  h.target.controlKind = 'cascader';
  const doc = h.w.document;
  const item = (text, next) => {
    const node = doc.createElement('div'); node.setAttribute('role', 'treeitem'); node.textContent = text;
    node.onclick = event => { event.stopPropagation(); if (next) setTimeout(() => {
      node.setAttribute('aria-expanded', 'true'); const group = doc.createElement('div'); group.setAttribute('role', 'group'); group.append(next()); node.append(group);
    }, 25); else { h.el.value = '广东省 / 深圳市 / 南山区'; node.setAttribute('aria-selected', 'true'); node.closest('[role="tree"]').hidden = true; } };
    return node;
  };
  h.el.onclick = () => { const popup = doc.createElement('div'); popup.id = 'choices'; popup.setAttribute('role', 'tree'); popup.append(item('广东省', () => item('深圳市', () => item('南山区')))); doc.body.append(popup); };
  assert.equal((await h.api.operate(h.target, '广东省 / 深圳市 / 南山区')).ok, true);
  assert.equal(h.api.check(h.target).ok, true);
});

test('an ARIA button with only a hidden value remains a single scanned control', () => {
  const h = harness('<label id="q">学历</label><button type="button" role="combobox" aria-labelledby="q" aria-controls="choices">请选择<input type="hidden" value=""></button>');
  const result = scanner.scanPage(h.w.document);
  assert.equal(result.controls.length, 1); assert.equal(result.controls[0].controlKind, 'custom-select');
  assert.equal(result.controls[0].label, '学历');
});

test('a visible ARIA container survives an invisible internal input', () => {
  const h = harness('<label id="q">学历</label><div role="combobox" tabindex="0" aria-labelledby="q" aria-controls="choices">请选择<input style="display:none"></div>');
  const result = scanner.scanPage(h.w.document, { isVisible: el => !el.matches('[style="display:none"]') });
  assert.equal(result.controls.length, 1); assert.equal(result.controls[0].controlKind, 'custom-select');
  assert.equal(result.controls[0].element.tagName, 'DIV');
});

test('independent library selects under a select-group are not merged', () => {
  const h = harness('<div class="select-group"><label id="q1">学历</label><div class="ant-select"><input role="combobox" aria-labelledby="q1"></div><label id="q2">学校</label><div class="ant-select"><input role="combobox" aria-labelledby="q2"></div></div>');
  const result = scanner.scanPage(h.w.document);
  assert.deepEqual(result.controls.map(item => item.label), ['学历', '学校']);
});
test('plain ARIA siblings under a select-group stay independent', () => {
  const h = harness('<div class="select-group"><input role="combobox" aria-label="学历"><input role="combobox" aria-label="学校"></div>');
  assert.equal(scanner.scanPage(h.w.document).controls.length, 2);
});
test('multi-select declared on the popup is refused before choosing an option', async () => {
  const h = harness(button); let writes = 0;
  h.el.onclick = () => { addOptions(h).setAttribute('aria-multiselectable', 'true'); };
  assert.equal((await h.api.operate(h.target, '硕士', { onWrite: () => writes++ })).reason, 'unsupported_control');
  assert.equal(writes, 0); assert.equal(h.el.textContent, '请选择');
});
test('a target becoming a password on focus is not written', async () => {
  const h = harness('<input role="combobox" aria-controls="choices">'); let writes = 0;
  h.el.onfocus = () => { h.el.type = 'password'; h.el.value = 'existing-fictitious-value'; };
  assert.equal((await h.api.operate(h.target, '硕士', { onWrite: () => writes++ })).reason, 'unsupported_control');
  assert.equal(writes, 0); assert.equal(h.el.value, 'existing-fictitious-value');
});
test('a searched input becoming readonly still needs actual commitment', async () => {
  const h = harness('<input role="combobox" aria-controls="choices" aria-autocomplete="list">', { timeoutMs: 250 });
  const popup = h.w.document.createElement('div'); popup.id = 'choices'; popup.setAttribute('role','listbox'); h.w.document.body.append(popup);
  h.el.oninput = () => { popup.innerHTML='<div role="option" aria-selected="false">硕士</div>'; popup.firstChild.onclick=()=>{h.el.readOnly=true;popup.hidden=true;}; };
  assert.equal((await h.api.operate(h.target, '硕士')).reason, 'selection_not_committed');
});
test('busy old options are not treated as the final option set', async () => {
  const h = harness(button, { timeoutMs: 250 });
  h.el.onclick = () => { const popup=addOptions(h,['本科']);popup.setAttribute('aria-busy','true');setTimeout(()=>{popup.remove();addOptions(h);},60); };
  assert.equal((await h.api.operate(h.target,'硕士')).ok, true);
});

test('opaque displayed state guards exclude popup choices and detect selection changes', () => {
  const h=harness('<label id="q">学历</label><div class="custom-select"><span id="chosen">本科</span><input readonly role="combobox" aria-labelledby="q"><div role="listbox"><div role="option">硕士</div></div></div>');
  const control=scanner.scanPage(h.w.document).controls[0];
  assert.deepEqual(scanner.displayedStateForGuard(control),['本科']);
  h.w.document.getElementById('chosen').textContent='硕士';
  assert.deepEqual(scanner.displayedStateForGuard(control),['硕士']);
});

test('modified placeholder captions are not existing selections', () => {
  for(const placeholder of ['请选择学历','请选择…','Please select an option','Select a degree']){
    const h=harness(button.replace('请选择',placeholder));
    assert.equal(h.w.ResumeProCustomControls.hasExistingValue(h.target),false,placeholder);
  }
});
test('an explicit ARIA label is compared as a label even when a hidden value also exists',async()=>{
  const h=harness('<div class="custom-select"><input role="combobox" aria-controls="choices" aria-autocomplete="list"><input type="hidden" value=""></div>',{timeoutMs:300});
  h.target.root=h.el.parentElement;const hidden=h.target.root.querySelector('input[type="hidden"]');
  const popup=h.w.document.createElement('div');popup.id='choices';popup.setAttribute('role','listbox');h.w.document.body.append(popup);
  h.el.oninput=()=>{popup.innerHTML='<div role="option" data-value="master">硕士</div>';popup.firstChild.onclick=()=>{hidden.value='master';h.el.setAttribute('aria-valuetext','硕士');popup.hidden=true;};};
  assert.equal((await h.api.operate(h.target,'硕士')).ok,true);
});
test('editable Element cascader query plus rejected leaf is not commitment',async()=>{
  const h=harness('<div class="el-cascader"><input role="combobox" aria-controls="choices"></div>',{timeoutMs:200});
  h.target.controlKind='cascader';h.target.root=h.el.parentElement;h.el.value='广东省';
  h.target.root.onclick=()=>{const popup=h.w.document.createElement('div');popup.id='choices';popup.className='el-cascader__dropdown';popup.innerHTML='<div class="el-cascader-menu"><div class="el-cascader-node">广东省</div></div>';popup.firstChild.firstChild.onclick=()=>{popup.hidden=true;};h.w.document.body.append(popup);};
  assert.equal((await h.api.operate(h.target,'广东省')).reason,'selection_not_committed');
});

test('cascade child wait follows a remounted owned popup and its busy state',async()=>{
  const h=harness('<div class="el-cascader"><input role="combobox" readonly aria-controls="choices"></div>',{timeoutMs:300});
  h.target.root=h.el.parentElement;h.target.controlKind='cascader';
  const create=()=>{const popup=h.w.document.createElement('div');popup.id='choices';popup.className='el-cascader__dropdown';popup.innerHTML='<div class="el-cascader-menu"><div class="el-cascader-node">广东省</div></div>';return popup;};
  h.el.onclick=()=>{const popup=create();h.w.document.body.append(popup);popup.firstChild.firstChild.onclick=()=>setTimeout(()=>{
    popup.remove();const fresh=create();fresh.setAttribute('aria-busy','true');fresh.insertAdjacentHTML('beforeend','<div class="el-cascader-menu"><div class="el-cascader-node">深圳市</div></div>');
    fresh.lastChild.firstChild.onclick=()=>{h.el.value='广东省 / 深圳市';fresh.hidden=true;};h.w.document.body.append(fresh);setTimeout(()=>fresh.removeAttribute('aria-busy'),30);
  },30);};
  assert.equal((await h.api.operate(h.target,'广东省 / 深圳市')).ok,true);
});

test('hidden stale aria-selected plus the typed query does not prove commitment',async()=>{
  const h=harness('<input role="combobox" aria-controls="choices" aria-autocomplete="list">',{timeoutMs:250});
  const popup=h.w.document.createElement('div');popup.id='choices';popup.setAttribute('role','listbox');h.w.document.body.append(popup);
  h.el.oninput=()=>{popup.innerHTML='<div role="option" aria-selected="true">硕士</div>';popup.firstChild.onclick=()=>{popup.hidden=true;};};
  assert.equal((await h.api.operate(h.target,'硕士')).reason,'selection_not_committed');
});

test('implicit button combobox outside a form is safely operable',async()=>{
  const h=harness(button.replace('type="button"',''));h.w.document.body.append(h.el);
  h.el.onclick=()=>addOptions(h);
  assert.equal((await h.api.operate(h.target,'硕士')).ok,true);
});
test('implicit button acquiring a form on mousedown is refused before activation',async()=>{
  const h=harness(button.replace('type="button"',''));h.w.document.body.append(h.el);
  let clicked=0,submitted=0;const form=h.w.document.querySelector('form');form.id='target-form';form.onsubmit=e=>{submitted++;e.preventDefault();};
  h.el.onmousedown=()=>h.el.setAttribute('form',form.id);h.el.onclick=()=>clicked++;
  assert.equal((await h.api.operate(h.target,'硕士')).reason,'unsupported_control');
  assert.equal(clicked,0);assert.equal(submitted,0);
});

test('implicit button acquiring a form during click still selects without submitting',async()=>{
  const h=harness(button.replace('type="button"',''));h.w.document.body.append(h.el);
  let submitted=0;const form=h.w.document.querySelector('form');form.id='target-form';form.onsubmit=e=>{submitted++;e.preventDefault();};
  h.el.onclick=()=>{h.el.setAttribute('form',form.id);addOptions(h);};
  assert.equal((await h.api.operate(h.target,'硕士')).ok,true);assert.equal(submitted,0);
  // The temporary listener must not suppress later user-owned activations.
  h.el.onclick=null;h.el.click();assert.equal(submitted,1);
});
test('button option changing its type during click commits without submitting',async()=>{
  const h=harness(button);let submitted=0;const form=h.w.document.querySelector('form');form.id='target-form';form.onsubmit=e=>{submitted++;e.preventDefault();};
  h.el.onclick=()=>{const popup=addOptions(h);popup.innerHTML='<button type="button" role="option">硕士</button>';
    popup.firstChild.onclick=()=>{popup.firstChild.type='submit';popup.firstChild.setAttribute('form',form.id);h.el.textContent='硕士';popup.hidden=true;};};
  assert.equal((await h.api.operate(h.target,'硕士')).ok,true);assert.equal(submitted,0);
});

test('Element Plus empty multiple select is refused from its owned dropdown class',async()=>{
  const h=harness('<div class="el-select"><input role="combobox" readonly aria-controls="choices"></div>');
  h.target.root=h.el.parentElement;let chosen=0;
  h.target.root.onclick=()=>{const popup=addOptions(h);popup.className='el-select__popper';popup.innerHTML='<div class="el-select-dropdown is-multiple"><div class="el-select-dropdown__item">硕士</div></div>';popup.querySelector('.el-select-dropdown__item').onclick=()=>chosen++;};
  assert.equal((await h.api.operate(h.target,'硕士')).reason,'unsupported_control');assert.equal(chosen,0);
});

test('a link masquerading as an option is not activated',async()=>{
  const h=harness(button);let clicked=0;
  h.el.onclick=()=>{const popup=addOptions(h);popup.innerHTML='<a role="option" href="https://example.test/side-effect">硕士</a>';popup.firstChild.onclick=e=>{clicked++;e.preventDefault();};};
  assert.equal((await h.api.operate(h.target,'硕士')).reason,'unsupported_control');assert.equal(clicked,0);
});
test('popup lookup targets escaped declared ids without scanning all document ids',async()=>{
  const h=harness(button);const id='choices"\\特殊';h.el.setAttribute('aria-controls',id);
  const query=h.w.document.querySelectorAll.bind(h.w.document);let scans=0;
  h.w.document.querySelectorAll=selector=>{if(selector==='[id]')scans++;return query(selector);};
  h.el.onclick=()=>{const popup=addOptions(h);popup.id=id;};
  assert.equal((await h.api.operate(h.target,'硕士')).ok,true);assert.equal(scans,0);
});
