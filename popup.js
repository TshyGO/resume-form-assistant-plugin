const DEFAULT_STORE = {
  templates: [],
  activeTemplateId: "",
  // aiConfig 始终是「当前正在使用」的那一份，给 content.js 等既有读取路径用。
  // 没有当前配置时 apiKey 为空，不会借其他已保存配置的 Key。
  aiConfig: {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiKey: ""
  },
  aiProfiles: [],
  activeAiProfileId: "",
  profile: {
    values: {},
    family: [],
    custom: []
  }
};

// 一个仓库同时有 desktop-v* 和 v* Release，通用 /releases/latest 可能指向桌面版。
const UPDATE_API_URL = "https://api.github.com/repos/TshyGO/resume-form-assistant-plugin/releases?per_page=100";
const UPDATE_CACHE_KEY = "resumeProUpdateCache";
const UPDATE_DISMISSED_KEY = "resumeProDismissedVersion";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_FAILURE_RETRY_MS = 60 * 60 * 1000;
const MAX_LISTED_ROW_NUMBERS = 20;
const TEMPLATE_SHEET_HEADER = ["一级分类", "字段名", "值"];
const BACKUP_FORMAT = "resume-pro.backup";
// 2 起备份里可以带「我的信息」。只有模板的备份仍写 1，旧版插件照样能导入；
// 带了档案的写 2，旧版插件会提示先更新，而不是悄悄丢掉档案。
// 3 起带上多份 AI 配置。只有一份时仍写 1 或 2，旧备份也能按原来的 aiConfig 导入。
const BACKUP_FORMAT_VERSION = 2;
const BACKUP_AI_PROFILES_VERSION = 3;
let pdfJsPromise = null;

const STORE_KEYS = Object.keys(DEFAULT_STORE);

