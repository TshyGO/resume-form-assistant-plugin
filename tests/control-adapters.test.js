const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const helpers = require('../ai-helpers.js');

function harness(options = {}) {
  class Element {
    constructor() { this.type = 'text'; this.value = ''; this.isConnected = true; this.listeners = new Map(); this.events = []; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) { this.events.push(event.type); for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
    focus() { this.dispatchEvent({ type: 'focus' }); }
    blur() { this.dispatchEvent({ type: 'blur' }); }
    getAttribute(name) { return this[name] ?? null; }
    closest() { return null; }
    click() { if (['checkbox', 'radio'].includes(this.type)) this.checked = this.type === 'radio' || !this.checked; this.dispatchEvent({ type: 'click' }); }
  }
  class Input extends Element {}
  class Select extends Element {}
  class TextArea extends Element {}
  const scope = { ResumeProAIHelpers: helpers };
  const context = { self: scope, HTMLInputElement: Input, HTMLSelectElement: Select, HTMLTextAreaElement: TextArea,
    HTMLElement: Element, Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } }, FocusEvent: class { constructor(type) { this.type = type; } },
    setTimeout, clearTimeout, performance, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'control-adapters.js'), 'utf8'), context);
  const operator = scope.ResumeProControls.create({ helpers, settleMs: 70, timeoutMs: 150, ...options });
  return { ...operator, Input, Select, Element, api: scope.ResumeProControls };
}

test('native date rollback after blur fails without retry or leaking the requested value', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month';
  let writes = 0;
  input.addEventListener('input', () => writes++);
  input.addEventListener('blur', () => setTimeout(() => { input.value = ''; }, 30));
  const result = await h.operate(input, '1998-06');
  assert.equal(result.ok, false); assert.equal(result.reason, 'value_reverted');
  assert.equal(input.value, ''); assert.equal(writes, 1);
  assert.equal(result.observed.rolledBack, true);
  assert.ok(!JSON.stringify(result).includes('1998'));
});

test('native month is actually focused and blurred, then verified', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month';
  const result = await h.operate(input, '1998年6月');
  assert.equal(result.ok, true); assert.equal(input.value, '1998-06');
  assert.ok(input.events.indexOf('focus') < input.events.indexOf('input'));
  assert.ok(input.events.indexOf('input') < input.events.indexOf('blur'));
});

test('readonly native date is refused before focus or any value change', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month'; input.readOnly = true;
  input.value = '2001-02';
  assert.equal((await h.operate(input, '1998-06')).reason, 'unsupported_control');
  assert.equal(input.value, '2001-02'); assert.deepEqual(input.events, []);
});

test('user edits during verification are preserved and not counted as success', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month';
  input.addEventListener('blur', () => setTimeout(() => {
    input.value = '2001-02'; input.dispatchEvent({ type: 'input', isTrusted: true });
  }, 20));
  const result = await h.operate(input, '1998-06');
  assert.equal(result.ok, false); assert.equal(result.reason, 'value_changed');
  assert.equal(input.value, '2001-02');
  assert.ok([...input.listeners.values()].every(list => list.size === 0 || list.size === 1));
});

test('a detached target during verification cannot succeed', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'date';
  input.addEventListener('blur', () => setTimeout(() => { input.isConnected = false; }, 20));
  assert.equal((await h.operate(input, '2000-01-02')).reason, 'element_disconnected');
});

test('cancellation after focus prevents the first write', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month';
  let active = true; input.addEventListener('focus', () => { active = false; });
  const result = await h.operate(input, '1998-06', { isCurrent: () => active });
  assert.equal(result.ok, false); assert.equal(result.reason, 'cancelled'); assert.equal(input.value, '');
});

test('generic date waits for popup rendering and rechecks replacement before writing', async () => {
  const h = harness(); const input = new h.Input(); let ready = false;
  input.click = () => setTimeout(() => { ready = true; }, 50);
  input.addEventListener('input', () => assert.equal(ready, true));
  assert.equal((await h.operate({kind:'element', element:input, pickerType:'generic'}, '1998-06-17')).ok, true);
  input.value = '';
  input.click = () => setTimeout(() => { input.isConnected = false; }, 50);
  const result = await h.operate({kind:'element', element:input, pickerType:'generic'}, '1998-06-17');
  assert.equal(result.reason, 'element_disconnected'); assert.equal(input.value, '');
});

test('native select uses existing resolver and detects rollback', async () => {
  const h = harness(); const select = new h.Select(); select.tagName = 'SELECT';
  select.options = [{value:'',text:'请选择'}, {value:'A',text:'全日制'}, {value:'B',text:'非全日制'}];
  select.selectedIndex = 0;
  const good = await h.operate(select, '非全日制');
  assert.equal(good.ok, true); assert.equal(select.selectedIndex, 2);
  select.addEventListener('blur', () => setTimeout(() => { select.selectedIndex = 0; select.value = ''; }, 20));
  assert.equal((await h.operate(select, '全日制')).ok, false);
});

test('radio and checkbox verify the final checked state', async () => {
  const h = harness({ radioLabel: el => el.label });
  const first = new h.Input(); first.type = 'radio'; first.value = 'A'; first.label = '男';
  const second = new h.Input(); second.type = 'radio'; second.value = 'B'; second.label = '女';
  assert.equal((await h.operate({kind:'radio',elements:[first,second]}, '女')).ok, true);
  const check = new h.Input(); check.type = 'checkbox'; check.checked = false;
  assert.equal((await h.operate(check, 'true')).ok, true); assert.equal(check.checked, true);
  assert.equal((await h.operate(check, 'false')).ok, true); assert.equal(check.checked, false);
  assert.equal((await h.operate(check, 'maybe')).ok, false);
});

