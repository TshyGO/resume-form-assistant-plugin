//! 用给定服务商问一次 Chat Completions，返回正文。简历解析（PR 2b）与插件经桌面转发的
//! `ai.complete`（PR 3）共用这一个函数，规矩与 `ai_client` 相同：不重试、有硬超时、
//! 日志只记主机名与耗时。提示词由调用方给，这里不理解业务。

use std::time::Duration;

use serde_json::json;

use crate::ai_client::{ChatClient, StreamLimits, Timing};
use crate::ai_settings::{host_of, AiProvider};
use crate::commands::CommandError;

/// 系统提示词与用户内容的上限（字符数）。简历全文一般几千字；超过这个数多半选错了文件，
/// 也不该一次把这么多内容发给服务商。
pub const MAX_SYSTEM_CHARS: usize = 8_000;
pub const MAX_USER_CHARS: usize = 60_000;
/// 解析一份长简历，慢的模型可能要一两分钟。
pub const COMPLETE_TIMEOUT: Duration = Duration::from_secs(120);
/// 插件的「深度分析」（purpose=analyze，#223）：强模型读整页大纲，比填写慢。插件到桌面
/// 这一路没有别的定时器，等多久由这里决定；插件取消会关掉端口，不必等到这个时间。
pub const ANALYZE_TIMEOUT: Duration = Duration::from_secs(180);

/// 插件经桌面转发的 `ai.complete` 等多久：只有 `analyze` 用 180 秒。
pub fn timeout_for(purpose: &str) -> Duration {
    if purpose == "analyze" { ANALYZE_TIMEOUT } else { COMPLETE_TIMEOUT }
}

/// 强档请求（深度分析、强模型填写）流式接收时，多久没收到新内容算卡住（#283）。
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// 强档请求一次生成最长多久。推理模型在大页面上要两三分钟，这里留足余量；用户随时可以停止。
pub const STREAM_TOTAL_TIMEOUT: Duration = Duration::from_secs(600);

/// 插件停止或断开之后，多久内发现并丢掉这次请求（#283）。
pub const CANCEL_POLL: Duration = Duration::from_millis(500);

/// 怎么等服务商的回答。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    /// 非流式，整次请求一个总超时。
    Whole(Duration),
    /// 流式接收，按空闲时间判断卡住（#283）。
    Stream(StreamLimits),
}

/// 插件经桌面转发的 `ai.complete` 怎么等：强档（带推理的强模型可能想很久）流式接收，
/// 其余用途照旧整段等 `timeout_for`，回归面最小。
pub fn wait_for(purpose: &str, strong: bool) -> Wait {
    if strong {
        Wait::Stream(StreamLimits {
            first_reply: timeout_for(purpose),
            idle: STREAM_IDLE_TIMEOUT,
            total: STREAM_TOTAL_TIMEOUT,
        })
    } else {
        Wait::Whole(timeout_for(purpose))
    }
}
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
    wait: Wait,
) -> Result<String, CommandError> {
    complete_timed(provider, key, system, user, wait).await.0
}

