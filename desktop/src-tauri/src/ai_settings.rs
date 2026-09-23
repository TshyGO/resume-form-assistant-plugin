//! 桌面这一侧的 AI 设置：接口地址和模型名。
//!
//! **Key 不在这里。** 它进 OS 凭据库（见 [`crate::ai_credentials`]），不进这个文件，
//! 也不进备份（data-privacy §1）。
//!
//! 单独一个 `ai-settings.json`，不跟配对草稿挤在 `settings.json` 里：那个文件是整份
//! 覆盖写的（`data-service::host::save_pairing_draft`），往里加东西会被下一次保存配对冲掉。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ai_extract::AiProtocol;

pub const DEFAULT_API_URL: &str = "https://api.openai.com/v1/chat/completions";
pub const DEFAULT_MODEL: &str = "gpt-4o-mini";
const FILE_NAME: &str = "ai-settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub api_url: String,
    pub model: String,
    #[serde(default)]
    pub protocol: AiProtocol,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            api_url: DEFAULT_API_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            protocol: AiProtocol::Chat,
        }
    }
}

pub fn path_for(data_root: &Path) -> PathBuf {
    data_root.join(FILE_NAME)
}

/// 读设置。文件不在、读不动、或者内容坏了，都退回默认值——
/// 这里没有任何不可再生的数据，报错拦住用户配 AI 没有意义。
pub fn load(data_root: &Path) -> AiSettings {
    let Ok(text) = fs::read_to_string(path_for(data_root)) else {
        return AiSettings::default();
    };
    let mut parsed: AiSettings = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => AiSettings::default(),
    };
    if parsed.api_url.trim().is_empty() {
        parsed.api_url = DEFAULT_API_URL.to_string();
    }
    if parsed.model.trim().is_empty() {
        parsed.model = DEFAULT_MODEL.to_string();
    }
    parsed
}

/// 地址里夹带凭据就不保存。
///
/// 文档写着「Key 只在认证请求头里，`ai-settings.json` 不含 Key」。用户把 key 贴进
/// 地址（`https://user:pass@host/…` 或 `?api-key=…`）就会把这句话变成假话：它会落进设置
/// 文件、随每次请求出现在 URL 里、也更容易被中转站的访问日志记下来。界面上的提醒挡不住
/// 直接改文件或粘贴，所以这一层必须拦。
pub fn credential_in_url(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Some("接口地址里带了用户名或密码。Key 请填在「API Key」里，别放进地址。".into());
    }
    // 查询串会随每次请求发出去；fragment 不会上线，但它照样落进 `ai-settings.json`、
    // 跟着截图和粘贴到处走，而用户多半以为自己在正确地配 Key。两个都拦。
    let query = url.split_once('?').map(|(_, rest)| rest).unwrap_or("");
    let fragment = url.split_once('#').map(|(_, rest)| rest).unwrap_or("");
    let hit = query
        .split(['&', ';'])
        .chain(fragment.split(['&', ';']))
        .find_map(|pair| {
        let name = pair.split('=').next().unwrap_or("").to_ascii_lowercase();
        // 按分段比，不按子串比：`api-key` / `api_key` / `x-token` 要拦住,
        // `monkey` / `keynote` / `api-version` 不能误伤。
            let segments = name.split(|c: char| !c.is_ascii_alphanumeric());
            segments
                .into_iter()
                .any(|segment| {
                    matches!(
                        segment,
                        "key" | "apikey" | "token" | "secret" | "password" | "auth" | "credential"
                            | "sig" | "sign" | "signature"
                    )
                })
                .then_some(name)
        });
    if let Some(name) = hit {
        return Some(format!(
            "接口地址里的 `{name}` 看着像一把 Key。Key 请填在「API Key」里，别放进地址。"
        ));
    }
    None
}

/// 写设置。先写临时文件再改名，避免写到一半断电留下半个文件。
pub fn save(data_root: &Path, typed_url: &str, typed_model: &str) -> Result<AiSettings, String> {
    save_with_protocol(data_root, typed_url, typed_model, AiProtocol::Chat)
}

pub fn save_with_protocol(data_root: &Path, typed_url: &str, typed_model: &str, protocol: AiProtocol) -> Result<AiSettings, String> {
    if let Some(problem) = credential_in_url(typed_url) {
        return Err(problem);
    }
    let current = load(data_root);
    let settings = AiSettings {
        api_url: normalize_api_url_for_protocol(typed_url, &current.api_url, protocol),
        model: {
            let model = typed_model.trim();
            if model.is_empty() {
                current.model.clone()
            } else {
                model.to_string()
            }
        },
        protocol,
    };
    let target = path_for(data_root);
    let tmp = target.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&tmp, json).map_err(|e| format!("写 {} 失败：{e}", tmp.display()))?;
    fs::rename(&tmp, &target).map_err(|e| format!("保存 {} 失败：{e}", target.display()))?;
    Ok(settings)
}

