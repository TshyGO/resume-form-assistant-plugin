(() => {
  const elements = {
    pageState: document.getElementById("page-state"),
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
    toast: document.getElementById("panel-toast")
  };
  let currentTabId = null;
  let currentStore = null;
  let toastTimer = null;
  let statusPolling = false;

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
    const templates = currentStore?.templates || [];
    return templates.find((template) => template.id === currentStore.activeTemplateId) || templates[0] || null;
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
      .filter((field) => field.key && field.value && !/密码|验证码|口令|密钥|私钥|token|secret/i.test(field.key));
  }

  function renderFromStore() {
    const templates = currentStore?.templates || [];
    const selected = selectedTemplate();
    elements.templateSelect.innerHTML = templates.length
      ? templates.map((template) => `<option value="${escapeHtml(template.id)}"${template.id === selected?.id ? " selected" : ""}>${escapeHtml(template.name)} · ${template.groups?.reduce((n, group) => n + (group.fields?.length || 0), 0) || 0} 个字段</option>`).join("")
      : '<option value="">暂无模板</option>';
    elements.templateSelect.disabled = !templates.length;
    elements.configState.textContent = currentStore?.aiConfig?.apiKey
      ? "AI 配置已保存 · 使用你自己的模型服务" : "请先在管理面板配置 AI 接口";

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
    updateFillAvailability();
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
    const configured = Boolean(currentStore?.aiConfig?.apiKey);
    elements.fillButton.disabled = !hasData || !configured || currentTabId === null || Boolean(status?.busy);
    elements.fillButton.textContent = status?.busy ? (status.phase || "正在填写…") : "一键 AI 填写";
    elements.cancelButton.hidden = !status?.canCancel;
  }

  async function pollStatus() {
    if (statusPolling) return;
    statusPolling = true;
    try {
      const tab = await activeTab();
      const nextTabId = tab?.id || null;
      if (nextTabId !== currentTabId) {
        elements.fillResult.hidden = true;
        elements.fillResult.textContent = "";
      }
      currentTabId = nextTabId;
      const response = await sendToPage({ type: "RESUME_PANEL_STATUS" }, currentTabId);
      const connected = Boolean(response?.ready);
      elements.pageState.textContent = connected ? "当前网页已连接填表助手" : "当前页面无法使用填表助手";
      elements.pageState.classList.toggle("is-unavailable", !connected);
      if (!connected) currentTabId = null;
      updateFillAvailability(connected ? response : null);
      if (connected && response.status) {
        elements.fillResult.hidden = false;
        elements.fillResult.textContent = response.status;
        elements.fillResult.classList.toggle("is-error", response.statusKind === "error");
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
    }
  }

  async function loadStore() {
    currentStore = await chrome.storage.local.get(["templates", "activeTemplateId", "aiConfig", "profile"]);
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
    await chrome.storage.local.set({ activeTemplateId: elements.templateSelect.value });
    await loadStore();
    toast("当前模板已切换。");
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
    await pollStatus();
  }));
  async function fieldAction(event, mode) {
    const button = event.target.closest("[data-chip-id]");
    if (!button) return;
    const field = visibleFields(groupedFields()).find((item) => item.chipId === button.dataset.chipId);
    if (!field) { toast("字段已变化，请刷新侧栏后重试。"); return; }
    if (mode === "copy") {
      toast(await copyFieldValue(field.value) ? "已复制字段内容。" : "复制失败，请在管理面板核对字段内容。");
      return;
    }
    const result = await sendToPage({ type: "RESUME_PANEL_FIELD", chipId: button.dataset.chipId, mode });
    if (result?.needsCopy) {
      const copied = await copyFieldValue(field.value);
      toast(copied ? `${result.message}字段内容已复制。` : "复制失败，请在管理面板核对字段内容。");
      return;
    }
    toast(result?.message || result?.error || "字段操作未完成。");
  }
  elements.quickFields.addEventListener("click", (event) => fieldAction(event, "fill"));
  elements.fieldGroups.addEventListener("click", (event) => fieldAction(event, event.target.closest(".field-row__copy") ? "copy" : "fill"));
  document.querySelectorAll("[data-advanced]").forEach((button) => button.addEventListener("click", async () => {
    document.querySelector(".dock-tools").open = false;
    const result = await sendToPage({ type: "RESUME_PANEL_ADVANCED", action: button.dataset.advanced });
    toast(result?.ok ? (button.dataset.advanced === "close" ? "网页高级控件已收起。" : "请在网页上的高级控件中继续操作。") : result?.error || "无法打开工具。");
  }));
  document.getElementById("open-manager").addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({ type: "OPEN_MANAGER" });
    if (!result?.opened) toast(result?.error || "无法打开管理面板。");
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["templates", "activeTemplateId", "aiConfig", "profile"].some((key) => changes[key])) loadStore().catch(() => {});
  });
  chrome.tabs.onActivated.addListener(() => { pollStatus().catch(() => {}); });
  chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === "complete") pollStatus().catch(() => {}); });
  loadStore().then(pollStatus).catch(() => { elements.pageState.textContent = "无法读取插件数据，请重新加载扩展。"; });
  setInterval(() => { pollStatus().catch(() => {}); }, 1500);
})();
