//! 错误类型。错误码语义与 D01 契约对齐:
//! `identity_missing` / `restore_epoch_mismatch` / `conflict` / `previously_purged`。

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("internal error: {0}")]
    Internal(String),
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("invalid input: {0}")]
    Validation(String),

    #[error("entity not found: {0}")]
    NotFound(String),

    /// 请求信封缺失档案身份字段。等价协议错误 `identity_missing`。
    #[error("identity_missing: envelope carries no archive identity")]
    IdentityMissing,

    /// 信封身份或 sourceRestoreEpoch 与当前指针不符。等价协议错误 `restore_epoch_mismatch`。
    /// 不是成功重放,不得改写成当前身份后执行。
    #[error("restore_epoch_mismatch: {detail}")]
    RestoreEpochMismatch {
        detail: String,
        #[source]
        source: Option<EpochMismatch>,
    },

    /// 幂等键身份相同但载荷摘要不同。等价协议错误 `conflict`。
    #[error("conflict: {0}")]
    Conflict(String),

    /// 重试命中永久删除墓碑。不得重建对象。
    #[error("previously_purged")]
    PreviouslyPurged {
        /// 原 resultId 仅供诊断,不再指向可用对象。
        former_result_id: Option<String>,
    },

    /// 迁移失败。原库未破坏;backup 指向迁移前的自动备份。
    #[error("migration to v{version} failed; original database intact; backup at {}",
        backup.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "<none>".into()))]
    MigrationFailed {
        version: i64,
        backup: Option<PathBuf>,
        #[source]
        source: anyhow_no_source::BoxError,
    },

    /// meta.json 与数据库内的 archiveId 不一致。
    #[error("archive identity mismatch: meta.json says {meta}, database says {db}")]
    ArchiveIdentityMismatch { meta: String, db: String },

    /// current.json 指向另一个 archiveId。需先完成恢复/指针切换。
    #[error("current pointer refers to archive {pointer}, but this archive is {here}")]
    PointerMismatch { pointer: String, here: String },

    /// 附件/快照相对路径非法(绝对路径、`..`、盘符、UNC)。
    #[error("path invalid: {0}")]
    PathInvalid(String),

    #[error("data directory not writable: {0}")]
    NotWritable(String),
}

/// 让 `MigrationFailed` 不依赖 anyhow,仅存展示字符串。
pub mod anyhow_no_source {
    use std::fmt;

    pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

    #[derive(Debug)]
    pub struct Wrapped(pub String);

    impl fmt::Display for Wrapped {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(&self.0)
        }
    }

    impl std::error::Error for Wrapped {}
}

/// epoch 不匹配的具体诊断信息(哪个字段、期望值类别)。不含敏感正文。
#[derive(Debug, Clone)]
pub enum EpochMismatch {
    EnvelopeArchiveId { expected: String },
    EnvelopeRestoreEpoch { expected: String },
    SourceRestoreEpoch { expected: String },
}

impl std::fmt::Display for EpochMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for EpochMismatch {}

impl StoreError {
    // Internal errors must not be retried as new writes by adapters.
    /// 供 D05/D06 适配层映射协议错误码。
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::IdentityMissing => "identity_missing",
            StoreError::RestoreEpochMismatch { .. } => "restore_epoch_mismatch",
            StoreError::Conflict(_) => "conflict",
            StoreError::PreviouslyPurged { .. } => "previously_purged",
            StoreError::NotFound(_) => "not_found",
            StoreError::Validation(_) => "validation_failed",
            StoreError::MigrationFailed { .. } => "migration_failed",
            StoreError::ArchiveIdentityMismatch { .. } => "archive_identity_mismatch",
            StoreError::PointerMismatch { .. } => "pointer_mismatch",
            StoreError::PathInvalid(_) => "path_invalid",
            StoreError::NotWritable(_) => "dir_not_writable",
            StoreError::Sqlite(_)
            | StoreError::Io(_)
            | StoreError::Json(_)
            | StoreError::Internal(_) => "internal_error",
        }
    }

    /// `restore_epoch_mismatch` 作为写入不是可重试成功;幂等重放冲突不可自动重试。
    pub fn retryable(&self) -> bool {
        matches!(self, StoreError::Sqlite(rusqlite::Error::SqliteFailure(code, _))
            if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
    }
}
