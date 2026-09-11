(function initResumeProModels(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.ResumeProModels = api;
  }
})(typeof self !== "undefined" ? self : globalThis, function createResumeProModels() {
  const DEFAULT_TIMEOUT_MS = 15000;
  const CHAT_SUFFIX = /\/chat\/completions$/iu;

  // A path is treated as an OpenAI-compatible base only when it could not have worked
  // as a chat endpoint itself: it ends in a version segment (/v1, /api/v3, /v1beta) or
  // in /openai (Gemini, Cloudflare AI Gateway). Anything else is left exactly as typed,
  // because a proxy may serve chat on a path we cannot recognise, and appending to it
  // would break a configuration that works today.
  function isBasePath(path) {
    const lastSegment = path.split("/").pop() || "";
    return /^v\d+[a-z0-9]*$/iu.test(lastSegment) || lastSegment.toLowerCase() === "openai";
  }

  function withPath(url, pathname) {
    const next = new URL(url.href);
    next.hash = "";
    next.pathname = pathname;
    return next.href;
  }

  function resolveEndpoints(input) {
    const text = String(input ?? "").trim();
    let url;

    try {
      url = new URL(text);
    } catch {
      return null;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const path = url.pathname.replace(/\/+$/u, "");

    if (CHAT_SUFFIX.test(path)) {
      return { chatUrl: text, modelsUrl: withPath(url, path.replace(CHAT_SUFFIX, "/models")) };
    }

    if (path === "" || isBasePath(path)) {
      const base = path || "/v1";
      return { chatUrl: withPath(url, `${base}/chat/completions`), modelsUrl: withPath(url, `${base}/models`) };
    }

    return { chatUrl: text, modelsUrl: null };
  }

  // Completion happens on save, never on read: the stored apiUrl keeps meaning "the chat
  // endpoint", so every call site that fetches it stays untouched. A value the user did
  // not edit is saved verbatim, so re-saving an old configuration can never rewrite it.
  function normalizeApiUrlForSave(typed, previous) {
    if (typed === previous) {
      return typed;
    }

    return resolveEndpoints(typed)?.chatUrl ?? typed;
  }

  // Narrow fragments only. Bare "audio" or "voice" would hide chat models such as
  // gpt-4o-audio-preview. "image" is matched only as a whole name segment (Qwen-Image,
  // Z-Image-Turbo, gpt-image-1): vision chat models are named VL/V instead. Hiding is
  // advisory anyway: the input accepts any typed name.
  const SEP = "(?:^|[\\/_.:\\s-])";
  const END = "(?:$|[\\/_.:\\s-])";
  const NON_CHAT_PATTERNS = [
    /embed/iu,
    /rerank/iu,
    new RegExp(`${SEP}bge${END}`, "iu"),
    new RegExp(`${SEP}ttsd?${END}`, "iu"),
    new RegExp(`asr${END}`, "iu"),
    /whisper/iu,
    /transcribe/iu,
    /dall-e/iu,
    new RegExp(`${SEP}image${END}`, "iu"),
    /moderation/iu,
    new RegExp(`${SEP}flux${END}`, "iu"),
    /stable-diffusion|sdxl/iu,
    /kolors/iu,
    /cosyvoice/iu,
    /sensevoice/iu,
    /fish-speech/iu,
    new RegExp(`${SEP}[ti]2v${END}`, "iu")
  ];

  function filterChatModels(ids) {
    const chat = [];
    const hidden = [];

    for (const id of ids) {
      (NON_CHAT_PATTERNS.some((pattern) => pattern.test(id)) ? hidden : chat).push(id);
    }

    return { chat, hidden };
  }

  // Suggestions for what the user has typed so far. Exact hits first, then names that
  // start with the query (also after a "vendor/" prefix), then any substring hit.
  function matchModels(ids, query) {
    const needle = String(query ?? "").trim().toLowerCase();

    if (!needle) {
      return [...ids];
    }

    const rank = (id) => {
      const lower = id.toLowerCase();
      if (lower === needle) return 0;
      if (lower.startsWith(needle) || lower.slice(lower.lastIndexOf("/") + 1).startsWith(needle)) return 1;
      return lower.includes(needle) ? 2 : -1;
    };

    return ids
      .map((id, index) => ({ id, index, rank: rank(id) }))
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.id);
  }

  function parseModelList(body) {
    const entries = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;

    if (!entries) {
      return null;
    }

    const ids = entries
      .map((entry) => (typeof entry === "string" ? entry : typeof entry?.id === "string" ? entry.id : ""))
      .map((id) => id.trim())
      .filter(Boolean);

    return [...new Set(ids)].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }));
  }

  function failure(reason, message) {
    return { ok: false, reason, message };
  }

  function providerDetail(body) {
    const detail = body?.error?.message || body?.message || (typeof body?.error === "string" ? body.error : "");
    return String(detail).replace(/\s+/gu, " ").trim().slice(0, 200);
  }

  async function fetchModelList({ apiUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const endpoints = resolveEndpoints(apiUrl);

    if (!endpoints) {
      return failure("invalid-url", "API URL 格式不对，请填写以 http:// 或 https:// 开头的地址。");
    }

    if (!endpoints.modelsUrl) {
      return failure(
        "unknown-shape",
        "无法从这个 API URL 推断模型列表地址（通常以 /v1 或 /chat/completions 结尾）。可直接手填模型名称。"
      );
    }

    const key = String(apiKey ?? "").trim();

    if (!key) {
      return failure("missing-key", "请先填写 API Key，再获取模型。");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let status;
    let text;

    try {
      const response = await fetchImpl(endpoints.modelsUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal
      });
      status = response.status;
      text = await response.text();
    } catch {
      if (timedOut) {
        const seconds = Math.max(1, Math.round(timeoutMs / 1000));
        return failure("timeout", `请求超时（${seconds} 秒无响应）：连不上该地址或服务过慢，请检查网络或代理。`);
      }

      return failure("network", "连不上该地址：请检查网络、代理，以及 API URL 的域名拼写。");
    } finally {
      clearTimeout(timer);
    }

    let body = null;

    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    const detail = providerDetail(body);
    const suffix = detail ? `服务返回：${detail}` : "";

    if (status === 401 || status === 403) {
      return failure("auth", `API Key 被拒绝（HTTP ${status}）：请检查密钥是否正确、是否有效。${suffix}`);
    }

    if (status === 404 || status === 405) {
      return failure(
        "not-found",
        `该地址没有返回模型列表（HTTP ${status}）。可能是地址不对（常见：漏了 /v1），也可能是服务商不提供模型列表——可直接手填模型名称。`
      );
    }

    if (status < 200 || status >= 300) {
      return failure("http", `获取模型失败（HTTP ${status}）${detail ? `：${detail}` : "。"}`);
    }

    const allModels = parseModelList(body);

    if (!allModels) {
      return failure("not-a-list", "该地址返回的不是模型列表，请检查 API URL 是否指向 OpenAI 兼容接口。");
    }

    const { chat, hidden } = filterChatModels(allModels);
    return { ok: true, models: chat, hiddenCount: hidden.length, allModels };
  }

  return {
    fetchModelList,
    filterChatModels,
    matchModels,
    normalizeApiUrlForSave,
    parseModelList,
    resolveEndpoints
  };
});
