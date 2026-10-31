// #301 AntD 下拉。替身按 2026-10-29 在 Chromium 里跑真 antd 3.26.20、ant-design-vue 1.7.8、antd 4.24.16 / 5.21.6 看到的结构写。
// 大易 hotjob、B 站、兴业是 3.x 结构：div.ant-select-selection 带 role=combobox，已选文字在 selection-selected-value 里；
// 没有选项（还在加载）时弹层带 --empty，里面是一个禁用的 li[role=option]；多选的选择框带 selection--multiple。
// 边输边搜的下拉（filterOption=false、notFoundContent=null）不输入就没有弹层，3.x 的输入框点开后才显示。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const scanner = require('../field-scan.js');

const visible = el => !el.closest('[hidden]');
function load(label, control) {
  const dom = new JSDOM(`<form><div class="ant-form-item"><div class="ant-form-item-label"><label title="${label}">${label}</label></div>
    <div class="ant-form-item-control">${control}</div></div></form>`, { runScripts: 'outside-only' });
  const w = dom.window;
  for (const file of ['ai-helpers.js', 'custom-controls.js', 'control-adapters.js']) w.eval(fs.readFileSync(file, 'utf8'));
  const api = w.ResumeProControls.create({ timeoutMs: 200, settleMs: 35, isVisible: visible });
  const found = scanner.scanPage(w.document, { isVisible: visible }).controls.find(item => item.label === label);
  assert.ok(found, `scanned ${label}`);
  const target = { kind: 'element', element: found.element, elements: found.elements, root: found.root, controlKind: found.controlKind, hints: {} };
  return { w, doc: w.document, api, target };
}

