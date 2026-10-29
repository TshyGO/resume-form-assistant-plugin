use super::*;
use crate::ai_credentials::{CredentialError, MemoryStore, UnavailableStore};
use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
const CLIENT: &str = "12345678-1234-4321-9876-123456789abc";
const AT: i64 = 1_800_000_000;
fn tokens(principal: &str, expires_at: i64) -> Tokens {
    Tokens {
        version: 1,
        client_id: CLIENT.into(),
        principal: principal.into(),
        access_token: "synthetic-access".into(),
        refresh_token: "synthetic-refresh".into(),
        expires_at,
    }
}
fn response() -> String {
    serde_json::json!({"access_token":"new-access","refresh_token":"rotated-refresh","expires_in":3600,"token_type":"Bearer","scope":"Mail.Read User.Read"}).to_string()
}
fn fixture() -> (tempfile::TempDir, Database, MemoryStore, Account) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let creds = MemoryStore::default();
    let account = persist(
        &db,
        &creds,
        "person@outlook.com",
        &tokens("graph:stable", AT),
        None,
    )
    .unwrap();
    (dir, db, creds, account)
}

// Bound real HTTP requests through production reqwest/form/JSON code. Responses
// never contact Microsoft, and request bodies contain only synthetic credentials.
async fn server(replies: Vec<(u16, String)>) -> (Http, tokio::task::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(header_end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..header_end]);
                    let len = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + len {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let reply = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(reply.as_bytes()).await.unwrap();
        }
        requests
    });
    let mut http = Http::new().unwrap();
    http.client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    http.token_url = format!("{url}/token");
    http.profile_url = format!("{url}/me?$select=id,mail,userPrincipalName");
    (http, task)
}
fn free_redirect() -> String {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    format!(
        "http://{}/microsoft/callback",
        listener.local_addr().unwrap()
    )
}
fn browser_callback(url: String) -> Result<()> {
    let url = Url::parse(&url).unwrap();
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
    let mut callback = Url::parse(&query["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &query["state"])
        .append_pair("code", "synthetic-code");
    tokio::spawn(async move {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(callback)
            .send()
            .await
            .unwrap();
    });
    Ok(())
}

#[test]
fn public_client_configuration_and_pkce_are_strict() {
    for input in [
        None,
        Some(""),
        Some("secret"),
        Some("00000000-0000-0000-0000-000000000000"),
    ] {
        assert_eq!(validate_client_id(input), Err(AuthError::Configuration));
    }
    assert_eq!(validate_client_id(Some(CLIENT)).unwrap(), CLIENT);
    // RFC 7636 Appendix B's S256 example.
    assert_eq!(
        base64url(&Sha256::digest(
            b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        )),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let auth = Authorization::new(REDIRECT).unwrap();
    let query: HashMap<_, _> = Url::parse(&auth.url(CLIENT))
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["response_mode"], "query");
    assert!(!query.contains_key("client_secret"));
    assert!(!SCOPES.contains("Write") && !SCOPES.contains("Send"));
    assert_eq!(
        query["code_challenge"],
        base64url(&Sha256::digest(auth.verifier.as_bytes()))
    );
    assert_ne!(auth.state, Authorization::new(REDIRECT).unwrap().state);
}
#[test]
fn callback_rejects_wrong_state_path_duplicates_and_mixed_results() {
    let auth = Authorization::new(REDIRECT).unwrap();
    for target in [
        "/microsoft/callback?code=x".into(),
        "/microsoft/callback?state=wrong&code=x".into(),
        format!("/elsewhere?state={}&code=x", auth.state),
        format!(
            "//evil.invalid/microsoft/callback?state={}&code=x",
            auth.state
        ),
        format!(
            "/microsoft/callback?state={}&state={}&code=x",
            auth.state, auth.state
        ),
        format!("/microsoft/callback?state={}&code=x&code=y", auth.state),
        format!(
            "/microsoft/callback?state={}&code=x&error=access_denied",
            auth.state
        ),
    ] {
        assert_eq!(auth.callback(&target), Err(AuthError::Callback));
    }
    assert_eq!(
        auth.callback(&format!(
            "/\\evil.invalid/microsoft/callback?state={}&code=x",
            auth.state
        )),
        Err(AuthError::Callback)
    );
    assert_eq!(
        auth.callback(&format!(
            "/microsoft/callback?state={}&error=access_denied",
            auth.state
        )),
        Err(AuthError::Denied)
    );
    assert_eq!(auth.callback(&format!("/microsoft/callback?state={}&error=access_denied&error_description=AADSTS53003%20synthetic-secret",auth.state)), Err(AuthError::Policy));
    assert_eq!(
        auth.callback(&format!(
            "/microsoft/callback?state={}&code=good",
            auth.state
        ))
        .unwrap(),
        "good"
    );
}
#[tokio::test]
async fn loopback_ignores_bad_host_wrong_state_and_supports_cancellation() {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let auth = Authorization::new(&format!(
        "http://{}/microsoft/callback",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let state = auth.state.clone();
    let addr = listener.local_addr().unwrap();
    let read = tokio::spawn(async move { receive_code(&listener, &auth).await });
    for host in ["evil.invalid".to_string(), addr.to_string()] {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request = format!(
            "GET /microsoft/callback?state=wrong&code=bad HTTP/1.1\r\nHost: {host}\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut body = String::new();
        stream.read_to_string(&mut body).await.unwrap();
        assert!(body.starts_with("HTTP/1.1 400"));
        assert!(!read.is_finished());
    }
    let url = format!("http://{addr}/microsoft/callback?state={state}&code=good");
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let response = client.get(&url).send().await.unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(read.await.unwrap().unwrap(), "good");
    let cancellation = Arc::new(LoginCancellation::default());
    let worker = cancellation.clone();
    let task = tokio::spawn(async move { worker.run(std::future::pending::<Result<()>>()).await });
    cancellation.cancel();
    assert_eq!(task.await.unwrap(), Err(AuthError::Cancelled));
}
#[tokio::test]
async fn login_exchanges_code_reads_only_identity_and_recovers_from_vault_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let creds = MemoryStore::default();
    let (http, request_task) = server(vec![
        (200, response()),
        (
            200,
            serde_json::json!({"id":"stable","mail":"person@outlook.com"}).to_string(),
        ),
    ])
    .await;
    connect_with(
        &db,
        &creds,
        &LoginCancellation::default(),
        None,
        browser_callback,
        CLIENT,
        &free_redirect(),
        &http,
    )
    .await
    .unwrap();
    let account = db.accounts().unwrap().remove(0);
    assert_eq!(account.source_account_id.as_deref(), Some("graph:stable"));
    drop(db);
    let restarted = Database::open(dir.path()).unwrap();
    let restored = read_tokens(&creds, &restarted.account(&account.id).unwrap(), CLIENT).unwrap();
    assert_eq!(restored.refresh_token, "rotated-refresh");
    let requests = request_task.await.unwrap();
    assert!(requests[0].starts_with("POST /token"));
    assert!(requests[0].contains("code_verifier=") && !requests[0].contains("client_secret"));
    assert!(requests[1].starts_with("GET /me?$select=id,mail,userPrincipalName"));
    assert!(!requests.iter().any(|r| r.contains("/messages")));
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let bytes = std::fs::read(path).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(!text.contains("new-access") && !text.contains("rotated-refresh"));
        }
    }
}
#[tokio::test]
async fn denied_or_cancelled_login_never_registers_an_account() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let creds = MemoryStore::default();
    let http = Http::new().unwrap();
    let denied = |url: String| {
        let url = Url::parse(&url).unwrap();
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        let mut target = Url::parse(&q["redirect_uri"]).unwrap();
        target
            .query_pairs_mut()
            .append_pair("state", &q["state"])
            .append_pair("error", "access_denied");
        tokio::spawn(async move {
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(target)
                .send()
                .await
                .unwrap();
        });
        Ok(())
    };
    assert_eq!(
        connect_with(
            &db,
            &creds,
            &LoginCancellation::default(),
            None,
            denied,
            CLIENT,
            &free_redirect(),
            &http
        )
        .await,
        Err(AuthError::Denied)
    );
    let cancelled = LoginCancellation::default();
    cancelled.cancel();
    assert_eq!(
        connect_with(
            &db,
            &creds,
            &cancelled,
            None,
            |_| panic!("must not open a browser"),
            CLIENT,
            &free_redirect(),
            &http
        )
        .await,
        Err(AuthError::Cancelled)
    );
    assert!(db.accounts().unwrap().is_empty());
}
#[tokio::test]
async fn refresh_rotates_tokens_and_subsequent_calls_reuse_the_saved_access_token() {
    let (_dir, db, creds, account) = fixture();
    let (http, task) = server(vec![(200, response())]).await;
    assert_eq!(
        refresh(&db, &creds, &account, CLIENT, &http, AT)
            .await
            .unwrap(),
        "new-access"
    );
    let stored = read_tokens(&creds, &account, CLIENT).unwrap();
    assert_eq!(stored.refresh_token, "rotated-refresh");
    assert_eq!(
        refresh(&db, &creds, &account, CLIENT, &http, AT + 1)
            .await
            .unwrap(),
        "new-access"
    );
    let requests = task.await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("refresh_token=synthetic-refresh"));
    let (http,task)=server(vec![(200,serde_json::json!({"access_token":"third-access","expires_in":3600,"token_type":"Bearer","scope":"Mail.Read User.Read"}).to_string())]).await;
    refresh(&db, &creds, &account, CLIENT, &http, AT + 3600)
        .await
        .unwrap();
    assert!(task.await.unwrap()[0].contains("refresh_token=rotated-refresh"));
    assert_eq!(
        read_tokens(&creds, &account, CLIENT).unwrap().refresh_token,
        "rotated-refresh"
    );
}
#[tokio::test]
async fn revoked_authorization_pauses_without_browser_or_raw_server_details() {
    let (_dir, db, creds, account) = fixture();
    let (http, task) = server(vec![(
        400,
        serde_json::json!({"error":"invalid_grant","error_description":"synthetic-secret"})
            .to_string(),
    )])
    .await;
    let error = refresh(&db, &creds, &account, CLIENT, &http, AT)
        .await
        .err()
        .unwrap();
    assert_eq!(error, AuthError::Reauthorize);
    assert!(!error.command().message.contains("synthetic-secret"));
    assert!(db.account(&account.id).unwrap().paused);
    task.await.unwrap();
    let (http,task)=server(vec![(400,serde_json::json!({"error":"access_denied","error_codes":[53003],"error_description":"synthetic-secret"}).to_string())]).await;
    assert_eq!(http.token(&[]).await.err(), Some(AuthError::Policy));
    task.await.unwrap();
}
#[test]
fn identity_aliases_reauthorization_and_vault_failures_preserve_the_original_connection() {
    let (_dir, db, creds, account) = fixture();
    let same = persist(
        &db,
        &creds,
        "alias@outlook.com",
        &tokens("graph:stable", AT),
        Some(&account.id),
    )
    .unwrap();
    assert_eq!(same.id, account.id);
    assert_eq!(
        persist(
            &db,
            &creds,
            "other@outlook.com",
            &tokens("graph:other", AT),
            Some(&account.id)
        )
        .err(),
        Some(AuthError::Identity)
    );
    assert_eq!(db.accounts().unwrap().len(), 1);
    assert!(read_tokens(&creds, &same, "different-client").is_err());
    assert_eq!(
        persist(
            &db,
            &UnavailableStore("synthetic-secret".into()),
            "third@outlook.com",
            &tokens("graph:third", AT),
            None
        )
        .err(),
        Some(AuthError::Credentials)
    );
    assert_eq!(db.accounts().unwrap().len(), 1);
    let _other = persist(
        &db,
        &creds,
        "alias@outlook.com",
        &tokens("graph:other", AT),
        None,
    )
    .unwrap();
    assert_eq!(db.accounts().unwrap().len(), 2); // Display email is not identity.
}
#[test]
fn login_registry_is_exclusive_and_cancellation_cannot_undo_a_committed_login() {
    let registry = MicrosoftAuth::default();
    let attempt = registry.begin().unwrap();
    assert!(registry.begin().is_err());
    registry.cancel().unwrap();
    assert_eq!(attempt.check(), Err(AuthError::Cancelled));
    registry.end(&attempt);
    let fresh = registry.begin().unwrap();
    registry.end(&attempt);
    assert!(registry.begin().is_err());
    fresh.finish(|| Ok(())).unwrap();
    registry.cancel().unwrap();
    assert!(fresh.check().is_ok());
    registry.end(&fresh);
}

