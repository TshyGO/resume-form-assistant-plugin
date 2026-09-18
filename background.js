import { installDesktopLink } from "./link/worker.mjs";

// The desktop link owns its own message listener. It deliberately does not touch
// chrome.action.onClicked or ENSURE_AI_HOST below: those belong to the existing plugin and
// keep working whether or not a desktop is installed.
installDesktopLink(chrome);

async function openManagerTab(requestedTab = "") {
  const hash = requestedTab === "profile" ? "#profile" : "";
  return chrome.tabs.create({ url: `${chrome.runtime.getURL("popup.html")}${hash}` });
}

chrome.action.onClicked.addListener(() => openManagerTab());

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
  if (message?.type === "OPEN_MANAGER") {
    openManagerTab(message.tab).then(() => sendResponse({ opened: true })).catch(() => {
      sendResponse({ opened: false, error: "无法打开管理面板，请从浏览器工具栏点击 Resume Pro。" });
    });
    return true;
  }
  if (message?.type === "ENSURE_AI_HOST") {
    ensureAiHost().then(() => sendResponse({ ready: true })).catch(() => {
      sendResponse({ ready: false, error: "无法启动 AI 请求进程，请更新 Chrome / Edge 或重新加载扩展。" });
    });
    return true;
  }
  return false;
});
