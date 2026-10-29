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
fn presets_are_exact_and_arbitrary_addresses_do_not_get_guessed_servers() {
    assert!(
        log::STATIC_MAX_LEVEL <= log::LevelFilter::Info,
        "protocol trace must never log authorization codes or mail bytes"
    );
    for (address, server, id) in [
        ("a@qq.com", "imap.qq.com", false),
        ("a@foxmail.com", "imap.qq.com", false),
        ("a@163.com", "imap.163.com", true),
        ("a@126.com", "imap.126.com", true),
        ("a@gmail.com", "imap.gmail.com", false),
        ("a@icloud.com", "imap.mail.me.com", false),
        ("a@sina.com", "imap.sina.com", false),
        ("a@sohu.com", "imap.sohu.com", false),
        ("a@aliyun.com", "imap.aliyun.com", false),
        ("a@139.com", "imap.139.com", false),
    ] {
        let (_, provider) = Provider::detect(address).unwrap();
        assert_eq!(provider.server(), server);
        assert_eq!(provider.needs_id(), id);
    }
    assert_eq!(Provider::detect(" A@QQ.COM ").unwrap().0, "a@qq.com");
    for address in [
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
    assert!(
        matches!(updated.locator, crate::source::MessageLocator::Imap { ref folder, uid: 4, .. } if folder == "Junk")
    );
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

#[test]
fn manual_configuration_is_validated_and_never_accepts_urls_plaintext_or_empty_logins() {
    let config = ConnectionConfig {
        host: "imap.school.example".into(),
        port: 993,
        encryption: Encryption::Tls,
        username: "student".into(),
        send_id: false,
        endpoint_confirmation: None,
    };
    assert!(config.clone().validated("student@school.example").is_ok());
    for host in [
        "https://mail.school.example/",
        "imap.school.example:993",
        "127.0.0.1",
        "a\r\nLOGIN.example",
        "-imap.school.example",
    ] {
        let mut invalid = config.clone();
        invalid.host = host.into();
        assert_eq!(
            invalid.validated("a@school.example"),
            Err(Error::Configuration)
        );
    }
    let mut invalid = config.clone();
    invalid.port = 0;
    assert_eq!(
        invalid.validated("a@school.example"),
        Err(Error::Configuration)
    );
    let mut invalid = config.clone();
    invalid.username = "a\nLOGIN".into();
    assert_eq!(
        invalid.validated("a@school.example"),
        Err(Error::Configuration)
    );
    for email in ["a@outlook.com", "a@hotmail.com", "a@live.com"] {
        assert_eq!(config.clone().validated(email), Err(Error::OAuthRequired));
    }
    assert!(serde_json::from_str::<Encryption>("\"none\"").is_err());
    assert_eq!(
        ConnectionConfig::preset("a@sina.cn").unwrap().host,
        "imap.sina.cn"
    );
}
#[test]
fn legacy_accounts_migrate_and_custom_settings_survive_restart_without_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    conn.execute_batch("CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,paused INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_checked INTEGER,next_check INTEGER NOT NULL DEFAULT 0);INSERT INTO accounts(id,email) VALUES ('old','a@qq.com');").unwrap();
    drop(conn);
    let db = Database::open(dir.path()).unwrap();
    assert_eq!(
        db.account("old").unwrap().connection.unwrap().host,
        "imap.qq.com"
    );
    let config = ConnectionConfig {
        host: "mail.school.example".into(),
        port: 143,
        encryption: Encryption::Starttls,
        username: "shortname".into(),
        send_id: true,
        endpoint_confirmation: None,
    };
    db.save_configured_account("school", "a@school.example", &config)
        .unwrap();
    drop(db);
    let db = Database::open(dir.path()).unwrap();
    assert_eq!(db.account("school").unwrap().connection, Some(config));
    assert_eq!(db.account("school").unwrap().provider, Provider::Custom);
    assert_eq!(db.accounts().unwrap().len(), 2);
}
#[test]
fn changing_endpoint_resets_only_that_accounts_locators_and_keeps_other_accounts() {
    let (_dir, mut db) = database();
    db.save_account("other", "b@163.com").unwrap();
    for id in ["account", "other"] {
        db.commit_scan(
            "archive",
            id,
            "INBOX",
            Cursor {
                validity: 1,
                uid: 9,
            },
            &[(9, header(id, "面试"), vec!["关键词".into()])],
        )
        .unwrap();
    }
    for id in ["account", "other"] {
        db.record_header_failure("archive", id, "INBOX", 1, 10)
            .unwrap();
    }
    let mut config = db.account("account").unwrap().connection.unwrap();
    db.save_configured_account("ignored-new-id", "a@qq.com", &config)
        .unwrap();
    assert!(db.cursor("archive", "account", "INBOX").unwrap().is_some());
    config.host = "imap.other.example".into();
    db.save_configured_account("ignored-new-id", "a@qq.com", &config)
        .unwrap();
    assert!(db.cursor("archive", "account", "INBOX").unwrap().is_none());
    assert!(db.cursor("archive", "other", "INBOX").unwrap().is_some());
    assert!(db
        .prepare_header_retries("archive", "account", "INBOX", 1, 100)
        .unwrap()
        .is_empty());
    assert_eq!(
        db.prepare_header_retries("archive", "other", "INBOX", 1, 100)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(db.pending_count("archive").unwrap(), 1);
    assert_eq!(db.pending("archive", 10).unwrap()[0].account_id, "other");
}

#[test]
fn endpoint_trust_is_label_bounded_and_confirmation_is_bound_to_the_whole_destination() {
    let mut config = ConnectionConfig::preset("a@qq.com").unwrap();
    for host in [
        "school.example",
        "imap.school.example",
        "imap.qq.com",
        "imap.exmail.qq.com",
        "imap.qiye.163.com",
        "imap.mail.me.com",
    ] {
        config.host = host.into();
        assert!(
            config.authorize_endpoint("a@school.example").is_ok(),
            "{host}"
        );
    }
    for host in [
        "school.example.evil.test",
        "notschool.example",
        "imap.exmail.qq.com.evil.test",
        "evil.exmail.qq.com",
        "mail.other.example",
    ] {
        config.host = host.into();
        assert_eq!(
            config.authorize_endpoint("a@school.example"),
            Err(Error::EndpointConfirmation),
            "{host}"
        );
    }
    config.endpoint_confirmation = Some(
        config
            .endpoint_confirmation_for("a@school.example")
            .unwrap(),
    );
    assert!(config.authorize_endpoint("a@school.example").is_ok());
    assert!(config.authorize_endpoint(" A@SCHOOL.EXAMPLE ").is_ok());
    assert_eq!(
        config.authorize_endpoint("b@school.example"),
        Err(Error::EndpointConfirmation)
    );
    let original = config.clone();
    let mut changed = original.clone();
    changed.host = "mail.different.example".into();
    assert_eq!(
        changed.authorize_endpoint("a@school.example"),
        Err(Error::EndpointConfirmation)
    );
    let mut changed = original.clone();
    changed.port = 143;
    assert_eq!(
        changed.authorize_endpoint("a@school.example"),
        Err(Error::EndpointConfirmation)
    );
    let mut changed = original.clone();
    changed.encryption = Encryption::Starttls;
    assert_eq!(
        changed.authorize_endpoint("a@school.example"),
        Err(Error::EndpointConfirmation)
    );
    let mut changed = original.clone();
    changed.username = "different".into();
    assert_eq!(
        changed.authorize_endpoint("a@school.example"),
        Err(Error::EndpointConfirmation)
    );
    let mut changed = original;
    changed.send_id = !changed.send_id;
    assert_eq!(
        changed.authorize_endpoint("a@school.example"),
        Err(Error::EndpointConfirmation)
    );
}

#[tokio::test]
async fn unconfirmed_cross_domain_connection_is_rejected_before_any_network_or_login() {
    let config = ConnectionConfig {
        host: "mail.unrelated.invalid".into(),
        port: 993,
        encryption: Encryption::Tls,
        username: "a@school.example".into(),
        send_id: false,
        endpoint_confirmation: None,
    };
    assert!(matches!(
        imap::connect_configured("a@school.example", "synthetic-secret", &config).await,
        Err(Error::EndpointConfirmation)
    ));
    assert!(matches!(
        imap::test_connection("a@school.example", "synthetic-secret", &config).await,
        Err(Error::EndpointConfirmation)
    ));
    let (_dir, db) = database();
    let account = db
        .save_configured_account("legacy", "a@school.example", &config)
        .unwrap();
    assert!(matches!(
        imap::login_account(&account, "synthetic-secret").await,
        Err(Error::EndpointConfirmation)
    ));
    assert_eq!(db.accounts().unwrap().len(), 2); // One legacy row cannot break listing/recovery.
    let mut approved = config.clone();
    approved.endpoint_confirmation = Some(
        approved
            .endpoint_confirmation_for("a@school.example")
            .unwrap(),
    );
    approved.host = "mail.changed.invalid".into();
    assert!(matches!(
        imap::connect_configured("a@school.example", "synthetic-secret", &approved).await,
        Err(Error::EndpointConfirmation)
    ));
}

#[test]
fn confirmation_persists_and_updating_only_confirmation_keeps_scan_state() {
    let (dir, mut db) = database();
    let mut config = ConnectionConfig {
        host: "mail.external.example".into(),
        port: 993,
        encryption: Encryption::Tls,
        username: "a@school.example".into(),
        send_id: false,
        endpoint_confirmation: None,
    };
    db.save_configured_account("legacy", "a@school.example", &config)
        .unwrap();
    db.commit_scan(
        "archive",
        "legacy",
        "INBOX",
        Cursor {
            validity: 1,
            uid: 7,
        },
        &[],
    )
    .unwrap();
    config.endpoint_confirmation = Some(
        config
            .endpoint_confirmation_for("a@school.example")
            .unwrap(),
    );
    db.save_configured_account("legacy", "a@school.example", &config)
        .unwrap();
    assert_eq!(
        db.cursor("archive", "legacy", "INBOX").unwrap(),
        Some(Cursor {
            validity: 1,
            uid: 7
        })
    );
    drop(db);
    let db = Database::open(dir.path()).unwrap();
    let saved = db.account("legacy").unwrap();
    assert_eq!(saved.connection.as_ref(), Some(&config));
    saved
        .connection
        .unwrap()
        .authorize_endpoint(&saved.email)
        .unwrap();
}

#[test]
fn api_accounts_use_principals_not_addresses_and_keep_credentials_separate() {
    use crate::source::SourceKind;
    let (_dir, db) = database();
    let graph = db
        .save_api_account(
            "graph",
            "a@qq.com",
            SourceKind::MicrosoftGraph,
            "tenant:person-1",
        )
        .unwrap();
    assert!(graph.connection.is_none());
    assert_eq!(graph.credential_id(), "mailbox:graph");
    let alias = db
        .save_api_account(
            "unused",
            "alias@example.com",
            SourceKind::MicrosoftGraph,
            "tenant:person-1",
        )
        .unwrap();
    assert_eq!(alias.id, graph.id);
    db.save_api_account(
        "another",
        "alias@example.com",
        SourceKind::MicrosoftGraph,
        "tenant:person-2",
    )
    .unwrap();
    db.save_api_account(
        "gmail",
        "alias@example.com",
        SourceKind::GmailApi,
        "tenant:person-1",
    )
    .unwrap();
    assert_eq!(db.accounts().unwrap().len(), 4);
    assert_eq!(db.account("account").unwrap().source, SourceKind::Imap);
    assert_eq!(
        db.save_api_account(
            "graph",
            "other@example.com",
            SourceKind::MicrosoftGraph,
            "different-principal"
        )
        .unwrap_err(),
        Error::Storage
    );
    assert_eq!(
        db.account("graph").unwrap().source_account_id.as_deref(),
        Some("tenant:person-1")
    );
}

#[test]
fn api_positions_are_atomic_local_and_cannot_be_used_as_imap_uids() {
    use crate::source::{MessageLocator, Metadata, Position, SourceKind};
    let (dir, mut db) = database();
    db.save_api_account(
        "graph",
        "a@outlook.com",
        SourceKind::MicrosoftGraph,
        "person",
    )
    .unwrap();
    let message = Metadata {
        locator: MessageLocator::Api {
            source: SourceKind::MicrosoftGraph,
            message_id: "remote-message".into(),
        },
        header: header("shared@id", "面试"),
    };
    let first = Position::Api {
        source: SourceKind::MicrosoftGraph,
        cursor: "opaque-page-1".into(),
    };
    db.commit_metadata("archive", "graph", "inbox", &first, &[])
        .unwrap();
    let next = Position::Api {
        source: SourceKind::MicrosoftGraph,
        cursor: "opaque-delta-2".into(),
    };
    let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_position BEFORE UPDATE ON source_positions BEGIN SELECT RAISE(ABORT,'disk'); END;").unwrap();
    assert_eq!(
        db.commit_metadata(
            "archive",
            "graph",
            "inbox",
            &next,
            &[(message.clone(), vec!["面试".into()])]
        ),
        Err(Error::Storage)
    );
    assert_eq!(db.pending_count("archive").unwrap(), 0);
    assert!(db.source_position("archive", "graph", "inbox").unwrap() == Some(first));
    sql.execute_batch("DROP TRIGGER fail_position;").unwrap();
    db.commit_metadata(
        "archive",
        "graph",
        "inbox",
        &next,
        &[(message.clone(), vec!["面试".into()])],
    )
    .unwrap();
    let item = db.pending("archive", 100).unwrap().remove(0);
    assert_eq!(item.locator, message.locator);
    db.finish("archive", &[item.id], true).unwrap();
    // Different remote ID, same mail: an ignore must survive rescan/label moves.
    let mut moved = message;
    moved.locator = MessageLocator::Api {
        source: SourceKind::MicrosoftGraph,
        message_id: "moved-message".into(),
    };
    db.commit_metadata(
        "archive",
        "graph",
        "inbox",
        &next,
        &[(moved.clone(), vec!["面试".into()])],
    )
    .unwrap();
    assert_eq!(db.pending_count("archive").unwrap(), 0);
    assert!(db.cursor("archive", "graph", "inbox").unwrap().is_none());
    assert!(db
        .source_position("other-archive", "graph", "inbox")
        .unwrap()
        .is_none());
    assert_eq!(
        db.commit_metadata(
            "archive",
            "graph",
            "inbox",
            &Position::Imap(Cursor {
                validity: 1,
                uid: 2
            }),
            &[]
        ),
        Err(Error::Changed)
    );
    assert_eq!(
        db.commit_metadata("archive", "account", "INBOX", &next, &[]),
        Err(Error::Changed)
    );
    moved.locator = MessageLocator::Api {
        source: SourceKind::GmailApi,
        message_id: "gmail-message".into(),
    };
    assert_eq!(
        db.commit_metadata(
            "archive",
            "graph",
            "inbox",
            &next,
            &[(moved, vec!["面试".into()])]
        ),
        Err(Error::Changed)
    );
    drop(db);
    let db = Database::open(dir.path()).unwrap();
    assert!(db.source_position("archive", "graph", "inbox").unwrap() == Some(next));
    assert_eq!(db.pending_count("archive").unwrap(), 0);
    db.delete_account("graph").unwrap();
    assert!(db
        .source_position("archive", "graph", "inbox")
        .unwrap()
        .is_none());
    let dangling: u32 = sql
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(dangling, 0);
}

#[test]
fn source_migration_preserves_populated_imap_state_and_foreign_keys() {
    let dir = tempfile::tempdir().unwrap();
    let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    sql.execute_batch("CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,paused INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_checked INTEGER,next_check INTEGER NOT NULL DEFAULT 0);
        INSERT INTO accounts(id,email) VALUES ('legacy','old@163.com');
        CREATE TABLE candidates(id TEXT PRIMARY KEY,archive TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,folder TEXT NOT NULL,validity INTEGER NOT NULL,uid INTEGER NOT NULL,header TEXT NOT NULL,reasons TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(archive,account,fingerprint));
        CREATE TABLE cursors(archive TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,folder TEXT NOT NULL,validity INTEGER NOT NULL,uid INTEGER NOT NULL,PRIMARY KEY(archive,account,folder));
        INSERT INTO cursors VALUES ('archive','legacy','INBOX',7,30);").unwrap();
    for (id, state) in [("a", "pending"), ("b", "ignored"), ("c", "imported")] {
        let h = header(id, "面试");
        sql.execute("INSERT INTO candidates VALUES (?1,'archive','legacy',?2,'INBOX',7,20,?3,'[\"面试\"]',?4)",rusqlite::params![id,h.fingerprint(),serde_json::to_string(&h).unwrap(),state]).unwrap();
    }
    let mut db = Database::open(dir.path()).unwrap();
    assert_eq!(
        db.account("legacy").unwrap().credential_id(),
        "mailbox:legacy"
    );
    assert_eq!(
        db.cursor("archive", "legacy", "INBOX").unwrap(),
        Some(Cursor {
            validity: 7,
            uid: 30
        })
    );
    assert!(matches!(
        db.candidate("archive", "a").unwrap().locator,
        crate::source::MessageLocator::Imap {
            validity: 7,
            uid: 20,
            ..
        }
    ));
    db.commit_scan(
        "archive",
        "legacy",
        "INBOX",
        Cursor {
            validity: 8,
            uid: 40,
        },
        &[(40, header("b", "面试"), vec!["面试".into()])],
    )
    .unwrap();
    assert_eq!(db.pending_count("archive").unwrap(), 1);
    db.delete_account("legacy").unwrap();
    assert_eq!(db.pending_count("archive").unwrap(), 0);
    assert!(db.cursor("archive", "legacy", "INBOX").unwrap().is_none());
    let dangling: u32 = sql
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(dangling, 0);
}

#[test]
fn a_failed_source_migration_rolls_back_the_account_table_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
    sql.execute_batch("CREATE TABLE accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,paused INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_checked INTEGER,next_check INTEGER NOT NULL DEFAULT 0);
        INSERT INTO accounts(id,email) VALUES ('legacy','old@qq.com');
        CREATE TABLE candidates(id TEXT PRIMARY KEY,archive TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,folder TEXT NOT NULL,validity INTEGER NOT NULL,uid INTEGER NOT NULL,header TEXT NOT NULL,reasons TEXT NOT NULL,state TEXT NOT NULL,locator TEXT,UNIQUE(archive,account,fingerprint));").unwrap();
    // Force failure after DROP/RENAME but before commit (duplicate column).
    assert!(matches!(Database::open(dir.path()), Err(Error::Storage)));
    let email: String = sql
        .query_row("SELECT email FROM accounts WHERE id='legacy'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(email, "old@qq.com");
    let has_source: bool = sql
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('accounts') WHERE name='source')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!has_source);
    sql.execute_batch("ALTER TABLE candidates DROP COLUMN locator;")
        .unwrap();
    let db = Database::open(dir.path()).unwrap();
    assert_eq!(
        db.account("legacy").unwrap().credential_id(),
        "mailbox:legacy"
    );
}

#[tokio::test]
async fn cancellation_stops_all_pending_work_and_rejects_later_requests() {
    use crate::source::Cancellation;
    let cancellation = Cancellation::default();
    let (first_started, first_ready) = tokio::sync::oneshot::channel();
    let (second_started, second_ready) = tokio::sync::oneshot::channel();
    let (first, second, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        tokio::join!(
            cancellation.run(async {
                let _ = first_started.send(());
                std::future::pending::<Result<()>>().await
            }),
            cancellation.run(async {
                let _ = second_started.send(());
                std::future::pending::<Result<()>>().await
            }),
            async {
                first_ready.await.unwrap();
                second_ready.await.unwrap();
                cancellation.cancel();
            },
        )
    })
    .await
    .expect("all pending operations must wake on cancellation");
    assert_eq!(first, Err(Error::Cancelled));
    assert_eq!(second, Err(Error::Cancelled));
    let later = cancellation
        .run::<()>(async { panic!("a cancelled operation must not start") })
        .await;
    assert_eq!(later, Err(Error::Cancelled));
}
