// 简历模板字段编辑（#273）：插件侧边栏与桌面「简历」页共用的草稿模型和校验规则。
// 桌面的 desktop/src/resume/template-fields.js 是这份的原样拷贝（profile-sync.test.ts 锁住），
// 改规则只改这里再复制过去。存储层（archive-store resume.rs）是最终把关，这里的校验
// 只为让人在保存前就看到问题，口径与它一致。
(function attachResumeProTemplateFields(globalScope) {
  const UNGROUPED = "未分类";
  // 与 archive-store 的 MAX_TEMPLATE_BYTES 一致：分组序列化后的上限。
  const MAX_TEMPLATE_BYTES = 24 * 1024;
  // 与 profile-fields.js / archive-store resume_secrets.rs 同一口径。
  const SECRET_LABEL = /密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret/i;
  const SECRET_VALUE = /(密码|口令|验证码|校验码|授权码|密钥|令牌|password|passwd|pwd|token|secret)\s*[:=：]\s*\S/i;

  function text(value) {
    return String(value ?? "");
  }

  // 去控制字符再 trim，空了就是「未分类」。与存储层 normalize_groups 对组名的处理一致。
  function categoryName(value) {
    const name = text(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return name || UNGROUPED;
  }

  function cloneGroups(groups) {
    return (Array.isArray(groups) ? groups : []).map((group) => ({
      name: text(group?.name),
      fields: (Array.isArray(group?.fields) ? group.fields : []).map((field) => ({ key: text(field?.key), value: text(field?.value) }))
    }));
  }

  /**
   * 从一份模板开草稿。字段的 id 只活在这份草稿里，用来在界面上认出「同一行」，
   * 不存进档案：保存时整份替换分组，并用 baseSha256 检查起点，所以不需要持久化的字段 ID。
   */
  function createDraft(template) {
    const base = cloneGroups(template?.groups);
    const fields = [];
    base.forEach((group) => group.fields.forEach((field) => {
      fields.push({ id: `f${fields.length + 1}`, category: categoryName(group.name), key: field.key, value: field.value, origin: { category: categoryName(group.name), key: field.key, value: field.value } });
    }));
    const categories = [];
    fields.forEach((field) => { if (!categories.includes(field.category)) categories.push(field.category); });
    return {
      templateId: text(template?.id),
      templateName: text(template?.name),
      base,
      categories,
      fields,
      nextId: fields.length + 1
    };
  }

  function addCategory(draft, name) {
    const category = categoryName(name);
    if (!text(name).trim()) return { draft, category: null, error: "分类名称不能为空。" };
    if (draft.categories.includes(category)) return { draft, category, error: null };
    return { draft: { ...draft, categories: [...draft.categories, category] }, category, error: null };
  }

  function addField(draft, { category, key = "", value = "" } = {}) {
    const target = categoryName(category);
    const id = `f${draft.nextId}`;
    const categories = draft.categories.includes(target) ? draft.categories : [...draft.categories, target];
    return {
      draft: { ...draft, categories, fields: [...draft.fields, { id, category: target, key: text(key), value: text(value), origin: null }], nextId: draft.nextId + 1 },
      id
    };
  }

  function updateField(draft, id, patch) {
    let categories = draft.categories;
    const fields = draft.fields.map((field) => {
      if (field.id !== id) return field;
      const next = { ...field };
      if ("key" in patch) next.key = text(patch.key);
      if ("value" in patch) next.value = text(patch.value);
      if ("category" in patch) {
        next.category = categoryName(patch.category);
        if (!categories.includes(next.category)) categories = [...categories, next.category];
      }
      return next;
    });
    return { ...draft, categories, fields };
  }

  function removeField(draft, id) {
    return { ...draft, fields: draft.fields.filter((field) => field.id !== id) };
  }

  /** 草稿按分类顺序整理成要保存的分组；没有字段的分类不保存。字段名 trim，内容原样。 */
  function toGroups(draft) {
    return draft.categories
      .map((name) => ({
        name,
        fields: draft.fields.filter((field) => field.category === name).map((field) => ({ key: field.key.trim(), value: field.value }))
      }))
      .filter((group) => group.fields.length);
  }

  function emptyCategories(draft) {
    return draft.categories.filter((name) => !draft.fields.some((field) => field.category === name));
  }

  function utf8Length(value) {
    return new TextEncoder().encode(value).length;
  }

  /**
   * 保存前的检查。errors 挡住保存（按字段 id 标在对应行上，或作为整体问题）；
   * warnings 只提醒。
   */
  function validateDraft(draft) {
    const fieldErrors = {};
    const problems = [];
    const warnings = [];
    draft.fields.forEach((field) => {
      const key = field.key.trim();
      if (!key) fieldErrors[field.id] = "字段名称不能为空。";
      else if (SECRET_LABEL.test(key)) fieldErrors[field.id] = `「${key}」看起来是密码或验证码，这类内容不存进模板。`;
      else if (SECRET_VALUE.test(field.value)) fieldErrors[field.id] = "内容看起来含有密码或验证码，这类内容不存进模板。";
    });
    if (!draft.fields.length) problems.push("模板至少要保留一个字段。不再需要这份模板时，可以在桌面模板列表里删除整份模板。");
    const groups = toGroups(draft);
    if (utf8Length(JSON.stringify(groups)) > MAX_TEMPLATE_BYTES) problems.push(`模板太大（超过 ${MAX_TEMPLATE_BYTES / 1024} KB），请删掉一些内容或拆成几个模板。`);
    groups.forEach((group) => {
      const seen = new Set();
      const repeated = new Set();
      group.fields.forEach((field) => {
        if (!field.key) return;
        if (seen.has(field.key)) repeated.add(field.key);
        seen.add(field.key);
      });
      repeated.forEach((key) => warnings.push(`「${group.name}」里有多个「${key}」，填写时可能只用到其中一个。`));
    });
    const empty = emptyCategories(draft);
    if (empty.length) warnings.push(`没有字段的分类不会保存：${empty.map((name) => `「${name}」`).join("、")}。`);
    return { fieldErrors, problems, warnings, ok: !Object.keys(fieldErrors).length && !problems.length };
  }

  function sameGroups(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function isDirty(draft) {
    return !sameGroups(toGroups(draft), draft.base);
  }

  /** 相对起点的改动数，给保存按钮和「放弃修改？」确认用。 */
  function summarizeChanges(draft) {
    const kept = new Set();
    let added = 0;
    let changed = 0;
    let moved = 0;
    draft.fields.forEach((field) => {
      if (!field.origin) { added += 1; return; }
      kept.add(field.id);
      if (field.key.trim() !== field.origin.key || field.value !== field.origin.value) changed += 1;
      if (field.category !== field.origin.category) moved += 1;
    });
    const total = draft.base.reduce((sum, group) => sum + group.fields.length, 0);
    return { added, changed, moved, removed: total - kept.size };
  }

  function describeChanges(summary) {
    const parts = [];
    if (summary.added) parts.push(`新增 ${summary.added} 个`);
    if (summary.changed) parts.push(`修改 ${summary.changed} 个`);
    if (summary.moved) parts.push(`调整分类 ${summary.moved} 个`);
    if (summary.removed) parts.push(`删除 ${summary.removed} 个`);
    return parts.join("，");
  }

  /**
   * 删掉或改了名的模板字段里，「我的信息」仍有同名内容的那些。一键填写时模板优先，
   * 模板里没有的名字会由「我的信息」补上，所以删掉模板字段不等于停用这项信息。
   * profileFields 是 profile-fields.js profileToResumeFields 的结果（已滤掉空值与密码类），
   * normalizeKey 是同一文件的字段名归一，和填写时合并用的是同一套。
   */
  function profileFallbacks(draft, profileFields, normalizeKey) {
    const norm = typeof normalizeKey === "function" ? normalizeKey : (value) => text(value).trim().toLowerCase();
    const profile = new Map();
    (Array.isArray(profileFields) ? profileFields : []).forEach((field) => {
      const key = norm(field?.key);
      if (key && field?.value && !profile.has(key)) profile.set(key, field.key);
    });
    const now = new Set(draft.fields.map((field) => norm(field.key)).filter(Boolean));
    const gone = [];
    draft.base.forEach((group) => group.fields.forEach((field) => {
      const key = norm(field.key);
      if (key && !now.has(key) && profile.has(key) && !gone.includes(field.key)) gone.push(field.key);
    }));
    return gone;
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  /**
   * 模板内容的版本：{"groups": [...]} 的规范 JSON（键按字典序、无空白）的 SHA-256，
   * 小写十六进制。与 archive-store groups_sha256 逐字节一致，两边各有固定向量的测试。
   */
  async function contentSha256(groups) {
    const bytes = new TextEncoder().encode(canonicalJson({ groups: cloneGroups(groups) }));
    const digest = await globalScope.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  const api = {
    MAX_TEMPLATE_BYTES,
    UNGROUPED,
    addCategory,
    addField,
    categoryName,
    contentSha256,
    createDraft,
    describeChanges,
    emptyCategories,
    isDirty,
    profileFallbacks,
    removeField,
    sameGroups,
    summarizeChanges,
    toGroups,
    updateField,
    validateDraft
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  globalScope.ResumeProTemplateFields = api;
})(typeof self !== "undefined" ? self : globalThis);
