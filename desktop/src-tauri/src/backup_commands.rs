//! D12 命令层：导出、预览、恢复、回滚。
//!
//! 这一层负责一件 `restore.rs` 做不了的事：**在切换之前把现有的 store 关掉，
//! 切换之后把新的装回去。** 唯一写入者只有一个，恢复是它换身份的时刻。
//!
//! 恢复之后插件那边的旧消息不会静默回灌——但那不是这里做的，是 D05/D07 早就
//! 在存储层做好的：`plugin.rs` 的两段校验里，信封 epoch 与 current 不符直接
//! `restore_epoch_mismatch`，旧 epoch 只能走只读对账。这里只需要**不去绕开它**，
//! 并且有一条回归测试盯着「恢复之后拿旧 epoch 提交会被拒」。

use std::path::Path;

use archive_store::{ArchiveCounts, ArchiveStore};
use serde::Serialize;

use crate::commands::CommandError;
use crate::restore::{
    export_archive, list_rollback_points, restore_archive_open, rollback_to_open, RestorePaths,
    RestoreReport, RollbackPoint,
};

/// 回滚点最多留几个（拆分计划 Q3）。超出**只提示不自动删**——自动删会在用户
/// 最需要的时候删掉那一个。
pub const KEEP_ROLLBACK_POINTS: usize = 3;

fn fail(code: &str, message: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.to_string(),
    }
}

/// 恢复前给用户看的对比。**看完点确认才切。**
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub created_at: String,
    pub archive_id: String,
    pub schema_version: i64,
    /// 备份里有多少。
    pub incoming: ArchiveCounts,
    /// 现在有多少。
    pub current: ArchiveCounts,
    /// 现有回滚点的数量，以及是不是已经超过建议上限。
    pub existing_rollback_points: usize,
    pub too_many_rollback_points: bool,
    /// 恢复的是不是同一个档案。不同档案不是错误，但用户该知道——
    /// 那意味着他在用别人的（或者另一台机器上另建的）档案覆盖现在这份。
    pub same_archive: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub size_bytes: u64,
    /// 档案目录里没进包的东西。清单没覆盖的也在这里——它不是错误，但要看得见。
    pub skipped: Vec<String>,
}

pub fn export(
    store: &ArchiveStore,
    paths: &RestorePaths,
    destination: &Path,
    now: &str,
) -> Result<ExportReport, CommandError> {
    let report = export_archive(store, paths, destination, now)?;
    Ok(ExportReport {
        path: report.path.to_string_lossy().to_string(),
        size_bytes: report.size_bytes,
        skipped: report
            .skipped
            .into_iter()
            .map(|(path, reason)| format!("{path}（{reason}）"))
            .collect(),
    })
}

/// 只读清单并和当前档案对比。**不往盘上写任何东西。**
pub fn preview(
    store: &ArchiveStore,
    paths: &RestorePaths,
    package: &Path,
) -> Result<RestorePreview, CommandError> {
    let manifest = backup::read_manifest(package).map_err(|e| fail("BACKUP_ERROR", e))?;
    let current = store.counts().map_err(|e| fail("STORE_ERROR", e))?;
    let points = list_rollback_points(paths)?.len();
    Ok(RestorePreview {
        created_at: manifest.created_at.clone(),
        archive_id: manifest.archive_id.clone(),
        schema_version: manifest.schema_version,
        incoming: ArchiveCounts {
            applications: manifest.counts.applications,
            events: manifest.counts.events,
            snapshots: manifest.counts.snapshots,
            todos: manifest.counts.todos,
            evidence: manifest.counts.evidence,
            attachments: manifest.counts.attachments,
        },
        current,
        existing_rollback_points: points,
        too_many_rollback_points: points >= KEEP_ROLLBACK_POINTS,
        same_archive: manifest.archive_id == store.identity().archive_id,
    })
}

