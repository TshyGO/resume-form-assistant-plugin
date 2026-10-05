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
    const visible = el => Boolean(el && el.isConnected !== false && !el.hidden
      && (deps.isVisible ? deps.isVisible(el) : !el.getBoundingClientRect || el.getBoundingClientRect().height > 0));
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
      if (ctx.kind !== 'radio' && ctx.nodes.some(el => el.disabled)) return 'control_disabled';
      if (ctx.options.isCurrent && !ctx.options.isCurrent()) return 'cancelled';
      if (ctx.userEdited) { ctx.options.beforeWrite?.(true); return 'value_changed'; }
      if (writing && !ctx.wrote && ctx.options.beforeWrite && !ctx.options.beforeWrite()) return 'value_changed';
      return '';
    }
    function write(el, value) {
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
    function click(el, ctx) {
      const reason = stop(ctx, true);
      if (reason) return reason;
      const ViewMouseEvent = el.ownerDocument?.defaultView?.MouseEvent || (typeof MouseEvent === 'function' ? MouseEvent : null);
      const ViewPointerEvent = el.ownerDocument?.defaultView?.PointerEvent || (typeof PointerEvent === 'function' ? PointerEvent : null);
      if (ViewPointerEvent) el.dispatchEvent(new ViewPointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      if (ViewMouseEvent) el.dispatchEvent(new ViewMouseEvent('mousedown', { bubbles: true }));
      // A page handler can replace the target, or a cancellation can happen on mousedown.
      if (stop(ctx, true) || el.isConnected === false) return stop(ctx, true) || 'element_disconnected';
      if (ViewPointerEvent) el.dispatchEvent(new ViewPointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
      if (ViewMouseEvent) el.dispatchEvent(new ViewMouseEvent('mouseup', { bubbles: true }));
      el.click();
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
      const didWrite = () => { ctx.wrote = true; };
      if (!await deps.runTextLifecycle(ctx.el, String(value ?? ''), false, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
      ctx.acceptedOnce = String(ctx.el.value ?? '') === expected;
      await deps.waitTextCommit();
      if (stop(ctx)) return result(false, stop(ctx), ctx);
      let verdict = deps.inspectText(ctx.el, expected, ctx.acceptedOnce);
      if (!verdict.ok && ['validation_not_cleared', 'framework_state_unsynced'].includes(verdict.reason)) {
        if (stop(ctx)) return result(false, stop(ctx), ctx);
        await deps.replayFocusBlur(ctx.el);
        await deps.waitTextCommit();
        if (stop(ctx)) return result(false, stop(ctx), ctx);
        verdict = deps.inspectText(ctx.el, expected, String(ctx.el.value ?? '') === expected);
      }
      if (!verdict.ok && deps.prefersSequential(ctx.el) && ['value_not_committed', 'value_reverted'].includes(verdict.reason)) {
        if (!await deps.runTextLifecycle(ctx.el, String(value ?? ''), true, guard, didWrite)) return result(false, stop(ctx) || 'value_changed', ctx);
        const committed = String(ctx.el.value ?? '') === expected;
        await deps.waitTextCommit();
        if (stop(ctx)) return result(false, stop(ctx), ctx);
        verdict = deps.inspectText(ctx.el, expected, committed);
        if (!verdict.ok && ['value_not_committed', 'value_reverted'].includes(verdict.reason) && guard()) {
          write(ctx.el, previous); deps.dispatchTextInput(ctx.el, previous);
          ctx.el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      return result(verdict.ok, verdict.reason, ctx);
    }

    async function operate(target, desiredValue, options = {}) {
      const el = target?.kind === 'element' ? target.element : target;
      const nodes = target?.kind === 'radio' ? target.elements || [] : el ? [el] : [];
      const ctx = { el: nodes[0], nodes, entry: target, options, hints: cleanHints(options.hints), kind: kindOf(target, el), wrote: false, userEdited: false };
      if (!KINDS.has(ctx.kind) || ['custom-select', 'cascader'].includes(ctx.kind)) return result(false, 'unsupported_control', ctx);
      if (ctx.el && typeof ctx.el === 'object') checks.delete(ctx.el);
      const refused = stop(ctx, true);
      if (refused) return result(false, refused, ctx);
      const track = event => { if (event.isTrusted) ctx.userEdited = true; };
      for (const node of nodes) for (const type of ['input', 'change', 'keydown', 'pointerdown']) node.addEventListener?.(type, track, true);
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
        if (stop(ctx, true)) return result(false, stop(ctx, true), ctx);
        let accepted;
        if (ctx.kind === 'radio') {
          const index = helpers?.findSelectOptionIndex?.(nodes.map(node => ({value:node.value,text:deps.radioLabel?.(node) || node.value,disabled:node.disabled})), desiredValue) ?? -1;
          const chosen = nodes[index];
          if (!chosen) return result(false, 'no_option_match', ctx);
          const reason = click(chosen, ctx); if (reason) return result(false, reason, ctx);
          // Native click selects the radio; this fallback preserves old test/DOM hosts.
          if (!chosen.checked) { chosen.checked = true; input(chosen); }
          accepted = () => chosen.checked === true;
        } else if (ctx.kind === 'checkbox') {
          const value = String(desiredValue).trim().toLowerCase();
          if (!['true', 'false', '1', '0', '是', '否'].includes(value)) return result(false, 'no_option_match', ctx);
          const checked = ['true', '1', '是'].includes(value);
          if (Boolean(ctx.el.checked) !== checked) { const reason = click(ctx.el, ctx); if (reason) return result(false, reason, ctx); }
          accepted = () => Boolean(ctx.el.checked) === checked;
        } else if (ctx.kind === 'native-select') {
          const index = helpers?.findSelectOptionIndex?.(Array.from(ctx.el.options).map(option => ({value:option.value,text:option.text,disabled:option.disabled})), desiredValue) ?? -1;
          if (index < 0) return result(false, 'no_option_match', ctx);
          const chosenValue = ctx.el.options[index].value;
          const chosenText = ctx.el.options[index].text;
          write(ctx.el, chosenValue); ctx.el.selectedIndex = index; input(ctx.el);
          accepted = () => ctx.el.selectedIndex === index && ctx.el.options[index]?.value === chosenValue && ctx.el.options[index]?.text === chosenText;
        } else if (ctx.kind === 'date') {
          const date = await operateDate(ctx, desiredValue);
          if (date.reason) return result(false, date.reason, ctx, date.observed);
          accepted = () => String(ctx.el.value ?? '') === date.expected;
        } else if (ctx.kind === 'contenteditable') {
          const expected = String(desiredValue ?? ''); ctx.el.textContent = expected;
          ctx.el.dispatchEvent(new Event('input', { bubbles: true })); accepted = () => ctx.el.textContent === expected;
        } else {
          const expected = String(desiredValue ?? ''); write(ctx.el, expected); input(ctx.el);
          accepted = () => ctx.el.value === expected;
        }
        ctx.wrote = true; ctx.acceptedOnce = accepted();
        if (!direct) blur(ctx.el);
        const inspect = ctx.kind === 'date' && !direct && deps.inspectText
          ? () => deps.inspectText(ctx.el, String(ctx.el.value ?? ''), true) : null;
        const verified = await verify(ctx, accepted, inspect);
        if (verified.ok) checks.set(ctx.el, { ctx, accepted, inspect });
        return verified;
      } catch {
        // Page exceptions are untrusted and can contain resume data. Only a fixed code escapes.
        return result(false, stop(ctx) || 'operation_failed', ctx);
      } finally {
        for (const node of nodes) for (const type of ['input', 'change', 'keydown', 'pointerdown']) node.removeEventListener?.(type, track, true);
      }
    }

    async function operateDate(ctx, raw) {
      if (['date', 'month', 'datetime-local', 'time', 'week'].includes(ctx.el.type)) {
        const expected = helpers?.normalizeDateValue?.(raw, ctx.el.type) ?? String(raw ?? '');
        if (!expected) return { reason: 'invalid_date' };
        write(ctx.el, expected); input(ctx.el); return { expected };
      }
      // An AntD picker often starts readonly, then opens an editable input. Writing
      // that input does not commit rc-picker state; choose an actual calendar cell.
      if (ctx.entry.pickerType === 'antd') return await antDate(ctx, raw);
      const expected = helpers?.normalizeDateValue?.(raw, ctx.entry.pickerInputType || 'date') ?? String(raw ?? '');
      if (ctx.el.readOnly) return { reason: 'unsupported_control' };
      if (typeof ctx.el.click === 'function') ctx.el.click();
      // Preserve the existing generic/Element picker opening window. Recheck the
      // target and user edits after the page has had time to render its popup.
      await delay(150);
      if (stop(ctx, true)) return { reason: stop(ctx, true) };
      write(ctx.el, expected); input(ctx.el);
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
      const take = async node => {
        if (!node || node.disabled || node.closest?.('.ant-picker-cell-disabled')) return 'no_option_match';
        return click(node.querySelector?.('.ant-picker-cell-inner') || node, ctx);
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
        if (cell) { const why = await take(cell); if (why) return { reason: why }; selected = true; break; }
        const years = Array.from(panel.querySelectorAll('td[title]')).map(node => Number(node.title)).filter(Number.isFinite);
        if (!years.length) return { reason: 'selection_not_committed' };
        const previous = panel.textContent;
        const why = await take(panel.querySelector(year < Math.min(...years) ? '.ant-picker-header-super-prev-btn' : '.ant-picker-header-super-next-btn'));
        if (why) return { reason: why };
        const changed = await waitUntil(ctx, popup, () => panel.textContent, text => text !== previous);
        if (changed.reason) return { reason: changed.reason };
      }
      if (!selected) return { reason: 'verification_timeout' };
      if (mode === 'year') return { expected };
      const leftYear = await waitUntil(ctx, popup, () => popup.querySelector('.ant-picker-year-panel'), panel => !panel);
      if (leftYear.reason) return { reason: leftYear.reason };
      if (mode === 'date' && !popup.querySelector('.ant-picker-month-panel')) {
        const why = await take(popup.querySelector('.ant-picker-month-btn')); if (why) return { reason: why };
        const month = await waitUntil(ctx, popup, () => popup.querySelector('.ant-picker-month-panel'), Boolean);
        if (month.reason) return { reason: month.reason };
      }
      const monthCell = popup.querySelector(`.ant-picker-month-panel td[title="${expected.slice(0, 7)}"]`);
      const monthWhy = await take(monthCell); if (monthWhy) return { reason: monthWhy };
      if (mode === 'date') {
        const day = await waitUntil(ctx, popup, () => popup.querySelector(`.ant-picker-date-panel td[title="${expected}"]`), Boolean);
        if (day.reason) return { reason: day.reason };
        const why = await take(day.value); if (why) return { reason: why };
      }
      return { expected };
    }
    function check(target) {
      const el = target?.kind === 'radio' ? target.elements?.[0] : target?.kind === 'element' ? target.element : target;
      const saved = checks.get(el);
      if (!saved) return null;
      const reason = stop(saved.ctx);
      if (reason) return result(false, reason, saved.ctx);
      if (!saved.accepted()) return result(false, 'value_reverted', saved.ctx);
      const verdict = saved.inspect?.();
      return result(verdict ? verdict.ok : true, verdict?.reason || '', saved.ctx);
    }
    return { operate, check };
  }
  scope.ResumeProControls = { create, cleanHints, controlKinds: Object.freeze(Array.from(KINDS)) };
})(typeof self !== 'undefined' ? self : globalThis);
