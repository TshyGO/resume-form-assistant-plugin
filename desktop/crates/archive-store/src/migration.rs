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
    conn.pragma_update(None, "user_version", v).map_err(StoreError::from)
}

/// 迁移前备份:用 SQLite backup API 产生一致性快照。
/// 返回备份文件路径。
pub fn backup_database(conn: &Connection, backup_dir: &Path, db_name: &str, from_version: i64) -> Result<PathBuf, StoreError> {
    std::fs::create_dir_all(backup_dir)?;
    let ts = now_utc().replace([':', '-'], "");
    let path = backup_dir.join(format!("{db_name}.pre-migration-v{from_version}-{ts}.db"));
    let mut dst = Connection::open(&path)?;
    use rusqlite::backup::Backup;
    Backup::new(conn, &mut dst)?
        .run_to_completion(64, Duration::from_millis(2), None)?;
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
    if current == 0 {
        // 全新库:一次性应用全部迁移(对 v1 即初始 schema)。
        let tx = conn.transaction()?;
        for m in migrations {
            tx.execute_batch(m.sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![m.to_version, m.description, now_utc()],
            )?;
        }
        tx.commit()?;
        set_user_version(conn, latest)?;
        return Ok((latest, None));
    }

    if current > latest {
        return Err(StoreError::Validation(format!(
            "database schema v{current} is newer than supported v{latest}; downgrade is not supported"
        )));
    }

    if current == latest {
        return Ok((latest, None));
    }

    // 需要迁移:先自动备份。
    let backup_path = backup_database(conn, backup_dir, db_name, current)?;

    // 逐版本迁移;每步一个事务。失败即回滚该步,原库停在旧版本且未被破坏。
    for m in migrations.iter().skip(current as usize) {
        let tx = conn.transaction()?;
        let result = tx
            .execute_batch(m.sql)
            .and_then(|_| {
                tx.execute(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![m.to_version, m.description, now_utc()],
                )
            });
        match result {
            Ok(_) => {
                tx.commit()?;
                set_user_version(conn, m.to_version)?;
            }
            Err(e) => {
                // tx drop 即回滚;显式提交从未发生。
                drop(tx);
                return Err(StoreError::MigrationFailed {
                    version: m.to_version,
                    backup: Some(backup_path),
                    source: Box::new(crate::error::anyhow_no_source::Wrapped(e.to_string())),
                });
            }
        }
    }

    Ok((latest, Some(backup_path)))
}

/// SCHEMA_VERSION 的访问器(公开给调用方诊断)。
pub fn current_schema_version() -> i64 {
    SCHEMA_VERSION
}

#[cfg(test)]
pub(crate) fn test_migrations_with_v2() -> Vec<Migration> {
    let mut v: Vec<Migration> = MIGRATIONS.to_vec();
    v.push(Migration {
        to_version: 2,
        description: "test-only: add archive_meta.note column",
        sql: "ALTER TABLE archive_meta ADD COLUMN note TEXT;",
    });
    v
}

#[cfg(test)]
pub(crate) fn test_migrations_with_failing_v2() -> Vec<Migration> {
    let mut v: Vec<Migration> = MIGRATIONS.to_vec();
    v.push(Migration {
        to_version: 2,
        description: "test-only: intentionally broken migration",
        sql: "CREATE TABLE this_is_fine (id INTEGER); THIS IS NOT SQL;",
    });
    v
}
