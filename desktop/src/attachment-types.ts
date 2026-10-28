export interface MailAttachment {
  index: number; name: string; mime: string; sizeBytes: number;
  previewKind: "pdf" | "image" | "file"; readable: boolean; canOpen: boolean;
}
export interface MailAttachments { sourceSha256: string; items: MailAttachment[] }
