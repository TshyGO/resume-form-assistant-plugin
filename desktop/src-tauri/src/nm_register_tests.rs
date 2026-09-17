//! Native Messaging 注册的回归。
//!
//! 每一条都在问同一个问题：**浏览器能不能找到 host，以及我们有没有动不该动的东西。**
//! 真注册表和真目录只在人工走查里验；这里验的是规则。

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::nm_register::*;

/// 内存里的假盘。真往 HKCU 和用户目录里写的测试会污染开发机。
#[derive(Default)]
struct FakeFiles {
    files: RefCell<HashMap<String, String>>,
    fail_on: Option<String>,
}

impl FakeFiles {
    fn with(entries: &[(&str, &str)]) -> FakeFiles {
        let files = FakeFiles::default();
        for (path, contents) in entries {
            files
                .files
                .borrow_mut()
                .insert((*path).to_string(), (*contents).to_string());
        }
        files
    }

    fn get(&self, path: &str) -> Option<String> {
        self.files.borrow().get(path).cloned()
    }

    fn count(&self) -> usize {
        self.files.borrow().len()
    }
}

impl Files for FakeFiles {
    fn read(&self, path: &Path) -> Option<String> {
        self.get(&path.to_string_lossy())
    }

    fn write(&self, path: &Path, contents: &str) -> Result<(), String> {
        let key = path.to_string_lossy().to_string();
        if self.fail_on.as_deref() == Some(key.as_str()) {
            return Err(format!("写不了 {key}：假装没权限"));
        }
        self.files.borrow_mut().insert(key, contents.to_string());
        Ok(())
    }

    fn remove(&self, path: &Path) -> Result<(), String> {
        self.files.borrow_mut().remove(&path.to_string_lossy().to_string());
        Ok(())
    }
}

#[derive(Default)]
struct FakeRegistry {
    values: RefCell<HashMap<String, String>>,
    fail: bool,
}

impl FakeRegistry {
    fn with(entries: &[(&str, &str)]) -> FakeRegistry {
        let registry = FakeRegistry::default();
        for (key, value) in entries {
            registry
                .values
                .borrow_mut()
                .insert((*key).to_string(), (*value).to_string());
        }
        registry
    }
}

impl Registry for FakeRegistry {
    fn read(&self, key: &str) -> Option<String> {
        self.values.borrow().get(key).cloned()
    }

    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        if self.fail {
            return Err("写不了注册表：假装被策略挡住了".into());
        }
        self.values.borrow_mut().insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        self.values.borrow_mut().remove(key);
        Ok(())
    }
}

/// 安装目录带空格是常态：Windows 的 per-user 装在 `%LOCALAPPDATA%\Resume Pro Desktop`，
/// macOS 是 `Resume Pro Desktop.app`。路径必须在**当前平台**上算绝对路径，
/// 否则 `manifest_json` 会先一步拒绝，测的就不是想测的那件事了。
fn exe() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Users\某人\AppData\Local\Resume Pro Desktop\resume-pro-desktop.exe")
    } else {
        PathBuf::from("/Users/某人/Applications/Resume Pro Desktop.app/Contents/MacOS/resume-pro-desktop")
    }
}

fn data_root() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Users\某人\AppData\Local\ResumePro")
    } else {
        PathBuf::from("/Users/某人/Library/Application Support/ResumePro")
    }
}

#[test]
fn the_manifest_names_the_extension_instead_of_trusting_everyone() {
    let text = manifest_json(&exe(), &extension_ids(&[])).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();

    assert_eq!(parsed["name"], HOST_NAME);
    assert_eq!(parsed["type"], "stdio");
    assert_eq!(
        parsed["allowed_origins"],
        serde_json::json!([format!("chrome-extension://{STORE_EXTENSION_ID}/")])
    );
    // 通配意味着机器上任何一个扩展都能启动 host，读到整本档案。
    assert!(!text.contains('*'));
}

#[test]
fn a_path_with_spaces_and_chinese_survives_the_round_trip() {
    let text = manifest_json(&exe(), &extension_ids(&[])).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();

    assert_eq!(parsed["path"], exe().to_string_lossy().to_string());
    assert!(parsed["path"].as_str().unwrap().contains("Resume Pro Desktop"));
}

