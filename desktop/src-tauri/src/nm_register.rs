//! 生产环境的 Native Messaging 注册：让浏览器找得到 host，并且只让我们那一个扩展启动它。
//!
//! 为什么由应用写、而不是安装器写：安装器只在安装那一刻跑一次。用户移动安装目录、
//! 从压缩包直接运行、换个通道重装，清单里的 `path` 就指向不存在的文件，而浏览器只会
//! 安静地连不上。应用每次启动核对一次，自己就能修好。安装器负责的是卸载时清理。
//!
//! 两条规矩和开发脚本（`scripts/nm-dev-register.mjs`）一致：
//!
//! 1. **不覆盖不是自己写的清单。** 开发机上可能已经有一份真的注册，盖掉了就还不回去。
//! 2. **写什么都先记回执**，卸载时按回执删，而不是按名字删。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

/// 清单里的 host 名字，也是注册表键名。插件那边 `connectNative` 用的就是它。
pub const HOST_NAME: &str = "com.resumepro.desktop";

/// 商店固定下来的扩展 ID。`manifest.json` 里有公钥，所以本地 unpacked 和商店版是同一个。
pub const STORE_EXTENSION_ID: &str = "diagjmploldedipjdenmecmjokckelkl";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Edge,
}

impl Browser {
    pub const ALL: [Browser; 2] = [Browser::Chrome, Browser::Edge];

    pub fn as_str(&self) -> &'static str {
        match self {
            Browser::Chrome => "chrome",
            Browser::Edge => "edge",
        }
    }

    /// 用户看的名字。
    pub fn label(&self) -> &'static str {
        match self {
            Browser::Chrome => "Chrome",
            Browser::Edge => "Edge",
        }
    }

    /// Windows 上清单放哪都行，位置记在这个 HKCU 键里。
    fn registry_key(&self) -> String {
        let vendor = match self {
            Browser::Chrome => r"Google\Chrome",
            Browser::Edge => r"Microsoft\Edge",
        };
        format!(r"Software\{vendor}\NativeMessagingHosts\{HOST_NAME}")
    }

    /// macOS 上清单必须躺在浏览器自己的目录里。
    #[cfg_attr(windows, allow(dead_code))]
    fn mac_dir(&self) -> PathBuf {
        match self {
            Browser::Chrome => PathBuf::from("Google").join("Chrome"),
            Browser::Edge => PathBuf::from("Microsoft Edge"),
        }
    }

    /// Linux 上的目录名和 macOS 完全不同，不能共用一套。
    #[cfg_attr(windows, allow(dead_code))]
    fn linux_dir(&self) -> &'static str {
        match self {
            Browser::Chrome => "google-chrome",
            Browser::Edge => "microsoft-edge",
        }
    }
}

/// 一个浏览器要写的东西：清单路径，以及（Windows 才有的）注册表键。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub browser: Browser,
    pub manifest_path: PathBuf,
    pub registry_key: Option<String>,
}

/// Windows：清单写在我们自己的数据目录下，注册表指过去。
pub fn windows_targets(data_root: &Path) -> Vec<Target> {
    Browser::ALL
        .iter()
        .map(|browser| Target {
            browser: *browser,
            manifest_path: data_root
                .join("nm")
                .join(format!("{}-{HOST_NAME}.json", browser.as_str())),
            registry_key: Some(browser.registry_key()),
        })
        .collect()
}

/// macOS：写进浏览器的用户级目录，没有注册表这一说。
#[cfg_attr(windows, allow(dead_code))]
pub fn mac_targets(home: &Path) -> Vec<Target> {
    let support = home.join("Library").join("Application Support");
    Browser::ALL
        .iter()
        .map(|browser| Target {
            browser: *browser,
            manifest_path: support
                .join(browser.mac_dir())
                .join("NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json")),
            registry_key: None,
        })
        .collect()
}

/// Linux：`~/.config/<browser>/NativeMessagingHosts/`。我们不发 Linux 包，但
/// 开发机可能是 Linux，写到 macOS 的路径上只会得到一个谁也不读的文件。
#[cfg_attr(windows, allow(dead_code))]
pub fn linux_targets(home: &Path) -> Vec<Target> {
    Browser::ALL
        .iter()
        .map(|browser| Target {
            browser: *browser,
            manifest_path: home
                .join(".config")
                .join(browser.linux_dir())
                .join("NativeMessagingHosts")
                .join(format!("{HOST_NAME}.json")),
            registry_key: None,
        })
        .collect()
}

fn valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| ('a'..='p').contains(&c))
}

