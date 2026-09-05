chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_MANAGER" }); } catch {}
  }
});

// This service worker only creates the host. It never owns a long AI request.
let creatingHost = null;
async function ensureAiHost() {
  if (creatingHost) return creatingHost;
  creatingHost = (async () => {
    const url = chrome.runtime.getURL("ai-host.html");
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: "ai-host.html", reasons: ["WORKERS"],
        justification: "Run user-requested AI network operations in a dedicated worker without service-worker fetch time limits."
      });
    }
  })();
  try { await creatingHost; } finally { creatingHost = null; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ENSURE_AI_HOST") return false;
  ensureAiHost().then(() => sendResponse({ ready: true })).catch(() => {
    sendResponse({ ready: false, error: "无法启动 AI 请求进程，请更新 Chrome / Edge 或重新加载扩展。" });
  });
  return true;
});
