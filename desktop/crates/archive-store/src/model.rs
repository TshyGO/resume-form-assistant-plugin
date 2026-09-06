//! 逻辑对象与字段目录的 Rust 类型(产品需求 §8)。
//! 敏感纪律:本 crate 不新增任何 secret 字段;payload 序列化不含 Key/密码/快照字节。

pub use crate::stage::{Fold, Stage, StageUpdateMode};
pub use crate::timeutil::Occurred;

use serde::{Deserialize, Serialize};

pub const PAYLOAD_VERSION_V1: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventSource {
    Manual,
    Plugin,
    Import,
    AiConfirmed,
}

impl EventSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventSource::Manual => "manual",
            EventSource::Plugin => "plugin",
            EventSource::Import => "import",
            EventSource::AiConfirmed => "ai_confirmed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "manual" => EventSource::Manual,
            "plugin" => EventSource::Plugin,
            "import" => EventSource::Import,
            "ai_confirmed" => EventSource::AiConfirmed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    User,
    Plugin,
    System,
}

impl Actor {
    pub fn as_str(&self) -> &'static str {
        match self {
            Actor::User => "user",
            Actor::Plugin => "plugin",
            Actor::System => "system",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "user" => Actor::User,
            "plugin" => Actor::Plugin,
            "system" => Actor::System,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationOrigin {
    Manual,
    Plugin,
}

impl ApplicationOrigin {
    pub fn as_str(&self) -> &'static str {
        match self {
            ApplicationOrigin::Manual => "manual",
            ApplicationOrigin::Plugin => "plugin",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "manual" => ApplicationOrigin::Manual,
            "plugin" => ApplicationOrigin::Plugin,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecycleState {
    Active,
    Recycled,
    Purged,
}

impl RecycleState {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecycleState::Active => "active",
            RecycleState::Recycled => "recycled",
            RecycleState::Purged => "purged",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "active" => RecycleState::Active,
            "recycled" => RecycleState::Recycled,
            "purged" => RecycleState::Purged,
            _ => return None,
        })
    }
}

/// 回复证据状态投影(§6.3):由关联证据存在性与已确认分类投影。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyEvidenceState {
    NoneImported,
    ImportedUnclassified,
    AutoAck,
    Classified,
    Mixed,
}

impl ReplyEvidenceState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReplyEvidenceState::NoneImported => "none_imported",
            ReplyEvidenceState::ImportedUnclassified => "imported_unclassified",
            ReplyEvidenceState::AutoAck => "auto_ack",
            ReplyEvidenceState::Classified => "classified",
            ReplyEvidenceState::Mixed => "mixed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "none_imported" => ReplyEvidenceState::NoneImported,
            "imported_unclassified" => ReplyEvidenceState::ImportedUnclassified,
            "auto_ack" => ReplyEvidenceState::AutoAck,
            "classified" => ReplyEvidenceState::Classified,
            "mixed" => ReplyEvidenceState::Mixed,
            _ => return None,
        })
    }
}

/// 通知业务类型(replyClass ≠ sendMode,§6.3)。
pub const REPLY_CLASSES: &[ReplyClass] = &[
    ReplyClass::AutoAck,
    ReplyClass::AssessmentInvite,
    ReplyClass::InterviewInvite,
    ReplyClass::ActionRequired,
    ReplyClass::Offer,
    ReplyClass::Reject,
    ReplyClass::Other,
    ReplyClass::Unknown,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyClass {
    AutoAck,
    AssessmentInvite,
    InterviewInvite,
    ActionRequired,
    Offer,
    Reject,
    Other,
    Unknown,
}

impl ReplyClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            ReplyClass::AutoAck => "auto_ack",
            ReplyClass::AssessmentInvite => "assessment_invite",
            ReplyClass::InterviewInvite => "interview_invite",
            ReplyClass::ActionRequired => "action_required",
            ReplyClass::Offer => "offer",
            ReplyClass::Reject => "reject",
            ReplyClass::Other => "other",
            ReplyClass::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        REPLY_CLASSES.iter().copied().find(|c| c.as_str() == s)
    }
}

/// 发送方式:无法判断必须 unknown,禁止因 replyClass 捏造 human。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendMode {
    Human,
    Automated,
    Unknown,
}

impl SendMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SendMode::Human => "human",
            SendMode::Automated => "automated",
            SendMode::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "human" => SendMode::Human,
            "automated" => SendMode::Automated,
            "unknown" => SendMode::Unknown,
            _ => return None,
        })
    }
}

/// 证据获取/格式 kind。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    Eml,
    Screenshot,
    Pdf,
    Paste,
    Unknown,
}

