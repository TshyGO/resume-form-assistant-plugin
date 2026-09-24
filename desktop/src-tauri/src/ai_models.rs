//! 模型列表拉取：往用户配的 OpenAI 兼容接口的 `/models` 发一次只带 Key 的 GET。
//!
//! 规则和插件那边（`ai-models.js`）一致：
//! - 已经指向 `/chat/completions` 的地址，把后缀换成 `/models`；
//! - 看着像 base（空路径、`/v1` 这类版本段、`/openai`）的，补上 `/models`；
//! - 别的路径原样不动，也推断不出模型列表地址——直接手填模型名，不瞎猜。
//! - 只显示看着像对话模型的，别的（embedding、语音、画图）藏起来计数。
//! 过滤词锁死测试读取插件 `ai-models.js`；PR 5 删除该文件时一并删掉那条测试。
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
    // 地址里的 userinfo 本来就该在命令层被 `checked_url` 拦下；
    // 这里再清一次，拼出来的请求地址不可能夹带凭据，将来复用也不怕。
    let _ = next.set_username("");
    let _ = next.set_password(None);
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

/// 过滤词的唯一正本（字符串形态）：`non_chat_patterns` 和跨端锁死单测共用它，
/// 插件加词时这里同步加。和插件 `ai-models.js` 的 NON_CHAT_PATTERNS 逐条一致
/// （含 `asr` 无前缀、`audio` 刻意放行以保住 gpt-4o-audio-preview 之类的注释口径）。
fn pattern_sources() -> Vec<String> {
    // 注意和 JS 那边 `\/` 与 `/` 的写法差：比对前单测会统一归一化，见单测注释。
    const SEP: &str = r"(?:^|[/_.:\s-])";
    const END: &str = r"(?:$|[/_.:\s-])";
    [
        "embed".to_string(),
        "rerank".to_string(),
        format!("{SEP}bge{END}"),
        format!("{SEP}ttsd?{END}"),
        format!("asr{END}"),
        "whisper".to_string(),
        "transcribe".to_string(),
        "dall-e".to_string(),
        format!("{SEP}image{END}"),
        "moderation".to_string(),
        format!("{SEP}flux{END}"),
        "stable-diffusion|sdxl".to_string(),
        "kolors".to_string(),
        "cosyvoice".to_string(),
        "sensevoice".to_string(),
        "fish-speech".to_string(),
        format!("{SEP}[ti]2v{END}"),
    ]
    .into_iter()
    .collect()
}

