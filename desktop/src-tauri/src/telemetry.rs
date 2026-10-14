//! Independent installation-count statistics (#259). No archive, feedback identifier,
//! user content, URLs from the webview, offline queue or background heartbeat enters here.
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, State};

const SETTINGS_VERSION: u32 = 1;
const NOTICE_VERSION: u32 = 2;
const SAVE_ERROR: &str = "使用统计设置未能保存，请重试。";
const OFF_SAVE_ERROR: &str =
    "本次运行已停止使用统计，但关闭设置无法保存。请在重启前检查磁盘权限并重试。";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    settings_version: u32,
    enabled: bool,
    notice_version: Option<u32>,
    installation_id: Option<String>,
    desktop_attempt_date: Option<String>,
    #[serde(default)]
    extension_attempt_date: Option<String>,
}
impl Default for Stored {
    fn default() -> Self {
        Self {
            settings_version: SETTINGS_VERSION,
            enabled: true,
            notice_version: None,
            installation_id: None,
            desktop_attempt_date: None,
            extension_attempt_date: None,
        }
    }
}
impl Stored {
    fn valid(&self) -> bool {
        self.settings_version == SETTINGS_VERSION
            && self.installation_id.as_ref().is_none_or(|id| {
                uuid::Uuid::parse_str(id).is_ok_and(|value| {
                    value.get_version_num() == 4
                        && value.get_variant() == uuid::Variant::RFC4122
                        && value.to_string() == *id
                })
            })
            && self
                .desktop_attempt_date
                .as_ref()
                .is_none_or(|date| valid_date(date))
            && self
                .extension_attempt_date
                .as_ref()
                .is_none_or(|date| valid_date(date))
            && (self.extension_attempt_date.is_none() || self.installation_id.is_some())
            && (self.desktop_attempt_date.is_none() || self.installation_id.is_some())
            && (self.enabled
                || (self.installation_id.is_none()
                    && self.desktop_attempt_date.is_none()
                    && self.extension_attempt_date.is_none()))
    }
}
fn valid_date(date: &str) -> bool {
    let format = time::macros::format_description!("[year]-[month]-[day]");
    time::Date::parse(date, format).is_ok_and(|value| value.to_string() == date)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Deletion {
    None,
    Pending,
    Deleted,
    Unconfirmed,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub enabled: bool,
    pub notice_required: bool,
    pub available: bool,
    pub outbound_enabled: bool,
    deletion: Deletion,
    revision: u64,
}
struct Inner {
    stored: Stored,
    available: bool,
    blocked: bool,
    deletion: Deletion,
    revision: u64,
}
struct ChangeFailure {
    message: &'static str,
    old_id: Option<String>,
    revision: u64,
}
impl std::fmt::Debug for ChangeFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never put an installation identifier into a diagnostic/panic message.
        formatter.write_str(self.message)
    }
}
struct Config {
    endpoint: Option<String>,
    platform: Option<&'static str>,
    timeout: Duration,
}
impl Config {
    fn release() -> Self {
        // Shipping code stays dormant until a reviewed release explicitly configures it.
        // Tests/debug/CI cannot opt into network by changing a runtime setting.
        let allowed = release_build_allowed(
            cfg!(test),
            cfg!(debug_assertions),
            option_env!("CI").is_some(),
            option_env!("RESUME_USAGE_METRICS_RELEASE_BUILD") == Some("1"),
            option_env!("RESUME_USAGE_METRICS_READY") == Some("1"),
        );
        let endpoint = option_env!("RESUME_USAGE_METRICS_ENDPOINT")
            .filter(|endpoint| allowed && checked_endpoint(endpoint))
            .map(str::to_owned);
        Self {
            endpoint,
            platform: match std::env::consts::OS {
                "windows" => Some("windows"),
                "macos" => Some("macos"),
                _ => None,
            },
            timeout: Duration::from_secs(3),
        }
    }
}
fn release_build_allowed(test: bool, debug: bool, ci: bool, reviewed_ci_release: bool, ready: bool) -> bool {
    !test && !debug && (!ci || reviewed_ci_release) && ready
}
fn checked_endpoint(endpoint: &str) -> bool {
    url::Url::parse(endpoint).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/v1/activity"
    })
}

