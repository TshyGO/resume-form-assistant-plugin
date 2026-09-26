(() => {
  const elements = {
    pageState: document.getElementById("page-state"),
    desktopConnection: document.getElementById("desktop-connection"),
    desktopConnectionText: document.getElementById("desktop-connection-text"),
    desktopConnectionAction: document.getElementById("desktop-connection-action"),
    jobAssist: document.getElementById("job-assist"),
    jobAssistText: document.getElementById("job-assist-text"),
    jobAssistCancel: document.getElementById("job-assist-cancel"),
    templateSelect: document.getElementById("template-select"),
    configState: document.getElementById("config-state"),
    fillButton: document.getElementById("fill-button"),
    cancelButton: document.getElementById("cancel-button"),
    fillResult: document.getElementById("fill-result"),
    profileOffer: document.getElementById("profile-offer"),
    profileOfferText: document.getElementById("profile-offer-text"),
    fillOffer: document.getElementById("fill-offer"),
    fillOfferText: document.getElementById("fill-offer-text"),
    fillOfferSnapshot: document.getElementById("fill-offer-snapshot"),
    desktopStatus: document.getElementById("desktop-status"),
    diagnostics: document.getElementById("fill-diagnostics"),
    diagnosticsText: document.getElementById("fill-diagnostics-text"),
    quickFields: document.getElementById("quick-fields"),
    fieldMeta: document.getElementById("field-meta"),
    fieldSearch: document.getElementById("field-search"),
    fieldGroups: document.getElementById("field-groups"),
    fieldEmpty: document.getElementById("field-empty"),
    toast: document.getElementById("panel-toast"),
    jobSaveButton: document.getElementById("job-save-button"),
    jobProgress: document.getElementById("job-save-progress"),
    jobProgressText: document.getElementById("job-save-progress-text"),
    jobProgressCount: document.getElementById("job-save-progress-count"),
    jobFragments: document.getElementById("job-save-fragments"),
    jobStop: document.getElementById("job-save-stop"),
    jobForm: document.getElementById("job-save-form"),
    jobCompany: document.getElementById("job-save-company"),
    jobTitle: document.getElementById("job-save-title"),
    jobUrl: document.getElementById("job-save-url"),
    jobNote: document.getElementById("job-save-note"),
    jobError: document.getElementById("job-save-error"),
    jobOpenAi: document.getElementById("job-save-open-ai"),
    jobReassist: document.getElementById("job-save-reassist"),
    jobHint: document.getElementById("job-save-hint"),
    jobConfirm: document.getElementById("job-save-confirm"),
    jobCancel: document.getElementById("job-save-cancel"),
    jobChoice: document.getElementById("job-save-choice"),
    jobCandidates: document.getElementById("job-save-candidates"),
    jobNew: document.getElementById("job-save-new"),
    jobLater: document.getElementById("job-save-later"),
    jobResult: document.getElementById("job-save-result"),
    jobResultText: document.getElementById("job-save-result-text"),
    jobResultHint: document.getElementById("job-save-result-hint"),
    jobAgain: document.getElementById("job-save-again"),
    jobCopyId: document.getElementById("job-save-copy-id"),
    jobDismiss: document.getElementById("job-save-dismiss")
  };
  let currentTabId = null;
  let currentStore = null;
  let desktopMode = "unavailable";
  let lastPageStatus = null;
  let toastTimer = null;
  let statusPolling = false;
  // The page's save-job draft as last rendered. The page owns it; the panel only shows it
  // and never stores it. `filled` remembers which draft revision is in the inputs, so a poll
  // never overwrites what the user is typing.
  let jobSave = null;
  let jobFilled = "";
  let jobPending = false;
  let statusRepoll = false;
  // Which request currently owns `jobPending`; a request that was overtaken must not clear it.
  let jobOwner = 0;

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  async function sendToPage(message, tabId = null) {
    const tab = tabId ? null : await activeTab();
    const id = tabId || tab?.id;
    if (!id) return { ok: false, error: "请先打开网申网页。" };
    if (message.type !== "RESUME_PANEL_STATUS" && tab?.id !== currentTabId) {
      return { ok: false, error: "网页已切换，请等侧栏更新后重试。" };
    }
    try {
      return await chrome.tabs.sendMessage(id, message);
    } catch {
      return { ok: false, error: "此页面无法使用助手，请在普通招聘网页中打开。" };
    }
  }

  function toast(message) {
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3000);
  }

  async function copyFieldValue(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const helper = document.createElement("textarea");
      helper.value = value;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      } finally {
        helper.remove();
      }
    }
  }

  function selectedTemplate() {
    return currentStore?.activeTemplate || null;
  }

  function groupedFields() {
    const template = selectedTemplate();
    const groups = (template?.groups || []).map((group, groupIndex) => ({
      name: group.name || "未分类",
      fields: (group.fields || []).map((field, fieldIndex) => ({
        key: String(field.key || ""), value: String(field.value || ""),
        chipId: `${template.id}:${groupIndex}:${fieldIndex}`
      }))
    }));
    const profile = self.ResumeProProfile?.profileToResumeFields(currentStore?.profile) || [];
    for (const field of profile) {
      let group = groups.find((item) => item.name === `我的信息 · ${field.group}`);
      if (!group) {
        group = { name: `我的信息 · ${field.group}`, fields: [] };
        groups.push(group);
      }
      group.fields.push({ key: field.key, value: field.value, chipId: `profile:${field.group}:${field.key}` });
    }
    return groups;
  }

  function visibleFields(groups) {
    return groups.flatMap((group) => group.fields)
      .filter((field) => field.key && field.value
        && !self.ResumeProProfile.SECRET_LABEL.test(field.key)
        && !self.ResumeProProfile.SECRET_VALUE.test(field.value));
  }

  function renderDesktopMode() {
    const mode = desktopMode === "ready" && !selectedTemplate() && !self.ResumeProProfile?.hasProfileContent(currentStore?.profile)
      ? "empty" : desktopMode;
    const copy = mode === "ready" ? null : self.ResumeProResumeData.modeCopy(mode);
    elements.desktopConnection.hidden = !copy;
    if (copy) {
      elements.desktopConnectionText.textContent = copy.message;
      elements.desktopConnectionAction.textContent = copy.action;
    }
    elements.configState.textContent = copy ? "桌面简历当前不可用" : "简历数据来自桌面程序";
    elements.templateSelect.disabled = Boolean(copy) || !(currentStore?.templates?.length);
    elements.fieldSearch.disabled = Boolean(copy);
    elements.desktopConnectionAction.dataset.kind = copy?.kind || "";
    document.getElementById("open-manager").textContent = copy?.action || "打开桌面";
  }

  function renderFromStore() {
    const templates = currentStore?.templates || [];
    const selected = selectedTemplate();
    elements.templateSelect.innerHTML = templates.length
      ? templates.map((template) => `<option value="${escapeHtml(template.id)}"${template.id === selected?.id ? " selected" : ""}>${escapeHtml(template.name)} · ${template.fieldCount} 个字段</option>`).join("")
      : '<option value="">暂无模板</option>';
    renderDesktopMode();

    const groups = groupedFields();
    const fields = visibleFields(groups);
    elements.fieldMeta.textContent = `${selected?.name || "我的信息"} · ${groups.length} 个分组 · ${fields.length} 项`;
    const preferred = ["姓名", "手机号", "手机号码", "邮箱", "常用邮箱"];
    const quick = preferred.map((key) => fields.find((field) => field.key === key)).filter(Boolean).slice(0, 3);
    if (!quick.length) quick.push(...fields.slice(0, 3));
    elements.quickFields.innerHTML = quick.length
      ? quick.map((field) => `<button type="button" class="quick-row" data-chip-id="${escapeHtml(field.chipId)}"><span class="row-key">${escapeHtml(field.key)}</span><span class="row-value">${escapeHtml(field.value)}</span></button>`).join("")
      : '<p class="field-empty">还没有可用的简历字段。</p>';

    elements.fieldGroups.innerHTML = groups.map((group, index) => {
      const rows = group.fields.filter((field) => fields.includes(field));
      if (!rows.length) return "";
      return `<details class="field-group"${index === 0 ? " open" : ""}>
        <summary><span>${escapeHtml(group.name)} <small>${rows.length} 项</small></span><span class="field-group__chevron" aria-hidden="true">›</span></summary>
        <div>${rows.map((field) => `<div class="field-row" data-search="${escapeHtml(`${field.key} ${field.value}`.toLocaleLowerCase())}"><button type="button" class="field-row__fill" data-chip-id="${escapeHtml(field.chipId)}"><span class="row-key">${escapeHtml(field.key)}</span><span class="row-value" title="${escapeHtml(field.value)}">${escapeHtml(field.value)}</span></button><button type="button" class="field-row__copy" data-chip-id="${escapeHtml(field.chipId)}">复制</button></div>`).join("")}</div>
      </details>`;
    }).join("");
    filterFields();
    updateFillAvailability(lastPageStatus);
  }

  function filterFields() {
    const query = elements.fieldSearch.value.trim().toLocaleLowerCase();
    let visible = 0;
    const groups = Array.from(elements.fieldGroups.querySelectorAll(".field-group"));
    groups.forEach((group, index) => {
      const groupMatches = group.querySelector("summary").textContent.toLocaleLowerCase().includes(query);
      let rowCount = 0;
      group.querySelectorAll(".field-row").forEach((row) => {
        const match = !query || groupMatches || row.dataset.search.includes(query);
        row.hidden = !match;
        if (match) rowCount += 1;
      });
      group.hidden = Boolean(query) && rowCount === 0;
      if (!group.hidden) visible += 1;
      if (query && rowCount) group.open = true;
      if (!query) group.open = index === 0;
    });
    elements.fieldEmpty.hidden = visible !== 0;
  }

  function updateFillAvailability(status = null) {
    const hasData = Boolean(selectedTemplate() || self.ResumeProProfile?.hasProfileContent(currentStore?.profile));
    elements.fillButton.disabled = desktopMode !== "ready" || !hasData || currentTabId === null || Boolean(status?.busy);
    elements.fillButton.textContent = status?.busy ? (status.phase || "正在填写…") : "一键 AI 填写";
    elements.cancelButton.hidden = !status?.canCancel;
  }

  function renderJobAssist(assist) {
    elements.jobAssist.hidden = !assist;
    if (!assist) return;
    const count = Number.isInteger(assist.fragments) && assist.fragments > 0 ? ` ${assist.fragments} 段` : "";
    elements.jobAssistText.textContent = `正在用桌面的 AI 识别岗位，发送的${count}页面文字列在网页上。`;
  }

  const JOB_ACTIVE = new Set(["extracting", "assist", "review", "saving", "choice"]);

  function applyJobSave(snapshot, tabId = currentTabId) {
    const next = snapshot && snapshot.draftId ? snapshot : null;
    if (!next && jobSave && snapshot?.discarded === "page-changed") {
      toast("网页已经换成别的页面，刚才的岗位内容已作废。请重新点「保存岗位到桌面端」。");
    }
    // An older answer for the same draft (a poll that left before a click) is not news.
    if (next && jobSave && next.draftId === jobSave.draftId && next.version < jobSave.version && jobSave.tabId === tabId) return;
    jobSave = next ? { ...next, tabId } : null;
    renderJobSave();
  }

  function renderJobSave() {
    const job = jobSave;
    const phase = job?.phase || "idle";
    const active = JOB_ACTIVE.has(phase);
    elements.jobSaveButton.hidden = active;
    // No page controller in this tab (an ordinary web page, a browser page, a page that has
    // not finished loading): the button is off and the reason is on screen, not just a tooltip.
    const noPage = currentTabId === null;
    elements.jobSaveButton.disabled = noPage || jobPending;
    elements.jobSaveButton.title = noPage ? "当前网页没有连接填表助手，无法保存岗位。" : "";
    elements.jobHint.hidden = !noPage || active;
    elements.jobSaveButton.textContent = "保存岗位到桌面端";

    elements.jobProgress.hidden = !(phase === "extracting" || phase === "assist");
    if (phase === "extracting") {
      elements.jobProgressText.textContent = "正在读取当前网页的岗位信息…";
      elements.jobProgressCount.textContent = "";
      elements.jobFragments.innerHTML = "";
      elements.jobStop.textContent = "取消";
    } else if (phase === "assist") {
      const count = job.assist?.count || 0;
      elements.jobProgressText.textContent = "正在识别岗位…";
      elements.jobProgressCount.textContent = `页面上的公司或岗位不好确定，已向桌面的 AI 发送 ${count} 段页面文字：`;
      elements.jobFragments.innerHTML = (job.assist?.lines || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
      elements.jobStop.textContent = "取消识别";
    }

    const showForm = phase === "review" || (phase === "saving" && !job?.candidates?.length);
    elements.jobForm.hidden = !showForm;
    if (showForm) {
      const key = `${job.draftId}:${job.revision}`;
      if (jobFilled !== key) {
        jobFilled = key;
        elements.jobCompany.value = job.fields?.company || "";
        elements.jobTitle.value = job.fields?.title || "";
      }
      // Always the page's redacted URL; the input is read-only and never read back.
      elements.jobUrl.value = job.fields?.sourceUrl || "";
      elements.jobUrl.title = job.fields?.sourceUrl || "";
      elements.jobNote.textContent = job.note || "";
      elements.jobError.hidden = !job.error;
      elements.jobError.textContent = job.error || "";
      elements.jobOpenAi.hidden = job.openView !== "settings-ai";
      const saving = phase === "saving" || jobPending;
      elements.jobConfirm.disabled = saving;
      elements.jobConfirm.textContent = saving ? "正在保存…" : "确定保存";
      elements.jobCancel.disabled = saving;
      elements.jobReassist.disabled = saving;
      elements.jobCompany.disabled = saving;
      elements.jobTitle.disabled = saving;
    }

    const showChoice = phase === "choice" || (phase === "saving" && Boolean(job?.candidates?.length));
    elements.jobChoice.hidden = !showChoice;
    if (showChoice) {
      elements.jobCandidates.innerHTML = (job.candidates || []).map((candidate) =>
        `<button type="button" data-application-id="${escapeHtml(candidate.applicationId)}">关联已有：${escapeHtml(candidate.label)}</button>`).join("");
      const busy = phase === "saving" || jobPending;
      elements.jobCandidates.querySelectorAll?.("button").forEach((button) => { button.disabled = busy; });
      elements.jobNew.disabled = busy;
      elements.jobLater.disabled = busy;
    }

    elements.jobResult.hidden = phase !== "result" || !job?.result;
    if (phase === "result" && job?.result) {
      elements.jobResult.className = `job-card is-${job.result.tone || "info"}`;
      elements.jobResultText.textContent = job.result.text || "";
      elements.jobResultHint.hidden = !job.result.hint;
      elements.jobResultHint.textContent = job.result.hint || "";
      elements.jobAgain.hidden = !job.result.offerForce;
      elements.jobAgain.disabled = jobPending;
      elements.jobCopyId.hidden = !job.result.extensionId;
    }
  }

  // One request at a time from the panel; the page refuses a second write on its own too.
  // Cancelling is the exception: it has to reach the page while the draft is still waiting,
  // and once it succeeds the panel is free again even though the cancelled draft request
  // (which waits for the AI) has not returned yet.
  async function jobRequest(message, { interrupt = false } = {}) {
    if (jobPending && !interrupt) return null;
    const owner = !interrupt;
    const mine = owner ? ++jobOwner : 0;
    if (owner) jobPending = true;
    renderJobSave();
    const tabId = currentTabId;
    try {
      const result = await sendToPage(message);
      if (interrupt && result?.ok) {
        jobOwner += 1;
        jobPending = false;
      }
      // An answer for another tab's page must not draw over the tab that is in front now.
      if (result?.jobSave && tabId === currentTabId) applyJobSave(result.jobSave, tabId);
      return result;
    } finally {
      if (owner && jobOwner === mine) jobPending = false;
      renderJobSave();
    }
  }

  async function pollStatus() {
    // A poll asked for while one is running is not lost: it runs again once this one ends.
    if (statusPolling) { statusRepoll = true; return; }
    statusPolling = true;
    try {
      const tab = await activeTab();
      const nextTabId = tab?.id || null;
      if (nextTabId !== currentTabId) {
        elements.fillResult.hidden = true;
        elements.fillResult.textContent = "";
        jobSave = null;
        jobFilled = "";
        // A request still waiting on the tab we left must not keep this tab's button locked,
        // and its answer is dropped by the tab check in jobRequest.
        jobOwner += 1;
        jobPending = false;
      }
      currentTabId = nextTabId;
      const polledTabId = currentTabId;
      const response = await sendToPage({ type: "RESUME_PANEL_STATUS" }, polledTabId);
      // The tab in front may have changed while the page was answering. That answer is about
      // the tab we left and must not be drawn over the new one.
      const front = await activeTab();
      if ((front?.id || null) !== polledTabId) { statusRepoll = true; return; }
      const connected = Boolean(response?.ready);
      elements.pageState.textContent = connected ? "当前网页已连接填表助手" : "当前页面无法使用填表助手";
      elements.pageState.classList.toggle("is-unavailable", !connected);
      if (!connected) currentTabId = null;
      lastPageStatus = connected ? response : null;
      updateFillAvailability(lastPageStatus);
      renderJobAssist(connected ? response.jobAssist : null);
      // Applied even while a click is waiting: recognition progress only arrives this way.
      // Older snapshots of the same draft are dropped by their version.
      applyJobSave(connected ? response.jobSave : null, currentTabId);
      if (connected && response.status) {
        elements.fillResult.hidden = false;
        elements.fillResult.textContent = response.status;
        elements.fillResult.classList.toggle("is-error", response.statusKind === "error");
        if (response.openView === "settings-ai") {
          elements.desktopConnection.hidden = false;
          elements.desktopConnectionText.textContent = response.status;
          elements.desktopConnectionAction.textContent = "打开桌面 AI 设置";
          elements.desktopConnectionAction.dataset.kind = "settings-ai";
        }
      }
      // The AI-settings hint belongs to the fill that raised it. Once the page stops
      // reporting it (a new fill started, or another tab), go back to the desktop state.
      if (response?.openView !== "settings-ai" && elements.desktopConnectionAction.dataset.kind === "settings-ai") {
        renderDesktopMode();
      }
      if (connected) {
        elements.profileOffer.hidden = !response.profileOffer;
        elements.profileOfferText.textContent = response.profileOffer || "";
        if (response.fillOffer && elements.fillOffer.hidden) elements.fillOfferSnapshot.checked = true;
        elements.fillOffer.hidden = !response.fillOffer;
        elements.fillOfferText.textContent = response.fillOffer || "";
        elements.fillOfferSnapshot.disabled = !response.snapshotAvailable;
        elements.desktopStatus.hidden = !response.desktopStatus;
        elements.desktopStatus.textContent = response.desktopStatus || "";
        elements.diagnostics.hidden = !response.diagnostics;
        if (elements.diagnosticsText.value !== (response.diagnostics || "")) {
          elements.diagnosticsText.value = response.diagnostics || "";
        }
      } else {
        elements.profileOffer.hidden = true;
        elements.fillOffer.hidden = true;
        elements.desktopStatus.hidden = true;
        elements.diagnostics.hidden = true;
      }
    } finally {
      statusPolling = false;
      if (statusRepoll) {
        statusRepoll = false;
        pollStatus().catch(() => {});
      }
    }
  }

  async function loadStore() {
    try {
      const result = await chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_READ" });
      desktopMode = result?.status === "ok" ? "ready" : result?.status || "unavailable";
      currentStore = result?.status === "ok" ? self.ResumeProResumeData.normalize(result.data) : null;
    } catch {
      desktopMode = "unavailable";
      currentStore = null;
    }
    renderFromStore();
  }

  document.querySelectorAll(".dock-tabs button").forEach((button) => button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    document.querySelectorAll(".dock-tabs button").forEach((item) => item.setAttribute("aria-selected", String(item.dataset.tab === tab)));
    document.querySelectorAll(".dock-view").forEach((view) => { view.hidden = view.dataset.view !== tab; });
  }));
  document.getElementById("show-fields").addEventListener("click", () => document.querySelector('.dock-tabs button[data-tab="fields"]').click());
  elements.fieldSearch.addEventListener("input", filterFields);
  elements.fieldGroups.addEventListener("toggle", (event) => {
    if (event.target.matches?.(".field-group") && event.target.open && !elements.fieldSearch.value) {
      elements.fieldGroups.querySelectorAll(".field-group").forEach((group) => { if (group !== event.target) group.open = false; });
    }
  }, true);
  elements.templateSelect.addEventListener("change", async () => {
    const result = await chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_UPDATE", op: "setActiveTemplate", templateId: elements.templateSelect.value });
    await loadStore();
    toast(result?.status === "missing_template" ? "这个模板在桌面里已经删掉了" : result?.status === "ok" ? "当前模板已切换。" : "桌面暂时无法切换模板。");
  });
  elements.fillButton.addEventListener("click", async () => {
    elements.fillResult.hidden = true;
    const result = await sendToPage({ type: "RESUME_PANEL_FILL" });
    if (!result?.ok) toast(result?.error || "无法开始填写。");
    await pollStatus();
  });
  elements.cancelButton.addEventListener("click", async () => {
    const result = await sendToPage({ type: "RESUME_PANEL_CANCEL" });
    if (!result?.ok) toast(result?.error || "当前无法取消。");
    await pollStatus();
  });
  document.querySelectorAll("[data-offer]").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.offer;
    const result = await sendToPage({ type: "RESUME_PANEL_OFFER", action, withSnapshot: elements.fillOfferSnapshot.checked });
    if (!result?.ok) toast(result?.error || "操作未完成，请查看网页。");
    else if (result.needsPageChoice) toast("请在网页上的确认控件里选择对应申请。");
    else if (action === "profileAdd") {
      await loadStore();
      await chrome.runtime.sendMessage({ type: "DESKTOP_OPEN_VIEW", view: "resume" });
    }
    await pollStatus();
  }));
  async function fieldAction(event, mode) {
    const button = event.target.closest("[data-chip-id]");
    if (!button) return;
    const field = visibleFields(groupedFields()).find((item) => item.chipId === button.dataset.chipId);
    if (!field) { toast("字段已变化，请刷新侧栏后重试。"); return; }
    if (mode === "copy") {
      toast(await copyFieldValue(field.value) ? "已复制字段内容。" : "复制失败，请在桌面核对字段内容。");
      return;
    }
    const result = await sendToPage({ type: "RESUME_PANEL_FIELD", chipId: button.dataset.chipId, value: field.value, mode });
    if (result?.needsCopy) {
      const copied = await copyFieldValue(field.value);
      toast(copied ? `${result.message}字段内容已复制。` : "复制失败，请在桌面核对字段内容。");
      return;
    }
    toast(result?.message || result?.error || "字段操作未完成。");
  }
  elements.quickFields.addEventListener("click", (event) => fieldAction(event, "fill"));
  elements.fieldGroups.addEventListener("click", (event) => fieldAction(event, event.target.closest(".field-row__copy") ? "copy" : "fill"));
  document.querySelectorAll("[data-advanced]").forEach((button) => button.addEventListener("click", async () => {
    document.querySelector(".dock-tools").open = false;
    const result = await sendToPage({ type: "RESUME_PANEL_ADVANCED", action: button.dataset.advanced });
    const done = {
      close: "网页高级控件已收起。"
    }[button.dataset.advanced] || "请在网页上的高级控件中继续操作。";
    toast(result?.ok ? done : result?.error || "无法打开工具。");
  }));
  elements.jobSaveButton.addEventListener("click", async () => {
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_DRAFT" });
    if (result && !result.ok) toast(result.error || "无法读取当前网页的岗位信息。");
  });
  elements.jobStop.addEventListener("click", async () => {
    if (!jobSave?.draftId) return;
    // Before the AI is asked there is nothing to fall back to, so this ends the draft.
    const scope = jobSave.phase === "assist" ? "assist" : "draft";
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CANCEL", draftId: jobSave.draftId, scope }, { interrupt: true });
    if (result && !result.ok) toast(result.error || "当前无法取消。");
    else if (result && scope === "assist") toast("已取消识别，请手动补全后再保存。");
  });
  elements.jobForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!jobSave?.draftId || jobSave.phase !== "review") return;
    const company = elements.jobCompany.value.trim();
    const title = elements.jobTitle.value.trim();
    elements.jobCompany.setAttribute?.("aria-invalid", String(!company));
    elements.jobTitle.setAttribute?.("aria-invalid", String(!title));
    if (!company || !title) {
      const missing = [!company && "公司名称", !title && "岗位名称"].filter(Boolean).join("和");
      elements.jobError.hidden = false;
      elements.jobError.textContent = `请补全${missing}后再保存。`;
      (company ? elements.jobTitle : elements.jobCompany).focus?.();
      return;
    }
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CONFIRM", draftId: jobSave.draftId, company, title });
    if (result && !result.ok && !result.missing) toast(result.error || "这次没能保存，请稍后再试。");
  });
  elements.jobCancel.addEventListener("click", async () => {
    if (!jobSave?.draftId) return;
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CANCEL", draftId: jobSave.draftId, scope: "draft" });
    if (result?.ok) toast("已取消，这次没有保存。");
    else if (result) toast(result.error || "当前无法取消。");
  });
  elements.jobReassist.addEventListener("click", async () => {
    if (!jobSave?.draftId || jobSave.phase !== "review") return;
    // What is in the boxes now goes along, so a failed or cancelled recognition gives it back.
    const result = await jobRequest({
      type: "RESUME_PANEL_SAVE_REASSIST", draftId: jobSave.draftId,
      company: elements.jobCompany.value.trim(), title: elements.jobTitle.value.trim()
    });
    if (result && !result.ok) toast(result.error || "暂时无法重新识别。");
  });
  elements.jobOpenAi.addEventListener("click", () => desktopAction("settings-ai").catch(() => toast("当前操作不可用。")));
  elements.jobCandidates.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-application-id]");
    if (!button || !jobSave?.draftId) return;
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CHOICE", draftId: jobSave.draftId, action: "existing", applicationId: button.dataset.applicationId });
    if (result && !result.ok) toast(result.error || "操作未完成。");
  });
  elements.jobNew.addEventListener("click", async () => {
    if (!jobSave?.draftId) return;
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CHOICE", draftId: jobSave.draftId, action: "new" });
    if (result && !result.ok) toast(result.error || "操作未完成。");
  });
  elements.jobLater.addEventListener("click", async () => {
    if (!jobSave?.draftId) return;
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CHOICE", draftId: jobSave.draftId, action: "later" });
    if (result && !result.ok) toast(result.error || "操作未完成。");
  });
  elements.jobAgain.addEventListener("click", async () => {
    if (!jobSave?.draftId) return;
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CONFIRM", draftId: jobSave.draftId, force: true });
    if (result && !result.ok) toast(result.error || "这次没能保存，请稍后再试。");
  });
  elements.jobCopyId.addEventListener("click", async () => {
    toast(await copyFieldValue(chrome.runtime.id) ? "扩展 ID 已复制，请在桌面设置中粘贴。" : "复制失败。");
  });
  elements.jobDismiss.addEventListener("click", async () => {
    if (!jobSave?.draftId) return;
    await jobRequest({ type: "RESUME_PANEL_SAVE_CANCEL", draftId: jobSave.draftId, scope: "draft" });
  });
  elements.jobAssistCancel.addEventListener("click", async () => {
    const result = await sendToPage({ type: "RESUME_PANEL_ADVANCED", action: "cancel-assist" });
    toast(result?.ok ? "已取消识别，请在网页表单里手动补全。" : result?.error || "无法取消识别。");
    await pollStatus().catch(() => {});
  });
  async function desktopAction(kind = "home") {
    if (kind === "download") {
      await chrome.tabs.create({ url: self.ResumeProResumeData.DOWNLOAD_URL });
      return;
    }
    if (kind === "pair") {
      await copyFieldValue(chrome.runtime.id);
      toast("扩展 ID 已复制，请在桌面设置中粘贴。");
      return;
    }
    if (kind === "retry") { await loadStore(); return; }
    const result = await chrome.runtime.sendMessage({ type: "DESKTOP_OPEN_VIEW", view: kind === "resume" ? "resume" : kind === "settings-ai" ? "settings-ai" : "home" });
    if (result?.status !== "ok") toast("桌面程序暂时无法打开，请检查连接。");
  }
  elements.desktopConnectionAction.addEventListener("click", () => desktopAction(elements.desktopConnectionAction.dataset.kind).catch(() => toast("当前操作不可用。")));
  document.getElementById("open-manager").addEventListener("click", () => {
    const mode = desktopMode === "ready" && !selectedTemplate() && !self.ResumeProProfile?.hasProfileContent(currentStore?.profile) ? "empty" : desktopMode;
    return desktopAction(mode === "ready" ? "home" : self.ResumeProResumeData.modeCopy(mode).kind).catch(() => toast("当前操作不可用。"));
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadStore().catch(() => {}); });
  chrome.tabs.onActivated.addListener(() => { loadStore().then(pollStatus).catch(() => {}); });
  chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === "complete") pollStatus().catch(() => {}); });
  loadStore().then(pollStatus).catch(() => { elements.configState.textContent = "无法连接桌面，请稍后重试。"; });
  setInterval(() => { pollStatus().catch(() => {}); }, 1500);
  // 0.4.0 data on its way to the desktop: only while it is in flight does the panel say so.
  async function renderLegacyHint() {
    const { legacyImport } = await chrome.storage.local.get(["legacyImport"]);
    document.getElementById("legacy-hint").hidden = !["sending", "waiting"].includes(legacyImport?.phase);
  }
  // Connection details and anything left over from the 0.4.0 migration live on the status page.
  document.getElementById("open-status").addEventListener("click", () => { chrome.runtime.openOptionsPage?.(); });
  document.getElementById("legacy-hint-open").addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({ type: "DESKTOP_OPEN_VIEW", view: "resume" }).catch(() => null);
    if (result?.status !== "ok") toast("桌面程序暂时无法打开，请检查连接。");
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.legacyImport) renderLegacyHint().catch(() => {});
  });
  // Opening the panel nudges a stalled migration; with no old data this does no native call.
  chrome.runtime.sendMessage({ type: "DESKTOP_LEGACY_STATUS" }).catch(() => {});
  renderLegacyHint().catch(() => {});
})();
