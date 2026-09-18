//! 打包。
//!
//! 写盘顺序是固定的，而且这个顺序本身就是一条验收：**备份失败不覆盖已有有效备份**
//! （#28）。所以先写一个临时文件、`sync_all`、再 rename 到目标名。中途任何一步
//! 失败都只留下（并删掉）那个临时文件，用户上一次成功的备份原封不动。

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::exclude::{classify, Disposition};
use crate::manifest::{
    ArchiveCounts, Manifest, ManifestEntry, DATABASE_PATH, FORMAT, FORMAT_VERSION, MANIFEST_PATH,
    SETTINGS_PATH,
};
use crate::BackupError;

/// 要打包的东西。
pub struct ArchiveSource<'a> {
    /// 档案目录。里面按 [`crate::exclude`] 的清单取。
    pub archive_dir: &'a Path,
    /// 数据库的一致性快照文件（由 archive-store 用 SQLite backup API 生成）。
    /// 它以 [`DATABASE_PATH`] 的名字进包，**替代**目录里那份正在被写的。
    pub database_snapshot: &'a Path,
    pub archive_id: String,
    pub schema_version: i64,
    pub counts: ArchiveCounts,
    /// 已经按白名单过滤过的设置 JSON。没有就不写这一项。
    pub settings_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteReport {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub entry_count: usize,
    /// 档案目录里没进包的东西：`(相对路径, 原因)`。
    ///
    /// 「清单没覆盖」也在这里。它不是错误，但也**不能无声无息**——那正是手写清单
    /// 会漏东西的方式。
    pub skipped: Vec<(String, String)>,
}

pub fn write_archive(
    source: &ArchiveSource<'_>,
    destination: &Path,
) -> Result<WriteReport, BackupError> {
    let parent = destination
        .parent()
        .ok_or_else(|| BackupError::Invalid("备份路径没有上级目录。".into()))?;
    std::fs::create_dir_all(parent)?;

    let staging = parent.join(format!(
        ".{}.tmp-{}",
        file_name(destination),
        uuid::Uuid::new_v4()
    ));

    match build(source, &staging) {
        Ok((entries, skipped)) => {
            // rename 之前先确认字节真的落盘了，否则「发布成功」只是页缓存里的事。
            let size_bytes = std::fs::metadata(&staging)?.len();
            std::fs::rename(&staging, destination)?;
            Ok(WriteReport {
                path: destination.to_path_buf(),
                size_bytes,
                entry_count: entries,
                skipped,
            })
        }
        Err(e) => {
            // 失败就把临时文件收走。目标位置上原来那个备份没被碰过。
            let _ = std::fs::remove_file(&staging);
            Err(e)
        }
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "archive.zip".into())
}

fn build(
    source: &ArchiveSource<'_>,
    staging: &Path,
) -> Result<(usize, Vec<(String, String)>), BackupError> {
    let file = File::create(staging)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut entries: Vec<ManifestEntry> = Vec::new();
    let mut skipped: Vec<(String, String)> = Vec::new();

    // 1. 数据库快照。
    let digest = add_file(&mut zip, options, DATABASE_PATH, source.database_snapshot)?;
    entries.push(digest);

    // 2. 档案目录里清单允许的部分。
    let mut walk: Vec<PathBuf> = vec![source.archive_dir.to_path_buf()];
    while let Some(dir) = walk.pop() {
        let mut children: Vec<_> = std::fs::read_dir(&dir)?.collect::<Result<_, _>>()?;
        // 排序，让包里的顺序稳定——同样的档案打两次应该得到同样的清单。
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let Some(rel) = relative(source.archive_dir, &path) else {
                continue;
            };
            match classify(&rel) {
                Disposition::Exclude(reason) => {
                    skipped.push((rel, reason.to_string()));
                    continue;
                }
                Disposition::Unknown => {
                    skipped.push((rel, "清单里没有这一项".into()));
                    continue;
                }
                Disposition::Include => {}
            }
            if child.file_type()?.is_dir() {
                walk.push(path);
            } else {
                entries.push(add_file(
                    &mut zip,
                    options,
                    &format!("archive/{rel}"),
                    &path,
                )?);
            }
        }
    }

    // 3. 过滤后的设置。
    if let Some(settings) = &source.settings_json {
        entries.push(add_bytes(
            &mut zip,
            options,
            SETTINGS_PATH,
            settings.as_bytes(),
        )?);
    }

    // 数据库快照里的引用数是打包开始时的业务真相。附件或快照若在快照之后、目录
    // 遍历之前被删掉，单靠 read_dir 会把它当成「本来就没有」并成功产出残包。这里
    // 用快照对应的计数卡住发布：少一个或多一个都失败，临时 ZIP 会由调用方删掉，
    // 上一份成功备份不会被覆盖。应用命令层还会持有 store slot 锁，阻止正常命令
    // 并发删除；这条是对进程外删除、崩溃遗留和未来绕过命令层代码的第二道防线。
    require_count(
        &entries,
        "archive/attachments/",
        source.counts.attachments,
        "附件文件",
    )?;
    require_count(
        &entries,
        "archive/snapshots/",
        source.counts.snapshots,
        "简历快照文件",
    )?;

    // 4. 清单最后写：它要覆盖上面所有条目。
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let manifest = Manifest {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        created_at: source.created_at.clone(),
        archive_id: source.archive_id.clone(),
        schema_version: source.schema_version,
        counts: source.counts.clone(),
        entries,
    };
    let json = serde_json::to_vec_pretty(&manifest)?;
    add_bytes(&mut zip, options, MANIFEST_PATH, &json)?;

    let mut finished = zip.finish()?;
    finished.flush()?;
    finished.sync_all()?;
    skipped.sort();
    Ok((manifest.entries.len(), skipped))
}

fn require_count(
    entries: &[ManifestEntry],
    prefix: &str,
    expected: i64,
    label: &str,
) -> Result<(), BackupError> {
    let actual = entries
        .iter()
        .filter(|entry| entry.path.starts_with(prefix))
        .count() as i64;
    if actual != expected {
        return Err(BackupError::Mismatch(format!(
            "数据库快照记录 {expected} 个{label}，备份目录找到 {actual} 个；请先运行档案完整性检查并修复缺失或孤立文件"
        )));
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn add_file(
    zip: &mut ZipWriter<File>,
    options: SimpleFileOptions,
    name: &str,
    from: &Path,
) -> Result<ManifestEntry, BackupError> {
    let mut source = File::open(from)?;
    zip.start_file(name, options)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut size_bytes = 0u64;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        zip.write_all(&buffer[..read])?;
        size_bytes += read as u64;
    }
    Ok(ManifestEntry {
        path: name.to_string(),
        size_bytes,
        sha256: hex(hasher.finalize().as_slice()),
    })
}

fn add_bytes(
    zip: &mut ZipWriter<File>,
    options: SimpleFileOptions,
    name: &str,
    bytes: &[u8],
) -> Result<ManifestEntry, BackupError> {
    zip.start_file(name, options)?;
    zip.write_all(bytes)?;
    Ok(ManifestEntry {
        path: name.to_string(),
        size_bytes: bytes.len() as u64,
        sha256: hex(Sha256::digest(bytes).as_slice()),
    })
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
