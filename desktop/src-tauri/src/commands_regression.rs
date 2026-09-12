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

// --- D09 PR 3: importing evidence, the inbox, previews, association and classification ---

mod evidence {
    use crate::commands::*;
    use crate::evidence_commands::{self, ImportArgs};
    use archive_store::ArchiveStore;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    const BUCKET: &str = "2026/09";

    fn archive() -> (tempfile::TempDir, ArchiveStore, String) {
        let dir = tempfile::tempdir().unwrap();
        let store =
            open_store(&dir.path().join("archive"), &dir.path().join("current.json")).unwrap();
        let app = create_application(
            &store,
            serde_json::from_value(json!({ "company": "Synthetic", "title": "Job" })).unwrap(),
        )
        .unwrap()
        .application
        .unwrap()
        .id
        .clone();
        (dir, store, app)
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    fn eml(subject: &str) -> Vec<u8> {
        format!("From: hr@example.test\r\nSubject: {subject}\r\nDate: Fri, 12 Sep 2026 08:00:00 +0000\r\n\r\n下周二上午十点面试。\r\n")
            .into_bytes()
    }

    /// 一个合成 PNG：魔数对得上、能读回来就够了。
    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        bytes.extend_from_slice(&[0u8; 32]);
        bytes
    }

    fn import(
        store: &ArchiveStore,
        paths: Vec<String>,
        text: Option<String>,
        app: Option<&str>,
    ) -> evidence_commands::ImportReport {
        evidence_commands::import_evidence(
            store,
            ImportArgs {
                paths,
                text,
                application_id: app.map(str::to_string),
            },
            BUCKET,
        )
        .unwrap()
    }