// 设置页、侧边栏、别的标签页都会读写同一份 storage。读到快照再整份写回，中间别人刚存的
// 东西就会被旧快照盖掉，所以这里只写真正变了的键。
const StorageService = {
  async ensureDefaults() {
    const current = await chrome.storage.local.get(STORE_KEYS);
    const migration = migrationFromLegacyAi(current);
    const merged = { ...current, ...migration };
    const pending = {};

    for (const key of STORE_KEYS) {
      if (merged[key] === undefined) {
        pending[key] = structuredClone(DEFAULT_STORE[key]);
      } else if (current[key] === undefined && Object.prototype.hasOwnProperty.call(migration, key)) {
        pending[key] = migration[key];
      }
    }

    if (Object.keys(pending).length) {
      await chrome.storage.local.set(pending);
    }

    return normalizeStore({ ...merged, ...pending });
  },

  async getState() {
    const current = await chrome.storage.local.get(STORE_KEYS);

    if (current.aiProfiles === undefined) {
      return this.ensureDefaults();
    }

    return normalizeStore(current);
  },

  // 整份替换，只给备份恢复这种本来就要覆盖全部的场景用。
  async saveState(nextState) {
    const normalized = normalizeStore(nextState);
    await chrome.storage.local.set(normalized);
    return normalized;
  },

  async update(updater) {
    const current = await this.getState();
    const next = normalizeStore(await updater(structuredClone(current)));
    const changed = {};

    for (const key of STORE_KEYS) {
      if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) {
        changed[key] = next[key];
      }
    }

    if (Object.keys(changed).length) {
      await chrome.storage.local.set(changed);
    }

    return next;
  },

  async setActiveTemplate(templateId) {
    return this.update((state) => {
      state.activeTemplateId = templateId;
      return state;
    });
  },

  // 旧调用方只认识「当前这一份」。有当前配置就改这一份；没有就新建并启用。
  // 不会去改列表里其他配置的 Key。
  async saveAiConfig(aiConfig) {
    return this.update((state) => {
      const next = normalizeAiConfig(aiConfig);
      const active = state.aiProfiles.find((profile) => profile.id === state.activeAiProfileId);

      if (active) {
        active.apiUrl = next.apiUrl;
        active.model = next.model;
        active.apiKey = next.apiKey;
        return state;
      }

      if (!next.apiKey) {
        return state;
      }

      const profile = {
        id: crypto.randomUUID(),
        name: profileNameFromUrl(next.apiUrl, state.aiProfiles),
        apiUrl: next.apiUrl,
        model: next.model,
        apiKey: next.apiKey
      };
      state.aiProfiles.push(profile);
      state.activeAiProfileId = profile.id;
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
  profileDirty: false,
  profileRowSeq: 0,
  aiForm: { mode: "new", editingId: "", dirty: false },
  pendingAiDeleteId: "",
  renamingAiProfileId: "",
  statusTimers: {
    profile: null,
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
  applyTabFromHash();
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
  elements.backupIncludeKey = document.getElementById("backup-include-key");
  elements.backupKeyConfirm = document.getElementById("backup-key-confirm");
  elements.backupKeyConfirmButton = document.getElementById("backup-key-confirm-button");
  elements.backupKeyCancelButton = document.getElementById("backup-key-cancel-button");
  elements.backupConfirm = document.getElementById("backup-confirm");
  elements.backupConfirmText = document.getElementById("backup-confirm-text");
  elements.backupAppendButton = document.getElementById("backup-append-button");
  elements.backupReplaceButton = document.getElementById("backup-replace-button");
  elements.backupCancelButton = document.getElementById("backup-cancel-button");
  elements.aiConfigForm = document.getElementById("ai-config-form");
  elements.aiNewProfile = document.getElementById("ai-new-profile");
  elements.aiCurrentLabel = document.getElementById("ai-current-label");
  elements.aiProfileList = document.getElementById("ai-profile-list");
  elements.aiProfileName = document.getElementById("ai-profile-name");
  elements.aiDeleteConfirm = document.getElementById("ai-delete-confirm");
  elements.aiDeleteText = document.getElementById("ai-delete-text");
  elements.aiDeleteNext = document.getElementById("ai-delete-next");
  elements.aiDeleteConfirmButton = document.getElementById("ai-delete-confirm-button");
  elements.aiDeleteCancelButton = document.getElementById("ai-delete-cancel-button");
  elements.aiRenameRow = document.getElementById("ai-rename-row");
  elements.aiRenameInput = document.getElementById("ai-rename-input");
  elements.aiRenameSave = document.getElementById("ai-rename-save");
  elements.aiRenameCancel = document.getElementById("ai-rename-cancel");
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
  elements.profileForm = document.getElementById("profile-form");
  elements.profilePreset = document.getElementById("profile-preset");
  elements.profileFamily = document.getElementById("profile-family");
  elements.profileCustom = document.getElementById("profile-custom");
  elements.profileAddMember = document.getElementById("profile-add-member");
  elements.profileAddCustom = document.getElementById("profile-add-custom");
  elements.profileStatus = document.getElementById("profile-status");
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
  elements.backupKeyConfirmButton.addEventListener("click", () => exportBackup(true));
  elements.backupKeyCancelButton.addEventListener("click", hideKeyConfirm);
  elements.backupIncludeKey.addEventListener("change", hideKeyConfirm);
  elements.importBackupButton.addEventListener("click", () => {
    hideBackupConfirm();
    hideKeyConfirm();
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
  elements.aiProfileList.addEventListener("click", handleAiProfileListClick);
  elements.aiNewProfile.addEventListener("click", beginNewAiProfile);
  elements.aiDeleteConfirmButton.addEventListener("click", confirmDeleteAiProfile);
  elements.aiDeleteCancelButton.addEventListener("click", hideAiDeleteConfirm);
  elements.aiRenameSave.addEventListener("click", confirmRenameAiProfile);
  elements.aiRenameCancel.addEventListener("click", hideAiRename);
  elements.aiConfigForm.addEventListener("submit", handleConfigSubmit);
  elements.aiConfigForm.addEventListener("input", () => {
    popupState.aiForm.dirty = true;
  });
  elements.profileForm.addEventListener("submit", handleProfileSubmit);
  elements.profileForm.addEventListener("input", markProfileDirty);
  elements.profileForm.addEventListener("change", markProfileDirty);
  elements.profileForm.addEventListener("click", handleProfileRemoveClick);
  elements.profileAddMember.addEventListener("click", () => {
    elements.profileFamily.insertAdjacentHTML("beforeend", familyRowHtml({ relation: "父亲" }));
    markProfileDirty();
  });
  elements.profileAddCustom.addEventListener("click", () => {
    elements.profileCustom.insertAdjacentHTML("beforeend", customRowHtml({ key: "", value: "" }));
    markProfileDirty();
  });
  // 侧边栏把空字段加进来之后，会带着 #profile 打开管理面板。
  self.addEventListener?.("hashchange", applyTabFromHash);
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

    // 正在改的表单不重画，否则没保存的输入会被冲掉；提醒一句保存会覆盖别处的改动。
    if (changes.profile && popupState.profileDirty) {
      showStatus("profile", "「我的信息」在别处被改过了，现在保存会覆盖那边的修改。", "warning", 0);
    }

    if (changes.templates || changes.activeTemplateId || changes.aiConfig || changes.aiProfiles || changes.activeAiProfileId || changes.profile) {
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
  renderAiSection(state);
  if (!popupState.profileDirty) renderProfile(state.profile);
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

function renderAiSection(state) {
  renderAiProfileList(state);

  if (popupState.aiForm.dirty) {
    return;
  }

  const active = state.aiProfiles.find((profile) => profile.id === state.activeAiProfileId);

  if (active) {
    popupState.aiForm = { mode: "edit", editingId: active.id, dirty: false };
    fillAiForm(active);
    return;
  }

  popupState.aiForm = { mode: "new", editingId: "", dirty: false };
  fillAiForm({ name: "", apiUrl: "", model: "", apiKey: "" });
}

function renderAiProfileList(state) {
  const active = state.aiProfiles.find((profile) => profile.id === state.activeAiProfileId);
  elements.aiCurrentLabel.textContent = active
    ? `当前使用的配置：${active.name}`
    : "当前使用的配置：未配置";

  if (!state.aiProfiles.length) {
    elements.aiProfileList.innerHTML = `<p class="empty-state">还没有已保存的配置。填完下面的表单后点「保存并使用」。</p>`;
    return;
  }

  elements.aiProfileList.innerHTML = state.aiProfiles.map((profile) => {
    const isActive = profile.id === state.activeAiProfileId;
    const keyNote = profile.apiKey ? "Key 已保存" : "Key 未填写";

    return `
      <article class="ai-profile ${isActive ? "is-active" : ""}" data-profile-id="${escapeHtml(profile.id)}">
        <div class="ai-profile__main">
          <strong>${escapeHtml(profile.name)}</strong>
          <span>${escapeHtml(profileHost(profile.apiUrl))} · ${escapeHtml(profile.model)} · ${keyNote}</span>
        </div>
        <div class="ai-profile__actions">
          ${isActive ? "" : '<button class="secondary-button" type="button" data-action="use">使用</button>'}
          <button class="text-button" type="button" data-action="rename">重命名</button>
          <button class="text-button" type="button" data-action="edit">编辑</button>
          <button class="text-button" type="button" data-action="delete">删除</button>
        </div>
      </article>
    `;
  }).join("");
}

function fillAiForm(profile) {
  elements.aiProfileName.value = profile.name || "";
  elements.apiUrlInput.value = profile.apiUrl || "";
  elements.modelInput.value = profile.model || "";
  elements.apiKeyInput.value = profile.apiKey || "";
  updateUrlWarning();
}

function beginNewAiProfile() {
  popupState.aiForm = { mode: "new", editingId: "", dirty: true };
  fillAiForm({ name: "", apiUrl: "", model: "", apiKey: "" });
  clearModelSuggestions();
  hideAiDeleteConfirm();
  hideAiRename();
  showStatus("config", "正在新建配置。Key 不会从当前配置带过来。", "success", 4000);
}

async function beginEditAiProfile(id) {
  const state = await StorageService.getState();
  const profile = state.aiProfiles.find((item) => item.id === id);

  if (!profile) {
    return;
  }

  popupState.aiForm = { mode: "edit", editingId: id, dirty: true };
  fillAiForm(profile);
  clearModelSuggestions();
  hideAiDeleteConfirm();
  showStatus("config", `正在编辑「${profile.name}」。保存后只更新这一份。`, "success", 4000);
}

async function handleAiProfileListClick(event) {
  const button = event.target.closest("[data-action]");

  if (!button || !elements.aiProfileList.contains(button)) {
    return;
  }

  const id = button.closest("[data-profile-id]")?.dataset.profileId;

  if (!id) {
    return;
  }

  if (button.dataset.action === "use") {
    await activateAiProfile(id);
    return;
  }

  if (button.dataset.action === "edit") {
    await beginEditAiProfile(id);
    return;
  }

  if (button.dataset.action === "rename") {
    await beginRenameAiProfile(id);
    return;
  }

  if (button.dataset.action === "delete") {
    await requestDeleteAiProfile(id);
  }
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

async function activateAiProfile(id) {
  popupState.aiForm.dirty = false;
  const state = await StorageService.update((draft) => {
    if (draft.aiProfiles.some((profile) => profile.id === id)) {
      draft.activeAiProfileId = id;
    }

    return draft;
  });
  const active = state.aiProfiles.find((profile) => profile.id === state.activeAiProfileId);
  showStatus("config", active ? `已改用「${active.name}」。` : "没有找到这份配置。", active ? "success" : "error");
  await render();
}

async function beginRenameAiProfile(id) {
  const state = await StorageService.getState();
  const profile = state.aiProfiles.find((item) => item.id === id);

  if (!profile) {
    return;
  }

  popupState.renamingAiProfileId = id;
  elements.aiRenameInput.value = profile.name;
  elements.aiRenameRow.hidden = false;
  hideAiDeleteConfirm();
}

function hideAiRename() {
  popupState.renamingAiProfileId = "";
  elements.aiRenameRow.hidden = true;
}

async function confirmRenameAiProfile() {
  const id = popupState.renamingAiProfileId;
  const name = elements.aiRenameInput.value.trim();

  if (!id) {
    return;
  }

  if (!name) {
    showStatus("config", "配置名称不能为空。", "error", 0);
    return;
  }

  await renameAiProfile(id, name);
  hideAiRename();
  showStatus("config", "名称已更新。", "success");
  await render();
}

async function renameAiProfile(id, name) {
  const trimmed = String(name ?? "").trim().slice(0, 80);

  if (!trimmed) {
    return StorageService.getState();
  }

  return StorageService.update((draft) => {
    const profile = draft.aiProfiles.find((item) => item.id === id);

    if (profile) {
      profile.name = trimmed;
    }

    return draft;
  });
}

async function requestDeleteAiProfile(id) {
  const state = await StorageService.getState();
  const profile = state.aiProfiles.find((item) => item.id === id);

  if (!profile) {
    return;
  }

  if (profile.id !== state.activeAiProfileId) {
    await deleteAiProfile(id);
    showStatus("config", `已删除「${profile.name}」。当前配置没有变。`, "success");
    await render();
    return;
  }

  const others = state.aiProfiles.filter((item) => item.id !== id);
  elements.aiDeleteNext.innerHTML = [
    ...others.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`),
    `<option value="">进入未配置状态</option>`
  ].join("");
  elements.aiDeleteText.textContent = `要删除当前配置「${profile.name}」。请选择之后用哪一份；不会自动改用其他配置的 Key。`;
  elements.aiDeleteConfirm.hidden = false;
  popupState.pendingAiDeleteId = id;
  hideAiRename();
}

function hideAiDeleteConfirm() {
  popupState.pendingAiDeleteId = "";
  elements.aiDeleteConfirm.hidden = true;
}

async function confirmDeleteAiProfile() {
  const id = popupState.pendingAiDeleteId;

  if (!id) {
    return;
  }

  const nextId = elements.aiDeleteNext.value;
  hideAiDeleteConfirm();
  popupState.aiForm.dirty = false;
  await deleteAiProfile(id, nextId);
  showStatus(
    "config",
    nextId ? "已删除当前配置，并改用所选的那一份。" : "已删除当前配置，现在是未配置状态。",
    "success"
  );
  await render();
}

// nextId 只有在删的是当前配置时才有意义：有值就改用那一份，空字符串表示进入未配置。
// 不传 nextId 时拒绝删除当前配置，避免静默落到另一份的 Key 上。
async function deleteAiProfile(id, nextId) {
  const state = await StorageService.getState();
  const isActive = state.activeAiProfileId === id;

  if (isActive && nextId === undefined) {
    throw new Error("删除当前配置时要选择另一份，或明确进入未配置状态。");
  }

  return StorageService.update((draft) => {
    const stillActive = draft.activeAiProfileId === id;
    draft.aiProfiles = draft.aiProfiles.filter((profile) => profile.id !== id);

    if (!stillActive) {
      return draft;
    }

    if (nextId && draft.aiProfiles.some((profile) => profile.id === nextId)) {
      draft.activeAiProfileId = nextId;
    } else {
      draft.activeAiProfileId = "";
    }

    return draft;
  });
}

async function handleConfigSubmit(event) {
  event.preventDefault();

  const typedUrl = elements.apiUrlInput.value.trim();
  const model = elements.modelInput.value.trim();
  const apiKey = elements.apiKeyInput.value.trim();
  const name = elements.aiProfileName.value.trim();

  if (!typedUrl || !model || !apiKey) {
    showStatus("config", "请把 API URL、API Key 和模型名称都填完后再保存。未完成的配置不会启用。", "error", 0);
    return;
  }

  const editingId = popupState.aiForm.mode === "edit" ? popupState.aiForm.editingId : "";
  const before = await StorageService.getState();
  const previous = before.aiProfiles.find((profile) => profile.id === editingId);
  const apiUrl = self.ResumeProModels.normalizeApiUrlForSave(typedUrl, previous?.apiUrl || "");

  if (editingId && !previous) {
    showStatus("config", "要编辑的配置已经不在了，没有保存。", "error", 0);
    return;
  }

  popupState.aiForm.dirty = false;
  const state = await StorageService.update((draft) => {
    if (previous) {
      const target = draft.aiProfiles.find((profile) => profile.id === editingId);
      target.name = name || target.name;
      target.apiUrl = apiUrl;
      target.model = model;
      target.apiKey = apiKey;
      draft.activeAiProfileId = target.id;
      return draft;
    }

    const profile = {
      id: crypto.randomUUID(),
      name: name || profileNameFromUrl(apiUrl, draft.aiProfiles),
      apiUrl,
      model,
      apiKey
    };
    draft.aiProfiles.push(profile);
    draft.activeAiProfileId = profile.id;
    return draft;
  });
  const saved = state.aiProfiles.find((profile) => profile.id === state.activeAiProfileId);
  popupState.aiForm = { mode: "edit", editingId: saved?.id || "", dirty: false };

  if (apiUrl !== typedUrl) {
    showStatus("config", `「${saved?.name || "配置"}」已保存并使用。API URL 已补全为 ${apiUrl}`, "success", 6000);
  } else {
    showStatus("config", `「${saved?.name || "配置"}」已保存并使用。`, "success");
  }

  await render();
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

// ---------------------------------------------------------------------------
// 我的信息
//
// 表单每个输入框带 data-kind / data-row / data-field，保存时整张表单读出来交给
// ResumeProProfile.profileFromEntries 还原，只写 profile 这一个键。

function applyTabFromHash() {
  const tab = typeof location !== "undefined" ? location.hash.replace(/^#/, "").split(":")[0] : "";

  if (tab && elements.tabPanels.some((panel) => panel.dataset.panel === tab)) {
    popupState.activeTab = tab;
    setActiveTab(tab);
  }
}

function renderProfile(profile) {
  const api = self.ResumeProProfile;

  elements.profilePreset.innerHTML = api.PROFILE_SCHEMA.map((group) => `
    <section class="profile-group">
      <h3 class="profile-group__title">${escapeHtml(group.name)}</h3>
      <div class="profile-grid">
        ${group.fields.map((field) => profileInputHtml(field, profile.values[field.id] || "", `data-kind="value" data-field="${escapeHtml(field.id)}"`)).join("")}
      </div>
    </section>
  `).join("");
  elements.profileFamily.innerHTML = profile.family.map(familyRowHtml).join("");
  elements.profileCustom.innerHTML = profile.custom.map(customRowHtml).join("");
  popupState.profileDirty = false;
}

function profileInputHtml(field, value, dataAttributes) {
  const id = `profile-input-${++popupState.profileRowSeq}`;
  const label = `<label for="${id}"><span>${escapeHtml(field.label || field.key)}</span></label>`;
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";

  if (field.type === "select") {
    // 备份里带来的值不在选项里时也要显示出来，不能保存一次就悄悄丢掉。
    const options = !value || field.options.includes(value) ? field.options : [...field.options, value];
    return `
      <div class="field-block">
        ${label}
        <select id="${id}" ${dataAttributes}>
          <option value=""></option>
          ${options.map((option) => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(option)}</option>`).join("")}
        </select>
      </div>
    `;
  }

  if (field.type === "textarea") {
    return `
      <div class="field-block profile-field--wide">
        ${label}
        <textarea id="${id}" rows="2" ${dataAttributes}${placeholder}>${escapeHtml(value)}</textarea>
      </div>
    `;
  }

  return `
    <div class="field-block">
      ${label}
      <input id="${id}" type="${field.type === "month" ? "month" : "text"}" value="${escapeHtml(value)}" autocomplete="off" ${dataAttributes}${placeholder}>
    </div>
  `;
}

function familyRowHtml(member) {
  const api = self.ResumeProProfile;
  const row = ++popupState.profileRowSeq;
  const attributes = (field) => `data-kind="family" data-row="${row}" data-field="${field}"`;

  return `
    <div class="profile-row">
      ${profileInputHtml({ key: "关系", type: "select", options: api.FAMILY_RELATIONS }, member.relation || "", attributes("relation"))}
      ${api.FAMILY_FIELDS.map((field) => profileInputHtml(field, member[field.id] || "", attributes(field.id))).join("")}
      <div class="profile-row__actions">
        <button class="text-button" type="button" data-remove-row>删除</button>
      </div>
    </div>
  `;
}

function customRowHtml(item) {
  const row = ++popupState.profileRowSeq;
  const attributes = (field) => `data-kind="custom" data-row="${row}" data-field="${field}"`;

  return `
    <div class="profile-row${item.key && !item.value ? " is-pending" : ""}">
      ${profileInputHtml({ key: "字段名" }, item.key, attributes("key"))}
      ${profileInputHtml({ key: "内容" }, item.value, attributes("value"))}
      <div class="profile-row__actions">
        <button class="text-button" type="button" data-remove-row>删除</button>
      </div>
    </div>
  `;
}

function readProfileForm() {
  const entries = Array.from(elements.profileForm.querySelectorAll("[data-kind]")).map((input) => ({
    kind: input.dataset.kind,
    row: input.dataset.row,
    field: input.dataset.field,
    value: input.value
  }));

  return self.ResumeProProfile.profileFromEntries(entries);
}

async function handleProfileSubmit(event) {
  event.preventDefault();
  await saveProfile(readProfileForm());
}

async function saveProfile(profile) {
  const api = self.ResumeProProfile;
  const state = await StorageService.update((draft) => {
    draft.profile = profile;
    return draft;
  });

  renderProfile(state.profile);

  const count = api.countProfileValues(state.profile);
  const pending = api.countPendingFields(state.profile);

  showStatus(
    "profile",
    pending ? `已保存 ${count} 项，还有 ${pending} 个字段没填内容。` : `已保存 ${count} 项。`,
    "success",
    pending ? 0 : 2200
  );

  return state;
}

function markProfileDirty() {
  popupState.profileDirty = true;
}

function handleProfileRemoveClick(event) {
  const button = event.target.closest?.("[data-remove-row]");

  if (!button) {
    return;
  }

  button.closest(".profile-row")?.remove();
  markProfileDirty();
}

// 备份和模板一样过一遍密码 / 验证码剔除。补充字段是用户自己起的名，拦不住一行叫「登录密码」。
function stripProfileSecrets(profile) {
  const { isSecretFieldName, isSecretFieldValue } = self.ResumeProSecretFields;
  const next = self.ResumeProProfile.normalizeProfile(profile);
  let omitted = 0;

  for (const [id, value] of Object.entries(next.values)) {
    if (isSecretFieldValue(value)) {
      delete next.values[id];
      omitted += 1;
    }
  }

  next.custom = next.custom.filter((item) => {
    const secret = isSecretFieldName(item.key) || isSecretFieldValue(item.value);
    if (secret) omitted += 1;
    return !secret;
  });

  for (const member of next.family) {
    for (const field of self.ResumeProProfile.FAMILY_FIELDS) {
      if (member[field.id] && isSecretFieldValue(member[field.id])) {
        member[field.id] = "";
        omitted += 1;
      }
    }
  }
  next.family = self.ResumeProProfile.normalizeProfile({ family: next.family }).family;

  return { profile: next, omitted };
}

function describeBackupContents(backup) {
  const parts = [];
  if (backup.templates.length) parts.push(`${backup.templates.length} 个模板`);
  if (backup.profile) parts.push("我的信息");
  return parts.join("和");
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
// data-privacy §4.1：密码、验证码这类东西不得出现在备份里。模板是用户自己填的
// 表格，拦不住一行叫「登录密码」，所以写文件前再过一道快照那套剔除规则。
// API Key 走 §4.1.1 的例外：默认不含，用户勾选并再确认一次才写进去。

async function handleExportBackup() {
  const state = await StorageService.getState();

  if (!state.templates.length && !self.ResumeProProfile.hasProfileContent(state.profile)) {
    showStatus("backup", "还没有模板或我的信息可以导出。", "warning");
    return;
  }

  // 勾选框太容易顺手点上，真要写 Key 进文件之前再拦一次（data-privacy §4.1.1）。
  const hasExportableKey = state.aiProfiles.some((profile) => profile.apiKey) || Boolean(state.aiConfig.apiKey);

  if (elements.backupIncludeKey.checked && hasExportableKey) {
    elements.backupKeyConfirm.hidden = false;
    hideStatus("backup");
    return;
  }

  await exportBackup(false);
}

async function exportBackup(includeApiKey) {
  hideKeyConfirm();

  try {
    const state = await StorageService.getState();
    const report = buildBackup(state, { includeApiKey });

    BackupIO.saveJson(backupFileName(), report.backup);

    const notes = [];
    if (report.omittedFieldCount) notes.push(`跳过 ${report.omittedFieldCount} 个密码 / 验证码类字段`);
    if (report.droppedTemplateCount) notes.push(`${report.droppedTemplateCount} 个模板因此没有内容，未写入`);
    if (report.endpointRedacted) notes.push("接口地址里的凭据参数已去掉");

    showStatus(
      "backup",
      notes.length
        ? `已导出 ${describeBackupContents(report.backup)}，${notes.join("，")}。`
        : `已导出 ${describeBackupContents(report.backup)}。`,
      "success",
      notes.length ? 6000 : 2200
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
    if (!state.templates.length && !self.ResumeProProfile.hasProfileContent(state.profile)) {
      await applyAndSave(backup, "replace");
      return;
    }

    popupState.pendingBackup = backup;
    elements.backupConfirmText.textContent = `备份里有 ${describeBackupContents(backup)}。`;
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
      ? `已恢复 ${describeBackupContents(backup)}。`
      : `已追加 ${describeBackupContents(backup)}。`,
    "success"
  );
}

function hideKeyConfirm() {
  elements.backupKeyConfirm.hidden = true;
}

function hideBackupConfirm() {
  popupState.pendingBackup = null;
  elements.backupConfirm.hidden = true;
}

function buildBackup(state, { includeApiKey = false, now = new Date() } = {}) {
  const { redactUrlCredentials, stripSecretFields } = self.ResumeProSecretFields;
  let omittedFieldCount = 0;

  const templates = [];
  let droppedTemplateCount = 0;

  for (const template of state.templates) {
    const stripped = stripSecretFields(template);
    omittedFieldCount += stripped.omittedFieldCount;

    // 一个字段都不剩的模板不写进文件：导入侧会把它丢掉，整份备份还会因此变成
    // 「备份里没有模板」，导出成功却恢复不了。
    if (!stripped.groups.length) {
      droppedTemplateCount += 1;
      continue;
    }

    templates.push({ id: template.id, name: template.name, groups: stripped.groups });
  }

  const strippedProfile = stripProfileSecrets(state.profile);
  const includeProfile = self.ResumeProProfile.hasProfileContent(strippedProfile.profile);
  omittedFieldCount += strippedProfile.omitted;

  if (!templates.length && !includeProfile) {
    throw new Error("剩下的内容都是密码 / 验证码这类，没有可以写进备份的内容。");
  }

  const active = state.aiProfiles.find((profile) => profile.id === state.activeAiProfileId) || null;
  const currentSource = active
    ? { apiUrl: active.apiUrl, model: active.model, apiKey: active.apiKey }
    : state.aiConfig;
  const currentExport = exportAiEndpoint(currentSource, includeApiKey, redactUrlCredentials);
  let endpointRedacted = currentExport.changed;
  let formatVersion = includeProfile ? BACKUP_FORMAT_VERSION : 1;
  let aiProfiles;

  // 只有一份时保持旧备份形状，旧插件仍能导入。两份及以上写成版本 3，
  // 避免旧插件只看见当前这一份、把其余配置悄悄丢掉。
  if (state.aiProfiles.length >= 2) {
    formatVersion = BACKUP_AI_PROFILES_VERSION;
    aiProfiles = state.aiProfiles.map((profile) => {
      const exported = exportAiEndpoint(profile, includeApiKey, redactUrlCredentials);
      endpointRedacted = endpointRedacted || exported.changed;
      return {
        id: profile.id,
        name: profile.name,
        ...exported.config
      };
    });
  }

  return {
    backup: {
      format: BACKUP_FORMAT,
      formatVersion,
      exportedAt: now.toISOString(),
      pluginVersion: chrome.runtime.getManifest().version,
      templates,
      activeTemplateId: state.activeTemplateId,
      ...(includeProfile ? { profile: strippedProfile.profile } : {}),
      aiConfig: currentExport.config,
      ...(aiProfiles ? { aiProfiles, activeAiProfileId: state.activeAiProfileId } : {})
    },
    omittedFieldCount,
    droppedTemplateCount,
    endpointRedacted
  };
}

function exportAiEndpoint(config, includeApiKey, redactUrlCredentials) {
  const endpoint = includeApiKey
    ? { url: config.apiUrl, changed: false }
    : redactUrlCredentials(config.apiUrl);
  const exported = { apiUrl: endpoint.url, model: config.model };

  if (includeApiKey && config.apiKey) {
    exported.apiKey = config.apiKey;
  }

  return { config: exported, changed: endpoint.changed };
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

  if (version > BACKUP_AI_PROFILES_VERSION) {
    throw new Error("备份来自更新版本的插件，请先更新插件。");
  }

  const templates = Array.isArray(raw.templates)
    ? raw.templates.map(normalizeTemplate).filter((template) => template && template.groups.length)
    : [];

  const profile = raw.profile && typeof raw.profile === "object"
    ? self.ResumeProProfile.normalizeProfile(raw.profile)
    : null;
  const hasProfile = Boolean(profile && self.ResumeProProfile.hasProfileContent(profile));

  if (!templates.length && !hasProfile) {
    throw new Error("备份里没有模板。");
  }

  return {
    templates,
    activeTemplateId: typeof raw.activeTemplateId === "string" ? raw.activeTemplateId : "",
    aiConfig: raw.aiConfig && typeof raw.aiConfig === "object" ? raw.aiConfig : null,
    aiProfiles: Array.isArray(raw.aiProfiles) ? raw.aiProfiles : null,
    activeAiProfileId: typeof raw.activeAiProfileId === "string" ? raw.activeAiProfileId : "",
    profile: hasProfile ? profile : null
  };
}

function applyBackup(state, backup, mode) {
  const next = structuredClone(state);
  // 只有「我的信息」的备份，替换也不能把本机模板清空。
  const templates = mode === "replace" && backup.templates.length ? [] : next.templates;
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
  next.activeTemplateId = activeTemplateId
    || (templates.some((template) => template.id === state.activeTemplateId) ? state.activeTemplateId : "")
    || next.templates[0]?.id
    || "";

  // 旧备份没有这一项，本机的保持不动；追加时本机已填的不被覆盖。
  if (backup.profile) {
    next.profile = mode === "replace"
      ? backup.profile
      : self.ResumeProProfile.mergeProfiles(next.profile, backup.profile);
  }

  if (!Array.isArray(next.aiProfiles)) {
    next.aiProfiles = [];
  }

  if (Array.isArray(backup.aiProfiles) && backup.aiProfiles.length) {
    applySavedAiProfiles(next, backup, mode);
  } else if (backup.aiConfig) {
    applyLegacyAiConfig(next, backup.aiConfig, mode);
  }

  return next;
}

function applyLegacyAiConfig(next, rawConfig, mode) {
  const previous = { ...next.aiConfig };
  const apiUrl = String(rawConfig.apiUrl ?? previous.apiUrl);
  const backupKey = typeof rawConfig.apiKey === "string" ? rawConfig.apiKey : "";
  // 备份自己带 Key 的话，Key 和地址是一起导出的，配在一起是对的。备份没带 Key
  // 就只在地址没变时接着用本机这个；地址变了必须清掉，否则下一次请求会把用户的
  // Key 发到别人备份里的地址上。
  const apiKey = backupKey || (mode !== "append" && apiUrl === previous.apiUrl ? previous.apiKey : "");
  const model = String(rawConfig.model ?? previous.model);
  const active = next.aiProfiles.find((profile) => profile.id === next.activeAiProfileId);

  if (mode !== "append" && active && active.apiUrl === previous.apiUrl) {
    active.apiUrl = apiUrl;
    active.model = model;
    active.apiKey = apiKey;
    next.aiConfig = { apiUrl, model, apiKey };
    return;
  }

  const profile = {
    id: crypto.randomUUID(),
    name: profileNameFromUrl(apiUrl, next.aiProfiles),
    apiUrl,
    model,
    apiKey
  };
  next.aiProfiles.push(profile);
  next.activeAiProfileId = profile.id;
  next.aiConfig = { apiUrl, model, apiKey };
}

function applySavedAiProfiles(next, backup, mode) {
  const localById = new Map(next.aiProfiles.map((profile) => [profile.id, profile]));
  const restored = mode === "append" ? [...next.aiProfiles] : [];
  const usedIds = new Set(restored.map((profile) => profile.id));
  let importedActiveId = "";

  for (const raw of backup.aiProfiles) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const apiUrl = String(raw.apiUrl ?? "").trim();
    const model = String(raw.model ?? "").trim();

    if (!apiUrl || !model) {
      continue;
    }

    const sourceId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID();
    let id = sourceId;

    while (usedIds.has(id)) {
      id = crypto.randomUUID();
    }
    usedIds.add(id);
    const backupKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
    const local = mode === "append" ? null : localById.get(sourceId);
    // Key 只跟导出它的那一条、同一个地址走。地址变了，或这条在本机不存在，就不能借用别的 Key。
    const apiKey = backupKey || (local && local.apiUrl === apiUrl ? local.apiKey : "");
    restored.push({
      id,
      name: String(raw.name ?? "").trim() || profileNameFromUrl(apiUrl, restored),
      apiUrl,
      model,
      apiKey
    });

    if (!importedActiveId && sourceId === backup.activeAiProfileId) {
      importedActiveId = id;
    }
  }

  next.aiProfiles = restored;
  const activeId = importedActiveId || (mode === "append" ? next.activeAiProfileId : "");
  const active = restored.find((profile) => profile.id === activeId) || null;
  next.activeAiProfileId = active?.id || "";
  next.aiConfig = active
    ? { apiUrl: active.apiUrl, model: active.model, apiKey: active.apiKey }
    : unconfiguredAiConfig();
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

  const profiles = Array.isArray(rawState.aiProfiles)
    ? rawState.aiProfiles.map(normalizeAiProfile).filter(Boolean)
    : [];
  let activeId = typeof rawState.activeAiProfileId === "string" ? rawState.activeAiProfileId : "";
  let active = profiles.find((profile) => profile.id === activeId) || null;

  if (!active) {
    activeId = "";
  }

  // 直接写进来的完整 aiConfig（旧测试、以及还没迁移的保存）在列表为空时成为第一份。
  // 列表里已经有别的配置时不再收养，避免把这份 Key 安到另一条上。
  const incoming = normalizeAiConfig(rawState.aiConfig);

  if (!active && profiles.length === 0 && isCompleteAi(incoming)) {
    const profile = {
      id: crypto.randomUUID(),
      name: profileNameFromUrl(incoming.apiUrl, profiles),
      apiUrl: incoming.apiUrl,
      model: incoming.model,
      apiKey: incoming.apiKey
    };
    profiles.push(profile);
    active = profile;
    activeId = profile.id;
  }

  return {
    templates,
    activeTemplateId: resolvedActiveTemplateId,
    aiConfig: active
      ? { apiUrl: active.apiUrl, model: active.model, apiKey: active.apiKey }
      : unconfiguredAiConfig(),
    aiProfiles: profiles,
    activeAiProfileId: activeId,
    profile: self.ResumeProProfile.normalizeProfile(rawState.profile)
  };
}

function migrationFromLegacyAi(current) {
  if (current.aiProfiles !== undefined) {
    return {};
  }

  if (!current.aiConfig || typeof current.aiConfig !== "object") {
    return { aiProfiles: [], activeAiProfileId: "" };
  }

  const config = normalizeAiConfig(current.aiConfig);

  if (!isUserAiConfig(config)) {
    return { aiProfiles: [], activeAiProfileId: "" };
  }

  const profile = {
    id: crypto.randomUUID(),
    name: profileNameFromUrl(config.apiUrl, []),
    apiUrl: config.apiUrl,
    model: config.model,
    apiKey: config.apiKey
  };

  return {
    aiProfiles: [profile],
    activeAiProfileId: isCompleteAi(profile) ? profile.id : ""
  };
}

function unconfiguredAiConfig() {
  return {
    apiUrl: DEFAULT_STORE.aiConfig.apiUrl,
    model: DEFAULT_STORE.aiConfig.model,
    apiKey: ""
  };
}

function isCompleteAi(config) {
  return Boolean(config.apiUrl && config.model && config.apiKey);
}

function isUserAiConfig(config) {
  return Boolean(
    config.apiKey
    || config.apiUrl !== DEFAULT_STORE.aiConfig.apiUrl
    || config.model !== DEFAULT_STORE.aiConfig.model
  );
}

function profileHost(apiUrl) {
  try {
    return new URL(apiUrl).host || apiUrl;
  } catch {
    return String(apiUrl || "");
  }
}

function profileNameFromUrl(apiUrl, profiles) {
  const host = profileHost(apiUrl) || "配置";
  const used = new Set(profiles.map((profile) => profile.name));

  if (!used.has(host)) {
    return host;
  }

  let index = 2;

  while (used.has(`${host} (${index})`)) {
    index += 1;
  }

  return `${host} (${index})`;
}

function normalizeAiProfile(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const apiUrl = String(raw.apiUrl ?? "").trim();
  const model = String(raw.model ?? "").trim();

  if (!apiUrl || !model) {
    return null;
  }

  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : crypto.randomUUID(),
    name: String(raw.name ?? "").trim() || profileNameFromUrl(apiUrl, []),
    apiUrl,
    model,
    apiKey: String(raw.apiKey ?? "")
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

    const release = ResumeProUtils.latestPluginRelease(await response.json());

    await chrome.storage.local.set({
      [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), release, failed: false }
    });
    const hasUpdate = renderUpdateBanner(release, dismissedVersion, currentVersion);

    if (announce) {
      elements.updateCheckStatus.textContent = !release ? "暂无正式版本" : hasUpdate ? "发现新版" : "已是最新版";
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
  elements.parseDownloadButton = document.getElementById("parse-download-button");
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
  elements.parseDownloadButton?.addEventListener("click", handleParseDownloadClick);
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

  // 换了一份文件，上一份的「下载 Excel 核对」就不该再留着，免得下成旧简历。
  if (file) {
    popupState.lastParsedFields = [];
    if (elements.parseDownloadButton) elements.parseDownloadButton.hidden = true;
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
  popupState.lastParsedFields = [];
  if (elements.parseDownloadButton) elements.parseDownloadButton.hidden = true;
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

    const fields = normalizeParsedResult(result.fields);
    // 先留住解析结果：下面存模板就算失败，也还能下载 Excel，不用再调一次 AI。
    popupState.lastParsedFields = result.fields;
    if (elements.parseDownloadButton) elements.parseDownloadButton.hidden = false;
    let template = null;

    await StorageService.update((draft) => {
      template = {
        id: crypto.randomUUID(),
        name: resolveTemplateName(`${getTemplateNameFromFile(file.name)}（AI 解析）`, draft.templates),
        groups: parsedFieldsToGroups(fields)
      };
      draft.templates.unshift(template);
      draft.activeTemplateId = template.id;
      return draft;
    });

    showParseStatus(`已存为模板「${template.name}」并设为当前，共 ${countTemplateFields(template)} 个字段。`, "success", 0);
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

function normalizeParsedResult(fields) {
  const rawFields = Array.isArray(fields)
    ? fields
        .map((field) => ({
          group: String(field?.group ?? "").trim(),
          key: String(field?.key ?? "").trim(),
          value: String(field?.value ?? "")
        }))
        .filter((field) => field.group && field.key)
    : [];

  const normalizedFields = typeof self.ResumeProAIHelpers?.normalizeParsedFields === "function"
    ? self.ResumeProAIHelpers.normalizeParsedFields(rawFields)
    : rawFields;

  if (!normalizedFields.length) {
    throw new Error("AI 未能提取到有效信息，请检查文件内容。");
  }

  return normalizedFields;
}

// 和 parseTemplateFile 读 Excel 得到的结构一样，存进去的模板与「下载 Excel 再导入」一致。
function parsedFieldsToGroups(fields) {
  const groupMap = new Map();

  fields.forEach((field) => {
    if (!groupMap.has(field.group)) {
      groupMap.set(field.group, []);
    }

    groupMap.get(field.group).push({ key: field.key, value: field.value });
  });

  return Array.from(groupMap, ([name, groupFields]) => ({ name, fields: groupFields }));
}

function handleParseDownloadClick() {
  try {
    generateAndDownloadExcel(popupState.lastParsedFields);
    showParseStatus("Excel 已下载。", "success");
  } catch (error) {
    showParseStatus(error.message || "Excel 导出失败。", "error", 0);
  }
}

function generateAndDownloadExcel(fields) {
  const rows = [
    [...TEMPLATE_SHEET_HEADER],
    ...normalizeParsedResult(fields).map((field) => [field.group, field.key, field.value])
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
    cacheParseElements,
    countTemplateFields,
    handleFileSelection,
    handleParseDownloadClick,
    handleParseResumeClick,
    handleTemplateListClick,
    parseTemplateFile,
    popupState,
    resolveTemplateName,
    StorageService,
    updateParseFileSelection,
    profile: {
      applyTabFromHash,
      renderProfile,
      saveProfile,
      stripProfileSecrets
    },
    backup: {
      applyBackup,
      BackupIO,
      buildBackup,
      commitPendingBackup,
      exportBackup,
      handleBackupFileSelection,
      handleExportBackup,
      parseBackup,
      templateExportFileName,
      templateToSheetRows
    },
    aiProfiles: {
      activateAiProfile,
      beginEditAiProfile,
      beginNewAiProfile,
      deleteAiProfile,
      handleConfigSubmit,
      renameAiProfile
    }
  };
}
