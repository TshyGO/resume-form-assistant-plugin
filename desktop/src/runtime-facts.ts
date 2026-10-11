import type { RuntimeStatus } from "./api.ts";

export interface Fact {
  label: string;
  value: string;
}

function yn(flag: unknown): string {
  return flag ? "是" : "否";
}

/**
 * 设置页「运行状态」那一列。纯函数，组件只负责把它画出来。
 *
 * 值一律先转成字符串：界面上这些格子是给人核对路径和开关用的，
 * 空值要显示成「—」，不能显示成 undefined。
 */
export function runtimeFacts(status: RuntimeStatus): Fact[] {
  const text = (value: unknown): string => {
    const raw = value ?? "";
    const str = String(raw).trim();
    return str === "" ? "—" : str;
  };
  return [
    { label: "应用版本", value: text(status.appVersion) },
    { label: "标识符", value: text(status.identifier) },
    { label: "运行状态", value: text(status.runtimeLabel) },
    { label: "程序目录", value: text(status.programDir) },
    { label: "用户数据目录", value: text(status.dataRoot) },
    { label: "档案目录", value: text(status.archiveDir) },
    { label: "日志目录", value: text(status.logsDir) },
    { label: "日志文件", value: text(status.logFile) },
    { label: "应用缓存目录", value: text(status.cacheDir) },
    { label: "WebView 数据目录", value: text(status.webviewDataDir || "未由本应用托管") },
    { label: "WebView 由本应用指定", value: yn(status.webviewDataManaged) },
    { label: "WebView 说明", value: text(status.webviewDataNote) },
    { label: "current.json", value: text(status.currentPointer) },
    { label: "启动时目录可写", value: yn(status.writable) },
    { label: "唯一写入者", value: yn(status.uniqueWriter) },
    { label: "窗口可见", value: yn(status.windowVisible) },
    { label: "本次隐藏启动", value: yn(status.hiddenLaunch) },
    { label: "开机启动", value: yn(status.autostartEnabled) },
    { label: "Native Messaging", value: nativeMessaging(status) },
    {
      label: "本次升级的迁移备份",
      value: status.migrationBackupUnknown
        ? "读取失败：这次没能确认有没有迁移备份"
        : status.migrationBackup
          ? `${status.migrationBackup}（升级前自动存的，出问题可以从它恢复）`
          : "本次启动没有升级数据库",
    },
    { label: "支持待办提醒", value: yn(status.remindersImplemented) },
    { label: "关闭窗口", value: status.closeWindowMeans === "hide-to-tray" ? "隐藏到托盘或菜单栏" : text(status.closeWindowMeans) },
    { label: "退出", value: status.quitMeans === "explicit-quit" ? "通过退出操作结束应用" : text(status.quitMeans) },
  ];
}

/**
 * 注册状态。整体成没成之外，还要说清楚是哪个浏览器没成、为什么——
 * 「未注册」三个字解决不了任何人的问题。
 */
function nativeMessaging(status: RuntimeStatus): string {
  const targets = status.nativeMessaging ?? [];
  if (targets.length === 0) {
    return `${yn(status.nativeMessagingRegistered)}（还没核对过）`;
  }
  const failed = targets.filter((target) => !target.registered);
  if (failed.length === 0) {
    return `已注册（${targets.map((t) => t.label).join("、")}）`;
  }
  return failed
    .map((target) => `${target.label} 未注册：${target.note ?? "原因不明"}`)
    .join("；");
}

export interface FactGroup {
  title: string;
  facts: Fact[];
}

const GROUPS: Array<{ title: string; labels: string[] }> = [
  {
    title: "应用与窗口",
    labels: ["应用版本", "标识符", "运行状态", "程序目录", "窗口可见", "本次隐藏启动", "开机启动", "关闭窗口", "退出"],
  },
  {
    title: "本地数据",
    labels: ["用户数据目录", "档案目录", "current.json", "日志目录", "日志文件", "应用缓存目录", "启动时目录可写", "唯一写入者"],
  },
  {
    title: "浏览器与 WebView",
    labels: ["Native Messaging", "WebView 数据目录", "WebView 由本应用指定", "WebView 说明"],
  },
  { title: "迁移与提醒", labels: ["本次升级的迁移备份", "支持待办提醒"] },
];

/**
 * 技术详情按四组展示。分组只是换个排法：`runtimeFacts` 里的每一项都必须出现且只出现一次，
 * 万一以后加了新字段却忘了归组，就放进最后一组，不会悄悄丢掉。
 */
export function runtimeFactGroups(status: RuntimeStatus): FactGroup[] {
  const facts = runtimeFacts(status);
  const byLabel = new Map(facts.map((fact) => [fact.label, fact]));
  const placed = new Set<string>();
  const groups = GROUPS.map((group) => ({
    title: group.title,
    facts: group.labels.flatMap((label) => {
      const fact = byLabel.get(label);
      if (!fact) return [];
      placed.add(label);
      return [fact];
    }),
  }));
  const rest = facts.filter((fact) => !placed.has(fact.label));
  if (rest.length) groups[groups.length - 1].facts.push(...rest);
  return groups;
}
