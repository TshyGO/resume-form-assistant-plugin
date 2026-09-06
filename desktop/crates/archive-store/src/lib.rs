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
pub mod schema;
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
pub use receipts::SnapshotProgress;
pub use receipts::{
    FillSubmitInput, JobSaveInput, PluginOp, PluginWriteContext, PluginWriteOutcome,
    ReconcileOutcome, ReconcileQueryItem, ReconcileReply, SnapshotChunkInput, SubmitConfirmInput,
};
pub use store::{ArchiveConfig, ArchiveStore};
pub use suggestions::{ConfirmOutcome, ConfirmSuggestionInput};
pub use todos::TodoPatch;
