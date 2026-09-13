//! 读包与校验。
//!
//! 这一层的全部职责是回答一个问题：**这个包能不能用。** 它不切换任何指针、不碰
//! 现有档案，只把内容解到一个独立的 staging 目录，并且在任何一步不对的时候把
//! staging 整个删掉。#28 把「损坏 / 截断 / 不支持版本 / 路径穿越被拒绝」和
//! 「当前档案不改变」写在同一条验收里，就是这个意思。
//!
//! 信任顺序也是固定的：**先信清单，再信条目**。包里的条目名是攻击者能控制的东西，
//! 所以只解清单列出的那些，逐个比大小和哈希；清单之外的条目一律视为这个包被动过。

use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::manifest::{Manifest, ManifestEntry, MANIFEST_PATH};
use crate::writer::hex;
use crate::BackupError;

/// 一个包最多能有多少条目。正常档案远远到不了这个数；到了说明这不是我们的包，
/// 或者有人在用条目数量本身做文章。
pub const MAX_ENTRIES: usize = 200_000;

/// 解压之后的总字节上限。清单声明的大小先过这一关，避免为一个声称有 500 GB 的
/// 包腾地方。
pub const MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ExtractReport {
    pub staging: PathBuf,
    pub manifest: Manifest,
    pub total_bytes: u64,
}

/// 只读清单，不解压。恢复前的预览用这个——用户还没确认之前不该往盘上写东西。
pub fn read_manifest(package: &Path) -> Result<Manifest, BackupError> {
    let file = File::open(package)?;
    let mut zip = zip::ZipArchive::new(file)?;
    if zip.len() > MAX_ENTRIES {
        return Err(BackupError::Mismatch(format!(
            "备份里有 {} 个条目，超出上限",
            zip.len()
        )));
    }
    let mut raw = String::new();
    zip.by_name(MANIFEST_PATH)
        .map_err(|_| BackupError::Unreadable(crate::UnreadableManifest::NotOurs))?
        .read_to_string(&mut raw)?;
    let manifest: Manifest =
        serde_json::from_str(&raw).map_err(|_| BackupError::Unreadable(crate::UnreadableManifest::Corrupt))?;
    manifest.check_readable()?;
    check_entries(&manifest)?;
    Ok(manifest)
}

fn check_entries(manifest: &Manifest) -> Result<(), BackupError> {
    if manifest.entries.is_empty() {
        return Err(BackupError::Mismatch("备份是空的。".into()));
    }
    let mut total: u64 = 0;
    for entry in &manifest.entries {
        safe_relative_path(&entry.path)?;
        if entry.sha256.len() != 64 || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BackupError::Mismatch(format!(
                "`{}` 的哈希不是 64 位十六进制",
                entry.path
            )));
        }
        total = total
            .checked_add(entry.size_bytes)
            .ok_or_else(|| BackupError::Mismatch("清单声明的总大小溢出了。".into()))?;
    }
    if total > MAX_TOTAL_BYTES {
        return Err(BackupError::Mismatch(format!(
            "备份声称有 {total} 字节，超出上限"
        )));
    }
    Ok(())
}

/// 把一个包内路径变成可以安全拼接的相对路径。
///
/// 拒绝的东西：绝对路径、盘符、UNC、任何 `..` 段、空段、反斜杠（zip 规范里
/// 分隔符只有正斜杠，出现反斜杠本身就说明这个包不是按规范写的）、以及 Windows
/// 上会被特殊解释的名字。**归一化之后还要再确认它没跑出根目录。**
pub fn safe_relative_path(raw: &str) -> Result<PathBuf, BackupError> {
    if raw.is_empty() {
        return Err(BackupError::Mismatch("备份里有一个空的条目名。".into()));
    }
    if raw.contains('\\') {
        return Err(BackupError::Mismatch(format!("条目名里有反斜杠：`{raw}`")));
    }
    if raw.contains('\0') {
        return Err(BackupError::Mismatch(format!("条目名里有空字节：`{raw}`")));
    }
    if raw.starts_with('/') {
        return Err(BackupError::Mismatch(format!("条目名是绝对路径：`{raw}`")));
    }

    let path = Path::new(raw);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                if part.is_empty() {
                    return Err(BackupError::Mismatch(format!("条目名里有空路径段：`{raw}`")));
                }
                // 冒号要在这里挡，不能指望 `components()`。
                //
                // Windows 上 `C:/x` 会被解析成一个 Prefix 组件、直接落进下面的
                // 兜底分支；**Unix 上它只是一个叫 `C:` 的普通目录名**，于是同一个
                // 包在两个系统上得到两种判断。包是别的机器打的，判断必须和判断
                // 它的机器无关——我们自己的条目名里本来也不会有冒号。
                if part.to_string_lossy().contains(':') {
                    return Err(BackupError::Mismatch(format!(
                        "条目名里有盘符或冒号：`{raw}`"
                    )));
                }
                out.push(part);
            }
            // 盘符、根、UNC 前缀、`.`、`..` 一个都不接受。
            _ => {
                return Err(BackupError::Mismatch(format!(
                    "条目名想跳出备份目录：`{raw}`"
                )))
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(BackupError::Mismatch(format!("条目名没有内容：`{raw}`")));
    }
    Ok(out)
}

