//! D12 命令层的回归测试。
//!
//! 重点有两个：**预览不写盘**，以及**恢复之后插件的旧消息不会静默回灌**。
//! 后者的机制是 D05/D07 在存储层做的，这里要证明恢复这条路没把它绕开。

use super::*;
use crate::commands::{create_application, open_store};
use archive_store::{FillOutcome, FillSubmitInput, Occurred, PluginOp, PluginWriteContext};
use serde_json::json;
use std::sync::Mutex;

const NOW: &str = "2026-09-13T02:00:00.000Z";
const CLIENT: &str = "11111111-1111-4111-8111-111111111111";

struct Layout {
    _dir: tempfile::TempDir,
    paths: RestorePaths,
    slot: Mutex<Option<ArchiveStore>>,
}

fn layout() -> Layout {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let paths = RestorePaths {
        archive_dir: root.join("archive"),
        current_pointer: root.join("current.json"),
        archives_retired_dir: root.join("archives-retired"),
        settings_file: root.join("settings.json"),
        data_root: root,
    };
    Layout {
        _dir: dir,
        paths,
        slot: Mutex::new(None),
    }
}

impl Layout {
    fn open(&self) -> &Self {
        let store = open_store(&self.paths.archive_dir, &self.paths.current_pointer).unwrap();
        *self.slot.lock().unwrap() = Some(store);
        self
    }

    fn slot(&self) -> StoreSlot<'_> {
        StoreSlot { slot: &self.slot }
    }

    fn with<T>(&self, f: impl FnOnce(&ArchiveStore) -> T) -> T {
        let guard = self.slot.lock().unwrap();
        f(guard.as_ref().expect("store 应该是开着的"))
    }

    fn seed(&self, company: &str) -> String {
        self.with(|store| {
            create_application(
                store,
                serde_json::from_value(json!({ "company": company, "title": "后端工程师" }))
                    .unwrap(),
            )
            .unwrap()
            .application
            .unwrap()
            .id
            .clone()
        })
    }

    fn export_to(&self, name: &str) -> std::path::PathBuf {
        let out = self.paths.data_root.join(name);
        self.with(|store| export(store, &self.paths, &out, NOW).unwrap());
        out
    }
}

