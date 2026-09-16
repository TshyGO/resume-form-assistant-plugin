import type { AiSettingsView } from "../api.ts";

export interface Message {
  tone: "ok" | "warn" | "error";
  text: string;
}

/** Key 配没配、凭据库能不能用，说清楚就行，不要让用户去猜。 */
export function describeKeyState(view: AiSettingsView | null): Message {
  if (!view) {
    return { tone: "warn", text: "还没读到 AI 设置。" };
  }
  if (view.credentialError) {
    return { tone: "error", text: view.credentialError };
  }
  return view.keyConfigured
    ? { tone: "ok", text: "已保存一条 Key（存在系统凭据库里，界面不会显示它）。" }
    : { tone: "warn", text: "还没有 Key。没有 Key 就不能用 AI 整理，手动分类照常可用。" };
}

/**
 * 明文传输提醒。和插件那边一个口径：局域网温和提示，公网明确警告，都不拦着用。
 */
export function describeTransportRisk(apiUrl: string): Message | null {
  const value = apiUrl.trim().toLowerCase();
  if (!value.startsWith("http://")) {
    return null;
  }
  const host = value.slice("http://".length).split("/")[0]?.split(":")[0] ?? "";
  const local =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    /^10(\.\d{1,3}){3}$/.test(host) ||
    /^192\.168(\.\d{1,3}){2}$/.test(host);
  if (local) {
    return { tone: "warn", text: "这是明文 http 的本机或局域网地址，内容不会加密。" };
  }
  return {
    tone: "error",
    text: "这是明文 http 的公网地址：证据正文和 Key 会以明文经过网络。建议改用 https。",
  };
}

/** 保存后的提示：地址被补全过就说清楚补成了什么。 */
export function describeSaved(typedUrl: string, view: AiSettingsView): Message {
  const typed = typedUrl.trim();
  if (typed && typed !== view.apiUrl) {
    return { tone: "ok", text: `已保存。接口地址补全为 ${view.apiUrl}` };
  }
  return { tone: "ok", text: "已保存。" };
}

/** 命令报错时的文案：错误码留着，方便对日志。 */
export function describeCommandError(error: unknown): Message {
  const err = error as { code?: string; message?: string } | null;
  const code = err?.code ?? "UNKNOWN";
  const detail = err?.message ?? "没有更多信息";
  return { tone: "error", text: `${detail}（${code}）` };
}