// AntD 3（rc-select 9）/ ant-design-vue 1.x：点组件根展开，弹层挂在 body 下；选中后占位隐藏，出现 selection-selected-value。
// loadAfter：点开后过一会儿才有选项。没有选项时弹层里是一个禁用条目（加载圈、「暂无数据」或一段文字），
// 弹层带 --empty；emptyClass=false 时不带。remote：输入前没有弹层，输入后按搜索词给选项。
// stale：输入前发出的请求晚到，先显示这份旧列表，再显示搜索结果。combobox：mode=combobox（AutoComplete 也是），输入框一直显示。
function antd3(choices, { label = '学历', loadAfter = 0, multiple = false, selected = '', remote = false, emptyClass = true, notFound = 'spin', stale = null, combobox = false } = {}) {
  const mode = multiple ? 'multiple' : 'single';
  const field = '<div class="ant-select-search__field__wrap"><input autocomplete="off" class="ant-select-search__field" value=""></div>';
  const search = multiple ? `<ul><li class="ant-select-search ant-select-search--inline">${field}</li></ul>`
    : remote || combobox ? `<div class="ant-select-search ant-select-search--inline"${combobox ? '' : ' hidden'}>${field}</div>` : '';
  const shown = selected ? `<div class="ant-select-selection-selected-value" title="${selected}">${selected}</div>` : '';
  const h = load(label, `<div class="ant-select${combobox ? ' ant-select-combobox' : ''} ant-select-enabled"><div class="ant-select-selection ant-select-selection--${mode}" role="combobox"
    aria-autocomplete="list" aria-haspopup="true" aria-controls="menu-1" aria-expanded="false" tabindex="0"><div class="ant-select-selection__rendered">
    <div class="ant-select-selection__placeholder"${selected ? ' hidden' : ''}>请选择</div>${shown}${search}</div></div></div>`);
  const { doc } = h;
  const root = doc.querySelector('.ant-select'), combo = root.querySelector('[role="combobox"]'), input = root.querySelector('input');
  const picked = [], searches = [];
  let dropdown = null, open = false, items = loadAfter || remote || combobox ? [] : choices;
  const close = () => {
    open = false; if (dropdown) dropdown.hidden = true; combo.setAttribute('aria-expanded', 'false');
    if (remote) { input.value = ''; input.closest('.ant-select-search').hidden = true; }
  };
  const choose = text => {
    picked.push(text);
    if (multiple) return;
    root.querySelector('.ant-select-selection__placeholder').hidden = true;
    let value = root.querySelector('.ant-select-selection-selected-value');
    if (!value) { value = doc.createElement('div'); value.className = 'ant-select-selection-selected-value'; root.querySelector('.ant-select-selection__rendered').append(value); }
    value.title = text; value.textContent = text;
    close();
  };
  const NOT_FOUND = {
    spin: '<div class="ant-spin ant-spin-sm ant-spin-spinning"><span class="ant-spin-dot ant-spin-dot-spin"><i class="ant-spin-dot-item"></i></span></div>',
    empty: '<div class="ant-empty ant-empty-small"><p class="ant-empty-description">暂无数据</p></div>',
    text: '暂无数据'
  };
  const render = () => {
    // notFoundContent=null：没有选项时不渲染弹层。
    if ((remote || combobox) && !items.length) { if (dropdown) dropdown.hidden = true; return; }
    if (!dropdown) {
      dropdown = doc.createElement('div');
      dropdown.innerHTML = '<div id="menu-1"><ul role="listbox" class="ant-select-dropdown-menu"></ul></div>';
      doc.body.append(dropdown);
    }
    dropdown.hidden = false;
    dropdown.className = `ant-select-dropdown ant-select-dropdown--${mode}${items.length || !emptyClass ? '' : ' ant-select-dropdown--empty'}`;
    const list = dropdown.querySelector('ul');
    list.innerHTML = '';
    for (const text of items.length ? items : [null]) {
      const li = doc.createElement('li');
      li.setAttribute('role', 'option'); li.setAttribute('unselectable', 'on'); li.setAttribute('aria-disabled', String(!text));
      li.className = text ? 'ant-select-dropdown-menu-item' : 'ant-select-dropdown-menu-item ant-select-dropdown-menu-item-disabled';
      if (text) { li.textContent = text; li.addEventListener('click', () => choose(text)); } else li.innerHTML = NOT_FOUND[notFound];
      list.append(li);
    }
  };
  root.addEventListener('click', () => {
    if (open) return;
    open = true; combo.setAttribute('aria-expanded', 'true');
    if (remote) input.closest('.ant-select-search').hidden = false;
    render();
    if (loadAfter && !items.length) setTimeout(() => { items = choices; if (open) render(); }, loadAfter);
  });
  input?.addEventListener('input', () => {
    if (!remote && !combobox) return;
    const query = input.value;
    searches.push(query);
    if (stale) setTimeout(() => { items = stale; if (open) render(); }, 10);
    setTimeout(() => { items = query ? choices.filter(text => text.includes(query)) : []; if (open) render(); }, stale ? 80 : 30);
  });
  return { ...h, root, input, picked, searches };
}

