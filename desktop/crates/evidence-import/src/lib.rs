//! D09 证据导入：把一个本机文件或一段粘贴文本变成档案目录里的一份受控副本。
//!
//! 这个 crate **只写文件**：安全文件名、内容嗅探、sha256、原子落盘。数据库登记由
//! archive-store（D03）负责，调用顺序固定为「先落文件，再登记」，因此绝不会出现
//! 「库里有记录、文件不在」。反过来的孤儿文件由 `check_attachment_refs` 报告。
//!
//! 原始来源路径（`sourcePathHint`）只作为参数存在：不进任何返回结构、不进错误信息、
//! 不进日志（产品需求 §8.4、走查 10.16）。

use std::path::{Path, PathBuf};

mod eml;
mod names;
mod sniff;

pub use eml::{html_to_text, parse_eml, ParsedMail, MAX_BODY_EXTRACT};
pub use names::safe_file_name;
pub use sniff::{sniff, Sniffed};

/// 单份附件上限。超过明确拒绝，不截断、不压缩（拆分计划 Q3）。
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

/// 一次导入最多接受的文件数。
pub const MAX_FILES_PER_IMPORT: usize = 20;

/// 获取格式，与 archive-store 的 `EvidenceKind` 一一对应（这里不依赖那个 crate）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
}

/// 已经落盘的一份字节。`stored_rel_path` 相对档案根，正斜杠分隔。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBlob {
    pub sha256: String,
    pub size_bytes: i64,
    pub stored_rel_path: String,
    pub mime: Option<String>,
    pub kind: EvidenceKind,
    pub original_filename: Option<String>,
    /// 同样的字节此前已经在档案里，这次没有再写一份文件。
    pub deduplicated: bool,
}

/// 导入失败的原因。**只带安全文件名与错误码**，不带来源路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportError {
    TooLarge { size_bytes: u64 },
    SourceUnreadable,
    Unsupported { mime: Option<String> },
    Storage { code: &'static str },
}

impl ImportError {
    pub fn code(&self) -> &'static str {
        match self {
            ImportError::TooLarge { .. } => "too_large",
            ImportError::SourceUnreadable => "source_unreadable",
            ImportError::Unsupported { .. } => "unsupported",
            ImportError::Storage { .. } => "storage",
        }
    }
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for ImportError {}

/// 已在档案里的同 sha256 字节的相对路径，由调用方查库回答。
pub type ExistingBlob<'a> = &'a dyn Fn(&str) -> Option<String>;

/// 复制一个本机文件进 `<archive>/attachments/<bucket>/`。
///
/// 先读、再判类型、再落盘：超限与不支持的文件在磁盘上不留任何痕迹。
pub fn stage_file(
    archive_dir: &Path,
    source: &Path,
    bucket: &str,
    existing: ExistingBlob<'_>,
) -> Result<StagedBlob, ImportError> {
    // 一个句柄读到底：先 metadata 再 read 会给别人换文件的机会，也挡不住一个还在
    // 增长的文件。`take(上限 + 1)` 让超限在读满之前就能判定，不会先吃下几百 MB。
    use std::io::Read;
    let file = std::fs::File::open(source).map_err(|_| ImportError::SourceUnreadable)?;
    if !file
        .metadata()
        .map_err(|_| ImportError::SourceUnreadable)?
        .is_file()
    {
        return Err(ImportError::SourceUnreadable);
    }
    let mut bytes = Vec::new();
    file.take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ImportError::SourceUnreadable)?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(ImportError::TooLarge {
            size_bytes: bytes.len() as u64,
        });
    }
    let original = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    let sniffed = sniff::sniff(&bytes, original.as_deref())?;
    write_blob(archive_dir, &bytes, bucket, sniffed, original, existing)
}

/// 把一段粘贴文本落成 `.txt`。
pub fn stage_text(
    archive_dir: &Path,
    text: &str,
    bucket: &str,
    existing: ExistingBlob<'_>,
) -> Result<StagedBlob, ImportError> {
    let bytes = text.as_bytes();
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(ImportError::TooLarge {
            size_bytes: bytes.len() as u64,
        });
    }
    let sniffed = Sniffed {
        kind: EvidenceKind::Paste,
        mime: Some("text/plain".into()),
    };
    write_blob(archive_dir, bytes, bucket, sniffed, None, existing)
}

/// 落盘的唯一入口：查重 → 建目录 → 写临时文件并 flush → rename 到不冲突的最终名。
///
/// 任何一步失败都不留临时文件。rename 之后由调用方登记数据库；两者之间崩溃只会留下
/// 一个没有引用的文件，`check_attachment_refs` 会报告它。
fn write_blob(
    archive_dir: &Path,
    bytes: &[u8],
    bucket: &str,
    sniffed: Sniffed,
    original_filename: Option<String>,
    existing: ExistingBlob<'_>,
) -> Result<StagedBlob, ImportError> {
    let sha256 = sha256_hex(bytes);
    let size_bytes = bytes.len() as i64;

    if let Some(stored_rel_path) = existing(&sha256) {
        return Ok(StagedBlob {
            sha256,
            size_bytes,
            stored_rel_path,
            mime: sniffed.mime,
            kind: sniffed.kind,
            original_filename,
            deduplicated: true,
        });
    }

    if !valid_bucket(bucket) {
        return Err(ImportError::Storage { code: "bucket" });
    }
    let dir = bucket_dir(archive_dir, bucket);
    std::fs::create_dir_all(&dir).map_err(|_| ImportError::Storage { code: "create_dir" })?;

    let fallback = match sniffed.kind {
        EvidenceKind::Paste => "paste.txt",
        _ => "evidence",
    };
    let safe = names::safe_file_name(Some(original_filename.as_deref().unwrap_or(fallback)));
    let file_name = format!("{}-{}", &sha256[..16], safe);
    let target = names::unique_path(&dir, &file_name);

    let temporary = dir.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(ImportError::Storage { code: "write" });
    }
    if std::fs::rename(&temporary, &target).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err(ImportError::Storage { code: "rename" });
    }
    // 让 rename 本身也持久（与 D08 的快照文件同一处理）：POSIX 上要 fsync 父目录，
    // Windows 没有可 fsync 的目录句柄，NTFS/ReFS 用日志提交这条目录项。
    #[cfg(unix)]
    {
        let _ = std::fs::File::open(&dir).and_then(|handle| handle.sync_all());
    }

    let final_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&file_name)
        .to_string();
    Ok(StagedBlob {
        sha256,
        size_bytes,
        stored_rel_path: format!("attachments/{bucket}/{final_name}"),
        mime: sniffed.mime,
        kind: sniffed.kind,
        original_filename,
        deduplicated: false,
    })
}

/// `YYYY/MM`，由调用方按导入时间给出。别的形状一律拒绝，路径不接受任何外部字符串。
fn valid_bucket(bucket: &str) -> bool {
    let bytes = bucket.as_bytes();
    bytes.len() == 7
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'/'
        && bytes[5..].iter().all(u8::is_ascii_digit)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// 导入时间决定文件落在哪个月份的桶里：`YYYY/MM`。
pub fn bucket_from_unix(seconds: i64) -> String {
    eml::rfc3339_utc(seconds)[..7].replace('-', "/")
}

/// `attachments/<bucket>` 的绝对路径。
pub fn bucket_dir(archive_dir: &Path, bucket: &str) -> PathBuf {
    archive_dir.join("attachments").join(bucket)
}
