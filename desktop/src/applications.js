const STAGE_LABEL = {
  saved: "已保存",
  filling: "填写中",
  submitted: "已投递",
  assessment: "测评",
  interview: "面试",
  offer: "Offer",
  rejected: "未通过",
  withdrawn: "已撤回",
  closed: "已关闭",
};

const EVENT_LABEL = {
  application_created: "创建申请",
  application_updated: "更新资料",
  submit_confirmed: "确认已投递",
  assessment_recorded: "记录测评",
  interview_recorded: "记录面试",
  offer_recorded: "记录 Offer",
  rejected: "记录未通过",
  withdrawn: "记录撤回",
  closed: "关闭申请",
  stage_corrected: "纠正阶段",
  note_added: "备注",
  fill_started: "开始填写",
  fill_completed: "填写完成",
  fill_partial: "部分填写",
  fill_failed: "填写失败",
  fill_cancelled: "填写取消",
};

export function stageLabel(code) {
  return STAGE_LABEL[code] || code;
}

export function eventLabel(code) {
  return EVENT_LABEL[code] || code;
}

export function evidenceLabel(state) {
  if (state === "none_imported") return "尚未导入回复证据";
  if (state === "imported_unclassified") return "已导入，待分类";
  if (state === "auto_ack") return "已有自动回执类证据";
  if (state === "classified") return "已有已分类回复证据";
  if (state === "mixed") return "证据状态混合";
  return state || "尚未导入回复证据";
}

export function createApplicationsController() {
  let listToken = 0;
  let selectedId = null;
  let formDirty = false;
  let saving = false;
  let editingId = null;
  let offset = 0;
  const limit = 20;
  let lastFilter = {};

  function beginList() {
    listToken += 1;
    return listToken;
  }

  function isCurrent(token) {
    return token === listToken;
  }

  function markFormDirty() {
    formDirty = true;
  }

  function clearFormDirty() {
    formDirty = false;
  }

  function snapshot() {
    return { formDirty, saving, selectedId, editingId, offset, lastFilter };
  }

  return {
    beginList,
    isCurrent,
    markFormDirty,
    clearFormDirty,
    snapshot,
    setSaving(value) {
      saving = value;
    },
    setSelected(id) {
      selectedId = id;
    },
    setEditing(id) {
      editingId = id;
    },
    setOffset(value) {
      offset = value;
    },
    setFilter(filter) {
      lastFilter = filter;
    },
    get offset() {
      return offset;
    },
    get limit() {
      return limit;
    },
    get selectedId() {
      return selectedId;
    },
    get editingId() {
      return editingId;
    },
    get formDirty() {
      return formDirty;
    },
    get saving() {
      return saving;
    },
  };
}
