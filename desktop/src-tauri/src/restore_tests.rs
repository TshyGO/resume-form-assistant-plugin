//! D12 恢复的回归测试。
//!
//! 每一条成功路径旁边都要有一条失败路径，而且失败路径断言的是**同一件事**：
//! 现有档案与指针原封不动。这块是整个项目里最容易把用户数据弄坏的地方，只测
//! 「能恢复」等于没测。

use super::*;
use crate::commands::{create_application, open_store};
use archive_store::{NewTodo, ReminderState, TodoDue};
use serde_json::json;

const NOW: &str = "2026-09-13T02:00:00.000Z";

struct Layout {
    _dir: tempfile::TempDir,
    paths: RestorePaths,
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
    Layout { _dir: dir, paths }
}

/// 一个有内容的档案：一条申请 + 一条已经登记过提醒的待办。
fn seeded(paths: &RestorePaths) -> (ArchiveStore, String) {
    let store = open_store(&paths.archive_dir, &paths.current_pointer).unwrap();
    let app = create_application(
        &store,
        serde_json::from_value(json!({ "company": "合成公司", "title": "后端工程师" })).unwrap(),
    )
    .unwrap()
    .application
    .unwrap()
    .id
    .clone();
    let todo = store
        .create_todo(NewTodo {
            application_id: app.clone(),
            title: "一面".into(),
            due: TodoDue::DateTime("2026-09-20T02:00:00Z".into()),
            time_zone: Some("Asia/Shanghai".into()),
            remind_at_utc: None,
            interview_round: Some(1),
            source_event_id: None,
        })
        .unwrap();
    store
        .set_todo_reminder(
            &todo.id,
            ReminderState::Scheduled,
            Some("2026-09-20T02:00:00Z"),
            Some("toast:this-machine-only"),
        )
        .unwrap();
    (store, app)
}

fn export_to(store: &ArchiveStore, paths: &RestorePaths, name: &str) -> std::path::PathBuf {
    let out = paths.data_root.join(name);
    export_archive(store, paths, &out, NOW).unwrap();
    out
}

#[test]
fn an_exported_archive_restores_with_the_same_counts() {
    let source = layout();
    let (store, _app) = seeded(&source.paths);
    let before = store.counts().unwrap();
    let package = export_to(&store, &source.paths, "backup.zip");
    store.close().unwrap();

    // 恢复到一台「新机器」：另一个 data_root，里面什么都没有。
    let target = layout();
    let report = restore_archive(&target.paths, &package, NOW, || Ok(())).unwrap();

    assert_eq!(report.counts, before);
    assert!(!report.restore_epoch.is_empty());
    let restored = ArchiveStore::open(ArchiveConfig::new(
        std::path::PathBuf::from(&report.archive_dir),
        target.paths.current_pointer.clone(),
    ))
    .unwrap();
    assert_eq!(restored.counts().unwrap(), before);
    assert_eq!(restored.counts().unwrap().applications, 1);
}

#[test]
fn restoring_the_same_backup_twice_mints_two_different_epochs() {
    let source = layout();
    let (store, _app) = seeded(&source.paths);
    let package = export_to(&store, &source.paths, "backup.zip");
    store.close().unwrap();

    let target = layout();
    let first = restore_archive(&target.paths, &package, NOW, || Ok(())).unwrap();
    let second = restore_archive(&target.paths, &package, NOW, || Ok(())).unwrap();

    assert_ne!(
        first.restore_epoch, second.restore_epoch,
        "restoreEpoch 不能从备份里拷，也不能是 generation+1——同一个包恢复两次必须是两个身份"
    );
}

#[test]
fn a_restore_clears_the_reminder_bookkeeping_but_keeps_the_overdue_acknowledgement() {
    let source = layout();
    let (store, app) = seeded(&source.paths);
    // 再加一条已经报过逾期的待办。
    let acked = store
        .create_todo(NewTodo {
            application_id: app,
            title: "早就该做的".into(),
            due: TodoDue::Date("2026-09-01".into()),
            time_zone: None,
            remind_at_utc: None,
            interview_round: None,
            source_event_id: None,
        })
        .unwrap();
    store.ack_overdue(&[acked.id.clone()], NOW).unwrap();
    let package = export_to(&store, &source.paths, "backup.zip");
    store.close().unwrap();

    let target = layout();
    let report = restore_archive(&target.paths, &package, NOW, || Ok(())).unwrap();

    assert_eq!(report.reminders_cleared, 1);
    let restored = ArchiveStore::open(ArchiveConfig::new(
        std::path::PathBuf::from(&report.archive_dir),
        target.paths.current_pointer.clone(),
    ))
    .unwrap();
    for todo in restored.list_todos(None, None, None, 100, 0).unwrap() {
        assert_eq!(
            todo.reminder_state,
            ReminderState::None,
            "句柄指向的是原来那台机器上的 OS 计划，带过来就是在撒谎"
        );
        assert!(todo.reminder_handle.is_none());
        assert!(todo.reminder_scheduled_for_utc.is_none());
        if todo.id == acked.id {
            assert!(
                todo.overdue_ack_at.is_some(),
                "「已经跟用户说过了」换台机器也仍然说过了，再报一遍就是重复轰炸"
            );
        }
    }
}

