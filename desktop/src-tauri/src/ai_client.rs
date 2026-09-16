//! 往用户自己配的 OpenAI 兼容接口发一次请求。
//!
//! 三条规矩写死在这里：**不自动重试**（重试等于重复计费，data-privacy §8）、
//! **有硬超时**（挂死的中转服务不能让按钮永远转圈）、**日志只记状态码和耗时**
//! （§9：正文、Key、完整地址都不许进日志）。

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::commands::CommandError;

/// 15 秒后界面出「还在等」，60 秒硬超时。超时按失败处理，不入库。
pub const SLOW_HINT_SECONDS: u64 = 15;
pub const TIMEOUT_SECONDS: u64 = 60;

pub struct ChatClient {
    inner: reqwest::Client,
}

impl ChatClient {
    pub fn new() -> Result<Self, CommandError> {
        Self::with_timeout(Duration::from_secs(TIMEOUT_SECONDS))
    }

    /// 超时可注入：测试里等 60 秒没有意义。
    pub fn with_timeout(timeout: Duration) -> Result<Self, CommandError> {
        let inner = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| {
                // 原始错误里有本机的代理与 TLS 配置，写日志够了，不往界面上贴。
                eprintln!("ai: client-init-failed · {e}");
                CommandError {
                    code: "AI_CLIENT_INIT_FAILED".into(),
                    message: "HTTP 客户端没建起来，这次没有发出去。".into(),
                }
            })?;
        Ok(Self { inner })
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
                    CommandError {
                        code: "AI_TIMEOUT".into(),
                        message: format!(
                            "等了 {TIMEOUT_SECONDS} 秒还没有返回，这次没有产生建议（{host} · {model}）。"
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

        let parsed: Value = response.json().await.map_err(|_| CommandError {
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
