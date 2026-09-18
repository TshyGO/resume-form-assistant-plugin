//! 打包。重点不在「能打出来」，在**打不出来的时候有没有把上一份好的备份弄坏**。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use backup::exclude::{classify, portable_settings, Disposition};
use backup::manifest::{Manifest, DATABASE_PATH, MANIFEST_PATH, SETTINGS_PATH};
use backup::{write_archive, ArchiveCounts, ArchiveSource};

fn write(path: &Path, bytes: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

/// 一个长得像真档案目录的目录，外加一份「数据库快照」。
fn archive(root: &Path) -> PathBuf {
    let dir = root.join("archive");
    write(&dir.join("meta.json"), br#"{"archiveId":"a-1"}"#);
    write(&dir.join("attachments/2026/09/abc-回复.eml"), b"eml bytes");
    write(&dir.join("attachments/2026/09/def-截图.png"), b"png bytes");
    write(&dir.join("snapshots/snap-1.json"), b"{}");
    // 不该进包的：正在被写的库、临时文件、迁移前备份。
    write(&dir.join("archive.db"), b"live database");
    write(&dir.join("archive.db-wal"), b"wal");
    write(&dir.join("tmp/half-written"), b"junk");
    write(&dir.join("backups/archive.pre-migration-v1.db"), b"old");

    let snapshot = root.join("snapshot.db");
    write(&snapshot, b"consistent database snapshot");
    snapshot
}

fn source<'a>(dir: &'a Path, snapshot: &'a Path) -> ArchiveSource<'a> {
    ArchiveSource {
        archive_dir: dir,
        database_snapshot: snapshot,
        archive_id: "a-1".into(),
        schema_version: 3,
        counts: ArchiveCounts {
            applications: 2,
            events: 9,
            snapshots: 1,
            todos: 3,
            evidence: 2,
            attachments: 2,
        },
        settings_json: None,
        created_at: "2026-09-13T02:00:00.000Z".into(),
    }
}

fn read_manifest(zip_path: &Path) -> Manifest {
    let file = fs::File::open(zip_path).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let mut raw = String::new();
    zip.by_name(MANIFEST_PATH)
        .unwrap()
        .read_to_string(&mut raw)
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn names(zip_path: &Path) -> Vec<String> {
    let file = fs::File::open(zip_path).unwrap();
    let zip = zip::ZipArchive::new(file).unwrap();
    let mut out: Vec<String> = zip.file_names().map(str::to_string).collect();
    out.sort();
    out
}

#[test]
fn a_backup_carries_the_archive_and_a_manifest_that_describes_it() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("out/resume-pro-archive.zip");

    let report = write_archive(&source(&archive_dir, &snapshot), &out).unwrap();

    assert!(out.exists());
    assert!(report.size_bytes > 0);
    let manifest = read_manifest(&out);
    assert_eq!(manifest.format, "resume-pro.archive");
    assert_eq!(manifest.format_version, 1);
    assert_eq!(manifest.archive_id, "a-1");
    assert_eq!(manifest.schema_version, 3);
    assert_eq!(manifest.counts.applications, 2);
    assert_eq!(manifest.counts.attachments, 2);

    // 清单覆盖包里除自己之外的每一项。
    let mut described: Vec<&str> = manifest.entries.iter().map(|e| e.path.as_str()).collect();
    described.sort();
    let mut inside: Vec<String> = names(&out)
        .into_iter()
        .filter(|n| n != MANIFEST_PATH)
        .collect();
    inside.sort();
    assert_eq!(
        described,
        inside.iter().map(String::as_str).collect::<Vec<_>>()
    );
}

#[test]
fn the_database_in_the_package_is_the_snapshot_not_the_live_file() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("archive.zip");

    write_archive(&source(&archive_dir, &snapshot), &out).unwrap();

    let file = fs::File::open(&out).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let mut bytes = String::new();
    zip.by_name(DATABASE_PATH)
        .unwrap()
        .read_to_string(&mut bytes)
        .unwrap();
    assert_eq!(
        bytes, "consistent database snapshot",
        "拷正在被写的 archive.db 拿到的可能是半个事务"
    );
}

#[test]
fn the_things_that_must_not_travel_are_not_in_the_package() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("archive.zip");

    let report = write_archive(&source(&archive_dir, &snapshot), &out).unwrap();
    let inside = names(&out).join("\n");

    for forbidden in ["archive/archive.db-wal", "archive/tmp/", "archive/backups/"] {
        assert!(
            !inside.contains(forbidden),
            "{forbidden} 不该进包：\n{inside}"
        );
    }
    // 而且它们是被**明确**排除的，不是碰巧没走到。
    let skipped: Vec<&str> = report
        .skipped
        .iter()
        .map(|(path, _)| path.as_str())
        .collect();
    for expected in ["archive.db", "archive.db-wal", "tmp", "backups"] {
        assert!(
            skipped.contains(&expected),
            "{expected} 应该出现在 skipped 里：{skipped:?}"
        );
    }
}

#[test]
fn a_file_the_list_does_not_cover_is_reported_rather_than_silently_swept_in_or_out() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    // 将来某个功能往档案目录里放了个新东西，而没人记得改清单。
    write(&archive_dir.join("brand-new-thing.json"), b"{}");
    let out = dir.path().join("archive.zip");

    let report = write_archive(&source(&archive_dir, &snapshot), &out).unwrap();

    assert!(
        !names(&out).iter().any(|n| n.contains("brand-new-thing")),
        "清单没覆盖的东西不能默默进包——它可能是日志或者机器专属路径"
    );
    let noted = report
        .skipped
        .iter()
        .find(|(path, _)| path == "brand-new-thing.json")
        .expect("也不能默默不进包，否则清单永远不会被补上");
    assert!(noted.1.contains("清单"));
}