/// 解到一个**空的** staging 目录并逐项校验。任何一步失败，staging 整个删掉。
pub fn extract_to_staging(package: &Path, staging: &Path) -> Result<ExtractReport, BackupError> {
    if staging.exists() {
        return Err(BackupError::Invalid(format!(
            "staging 目录已经存在：{}",
            staging.display()
        )));
    }
    std::fs::create_dir_all(staging)?;
    match extract(package, staging) {
        Ok(report) => Ok(report),
        Err(e) => {
            // 校验没过就当没发生过。这是「当前档案不改变」的第一道保证——
            // 半解压的目录留在盘上，下一步就有人会拿它去切换。
            let _ = std::fs::remove_dir_all(staging);
            Err(e)
        }
    }
}

fn extract(package: &Path, staging: &Path) -> Result<ExtractReport, BackupError> {
    let manifest = read_manifest(package)?;
    let file = File::open(package)?;
    let mut zip = zip::ZipArchive::new(file)?;

    // 包里除了清单之外的每一个文件条目，都必须在清单里。多出来的意味着这个包
    // 被动过——我们宁可拒绝整包，也不去猜哪些是好的。
    let described: std::collections::HashSet<&str> =
        manifest.entries.iter().map(|e| e.path.as_str()).collect();
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index)?;
        let name = entry.name().to_string();
        if name == MANIFEST_PATH {
            continue;
        }
        if entry.is_dir() {
            // 目录项不带内容，也不参与校验；但名字照样要安全。
            safe_relative_path(name.trim_end_matches('/'))?;
            continue;
        }
        if is_symlink(&entry) {
            return Err(BackupError::Mismatch(format!("备份里有符号链接：`{name}`")));
        }
        if !described.contains(name.as_str()) {
            return Err(BackupError::Mismatch(format!("`{name}` 不在清单里")));
        }
    }

    let mut total_bytes = 0u64;
    for entry in &manifest.entries {
        total_bytes += extract_one(&mut zip, staging, entry)?;
    }

    Ok(ExtractReport {
        staging: staging.to_path_buf(),
        manifest,
        total_bytes,
    })
}

/// zip 里的符号链接项。
///
/// 两个平台都挡：包是别的机器打的，条目里的 unix mode 照样读得到，而在能建符号
/// 链接的系统上解出来就是一条指向档案目录外面的链接。
fn is_symlink(entry: &zip::read::ZipFile<'_>) -> bool {
    entry
        .unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

fn extract_one(
    zip: &mut zip::ZipArchive<File>,
    staging: &Path,
    entry: &ManifestEntry,
) -> Result<u64, BackupError> {
    let relative = safe_relative_path(&entry.path)?;
    let destination = staging.join(&relative);

    // 拼完再确认一次：归一化能挡住 `..`，但拼接之后仍然要在根目录里面。
    if !destination.starts_with(staging) {
        return Err(BackupError::Mismatch(format!(
            "条目想跳出备份目录：`{}`",
            entry.path
        )));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut source = zip
        .by_name(&entry.path)
        .map_err(|_| BackupError::Mismatch(format!("清单里的 `{}` 不在备份里", entry.path)))?;

    let mut out = File::create(&destination)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        written += read as u64;
        // 边写边卡上限：声明 1 KB 实际吐 10 GB 的包不该把盘写满才被发现。
        if written > entry.size_bytes {
            return Err(BackupError::Mismatch(format!(
                "`{}` 的内容比清单说的多",
                entry.path
            )));
        }
        hasher.update(&buffer[..read]);
        std::io::Write::write_all(&mut out, &buffer[..read])?;
    }
    out.sync_all()?;

    if written != entry.size_bytes {
        return Err(BackupError::Mismatch(format!(
            "`{}` 少了 {} 字节",
            entry.path,
            entry.size_bytes - written
        )));
    }
    let actual = hex(hasher.finalize().as_slice());
    if actual != entry.sha256 {
        return Err(BackupError::Mismatch(format!("`{}` 的内容被改过", entry.path)));
    }
    Ok(written)
}
