import { installDesktopLink } from "./link/worker.mjs";
import { installFeedback } from "./link/feedback.mjs";
// #226 站点配方的存储规则（和内容脚本是同一份文件）：这些脚本只把接口挂到 self 上。
import "./page-outline.js";
import "./deep-analysis.js";
import "./page-recipe.js";

installFeedback(chrome);

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
    if (!ready) openManagerTab().catch(() => console.warn("网申快填 could not open its manager tab."));
  });
});
if (chrome.sidePanel?.setPanelBehavior) {
  try {
    sidePanelReady = Promise.resolve(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }))
      .then(() => true, () => {
        console.warn("网申快填 could not enable the browser side panel.");
        return false;
      });
  } catch {
    console.warn("网申快填 could not enable the browser side panel.");
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

// #226 站点配方只在这里写入：所有保存、删除、更新最近使用排成一队，两个网页同时保存也不会互相覆盖。
// 只接受本扩展内容脚本（网页顶层）发来的请求，并且只能写它自己所在网页的那一条（按发送方网址重新归类核对）。
// 配方是本机缓存：这里不转发、不上传，也不交给桌面。
const recipes = globalThis.ResumeProPageRecipe?.createStore(chrome.storage.local) || null;
const RECIPE_MESSAGES = new Set(["RECIPE_SAVE", "RECIPE_DELETE", "RECIPE_TOUCH"]);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!RECIPE_MESSAGES.has(message?.type)) return false;
  const api = globalThis.ResumeProPageRecipe;
  const key = api && sender?.id === chrome.runtime.id && sender.tab && sender.frameId === 0 ? api.pageKey(sender.url) : null;
  if (!recipes || !key?.ok || key.host !== message.host || key.path !== message.path) {
    sendResponse({ ok: false, error: "forbidden" });
    return false;
  }
  const task = message.type === "RECIPE_SAVE" ? recipes.read().then(({ store }) => {
    const replaced = Boolean(api.findRecipe(store, key));
    return recipes.save(key.host, key.path, message.recipe).then(result => ({ ...result, replaced }));
  })
    : message.type === "RECIPE_DELETE" ? recipes.remove(key.host, key.path)
      : recipes.touch(key.host, key.path);
  task.then(result => sendResponse({ ok: Boolean(result?.ok), error: result?.ok ? undefined : result?.error || "storage_failed",
    ...(message.type === "RECIPE_SAVE" ? { replaced: Boolean(result?.replaced) } : {}) }))
    .catch(() => sendResponse({ ok: false, error: "storage_failed" }));
  return true;
});
