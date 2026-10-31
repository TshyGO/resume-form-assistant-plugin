//! User-confirmed permanent deletion of a single recycled notification.
use crate::commands::CommandError;
use archive_store::ArchiveStore;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeTarget {
    pub evidence_id: String,
    pub archive_id: String,
    pub restore_epoch: String,
    pub blob_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgePreview {
    pub target: PurgeTarget,
    pub title: String,
    pub original_shared: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub original_shared: bool,
    pub cleanup_pending: bool,
}

fn invalid(message: &str) -> CommandError {
    CommandError {
        code: "VALIDATION".into(),
        message: message.into(),
    }
}

pub fn preview(store: &ArchiveStore, id: &str) -> Result<PurgePreview, CommandError> {
    let record = store
        .get_evidence(id)?
        .ok_or_else(|| invalid("这条通知不存在。"))?;
    if !store.is_evidence_recycled(id)? {
        return Err(invalid("通知不在回收站，请先移到回收站。"));
    }
    let identity = store.identity();
    Ok(PurgePreview {
        target: PurgeTarget {
            evidence_id: id.into(),
            archive_id: identity.archive_id,
            restore_epoch: identity.restore_epoch,
            blob_sha256: record.blob.meta.sha256.clone(),
        },
        title: record
            .subject
            .filter(|s| !s.trim().is_empty())
            .or(record.original_filename)
            .unwrap_or_else(|| "招聘通知".into()),
        original_shared: store.evidence_for_blob(&record.blob.meta.sha256)?.len() > 1,
    })
}

/// Called while the host holds its archive gate, like application purging and backup.
pub fn purge(store: &ArchiveStore, target: PurgeTarget) -> Result<PurgeResult, CommandError> {
    let identity = store.identity();
    if identity.archive_id != target.archive_id || identity.restore_epoch != target.restore_epoch {
        return Err(invalid("档案已恢复或切换，请关闭弹窗后重新确认删除。"));
    }
    let record = store.purge_recycled_evidence(&target.evidence_id, &target.blob_sha256)?;
    let shared = record.blob.ref_count > 0;
    let mut cleanup_pending = false;
    if !shared {
        // Commit the row deletion first. A failed unlink keeps a zero-reference
        // blob row so Settings → attachment cleanup can find and retry it.
        cleanup_pending = !remove_original(store.archive_dir(), &record.blob.meta.stored_rel_path)
            || store
                .remove_unreferenced_blob(&record.blob.meta.sha256)
                .is_err();
    }
    Ok(PurgeResult {
        original_shared: shared,
        cleanup_pending,
    })
}

fn remove_original(root: &std::path::Path, rel: &str) -> bool {
    use std::path::Component;
    let relative = std::path::Path::new(rel);
    if !relative.starts_with("attachments")
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return false;
    }
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let path = root.join(relative);
    if std::fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return true;
    }
    let Some(parent) = path.parent().and_then(|p| p.canonicalize().ok()) else {
        return false;
    };
    if !parent.starts_with(root.join("attachments")) {
        return false;
    }
    // Unlink the entry itself, never follow a final symlink to its target.
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

#[cfg(test)]
#[path = "evidence_purge_tests.rs"]
mod tests;
