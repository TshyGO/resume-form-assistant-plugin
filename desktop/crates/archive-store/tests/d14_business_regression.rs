//! D14 T2：同一 `d14-v1` 数据集贯穿岗位、通知、审核确认、待办和阶段投影。

use archive_store::*;
use serde_json::{json, Value};

const DATASET: &str = include_str!(
    "../../../../docs/desktop-mvp/acceptance/fixtures/d14-v1/dataset.json"
);
const EXPECTED: &str = include_str!(
    "../../../../docs/desktop-mvp/acceptance/fixtures/d14-v1/expected-results.json"
);

fn config(root: &std::path::Path) -> ArchiveConfig {
    ArchiveConfig::new(root.join("archive"), root.join("current.json"))
}

fn item<'a>(dataset: &'a Value, list: &str, logical_id: &str) -> &'a Value {
    dataset[list]
        .as_array()
        .expect("fixture list")
        .iter()
        .find(|entry| entry["logicalId"].as_str() == Some(logical_id))
        .unwrap_or_else(|| panic!("missing D14 fixture {list}/{logical_id}"))
}

fn application(store: &ArchiveStore, dataset: &Value, logical_id: &str) -> ApplicationDetail {
    let mapping = item(dataset, "applications", logical_id);
    let job = item(dataset, "jobs", mapping["job"].as_str().unwrap());
    store
        .create_application(NewApplication {
            company: job["company"].as_str().unwrap().into(),
            title: job["title"].as_str().unwrap().into(),
            source_url: job["url"].as_str().map(str::to_string),
            location: job["location"].as_str().map(str::to_string),
            notes: None,
            origin: ApplicationOrigin::Plugin,
            occurred_at: Occurred::Unknown,
        })
        .unwrap()
}

fn evidence(
    store: &ArchiveStore,
    dataset: &Value,
    logical_id: &str,
    application_id: Option<String>,
    digest_byte: char,
) -> ReplyEvidence {
    let notice = item(dataset, "notices", logical_id);
    store
        .import_evidence(NewEvidence {
            application_id,
            kind: EvidenceKind::Paste,
            blob: AttachmentBlobMeta {
                sha256: digest_byte.to_string().repeat(64),
                size_bytes: notice["body"].as_str().unwrap().len() as i64,
                stored_rel_path: format!("attachments/{logical_id}.txt"),
                mime: Some("text/plain".into()),
            },
            original_filename: Some(format!("{logical_id}.txt")),
            subject: notice["subject"].as_str().map(str::to_string),
            from_addr: Some("ats@d14.example.test".into()),
            sent_at: None,
            body_extract: notice["body"].as_str().map(str::to_string),
            append_event: true,
        })
        .unwrap()
}

fn event(payload: EventPayload) -> EventDraft {
    EventDraft::new(payload, Occurred::Unknown, EventSource::Manual, Actor::User)
}

