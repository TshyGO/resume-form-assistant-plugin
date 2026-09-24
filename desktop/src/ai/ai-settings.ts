import type { ModelListView } from "../api.ts";

export interface Message {
  tone: "ok" | "warn" | "error";
  text: string;
}

export interface Preset {
  id: string;
  name: string;
  /** Base URL，保存时由桌面补全 /chat/completions。自定义为空。 */
  apiUrl: string;
  /** 去哪里申请 Key。只显示为可复制的文字，不在应用里打开外部网页。 */
  keyPage: string;
  modelHint: string;
}

// 只列 OpenAI 兼容 Chat Completions 的常用服务商。模型名不预填：各家更新快。
export const PRESETS: Preset[] = [
  { id: "deepseek", name: "DeepSeek", apiUrl: "https://api.deepseek.com/v1", keyPage: "https://platform.deepseek.com/api_keys", modelHint: "deepseek-chat" },
  { id: "qwen", name: "通义千问", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyPage: "https://bailian.console.aliyun.com/", modelHint: "qwen-plus" },
  { id: "kimi", name: "Kimi", apiUrl: "https://api.moonshot.cn/v1", keyPage: "https://platform.moonshot.cn/console/api-keys", modelHint: "" },
  { id: "zhipu", name: "智谱", apiUrl: "https://open.bigmodel.cn/api/paas/v4", keyPage: "https://open.bigmodel.cn/usercenter/apikeys", modelHint: "" },
  { id: "doubao", name: "豆包（火山方舟）", apiUrl: "https://ark.cn-beijing.volces.com/api/v3", keyPage: "https://console.volcengine.com/ark", modelHint: "" },
  { id: "openrouter", name: "OpenRouter", apiUrl: "https://openrouter.ai/api/v1", keyPage: "https://openrouter.ai/keys", modelHint: "" },
  { id: "openai", name: "OpenAI", apiUrl: "https://api.openai.com/v1", keyPage: "https://platform.openai.com/api-keys", modelHint: "gpt-4o-mini" },
  { id: "custom", name: "自定义", apiUrl: "", keyPage: "", modelHint: "" },
];

/** 一个服务商的 Key 状态。凭据库本身出错时优先说出错。 */
export function describeProviderKey(provider: { keyConfigured: boolean }, credentialError: string | null): Message {
  if (credentialError) return { tone: "error", text: credentialError };
  return provider.keyConfigured
    ? { tone: "ok", text: "已保存 Key（存在系统凭据库里，界面不会显示它）。" }
    : { tone: "warn", text: "还没有 Key。没有 Key 就不能用 AI，手动操作照常可用。" };
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

/** 获取模型成功后的提示：几个能填、几个藏了、问的哪台主机。 */
export function describeModelsResult(view: ModelListView): Message {
  const hidden = view.hiddenCount > 0 ? `另有 ${view.hiddenCount} 个非对话模型已隐藏。` : "";
  if (view.models.length === 0) {
    return { tone: "warn", text: `问过 ${view.host} 了，列表里没有能填的对话模型。${hidden}可直接手填模型名称。` };
  }
  return { tone: "ok", text: `从 ${view.host} 拿到 ${view.models.length} 个模型，点一个填进去，也可直接手填。${hidden}` };
}

/** 完全一致优先，然后前缀（含 vendor/ 后半段），最后子串。 */
export function matchModels(ids: string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...ids];
  const rank = (id: string): number => {
    const lower = id.toLowerCase();
    if (lower === needle) return 0;
    const afterVendor = lower.slice(lower.lastIndexOf("/") + 1);
    if (lower.startsWith(needle) || afterVendor.startsWith(needle)) return 1;
    return lower.includes(needle) ? 2 : -1;
  };
  return ids
    .map((id, index) => ({ id, index, rank: rank(id) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.id);
}

/** 命令报错时的文案：错误码留着，方便对日志。 */
export function describeCommandError(error: unknown): Message {
  const err = error as { code?: string; message?: string } | null;
  const code = err?.code ?? "UNKNOWN";
  const detail = err?.message ?? "没有更多信息";
  return { tone: "error", text: `${detail}（${code}）` };
}
