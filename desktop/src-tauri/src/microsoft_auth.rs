//! Microsoft public-client authorization. Only safe status reaches the WebView.
//! Tokens are opaque, stored as one versioned OS credential, and never logged.
use crate::ai_credentials::CredentialStore;
use crate::commands::CommandError;
use mailbox_sync::{source::SourceKind, Account, Database};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

const AUTHORIZE: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const PROFILE: &str = "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName";
// Fixed loopback address/port must be registered as a native/public client URI.
pub const REDIRECT: &str = "http://127.0.0.1:53682/microsoft/callback";
const SCOPES: &str =
    "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);
const RESPONSE_LIMIT: usize = 128 * 1024;

type Result<T> = std::result::Result<T, AuthError>;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    Configuration,
    Busy,
    Cancelled,
    Timeout,
    Callback,
    Denied,
    Policy,
    Reauthorize,
    Credentials,
    Network,
    Protocol,
    Identity,
    Storage,
}
impl AuthError {
    pub fn command(self) -> CommandError {
        let message = match self {
            Self::Configuration => "此版本尚未配置微软登录。请联系维护者更新应用；无需自行注册开发者应用。可先从网页保存邮件或手动导入。",
            Self::Busy => "微软账号操作正在进行，请稍后重试。",
            Self::Cancelled => "已取消微软登录，未保存本次授权。",
            Self::Timeout => "微软登录已超时。请重新点击连接；也可从网页保存邮件或手动导入。",
            Self::Callback => "微软登录回调校验失败，未保存授权。请关闭登录页后重新连接。若本机回调端口被占用，请稍后重试。",
            Self::Denied => "未获得微软读取邮件的授权。你可以重新连接，或从网页保存邮件、手动导入。",
            Self::Policy => "学校或机构的管理员策略阻止了授权。请联系管理员，或从网页保存邮件、手动导入；个人账号可用不代表该组织已开放访问。",
            Self::Reauthorize => "微软授权已失效或需要重新同意。请点击重新授权；也可从网页保存邮件或手动导入。",
            Self::Credentials => "系统凭据库不可用，微软授权未能安全保存或清除。请解锁系统凭据库后重试。",
            Self::Network => "暂时无法连接微软，请检查网络后重试。不会自动打开登录窗口。",
            Self::Protocol => "微软未返回有效的账号或只读邮件授权，请重新连接。",
            Self::Identity => "本次登录的微软账号与原连接不同，原连接未更换。请使用原账号重新授权，或另行连接新账号。",
            Self::Storage => "微软账号状态未能保存，请检查本机磁盘后重试。",
        };
        CommandError {
            code: format!("MICROSOFT_{self:?}").to_ascii_uppercase(),
            message: message.into(),
        }
    }
}

#[derive(Default)]
pub struct LoginCancellation {
    cancelled: AtomicBool,
    wake: tokio::sync::Notify,
    commit: Mutex<()>,
    finished: AtomicBool,
}
impl LoginCancellation {
    fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            Err(AuthError::Cancelled)
        } else {
            Ok(())
        }
    }
    fn cancel(&self) {
        let Ok(_guard) = self.commit.lock() else {
            return;
        };
        if self.finished.load(Ordering::Acquire) {
            return;
        }
        self.cancelled.store(true, Ordering::Release);
        self.wake.notify_waiters();
    }
    fn finish<T>(&self, persist: impl FnOnce() -> Result<T>) -> Result<T> {
        let _guard = self.commit.lock().map_err(|_| AuthError::Storage)?;
        self.check()?;
        let value = persist()?;
        self.finished.store(true, Ordering::Release);
        Ok(value)
    }
    async fn run<T>(&self, future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        let notified = self.wake.notified();
        self.check()?;
        tokio::select! {
            biased;
            _ = notified => Err(AuthError::Cancelled),
            result = future => { self.check()?; result }
        }
    }
}

#[derive(Default)]
pub struct MicrosoftAuth {
    // Held on blocking workers across network + credential commit. Refreshes read
    // the latest credential after taking this lock, so rotated tokens cannot race
    // another refresh, disconnect, or reauthorization. No access-token cache.
    pub operation: Mutex<()>,
    active: Mutex<Option<Arc<LoginCancellation>>>,
}
impl MicrosoftAuth {
    pub fn begin(&self) -> Result<Arc<LoginCancellation>> {
        let mut active = self.active.lock().map_err(|_| AuthError::Busy)?;
        if active.is_some() {
            return Err(AuthError::Busy);
        }
        let attempt = Arc::new(LoginCancellation::default());
        *active = Some(attempt.clone());
        Ok(attempt)
    }
    pub fn end(&self, attempt: &Arc<LoginCancellation>) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, attempt))
            {
                *active = None;
            }
        }
    }
    pub fn cancel(&self) -> Result<()> {
        if let Some(active) = self.active.lock().map_err(|_| AuthError::Busy)?.as_ref() {
            active.cancel();
        }
        Ok(())
    }
}