test('native activation trusted change is distinguished from subsequent user edits', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'checkbox';
  input.click = () => { input.checked = !input.checked; input.dispatchEvent({type:'change',isTrusted:true}); };
  assert.equal((await h.operate(input, true)).ok, true);
  input.addEventListener('blur', () => setTimeout(() => {
    input.checked = false; input.dispatchEvent({type:'change',isTrusted:true});
  }, 20));
  assert.equal((await h.operate(input, true)).reason, 'value_changed');
  assert.equal(input.checked, false);
});

test('a controlled radio rejection is not forcibly checked or counted as success', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'radio'; input.value = 'B';
  input.click = () => { input.checked = false; };
  const result = await h.operate(input, 'B');
  assert.equal(result.ok, false); assert.equal(result.reason, 'value_not_committed');
  assert.equal(input.checked, false); assert.ok(!input.events.includes('input'));
});

test('the closed control and hints sets reject unsupported controls and strip unknown hints', async () => {
  const h = harness(); const input = new h.Input();
  assert.equal((await h.operate({kind:'element',element:input,controlKind:'custom-select'}, 'A')).reason, 'unsupported_control');
  assert.equal((await h.operate({kind:'element',element:input,controlKind:'invented'}, 'A')).reason, 'unsupported_control');
  assert.deepEqual(JSON.parse(JSON.stringify(h.api.cleanHints({searchable:true,popup:'portal',dateFormat:'YYYY-MM',multiple:false,code:'evil',selector:'body'}))),
    {searchable:true,popup:'portal',dateFormat:'YYYY-MM',multiple:false});
});

test('a refused guard never mutates a target', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month'; input.value = '2001-01';
  assert.equal((await h.operate(input, '1998-06', {beforeWrite: () => false})).ok, false);
  assert.equal(input.value, '2001-01'); assert.deepEqual(input.events, []);
});

test('native sensitive input types cannot be overridden by metadata', async () => {
  const h = harness();
  for (const type of ['password', 'file', 'hidden', 'submit']) {
    const input = new h.Input(); input.type = type;
    const result = await h.operate({kind:'element',element:input,controlKind:'text'}, 'secret');
    assert.equal(result.ok, false); assert.equal(input.value, '');
    assert.ok(!JSON.stringify(result).includes('secret'));
  }
});

test('a disabled radio option does not disable the rest of its group', async () => {
  const h = harness();
  const first = new h.Input(); Object.assign(first, {type:'radio',value:'A',disabled:true});
  const second = new h.Input(); Object.assign(second, {type:'radio',value:'B'});
  assert.equal((await h.operate({kind:'radio',elements:[first,second]}, 'B')).ok, true);
  assert.equal((await h.operate({kind:'radio',elements:[first,second]}, 'A')).reason, 'no_option_match');
  assert.equal(Boolean(first.checked), false);
});

for (const eventType of ['mousedown', 'mouseup']) test(`a radio disabled by ${eventType} is not activated`, async () => {
  const h = harness(); const input = new h.Input(); input.type = 'radio'; input.value = 'B';
  input.addEventListener(eventType, () => { input.disabled = true; });
  assert.equal((await h.operate(input, 'B')).reason, 'control_disabled');
  assert.equal(Boolean(input.checked), false); assert.ok(!input.events.includes('click'));
});

test('cancellation during settlement preserves the written value and removes temporary listeners', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month'; let active = true;
  input.addEventListener('blur', () => setTimeout(() => { active = false; }, 20));
  const result = await h.operate(input, '1998-06', {isCurrent: () => active});
  assert.equal(result.ok, false); assert.equal(result.reason, 'cancelled'); assert.equal(input.value, '1998-06');
  for (const type of ['input','change','keydown','pointerdown']) assert.equal(input.listeners.get(type).size, 0);
});

test('final read catches an earlier successful control rolled back by a later field', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month';
  assert.equal((await h.operate(input, '1998-06')).ok, true);
  input.value = '';
  assert.equal(h.check(input).ok, false); assert.equal(h.check(input).reason, 'value_reverted');
  assert.equal(input.value, '');
});

test('read-only final verification preserves completed evidence after cancellation', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month'; let active = true;
  assert.equal((await h.operate(input, '1998-06', {isCurrent:()=>active})).ok, true);
  active = false; const before = input.events.length;
  assert.equal(h.check(input).ok, true); assert.equal(input.events.length, before);
  input.isConnected = false; assert.equal(h.check(input).reason, 'element_disconnected');
});

test('write accounting distinguishes a refused guard from an interrupted attempted write', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month';
  let writes = 0, active = true;
  const onWrite = () => writes++;
  await h.operate(input, '1998-06', {beforeWrite:()=>false, onWrite});
  assert.equal(writes, 0);
  input.addEventListener('blur', () => { active = false; });
  const result = await h.operate(input, '1998-06', {isCurrent:()=>active, onWrite});
  assert.equal(result.reason, 'cancelled'); assert.equal(writes, 1);
  assert.equal(input.value, '1998-06');
  assert.ok(!JSON.stringify(result).includes('1998'));
});

test('guard callbacks are evaluated once at each stop point', async () => {
  const h = harness(); const input = new h.Input(); input.type = 'month';
  let guardCalls = 0;
  const result = await h.operate(input, '1998-06', {beforeWrite:()=> ++guardCalls === 1});
  assert.equal(result.reason, 'value_changed'); assert.equal(guardCalls, 2);
  assert.equal(input.value, '');
});
