//! 模型列表拉取：往用户配的 OpenAI 兼容接口的 `/models` 发一次只带 Key 的 GET。
//!
//! 规则和插件那边（`ai-models.js`）一致：
//! - 已经指向 `/chat/completions` 的地址，把后缀换成 `/models`；
//! - 看着像 base（空路径、`/v1` 这类版本段、`/openai`）的，补上 `/models`；
//! - 别的路径原样不动，也推断不出模型列表地址——直接手填模型名，不瞎猜。
//! - 只显示看着像对话模型的，别的（embedding、语音、画图）藏起来计数。
//!
//! 日志和报错里只出现主机名，不出现 Key 和完整地址（data-privacy §9）。

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use crate::commands::CommandError;

/// 插件那边也是 15 秒：`/models` 只是读配置，不值得等一分钟。
pub const MODELS_TIMEOUT_SECONDS: u64 = 15;

pub struct ResolvedEndpoints {
    // 保存时补全地址另有一套老的 `normalize_api_url`（含无 scheme 的脏输入），
    // 这里只给 `/models` 用，chat_url 留给单测钉住和插件一致的口径。
    #[allow(dead_code)]
    pub chat_url: String,
    pub models_url: Option<String>,
}

/// 地址能不能用来拉模型列表。`None` 表示连解析都过不了。
pub fn resolve_endpoints(input: &str) -> Option<ResolvedEndpoints> {
    let text = input.trim();
    let url = url::Url::parse(text).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let path = url.path().trim_end_matches('/').to_string();
    let path_lower = path.to_ascii_lowercase();

    if path_lower
        .strip_suffix("/chat/completions")
        .is_some()
    {
        let base = &path[..path.len() - "/chat/completions".len()];
        return Some(ResolvedEndpoints {
            chat_url: text.to_string(),
            models_url: Some(with_path(&url, &format!("{base}/models"))),
        });
    }

    if path.is_empty() || is_base_path(&path) {
        let base = if path.is_empty() { "/v1".to_string() } else { path };
        return Some(ResolvedEndpoints {
            chat_url: with_path(&url, &format!("{base}/chat/completions")),
            models_url: Some(with_path(&url, &format!("{base}/models"))),
        });
    }

    Some(ResolvedEndpoints {
        chat_url: text.to_string(),
        models_url: None,
    })
}

/// 和 `withPath` 一个意思：只换路径，查询串留着（有些中转要 `?api-version=`），
/// fragment 不要（它本来也不该进请求）。
fn with_path(url: &url::Url, pathname: &str) -> String {
    let mut next = url.clone();
    next.set_fragment(None);
    next.set_path(pathname);
    next.to_string()
}

/// 最后一个分段是版本段（`/v1`、`/api/v3`、`/v1beta`）或 `openai` 时，
/// 这个路径自己不可能是 chat 端点，只能是 base。口径和插件的 `isBasePath` 一致：
/// `v` 后面必须先是数字，剩下的是字母数字。
fn is_base_path(path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or("");
    last.eq_ignore_ascii_case("openai") || is_version_segment(last)
}

fn is_version_segment(segment: &str) -> bool {
    let rest = match segment.strip_prefix('v').or_else(|| segment.strip_prefix('V')) {
        Some(rest) => rest,
        None => return false,
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(first) if first.is_ascii_digit() => {}
        _ => return false,
    }
    rest.chars().all(|c| c.is_ascii_alphanumeric())
}

/// `/models` 返回的形状：裸数组，或包在 `data` 里。条目是字符串或带 `id` 的对象。
/// 去重并排序；形状不对返回 `None`。空列表是合法的（`Some(vec![])`）。
pub fn parse_model_list(body: &Value) -> Option<Vec<String>> {
    let entries = if let Some(items) = body.as_array() {
        items
    } else if let Some(items) = body.get("data").and_then(Value::as_array) {
        items
    } else {
        return None;
    };
    let mut ids: Vec<String> = entries
        .iter()
        .map(|entry| {
            if let Some(name) = entry.as_str() {
                name.trim().to_string()
            } else if let Some(id) = entry.get("id").and_then(Value::as_str) {
                id.trim().to_string()
            } else {
                String::new()
            }
        })
        .filter(|id| !id.is_empty())
        .collect();
    ids.sort_by(|a, b| {
        a.to_lowercase()
            .cmp(&b.to_lowercase())
            .then_with(|| a.cmp(b))
    });
    ids.dedup();
    Some(ids)
}