impl EvidenceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EvidenceKind::Eml => "eml",
            EvidenceKind::Screenshot => "screenshot",
            EvidenceKind::Pdf => "pdf",
            EvidenceKind::Paste => "paste",
            EvidenceKind::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "eml" => EvidenceKind::Eml,
            "screenshot" => EvidenceKind::Screenshot,
            "pdf" => EvidenceKind::Pdf,
            "paste" => EvidenceKind::Paste,
            "unknown" => EvidenceKind::Unknown,
            _ => return None,
        })
    }
}

/// 待办状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Open,
    Done,
    Cancelled,
}

impl TodoStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TodoStatus::Open => "open",
            TodoStatus::Done => "done",
            TodoStatus::Cancelled => "cancelled",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "open" => TodoStatus::Open,
            "done" => TodoStatus::Done,
            "cancelled" => TodoStatus::Cancelled,
            _ => return None,
        })
    }
}

/// 待办到期精度(§8.6):datetime / date / none 三态分列存储。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DuePrecision {
    DateTime,
    Date,
    None,
}

impl DuePrecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            DuePrecision::DateTime => "datetime",
            DuePrecision::Date => "date",
            DuePrecision::None => "none",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "datetime" => DuePrecision::DateTime,
            "date" => DuePrecision::Date,
            "none" => DuePrecision::None,
            _ => return None,
        })
    }
}

