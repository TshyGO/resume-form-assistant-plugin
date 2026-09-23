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
  if (!view.activeId) {
    return {
      tone: "warn",
      text: "还没有当前配置。保存一份并使用之后才能整理；手动分类照常可用。",
    };
  }
  return view.keyConfigured
    ? { tone: "ok", text: "当前配置已保存一条 Key（存在系统凭据库里，界面不会显示它）。" }
    : { tone: "warn", text: "当前配置还没有 Key。没有 Key 就不能用 AI 整理，手动分类照常可用。" };
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

/**
 * 接口地址里夹带凭据的提醒。我们承诺「Key 只在 Authorization 头里」，但用户完全
 * 可能把 key 贴进地址：`https://user:pass@host/…` 或者 `?api-key=…`。那样它会随
 * 每一次请求出现在 URL 里，也更容易被中转站的访问日志记下来。
 */
export function describeUrlSecrets(apiUrl: string): Message | null {
  const value = apiUrl.trim();
  if (value === "") return null;
  const rest = value.split("://")[1] ?? value;
  const authority = rest.split("/")[0] ?? "";
  if (authority.includes("@")) {
    return {
      tone: "error",
      text: "接口地址里带了用户名或密码。它会随每次请求一起发出去，也会进中转站的日志。Key 请填在下面的 API Key 里。",
    };
  }
  // 判定规则和命令层的 `ai_settings::credential_in_url` 保持一致：按分段比，
  // 查询串和 fragment 都看。两边口径不一样，用户会遇到「这里提示、那里能存」。
  const SECRETS = [
    "key",
    "apikey",
    "token",
    "secret",
    "password",
    "auth",
    "credential",
    "sig",
    "sign",
    "signature",
  ];
  const tail = [value.split("?")[1] ?? "", value.split("#")[1] ?? ""].join("&");
  const suspicious = tail
    .split(/[&;]/)
    .map((pair) => (pair.split("=")[0] ?? "").toLowerCase())
    .find((name) => name.split(/[^a-z0-9]/).some((segment) => SECRETS.includes(segment)));
  if (suspicious) {
    return {
      tone: "warn",
      text: `接口地址里的 ${suspicious} 看着像一把 Key。保存时会被拒；Key 请填在下面的「API Key」里。`,
    };
  }
  return null;
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
