// 「连接浏览器」这一段的纯逻辑：状态怎么说、下一步该做什么。
//
// 固定扩展 ID 之后，正常路径上不再需要用户粘贴 32 位 ID —— 那一步现在只留给
// 开发模式。这里只算文案和状态，打开商店页由命令层做（URL 只有一份，在 Rust 里）。

import type { RuntimeStatus } from "./api.ts";

export interface LinkProblem {
  label: string;
  /** 宿主给的原始说明，含完整路径；原样显示，可选中复制。 */
  note: string;
  /** 是不是「已经有一份别的同名清单」。只有这种才配「同名清单冲突」的说明。 */
  conflict: boolean;
}

export interface LinkState {
  tone: "pending" | "ok" | "warn" | "error";
  /** 状态胶囊上的短语：只说注册结果，不说「已连接」。 */
  status: string;
  /** 出问题时的原因摘要；没问题时为空。 */
  text: string;
  /** 每个没注册上的浏览器各一条。 */
  problems: LinkProblem[];
  /** 接下来该做什么。 */
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

/** 宿主在「别人的同名清单」时写的说法（nm_register.rs 的 Decision::NotOurs）。 */
function isConflict(note: string): boolean {
  return note.includes("同名清单");
}

/** 同名清单冲突时的处理办法。只配给真的冲突，不拿去解释权限之类的别的错。 */
export const CONFLICT_HINT =
  "这份同名清单不是本程序写的，可能来自已安装的正式版或旧版本。确认不再需要后删除上面的文件，再点「重新检查注册」。";

function summarize(problems: LinkProblem[]): string {
  const labels = problems.map((problem) => problem.label).join("、");
  if (problems.every((problem) => problem.conflict)) {
    return `${labels} 注册失败：已经有一份别的同名清单，桌面没有改动它。`;
  }
  if (problems.length === 1) return `${labels} 注册失败：${problems[0].note}`;
  if (problems.every((problem) => !problem.conflict)) {
    return `${labels} 注册失败：写入连接清单时出错，展开查看每个浏览器的原因。`;
  }
  return `${labels} 注册失败，原因各不相同，展开查看每个浏览器的原因。`;
}

/**
 * 浏览器连接卡片要说的话。桌面只掌握 Native Messaging 清单写没写成：
 * 注册不等于扩展装好，也不等于连上，所以从不说「已连接」。
 * `readError` 是这一次读运行状态失败的原因；有它时不沿用旧状态假装知道。
 */
export function describeLink(status: RuntimeStatus | null, readError?: string | null): LinkState {
  const base = { problems: [] as LinkProblem[], text: "", showInstall: true };
  if (readError) {
    return {
      ...base,
      tone: "error",
      status: "读取注册状态失败",
      text: `读不到桌面运行状态：${readError}`,
      next: "页面每隔几秒会自动重读；也可以点「重新检查注册」。",
      showRetry: true,
    };
  }
  if (!status) {
    return { ...base, tone: "pending", status: "正在读取注册状态…", next: "", showRetry: false };
  }

  const targets = status.nativeMessaging ?? [];
  if (targets.length === 0) {
    return {
      ...base,
      tone: "warn",
      status: "尚未核对注册",
      next: "还没核对过浏览器注册。点「重新检查注册」让桌面写一次清单。商店暂时无法安装时，可以先下载插件包手动加载。",
      showRetry: true,
    };
  }

  const problems = targets
    .filter((target) => !target.registered)
    .map((target) => {
      const note = target.note?.trim() || "原因不明";
      return { label: target.label, note, conflict: isConflict(note) };
    });
  const ready = targets.filter((target) => target.registered).map((target) => target.label);

  if (ready.length === 0) {
    return {
      ...base,
      tone: "error",
      status: "浏览器注册失败",
      text: summarize(problems),
      problems,
      next: "先处理上面的问题，再点「重新检查注册」。在这之前，扩展装上了也连不上桌面。",
      showRetry: true,
    };
  }
  if (problems.length > 0) {
    return {
      ...base,
      tone: "warn",
      status: `已注册 ${ready.join("、")} · ${problems.map((p) => p.label).join("、")} 注册失败`,
      text: summarize(problems),
      problems,
      next: `${ready.join("、")} 可以装上扩展使用；${problems.map((p) => p.label).join("、")} 要先处理上面的问题。`,
      showRetry: true,
    };
  }
  return {
    ...base,
    tone: "ok",
    status: `已注册 ${ready.join("、")}`,
    next: "在浏览器里装上扩展就能使用。扩展有没有装好、连没连上，要在浏览器里查看。",
    showRetry: true,
  };
}

export interface RegistrationPill {
  tone: "ok" | "warn" | "error" | "pending";
  text: string;
  /** 悬停说明：注册只是桌面写好了清单，不等于扩展装好或连上。 */
  title: string;
}

const REGISTRATION_ONLY =
  "这里只说明桌面是否已在浏览器里登记连接方式，不代表扩展已安装或已经连上。";

/**
 * 顶栏那颗状态胶囊。桌面只掌握 Native Messaging 清单写没写成，所以只说「已注册」，
 * 绝不说「已连接」——扩展装没装、连没连上，桌面这边并不知道。
 */
export function describeRegistration(status: RuntimeStatus | null): RegistrationPill {
  if (!status) return { tone: "pending", text: "正在读取浏览器注册…", title: REGISTRATION_ONLY };
  const targets = status.nativeMessaging ?? [];
  if (targets.length === 0) {
    return { tone: "warn", text: "浏览器注册未核对", title: REGISTRATION_ONLY };
  }
  const ready = targets.filter((target) => target.registered).map((target) => target.label);
  const failed = targets.filter((target) => !target.registered).map((target) => target.label);
  if (ready.length === 0) {
    return { tone: "error", text: "浏览器未注册", title: `${failed.join("、")} 未注册。${REGISTRATION_ONLY}` };
  }
  if (failed.length > 0) {
    return { tone: "warn", text: `已注册 ${ready.join("、")} · ${failed.join("、")} 未注册`, title: REGISTRATION_ONLY };
  }
  return { tone: "ok", text: `已注册 ${ready.join("、")}`, title: REGISTRATION_ONLY };
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
