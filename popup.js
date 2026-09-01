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
  statusTimers: {
    template: null,
    config: null
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
  elements.aiConfigForm = document.getElementById("ai-config-form");
  elements.apiUrlInput = document.getElementById("api-url-input");
  elements.modelInput = document.getElementById("model-input");
  elements.apiKeyInput = document.getElementById("api-key-input");
  elements.toggleApiKeyButton = document.getElementById("toggle-api-key");
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
  elements.templateList.addEventListener("click", handleTemplateListClick);
  elements.aiConfigForm.addEventListener("submit", handleConfigSubmit);
  elements.toggleApiKeyButton.addEventListener("click", toggleApiKeyVisibility);
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

  if (action === "delete") {
    await deleteTemplate(templateId);
  }
}

async function handleFileSelection(event) {
  const [file] = event.target.files || [];
  elements.templateFileInput.value = "";

  if (!file) {
    return;
  }

  try {
    const groups = await parseTemplateFile(file);
    const templateName = getTemplateNameFromFile(file.name);

    await StorageService.update((state) => {
      if (popupState.reimportTemplateId) {
        const target = state.templates.find((item) => item.id === popupState.reimportTemplateId);

        if (!target) {
          throw new Error("要重新导入的模板不存在。");
        }

        target.groups = groups;
        state.activeTemplateId = target.id;
      } else {
        const nextTemplate = {
          id: crypto.randomUUID(),
          name: templateName,
          groups
        };

        state.templates.unshift(nextTemplate);
        state.activeTemplateId = nextTemplate.id;
      }

      return state;
    });

    const successMessage = popupState.reimportTemplateId
      ? "模板已用新的 Excel 内容覆盖。"
      : "简历模板导入成功。";

    popupState.reimportTemplateId = "";
    showStatus("template", successMessage, "success");
  } catch (error) {
    popupState.reimportTemplateId = "";
    showStatus("template", `导入失败：${error.message}`, "error", 0);
  }
}

async function handleConfigSubmit(event) {
  event.preventDefault();

  const aiConfig = {
    apiUrl: elements.apiUrlInput.value.trim() || DEFAULT_STORE.aiConfig.apiUrl,
    model: elements.modelInput.value.trim() || DEFAULT_STORE.aiConfig.model,
    apiKey: elements.apiKeyInput.value.trim()
  };

  await StorageService.saveAiConfig(aiConfig);
  showStatus("config", "配置已保存。", "success");
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

  dataRows.forEach((row, index) => {
    const groupName = String(row[0] ?? "").trim();
    const fieldKey = String(row[1] ?? "").trim();
    const fieldValue = String(row[2] ?? "").trim();

    if (!groupName && !fieldKey && !fieldValue) {
      return;
    }

    if (!fieldKey) {
      throw new Error(`第 ${index + 2} 行缺少字段名。`);
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

  const groups = groupOrder.map((groupName) => ({
    name: groupName,
    fields: groupMap.get(groupName)
  }));

  if (!groups.length) {
    throw new Error("未解析到任何字段，请检查 Excel 格式。");
  }

  return groups;
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

function showStatus(type, message, variant, autoHideDelay = 2200) {
  const element = type === "config" ? elements.configStatus : elements.templateStatus;
  const timerKey = type === "config" ? "config" : "template";

  element.textContent = message;
  element.className = `status-message is-visible is-${variant}`;

  if (popupState.statusTimers[timerKey]) {
    clearTimeout(popupState.statusTimers[timerKey]);
  }

  if (autoHideDelay > 0) {
    popupState.statusTimers[timerKey] = setTimeout(() => {
      element.className = "status-message";
      element.textContent = "";
    }, autoHideDelay);
  }
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
  elements.checkUpdateButton.disabled = true;

  if (announce) {
    elements.updateCheckStatus.textContent = "检查中...";
  }

  try {
    const stored = await chrome.storage.local.get([UPDATE_CACHE_KEY, UPDATE_DISMISSED_KEY]);
    const cached = stored[UPDATE_CACHE_KEY];

    if (!force && ResumeProUtils.shouldUseUpdateCache(cached?.checkedAt, Date.now(), UPDATE_CHECK_INTERVAL_MS)) {
      renderUpdateBanner(cached?.release || null, stored[UPDATE_DISMISSED_KEY], currentVersion);
      return;
    }

    const response = await fetch(UPDATE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json"
      }
    });

    if (response.status === 404) {
      await chrome.storage.local.set({
        [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), release: null }
      });
      renderUpdateBanner(null, stored[UPDATE_DISMISSED_KEY], currentVersion);
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
      [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), release }
    });
    const hasUpdate = renderUpdateBanner(release, stored[UPDATE_DISMISSED_KEY], currentVersion);

    if (announce) {
      elements.updateCheckStatus.textContent = hasUpdate ? "发现新版" : "已是最新版";
    }
  } catch (error) {
    console.warn("Resume Pro update check failed:", error);
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
    const result = await chrome.runtime.sendMessage({
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
    let textContent;

    try {
      const pdfjsLib = await loadPdfJs();
      const arrayBuffer = await readFileAsArrayBuffer(file, "读取 PDF 文件失败。");
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
    ["一级分类", "字段名", "值"],
    ...normalizedFields.map((field) => [field.group, field.key, field.value])
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "简历模板");
  XLSX.writeFile(workbook, `resume_parsed_${formatCurrentDate()}.xlsx`);
}

function formatCurrentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
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
