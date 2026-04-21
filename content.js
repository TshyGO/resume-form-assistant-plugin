(function () {
  const SIDEBAR_ID = "resume-pro-sidebar";
  const STORAGE_KEYS = ["templates", "activeTemplateId", "aiConfig"];
  const state = {
    dragOffsetX: 0,
    dragOffsetY: 0,
    dragging: false,
    currentStore: null,
    statusTimer: null,
    lastFocusedField: null,
    managerVisible: false
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
    createSidebar();
    createManagerPanel();
    renderSidebar();
    bindStorageSync();
    bindFocusTracking();
  }

  function createSidebar() {
    const sidebar = document.createElement("aside");
    sidebar.id = SIDEBAR_ID;
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
        <div class="resume-pro__status" id="resume-pro-status" aria-live="polite"></div>
        <div class="resume-pro__divider"></div>
        <div class="resume-pro__groups" id="resume-pro-groups"></div>
        <div class="resume-pro__footer">
          <button class="resume-pro__manager-button" id="resume-pro-open-manager" type="button">打开管理面板</button>
          <p class="resume-pro__footer-tip">管理面板会常驻在当前页面，点右上角 X 再关闭。</p>
        </div>
      </div>
    `;

    document.body.appendChild(sidebar);
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
          src="${chrome.runtime.getURL("popup.html")}"
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
    openManagerButton?.addEventListener("click", () => setManagerVisibility(true));
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
    const sidebar = document.getElementById(SIDEBAR_ID);

    if (!sidebar) {
      return;
    }

    const templateSelect = sidebar.querySelector("#resume-pro-template-select");
    const groupsContainer = sidebar.querySelector("#resume-pro-groups");
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
      groupsContainer.innerHTML = activeTemplate.groups.map((group) => `
      <section class="resume-pro__group">
        <div class="resume-pro__group-name">${escapeHtml(group.name)}</div>
        <div class="resume-pro__chips">
          ${group.fields.map((field) => `
            <button
              class="resume-pro__chip"
              type="button"
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
  }

  async function handleFieldChipClick(button) {
    const value = button.dataset.value || "";
    const copied = await copyText(value);
    const filled = fillLastFocusedField(value);

    button.classList.add("is-success");
    button.textContent = filled ? "已填写" : "已复制";
    window.setTimeout(() => {
      button.classList.remove("is-success");
      renderSidebar();
    }, 1000);

    if (filled) {
      showStatus(copied ? "已复制并填入当前输入框。" : "已填入当前输入框。", "success");
      return;
    }

    showStatus(copied ? "字段值已复制到剪贴板。" : "字段值已准备好，请手动粘贴。", "success");
  }

  async function handleAiFillClick(event) {
    const button = event.currentTarget;
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

    const { fields, fieldMap } = scanFillableFields();

    if (!fields.length) {
      showStatus("当前页面没有可填写的表单字段。", "error");
      return;
    }

    button.disabled = true;
    button.textContent = "匹配中...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "AI_FILL",
        formFields: fields,
        resumeFields: flattenTemplateFields(activeTemplate),
        aiConfig
      });

      if (!response?.success) {
        throw new Error(response?.error || "AI 填写失败。");
      }

      let filledCount = 0;

      response.matches.forEach((match) => {
        const element = fieldMap.get(match.fieldId);

        if (element && setElementValue(element, match.value)) {
          filledCount += 1;
        }
      });

      showStatus(`已填写 ${filledCount} 个字段。`, "success");
    } catch (error) {
      showStatus(error.message || "AI 填写失败。", "error");
    } finally {
      button.disabled = false;
      button.textContent = "一键 AI 填写";
    }
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

  function fillLastFocusedField(value) {
    const candidates = [state.lastFocusedField, document.activeElement];

    for (const candidate of candidates) {
      if (candidate instanceof HTMLElement && isFillTarget(candidate) && document.contains(candidate)) {
        if (setElementValue(candidate, value)) {
          candidate.focus?.();
          state.lastFocusedField = candidate;
          return true;
        }
      }
    }

    return false;
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

    if (element && typeof element === "object" && element.kind === "element") {
      element = element.element;
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
    const statusElement = document.getElementById("resume-pro-status");

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

    const sidebar = document.getElementById(SIDEBAR_ID);
    const rect = sidebar.getBoundingClientRect();
    state.dragging = true;
    state.dragOffsetX = event.clientX - rect.left;
    state.dragOffsetY = event.clientY - rect.top;
    sidebar.classList.add("is-dragging");
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
    document.getElementById(SIDEBAR_ID)?.classList.remove("is-dragging");
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
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
})();
