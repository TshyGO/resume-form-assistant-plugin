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
use url::Url;

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

/// 一次挑选的结果。
///
/// 「没有更新」和「判断不出来」必须分开：两者都返回 `None` 的话，仓库改名、
/// 接口变形、地址全都不合规——这些情况界面都会说「已经是最新版」，而且完全
/// 静默。这正是这个模块最不该说的谎。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    /// 列表读懂了，里面没有比这更该提示的桌面版本。
    Nothing,
    /// 有一条能用的。
    Found(UpdateInfo),
    /// 有桌面版本，但没有一条能用（地址不是本仓库的 Release 页、字段缺失……）。
    /// 这是「没查成」，不是「已经最新」。
    Unusable,
}

/// 从 releases 列表里挑出最新的桌面版本。
///
/// 规则写死在这里而不是靠 GitHub 的 `latest`：那个接口给的是整个仓库的最新
/// release，很可能是插件的。草稿和预发布一律跳过。
pub fn latest_desktop_release(body: &Value) -> Pick {
    let mut best: Option<(Vec<u32>, UpdateInfo)> = None;
    // 「认得出的最高版本」和「能安全打开的最高版本」分开记。两者不一致，说明
    // 最新那一版我们打不开——那是「没查成」，不是「已经最新」。
    let mut highest_seen: Option<Vec<u32>> = None;
    let Some(items) = body.as_array() else {
        // 连列表都不是：这不是「没有更新」。
        return Pick::Unusable;
    };
    for item in items {
        if item["draft"].as_bool().unwrap_or(false) || item["prerelease"].as_bool().unwrap_or(false)
        {
            continue;
        }
        // 这里每一步都得 `continue` 而不是 `?`：用 `?` 的话，列表里任何一条
        // 缺字段的 release（接口加字段、异常发布、以后 API 变形）都会让整个函数
        // 返回 None，界面照直说「已经是最新版」——正好是这块代码最该避免的谎。
        let Some(tag) = item["tag_name"].as_str() else {
            continue;
        };
        let Some(version) = tag.strip_prefix(TAG_PREFIX) else {
            continue;
        };
        let Some(parts) = parse_version(version) else {
            continue;
        };
        match &highest_seen {
            Some(current) if *current >= parts => {}
            _ => highest_seen = Some(parts.clone()),
        }
        // 下载页地址在这里就得站得住：留到点「去下载页」才发现打不开，
        // 用户已经被告知「有新版本」了。
        let Some(url) = item["html_url"].as_str().filter(|url| is_release_page(url)) else {
            continue;
        };
        let candidate = UpdateInfo {
            version: version.to_string(),
            url: url.to_string(),
        };
        match &best {
            Some((current, _)) if *current >= parts => {}
            _ => best = Some((parts, candidate)),
        }
    }
    match (best, highest_seen) {
        // 最高版本正好是能打开的那一条。
        (Some((parts, info)), Some(highest)) if parts == highest => Pick::Found(info),
        // 认得出更高的版本，却只能打开一个更旧的。退回去说「有新版本 vN-1」，
        // 用户点完下载页装完，还是落后；说「已经最新」更是直接的谎。
        (_, Some(_)) => Pick::Unusable,
        (_, None) => Pick::Nothing,
    }
}

/// 只认本仓库 Release 页的地址。命令层打开前还会再查一次，这里是第一道。
///
/// 这个地址来自网络响应，最后会被交给系统浏览器打开，所以不能只比前缀：
/// `…/releases/../../../someone/else` 前缀是对的，浏览器规范化之后却落在
/// 别人的仓库。先解析成 URL（`..`、`.`、`%2e` 都在解析时就被归一掉），
/// 再一项项核对主机、端口、用户名密码和路径。
///
/// 以后要是接了镜像或代理域名，这里会一并拒掉——那时候该显式加白名单，
/// 而不是把判断放松。
pub fn is_release_page(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("github.com")
        && parsed.port().is_none()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed
            .path()
            .strip_prefix("/TshyGO/resume-form-assistant-plugin/releases/")
            .is_some_and(|rest| !rest.is_empty())
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
    offer_from(&Value::Array(releases))
}