#[test]
fn d14_notice_review_is_explicit_idempotent_and_never_rolls_offer_back() {
    let dataset: Value = serde_json::from_str(DATASET).unwrap();
    let expected: Value = serde_json::from_str(EXPECTED).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = ArchiveStore::open(config(dir.path())).unwrap();
    let app_a = application(&store, &dataset, "application-a");
    let app_b = application(&store, &dataset, "application-b");
    let _app_c = application(&store, &dataset, "application-c");

    let job_a = item(&dataset, "jobs", "job-a");
    let ambiguous = store
        .query_candidates(job_a["company"].as_str().unwrap(), "下一步安排", None)
        .unwrap();
    assert!(ambiguous.exact.is_empty());
    assert_eq!(
        ambiguous.same_company.len(),
        expected["logicalEntities"]["sameCompanyAmbiguity"]
            .as_array()
            .unwrap()
            .len(),
        "同公司两个岗位必须同时交给用户消歧"
    );

    let ambiguous_evidence = evidence(
        &store,
        &dataset,
        "notice-ambiguous-acme",
        None,
        'a',
    );
    let suggestion = store
        .create_suggestion(NewAiSuggestion {
            evidence_id: ambiguous_evidence.id.clone(),
            candidate_application_ids: vec![app_a.id.clone(), app_b.id.clone()],
            suggested_stage: Some(Stage::Interview),
            suggested_round: Some(1),
            suggested_reply_class: ReplyClass::ActionRequired,
            suggested_send_mode: SendMode::Unknown,
            suggested_todos: vec![SuggestedTodo {
                title: "下一步沟通".into(),
                due: TodoDue::Date("2026-10-24".into()),
                time_zone: Some("Asia/Shanghai".into()),
                interview_round: Some(1),
            }],
            excerpt_refs: Some(json!(["你的申请已进入下一步"])),
            uncertainties: Some(json!(["正文没有职位名称"])),
            model_label: Some("d14-fixed-response".into()),
            prompt_scope: Some("D14 synthetic notice · 2 candidates".into()),
        })
        .unwrap();

    assert!(store
        .get_evidence(&ambiguous_evidence.id)
        .unwrap()
        .unwrap()
        .reply_class
        .is_none());
    assert_eq!(store.get_application(&app_a.id).unwrap().unwrap().current_stage, Stage::Saved);
    assert_eq!(store.get_application(&app_b.id).unwrap().unwrap().current_stage, Stage::Saved);
    assert!(store
        .list_todos(Some(app_b.id.as_str()), None, None, 100, 0)
        .unwrap()
        .is_empty());

    let decision = ConfirmSuggestionInput {
        suggestion_id: suggestion.id.clone(),
        application_id: app_b.id.clone(),
        approved_reply_class: ReplyClass::InterviewInvite,
        approved_send_mode: SendMode::Human,
        stage_event: Some(event(EventPayload::InterviewRecorded {
            round: Some(1),
            label: Some("平台工程师面试（用户确认）".into()),
            stage_update_mode: StageUpdateMode::UpdateProgress,
        })),
        create_todos: true,
        approved_todos: Some(vec![SuggestedTodo {
            title: "平台工程师面试（已人工改期）".into(),
            due: TodoDue::DateTime("2026-10-24T02:30:00Z".into()),
            time_zone: Some("Asia/Shanghai".into()),
            interview_round: Some(1),
        }]),
    };
    let confirmed = store.confirm_suggestion(decision.clone()).unwrap();
    assert!(!confirmed.already_confirmed);
    assert_eq!(confirmed.todos.len(), 1);
    assert_eq!(confirmed.todos[0].time_zone.as_deref(), Some("Asia/Shanghai"));
    assert_eq!(store.get_application(&app_a.id).unwrap().unwrap().current_stage, Stage::Saved);
    assert_eq!(
        store.get_application(&app_b.id).unwrap().unwrap().current_stage,
        Stage::Interview
    );
    let classified = store.get_evidence(&ambiguous_evidence.id).unwrap().unwrap();
    assert_eq!(classified.application_id.as_deref(), Some(app_b.id.as_str()));
    assert_eq!(classified.reply_class, Some(ReplyClass::InterviewInvite));
    assert_eq!(classified.send_mode, Some(SendMode::Human));
    assert_eq!(
        store.get_suggestion(&suggestion.id).unwrap().unwrap().status,
        SuggestionStatus::ModifiedConfirmed
    );

    let before_repeat = store.list_events(&app_b.id).unwrap().len();
    let repeated = store.confirm_suggestion(decision).unwrap();
    assert!(repeated.already_confirmed);
    assert!(repeated.events.is_empty());
    assert!(repeated.todos.is_empty());
    assert_eq!(store.list_events(&app_b.id).unwrap().len(), before_repeat);

    let ats = item(&dataset, "notices", "notice-ats-interview-a");
    let ats_evidence = evidence(
        &store,
        &dataset,
        "notice-ats-interview-a",
        Some(app_a.id.clone()),
        'b',
    );
    let ats_suggestion = store
        .create_suggestion(NewAiSuggestion {
            evidence_id: ats_evidence.id.clone(),
            candidate_application_ids: vec![app_a.id.clone()],
            suggested_stage: Some(Stage::Interview),
            suggested_round: Some(1),
            suggested_reply_class: ReplyClass::InterviewInvite,
            suggested_send_mode: SendMode::Automated,
            suggested_todos: vec![],
            excerpt_refs: None,
            uncertainties: None,
            model_label: Some("d14-fixed-response".into()),
            prompt_scope: Some("D14 ATS notice".into()),
        })
        .unwrap();
    store
        .confirm_suggestion(ConfirmSuggestionInput {
            suggestion_id: ats_suggestion.id,
            application_id: app_a.id.clone(),
            approved_reply_class: ReplyClass::parse(ats["expectedReplyClass"].as_str().unwrap())
                .unwrap(),
            approved_send_mode: SendMode::parse(ats["expectedSendMode"].as_str().unwrap()).unwrap(),
            stage_event: None,
            create_todos: false,
            approved_todos: None,
        })
        .unwrap();
    let classified_ats = store.get_evidence(&ats_evidence.id).unwrap().unwrap();
    assert_eq!(classified_ats.send_mode, Some(SendMode::Automated));
    assert_eq!(
        store.get_application(&app_a.id).unwrap().unwrap().current_stage,
        Stage::Saved,
        "审核建议但未选择更新进度时，正式阶段不能变化"
    );

    store
        .append_event(
            Some(app_a.id.as_str()),
            event(EventPayload::OfferRecorded {
                note: Some("D14 synthetic offer".into()),
                stage_update_mode: StageUpdateMode::UpdateProgress,
            }),
        )
        .unwrap();
    assert_eq!(store.get_application(&app_a.id).unwrap().unwrap().current_stage, Stage::Offer);

    let historical_evidence = evidence(
        &store,
        &dataset,
        "notice-historical-assessment-a",
        Some(app_a.id.clone()),
        'c',
    );
    let historical = store
        .create_suggestion(NewAiSuggestion {
            evidence_id: historical_evidence.id,
            candidate_application_ids: vec![app_a.id.clone()],
            suggested_stage: Some(Stage::Assessment),
            suggested_round: None,
            suggested_reply_class: ReplyClass::AssessmentInvite,
            suggested_send_mode: SendMode::Automated,
            suggested_todos: vec![],
            excerpt_refs: None,
            uncertainties: None,
            model_label: Some("d14-fixed-response".into()),
            prompt_scope: Some("D14 historical notice".into()),
        })
        .unwrap();
    store
        .confirm_suggestion(ConfirmSuggestionInput {
            suggestion_id: historical.id,
            application_id: app_a.id.clone(),
            approved_reply_class: ReplyClass::AssessmentInvite,
            approved_send_mode: SendMode::Automated,
            stage_event: Some(event(EventPayload::AssessmentRecorded {
                name: Some("此前的前端测评".into()),
                due: None,
                stage_update_mode: StageUpdateMode::HistoryOnly,
            })),
            create_todos: false,
            approved_todos: None,
        })
        .unwrap();
    assert_eq!(
        store.get_application(&app_a.id).unwrap().unwrap().current_stage,
        Stage::Offer,
        "Offer 后补录旧测评只能进历史，不能回退当前阶段"
    );
}
