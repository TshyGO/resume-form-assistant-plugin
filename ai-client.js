(function (root) {
  const pending = new Map();
  async function send(message) {
    const key = message.requestId || Symbol();
    let posted;
    pending.set(key, new Promise(resolve => { posted = resolve; }));
    try {
      const host = await chrome.runtime.sendMessage({ type: "ENSURE_AI_HOST" });
      if (!host?.ready) throw new Error(host?.error || "无法启动 AI 请求进程。");
      const ready = await chrome.runtime.sendMessage({ type: "AI_HOST_READY" });
      if (!ready?.ready) throw new Error("AI 请求进程尚未就绪，请重新加载扩展。");
      const result = chrome.runtime.sendMessage(message);
      posted(true);
      return await result;
    } finally {
      posted(false);
      pending.delete(key);
    }
  }
  async function cancel(requestId) {
    const posting = pending.get(requestId);
    if (!posting || !await posting) return { cancelled: false };
    return chrome.runtime.sendMessage({ type: "CANCEL_AI_FILL", requestId });
  }
  root.ResumeProAIClient = { send, cancel };
})(typeof self !== "undefined" ? self : globalThis);
