//! ArchiveStore:入口类型。路径由调用方(D02 `HostPaths`)注入,
//! 不硬编码用户目录,不创建第二个写入进程。
//!
//! 一个 `ArchiveStore` 对应一个档案目录(`archive.db` + `meta.json`)与一个
//! 机器本地 current 指针。所有写操作走单一连接(唯一写入者语义,WAL)。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::error::StoreError;
use crate::identity::{
    is_uuid, new_uuid, read_meta_file, read_pointer, write_meta_file, write_pointer, ArchiveIdentity,
    ArchiveMetaFile, CurrentPointer,
};
use crate::migration::ensure_schema;
use crate::schema::{MIGRATIONS, SCHEMA_VERSION};
use crate::timeutil::now_utc;
use crate::tx::StoreTx;

/// 打开配置。两个字段都由宿主注入:
/// - `archive_dir`:D02 `HostPaths::archive_dir`,内含 `archive.db` / `meta.json` / `backups/`。
/// - `current_pointer`:D02 `HostPaths::current_pointer`(通常 `<data_root>/current.json`)。
#[derive(Debug, Clone)]
pub struct ArchiveConfig {
    pub archive_dir: PathBuf,
    pub current_pointer: PathBuf,
}

impl ArchiveConfig {
    pub fn new(archive_dir: impl Into<PathBuf>, current_pointer: impl Into<PathBuf>) -> Self {
        Self { archive_dir: archive_dir.into(), current_pointer: current_pointer.into() }
    }

    pub fn db_path(&self) -> PathBuf {
        self.archive_dir.join("archive.db")
    }
    pub fn meta_path(&self) -> PathBuf {
        self.archive_dir.join("meta.json")
    }
    pub fn backup_dir(&self) -> PathBuf {
        self.archive_dir.join("backups")
    }
}

pub struct ArchiveStore {
    conn: Mutex<Connection>,
    cfg: ArchiveConfig,
    identity: Mutex<ArchiveIdentity>,
    schema_version: i64,
    /// 打开时若发生迁移,记录本次迁移前的自动备份路径(供诊断/恢复入口)。
    pub migration_backup: Option<PathBuf>,
}

impl ArchiveStore {
    /// 打开(或首次创建)档案。首次创建会:
    /// 1. 生成 archiveId 并写 meta.json;
    /// 2. 应用全部迁移(建表);
    /// 3. 新铸 restoreEpoch 并原子写 current.json。
    ///
    /// 重复打开:读取既有 meta.json 与指针,校验一致性,不重铸 epoch。
    pub fn open(cfg: ArchiveConfig) -> Result<ArchiveStore, StoreError> {
        Self::open_with_migrations(cfg, MIGRATIONS)
    }

