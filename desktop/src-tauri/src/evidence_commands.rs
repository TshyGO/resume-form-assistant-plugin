//! D09 命令层：导入、收件箱、预览、关联与分类。
//!
//! 顺序固定：`evidence-import` 先把字节落进 `attachments/`，成功之后 archive-store 才登记
//! 一行证据。一个文件失败不影响同一批里的其他文件。
//!
//! 给 WebView 的每个结构里都**没有存储路径**：预览要么是文本，要么是这里生成的 `data:`
//! 图片；PDF 只给元数据，由 `open_evidence` 交给系统程序打开（拆分计划决策 6、Q2）。

use std::path::{Path, PathBuf};

use archive_store::{
    ArchiveStore, AttachmentBlobMeta, EvidenceKind as StoredKind, NewEvidence, Occurred,
    ReplyClass, ReplyEvidence, SendMode,
};
use evidence_import::{
    bucket_from_unix, parse_eml, stage_file, stage_text, EvidenceKind, MAX_FILES_PER_IMPORT,
};
use serde::{Deserialize, Serialize};

use crate::commands::CommandError;

/// 超过这个大小的图片不做 `data:` 预览，只给元数据：一份内存里的副本已经够贵了。
const MAX_INLINE_IMAGE_BYTES: i64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceSummary {
    pub id: String,
    pub application_id: Option<String>,
    pub kind: String,
    pub mime: Option<String>,
    pub size_bytes: i64,
    pub original_filename: Option<String>,
    pub imported_at: String,
    pub subject: Option<String>,
    pub from_addr: Option<String>,
    pub sent_at: Option<String>,
    pub reply_class: Option<String>,
    pub send_mode: Option<String>,
    /// 引用同一份字节的其他证据。同哈希只是提示，不代表这次导入是多余的。
    pub same_bytes_as: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedImport {
    /// 安全文件名，**不是**用户机器上的路径。
    pub name: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<EvidenceSummary>,
    pub duplicates: Vec<EvidenceSummary>,
    pub failed: Vec<FailedImport>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportArgs {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub application_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePreview {
    #[serde(flatten)]
    pub summary: EvidenceSummary,
    pub body_extract: Option<String>,
    /// 图片才有；`data:` URL 由这里生成，页面的 CSP 允许 `img-src data:`。
    pub image_data_url: Option<String>,
    /// 不能内嵌预览时说明为什么，以及还能做什么。
    pub note: Option<String>,
}

/// 一批导入。失败逐个记录，成功逐个登记；这一批里没有全有或全无的语义。
pub fn import_evidence(
    store: &ArchiveStore,
    args: ImportArgs,
    bucket: &str,
) -> Result<ImportReport, CommandError> {
    let mut report = ImportReport {
        imported: Vec::new(),
        duplicates: Vec::new(),
        failed: Vec::new(),
    };
    let archive_dir = store.archive_dir().to_path_buf();

    let paths: Vec<PathBuf> = args
        .paths
        .iter()
        .take(MAX_FILES_PER_IMPORT)
        .map(PathBuf::from)
        .collect();
    for path in &args.paths[paths.len().min(args.paths.len())..] {
        report.failed.push(FailedImport {
            name: evidence_import::safe_file_name(
                Path::new(path).file_name().and_then(|n| n.to_str()),
            ),
            code: "too_many_files".into(),
        });
    }

    for path in paths {
        match import_one(
            store,
            &archive_dir,
            &path,
            bucket,
            args.application_id.as_deref(),
        ) {
            Ok((summary, duplicated)) => {
                if duplicated {
                    report.duplicates.push(summary);
                } else {
                    report.imported.push(summary);
                }
            }
            Err(failed) => report.failed.push(failed),
        }
    }

    if let Some(text) = args
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        match import_pasted(
            store,
            &archive_dir,
            text,
            bucket,
            args.application_id.as_deref(),
        ) {
            Ok((summary, duplicated)) => {
                if duplicated {
                    report.duplicates.push(summary);
                } else {
                    report.imported.push(summary);
                }
            }
            Err(failed) => report.failed.push(failed),
        }
    }

    Ok(report)
}

fn import_one(
    store: &ArchiveStore,
    archive_dir: &Path,
    source: &Path,
    bucket: &str,
    application_id: Option<&str>,
) -> Result<(EvidenceSummary, bool), FailedImport> {
    let name = evidence_import::safe_file_name(source.file_name().and_then(|n| n.to_str()));
    let existing = |sha: &str| {
        store
            .find_blob(sha)
            .ok()
            .flatten()
            .map(|b| b.meta.stored_rel_path)
    };
    let staged =
        stage_file(archive_dir, source, bucket, &existing).map_err(|err| FailedImport {
            name: name.clone(),
            code: err.code().to_string(),
        })?;

    // 文本类的原件再问一次邮件解析：一个只有 From 头的残信 sniff 判不出来，但它确实是信。
    let parsed = matches!(staged.kind, EvidenceKind::Eml | EvidenceKind::Unknown)
        .then(|| std::fs::read(archive_dir.join(&staged.stored_rel_path)).ok())
        .flatten()
        .and_then(|bytes| parse_eml(&bytes));
    let kind = if parsed.is_some() {
        StoredKind::Eml
    } else {
        stored_kind(staged.kind)
    };

    let record = store
        .import_evidence(NewEvidence {
            application_id: application_id.map(str::to_string),
            kind,
            blob: AttachmentBlobMeta {
                sha256: staged.sha256.clone(),
                size_bytes: staged.size_bytes,
                stored_rel_path: staged.stored_rel_path.clone(),
                mime: staged.mime.clone(),
            },
            original_filename: staged.original_filename.clone(),
            subject: parsed.as_ref().and_then(|mail| mail.subject.clone()),
            from_addr: parsed.as_ref().and_then(|mail| mail.from_addr.clone()),
            sent_at: parsed
                .as_ref()
                .and_then(|mail| mail.sent_at.clone())
                .map(|rfc3339| Occurred::DateTime {
                    rfc3339,
                    time_zone: None,
                }),
            body_extract: parsed.as_ref().and_then(|mail| mail.body_extract.clone()),
            append_event: true,
        })
        .map_err(|_| FailedImport {
            name,
            code: "storage".into(),
        })?;

    Ok((summarise(store, record), staged.deduplicated))
}

fn import_pasted(
    store: &ArchiveStore,
    archive_dir: &Path,
    text: &str,
    bucket: &str,
    application_id: Option<&str>,
) -> Result<(EvidenceSummary, bool), FailedImport> {
    let existing = |sha: &str| {
        store
            .find_blob(sha)
            .ok()
            .flatten()
            .map(|b| b.meta.stored_rel_path)
    };
    let staged = stage_text(archive_dir, text, bucket, &existing).map_err(|err| FailedImport {
        name: "paste.txt".into(),
        code: err.code().to_string(),
    })?;
    let record = store
        .import_evidence(NewEvidence {
            application_id: application_id.map(str::to_string),
            kind: StoredKind::Paste,
            blob: AttachmentBlobMeta {
                sha256: staged.sha256.clone(),
                size_bytes: staged.size_bytes,
                stored_rel_path: staged.stored_rel_path.clone(),
                mime: staged.mime.clone(),
            },
            original_filename: None,
            subject: None,
            from_addr: None,
            sent_at: None,
            body_extract: Some(first_lines(text)),
            append_event: true,
        })
        .map_err(|_| FailedImport {
            name: "paste.txt".into(),
            code: "storage".into(),
        })?;
    Ok((summarise(store, record), staged.deduplicated))
}

fn first_lines(text: &str) -> String {
    let mut extract: String = text
        .chars()
        .take(evidence_import::MAX_BODY_EXTRACT / 4)
        .collect();
    if extract.len() < text.len() {
        extract.push_str("（正文已截断）");
    }
    extract
}

/// 收件箱：还没有关联到任何申请的证据，最近导入的在前。
pub fn list_inbox(store: &ArchiveStore) -> Result<Vec<EvidenceSummary>, CommandError> {
    let mut items: Vec<EvidenceSummary> = store
        .list_evidence(None)?
        .into_iter()
        .map(|record| summarise(store, record))
        .collect();
    items.sort_by(|a, b| b.imported_at.cmp(&a.imported_at));
    Ok(items)
}

pub fn list_for_application(
    store: &ArchiveStore,
    application_id: &str,
) -> Result<Vec<EvidenceSummary>, CommandError> {
    Ok(store
        .list_evidence(Some(application_id))?
        .into_iter()
        .map(|record| summarise(store, record))
        .collect())
}

pub fn get_preview(
    store: &ArchiveStore,
    evidence_id: &str,
) -> Result<EvidencePreview, CommandError> {
    let record = store
        .get_evidence(evidence_id)?
        .ok_or_else(|| CommandError {
            code: "NOT_FOUND".into(),
            message: "找不到这条证据".into(),
        })?;
    let summary = summarise(store, record.clone());
    let path = store.archive_dir().join(&record.blob.meta.stored_rel_path);
    let missing = !path.exists();

    let (image_data_url, note) = match (&record.kind, missing) {
        (_, true) => (
            None,
            Some("本机副本不在了：档案目录里找不到这份文件，可以重新导入原件。".into()),
        ),
        (StoredKind::Screenshot, false)
            if record.blob.meta.size_bytes <= MAX_INLINE_IMAGE_BYTES =>
        {
            match std::fs::read(&path) {
                Ok(bytes) => (
                    Some(format!(
                        "data:{};base64,{}",
                        record.blob.meta.mime.as_deref().unwrap_or("image/png"),
                        base64(&bytes)
                    )),
                    None,
                ),
                Err(_) => (
                    None,
                    Some("这张图片读不出来，档案里的原件可能已损坏。".into()),
                ),
            }
        }
        (StoredKind::Screenshot, false) => (
            None,
            Some("这张图片超过 8 MiB，没有在应用内展开；可以用系统程序打开本机副本。".into()),
        ),
        (StoredKind::Pdf, false) => (
            None,
            Some("PDF 不在应用内渲染。可以用系统程序打开本机副本——那会离开这个应用。".into()),
        ),
        _ => (None, None),
    };

    Ok(EvidencePreview {
        summary,
        body_extract: record.body_extract,
        image_data_url,
        note,
    })
}

pub fn associate(
    store: &ArchiveStore,
    evidence_id: &str,
    application_id: &str,
) -> Result<EvidenceSummary, CommandError> {
    let record = store.associate_evidence(evidence_id, application_id)?;
    Ok(summarise(store, record))
}

pub fn unassociate(
    store: &ArchiveStore,
    evidence_id: &str,
) -> Result<EvidenceSummary, CommandError> {
    let record = store.unassociate_evidence(evidence_id)?;
    Ok(summarise(store, record))
}

/// 用户确认的分类。两个字段各自独立：选了「面试邀请」不会让发送方式变成「人工」。
pub fn classify(
    store: &ArchiveStore,
    evidence_id: &str,
    reply_class: &str,
    send_mode: &str,
) -> Result<EvidenceSummary, CommandError> {
    let class = parse_reply_class(reply_class).ok_or_else(|| CommandError {
        code: "VALIDATION".into(),
        message: format!("未知的通知类型：{reply_class}"),
    })?;
    let mode = parse_send_mode(send_mode).ok_or_else(|| CommandError {
        code: "VALIDATION".into(),
        message: format!("未知的发送方式：{send_mode}"),
    })?;
    let record = store.classify_evidence(evidence_id, class, mode)?;
    Ok(summarise(store, record))
}

/// 这份证据在档案里的绝对路径，只给宿主用来交给系统程序（永远不返回给 WebView）。
pub fn stored_path(store: &ArchiveStore, evidence_id: &str) -> Result<PathBuf, CommandError> {
    let record = store
        .get_evidence(evidence_id)?
        .ok_or_else(|| CommandError {
            code: "NOT_FOUND".into(),
            message: "找不到这条证据".into(),
        })?;
    let root = store
        .archive_dir()
        .canonicalize()
        .map_err(|err| CommandError {
            code: "STORE_ERROR".into(),
            message: err.to_string(),
        })?;
    let path = root
        .join(&record.blob.meta.stored_rel_path)
        .canonicalize()
        .map_err(|_| CommandError {
            code: "NOT_FOUND".into(),
            message: "本机副本不在了".into(),
        })?;
    if !path.starts_with(&root) {
        return Err(CommandError {
            code: "VALIDATION".into(),
            message: "这条证据指向档案目录之外".into(),
        });
    }
    Ok(path)
}

fn summarise(store: &ArchiveStore, record: ReplyEvidence) -> EvidenceSummary {
    let same_bytes_as = store
        .evidence_for_blob(&record.blob.meta.sha256)
        .unwrap_or_default()
        .into_iter()
        .filter(|id| id != &record.id)
        .collect();
    EvidenceSummary {
        id: record.id,
        application_id: record.application_id,
        kind: record.kind.as_str().to_string(),
        mime: record.blob.meta.mime,
        size_bytes: record.blob.meta.size_bytes,
        original_filename: record.original_filename,
        imported_at: record.imported_at,
        subject: record.subject,
        from_addr: record.from_addr,
        sent_at: occurred_text(record.sent_at),
        reply_class: record.reply_class.map(|c| c.as_str().to_string()),
        send_mode: record.send_mode.map(|m| m.as_str().to_string()),
        same_bytes_as,
    }
}

fn occurred_text(occurred: Option<Occurred>) -> Option<String> {
    match occurred {
        Some(Occurred::DateTime { rfc3339, .. }) => Some(rfc3339),
        Some(Occurred::Date { date, .. }) => Some(date),
        _ => None,
    }
}

fn stored_kind(kind: EvidenceKind) -> StoredKind {
    match kind {
        EvidenceKind::Eml => StoredKind::Eml,
        EvidenceKind::Screenshot => StoredKind::Screenshot,
        EvidenceKind::Pdf => StoredKind::Pdf,
        EvidenceKind::Paste => StoredKind::Paste,
        EvidenceKind::Unknown => StoredKind::Unknown,
    }
}

fn parse_reply_class(value: &str) -> Option<ReplyClass> {
    Some(match value {
        "auto_ack" => ReplyClass::AutoAck,
        "assessment_invite" => ReplyClass::AssessmentInvite,
        "interview_invite" => ReplyClass::InterviewInvite,
        "action_required" => ReplyClass::ActionRequired,
        "offer" => ReplyClass::Offer,
        "reject" => ReplyClass::Reject,
        "other" => ReplyClass::Other,
        "unknown" => ReplyClass::Unknown,
        _ => return None,
    })
}

fn parse_send_mode(value: &str) -> Option<SendMode> {
    Some(match value {
        "human" => SendMode::Human,
        "automated" => SendMode::Automated,
        "unknown" => SendMode::Unknown,
        _ => return None,
    })
}

/// 导入时间决定桶名，也就决定了文件落在 `attachments/<yyyy>/<mm>/`。
pub fn bucket_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    bucket_from_unix(seconds)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - i * 6)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