#[test]
fn a_failed_backup_does_not_touch_the_previous_good_one() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("archive.zip");

    // 先成功一次。
    write_archive(&source(&archive_dir, &snapshot), &out).unwrap();
    let good = fs::read(&out).unwrap();
    assert!(!good.is_empty());

    // 再让它失败：快照文件不在了。
    fs::remove_file(&snapshot).unwrap();
    let error = write_archive(&source(&archive_dir, &snapshot), &out).unwrap_err();
    assert!(matches!(error, backup::BackupError::Io(_)), "{error}");

    assert_eq!(fs::read(&out).unwrap(), good, "上一份好的备份必须原封不动");
    // 也不能留下临时文件。
    let leftovers: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn deleting_a_referenced_file_after_the_database_snapshot_cannot_publish_a_partial_backup() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("archive.zip");

    write_archive(&source(&archive_dir, &snapshot), &out).unwrap();
    let previous = fs::read(&out).unwrap();

    // `source.counts` and snapshot.db have already captured two attachment references. This
    // deletion models another actor removing one byte file after that barrier but before the
    // directory walker reaches it.
    fs::remove_file(archive_dir.join("attachments/2026/09/def-截图.png")).unwrap();
    let error = write_archive(&source(&archive_dir, &snapshot), &out).unwrap_err();
    assert!(matches!(error, backup::BackupError::Mismatch(_)), "{error}");
    assert!(error.to_string().contains("2 个附件文件"), "{error}");
    assert!(error.to_string().contains("档案完整性检查"), "{error}");
    assert_eq!(
        fs::read(&out).unwrap(),
        previous,
        "上一份完整备份不能被残包覆盖"
    );
}

#[test]
fn a_missing_snapshot_file_is_rejected_without_replacing_the_previous_backup() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("archive.zip");

    write_archive(&source(&archive_dir, &snapshot), &out).unwrap();
    let previous = fs::read(&out).unwrap();
    fs::remove_file(archive_dir.join("snapshots/snap-1.json")).unwrap();

    let error = write_archive(&source(&archive_dir, &snapshot), &out).unwrap_err();
    assert!(matches!(error, backup::BackupError::Mismatch(_)), "{error}");
    assert!(error.to_string().contains("1 个简历快照文件"), "{error}");
    assert_eq!(fs::read(&out).unwrap(), previous);
}

#[test]
fn an_orphan_attachment_fails_closed_with_a_repair_hint() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("archive.zip");
    write(
        &archive_dir.join("attachments/2026/09/orphan.bin"),
        b"orphaned after a rolled-back import",
    );

    let error = write_archive(&source(&archive_dir, &snapshot), &out).unwrap_err();
    assert!(matches!(error, backup::BackupError::Mismatch(_)), "{error}");
    assert!(error.to_string().contains("档案完整性检查"), "{error}");
    assert!(!out.exists(), "不完整的首份备份也不能发布");
}

#[test]
fn the_same_archive_packed_twice_describes_itself_the_same_way() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());

    let first = dir.path().join("one.zip");
    let second = dir.path().join("two.zip");
    write_archive(&source(&archive_dir, &snapshot), &first).unwrap();
    write_archive(&source(&archive_dir, &snapshot), &second).unwrap();

    // 目录遍历顺序不能让清单每次都不一样，否则用户没法比对两次导出。
    assert_eq!(
        read_manifest(&first).entries,
        read_manifest(&second).entries
    );
}

#[test]
fn only_the_allowlisted_settings_travel() {
    let raw = r#"{
      "pairing": { "chrome": "diagjmploldedipjdenmecmjokckelkl", "edge": "" },
      "apiKey": "sk-must-not-travel",
      "nativeHostPath": "C:\\Users\\someone\\AppData\\Local\\ResumePro\\host.exe"
    }"#;

    let kept = portable_settings(raw).unwrap();

    assert!(
        kept.contains("diagjmpl"),
        "配对草稿要跟着走，否则换机要重配"
    );
    assert!(!kept.contains("sk-must-not-travel"), "API Key 一律不进备份");
    assert!(!kept.contains("nativeHostPath"), "机器专属路径不进备份");
    assert!(!kept.contains("someone"), "更不能带上用户名");
}

#[test]
fn settings_that_have_nothing_portable_produce_no_entry() {
    let dir = tempfile::tempdir().unwrap();
    let archive_dir = dir.path().join("archive");
    let snapshot = archive(dir.path());
    let out = dir.path().join("archive.zip");

    assert_eq!(portable_settings(r#"{"apiKey":"sk-x"}"#), None);
    assert_eq!(portable_settings("这不是 JSON"), None);

    write_archive(&source(&archive_dir, &snapshot), &out).unwrap();
    assert!(!names(&out).contains(&SETTINGS_PATH.to_string()));
}

#[test]
fn the_disposition_of_every_top_level_name_is_a_deliberate_decision() {
    assert_eq!(classify("meta.json"), Disposition::Include);
    assert_eq!(classify("attachments/2026/09/x.eml"), Disposition::Include);
    assert_eq!(classify("snapshots/s.json"), Disposition::Include);
    assert!(matches!(classify("archive.db"), Disposition::Exclude(_)));
    assert!(matches!(classify("tmp/x"), Disposition::Exclude(_)));
    assert!(matches!(classify("backups/x.db"), Disposition::Exclude(_)));
    assert_eq!(classify("something-new"), Disposition::Unknown);
    // 前缀匹配必须按路径段来：`attachments-old/` 不是 `attachments/`。
    assert_eq!(classify("attachments-old/x"), Disposition::Unknown);
    assert_eq!(classify("tmpfile"), Disposition::Unknown);
}
