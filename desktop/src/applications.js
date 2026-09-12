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

const FILL_OUTCOME = {
  started: "开始",
  completed: "完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

// Shown with every snapshot the desktop displays (D08 acceptance): a snapshot is what the
// plugin copied from the template when the fill was archived, not a record of what the
// website received.
export const SNAPSHOT_DISCLAIMER =
  "这是插件在留档时从简历模板拷贝的内容，用来追溯当时用了哪份资料；它不能证明网站最终收到或保存了这些内容。";

/**
 * One line for a fill event: its outcome and how many fields were written into the page.
 * "Written into the page" is all the plugin can know; nothing here says the site accepted
 * anything, and a fill is never a submission.
 */
export function fillSummary(payload) {
  if (payload?.kind !== "fill_event") return "";
  const parts = [FILL_OUTCOME[payload.outcome] || "结束"];
  // Only what was sent: an absent filled count is unknown, not zero.
  if (Number.isInteger(payload.field_count) && Number.isInteger(payload.filled_count)) {
    parts.push(`已写入网页 ${payload.filled_count}/${payload.field_count} 项`);
  } else if (Number.isInteger(payload.field_count)) {
    parts.push(`共 ${payload.field_count} 项`);
  } else if (Number.isInteger(payload.filled_count)) {
    parts.push(`已写入网页 ${payload.filled_count} 项`);
  }
  if (payload.unconfirmed_count) parts.push(`${payload.unconfirmed_count} 项未确认`);
  const took = durationLabel(payload.durations_ms?.total);
  if (took) parts.push(`用时 ${took}`);
  // The version tells two revisions of a template with the same name apart.
  if (payload.template_name) {
    parts.push(`模板：${payload.template_name}${payload.template_version ? `（${payload.template_version}）` : ""}`);
  }
  return parts.join(" · ");
}

function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** Null when the snapshot can be opened; otherwise the sentence to show in its place. */
export function snapshotStateLabel(state) {
  if (state === "stored") return null;
  if (state === "uploading") return "简历快照上传中，还没有传完。";
  // After a restore the plugin can upload the same bytes again, but only under a new id; the
  // fill event cannot be rewritten to point at it, so the copy shows up in the list instead.
  return "简历快照不可用：桌面没有收到这份快照。恢复备份后重新上传的快照会单独出现在上方的快照列表里。";
}

export function stageLabel(code) {
  return STAGE_LABEL[code] || code;
}

export function eventLabel(code) {
  return EVENT_LABEL[code] || code;
}

export function occurredLabel(occurred) {
  if (occurred?.precision === "date") return occurred.value?.date || "发生日期未知";
  if (occurred?.precision === "date_time") return occurred.value?.rfc3339 || "发生时间未知";
  return "发生时间未知";
}

export function evidenceLabel(state) {
  if (state === "none_imported") return "尚未导入回复证据";
  if (state === "imported_unclassified") return "已导入，待分类";
  if (state === "auto_ack") return "已有自动回执类证据";
  if (state === "classified") return "已有已分类回复证据";
  if (state === "mixed") return "证据状态混合";
  return state || "尚未导入回复证据";
}

/**
 * 「尚未导入回复证据」旁边永远跟着这句：没有证据只说明没人导入过东西，不说明对方
 * 没有回复（§6.3 与 §11 的措辞约束）。
 */
export function evidenceNote(state) {
  if (state === "none_imported" || !state) {
    return "这只表示还没有导入任何回复证据，不代表对方没有回复。";
  }
  if (state === "imported_unclassified") {
    return "已经导入了证据，还没有确认它属于哪一类。";
  }
  return "";
}

/** 详情里一条证据的摘要行：类型、来源、分类与发送方式，各说各的。 */
export function evidenceLine(item) {
  const parts = [];
  parts.push(EVIDENCE_KIND[item?.kind] || "文件");
  if (item?.fromAddr) parts.push(item.fromAddr);
  if (item?.sentAt) parts.push(item.sentAt);
  parts.push(item?.replyClass ? EVIDENCE_CLASS[item.replyClass] || item.replyClass : "待分类");
  parts.push(`发送方式：${EVIDENCE_SEND_MODE[item?.sendMode || "unknown"]}`);
  return parts.join(" · ");
}

const EVIDENCE_KIND = {
  eml: "邮件",
  screenshot: "截图",
  pdf: "PDF",
  paste: "粘贴文本",
  unknown: "文本",
};

const EVIDENCE_CLASS = {
  auto_ack: "自动回执",
  assessment_invite: "测评邀请",
  interview_invite: "面试邀请",
  action_required: "需要处理",
  offer: "Offer",
  reject: "未通过",
  other: "其他",
  unknown: "看不出来",
};

const EVIDENCE_SEND_MODE = {
  human: "人工发送",
  automated: "系统自动发送",
  unknown: "未知",
};

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
