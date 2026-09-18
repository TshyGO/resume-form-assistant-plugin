//! 「有没有新版本」这一件事。**只查、只说，不下载、不安装。**
//!
//! 为什么不做静默更新：安装包没有签名。让程序自己下一个未签名的安装包再运行，
//! 比让用户自己去下载页点一下糟得多——那等于把「确认这是我要的东西」这一步
//! 从用户手里拿走了。
//!
//! 查的是 GitHub 的 releases 列表，只认 `desktop-v*` 的 tag：插件用的是
//! `v*.*.*`，两边混在同一个仓库里。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::CommandError;

const RELEASES_URL: &str =
    "https://api.github.com/repos/TshyGO/resume-form-assistant-plugin/releases";
const RELEASES_PER_PAGE: usize = 100;
const TAG_PREFIX: &str = "desktop-v";
const TIMEOUT_SECONDS: u64 = 10;
const FILE_NAME: &str = "update-check.json";

/// 用户对自动检查的偏好。单独一个文件：settings.json 是整份覆盖写的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreference {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
}

impl Default for UpdatePreference {
    fn default() -> Self {
        // 默认开：不知道有新版本，用户就一直停在旧版上。查一次只是一个 GET，
        // 而且每天最多一次，随时能关。
        Self {
            enabled: true,
            last_checked_at: None,
        }
    }
}

pub fn path_for(data_root: &Path) -> PathBuf {
    data_root.join(FILE_NAME)
}

/// 读偏好。文件坏了就退回默认：这里没有任何不可再生的数据。
pub fn load(data_root: &Path) -> UpdatePreference {
    std::fs::read_to_string(path_for(data_root))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(data_root: &Path, pref: &UpdatePreference) -> Result<(), String> {
    let target = path_for(data_root);
    let tmp = target.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(pref).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("写 {} 失败：{e}", tmp.display()))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("保存 {} 失败：{e}", target.display()))
}

/// 一次能下载的版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
}

/// 从 releases 列表里挑出最新的桌面版本。
///
/// 规则写死在这里而不是靠 GitHub 的 `latest`：那个接口给的是整个仓库的最新
/// release，很可能是插件的。草稿和预发布一律跳过。
pub fn latest_desktop_release(body: &Value) -> Option<UpdateInfo> {
    let mut best: Option<(Vec<u32>, UpdateInfo)> = None;
    for item in body.as_array()? {
        if item["draft"].as_bool().unwrap_or(false) || item["prerelease"].as_bool().unwrap_or(false)
        {
            continue;
        }
        let tag = item["tag_name"].as_str()?;
        let Some(version) = tag.strip_prefix(TAG_PREFIX) else {
            continue;
        };
        let Some(parts) = parse_version(version) else {
            continue;
        };
        let url = item["html_url"].as_str().unwrap_or_default().to_string();
        let candidate = UpdateInfo {
            version: version.to_string(),
            url,
        };
        match &best {
            Some((current, _)) if *current >= parts => {}
            _ => best = Some((parts, candidate)),
        }
    }
    best.map(|(_, info)| info)
}

fn parse_version(value: &str) -> Option<Vec<u32>> {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    parts.iter().map(|part| part.parse::<u32>().ok()).collect()
}

