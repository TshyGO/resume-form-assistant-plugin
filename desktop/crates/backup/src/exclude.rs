//! 什么进包、什么不进包。
//!
//! 这是一份**手写清单**，所以它必须有守卫。插件那边的 `plugin-release-assets.json`
//! 是同一个道理：清单一旦靠人记得补，加东西的人忘了就静默漏——这次漏的可能是
//! 一份日志里的邮件正文，或者一个机器专属路径。
//!
//! 守卫在 [`classify`]：档案目录里出现清单没覆盖的东西，它既不进包、也不被无声
//! 忽略，而是记进 [`crate::WriteReport::skipped`] 让调用方看得见。

/// 档案目录下会进包的顶层项。
pub const INCLUDED_PREFIXES: &[&str] = &["meta.json", "attachments/", "snapshots/"];

/// 档案目录下**明确**不进包的顶层项，以及为什么。
pub const EXCLUDED_PREFIXES: &[(&str, &str)] = &[
    // 正在被写的库不能直接拷。进包的是 SQLite backup API 出来的一致性快照。
    ("archive.db", "改用一致性快照"),
    ("archive.db-wal", "改用一致性快照"),
    ("archive.db-shm", "改用一致性快照"),
    ("tmp/", "临时文件"),
    ("backups/", "迁移前的库备份，属于这台机器"),
];

/// `settings.json` 里唯一会被带走的那些键（拆分计划 Q2）。
///
/// 整份带走会把将来加进去的任何机器专属设置一起带走；一个不带则换机后配对要
/// 从头再来。所以按键白名单，加新键的人必须显式决定它要不要跟着走。
pub const PORTABLE_SETTING_KEYS: &[&str] = &["pairing"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    /// 进包。
    Include,
    /// 不进包，有明确理由。
    Exclude(&'static str),
    /// 清单没覆盖。**不进包**，但要报告出来——这是清单该更新的信号。
    Unknown,
}

/// 档案目录里的一个相对路径该怎么处理。`rel` 用正斜杠，不带前导斜杠。
pub fn classify(rel: &str) -> Disposition {
    for (prefix, reason) in EXCLUDED_PREFIXES {
        if matches(rel, prefix) {
            return Disposition::Exclude(reason);
        }
    }
    for prefix in INCLUDED_PREFIXES {
        if matches(rel, prefix) {
            return Disposition::Include;
        }
    }
    Disposition::Unknown
}

fn matches(rel: &str, prefix: &str) -> bool {
    match prefix.strip_suffix('/') {
        // 目录前缀：`attachments/` 匹配它下面的一切，也匹配目录项本身。
        Some(dir) => rel == dir || rel.starts_with(&format!("{dir}/")),
        // 文件：只匹配它自己。
        None => rel == prefix,
    }
}

/// 从一份设置 JSON 里挑出可以带走的键。解析不了就当没有设置可带。
pub fn portable_settings(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let object = parsed.as_object()?;
    let mut kept = serde_json::Map::new();
    for key in PORTABLE_SETTING_KEYS {
        if let Some(value) = object.get(*key) {
            kept.insert((*key).to_string(), value.clone());
        }
    }
    if kept.is_empty() {
        return None;
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(kept)).ok()
}
