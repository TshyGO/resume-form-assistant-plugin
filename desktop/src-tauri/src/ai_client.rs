//! 往用户自己配的 OpenAI 兼容接口发一次请求。
//!
//! 规矩写死在这里：**不自动重试**（重试等于重复计费，data-privacy §8）、
//! **有硬超时**（挂死的中转服务不能让按钮永远转圈；强档请求流式接收，按多久没有新内容
//! 判断卡住，见 `StreamLimits`）、**日志只记状态码和耗时**
//! （§9：正文、Key、完整地址都不许进日志）、**只跟随同源跳转**（跨源的 307/308
//! 会把请求正文——证据或简历全文——原样重发给确认页上没出现过的主机）、
//! **响应边读边限大小**（超大响应不先整块读进内存）。

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::commands::CommandError;

/// 15 秒后界面出「还在等」，60 秒硬超时。超时按失败处理，不入库。
pub const SLOW_HINT_SECONDS: u64 = 15;
pub const TIMEOUT_SECONDS: u64 = 60;
/// 一次回答最多读这么多字节。20 万字的中文正文加上 JSON 外壳也就一两 MB，
/// 超过这个数不是正常回答，读到这里就停。
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// 同源跳转最多跟几次，防止来回跳。
const MAX_REDIRECTS: usize = 5;

/// AI 请求都自报产品名（#212）。不设的话 reqwest 不发任何 User-Agent：OpenCode Go 要求
/// 客户端自报名字，Cloudflare 前置的接口也常拦没有 UA 的请求。
pub const USER_AGENT: &str = concat!("wangshen-kuaitian-desktop/", env!("CARGO_PKG_VERSION"));

/// OpenCode（opencode.ai）要求每个对话带稳定的 `x-opencode-session`，用于路由和提示缓存，
/// 缺了会回 400 MissingSessionID（#212）。网申快填没有「对话」，用每次启动随机生成的一个
/// 编号：不含任何用户信息，只发给 OpenCode，别的服务商不带。
fn opencode_session(api_url: &str) -> Option<&'static str> {
    let url = reqwest::Url::parse(api_url).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if host != "opencode.ai" && !host.ends_with(".opencode.ai") {
        return None;
    }
    static SESSION: OnceLock<String> = OnceLock::new();
    Some(SESSION.get_or_init(|| uuid::Uuid::new_v4().to_string()).as_str())
}

/// 协议、主机、有效端口都相同才算同源。
fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
}

/// 流式接收时的三个时限（#283）。推理模型想得久，但想的时候也在不停地往回发内容；
/// 按「多久没收到新内容」判断卡死，慢而正常的生成就不会被总时长掐断。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamLimits {
    /// 等响应头；服务商不理会 `stream`、照旧整段返回时，也是等整段正文的时限。
    /// 和非流式的总超时取同一个值，这类服务商不会比以前等得更短。
    pub first_reply: Duration,
    /// 正文里两次收到数据最多隔多久。推理内容、心跳注释都算收到。
    pub idle: Duration,
    /// 一次生成最长多久，从发出请求算起。防止一直有零星数据却永远生成不完。
    pub total: Duration,
}

pub struct ChatClient {
    inner: reqwest::Client,
    /// 超时报错的文案要说实际配的这个值，不能写死成默认的 60 秒
    /// （简历解析用 `with_timeout(120s)`，说「等了 60 秒」是错的）。
    timeout: Duration,
    /// 有值时按 SSE 流式接收；这时客户端不设总超时，时限由这里管。
    stream: Option<StreamLimits>,
}

impl ChatClient {
    pub fn new() -> Result<Self, CommandError> {
        Self::with_timeout(Duration::from_secs(TIMEOUT_SECONDS))
    }

    /// 超时可注入：测试里等 60 秒没有意义。
    pub fn with_timeout(timeout: Duration) -> Result<Self, CommandError> {
        Ok(Self { inner: build_client(Some(timeout))?, timeout, stream: None })
    }

