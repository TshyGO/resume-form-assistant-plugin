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

#[cfg(feature = "usage-metrics-acceptance")]
pub fn prepare(identifier: &str) -> Result<(), &'static str> {
    if !build_enabled() || identifier != IDENTIFIER {
        return Err("统计验收包构建配置不完整，已停止启动。请使用专用 release 验收包。");
    }
    let root = root()?;
    // Do not allow an old symlink to redirect the test package into a real archive.
    let parent = root.parent().ok_or("测试目录无效。")?;
    for path in [parent, root.as_path()] {
        if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("测试目录不能是符号链接，已停止启动。");
        }
    }
    std::fs::create_dir_all(&root).map_err(|_| "无法创建独立测试目录。")?;
    // This process includes native-host invocations: every entry uses the same isolated root.
    std::env::set_var("RESUMEPRO_DATA_DIR", &root);
    std::env::set_var("RESUMEPRO_CACHE_DIR", parent.join("cache"));
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
}