pub fn client_id() -> Result<String> {
    validate_client_id(option_env!("RESUME_MICROSOFT_CLIENT_ID"))
}
fn validate_client_id(value: Option<&str>) -> Result<String> {
    let value = value.ok_or(AuthError::Configuration)?;
    let id = uuid::Uuid::parse_str(value).map_err(|_| AuthError::Configuration)?;
    if id.is_nil() {
        return Err(AuthError::Configuration);
    }
    Ok(id.to_string())
}

struct Authorization {
    state: String,
    verifier: String,
    redirect: Url,
}
fn base64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
impl Authorization {
    fn new(redirect: &str) -> Result<Self> {
        // UUID v4 draws from the platform CSPRNG. Two values provide > 240 random bits.
        Ok(Self {
            state: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            verifier: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            redirect: Url::parse(redirect).map_err(|_| AuthError::Callback)?,
        })
    }
    fn url(&self, client_id: &str) -> String {
        let mut url = Url::parse(AUTHORIZE).expect("static authorize URL");
        url.query_pairs_mut().extend_pairs([
            ("client_id", client_id),
            ("response_type", "code"),
            ("redirect_uri", self.redirect.as_str()),
            ("response_mode", "query"),
            ("scope", SCOPES),
            ("state", &self.state),
            (
                "code_challenge",
                &base64url(&Sha256::digest(self.verifier.as_bytes())),
            ),
            ("code_challenge_method", "S256"),
            ("prompt", "select_account"),
        ]);
        url.into()
    }
    fn callback(&self, target: &str) -> Result<String> {
        if !target.starts_with('/') || target.starts_with("//") || target.contains('#') {
            return Err(AuthError::Callback);
        }
        let url = self
            .redirect
            .join(target)
            .map_err(|_| AuthError::Callback)?;
        if url.origin() != self.redirect.origin() || url.path() != self.redirect.path() {
            return Err(AuthError::Callback);
        }
        let pairs: Vec<_> = url.query_pairs().collect();
        let one = |key: &str| -> Result<Option<&str>> {
            let values: Vec<_> = pairs
                .iter()
                .filter(|(k, _)| k == key)
                .map(|(_, v)| v.as_ref())
                .collect();
            if values.len() > 1 {
                return Err(AuthError::Callback);
            }
            Ok(values.first().copied())
        };
        if one("state")? != Some(self.state.as_str()) {
            return Err(AuthError::Callback);
        }
        let code = one("code")?;
        if let Some(error) = one("error")? {
            if code.is_some() {
                return Err(AuthError::Callback);
            }
            return Err(match error {
                "access_denied"
                    if one("error_description")?.is_some_and(|description| {
                        [
                            "AADSTS53003",
                            "AADSTS50105",
                            "AADSTS65001",
                            "AADSTS650052",
                            "AADSTS90094",
                        ]
                        .iter()
                        .any(|code| description.contains(code))
                    }) =>
                {
                    AuthError::Policy
                }
                "access_denied" => AuthError::Denied,
                "interaction_required" | "consent_required" | "login_required" => {
                    AuthError::Reauthorize
                }
                _ => AuthError::Protocol,
            });
        }
        let code = code
            .filter(|v| !v.is_empty() && v.len() <= 8192 && !v.chars().any(char::is_control))
            .ok_or(AuthError::Callback)?;
        Ok(code.into())
    }
}

