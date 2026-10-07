//! Optional feedback. No archive/AI objects enter this module; automatic messages are
//! a closed vocabulary and stack locations are filtered before persistence/network.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

const ENDPOINT: &str = "https://app-feedback-relay.nebula-lab.workers.dev/feedback";
const HOUR: u64 = 3_600_000;
const DAY: u64 = 24 * HOUR;
const SAVE_ERROR: &str = "反馈设置未能保存，请重试。";
/// The explanation the user agreed to. Raise it when automatic reports start carrying something
/// the notice does not describe: earlier grants then count as undecided and the user is asked again.
const CONSENT_VERSION: u32 = 1;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Stored {
    /// `None` until the user chooses; nothing automatic is sent or kept before that.
    consent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    consent_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anonymous_id: Option<String>,
    recent: BTreeMap<String, u64>,
    hourly: Vec<u64>,
    backoff: u64,
    manual_at: Option<u64>,
}
#[derive(Serialize)]
pub struct Status {
    consent: Option<bool>,
}
#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Payload {
    app: &'static str,
    app_version: &'static str,
    os: &'static str,
    error_type: String,
    error_stack: String,
    user_description: String,
    anonymous_id: String,
    timestamp: String,
}
#[derive(Deserialize, Default)]
pub struct FrontendError {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub stack: String,
}
#[derive(Serialize)]
pub struct Preview {
    token: String,
    payload: Payload,
}
#[derive(Serialize, Debug)]
pub struct Receipt {
    pub ok: bool,
    pub id: Option<String>,
    pub reason: Option<&'static str>,
}
impl Receipt {
    fn fail(reason: &'static str) -> Self {
        Self {
            ok: false,
            id: None,
            reason: Some(reason),
        }
    }
}
struct Draft {
    token: String,
    payload: Payload,
    created: u64,
}
pub struct Reporter {
    path: PathBuf,
    state: Mutex<Stored>,
    draft: Mutex<Option<Draft>>,
    changes: tokio::sync::watch::Sender<u64>,
    enabled: Arc<AtomicBool>,
    #[cfg(test)]
    endpoint: String,
    #[cfg(test)]
    timeout: Duration,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn limited(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

pub fn redact(value: &str) -> String {
    // Reuse the existing path/credential protection, then cover all supported OSes,
    // including paths copied from a different user's computer.
    let mut text = limited(value, 4000);
    for (pattern, replacement) in [
        (
            r"(?i)(?:[a-z]:[\\/]Users[\\/]|/(?:Users|home)/)[^\s\\/]+",
            "[用户目录]",
        ),
        (
            r"(?i)(?:(?:Bearer|Basic)\s+\S+|(?:sk|oc_sk|key|token)[-_][A-Za-z0-9_-]{8,})",
            "[凭据]",
        ),
        (
            r"(?im)^\s*(?:cookie|set-cookie|authorization)\s*:\s*[^\n]*",
            "[敏感请求头]",
        ),
        (
            r#"(?i)["']?(?:api[-_ ]?key|authorization|cookie|password|secret|(?:auth|access|refresh|id)[-_ ]?token|token|密码|姓名|联系人)["']?\s*[:=：]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n;；,}]+)"#,
            "[敏感信息]",
        ),
        (
            r"(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})",
            "[凭据]",
        ),
        (r#"(?i)https?://[^\s<>"'）)]+"#, "[网址]"),
        (r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[邮箱]"),
        (
            r"[0-9０-９](?:[\s().+_（）．＋－-]*[0-9０-９]){4,}[xX]?",
            "[数字]",
        ),
    ] {
        if let Ok(re) = regex::Regex::new(pattern) {
            text = re.replace_all(&text, replacement).into_owned();
        }
    }
    let chars: Vec<char> = text.chars().take(1400).collect();
    chars
        .chunks(500)
        .map(|part| data_service::redact_path(&part.iter().collect::<String>(), &[]))
        .collect()
}

fn error_name(value: &str) -> &str {
    match value {
        "TypeError" | "ReferenceError" | "SyntaxError" | "RangeError" | "URIError"
        | "EvalError" | "AggregateError" | "panic" => value,
        _ => "Error",
    }
}
fn stack_locations(value: &str) -> String {
    // Accept only the app's own assets/source frames, not arbitrary local or web URLs,
    // function names, exception messages, component props or request text.
    let re = regex::Regex::new(r"(?:tauri://localhost/|https?://tauri\.localhost/|http://(?:localhost|127\.0\.0\.1):1420/)((?:assets|src)/[A-Za-z0-9_./-]+\.(?:js|tsx?|jsx)):(\d{1,6}):(\d{1,6})(?:\)|\s|$)").expect("constant regex");
    let raw = limited(value, 20000);
    re.captures_iter(&raw)
        .take(20)
        .map(|m| format!("{}:{}:{}", &m[1], &m[2], &m[3]))
        .collect::<Vec<_>>()
        .join("\n")
}
fn own_panic_location(file: &str, line: u32, column: u32) -> String {
    let normalized = file.replace('\\', "/");
    let manifest = env!("CARGO_MANIFEST_DIR").replace('\\', "/");
    let desktop = manifest.strip_suffix("/src-tauri").unwrap_or(&manifest);
    let own = normalized
        .strip_prefix(&format!("{manifest}/"))
        .or_else(|| normalized.strip_prefix(&format!("{desktop}/")))
        .or_else(|| normalized.strip_prefix("../"))
        .unwrap_or(&normalized);
    if !(own.starts_with("src/") || own.starts_with("crates/"))
        || !own.ends_with(".rs")
        || own.split('/').any(|part| part == "..")
        || !own
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_/.-".contains(&b))
    {
        return String::new();
    }
    format!("{own}:{line}:{column}")
}

fn payload(kind: &str, stack: String, description: String, id: String) -> Payload {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let version = env!("CARGO_PKG_VERSION");
    Payload {
        app: "resume-form-assistant-desktop",
        app_version: version,
        os,
        error_type: kind.into(),
        error_stack: stack,
        user_description: format!(
            "{}{}--- 诊断信息 ---\n版本: {version} / 系统: {os}",
            description,
            if description.is_empty() { "" } else { "\n" }
        ),
        anonymous_id: id,
        timestamp: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default(),
    }
}

impl Reporter {
    pub fn new(root: PathBuf) -> Arc<Self> {
        let path = root.join("feedback-state.json");
        let loaded: Option<Stored> = match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 65536 => serde_json::from_slice(&bytes).ok(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(Stored::default()),
            _ => None,
        };
        // A missing file is a new installation: undecided, and nothing is written until the user
        // chooses. Corrupt/unreadable files fail closed as declined, so a lost opt-out stays off.
        let mut state = loaded.unwrap_or_else(|| Stored {
            consent: Some(false),
            ..Stored::default()
        });
        // Builds before #247 wrote `consent: true` by default and their notice only folded, so a
        // grant without the current version is no grant: ask again. An opt-out is always kept.
        if state.consent == Some(true) && state.consent_version != Some(CONSENT_VERSION) {
            state.consent = None;
            state.consent_version = None;
            state.anonymous_id = None;
            // Undecided in memory either way; the next choice rewrites the file.
            let _ = Self::save_to(&path, &state);
        }
        if state.consent != Some(true) {
            state.anonymous_id = None;
        } else if state
            .anonymous_id
            .as_deref()
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .is_none()
        {
            state.anonymous_id = None;
            state.consent = Some(false);
        }
        let enabled = Arc::new(AtomicBool::new(state.consent == Some(true)));
        let (changes, _) = tokio::sync::watch::channel(0);
        Arc::new(Self {
            path,
            state: Mutex::new(state),
            draft: Mutex::new(None),
            changes,
            enabled,
            #[cfg(test)]
            endpoint: ENDPOINT.into(),
            #[cfg(test)]
            timeout: Duration::from_secs(5),
        })
    }
    fn save(&self, state: &Stored) -> Result<(), &'static str> {
        Self::save_to(&self.path, state)
    }
    fn save_to(path: &std::path::Path, state: &Stored) -> Result<(), &'static str> {
        use std::io::Write;
        let bytes = serde_json::to_vec(state).map_err(|_| SAVE_ERROR)?;
        let tmp = path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp).map_err(|_| SAVE_ERROR)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| SAVE_ERROR)?;
        std::fs::rename(tmp, path).map_err(|_| SAVE_ERROR)
    }
    pub fn status(&self) -> Result<Status, &'static str> {
        let state = self.state.lock().map_err(|_| SAVE_ERROR)?;
        Ok(Status {
            consent: state.consent,
        })
    }
    pub fn consent(&self, enabled: bool) -> Result<Status, &'static str> {
        let mut state = self.state.lock().map_err(|_| SAVE_ERROR)?;
        let mut next = state.clone();
        next.consent = Some(enabled);
        next.consent_version = enabled.then_some(CONSENT_VERSION);
        next.anonymous_id = if enabled {
            next.anonymous_id
                .or_else(|| Some(uuid::Uuid::new_v4().to_string()))
        } else {
            None
        };
        if !enabled {
            self.enabled.store(false, Ordering::Release);
            *state = next.clone();
            self.changes
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
        if let Err(error) = self.save(&next) {
            if enabled {
                return Err(error);
            }
            // Never delete the state file: absence means undecided, and the user would be asked
            // again. A disabled tombstone is safe even if interrupted (invalid JSON fails closed).
            use std::io::Write;
            let revoke = || -> std::io::Result<()> {
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create(true).truncate(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&self.path)?;
                file.write_all(b"{\"consent\":false}")?;
                file.sync_all()
            };
            if revoke().is_err() {
                return Err(
                    "本次运行已停止自动上报，但关闭设置无法保存。请在重启前检查磁盘权限并重试。",
                );
            }
        }
        *state = next;
        self.enabled.store(enabled, Ordering::Release);
        Ok(Status {
            consent: state.consent,
        })
    }
    fn reserve(&self, error: FrontendError, panic_location: bool, time: u64) -> Option<Payload> {
        let mut state = self.state.lock().ok()?;
        if state.consent != Some(true) || time < state.backoff {
            return None;
        }
        let id = state.anonymous_id.clone()?;
        let name = error_name(&error.name);
        let stack = if panic_location {
            error.stack
        } else {
            stack_locations(&error.stack)
        };
        if stack.is_empty() {
            return None;
        }
        let message = format!("{name}: 未处理的代码异常");
        let signature = format!(
            "{name}|{message}|{}",
            stack.lines().next().unwrap_or_default()
        );
        let hash = format!("{:x}", Sha256::digest(signature.as_bytes()));
        let mut next = state.clone();
        next.hourly.retain(|t| time.saturating_sub(*t) < HOUR);
        next.recent.retain(|_, t| time.saturating_sub(*t) < DAY);
        if next.hourly.len() >= 5 || next.recent.contains_key(&hash) {
            return None;
        }
        next.hourly.push(time);
        next.recent.insert(hash, time);
        self.save(&next).ok()?;
        *state = next;
        Some(payload(name, stack, message, id))
    }
    async fn automatic(&self, error: FrontendError, panic_location: bool) -> Receipt {
        let mut changes = self.changes.subscribe();
        let Some(body) = self.reserve(error, panic_location, now()) else {
            return Receipt::fail("suppressed");
        };
        tokio::select! {
            biased;
            _ = changes.changed() => Receipt::fail("disabled"),
            receipt = self.transmit(&body) => receipt,
        }
    }
    pub fn preview(&self, description: &str) -> Result<Preview, &'static str> {
        let token = uuid::Uuid::new_v4().to_string();
        let body = payload(
            "manual",
            String::new(),
            redact(description),
            uuid::Uuid::new_v4().to_string(),
        );
        *self.draft.lock().map_err(|_| SAVE_ERROR)? = Some(Draft {
            token: token.clone(),
            payload: body.clone(),
            created: now(),
        });
        Ok(Preview {
            token,
            payload: body,
        })
    }
    async fn manual(&self, token: &str) -> Receipt {
        let body = {
            let Ok(mut slot) = self.draft.lock() else {
                return Receipt::fail("unavailable");
            };
            let Some(draft) = slot.as_ref() else {
                return Receipt::fail("preview");
            };
            if draft.token != token || now().saturating_sub(draft.created) > 600_000 {
                return Receipt::fail("preview");
            }
            let Ok(mut state) = self.state.lock() else {
                return Receipt::fail("unavailable");
            };
            let time = now();
            if state
                .manual_at
                .is_some_and(|t| time.saturating_sub(t) < 60_000)
            {
                return Receipt::fail("cooldown");
            }
            let mut next = state.clone();
            next.manual_at = Some(time);
            if self.save(&next).is_err() {
                return Receipt::fail("unavailable");
            }
            *state = next;
            let body = draft.payload.clone();
            *slot = None;
            body
        };
        self.transmit(&body).await
    }
    async fn transmit(&self, body: &Payload) -> Receipt {
        let result = self.request(body).await;
        if !result.ok {
            let reason = result.reason.unwrap_or("failed");
            eprintln!("feedback: {reason}");
            if let Some(root) = self.path.parent() {
                let paths = data_service::HostPaths::from_roots(root.into(), root.join("cache"));
                let _ = data_service::write_log(
                    &paths,
                    "debug",
                    "FEEDBACK_FAILED",
                    &[("reason", reason)],
                );
            }
        }
        result
    }
    async fn request(&self, body: &Payload) -> Receipt {
        #[cfg(not(test))]
        let (endpoint, timeout) = (ENDPOINT, Duration::from_secs(5));
        #[cfg(test)]
        let (endpoint, timeout) = (self.endpoint.as_str(), self.timeout);
        let Ok(client) = reqwest::Client::builder()
            .user_agent(concat!(
                "wangshen-kuaitian-desktop/",
                env!("CARGO_PKG_VERSION")
            ))
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
        else {
            return Receipt::fail("network");
        };
        let Ok(mut response) = client.post(endpoint).json(body).send().await else {
            return Receipt::fail("network");
        };
        if response.status().as_u16() == 429 || response.status().is_server_error() {
            if let Ok(mut state) = self.state.lock() {
                state.backoff = now() + HOUR;
                let _ = self.save(&state);
            }
        }
        if !response.status().is_success() {
            return Receipt::fail("server");
        }
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= 4096 => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return Receipt::fail("response"),
            }
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return Receipt::fail("response");
        };
        let id = value.get("id").and_then(|s| s.as_str()).filter(|s| {
            !s.is_empty()
                && s.len() <= 100
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        });
        if value.get("ok").and_then(|s| s.as_bool()) != Some(true) || id.is_none() {
            return Receipt::fail("response");
        }
        Receipt {
            ok: true,
            id: id.map(str::to_owned),
            reason: None,
        }
    }
    pub fn install_panic_hook(self: &Arc<Self>) {
        // A bounded in-memory handoff keeps I/O and locks out of the panic hook.
        // Best effort for unwind panics; fatal aborts/process termination cannot guarantee delivery.
        let (tx, rx) = std::sync::mpsc::sync_channel::<FrontendError>(1);
        let reporter = Arc::clone(self);
        let started = std::thread::Builder::new()
            .name("feedback-panic".into())
            .spawn(move || {
                for error in rx {
                    tauri::async_runtime::block_on(reporter.automatic(error, true));
                }
            });
        if started.is_err() {
            return;
        }
        let enabled = Arc::clone(&self.enabled);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if enabled.load(Ordering::Acquire) {
                let stack = info
                    .location()
                    .map(|loc| own_panic_location(loc.file(), loc.line(), loc.column()))
                    .unwrap_or_default();
                if stack.is_empty() {
                    previous(info);
                    return;
                }
                let _ = tx.try_send(FrontendError {
                    name: "panic".into(),
                    stack,
                });
            }
            previous(info);
        }));
    }
}

