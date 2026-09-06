use crate::error::{HostError, INSTANCE_LOCK_FAILED};
use crate::logging::{self, write_log};
use crate::paths::{program_dir, HostPaths};
use serde::Serialize;
use std::fs;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const PRODUCT_NAME: &str = "Resume Pro Desktop";
const IDENTIFIER: &str = "com.resumepro.desktop";

/// Unique-writer host. D03 should reuse this process and `paths()`, not spawn a second writer.
pub struct DataHost {
    paths: HostPaths,
    _lock: fslock::LockFile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingDraft {
    pub chrome_extension_id: String,
    pub edge_extension_id: String,
    /// Always false in D02. D13 writes Native Messaging registration.
    pub native_messaging_registered: bool,
}

impl Default for PairingDraft {
    fn default() -> Self {
        Self {
            chrome_extension_id: String::new(),
            edge_extension_id: String::new(),
            native_messaging_registered: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub ok: bool,
    pub app_version: String,
    pub product_name: String,
    pub identifier: String,
    pub platform: String,
    pub arch: String,
    pub program_dir: Option<String>,
    pub data_root: String,
    pub archive_dir: String,
    pub logs_dir: String,
    pub cache_dir: String,
    pub current_pointer: String,
    pub writable: bool,
    pub another_instance_running: bool,
    pub unique_writer: bool,
    pub autostart_enabled: bool,
    pub native_messaging_registered: bool,
    pub reminders_implemented: bool,
    pub error: Option<crate::error::HostErrorDto>,
}

impl DataHost {
    pub fn initialize() -> Result<Self, HostError> {
        Self::initialize_with(HostPaths::resolve()?)
    }

    pub fn initialize_with(paths: HostPaths) -> Result<Self, HostError> {
        paths.ensure_layout()?;
        let lock = acquire_lock(&paths)?;
        let host = Self { paths, _lock: lock };
        let _ = write_log(
            host.paths(),
            "info",
            "HOST_STARTED",
            &[
                ("platform", std::env::consts::OS),
                ("role", "unique-writer"),
            ],
        );
        Ok(host)
    }

    pub fn paths(&self) -> &HostPaths {
        &self.paths
    }

    pub fn is_writable(&self) -> Result<(), HostError> {
        self.paths.assert_writable()
    }

    pub fn load_pairing_draft(&self) -> PairingDraft {
        read_pairing_draft(&self.paths.settings_file)
    }

    pub fn save_pairing_draft(&self, draft: &PairingDraft) -> Result<(), HostError> {
        // D02 stores a local draft only. It does not write Native Messaging manifests or registry keys.
        let mut stored = draft.clone();
        stored.native_messaging_registered = false;
        let json = serde_json::to_string_pretty(&stored).unwrap_or_else(|_| "{}".to_string());
        fs::write(&self.paths.settings_file, json).map_err(|e| {
            HostError::dir_not_writable(
                self.paths.settings_file.clone(),
                format!("write settings.json failed: {e}"),
            )
        })?;
        let _ = write_log(
            &self.paths,
            "info",
            "PAIRING_DRAFT_SAVED",
            &[("nativeMessagingRegistered", "false")],
        );
        Ok(())
    }
}

fn acquire_lock(paths: &HostPaths) -> Result<fslock::LockFile, HostError> {
    let mut lock = fslock::LockFile::open(&paths.lock_file).map_err(|e| {
        HostError::instance_lock_failed(paths.lock_file.clone()).pipe_message(e.to_string())
    })?;
    match lock.try_lock() {
        Ok(true) => Ok(lock),
        Ok(false) => Err(HostError::instance_lock_failed(paths.lock_file.clone())),
        Err(e) => Err(HostError::new(
            INSTANCE_LOCK_FAILED,
            format!("lock error: {e}"),
            Some(paths.lock_file.clone()),
            "A second launch should focus the existing window instead of creating another writer.",
        )),
    }
}

trait PipeMessage {
    fn pipe_message(self, extra: String) -> Self;
}

impl PipeMessage for HostError {
    fn pipe_message(self, extra: String) -> Self {
        HostError::new(
            self.code(),
            format!("{} ({extra})", self.message()),
            self.path().map(|p| p.to_path_buf()),
            self.hint(),
        )
    }
}

fn lock_is_held(paths: &HostPaths) -> Result<bool, HostError> {
    if !paths.lock_file.exists() {
        return Ok(false);
    }
    let mut lock = fslock::LockFile::open(&paths.lock_file).map_err(|e| {
        HostError::new(
            INSTANCE_LOCK_FAILED,
            format!("open lock: {e}"),
            Some(paths.lock_file.clone()),
            "Could not inspect the unique-writer lock.",
        )
    })?;
    match lock.try_lock() {
        Ok(true) => {
            let _ = lock.unlock();
            Ok(false)
        }
        Ok(false) => Ok(true),
        Err(e) => Err(HostError::new(
            INSTANCE_LOCK_FAILED,
            format!("try_lock: {e}"),
            Some(paths.lock_file.clone()),
            "Could not inspect the unique-writer lock.",
        )),
    }
}

fn read_pairing_draft(path: &std::path::Path) -> PairingDraft {
    let Ok(text) = fs::read_to_string(path) else {
        return PairingDraft::default();
    };
    serde_json::from_str::<PairingDraft>(&text).unwrap_or_default()
}

impl<'de> serde::Deserialize<'de> for PairingDraft {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            #[serde(default)]
            chrome_extension_id: String,
            #[serde(default)]
            edge_extension_id: String,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(PairingDraft {
            chrome_extension_id: raw.chrome_extension_id,
            edge_extension_id: raw.edge_extension_id,
            native_messaging_registered: false,
        })
    }
}

pub fn probe() -> ProbeReport {
    match HostPaths::resolve() {
        Ok(paths) => probe_with(&paths),
        Err(err) => ProbeReport {
            ok: false,
            app_version: APP_VERSION.to_string(),
            product_name: PRODUCT_NAME.to_string(),
            identifier: IDENTIFIER.to_string(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            program_dir: program_dir().map(|p| p.display().to_string()),
            data_root: String::new(),
            archive_dir: String::new(),
            logs_dir: String::new(),
            cache_dir: String::new(),
            current_pointer: String::new(),
            writable: false,
            another_instance_running: false,
            unique_writer: false,
            autostart_enabled: false,
            native_messaging_registered: false,
            reminders_implemented: false,
            error: Some(err.to_dto()),
        },
    }
}

#[derive(Clone, Copy)]
enum ProbeLockView {
    DetectExternal,
    SelfOwned,
}

pub fn probe_with(paths: &HostPaths) -> ProbeReport {
    build_probe(paths, ProbeLockView::DetectExternal, false)
}

fn build_probe(paths: &HostPaths, lock_view: ProbeLockView, unique_writer: bool) -> ProbeReport {
    let layout = paths.ensure_layout();
    let writable = layout.is_ok();
    let error = layout.err().map(|e| e.to_dto());
    let another = match lock_view {
        ProbeLockView::SelfOwned => false,
        ProbeLockView::DetectExternal => match lock_is_held(paths) {
            Ok(held) => held,
            Err(e) => {
                return ProbeReport {
                    ok: false,
                    error: Some(e.to_dto()),
                    another_instance_running: false,
                    unique_writer,
                    ..probe_paths_only(paths, writable)
                };
            }
        },
    };
    ProbeReport {
        ok: writable && error.is_none(),
        another_instance_running: another,
        unique_writer,
        error,
        ..probe_paths_only(paths, writable)
    }
}

fn probe_paths_only(paths: &HostPaths, writable: bool) -> ProbeReport {
    ProbeReport {
        ok: false,
        app_version: APP_VERSION.to_string(),
        product_name: PRODUCT_NAME.to_string(),
        identifier: IDENTIFIER.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        program_dir: program_dir().map(|p| p.display().to_string()),
        data_root: paths.data_root.display().to_string(),
        archive_dir: paths.archive_dir.display().to_string(),
        logs_dir: paths.logs_dir.display().to_string(),
        cache_dir: paths.cache_dir.display().to_string(),
        current_pointer: paths.current_pointer.display().to_string(),
        writable,
        another_instance_running: false,
        unique_writer: false,
        autostart_enabled: false,
        native_messaging_registered: false,
        reminders_implemented: false,
        error: None,
    }
}

pub fn diagnostics_from(paths: &HostPaths, unique_writer: bool, extra: &[(&str, &str)]) -> serde_json::Value {
    let lock_view = if unique_writer {
        ProbeLockView::SelfOwned
    } else {
        ProbeLockView::DetectExternal
    };
    let report = redact_probe(build_probe(paths, lock_view, unique_writer), paths);
    let mut value = serde_json::to_value(&report).unwrap_or_else(|_| serde_json::json!({}));
    let replacements = crate::redact::path_replacements(paths);
    if let Some(obj) = value.as_object_mut() {
        for (k, v) in crate::redact::sanitize_context(extra) {
            obj.insert(k, serde_json::Value::String(crate::redact::redact_path(&v, &replacements)));
        }
        obj.insert(
            "logFile".into(),
            serde_json::Value::String(crate::redact::redact_path(
                &logging::log_path(paths).display().to_string(),
                &replacements,
            )),
        );
        let webview = crate::webview::webview_storage(paths);
        obj.insert("webviewDataManaged".into(), serde_json::Value::Bool(webview.managed_by_app));
        obj.insert(
            "webviewDataDir".into(),
            match webview.webview_data_dir {
                Some(dir) => serde_json::Value::String(crate::redact::redact_path(
                    &dir.display().to_string(),
                    &replacements,
                )),
                None => serde_json::Value::Null,
            },
        );
        obj.insert("webviewDataNote".into(), serde_json::Value::String(webview.note));
        obj.insert("d03Note".into(), serde_json::Value::String(
            "D03 should open SQLite under archiveDir and write current.json at currentPointer. D02 does not create archive.db.".into(),
        ));
        obj.insert("d06Note".into(), serde_json::Value::String(
            "D06 should start this same unique-writer process with --hidden. Do not spawn a second database writer.".into(),
        ));
    }
    value
}

fn redact_probe(mut report: ProbeReport, paths: &HostPaths) -> ProbeReport {
    let replacements = crate::redact::path_replacements(paths);
    report.program_dir = report
        .program_dir
        .map(|p| crate::redact::redact_path(&p, &replacements));
    report.data_root = crate::redact::redact_path(&report.data_root, &replacements);
    report.archive_dir = crate::redact::redact_path(&report.archive_dir, &replacements);
    report.logs_dir = crate::redact::redact_path(&report.logs_dir, &replacements);
    report.cache_dir = crate::redact::redact_path(&report.cache_dir, &replacements);
    report.current_pointer = crate::redact::redact_path(&report.current_pointer, &replacements);
    if let Some(error) = report.error.as_mut() {
        error.message = crate::redact::redact_path(&error.message, &replacements);
        error.path = error
            .path
            .as_ref()
            .map(|p| crate::redact::redact_path(p, &replacements));
        error.hint = crate::redact::redact_path(&error.hint, &replacements);
    }
    report
}

pub fn write_diagnostics_file(paths: &HostPaths, body: &serde_json::Value) -> Result<std::path::PathBuf, HostError> {
    paths.ensure_layout()?;
    let name = format!(
        "diagnostics-{}.json",
        time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| "now".into())
            .replace(':', "")
    );
    let dest = paths.logs_dir.join(name);
    fs::write(&dest, serde_json::to_string_pretty(body).unwrap_or_else(|_| "{}".into())).map_err(
        |e| HostError::log_write_failed(dest.clone(), format!("write diagnostics failed: {e}")),
    )?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::DIR_NOT_WRITABLE;
    use std::fs;

    #[test]
    fn second_host_cannot_take_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = HostPaths::resolve_with(Some(tmp.path().join("data")), None).unwrap();
        let first = DataHost::initialize_with(paths.clone()).unwrap();
        let err = match DataHost::initialize_with(paths.clone()) {
            Ok(_) => panic!("second unique writer should fail"),
            Err(e) => e,
        };
        assert_eq!(err.code(), INSTANCE_LOCK_FAILED);
        let probe = probe_with(first.paths());
        assert!(probe.another_instance_running);
        drop(first);
        let second = DataHost::initialize_with(paths).unwrap();
        assert!(second.paths().archive_dir.is_dir());
    }