async fn receive_code(listener: &TcpListener, auth: &Authorization) -> Result<String> {
    loop {
        let (mut stream, peer) = listener.accept().await.map_err(|_| AuthError::Callback)?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let request = tokio::time::timeout(Duration::from_secs(3), async {
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let n = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|_| AuthError::Callback)?;
                if n == 0 {
                    return Err(AuthError::Callback);
                }
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > 16384 {
                    return Err(AuthError::Callback);
                }
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| AuthError::Callback)?;
            let mut lines = text.split("\r\n");
            let mut first = lines.next().ok_or(AuthError::Callback)?.split_whitespace();
            let method = first.next().ok_or(AuthError::Callback)?;
            let target = first.next().ok_or(AuthError::Callback)?;
            if method != "GET" || first.next() != Some("HTTP/1.1") || first.next().is_some() {
                return Err(AuthError::Callback);
            }
            let hosts: Vec<_> = lines
                .filter_map(|line| line.split_once(':'))
                .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
                .collect();
            let expected_host = format!(
                "{}:{}",
                auth.redirect.host_str().unwrap_or_default(),
                auth.redirect.port_or_known_default().unwrap_or(80)
            );
            if hosts.len() != 1 || hosts[0].1.trim() != expected_host {
                return Err(AuthError::Callback);
            }
            auth.callback(target)
        })
        .await;
        let result = request.unwrap_or(Err(AuthError::Callback));
        let body = if result.is_ok() {
            "Login response received. Return to the desktop app to finish connecting."
        } else {
            "Login response rejected. Return to the desktop app."
        };
        let response = format!("HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n{body}", if result.is_ok() { "200 OK" } else { "400 Bad Request" }, body.len());
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            stream.write_all(response.as_bytes()),
        )
        .await;
        // Stray requests (favicon, stale/wrong-state callbacks) cannot consume a
        // valid pending attempt. Only a matching state can finish or reject it.
        match result {
            Err(AuthError::Callback) => continue,
            result => return result,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Tokens {
    version: u8,
    client_id: String,
    principal: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
    token_type: String,
    scope: String,
}
impl TokenResponse {
    fn into_tokens(
        self,
        client_id: &str,
        principal: String,
        previous_refresh: Option<&str>,
        now: i64,
    ) -> Result<Tokens> {
        let refresh = self
            .refresh_token
            .as_deref()
            .or(previous_refresh)
            .filter(|s| !s.is_empty())
            .ok_or(AuthError::Reauthorize)?;
        let scopes: Vec<_> = self
            .scope
            .split_whitespace()
            .map(|s| s.rsplit('/').next().unwrap_or(s).to_ascii_lowercase())
            .collect();
        if !self.token_type.eq_ignore_ascii_case("bearer")
            || self.access_token.is_empty()
            || self.expires_in < 60
            || self.expires_in > 86400
            || !scopes.iter().any(|s| s == "mail.read")
            || !scopes.iter().any(|s| s == "user.read")
        {
            return Err(AuthError::Protocol);
        }
        Ok(Tokens {
            version: 1,
            client_id: client_id.into(),
            principal,
            access_token: self.access_token,
            refresh_token: refresh.into(),
            expires_at: now.saturating_add(self.expires_in),
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    id: String,
    mail: Option<String>,
    user_principal_name: Option<String>,
}
impl Profile {
    fn identity(self) -> Result<(String, String)> {
        if self.id.is_empty()
            || self.id.len() > 256
            || self.id.trim() != self.id
            || self.id.chars().any(char::is_control)
        {
            return Err(AuthError::Protocol);
        }
        let email = self
            .mail
            .as_deref()
            .and_then(|s| mailbox_sync::config::normalize_address(s).ok())
            .or_else(|| {
                self.user_principal_name
                    .as_deref()
                    .and_then(|s| mailbox_sync::config::normalize_address(s).ok())
            })
            .ok_or(AuthError::Protocol)?;
        Ok((format!("graph:{}", self.id), email))
    }
}

struct Http {
    client: reqwest::Client,
    token_url: String,
    profile_url: String,
}
impl Http {
    fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| AuthError::Network)?,
            token_url: TOKEN.into(),
            profile_url: PROFILE.into(),
        })
    }
    async fn json<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T> {
        let mut response = request.send().await.map_err(|_| AuthError::Network)?;
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| AuthError::Network)? {
            if bytes.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
                return Err(AuthError::Protocol);
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            // Never propagate Microsoft's error_description, HTTP body or reqwest
            // error (which can contain URLs/tokens) into diagnostics or IPC.
            let error: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            let code = error.get("error").and_then(|v| v.as_str()).unwrap_or("");
            let policy = error
                .get("error_codes")
                .and_then(|v| v.as_array())
                .is_some_and(|codes| {
                    codes
                        .iter()
                        .any(|v| matches!(v.as_i64(), Some(53003 | 50105 | 65001 | 650052 | 90094)))
                });
            return Err(if status.as_u16() == 429 || status.is_server_error() {
                AuthError::Network
            } else if policy {
                AuthError::Policy
            } else {
                match code {
                    "invalid_grant"
                    | "interaction_required"
                    | "consent_required"
                    | "login_required" => AuthError::Reauthorize,
                    "access_denied" => AuthError::Denied,
                    "unauthorized_client" | "invalid_client" => AuthError::Configuration,
                    _ if status.as_u16() == 401 => AuthError::Reauthorize,
                    _ if status.as_u16() == 403 => AuthError::Policy,
                    _ => AuthError::Protocol,
                }
            });
        }
        serde_json::from_slice(&bytes).map_err(|_| AuthError::Protocol)
    }
    async fn token(&self, params: &[(&str, &str)]) -> Result<TokenResponse> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().copied())
            .finish();
        self.json(
            self.client
                .post(&self.token_url)
                .header(
                    reqwest::header::CONTENT_TYPE,
                    "application/x-www-form-urlencoded",
                )
                .body(body),
        )
        .await
    }
    async fn profile(&self, token: &str) -> Result<Profile> {
        self.json(self.client.get(&self.profile_url).bearer_auth(token))
            .await
    }
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}
fn read_tokens(creds: &dyn CredentialStore, account: &Account, client_id: &str) -> Result<Tokens> {
    if account.source != SourceKind::MicrosoftGraph {
        return Err(AuthError::Identity);
    }
    let raw = crate::microsoft_credentials::read(creds, &account.credential_id())?
        .ok_or(AuthError::Reauthorize)?;
    let tokens: Tokens = serde_json::from_str(&raw).map_err(|_| AuthError::Reauthorize)?;
    if tokens.version != 1
        || tokens.client_id != client_id
        || Some(&tokens.principal) != account.source_account_id.as_ref()
        || tokens.refresh_token.is_empty()
        || tokens.access_token.is_empty()
    {
        return Err(AuthError::Reauthorize);
    }
    Ok(tokens)
}
fn write_tokens(creds: &dyn CredentialStore, id: &str, tokens: &Tokens) -> Result<()> {
    let raw = serde_json::to_string(tokens).map_err(|_| AuthError::Credentials)?;
    crate::microsoft_credentials::replace(creds, id, &raw, || Ok(()))
}
fn persist(
    db: &Database,
    creds: &dyn CredentialStore,
    email: &str,
    tokens: &Tokens,
    expected_id: Option<&str>,
) -> Result<Account> {
    let accounts = db.accounts().map_err(|_| AuthError::Storage)?;
    let old = accounts.iter().find(|a| {
        a.source == SourceKind::MicrosoftGraph
            && a.source_account_id.as_deref() == Some(tokens.principal.as_str())
    });
    if expected_id.is_some() && old.map(|a| a.id.as_str()) != expected_id {
        return Err(AuthError::Identity);
    }
    let id = old
        .map(|a| a.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let credential_id = format!("mailbox:{id}");
    let raw = serde_json::to_string(tokens).map_err(|_| AuthError::Credentials)?;
    crate::microsoft_credentials::replace(creds, &credential_id, &raw, || {
        db.save_api_account(&id, email, SourceKind::MicrosoftGraph, &tokens.principal)
            .map_err(|_| AuthError::Storage)
    })
}

pub async fn connect(
    db: &Database,
    creds: &dyn CredentialStore,
    attempt: &LoginCancellation,
    expected_id: Option<&str>,
    open: impl FnOnce(String) -> Result<()>,
) -> Result<()> {
    let client_id = client_id()?;
    connect_with(
        db,
        creds,
        attempt,
        expected_id,
        open,
        &client_id,
        REDIRECT,
        &Http::new()?,
    )
    .await
}
#[allow(clippy::too_many_arguments)]
async fn connect_with(
    db: &Database,
    creds: &dyn CredentialStore,
    attempt: &LoginCancellation,
    expected_id: Option<&str>,
    open: impl FnOnce(String) -> Result<()>,
    client_id: &str,
    redirect: &str,
    http: &Http,
) -> Result<()> {
    // Check the target before showing a browser. The operation lock protects it
    // until credential commit; a different Microsoft identity is never substituted.
    if let Some(id) = expected_id {
        if db.account(id).map_err(|_| AuthError::Identity)?.source != SourceKind::MicrosoftGraph {
            return Err(AuthError::Identity);
        }
    }
    attempt.check()?;
    let auth = Authorization::new(redirect)?;
    let listener = TcpListener::bind((
        std::net::Ipv4Addr::LOCALHOST,
        auth.redirect.port().ok_or(AuthError::Callback)?,
    ))
    .await
    .map_err(|_| AuthError::Callback)?;
    attempt.check()?;
    open(auth.url(&client_id))?;
    let operation = async {
        let code = receive_code(&listener, &auth).await?;
        // One attempt/one code exchange. No retries of a consumed authorization code.
        let response = http
            .token(&[
                ("client_id", &client_id),
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", redirect),
                ("code_verifier", &auth.verifier),
                ("scope", SCOPES),
            ])
            .await?;
        let (principal, email) = http.profile(&response.access_token).await?.identity()?;
        let tokens = response.into_tokens(&client_id, principal, None, now())?;
        attempt.check()?;
        attempt.finish(|| persist(db, creds, &email, &tokens, expected_id))?;
        Ok(())
    };
    attempt
        .run(async {
            tokio::time::timeout(LOGIN_TIMEOUT, operation)
                .await
                .map_err(|_| AuthError::Timeout)?
        })
        .await
}

async fn refresh(
    db: &Database,
    creds: &dyn CredentialStore,
    account: &Account,
    client_id: &str,
    http: &Http,
    at: i64,
) -> Result<String> {
    let old = read_tokens(creds, account, client_id)?;
    if old.expires_at > at.saturating_add(120) {
        return Ok(old.access_token);
    }
    let response = match http
        .token(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", &old.refresh_token),
            ("scope", SCOPES),
        ])
        .await
    {
        Ok(response) => response,
        Err(error) => {
            if matches!(
                error,
                AuthError::Reauthorize | AuthError::Denied | AuthError::Policy
            ) {
                db.pause_with_error(&account.id, mailbox_sync::Error::Auth)
                    .map_err(|_| AuthError::Storage)?;
                // Keep the credential for an explicit retry/OS cleanup; never
                // reopen the browser from a background refresh failure.
            }
            return Err(error);
        }
    };
    let tokens = response.into_tokens(client_id, old.principal, Some(&old.refresh_token), at)?;
    write_tokens(creds, &account.credential_id(), &tokens)?;
    Ok(tokens.access_token)
}

