(function () {
  self.ResumeProFeedback?.install(report => chrome.runtime.sendMessage({ type: "FEEDBACK_AUTO", report }),
    { origin: chrome.runtime.getURL(""), requireOwn: true });
  const SIDEBAR_ID = "resume-pro-sidebar";
  const SIDEBAR_PANEL_ID = "resume-pro-sidebar-panel";
  const SIDEBAR_DEFAULT_TOP = 96;
  const SIDEBAR_DEFAULT_RIGHT = 24;
  const FIELD_HIGHLIGHT_CLASS = "resume-pro__field-highlight";
  const FIELD_HIGHLIGHT_STYLE_ID = "resume-pro-field-highlight-styles";
  const FIELD_HIGHLIGHT_STYLE_TEXT = `
.${FIELD_HIGHLIGHT_CLASS} {
  animation: resume-pro-field-highlight 2.6s ease-out forwards !important;
  outline: 2px solid rgba(34, 197, 94, 0.95) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.14), 0 0 12px rgba(34, 197, 94, 0.5) !important;
  background-color: rgba(34, 197, 94, 0.1) !important;
}

@keyframes resume-pro-field-highlight {
  0% {
    outline-color: rgba(34, 197, 94, 0.95);
    box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.14), 0 0 12px rgba(34, 197, 94, 0.5);
    background-color: rgba(34, 197, 94, 0.1);
  }

  70% {
    outline-color: rgba(34, 197, 94, 0.8);
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.09), 0 0 8px rgba(34, 197, 94, 0.28);
    background-color: rgba(34, 197, 94, 0.06);
  }

  100% {
    outline-color: rgba(34, 197, 94, 0);
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);
    background-color: transparent;
  }
}
  `;
  const fieldHighlightTimers = new WeakMap();
  const chipSelectionIdsByTarget = new WeakMap();
  const chipWriteTargets = new WeakSet();
  // 每个网页目标最后一次有效的光标/选区。点原生侧栏会让网页失焦，所以不能等到
  // 收到侧栏操作时才去读 selection。只放在页面内存里，按元素保存，不跨文本框复用。
  const savedTextSelections = new WeakMap();
  // 侧栏最近一次来问过目标状态的时间。只有侧栏在线时，才把「目标变了」通知过去。
  let panelQueriedAt = 0;
  let panelNotifyTimer = null;
  const PANEL_ONLINE_MS = 5000;
  const textFillFailures = new WeakMap();
  // 给页面自己的校验留一点时间。短到不拖慢整表，长过常见的几十毫秒回滚。
  let textCommitWaitMs = 100;
  // #173：本次一键填写成功的文本框，只放在当前网页的内存里，不写 storage。
  let fillSession = null;
  let submitGesture = null;
  let submitSyncBound = false;
  let submitSyncBusy = false;
  // 网站校验通常在点击后几十毫秒内出结果，多等一拍再检查有没有仍标红的字段。
  let submitCheckDelayMs = 500;
  const SUBMIT_GESTURE_DEDUPE_MS = 1500;
  const TEXT_FILL_FAILURE_LABELS = {
    value_not_committed: "值没有写上",
    value_reverted: "值被页面退回",
    element_disconnected: "字段已被页面替换",
    validation_not_cleared: "页面仍提示无效",
    framework_state_unsynced: "页面表单状态未同步",
    value_changed: "字段内容已变化",
    verification_timeout: "尚未确认页面已接受",
    unsupported_control: "控件暂不支持",
    no_option_match: "没有匹配的选项",
    selection_not_committed: "选项选择未提交",
    options_not_rendered: "没有发现选项",
    options_timeout: "等待选项更新超时",
    ambiguous_option: "选项存在歧义",
    ambiguous_popup: "无法确定控件弹层",
    cascade_timeout: "等待下一级选项超时",
    cascade_parent_failed: "上一级选择失败",
    control_disabled: "字段不可操作",
    invalid_date: "日期格式或范围不符",
    operation_failed: "控件操作失败",
    cancelled: "填写已停止"
  };
  let shadowRoot = null;
  // 最近一次填写的 v1 诊断块（#215）：手动反馈附上的是它，不是侧栏那段给人看的文字。
  let lastFillReport = "";
  // Archiving a finished fill from the native side panel (#178). Declared up here because the
  // side panel's status message can arrive before the rest of this script has run.
  let panelFill = null;
  const state = {
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragging: false,
    sidebarUiState: null,
    currentStore: null,
    desktopMode: "unavailable",
    aiBusy: false,
    suggestedView: null,
    statusTimer: null,
    lastFocusedField: null,
    chipAction: null,
    nativeSidePanel: false,
    // 「加到我的信息」（#189）：候选连着网页上的控件，只在本页内存里；值每次都现读。
    profileOfferCandidates: [],
    profileOfferVersion: 0,
    profileOfferEpoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    profileOfferResult: null,
    profileResultCandidateSignature: "",
    profileDismissedCandidateSignature: null,
    profileSaving: false
  };
  // #188 辅助新增的状态，只在本页内存里；控制逻辑见 handlePanelRepeat。
  const REPEAT_ACTIVE = ["scanning", "planning", "preview", "executing", "filling"];
  const REPEAT_STOPPABLE = ["scanning", "planning", "executing", "filling"];
  const repeat = { phase: "idle", requestId: "", message: "", plan: [], added: 0, run: null };

  // The native side panel owns the visible UI. The existing shadow DOM remains
  // mounted as the form-filling controller so its tested AI and site adapters
  // continue to run in the page's content-script context.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !String(message.type || "").startsWith("RESUME_PANEL_")) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    if (message.type === "RESUME_PANEL_STATUS") {
      const button = shadowRoot?.querySelector("#resume-pro-ai-fill");
      const status = shadowRoot?.querySelector("#resume-pro-status");
      const cancel = shadowRoot?.querySelector("#resume-pro-cancel-fill");
      const desktopStatus = shadowRoot?.querySelector("#resume-pro-desktop-status");
      const diagnosticsPanel = shadowRoot?.querySelector("#resume-pro-diagnostics");
      const jobAssist = shadowRoot?.querySelector("#resume-pro-job-assist");
      dropStalePanelJob();
      dropStalePanelSubmit();
      const jobSave = panelJobSnapshot();
      sendResponse({
        ready: Boolean(button),
        // `disabled` also covers the controller's pre-read state. Treating that as
        // "busy" deadlocks the native side panel: it cannot send the fill command
        // which performs the desktop reread below. Only an active AI run is busy.
        busy: state.aiBusy,
        phase: button?.textContent || "",
        status: status?.classList.contains("is-visible") ? status.textContent : "",
        statusKind: status?.classList.contains("is-error") ? "error" : "success",
        openView: state.suggestedView,
        // While 辅助新增 runs, its own 停止 is the one control; the fill's cancel stays hidden.
        canCancel: !repeatActive() && Boolean(cancel && !cancel.hidden && !cancel.disabled),
        // 保存到「我的信息」的候选、勾选依据和结果（#189）；null 表示没有可问的。
        profileOffer: panelProfileSnapshot(),
        // Archiving the fill that just ended (#178): the offer, the application question and
        // its answer, all drawn by the side panel from this snapshot. Page memory only.
        fillArchive: panelFillSnapshot(),
        desktopStatus: desktopStatus?.textContent || "",
        diagnostics: diagnosticsPanel && !diagnosticsPanel.hidden
          ? diagnosticsPanel.querySelector("#resume-pro-diagnostics-text")?.value || "" : "",
        // 手动反馈附上的诊断（#215 v1）：只含结构和计数，后台还会再按白名单过滤一遍。
        diagnosticsReport: diagnosticsPanel && !diagnosticsPanel.hidden ? lastFillReport : "",
        // Job recognition runs in the page's controls; the side panel shows it and can cancel it.
        jobAssist: jobAssist && !jobAssist.hidden
          ? { fragments: jobAssist.querySelectorAll("#resume-pro-job-assist-fragments li").length } : null,
        // Saving a job from the side panel itself (#172); held in this page's memory only.
        jobSave,
        // Confirming a submission from the side panel (#172); also held in this page's memory only.
        submitConfirm: panelSubmitSnapshot(),
        // AI 辅助新增条目 from the side panel (#188); also held in this page's memory only.
        repeat: describeRepeat()
      });
      return false;
    }

    if (message.type === "RESUME_PANEL_FILL") {
      if (repeatActive()) {
        sendResponse({ ok: false, error: "AI 辅助新增正在进行，请先完成或停止。" });
        return false;
      }
      StorageService.getState().then(store => {
        state.currentStore = store;
        if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
        const button = shadowRoot?.querySelector("#resume-pro-ai-fill");
        if (!button || button.hidden || button.disabled) sendResponse({ ok: false, error: "桌面简历当前不可用。" });
        else { button.click(); sendResponse({ ok: true }); }
      }).catch(() => sendResponse({ ok: false, error: "桌面简历当前不可用。" }));
      return true;
    }
    if (message.type === "RESUME_PANEL_CANCEL") {
      const selector = "#resume-pro-cancel-fill";
      const button = shadowRoot?.querySelector(selector);
      if (!button || button.hidden || button.disabled) sendResponse({ ok: false, error: "当前操作不可用。" });
      else { button.click(); sendResponse({ ok: true }); }
      return false;
    }

    if (message.type === "RESUME_PANEL_REPEAT") {
      Promise.resolve(handlePanelRepeat(message)).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "辅助新增失败，请手动核对网页。" }));
      return true;
    }

    if (message.type === "RESUME_PANEL_TARGET") {
      panelQueriedAt = Date.now();
      sendResponse(describePanelTarget(readPanelChips(message.chips)));
      return false;
    }

    if (message.type === "RESUME_PANEL_FIELD") {
      handlePanelFieldAction(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false, error: "字段填写失败，请手动核对网页。" }));
      return true;
    }
    if (message.type === "RESUME_PANEL_OFFER") {
      const action = String(message.action || "");
      if (action === "profileSkip") { closeProfileOffer(); sendResponse({ ok: true }); return false; }
      if (action === "profileDismiss") { dismissProfileResult(); sendResponse({ ok: true, profileOffer: panelProfileSnapshot() }); return false; }
      if (action === "profileAdd") {
        addUnansweredToProfile(message).then(sendResponse)
          .catch(() => sendResponse({ ok: false, saved: 0, error: "保存失败，请稍后再试。", profileOffer: panelProfileSnapshot() }));
        return true;
      }
      // Archiving a fill is no longer answered here (#178): the side panel runs the whole
      // question itself (RESUME_PANEL_ARCHIVE_*) and never sends the user to the page overlay.
      sendResponse({ ok: false, error: "当前操作不可用。" });
      return false;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_START") {
      startPanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能开始留档，请稍后再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_REQUERY") {
      requeryPanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能重新查找，请稍后再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_CHOOSE") {
      choosePanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能留档，请到「待同步」核对后再操作。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_LATER") {
      laterPanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能记入待同步，请稍后再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_REMOVE") {
      removePanelFillArchive(message).then(sendResponse)
        .catch(() => sendResponse(panelFillOutcome({ ok: false, error: "没能删除这条待同步记录，请在「待同步」里再试。" })));
      return true;
    }
    if (message.type === "RESUME_PANEL_ARCHIVE_CANCEL") {
      sendResponse(cancelPanelFillArchive(message));
      return false;
    }
    if (message.type === "RESUME_PANEL_SAVE_DRAFT") {
      startPanelJobDraft().then(jobSave => sendResponse({ ok: true, jobSave }))
        .catch(() => sendResponse({ ok: false, error: "读取岗位信息失败。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_CONFIRM") {
      confirmPanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "这次没能保存，请稍后再试。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_REASSIST") {
      reassistPanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "重新识别没有完成，请稍后再试。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_CANCEL") {
      cancelPanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "当前无法取消。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SAVE_CHOICE") {
      choosePanelJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "这次没能保存，请稍后再试。", jobSave: panelJobSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_START") {
      startPanelSubmit().then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "没能开始确认投递，请稍后再试。", submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_QUERY") {
      queryPanelSubmit(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "没能查到对应的投递记录，这次没有确认投递。请稍后再试。", submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_CHOICE") {
      choosePanelSubmit(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "没能确认结果，请到桌面端查看这条申请的当前状态。", submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_BACK") {
      sendResponse(backPanelSubmit(message));
      return false;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_CANCEL") {
      sendResponse(cancelPanelSubmit(message));
      return false;
    }
    if (message.type === "RESUME_PANEL_SUBMIT_SAVE") {
      savePanelSubmitJob(message).then(sendResponse)
        .catch(() => sendResponse({ ok: false, error: "读取岗位信息失败。", jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() }));
      return true;
    }
    if (message.type === "RESUME_PANEL_ADVANCED") {
      if (message.action === "cancel-assist") {
        const running = Boolean(shadowRoot?.querySelector("#resume-pro-job-assist")?.hidden === false);
        if (running) cancelJobAssist();
        sendResponse(running ? { ok: true } : { ok: false, error: "识别已经结束了。" });
        return false;
      }
      if (message.action === "close") {
        shadowRoot?.querySelector(".resume-pro")?.classList.remove("is-legacy-open");
        sendResponse({ ok: true });
        return false;
      }
      // 保存岗位、确认已投递 (#172) and AI 辅助新增条目 (#188) all run in the side panel itself,
      // so nothing here opens the page's old controls any more.
      sendResponse({ ok: false, error: "当前网页无法打开该工具。" });
      return false;
    }
    return false;
  });

  const StorageService = {
    async getState() {
      try {
        const result = await chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_READ" });
        state.desktopMode = result?.status === "ok" ? "ready" : result?.status || "unavailable";
        return result?.status === "ok" ? self.ResumeProResumeData.normalize(result.data) : null;
      } catch {
        state.desktopMode = "unavailable";
        return null;
      }
    },

    async getSidebarUiState() {
      return self.ResumeProSidebarState.readOrDefault(chrome.storage.local);
    },

    async setSidebarUiState(uiState) {
      await self.ResumeProSidebarState.write(chrome.storage.local, uiState);
    },

    async setActiveTemplate(templateId) {
      return chrome.runtime.sendMessage({ type: "DESKTOP_RESUME_UPDATE", op: "setActiveTemplate", templateId });
    }
  };

  if (window.top !== window) {
    return;
  }

  // Register before a fill starts so this capture listener is as early as the content script
  // can make it. With no active fill session every handler returns immediately.
  bindSubmitSync();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  async function init() {
    if (document.getElementById(SIDEBAR_ID)) {
      return;
    }

    // No desktop read here. This script runs on every page, and each read starts the
    // native host (and cold-starts the desktop app). The data is read when the in-page
    // panel is actually shown, or when the user starts an action.
    state.sidebarUiState = await StorageService.getSidebarUiState();
    state.sidebarUiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    const cssText = await fetch(chrome.runtime.getURL("content.css")).then((r) => r.text());
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    injectFieldHighlightStyles();
    // Chrome and Edge 116+ own the visible UI in the native side panel.
    // Background opens the manager tab if that API is unavailable.
    state.nativeSidePanel = true;
    createSidebar(sheet);
    renderSidebar();
    bindStorageSync();
    document.addEventListener("visibilitychange", () => {
      // A plan made for this tab must not keep clicking once the user has moved to another one.
      if (document.hidden) invalidateRepeat("已切换到其他标签页，计划已失效，请重新预览。");
      else refreshVisibleStore().catch(() => {});
    });
    bindFocusTracking();
    window.addEventListener("resize", constrainSidebarToViewport);
  }

  function inPageUiVisible() {
    return Boolean(shadowRoot?.querySelector(".resume-pro")?.classList.contains("is-legacy-open"));
  }

  // Reads the desktop only while the in-page panel is on screen. With the native side
  // panel it stays hidden, and the side panel reads for itself.
  async function refreshVisibleStore() {
    if (!inPageUiVisible()) return false;
    state.currentStore = await StorageService.getState();
    renderSidebar();
    const { legacyImport } = await chrome.storage.local.get(["legacyImport"]).catch(() => ({}));
    const hint = shadowRoot?.querySelector("#resume-pro-legacy-hint");
    if (hint) hint.hidden = !["sending", "waiting"].includes(legacyImport?.phase);
    return true;
  }

  function createSidebar(sheet) {
    const uiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    state.sidebarUiState = uiState;
    const host = document.createElement("div");
    host.id = SIDEBAR_ID;
    Object.assign(host.style, {
      position: "fixed",
      top: `${SIDEBAR_DEFAULT_TOP}px`,
      right: `${SIDEBAR_DEFAULT_RIGHT}px`,
      zIndex: "2147483647"
    });

    if (uiState.left !== null && uiState.top !== null) {
      host.style.left = `${uiState.left}px`;
      host.style.top = `${uiState.top}px`;
      host.style.right = "auto";
    }

    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: "closed" });
    shadowRoot.adoptedStyleSheets = [sheet];

    const sidebar = document.createElement("aside");
    sidebar.id = SIDEBAR_PANEL_ID;
    sidebar.className = uiState.collapsed ? "resume-pro is-collapsed" : "resume-pro";
    sidebar.innerHTML = `
      <div class="resume-pro__header" data-drag-handle="true">
        <div class="resume-pro__title-wrap">
          <p class="resume-pro__eyebrow">网申快填</p>
          <strong class="resume-pro__title">填表助手</strong>
        </div>
        <button class="resume-pro__collapse" type="button" aria-label="折叠助手" aria-controls="${SIDEBAR_PANEL_ID}">−</button>
      </div>
      <div class="resume-pro__body">
        <label class="resume-pro__field">
          <span>当前模板</span>
          <select class="resume-pro__select" id="resume-pro-template-select"></select>
        </label>
        <button class="resume-pro__ai-button" id="resume-pro-ai-fill" type="button">一键 AI 填写</button>
        <button class="resume-pro__manager-button" id="resume-pro-repeat-fill" type="button">AI 辅助新增条目（先预览）</button>
        <button class="resume-pro__manager-button" id="resume-pro-cancel-fill" type="button" hidden>取消 AI 等待（保留本地匹配）</button>
        <p id="resume-pro-wait-hint" role="status" hidden></p>
        <div class="resume-pro__status" id="resume-pro-status" aria-live="polite"></div>
        <div class="resume-pro__fill-record" id="resume-pro-profile-offer" hidden>
          <p class="resume-pro__save-note" id="resume-pro-profile-offer-text"></p>
          <div class="resume-pro__save-actions">
            <button class="resume-pro__ai-button" type="button" id="resume-pro-profile-offer-add">保存到我的信息</button>
            <button class="resume-pro__manager-button" type="button" id="resume-pro-profile-offer-skip">不用</button>
          </div>
        </div>
        <div class="resume-pro__fill-record" id="resume-pro-fill-record" hidden>
          <p class="resume-pro__save-note" id="resume-pro-fill-record-summary"></p>
          <label class="resume-pro__fill-record-option">
            <input type="checkbox" id="resume-pro-fill-record-snapshot" checked>
            <span>附上这次用的简历模板拷贝（先存在本机，传到桌面后可在申请里查看）</span>
          </label>
          <div class="resume-pro__save-actions">
            <button class="resume-pro__ai-button" type="button" id="resume-pro-fill-record-save">留档到桌面</button>
            <button class="resume-pro__manager-button" type="button" id="resume-pro-fill-record-skip">不留档</button>
          </div>
        </div>
        <details class="resume-pro__diagnostics" id="resume-pro-diagnostics" hidden>
          <summary>填写诊断（不含简历内容）</summary>
          <textarea id="resume-pro-diagnostics-text" readonly aria-label="填写诊断摘要，可选择复制" rows="14"></textarea>
        </details>
        <div class="resume-pro__divider"></div>
        <div class="resume-pro__desktop">
          <button class="resume-pro__manager-button" id="resume-pro-save-job" type="button">保存岗位到桌面端</button>
          <p class="resume-pro__footer-tip">页面信息不全时，会经桌面把几段岗位文字发给 AI 识别，不会发送表单或简历内容。</p>
          <button class="resume-pro__manager-button" id="resume-pro-confirm-submit" type="button">确认已投递</button>
          <form class="resume-pro__save-form" id="resume-pro-save-form" hidden>
            <label class="resume-pro__field">
              <span>公司<em>*</em></span>
              <input type="text" id="resume-pro-save-company" autocomplete="off" required>
            </label>
            <label class="resume-pro__field">
              <span>岗位<em>*</em></span>
              <input type="text" id="resume-pro-save-title" autocomplete="off" required>
            </label>
            <label class="resume-pro__field">
              <span>地点</span>
              <input type="text" id="resume-pro-save-location" autocomplete="off">
            </label>
            <label class="resume-pro__field">
              <span>来源链接</span>
              <input type="text" id="resume-pro-save-url" readonly>
            </label>
            <p class="resume-pro__save-note" id="resume-pro-save-note"></p>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__ai-button" type="submit">确认</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-save-cancel">取消</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-save-open-ai" hidden>打开桌面 AI 设置</button>
            </div>
          </form>
          <div class="resume-pro__save-form" id="resume-pro-job-assist" hidden>
            <p class="resume-pro__save-note" id="resume-pro-job-assist-note" role="status"></p>
            <ul class="resume-pro__candidate-list" id="resume-pro-job-assist-fragments"></ul>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__manager-button" type="button" id="resume-pro-job-assist-cancel">取消识别</button>
            </div>
          </div>
          <div class="resume-pro__candidates" id="resume-pro-candidates" hidden>
            <p class="resume-pro__save-note" id="resume-pro-candidates-note"></p>
            <div class="resume-pro__candidate-list" id="resume-pro-candidate-list"></div>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__ai-button" type="button" id="resume-pro-bind-new">新建一条</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-bind-later">稍后再说</button>
            </div>
          </div>
          <div class="resume-pro__desktop-status" id="resume-pro-desktop-status" aria-live="polite"></div>
          <details class="resume-pro__pending" id="resume-pro-pending" hidden>
            <summary>待同步 <span id="resume-pro-pending-count">0</span> 条</summary>
            <div class="resume-pro__pending-list" id="resume-pro-pending-list"></div>
          </details>
        </div>
        <div class="resume-pro__divider"></div>
        <div class="resume-pro__groups" id="resume-pro-groups"></div>
        <div class="resume-pro__footer">
          <button class="resume-pro__manager-button" id="resume-pro-open-manager" type="button">打开桌面</button>
          <p class="resume-pro__footer-tip">简历数据和 AI 设置由桌面程序管理。</p>
          <p class="resume-pro__footer-tip" id="resume-pro-legacy-hint" hidden>插件里的旧简历正在迁到桌面，请到桌面「简历」页确认导入。</p>
        </div>
      </div>
    `;

    shadowRoot.appendChild(sidebar);
    updateCollapseButton(sidebar);
    constrainSidebarToViewport();
    const chipActions = document.createElement("div");
    chipActions.id = "resume-pro-chip-actions";
    chipActions.className = "resume-pro__chip-actions";
    chipActions.hidden = true;
    chipActions.setAttribute("role", "menu");
    chipActions.setAttribute("aria-label", "字段填写方式");
    chipActions.innerHTML = `
      <button type="button" role="menuitem" data-chip-mode="add">添加</button>
      <button type="button" role="menuitem" data-chip-mode="replace">替换</button>
    `;
    shadowRoot.appendChild(chipActions);
    bindSidebarEvents(sidebar);
  }

  function bindSidebarEvents(sidebar) {
    const header = sidebar.querySelector(".resume-pro__header");
    const collapseButton = sidebar.querySelector(".resume-pro__collapse");
    const templateSelect = sidebar.querySelector("#resume-pro-template-select");
    const aiFillButton = sidebar.querySelector("#resume-pro-ai-fill");
    const openManagerButton = sidebar.querySelector("#resume-pro-open-manager");
    header.addEventListener("mousedown", startDrag);
    document.addEventListener("mousemove", onDrag);
    document.addEventListener("mouseup", stopDrag);

    collapseButton.addEventListener("click", () => {
      const host = document.getElementById(SIDEBAR_ID);
      if (!host) {
        return;
      }
      const rect = host.getBoundingClientRect();
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.right = "auto";
      sidebar.classList.toggle("is-collapsed");
      updateCollapseButton(sidebar);
      persistSidebarUiState();
    });

    templateSelect.addEventListener("change", async (event) => {
      const result = await StorageService.setActiveTemplate(event.target.value).catch(() => null);
      state.currentStore = await StorageService.getState();
      renderSidebar();
      showStatus(result?.status === "missing_template" ? "这个模板在桌面里已经删掉了" : result?.status === "ok" ? "模板已切换。" : "桌面暂时无法切换模板。", result?.status === "ok" ? "success" : "error");
    });

    aiFillButton.addEventListener("click", handleAiFillClick);
    sidebar.querySelector("#resume-pro-repeat-fill").addEventListener("click", handleRepeatFillClick);
    openManagerButton?.addEventListener("click", () => state.desktopMode === "ready" ? openManager("home") : openDesktopAction(state.desktopMode));
    sidebar.querySelector("#resume-pro-profile-offer-add")?.addEventListener("click", () => { addUnansweredToProfile().catch(() => {}); });
    sidebar.querySelector("#resume-pro-profile-offer-skip")?.addEventListener("click", closeProfileOffer);
    bindDesktopEvents(sidebar);

    const chipActions = shadowRoot.querySelector("#resume-pro-chip-actions");
    chipActions?.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    chipActions?.querySelectorAll("[data-chip-mode]").forEach((actionButton) => {
      actionButton.addEventListener("click", () => handleChipAction(actionButton.dataset.chipMode));
    });
    document.addEventListener("mousedown", () => closeChipActionMenu());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeChipActionMenu();
      }
    });
  }

  function bindStorageSync() {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      const sidebarStateChange = changes[self.ResumeProSidebarState.STORAGE_KEY];
      if (sidebarStateChange && !state.dragging) {
        state.sidebarUiState = self.ResumeProSidebarState.normalize(sidebarStateChange.newValue);
        applySidebarUiState();
      }
    });
  }

  function renderSidebar() {
    if (!shadowRoot) {
      return;
    }

    const templateSelect = shadowRoot.querySelector("#resume-pro-template-select");
    const groupsContainer = shadowRoot.querySelector("#resume-pro-groups");
    const activeTemplate = getActiveTemplate(state.currentStore);
    const templates = state.currentStore?.templates || [];
    const profileFields = profileResumeFields();
    const downgrade = state.desktopMode !== "ready" ? state.desktopMode
      : !activeTemplate && !profileFields.length ? "empty" : null;
    const downgradeCopy = downgrade ? self.ResumeProResumeData.modeCopy(downgrade) : null;
    const openButton = shadowRoot.querySelector("#resume-pro-open-manager");
    if (openButton) openButton.textContent = downgradeCopy?.action || "打开桌面";

    templateSelect.innerHTML = templates.length
      ? templates.map((template) => `
          <option value="${escapeHtml(template.id)}" ${template.id === state.currentStore.activeTemplateId ? "selected" : ""}>
            ${escapeHtml(template.name)}
          </option>
        `).join("")
      : '<option value="">暂无模板</option>';

    templateSelect.disabled = Boolean(downgradeCopy) || !templates.length;
    const aiFillButton = shadowRoot.querySelector("#resume-pro-ai-fill");
    if (aiFillButton) aiFillButton.disabled = Boolean(downgradeCopy) || state.aiBusy;
    const repeatButton = shadowRoot.querySelector("#resume-pro-repeat-fill");
    if (repeatButton) {
      repeatButton.disabled = Boolean(downgradeCopy) || !activeTemplate || state.aiBusy;
      // With the native side panel this runs from there; the page's copy (window.confirm) stays off.
      repeatButton.hidden = Boolean(state.nativeSidePanel);
    }

    if (downgradeCopy) {
      groupsContainer.innerHTML = `
        <div class="resume-pro__empty">
          <p>${escapeHtml(downgradeCopy.message)}</p>
          <button class="resume-pro__setup-button" id="resume-pro-setup-button" type="button">${escapeHtml(downgradeCopy.action)}</button>
        </div>
      `;
    } else {
      groupsContainer.innerHTML = (activeTemplate ? activeTemplate.groups : []).map((group, groupIndex) => `
      <section class="resume-pro__group">
        <div class="resume-pro__group-name">${escapeHtml(group.name)}</div>
        <div class="resume-pro__chips">
          ${group.fields.map((field, fieldIndex) => `
            <button
              class="resume-pro__chip"
              type="button"
              data-chip-id="${escapeHtml(`${activeTemplate.id}:${groupIndex}:${fieldIndex}`)}"
              data-value="${escapeHtml(field.value)}"
              title="${escapeHtml(field.value)}"
            >
              ${escapeHtml(field.key)}
            </button>
          `).join("")}
        </div>
      </section>
    `).join("") + buildProfileChipsHtml(profileFields);

      groupsContainer.querySelectorAll(".resume-pro__chip").forEach((button) => {
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => handleFieldChipClick(button));
      });
    }

    const setupButton = groupsContainer.querySelector("#resume-pro-setup-button");
    if (setupButton) {
      setupButton.addEventListener("click", () => openDesktopAction(downgrade));
    }

    closeChipActionMenu();
    syncChipSelectionState();
  }

  async function handleFieldChipClick(button) {
    const value = button.dataset.value || "";
    const target = getLastFocusedFillTarget();

    closeChipActionMenu();
    if (!value) {
      return;
    }

    if (!target) {
      await copyText(value);
      return;
    }

    if (isBlockedFillTarget(target)) {
      return;
    }

    if (!isComposableTextTarget(target)) {
      await copyText(value);
      const filled = await Promise.resolve(setElementValue(target, value));
      if (filled) {
        target.focus?.();
        state.lastFocusedField = target;
      }
      return;
    }

    const selection = captureTextSelection(target);
    const currentValue = getComposableTargetValue(target);
    syncChipSelectionState();
    if (button.classList.contains("is-in-field")) {
      await applyChipValue(target, value, "remove", selection, button.dataset.chipId);
      return;
    }

    if (!currentValue) {
      await copyText(value);
      await applyChipValue(target, value, "add", selection, button.dataset.chipId);
      return;
    }

    showChipActionMenu(button, target, value, selection);
  }

  const PANEL_COMPOSE_MODES = new Set(["add", "replace", "remove"]);
  const PANEL_MAX_CHIPS = 2000;

  // The side panel sends only what it needs to judge a field: its id and its own value.
  // Nothing here reads the page's text back out to the panel.
  function readPanelChips(raw, extra = null) {
    const chips = [];
    const seen = new Set();
    const push = (chipId, value) => {
      if (typeof chipId !== "string" || !chipId || typeof value !== "string" || !value || seen.has(chipId)) return;
      if (chips.length >= PANEL_MAX_CHIPS) return;
      seen.add(chipId);
      chips.push({ dataset: { chipId, value } });
    };
    if (Array.isArray(raw)) {
      raw.forEach((item) => push(item?.chipId, item?.value));
    }
    if (extra) {
      const at = chips.findIndex((chip) => chip.dataset.chipId === extra.chipId);
      if (at >= 0) chips[at].dataset.value = extra.value;
      else push(extra.chipId, extra.value);
    }
    return chips;
  }

  function planChipActions(target, chips) {
    const current = getComposableTargetValue(target);
    const selection = resolveTextSelection(target);
    const selected = resolveSelectedChipIds(target, chips, current);
    const actions = {};
    chips.forEach((chip) => {
      const chipId = chip.dataset.chipId;
      const value = chip.dataset.value;
      const contained = selected.has(chipId);
      actions[chipId] = {
        add: !contained && composeChipText(current, value, "add", selection).changed,
        replace: current !== "" && composeChipText(current, value, "replace", selection).changed,
        remove: contained && composeChipText(current, value, "remove", selection).changed
      };
    });
    return { current, selected, actions };
  }

  // 侧栏只拿到布尔能力和 chipId，不会拿到文本框原文。
  function describePanelTarget(chips) {
    const target = getLastFocusedFillTarget();
    const none = { ok: true, targetAvailable: false, composable: false, empty: true, selectedChipIds: [], actions: {} };
    if (!target) return none;
    if (!isComposableTextTarget(target)) return { ...none, targetAvailable: true };
    const plan = planChipActions(target, chips);
    return {
      ok: true,
      targetAvailable: true,
      composable: true,
      empty: plan.current === "",
      selectedChipIds: Array.from(plan.selected),
      actions: plan.actions
    };
  }

  function panelActionRefusal(mode, plan, chipId) {
    if (plan.actions[chipId]?.[mode]) return "";
    if (mode === "add") {
      return plan.selected.has(chipId) ? "网页输入框已包含这个字段。" : "添加不会改变网页内容。";
    }
    if (mode === "replace") {
      return plan.current === "" ? "网页输入框是空的，请使用「添加」。" : "替换不会改变网页内容。";
    }
    return plan.selected.has(chipId) ? "删除不会改变网页内容。" : "网页输入框里没有这个字段。";
  }

  async function applyPanelComposeAction(message, chipId, value, mode, trusted) {
    const target = getLastFocusedFillTarget();
    if (!target) return { ok: false, error: "请先点击网页输入框。" };
    if (!isComposableTextTarget(target)) {
      return { ok: false, error: "这个网页控件不能组合字段，请换到普通文本框。" };
    }
    // Hidden page chips may be older than the panel's snapshot; only the panel's own
    // list is used for identity when the sender is this extension.
    const chips = readPanelChips(trusted ? message.chips : null, { chipId, value });
    if (!trusted) {
      Array.from(shadowRoot?.querySelectorAll(".resume-pro__chip") || []).forEach((button) => {
        if (button.dataset.chipId && button.dataset.value && !chips.some((chip) => chip.dataset.chipId === button.dataset.chipId)) {
          chips.push({ dataset: { chipId: button.dataset.chipId, value: button.dataset.value } });
        }
      });
    }
    const plan = planChipActions(target, chips);
    const refusal = panelActionRefusal(mode, plan, chipId);
    if (refusal) return { ok: false, error: refusal };
    const applied = await applyChipValue(target, value, mode, resolveTextSelection(target), chipId);
    if (!applied) return { ok: false, error: "网页控件没有接受这次修改，内容未变化，请手动核对。" };
    const done = { add: "已添加到网页输入框。", replace: "已替换网页输入框内容。", remove: "已从网页输入框删除。" };
    return { ok: true, message: done[mode] };
  }

  async function handlePanelFieldAction(message, sender) {
    const mode = message.mode;
    if (mode !== "fill" && mode !== "copy" && !PANEL_COMPOSE_MODES.has(mode)) {
      return { ok: false, error: "未知的字段操作。" };
    }
    const chipId = String(message.chipId || "");
    const button = Array.from(shadowRoot?.querySelectorAll(".resume-pro__chip") || [])
      .find((item) => item.dataset.chipId === chipId);
    // The native side panel has its own fresh desktop snapshot. Its value is trusted
    // only when the sender is this extension; the hidden page chips may be older.
    const trustedValue = sender?.id === chrome.runtime.id && typeof message.value === "string";
    const value = trustedValue
      ? message.value : button?.dataset.value || "";
    if (!button && !trustedValue) return { ok: false, error: "模板字段已变化，请刷新侧栏。" };
    if (!value) return { ok: false, error: "这个字段没有内容。" };

    if (mode === "copy") {
      return { ok: false, needsCopy: true, message: "请在侧栏复制字段内容。" };
    }
    if (PANEL_COMPOSE_MODES.has(mode)) {
      return applyPanelComposeAction(message, chipId, value, mode, trustedValue);
    }

    // 兼容旧的 fill：字段主区域的快捷行为。
    const target = getLastFocusedFillTarget();
    if (!target) {
      return { ok: false, error: "请先点击网页输入框，再选择字段。" };
    }
    if (isBlockedFillTarget(target)) {
      return { ok: false, error: "这个输入框可能是密码、验证码或文件，插件不会自动填写。" };
    }

    if (isComposableTextTarget(target)) {
      if (getComposableTargetValue(target)) {
        return { ok: false, needsChoice: true, message: "网页输入框已有内容，请点击「添加」或「替换」。" };
      }
      const filled = await applyChipValue(target, value, "add", resolveTextSelection(target), chipId);
      if (filled) return { ok: true, message: "已填入网页输入框。" };
      return { ok: false, error: "网页控件没有接受写入，内容未变化，请手动核对。" };
    }

    if (hasExistingValue({ kind: "element", element: target })) {
      return { ok: false, needsCopy: true, message: "网页控件已有内容；请先核对，再粘贴复制的字段。" };
    }
    const filled = await Promise.resolve(setElementValue(target, value));
    if (filled) {
      target.focus?.();
      state.lastFocusedField = target;
      return { ok: true, message: "已填入网页输入框。" };
    }
    return { ok: false, needsCopy: true, message: "网页控件未接受写入；请手动粘贴复制的字段。" };
  }

  async function handleChipAction(mode) {
    const action = state.chipAction;
    closeChipActionMenu();
    if (!action || !["add", "replace"].includes(mode)) {
      return;
    }

    await copyText(action.value);
    const filled = await applyChipValue(action.target, action.value, mode, action.selection, action.button.dataset.chipId);
    if (!filled) {
      return;
    }
  }

  function showChipActionMenu(button, target, value, selection) {
    const menu = shadowRoot?.querySelector("#resume-pro-chip-actions");
    if (!menu) {
      return;
    }

    state.chipAction = { button, target, value, selection };
    menu.hidden = false;
    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(buttonRect.left, window.innerWidth - menuRect.width - 8));
    const fitsBelow = buttonRect.bottom + menuRect.height + 8 <= window.innerHeight;
    const top = fitsBelow ? buttonRect.bottom + 6 : Math.max(8, buttonRect.top - menuRect.height - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function closeChipActionMenu() {
    const menu = shadowRoot?.querySelector?.("#resume-pro-chip-actions");
    if (menu) {
      menu.hidden = true;
    }
    state.chipAction = null;
  }

  function readLiveTextSelection(target) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      let start;
      let end;
      try {
        start = target.selectionStart;
        end = target.selectionEnd;
      } catch {
        return null;
      }
      return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
    }

    const selection = window.getSelection?.();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!target.contains?.(range.commonAncestorContainer)) return null;
    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(target);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = range.cloneRange();
    beforeEnd.selectNodeContents(target);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return { start: beforeStart.toString().length, end: beforeEnd.toString().length };
  }

  function validTextSelection(selection, length) {
    if (!selection || !Number.isInteger(selection.start) || !Number.isInteger(selection.end)) return null;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    return start >= 0 && end <= length ? { start, end } : null;
  }

  // 优先取网页里此刻的光标；取不到（例如 contenteditable 失焦后选区没了，或 email
  // 输入框没有 selectionStart）就用最后保存的；再无效就回到文本末尾。
  function resolveTextSelection(target) {
    const length = getComposableTargetValue(target).length;
    const live = validTextSelection(readLiveTextSelection(target), length);
    if (live) {
      savedTextSelections.set(target, live);
      return live;
    }
    const saved = validTextSelection(savedTextSelections.get(target), length);
    return saved || { start: length, end: length };
  }

  function captureTextSelection(target) {
    return resolveTextSelection(target);
  }

  function rememberTextSelection(target) {
    // 只记光标下标，不记文本；这里不做敏感判断，避免每次 selectionchange 都去找标签。
    const textual = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable);
    if (!textual || chipWriteTargets.has(target)) return;
    const live = validTextSelection(readLiveTextSelection(target), getComposableTargetValue(target).length);
    if (live) savedTextSelections.set(target, live);
  }

  function composeChipText(currentValue, chipValue, mode, selection = {}) {
    const current = String(currentValue || "");
    const chip = String(chipValue || "");
    const rawStart = Number.isInteger(selection.start) ? selection.start : current.length;
    const start = Math.min(Math.max(0, rawStart), current.length);

    if (!chip) {
      return { value: current, caret: start, changed: false };
    }

    if (mode === "replace") {
      return { value: chip, caret: chip.length, changed: current !== chip };
    }

    if (mode === "remove") {
      const index = findNearestChipOccurrence(current, chip, start);
      if (index < 0) {
        return { value: current, caret: start, changed: false };
      }
      return {
        value: current.slice(0, index) + current.slice(index + chip.length),
        caret: index,
        changed: true
      };
    }

    return {
      value: current.slice(0, start) + chip + current.slice(start),
      caret: start + chip.length,
      changed: true
    };
  }

  function findNearestChipOccurrence(current, chip, caret) {
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let index = current.indexOf(chip);
    while (index >= 0) {
      const distance = caret < index ? index - caret : caret > index + chip.length ? caret - (index + chip.length) : 0;
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
      index = current.indexOf(chip, index + Math.max(1, chip.length));
    }
    return nearestIndex;
  }

  async function applyChipValue(target, chipValue, mode, selection, chipId = "") {
    if (!isComposableTextTarget(target) || !document.contains(target)) {
      return false;
    }

    const composed = composeChipText(getComposableTargetValue(target), chipValue, mode, selection);
    if (!composed.changed) {
      if (mode === "replace" && chipId) {
        updateTrackedChipSelection(target, chipId, mode);
        syncChipSelectionState();
        return true;
      }
      return false;
    }

    const hadTrackedSelection = chipSelectionIdsByTarget.has(target);
    const previousSelection = new Set(chipSelectionIdsByTarget.get(target) || []);
    updateTrackedChipSelection(target, chipId, mode);
    chipWriteTargets.add(target);
    let filled;
    try {
      filled = await Promise.resolve(setElementValue(target, composed.value));
    } finally {
      chipWriteTargets.delete(target);
    }
    if (!filled) {
      if (chipId) {
        if (hadTrackedSelection) {
          chipSelectionIdsByTarget.set(target, previousSelection);
        } else {
          chipSelectionIdsByTarget.delete(target);
        }
      }
      return false;
    }

    target.focus?.();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.setSelectionRange?.(composed.caret, composed.caret);
    } else {
      setContentEditableCaret(target, composed.caret);
    }
    savedTextSelections.set(target, { start: composed.caret, end: composed.caret });
    state.lastFocusedField = target;
    syncChipSelectionState();
    return true;
  }

  function getComposableTargetValue(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? String(target.value || "")
      : String(target.textContent || "");
  }

  function findTextPosition(root, offset) {
    let remaining = offset;
    let last = null;
    const walk = (node) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const length = child.textContent?.length || 0;
          if (remaining <= length) return { node: child, offset: remaining };
          remaining -= length;
          last = child;
        } else if (child.firstChild) {
          const found = walk(child);
          if (found) return found;
        }
      }
      return null;
    };
    const found = walk(root);
    if (found) return found;
    return last ? { node: last, offset: last.textContent?.length || 0 } : { node: root, offset: 0 };
  }

  function setContentEditableCaret(target, caret) {
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (!selection || !range) {
      return;
    }
    const position = findTextPosition(target, caret);
    range.setStart(position.node, position.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 验证码、一次性口令类字段不能只看 input.type：这里复用档案里的敏感词表，再补上
  // 验证码/OTP 的常见写法，以及浏览器自己的 autocomplete 声明。
  const OTP_HINT = /(?:^|[^a-z])otp(?:[^a-z]|$)|one[-_ ]?time|sms[-_ ]?code|verif(?:y|ication)[-_ ]?code|security[-_ ]?code|captcha|验证码|校验码|短信码|动态码|安全码/i;

  function isSensitiveTextTarget(target) {
    if (!(target instanceof HTMLElement)) return false;
    const type = String(target.type || "").toLowerCase();
    if (type === "password") return true;
    const attr = (name) => String(target.getAttribute?.(name) || "");
    if (/one-time-code|current-password|new-password/i.test(attr("autocomplete"))) return true;
    let label = "";
    try {
      label = getFieldLabel(target);
    } catch {
      label = "";
    }
    const hint = [target.name, target.id, attr("placeholder"), attr("aria-label"), attr("data-label"), label].join(" ");
    const secret = self.ResumeProProfile?.SECRET_LABEL;
    return OTP_HINT.test(hint) || Boolean(secret && secret.test(hint));
  }

  function isBlockedFillTarget(target) {
    return isSensitiveTextTarget(target)
      || (target instanceof HTMLInputElement && String(target.type || "").toLowerCase() === "file");
  }

  function isComposableTextTarget(target) {
    if (!(target instanceof HTMLElement) || target.disabled || target.readOnly || isSensitiveTextTarget(target)) {
      return false;
    }
    if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
      return true;
    }
    return target instanceof HTMLInputElement && ["text", "search", "tel", "url", "email"].includes(target.type || "text");
  }

  function syncChipSelectionState() {
    // 侧栏在线时，选中状态以侧栏发来的字段清单为准；隐藏的旧字段可能比它旧。
    if (!shadowRoot?.querySelectorAll || Date.now() - panelQueriedAt < PANEL_ONLINE_MS) {
      return;
    }
    const target = getLastFocusedFillTarget();
    const currentValue = target && isComposableTextTarget(target) ? getComposableTargetValue(target) : "";
    const buttons = Array.from(shadowRoot.querySelectorAll(".resume-pro__chip"));
    const selectedIds = target && isComposableTextTarget(target)
      ? resolveSelectedChipIds(target, buttons, currentValue)
      : new Set();
    buttons.forEach((button) => {
      const selected = selectedIds.has(button.dataset.chipId);
      button.classList.toggle("is-in-field", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function updateTrackedChipSelection(target, chipId, mode) {
    if (!chipId) {
      return;
    }
    const selectedIds = new Set(chipSelectionIdsByTarget.get(target) || []);
    if (mode === "replace") {
      selectedIds.clear();
    }
    if (mode === "remove") {
      selectedIds.delete(chipId);
    } else {
      selectedIds.add(chipId);
    }
    chipSelectionIdsByTarget.set(target, selectedIds);
  }

  function resolveSelectedChipIds(target, buttons, currentValue) {
    const hasTrackedSelection = chipSelectionIdsByTarget.has(target);
    const previousIds = chipSelectionIdsByTarget.get(target) || new Set();
    const nextIds = new Set();
    const buttonsByValue = new Map();

    buttons.forEach((button, index) => {
      if (!button.dataset.chipId) {
        button.dataset.chipId = `rendered-chip-${index}`;
      }
      const value = button.dataset.value || "";
      if (!value) {
        return;
      }
      if (!buttonsByValue.has(value)) {
        buttonsByValue.set(value, []);
      }
      buttonsByValue.get(value).push(button);
    });

    buttonsByValue.forEach((sameValueButtons, value) => {
      let remaining = countTextOccurrences(currentValue, value);
      const preferred = sameValueButtons.filter((button) => previousIds.has(button.dataset.chipId));
      const candidates = hasTrackedSelection
        ? preferred
        : sameValueButtons;
      candidates.forEach((button) => {
        if (remaining > 0) {
          nextIds.add(button.dataset.chipId);
          remaining -= 1;
        }
      });
    });

    chipSelectionIdsByTarget.set(target, nextIds);
    return nextIds;
  }

  function countTextOccurrences(text, value) {
    if (!value) {
      return 0;
    }
    let count = 0;
    let index = String(text || "").indexOf(value);
    while (index >= 0) {
      count += 1;
      index = String(text || "").indexOf(value, index + value.length);
    }
    return count;
  }

  function newRequestId() {
    return crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join("-");
  }

  // A fill record's id has to be a real UUID (link/fillrecords.mjs). `randomUUID` is missing
  // on plain-http pages, so the same shape is built from random bytes there.
  function newRecordId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // The retained page button is guarded while Chrome/Edge use the native side panel (#188).
  async function handleRepeatFillClick(event) {
    const button = event.currentTarget;
    if (state.nativeSidePanel) {
      showStatus("请在浏览器侧栏的「填写」页使用「AI 辅助新增条目」。", "error");
      return;
    }
    const fillButton = shadowRoot.querySelector("#resume-pro-ai-fill");
    if (button.disabled || fillButton.disabled || state.aiBusy) return;
    state.aiBusy = true;
    state.suggestedView = null;
    const release = message => {
      state.aiBusy = false;
      fillButton.disabled = state.desktopMode !== "ready" || !hasResumeData();
      button.disabled = state.desktopMode !== "ready" || !getActiveTemplate(state.currentStore);
      if (message) showStatus(message, "error");
    };
    state.currentStore = await StorageService.getState();
    if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    if (state.desktopMode !== "ready") {
      release(self.ResumeProResumeData.modeCopy(state.desktopMode).message);
      return;
    }
    const template = getActiveTemplate(state.currentStore);
    const templateFingerprint = JSON.stringify(template);
    if (!template) {
      release("请先在桌面准备简历模板。");
      return;
    }
    const agent = self.ResumeProFormAgent;
    let snapshot;
    try { snapshot = agent.collect(document, flattenTemplateFields(template)); }
    catch { release("无法识别网页分组，请手动新增条目。"); return; }
    if (!snapshot.candidates.length) {
      release("未识别到可安全新增的分组，请先手动新增条目，再一键填写。");
      return;
    }
    button.disabled = true;
    fillButton.disabled = true;
    const cancel = shadowRoot.querySelector("#resume-pro-cancel-fill");
    const hint = shadowRoot.querySelector("#resume-pro-wait-hint");
    const requestId = newRequestId();
    let stopped = false;
    let planning = true;
    let expanded;
    cancel.hidden = false;
    cancel.disabled = false;
    cancel.textContent = "停止辅助新增";
    cancel.onclick = () => {
      stopped = true;
      cancel.disabled = true;
      if (planning) self.ResumeProAIClient.cancel(requestId).catch(() => {});
    };
    const start = performance.now();
    const progress = () => {
      const seconds = Math.floor((performance.now() - start) / 1000);
      button.textContent = `AI 规划中... ${seconds}s`;
      if (seconds >= 90) {
        hint.hidden = false;
        hint.textContent = "正在等待 AI 规划，上游模型、中转或网络可能较慢；不会自动取消，可手动停止。";
      }
    };
    progress();
    const timer = window.setInterval(progress, 1000);
    try {
      const reply = await self.ResumeProAIClient.send({ type: "AI_PLAN_REPEAT", requestId, candidates: snapshot.candidates });
      planning = false;
      window.clearInterval(timer);
      if (stopped) throw new Error("已停止，未执行新增。");
      if (!reply?.success) {
        if (reply?.openView === "settings-ai") {
          state.suggestedView = "settings-ai";
          await openManager("settings-ai");
        }
        throw new Error(reply?.error || "AI 规划失败，未执行新增。可稍后重试或手动新增。");
      }
      const plan = agent.validatePlan(reply.plan, snapshot.candidates);
      if (!plan.length) throw new Error("AI 未给出可确认的新增操作，请手动处理。");
      const preview = plan.map(action => `${snapshot.candidates.find(c => c.id === action.id).label}：${action.count} 条`).join("\n");
      if (!window.confirm(`允许以下操作吗？\n${preview}\n\n确认后将点击网页新增按钮，再用 AI 填写这些分组的空字段。不会提交、删除或覆盖已有内容。网页自身可能保存新条目；停止后不自动删除。`)) return;
      state.currentStore = await StorageService.getState();
      if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
      if (JSON.stringify(getActiveTemplate(state.currentStore)) !== templateFingerprint) throw new Error("当前模板已变化，请重新预览。");
      button.textContent = "正在新增并检查网页...";
      hint.hidden = true;
      expanded = await agent.execute(plan, snapshot, () => stopped || JSON.stringify(getActiveTemplate(state.currentStore)) !== templateFingerprint);
    } catch (error) {
      showStatus(error.message || "辅助新增失败，请手动核对网页。", "error");
    } finally {
      window.clearInterval(timer);
      cancel.hidden = true;
      cancel.onclick = null;
      cancel.textContent = "取消 AI 等待（保留本地匹配）";
      hint.hidden = true;
      button.disabled = state.desktopMode !== "ready" || !getActiveTemplate(state.currentStore);
      state.aiBusy = false;
      fillButton.disabled = state.desktopMode !== "ready" || !hasResumeData();
      button.textContent = "AI 辅助新增条目（先预览）";
    }
    if (expanded && !stopped) {
      state.currentStore = await StorageService.getState();
      if (JSON.stringify(getActiveTemplate(state.currentStore)) === templateFingerprint) {
        await handleAiFillClick({ currentTarget: fillButton }, { scopes: expanded.scopes });
      } else {
        showStatus("当前模板已变化，已停止辅助填写，请重新预览。", "error");
      }
    }
  }

  // #188：原生侧栏的「AI 辅助新增条目」。扫描、规划、预览、执行、填写都在这里跑，侧栏只显示
  // describeRepeat() 给出的有限字段，并用 requestId 发确认、取消、停止。一次操作绑定本页地址、
  // 模板 ID 与内容、扫描时的候选；任何一项变了，旧计划作废，不再点击网页。

  function repeatActive() {
    return REPEAT_ACTIVE.includes(repeat.phase);
  }

  function repeatLabel(domain) {
    return self.ResumeProFormAgent?.labels?.[domain] || "条目";
  }

  function repeatAddedNote(added) {
    return added > 0 ? `已经新增的 ${added} 条空记录会保留，请在网页中核对。` : "网页没有新增条目。";
  }

  function setRepeat(run, phase, message, extra = {}) {
    if (repeat.run !== run) return false;
    repeat.phase = phase;
    repeat.message = message;
    if (extra.plan) repeat.plan = extra.plan;
    if (Number.isInteger(extra.added)) repeat.added = extra.added;
    if (!REPEAT_ACTIVE.includes(phase)) {
      run.done = true;
      state.aiBusy = false;
      if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    }
    return true;
  }

  // Everything the side panel may see. Labels come from our fixed domain table, never the page.
  function describeRepeat() {
    const run = repeat.run;
    // A tab switch or address change (an SPA moving to another job fires no page event) ends
    // any run in flight. Scanning, planning and preview stop here; execution and filling see the
    // flag before their next step and report the rows they really added.
    if (run && !run.done && repeatActive() && repeatStale(run)) invalidateRepeat(repeatStale(run));
    const phase = repeat.phase;
    return {
      phase,
      requestId: repeat.requestId,
      message: repeat.message,
      plan: repeat.plan.map(({ domain, count }) => ({ domain, count })),
      added: repeat.added,
      canConfirm: phase === "preview",
      canCancel: phase === "preview",
      canStop: REPEAT_STOPPABLE.includes(phase)
    };
  }

  // Why this run may no longer touch the page, or "" while it still may.
  function repeatStale(run) {
    if (run.invalid) return run.invalid;
    if (location.href !== run.url) return "网页地址已变化，计划已失效，请重新预览。";
    if (document.hidden) return "已切换到其他标签页，计划已失效，请重新预览。";
    return "";
  }

  function repeatStopped(run) {
    return run.stopped || repeat.run !== run || Boolean(repeatStale(run));
  }

  // Ends whatever run is in flight. A planning request is cancelled; an execution sees the
  // flag at its next check and stops before the next click.
  function stopRepeat(run, message) {
    if (!run || run.done) return;
    run.stopped = true;
    if (repeat.phase === "planning") self.ResumeProAIClient.cancel(run.requestId).catch(() => {});
    if (repeat.phase === "filling" && run.fillRequestId) self.ResumeProAIClient.cancel(run.fillRequestId).catch(() => {});
    // Planning and preview have not clicked anything, so they end here. Execution and filling
    // finish their current step and then report the real count.
    if (["scanning", "planning", "preview"].includes(repeat.phase)) setRepeat(run, "stopped", message);
  }

  function invalidateRepeat(reason) {
    const run = repeat.run;
    if (!run || run.done) return false;
    run.invalid = reason;
    stopRepeat(run, reason);
    return true;
  }

  async function startRepeat() {
    if (repeatActive() || state.aiBusy) return { ok: false, error: "已有填写或新增正在进行，请先完成或停止。" };
    const run = { requestId: newRequestId(), url: location.href, stopped: false, invalid: "", done: false };
    repeat.run = run;
    repeat.requestId = run.requestId;
    repeat.plan = [];
    repeat.added = 0;
    state.aiBusy = true;
    state.suggestedView = null;
    setRepeat(run, "scanning", "正在检查网页中可以安全新增的经历…");
    planRepeat(run).catch(error => {
      if (!run.done) setRepeat(run, "failed", error?.message || "辅助新增失败，请手动核对网页。");
    });
    return { ok: true, requestId: run.requestId };
  }

  // A run that went stale while waiting ends with its reason instead of staying "in progress".
  // A user stop has already ended it, and a newer run owns the card.
  function abandonRepeat(run) {
    if (!run.done && repeat.run === run) setRepeat(run, "stopped", repeatStale(run) || "已停止，未新增任何条目。");
  }

  async function planRepeat(run) {
    state.currentStore = await StorageService.getState();
    if (repeatStopped(run)) { abandonRepeat(run); return; }
    if (state.desktopMode !== "ready") {
      setRepeat(run, "failed", self.ResumeProResumeData.modeCopy(state.desktopMode).message);
      return;
    }
    const template = getActiveTemplate(state.currentStore);
    if (!template) {
      setRepeat(run, "failed", "请先在桌面准备简历模板。");
      return;
    }
    run.templateId = template.id;
    run.fingerprint = JSON.stringify(template);
    const agent = self.ResumeProFormAgent;
    try {
      run.snapshot = agent.collect(document, flattenTemplateFields(template));
    } catch {
      setRepeat(run, "failed", "无法识别网页分组，请手动新增条目。");
      return;
    }
    if (!run.snapshot.candidates.length) {
      setRepeat(run, "failed", "未识别到可安全新增的分组，请先手动新增条目，再一键填写。");
      return;
    }
    setRepeat(run, "planning", "AI 正在规划需要新增的条目…");
    // Only the local candidate summary goes out: id, domain, label, current, target.
    const reply = await self.ResumeProAIClient.send({ type: "AI_PLAN_REPEAT", requestId: run.requestId, candidates: run.snapshot.candidates });
    // A stop, cancel, tab switch or newer run already answered the user; this reply is late.
    if (repeatStopped(run)) { abandonRepeat(run); return; }
    if (!reply?.success) {
      if (reply?.openView === "settings-ai") {
        state.suggestedView = "settings-ai";
        await openManager("settings-ai").catch(() => {});
      }
      setRepeat(run, "failed", reply?.error || "AI 规划失败，未执行新增。可稍后重试或手动新增。");
      return;
    }
    let plan;
    try {
      plan = agent.validatePlan(reply.plan, run.snapshot.candidates);
    } catch (error) {
      setRepeat(run, "failed", `${error.message || "AI 计划无效。"}未执行新增。`);
      return;
    }
    if (!plan.length) {
      setRepeat(run, "failed", "AI 未给出可确认的新增操作，请手动处理。");
      return;
    }
    run.plan = plan;
    const preview = plan.map(action => ({ domain: run.snapshot.candidates.find(c => c.id === action.id).domain, count: action.count }));
    setRepeat(run, "preview", "计划新增以下条目：", { plan: preview });
  }

  // The desktop template and the page's candidates must still be what the user previewed.
  async function recheckRepeat(run) {
    const stale = repeatStale(run);
    if (stale) return stale;
    state.currentStore = await StorageService.getState();
    if (repeatStopped(run)) return repeatStale(run) || "已停止。";
    const template = getActiveTemplate(state.currentStore);
    if (state.desktopMode !== "ready" || !template || template.id !== run.templateId || JSON.stringify(template) !== run.fingerprint) {
      return "当前模板已变化，计划已失效，请重新预览。";
    }
    return "";
  }

  // The page's candidates must be exactly the scanned ones, moved on only by the rows this plan
  // has added so far (`addedById`). A group that appears, goes, is rebuilt or grows by itself
  // means the plan the user confirmed no longer describes the page.
  function repeatGroupsAsExpected(run, addedById) {
    let fresh;
    try {
      fresh = self.ResumeProFormAgent.collect(document, flattenTemplateFields(JSON.parse(run.fingerprint)));
    } catch {
      return false;
    }
    const expected = run.snapshot.candidates
      .map(c => ({ button: run.snapshot.refs.get(c.id)?.button, domain: c.domain, label: c.label, current: c.current + (addedById.get(c.id) || 0), target: c.target }))
      .filter(c => c.current < c.target);
    const actual = fresh.candidates
      .map(c => ({ button: fresh.refs.get(c.id)?.button, domain: c.domain, label: c.label, current: c.current, target: c.target }));
    return expected.length === actual.length && expected.every((c, i) => c.button === actual[i].button
      && c.domain === actual[i].domain && c.label === actual[i].label && c.current === actual[i].current && c.target === actual[i].target);
  }

  // Rows this plan has added before `step`'s click, per candidate.
  function repeatAddedBefore(run, step) {
    const added = new Map();
    for (const action of run.plan) {
      if (action.id === step.id) { added.set(action.id, step.index - 1); break; }
      added.set(action.id, action.count);
    }
    return added;
  }

  async function confirmRepeat(requestId) {
    const run = repeat.run;
    if (repeat.phase !== "preview" || !run || run.done || run.requestId !== requestId) {
      return { ok: false, error: "这个计划已经失效，请重新预览。" };
    }
    // The phase moves before any await, so a second 确认新增 finds no preview to confirm.
    setRepeat(run, "executing", "正在核对网页和模板…");
    executeRepeat(run).catch(error => {
      if (!run.done) setRepeat(run, "failed", error?.message || "辅助新增失败，请手动核对网页。");
    });
    return { ok: true };
  }

  async function executeRepeat(run) {
    const stale = await recheckRepeat(run) || (repeatGroupsAsExpected(run, new Map()) ? "" : "网页分组已变化，计划已失效，请重新预览。");
    if (stale) {
      setRepeat(run, "stopped", `${stale}${repeatAddedNote(0)}`, { added: 0 });
      return;
    }
    let expanded;
    try {
      expanded = await self.ResumeProFormAgent.execute(run.plan, run.snapshot, () => repeatStopped(run), progress => {
        setRepeat(run, "executing", `正在新增${repeatLabel(progress.domain)} ${progress.index}/${progress.count}…`, { added: progress.added });
      }, step => repeatGroupsAsExpected(run, repeatAddedBefore(run, step)));
    } catch (error) {
      const added = Number.isInteger(error?.added) ? error.added : repeat.added;
      if (run.stopped || repeatStale(run)) {
        setRepeat(run, "stopped", `${run.invalid || repeatStale(run) || "已停止。"}${repeatAddedNote(added)}`, { added });
      } else {
        setRepeat(run, "failed", `${error?.message || "辅助新增失败。"}${added > 0 ? repeatAddedNote(added) : ""}`, { added });
      }
      return;
    }
    const added = expanded.added;
    const summary = run.plan.map(action => `${repeatLabel(run.snapshot.candidates.find(c => c.id === action.id).domain)} ${action.count} 条`).join("、");
    setRepeat(run, "filling", `已新增${summary}，正在填写新增的分组…`, { added });
    const stale2 = await recheckRepeat(run);
    if (stale2) {
      setRepeat(run, "stopped", `${stale2}已停止填写。${repeatAddedNote(added)}`, { added });
      return;
    }
    // Only the new scopes, only empty text fields; the fill itself never submits the form.
    state.aiBusy = false;
    const fillButton = shadowRoot?.querySelector("#resume-pro-ai-fill");
    if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    const result = fillButton
      ? await handleAiFillClick({ currentTarget: fillButton }, {
        scopes: expanded.scopes, quiet: true,
        stopped: () => repeatStopped(run),
        onRequest: id => { run.fillRequestId = id; }
      })
      : { outcome: "failed", filledCount: 0, unconfirmedCount: 0, error: "填写控件不可用。" };
    if (repeat.run !== run) return;
    // Fields may already be written when a stop or failure lands mid-fill: say so, not "空记录".
    const filled = Number.isInteger(result?.filledCount) ? result.filledCount : 0;
    const unconfirmed = Number.isInteger(result?.unconfirmedCount) ? result.unconfirmedCount : 0;
    const kept = filled || unconfirmed
      ? `已新增的 ${added} 条记录会保留，其中 ${filled} 项已确认填写${unconfirmed ? `，${unconfirmed} 项可能已写入但未确认` : ""}，请在网页中核对。`
      : repeatAddedNote(added);
    if (run.stopped || repeatStale(run)) {
      setRepeat(run, "stopped", `${run.invalid || repeatStale(run) || ""}已停止填写。${kept}`, { added });
    } else if (result?.outcome === "success") {
      setRepeat(run, "completed", `已新增${summary}，并完成新字段填写（${result.filledCount} 项）。请核对网页内容。`, { added });
    } else if (result?.outcome === "partial") {
      setRepeat(run, "completed", `已新增${summary}；新字段已填写 ${result.filledCount} 项${result.unconfirmedCount ? `，${result.unconfirmedCount} 项未确认` : ""}，请核对网页内容。`, { added });
    } else {
      const why = result?.error && result.error !== "busy" ? result.error : "填写没有开始";
      setRepeat(run, "failed", `已新增${summary}，但新字段${filled > 0 ? "没有填完" : "没有填写"}：${why}。${kept}`, { added });
    }
  }

  function handlePanelRepeat(message) {
    const action = String(message?.action || "");
    const requestId = typeof message?.requestId === "string" ? message.requestId : "";
    const run = repeat.run;
    const current = run && !run.done && requestId === run.requestId;
    if (action === "start") return startRepeat();
    if (action === "confirm") return confirmRepeat(requestId);
    if (action === "cancel") {
      if (!current || repeat.phase !== "preview") return { ok: false, error: "这个计划已经结束了。" };
      run.stopped = true;
      setRepeat(run, "stopped", "已取消，网页没有变化。");
      return { ok: true };
    }
    if (action === "stop") {
      if (!current || !REPEAT_STOPPABLE.includes(repeat.phase)) return { ok: false, error: "当前没有可以停止的新增。" };
      stopRepeat(run, "已停止，未新增任何条目。");
      return { ok: true };
    }
    if (action === "invalidate") {
      // The side panel switched the template: whatever was planned was for the old one.
      invalidateRepeat("当前模板已切换，计划已失效，请重新预览。");
      return { ok: true };
    }
    if (action === "dismiss") {
      if (repeatActive()) return { ok: false, error: "新增还在进行。" };
      repeat.phase = "idle";
      repeat.requestId = "";
      repeat.message = "";
      repeat.plan = [];
      repeat.added = 0;
      repeat.run = null;
      return { ok: true };
    }
    return { ok: false, error: "当前操作不可用。" };
  }

  function isAssistedTextField(entry) {
    const el = entry.element;
    if (["custom-select", "cascader"].includes(entry.controlKind)) return false;
    return !el.disabled && !el.readOnly && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "email", "tel", "url", "search"].includes(el.type)));
  }

  function hasExistingValue(entry) {
    if (entry.kind === "radio") return entry.elements.some(el => el.checked);
    const el = entry.element;
    if (!el?.isConnected) return true;
    if (["custom-select", "cascader"].includes(entry.controlKind) && self.ResumeProCustomControls) {
      return self.ResumeProCustomControls.hasExistingValue(entry)
        || Boolean(entry.binding && self.ResumeProFieldScan?.hasDisplayedValue(entry.binding, { isVisible }));
    }
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    if (el.multiple && el.options) return Array.from(el.options).some(option => option.selected
      && !(option.value === "" && self.ResumeProAIHelpers?.isPlaceholderOption?.({ value: option.value, text: option.text, disabled: option.disabled })));
    if (String(el.value ?? el.textContent ?? "").trim()) return true;
    // 自定义下拉选好的内容显示在组件里，内部 input 常常是空的。
    return entry.controlKind === "custom-select" && Boolean(entry.binding)
      && Boolean(self.ResumeProFieldScan?.hasDisplayedValue(entry.binding, { isVisible }));
  }

  // 只在本次填写期间比较网页值，不保存或发送到桌面/AI。
  function fillValueSnapshot(entry) {
    if (entry.kind === "radio") return entry.elements.every(el => el.isConnected)
      ? JSON.stringify(entry.elements.map(el => [el.value, el.checked])) : null;
    const el = entry.element;
    if (!el?.isConnected) return null;
    if (["custom-select", "cascader"].includes(entry.controlKind) && self.ResumeProCustomControls) {
      const state = self.ResumeProCustomControls.snapshot(entry);
      return state === null ? null : JSON.stringify([state,
        entry.binding ? self.ResumeProFieldScan?.displayedStateForGuard?.(entry.binding, { isVisible }) || [] : []]);
    }
    if (el.type === "checkbox" || el.type === "radio") return JSON.stringify(el.checked);
    if (el.multiple && el.options) return JSON.stringify(Array.from(el.options, option => [option.value, option.selected]));
    if (el instanceof HTMLSelectElement) {
      const option = el.options[el.selectedIndex];
      const emptyPlaceholder = el.value === "" && (el.selectedIndex < 0
        || (option && self.ResumeProAIHelpers?.isPlaceholderOption?.({ value: option.value, text: option.text, disabled: option.disabled })));
      return JSON.stringify([el.value, emptyPlaceholder ? -1 : el.selectedIndex]);
    }
    return String(el.value ?? el.textContent ?? "");
  }

  // `assisted` limits filling to new rows. The returned summary supplies the side panel;
  // `stopped` and `onRequest` let it stop the AI wait and subsequent writes.
  async function handleAiFillClick(event, assisted = null) {
    const button = event.currentTarget;
    const failed = error => ({ outcome: "failed", filledCount: 0, unconfirmedCount: 0, error });
    if (button.disabled || state.aiBusy) return failed("busy");
    const report = assisted?.quiet ? () => {} : showStatus;
    state.aiBusy = true;
    state.suggestedView = null;
    state.currentStore = await StorageService.getState();
    if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
    if (state.desktopMode !== "ready") {
      state.aiBusy = false;
      const message = self.ResumeProResumeData.modeCopy(state.desktopMode).message;
      report(message, "error");
      return failed(message);
    }
    const activeTemplate = getActiveTemplate(state.currentStore);
    const activeTemplateFingerprint = JSON.stringify(activeTemplate);

    const profileFields = profileResumeFields();

    if (!activeTemplate && !profileFields.length) {
      state.aiBusy = false;
      report("请先导入简历模板，或在「我的信息」里填写内容。", "error");
      return failed("请先导入简历模板，或在「我的信息」里填写内容。");
    }

    button.disabled = true;
    // Warm the desktop modules while the fill runs, so that when it ends the page can be read
    // for the archive offer without waiting on anything (see offerFillRecord).
    loadDesktopModules().catch(() => {});
    const repeatButton = shadowRoot?.querySelector("#resume-pro-repeat-fill");
    if (repeatButton) repeatButton.disabled = true;
    button.textContent = "正在扫描网页...";
    const totalStart = performance.now();
    const timing = { scanMs: null, roundTripMs: null, fillMs: null };
    let phaseStart = totalStart;
    let phase = "scanMs";
    let timer = null;
    let diagnostics = {};
    let fieldCount = 0;
    let filledCount = 0;
    let unconfirmedCount = 0;
    const verifiedControls = [];
    let recheckVerifiedControls = () => {};
    const unfilledLabels = [];
    const unfilledControls = [];
    let probe = null;
    // 诊断 v1（#215）：失败卡在哪一步，以及这个页面像不像网申填写页。
    const readyAtScan = document.readyState === "complete";
    let scanDone = false;
    let stage = "scan";
    let failedStage = null;
    let requested = false;
    let responded = false;
    let matched = null;
    let stats = null;
    let pageType = null;
    let scanPath = location.pathname;
    // 猎聘这类查看状态的页面：页头搜索框之类会被扫描到，但一个都没填上，照样提示先点「编辑」。
    const viewModeHint = () => !assisted && filledCount === 0 && probe?.editButtons > 0
      ? withFillProbe(api => api.emptyPageHint(probe), "") : "";
    let outcome = "failed";
    let failure = "";
    // 失败信息里带了「先点编辑」这类提示：要一直留在屏幕上，不像别的失败几秒后消失。
    let hinted = false;
    const requestId = newRequestId();
    const cancelButton = shadowRoot?.querySelector("#resume-pro-cancel-fill");
    const waitHint = shadowRoot?.querySelector("#resume-pro-wait-hint");
    let cancelRequested = false;
    let writeCancelled = false;
    const fillUrl = location.href;
    let overwriteDeclined = false;
    // 辅助新增条目是同一次一键填写的延续，接着用当前会话；其余每次都开新会话，上一次的记录清掉。
    const session = assisted && fillSession ? fillSession : beginFillSession();

    try {
      const scanned = scanFillableFields();
      const fieldMap = scanned.fieldMap;
      const fields = assisted ? scanned.fields.filter(field => {
        const entry = fieldMap.get(field.fieldId);
        return entry?.kind === "element" && isAssistedTextField(entry) && assisted.scopes.some(scope => scope.contains(entry.element)) && !hasExistingValue(entry);
      }) : scanned.fields;
      fieldCount = fields.length;
      timing.scanMs = performance.now() - phaseStart;
      phase = null;
      scanDone = true;
      // 单页应用可能在填写途中换页：诊断描述的是扫描时的那一页。
      scanPath = location.pathname;
      stats = { ...scanned.stats, outOfScope: scanned.fields.length - fields.length };
      // 探测放在扫描计时之后：诊断里的「扫描」耗时不含探测。
      probe = withFillProbe(api => api.probePage(document, { href: location.href }), null);
      pageType = withFillProbe(api => api.pageType({ pathname: scanPath, hash: location.hash, title: document.title, probe, stats }), null);
      if (!fields.length) {
        // 辅助新增只是过滤后为空（页面本身有字段），或本来就在辅助新增：不给「先点编辑」这类提示。
        const hint = !assisted && !scanned.fields.length
          ? withFillProbe(api => api.emptyPageHint(probe, { notForm: pageType?.type === "unknown" }), "") : "";
        hinted = Boolean(hint);
        throw new Error(`当前页面没有可填写的表单字段。${hint}`);
      }
      if (!assisted) closeProfileOffer();
      // 模板字段在前并且优先；「我的信息」只补模板里没有的字段名。
      const templateFields = activeTemplate ? flattenTemplateFields(activeTemplate) : [];
      const resumeFields = self.ResumeProProfile
        ? self.ResumeProProfile.mergeResumeFields(templateFields, profileFields)
        : templateFields;
      // 诊断里要藏起来的简历内容（一个字的值太容易撞上普通字段名，不参与比较）。
      const resumeValues = resumeFields.map(field => normalizeForOverlap(field?.value)).filter(value => value.length >= 2);
      phase = "roundTripMs";
      stage = "match";
      phaseStart = performance.now();
      if (cancelButton) {
        cancelButton.hidden = false;
        cancelButton.disabled = false;
        cancelButton.onclick = async () => {
          if (phase === 'fillMs') {
            writeCancelled = true; cancelRequested = true; cancelButton.disabled = true;
            showStatus('已停止后续填写，请核对网页中已填写的内容。', 'error', true);
            return;
          }
          if (phase !== "roundTripMs") return;
          cancelRequested = true;
          cancelButton.disabled = true;
          try {
            const reply = await self.ResumeProAIClient.cancel(requestId);
            cancelRequested = Boolean(reply?.cancelled);
            if (waitHint && phase === "roundTripMs") {
              waitHint.hidden = false;
              waitHint.textContent = reply?.cancelled ? "正在取消 AI 等待，保留本地匹配结果。" : "请求已结束或无法取消，正在等待结果。";
            }
          } catch {
            cancelRequested = false;
            if (phase === "roundTripMs") {
              cancelButton.disabled = false;
              if (waitHint) {
                waitHint.hidden = false;
                waitHint.textContent = "取消请求未送达，请重试；当前请求可能仍在等待。";
              }
            }
          }
        };
      }
      const updateProgress = () => {
        const seconds = Math.floor((performance.now() - phaseStart) / 1000);
        button.textContent = `AI 匹配中... ${seconds}s`;
        if (seconds >= 90 && waitHint && !cancelRequested) {
          waitHint.hidden = false;
          waitHint.textContent = "AI 匹配尚未返回，等待通常与上游模型处理、中转服务或网络有关，输入量也会影响耗时。插件不会因等待较久自动取消；你可以继续等待或手动取消。";
        }
      };
      updateProgress();
      timer = window.setInterval(updateProgress, 1000);
      // A stop during the preparation above had no request to cancel yet: send nothing.
      if (assisted?.stopped?.()) throw new Error("已停止辅助填写。");
      assisted?.onRequest?.(requestId);
      requested = true;
      const response = await self.ResumeProAIClient.send({
        type: "AI_FILL",
        requestId,
        formFields: fields,
        resumeFields
      });
      timing.roundTripMs = performance.now() - phaseStart;
      phase = null;
      window.clearInterval(timer);
      timer = null;
      if (waitHint) waitHint.hidden = true;
      diagnostics = response?.diagnostics || {};
      responded = Boolean(response);
      // Cancellation may race a successful AI reply. Only the worker's explicitly
      // cancelled response may retain its documented local matches.
      if (cancelRequested && diagnostics.errorCode !== 'cancelled') {
        writeCancelled = true;
        throw new Error('已取消填写，忽略迟到的 AI 结果。');
      }
      matched = Array.isArray(response?.matches) ? response.matches.length : null;
      if (assisted?.stopped?.()) throw new Error("已停止辅助填写。");

      if (response?.openView === "settings-ai") {
        state.suggestedView = "settings-ai";
        await openManager("settings-ai");
      }
      if (!response?.success) {
        throw new Error(response?.error || "AI 填写失败。");
      }

      button.textContent = "正在填写网页...";
      phase = "fillMs";
      stage = "fill";
      phaseStart = performance.now();

      const fieldMetaMap = new Map(fields.map((f) => [f.fieldId, f]));
      const domOrderMap = new Map(fields.map((field, index) => [field.fieldId, index]));
      const sortedMatches = [...response.matches].sort((a, b) => {
        const ma = fieldMetaMap.get(a.fieldId);
        const mb = fieldMetaMap.get(b.fieldId);
        if (ma?.cascadeGroup !== undefined && ma.cascadeGroup === mb?.cascadeGroup) {
          return (ma.cascadeLevel ?? 0) - (mb.cascadeLevel ?? 0);
        }
        // 其余按页面顺序从上往下填：没被识别成联动组的省/市/县也能等上一级先选好。
        return (domOrderMap.get(a.fieldId) ?? 0) - (domOrderMap.get(b.fieldId) ?? 0);
      });

      const approvedValues = new Map();
      if (!assisted) {
        for (const match of sortedMatches) {
          const entry = fieldMap.get(match.fieldId);
          if (entry) approvedValues.set(entry, fillValueSnapshot(entry));
        }
        const occupiedCount = [...approvedValues.keys()].filter(hasExistingValue).length;
        if (occupiedCount && !window.confirm(
          `本次将重新填写 ${occupiedCount} 个已有内容的字段，可能覆盖你手动修改的内容。\n\n确定继续填写吗？取消将保留网页现有内容，本次不会写入任何字段。AI 匹配已完成，取消不会撤销已发生的 AI 请求。`
        )) {
          overwriteDeclined = true;
          cancelRequested = true;
          showStatus("已取消填写，网页现有内容未修改。", "error", true);
          return;
        }
      }

      const noteControlFailure = (element, fieldMeta, value, reason, uncertain) => {
        const control = element.kind === 'element' ? element.element : element;
        textFillFailures.set(control, reason);
        if (assisted) { if (uncertain !== false) unconfirmedCount += 1; return; }
        const label = fieldMeta?.label || fieldMeta?.placeholder || fieldMeta?.name || '未命名字段';
        const why = TEXT_FILL_FAILURE_LABELS[reason] || '';
        const shown = why ? `${label}（${why}）` : label;
        if (uncertain ?? ['verification_timeout', 'framework_state_unsynced', 'value_changed', 'cancelled', 'element_disconnected'].includes(reason)) {
          unconfirmedCount += 1;
        } else unfilledLabels.push(shown);
        // Preserve the existing overlap redaction for both immediate and final failures.
        const shownValue = normalizeForOverlap(value);
        const shownLabel = normalizeForOverlap(label);
        const overlaps = Boolean(shownValue && shownLabel) && (shownLabel === shownValue
          || (shownValue.length >= 2 && (shownLabel.includes(shownValue) || shownValue.includes(shownLabel))));
        const showsResume = Boolean(shownLabel) && resumeValues.some(value => shownLabel.includes(value));
        unfilledControls.push({ label: overlaps || showsResume ? '（字段名已隐藏）' : label, reason: why,
          reasonCode: reason, control: withFillProbe(api => api.describeControl(element), null) });
      };
      let controlsRechecked = false;
      recheckVerifiedControls = () => {
        if (controlsRechecked) return;
        controlsRechecked = true;
        for (const item of verifiedControls) {
          const checked = isFieldBindingCurrent(item.element) ? controlOperator?.check(item.element)
            : { ok: false, reason: 'element_disconnected' };
          if (checked && !checked.ok) {
            filledCount -= 1;
            noteControlFailure(item.element, item.fieldMeta, item.value, checked.reason);
          }
        }
      };
      const isCurrent = () => !writeCancelled && !assisted?.stopped?.()
        && location.href === fillUrl && session === fillSession;
      const failedCascadeGroups = new Set();
      for (const match of sortedMatches) {
        if (!isCurrent()) { cancelRequested = true; throw new Error('已停止填写，页面或填写会话已变化。'); }
        if (assisted?.stopped?.()) throw new Error("已停止辅助填写。");
        if (assisted && JSON.stringify(getActiveTemplate(state.currentStore)) !== activeTemplateFingerprint) throw new Error("模板已变化，已停止辅助填写，请核对网页。");
        const element = fieldMap.get(match.fieldId);

        if (!element) continue;
        // 匹配期间页面可能展开、重渲染：控件已经不在原来的题目下，就不按旧的对应关系写。
        if (!isFieldBindingCurrent(element)) {
          const stale = fieldMetaMap.get(match.fieldId);
          if (stale?.cascadeGroup !== undefined) failedCascadeGroups.add(stale.cascadeGroup);
          if (assisted) {
            unconfirmedCount += 1;
          } else {
            const staleMeta = fieldMetaMap.get(match.fieldId);
            unfilledLabels.push(`${staleMeta?.label || staleMeta?.placeholder || staleMeta?.name || "未命名字段"}（页面已变化）`);
            unfilledControls.push({ label: "（字段名已隐藏）", reason: "页面已变化",
              control: withFillProbe(api => api.describeControl(element), null) });
          }
          continue;
        }
        if (assisted && (!isAssistedTextField(element) || hasExistingValue(element) || !assisted.scopes.some(scope => scope.isConnected && scope.contains(element.element)))) continue;

        // 控件内部也会异步等待；实际写入及重试前复查，不能仅在进入控件时检查。
        const beforeWrite = assisted ? undefined : (userEdited = false) => {
          if (overwriteDeclined || !isCurrent()) return false;
          const currentValue = fillValueSnapshot(element);
          if (!userEdited && currentValue !== null && currentValue === approvedValues.get(element)) return true;
          overwriteDeclined = true;
          cancelRequested = true;
          outcome = filledCount ? "partial" : "failed";
          showStatus(`填写期间检测到字段内容变化，已停止后续填写，保留该字段的现有内容。此前已填写 ${filledCount} 项，请核对网页。`, "error", true);
          return false;
        };
        const fieldMeta = fieldMetaMap.get(match.fieldId);
        if (fieldMeta?.cascadeGroup !== undefined && failedCascadeGroups.has(fieldMeta.cascadeGroup)) {
          noteControlFailure(element, fieldMeta, match.value, 'cascade_parent_failed');
          continue;
        }
        // Host-owned accounting callback: a guard refusal before any write is
        // skipped, while an interrupted attempted write remains unconfirmed.
        let writeAttempted = false;
        const onWrite = () => { writeAttempted = true; };
        const controlCurrent = () => isCurrent() && isFieldBindingCurrent(element);
        const stopInterruptedControl = () => {
          if (!overwriteDeclined && isCurrent()) return;
          cancelRequested = true;
          noteControlFailure(element, fieldMeta, match.value, textFillFailureCode(element) || 'cancelled', writeAttempted);
          throw new Error(overwriteDeclined
            ? "字段内容已变化，已停止后续填写并保留现有内容，请核对网页。"
            : "已停止填写，请核对网页。");
        };
        let filled = await setElementValue(element, match.value, beforeWrite, controlCurrent, onWrite);
        stopInterruptedControl();
        if (assisted && filled) {
          await new Promise(resolve => window.setTimeout(resolve, 50));
          // 日期控件显示的是组件自己的格式（猎聘是「1998年06月」）：交给控件层按面板精度复核，不逐字比较（#236）。
          // 节点被页面替换的，两种都算未确认。
          filled = element.element.isConnected && (element.pickerType
            ? Boolean(controlOperator?.check(element)?.ok)
            : String(element.element.value ?? "") === normalizeExpectedTextValue(element.element, match.value));
        }

        // 联动下拉的选项是上一级选完才异步加载的。没被识别成联动组、但除了「请选择」还没有选项的下拉框
        // 也按同样的方式等一等（和 worker 放行它用的是同一个判断）；选项出来了却对不上，不再白等。
        if (!filled && element.kind === "element" && element.element instanceof HTMLSelectElement
          && (fieldMeta?.cascadeGroup !== undefined || !hasRealSelectOptions(element.element))) {
          for (let retry = 0; retry < 3; retry++) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            filled = await setElementValue(element, match.value, beforeWrite, controlCurrent, onWrite);
            stopInterruptedControl();
            if (filled || (fieldMeta?.cascadeGroup === undefined && hasRealSelectOptions(element.element))) break;
          }
        }

        if (filled) {
          filledCount += 1;
          verifiedControls.push({ element, fieldMeta, value: match.value });
          highlightFilledField(element, match.value);
          if (element.kind === "element" && !element.pickerType && !["custom-select", "cascader"].includes(element.controlKind)) {
            recordFilledTextControl(session, element.element);
          }
        } else {
          noteControlFailure(element, fieldMeta, match.value, textFillFailureCode(element));
          if (fieldMeta?.cascadeGroup !== undefined) failedCascadeGroups.add(fieldMeta.cascadeGroup);
        }

        if (filled && fieldMeta?.cascadeGroup !== undefined) {
          const groupFields = fields.filter((f) => f.cascadeGroup === fieldMeta.cascadeGroup);
          const maxLevelInGroup = Math.max(...groupFields.map((f) => f.cascadeLevel));
          
          if (fieldMeta.cascadeLevel < maxLevelInGroup) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }

      await finalSyncFillSession(session);
      // A later control's focus can roll back an earlier picker. Re-read the final
      // state before counting success; verification never writes or retries.
      recheckVerifiedControls();
      stage = null;

      outcome = response.warning || unconfirmedCount || unfilledLabels.length ? "partial" : "success";
      const unfilledNote = (unfilledLabels.length
        ? `${unfilledLabels.length} 项没填上：${summarizeLabels(unfilledLabels)}，请手动补上。` : '')
        + (unconfirmedCount ? `${unconfirmedCount} 项未确认，请核对网页。` : '');
      const emptyHint = viewModeHint();
      if (assisted) {
        report(`辅助填写：已验证 ${filledCount} 项。${unconfirmedCount ? `${unconfirmedCount} 项未确认，请核对网页。` : ""}${response.warning || ""}`, outcome === "partial" ? "error" : "success");
      } else if (emptyHint) {
        hinted = true;
        // 一个都没填上：提示放最后，AI 的提醒和没填上的字段照旧列出。
        // 状态已经说要先点「编辑」了，诊断和留档就不能再写「完成」；已经是部分完成的保持不变。
        if (outcome === "success") outcome = "failed";
        showStatus(`已填写 0 个字段。${unfilledNote}${response.warning || ""}${emptyHint}`, "error", true);
      } else if (response.warning) {
        showStatus(`本地已填写 ${filledCount} 项；${unfilledNote}${response.warning}`, "error", Boolean(unfilledNote));
      } else if (unfilledNote) {
        // 没填上的字段要用户自己去补，提示不自动消失。
        showStatus(`已填写 ${filledCount} 个字段。${unfilledNote}`, "error", true);
      } else {
        showStatus(`已填写 ${filledCount} 个字段。`, "success");
      }

      if (!assisted) {
        const matchedIds = new Set(response.matches.map((match) => match.fieldId));
        // 只有对上了题目的字段才问：占位文字、计数器、跨行借来的文字都不会出现在这里。
        const offerStats = {};
        offerUnansweredFields(fields.flatMap((field) => {
          const entry = fieldMap.get(field.fieldId);
          if (!(entry?.offerable && entry.offerLabel)) return [];
          const control = entry.element || entry.elements?.[0];
          return [{
            label: entry.offerLabel,
            title: entry.binding?.label || "",
            section: entry.binding?.section || "",
            sectionRepeatable: Boolean(entry.binding?.sectionRepeatable),
            inputType: field.inputType,
            matched: matchedIds.has(field.fieldId),
            autocomplete: control?.getAttribute?.("autocomplete") || "",
            entry
          }];
        }), offerStats);
        // 「加到我的信息」没问的字段：只有这里真的挑过一遍，辅助新增和填写失败时不记。
        if (stats) stats.offerSkipped = { ambiguous: stats.ambiguous || 0, entry: offerStats.entry || 0 };
      }
    } catch (error) {
      // Interrupted fills still get a read-only final count; never replay focus,
      // write, or retry after a stop/overwrite refusal.
      recheckVerifiedControls();
      if (stage === "fill") outcome = filledCount > 0 ? "partial" : "failed";
      failedStage = stage;
      failure = error.message || "AI 填写失败。";
      // AI 没匹配上（none / no_context）才补这个提示；认证、网络等失败与页面状态无关。
      if (!hinted && ["none", "no_context"].includes(diagnostics.errorCode)) {
        const hint = viewModeHint();
        failure += hint;
        hinted = Boolean(hint);
      }
      report(failure, "error", hinted);
    } finally {
      if (cancelButton) {
        cancelButton.hidden = true;
        cancelButton.onclick = null;
      }
      if (waitHint) waitHint.hidden = true;
      if (timer !== null) window.clearInterval(timer);
      if (phase) timing[phase] = performance.now() - phaseStart;
      const totalMs = performance.now() - totalStart;
      const verdict = fillVerdict({ scanned: scanDone, fieldCount, pageType: pageType?.type ?? null, frames: probe?.frames ?? null,
        failedStage, responded, errorCode: diagnostics.errorCode, matched, filledCount, unfilledCount: unfilledLabels.length, unconfirmedCount });
      const summaryInput = { ...timing, totalMs,
        fieldCount, filledCount, unfilledCount: unfilledLabels.length, outcome, diagnostics, probe, unfilledControls,
        path: scanPath, pageType, readyAtScan, stats, matched, requested, unconfirmedCount, ...verdict };
      if (session === fillSession) session.summary = summaryInput;
      // 侧栏、手动反馈和自动上报用同一份输入，两个通道的诊断块一致。
      const reportInput = { ...summaryInput, unsyncedCount: session === fillSession ? session.unsynced : 0 };
      writeFillDiagnostics(reportInput);
      // Feedback cannot delay filling, archiving or releasing the busy state.
      try {
        // 不是网申填写页（page_not_supported）不上报：没有可修的东西。
        const kind = self.ResumeProFeedback?.fillFailure({ assisted: Boolean(assisted), cancelled: cancelRequested,
          overwriteDeclined, fieldCount, filledCount, unfilledCount: unfilledLabels.length, unconfirmedCount,
          editHint: hinted && probe?.editButtons > 0, category: verdict.category });
        if (kind) Promise.resolve(chrome.runtime.sendMessage({ type: "FEEDBACK_AUTO", report: {
          kind, diagnostics: self.ResumeProFeedback.fillReport(reportInput)
        } })).catch(() => {});
      } catch { /* feedback is optional; never break the fill lifecycle */ }
      state.aiBusy = false;
      button.disabled = state.desktopMode !== "ready" || !hasResumeData();
      if (repeatButton) repeatButton.disabled = state.desktopMode !== "ready" || !getActiveTemplate(state.currentStore);
      button.textContent = "一键 AI 填写";
      // A page with nothing to fill produced nothing worth archiving.
      if (fieldCount > 0 && (!overwriteDeclined || filledCount > 0)) {
        offerFillRecord({
          outcome, cancelled: cancelRequested, fieldCount, filledCount, unconfirmedCount,
          timing: { scanMs: timing.scanMs, roundTripMs: timing.roundTripMs, fillMs: timing.fillMs, totalMs },
          templateName: activeTemplate?.name,
          endedAt: new Date().toISOString()
        }, activeTemplate).catch(() => {});
      }
    }
    return { outcome, filledCount, unconfirmedCount, error: failure };
  }

  function summarizeLabels(labels, limit = 5) {
    const unique = [...new Set(labels.map((label) => String(label ?? "").trim()).filter(Boolean))];
    const shown = unique.slice(0, limit).join("、");
    return unique.length > limit ? `${shown} 等` : shown;
  }

  // 比较字段名和简历内容前先去掉空白、统一全角半角和大小写。
  function normalizeForOverlap(text) {
    return String(text ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  // 失败类别和第一个失败的阶段由 feedback-core.js 判断；它缺席或出错时退回 unknown，填写不受影响。
  function fillVerdict(input) {
    try {
      const verdict = self.ResumeProFeedback?.fillCategory?.(input);
      if (verdict) return verdict;
    } catch { /* fall through */ }
    return { category: "unknown", stage: input.failedStage || "none" };
  }

  // fill-probe.js 只读页面结构，给诊断和空页面提示用；它缺席或出错都不能影响填写。
  function withFillProbe(use, fallback) {
    try {
      const api = self.ResumeProFillProbe;
      return api ? use(api) ?? fallback : fallback;
    } catch {
      return fallback;
    }
  }

  // #228 扫描诊断：只有数量，没有字段名、网页内容或网址。没跳过的扫描原因见「丢弃原因」。
  function formatScanStats(stats, feedback) {
    if (!stats) return [];
    const sourceLabels = { explicit: "明确关联", item: "表单项", table: "表格", sibling: "相邻文字", placeholder: "仅占位文字" };
    const sources = (() => {
      try { return feedback?.labelSources?.(stats) || []; } catch { return []; }
    })();
    const offer = stats.offerSkipped;
    return [
      ...(sources.length ? [`字段名来源：${sources.map(([key, value]) => `${sourceLabels[key] || key} ${value}`).join("、")}`] : []),
      ...(offer ? [`「加到我的信息」没问：同名找不到区块 ${offer.ambiguous || 0}；经历类区块 ${offer.entry || 0}`] : [])
    ];
  }

  function formatFillDiagnostics(result) {
    // 阶段没跑：未执行；跑了但没拿到数字（例如请求发出去后通道断开）：未取得。
    const missing = result.requested ? "未取得" : "未执行";
    const seconds = (value) => typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : "未执行";
    const count = (value) => Number.isInteger(value) && value >= 0 ? value : missing;
    const d = result.diagnostics;
    const feedback = self.ResumeProFeedback;
    // Explicit allowlist: never copy provider messages, URL, keys or field values.
    const allowedCodes = new Set(["none", "cancelled", "network", "format", "input_too_large", "no_context", "bad_response",
      "not_configured", "credential_unavailable", "auth", "rate_limited", "timeout", "http", "response_too_large",
      "secret_in_prompt", "not_installed", "not_paired", "never_paired", "incompatible", "unavailable",
      "secret_only", "no_resume_fields"]);
    const code = allowedCodes.has(d.errorCode) || /^http_\d{3}$/.test(d.errorCode) ? d.errorCode : missing;
    // 提交校验后网页仍把插件填的框标成无效：不能再算「完成」。
    const unsynced = Number.isInteger(result.unsyncedCount) && result.unsyncedCount > 0 ? result.unsyncedCount : 0;
    const outcome = unsynced && result.outcome === "success" ? "partial" : result.outcome;
    const category = /^[a-z_]{1,32}$/.test(result.category || "") ? result.category : "unknown";
    const stage = ({ scan: "扫描", match: "匹配", fill: "填写", none: "无" })[result.stage] || "无";
    const called = (() => {
      try { return feedback?.aiCalled?.(result) ?? null; } catch { return null; }
    })();
    const drops = (() => {
      try { return feedback?.fillDrops?.(result) || []; } catch { return []; }
    })();
    const dropLabels = { type_hidden: "隐藏输入框", non_fillable: "按钮或文件框", disabled: "禁用", invisible: "不可见",
      popup_internal: "下拉内部输入", grouped: "并入同一控件", page_chrome: "页头导航", site_search: "站内搜索",
      outside_form: "表单外", no_label: "对不上题目", out_of_scope: "不在新增范围", secret: "疑似密码", no_resume_mapping: "无对应资料",
      ai_unmatched: "AI 未匹配", no_result: "没拿到 AI 结果", not_sent: "没送 AI", not_written: "没写上", unconfirmed: "未确认", unsynced: "未同步" };
    const pageType = result.pageType
      ? `${result.pageType.type === "application_form" ? "网申填写页" : "不像网申填写页"}（依据：${({
        url: "网址", title: "标题", edit_button: "「编辑」按钮", structure: "页面结构", none: "无" })[result.pageType.reason] || "无"}）`
      : "未取得";
    const stats = result.stats || {};
    return [
      `网申快填 v${chrome.runtime.getManifest().version}`,
      `结果：${({ success: "完成", partial: "部分完成", failed: "失败" })[outcome] || "未知"}；错误类别：${category}；失败阶段：${stage}`,
      `页面类型：${pageType}；扫描时已加载完：${result.readyAtScan === true ? "是" : result.readyAtScan === false ? "否" : "未取得"}`,
      `输入框：页面共 ${count(stats.domInputs)} → 可见可填 ${count(stats.visible)} → 进入匹配 ${count(result.fieldCount)}`
        + ` → 匹配 ${count(result.matched)} → 填入 ${count(result.filledCount)}`,
      ...(drops.length ? [`丢弃原因：${drops.map(([key, value]) => `${dropLabels[key] || key} ${value}`).join("、")}`] : []),
      ...formatScanStats(result.stats, feedback),
      `网页字段：${count(result.fieldCount)}；成功填写：${count(result.filledCount)}；没填上：${count(result.unfilledCount)}；未确认：${count(result.unconfirmedCount)}`,
      ...(unsynced ? [`页面表单状态未同步：${unsynced}（提交校验后网页仍标为无效，请手动点击这些字段确认）`] : []),
      `本地匹配：${count(d.ruleMatches)}；AI 匹配：${count(d.aiMatches)}`,
      `送 AI 字段：${count(d.aiFields)}；AI：${called === true ? "已调用" : called === false ? "未调用" : "未取得"}；错误码：${code}`,
      `候选 / 简历字段：${count(d.candidateFields)} / ${count(d.resumeFields)}`,
      `敏感字段过滤：${count(d.skippedSecret)}；超大资料跳过：${count(d.skippedOversized)}；无对应资料跳过：${count(d.skippedNoContext)}`,
      `用户 prompt：${count(d.promptBytes)} bytes`,
      `扫描：${seconds(result.scanMs)}`,
      `匹配往返（含后台处理）：${seconds(result.roundTripMs)}`,
      `API（含响应读取）：${called === true ? seconds(d.apiMs) : called === false ? "未调用" : "未取得"}`,
      `填写：${seconds(result.fillMs)}；总计：${seconds(result.totalMs)}`,
      ...withFillProbe(api => api.formatReport(result.probe || null, result.unfilledControls || []), [])
    ].join("\n");
  }

  // #228：扫描交给 field-scan.js。只收能对上题目的逻辑控件：自定义下拉连同内部输入算一个，
  // 页头搜索、下拉弹层里的搜索框、对不上题目的控件都跳过，只在诊断里记数量。
  function scanFillableFields() {
    const scan = self.ResumeProFieldScan.scanPage(document, {
      isVisible,
      exclude: (element) => Boolean(element.closest(`#${SIDEBAR_ID}`))
    });
    const fieldMap = new Map();
    const fields = [];

    scan.controls.forEach((control) => {
      const element = control.element;
      // 扫描时的对应关系原样留着，填写和「加到我的信息」用之前拿它复查。
      const binding = control;
      const controlKind = control.controlKind === 'select' ? 'native-select'
        : control.controlKind === 'date-picker' ? 'date' : control.controlKind;
      const common = { controlKind, root: control.root, binding,
        offerable: control.offerable, offerLabel: control.offerLabel };
      const base = {
        controlKind,
        label: control.label,
        placeholder: control.placeholder,
        ariaLabel: element.getAttribute("aria-label") || "",
        group: control.group
      };

      if (control.kind === "radio") {
        const fieldId = `field-radio-${fields.length}`;
        fieldMap.set(fieldId, { kind: "radio", elements: control.elements, ...common });
        fields.push({
          fieldId, ...base, placeholder: "", name: element.name || "", idAttr: "",
          tagName: "input", inputType: "radio",
          options: control.elements.map((radio) => getRadioOptionLabel(radio)).filter(Boolean)
        });
        return;
      }

      const fieldId = `field-${fields.length}`;
      if (control.controlKind === "date-picker") {
        const pickerType = control.pickerType || "generic";
        const pickerInputType = inferPickerInputType(control.root, element);
        fieldMap.set(fieldId, { kind: "element", element, pickerType, pickerInputType, ...common });
        fields.push({
          fieldId, ...base, name: element.getAttribute("name") || "", idAttr: element.id || "",
          tagName: "input", inputType: "date-picker", pickerType, pickerInputType, options: []
        });
        return;
      }

      fieldMap.set(fieldId, { kind: "element", element, ...common });
      fields.push({
        fieldId, ...base,
        dynamicOptions: ["custom-select", "cascader"].includes(control.controlKind),
        name: element.getAttribute("name") || "",
        idAttr: element.id || "",
        tagName: element.tagName.toLowerCase(),
        inputType: ["custom-select", "cascader"].includes(control.controlKind) ? "select"
          : element instanceof HTMLInputElement ? element.type || "text" : element.tagName.toLowerCase(),
        options: element instanceof HTMLSelectElement
          ? Array.from(element.options).map((option) => option.text.trim()).filter(Boolean)
          : []
      });
    });

    // 级联判断 (Cascade Detection)
    if (self.ResumeProAIHelpers?.detectCascadeGroups) {
      self.ResumeProAIHelpers.detectCascadeGroups(fields, fieldMap);
    }

    return { fields, fieldMap, stats: scanStats(scan, fields.length) };
  }

  // 诊断漏斗（#215 / #228）：页面上全部输入框按「为什么没进入匹配」分开数。只数数，不读值。
  // 隐藏、按钮或文件框、禁用、看不见按 DOM 数；看得见的再按 field-scan.js 的跳过原因分，
  // 剩下没单列的是并进同一个控件的输入框（一组单选、自定义下拉里的几个输入框算一个）。
  function scanStats(scan, fields) {
    const all = Array.from(document.querySelectorAll("input, select, textarea")).filter((element) => !element.closest?.(`#${SIDEBAR_ID}`));
    let typeHidden = 0;
    let nonFillable = 0;
    let disabled = 0;
    let visible = 0;
    for (const element of all) {
      const type = element instanceof HTMLInputElement ? String(element.type || "").toLowerCase() : "";
      if (type === "hidden") typeHidden += 1;
      else if (["file", "button", "submit", "reset", "image"].includes(type)) nonFillable += 1;
      else if (element.disabled) disabled += 1;
      else if (isVisible(element)) visible += 1;
    }
    const count = (value) => Number.isInteger(value) && value > 0 ? value : 0;
    const skipped = scan?.skipped || {};
    const listed = { popup: count(skipped.popup), pageChrome: count(skipped.pageChrome), siteSearch: count(skipped.siteSearch),
      outsideForm: count(skipped.outsideForm), noLabel: count(skipped.noLabel) };
    const listedTotal = Object.values(listed).reduce((total, value) => total + value, 0);
    return { domInputs: all.length, visible, typeHidden, nonFillable, disabled,
      invisible: all.length - typeHidden - nonFillable - disabled - visible, ...listed,
      grouped: Math.max(0, visible - fields - listedTotal),
      sources: scan?.sources || {}, ambiguous: count(skipped.ambiguous) };
  }

  // 题目和控件的对应关系还成立吗：控件还在原来的表单项里、表单项没混进别的控件、题目没变。
  function isFieldBindingCurrent(entry) {
    if (!entry?.binding) return true;
    try {
      return self.ResumeProFieldScan.isBindingCurrent(entry.binding, document, { isVisible });
    } catch {
      return false;
    }
  }

  function getFieldLabel(element) {
    return self.ResumeProFieldScan?.labelForElement(element, {
      isVisible,
      exclude: (candidate) => Boolean(candidate.closest(`#${SIDEBAR_ID}`))
    }) || "";
  }

  // 目标、光标或内容变了，就让在线的侧栏重新问一次状态。消息里不带任何数据。
  function notifyPanelTargetChanged() {
    if (Date.now() - panelQueriedAt >= PANEL_ONLINE_MS || panelNotifyTimer) return;
    panelNotifyTimer = window.setTimeout(() => {
      panelNotifyTimer = null;
      try {
        Promise.resolve(chrome.runtime.sendMessage({ type: "RESUME_TARGET_CHANGED" })).catch(() => {});
      } catch {
        // The panel closed between the query and now.
      }
    }, 60);
  }

  function bindFocusTracking() {
    const trackedTarget = (event) => {
      const candidate = event.target instanceof HTMLElement && isFillTarget(event.target)
        ? event.target : document.activeElement;
      return candidate instanceof HTMLElement && isFillTarget(candidate) && !candidate.closest?.(`#${SIDEBAR_ID}`)
        ? candidate : null;
    };
    document.addEventListener("focusin", (event) => {
      // 提交前同步会短暂聚焦已填字段，不能把它们当成用户最后点过的字段。
      if (submitSyncBusy) {
        return;
      }
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest(`#${SIDEBAR_ID}`)) {
        return;
      }

      if (isFillTarget(target)) {
        state.lastFocusedField = target;
        closeChipActionMenu();
        rememberTextSelection(target);
        syncChipSelectionState();
        notifyPanelTargetChanged();
      }
    }, true);
    // 失焦前最后记一次：点侧栏之后，contenteditable 的选区可能已经不在了。
    document.addEventListener("focusout", (event) => {
      const target = trackedTarget(event);
      if (target) rememberTextSelection(target);
    }, true);
    const trackCaret = (event) => {
      const target = trackedTarget(event);
      if (!target) return;
      rememberTextSelection(target);
      if (target === state.lastFocusedField) notifyPanelTargetChanged();
    };
    document.addEventListener("selectionchange", trackCaret, true);
    document.addEventListener("keyup", trackCaret, true);
    document.addEventListener("mouseup", trackCaret, true);
    document.addEventListener("input", (event) => {
      // 用户手动改过、或页面自己改过：按值重新推断，不再沿用之前记的字段身份。
      // 我们自己写入时不清，写完由 applyChipValue 收尾。
      if (event.target && !chipWriteTargets.has(event.target)) {
        chipSelectionIdsByTarget.delete(event.target);
      }
      if (event.target === state.lastFocusedField) {
        closeChipActionMenu();
        rememberTextSelection(event.target);
        syncChipSelectionState();
        notifyPanelTargetChanged();
      }
    }, true);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "readonly");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const success = document.execCommand("copy");
      helper.remove();
      return success;
    }
  }

  function getLastFocusedFillTarget() {
    const candidates = [state.lastFocusedField, document.activeElement];

    for (const candidate of candidates) {
      if (candidate instanceof HTMLElement && isFillTarget(candidate) && document.contains(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  function hasRealSelectOptions(select) {
    const isPlaceholder = self.ResumeProAIHelpers?.isPlaceholderOption;
    return Array.from(select.options || []).some((option) => String(option.text ?? "").trim()
      && !(isPlaceholder && isPlaceholder({ value: option.value, text: option.text, disabled: option.disabled })));
  }

  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) {
      return true;
    }
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    const type = String(element.type || "text").toLowerCase();
    return !["checkbox", "radio", "file", "button", "submit", "reset", "image", "hidden", "range", "color", "date", "month", "datetime-local", "time", "week"].includes(type);
  }

  function prefersSequentialInput(element) {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    const type = String(element.type || "").toLowerCase();
    if (type === "tel" || type === "email" || type === "number") {
      return true;
    }
    const hint = `${element.name || ""} ${element.id || ""} ${element.getAttribute?.("autocomplete") || ""} ${element.getAttribute?.("inputmode") || ""}`.toLowerCase();
    return /tel|phone|mobile|email|e-mail|idcard|id-card|identity|shenfen|身份证/.test(hint);
  }

  function writeControlValue(element, value) {
    const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchTextInput(element, data) {
    const text = String(data ?? "");
    try {
      if (typeof InputEvent === "function") {
        element.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text
        }));
        return;
      }
    } catch (_) {
      // 旧环境构造 InputEvent 会抛，退回普通 Event。
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function focusControl(element) {
    try {
      if (typeof element.focus === "function") {
        try {
          element.focus({ preventScroll: true });
        } catch (_) {
          element.focus();
        }
        return;
      }
    } catch (_) {
      // focus() 不可用时下面补一个事件。
    }
    try {
      element.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
    } catch (_) {
      // 没有 FocusEvent 时不再额外发事件。
    }
  }

  function blurControl(element) {
    try {
      if (typeof element.blur === "function") {
        element.blur();
        return;
      }
    } catch (_) {
      // blur() 不可用时下面补一个事件。
    }
    try {
      element.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    } catch (_) {
      // 没有 FocusEvent 时不再额外发事件。
    }
  }

  function nextTask() {
    if (textCommitWaitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  // 先让 focus 引起的页面更新结束，再写值并通知输入事件。
  // 如果先写值，受控表单可能在 focus 后按旧状态重绘，把值清空。
  async function runTextLifecycle(element, value, sequential, beforeWrite, didWrite) {
    focusControl(element);
    await nextTask();
    if (beforeWrite && !beforeWrite()) return false;
    if (!sequential) {
      writeControlValue(element, value);
      didWrite?.();
      dispatchTextInput(element, value);
    } else {
      writeControlValue(element, "");
      didWrite?.();
      dispatchTextInput(element, "");
      let built = "";
      for (const char of Array.from(value)) {
        built += char;
        writeControlValue(element, built);
        dispatchTextInput(element, char);
      }
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTask();
    if (beforeWrite && !beforeWrite()) return false;
    blurControl(element);
    return true;
  }

  // 用户不用改字，点一下输入框再点空白，提示就会消失。校验还在时照这个再做一次。
  async function replayFocusBlur(element) {
    focusControl(element);
    await nextTask();
    blurControl(element);
  }

  // ---- #173 提交前同步 ----
  // 有的网站要等用户第一次点「预览 / 下一步 / 提交」才开始整表校验，那时它内部还没接受插件填的文本，
  // 于是把已经显示着内容的框标红。用户点一下输入框再点空白就好，说明缺的只是一次 focus → blur。
  // 这里记住本次填写成功的文本框，在用户真正点按钮、网站自己的点击处理之前补上这一次。
  // 只做 focus → blur：不写值、不点按钮、不提交、不拦截事件。
  const SYNC_INPUT_TYPES = new Set(["text", "tel", "email"]);
  const CAPTCHA_HINT = /captcha|验证码|校验码|图形码|短信码|verif(?:y|ication)[-_ ]?code|one-time-code|(?:^|[^a-z0-9])otp(?:[^a-z0-9]|$)/i;
  const PASSWORD_HINT = /password|passwd|(?:^|[^a-z0-9])pwd(?:[^a-z0-9]|$)|密码/i;
  const SUBMIT_TEXT_PATTERN = /预览|下一步|下一页|提交|保存并(?:继续|下一步)|^(?:submit|next|continue|preview|save\s*(?:and|&)\s*(?:continue|next)|(?:review|preview)\s*(?:and|&)\s*submit)\b/i;
  const NON_SUBMIT_TEXT_PATTERN = /关闭|删除|取消|返回|上一步|上一页|清空|重置|移除|添加|新增|上传|^(?:close|delete|remove|cancel|back|previous|prev|reset|clear|add|upload)\b/i;

  function controlHintText(element) {
    const parts = [
      element.name,
      element.id,
      element.getAttribute?.("autocomplete"),
      element.getAttribute?.("placeholder"),
      element.getAttribute?.("aria-label")
    ];
    try {
      for (const label of Array.from(element.labels || [])) parts.push(label?.textContent);
    } catch (_) {
      // A custom control may expose a non-standard labels getter. Its other hints still apply.
    }
    const labelledBy = String(element.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    for (const id of labelledBy) parts.push(document.getElementById?.(id)?.textContent);
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  // 只有 text / tel / email / textarea 会被记录；密码、验证码、下拉、日期、文件、单选、复选都不碰。
  function isSyncableTextControl(element) {
    const textarea = element instanceof HTMLTextAreaElement;
    const input = element instanceof HTMLInputElement;
    if (!textarea && !input) return false;
    if (input && !SYNC_INPUT_TYPES.has(String(element.type || "text").toLowerCase())) return false;
    const hint = controlHintText(element);
    return !CAPTCHA_HINT.test(hint) && !PASSWORD_HINT.test(hint);
  }

  function buttonLabelText(element) {
    const parts = [
      String(element.tagName || "").toUpperCase() === "INPUT" ? element.value : "",
      element.textContent,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title")
    ];
    const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    // 一大段文字不是按钮文案。
    return text.length > 40 ? "" : text;
  }

  function isButtonLike(element) {
    const tag = String(element?.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "A") {
      return true;
    }
    if (tag === "INPUT") {
      return ["submit", "button", "image"].includes(String(element.getAttribute?.("type") ?? element.type ?? "").toLowerCase());
    }
    return element?.getAttribute?.("role") === "button";
  }

  function ownerForm(element) {
    if (element?.form) {
      return element.form;
    }
    let node = element?.parentElement;
    while (node) {
      if (String(node.tagName || "").toUpperCase() === "FORM") {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function belongsToForm(element, form) {
    return element.form === form || (typeof form.contains === "function" && form.contains(element));
  }

  // 这个按钮是不是「预览 / 下一步 / 提交」一类会触发整表校验的按钮。
  function isSubmitTrigger(element) {
    if (!isButtonLike(element)) {
      return false;
    }
    if (element.disabled === true || element.getAttribute?.("aria-disabled") === "true") {
      return false;
    }
    const text = buttonLabelText(element);
    if (NON_SUBMIT_TEXT_PATTERN.test(text)) {
      return false;
    }
    const tag = String(element.tagName || "").toUpperCase();
    const type = String(element.getAttribute?.("type") ?? "").toLowerCase();
    if (tag === "INPUT" && (type === "submit" || type === "image")) {
      return true;
    }
    if (tag === "BUTTON") {
      if (type === "submit" || (!type && ownerForm(element))) {
        return true;
      }
    }
    return SUBMIT_TEXT_PATTERN.test(text);
  }

  // 从点击落点往上找最近的按钮：最近的按钮就是用户点的那个，它不是提交类就不处理，不再往外层找。
  function findSubmitTrigger(target) {
    let node = target;
    while (node) {
      if (isButtonLike(node)) {
        return isSubmitTrigger(node) ? node : null;
      }
      node = node.parentElement;
    }
    return null;
  }

  // composedPath crosses a shadow boundary while parentElement does not. The first button-like
  // node in the path is what the user actually activated; an ordinary inner button must not be
  // skipped in favour of a submit-looking outer host.
  function findSubmitTriggerInPath(path, target) {
    for (const node of path || []) {
      if (node?.id === SIDEBAR_ID) return null;
      if (isButtonLike(node)) return isSubmitTrigger(node) ? node : null;
    }
    return findSubmitTrigger(target);
  }

  function deepActiveElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active || null;
  }

  function isEditableElement(element) {
    if (!element) {
      return false;
    }
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return true;
    }
    if (element instanceof HTMLInputElement) {
      return !["button", "submit", "reset", "image", "checkbox", "radio", "file"].includes(String(element.type || "text").toLowerCase());
    }
    return element.isContentEditable === true;
  }

  function beginFillSession() {
    endFillSession();
    fillSession = { controls: new Map(), unsyncedControls: new Set(), checkTimer: null, unsynced: 0, summary: null };
    bindSubmitSync();
    return fillSession;
  }

  function endFillSession() {
    if (fillSession && fillSession.checkTimer !== null) {
      window.clearTimeout(fillSession.checkTimer);
    }
    fillSession = null;
    submitGesture = null;
  }

  function recordFilledTextControl(session, element) {
    if (!session || session !== fillSession || !isSyncableTextControl(element)) {
      return false;
    }
    session.controls.set(element, String(element.value ?? ""));
    return true;
  }

  // 还能安全同步的字段：已断开的丢掉；空的、禁用的、只读的跳过；给了表单就只取这张表单里的。
  function syncableControls(session, form) {
    const list = [];
    for (const element of Array.from(session.controls.keys())) {
      if (element.isConnected === false) {
        session.controls.delete(element);
        continue;
      }
      if (!isSyncableTextControl(element) || element.disabled || element.readOnly) {
        continue;
      }
      if (!String(element.value ?? "").trim()) {
        continue;
      }
      if (form && !belongsToForm(element, form)) {
        continue;
      }
      list.push(element);
    }
    return list;
  }

  // 全程同步、没有 await / 定时器：必须赶在网站自己的点击处理之前做完。
  function focusBlurNow(controls) {
    if (!controls.length || submitSyncBusy) {
      return;
    }
    const previous = deepActiveElement();
    submitSyncBusy = true;
    try {
      for (const control of controls) {
        focusControl(control);
        blurControl(control);
      }
    } finally {
      submitSyncBusy = false;
    }
    // 把焦点还给原来的元素：空格键靠按钮保持焦点才会在松开时触发点击。
    if (previous && previous !== document.body && previous !== document.documentElement
      && previous.isConnected !== false && deepActiveElement() !== previous) {
      focusControl(previous);
    }
  }

  // 全部填完、页面稳定后补一次。用户正在别的输入框里操作就不抢焦点，提交前同步还在。
  async function finalSyncFillSession(session) {
    try {
      if (!session || session !== fillSession || !session.controls.size) {
        return;
      }
      await waitForTextCommit();
      if (session !== fillSession || isEditableElement(deepActiveElement())) {
        return;
      }
      focusBlurNow(syncableControls(session, null));
    } catch (_) {
      // 最终同步只是加固，出错不能影响填写结果。
    }
  }

  function writeFillDiagnostics(input) {
    try {
      lastFillReport = self.ResumeProFeedback?.fillReport?.(input) || "";
    } catch {
      lastFillReport = "";
    }
    const panel = shadowRoot?.querySelector("#resume-pro-diagnostics");
    const text = shadowRoot?.querySelector("#resume-pro-diagnostics-text");
    if (panel && text) {
      text.value = formatFillDiagnostics(input);
      panel.hidden = false;
      panel.open = true;
    }
  }

  // 网站校验之后，看看插件填的、用户没改过的框是不是还被标成无效。
  // 未同步的字段记在会话的集合里，一次检查只更新它检查的那一部分：
  // 检查表单 B 不能抹掉表单 A 里仍未同步的记录。
  // 用户改过的字段、真正为空的字段，网站标红是真实错误，不算在内。
  function checkUnsyncedControls(session, form) {
    const flagged = session.unsyncedControls;
    const before = flagged.size;
    const release = (element) => {
      flagged.delete(element);
      if (textFillFailures.get(element) === "framework_state_unsynced") textFillFailures.delete(element);
    };
    const inScope = new Set(syncableControls(session, form));
    // 已移除的字段随时清掉；本范围内不再可检查（清空、禁用、只读）的也清掉；别的表单里的保留。
    for (const element of Array.from(flagged)) {
      if (!session.controls.has(element) || element.isConnected === false
        || (!inScope.has(element) && (!form || belongsToForm(element, form)))) {
        release(element);
      }
    }
    for (const element of inScope) {
      const current = String(element.value ?? "");
      // 用户改过的值，网站标红是真实错误。
      if (current !== session.controls.get(element)) {
        release(element);
        continue;
      }
      // Native type/required/pattern errors are real content errors, not a framework state
      // that another focus/blur can repair. Reading validity has no submission side effect.
      if (element.validity?.valid === false) {
        release(element);
        continue;
      }
      const result = inspectTextCommit(element, current, true);
      if (!result.ok && (result.reason === "validation_not_cleared" || result.reason === "framework_state_unsynced")) {
        flagged.add(element);
        textFillFailures.set(element, "framework_state_unsynced");
      } else {
        release(element);
      }
    }
    session.unsynced = flagged.size;
    if (flagged.size) {
      showStatus("页面仍认为部分内容无效，请检查内容或手动点击字段确认", "error", true);
    } else if (before > 0) {
      showStatus("页面表单状态已同步。", "success");
    }
    if (before !== flagged.size && session.summary) {
      writeFillDiagnostics({ ...session.summary, unsyncedCount: session.unsynced });
    }
  }

  // 一个会话只留一个检查定时器：连续点击只会顺延，不会越积越多。
  function scheduleUnsyncedCheck(session, form) {
    if (session.checkTimer !== null) {
      window.clearTimeout(session.checkTimer);
    }
    session.checkTimer = window.setTimeout(() => {
      session.checkTimer = null;
      if (session !== fillSession) {
        return;
      }
      try {
        checkUnsyncedControls(session, form);
      } catch (_) {
        // 检查失败不影响网页。
      }
    }, submitCheckDelayMs);
  }

  function syncBeforeSubmit(session, trigger) {
    const form = ownerForm(trigger);
    const controls = syncableControls(session, form);
    // 没有可同步的字段时，如果还有旧的未同步记录，也要检查一次，好把已清空 / 已禁用的字段清掉。
    if (!controls.length && !session.unsyncedControls.size) {
      return;
    }
    focusBlurNow(controls);
    scheduleUnsyncedCheck(session, form);
  }

  // 只接住捕获阶段用户真实的鼠标 / 键盘操作：不 preventDefault、不 stopPropagation、不替用户点。
  // pointerdown / keydown 在网站的 click 处理之前，是主要同步点；随后的 click 只认领已同步过的那次，
  // 没有前置手势的 click（例如回车触发的隐式提交）才自己同步一次。
  function handleSubmitGesture(event) {
    try {
      const session = fillSession;
      if (!session || !event || event.isTrusted !== true || submitSyncBusy) {
        return;
      }
      if (event.type === "pointerdown" && event.button !== 0) {
        return;
      }
      if (event.type === "keydown") {
        const activation = event.key === "Enter" || event.key === " " || event.key === "Spacebar";
        if (!activation || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
          return;
        }
      }
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const target = path[0] || event.target;
      if (!target || path.some((node) => node?.id === SIDEBAR_ID)) {
        return;
      }
      const trigger = findSubmitTriggerInPath(path, target);
      if (!trigger) {
        return;
      }
      const now = Date.now();
      if (event.type === "click") {
        const gesture = submitGesture;
        submitGesture = null;
        if (gesture && gesture.trigger === trigger && now - gesture.at < SUBMIT_GESTURE_DEDUPE_MS) {
          return;
        }
      } else {
        submitGesture = { trigger, at: now };
      }
      syncBeforeSubmit(session, trigger);
    } catch (_) {
      // 同步只是辅助，任何异常都不能挡住网站自己的点击。
    }
  }

  // 监听器只注册一次，之后每次新会话复用。
  function bindSubmitSync() {
    if (submitSyncBound) {
      return;
    }
    submitSyncBound = true;
    for (const type of ["pointerdown", "keydown", "click"]) {
      document.addEventListener(type, handleSubmitGesture, true);
    }
    if (typeof window.addEventListener === "function") {
      window.addEventListener("pagehide", endFillSession);
    }
  }

  function classText(node) {
    if (!node) {
      return "";
    }
    if (typeof node.className === "string") {
      return node.className;
    }
    if (node.classList && typeof node.classList.values === "function") {
      return Array.from(node.classList.values()).join(" ");
    }
    return "";
  }

  function isShown(node) {
    let current = node;
    while (current && current !== document) {
      if (current.hidden) {
        return false;
      }
      const hidden = current.getAttribute?.("hidden");
      if (hidden != null && hidden !== "false") {
        return false;
      }
      if (current.getAttribute?.("aria-hidden") === "true") {
        return false;
      }
      if (typeof window.getComputedStyle === "function" && current instanceof HTMLElement) {
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
          return false;
        }
      }
      current = current.parentElement;
    }
    return true;
  }

  function looksLikeFieldError(node) {
    if (!node || node === document.body) {
      return false;
    }
    if (node.getAttribute?.("role") === "alert") {
      return true;
    }
    const className = classText(node);
    return /(?:^|[\s_])(?:error|has-error|is-error|is-invalid|invalid-feedback|field-error|form-error)(?:$|[\s_])/i.test(className)
      || /el-form-item__error|ant-form-item-explain-error|ant-form-item-has-error|Validform_wrong/.test(className);
  }

  function listOtherControls(root, skip) {
    const found = [];
    const stack = [...(root?.children || [])];
    while (stack.length) {
      const node = stack.shift();
      if (node !== skip && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) {
        found.push(node);
      }
      if (node?.children?.length) {
        stack.push(...node.children);
      }
    }
    return found;
  }

  function associatedContainer(element) {
    let current = element.parentElement;
    let best = current;
    while (current && current !== document.body && current !== document.documentElement) {
      if (listOtherControls(current, element).length > 0) {
        return best;
      }
      best = current;
      if (/form-item|form-group|form-field|el-form-item|ant-form-item/i.test(classText(current))) {
        return current;
      }
      current = current.parentElement;
    }
    // 没有其他控件作边界时，不要把整张表单的错误算到唯一输入框上。
    return element.parentElement;
  }

  function describedErrorVisible(element) {
    const ids = `${element.getAttribute?.("aria-describedby") || ""} ${element.getAttribute?.("aria-errormessage") || ""}`
      .split(/\s+/)
      .filter(Boolean);
    return ids.some((id) => {
      const node = document.getElementById?.(id);
      return node && node !== element && isShown(node) && String(node.textContent || "").trim()
        && (looksLikeFieldError(node) || node.getAttribute?.("role") === "alert");
    });
  }

  function containerErrorVisible(element) {
    const container = associatedContainer(element);
    if (!container) {
      return false;
    }
    const stack = [...(container.children || [])];
    while (stack.length) {
      const node = stack.shift();
      if (node === element) {
        continue;
      }
      if (looksLikeFieldError(node) && isShown(node) && String(node.textContent || "").trim()) {
        return true;
      }
      if (node?.children?.length) {
        stack.push(...node.children);
      }
    }
    return false;
  }

  function containerFrameworkUnsynced(element) {
    const container = associatedContainer(element);
    return /ant-form-item-has-error|(?:^|\s)has-error(?:\s|$)|is-error|is-invalid|Validform_wrong/.test(classText(container));
  }

  function inspectTextCommit(element, expected, committedBeforeWait) {
    if (element.isConnected === false) {
      return { ok: false, reason: "element_disconnected" };
    }
    const current = String(element.value ?? "");
    if (current !== expected) {
      return { ok: false, reason: committedBeforeWait ? "value_reverted" : "value_not_committed" };
    }
    if (element.getAttribute?.("aria-invalid") === "true" || describedErrorVisible(element) || containerErrorVisible(element)) {
      return { ok: false, reason: "validation_not_cleared" };
    }
    if (containerFrameworkUnsynced(element)) {
      return { ok: false, reason: "framework_state_unsynced" };
    }
    return { ok: true, reason: "" };
  }

  function waitForTextCommit() {
    if (textCommitWaitMs <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => window.setTimeout(resolve, textCommitWaitMs));
  }

  function textFillFailureCode(element) {
    const control = element?.kind === "element" ? element.element : element;
    return (control && textFillFailures.get(control)) || "";
  }

  function textFillFailureLabel(element) {
    return TEXT_FILL_FAILURE_LABELS[textFillFailureCode(element)] || "";
  }

  function normalizeExpectedTextValue(element, value) {
    const text = String(value ?? "");
    if (element instanceof HTMLTextAreaElement) {
      return text.replace(/\r\n?/g, "\n");
    }
    if (!(element instanceof HTMLInputElement)) {
      return text;
    }
    const type = String(element.type || "text").toLowerCase();
    if (type === "email" || type === "url") {
      return text.replace(/[\r\n]/g, "").replace(/^[\t\f ]+|[\t\f ]+$/g, "");
    }
    if (["text", "search", "tel", "password"].includes(type)) {
      return text.replace(/[\r\n]/g, "");
    }
    // 数字等类型的无效值会被浏览器拒绝，不能把清空后的值当成成功。
    return text;
  }

  let controlOperator;
  function operateControl(target, value, options = {}) {
    if (!controlOperator) controlOperator = self.ResumeProControls.create({
      helpers: self.ResumeProAIHelpers, radioLabel: getRadioOptionLabel,
      isVisible, writeValue: writeControlValue, focus: focusControl, blur: blurControl,
      normalizeText: normalizeExpectedTextValue, runTextLifecycle,
      inspectText: inspectTextCommit, waitTextCommit: waitForTextCommit,
      replayFocusBlur, prefersSequential: prefersSequentialInput, dispatchTextInput,
      getSettleMs: () => textCommitWaitMs <= 0 ? 0 : 250
    });
    // #230's scanner uses date-picker; the #219 operation contract uses date.
    const entry = target?.controlKind === 'date-picker' ? { ...target, controlKind: 'date' } : target;
    return controlOperator.operate(entry, value, options);
  }

  async function setElementValue(target, value, beforeWrite, isCurrent, onWrite) {
    const result = await operateControl(target, value, { hints: target?.hints, beforeWrite, isCurrent, onWrite });
    const control = target?.kind === 'element' ? target.element : target;
    if (control && typeof control === 'object') {
      if (result.ok) textFillFailures.delete(control);
      else textFillFailures.set(control, result.reason);
    }
    return result.ok;
  }

  function highlightFilledField(fieldEntry, value) {
    getHighlightTargets(fieldEntry, value).forEach((target) => {
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (!isInViewport(target)) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        queueFieldHighlightWhenVisible(target);
        return;
      }

      applyFieldHighlight(target);
    });
  }

  function queueFieldHighlightWhenVisible(target, attempt = 0) {
    clearFieldHighlightTimer(target);
    const timer = window.setTimeout(() => {
      if (isInViewport(target) || attempt >= 18) {
        applyFieldHighlight(target);
        return;
      }

      queueFieldHighlightWhenVisible(target, attempt + 1);
    }, 100);
    fieldHighlightTimers.set(target, timer);
  }

  function applyFieldHighlight(target) {
    clearFieldHighlightTimer(target);
    target.classList.remove(FIELD_HIGHLIGHT_CLASS);
    void target.offsetWidth;
    target.classList.add(FIELD_HIGHLIGHT_CLASS);

    const timer = window.setTimeout(() => {
      target.classList.remove(FIELD_HIGHLIGHT_CLASS);
      fieldHighlightTimers.delete(target);
    }, 2800);
    fieldHighlightTimers.set(target, timer);
  }

  function clearFieldHighlightTimer(target) {
    if (!fieldHighlightTimers.has(target)) {
      return;
    }

    window.clearTimeout(fieldHighlightTimers.get(target));
    fieldHighlightTimers.delete(target);
  }

  function getHighlightTargets(fieldEntry, value) {
    if (fieldEntry?.kind === "radio") {
      const trimmedValue = String(value || "").trim();
      const matchedRadio = fieldEntry.elements.find((radio) => {
        const optionText = getRadioOptionLabel(radio);
        return optionText === trimmedValue || radio.value === trimmedValue;
      });

      if (!matchedRadio) {
        return [];
      }

      return [matchedRadio.labels?.[0] || matchedRadio.closest("label") || matchedRadio];
    }

    const element = fieldEntry?.kind === "element" ? fieldEntry.element : fieldEntry;

    if (!(element instanceof HTMLElement)) {
      return [];
    }

    if (fieldEntry?.pickerType) {
      return [element.closest(".ant-picker, .el-date-editor, [class*='date-picker']") || element];
    }

    return [element];
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0
      && rect.left >= 0
      && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight)
      && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
  }

  function injectFieldHighlightStyles() {
    if (document.getElementById(FIELD_HIGHLIGHT_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = FIELD_HIGHLIGHT_STYLE_ID;
    style.textContent = FIELD_HIGHLIGHT_STYLE_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  function profileResumeFields() {
    return self.ResumeProProfile?.profileToResumeFields(state.currentStore?.profile) || [];
  }

  function buildProfileChipsHtml(profileFields) {
    const groups = new Map();

    profileFields.forEach((field) => {
      if (!groups.has(field.group)) groups.set(field.group, []);
      groups.get(field.group).push(field);
    });

    return Array.from(groups, ([name, groupFields]) => `
      <section class="resume-pro__group">
        <div class="resume-pro__group-name">我的信息 · ${escapeHtml(name)}</div>
        <div class="resume-pro__chips">
          ${groupFields.map((field) => `
            <button
              class="resume-pro__chip"
              type="button"
              data-chip-id="${escapeHtml(`profile:${name}:${field.key}`)}"
              data-value="${escapeHtml(field.value)}"
              title="${escapeHtml(field.value)}"
            >
              ${escapeHtml(field.key)}
            </button>
          `).join("")}
        </div>
      </section>
    `).join("");
  }

  // 填完之后，网页上没匹配上的字段（已填的和空着的）和它们此刻的内容，列给用户勾选后存进桌面「我的信息」（#189）。
  // 档案只在桌面：这里不留副本，每次都按网页当前的值和桌面最新的档案重新算。
  function offerUnansweredFields(candidates, stats = null) {
    const api = self.ResumeProProfile;
    if (!api) return;

    state.profileOfferCandidates = candidates;
    state.profileOfferResult = null;
    state.profileResultCandidateSignature = "";
    state.profileDismissedCandidateSignature = null;
    state.profileOfferVersion += 1;
    const plan = currentProfilePlan(state.currentStore, stats);

    if (!api.planHasOffer(plan)) {
      closeProfileOffer();
      return;
    }
    syncProfileOfferCard(plan);
  }

  function closeProfileOffer() {
    const card = shadowRoot?.querySelector("#resume-pro-profile-offer");
    if (card) card.hidden = true;
    state.profileOfferCandidates = [];
    state.profileOfferResult = null;
    state.profileResultCandidateSignature = "";
    state.profileDismissedCandidateSignature = null;
  }

  // 「完成」收起整张卡；保留候选以便网页上补出新答案时重新出现。
  function dismissProfileResult() {
    const result = state.profileOfferResult;
    state.profileOfferResult = null;
    state.profileResultCandidateSignature = "";
    // 部分保存后仍有可处理的候选时，直接把更新后的内容交还给用户复核。
    state.profileDismissedCandidateSignature = result?.kind === "partial" ? null
      : profileCandidateSignature(currentProfilePlan());
  }

  function syncProfileOfferCard(plan) {
    const api = self.ResumeProProfile;
    const card = shadowRoot?.querySelector("#resume-pro-profile-offer");
    if (!card) return;
    const offered = api.planHasOffer(plan);
    card.hidden = !offered;
    const note = card.querySelector?.("#resume-pro-profile-offer-text");
    if (offered && note) note.textContent = api.profileOfferSummary(plan);
  }

  const PROFILE_UNREADABLE_TYPES = new Set(["password", "file", "hidden", "checkbox"]);

  function cleanProfileText(value, multiline) {
    const raw = String(value ?? "").replace(/\r\n?/g, "\n").trim();
    return multiline ? raw : raw.replace(/\s+/g, " ");
  }

  // 读出用户眼前看到的值：文本原样、下拉和单选是选项文字（不是内部 code）。
  // stale = 控件没了或和题目的对应关系变了；unreadable = 有内容但读不准，不猜。
  function readProfileEntry(entry) {
    const stale = { state: "stale", value: "" };
    const unreadable = { state: "unreadable", value: "" };
    const ready = (value) => ({ state: "ready", value });
    const controls = entry?.kind === "radio" ? entry.elements : [entry?.element];
    if (!controls?.length || !controls.every((el) => el?.isConnected) || !isFieldBindingCurrent(entry)) return stale;
    try {
      if (entry.kind === "radio") {
        const checked = entry.elements.find((el) => el.checked);
        if (!checked) return ready("");
        const label = cleanProfileText(checked.labels?.[0]?.textContent || checked.closest?.("label")?.textContent
          || checked.getAttribute?.("aria-label"), false);
        return label ? ready(label) : unreadable;
      }
      const el = entry.element;
      if (PROFILE_UNREADABLE_TYPES.has(String(el.type || "").toLowerCase())) return unreadable;
      if (["custom-select", "cascader"].includes(entry.controlKind)) {
        const selection = self.ResumeProCustomControls?.readSelection?.(entry);
        if (selection?.texts?.length) return ready(cleanProfileText(selection.texts.join(selection.cascade ? "/" : "、"), false));
        return hasExistingValue(entry) ? unreadable : ready("");
      }
      if (el instanceof HTMLSelectElement) {
        const options = Array.from(el.options || []);
        const chosen = el.multiple ? options.filter((option) => option.selected) : [options[el.selectedIndex]].filter(Boolean);
        const texts = chosen
          .filter((option) => option.value !== "" && !self.ResumeProAIHelpers?.isPlaceholderOption?.({ value: option.value, text: option.text, disabled: option.disabled }))
          .map((option) => cleanProfileText(option.text ?? option.textContent, false))
          .filter(Boolean);
        return ready(texts.join("、"));
      }
      return ready(cleanProfileText(el.isContentEditable ? el.textContent : el.value, el.tagName === "TEXTAREA" || el.isContentEditable));
    } catch {
      return unreadable;
    }
  }

  // 此刻的候选规划：网页当前的值 × 给定的桌面档案和模板。
  function currentProfilePlan(store = state.currentStore, stats = null) {
    const candidates = (state.profileOfferCandidates || []).map((candidate) =>
      candidate.matched ? candidate : { ...candidate, ...readProfileEntry(candidate.entry) });
    const template = getActiveTemplate(store);
    return self.ResumeProProfile.planProfileOffer({
      candidates, profile: store?.profile, templateFields: template ? flattenTemplateFields(template) : [], stats
    });
  }

  // 侧栏画候选用的快照。值只经这条本机消息给侧栏，不进诊断、反馈或存储。
  function panelProfileSnapshot() {
    const api = self.ResumeProProfile;
    let result = state.profileOfferResult;
    if (!api || (!state.profileOfferCandidates?.length && !result)) return null;
    const plan = state.profileOfferCandidates?.length
      ? currentProfilePlan()
      : { filled: [], pending: [], conflicts: [], notes: [], same: 0, hidden: 0 };
    // 保存完成后保持简短结果；用户随后在网页补出新答案时，再展示新的保存建议。
    if (result?.saved > 0 && profileCandidateSignature(plan) !== state.profileResultCandidateSignature) {
      state.profileOfferResult = null;
      result = null;
    }
    if (state.profileDismissedCandidateSignature !== null) {
      if (profileCandidateSignature(plan) === state.profileDismissedCandidateSignature) return null;
      state.profileDismissedCandidateSignature = null;
    }
    if (!api.planHasOffer(plan) && !result) return null;
    return {
      epoch: state.profileOfferEpoch,
      version: state.profileOfferVersion,
      saving: state.profileSaving,
      summary: api.planHasOffer(plan) ? api.profileOfferSummary(plan) : "",
      filled: plan.filled.map(({ id, key, value, completes, jobSpecific, defaultSelected }) => ({ id, key, value, completes, jobSpecific, defaultSelected })),
      pending: plan.pending.map(({ id, key, unreadable }) => ({ id, key, unreadable, defaultSelected: false })),
      conflicts: plan.conflicts.map(({ id, key, value, existing }) => ({ id, key, value, existing, defaultSelected: false })),
      notes: plan.notes.map((note) => note.text),
      same: plan.same,
      hidden: plan.hidden,
      result: state.profileOfferResult ? { ...state.profileOfferResult } : null
    };
  }

  function profileCandidateSignature(plan) {
    return JSON.stringify([
      ...(plan?.filled || []).map((item) => [item.id, item.value]),
      ...(plan?.conflicts || []).map((item) => [item.id, item.value, item.existing])
    ]);
  }

  function normalizeProfileSelection(raw) {
    return (Array.isArray(raw) ? raw : []).slice(0, 200).map((item) => ({
      id: String(item?.id ?? ""),
      key: String(item?.key ?? ""),
      kind: ["filled", "pending", "conflict"].includes(item?.kind) ? item.kind : undefined,
      reviewedValue: typeof item?.reviewedValue === "string" ? item.reviewedValue : undefined,
      replaceOf: typeof item?.replaceOf === "string" ? item.replaceOf : undefined
    }));
  }

  function profileSaveFailure(status) {
    if (status === "conflict") return "「我的信息」刚在别处改过，这次没有保存；候选还在，请再点一次保存。";
    if (status === "secret") return "桌面认为有一项内容像密码或验证码，这次没有保存任何内容；候选还在。";
    if (status === "input_too_large") return "「我的信息」太大，桌面没有保存。先在桌面删掉用不上的补充字段；候选还在。";
    if (status === "invalid_payload") return "桌面没有接受这次保存（可能超出补充字段数量或大小限制），什么都没有写入；候选还在。";
    if (["not_installed", "not_paired", "never_paired", "incompatible", "unavailable"].includes(status)) {
      return `没有保存：${self.ResumeProResumeData.modeCopy(status).message}候选还在，连上后再点保存。`;
    }
    return "桌面暂时无法保存「我的信息」，什么都没有写入；候选还在，可以稍后再试。";
  }

  // 点击保存：重新读桌面档案和网页当前的值，按用户的勾选写入，成功后再读一次桌面档案。
  async function saveProfileSelection(request) {
    const api = self.ResumeProProfile;
    const fail = (text) => ({ kind: "error", text, hint: "", details: [], saved: 0 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fresh = await StorageService.getState();
      if (!fresh) return fail(profileSaveFailure(state.desktopMode));
      state.currentStore = fresh;
      const plan = currentProfilePlan(fresh);
      const selection = request ? normalizeProfileSelection(request.selected) : api.defaultProfileSelection(plan);
      const outcome = api.applyProfileSelection(fresh.profile, plan, selection);
      if (!outcome.saved.length) return { ...api.describeProfileSave(outcome), saved: 0 };

      const reply = await chrome.runtime.sendMessage({
        type: "DESKTOP_RESUME_UPDATE", op: "saveProfile",
        profile: outcome.profile, expectedRevision: fresh.profileRevision
      });
      if (reply?.status === "conflict" && attempt === 0) continue;
      if (reply?.status !== "ok") return fail(profileSaveFailure(reply?.status));

      // 桌面确认写入了；插件显示和下次填写用的都是重新读到的桌面档案。
      const after = await StorageService.getState();
      if (after) {
        state.currentStore = after;
        if (shadowRoot?.querySelector("#resume-pro-template-select")) renderSidebar();
      }
      const message = api.describeProfileSave(outcome);
      return {
        ...message, saved: outcome.saved.length,
        savedItems: outcome.saved.map(({ key, value, kind }) => ({ key, value, kind })),
        hint: [message.hint, after ? "" : "暂时没能重新读取桌面档案，下次填写前会再读一次。"].filter(Boolean).join(" ")
      };
    }
    return fail(profileSaveFailure("conflict"));
  }

  async function addUnansweredToProfile(request = null) {
    const done = (extra) => ({ ...extra, profileOffer: panelProfileSnapshot() });
    if (!self.ResumeProProfile || !state.profileOfferCandidates?.length) {
      return done({ ok: false, saved: 0, error: "没有可保存的内容，请先一键填写。" });
    }
    if (Number.isInteger(request?.version) && request.version !== state.profileOfferVersion) {
      return done({ ok: false, saved: 0, error: "候选已经更新，请重新核对后再保存。" });
    }
    if (state.profileSaving) return done({ ok: false, saved: 0, error: "正在保存，请稍候。" });

    state.profileSaving = true;
    state.profileOfferResult = null;
    let result;
    try {
      result = await saveProfileSelection(request);
    } catch (error) {
      result = { kind: "error", text: `没有保存：${error?.message || "写入失败"}；候选还在。`, hint: "", details: [], saved: 0 };
    } finally {
      state.profileSaving = false;
    }
    state.profileOfferResult = result;
    const plan = currentProfilePlan();
    state.profileResultCandidateSignature = profileCandidateSignature(plan);
    syncProfileOfferCard(plan);
    // 原生侧栏自己显示结果；旧的页面内侧栏只读这块状态区，需要明确反馈。
    if (inPageUiVisible()) {
      const shown = [result.text, ...(result.details || []), result.hint].filter(Boolean).join(" ");
      showStatus(shown, result.kind === "success" ? "success" : "error", result.kind !== "success");
    }
    return done({ ok: result.saved > 0, saved: result.saved });
  }

  function flattenTemplateFields(template) {
    return template.groups.flatMap((group) => group.fields.map((field) => ({
      group: group.name,
      key: field.key,
      value: field.value
    })));
  }

  function getRadioOptionLabel(radio) {
    const directLabel = radio.labels?.[0]?.textContent?.trim();

    if (directLabel) {
      return directLabel;
    }

    const wrappingLabel = radio.closest("label")?.textContent?.trim();
    if (wrappingLabel) {
      return wrappingLabel;
    }

    return radio.value?.trim() || "";
  }

  async function openManager(view = "home") {
    try {
      const result = await chrome.runtime.sendMessage({ type: "DESKTOP_OPEN_VIEW", view });
      if (result?.status !== "ok") {
        showStatus("桌面程序暂时无法打开，请检查连接。", "error");
      }
    } catch {
      showStatus("桌面程序暂时无法打开，请检查连接。", "error");
    }
  }

  async function openDesktopAction(mode) {
    const kind = self.ResumeProResumeData.modeCopy(mode).kind;
    if (kind === "download") {
      window.open(self.ResumeProResumeData.DOWNLOAD_URL, "_blank", "noopener");
    } else if (kind === "pair") {
      await copyText(chrome.runtime.id);
      showStatus("扩展 ID 已复制，请在桌面设置中粘贴并完成配对。", "success", true);
    } else if (kind === "retry") {
      state.currentStore = await StorageService.getState();
      renderSidebar();
    } else {
      await openManager(kind === "resume" ? "resume" : "home");
    }
  }

  function isFillTarget(target) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  function getActiveTemplate(store) {
    return store?.activeTemplate || null;
  }

  function hasResumeData() {
    return Boolean(getActiveTemplate(state.currentStore) || profileResumeFields().length);
  }

  function showStatus(message, variant, persist = false) {
    const statusElement = shadowRoot?.querySelector("#resume-pro-status");

    if (!statusElement) {
      return;
    }

    statusElement.textContent = message;
    statusElement.className = `resume-pro__status is-visible is-${variant}`;

    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
      state.statusTimer = null;
    }

    if (persist) {
      return;
    }

    state.statusTimer = window.setTimeout(() => {
      statusElement.className = "resume-pro__status";
      statusElement.textContent = "";
    }, 2400);
  }

  function startDrag(event) {
    if (event.target.closest("button, select, input")) {
      return;
    }

    const host = document.getElementById(SIDEBAR_ID);
    const rect = host.getBoundingClientRect();
    state.dragging = true;
    state.dragOffsetX = event.clientX - rect.left;
    state.dragOffsetY = event.clientY - rect.top;
    shadowRoot?.querySelector(".resume-pro")?.classList.add("is-dragging");
  }

  function onDrag(event) {
    if (!state.dragging) {
      return;
    }

    const sidebar = document.getElementById(SIDEBAR_ID);
    const width = sidebar.offsetWidth;
    const height = sidebar.offsetHeight;
    const nextLeft = clamp(event.clientX - state.dragOffsetX, 12, window.innerWidth - width - 12);
    const nextTop = clamp(event.clientY - state.dragOffsetY, 12, window.innerHeight - height - 12);

    sidebar.style.left = `${nextLeft}px`;
    sidebar.style.top = `${nextTop}px`;
    sidebar.style.right = "auto";
  }

  function stopDrag() {
    if (!state.dragging) {
      return;
    }

    state.dragging = false;
    shadowRoot?.querySelector(".resume-pro")?.classList.remove("is-dragging");
    persistSidebarUiState();
  }

  function updateCollapseButton(sidebar = shadowRoot?.querySelector(".resume-pro")) {
    const collapseButton = sidebar?.querySelector(".resume-pro__collapse");
    if (!collapseButton) {
      return;
    }

    const collapsed = sidebar.classList.contains("is-collapsed");
    collapseButton.textContent = collapsed ? "+" : "−";
    collapseButton.setAttribute("aria-label", collapsed ? "展开助手" : "折叠助手");
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
  }

  function readSidebarUiState() {
    const host = document.getElementById(SIDEBAR_ID);
    const sidebar = shadowRoot?.querySelector(".resume-pro");
    if (!host || !sidebar) {
      return self.ResumeProSidebarState.normalize(state.sidebarUiState);
    }

    // The host uses position: fixed, so these are viewport coordinates unless a
    // page deliberately establishes a transformed containing block.
    const rect = host.getBoundingClientRect();
    return self.ResumeProSidebarState.normalize({
      collapsed: sidebar.classList.contains("is-collapsed"),
      left: rect.left,
      top: rect.top
    });
  }

  function applySidebarUiState() {
    const host = document.getElementById(SIDEBAR_ID);
    const sidebar = shadowRoot?.querySelector(".resume-pro");
    if (!host || !sidebar) {
      return;
    }

    const uiState = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    sidebar.classList.toggle("is-collapsed", uiState.collapsed);
    updateCollapseButton(sidebar);

    if (uiState.left === null || uiState.top === null) {
      host.style.removeProperty("left");
      host.style.top = `${SIDEBAR_DEFAULT_TOP}px`;
      host.style.right = `${SIDEBAR_DEFAULT_RIGHT}px`;
      state.sidebarUiState = uiState;
      return;
    }

    const rect = host.getBoundingClientRect();
    const constrained = self.ResumeProSidebarState.constrain(
      uiState,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight }
    );
    host.style.left = `${constrained.left}px`;
    host.style.top = `${constrained.top}px`;
    host.style.right = "auto";
    state.sidebarUiState = constrained;
  }

  function constrainSidebarToViewport() {
    const current = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    if (current.left === null || current.top === null) {
      // Keep the untouched default anchored to the right edge as the viewport changes.
      state.sidebarUiState = current;
      applySidebarUiState();
      return false;
    }

    // A resize only pulls the sidebar back into view for this session. It is
    // deliberately not persisted: a window the user shrank for a moment should not
    // overwrite the position they chose on a larger one.
    state.sidebarUiState = readSidebarUiState();
    applySidebarUiState();
    return !self.ResumeProSidebarState.equal(current, state.sidebarUiState);
  }

  function persistSidebarUiState() {
    const previous = self.ResumeProSidebarState.normalize(state.sidebarUiState);
    state.sidebarUiState = readSidebarUiState();
    applySidebarUiState();
    if (self.ResumeProSidebarState.equal(previous, state.sidebarUiState)) {
      return;
    }
    StorageService.setSidebarUiState(state.sidebarUiState).catch(() => {});
  }

  function clamp(value, min, max) {
    return max < min ? 0 : Math.min(Math.max(value, min), max);
  }

  function inferPickerInputType(container, inner) {
    const cls = container.className || "";
    const placeholder = (inner.getAttribute("placeholder") || "").toLowerCase();
    if (/time/i.test(cls) || /时间|hh:mm/.test(placeholder)) return "time";
    if (/month/i.test(cls) || /年月|月份|month/.test(placeholder)) return "month";
    if (/datetime/i.test(cls) || /日期.*时间|datetime/.test(placeholder)) return "datetime-local";
    return "date";
  }

  function isVisible(element) {
    const styles = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return styles.display !== "none"
      && styles.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // --- Desktop link ---------------------------------------------------------
  //
  // The sidebar reads the page and shows the result; the service worker owns the native
  // messaging port and both queues. Content scripts cannot open that port at all, so every
  // desktop operation is a message.
  //
  // Extraction and URL redaction run here rather than in the worker because the worker has
  // no DOM, and because §5.2 puts the credential stripping before anything leaves the page.

  let desktopModules = null;
  let pendingFields = null;
  let saveInFlight = false;
  let extractInFlight = false;
  let lastSubmittedFields = null;
  let extractToken = 0;
  let assistRequestId = null;
  let assistFallback = null;
  // The finished fill the card is offering to archive, and a copy of the template it used.
  // Held only until the user answers; the template copy leaves only if the box is ticked.
  let pendingFill = null;
  let pendingFillTemplate = null;

  async function loadDesktopModules() {
    if (!desktopModules) {
      const [extract, copy, fillrecords, snapshot, saveFlow] = await Promise.all([
        import(chrome.runtime.getURL("link/extract.mjs")),
        import(chrome.runtime.getURL("link/copy.mjs")),
        import(chrome.runtime.getURL("link/fillrecords.mjs")),
        import(chrome.runtime.getURL("link/snapshot.mjs")),
        import(chrome.runtime.getURL("link/save-flow.mjs"))
      ]);
      desktopModules = { extract, copy, fillrecords, snapshot, saveFlow };
    }
    return desktopModules;
  }

  function bindDesktopEvents(sidebar) {
    sidebar.querySelector("#resume-pro-save-job")?.addEventListener("click", handleSaveJobClick);
    sidebar.querySelector("#resume-pro-confirm-submit")?.addEventListener("click", handleConfirmSubmitClick);
    sidebar.querySelector("#resume-pro-save-cancel")?.addEventListener("click", closeSaveForm);
    sidebar.querySelector("#resume-pro-job-assist-cancel")?.addEventListener("click", cancelJobAssist);
    sidebar.querySelector("#resume-pro-save-open-ai")?.addEventListener("click", () => openManager("settings-ai"));
    sidebar.querySelector("#resume-pro-fill-record-save")?.addEventListener("click", handleRecordFillClick);
    sidebar.querySelector("#resume-pro-fill-record-skip")?.addEventListener("click", closeFillRecord);
    sidebar.querySelector("#resume-pro-save-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitSaveForm({ force: false });
    });
    refreshPendingList();
  }

  async function handleSaveJobClick() {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form || !form.hidden || saveInFlight || extractInFlight) return;
    const token = ++extractToken;
    extractInFlight = true;
    const button = shadowRoot.querySelector("#resume-pro-save-job");
    if (button) button.disabled = true;
    form.hidden = true;
    setDesktopStatus(null);

    try {
      const draft = await draftJobFields({
        isCurrent: () => token === extractToken,
        onAssistStart: (described, requestId, fallback) => {
          assistRequestId = requestId;
          assistFallback = fallback;
          showJobAssist(described);
        },
        onAssistEnd: (requestId) => {
          if (assistRequestId === requestId) assistRequestId = null;
          if (token === extractToken) hideJobAssist();
        }
      });
      if (!draft || token !== extractToken) return;
      openSaveForm(draft.fields, draft.note, { openView: draft.openView });
    } catch (error) {
      if (token !== extractToken) return;
      setDesktopStatus({ tone: "warn", text: "读取页面信息失败，请手动填写后再保存。" });
      openSaveForm(emptyJobFields(), "读取页面信息失败，请手动填写。");
    } finally {
      if (token === extractToken) {
        extractInFlight = false;
        if (button) button.disabled = saveInFlight;
      }
    }
  }

  function emptyJobFields() {
    return { company: "", title: "", location: "", sourceUrl: "", dedupeUrl: "" };
  }

  // Step one of saving a job, shared by the page form and the native side panel: read the
  // page, ask the desktop's AI only when extraction is unsure, and return what the user
  // should review. Nothing is written anywhere here. `null` means the caller moved on
  // (cancelled or restarted) and the answer must be dropped.
  async function draftJobFields({ isCurrent, onAssistStart, onAssistEnd }) {
    const { extract, saveFlow, copy } = await loadDesktopModules();
    const extraction = extract.extractJobFields(document, location.href);
    const step = saveFlow.nextSaveStep(extraction);
    if (!isCurrent()) return null;
    if (step.action === "commit") {
      return { fields: step.fields, note: copy.describeReviewSave(), openView: null, fallback: step.fields };
    }
    if (step.action === "assist") {
      const outcome = await runJobAssist(step.fragments, step.fields, { isCurrent, onAssistStart, onAssistEnd });
      if (!isCurrent() || outcome.action === "ignore") return null;
      return {
        fields: outcome.fields,
        note: outcome.action === "commit" ? copy.describeReviewSave() : outcome.note,
        openView: outcome.openView || null,
        fallback: step.fields
      };
    }
    return { fields: step.fields, note: copy.describeManualSave(step.reason), openView: null, fallback: step.fields };
  }

  // The worker asks the desktop's AI and gives up after 25 seconds itself; this timer only
  // covers a worker that never answers. There is no automatic retry either way.
  async function runJobAssist(fragments, fallback, { isCurrent, onAssistStart, onAssistEnd }) {
    const { saveFlow, copy } = await loadDesktopModules();
    // The user may have cancelled, or the page moved on, while the modules were loading.
    // Checked before anything is shown or sent: an assist panel raised for a job nobody is
    // waiting for would have no request to end it and would stay on screen.
    if (!isCurrent()) return { action: "ignore" };
    const requestId = newRequestId();
    onAssistStart?.(copy.describeJobAssist(saveFlow.assistDisclosure(fragments)), requestId, fallback);
    // Showing the progress can itself hand control away (a caller that re-renders). If the
    // job stopped being current, the progress is taken down again and nothing is sent.
    if (!isCurrent()) {
      onAssistEnd?.(requestId);
      return { action: "ignore" };
    }
    let reply;
    let timer;
    try {
      reply = await Promise.race([
        self.ResumeProAIClient.send({ type: "AI_EXTRACT_JOB", requestId, fragments }),
        new Promise(resolve => {
          timer = setTimeout(() => {
            self.ResumeProAIClient.cancel(requestId).catch(() => {});
            resolve({ status: "manual", reason: "timeout", reliable: false, fields: {} });
          }, 30000);
        })
      ]);
    } catch {
      reply = { status: "manual", reason: "internal", reliable: false, fields: {} };
    } finally {
      clearTimeout(timer);
      onAssistEnd?.(requestId);
    }
    if (!isCurrent()) return { action: "ignore" };
    const after = saveFlow.afterAssist(reply, fallback);
    if (after.action === "form") {
      // `note` is a desktop failure from the worker; `error` is the host saying the worker itself died.
      const detail = [reply?.note, reply?.error].find(value => typeof value === "string" && value) || "";
      after.note = copy.describeManualSave(after.reason, detail);
      if (reply?.openView === "settings-ai") after.openView = "settings-ai";
    }
    return after;
  }

  function showJobAssist(described) {
    const panel = shadowRoot?.querySelector("#resume-pro-job-assist");
    if (!panel) return;
    // The note is a status region: show the panel first so a screen reader hears the text
    // arrive, rather than finding it already there.
    panel.hidden = false;
    panel.querySelector("#resume-pro-job-assist-note").textContent = described.text;
    const list = panel.querySelector("#resume-pro-job-assist-fragments");
    list.textContent = "";
    for (const line of described.fragments || []) {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    }
  }

  function hideJobAssist() {
    const panel = shadowRoot?.querySelector("#resume-pro-job-assist");
    if (!panel) return;
    panel.hidden = true;
    // Cleared so the next recognition is announced again.
    const note = panel.querySelector("#resume-pro-job-assist-note");
    if (note) note.textContent = "";
  }

  function cancelJobAssist() {
    const token = ++extractToken;
    extractInFlight = false;
    if (assistRequestId) self.ResumeProAIClient.cancel(assistRequestId).catch(() => {});
    assistRequestId = null;
    const button = shadowRoot?.querySelector("#resume-pro-save-job");
    if (button) button.disabled = saveInFlight;
    hideJobAssist();
    const fields = assistFallback || pendingFields || emptyJobFields();
    // The panel is already gone; the form has to open either way or the user is left with nothing.
    loadDesktopModules().then(({ copy }) => copy.describeManualSave("cancelled"), () => "已取消识别。请手动补全后再保存。")
      .then(note => {
        if (token !== extractToken) return;
        openSaveForm(fields, note);
      });
  }

  function openSaveForm(fields, note, { openView = null } = {}) {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form) return;
    pendingFields = fields;
    form.querySelector("#resume-pro-save-company").value = fields.company || "";
    form.querySelector("#resume-pro-save-title").value = fields.title || "";
    form.querySelector("#resume-pro-save-location").value = fields.location || "";
    form.querySelector("#resume-pro-save-url").value = fields.sourceUrl || "";
    form.querySelector("#resume-pro-save-note").textContent = note;
    const openAi = form.querySelector("#resume-pro-save-open-ai");
    if (openAi) openAi.hidden = openView !== "settings-ai";
    form.hidden = false;
  }

  // Confirming a submission is its own act: it has nothing to do with whether the AI fill
  // worked, and nothing to do with having saved the posting a moment ago. The application is
  // chosen from the desktop's own candidates rather than remembered here, so the plugin never
  // holds a stale application id across a restore.
  async function handleConfirmSubmitClick() {
    const { extract, copy } = await loadDesktopModules();
    const fields = extract.extractJobFields(document, location.href);
    if (!fields.company) {
      setDesktopStatus({ tone: 'warn', text: '这个页面看不出是哪家公司，请先在桌面里确认投递。' });
      return;
    }

    let candidates;
    try {
      candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields });
    } catch {
      candidates = null;
    }
    if (candidates?.status !== "ok") {
      // Nothing was written or queued: say which way the desktop could not be reached.
      setDesktopStatus(copy.describeConfirmBlocked(confirmBlockedMode(candidates?.status), { extensionId: chrome.runtime.id }));
      return;
    }

    const options = [...candidates.exact, ...candidates.sameCompany];
    if (!options.length) {
      setDesktopStatus({ tone: 'warn', text: '桌面里还没有这家公司的申请，请先保存岗位。' });
      return;
    }

    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent = "这次投递的是哪一条申请？";
    list.textContent = "";
    for (const candidate of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}`;
      row.addEventListener("click", async () => {
        box.hidden = true;
        let result;
        try {
          result = await chrome.runtime.sendMessage({
            type: "DESKTOP_CONFIRM_SUBMIT", applicationId: candidate.applicationId
          });
        } catch {
          result = { status: "unknown" };
        }
        setDesktopStatus(copy.describeConfirmResult(result ?? { status: "unknown" }));
        refreshPendingList();
      });
      list.appendChild(row);
    }
    shadowRoot.querySelector("#resume-pro-bind-new").hidden = true;
    box.hidden = false;
  }

  // What the desktop's answer to a candidates query means for "确认已投递". Only these modes
  // have their own wording; a retryable or fatal failure is "the desktop is not answering".
  const CONFIRM_BLOCKED_MODES = new Set(["not_installed", "not_paired", "never_paired", "incompatible", "unavailable"]);
  function confirmBlockedMode(status) {
    return CONFIRM_BLOCKED_MODES.has(status) ? status : "unavailable";
  }

  // --- D08: archiving a finished fill ----------------------------------------------------
  //
  // After every fill the sidebar may offer to archive it. It never blocks the fill and never
  // throws into it, and a profile that has never paired a desktop is not asked at all: those
  // users keep nothing. What is offered is counts and timings; the field values stay here.

  async function offerFillRecord(raw, template) {
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (!card) return;
    // Read the page before waiting on the worker: on a single-page site the user can move on
    // to the next posting meanwhile, and this fill must not be filed under that one. The
    // modules were warmed when the fill started; if they were not, and the page changed while
    // they loaded, there is no posting to offer this fill under.
    const pageUrl = location.href;
    const { extract, copy, fillrecords, snapshot } = await loadDesktopModules();
    if (location.href !== pageUrl) return;
    const job = extract.extractJobFields(document, pageUrl);
    const link = await chrome.runtime.sendMessage({ type: "DESKTOP_LINK_STATE" });
    if (!link?.everPaired) return;
    // The template the fill actually used, frozen now: editing the template before answering
    // must not change what the snapshot says was used (D08 decision 2).
    pendingFillTemplate = template ? structuredClone(template) : null;
    pendingFill = {
      ...raw,
      // This one finished fill's id (#178). Minted here, it is the record's id if the user
      // archives it, so a repeated or doubled request can never become a second record.
      recordId: newRecordId(),
      urlRedacted: job.sourceUrl,
      templateVersion: (await snapshot.templateVersionOf(template)) || "",
      pluginVersion: chrome.runtime.getManifest().version,
      job: { company: job.company, title: job.title, sourceUrl: job.sourceUrl }
    };
    // The summary is built from exactly what would be sent, so the card cannot promise more.
    const summary = copy.describeFillOffer(fillrecords.buildFillPayload(pendingFill));
    card.querySelector("#resume-pro-fill-record-summary").textContent = summary;
    const option = card.querySelector("#resume-pro-fill-record-snapshot");
    if (option) {
      option.checked = true;
      option.disabled = !pendingFillTemplate;
    }
    card.hidden = false;
    offerPanelFillArchive(pendingFill, pendingFillTemplate, summary);
  }

  function closeFillRecord() {
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (card) card.hidden = true;
    pendingFill = null;
    pendingFillTemplate = null;
    // Answered on the page overlay: the side panel's copy of the same offer goes too.
    if (panelFill?.phase === "offer") panelFill = idlePanelFill(panelFill);
  }

  async function handleRecordFillClick() {
    const raw = pendingFill;
    if (!raw) return;
    const withSnapshot = shadowRoot?.querySelector("#resume-pro-fill-record-snapshot")?.checked;
    const snapshotTemplate = withSnapshot ? pendingFillTemplate : null;
    closeFillRecord();

    let candidates = null;
    if (raw.job?.company) {
      try {
        candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: raw.job });
      } catch {
        candidates = null;
      }
    }
    if (candidates?.status !== "ok") {
      // The desktop is not answering, or the page does not say which company this is. The
      // fill waits, and the application is picked from the pending list later.
      await recordFill(raw, null, snapshotTemplate);
      return;
    }

    const options = [...candidates.exact, ...candidates.sameCompany];
    showFillCandidates(options, {
      note: options.length
        ? "这次填写属于哪条申请？"
        : "桌面里还没有这家公司的申请。可以先「保存岗位到桌面端」，或者稍后在待同步里选择。",
      onPick: applicationId => recordFill(raw, applicationId, snapshotTemplate),
      onLater: () => recordFill(raw, null, snapshotTemplate)
    });
  }

  async function recordFill(raw, applicationId, snapshotTemplate) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "DESKTOP_RECORD_FILL", raw, recordId: raw.recordId, applicationId, snapshotTemplate
      });
    } catch {
      result = { status: "rejected" };
    }
    setDesktopStatus(copy.describeFillRecordResult(result ?? { status: "rejected" }));
    revealDesktopStatus();
    refreshPendingList();
  }

  // The card sits under the fill result; the answer lands in the desktop section further
  // down. Bring it into view so the click does not look like it did nothing.
  function revealDesktopStatus() {
    shadowRoot?.querySelector("#resume-pro-desktop-status")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  // The same candidate box saving a job uses. There is no "new application" here: a fill
  // belongs to an application that exists, and nothing is ever bound on the user's behalf.
  function showFillCandidates(options, { note, onPick, onLater }) {
    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    if (!box || !list) return;
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent = note;
    list.textContent = "";
    for (const candidate of options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}${candidate.stage ? `（${candidate.stage}）` : ""}`;
      row.addEventListener("click", () => {
        box.hidden = true;
        onPick(candidate.applicationId);
      });
      list.appendChild(row);
    }
    shadowRoot.querySelector("#resume-pro-bind-new").hidden = true;
    shadowRoot.querySelector("#resume-pro-bind-later").onclick = () => {
      box.hidden = true;
      onLater();
    };
    box.hidden = false;
    box.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  // What the desktop shows as an application's id. Checked before binding: a mistyped id would
  // otherwise be queued and then refused on every attempt.
  const APPLICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // A waiting record, bound from the pending list.
  async function chooseFillApplication(record) {
    const { copy } = await loadDesktopModules();
    if (!record.job?.company) {
      const typed = prompt("这条留档要记到哪条申请？请粘贴桌面里的申请 ID：")?.trim();
      if (!typed) return;
      if (!APPLICATION_ID_PATTERN.test(typed)) {
        setDesktopStatus(copy.describeFillRecordResult({ status: "rejected", reason: "invalid_application_id" }));
        return;
      }
      await bindFillRecord(record.recordId, typed);
      return;
    }
    let candidates;
    try {
      candidates = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: record.job });
    } catch {
      candidates = null;
    }
    if (candidates?.status !== "ok") {
      setDesktopStatus(copy.describeFillRecordResult({ status: "recorded", mode: "unavailable" }));
      return;
    }
    const options = [...candidates.exact, ...candidates.sameCompany];
    showFillCandidates(options, {
      note: options.length ? "这次填写属于哪条申请？" : "桌面里还没有这家公司的申请，请先保存岗位。",
      onPick: applicationId => bindFillRecord(record.recordId, applicationId),
      onLater: () => {}
    });
  }

  async function bindFillRecord(recordId, applicationId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_BIND_FILL", recordId, applicationId });
    } catch {
      result = { status: "pending" };
    }
    setDesktopStatus(copy.describeFillRecordResult(result ?? { status: "pending" }));
    revealDesktopStatus();
    refreshPendingList();
  }

  // --- Archiving a fill from the native side panel (#178) --------------------------------
  //
  //   offer -> querying -> choosing | empty | blocked -> saving
  //         -> saved | queued | pending_bind | failed | unknown      (or cancelled)
  //
  // The side panel draws every step from panelFillSnapshot() and answers with the messages
  // above (RESUME_PANEL_ARCHIVE_*). Nothing is written until the user picks an application
  // or explicitly asks to keep the fill waiting; cancelling writes and stages nothing. The
  // archive is bound to:
  //   - `archiveId`, the recordId minted when the fill was offered. The record, if any, gets
  //     this id, so a second request for the same fill is a duplicate (link/fillrecords.mjs);
  //   - a token that every cancel, re-query and new fill replaces, so an answer still on its
  //     way for an earlier question is dropped instead of reopening it;
  //   - this page load (`epoch`), so the panel never compares versions across a reload.
  // The candidates are the desktop's list for this fill's company; the panel can only pick
  // from it, and even a single candidate waits for the user. Page memory only.

  const PANEL_FILL_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const PANEL_FILL_OPEN = ["offer", "querying", "choosing", "empty", "blocked"];
  const PANEL_FILL_DONE = ["saved", "queued", "pending_bind", "failed", "unknown"];
  const PANEL_FILL_BLOCKED_MODES = new Set(["unavailable", "incompatible", "not_installed", "not_paired", "never_paired"]);
  const PANEL_FILL_ENDED = "这次填写的留档已经结束了。";
  let panelFillWaitMs = 30000;
  panelFill = idlePanelFill(null);

  function idlePanelFill(previous) {
    return {
      archiveId: null, phase: "idle", version: (previous?.version || 0) + 1, token: (previous?.token || 0) + 1,
      raw: null, template: null, summary: "", withSnapshot: false, candidates: [], reason: "",
      canQueue: false, result: null, application: null, snapshotId: null, recordKept: false, saving: ""
    };
  }

  function touchPanelFill(changes) {
    Object.assign(panelFill, changes, { version: panelFill.version + 1 });
  }

  // What the side panel may see: counts in the summary, labels and ids of the offered
  // applications, and the answer. Never the page's field values, and never the template.
  function panelFillSnapshot() {
    const job = panelFill || idlePanelFill(null);
    return {
      epoch: PANEL_FILL_EPOCH,
      archiveId: job.archiveId,
      phase: job.phase,
      version: job.version,
      summary: job.summary,
      snapshotAvailable: Boolean(job.template),
      withSnapshot: job.withSnapshot,
      saving: job.saving,
      reason: job.reason,
      canQueue: job.canQueue,
      candidates: job.candidates.map(candidate => ({ applicationId: candidate.applicationId, label: candidate.label })),
      result: job.result ? { ...job.result } : null,
      recordKept: job.recordKept,
      snapshotId: job.snapshotId
    };
  }

  const panelFillOutcome = (extra = {}) => ({ ...extra, fillArchive: panelFillSnapshot() });

  // A new finished fill replaces whatever question the previous one left open. A write that
  // is already on its way keeps going; its answer is dropped by the token and lands in the
  // pending list instead.
  function offerPanelFillArchive(raw, template, summary) {
    panelFill = idlePanelFill(panelFill);
    touchPanelFill({ archiveId: raw.recordId, phase: "offer", raw, template, summary, withSnapshot: Boolean(template) });
  }

  function panelFillMatches(archiveId) {
    return Boolean(archiveId) && archiveId === panelFill?.archiveId;
  }

  async function waitForPanelFill(promise, fallback) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise(resolve => { timer = setTimeout(() => resolve(fallback), panelFillWaitMs); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function startPanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    // A second click while the first is looking: the same question, not a second one.
    if (panelFill.phase !== "offer") return panelFillOutcome({ ok: panelFill.phase !== "idle" && panelFill.phase !== "cancelled" });
    // The side panel owns this fill now; the page overlay's copy of the offer goes away so
    // the two can never both send it.
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (card) card.hidden = true;
    pendingFill = null;
    pendingFillTemplate = null;
    // Decided now, with the offer on screen: the template copy leaves only if this was ticked.
    touchPanelFill({ withSnapshot: Boolean(panelFill.template) && message.withSnapshot !== false });
    return queryPanelFillCandidates();
  }

  async function requeryPanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase === "querying") return panelFillOutcome({ ok: true });
    if (!["empty", "blocked", "choosing"].includes(panelFill.phase)) {
      return panelFillOutcome({ ok: false, error: "现在不能重新查找。" });
    }
    return queryPanelFillCandidates();
  }

  async function queryPanelFillCandidates() {
    // A new token: an earlier lookup's answer belongs to a question nobody is asking now.
    touchPanelFill({ phase: "querying", token: panelFill.token + 1, candidates: [], reason: "", canQueue: false, result: null });
    const token = panelFill.token;
    const isCurrent = () => panelFill.token === token && panelFill.phase === "querying";
    const job = panelFill.raw?.job || {};
    try {
      const { copy } = await loadDesktopModules();
      if (!isCurrent()) return panelFillOutcome({ ok: true });
      if (!job.company) {
        // Nothing to look up. Not an empty list either: that would suggest the desktop has
        // no application for a company the page never named.
        const blocked = copy.describeFillArchiveBlocked("unrecognized");
        touchPanelFill({ phase: "blocked", reason: "unrecognized", canQueue: blocked.canQueue, result: blocked });
        return panelFillOutcome({ ok: true });
      }
      const asked = { company: job.company, title: job.title || "", sourceUrl: job.sourceUrl || "" };
      let answer;
      try {
        answer = await waitForPanelFill(chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: asked }), null);
      } catch {
        answer = null;
      }
      if (!isCurrent()) return panelFillOutcome({ ok: true });
      if (answer?.status !== "ok") {
        // No answer is not "no candidates": an empty list would push the user towards saving
        // a job the desktop may already have.
        const reason = PANEL_FILL_BLOCKED_MODES.has(answer?.status) ? answer.status : "unavailable";
        const blocked = copy.describeFillArchiveBlocked(reason, { extensionId: chrome.runtime.id });
        touchPanelFill({ phase: "blocked", reason, canQueue: blocked.canQueue, result: blocked });
        return panelFillOutcome({ ok: true });
      }
      const seen = new Set();
      const options = [...(answer.exact || []), ...(answer.sameCompany || [])].filter(candidate => {
        if (!candidate || typeof candidate.applicationId !== "string" || !candidate.applicationId) return false;
        if (typeof candidate.company !== "string" || typeof candidate.title !== "string") return false;
        if (seen.has(candidate.applicationId)) return false;
        seen.add(candidate.applicationId);
        return true;
      }).map(candidate => ({
        applicationId: candidate.applicationId, company: candidate.company, title: candidate.title,
        label: copy.describeApplicationChoice(candidate)
      }));
      if (options.length) {
        // Even one candidate waits for the user: the plugin never picks an application.
        touchPanelFill({ phase: "choosing", candidates: options });
      } else {
        touchPanelFill({ phase: "empty", reason: "no-record", result: copy.describeFillArchiveEmpty() });
      }
    } catch {
      if (isCurrent()) {
        touchPanelFill({
          phase: "blocked", reason: "unavailable", canQueue: true,
          result: { tone: "warn", text: "没能查到对应的投递记录。", hint: "可以稍后重新查找，或者先记入待同步。现在还没有留档到桌面。" }
        });
      }
    }
    return panelFillOutcome({ ok: true });
  }

  async function choosePanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    // Claimed synchronously below, so a second click can never send a second record.
    if (panelFill.phase === "saving") return panelFillOutcome({ ok: false, error: "正在留档，请稍候。" });
    if (panelFill.phase !== "choosing") return panelFillOutcome({ ok: false, error: "这个选择已经失效了。" });
    const candidate = panelFill.candidates.find(item => item.applicationId === message.applicationId);
    if (!candidate) return panelFillOutcome({ ok: false, error: "请选择列表里的申请。" });
    return recordPanelFill(candidate);
  }

  // "稍后处理" / "稍后在待同步中选择" / "记入待同步": one waiting record, no application.
  async function laterPanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase === "saving") return panelFillOutcome({ ok: false, error: "正在处理，请稍候。" });
    const allowed = panelFill.phase === "choosing" || panelFill.phase === "empty"
      || (panelFill.phase === "blocked" && panelFill.canQueue);
    if (!allowed) return panelFillOutcome({ ok: false, error: "现在不能记入待同步。" });
    return recordPanelFill(null);
  }

  async function recordPanelFill(candidate) {
    const token = panelFill.token;
    const archiveId = panelFill.archiveId;
    const raw = panelFill.raw;
    const snapshotTemplate = panelFill.withSnapshot ? panelFill.template : null;
    const application = candidate ? { company: candidate.company, title: candidate.title } : null;
    touchPanelFill({ phase: "saving", saving: candidate ? "bind" : "later", application, result: null });
    let result;
    try {
      result = await waitForPanelFill(chrome.runtime.sendMessage({
        type: "DESKTOP_RECORD_FILL", raw, recordId: archiveId,
        applicationId: candidate ? candidate.applicationId : null, snapshotTemplate
      }), { status: "unknown" });
    } catch {
      // The request may have reached the worker before the port failed: not a failure to retry.
      result = { status: "unknown" };
    }
    refreshPendingList();
    if (panelFill.token !== token || panelFill.archiveId !== archiveId) {
      return panelFillOutcome({ ok: false, expired: true, error: "这次留档的结果已经过期，请在「待同步」里核对。" });
    }
    let phase;
    let described;
    try {
      const { copy } = await loadDesktopModules();
      const status = result?.status;
      if (!status || status === "unknown" || result?.error) {
        phase = "unknown";
        described = { tone: "pending", text: copy.FILL_ARCHIVE_UNKNOWN };
      } else if (status === "saved" || (status === "duplicate" && result.receipt?.outcome === "saved")) {
        // Only a persisted reply gets here, and only this names the application.
        phase = "saved";
        described = copy.describeFillRecordResult(result, { application: status === "saved" ? application : null, uploadShownSeparately: true });
      } else if (status === "recorded" || (status === "duplicate" && result.record?.status === "pending_bind")) {
        phase = "pending_bind";
        described = copy.describeFillRecordResult({ ...result, status: "recorded" });
      } else if (status === "duplicate" && result.receipt?.outcome === "discarded") {
        phase = "failed";
        described = copy.describeFillRecordResult(result);
      } else if (status === "pending" || status === "stalled" || status === "duplicate") {
        phase = "queued";
        described = copy.describeFillRecordResult(status === "stalled" ? { ...result, status: "pending" } : result);
      } else {
        phase = "failed";
        described = copy.describeFillRecordResult(result);
      }
    } catch {
      phase = "unknown";
      described = { tone: "pending", text: "没能确认留档结果，请到「待同步」或桌面端核对后再操作。" };
    }
    touchPanelFill({
      phase, saving: "", result: described, raw: null, template: null,
      // Where the record is now, so the panel can offer the pending list only when it exists.
      recordKept: phase === "pending_bind" || phase === "queued" || phase === "unknown" || Boolean(result?.record),
      snapshotId: phase === "saved" && result?.uploadQueued ? result.record?.snapshot?.snapshotId || null : null
    });
    return panelFillOutcome({ ok: true });
  }

  // Deleting the waiting record just made, from the answer card. Only a record that is still
  // waiting can go (removeWaiting); one already sent is left alone.
  async function removePanelFillArchive(message) {
    if (!panelFillMatches(message.archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase !== "pending_bind") return panelFillOutcome({ ok: false, error: "这条记录现在不能删除。" });
    const token = panelFill.token;
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_FILL", recordId: panelFill.archiveId });
    } catch {
      reply = null;
    }
    refreshPendingList();
    if (!reply?.ok) {
      return panelFillOutcome({ ok: false, error: "这条记录已经不在待同步里了，可能已经处理过。" });
    }
    if (panelFill.token === token) panelFill = idlePanelFill(panelFill);
    return panelFillOutcome({ ok: true, removed: true });
  }

  // "不留档" on the offer, "取消留档" on a question, or "知道了" on an answer.
  function cancelPanelFillArchive({ archiveId }) {
    if (!panelFillMatches(archiveId)) return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
    if (panelFill.phase === "saving") {
      return panelFillOutcome({ ok: false, error: "已经在留档了，无法取消。请在「待同步」里核对。" });
    }
    if (PANEL_FILL_OPEN.includes(panelFill.phase)) {
      // Nothing was created and nothing staged. The page overlay's copy goes too.
      const card = shadowRoot?.querySelector("#resume-pro-fill-record");
      if (card) card.hidden = true;
      pendingFill = null;
      pendingFillTemplate = null;
      panelFill = idlePanelFill(panelFill);
      // Kept, so a lookup answer still on its way is recognised as belonging to a closed one.
      touchPanelFill({ archiveId, phase: "cancelled" });
      return panelFillOutcome({ ok: true, cancelled: true });
    }
    if (PANEL_FILL_DONE.includes(panelFill.phase) || panelFill.phase === "cancelled") {
      panelFill = idlePanelFill(panelFill);
      return panelFillOutcome({ ok: true });
    }
    return panelFillOutcome({ ok: false, error: PANEL_FILL_ENDED });
  }

  function closeSaveForm() {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (form) form.hidden = true;
    hideJobAssist();
    pendingFields = null;
    assistFallback = null;
  }

  async function submitSaveForm({ force, fields: retryFields = null }) {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form || saveInFlight || extractInFlight) return;

    // "再存一次" resends what was confirmed. By then the form may be closed and
    // pendingFields cleared, so reading them again would drop the redacted URLs.
    const fields = retryFields || {
      company: form.querySelector("#resume-pro-save-company").value.trim(),
      title: form.querySelector("#resume-pro-save-title").value.trim(),
      location: form.querySelector("#resume-pro-save-location").value.trim(),
      // The URL is whatever redaction produced when the form opened. It is not editable and
      // is never re-read from the address bar here, so no un-redacted URL can reach storage.
      sourceUrl: pendingFields?.sourceUrl || "",
      dedupeUrl: pendingFields?.dedupeUrl || ""
    };
    lastSubmittedFields = fields;
    saveInFlight = true;
    try {
      await commitSave(fields, { force });
    } finally {
      saveInFlight = false;
    }
  }

  // The click, the corrected form and "完成保存" all end here. A live desktop with no exact
  // duplicate is written in this call. Same-company other jobs are not a second question.
  async function commitSave(fields, { force }) {
    const { copy } = await loadDesktopModules();
    presentSaveResult(copy, await saveReviewedJob(fields, { force }));
  }

  // Step two of saving a job, shared by the page form and the native side panel: write what
  // the user confirmed through the existing worker path (duplicate check, offline queue).
  // The URLs always come from the draft's local redaction, never from the caller's edits.
  function reviewedJobFields(draftFields, edited = {}) {
    const text = value => typeof value === "string" ? value.trim() : "";
    return {
      company: text(edited.company),
      title: text(edited.title),
      // Location is shown beside company and title and is part of the user's confirmation.
      location: text(edited.location),
      sourceUrl: typeof draftFields?.sourceUrl === "string" ? draftFields.sourceUrl : "",
      dedupeUrl: typeof draftFields?.dedupeUrl === "string" ? draftFields.dedupeUrl : ""
    };
  }

  async function saveReviewedJob(fields, { force }) {
    try {
      return (await chrome.runtime.sendMessage({ type: "DESKTOP_SAVE_JOB", fields, force: Boolean(force) })) ?? { status: "error" };
    } catch {
      return { status: "error" };
    }
  }

  async function bindSavedJob(intentId, applicationId) {
    try {
      return (await chrome.runtime.sendMessage({ type: "DESKTOP_BIND", intentId, applicationId })) ?? { status: "unknown" };
    } catch {
      // A missing response is not proof that the background queued the bind. Callers keep the
      // existing intent available for recovery, but must not promise an automatic retry.
      return { status: "unknown" };
    }
  }

  // Outcomes after which the job is no longer the form's business: it was written, queued,
  // or is waiting in the pending list. Anything else leaves the form open to try again.
  function saveResultClosesForm(result) {
    const status = result?.status;
    return status === "saved" || status === "pending" || status === "queued" || status === "duplicate"
      || (status === "rejected" && result.reason === "queue_full" && Boolean(result.intent))
      || (status === "failed" && Boolean(result.intent));
  }

  async function continueIntent(intentId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_CONTINUE_SAVE", intentId });
    } catch (error) {
      result = { status: "error" };
    }
    presentSaveResult(copy, result);
  }

  function presentSaveResult(copy, result) {
    if (result?.status === "needs_choice") {
      closeSaveForm();
      showExactChoice(result.intent.intentId, result.exact || []);
      refreshPendingList();
      return;
    }
    setDesktopStatus(describeCommit(copy, result ?? { status: "error" }));
    if (saveResultClosesForm(result)) {
      closeSaveForm();
    }
    refreshPendingList();
  }

  function describeCommit(copy, result) {
    if (result?.status === "saved" || result?.status === "pending" || result?.status === "failed") {
      return copy.describeBindResult(result);
    }
    if (result?.status === "duplicate" && result?.reason === "already_queued") {
      return copy.describeBindResult(result);
    }
    if (result?.status === "rejected" && ["unknown_intent", "no_identity", "awaiting_reconcile", "not_paused"].includes(result.reason)) {
      return copy.describeBindResult(result);
    }
    if (result?.status === "rejected" && result.reason === "queue_full" && result.intent) {
      return copy.describeBindResult(result);
    }
    return copy.describeSaveResult(result);
  }

  // Exact duplicate only. Another title at the same company never reaches this box.
  function showExactChoice(intentId, exact) {
    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    if (!box || !list) return;
    list.textContent = "";
    shadowRoot.querySelector("#resume-pro-candidates-note").textContent =
      "这可能是同一个岗位。要使用已有申请，还是新建一条？";
    for (const candidate of exact) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `使用已有：${candidate.company} · ${candidate.title}${candidate.stage ? `（${candidate.stage}）` : ""}`;
      row.addEventListener("click", () => bindIntent(intentId, candidate.applicationId));
      list.appendChild(row);
    }
    box.hidden = false;
    const bindNew = shadowRoot.querySelector("#resume-pro-bind-new");
    bindNew.hidden = false;
    bindNew.onclick = () => bindIntent(intentId, null);
    shadowRoot.querySelector("#resume-pro-bind-later").onclick = () => {
      box.hidden = true;
      setDesktopStatus({ tone: "pending", text: "已记下，尚未写入桌面。可以稍后在待同步里完成保存。" });
    };
  }

  async function bindIntent(intentId, applicationId) {
    const { copy } = await loadDesktopModules();
    const result = await bindSavedJob(intentId, applicationId);

    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    if (box) box.hidden = true;
    setDesktopStatus(copy.describeBindResult(result));
    refreshPendingList();
  }

  // --- Saving a job from the native side panel (#172) -----------------------------------
  //
  // The same two steps the page form uses, driven by explicit messages instead of page
  // clicks: RESUME_PANEL_SAVE_DRAFT reads the page (and asks the desktop's AI only when the
  // page is unclear), RESUME_PANEL_SAVE_CONFIRM writes what the user reviewed, and
  // RESUME_PANEL_SAVE_CANCEL / RESUME_PANEL_SAVE_CHOICE end it. The draft lives in this
  // page's memory only; nothing about it is written to extension storage.

  const PANEL_JOB_LATER = "已记下，尚未写入桌面。可以稍后在待同步里完成保存。";
  // Shown when the write was sent but its outcome could not be worked out; never "saved".
  const PANEL_JOB_UNKNOWN = {
    tone: "pending",
    // Kept equal to copy.UNKNOWN_SAVE_TEXT (the page overlay's wording); a test holds them together.
    text: "没能确认保存结果，请到桌面或待同步列表核对后再操作。"
  };
  const PANEL_JOB_STALE = "网页已经换成别的页面，刚才的岗位内容已作废。请重新点「保存岗位到桌面端」。";
  const PANEL_JOB_EXPIRED = "这次保存的页面已经变化或已被取消，结果已过期。请到桌面端确认这个岗位是否已保存。";
  let panelJobWriteTimeoutMs = 30000;

  async function waitForPanelJobWrite(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ status: "unknown" }), panelJobWriteTimeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Cancelling is best effort: a worker that is not there has nothing to cancel.
  function cancelAiRequest(requestId) {
    if (!requestId) return;
    try { Promise.resolve(self.ResumeProAIClient?.cancel?.(requestId)).catch(() => {}); } catch {}
  }
  let panelJob = idlePanelJob(null);

  // Every reset takes a new token, so an answer still on its way for the old draft is dropped.
  function idlePanelJob(previous) {
    return {
      draftId: null, phase: "idle", version: (previous?.version || 0) + 1, token: (previous?.token || 0) + 1,
      fields: null, revision: 0, note: "", openView: null, error: "", assist: null, requestId: null,
      fallback: null, confirmed: null, intentId: null, candidates: [], result: null,
      pageUrl: "", discarded: null
    };
  }

  function touchPanelJob(changes) {
    Object.assign(panelJob, changes, { version: panelJob.version + 1 });
  }

  // What the side panel may see. The dedupe URL and the pending intent id stay in the page.
  function panelJobSnapshot() {
    const job = panelJob;
    return {
      draftId: job.draftId,
      phase: job.phase,
      version: job.version,
      revision: job.revision,
      fields: job.fields ? {
        company: job.fields.company || "", title: job.fields.title || "",
        location: job.fields.location || "", sourceUrl: job.fields.sourceUrl || ""
      } : null,
      note: job.note,
      openView: job.openView,
      error: job.error,
      assist: job.assist ? { count: job.assist.lines.length, text: job.assist.text, lines: [...job.assist.lines] } : null,
      candidates: job.candidates.map(candidate => ({
        applicationId: candidate.applicationId,
        label: candidate.label || `${candidate.company} · ${candidate.title}`
      })),
      result: job.result ? { ...job.result } : null,
      discarded: job.discarded
    };
  }

  // A single-page site can swap the job under an open draft without reloading the page. The
  // draft belongs to the address it was read from; once that changes it is thrown away, so
  // the panel can never save the old company and title for the new page.
  function dropStalePanelJob() {
    if (!panelJob.draftId || panelJob.pageUrl === location.href) return false;
    // A completed result is a fact about the write that already happened. Keep that fact on
    // screen after navigation, but an old duplicate warning must not offer "save again" for
    // the previous page.
    if (panelJob.phase === "result") {
      if (panelJob.result?.offerForce) {
        touchPanelJob({
          result: {
            ...panelJob.result,
            offerForce: false,
            hint: "网页已经切换；上面的结果仍然有效，但不能为上一页的岗位再存一次。"
          }
        });
      }
      return false;
    }
    const open = ["extracting", "assist", "review", "choice"].includes(panelJob.phase);
    if (!open) return false;
    cancelAiRequest(panelJob.requestId);
    panelJob = idlePanelJob(panelJob);
    panelJob.discarded = "page-changed";
    return true;
  }

  function openPanelReview(fields, note, openView = null) {
    touchPanelJob({
      phase: "review", fields: { ...emptyJobFields(), ...fields }, revision: panelJob.revision + 1,
      note, openView, error: "", assist: null, requestId: null
    });
  }

  async function startPanelJobDraft() {
    dropStalePanelJob();
    if (panelJob.draftId && panelJob.phase !== "idle" && panelJob.phase !== "result") return panelJobSnapshot();
    // The two questions are never open together (§172): "确认已投递" owns the area until the
    // user finishes it. `savePanelSubmitJob` clears its own phase to "cancelled" before
    // calling here, so that hand-off is not blocked by this guard.
    if (panelSubmitIsActive()) return panelJobSnapshot();
    panelJob = idlePanelJob(panelJob);
    const token = panelJob.token;
    const pageUrl = location.href;
    touchPanelJob({ draftId: newRequestId(), phase: "extracting", pageUrl });
    const isCurrent = () => panelJob.token === token && panelJob.pageUrl === pageUrl && location.href === pageUrl;
    try {
      const draft = await draftJobFields({
        isCurrent,
        onAssistStart: (described, requestId, fallback) => {
          if (!isCurrent()) return;
          touchPanelJob({
            phase: "assist", requestId, fallback,
            assist: { text: described.text, lines: [...(described.fragments || [])] }
          });
        },
        onAssistEnd: requestId => {
          if (isCurrent() && panelJob.requestId === requestId) touchPanelJob({ requestId: null });
        }
      });
      if (draft && isCurrent()) {
        openPanelReview(draft.fields, draft.note, draft.openView);
      } else if (panelJob.token === token && location.href !== pageUrl) {
        dropStalePanelJob();
      }
    } catch {
      if (isCurrent()) {
        openPanelReview(emptyJobFields(), "读取页面信息失败，请手动填写公司和岗位。");
      } else if (panelJob.token === token && location.href !== pageUrl) {
        dropStalePanelJob();
      }
    }
    return panelJobSnapshot();
  }

  async function cancelPanelJob({ draftId, scope }) {
    if (!draftId || draftId !== panelJob.draftId) return { ok: false, error: "这次保存已经结束了。", jobSave: panelJobSnapshot() };
    if (panelJob.phase === "saving") return { ok: false, error: "已经在写入桌面，无法取消。", jobSave: panelJobSnapshot() };
    cancelAiRequest(panelJob.requestId);
    if (scope === "assist") {
      if (panelJob.phase !== "assist" && panelJob.phase !== "extracting") {
        return { ok: false, error: "识别已经结束了。", jobSave: panelJobSnapshot() };
      }
      // A new token: whatever the AI says later belongs to a recognition nobody is waiting for.
      const fallback = panelJob.fallback || emptyJobFields();
      touchPanelJob({ token: panelJob.token + 1 });
      let note = "已取消识别。请手动补全后再保存。";
      try { note = (await loadDesktopModules()).copy.describeManualSave("cancelled"); } catch {}
      openPanelReview(fallback, note);
      return { ok: true, jobSave: panelJobSnapshot() };
    }
    // Cancelling the draft itself: nothing was written, and nothing will be.
    panelJob = idlePanelJob(panelJob);
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  async function confirmPanelJob(message) {
    if (!message.draftId || message.draftId !== panelJob.draftId) {
      return { ok: false, error: "这份岗位草稿已经失效，请重新点「保存岗位到桌面端」。", jobSave: panelJobSnapshot() };
    }
    if (dropStalePanelJob()) return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    if (panelJob.phase === "saving" || saveInFlight) return { ok: false, error: "正在保存，请稍候。", jobSave: panelJobSnapshot() };
    // "再存一次" after a duplicate resends exactly what was confirmed; anything else needs the form.
    const again = message.force === true && panelJob.phase === "result" && panelJob.result?.offerForce && panelJob.confirmed;
    if (!again && panelJob.phase !== "review") return { ok: false, error: "请先核对岗位信息。", jobSave: panelJobSnapshot() };

    const fields = again ? panelJob.confirmed : reviewedJobFields(panelJob.fields, message);
    if (!again) {
      const missing = [!fields.company && "公司名称", !fields.title && "岗位名称"].filter(Boolean);
      if (missing.length) {
        const error = `请补全${missing.join("和")}后再保存。`;
        touchPanelJob({
          error,
          fields: { ...panelJob.fields, company: fields.company, title: fields.title, location: fields.location }
        });
        return { ok: false, error, missing, jobSave: panelJobSnapshot() };
      }
    }
    // Claimed before the first await, so a second click cannot send a second write.
    const token = panelJob.token;
    saveInFlight = true;
    touchPanelJob({
      phase: "saving", confirmed: fields, error: "",
      fields: { ...panelJob.fields, company: fields.company, title: fields.title, location: fields.location }
    });
    let result = null;
    let failed = false;
    try {
      // Only "save again" after a duplicate warning may skip the duplicate check; a "force"
      // sent with an ordinary confirm is ignored.
      result = await waitForPanelJobWrite(saveReviewedJob(fields, { force: Boolean(again) }));
    } catch {
      failed = true;
    } finally {
      saveInFlight = false;
    }
    if (panelJob.token !== token) {
      refreshPendingList();
      return { ok: false, expired: true, error: PANEL_JOB_EXPIRED, jobSave: panelJobSnapshot() };
    }
    // Whatever goes wrong from here on, the phase must leave "saving": the desktop may
    // already hold the job, so the panel says it could not tell rather than stay locked.
    try {
      if (failed) throw new Error("save-failed");
      if (result?.status === "unknown") {
        touchPanelJob({ phase: "result", candidates: [], error: "", result: { ...PANEL_JOB_UNKNOWN } });
      } else {
        const { copy } = await loadDesktopModules();
        if (result?.status === "needs_choice") {
        // The desktop sends its stage code ("saved"); the label uses the same Chinese name
        // "确认已投递" shows, so the two lists never read differently for one application.
        const candidates = (result.exact || []).map(candidate => ({ ...candidate, label: copy.describeApplicationChoice(candidate) }));
        touchPanelJob({ phase: "choice", intentId: result.intent?.intentId || null, candidates, result: null });
        } else if (saveResultClosesForm(result) || result?.status === "not_queued") {
          // Written, queued, or a clear "no desktop / not paired" answer the user has to act on.
          touchPanelJob({ phase: "result", result: describeCommit(copy, result) });
        } else {
          // Not written and not queued: keep the reviewed form so the user can try again.
          touchPanelJob({ phase: "review", error: describeCommit(copy, result).text, result: null });
        }
      }
    } catch {
      if (panelJob.token === token) touchPanelJob({ phase: "result", candidates: [], error: "", result: { ...PANEL_JOB_UNKNOWN } });
    }
    refreshPendingList();
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  // "AI 重新识别": the local read looked fine but the user says it is wrong. Same AI step as
  // the first recognition, same progress and cancel. What the user has typed is the
  // fallback: a failed, cancelled or unsure AI leaves it exactly as it was, and nothing is
  // saved until the user confirms again.
  async function reassistPanelJob(message) {
    if (!message.draftId || message.draftId !== panelJob.draftId) {
      return { ok: false, error: "这份岗位草稿已经失效，请重新点「保存岗位到桌面端」。", jobSave: panelJobSnapshot() };
    }
    if (dropStalePanelJob()) return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    if (panelJob.phase !== "review" || saveInFlight) {
      return { ok: false, error: "现在不能重新识别，请稍后再试。", jobSave: panelJobSnapshot() };
    }
    const pageUrl = panelJob.pageUrl;
    let modules;
    try {
      modules = await loadDesktopModules();
    } catch {
      return { ok: false, error: "暂时无法重新识别，请稍后再试。", jobSave: panelJobSnapshot() };
    }
    if (message.draftId !== panelJob.draftId || panelJob.phase !== "review") {
      return { ok: false, error: "这份岗位草稿已经变化，请重新操作。", jobSave: panelJobSnapshot() };
    }
    if (panelJob.pageUrl !== pageUrl || location.href !== pageUrl) {
      dropStalePanelJob();
      return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    }
    const { extract, saveFlow, copy } = modules;
    const extraction = extract.extractJobFields(document, location.href);
    const fragments = saveFlow.allowFragments(extraction.fragments);
    if (!fragments.length) {
      const error = "这个页面没有可交给 AI 识别的岗位文字，请直接修改后保存。";
      touchPanelJob({ error });
      return { ok: false, error, jobSave: panelJobSnapshot() };
    }
    const typed = reviewedJobFields(panelJob.fields, message);
    const fallback = {
      company: typed.company, title: typed.title, location: typed.location,
      sourceUrl: typeof extraction.sourceUrl === "string" ? extraction.sourceUrl : typed.sourceUrl,
      dedupeUrl: typeof extraction.dedupeUrl === "string" ? extraction.dedupeUrl : typed.dedupeUrl
    };
    // A new token: an answer to an earlier recognition of this draft is dropped.
    touchPanelJob({
      token: panelJob.token + 1, phase: "assist", fields: { ...fallback }, fallback, error: "", note: "",
      openView: null, requestId: null, assist: { text: "", lines: [] }, pageUrl
    });
    const token = panelJob.token;
    const isCurrent = () => panelJob.token === token && panelJob.pageUrl === pageUrl && location.href === pageUrl;
    try {
      const outcome = await runJobAssist(fragments, fallback, {
        isCurrent,
        onAssistStart: (described, requestId, fb) => {
          if (!isCurrent()) return;
          touchPanelJob({ requestId, fallback: fb, assist: { text: described.text, lines: [...(described.fragments || [])] } });
        },
        onAssistEnd: requestId => {
          if (isCurrent() && panelJob.requestId === requestId) touchPanelJob({ requestId: null });
        }
      });
      if (!isCurrent() || outcome.action === "ignore") {
        if (panelJob.token === token && location.href !== pageUrl) {
          dropStalePanelJob();
          return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
        }
        return { ok: true, jobSave: panelJobSnapshot() };
      }
      if (outcome.action === "commit") {
        openPanelReview(outcome.fields, copy.describeReviewSave());
      } else {
        // Not sure, failed or timed out: keep what the user has, only filling what is blank.
        const suggested = outcome.fields || {};
        openPanelReview({
          company: fallback.company || suggested.company || "",
          title: fallback.title || suggested.title || "",
          location: fallback.location || suggested.location || "",
          sourceUrl: fallback.sourceUrl, dedupeUrl: fallback.dedupeUrl
        }, outcome.note, outcome.openView || null);
      }
    } catch {
      if (isCurrent()) openPanelReview(fallback, "重新识别没有完成，已保留你现在的内容，可以手动修改后保存。");
    }
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  async function choosePanelJob(message) {
    if (message.draftId && message.draftId === panelJob.draftId && dropStalePanelJob()) {
      return { ok: false, error: PANEL_JOB_STALE, jobSave: panelJobSnapshot() };
    }
    if (!message.draftId || message.draftId !== panelJob.draftId || panelJob.phase !== "choice") {
      return { ok: false, error: "这个选择已经失效了。", jobSave: panelJobSnapshot() };
    }
    if (saveInFlight) return { ok: false, error: "正在保存，请稍候。", jobSave: panelJobSnapshot() };
    const action = String(message.action || "");
    if (action === "later") {
      touchPanelJob({ phase: "result", candidates: [], result: { tone: "pending", text: PANEL_JOB_LATER } });
      return { ok: true, jobSave: panelJobSnapshot() };
    }
    let applicationId = null;
    if (action === "existing") {
      applicationId = panelJob.candidates.find(candidate => candidate.applicationId === message.applicationId)?.applicationId || null;
      if (!applicationId) return { ok: false, error: "请选择列表里的已有岗位。", jobSave: panelJobSnapshot() };
    } else if (action !== "new") {
      return { ok: false, error: "当前操作不可用。", jobSave: panelJobSnapshot() };
    }
    const token = panelJob.token;
    saveInFlight = true;
    touchPanelJob({ phase: "saving" });
    let bound;
    try {
      const result = await waitForPanelJobWrite(bindSavedJob(panelJob.intentId, applicationId));
      if (panelJob.token !== token) {
        refreshPendingList();
        return { ok: false, expired: true, error: PANEL_JOB_EXPIRED, jobSave: panelJobSnapshot() };
      }
      bound = result?.status === "unknown"
        ? { ...PANEL_JOB_UNKNOWN }
        : (await loadDesktopModules()).copy.describeBindResult(result);
    } catch {
      bound = { ...PANEL_JOB_UNKNOWN };
    } finally {
      saveInFlight = false;
    }
    if (panelJob.token === token) touchPanelJob({ phase: "result", candidates: [], result: bound });
    refreshPendingList();
    return { ok: true, jobSave: panelJobSnapshot() };
  }

  // --- Confirming a submission from the native side panel (#172) -------------------------
  //
  // "确认已投递" only moves an application's stage on the desktop: the user says they already
  // applied on the job site. Nothing here clicks, submits or listens to the site's controls.
  //
  //   idle -> extracting -> assist -> review -> querying -> choosing -> confirming
  //        -> confirmed | empty | unavailable | unknown | failed | cancelled
  //
  // Step one (extracting/assist) only reads the page and, when it is unsure, asks the
  // desktop's AI — exactly draftJobFields(), the same step "保存岗位到桌面端" uses. It always
  // lands on an editable review; nothing is queried yet, so a wrong local read ("公安" instead
  // of "金发科技") is never sent to the desktop. Only "查找对应申请" (querying) leaves the page,
  // and only with what the user confirmed on the review form.
  //
  // The state is this page's (one page controller per tab) and is bound to the address it
  // was started on, a token that any cancel, restart or page change replaces, and the list of
  // candidates the desktop offered. The panel can only pick from that list.

  const SUBMIT_STALE = "网页已经换成别的页面，刚才核对的内容已作废。请重新点「确认已投递」。";
  const SUBMIT_EMPTY = "桌面里还没有这家公司的投递记录。";
  // Every phase between clicking "确认已投递" and a final answer, except "confirming": a
  // write already on its way to the desktop is never yanked out from under itself by a page
  // change, same rule as saving a job. "confirmed" is a fact about the desktop and also stays.
  const SUBMIT_DROPPABLE_PHASES = [
    "extracting", "assist", "review", "querying", "choosing", "empty", "unavailable", "failed", "unknown"
  ];
  const SUBMIT_BACK_PHASES = ["choosing", "empty", "unavailable", "failed", "unknown"];
  const PANEL_SUBMIT_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let panelSubmit = idlePanelSubmit(null);

  function idlePanelSubmit(previous) {
    return {
      confirmId: null, phase: "idle", version: (previous?.version || 0) + 1, token: (previous?.token || 0) + 1,
      pageUrl: "", fields: null, revision: 0, note: "", openView: null, error: "", assist: null, requestId: null,
      fallback: null, candidates: [], reason: "", result: null, discarded: null
    };
  }

  function touchPanelSubmit(changes) {
    Object.assign(panelSubmit, changes, { version: panelSubmit.version + 1 });
  }

  // What the side panel may see: the editable draft (never the page's raw text beyond what
  // the user already typed), AI progress, and labels/ids of the offered applications.
  function panelSubmitSnapshot() {
    const job = panelSubmit;
    return {
      // Names this page load, so a snapshot from before a reload is never compared by version.
      epoch: PANEL_SUBMIT_EPOCH,
      confirmId: job.confirmId,
      phase: job.phase,
      version: job.version,
      revision: job.revision,
      fields: job.fields
        ? { company: job.fields.company || "", title: job.fields.title || "", sourceUrl: job.fields.sourceUrl || "" }
        : null,
      note: job.note,
      openView: job.openView,
      error: job.error,
      reason: job.reason,
      assist: job.assist ? { count: job.assist.lines.length, text: job.assist.text, lines: [...job.assist.lines] } : null,
      candidates: job.candidates.map(candidate => ({ applicationId: candidate.applicationId, label: candidate.label })),
      result: job.result ? { ...job.result } : null,
      discarded: job.discarded
    };
  }

  function panelJobIsActive() {
    return ["extracting", "assist", "review", "saving", "choice"].includes(panelJob.phase);
  }

  function panelSubmitIsActive() {
    return SUBMIT_DROPPABLE_PHASES.includes(panelSubmit.phase) || panelSubmit.phase === "confirming";
  }

  // A single-page site can swap the job under an open question. The draft and candidates
  // belong to the address they were read from; once it changes they are thrown away. A
  // write already sent (confirming) and a finished result (confirmed) are facts and stay.
  function dropStalePanelSubmit() {
    if (!panelSubmit.confirmId || panelSubmit.pageUrl === location.href) return false;
    if (!SUBMIT_DROPPABLE_PHASES.includes(panelSubmit.phase)) return false;
    cancelAiRequest(panelSubmit.requestId);
    panelSubmit = idlePanelSubmit(panelSubmit);
    panelSubmit.discarded = "page-changed";
    return true;
  }

  const submitOutcome = (extra = {}) => ({ ...extra, submitConfirm: panelSubmitSnapshot() });

  function openSubmitReview(fields, note, openView = null) {
    touchPanelSubmit({
      phase: "review", fields: { company: "", title: "", sourceUrl: "", ...fields },
      revision: panelSubmit.revision + 1, note, openView, error: "", assist: null, requestId: null
    });
  }

  // Step one, shared with "保存岗位到桌面端" (draftJobFields): read the page, ask the
  // desktop's AI only when extraction is unsure, and land on an editable review. Nothing
  // leaves the page here and nothing is written; a query only happens from "查找对应申请".
  async function startPanelSubmit() {
    dropStalePanelSubmit();
    if (panelSubmitIsActive()) return submitOutcome({ ok: true });
    if (panelJobIsActive()) {
      return submitOutcome({ ok: false, error: "请先完成或取消正在进行的岗位保存。" });
    }
    panelSubmit = idlePanelSubmit(panelSubmit);
    const token = panelSubmit.token;
    const pageUrl = location.href;
    touchPanelSubmit({ confirmId: newRequestId(), phase: "extracting", pageUrl });
    const isCurrent = () => panelSubmit.token === token && panelSubmit.pageUrl === pageUrl && location.href === pageUrl;
    try {
      const draft = await draftJobFields({
        isCurrent,
        onAssistStart: (described, requestId, fallback) => {
          if (!isCurrent()) return;
          touchPanelSubmit({
            phase: "assist", requestId, fallback,
            assist: { text: described.text, lines: [...(described.fragments || [])] }
          });
        },
        onAssistEnd: requestId => {
          if (isCurrent() && panelSubmit.requestId === requestId) touchPanelSubmit({ requestId: null });
        }
      });
      if (draft && isCurrent()) {
        openSubmitReview(draft.fields, draft.note, draft.openView);
      } else if (panelSubmit.token === token && location.href !== pageUrl) {
        dropStalePanelSubmit();
      }
    } catch {
      if (isCurrent()) {
        openSubmitReview(emptyJobFields(), "读取页面信息失败，请手动填写公司和岗位。");
      } else if (panelSubmit.token === token && location.href !== pageUrl) {
        dropStalePanelSubmit();
      }
    }
    return submitOutcome({ ok: true });
  }

  // Step two: only now does anything leave the page. `company`/`title` are the user's
  // reviewed text, whatever they are after "公安" became "金发科技"; the address is always
  // the draft's own redacted one, never something the panel message could substitute.
  async function queryPanelSubmit(message) {
    if (!message.confirmId || message.confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这份核对内容已经失效，请重新点「确认已投递」。" });
    }
    if (dropStalePanelSubmit()) return submitOutcome({ ok: false, error: SUBMIT_STALE });
    if (panelSubmit.phase !== "review") {
      return submitOutcome({ ok: false, error: "请先核对公司和岗位。" });
    }
    const company = typeof message.company === "string" ? message.company.trim() : "";
    const title = typeof message.title === "string" ? message.title.trim() : "";
    const sourceUrl = typeof panelSubmit.fields?.sourceUrl === "string" ? panelSubmit.fields.sourceUrl : "";
    if (!company || !title) {
      const missing = [!company && "公司名称", !title && "岗位名称"].filter(Boolean).join("和");
      const error = `请补全${missing}后再查找。`;
      touchPanelSubmit({ error, fields: { ...panelSubmit.fields, company, title } });
      return submitOutcome({ ok: false, error, missing });
    }
    const token = panelSubmit.token;
    const pageUrl = panelSubmit.pageUrl;
    // Only company/title change; the draft's own location and redacted URLs stay, so a later
    // "保存岗位到桌面端" can start from exactly what the user reviewed here.
    touchPanelSubmit({ phase: "querying", error: "", fields: { ...panelSubmit.fields, company, title, sourceUrl } });
    const asked = { company, title, sourceUrl };
    let answer;
    try {
      answer = await waitForPanelJobWrite(chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES_FOR", fields: asked }));
    } catch {
      answer = null;
    }
    if (panelSubmit.token !== token) {
      return submitOutcome({ ok: false, expired: true, error: SUBMIT_STALE });
    }
    if (location.href !== pageUrl) {
      dropStalePanelSubmit();
      return submitOutcome({ ok: false, error: SUBMIT_STALE });
    }
    try {
      const { copy } = await loadDesktopModules();
      if (answer?.status !== "ok") {
        // No reply is not "no candidates": an empty list would push the user into saving a duplicate.
        touchPanelSubmit({
          phase: "unavailable", candidates: [],
          result: copy.describeConfirmBlocked(confirmBlockedMode(answer?.status), { extensionId: chrome.runtime.id })
        });
        return submitOutcome({ ok: true });
      }
      const seen = new Set();
      const options = [...(answer.exact || []), ...(answer.sameCompany || [])].filter(candidate => {
        if (!candidate || typeof candidate.applicationId !== "string" || !candidate.applicationId) return false;
        if (typeof candidate.company !== "string" || typeof candidate.title !== "string") return false;
        if (seen.has(candidate.applicationId)) return false;
        seen.add(candidate.applicationId);
        return true;
      }).map(candidate => ({
        applicationId: candidate.applicationId, company: candidate.company, title: candidate.title,
        label: copy.describeApplicationChoice(candidate)
      }));
      if (!options.length) {
        touchPanelSubmit({ phase: "empty", reason: "no-record", candidates: [], result: { tone: "info", text: SUBMIT_EMPTY } });
      } else {
        // Even one candidate waits for the user: the plugin never picks an application.
        touchPanelSubmit({ phase: "choosing", candidates: options });
      }
    } catch {
      touchPanelSubmit({
        phase: "failed", candidates: [],
        result: { tone: "warn", text: "没能查到对应的投递记录，这次没有确认投递。请稍后再试。" }
      });
    }
    return submitOutcome({ ok: true });
  }

  async function choosePanelSubmit(message) {
    const stale = () => submitOutcome({ ok: false, error: SUBMIT_STALE });
    if (message.confirmId && message.confirmId === panelSubmit.confirmId && dropStalePanelSubmit()) return stale();
    if (!message.confirmId || message.confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这个选择已经失效了，请重新点「确认已投递」。" });
    }
    // Claimed synchronously, so a second click can never send a second confirmation.
    if (panelSubmit.phase === "confirming") return submitOutcome({ ok: false, error: "正在确认，请稍候。" });
    if (panelSubmit.phase !== "choosing") return submitOutcome({ ok: false, error: "这个选择已经失效了，请重新点「确认已投递」。" });
    const candidate = panelSubmit.candidates.find(item => item.applicationId === message.applicationId);
    if (!candidate) return submitOutcome({ ok: false, error: "请选择列表里的申请。" });

    const token = panelSubmit.token;
    touchPanelSubmit({ phase: "confirming", result: null });
    let result = null;
    try {
      result = await waitForPanelJobWrite(chrome.runtime.sendMessage({
        type: "DESKTOP_CONFIRM_SUBMIT", applicationId: candidate.applicationId
      }));
    } catch {
      // The request may have reached the desktop before the port failed: not a failure to retry.
      result = { status: "unknown" };
    }
    if (panelSubmit.token !== token) {
      refreshPendingList();
      return submitOutcome({ ok: false, expired: true, error: "这次确认已经过期，请到桌面端查看这条申请的当前状态。" });
    }
    let described;
    let phase;
    try {
      const { copy } = await loadDesktopModules();
      const status = result?.status;
      described = copy.describeConfirmResult(result ?? { status: "unknown" });
      if (status === "saved") {
        // Only a persisted reply gets to say "已确认投递".
        phase = "confirmed";
        described = {
          tone: "success", text: `已确认投递：${candidate.company} · ${candidate.title}`,
          hint: "只更新了桌面上的申请阶段，没有提交招聘网站上的申请。"
        };
      } else if (!status || status === "unknown") {
        phase = "unknown";
      } else if (status === "failed" || status === "rejected") {
        phase = "failed";
      } else {
        phase = "unavailable";
      }
    } catch {
      phase = "unknown";
      described = { tone: "pending", text: "没能确认结果，请到桌面端查看这条申请的当前状态。" };
    }
    if (panelSubmit.token === token) touchPanelSubmit({ phase, candidates: [], result: described });
    refreshPendingList();
    return submitOutcome({ ok: true });
  }

  // "返回修改": go back to the editable review with what is already there. No re-extraction,
  // no new AI request, nothing sent to the desktop — the company/title the user last typed
  // (or the candidates/result screen showed) are exactly what the review form gets back.
  function backPanelSubmit({ confirmId }) {
    if (!confirmId || confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这次确认已经结束了。" });
    }
    if (dropStalePanelSubmit()) return submitOutcome({ ok: false, error: SUBMIT_STALE });
    if (!SUBMIT_BACK_PHASES.includes(panelSubmit.phase)) {
      return submitOutcome({ ok: false, error: "现在无法返回修改。" });
    }
    touchPanelSubmit({ phase: "review", revision: panelSubmit.revision + 1, candidates: [], result: null, error: "" });
    return submitOutcome({ ok: true });
  }

  function cancelPanelSubmit({ confirmId, scope }) {
    if (!confirmId || confirmId !== panelSubmit.confirmId) {
      return submitOutcome({ ok: false, error: "这次确认已经结束了。" });
    }
    if (panelSubmit.phase === "confirming") {
      return submitOutcome({ ok: false, error: "已经在确认了，无法取消。请到桌面端查看这条申请的当前状态。" });
    }
    if (scope === "assist") {
      // The one button covers three waits: recognizing the page, and looking the company up
      // on the desktop. None of them has anything left to do once cancelled but go back to
      // an editable review — "abandon the whole attempt" is the other button's job.
      if (!["extracting", "assist", "querying"].includes(panelSubmit.phase)) {
        return submitOutcome({ ok: false, error: "识别已经结束了。" });
      }
      cancelAiRequest(panelSubmit.requestId);
      if (panelSubmit.phase === "querying") {
        // Nothing to re-run here, just the fields the user had reviewed before the query.
        const fields = panelSubmit.fields || emptyJobFields();
        touchPanelSubmit({ token: panelSubmit.token + 1 });
        openSubmitReview(fields, "");
        return submitOutcome({ ok: true });
      }
      // A new token: whatever the AI says later belongs to a recognition nobody is waiting for.
      const fallback = panelSubmit.fallback || emptyJobFields();
      touchPanelSubmit({ token: panelSubmit.token + 1 });
      openSubmitReview(fallback, "已取消识别。请手动补全后再查找。");
      return submitOutcome({ ok: true });
    }
    if (SUBMIT_DROPPABLE_PHASES.includes(panelSubmit.phase)) {
      // A new token: an AI reply or a candidate list still on its way belongs to a question
      // nobody is asking any more.
      cancelAiRequest(panelSubmit.requestId);
      panelSubmit = idlePanelSubmit(panelSubmit);
      panelSubmit.phase = "cancelled";
      return submitOutcome({ ok: true });
    }
    // A finished result being dismissed.
    panelSubmit = idlePanelSubmit(panelSubmit);
    return submitOutcome({ ok: true });
  }

  // "桌面里还没有这家公司的投递记录 → 保存岗位到桌面端": hands over to the review flow.
  // Nothing is created here, and the application still has to be chosen afterwards.
  async function savePanelSubmitJob({ confirmId }) {
    if (!confirmId || confirmId !== panelSubmit.confirmId) {
      return { ok: false, error: "这次确认已经结束了。", jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    if (dropStalePanelSubmit()) return { ok: false, error: SUBMIT_STALE, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    if (panelSubmit.phase !== "empty") {
      return { ok: false, error: "现在不能保存岗位。", jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    // The save form opens with what the user already reviewed and corrected here ("公安" →
    // "金发科技"), not with a fresh read of the page: re-reading would bring the wrong
    // company back (or ask the AI again), and the user would have to fix it a second time.
    const reviewed = { ...emptyJobFields(), ...panelSubmit.fields };
    const pageUrl = panelSubmit.pageUrl;
    panelSubmit = idlePanelSubmit(panelSubmit);
    panelSubmit.phase = "cancelled";
    if (panelJob.draftId && panelJob.phase !== "idle" && panelJob.phase !== "result") {
      return { ok: true, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    let note = "可直接修改，确认后才会写入桌面。";
    try { note = (await loadDesktopModules()).copy.describeReviewSave(); } catch {}
    if (location.href !== pageUrl) {
      return { ok: false, error: SUBMIT_STALE, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
    }
    panelJob = idlePanelJob(panelJob);
    touchPanelJob({ draftId: newRequestId(), pageUrl });
    openPanelReview(reviewed, note);
    return { ok: true, jobSave: panelJobSnapshot(), submitConfirm: panelSubmitSnapshot() };
  }

  function setDesktopStatus(copy) {
    const box = shadowRoot?.querySelector("#resume-pro-desktop-status");
    if (!box) return;
    box.textContent = "";
    box.className = "resume-pro__desktop-status";
    if (!copy) return;

    box.classList.add(`is-${copy.tone}`);
    const line = document.createElement("p");
    line.textContent = copy.text;
    box.appendChild(line);

    if (copy.extensionId) {
      const id = document.createElement("code");
      id.className = "resume-pro__extension-id";
      id.textContent = copy.extensionId;
      box.appendChild(id);
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "resume-pro__manager-button";
      copyButton.textContent = "复制扩展 ID";
      copyButton.addEventListener("click", () => copyText(copy.extensionId));
      box.appendChild(copyButton);
    }

    if (copy.hint) {
      const hint = document.createElement("p");
      hint.className = "resume-pro__save-note";
      hint.textContent = copy.hint;
      box.appendChild(hint);
    }

    if (copy.offerForce && lastSubmittedFields) {
      const confirmed = lastSubmittedFields;
      const again = document.createElement("button");
      again.type = "button";
      again.className = "resume-pro__manager-button";
      again.textContent = "再存一次";
      again.addEventListener("click", () => submitSaveForm({ force: true, fields: confirmed }));
      box.appendChild(again);
    }
  }

  async function refreshPendingList() {
    const details = shadowRoot?.querySelector("#resume-pro-pending");
    const list = shadowRoot?.querySelector("#resume-pro-pending-list");
    if (!details || !list) return;

    let intents = [];
    let outbox = [];
    let fillRecords = [];
    let expired = new Set();
    let copy;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "DESKTOP_LIST_QUEUE" });
      intents = reply?.intents || [];
      outbox = reply?.outbox || [];
      fillRecords = reply?.fillRecords || [];
      expired = new Set(reply?.expiredSnapshots || []);
      ({ copy } = await loadDesktopModules());
    } catch {
      return;
    }

    const total = intents.length + outbox.length + fillRecords.length;
    details.hidden = total === 0;
    shadowRoot.querySelector("#resume-pro-pending-count").textContent = String(total);
    list.textContent = "";

    for (const intent of intents) {
      const row = pendingRow(
        `${intent.fields.company} · ${intent.fields.title}`,
        intent.fields.sourceUrl,
        intent.status === "pending_bind" ? "待绑定申请" : "待同步（尚未绑定申请）"
      );
      row.appendChild(rowButton("完成保存", () => continueIntent(intent.intentId)));
      row.appendChild(rowButton("删除", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_INTENT", intentId: intent.intentId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }

    for (const record of fillRecords) {
      const row = pendingRow(
        `填写留档 · ${record.fill?.templateName || ""}`,
        [record.job?.company, record.job?.title].filter(Boolean).join(" · "),
        "待同步（尚未选择申请）"
      );
      if (record.snapshot && expired.has(record.snapshot.snapshotId)) {
        appendNote(row, "附带的简历快照已暂存超过 30 天，要继续还是丢弃？");
        row.appendChild(rowButton("丢弃快照", () => dropSnapshot(record.snapshot.snapshotId)));
      }
      row.appendChild(rowButton("选择申请", () => chooseFillApplication(record)));
      row.appendChild(rowButton("删除", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_FILL", recordId: record.recordId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }

    for (const entry of outbox.filter(item => item.messageType === "snapshot.upload")) {
      const state = copy.describeSnapshotUpload(entry, { expired: expired.has(entry.snapshotId) });
      const row = pendingRow(`简历快照 · ${entry.payload?.templateName || ""}`, "", state.text);
      if (entry.status === "paused" || entry.status === "needs_user") {
        // After a restore the only ways out are the user's: upload the kept original again
        // under a new identity, or let it go. Never a plain retry of the old chunks.
        appendNote(row, copy.describeSnapshotReconcile(entry.reconcileStatus).text);
        row.appendChild(rowButton("重新上传到当前档案", () => resolvePaused(entry, "resave")));
        row.appendChild(rowButton("丢弃快照", () => resolvePaused(entry, "discard")));
        list.appendChild(row);
        continue;
      }
      if (state.retry) {
        row.appendChild(rowButton("立即重试", async () => {
          await chrome.runtime.sendMessage({ type: "DESKTOP_RETRY", messageId: entry.messageId });
          refreshPendingList();
        }));
      }
      row.appendChild(rowButton(entry.status === "bytes_lost" ? "移除" : "丢弃快照", () => dropSnapshot(entry.snapshotId)));
      list.appendChild(row);
    }

    for (const entry of outbox.filter(item => item.messageType !== "snapshot.upload")) {
      const row = pendingRow(queueLabel(entry), entry.payload?.sourceUrl, describeOutboxState(entry));
      if (entry.status === "needs_user" || entry.status === "paused") {
        appendReconcileChoices(row, entry);
        list.appendChild(row);
        continue;
      }
      row.appendChild(rowButton("立即重试", async () => {
        const { copy } = await loadDesktopModules();
        const result = await chrome.runtime.sendMessage({ type: "DESKTOP_RETRY", messageId: entry.messageId });
        setDesktopStatus(describeQueueResult(copy, entry, result ?? { status: "pending" }));
        refreshPendingList();
      }));
      row.appendChild(rowButton("取消", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_CANCEL", messageId: entry.messageId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }
  }

  function appendNote(row, text) {
    const note = document.createElement("em");
    note.textContent = text;
    row.appendChild(note);
  }

  // The fill record stays; only the snapshot copy and its upload go.
  async function dropSnapshot(snapshotId) {
    await chrome.runtime.sendMessage({ type: "DESKTOP_DROP_SNAPSHOT", snapshotId });
    refreshPendingList();
  }

  // Each kind of queued message has its own wording: a retried fill must not report that a
  // job was saved, nor a refused one ask the user to check a company name.
  function describeQueueResult(copy, entry, result) {
    if (entry.messageType === "fill.submit") return copy.describeFillRecordResult(result);
    if (entry.messageType === "snapshot.upload") return copy.describeSnapshotResolveResult(result);
    if (entry.messageType === "submit.confirm") return copy.describeConfirmResult(result);
    return copy.describeBindResult(result);
  }

  function queueLabel(entry) {
    if (entry.messageType === "fill.submit") return `填写留档 · ${entry.payload?.templateName || ""}`;
    if (entry.messageType === "submit.confirm") return "确认已投递";
    return `${entry.payload?.company || ""} · ${entry.payload?.title || ""}`;
  }

  function pendingRow(label, title, state) {
    const row = document.createElement("div");
    row.className = "resume-pro__pending-row";

    const name = document.createElement("span");
    name.textContent = label;
    name.title = title || "";
    row.appendChild(name);

    const status = document.createElement("em");
    status.textContent = state;
    row.appendChild(status);
    return row;
  }

  function rowButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "resume-pro__manager-button";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  // After a restore the queued envelope carries an epoch the desktop has replaced. There is
  // no "retry" here on purpose: the only ways out are the three the user chooses.
  function appendReconcileChoices(row, entry) {
    loadDesktopModules().then(({ copy }) => {
      const explain = copy.describeReconcileStatus(entry.reconcileStatus);
      const note = document.createElement("em");
      note.textContent = explain.text;
      row.appendChild(note);
    });

    row.appendChild(rowButton("关联到已有申请", async () => {
      const applicationId = prompt("要关联到哪条申请？请粘贴桌面里的申请 ID：");
      if (!applicationId) return;
      await resolvePaused(entry, "associate", applicationId.trim());
    }));
    row.appendChild(rowButton("另存为新的", () => resolvePaused(entry, "resave")));
    row.appendChild(rowButton("丢弃", () => resolvePaused(entry, "discard")));
  }

  async function resolvePaused(entry, choice, applicationId) {
    const { copy } = await loadDesktopModules();
    const result = await chrome.runtime.sendMessage({
      type: "DESKTOP_RESOLVE", messageId: entry.messageId, choice, applicationId
    });
    if (choice !== "discard") {
      // A resaved snapshot is queued, not yet on the desktop: described as pending.
      const shown = result?.status === "queued" ? { status: "pending" } : (result ?? { status: "pending" });
      setDesktopStatus(describeQueueResult(copy, entry, shown));
    }
    refreshPendingList();
  }

  // The reason is the plugin's own classification, not the protocol text: the wording table
  // in link/copy.mjs is the only place that turns a code into a sentence.
  function describeOutboxState(entry) {
    if (entry.status === "paused") return "桌面换过档案库，已暂停";
    if (entry.status === "needs_user") return "桌面换过档案库，等你决定";
    if (entry.status === "failed") return `已停下，需要处理（${describeFailure(entry.lastError)}）`;
    if (entry.status === "stalled") return `重试多次仍未成功，等你决定（${describeFailure(entry.lastError)}）`;
    const next = entry.nextAttemptAt ? `，下次重试 ${formatClock(entry.nextAttemptAt)}` : "";
    return `待同步（已尝试 ${entry.attempts || 0} 次${next}）`;
  }

  function describeFailure(code) {
    if (code === "unavailable") return "桌面暂时不可用";
    if (code === "invalid_payload") return "桌面看不懂这条内容";
    if (code === "restore_epoch_mismatch") return "桌面换过档案库";
    if (code === "previously_purged") return "已在桌面永久删除";
    if (code === "conflict") return "与桌面已有记录冲突";
    return "原因未知";
  }

  function formatClock(iso) {
    const at = new Date(iso);
    return Number.isNaN(at.getTime())
      ? "稍后"
      : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  if (self.__RESUME_PRO_TEST__) {
    self.ResumeProHighlightTest = {
      applySidebarUiState,
      bindStorageSync,
      bindFocusTracking,
      describePanelTarget,
      readPanelChips,
      resolveTextSelection,
      isSensitiveTextTarget,
      constrainSidebarToViewport,
      persistSidebarUiState,
      readSidebarUiState,
      stopDrag,
      handleRepeatFillClick,
      handlePanelRepeat,
      describeRepeat,
      addUnansweredToProfile,
      formatFillDiagnostics,
      getHighlightTargets,
      handleAiFillClick,
      handleSaveJobClick,
      cancelJobAssist,
      submitSaveForm,
      describeCommit,
      presentSaveResult,
      draftJobFields,
      runJobAssist,
      reviewedJobFields,
      panelJobSnapshot,
      getSaveInteractionState() {
        return { extractInFlight, saveInFlight, extractToken };
      },
      setDesktopModules(modules) {
        desktopModules = modules;
      },
      offerFillRecord,
      handleRecordFillClick,
      panelFillSnapshot,
      getPendingFill() {
        return pendingFill;
      },
      setPanelFillWaitMs(ms) {
        panelFillWaitMs = ms;
      },
      setPanelJobWriteTimeoutMs(ms) {
        panelJobWriteTimeoutMs = ms;
      },
      handleChipAction,
      handleFieldChipClick,
      handlePanelFieldAction,
      refreshVisibleStore,
      highlightFilledField,
      injectFieldHighlightStyles,
      isInViewport,
      applyChipValue,
      composeChipText,
      syncChipSelectionState,
      setElementValue,
      operateControl,
      isSyncableTextControl,
      isSubmitTrigger,
      findSubmitTrigger,
      beginFillSession,
      endFillSession,
      recordFilledTextControl,
      finalSyncFillSession,
      getFillSession() {
        return fillSession;
      },
      fillSessionControls() {
        return fillSession ? Array.from(fillSession.controls.keys()) : [];
      },
      setSubmitCheckDelayMs(ms) {
        submitCheckDelayMs = ms;
      },
      setTextCommitWaitMs(ms) {
        textCommitWaitMs = ms;
      },
      textFillFailureReason(element) {
        const control = element?.kind === "element" ? element.element : element;
        return textFillFailures.get(control) || "";
      },
      setCurrentStore(store) {
        state.currentStore = store;
      },
      setAiBusy(busy) {
        state.aiBusy = Boolean(busy);
      },
      setNativeSidePanel(supported) {
        state.nativeSidePanel = Boolean(supported);
      },
      setProfileOffer({ candidates }) {
        state.profileOfferCandidates = candidates;
        state.profileOfferResult = null;
        state.profileOfferVersion += 1;
      },
      getProfileOfferVersion() {
        return state.profileOfferVersion;
      },
      panelProfileSnapshot,
      offerUnansweredFields,
      dismissProfileResult,
      setLastFocusedField(field) {
        state.lastFocusedField = field;
      },
      setDragging(dragging) {
        state.dragging = Boolean(dragging);
      },
      setSidebarUiState(uiState) {
        state.sidebarUiState = self.ResumeProSidebarState.normalize(uiState);
      },
      getSidebarUiState() {
        return self.ResumeProSidebarState.normalize(state.sidebarUiState);
      },
      setShadowRoot(root) {
        shadowRoot = root;
      }
    };
  }
})();
