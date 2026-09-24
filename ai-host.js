// Offscreen documents support runtime messaging; the dedicated worker owns fetch.
const worker = new Worker("ai-worker.js");
const pending = new Map();
let sequence = 0;
let failed = false;
worker.onmessage = ({ data }) => {
  const respond = pending.get(data.id);
  pending.delete(data.id);
  respond?.(data.reply);
};
worker.onerror = () => {
  failed = true;
  for (const respond of pending.values()) respond({ success: false, error: "AI 请求进程已中断，请重新加载扩展。" });
  pending.clear();
};
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AI_HOST_READY") {
    sendResponse({ ready: !failed });
    return false;
  }
  if (!["AI_FILL", "AI_PLAN_REPEAT", "CANCEL_AI_FILL", "PARSE_RESUME"].includes(message?.type)) return false;
  if (failed) {
    sendResponse({ success: false, error: "AI 请求进程已中断，请重新加载扩展。" });
    return false;
  }
  const id = ++sequence;
  pending.set(id, sendResponse);
  worker.postMessage({ id, message, sender: { tab: sender.tab ? { id: sender.tab.id } : undefined, frameId: sender.frameId, documentId: sender.documentId } });
  return true;
});
