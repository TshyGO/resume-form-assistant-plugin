(function () {
  const SIDEBAR_ID = "resume-pro-sidebar";
  const STORAGE_KEYS = ["templates", "activeTemplateId", "aiConfig"];
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
  let shadowRoot = null;
  const state = {
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragging: false,
    currentStore: null,
    statusTimer: null,
    lastFocusedField: null,
    managerVisible: false,
    chipAction: null
  };

  const StorageService = {
    async ensureDefaults() {
      const current = await chrome.storage.local.get(STORAGE_KEYS);
      const normalized = normalizeStore(current);

      if (JSON.stringify(current) !== JSON.stringify(normalized)) {
        await chrome.storage.local.set(normalized);
      }

      return normalized;
    },

    async getState() {
      const current = await chrome.storage.local.get(STORAGE_KEYS);
      return normalizeStore(current);
    },

    async setActiveTemplate(templateId) {
      await chrome.storage.local.set({ activeTemplateId: templateId });
    }
  };

  if (window.top !== window) {
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  async function init() {
    if (document.getElementById(SIDEBAR_ID)) {
      return;
    }

    state.currentStore = await StorageService.ensureDefaults();
    const cssText = await fetch(chrome.runtime.getURL("content.css")).then((r) => r.text());
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    injectFieldHighlightStyles();
    createSidebar(sheet);
    createManagerPanel();
    renderSidebar();
    bindStorageSync();
    bindFocusTracking();
  }

  function createSidebar(sheet) {
    const host = document.createElement("div");
    host.id = SIDEBAR_ID;
    Object.assign(host.style, {
      position: "fixed",
      top: "96px",
      right: "24px",
      zIndex: "2147483647"
    });

    document.body.appendChild(host);
    shadowRoot = host.attachShadow({ mode: "closed" });
    shadowRoot.adoptedStyleSheets = [sheet];

    const sidebar = document.createElement("aside");
    sidebar.className = "resume-pro";
    sidebar.innerHTML = `
      <div class="resume-pro__header" data-drag-handle="true">
        <div class="resume-pro__title-wrap">
          <p class="resume-pro__eyebrow">Resume Pro</p>
          <strong class="resume-pro__title">填表助手</strong>
        </div>
        <button class="resume-pro__collapse" type="button" aria-label="折叠助手">−</button>
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
        <div class="resume-pro__fill-record" id="resume-pro-fill-record" hidden>
          <p class="resume-pro__save-note" id="resume-pro-fill-record-summary"></p>
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
          <button class="resume-pro__manager-button" id="resume-pro-save-job" type="button">保存岗位到本地</button>
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
              <button class="resume-pro__ai-button" type="submit">确认保存</button>
              <button class="resume-pro__manager-button" type="button" id="resume-pro-save-cancel">取消</button>
            </div>
          </form>
          <div class="resume-pro__candidates" id="resume-pro-candidates" hidden>
            <p class="resume-pro__save-note" id="resume-pro-candidates-note"></p>
            <div class="resume-pro__candidate-list" id="resume-pro-candidate-list"></div>
            <div class="resume-pro__save-actions">
              <button class="resume-pro__ai-button" type="button" id="resume-pro-bind-new">新建一条申请</button>
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
          <button class="resume-pro__manager-button" id="resume-pro-open-manager" type="button">打开管理面板</button>
          <p class="resume-pro__footer-tip">管理面板会常驻在当前页面，点右上角 X 再关闭。</p>
        </div>
      </div>
    `;

    shadowRoot.appendChild(sidebar);
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

  function createManagerPanel() {
    const panel = document.createElement("div");
    panel.id = "resume-pro-manager";
    panel.className = "resume-pro-manager";
    panel.innerHTML = `
      <div class="resume-pro-manager__panel" role="dialog" aria-modal="false" aria-label="Resume Pro 管理面板">
        <div class="resume-pro-manager__header">
          <div>
            <div class="resume-pro-manager__eyebrow">Resume Pro</div>
            <div class="resume-pro-manager__title">管理面板</div>
          </div>
          <button class="resume-pro-manager__close" id="resume-pro-close-manager" type="button" aria-label="关闭管理面板">×</button>
        </div>
        <iframe
          class="resume-pro-manager__frame"
          data-src="${chrome.runtime.getURL("popup.html")}"
          title="Resume Pro 管理面板"
        ></iframe>
      </div>
    `;

    document.body.appendChild(panel);
    panel.querySelector("#resume-pro-close-manager")?.addEventListener("click", () => {
      setManagerVisibility(false);
    });
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
      sidebar.classList.toggle("is-collapsed");
      collapseButton.textContent = sidebar.classList.contains("is-collapsed") ? "+" : "−";
    });

    templateSelect.addEventListener("change", async (event) => {
      await StorageService.setActiveTemplate(event.target.value);
      showStatus("模板已切换。", "success");
    });

    aiFillButton.addEventListener("click", handleAiFillClick);
    sidebar.querySelector("#resume-pro-repeat-fill").addEventListener("click", handleRepeatFillClick);
    openManagerButton?.addEventListener("click", () => setManagerVisibility(true));
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

      if (changes.templates || changes.activeTemplateId || changes.aiConfig) {
        state.currentStore = await StorageService.getState();
        renderSidebar();
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

    templateSelect.innerHTML = templates.length
      ? templates.map((template) => `
          <option value="${escapeHtml(template.id)}" ${template.id === state.currentStore.activeTemplateId ? "selected" : ""}>
            ${escapeHtml(template.name)}
          </option>
        `).join("")
      : '<option value="">暂无模板</option>';

    templateSelect.disabled = !templates.length;

    if (!activeTemplate) {
      groupsContainer.innerHTML = `
        <div class="resume-pro__empty">
          <p>还没有简历数据。</p>
          <button class="resume-pro__setup-button" id="resume-pro-setup-button" type="button">上传简历 / 导入模板</button>
        </div>
      `;
    } else {
      groupsContainer.innerHTML = activeTemplate.groups.map((group, groupIndex) => `
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
    `).join("");

      groupsContainer.querySelectorAll(".resume-pro__chip").forEach((button) => {
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", () => handleFieldChipClick(button));
      });
    }

    const setupButton = groupsContainer.querySelector("#resume-pro-setup-button");
    if (setupButton) {
      setupButton.addEventListener("click", () => setManagerVisibility(true));
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

  function captureTextSelection(target) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const fallback = target.value.length;
      return {
        start: Number.isInteger(target.selectionStart) ? target.selectionStart : fallback,
        end: Number.isInteger(target.selectionEnd) ? target.selectionEnd : fallback
      };
    }

    const selection = window.getSelection?.();
    if (!selection?.rangeCount) {
      const fallback = target.textContent?.length || 0;
      return { start: fallback, end: fallback };
    }

    const range = selection.getRangeAt(0);
    if (!target.contains(range.commonAncestorContainer)) {
      const fallback = target.textContent?.length || 0;
      return { start: fallback, end: fallback };
    }

    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(target);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const beforeEnd = range.cloneRange();
    beforeEnd.selectNodeContents(target);
    beforeEnd.setEnd(range.endContainer, range.endOffset);
    return { start: beforeStart.toString().length, end: beforeEnd.toString().length };
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
    state.lastFocusedField = target;
    syncChipSelectionState();
    return true;
  }

  function getComposableTargetValue(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? String(target.value || "")
      : String(target.textContent || "");
  }

  function setContentEditableCaret(target, caret) {
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    if (!selection || !range) {
      return;
    }
    const textNode = target.firstChild || target;
    const offset = textNode === target ? 0 : Math.min(caret, textNode.textContent?.length || 0);
    range.setStart(textNode, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function isComposableTextTarget(target) {
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
      return true;
    }
    return target instanceof HTMLInputElement && ["text", "search", "tel", "url", "email", "password"].includes(target.type || "text");
  }

  function syncChipSelectionState() {
    if (!shadowRoot?.querySelectorAll) {
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

  async function handleRepeatFillClick(event) {
    const button = event.currentTarget;
    const fillButton = shadowRoot.querySelector("#resume-pro-ai-fill");
    if (button.disabled || fillButton.disabled) return;
    const template = getActiveTemplate(state.currentStore);
    const config = state.currentStore?.aiConfig;
    if (!template || !config?.apiKey || !config?.apiUrl || !config?.model) {
      showStatus("请先准备简历模板和 AI 接口。", "error");
      return;
    }
    const agent = self.ResumeProFormAgent;
    const snapshot = agent.collect(document, flattenTemplateFields(template));
    if (!snapshot.candidates.length) {
      showStatus("未识别到可安全新增的分组，请先手动新增条目，再一键填写。", "error");
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
      const reply = await self.ResumeProAIClient.send({ type: "AI_PLAN_REPEAT", requestId, aiConfig: config, candidates: snapshot.candidates });
      planning = false;
      window.clearInterval(timer);
      if (stopped) throw new Error("已停止，未执行新增。");
      if (!reply?.success) throw new Error("AI 规划失败，未执行新增。可稍后重试或手动新增。");
      const plan = agent.validatePlan(reply.plan, snapshot.candidates);
      if (!plan.length) throw new Error("AI 未给出可确认的新增操作，请手动处理。");
      const preview = plan.map(action => `${snapshot.candidates.find(c => c.id === action.id).label}：${action.count} 条`).join("\n");
      if (!window.confirm(`允许以下操作吗？\n${preview}\n\n确认后将点击网页新增按钮，再用 AI 填写这些分组的空字段。不会提交、删除或覆盖已有内容。网页自身可能保存新条目；停止后不自动删除。`)) return;
      if (getActiveTemplate(state.currentStore) !== template) throw new Error("当前模板已变化，请重新预览。");
      button.textContent = "正在新增并检查网页...";
      hint.hidden = true;
      expanded = await agent.execute(plan, snapshot, () => stopped || getActiveTemplate(state.currentStore) !== template);
    } catch (error) {
      showStatus(error.message || "辅助新增失败，请手动核对网页。", "error");
    } finally {
      window.clearInterval(timer);
      cancel.hidden = true;
      cancel.onclick = null;
      cancel.textContent = "取消 AI 等待（保留本地匹配）";
      hint.hidden = true;
      button.disabled = false;
      fillButton.disabled = false;
      button.textContent = "AI 辅助新增条目（先预览）";
    }
    if (expanded && !stopped && getActiveTemplate(state.currentStore) === template) await handleAiFillClick({ currentTarget: fillButton }, { scopes: expanded.scopes });
  }

  function isAssistedTextField(entry) {
    const el = entry.element;
    return !el.disabled && !el.readOnly && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && ["text", "email", "tel", "url", "search"].includes(el.type)));
  }

  function hasExistingValue(entry) {
    if (entry.kind === "radio") return entry.elements.some(el => el.checked);
    const el = entry.element;
    if (!el?.isConnected) return true;
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    return Boolean(String(el.value ?? el.textContent ?? "").trim());
  }

  async function handleAiFillClick(event, assisted = null) {
    const button = event.currentTarget;
    if (button.disabled) return;
    const activeTemplate = getActiveTemplate(state.currentStore);
    const aiConfig = state.currentStore?.aiConfig;

    if (!activeTemplate) {
      showStatus("请先导入简历模板。", "error");
      return;
    }

    if (!aiConfig?.apiUrl || !aiConfig?.model || !aiConfig?.apiKey) {
      showStatus("请先在插件中配置 AI 接口。", "error");
      return;
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
    let outcome = "failed";
    const requestId = newRequestId();
    const cancelButton = shadowRoot?.querySelector("#resume-pro-cancel-fill");
    const waitHint = shadowRoot?.querySelector("#resume-pro-wait-hint");
    let cancelRequested = false;

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
      if (!fields.length) throw new Error("当前页面没有可填写的表单字段。");
      const resumeFields = flattenTemplateFields(activeTemplate);
      phase = "roundTripMs";
      phaseStart = performance.now();
      if (cancelButton) {
        cancelButton.hidden = false;
        cancelButton.disabled = false;
        cancelButton.onclick = async () => {
          if (phase !== "roundTripMs") return;
          cancelButton.disabled = true;
          try {
            const reply = await self.ResumeProAIClient.cancel(requestId);
            if (reply?.cancelled) cancelRequested = true;
            if (waitHint && phase === "roundTripMs") {
              waitHint.hidden = false;
              waitHint.textContent = reply?.cancelled ? "正在取消 AI 等待，保留本地匹配结果。" : "请求已结束或无法取消，正在等待结果。";
            }
          } catch {
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
      const response = await self.ResumeProAIClient.send({
        type: "AI_FILL",
        requestId,
        formFields: fields,
        resumeFields,
        aiConfig
      });
      timing.roundTripMs = performance.now() - phaseStart;
      phase = null;
      window.clearInterval(timer);
      timer = null;
      if (cancelButton) cancelButton.hidden = true;
      if (waitHint) waitHint.hidden = true;
      diagnostics = response?.diagnostics || {};

      if (!response?.success) {
        throw new Error(response?.error || "AI 填写失败。");
      }

      button.textContent = "正在填写网页...";
      phase = "fillMs";
      phaseStart = performance.now();

      const fieldMetaMap = new Map(fields.map((f) => [f.fieldId, f]));
      const sortedMatches = [...response.matches].sort((a, b) => {
        const ma = fieldMetaMap.get(a.fieldId);
        const mb = fieldMetaMap.get(b.fieldId);
        if (ma?.cascadeGroup !== undefined && ma.cascadeGroup === mb?.cascadeGroup) {
          return (ma.cascadeLevel ?? 0) - (mb.cascadeLevel ?? 0);
        }
        return 0;
      });

      for (const match of sortedMatches) {
        if (assisted && getActiveTemplate(state.currentStore) !== activeTemplate) throw new Error("模板已变化，已停止辅助填写，请核对网页。");
        const element = fieldMap.get(match.fieldId);

        if (!element) continue;
        if (assisted && (!isAssistedTextField(element) || hasExistingValue(element) || !assisted.scopes.some(scope => scope.isConnected && scope.contains(element.element)))) continue;

        let filled = setElementValue(element, match.value);
        if (filled instanceof Promise) {
          filled = await filled;
        }
        if (assisted && filled) {
          await new Promise(resolve => window.setTimeout(resolve, 50));
          filled = element.element.isConnected && element.element.value === match.value;
        }

        const fieldMeta = fieldMetaMap.get(match.fieldId);

        if (!filled && element.kind === "element" && element.element instanceof HTMLSelectElement && fieldMeta?.cascadeGroup !== undefined) {
          for (let retry = 0; retry < 3; retry++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            filled = setElementValue(element, match.value);
            if (filled) break;
          }
        }

        if (filled) {
          filledCount += 1;
          highlightFilledField(element, match.value);
        } else if (assisted) {
          unconfirmedCount += 1;
        }

        if (filled && fieldMeta?.cascadeGroup !== undefined) {
          const groupFields = fields.filter((f) => f.cascadeGroup === fieldMeta.cascadeGroup);
          const maxLevelInGroup = Math.max(...groupFields.map((f) => f.cascadeLevel));
          
          if (fieldMeta.cascadeLevel < maxLevelInGroup) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }

      outcome = response.warning || unconfirmedCount ? "partial" : "success";
      if (assisted) {
        showStatus(`辅助填写：已验证 ${filledCount} 项。${unconfirmedCount ? `${unconfirmedCount} 项未确认，请核对网页。` : ""}${response.warning || ""}`, outcome === "partial" ? "error" : "success");
      } else showStatus(response.warning
        ? `本地已填写 ${filledCount} 项；${response.warning}`
        : `已填写 ${filledCount} 个字段。`, response.warning ? "error" : "success");
    } catch (error) {
      showStatus(error.message || "AI 填写失败。", "error");
    } finally {
      if (cancelButton) {
        cancelButton.hidden = true;
        cancelButton.onclick = null;
      }
      if (waitHint) waitHint.hidden = true;
      if (timer !== null) window.clearInterval(timer);
      if (phase) timing[phase] = performance.now() - phaseStart;
      const totalMs = performance.now() - totalStart;
      const summary = formatFillDiagnostics({ ...timing, totalMs,
        fieldCount, filledCount, outcome, diagnostics });
      const panel = shadowRoot?.querySelector("#resume-pro-diagnostics");
      const text = shadowRoot?.querySelector("#resume-pro-diagnostics-text");
      if (panel && text) {
        text.value = summary;
        panel.hidden = false;
        panel.open = true;
      }
      button.disabled = false;
      if (repeatButton) repeatButton.disabled = false;
      button.textContent = "一键 AI 填写";
      // A page with nothing to fill produced nothing worth archiving.
      if (fieldCount > 0) {
        offerFillRecord({
          outcome, cancelled: cancelRequested, fieldCount, filledCount, unconfirmedCount,
          timing: { scanMs: timing.scanMs, roundTripMs: timing.roundTripMs, fillMs: timing.fillMs, totalMs },
          templateName: activeTemplate?.name,
          endedAt: new Date().toISOString()
        }, activeTemplate).catch(() => {});
      }
    }
  }

  function formatFillDiagnostics(result) {
    const seconds = (value) => typeof value === "number" && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} s` : "未执行 / 未取得";
    const count = (value) => Number.isInteger(value) && value >= 0 ? value : "未取得";
    const d = result.diagnostics;
    // Explicit allowlist: never copy provider messages, URL, keys or field values.
    const code = /^(none|cancelled|network|format|http_\d{3})$/.test(d.errorCode) ? d.errorCode : "unknown";
    return [
      `Resume Pro v${chrome.runtime.getManifest().version}`,
      `结果：${({ success: "完成", partial: "部分完成", failed: "失败" })[result.outcome] || "未知"}；错误类别：${code}`,
      `网页字段：${count(result.fieldCount)}；成功填写：${count(result.filledCount)}`,
      `本地匹配：${count(d.ruleMatches)}；AI 匹配：${count(d.aiMatches)}`,
      `送 AI 字段：${count(d.aiFields)}`,
      `候选 / 简历字段：${count(d.candidateFields)} / ${count(d.resumeFields)}`,
      `用户 prompt：${count(d.promptBytes)} bytes`,
      `扫描：${seconds(result.scanMs)}`,
      `匹配往返（含后台处理）：${seconds(result.roundTripMs)}`,
      `API（含响应读取）：${seconds(d.apiMs)}`,
      `填写：${seconds(result.fillMs)}；总计：${seconds(result.totalMs)}`
    ].join("\n");
  }

  function scanFillableFields() {
    const candidates = Array.from(document.querySelectorAll(
      "input:not([type='hidden']):not([type='file']):not([type='button']):not([type='submit']):not([type='reset']):not([disabled]), textarea:not([disabled]), select:not([disabled])"
    )).filter((element) => isVisible(element) && !element.closest(`#${SIDEBAR_ID}`));

    const fieldMap = new Map();
    const fields = [];
    const radioGroups = new Set();

    candidates.forEach((element, index) => {
      if (element instanceof HTMLInputElement && element.type === "radio") {
        const groupName = element.name || `__radio__${index}`;

        if (radioGroups.has(groupName)) {
          return;
        }

        radioGroups.add(groupName);
        const radioElements = candidates.filter((candidate) => candidate instanceof HTMLInputElement && candidate.type === "radio" && (candidate.name || `__radio__${index}`) === groupName);
        const fieldId = `field-radio-${fields.length}`;
        fieldMap.set(fieldId, { kind: "radio", elements: radioElements });
        fields.push({
          fieldId,
          label: getFieldLabel(element),
          placeholder: "",
          name: groupName,
          idAttr: "",
          ariaLabel: element.getAttribute("aria-label") || "",
          tagName: "input",
          inputType: "radio",
          options: radioElements.map((radio) => getRadioOptionLabel(radio)).filter(Boolean),
          group: findNearestGroupLabel(element)
        });
        return;
      }

      const fieldId = `field-${fields.length}`;
      fieldMap.set(fieldId, { kind: "element", element });
      fields.push({
        fieldId,
        label: getFieldLabel(element),
        placeholder: element.getAttribute("placeholder") || "",
        name: element.getAttribute("name") || "",
        idAttr: element.id || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        tagName: element.tagName.toLowerCase(),
        inputType: element instanceof HTMLInputElement ? element.type || "text" : element.tagName.toLowerCase(),
        options: element instanceof HTMLSelectElement
          ? Array.from(element.options).map((option) => option.text.trim()).filter(Boolean)
          : [],
        group: findNearestGroupLabel(element)
      });
    });

    const pickerSelectors = [
      { selector: ".ant-picker", pickerType: "antd" },
      { selector: ".el-date-editor", pickerType: "element" },
      { selector: "[class*='date-picker']", pickerType: "generic" }
    ];

    pickerSelectors.forEach(({ selector, pickerType }) => {
      document.querySelectorAll(selector).forEach((container) => {
        if (container.closest(`#${SIDEBAR_ID}`)) return;
        if (!isVisible(container)) return;

        Array.from(container.querySelectorAll("input:not([type='hidden']):not([disabled])"))
          .filter((inner) => isVisible(inner))
          .forEach((inner) => {
          const pickerInputType = inferPickerInputType(container, inner);

          const existingEntry = Array.from(fieldMap.entries()).find(([, v]) => v.element === inner);
          if (existingEntry) {
            const [existingId, entryValue] = existingEntry;
            entryValue.pickerType = pickerType;
            entryValue.pickerInputType = pickerInputType;
            const existingField = fields.find((f) => f.fieldId === existingId);
            if (existingField) {
              existingField.inputType = "date-picker";
              existingField.pickerType = pickerType;
              existingField.pickerInputType = pickerInputType;
            }
            return;
          }

          const fieldId = `field-${fields.length}`;
          fieldMap.set(fieldId, { kind: "element", element: inner, pickerType, pickerInputType });
          fields.push({
            fieldId,
            label: getFieldLabel(inner),
            placeholder: inner.getAttribute("placeholder") || "",
            name: inner.getAttribute("name") || "",
            idAttr: inner.id || "",
            ariaLabel: inner.getAttribute("aria-label") || "",
            tagName: "input",
            inputType: "date-picker",
            pickerType,
            pickerInputType,
            options: [],
            group: findNearestGroupLabel(inner)
          });
        });
      });
    });

    // 级联判断 (Cascade Detection)
    if (self.ResumeProAIHelpers?.detectCascadeGroups) {
      self.ResumeProAIHelpers.detectCascadeGroups(fields, fieldMap);
    }

    return { fields, fieldMap };
  }

  function getFieldLabel(element) {
    const cleanedElementLabel = sanitizeLabelText(element.getAttribute("data-label"));
    if (cleanedElementLabel) return cleanedElementLabel;

    // 1. 标准 label 关联
    if (element.labels?.length) {
      const labelText = sanitizeLabelText(Array.from(element.labels).map((label) => label.textContent?.trim() || "").join(" / "));
      if (labelText) return labelText;
    }

    // 2. label[for] 关联
    if (element.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      const linkedText = sanitizeLabelText(linked?.textContent);
      if (linkedText) return linkedText;
    }

    // 3. 包裹在 label 里
    const wrappingLabel = element.closest("label");
    const wrappingText = sanitizeLabelText(wrappingLabel?.textContent);
    if (wrappingText) return wrappingText;

    // 4. aria-labelledby
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = sanitizeLabelText(labelledBy.split(" ").map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" "));
      if (text) return text;
    }

    // 5. 同一行的前一个兄弟元素文本（td/th/span/div/p）
    let sibling = element.previousElementSibling;
    while (sibling) {
      const text = sanitizeLabelText(sibling.textContent);
      if (text && text.length < 30) return text;
      sibling = sibling.previousElementSibling;
    }

    // 6. 父容器内、input 之前的文本节点或标签元素（常见于 td 布局）
    const parent = element.parentElement;
    if (parent) {
      // 找父容器的前一个兄弟（如 th/td）
      let parentSibling = parent.previousElementSibling;
      while (parentSibling) {
        const text = sanitizeLabelText(parentSibling.textContent);
        if (text && text.length < 30) return text;
        parentSibling = parentSibling.previousElementSibling;
      }

      // 父容器本身的直接文本（排除 input 本身的内容）
      const clone = parent.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, button").forEach(el => el.remove());
      const text = sanitizeLabelText(clone.textContent);
      if (text && text.length < 30) return text;
    }

    // 7. 向上追溯祖先容器的前序单元格/标签，适配表格或复杂布局
    let current = parent;
    let depth = 0;
    while (current && depth < 5) {
      let previous = current.previousElementSibling;
      while (previous) {
        const text = sanitizeLabelText(previous.textContent);
        if (text && text.length < 40) return text;
        previous = previous.previousElementSibling;
      }

      const scopedLabel = current.querySelector("label, th, .label, .form-label, .ant-form-item-label");
      const scopedText = sanitizeLabelText(scopedLabel?.textContent);
      if (scopedText && scopedText.length < 40) return scopedText;

      current = current.parentElement;
      depth += 1;
    }

    // 8. placeholder 兜底
    return element.getAttribute("placeholder")?.trim() || "";
  }

  function bindFocusTracking() {
    document.addEventListener("focusin", (event) => {
      const target = event.target;

      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.closest(`#${SIDEBAR_ID}`) || target.closest("#resume-pro-manager")) {
        return;
      }

      if (isFillTarget(target)) {
        state.lastFocusedField = target;
        closeChipActionMenu();
        syncChipSelectionState();
      }
    }, true);
    document.addEventListener("input", (event) => {
      if (event.target === state.lastFocusedField) {
        closeChipActionMenu();
        if (!chipWriteTargets.has(event.target)) {
          chipSelectionIdsByTarget.delete(event.target);
        }
        syncChipSelectionState();
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

  function setElementValue(element, value) {
    if (element && typeof element === "object" && element.kind === "radio") {
      const matchedRadio = element.elements.find((radio) => {
        const optionText = getRadioOptionLabel(radio);
        return optionText === value.trim() || radio.value === value.trim();
      });

      if (!matchedRadio) {
        return false;
      }

      matchedRadio.checked = true;
      matchedRadio.dispatchEvent(new Event("input", { bubbles: true }));
      matchedRadio.dispatchEvent(new Event("change", { bubbles: true }));
      matchedRadio.click();
      return true;
    }

    const pickerType = (element && typeof element === "object" && element.kind === "element") ? element.pickerType : null;
    const pickerInputType = (element && typeof element === "object" && element.kind === "element") ? (element.pickerInputType || "date") : "date";

    if (element && typeof element === "object" && element.kind === "element") {
      element = element.element;
    }

    if (element instanceof HTMLInputElement && ["date", "month", "datetime-local", "time"].includes(element.type)) {
      const normalized = self.ResumeProAIHelpers?.normalizeDateValue?.(value, element.type) ?? value;
      const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
      element.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      if (descriptor?.set) {
        descriptor.set.call(element, normalized);
      } else {
        element.value = normalized;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      return element.value === normalized;
    }

    if (element instanceof HTMLInputElement && (pickerType === "antd" || pickerType === "element" || pickerType === "generic")) {
      const normalized = self.ResumeProAIHelpers?.normalizeDateValue?.(value, pickerInputType) ?? value;
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return new Promise((resolve) => {
        window.setTimeout(() => {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
            if (descriptor?.set) {
              descriptor.set.call(element, normalized);
            } else {
              element.value = normalized;
            }
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
          } catch (_) {
            resolve(false);
            return;
          }
          resolve(element.value === normalized);
        }, 150);
      });
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (element instanceof HTMLSelectElement) {
      if (element.options.length <= 1) {
        const onlyOption = element.options[0];
        if (!onlyOption || (onlyOption.value !== value && onlyOption.text.trim() !== value.trim())) {
          return false;
        }
      }

      if (Array.from(element.options).some((option) => option.value === value)) {
        element.value = value;
      } else {
        const matchedOption = Array.from(element.options).find((option) => option.text.trim() === value.trim());
        if (!matchedOption) {
          return false;
        }
        element.value = matchedOption.value;
      }
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    return false;
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

  function findNearestGroupLabel(element) {
    const sectionSelectors = ["fieldset", "[role='group']", ".form-item", ".ant-form-item", "tr", "li", "section", "td"];

    for (const selector of sectionSelectors) {
      const container = element.closest(selector);

      if (!container) {
        continue;
      }

      const labelCandidate = container.querySelector("legend, label, th, .label, .form-label, .ant-form-item-label");
      const text = labelCandidate?.textContent?.trim().replace(/[*\s]+$/g, "").trim();

      if (text && text.length < 40) {
        return text;
      }
    }

    return "";
  }

  function sanitizeLabelText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .replace(/^\*+/, "")
      .replace(/\*+$/g, "")
      .trim();
  }

  function setManagerVisibility(visible) {
    const panel = document.getElementById("resume-pro-manager");

    if (!panel) {
      return;
    }

    const frame = panel.querySelector(".resume-pro-manager__frame");
    if (visible && frame && frame.dataset.loaded !== "true") {
      frame.src = frame.dataset.src;
      frame.dataset.loaded = "true";
    }

    panel.classList.toggle("is-visible", visible);
    state.managerVisible = visible;
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
    if (!store?.templates?.length) {
      return null;
    }

    return store.templates.find((template) => template.id === store.activeTemplateId) || store.templates[0];
  }

  function showStatus(message, variant) {
    const statusElement = shadowRoot?.querySelector("#resume-pro-status");

    if (!statusElement) {
      return;
    }

    statusElement.textContent = message;
    statusElement.className = `resume-pro__status is-visible is-${variant}`;

    if (state.statusTimer) {
      clearTimeout(state.statusTimer);
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
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
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

  function normalizeStore(rawState) {
    const templates = Array.isArray(rawState.templates)
      ? rawState.templates.map(normalizeTemplate).filter(Boolean)
      : [];

    const activeTemplateId = typeof rawState.activeTemplateId === "string"
      ? rawState.activeTemplateId
      : "";

    return {
      templates,
      activeTemplateId: templates.some((template) => template.id === activeTemplateId)
        ? activeTemplateId
        : templates[0]?.id || "",
      aiConfig: {
        apiUrl: String(rawState.aiConfig?.apiUrl ?? "https://api.openai.com/v1/chat/completions").trim(),
        model: String(rawState.aiConfig?.model ?? "gpt-4o-mini").trim(),
        apiKey: String(rawState.aiConfig?.apiKey ?? "")
      }
    };
  }

  function normalizeTemplate(template) {
    if (!template || typeof template !== "object") {
      return null;
    }

    const groups = Array.isArray(template.groups)
      ? template.groups
          .map((group) => {
            if (!group || typeof group !== "object") {
              return null;
            }

            const fields = Array.isArray(group.fields)
              ? group.fields
                  .map((field) => {
                    if (!field || typeof field !== "object") {
                      return null;
                    }

                    return {
                      key: String(field.key ?? "").trim(),
                      value: String(field.value ?? "")
                    };
                  })
                  .filter((field) => field && field.key)
              : [];

            return {
              name: String(group.name ?? "").trim() || "未分类",
              fields
            };
          })
          .filter((group) => group && group.fields.length)
      : [];

    return {
      id: typeof template.id === "string" && template.id.trim() ? template.id : crypto.randomUUID(),
      name: String(template.name ?? "").trim() || "未命名模板",
      groups
    };
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
  // The finished fill the card is offering to archive. Held only until the user answers.
  let pendingFill = null;

  async function loadDesktopModules() {
    if (!desktopModules) {
      const [extract, copy, fillrecords, snapshot] = await Promise.all([
        import(chrome.runtime.getURL("link/extract.mjs")),
        import(chrome.runtime.getURL("link/copy.mjs")),
        import(chrome.runtime.getURL("link/fillrecords.mjs")),
        import(chrome.runtime.getURL("link/snapshot.mjs"))
      ]);
      desktopModules = { extract, copy, fillrecords, snapshot };
    }
    return desktopModules;
  }

  function bindDesktopEvents(sidebar) {
    sidebar.querySelector("#resume-pro-save-job")?.addEventListener("click", handleSaveJobClick);
    sidebar.querySelector("#resume-pro-confirm-submit")?.addEventListener("click", handleConfirmSubmitClick);
    sidebar.querySelector("#resume-pro-save-cancel")?.addEventListener("click", closeSaveForm);
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
    if (!form) return;

    try {
      const { extract } = await loadDesktopModules();
      const fields = extract.extractJobFields(document, location.href);
      form.querySelector("#resume-pro-save-company").value = fields.company;
      form.querySelector("#resume-pro-save-title").value = fields.title;
      form.querySelector("#resume-pro-save-location").value = fields.location;
      form.querySelector("#resume-pro-save-url").value = fields.sourceUrl;
      pendingFields = fields;
      const note = form.querySelector("#resume-pro-save-note");
      // Blanks are expected: nothing is guessed. Saying so is what stops a user from
      // assuming the extension already knows the employer.
      note.textContent = fields.company
        ? "请核对，缺的可以自己补。"
        : "这个页面没有声明公司名，请手动填写；插件不会替你猜。";
      form.hidden = false;
      setDesktopStatus(null);
    } catch (error) {
      setDesktopStatus({ tone: "warn", text: "读取页面信息失败，请手动填写后再保存。" });
    }
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
      setDesktopStatus(copy.describeConfirmResult({ status: "pending" }));
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
        const result = await chrome.runtime.sendMessage({
          type: "DESKTOP_CONFIRM_SUBMIT", applicationId: candidate.applicationId
        });
        setDesktopStatus(copy.describeConfirmResult(result ?? { status: "pending" }));
        refreshPendingList();
      });
      list.appendChild(row);
    }
    shadowRoot.querySelector("#resume-pro-bind-new").hidden = true;
    box.hidden = false;
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
    pendingFill = {
      ...raw,
      urlRedacted: job.sourceUrl,
      templateVersion: (await snapshot.templateVersionOf(template)) || "",
      pluginVersion: chrome.runtime.getManifest().version,
      job: { company: job.company, title: job.title, sourceUrl: job.sourceUrl }
    };
    // The summary is built from exactly what would be sent, so the card cannot promise more.
    card.querySelector("#resume-pro-fill-record-summary").textContent =
      copy.describeFillOffer(fillrecords.buildFillPayload(pendingFill));
    card.hidden = false;
  }

  function closeFillRecord() {
    const card = shadowRoot?.querySelector("#resume-pro-fill-record");
    if (card) card.hidden = true;
    pendingFill = null;
  }

  async function handleRecordFillClick() {
    const raw = pendingFill;
    if (!raw) return;
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
      await recordFill(raw, null);
      return;
    }

    const options = [...candidates.exact, ...candidates.sameCompany];
    showFillCandidates(options, {
      note: options.length
        ? "这次填写属于哪条申请？"
        : "桌面里还没有这家公司的申请。可以先「保存岗位到本地」，或者稍后在待同步里选择。",
      onPick: applicationId => recordFill(raw, applicationId),
      onLater: () => recordFill(raw, null)
    });
  }

  async function recordFill(raw, applicationId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_RECORD_FILL", raw, applicationId });
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

  function closeSaveForm() {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (form) form.hidden = true;
    pendingFields = null;
  }

  async function submitSaveForm({ force }) {
    const form = shadowRoot?.querySelector("#resume-pro-save-form");
    if (!form) return;

    const fields = {
      company: form.querySelector("#resume-pro-save-company").value.trim(),
      title: form.querySelector("#resume-pro-save-title").value.trim(),
      location: form.querySelector("#resume-pro-save-location").value.trim(),
      // The URL is whatever redaction produced when the form opened. It is not editable and
      // is never re-read from the address bar here, so no un-redacted URL can reach storage.
      sourceUrl: pendingFields?.sourceUrl || "",
      dedupeUrl: pendingFields?.dedupeUrl || ""
    };

    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_SAVE_JOB", fields, force });
    } catch (error) {
      result = { status: "error" };
    }

    setDesktopStatus(copy.describeSaveResult(result ?? { status: "error" }));
    if (result?.status === "queued") {
      closeSaveForm();
      if (result.mode === "ready") {
        await offerCandidates(result.intent.intentId);
      }
    }
    refreshPendingList();
  }

  // Two layers, per §7. The exact layer is "this may be the same posting again"; the
  // same-company layer is a hint and nothing more. Neither ever binds on its own — the
  // default is always a new application.
  async function offerCandidates(intentId) {
    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    const list = shadowRoot?.querySelector("#resume-pro-candidate-list");
    if (!box || !list) return;

    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_CANDIDATES", intentId });
    } catch {
      return;
    }
    if (result?.status !== "ok") return;

    list.textContent = "";
    const note = shadowRoot.querySelector("#resume-pro-candidates-note");
    const total = result.exact.length + result.sameCompany.length;
    note.textContent = total
      ? "桌面里有相关的申请。要绑定到已有的哪一条，还是新建？默认新建。"
      : "桌面里没有相关的申请，确认后会新建一条。";

    appendCandidateGroup(list, "可能是同一岗位的重复投递", result.exact, intentId);
    appendCandidateGroup(list, "同公司的其他岗位（仅供参考）", result.sameCompany, intentId);

    box.hidden = false;
    const bindNew = shadowRoot.querySelector("#resume-pro-bind-new");
    bindNew.hidden = false;
    bindNew.onclick = () => bindIntent(intentId, null);
    shadowRoot.querySelector("#resume-pro-bind-later").onclick = () => {
      // §5.2.4: cancelling the picker keeps the intent pending. Nothing is bound and nothing
      // is discarded.
      box.hidden = true;
    };
  }

  function appendCandidateGroup(list, heading, candidates, intentId) {
    if (!candidates.length) return;
    const title = document.createElement("p");
    title.className = "resume-pro__save-note";
    title.textContent = heading;
    list.appendChild(title);

    for (const candidate of candidates) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "resume-pro__candidate";
      row.textContent = `${candidate.company} · ${candidate.title}${candidate.stage ? `（${candidate.stage}）` : ""}`;
      row.addEventListener("click", () => bindIntent(intentId, candidate.applicationId));
      list.appendChild(row);
    }
  }

  async function bindIntent(intentId, applicationId) {
    const { copy } = await loadDesktopModules();
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "DESKTOP_BIND", intentId, applicationId });
    } catch {
      result = { status: "pending" };
    }

    const box = shadowRoot?.querySelector("#resume-pro-candidates");
    if (box) box.hidden = true;
    setDesktopStatus(copy.describeBindResult(result ?? { status: "pending" }));
    refreshPendingList();
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

    if (copy.offerForce) {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "resume-pro__manager-button";
      again.textContent = "再存一次";
      again.addEventListener("click", () => submitSaveForm({ force: true }));
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
    try {
      const reply = await chrome.runtime.sendMessage({ type: "DESKTOP_LIST_QUEUE" });
      intents = reply?.intents || [];
      outbox = reply?.outbox || [];
      fillRecords = reply?.fillRecords || [];
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
      if (intent.status === "pending_bind") {
        row.appendChild(rowButton("选择绑定", () => offerCandidates(intent.intentId)));
      }
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
      row.appendChild(rowButton("选择申请", () => chooseFillApplication(record)));
      row.appendChild(rowButton("删除", async () => {
        await chrome.runtime.sendMessage({ type: "DESKTOP_REMOVE_FILL", recordId: record.recordId });
        refreshPendingList();
      }));
      list.appendChild(row);
    }

    for (const entry of outbox) {
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

  // Each kind of queued message has its own wording: a retried fill must not report that a
  // job was saved, nor a refused one ask the user to check a company name.
  function describeQueueResult(copy, entry, result) {
    if (entry.messageType === "fill.submit") return copy.describeFillRecordResult(result);
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
      setDesktopStatus(describeQueueResult(copy, entry, result ?? { status: "pending" }));
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

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TOGGLE_MANAGER") {
      setManagerVisibility(!state.managerVisible);
    }
    return false;
  });

  if (self.__RESUME_PRO_TEST__) {
    self.ResumeProHighlightTest = {
      handleRepeatFillClick,
      formatFillDiagnostics,
      getHighlightTargets,
      handleAiFillClick,
      handleChipAction,
      handleFieldChipClick,
      highlightFilledField,
      injectFieldHighlightStyles,
      isInViewport,
      applyChipValue,
      composeChipText,
      syncChipSelectionState,
      setCurrentStore(store) {
        state.currentStore = store;
      },
      setLastFocusedField(field) {
        state.lastFocusedField = field;
      },
      setShadowRoot(root) {
        shadowRoot = root;
      }
    };
  }
})();