    /// 流式接收（#283）：请求带 `stream: true`，按 `limits` 判断超时。
    pub fn streaming(limits: StreamLimits) -> Result<Self, CommandError> {
        Ok(Self { inner: build_client(None)?, timeout: limits.first_reply, stream: Some(limits) })
    }

    /// 发一次 Chat Completions，返回模型输出的正文。
    ///
    /// 出错信息里带主机名和模型名，**不带 Key、不带完整地址、不带请求正文**。
    pub async fn chat(
        &self,
        api_url: &str,
        api_key: &str,
        host: &str,
        model: &str,
        body: &Value,
    ) -> Result<String, CommandError> {
        if let Some(limits) = self.stream {
            return self.chat_streamed(limits, api_url, api_key, host, model, body).await;
        }
        let started = Instant::now();
        let response = self
            .request(api_url, api_key, body)
            .send()
            .await
            .map_err(|err| self.send_failed(&err, host, model, started))?;
        let response = checked_status(response, host, model, started)?;
        let bytes = read_body(response, None, self.timeout, host, model, started).await?;
        content_of(&bytes, host)
    }

    async fn chat_streamed(
        &self,
        limits: StreamLimits,
        api_url: &str,
        api_key: &str,
        host: &str,
        model: &str,
        body: &Value,
    ) -> Result<String, CommandError> {
        let started = Instant::now();
        let start = tokio::time::Instant::now();
        let first_reply_by = start + limits.first_reply;
        let finish_by = start + limits.total;
        let mut body = body.clone();
        body["stream"] = Value::Bool(true);
        let response = match tokio::time::timeout_at(first_reply_by, self.request(api_url, api_key, &body).send()).await {
            Err(_) => {
                log_line(host, model, "timeout", started);
                return Err(timeout_error(limits.first_reply.as_secs(), host, model));
            }
            Ok(sent) => sent.map_err(|err| self.send_failed(&err, host, model, started))?,
        };
        let response = checked_status(response, host, model, started)?;
        let event_stream = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.trim().to_ascii_lowercase().starts_with("text/event-stream"));
        if !event_stream {
            // 不支持流式的服务商多半直接忽略 `stream`，照旧回一整段 JSON：按非流式的规矩读。
            let bytes = read_body(response, Some(first_reply_by), limits.first_reply, host, model, started).await?;
            return content_of(&bytes, host);
        }

        let mut response = response;
        let mut text = StreamText::default();
        while !text.done {
            let by = (tokio::time::Instant::now() + limits.idle).min(finish_by);
            match tokio::time::timeout_at(by, response.chunk()).await {
                Err(_) if by == finish_by => {
                    log_line(host, model, "stream-total-timeout", started);
                    let total = limits.total.as_secs();
                    let span = if total >= 60 && total % 60 == 0 { format!("{} 分钟", total / 60) } else { format!("{total} 秒") };
                    return Err(CommandError {
                        code: "AI_TIMEOUT".into(),
                        message: format!("生成超过 {span}还没有完成，这次没有产生建议（{host} · {model}）。"),
                    });
                }
                Err(_) => {
                    log_line(host, model, "stream-idle-timeout", started);
                    let seconds = limits.idle.as_secs();
                    return Err(CommandError {
                        code: "AI_TIMEOUT".into(),
                        message: format!("{seconds} 秒没有收到新内容，这次没有产生建议（{host} · {model}）。"),
                    });
                }
                Ok(Ok(Some(chunk))) => {
                    text.feed(&chunk).map_err(|fault| stream_failed(fault, host, model, started))?
                }
                Ok(Ok(None)) => break,
                Ok(Err(_)) => {
                    log_line(host, model, "body-error", started);
                    return Err(network_error(host));
                }
            }
        }
        let content = text.finish().map_err(|fault| stream_failed(fault, host, model, started))?;
        log_line(host, model, "stream-done", started);
        Ok(content)
    }

    fn request(&self, api_url: &str, api_key: &str, body: &Value) -> reqwest::RequestBuilder {
        let mut request = self.inner.post(api_url).bearer_auth(api_key).json(body);
        if let Some(session) = opencode_session(api_url) {
            request = request.header("x-opencode-session", session);
        }
        request
    }

    fn send_failed(&self, err: &reqwest::Error, host: &str, model: &str, started: Instant) -> CommandError {
        if err.is_timeout() {
            log_line(host, model, "timeout", started);
            timeout_error(self.timeout.as_secs(), host, model)
        } else {
            log_line(host, model, "network-error", started);
            network_error(host)
        }
    }
}