// AntD 4/5（rc-select 14）：input[type=search][role=combobox] 在组件根里，真选项是 .ant-select-item-option（虚拟列表只渲染第一屏）。
// remote：边输边搜，输入前没有弹层。autoComplete：AutoComplete 组件，输入框里的字就是字段的值。
function antd4(choices, { label = '专业', remote = false, autoComplete = false } = {}) {
  const typing = remote || autoComplete;
  const h = load(label, `<div class="ant-select${autoComplete ? ' ant-select-auto-complete' : ''} ant-select-single${typing ? ' ant-select-show-search' : ''}">
    <div class="ant-select-selector"><span class="ant-select-selection-search"><input type="search" autocomplete="off" class="ant-select-selection-search-input"
      role="combobox" aria-haspopup="listbox" aria-owns="rc_select_0_list" aria-autocomplete="list" aria-controls="rc_select_0_list" aria-expanded="false"${typing ? '' : ' readonly'}></span>
    <span class="ant-select-selection-placeholder">请选择</span></div></div>`);
  const { doc } = h;
  const root = doc.querySelector('.ant-select'), input = root.querySelector('input');
  const picked = [], searches = [];
  let dropdown = null, items = typing ? [] : choices;
  const choose = text => {
    picked.push(text);
    root.querySelector('.ant-select-selection-placeholder')?.remove();
    const item = doc.createElement('span'); item.className = 'ant-select-selection-item'; item.title = text; item.textContent = text;
    root.querySelector('.ant-select-selector').append(item);
    input.value = ''; dropdown.hidden = true; input.setAttribute('aria-expanded', 'false');
  };
  const render = () => {
    if (!items.length) { if (dropdown) dropdown.hidden = true; return; }
    if (!dropdown) {
      dropdown = doc.createElement('div'); dropdown.className = 'ant-select-dropdown';
      dropdown.innerHTML = '<div><div role="listbox" id="rc_select_0_list"></div><div class="rc-virtual-list"><div class="rc-virtual-list-holder"><div><div class="rc-virtual-list-holder-inner"></div></div></div></div></div>';
      doc.body.append(dropdown);
    }
    dropdown.hidden = false; input.setAttribute('aria-expanded', 'true');
    // 0×0 的辅助列表只放当前项前后两条，文字是选项的值。
    dropdown.querySelector('[role="listbox"]').innerHTML = items.slice(0, 2).map((text, index) => `<div role="option" aria-label="${text}" id="rc_select_0_list_${index}">v${index}</div>`).join('');
    const inner = dropdown.querySelector('.rc-virtual-list-holder-inner');
    inner.innerHTML = '';
    for (const text of items.slice(0, 10)) {
      const item = doc.createElement('div'); item.className = 'ant-select-item ant-select-item-option'; item.title = text;
      item.innerHTML = `<div class="ant-select-item-option-content">${text}</div>`;
      item.addEventListener('click', () => choose(text));
      inner.append(item);
    }
  };
  root.querySelector('.ant-select-selector').addEventListener('click', () => { input.setAttribute('aria-expanded', 'true'); render(); });
  input.addEventListener('input', () => {
    searches.push(input.value);
    if (!typing) return;
    const query = input.value;
    setTimeout(() => { items = query ? choices.filter(text => text.includes(query)) : []; render(); }, 30);
  });
  return { ...h, root, input, picked, searches };
}

test('AntD 3 single selection is verified from its selected-value text', async () => {
  const h = antd3(['本科', '硕士', '博士']);
  assert.equal(h.target.element.getAttribute('role'), 'combobox');
  const result = await h.api.operate(h.target, '硕士');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.picked, ['硕士']);
  assert.equal(h.api.check(h.target).ok, true);
  h.root.querySelector('.ant-select-selection-selected-value').remove();
  assert.equal(h.api.check(h.target).reason, 'value_reverted');
});

// #301 #418 南航（ant-design-vue 1.7.8）的证件类型：资料写「居民身份证」，选项里有「身份证」「香港居民身份证」「澳门居民身份证」。
test('an ID type from the profile selects the site option that is another name for it', async () => {
  const ids = ['身份证', '护照', '回乡证', '港澳通行证', '香港居民身份证', '澳门居民身份证', '台胞证'];
  for (const [value, wanted] of [['居民身份证', '身份证'], ['港澳居民来往内地通行证', '回乡证'], ['台湾居民来往大陆通行证', '台胞证']]) {
    const h = antd3(ids, { label: '证件类型' });
    const result = await h.api.operate(h.target, value);
    assert.equal(result.ok, true, `${value}: ${result.reason}`);
    assert.deepEqual(h.picked, [wanted]);
  }
});

test('AntD 3 existing selection is read as the displayed choice', () => {
  const h = antd3(['CET4', 'CET6'], { label: '外语等级', selected: 'CET4' });
  assert.deepEqual(Array.from(h.w.ResumeProCustomControls.readSelection(h.target).texts), ['CET4']);
  assert.equal(h.w.ResumeProCustomControls.hasExistingValue(h.target), true);
});

