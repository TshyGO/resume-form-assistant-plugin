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
      if (ctx.kind === 'radio' && ctx.nodes.some(el => ctx.customRadio ? el instanceof HTMLInputElement : el.type !== 'radio')) return 'unsupported_control';
      if (ctx.kind !== 'radio' && ctx.nodes.some(el => el.disabled)) return 'control_disabled';
      if (['custom-select', 'cascader'].includes(ctx.kind)) {
        const root = scope.ResumeProCustomControls?.describe(ctx.entry).root;
        if (!root?.isConnected || !root.contains(ctx.el)) return 'element_disconnected';
        if (root.getAttribute('aria-disabled') === 'true' || root.matches('.ant-select-disabled, .ant-cascader-disabled, .is-disabled, .arco-select-disabled, .arco-cascader-disabled, .layui-select-disabled')) return 'control_disabled';
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
      // Custom option handlers can change type/form/href during click dispatch.
      // Cancel default activation while still letting selection handlers run.
      // Native checkbox/radio activation keeps its normal toggle behavior.
      const preventDefaultActivation = event => event.preventDefault();
      const cancelDefault = el.tagName === 'BUTTON' || ['custom-select', 'cascader'].includes(ctx.kind);
      if (cancelDefault) el.addEventListener('click', preventDefaultActivation, { capture: true });
      ctx.activating = true;
      // SVG icons (#269 北森的单选圈) have no click(); dispatch the same activation event instead.
      try {
        if (committing) markWrite(ctx);
        if (typeof el.click === 'function') el.click();
        else if (ViewMouseEvent) el.dispatchEvent(new ViewMouseEvent('click', { bubbles: true, cancelable: true }));
      } finally {
        if (cancelDefault) el.removeEventListener('click', preventDefaultActivation, true);
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

    // 框里的字和要填的一样：逐字相同，或宿主认可的同一个值（电话框自己加了空格、短横）。
    function shows(el, expected) {
      const current = String(el.value ?? '');
      return current === expected || Boolean(deps.sameTextValue?.(el, current, expected));
    }

    // shown：联想框点了建议、框里已经是要填的字，只是组件没有标出选中状态（#299 51job）：不再写，按文本框核对。
    async function text(ctx, value, shown = false) {
      if (!deps.runTextLifecycle) return result(false, 'unsupported_control', ctx);
      const previous = String(ctx.el.value ?? '');
      const expected = deps.normalizeText(ctx.el, value);
      const guard = () => !stop(ctx, true);
      const didWrite = () => markWrite(ctx);
      if (!shown && !await deps.runTextLifecycle(ctx.el, String(value ?? ''), false, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
      ctx.acceptedOnce = shows(ctx.el, expected);
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
      if (!verdict.ok && !shown && deps.prefersSequential(ctx.el) && ['value_not_committed', 'value_reverted'].includes(verdict.reason)) {
        if (!await deps.runTextLifecycle(ctx.el, String(value ?? ''), true, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
        const committed = shows(ctx.el, expected);
        await deps.waitTextCommit();
        stopped = stop(ctx);
        if (stopped) return result(false, stopped, ctx);
        verdict = deps.inspectText(ctx.el, expected, committed);
        // 框里显示的是同一个号码（页面改了格式）时不恢复原值。
        if (!verdict.ok && ['value_not_committed', 'value_reverted'].includes(verdict.reason) && !shows(ctx.el, expected) && guard()) {
          write(ctx.el, previous); deps.dispatchTextInput(ctx.el, previous);
          ctx.el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      // 页面还提示无效的也留着复核：提示可能要等后面的字段填完才消（开始 / 结束时间）。
      if (verdict.ok || verdict.reason === 'validation_not_cleared') checks.set(ctx.el, { ctx,
        accepted: () => shows(ctx.el, expected),
        inspect: () => deps.inspectText(ctx.el, expected, true) });
      return result(verdict.ok, verdict.reason, ctx);
    }

    // 联想框按文本框填完：建议框常常还开着，或打字后稍后才弹出（#299 51job），会挡住后面的字段。
    // 给这个框发一个 Tab 键收起它（不点页面，焦点也不动），再按文本框核对一次。
    // Element's autocomplete closes its suggestions on Tab (Element UI 2 and Element Plus alike).
    // The key starts at the box being filled and bubbles like a real one: Element UI 2 listens on the
    // wrapper around the box. Unlike a real Tab it moves no focus and types nothing.
    function pressTab(el) {
      const ViewKeyboardEvent = el.ownerDocument?.defaultView?.KeyboardEvent || (typeof KeyboardEvent === 'function' ? KeyboardEvent : null);
      if (!ViewKeyboardEvent) return;
      el.dispatchEvent(new ViewKeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, which: 9, bubbles: true, cancelable: true }));
    }
    // rc-picker closes when its input loses focus to somewhere outside the picker, and commits
    // nothing when the text did not change. Not Esc: it bubbles to an AntD Modal around the
    // form, which closes on Esc and drops whatever was typed in it. When the page has no focus
    // (一键填写 clicked in the side panel) blur() moves focus without any event, so the
    // focusout React listens for is sent here.
    function leavePicker(el) {
      let left = false;
      const seen = () => { left = true; };
      el.addEventListener('focusout', seen, true);
      try { blur(el); } finally { el.removeEventListener('focusout', seen, true); }
      const View = el.ownerDocument?.defaultView;
      if (!left && View?.FocusEvent && el.ownerDocument.activeElement !== el) el.dispatchEvent(new View.FocusEvent('focusout', { bubbles: true }));
    }

    async function freeText(ctx, value, shown) {
      const typed = await text(ctx, value, shown);
      // Only a filled box gets its suggestions closed; after a failure the page is left alone.
      if (!typed.ok || !ctx.el?.isConnected || stop(ctx)) return typed;
      pressTab(ctx.el);
      const saved = checks.get(ctx.el);
      if (!saved) return typed;
      const again = await verify(ctx, saved.accepted, saved.inspect);
      if (!again.ok && again.reason !== 'validation_not_cleared') checks.delete(ctx.el);
      return again;
    }

    async function operate(target, desiredValue, options = {}) {
      const el = target?.kind === 'element' ? target.element : target;
      const nodes = target?.kind === 'radio' ? target.elements || [] : el ? [el] : [];
      // PR1 accepts the shared hint contract for future adapters. Native types and
      // the actual AntD panel remain authoritative; hints cannot prescribe actions.
      const ctx = { el: nodes[0], nodes, entry: target, options, hints: cleanHints(options.hints), kind: kindOf(target, el), wrote: false, userEdited: false };
      // #269 自制单选组：选项是 div（北森 phoenix-radio），没有 input。
      ctx.customRadio = ctx.kind === 'radio' && nodes.length > 0 && nodes.every(node => !(node instanceof HTMLInputElement));
      if (ctx.customRadio && !scope.ResumeProCustomControls) return result(false, 'unsupported_control', ctx);
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
        if (custom) ctx.popupsBeforeFocus = scope.ResumeProCustomControls.visiblePopups?.(ctx.entry, visible) || null;
        if (!direct) focus(ctx.el);
        await delay(0);
        const afterFocus = stop(ctx, true);
        if (afterFocus) return result(false, afterFocus, ctx);
        let accepted;
        if (custom) {
          const outcome = await scope.ResumeProCustomControls.run(ctx, desiredValue, { helpers, visible, click, stop, write, input, waitUntil, blur });
          // #269 联想输入框（智联学校名称 el-autocomplete）：本来就允许直接输入，建议里没有时按文本框填写并核对。
          // 点了建议、组件没标出选中状态，但框里已经是要填的字（#299）：不算没选上，按文本框核对。
          if (outcome.reason && scope.ResumeProCustomControls.acceptsFreeText(ctx) && !stop(ctx)) {
            const shown = outcome.reason === 'selection_not_committed' && Boolean(deps.normalizeText)
              && String(ctx.el.value ?? '') === deps.normalizeText(ctx.el, desiredValue);
            if (shown || ['no_option_match', 'options_not_rendered', 'options_timeout'].includes(outcome.reason)) return await freeText(ctx, desiredValue, shown);
          }
          if (outcome.reason) return result(false, outcome.reason, ctx);
          accepted = outcome.accepted;
          if (outcome.dayDefaulted) ctx.observed = { ...ctx.observed, dayDefaulted: true };
        } else if (ctx.kind === 'radio' && ctx.customRadio) {
          const custom = scope.ResumeProCustomControls;
          const text = node => String(node.textContent || '').replace(/\s+/g, ' ').trim();
          const disabled = node => node.getAttribute('aria-disabled') === 'true' || /(?:^|[-_])disabled$/i.test(String(node.className || ''))
            || Boolean(node.querySelector('[aria-disabled="true"]'));
          const index = helpers?.findSelectOptionIndex?.(nodes.map(node => ({ value: text(node), text: text(node), disabled: disabled(node) })), desiredValue) ?? -1;
          const chosen = nodes[index];
          if (!chosen) return result(false, 'no_option_match', ctx);
          if (!custom.isChecked(chosen)) { const reason = click(custom.optionTarget(chosen), ctx, true); if (reason) return result(false, reason, ctx); }
          // 只认组件自己标出的选中状态（--checked、aria-checked），并且组里只有这一项选中。
          accepted = () => chosen.isConnected && custom.isChecked(chosen) && nodes.every(node => node === chosen || !custom.isChecked(node));
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
          if (date.dayDefaulted) ctx.observed = { ...ctx.observed, dayDefaulted: true };
          accepted = date.accepted || (() => {
            const display = String(ctx.el.value ?? '');
            // The real Liepin picker displays YYYY年MM月 after calendar commit.
            // Compare the actual panel's date precision, preserving its display format.
            const canonical = date.mode === 'year' ? display.match(/^\s*(\d{4})(?:年)?\s*$/)?.[1]
              : date.mode ? helpers?.normalizeDateValue?.(display, date.mode) : display;
            return canonical === date.expected;
          });
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
        if (verified.ok || verified.reason === 'validation_not_cleared') checks.set(ctx.el, { ctx, accepted, inspect });
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
      if (ctx.entry.pickerType === 'jiandaoyun') return await jdyDate(ctx, raw);
      // #269 只读的日期框（智联 Element 日期选择器）：不能打字，按日历逐级点，和北森的日历共用一套。
      if (ctx.el.readOnly && scope.ResumeProCustomControls?.run) {
        const outcome = await scope.ResumeProCustomControls.run(ctx, raw, { helpers, visible, click, stop, write, input, waitUntil, blur });
        return outcome.reason ? { reason: outcome.reason } : { accepted: outcome.accepted, dayDefaulted: outcome.dayDefaulted };
      }
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
      ctx.observed = { library: 'antd', popupRole: 'calendar' };
      // 页面异常也按失败收尾；只把固定的原因码交出去。
      const picked = await antDatePick(ctx, raw, popup).catch(() => ({ reason: 'operation_failed' }));
      // 选不成时收起自己点开的日历，免得挡住后面的字段：让输入框失焦（见 leavePicker），组件里的值不变。
      // 不按键、不点页面别处；原本就开着的、用户停下或改了内容的不动。
      // 刚在日历里按下过鼠标时，rc-picker 到下一帧才认失焦，这一次它不收：0.1 秒内没开始收起就再失焦一次。
      // 收起有约 0.2 秒的动画，最多等 0.6 秒它走完再交还，免得再点开同一个日历时把还在淡出的它当成原本就开着的。
      if (picked.reason && !before.has(popup) && !stop(ctx) && popup.isConnected && visible(popup)) {
        const gone = () => !popup.isConnected || !visible(popup);
        leavePicker(ctx.el);
        const leaving = await waitUntil(ctx, doc.documentElement, () => gone() || Array.from(popup.classList).some(token => /-leave$/.test(token)), Boolean, 100);
        if (leaving.reason === 'verification_timeout' && !stop(ctx)) leavePicker(ctx.el);
        await waitUntil(ctx, doc.documentElement, gone, Boolean, 600);
      }
      return picked;
    }
    async function antDatePick(ctx, raw, popup) {
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

    // #301 简道云日期框（.fx-form-datetime .x-datetime）：框里能打字，日历跟着跳到打的日子；可它要等日历收起
    // （点日子、点框外面）才把日历指着的日子交给表单。只打字再失焦（#399），日历一直开着，表单里要等用户下次点别处才有值，
    // 框里又改成了组件自己的格式（出生年月 1999-05-12 → 1999-05），按字面核对就报 value_reverted。
    // 做法：点开日历，看它选日、选月还是选年（带时间的不处理）；按资料的精度打 YYYY-MM-DD / YYYY-MM / YYYY，
    // 日历的年、月和选中的格子对上了，再点那一格：日历自己收起并提交。
    // 选不成时收起自己点开的日历，表单里留原来的值，见 jdyRestore。
    // 不按键：Esc 收起日历但不提交，框里留着打的字，表单里没有。
    function jdyDateParts(raw) {
      const text = String(raw ?? '').trim();
      const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(helpers?.normalizeDateValue?.(text, 'date') || '');
      const month = /^(\d{4})-(\d{2})$/.exec(helpers?.normalizeDateValue?.(text, 'month') || '');
      const year = /^(\d{4})(?:年)?$/.exec(text);
      const parts = day ? { year: day[1], month: day[2], day: day[3] } : month ? { year: month[1], month: month[2], day: '' }
        : year ? { year: year[1], month: '', day: '' } : null;
      if (!parts) return null;
      const y = Number(parts.year), m = Number(parts.month || 1), d = Number(parts.day || 1);
      const date = new Date(y, m - 1, d);
      if (y < 1900 || y > 2100 || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
      return parts;
    }
    const JDY_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    function jdyMonthOf(text) {
      const value = String(text || '').trim().toLowerCase();
      const digits = /^(\d{1,2})/.exec(value);
      if (digits) return Number(digits[1]);
      const index = JDY_MONTHS.findIndex(name => value.startsWith(name));
      return index >= 0 ? index + 1 : 0;
    }
    async function jdyDate(ctx, raw) {
      const doc = ctx.el.ownerDocument;
      const root = ctx.el.closest?.('.fx-form-datetime .x-datetime');
      if (!doc?.querySelectorAll || !root) return { reason: 'unsupported_control' };
      const want = jdyDateParts(raw);
      if (!want) return { reason: 'invalid_date' };
      const popups = () => Array.from(doc.querySelectorAll('.x-popup.x-datetime-content')).filter(visible);
      const before = new Set(popups());
      const original = ctx.el.value;
      const reason = click(ctx.el, ctx); if (reason) return { reason };
      const opened = await waitUntil(ctx, doc.documentElement, () => {
        const added = popups().filter(node => !before.has(node));
        return added.length === 1 ? added[0] : null;
      }, Boolean);
      if (opened.reason) return { reason: opened.reason };
      const popup = opened.value;
      ctx.observed = { library: 'jiandaoyun', popupRole: 'calendar' };
      const picked = await jdyPick(ctx, want, popup).catch(() => ({ reason: 'operation_failed' }));
      if (picked.reason && !stop(ctx) && popup.isConnected && visible(popup)) await jdyRestore(ctx, root, popup, original);
      return picked;
    }
    // 选不成时收起自己点开的日历，表单里留原来的值。框失焦再点框能收起日历，但会把日历指着的日子交给表单，
    // 打过字就是打的那天（#301 评审在真组件上看到）。所以先把日历拨回原来的值再收：框里原来有字就写回去；
    // 原来是空的就点框里的清除按钮，真组件上它收起日历、表单里还是空的（写回空字会被读成 1901-01-01）。
    // 没有清除按钮就只能照旧收起。
    async function jdyRestore(ctx, root, popup, original) {
      const doc = ctx.el.ownerDocument;
      const gone = () => !popup.isConnected || !visible(popup);
      if (ctx.el.value !== original) {
        const clear = !original && root.querySelector('.clear-icon');
        if (original) { write(ctx.el, original, ctx); input(ctx.el); }
        else if (clear && !click(clear, ctx)) await waitUntil(ctx, doc.documentElement, gone, Boolean, 600);
      }
      if (!gone() && !stop(ctx)) {
        blur(ctx.el);
        await delay(0);
        if (!stop(ctx) && !click(root, ctx)) await waitUntil(ctx, doc.documentElement, gone, Boolean, 600);
      }
      // 点清除按钮时框还有焦点，框里的字要等失焦才清掉。
      if (!stop(ctx) && doc.activeElement === ctx.el) blur(ctx.el);
    }
    async function jdyPick(ctx, want, popup) {
      const mode = popup.querySelector('.date-time-picker, .time-body, .week-cell') ? ''
        : popup.querySelector('.date-body .day') ? 'date' : popup.querySelector('.date-month') ? 'month' : popup.querySelector('.date-year') ? 'year' : '';
      if (!mode) return { reason: 'unsupported_control' };
      // 资料只有年份，日历要选到月或日：不替用户编月份。
      if (mode !== 'year' && !want.month) return { reason: 'invalid_date' };
      const text = want.day ? `${want.year}-${want.month}-${want.day}` : want.month ? `${want.year}-${want.month}` : want.year;
      const stopped = stop(ctx, true); if (stopped) return { reason: stopped };
      write(ctx.el, text, ctx); input(ctx.el);
      const year = () => (popup.querySelector('.date-head .btn-year')?.textContent || '').trim();
      const usable = cell => cell && !cell.matches('.disabled, .oday') && !cell.querySelector('.disabled');
      const target = () => {
        if (mode === 'year') {
          const cells = Array.from(popup.querySelectorAll('.date-year .item-cell')).filter(cell => cell.querySelector('.cell-btn.select'));
          return cells.length === 1 && usable(cells[0]) && cells[0].textContent.trim() === want.year ? cells[0] : null;
        }
        if (year() !== want.year) return null;
        if (mode === 'month') {
          const cells = Array.from(popup.querySelectorAll('.date-month .item-cell'));
          const chosen = cells.filter(cell => cell.querySelector('.cell-btn.select'));
          return cells.length === 12 && chosen.length === 1 && cells.indexOf(chosen[0]) === Number(want.month) - 1 && usable(chosen[0]) ? chosen[0] : null;
        }
        if (jdyMonthOf(popup.querySelector('.date-head .btn-month')?.textContent) !== Number(want.month)) return null;
        const days = Array.from(popup.querySelectorAll('.date-body .day.selected'));
        return days.length === 1 && usable(days[0]) && days[0].textContent.trim() === String(Number(want.day || 1)) ? days[0] : null;
      };
      const found = await waitUntil(ctx, popup, target, Boolean);
      // 日历没跳到这一天：多半是超出了表单允许的日期范围。
      if (found.reason) return { reason: found.reason === 'verification_timeout' ? 'no_option_match' : found.reason };
      const why = click(found.value, ctx, true); if (why) return { reason: why };
      const closed = await waitUntil(ctx, popup, () => !popup.isConnected || !visible(popup), Boolean);
      if (closed.reason) return { reason: closed.reason === 'verification_timeout' ? 'selection_not_committed' : closed.reason };
      const expected = mode === 'year' ? want.year : mode === 'month' ? `${want.year}-${want.month}` : `${want.year}-${want.month}-${want.day || '01'}`;
      return { expected, mode, dayDefaulted: mode === 'date' && !want.day };
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
        if (saved.ctx.kind === 'radio' && saved.ctx.nodes.some(node => saved.ctx.customRadio ? node instanceof HTMLInputElement : node.type !== 'radio')) return result(false, 'element_disconnected', saved.ctx);
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
