//! D09 PR 2：一封 `.eml` 变成能安全显示的头部与纯文本正文，或者变成「读不懂但仍然存下」。

use evidence_import::{html_to_text, parse_eml, MAX_BODY_EXTRACT};

fn wrap(headers: &str, body: &str) -> Vec<u8> {
    format!("{headers}\r\n\r\n{body}").into_bytes()
}

#[test]
fn a_plain_email_gives_its_headers_and_body() {
    let raw = wrap(
        "From: \"HR 招聘\" <hr@example.test>\r\n\
         To: me@example.test\r\n\
         Subject: 面试邀请\r\n\
         Date: Fri, 12 Sep 2026 08:00:00 +0000",
        "你好，下周二上午十点面试。\r\n",
    );
    let mail = parse_eml(&raw).expect("this is an email");
    assert_eq!(mail.subject.as_deref(), Some("面试邀请"));
    assert_eq!(mail.from_addr.as_deref(), Some("hr@example.test"));
    assert_eq!(mail.sent_at.as_deref(), Some("2026-09-12T08:00:00Z"));
    assert!(mail
        .body_extract
        .as_deref()
        .unwrap()
        .contains("下周二上午十点"));
    assert!(!mail.had_html);
}

#[test]
fn an_encoded_chinese_subject_and_body_come_back_readable() {
    let raw = wrap(
        "From: hr@example.test\r\n\
         Subject: =?UTF-8?B?6Z2i6K+V6YKA6K+3?=\r\n\
         Date: Fri, 12 Sep 2026 08:00:00 +0000\r\n\
         Content-Type: text/plain; charset=\"gb18030\"\r\n\
         Content-Transfer-Encoding: base64",
        "1eLKx7zyzOXW0M7E\r\n",
    );
    let mail = parse_eml(&raw).expect("this is an email");
    assert_eq!(mail.subject.as_deref(), Some("面试邀请"));
    assert_eq!(mail.body_extract.as_deref(), Some("这是简体中文"));
}

#[test]
fn a_multipart_message_prefers_the_plain_text_part() {
    let raw = "From: hr@example.test\r\n\
Subject: Offer\r\n\
Date: Fri, 12 Sep 2026 08:00:00 +0000\r\n\
Content-Type: multipart/alternative; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/plain; charset=\"utf-8\"\r\n\
\r\n\
纯文本版本\r\n\
--b\r\n\
Content-Type: text/html; charset=\"utf-8\"\r\n\
\r\n\
<p>HTML 版本</p>\r\n\
--b--\r\n"
        .as_bytes()
        .to_vec();
    let mail = parse_eml(&raw).expect("this is an email");
    assert_eq!(mail.body_extract.as_deref(), Some("纯文本版本"));
    assert!(mail.had_html, "the html part is still noted");
}

#[test]
fn an_html_only_message_is_flattened_to_text_without_anything_executable() {
    let raw = wrap(
        "From: hr@example.test\r\n\
         Subject: 通知\r\n\
         Date: Fri, 12 Sep 2026 08:00:00 +0000\r\n\
         Content-Type: text/html; charset=\"utf-8\"",
        "<html><head><style>p{color:red}</style></head><body>\
         <script>alert('x')</script>\
         <p>请点击 <a href=\"https://tracker.example.test/click?id=1\">这里</a></p>\
         <img src=\"https://tracker.example.test/pixel.gif\">\
         <p>第二段</p></body></html>",
    );
    let mail = parse_eml(&raw).expect("this is an email");
    let text = mail.body_extract.unwrap();
    // 链接以 RFC 风格的 `文字 <URL>` 出现，除此之外没有任何标签留下。
    assert!(
        !text.contains("<p") && !text.contains("<img") && !text.contains("</"),
        "{text}"
    );
    assert!(
        !text.contains("pixel.gif"),
        "远程图片连地址都不该出现：{text}"
    );
    assert!(!text.to_lowercase().contains("script"), "{text}");
    assert!(!text.contains("color:red"), "{text}");
    assert!(
        text.contains("这里 <https://tracker.example.test/click?id=1>"),
        "{text}"
    );
    assert!(text.contains("第二段"), "{text}");
    assert!(mail.had_html);
}

#[test]
fn a_forwarded_and_quoted_thread_stays_readable() {
    let raw = wrap(
        "From: me@example.test\r\n\
         Subject: Fwd: 面试邀请\r\n\
         Date: Fri, 12 Sep 2026 09:00:00 +0000",
        "转发如下\r\n\r\n-----Original Message-----\r\n> 下周二上午十点\r\n> 地点：望京\r\n",
    );
    let mail = parse_eml(&raw).expect("this is an email");
    let text = mail.body_extract.unwrap();
    assert!(text.contains("-----Original Message-----"));
    assert!(text.contains("> 下周二上午十点"));
}

#[test]
fn a_very_long_body_is_cut_and_says_so() {
    let raw = wrap(
        "From: hr@example.test\r\nSubject: 长信\r\nDate: Fri, 12 Sep 2026 08:00:00 +0000",
        &"内容".repeat(60_000),
    );
    let mail = parse_eml(&raw).expect("this is an email");
    let text = mail.body_extract.unwrap();
    assert!(text.len() <= MAX_BODY_EXTRACT + 64, "{}", text.len());
    assert!(
        text.ends_with("（正文已截断）"),
        "{}",
        &text[text.len() - 40..]
    );
}

#[test]
fn headers_that_cannot_be_read_do_not_stop_the_import() {
    // 没有日期、没有主题、正文空：能拿多少算多少，不报错。
    let mail = parse_eml(b"From: hr@example.test\r\n\r\n").expect("still an email");
    assert_eq!(mail.from_addr.as_deref(), Some("hr@example.test"));
    assert_eq!(mail.subject, None);
    assert_eq!(mail.sent_at, None);

    // 完全不是邮件：None，调用方按 unknown 存下原件。
    assert!(parse_eml(b"just some notes about the interview").is_none());
    assert!(parse_eml(&[0xFF, 0xFE, 0x00, 0x01]).is_none());
}

#[test]
fn a_truncated_multipart_message_does_not_panic() {
    let raw = "From: hr@example.test\r\n\
Subject: broken\r\n\
Content-Type: multipart/mixed; boundary=\"b\"\r\n\
\r\n\
--b\r\n\
Content-Type: text/plain\r\n\
\r\n\
half a line"
        .as_bytes()
        .to_vec();
    let mail = parse_eml(&raw).expect("headers are there");
    assert_eq!(mail.subject.as_deref(), Some("broken"));
}

#[test]
fn html_to_text_is_usable_on_its_own() {
    assert_eq!(html_to_text("<p>a</p><p>b</p>").trim(), "a\n\nb");
    assert_eq!(html_to_text("a<br>b").trim(), "a\nb");
    assert_eq!(
        html_to_text("&lt;tag&gt; &amp; &nbsp;x").trim(),
        "<tag> &  x"
    );
    assert_eq!(html_to_text("<script>evil()</script>ok").trim(), "ok");
}
