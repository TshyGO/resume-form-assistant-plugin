// D12 备份与恢复的文案与纯函数。
//
// 这一块的文案有一条硬要求（data-privacy §6.3）：**导出 UI 必须说明文件不加密、
// 里面有简历和邮件内容、应该放在用户自己控制的位置。** 不得在任何地方宣传
// 「已加密」——我们没做加密。
//
// 另一条是恢复的措辞。恢复是这个程序里唯一一个会把现有档案整个换掉的操作，
// 所以每一句都要让用户在点确认之前知道会发生什么，包括「旧的去哪了」。

import type { ArchiveCounts, OrphanReport, PurgePreview, RestorePreview } from "./api.ts";

export interface Message {
  tone: "info" | "success" | "warn" | "pending";
  text: string;
}

/** 导出按钮旁边常驻的说明。三句话，一句都不能少。 */
export const EXPORT_NOTE = [
  "备份包含全部申请、事件、待办、回复证据和简历快照。",
  "文件不加密，里面有简历和邮件内容，请放在自己控制的位置。",
  "API Key、日志和这台机器专属的配置不会进备份。",
].join("");

/** 恢复之前的说明。 */
export const RESTORE_NOTE =
  "恢复会把当前档案整个换成备份里的那一份。当前这份不会删掉，它会变成一个回滚点，随时可以换回来。";

export const EMPTY_ROLLBACK = "还没有回滚点。第一次恢复之后，被换下来的档案会出现在这里。";

export const EMPTY_RECYCLE = "回收站是空的。";

/** 永久删除前的最后一句。 */
export const PURGE_WARNING =
  "永久删除不可撤销，也不会进回收站。只有没有别的申请引用的附件才会跟着删掉。";

const LABELS: Array<[keyof ArchiveCounts, string]> = [
  ["applications", "申请"],
  ["events", "事件"],
  ["todos", "待办"],
  ["evidence", "回复证据"],
  ["snapshots", "简历快照"],
  ["attachments", "附件"],
];

/** 「现在 12 条申请 → 恢复后 8 条」。只列出会变的那些。 */
export function describeChange(preview: RestorePreview): string[] {
  return LABELS.filter(([key]) => preview.current[key] !== preview.incoming[key]).map(
    ([key, label]) => `${label} ${preview.current[key]} → ${preview.incoming[key]}`,
  );
}

/** 恢复预览要说的话。 */
export function describePreview(preview: RestorePreview): Message[] {
  const out: Message[] = [];
  const changes = describeChange(preview);
  out.push({
    tone: "info",
    text: changes.length ? `恢复之后：${changes.join("，")}。` : "数量和现在完全一样。",
  });

  if (!preview.sameArchive) {
    out.push({
      tone: "warn",
      // 不是错误，但用户该知道。他可能拿错了文件。
      text: "这份备份来自另一个档案，不是这台机器上这份的历史版本。",
    });
  }
  if (preview.tooManyRollbackPoints) {
    out.push({
      tone: "warn",
      text: `已经有 ${preview.existingRollbackPoints} 个回滚点。程序不会自动删它们，占地方的话请自己清理。`,
    });
  }
  return out;
}

export function describeExport(path: string, sizeBytes: number, skipped: string[]): Message {
  const size = formatSize(sizeBytes);
  if (!skipped.length) {
    return { tone: "success", text: `已导出到 ${path}（${size}）。` };
  }
  return {
    tone: "info",
    text: `已导出到 ${path}（${size}）。没有进包的：${skipped.join("、")}。`,
  };
}

export function describeRestore(counts: ArchiveCounts, rollbackPoint: string): Message {
  return {
    tone: "success",
    text: `已恢复：${counts.applications} 条申请、${counts.events} 条事件、${counts.todos} 条待办。原来那份存成了回滚点 ${rollbackPoint}。`,
  };
}

/**
 * 恢复之后关于提醒的那句话。
 *
 * 必须说，而且要说清是「重新登记」不是「丢了」——待办都在，只是这台机器上还没有
 * 给它们排过系统通知。
 */
export function describeRemindersAfterRestore(cleared: number): Message | null {
  if (cleared <= 0) return null;
  return {
    tone: "info",
    text: `${cleared} 条待办的提醒需要重新登记：原来的提醒排在另一台机器上，待办本身都在。`,
  };
}

export function describePurgePreview(preview: PurgePreview): string {
  const parts = [
    `${preview.events} 条事件`,
    `${preview.todos} 条待办`,
    `${preview.evidence} 份证据`,
    `${preview.snapshots} 份快照`,
  ];
  return `永久删除「${preview.company} · ${preview.title}」会连带删掉 ${parts.join("、")}。`;
}

export function describeOrphans(report: OrphanReport): Message {
  if (report.danglingEvidence.length) {
    return {
      tone: "warn",
      // 悬空引用说明有别的问题，这时候更不该动任何文件。
      text: `有 ${report.danglingEvidence.length} 条证据指向不存在的附件记录。先别删任何东西，这说明档案里有别的问题。`,
    };
  }
  if (!report.zeroRefBlobs.length) {
    return { tone: "success", text: `${report.totalBlobs} 份附件都有证据引用，没有可清理的。` };
  }
  return {
    tone: "info",
    text: `有 ${report.zeroRefBlobs.length} 份附件没有任何证据引用了。要删的话逐个确认。`,
  };
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 默认的备份文件名。 */
export function defaultBackupName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `resume-pro-archive-${stamp}.zip`;
}
