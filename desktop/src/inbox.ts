// D09 收件箱的文案与纯函数。界面只负责拼 DOM，说什么由这里决定（沿用 D07/D08 的
// 「文案只在一处说」）。这里的每一句都要经得起 §11 的检查：导入不等于对方回复了什么，
// 关联后未分类不叫「尚未导入」。

import type { EvidenceKind, EvidencePreview, EvidenceSummary, ReplyClass, SendMode } from "./api.ts";

/** describeImport 只数数量与失败原因，不关心成功项的完整形状。 */
export interface ImportOutcome {
  imported?: unknown[];
  duplicates?: unknown[];
  failed?: Array<{ name: string; code: string }>;
}

/** 界面上要说的一句话：语气决定它显示成什么颜色。 */
export interface Message {
  tone: "info" | "success" | "warn" | "pending";
  text: string;
}

export const KIND_LABEL: Record<string, string> = {
  eml: "邮件",
  screenshot: "截图",
  pdf: "PDF",
  paste: "粘贴文本",
  unknown: "文本",
};

/** 通知业务类型（§6.3）。与发送方式各选各的，互不推断。 */
export const REPLY_CLASS_OPTIONS: Array<{ value: ReplyClass | ""; label: string }> = [
  { value: "", label: "未分类" },
  { value: "auto_ack", label: "自动回执" },
  { value: "assessment_invite", label: "测评邀请" },
  { value: "interview_invite", label: "面试邀请" },
  { value: "action_required", label: "需要我处理" },
  { value: "offer", label: "Offer" },
  { value: "reject", label: "未通过" },
  { value: "other", label: "其他" },
  { value: "unknown", label: "看不出来" },
];

/** 发送方式。判断不了就是「未知」，不因为类型是面试邀请就写成人工（走查 10.13）。 */
export const SEND_MODE_OPTIONS: Array<{ value: SendMode; label: string }> = [
  { value: "unknown", label: "未知" },
  { value: "human", label: "人工发送" },
  { value: "automated", label: "系统自动发送" },
];

const IMPORT_ERRORS: Record<string, string> = {
  unsupported: "不支持这种文件。Outlook 的 .msg 请在邮件客户端里另存为 .eml，或者直接粘贴正文。",
  too_large: "超过 25 MiB，没有导入。",
  source_unreadable: "读不到这个文件，可能已经被移走或没有权限。",
  storage: "写入档案目录失败，什么都没有留下。",
  too_many_files: "一次最多导入 20 个文件，这个没有排上。",
};

export function kindLabel(kind: EvidenceKind | string | undefined): string {
  return (kind && KIND_LABEL[kind]) || "文件";
}

export function replyClassLabel(value: ReplyClass | null | undefined): string {
  return REPLY_CLASS_OPTIONS.find((option) => option.value === (value || ""))?.label || "未分类";
}

export function sendModeLabel(value: SendMode | null | undefined): string {
  return SEND_MODE_OPTIONS.find((option) => option.value === (value || "unknown"))?.label || "未知";
}

/** 列表里这条叫什么：主题 → 原始文件名 → 类型兜底。 */
export function evidenceTitle(item: Partial<EvidenceSummary> | null | undefined): string {
  const subject = (item?.subject || "").trim();
  if (subject) return subject;
  const filename = (item?.originalFilename || "").trim();
  if (filename) return filename;
  return kindLabel(item?.kind);
}

export function importErrorText(code: string): string {
  return IMPORT_ERRORS[code] || "这个文件没能导入。";
}

/**
 * 一次导入之后说什么。成功、重复、失败分开讲：重复不是错误，用户可能真的想把同一封信
 * 关到另一条申请上。
 */
export function describeImport(report: ImportOutcome | null | undefined): Message {
  const imported = report?.imported?.length ?? 0;
  const duplicates = report?.duplicates?.length ?? 0;
  const failed = report?.failed ?? [];
  if (!imported && !duplicates && !failed.length) {
    return { tone: "info", text: "没有选择任何文件。" };
  }

  const parts = [];
  if (imported) parts.push(`已导入 ${imported} 条，待分类`);
  if (duplicates) parts.push(`${duplicates} 条内容和已有的完全相同，没有重复保存；需要的话可以把它关联到另一条申请`);
  for (const item of failed) parts.push(`${item.name}：${importErrorText(item.code)}`);

  const tone = failed.length ? "warn" : imported ? "success" : "info";
  return { tone, text: parts.join("；") + "。" };
}

/** 这条证据和别的证据字节相同时的提示。 */
export function duplicateNote(item: Partial<EvidenceSummary> | null | undefined): string {
  const count = item?.sameBytesAs?.length ?? 0;
  if (!count) return "";
  return `内容和另外 ${count} 条完全相同（同一份字节只存了一次）。`;
}

/** 预览面板顶部那行元数据。 */
export function describeEvidenceMeta(item: Partial<EvidencePreview> | null | undefined): string {
  const parts = [kindLabel(item?.kind)];
  if (item?.fromAddr) parts.push(`来自 ${item.fromAddr}`);
  if (item?.sentAt) parts.push(`发送于 ${item.sentAt}`);
  parts.push(`导入于 ${item?.importedAt ?? "未知时间"}`);
  if (Number.isInteger(item?.sizeBytes)) parts.push(sizeLabel(item?.sizeBytes));
  return parts.join(" · ");
}

export function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** 关联结果的说法。关联本身不代表这封信说了什么。 */
export function describeAssociation(result: unknown, company: string | undefined): Message {
  if (!result) return { tone: "warn", text: "没能关联，请再试一次。" };
  const where = company ? `「${company}」` : "所选申请";
  return {
    tone: "success",
    text: `已关联到${where}，状态是「已导入，待分类」。分类由你确认，导入本身不改变申请阶段。`,
  };
}

export function describeUnassociation(): Message {
  return { tone: "info", text: "已从那条申请里取出，回到收件箱。那条申请回到「尚未导入回复证据」。" };
}

export function describeClassification(item: Partial<EvidenceSummary> | null | undefined): Message {
  return {
    tone: "success",
    text: `已记为「${replyClassLabel(item?.replyClass)}」，发送方式「${sendModeLabel(item?.sendMode)}」。这只是给这封信分类，不改变申请阶段。`,
  };
}

/** 空收件箱：说清楚这里为什么空，不暗示对方没回复。 */
export const EMPTY_INBOX =
  "收件箱里没有待处理的证据。把回复邮件（.eml）、截图或 PDF 拖进窗口，或者粘贴一段文本，就能存进档案。";

/** 候选申请列表的提示：同公司多个岗位不合并，必须自己选（§7、走查 10.1）。 */
export const CHOOSE_APPLICATION_HINT =
  "同一家公司可能有多条申请，这里不会替你猜——请选中具体那一条。";