/// 浏览器要读的那份清单。
///
/// `allowed_origins` 逐个写明扩展 ID：通配意味着机器上任何一个扩展都能启动 host、
/// 进而读到整本求职档案。
pub fn manifest_json(exe: &Path, extension_ids: &[String]) -> Result<String, String> {
    if !exe.is_absolute() {
        return Err(format!("host 路径必须是绝对路径，拿到的是 {}", exe.display()));
    }
    if extension_ids.is_empty() {
        return Err("至少要有一个扩展 ID".into());
    }
    let mut origins = Vec::new();
    for id in extension_ids {
        if !valid_extension_id(id) {
            return Err(format!("不是扩展 ID：{id}"));
        }
        let origin = format!("chrome-extension://{id}/");
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    let value = json!({
        "name": HOST_NAME,
        "description": "Resume Pro 桌面档案",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins,
    });
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

/// 正式清单里默认只有商店那一条 ID；开发模式加的 ID 单独传进来，不写进默认值。
pub fn extension_ids(extra: &[String]) -> Vec<String> {
    let mut ids = vec![STORE_EXTENSION_ID.to_string()];
    for id in extra {
        if valid_extension_id(id) && !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    ids
}

/// 回执：我们写过哪些文件、写的是什么、哪些是别人的不许动。
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Receipt {
    /// 清单路径 → 我们写进去那份内容的 SHA-256。
    #[serde(default)]
    pub written: BTreeMap<String, String>,
    /// 因为是别人的清单而没有动的路径。
    #[serde(default)]
    pub skipped: Vec<String>,
}

pub fn receipt_path(data_root: &Path) -> PathBuf {
    data_root.join("nm").join("receipt.json")
}

pub fn digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// 一个浏览器这一次的结果。界面照这个说话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub browser: Browser,
    pub label: String,
    pub registered: bool,
    /// 没注册成时说清楚为什么；注册成了就是 `None`。
    pub note: Option<String>,
}

/// 决定这一次要不要写、以及为什么。把「判断」和「动手」分开，是为了这一段能测。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 盘上已经是我们要写的内容。
    UpToDate,
    /// 该写：没有文件、内容过时（多半是 exe 换了位置）、或者上一版是我们写的。
    Write,
    /// 别人的清单，不许动。
    NotOurs,
}

/// `existing` 是盘上现在的内容，`receipt_digest` 是回执里记的「我们上次写的内容」。
pub fn decide(existing: Option<&str>, desired: &str, receipt_digest: Option<&str>) -> Decision {
    match existing {
        None => Decision::Write,
        Some(current) if current == desired => Decision::UpToDate,
        Some(current) => {
            // 内容变了：只有当它确实是我们上次写的那份时才敢重写。
            match receipt_digest {
                Some(recorded) if recorded == digest(current) => Decision::Write,
                _ => Decision::NotOurs,
            }
        }
    }
}

/// 注册表里那条值该不该改。
///
/// 指向别的路径要改；指向一个**已经不在了**的文件同样要改——那正是「旧注册残留」
/// 的样子：键还在，文件早没了，浏览器只会安静地连不上。
pub fn registry_needs_update(
    current: Option<&str>,
    manifest_path: &Path,
    target_exists: bool,
) -> bool {
    match current {
        None => true,
        Some(value) => Path::new(value) != manifest_path || !target_exists,
    }
}

// --- 动手的那一半 -------------------------------------------------------------------------

/// 文件系统。抽出来是为了让 [`ensure`] 能在测试里跑，不真往盘上写。
pub trait Files {
    fn read(&self, path: &Path) -> Option<String>;
    fn write(&self, path: &Path, contents: &str) -> Result<(), String>;
    /// 只有 [`undo`] 用，见它上面那句注释。
    #[allow(dead_code)]
    fn remove(&self, path: &Path) -> Result<(), String>;
}

/// Windows 注册表。macOS 上用 [`NoRegistry`]，什么都不做。
pub trait Registry {
    fn read(&self, key: &str) -> Option<String>;
    fn write(&self, key: &str, value: &str) -> Result<(), String>;
    #[allow(dead_code)]
    fn remove(&self, key: &str) -> Result<(), String>;
}

pub struct RealFiles;

impl Files for RealFiles {
    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn write(&self, path: &Path, contents: &str) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建不了 {}：{e}", parent.display()))?;
        }
        std::fs::write(path, contents).map_err(|e| format!("写不了 {}：{e}", path.display()))
    }

    fn remove(&self, path: &Path) -> Result<(), String> {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删不了 {}：{e}", path.display())),
        }
    }
}

pub struct NoRegistry;

