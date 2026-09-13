//! 备份清单：包里有什么、每样多大、内容哈希是多少。
//!
//! 清单存在的意义不是「解压的时候顺便对一下」，而是**让恢复可以在动任何东西之前
//! 就判断这个包能不能用**。#28 的验收把「损坏 / 截断 / 不支持版本 / 路径穿越」
//! 和「当前档案不改变」写在同一条里——只有先读清单、逐项校验，才谈得上后半句。

use serde::{Deserialize, Serialize};

/// 包的格式标识。换了格式就换这个字符串，别在版本号上做文章。
pub const FORMAT: &str = "resume-pro.archive";

/// 当前写出的格式版本。读到比它大的一律拒绝——我们不知道未来的包里有什么。
pub const FORMAT_VERSION: u32 = 1;

/// 清单在包里的固定位置。
pub const MANIFEST_PATH: &str = "manifest.json";

/// 数据库快照在包里的固定位置。它是 SQLite backup API 出来的一致性副本，
/// **不是**档案目录里那份正在被写的 `archive.db`。
pub const DATABASE_PATH: &str = "archive/archive.db";

/// 过滤之后的设置。整份 `settings.json` 不进包（见拆分计划 Q2）。
pub const SETTINGS_PATH: &str = "settings.json";

/// 给用户看的计数。恢复前的预览拿它和当前档案对比，用户才知道自己要换成什么。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCounts {
    pub applications: i64,
    pub events: i64,
    pub snapshots: i64,
    pub todos: i64,
    pub evidence: i64,
    pub attachments: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// 包内路径，永远是正斜杠。
    pub path: String,
    pub size_bytes: u64,
    /// 小写十六进制 sha256。
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub created_at: String,
    /// 档案身份。**不含 restoreEpoch**——那是机器本地的东西，恢复时新铸
    /// （identity.rs 的契约，#28 的 D01 修订也点了名）。
    pub archive_id: String,
    pub schema_version: i64,
    pub counts: ArchiveCounts,
    pub entries: Vec<ManifestEntry>,
}

impl Manifest {
    pub fn entry(&self, path: &str) -> Option<&ManifestEntry> {
        self.entries.iter().find(|entry| entry.path == path)
    }

    /// 这个包是我们能读的吗。
    ///
    /// 分成两种拒绝：**不是我们的包** 和 **是我们的包但太新了**。两句话对用户
    /// 的意义完全不同，一句「备份文件无效」把它们混在一起没有帮助。
    pub fn check_readable(&self) -> Result<(), UnreadableManifest> {
        if self.format != FORMAT {
            return Err(UnreadableManifest::NotOurs);
        }
        if self.format_version == 0 {
            return Err(UnreadableManifest::Corrupt);
        }
        if self.format_version > FORMAT_VERSION {
            return Err(UnreadableManifest::TooNew {
                found: self.format_version,
                supported: FORMAT_VERSION,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnreadableManifest {
    NotOurs,
    Corrupt,
    TooNew { found: u32, supported: u32 },
}

impl std::fmt::Display for UnreadableManifest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnreadableManifest::NotOurs => write!(f, "这不是 Resume Pro 的备份文件。"),
            UnreadableManifest::Corrupt => write!(f, "备份文件的清单已损坏。"),
            UnreadableManifest::TooNew { found, supported } => write!(
                f,
                "备份来自更新版本的程序（格式 v{found}，本机支持到 v{supported}），请先升级。"
            ),
        }
    }
}
