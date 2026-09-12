use crate::commands::*;
use archive_store::{Occurred, Stage};
use serde_json::json;

#[test]
fn diagnostics_include_redacted_archive_failure() {
    let dir = tempfile::tempdir().unwrap();
    let paths = data_service::HostPaths::resolve_with(Some(dir.path().join("data")), None).unwrap();
    let mut body = json!({"uniqueWriter":true});
    crate::add_archive_diagnostics(
        &mut body,
        &paths,
        false,
        Some(&CommandError {
            code: "STORE_ERROR".into(),
            message: format!("failed at {}", paths.archive_dir.display()),
        }),
    );
    assert_eq!(body["archiveAvailable"], false);
    assert_eq!(body["archiveError"]["code"], "STORE_ERROR");
    assert!(!body
        .to_string()
        .contains(&paths.data_root.display().to_string()));
    crate::add_archive_diagnostics(&mut body, &paths, true, None);
    assert_eq!(body["archiveAvailable"], true);
    assert!(body["archiveError"].is_null());
}

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

// --- D08 PR 6: fill events, their snapshots, and reading one ---------------------------

mod snapshots {
    use crate::commands::*;
    use archive_store::{
        ArchiveStore, FillOutcome, FillSubmitInput, Occurred, PluginOp, PluginWriteContext,
        SnapshotChunkInput,
    };
    use serde_json::json;

    const CLIENT: &str = "11111111-1111-4111-8111-111111111111";
    const STORED: &str = "66666666-6666-4666-8666-666666666666";
    const UPLOADING: &str = "77777777-7777-4777-8777-777777777777";
    const MISSING: &str = "88888888-8888-4888-8888-888888888888";

    fn sha(bytes: &[u8]) -> String {
        resume_pro_protocol::sha256_hex(bytes)
    }

    fn submit(store: &ArchiveStore, message_id: &str, op: PluginOp) {
        let ctx = PluginWriteContext {
            envelope_identity: Some(store.identity()),
            client_instance_id: CLIENT.into(),
            message_id: message_id.into(),
            source_restore_epoch: store.identity().restore_epoch,
            payload_sha256: op.digest().unwrap(),
        };
        store.submit_plugin_message(&ctx, op).unwrap();
    }

    fn fill(store: &ArchiveStore, message_id: &str, app: &str, snapshot: &str) {
        submit(store, message_id, PluginOp::FillSubmit(FillSubmitInput {
            application_id: app.into(),
            outcome: FillOutcome::Partial,
            field_count: Some(12),
            filled_count: Some(9),
            unconfirmed_count: Some(3),
            durations_ms: None,
            url_redacted: None,
            template_name: Some("合成模板".into()),
            template_version: Some("0123456789ab".into()),
            snapshot_id: Some(snapshot.into()),
            plugin_version: Some("0.4.0".into()),
            occurred: Occurred::Unknown,
        }));
    }

    fn chunk(store: &ArchiveStore, message_id: &str, app: &str, snapshot: &str, bytes: &[u8], index: i64, count: i64, piece: Vec<u8>) {
        submit(store, message_id, PluginOp::SnapshotChunk(SnapshotChunkInput {
            application_id: Some(app.into()),
            snapshot_id: snapshot.into(),
            chunk_index: index,
            chunk_count: count,
            total_sha256: sha(bytes),
            byte_size: bytes.len() as i64,
            chunk_sha256: sha(&piece),
            template_name: None,
            template_version: None,
            bytes: piece,
        }));
    }

    fn document() -> Vec<u8> {
        json!({
            "capturedAt": "2026-09-12T08:00:00.000Z",
            "format": "resume-pro.snapshot",
            "formatVersion": 1,
            "groups": [{ "name": "基本信息", "fields": [{ "key": "姓名", "value": "合成" }, { "key": "备注", "value": "<img src=x onerror=alert(1)>" }] }],
            "omittedFieldCount": 2,
            "templateName": "合成模板",
            "templateVersion": "0123456789ab"
        })
        .to_string()
        .into_bytes()
    }

    fn archive() -> (tempfile::TempDir, ArchiveStore, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(&dir.path().join("archive"), &dir.path().join("current.json")).unwrap();
        let app = create_application(
            &store,
            serde_json::from_value(json!({ "company": "Synthetic", "title": "Job" })).unwrap(),
        )
        .unwrap()
        .application
        .unwrap()
        .id
        .clone();
        let bytes = document();
        fill(&store, "aaaaaaaa-0000-4000-8000-000000000001", &app, STORED);
        chunk(&store, "aaaaaaaa-0000-4000-8000-000000000002", &app, STORED, &bytes, 0, 1, bytes.clone());
        store.complete_snapshot_upload(CLIENT, STORED).unwrap();
        fill(&store, "aaaaaaaa-0000-4000-8000-000000000003", &app, UPLOADING);
        let half = bytes[..bytes.len() / 2].to_vec();
        chunk(&store, "aaaaaaaa-0000-4000-8000-000000000004", &app, UPLOADING, &bytes, 0, 2, half);
        fill(&store, "aaaaaaaa-0000-4000-8000-000000000005", &app, MISSING);
        (dir, store, app)
    }