#[test]
fn a_backup_that_does_not_validate_leaves_the_current_archive_untouched() {
    let target = layout();
    let (store, _app) = seeded(&target.paths);
    let before = store.counts().unwrap();
    let pointer_before = std::fs::read_to_string(&target.paths.current_pointer).unwrap();
    store.close().unwrap();

    // 一个内容被改过的包。
    let source = layout();
    let (donor, _) = seeded(&source.paths);
    let package = export_to(&donor, &source.paths, "backup.zip");
    donor.close().unwrap();
    let mut bytes = std::fs::read(&package).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0xff;
    std::fs::write(&package, &bytes).unwrap();

    let error = restore_archive(&target.paths, &package, NOW, || {
        panic!("校验都没过就不该去关现有的库")
    })
    .unwrap_err();

    assert_eq!(error.code, "BACKUP_ERROR", "{error:?}");
    assert_eq!(
        std::fs::read_to_string(&target.paths.current_pointer).unwrap(),
        pointer_before,
        "指针不能被动过"
    );
    let still = ArchiveStore::open(ArchiveConfig::new(
        target.paths.archive_dir.clone(),
        target.paths.current_pointer.clone(),
    ))
    .unwrap();
    assert_eq!(still.counts().unwrap(), before);
    assert!(
        !target.paths.data_root.join("archives-staging").join("..").exists()
            || staging_children(&target.paths) == 0,
        "失败之后不该留下 staging 残留"
    );
}

fn staging_children(paths: &RestorePaths) -> usize {
    let dir = paths.data_root.join("archives-staging");
    std::fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
}

#[test]
fn the_old_archive_becomes_a_rollback_point_and_can_be_rolled_back_to() {
    let target = layout();
    let (store, _app) = seeded(&target.paths);
    let original = store.counts().unwrap();
    store.close().unwrap();

    // 另一份内容不同的备份：只有申请，没有待办。
    let source = layout();
    let donor = open_store(&source.paths.archive_dir, &source.paths.current_pointer).unwrap();
    create_application(
        &donor,
        serde_json::from_value(json!({ "company": "另一家", "title": "全栈" })).unwrap(),
    )
    .unwrap();
    let package = export_to(&donor, &source.paths, "other.zip");
    donor.close().unwrap();

    let restored = restore_archive(&target.paths, &package, NOW, || Ok(())).unwrap();
    assert_eq!(restored.counts.todos, 0);

    let points = list_rollback_points(&target.paths).unwrap();
    assert_eq!(points.len(), 1, "旧档案要变成一个回滚点");
    assert_eq!(points[0].id, restored.rollback_point);

    let back = rollback_to(&target.paths, &points[0].id, NOW, || Ok(())).unwrap();

    assert_eq!(back.counts, original, "回滚要回到原来那份档案");
    assert_ne!(
        back.restore_epoch, restored.restore_epoch,
        "回滚也是一次新切换，epoch 要再铸一个"
    );
    assert_eq!(
        list_rollback_points(&target.paths).unwrap().len(),
        1,
        "刚才恢复出来的那份跟着退休，所以回滚本身也是可逆的"
    );
}

#[test]
fn a_rollback_id_cannot_point_outside_the_retired_directory() {
    let target = layout();
    let (store, _app) = seeded(&target.paths);
    store.close().unwrap();

    for evil in ["", "..", "../archive", "..\\archive", "a/../../b"] {
        let error = rollback_to(&target.paths, evil, NOW, || {
            panic!("参数都不合法就不该去关现有的库")
        })
        .unwrap_err();
        assert!(
            error.code == "VALIDATION" || error.code == "NOT_FOUND",
            "{evil:?} → {error:?}"
        );
    }
}

#[test]
fn an_export_carries_the_settings_we_allow_and_nothing_else() {
    let target = layout();
    let (store, _app) = seeded(&target.paths);
    std::fs::write(
        &target.paths.settings_file,
        r#"{"pairing":{"chrome":"diagjmploldedipjdenmecmjokckelkl"},"apiKey":"sk-must-not-travel"}"#,
    )
    .unwrap();

    let package = export_to(&store, &target.paths, "backup.zip");
    store.close().unwrap();

    let raw = std::fs::read(&package).unwrap();
    let text = String::from_utf8_lossy(&raw);
    // zip 是压缩过的，直接搜字符串不可靠——解出来看。
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("s");
    backup::extract_to_staging(&package, &staging).unwrap();
    let settings = std::fs::read_to_string(staging.join("settings.json")).unwrap();
    assert!(settings.contains("diagjmpl"));
    assert!(!settings.contains("sk-must-not-travel"));
    let _ = text;
}

#[test]
fn the_machine_local_pointer_never_travels_in_a_backup() {
    let target = layout();
    let (store, _app) = seeded(&target.paths);
    let package = export_to(&store, &target.paths, "backup.zip");
    store.close().unwrap();

    let manifest = backup::read_manifest(&package).unwrap();
    let paths: Vec<&str> = manifest.entries.iter().map(|e| e.path.as_str()).collect();

    assert!(
        !paths.iter().any(|p| p.contains("current.json")),
        "current.json 是机器本地的东西，带走就等于把别人的 epoch 也带走了：{paths:?}"
    );
    // 而清单里带着 archiveId，恢复时要靠它对账。
    assert!(!manifest.archive_id.is_empty());
}

#[test]
fn an_export_that_fails_does_not_leave_a_snapshot_behind() {
    let target = layout();
    let (store, _app) = seeded(&target.paths);

    // 目标是一个已经存在的目录，写不进去。
    let blocked = target.paths.data_root.join("a-directory");
    std::fs::create_dir_all(&blocked).unwrap();
    assert!(export_archive(&store, &target.paths, &blocked, NOW).is_err());

    let leftovers: Vec<String> = std::fs::read_dir(target.paths.data_root.join("archives-staging"))
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    assert!(leftovers.is_empty(), "中间快照要收走：{leftovers:?}");
}
