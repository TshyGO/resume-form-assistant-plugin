use crate::error::HostError;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// On-disk product folder name (not the UI product name).
pub const DATA_DIR_NAME: &str = "ResumePro";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPaths {
    pub data_root: PathBuf,
    pub archive_dir: PathBuf,
    pub attachments_dir: PathBuf,
    pub snapshots_dir: PathBuf,
    pub tmp_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub current_pointer: PathBuf,
    pub archives_retired_dir: PathBuf,
    pub lock_file: PathBuf,
    pub settings_file: PathBuf,
}

impl HostPaths {
    pub fn resolve() -> Result<Self, HostError> {
        let data_override = std::env::var_os("RESUMEPRO_DATA_DIR").map(PathBuf::from);
        let cache_override = std::env::var_os("RESUMEPRO_CACHE_DIR").map(PathBuf::from);
        Self::resolve_with(data_override, cache_override)
    }

    pub fn resolve_with(
        data_override: Option<PathBuf>,
        cache_override: Option<PathBuf>,
    ) -> Result<Self, HostError> {
        let data_root = match data_override {
            Some(p) => validate_override(p, "RESUMEPRO_DATA_DIR")?,
            None => default_data_root()?,
        };
        let cache_dir = match cache_override {
            Some(p) => validate_override(p, "RESUMEPRO_CACHE_DIR")?,
            None => default_cache_dir(&data_root)?,
        };
        Ok(Self::from_roots(data_root, cache_dir))
    }

    pub fn from_roots(data_root: PathBuf, cache_dir: PathBuf) -> Self {
        let archive_dir = data_root.join("archive");
        Self {
            attachments_dir: archive_dir.join("attachments"),
            snapshots_dir: archive_dir.join("snapshots"),
            tmp_dir: archive_dir.join("tmp"),
            logs_dir: data_root.join("logs"),
            current_pointer: data_root.join("current.json"),
            archives_retired_dir: data_root.join("archives-retired"),
            lock_file: data_root.join("host.lock"),
            settings_file: data_root.join("settings.json"),
            archive_dir,
            cache_dir,
            data_root,
        }
    }

    pub fn layout_dirs(&self) -> [&Path; 8] {
        [
            self.data_root.as_path(),
            self.archive_dir.as_path(),
            self.attachments_dir.as_path(),
            self.snapshots_dir.as_path(),
            self.tmp_dir.as_path(),
            self.logs_dir.as_path(),
            self.cache_dir.as_path(),
            self.archives_retired_dir.as_path(),
        ]
    }

    /// Create the D02 directory layout. Does not create `archive.db` or write `current.json`.
    pub fn ensure_layout(&self) -> Result<(), HostError> {
        for dir in self.layout_dirs() {
            fs::create_dir_all(dir).map_err(|e| {
                HostError::dir_create_failed(dir.to_path_buf(), format!("create_dir_all failed: {e}"))
            })?;
        }
        self.assert_writable()?;
        Ok(())
    }

    pub fn assert_writable(&self) -> Result<(), HostError> {
        for dir in [self.data_root.as_path(), self.logs_dir.as_path(), self.archive_dir.as_path()]
        {
            assert_dir_writable(dir)?;
        }
        Ok(())
    }
}

fn validate_override(path: PathBuf, name: &str) -> Result<PathBuf, HostError> {
    if path.as_os_str().is_empty() {
        return Err(HostError::path_invalid(format!("{name} is empty")));
    }
    if !path.is_absolute() {
        return Err(HostError::path_invalid(format!(
            "{name} must be an absolute path, got {}",
            path.display()
        )));
    }
    Ok(path)
}

fn default_data_root() -> Result<PathBuf, HostError> {
    let base = platform_data_base()?;
    Ok(base.join(DATA_DIR_NAME))
}

fn default_cache_dir(data_root: &Path) -> Result<PathBuf, HostError> {
    if cfg!(target_os = "macos") {
        dirs::cache_dir()
            .map(|p| p.join(DATA_DIR_NAME))
            .ok_or_else(|| {
                HostError::path_invalid("NSCachesDirectory / cache_dir is unavailable")
            })
    } else {
        Ok(data_root.join("cache"))
    }
}

