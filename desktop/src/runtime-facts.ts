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
    { label: "开机启动", value: `${yn(status.autostartEnabled)}（D02 不会注册）` },
    {
      label: "Native Messaging",
      value: `${yn(status.nativeMessagingRegistered)}（未注册，属 D06/D13）`,
    },
    { label: "提醒已实现", value: `${yn(status.remindersImplemented)}（属 D10）` },
    { label: "关闭窗口", value: text(status.closeWindowMeans) },
    { label: "退出", value: text(status.quitMeans) },
  ];
}
