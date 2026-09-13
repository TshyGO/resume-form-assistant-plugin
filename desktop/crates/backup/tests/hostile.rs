//! 拿不该收的包会怎样。
//!
//! 每一条的断言都有两半：**拒绝**，以及**没在盘上留下任何东西**。只做到前半句
//! 没有意义——半解压的 staging 留着，下一步就会有人拿它去切换档案。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use backup::manifest::{Manifest, ManifestEntry, MANIFEST_PATH};
use backup::{extract_to_staging, read_manifest, safe_relative_path, BackupError};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 手搓一个包：`files` 是真正写进 zip 的东西，`manifest_entries` 是清单声称的。
/// 两者可以故意不一致——那正是要测的。
fn package(
    dir: &Path,
    name: &str,
    files: &[(&str, &[u8])],
    manifest_entries: Option<Vec<ManifestEntry>>,
    format_version: u32,
    format: &str,
) -> PathBuf {
    let path = dir.join(name);
    let file = fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();

    for (entry_name, bytes) in files {
        zip.start_file(*entry_name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }

    let entries = manifest_entries.unwrap_or_else(|| {
        files
            .iter()
            .map(|(entry_name, bytes)| ManifestEntry {
                path: (*entry_name).to_string(),
                size_bytes: bytes.len() as u64,
                sha256: hex(Sha256::digest(bytes).as_slice()),
            })
            .collect()
    });

    let manifest = Manifest {
        format: format.into(),
        format_version,
        created_at: "2026-09-13T02:00:00.000Z".into(),
        archive_id: "a-1".into(),
        schema_version: 3,
        counts: Default::default(),
        entries,
    };
    zip.start_file(MANIFEST_PATH, options).unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
    zip.finish().unwrap();
    path
}

fn good(dir: &Path, name: &str) -> PathBuf {
    package(
        dir,
        name,
        &[("archive/archive.db", b"db"), ("archive/meta.json", b"{}")],
        None,
        1,
        "resume-pro.archive",
    )
}

/// 解一次，断言失败并且 staging 没留下来。
fn must_reject(package_path: &Path, staging: &Path) -> BackupError {
    let error = extract_to_staging(package_path, staging).unwrap_err();
    assert!(
        !staging.exists(),
        "拒绝了却把半解压的目录留在盘上：{}",
        staging.display()
    );
    error
}

#[test]
fn a_good_package_extracts_and_verifies() {
    let dir = tempfile::tempdir().unwrap();
    let path = good(dir.path(), "ok.zip");
    let staging = dir.path().join("staging");

    let report = extract_to_staging(&path, &staging).unwrap();

    assert_eq!(report.total_bytes, 4);
    assert_eq!(fs::read(staging.join("archive/archive.db")).unwrap(), b"db");
    assert_eq!(report.manifest.archive_id, "a-1");
}

#[test]
fn a_package_that_is_not_ours_is_told_apart_from_one_that_is_too_new() {
    let dir = tempfile::tempdir().unwrap();

    let foreign = package(dir.path(), "foreign.zip", &[("x", b"y")], None, 1, "someone-else");
    let error = must_reject(&foreign, &dir.path().join("s1"));
    assert!(error.to_string().contains("不是 Resume Pro"), "{error}");

    let future = package(dir.path(), "future.zip", &[("x", b"y")], None, 99, "resume-pro.archive");
    let error = must_reject(&future, &dir.path().join("s2"));
    assert!(error.to_string().contains("更新版本"), "{error}");
    assert!(error.to_string().contains("升级"), "要告诉用户怎么办：{error}");
}

#[test]
fn a_zip_without_a_manifest_is_not_our_package() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bare.zip");
    let file = fs::File::create(&path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("readme.txt", SimpleFileOptions::default()).unwrap();
    zip.write_all(b"hello").unwrap();
    zip.finish().unwrap();

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("不是 Resume Pro"), "{error}");
}

#[test]
fn a_truncated_package_does_not_panic() {
    let dir = tempfile::tempdir().unwrap();
    let path = good(dir.path(), "whole.zip");
    let bytes = fs::read(&path).unwrap();
    let cut = dir.path().join("cut.zip");
    fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();

    let error = must_reject(&cut, &dir.path().join("s"));
    assert!(matches!(error, BackupError::Zip(_)), "{error}");
}

#[test]
fn a_single_flipped_byte_is_caught_by_the_hash() {
    let dir = tempfile::tempdir().unwrap();
    // 清单声称的哈希对应 "db"，包里实际写的是 "DB"。
    let entries = vec![ManifestEntry {
        path: "archive/archive.db".into(),
        size_bytes: 2,
        sha256: hex(Sha256::digest(b"db").as_slice()),
    }];
    let path = package(
        dir.path(),
        "tampered.zip",
        &[("archive/archive.db", b"DB")],
        Some(entries),
        1,
        "resume-pro.archive",
    );

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("被改过"), "{error}");
}

#[test]
fn a_file_that_is_shorter_than_the_manifest_says_is_caught() {
    let dir = tempfile::tempdir().unwrap();
    let entries = vec![ManifestEntry {
        path: "archive/archive.db".into(),
        size_bytes: 1000,
        sha256: hex(Sha256::digest(b"db").as_slice()),
    }];
    let path = package(
        dir.path(),
        "short.zip",
        &[("archive/archive.db", b"db")],
        Some(entries),
        1,
        "resume-pro.archive",
    );

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("少了"), "{error}");
}

