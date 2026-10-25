//! Network runs on a blocking worker without the archive/restore lock. Every
//! completion checks both archive ID and restore epoch before touching evidence.
use crate::{
    ai_data_root, archive_worker, commands::CommandError, evidence_commands, with_store, AppState,
};
use archive_store::{ApplicationFilter, ArchiveIdentity, MailKey, Occurred};
use mailbox_sync::{
    classify, imap, Account, Candidate, ConnectionConfig, Cursor, Database, Error, Header,
};
use serde::Serialize;
use std::sync::MutexGuard;
use tauri::{AppHandle, Emitter};
type Result<T> = std::result::Result<T, CommandError>;

pub fn fail(error: Error) -> CommandError {
    let message = match error {
        Error::Address => "请输入有效的邮箱地址。",
        Error::Configuration => "请核对 IMAP 服务器域名、端口、加密方式和登录账号；服务器处不要填写网页链接。",
        Error::OAuthRequired => "Outlook / Hotmail / Live 需要微软登录授权，当前暂不支持。请改用手动导入邮件。",
        Error::Auth => "邮箱拒绝登录：请核对登录账号，确认已开启 IMAP；按邮箱或学校教程填写授权码、应用专用密码或登录密码。授权码失效时请重新生成。",
        Error::ImapDisabled => "邮箱尚未开启 IMAP。请按下方教程开启后，再测试连接。",
        Error::Network => "暂时连不上邮箱服务器，请核对地址与端口并检查网络；学校邮箱可能需要校园网或没有开放 IMAP，可改用手动导入。",
        Error::Tls => "无法验证邮箱服务器的安全连接，请检查系统时间和网络后重试。",
        Error::Protocol => "邮箱没有完成读取请求，请稍后重试；163 / 126 请核对 IMAP 授权设置。",
        Error::Storage => "邮箱设置或扫描记录未能保存，请检查本机磁盘后重试。",
        Error::Missing => "找不到这封候选邮件，可能已被移动或删除。请立即检查邮箱，或忽略此条。",
        Error::TooLarge => "邮件或信头过大，未能读取。单封邮件上限 25 MiB，可改用截图或粘贴文本。",
        Error::Changed => "邮箱编号或当前档案已变化，未保存邮件。请立即检查后重新确认。",
        Error::Busy => "邮箱操作正在进行，请完成后再试。",
        Error::Credentials => "系统凭据库暂时不可用或没有授权码，请解锁凭据库，或重新填写授权码并测试连接。",
    };
    CommandError {
        code: format!("MAILBOX_{error:?}").to_ascii_uppercase(),
        message: message.into(),
    }
}
fn mapped<T>(value: mailbox_sync::Result<T>) -> Result<T> {
    value.map_err(fail)
}
fn database(state: &AppState) -> Result<Database> {
    mapped(Database::open(&ai_data_root(state)?))
}
fn gate(state: &AppState) -> Result<MutexGuard<'_, ()>> {
    state.mailbox_gate.try_lock().map_err(|_| fail(Error::Busy))
}
fn identity(state: &AppState) -> Result<ArchiveIdentity> {
    with_store(state, |s| Ok(s.identity()))
}
fn check_identity(store: &archive_store::ArchiveStore, expected: &ArchiveIdentity) -> Result<()> {
    if &store.identity() != expected {
        return Err(fail(Error::Changed));
    }
    Ok(())
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
fn key(header: &Header) -> Option<MailKey> {
    Some(MailKey {
        message_id: header.message_id.clone()?,
        from_addr: header.from_addr.clone(),
        sent_at: header.sent_at.clone().map(|rfc3339| Occurred::DateTime {
            rfc3339,
            time_zone: None,
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub accounts: Vec<Account>,
    pub candidates: Vec<Candidate>,
    pub pending_count: u32,
}
fn view(state: &AppState, limit: u32) -> Result<View> {
    let db = database(state)?;
    let current = identity(state)?;
    Ok(View {
        accounts: mapped(db.accounts())?,
        candidates: mapped(db.pending(&current.archive_id, limit))?,
        pending_count: mapped(db.pending_count(&current.archive_id))?,
    })
}

fn save(
    state: &AppState,
    email: String,
    secret: String,
    config: Option<ConnectionConfig>,
) -> Result<()> {
    let email = mapped(mailbox_sync::config::normalize_email(&email))?;
    let config = mapped(match config {
        Some(config) => config.validated(&email),
        None => ConnectionConfig::preset(&email),
    })?;
    let secret = if mailbox_sync::Provider::detect(&email)
        .is_ok_and(|(_, p)| p == mailbox_sync::Provider::Gmail)
    {
        secret.replace(' ', "")
    } else {
        secret
    };
    // No persistence until the same connection has authenticated and opened folders.
    mapped(tauri::async_runtime::block_on(imap::test_connection(
        &email, &secret, &config,
    )))?;
    let db = database(state)?;
    persist_configured_account(&db, state.credentials.as_ref(), &email, &secret, &config)
}
#[cfg(test)]
fn persist_account(
    db: &Database,
    creds: &dyn crate::ai_credentials::CredentialStore,
    email: &str,
    secret: &str,
) -> Result<()> {
    persist_configured_account(
        db,
        creds,
        email,
        secret,
        &mapped(ConnectionConfig::preset(email))?,
    )
}
fn persist_configured_account(
    db: &Database,
    creds: &dyn crate::ai_credentials::CredentialStore,
    email: &str,
    secret: &str,
    config: &ConnectionConfig,
) -> Result<()> {
    let existing = mapped(db.accounts())?
        .into_iter()
        .find(|a| a.email == email);
    let id = existing
        .as_ref()
        .map(|a| a.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let credential_id = format!("mailbox:{id}");
    let previous = creds
        .get_key(&credential_id)
        .map_err(|_| fail(Error::Credentials))?;
    creds
        .set_key(&credential_id, secret.trim())
        .map_err(|_| fail(Error::Credentials))?;
    if let Err(error) = db.save_configured_account(&id, &email, config) {
        let restored = match previous {
            Some(value) => creds.set_key(&credential_id, &value),
            None => creds.clear_key(&credential_id),
        };
        restored.map_err(|_| fail(Error::Credentials))?;
        return Err(fail(error));
    }
    Ok(())
}
fn delete(state: &AppState, id: &str) -> Result<()> {
    let db = database(state)?;
    let account = mapped(db.account(id))?;
    // Pause first: a failed OS delete must never leave an active orphan connection.
    mapped(db.pause(id, true))?;
    state
        .credentials
        .clear_key(&account.credential_id())
        .map_err(|_| fail(Error::Credentials))?;
    mapped(db.delete_account(id))
}
fn companies(state: &AppState, expected: &ArchiveIdentity) -> Result<Vec<String>> {
    with_store(state, |store| {
        check_identity(store, expected)?;
        let mut companies = Vec::new();
        let mut offset = 0;
        loop {
            let page = store.list_applications(&ApplicationFilter {
                archived: Some(false),
                limit: 200,
                offset,
                ..Default::default()
            })?;
            let count = page.items.len();
            companies.extend(page.items.into_iter().map(|a| a.company));
            offset += count as u64;
            if count == 0 || offset >= page.total as u64 {
                break;
            }
        }
        companies.sort();
        companies.dedup();
        Ok(companies)
    })
}
async fn scan_folder(
    state: &AppState,
    db: &mut Database,
    expected: &ArchiveIdentity,
    account: &Account,
    companies: &[String],
    session: &mut imap::LiveSession,
    folder: &str,
) -> Result<()> {
    let cursor = mapped(db.cursor(&expected.archive_id, &account.id, folder))?;
    let plan = mapped(imap::plan(session, folder, cursor, now()).await)?;
    for chunk in plan.uids.chunks(imap::BATCH_SIZE) {
        let headers = mapped(imap::headers_resilient(session, chunk).await)?;
        // Short archive lock only for local matching and persistence. No network.
        with_store(state, |store| {
            check_identity(store, expected)?;
            let mut found = Vec::new();
            for (uid, header) in headers {
                let reasons = classify(&header, companies);
                if reasons.is_empty() {
                    continue;
                }
                let exists = key(&header)
                    .map(|key| store.find_known_mail(&key))
                    .transpose()?
                    .flatten()
                    .is_some();
                if !exists {
                    found.push((uid, header, reasons));
                }
            }
            mapped(db.commit_scan(
                &expected.archive_id,
                &account.id,
                folder,
                Cursor {
                    validity: plan.validity,
                    uid: *chunk.last().unwrap(),
                },
                &found,
            ))
        })?;
    }
    // Includes empty scans and expunged gaps, bounded by UIDNEXT snapshot.
    with_store(state, |store| {
        check_identity(store, expected)?;
        mapped(db.commit_scan(
            &expected.archive_id,
            &account.id,
            folder,
            Cursor {
                validity: plan.validity,
                uid: plan.high_uid,
            },
            &[],
        ))
    })
}

fn scan_account(
    state: &AppState,
    db: &mut Database,
    expected: &ArchiveIdentity,
    account: &Account,
    companies: &[String],
) -> Result<()> {
    let secret = state
        .credentials
        .get_key(&account.credential_id())
        .map_err(|_| fail(Error::Credentials))?
        .ok_or_else(|| fail(Error::Credentials))?;
    tauri::async_runtime::block_on(async {
        let mut session = mapped(imap::login_account(account, &secret).await)?;
        let folders = mapped(imap::folders(&mut session).await)?;
        let mut succeeded = 0usize;
        let mut first_error = None;
        for folder in folders {
            match scan_folder(
                state,
                db,
                expected,
                account,
                companies,
                &mut session,
                &folder,
            )
            .await
            {
                Ok(()) => succeeded += 1,
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            };
        }
        // A broken optional junk folder must not hide a healthy INBOX. If every
        // advertised folder failed, keep the account failure and retry policy.
        if succeeded == 0 {
            return Err(first_error.unwrap_or_else(|| fail(Error::Protocol)));
        }
        // Dropping a read-only session also safely closes the socket.
        Ok(())
    })
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub checked_accounts: u32,
    pub succeeded_accounts: u32,
    pub failed_accounts: Vec<CheckFailure>,
    pub skipped_paused: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckFailure {
    pub account_id: String,
    pub message: String,
    pub paused: bool,
}

/// Account failures stay independent, but are also returned to the initiating UI.
/// A successful IPC round trip does not mean that any mailbox was checked.
fn run_checks(
    db: &mut Database,
    accounts: Vec<Account>,
    force: bool,
    started_at: i64,
    mut scan: impl FnMut(&mut Database, &Account) -> Result<()>,
) -> Result<CheckReport> {
    let mut report = CheckReport::default();
    for account in accounts {
        if account.paused {
            report.skipped_paused += 1;
            continue;
        }
        if !force && account.next_check > started_at {
            continue;
        }
        report.checked_accounts += 1;
        match scan(db, &account) {
            Ok(()) => {
                mapped(db.success(&account.id, now()))?;
                report.succeeded_accounts += 1;
            }
            Err(error) => {
                if error.code == fail(Error::Changed).code {
                    return Err(error);
                }
                let category = [
                    Error::Auth,
                    Error::ImapDisabled,
                    Error::Network,
                    Error::Tls,
                    Error::Protocol,
                    Error::Storage,
                    Error::TooLarge,
                    Error::Credentials,
                ]
                .into_iter()
                .find(|category| fail(*category).code == error.code)
                .unwrap_or(Error::Storage);
                mapped(db.failure(&account.id, category, now()))?;
                report.failed_accounts.push(CheckFailure {
                    account_id: account.id.clone(),
                    message: fail(category).message,
                    paused: mapped(db.account(&account.id))?.paused,
                });
            }
        }
    }
    Ok(report)
}

fn check(state: &AppState, force: bool) -> Result<CheckReport> {
    let _gate = gate(state)?;
    let expected = identity(state)?;
    let mut db = database(state)?;
    let accounts = mapped(db.accounts())?;
    let started_at = now();
    let has_due = accounts
        .iter()
        .any(|a| !a.paused && (force || a.next_check <= started_at));
    let companies = if has_due {
        let companies = companies(state, &expected)?;
        // Upgrade-before-connect duplicates must be visible without downloading bodies.
        with_store(state, |store| {
            check_identity(store, &expected)?;
            evidence_commands::backfill_message_ids(store, store.archive_dir());
            Ok(())
        })?;
        companies
    } else {
        Vec::new()
    };
    run_checks(&mut db, accounts, force, started_at, |db, account| {
        scan_account(state, db, &expected, account, &companies)
    })
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmReport {
    pub imported: u32,
    pub duplicates: u32,
    pub failed: Vec<ConfirmFailure>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmFailure {
    pub id: String,
    pub message: String,
}
fn prepare_confirm(
    state: &AppState,
    db: &Database,
    expected: &ArchiveIdentity,
    id: &str,
) -> Result<Option<Candidate>> {
    let item = mapped(db.candidate(&expected.archive_id, id))?;
    // It may have been manually imported since discovery; skip the download too.
    let duplicate = with_store(state, |store| {
        check_identity(store, expected)?;
        evidence_commands::backfill_message_ids(store, store.archive_dir());
        Ok(key(&item.header)
            .map(|key| store.find_known_mail(&key))
            .transpose()?
            .flatten()
            .is_some())
    })?;
    if duplicate {
        with_store(state, |store| {
            check_identity(store, expected)?;
            mapped(db.finish(&expected.archive_id, &[id.into()], false)).map(|_| ())
        })?;
        return Ok(None);
    }
    Ok(Some(item))
}
fn confirm_failure(report: &mut ConfirmReport, id: String, error: CommandError) {
    report.failed.push(ConfirmFailure {
        id,
        message: error.message,
    });
}
async fn confirm_many(
    state: &AppState,
    db: &Database,
    expected: &ArchiveIdentity,
    ids: Vec<String>,
) -> ConfirmReport {
    use std::collections::BTreeMap;
    let mut report = ConfirmReport::default();
    let mut groups: BTreeMap<String, Vec<(String, Candidate)>> = BTreeMap::new();
    for id in ids {
        match prepare_confirm(state, db, expected, &id) {
            Ok(None) => report.duplicates += 1,
            Ok(Some(item)) => groups
                .entry(item.account_id.clone())
                .or_default()
                .push((id, item)),
            Err(error) => confirm_failure(&mut report, id, error),
        }
    }
    for (account_id, candidates) in groups {
        let account = match mapped(db.account(&account_id)) {
            Ok(account) => account,
            Err(error) => {
                for (id, _) in candidates {
                    confirm_failure(&mut report, id, error.clone());
                }
                continue;
            }
        };
        let secret = match state
            .credentials
            .get_key(&account.credential_id())
            .map_err(|_| fail(Error::Credentials))
            .and_then(|value| value.ok_or_else(|| fail(Error::Credentials)))
        {
            Ok(secret) => secret,
            Err(error) => {
                for (id, _) in candidates {
                    confirm_failure(&mut report, id, error.clone());
                }
                continue;
            }
        };
        let mut session = match imap::login_account(&account, &secret).await {
            Ok(connected) => Some(connected),
            Err(error) => {
                let error = fail(error);
                for (id, _) in candidates {
                    confirm_failure(&mut report, id, error.clone());
                }
                continue;
            }
        };
        for (id, item) in candidates {
            if session.is_none() {
                match imap::login_account(&account, &secret).await {
                    Ok(connected) => session = Some(connected),
                    Err(error) => {
                        confirm_failure(&mut report, id, fail(error));
                        continue;
                    }
                }
            }
            let download =
                imap::download(session.as_mut().expect("session established"), &item).await;
            match download {
                Ok(bytes) => match with_store(state, |store| {
                    persist_confirmed(store, db, expected, &id, &bytes)
                }) {
                    Ok(true) => report.duplicates += 1,
                    Ok(false) => report.imported += 1,
                    Err(error) => confirm_failure(&mut report, id, error),
                },
                Err(error) => {
                    let reconnect = matches!(error, Error::Network | Error::Protocol);
                    confirm_failure(&mut report, id, fail(error));
                    if reconnect {
                        session = None;
                    }
                }
            }
        }
    }
    report
}
fn persist_confirmed(
    store: &archive_store::ArchiveStore,
    db: &Database,
    expected: &ArchiveIdentity,
    id: &str,
    bytes: &[u8],
) -> Result<bool> {
    use sha2::{Digest, Sha256};
    check_identity(store, expected)?;
    // A crash can happen after archive import but before the local candidate is
    // consumed. Exact bytes also make this retry idempotent for ID-less mail.
    let sha = format!("{:x}", Sha256::digest(bytes));
    for existing in store.evidence_for_blob(&sha)? {
        if let Some(evidence) = store.get_evidence(&existing)? {
            let visible = match evidence.application_id.as_deref() {
                None => true,
                Some(app) => store
                    .get_application(app)?
                    .is_some_and(|a| a.recycle_state == archive_store::RecycleState::Active),
            };
            if visible {
                mapped(db.finish(&expected.archive_id, &[id.into()], false))?;
                return Ok(true);
            }
        }
    }
    let (_, duplicate) = evidence_commands::import_bytes(
        store,
        store.archive_dir(),
        bytes,
        Some("mailbox.eml".into()),
        &evidence_commands::bucket_now(),
        None,
    )
    .map_err(|failure| {
        if failure.code == "too_large" {
            fail(Error::TooLarge)
        } else {
            fail(Error::Storage)
        }
    })?;
    mapped(db.finish(&expected.archive_id, &[id.into()], false))?;
    Ok(duplicate)
}

#[tauri::command]
pub async fn mailbox_view(app: AppHandle, limit: Option<u32>) -> Result<View> {
    archive_worker(app, move |state| view(state, limit.unwrap_or(200))).await
}
#[tauri::command]
pub async fn mailbox_connect(
    app: AppHandle,
    email: String,
    secret: String,
    config: Option<ConnectionConfig>,
) -> Result<()> {
    archive_worker(app.clone(), move |state| save(state, email, secret, config)).await?;
    let _ = app.emit("mailbox-changed", ());
    Ok(())
}
#[tauri::command]
pub async fn mailbox_delete(app: AppHandle, id: String) -> Result<()> {
    archive_worker(app.clone(), move |state| delete(state, &id)).await?;
    let _ = app.emit("mailbox-changed", ());
    Ok(())
}
#[tauri::command]
pub async fn mailbox_pause(app: AppHandle, id: String, paused: bool) -> Result<()> {
    archive_worker(app.clone(), move |state| {
        mapped(database(state)?.pause(&id, paused))
    })
    .await?;
    let _ = app.emit("mailbox-changed", ());
    Ok(())
}
#[tauri::command]
pub async fn mailbox_check(app: AppHandle) -> Result<CheckReport> {
    let report = archive_worker(app.clone(), move |state| check(state, true)).await?;
    let _ = app.emit("mailbox-changed", ());
    Ok(report)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreReport {
    pub ignored: u32,
    pub unchanged: u32,
}
#[tauri::command]
pub async fn mailbox_ignore(app: AppHandle, ids: Vec<String>) -> Result<IgnoreReport> {
    if ids.len() > 2000 {
        return Err(fail(Error::TooLarge));
    }
    let requested = ids.len() as u32;
    let ignored = archive_worker(app.clone(), move |state| {
        with_store(state, |store| {
            mapped(database(state)?.finish(&store.identity().archive_id, &ids, true))
        })
    })
    .await?;
    let _ = app.emit("mailbox-changed", ());
    Ok(IgnoreReport {
        ignored,
        unchanged: requested.saturating_sub(ignored),
    })
}
#[tauri::command]
pub async fn mailbox_confirm(app: AppHandle, ids: Vec<String>) -> Result<ConfirmReport> {
    if ids.len() > 100 {
        return Err(fail(Error::TooLarge));
    }
    let report = archive_worker(app.clone(), move |state| {
        let expected = identity(state)?;
        let db = database(state)?;
        Ok(tauri::async_runtime::block_on(confirm_many(
            state, &db, &expected, ids,
        )))
    })
    .await?;
    let _ = app.emit("mailbox-changed", ());
    Ok(report)
}
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut startup = true;
        loop {
            let force = startup;
            let result = archive_worker(app.clone(), move |state| {
                if state
                    .quit_guard
                    .lock()
                    .map_err(|_| fail(Error::Storage))?
                    .is_some()
                {
                    return Ok(true);
                }
                check(state, force).map(|_| false)
            })
            .await;
            if matches!(result, Ok(true)) {
                break;
            }
            startup = false;
            // Only safe state is emitted; no mail headers, credentials or server text.
            if matches!(result, Ok(false)) {
                let _ = app.emit("mailbox-changed", ());
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_credentials::{CredentialStore, MemoryStore, UnavailableStore};
    #[test]
    fn custom_school_settings_and_os_credentials_keep_the_same_account_on_update() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        let creds = MemoryStore::default();
        let mut config = ConnectionConfig {
            host: "mail.school.example".into(),
            port: 993,
            encryption: mailbox_sync::Encryption::Tls,
            username: "shortname".into(),
            send_id: false,
        };
        persist_configured_account(&db, &creds, "a@school.example", "first-secret", &config)
            .unwrap();
        let original = db.accounts().unwrap().remove(0);
        config.username = "a@school.example".into();
        persist_configured_account(&db, &creds, "a@school.example", "updated-secret", &config)
            .unwrap();
        let updated = db.accounts().unwrap().remove(0);
        assert_eq!(original.id, updated.id);
        assert_eq!(updated.connection, config);
        assert_eq!(
            creds.get_key(&updated.credential_id()).unwrap().as_deref(),
            Some("updated-secret")
        );
        let bytes = std::fs::read(dir.path().join("mailboxes.sqlite")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("secret"));
    }
    #[test]
    fn manual_check_returns_network_failure_and_continues_other_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path()).unwrap();
        db.save_account("a", "a@qq.com").unwrap();
        db.save_account("b", "b@163.com").unwrap();
        db.commit_scan(
            "archive",
            "a",
            "INBOX",
            Cursor {
                validity: 1,
                uid: 7,
            },
            &[],
        )
        .unwrap();
        let accounts = db.accounts().unwrap();
        let mut visited = Vec::new();
        let report = run_checks(&mut db, accounts, true, 0, |_, account| {
            visited.push(account.id.clone());
            if account.id == "a" {
                Err(CommandError {
                    code: fail(Error::Network).code,
                    message: "unsafe raw server text and synthetic secret".into(),
                })
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(visited, vec!["a", "b"]);
        assert_eq!(report.checked_accounts, 2);
        assert_eq!(report.succeeded_accounts, 1);
        assert_eq!(report.failed_accounts.len(), 1);
        assert_eq!(report.failed_accounts[0].account_id, "a");
        assert_eq!(
            report.failed_accounts[0].message,
            fail(Error::Network).message
        );
        assert!(!report.failed_accounts[0].paused);
        assert_eq!(
            db.cursor("archive", "a", "INBOX").unwrap(),
            Some(Cursor {
                validity: 1,
                uid: 7
            })
        );
        let wire = serde_json::to_string(&report).unwrap();
        assert!(
            !wire.contains("unsafe raw")
                && !wire.contains("synthetic secret")
                && !wire.contains("a@qq.com")
        );
    }
    #[test]
    fn manual_check_reports_paused_accounts_without_resuming_or_attempting_network() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path()).unwrap();
        db.save_account("a", "a@qq.com").unwrap();
        for _ in 0..3 {
            db.failure("a", Error::Network, 0).unwrap();
        }
        let accounts = db.accounts().unwrap();
        let report = run_checks(&mut db, accounts, true, i64::MAX, |_, _| {
            panic!("paused mailbox must not connect")
        })
        .unwrap();
        assert_eq!(report.checked_accounts, 0);
        assert_eq!(report.succeeded_accounts, 0);
        assert_eq!(report.skipped_paused, 1);
        assert!(report.failed_accounts.is_empty());
        assert!(db.account("a").unwrap().paused);
    }
    #[test]
    fn third_failure_reports_the_new_automatic_pause_and_success_clears_old_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path()).unwrap();
        db.save_account("a", "a@qq.com").unwrap();
        for _ in 0..2 {
            db.failure("a", Error::Network, 0).unwrap();
        }
        let accounts = db.accounts().unwrap();
        let report =
            run_checks(&mut db, accounts, true, 0, |_, _| Err(fail(Error::Network))).unwrap();
        assert_eq!(report.skipped_paused, 0);
        assert!(report.failed_accounts[0].paused);
        assert_eq!(db.account("a").unwrap().failures, 3);
        db.pause("a", false).unwrap();
        let accounts = db.accounts().unwrap();
        let report = run_checks(&mut db, accounts, true, 0, |_, _| Ok(())).unwrap();
        assert_eq!(report.succeeded_accounts, 1);
        assert!(report.failed_accounts.is_empty());
        assert!(db.account("a").unwrap().last_error.is_none());
    }
    #[test]
    fn scheduled_checks_do_not_report_success_for_accounts_that_are_not_due() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path()).unwrap();
        db.save_account("a", "a@qq.com").unwrap();
        db.success("a", 100).unwrap();
        let accounts = db.accounts().unwrap();
        let report = run_checks(&mut db, accounts, false, 200, |_, _| panic!("not due")).unwrap();
        assert_eq!(report.checked_accounts, 0);
        assert_eq!(report.succeeded_accounts, 0);
        assert_eq!(report.skipped_paused, 0);
    }
    #[test]
    fn credential_failure_never_persists_an_active_account() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        assert!(persist_account(
            &db,
            &UnavailableStore("locked".into()),
            "a@qq.com",
            "synthetic-secret"
        )
        .is_err());
        assert!(db.accounts().unwrap().is_empty());
    }
    #[test]
    fn account_write_failure_rolls_back_the_previous_os_credential() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        db.save_account("account", "a@qq.com").unwrap();
        let creds = MemoryStore::default();
        creds.set_key("mailbox:account", "old-secret").unwrap();
        let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
        sql.execute_batch("CREATE TRIGGER fail_account BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT,'disk'); END;").unwrap();
        assert!(persist_account(&db, &creds, "a@qq.com", "new-secret").is_err());
        assert_eq!(
            creds.get_key("mailbox:account").unwrap().as_deref(),
            Some("old-secret")
        );
        let all = serde_json::to_string(&db.accounts().unwrap()).unwrap();
        assert!(!all.contains("old-secret") && !all.contains("new-secret"));
    }
    #[test]
    fn account_credentials_are_separate_from_ai_and_updates_keep_the_mailbox_id() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        let creds = MemoryStore::default();
        creds.set_key("provider", "ai-secret").unwrap();
        persist_account(&db, &creds, "a@163.com", "mail-secret").unwrap();
        let first = db.accounts().unwrap().remove(0);
        persist_account(&db, &creds, "a@163.com", "updated-secret").unwrap();
        let updated = db.accounts().unwrap().remove(0);
        assert_eq!(first.id, updated.id);
        assert_eq!(
            creds.get_key(&updated.credential_id()).unwrap().as_deref(),
            Some("updated-secret")
        );
        assert_eq!(
            creds.get_key("provider").unwrap().as_deref(),
            Some("ai-secret")
        );
    }
    fn mail() -> Vec<u8> {
        b"From: hr@example.com\r\nSubject: Interview\r\nDate: Sat, 24 Oct 2026 12:00:00 +0800\r\n\r\nInterview details.".to_vec()
    }
    #[test]
    fn crash_between_import_and_candidate_completion_is_idempotent_even_without_message_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Database::open(dir.path()).unwrap();
        db.save_account("account", "a@qq.com").unwrap();
        let store = crate::commands::open_store(
            &dir.path().join("archive"),
            &dir.path().join("current.json"),
        )
        .unwrap();
        let identity = store.identity();
        let bytes = mail();
        db.commit_scan(
            &identity.archive_id,
            "account",
            "INBOX",
            Cursor {
                validity: 1,
                uid: 2,
            },
            &[(2, Header::parse(&bytes), vec!["Interview".into()])],
        )
        .unwrap();
        let id = db.pending(&identity.archive_id, 100).unwrap().remove(0).id;
        let sql = rusqlite::Connection::open(dir.path().join("mailboxes.sqlite")).unwrap();
        sql.execute_batch("CREATE TRIGGER fail_finish BEFORE UPDATE OF state ON candidates BEGIN SELECT RAISE(ABORT,'disk'); END;").unwrap();
        assert!(persist_confirmed(&store, &db, &identity, &id, &bytes).is_err());
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
        assert_eq!(db.pending_count(&identity.archive_id).unwrap(), 1);
        sql.execute_batch("DROP TRIGGER fail_finish;").unwrap();
        assert!(persist_confirmed(&store, &db, &identity, &id, &bytes).unwrap());
        assert_eq!(store.list_evidence(None).unwrap().len(), 1);
        assert_eq!(store.list_inbox_events().unwrap().len(), 1);
        assert_eq!(db.pending_count(&identity.archive_id).unwrap(), 0);
    }
    #[test]
    fn a_restore_during_download_cannot_write_into_the_new_current_archive() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(dir.path()).unwrap();
        let store = crate::commands::open_store(
            &dir.path().join("archive"),
            &dir.path().join("current.json"),
        )
        .unwrap();
        let mut before = store.identity();
        before.restore_epoch = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            persist_confirmed(&store, &db, &before, "unused", &mail())
                .unwrap_err()
                .code,
            fail(Error::Changed).code
        );
        assert!(store.list_evidence(None).unwrap().is_empty());
        assert!(!store.archive_dir().join("attachments").exists());
    }
    #[test]
    fn local_mailbox_state_does_not_leak_into_archive_backups_or_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        let paths =
            data_service::HostPaths::from_roots(dir.path().into(), dir.path().join("cache"));
        paths.ensure_layout().unwrap();
        let mut db = Database::open(dir.path()).unwrap();
        db.save_account("account", "private@qq.com").unwrap();
        let store =
            crate::commands::open_store(&paths.archive_dir, &paths.current_pointer).unwrap();
        db.commit_scan(
            &store.identity().archive_id,
            "account",
            "INBOX",
            Cursor {
                validity: 1,
                uid: 2,
            },
            &[(2, Header::parse(&mail()), vec!["Interview".into()])],
        )
        .unwrap();
        let output = dir.path().join("backup.zip");
        let export = crate::restore::RestorePaths {
            data_root: paths.data_root.clone(),
            archive_dir: paths.archive_dir.clone(),
            current_pointer: paths.current_pointer.clone(),
            archives_retired_dir: paths.archives_retired_dir.clone(),
            settings_file: paths.settings_file.clone(),
        };
        crate::restore::export_archive(&store, &export, &output, "2026-10-24T00:00:00Z").unwrap();
        assert!(backup::read_manifest(&output)
            .unwrap()
            .entries
            .iter()
            .all(|e| !e.path.contains("mailbox")));
        let diagnostics = data_service::diagnostics_from(&paths, true, &[]).to_string();
        assert!(!diagnostics.contains("private@qq.com") && !diagnostics.contains("Interview"));
    }
}

#[tauri::command]
pub async fn mailbox_discover(email: String) -> Result<mailbox_sync::discovery::Discovery> {
    mapped(mailbox_sync::discovery::discover(&email).await)
}

#[tauri::command]
pub async fn mailbox_open_help(app: AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    if !mailbox_sync::discovery::HELP_URLS.contains(&url.as_str()) {
        return Err(fail(Error::Configuration));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| fail(Error::Network))
}