    #[test]
    fn the_detail_view_carries_every_snapshot_and_the_state_of_each_one_a_fill_names() {
        let (_dir, store, app) = archive();
        let view = serde_json::to_value(get_application(&store, &app).unwrap()).unwrap();
        assert_eq!(view["snapshotStates"][STORED], "stored");
        assert_eq!(view["snapshotStates"][UPLOADING], "uploading");
        assert_eq!(view["snapshotStates"][MISSING], "missing");
        let snapshots = view["snapshots"].as_array().unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0]["snapshot_id"], STORED);
        assert_eq!(snapshots[0]["template_name"], "合成模板");
    }

    /// Store `bytes` as a complete snapshot `id` under the application.
    fn stored(store: &ArchiveStore, app: &str, id: &str, prefix: &str, bytes: Vec<u8>) {
        fill(store, &format!("{prefix}-0000-4000-8000-000000000001"), app, id);
        chunk(store, &format!("{prefix}-0000-4000-8000-000000000002"), app, id, &bytes, 0, 1, bytes.clone());
        store.complete_snapshot_upload(CLIENT, id).unwrap();
    }

    #[test]
    fn a_credential_a_careless_client_put_in_a_snapshot_never_reaches_the_viewer() {
        // The plugin strips these before it serialises; the archive keeps whatever a paired
        // client sent, so the desktop applies the same rules again (data-privacy §4.1).
        let (_dir, store, app) = archive();
        const LEAKY: &str = "99999999-9999-4999-8999-999999999999";
        let doc = json!({
            "capturedAt": "2026-09-12T08:00:00.000Z",
            "format": "resume-pro.snapshot",
            "formatVersion": 1,
            "groups": [
                { "name": "账号", "fields": [
                    { "key": "登录密码", "value": "hunter2-synthetic" },
                    { "key": "access_token", "value": "tok-synthetic" },
                    { "key": "apiKey", "value": "sk-synthetic" }
                ] },
                { "name": "其他", "fields": [
                    { "key": "备注", "value": "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" },
                    { "key": "个人简介", "value": "熟悉 API Key 管理平台" }
                ] }
            ],
            "omittedFieldCount": 1,
            "templateName": "合成模板",
            "templateVersion": "0123456789ab"
        })
        .to_string()
        .into_bytes();
        stored(&store, &app, LEAKY, "bbbbbbbb", doc);

        let view = serde_json::to_value(get_snapshot(&store, LEAKY).unwrap()).unwrap();
        let text = view.to_string();
        for secret in ["hunter2-synthetic", "tok-synthetic", "sk-synthetic", "abcdefghijklmnopqrstuvwxyz"] {
            assert!(!text.contains(secret), "{secret} reached the viewer");
        }
        assert_eq!(view["omittedFieldCount"], 5, "the one the plugin dropped plus four more");
        let groups = view["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1, "a group with nothing left is not shown");
        assert_eq!(groups[0]["fields"][0]["key"], "个人简介");
    }

    #[test]
    fn a_fill_that_names_another_applications_snapshot_is_not_offered_it() {
        let (_dir, store, app) = archive();
        let other = create_application(
            &store,
            serde_json::from_value(json!({ "company": "Other", "title": "Job" })).unwrap(),
        )
        .unwrap()
        .application
        .unwrap()
        .id
        .clone();
        const THEIRS: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        stored(&store, &other, THEIRS, "dddddddd", document());
        fill(&store, "eeeeeeee-0000-4000-8000-000000000001", &app, THEIRS);
        let view = serde_json::to_value(get_application(&store, &app).unwrap()).unwrap();
        assert_eq!(view["snapshotStates"][THEIRS], "missing");
    }

    #[test]
    fn plural_labels_and_credential_groups_are_stripped_at_the_desktop_too() {
        let (_dir, store, app) = archive();
        const SHEET: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        let doc = json!({
            "format": "resume-pro.snapshot",
            "formatVersion": 1,
            "groups": [
                { "name": "API Keys", "fields": [{ "key": "OpenAI", "value": "opaque-synthetic" }] },
                { "name": "账号", "fields": [{ "key": "Passwords", "value": "plural-synthetic" }, { "key": "邮箱", "value": "a@example.com" }] }
            ],
            "omittedFieldCount": 0,
            "templateName": "合成模板"
        })
        .to_string()
        .into_bytes();
        stored(&store, &app, SHEET, "abababab", doc);
        let view = serde_json::to_value(get_snapshot(&store, SHEET).unwrap()).unwrap();
        let text = view.to_string();
        assert!(!text.contains("opaque-synthetic") && !text.contains("plural-synthetic"));
        assert!(!text.contains("API Keys"));
        assert_eq!(view["omittedFieldCount"], 2);
    }

    #[test]
    fn a_snapshot_in_a_later_format_version_is_not_read_as_version_one() {
        let (_dir, store, app) = archive();
        const LATER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let doc = json!({
            "format": "resume-pro.snapshot",
            "formatVersion": 2,
            "groups": [{ "name": "经历", "fields": [{ "key": "描述", "value": "合成" }] }],
            "templateName": "合成模板"
        })
        .to_string()
        .into_bytes();
        stored(&store, &app, LATER, "cccccccc", doc);
        let err = get_snapshot(&store, LATER).unwrap_err();
        assert_eq!(err.code, "UNSUPPORTED_SNAPSHOT_VERSION");
        assert!(err.message.contains("更新桌面程序"));
    }

    #[test]
    fn reading_a_snapshot_returns_its_groups_and_nothing_from_a_tampered_file() {
        let (dir, store, _app) = archive();
        let view = serde_json::to_value(get_snapshot(&store, STORED).unwrap()).unwrap();
        assert_eq!(view["templateName"], "合成模板");
        assert_eq!(view["capturedAt"], "2026-09-12T08:00:00.000Z");
        assert_eq!(view["omittedFieldCount"], 2);
        assert_eq!(view["groups"][0]["fields"][0]["key"], "姓名");

        let meta = store.get_snapshot(STORED).unwrap().unwrap();
        let path = dir.path().join("archive").join(&meta.stored_rel_path);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[5] ^= 0x01;
        std::fs::write(&path, bytes).unwrap();
        assert!(get_snapshot(&store, STORED).is_err());
        assert_eq!(get_snapshot(&store, MISSING).unwrap_err().code, "NOT_FOUND");
    }
}
