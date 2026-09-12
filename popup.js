const DEFAULT_STORE = {
  templates: [],
  activeTemplateId: "",
  aiConfig: {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiKey: ""
  }
};

const UPDATE_API_URL = "https://api.github.com/repos/TshyGO/resume-form-assistant-plugin/releases/latest";
const UPDATE_CACHE_KEY = "resumeProUpdateCache";
const UPDATE_DISMISSED_KEY = "resumeProDismissedVersion";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const MAX_LISTED_ROW_NUMBERS = 20;
const TEMPLATE_SHEET_HEADER = ["一级分类", "字段名", "值"];
const BACKUP_FORMAT = "resume-pro.backup";
const BACKUP_FORMAT_VERSION = 1;
let pdfJsPromise = null;

const StorageService = {
  async ensureDefaults() {
    const current = await chrome.storage.local.get(null);
    const normalized = normalizeStore(current);

    if (JSON.stringify(current) !== JSON.stringify(normalized)) {
      await chrome.storage.local.set(normalized);
    }

    return normalized;
  },

  async getState() {
    const current = await chrome.storage.local.get(null);
    return normalizeStore(current);
  },

  async saveState(nextState) {
    const normalized = normalizeStore(nextState);
    await chrome.storage.local.set(normalized);
    return normalized;
  },

  async update(updater) {
    const current = await this.getState();
    const next = await updater(structuredClone(current));
    return this.saveState(next);
  },

  async setActiveTemplate(templateId) {
    return this.update((state) => {
      state.activeTemplateId = templateId;
      return state;
    });
  },

  async saveAiConfig(aiConfig) {
    return this.update((state) => {
      state.aiConfig = normalizeAiConfig(aiConfig);
      return state;
    });
  }
};

const popupState = {
  activeTab: "templates",
  availableRelease: null,
  reimportTemplateId: "",
  pendingBackup: null,
  modelRequestId: 0,
  modelResult: null,
  modelVisible: [],
  modelActiveIndex: -1,
  statusTimers: {
    template: null,
    backup: null,
    config: null,
    model: null,
    url: null
  }
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((error) => {
    console.error("Resume Pro popup init failed:", error);
    showStatus("template", `初始化失败：${error.message}`, "error", 0);
  });
});

async function bootstrap() {
  cacheElements();
  bindEvents();
  await StorageService.ensureDefaults();
  await render();
  initializeUpdateFeature().catch((error) => {
    console.warn("Resume Pro update feature init failed:", error);
  });
}

function cacheElements() {
  elements.tabButtons = Array.from(document.querySelectorAll(".tab-button"));
  elements.tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
  elements.templateList = document.getElementById("template-list");
  elements.templateFileInput = document.getElementById("template-file-input");
  elements.importTemplateButton = document.getElementById("import-template-button");
  elements.parseToggleButton = document.getElementById("parse-toggle-button");
  elements.parseSection = document.getElementById("parse-section");
  elements.templateStatus = document.getElementById("template-status");
  elements.backupStatus = document.getElementById("backup-status");
  elements.exportBackupButton = document.getElementById("export-backup-button");
  elements.importBackupButton = document.getElementById("import-backup-button");
  elements.backupFileInput = document.getElementById("backup-file-input");
  elements.backupConfirm = document.getElementById("backup-confirm");
  elements.backupConfirmText = document.getElementById("backup-confirm-text");
  elements.backupAppendButton = document.getElementById("backup-append-button");
  elements.backupReplaceButton = document.getElementById("backup-replace-button");
  elements.backupCancelButton = document.getElementById("backup-cancel-button");
  elements.aiConfigForm = document.getElementById("ai-config-form");
  elements.apiUrlInput = document.getElementById("api-url-input");
  elements.modelInput = document.getElementById("model-input");
  elements.apiKeyInput = document.getElementById("api-key-input");
  elements.toggleApiKeyButton = document.getElementById("toggle-api-key");
  elements.fetchModelsButton = document.getElementById("fetch-models-button");
  elements.modelCombo = document.getElementById("model-combo");
  elements.modelToggle = document.getElementById("model-toggle");
  elements.modelListbox = document.getElementById("model-listbox");
  elements.modelStatus = document.getElementById("model-status");
  elements.urlStatus = document.getElementById("url-status");
  elements.configStatus = document.getElementById("config-status");
  elements.currentVersion = document.getElementById("current-version");
  elements.checkUpdateButton = document.getElementById("check-update-button");
  elements.updateCheckStatus = document.getElementById("update-check-status");
  elements.updateBanner = document.getElementById("update-banner");
  elements.updateTitle = document.getElementById("update-title");
  elements.updateSummary = document.getElementById("update-summary");
  elements.downloadUpdateButton = document.getElementById("download-update-button");
  elements.dismissUpdateButton = document.getElementById("dismiss-update-button");
}