#[test]
fn a_relative_path_or_a_bad_id_is_refused_before_anything_is_written() {
    assert!(manifest_json(Path::new("resume-pro-desktop.exe"), &extension_ids(&[])).is_err());
    assert!(manifest_json(Path::new("./relative/host"), &extension_ids(&[])).is_err());
    assert!(manifest_json(&exe(), &[]).is_err());
    assert!(manifest_json(&exe(), &["不是扩展 ID".to_string()]).is_err());
}

#[test]
fn a_development_id_is_added_but_never_replaces_the_store_one() {
    let dev = "abcdefghijklmnopabcdefghijklmnop".to_string();
    let ids = extension_ids(&[dev.clone()]);

    assert_eq!(ids, vec![STORE_EXTENSION_ID.to_string(), dev]);
    // 乱填的不进清单，否则清单直接写不出来。
    assert_eq!(extension_ids(&["zzz".to_string()]), vec![STORE_EXTENSION_ID.to_string()]);
}

#[test]
fn both_browsers_get_a_manifest_and_windows_also_gets_a_registry_key() {
    let files = FakeFiles::default();
    let registry = FakeRegistry::default();
    let targets = windows_targets(&data_root());

    let (outcomes, receipt) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        Receipt::default(),
    );

    assert_eq!(outcomes.len(), 2);
    assert!(outcomes.iter().all(|o| o.registered), "{outcomes:?}");
    assert_eq!(files.count(), 2);
    assert_eq!(receipt.written.len(), 2);
    // Edge 也要写：从 Chrome 商店装的扩展可以跑在 Edge 里。
    let edge = &targets[1];
    assert_eq!(edge.browser, Browser::Edge);
    assert_eq!(
        registry.read(edge.registry_key.as_ref().unwrap()).as_deref(),
        Some(edge.manifest_path.to_string_lossy().as_ref())
    );
}

#[test]
fn a_manifest_written_by_someone_else_is_left_alone() {
    let targets = windows_targets(&data_root());
    let chrome = targets[0].manifest_path.to_string_lossy().to_string();
    let theirs = r#"{"name":"com.resumepro.desktop","path":"C:\\别人的\\host.exe"}"#;
    let files = FakeFiles::with(&[(chrome.as_str(), theirs)]);
    let registry = FakeRegistry::default();

    let (outcomes, receipt) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        Receipt::default(),
    );

    assert_eq!(files.get(&chrome).as_deref(), Some(theirs), "把别人的清单盖掉了");
    assert!(!outcomes[0].registered);
    assert!(outcomes[0].note.as_ref().unwrap().contains("没有动它"));
    assert!(receipt.skipped.contains(&chrome));
    // 另一个浏览器不受影响。
    assert!(outcomes[1].registered);
}

#[test]
fn a_stale_manifest_we_wrote_is_repaired() {
    let targets = windows_targets(&data_root());
    let chrome = targets[0].manifest_path.to_string_lossy().to_string();
    let old_exe = if cfg!(windows) {
        PathBuf::from(r"D:\旧位置\resume-pro-desktop.exe")
    } else {
        PathBuf::from("/Volumes/旧位置/resume-pro-desktop")
    };
    let stale = manifest_json(&old_exe, &extension_ids(&[])).unwrap();
    let files = FakeFiles::with(&[(chrome.as_str(), stale.as_str())]);
    let registry = FakeRegistry::default();
    let mut receipt = Receipt::default();
    receipt.written.insert(chrome.clone(), digest(&stale));

    let (outcomes, _) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        receipt,
    );

    assert!(outcomes[0].registered);
    let now = files.get(&chrome).unwrap();
    assert!(now.contains("Resume Pro Desktop"), "没有改成新位置：{now}");
    assert!(!now.contains("旧位置"));
}

#[test]
fn a_registry_key_pointing_at_nothing_is_rewritten() {
    let targets = windows_targets(&data_root());
    let key = targets[0].registry_key.clone().unwrap();
    let gone = if cfg!(windows) {
        r"D:\早就删了\chrome-host.json"
    } else {
        "/Volumes/早就删了/chrome-host.json"
    };
    let registry = FakeRegistry::with(&[(key.as_str(), gone)]);
    let files = FakeFiles::default();

    let (outcomes, _) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        Receipt::default(),
    );

    assert!(outcomes[0].registered);
    assert_eq!(
        registry.read(&key).as_deref(),
        Some(targets[0].manifest_path.to_string_lossy().as_ref()),
        "旧注册还指着不存在的文件"
    );
}

