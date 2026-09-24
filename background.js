import { installDesktopLink } from "./link/worker.mjs";

// The desktop link owns its own message listener. It deliberately does not touch
// chrome.action.onClicked or ENSURE_AI_HOST below: those belong to the existing plugin and
// keep working whether or not a desktop is installed.
installDesktopLink(chrome);

// Browsers without the side panel API open the status page from the toolbar instead.
async function openManagerTab() {
  const baseUrl = chrome.runtime.getURL("popup.html");
  const targetUrl = baseUrl;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url?.startsWith(baseUrl));
  if (existing?.id) {
    const update = { active: true };
    if (existing.url !== targetUrl) update.url = targetUrl;
    const tab = await chrome.tabs.update(existing.id, update);
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return tab;
  }
  return chrome.tabs.create({ url: targetUrl });
}

// Register toolbar events synchronously: MV3 service workers can be restarted by
// the click itself. Browsers without sidePanel fall back to the old manager tab.
let sidePanelReady = Promise.resolve(false);
chrome.action.onClicked.addListener(() => {
  sidePanelReady.then((ready) => {
    if (!ready) openManagerTab().catch(() => console.warn("Resume Pro could not open its manager tab."));
  });
});
if (chrome.sidePanel?.setPanelBehavior) {
  try {
    sidePanelReady = Promise.resolve(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }))
      .then(() => true, () => {
        console.warn("Resume Pro could not enable the browser side panel.");
        return false;
      });
  } catch {
    console.warn("Resume Pro could not enable the browser side panel.");
  }
}

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
  if (message?.type === "SIDE_PANEL_CAPABILITY") {
    sidePanelReady.then((supported) => sendResponse({ supported }));
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