#[test]
fn telemetry_state_is_not_exported_or_restored_over_a_local_opt_out() {
    let source = layout();
    source.open().seed("合成公司");
    std::fs::write(
        source.paths.data_root.join("telemetry-state.json"),
        br#"{"enabled":true,"installation_id":"synthetic-statistics-id"}"#,
    )
    .unwrap();
    std::fs::write(source.paths.data_root.join("telemetry-initialized"), b"1").unwrap();
    let package = source.export_to("backup.zip");
    let manifest = backup::read_manifest(&package).unwrap();
    assert!(manifest
        .entries
        .iter()
        .all(|entry| !entry.path.contains("telemetry")));
    source.slot().close().unwrap();

    let target = layout();
    target.open();
    let local_state = target.paths.data_root.join("telemetry-state.json");
    std::fs::write(&local_state, br#"{"enabled":false}"#).unwrap();
    std::fs::write(target.paths.data_root.join("telemetry-initialized"), b"1").unwrap();
    restore(&target.slot(), &target.paths, &package, NOW).unwrap();
    assert_eq!(
        std::fs::read(&local_state).unwrap(),
        br#"{"enabled":false}"#
    );
    assert_eq!(
        std::fs::read(target.paths.data_root.join("telemetry-initialized")).unwrap(),
        b"1"
    );
}

#[test]
fn a_preview_compares_the_package_with_what_is_here_and_writes_nothing() {
    let source = layout();
    source.open().seed("合成公司");
    let package = source.export_to("backup.zip");
    source.slot().close().unwrap();

    let target = layout();
    target.open();
    target.seed("另一家");
    target.seed("第三家");

    let listing_before = std::fs::read_dir(target.paths.data_root.join("archives-staging"))
        .map(|d| d.count())
        .unwrap_or(0);
    let preview = target.with(|store| preview(store, &target.paths, &package).unwrap());

    assert_eq!(preview.incoming.applications, 1);
    assert_eq!(preview.current.applications, 2);
    assert!(!preview.same_archive, "两个档案不是同一个身份");
    assert_eq!(preview.existing_rollback_points, 0);
    assert!(!preview.too_many_rollback_points);
    assert_eq!(
        std::fs::read_dir(target.paths.data_root.join("archives-staging"))
            .map(|d| d.count())
            .unwrap_or(0),
        listing_before,
        "用户还没确认，预览不该往盘上写东西"
    );
}

#[test]
fn a_preview_says_when_it_is_the_same_archive() {
    let here = layout();
    here.open().seed("合成公司");
    let package = here.export_to("mine.zip");

    let preview = here.with(|store| preview(store, &here.paths, &package).unwrap());

    assert!(
        preview.same_archive,
        "自己的备份恢复回自己，不该被说成换了档案"
    );
}

#[test]
fn restoring_swaps_the_live_store_so_later_commands_see_the_new_archive() {
    let source = layout();
    source.open().seed("合成公司");
    let package = source.export_to("backup.zip");
    source.slot().close().unwrap();

    let target = layout();
    target.open();
    target.seed("另一家");
    target.seed("第三家");

    let report = restore(&target.slot(), &target.paths, &package, NOW).unwrap();

    assert_eq!(report.counts.applications, 1);
    // 关键：命令层要能接着用，而且看到的是新档案。
    target.with(|store| {
        assert_eq!(store.counts().unwrap().applications, 1);
        assert_eq!(store.identity().restore_epoch, report.restore_epoch);
    });
}

#[test]
fn a_plugin_message_stamped_with_the_old_epoch_is_refused_after_a_restore() {
    let here = layout();
    here.open();
    let app = here.seed("合成公司");
    let package = here.export_to("backup.zip");

    // 恢复之前记下当时的身份——这就是插件那边队列里盖着的章。
    let stale = here.with(|store| store.identity());

    let report = restore(&here.slot(), &here.paths, &package, NOW).unwrap();
    assert_ne!(report.restore_epoch, stale.restore_epoch);

    // 拿旧 epoch 提交一条填写事件。
    let op = PluginOp::FillSubmit(FillSubmitInput {
        application_id: app.clone(),
        outcome: FillOutcome::Completed,
        field_count: None,
        filled_count: None,
        unconfirmed_count: None,
        durations_ms: None,
        url_redacted: None,
        template_name: None,
        template_version: None,
        snapshot_id: None,
        plugin_version: Some("0.4.0".into()),
        occurred: Occurred::Unknown,
    });
    let ctx = PluginWriteContext {
        envelope_identity: Some(stale.clone()),
        client_instance_id: CLIENT.into(),
        message_id: "stale-message".into(),
        source_restore_epoch: stale.restore_epoch.clone(),
        payload_sha256: op.digest().unwrap(),
    };

    let refused = here.with(|store| store.submit_plugin_message(&ctx, op));

    assert!(
        refused.is_err(),
        "恢复之后旧 epoch 的消息必须被拒，否则队列会把旧世界的写入灌进新档案"
    );
    let message = format!("{:?}", refused.unwrap_err());
    assert!(
        message.contains("restore_epoch_mismatch") || message.contains("RestoreEpochMismatch"),
        "错误要说得出是 epoch 对不上，插件那边才知道该暂停而不是重试：{message}"
    );
}

#[test]
fn the_preview_warns_once_there_are_too_many_rollback_points() {
    let here = layout();
    here.open().seed("合成公司");
    let package = here.export_to("backup.zip");

    for _ in 0..KEEP_ROLLBACK_POINTS {
        restore(&here.slot(), &here.paths, &package, NOW).unwrap();
    }

    let preview = here.with(|store| preview(store, &here.paths, &package).unwrap());
    assert_eq!(preview.existing_rollback_points, KEEP_ROLLBACK_POINTS);
    assert!(
        preview.too_many_rollback_points,
        "超过上限只提示，不自动删——自动删会在用户最需要的时候删掉那一个"
    );
    // 而且确实没有自动删。
    assert_eq!(
        rollback_points(&here.paths).unwrap().len(),
        KEEP_ROLLBACK_POINTS
    );
}

#[test]
fn a_rejected_package_leaves_the_live_store_open() {
    let here = layout();
    here.open().seed("合成公司");
    let before = here.with(|store| store.counts().unwrap());

    let junk = here.paths.data_root.join("not-a-backup.zip");
    std::fs::write(&junk, "这不是一个 zip".as_bytes()).unwrap();

    let error = restore(&here.slot(), &here.paths, &junk, NOW).unwrap_err();

    assert_eq!(error.code, "BACKUP_ERROR", "{error:?}");
    // store 一关，界面上所有命令都会开始报「档案不可用」。所以最后会被拒绝的
    // 包，不能先把它关掉。
    here.with(|store| assert_eq!(store.counts().unwrap(), before));
}

#[test]
fn the_export_report_surfaces_what_did_not_travel() {
    let here = layout();
    here.open().seed("合成公司");
    // 往档案目录里塞一个清单没覆盖的东西。
    std::fs::write(here.paths.archive_dir.join("mystery.bin"), b"?").unwrap();

    let out = here.paths.data_root.join("backup.zip");
    let report = here.with(|store| export(store, &here.paths, &out, NOW).unwrap());

    assert!(report.size_bytes > 0);
    assert!(
        report
            .skipped
            .iter()
            .any(|line| line.contains("mystery.bin")),
        "清单没覆盖的东西要让人看见，否则清单永远不会被补上：{:?}",
        report.skipped
    );
}

/// D11：桌面那条 AI Key 存在 OS 凭据库，接口地址存在 `ai-settings.json`。
/// 两样都不进备份（data-privacy §1）——换台机器重新配一次，比把凭据带着走安全。
#[test]
fn the_ai_settings_file_never_enters_a_backup() {
    let here = layout();
    here.open();
    here.seed("合成公司");
    std::fs::write(
        crate::ai_settings::path_for(&here.paths.data_root),
        r#"{"apiUrl":"https://api.deepseek.com/v1/chat/completions","model":"deepseek-chat"}"#,
    )
    .unwrap();

    let package = here.export_to("backup.zip");
    let bytes = std::fs::read(&package).unwrap();
    let dumped = String::from_utf8_lossy(&bytes);
    assert!(
        !dumped.contains("ai-settings"),
        "备份里出现了 ai-settings.json"
    );
    assert!(!dumped.contains("api.deepseek.com"), "备份里出现了接口地址");
}

fn attach(here: &Layout, application: &str, name: &str, bytes: &[u8]) {
    use sha2::{Digest, Sha256};
    here.with(|store| {
        let relative = format!("attachments/{name}");
        let path = store.archive_dir().join(&relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        store
            .import_evidence(archive_store::NewEvidence {
                application_id: Some(application.into()),
                kind: archive_store::EvidenceKind::Paste,
                blob: archive_store::AttachmentBlobMeta {
                    sha256: Sha256::digest(bytes)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                    size_bytes: bytes.len() as i64,
                    stored_rel_path: relative,
                    mime: Some("text/plain".into()),
                },
                original_filename: None,
                subject: None,
                from_addr: None,
                sent_at: None,
                body_extract: None,
                append_event: true,
            })
            .unwrap();
    });
}

#[test]
fn restoring_then_exporting_and_rolling_back_uses_the_active_directory_and_survives_restart() {
    let here = layout();
    here.open();
    let app = here.seed("original");
    attach(&here, &app, "original.txt", b"original attachment");
    let original_package = here.export_to("original.rpbak");
    let first = restore(&here.slot(), &here.paths, &original_package, NOW).unwrap();
    let added = here.seed("after restore");
    attach(&here, &added, "new.txt", b"new attachment");
    // Deliberately retain the old RestorePaths, as startup HostPaths used to do.
    let second_package = here.export_to("after-restore.rpbak");
    let manifest = backup::read_manifest(&second_package).unwrap();
    assert_eq!(manifest.counts.applications, 2);
    assert_eq!(manifest.counts.attachments, 2);
    assert!(manifest
        .entries
        .iter()
        .any(|entry| entry.path == "archive/attachments/new.txt"));
    let extracted = here.paths.data_root.join("verify-export");
    backup::extract_to_staging(&second_package, &extracted).unwrap();
    assert_eq!(
        std::fs::read(extracted.join("archive/attachments/new.txt")).unwrap(),
        b"new attachment"
    );

    rollback(&here.slot(), &here.paths, &first.rollback_point, NOW).unwrap();
    let rolled_package = here.export_to("rolled.rpbak");
    assert_eq!(
        backup::read_manifest(&rolled_package)
            .unwrap()
            .counts
            .attachments,
        1
    );
    here.slot().close().unwrap();
    let restarted =
        crate::commands::open_current_store(&here.paths.archive_dir, &here.paths.current_pointer)
            .unwrap();
    assert_eq!(restarted.counts().unwrap().applications, 1);
    assert_ne!(restarted.archive_dir(), here.paths.archive_dir);
}

#[test]
fn a_failure_after_close_restores_the_original_pointer_epoch_and_writable_store() {
    let here = layout();
    here.open().seed("original");
    let package = here.export_to("original.rpbak");
    let pointer = std::fs::read(&here.paths.current_pointer).unwrap();
    let old_identity = here.with(|store| store.identity());
    // Actual restore reaches its switch with a missing pointer after closing the
    // old store. The command layer must restore the saved bytes, then reopen it.
    let error = transition(&here.slot(), &here.paths, |close| {
        restore_archive_open(&here.paths, &package, NOW, || {
            close()?;
            std::fs::remove_file(&here.paths.current_pointer).unwrap();
            Ok(())
        })
    })
    .unwrap_err();
    assert_eq!(error.code, "IO_ERROR");
    assert_eq!(std::fs::read(&here.paths.current_pointer).unwrap(), pointer);
    here.with(|store| assert_eq!(store.identity(), old_identity));
    here.seed("still writable");
    assert_eq!(here.with(|store| store.counts().unwrap().applications), 2);
}

#[test]
fn rollback_failure_reopens_the_old_store_and_keeps_the_rollback_point() {
    let here = layout();
    here.open().seed("original");
    let package = here.export_to("original.rpbak");
    let restored = restore(&here.slot(), &here.paths, &package, NOW).unwrap();
    here.seed("current");
    let identity = here.with(|store| store.identity());
    let error = transition(&here.slot(), &here.paths, |close| {
        rollback_to_open(&here.paths, &restored.rollback_point, NOW, || {
            close()?;
            std::fs::remove_file(&here.paths.current_pointer).unwrap();
            Ok(())
        })
    })
    .unwrap_err();
    assert_eq!(error.code, "IO_ERROR");
    here.with(|store| assert_eq!(store.identity(), identity));
    assert!(here
        .paths
        .archives_retired_dir
        .join(restored.rollback_point)
        .join("archive.db")
        .is_file());
    here.seed("still writable");
}

#[test]
fn a_secondary_recovery_error_preserves_data_and_reports_both_failures() {
    let here = layout();
    here.open().seed("original");
    let error = transition(&here.slot(), &here.paths, |close| {
        close()?;
        std::fs::remove_file(&here.paths.current_pointer).unwrap();
        std::fs::create_dir(&here.paths.current_pointer).unwrap();
        Err(fail("SYNTHETIC_SWITCH_FAILURE", "synthetic switch failure"))
    })
    .unwrap_err();
    assert_eq!(error.code, "RESTORE_RECOVERY_FAILED");
    assert!(error.message.contains("synthetic switch failure"));
    assert!(error.message.contains("旧档案重开失败"));
    assert!(here.paths.archive_dir.join("archive.db").is_file());
    assert!(here.slot.lock().unwrap().is_none());
}

#[test]
fn the_store_slot_stays_locked_during_the_entire_transition() {
    let here = layout();
    here.open().seed("original");
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let worker_here = &here;
        let worker = scope.spawn(move || {
            transition(&worker_here.slot(), &worker_here.paths, |close| {
                close()?;
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Err(fail("SYNTHETIC", "synthetic interruption"))
            })
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(matches!(
            here.slot.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        release_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
    });
    here.seed("writable after transition");
}

#[test]
fn startup_recovers_the_pointer_if_a_switch_was_interrupted() {
    let here = layout();
    here.open().seed("original");
    let saved = crate::restore::recovery_pointer_path(&here.paths.current_pointer);
    let bytes = std::fs::read(&here.paths.current_pointer).unwrap();
    crate::restore::restore_pointer(&saved, &bytes).unwrap();
    here.slot().close().unwrap();
    std::fs::remove_file(&here.paths.current_pointer).unwrap();
    let store =
        crate::commands::open_current_store(&here.paths.archive_dir, &here.paths.current_pointer)
            .unwrap();
    assert_eq!(store.counts().unwrap().applications, 1);
    assert_eq!(std::fs::read(&here.paths.current_pointer).unwrap(), bytes);
}

#[test]
fn invalid_startup_pointers_never_create_a_replacement_archive() {
    let here = layout();
    here.open();
    here.slot().close().unwrap();
    let original = std::fs::read(&here.paths.current_pointer).unwrap();
    for bytes in [b"invalid".to_vec(), vec![b'x'; 65537]] {
        std::fs::write(&here.paths.current_pointer, bytes).unwrap();
        assert!(crate::commands::open_current_store(
            &here.paths.archive_dir,
            &here.paths.current_pointer
        )
        .is_err());
    }
    let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    for path in [
        here.paths.data_root.join("missing"),
        here.paths.data_root.clone(),
        here.paths.data_root.parent().unwrap().to_owned(),
    ] {
        value["archive_dir"] = serde_json::json!(path);
        std::fs::write(
            &here.paths.current_pointer,
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert!(crate::commands::open_current_store(
            &here.paths.archive_dir,
            &here.paths.current_pointer
        )
        .is_err());
    }
}

#[test]
fn a_leftover_recovery_pointer_can_be_atomically_replaced_on_this_platform() {
    let here = layout();
    here.open().seed("original");
    let saved = crate::restore::recovery_pointer_path(&here.paths.current_pointer);
    std::fs::write(&saved, b"previous recovery bytes").unwrap();
    let package = here.export_to("original.rpbak");
    restore(&here.slot(), &here.paths, &package, NOW).unwrap();
    assert!(!saved.exists());
    here.seed("writable after replace");
    assert_eq!(here.with(|store| store.counts().unwrap().applications), 2);
}

#[test]
fn rejecting_a_package_does_not_touch_recovery_evidence_and_pointer_reads_are_bounded() {
    let here = layout();
    here.open().seed("original");
    let saved = crate::restore::recovery_pointer_path(&here.paths.current_pointer);
    std::fs::write(&saved, b"previous evidence").unwrap();
    let bad = here.paths.data_root.join("bad.rpbak");
    std::fs::write(&bad, b"bad zip").unwrap();
    assert!(restore(&here.slot(), &here.paths, &bad, NOW).is_err());
    assert_eq!(std::fs::read(&saved).unwrap(), b"previous evidence");
    let original_pointer = std::fs::read(&here.paths.current_pointer).unwrap();
    std::fs::write(&here.paths.current_pointer, vec![b'x'; 65537]).unwrap();
    let error = restore(&here.slot(), &here.paths, &bad, NOW).unwrap_err();
    assert!(error.message.contains("64 KiB"));
    assert_eq!(std::fs::read(&saved).unwrap(), b"previous evidence");
    assert!(here.slot.lock().unwrap().is_some());
    std::fs::write(&here.paths.current_pointer, original_pointer).unwrap();
    here.seed("still writable");
}

#[test]
fn a_lost_pointer_after_restore_never_creates_a_new_empty_archive() {
    let here = layout();
    here.open().seed("original");
    let package = here.export_to("original.rpbak");
    let restored = restore(&here.slot(), &here.paths, &package, NOW).unwrap();
    here.slot().close().unwrap();
    std::fs::remove_file(&here.paths.current_pointer).unwrap();
    let error =
        crate::commands::open_current_store(&here.paths.archive_dir, &here.paths.current_pointer)
            .err()
            .unwrap();
    assert_eq!(error.code, "STORE_OPEN_FAILED");
    assert!(!here.paths.archive_dir.join("archive.db").exists());
    assert!(!here.paths.current_pointer.exists());
    assert!(std::path::Path::new(&restored.archive_dir)
        .join("archive.db")
        .is_file());
}

#[test]
fn a_closed_unreadable_archive_can_be_previewed_and_replaced_without_losing_it() {
    let source = layout();
    source.open().seed("backup content");
    let package = source.export_to("rescue.rpbak");
    let target = layout();
    target.open().seed("unreadable original");
    target.slot().close().unwrap();
    let original = b"synthetic unreadable database";
    std::fs::write(target.paths.archive_dir.join("archive.db"), original).unwrap();
    assert!(crate::commands::open_current_store(
        &target.paths.archive_dir,
        &target.paths.current_pointer
    )
    .is_err());
    let preview = preview_optional(None, &target.paths, &package).unwrap();
    assert!(!preview.current_available);
    assert!(!preview.same_archive);
    assert_eq!(preview.incoming.applications, 1);
    let report = restore(&target.slot(), &target.paths, &package, NOW).unwrap();
    assert_eq!(
        std::fs::read(
            target
                .paths
                .archives_retired_dir
                .join(report.rollback_point)
                .join("archive.db")
        )
        .unwrap(),
        original
    );
    target.seed("writable after rescue");
    target.with(|store| assert_eq!(store.counts().unwrap().applications, 2));
}

#[test]
fn rescue_on_a_blank_target_and_rejecting_a_bad_package_need_no_live_store() {
    let source = layout();
    source.open().seed("backup content");
    let package = source.export_to("rescue.rpbak");
    let target = layout();
    let bad = target.paths.data_root.join("bad.rpbak");
    std::fs::write(&bad, b"bad zip").unwrap();
    assert_eq!(
        restore(&target.slot(), &target.paths, &bad, NOW)
            .unwrap_err()
            .code,
        "BACKUP_ERROR"
    );
    assert!(!target.paths.current_pointer.exists());
    assert!(target.slot.lock().unwrap().is_none());
    restore(&target.slot(), &target.paths, &package, NOW).unwrap();
    target.with(|store| assert_eq!(store.counts().unwrap().applications, 1));
}

#[test]
fn rescue_never_retires_an_external_directory_from_a_corrupt_pointer() {
    let source = layout();
    source.open().seed("backup content");
    let package = source.export_to("rescue.rpbak");
    let target = layout();
    let external = tempfile::tempdir().unwrap();
    std::fs::write(external.path().join("archive.db"), b"outside data").unwrap();
    std::fs::write(
        &target.paths.current_pointer,
        serde_json::to_vec(&json!({
            "archive_dir": external.path()
        }))
        .unwrap(),
    )
    .unwrap();
    restore(&target.slot(), &target.paths, &package, NOW).unwrap();
    assert_eq!(
        std::fs::read(external.path().join("archive.db")).unwrap(),
        b"outside data"
    );
}

#[test]
fn preparing_a_restore_does_not_lock_the_store_and_activation_uses_the_latest_archive() {
    let here = layout();
    here.open().seed("original");
    let package = here.export_to("original.rpbak");
    let prepared = {
        // Preparation must succeed even while a business operation holds the slot.
        let guard = here.slot.lock().unwrap();
        let prepared = crate::restore::prepare_restore(&here.paths, &package).unwrap();
        assert!(guard.is_some());
        prepared
    };
    // A different restore wins the switch while this package was being prepared.
    let intervening = restore(&here.slot(), &here.paths, &package, NOW).unwrap();
    here.seed("intervening write");
    let report = transition(&here.slot(), &here.paths, |close| {
        crate::restore::activate_restore(&here.paths, prepared, NOW, close)
    })
    .unwrap();
    assert!(!std::path::Path::new(&intervening.archive_dir).exists());
    assert!(here
        .paths
        .archives_retired_dir
        .join(&report.rollback_point)
        .join("archive.db")
        .is_file());
    rollback(&here.slot(), &here.paths, &report.rollback_point, NOW).unwrap();
    here.with(|store| assert_eq!(store.counts().unwrap().applications, 2));
}
