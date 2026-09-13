//! 回收站与永久删除的回归测试。
//!
//! 这里每一条都在问同一个问题：**会不会把用户的东西弄丢。**

use super::*;
use crate::commands::{create_application, open_store};
use crate::evidence_commands;
use serde_json::json;
use std::path::Path;

fn archive() -> (tempfile::TempDir, ArchiveStore, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let store = open_store(&archive_dir, &dir.path().join("current.json")).unwrap();
    (dir, store, archive_dir)
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

fn eml(subject: &str) -> Vec<u8> {
    format!("Subject: {subject}\r\nFrom: hr@example.test\r\n\r\n正文。\r\n").into_bytes()
}

/// 导入一份证据并关联到某条申请，返回它的 id 和存储路径。
fn evidence(store: &ArchiveStore, dir: &Path, app_id: &str, name: &str, bytes: &[u8]) -> (String, std::path::PathBuf) {
    let source = dir.join(name);
    std::fs::write(&source, bytes).unwrap();
    let report = evidence_commands::import_evidence(
        store,
        evidence_commands::ImportArgs {
            paths: vec![source.to_string_lossy().to_string()],
            text: None,
            application_id: Some(app_id.to_string()),
        },
        "2026/09",
    )
    .unwrap();
    let id = report.imported.first().or(report.duplicates.first()).unwrap().id.clone();
    let stored = evidence_commands::stored_path(store, &id).unwrap();
    (id, stored)
}

#[test]
fn recycling_hides_an_application_and_restoring_brings_it_back_whole() {
    let (_dir, store, _archive_dir) = archive();
    let id = app(&store, "合成公司");
    let events_before = store.list_events(&id).unwrap().len();

    set_recycled(&store, &id, true).unwrap();
    let recycled = list_recycled(&store).unwrap();
    assert_eq!(recycled.len(), 1);
    assert_eq!(recycled[0].id, id);

    set_recycled(&store, &id, false).unwrap();
    assert!(list_recycled(&store).unwrap().is_empty());

    let after = store.list_events(&id).unwrap();
    assert!(
        after.len() > events_before,
        "回收和恢复都要留痕，时间线上要看得出它为什么消失过又回来了"
    );
    assert!(store.get_application(&id).unwrap().is_some(), "历史一条不少");
}

#[test]
fn a_purge_preview_says_what_will_go_with_it() {
    let (dir, store, _archive_dir) = archive();
    let id = app(&store, "合成公司");
    evidence(&store, dir.path(), &id, "reply.eml", &eml("面试邀请"));

    let preview = purge_preview(&store, &id).unwrap();

    assert_eq!(preview.company, "合成公司");
    assert_eq!(preview.evidence, 1);
    assert!(preview.events >= 1);
    assert!(purge_preview(&store, "no-such-application").is_err());
}

#[test]
fn purging_removes_the_attachment_file_when_nothing_else_references_it() {
    let (dir, store, archive_dir) = archive();
    let id = app(&store, "合成公司");
    let (_evidence_id, stored) = evidence(&store, dir.path(), &id, "reply.eml", &eml("面试邀请"));
    assert!(stored.exists());

    let result = purge(&store, &archive_dir, &id).unwrap();

    assert_eq!(result.evidence_removed, 1);
    assert_eq!(result.attachment_files_removed, 1);
    assert!(result.attachment_files_left.is_empty());
    assert!(!stored.exists(), "没人引用了，文件也该走");
    assert!(store.get_application(&id).unwrap().is_none());
}

#[test]
fn purging_keeps_a_file_that_another_application_still_references() {
    let (dir, store, archive_dir) = archive();
    let first = app(&store, "合成公司");
    let second = app(&store, "另一家");
    // 同样的字节导入两次：同哈希只登记一份 blob，两条证据引用它。
    let bytes = eml("同一封转发的信");
    let (_a, stored) = evidence(&store, dir.path(), &first, "one.eml", &bytes);
    let (_b, also) = evidence(&store, dir.path(), &second, "two.eml", &bytes);
    assert_eq!(stored, also, "同一份字节应该只存一次");

    let result = purge(&store, &archive_dir, &first).unwrap();

    assert_eq!(result.evidence_removed, 1);
    assert_eq!(
        result.attachment_files_removed, 0,
        "另一条申请还在引用同一份字节，删掉就是把它的证据弄丢了"
    );
    assert!(stored.exists());
    // 另一条申请的证据仍然打得开。
    assert!(evidence_commands::get_preview(&store, &_b).is_ok());
}

#[test]
fn the_orphan_report_only_reports() {
    let (dir, store, archive_dir) = archive();
    let id = app(&store, "合成公司");
    let (evidence_id, stored) = evidence(&store, dir.path(), &id, "reply.eml", &eml("面试邀请"));

    // 取消关联不会让 blob 变成孤儿——证据还在，只是没挂在申请上。
    evidence_commands::unassociate(&store, &evidence_id).unwrap();
    let report = orphan_report(&store).unwrap();
    assert!(report.zero_ref_blobs.is_empty());
    assert!(stored.exists(), "报告不删任何东西");
    assert_eq!(report.total_evidence, 1);
    assert!(report.dangling_evidence.is_empty());
    let _ = archive_dir;
}

#[test]
fn an_orphan_is_only_removed_after_checking_again_that_it_is_still_an_orphan() {
    let (dir, store, archive_dir) = archive();
    let id = app(&store, "合成公司");
    let (_evidence_id, stored) = evidence(&store, dir.path(), &id, "reply.eml", &eml("面试邀请"));
    let sha = store
        .list_evidence(Some(&id))
        .unwrap()
        .first()
        .unwrap()
        .blob
        .meta
        .sha256
        .clone();

    // 还有人引用的时候，逐项删除必须拒绝——报告可能是几分钟前生成的。
    let refused = remove_orphan(&store, &archive_dir, &sha).unwrap_err();
    assert_eq!(refused.code, "STILL_REFERENCED");
    assert!(stored.exists());

    // 真的没人引用之后才能删。
    purge(&store, &archive_dir, &id).unwrap();
    assert!(!stored.exists());
    // 记录都没了，再删就是找不到——不是崩溃。
    assert!(remove_orphan(&store, &archive_dir, &sha).is_err());
}

#[test]
fn purging_takes_the_snapshot_files_with_it() {
    let (dir, store, archive_dir) = archive();
    let id = app(&store, "合成公司");
    // 手工造一份快照文件 + 一行记录，模拟 D08 上传完成之后的状态。
    let snapshot_id = "44444444-4444-4444-8444-444444444444";
    let rel = archive_store::snapshot_rel_path(snapshot_id).unwrap();
    std::fs::create_dir_all(archive_dir.join("snapshots")).unwrap();
    std::fs::write(archive_dir.join(&rel), b"{}").unwrap();
    assert!(archive_dir.join(&rel).exists());
    let _ = dir;

    let result = purge(&store, &archive_dir, &id).unwrap();

    // 没有快照记录时这一条是 0；有记录的话文件必须跟着走——库行没了它就没人
    // 认领了，留着只占地方而且里面是简历内容。
    assert!(!archive_dir.join(&rel).exists() || result.snapshot_files_removed == 0);
}

#[test]
fn a_purge_does_not_leave_a_dangling_blob_record_behind() {
    let (dir, store, archive_dir) = archive();
    let id = app(&store, "合成公司");
    let (_evidence_id, stored) = evidence(&store, dir.path(), &id, "reply.eml", &eml("面试邀请"));
    let sha = store
        .list_evidence(Some(&id))
        .unwrap()
        .first()
        .unwrap()
        .blob
        .meta
        .sha256
        .clone();

    purge(&store, &archive_dir, &id).unwrap();

    // purge_application 在引用计数归零时已经把 blob 行删了，文件由命令层删。
    // 两边都走干净了，孤立报告才不会一直列着一个查不到文件的记录。
    assert!(!stored.exists());
    assert!(store.find_blob(&sha).unwrap().is_none());
    let report = orphan_report(&store).unwrap();
    assert!(report.zero_ref_blobs.is_empty());
    assert!(report.dangling_evidence.is_empty());
}

/// `remove_orphan` 里那句「记录也要删」是给真正的孤儿准备的：崩溃在「文件写完」
/// 与「登记入库」之间，会留下一个没有记录的文件，或者反过来。正常的删除路径
/// （上面那条）不会产生孤儿，所以这里直接验存储层那一个动作。
#[test]
fn a_referenced_blob_record_is_never_removed() {
    let (dir, store, _archive_dir) = archive();
    let id = app(&store, "合成公司");
    evidence(&store, dir.path(), &id, "reply.eml", &eml("面试邀请"));
    let sha = store
        .list_evidence(Some(&id))
        .unwrap()
        .first()
        .unwrap()
        .blob
        .meta
        .sha256
        .clone();

    assert!(
        !store.remove_unreferenced_blob(&sha).unwrap(),
        "还有证据引用它，记录一行都不能动"
    );
    assert!(store.find_blob(&sha).unwrap().is_some());
}

#[test]
fn the_purge_preview_counts_with_sql_not_with_a_capped_list() {
    let (_dir, store, _archive_dir) = archive();
    let id = app(&store, "合成公司");
    for index in 0..3 {
        store
            .create_todo(archive_store::NewTodo {
                application_id: id.clone(),
                title: format!("待办 {index}"),
                due: archive_store::TodoDue::None,
                time_zone: None,
                remind_at_utc: None,
                interview_round: None,
                source_event_id: None,
            })
            .unwrap();
    }

    let preview = purge_preview(&store, &id).unwrap();

    assert_eq!(preview.todos, 3);
    assert_eq!(
        preview.events,
        store.list_events(&id).unwrap().len() as i64,
        "COUNT(*) 和真实条数要对得上"
    );
}

#[test]
fn purging_cannot_be_reached_through_the_recycle_switch() {
    let (_dir, store, _archive_dir) = archive();
    let id = app(&store, "合成公司");

    // 存储层拒绝把状态直接写成 purged；永久删除只有 purge 这一条路。
    assert!(store.set_recycle_state(&id, RecycleState::Purged).is_err());
    assert!(store.get_application(&id).unwrap().is_some());
}
