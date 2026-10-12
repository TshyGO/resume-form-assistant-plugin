// 侧边栏的模板字段编辑（#273）。草稿规则在 template-fields.js（与桌面共用），这里只管界面：
// 按分类列出字段、改名称/内容/分类、添加、删除前确认、保存与取消、冲突与失败时保留草稿。
// 外观沿用侧栏已有的任务面板（task-panel）、字段分组（field-group）和输入框（job-input）。
(function attachResumeProTemplateEditor(globalScope) {
  const NEW_CATEGORY = "__new__";
  const PENCIL = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  /**
   * deps:
   *   doc            页面的 document
   *   fields         ResumeProTemplateFields
   *   profileApi     ResumeProProfile（填写合并用的同一套字段名归一与「我的信息」展开）
   *   send(message)  发给 background（DESKTOP_RESUME_UPDATE / DESKTOP_OPEN_VIEW）
   *   reload()       重新 resume.read，返回最新的 store（resume-data normalize 的结果）
   *   groupIcon(name)、toast(text)、onOpenChange(open)
   */
  function create(deps) {
    const { doc, fields } = deps;
    const $ = (id) => doc.getElementById(id);
    const el = {
      panel: $("template-editor"), title: $("te-title"), desc: $("te-desc"), exit: $("te-exit"),
      notice: $("te-notice"), noticeText: $("te-notice-text"), noticeAction: $("te-notice-action"),
      form: $("te-form"), groups: $("te-groups"), problems: $("te-problems"), warnings: $("te-warnings"),
      fallback: $("te-fallback"), addToggle: $("te-add-toggle"), add: $("te-add"), addCategory: $("te-add-category"),
      addNewCategory: $("te-add-new-category"), addNewCategoryRow: $("te-add-new-category-row"), addKey: $("te-add-key"),
      addValue: $("te-add-value"), addError: $("te-add-error"), addSubmit: $("te-add-submit"), addClose: $("te-add-close"),
      categoryToggle: $("te-category-toggle"), categoryForm: $("te-category"), categoryName: $("te-category-name"),
      categoryError: $("te-category-error"), categorySubmit: $("te-category-submit"), categoryClose: $("te-category-close"),
      foot: $("te-foot"), result: $("te-result"), resultText: $("te-result-text"), resultExport: $("te-result-export"),
      resultDone: $("te-result-done")
    };
    const state = {
      open: false, phase: "editing", draft: null, base: "", store: null, message: null, notice: null,
      conflict: null, confirmRemove: "", showErrors: false, returnFocus: null
    };

    function profileFields() {
      return deps.profileApi?.profileToResumeFields(state.store?.profile) || [];
    }

    function fallbacks() {
      return fields.profileFallbacks(state.draft, profileFields(), deps.profileApi?.normalizeKey);
    }

    function inProfile(key) {
      const norm = deps.profileApi?.normalizeKey || ((value) => String(value).trim());
      const wanted = norm(key);
      return Boolean(wanted) && profileFields().some((field) => norm(field.key) === wanted && field.value);
    }

    function categoryOptions(selected, { withNew = false } = {}) {
      const options = state.draft.categories.map((name) => `<option value="${escapeHtml(name)}"${name === selected ? " selected" : ""}>${escapeHtml(name)}</option>`);
      if (withNew) options.push(`<option value="${NEW_CATEGORY}">＋ 新建分类…</option>`);
      return options.join("");
    }

    function renderRow(field, errors) {
      const id = escapeHtml(field.id);
      const error = state.showErrors ? errors[field.id] : "";
      const confirming = state.confirmRemove === field.id;
      const name = field.key.trim() || "这个字段";
      const confirm = confirming ? `<div class="te-confirm" role="alert">
          <p>从「${escapeHtml(state.draft.templateName)}」删除「${escapeHtml(name)}」？只影响这份模板，保存后生效。</p>
          ${inProfile(field.key) ? `<p class="te-confirm__note">「我的信息」里还有同名字段，一键填写时仍可能用它；删除模板字段不会删除「我的信息」。</p>` : ""}
          <div class="te-confirm__actions"><button type="button" class="btn-danger" data-te-remove-confirm="${id}">删除</button><button type="button" data-te-remove-keep="${id}">保留</button></div>
        </div>` : "";
      return `<div class="te-row${confirming ? " is-confirming" : ""}" data-field-id="${id}">
        <input class="job-input te-key" data-te-edit="key" data-field-id="${id}" value="${escapeHtml(field.key)}" placeholder="字段名称" aria-label="字段名称" autocomplete="off"${error ? ' aria-invalid="true"' : ""}>
        <textarea class="job-input te-value" data-te-edit="value" data-field-id="${id}" rows="${Math.min(6, Math.max(1, field.value.split("\n").length))}" placeholder="内容" aria-label="「${escapeHtml(name)}」的内容">${escapeHtml(field.value)}</textarea>
        <div class="te-row__foot">
          <select class="job-input te-category" data-te-edit="category" data-field-id="${id}" aria-label="「${escapeHtml(name)}」所属分类">${categoryOptions(field.category)}</select>
          <button type="button" class="te-remove" data-te-remove="${id}" aria-label="删除「${escapeHtml(name)}」">删除</button>
        </div>
        ${error ? `<p class="job-error te-row__error">${escapeHtml(error)}</p>` : ""}
        ${confirm}
      </div>`;
    }

    function renderGroups() {
      const openGroups = new Set(Array.from(el.groups.querySelectorAll(".field-group")).filter((node) => !node.open).map((node) => node.dataset.category));
      const { fieldErrors } = fields.validateDraft(state.draft);
      el.groups.innerHTML = state.draft.categories.map((category) => {
        const rows = state.draft.fields.filter((field) => field.category === category);
        const folded = openGroups.has(category);
        return `<details class="field-group te-group" data-category="${escapeHtml(category)}"${folded ? "" : " open"}>
          <summary><span class="group-icon" aria-hidden="true">${deps.groupIcon ? deps.groupIcon(category) : ""}</span><span class="group-name">${escapeHtml(category)}</span><small>${rows.length} 项</small><span class="field-group__chevron" aria-hidden="true">›</span></summary>
          <div class="field-group__body">
            ${rows.length ? rows.map((field) => renderRow(field, fieldErrors)).join("") : '<p class="te-group__empty">这个分类还没有字段，没有字段的分类不会保存。</p>'}
            <button type="button" class="job-link te-group__add" data-te-add-in="${escapeHtml(category)}">＋ 在「${escapeHtml(category)}」添加字段</button>
          </div>
        </details>`;
      }).join("");
    }

    // 不动输入框的部分：保存按钮上的改动数、整体问题、提醒、删除后仍会用「我的信息」的字段。
    function renderStatus() {
      const check = fields.validateDraft(state.draft);
      const summary = fields.summarizeChanges(state.draft);
      const dirty = fields.isDirty(state.draft);
      const problems = state.showErrors ? [...check.problems] : [];
      if (state.showErrors && Object.keys(check.fieldErrors).length) problems.unshift("有字段需要修改，见标红的输入框。");
      if (state.message) problems.unshift(state.message);
      el.problems.hidden = !problems.length;
      el.problems.textContent = problems.join(" ");
      el.warnings.textContent = check.warnings.join(" ");
      const gone = fallbacks();
      el.fallback.hidden = !gone.length;
      el.fallback.textContent = gone.length
        ? `已删除或改名的${gone.map((key) => `「${key}」`).join("、")}在「我的信息」里仍有同名内容，一键填写时仍可能使用。要彻底停用，请到桌面「我的信息」里修改。`
        : "";
      renderFoot(dirty, summary);
    }

    function footButtons(buttons) {
      el.foot.innerHTML = buttons.map((button) => `<button type="${button.submit ? "submit" : "button"}"${button.className ? ` class="${button.className}"` : ""} data-te-action="${button.action}"${button.disabled ? " disabled" : ""}>${escapeHtml(button.label)}</button>`).join("");
    }

    function renderFoot(dirty, summary) {
      if (state.phase === "saving") {
        footButtons([{ action: "save", label: "正在保存…", className: "btn-primary", disabled: true, submit: true }]);
      } else if (state.phase === "discard") {
        footButtons([
          { action: "discard", label: "放弃修改", className: "btn-danger" },
          { action: "resume", label: "继续编辑" }
        ]);
      } else if (state.phase === "conflict") {
        const buttons = [];
        if (state.conflict?.latest) buttons.push({ action: "load-latest", label: "放弃我的修改，载入最新内容" });
        if (state.conflict?.latest) buttons.push({ action: "overwrite", label: "用我的修改覆盖", className: "btn-danger" });
        if (state.conflict?.gone) buttons.push({ action: "discard", label: "关闭" });
        else buttons.push({ action: "resume", label: "继续编辑" });
        footButtons(buttons);
      } else {
        const changes = fields.describeChanges(summary);
        footButtons([
          { action: "save", label: dirty ? "保存" : "没有修改", className: "btn-primary", disabled: !dirty, submit: true },
          { action: "cancel", label: "取消" }
        ]);
        el.foot.querySelector?.('[data-te-action="save"]')?.setAttribute("title", changes ? `将保存：${changes}` : "还没有修改");
      }
    }

    function renderNotice() {
      const notice = state.phase === "conflict" ? { text: state.conflict.text } : state.notice;
      el.notice.hidden = !notice;
      el.noticeText.textContent = notice?.text || "";
      el.noticeAction.hidden = !notice?.action;
      el.noticeAction.textContent = notice?.action?.label || "";
    }

    function render() {
      el.panel.hidden = !state.open;
      if (!state.open) return;
      const saved = state.phase === "saved";
      el.form.hidden = saved;
      el.result.hidden = !saved;
      el.exit.textContent = saved ? "完成" : "取消";
      el.exit.disabled = state.phase === "saving";
      el.desc.textContent = `正在编辑「${state.draft.templateName}」`;
      renderNotice();
      if (saved) return;
      renderGroups();
      renderStatus();
      // 添加表单里选中的分类（包括「新建分类…」）在重新渲染后保持不变。
      const chosen = el.addCategory.value;
      el.addCategory.innerHTML = categoryOptions(chosen || state.draft.categories[0], { withNew: true });
      if (chosen === NEW_CATEGORY || state.draft.categories.includes(chosen)) el.addCategory.value = chosen;
    }

    function setOpen(open) {
      state.open = open;
      deps.onOpenChange?.(open);
    }

    async function open(store) {
      const template = store?.activeTemplate;
      if (!template) return false;
      state.returnFocus = doc.activeElement || null;
      state.store = store;
      state.draft = fields.createDraft(template);
      state.base = await fields.contentSha256(template.groups);
      Object.assign(state, { phase: "editing", message: null, notice: null, conflict: null, confirmRemove: "", showErrors: false });
      el.add.hidden = true;
      el.categoryForm.hidden = true;
      el.addCategory.value = "";
      setOpen(true);
      render();
      el.title.focus?.();
      return true;
    }

    function close() {
      setOpen(false);
      state.draft = null;
      render();
      const target = state.returnFocus;
      state.returnFocus = null;
      if (target?.isConnected && !target.disabled) target.focus?.();
    }

    function edit(next, { structural = false } = {}) {
      state.draft = next;
      state.message = null;
      if (structural) render();
      else renderStatus();
    }

    // 侧栏每次重新读桌面之后调用：编辑期间另一端动了这份模板，就先说出来，保存时再让人选。
    async function observe(store) {
      if (!state.open || !state.draft) return;
      state.store = store;
      if (state.phase === "saved" || state.phase === "saving" || state.phase === "conflict") { render(); return; }
      const id = state.draft.templateId;
      const exists = (store?.templates || []).some((item) => item.id === id);
      let notice = null;
      if (!exists) {
        notice = { text: "这份模板已在别处删除，修改无法保存。" };
      } else if (store.activeTemplate?.id === id) {
        const latest = await fields.contentSha256(store.activeTemplate.groups);
        if (!state.open || !state.draft || state.draft.templateId !== id) return;
        if (latest !== state.base) notice = { text: "这份模板刚在别处（例如桌面端）更新过。你的修改还在，保存时会请你选择如何处理。", action: { kind: "load-latest", label: "放弃我的修改，载入最新内容" } };
      } else {
        const current = (store.templates || []).find((item) => item.id === store.activeTemplateId);
        notice = { text: `当前模板已切换为「${current?.name || "另一份模板"}」。你仍在编辑「${state.draft.templateName}」，保存只影响它。` };
      }
      state.notice = notice;
      renderNotice();
      renderStatus();
    }

    async function conflictState(store) {
      const id = state.draft.templateId;
      const exists = (store?.templates || []).some((item) => item.id === id);
      if (!exists) return { gone: true, text: "这份模板已在别处删除，修改无法保存。关闭后修改会丢失，需要的话先复制要保留的内容。" };
      if (store.activeTemplate?.id === id) {
        return {
          latest: store.activeTemplate, latestSha: await fields.contentSha256(store.activeTemplate.groups),
          text: "这份模板已在别处修改（例如桌面端），为避免覆盖，这次没有保存。你的修改还在：可以载入最新内容重新编辑，或确认用你的修改覆盖。"
        };
      }
      return { text: "这份模板已在别处修改，但它已不是当前模板，插件读不到最新内容。你的修改还在；可以到桌面查看最新内容后再编辑。" };
    }

    async function save(base = state.base) {
      const check = fields.validateDraft(state.draft);
      if (!check.ok) {
        state.showErrors = true;
        state.message = null;
        render();
        el.groups.querySelector?.('[aria-invalid="true"]')?.focus?.();
        return;
      }
      state.phase = "saving";
      state.message = null;
      render();
      const groups = fields.toGroups(state.draft);
      let result;
      try {
        result = await deps.send({ type: "DESKTOP_RESUME_UPDATE", op: "saveTemplate", templateId: state.draft.templateId, groups, baseSha256: base });
      } catch {
        result = null;
      }
      if (!state.open) return;
      if (result?.status === "ok") {
        const store = await deps.reload().catch(() => null);
        state.store = store || state.store;
        state.phase = "saved";
        const count = groups.reduce((sum, group) => sum + group.fields.length, 0);
        el.resultText.textContent = `已保存「${state.draft.templateName}」，共 ${count} 个字段。填写、搜索和复制会使用新内容。`;
        render();
        el.resultDone.focus?.();
        return;
      }
      if (result?.status === "conflict") {
        // 只有重新读到了桌面的最新数据才让人选「载入最新」或「覆盖」：拿编辑前的旧数据给选项，
        // 「载入最新」载入的会是旧内容，「覆盖」也会用旧起点再撞一次冲突。
        const store = await deps.reload().catch(() => null);
        const conflict = store ? await conflictState(store).catch(() => null) : null;
        if (!state.open) return;
        if (!conflict) {
          state.phase = "editing";
          state.message = "这份模板已在别处修改，但暂时读不到最新内容。修改还在，请稍后再点「保存」。";
          render();
          return;
        }
        state.store = store;
        state.conflict = conflict;
        state.phase = "conflict";
        render();
        el.title.focus?.();
        return;
      }
      state.phase = "editing";
      state.message = {
        secret: "有字段看起来是密码或验证码，这类内容不存进模板。修改还在，删掉或改写后再保存。",
        rejected: "桌面没有接受这次保存（内容不符合要求，或桌面程序版本较旧需要更新）。修改还在。",
        incompatible: "桌面程序版本太旧，请更新桌面后再保存。修改还在。",
        input_too_large: "模板太大，桌面无法保存。修改还在，删掉一些内容后再试。"
      }[result?.status] || "没能保存到桌面（桌面暂时没有响应）。修改还在，稍后再点「保存」。";
      render();
    }

    // 先算出最新内容的摘要，再把草稿和起点一起换掉：要么完整换成最新版本，要么什么都不变。
    async function loadLatest() {
      const latest = state.phase === "conflict" ? state.conflict?.latest : state.store?.activeTemplate;
      if (!latest || latest.id !== state.draft?.templateId) return;
      let sha;
      try {
        sha = await fields.contentSha256(latest.groups);
      } catch {
        deps.toast?.("无法载入最新内容，修改还在。");
        return;
      }
      if (!state.open || state.draft?.templateId !== latest.id) return;
      const name = state.draft.templateName;
      state.draft = fields.createDraft({ ...latest, name: latest.name || name });
      state.base = sha;
      Object.assign(state, { phase: "editing", conflict: null, notice: null, message: null, confirmRemove: "", showErrors: false });
      render();
      deps.toast?.("已载入最新内容。");
    }

    function requestClose() {
      if (state.phase === "saving") return;
      if (state.phase === "saved" || !fields.isDirty(state.draft)) { close(); return; }
      state.phase = "discard";
      render();
      el.foot.querySelector?.('[data-te-action="resume"]')?.focus?.();
    }

    function openAdd(category) {
      el.categoryForm.hidden = true;
      el.add.hidden = false;
      el.addError.hidden = true;
      el.addCategory.innerHTML = categoryOptions(category || state.draft.categories[0], { withNew: true });
      if (!state.draft.categories.length) el.addCategory.value = NEW_CATEGORY;
      el.addNewCategoryRow.hidden = el.addCategory.value !== NEW_CATEGORY;
      el.addKey.focus?.();
    }

    function submitAdd() {
      const key = el.addKey.value.trim();
      let category = el.addCategory.value;
      let draft = state.draft;
      const fail = (text, target) => { el.addError.hidden = false; el.addError.textContent = text; target?.focus?.(); };
      if (category === NEW_CATEGORY) {
        const created = fields.addCategory(draft, el.addNewCategory.value);
        if (created.error) return fail(created.error, el.addNewCategory);
        draft = created.draft;
        category = created.category;
      }
      if (!key) return fail("字段名称不能为空。", el.addKey);
      const added = fields.addField(draft, { category, key, value: el.addValue.value });
      el.addKey.value = "";
      el.addValue.value = "";
      el.addNewCategory.value = "";
      el.addError.hidden = true;
      edit(added.draft, { structural: true });
      el.addCategory.value = category;
      el.addNewCategoryRow.hidden = true;
      el.addKey.focus?.();
      deps.toast?.(`已添加到「${category}」，保存后生效。`);
    }

    function submitCategory() {
      const created = fields.addCategory(state.draft, el.categoryName.value);
      if (created.error) {
        el.categoryError.hidden = false;
        el.categoryError.textContent = created.error;
        el.categoryName.focus?.();
        return;
      }
      el.categoryName.value = "";
      el.categoryError.hidden = true;
      el.categoryForm.hidden = true;
      edit(created.draft, { structural: true });
      const escape = globalScope.CSS?.escape || ((value) => String(value).replace(/["\\]/g, "\\$&"));
      el.groups.querySelector?.(`[data-te-add-in="${escape(created.category)}"]`)?.focus?.();
    }

    // ---- 事件 ----
    el.form.addEventListener("submit", (event) => { event.preventDefault(); if (state.phase === "editing") save(); });
    el.exit.addEventListener("click", () => (state.phase === "saved" ? close() : requestClose()));
    el.resultDone.addEventListener("click", close);
    el.resultExport.addEventListener("click", async () => {
      const result = await deps.send({ type: "DESKTOP_OPEN_VIEW", view: "resume" }).catch(() => null);
      deps.toast?.(result?.status === "ok" ? "已打开桌面「简历」页，在模板详情里点「导出 Excel」。" : "桌面程序暂时无法打开，请检查连接。");
    });
    el.noticeAction.addEventListener("click", () => { if (state.notice?.action?.kind === "load-latest") loadLatest(); });
    el.foot.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-te-action]")?.dataset.teAction;
      if (!action || action === "save") return;
      if (action === "cancel") requestClose();
      else if (action === "discard") close();
      else if (action === "resume") { state.phase = "editing"; state.conflict = null; render(); }
      else if (action === "load-latest") loadLatest();
      else if (action === "overwrite") save(state.conflict.latestSha);
    });
    el.groups.addEventListener("input", (event) => {
      const target = event.target;
      const id = target?.dataset?.fieldId;
      const kind = target?.dataset?.teEdit;
      if (!id || (kind !== "key" && kind !== "value")) return;
      if (kind === "value") target.rows = Math.min(6, Math.max(1, target.value.split("\n").length));
      edit(fields.updateField(state.draft, id, { [kind]: target.value }));
      if (state.showErrors && kind === "key") {
        const error = fields.validateDraft(state.draft).fieldErrors[id];
        if (error) target.setAttribute("aria-invalid", "true");
        else target.removeAttribute("aria-invalid");
      }
    });
    el.groups.addEventListener("change", (event) => {
      const target = event.target;
      if (target?.dataset?.teEdit !== "category") return;
      edit(fields.updateField(state.draft, target.dataset.fieldId, { category: target.value }), { structural: true });
      el.groups.querySelector?.(`select[data-field-id="${target.dataset.fieldId}"]`)?.focus?.();
    });
    el.groups.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button");
      if (!button) return;
      if (button.dataset.teRemove) {
        state.confirmRemove = button.dataset.teRemove;
        render();
        el.groups.querySelector?.(`[data-te-remove-keep="${button.dataset.teRemove}"]`)?.focus?.();
      } else if (button.dataset.teRemoveConfirm) {
        state.confirmRemove = "";
        edit(fields.removeField(state.draft, button.dataset.teRemoveConfirm), { structural: true });
        deps.toast?.("已从草稿中删除，保存后生效。");
      } else if (button.dataset.teRemoveKeep) {
        const id = button.dataset.teRemoveKeep;
        state.confirmRemove = "";
        render();
        el.groups.querySelector?.(`[data-te-remove="${id}"]`)?.focus?.();
      } else if (button.dataset.teAddIn !== undefined) {
        const added = fields.addField(state.draft, { category: button.dataset.teAddIn });
        edit(added.draft, { structural: true });
        el.groups.querySelector?.(`input[data-field-id="${added.id}"]`)?.focus?.();
      }
    });
    el.addToggle.addEventListener("click", () => (el.add.hidden ? openAdd() : (el.add.hidden = true)));
    el.addCategory.addEventListener("change", () => {
      el.addNewCategoryRow.hidden = el.addCategory.value !== NEW_CATEGORY;
      if (!el.addNewCategoryRow.hidden) el.addNewCategory.focus?.();
    });
    el.addSubmit.addEventListener("click", submitAdd);
    el.addClose.addEventListener("click", () => { el.add.hidden = true; el.addToggle.focus?.(); });
    el.categoryToggle.addEventListener("click", () => {
      el.add.hidden = true;
      el.categoryForm.hidden = !el.categoryForm.hidden;
      el.categoryError.hidden = true;
      if (!el.categoryForm.hidden) el.categoryName.focus?.();
    });
    el.categorySubmit.addEventListener("click", submitCategory);
    el.categoryClose.addEventListener("click", () => { el.categoryForm.hidden = true; el.categoryToggle.focus?.(); });
    for (const input of [el.addKey, el.addNewCategory]) {
      input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submitAdd(); } });
    }
    el.categoryName.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submitCategory(); } });
    el.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open && state.phase !== "saving") { event.preventDefault(); requestClose(); }
    });
    el.panel.querySelector?.(".task-icon")?.insertAdjacentHTML?.("afterbegin", PENCIL);

    return { open, observe, close, isOpen: () => state.open, state };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.ResumeProTemplateEditor = api;
})(typeof self !== "undefined" ? self : globalThis);
