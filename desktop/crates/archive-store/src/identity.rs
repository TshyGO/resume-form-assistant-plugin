//! 档案身份:`meta.json`(随档案目录,含 archiveId)与 `current.json`
//! (机器本地指针,含当前 restoreEpoch,**不进备份**)。
//!
//! 契约(data-privacy §6.5、§8.1):
//! - 每次成功切换 current 指针(首次建库、恢复、回滚)新铸 restoreEpoch UUID。
//! - restoreEpoch 不从备份拷贝、不用 generation+1。
//! - 指针写入必须原子(tmp + rename)。

use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::StoreError;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ArchiveIdentity {
    pub archive_id: String,
    pub restore_epoch: String,
}

impl ArchiveIdentity {
    pub fn mint(archive_id: String) -> Self {
        Self { archive_id, restore_epoch: Uuid::new_v4().to_string() }
    }
}

/// archive 目录内的 meta.json(不含 restoreEpoch)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveMetaFile {
    pub archive_id: String,
    pub schema_version: i64,
    pub created_at: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

/// 机器本地 current.json。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentPointer {
    pub archive_dir: String,
    pub archive_id: String,
    pub restore_epoch: String,
}

pub(crate) fn new_uuid() -> String {
    Uuid::new_v4().to_string()
}

pub(crate) fn is_uuid(s: &str) -> bool {
    Uuid::parse_str(s).is_ok()
}

/// 原子写 JSON:写临时文件后 rename 覆盖。
pub(crate) fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StoreError> {
    let dir = path.parent().ok_or_else(|| StoreError::Validation(format!("path has no parent: {}", path.display())))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
        Uuid::new_v4()
    ));
    let json = serde_json::to_string_pretty(value)?;
    std::fs::write(&tmp, json)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e.into())
        }
    }
}

pub(crate) fn read_meta_file(path: &Path) -> Result<Option<ArchiveMetaFile>, StoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read(path)?;
    serde_json::from_slice(&raw).map(Some).map_err(StoreError::from)
}

pub(crate) fn write_meta_file(path: &Path, meta: &ArchiveMetaFile) -> Result<(), StoreError> {
    atomic_write_json(path, meta)
}

pub(crate) fn read_pointer(path: &Path) -> Result<Option<CurrentPointer>, StoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read(path)?;
    serde_json::from_slice(&raw).map(Some).map_err(StoreError::from)
}

pub(crate) fn write_pointer(path: &Path, pointer: &CurrentPointer) -> Result<(), StoreError> {
    atomic_write_json(path, pointer)
}
