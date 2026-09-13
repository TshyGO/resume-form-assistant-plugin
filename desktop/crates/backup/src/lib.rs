//! 档案备份的归档格式（D12）。
//!
//! 这个 crate 只搬字节：打包、算哈希、写清单、校验、解包。它不认识数据库，也不
//! 知道「一条申请」是什么——一致性快照由 `archive-store` 生成好之后交进来。
//!
//! 之所以单独一层，是因为 #28 的验收里最要命的那几条（损坏、截断、路径穿越、
//! 磁盘失败、失败之后原状不变）都能在这里用普通 `cargo test` 覆盖，不需要起
//! 一个真的档案库，也不需要 Tauri。

pub mod exclude;
pub mod manifest;
mod reader;
mod writer;

pub use manifest::{ArchiveCounts, Manifest, ManifestEntry, UnreadableManifest};
pub use reader::{extract_to_staging, read_manifest, safe_relative_path, ExtractReport};
pub use writer::{write_archive, ArchiveSource, WriteReport};

#[derive(Debug)]
pub enum BackupError {
    /// 参数本身不成立。
    Invalid(String),
    /// 包读不了：不是我们的包、损坏、或者版本太新。
    Unreadable(UnreadableManifest),
    /// 包里的内容和清单对不上。
    Mismatch(String),
    Io(std::io::Error),
    Zip(zip::result::ZipError),
    Json(serde_json::Error),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BackupError::Invalid(m) => write!(f, "{m}"),
            BackupError::Unreadable(m) => write!(f, "{m}"),
            BackupError::Mismatch(m) => write!(f, "备份内容与清单对不上：{m}"),
            BackupError::Io(e) => write!(f, "读写失败：{e}"),
            BackupError::Zip(e) => write!(f, "备份文件读不开：{e}"),
            BackupError::Json(e) => write!(f, "清单解析失败：{e}"),
        }
    }
}

impl std::error::Error for BackupError {}

impl From<std::io::Error> for BackupError {
    fn from(e: std::io::Error) -> Self {
        BackupError::Io(e)
    }
}

impl From<zip::result::ZipError> for BackupError {
    fn from(e: zip::result::ZipError) -> Self {
        BackupError::Zip(e)
    }
}

impl From<serde_json::Error> for BackupError {
    fn from(e: serde_json::Error) -> Self {
        BackupError::Json(e)
    }
}

impl From<UnreadableManifest> for BackupError {
    fn from(e: UnreadableManifest) -> Self {
        BackupError::Unreadable(e)
    }
}