function bindEvents() {
  elements.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  elements.parseToggleButton.addEventListener("click", () => {
    const isOpen = elements.parseSection.classList.toggle("is-open");
    elements.parseToggleButton.classList.toggle("is-active", isOpen);
  });

  elements.importTemplateButton.addEventListener("click", () => {
    popupState.reimportTemplateId = "";
    elements.templateFileInput.click();
  });

  elements.templateFileInput.addEventListener("change", handleFileSelection);
  elements.exportBackupButton.addEventListener("click", handleExportBackup);
  elements.importBackupButton.addEventListener("click", () => {
    hideBackupConfirm();
    elements.backupFileInput.click();
  });
  elements.backupFileInput.addEventListener("change", handleBackupFileSelection);
  elements.backupAppendButton.addEventListener("click", () => commitPendingBackup("append"));
  elements.backupReplaceButton.addEventListener("click", () => commitPendingBackup("replace"));
  elements.backupCancelButton.addEventListener("click", () => {
    hideBackupConfirm();
    hideStatus("backup");
  });
  elements.templateList.addEventListener("click", handleTemplateListClick);
  elements.aiConfigForm.addEventListener("submit", handleConfigSubmit);
  elements.toggleApiKeyButton.addEventListener("click", toggleApiKeyVisibility);
  elements.fetchModelsButton.addEventListener("click", handleFetchModelsClick);
  bindModelCombo();
  // Suggestions fetched for one address and key are wrong for another.
  elements.apiUrlInput.addEventListener("input", clearModelSuggestions);
  elements.apiUrlInput.addEventListener("input", updateUrlWarning);
  elements.apiKeyInput.addEventListener("input", clearModelSuggestions);
  elements.checkUpdateButton.addEventListener("click", () => {
    checkForUpdates({ force: true, announce: true });
  });
  elements.downloadUpdateButton.addEventListener("click", openAvailableRelease);
  elements.dismissUpdateButton.addEventListener("click", dismissAvailableRelease);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes.templates || changes.activeTemplateId || changes.aiConfig) {
      render().catch((error) => {
        console.error("Resume Pro popup render failed:", error);
      });
    }
  });
}

function setActiveTab(tabName) {
  popupState.activeTab = tabName;

  elements.tabButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tabName);
  });

  elements.tabPanels.forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === tabName);
  });
}

async function render() {
  const state = await StorageService.getState();
  renderTemplates(state);
  renderConfig(state.aiConfig);
  setActiveTab(popupState.activeTab);
}

