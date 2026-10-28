import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { AttachmentViewer } from "./attachment-viewer.tsx";
import { mountAttachmentList } from "./attachment-list.ts";
import { InvokeProvider } from "./react/invoke.tsx";
import type { Invoke } from "./api.ts";
import type { MailAttachments } from "./attachment-types.ts";
const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), getPage: vi.fn(), render: vi.fn(), destroy: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/worker.js" }));
const attachments: MailAttachments = { sourceSha256: "source", items: [
  { index: 0, name: "简历.pdf", mime: "application/pdf", sizeBytes: 380268, previewKind: "pdf", readable: true, canOpen: true },
  { index: 1, name: "面试安排.png", mime: "image/png", sizeBytes: 1000, previewKind: "image", readable: true, canOpen: true },
  { index: 2, name: "补充资料.docx", mime: "application/octet-stream", sizeBytes: 4200, previewKind: "file", readable: true, canOpen: true },
] };
beforeEach(() => {
  pdf.render.mockReset().mockImplementation(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  pdf.destroy.mockReset().mockResolvedValue(undefined);
  pdf.getPage.mockReset().mockResolvedValue({ getViewport: ({ scale }: { scale: number }) => ({ width: 500 * scale, height: 700 * scale }), render: pdf.render });
  pdf.getDocument.mockReset().mockImplementation(() => ({ promise: Promise.resolve({ numPages: 2, getPage: pdf.getPage }), destroy: pdf.destroy }));
});
afterEach(() => { cleanup(); document.body.innerHTML = ""; });
function show(index = 0, custom?: Invoke) {
  const close = vi.fn();
  const invoke = vi.fn(custom ?? (async <T,>(command: string) => (command === "preview_evidence_attachment_cmd" ? { bytesBase64: btoa("%PDF synthetic"), mime: index === 1 ? "image/png" : "application/pdf" } : true) as T));
  render(<InvokeProvider invoke={invoke as Invoke}><AttachmentViewer evidenceId="mail" title="测试面试邀请" attachments={attachments} initialIndex={index} onClose={close} /></InvokeProvider>);
  return { invoke, close };
}
test("PDF preview keeps file operations visible and page/zoom controls actually render the chosen page", async () => {
  const { invoke } = show();
  await screen.findByLabelText("简历.pdf，第 1 页");
  await waitFor(() => expect(pdf.render).toHaveBeenCalled());
  expect(screen.getByRole("button", { name: "上一页" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(pdf.getPage).toHaveBeenLastCalledWith(2));
  expect(screen.getByRole("button", { name: "下一页" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "放大" }));
  expect(screen.getByText("125%")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "适合宽度" }));
  await waitFor(() => expect(screen.queryByText("正在显示页面…")).toBeNull());
  expect(invoke).toHaveBeenCalledWith("preview_evidence_attachment_cmd", { evidenceId: "mail", index: 0, sourceSha256: "source" });
  expect(screen.getByRole("button", { name: "另存为" })).toBeTruthy();
});
test("non-previewable attachments have native open and save actions without trying to render them", () => {
  const { invoke } = show(2);
  expect(screen.getByText("这种文件可另存为，或用电脑上的对应软件打开。")).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
});
test("images preview from local bytes and selecting another attachment clears the old preview", async () => {
  const { invoke } = show(1);
  expect((await screen.findByRole("img", { name: "面试安排.png" })).getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  fireEvent.click(screen.getByRole("button", { name: /补充资料.docx/ }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});
test("a late preview reply cannot replace the attachment the user switched to", async () => {
  let release: (value: unknown) => void = () => {};
  show(0, (async () => new Promise<unknown>(resolve => { release = resolve; })) as Invoke);
  fireEvent.click(screen.getByRole("button", { name: /补充资料.docx/ }));
  await act(async () => release({ bytesBase64: btoa("%PDF old"), mime: "application/pdf" }));
  expect(pdf.getDocument).not.toHaveBeenCalled();
  expect(screen.getByText("这种文件可另存为，或用电脑上的对应软件打开。")).toBeTruthy();
});
test("cancelled save reports cancellation and a failed native open leaves a useful retryable viewer", async () => {
  const { close, invoke } = show(2, (async (command: string) => {
    if (command === "save_evidence_attachment_cmd") return false;
    throw { message: "没有对应的软件" };
  }) as Invoke);
  fireEvent.click(screen.getByRole("button", { name: "另存为" }));
  await screen.findByText("已取消另存为。");
  fireEvent.click(screen.getByRole("button", { name: "用系统程序打开" }));
  await screen.findByText("没有对应的软件");
  expect(close).not.toHaveBeenCalled(); expect(invoke).toHaveBeenLastCalledWith("open_evidence_attachment_cmd", { evidenceId: "mail", index: 2, sourceSha256: "source" });
});
test("native file operation prevents double clicks, attachment switches and escape until it finishes", async () => {
  let release: (value: unknown) => void = () => {};
  const { close, invoke } = show(2, (async () => new Promise<unknown>(resolve => { release = resolve; })) as Invoke);
  fireEvent.click(screen.getByRole("button", { name: "另存为" }));
  fireEvent.click(screen.getByRole("button", { name: "正在保存…" }));
  expect(screen.getByRole("button", { name: /简历.pdf/ }).hasAttribute("disabled")).toBe(true);
  fireEvent.keyDown(document.querySelector("dialog")!, { key: "Escape" });
  expect(close).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => release(true));
  await screen.findByText("附件已另存为。");
  fireEvent.keyDown(document.querySelector("dialog")!, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
});
test("unreadable attachment has an explicit state and cannot invoke file actions", () => {
  const broken = { ...attachments, items: [{ ...attachments.items[0], readable: false }] };
  const invoke = vi.fn(); render(<InvokeProvider invoke={invoke}><AttachmentViewer evidenceId="mail" title="Test" attachments={broken} initialIndex={0} onClose={() => {}} /></InvokeProvider>);
  expect(screen.getByRole("alert").textContent).toContain("编码已损坏");
  expect(screen.getByRole("button", { name: "另存为" }).hasAttribute("disabled")).toBe(true);expect(invoke).not.toHaveBeenCalled();
});
test("attachment entry rows are text-safe and metadata does not download PDF bytes before click", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const invoke = vi.fn(async () => ({ ...attachments, items: [{ ...attachments.items[2], name: '<img src=x onerror=alert(1)>.docx' }] })) as unknown as Invoke;
  const dispose = mountAttachmentList(root,invoke,"mail","Test");
  await within(root).findByRole("button", { name: /<img src=x/ });
  expect(root.querySelector("img")).toBeNull(); expect(invoke).toHaveBeenCalledTimes(1);
  dispose();
});
test("closing the attachment dialog returns focus to the exact entry button", async () => {
  const root = document.createElement("div"); document.body.append(root);
  const invoke = vi.fn(async (name: string) => name === "list_evidence_attachments_cmd" ? { ...attachments, items: [attachments.items[2]] } : true) as unknown as Invoke;
  const dispose = mountAttachmentList(root,invoke,"mail","Test");
  const entry = await within(root).findByRole("button", { name: /补充资料.docx/ });
  fireEvent.click(entry);
  const close = await screen.findByRole("button", { name: /^关闭$/ });
  fireEvent.click(close);
  await waitFor(() => expect(document.querySelector("dialog")).toBeNull());
  expect(document.activeElement).toBe(entry); dispose();
});