/// 事件载荷(v1)。折叠语义见 [crate::stage::fold_stage]。
/// `stage_update_mode` 出现在阶段相关载荷上并随事件持久化。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventPayload {
    ApplicationCreated {
        company: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        location: Option<String>,
        origin: ApplicationOrigin,
    },
    ApplicationUpdated {
        changes: Vec<FieldChange>,
    },
    JobSaved {
        company: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        location: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dedupe_url: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    FillEvent {
        outcome: FillOutcome,
        #[serde(default)]
        field_count: Option<i64>,
        #[serde(default)]
        filled_count: Option<i64>,
        #[serde(default)]
        unconfirmed_count: Option<i64>,
        #[serde(default)]
        durations_ms: Option<serde_json::Value>,
        /// 脱敏后的 URL。
        #[serde(skip_serializing_if = "Option::is_none")]
        url_redacted: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        template_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        template_version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        plugin_version: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    SubmitConfirmed {
        /// `desktop`(D04)或 `plugin`(D07 submit.confirm)。
        via: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    StageCorrected {
        from: Stage,
        to: Stage,
        reason: String,
        actor: Actor,
    },
    AssessmentRecorded {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        due: Option<Occurred>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    InterviewRecorded {
        #[serde(skip_serializing_if = "Option::is_none")]
        round: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    InterviewRescheduled {
        #[serde(skip_serializing_if = "Option::is_none")]
        round: Option<i64>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    OfferRecorded {
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    Rejected {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    Withdrawn {
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    Closed {
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
    EvidenceImported {
        evidence_id: String,
    },
    EvidenceAssociated {
        evidence_id: String,
        application_id: String,
    },
    AssociationChanged {
        evidence_id: String,
        from_application_id: Option<String>,
        to_application_id: String,
    },
    EvidenceClassified {
        evidence_id: String,
        reply_class: String,
        send_mode: String,
    },
    NoteAdded {
        text: String,
    },
    TodoCreated {
        todo_id: String,
        title: String,
    },
    TodoCompleted {
        todo_id: String,
    },
    TodoCancelled {
        todo_id: String,
    },
    /// D03 允许下游增补事件类型;默认不参与阶段折叠。
    /// `event_type` 为稳定 code;payload 为结构化 JSON。
    Custom {
        event_type: String,
        data: serde_json::Value,
        #[serde(default)]
        stage_update_mode: StageUpdateMode,
    },
}

impl EventPayload {
    /// 事件的稳定 eventType code。
    pub fn event_type(&self) -> String {
        match self {
            EventPayload::ApplicationCreated { .. } => "application_created".into(),
            EventPayload::ApplicationUpdated { .. } => "application_updated".into(),
            EventPayload::JobSaved { .. } => "job_saved".into(),
            EventPayload::FillEvent { outcome, .. } => outcome.event_type().into(),
            EventPayload::SubmitConfirmed { .. } => "submit_confirmed".into(),
            EventPayload::StageCorrected { .. } => "stage_corrected".into(),
            EventPayload::AssessmentRecorded { .. } => "assessment_recorded".into(),
            EventPayload::InterviewRecorded { .. } => "interview_recorded".into(),
            EventPayload::InterviewRescheduled { .. } => "interview_rescheduled".into(),
            EventPayload::OfferRecorded { .. } => "offer_recorded".into(),
            EventPayload::Rejected { .. } => "rejected".into(),
            EventPayload::Withdrawn { .. } => "withdrawn".into(),
            EventPayload::Closed { .. } => "closed".into(),
            EventPayload::EvidenceImported { .. } => "evidence_imported".into(),
            EventPayload::EvidenceAssociated { .. } => "evidence_associated".into(),
            EventPayload::AssociationChanged { .. } => "association_changed".into(),
            EventPayload::EvidenceClassified { .. } => "evidence_classified".into(),
            EventPayload::NoteAdded { .. } => "note_added".into(),
            EventPayload::TodoCreated { .. } => "todo_created".into(),
            EventPayload::TodoCompleted { .. } => "todo_completed".into(),
            EventPayload::TodoCancelled { .. } => "todo_cancelled".into(),
            EventPayload::Custom { event_type, .. } => event_type.clone(),
        }
    }

    /// 阶段相关事件的 stageUpdateMode(§6.2);无关事件为 None。
    pub fn stage_update_mode(&self) -> Option<StageUpdateMode> {
        match self {
            EventPayload::JobSaved {
                stage_update_mode, ..
            }
            | EventPayload::FillEvent {
                stage_update_mode, ..
            }
            | EventPayload::SubmitConfirmed {
                stage_update_mode, ..
            }
            | EventPayload::AssessmentRecorded {
                stage_update_mode, ..
            }
            | EventPayload::InterviewRecorded {
                stage_update_mode, ..
            }
            | EventPayload::InterviewRescheduled {
                stage_update_mode, ..
            }
            | EventPayload::OfferRecorded {
                stage_update_mode, ..
            }
            | EventPayload::Rejected {
                stage_update_mode, ..
            }
            | EventPayload::Withdrawn {
                stage_update_mode, ..
            }
            | EventPayload::Closed {
                stage_update_mode, ..
            }
            | EventPayload::Custom {
                stage_update_mode, ..
            } => Some(*stage_update_mode),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillOutcome {
    Started,
    Completed,
    Partial,
    Failed,
    Cancelled,
}

impl FillOutcome {
    pub fn event_type(&self) -> &'static str {
        match self {
            FillOutcome::Started => "fill_started",
            FillOutcome::Completed => "fill_completed",
            FillOutcome::Partial => "fill_partial",
            FillOutcome::Failed => "fill_failed",
            FillOutcome::Cancelled => "fill_cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldChange {
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

/// 新建申请输入。同公司/同 URL 不设唯一约束——重复申请并存。
#[derive(Debug, Clone)]
pub struct NewApplication {
    pub company: String,
    pub title: String,
    pub source_url: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub origin: ApplicationOrigin,
    /// application_created 事件的发生时间(通常与创建同时刻)。
    pub occurred_at: Occurred,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationSummary {
    pub id: String,
    pub company: String,
    pub title: String,
    pub source_url: Option<String>,
    pub location: Option<String>,
    pub current_stage: Stage,
    pub reply_evidence_state: ReplyEvidenceState,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub recycle_state: RecycleState,
    pub origin: ApplicationOrigin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationDetail {
    #[serde(flatten)]
    pub summary: ApplicationSummary,
    pub company_normalized: String,
    pub title_normalized: String,
    pub dedupe_url: Option<String>,
    pub notes: Option<String>,
    pub last_event_sequence: i64,
}

impl std::ops::Deref for ApplicationDetail {
    type Target = ApplicationSummary;
    fn deref(&self) -> &Self::Target {
        &self.summary
    }
}

/// 持久化后的事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredEvent {
    pub id: String,
    /// 未关联申请的收件箱事件为 null。
    pub application_id: Option<String>,
    pub event_sequence: i64,
    pub event_type: String,
    pub occurred: Occurred,
    pub recorded_at: String,
    pub source: EventSource,
    pub source_request_id: Option<String>,
    pub payload_version: i64,
    pub payload: EventPayload,
    pub actor: Actor,
}

/// 追加事件的草稿。occurred/source/actor/payload 由调用方给出;
/// eventSequence 由存储层在同一事务内分配,调用方不得指定。
#[derive(Debug, Clone)]
pub struct EventDraft {
    pub occurred: Occurred,
    pub source: EventSource,
    pub source_request_id: Option<String>,
    pub actor: Actor,
    pub payload: EventPayload,
}

impl EventDraft {
    pub fn new(
        payload: EventPayload,
        occurred: Occurred,
        source: EventSource,
        actor: Actor,
    ) -> Self {
        Self {
            occurred,
            source,
            source_request_id: None,
            actor,
            payload,
        }
    }
}

/// 附件 blob 元数据:字节在库外,这里只有受控相对路径与摘要。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentBlobMeta {
    pub sha256: String,
    pub size_bytes: i64,
    /// 档案目录内相对路径;拒绝绝对路径、`..`、盘符、UNC。
    pub stored_rel_path: String,
    pub mime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentBlob {
    #[serde(flatten)]
    pub meta: AttachmentBlobMeta,
    pub ref_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyEvidence {
    pub id: String,
    pub application_id: Option<String>,
    pub kind: EvidenceKind,
    /// 确认前可空;确认后 mutable→immutable。
    pub reply_class: Option<ReplyClass>,
    pub send_mode: Option<SendMode>,
    pub blob: AttachmentBlob,
    pub original_filename: Option<String>,
    pub imported_at: String,
    pub subject: Option<String>,
    pub from_addr: Option<String>,
    /// 邮件头发送时间(若可解析);精度未知时为 unknown。
    pub sent_at: Option<Occurred>,
    pub body_extract: Option<String>,
}

/// 导入证据输入。blob 由调用方(D09)写入文件后登记元数据。
#[derive(Debug, Clone)]
pub struct NewEvidence {
    pub application_id: Option<String>,
    pub kind: EvidenceKind,
    pub blob: AttachmentBlobMeta,
    pub original_filename: Option<String>,
    pub subject: Option<String>,
    pub from_addr: Option<String>,
    pub sent_at: Option<Occurred>,
    pub body_extract: Option<String>,
    /// 是否立即追加 evidence_imported 事件;收件箱(无申请)用档案级序号。
    pub append_event: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeSnapshotMeta {
    pub snapshot_id: String,
    pub application_id: String,
    pub template_name: String,
    pub template_version: Option<String>,
    pub sha256: String,
    pub stored_rel_path: String,
    pub created_at: String,
    pub byte_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    pub application_id: String,
    pub title: String,
    pub due: TodoDue,
    pub time_zone: Option<String>,
    pub remind_at_utc: Option<String>,
    pub status: TodoStatus,
    pub interview_round: Option<i64>,
    pub source_event_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoDue {
    /// 精确时刻 UTC。
    DateTime(String),
    /// 只有日历日。
    Date(String),
    None,
}

#[derive(Debug, Clone)]
pub struct NewTodo {
    pub application_id: String,
    pub title: String,
    pub due: TodoDue,
    pub time_zone: Option<String>,
    pub remind_at_utc: Option<String>,
    pub interview_round: Option<i64>,
    /// 由哪个事件创建(可选)。
    pub source_event_id: Option<String>,
}

/// AI 建议状态(§8.7)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SuggestionStatus {
    Pending,
    Confirmed,
    ModifiedConfirmed,
    Rejected,
    Deferred,
}

impl SuggestionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SuggestionStatus::Pending => "pending",
            SuggestionStatus::Confirmed => "confirmed",
            SuggestionStatus::ModifiedConfirmed => "modified_confirmed",
            SuggestionStatus::Rejected => "rejected",
            SuggestionStatus::Deferred => "deferred",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => SuggestionStatus::Pending,
            "confirmed" => SuggestionStatus::Confirmed,
            "modified_confirmed" => SuggestionStatus::ModifiedConfirmed,
            "rejected" => SuggestionStatus::Rejected,
            "deferred" => SuggestionStatus::Deferred,
            _ => return None,
        })
    }
}

/// 建议的待办草案(结构化;确认事务才转正)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuggestedTodo {
    pub title: String,
    pub due: TodoDue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interview_round: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSuggestion {
    pub id: String,
    pub evidence_id: String,
    pub status: SuggestionStatus,
    pub candidate_application_ids: Vec<String>,
    pub suggested_stage: Option<Stage>,
    pub suggested_round: Option<i64>,
    /// 与正式证据字段分离;确认前证据分类不变。
    pub suggested_reply_class: ReplyClass,
    pub suggested_send_mode: SendMode,
    pub suggested_todos: Vec<SuggestedTodo>,
    pub excerpt_refs: Option<serde_json::Value>,
    pub uncertainties: Option<serde_json::Value>,
    pub model_label: Option<String>,
    /// 外发范围摘要(非原文密钥)。
    pub prompt_scope: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
    /// 用户批准值;modified_confirmed 必须可追溯。
    pub approved_reply_class: Option<ReplyClass>,
    pub approved_send_mode: Option<SendMode>,
    /// 确认时批准推进到的阶段(若用户选择记为面试等)。
    pub approved_stage: Option<Stage>,
}

#[derive(Debug, Clone)]
pub struct NewAiSuggestion {
    pub evidence_id: String,
    pub candidate_application_ids: Vec<String>,
    pub suggested_stage: Option<Stage>,
    pub suggested_round: Option<i64>,
    pub suggested_reply_class: ReplyClass,
    pub suggested_send_mode: SendMode,
    pub suggested_todos: Vec<SuggestedTodo>,
    pub excerpt_refs: Option<serde_json::Value>,
    pub uncertainties: Option<serde_json::Value>,
    pub model_label: Option<String>,
    pub prompt_scope: Option<String>,
}