test('AntD 3 options loaded after opening are waited for instead of matching the empty placeholder', async () => {
  const h = antd3(['汉族', '回族', '满族'], { label: '民族', loadAfter: 60 });
  const result = await h.api.operate(h.target, '回族');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.picked, ['回族']);
});

test('an AntD 3 popup holding only a disabled no-data entry is waited on without the --empty class', async () => {
  for (const notFound of ['empty', 'text']) {
    const h = antd3(['汉族', '回族', '满族'], { label: '民族', loadAfter: 60, emptyClass: false, notFound });
    const result = await h.api.operate(h.target, '回族');
    assert.equal(result.ok, true, `${notFound}: ${result.reason}`);
    assert.deepEqual(h.picked, ['回族']);
  }
});

test('AntD 3 multiple select is refused before an option is clicked', async () => {
  const h = antd3(['英语', '日语'], { label: '技能', multiple: true });
  const result = await h.api.operate(h.target, '日语');
  assert.equal(result.reason, 'unsupported_control');
  assert.deepEqual(h.picked, []);
});

test('AntD 3 search select without a popup before typing is searched in its own input', async () => {
  const h = antd3(['北京大学', '北京师范大学', '清华大学'], { label: '毕业院校', remote: true });
  const result = await h.api.operate(h.target, '北京大学');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.picked, ['北京大学']);
  assert.deepEqual(h.searches, ['北京大学']);
  assert.equal(h.input.value, '');
});

test('a failed AntD 3 search without results puts the typed query back', async () => {
  const h = antd3(['北京大学', '北京师范大学', '清华大学'], { label: '毕业院校', remote: true });
  const result = await h.api.operate(h.target, '某某大学');
  assert.equal(result.reason, 'options_not_rendered');
  assert.deepEqual(h.picked, []);
  assert.deepEqual(h.searches, ['某某大学', '']);
  assert.equal(h.input.value, '');
});

test('an AntD 3 search waits past a stale list that arrives after typing', async () => {
  const h = antd3(['北京大学', '北京师范大学', '清华大学'], { label: '毕业院校', remote: true, stale: ['北京大学医学部'] });
  const result = await h.api.operate(h.target, '北京大学');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.picked, ['北京大学']);
});

test('an AntD 3 search whose results hold only a longer name still picks it after the wait', async () => {
  const h = antd3(['北京大学（本部）', '清华大学'], { label: '毕业院校', remote: true });
  const result = await h.api.operate(h.target, '北京大学');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.picked, ['北京大学（本部）']);
});

test('AntD 3 combobox mode without suggestions is not typed into', async () => {
  const h = antd3(['北京大学', '清华大学'], { label: '毕业院校', combobox: true });
  const result = await h.api.operate(h.target, '北京大学');
  assert.equal(result.reason, 'options_not_rendered');
  assert.deepEqual(h.searches, []);
  assert.equal(h.input.value, '');
});

test('AntD 4/5 search select without a popup before typing is searched in its own input', async () => {
  const h = antd4(['北京大学', '北京师范大学', '清华大学'], { label: '毕业院校', remote: true });
  const result = await h.api.operate(h.target, '北京大学');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.picked, ['北京大学']);
  assert.equal(h.input.value, '');
});

test('AntD 4/5 select picks from its rendered options as before', async () => {
  const majors = Array.from({ length: 120 }, (_, index) => `专业${String(index + 1).padStart(3, '0')}`);
  const h = antd4(majors);
  const result = await h.api.operate(h.target, '专业003');
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.picked, ['专业003']);
  assert.deepEqual(h.searches, []);
});

test('AntD AutoComplete without suggestions is not typed into', async () => {
  const h = antd4(['北京大学', '清华大学'], { label: '毕业院校', autoComplete: true });
  assert.equal(h.target.controlKind, 'custom-select');
  const result = await h.api.operate(h.target, '北京大学');
  assert.equal(result.reason, 'options_not_rendered');
  assert.deepEqual(h.searches, []);
  assert.equal(h.input.value, '');
});