#[test]
fn the_second_run_changes_nothing() {
    let targets = windows_targets(&data_root());
    let files = FakeFiles::default();
    let registry = FakeRegistry::default();

    let (_, first) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        Receipt::default(),
    );
    let snapshot = files.files.borrow().clone();
    let (outcomes, second) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        first.clone(),
    );

    assert!(outcomes.iter().all(|o| o.registered));
    assert_eq!(*files.files.borrow(), snapshot);
    assert_eq!(first, second);
}

#[test]
fn a_registry_that_refuses_gives_a_reason_instead_of_panicking() {
    let targets = windows_targets(&data_root());
    let files = FakeFiles::default();
    let registry = FakeRegistry {
        fail: true,
        ..FakeRegistry::default()
    };

    let (outcomes, _) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        Receipt::default(),
    );

    assert!(outcomes.iter().all(|o| !o.registered));
    assert!(outcomes[0].note.as_ref().unwrap().contains("策略"));
}

#[test]
fn a_file_that_cannot_be_written_is_reported_per_browser() {
    let targets = windows_targets(&data_root());
    let chrome = targets[0].manifest_path.to_string_lossy().to_string();
    let files = FakeFiles {
        fail_on: Some(chrome),
        ..FakeFiles::default()
    };
    let registry = FakeRegistry::default();

    let (outcomes, receipt) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        Receipt::default(),
    );

    assert!(!outcomes[0].registered);
    assert!(outcomes[1].registered, "一个浏览器失败不该拖垮另一个");
    assert_eq!(receipt.written.len(), 1);
}

#[test]
fn undo_only_removes_what_we_wrote() {
    let targets = windows_targets(&data_root());
    let chrome = targets[0].manifest_path.to_string_lossy().to_string();
    let edge = targets[1].manifest_path.to_string_lossy().to_string();
    let theirs = r#"{"name":"com.resumepro.desktop","path":"C:\\别人的\\host.exe"}"#;
    let files = FakeFiles::with(&[(edge.as_str(), theirs)]);
    let registry = FakeRegistry::default();

    let (_, receipt) = ensure(
        &targets,
        &exe(),
        &extension_ids(&[]),
        &files,
        &registry,
        Receipt::default(),
    );
    let problems = undo(&targets, &files, &registry, &receipt);

    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(files.get(&chrome), None, "自己写的没删掉");
    assert_eq!(files.get(&edge).as_deref(), Some(theirs), "把别人的清单删了");
    assert_eq!(registry.read(targets[0].registry_key.as_ref().unwrap()), None);
}

#[test]
fn the_receipt_survives_a_round_trip_and_a_missing_file_is_not_fatal() {
    let files = FakeFiles::default();
    let path = receipt_path(&data_root());
    let mut receipt = Receipt::default();
    receipt.written.insert("a".into(), digest("x"));
    receipt.skipped.push("b".into());

    save_receipt(&files, &path, &receipt).unwrap();
    assert_eq!(load_receipt(&files, &path), receipt);
    // 回执丢了最坏也就是不敢重写别人的清单，不该炸。
    assert_eq!(load_receipt(&files, Path::new("没有这个文件")), Receipt::default());
}

#[test]
fn mac_manifests_go_where_the_browsers_look() {
    let targets = mac_targets(Path::new("/Users/某人"));
    let paths: Vec<String> = targets
        .iter()
        .map(|t| t.manifest_path.to_string_lossy().replace('\\', "/"))
        .collect();

    assert!(paths[0].ends_with(&format!(
        "Library/Application Support/Google/Chrome/NativeMessagingHosts/{HOST_NAME}.json"
    )));
    assert!(paths[1].ends_with(&format!(
        "Library/Application Support/Microsoft Edge/NativeMessagingHosts/{HOST_NAME}.json"
    )));
    assert!(targets.iter().all(|t| t.registry_key.is_none()));
}

#[test]
fn the_decision_table_is_explicit_about_what_it_will_overwrite() {
    let desired = "{\"a\":1}";
    let ours = "{\"a\":0}";
    assert_eq!(decide(None, desired, None), Decision::Write);
    assert_eq!(decide(Some(desired), desired, None), Decision::UpToDate);
    assert_eq!(decide(Some(ours), desired, Some(&digest(ours))), Decision::Write);
    assert_eq!(decide(Some("别人的"), desired, Some(&digest(ours))), Decision::NotOurs);
    assert_eq!(decide(Some("别人的"), desired, None), Decision::NotOurs);
}
