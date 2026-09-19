//! D12 的编排：导出、恢复、切换、回滚。
//!
//! 整个模块围绕一句话写：**切换之前，现有档案一个字节都不动。**
//!
//! 顺序是固定的，而且每一步失败的后果都要想清楚：
//!
//! 1. 解到 `archives-staging/<uuid>/` 并逐项校验（`backup` crate 干的）
//! 2. 用 staging 自己的指针打开一次库，让迁移跑一遍——**演练**。这一步能挡住
//!    「包本身完好但库版本我们处理不了」的情况，而且它发生在切换之前。
//! 3. 把 staging 挪到 `archive-<uuid>/`，**移开旧的 `current.json`**，再打开新档案
//! 4. 旧档案目录挪进 `archives-retired/<时间戳>/`，成为回滚点
//!
//! 第 3 步里为什么是「移开指针」而不是「改写指针」：`ArchiveStore::open` 在指针
//! 指向另一个目录时会直接拒绝（那道拦截本来就是为了防止有人拿错档案），而指针
//! **缺失**时它会新铸一个 restoreEpoch 并把指针写好——那正是「一次切换」的定义
//! （identity.rs 的契约：首次建库、恢复、回滚都新铸）。所以这里不需要另外调
//! `rotate_restore_epoch()`，open 自己就是那一步；调两次只会白铸一个用不上的 epoch。
//!
//! 移开指针到打开成功之间有一个窗口。窗口里失败的话，**旧指针原样写回去**，
//! 旧档案目录还在原地（还没退休），于是回到出发点。第 3 步之后崩溃：指针已经
//! 指向新档案，下次启动打开的就是它，旧目录也还在，仍然可以手工回滚。

use std::path::{Path, PathBuf};

use archive_store::{ArchiveConfig, ArchiveCounts, ArchiveStore};
use backup::{
    exclude::portable_settings, extract_to_staging, write_archive, ArchiveSource, WriteReport,
};
use serde::Serialize;

use crate::commands::CommandError;

