import type { Invoke } from "./api.ts";
import type { MailAttachments } from "./attachment-types.ts";
/** Build trusted DOM from plain text and local image references. No email HTML enters the page. */
export function mountMailBody(container: HTMLElement, invoke: Invoke, evidenceId: string, title: string, data: MailAttachments) {
  let active = true;
  const blocks = data.bodyBlocks ?? [];
  if (!blocks.length) return () => { active = false; };
  const photos = blocks.flatMap(b => b.kind === "image" ? [b.attachment] : []);
  const unique = photos.filter((p, i) => photos.findIndex(other => other.index === p.index) === i);
  const previews: MailAttachments = { sourceSha256: data.sourceSha256, items: unique, contentKind: "bodyImage" };
  const tasks: (() => Promise<void>)[] = [];
  const nodes = blocks.map(block => {
    if (block.kind === "text") {
      const pre = document.createElement("pre"); pre.className = "evidence-body"; pre.textContent = block.text;
      return pre;
    }
    const item = block.attachment;
    const figure = document.createElement("figure"); figure.className = "mail-body-photo";
    const button = document.createElement("button"); button.type = "button";
    button.setAttribute("aria-label", `放大查看正文图片：${item.name}`);
    const state = document.createElement("span"); state.className = "muted"; state.textContent = "正在读取正文图片…";
    const caption = document.createElement("figcaption"); caption.textContent = "正文图片 · 点击放大查看";
    button.append(state); figure.append(button, caption);
    button.addEventListener("click", () => {
      button.focus();
      void import("./attachment-viewer.tsx").then(({ openAttachmentViewer }) => {
        if (active && button.isConnected) openAttachmentViewer(invoke, evidenceId, title, previews, item.index);
      }).catch(() => { if (active) caption.textContent = "图片窗口暂时无法打开，请重新点击。"; });
    });
    tasks.push(async () => {
      try {
        const preview = await invoke<{ bytesBase64: string; mime: string }>("preview_evidence_attachment_cmd", { evidenceId, index: item.index, sourceSha256: data.sourceSha256 });
        if (!active || !container.isConnected) return;
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(preview.mime)) throw new Error("unsupported image");
        const image = document.createElement("img"); image.alt = item.name;
        image.src = `data:${preview.mime};base64,${preview.bytesBase64}`;
        image.addEventListener("error", () => { if (active) { state.textContent = "正文图片暂时无法显示，点击后可另存为或用系统程序打开。"; button.replaceChildren(state); } });
        button.replaceChildren(image);
      } catch { if (active) state.textContent = "正文图片暂时无法显示，点击后可另存为或用系统程序打开。"; }
    });
    return figure;
  });
  container.replaceChildren(...nodes);
  // Read sequentially so a message with many inline images does not fan out archive workers.
  void (async () => { for (const task of tasks) { if (!active) break; await task(); } })();
  return () => { active = false; };
}
