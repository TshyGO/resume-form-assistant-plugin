import { afterEach, expect, test, vi } from "vitest";
import { within, waitFor } from "@testing-library/react";
import type { Invoke } from "./api.ts";
import type { MailAttachments } from "./attachment-types.ts";
import { mountAttachmentList } from "./attachment-list.ts";
const image = { index: 0, name: "正文照片.jpg", mime: "image/jpeg", sizeBytes: 100, previewKind: "image" as const, readable: true, canOpen: true };
const metadata: MailAttachments = { sourceSha256: "source", items: [{ ...image, index: 1, name: "独立照片.jpg" }], bodyBlocks: [
  { kind: "text", text: "照片之前<script>literal</script>" }, { kind: "image", attachment: image }, { kind: "text", text: "照片之后" },
] };
afterEach(() => { document.body.innerHTML = ""; });
function roots() {
  const attachments = document.createElement("div"); const body = document.createElement("div");
  body.textContent = "原有文本"; document.body.append(attachments, body);
  return { attachments, body };
}
test("CID images render in text order while actual image attachments retain separate rows", async () => {
  const { attachments, body } = roots();
  const invoke = vi.fn(async (name: string) => name === "list_evidence_attachments_cmd" ? metadata : { mime: "image/jpeg", bytesBase64: "image" });
  const dispose = mountAttachmentList(attachments, invoke as Invoke, "mail", "Test", body);
  await within(body).findByRole("img", { name: "正文照片.jpg" });
  expect([...body.children].map(n => n.tagName)).toEqual(["PRE", "FIGURE", "PRE"]);
  expect(body.firstElementChild?.textContent).toContain("<script>literal</script>");
  expect(body.querySelector("script")).toBeNull();
  expect(body.lastElementChild?.textContent).toBe("照片之后");
  expect(attachments.textContent).toContain("附件 · 1");
  expect(attachments.textContent).toContain("独立照片.jpg");
  expect(attachments.textContent).not.toContain("正文照片.jpg");
  expect(invoke).toHaveBeenCalledWith("preview_evidence_attachment_cmd", { evidenceId: "mail", index: 0, sourceSha256: "source" });
  dispose();
});
test("late body-image responses cannot modify a closed mail and remote/active image types never render", async () => {
  const { attachments, body } = roots();
  let release!: (value: unknown) => void;
  const invoke = vi.fn(async (name: string) => name === "list_evidence_attachments_cmd" ? metadata : new Promise(resolve => { release = resolve; }));
  const dispose = mountAttachmentList(attachments, invoke as Invoke, "mail", "Test", body);
  await within(body).findByRole("button", { name: /放大查看正文图片/ });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  dispose(); body.replaceChildren();
  release({ mime: "image/jpeg", bytesBase64: "image" });
  await waitFor(() => expect(body.children).toHaveLength(0));
  const dispose2 = mountAttachmentList(attachments, (async (name: string) => name === "list_evidence_attachments_cmd" ? metadata : { mime: "image/svg+xml", bytesBase64: "active" }) as Invoke, "mail", "Test", body);
  await within(body).findByText(/正文图片暂时无法显示/);
  expect(body.querySelector("img")).toBeNull(); dispose2();
});
test("mail without local body images keeps the existing text preview", async () => {
  const { attachments, body } = roots();
  const dispose = mountAttachmentList(attachments, (async () => ({ sourceSha256: "source", items: [], bodyBlocks: [] })) as Invoke, "mail", "Test", body);
  await within(attachments).findByText("这封邮件没有文件附件。");
  expect(body.textContent).toBe("原有文本"); dispose();
});
