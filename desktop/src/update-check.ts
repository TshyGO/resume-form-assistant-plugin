// 更新检查的纯逻辑：版本怎么比、什么时候该查、查完说什么。
//
// 首发只做「检查并提示」，不下载、不静默安装（D13 计划里定的）。理由是安装包
// 没有签名：让程序自己下一个未签名的安装包再运行，远比让用户自己去下更糟。

export interface UpdateInfo {
  /** 最新版本号，例如 `0.2.0`。 */
  version: string;
  /** 那一版的发布页。 */
  url: string;
}

export interface UpdatePreference {
  /** 启动时自动查一次（每天最多一次）。 */
  enabled: boolean;
  /** 上次检查的时间，RFC3339。没查过就是空。 */
  lastCheckedAt?: string | null;
}

/**
 * 比较 `1.2.3` 这样的版本号。只认三段数字——预发布版本怎么发还没定，
 * 发版守卫那边也拒绝这种 tag。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 该不该查。关了就不查；今天查过了也不查——用户不需要每次开窗都联一次网。 */
export function shouldCheck(pref: UpdatePreference, nowIso: string): boolean {
  if (!pref.enabled) return false;
  const last = pref.lastCheckedAt;
  if (!last) return true;
  const lastDay = last.slice(0, 10);
  const today = nowIso.slice(0, 10);
  return lastDay !== today;
}

export interface UpdateMessage {
  tone: "ok" | "warn" | "error";
  text: string;
  /** 有没有新版本可下载。界面照它决定要不要显示「去下载」。 */
  available: boolean;
}

/** 查完之后说什么。 */
export function describeUpdate(current: string, latest: UpdateInfo | null): UpdateMessage {
  if (!latest) {
    return { tone: "ok", text: `已经是最新版（${current}）。`, available: false };
  }
  const order = compareVersions(latest.version, current);
  if (order <= 0) {
    return { tone: "ok", text: `已经是最新版（${current}）。`, available: false };
  }
  return {
    tone: "warn",
    text: `有新版本 ${latest.version}（现在是 ${current}）。下载后手动安装，装之前不用卸载旧版。`,
    available: true,
  };
}

/** 查不到时的说法。查不到不是错误，不该打扰用户。 */
export function describeCheckFailure(error: unknown): UpdateMessage {
  const detail = error as { code?: string; message?: string } | null;
  switch (detail?.code) {
    case "UPDATE_OFFLINE":
      return { tone: "warn", text: "连不上更新服务器，这次没查到。", available: false };
    case "UPDATE_RATE_LIMITED":
      return { tone: "warn", text: "更新服务器暂时限流了，过一会儿再查。", available: false };
    default:
      return {
        tone: "warn",
        text: `没查成：${detail?.message ?? "原因不明"}`,
        available: false,
      };
  }
}
