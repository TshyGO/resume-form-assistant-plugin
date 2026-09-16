//! D11 请求链路的回归测试。
//!
//! 这里每一条都在问同一个问题：**这次请求会不会把不该发的东西发出去，
//! 或者把不该写的东西写进档案。**
//!
//! 请求用本机起的假服务器，不联外网：CI 上不能依赖任何服务商。

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use archive_store::{ArchiveStore, SuggestionStatus};
use serde_json::json;

use crate::ai_client::ChatClient;
use crate::ai_commands::{self, InflightRegistry};
use crate::commands::{create_application, open_store, CommandError};
use crate::evidence_commands;

fn archive() -> (tempfile::TempDir, ArchiveStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(
        &dir.path().join("archive"),
        &dir.path().join("current.json"),
    )
    .unwrap();
    (dir, store)
}

fn app(store: &ArchiveStore, company: &str) -> String {
    create_application(
        store,
        serde_json::from_value(json!({ "company": company, "title": "后端工程师" })).unwrap(),
    )
    .unwrap()
    .application
    .unwrap()
    .id
    .clone()
}

/// 导入一份文件证据，返回它的 id。
fn import(
    store: &ArchiveStore,
    dir: &tempfile::TempDir,
    name: &str,
    bytes: &[u8],
    application_id: Option<&str>,
) -> String {
    let source = dir.path().join(name);
    std::fs::write(&source, bytes).unwrap();
    let report = evidence_commands::import_evidence(
        store,
        evidence_commands::ImportArgs {
            paths: vec![source.to_string_lossy().to_string()],
            text: None,
            application_id: application_id.map(str::to_string),
        },
        "2026/09",
    )
    .unwrap();
    assert!(report.failed.is_empty(), "导入失败：{:?}", report.failed);
    report
        .imported
        .first()
        .or(report.duplicates.first())
        .unwrap()
        .id
        .clone()
}

fn interview_mail(company: &str) -> Vec<u8> {
    format!(
        "Subject: 面试邀请｜{company}\r\nFrom: hr@example.test\r\n\r\n您好，{company} 邀请您参加第一轮面试，时间定在下周二上午十点。\r\n"
    )
    .into_bytes()
}

/// 模型的一次正常返回。`candidates` 用编号，正文引用必须在原文里找得到。
fn model_reply() -> String {
    json!({
        "candidates": ["c1"],
        "replyClass": "interview_invite",
        "sendMode": "auto",
        "stage": "interview",
        "round": 1,
        "todos": [{
            "title": "一面",
            "due": "2026-09-22T02:00:00Z",
            "timeZone": "Asia/Shanghai",
            "round": 1
        }],
        "excerpts": ["下周二上午十点"],
        "uncertainties": []
    })
    .to_string()
}

fn chat_completion(content: &str) -> String {
    json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] }).to_string()
}

/// 本机假服务器：收一次请求，把原始报文交回测试，然后按脚本回一次。
struct FakeServer {
    url: String,
    request: std::sync::mpsc::Receiver<String>,
}

impl FakeServer {
    fn new(delay: Duration, status: &str, body: String) -> FakeServer {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://127.0.0.1:{}/v1/chat/completions",
            listener.local_addr().unwrap().port()
        );
        let (tx, request) = std::sync::mpsc::channel();
        let status = status.to_string();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                let done = line == "\r\n";
                head.push_str(&line);
                if done {
                    break;
                }
            }
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            let mut payload = vec![0u8; length];
            reader.read_exact(&mut payload).ok();
            let _ = tx.send(format!("{head}{}", String::from_utf8_lossy(&payload)));

            std::thread::sleep(delay);
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.as_bytes().len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });
        FakeServer { url, request }
    }

    fn ok(content: &str) -> FakeServer {
        FakeServer::new(Duration::ZERO, "200 OK", chat_completion(content))
    }

    /// 发出去的那份报文。请求还没到就等一会儿——线程调度不该让测试变成偶发失败。
    fn received(&self) -> String {
        self.request.recv_timeout(Duration::from_secs(10)).unwrap()
    }
}