/// 交给 `restore.rs` 的「关掉现有 store」动作。
///
/// 单独拎出来是因为它必须在**校验都过了之后**才发生：store 一关，界面上所有
/// 命令都会开始报「档案不可用」，所以不能为了一个最后会被拒绝的包先把它关掉。
pub struct StoreSlot<'a> {
    pub slot: &'a std::sync::Mutex<Option<ArchiveStore>>,
}

impl StoreSlot<'_> {
    fn close(&self) -> Result<(), CommandError> {
        let mut guard = self
            .slot
            .lock()
            .map_err(|e| fail("STORE_ERROR", format!("store lock poisoned: {e}")))?;
        if let Some(store) = guard.take() {
            store.close().map_err(|e| fail("STORE_ERROR", e))?;
        }
        Ok(())
    }
}

/// One lock order for every archive operation: acquire the shared store slot once,
/// retain it across the switch, install the already-open new store, then release.
/// UI writes, IPC writes, exports and other restores all serialize on this mutex.
/// No network or encryption belongs inside this function.
fn transition(
    slot: &StoreSlot<'_>,
    paths: &RestorePaths,
    operation: impl FnOnce(
        &mut dyn FnMut() -> Result<(), CommandError>,
    ) -> Result<(RestoreReport, ArchiveStore), CommandError>,
) -> Result<RestoreReport, CommandError> {
    let mut guard = slot
        .slot
        .lock()
        .map_err(|_| fail("STORE_ERROR", "store lock poisoned"))?;
    let old_dir = guard
        .as_ref()
        .ok_or_else(|| fail("STORE_UNAVAILABLE", "档案未打开。"))?
        .archive_dir()
        .to_path_buf();
    let old_pointer = std::fs::read(&paths.current_pointer).map_err(|e| fail("IO_ERROR", e))?;
    // Persist recovery bytes before the close/remove/open switch window. A crash
    // there must not make startup mistake this for a first-time empty archive.
    let recovery_pointer = crate::restore::recovery_pointer_path(&paths.current_pointer);
    crate::restore::restore_pointer(&recovery_pointer, &old_pointer)?;
    let outcome = operation(&mut || {
        if let Some(store) = guard.take() {
            store.close().map_err(|e| fail("STORE_ERROR", e))?;
        }
        Ok(())
    });
    match outcome {
        Ok((report, store)) => {
            *guard = Some(store);
            let _ = std::fs::remove_file(&recovery_pointer);
            Ok(report)
        }
        Err(error) => {
            if guard.is_none() {
                let recovery =
                    crate::restore::restore_pointer(&paths.current_pointer, &old_pointer).and_then(
                        |()| crate::commands::open_store(&old_dir, &paths.current_pointer),
                    );
                match recovery {
                    Ok(store) => *guard = Some(store),
                    Err(recovery) => {
                        return Err(fail(
                            "RESTORE_RECOVERY_FAILED",
                            format!(
                                "{}；旧档案重开失败：{}。档案保留在 {}，可重启后重试。",
                                error.message,
                                recovery.message,
                                old_dir.display()
                            ),
                        ))
                    }
                }
            }
            let _ = std::fs::remove_file(&recovery_pointer);
            Err(error)
        }
    }
}

pub fn restore(
    slot: &StoreSlot<'_>,
    paths: &RestorePaths,
    package: &Path,
    now: &str,
) -> Result<RestoreReport, CommandError> {
    transition(slot, paths, |close| {
        restore_archive_open(paths, package, now, close)
    })
}

pub fn rollback(
    slot: &StoreSlot<'_>,
    paths: &RestorePaths,
    id: &str,
    now: &str,
) -> Result<RestoreReport, CommandError> {
    transition(slot, paths, |close| rollback_to_open(paths, id, now, close))
}

pub fn rollback_points(paths: &RestorePaths) -> Result<Vec<RollbackPoint>, CommandError> {
    list_rollback_points(paths)
}

#[cfg(test)]
#[path = "backup_commands_tests.rs"]
mod tests;