fn platform_data_base() -> Result<PathBuf, HostError> {
    if cfg!(windows) {
        dirs::data_local_dir().ok_or_else(|| {
            HostError::path_invalid("FOLDERID_LocalAppData / data_local_dir is unavailable")
        })
    } else if cfg!(target_os = "macos") {
        dirs::data_dir().ok_or_else(|| {
            HostError::path_invalid("NSApplicationSupportDirectory / data_dir is unavailable")
        })
    } else {
        dirs::data_local_dir()
            .ok_or_else(|| HostError::path_invalid("XDG data directory is unavailable"))
    }
}

fn assert_dir_writable(dir: &Path) -> Result<(), HostError> {
    if dir.exists() && !dir.is_dir() {
        return Err(HostError::dir_not_writable(
            dir.to_path_buf(),
            "path exists and is not a directory",
        ));
    }
    let probe = dir.join(".resumepro-write-test");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(HostError::dir_not_writable(
            dir.to_path_buf(),
            format!("write test failed: {e}"),
        )),
    }
}

pub fn program_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn default_root_uses_os_api_and_product_name() {
        let paths = HostPaths::resolve_with(None, None).unwrap();
        assert!(paths.data_root.ends_with(DATA_DIR_NAME));
        let rendered = paths.data_root.to_string_lossy();
        assert!(
            !rendered.contains("Antigravity_Workshop"),
            "data root must not be the program/repo directory: {rendered}"
        );
        assert!(!rendered.contains("PeterYan\\resume-pro"));
        if let Some(exe_dir) = program_dir() {
            assert_ne!(paths.data_root, exe_dir);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_local_appdata_not_roaming() {
        let paths = HostPaths::resolve_with(None, None).unwrap();
        let rendered = paths.data_root.to_string_lossy();
        assert!(
            rendered.contains(r"AppData\Local\ResumePro"),
            "expected LocalAppData product dir, got {rendered}"
        );
        assert_eq!(paths.cache_dir, paths.data_root.join("cache"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_uses_application_support_and_caches() {
        let paths = HostPaths::resolve_with(None, None).unwrap();
        let data = paths.data_root.to_string_lossy();
        let cache = paths.cache_dir.to_string_lossy();
        assert!(
            data.contains("Application Support/ResumePro") || data.contains("Application Support/ResumePro/"),
            "expected Application Support product dir, got {data}"
        );
        assert!(
            cache.contains("Caches/ResumePro"),
            "expected Caches product dir, got {cache}"
        );
        assert_ne!(paths.cache_dir, paths.data_root.join("cache"));
    }

    #[test]
    fn override_rejects_relative_path() {
        let err = HostPaths::resolve_with(Some(PathBuf::from("relative/dir")), None).unwrap_err();
        assert_eq!(err.code(), crate::error::PATH_INVALID);
    }

    #[test]
    fn chinese_and_spaces_override_is_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("用户 数据").join("Resume Pro Data");
        let paths = HostPaths::resolve_with(Some(root.clone()), None).unwrap();
        assert_eq!(paths.data_root, root);
        paths.ensure_layout().unwrap();
        assert!(paths.archive_dir.is_dir());
        assert!(paths.logs_dir.is_dir());
        assert!(!paths.archive_dir.join("archive.db").exists());
        assert!(!paths.current_pointer.exists());
    }

    #[test]
    fn ensure_layout_does_not_delete_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("data");
        let paths = HostPaths::resolve_with(Some(root.clone()), None).unwrap();
        paths.ensure_layout().unwrap();
        let marker = paths.archive_dir.join("keep-me.txt");
        fs::write(&marker, b"stay").unwrap();
        paths.ensure_layout().unwrap();
        assert_eq!(fs::read_to_string(&marker).unwrap(), "stay");
    }

    #[test]
    fn unwritable_file_as_root_does_not_fallback() {
        let tmp = tempfile::tempdir().unwrap();
        let file_root = tmp.path().join("not-a-dir");
        fs::write(&file_root, b"nope").unwrap();
        let paths = HostPaths::resolve_with(Some(file_root.clone()), None).unwrap();
        let err = paths.ensure_layout().unwrap_err();
        assert!(
            err.code() == crate::error::DIR_NOT_WRITABLE
                || err.code() == crate::error::DIR_CREATE_FAILED
        );
        let temp = std::env::temp_dir();
        assert_ne!(paths.data_root, temp);
        assert!(paths.data_root.starts_with(tmp.path()));
    }
}
