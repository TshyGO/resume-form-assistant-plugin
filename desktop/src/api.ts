// 桌面前端与 Rust 命令层之间的形状。
//
// 这些接口是手写的，但**不是没人看着**：`desktop/src-tauri/src/commands_regression.rs` 里的
// `the_json_keys_the_desktop_frontend_reads_are_pinned` 会把前端真正读的那些键逐个断言，
// 谁改了字段名或 `rename_all`，那条 Rust 测试先红。
//
// 更彻底的做法是用 ts-rs 从 Rust 结构体生成这个文件（archive-store 的模型也要跟着加 derive，
// 包括 `#[serde(flatten)]` 与那个大 EventPayload 枚举）——留作后续。

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

/**
 * 列表与详情里的一条申请。
 *
 * **键名就是命令层真正发出来的那些**：archive-store 的模型走 snake_case，D08/D09 的命令层
 * 结构体标了 `rename_all = "camelCase"`。两边都由 `commands_regression.rs` 的
 * `the_json_keys_the_desktop_frontend_reads_are_pinned` 钉死——改名会先让那条 Rust 测试红。
 */
export interface ApplicationSummary {
  id: string;
  company: string;
  title: string;
  location?: string | null;
  current_stage?: Stage;
  reply_evidence_state?: ReplyEvidenceState;
  recycle_state?: string;
  updated_at?: string;
  source_url?: string | null;
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
