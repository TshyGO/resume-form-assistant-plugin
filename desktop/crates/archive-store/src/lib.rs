//! Resume Pro D03 本地数据层(issue #18)。
//!
//! SQLite 申请档案与事件存储:申请、事件(eventSequence + 阶段投影同事务)、
//! 回复证据元数据、简历快照元数据、待办、AI 建议、提交回执与幂等墓碑。
//!
//! 边界:
//! - 路径由宿主注入([ArchiveConfig]),不硬编码用户目录,不创建第二个写入进程。
//! - 附件/快照字节不进库;这里只有受控相对路径与摘要,文件导入归 D09、
//!   备份归 D12。
//! - 协议适配(D05/D06)在本 crate 之上:入口是 [PluginWriteContext] +
//!   [PluginOp],之后由适配器调用;本 crate 不做网络与 Native Messaging。
//!
//! 契约来源:`docs/desktop-mvp/`(D01 基线);阶段折叠见 [stage::fold_stage]。

pub mod applications;
pub mod error;
pub mod evidence;
pub mod facade;
pub mod identity;
pub mod migration;
pub mod model;
pub mod normalize;
pub mod plugin;
pub mod receipts;
pub mod resume;
pub mod resume_secrets;
pub mod schema;
mod snapshot_file;
/// 快照文件在档案目录里的相对路径。D12 永久删除时要按它去删文件。
pub use snapshot_file::rel_path_for as snapshot_rel_path;
pub mod stage;
pub mod store;
pub mod suggestions;
pub mod timeutil;
pub mod todos;
pub mod tx;

pub use applications::{
    ApplicationCandidate, ApplicationFilter, Candidates, ListSort, Page, PurgeReport,
    UpdateApplicationInput,
};
pub use error::StoreError;
pub use identity::{ArchiveIdentity, ArchiveMetaFile, CurrentPointer};
pub use migration::current_schema_version;
// model::* 已含 Stage / StageUpdateMode / Fold / Occurred / EventPayload 等模型类型。
pub use model::*;
pub use receipts::{SnapshotCompletion, SnapshotProgress, SnapshotState};
pub use receipts::{
    FillSubmitInput, JobSaveInput, PluginOp, PluginWriteContext, PluginWriteOutcome,
    ReconcileOutcome, ReconcileQueryItem, ReconcileReply, SnapshotChunkInput, SubmitConfirmInput,
};
pub use resume::{
    empty_profile, field_count, normalize_groups, reject_profile_secrets, validate_profile, ProfileRecord, ResumeOverview,
    ResumeTemplate, SavedTemplate, TemplateField, TemplateGroup, TemplateSummary, MAX_CUSTOM_FIELDS,
    MAX_PROFILE_BYTES, MAX_TEMPLATES, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_NAME_CHARS,
};
pub use resume_secrets::{is_secret_label, is_secret_value};
pub use store::{ArchiveConfig, ArchiveStore};
pub use suggestions::{ConfirmOutcome, ConfirmSuggestionInput};
pub use todos::TodoPatch;
