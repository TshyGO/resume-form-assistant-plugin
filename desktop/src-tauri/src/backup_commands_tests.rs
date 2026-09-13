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

    assert!(preview.same_archive, "自己的备份恢复回自己，不该被说成换了档案");
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
        report.skipped.iter().any(|line| line.contains("mystery.bin")),
        "清单没覆盖的东西要让人看见，否则清单永远不会被补上：{:?}",
        report.skipped
    );
}
