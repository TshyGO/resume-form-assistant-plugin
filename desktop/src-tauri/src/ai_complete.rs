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
    ChatClient::with_timeout(timeout)?
        .chat(&provider.api_url, key, &host, &provider.model, &body)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_settings::AiProvider;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve_once(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<String>) {
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
}