fn fail(code: &str, message: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub archive_dir: String,
    /// 新铸的 epoch。同一个备份恢复两次必须得到两个不同的值。
    pub restore_epoch: String,
    pub rollback_point: String,
    /// 清掉了多少条待办的提醒记账。
    pub reminders_cleared: usize,
    pub counts: ArchiveCounts,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RollbackPoint {
    /// 目录名，也是回滚时的标识。
    pub id: String,
    pub retired_at: String,
}

/// 布局里 D12 要用到的几个位置。
pub struct RestorePaths {
    pub data_root: PathBuf,
    pub archive_dir: PathBuf,
    pub current_pointer: PathBuf,
    pub archives_retired_dir: PathBuf,
    pub settings_file: PathBuf,
}

impl RestorePaths {
    fn staging_root(&self) -> PathBuf {
        self.data_root.join("archives-staging")
    }
}

// --- 导出 ---------------------------------------------------------------------------------

pub fn export_archive(
    store: &ArchiveStore,
    paths: &RestorePaths,
    destination: &Path,
    now: &str,
) -> Result<WriteReport, CommandError> {
    let staging = paths.staging_root();
    std::fs::create_dir_all(&staging).map_err(|e| fail("IO_ERROR", e))?;
    let snapshot = staging.join(format!("snapshot-{}.db", uuid::Uuid::new_v4()));

    // 一致性快照。拷正在被写的 archive.db 拿到的可能是半个事务。
    store
        .snapshot_database_to(&snapshot)
        .map_err(|e| fail("STORE_ERROR", e))?;

    let result = (|| {
        let inventory = ArchiveStore::backup_inventory_from_snapshot(&snapshot)
            .map_err(|e| fail("STORE_ERROR", e))?;
        let counts = to_backup_counts(&inventory.counts);
        let settings_json = std::fs::read_to_string(&paths.settings_file)
            .ok()
            .and_then(|raw| portable_settings(&raw));
        let source = ArchiveSource {
            archive_dir: &paths.archive_dir,
            database_snapshot: &snapshot,
            archive_id: store.identity().archive_id,
            schema_version: store.schema_version(),
            counts,
            referenced_paths: inventory.referenced_paths,
            settings_json,
            created_at: now.to_string(),
        };
        write_archive(&source, destination).map_err(|e| fail("BACKUP_ERROR", e))
    })();

    // 快照是中间产物，成败都不留。
    let _ = std::fs::remove_file(&snapshot);
    result
}

// --- 恢复 ---------------------------------------------------------------------------------

/// 两个 crate 各有一份计数类型：`backup` 不该依赖档案库，档案库也不该依赖
/// 归档格式。这两个小转换就是那条界线的价格，值。
fn to_backup_counts(counts: &ArchiveCounts) -> backup::ArchiveCounts {
    backup::ArchiveCounts {
        applications: counts.applications,
        events: counts.events,
        snapshots: counts.snapshots,
        todos: counts.todos,
        evidence: counts.evidence,
        attachments: counts.attachments,
    }
}

/// 用户确认之后真的恢复。
///
/// `close_current` 是调用方交回来的「把现有 store 关掉」的动作——切换之前必须
/// 先松开对旧库的文件锁，否则 Windows 上挪不动那个目录。
pub fn restore_archive(
    paths: &RestorePaths,
    package: &Path,
    now: &str,
    close_current: impl FnOnce() -> Result<(), CommandError>,
) -> Result<RestoreReport, CommandError> {
    let staging_root = paths.staging_root();
    std::fs::create_dir_all(&staging_root).map_err(|e| fail("IO_ERROR", e))?;
    let staging = staging_root.join(uuid::Uuid::new_v4().to_string());

    // 1. 解压 + 逐项校验。失败时 backup crate 自己把 staging 删干净。
    extract_to_staging(package, &staging).map_err(|e| fail("BACKUP_ERROR", e))?;
    let staged_archive = staging.join("archive");
    if !staged_archive.join("archive.db").exists() {
        cleanup(&staging);
        return Err(fail("BACKUP_ERROR", "备份里没有数据库。"));
    }

    // 2. 迁移演练：用 staging 自己的指针打开一次。库版本我们处理不了的话，
    //    要在切换之前就知道。
    let rehearsal_pointer = staging.join("current.json");
    match ArchiveStore::open(ArchiveConfig::new(
        staged_archive.clone(),
        rehearsal_pointer.clone(),
    )) {
        Ok(store) => {
            let _ = store.close();
        }
        Err(e) => {
            cleanup(&staging);
            return Err(fail("BACKUP_ERROR", format!("备份里的档案打不开：{e}")));
        }
    }
    // 演练用的指针不能跟着进档案目录——current.json 是机器本地的东西。
    let _ = std::fs::remove_file(&rehearsal_pointer);

    // 3. 松开旧库，把 staging 挪成一个正式档案目录，然后切换。
    //    切换之前先记下现在生效的是哪个目录——切完指针就问不出来了。
    let previous = live_archive_dir(paths).or_else(|| {
        paths
            .archive_dir
            .exists()
            .then(|| paths.archive_dir.clone())
    });
    close_current()?;
    let restored_dir = paths
        .data_root
        .join(format!("archive-{}", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::rename(&staged_archive, &restored_dir) {
        cleanup(&staging);
        return Err(fail("IO_ERROR", format!("无法启用恢复出来的档案：{e}")));
    }
    cleanup(&staging);

    let outcome = switch_to(paths, &restored_dir);

    match outcome {
        Ok((identity, reminders_cleared, counts)) => {
            // 4. 旧档案退休成回滚点。这一步失败不影响恢复本身——指针已经指向
            //    新档案，旧目录留在原地也还在，只是没进退休目录。
            let rollback_point = retire(paths, previous, now)
                .unwrap_or_else(|_| "（旧档案未能移入回滚目录）".into());
            Ok(RestoreReport {
                archive_dir: restored_dir.to_string_lossy().to_string(),
                restore_epoch: identity.restore_epoch,
                rollback_point,
                reminders_cleared,
                counts,
            })
        }
        Err(e) => {
            // 切换窗口里失败：把恢复出来的目录收掉，旧档案还在原地、旧指针已经
            // 写回去了（switch_to 负责），于是回到出发点。
            let _ = std::fs::remove_dir_all(&restored_dir);
            Err(e)
        }
    }
}

/// 把 current 指针切到 `target`，并做恢复后必须做的两件事。
///
/// 「切换」的实现是**移开旧指针再打开**：`open` 在指针缺失时新铸 epoch 并写好
/// 指针，那就是 identity.rs 契约里说的那一次新铸。中途失败会把旧指针原样写回。
fn switch_to(
    paths: &RestorePaths,
    target: &Path,
) -> Result<(archive_store::ArchiveIdentity, usize, ArchiveCounts), CommandError> {
    let previous_pointer = std::fs::read(&paths.current_pointer).ok();
    let restore_pointer = || {
        if let Some(bytes) = &previous_pointer {
            let _ = std::fs::write(&paths.current_pointer, bytes);
        }
    };
    let _ = std::fs::remove_file(&paths.current_pointer);

    let store = match ArchiveStore::open(ArchiveConfig::new(
        target.to_path_buf(),
        paths.current_pointer.clone(),
    )) {
        Ok(store) => store,
        Err(e) => {
            restore_pointer();
            return Err(fail("STORE_ERROR", format!("恢复出来的档案打不开：{e}")));
        }
    };

    let identity = store.identity();

    // 提醒记账清零：句柄指向的是原来那台机器上的 OS 计划。
    let cleared = match store.clear_todo_reminders() {
        Ok(cleared) => cleared,
        Err(e) => {
            let _ = store.close();
            restore_pointer();
            return Err(fail("STORE_ERROR", e));
        }
    };
    let counts = match store.counts() {
        Ok(counts) => counts,
        Err(e) => {
            let _ = store.close();
            restore_pointer();
            return Err(fail("STORE_ERROR", e));
        }
    };
    let _ = store.close();
    Ok((identity, cleared, counts))
}

fn cleanup(staging: &Path) {
    let _ = std::fs::remove_dir_all(staging);
}

/// 现在生效的那个档案目录。
///
/// **不能想当然地认为它就是 `<data_root>/archive`**：第一次恢复之后，生效的是
/// `archive-<uuid>`，固定路径那个已经退休了。退休哪一个要看指针说的是哪一个。
fn live_archive_dir(paths: &RestorePaths) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(&paths.current_pointer).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let dir = parsed.get("archive_dir")?.as_str()?;
    let path = PathBuf::from(dir);
    path.exists().then_some(path)
}

fn retire(
    paths: &RestorePaths,
    previous: Option<PathBuf>,
    now: &str,
) -> Result<String, std::io::Error> {
    let Some(previous) = previous else {
        return Ok("（没有旧档案）".into());
    };
    if !previous.exists() {
        return Ok("（没有旧档案）".into());
    }
    std::fs::create_dir_all(&paths.archives_retired_dir)?;
    let name = format!("{}-{}", sanitize_stamp(now), uuid::Uuid::new_v4());
    std::fs::rename(&previous, paths.archives_retired_dir.join(&name))?;
    Ok(name)
}

/// 时间戳进目录名之前把 `:` 这类字符去掉——Windows 上带冒号的目录名建不出来。
fn sanitize_stamp(now: &str) -> String {
    now.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

// --- 回滚 ---------------------------------------------------------------------------------

pub fn list_rollback_points(paths: &RestorePaths) -> Result<Vec<RollbackPoint>, CommandError> {
    let dir = &paths.archives_retired_dir;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut points = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| fail("IO_ERROR", e))? {
        let entry = entry.map_err(|e| fail("IO_ERROR", e))?;
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let retired_at = id.split('-').take(3).collect::<Vec<_>>().join("-");
        points.push(RollbackPoint { id, retired_at });
    }
    points.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(points)
}

/// 回滚到某个退休目录。
///
/// 回滚**也是一次新切换**：再铸一个 epoch（#28 的 D01 修订原话）。当前档案跟着
/// 退休成新的回滚点，所以回滚本身也是可逆的。
pub fn rollback_to(
    paths: &RestorePaths,
    id: &str,
    now: &str,
    close_current: impl FnOnce() -> Result<(), CommandError>,
) -> Result<RestoreReport, CommandError> {
    // id 是从我们自己的目录列表里来的，但它经过了 WebView 一圈，当外部输入看。
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(fail("VALIDATION", "回滚点标识不合法。"));
    }
    let source = paths.archives_retired_dir.join(id);
    if !source.join("archive.db").exists() {
        return Err(fail("NOT_FOUND", "这个回滚点里没有档案。"));
    }

    let previous = live_archive_dir(paths).or_else(|| {
        paths
            .archive_dir
            .exists()
            .then(|| paths.archive_dir.clone())
    });
    close_current()?;
    let restored_dir = paths
        .data_root
        .join(format!("archive-{}", uuid::Uuid::new_v4()));
    std::fs::rename(&source, &restored_dir).map_err(|e| fail("IO_ERROR", e))?;

    let (identity, reminders_cleared, counts) = match switch_to(paths, &restored_dir) {
        Ok(result) => result,
        Err(e) => {
            // 挪回退休目录，回滚点没了才是真的糟糕。
            let _ = std::fs::rename(&restored_dir, &source);
            return Err(e);
        }
    };

    let rollback_point =
        retire(paths, previous, now).unwrap_or_else(|_| "（旧档案未能移入回滚目录）".into());

    Ok(RestoreReport {
        archive_dir: restored_dir.to_string_lossy().to_string(),
        restore_epoch: identity.restore_epoch,
        rollback_point,
        reminders_cleared,
        counts,
    })
}

#[cfg(test)]
#[path = "restore_tests.rs"]
mod tests;
