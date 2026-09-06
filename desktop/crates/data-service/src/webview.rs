use crate::paths::HostPaths;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebViewStorage {
    pub app_cache_dir: PathBuf,
    pub webview_data_dir: Option<PathBuf>,
    pub managed_by_app: bool,
    pub note: String,
}

pub fn webview_storage(paths: &HostPaths) -> WebViewStorage {
    if cfg!(windows) {
        WebViewStorage {
            app_cache_dir: paths.cache_dir.clone(),
            webview_data_dir: Some(paths.cache_dir.join("webview")),
            managed_by_app: true,
            note: "Windows WebView2 用户数据由 WEBVIEW2_USER_DATA_FOLDER 指定到应用缓存下的 webview\\。".to_string(),
        }
    } else if cfg!(target_os = "macos") {
        WebViewStorage {
            app_cache_dir: paths.cache_dir.clone(),
            webview_data_dir: None,
            managed_by_app: false,
            note: "当前 Tauri/wry 的 WKWebView 没有 data_directory。网站数据留在 identifier com.resumepro.desktop 的系统默认存储（常见为 ~/Library/WebKit），不是 ~/Library/Caches/ResumePro。应用缓存目录仍由本应用管理，但不是 WebView 配置目录。".to_string(),
        }
    } else {
        WebViewStorage {
            app_cache_dir: paths.cache_dir.clone(),
            webview_data_dir: Some(paths.cache_dir.join("webview")),
            managed_by_app: true,
            note: "WebKitGTK 可通过 data_directory 使用应用缓存下的 webview/。Linux 不是首版产品目标。".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::HostPaths;

    #[test]
    fn windows_webview_dir_is_under_cache() {
        if !cfg!(windows) {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let paths = HostPaths::from_roots(tmp.path().join("data"), tmp.path().join("data").join("cache"));
        let info = webview_storage(&paths);
        assert!(info.managed_by_app);
        assert_eq!(info.webview_data_dir.as_ref().unwrap(), &paths.cache_dir.join("webview"));
    }

    #[test]
    fn macos_does_not_claim_custom_webview_path() {
        if !cfg!(target_os = "macos") {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let paths = HostPaths::from_roots(tmp.path().join("data"), tmp.path().join("cache"));
        let info = webview_storage(&paths);
        assert!(!info.managed_by_app);
        assert!(info.webview_data_dir.is_none());
        assert!(info.note.contains("WKWebView"));
    }
}
