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

// --- 确认、拒绝、暂存 ---------------------------------------------------------------------
//
// 产品需求 §10 场景 5–7 与 #25 的验收都落在这一段：**确认之前，正式字段一个都不许动。**

/// 记账用的假调度器。这里要验的是「确认之后提醒登记了没有」，不是 Toast 长什么样。
#[derive(Default)]
struct FakeScheduler {
    scheduled: Mutex<Vec<reminders::ReminderRequest>>,
}

impl reminders::ReminderScheduler for FakeScheduler {
    fn capability(&self) -> reminders::Capability {
        reminders::Capability::Available
    }

    fn schedule(
        &self,
        request: &reminders::ReminderRequest,
    ) -> Result<reminders::ScheduledHandle, reminders::ReminderError> {
        self.scheduled.lock().unwrap().push(request.clone());
        Ok(reminders::ScheduledHandle::new(format!(
            "fake:{}",
            request.todo_id
        )))
    }

    fn cancel(&self, _handle: &reminders::ScheduledHandle) -> Result<(), reminders::ReminderError> {
        Ok(())
    }

    fn cancel_all(&self) -> Result<(), reminders::ReminderError> {
        Ok(())
    }
}

fn now() -> time::OffsetDateTime {
    time::macros::datetime!(2026-09-16 02:00 UTC)
}

/// 直接造一条 `pending` 建议，省掉一次网络请求。请求那条链路上面已经测过了。
fn pending(
    store: &ArchiveStore,
    evidence_id: &str,
    candidates: &[String],
    todos: Vec<archive_store::SuggestedTodo>,
) -> archive_store::AiSuggestion {
    store
        .create_suggestion(archive_store::NewAiSuggestion {
            evidence_id: evidence_id.to_string(),
            candidate_application_ids: candidates.to_vec(),
            suggested_stage: Some(archive_store::Stage::Interview),
            suggested_round: Some(1),
            suggested_reply_class: archive_store::ReplyClass::InterviewInvite,
            suggested_send_mode: archive_store::SendMode::Automated,
            suggested_todos: todos,
            excerpt_refs: Some(json!(["下周二上午十点"])),
            uncertainties: None,
            model_label: Some("fake-model".into()),
            prompt_scope: Some("发往 127.0.0.1 · 模型 fake-model · 正文 42 字 · 候选 1 条".into()),
        })
        .unwrap()
}

fn interview_todo() -> archive_store::SuggestedTodo {
    archive_store::SuggestedTodo {
        title: "一面".into(),
        due: archive_store::TodoDue::DateTime("2026-09-22T02:00:00Z".into()),
        time_zone: Some("Asia/Shanghai".into()),
        interview_round: Some(1),
    }
}

fn confirm_args(suggestion_id: &str, application_id: Option<&str>) -> ai_commands::ConfirmArgs {
    ai_commands::ConfirmArgs {
        suggestion_id: suggestion_id.to_string(),
        application_id: application_id.map(str::to_string),
        reply_class: "interview_invite".into(),
        send_mode: "automated".into(),
        stage: Some("interview".into()),
        round: Some(1),
        occurred_at: None,
        update_progress: false,
        create_todos: true,
        todos: None,
    }
}

fn stage_of(store: &ArchiveStore, application_id: &str) -> archive_store::Stage {
    store
        .get_application(application_id)
        .unwrap()
        .unwrap()
        .summary
        .current_stage
}

#[test]
fn two_candidates_are_never_resolved_for_the_user() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let b = app(&store, "合成科技分部");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone(), b.clone()], vec![interview_todo()]);

    let err = ai_commands::confirm(
        &store,
        &FakeScheduler::default(),
        confirm_args(&suggestion.id, None),
        now(),
    )
    .unwrap_err();

    assert_eq!(err.code, "AI_NEEDS_DISAMBIGUATION");
    assert_eq!(stage_of(&store, &a), archive_store::Stage::Saved);
    assert!(store
        .get_evidence(&evidence)
        .unwrap()
        .unwrap()
        .reply_class
        .is_none());
}

