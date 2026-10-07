(() => {
  self.ResumeProFeedback?.install(report => chrome.runtime.sendMessage({ type: "FEEDBACK_AUTO", report }), { origin: chrome.runtime.getURL("") });
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
    repeatButton: document.getElementById("repeat-button"),
    repeatCard: document.getElementById("repeat-card"),
    repeatMessage: document.getElementById("repeat-message"),
    repeatPlan: document.getElementById("repeat-plan"),
    repeatConfirm: document.getElementById("repeat-confirm"),
    repeatCancel: document.getElementById("repeat-cancel"),
    repeatStop: document.getElementById("repeat-stop"),
    repeatDismiss: document.getElementById("repeat-dismiss"),
    fillResult: document.getElementById("fill-result"),
    profileOffer: document.getElementById("profile-offer"),
    profileOfferText: document.getElementById("profile-offer-text"),
    profileOfferIntro: document.getElementById("profile-offer-intro"),
    profileOfferResult: document.getElementById("profile-offer-result"),
    profileOfferDetail: document.getElementById("profile-offer-detail"),
    profileOfferGroups: document.getElementById("profile-offer-groups"),
    profileOfferNotes: document.getElementById("profile-offer-notes"),
    profileOfferSave: document.getElementById("profile-offer-save"),
    profileOfferSkip: document.getElementById("profile-offer-skip"),
    profileOfferView: document.getElementById("profile-offer-view"),
    profileOfferDismiss: document.getElementById("profile-offer-dismiss"),
    fillOffer: document.getElementById("fill-offer"),
    fillOfferTitle: document.getElementById("fill-offer-title"),
    fillOfferText: document.getElementById("fill-offer-text"),
    fillOfferHint: document.getElementById("fill-offer-hint"),
    fillOfferSnapshotState: document.getElementById("fill-offer-snapshot-state"),
    fillOfferCheck: document.getElementById("fill-offer-check"),
    fillOfferSnapshot: document.getElementById("fill-offer-snapshot"),
    fillOfferCandidates: document.getElementById("fill-offer-candidates"),
    fillOfferExtensionId: document.getElementById("fill-offer-extension-id"),
    fillOfferActions: document.getElementById("fill-offer-actions"),
    queueToggle: document.getElementById("queue-toggle"),
    queueCount: document.getElementById("queue-count"),
    queueBody: document.getElementById("queue-body"),
    queueList: document.getElementById("queue-list"),
    queueEmpty: document.getElementById("queue-empty"),
    desktopStatus: document.getElementById("desktop-status"),
    diagnostics: document.getElementById("fill-diagnostics"),
    diagnosticsText: document.getElementById("fill-diagnostics-text"),
    copyDiagnostics: document.getElementById("copy-diagnostics"),
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
    jobLocation: document.getElementById("job-save-location"),
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
    jobDismiss: document.getElementById("job-save-dismiss"),
    submitButton: document.getElementById("submit-confirm-button"),
    submitProgress: document.getElementById("submit-confirm-progress"),
    submitProgressText: document.getElementById("submit-confirm-progress-text"),
    submitProgressCount: document.getElementById("submit-confirm-progress-count"),
    submitFragments: document.getElementById("submit-confirm-fragments"),
    submitStop: document.getElementById("submit-confirm-stop"),
    submitForm: document.getElementById("submit-confirm-form"),
    submitCompany: document.getElementById("submit-confirm-company"),
    submitTitle: document.getElementById("submit-confirm-title"),
    submitUrl: document.getElementById("submit-confirm-url"),
    submitNote: document.getElementById("submit-confirm-note"),
    submitError: document.getElementById("submit-confirm-error"),
    submitOpenAi: document.getElementById("submit-confirm-open-ai"),
    submitQuery: document.getElementById("submit-confirm-query"),
    submitReviewCancel: document.getElementById("submit-confirm-review-cancel"),
    submitChoice: document.getElementById("submit-confirm-choice"),
    submitCandidates: document.getElementById("submit-confirm-candidates"),
    submitBack: document.getElementById("submit-confirm-back"),
    submitCancel: document.getElementById("submit-confirm-cancel"),
    submitResult: document.getElementById("submit-confirm-result"),
    submitResultText: document.getElementById("submit-confirm-result-text"),
    submitResultHint: document.getElementById("submit-confirm-result-hint"),
    submitSave: document.getElementById("submit-confirm-save"),
    submitResultBack: document.getElementById("submit-confirm-result-back"),
    submitCopyId: document.getElementById("submit-confirm-copy-id"),
    submitDismiss: document.getElementById("submit-confirm-dismiss")
  };
  let currentTabId = null;
  let currentStore = null;
  let desktopMode = "unavailable";
  let storeSnapshot = "";
  let storeLoaded = false;
  let storeReadSequence = 0;
  let lastPageStatus = null;
  let toastTimer = null;
  let statusPolling = false;
  // The page's save-job draft as last rendered. The page owns it; the panel only shows it
  // and never stores it. `filled` remembers which draft revision is in the inputs, so a poll
  // never overwrites what the user is typing.
  let jobSave = null;
  let jobFilled = "";
  let jobLocalError = "";
  let jobPending = false;
  let statusRepoll = false;
  // "确认已投递" (#172): the page's confirm-submission state as last rendered. Like the save
  // draft it is the page's; the panel shows it and picks from the candidates it offered.
  // `submitSeen` remembers the newest snapshot of the current tab and page load, so an older
  // poll that left before a click can neither clear nor reopen what the user just did.
  let submitConfirm = null;
  let submitSeen = { tabId: null, epoch: "", version: 0 };
  // Like `jobFilled`/`jobLocalError` for the save-job form: which review revision is in the
  // inputs (so a poll never overwrites what the user is typing), and a required-field prompt
  // that lives in the panel so editing can clear it without a round trip to the page.
  let submitFilled = "";
  let submitLocalError = "";
  // Which request currently owns `jobPending`; a request that was overtaken must not clear it.
  let jobOwner = 0;
  // Booleans and chip ids from the page controller, never the page's own text (#174).
  let targetState = self.ResumeProCompose.emptyTargetState();
  let targetRequest = 0;
  // #188 辅助新增：只保存当前标签页上报、经过 normalizeRepeat 的状态。换标签页就清掉。
  let repeatView = null;
  let repeatPending = false;
  let repeatPollTimer = null;
  let tabEpoch = 0;
  const REPEAT_PHASES = ["idle", "scanning", "planning", "preview", "executing", "filling", "completed", "stopped", "failed"];
  const REPEAT_ACTIVE = ["scanning", "planning", "preview", "executing", "filling"];
  const REPEAT_STOPPABLE = ["scanning", "planning", "executing", "filling"];
  const REPEAT_LABELS = { papers: "论文", education: "教育经历", work: "工作经历", projects: "项目经历" };
  // Archiving the fill that just ended (#178). The page owns the question and its answer;
  // the panel draws the page's snapshot, bound to the tab it came from. `archiveSeen` is the
  // newest snapshot of this tab and page load, so an older poll that left before a click can
  // neither clear nor reopen what the user just did. `archivePending` names the one request
  // the panel is waiting on: no second one starts until it returns.
  let fillArchive = null;
  let archiveSeen = { tabId: null, epoch: "", version: 0 };
  let archivePending = "";
  let archiveOwner = 0;
  let offerShown = "";
  // The pending list (DESKTOP_LIST_QUEUE) as last read, and each row's open question.
  let queueReply = null;
  let queueRows = [];
  const queueUi = new Map();
  let queueFocus = "";
  let queueRequest = 0;
  let queueReadCompleted = 0;
  // A saved card can arrive after an older queue read. Require one fresh read for its
  // snapshot before deciding that an absent upload needs desktop verification.
  let snapshotQueryNeeded = { id: "", request: Infinity };
  // Snapshot uploads seen waiting at least once: if one vanishes without a complete ACK,
  // its state is unknown rather than uploaded.
  const snapshotsSeen = new Set();
  // What else can take a snapshot off the list, when the panel itself did it: the user gave
  // it up (never "uploaded"), or saved it again under a new id (follow the new one).
  const snapshotsDropped = new Set();
  const snapshotsReplaced = new Map();
  // Snapshots the desktop confirmed complete (worker memory, DESKTOP_LIST_QUEUE). Only these
  // are ever called uploaded.
  const snapshotsConfirmed = new Set();
  // The fill on the card, once the pending list has listed it: only then may its leaving the
  // list (or its waiting row turning into a bound one) close the card.
  const archivesListed = new Set();
  // Fills the user acted on in this panel's pending list: that action already said what happened.
  const archivesTouched = new Set();
  let linkCopyModule = self.ResumeProLinkCopy || null;

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
    const oldGroups = Array.from(elements.fieldGroups.querySelectorAll(".field-group"));
    const openGroupKeys = new Set(oldGroups.filter((group) => group.open).map((group) => group.dataset.groupKey));
    const templates = currentStore?.templates || [];
    const selected = selectedTemplate();
    elements.templateSelect.innerHTML = templates.length
      ? templates.map((template) => `<option value="${escapeHtml(template.id)}"${template.id === selected?.id ? " selected" : ""}>${escapeHtml(template.name)} · ${template.fieldCount} 个字段</option>`).join("")
      : '<option value="">暂无模板</option>';
    renderDesktopMode();

    const groups = groupedFields();
    const fields = visibleFields(groups);
    elements.fieldMeta.textContent = `${selected?.name || "我的信息"} · ${groups.length} 个分组 · ${fields.length} 项`;
    const groupOccurrences = new Map();
    elements.fieldGroups.innerHTML = groups.map((group, index) => {
      const rows = group.fields.filter((field) => fields.includes(field));
      if (!rows.length) return "";
      const occurrence = groupOccurrences.get(group.name) || 0;
      groupOccurrences.set(group.name, occurrence + 1);
      const groupKey = JSON.stringify([group.name, occurrence]);
      const open = oldGroups.length ? openGroupKeys.has(groupKey) : index === 0;
      return `<details class="field-group" data-group-key="${escapeHtml(groupKey)}"${open ? " open" : ""}>
        <summary><span>${escapeHtml(group.name)} <small>${rows.length} 项</small></span><span class="field-group__chevron" aria-hidden="true">›</span></summary>
        <div class="field-group__body">${rows.map((field) => self.ResumeProCompose.renderRow(field, "group")).join("")}</div>
      </details>`;
    }).join("");
    filterFields(oldGroups.length > 0);
    updateFillAvailability(lastPageStatus);
    renderTargetState();
    refreshTarget().catch(() => {});
  }

  function panelChips() {
    return visibleFields(groupedFields()).map((field) => ({ chipId: field.chipId, value: field.value }));
  }

  function renderTargetState() {
    self.ResumeProCompose.applyTargetState([elements.fieldGroups], targetState);
  }

  function clearTargetState() {
    targetRequest += 1;
    targetState = self.ResumeProCompose.emptyTargetState();
    renderTargetState();
  }

  // Asks the page which chips its current text box already holds, and which of the three
  // actions would change it. A stale answer (the tab or target moved on) is dropped.
  async function refreshTarget() {
    const request = ++targetRequest;
    let next = self.ResumeProCompose.emptyTargetState();
    if (currentTabId !== null && (selectedTemplate() || self.ResumeProProfile?.hasProfileContent(currentStore?.profile))) {
      const response = await sendToPage({ type: "RESUME_PANEL_TARGET", chips: panelChips() });
      next = self.ResumeProCompose.normalizeTargetState(response);
    }
    if (request !== targetRequest) return;
    targetState = next;
    renderTargetState();
  }

  function filterFields(preserveOpen = false) {
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
      if (!query && !preserveOpen) group.open = index === 0;
    });
    elements.fieldEmpty.hidden = visible !== 0;
  }

  function updateFillAvailability(status = null) {
    const hasData = Boolean(selectedTemplate() || self.ResumeProProfile?.hasProfileContent(currentStore?.profile));
    const repeating = Boolean(repeatView && REPEAT_ACTIVE.includes(repeatView.phase));
    elements.fillButton.disabled = desktopMode !== "ready" || !hasData || currentTabId === null || Boolean(status?.busy) || repeating;
    elements.fillButton.textContent = status?.busy && !repeating ? (status.phase || "正在填写…") : "一键 AI 填写";
    elements.cancelButton.hidden = !status?.canCancel || repeating;
    elements.repeatButton.disabled = desktopMode !== "ready" || !selectedTemplate() || currentTabId === null
      || Boolean(status?.busy) || repeating || repeatPending;
  }

  // The page's repeat state, cut down to what the card shows. Anything unexpected is dropped
  // rather than displayed; group names come from the table above, never from the page.
  function normalizeRepeat(raw) {
    if (!raw || typeof raw !== "object" || !REPEAT_PHASES.includes(raw.phase)) return null;
    let plan = raw.phase === "preview" && Array.isArray(raw.plan) && raw.plan.length <= 4
      ? raw.plan.filter((item) => Object.prototype.hasOwnProperty.call(REPEAT_LABELS, item?.domain)
        && Number.isInteger(item.count) && item.count >= 1 && item.count <= 5)
        .map((item) => ({ domain: item.domain, count: item.count }))
      : [];
    if (plan.reduce((total, item) => total + item.count, 0) > 5) plan = [];
    const requestId = typeof raw.requestId === "string" && /^[\w-]{1,64}$/.test(raw.requestId) ? raw.requestId : "";
    return {
      phase: raw.phase,
      requestId,
      message: typeof raw.message === "string" ? raw.message.slice(0, 240) : "",
      plan,
      added: Number.isInteger(raw.added) && raw.added >= 0 && raw.added <= 5 ? raw.added : 0,
      canConfirm: raw.phase === "preview" && raw.canConfirm === true && Boolean(requestId) && plan.length > 0,
      canCancel: raw.phase === "preview" && raw.canCancel === true && Boolean(requestId),
      canStop: REPEAT_STOPPABLE.includes(raw.phase) && raw.canStop === true && Boolean(requestId)
    };
  }

  function renderRepeat() {
    const view = repeatView;
    const shown = Boolean(view && view.phase !== "idle");
    elements.repeatCard.hidden = !shown;
    if (shown) {
      elements.repeatCard.dataset.phase = view.phase;
      elements.repeatCard.classList.toggle("is-error", view.phase === "failed");
      elements.repeatMessage.textContent = view.message;
      elements.repeatPlan.hidden = !view.plan.length;
      elements.repeatPlan.replaceChildren(...view.plan.map((item) => {
        const row = document.createElement("li");
        row.textContent = `${REPEAT_LABELS[item.domain]}：${item.count} 条`;
        return row;
      }));
      elements.repeatConfirm.hidden = !view.canConfirm;
      elements.repeatCancel.hidden = !view.canCancel;
      elements.repeatStop.hidden = !view.canStop;
      elements.repeatDismiss.hidden = REPEAT_ACTIVE.includes(view.phase);
      for (const button of [elements.repeatConfirm, elements.repeatCancel, elements.repeatStop, elements.repeatDismiss]) {
        button.disabled = repeatPending;
      }
    }
    updateFillAvailability(lastPageStatus);
  }

  function clearRepeat() {
    repeatView = null;
    renderRepeat();
  }

  // Every action names the plan it was shown for; the page refuses a requestId it no longer has.
  async function repeatAction(action) {
    if (repeatPending) return;
    const requestId = repeatView?.requestId || "";
    if (action !== "start" && !requestId) return;
    repeatPending = true;
    renderRepeat();
    try {
      const result = await sendToPage({ type: "RESUME_PANEL_REPEAT", action, ...(action === "start" ? {} : { requestId }) });
      if (!result?.ok) toast(result?.error || "操作未完成，请重试。");
    } finally {
      repeatPending = false;
      renderRepeat();
    }
    await pollStatus();
  }

  function renderJobAssist(assist) {
    elements.jobAssist.hidden = !assist;
    if (!assist) return;
    const count = Number.isInteger(assist.fragments) && assist.fragments > 0 ? ` ${assist.fragments} 段` : "";
    elements.jobAssistText.textContent = `正在用桌面的 AI 识别岗位，发送的${count}页面文字列在网页上。`;
  }

  // link/copy.mjs holds every sentence about the desktop. An extension page can import it
  // directly; it is loaded once and kept.
  async function linkCopy() {
    if (!linkCopyModule) linkCopyModule = self.ResumeProLinkCopy || await import(chrome.runtime.getURL("link/copy.mjs"));
    return linkCopyModule;
  }

  // --- 留档到桌面 (#178): the whole question in the panel, nothing on the page overlay -------

  // Phases in which the card waits for the user or the desktop. A cancelled or finished-and-
  // dismissed archive shows nothing.
  const ARCHIVE_SHOWN = new Set(["offer", "querying", "choosing", "empty", "blocked", "saving",
    "saved", "queued", "pending_bind", "failed", "unknown"]);

  function resetFillArchive() {
    fillArchive = null;
    archiveSeen = { tabId: null, epoch: "", version: 0 };
    snapshotQueryNeeded = { id: "", request: Infinity };
    // A request still waiting on the tab we left must not keep this tab's card locked; its
    // answer is dropped by the tab check in archiveRequest.
    archiveOwner += 1;
    archivePending = "";
    renderFillArchive();
  }

  function applyFillArchive(snapshot, tabId) {
    if (tabId !== currentTabId) return;
    if (!snapshot) { fillArchive = null; renderFillArchive(); return; }
    // An older answer from this page load is not news: it may predate a click or a cancel.
    if (archiveSeen.tabId === tabId && archiveSeen.epoch === snapshot.epoch && snapshot.version < archiveSeen.version) return;
    archiveSeen = { tabId, epoch: snapshot.epoch, version: snapshot.version };
    fillArchive = snapshot.archiveId && ARCHIVE_SHOWN.has(snapshot.phase) ? { ...snapshot, tabId } : null;
    if (fillArchive?.phase === "saved" && fillArchive.snapshotId && snapshotQueryNeeded.id !== fillArchive.snapshotId) {
      snapshotQueryNeeded = { id: fillArchive.snapshotId, request: queueRequest + 1 };
      refreshQueue().catch(() => {});
    }
    if (fillArchive?.phase === "offer" && offerShown !== fillArchive.archiveId) {
      // A new finished fill: the snapshot box starts ticked whenever there is a template to attach.
      offerShown = fillArchive.archiveId;
      elements.fillOfferSnapshot.checked = Boolean(fillArchive.snapshotAvailable);
    }
    renderFillArchive();
  }

  const archiveButton = (action, label, { disabled = false } = {}) =>
    `<button type="button" data-archive="${action}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button>`;

  function renderFillArchive() {
    const job = fillArchive;
    elements.fillOffer.hidden = !job;
    if (!job) return;
    const copy = linkCopyModule;
    const busy = Boolean(archivePending);
    // The click is on its way and the page has not answered yet: already show what it does
    // (the lookup, or the write), not a card of greyed-out buttons.
    let phase = job.phase;
    let savingKind = job.saving;
    if (job.phase === "offer" && archivePending === "RESUME_PANEL_ARCHIVE_START") phase = "querying";
    else if (job.phase === "choosing" && archivePending === "RESUME_PANEL_ARCHIVE_CHOOSE") { phase = "saving"; savingKind = "bind"; }
    else if (["choosing", "empty", "blocked"].includes(job.phase) && archivePending === "RESUME_PANEL_ARCHIVE_LATER") { phase = "saving"; savingKind = "queue"; }
    const result = job.result || null;
    let title = "";
    let text = "";
    let hint = "";
    let actions = [];
    let candidates = "";
    if (phase === "offer") {
      text = job.summary || "";
      actions = [archiveButton("start", "留档到桌面", { disabled: busy }), archiveButton("cancel", "不留档", { disabled: busy })];
    } else if (phase === "querying") {
      text = copy?.FILL_ARCHIVE_QUERYING || "";
      // The only way out of a lookup is giving up on it; it reaches the page even while the
      // lookup itself is still waiting.
      actions = [archiveButton("cancel", "取消留档", { disabled: job.phase !== "querying" })];
    } else if (phase === "choosing") {
      title = copy?.FILL_ARCHIVE_CHOOSE || "";
      hint = "选好之后才会写入桌面；只有一条也需要你确认，插件不会替你选。";
      candidates = (job.candidates || []).map((candidate) =>
        `<button type="button" data-application-id="${escapeHtml(candidate.applicationId)}"${busy ? " disabled" : ""}>${escapeHtml(candidate.label)}</button>`).join("");
      actions = [archiveButton("later", "稍后处理", { disabled: busy }), archiveButton("cancel", "取消留档", { disabled: busy })];
    } else if (phase === "empty") {
      text = result?.text || "";
      hint = result?.hint || "";
      actions = [
        archiveButton("savejob", "保存岗位到桌面端", { disabled: busy }),
        archiveButton("requery", "重新查找", { disabled: busy }),
        archiveButton("later", "稍后在待同步中选择", { disabled: busy }),
        archiveButton("cancel", "取消留档", { disabled: busy })
      ];
    } else if (phase === "blocked") {
      text = result?.text || "";
      hint = result?.hint || "";
      actions = job.canQueue
        ? [archiveButton("later", "记入待同步，稍后选择", { disabled: busy }), archiveButton("requery", "重新查找", { disabled: busy }),
          archiveButton("cancel", "取消留档", { disabled: busy })]
        : [...(result?.extensionId ? [archiveButton("copyid", "复制扩展 ID")] : []), archiveButton("cancel", "知道了", { disabled: busy })];
    } else if (phase === "saving") {
      text = (savingKind === "bind" ? copy?.FILL_ARCHIVE_SAVING : copy?.FILL_ARCHIVE_QUEUEING) || "";
    } else {
      text = result?.text || "";
      hint = result?.hint || "";
      const queueLabel = { pending_bind: "去待同步选择申请", queued: "去待同步查看", unknown: "去待同步核对", failed: "去待同步处理" }[phase];
      if (queueLabel && (phase !== "failed" || job.recordKept)) actions.push(archiveButton("openqueue", queueLabel));
      if (phase === "pending_bind") actions.push(archiveButton("remove", "删除这条待同步记录", { disabled: busy }));
      actions.push(archiveButton("dismiss", "知道了", { disabled: busy }));
    }
    const tone = ["offer", "querying", "choosing", "saving"].includes(phase) ? "" : (result?.tone || "info");
    elements.fillOffer.className = `offer-card${tone ? ` is-${tone}` : ""}`;
    elements.fillOfferTitle.hidden = !title;
    elements.fillOfferTitle.textContent = title;
    elements.fillOfferText.hidden = !text;
    elements.fillOfferText.textContent = text;
    elements.fillOfferHint.hidden = !hint;
    elements.fillOfferHint.textContent = hint;
    // The box is the user's choice for this offer only; once the lookup starts it is decided.
    elements.fillOfferCheck.hidden = phase !== "offer";
    elements.fillOfferSnapshot.disabled = !job.snapshotAvailable || busy;
    elements.fillOfferCandidates.hidden = !candidates;
    elements.fillOfferCandidates.innerHTML = candidates;
    const extensionId = phase === "blocked" ? result?.extensionId || "" : "";
    elements.fillOfferExtensionId.hidden = !extensionId;
    elements.fillOfferExtensionId.textContent = extensionId;
    const snapshotLine = phase === "saved" && job.snapshotId ? describeArchiveSnapshot(job.snapshotId) : "";
    elements.fillOfferSnapshotState.hidden = !snapshotLine;
    elements.fillOfferSnapshotState.textContent = snapshotLine;
    elements.fillOfferActions.innerHTML = actions.join("");
  }

  // The template copy of a fill that reached the desktop uploads afterwards, on its own. Its
  // real state comes from the pending list; it says "uploaded" only after it was seen queued.
  function describeArchiveSnapshot(snapshotId) {
    const copy = linkCopyModule;
    if (!copy) return "";
    let current = snapshotId;
    for (let hops = 0; snapshotsReplaced.has(current) && hops < 8; hops += 1) current = snapshotsReplaced.get(current);
    const entry = (queueReply?.outbox || []).find((item) => item?.messageType === "snapshot.upload" && item.snapshotId === current) || null;
    return copy.describeFillSnapshotProgress(entry, {
      seen: snapshotsSeen.has(current),
      queried: snapshotQueryNeeded.id === snapshotId && queueReadCompleted >= snapshotQueryNeeded.request,
      dropped: snapshotsDropped.has(current), confirmed: snapshotsConfirmed.has(current)
    }).text;
  }

  // One request at a time from the card; the page refuses a second write on its own too.
  // Cancelling a lookup is the exception: it has to reach the page while the lookup is still
  // waiting, and once it is done the card is free again.
  async function archiveRequest(message, { interrupt = false } = {}) {
    if (archivePending && !interrupt) return null;
    const mine = interrupt ? 0 : ++archiveOwner;
    if (!interrupt) archivePending = message.type;
    renderFillArchive();
    const tabId = currentTabId;
    try {
      const result = await sendToPage(message);
      if (interrupt && result?.ok) {
        // The overtaken request no longer owns the lock; its late answer is only a snapshot,
        // which the version check files in order.
        archiveOwner += 1;
        archivePending = "";
      }
      // An answer for another tab's page must not draw over the tab that is in front now.
      if (result?.fillArchive && tabId === currentTabId) applyFillArchive(result.fillArchive, tabId);
      return result;
    } finally {
      if (!interrupt && archiveOwner === mine) archivePending = "";
      renderFillArchive();
    }
  }

  async function archiveAction(action, extra = {}) {
    const job = fillArchive;
    if (!job?.archiveId) return;
    const archiveId = job.archiveId;
    if (action === "start") {
      const request = archiveRequest({ type: "RESUME_PANEL_ARCHIVE_START", archiveId, withSnapshot: elements.fillOfferSnapshot.checked });
      // The lookup's progress is in the page's snapshot already; fetch it now, not at the next tick.
      pollStatus().catch(() => {});
      const result = await request;
      if (result && !result.ok) toast(result.error || "没能开始留档，请稍后再试。");
    } else if (action === "cancel") {
      // Giving up on a question says so; "不留档" on the offer and "知道了" on a dead end do not.
      const asking = ["querying", "choosing", "empty"].includes(job.phase) || (job.phase === "blocked" && job.canQueue);
      const result = await archiveRequest({ type: "RESUME_PANEL_ARCHIVE_CANCEL", archiveId }, { interrupt: job.phase === "querying" });
      if (result?.ok && asking) toast("已取消留档，没有创建任何记录。");
      else if (result && !result.ok) toast(result.error || "当前无法取消。");
    } else if (action === "dismiss") {
      await archiveRequest({ type: "RESUME_PANEL_ARCHIVE_CANCEL", archiveId });
    } else if (action === "requery") {
      const request = archiveRequest({ type: "RESUME_PANEL_ARCHIVE_REQUERY", archiveId });
      pollStatus().catch(() => {});
      const result = await request;
      if (result && !result.ok) toast(result.error || "没能重新查找，请稍后再试。");
    } else if (action === "choose") {
      const result = await archiveRequest({ type: "RESUME_PANEL_ARCHIVE_CHOOSE", archiveId, applicationId: extra.applicationId });
      if (result && !result.ok) toast(result.error || "没能留档，请到「待同步」核对后再操作。");
      refreshQueue().catch(() => {});
    } else if (action === "later") {
      const result = await archiveRequest({ type: "RESUME_PANEL_ARCHIVE_LATER", archiveId });
      if (result && !result.ok) toast(result.error || "没能记入待同步，请稍后再试。");
      refreshQueue().catch(() => {});
    } else if (action === "remove") {
      const result = await archiveRequest({ type: "RESUME_PANEL_ARCHIVE_REMOVE", archiveId });
      if (result?.ok) toast("已删除这条待同步记录，这次填写没有留档。");
      else if (result) toast(result.error || "没能删除这条待同步记录。");
      refreshQueue().catch(() => {});
    } else if (action === "openqueue") {
      await openQueue(archiveId);
    } else if (action === "copyid") {
      toast(await copyFieldValue(chrome.runtime.id) ? "扩展 ID 已复制，请在桌面设置中粘贴。" : "复制失败。");
    } else if (action === "savejob") {
      // The panel's own job review (#172), exactly what its 保存岗位到桌面端 button starts —
      // never the page overlay's form. Nothing is created from here, and the fill still waits
      // for the user to pick the application afterwards (重新查找).
      const result = await jobRequest({ type: "RESUME_PANEL_SAVE_DRAFT" });
      if (result && !result.ok) toast(result.error || "无法读取当前网页的岗位信息。");
    }
  }

  // --- 待同步 (#178): the worker's existing queue, listed and handled in the panel ----------

  function formatClock(iso) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "稍后" : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // A snapshot upload rewrites the queue once per chunk. Reads that pile up while one is on
  // its way collapse into a single read after it, and the newest read always wins.
  let queueReading = null;
  let queueDirty = false;
  function refreshQueue() {
    if (queueReading) {
      queueDirty = true;
      return queueReading;
    }
    queueReading = (async () => {
      do {
        queueDirty = false;
        await readQueue();
      } while (queueDirty);
    })().finally(() => { queueReading = null; });
    return queueReading;
  }

  async function readQueue() {
    const request = ++queueRequest;
    let reply;
    let copy;
    try {
      [reply, copy] = await Promise.all([chrome.runtime.sendMessage({ type: "DESKTOP_LIST_QUEUE" }), linkCopy()]);
    } catch {
      return;
    }
    if (request !== queueRequest || !reply || reply.error) return;
    queueReply = reply;
    queueReadCompleted = request;
    for (const entry of reply.outbox || []) {
      if (entry?.messageType === "snapshot.upload" && entry.snapshotId) snapshotsSeen.add(entry.snapshotId);
    }
    for (const snapshotId of reply.uploadedSnapshots || []) snapshotsConfirmed.add(snapshotId);
    queueRows = self.ResumeProQueue.buildRows(reply, copy, { formatTime: formatClock });
    // A row that has left the list (sent, deleted) takes its open question with it.
    for (const key of [...queueUi.keys()]) {
      if (!queueRows.some((row) => row.key === key)) queueUi.delete(key);
    }
    renderQueue();
    renderFillArchive();
    followQueue();
  }

  // The card and the pending list must never disagree. Once the list has shown this fill, the
  // list is where its state lives: if it is no longer waiting (bound, sent or deleted — here or
  // in another window) while the card still says "尚未选择申请", or it has left the list while
  // the card still says it is queued, the card closes. It never guesses what happened instead.
  function followQueue() {
    const job = fillArchive;
    if (!job?.archiveId || archivePending) return;
    const rows = queueRows.filter((row) => row.recordId === job.archiveId);
    if (rows.length) archivesListed.add(job.archiveId);
    if (!archivesListed.has(job.archiveId)) return;
    const waiting = rows.some((row) => row.kind === "fill");
    const stale = (job.phase === "pending_bind" && !waiting)
      || (["queued", "unknown", "failed"].includes(job.phase) && rows.length === 0);
    if (!stale) return;
    if (!archivesTouched.has(job.archiveId)) toast("这次填写已经不在「待同步」里了（已发送，或在别处处理过），可以到桌面这条申请的时间线里核对。");
    archiveRequest({ type: "RESUME_PANEL_ARCHIVE_CANCEL", archiveId: job.archiveId }).catch(() => {});
  }

  function renderQueue() {
    const total = self.ResumeProQueue.queueTotal(queueReply);
    elements.queueCount.textContent = `${total} 条`;
    elements.queueToggle.classList.toggle("has-items", total > 0);
    elements.queueEmpty.hidden = queueRows.length > 0;
    elements.queueList.innerHTML = self.ResumeProQueue.renderRows(queueRows, queueUi, { focusKey: queueFocus });
  }

  function setQueueOpen(open) {
    elements.queueBody.hidden = !open;
    elements.queueToggle.setAttribute("aria-expanded", String(open));
  }

  // "去待同步…": open the list on the record this fill just made, wherever it is now (still
  // waiting for an application, or already bound and waiting to be sent).
  async function openQueue(recordId) {
    setQueueOpen(true);
    await refreshQueue();
    // One fill can have up to three rows (the waiting record, its bound event, its snapshot).
    // Land on the fill itself, not on its snapshot.
    const mine = queueRows.filter((item) => item.recordId === recordId);
    const row = ["fill", "message", "snapshot"].map((kind) => mine.find((item) => item.kind === kind)).find(Boolean);
    queueFocus = row?.key || "";
    renderQueue();
    if (!row) toast("待同步里已经没有这条记录了，可能已经发送或删除。");
    else elements.queueList.querySelector?.(`[data-key="${row.key}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function setRowUi(key, changes) {
    queueUi.set(key, { ...(queueUi.get(key) || {}), ...changes });
    renderQueue();
  }

  async function queueCall(key, message, fallback) {
    setRowUi(key, { busy: true, message: null });
    try {
      return (await chrome.runtime.sendMessage(message)) ?? fallback;
    } catch {
      return fallback;
    } finally {
      const open = queueUi.get(key);
      if (open) queueUi.set(key, { ...open, busy: false });
    }
  }

  async function queueAction(button) {
    const key = button.dataset.key;
    const row = queueRows.find((item) => item.key === key);
    if (!row || button.disabled || queueUi.get(key)?.busy) return;
    if (row.recordId) archivesTouched.add(row.recordId);
    const copy = await linkCopy();
    const action = button.dataset.queueAction;
    // The answer stays on the row; a row that left the list (sent, bound) says it in a toast.
    const done = async (message, extra = {}) => {
      setRowUi(key, { busy: false, message, ...extra });
      await refreshQueue();
      if (message?.text && !queueRows.some((item) => item.key === key)) toast(message.text);
    };

    if (action === "copy-id") {
      toast(await copyFieldValue(chrome.runtime.id) ? "扩展 ID 已复制，请在桌面设置中粘贴。" : "复制失败。");
      return;
    }

    if (action === "close-question") { setRowUi(key, { mode: "", candidates: [], message: null, typed: "" }); return; }

    if (action === "choose-fill") {
      if (!row.job.company) {
        // The page named no company, so there is nothing to look up: the id comes from the desktop.
        setRowUi(key, { mode: "id", idLabel: "这条留档看不出是哪家公司。请粘贴桌面里对应申请的 ID：", message: null, typed: "" });
        return;
      }
      const answer = await queueCall(key, { type: "DESKTOP_CANDIDATES_FOR", fields: row.job }, null);
      if (answer?.status !== "ok") {
        const mode = ["unavailable", "incompatible", "not_installed", "not_paired", "never_paired"].includes(answer?.status) ? answer.status : "unavailable";
        await done(copy.describeFillArchiveBlocked(mode, { extensionId: chrome.runtime.id }), { mode: "" });
        return;
      }
      const seen = new Set();
      const candidates = [...(answer.exact || []), ...(answer.sameCompany || [])]
        .filter((candidate) => typeof candidate?.applicationId === "string" && candidate.applicationId && !seen.has(candidate.applicationId) && seen.add(candidate.applicationId))
        .map((candidate) => ({ applicationId: candidate.applicationId, company: candidate.company, title: candidate.title, label: copy.describeApplicationChoice(candidate) }));
      if (!candidates.length) {
        const empty = copy.describeFillArchiveEmpty();
        setRowUi(key, { busy: false, mode: "", message: { tone: empty.tone, text: `${empty.text}请先保存岗位到桌面端，再回来选择。` } });
        return;
      }
      setRowUi(key, { busy: false, mode: "choices", candidates, allowNew: false, prompt: copy.FILL_ARCHIVE_CHOOSE, message: null });
      return;
    }

    if (action === "pick" && row.kind === "fill") {
      const candidate = (queueUi.get(key)?.candidates || []).find((item) => item.applicationId === button.dataset.applicationId);
      if (!candidate) return;
      const result = await queueCall(key, { type: "DESKTOP_BIND_FILL", recordId: row.recordId, applicationId: candidate.applicationId }, { status: "unknown" });
      const message = result?.status === "unknown" || result?.error
        ? { tone: "pending", text: copy.FILL_ARCHIVE_UNKNOWN }
        : copy.describeFillRecordResult(result, { application: candidate });
      await done(message, { mode: "", candidates: [] });
      return;
    }

    if (action === "submit-id") {
      const input = elements.queueList.querySelector?.(`input[data-key="${key}"]`);
      const typed = String(input?.value || "").trim();
      if (!self.ResumeProQueue.isApplicationId(typed)) {
        // Kept in the box: the list is redrawn, and one wrong character should not mean
        // pasting the whole id again.
        setRowUi(key, { typed, message: copy.describeFillRecordResult({ status: "rejected", reason: "invalid_application_id" }) });
        return;
      }
      if (row.kind === "fill") {
        const result = await queueCall(key, { type: "DESKTOP_BIND_FILL", recordId: row.recordId, applicationId: typed }, { status: "unknown" });
        await done(result?.status === "unknown" ? { tone: "pending", text: copy.FILL_ARCHIVE_UNKNOWN } : copy.describeFillRecordResult(result), { mode: "" });
      } else {
        const result = await queueCall(key, { type: "DESKTOP_RESOLVE", messageId: row.messageId, choice: "associate", applicationId: typed }, { status: "pending" });
        await done(copy.describeQueueOutcome({ messageType: row.messageType }, result), { mode: "" });
      }
      return;
    }

    if (action === "remove-fill") {
      const result = await queueCall(key, { type: "DESKTOP_REMOVE_FILL", recordId: row.recordId }, null);
      if (result?.ok) toast("已删除这条待同步记录。");
      else setRowUi(key, { message: { tone: "warn", text: "这条留档已经不在待同步里了，可能已经发送过。" } });
      await refreshQueue();
      return;
    }

    if (action === "drop-snapshot") {
      const snapshotId = button.dataset.snapshotId || row.snapshotId;
      const result = await queueCall(key, { type: "DESKTOP_DROP_SNAPSHOT", snapshotId }, null);
      if (result?.ok) {
        snapshotsDropped.add(snapshotId);
        toast("已丢弃这份简历快照，填写记录不受影响。");
      } else {
        setRowUi(key, { message: { tone: "warn", text: "没能丢弃这份简历快照，请稍后再试。" } });
      }
      await refreshQueue();
      return;
    }

    if (action === "continue-intent") {
      const result = await queueCall(key, { type: "DESKTOP_CONTINUE_SAVE", intentId: row.intentId }, { status: "unknown" });
      if (result?.status === "needs_choice") {
        const candidates = (result.exact || []).filter((candidate) => typeof candidate?.applicationId === "string")
          .map((candidate) => ({ applicationId: candidate.applicationId, label: `使用已有：${copy.describeApplicationChoice(candidate)}` }));
        setRowUi(key, { busy: false, mode: "choices", candidates, allowNew: true, prompt: "这可能是同一个岗位。要使用已有申请，还是另存为新的？", message: null });
        return;
      }
      await done(self.ResumeProQueue.describeContinueResult(copy, result), { mode: "" });
      return;
    }

    if ((action === "pick" || action === "pick-new") && row.kind === "intent") {
      const applicationId = action === "pick" ? (queueUi.get(key)?.candidates || []).find((item) => item.applicationId === button.dataset.applicationId)?.applicationId : null;
      if (action === "pick" && !applicationId) return;
      const result = await queueCall(key, { type: "DESKTOP_BIND", intentId: row.intentId, applicationId }, { status: "unknown" });
      await done(copy.describeBindResult(result), { mode: "", candidates: [] });
      return;
    }

    if (action === "remove-intent") {
      const result = await queueCall(key, { type: "DESKTOP_REMOVE_INTENT", intentId: row.intentId }, null);
      if (result?.ok) toast("已删除这条待同步记录。");
      else setRowUi(key, { message: { tone: "warn", text: "没能删除这条待同步记录，请稍后再试。" } });
      await refreshQueue();
      return;
    }

    if (action === "retry") {
      const entry = (queueReply?.outbox || []).find((item) => item.messageId === row.messageId) || { messageType: row.messageType };
      const result = await queueCall(key, { type: "DESKTOP_RETRY", messageId: row.messageId }, { status: "pending" });
      await done(copy.describeQueueOutcome(entry, result));
      return;
    }

    if (action === "cancel-message") {
      // Cancelling a bound fill gives up the snapshot bound with it too (router: MSG.cancel).
      const related = (queueReply?.outbox || [])
        .filter((item) => item?.messageType === "snapshot.upload" && (item.messageId === row.messageId || (row.recordId && item.recordId === row.recordId)))
        .map((item) => item.snapshotId);
      const result = await queueCall(key, { type: "DESKTOP_CANCEL", messageId: row.messageId }, null);
      if (result?.ok) related.forEach((snapshotId) => snapshotsDropped.add(snapshotId));
      else setRowUi(key, { message: { tone: "warn", text: "没能取消，请稍后再试。" } });
      await refreshQueue();
      return;
    }

    if (action === "resolve-associate") {
      setRowUi(key, { mode: "id", idLabel: "要关联到哪条申请？请粘贴桌面里的申请 ID：", message: null, typed: "" });
      return;
    }

    if (action === "resolve-resave" || action === "resolve-discard") {
      const choice = action === "resolve-resave" ? "resave" : "discard";
      const entry = (queueReply?.outbox || []).find((item) => item.messageId === row.messageId) || {};
      const result = await queueCall(key, { type: "DESKTOP_RESOLVE", messageId: row.messageId, choice }, { status: "pending" });
      if (row.kind === "snapshot" && row.snapshotId) {
        if (result?.status === "discarded") snapshotsDropped.add(row.snapshotId);
        if (result?.status === "queued" && result.messageId) {
          await refreshQueue();
          const moved = (queueReply?.outbox || []).find((item) => item?.messageId === result.messageId);
          if (moved?.snapshotId) snapshotsReplaced.set(row.snapshotId, moved.snapshotId);
        }
      }
      // A resaved entry is queued, not yet on the desktop: described as pending.
      const shown = result?.status === "queued" ? { status: "pending" } : result;
      await done(choice === "discard" ? null : copy.describeQueueOutcome(entry, shown));
    }
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
    if (!next) jobLocalError = "";
    renderJobSave();
  }

  // Phases that need the user's attention before anything else on this page may start.
  const SUBMIT_ACTIVE = new Set([
    "extracting", "assist", "review", "querying", "choosing", "confirming",
    "confirmed", "empty", "unavailable", "failed", "unknown"
  ]);
  const SUBMIT_BACK_PHASES = new Set(["choosing", "empty", "unavailable", "failed", "unknown"]);

  function applySubmitConfirm(snapshot, tabId = currentTabId) {
    if (!snapshot) {
      submitConfirm = null;
      renderJobSave();
      return;
    }
    // An older answer from this page load is not news: it may predate a click or a cancel.
    if (submitSeen.tabId === tabId && submitSeen.epoch === snapshot.epoch && snapshot.version < submitSeen.version) return;
    submitSeen = { tabId, epoch: snapshot.epoch, version: snapshot.version };
    const next = snapshot.confirmId ? snapshot : null;
    if (!next && submitConfirm && snapshot.discarded === "page-changed") {
      toast("网页已经换成别的页面，刚才核对的内容已作废。请重新点「确认已投递」。");
    }
    submitConfirm = next ? { ...next, tabId } : null;
    if (!next) submitLocalError = "";
    renderJobSave();
  }

  function renderSubmitConfirm() {
    const job = submitConfirm;
    const phase = job?.phase || "idle";
    const noPage = currentTabId === null;
    const jobActive = JOB_ACTIVE.has(jobSave?.phase || "idle");
    elements.submitButton.hidden = SUBMIT_ACTIVE.has(phase) || jobActive;
    elements.submitButton.disabled = noPage || jobPending;
    elements.submitButton.title = noPage ? "当前网页没有连接填表助手，无法确认投递。" : "";

    elements.submitProgress.hidden = !(phase === "extracting" || phase === "assist" || phase === "querying" || phase === "confirming");
    if (phase === "extracting" || phase === "querying" || phase === "confirming") {
      elements.submitProgressText.textContent = phase === "confirming" ? "正在确认投递……"
        : phase === "querying" ? "正在查找对应的投递记录……" : "正在读取当前网页的岗位信息……";
      elements.submitProgressCount.textContent = "";
      elements.submitFragments.innerHTML = "";
      // Once the confirmation is on its way to the desktop it cannot be recalled.
      elements.submitStop.hidden = phase === "confirming";
    } else if (phase === "assist") {
      const count = job.assist?.count || 0;
      elements.submitProgressText.textContent = "正在识别岗位…";
      elements.submitProgressCount.textContent = `页面上的公司或岗位不好确定，已向桌面的 AI 发送 ${count} 段页面文字：`;
      elements.submitFragments.innerHTML = (job.assist?.lines || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
      elements.submitStop.hidden = false;
    }

    const showForm = phase === "review";
    elements.submitForm.hidden = !showForm;
    if (showForm) {
      const key = `${job.confirmId}:${job.revision}`;
      if (submitFilled !== key) {
        submitFilled = key;
        submitLocalError = "";
        elements.submitCompany.removeAttribute?.("aria-invalid");
        elements.submitTitle.removeAttribute?.("aria-invalid");
        elements.submitCompany.value = job.fields?.company || "";
        elements.submitTitle.value = job.fields?.title || "";
      }
      // Always the page's redacted URL; the input is read-only and never read back.
      elements.submitUrl.value = job.fields?.sourceUrl || "";
      elements.submitUrl.title = job.fields?.sourceUrl || "";
      elements.submitNote.textContent = job.note || "";
      const error = job.error || submitLocalError;
      elements.submitError.hidden = !error;
      elements.submitError.textContent = error;
      elements.submitOpenAi.hidden = job.openView !== "settings-ai";
      elements.submitQuery.disabled = jobPending;
      elements.submitReviewCancel.disabled = jobPending;
      elements.submitCompany.disabled = jobPending;
      elements.submitTitle.disabled = jobPending;
    }

    elements.submitChoice.hidden = phase !== "choosing";
    if (phase === "choosing") {
      elements.submitCandidates.innerHTML = (job.candidates || []).map((candidate) =>
        `<button type="button" data-application-id="${escapeHtml(candidate.applicationId)}">${escapeHtml(candidate.label)}</button>`).join("");
      elements.submitCandidates.querySelectorAll?.("button").forEach((button) => { button.disabled = jobPending; });
      elements.submitBack.disabled = jobPending;
      elements.submitCancel.disabled = jobPending;
    }

    const showResult = Boolean(job?.result) && ["empty", "confirmed", "unavailable", "unknown", "failed"].includes(phase);
    elements.submitResult.hidden = !showResult;
    if (showResult) {
      elements.submitResult.className = `job-card is-${job.result.tone || "info"}`;
      elements.submitResultText.textContent = job.result.text || "";
      elements.submitResultHint.hidden = !job.result.hint;
      elements.submitResultHint.textContent = job.result.hint || "";
      elements.submitSave.hidden = phase !== "empty";
      elements.submitSave.disabled = jobPending;
      elements.submitResultBack.hidden = !SUBMIT_BACK_PHASES.has(phase);
      elements.submitResultBack.disabled = jobPending;
      elements.submitCopyId.hidden = !job.result.extensionId;
      elements.submitDismiss.textContent = phase === "empty" ? "取消" : "知道了";
    }
  }

  function renderJobSave() {
    const job = jobSave;
    const phase = job?.phase || "idle";
    const active = JOB_ACTIVE.has(phase);
    // A confirmation waiting for the user (or a "not saved yet" answer) owns this area: two
    // different questions are never open at once.
    elements.jobSaveButton.hidden = active || SUBMIT_ACTIVE.has(submitConfirm?.phase || "idle");
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
        jobLocalError = "";
        // A new or re-recognised draft starts with no red borders left over from the last one.
        elements.jobCompany.removeAttribute?.("aria-invalid");
        elements.jobTitle.removeAttribute?.("aria-invalid");
        elements.jobCompany.value = job.fields?.company || "";
        elements.jobTitle.value = job.fields?.title || "";
        elements.jobLocation.value = job.fields?.location || "";
      }
      // Always the page's redacted URL; the input is read-only and never read back.
      elements.jobUrl.value = job.fields?.sourceUrl || "";
      elements.jobUrl.title = job.fields?.sourceUrl || "";
      elements.jobNote.textContent = job.note || "";
      const error = job.error || jobLocalError;
      elements.jobError.hidden = !error;
      elements.jobError.textContent = error;
      elements.jobOpenAi.hidden = job.openView !== "settings-ai";
      const saving = phase === "saving" || jobPending;
      elements.jobConfirm.disabled = saving;
      elements.jobConfirm.textContent = saving ? "正在保存…" : "确定保存";
      elements.jobCancel.disabled = saving;
      elements.jobReassist.disabled = saving;
      elements.jobCompany.disabled = saving;
      elements.jobTitle.disabled = saving;
      elements.jobLocation.disabled = saving;
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
    renderSubmitConfirm();
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
      if (result?.submitConfirm && tabId === currentTabId) applySubmitConfirm(result.submitConfirm, tabId);
      return result;
    } finally {
      if (owner && jobOwner === mine) jobPending = false;
      renderJobSave();
    }
  }

  // 保存到「我的信息」（#189）。候选、值和结果都是网页那边的快照；这里只记用户改过的勾选，
  // 没动过的跟着快照的默认走，所以用户在网页上又填了几项，新出现的项按默认勾选，已取消的不会被勾回去。
  let profileOffer = null;
  let profileChoices = new Map();
  let profileOfferKey = "";
  let profileSavePending = false;
  let profileRenderSig = "";
  const PROFILE_PREVIEW_CHARS = 80;
  const profileItems = () => !profileOffer ? [] : [
    ...profileOffer.filled.map((item) => ({ ...item, kind: "filled" })),
    ...profileOffer.pending.map((item) => ({ ...item, kind: "pending" })),
    ...profileOffer.conflicts.map((item) => ({ ...item, kind: "conflict" }))
  ];
  const profileChecked = (item) => profileChoices.has(item.id) ? profileChoices.get(item.id) : Boolean(item.defaultSelected);

  function setProfileOffer(snapshot) {
    const key = snapshot ? `${currentTabId}:${snapshot.epoch}:${snapshot.version}` : "";
    if (key !== profileOfferKey) { profileChoices = new Map(); profileOfferKey = key; }
    profileOffer = snapshot || null;
    renderProfileOffer();
  }

  function profileRow(item) {
    const preview = (value) => value.length > PROFILE_PREVIEW_CHARS ? `${value.slice(0, PROFILE_PREVIEW_CHARS)}…` : value;
    const lines = [];
    if (item.kind === "conflict") {
      lines.push(`<span class="profile-item__value" title="${escapeHtml(item.existing)}">桌面：${escapeHtml(preview(item.existing))}</span>`);
      lines.push(`<span class="profile-item__value" title="${escapeHtml(item.value)}">网页：${escapeHtml(preview(item.value))}</span>`);
    } else if (item.kind === "filled") {
      lines.push(`<span class="profile-item__value" title="${escapeHtml(item.value)}">${escapeHtml(preview(item.value))}</span>`);
    }
    if (item.completes) lines.push('<em class="profile-item__tag">桌面里已有这个待补充项，会补上内容</em>');
    if (item.jobSpecific) lines.push('<em class="profile-item__tag">可能只适用于当前岗位，默认不勾选</em>');
    if (item.unreadable) lines.push('<em class="profile-item__tag">网页上已有内容但读不准，只保存字段名</em>');
    return `<label class="profile-item"><input type="checkbox" data-profile-id="${escapeHtml(item.id)}"${profileChecked(item) ? " checked" : ""}${profileSavePending || profileOffer?.saving ? " disabled" : ""}>`
      + `<span class="profile-item__body"><span class="profile-item__key">${escapeHtml(item.key)}</span>${lines.join("")}</span></label>`;
  }

  function renderProfileOffer() {
    const offer = profileOffer;
    elements.profileOffer.hidden = !offer;
    if (!offer) { profileRenderSig = ""; return; }
    const items = profileItems();
    const selected = items.filter(profileChecked);
    const busy = profileSavePending || Boolean(offer.saving);
    const result = offer.result;
    const completed = Boolean(result?.saved > 0);
    elements.profileOffer.classList.toggle("is-done", completed);
    const signature = JSON.stringify([offer, [...profileChoices], busy, desktopMode]);
    if (signature === profileRenderSig) return;
    profileRenderSig = signature;
    const filled = items.filter((item) => item.kind === "filled");
    const pending = items.filter((item) => item.kind === "pending");
    const conflicts = items.filter((item) => item.kind === "conflict");
    const savedItems = Array.isArray(result?.savedItems) ? result.savedItems : [];
    const savedContent = savedItems.filter((item) => item.kind !== "pending");
    const savedQuestions = savedItems.length - savedContent.length;
    if (completed) {
      const only = savedContent.length === 1 && savedItems.length === 1 ? savedContent[0] : null;
      const value = only?.value?.length > 24 ? `${only.value.slice(0, 24)}…` : only?.value;
      elements.profileOfferText.textContent = only
        ? `已记住「${only.key}：${value}」`
        : savedContent.length
          ? `已记住 ${savedContent.length} 项内容${savedQuestions ? `，另记下 ${savedQuestions} 个问题` : ""}`
          : `已记下 ${savedQuestions || result.saved} 个问题`;
    } else {
      elements.profileOfferText.textContent = !items.length && result?.text ? result.text : filled.length
        ? "要记住这次填写的内容吗？"
        : conflicts.length
          ? "网页内容与桌面已有内容不同"
          : `还有 ${pending.length} 个问题需要你填写`;
    }
    elements.profileOfferIntro.hidden = completed || !items.length;
    elements.profileOfferIntro.textContent = filled.length
      ? "保存后，下次遇到相同问题可以使用。"
      : conflicts.length
        ? "桌面原内容会保留；只有你选中时才会替换。"
        : "在网页填好后，这里会自动显示可保存的答案。";
    elements.profileOfferResult.hidden = !result;
    if (result) {
      elements.profileOfferResult.className = `profile-result is-${result.kind}`;
      elements.profileOfferResult.innerHTML = completed
        ? `<span>${escapeHtml(savedContent.length ? "已保存到桌面「我的信息」，下次填写可以使用。" : "已保存到桌面「我的信息」；补上答案后，下次填写可以使用。")}</span>`
          + (result.kind === "partial" ? `<span>${escapeHtml(result.text)}</span>` : "")
          + (result.hint && (result.kind === "partial" || result.hint.includes("暂时没能重新读取")) ? `<span>${escapeHtml(result.hint)}</span>` : "")
          + (result.details?.length ? `<ul>${result.details.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : "")
        : `<strong>${escapeHtml(result.text)}</strong>`
          + (result.hint ? `<span>${escapeHtml(result.hint)}</span>` : "")
        + (result.details?.length ? `<ul>${result.details.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : "");
    }

    elements.profileOfferDetail.hidden = completed || !items.length;
    const focused = document.activeElement?.dataset?.profileId;
    const openMore = new Set(Array.from(elements.profileOfferGroups.querySelectorAll?.("details.profile-more[open]") || [])
      .map((detail) => detail.dataset.profileMore));
    const more = (kind, list, title, hint) => !list.length ? ""
      : `<details class="profile-more" data-profile-more="${kind}"${openMore.has(kind) ? " open" : ""}>`
        + `<summary>${title}</summary>`
        + `<p class="profile-group__hint">${hint}</p>`
        + `<div class="profile-items">${list.map(profileRow).join("")}</div></details>`;
    elements.profileOfferGroups.innerHTML = completed ? "" : [
      filled.length ? `<div class="profile-items profile-items--filled">${filled.map(profileRow).join("")}</div>` : "",
      more("pending", pending, filled.length
        ? `还有 ${pending.length} 个问题没填 · 稍后处理`
        : `查看这 ${pending.length} 个问题`, "只记下问题名称；在网页填好后，这里会自动出现可保存的答案。"),
      more("conflict", conflicts, `桌面已有 ${conflicts.length} 项不同内容`, "默认保留桌面原内容；勾选后才会用网页内容替换。")
    ].join("");
    if (focused) {
      Array.from(elements.profileOfferGroups.querySelectorAll?.("input[data-profile-id]") || [])
        .find((box) => box.dataset.profileId === focused)?.focus?.();
    }

    const notes = [...offer.notes.slice(0, 5), ...(offer.notes.length > 5 ? [`还有 ${offer.notes.length - 5} 项不能保存的字段。`] : []),
      ...(offer.same ? [`${offer.same} 项桌面里已经有相同内容，不会重复保存。`] : []),
      ...(offer.hidden ? [`还有 ${offer.hidden} 项没有列出。`] : [])];
    elements.profileOfferNotes.hidden = completed || !notes.length;
    elements.profileOfferNotes.innerHTML = notes.map(escapeHtml).join("<br>");

    elements.profileOfferSave.hidden = completed || !items.length || (!selected.length && !filled.length && !conflicts.length);
    elements.profileOfferSkip.hidden = completed || !items.length;
    elements.profileOfferSave.textContent = busy ? "正在保存…" : !selected.length
      ? "选择要保存的内容"
      : selected.every((item) => item.kind === "pending")
        ? `记录这 ${selected.length} 个问题`
        : `记住这 ${selected.length} 项`;
    elements.profileOfferSave.disabled = busy || !selected.length || desktopMode !== "ready";
    elements.profileOfferSkip.disabled = busy;
    elements.profileOfferView.hidden = !completed;
    elements.profileOfferDismiss.hidden = !result;
    elements.profileOfferDismiss.textContent = completed ? "完成" : "关闭提示";
  }

  // 一次点击就保存勾选的项，不再二次确认；写入由页面那边在点击时重新读网页和桌面后完成。
  async function saveProfileOffer() {
    if (!profileOffer || profileSavePending) return;
    const selected = profileItems().filter(profileChecked).map((item) => ({
      id: item.id, key: item.key, kind: item.kind, ...(item.kind === "conflict" ? { replaceOf: item.existing } : {})
    }));
    if (!selected.length) return;
    profileSavePending = true;
    renderProfileOffer();
    let reply = null;
    try {
      reply = await sendToPage({ type: "RESUME_PANEL_OFFER", action: "profileAdd", version: profileOffer.version, selected });
    } finally {
      profileSavePending = false;
    }
    if (reply?.profileOffer) setProfileOffer(reply.profileOffer);
    else {
      renderProfileOffer();
      toast(reply?.error || "保存没有完成，候选还在，请稍后再试。");
    }
    // 保存成功后侧栏也改读桌面的最新档案，下次填写和「简历字段」页看到的就是它。
    if (reply?.saved > 0) await loadStore();
    await pollStatus();
  }

  async function pollStatus() {
    // A poll asked for while one is running is not lost: it runs again once this one ends.
    if (statusPolling) { statusRepoll = true; return; }
    statusPolling = true;
    try {
      const epoch = tabEpoch;
      const tab = await activeTab();
      const nextTabId = tab?.id || null;
      if (nextTabId !== currentTabId) {
        elements.fillResult.hidden = true;
        elements.fillResult.textContent = "";
        jobSave = null;
        jobFilled = "";
        jobLocalError = "";
        submitConfirm = null;
        submitSeen = { tabId: null, epoch: "", version: 0 };
        // A request still waiting on the tab we left must not keep this tab's button locked,
        // and its answer is dropped by the tab check in jobRequest.
        jobOwner += 1;
        jobPending = false;
        clearTargetState();
        clearRepeat();
        resetFillArchive();
        profileOfferKey = "";
        setProfileOffer(null);
      }
      currentTabId = nextTabId;
      const polledTabId = currentTabId;
      const polledJobOwner = jobOwner;
      const response = await sendToPage({ type: "RESUME_PANEL_STATUS" }, polledTabId);
      // The tab in front may have changed while the page was answering. That answer is about
      // the tab we left and must not be drawn over the new one. The epoch also catches a
      // switch away and back (A → B → A) that the front-tab check alone cannot see.
      const front = await activeTab();
      if ((front?.id || null) !== polledTabId || epoch !== tabEpoch) { statusRepoll = true; return; }
      const connected = Boolean(response?.ready);
      elements.pageState.textContent = connected ? "当前网页已连接填表助手" : "当前页面无法使用填表助手";
      elements.pageState.classList.toggle("is-unavailable", !connected);
      if (!connected) currentTabId = null;
      lastPageStatus = connected ? response : null;
      updateFillAvailability(lastPageStatus);
      renderJobAssist(connected ? response.jobAssist : null);
      // Applied even while a click is waiting: recognition progress only arrives this way.
      // Older snapshots of the same draft are dropped by their version.
      if (jobOwner === polledJobOwner) {
        applyJobSave(connected ? response.jobSave : null, currentTabId);
        applySubmitConfirm(connected ? response.submitConfirm : null, currentTabId);
      } else {
        // A user action produced a newer draft while this poll was in flight. Ask again rather
        // than letting the old response clear or resurrect the newer state.
        statusRepoll = true;
      }
      repeatView = connected ? normalizeRepeat(response.repeat) : null;
      renderRepeat();
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
        // While a save is on its way its own answer is the newest word; an older poll must not redraw over it.
        if (!profileSavePending) setProfileOffer(response.profileOffer || null);
        applyFillArchive(response.fillArchive || null, polledTabId);
        elements.desktopStatus.hidden = !response.desktopStatus;
        elements.desktopStatus.textContent = response.desktopStatus || "";
        elements.diagnostics.hidden = !response.diagnostics;
        if (elements.diagnosticsText.value !== (response.diagnostics || "")) {
          elements.diagnosticsText.value = response.diagnostics || "";
        }
      } else {
        setProfileOffer(null);
        resetFillArchive();
        elements.desktopStatus.hidden = true;
        elements.diagnostics.hidden = true;
      }
      await refreshTarget();
    } finally {
      statusPolling = false;
      if (statusRepoll) {
        statusRepoll = false;
        pollStatus().catch(() => {});
      }
    }
    // While 辅助新增 runs, follow it more closely than the idle interval.
    clearTimeout(repeatPollTimer);
    if (repeatView && REPEAT_ACTIVE.includes(repeatView.phase)) {
      repeatPollTimer = setTimeout(() => { pollStatus().catch(() => {}); }, 500);
    }
  }

  async function loadStore({ periodic = false } = {}) {
    const sequence = ++storeReadSequence;
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_READ" });
    } catch {
      result = null;
    }
    if (sequence !== storeReadSequence) return;
    // A periodic refresh looks for new data, not connection health. A transient native
    // messaging failure must not erase the fields the user is currently browsing.
    if (periodic && result?.status !== "ok" && storeLoaded) return;
    const nextMode = result?.status === "ok" ? "ready" : result?.status || "unavailable";
    const nextStore = result?.status === "ok" ? self.ResumeProResumeData.normalize(result.data) : null;
    const nextSnapshot = JSON.stringify(nextStore);
    const changed = !storeLoaded || desktopMode !== nextMode || storeSnapshot !== nextSnapshot;
    desktopMode = nextMode;
    currentStore = nextStore;
    storeSnapshot = nextSnapshot;
    storeLoaded = true;
    if (changed) renderFromStore();
  }

  document.querySelectorAll(".dock-tabs button").forEach((button) => button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    document.querySelectorAll(".dock-tabs button").forEach((item) => item.setAttribute("aria-selected", String(item.dataset.tab === tab)));
    document.querySelectorAll(".dock-view").forEach((view) => { view.hidden = view.dataset.view !== tab; });
  }));
  document.getElementById("show-fields").addEventListener("click", () => document.querySelector('.dock-tabs button[data-tab="fields"]').click());
  elements.fieldSearch.addEventListener("input", () => filterFields());
  elements.fieldGroups.addEventListener("toggle", (event) => {
    if (event.target.matches?.(".field-group") && event.target.open && !elements.fieldSearch.value) {
      elements.fieldGroups.querySelectorAll(".field-group").forEach((group) => { if (group !== event.target) group.open = false; });
    }
  }, true);
  elements.templateSelect.addEventListener("change", async () => {
    // A plan made for the old template must not run with the new one.
    await sendToPage({ type: "RESUME_PANEL_REPEAT", action: "invalidate" }).catch(() => {});
    const result = await chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_UPDATE", op: "setActiveTemplate", templateId: elements.templateSelect.value });
    await loadStore();
    toast(result?.status === "missing_template" ? "这个模板在桌面里已经删掉了" : result?.status === "ok" ? "当前模板已切换。" : "桌面暂时无法切换模板。");
  });
  elements.copyDiagnostics.addEventListener("click", async () => {
    toast(await copyFieldValue(elements.diagnosticsText.value)
      ? "填写诊断已复制，可以粘贴到反馈里。"
      : "复制失败，请手动选中诊断文字复制。");
  });
  elements.fillButton.addEventListener("click", async () => {
    elements.fillResult.hidden = true;
    const result = await sendToPage({ type: "RESUME_PANEL_FILL" });
    if (!result?.ok) toast(result?.error || "无法开始填写。");
    await pollStatus();
  });
  elements.repeatButton.addEventListener("click", () => {
    if (elements.repeatButton.disabled) return;
    repeatAction("start").catch(() => toast("无法开始辅助新增。"));
  });
  elements.repeatConfirm.addEventListener("click", () => { repeatAction("confirm").catch(() => {}); });
  elements.repeatCancel.addEventListener("click", () => { repeatAction("cancel").catch(() => {}); });
  elements.repeatStop.addEventListener("click", () => { repeatAction("stop").catch(() => {}); });
  elements.repeatDismiss.addEventListener("click", () => { repeatAction("dismiss").catch(() => {}); });
  elements.cancelButton.addEventListener("click", async () => {
    const result = await sendToPage({ type: "RESUME_PANEL_CANCEL" });
    if (!result?.ok) toast(result?.error || "当前无法取消。");
    await pollStatus();
  });
  document.querySelectorAll("[data-offer]").forEach((button) => button.addEventListener("click", async () => {
    const action = button.dataset.offer;
    if (action === "profileAdd") { await saveProfileOffer(); return; }
    const result = await sendToPage({ type: "RESUME_PANEL_OFFER", action });
    if (!result?.ok) toast(result?.error || "操作未完成，请查看网页。");
    else setProfileOffer("profileOffer" in result ? result.profileOffer : null);
    await pollStatus();
  }));
  elements.profileOfferGroups.addEventListener("change", (event) => {
    const box = event.target?.closest?.("input[data-profile-id]");
    if (!box) return;
    profileChoices.set(box.dataset.profileId, Boolean(box.checked));
    renderProfileOffer();
  });
  elements.profileOfferGroups.addEventListener("click", (event) => {
    const toggle = event.target?.closest?.("button[data-profile-group]");
    if (!toggle) return;
    const list = profileItems().filter((item) => item.kind === toggle.dataset.profileGroup);
    const allChecked = list.every(profileChecked);
    list.forEach((item) => profileChoices.set(item.id, !allChecked));
    renderProfileOffer();
  });
  elements.profileOfferView.addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({ type: "DESKTOP_OPEN_VIEW", view: "resume" }).catch(() => null);
    if (result?.status !== "ok") toast("桌面程序暂时无法打开，请检查连接。");
  });
  elements.fillOfferActions.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-archive]");
    if (!button || button.disabled) return;
    archiveAction(button.dataset.archive).catch(() => toast("操作未完成，请稍后再试。"));
  });
  elements.fillOfferCandidates.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-application-id]");
    if (!button || button.disabled || fillArchive?.phase !== "choosing") return;
    archiveAction("choose", { applicationId: button.dataset.applicationId }).catch(() => toast("操作未完成，请稍后再试。"));
  });
  elements.queueToggle.addEventListener("click", () => {
    const open = elements.queueBody.hidden;
    setQueueOpen(open);
    if (!open) queueFocus = "";
    if (open) refreshQueue().catch(() => {});
    else renderQueue();
  });
  elements.queueList.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-queue-action]");
    if (!button) return;
    queueAction(button).catch(() => toast("操作未完成，请稍后再试。"));
  });
  // What is typed into an id box is kept as it is typed: the list is redrawn whenever the
  // queue changes (a snapshot chunk, another window), and that must not empty the box.
  elements.queueList.addEventListener("input", (event) => {
    const key = event.target?.dataset?.key;
    if (!key || !event.target.classList?.contains("queue-id")) return;
    const open = queueUi.get(key);
    if (open) queueUi.set(key, { ...open, typed: String(event.target.value || "") });
  });
  // Every field row goes through here. The row body is the quick path (the
  // page decides: an empty box gets the field, a filled one asks for an explicit button);
  // 添加 / 替换 / 删除 name the operation, and the page refuses one that would change nothing.
  async function fieldAction(event) {
    const button = event.target.closest?.("button[data-chip-id]");
    if (!button || button.disabled) return;
    const mode = button.dataset.action || "fill";
    const field = visibleFields(groupedFields()).find((item) => item.chipId === button.dataset.chipId);
    if (!field) { toast("字段已变化，请刷新侧栏后重试。"); return; }
    const result = await sendToPage({ type: "RESUME_PANEL_FIELD", chipId: field.chipId, value: field.value, mode, chips: panelChips() });
    if (result?.needsCopy) {
      // Only a non-text control that refused the write gets here; the toast says what was copied.
      const copied = await copyFieldValue(field.value);
      toast(copied ? `${result.message}字段内容已复制。` : "复制失败，请在桌面核对字段内容。");
    } else {
      toast(result?.message || result?.error || "字段操作未完成。");
    }
    await refreshTarget().catch(() => {});
  }
  elements.fieldGroups.addEventListener("click", fieldAction);
  chrome.runtime.onMessage?.addListener((message, sender) => {
    if (message?.type === "RESUME_TARGET_CHANGED" && sender?.id === chrome.runtime.id
      && currentTabId !== null && sender.tab?.id === currentTabId) {
      refreshTarget().catch(() => {});
    }
    return false;
  });
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
  // --- 确认已投递: all of it in the panel, nothing on the job site is touched -------------
  // The page answers a start or a choice only when the desktop has; its progress ("正在查找…",
  // "正在确认投递…") is already in its snapshot, so fetch that now instead of at the next tick.
  async function submitRequest(message) {
    const request = jobRequest(message);
    pollStatus().catch(() => {});
    return request;
  }
  elements.submitButton.addEventListener("click", async () => {
    const result = await submitRequest({ type: "RESUME_PANEL_SUBMIT_START" });
    if (result && !result.ok) toast(result.error || "没能开始确认投递，请稍后再试。");
  });
  // `scope: "assist"` only stops the AI and returns to the (still open) review form — the
  // same distinction "取消识别" vs "取消" makes for saving a job. Anything else ends the
  // whole attempt: nothing is queried, confirmed or saved.
  async function cancelSubmitConfirm(scope, interrupt = false) {
    if (!submitConfirm?.confirmId) return;
    const dismissing = ["confirmed", "unavailable", "unknown", "failed"].includes(submitConfirm.phase);
    const result = await jobRequest(
      { type: "RESUME_PANEL_SUBMIT_CANCEL", confirmId: submitConfirm.confirmId, scope }, { interrupt }
    );
    if (result?.ok && scope === "assist") toast("已取消，请核对后再查找。");
    else if (result?.ok && !dismissing) toast("已取消，桌面上没有任何变化。");
    else if (result && !result.ok) toast(result.error || "当前无法取消。");
  }
  // Waiting for the desktop: this has to get through while the lookup is still pending.
  elements.submitStop.addEventListener("click", () => cancelSubmitConfirm("assist", true));
  elements.submitReviewCancel.addEventListener("click", () => cancelSubmitConfirm("draft"));
  elements.submitCancel.addEventListener("click", () => cancelSubmitConfirm("draft"));
  elements.submitDismiss.addEventListener("click", () => cancelSubmitConfirm("draft"));
  elements.submitForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!submitConfirm?.confirmId || submitConfirm.phase !== "review") return;
    const company = elements.submitCompany.value.trim();
    const title = elements.submitTitle.value.trim();
    elements.submitCompany.setAttribute?.("aria-invalid", String(!company));
    elements.submitTitle.setAttribute?.("aria-invalid", String(!title));
    if (!company || !title) {
      const missing = [!company && "公司名称", !title && "岗位名称"].filter(Boolean).join("和");
      submitLocalError = `请补全${missing}后再查找。`;
      elements.submitError.hidden = false;
      elements.submitError.textContent = submitLocalError;
      (company ? elements.submitTitle : elements.submitCompany).focus?.();
      return;
    }
    submitLocalError = "";
    renderJobSave();
    const result = await submitRequest({ type: "RESUME_PANEL_SUBMIT_QUERY", confirmId: submitConfirm.confirmId, company, title });
    if (result && !result.ok && !result.missing) toast(result.error || "没能查到对应的投递记录，请稍后再试。");
  });
  // Editing a required field clears only that field's red border, mirroring job-save's inputs.
  const requiredSubmitInputs = [[elements.submitCompany, "公司名称"], [elements.submitTitle, "岗位名称"]];
  for (const [input] of requiredSubmitInputs) {
    input.addEventListener("input", () => {
      input.removeAttribute?.("aria-invalid");
      if (!submitLocalError) return;
      const missing = requiredSubmitInputs
        .filter(([other]) => other.getAttribute?.("aria-invalid") === "true")
        .map(([, label]) => label);
      submitLocalError = missing.length ? `请补全${missing.join("和")}后再查找。` : "";
      renderJobSave();
    });
  }
  elements.submitCandidates.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-application-id]");
    if (!button || button.disabled || !submitConfirm?.confirmId) return;
    const result = await submitRequest({
      type: "RESUME_PANEL_SUBMIT_CHOICE", confirmId: submitConfirm.confirmId, applicationId: button.dataset.applicationId
    });
    if (result && !result.ok) toast(result.error || "没能确认投递，请稍后再试。");
  });
  async function backToSubmitReview() {
    if (!submitConfirm?.confirmId) return;
    const result = await jobRequest({ type: "RESUME_PANEL_SUBMIT_BACK", confirmId: submitConfirm.confirmId });
    if (result && !result.ok) toast(result.error || "现在无法返回修改。");
  }
  elements.submitBack.addEventListener("click", backToSubmitReview);
  elements.submitResultBack.addEventListener("click", backToSubmitReview);
  elements.submitSave.addEventListener("click", async () => {
    if (!submitConfirm?.confirmId) return;
    const result = await jobRequest({ type: "RESUME_PANEL_SUBMIT_SAVE", confirmId: submitConfirm.confirmId });
    if (result && !result.ok) toast(result.error || "无法读取当前网页的岗位信息。");
  });
  elements.submitOpenAi.addEventListener("click", () => desktopAction("settings-ai").catch(() => toast("当前操作不可用。")));
  elements.submitCopyId.addEventListener("click", async () => {
    toast(await copyFieldValue(chrome.runtime.id) ? "扩展 ID 已复制，请在桌面设置中粘贴。" : "复制失败。");
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
    const location = elements.jobLocation.value.trim();
    elements.jobCompany.setAttribute?.("aria-invalid", String(!company));
    elements.jobTitle.setAttribute?.("aria-invalid", String(!title));
    if (!company || !title) {
      const missing = [!company && "公司名称", !title && "岗位名称"].filter(Boolean).join("和");
      jobLocalError = `请补全${missing}后再保存。`;
      elements.jobError.hidden = false;
      elements.jobError.textContent = jobLocalError;
      (company ? elements.jobTitle : elements.jobCompany).focus?.();
      return;
    }
    jobLocalError = "";
    renderJobSave();
    const result = await jobRequest({ type: "RESUME_PANEL_SAVE_CONFIRM", draftId: jobSave.draftId, company, title, location });
    if (result && !result.ok && !result.missing) toast(result.error || "这次没能保存，请稍后再试。");
  });
  // Editing a required field clears only that field's red border. The prompt keeps naming
  // whichever field is still empty, and the next submit judges both again.
  const requiredJobInputs = [[elements.jobCompany, "公司名称"], [elements.jobTitle, "岗位名称"]];
  for (const [input] of requiredJobInputs) {
    input.addEventListener("input", () => {
      input.removeAttribute?.("aria-invalid");
      if (!jobLocalError) return;
      const missing = requiredJobInputs
        .filter(([other]) => other.getAttribute?.("aria-invalid") === "true")
        .map(([, label]) => label);
      jobLocalError = missing.length ? `请补全${missing.join("和")}后再保存。` : "";
      renderJobSave();
    });
  }
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
      company: elements.jobCompany.value.trim(), title: elements.jobTitle.value.trim(),
      location: elements.jobLocation.value.trim()
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
    else await loadStore();
  }
  elements.desktopConnectionAction.addEventListener("click", () => desktopAction(elements.desktopConnectionAction.dataset.kind).catch(() => toast("当前操作不可用。")));
  document.getElementById("open-manager").addEventListener("click", () => {
    const mode = desktopMode === "ready" && !selectedTemplate() && !self.ResumeProProfile?.hasProfileContent(currentStore?.profile) ? "empty" : desktopMode;
    return desktopAction(mode === "ready" ? "home" : self.ResumeProResumeData.modeCopy(mode).kind).catch(() => toast("当前操作不可用。"));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    loadStore().catch(() => {});
    refreshQueue().catch(() => {});
  });
  chrome.tabs.onActivated.addListener(() => {
    tabEpoch += 1;
    clearTargetState();
    clearRepeat();
    loadStore().then(pollStatus).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((_tabId, change) => { if (change.status === "complete") pollStatus().catch(() => {}); });
  loadStore().then(pollStatus).catch(() => { elements.configState.textContent = "无法连接桌面，请稍后重试。"; });
  let statusPollCount = 0;
  setInterval(() => {
    pollStatus().catch(() => {});
    // The page status poll does not include desktop profile changes. Reread while the
    // panel stays open so desktop edits appear without a tab switch or reopening it.
    if (!document.hidden && ++statusPollCount % 4 === 0) loadStore({ periodic: true }).catch(() => {});
  }, 1500);
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
  // The pending list lives in the worker's storage keys (link/store.mjs). A change there —
  // a record bound, a message sent, a retry counted — is read again through the worker; the
  // panel never reads those keys itself.
  const QUEUE_KEYS = ["desktopSaveIntents", "desktopOutbox", "desktopFillRecords"];
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.legacyImport) renderLegacyHint().catch(() => {});
    if (area === "local" && QUEUE_KEYS.some((key) => changes[key])) refreshQueue().catch(() => {});
  });
  linkCopy().then(() => { renderFillArchive(); renderQueue(); }).catch(() => {});
  // Still there after the job page was closed and the panel reopened: the list is the worker's.
  refreshQueue().catch(() => {});
  // Opening the panel nudges a stalled migration; with no old data this does no native call.
  chrome.runtime.sendMessage({ type: "DESKTOP_LEGACY_STATUS" }).catch(() => {});
  renderLegacyHint().catch(() => {});
})();
