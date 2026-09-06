//! Schema 版本管理与迁移机制。
//!
//! 契约(issue #18 验收):
//! - 迁移前自动备份;备份文件落在档案目录 `backups/` 下。
//! - 迁移在单个事务内执行;失败回滚,不破坏原库,并提供备份恢复入口。
//! - 迁移记录写入 `schema_migrations`。

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;

use crate::error::StoreError;
use crate::schema::{Migration, SCHEMA_VERSION};
use crate::timeutil::now_utc;

pub use crate::schema::MIGRATIONS;

/// 读取 PRAGMA user_version。
fn user_version(conn: &Connection) -> Result<i64, StoreError> {
    conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
        .map_err(StoreError::from)
}

fn set_user_version(conn: &Connection, v: i64) -> Result<(), StoreError> {
    conn.pragma_update(None, "user_version", v)
        .map_err(StoreError::from)
}

/// 迁移前备份:用 SQLite backup API 产生一致性快照。
/// 返回备份文件路径。
pub fn backup_database(
    conn: &Connection,
    backup_dir: &Path,
    db_name: &str,
    from_version: i64,
) -> Result<PathBuf, StoreError> {
    std::fs::create_dir_all(backup_dir)?;
    if !db_name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(StoreError::Validation("unsafe backup name".into()));
    }
    let ts = uuid::Uuid::new_v4().to_string();
    let path = backup_dir.join(format!("{db_name}.pre-migration-v{from_version}-{ts}.db"));
    let mut dst = Connection::open(&path)?;
    use rusqlite::backup::Backup;
    Backup::new(conn, &mut dst)?.run_to_completion(64, Duration::from_millis(2), None)?;
    dst.close().map_err(|(_, e)| e)?;
    Ok(path)
}

/// 打开时调用:建库(全新)或按需迁移(旧版本)。
///
/// 返回 (最终版本, 本次迁移前备份路径 Option)。
pub fn ensure_schema(
    conn: &mut Connection,
    migrations: &[Migration],
    backup_dir: &Path,
    db_name: &str,
) -> Result<(i64, Option<PathBuf>), StoreError> {
    // 校验迁移链连续且以 1 开始。
    let mut expected = 1;
    for m in migrations {
        if m.to_version != expected {
            return Err(StoreError::Validation(format!(
                "migration chain broken: expected to_version {expected}, got {}",
                m.to_version
            )));
        }
        expected += 1;
    }
    let latest = migrations.len() as i64;

    let current = user_version(conn)?;
    if latest == 0 || current > latest {
        return Err(StoreError::Validation(
            "empty migration chain or unsupported newer database".into(),
        ));
    }
    if current == latest {
        return Ok((latest, None));
    }
    let tables: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        |r| r.get(0),
    )?;
    if current == 0 && tables != 0 {
        return Err(StoreError::Validation(
            "unversioned existing database requires explicit recovery".into(),
        ));
    }
    let backup = if current > 0 {
        Some(backup_database(conn, backup_dir, db_name, current)?)
    } else {
        None
    };
    // All pending steps, migration ledger and user_version share one commit.
    let tx = conn.transaction()?;
    for m in migrations.iter().skip(current as usize) {
        if let Err(e) = tx.execute_batch(m.sql).and_then(|_| {
            tx.execute("INSERT INTO schema_migrations (version, description, applied_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![m.to_version, m.description, now_utc()])
        }) {
            return Err(StoreError::MigrationFailed { version: m.to_version, backup,
                source: Box::new(crate::error::anyhow_no_source::Wrapped(e.to_string())) });
        }
    }
    set_user_version(&tx, latest)?;
    tx.execute(
        "UPDATE archive_meta SET schema_version = ?1 WHERE id = 1",
        [latest],
    )?;
    tx.commit()?;
    Ok((latest, backup))
}

/// SCHEMA_VERSION 的访问器(公开给调用方诊断)。
pub fn current_schema_version() -> i64 {
    SCHEMA_VERSION
}