#[test]
fn confirming_writes_the_class_the_event_and_the_todo_at_once() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let b = app(&store, "别家公司");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone(), b.clone()], vec![interview_todo()]);
    let scheduler = FakeScheduler::default();

    let result = ai_commands::confirm(
        &store,
        &scheduler,
        confirm_args(&suggestion.id, Some(&a)),
        now(),
    )
    .unwrap();

    assert_eq!(result.suggestion.status, SuggestionStatus::Confirmed);
    assert!(!result.already_confirmed);
    assert_eq!(result.todos.len(), 1);
    assert!(result.reminder_problems.is_empty());
    assert_eq!(scheduler.scheduled.lock().unwrap().len(), 1, "待办没登记提醒");

    let record = store.get_evidence(&evidence).unwrap().unwrap();
    assert_eq!(
        record.reply_class,
        Some(archive_store::ReplyClass::InterviewInvite)
    );
    assert_eq!(record.application_id.as_deref(), Some(a.as_str()));

    let detail = store.get_application(&a).unwrap().unwrap();
    assert_eq!(
        detail.summary.reply_evidence_state,
        archive_store::ReplyEvidenceState::Classified
    );
    // updateProgress 没勾：只进时间线，不动当前进度。
    assert_eq!(detail.summary.current_stage, archive_store::Stage::Saved);
    assert_eq!(stage_of(&store, &b), archive_store::Stage::Saved);
}

#[test]
fn ticking_update_progress_is_what_moves_the_stage() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone()], vec![]);

    let mut args = confirm_args(&suggestion.id, Some(&a));
    args.update_progress = true;
    args.create_todos = false;
    ai_commands::confirm(&store, &FakeScheduler::default(), args, now()).unwrap();

    assert_eq!(stage_of(&store, &a), archive_store::Stage::Interview);
}

#[test]
fn editing_a_todo_before_confirming_is_recorded_as_a_modification() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone()], vec![interview_todo()]);
    let scheduler = FakeScheduler::default();

    let mut args = confirm_args(&suggestion.id, Some(&a));
    args.todos = Some(vec![ai_commands::TodoEdit {
        title: "一面（改到周三）".into(),
        due_precision: Some("datetime".into()),
        due_at_utc: Some("2026-09-23T02:00:00Z".into()),
        due_date: None,
        time_zone: Some("Asia/Shanghai".into()),
        interview_round: Some(1),
    }]);
    let result = ai_commands::confirm(&store, &scheduler, args, now()).unwrap();

    assert_eq!(result.suggestion.status, SuggestionStatus::ModifiedConfirmed);
    assert_eq!(result.todos.len(), 1);
    assert_eq!(result.todos[0].title, "一面（改到周三）");
    // 建议行原样留着：模型当初说的是什么，事后查得到。
    assert_eq!(result.suggestion.suggested_todos[0].title, "一面");
}

#[test]
fn a_different_send_mode_makes_it_a_modified_confirmation() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone()], vec![]);

    let mut args = confirm_args(&suggestion.id, Some(&a));
    args.send_mode = "unknown".into();
    args.create_todos = false;
    let result = ai_commands::confirm(&store, &FakeScheduler::default(), args, now()).unwrap();

    assert_eq!(result.suggestion.status, SuggestionStatus::ModifiedConfirmed);
    assert_eq!(
        result.suggestion.suggested_send_mode,
        archive_store::SendMode::Automated
    );
    assert_eq!(
        result.suggestion.approved_send_mode,
        Some(archive_store::SendMode::Unknown)
    );
}

#[test]
fn changing_the_stage_or_the_round_also_counts_as_a_modification() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);

    // 建议说「面试 一面」，用户改成「测评」。
    let first = pending(&store, &evidence, &[a.clone()], vec![]);
    let mut args = confirm_args(&first.id, Some(&a));
    args.stage = Some("assessment".into());
    args.round = None;
    args.create_todos = false;
    let result = ai_commands::confirm(&store, &FakeScheduler::default(), args, now()).unwrap();
    assert_eq!(result.suggestion.status, SuggestionStatus::ModifiedConfirmed);

    // 阶段照建议，轮次从一面改成二面。
    let second = pending(&store, &evidence, &[a.clone()], vec![]);
    let mut args = confirm_args(&second.id, Some(&a));
    args.round = Some(2);
    args.create_todos = false;
    let result = ai_commands::confirm(&store, &FakeScheduler::default(), args, now()).unwrap();
    assert_eq!(result.suggestion.status, SuggestionStatus::ModifiedConfirmed);

    // 干脆不记阶段，也是改。
    let third = pending(&store, &evidence, &[a.clone()], vec![]);
    let mut args = confirm_args(&third.id, Some(&a));
    args.stage = None;
    args.create_todos = false;
    let result = ai_commands::confirm(&store, &FakeScheduler::default(), args, now()).unwrap();
    assert_eq!(result.suggestion.status, SuggestionStatus::ModifiedConfirmed);
}

