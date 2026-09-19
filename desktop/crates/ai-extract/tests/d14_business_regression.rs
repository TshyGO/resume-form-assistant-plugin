//! D14 T2：直接消费首发验收夹具，钉住“同公司两岗位不替用户做选择”的提取契约。

use ai_extract::{build_request, parse_response, Candidate, EvidenceInput};
use serde_json::Value;

const DATASET: &str =
    include_str!("../../../../docs/desktop-mvp/acceptance/fixtures/d14-v1/dataset.json");

fn item<'a>(dataset: &'a Value, list: &str, logical_id: &str) -> &'a Value {
    dataset[list]
        .as_array()
        .expect("fixture list")
        .iter()
        .find(|entry| entry["logicalId"].as_str() == Some(logical_id))
        .unwrap_or_else(|| panic!("missing D14 fixture {list}/{logical_id}"))
}

#[test]
fn d14_ambiguous_notice_keeps_both_candidates_for_user_choice() {
    let dataset: Value = serde_json::from_str(DATASET).expect("D14 dataset is valid JSON");
    let notice = item(&dataset, "notices", "notice-ambiguous-acme");
    let response = item(&dataset, "modelResponses", "model-valid-ambiguous");
    let job_a = item(&dataset, "jobs", "job-a");
    let job_b = item(&dataset, "jobs", "job-b");
    let app_a = item(&dataset, "applications", "application-a");
    let app_b = item(&dataset, "applications", "application-b");

    let built = build_request(
        "https://api.example.test/v1/chat/completions",
        "d14-fixed-response",
        &EvidenceInput {
            subject: notice["subject"].as_str().map(str::to_string),
            from_addr: None,
            sent_at: notice["receivedAt"].as_str().map(str::to_string),
            body: notice["body"].as_str().unwrap().to_string(),
        },
        &[
            Candidate {
                id: app_a["fixtureUuid"].as_str().unwrap().to_string(),
                company: job_a["company"].as_str().unwrap().to_string(),
                title: job_a["title"].as_str().unwrap().to_string(),
                stage: "submitted".into(),
            },
            Candidate {
                id: app_b["fixtureUuid"].as_str().unwrap().to_string(),
                company: job_b["company"].as_str().unwrap().to_string(),
                title: job_b["title"].as_str().unwrap().to_string(),
                stage: "submitted".into(),
            },
        ],
    );
    let raw = serde_json::to_string(&response["value"]).unwrap();
    let parsed = parse_response(&raw, &built.context).expect("valid D14 response");

    assert_eq!(
        parsed.application_ids,
        vec![
            app_a["fixtureUuid"].as_str().unwrap().to_string(),
            app_b["fixtureUuid"].as_str().unwrap().to_string(),
        ]
    );
    assert_eq!(parsed.reply_class, "action_required");
    assert_eq!(parsed.send_mode, "unknown");
    assert!(parsed
        .uncertainties
        .iter()
        .any(|note| note.contains("正文没有职位名称")));
}

#[test]
fn d14_invalid_model_outputs_never_become_formal_values() {
    let dataset: Value = serde_json::from_str(DATASET).expect("D14 dataset is valid JSON");
    let notice = item(&dataset, "notices", "notice-ambiguous-acme");
    let job_a = item(&dataset, "jobs", "job-a");
    let job_b = item(&dataset, "jobs", "job-b");
    let app_a = item(&dataset, "applications", "application-a");
    let app_b = item(&dataset, "applications", "application-b");
    let built = build_request(
        "https://api.example.test/v1/chat/completions",
        "d14-fixed-response",
        &EvidenceInput {
            subject: notice["subject"].as_str().map(str::to_string),
            from_addr: None,
            sent_at: notice["receivedAt"].as_str().map(str::to_string),
            body: notice["body"].as_str().unwrap().to_string(),
        },
        &[
            Candidate {
                id: app_a["fixtureUuid"].as_str().unwrap().to_string(),
                company: job_a["company"].as_str().unwrap().to_string(),
                title: job_a["title"].as_str().unwrap().to_string(),
                stage: "submitted".into(),
            },
            Candidate {
                id: app_b["fixtureUuid"].as_str().unwrap().to_string(),
                company: job_b["company"].as_str().unwrap().to_string(),
                title: job_b["title"].as_str().unwrap().to_string(),
                stage: "submitted".into(),
            },
        ],
    );

    let invalid_json = item(&dataset, "modelResponses", "model-invalid-json");
    assert_eq!(
        parse_response(invalid_json["value"].as_str().unwrap(), &built.context)
            .unwrap_err()
            .code(),
        "AI_BAD_RESPONSE"
    );

    let invalid_enum = item(&dataset, "modelResponses", "model-invalid-enum");
    let parsed = parse_response(
        &serde_json::to_string(&invalid_enum["value"]).unwrap(),
        &built.context,
    )
    .unwrap();
    assert_eq!(parsed.reply_class, "unknown");
    assert!(parsed
        .uncertainties
        .iter()
        .any(|note| note.contains("通知类型无法识别")));

    let out_of_range = item(&dataset, "modelResponses", "model-out-of-range-candidate");
    assert_eq!(
        parse_response(
            &serde_json::to_string(&out_of_range["value"]).unwrap(),
            &built.context,
        )
        .unwrap_err()
        .code(),
        "AI_CANDIDATE_OUT_OF_RANGE"
    );

    let invalid_date = item(&dataset, "modelResponses", "model-invalid-date");
    let parsed = parse_response(
        &serde_json::to_string(&invalid_date["value"]).unwrap(),
        &built.context,
    )
    .unwrap();
    assert!(
        parsed.todos.is_empty(),
        "an impossible date must not reach confirmation"
    );
    assert!(parsed
        .uncertainties
        .iter()
        .any(|note| note.contains("时间没法确定")));
}