impl Registry for NoRegistry {
    fn read(&self, _key: &str) -> Option<String> {
        None
    }
    fn write(&self, _key: &str, _value: &str) -> Result<(), String> {
        Ok(())
    }
    fn remove(&self, _key: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(windows)]
pub struct HkcuRegistry;

#[cfg(windows)]
impl Registry for HkcuRegistry {
    fn read(&self, key: &str) -> Option<String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(key)
            .ok()?
            .get_value::<String, _>("")
            .ok()
    }

    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let (handle, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(key)
            .map_err(|e| format!("建不了注册表键 {key}：{e}"))?;
        handle
            .set_value("", &value)
            .map_err(|e| format!("写不了注册表键 {key}：{e}"))
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        match RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(key) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删不了注册表键 {key}：{e}")),
        }
    }
}

/// 把清单和注册表核对一遍，需要就写。返回每个浏览器的结果和新的回执。
pub fn ensure(
    targets: &[Target],
    exe: &Path,
    extension_ids: &[String],
    files: &dyn Files,
    registry: &dyn Registry,
    receipt: Receipt,
) -> (Vec<Outcome>, Receipt) {
    let desired = match manifest_json(exe, extension_ids) {
        Ok(text) => text,
        Err(problem) => {
            let outcomes = targets
                .iter()
                .map(|target| Outcome {
                    browser: target.browser,
                    label: target.browser.label().to_string(),
                    registered: false,
                    note: Some(problem.clone()),
                })
                .collect();
            return (outcomes, receipt);
        }
    };

    let mut next = Receipt::default();
    let mut outcomes = Vec::new();
    for target in targets {
        let key = target.manifest_path.to_string_lossy().to_string();
        let existing = files.read(&target.manifest_path);
        let recorded = receipt.written.get(&key).cloned();
        let decision = decide(existing.as_deref(), &desired, recorded.as_deref());

        let mut note = None;
        let mut registered = true;
        match decision {
            Decision::NotOurs => {
                registered = false;
                note = Some(format!(
                    "{} 已经有一份别的同名清单，没有动它。要用本程序请先删掉 {}",
                    target.browser.label(),
                    target.manifest_path.display()
                ));
                next.skipped.push(key.clone());
            }
            Decision::Write => match files.write(&target.manifest_path, &desired) {
                Ok(()) => {
                    next.written.insert(key.clone(), digest(&desired));
                }
                Err(problem) => {
                    registered = false;
                    note = Some(problem);
                }
            },
            Decision::UpToDate => {
                next.written.insert(key.clone(), digest(&desired));
            }
        }

        // 注册表这一步和清单分开算：清单在、键没了，浏览器照样找不到 host。
        if registered {
            if let Some(reg_key) = &target.registry_key {
                let current = registry.read(reg_key);
                let exists = files.read(&target.manifest_path).is_some();
                if registry_needs_update(current.as_deref(), &target.manifest_path, exists) {
                    if let Err(problem) = registry.write(reg_key, &key) {
                        registered = false;
                        note = Some(problem);
                    }
                }
            }
        }

        outcomes.push(Outcome {
            browser: target.browser,
            label: target.browser.label().to_string(),
            registered,
            note,
        });
    }
    (outcomes, next)
}

/// 卸载时按回执删：只删我们写过的那些文件，别人的清单一个不碰。
///
/// 卸载器怎么调它是 D13 PR 4（卸载钩子）的事；这里先把语义和测试立住。
#[allow(dead_code)]
pub fn undo(
    targets: &[Target],
    files: &dyn Files,
    registry: &dyn Registry,
    receipt: &Receipt,
) -> Vec<String> {
    let mut problems = Vec::new();
    for target in targets {
        let key = target.manifest_path.to_string_lossy().to_string();
        let Some(recorded) = receipt.written.get(&key) else {
            continue;
        };
        // 回执说这份是我们写的，但盘上的内容可能已经被人改过。改过的就不是
        // 「我们写的那份」了，删它等于删别人的东西。
        let ours = files
            .read(&target.manifest_path)
            .map(|current| digest(&current) == *recorded)
            .unwrap_or(false);
        if ours {
            if let Err(problem) = files.remove(&target.manifest_path) {
                problems.push(problem);
            }
        }
        if let Some(reg_key) = &target.registry_key {
            // 同理：键现在指着别处，说明别人接管了这个 host 名，不动它。
            let points_at_us =
                registry.read(reg_key).as_deref() == Some(key.as_str());
            if points_at_us {
                if let Err(problem) = registry.remove(reg_key) {
                    problems.push(problem);
                }
            }
        }
    }
    problems
}

/// 读回执。读不出来就当没有——回执丢了最坏也就是不敢重写别人的清单。
pub fn load_receipt(files: &dyn Files, path: &Path) -> Receipt {
    files
        .read(path)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_receipt(files: &dyn Files, path: &Path, receipt: &Receipt) -> Result<(), String> {
    let text = serde_json::to_string_pretty(receipt).map_err(|e| e.to_string())?;
    files.write(path, &text)
}
