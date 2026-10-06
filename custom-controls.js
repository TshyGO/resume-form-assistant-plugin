// DOM-only custom controls. No model-provided selectors, framework internals or
// page code are executed. The host owns write guards, events, waits and verification.
(function attachCustomControls(scope) {
  const ROOTS = '.ant-select, .ant-cascader, .el-select, .el-cascader, .arco-select, .arco-cascader';
  const SHELLS = '.ant-select-dropdown, .ant-cascader-dropdown, .el-select__popper, .el-select-dropdown, .el-cascader__dropdown, .arco-select-popup, .arco-cascader-popup, .arco-trigger-popup';
  const POPUPS = `${SHELLS}, [role="listbox"], [role="tree"]`;
  const trim = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  function describe(target) {
    const el = target?.element || target;
    const root = el?.closest?.(ROOTS) || target?.root || el;
    const library = root?.matches?.('.ant-select, .ant-cascader') ? 'antd'
      : root?.matches?.('.el-select, .el-cascader') ? 'element'
      : root?.matches?.('.arco-select, .arco-cascader') ? 'arco' : 'aria';
    const cascade = target?.controlKind === 'cascader' || root?.matches?.('.ant-cascader, .el-cascader, .arco-cascader');
    const combo = root?.matches?.('[role="combobox"]') ? root : root?.querySelector?.('[role="combobox"]') || el;
    const multiple = combo?.getAttribute?.('aria-multiselectable') === 'true'
      || root?.matches?.('.ant-select-multiple, .el-select--multiple, .arco-select-multiple')
      || Boolean(root?.querySelector?.('.ant-select-selection-overflow, .el-select__tags, .arco-select-view-tag'));
    return { el, root, combo, library, cascade: Boolean(cascade), multiple: Boolean(multiple) };
  }
  function selectedTexts(info) {
    const { root, el, library, cascade } = info;
    if (!root?.isConnected) return null;
    if (library === 'aria' && el.tagName === 'INPUT' && !el.readOnly) {
      const explicit = trim(info.combo.getAttribute('aria-valuetext'));
      if (explicit) return [explicit];
      const hidden = root.querySelectorAll('input[type="hidden"]');
      if (hidden.length === 1) return hidden[0].value ? [String(hidden[0].value)] : [];
      const linked = ownedPopup(info, () => true);
      if (linked.ambiguous) return null;
      const popup = linked.popup || info.popup || root.querySelector('[role="listbox"]');
      if (popup?.isConnected) return Array.from(popup.querySelectorAll('[role="option"][aria-selected="true"]'), node => trim(node.textContent));
      // The input may contain a query even after Escape/blur closed the popup.
      // Without an independent selected-state signal, commitment is unknown.
      return el.value ? null : [];
    }
    const selector = library === 'antd' ? '.ant-select-selection-item'
      : library === 'element' ? '.el-select__selected-item:not(.el-select__input-wrapper):not(.is-transparent), .el-select__tags-text'
      : library === 'arco' ? '.arco-select-view-value, .arco-select-view-tag, .arco-cascader-view-value' : '';
    if (selector) {
      const values = Array.from(root.querySelectorAll(selector), node => trim(node.textContent)).filter(Boolean);
      if (values.length) return cascade ? values.join(' / ').split(/\s*(?:\/|>|→)\s*/).filter(Boolean) : values;
      // Element UI (Vue 2) stores the committed label directly in its readonly input.
      if (library !== 'element' || (!cascade && !el.readOnly)) return [];
    }
    const value = trim(el.tagName === 'INPUT' ? el.value : el.getAttribute('role') === 'combobox' ? el.textContent : '');
    if (!value || /^(请选择|Select|Please select)$/i.test(value)) return [];
    return cascade ? value.split(/\s*(?:\/|>|→)\s*/).filter(Boolean) : [value];
  }
  function snapshot(target) {
    const info = describe(target);
    if (!info.root?.isConnected || !info.el?.isConnected) return null;
    return JSON.stringify({ selection: selectedTexts(info),
      query: info.el.tagName === 'INPUT' && !info.el.readOnly ? String(info.el.value ?? '') : null });
  }
  function hasExistingValue(target) {
    const info = describe(target), values = selectedTexts(info);
    // A query is existing user input which needs overwrite protection, not
    // evidence of a committed selection. The snapshot tracks it separately.
    return values === null || values.length > 0 || (info.el.tagName === 'INPUT' && !info.el.readOnly && Boolean(info.el.value));
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
    const referenced = Array.from(info.el.ownerDocument.querySelectorAll('[id]')).filter(node => ids.has(node.id));
    const owned = Array.from(new Set(referenced.map(outerPopup).filter(visible)));
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
      : info.library === 'arco' ? '.arco-select-option' : '';
    const real = realSelector ? Array.from(popup.querySelectorAll(realSelector)) : [];
    return real.length ? real : Array.from(popup.querySelectorAll('[role="option"]'));
  }
  function options(popup, info, level, h) {
    return optionNodes(popup, info, level).filter(h.visible).map(node => {
      const label = node.querySelector('.ant-select-item-option-content, .el-cascader-node__label, .arco-cascader-list-item-label') || node;
      const text = info.library === 'aria' && info.cascade ? trim(node.getAttribute('aria-label') || Array.from(node.childNodes)
        .filter(child => child.nodeType !== 1 || !child.matches('[role="group"]')).map(child => child.textContent).join(' ')) : trim(label.textContent);
      return { node, text, value: node.getAttribute('data-value') ?? node.getAttribute('value') ?? text,
        disabled: node.getAttribute('aria-disabled') === 'true' || node.matches('.ant-select-item-option-disabled, .ant-cascader-menu-item-disabled, .is-disabled, .arco-select-option-disabled, .arco-cascader-list-item-disabled') || Boolean(node.disabled) };
    });
  }
  function match(list, value, helpers) {
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
  async function perform(ctx, raw, h, state) {
    const info = describe(ctx.entry);
    state.info = info;
    if (!info.root || info.multiple || ctx.hints.multiple === true) return { reason: 'unsupported_control' };
    const desired = info.cascade ? (Array.isArray(raw) ? raw.map(trim) : trim(raw).split(/\s*(?:\/|>|→)\s*/)) : [trim(raw)];
    if (!desired.length || desired.length > 8 || desired.some(value => !value)) return { reason: 'no_option_match' };
    const doc = info.el.ownerDocument;
    const before = new Set(popups(doc, h.visible));
    const initiallyOwned = ownedPopup(info, h.visible);
    const alreadyOpen = info.combo.getAttribute('aria-expanded') === 'true' && initiallyOwned.popup;
    const trigger = info.cascade ? info.el : info.library === 'antd' ? info.root.querySelector('.ant-select-selector') || info.root
      : info.library === 'element' ? info.root.querySelector('.el-select__wrapper, .el-input') || info.root
      : info.library === 'arco' ? info.root.querySelector('.arco-select-view') || info.root : info.combo;
    if (!alreadyOpen) { const reason = h.click(trigger, ctx); if (reason) return { reason }; }
    const opened = await h.waitUntil(ctx, doc.documentElement, () => {
      const owned = ownedPopup(info, h.visible);
      if (owned.ambiguous) return { reason: 'ambiguous_popup' };
      if (owned.popup) return { popup: owned.popup };
      // AntD Cascader 4 advertises an aria-controls id that is never mounted.
      // A library adapter may associate one newly opened shell; generic ARIA
      // controls with explicit ids must never fall through to another popup.
      if (owned.hasIds && info.library === 'aria') return null;
      const added = popups(doc, h.visible).filter(node => !before.has(node));
      return added.length > 1 ? { reason: 'ambiguous_popup' } : added.length === 1 ? { popup: added[0] } : null;
    }, Boolean);
    if (opened.reason) return { reason: opened.reason === 'verification_timeout' ? 'options_not_rendered' : opened.reason };
    if (opened.value.reason) return opened.value;
    const popup = opened.value.popup; ctx.popup = popup;
    info.popup = popup;
    const role = popup.getAttribute('role');
    ctx.observed = { library: info.library, popupRole: ['listbox', 'tree', 'menu'].includes(role) ? role : 'component', optionCount: 0 };
    const searchInput = info.combo.tagName === 'INPUT' && !info.combo.readOnly ? info.combo
      : info.root.querySelector('input:not([readonly]):not([type="hidden"])');
    const searchable = !info.cascade && searchInput && (ctx.hints.searchable === true
      || info.combo.getAttribute('aria-autocomplete') === 'list' || searchInput.getAttribute('aria-autocomplete') === 'list'
      || info.root.matches('.ant-select-show-search') || Boolean(info.root.querySelector('.el-select__wrapper.is-filterable')));
    let searchDone = false;
    const chosenLabels = [], chosenValues = [];
    for (let level = 0; level < desired.length; level++) {
      const ready = await h.waitUntil(ctx, doc.documentElement, () => options(popup, info, level, h), list => list.length > 0 || (searchable && !searchDone));
      if (ready.reason) return { reason: ready.reason === 'verification_timeout' ? info.cascade ? 'cascade_timeout' : 'options_not_rendered' : ready.reason };
      let list = ready.value;
      let found = match(list, desired[level], h.helpers);
      if (searchable && !found.option && found.reason !== 'ambiguous_option' && !searchDone) {
        const reason = h.stop(ctx, true); if (reason) return { reason };
        const signature = list.map(option => `${option.value}:${option.text}`).join('\n');
        state.searchInput = searchInput; state.searchBefore = searchInput.value; state.query = desired[level];
        h.write(searchInput, desired[level], ctx); h.input(searchInput); searchDone = true;
        let lastSignature = signature, stableSince = Date.now();
        const updated = await h.waitUntil(ctx, doc.documentElement, () => {
          const current = options(popup, info, level, h);
          const next = current.map(option => `${option.value}:${option.text}`).join('\n');
          if (next !== lastSignature) { stableSince = Date.now(); lastSignature = next; }
          return current;
        }, current => lastSignature !== signature && current.length > 0 && Date.now() - stableSince >= 80);
        if (updated.reason) return { reason: updated.reason === 'verification_timeout' ? 'options_timeout' : updated.reason };
        list = updated.value; found = match(list, desired[level], h.helpers);
      }
      ctx.observed.optionCount = Math.min(200, list.length);
      if (found.reason) return found;
      // Re-read immediately before activation: async renders can replace an option.
      const latest = match(options(popup, info, level, h), desired[level], h.helpers);
      if (latest.reason) return latest;
      if (!info.pathNodes) info.pathNodes = [];
      info.pathNodes[level] = latest.option.node;
      const previousChildren = info.cascade ? options(popup, info, level + 1, h) : [];
      const parentActive = latest.option.node.getAttribute('aria-expanded') === 'true'
        || latest.option.node.matches('.ant-cascader-menu-item-active, .el-cascader-node.is-active, .arco-cascader-list-item-active');
      // Some cascaders commit parent selections (changeOnSelect/checkStrictly).
      // Every path activation can change component state, even before the leaf.
      const activation = info.library === 'arco' && info.cascade
        ? latest.option.node.querySelector('.arco-cascader-list-item-label') || latest.option.node : latest.option.node;
      state.activated = true;
      const reason = h.click(activation, ctx, true);
      if (reason) return { reason };
      chosenLabels.push(latest.option.text);
      chosenValues.push(String(latest.option.value));
      if (info.cascade && level < desired.length - 1) {
        const next = await h.waitUntil(ctx, doc.documentElement, () => options(popup, info, level + 1, h), children => children.length > 0 && (parentActive
          || children.length !== previousChildren.length || children.some((child, index) => child.node !== previousChildren[index]?.node || child.value !== previousChildren[index]?.value || child.text !== previousChildren[index]?.text)));
        if (next.reason) return { reason: next.reason === 'verification_timeout' ? 'cascade_timeout' : next.reason };
      }
    }
    const accepted = () => {
      const values = selectedTexts(info);
      if (!values || values.length !== chosenLabels.length) return false;
      const hidden = info.library === 'aria' && info.el.tagName === 'INPUT' && !info.el.readOnly
        ? info.root.querySelectorAll('input[type="hidden"]') : [];
      const expected = hidden.length === 1 ? chosenValues : chosenLabels;
      if (!values.every((value, index) => h.helpers.normalizeText(value) === h.helpers.normalizeText(expected[index]))) return false;
      return true;
    };
    const committed = await h.waitUntil(ctx, doc.documentElement, accepted, Boolean);
    if (committed.reason) return { reason: committed.reason === 'verification_timeout' ? 'selection_not_committed' : committed.reason };
    return { accepted };
  }
  async function run(ctx, raw, h) {
    const state = {}; let outcome;
    try { outcome = await perform(ctx, raw, h, state); return outcome; }
    finally {
      // Cancellation, user edits and stale bindings forbid further actions,
      // including cleanup. Never undo an attempted semantic selection.
      if (outcome?.reason && !h.stop(ctx)) {
        const input = state.searchInput;
        if (!state.activated && input?.isConnected && input.value === state.query) {
          h.write(input, state.searchBefore); h.input(input);
        }
        const info = state.info;
        if (info?.root?.contains(info.el.ownerDocument.activeElement) && !h.stop(ctx)) h.blur(info.el);
      }
    }
  }
  scope.ResumeProCustomControls = { describe, snapshot, hasExistingValue, run };
})(typeof self !== 'undefined' ? self : globalThis);