/// 用户填的多半是服务商文档上的 Base URL。规则和插件那边（`ai-models.js`）一致：
/// 已经指向具体端点的原样保留，看着像 base 的补上 `/chat/completions`。
pub fn normalize_api_url(typed: &str, fallback: &str) -> String {
    normalize_api_url_for_protocol(typed, fallback, AiProtocol::Chat)
}

pub fn normalize_api_url_for_protocol(typed: &str, fallback: &str, protocol: AiProtocol) -> String {
    let value = typed.trim();
    if value.is_empty() {
        return normalize_api_url_for_protocol(fallback, DEFAULT_API_URL, protocol);
    }
    let (prefix, rest) = match value.find("://") {
        Some(at) => value.split_at(at + 3),
        None => ("", value),
    };
    let (authority_and_path, suffix) = match rest.find(['?', '#']) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let trimmed = authority_and_path.trim_end_matches('/');
    let path_start = trimmed.find('/').unwrap_or(trimmed.len());
    let (authority, path) = trimmed.split_at(path_start);
    let lower = path.to_ascii_lowercase();

    for endpoint in ["/chat/completions", "/responses", "/messages"] {
        if lower.ends_with(endpoint) {
            if endpoint == protocol.suffix() {
                return value.to_string();
            }
            let base = &path[..path.len() - endpoint.len()];
            return format!("{prefix}{authority}{base}{}{suffix}", protocol.suffix());
        }
    }
    let last = path.rsplit('/').next().unwrap_or("");
    let looks_like_base = path.is_empty() || is_version_segment(last) || last.eq_ignore_ascii_case("openai");
    if !looks_like_base {
        return value.to_string();
    }
    let base = if path.is_empty() { "/v1" } else { path };
    format!("{prefix}{authority}{base}{}{suffix}", protocol.suffix())
}

