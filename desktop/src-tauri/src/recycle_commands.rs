//! D12 的回收站与永久删除。
//!
//! 两条规矩贯穿整块（#28 范围）：
//!
//! 1. **回收不等于删除。** 回收之后必须能原样恢复，历史一条不少。
//! 2. **永久删除只清没人引用的附件。** 同一份字节可能被好几条证据引用（同哈希
//!    只登记一次），删掉一条不代表那份文件没人要了。不确定的一律留着——
//!    留一个孤儿文件只是占地方，删错一个是把用户的东西弄丢了。
//!
//! 孤立附件检查因此只**报告**，删除要用户逐项确认。`check_attachment_refs`
//! 早就是这个语义（D03 的注释原话：「只报告不删除」），这里不去改它。

use std::path::PathBuf;

use archive_store::{ApplicationFilter, ApplicationSummary, ArchiveStore, RecycleState};
use serde::Serialize;

use crate::commands::CommandError;

fn fail(code: &str, message: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.to_string(),
    }
}

/// 永久删除之前给用户看的东西。**先看会连带删掉什么，再决定。**
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PurgePreview {
    pub application_id: String,
    pub company: String,
    pub title: String,
    pub events: i64,
    pub todos: i64,
    pub evidence: i64,
    pub snapshots: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub application_id: String,
    pub events_removed: usize,
    pub todos_removed: usize,
    pub evidence_removed: usize,
    pub snapshots_removed: usize,
    /// 引用计数降到 0、因此**文件也删掉了**的附件。
    pub attachment_files_removed: usize,
    /// 库行删了但文件没删掉的（比如文件已经不在）。不算失败，但要说出来。
    pub attachment_files_left: Vec<String>,
}

/// 孤立附件的报告。**只报告。**
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanReport {
    pub total_blobs: usize,
    pub total_evidence: usize,
    /// 没有任何证据引用的 blob。
    pub zero_ref_blobs: Vec<String>,
    /// 指向缺失 blob 行的证据。正常应该是空的；不空说明有别的问题，
    /// 这时候**更不该**自动删任何东西。
    pub dangling_evidence: Vec<String>,
    pub invalid_files: Vec<String>,
}

pub fn list_recycled(store: &ArchiveStore) -> Result<Vec<ApplicationSummary>, CommandError> {
    let filter = ApplicationFilter {
        recycle_state: Some(Some(RecycleState::Recycled)),
        ..Default::default()
    };
    Ok(store
        .list_applications(&filter)
        .map_err(|e| fail("STORE_ERROR", e))?
        .items)
}

/// 把一条申请放进回收站，或者从回收站拿回来。
///
/// 走的是 `set_recycle_state`，它会写一条事件——回收和恢复都留痕，时间线上看得出
/// 这条申请为什么消失过又回来了。永久删除**不能**从这里走（存储层会拒绝）。
pub fn set_recycled(
    store: &ArchiveStore,
    id: &str,
    recycled: bool,
) -> Result<(), CommandError> {
    let state = if recycled {
        RecycleState::Recycled
    } else {
        RecycleState::Active
    };
    store
        .set_recycle_state(id, state)
        .map(|_| ())
        .map_err(|e| fail("STORE_ERROR", e))
}

pub fn purge_preview(store: &ArchiveStore, id: &str) -> Result<PurgePreview, CommandError> {
    let view = store
        .get_application(id)
        .map_err(|e| fail("STORE_ERROR", e))?
        .ok_or_else(|| fail("NOT_FOUND", "这条申请不存在。"))?;
    let events = store
        .list_events(id)
        .map_err(|e| fail("STORE_ERROR", e))?
        .len() as i64;
    let todos = store
        .list_todos(Some(id), None, None, 1000, 0)
        .map_err(|e| fail("STORE_ERROR", e))?
        .len() as i64;
    let evidence = store
        .list_evidence(Some(id))
        .map_err(|e| fail("STORE_ERROR", e))?
        .len() as i64;
    let snapshots = store
        .list_snapshots(id)
        .map_err(|e| fail("STORE_ERROR", e))?
        .len() as i64;
    Ok(PurgePreview {
        application_id: id.to_string(),
        company: view.company.clone(),
        title: view.title.clone(),
        events,
        todos,
        evidence,
        snapshots,
    })
}