    /// 同 [open],但迁移链可注入(测试与 D12 迁移验证使用)。
    pub fn open_with_migrations(
        cfg: ArchiveConfig,
        migrations: &[crate::schema::Migration],
    ) -> Result<ArchiveStore, StoreError> {
        std::fs::create_dir_all(&cfg.archive_dir)?;

        let mut conn = Connection::open(cfg.db_path())?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;

        let (schema_version, migration_backup) =
            ensure_schema(&mut conn, migrations, &cfg.backup_dir(), "archive")?;

        // 档案身份:meta.json 为档案目录的权威;库内 archive_meta 需一致。
        let meta = match read_meta_file(&cfg.meta_path())? {
            Some(meta) => meta,
            None => {
                let meta = ArchiveMetaFile {
                    archive_id: new_uuid(),
                    schema_version,
                    created_at: now_utc(),
                    display_name: None,
                };
                write_meta_file(&cfg.meta_path(), &meta)?;
                meta
            }
        };
        if !is_uuid(&meta.archive_id) {
            return Err(StoreError::Validation(format!(
                "meta.json archiveId is not a UUID: {}",
                meta.archive_id
            )));
        }

        let tx = conn.transaction()?;
        let db_archive_id: Option<String> = tx
            .query_row("SELECT archive_id FROM archive_meta WHERE id = 1", [], |r| r.get(0))
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        match db_archive_id {
            None => {
                tx.execute(
                    "INSERT INTO archive_meta (id, archive_id, schema_version, created_at, display_name) VALUES (1, ?1, ?2, ?3, ?4)",
                    rusqlite::params![meta.archive_id, schema_version, meta.created_at, meta.display_name],
                )?;
                tx.commit()?;
            }
            Some(db_id) => {
                tx.commit()?;
                if db_id != meta.archive_id {
                    return Err(StoreError::ArchiveIdentityMismatch {
                        meta: meta.archive_id,
                        db: db_id,
                    });
                }
            }
        }

        // current 指针:不存在则新铸 epoch(首次建库);存在则校验 archiveId 一致。
        let identity = match read_pointer(&cfg.current_pointer)? {
            Some(pointer) => {
                if pointer.archive_id != meta.archive_id {
                    return Err(StoreError::PointerMismatch {
                        pointer: pointer.archive_id,
                        here: meta.archive_id,
                    });
                }
                if !is_uuid(&pointer.restore_epoch) {
                    return Err(StoreError::Validation(
                        "current.json restoreEpoch is not a UUID".into(),
                    ));
                }
                ArchiveIdentity {
                    archive_id: pointer.archive_id,
                    restore_epoch: pointer.restore_epoch,
                }
            }
            None => {
                let identity = ArchiveIdentity::mint(meta.archive_id.clone());
                write_pointer(
                    &cfg.current_pointer,
                    &CurrentPointer {
                        archive_dir: display_dir(&cfg.archive_dir),
                        archive_id: identity.archive_id.clone(),
                        restore_epoch: identity.restore_epoch.clone(),
                    },
                )?;
                identity
            }
        };

        Ok(ArchiveStore {
            conn: Mutex::new(conn),
            cfg,
            identity: Mutex::new(identity),
            schema_version,
            migration_backup,
        })
    }

    /// 当前档案身份(archiveId + 当前 restoreEpoch)。握手应答使用。
    pub fn identity(&self) -> ArchiveIdentity {
        self.identity.lock().expect("identity lock").clone()
    }

    pub fn schema_version(&self) -> i64 {
        self.schema_version
    }

    pub fn config(&self) -> &ArchiveConfig {
        &self.cfg
    }

    pub fn archive_dir(&self) -> &Path {
        &self.cfg.archive_dir
    }

    /// current 指针文件路径。
    pub fn pointer_path(&self) -> &Path {
        &self.cfg.current_pointer
    }

    /// 恢复/回滚流程(D12)在成功切换档案目录后调用:新铸 restoreEpoch
    /// 并原子更新 current.json。archiveId 不变(保留 backup 的值)。
    pub fn rotate_restore_epoch(&self) -> Result<ArchiveIdentity, StoreError> {
        let mut guard = self.identity.lock().expect("identity lock");
        guard.restore_epoch = new_uuid();
        write_pointer(
            &self.cfg.current_pointer,
            &CurrentPointer {
                archive_dir: display_dir(&self.cfg.archive_dir),
                archive_id: guard.archive_id.clone(),
                restore_epoch: guard.restore_epoch.clone(),
            },
        )?;
        Ok(guard.clone())
    }

    /// 事务接口:闭包内通过 [StoreTx] 执行多个操作,同提交同回滚。
    /// 闭包返回 Err 时整体回滚,不留半成品。
    ///
    /// 注意:闭包内不得再调用 `&self` 的便捷方法(会重入连接锁)。
    pub fn transaction<F, T>(&self, f: F) -> Result<T, StoreError>
    where
        F: FnOnce(&mut StoreTx<'_>) -> Result<T, StoreError>,
    {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut store_tx = StoreTx::new(tx, self.identity.lock().expect("identity lock").archive_id.clone());
        match f(&mut store_tx) {
            Ok(value) => {
                store_tx.commit()?;
                Ok(value)
            }
            Err(e) => {
                store_tx.rollback()?;
                Err(e)
            }
        }
    }

    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().expect("archive connection lock")
    }

    /// 关闭:checkpoint WAL,随后随结构体析构释放连接。
    /// 重新打开读到的数据即为此刻状态(持久化闭环的验证点)。
    pub fn close(self) -> Result<(), StoreError> {
        let mut guard = self.conn.lock().expect("archive connection lock");
        let _ = guard.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get::<_, i64>(0));
        Ok(())
    }
}

fn display_dir(p: &Path) -> String {
    p.to_string_lossy().to_string()
}