/// 和 `complete` 一样，另外交回这次的计时（#299）。没发出去的请求计时为空。
pub async fn complete_timed(
    provider: &AiProvider,
    key: &str,
    system: &str,
    user: &str,
    wait: Wait,
) -> (Result<String, CommandError>, Timing) {
    if let Err(err) = check_sizes(system, user) {
        return (Err(err), Timing::default());
    }
    let body = json!({
        "model": provider.model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    let host = host_of(&provider.api_url);
    let client = match wait {
        Wait::Whole(timeout) => ChatClient::with_timeout(timeout),
        Wait::Stream(limits) => ChatClient::streaming(limits),
    };
    let client = match client {
        Ok(client) => client,
        Err(err) => return (Err(err), Timing::default()),
    };
    let (text, timing) = client.chat_timed(&provider.api_url, key, &host, &provider.model, &body).await;
    let text = text.and_then(|text| {
        if text.chars().count() > MAX_OUTPUT_CHARS {
            return Err(CommandError {
                code: "AI_OUTPUT_TOO_LARGE".into(),
                message: "AI 返回的内容过长（超过 20 万字），没有保存。".into(),
            });
        }
        Ok(text)
    });
    (text, timing)
}

/// 和 `complete` 一样，但调用方走了就不再等（#283）：每 `CANCEL_POLL` 问一次 `peer_gone`，
/// 为真就丢掉这次请求，连带关掉和服务商的连接，返回 `None`。流式生成时服务商一般会因此
/// 停下，但不保证停止计算或计费。
pub async fn complete_unless_gone(
    provider: &AiProvider,
    key: &str,
    system: &str,
    user: &str,
    wait: Wait,
    peer_gone: &dyn Fn() -> bool,
) -> Option<(Result<String, CommandError>, Timing)> {
    let started = std::time::Instant::now();
    tokio::select! {
        completed = complete_timed(provider, key, system, user, wait) => Some(completed),
        () = departure(peer_gone) => {
            crate::ai_client::log_line(&host_of(&provider.api_url), &provider.model, "cancelled", started);
            None
        }
    }
}

async fn departure(peer_gone: &dyn Fn() -> bool) {
    loop {
        tokio::time::sleep(CANCEL_POLL).await;
        if peer_gone() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_client::TimeoutStage;
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
        let text = complete(&provider(&url), "sk-test", "SYS", "USER", Wait::Whole(Duration::from_secs(5))).await.unwrap();
        assert_eq!(text, "[]");
        let request = server.join().unwrap();
        assert!(request.contains("authorization: Bearer sk-test") || request.contains("Authorization: Bearer sk-test"));
        assert!(request.contains(r#""model":"m1""#));
        assert!(request.contains(r#""temperature":0"#));
        assert!(request.contains("SYS") && request.contains("USER"));
    }

    #[test]
    fn only_analyze_waits_longer() {
        assert_eq!(timeout_for("analyze"), Duration::from_secs(180));
        for purpose in ["fill", "plan", "extract_job"] {
            assert_eq!(timeout_for(purpose), Duration::from_secs(120), "{purpose}");
        }
    }

    #[test]
    fn only_strong_requests_stream() {
        assert_eq!(wait_for("fill", false), Wait::Whole(COMPLETE_TIMEOUT));
        assert_eq!(wait_for("extract_job", false), Wait::Whole(COMPLETE_TIMEOUT));
        for (purpose, first_reply) in [("analyze", ANALYZE_TIMEOUT), ("fill", COMPLETE_TIMEOUT)] {
            assert_eq!(
                wait_for(purpose, true),
                Wait::Stream(StreamLimits { first_reply, idle: STREAM_IDLE_TIMEOUT, total: STREAM_TOTAL_TIMEOUT }),
                "{purpose}"
            );
        }
    }

    #[tokio::test]
    async fn a_streamed_completion_sends_the_same_prompt_with_stream_on() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let n = stream.read(&mut buf).unwrap();
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"[]\"}}]}\n\ndata: [DONE]\n\n";
            stream.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}").as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..n]).to_string()
        });
        let text = complete(&provider(&url), "sk-test", "SYS", "USER", wait_for("analyze", true)).await.unwrap();
        assert_eq!(text, "[]");
        let request = server.join().unwrap();
        assert!(request.contains(r#""stream":true"#) && request.contains(r#""temperature":0"#), "{request}");
        assert!(request.contains("SYS") && request.contains("USER"));
    }

    /// 插件停止后：桌面在一个轮询间隔内放弃这次请求，并关掉和服务商的连接。
    /// 多线程运行时：关连接的是 HTTP 客户端在运行时里的后台任务，和正式环境一样。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_request_is_dropped_soon_after_its_caller_leaves() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        // 一直在「思考」的服务商：每 100 毫秒发一段，直到连接被关掉。
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 65536];
            let _ = stream.read(&mut buf).unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n").unwrap();
            let started = std::time::Instant::now();
            let line = b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"...\"}}]}\n\n";
            while started.elapsed() < Duration::from_secs(10) {
                if stream.write_all(line).and_then(|_| stream.flush()).is_err() {
                    return Some(started.elapsed());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            None
        });
        let gone = Arc::new(AtomicBool::new(false));
        let leaving = Arc::clone(&gone);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            leaving.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        let reply = complete_unless_gone(&provider(&url), "sk-test", "SYS", "USER", wait_for("analyze", true), &|| gone.load(Ordering::SeqCst)).await;
        let reply = reply.map(|(result, _)| result);
        assert!(reply.is_none(), "{reply:?}");
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
        let closed_after = tokio::task::spawn_blocking(move || server.join().unwrap()).await.unwrap();
        assert!(closed_after.is_some_and(|after| after < Duration::from_secs(4)), "the provider connection is closed: {closed_after:?}");
    }

    #[tokio::test]
    async fn a_caller_that_stays_gets_the_answer() {
        let (url, server) = serve_once(200, r#"{"choices":[{"message":{"content":"[]"}}]}"#);
        let (result, timing) = complete_unless_gone(&provider(&url), "sk-test", "SYS", "USER", Wait::Whole(Duration::from_secs(5)), &|| false).await.unwrap();
        assert_eq!(result.unwrap(), "[]");
        assert!(timing.first_byte.is_some() && timing.timeout_stage.is_none(), "{timing:?}");
        server.join().unwrap();
    }

    /// 插件经桌面转发的请求超时了，交回停在哪一步（#299）。
    #[tokio::test]
    async fn a_timed_out_completion_says_where_it_stopped() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let Ok((_stream, _)) = listener.accept() else { return };
            std::thread::sleep(Duration::from_secs(3));
        });
        let (result, timing) = complete_unless_gone(&provider(&url), "sk-test", "SYS", "USER", Wait::Whole(Duration::from_millis(500)), &|| false).await.unwrap();
        assert_eq!(result.unwrap_err().code, "AI_TIMEOUT");
        assert_eq!(timing.timeout_stage, Some(TimeoutStage::FirstByte));
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
        let err = complete(&provider(&url), "sk-test", "SYS", "USER", Wait::Whole(Duration::from_secs(5)))
            .await
            .unwrap_err();
        assert_eq!(err.code, "AI_OUTPUT_TOO_LARGE");
    }
}