#[test]
fn confirming_twice_is_idempotent_and_a_different_decision_conflicts() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone()], vec![interview_todo()]);
    let scheduler = FakeScheduler::default();

    ai_commands::confirm(
        &store,
        &scheduler,
        confirm_args(&suggestion.id, Some(&a)),
        now(),
    )
    .unwrap();
    let again = ai_commands::confirm(
        &store,
        &scheduler,
        confirm_args(&suggestion.id, Some(&a)),
        now(),
    )
    .unwrap();
    assert!(again.already_confirmed);
    assert!(again.todos.is_empty(), "重复确认又建了一遍待办");
    assert_eq!(store.list_todos(Some(&a), None, None, 50, 0).unwrap().len(), 1);

    let mut other = confirm_args(&suggestion.id, Some(&a));
    other.reply_class = "reject".into();
    let err = ai_commands::confirm(&store, &scheduler, other, now()).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
}

#[test]
fn rejecting_leaves_every_formal_field_alone() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone()], vec![interview_todo()]);

    let rejected =
        ai_commands::set_status(&store, &suggestion.id, SuggestionStatus::Rejected).unwrap();

    assert_eq!(rejected.status, SuggestionStatus::Rejected);
    assert_eq!(stage_of(&store, &a), archive_store::Stage::Saved);
    assert!(store
        .get_evidence(&evidence)
        .unwrap()
        .unwrap()
        .reply_class
        .is_none());
    assert!(store.list_todos(Some(&a), None, None, 50, 0).unwrap().is_empty());
}

#[test]
fn a_deferred_suggestion_survives_a_restart_and_can_still_be_confirmed() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let pointer = dir.path().join("current.json");
    let store = open_store(&archive_dir, &pointer).unwrap();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone()], vec![interview_todo()]);
    ai_commands::set_status(&store, &suggestion.id, SuggestionStatus::Deferred).unwrap();
    drop(store);

    let store = open_store(&archive_dir, &pointer).unwrap();
    let reopened = ai_commands::list_suggestions(&store, &evidence).unwrap();
    assert_eq!(reopened.len(), 1);
    assert_eq!(reopened[0].status, SuggestionStatus::Deferred);
    assert!(store
        .get_evidence(&evidence)
        .unwrap()
        .unwrap()
        .reply_class
        .is_none());

    let mut args = confirm_args(&suggestion.id, Some(&a));
    args.send_mode = "unknown".into();
    let result = ai_commands::confirm(&store, &FakeScheduler::default(), args, now()).unwrap();
    assert_eq!(result.suggestion.status, SuggestionStatus::ModifiedConfirmed);
}

#[test]
fn analysing_the_same_evidence_again_does_not_touch_the_confirmed_one() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let first = pending(&store, &evidence, &[a.clone()], vec![interview_todo()]);
    ai_commands::confirm(
        &store,
        &FakeScheduler::default(),
        confirm_args(&first.id, Some(&a)),
        now(),
    )
    .unwrap();

    // 换个模型重跑一遍：新增一行，旧的那行和它写下的东西都不动。
    let second = pending(&store, &evidence, &[a.clone()], vec![]);

    let rows = ai_commands::list_suggestions(&store, &evidence).unwrap();
    assert_eq!(rows.len(), 2);
    let old = rows.iter().find(|row| row.id == first.id).unwrap();
    assert_eq!(old.status, SuggestionStatus::Confirmed);
    assert_eq!(
        rows.iter().find(|row| row.id == second.id).unwrap().status,
        SuggestionStatus::Pending
    );
    assert_eq!(store.list_todos(Some(&a), None, None, 50, 0).unwrap().len(), 1);
    assert_eq!(
        store.get_evidence(&evidence).unwrap().unwrap().reply_class,
        Some(archive_store::ReplyClass::InterviewInvite)
    );
}

#[test]
fn a_stage_that_cannot_come_from_a_notification_is_refused() {
    let (dir, store) = archive();
    let a = app(&store, "合成科技");
    let evidence = import(&store, &dir, "invite.eml", &interview_mail("合成科技"), None);
    let suggestion = pending(&store, &evidence, &[a.clone()], vec![]);

    let mut args = confirm_args(&suggestion.id, Some(&a));
    args.stage = Some("submitted".into());
    let err = ai_commands::confirm(&store, &FakeScheduler::default(), args, now()).unwrap_err();

    assert_eq!(err.code, "VALIDATION");
    assert_eq!(stage_of(&store, &a), archive_store::Stage::Saved);
}
