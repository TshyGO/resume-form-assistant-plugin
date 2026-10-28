export interface MailAttachment {
  index: number; name: string; mime: string; sizeBytes: number;
  previewKind: "pdf" | "image" | "xlsx" | "file"; readable: boolean; canOpen: boolean;
}
export type MailBodyBlock = { kind: "text"; text: string } | { kind: "image"; attachment: MailAttachment };
export interface MailAttachments { sourceSha256: string; items: MailAttachment[]; bodyBlocks?: MailBodyBlock[]; contentKind?: "bodyImage" }
export interface SpreadsheetPreview {
  sheetNames: string[]; sheetIndex: number; cells: [number, number, string][];
  rowCount: number; columnCount: number; truncated: boolean;
}