fn build_client(timeout: Option<Duration>) -> Result<reqwest::Client, CommandError> {
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        let first = attempt.previous().first().cloned();
        let stays = first.as_ref().is_some_and(|origin| same_origin(origin, attempt.url()));
        if stays && attempt.previous().len() <= MAX_REDIRECTS {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    let mut builder = reqwest::Client::builder().user_agent(USER_AGENT).redirect(redirects);
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|e| {
        // 原始错误里有本机的代理与 TLS 配置，写日志够了，不往界面上贴。
        eprintln!("ai: client-init-failed · {e}");
        CommandError {
            code: "AI_CLIENT_INIT_FAILED".into(),
            message: "HTTP 客户端没建起来，这次没有发出去。".into(),
        }
    })
}

fn timeout_error(seconds: u64, host: &str, model: &str) -> CommandError {
    CommandError {
        code: "AI_TIMEOUT".into(),
        message: format!("等了 {seconds} 秒还没有返回，这次没有产生建议（{host} · {model}）。"),
    }
}

fn network_error(host: &str) -> CommandError {
    CommandError {
        code: "AI_NETWORK".into(),
        message: format!("连不上 {host}，这次没有产生建议。"),
    }
}

fn too_large(host: &str) -> CommandError {
    CommandError {
        code: "AI_OUTPUT_TOO_LARGE".into(),
        message: format!("{host} 返回的内容过大（超过 {} MB），这次没有产生建议。", MAX_RESPONSE_BYTES / 1024 / 1024),
    }
}

fn checked_status(
    response: reqwest::Response,
    host: &str,
    model: &str,
    started: Instant,
) -> Result<reqwest::Response, CommandError> {
    let status = response.status();
    log_line(host, model, &format!("HTTP {}", status.as_u16()), started);
    if !status.is_success() {
        let hint = match status.as_u16() {
            300..=399 => "，对方要求跳转到另一个地址，为避免把内容发给没确认过的主机，没有跟随",
            401 | 403 => "，多半是 Key 不对或没有权限",
            404 => "，多半是接口地址或模型名不对",
            429 => "，服务商限流了",
            500..=599 => "，服务商那边出错了",
            _ => "",
        };
        return Err(CommandError {
            code: format!("AI_HTTP_{}", status.as_u16()),
            message: format!("{host} 返回 HTTP {}{hint}。", status.as_u16()),
        });
    }
    if response.content_length().is_some_and(|len| len > MAX_RESPONSE_BYTES as u64) {
        log_line(host, model, "body-too-large", started);
        return Err(too_large(host));
    }
    Ok(response)
}

/// 边读边限大小地读完整段正文。`by` 为空时靠客户端自己的总超时；`seconds` 只用于报错文案。
async fn read_body(
    mut response: reqwest::Response,
    by: Option<tokio::time::Instant>,
    seconds: Duration,
    host: &str,
    model: &str,
    started: Instant,
) -> Result<Vec<u8>, CommandError> {
    let mut bytes = Vec::new();
    loop {
        let next = match by {
            Some(by) => tokio::time::timeout_at(by, response.chunk()).await.ok(),
            None => Some(response.chunk().await),
        };
        match next {
            Some(Ok(Some(chunk))) => {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    log_line(host, model, "body-too-large", started);
                    return Err(too_large(host));
                }
                bytes.extend_from_slice(&chunk);
            }
            Some(Ok(None)) => return Ok(bytes),
            Some(Err(err)) if !err.is_timeout() => {
                log_line(host, model, "body-error", started);
                return Err(network_error(host));
            }
            // 客户端总超时，或者 `by` 到了。
            Some(Err(_)) | None => {
                log_line(host, model, "body-timeout", started);
                return Err(timeout_error(seconds.as_secs(), host, model));
            }
        }
    }
}

