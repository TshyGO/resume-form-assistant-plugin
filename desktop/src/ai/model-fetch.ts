// ai-models.js is also loaded as a classic script by the extension. It exposes
// ResumeProModels on globalThis; it does not have an ES module default export.
import "../../../ai-models.js";

export interface ModelFetchRaw {
  reason: string;
  status?: number | null;
  body?: string;
  timeoutMs?: number;
}

export interface ModelFetchResult {
  ok: boolean;
  reason?: string;
  message?: string;
  models?: string[];
  hiddenCount?: number;
  allModels?: string[];
}

/** 桌面拿到 Rust 的状态码和正文后，用插件同一份文案和过滤规则解释。 */
export function interpretFetchedModels(raw: ModelFetchRaw): ModelFetchResult {
  return globalThis.ResumeProModels.interpretModelTransport(raw);
}
