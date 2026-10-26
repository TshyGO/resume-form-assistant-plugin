use super::*;

fn header(id: &str, subject: &str) -> Header {
    Header::parse(format!("From: 星河科技 <hr@example.com>\r\nSubject: {subject}\r\nDate: Sat, 24 Oct 2026 12:00:00 +0800\r\nMessage-ID: <{id}>\r\n\r\n").as_bytes())
}
fn database() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    db.save_account("account", "a@qq.com").unwrap();
    (dir, db)
}

#[test]
fn provider_allowlist_never_accepts_arbitrary_endpoints_or_control_characters() {
    assert!(
        log::STATIC_MAX_LEVEL <= log::LevelFilter::Info,
        "protocol trace must never log authorization codes or mail bytes"
    );
    for (address, server, id) in [
        ("a@qq.com", "imap.qq.com", false),
        ("a@foxmail.com", "imap.qq.com", false),
        ("a@163.com", "imap.163.com", true),
        ("a@126.com", "imap.126.com", true),
    ] {
        let (_, provider) = Provider::detect(address).unwrap();
        assert_eq!(provider.server(), server);
        assert_eq!(provider.needs_id(), id);
    }
    assert_eq!(Provider::detect(" A@QQ.COM ").unwrap().0, "a@qq.com");
    for address in [
        "a@gmail.com",
        "a@qq.com.evil.test",
        "a@127.0.0.1",
        "@qq.com",
        "a\r\nLOGIN@qq.com",
        "a@qq.com:993",
        "a@a@qq.com",
    ] {
        assert_eq!(Provider::detect(address), Err(Error::Address));
    }
}
#[test]
fn rules_are_local_explainable_and_match_domains_on_label_boundaries() {
    let h = header("a@b", "星河科技面试邀请");
    let reasons = classify(&h, &["星河科技".into()]);
    assert!(reasons.contains(&"标题包含：面试".into()));
    assert!(reasons.contains(&"匹配申请公司：星河科技".into()));
    let mut h = header("b@c", "申请已收到");
    h.from_addr = Some("notice@mail.mokahr.com".into());
    assert!(classify(&h, &[]).iter().any(|s| s.contains("Moka")));
    for sender in [
        "moka@evil.test",
        "a@notmokahr.com",
        "a@mokahr.com.evil.test",
    ] {
        h.from_addr = Some(sender.into());
        assert!(classify(&h, &[]).is_empty());
    }
    h.from_addr = Some("recruitment@feishu.cn".into());
    assert!(classify(&h, &[]).iter().any(|s| s.contains("飞书招聘")));
    h.from_addr = Some("notice@feishu.cn".into());
    assert!(classify(&h, &[]).is_empty());
    h.subject = Some("Your OFFER".into());
    assert!(!classify(&h, &[]).is_empty());
    h.subject = Some("订单已发货".into());
    assert!(classify(&h, &[]).is_empty());

    let mut h = header("short@company", "普通系统通知");
    h.from_name = None;
    h.from_addr = Some("newsletter@dailynews.com".into());
    assert!(classify(&h, &["AI".into()]).is_empty());
    h.from_name = Some("AI 招聘团队".into());
    assert!(classify(&h, &["AI".into()])
        .iter()
        .any(|reason| reason.contains("匹配申请公司")));
    h.from_name = None;
    h.subject = Some("DAILY 新闻".into());
    assert!(classify(&h, &["AI".into()]).is_empty());
    h.subject = Some("AI 面试安排".into());
    assert!(classify(&h, &["AI".into()])
        .iter()
        .any(|reason| reason.contains("匹配申请公司")));

    h.subject = Some("Application update from Star Tech".into());
    assert!(classify(&h, &["Star Tech".into()])
        .iter()
        .any(|reason| reason.contains("匹配申请公司：Star Tech")));
    h.subject = Some("Application update from Star Technology".into());
    assert!(classify(&h, &["Star Tech".into()]).is_empty());
    h.subject = Some("Application status updated".into());
    h.from_name = Some("Moka团队".into());
    assert!(classify(&h, &["Moka".into()])
        .iter()
        .any(|reason| reason.contains("匹配申请公司：Moka")));
    h.from_name = None;
    h.subject = Some("来自Moka的申请更新".into());
    assert!(classify(&h, &["Moka".into()])
        .iter()
        .any(|reason| reason.contains("匹配申请公司：Moka")));
    h.subject = Some("Star科技Tech application update".into());
    assert!(classify(&h, &["Star Tech".into()]).is_empty());

    h.subject = Some("Special offers this week".into());
    assert!(classify(&h, &[]).is_empty());
    h.subject = Some("Your Offer is ready".into());
    assert!(classify(&h, &[])
        .iter()
        .any(|reason| reason == "标题包含：offer"));
    h.subject = Some("Coffer shop promotion".into());
    assert!(classify(&h, &[]).is_empty());
}
#[test]
fn encoded_sender_names_and_subjects_are_decoded_before_matching() {
    let h = Header::parse(
        b"From: =?UTF-8?B?TW9rYQ==?= <a@example.com>\r\nSubject: =?UTF-8?B?6Z2i6K+V?=\r\n\r\n",
    );
    assert_eq!(h.from_name.as_deref(), Some("Moka"));
    assert!(classify(&h, &[]).iter().any(|s| s.contains("面试")));
}
#[test]
fn discovery_keeps_only_matched_headers_and_progress() {
    let (dir, mut db) = database();
    let h = header("private@example.com", "PRIVATE_UNMATCHED_ORDER");
    db.commit_scan(
        "archive",
        "account",
        "INBOX",
        Cursor {
            validity: 1,
            uid: 2,
        },
        &[(2, h, vec![])],
    )
    .unwrap();
    assert_eq!(db.pending_count("archive").unwrap(), 0);
    assert_eq!(
        db.cursor("archive", "account", "INBOX").unwrap(),
        Some(Cursor {
            validity: 1,
            uid: 2
        })
    );
    drop(db);
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE_UNMATCHED_ORDER"));
    }
}
#[test]
fn ignores_survive_rescans_uid_rebuilds_and_folder_moves() {
    let (_dir, mut db) = database();
    let h = header("a@b", "面试邀请");
    db.commit_scan(
        "archive",
        "account",
        "INBOX",
        Cursor {
            validity: 1,
            uid: 9,
        },
        &[(9, h.clone(), vec!["面试".into()])],
    )
    .unwrap();
    let first = db.pending("archive", 100).unwrap().remove(0);
    assert_eq!(db.finish("archive", &[first.id.clone()], true).unwrap(), 1);
    assert_eq!(db.finish("archive", &[first.id.clone()], true).unwrap(), 0);
    db.commit_scan(
        "archive",
        "account",
        "Junk",
        Cursor {
            validity: 2,
            uid: 3,
        },
        &[(3, h, vec!["面试".into()])],
    )
    .unwrap();
    assert_eq!(db.pending_count("archive").unwrap(), 0);
    assert_eq!(
        db.cursor("archive", "account", "INBOX")
            .unwrap()
            .unwrap()
            .uid,
        9
    );
    assert_eq!(
        db.cursor("archive", "account", "Junk")
            .unwrap()
            .unwrap()
            .uid,
        3
    );
}
#[test]
fn missing_ids_use_stable_header_fingerprints_not_just_subjects() {
    let mut h = header("a@b", "面试邀请");
    h.message_id = None;
    let same = h.clone();
    assert_eq!(h.fingerprint(), same.fingerprint());
    h.sent_at = Some("2026-10-25T04:00:00Z".into());
    assert_ne!(h.fingerprint(), same.fingerprint());
}
#[test]
fn reused_message_ids_from_different_senders_are_not_silently_dropped() {
    let (_dir, mut db) = database();
    let h = header("a@b", "面试邀请");
    let mut other = h.clone();
    other.from_addr = Some("other@example.com".into());
    db.commit_scan(
        "archive",
        "account",
        "INBOX",
        Cursor {
            validity: 1,
            uid: 2,
        },
        &[(1, h, vec!["面试".into()]), (2, other, vec!["面试".into()])],
    )
    .unwrap();
    assert_eq!(db.pending_count("archive").unwrap(), 2);
}
#[test]
fn candidate_and_cursor_commit_is_atomic_even_if_sqlite_rejects_progress() {
    let (dir, mut db) = database();
    db.commit_scan(
        "archive",
        "account",
        "INBOX",
        Cursor {
            validity: 1,
            uid: 1,
        },
        &[],
    )
    .unwrap();
    let observer = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    observer.execute_batch("CREATE TRIGGER reject_progress BEFORE UPDATE ON cursors BEGIN SELECT RAISE(ABORT,'disk simulation'); END;").unwrap();
    assert!(db
        .commit_scan(
            "archive",
            "account",
            "INBOX",
            Cursor {
                validity: 1,
                uid: 2
            },
            &[(2, header("a@b", "面试"), vec!["面试".into()])]
        )
        .is_err());
    assert_eq!(db.pending_count("archive").unwrap(), 0);
    assert_eq!(
        db.cursor("archive", "account", "INBOX")
            .unwrap()
            .unwrap()
            .uid,
        1
    );
}
#[test]
fn partial_retry_updates_locators_without_resurrecting_confirmed_messages() {
    let (_dir, mut db) = database();
    let h = header("a@b", "面试");
    db.commit_scan(
        "archive",
        "account",
        "INBOX",
        Cursor {
            validity: 1,
            uid: 2,
        },
        &[(2, h.clone(), vec!["面试".into()])],
    )
    .unwrap();
    let first = db.pending("archive", 100).unwrap().remove(0);
    db.commit_scan(
        "archive",
        "account",
        "Junk",
        Cursor {
            validity: 2,
            uid: 4,
        },
        &[(4, h.clone(), vec!["面试".into()])],
    )
    .unwrap();
    let updated = db.candidate("archive", &first.id).unwrap();
    assert_eq!(updated.uid, 4);
    assert_eq!(updated.folder, "Junk");
    db.finish("archive", &[first.id], false).unwrap();
    db.commit_scan(
        "archive",
        "account",
        "INBOX",
        Cursor {
            validity: 3,
            uid: 7,
        },
        &[(7, h, vec!["面试".into()])],
    )
    .unwrap();
    assert_eq!(db.pending_count("archive").unwrap(), 0);
}
#[test]
fn failures_back_off_pause_and_resume_durably() {
    let (dir, db) = database();
    db.failure("account", Error::Network, 100).unwrap();
    assert_eq!(db.account("account").unwrap().next_check, 160);
    db.failure("account", Error::Auth, 200).unwrap();
    assert!(!db.account("account").unwrap().paused);
    db.failure("account", Error::Auth, 300).unwrap();
    drop(db);
    let db = Database::open(dir.path()).unwrap();
    assert!(db.account("account").unwrap().paused);
    assert_eq!(
        db.account("account").unwrap().last_error.as_deref(),
        Some("Auth")
    );
    db.pause("account", false).unwrap();
    assert_eq!(db.account("account").unwrap().next_check, 0);
    db.success("account", 400).unwrap();
    assert_eq!(db.account("account").unwrap().next_check, 1000);
    assert_eq!(db.account("account").unwrap().failures, 0);
}
#[test]
fn unreadable_live_headers_retry_three_times_then_remain_visible_as_issues() {
    let (_dir, mut db) = database();
    assert_eq!(
        db.record_header_failure("archive", "account", "INBOX", 7, 102)
            .unwrap(),
        1
    );
    assert_eq!(
        db.prepare_header_retries("archive", "account", "INBOX", 7, 8)
            .unwrap(),
        vec![HeaderRetry {
            uid: 102,
            attempts: 1
        }]
    );
    assert_eq!(
        db.record_header_failure("archive", "account", "INBOX", 7, 102)
            .unwrap(),
        2
    );
    assert_eq!(
        db.record_header_failure("archive", "account", "INBOX", 7, 102)
            .unwrap(),
        3
    );
    assert!(db
        .prepare_header_retries("archive", "account", "INBOX", 7, 8)
        .unwrap()
        .is_empty());
    assert_eq!(db.header_issue_count("archive", "account").unwrap(), 1);
    db.commit_header_retry("archive", "account", "INBOX", 7, 102, None)
        .unwrap();
    assert_eq!(db.header_issue_count("archive", "account").unwrap(), 0);
}
#[test]
fn deferred_headers_do_not_consume_a_retry_attempt_before_fetching() {
    let (_dir, db) = database();
    db.defer_header_retry("archive", "account", "INBOX", 7, 103)
        .unwrap();
    assert_eq!(
        db.prepare_header_retries("archive", "account", "INBOX", 7, 8)
            .unwrap(),
        vec![HeaderRetry {
            uid: 103,
            attempts: 0
        }]
    );
    assert_eq!(
        db.record_header_failure("archive", "account", "INBOX", 7, 103)
            .unwrap(),
        1
    );
}

#[test]
fn partial_checks_preserve_the_last_successful_check_time() {
    let (_dir, db) = database();
    db.success("account", 100).unwrap();
    db.partial_failure("account", Error::Protocol, 200).unwrap();
    let account = db.account("account").unwrap();
    assert_eq!(account.last_checked, Some(100));
    assert_eq!(account.next_check, 260);
    assert_eq!(account.last_error.as_deref(), Some("Protocol"));
}
#[test]
fn deleting_accounts_cascades_and_archive_scopes_stay_separate() {
    let (_dir, mut db) = database();
    db.commit_scan(
        "a",
        "account",
        "INBOX",
        Cursor {
            validity: 1,
            uid: 1,
        },
        &[(1, header("a@b", "面试"), vec!["面试".into()])],
    )
    .unwrap();
    let item = db.pending("a", 100).unwrap().remove(0);
    assert!(db.candidate("b", &item.id).is_err());
    db.finish("b", &[item.id], true).unwrap();
    assert_eq!(db.pending_count("a").unwrap(), 1);
    db.delete_account("account").unwrap();
    assert_eq!(db.pending_count("a").unwrap(), 0);
    assert!(db.cursor("a", "account", "INBOX").unwrap().is_none());
}