#[test]
fn a_file_that_is_longer_than_the_manifest_says_is_stopped_while_writing() {
    let dir = tempfile::tempdir().unwrap();
    let entries = vec![ManifestEntry {
        path: "archive/archive.db".into(),
        size_bytes: 2,
        sha256: hex(Sha256::digest(b"db").as_slice()),
    }];
    let big = vec![b'x'; 512 * 1024];
    let path = package(
        dir.path(),
        "long.zip",
        &[("archive/archive.db", &big)],
        Some(entries),
        1,
        "resume-pro.archive",
    );

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(
        error.to_string().contains("比清单说的多"),
        "声明 2 字节实际吐半兆的包不该把盘写满才被发现：{error}"
    );
}

#[test]
fn an_entry_the_manifest_does_not_list_makes_the_whole_package_suspect() {
    let dir = tempfile::tempdir().unwrap();
    let entries = vec![ManifestEntry {
        path: "archive/meta.json".into(),
        size_bytes: 2,
        sha256: hex(Sha256::digest(b"{}").as_slice()),
    }];
    let path = package(
        dir.path(),
        "extra.zip",
        &[("archive/meta.json", b"{}"), ("archive/surprise.exe", b"MZ")],
        Some(entries),
        1,
        "resume-pro.archive",
    );

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("不在清单里"), "{error}");
}

#[test]
fn a_manifest_entry_with_no_file_behind_it_is_caught() {
    let dir = tempfile::tempdir().unwrap();
    let entries = vec![
        ManifestEntry {
            path: "archive/meta.json".into(),
            size_bytes: 2,
            sha256: hex(Sha256::digest(b"{}").as_slice()),
        },
        ManifestEntry {
            path: "archive/ghost.json".into(),
            size_bytes: 2,
            sha256: hex(Sha256::digest(b"{}").as_slice()),
        },
    ];
    let path = package(
        dir.path(),
        "ghost.zip",
        &[("archive/meta.json", b"{}")],
        Some(entries),
        1,
        "resume-pro.archive",
    );

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("不在备份里"), "{error}");
}

#[test]
fn nothing_a_manifest_can_say_puts_a_file_outside_the_staging_directory() {
    for evil in [
        "../evil",
        "../../evil",
        "archive/../../evil",
        "/etc/passwd",
        // 这两类在 Windows 上是 Prefix 组件，在 Unix 上只是普通目录名——
        // 同一个包必须在两个系统上得到同一个判断。
        "C:/Windows/System32/evil.dll",
        "c:/lower/case",
        "archive/D:/nested",
        "C:\\Windows\\evil.dll",
        "\\\\server\\share\\evil",
        "archive\\..\\..\\evil",
        "./evil",
        "",
    ] {
        assert!(
            safe_relative_path(evil).is_err(),
            "`{evil}` 必须被拒绝，否则恢复会往档案目录外面写"
        );
    }
    // 正常的相对路径要放行。
    assert!(safe_relative_path("archive/attachments/2026/09/x-回复.eml").is_ok());
}

#[test]
fn a_traversing_entry_name_is_rejected_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let evil = "../escaped.txt";
    let entries = vec![ManifestEntry {
        path: evil.into(),
        size_bytes: 3,
        sha256: hex(Sha256::digest(b"pwn").as_slice()),
    }];
    let path = package(dir.path(), "evil.zip", &[(evil, b"pwn")], Some(entries), 1, "resume-pro.archive");
    let staging = dir.path().join("staging");

    let error = must_reject(&path, &staging);

    assert!(error.to_string().contains("跳出"), "{error}");
    assert!(
        !dir.path().join("escaped.txt").exists(),
        "文件被写到了 staging 外面"
    );
}

#[test]
fn an_empty_manifest_is_not_a_usable_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = package(dir.path(), "empty.zip", &[], Some(vec![]), 1, "resume-pro.archive");

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("空的"), "{error}");
}

#[test]
fn a_manifest_that_claims_an_impossible_size_is_refused_before_extracting() {
    let dir = tempfile::tempdir().unwrap();
    let entries = vec![ManifestEntry {
        path: "archive/archive.db".into(),
        size_bytes: u64::MAX,
        sha256: hex(Sha256::digest(b"db").as_slice()),
    }];
    let path = package(
        dir.path(),
        "huge.zip",
        &[("archive/archive.db", b"db")],
        Some(entries),
        1,
        "resume-pro.archive",
    );

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("超出上限"), "{error}");
}

#[test]
fn a_bad_hash_string_in_the_manifest_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let entries = vec![ManifestEntry {
        path: "archive/archive.db".into(),
        size_bytes: 2,
        sha256: "not-a-hash".into(),
    }];
    let path = package(
        dir.path(),
        "badhash.zip",
        &[("archive/archive.db", b"db")],
        Some(entries),
        1,
        "resume-pro.archive",
    );

    let error = must_reject(&path, &dir.path().join("s"));
    assert!(error.to_string().contains("十六进制"), "{error}");
}

#[test]
fn reading_a_manifest_never_writes_anything() {
    let dir = tempfile::tempdir().unwrap();
    let path = good(dir.path(), "ok.zip");
    let before = fs::read_dir(dir.path()).unwrap().count();

    read_manifest(&path).unwrap();

    // 预览阶段用户还没确认，盘上不该多出任何东西。
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), before);
}

#[test]
fn extracting_into_an_existing_directory_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = good(dir.path(), "ok.zip");
    let staging = dir.path().join("already-there");
    fs::create_dir_all(staging.join("someone-elses-data")).unwrap();

    let error = extract_to_staging(&path, &staging).unwrap_err();

    assert!(error.to_string().contains("已经存在"), "{error}");
    assert!(
        staging.join("someone-elses-data").exists(),
        "拒绝的时候不能把别人的目录删了"
    );
}