/// 命令里的那条链路，测试侧照抄一遍：持锁读 → 放锁 → 发请求 → 再持锁写。
/// 抄的是顺序，不是逻辑；顺序正是这里要盯住的东西。
async fn analyze(
    store: &Arc<Mutex<Option<ArchiveStore>>>,
    client: &ChatClient,
    api_url: &str,
    evidence_id: &str,
    selected: Option<&[String]>,
) -> Result<archive_store::AiSuggestion, CommandError> {
    let (gathered, built) = {
        let guard = store.lock().unwrap();
        let store = guard.as_ref().unwrap();
        let gathered = ai_commands::gather(store, store.archive_dir(), evidence_id, selected)?;
        let built = ai_extract::build_request(
            api_url,
            "fake-model",
            &gathered.evidence,
            &gathered.candidates,
        );
        (gathered, built)
    };
    let content = client
        .chat(api_url, "sk-test", "127.0.0.1", "fake-model", &built.body)
        .await?;
    let extraction =
        ai_extract::parse_response(&content, &built.context).map_err(|err| CommandError {
            code: err.code().into(),
            message: err.message(),
        })?;
    let guard = store.lock().unwrap();
    ai_commands::store_suggestion(guard.as_ref().unwrap(), &gathered, extraction, &built.scope)
}

fn shared(store: ArchiveStore) -> Arc<Mutex<Option<ArchiveStore>>> {
    Arc::new(Mutex::new(Some(store)))
}

fn suggestions(store: &Arc<Mutex<Option<ArchiveStore>>>, evidence_id: &str) -> usize {
    let guard = store.lock().unwrap();
    ai_commands::list_suggestions(guard.as_ref().unwrap(), evidence_id)
        .unwrap()
        .len()
}

fn client() -> ChatClient {
    ChatClient::with_timeout(Duration::from_secs(5)).unwrap()
}

#[test]
fn candidates_come_from_the_company_name_and_the_rest_stay_home() {
    let (dir, store) = archive();
    let wanted = app(&store, "合成科技");
    let other = app(&store, "别家公司");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);

    let gathered = ai_commands::gather(&store, store.archive_dir(), &evidence, None).unwrap();
    let ids: Vec<&str> = gathered
        .candidates
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    assert_eq!(ids, vec![wanted.as_str()]);
    assert!(!ids.contains(&other.as_str()));
}

#[test]
fn an_associated_evidence_only_ever_offers_its_own_application() {
    let (dir, store) = archive();
    let mine = app(&store, "合成科技");
    app(&store, "另一家");
    // 正文里写着另一家的名字，但这条证据已经挂在「合成科技」上：以关联为准。
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("另一家"), Some(&mine));

    let gathered = ai_commands::gather(&store, store.archive_dir(), &evidence, None).unwrap();
    assert_eq!(gathered.candidates.len(), 1);
    assert_eq!(gathered.candidates[0].id, mine);
}

#[test]
fn an_unrecognised_mail_asks_the_user_instead_of_sending_the_whole_archive() {
    let (dir, store) = archive();
    app(&store, "合成科技");
    app(&store, "别家公司");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("谁都不是的公司"), None);

    let err = ai_commands::gather(&store, store.archive_dir(), &evidence, None).unwrap_err();
    assert_eq!(err.code, "AI_NEEDS_CANDIDATES");
}

#[test]
fn an_empty_hand_picked_list_is_refused_instead_of_sending_a_request() {
    let (dir, store) = archive();
    app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);

    let err = ai_commands::gather(&store, store.archive_dir(), &evidence, Some(&[])).unwrap_err();

    assert_eq!(err.code, "AI_NEEDS_CANDIDATES");
}

#[test]
fn a_pdf_is_refused_before_anything_leaves_the_machine() {
    let (dir, store) = archive();
    let id = app(&store, "合成科技");
    let evidence = import(
        &store,
        &dir,
        "offer.pdf",
        b"%PDF-1.7\n1 0 obj\n<< >>\nendobj\n",
        Some(&id),
    );

    let err = ai_commands::gather(&store, store.archive_dir(), &evidence, None).unwrap_err();
    assert_eq!(err.code, "AI_UNSUPPORTED_KIND");
}