#[derive(Serialize)]
struct Activity {
    schema_version: u32,
    installation_id: String,
    platform: &'static str,
    app_version: &'static str,
    surface: &'static str,
}
#[derive(Serialize)]
struct DeleteActivity {
    schema_version: u32,
    installation_id: String,
}

pub struct Telemetry {
    path: PathBuf,
    marker: PathBuf,
    inner: Mutex<Inner>,
    changes: tokio::sync::watch::Sender<u64>,
    config: Config,
}
impl Telemetry {
    pub fn new(root: PathBuf) -> Arc<Self> {
        let mut config = Config::release();
        if let Some(endpoint) = crate::metrics_acceptance::configured_endpoint(&root) {
            config.endpoint = Some(endpoint);
        }
        Self::load(root, config)
    }
    fn load(root: PathBuf, config: Config) -> Arc<Self> {
        let path = root.join("telemetry-state.json");
        // State loss must not silently re-enable a previous opt-out. This marker contains
        // no identifier; absence of BOTH files is the only first-install default.
        let marker = root.join("telemetry-initialized");
        let loaded = match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 4096 => serde_json::from_slice::<Stored>(&bytes)
                .ok()
                .filter(Stored::valid),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && matches!(marker.try_exists(), Ok(false)) =>
            {
                // Mark first: an interrupted state write then fails closed next launch.
                if write_file(&marker, b"1").is_ok()
                    && save_state(&path, &Stored::default()).is_ok()
                {
                    Some(Stored::default())
                } else {
                    None
                }
            }
            _ => None,
        };
        let available = loaded.is_some() && write_file(&marker, b"1").is_ok();
        let mut stored = loaded.unwrap_or_else(|| Stored {
            enabled: false,
            ..Stored::default()
        });
        if !available {
            stored.enabled = false;
            stored.installation_id = None;
            stored.desktop_attempt_date = None;
            stored.extension_attempt_date = None;
        }
        let (changes, _) = tokio::sync::watch::channel(0);
        Arc::new(Self {
            path,
            marker,
            config,
            changes,
            inner: Mutex::new(Inner {
                stored,
                available,
                blocked: !available,
                deletion: Deletion::None,
                revision: 0,
            }),
        })
    }
    fn view(&self, state: &Inner) -> Status {
        Status {
            enabled: state.stored.enabled && !state.blocked,
            notice_required: state.stored.enabled
                && state.stored.notice_version != Some(NOTICE_VERSION),
            available: state.available,
            outbound_enabled: self.config.endpoint.is_some() && self.config.platform.is_some(),
            deletion: state.deletion,
            revision: state.revision,
        }
    }
    pub fn status(&self) -> Result<Status, &'static str> {
        let state = self.inner.lock().map_err(|_| SAVE_ERROR)?;
        Ok(self.view(&state))
    }
    fn change(&self, enabled: bool) -> Result<(Status, Option<String>, u64), ChangeFailure> {
        let mut state = self.inner.lock().map_err(|_| ChangeFailure {
            message: SAVE_ERROR,
            old_id: None,
            revision: 0,
        })?;
        let mut next = state.stored.clone();
        let old_id = if enabled {
            None
        } else {
            next.installation_id.take()
        };
        if !enabled || !state.stored.enabled || state.blocked {
            next.installation_id = None;
            next.desktop_attempt_date = None;
            next.extension_attempt_date = None;
        }
        next.enabled = enabled;
        next.settings_version = SETTINGS_VERSION;
        state.revision += 1;
        let revision = state.revision;
        if !enabled {
            // Stop first, including requests which reserved before this choice.
            state.stored = next.clone();
            state.blocked = true;
            self.changes
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
        let saved = write_file(&self.marker, b"1").and_then(|_| save_state(&self.path, &next));
        if saved.is_err() {
            if !enabled {
                // In-place disabled tombstone if atomic replacement fails. Interrupted JSON
                // is corrupt and fails closed; never remove a file to reset a choice.
                if serde_json::to_vec(&next)
                    .is_ok_and(|bytes| write_file(&self.path, &bytes).is_ok())
                {
                    state.available = true;
                } else {
                    state.available = false;
                    state.deletion = Deletion::Unconfirmed;
                    return Err(ChangeFailure {
                        message: OFF_SAVE_ERROR,
                        old_id,
                        revision,
                    });
                }
            } else {
                state.blocked = true;
                state.available = false;
                self.changes
                    .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
                return Err(ChangeFailure {
                    message: SAVE_ERROR,
                    old_id: None,
                    revision,
                });
            }
        }
        state.stored = next;
        if !enabled {
            let _ = std::fs::remove_file(self.path.with_extension("json.tmp"));
        }
        state.blocked = false;
        state.available = true;
        state.deletion = if old_id.is_some() {
            Deletion::Pending
        } else {
            Deletion::None
        };
        Ok((self.view(&state), old_id, revision))
    }
    fn acknowledge_notice(&self) -> Result<Status, &'static str> {
        let mut state = self.inner.lock().map_err(|_| SAVE_ERROR)?;
        if !state.available || state.blocked {
            return Err(SAVE_ERROR);
        }
        if state.stored.notice_version == Some(NOTICE_VERSION) {
            return Ok(self.view(&state));
        }
        let mut next = state.stored.clone();
        // Records seeing the disclosure, not explicit consent or past activity.
        next.notice_version = Some(NOTICE_VERSION);
        if save_state(&self.path, &next).is_err() {
            state.blocked = true;
            state.available = false;
            state.revision += 1;
            self.changes
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
            return Err(SAVE_ERROR);
        }
        state.stored = next;
        state.revision += 1;
        Ok(self.view(&state))
    }
    fn reserve(&self, date: &str, visible_active: bool) -> Option<Activity> {
        self.reserve_surface(date, visible_active, "desktop")
    }
    fn reserve_surface(
        &self,
        date: &str,
        visible_active: bool,
        surface: &'static str,
    ) -> Option<Activity> {
        if !["desktop", "extension"].contains(&surface) {
            return None;
        }
        if !visible_active || !valid_date(date) {
            return None;
        }
        let platform = self.config.platform?;
        self.config.endpoint.as_ref()?;
        let mut state = self.inner.lock().ok()?;
        if state.blocked || !state.available || !state.stored.enabled
            || state.stored.notice_version != Some(NOTICE_VERSION)
            // A backwards clock cannot create another attempt in an already consumed day.
            || (if surface == "desktop" { &state.stored.desktop_attempt_date } else { &state.stored.extension_attempt_date }).as_deref().is_some_and(|previous| previous >= date)
        {
            return None;
        }
        let mut next = state.stored.clone();
        let id = next
            .installation_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        if surface == "desktop" {
            next.desktop_attempt_date = Some(date.to_owned());
        } else {
            next.extension_attempt_date = Some(date.to_owned());
        }
        // Persist quota BEFORE any network request. Failures consume the day; no retry queue.
        if save_state(&self.path, &next).is_err() {
            state.blocked = true;
            state.available = false;
            state.revision += 1;
            self.changes
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
            return None;
        }
        state.stored = next;
        Some(Activity {
            schema_version: 1,
            installation_id: id,
            platform,
            app_version: env!("CARGO_PKG_VERSION"),
            surface,
        })
    }
    async fn touch(&self, date: &str, visible_active: bool) {
        let mut changes = self.changes.subscribe();
        let Some(body) = self.reserve(date, visible_active) else {
            return;
        };
        tokio::select! {
            biased;
            _ = changes.changed() => {},
            _ = self.transmit(reqwest::Method::POST, &body) => {},
        }
    }
    pub async fn extension_touch(&self) {
        let mut changes = self.changes.subscribe();
        let Some(body) = self.reserve_surface(&today(), true, "extension") else {
            return;
        };
        tokio::select! {
            biased;
            _ = changes.changed() => {},
            _ = self.transmit(reqwest::Method::POST, &body) => {},
        }
    }
    async fn transmit(&self, method: reqwest::Method, body: &impl Serialize) -> bool {
        let Some(endpoint) = self.config.endpoint.as_deref() else {
            return false;
        };
        let Ok(client) = reqwest::Client::builder()
            .timeout(self.config.timeout)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
        else {
            return false;
        };
        // No token, auth header, user agent with device details, response body or error log.
        client
            .request(method, endpoint)
            .json(body)
            .send()
            .await
            .is_ok_and(|response| response.status() == reqwest::StatusCode::NO_CONTENT)
    }
    async fn delete(&self, id: String, revision: u64) -> Result<Status, &'static str> {
        let deleted = self
            .transmit(
                reqwest::Method::DELETE,
                &DeleteActivity {
                    schema_version: 1,
                    installation_id: id,
                },
            )
            .await;
        let mut state = self.inner.lock().map_err(|_| SAVE_ERROR)?;
        // A late delete receipt must not alter a newer enable/disable choice.
        if state.revision == revision {
            state.deletion = if deleted {
                Deletion::Deleted
            } else {
                Deletion::Unconfirmed
            };
            state.revision += 1;
        }
        Ok(self.view(&state))
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}
fn save_state(path: &Path, state: &Stored) -> std::io::Result<()> {
    let temporary = path.with_extension("json.tmp");
    write_file(&temporary, &serde_json::to_vec(state)?)?;
    std::fs::rename(&temporary, path)
}
fn active_window(window: &tauri::WebviewWindow) -> bool {
    window.label() == "main"
        && window.is_visible().unwrap_or(false)
        && window.is_focused().unwrap_or(false)
        && !window.is_minimized().unwrap_or(true)
}
fn today() -> String {
    time::OffsetDateTime::now_utc().date().to_string()
}