fn non_chat_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        pattern_sources()
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
    if !(200..300).contains(&status) {
        // 非 2xx 只按状态码分类，不读取服务商正文；正文可能包含完整地址或 Key。
        eprintln!("ai-models: {host} · HTTP {status} · {} ms", started.elapsed().as_millis());
        if status == 401 || status == 403 {
            return Err(CommandError {
                code: "AI_MODELS_AUTH".into(),
                message: format!("{host} 拒绝了这个 Key（HTTP {status}）：请检查密钥是否正确、是否有效。"),
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
        return Err(CommandError {
            code: format!("AI_MODELS_HTTP_{status}"),
            message: format!("从 {host} 获取模型失败（HTTP {status}）。"),
        });
    }
    // 模型列表才几 KB：Content-Length 老实标超的，看完头就拒掉，不读进内存；
    // 没标或谎报的，读完按字节数再拒一次（见下）。chunked 无头细水长流的靠总超时兜底，
    // 和 chat 路径一个待遇：reqwest 构建时没开 `stream` 特性，
    // 为这一次设置页请求另起流式限流不值得。
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
    let bytes = response.bytes().await.map_err(|err| {
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
    if bytes.len() as u64 > MAX_MODELS_BODY_BYTES {
        return Err(CommandError {
            code: "AI_MODELS_BAD_RESPONSE".into(),
            message: format!("{host} 返回的内容过大（超过 1MB），请检查 API URL 是否指错了地方。"),
        });
    }
    // `from_slice` 失败（含非 UTF-8 / 二进制）一律是“形状不对”，不再误报断连。
    let body: Option<Value> = serde_json::from_slice(&bytes).ok();

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

    /// 保存时补全地址用 `ai_settings::normalize_api_url`，获取模型用 `resolve_endpoints`。
    /// 两套各自实现、口径本该一致（模块头注释：「规则和插件那边一致」，`normalize_api_url`
    /// 的注释也是「规则和插件那边一致」）——如果对同一个输入吐出两个不同的 chat 端点，
    /// 保存时存的地址和获取模型时用的地址就对不上。这里逐条钉住，任何一行不一致就直接
    /// 报出来是哪一条、期望什么、实际是什么，而不是悄悄让某一边迁就另一边。
    #[test]
    fn normalize_api_url_and_resolve_endpoints_agree_on_the_chat_url() {
        let cases = [
            "https://api.deepseek.com",
            "https://api.deepseek.com/",
            "https://api.deepseek.com/v1",
            "https://api.deepseek.com/v1/",
            "https://open.bigmodel.cn/api/paas/v4",
            "https://gateway.example/openai",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "https://relay.example/v1/chat/completions?api-version=2024-10-21",
            "https://relay.example/custom/path",
        ];
        let mut mismatches = Vec::new();
        for input in cases {
            let normalized = crate::ai_settings::normalize_api_url(input, crate::ai_settings::DEFAULT_API_URL);
            let resolved = resolve_endpoints(input).expect("都是合法 http(s) 地址，resolve_endpoints 不该返回 None");
            if normalized != resolved.chat_url {
                mismatches.push(format!(
                    "{input} -> normalize_api_url={normalized:?}, resolve_endpoints.chat_url={:?}",
                    resolved.chat_url
                ));
            }
        }
        assert!(mismatches.is_empty(), "口径不一致：\n{}", mismatches.join("\n"));
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
        serve_once_bytes(status, body.as_bytes())
    }

    fn serve_once_bytes(
        status: u16,
        body: &[u8],
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let header = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        let body = body.to_vec();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = stream.write_all(&header);
            let _ = stream.write_all(&body);
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (format!("http://{addr}/v1/models"), handle)
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
    fn serve_stalled_body(status: u16, content_length: usize) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
            std::thread::sleep(Duration::from_secs(5));
        });
        (format!("http://{addr}/v1/models"), handle)
    }

    /// 不标 Content-Length、改用 chunked 分块送超大正文：验证读完之后
    /// 的字节数检查照样拒收（只是比看头多花一次缓冲）。
    fn serve_chunked(status: u16, body: &[u8]) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = body.to_vec();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
            for chunk in body.chunks(128 * 1024) {
                let _ = stream.write_all(format!("{:X}\r\n", chunk.len()).as_bytes());
                let _ = stream.write_all(chunk);
                let _ = stream.write_all(b"\r\n");
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        (format!("http://{addr}/v1/models"), handle)
    }

    /// 报一个超大 Content-Length 然后拖着不关：客户端应该看完头就拒掉，
    /// 不会真的读 2MB。
    fn serve_oversized(status: u16) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: 2097152\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
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
        let (url, handle) = serve_stalled_body(200, 64);
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
        let (url, handle) = serve_oversized(200);
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
        let (auth_url, auth) = serve_once(401, r#"{"error":{"message":"bad key https://relay.example?api_key=sk-secret"}}"#);
        let err = fetch_model_list_with_timeout(
            &auth_url,
            "sk-bad",
            "relay.example",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_AUTH");
        assert!(!err.message.contains("sk-secret"), "{}", err.message);
        assert!(!err.message.contains("bad key"), "{}", err.message);
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

        let (server_url, server) =
            serve_once(500, r#"{"error":{"message":"upstream https://relay.example?key=sk-secret"}}"#);
        let err = fetch_model_list_with_timeout(&server_url, "sk-test", "relay.example", Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_HTTP_500");
        assert!(!err.message.contains("sk-secret"), "{}", err.message);
        server.join().unwrap();
    }

    #[tokio::test]
    async fn error_statuses_win_over_body_problems() {
        // 401 的 body 卡住：分类仍是 AUTH，不是 TIMEOUT。
        let (auth_url, auth) = serve_stalled_body(401, 64);
        let err = fetch_model_list_with_timeout(
            &auth_url,
            "sk-bad",
            "127.0.0.1",
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_AUTH");
        auth.join().unwrap();

        // 404 配超大正文：分类仍是 NOT_FOUND，不是“地址不对”的 BAD_RESPONSE。
        let (missing_url, missing) = serve_oversized(404);
        let err = fetch_model_list_with_timeout(
            &missing_url,
            "sk-test",
            "127.0.0.1",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_NOT_FOUND");
        missing.join().unwrap();
    }

    #[tokio::test]
    async fn non_utf8_and_oversized_chunked_bodies_are_bad_responses() {
        // 200 配非法 UTF-8：是“形状不对”，不是断连。
        let (bin_url, bin_handle) =
            serve_once_bytes(200, &[0x7b, 0x22, 0xff, 0xfe, 0x7d]);
        let err = fetch_model_list_with_timeout(
            &bin_url,
            "sk-test",
            "127.0.0.1",
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_BAD_RESPONSE");
        bin_handle.join().unwrap();

        // chunked 无头超大正文：读完按字节数拒收，不进解析。
        let big = vec![b'a'; MAX_MODELS_BODY_BYTES as usize + 16];
        let (chunked_url, chunked) = serve_chunked(200, &big);
        let err = fetch_model_list_with_timeout(
            &chunked_url,
            "sk-test",
            "127.0.0.1",
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "AI_MODELS_BAD_RESPONSE");
        assert!(err.message.contains("过大"), "{}", err.message);
        chunked.join().unwrap();
    }

    #[test]
    fn credentials_in_the_address_never_survive_into_models_url() {
        let resolved = resolve_endpoints("https://user:secret@relay.example/v1").unwrap();
        let models = resolved.models_url.unwrap();
        assert!(!models.contains('@'), "{models}");
        assert!(!models.contains("secret"), "{models}");
        assert!(models.starts_with("https://relay.example/"), "{models}");
    }

    /// 和插件 `ai-models.js` 的 NON_CHAT_PATTERNS 逐条锁死：插件加词时这里必须同步加，
    /// 否则这条测试变红。读的是仓库根下的源文件（编译时相对本文件定位，和运行目录无关）。
    /// 只比“词”本身：JS 模板里的 `\/` 和这里的 `/` 写法不同但语义一样，比对前统一归一化。
    #[test]
    fn non_chat_patterns_match_the_plugin_word_for_word() {
        const JS: &str = include_str!("../../../ai-models.js");
        let block = JS
            .split("NON_CHAT_PATTERNS = [")
            .nth(1)
            .expect("NON_CHAT_PATTERNS block")
            .split("];")
            .next()
            .expect("NON_CHAT_PATTERNS end");
        let js_sep = js_string_const(JS, "const SEP = ").expect("SEP const");
        let js_end = js_string_const(JS, "const END = ").expect("END const");
        let mut expected = Vec::new();
        for raw_line in block.lines() {
            let line = raw_line.trim().trim_end_matches(',').trim();
            if line.is_empty() {
                continue;
            }
            let (raw_source, flags) = if line.starts_with('/') {
                split_regex_literal(line).expect("regex literal entry")
            } else if line.starts_with("new RegExp") {
                let template = line.split('`').nth(1).expect("RegExp template");
                let flags = line.rsplit('"').nth(1).expect("RegExp flags");
                (
                    template.replace("${SEP}", &js_sep).replace("${END}", &js_end),
                    flags.to_string(),
                )
            } else {
                panic!("看不懂的词条（插件改格式了就同步改这里）：{line}");
            };
            assert!(
                flags.contains('i'),
                "过滤词必须大小写不敏感（和这里的 (?i) 对应）：{line}"
            );
            expected.push(raw_source.replace("\\/", "/"));
        }
        let actual: Vec<String> = pattern_sources()
            .into_iter()
            .map(|pattern| pattern.replace("\\/", "/"))
            .collect();
        assert_eq!(
            actual, expected,
            "过滤词和插件对不上了：插件加词时这里同步加"
        );
    }

    /// 取 `const SEP = "(?:^|...)"` 这类 JS 字符串常量的实际串值。
    /// 文件里只用到了 `\\` 转义，unescape 就处理这一种，够用了。
    fn js_string_const(js: &str, prefix: &str) -> Option<String> {
        let line = js
            .lines()
            .find(|line| line.trim_start().starts_with(prefix))?;
        let quoted = line.split('"').nth(1)?;
        Some(quoted.replace("\\\\", "\\"))
    }

    /// 拆 `/source/flags` 字面量：`[...]` 字符组里的 `/` 不算结尾，转义的跳过一位。
    fn split_regex_literal(line: &str) -> Option<(String, String)> {
        let bytes = line.as_bytes();
        let mut in_class = false;
        let mut i = 1;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' => i += 1,
                b'[' => in_class = true,
                b']' => in_class = false,
                b'/' if !in_class => {
                    return Some((line[1..i].to_string(), line[i + 1..].to_string()));
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    #[test]
    fn non_ascii_version_lookalikes_are_not_base_paths() {
        // JS 的 `\d` 不管带不带 `u` 标志都只认 ASCII 数字，全角数字不算；插件那条正则
        // 因此本来就不会把这类地址当成版本号段。桌面侧的 `is_version_segment` 同样只认
        // ASCII，口径一致，不是刻意的分歧。这类地址不瞎猜，直接走“推不出模型地址”，用户手填。
        assert!(!is_base_path("/v１２"));
        assert!(!is_base_path("/Ｖ1"));
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