// Native-sized fake catches Windows' UTF-16 password limit on every platform.
#[derive(Default)]
struct SizedVault {
    keys: Mutex<HashMap<String, String>>,
    sets: AtomicUsize,
    fail_at: AtomicUsize,
}
impl CredentialStore for SizedVault {
    fn set_key(&self, id: &str, key: &str) -> std::result::Result<(), CredentialError> {
        let n = self.sets.fetch_add(1, Ordering::SeqCst) + 1;
        if key.encode_utf16().count() * 2 > 2560 || self.fail_at.load(Ordering::SeqCst) == n {
            return Err(CredentialError::Unavailable("synthetic failure".into()));
        }
        self.keys.lock().unwrap().insert(id.into(), key.into());
        Ok(())
    }
    fn get_key(&self, id: &str) -> std::result::Result<Option<String>, CredentialError> {
        Ok(self.keys.lock().unwrap().get(id).cloned())
    }
    fn clear_key(&self, id: &str) -> std::result::Result<(), CredentialError> {
        self.keys.lock().unwrap().remove(id);
        Ok(())
    }
    fn get_legacy_key(&self) -> std::result::Result<Option<String>, CredentialError> {
        Ok(None)
    }
    fn clear_legacy_key(&self) -> std::result::Result<(), CredentialError> {
        Ok(())
    }
}
#[test]
fn large_tokens_rotate_atomically_in_native_sized_vault_entries_and_disconnect_clears_them() {
    use crate::microsoft_credentials as vault;
    let store = SizedVault::default();
    let secret = "synthetic-long-令牌".repeat(1000);
    vault::replace(&store, "mailbox:a", &secret, || Ok(())).unwrap();
    assert_eq!(
        vault::read(&store, "mailbox:a").unwrap(),
        Some(secret.clone())
    );
    let first_keys = store.keys.lock().unwrap().len();
    assert!(first_keys > 5);
    assert_eq!(
        vault::replace(&store, "mailbox:a", "replacement", || Err::<(), _>(
            AuthError::Storage
        )),
        Err(AuthError::Storage)
    );
    assert_eq!(
        vault::read(&store, "mailbox:a").unwrap(),
        Some(secret.clone())
    );
    store
        .fail_at
        .store(store.sets.load(Ordering::SeqCst) + 2, Ordering::SeqCst);
    assert_eq!(
        vault::replace(&store, "mailbox:a", &secret, || Ok(())),
        Err(AuthError::Credentials)
    );
    assert_eq!(vault::read(&store, "mailbox:a").unwrap(), Some(secret));
    vault::replace(&store, "mailbox:a", "replacement", || Ok(())).unwrap();
    assert_eq!(store.keys.lock().unwrap().len(), 2);
    vault::clear(&store, "mailbox:a").unwrap();
    assert!(store.keys.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_production_refreshes_use_one_exchange_and_keep_mail_scan_time_unchanged() {
    let (dir, db, creds, account) = fixture();
    let auth = Arc::new(MicrosoftAuth::default());
    let creds = Arc::new(creds);
    let (http, task) = server(vec![(200, response())]).await;
    let mut workers = Vec::new();
    for _ in 0..4 {
        let root = dir.path().to_owned();
        let auth = auth.clone();
        let creds = creds.clone();
        let id = account.id.clone();
        let http = Http {
            client: http.client.clone(),
            token_url: http.token_url.clone(),
            profile_url: http.profile_url.clone(),
        };
        workers.push(tokio::task::spawn_blocking(move || {
            let db = Database::open(&root).unwrap();
            token_for_account(&auth, &db, creds.as_ref(), &id, CLIENT, &http, AT)
        }));
    }
    for worker in workers {
        assert_eq!(worker.await.unwrap().unwrap(), "new-access");
    }
    assert_eq!(task.await.unwrap().len(), 1);
    assert_eq!(db.account(&account.id).unwrap().last_checked, None);
}

#[tokio::test]
async fn login_vault_write_failure_never_saves_the_new_account() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let store = SizedVault::default();
    store.fail_at.store(2, Ordering::SeqCst);
    let (http, task) = server(vec![
        (200, response()),
        (
            200,
            "{\"id\":\"stable\",\"mail\":\"person@outlook.com\"}".into(),
        ),
    ])
    .await;
    assert_eq!(
        connect_with(
            &db,
            &store,
            &LoginCancellation::default(),
            None,
            browser_callback,
            CLIENT,
            &free_redirect(),
            &http
        )
        .await,
        Err(AuthError::Credentials)
    );
    assert!(db.accounts().unwrap().is_empty());
    assert!(store.keys.lock().unwrap().is_empty());
    task.await.unwrap();
}

#[tokio::test]
async fn cancelling_in_progress_login_releases_listener_and_does_not_save_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let creds = MemoryStore::default();
    let attempt = LoginCancellation::default();
    let redirect = free_redirect();
    let http = Http::new().unwrap();
    assert_eq!(
        connect_with(
            &db,
            &creds,
            &attempt,
            None,
            |_| {
                attempt.cancel();
                Ok(())
            },
            CLIENT,
            &redirect,
            &http
        )
        .await,
        Err(AuthError::Cancelled)
    );
    assert!(db.accounts().unwrap().is_empty());
    let url = Url::parse(&redirect).unwrap();
    assert!(
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, url.port().unwrap()))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn malformed_and_write_only_permissions_are_rejected_without_credential_mutation() {
    let (_dir, db, creds, account) = fixture();
    let raw = crate::microsoft_credentials::read(&creds, &account.credential_id()).unwrap();
    let (http,task)=server(vec![(200,serde_json::json!({"access_token":"bad","refresh_token":"bad","expires_in":3600,"token_type":"Bearer","scope":"Mail.ReadWrite User.Read"}).to_string())]).await;
    assert_eq!(
        refresh(&db, &creds, &account, CLIENT, &http, AT)
            .await
            .err(),
        Some(AuthError::Protocol)
    );
    assert_eq!(
        crate::microsoft_credentials::read(&creds, &account.credential_id()).unwrap(),
        raw
    );
    task.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn abandoned_browser_times_out_without_registering_an_account() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(dir.path()).unwrap();
    let creds = MemoryStore::default();
    let http = Http::new().unwrap();
    assert_eq!(
        connect_with(
            &db,
            &creds,
            &LoginCancellation::default(),
            None,
            |_| Ok(()),
            CLIENT,
            &free_redirect(),
            &http
        )
        .await,
        Err(AuthError::Timeout)
    );
    assert!(db.accounts().unwrap().is_empty());
}
