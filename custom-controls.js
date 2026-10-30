// DOM-only custom controls. No model-provided selectors, framework internals or
// page code are executed. The host owns write guards, events, waits and verification.
(function attachCustomControls(scope) {
  const ROOTS = '.ant-select, .ant-cascader, .el-select, .el-cascader, .arco-select, .arco-cascader, .layui-form-select';
  const SHELLS = '.ant-select-dropdown, .ant-cascader-dropdown, .el-select__popper, .el-select-dropdown, .el-cascader__dropdown, .arco-select-popup, .arco-cascader-popup, .arco-trigger-popup';
  const POPUPS = `${SHELLS}, [role="listbox"], [role="tree"]`;
  const trim = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function shown(node) {
    for(let current=node;current;current=current.parentElement){
      if(current.hidden || current.getAttribute('aria-hidden')==='true') return false;
      const css=current.ownerDocument.defaultView.getComputedStyle(current);
      if(css.display==='none' || css.visibility==='hidden') return false;
    }
    return true;
  }
  // 组件根里看得见的文字。组件根取大了（外层类名带 select 的整行）时会装进题目和占位提示，这些不是已选值：
  // 不装着输入框的 <label>、类名以 title / placeholder 结尾的元素里的字都跳过。
  const NOT_VALUE_TOKEN = /(?:^|[-_])(?:title|placeholder)$/i;
  // #301 弹层画在组件根里（Moka sd-Dropdown 不挂到 body 时）：在包着输入框的 <label> 外框旁边的槽位里，fixed 定位。
  // 组件根里、外框外面、自己或往上到根之间有一层 fixed 定位的一块才算；外框里是组件显示的已选值。
  // absolute 定位的一块可能是组件浮着显示的已选值，不算。
  function innerPopup(node, root, el) {
    const frame = el?.closest?.('label');
    if (!frame || !root.contains(frame) || node === root || !root.contains(node) || node.contains(frame) || frame.contains(node)) return false;
    for (let current = node; current && current !== root; current = current.parentElement) {
      if (current.ownerDocument.defaultView.getComputedStyle(current).position === 'fixed') return true;
    }
    return false;
  }
  function shownText(root, el) {
    const parts = [];
    const notValue = node => {
      for (let current = node; current && current !== root.parentElement; current = current.parentElement) {
        if (current.tagName === 'LABEL' && !(el && current.contains(el))) return true;
        if (String(current.getAttribute?.('class') || '').split(/\s+/).some(token => NOT_VALUE_TOKEN.test(token))) return true;
        // 根里展开的弹层：里面是选项，不是已选值。
        if (innerPopup(current, root, el)) return true;
      }
      return false;
    };
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(parent.tagName) && trim(node.data) && shown(parent) && !notValue(parent)) parts.push(trim(node.data));
    }
    return trim(parts.join(' '));
  }
  // #269 通用路径：不是已适配的组件库、整个组件上也没有任何 ARIA 标记的下拉（北森 phoenix、Moka sd 等自研组件）。
  // 不靠类名认弹层：点开后看页面上新冒出来、贴着这个控件的那一块；选项是里面只含一段短文字的条目；
  // 选完读组件上显示的文字核验。拿不准（两块并存、没有匹配、被回滚）一律不选或不算成功。
  const ARIA_SIGNALS = '[role="combobox"], [aria-haspopup]:not([aria-haspopup="false"]), [aria-controls], [aria-owns], [aria-autocomplete]';
  const GENERIC_EMPTY = /^(?:暂无数据|无匹配数据|没有数据|无数据|加载中|搜索中|no data|no results?|loading)/i;
  const GENERIC_LOADING = /^(?:加载中|搜索中|loading)/i;
  // 弹层里的操作文字（北森「勾选 + 确定」式底部按钮、已选计数）不是选项。
  const GENERIC_ACTION = /^(?:确定|确认|完成|取消|关闭|清空|清空已选|重置|全选|已选\s*\d+\s*\/\s*\d+|ok|cancel|confirm|done|clear|reset)$/i;
  const GENERIC_NOISE = /(?:^|[-_])(?:error|message|tip|tips|tooltip|help|hint|feedback)(?:$|[-_])/i;
  // 北森「勾选 + 确定」式弹层里列表周围的字：左侧的「全部」面包屑，右侧拆成几段的「已选 0/1」计数，没选时的「请在左侧选择内容」。
  const GENERIC_COUNTER = /^已选\s*\d+\s*\/\s*\d+$/;
  const GENERIC_PROMPT = /^请(?:在|从)左(?:侧|边)选择/;
  const BREADCRUMB_CLASS = /breadcrumb/i;
  // 加载图标：类名以 loading 结尾（北森 psd_page-loading），自己不带文字。lazyloading、loading-done 不算。
  const LOADING_TOKEN = /(?:^|[-_])loading$/i;
  // 带月份的日期：通用路径分不清日历格子，交给日期操作或不填。
  const DATE_VALUE = /^\s*\d{4}\s*[-./年]\s*\d{1,2}/;
  // 通用路径交还前等自己的弹层退场的上限。
  const POPUP_LEAVE_MS = 1000;
  // 失败收尾按了 Esc 以后等弹层退场的上限，过了还在才在页面空白处按一下。
  const ESC_LEAVE_MS = 600;
  // 点选后冒出的下一级选项要一直在、组件也一直没显示所选，满这么久才算两级选择。
  const NEXT_LEVEL_MS = 300;
  // 联想框（#404 51job）聚焦后多半不弹建议，要打了字才有：只等这么久，没有就先打字。
  const FREE_TEXT_OPEN_MS = 600;
  // 打字后的建议里没有同名的一项：列表这么久没变、离打字也过了 FREE_TEXT_SETTLE_MS，才认定没有，
  // 免得把聚焦时那次请求晚到的列表当成打字后的结果。
  const FREE_TEXT_STEADY_MS = 500;
  const FREE_TEXT_SETTLE_MS = 1000;
  // 联想框打字后等它自己的建议框出来的上限。Element 防抖后取建议时就先弹出加载中的建议框。
  const FREE_TEXT_TYPED_MS = 1500;
  // 普通文本框写不进时再打一次字，等建议的上限（见 suggest）。
  const SUGGEST_MS = 1500;
  // #377 YUI 2 AutoComplete（SuccessFactors 的 juic.SFLegacyAutoComplete 改自它）：输入框带 yui-ac-input，
  // 外层 div.yui-ac 里的 .yui-ac-container 是建议框，正好一个才认。
  function yuiBox(el) {
    if (el?.tagName !== 'INPUT' || !el.classList?.contains('yui-ac-input')) return null;
    const boxes = el.closest('.yui-ac')?.querySelectorAll('.yui-ac-container') || [];
    return boxes.length === 1 ? boxes[0] : null;
  }
  function describe(target) {
    const el = target?.element || target;
    if (yuiBox(el)) return { el, root: target?.root || el, combo: el, library: 'yui', cascade: false, multiple: false };
    const root = el?.closest?.(ROOTS) || target?.root || el;
    let library = root?.matches?.('.ant-select, .ant-cascader') ? 'antd'
      : root?.matches?.('.el-select, .el-cascader') ? 'element'
      : root?.matches?.('.arco-select, .arco-cascader') ? 'arco'
      : root?.matches?.('.layui-form-select') ? 'layui' : 'aria';
    if (library === 'aria' && root && !root.matches?.(ARIA_SIGNALS) && !el?.matches?.(ARIA_SIGNALS) && !root.querySelector?.(ARIA_SIGNALS)) library = 'generic';
    if (library === 'generic') return { el, root, combo: el, library, cascade: target?.controlKind === 'cascader', multiple: false };
    const cascade = target?.controlKind === 'cascader' || root?.matches?.('.ant-cascader, .el-cascader, .arco-cascader');
    const combo = root?.matches?.('[role="combobox"]') ? root : root?.querySelector?.('[role="combobox"]') || el;
    const multiple = combo?.getAttribute?.('aria-multiselectable') === 'true'
      || root?.matches?.('.ant-select-multiple, .el-select--multiple, .arco-select-multiple')
      || Boolean(root?.querySelector?.('.ant-select-selection-overflow, .ant-select-selection--multiple, .el-select__tags, .arco-select-view-tag'));
    return { el, root, combo, library, cascade: Boolean(cascade), multiple: Boolean(multiple) };
  }
  // #269 联想输入框（智联学校名称、#299 51job 的 el-autocomplete）：本来就允许直接输入。
  // 只认组件类名写明是联想输入框的；单有 aria-autocomplete 的可能是只能从列表里选的下拉。
  // 宿主（control-adapters.js）据此在建议里没有时按文本框填写，这里据此不选比要填的字短的建议。
  const AUTOCOMPLETE_TOKEN = /(?:^|[-_])auto-?complete$/i;
  function acceptsFreeText(ctx) {
    const el = ctx.el, info = describe(ctx.entry);
    if (ctx.kind !== 'custom-select' || el?.tagName !== 'INPUT' || el.readOnly || el.disabled) return false;
    if (!['text', 'search'].includes(el.type) || !['aria', 'generic'].includes(info.library)) return false;
    return [info.root, el.parentElement, el.parentElement?.parentElement].some(node => String(node?.className || '').split(/\s+/)
      .some(token => AUTOCOMPLETE_TOKEN.test(token)));
  }
  // Element UI（Vue 2）可搜索的下拉：收起时输入框只读、显示已选文字；展开时输入框清空，已选文字挪到占位提示里。
  // 记下收起时的占位提示，展开时占位提示和它不同，就是已选文字（#269 智联）。
  const closedPlaceholder = new WeakMap();
  function selectedTexts(info) {
    const { root, el, library, cascade } = info;
    if (!root?.isConnected) return null;
    if (library === 'element' && !cascade && el.tagName === 'INPUT' && !root.querySelector('.el-select__wrapper')) {
      if (el.readOnly) closedPlaceholder.set(el, el.placeholder);
      else if (!el.value && closedPlaceholder.has(el) && trim(el.placeholder) && el.placeholder !== closedPlaceholder.get(el)) return [trim(el.placeholder)];
    }
    if (library === 'generic') {
      // 组件上显示的文字：输入框的值，没有就取组件根里看得见的文字；占位提示不算。
      const text = trim(el.tagName === 'INPUT' ? el.value : '') || shownText(root, el);
      if (!text || scope.ResumeProAIHelpers?.isPlaceholderOption(text) || text === trim(el.getAttribute?.('placeholder'))) return [];
      return [text];
    }
    if (library === 'aria' && el.tagName === 'INPUT' && (!el.readOnly || info.requireCommitSignal)) {
      const explicit = trim(info.combo.getAttribute('aria-valuetext'));
      if (explicit) return [explicit];
      const hidden = root.querySelectorAll('input[type="hidden"]');
      if (hidden.length === 1) return hidden[0].value ? [String(hidden[0].value)] : [];
      // aria-selected in an open popup can describe visual focus rather than a
      // committed value. Editable controls always need a persistent signal.
      // The input may contain a query even after Escape/blur closed the popup.
      // Without an independent selected-state signal, commitment is unknown.
      return el.value ? null : [];
    }
    // AntD 3 和 ant-design-vue 1.x（大易 hotjob、B 站）把已选文字放在 selection-selected-value 里。
    const selector = library === 'antd' ? '.ant-select-selection-item, .ant-select-selection-selected-value'
      : library === 'element' ? '.el-select__selected-item:not(.el-select__input-wrapper):not(.is-transparent), .el-select__tags-text'
      : library === 'arco' ? '.arco-select-view-value, .arco-select-view-tag, .arco-cascader-view-value' : '';
    if (library === 'element' && cascade && (info.requireCascadeSignal || !el.readOnly)) {
      const leaf = info.lastChoice;
      const checked = leaf?.isConnected && (leaf.getAttribute('aria-checked') === 'true'
        || leaf.classList.contains('is-checked') || Boolean(leaf.querySelector('input[type="radio"]:checked, .el-radio.is-checked')));
      if (!checked) return [];
    }
    if (selector) {
      const values = Array.from(root.querySelectorAll(selector), node => trim(node.textContent)).filter(Boolean);
      if (values.length) return cascade ? values.join(' / ').split(/\s*(?:\/|>|→)\s*/).filter(Boolean) : values;
      // Element UI (Vue 2) stores the committed label directly in its input. Its readonly flag
      // flips while the dropdown opens (#269 智联), so only Element Plus (wrapper markup) stops here.
      if (library !== 'element' || (!cascade && root.querySelector('.el-select__wrapper'))) return [];
    }
    const value = trim(el.tagName === 'INPUT' ? el.value : el.getAttribute('role') === 'combobox' ? el.textContent : '');
    if (!value || scope.ResumeProAIHelpers?.isPlaceholderOption(value)) return [];
    return cascade ? value.split(/\s*(?:\/|>|→)\s*/).filter(Boolean) : [value];
  }
  function snapshot(target) {
    const info = describe(target);
    if (!info.root?.isConnected || !info.el?.isConnected) return null;
    // 不记只读状态：有的组件点开下拉时会切换 readonly（#269 智联 Element UI），
    // 那是插件自己的操作，不能被写入前复查当成用户改了字段。
    // Element 的输入框里就是已选文字（展开时清空），已经由 selection 表示。
    return JSON.stringify({ selection: selectedTexts(info),
      query: info.el.tagName === 'INPUT' && info.library !== 'element' ? String(info.el.value ?? '') : null });
  }
  function hasExistingValue(target) {
    const info = describe(target), values = selectedTexts(info);
    // A query is existing user input which needs overwrite protection, not
    // evidence of a committed selection. The snapshot tracks it separately.
    return values === null || values.length > 0 || (info.el.tagName === 'INPUT' && !info.el.readOnly && Boolean(info.el.value));
  }
  // 用户眼前显示的已选文字（#189 保存到「我的信息」用）。读不准就返回 null，不猜；没选返回空数组。
  function readSelection(target) {
    const info = describe(target), texts = selectedTexts(info);
    return texts === null ? null : { texts, cascade: info.cascade };
  }
  function outerPopup(node) { return node?.closest?.(SHELLS) || node; }
  function popups(doc, visible) {
    const all = Array.from(new Set(Array.from(doc.querySelectorAll(POPUPS), outerPopup))).filter(visible);
    return all.filter(node => !all.some(other => other !== node && other.contains(node)));
  }
  function ownedPopup(info, visible) {
    const sources = [info.combo, info.el, info.root, ...info.root.querySelectorAll('[aria-controls], [aria-owns]')];
    const ids = new Set(sources.flatMap(node => `${node.getAttribute('aria-controls') || ''} ${node.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean)));
    // Duplicate ids are invalid HTML but occur in repeated application rows.
    // getElementById would silently pick the first popup and could select a
    // different row's option. Only one visible referenced popup is acceptable.
    // Resolve only declared ids. Attribute-string CSS escaping also works where
    // CSS.escape is unavailable; no page value becomes an executable selector.
    const escaped = id => id.replace(/[\u0000-\u001f\u007f"\\]/g, character => `\\${character.codePointAt(0).toString(16)} `);
    const referenced = Array.from(ids).flatMap(id => Array.from(info.el.ownerDocument.querySelectorAll(`[id="${escaped(id)}"]`)));
    const layers = Array.from(new Set(referenced.map(outerPopup).filter(visible)));
    // Element Plus el-autocomplete: aria-controls names the suggestion layer and aria-owns the list
    // inside it. A referenced layer holding another counts once, unless it also holds the control:
    // that is a page section rather than a popup, and both stay ambiguous.
    const owned = layers.filter(node => !layers.some(other => other !== node && other.contains(node) && !other.contains(info.root)));
    return { hasIds: ids.size > 0, popup: owned.length === 1 ? owned[0] : null, ambiguous: owned.length > 1 };
  }
  function optionNodes(popup, info, level) {
    if (info.cascade) {
      if (info.library === 'aria' && popup.getAttribute('role') === 'tree') {
        const parent = level === 0 ? popup : info.pathNodes?.[level - 1];
        if (!parent?.isConnected) return [];
        return Array.from(parent.querySelectorAll('[role="treeitem"]')).filter(node => {
          const ancestor = node.parentElement.closest('[role="treeitem"]');
          return level === 0 ? !ancestor : ancestor === parent;
        });
      }
      const columns = popup.querySelectorAll('.ant-cascader-menu, .el-cascader-menu, .arco-cascader-list, [role="group"]');
      const column = columns[level];
      return column ? Array.from(column.querySelectorAll('.ant-cascader-menu-item, .el-cascader-node, .arco-cascader-list-item, [role="treeitem"], [role="option"]')) : [];
    }
    const realSelector = info.library === 'antd' ? '.ant-select-item-option'
      : info.library === 'element' ? '.el-select-dropdown__item'
      : info.library === 'arco' ? '.arco-select-option'
      : info.library === 'layui' ? 'dd:not(.layui-select-tips)' : '';
    const real = realSelector ? Array.from(popup.querySelectorAll(realSelector)) : [];
    return real.length ? real : Array.from(popup.querySelectorAll('[role="option"]'));
  }
  // 搜索词高亮（北森 react-highlight-words）：「大专及以上」拆成 <mark>大专</mark><span>及以上</span>。
  // 子元素里有 <mark>、并且都是不再往下分的行内元素时，整段文字算一个条目；只在类名上标了 highlighted 的不算。
  const INLINE_TAGS = new Set(['MARK', 'SPAN', 'B', 'EM', 'STRONG', 'I']);
  function highlightedText(node) {
    const children = Array.from(node.children);
    return children.some(child => child.tagName === 'MARK') && children.every(child => INLINE_TAGS.has(child.tagName) && !child.children.length);
  }
  // 弹层里的条目：每个只含一段短文字的叶子，往上取到「只装着这一段文字」的最高一层当作可点的条目。
  function genericOptions(popup, h) {
    const hasText = node => Boolean(trim(node.textContent));
    // 弹层自己标了 role=option 就用它；否则按「只含一段短文字」找条目。
    const marked = Array.from(popup.querySelectorAll('[role="option"]')).filter(node => h.visible(node) && hasText(node));
    const leaves = marked.length ? [] : Array.from(popup.querySelectorAll('*')).filter(node => h.visible(node) && hasText(node)
      && (!Array.from(node.children).some(hasText) || highlightedText(node)) && !(node.parentElement && highlightedText(node.parentElement))
      && trim(node.textContent).length <= 40
      && !node.closest('input, textarea, select, button[type="submit"]'));
    const items = marked.slice();
    for (const leaf of leaves) {
      let item = leaf;
      while (item.parentElement && item.parentElement !== popup
        && leaves.filter(other => item.parentElement.contains(other)).length === 1) item = item.parentElement;
      if (!items.includes(item) && !item.querySelector('input, textarea, select')) items.push(item);
    }
    return items.map(node => {
      const full = trim(node.textContent);
      // 中英双语的选项（「男/Male」）：按中文部分比，后半是纯英文时才拆。
      const [first, ...rest] = full.split(/\s*\/\s*/);
      const primary = rest.length && /^[\x20-\x7e]+$/.test(rest.join('/')) ? first : full;
      const disabled = node.getAttribute('aria-disabled') === 'true' || /(?:^|[-_])disabled(?:$|[-_])/i.test(String(node.className || ''));
      return { node, target: clickTarget(node, hasText), text: primary, value: full, full, disabled };
    }).filter(option => !GENERIC_EMPTY.test(option.full) && !GENERIC_ACTION.test(option.full)
      && !option.node.closest('button, [role="button"], [class*="footer" i]'));
  }
  const CALENDAR_CLASS = /(?:^|[-_])(?:date|calendar|datepicker|daterange)(?:$|[-_])|date-?picker/i;
  function looksCalendar(layer, popup, h) {
    const nodes = [popup, layer, ...layer.querySelectorAll('[class]')];
    if (nodes.some(node => CALENDAR_CLASS.test(String(node.className || '')))) return true;
    // 没有类名线索时看内容：一屏里大半是 1～31 的数字，并且有「xxxx年」「x月」这样的标题，才是日期格子
    // （班级排名 1～30 这类数字下拉没有年月标题，不算）。
    const list = genericOptions(popup, h);
    if (!(list.length >= 20 && list.filter(option => /^\d{1,2}$/.test(option.full)).length >= list.length * 0.6)) return false;
    const view = calendarView(layer, h);
    return Boolean(view.headYear || view.headMonth);
  }
  // 点哪里：条目带单选圈、勾选框时点它（北森「勾选 + 确定」式选择框只认圆圈，点文字不算选中）；
  // 否则点文字所在的最里层，事件向外冒泡，网站把点击处理挂在哪一层都收得到。
  const MARK_CLASS = /radio|checkbox|check-?box|checked|unchecked/i;
  function clickTarget(node, hasText) {
    const marks = Array.from(node.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [class]'))
      .filter(el => el.matches('input, [role="radio"], [role="checkbox"]') || (!hasText(el) && MARK_CLASS.test(String(el.getAttribute('class') || ''))));
    const outer = marks.filter(el => !marks.some(other => other !== el && other.contains(el)));
    if (outer.length === 1) return outer[0];
    let target = node;
    for (let inner = target.firstElementChild; inner; inner = target.firstElementChild) {
      const texty = Array.from(target.children).filter(hasText);
      if (texty.length !== 1 || Array.from(target.childNodes).some(child => child.nodeType === 3 && trim(child.data))) break;
      target = texty[0];
    }
    return target;
  }
  // 选择框底部的「确定」：弹层里只有一个看得见的这类按钮时才点；表单的提交、跳转由 click 自己拦下。
  const CONFIRM_TEXT = /^(?:确定|确认|完成|ok|confirm|done)$/i;
  function confirmButton(layer, h) {
    const found = Array.from(layer.querySelectorAll('*')).filter(el => h.visible(el) && CONFIRM_TEXT.test(trim(el.textContent))
      && !Array.from(el.children).some(child => CONFIRM_TEXT.test(trim(child.textContent))));
    return found.length === 1 ? found[0] : null;
  }
  // minOptions：只是点开时至少 2 条，免得把页面的校验提示当成弹层；已经输入了搜索词时 1 条建议也算。
  // 装着单选、勾选的区域多半是旁边的另一道题（点开下拉时它可能因为校验样式变化被记下）：
  // 只有浮在页面上的层（自己或外层是 absolute / fixed 定位，真正的弹层、日历都是）才可能是弹层。
  const CHOICE_SELECTOR = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="radiogroup"], [class*="radio-group" i], [class*="radiogroup" i], [class*="checkbox-group" i]';
  function neighbourQuestion(node, h) {
    if (!Array.from(node.querySelectorAll(CHOICE_SELECTOR)).some(el => h.visible(el) || el.closest('label, [class*="radio" i], [class*="checkbox" i]'))) return false;
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const position = current.ownerDocument.defaultView.getComputedStyle(current).position;
      if (position === 'absolute' || position === 'fixed') return false;
    }
    return true;
  }
  function genericPopupFrom(node, info, h, minOptions = 2) {
    if (!node?.isConnected || node.nodeType !== 1 || !h.visible(node) || node.contains(info.root)
      || (info.root.contains(node) && !innerPopup(node, info.root, info.el))) return null;
    if (node.getAttribute('role') === 'alert' || GENERIC_NOISE.test(String(node.className || ''))) return null;
    if (neighbourQuestion(node, h)) return null;
    const list = genericOptions(node, h);
    if (list.length < minOptions) return null;
    // 整页大小的外壳里只取装着全部条目的最小容器，再看它是不是贴着控件。
    let box = list[0].node.parentElement;
    while (box && box !== node && !list.every(option => box.contains(option.node))) box = box.parentElement;
    box = box || node;
    // 贴着控件：弹层外壳或条目列表任意一个与控件左右有重叠、上下重叠或相距 60px 以内。
    // 北森的弹层有时盖住输入框（搜索框占了原位置），有时在下方、列表上面还隔着搜索框。
    const c = info.root.getBoundingClientRect();
    const near = el => {
      const r = el.getBoundingClientRect();
      return r.right > c.left - 16 && r.left < c.right + 16 && r.top <= c.bottom + 60 && r.bottom >= c.top - 60;
    };
    return near(box) || near(node) ? box : null;
  }
  // AntD 3 / ant-design-vue 1.x 没有选项（还在加载）时把加载圈或「暂无数据」做成一个禁用的 role=option 条目，弹层带 --empty。
  function antdNotFound(popup, nodes) {
    if (popup.matches('.ant-select-dropdown--empty')) return true;
    const only = nodes.length === 1 ? nodes[0] : null, text = trim(only?.textContent);
    return Boolean(only?.matches('[aria-disabled="true"], .ant-select-dropdown-menu-item-disabled')
      && (only.querySelector('.ant-empty, .ant-spin') || !text || GENERIC_EMPTY.test(text)));
  }
  // 列表周围的字（见 GENERIC_COUNTER）认弹层时照样算上：左侧还在加载时，点开后只看得到右侧这一栏。
  // 比对和诊断里的「有没有选项」不算它们，免得空列表算成有选项、和同名的真选项撞成歧义。
  function layerWord(option, popup) {
    if (GENERIC_PROMPT.test(option.full)) return true;
    // 列表为空时左侧一栏只剩面包屑，条目往上合并会把它整个装进来：条目里的字全是面包屑的也算。
    const crumb = option.node.querySelector('[class*="breadcrumb" i]');
    if (crumb && trim(crumb.textContent) === option.full) return true;
    for (let node = option.node; node && node !== popup; node = node.parentElement) {
      if (BREADCRUMB_CLASS.test(node.getAttribute('class') || '') || GENERIC_COUNTER.test(trim(node.textContent))) return true;
    }
    return false;
  }
  function options(popup, info, level, h) {
    if (info.library === 'generic') return genericOptions(popup, h).filter(option => !layerWord(option, popup));
    const nodes = optionNodes(popup, info, level).filter(h.visible);
    // 这样的弹层还不是选项列表：按没有选项接着等。
    if (info.library === 'antd' && !info.cascade && antdNotFound(popup, nodes)) return [];
    return nodes.map(node => {
      const label = node.querySelector('.ant-select-item-option-content, .el-cascader-node__label, .arco-cascader-list-item-label') || node;
      const text = info.library === 'aria' && info.cascade ? trim(node.getAttribute('aria-label') || Array.from(node.childNodes)
        .filter(child => child.nodeType !== 1 || !child.matches('[role="group"]')).map(child => child.textContent).join(' ')) : trim(label.textContent);
      return { node, text, value: node.getAttribute('data-value') ?? node.getAttribute('value') ?? text,
        disabled: node.getAttribute('aria-disabled') === 'true' || node.matches('.ant-select-item-option-disabled, .ant-cascader-menu-item-disabled, .is-disabled, .arco-select-option-disabled, .arco-cascader-list-item-disabled, .layui-disabled') || Boolean(node.disabled) };
    });
  }
  function match(list, value, helpers, freeText = false) {
    // 联想输入框：比要填的字短的建议（要填「广州市天河区」，建议「广州市」）不选，交给宿主打入完整的字；
    // 建议包含要填的字（要填「广州」，建议「广州市」）照常选。
    // 去掉短的才选得出来的长建议（要填「广州市天河区」，建议「广州市」「广州市天河区体育西路」）可能是另一个值：照旧算拿不准。
    if (freeText) {
      const target = helpers.normalizeText(value);
      const found = match(list.map(option => {
        const text = helpers.normalizeText(option.text);
        return text.length < target.length && target.includes(text) && helpers.normalizeText(option.value) !== target ? { ...option, disabled: true } : option;
      }), value, helpers);
      return found.option && !match(list, value, helpers).option ? { reason: 'ambiguous_option' } : found;
    }
    const index = helpers.findSelectOptionIndex(list, value);
    if (index < 0) {
      const possible = list.filter(option => !helpers.isPlaceholderOption(option)).filter(option => {
        const text = helpers.normalizeText(option.text), target = helpers.normalizeText(value);
        return text.includes(target) || target.includes(text);
      });
      return { reason: possible.length > 1 ? 'ambiguous_option' : 'no_option_match' };
    }
    // Preserve native first-exact semantics, but never guess between indistinguishable
    // custom choices. Re-running the same resolver without the winner exposes ties.
    const remaining = list.map((option, at) => at === index ? { ...option, disabled: true } : option);
    const another = helpers.findSelectOptionIndex(remaining, value);
    if (another >= 0) {
      const exact = option => [trim(option.value), trim(option.text)].includes(trim(value));
      const normalized = option => [option.value, option.text].some(text => helpers.normalizeText(text) === helpers.normalizeText(value));
      if ((exact(list[index]) && exact(list[another])) || (!exact(list[index]) && normalized(list[index]) && normalized(list[another]))) return { reason: 'ambiguous_option' };
    }
    return { option: list[index] };
  }
  // 插件自己打了字以后的建议（#301 联想框）：只认和要填的字相同的一项。逐字相同（去掉首尾空白）优先，
  // 没有再看归一化后相同（大小写、空格、括号）；包含、被包含都不算。
  function sameOption(list, value, helpers) {
    const usable = list.filter(option => !option.disabled);
    const texts = option => [option.text, option.value, option.full].filter(text => text != null).map(String);
    const exact = usable.filter(option => texts(option).some(text => trim(text) === trim(value)));
    const pool = exact.length ? exact : usable.filter(option => texts(option).some(text => helpers.normalizeText(text) === helpers.normalizeText(value)));
    return pool.length === 1 ? { option: pool[0] } : { reason: pool.length > 1 ? 'ambiguous_option' : 'no_option_match' };
  }
  // #269 日历（北森 phoenix-date-picker、Element el-date-picker 等）：认弹层里写着「2026年」「10月」的年月标题、
  // 年/月/日格子和左右翻页按钮，按 年 → 月 → 日 逐级点；日历自带能打字的日期框时先直接输入。
  // 资料只有年月、日历要选到日时选 1 号，并告诉宿主（dayDefaulted），结果里写明。
  const PRESENT = /^(?:至今|至今在读|今|现在|present|now|till now|to date)$/i;
  const CN_MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  const OTHER_MONTH = /(?:prev|last|next|other|pre)[-_]?month|disabled|outside|out-of/i;
  const pad2 = value => String(value).padStart(2, '0');
  function yearOf(text) { const hit = /^(\d{4})\s*年?$/.exec(trim(text)); return hit ? Number(hit[1]) : 0; }
  function monthOf(text) {
    const value = trim(text), number = /^(\d{1,2})\s*月$/.exec(value), chinese = /^(十一|十二|[一二三四五六七八九十])月$/.exec(value);
    return number ? Number(number[1]) : chinese ? CN_MONTHS.indexOf(chinese[1]) + 1 : 0;
  }
  // 显示文字里第一段日期（组件可能把同一个值显示两遍），按日历精度比。
  function shownDate(text, mode) {
    const hit = /(\d{4})\s*(?:[-/.年]\s*(\d{1,2})\s*(?:[-/.月]\s*(\d{1,2}))?)?/.exec(String(text || ''));
    if (!hit) return '';
    if (mode === 'year') return hit[1];
    if (!hit[2]) return '';
    if (mode === 'month') return `${hit[1]}-${pad2(hit[2])}`;
    return hit[3] ? `${hit[1]}-${pad2(hit[2])}-${pad2(hit[3])}` : '';
  }
  function dateTarget(raw, helpers) {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(helpers.normalizeDateValue(raw, 'date'));
    if (day) return { y: Number(day[1]), m: Number(day[2]), d: Number(day[3]) };
    const month = /^(\d{4})-(\d{2})$/.exec(helpers.normalizeDateValue(raw, 'month'));
    if (month) return { y: Number(month[1]), m: Number(month[2]), d: null };
    const year = yearOf(raw);
    return year ? { y: year, m: null, d: null } : null;
  }
  function calendarView(layer, h) {
    const hasText = el => Boolean(trim(el.textContent));
    const leaves = Array.from(layer.querySelectorAll('*')).filter(el => h.visible(el) && hasText(el) && !Array.from(el.children).some(hasText));
    const inCell = el => Boolean(el.closest('td, [role="gridcell"]'));
    const otherMonth = el => {
      for (let node = el; node && node !== layer; node = node.parentElement) {
        if (OTHER_MONTH.test(String(node.getAttribute?.('class') || ''))) return true;
        if (node.matches?.('td, [role="gridcell"]')) return false;
      }
      return false;
    };
    const cells = (read, keep = () => true) => leaves.filter(el => inCell(el) && read(el.textContent) && keep(el)).map(el => ({ value: read(el.textContent), node: el }));
    const headYear = leaves.find(el => !inCell(el) && yearOf(el.textContent));
    const headMonth = leaves.find(el => !inCell(el) && monthOf(el.textContent));
    const disabledCell = el => {
      for (let node = el; node && node !== layer; node = node.parentElement) {
        if (node.getAttribute?.('aria-disabled') === 'true' || node.hasAttribute?.('disabled')) return true;
        if (node.matches?.('td, [role="gridcell"]')) return false;
      }
      return false;
    };
    const buttons = Array.from(layer.querySelectorAll('[class]')).filter(el => h.visible(el) && !el.closest('td')).map(el => {
      const cls = String(el.getAttribute('class')).toLowerCase();
      const dir = /prev|last|left/.test(cls) ? -1 : /next|right/.test(cls) ? 1 : 0;
      const level = /year|decade|super|d-arrow|double/.test(cls) ? 'year' : /month|arrow/.test(cls) ? 'month' : '';
      return dir && level ? { el, dir, level } : null;
    }).filter(Boolean);
    const input = Array.from(layer.querySelectorAll('input')).find(el => h.visible(el) && !el.readOnly && !el.disabled
      && (/(^|[-_])(?:calendar|date)[-_]?input/i.test(String(el.className || '')) || /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(trim(el.value))));
    const dayOf = text => /^\d{1,2}$/.test(trim(text)) ? Number(trim(text)) : 0;
    return {
      years: cells(yearOf), months: cells(monthOf),
      // 判断是不是日期表看全部格子（今天以后、上下月的灰格也算）；能点的只有本月可选的。
      dayCells: cells(dayOf).length,
      // 8. 用 aria-disabled / disabled 属性标出的不可选日期也不点。
      days: cells(dayOf, el => !otherMonth(el) && !disabledCell(el)),
      headYear: headYear ? yearOf(headYear.textContent) : 0, headYearNode: headYear || null,
      headMonth: headMonth ? monthOf(headMonth.textContent) : 0, headMonthNode: headMonth || null,
      button: (level, dir) => buttons.find(button => button.level === level && button.dir === dir)?.el || null,
      input
    };
  }
  // 输入框被同一道题里的遮罩盖住（#269 智联「离职时间」）：像真人一样点盖在最上面的那个。页面别处的浮层不点。
  function coverOf(trigger, info) {
    const doc = trigger.ownerDocument;
    if (typeof doc.elementFromPoint !== 'function') return null;
    const r = trigger.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const top = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || top === trigger || trigger.contains(top) || top.contains(trigger)) return null;
    let scope = info.root;
    for (let depth = 0; depth < 3 && scope.parentElement; depth += 1) scope = scope.parentElement;
    // 遮罩只是一层透明的东西：有字的、按钮样的都不点（可能是「提交」「删除」之类）。
    if (!scope.contains(top) || top.closest('input, textarea, select, button, a[href], [role="button"]') || trim(top.textContent)) return null;
    return top;
  }
  function calendarNear(info, h) {
    const doc = info.el.ownerDocument, c = info.root.getBoundingClientRect();
    const found = Array.from(doc.querySelectorAll('[class]')).filter(el => CALENDAR_CLASS.test(String(el.getAttribute('class')))
      && h.visible(el) && !el.contains(info.root) && (!info.root.contains(el) || innerPopup(el, info.root, info.el)) && el.querySelector('td, [role="gridcell"]'));
    const outer = found.filter(el => !found.some(other => other !== el && other.contains(el)));
    const near = outer.filter(el => {
      const r = el.getBoundingClientRect();
      return r.right > c.left - 16 && r.left < c.right + 16 && r.top <= c.bottom + 60 && r.bottom >= c.top - 60;
    });
    return near.length === 1 ? near[0] : null;
  }
  async function pickPresent(ctx, h, layer, info) {
    // 日历里自带「至今」选项（勾选框或按钮）才点；没有就交还，由页面上单独的「至今」勾选题去填。
    const marks = Array.from(layer.querySelectorAll('*')).filter(el => h.visible(el) && PRESENT.test(trim(el.textContent))
      && !Array.from(el.children).some(child => PRESENT.test(trim(child.textContent))));
    if (marks.length !== 1) return { reason: 'no_option_match' };
    const target = marks[0].closest('label') || marks[0];
    const reason = h.click(optionTarget(target), ctx, true); if (reason) return { reason };
    const accepted = () => (selectedTexts(info) || []).some(text => PRESENT.test(trim(text))) || isChecked(target);
    const done = await h.waitUntil(ctx, info.el.ownerDocument.documentElement, accepted, Boolean);
    return done.reason ? { reason: done.reason === 'verification_timeout' ? 'selection_not_committed' : done.reason } : { accepted };
  }
  async function pickDate(ctx, raw, h, layer, info) {
    const doc = info.el.ownerDocument;
    // 日历切换年/月时整块重建的：旧面板不在了就在控件旁边重新找一次。
    const current = () => {
      if (layer.isConnected && h.visible(layer)) return layer;
      const again = calendarNear(info, h);
      if (again) layer = again;
      return again;
    };
    if (PRESENT.test(trim(raw))) return pickPresent(ctx, h, layer, info);
    const target = dateTarget(raw, h.helpers);
    if (!target || target.y < 1900 || target.y > 2100) return { reason: 'invalid_date' };
    const modeOf = current => current.dayCells >= 28 ? 'date' : current.months.length >= 12 ? 'month' : current.years.length >= 6 ? 'year' : '';
    // 日历打开有动画（Element 从 0 放大）：格子显示出来才看得出是选日、选月还是选年。
    const shown = await h.waitUntil(ctx, doc.documentElement, () => calendarView(layer, h), current => Boolean(modeOf(current)), 1500);
    if (shown.reason) return { reason: shown.reason === 'verification_timeout' ? 'unsupported_control' : shown.reason };
    let view = shown.value;
    const mode = modeOf(view);
    if (mode !== 'year' && !target.m) return { reason: 'invalid_date' };
    const dayDefaulted = mode === 'date' && !target.d;
    const want = { ...target, d: target.d || 1 };
    const expected = mode === 'date' ? `${want.y}-${pad2(want.m)}-${pad2(want.d)}` : mode === 'month' ? `${want.y}-${pad2(want.m)}` : String(want.y);
    const accepted = () => (selectedTexts(info) || []).some(text => shownDate(text, mode) === expected)
      || (info.el.tagName === 'INPUT' && shownDate(info.el.value, mode) === expected);
    ctx.observed = { ...ctx.observed, popupRole: 'calendar', calendarMode: mode };
    // 1. 日历自带的日期框：按它现有的格式输入、回车。
    if (mode === 'date' && view.input) {
      const input = view.input, sep = input.value.includes('/') ? '/' : '-';
      const reason = h.stop(ctx, true); if (reason) return { reason };
      h.write(input, [want.y, pad2(want.m), pad2(want.d)].join(sep), ctx); h.input(input);
      const View = doc.defaultView;
      for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new View.KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      const typed = await h.waitUntil(ctx, doc.documentElement, accepted, Boolean, 600);
      if (!typed.reason) return { accepted, dayDefaulted };
      if (typed.reason !== 'verification_timeout') return { reason: typed.reason };
      if (!current()) return { reason: 'selection_not_committed' };
    }
    // 2. 逐级点：日期表 → 年份标题 → 年份表 → 月份表 → 日期表。
    for (let step = 0; step < 40; step++) {
      if (!current()) return { reason: 'selection_not_committed' };
      view = calendarView(layer, h);
      let node = null, last = false;
      if (view.dayCells >= 28) {
        if (view.headYear === want.y && view.headMonth === want.m) {
          const hits = view.days.filter(cell => cell.value === want.d);
          node = hits.length === 1 ? hits[0].node : null; last = true;
        } else if (view.headYearNode && view.headYear !== want.y) node = view.headYearNode;
        // 同年不同月：有「上/下一月」就点；没有就点月份标题进月份表，再没有就点年份标题从头走。
        else node = view.button('month', want.y * 12 + want.m < view.headYear * 12 + view.headMonth ? -1 : 1)
          || view.headMonthNode || view.headYearNode;
      } else if (view.months.length >= 12) {
        if (!view.headYear || view.headYear === want.y) {
          const hits = view.months.filter(cell => cell.value === want.m);
          node = hits.length === 1 ? hits[0].node : null; last = mode === 'month';
        } else node = view.button('year', want.y < view.headYear ? -1 : 1) || view.headYearNode;
      } else if (view.years.length >= 6) {
        const hits = view.years.filter(cell => cell.value === want.y);
        if (hits.length === 1) { node = hits[0].node; last = mode === 'year'; }
        else if (!hits.length) node = view.button('year', want.y < Math.min(...view.years.map(cell => cell.value)) ? -1 : 1);
      }
      if (!node) return { reason: 'no_option_match' };
      // 日历的年/月/日表常常都在页面里、只切换显示（Element）：按看得见的内容判断有没有翻过去，不看整块文字。
      const looks = () => {
        if (!current()) return null;
        const seen = calendarView(layer, h);
        return [seen.dayCells, seen.months.length, seen.years.length, seen.headYear, seen.headMonth,
          seen.days.map(cell => cell.value).join(','), seen.years.map(cell => cell.value).join(',')].join('|');
      };
      const before = looks();
      const reason = h.click(node, ctx, last); if (reason) return { reason };
      if (last) break;
      const moved = await h.waitUntil(ctx, doc.documentElement, looks, seen => seen !== null && seen !== before, 1000);
      if (moved.reason) return { reason: moved.reason === 'verification_timeout' ? 'selection_not_committed' : moved.reason };
    }
    const done = await h.waitUntil(ctx, doc.documentElement, accepted, Boolean);
    if (done.reason) return { reason: done.reason === 'verification_timeout' ? 'selection_not_committed' : done.reason };
    return { accepted, dayDefaulted };
  }
  async function perform(ctx, raw, h, state) {
    const info = describe(ctx.entry);
    state.info = info;
    info.requireCommitSignal = info.library === 'aria' && ctx.startedEditable;
    info.requireCascadeSignal = info.library === 'element' && info.cascade && ctx.startedEditable;
    info.freeText = acceptsFreeText(ctx);
    if (!info.root || info.multiple || ctx.hints.multiple === true) return { reason: 'unsupported_control' };
    // 通用路径不做级联：分不清每一列，宁可不填。
    if (info.library === 'generic' && info.cascade) return { reason: 'unsupported_control' };
    const desired = info.cascade ? (Array.isArray(raw) ? raw.map(trim) : trim(raw).split(/\s*(?:\/|>|→)\s*/)) : [trim(raw)];
    if (!desired.length || desired.length > 8 || desired.some(value => !value)) return { reason: 'no_option_match' };
    const safeSearch = input => input?.tagName === 'INPUT' && !input.readOnly && !input.disabled
      && ['text', 'search', 'email', 'tel', 'url'].includes(input.type);
    state.safeSearch = safeSearch;
    if (info.library === 'yui') return await pickYui(ctx, desired[0], h, info, state);
    // 日期（带月份的值、「至今」，或宿主按日期控件交来的）：只在点开的是日历时操作，见 pickDate。
    const dateWanted = info.library === 'generic' && !info.cascade
      && (ctx.kind === 'date' || DATE_VALUE.test(desired[0]) || PRESENT.test(desired[0]));
    // 通用路线：组件上显示的已经就是要填的值（整段或中文部分完全相同），不再点开。
    // 「勾选 + 确定」式弹层右侧的「已选」栏会把已选项再列一遍，点开反而分不清两个同名选项（金发民族）。
    if (info.library === 'generic' && !dateWanted) {
      const sameAsWanted = text => {
        const full = trim(text), [first, ...rest] = full.split(/\s*\/\s*/);
        const primary = rest.length && /^[\x20-\x7e]+$/.test(rest.join('/')) ? first : full;
        return [full, primary].some(value => h.helpers.normalizeText(value) === h.helpers.normalizeText(desired[0]));
      };
      const shownNow = selectedTexts(info);
      if (shownNow?.length === 1 && sameAsWanted(shownNow[0])) return { accepted: () => (selectedTexts(info) || []).length === 1 && sameAsWanted(selectedTexts(info)[0]) };
    }
    const doc = info.el.ownerDocument;
    // 宿主在聚焦之前记下的弹层：有的下拉一聚焦就展开（#269 智联 Element UI），聚焦后再记就把它算成了原有的。
    const before = ctx.popupsBeforeFocus || new Set(popups(doc, h.visible));
    // 通用路径：从点开之前开始记下新加或改了 class/style 的元素，弹层只在这些里找。
    const touched = new Set();
    const View = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (info.library === 'generic' && View?.MutationObserver) {
      state.watch = new View.MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') touched.add(record.target);
          else record.addedNodes.forEach(node => { if (node.nodeType === 1) touched.add(node); });
        }
      });
      state.watch.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    const genericOpened = (minOptions = 2) => {
      const layers = new Map();
      for (const node of touched) {
        const box = genericPopupFrom(node, info, h, minOptions);
        if (box && (!layers.has(box) || node.contains(layers.get(box)))) layers.set(box, node);
      }
      const found = Array.from(layers.keys());
      const outer = found.filter(node => !found.some(other => other !== node && other.contains(node)));
      if (outer.length !== 1) return outer.length > 1 ? { reason: 'ambiguous_popup' } : null;
      // 弹层外壳（北森的搜索框和条目列表是兄弟）：只装着一个输入框时才当作这个下拉的一部分。
      const layer = layers.get(outer[0]);
      const inputs = Array.from(layer.querySelectorAll('input')).filter(input => state.safeSearch(input) && h.visible(input));
      return { popup: outer[0], layer: inputs.length <= 1 ? layer : outer[0] };
    };
    // #301 layui 的选项列表是组件根里的 dl，点输入框时显示（隐藏的原生 select 由它点选项时同步）；
    // 已经展开时再点输入框会收起，所以不再点。
    const layuiList = () => {
      const list = info.library === 'layui' ? info.root.querySelector(':scope > dl') : null;
      return list && h.visible(list) ? list : null;
    };
    const initiallyOwned = ownedPopup(info, h.visible);
    const alreadyOpen = (info.combo.getAttribute('aria-expanded') === 'true' && initiallyOwned.popup) || layuiList();
    const trigger = info.cascade ? info.el : info.library === 'antd' ? info.root.querySelector('.ant-select-selector') || info.root
      : info.library === 'element' ? info.root.querySelector('.el-select__wrapper, .el-input') || info.root
      : info.library === 'arco' ? info.root.querySelector('.arco-select-view') || info.root : info.combo;
    if (!alreadyOpen) { const reason = h.click(info.library === 'generic' ? coverOf(trigger, info) || trigger : trigger, ctx); if (reason) return { reason }; }
    const findOpened = () => {
      if (info.library === 'generic') {
        // 新出现的弹层自己带 role=listbox 一类标记时直接用它，否则按位置和条目认。
        const marked = popups(doc, h.visible).filter(node => !before.has(node) && !node.contains(info.root) && node.querySelector('[role="option"]'));
        return marked.length > 1 ? { reason: 'ambiguous_popup' } : marked.length === 1 ? { popup: marked[0] } : genericOpened();
      }
      if (info.library === 'layui') { const list = layuiList(); return list ? { popup: list } : null; }
      const owned = ownedPopup(info, h.visible);
      if (owned.ambiguous) return { reason: 'ambiguous_popup' };
      if (owned.popup) return { popup: owned.popup };
      // AntD Cascader 4 advertises an aria-controls id that is never mounted.
      // A library adapter may associate one newly opened shell; generic ARIA
      // controls with explicit ids must never fall through to another popup.
      if (owned.hasIds && info.library === 'aria') return null;
      const added = popups(doc, h.visible).filter(node => !before.has(node));
      return added.length > 1 ? { reason: 'ambiguous_popup' } : added.length === 1 ? { popup: added[0] } : null;
    };
    let opened = await h.waitUntil(ctx, doc.documentElement, findOpened, Boolean,
      info.freeText ? Math.min(FREE_TEXT_OPEN_MS, h.timeoutMs ?? FREE_TEXT_OPEN_MS) : undefined);
    // 通用路径和 AntD：点开后没有弹层、输入框又能打字（学校、专业这类边输边搜的下拉）：输入要找的值再等弹层。
    // AntD 的输入框在组件根里（3.x 点开后才显示）；AntD 的 AutoComplete、combobox 模式输入就是改值，不这样做。
    // 联想框（#404 51job 的 el-autocomplete）聚焦后没弹建议：像打字一样输入要填的字，再等它自己的建议框。
    // 一聚焦才展开的日历（Element 日期选择器）：浏览器窗口不在前台时 focus() 不派发事件，补一次 focus 再等。
    // 聚焦时就已经打开的日历不算「新出现」：找贴着这个框、带日期格子的日历面板，正好一个才用。
    if (dateWanted && opened.reason === 'verification_timeout') {
      const open = calendarNear(info, h);
      if (open) opened = { value: { popup: open, layer: open } };
    }
    if (dateWanted && opened.reason === 'verification_timeout' && !h.stop(ctx, true)) {
      const View = doc.defaultView;
      info.el.dispatchEvent(new View.FocusEvent('focus'));
      info.el.dispatchEvent(new View.FocusEvent('focusin', { bubbles: true }));
      opened = await h.waitUntil(ctx, doc.documentElement, () => genericOpened(), Boolean);
    }
    let typedFirst = false, typedAt = 0;
    const typeInto = info.library === 'generic' || info.freeText ? info.el
      : info.library === 'antd' && !info.cascade && !info.root.matches('.ant-select-auto-complete, .ant-select-combobox')
        ? Array.from(info.root.querySelectorAll('input')).find(input => safeSearch(input) && h.visible(input)) : null;
    if (typeInto && !dateWanted && opened.reason === 'verification_timeout' && safeSearch(typeInto) && h.visible(typeInto)) {
      const reason = h.stop(ctx, true); if (reason) return { reason };
      state.searchInput = typeInto; state.searchBefore = typeInto.value; state.query = desired[0];
      if (info.freeText) h.type(typeInto, desired[0], ctx); else { h.write(typeInto, desired[0], ctx); h.input(typeInto); }
      typedFirst = true; typedAt = Date.now();
      opened = await h.waitUntil(ctx, doc.documentElement, info.library === 'generic' ? () => genericOpened(1) : findOpened, Boolean,
        info.freeText ? Math.min(FREE_TEXT_TYPED_MS, h.timeoutMs ?? FREE_TEXT_TYPED_MS) : undefined);
    }
    if (opened.reason) return { reason: opened.reason === 'verification_timeout' ? 'options_not_rendered' : opened.reason };
    if (opened.value.reason) return opened.value;
    let popup = opened.value.popup; ctx.popup = opened.value.layer || popup;
    info.popup = popup;
    const role = popup.getAttribute('role');
    // hasOptions（#301 诊断）在下面读第一层列表时才写，见那里的说明；没读到列表就不写。
    ctx.observed = { library: info.library, popupRole: ['listbox', 'tree', 'menu'].includes(role) ? role : 'component' };
    const multiplePopup = () => popup.getAttribute('aria-multiselectable') === 'true'
      || Boolean(popup.querySelector('[aria-multiselectable="true"]'))
      || (info.library === 'element' && (popup.matches('.el-select-dropdown.is-multiple')
        || Boolean(popup.querySelector('.el-select-dropdown.is-multiple'))));
    if (multiplePopup()) return { reason: 'unsupported_control' };
    // 通用路径点开的是日历（北森 phoenix-date-picker）：格子分不清年月日，不当成选项列表去匹配。
    if (info.library === 'generic' && looksCalendar(ctx.popup, popup, h)) {
      return dateWanted ? await pickDate(ctx, desired[0], h, ctx.popup, info) : { reason: 'unsupported_control' };
    }
    // 要填日期，点开的却不是日历：不按文字去匹配列表。
    if (dateWanted) return { reason: 'unsupported_control' };
    // 通用路径先用弹层自带的搜索框（北森），没有才在下拉自己的输入框里输入（Moka 学校、专业）。
    const candidates = info.library === 'generic' ? [...ctx.popup.querySelectorAll('input'), info.combo, ...info.root.querySelectorAll('input')]
      : [info.combo, ...info.root.querySelectorAll('input'), ...popup.querySelectorAll('input')];
    const searchInput = candidates.find(input => safeSearch(input) && h.visible(input));
    const searchable = !info.cascade && searchInput && (ctx.hints.searchable === true || info.library === 'generic'
      || info.combo.getAttribute('aria-autocomplete') === 'list' || searchInput.getAttribute('aria-autocomplete') === 'list'
      || searchInput.getAttribute('role') === 'searchbox' || searchInput.type === 'search'
      || info.root.matches('.ant-select-show-search') || Boolean(info.root.querySelector('.el-select__wrapper.is-filterable')));
    let searchDone = typedFirst;
    // 点选之前在弹层里见过的所有选项（搜索前后都算），两级选择的判断要用。
    const optionKey = option => option.full ?? option.text;
    const seenOptions = new Set();
    const readOptions = level => {
      if (info.library === 'generic' && !popup.isConnected) {
        const again = genericOpened(searchDone ? 1 : 2);
        if (again?.popup) { popup = again.popup; ctx.popup = again.layer || popup; info.popup = popup; }
      }
      if (!popup.isConnected) {
        const linked = ownedPopup(info, h.visible);
        if (linked.popup && !linked.ambiguous) { popup = linked.popup; ctx.popup = popup; info.popup = popup; }
      }
      // 北森：右侧「已选」栏先画出来，左侧列表还在加载，点开时认到的只是已选栏。
      // 同一个弹层里后来出现了更多条目，就换成装着全部条目的那一层。
      if (info.library === 'generic' && ctx.popup !== popup && ctx.popup?.isConnected && ctx.popup.contains(popup)) {
        const grown = genericPopupFrom(ctx.popup, info, h, searchDone ? 1 : 2);
        if (grown && grown !== popup && grown.contains(popup)) { popup = grown; info.popup = popup; }
      }
      const list = options(popup, info, level, h);
      if (!info.cascade) list.forEach(option => seenOptions.add(optionKey(option)));
      return list;
    };
    // 通用路径：弹层里还显示着加载图标时，列表还没好。靠 opacity: 0 淡出、没有卸载的不算。
    const faded = node => {
      for (let el = node; el && ctx.popup.contains(el); el = el.parentElement) {
        if (parseFloat(el.ownerDocument.defaultView.getComputedStyle(el).opacity) === 0) return true;
      }
      return false;
    };
    const spinnerShown = () => info.library === 'generic' && Boolean(ctx.popup?.isConnected)
      && Array.from(ctx.popup.querySelectorAll('[class]')).some(node => !trim(node.textContent)
        && String(node.getAttribute('class')).split(/\s+/).some(token => LOADING_TOKEN.test(token)) && h.visible(node) && !faded(node));
    const loading = () => info.combo.getAttribute('aria-busy') === 'true' || popup.getAttribute('aria-busy') === 'true' || spinnerShown();
    // 弹层里显示着「暂无数据」一类的空状态；「加载中」还在等，不算。
    const emptyShown = () => [popup, ctx.popup].some(layer => layer?.isConnected && Array.from(layer.querySelectorAll('*')).some(node => {
      const text = trim(node.textContent);
      return GENERIC_EMPTY.test(text) && !GENERIC_LOADING.test(text) && !Array.from(node.children).some(child => trim(child.textContent)) && h.visible(node);
    }));
    // 两级选择（省 → 市，#301）：点了一项后弹层还开着，里面冒出了之前没见过的选项（换成下一级，或多出一列）。
    // 不再往下点，按失败收起弹层，报两级选择不支持。至少多出两项才算，免得把选中后出现的勾、计数当成下一级；
    // 和见过的选项同在一个列表里的不算（搜索框清空后列表回到第一屏或整张列表，「已选」栏的标题和删除）。
    // 要持续 NEXT_LEVEL_MS：收起前重画一下列表、随后显示所选的，不算。联想输入框不是两级选择。
    const layerOptions = () => ctx.popup?.isConnected && h.visible(ctx.popup) ? options(ctx.popup, info, 0, h) : null;
    let shownBefore = null, freshSince = 0;
    const freshLevel = () => {
      if (!shownBefore) return false;
      const list = layerOptions() || [];
      const seen = list.filter(option => shownBefore.has(optionKey(option)));
      return list.filter(option => !shownBefore.has(optionKey(option))
        && !seen.some(other => option.node.parentElement?.contains(other.node))).length >= 2;
    };
    const nextLevel = () => {
      if (!freshLevel()) { freshSince = 0; return false; }
      freshSince = freshSince || Date.now();
      return Date.now() - freshSince >= NEXT_LEVEL_MS;
    };
    // 联想框（#299、#404 51job）不标出选中状态，看框里的字和建议框收没收起（aria-expanded）。
    const collapsed = () => ![info.combo, info.el].some(node => node.getAttribute('aria-expanded') === 'true');
    // 联想框打字后建议框收起、列表是空的，离打字也过了一阵（加载中时建议框开着）：打的字没有建议，不用等满。
    const noSuggestions = list => info.freeText && !list.length && collapsed() && (!popup.isConnected || !h.visible(popup))
      && Date.now() - typedAt >= FREE_TEXT_SETTLE_MS;
    const chosenLabels = [], chosenValues = [];
    for (let level = 0; level < desired.length; level++) {
      // 通用路线：第一次点开时选项常常还在从网站后台加载（金发民族：左侧只有加载图标，右侧「已选」栏已经画出来），
      // 等加载图标消失、列表连续 300ms 不变再判断有没有要的选项；一直在变或一直为空，等满后再改用搜索框。
      const generic = info.library === 'generic';
      const eagerSearch = searchable && !searchDone && !generic;
      let lastSeen = null, steadySince = Date.now();
      const watchOptions = () => {
        const list = readOptions(level), seen = list.map(option => option.full ?? option.text).join('\n');
        if (seen !== lastSeen) { lastSeen = seen; steadySince = Date.now(); }
        return list;
      };
      // AntD 先输入了要找的值：先到的列表可能是输入前的请求晚到的结果。列表里有同名的一项才马上选，否则等满再用最后的列表。
      const typedAntd = typedFirst && !generic;
      const sameName = list => list.some(option => !option.disabled && [option.text, option.value]
        .some(text => h.helpers.normalizeText(text) === h.helpers.normalizeText(desired[level])));
      // 联想框打字后的建议里没有同名的一项：停住一阵再算没有（见 FREE_TEXT_STEADY_MS），不用等满。
      const typedSettled = since => info.freeText && Date.now() - since >= FREE_TEXT_STEADY_MS && Date.now() - typedAt >= FREE_TEXT_SETTLE_MS;
      // 联想框里插件自己打过字：只选同名的一项（见 sameOption）；网页自己先给出的建议照旧（包含要填的字的也选）。
      const pick = items => info.freeText && searchDone ? sameOption(items, desired[level], h.helpers) : match(items, desired[level], h.helpers, info.freeText);
      let ready = await h.waitUntil(ctx, doc.documentElement, generic || typedAntd ? watchOptions : () => readOptions(level),
        list => (!loading() && list.length > 0 && (!generic || Date.now() - steadySince >= 300) && (!typedAntd || sameName(list) || typedSettled(steadySince)))
          || (eagerSearch && list.length === 0) || (typedAntd && noSuggestions(list)));
      if (ready.reason === 'verification_timeout' && (generic && (searchable && !searchDone || lastSeen) || typedAntd && lastSeen)) ready = { value: readOptions(level) };
      if (ready.reason) return { reason: ready.reason === 'verification_timeout' ? info.cascade ? 'cascade_timeout' : 'options_not_rendered' : ready.reason };
      let list = ready.value;
      // 诊断（#301）只记列表里有没有选项，不记项数：省、市分成两个下拉时，市的第一层就是网页按简历里的省加载的
      // （江苏 13 个市、宁夏 5 个）；下面没有市的省（港澳台）列表是空的，这一位照报。
      // 也只看第一层：插件输入过要找的值（含点开前先输入的）、或级联点了上一列之后，列表由简历的值决定。
      if (level === 0 && !searchDone) ctx.observed.hasOptions = list.length > 0;
      let found = pick(list);
      if (searchable && !found.option && found.reason !== 'ambiguous_option' && !searchDone) {
        const reason = h.stop(ctx, true); if (reason) return { reason };
        if (!safeSearch(searchInput)) return { reason: 'unsupported_control' };
        if (!searchInput.isConnected || (!info.root.contains(searchInput) && !popup.contains(searchInput) && !ctx.popup.contains(searchInput))) return { reason: 'element_disconnected' };
        const signature = list.map(option => `${option.value}:${option.text}`).join('\n');
        state.searchInput = searchInput; state.searchBefore = searchInput.value; state.query = desired[level];
        info.requireCommitSignal = info.library === 'aria';
        if (info.freeText) h.type(searchInput, desired[level], ctx); else { h.write(searchInput, desired[level], ctx); h.input(searchInput); }
        searchDone = true; typedAt = Date.now();
        let lastSignature = signature, stableSince = Date.now();
        const updated = await h.waitUntil(ctx, doc.documentElement, () => {
          const current = readOptions(level);
          const next = current.map(option => `${option.value}:${option.text}`).join('\n');
          if (next !== lastSignature) { stableSince = Date.now(); lastSignature = next; }
          return current;
        }, current => !loading() && lastSignature !== signature && current.length > 0
          && (info.freeText ? sameName(current) || typedSettled(stableSince) : Date.now() - stableSince >= 80) || noSuggestions(current));
        // 等满了列表还是空的：搜之前有选项、搜完变空，或弹层写着「暂无数据」一类，就是没有这一项，不报超时。
        if (updated.reason === 'verification_timeout' && !loading() && !readOptions(level).length && (signature || emptyShown())) return { reason: 'no_option_match' };
        if (updated.reason) return { reason: updated.reason === 'verification_timeout' ? 'options_timeout' : updated.reason };
        list = updated.value; found = pick(list);
      }
      if (found.reason) return found;
      // Re-read immediately before activation: async renders can replace an option.
      const latest = pick(readOptions(level));
      if (multiplePopup()) return { reason: 'unsupported_control' };
      if (latest.reason) return latest;
      if (!info.pathNodes) info.pathNodes = [];
      info.pathNodes[level] = latest.option.node;
      const previousChildren = info.cascade ? readOptions(level + 1) : [];
      const parentActive = latest.option.node.getAttribute('aria-expanded') === 'true'
        || latest.option.node.matches('.ant-cascader-menu-item-active, .el-cascader-node.is-active, .arco-cascader-list-item-active');
      // Some cascaders commit parent selections (changeOnSelect/checkStrictly).
      // Every path activation can change component state, even before the leaf.
      const activation = info.library === 'arco' && info.cascade
        ? latest.option.node.querySelector('.arco-cascader-list-item-label') || latest.option.node
        : info.library === 'generic' ? latest.option.target || latest.option.node : latest.option.node;
      if (!info.cascade && !info.freeText) shownBefore = new Set([...seenOptions, ...(layerOptions() || []).map(optionKey)]);
      state.activated = true;
      info.lastChoice = latest.option.node;
      const reason = h.click(activation, ctx, true);
      if (reason) return { reason };
      chosenLabels.push(latest.option.text);
      chosenValues.push(String(latest.option.value));
      if (info.cascade && level < desired.length - 1) {
        const next = await h.waitUntil(ctx, doc.documentElement, () => readOptions(level + 1), children => !loading() && children.length > 0 && (parentActive
          || children.length !== previousChildren.length || children.some((child, index) => child.node !== previousChildren[index]?.node || child.value !== previousChildren[index]?.value || child.text !== previousChildren[index]?.text)));
        if (next.reason) return { reason: next.reason === 'verification_timeout' ? 'cascade_timeout' : next.reason };
      }
    }
    // 联想框（#299、#404 51job）不标出选中状态：点了建议、框里换成这一项、建议框也收起了就算选上。
    // 之后的核对只看框里的字：插件打字引起的建议晚到时建议框会再弹出来。失焦后留不留得住由宿主核对，页面没收下的失焦时会还原。
    const accepted = (picking = true) => {
      const values = selectedTexts(info);
      if (values === null && info.freeText && info.library === 'aria') {
        return chosenLabels.length === 1 && (!picking || collapsed()) && h.helpers.normalizeText(info.el.value) === h.helpers.normalizeText(chosenLabels[0]);
      }
      if (!values || values.length !== chosenLabels.length) return false;
      const hidden = info.library === 'aria' && info.el.tagName === 'INPUT' && (!info.el.readOnly || info.requireCommitSignal)
        ? info.root.querySelectorAll('input[type="hidden"]') : [];
      const explicitLabel = trim(info.combo.getAttribute('aria-valuetext'));
      const expected = hidden.length === 1 && !explicitLabel ? chosenValues : chosenLabels;
      // 通用路径：组件里可能显示整段（「男/Male」）也可能只显示中文部分，两种都认，别的都不算。
      const same = (value, index) => [expected[index], ...(info.library === 'generic' ? [chosenValues[index]] : [])]
        .some(text => h.helpers.normalizeText(value) === h.helpers.normalizeText(text));
      if (!values.every(same)) return false;
      // 在下拉自己的输入框里打过字：框里的字可能只是搜索词。弹层收起来了才算真选上。
      if (info.library === 'generic' && state.searchInput && info.root.contains(state.searchInput)
        && popup.isConnected && h.visible(popup)) return false;
      return true;
    };
    const settled = () => accepted() ? 'accepted' : nextLevel() ? 'next' : '';
    // 「勾选 + 确定」式选择框：点了选项、组件上还没显示出来，就点弹层里唯一的「确定」。
    if (info.library === 'generic') {
      const quick = await h.waitUntil(ctx, doc.documentElement, settled, Boolean, 400);
      if (quick.reason && quick.reason !== 'verification_timeout') return { reason: quick.reason };
      if (quick.value === 'next') return { reason: 'cascade_unsupported' };
      const layer = ctx.popup?.isConnected ? ctx.popup : popup;
      // 已经冒出下一级选项时不点「确定」：只选了第一级就确定，页面会收下半截的值。
      const confirm = quick.reason && !freshLevel() && layer?.isConnected && h.visible(layer) ? confirmButton(layer, h) : null;
      if (confirm) { const reason = h.click(confirm, ctx, true); if (reason) return { reason }; }
    }
    const committed = await h.waitUntil(ctx, doc.documentElement, settled, Boolean);
    if (committed.reason) return { reason: committed.reason === 'verification_timeout' ? 'selection_not_committed' : committed.reason };
    if (committed.value === 'next') return { reason: 'cascade_unsupported' };
    // 联想框里插件打过字：之后才到的建议会再弹出来，由宿主发 Tab 收起（closeSuggestions）。
    return { accepted: () => accepted(false), closeSuggestions: Boolean(info.freeText && searchDone) };
  }
  // #377 YUI 联想框（见 yuiBox）：聚焦、点击都不打开，只在 keyup 后按框里的字查询（SF 停 0.2 秒再查），最多列 10 条；
  // 点 li 才算选中，选中后框里换成这一项、建议框收起（SF 还把 aria-expanded 改回 false）。
  // 只认和要填的字相同的一项，没有就报没有匹配的选项；没点成时由 run 收尾恢复原来的字、按 Esc 收起建议框。
  // 框里已经是要填的字也照样打字再选一次：开了 forceSelection 的，这次没选过就失焦会清空框里的字。
  async function pickYui(ctx, wanted, h, info, state) {
    const el = info.el, doc = el.ownerDocument, View = doc.defaultView;
    const content = yuiBox(el).querySelector('.yui-ac-content') || yuiBox(el);
    const same = text => h.helpers.normalizeText(text) === h.helpers.normalizeText(wanted);
    const items = () => content.isConnected && h.visible(content)
      ? Array.from(content.querySelectorAll('li')).filter(li => h.visible(li) && trim(li.textContent)) : [];
    const collapsed = () => el.getAttribute('aria-expanded') !== 'true' && !items().length;
    // 浏览器窗口不在前台时 focus() 不派发 focus 事件，YUI 没记下聚焦就不显示查询结果：补一个。
    if (!doc.hasFocus?.()) el.dispatchEvent(new View.FocusEvent('focus'));
    const reason = h.stop(ctx, true); if (reason) return { reason };
    state.searchInput = el; state.searchBefore = el.value; state.query = wanted;
    ctx.popup = content;
    h.type(el, wanted, ctx);
    let lastSeen = '', steadySince = Date.now();
    const read = () => {
      const list = items(), seen = list.map(li => trim(li.textContent)).join('\n');
      if (seen !== lastSeen) { lastSeen = seen; steadySince = Date.now(); }
      return list;
    };
    const shown = await h.waitUntil(ctx, doc.documentElement, read,
      list => list.length > 0 && (list.some(li => same(li.textContent)) || Date.now() - steadySince >= 200));
    if (shown.reason && !(shown.reason === 'verification_timeout' && lastSeen)) {
      return { reason: shown.reason === 'verification_timeout' ? 'options_not_rendered' : shown.reason };
    }
    const list = content.querySelector('ul');
    ctx.observed = { library: 'yui', popupRole: list?.getAttribute('role') === 'listbox' ? 'listbox' : 'component' };
    const found = sameOption(items().map(li => ({ node: li, text: trim(li.textContent), value: trim(li.textContent), disabled: false })), wanted, h.helpers);
    if (!found.option) return { reason: found.reason };
    state.activated = true;
    const clicked = h.click(found.option.node, ctx, true); if (clicked) return { reason: clicked };
    const chosen = found.option.text;
    const accepted = () => h.helpers.normalizeText(el.value) === h.helpers.normalizeText(chosen) && collapsed();
    const done = await h.waitUntil(ctx, doc.documentElement, accepted, Boolean);
    return done.reason ? { reason: done.reason === 'verification_timeout' ? 'selection_not_committed' : done.reason } : { accepted };
  }
  // 校验提示、浮动提示（antd 的 form-item-explain、Element 的 form-item__error、role=alert / tooltip）不是建议框。
  // 只看这一块自己和它往上、还没装进输入框的几层：整张表单项标红（ant-form-item-has-error）时里面的建议框照样算。
  const HINT_ROLES = new Set(['alert', 'alertdialog', 'tooltip', 'status', 'log']);
  const HINT_TOKEN = /(?:^|[-_])(?:explain|error|errors|invalid|validate|validation|warning|tooltip|tip|tips|message|help|hint|feedback)(?:$|[-_])/i;
  function hintLayer(node, el) {
    if (node.querySelector('[role="alert"], [role="tooltip"]')) return true;
    for (let current = node; current && current.nodeType === 1 && !current.contains(el); current = current.parentElement) {
      if (HINT_ROLES.has(current.getAttribute('role')) || current.hasAttribute('aria-live')) return true;
      if (String(current.getAttribute('class') || '').split(/\s+/).some(token => HINT_TOKEN.test(token))) return true;
    }
    return false;
  }
  // #301 普通文本框写不进时再打一次字（control-adapters.js 的 text 调用）：大易 hotjob 的学校库、专业库是 antd 输入框加自研的建议框，
  // 框上没有任何下拉标记；打字只是搜索，失焦时没从建议里选就还原。保持焦点、像打字一样输入，等打字后新出现、
  // 贴着这个框的一块（认法同通用下拉，见 genericPopupFrom；校验提示不算），只点和要填的字相同的一项。
  // 点了返回 accepted、没有这样的一块返回 typed（有的框要有按键才收下），宿主都随后失焦、按文本框核对。
  // 有建议框但没有这一项报没有匹配的选项：恢复打字前的字，按 Esc、失焦收起建议框。
  async function suggest(ctx, raw, h) {
    const el = ctx.el, doc = el?.ownerDocument, View = doc?.defaultView;
    const wanted = trim(raw);
    if (el?.tagName !== 'INPUT' || el.readOnly || el.disabled || !['text', 'search'].includes(el.type) || !wanted || !View?.MutationObserver) return {};
    const info = { el, root: el, combo: el, library: 'generic', cascade: false, multiple: false };
    const touched = new Set();
    const watch = new View.MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') touched.add(record.target);
        else record.addedNodes.forEach(node => { if (node.nodeType === 1) touched.add(node); });
      }
    });
    watch.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    const before = String(el.value ?? '');
    let layer = null, undo = false;
    try {
      h.focus(el);
      await new Promise(resolve => setTimeout(resolve, 0));
      const reason = h.stop(ctx, true); if (reason) return { reason };
      h.type(el, wanted, ctx);
      let lastSeen = null, steadySince = Date.now();
      const look = () => {
        const layers = new Map();
        for (const node of touched) {
          if (!node.isConnected || hintLayer(node, el)) continue;
          const box = genericPopupFrom(node, info, h, 1);
          if (box && !hintLayer(box, el) && (!layers.has(box) || node.contains(layers.get(box)))) layers.set(box, node);
        }
        const found = Array.from(layers.keys());
        const outer = found.filter(node => !found.some(other => other !== node && other.contains(node)));
        if (outer.length !== 1) { lastSeen = null; return outer.length > 1 ? { reason: 'ambiguous_popup' } : null; }
        const list = genericOptions(outer[0], h).filter(option => !layerWord(option, outer[0]));
        const seen = list.map(option => option.full).join('\n');
        if (seen !== lastSeen) { lastSeen = seen; steadySince = Date.now(); }
        return { popup: outer[0], layer: layers.get(outer[0]), list };
      };
      const sameIn = list => Boolean(sameOption(list, wanted, h.helpers).option);
      const settled = await h.waitUntil(ctx, doc.documentElement, look,
        seen => Boolean(seen?.popup && seen.list.length && (sameIn(seen.list) || Date.now() - steadySince >= 300)), Math.min(SUGGEST_MS, h.timeoutMs ?? SUGGEST_MS));
      if (settled.reason && settled.reason !== 'verification_timeout') return { reason: settled.reason };
      const seen = settled.value || look();
      if (!seen) return { typed: true };
      undo = true;
      if (seen.reason) return seen;
      layer = seen.layer || seen.popup;
      const found = sameOption(seen.list, wanted, h.helpers);
      if (!found.option) return { reason: found.reason };
      undo = false;
      const why = h.click(found.option.target || found.option.node, ctx, true); if (why) return { reason: why };
      // 点完框里换成这一项（组件可能下一拍才写）。
      const shown = await h.waitUntil(ctx, doc.documentElement, () => String(el.value ?? ''),
        value => h.helpers.normalizeText(value) === h.helpers.normalizeText(found.option.text), POPUP_LEAVE_MS);
      return shown.reason ? { reason: shown.reason === 'verification_timeout' ? 'selection_not_committed' : shown.reason } : { accepted: true };
    } finally {
      watch.disconnect();
      if (undo && !h.stop(ctx)) {
        if (el.isConnected && String(el.value ?? '') === wanted && before !== wanted) { h.write(el, before); h.input(el); }
        el.dispatchEvent(new View.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        h.blur(el);
        const gone = () => !layer?.isConnected || !h.visible(layer);
        if (layer && !gone()) await h.waitUntil(ctx, doc.documentElement, gone, Boolean, ESC_LEAVE_MS);
      }
    }
  }
  async function run(ctx, raw, h) {
    const state = {}; let outcome;
    // 页面异常也按失败收尾（收起弹层、恢复搜索词）；只把固定的原因码交出去。
    try { outcome = await perform(ctx, raw, h, state); } catch { outcome = { reason: 'operation_failed' }; }
    try { return outcome; }
    finally {
      state.watch?.disconnect();
      // Cancellation, user edits and stale bindings forbid further actions,
      // including cleanup. Never undo an attempted semantic selection.
      if (outcome?.reason && !h.stop(ctx)) {
        const input = state.searchInput;
        if (!state.activated && input?.isConnected && state.safeSearch?.(input)
          && (state.info.root.contains(input) || ctx.popup?.contains(input)) && input.value === state.query) {
          h.write(input, state.searchBefore); h.input(input);
        }
        const info = state.info;
        if (info?.root?.contains(info.el.ownerDocument.activeElement) && !h.stop(ctx)) h.blur(info.el);
        // 通用路径失败时收起自己点开的弹层，免得挡住、干扰后面的字段（北森的弹层不关会一直开着）；
        // 两级选择停在第一级时、YUI 联想框没选成时也收起。先在控件自己的输入框上按 Esc（#301 Moka 的弹层只认这里的 Esc，失焦后也认）。
        // Esc 后弹层可能还要淡出一会儿（Moka 约 500ms 才移除），先等它走，最多约 0.6 秒；
        // 过了还开着就在页面空白处按下、松开，不派发 click：网页可能把点了外面当成要保存。关不掉就让它开着。只派发事件，不改页面状态。
        if ((['generic', 'yui'].includes(info?.library) || outcome.reason === 'cascade_unsupported') && ctx.popup?.isConnected && h.visible(ctx.popup) && !h.stop(ctx)) {
          const doc = info.el.ownerDocument, View = doc.defaultView, layer = ctx.popup;
          info.el.dispatchEvent(new View.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
          const left = await h.waitUntil(ctx, doc.documentElement, () => !layer.isConnected || !h.visible(layer), Boolean, ESC_LEAVE_MS);
          if (left.reason === 'verification_timeout' && layer.isConnected && h.visible(layer) && !h.stop(ctx)) {
            for (const [type, Event] of [['pointerdown', View.PointerEvent], ['mousedown', View.MouseEvent], ['pointerup', View.PointerEvent], ['mouseup', View.MouseEvent]]) {
              if (Event) doc.body.dispatchEvent(new Event(type, { bubbles: true }));
            }
          }
        }
      }
      // 通用路径成功、失败都先等自己点开的弹层移除或隐藏（最多约 1 秒）再交还：弹层带退场动画时
      // 一边改 class 一边淡出，下一个相邻的下拉会把它也当成新出现的弹层，报「无法确定控件弹层」（#301 北森）。
      // 看装着选项的那一块：它不见了，外壳就算还在页面上也不会再被认成弹层。
      const own = state.info?.library === 'generic' ? state.info.popup : null;
      const gone = () => !own.isConnected || !h.visible(own);
      if (own && !gone()) await h.waitUntil(ctx, state.info.el.ownerDocument.documentElement, gone, Boolean, POPUP_LEAVE_MS);
    }
  }
  function visiblePopups(target, visible) {
    const doc = describe(target).el?.ownerDocument;
    return doc?.querySelectorAll ? new Set(popups(doc, visible)) : null;
  }
  // 自制单选（#269 北森 phoenix-radio）和通用路线共用：选项怎么点、选中了没有。
  const CHECKED_TOKEN = /(?:^|[-_])checked$/i;
  function optionTarget(node) { return clickTarget(node, el => Boolean(trim(el.textContent))); }
  function isChecked(node) {
    if (node instanceof node.ownerDocument.defaultView.HTMLInputElement) return node.checked;
    return [node, ...node.querySelectorAll('[aria-checked], [class]')].some(el => el.getAttribute('aria-checked') === 'true'
      || String(el.getAttribute('class') || '').split(/\s+/).some(token => CHECKED_TOKEN.test(token)));
  }
  scope.ResumeProCustomControls = { describe, acceptsFreeText, snapshot, hasExistingValue, readSelection, visiblePopups, optionTarget, isChecked, run, suggest };
})(typeof self !== 'undefined' ? self : globalThis);
