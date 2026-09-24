//! 用给定服务商问一次 Chat Completions，返回正文。简历解析（PR 2b）与插件经桌面转发的
//! `ai.complete`（PR 3）共用这一个函数，规矩与 `ai_client` 相同：不重试、有硬超时、
//! 日志只记主机名与耗时。提示词由调用方给，这里不理解业务。

use std::time::Duration;

use serde_json::json;

use crate::ai_client::ChatClient;
use crate::ai_settings::{host_of, AiProvider};
use crate::commands::CommandError;

/// 系统提示词与用户内容的上限（字符数）。简历全文一般几千字；超过这个数多半选错了文件，
/// 也不该一次把这么多内容发给服务商。
pub const MAX_SYSTEM_CHARS: usize = 8_000;
pub const MAX_USER_CHARS: usize = 60_000;
/// 解析一份长简历，慢的模型可能要一两分钟。
pub const COMPLETE_TIMEOUT: Duration = Duration::from_secs(120);
/// 模型返回的正文上限（字符数）。正常的简历解析结果是一份 JSON 数组，几千字封顶；
/// 远超这个数多半是模型发疯了（复读、把系统提示词或整份原文吐回来），这种内容不该
/// 被当成解析结果存进模板。
pub const MAX_OUTPUT_CHARS: usize = 200_000;

pub fn check_sizes(system: &str, user: &str) -> Result<(), CommandError> {
    // 两条分开的消息：系统提示词超限时不能说成是用户内容超限，那样用户会去找错文件、
    // 却怎么删减都没用——真正超限的是提示词，不是他选的那份简历。
    if system.chars().count() > MAX_SYSTEM_CHARS {
        return Err(CommandError {
            code: "AI_INPUT_TOO_LARGE".into(),
            message: format!("系统提示词超过 {MAX_SYSTEM_CHARS} 字，没有发送。"),
        });
    }
    if user.chars().count() > MAX_USER_CHARS {
        return Err(CommandError {
            code: "AI_INPUT_TOO_LARGE".into(),
            message: format!("要发给 AI 的内容超过 {MAX_USER_CHARS} 字，没有发送。确认选对了文件。"),
        });
    }
    Ok(())
}

/// `ai_inflight::begin` 的「正在分析」错误是为证据整理写的用词（「这条证据正在分析中」）；
/// 简历解析没有「证据」这个概念，换成贴合这个场景的话。其余错误码原样放行。
pub fn resume_busy_message(err: CommandError) -> CommandError {
    if err.code == "AI_BUSY" {
        CommandError {
            code: "AI_BUSY".into(),
            message: "上一份简历还在解析中，等它结束或先取消。".into(),
        }
    } else {
        err
    }
}

/// 确认外发时看到的服务商，和真正发送时「当前使用」的服务商必须是同一个：确认之后
/// 用户在设置页切换了服务商，不能拿新服务商的 Key 去发一份用户以为发给旧服务商的内容。
pub fn check_provider_unchanged(current_id: &str, confirmed_id: &str) -> Result<(), CommandError> {
    if current_id == confirmed_id {
        Ok(())
    } else {
        Err(CommandError {
            code: "AI_PROVIDER_CHANGED".into(),
            message: "当前服务商在确认之后变了，请重新选择文件确认一次。".into(),
        })
    }
}

pub async fn complete(
    provider: &AiProvider,
    key: &str,
    system: &str,
    user: &str,
    timeout: Duration,
) -> Result<String, CommandError> {
    check_sizes(system, user)?;
    let body = json!({
        "model": provider.model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    let host = host_of(&provider.api_url);
    let text = ChatClient::with_timeout(timeout)?
        .chat(&provider.api_url, key, &host, &provider.model, &body)
        .await?;
    if text.chars().count() > MAX_OUTPUT_CHARS {
        return Err(CommandError {
            code: "AI_OUTPUT_TOO_LARGE".into(),
            message: "AI 返回的内容过长（超过 20 万字），没有保存。".into(),
        });
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_settings::AiProvider;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve_once(status: u16, body: impl Into<String>) -> (String, std::thread::JoinHandle<String>) {
        let body = body.into();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
            request
        });
        (url, handle)
    }

    fn provider(url: &str) -> AiProvider {
        AiProvider { id: "p".into(), name: "P".into(), api_url: url.into(), model: "m1".into() }
    }

    #[tokio::test]
    async fn it_sends_system_and_user_and_returns_the_text() {
        let (url, server) = serve_once(200, r#"{"choices":[{"message":{"content":"[]"}}]}"#);
        let text = complete(&provider(&url), "sk-test", "SYS", "USER", Duration::from_secs(5)).await.unwrap();
        assert_eq!(text, "[]");
        let request = server.join().unwrap();
        assert!(request.contains("authorization: Bearer sk-test") || request.contains("Authorization: Bearer sk-test"));
        assert!(request.contains(r#""model":"m1""#));
        assert!(request.contains(r#""temperature":0"#));
        assert!(request.contains("SYS") && request.contains("USER"));
    }

    #[test]
    fn oversized_input_is_refused_before_sending() {
        let long = "字".repeat(MAX_USER_CHARS + 1);
        let err = check_sizes("s", &long).unwrap_err();
        assert_eq!(err.code, "AI_INPUT_TOO_LARGE");
        assert!(!err.message.contains("系统提示词"), "{}", err.message);
        let system_err = check_sizes(&"s".repeat(MAX_SYSTEM_CHARS + 1), "u").unwrap_err();
        assert!(system_err.message.contains("系统提示词"), "系统提示词超限不该被说成是用户内容超限：{}", system_err.message);
        assert!(check_sizes("s", "u").is_ok());
    }

    #[test]
    fn resume_busy_message_rewrites_only_the_busy_code() {
        // `ai_inflight::begin` 是给「证据」整理写的措辞；简历解析没有证据，
        // 原样透传会让用户看不懂「这条证据正在分析中」说的是什么。
        let busy = CommandError {
            code: "AI_BUSY".into(),
            message: "这条证据正在分析中。等它结束，或者先取消。".into(),
        };
        let rewritten = resume_busy_message(busy);
        assert_eq!(rewritten.code, "AI_BUSY");
        assert_eq!(rewritten.message, "上一份简历还在解析中，等它结束或先取消。");

        // 别的错误码原样放行，不能被这一层吞掉或改写。
        let other = CommandError { code: "AI_NOT_CONFIGURED".into(), message: "还没有配置 AI 服务商。".into() };
        let passthrough = resume_busy_message(CommandError { code: other.code.clone(), message: other.message.clone() });
        assert_eq!(passthrough.code, other.code);
        assert_eq!(passthrough.message, other.message);
    }

    #[test]
    fn check_provider_unchanged_rejects_a_mismatch() {
        assert!(check_provider_unchanged("p1", "p1").is_ok());
        let err = check_provider_unchanged("p2", "p1").unwrap_err();
        assert_eq!(err.code, "AI_PROVIDER_CHANGED");
        assert_eq!(err.message, "当前服务商在确认之后变了，请重新选择文件确认一次。");
    }

    #[tokio::test]
    async fn oversized_output_is_refused_after_receiving() {
        let long = "字".repeat(MAX_OUTPUT_CHARS + 1);
        let body = format!(r#"{{"choices":[{{"message":{{"content":"{long}"}}}}]}}"#);
        let (url, _server) = serve_once(200, body);
        let err = complete(&provider(&url), "sk-test", "SYS", "USER", Duration::from_secs(5))
            .await
            .unwrap_err();
        assert_eq!(err.code, "AI_OUTPUT_TOO_LARGE");
    }
}