#[test]
fn a_plain_text_file_is_read_back_from_disk() {
    let (dir, store) = archive();
    let id = app(&store, "合成科技");
    let evidence = import(
        &store,
        &dir,
        "note.txt",
        "合成科技通知：下周二上午十点面试。".as_bytes(),
        Some(&id),
    );

    let gathered = ai_commands::gather(&store, store.archive_dir(), &evidence, None).unwrap();
    assert!(gathered.evidence.body.contains("下周二上午十点"));
}

#[test]
fn the_preview_says_where_it_goes_without_naming_the_endpoint_or_the_ids() {
    let (dir, store) = archive();
    let id = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);

    let gathered = ai_commands::gather(&store, store.archive_dir(), &evidence, None).unwrap();
    let preview = ai_commands::preview(
        &gathered,
        "https://api.example.test/v1/chat/completions",
        "fake-model",
    );
    assert_eq!(preview.host, "api.example.test");
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].label, "c1");
    let json = serde_json::to_string(&preview).unwrap();
    assert!(!json.contains(&id), "预览里出现了申请 id：{json}");
    assert!(!json.contains("/v1/chat/completions"), "预览里出现了完整地址");
    assert!(preview.slow_hint_seconds < preview.timeout_seconds);
}

#[tokio::test]
async fn a_normal_reply_becomes_one_pending_suggestion() {
    let (dir, store) = archive();
    let application = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let store = shared(store);
    let server = FakeServer::ok(&model_reply());

    let suggestion = analyze(&store, &client(), &server.url, &evidence, None)
        .await
        .unwrap();

    assert_eq!(suggestion.status, SuggestionStatus::Pending);
    assert_eq!(suggestion.candidate_application_ids, vec![application.clone()]);
    assert_eq!(suggestion.suggested_todos.len(), 1);
    assert_eq!(
        suggestion.suggested_todos[0].time_zone.as_deref(),
        Some("Asia/Shanghai")
    );
    assert!(suggestion.prompt_scope.is_some());

    // 建议归建议：证据自己的分类、关联都没动。
    let guard = store.lock().unwrap();
    let record = guard
        .as_ref()
        .unwrap()
        .get_evidence(&evidence)
        .unwrap()
        .unwrap();
    assert!(record.application_id.is_none());
    assert!(record.reply_class.is_none());
}

#[tokio::test]
async fn the_request_carries_labels_and_no_local_ids() {
    let (dir, store) = archive();
    let application = app(&store, "合成科技");
    let unrelated = app(&store, "完全无关公司");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let store = shared(store);
    let server = FakeServer::ok(&model_reply());

    analyze(&store, &client(), &server.url, &evidence, None)
        .await
        .unwrap();

    let sent = server.received();
    let (head, body) = sent.split_once("\r\n\r\n").unwrap();
    assert!(!body.contains(&application), "请求体里出现了申请 UUID");
    assert!(!body.contains(&unrelated), "请求体里出现了别的申请");
    assert!(!body.contains("完全无关公司"), "没选中的公司名被发出去了");
    assert!(!body.contains(&evidence), "请求体里出现了证据 UUID");
    assert!(body.contains("c1"), "候选编号没发出去");
    // Key 只在头里，不在正文里。
    assert!(head.to_ascii_lowercase().contains("authorization: bearer sk-test"));
    assert!(!body.contains("sk-test"));
}

#[tokio::test]
async fn an_http_error_writes_nothing() {
    let (dir, store) = archive();
    app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let store = shared(store);
    let server = FakeServer::new(
        Duration::ZERO,
        "500 Internal Server Error",
        json!({ "error": "boom" }).to_string(),
    );

    let err = analyze(&store, &client(), &server.url, &evidence, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "AI_HTTP_500");
    assert!(!err.message.contains("sk-test"));
    assert_eq!(suggestions(&store, &evidence), 0);
}

