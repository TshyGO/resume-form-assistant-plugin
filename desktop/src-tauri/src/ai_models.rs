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

/// 正常模型列表才几 KB：超过这个数的一律当指错了地址，不读进内存。
const MAX_MODELS_BODY_BYTES: u64 = 1024 * 1024;

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
/// `/^v\d+[a-z0-9]*$/iu`（大小写不敏感，`V2` 也算，见单测）。
fn is_base_path(path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or("");
    last.eq_ignore_ascii_case("openai") || crate::ai_settings::is_version_segment(last)
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
    // 和插件 `ai-models.js` 的 NON_CHAT_PATTERNS 逐条一致（含 `asr` 无前缀、
    // `audio` 刻意放行以保住 gpt-4o-audio-preview 之类的注释口径）。
    // 插件加词时这里同步加，单测 `non_chat_models_are_hidden_but_counted` 盯着例子。
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

/// 下拉的过滤发生在前端（`ai-settings.ts` 的 `matchModels`，有自己的单测）。
/// 这里不留第二份实现：测 Rust 副本拦不住 TS 漂移，反而多一份要同步的词表。
#[derive(Debug, Clone)]
pub struct ModelList {
    pub models: Vec<String>,
    pub hidden_count: usize,
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
                .or_else(|| error.as_str().map(str::to_string))
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
    // 重定向沿用 reqwest 默认：跨主机跳转不带 Authorization。换 client 配置时别顺手改了这条。
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
    // 模型列表才几 KB：先看一眼长度，超大正文直接拒掉，不读进内存。
    // 只防 Content-Length 老实标出来的那种；chunked 细水长流的靠总超时兜底，
    // 和 chat 路径一个待遇，不在这里另起一套流式限流。
    if response.content_length().is_some_and(|len| len > MAX_MODELS_BODY_BYTES) {
        eprintln!(
            "ai-models: {host} · HTTP {status} · body-too-large · {} ms",
            started.elapsed().as_millis()
        );
        return Err(CommandError {
            code: "AI_MODELS_BAD_RESPONSE".into(),
            message: format!("{host} 返回的内容过大（超过 1MB），请检查 API URL 是否指错了地方。"),
        });
    }
    let text = response.text().await.map_err(|err| {
        if err.is_timeout() {
            let seconds = timeout.as_secs().max(1);
            eprintln!(
                "ai-models: {host} · body-timeout · {} ms",
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
                "ai-models: {host} · body-error · {} ms",
                started.elapsed().as_millis()
            );
            CommandError {
                code: "AI_MODELS_NETWORK".into(),
                message: format!("连不上 {host}：请检查网络、代理，以及 API URL 的域名拼写。"),
            }
        }
    })?;
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
    // 全量列表只在内部算隐藏数，不出这道门：前端只要能填的 + 藏了几个。
    Ok(ModelList {
        models,
        hidden_count: hidden.len(),
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

    /// 起一个只回一次的本地 HTTP 服务器，返回它的地址和收到的请求头。
    /// 发请求不走外网；顺带钉住 Key 只走 Authorization 头。
    fn serve_once(status: u16, body: &str) -> (String, std::thread::JoinHandle<String>) {
        serve_once_delayed(status, body, Duration::from_secs(0))
    }

    fn serve_once_delayed(
        status: u16,
        body: &str,
        delay: Duration,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let payload = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            let _ = stream.write_all(payload.as_bytes());
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (format!("http://{addr}/v1/models"), handle)
    }

    /// 只发响应头就停住：Content-Length 说后面还有，但 body 永远不来。
    /// 用来走读 body 阶段的超时分支。
    fn serve_stalled_body(content_length: usize) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 Test\r\nContent-Type: application/json\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
            std::thread::sleep(Duration::from_secs(5));
        });
        (format!("http://{addr}/v1/models"), handle)
    }

    /// 报一个超大 Content-Length 然后拖着不关：客户端应该看完头就拒掉，
    /// 不会真的读 2MB。
    fn serve_oversized() -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                b"HTTP/1.1 200 Test\r\nContent-Type: application/json\r\nContent-Length: 2097152\r\nConnection: close\r\n\r\n",
            );
            std::thread::sleep(Duration::from_secs(5));
        });
        (format!("http://{addr}/v1/models"), handle)
    }

    /// 占一个端口再放掉：连过去必定被拒绝，用来走 NETWORK 分支，不碰外网。
    fn refused_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{addr}/v1/models")
    }

    #[test]
    fn query_string_survives_but_fragment_does_not() {
        let resolved =
            resolve_endpoints("https://relay.example/v1/chat/completions?api-version=2024-10-21#frag")
                .unwrap();
        let models = resolved.models_url.unwrap();
        assert!(models.contains("api-version=2024-10-21"), "{models}");
        assert!(!models.contains("frag"), "{models}");
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
        let request = handle.join().unwrap();
        assert!(
            request.contains("authorization: Bearer sk-test"),
            "Key 只许走 Authorization 头：\n{request}"
        );
    }

    #[tokio::test]
    async fn a_slow_server_maps_to_timeout_and_a_dead_port_to_network() {
        let (slow_url, slow) = serve_once_delayed(200, r#"{"data":[]}"#, Duration::from_secs(5));
        let err = fetch_model_list_with_timeout(
            &slow_url,
            "sk-test",
            "127.0.0.1",
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_TIMEOUT");
        slow.join().unwrap();

        let err = fetch_model_list_with_timeout(
            &refused_url(),
            "sk-test",
            "127.0.0.1",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_NETWORK");
    }

    #[tokio::test]
    async fn a_body_that_never_arrives_is_still_a_timeout() {
        let (url, handle) = serve_stalled_body(64);
        let err = fetch_model_list_with_timeout(
            &url,
            "sk-test",
            "127.0.0.1",
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_TIMEOUT");
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused_from_the_headers() {
        let (url, handle) = serve_oversized();
        let err = fetch_model_list_with_timeout(
            &url,
            "sk-test",
            "127.0.0.1",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_BAD_RESPONSE");
        assert!(err.message.contains("过大"), "{}", err.message);
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
