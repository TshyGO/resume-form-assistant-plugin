// 桌面前端与 Rust 命令层之间的形状。
//
// 这些接口现在是手写的，**下一步会由 Rust 的结构体生成**（ts-rs），这样字段改名时前端
// 立刻红，而不是像以前那样在界面里写 `app.replyEvidenceState || app.reply_evidence_state`
// 两种命名都试一遍。在那之前，这个文件是唯一一处描述边界的地方。

export type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface CommandError {
  code: string;
  message: string;
}

export type Stage =
  | "saved"
  | "filling"
  | "submitted"
  | "assessment"
  | "interview"
  | "offer"
  | "rejected"
  | "withdrawn"
  | "closed";

export type ReplyEvidenceState =
  | "none_imported"
  | "imported_unclassified"
  | "auto_ack"
  | "classified"
  | "mixed";

export type ReplyClass =
  | "auto_ack"
  | "assessment_invite"
  | "interview_invite"
  | "action_required"
  | "offer"
  | "reject"
  | "other"
  | "unknown";

export type SendMode = "human" | "automated" | "unknown";

export type EvidenceKind = "eml" | "screenshot" | "pdf" | "paste" | "unknown";

/** 列表里的一行。命令层给的是 snake_case，两种命名都在这里声明，界面只读其中一种。 */
export interface ApplicationSummary {
  id: string;
  company: string;
  title: string;
  location?: string | null;
  current_stage?: Stage;
  currentStage?: Stage;
  reply_evidence_state?: ReplyEvidenceState;
  replyEvidenceState?: ReplyEvidenceState;
  recycle_state?: string;
  recycleState?: string;
  updated_at?: string;
  updatedAt?: string;
  source_url?: string | null;
  sourceUrl?: string | null;
  notes?: string | null;
}

export interface Page<T> {
  total: number;
  items: T[];
}

export interface Occurred {
  precision?: "date" | "date_time" | "unknown";
  value?: { date?: string; rfc3339?: string };
}

export interface StoredEvent {
  id: string;
  event_type: string;
  event_sequence: number;
  occurred?: Occurred;
  recorded_at?: string;
  payload?: Record<string, unknown> & { kind?: string };
}

export interface SnapshotSummary {
  snapshot_id: string;
  template_name: string;
  template_version?: string | null;
  created_at: string;
  byte_size: number;
}

export interface SnapshotView {
  snapshotId: string;
  templateName: string;
  templateVersion?: string | null;
  createdAt: string;
  capturedAt?: string | null;
  omittedFieldCount: number;
  groups: Array<{ name: string; fields: Array<{ key: string; value: string }> }>;
}

export interface EvidenceSummary {
  id: string;
  applicationId: string | null;
  kind: EvidenceKind;
  mime: string | null;
  sizeBytes: number;
  originalFilename: string | null;
  importedAt: string;
  subject: string | null;
  fromAddr: string | null;
  sentAt: string | null;
  replyClass: ReplyClass | null;
  sendMode: SendMode | null;
  sameBytesAs: string[];
}

export interface EvidencePreview extends EvidenceSummary {
  bodyExtract: string | null;
  imageDataUrl: string | null;
  note: string | null;
}

export interface ImportReport {
  imported: EvidenceSummary[];
  duplicates: EvidenceSummary[];
  failed: Array<{ name: string; code: string }>;
}

export interface ApplicationView {
  application: ApplicationSummary & { summary?: ApplicationSummary; notes?: string | null };
  events: StoredEvent[];
  snapshots: SnapshotSummary[];
  snapshotStates: Record<string, "stored" | "uploading" | "missing">;
  evidence: EvidenceSummary[];
}

/** 设置页显示的宿主状态。字段由 `get_runtime_status` 命令给出。 */
export interface RuntimeStatus {
  runtimeLabel: string;
  appVersion: string;
  identifier: string;
  programDir: string;
  dataRoot: string;
  archiveDir: string;
  logsDir: string;
  logFile: string;
  cacheDir: string;
  webviewDataDir?: string | null;
  webviewDataManaged: boolean;
  webviewDataNote: string;
  currentPointer: string;
  writable: boolean;
  uniqueWriter: boolean;
  windowVisible: boolean;
  hiddenLaunch: boolean;
  autostartEnabled: boolean;
  nativeMessagingRegistered: boolean;
  remindersImplemented: boolean;
  closeWindowMeans: string;
  quitMeans: string;
  error?: { code: string; message: string; hint: string } | null;
  pairing?: { chromeExtensionId?: string | null; edgeExtensionId?: string | null } | null;
}

/** `create_application_cmd` 的结果：要么建好了，要么给出可能重复的候选让用户自己决定。 */
export interface CreateApplicationResult {
  created: boolean;
  application?: ApplicationSummary | null;
  candidates?: {
    exact?: ApplicationSummary[];
    sameCompany?: ApplicationSummary[];
    same_company?: ApplicationSummary[];
  } | null;
}
