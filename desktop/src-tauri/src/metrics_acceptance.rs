//! Explicit release-only acceptance package. Never changes normal-build paths or keys.
use std::path::{Path, PathBuf};

pub const IDENTIFIER: &str = "com.resumepro.metrics.acceptance";
pub const ENDPOINT: &str = "https://resume-usage-metrics-test.nebula-lab.workers.dev/v1/activity";

pub fn build_enabled() -> bool {
    cfg!(feature = "usage-metrics-acceptance")
        && !cfg!(any(test, debug_assertions))
        && option_env!("RESUME_USAGE_METRICS_ACCEPTANCE_BUILD") == Some("1")
}

pub fn root_under(base: &Path) -> PathBuf {
    base.join("ResumeProUsageMetricsTest")
        .join("usage-metrics-test-data")
}

pub fn root() -> Result<PathBuf, &'static str> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Application Support"));
    base.filter(|base| base.is_absolute())
        .map(|base| root_under(&base))
        .ok_or("无法定位独立测试目录，测试版没有启动。")
}

pub fn configured_endpoint(data_root: &Path) -> Option<String> {
    (build_enabled() && root().is_ok_and(|expected| expected == data_root))
        .then(|| ENDPOINT.to_owned())
}

fn metadata_is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn reject_links(path: &Path) -> Result<(), &'static str> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法检查独立测试目录。"),
    };
    if metadata_is_link(&metadata) {
        return Err("测试数据或缓存不能包含符号链接，已停止启动。");
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|_| "无法检查独立测试目录。")? {
            reject_links(&entry.map_err(|_| "无法检查独立测试目录。")?.path())?;
        }
    }
    Ok(())
}

fn prepare_directories(root: &Path) -> Result<PathBuf, &'static str> {
    let parent = root.parent().ok_or("测试目录无效。")?;
    // Check only the namespace node, then recurse into app data/cache. Browser profiles
    // are siblings and legitimately contain Chromium SingletonLock symlinks.
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) if metadata_is_link(&metadata) => return Err("测试命名空间不能是符号链接。"),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法检查独立测试目录。"),
    }
    reject_links(root)?;
    let cache = parent.join("cache");
    reject_links(&cache)?;
    std::fs::create_dir_all(root).map_err(|_| "无法创建独立测试目录。")?;
    std::fs::create_dir_all(&cache).map_err(|_| "无法创建独立测试缓存。")?;
    reject_links(root)?;
    reject_links(&cache)?;
    Ok(cache)
}

pub fn effective_isolation() -> bool {
    let Ok(expected) = root() else {
        return false;
    };
    let Ok(paths) = data_service::HostPaths::resolve() else {
        return false;
    };
    paths.data_root == expected
        && expected
            .parent()
            .is_some_and(|parent| paths.cache_dir == parent.join("cache"))
        && reject_links(&expected).is_ok()
        && expected
            .parent()
            .is_some_and(|parent| reject_links(&parent.join("cache")).is_ok())
}

#[cfg(feature = "usage-metrics-acceptance")]
pub fn prepare(identifier: &str) -> Result<(), &'static str> {
    if !build_enabled() || identifier != IDENTIFIER {
        return Err("统计验收包构建配置不完整，已停止启动。请使用专用 release 验收包。");
    }
    let root = root()?;
    let cache = prepare_directories(&root)?;
    // This process includes native-host invocations: every entry uses the same isolated root.
    std::env::set_var("RESUMEPRO_DATA_DIR", &root);
    std::env::set_var("RESUMEPRO_CACHE_DIR", cache);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_and_test_builds_cannot_enable_cloud_activity() {
        assert!(!build_enabled());
        assert!(configured_endpoint(Path::new("/some/real/archive")).is_none());
    }
    #[test]
    fn data_root_is_always_separate_from_the_real_resumepro_root() {
        let root = root_under(Path::new("/synthetic-app-data"));
        assert!(root.ends_with("ResumeProUsageMetricsTest/usage-metrics-test-data"));
        assert!(!root.starts_with("/synthetic-app-data/ResumePro"));
    }
    #[test]
    fn data_and_cache_are_created_in_the_same_test_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let root = root_under(dir.path());
        let cache = prepare_directories(&root).unwrap();
        assert!(root.is_dir());
        assert!(cache.is_dir());
        assert_eq!(cache, root.parent().unwrap().join("cache"));
    }
    #[cfg(unix)]
    #[test]
    fn cache_and_nested_data_links_are_rejected_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("synthetic-real-data");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("sentinel"), b"unchanged").unwrap();
        let root = root_under(dir.path());
        let cache = prepare_directories(&root).unwrap();
        std::fs::remove_dir(&cache).unwrap();
        symlink(&real, &cache).unwrap();
        assert!(prepare_directories(&root).is_err());
        std::fs::remove_file(&cache).unwrap();
        std::fs::create_dir(&cache).unwrap();
        symlink(&real, root.join("archive")).unwrap();
        assert!(prepare_directories(&root).is_err());
        assert_eq!(std::fs::read(real.join("sentinel")).unwrap(), b"unchanged");
        assert_eq!(std::fs::read_dir(real).unwrap().count(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn browser_profile_singleton_links_do_not_block_the_isolated_app() {
        let dir = tempfile::tempdir().unwrap();
        let root = root_under(dir.path());
        prepare_directories(&root).unwrap();
        let browser = root.parent().unwrap().join("chrome-profile");
        std::fs::create_dir(&browser).unwrap();
        std::os::unix::fs::symlink("synthetic-host-123", browser.join("SingletonLock")).unwrap();
        assert!(prepare_directories(&root).is_ok());
    }
}
