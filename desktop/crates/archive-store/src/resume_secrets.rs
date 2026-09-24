//! 密码、验证码类内容的识别（data-privacy §4.1）。与插件 `profile-fields.js` 的
//! `SECRET_LABEL` / `SECRET_VALUE` 同一口径，改这里要同步改那边。
//!
//! 放在存储层而不是命令层：档案会整库进 D12 备份，任何写入口（桌面界面、
//! 插件经协议写回、将来的导入）都得经过同一道拦截。

use std::sync::OnceLock;

use regex::Regex;

fn label_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)密码|口令|验证码|校验码|授权码|密钥|私钥|令牌|password|passwd|captcha|token|secret").unwrap()
    })
}

fn value_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(密码|口令|验证码|校验码|授权码|密钥|令牌|password|passwd|pwd|token|secret)\s*[:=：]\s*\S").unwrap()
    })
}

/// 字段名像是在问密码、验证码之类的秘密（比如「邮箱密码」「短信验证码」）。
pub fn is_secret_label(label: &str) -> bool {
    label_pattern().is_match(label)
}

/// 内容里带着「密码：xxx」这种写法。只看形如「名称 + 冒号/等号 + 内容」的，
/// 「密码学课程」这类正常文字不算。
pub fn is_secret_value(value: &str) -> bool {
    value_pattern().is_match(value)
}