    #[test]
    fn one_bad_file_does_not_take_the_good_ones_with_it() {
        let (dir, store, _app) = archive();
        let good = write(dir.path(), "面试邀请.eml", &eml("面试邀请"));
        let bad = write(
            dir.path(),
            "invite.msg",
            b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 padding",
        );

        let report = import(&store, vec![good, bad], None, None);

        assert_eq!(report.imported.len(), 1);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].code, "unsupported");
        assert_eq!(report.failed[0].name, "invite.msg");
        let one = &report.imported[0];
        assert_eq!(one.kind, "eml");
        assert_eq!(one.subject.as_deref(), Some("面试邀请"));
        assert_eq!(one.from_addr.as_deref(), Some("hr@example.test"));
        assert_eq!(
            one.sent_at.as_deref(),
            Some("2026-09-12T08:00:00.000Z"),
            "档案层把时间规范成毫秒精度"
        );
        assert_eq!(
            one.application_id, None,
            "还没有选申请：它待在收件箱里"
        );
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
    }

    #[test]
    fn the_same_bytes_are_reported_as_a_duplicate_and_stored_once() {
        let (dir, store, _app) = archive();
        let path = write(dir.path(), "reply.eml", &eml("同一封"));

        let first = import(&store, vec![path.clone()], None, None);
        assert_eq!(first.imported.len(), 1);
        assert!(first.duplicates.is_empty());

        let again = import(&store, vec![path], None, None);
        assert!(again.imported.is_empty());
        assert_eq!(again.duplicates.len(), 1);
        assert_eq!(
            again.duplicates[0].same_bytes_as.len(),
            1,
            "提示指向先导入的那条"
        );

        let blob_dir = store
            .archive_dir()
            .join("attachments")
            .join("2026")
            .join("09");
        assert_eq!(
            std::fs::read_dir(blob_dir).unwrap().count(),
            1,
            "字节只存一份"
        );
    }

    #[test]
    fn evidence_moves_in_and_out_of_an_application_with_the_state_following() {
        let (dir, store, app) = archive();
        let path = write(dir.path(), "reply.eml", &eml("回复"));
        let id = import(&store, vec![path], None, None).imported[0].id.clone();
        let state = |store: &ArchiveStore| {
            store
                .get_application(&app)
                .unwrap()
                .unwrap()
                .reply_evidence_state
                .as_str()
                .to_string()
        };
        assert_eq!(state(&store), "none_imported");

        evidence_commands::associate(&store, &id, &app).unwrap();
        assert_eq!(
            state(&store),
            "imported_unclassified",
            "关联后未分类，不能说尚未导入"
        );

        evidence_commands::unassociate(&store, &id).unwrap();
        assert_eq!(state(&store), "none_imported");
        assert_eq!(evidence_commands::list_inbox(&store).unwrap().len(), 1);

        evidence_commands::associate(&store, &id, &app).unwrap();
        let classified =
            evidence_commands::classify(&store, &id, "interview_invite", "automated").unwrap();
        assert_eq!(classified.reply_class.as_deref(), Some("interview_invite"));
        assert_eq!(
            classified.send_mode.as_deref(),
            Some("automated"),
            "不因为是面试邀请就写成人工"
        );
        assert_eq!(state(&store), "classified");
        assert_eq!(
            store
                .get_application(&app)
                .unwrap()
                .unwrap()
                .current_stage
                .as_str(),
            "saved",
            "导入与分类都不改阶段"
        );
        assert!(evidence_commands::classify(&store, &id, "made_up", "human").is_err());
    }

    #[test]
    fn a_preview_is_text_or_a_data_url_and_never_a_path() {
        let (dir, store, _app) = archive();
        let mail = write(dir.path(), "reply.eml", &eml("面试邀请"));
        let shot = write(dir.path(), "screenshot.png", &png());
        let pdf = write(dir.path(), "offer.pdf", b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
        let report = import(
            &store,
            vec![mail, shot, pdf],
            Some("他们说下周二面试。".into()),
            None,
        );
        assert_eq!(report.imported.len(), 4, "{:?}", report.failed);

        let by_kind = |kind: &str| {
            report
                .imported
                .iter()
                .find(|item| item.kind == kind)
                .unwrap()
                .id
                .clone()
        };

        let mail = evidence_commands::get_preview(&store, &by_kind("eml")).unwrap();
        assert!(mail.body_extract.unwrap().contains("下周二上午十点"));
        assert!(mail.image_data_url.is_none());

        let shot = evidence_commands::get_preview(&store, &by_kind("screenshot")).unwrap();
        assert!(shot
            .image_data_url
            .unwrap()
            .starts_with("data:image/png;base64,"));

        let pdf = evidence_commands::get_preview(&store, &by_kind("pdf")).unwrap();
        assert!(pdf.image_data_url.is_none());
        assert!(pdf.note.unwrap().contains("系统程序"));

        let pasted = evidence_commands::get_preview(&store, &by_kind("paste")).unwrap();
        assert_eq!(pasted.body_extract.as_deref(), Some("他们说下周二面试。"));

        // 给 WebView 的任何一条里都没有存储路径。
        for id in report.imported.iter().map(|item| item.id.clone()) {
            let json =
                serde_json::to_string(&evidence_commands::get_preview(&store, &id).unwrap())
                    .unwrap();
            assert!(!json.contains("attachments/"), "{json}");
            assert!(!json.contains(&store.archive_dir().to_string_lossy().to_string()));
        }
    }

    #[test]
    fn a_copy_that_is_gone_says_so_instead_of_pretending() {
        let (dir, store, _app) = archive();
        let path = write(dir.path(), "reply.eml", &eml("回复"));
        let id = import(&store, vec![path], None, None).imported[0].id.clone();
        let stored: PathBuf = evidence_commands::stored_path(&store, &id).unwrap();
        assert!(stored.starts_with(store.archive_dir().canonicalize().unwrap()));

        std::fs::remove_file(&stored).unwrap();
        let preview = evidence_commands::get_preview(&store, &id).unwrap();
        assert!(preview.note.unwrap().contains("不在了"));
        assert!(evidence_commands::stored_path(&store, &id).is_err());
    }
}