#[tauri::command]
pub async fn feedback_status(state: State<'_, Arc<Reporter>>) -> Result<Status, &'static str> {
    state.status()
}
#[tauri::command]
pub async fn feedback_consent(
    state: State<'_, Arc<Reporter>>,
    enabled: bool,
) -> Result<Status, &'static str> {
    state.consent(enabled)
}
#[tauri::command]
pub async fn feedback_preview(
    state: State<'_, Arc<Reporter>>,
    description: String,
) -> Result<Preview, &'static str> {
    state.preview(&description)
}
#[tauri::command]
pub async fn feedback_send(state: State<'_, Arc<Reporter>>, token: String) -> Result<Receipt, ()> {
    Ok(state.manual(&token).await)
}
#[tauri::command]
pub async fn report_frontend_error(
    state: State<'_, Arc<Reporter>>,
    error: FrontendError,
) -> Result<(), ()> {
    state.automatic(error, false).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn error(line: usize) -> FrontendError {
        FrontendError { name: "TypeError".into(), stack: format!("private content\n at secret (tauri://localhost/assets/index-test.js:{line}:2)\n at https://private.test/resume:2:3") }
    }
    fn reporter() -> (tempfile::TempDir, Arc<Reporter>) {
        let dir = tempfile::tempdir().unwrap();
        let service = Reporter::new(dir.path().to_path_buf());
        (dir, service)
    }
    fn server(
        status: u16,
        body: String,
        delay: Duration,
    ) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/feedback", listener.local_addr().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut raw = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let n = socket.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&raw);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            tx.send(String::from_utf8_lossy(&raw).to_string()).ok();
            std::thread::sleep(delay);
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes());
        });
        (url, rx)
    }
    #[test]
    fn consent_identity_and_persistent_concurrent_dedup() {
        let (dir, reporter) = reporter();
        // New installation: undecided, nothing enabled, nothing kept, nothing written.
        assert_eq!(reporter.status().unwrap().consent, None);
        assert!(!reporter.enabled.load(Ordering::Acquire));
        assert!(reporter.reserve(error(1), false, now()).is_none());
        assert!(!reporter.path.exists());
        reporter.consent(false).unwrap();
        assert!(reporter.reserve(error(1), false, now()).is_none());
        reporter.consent(true).unwrap();
        let id = reporter.state.lock().unwrap().anonymous_id.clone().unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        let handles: Vec<_> = (0..50)
            .map(|_| {
                let reporter = reporter.clone();
                std::thread::spawn(move || reporter.reserve(error(1), false, now()).is_some())
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|h| h.join().unwrap() as usize)
                .sum::<usize>(),
            1
        );
        let restart = Reporter::new(dir.path().into());
        assert!(restart.reserve(error(1), false, now()).is_none());
        for i in 2..6 {
            assert!(reporter.reserve(error(i), false, now()).is_some());
        }
        assert!(reporter.reserve(error(6), false, now()).is_none());
        assert!(reporter
            .reserve(error(6), false, now() + HOUR + 1)
            .is_some());
        assert!(reporter.reserve(error(1), false, now() + DAY + 1).is_some());
        reporter.consent(false).unwrap();
        assert!(!std::fs::read_to_string(&reporter.path)
            .unwrap()
            .contains(&id));
        reporter.consent(true).unwrap();
        assert_ne!(
            reporter.state.lock().unwrap().anonymous_id.as_deref(),
            Some(id.as_str())
        );
    }
    #[test]
    fn choices_survive_restarts_and_old_default_grants_are_not_consent() {
        let (dir, reporter) = reporter();
        assert_eq!(
            Reporter::new(dir.path().into()).status().unwrap().consent,
            None
        );
        reporter.consent(true).unwrap();
        let id = reporter.state.lock().unwrap().anonymous_id.clone().unwrap();
        let granted = Reporter::new(dir.path().into());
        assert_eq!(granted.status().unwrap().consent, Some(true));
        assert!(granted.enabled.load(Ordering::Acquire));
        assert_eq!(
            granted.state.lock().unwrap().anonymous_id.as_deref(),
            Some(id.as_str())
        );
        reporter.consent(false).unwrap();
        let declined = Reporter::new(dir.path().into());
        assert_eq!(declined.status().unwrap().consent, Some(false));
        assert!(declined.state.lock().unwrap().anonymous_id.is_none());
        // Files written by the default-on builds: never shown, folded with 「知道了」, or switched
        // on by hand. The last two look the same, so none of them proves a choice.
        let undecided = [
            format!(r#"{{"consent":true,"notice_seen":false,"anonymous_id":"{id}"}}"#),
            format!(r#"{{"consent":true,"notice_seen":true,"anonymous_id":"{id}"}}"#),
            format!(r#"{{"consent":true,"anonymous_id":"{id}"}}"#),
            format!(
                r#"{{"consent":true,"consent_version":{},"anonymous_id":"{id}"}}"#,
                CONSENT_VERSION + 1
            ),
            r#"{"consent":null,"notice_seen":false}"#.into(),
            "{}".into(),
        ];
        for old in undecided {
            std::fs::write(&reporter.path, &old).unwrap();
            let migrated = Reporter::new(dir.path().into());
            assert_eq!(migrated.status().unwrap().consent, None, "{old}");
            assert!(!migrated.enabled.load(Ordering::Acquire), "{old}");
            assert!(migrated.reserve(error(1), false, now()).is_none(), "{old}");
            assert!(
                !std::fs::read_to_string(&reporter.path)
                    .unwrap()
                    .contains(&id),
                "{old}"
            );
        }
        for old in [
            r#"{"consent":false,"notice_seen":true}"#,
            r#"{"consent":false}"#,
        ] {
            std::fs::write(&reporter.path, old).unwrap();
            assert_eq!(
                Reporter::new(dir.path().into()).status().unwrap().consent,
                Some(false),
                "{old}"
            );
        }
        std::fs::write(
            &reporter.path,
            format!(
                r#"{{"consent":true,"consent_version":{CONSENT_VERSION},"anonymous_id":"{id}"}}"#
            ),
        )
        .unwrap();
        let current = Reporter::new(dir.path().into());
        assert_eq!(current.status().unwrap().consent, Some(true));
        assert_eq!(
            current.state.lock().unwrap().anonymous_id.as_deref(),
            Some(id.as_str())
        );
    }
    #[test]
    fn invalid_or_unwritable_preferences_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("feedback-state.json");
        std::fs::write(&path, b"invalid JSON").unwrap();
        let invalid = Reporter::new(dir.path().into());
        assert_eq!(invalid.status().unwrap().consent, Some(false));
        assert!(invalid.reserve(error(1), false, now()).is_none());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        let unwritable = Reporter::new(dir.path().into());
        assert_eq!(unwritable.status().unwrap().consent, None);
        assert!(unwritable.consent(true).is_err());
        assert_eq!(unwritable.status().unwrap().consent, None);
        assert!(!unwritable.enabled.load(Ordering::Acquire));
        assert!(unwritable.reserve(error(1), false, now()).is_none());
    }
    #[tokio::test]
    async fn fresh_install_sends_nothing_until_consent() {
        let (_dir, mut reporter) = reporter();
        let (url, received) = server(
            200,
            r#"{"ok":true,"id":"consent-test"}"#.into(),
            Duration::ZERO,
        );
        Arc::get_mut(&mut reporter).unwrap().endpoint = url;
        assert_eq!(
            reporter.automatic(error(1), false).await.reason,
            Some("suppressed")
        );
        assert!(received.try_recv().is_err());
        reporter.consent(true).unwrap();
        // The error from before the choice was not kept, so the same error now is a first report.
        assert!(reporter.automatic(error(1), false).await.ok);
        assert!(received
            .recv()
            .unwrap()
            .contains("resume-form-assistant-desktop"));
    }
    #[test]
    fn sensitive_text_and_foreign_frames_are_removed() {
        for raw in [
            "a@example.com",
            "+86 138-1234-5678",
            "110105199001011234",
            "１２３４５６７８９",
            "https://host.test/a?key=secret",
            "C:\\Users\\张三\\file",
            "/Users/alice/file",
            "/home/bob/file",
            "Bearer token1234",
            "oc_sk_123456789abcdef",
            "姓名：张三",
        ] {
            let safe = redact(raw);
            for secret in [
                "a@example.com",
                "138",
                "110105",
                "１２３４",
                "host.test",
                "张三",
                "alice",
                "bob",
                "token1234",
                "123456789abcdef",
            ] {
                assert!(!safe.contains(secret), "{raw} -> {safe}");
            }
        }
        assert_eq!(stack_locations(&error(1).stack), "assets/index-test.js:1:2");
        assert_eq!(
            stack_locations("https://example.com/assets/test.js:1:2"),
            ""
        );
        assert_eq!(redact(&"测".repeat(1400)).chars().count(), 1400);
    }
    #[test]
    fn preview_redacts_json_and_basic_credentials() {
        let (_dir, reporter) = reporter();
        for text in [
            r#"{"authToken":"privateCredential"}"#,
            r#"{"token":"privateCredential"}"#,
            r#"{"apiKey":"privateCredential"}"#,
            "Basic privateCredential",
            "access_token=privateCredential",
            "'password': 'privateCredential'",
        ] {
            let preview = reporter.preview(text).unwrap();
            assert!(
                !preview
                    .payload
                    .user_description
                    .contains("privateCredential"),
                "{text}"
            );
        }
    }
    #[tokio::test]
    async fn sends_exact_manual_preview_while_disabled_with_explicit_ua() {
        let (_dir, mut reporter) = reporter();
        let (url, received) = server(
            200,
            r#"{"ok":true,"id":"test-receipt"}"#.into(),
            Duration::ZERO,
        );
        Arc::get_mut(&mut reporter).unwrap().endpoint = url;
        reporter.consent(false).unwrap();
        let preview = reporter.preview("按钮无响应 邮箱 a@example.com").unwrap();
        assert_eq!(reporter.manual("wrong-token").await.reason, Some("preview"));
        let receipt = reporter.manual(&preview.token).await;
        assert!(receipt.ok);
        assert_eq!(receipt.id.as_deref(), Some("test-receipt"));
        let request = received.recv().unwrap();
        assert!(request
            .to_lowercase()
            .contains("user-agent: wangshen-kuaitian-desktop/"));
        let actual: serde_json::Value =
            serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(actual, serde_json::to_value(&preview.payload).unwrap());
        assert_eq!(actual["app"], "resume-form-assistant-desktop");
        assert!(!request.contains("a@example.com"));
        let next = reporter.preview("再次发送").unwrap();
        assert_eq!(reporter.manual(&next.token).await.reason, Some("cooldown"));
        assert!(reporter.state.lock().unwrap().anonymous_id.is_none());
    }
    #[tokio::test]
    async fn optout_has_no_request_and_failed_requests_are_safe_and_back_off() {
        for status in [400, 429, 500, 503] {
            let (_dir, mut reporter) = reporter();
            reporter.consent(false).unwrap();
            let (url, received) = server(status, "private body".into(), Duration::ZERO);
            Arc::get_mut(&mut reporter).unwrap().endpoint = url;
            assert_eq!(
                reporter.automatic(error(1), false).await.reason,
                Some("suppressed")
            );
            assert!(received.try_recv().is_err());
            reporter.consent(true).unwrap();
            assert_eq!(
                reporter.automatic(error(1), false).await.reason,
                Some("server")
            );
            received.recv().unwrap();
            if status == 429 || status >= 500 {
                assert!(reporter.reserve(error(2), false, now()).is_none());
                assert!(reporter
                    .reserve(error(2), false, now() + HOUR + 1)
                    .is_some());
            }
        }
    }
    #[tokio::test]
    async fn timeout_and_oversized_response_are_bounded() {
        for (body, delay, expected) in [
            ("x".repeat(5000), Duration::ZERO, "response"),
            ("{}".into(), Duration::from_millis(300), "network"),
        ] {
            let (_dir, mut reporter) = reporter();
            let (url, _) = server(200, body, delay);
            let mutable = Arc::get_mut(&mut reporter).unwrap();
            mutable.endpoint = url;
            mutable.timeout = Duration::from_millis(80);
            reporter.consent(true).unwrap();
            assert_eq!(
                reporter.automatic(error(1), false).await.reason,
                Some(expected)
            );
        }
    }
    #[tokio::test]
    async fn optout_cancels_inflight_without_waiting_for_response() {
        let (_dir, mut reporter) = reporter();
        let (url, rx) = server(200, "{}".into(), Duration::from_millis(500));
        Arc::get_mut(&mut reporter).unwrap().endpoint = url;
        reporter.consent(true).unwrap();
        let child = reporter.clone();
        let task = tokio::spawn(async move { child.automatic(error(1), false).await });
        tokio::task::spawn_blocking(move || rx.recv().unwrap())
            .await
            .unwrap();
        reporter.consent(false).unwrap();
        assert_eq!(task.await.unwrap().reason, Some("disabled"));
    }
    #[test]
    fn foreign_and_empty_frames_never_reserve_a_report() {
        let (_dir, reporter) = reporter();
        reporter.consent(true).unwrap();
        assert!(reporter
            .reserve(FrontendError::default(), false, now())
            .is_none());
        assert!(reporter
            .reserve(
                FrontendError {
                    name: "Error".into(),
                    stack: "https://foreign.test/a.js:1:2".into()
                },
                false,
                now()
            )
            .is_none());
        assert_eq!(
            own_panic_location("src/feedback.rs", 1, 2),
            "src/feedback.rs:1:2"
        );
        assert_eq!(
            own_panic_location(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"), 1, 2),
            "src/lib.rs:1:2"
        );
        assert_eq!(
            own_panic_location("../crates/archive-store/src/lib.rs", 1, 2),
            "crates/archive-store/src/lib.rs:1:2"
        );
        for path in [
            "/Users/alice/.cargo/registry/src/dependency/src/lib.rs",
            "/rustc/hash/library/std/src/lib.rs",
            "C:\\Users\\alice\\.cargo\\registry\\src\\lib.rs",
            "src/../../private.rs",
        ] {
            assert_eq!(own_panic_location(path, 1, 2), "");
        }
    }
    #[test]
    fn full_cookie_headers_and_common_tokens_are_removed() {
        for raw in [
            "Cookie: a=privateOne; b=privateTwo",
            "Authorization: Basic privateOne; extra=privateTwo",
            "ghp_abcdefghijklmnopqr",
            "xoxb-abcdefghijklmno",
            "eyJabcdefghij.abcdefghijk.abcdefghijk",
        ] {
            let safe = redact(raw);
            for secret in ["privateOne", "privateTwo", "abcdefghijkl"] {
                assert!(!safe.contains(secret), "{raw} -> {safe}");
            }
        }
    }
    #[test]
    fn optout_revokes_persisted_identity_even_if_atomic_replacement_fails() {
        let (dir, reporter) = reporter();
        reporter.consent(true).unwrap();
        std::fs::create_dir(reporter.path.with_extension("json.tmp")).unwrap();
        reporter.consent(false).unwrap();
        assert!(reporter.path.exists());
        assert!(!std::fs::read_to_string(&reporter.path)
            .unwrap()
            .contains("anonymous_id"));
        let restarted = Reporter::new(dir.path().into());
        assert_ne!(restarted.status().unwrap().consent, Some(true));
        assert!(restarted.state.lock().unwrap().anonymous_id.is_none());
    }

    #[test]
    fn feedback_identity_is_absent_from_real_archive_export_and_diagnostics() {
        let (dir, reporter) = reporter();
        let paths =
            data_service::HostPaths::from_roots(dir.path().into(), dir.path().join("cache"));
        paths.ensure_layout().unwrap();
        reporter.consent(true).unwrap();
        reporter.reserve(error(1), false, now()).unwrap();
        let id = reporter.state.lock().unwrap().anonymous_id.clone().unwrap();
        let store =
            crate::commands::open_store(&paths.archive_dir, &paths.current_pointer).unwrap();
        let export_paths = crate::restore::RestorePaths {
            data_root: paths.data_root.clone(),
            archive_dir: paths.archive_dir.clone(),
            current_pointer: paths.current_pointer.clone(),
            archives_retired_dir: paths.archives_retired_dir.clone(),
            settings_file: paths.settings_file.clone(),
        };
        let destination = dir.path().join("backup.zip");
        crate::restore::export_archive(&store, &export_paths, &destination, "2026-10-03T00:00:00Z")
            .unwrap();
        let manifest = backup::read_manifest(&destination).unwrap();
        assert!(manifest
            .entries
            .iter()
            .all(|entry| !entry.path.contains("feedback")));
        let diagnostics = data_service::diagnostics_from(&paths, true, &[]).to_string();
        assert!(!diagnostics.contains(&id));
        assert!(!diagnostics.contains("feedback-state"));
    }
    #[test]
    fn panic_hook_preserves_previous_handler_and_respects_consent() {
        const CHILD: &str = "RESUMEPRO_FEEDBACK_PANIC_TEST";
        if std::env::var_os(CHILD).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "feedback::tests::panic_hook_preserves_previous_handler_and_respects_consent",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let (_dir, mut reporter) = reporter();
        let (url, requests) = server(
            200,
            r#"{"ok":true,"id":"panic-test"}"#.into(),
            Duration::ZERO,
        );
        Arc::get_mut(&mut reporter).unwrap().endpoint = url;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            count.fetch_add(1, Ordering::Relaxed);
            previous(info);
        }));
        reporter.consent(false).unwrap();
        reporter.install_panic_hook();
        let _ = std::panic::catch_unwind(|| panic!("private synthetic panic"));
        assert!(requests.try_recv().is_err());
        reporter.consent(true).unwrap();
        let _ = std::panic::catch_unwind(|| panic!("private synthetic panic"));
        let request = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(request.contains("\"error_type\":\"panic\""));
        assert!(request.contains("src/feedback.rs:"));
        assert!(!request.contains("private synthetic"));
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }
    #[tokio::test]
    #[ignore = "explicit live synthetic relay acceptance only"]
    async fn live_synthetic_relay_receipt() {
        let (_dir, reporter) = reporter();
        reporter.consent(true).unwrap();
        let receipt = reporter.automatic(error(208), false).await;
        println!("synthetic desktop relay receipt: {:?}", receipt);
        assert!(receipt.ok);
    }
}
