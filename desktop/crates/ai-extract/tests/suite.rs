//! 固定合成通知集。每个 fixture 都写明它在防什么。
//!
//! 统计那条测试是这块的底线：不是「返回了 JSON 就算过」，而是误关联、错误阶段建议、
//! 该记未知却给了具体值，三项都必须是 0。

use std::fs;
use std::path::{Path, PathBuf};

use ai_extract::{build_request, parse_response, Candidate, Due, EvidenceInput, Extraction};
use serde_json::Value;

struct Fixture {
    name: String,
    why: String,
    path: PathBuf,
    raw: Value,
}

fn fixtures() -> Vec<Fixture> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("fixtures 目录读不到")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().map(|ext| ext == "json").unwrap_or(false))
        .collect();
    paths.sort();
    assert!(!paths.is_empty(), "一个 fixture 都没有");
    paths
        .into_iter()
        .map(|path| {
            let text = fs::read_to_string(&path).expect("fixture 读不出来");
            let raw: Value = serde_json::from_str(&text)
                .unwrap_or_else(|err| panic!("{} 不是合法 JSON：{err}", path.display()));
            Fixture {
                name: raw["name"].as_str().unwrap_or_default().to_string(),
                why: raw["why"].as_str().unwrap_or_default().to_string(),
                path,
                raw,
            }
        })
        .collect()
}

fn candidates_of(raw: &Value) -> Vec<Candidate> {
    raw["candidates"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| Candidate {
                    id: item["id"].as_str().unwrap_or_default().to_string(),
                    company: item["company"].as_str().unwrap_or_default().to_string(),
                    title: item["title"].as_str().unwrap_or_default().to_string(),
                    stage: item["stage"].as_str().unwrap_or("submitted").to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn evidence_of(raw: &Value) -> EvidenceInput {
    EvidenceInput {
        subject: raw["evidence"]["subject"].as_str().map(str::to_string),
        from_addr: raw["evidence"]["from"].as_str().map(str::to_string),
        sent_at: raw["evidence"]["sentAt"].as_str().map(str::to_string),
        body: raw["evidence"]["body"].as_str().unwrap_or_default().to_string(),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn run(fixture: &Fixture) -> Result<Extraction, String> {
    let built = build_request(
        "https://api.example.test/v1/chat/completions",
        "synthetic-model",
        &evidence_of(&fixture.raw),
        &candidates_of(&fixture.raw),
    );
    let output = fixture.raw["modelOutput"].as_str().unwrap_or_default();
    parse_response(output, &built.context).map_err(|err| err.code().to_string())
}

#[test]
fn every_fixture_matches_what_it_says_it_expects() {
    for fixture in fixtures() {
        let expect = &fixture.raw["expect"];
        let label = format!("{}（{}）", fixture.name, fixture.path.display());
        let result = run(&fixture);

        if let Some(code) = expect["error"].as_str() {
            let actual = result.expect_err(&format!("{label} 应该失败：{}", fixture.why));
            assert_eq!(actual, code, "{label}");
            continue;
        }

        let parsed = result.unwrap_or_else(|err| panic!("{label} 不该失败，却报了 {err}"));

        if let Some(expected) = expect.get("applicationIds") {
            assert_eq!(parsed.application_ids, strings(expected), "{label} 候选");
        }
        if let Some(expected) = expect["replyClass"].as_str() {
            assert_eq!(parsed.reply_class, expected, "{label} 通知类型");
        }
        if let Some(expected) = expect["sendMode"].as_str() {
            assert_eq!(parsed.send_mode, expected, "{label} 发送方式");
        }
        if expect.get("stage").is_some() {
            let expected = expect["stage"].as_str().map(str::to_string);
            assert_eq!(parsed.stage, expected, "{label} 阶段建议");
        }
        if expect.get("round").is_some() {
            assert_eq!(parsed.round, expect["round"].as_i64(), "{label} 轮次");
        }
        if let Some(expected) = expect.get("todoTitles") {
            let titles: Vec<String> = parsed.todos.iter().map(|t| t.title.clone()).collect();
            assert_eq!(titles, strings(expected), "{label} 待办");
        }
        if let Some(expected) = expect["todoDue"].as_str() {
            let due = parsed.todos.first().map(|t| t.due.clone());
            assert_eq!(
                due,
                Some(Due::DateTime(expected.to_string())),
                "{label} 待办时间"
            );
        }
        if let Some(expected) = expect.get("excerpts") {
            assert_eq!(parsed.excerpts, strings(expected), "{label} 引用");
        }
        for needle in strings(&expect["uncertaintyContains"]) {
            assert!(
                parsed.uncertainties.iter().any(|note| note.contains(&needle)),
                "{label} 的不确定点里应该提到「{needle}」，实际是 {:?}",
                parsed.uncertainties
            );
        }
        if expect["noUncertainties"].as_bool().unwrap_or(false) {
            assert!(
                parsed.uncertainties.is_empty(),
                "{label} 不该有不确定点，实际是 {:?}",
                parsed.uncertainties
            );
        }
    }
}

/// 这条盯的是质量，不是「有没有返回」。三项计数必须都是 0。
#[test]
fn the_synthetic_set_produces_no_wrong_association_stage_or_confidence() {
    let mut wrong_association = 0;
    let mut wrong_stage = 0;
    let mut should_have_been_unknown = 0;
    let mut checked = 0;

    for fixture in fixtures() {
        let expect = &fixture.raw["expect"];
        if expect["error"].is_string() {
            continue;
        }
        let Ok(parsed) = run(&fixture) else {
            panic!("{} 不该失败", fixture.name);
        };
        checked += 1;

        if let Some(expected) = expect.get("applicationIds") {
            if parsed.application_ids != strings(expected) {
                wrong_association += 1;
            }
        }
        if expect.get("stage").is_some() {
            let expected = expect["stage"].as_str().map(str::to_string);
            if parsed.stage != expected {
                wrong_stage += 1;
            }
        }
        for (field, actual) in [
            ("replyClass", &parsed.reply_class),
            ("sendMode", &parsed.send_mode),
        ] {
            if expect[field].as_str() == Some("unknown") && actual != "unknown" {
                should_have_been_unknown += 1;
            }
        }
    }

    assert!(checked >= 10, "合成集太小，只核了 {checked} 条");
    assert_eq!(
        (wrong_association, wrong_stage, should_have_been_unknown),
        (0, 0, 0),
        "误关联 {wrong_association} 条、错误阶段 {wrong_stage} 条、该记未知却给了具体值 {should_have_been_unknown} 条"
    );
}

/// 每个 fixture 都要写清楚它在防什么，否则合成集会慢慢变成一堆只会过的样本。
#[test]
fn every_fixture_says_what_it_guards_against() {
    for fixture in fixtures() {
        assert!(
            !fixture.name.trim().is_empty() && fixture.why.chars().count() >= 8,
            "{} 缺 name 或 why",
            fixture.path.display()
        );
    }
}
