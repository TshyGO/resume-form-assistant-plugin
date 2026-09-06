use crate::commands::*;
use archive_store::{Occurred, Stage};
use serde_json::json;

#[test]
fn wire_edit_explicit_empty_clears_and_omitted_keeps() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(
        &dir.path().join("archive"),
        &dir.path().join("current.json"),
    )
    .unwrap();
    let created=create_application(&store,serde_json::from_value(json!({"company":"Synthetic","title":"Job","sourceUrl":"https://example.test","location":"City","notes":"old"})).unwrap()).unwrap().application.unwrap();
    let kept = update_application(
        &store,
        serde_json::from_value(json!({"id":created.id,"title":"Updated"})).unwrap(),
    )
    .unwrap();
    assert_eq!(kept.notes.as_deref(), Some("old"));
    let cleared = update_application(
        &store,
        serde_json::from_value(json!({"id":created.id,"sourceUrl":"","location":"","notes":""}))
            .unwrap(),
    )
    .unwrap();
    assert!(cleared.source_url.is_none());
    assert!(cleared.location.is_none());
    assert!(cleared.notes.is_none());
    assert!(update_application(
        &store,
        serde_json::from_value(json!({"id":created.id,"company":" "})).unwrap()
    )
    .is_err());
}

#[test]
fn rounds_dates_unknown_time_and_invalid_inputs_cross_command_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(
        &dir.path().join("archive"),
        &dir.path().join("current.json"),
    )
    .unwrap();
    let a = create_application(
        &store,
        serde_json::from_value(json!({"company":"Synthetic","title":"Job"})).unwrap(),
    )
    .unwrap()
    .application
    .unwrap();
    record_offer(
        &store,
        serde_json::from_value(json!({"id":a.id,"updateProgress":true})).unwrap(),
    )
    .unwrap();
    let view=record_interview(&store,serde_json::from_value(json!({"id":a.id,"round":2,"updateProgress":false,"occurred":{"precision":"date","value":{"date":"2026-08-21","time_zone":null}}})).unwrap()).unwrap();
    assert_eq!(view.application.current_stage, Stage::Offer);
    let last = view.events.last().unwrap();
    assert!(matches!(&last.occurred,Occurred::Date{date,..} if date=="2026-08-21"));
    assert_eq!(serde_json::to_value(&last.payload).unwrap()["round"], 2);
    let view =
        record_assessment(&store, serde_json::from_value(json!({"id":a.id})).unwrap()).unwrap();
    assert!(matches!(
        view.events.last().unwrap().occurred,
        Occurred::Unknown
    ));
    let count = view.events.len();
    for bad in [
        json!({"id":a.id,"round":0}),
        json!({"id":a.id,"round":100}),
        json!({"id":a.id,"occurred":{"precision":"date","value":{"date":"2026-02-30","time_zone":null}}}),
    ] {
        assert!(record_interview(&store, serde_json::from_value(bad).unwrap()).is_err());
    }
    assert_eq!(get_application(&store, &a.id).unwrap().events.len(), count);
}