/// 挑选结果 → 命令层的返回。单独一个函数是为了这层映射也能被测到：
/// 「说不清」被当成「已经最新」是这块代码最贵的错法。
pub fn offer_from(body: &Value) -> Result<Option<UpdateInfo>, CommandError> {
    match latest_desktop_release(body) {
        Pick::Found(info) => Ok(Some(info)),
        Pick::Nothing => Ok(None),
        // 说不清的时候说「没查成」。说成「已经是最新版」，用户就再也不会去看了。
        // 走到这里有两种原因：返回的不是列表（接口变形、仓库改名），或者列表里
        // 每条的下载地址都不指向本仓库。对用户来说是同一句话：这次没查成。
        Pick::Unusable => Err(CommandError {
            code: "UPDATE_FAILED".into(),
            message: "读不懂更新服务器给的发布列表，这次没查成。".into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 挑出来并且能用的那一条。挑不出来时直接让测试失败，信息比 `unwrap` 清楚。
    fn found(body: &Value) -> UpdateInfo {
        match latest_desktop_release(body) {
            Pick::Found(info) => info,
            other => panic!("没挑出可用的版本：{other:?}"),
        }
    }

    fn release(tag: &str, draft: bool, prerelease: bool) -> Value {
        json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "html_url": format!(
                "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/{tag}"
            ),
        })
    }

    #[test]
    fn only_desktop_tags_count() {
        // 同一个仓库里还有插件的 release，别把它当成桌面的新版本。
        let body = json!([
            release("v0.5.0", false, false),
            release("desktop-v0.2.0", false, false)
        ]);
        assert_eq!(found(&body).version, "0.2.0");
    }

    #[test]
    fn the_newest_wins_regardless_of_order() {
        let body = json!([
            release("desktop-v0.2.0", false, false),
            release("desktop-v0.10.0", false, false),
            release("desktop-v0.9.0", false, false),
        ]);
        // 字符串比会说 0.9 更大。
        assert_eq!(found(&body).version, "0.10.0");
    }

    #[test]
    fn more_than_twenty_plugin_releases_do_not_hide_the_desktop_release() {
        let mut releases = (0..25)
            .map(|index| release(&format!("v0.5.{index}"), false, false))
            .collect::<Vec<_>>();
        releases.push(release("desktop-v0.2.0", false, false));
        assert_eq!(found(&Value::Array(releases)).version, "0.2.0");
    }

    #[test]
    fn drafts_and_prereleases_are_not_offered() {
        let body = json!([
            release("desktop-v0.3.0", true, false),
            release("desktop-v0.4.0", false, true),
            release("desktop-v0.1.0", false, false),
        ]);
        assert_eq!(found(&body).version, "0.1.0");
    }

    #[test]
    fn one_malformed_entry_does_not_hide_the_rest() {
        // 缺字段的 release 只该被跳过。整列作废的后果是界面说「已经是最新版」——
        // 用户永远不知道有新版本，而这正是最难被发现的那种错。
        let body = json!([
            json!({ "draft": false, "prerelease": false }),
            json!({ "tag_name": 42 }),
            release("desktop-v1.0.0", false, false),
        ]);
        assert_eq!(found(&body).version, "1.0.0");
    }

    #[test]
    fn a_release_without_a_usable_download_page_is_skipped() {
        // 说了「有新版」就得能点开。地址不对的条目在筛选阶段就该出局，
        // 而不是等用户点「去下载页」才报错。
        let mut broken = release("desktop-v1.0.0", false, false);
        broken["html_url"] = json!("https://example.test/not-a-release");
        let body = json!([release("desktop-v2.0.0", false, false), broken]);
        assert_eq!(found(&body).version, "2.0.0");

        // 一条桌面版本都用不上时，那是「没查成」，不是「已经最新」。
        let mut missing = release("desktop-v3.0.0", false, false);
        missing["html_url"] = Value::Null;
        assert_eq!(latest_desktop_release(&json!([missing])), Pick::Unusable);
    }

    #[test]
    fn a_broken_newest_release_is_not_covered_up_by_an_older_working_one() {
        // 最高版本打不开、次高版本能打开时，不能退回去报次高版本：本机要是已经
        // 装着次高版本，退回去的结果就是界面说「已经是最新版」——最新那一版
        // 出了问题，反而一个字都没提。
        let mut broken = release("desktop-v2.0.0", false, false);
        broken["html_url"] = json!("https://example.test/not-a-release");
        let body = json!([broken, release("desktop-v1.0.0", false, false)]);
        assert_eq!(latest_desktop_release(&body), Pick::Unusable);
    }

    #[test]
    fn a_list_we_cannot_read_is_not_the_same_as_being_up_to_date() {
        // 仓库改名、接口变形、地址全都不合规——这些都不是「已经是最新版」。
        assert_eq!(
            latest_desktop_release(&json!({"message": "Not Found"})),
            Pick::Unusable
        );
        assert_eq!(latest_desktop_release(&json!("字符串")), Pick::Unusable);
        // 真的没有桌面版本，才是「没有更新」。
        assert_eq!(latest_desktop_release(&json!([])), Pick::Nothing);
        assert_eq!(
            latest_desktop_release(&json!([release("v1.0.0", false, false)])),
            Pick::Nothing
        );
    }

    #[test]
    fn only_this_repository_release_pages_are_accepted() {
        assert!(is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        // 别人仓库的 Release 页、明文 http、以及别的路径都不行。
        assert!(!is_release_page(
            "https://github.com/someone/else/releases/tag/v1"
        ));
        assert!(!is_release_page(
            "http://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin"
        ));
        // 前缀对、规范化之后却在别人仓库的那几种写法。
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/../../someone/else"
        ));
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/%2e%2e/%2e%2e/someone/else"
        ));
        // 主机像是 github.com，其实不是。
        assert!(!is_release_page(
            "https://github.com.evil.test/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        assert!(!is_release_page(
            "https://user:pass@github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        assert!(!is_release_page(
            "https://github.com:8443/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.1.0"
        ));
        // `/releases` 本身不是一个下载页，别把用户扔到一个空路径上。
        assert!(!is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/"
        ));
        assert!(!is_release_page("不是地址"));
        // Release 页的另外两种形状也要认。
        assert!(is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/download/desktop-v0.1.0/setup.exe"
        ));
        assert!(is_release_page(
            "https://github.com/TshyGO/resume-form-assistant-plugin/releases/latest"
        ));
    }

    #[test]
    fn saying_nothing_and_saying_i_cannot_tell_map_to_different_answers() {
        // 「没有更新」是 Ok(None)，「读不懂」必须是错误。两者混在一起，用户就
        // 会在一个坏掉的检查上看到「已经是最新版」。
        assert_eq!(offer_from(&json!([])).unwrap(), None);
        let found = offer_from(&json!([release("desktop-v9.9.9", false, false)]))
            .unwrap()
            .unwrap();
        assert_eq!(found.version, "9.9.9");

        let mut bad_url = release("desktop-v1.0.0", false, false);
        bad_url["html_url"] = json!("https://github.com/someone/else/releases/tag/v1");
        let err = offer_from(&json!([bad_url])).unwrap_err();
        assert_eq!(err.code, "UPDATE_FAILED");
    }

    #[test]
    fn a_tag_we_cannot_parse_is_skipped_without_panicking() {
        // 形状不对的 tag 既不是更新，也不该让整次检查炸掉。
        assert_eq!(
            latest_desktop_release(&json!([release("desktop-v不是版本号", false, false)])),
            Pick::Nothing
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
