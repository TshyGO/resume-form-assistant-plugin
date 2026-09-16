//! 引用片段核对：模型说「依据是这一句」，那这一句必须真的在原文里。

/// 归一化：所有空白（含全角空格、换行）压成一个半角空格，两端去空白。
/// 只做这一层，不做大小写折叠——邮件正文里大小写常常就是信息。
pub fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for ch in value.chars() {
        if ch.is_whitespace() || ch == '\u{3000}' {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    out
}

/// 片段（归一化后）是否确实出自正文。
pub fn appears_in(body: &str, excerpt: &str) -> bool {
    let needle = normalize(excerpt);
    if needle.is_empty() {
        return false;
    }
    normalize(body).contains(&needle)
}
