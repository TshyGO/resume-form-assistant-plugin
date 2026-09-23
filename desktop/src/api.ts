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

export type TodoStatus = "open" | "done" | "cancelled";

/** `datetime` / `date` / `none`。`date` 是**只有日历日**，没有时刻。 */
export type DuePrecision = "datetime" | "date" | "none";

/** 一条待办的提醒现在处于什么状态（D10）。这是本机投递状态，不是申请历史。 */
export type ReminderState = "none" | "scheduled" | "fired" | "missed" | "unsupported";

export interface TodoView {
  id: string;
  applicationId: string;
  title: string;
  duePrecision: DuePrecision;
  dueAtUtc?: string | null;
  dueDate?: string | null;
  timeZone?: string | null;
  remindAtUtc?: string | null;
  status: TodoStatus;
  interviewRound?: number | null;
  sourceEventId?: string | null;
  reminderState: ReminderState;
  reminderScheduledForUtc?: string | null;
  company?: string | null;
  position?: string | null;
}

/** 提醒在这台机器上现在能不能响。不能的话 `reason` 是给用户看的一句话。 */
export interface ReminderCapability {
  available: boolean;
  reason?: string | null;
}

/**
 * 一次写操作的结果。
 *
 * `todo` 和 `reminderProblem` 分开是有意的：保存成功、提醒失败是完全可能的，
 * 界面要能同时说出这两件事。
 */
export interface TodoWriteResult {
  todo: TodoView;
  reminderProblem?: string | null;
}

export interface OverdueDigest {
  todos: TodoView[];
  more: number;
}

/** 各类记录的条数。备份清单与恢复预览都用它。 */
export interface ArchiveCounts {
  applications: number;
  events: number;
  snapshots: number;
  todos: number;
  evidence: number;
  attachments: number;
}

export interface ExportReport {
  path: string;
  sizeBytes: number;
  /** 档案目录里没进包的东西，含「清单没覆盖」的那些。 */
  skipped: string[];
}

export interface RestorePreview {
  createdAt: string;
  archiveId: string;
  schemaVersion: number;
  incoming: ArchiveCounts;
  current: ArchiveCounts;
  existingRollbackPoints: number;
  tooManyRollbackPoints: boolean;
  /** 备份是不是这台机器上这份档案的历史版本。不是的话用户可能拿错了文件。 */
  sameArchive: boolean;
}

export interface RestoreReport {
  archiveDir: string;
  restoreEpoch: string;
  rollbackPoint: string;
  /** 清掉了多少条待办的提醒记账；它们需要重新登记。 */
  remindersCleared: number;
  counts: ArchiveCounts;
}

export interface RollbackPoint {
  id: string;
  retiredAt: string;
}

export interface PurgePreview {
  applicationId: string;
  company: string;
  title: string;
  events: number;
  todos: number;
  evidence: number;
  snapshots: number;
}

export interface PurgeResult {
  applicationId: string;
  eventsRemoved: number;
  todosRemoved: number;
  evidenceRemoved: number;
  snapshotsRemoved: number;
  attachmentFilesRemoved: number;
  attachmentFilesLeft: string[];
}

export interface OrphanReport {
  totalBlobs: number;
  totalEvidence: number;
  zeroRefBlobs: string[];
  danglingEvidence: string[];
  invalidFiles: string[];
}

export interface ApplicationView {
  application: ApplicationSummary & { summary?: ApplicationSummary; notes?: string | null };
  events: StoredEvent[];
  snapshots: SnapshotSummary[];
  snapshotStates: Record<string, "stored" | "uploading" | "missing">;
  evidence: EvidenceSummary[];
  todos: TodoView[];
}

/** 一份已保存的桌面 AI 配置。没有 Key 原文。 */
export interface AiProfileView {
  id: string;
  name: string;
  apiUrl: string;
  model: string;
  /** 这一份自己的 Key 配没配。 */
  keyConfigured: boolean;
}

/** 设置页显示的 AI 配置。字段由 `get_ai_settings_cmd` 给出，不含任何 Key。 */
export interface AiSettingsView {
  activeId: string | null;
  profiles: AiProfileView[];
  /** 当前配置的地址。没有当前配置时为空，不会拿另一份来充数。 */
  apiUrl: string;
  model: string;
  /** 只有主机名，不含完整地址。 */
  host: string;
  /** 当前这一份的 Key 配没配。**Key 本身永远不会回到前端。** */
  keyConfigured: boolean;
  /** 凭据库读不出来时的原因；正常是 null。 */
  credentialError: string | null;
}

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
  /** 这次启动升级过数据库的话，迁移前那份自动备份在哪。 */
  migrationBackup?: string | null;
  /** 读不到档案状态时为真，界面不能把它说成「没有升级」。 */
  migrationBackupUnknown?: boolean;
  /** 每个浏览器注册成了没有。没成时 `note` 说清楚为什么。 */
  nativeMessaging?: Array<{
    browser: "chrome" | "edge";
    label: string;
    registered: boolean;
    note?: string | null;
  }>;
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

// --- D11 AI 整理 -------------------------------------------------------------------------

/** 发送前预览：这一次要把什么发出去。不含 Key，不含申请 id，不含完整接口地址。 */
export interface OutboundPreview {
  host: string;
  model: string;
  bodyChars: number;
  truncated: boolean;
  hasSubject: boolean;
  hasFrom: boolean;
  candidates: Array<{ label: string; company: string; title: string; stage: string }>;
  bodyPreview: string;
  summary: string;
  /** 等这么久之后界面说「还在等」，再等这么久就算超时。 */
  slowHintSeconds: number;
  timeoutSeconds: number;
  /** 一次最多送几条候选。界面照这个数拦，不另抄一份常量。 */
  maxCandidates: number;
}

export type SuggestionStatus =
  | "pending"
  | "confirmed"
  | "modified_confirmed"
  | "rejected"
  | "deferred";

export interface SuggestedTodoView {
  title: string;
  duePrecision: "datetime" | "date" | "none";
  dueAtUtc?: string | null;
  dueDate?: string | null;
  timeZone?: string | null;
  interviewRound?: number | null;
}

export interface SuggestionCandidate {
  id: string;
  company: string;
  title: string;
  stage: string;
  /** 这条申请已经不在了。界面不许默认选中它，也不许选它。 */
  missing?: boolean;
  /** 这一次没读出来，但它多半还在。不预选，但可以选。 */
  unreadable?: boolean;
}

/** 一条待确认的建议。**全部是建议值**：确认之前，正式字段一个都没改。 */
export interface AiSuggestion {
  id: string;
  evidenceId: string;
  status: SuggestionStatus;
  candidates: SuggestionCandidate[];
  stage?: Stage | null;
  round?: number | null;
  replyClass: ReplyClass;
  sendMode: SendMode;
  todos: SuggestedTodoView[];
  excerpts: string[];
  uncertainties: string[];
  modelLabel?: string | null;
  promptScope?: string | null;
  createdAt: string;
  approvedReplyClass?: ReplyClass | null;
  approvedSendMode?: SendMode | null;
  approvedStage?: Stage | null;
}

export interface ConfirmResult {
  suggestion: AiSuggestion;
  /** 重复确认同一个决定：这次什么都没再写。 */
  alreadyConfirmed: boolean;
  events: unknown[];
  todos: TodoView[];
  /** 提醒没登记上的原因。确认本身已经成了。 */
  reminderProblems: string[];
}