/// 永久删除。
///
/// 顺序是**先删库行、再删文件**：反过来的话，删文件成功而事务回滚，库里就会有
/// 一条指向不存在文件的记录。这个顺序下最坏的情况是留下一个没人引用的文件，
/// 由孤立附件检查报出来。
pub fn purge(
    store: &ArchiveStore,
    archive_dir: &std::path::Path,
    id: &str,
) -> Result<PurgeResult, CommandError> {
    // 删之前先把 blob 的存储路径问出来——删完就查不到了。
    let released_paths = blob_paths(store, id)?;

    let report = store
        .purge_application(id)
        .map_err(|e| fail("STORE_ERROR", e))?;

    let mut removed = 0usize;
    let mut left = Vec::new();
    for sha in &report.blobs_released {
        match released_paths.get(sha) {
            Some(rel) => {
                let path = archive_dir.join(rel);
                match std::fs::remove_file(&path) {
                    Ok(()) => removed += 1,
                    // 文件已经不在了：结果和我们想要的一样，不算失败。
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => removed += 1,
                    Err(_) => left.push(rel.clone()),
                }
            }
            // 查不到路径就不猜。孤立附件检查会把它报出来。
            None => left.push(sha.clone()),
        }
    }

    Ok(PurgeResult {
        application_id: report.application_id,
        events_removed: report.events_removed,
        todos_removed: report.todos_removed,
        evidence_removed: report.evidence_removed,
        snapshots_removed: report.snapshots_removed,
        attachment_files_removed: removed,
        attachment_files_left: left,
    })
}

/// 这条申请下每份证据的 blob 哈希 → 存储相对路径。
fn blob_paths(
    store: &ArchiveStore,
    id: &str,
) -> Result<std::collections::HashMap<String, String>, CommandError> {
    let mut out = std::collections::HashMap::new();
    for evidence in store
        .list_evidence(Some(id))
        .map_err(|e| fail("STORE_ERROR", e))?
    {
        out.insert(
            evidence.blob.meta.sha256.clone(),
            evidence.blob.meta.stored_rel_path.clone(),
        );
    }
    Ok(out)
}

/// 孤立附件检查。**只报告，删除要用户逐项确认。**
pub fn orphan_report(store: &ArchiveStore) -> Result<OrphanReport, CommandError> {
    let report = store
        .check_attachment_refs()
        .map_err(|e| fail("STORE_ERROR", e))?;
    Ok(OrphanReport {
        total_blobs: report.total_blobs,
        total_evidence: report.total_evidence,
        zero_ref_blobs: report.zero_ref_blobs,
        dangling_evidence: report.dangling_evidence,
        invalid_files: report.invalid_files,
    })
}

/// 用户在孤立报告里逐项确认之后，删掉一个文件。
///
/// 每次只删一个，而且要再问一次库：确认它现在**仍然**没人引用。报告可能是几分钟
/// 前生成的，中间用户可能又导入了引用同一份字节的证据。
pub fn remove_orphan(
    store: &ArchiveStore,
    archive_dir: &std::path::Path,
    sha256: &str,
) -> Result<(), CommandError> {
    let report = store
        .check_attachment_refs()
        .map_err(|e| fail("STORE_ERROR", e))?;
    if !report.zero_ref_blobs.iter().any(|s| s == sha256) {
        return Err(fail(
            "STILL_REFERENCED",
            "这份附件现在有证据引用了，没有删除。",
        ));
    }
    let Some(rel) = store
        .find_blob(sha256)
        .map_err(|e| fail("STORE_ERROR", e))?
        .map(|blob| blob.meta.stored_rel_path)
    else {
        return Err(fail("NOT_FOUND", "找不到这份附件的记录。"));
    };
    let path: PathBuf = archive_dir.join(&rel);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(fail("IO_ERROR", e)),
    }
}

#[cfg(test)]
#[path = "recycle_commands_tests.rs"]
mod tests;