/// 去问一次。失败一律是「没查成」，不是「已经最新」——这两件事不能混。
pub async fn fetch_latest() -> Result<Option<UpdateInfo>, CommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECONDS))
        .build()
        .map_err(|_| CommandError {
            code: "UPDATE_OFFLINE".into(),
            message: "查更新的客户端没建起来。".into(),
        })?;
    let mut page = 1_u32;
    let mut releases = Vec::new();
    loop {
        let url = format!("{RELEASES_URL}?per_page={RELEASES_PER_PAGE}&page={page}");
        let response = client
            .get(url)
            // GitHub 要求带 User-Agent，不带会直接 403。
            .header("user-agent", "resume-pro-desktop")
            .header("accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| CommandError {
                code: "UPDATE_OFFLINE".into(),
                message: "连不上更新服务器。".into(),
            })?;
        let status = response.status();
        if status.as_u16() == 403 || status.as_u16() == 429 {
            return Err(CommandError {
                code: "UPDATE_RATE_LIMITED".into(),
                message: "更新服务器暂时限流了。".into(),
            });
        }
        if !status.is_success() {
            return Err(CommandError {
                code: "UPDATE_FAILED".into(),
                message: format!("更新服务器返回 HTTP {}。", status.as_u16()),
            });
        }
        let body: Value = response.json().await.map_err(|_| CommandError {
            code: "UPDATE_FAILED".into(),
            message: "更新服务器返回的不是 JSON。".into(),
        })?;
        let Some(items) = body.as_array() else {
            return Err(CommandError {
                code: "UPDATE_FAILED".into(),
                message: "更新服务器返回的不是发布列表。".into(),
            });
        };
        let item_count = items.len();
        releases.extend(items.iter().cloned());
        if item_count < RELEASES_PER_PAGE {
            break;
        }
        page = page.checked_add(1).ok_or_else(|| CommandError {
            code: "UPDATE_FAILED".into(),
            message: "更新记录页数异常。".into(),
        })?;
    }
    Ok(latest_desktop_release(&Value::Array(releases)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, draft: bool, prerelease: bool) -> Value {
        json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "html_url": format!("https://example.test/{tag}"),
        })
    }

    #[test]
    fn only_desktop_tags_count() {
        // 同一个仓库里还有插件的 release，别把它当成桌面的新版本。
        let body = json!([
            release("v0.5.0", false, false),
            release("desktop-v0.2.0", false, false)
        ]);
        let latest = latest_desktop_release(&body).unwrap();
        assert_eq!(latest.version, "0.2.0");
    }

    #[test]
    fn the_newest_wins_regardless_of_order() {
        let body = json!([
            release("desktop-v0.2.0", false, false),
            release("desktop-v0.10.0", false, false),
            release("desktop-v0.9.0", false, false),
        ]);
        // 字符串比会说 0.9 更大。
        assert_eq!(latest_desktop_release(&body).unwrap().version, "0.10.0");
    }

    #[test]
    fn more_than_twenty_plugin_releases_do_not_hide_the_desktop_release() {
        let mut releases = (0..25)
            .map(|index| release(&format!("v0.5.{index}"), false, false))
            .collect::<Vec<_>>();
        releases.push(release("desktop-v0.2.0", false, false));
        assert_eq!(
            latest_desktop_release(&Value::Array(releases))
                .unwrap()
                .version,
            "0.2.0"
        );
    }

    #[test]
    fn drafts_and_prereleases_are_not_offered() {
        let body = json!([
            release("desktop-v0.3.0", true, false),
            release("desktop-v0.4.0", false, true),
            release("desktop-v0.1.0", false, false),
        ]);
        assert_eq!(latest_desktop_release(&body).unwrap().version, "0.1.0");
    }

    #[test]
    fn nothing_to_offer_is_not_an_error() {
        assert_eq!(latest_desktop_release(&json!([])), None);
        assert_eq!(
            latest_desktop_release(&json!([release("v1.0.0", false, false)])),
            None
        );
        // 形状不对的 tag 直接跳过，不 panic。
        assert_eq!(
            latest_desktop_release(&json!([release("desktop-v不是版本号", false, false)])),
            None
        );
        assert_eq!(
            latest_desktop_release(&json!({"message": "Not Found"})),
            None
        );
    }

    #[test]
    fn the_preference_round_trips_and_a_broken_file_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), UpdatePreference::default());

        let pref = UpdatePreference {
            enabled: false,
            last_checked_at: Some("2026-09-17T10:00:00Z".into()),
        };
        save(dir.path(), &pref).unwrap();
        assert_eq!(load(dir.path()), pref);

        std::fs::write(path_for(dir.path()), "{ 坏掉的").unwrap();
        assert_eq!(load(dir.path()), UpdatePreference::default());
    }
}