/// Native focus is an active signal only AFTER a visible main window exists.
pub fn focused(window: &tauri::Window) {
    if window.label() != "main"
        || !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
    {
        return;
    }
    let Some(state) = window.try_state::<Arc<Telemetry>>() else {
        return;
    };
    let service = Arc::clone(&state);
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        service.touch(&today(), true).await;
        announce_problem(&service, &app);
    });
}
fn announce_problem(service: &Telemetry, app: &tauri::AppHandle) {
    if let Ok(status) = service.status() {
        if !status.available {
            let _ = app.emit("usage-metrics-changed", status);
        }
    }
}
#[tauri::command]
pub fn telemetry_status(state: State<'_, Arc<Telemetry>>) -> Result<Status, &'static str> {
    state.status()
}
#[tauri::command]
pub fn telemetry_notice(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Telemetry>>,
) -> Result<Status, &'static str> {
    if !active_window(&window) {
        return Err("请在可见的主窗口查看统计说明。");
    }
    state.acknowledge_notice()
}
#[tauri::command]
pub fn telemetry_enabled(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Telemetry>>,
    enabled: bool,
) -> Result<Status, &'static str> {
    if !active_window(&window) {
        return Err("请在可见的主窗口更改统计设置。");
    }
    let result = state.change(enabled);
    let (old_id, revision) = match &result {
        Ok((_, id, revision)) => (id.clone(), *revision),
        Err(error) => (error.old_id.clone(), error.revision),
    };
    if let Some(id) = old_id {
        let service = Arc::clone(&state);
        let app = window.app_handle().clone();
        // Closing returns immediately; deletion is a single best-effort request, in memory only.
        tauri::async_runtime::spawn(async move {
            if let Ok(status) = service.delete(id, revision).await {
                let _ = app.emit("usage-metrics-changed", status);
            }
        });
    }
    result
        .map(|(status, _, _)| status)
        .map_err(|error| error.message)
}
#[tauri::command]
pub async fn telemetry_touch(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<Telemetry>>,
) -> Result<(), ()> {
    state.touch(&today(), active_window(&window)).await;
    announce_problem(&state, window.app_handle());
    Ok(())
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;
