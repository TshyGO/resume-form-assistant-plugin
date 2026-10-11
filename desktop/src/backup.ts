// D12 备份与恢复的文案与纯函数。
//
// 这一块的文案有一条硬要求（data-privacy §6.3）：**导出 UI 必须说明文件不加密、
// 里面有简历和邮件内容、应该放在用户自己控制的位置。** 不得在任何地方宣传
// 「已加密」——我们没做加密。
//
// 另一条是恢复的措辞。恢复是这个程序里唯一一个会把现有档案整个换掉的操作，
// 所以每一句都要让用户在点确认之前知道会发生什么，包括「旧的去哪了」。

import type { ArchiveCounts, OrphanReport, PurgePreview, RestorePreview, RollbackPoint } from "./api.ts";

export interface Message {
  tone: "info" | "success" | "warn" | "pending";
  text: string;
}

/** 导出按钮旁边常驻的说明。三句话，一句都不能少；界面上逐条列出。 */
export const EXPORT_POINTS = [
  "备份是一个 ZIP 文件，包含全部申请、事件、待办、回复证据（含附件）和简历快照。",
  "文件不加密，里面有简历和邮件内容，请放在自己控制的位置。",
  "API Key、日志和这台机器专属的配置不会进备份。",
];

export const EXPORT_NOTE = EXPORT_POINTS.join("");

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

/** 恢复预览的对比表：六类都列，会变的标出来。 */
export function restoreRows(preview: RestorePreview): Array<{ label: string; current: number; incoming: number; changed: boolean }> {
  return LABELS.map(([key, label]) => ({
    label,
    current: preview.current[key],
    incoming: preview.incoming[key],
    changed: preview.current[key] !== preview.incoming[key],
  }));
}

/**
 * 时间戳给人看：能解析就换成本机时间 `2026-10-09 14:20`，解析不了就原样显示，
 * 不猜、不补。只有日期的（如回滚点 `2026-10-09`）原样留着，不编出一个 00:00。
 */
export function formatTimestamp(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "时间未知";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
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

/**
 * 回滚点是什么时候存下的。接口只给了标识和日期；标识开头是存档那一刻的 UTC 时间
 * （`2026-10-09T14-20-00-123Z-<uuid>`，冒号被换成了横线），能认出来就换成本机时间，
 * 认不出来就只显示日期。
 */
export function rollbackTime(point: RollbackPoint): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(point.id);
  if (match) {
    const at = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
    if (!Number.isNaN(at.getTime())) return formatTimestamp(at.toISOString());
  }
  return formatTimestamp(point.retiredAt);
}

/** 永久删除前要列出的连带数据。 */
export function purgeRows(preview: PurgePreview): Array<[string, string]> {
  return [
    ["事件", `${preview.events} 条`],
    ["待办", `${preview.todos} 条`],
    ["回复证据", `${preview.evidence} 份`],
    ["简历快照", `${preview.snapshots} 份`],
  ];
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
  return `wangshen-kuaitian-archive-${stamp}.zip`;
}