function renderTemplates(state) {
  const { templates, activeTemplateId } = state;

  if (!templates.length) {
    elements.templateList.innerHTML = `
      <div class="empty-state">
        <p>还没有简历模板。</p>
        <p>点击右上角按钮导入 Excel，或用下方 AI 解析功能从简历文件一键生成。</p>
      </div>
    `;
    return;
  }

  elements.templateList.innerHTML = templates.map((template) => {
    const fieldCount = countTemplateFields(template);
    const groupCount = Array.isArray(template.groups) ? template.groups.length : 0;
    const isActive = template.id === activeTemplateId;

    return `
      <article class="template-item ${isActive ? "is-active" : ""}" data-template-id="${escapeHtml(template.id)}">
        <div class="template-head">
          <div class="template-info">
            <h3 class="template-name">${escapeHtml(template.name || "未命名模板")}</h3>
            <p class="template-meta">${groupCount} 个分组 · ${fieldCount} 个字段</p>
          </div>
          ${isActive ? '<span class="active-badge">当前使用中</span>' : ""}
        </div>
        <div class="template-actions">
          ${
            isActive
              ? ""
              : '<button class="secondary-button" type="button" data-action="activate">设为当前</button>'
          }
          <button class="secondary-button" type="button" data-action="reimport">重新导入 Excel</button>
          <button class="secondary-button" type="button" data-action="export">导出 Excel</button>
          <button class="danger-button" type="button" data-action="delete">删除</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderConfig(aiConfig) {
  elements.apiUrlInput.value = aiConfig.apiUrl || "";
  elements.modelInput.value = aiConfig.model || "";
  elements.apiKeyInput.value = aiConfig.apiKey || "";
  updateUrlWarning();
}

// Shown whenever the settings page shows the address -- on open, while typing and after
// save -- so users already configured with plain http see it too. Nothing is blocked.
function updateUrlWarning() {
  const risk = self.ResumeProModels.describeTransportRisk(elements.apiUrlInput.value);

  if (risk) {
    showStatus("url", risk.message, "warning", 0);
  } else {
    hideStatus("url");
  }
}

async function handleTemplateListClick(event) {
  const actionButton = event.target.closest("button[data-action]");
  const templateCard = event.target.closest(".template-item");

  if (!templateCard) {
    return;
  }

  const templateId = templateCard.dataset.templateId;
  const action = actionButton?.dataset.action;

  if (!action && !actionButton) {
    await StorageService.setActiveTemplate(templateId);
    showStatus("template", "已切换当前模板。", "success");
    return;
  }

  if (action === "activate") {
    await StorageService.setActiveTemplate(templateId);
    showStatus("template", "已切换当前模板。", "success");
    return;
  }

  if (action === "reimport") {
    popupState.reimportTemplateId = templateId;
    elements.templateFileInput.click();
    return;
  }

  if (action === "export") {
    await exportTemplateToExcel(templateId);
    return;
  }

  if (action === "delete") {
    await deleteTemplate(templateId);
  }
}

async function handleFileSelection(event) {
  const [file] = event.target.files || [];
  elements.templateFileInput.value = "";

  const reimportTemplateId = popupState.reimportTemplateId;
  popupState.reimportTemplateId = "";

  if (!file) {
    return;
  }

  try {
    const groups = await parseTemplateFile(file);
    const templateName = getTemplateNameFromFile(file.name);
    const fieldCount = countTemplateFields({ groups });
    let previousFieldCount = null;

    await StorageService.update((state) => {
      if (reimportTemplateId) {
        const target = state.templates.find((item) => item.id === reimportTemplateId);

        if (!target) {
          throw new Error("要重新导入的模板不存在。");
        }

        previousFieldCount = countTemplateFields(target);
        target.groups = groups;
        state.activeTemplateId = target.id;
      } else {
        const nextTemplate = {
          id: crypto.randomUUID(),
          name: resolveTemplateName(templateName, state.templates),
          groups
        };

        state.templates.unshift(nextTemplate);
        state.activeTemplateId = nextTemplate.id;
      }

      return state;
    });

    const unchanged = previousFieldCount === fieldCount;

    showStatus(
      "template",
      buildImportSuccessMessage(fieldCount, previousFieldCount),
      unchanged ? "warning" : "success",
      unchanged ? 0 : 6000
    );
  } catch (error) {
    const hint = reimportTemplateId ? "本次导入未生效，原模板保持不变。" : "本次导入未生效。";
    showStatus("template", `导入失败：${error.message}${hint}`, "error", 0);
  }
}

// The count is the only thing a user can check at a glance after editing the Excel by hand,
// so say it out loud — and say it twice when nothing moved, because that almost always means
// the file that got picked is not the file that got edited.
function buildImportSuccessMessage(fieldCount, previousFieldCount) {
  if (previousFieldCount === null) {
    return `简历模板导入成功，共 ${fieldCount} 个字段。`;
  }

  if (previousFieldCount === fieldCount) {
    return `模板已覆盖，仍是 ${fieldCount} 个字段，数量没有变化。如果刚在 Excel 里加过内容，请确认选中的是改完并保存后的那份文件。`;
  }

  return `模板已覆盖，字段 ${previousFieldCount} → ${fieldCount} 个。`;
}

function resolveTemplateName(templateName, templates) {
  const usedNames = new Set(templates.map((template) => template.name));

  if (!usedNames.has(templateName)) {
    return templateName;
  }

  let index = 2;

  while (usedNames.has(`${templateName} (${index})`)) {
    index += 1;
  }

  return `${templateName} (${index})`;
}

async function handleConfigSubmit(event) {
  event.preventDefault();

  const typedUrl = elements.apiUrlInput.value.trim() || DEFAULT_STORE.aiConfig.apiUrl;
  const { aiConfig: savedConfig } = await StorageService.getState();
  const aiConfig = {
    apiUrl: self.ResumeProModels.normalizeApiUrlForSave(typedUrl, savedConfig.apiUrl),
    model: elements.modelInput.value.trim() || DEFAULT_STORE.aiConfig.model,
    apiKey: elements.apiKeyInput.value.trim()
  };

  await StorageService.saveAiConfig(aiConfig);

  if (aiConfig.apiUrl !== typedUrl) {
    elements.apiUrlInput.value = aiConfig.apiUrl;
    showStatus("config", `配置已保存。API URL 已补全为 ${aiConfig.apiUrl}`, "success", 6000);
    return;
  }

  showStatus("config", "配置已保存。", "success");
}

// Fetching never touches the model input or storage: the list only feeds the suggestion
// dropdown, so a failed fetch leaves the field behaving exactly like the plain text box it was.
async function handleFetchModelsClick() {
  const button = elements.fetchModelsButton;
  const requestId = ++popupState.modelRequestId;
  button.disabled = true;
  button.textContent = "获取中…";
  showStatus("model", "正在获取模型列表…", "success", 0);

  try {
    const result = await self.ResumeProModels.fetchModelList({
      apiUrl: elements.apiUrlInput.value.trim() || DEFAULT_STORE.aiConfig.apiUrl,
      apiKey: elements.apiKeyInput.value
    });

    if (requestId !== popupState.modelRequestId) {
      return;
    }

    if (!result.ok) {
      setModelSuggestions(null);
      showStatus("model", result.message, "error", 0);
      return;
    }

    setModelSuggestions(result);
    showModelNotice();

    if (result.models.length) {
      elements.modelInput.focus();
      openModelList("");
    }
  } finally {
    button.disabled = false;
    button.textContent = "获取模型";
  }
}

function showModelNotice() {
  const result = popupState.modelResult;

  if (!result) {
    return;
  }

  if (!result.allModels.length) {
    showStatus("model", "该服务返回了空的模型列表，可直接手填模型名称。", "warning", 0);
    return;
  }

  const hiddenNote = result.hiddenCount ? `（另隐藏 ${result.hiddenCount} 个向量、语音、图像等非对话模型）` : "";
  const summary = `已获取 ${result.models.length} 个模型${hiddenNote}。可从列表选择，也可直接输入任意名称。`;
  const currentModel = elements.modelInput.value.trim();

  if (currentModel && !result.allModels.includes(currentModel)) {
    showStatus("model", `${summary}当前填写的「${currentModel}」不在列表中，请确认拼写。`, "warning", 0);
    return;
  }

  showStatus("model", summary, "success", 0);
}

function clearModelSuggestions() {
  popupState.modelRequestId += 1;
  setModelSuggestions(null);
  hideStatus("model");
}

function setModelSuggestions(result) {
  popupState.modelResult = result;
  elements.modelToggle.hidden = !result?.models.length;
  closeModelList();
}

// The suggestion list is a hand-built combobox rather than a <datalist>: Chrome filters a
// datalist by the text already in the box, so a filled-in field would show one option, or
// none when the current name is misspelt -- exactly when the user wants to browse.
function openModelList(query) {
  const suggestions = popupState.modelResult?.models || [];

  if (!suggestions.length) {
    return;
  }

  popupState.modelVisible = self.ResumeProModels.matchModels(suggestions, query);
  popupState.modelActiveIndex = -1;
  renderModelList();
  elements.modelListbox.hidden = false;
  elements.modelInput.setAttribute("aria-expanded", "true");
  placeModelList();
  elements.modelListbox.querySelector(".is-current")?.scrollIntoView({ block: "nearest" });
}

function closeModelList() {
  popupState.modelActiveIndex = -1;
  elements.modelListbox.hidden = true;
  elements.modelInput.setAttribute("aria-expanded", "false");
  elements.modelInput.removeAttribute("aria-activedescendant");
}

function isModelListOpen() {
  return !elements.modelListbox.hidden;
}

function renderModelList() {
  const { modelVisible: visible, modelActiveIndex: active } = popupState;
  const current = elements.modelInput.value.trim();

  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "model-combo__empty";
    empty.setAttribute("role", "presentation");
    empty.textContent = "没有匹配的模型，保存时按输入的名称使用。";
    elements.modelListbox.replaceChildren(empty);
    elements.modelInput.removeAttribute("aria-activedescendant");
    return;
  }

  elements.modelListbox.replaceChildren(...visible.map((id, index) => {
    const option = document.createElement("li");
    option.id = `model-option-${index}`;
    option.className = "model-combo__option";
    option.classList.toggle("is-active", index === active);
    option.classList.toggle("is-current", id === current);
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(id === current));
    option.dataset.value = id;
    option.title = id;
    option.textContent = id;
    return option;
  }));

  if (active >= 0) {
    elements.modelInput.setAttribute("aria-activedescendant", `model-option-${active}`);
    document.getElementById(`model-option-${active}`)?.scrollIntoView({ block: "nearest" });
  } else {
    elements.modelInput.removeAttribute("aria-activedescendant");
  }
}

// The model field sits near the bottom of the panel, so open upwards when there is not
// enough room below rather than pushing the list out of the iframe.
function placeModelList() {
  const rect = elements.modelCombo.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 16;
  const above = rect.top - 16;
  const openAbove = below < 200 && above > below;
  elements.modelListbox.classList.toggle("is-above", openAbove);
  elements.modelListbox.style.maxHeight = `${Math.max(120, Math.min(260, openAbove ? above : below))}px`;
}

function pickModel(id) {
  elements.modelInput.value = id;
  closeModelList();
  elements.modelInput.focus();
  showModelNotice();
}

function moveModelActive(step) {
  const count = popupState.modelVisible.length;

  if (!count) {
    return;
  }

  const next = popupState.modelActiveIndex + step;
  popupState.modelActiveIndex = next < 0 ? count - 1 : next >= count ? 0 : next;
  renderModelList();
}

function handleModelKeydown(event) {
  // While an IME is composing, arrows pick candidates and Enter commits the text: those
  // keys belong to the input method, not to the list.
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  const hasSuggestions = Boolean(popupState.modelResult?.models.length);

  if (event.key === "ArrowDown" && hasSuggestions) {
    event.preventDefault();
    if (!isModelListOpen()) {
      openModelList("");
    }
    moveModelActive(1);
    return;
  }

  if (!isModelListOpen()) {
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveModelActive(-1);
  } else if (event.key === "Enter" && popupState.modelActiveIndex >= 0) {
    // Only an option the user moved to is taken; otherwise Enter saves what was typed.
    event.preventDefault();
    pickModel(popupState.modelVisible[popupState.modelActiveIndex]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeModelList();
  } else if (event.key === "Enter" || event.key === "Tab") {
    closeModelList();
  }
}

function bindModelCombo() {
  elements.modelInput.addEventListener("keydown", handleModelKeydown);
  elements.modelInput.addEventListener("input", () => openModelList(elements.modelInput.value));
  elements.modelInput.addEventListener("click", () => {
    if (!isModelListOpen()) {
      openModelList("");
    }
  });
  elements.modelInput.addEventListener("change", showModelNotice);

  // Keep focus in the input while clicking the arrow or an option.
  elements.modelToggle.addEventListener("mousedown", (event) => event.preventDefault());
  elements.modelToggle.addEventListener("click", () => {
    if (isModelListOpen()) {
      closeModelList();
      return;
    }
    elements.modelInput.focus();
    openModelList("");
  });
  elements.modelListbox.addEventListener("mousedown", (event) => {
    if (event.target.closest("[data-value]")) {
      event.preventDefault();
    }
  });
  elements.modelListbox.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (option) {
      pickModel(option.dataset.value);
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (isModelListOpen() && !elements.modelCombo.contains(event.target)) {
      closeModelList();
    }
  });
  window.addEventListener("resize", closeModelList);
}

function toggleApiKeyVisibility() {
  const isPassword = elements.apiKeyInput.type === "password";
  elements.apiKeyInput.type = isPassword ? "text" : "password";
  elements.toggleApiKeyButton.innerHTML = `<span aria-hidden="true">${isPassword ? "🙈" : "👁"}</span>`;
}

async function deleteTemplate(templateId) {
  const state = await StorageService.update((draft) => {
    draft.templates = draft.templates.filter((template) => template.id !== templateId);

    if (!draft.templates.some((template) => template.id === draft.activeTemplateId)) {
      draft.activeTemplateId = draft.templates[0]?.id || "";
    }

    return draft;
  });

  const message = state.templates.length
    ? "模板已删除。"
    : "模板已删除，当前没有可用模板。";

  showStatus("template", message, "success");
}

// ---------------------------------------------------------------------------
// 备份 / 导出
//
// Excel 只装得下一个模板的字段，而模板列表、当前用哪一个、AI 配置都只活在
// chrome.storage.local 里。换电脑或者换扩展 ID 之后这些东西没有出口，所以这里
// 补一个 JSON 备份。配对信息和待同步队列不进备份，那些换个环境本来就要重来。
//
// data-privacy §4.1：API Key、密码、验证码这类东西不得出现在备份里，没有
// 「用户勾了就行」的例外。模板是用户自己填的表格，拦不住一行叫「登录密码」，
// 所以写文件前再过一道快照那套剔除规则。

async function handleExportBackup() {
  try {
    const state = await StorageService.getState();

    if (!state.templates.length) {
      showStatus("backup", "还没有模板可以导出。", "warning");
      return;
    }

    const { backup, omittedFieldCount } = buildBackup(state);

    BackupIO.saveJson(backupFileName(), backup);
    showStatus(
      "backup",
      omittedFieldCount
        ? `已导出 ${backup.templates.length} 个模板，跳过 ${omittedFieldCount} 个密码 / 验证码类字段。`
        : `已导出 ${backup.templates.length} 个模板。`,
      "success",
      omittedFieldCount ? 6000 : 2200
    );
  } catch (error) {
    showStatus("backup", `导出失败：${error.message}`, "error", 0);
  }
}

async function handleBackupFileSelection(event) {
  const [file] = event.target.files || [];
  elements.backupFileInput.value = "";
  hideBackupConfirm();

  if (!file) {
    return;
  }

  try {
    const backup = parseBackup(await file.text());
    const state = await StorageService.getState();

    // 刚装完、或者换了扩展 ID，没有东西可覆盖，直接恢复。
    if (!state.templates.length) {
      await applyAndSave(backup, "replace");
      return;
    }

    popupState.pendingBackup = backup;
    elements.backupConfirmText.textContent = `备份里有 ${backup.templates.length} 个模板。`;
    elements.backupConfirm.hidden = false;
    hideStatus("backup");
  } catch (error) {
    showStatus("backup", `导入失败：${error.message}`, "error", 0);
  }
}

async function commitPendingBackup(mode) {
  const backup = popupState.pendingBackup;

  if (!backup) {
    return;
  }

  hideBackupConfirm();

  try {
    await applyAndSave(backup, mode);
  } catch (error) {
    showStatus("backup", `导入失败：${error.message}`, "error", 0);
  }
}

async function applyAndSave(backup, mode) {
  const state = await StorageService.getState();
  await StorageService.saveState(applyBackup(state, backup, mode));
  await render();

  showStatus(
    "backup",
    mode === "replace"
      ? `已恢复 ${backup.templates.length} 个模板。`
      : `已追加 ${backup.templates.length} 个模板。`,
    "success"
  );
}

function hideBackupConfirm() {
  popupState.pendingBackup = null;
  elements.backupConfirm.hidden = true;
}

function buildBackup(state, { now = new Date() } = {}) {
  const { stripSecretFields } = self.ResumeProSecretFields;
  let omittedFieldCount = 0;

  const templates = state.templates.map((template) => {
    const stripped = stripSecretFields(template);
    omittedFieldCount += stripped.omittedFieldCount;
    return { id: template.id, name: template.name, groups: stripped.groups };
  });

  return {
    backup: {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      pluginVersion: chrome.runtime.getManifest().version,
      templates,
      activeTemplateId: state.activeTemplateId,
      // API Key 不进备份，换了机器重新填一次。
      aiConfig: { apiUrl: state.aiConfig.apiUrl, model: state.aiConfig.model }
    },
    omittedFieldCount
  };
}

function parseBackup(text) {
  let raw;

  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON。");
  }

  if (!raw || typeof raw !== "object" || raw.format !== BACKUP_FORMAT) {
    throw new Error("这不是 Resume Pro 的备份文件。");
  }

  const version = Number(raw.formatVersion);

  if (!Number.isInteger(version) || version < 1) {
    throw new Error("备份文件已损坏。");
  }

  if (version > BACKUP_FORMAT_VERSION) {
    throw new Error("备份来自更新版本的插件，请先更新插件。");
  }

  const templates = Array.isArray(raw.templates)
    ? raw.templates.map(normalizeTemplate).filter((template) => template && template.groups.length)
    : [];

  if (!templates.length) {
    throw new Error("备份里没有模板。");
  }

  return {
    templates,
    activeTemplateId: typeof raw.activeTemplateId === "string" ? raw.activeTemplateId : "",
    aiConfig: raw.aiConfig && typeof raw.aiConfig === "object" ? raw.aiConfig : null
  };
}

function applyBackup(state, backup, mode) {
  const next = structuredClone(state);
  const templates = mode === "replace" ? [] : next.templates;
  let activeTemplateId = "";

  backup.templates.forEach((template) => {
    const copy = structuredClone(template);

    // 追加时备份里的 id 可能已经在用，撞上就换一个，否则两张卡片指向同一个模板。
    if (templates.some((item) => item.id === copy.id)) {
      copy.id = crypto.randomUUID();
    }

    copy.name = resolveTemplateName(copy.name, templates);
    templates.push(copy);

    if (!activeTemplateId || template.id === backup.activeTemplateId) {
      activeTemplateId = copy.id;
    }
  });

  next.templates = templates;
  next.activeTemplateId = activeTemplateId || next.templates[0]?.id || "";

  if (backup.aiConfig) {
    const apiUrl = String(backup.aiConfig.apiUrl ?? next.aiConfig.apiUrl);

    next.aiConfig = {
      apiUrl,
      model: String(backup.aiConfig.model ?? next.aiConfig.model),
      // 备份里不会有 Key。地址没变就接着用本机这个；地址变了必须清掉，
      // 否则下一次请求会把用户的 Key 发到别人备份里的地址上。
      apiKey: apiUrl === next.aiConfig.apiUrl ? next.aiConfig.apiKey : ""
    };
  }

  return next;
}

async function exportTemplateToExcel(templateId) {
  const state = await StorageService.getState();
  const template = state.templates.find((item) => item.id === templateId);

  if (!template) {
    showStatus("template", "模板不存在。", "error", 0);
    return;
  }

  try {
    BackupIO.saveWorkbook(templateToSheetRows(template), templateExportFileName(template.name));
    showStatus("template", `已导出 ${countTemplateFields(template)} 个字段。`, "success");
  } catch (error) {
    showStatus("template", `导出失败：${error.message}`, "error", 0);
  }
}

// 表头和列序跟 parseTemplateFile 读的是同一套，导出的文件能原样再导回来。
// 这里不剔密码类字段：它是用户自己那份 Excel 的往返，剔了就导不回去了。
function templateToSheetRows(template) {
  const rows = [[...TEMPLATE_SHEET_HEADER]];

  (Array.isArray(template.groups) ? template.groups : []).forEach((group) => {
    (Array.isArray(group.fields) ? group.fields : []).forEach((field) => {
      rows.push([group.name, field.key, field.value]);
    });
  });

  return rows;
}

function backupFileName(now = new Date()) {
  return `resume-pro-backup-${formatDate(now)}.json`;
}

// 导入时模板名取自文件名，所以这里保留原名，只去掉文件系统不收的字符。
function templateExportFileName(templateName) {
  const safe = String(templateName ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim();

  return `${safe || "简历模板"}.xlsx`;
}

const BackupIO = {
  saveJson(fileName, data) {
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), fileName);
  },

  saveWorkbook(rows, fileName) {
    if (typeof XLSX === "undefined") {
      throw new Error("未找到 Excel 生成库。");
    }

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "简历模板");
    XLSX.writeFile(workbook, fileName);
  }
};

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // 立刻回收会让下载来不及读到数据，放到下一轮任务里。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function parseTemplateFile(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (!["xlsx", "csv"].includes(extension || "")) {
    throw new Error("仅支持 .xlsx 或 .csv 文件。");
  }

  if (typeof XLSX === "undefined") {
    throw new Error("未找到 Excel 解析库。");
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("文件中没有可用工作表。");
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    blankrows: false,
    defval: ""
  });

  if (!rows.length) {
    throw new Error("Excel 内容为空。");
  }

  const dataRows = rows.slice(1);
  const groupOrder = [];
  const groupMap = new Map();
  const missingKeyRows = [];

  dataRows.forEach((row, index) => {
    const groupName = String(row[0] ?? "").trim();
    const fieldKey = String(row[1] ?? "").trim();
    const fieldValue = String(row[2] ?? "").trim();

    if (!groupName && !fieldKey && !fieldValue) {
      return;
    }

    // Collect every offending row instead of stopping at the first one, so a hand-edited
    // sheet can be fixed in a single pass.
    if (!fieldKey) {
      missingKeyRows.push(index + 2);
      return;
    }

    if (!groupMap.has(groupName || "未分类")) {
      groupMap.set(groupName || "未分类", []);
      groupOrder.push(groupName || "未分类");
    }

    groupMap.get(groupName || "未分类").push({
      key: fieldKey,
      value: fieldValue
    });
  });

  if (missingKeyRows.length) {
    throw new Error(buildMissingKeyMessage(missingKeyRows));
  }

  const groups = groupOrder.map((groupName) => ({
    name: groupName,
    fields: groupMap.get(groupName)
  }));

  if (!groups.length) {
    throw new Error("未解析到任何字段，请检查 Excel 格式。");
  }

  return groups;
}

// A hand-edited sheet needs every offending row number, or the user fixes what is listed,
// re-imports and fails again. Past a couple of dozen the cause is almost always a shifted
// column rather than individual typos, and a wall of numbers helps nobody — so say that
// instead.
function buildMissingKeyMessage(rowNumbers) {
  if (rowNumbers.length > MAX_LISTED_ROW_NUMBERS) {
    return `共 ${rowNumbers.length} 行缺少「字段名」（第二列），请检查第二列是不是整列错位了。`;
  }

  return `第 ${rowNumbers.join("、")} 行缺少「字段名」（第二列）。`;
}

function getTemplateNameFromFile(fileName) {
  return fileName.replace(/\.[^.]+$/, "").trim() || "未命名模板";
}

function countTemplateFields(template) {
  if (!Array.isArray(template.groups)) {
    return 0;
  }

  return template.groups.reduce((total, group) => {
    const fields = Array.isArray(group.fields) ? group.fields.length : 0;
    return total + fields;
  }, 0);
}

const INLINE_STATUS_TYPES = new Set(["model", "url"]);

function statusBaseClass(type) {
  return INLINE_STATUS_TYPES.has(type) ? "status-message is-inline" : "status-message";
}

function showStatus(type, message, variant, autoHideDelay = 2200) {
  const element = elements[`${type}Status`];

  element.textContent = message;
  element.className = `${statusBaseClass(type)} is-visible is-${variant}`;

  if (popupState.statusTimers[type]) {
    clearTimeout(popupState.statusTimers[type]);
  }

  if (autoHideDelay > 0) {
    popupState.statusTimers[type] = setTimeout(() => hideStatus(type), autoHideDelay);
  }
}

function hideStatus(type) {
  const element = elements[`${type}Status`];
  clearTimeout(popupState.statusTimers[type]);
  element.className = statusBaseClass(type);
  element.textContent = "";
}

function normalizeStore(rawState) {
  const templates = Array.isArray(rawState.templates)
    ? rawState.templates
        .map(normalizeTemplate)
        .filter(Boolean)
    : [];

  const activeTemplateId = typeof rawState.activeTemplateId === "string"
    ? rawState.activeTemplateId
    : DEFAULT_STORE.activeTemplateId;

  const resolvedActiveTemplateId = templates.some((template) => template.id === activeTemplateId)
    ? activeTemplateId
    : templates[0]?.id || "";

  return {
    templates,
    activeTemplateId: resolvedActiveTemplateId,
    aiConfig: normalizeAiConfig(rawState.aiConfig)
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

function normalizeAiConfig(aiConfig) {
  const value = aiConfig && typeof aiConfig === "object" ? aiConfig : {};

  return {
    apiUrl: String(value.apiUrl ?? DEFAULT_STORE.aiConfig.apiUrl).trim() || DEFAULT_STORE.aiConfig.apiUrl,
    model: String(value.model ?? DEFAULT_STORE.aiConfig.model).trim() || DEFAULT_STORE.aiConfig.model,
    apiKey: String(value.apiKey ?? "")
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

async function initializeUpdateFeature() {
  const currentVersion = chrome.runtime.getManifest().version;
  elements.currentVersion.textContent = `当前 v${currentVersion}`;
  await checkForUpdates({ force: false, announce: false });
}

async function checkForUpdates({ force, announce }) {
  const currentVersion = chrome.runtime.getManifest().version;
  let cached = null;
  let dismissedVersion = null;
  elements.checkUpdateButton.disabled = true;

  if (announce) {
    elements.updateCheckStatus.textContent = "检查中...";
  }

  try {
    const stored = await chrome.storage.local.get([UPDATE_CACHE_KEY, UPDATE_DISMISSED_KEY]);
    cached = stored[UPDATE_CACHE_KEY];
    dismissedVersion = stored[UPDATE_DISMISSED_KEY];
    const cacheInterval = cached?.failed ? UPDATE_FAILURE_RETRY_MS : UPDATE_CHECK_INTERVAL_MS;

    if (!force && ResumeProUtils.shouldUseUpdateCache(cached?.checkedAt, Date.now(), cacheInterval)) {
      renderUpdateBanner(cached?.release || null, dismissedVersion, currentVersion);
      return;
    }

    const response = await fetch(UPDATE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json"
      }
    });

    if (response.status === 404) {
      await chrome.storage.local.set({
        [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), release: null, failed: false }
      });
      renderUpdateBanner(null, dismissedVersion, currentVersion);
      if (announce) elements.updateCheckStatus.textContent = "暂无正式版本";
      return;
    }

    if (!response.ok) {
      throw new Error(`GitHub API HTTP ${response.status}`);
    }

    const release = ResumeProUtils.normalizeRelease(await response.json());
    if (!release) {
      throw new Error("GitHub Release 响应无效");
    }

    await chrome.storage.local.set({
      [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), release, failed: false }
    });
    const hasUpdate = renderUpdateBanner(release, dismissedVersion, currentVersion);

    if (announce) {
      elements.updateCheckStatus.textContent = hasUpdate ? "发现新版" : "已是最新版";
    }
  } catch (error) {
    console.warn("Resume Pro update check failed:", error);
    await chrome.storage.local.set({
      [UPDATE_CACHE_KEY]: {
        checkedAt: Date.now(),
        release: cached?.release || null,
        failed: true
      }
    }).catch(() => {});
    renderUpdateBanner(cached?.release || null, dismissedVersion, currentVersion);
    if (announce) {
      elements.updateCheckStatus.textContent = "检查失败，不影响使用";
    }
  } finally {
    elements.checkUpdateButton.disabled = false;
  }
}

function renderUpdateBanner(release, dismissedVersion, currentVersion) {
  let hasUpdate = false;

  try {
    hasUpdate = Boolean(release)
      && ResumeProUtils.compareVersions(release.version, currentVersion) > 0
      && release.version !== dismissedVersion;
  } catch {
    hasUpdate = false;
  }

  popupState.availableRelease = hasUpdate ? release : null;
  elements.updateBanner.hidden = !hasUpdate;

  if (hasUpdate) {
    elements.updateTitle.textContent = `发现新版本 ${release.version}`;
    elements.updateSummary.textContent = release.summary;
  }

  return hasUpdate;
}

async function openAvailableRelease() {
  if (!popupState.availableRelease?.url) {
    return;
  }

  await chrome.tabs.create({ url: popupState.availableRelease.url });
}

async function dismissAvailableRelease() {
  if (!popupState.availableRelease?.version) {
    return;
  }

  await chrome.storage.local.set({
    [UPDATE_DISMISSED_KEY]: popupState.availableRelease.version
  });
  popupState.availableRelease = null;
  elements.updateBanner.hidden = true;
}

popupState.selectedParseFile = null;
popupState.statusTimers.parse = null;

document.addEventListener("DOMContentLoaded", () => {
  initResumeParsingFeature().catch((error) => {
    console.error("Resume Pro parse feature init failed:", error);
    showParseStatus(`解析功能初始化失败：${error.message}`, "error", 0);
  });
});

async function initResumeParsingFeature() {
  cacheParseElements();
  bindParseEvents();
  updateParseFileSelection(null);
}

function cacheParseElements() {
  elements.parseDropZone = document.getElementById("parse-drop-zone");
  elements.parseFileInput = document.getElementById("parse-file-input");
  elements.parseResumeButton = document.getElementById("parse-resume-button");
  elements.parseStatus = document.getElementById("parse-status");
  elements.parseDropLabel = document.getElementById("parse-drop-label");
}

function bindParseEvents() {
  if (!elements.parseDropZone || !elements.parseFileInput || !elements.parseResumeButton) {
    return;
  }

  elements.parseDropZone.addEventListener("click", () => {
    elements.parseFileInput.click();
  });

  elements.parseDropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.parseDropZone.classList.add("is-dragover");
  });

  elements.parseDropZone.addEventListener("dragleave", () => {
    elements.parseDropZone.classList.remove("is-dragover");
  });

  elements.parseDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.parseDropZone.classList.remove("is-dragover");
    const [file] = event.dataTransfer?.files || [];
    if (file) {
      updateParseFileSelection(file);
    }
  });

  elements.parseFileInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    updateParseFileSelection(file || null);
  });

  elements.parseResumeButton.addEventListener("click", handleParseResumeClick);
}

function updateParseFileSelection(file) {
  popupState.selectedParseFile = file || null;

  if (elements.parseFileInput) {
    elements.parseFileInput.value = "";
  }

  if (elements.parseDropLabel) {
    elements.parseDropLabel.textContent = file
      ? file.name
      : "拖拽简历文件到此处，或点击选择";
  }

  if (elements.parseDropZone) {
    elements.parseDropZone.classList.toggle("has-file", Boolean(file));
  }

  if (elements.parseResumeButton) {
    elements.parseResumeButton.disabled = !file;
  }
}

async function handleParseResumeClick() {
  const file = popupState.selectedParseFile;

  if (!file) {
    showParseStatus("请先选择简历文件。", "error", 0);
    return;
  }

  const state = await StorageService.getState();
  const aiConfig = normalizeAiConfig(state.aiConfig);

  if (!aiConfig.apiUrl || !aiConfig.model || !aiConfig.apiKey) {
    showParseStatus("请先配置 AI 接口。", "error", 0);
    return;
  }

  const extension = file.name.split(".").pop()?.toLowerCase();

  if (!["pdf", "docx", "txt"].includes(extension || "")) {
    showParseStatus("仅支持 PDF、Word(.docx) 或 TXT。", "error", 0);
    return;
  }

  elements.parseResumeButton.disabled = true;
  elements.parseResumeButton.textContent = "解析中...";
  showParseStatus("正在本地读取简历，然后调用 AI 提取信息...", "success", 0);

  try {
    const payload = await buildResumeParsePayload(file, extension);
    const result = await self.ResumeProAIClient.send({
      type: "PARSE_RESUME",
      fileType: payload.fileType,
      content: payload.content,
      aiConfig
    });

    if (!result?.success) {
      throw new Error(result?.error || "简历解析失败。");
    }

    generateAndDownloadExcel(result.fields);
    showParseStatus("Excel 已下载，请检查补充后导入插件。", "success");
    updateParseFileSelection(null);
  } catch (error) {
    showParseStatus(error.message || "简历解析失败。", "error", 0);
  } finally {
    elements.parseResumeButton.textContent = "开始解析";
    elements.parseResumeButton.disabled = !popupState.selectedParseFile;
  }
}

async function buildResumeParsePayload(file, extension) {
  if (extension === "txt") {
    return {
      fileType: "text",
      content: await readFileAsText(file)
    };
  }

  if (extension === "docx") {
    if (typeof mammoth === "undefined") {
      throw new Error("未找到 mammoth 解析库。");
    }

    const arrayBuffer = await readFileAsArrayBuffer(file, "读取 Word 文件失败。");
    const result = await mammoth.convertToHtml({ arrayBuffer });
    const textContent = extractTextFromHtml(result.value);

    if (!textContent.trim()) {
      throw new Error("Word 文件未解析到有效文本。");
    }

    return {
      fileType: "text",
      content: textContent
    };
  }

  if (extension === "pdf") {
    let pdfjsLib;
    let textContent;

    try {
      pdfjsLib = await loadPdfJs();
    } catch {
      throw new Error("PDF 解析组件加载失败，请在扩展管理页重新加载后重试。");
    }

    const arrayBuffer = await readFileAsArrayBuffer(file, "读取 PDF 文件失败。");

    try {
      textContent = await ResumeProUtils.extractPdfText(pdfjsLib, arrayBuffer, {
        cMapPacked: true,
        cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/")
      });
    } catch (error) {
      throw new Error(ResumeProUtils.getPdfExtractionErrorMessage(error));
    }

    if (!textContent.trim()) {
      throw new Error(
        "PDF 未检测到可提取文字，可能是扫描版。请改用 Word / TXT、先用 OCR，或将页面转成图片后交给视觉模型。"
      );
    }

    return {
      fileType: "text",
      content: textContent
    };
  }

  throw new Error("暂不支持该文件类型。");
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取 TXT 文件失败。"));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file, errorMessage) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(errorMessage));
    reader.readAsArrayBuffer(file);
  });
}

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import(chrome.runtime.getURL("vendor/pdfjs/pdf.min.mjs"))
      .then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
        return pdfjsLib;
      });
  }

  return pdfJsPromise;
}

function extractTextFromHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || "", "text/html");
  return (doc.body?.textContent || "").replace(/\s+\n/g, "\n").trim();
}

function generateAndDownloadExcel(fields) {
  if (typeof XLSX === "undefined") {
    throw new Error("未找到 Excel 生成库。");
  }

  const rawFields = Array.isArray(fields)
    ? fields
        .map((field) => ({
          group: String(field?.group ?? "").trim(),
          key: String(field?.key ?? "").trim(),
          value: String(field?.value ?? "")
        }))
        .filter((field) => field.group && field.key)
    : [];

  const normalizedFields = typeof ResumeProAIHelpers?.normalizeParsedFields === "function"
    ? ResumeProAIHelpers.normalizeParsedFields(rawFields)
    : rawFields;

  if (!normalizedFields.length) {
    throw new Error("AI 未能提取到有效信息，请检查文件内容。");
  }

  const rows = [
    [...TEMPLATE_SHEET_HEADER],
    ...normalizedFields.map((field) => [field.group, field.key, field.value])
  ];

  BackupIO.saveWorkbook(rows, `resume_parsed_${formatCurrentDate()}.xlsx`);
}

function formatCurrentDate() {
  return formatDate(new Date());
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function showParseStatus(message, variant, autoHideDelay = 2200) {
  if (!elements.parseStatus) {
    return;
  }

  elements.parseStatus.textContent = message;
  elements.parseStatus.className = `status-message is-visible is-${variant}`;

  if (popupState.statusTimers.parse) {
    clearTimeout(popupState.statusTimers.parse);
  }

  if (autoHideDelay > 0) {
    popupState.statusTimers.parse = setTimeout(() => {
      elements.parseStatus.className = "status-message";
      elements.parseStatus.textContent = "";
    }, autoHideDelay);
  }
}

if (typeof self !== "undefined" && self.__RESUME_PRO_TEST__) {
  self.ResumeProTemplateImportTest = {
    cacheElements,
    countTemplateFields,
    handleFileSelection,
    handleTemplateListClick,
    parseTemplateFile,
    popupState,
    resolveTemplateName,
    StorageService,
    backup: {
      applyBackup,
      BackupIO,
      buildBackup,
      commitPendingBackup,
      handleBackupFileSelection,
      handleExportBackup,
      parseBackup,
      templateExportFileName,
      templateToSheetRows
    }
  };
}