fn content_of(bytes: &[u8], host: &str) -> Result<String, CommandError> {
    let parsed: Value = serde_json::from_slice(bytes).map_err(|_| CommandError {
        code: "AI_BAD_RESPONSE".into(),
        message: format!("{host} 返回的不是 JSON，这次没有产生建议。"),
    })?;

    parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .filter(|content| !content.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| empty_reply(host))
}

fn empty_reply(host: &str) -> CommandError {
    CommandError {
        code: "AI_BAD_RESPONSE".into(),
        message: format!("{host} 没有返回可用的内容，这次没有产生建议。"),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StreamFault {
    TooLarge,
    /// 一行 `data:` 不是 JSON。
    Malformed,
    /// 服务商在流里发来了 `error`（生成到一半出错）。
    Upstream,
    Empty,
}

fn stream_failed(fault: StreamFault, host: &str, model: &str, started: Instant) -> CommandError {
    match fault {
        StreamFault::TooLarge => {
            log_line(host, model, "body-too-large", started);
            too_large(host)
        }
        StreamFault::Malformed => {
            log_line(host, model, "stream-malformed", started);
            CommandError {
                code: "AI_BAD_RESPONSE".into(),
                message: format!("{host} 返回的流式内容无法解析，这次没有产生建议。"),
            }
        }
        StreamFault::Upstream => {
            log_line(host, model, "stream-error", started);
            CommandError {
                code: "AI_BAD_RESPONSE".into(),
                message: format!("{host} 在生成途中报错，这次没有产生建议。"),
            }
        }
        StreamFault::Empty => {
            log_line(host, model, "stream-empty", started);
            empty_reply(host)
        }
    }
}

/// 把 OpenAI 兼容的 SSE 流（一行一个 `data: {...}`，以 `data: [DONE]` 结束）拼回完整正文。
/// 只收 `choices[0].delta.content`：推理内容（`reasoning_content`）和 `:` 开头的心跳只说明
/// 服务商还在干活，不进结果，也不占大小上限。
#[derive(Default)]
struct StreamText {
    line: Vec<u8>,
    content: String,
    done: bool,
}

impl StreamText {
    fn feed(&mut self, mut bytes: &[u8]) -> Result<(), StreamFault> {
        while !self.done {
            let Some(at) = bytes.iter().position(|byte| *byte == b'\n') else {
                self.line.extend_from_slice(bytes);
                break;
            };
            self.line.extend_from_slice(&bytes[..at]);
            bytes = &bytes[at + 1..];
            let line = std::mem::take(&mut self.line);
            self.take_line(&line)?;
        }
        if self.line.len() > MAX_RESPONSE_BYTES {
            return Err(StreamFault::TooLarge);
        }
        Ok(())
    }

    fn take_line(&mut self, line: &[u8]) -> Result<(), StreamFault> {
        // 空行、`:` 心跳、`event:` / `id:` 这些行都不带正文。
        let Some(data) = line.strip_prefix(b"data:") else { return Ok(()) };
        let data = data.trim_ascii();
        if data == b"[DONE]" {
            self.done = true;
            return Ok(());
        }
        let event: Value = serde_json::from_slice(data).map_err(|_| StreamFault::Malformed)?;
        if event.get("error").is_some_and(|error| !error.is_null()) {
            return Err(StreamFault::Upstream);
        }
        if let Some(piece) = event.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            if self.content.len() + piece.len() > MAX_RESPONSE_BYTES {
                return Err(StreamFault::TooLarge);
            }
            self.content.push_str(piece);
        }
        Ok(())
    }

    /// 流结束（`[DONE]` 或对方正常关闭连接）后取正文。
    fn finish(mut self) -> Result<String, StreamFault> {
        if !self.done && !self.line.is_empty() {
            let line = std::mem::take(&mut self.line);
            self.take_line(&line)?;
        }
        if self.content.trim().is_empty() {
            return Err(StreamFault::Empty);
        }
        Ok(self.content)
    }
}

/// 这一行是排障时唯一的线索，也是唯一允许写出去的东西：
/// 主机名、模型名、结果、耗时。**没有正文、没有 Key、没有完整地址**（data-privacy §9）。
fn log_line(host: &str, model: &str, outcome: &str, started: Instant) {
    eprintln!(
        "ai: {host} · {model} · {outcome} · {} ms",
        started.elapsed().as_millis()
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// 接受连接但永不回应，逼客户端自己的超时先触发（不依赖服务器配合）。
    /// 连上的 `stream` 必须留在作用域里陪着一起睡：`let _ = listener.accept()`
    /// 会把它当场丢掉，对端看到的是连接被关闭（`IncompleteMessage`），不是超时。
    fn accept_and_hang() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let Ok((_stream, _)) = listener.accept() else { return };
            std::thread::sleep(Duration::from_secs(5));
        });
        url
    }

    /// 回一次固定的原始 HTTP 响应，并把收到的请求原文交回来（没人连就交回空串）。
    fn serve_raw(reply: Vec<u8>) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(false).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let started = Instant::now();
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(pair) => break pair,
                    Err(_) if started.elapsed() < Duration::from_secs(3) => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => return String::new(),
                }
            };
            stream.set_nonblocking(false).unwrap();
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = stream.write_all(&reply);
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (base, handle)
    }

    fn ok_reply(content: &str) -> Vec<u8> {
        let body = serde_json::json!({ "choices": [{ "message": { "content": content } }] }).to_string();
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn a_cross_origin_redirect_is_not_followed_so_the_body_stays_put() {
        let (elsewhere, elsewhere_handle) = serve_raw(ok_reply("leaked"));
        let redirect = format!(
            "HTTP/1.1 307 Temporary Redirect\r\nlocation: {elsewhere}/v1/chat/completions\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        let (origin, origin_handle) = serve_raw(redirect.into_bytes());
        let client = ChatClient::with_timeout(Duration::from_secs(5)).unwrap();
        let body = serde_json::json!({ "resume": "张三的简历全文" });
        let err = client
            .chat(&format!("{origin}/v1/chat/completions"), "sk-test", "origin", "m1", &body)
            .await
            .unwrap_err();
        assert_eq!(err.code, "AI_HTTP_307");
        assert!(err.message.contains("跳转"), "{}", err.message);
        origin_handle.join().unwrap();
        assert_eq!(elsewhere_handle.join().unwrap(), "", "简历不该被重发到另一个来源");
    }

    #[tokio::test]
    async fn a_same_origin_redirect_is_followed() {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let moved = format!(
            "HTTP/1.1 308 Permanent Redirect\r\nlocation: {base}/v2/chat/completions\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        let handle = std::thread::spawn(move || {
            for reply in [moved.into_bytes(), ok_reply("[]")] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = vec![0u8; 65536];
                let _ = stream.read(&mut buf).unwrap();
                stream.write_all(&reply).unwrap();
            }
        });
        let client = ChatClient::with_timeout(Duration::from_secs(5)).unwrap();
        let text = client
            .chat(&format!("{base}/v1/chat/completions"), "sk-test", "h", "m1", &Value::Null)
            .await
            .unwrap();
        assert_eq!(text, "[]");
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn requests_name_the_product_and_other_providers_get_no_opencode_header() {
        let (base, handle) = serve_raw(ok_reply("[]"));
        let client = ChatClient::with_timeout(Duration::from_secs(5)).unwrap();
        client.chat(&format!("{base}/v1/chat/completions"), "sk-test", "h", "m1", &Value::Null).await.unwrap();
        let request = handle.join().unwrap().to_ascii_lowercase();
        assert!(request.contains(&format!("user-agent: {}", USER_AGENT)), "{request}");
        assert!(!request.contains("x-opencode-session"), "{request}");
    }

    #[test]
    fn only_opencode_gets_a_session_and_it_stays_the_same_for_the_run() {
        let first = opencode_session("https://opencode.ai/zen/go/v1/chat/completions").unwrap();
        assert!(uuid::Uuid::parse_str(first).is_ok(), "{first}");
        assert_eq!(opencode_session("https://OPENCODE.AI/zen/v1/chat/completions"), Some(first));
        for other in [
            "https://api.deepseek.com/v1/chat/completions",
            "https://opencode.ai.relay.example/zen/go/v1/chat/completions",
            "https://relay.example/opencode.ai/v1/chat/completions",
            "not a url",
        ] {
            assert_eq!(opencode_session(other), None, "{other}");
        }
        assert!(USER_AGENT.starts_with("wangshen-kuaitian-desktop/"));
    }

    #[tokio::test]
    async fn an_oversized_response_is_refused_while_reading() {
        let big = "x".repeat(MAX_RESPONSE_BYTES + 1);
        // 不带 content-length（分块），逼客户端边读边数，而不是看头就拒。
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n{:x}\r\n{big}\r\n0\r\n\r\n",
            big.len()
        );
        let (base, handle) = serve_raw(reply.into_bytes());
        let client = ChatClient::with_timeout(Duration::from_secs(5)).unwrap();
        let err = client
            .chat(&format!("{base}/v1/chat/completions"), "sk-test", "h", "m1", &Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.code, "AI_OUTPUT_TOO_LARGE");
        let _ = handle.join();
    }

    #[tokio::test]
    async fn the_timeout_message_names_the_timeout_this_client_was_built_with() {
        let url = accept_and_hang();
        // 用一个明显不是默认值（60 秒）的超时构造客户端：报错文案要说这个数，
        // 不能不管实际配置、永远说「60 秒」。
        let client = ChatClient::with_timeout(Duration::from_secs(1)).unwrap();
        let err = client
            .chat(&url, "sk-test", "example.com", "m1", &Value::Null)
            .await
            .unwrap_err();
        assert_eq!(err.code, "AI_TIMEOUT");
        assert!(err.message.contains("等了 1 秒"), "{}", err.message);
        assert!(!err.message.contains("60 秒"), "{}", err.message);
    }

    // ---- #283 流式接收 ----

    const SSE_HEAD: &str = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream; charset=utf-8\r\nconnection: close\r\n\r\n";

    /// 先回响应头，再按 `(等多少毫秒, 内容)` 一段段写；`hang` 为真时写完不关连接，一直挂着。
    /// 交回收到的请求原文。
    fn serve_paced(head: &str, steps: Vec<(u64, String)>, hang: bool) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        let head = head.to_string();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = stream.write_all(head.as_bytes());
            for (delay, piece) in steps {
                std::thread::sleep(Duration::from_millis(delay));
                if stream.write_all(piece.as_bytes()).is_err() {
                    break;
                }
                let _ = stream.flush();
            }
            if hang {
                std::thread::sleep(Duration::from_secs(5));
            }
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        (url, handle)
    }

    fn delta(content: &str) -> String {
        format!("data: {}\n\n", serde_json::json!({ "choices": [{ "delta": { "content": content } }] }))
    }

    fn reasoning(text: &str) -> String {
        format!("data: {}\n\n", serde_json::json!({ "choices": [{ "delta": { "reasoning_content": text } }] }))
    }

    fn limits(first_reply_ms: u64, idle_ms: u64, total_ms: u64) -> StreamLimits {
        StreamLimits {
            first_reply: Duration::from_millis(first_reply_ms),
            idle: Duration::from_millis(idle_ms),
            total: Duration::from_millis(total_ms),
        }
    }

    #[tokio::test]
    async fn a_stream_is_assembled_from_content_deltas_only() {
        let steps = vec![
            (0, ": keep-alive\n\n".to_string()),
            (0, reasoning("先想一想")),
            (0, delta("[{\"fieldId\":")),
            (0, delta("\"f1\",\"value\":\"张三\"}]")),
            (0, "data: [DONE]\n\n".to_string()),
        ];
        let (url, server) = serve_paced(SSE_HEAD, steps, false);
        let client = ChatClient::streaming(limits(5_000, 2_000, 5_000)).unwrap();
        let text = client.chat(&url, "sk-test", "h", "m1", &serde_json::json!({ "model": "m1" })).await.unwrap();
        assert_eq!(text, "[{\"fieldId\":\"f1\",\"value\":\"张三\"}]");
        let request = server.join().unwrap();
        assert!(request.contains(r#""stream":true"#), "{request}");
    }

    /// 推理模型想得久：总耗时超过空闲时限好几倍，但一直有内容回来，不能被掐断。
    #[tokio::test]
    async fn a_slow_stream_that_keeps_sending_is_not_cut_off() {
        let mut steps: Vec<(u64, String)> = (0..8).map(|_| (300, reasoning("……"))).collect();
        steps.push((300, delta("[]")));
        steps.push((0, "data: [DONE]\n\n".to_string()));
        let (url, server) = serve_paced(SSE_HEAD, steps, false);
        let client = ChatClient::streaming(limits(5_000, 1_000, 10_000)).unwrap();
        let started = Instant::now();
        let text = client.chat(&url, "sk-test", "h", "m1", &Value::Null).await.unwrap();
        assert_eq!(text, "[]");
        assert!(started.elapsed() > Duration::from_millis(2_000), "{:?}", started.elapsed());
        server.join().unwrap();
    }

    #[tokio::test]
    async fn a_stream_that_goes_quiet_stops_at_the_idle_limit() {
        let (url, _server) = serve_paced(SSE_HEAD, vec![(0, reasoning("想到一半"))], true);
        let client = ChatClient::streaming(limits(5_000, 500, 10_000)).unwrap();
        let started = Instant::now();
        let err = client.chat(&url, "sk-test", "example.com", "m1", &Value::Null).await.unwrap_err();
        assert_eq!(err.code, "AI_TIMEOUT");
        assert!(err.message.contains("秒没有收到新内容"), "{}", err.message);
        assert!(err.message.contains("example.com · m1"), "{}", err.message);
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_stream_that_never_finishes_stops_at_the_total_limit() {
        let steps = (0..40).map(|_| (100, ": keep-alive\n\n".to_string())).collect();
        let (url, _server) = serve_paced(SSE_HEAD, steps, true);
        let client = ChatClient::streaming(limits(5_000, 1_000, 1_000)).unwrap();
        let started = Instant::now();
        let err = client.chat(&url, "sk-test", "h", "m1", &Value::Null).await.unwrap_err();
        assert_eq!(err.code, "AI_TIMEOUT");
        assert!(err.message.contains("生成超过 1 秒还没有完成"), "{}", err.message);
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn no_reply_at_all_stops_at_the_first_reply_limit() {
        let url = accept_and_hang();
        let client = ChatClient::streaming(limits(1_000, 60_000, 600_000)).unwrap();
        let err = client.chat(&url, "sk-test", "example.com", "m1", &Value::Null).await.unwrap_err();
        assert_eq!(err.code, "AI_TIMEOUT");
        assert!(err.message.contains("等了 1 秒"), "{}", err.message);
    }

    /// 不支持流式的服务商忽略 `stream`，照旧回整段 JSON：照常解析。
    #[tokio::test]
    async fn a_provider_that_ignores_stream_is_read_as_one_json_reply() {
        let (base, server) = serve_raw(ok_reply("[]"));
        let client = ChatClient::streaming(limits(5_000, 1_000, 5_000)).unwrap();
        let text = client.chat(&format!("{base}/v1/chat/completions"), "sk-test", "h", "m1", &Value::Null).await.unwrap();
        assert_eq!(text, "[]");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn an_error_event_in_the_stream_fails_without_partial_text() {
        let steps = vec![
            (0, delta("[{\"fieldId\":")),
            (0, "data: {\"error\":{\"message\":\"overloaded\"}}\n\n".to_string()),
        ];
        let (url, _server) = serve_paced(SSE_HEAD, steps, false);
        let client = ChatClient::streaming(limits(5_000, 1_000, 5_000)).unwrap();
        let err = client.chat(&url, "sk-test", "h", "m1", &Value::Null).await.unwrap_err();
        assert_eq!(err.code, "AI_BAD_RESPONSE");
        assert!(!err.message.contains("overloaded"), "服务商的报错原文不进界面：{}", err.message);
    }

    #[tokio::test]
    async fn a_streamed_http_error_keeps_its_status() {
        let (url, _server) = serve_paced(
            "HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            vec![],
            false,
        );
        let client = ChatClient::streaming(limits(5_000, 1_000, 5_000)).unwrap();
        let err = client.chat(&url, "sk-test", "h", "m1", &Value::Null).await.unwrap_err();
        assert_eq!(err.code, "AI_HTTP_429");
    }

    #[test]
    fn stream_lines_split_anywhere_still_join_up() {
        let whole = format!("{}{}\r\n{}data: [DONE]\n\ndata: {{\"choices\":[{{\"delta\":{{\"content\":\"之后\"}}}}]}}\n",
            delta("网申"), ": ping", delta("快填"));
        let bytes = whole.as_bytes();
        // 每一个切点都试一遍，包括切在一个汉字的 UTF-8 字节中间。
        for cut in 0..=bytes.len() {
            let mut text = StreamText::default();
            text.feed(&bytes[..cut]).unwrap();
            text.feed(&bytes[cut..]).unwrap();
            assert_eq!(text.finish().unwrap(), "网申快填", "cut at {cut}");
        }
    }

    #[test]
    fn a_stream_that_ends_without_done_keeps_what_arrived() {
        let mut text = StreamText::default();
        text.feed(delta("[]").trim_end().as_bytes()).unwrap();
        assert_eq!(text.finish().unwrap(), "[]");
        let mut empty = StreamText::default();
        empty.feed(reasoning("只想不写").as_bytes()).unwrap();
        assert_eq!(empty.finish().unwrap_err(), StreamFault::Empty);
        let mut bad = StreamText::default();
        assert_eq!(bad.feed(b"data: {not json\n").unwrap_err(), StreamFault::Malformed);
    }

    #[test]
    fn stream_size_is_counted_on_content_not_on_reasoning() {
        let mut text = StreamText::default();
        // 三段推理内容合计约 1.5 倍上限。
        let thinking = "想".repeat(MAX_RESPONSE_BYTES / 6);
        for _ in 0..3 {
            text.feed(reasoning(&thinking).as_bytes()).unwrap();
        }
        text.feed(delta("[]").as_bytes()).unwrap();
        assert_eq!(text.finish().unwrap(), "[]");
        let mut big = StreamText::default();
        let piece = "x".repeat(MAX_RESPONSE_BYTES / 2 + 1);
        big.feed(delta(&piece).as_bytes()).unwrap();
        assert_eq!(big.feed(delta(&piece).as_bytes()).unwrap_err(), StreamFault::TooLarge);
    }
}
