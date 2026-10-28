import type { Invoke } from "./api.ts";
import type { MailAttachment, MailAttachments } from "./attachment-types.ts";
const errorText = (err: unknown) => typeof err === "string" ? err : (err as { message?: string })?.message || "读取失败，请重试。";
const kindName = (a: MailAttachment) => a.previewKind === "pdf" ? "PDF" : a.previewKind === "image" ? "图片" : a.name.includes(".") ? a.name.split(".").pop()!.toUpperCase() : "文件";
const attachmentSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`;
/** Same compact entry rows in inbox and application details. Metadata only; bytes load on click. */
export function mountAttachmentList(container: HTMLElement, invoke: Invoke, evidenceId: string, title: string) {
  let active = true;
  const heading = document.createElement("h3"); heading.textContent = "附件";
  const state = document.createElement("p"); state.className = "muted"; state.textContent = "正在读取附件列表…";
  container.classList.add("mail-attachment-section"); container.replaceChildren(heading, state);
  const load = async () => {
    try {
      const data = await invoke<MailAttachments>("list_evidence_attachments_cmd", { evidenceId });
      if (!active || !container.isConnected) return;
      heading.textContent = `附件 · ${data.items.length}`;
      state.textContent = data.items.length ? "点击附件查看或另存为" : "这封邮件没有文件附件。";
      container.replaceChildren(heading, state);
      for (const a of data.items) {
        const button = document.createElement("button"); button.type = "button"; button.className = "mail-attachment-row";
        const label = document.createElement("span"); label.className = "mail-attachment-label";
        const name = document.createElement("strong"); name.textContent = a.name;
        const detail = document.createElement("small"); detail.textContent = `${kindName(a)} · ${attachmentSize(a.sizeBytes)}`;
        label.append(name,detail);
        const arrow = document.createElement("span"); arrow.textContent = "查看 ›"; arrow.setAttribute("aria-hidden","true");
        button.append(label,arrow); button.addEventListener("click", () => {
          // WKWebView does not focus buttons on a mouse click by default. Remember
          // this exact trigger so closing the dialog restores keyboard navigation.
          button.focus();
          void import("./attachment-viewer.tsx").then(({ openAttachmentViewer }) => {
            if (active && container.isConnected && button.isConnected) openAttachmentViewer(invoke,evidenceId,title,data,a.index);
          }).catch(() => { if (active && container.isConnected) state.textContent = "附件窗口暂时无法打开，请重新点击附件。"; });
        });
        container.append(button);
      }
    } catch (err) {
      if (!active || !container.isConnected) return;
      state.textContent = `附件列表读不出来：${errorText(err)}`;
      const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重新读取附件";
      retry.addEventListener("click", () => { retry.remove(); void load(); }); container.append(retry);
    }
  };
  void load();
  return () => { active = false; };
}