/// Rust-only entry for #355. Call on a blocking worker, never return the token
/// through a command. Serialize read/refresh/write with login and disconnect.
pub fn access_token(
    state: &crate::AppState,
    id: &str,
) -> std::result::Result<String, CommandError> {
    let client_id = client_id().map_err(AuthError::command)?;
    let db =
        Database::open(&crate::ai_data_root(state)?).map_err(|_| AuthError::Storage.command())?;
    token_for_account(
        &state.microsoft_auth,
        &db,
        state.credentials.as_ref(),
        id,
        &client_id,
        &Http::new().map_err(AuthError::command)?,
        now(),
    )
    .map_err(AuthError::command)
}

fn token_for_account(
    auth: &MicrosoftAuth,
    db: &Database,
    creds: &dyn CredentialStore,
    id: &str,
    client_id: &str,
    http: &Http,
    at: i64,
) -> Result<String> {
    let _guard = auth.operation.lock().map_err(|_| AuthError::Busy)?;
    let account = db.account(id).map_err(|_| AuthError::Identity)?;
    let result = tauri::async_runtime::block_on(refresh(db, creds, &account, client_id, http, at));
    match result {
        Ok(token) => {
            db.authorization_success(id, at)
                .map_err(|_| AuthError::Storage)?;
            Ok(token)
        }
        Err(error) => {
            match error {
                AuthError::Reauthorize
                | AuthError::Denied
                | AuthError::Policy
                | AuthError::Protocol => db.pause_with_error(id, mailbox_sync::Error::Auth),
                AuthError::Credentials => db.pause_with_error(id, mailbox_sync::Error::Credentials),
                AuthError::Network => db.failure(id, mailbox_sync::Error::Network, at),
                _ => Ok(()),
            }
            .map_err(|_| AuthError::Storage)?;
            Err(error)
        }
    }
}

pub fn maintain(state: &crate::AppState) {
    // Missing release configuration is surfaced on an explicit connect. Never
    // open the browser or ask for credentials during background maintenance.
    if client_id().is_err() {
        return;
    }
    let Ok(root) = crate::ai_data_root(state) else {
        return;
    };
    let Ok(db) = Database::open(&root) else {
        return;
    };
    let Ok(accounts) = db.accounts() else {
        return;
    };
    for account in accounts
        .into_iter()
        .filter(|a| a.source == SourceKind::MicrosoftGraph && !a.paused && a.next_check <= now())
    {
        let _ = access_token(state, &account.id);
    }
}

#[cfg(test)]
#[path = "microsoft_auth_tests.rs"]
mod tests;