/// 版本段（`/v1`、`/api/v3`、`/v1beta`）：`v` 后面必须先是数字，剩下全是字母数字。
/// 口径和插件 `ai-models.js` 的 `/^v\d+[a-z0-9]*$/iu` 在 ASCII 输入下一致，
/// 也被 `ai_models` 复用，改一边时另一边同步变。注意两处刻意的不同：
/// 插件正则带 `u` 标志还会认 Unicode 数字/字母，桌面侧只认 ASCII（见单测）；
/// `v1-beta` 不算：它不再触发 base 补全（见单测）。
pub(crate) fn is_version_segment(segment: &str) -> bool {
    let rest = match segment.strip_prefix('v').or_else(|| segment.strip_prefix('V')) {
        Some(rest) => rest,
        None => return false,
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(first) if first.is_ascii_digit() => {}
        _ => return false,
    }
    // 口径和插件 `ai-models.js` 的 /^v\d+[a-z0-9]*$/ 在 ASCII 输入下一致：
    // v1-beta 不算版本段（插件正则的 `u` 标志还会认 Unicode 数字，桌面侧不认）。
    rest.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 预览和日志里只出现主机名，不出现完整地址（data-privacy §9）。
pub fn host_of(api_url: &str) -> String {
    let rest = api_url.split("://").nth(1).unwrap_or(api_url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    if host.is_empty() {
        "（接口地址无法解析）".to_string()
    } else {
        host.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_grows_the_endpoint_and_a_full_one_is_left_alone() {
        let cases = [
            ("https://api.deepseek.com", "https://api.deepseek.com/v1/chat/completions"),
            ("https://api.deepseek.com/", "https://api.deepseek.com/v1/chat/completions"),
            ("https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"),
            ("https://api.deepseek.com/v1/", "https://api.deepseek.com/v1/chat/completions"),
            (
                "https://open.bigmodel.cn/api/paas/v4",
                "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            ),
            (
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            ),
            (
                "https://api.openai.com/v1/chat/completions",
                "https://api.openai.com/v1/chat/completions",
            ),
            (
                "https://relay.example/v1/chat/completions?api-version=2024-10-21",
                "https://relay.example/v1/chat/completions?api-version=2024-10-21",
            ),
            ("http://127.0.0.1:8000", "http://127.0.0.1:8000/v1/chat/completions"),
        ];
        for (typed, expected) in cases {
            assert_eq!(normalize_api_url(typed, DEFAULT_API_URL), expected, "{typed}");
        }
    }

    #[test]
    fn an_empty_address_keeps_whatever_was_there_before() {
        assert_eq!(normalize_api_url("   ", "https://kept.example/v1/chat/completions"),
            "https://kept.example/v1/chat/completions");
        assert_eq!(
            normalize_api_url_for_protocol("   ", "https://kept.example/v1/chat/completions", AiProtocol::Anthropic),
            "https://kept.example/v1/messages"
        );
    }

    #[test]
    fn an_unrecognised_path_is_not_rewritten() {
        // 中转站有各种自定义路径，猜着改只会把能用的地址改坏。
        assert_eq!(
            normalize_api_url("https://relay.example/proxy/openai-compatible", DEFAULT_API_URL),
            "https://relay.example/proxy/openai-compatible"
        );
        // `v1-beta` 不是版本段（和插件 `/^v\d+[a-z0-9]*$/iu` 一致）：以前会误补，
        // 现在原样保留。收紧是 #143 有意对齐插件，不是顺手改的。
        assert_eq!(
            normalize_api_url("https://relay.example/v1-beta", DEFAULT_API_URL),
            "https://relay.example/v1-beta"
        );
    }

    #[test]
    fn the_host_never_carries_credentials() {
        assert_eq!(host_of("https://user:pass@API.Example.test/v1/chat/completions"), "api.example.test");
        assert_eq!(host_of("https://relay.example?tenant=private"), "relay.example");
    }

    #[test]
    fn protocol_switch_rewrites_known_endpoint_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let saved = save_with_protocol(dir.path(), "https://relay.example/v1/chat/completions", "claude-test", AiProtocol::Anthropic).unwrap();
        assert_eq!(saved.api_url, "https://relay.example/v1/messages");
        assert_eq!(load(dir.path()).protocol, AiProtocol::Anthropic);
        let legacy = dir.path().join("ai-settings.json");
        std::fs::write(&legacy, r#"{"apiUrl":"https://relay.example/v1/responses","model":"m"}"#).unwrap();
        assert_eq!(load(dir.path()).protocol, AiProtocol::Chat);
    }

    #[test]
    fn settings_round_trip_and_a_broken_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), AiSettings::default());

        let saved = save(dir.path(), "https://api.deepseek.com", "deepseek-chat").unwrap();
        assert_eq!(saved.api_url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(load(dir.path()), saved);

        std::fs::write(path_for(dir.path()), "{ 坏掉的").unwrap();
        assert_eq!(load(dir.path()), AiSettings::default());
    }

    #[test]
    fn an_address_that_carries_a_credential_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "https://someone:sk-123@relay.example/v1/chat/completions",
            "https://relay.example/v1/chat/completions?api-key=sk-123",
            "https://relay.example/v1/chat/completions?token=abc",
        ] {
            let err = save(dir.path(), bad, "m").unwrap_err();
            assert!(err.contains("API Key"), "{bad}: {err}");
        }
        // fragment 里的也算。
        assert!(credential_in_url("https://relay.example/v1/chat/completions#api-key=sk-1").is_some());
        // 正常参数不该被误伤：按分段比，不按子串比。
        for fine in [
            "https://relay.example/v1/chat/completions?api-version=2024-10-21",
            "https://relay.example/v1/chat/completions?monkey=1",
            "https://relay.example/v1/chat/completions?keynote=x",
        ] {
            assert!(credential_in_url(fine).is_none(), "{fine}");
        }
        assert!(save(
            dir.path(),
            "https://relay.example/v1/chat/completions?api-version=2024-10-21",
            "m"
        )
        .is_ok());
        // 报错里带上命中的那个参数名，用户才知道该删哪个。
        let named = credential_in_url("https://relay.example/v1?x-token=abc").unwrap();
        assert!(named.contains("x-token"), "{named}");
        let text = std::fs::read_to_string(path_for(dir.path())).unwrap();
        assert!(!text.contains("sk-123"), "被拒的地址还是写进了文件：{text}");
    }

    #[test]
    fn the_settings_file_never_contains_a_key() {
        let dir = tempfile::tempdir().unwrap();
        save(dir.path(), "https://api.deepseek.com/v1", "deepseek-chat").unwrap();
        let text = std::fs::read_to_string(path_for(dir.path())).unwrap();
        for forbidden in ["key", "Key", "token", "secret"] {
            assert!(!text.contains(forbidden), "设置文件里出现了 {forbidden}：{text}");
        }
    }
}