#[tokio::test]
async fn a_reply_that_is_not_json_writes_nothing() {
    let (dir, store) = archive();
    app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let store = shared(store);
    // 接口本身返回成功，但模型吐的是一段散文。
    let server = FakeServer::ok("我觉得这封邮件挺好的。");

    let err = analyze(&store, &client(), &server.url, &evidence, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "AI_BAD_RESPONSE");
    assert_eq!(suggestions(&store, &evidence), 0);
}

#[tokio::test]
async fn a_timeout_writes_nothing() {
    let (dir, store) = archive();
    app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let store = shared(store);
    let server = FakeServer::new(
        Duration::from_secs(5),
        "200 OK",
        chat_completion(&model_reply()),
    );
    let client = ChatClient::with_timeout(Duration::from_millis(300)).unwrap();

    let err = analyze(&store, &client, &server.url, &evidence, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "AI_TIMEOUT");
    assert_eq!(suggestions(&store, &evidence), 0);
}

#[tokio::test]
async fn cancelling_a_slow_request_leaves_the_archive_untouched() {
    let (dir, store) = archive();
    app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let store = shared(store);
    let server = FakeServer::new(
        Duration::from_secs(5),
        "200 OK",
        chat_completion(&model_reply()),
    );

    let registry = InflightRegistry::default();
    let cancelled = registry.begin(&evidence, "req-1").unwrap();
    let client = client();
    let outcome = tokio::select! {
        result = analyze(&store, &client, &server.url, &evidence, None) => result,
        _ = async {
            // 请求已经在路上（假服务器要睡 5 秒），这时候按取消。
            tokio::time::sleep(Duration::from_millis(200)).await;
            assert!(registry.cancel("req-1"), "取消信号没送到");
            cancelled.await.unwrap();
        } => Err(CommandError { code: "AI_CANCELLED".into(), message: "已取消。".into() }),
    };
    registry.finish("req-1");

    assert_eq!(outcome.unwrap_err().code, "AI_CANCELLED");
    assert_eq!(suggestions(&store, &evidence), 0);
}

#[test]
fn a_second_request_on_the_same_evidence_is_refused() {
    let registry = InflightRegistry::default();
    let _first = registry.begin("ev-1", "req-1").unwrap();

    let err = registry.begin("ev-1", "req-2").unwrap_err();
    assert_eq!(err.code, "AI_BUSY");
    // 别的证据照常。
    assert!(registry.begin("ev-2", "req-3").is_ok());

    registry.finish("req-1");
    assert!(registry.begin("ev-1", "req-4").is_ok());
}

#[test]
fn cancelling_something_that_already_finished_just_says_no() {
    let registry = InflightRegistry::default();
    let _signal = registry.begin("ev-1", "req-1").unwrap();
    registry.finish("req-1");
    assert!(!registry.cancel("req-1"));
    assert!(!registry.cancel("never-existed"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_archive_stays_readable_while_a_request_is_in_flight() {
    let (dir, store) = archive();
    app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let store = shared(store);
    let server = FakeServer::new(
        Duration::from_secs(3),
        "200 OK",
        chat_completion(&model_reply()),
    );

    let reader = Arc::clone(&store);
    let client = client();
    let request = analyze(&store, &client, &server.url, &evidence, None);
    tokio::pin!(request);

    // 请求已经发出去了，说明取证那一段结束、锁也该放了。
    let mut waiting = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let guard = reader.lock().unwrap();
        let inbox = evidence_commands::list_inbox(guard.as_ref().unwrap()).unwrap();
        (started.elapsed(), inbox.len())
    });
    let (elapsed, inbox) = tokio::select! {
        result = &mut waiting => result.unwrap(),
        _ = &mut request => panic!("请求先于读取完成，这个测试没测到东西"),
    };

    assert_eq!(inbox, 1);
    assert!(
        elapsed < Duration::from_secs(2),
        "请求期间档案被锁住了：等了 {elapsed:?}"
    );
    request.await.unwrap();
    drop(dir);
}