fn non_chat_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    const SEP: &str = r"(?:^|[/_.:\s-])";
    const END: &str = r"(?:$|[/_.:\s-])";
    PATTERNS.get_or_init(|| {
        [
            "embed",
            "rerank",
            format!("{SEP}bge{END}").as_str(),
            format!("{SEP}ttsd?{END}").as_str(),
            format!("asr{END}").as_str(),
            "whisper",
            "transcribe",
            "dall-e",
            format!("{SEP}image{END}").as_str(),
            "moderation",
            format!("{SEP}flux{END}").as_str(),
            "stable-diffusion|sdxl",
            "kolors",
            "cosyvoice",
            "sensevoice",
            "fish-speech",
            format!("{SEP}[ti]2v{END}").as_str(),
        ]
        .into_iter()
        .map(|pattern| Regex::new(&format!("(?i){pattern}")).expect("model filter pattern"))
        .collect()
    })
}

/// 看着像对话模型的留下，embedding、语音、画图之类的藏起来计数。
/// 返回 `(chat, hidden)`。隐藏只是建议：输入框永远可以手填。
pub fn filter_chat_models(ids: &[String]) -> (Vec<String>, Vec<String>) {
    let patterns = non_chat_patterns();
    let mut chat = Vec::new();
    let mut hidden = Vec::new();
    for id in ids {
        if patterns.iter().any(|pattern| pattern.is_match(id)) {
            hidden.push(id.clone());
        } else {
            chat.push(id.clone());
        }
    }
    (chat, hidden)
}

/// 按用户已经敲的字给候选排序：完全一致最前，然后是前缀（含 `vendor/` 后面的部分），
/// 然后是子串。对不上的不要。下标小的优先，排序是稳定的。
///
/// 下拉的过滤发生在前端（`matchModels`），这里留一份同口径实现并由单测钉住，
/// 免得两边悄悄分叉。
#[allow(dead_code)]
pub fn match_models(ids: &[String], query: &str) -> Vec<String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return ids.to_vec();
    }
    let rank = |id: &str| {
        let lower = id.to_lowercase();
        if lower == needle {
            return 0;
        }
        let after_vendor = lower.rsplit('/').next().unwrap_or(&lower);
        if lower.starts_with(&needle) || after_vendor.starts_with(&needle) {
            return 1;
        }
        if lower.contains(&needle) { 2 } else { -1 }
    };
    let mut ranked: Vec<(i32, usize, &String)> = ids
        .iter()
        .enumerate()
        .map(|(index, id)| (rank(id), index, id))
        .filter(|(rank, _, _)| *rank >= 0)
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    ranked.into_iter().map(|(_, _, id)| id.clone()).collect()
}

#[derive(Debug, Clone)]
pub struct ModelList {
    pub models: Vec<String>,
    pub hidden_count: usize,
    pub all_models: Vec<String>,
}

