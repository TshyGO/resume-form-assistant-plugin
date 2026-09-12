//! 安全文件名与不覆盖的冲突处理（data-privacy：附件文件名冲突时加后缀，不覆盖）。

use std::path::{Path, PathBuf};

const MAX_STEM: usize = 80;
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 一个只由本机字符集内的安全字符组成、不含任何路径分隔的文件名。
///
/// 保留字母、数字、CJK、`.`、`-`、`_` 与空格，其余替换成 `_`；去掉首尾空白与点；
/// 主干砍到 80 字符（扩展名保留，最长 16 字符）；Windows 保留名前加 `_`；空名回退
/// 为 `evidence`。
pub fn safe_file_name(original: Option<&str>) -> String {
    let raw = original.unwrap_or("").trim();
    // 目录分隔与盘符先切掉：只留最后一段，绝不让 `..` 或 `C:\` 参与拼路径。
    let last = raw
        .rsplit(|c| c == '/' || c == '\\' || c == ':')
        .next()
        .unwrap_or("");
    let mut cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '_') && cleaned.len() < 2 {
        cleaned = "evidence".to_string();
    }

    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.chars().count() <= 16 => {
            (stem.to_string(), Some(ext.to_lowercase()))
        }
        _ => (cleaned.clone(), None),
    };

    let mut stem: String = stem.chars().take(MAX_STEM).collect();
    stem = stem.trim().to_string();
    if stem.is_empty() {
        stem = "evidence".to_string();
    }
    if RESERVED.contains(&stem.to_lowercase().as_str()) {
        stem.insert(0, '_');
    }

    match ext {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem,
    }
}

/// `dir` 里一个还没被占用的路径。冲突时在主干后加 `-2`、`-3`……绝不覆盖。
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), Some(ext.to_string())),
        _ => (file_name.to_string(), None),
    };
    for n in 2..10_000 {
        let name = match &ext {
            Some(ext) => format!("{stem}-{n}.{ext}"),
            None => format!("{stem}-{n}"),
        };
        let candidate = dir.join(&name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_can_never_carry_a_path() {
        for hostile in [
            "../../etc/passwd",
            "..\\..\\windows\\win.ini",
            "C:\\Windows\\win.ini",
            "\\\\server\\share\\x.eml",
            "/etc/shadow",
        ] {
            let safe = safe_file_name(Some(hostile));
            assert!(
                !safe.contains('/') && !safe.contains('\\') && !safe.contains(':'),
                "{safe}"
            );
            assert_ne!(safe, "..");
            assert!(!safe.starts_with('.'), "{safe}");
        }
    }

    #[test]
    fn ordinary_names_survive_including_chinese() {
        assert_eq!(
            safe_file_name(Some("面试邀请 2026.eml")),
            "面试邀请 2026.eml"
        );
        assert_eq!(safe_file_name(Some("offer.PDF")), "offer.pdf");
        assert_eq!(safe_file_name(Some("a*b?c.txt")), "a_b_c.txt");
    }

    #[test]
    fn empty_and_reserved_names_get_something_usable() {
        assert_eq!(safe_file_name(None), "evidence");
        assert_eq!(safe_file_name(Some("   ")), "evidence");
        assert_eq!(safe_file_name(Some("...")), "evidence");
        assert_eq!(safe_file_name(Some("CON.txt")), "_CON.txt");
        assert_eq!(safe_file_name(Some("lpt9")), "_lpt9");
    }

    #[test]
    fn a_very_long_name_keeps_its_extension() {
        let name = safe_file_name(Some(&format!("{}.eml", "a".repeat(300))));
        assert!(name.ends_with(".eml"));
        assert!(
            name.chars().count() <= MAX_STEM + 4,
            "{}",
            name.chars().count()
        );
    }
}
