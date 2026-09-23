// 「连接浏览器」这一段的纯逻辑：状态怎么说、下一步该做什么。
//
// 固定扩展 ID 之后，正常路径上不再需要用户粘贴 32 位 ID —— 那一步现在只留给
// 开发模式。这里只算文案和状态，打开商店页由命令层做（URL 只有一份，在 Rust 里）。

import type { RuntimeStatus } from "./api.ts";

export interface LinkState {
  tone: "ok" | "warn" | "error";
  /** 现在是什么情况。 */
  text: string;
  /** 接下来该做什么。已经连上时为空。 */
  next: string;
  /** 「去装扩展」这个按钮要不要显示。商店审核期间也要一直在，不能等注册成功才出现。 */
  showInstall: boolean;
  /** 「重新检查注册」要不要显示。成功时也保留，便于发现启动后的外部改动。 */
  showRetry: boolean;
}

export interface NativeMessagingRegistrationOutcome {
  registered: boolean;
}

/** Only report success when the command returned at least one target and every target registered. */
export function registrationCompleted(
  outcomes: readonly NativeMessagingRegistrationOutcome[],
): boolean {
  return outcomes.length > 0 && outcomes.every((outcome) => outcome.registered);
}

/**
 * 三件事凑齐才算连上：清单写了、扩展装了、协议版本对得上。
 * 缺哪一件就说哪一件，不要笼统地说「未连接」。
 */
export function describeLink(status: RuntimeStatus | null): LinkState {
  if (!status) {
    return {
      tone: "warn",
      text: "还没读到桌面状态。",
      next: "稍等一下，或者重开一次应用。商店还在审核的话，可以先下载插件包。",
      showInstall: true,
      showRetry: false,
    };
  }

  const targets = status.nativeMessaging ?? [];
  const failed = targets.filter((target) => !target.registered);
  if (targets.length === 0) {
    return {
      tone: "warn",
      text: "还没核对过浏览器注册。",
      next: "点「重新检查注册」让桌面写一次清单。商店还在审核的话，先下载插件包加载。",
      showInstall: true,
      showRetry: true,
    };
  }
  if (failed.length === targets.length) {
    return {
      tone: "error",
      text: `浏览器找不到桌面程序：${failed.map((t) => `${t.label} ${t.note ?? "未注册"}`).join("；")}`,
      next: "先解决上面的问题，否则扩展装了也连不上。商店还在审核的话，先下载插件包加载。",
      showInstall: true,
      showRetry: true,
    };
  }

  const ready = targets.filter((target) => target.registered).map((target) => target.label);
  const partial = failed.length > 0 ? `（${failed.map((t) => t.label).join("、")}没注册上）` : "";
  return {
    tone: failed.length > 0 ? "warn" : "ok",
    text: `桌面这边准备好了：${ready.join("、")}${partial}。`,
    next: "在浏览器里装上扩展，装完回到这里刷新一下。商店还在审核就先下载插件包。",
    showInstall: true,
    showRetry: true,
  };
}

/**
 * 装完扩展之后的提示。浏览器要重新读一次 host 清单，才连得上刚写好的注册
 * （D01 的 V3：清单变了不保证不重启就生效）。
 */
export const AFTER_INSTALL_HINT =
  "装好之后如果还连不上，把扩展在浏览器里重新加载一次，或者重启浏览器——它要重新读一遍 host 清单。";

/** 商店页打不开或无法安装时的手动安装办法。 */
export const STORE_PENDING_HINT =
  "如果暂时无法从商店安装，请点「下载插件包」，解压后在 Chrome 或 Edge 的扩展页打开「开发者模式」，用「加载已解压的扩展程序」选中解压出来的文件夹。";

/** 协议版本对不上时，说清楚谁该升。 */
export function describeProtocolMismatch(
  desktop: number | null | undefined,
  plugin: number | null | undefined,
): string | null {
  if (!desktop || !plugin || desktop === plugin) {
    return null;
  }
  const older = desktop < plugin ? "桌面" : "扩展";
  return `协议版本对不上：桌面 v${desktop}，扩展 v${plugin}。升级${older}那一边。`;
}
