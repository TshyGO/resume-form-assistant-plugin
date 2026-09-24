//! 往用户自己配的 OpenAI 兼容接口发一次请求。
//!
//! 规矩写死在这里：**不自动重试**（重试等于重复计费，data-privacy §8）、
//! **有硬超时**（挂死的中转服务不能让按钮永远转圈）、**日志只记状态码和耗时**
//! （§9：正文、Key、完整地址都不许进日志）、**只跟随同源跳转**（跨源的 307/308
//! 会把请求正文——证据或简历全文——原样重发给确认页上没出现过的主机）、
//! **响应边读边限大小**（超大响应不先整块读进内存）。

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

/// 协议、主机、有效端口都相同才算同源。
fn same_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str().map(str::to_ascii_lowercase) == b.host_str().map(str::to_ascii_lowercase)
        && a.port_or_known_default() == b.port_or_known_default()
}

pub struct ChatClient {
    inner: reqwest::Client,
    /// 超时报错的文案要说实际配的这个值，不能写死成默认的 60 秒
    /// （简历解析用 `with_timeout(120s)`，说「等了 60 秒」是错的）。
    timeout: Duration,
}

impl ChatClient {
    pub fn new() -> Result<Self, CommandError> {
        Self::with_timeout(Duration::from_secs(TIMEOUT_SECONDS))
    }

    /// 超时可注入：测试里等 60 秒没有意义。
    pub fn with_timeout(timeout: Duration) -> Result<Self, CommandError> {
        let redirects = reqwest::redirect::Policy::custom(|attempt| {
            let first = attempt.previous().first().cloned();
            let stays = first.as_ref().is_some_and(|origin| same_origin(origin, attempt.url()));
            if stays && attempt.previous().len() <= MAX_REDIRECTS {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });
        let inner = reqwest::Client::builder()
            .timeout(timeout)
            .redirect(redirects)
            .build()
            .map_err(|e| {
                // 原始错误里有本机的代理与 TLS 配置，写日志够了，不往界面上贴。
                eprintln!("ai: client-init-failed · {e}");
                CommandError {
                    code: "AI_CLIENT_INIT_FAILED".into(),
                    message: "HTTP 客户端没建起来，这次没有发出去。".into(),
                }
            })?;
        Ok(Self { inner, timeout })
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
        let started = Instant::now();
        let response = self
            .inner
            .post(api_url)
            .bearer_auth(api_key)
            .json(body)
            .send()
            .await
            .map_err(|err| {
                if err.is_timeout() {
                    log_line(host, model, "timeout", started);
                    let seconds = self.timeout.as_secs();
                    CommandError {
                        code: "AI_TIMEOUT".into(),
                        message: format!(
                            "等了 {seconds} 秒还没有返回，这次没有产生建议（{host} · {model}）。"
                        ),
                    }
                } else {
                    log_line(host, model, "network-error", started);
                    CommandError {
                        code: "AI_NETWORK".into(),
                        message: format!("连不上 {host}，这次没有产生建议。"),
                    }
                }
            })?;

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

        let too_large = || CommandError {
            code: "AI_OUTPUT_TOO_LARGE".into(),
            message: format!("{host} 返回的内容过大（超过 {} MB），这次没有产生建议。", MAX_RESPONSE_BYTES / 1024 / 1024),
        };
        if response.content_length().is_some_and(|len| len > MAX_RESPONSE_BYTES as u64) {
            log_line(host, model, "body-too-large", started);
            return Err(too_large());
        }
        let mut response = response;
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                        log_line(host, model, "body-too-large", started);
                        return Err(too_large());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(err) if err.is_timeout() => {
                    log_line(host, model, "body-timeout", started);
                    let seconds = self.timeout.as_secs();
                    return Err(CommandError {
                        code: "AI_TIMEOUT".into(),
                        message: format!("等了 {seconds} 秒还没有返回，这次没有产生建议（{host} · {model}）。"),
                    });
                }
                Err(_) => {
                    log_line(host, model, "body-error", started);
                    return Err(CommandError {
                        code: "AI_NETWORK".into(),
                        message: format!("连不上 {host}，这次没有产生建议。"),
                    });
                }
            }
        }

        let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| CommandError {
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
            .ok_or_else(|| CommandError {
                code: "AI_BAD_RESPONSE".into(),
                message: format!("{host} 没有返回可用的内容，这次没有产生建议。"),
            })
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
}