/// 服务商报错正文里的一句话，压成一行、最多 200 字。拿不到就空着。
fn provider_detail(body: Option<&Value>) -> String {
    let body = match body {
        Some(body) => body,
        None => return String::new(),
    };
    let detail = body
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    if let Some(text) = error.as_str() {
                        Some(text.to_string())
                    } else {
                        None
                    }
                })
        })
        .or_else(|| {
            body.get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    detail
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect::<String>()
        .trim()
        .to_string()
}

/// 拉一次模型列表。调用前地址里的凭据、`models_url` 推不出来、Key 为空这三件事
/// 应该已经在命令层拦过——这里再各守一道，方便单测。
pub async fn fetch_model_list(
    models_url: &str,
    api_key: &str,
    host: &str,
) -> Result<ModelList, CommandError> {
    fetch_model_list_with_timeout(
        models_url,
        api_key,
        host,
        Duration::from_secs(MODELS_TIMEOUT_SECONDS),
    )
    .await
}

pub async fn fetch_model_list_with_timeout(
    models_url: &str,
    api_key: &str,
    host: &str,
    timeout: Duration,
) -> Result<ModelList, CommandError> {
    if models_url.trim().is_empty()
        || url::Url::parse(models_url)
            .map(|url| url.scheme() != "http" && url.scheme() != "https")
            .unwrap_or(true)
    {
        return Err(CommandError {
            code: "AI_MODELS_BAD_URL".into(),
            message: "API URL 格式不对，请填写以 http:// 或 https:// 开头的地址。".into(),
        });
    }
    if api_key.trim().is_empty() {
        return Err(CommandError {
            code: "AI_MODELS_MISSING_KEY".into(),
            message: "请先填写 API Key，再获取模型。".into(),
        });
    }

    let started = Instant::now();
    let client = reqwest::Client::builder().timeout(timeout).build().map_err(|e| {
        eprintln!("ai-models: client-init-failed · {e}");
        CommandError {
            code: "AI_CLIENT_INIT_FAILED".into(),
            message: "HTTP 客户端没建起来，这次没有发出去。".into(),
        }
    })?;
    let response = client
        .get(models_url)
        .bearer_auth(api_key.trim())
        .send()
        .await
        .map_err(|err| {
            if err.is_timeout() {
                let seconds = timeout.as_secs().max(1);
                eprintln!(
                    "ai-models: {host} · timeout · {} ms",
                    started.elapsed().as_millis()
                );
                CommandError {
                    code: "AI_MODELS_TIMEOUT".into(),
                    message: format!(
                        "请求超时（{seconds} 秒无响应）：连不上该地址或服务过慢，请检查网络或代理。"
                    ),
                }
            } else {
                eprintln!(
                    "ai-models: {host} · network-error · {} ms",
                    started.elapsed().as_millis()
                );
                CommandError {
                    code: "AI_MODELS_NETWORK".into(),
                    message: format!("连不上 {host}：请检查网络、代理，以及 API URL 的域名拼写。"),
                }
            }
        })?;

    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    eprintln!(
        "ai-models: {host} · HTTP {status} · {} ms",
        started.elapsed().as_millis()
    );
    let body: Option<Value> = serde_json::from_str(&text).ok();
    let detail = provider_detail(body.as_ref());
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("服务返回：{detail}")
    };

    if status == 401 || status == 403 {
        return Err(CommandError {
            code: "AI_MODELS_AUTH".into(),
            message: format!("{host} 拒绝了这个 Key（HTTP {status}）：请检查密钥是否正确、是否有效。{suffix}"),
        });
    }
    if status == 404 || status == 405 {
        return Err(CommandError {
            code: "AI_MODELS_NOT_FOUND".into(),
            message: format!(
                "{host} 没有返回模型列表（HTTP {status}）。可能是地址不对（常见：漏了 /v1），也可能是服务商不提供模型列表——可直接手填模型名称。"
            ),
        });
    }
    if !(200..300).contains(&status) {
        let message = if detail.is_empty() {
            format!("从 {host} 获取模型失败（HTTP {status}）。")
        } else {
            format!("从 {host} 获取模型失败（HTTP {status}）：{detail}")
        };
        return Err(CommandError {
            code: format!("AI_MODELS_HTTP_{status}"),
            message,
        });
    }

    let all_models = body
        .as_ref()
        .and_then(parse_model_list)
        .ok_or_else(|| CommandError {
            code: "AI_MODELS_BAD_RESPONSE".into(),
            message: format!("{host} 返回的不是模型列表，请检查 API URL 是否指向 OpenAI 兼容接口。"),
        })?;
    let (models, hidden) = filter_chat_models(&all_models);
    Ok(ModelList {
        models,
        hidden_count: hidden.len(),
        all_models,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn chat_endpoint_swaps_its_suffix_for_models() {
        let resolved =
            resolve_endpoints("https://api.deepseek.com/v1/chat/completions").unwrap();
        assert_eq!(
            resolved.chat_url,
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            resolved.models_url.as_deref(),
            Some("https://api.deepseek.com/v1/models")
        );
    }

    #[test]
    fn base_addresses_gain_both_endpoints() {
        let resolved = resolve_endpoints("https://api.deepseek.com/v1").unwrap();
        assert_eq!(
            resolved.chat_url,
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            resolved.models_url.as_deref(),
            Some("https://api.deepseek.com/v1/models")
        );

        let bare = resolve_endpoints("https://api.deepseek.com").unwrap();
        assert_eq!(bare.chat_url, "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(
            bare.models_url.as_deref(),
            Some("https://api.deepseek.com/v1/models")
        );

        let gateway = resolve_endpoints("https://gateway.example/openai").unwrap();
        assert!(gateway.models_url.unwrap().ends_with("/openai/models"));
    }

    #[test]
    fn unrecognised_paths_are_left_alone_with_no_models_url() {
        let resolved = resolve_endpoints("https://proxy.example/some/chat").unwrap();
        assert_eq!(resolved.chat_url, "https://proxy.example/some/chat");
        assert!(resolved.models_url.is_none());
    }

    #[test]
    fn garbage_and_non_http_resolve_to_nothing() {
        assert!(resolve_endpoints("not a url").is_none());
        assert!(resolve_endpoints("ftp://relay.example/v1").is_none());
        assert!(resolve_endpoints("").is_none());
    }

    #[test]
    fn version_segments_follow_the_plugin_rule() {
        for good in ["/v1", "/api/v3", "/v1beta", "/V2", "/openai", "/OPENAI"] {
            assert!(is_base_path(good), "{good} should be a base path");
        }
        for bad in ["/chat", "/v", "/vx", "/v1-beta", "/openai2", "/v1/openai/extra"] {
            assert!(!is_base_path(bad), "{bad} should not be a base path");
        }
    }

    #[test]
    fn model_lists_come_bare_or_wrapped_and_dedupe() {
        let wrapped = json!({"data": [{"id": "b-chat"}, {"id": "a-chat"}, {"id": "a-chat"}, {"id": "  "}, {"id": 7}]});
        assert_eq!(
            parse_model_list(&wrapped).unwrap(),
            vec!["a-chat".to_string(), "b-chat".to_string()]
        );
        let bare = json!(["x", "y"]);
        assert_eq!(
            parse_model_list(&bare).unwrap(),
            vec!["x".to_string(), "y".to_string()]
        );
        assert!(parse_model_list(&json!({"models": []})).is_none());
        assert_eq!(
            parse_model_list(&json!({"data": []})).unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn non_chat_models_are_hidden_but_counted() {
        let ids = [
            "deepseek-chat",
            "gpt-4o-audio-preview",
            "text-embedding-3-small",
            "whisper-1",
            "Qwen-Image",
            "dall-e-3",
            " Doubao-Seed-1-6-flash ",
        ]
        .into_iter()
        .map(|id| id.trim().to_string())
        .collect::<Vec<_>>();
        let (chat, hidden) = filter_chat_models(&ids);
        assert!(chat.contains(&"deepseek-chat".to_string()));
        assert!(chat.contains(&"gpt-4o-audio-preview".to_string()));
        assert!(chat.contains(&"Doubao-Seed-1-6-flash".to_string()));
        assert_eq!(hidden.len(), 4);
    }

    #[test]
    fn matching_prefers_exact_then_prefix_then_substring() {
        let ids = ["zzz-gpt", "gpt-4o", "vendor/gpt-4o-mini", "my-gpt-x"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert_eq!(match_models(&ids, "gpt-4o"), vec!["gpt-4o", "vendor/gpt-4o-mini"]);
        assert_eq!(match_models(&ids, "mini"), vec!["vendor/gpt-4o-mini"]);
        assert_eq!(match_models(&ids, ""), ids);
        assert!(match_models(&ids, "claude").is_empty());
    }

    /// 起一个只回一次的本地 HTTP 服务器，返回它的地址。发请求不走外网。
    fn serve_once(status: u16, body: &str) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let payload = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(payload.as_bytes());
        });
        (format!("http://{addr}/v1/models"), handle)
    }

    #[tokio::test]
    async fn fetch_success_filters_and_counts() {
        let (url, handle) = serve_once(
            200,
            r#"{"data":[{"id":"c-chat"},{"id":"text-embedding-3-small"},{"id":"a-chat"}]}"#,
        );
        let list =
            fetch_model_list_with_timeout(&url, "sk-test", "127.0.0.1", Duration::from_secs(5))
                .await
                .unwrap();
        assert_eq!(list.models, vec!["a-chat".to_string(), "c-chat".to_string()]);
        assert_eq!(list.hidden_count, 1);
        assert_eq!(list.all_models.len(), 3);
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn fetch_statuses_map_to_the_documented_failures() {
        let (auth_url, auth) = serve_once(401, r#"{"error":{"message":"bad key"}}"#);
        let err = fetch_model_list_with_timeout(
            &auth_url,
            "sk-bad",
            "relay.example",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_AUTH");
        assert!(err.message.contains("bad key"), "{}", err.message);
        auth.join().unwrap();

        let (missing_url, missing) = serve_once(404, "{}");
        let err = fetch_model_list_with_timeout(
            &missing_url,
            "sk-test",
            "relay.example",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_NOT_FOUND");
        missing.join().unwrap();

        let (shape_url, shape) = serve_once(200, r#"{"models":["a"]}"#);
        let err = fetch_model_list_with_timeout(
            &shape_url,
            "sk-test",
            "relay.example",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_BAD_RESPONSE");
        shape.join().unwrap();
    }

    #[tokio::test]
    async fn fetch_without_a_key_or_url_fails_before_touching_the_network() {
        let err = fetch_model_list_with_timeout(
            "http://127.0.0.1:1/v1/models",
            "  ",
            "127.0.0.1",
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_MISSING_KEY");

        let err = fetch_model_list_with_timeout(
            "not a url",
            "sk-test",
            "nowhere",
            Duration::from_secs(2),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_BAD_URL");
    }
}