    #[test]
    fn initialize_does_not_create_database() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = HostPaths::resolve_with(Some(tmp.path().join("data")), None).unwrap();
        let host = DataHost::initialize_with(paths).unwrap();
        assert!(!host.paths().archive_dir.join("archive.db").exists());
        assert!(!host.paths().current_pointer.exists());
    }

    #[test]
    fn unwritable_dir_is_actionable() {
        let tmp = tempfile::tempdir().unwrap();
        let blocker = tmp.path().join("blocked");
        fs::write(&blocker, b"file").unwrap();
        let paths = HostPaths::from_roots(blocker.clone(), blocker.join("cache"));
        let err = match DataHost::initialize_with(paths) {
            Ok(_) => panic!("unwritable root should fail"),
            Err(e) => e,
        };
        assert!(err.code() == DIR_NOT_WRITABLE || err.code() == crate::error::DIR_CREATE_FAILED);
        assert!(err.hint().contains("will not"));
        assert_eq!(err.path().map(|p| p.to_path_buf()), Some(blocker));
    }

    #[test]
    fn pairing_draft_does_not_claim_registration() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = HostPaths::resolve_with(Some(tmp.path().join("data")), None).unwrap();
        let host = DataHost::initialize_with(paths).unwrap();
        let mut draft = PairingDraft::default();
        draft.chrome_extension_id = "abcdefghijklmnopqrstuvwxyzabcdef".into();
        draft.native_messaging_registered = true;
        host.save_pairing_draft(&draft).unwrap();
        let loaded = host.load_pairing_draft();
        assert_eq!(loaded.chrome_extension_id, "abcdefghijklmnopqrstuvwxyzabcdef");
        assert!(!loaded.native_messaging_registered);
    }

    #[test]
    fn probe_keeps_layout_error_instead_of_null() {
        let tmp = tempfile::tempdir().unwrap();
        let blocker = tmp.path().join("blocked");
        fs::write(&blocker, b"file").unwrap();
        let paths = HostPaths::from_roots(blocker, tmp.path().join("cache"));
        let probe = probe_with(&paths);
        assert!(!probe.ok);
        assert!(!probe.writable);
        let error = probe.error.expect("probe must keep the layout error");
        assert!(error.code == DIR_NOT_WRITABLE || error.code == crate::error::DIR_CREATE_FAILED);
    }

    #[test]
    fn diagnostics_from_active_host_does_not_report_self_as_another_instance() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = HostPaths::resolve_with(Some(tmp.path().join("data")), None).unwrap();
        let host = DataHost::initialize_with(paths.clone()).unwrap();
        let external = probe_with(host.paths());
        assert!(external.another_instance_running);
        assert!(!external.unique_writer);
        let exported = diagnostics_from(host.paths(), true, &[("windowVisible", "true")]);
        assert_eq!(exported["uniqueWriter"], serde_json::Value::Bool(true));
        assert_eq!(exported["anotherInstanceRunning"], serde_json::Value::Bool(false));
        let text = exported.to_string();
        if let Some(home) = dirs::home_dir() {
            if let Some(name) = home.file_name() {
                let name = name.to_string_lossy();
                if name.len() >= 3 {
                    assert!(!text.contains(name.as_ref()), "diagnostics leaked user name: {text}");
                }
            }
        }
        assert!(!text.contains("sk-secret"));
        drop(host);
        let after = probe_with(&paths);
        assert!(!after.another_instance_running);
    }
}
