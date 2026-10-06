(function attachControls(scope) {
  // These are the shared #219 types. Component libraries are implementation details,
  // never new control kinds or instructions supplied by a model.
  const KINDS = new Set(['text', 'textarea', 'native-select', 'radio', 'checkbox', 'date', 'custom-select', 'cascader', 'contenteditable']);
  function cleanHints(hints) {
    const clean = {};
    if (!hints || typeof hints !== 'object') return clean;
    for (const key of ['searchable', 'multiple']) if (typeof hints[key] === 'boolean') clean[key] = hints[key];
    if (['inline', 'portal'].includes(hints.popup)) clean.popup = hints.popup;
    if (['YYYY-MM-DD', 'YYYY-MM', 'YYYY'].includes(hints.dateFormat)) clean.dateFormat = hints.dateFormat;
    return clean;
  }

  function create(deps = {}) {
    const helpers = deps.helpers || scope.ResumeProAIHelpers;
    const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const settleMs = () => deps.getSettleMs ? deps.getSettleMs() : deps.settleMs ?? 250;
    const checks = new WeakMap();
    const timeoutMs = deps.timeoutMs ?? 2000;
    const visible = el => {
      if (!el || el.isConnected === false || el.hidden || el.classList?.contains('ant-picker-dropdown-hidden')) return false;
      if (deps.isVisible ? deps.isVisible(el) : !el.getBoundingClientRect || el.getBoundingClientRect().height > 0) return true;
      // Liepin's opening motion starts at scale(0): the rendered rect is empty,
      // while the mounted calendar already has layout and can commit selection.
      // Hidden/unmounted parked popups still fail the style/layout checks.
      const css = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
      return Boolean(css && css.display !== 'none' && css.visibility !== 'hidden'
        && el.offsetHeight > 0 && el.offsetWidth > 0);
    };
    const result = (ok, reason, ctx, extra = {}) => ({ ok, reason, observed: {
      ...(KINDS.has(ctx.kind) ? { controlKind: ctx.kind } : {}), connected: ctx.nodes.every(el => el.isConnected !== false),
      rolledBack: reason === 'value_reverted', ...ctx.observed, ...extra
    } });
    function kindOf(entry, el) {
      if (entry?.kind === 'radio') return 'radio';
      if (el instanceof HTMLSelectElement) return 'native-select';
      if (el instanceof HTMLInputElement) {
        if (['file', 'submit', 'button', 'reset', 'image', 'hidden', 'password'].includes(el.type)) return 'unsupported';
        if (['checkbox', 'radio'].includes(el.type)) return el.type;
        if (['date', 'month', 'datetime-local', 'time', 'week'].includes(el.type)) return 'date';
      }
      if (el instanceof HTMLTextAreaElement) return 'textarea';
      if (entry?.controlKind && !KINDS.has(entry.controlKind)) return 'unsupported';
      if (entry?.controlKind) return entry.controlKind;
      if (entry?.pickerType) return 'date';
      if (el instanceof HTMLInputElement) return 'text';
      return el?.isContentEditable ? 'contenteditable' : 'unsupported';
    }
    function stop(ctx, writing = false) {
      if (!ctx.nodes.length || ctx.nodes.some(el => el.isConnected === false)) return 'element_disconnected';
      if (ctx.nodes.some(el => el instanceof HTMLInputElement && ['file', 'password', 'hidden', 'submit', 'reset', 'button', 'image'].includes(el.type))) return 'unsupported_control';
      if (ctx.kind === 'checkbox' && ctx.el.type !== 'checkbox') return 'unsupported_control';
      if (ctx.kind === 'radio' && ctx.nodes.some(el => el.type !== 'radio')) return 'unsupported_control';
      if (ctx.kind !== 'radio' && ctx.nodes.some(el => el.disabled)) return 'control_disabled';
      if (['custom-select', 'cascader'].includes(ctx.kind)) {
        const root = scope.ResumeProCustomControls?.describe(ctx.entry).root;
        if (!root?.isConnected || !root.contains(ctx.el)) return 'element_disconnected';
        if (root.getAttribute('aria-disabled') === 'true' || root.matches('.ant-select-disabled, .ant-cascader-disabled, .is-disabled, .arco-select-disabled, .arco-cascader-disabled')) return 'control_disabled';
      }
      if (ctx.kind === 'date' && ['date', 'month', 'datetime-local', 'time', 'week'].includes(ctx.el.type) && ctx.el.readOnly) return 'unsupported_control';
      if (ctx.options.isCurrent && !ctx.options.isCurrent()) return 'cancelled';
      if (ctx.userEdited) { ctx.options.beforeWrite?.(true); return 'value_changed'; }
      if (writing && !ctx.wrote && ctx.options.beforeWrite && !ctx.options.beforeWrite()) return 'value_changed';
      return '';
    }
    function markWrite(ctx) {
      if (!ctx.wrote) ctx.options.onWrite?.();
      ctx.wrote = true;
    }
    function write(el, value, ctx) {
      if (ctx) markWrite(ctx);
      if (deps.writeValue) return deps.writeValue(el, value);
      const descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      if (descriptor?.set) descriptor.set.call(el, value); else el.value = value;
    }
    function input(el) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function focus(el) { if (deps.focus) deps.focus(el); else el.focus?.(); }
    function blur(el) { if (deps.blur) deps.blur(el); else el.blur?.(); }
    function click(el, ctx, committing = false) {
      const reason = stop(ctx, true);
      if (reason) return reason;
      const disabled = () => el.disabled || Boolean(el.closest?.('[aria-disabled="true"], .ant-select-item-option-disabled, .ant-cascader-menu-item-disabled, .is-disabled, .arco-select-option-disabled, .arco-cascader-list-item-disabled'));
      if (disabled()) return 'control_disabled';
      // ARIA/component markup does not authorize form submission or reset.
      const submits = () => ['BUTTON', 'INPUT'].includes(el.tagName) && ['submit', 'reset', 'image'].includes(el.type)
        && !(el.tagName === 'BUTTON' && !el.hasAttribute('type') && !el.form);
      const navigates = () => Boolean(el.closest?.('a[href], area[href]'));
      if (submits() || navigates()) return 'unsupported_control';
      const ViewMouseEvent = el.ownerDocument?.defaultView?.MouseEvent || (typeof MouseEvent === 'function' ? MouseEvent : null);
      const ViewPointerEvent = el.ownerDocument?.defaultView?.PointerEvent || (typeof PointerEvent === 'function' ? PointerEvent : null);
      // Framework options may commit on pointerdown/mousedown, before click.
      // Account for that attempt before dispatching, preserving native activation.
      if (committing && ['custom-select', 'cascader'].includes(ctx.kind)) markWrite(ctx);
      const dispatch = event => {
        const previous = ctx.activating;
        if (committing && ['custom-select', 'cascader'].includes(ctx.kind)) ctx.activating = true;
        try { el.dispatchEvent(event); } finally { ctx.activating = previous; }
      };
      if (ViewPointerEvent) dispatch(new ViewPointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      if (ViewMouseEvent) dispatch(new ViewMouseEvent('mousedown', { bubbles: true }));
      // A page handler can replace the target, or a cancellation can happen on mousedown.
      const afterPress = stop(ctx, true);
      if (afterPress || el.isConnected === false) return afterPress || 'element_disconnected';
      if (submits() || navigates()) return 'unsupported_control';
      if (disabled()) return 'control_disabled';
      if (ViewPointerEvent) dispatch(new ViewPointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
      if (ViewMouseEvent) dispatch(new ViewMouseEvent('mouseup', { bubbles: true }));
      const beforeActivation = stop(ctx, true);
      if (beforeActivation || el.isConnected === false) return beforeActivation || 'element_disconnected';
      if (submits() || navigates()) return 'unsupported_control';
      if (disabled()) return 'control_disabled';
      // Native activation emits trusted input/change even when .click() itself is
      // synthetic. Exclude only this synchronous activation from user-edit tracking.
      // Button handlers can change type/form ownership during click dispatch.
      // Cancel its default activation while still letting option handlers run.
      const preventButtonDefault = event => event.preventDefault();
      const button = el.tagName === 'BUTTON';
      if (button) el.addEventListener('click', preventButtonDefault, { capture: true });
      ctx.activating = true;
      try { if (committing) markWrite(ctx); el.click(); } finally {
        if (button) el.removeEventListener('click', preventButtonDefault, true);
        ctx.activating = false;
      }
      return '';
    }
    // Observe the relevant subtree and also sample properties: .value/.checked changes
    // do not necessarily produce DOM mutations. Both waits have a hard deadline.
    function waitUntil(ctx, root, read, ready, limit = timeoutMs) {
      return new Promise(resolve => {
        const start = now(); let timer, observer, finished = false;
        const done = answer => { if (finished) return; finished = true; clearTimeout(timer); observer?.disconnect(); resolve(answer); };
        const check = () => { try {
          const reason = stop(ctx);
          if (reason) return done({ reason });
          const value = read();
          if (ready(value)) return done({ value });
          if (now() - start >= limit) return done({ reason: 'verification_timeout' });
          clearTimeout(timer); timer = setTimeout(check, 20);
        } catch { done({ reason: 'operation_failed' }); }
        };
        const Observer = root?.ownerDocument?.defaultView?.MutationObserver || (typeof MutationObserver === 'function' ? MutationObserver : null);
        if (Observer && root) { observer = new Observer(check); observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); }
        check();
      });
    }
    async function verify(ctx, accepted, inspect) {
      let stableStart = now(); let previous = null;
      const answer = await waitUntil(ctx, ctx.el.parentElement || ctx.el, () => {
        const same = accepted();
        const verdict = same && inspect ? inspect() : null;
        const signature = `${same}:${verdict?.reason || ''}`;
        if (signature !== previous) { stableStart = now(); previous = signature; }
        return { same, verdict };
      }, () => now() - stableStart >= settleMs(), Math.max(timeoutMs, settleMs() + 100));
      if (answer.reason) return result(false, answer.reason, ctx);
      if (!answer.value.same) return result(false, ctx.acceptedOnce ? 'value_reverted' : 'value_not_committed', ctx);
      if (answer.value.verdict && !answer.value.verdict.ok) return result(false, answer.value.verdict.reason, ctx);
      return result(true, '', ctx);
    }

    async function text(ctx, value) {
      if (!deps.runTextLifecycle) return result(false, 'unsupported_control', ctx);
      const previous = String(ctx.el.value ?? '');
      const expected = deps.normalizeText(ctx.el, value);
      const guard = () => !stop(ctx, true);
      const didWrite = () => markWrite(ctx);
      if (!await deps.runTextLifecycle(ctx.el, String(value ?? ''), false, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
      ctx.acceptedOnce = String(ctx.el.value ?? '') === expected;
      await deps.waitTextCommit();
      let stopped = stop(ctx);
      if (stopped) return result(false, stopped, ctx);
      let verdict = deps.inspectText(ctx.el, expected, ctx.acceptedOnce);
      if (!verdict.ok && ['validation_not_cleared', 'framework_state_unsynced'].includes(verdict.reason)) {
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        await deps.replayFocusBlur(ctx.el);
        await deps.waitTextCommit();
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        verdict = deps.inspectText(ctx.el, expected, String(ctx.el.value ?? '') === expected);
      }
      if (!verdict.ok && deps.prefersSequential(ctx.el) && ['value_not_committed', 'value_reverted'].includes(verdict.reason)) {
        if (!await deps.runTextLifecycle(ctx.el, String(value ?? ''), true, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
        const committed = String(ctx.el.value ?? '') === expected;
        await deps.waitTextCommit();
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        verdict = deps.inspectText(ctx.el, expected, committed);
        if (!verdict.ok && ['value_not_committed', 'value_reverted'].includes(verdict.reason) && guard()) {
          write(ctx.el, previous); deps.dispatchTextInput(ctx.el, previous);
          ctx.el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (verdict.ok) checks.set(ctx.el, { ctx,
        accepted: () => String(ctx.el.value ?? '') === expected,
        inspect: () => deps.inspectText(ctx.el, expected, true) });
      return result(verdict.ok, verdict.reason, ctx);
    }

    async function operate(target, desiredValue, options = {}) {
      const el = target?.kind === 'element' ? target.element : target;
      const nodes = target?.kind === 'radio' ? target.elements || [] : el ? [el] : [];
      // PR1 accepts the shared hint contract for future adapters. Native types and
      // the actual AntD panel remain authoritative; hints cannot prescribe actions.
      const ctx = { el: nodes[0], nodes, entry: target, options, hints: cleanHints(options.hints), kind: kindOf(target, el), wrote: false, userEdited: false };
      ctx.startedEditable = ctx.el instanceof HTMLInputElement && !ctx.el.readOnly;
      const custom = ['custom-select', 'cascader'].includes(ctx.kind);
      if (!KINDS.has(ctx.kind) || (custom && !scope.ResumeProCustomControls)) return result(false, 'unsupported_control', ctx);
      if (custom) ctx.nodes = Array.from(new Set([...nodes, scope.ResumeProCustomControls.describe(ctx.entry).root].filter(Boolean)));
      if (ctx.el && typeof ctx.el === 'object') checks.delete(ctx.el);
      const refused = stop(ctx, true);
      if (refused) return result(false, refused, ctx);
      const track = event => {
        if (!event.isTrusted || ctx.activating) return;
        if (custom && event.currentTarget === ctx.el.ownerDocument
          && !ctx.entry.root?.contains(event.target) && !ctx.el.contains(event.target) && !ctx.popup?.contains(event.target)) return;
        ctx.userEdited = true;
      };
      const watched = custom ? Array.from(new Set([...nodes, ctx.entry.root].filter(Boolean))) : nodes;
      if (custom && ctx.el.ownerDocument) watched.push(ctx.el.ownerDocument);
      for (const node of watched) for (const type of ['input', 'change', 'keydown', 'pointerdown']) node.addEventListener?.(type, track, true);
      try {
        if (['text', 'textarea'].includes(ctx.kind) && !['range', 'color'].includes(ctx.el.type)) return await text(ctx, desiredValue);
        const direct = ['week', 'range', 'color'].includes(ctx.el.type);
        if (ctx.kind === 'date' && ctx.entry.pickerType === 'antd' && ctx.el.ownerDocument) {
          const doc = ctx.el.ownerDocument;
          ctx.popupsBefore = new Set(Array.from(doc.querySelectorAll('.ant-picker-dropdown')).filter(visible));
          ctx.alreadyOpen = doc.activeElement === ctx.el && ctx.popupsBefore.size === 1;
        }
        if (!direct) focus(ctx.el);
        await delay(0);
        const afterFocus = stop(ctx, true);
        if (afterFocus) return result(false, afterFocus, ctx);
        let accepted;
        if (custom) {
          const outcome = await scope.ResumeProCustomControls.run(ctx, desiredValue, { helpers, visible, click, stop, write, input, waitUntil, blur });
          if (outcome.reason) return result(false, outcome.reason, ctx);
          accepted = outcome.accepted;
        } else if (ctx.kind === 'radio') {
          const index = helpers?.findSelectOptionIndex?.(nodes.map(node => ({value:node.value,text:deps.radioLabel?.(node) || node.value,disabled:node.disabled})), desiredValue) ?? -1;
          const chosen = nodes[index];
          if (!chosen) return result(false, 'no_option_match', ctx);
          const reason = click(chosen, ctx, true); if (reason) return result(false, reason, ctx);
          // A controlled component may reject activation. Never force checked after
          // its handler restored state: DOM assignment would create a false success.
          accepted = () => chosen.checked === true;
        } else if (ctx.kind === 'checkbox') {
          const value = String(desiredValue).trim().toLowerCase();
          if (!['true', 'false', '1', '0', '是', '否'].includes(value)) return result(false, 'no_option_match', ctx);
          const checked = ['true', '1', '是'].includes(value);
          if (Boolean(ctx.el.checked) !== checked) { const reason = click(ctx.el, ctx, true); if (reason) return result(false, reason, ctx); }
          accepted = () => Boolean(ctx.el.checked) === checked;
        } else if (ctx.kind === 'native-select') {
          const index = helpers?.findSelectOptionIndex?.(Array.from(ctx.el.options).map(option => ({value:option.value,text:option.text,disabled:option.disabled})), desiredValue) ?? -1;
          if (index < 0) return result(false, 'no_option_match', ctx);
          const chosenValue = ctx.el.options[index].value;
          const chosenText = ctx.el.options[index].text;
          write(ctx.el, chosenValue, ctx); ctx.el.selectedIndex = index; input(ctx.el);
          accepted = () => ctx.el.selectedIndex === index && ctx.el.options[index]?.value === chosenValue && ctx.el.options[index]?.text === chosenText;
        } else if (ctx.kind === 'date') {
          const date = await operateDate(ctx, desiredValue);
          if (date.reason) return result(false, date.reason, ctx, date.observed);
          accepted = () => {
            const display = String(ctx.el.value ?? '');
            // The real Liepin picker displays YYYY年MM月 after calendar commit.
            // Compare the actual panel's date precision, preserving its display format.
            const canonical = date.mode === 'year' ? display.match(/^\s*(\d{4})(?:年)?\s*$/)?.[1]
              : date.mode ? helpers?.normalizeDateValue?.(display, date.mode) : display;
            return canonical === date.expected;
          };
        } else if (ctx.kind === 'contenteditable') {
          const expected = String(desiredValue ?? ''); markWrite(ctx); ctx.el.textContent = expected;
          ctx.el.dispatchEvent(new Event('input', { bubbles: true })); accepted = () => ctx.el.textContent === expected;
        } else {
          const expected = String(desiredValue ?? ''); write(ctx.el, expected, ctx); input(ctx.el);
          accepted = () => ctx.el.value === expected;
        }
        ctx.acceptedOnce = accepted();
        if (!direct) blur(ctx.el);
        const inspect = ['date', 'custom-select', 'cascader'].includes(ctx.kind) && !direct && deps.inspectText
          ? () => deps.inspectText(ctx.el, String(ctx.el.value ?? ''), true) : null;
        const verified = await verify(ctx, accepted, inspect);
        if (verified.ok) checks.set(ctx.el, { ctx, accepted, inspect });
        return verified;
      } catch {
        // Page exceptions are untrusted and can contain resume data. Only a fixed code escapes.
        return result(false, stop(ctx) || 'operation_failed', ctx);
      } finally {
        for (const node of watched) for (const type of ['input', 'change', 'keydown', 'pointerdown']) node.removeEventListener?.(type, track, true);
      }
    }

    async function operateDate(ctx, raw) {
      if (['date', 'month', 'datetime-local', 'time', 'week'].includes(ctx.el.type)) {
        const expected = helpers?.normalizeDateValue?.(raw, ctx.el.type) ?? String(raw ?? '');
        if (!expected) return { reason: 'invalid_date' };
        write(ctx.el, expected, ctx); input(ctx.el); return { expected };
      }
      // An AntD picker often starts readonly, then opens an editable input. Writing
      // that input does not commit rc-picker state; choose an actual calendar cell.
      if (ctx.entry.pickerType === 'antd') return await antDate(ctx, raw);
      const expected = helpers?.normalizeDateValue?.(raw, ctx.entry.pickerInputType || 'date') ?? String(raw ?? '');
      if (ctx.el.readOnly) return { reason: 'unsupported_control' };
      if (typeof ctx.el.click === 'function') {
        const reason = click(ctx.el, ctx); if (reason) return { reason };
      }
      // Preserve the existing generic/Element picker opening window. Recheck the
      // target and user edits after the page has had time to render its popup.
      await delay(150);
      const afterOpening = stop(ctx, true);
      if (afterOpening) return { reason: afterOpening };
      write(ctx.el, expected, ctx); input(ctx.el);
      return { expected };
    }

    async function antDate(ctx, raw) {
      const doc = ctx.el.ownerDocument;
      if (!doc?.querySelectorAll) return { reason: 'unsupported_control' };
      const before = ctx.popupsBefore || new Set(Array.from(doc.querySelectorAll('.ant-picker-dropdown')).filter(visible));
      const reason = click(ctx.el, ctx); if (reason) return { reason };
      const opened = await waitUntil(ctx, doc.documentElement, () => {
        const all = Array.from(doc.querySelectorAll('.ant-picker-dropdown')).filter(visible);
        const added = all.filter(node => !before.has(node));
        return added.length === 1 ? added[0] : ctx.alreadyOpen && all.length === 1 ? all[0] : null;
      }, popup => Boolean(popup));
      if (opened.reason) return { reason: opened.reason };
      const popup = opened.value;
      ctx.observed = { library: 'antd', optionCount: Math.min(200, popup.querySelectorAll('td').length) };
      if (popup.querySelectorAll('.ant-picker-panel').length !== 1) return { reason: 'unsupported_control' };
      const mode = popup.querySelector('.ant-picker-month-panel') ? 'month' : popup.querySelector('.ant-picker-year-panel') ? 'year' : 'date';
      const expected = mode === 'year' ? String(raw).match(/^\s*(\d{4})(?:年|\b)/)?.[1] : helpers?.normalizeDateValue?.(raw, mode);
      if (!expected || !(mode === 'year' ? /^\d{4}$/ : mode === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(expected)) return { reason: 'invalid_date' };
      const year = Number(expected.slice(0, 4));
      if (year < 1900 || year > 2100) return { reason: 'invalid_date' };
      const take = async (node, committing = false) => {
        if (!node || node.disabled || node.closest?.('.ant-picker-cell-disabled')) return 'no_option_match';
        return click(node.querySelector?.('.ant-picker-cell-inner') || node, ctx, committing);
      };
      if (mode !== 'year') {
        const why = await take(popup.querySelector('.ant-picker-year-btn')); if (why) return { reason: why };
        const panel = await waitUntil(ctx, popup, () => popup.querySelector('.ant-picker-year-panel'), Boolean);
        if (panel.reason) return { reason: panel.reason };
      }
      let selected = false;
      const started = now();
      for (let step = 0; step < 24 && now() - started < timeoutMs; step++) {
        const panel = popup.querySelector('.ant-picker-year-panel');
        if (!panel) return { reason: 'selection_not_committed' };
        const cell = panel.querySelector(`td[title="${year}"]`);
        if (cell) { const why = await take(cell, mode === 'year'); if (why) return { reason: why }; selected = true; break; }
        const years = Array.from(panel.querySelectorAll('td[title]')).map(node => Number(node.title)).filter(Number.isFinite);
        if (!years.length) return { reason: 'selection_not_committed' };
        const previous = panel.textContent;
        const why = await take(panel.querySelector(year < Math.min(...years) ? '.ant-picker-header-super-prev-btn' : '.ant-picker-header-super-next-btn'));
        if (why) return { reason: why };
        const changed = await waitUntil(ctx, popup, () => panel.textContent, text => text !== previous);
        if (changed.reason) return { reason: changed.reason };
      }
      if (!selected) return { reason: 'verification_timeout' };
      if (mode === 'year') return { expected, mode };
      const leftYear = await waitUntil(ctx, popup, () => popup.querySelector('.ant-picker-year-panel'), panel => !panel);
      if (leftYear.reason) return { reason: leftYear.reason };
      if (mode === 'date' && !popup.querySelector('.ant-picker-month-panel')) {
        const why = await take(popup.querySelector('.ant-picker-month-btn')); if (why) return { reason: why };
        const month = await waitUntil(ctx, popup, () => popup.querySelector('.ant-picker-month-panel'), Boolean);
        if (month.reason) return { reason: month.reason };
      }
      const monthCell = popup.querySelector(`.ant-picker-month-panel td[title="${expected.slice(0, 7)}"]`);
      const monthWhy = await take(monthCell, mode === 'month'); if (monthWhy) return { reason: monthWhy };
      if (mode === 'date') {
        const day = await waitUntil(ctx, popup, () => popup.querySelector(`.ant-picker-date-panel td[title="${expected}"]`), Boolean);
        if (day.reason) return { reason: day.reason };
        const why = await take(day.value, true); if (why) return { reason: why };
      }
      return { expected, mode };
    }
    function check(target) {
      const el = target?.kind === 'radio' ? target.elements?.[0] : target?.kind === 'element' ? target.element : target;
      const saved = checks.get(el);
      if (!saved) return null;
      // Cancellation gates new actions, not evidence from a completed operation.
      // This path only reads the final DOM and never invokes write/stop callbacks.
      try {
        if (saved.ctx.nodes.some(node => node.isConnected === false)) return result(false, 'element_disconnected', saved.ctx);
        if (saved.ctx.nodes.some(node => node instanceof HTMLInputElement && ['file', 'password', 'hidden', 'submit', 'reset', 'button', 'image'].includes(node.type))) return result(false, 'element_disconnected', saved.ctx);
        if (saved.ctx.kind === 'radio' && saved.ctx.nodes.some(node => node.type !== 'radio')) return result(false, 'element_disconnected', saved.ctx);
        if (saved.ctx.kind === 'checkbox' && saved.ctx.el.type !== 'checkbox') return result(false, 'element_disconnected', saved.ctx);
        if (kindOf(saved.ctx.entry, saved.ctx.el) !== saved.ctx.kind) return result(false, 'element_disconnected', saved.ctx);
        if (!saved.accepted()) return result(false, 'value_reverted', saved.ctx);
        const verdict = saved.inspect?.();
        return result(verdict ? verdict.ok : true, verdict?.reason || '', saved.ctx);
      } catch {
        return result(false, 'operation_failed', saved.ctx);
      }
    }
    return { operate, check };
  }
  scope.ResumeProControls = { create, cleanHints, controlKinds: Object.freeze(Array.from(KINDS)) };
})(typeof self !== 'undefined' ? self : globalThis);
