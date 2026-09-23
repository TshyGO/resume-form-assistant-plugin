mod ai_client;
mod ai_commands;
#[cfg(test)]
mod ai_commands_tests;
mod ai_credentials;
mod ai_settings;
mod nm_register;
mod update_check;
#[cfg(test)]
mod nm_register_tests;
mod cli;
mod commands;
mod evidence_commands;
mod backup_commands;
mod recycle_commands;
mod restore;
mod resume_commands;
mod todo_commands;
#[cfg(test)]
mod commands_regression;
mod ipc_client;
mod ipc_server;
mod lifecycle;
mod nm;
mod plugin_bridge;

use archive_store::ArchiveStore;
use commands::{
    add_note, application_manager_loop, confirm_submit, correct_stage, create_application,
    get_application, list_applications, open_store, query_candidates, record_assessment,
    record_closed, record_interview, record_offer, record_rejected, record_withdrawn, set_recycle,
    update_application, CommandError, CorrectStageArgs, CreateApplicationArgs,
    ListApplicationsArgs, NoteArgs, ProgressEventArgs, SubmitArgs, UpdateApplicationArgs,
};
use data_service::{
    diagnostics_from, probe, write_diagnostics_file, write_log, DataHost, HostErrorDto, HostPaths,
    PairingDraft,
};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

pub use cli::prepare_stdio;

struct AppState {
    host: Mutex<Option<DataHost>>,
    host_error: Mutex<Option<HostErrorDto>>,
    paths: Mutex<Option<HostPaths>>,
    store: Arc<Mutex<Option<ArchiveStore>>>,
    store_error: Mutex<Option<CommandError>>,
    hidden_launch: bool,
    /// Serving the local endpoint. Held here so it lives exactly as long as the
    /// application does, which is what ties the unique listener to the unique writer.
    ipc: Mutex<Option<ipc_server::IpcService>>,
    /// D10：把到期登记给操作系统的那一位。整个进程共用一个，退出时要靠它撤销
    /// 全部未触发的计划。它不认识数据库，也不认识待办是什么。
    reminders: Box<dyn reminders::ReminderScheduler>,
    /// D11：桌面这条 AI Key 的存放处。只有发请求时才从这里取，
    /// 没有把 Key 交回界面的命令。
    credentials: Box<dyn ai_credentials::CredentialStore>,
    /// D11：正在进行的分析请求。按 requestId 取消；同一条证据同时只允许一个，
    /// 不排队也不重试。
    ai_inflight: ai_commands::InflightRegistry,
    /// D13：上一次核对 Native Messaging 注册的结果。启动时算一次，手动重试时更新。
    native_messaging: Mutex<Vec<nm_register::Outcome>>,
    /// D13：上一次查到的可下载版本。「去下载页」开的是它，不是前端传来的任意地址。
    latest_update: Mutex<Option<update_check::UpdateInfo>>,
}

/// 设置页要看的 AI 配置。**故意不含 Key**，只说配没配。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSettingsView {
    api_url: String,
    model: String,
    /// 预览和提示里只出现主机名。
    host: String,
    key_configured: bool,
    /// 凭据库读不出来时说明原因，不假装「没配过」。
    credential_error: Option<String>,
}

fn ai_settings_view(state: &AppState) -> Result<AiSettingsView, CommandError> {
    let settings = ai_settings::load(&ai_data_root(state)?);
    let (key_configured, credential_error) = match state.credentials.get_key() {
        Ok(found) => (found.is_some(), None),
        Err(err) => (false, Some(err.message())),
    };
    Ok(AiSettingsView {
        host: ai_settings::host_of(&settings.api_url),
        api_url: settings.api_url,
        model: settings.model,
        key_configured,
        credential_error,
    })
}

fn ai_data_root(state: &AppState) -> Result<std::path::PathBuf, CommandError> {
    let guard = state.paths.lock().map_err(|e| CommandError {
        code: "STORE_ERROR".into(),
        message: e.to_string(),
    })?;
    let paths = guard.as_ref().ok_or_else(|| CommandError {
        code: "NO_DATA_DIR".into(),
        message: "还没有定位到用户数据目录，设置没有保存。".into(),
    })?;
    Ok(paths.data_root.clone())
}

/// 发请求之前再看一眼地址。`save` 已经拦过一次，但旧版本存下的配置、用户手改的
/// 文件、恢复回来的备份都可能绕过它——真正要紧的是**别把 Key 发出去**。
fn checked_url(api_url: &str) -> Result<(), CommandError> {
    match ai_settings::credential_in_url(api_url) {
        Some(problem) => Err(CommandError {
            code: "AI_URL_HAS_CREDENTIAL".into(),
            message: problem,
        }),
        None => Ok(()),
    }
}

/// 这台机器上要写哪几份清单。三个平台的位置互不相同，不能共用一套路径。
fn native_messaging_targets(data_root: &std::path::Path) -> Vec<nm_register::Target> {
    #[cfg(windows)]
    {
        nm_register::windows_targets(data_root)
    }
    #[cfg(not(windows))]
    {
        let _ = data_root;
        let Ok(home) = std::env::var("HOME") else {
            return Vec::new();
        };
        let home = std::path::Path::new(&home);
        #[cfg(target_os = "macos")]
        {
            nm_register::mac_targets(home)
        }
        #[cfg(target_os = "linux")]
        {
            nm_register::linux_targets(home)
        }
        // 别的系统我们不发包，也就不知道浏览器读哪里。写一个猜的位置
        // 只会得到一个谁也不读的文件。
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = home;
            Vec::new()
        }
    }
}

fn native_messaging_registry() -> Box<dyn nm_register::Registry> {
    #[cfg(windows)]
    {
        Box::new(nm_register::HkcuRegistry)
    }
    #[cfg(not(windows))]
    {
        Box::new(nm_register::NoRegistry)
    }
}

/// 核对一次注册，需要就写，并把结果存进状态。
///
/// 启动时跑一次，用户手动重试时再跑一次。写失败不影响应用别的部分：连不上浏览器
/// 是一件要说清楚的事，不是一件要拦住启动的事。
fn refresh_native_messaging(state: &AppState) -> Vec<nm_register::Outcome> {
    let data_root = match state.paths.lock() {
        Ok(guard) => guard.as_ref().map(|p| p.data_root.clone()),
        Err(_) => None,
    };
    let Some(data_root) = data_root else {
        return Vec::new();
    };
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(err) => {
            return vec![nm_register::Outcome {
                browser: nm_register::Browser::Chrome,
                label: "本机".into(),
                registered: false,
                note: Some(format!("认不出自己的程序路径：{err}")),
            }]
        }
    };
    // 配对草稿里手填的 ID **只在开发构建里**并进清单。
    //
    // 正式构建不看它：那个文件在用户目录下，任何一个本机进程都能往里写；要是
    // 照单全收，写一行就等于给一个扩展永久授权读整本求职档案。正式版靠的是
    // manifest.json 里的公钥——本地 unpacked 和商店版是同一个 ID，本来也不需要填。
    let extra: Vec<String> = if cfg!(debug_assertions) {
        let draft = match state.host.lock() {
            Ok(guard) => guard.as_ref().map(|h| h.load_pairing_draft()),
            Err(_) => None,
        }
        .unwrap_or_default();
        [draft.chrome_extension_id, draft.edge_extension_id]
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .collect()
    } else {
        Vec::new()
    };
    let ids = nm_register::extension_ids(&extra);

    let targets = native_messaging_targets(&data_root);
    let files = nm_register::RealFiles;
    let registry = native_messaging_registry();
    let receipt_path = nm_register::receipt_path(&data_root);
    let receipt = nm_register::load_receipt(&files, &receipt_path);
    let (outcomes, next) = nm_register::ensure(
        &targets,
        &exe,
        &ids,
        &files,
        registry.as_ref(),
        receipt,
    );
    if let Err(problem) = nm_register::save_receipt(&files, &receipt_path, &next) {
        eprintln!("nm: 回执没写成：{problem}");
    }
    if let Ok(mut slot) = state.native_messaging.lock() {
        *slot = outcomes.clone();
    }
    outcomes
}

fn credential_error(err: ai_credentials::CredentialError) -> CommandError {
    CommandError {
        code: err.code().into(),
        message: err.message(),
    }
}

fn with_store<T>(
    state: &AppState,
    f: impl FnOnce(&ArchiveStore) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let guard = state.store.lock().map_err(|e| CommandError {
        code: "STORE_ERROR".into(),
        message: e.to_string(),
    })?;
    match guard.as_ref() {
        Some(store) => f(store),
        None => Err(state
            .store_error
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
            .unwrap_or(CommandError {
                code: "STORE_UNAVAILABLE".into(),
                message: "申请档案未能打开，未改用临时或内存数据库".into(),
            })),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    app_version: String,
    product_name: String,
    identifier: String,
    platform: String,
    arch: String,
    program_dir: Option<String>,
    data_root: String,
    archive_dir: String,
    logs_dir: String,
    cache_dir: String,
    log_file: String,
    current_pointer: String,
    writable: bool,
    unique_writer: bool,
    window_visible: bool,
    hidden_launch: bool,
    autostart_enabled: bool,
    native_messaging_registered: bool,
    /// 每个浏览器注册成了没有、没成是因为什么。界面照这个说话。
    native_messaging: Vec<nm_register::Outcome>,
    /// 这次启动升级过数据库的话，迁移前那份自动备份在哪。没升级就是空。
    migration_backup: Option<String>,
    /// 读不到档案状态时不能把它当成「没有升级」；这个开关让界面如实说。
    migration_backup_unknown: bool,
    reminders_implemented: bool,
    close_window_means: String,
    quit_means: String,
    pairing: PairingDraft,
    error: Option<HostErrorDto>,
    runtime_label: String,
    webview_data_dir: Option<String>,
    webview_data_managed: bool,
    webview_data_note: String,
}

#[tauri::command]
fn get_runtime_status(app: AppHandle, state: State<AppState>) -> Result<RuntimeStatus, String> {
    let window_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let host = state.host.lock().map_err(|e| e.to_string())?;
    let error = state.host_error.lock().map_err(|e| e.to_string())?.clone();
    let store_error = state.store_error.lock().map_err(|e| e.to_string())?.clone();
    let error = error.or_else(|| {
        store_error.map(|e| HostErrorDto {
            code: e.code,
            message: e.message,
            path: None,
            hint: "申请档案未能打开。不会改用临时或内存数据库。".into(),
        })
    });
    let paths = state.paths.lock().map_err(|e| e.to_string())?;
    let unique_writer = host.is_some();
    let pairing = host
        .as_ref()
        .map(|h| h.load_pairing_draft())
        .unwrap_or_default();
    let resolved = paths.clone().or_else(|| HostPaths::resolve().ok());
    // 升级时 archive-store 会在迁移前自动备份一份（D03）。它是「升级失败还有退路」
    // 这句话的凭据，得让用户看得见，而不是只躺在日志里。
    let (migration_backup, migration_backup_unknown) = match state.store.lock() {
        // A store that failed to open is also "unknown", not "no migration".
        Ok(guard) => match guard.as_ref() {
            Some(store) => (
                store
                    .migration_backup
                    .clone()
                    .map(|path| path.display().to_string()),
                false,
            ),
            None => (None, true),
        },
        Err(_) => (None, true),
    };
    // 注册结果是启动时算好的：状态查询不该顺手往盘上写东西。
    let native_messaging = state
        .native_messaging
        .lock()
        .map(|outcomes| outcomes.clone())
        .unwrap_or_default();
    let data_root = resolved
        .as_ref()
        .map(|p| p.data_root.display().to_string())
        .unwrap_or_default();
    let runtime_label = if let Some(err) = &error {
        format!("启动受限 · {}", err.code)
    } else if unique_writer && window_visible {
        "运行中 · 唯一写入者 · 窗口可见".to_string()
    } else if unique_writer {
        "运行中 · 唯一写入者 · 窗口已隐藏".to_string()
    } else {
        "未成为唯一写入者".to_string()
    };
    Ok(RuntimeStatus {
        app_version: app.package_info().version.to_string(),
        product_name: "Resume Pro Desktop".into(),
        identifier: "com.resumepro.desktop".into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        program_dir: data_service::program_dir().map(|p| p.display().to_string()),
        archive_dir: resolved
            .as_ref()
            .map(|p| p.archive_dir.display().to_string())
            .unwrap_or_default(),
        logs_dir: resolved
            .as_ref()
            .map(|p| p.logs_dir.display().to_string())
            .unwrap_or_default(),
        cache_dir: resolved
            .as_ref()
            .map(|p| p.cache_dir.display().to_string())
            .unwrap_or_default(),
        log_file: resolved
            .as_ref()
            .map(|p| data_service::log_path(p).display().to_string())
            .unwrap_or_default(),
        current_pointer: resolved
            .as_ref()
            .map(|p| p.current_pointer.display().to_string())
            .unwrap_or_default(),
        data_root,
        writable: host.is_some(), // initialization result; status polling must not write probe files
        unique_writer,
        window_visible,
        hidden_launch: state.hidden_launch,
        autostart_enabled: false,
        native_messaging_registered: native_messaging.iter().all(|o| o.registered)
            && !native_messaging.is_empty(),
        native_messaging,
        migration_backup,
        migration_backup_unknown,
        reminders_implemented: false,
        close_window_means: "hide-to-tray".into(),
        quit_means: "explicit-quit".into(),
        pairing,
        error,
        runtime_label,
        webview_data_dir: resolved.as_ref().and_then(|p| {
            data_service::webview_storage(p)
                .webview_data_dir
                .map(|d| d.display().to_string())
        }),
        webview_data_managed: resolved
            .as_ref()
            .map(|p| data_service::webview_storage(p).managed_by_app)
            .unwrap_or(false),
        webview_data_note: resolved
            .as_ref()
            .map(|p| data_service::webview_storage(p).note)
            .unwrap_or_default(),
    })
}

#[tauri::command]
fn export_diagnostics(app: AppHandle, state: State<AppState>) -> Result<serde_json::Value, String> {
    let unique = state.host.lock().map_err(|e| e.to_string())?.is_some();
    let paths = state
        .paths
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .or_else(|| HostPaths::resolve().ok())
        .ok_or_else(|| "PATH_INVALID: cannot resolve data directory".to_string())?;
    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let extra = [
        ("windowVisible", if visible { "true" } else { "false" }),
        (
            "hiddenLaunch",
            if state.hidden_launch { "true" } else { "false" },
        ),
    ];
    let mut body = diagnostics_from(&paths, unique, &extra);
    let available = state.store.lock().map_err(|e| e.to_string())?.is_some();
    let store_error = state.store_error.lock().map_err(|e| e.to_string())?.clone();
    add_archive_diagnostics(&mut body, &paths, available, store_error.as_ref());
    let dest = write_diagnostics_file(&paths, &body).map_err(|e| e.to_string())?;
    let _ = write_log(&paths, "info", "DIAGNOSTICS_EXPORTED", &[("ok", "true")]);
    let mut out = body;
    if let Some(obj) = out.as_object_mut() {
        obj.insert(
            "exportPath".into(),
            serde_json::Value::String(dest.display().to_string()),
        );
    }
    Ok(out)
}

fn add_archive_diagnostics(
    body: &mut serde_json::Value,
    paths: &HostPaths,
    available: bool,
    error: Option<&CommandError>,
) {
    body["archiveAvailable"] = serde_json::json!(available);
    body["archiveError"] = error.map(|e| serde_json::json!({
        "code": e.code,
        "message": data_service::redact_path(&e.message, &data_service::path_replacements(paths))
    })).unwrap_or(serde_json::Value::Null);
}

#[tauri::command]
fn save_pairing_draft(
    state: State<AppState>,
    chrome_extension_id: String,
    edge_extension_id: String,
) -> Result<PairingDraft, String> {
    let host = state.host.lock().map_err(|e| e.to_string())?;
    let host = host
        .as_ref()
        .ok_or_else(|| "INSTANCE_LOCK_FAILED: unique writer is not available".to_string())?;
    let draft = PairingDraft {
        chrome_extension_id: chrome_extension_id.trim().to_string(),
        edge_extension_id: edge_extension_id.trim().to_string(),
        native_messaging_registered: false,
    };
    host.save_pairing_draft(&draft).map_err(|e| e.to_string())?;
    Ok(host.load_pairing_draft())
}

#[tauri::command]
fn list_applications_cmd(
    state: State<AppState>,
    args: ListApplicationsArgs,
) -> Result<archive_store::Page<archive_store::ApplicationSummary>, CommandError> {
    with_store(&state, |store| list_applications(store, args))
}

#[tauri::command]
fn create_application_cmd(
    state: State<AppState>,
    args: CreateApplicationArgs,
) -> Result<commands::CreateApplicationResult, CommandError> {
    with_store(&state, |store| create_application(store, args))
}

#[tauri::command]
fn get_application_cmd(
    state: State<AppState>,
    id: String,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| get_application(store, &id))
}

#[tauri::command]
fn get_snapshot_cmd(
    state: State<AppState>,
    snapshot_id: String,
) -> Result<commands::SnapshotView, CommandError> {
    with_store(&state, |store| commands::get_snapshot(store, &snapshot_id))
}

#[tauri::command]
fn import_evidence_cmd(
    state: State<AppState>,
    args: evidence_commands::ImportArgs,
) -> Result<evidence_commands::ImportReport, CommandError> {
    let bucket = evidence_commands::bucket_now();
    with_store(&state, |store| {
        evidence_commands::import_evidence(store, args.clone(), &bucket)
    })
}

#[tauri::command]
fn list_inbox_cmd(state: State<AppState>) -> Result<Vec<evidence_commands::EvidenceSummary>, CommandError> {
    with_store(&state, evidence_commands::list_inbox)
}

#[tauri::command]
fn get_evidence_preview_cmd(
    state: State<AppState>,
    evidence_id: String,
) -> Result<evidence_commands::EvidencePreview, CommandError> {
    with_store(&state, |store| {
        evidence_commands::get_preview(store, &evidence_id)
    })
}

#[tauri::command]
fn associate_evidence_cmd(
    state: State<AppState>,
    evidence_id: String,
    application_id: String,
) -> Result<evidence_commands::EvidenceSummary, CommandError> {
    with_store(&state, |store| {
        evidence_commands::associate(store, &evidence_id, &application_id)
    })
}

#[tauri::command]
fn unassociate_evidence_cmd(
    state: State<AppState>,
    evidence_id: String,
) -> Result<evidence_commands::EvidenceSummary, CommandError> {
    with_store(&state, |store| {
        evidence_commands::unassociate(store, &evidence_id)
    })
}

#[tauri::command]
fn classify_evidence_cmd(
    state: State<AppState>,
    evidence_id: String,
    reply_class: String,
    send_mode: String,
) -> Result<evidence_commands::EvidenceSummary, CommandError> {
    with_store(&state, |store| {
        evidence_commands::classify(store, &evidence_id, &reply_class, &send_mode)
    })
}

/// 用系统默认程序打开本机副本。路径在这里解析并核对在档案目录之内，**不经过 WebView**。
#[tauri::command]
fn open_evidence_cmd(
    app: tauri::AppHandle,
    state: State<AppState>,
    evidence_id: String,
) -> Result<(), CommandError> {
    let path = with_store(&state, |store| {
        evidence_commands::stored_path(store, &evidence_id)
    })?;
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|err| CommandError {
            code: "OPEN_FAILED".into(),
            message: err.to_string(),
        })
}

/// D12 要用到的那几个路径。从 HostPaths 里取，取不到就说清楚而不是猜一个。
fn restore_paths(state: &AppState) -> Result<restore::RestorePaths, CommandError> {
    let guard = state.paths.lock().map_err(|e| CommandError {
        code: "STORE_ERROR".into(),
        message: e.to_string(),
    })?;
    let paths = guard.as_ref().ok_or_else(|| CommandError {
        code: "NO_DATA_DIR".into(),
        message: "还没有定位到用户数据目录。".into(),
    })?;
    Ok(restore::RestorePaths {
        data_root: paths.data_root.clone(),
        archive_dir: paths.archive_dir.clone(),
        current_pointer: paths.current_pointer.clone(),
        archives_retired_dir: paths.archives_retired_dir.clone(),
        settings_file: paths.settings_file.clone(),
    })
}

#[tauri::command]
fn export_archive_cmd(
    state: State<AppState>,
    destination: String,
) -> Result<backup_commands::ExportReport, CommandError> {
    let paths = restore_paths(&state)?;
    let now = time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
    with_store(&state, |store| {
        backup_commands::export(store, &paths, std::path::Path::new(&destination), &now)
    })
}

#[tauri::command]
fn preview_restore_cmd(
    state: State<AppState>,
    package: String,
) -> Result<backup_commands::RestorePreview, CommandError> {
    let paths = restore_paths(&state)?;
    with_store(&state, |store| {
        backup_commands::preview(store, &paths, std::path::Path::new(&package))
    })
}

#[tauri::command]
fn restore_archive_cmd(
    state: State<AppState>,
    package: String,
) -> Result<restore::RestoreReport, CommandError> {
    let paths = restore_paths(&state)?;
    let slot = backup_commands::StoreSlot { slot: &state.store };
    backup_commands::restore(
        &slot,
        &paths,
        std::path::Path::new(&package),
        &time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
    )
}

#[tauri::command]
fn list_rollback_points_cmd(
    state: State<AppState>,
) -> Result<Vec<restore::RollbackPoint>, CommandError> {
    backup_commands::rollback_points(&restore_paths(&state)?)
}

#[tauri::command]
fn rollback_to_cmd(
    state: State<AppState>,
    id: String,
) -> Result<restore::RestoreReport, CommandError> {
    let paths = restore_paths(&state)?;
    let slot = backup_commands::StoreSlot { slot: &state.store };
    backup_commands::rollback(&slot, &paths, &id, &time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default())
}

#[tauri::command]
fn list_recycled_cmd(
    state: State<AppState>,
) -> Result<Vec<archive_store::ApplicationSummary>, CommandError> {
    with_store(&state, recycle_commands::list_recycled)
}

#[tauri::command]
fn set_recycled_cmd(
    state: State<AppState>,
    id: String,
    recycled: bool,
) -> Result<(), CommandError> {
    with_store(&state, |store| {
        recycle_commands::set_recycled(store, &id, recycled)
    })
}

#[tauri::command]
fn purge_preview_cmd(
    state: State<AppState>,
    id: String,
) -> Result<recycle_commands::PurgePreview, CommandError> {
    with_store(&state, |store| recycle_commands::purge_preview(store, &id))
}

#[tauri::command]
fn purge_application_cmd(
    state: State<AppState>,
    id: String,
) -> Result<recycle_commands::PurgeResult, CommandError> {
    let archive_dir = restore_paths(&state)?.archive_dir;
    with_store(&state, |store| {
        recycle_commands::purge(store, &archive_dir, &id)
    })
}

#[tauri::command]
fn orphan_report_cmd(
    state: State<AppState>,
) -> Result<recycle_commands::OrphanReport, CommandError> {
    with_store(&state, recycle_commands::orphan_report)
}

#[tauri::command]
fn remove_orphan_cmd(state: State<AppState>, sha256: String) -> Result<(), CommandError> {
    let archive_dir = restore_paths(&state)?.archive_dir;
    with_store(&state, |store| {
        recycle_commands::remove_orphan(store, &archive_dir, &sha256)
    })
}

#[tauri::command]
fn resume_overview_cmd(state: State<AppState>) -> Result<archive_store::ResumeOverview, CommandError> {
    with_store(&state, resume_commands::overview)
}

#[tauri::command]
fn get_resume_template_cmd(state: State<AppState>, id: String) -> Result<archive_store::ResumeTemplate, CommandError> {
    with_store(&state, |store| resume_commands::get_template(store, &id))
}

#[tauri::command]
fn import_resume_template_cmd(
    state: State<AppState>,
    path: String,
    replace_id: Option<String>,
) -> Result<resume_commands::ImportResult, CommandError> {
    with_store(&state, |store| {
        resume_commands::import_template(store, std::path::Path::new(&path), replace_id.as_deref())
    })
}

#[tauri::command]
fn export_resume_template_cmd(state: State<AppState>, id: String, path: String) -> Result<(), CommandError> {
    with_store(&state, |store| resume_commands::export_template(store, &id, std::path::Path::new(&path)))
}

#[tauri::command]
fn rename_resume_template_cmd(
    state: State<AppState>,
    id: String,
    name: String,
) -> Result<archive_store::TemplateSummary, CommandError> {
    with_store(&state, |store| resume_commands::rename_template(store, &id, &name))
}

#[tauri::command]
fn delete_resume_template_cmd(state: State<AppState>, id: String) -> Result<archive_store::ResumeOverview, CommandError> {
    with_store(&state, |store| resume_commands::delete_template(store, &id))
}

#[tauri::command]
fn set_active_resume_template_cmd(
    state: State<AppState>,
    id: String,
) -> Result<archive_store::ResumeOverview, CommandError> {
    with_store(&state, |store| resume_commands::set_active_template(store, &id))
}

#[tauri::command]
fn get_profile_cmd(state: State<AppState>) -> Result<archive_store::ProfileRecord, CommandError> {
    with_store(&state, resume_commands::get_profile)
}

#[tauri::command]
fn save_profile_cmd(
    state: State<AppState>,
    profile: serde_json::Value,
    revision: i64,
) -> Result<archive_store::ProfileRecord, CommandError> {
    with_store(&state, |store| resume_commands::save_profile(store, profile.clone(), revision))
}

#[tauri::command]
fn create_todo_cmd(
    state: State<AppState>,
    args: todo_commands::NewTodoArgs,
) -> Result<todo_commands::TodoWriteResult, CommandError> {
    let now = time::OffsetDateTime::now_utc();
    let scheduler = state.reminders.as_ref();
    with_store(&state, |store| {
        todo_commands::create_todo(store, scheduler, args.clone(), now)
    })
}

#[tauri::command]
fn edit_todo_cmd(
    state: State<AppState>,
    args: todo_commands::EditTodoArgs,
) -> Result<todo_commands::TodoWriteResult, CommandError> {
    let now = time::OffsetDateTime::now_utc();
    let scheduler = state.reminders.as_ref();
    with_store(&state, |store| {
        todo_commands::edit_todo(store, scheduler, args.clone(), now)
    })
}

#[tauri::command]
fn set_todo_status_cmd(
    state: State<AppState>,
    id: String,
    status: String,
) -> Result<todo_commands::TodoWriteResult, CommandError> {
    let now = time::OffsetDateTime::now_utc();
    let scheduler = state.reminders.as_ref();
    with_store(&state, |store| {
        todo_commands::set_todo_status(store, scheduler, &id, &status, now)
    })
}

#[tauri::command]
fn list_todos_cmd(
    state: State<AppState>,
    application_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<todo_commands::TodoView>, CommandError> {
    with_store(&state, |store| {
        todo_commands::list_todos(store, application_id.as_deref(), status.as_deref())
    })
}

#[tauri::command]
fn overdue_digest_cmd(
    state: State<AppState>,
) -> Result<todo_commands::OverdueDigest, CommandError> {
    let now = time::OffsetDateTime::now_utc();
    with_store(&state, |store| todo_commands::overdue_digest(store, now))
}

#[tauri::command]
fn reminder_capability_cmd(state: State<AppState>) -> todo_commands::ReminderCapability {
    todo_commands::reminder_capability(state.reminders.as_ref())
}

#[tauri::command]
fn update_application_cmd(
    state: State<AppState>,
    args: UpdateApplicationArgs,
) -> Result<archive_store::ApplicationDetail, CommandError> {
    with_store(&state, |store| update_application(store, args))
}

#[tauri::command]
fn add_note_cmd(
    state: State<AppState>,
    args: NoteArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| add_note(store, args))
}

#[tauri::command]
fn confirm_submit_cmd(
    state: State<AppState>,
    args: SubmitArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| confirm_submit(store, args))
}

#[tauri::command]
fn record_assessment_cmd(
    state: State<AppState>,
    args: ProgressEventArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| record_assessment(store, args))
}

#[tauri::command]
fn record_interview_cmd(
    state: State<AppState>,
    args: ProgressEventArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| record_interview(store, args))
}

#[tauri::command]
fn record_offer_cmd(
    state: State<AppState>,
    args: ProgressEventArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| record_offer(store, args))
}

#[tauri::command]
fn record_rejected_cmd(
    state: State<AppState>,
    args: ProgressEventArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| record_rejected(store, args))
}

#[tauri::command]
fn record_withdrawn_cmd(
    state: State<AppState>,
    args: ProgressEventArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| record_withdrawn(store, args))
}

#[tauri::command]
fn record_closed_cmd(
    state: State<AppState>,
    args: ProgressEventArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| record_closed(store, args))
}

#[tauri::command]
fn correct_stage_cmd(
    state: State<AppState>,
    args: CorrectStageArgs,
) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| correct_stage(store, args))
}

#[tauri::command]
fn set_recycle_cmd(
    state: State<AppState>,
    id: String,
    recycled: bool,
) -> Result<archive_store::ApplicationDetail, CommandError> {
    with_store(&state, |store| set_recycle(store, &id, recycled))
}

#[tauri::command]
fn query_candidates_cmd(
    state: State<AppState>,
    company: String,
    title: String,
    source_url: Option<String>,
) -> Result<archive_store::Candidates, CommandError> {
    with_store(&state, |store| {
        query_candidates(store, &company, &title, source_url.as_deref())
    })
}

#[tauri::command]
fn get_ai_settings_cmd(state: State<AppState>) -> Result<AiSettingsView, CommandError> {
    ai_settings_view(&state)
}

#[tauri::command]
fn save_ai_settings_cmd(
    state: State<AppState>,
    api_url: String,
    model: String,
) -> Result<AiSettingsView, CommandError> {
    let data_root = ai_data_root(&state)?;
    ai_settings::save(&data_root, &api_url, &model).map_err(|message| CommandError {
        code: "AI_SETTINGS_WRITE_FAILED".into(),
        message,
    })?;
    ai_settings_view(&state)
}

/// Key 只进凭据库。这里不写日志、不回显，连长度都不记。
#[tauri::command]
fn set_ai_key_cmd(state: State<AppState>, key: String) -> Result<AiSettingsView, CommandError> {
    state.credentials.set_key(&key).map_err(credential_error)?;
    ai_settings_view(&state)
}

#[tauri::command]
fn clear_ai_key_cmd(state: State<AppState>) -> Result<AiSettingsView, CommandError> {
    state.credentials.clear_key().map_err(credential_error)?;
    ai_settings_view(&state)
}

/// 发送前预览：这次要把什么发出去。**只读，不发请求。**
#[tauri::command]
fn preview_analysis_cmd(
    state: State<AppState>,
    evidence_id: String,
    candidate_ids: Option<Vec<String>>,
) -> Result<ai_commands::OutboundPreview, CommandError> {
    let settings = ai_settings::load(&ai_data_root(&state)?);
    checked_url(&settings.api_url)?;
    with_store(&state, |store| {
        let gathered = ai_commands::gather(
            store,
            store.archive_dir(),
            &evidence_id,
            candidate_ids.as_deref(),
        )?;
        Ok(ai_commands::preview(&gathered, &settings.api_url, &settings.model))
    })
}

/// 分析一份证据，产出一条待确认的建议。
///
/// 项目里第一个异步命令。顺序是「持锁读 → **放锁** → 发请求 → 持锁写」：
/// 请求可能要几十秒，期间不能把档案库锁住，否则插件保存岗位、界面翻列表全都卡住。
#[tauri::command]
async fn analyze_evidence_cmd(
    state: State<'_, AppState>,
    evidence_id: String,
    request_id: String,
    candidate_ids: Option<Vec<String>>,
) -> Result<ai_commands::SuggestionView, CommandError> {
    let settings = ai_settings::load(&ai_data_root(&state)?);
    checked_url(&settings.api_url)?;
    let key = state
        .credentials
        .get_key()
        .map_err(credential_error)?
        .ok_or_else(|| CommandError {
            code: "AI_NOT_CONFIGURED".into(),
            message: "还没有配置 AI Key，先去设置页填一条。".into(),
        })?;

    // 第一段：持锁读。`built` 里带着编号与本地 id 的对应关系，解析返回时要用。
    let (gathered, built) = with_store(&state, |store| {
        let gathered = ai_commands::gather(
            store,
            store.archive_dir(),
            &evidence_id,
            candidate_ids.as_deref(),
        )?;
        let built = ai_extract::build_request(
            &settings.api_url,
            &settings.model,
            &gathered.evidence,
            &gathered.candidates,
        );
        Ok((gathered, built))
    })?;

    let cancelled = state.ai_inflight.begin(&evidence_id, &request_id)?;

    let host = ai_settings::host_of(&settings.api_url);
    let client = ai_client::ChatClient::new()?;
    // 第二段：锁已经放了。取消就是不再等这个 future，上游是否继续计费我们管不着，
    // 界面文案也是这么说的。
    let outcome = tokio::select! {
        result = client.chat(&settings.api_url, &key, &host, &settings.model, &built.body) => result,
        _ = cancelled => Err(CommandError {
            code: "AI_CANCELLED".into(),
            message: "已取消。取消不保证对方停止计算或停止计费。".into(),
        }),
    };
    state.ai_inflight.finish(&request_id);

    let content = outcome?;
    let extraction = ai_extract::parse_response(&content, &built.context).map_err(|err| {
        CommandError {
            code: err.code().into(),
            message: err.message(),
        }
    })?;

    // 第三段：再持锁写。只写 ai_suggestions，一个正式字段都不动。
    with_store(&state, |store| {
        ai_commands::store_suggestion(store, &gathered, extraction, &built.scope)
    })
}

#[tauri::command]
fn cancel_analysis_cmd(state: State<AppState>, request_id: String) -> Result<bool, CommandError> {
    Ok(state.ai_inflight.cancel(&request_id))
}

#[tauri::command]
fn list_suggestions_cmd(
    state: State<AppState>,
    evidence_id: String,
) -> Result<Vec<ai_commands::SuggestionView>, CommandError> {
    with_store(&state, |store| {
        ai_commands::list_suggestions(store, &evidence_id)
    })
}

#[tauri::command]
fn confirm_suggestion_cmd(
    state: State<AppState>,
    args: ai_commands::ConfirmArgs,
) -> Result<ai_commands::ConfirmResult, CommandError> {
    let now = time::OffsetDateTime::now_utc();
    let scheduler = state.reminders.as_ref();
    with_store(&state, |store| {
        ai_commands::confirm(store, scheduler, args.clone(), now)
    })
}

#[tauri::command]
fn reject_suggestion_cmd(
    state: State<AppState>,
    suggestion_id: String,
) -> Result<ai_commands::SuggestionView, CommandError> {
    with_store(&state, |store| {
        ai_commands::set_status(store, &suggestion_id, archive_store::SuggestionStatus::Rejected)
    })
}

/// 暂存：这条建议先放着。退出重开之后还在，状态还是待处理。
#[tauri::command]
fn defer_suggestion_cmd(
    state: State<AppState>,
    suggestion_id: String,
) -> Result<ai_commands::SuggestionView, CommandError> {
    with_store(&state, |store| {
        ai_commands::set_status(store, &suggestion_id, archive_store::SuggestionStatus::Deferred)
    })
}

/// 查一次有没有新版本。**只查、只说**，不下载也不安装。
#[tauri::command]
async fn check_update_cmd(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<Option<update_check::UpdateInfo>, CommandError> {
    let data_root = ai_data_root(&state).ok();
    let latest = update_check::fetch_latest().await;
    // 查过了就记一笔，无论查到没查到——失败也不该让它每次开窗都重试。
    if let Some(root) = &data_root {
        let mut pref = update_check::load(root);
        pref.last_checked_at = Some(time::OffsetDateTime::now_utc().to_string());
        if let Err(problem) = update_check::save(root, &pref) {
            eprintln!("update: 偏好没写成：{problem}");
        }
    }
    let latest = latest?;
    // 比自己新才算数：本地跑的可能是没发过的开发版。
    let current = app.package_info().version.to_string();
    let offer = latest.filter(|info| newer_than(&info.version, &current));
    if let Ok(mut slot) = state.latest_update.lock() {
        *slot = offer.clone();
    }
    Ok(offer)
}

/// 打开上一次查到的那个下载页。
///
/// 不收前端传来的地址：那等于给界面开了一个「用系统浏览器打开任意 URL」的口子。
#[tauri::command]
fn open_update_page_cmd(state: State<AppState>, app: AppHandle) -> Result<(), CommandError> {
    let url = state
        .latest_update
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|info| info.url.clone()))
        .ok_or_else(|| CommandError {
            code: "UPDATE_NOT_CHECKED".into(),
            message: "还没查到可下载的版本。".into(),
        })?;
    // 和筛选阶段同一把尺子：`https://github.com/` 前缀太松，本仓库以外的
    // Release 页也能过。两处用同一个函数，免得哪天改了一处。
    if !update_check::is_release_page(&url) {
        return Err(CommandError {
            code: "UPDATE_BAD_URL".into(),
            message: format!("这个下载地址不像 Release 页，没有打开：{url}"),
        });
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|err| CommandError {
            code: "OPEN_FAILED".into(),
            message: format!("打不开下载页：{err}"),
        })
}

fn newer_than(candidate: &str, current: &str) -> bool {
    let parse = |value: &str| -> Option<Vec<u32>> {
        let parts: Vec<&str> = value.split('.').collect();
        (parts.len() == 3)
            .then(|| parts.iter().map(|p| p.parse::<u32>().ok()).collect())
            .flatten()
    };
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        // 认不出的版本号就别提示升级。
        _ => false,
    }
}

#[tauri::command]
fn get_update_preference_cmd(state: State<AppState>) -> update_check::UpdatePreference {
    match ai_data_root(&state) {
        Ok(root) => update_check::load(&root),
        Err(_) => update_check::UpdatePreference::default(),
    }
}

#[tauri::command]
fn set_update_preference_cmd(
    state: State<AppState>,
    enabled: bool,
) -> Result<update_check::UpdatePreference, CommandError> {
    let root = ai_data_root(&state)?;
    let mut pref = update_check::load(&root);
    pref.enabled = enabled;
    update_check::save(&root, &pref).map_err(|message| CommandError {
        code: "UPDATE_PREF_FAILED".into(),
        message,
    })?;
    Ok(pref)
}

/// 扩展的商店页。URL 只有这一份，前端不另抄：改成别的商店或换 ID 时只改这里。
#[tauri::command]
fn open_extension_store_cmd(app: AppHandle) -> Result<(), CommandError> {
    let url = format!(
        "https://chromewebstore.google.com/detail/{}",
        nm_register::STORE_EXTENSION_ID
    );
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|err| CommandError {
            code: "OPEN_FAILED".into(),
            message: format!("打不开商店页：{err}"),
        })
}

/// 打开当前桌面版本的 GitHub Release 页，让用户下载同一页里的插件 zip。
///
/// 地址由本机版本号拼出来，不收前端传来的 URL。
#[tauri::command]
fn open_plugin_release_cmd(app: AppHandle) -> Result<(), CommandError> {
    let url = update_check::desktop_release_tag_url(&app.package_info().version.to_string());
    if !update_check::is_release_page(&url) {
        return Err(CommandError {
            code: "UPDATE_BAD_URL".into(),
            message: format!("这个下载地址不像 Release 页，没有打开：{url}"),
        });
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<&str>)
        .map_err(|err| CommandError {
            code: "OPEN_FAILED".into(),
            message: format!("打不开插件下载页：{err}"),
        })
}

/// 手动重试注册。用户装完浏览器、或者上一次因为权限失败时点它。
#[tauri::command]
fn register_native_messaging_cmd(state: State<AppState>) -> Vec<nm_register::Outcome> {
    refresh_native_messaging(&state)
}

#[tauri::command]
fn hide_main_window_cmd(app: AppHandle) -> Result<(), String> {
    lifecycle::hide_main_window(&app);
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    // 主动退出默认撤销尚未触发的提醒：进程走了就别留下会替它说话的东西。
    // 界面在按下退出之前已经告知过这一点（PR6 的文案）。
    let cancelled = todo_commands::cancel_all_reminders(state.reminders.as_ref());
    if let Ok(paths) = state.paths.lock() {
        if let Some(paths) = paths.as_ref() {
            let _ = write_log(paths, "info", "APP_QUIT", &[("reason", "explicit")]);
            // 撤销失败就意味着我们刚跟用户说的「退出后不会弹提醒」不成立。
            // 拦不住退出，但至少要在诊断里留下痕迹，别让它无声无息。
            if let Err(error) = &cancelled {
                let _ = write_log(
                    paths,
                    "error",
                    "REMINDER_CANCEL_FAILED",
                    &[("at", "quit"), ("code", &error.code)],
                );
            }
        }
    }
    app.exit(0);
    Ok(())
}

fn configure_webview_cache() {
    let Ok(paths) = HostPaths::resolve() else {
        return;
    };
    let info = data_service::webview_storage(&paths);
    let _ = std::fs::create_dir_all(&info.app_cache_dir);
    if info.managed_by_app {
        if let Some(dir) = info.webview_data_dir {
            let _ = std::fs::create_dir_all(&dir);
            #[cfg(windows)]
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
        }
    }
}

fn run_apps_loop() -> Result<serde_json::Value, CommandError> {
    // Diagnostic/demo data must never enter the configured user archive.
    let base = (0..1000)
        .find_map(|_| {
            let candidate = std::env::temp_dir().join(format!(
                "resumepro-d04-loop-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            std::fs::create_dir(&candidate).ok().map(|_| candidate)
        })
        .ok_or_else(|| CommandError {
            code: "STORE_OPEN_FAILED".into(),
            message: "Cannot create isolated demo directory".into(),
        })?;
    let archive = base.join("archive");
    let pointer = base.join("current.json");
    std::fs::create_dir_all(&archive).map_err(|e| CommandError {
        code: "STORE_OPEN_FAILED".into(),
        message: e.to_string(),
    })?;
    let first = {
        let store = open_store(&archive, &pointer)?;
        application_manager_loop(&store)?
    };
    let store = open_store(&archive, &pointer)?;
    let id = first
        .get("firstId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CommandError {
            code: "STORE_ERROR".into(),
            message: "loop missing firstId".into(),
        })?;
    let reopened = get_application(&store, id)?;
    Ok(serde_json::json!({
        "ok": true,
        "isolatedDir": base.display().to_string(),
        "loop": first,
        "reopenedStage": reopened.application.current_stage,
        "reopenedEvents": reopened.events.len(),
        "reopenedTitle": reopened.application.title,
    }))
}

pub fn run() {
    let args = cli::parse();
    if args.help {
        cli::print_help();
        return;
    }
    // Before every branch that prints: --probe and --apps-loop both write to stdout, and
    // stdout in this mode carries protocol frames only.
    if args.nm_host {
        // Pairing is consulted only when there is an origin to authorise. Loading it
        // unconditionally would send the --nm-host test entry point to the real settings
        // file, which is exactly what the isolated data directories are meant to prevent.
        let caller = match args.origin.as_deref() {
            None => {
                eprintln!("nm-host: no caller origin supplied");
                nm::Caller::Unidentified
            }
            Some(origin) => {
                // Read-only: this process is the translator, not the writer, so it must
                // not create the layout or take the lock the application process owns.
                let allowed = match data_service::HostPaths::resolve() {
                    Ok(paths) => nm::allowed_origins_from(&data_service::read_pairing_draft_at(
                        &paths.settings_file,
                    )),
                    Err(err) => {
                        eprintln!(
                            "nm-host: cannot resolve data paths, treating as unpaired: {err:?}"
                        );
                        Vec::new()
                    }
                };
                let caller = nm::authorise(Some(origin), &allowed);
                match &caller {
                    nm::Caller::Authorised(_) => {
                        eprintln!("nm-host: authorised caller {origin}")
                    }
                    _ => eprintln!("nm-host: caller {origin} is not paired with this desktop"),
                }
                caller
            }
        };
        let mut input = std::io::stdin();
        let mut output = std::io::stdout();
        // Anything the host cannot answer alone goes to the application over the local
        // endpoint, started with --hidden if it is not there. Without a resolvable data
        // directory there is nothing to reach, and every such request answers
        // unavailable through the backend's own error path.
        let exit = match (
            data_service::HostPaths::resolve(),
            ipc_client::own_program(),
        ) {
            (Ok(paths), Ok(program)) => {
                let mut backend = nm::AppBackend {
                    data_root: paths.data_root,
                    program,
                };
                nm::serve_with(&caller, &mut input, &mut output, &mut backend)
            }
            (paths, program) => {
                if let Err(err) = paths {
                    eprintln!("nm-host: no data directory to reach the application in: {err:?}");
                }
                if let Err(err) = program {
                    eprintln!("nm-host: cannot identify this executable: {err}");
                }
                nm::serve(&caller, &mut input, &mut output)
            }
        };
        std::process::exit(exit);
    }
    if args.apps_loop {
        match run_apps_loop() {
            Ok(report) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report).unwrap_or_else(|e| e.to_string())
                );
                std::process::exit(0);
            }
            Err(err) => {
                eprintln!(
                    "{}",
                    serde_json::to_string(&err).unwrap_or_else(|_| err.message.clone())
                );
                std::process::exit(2);
            }
        }
    }
    if args.probe {
        let mut report = probe();
        report.app_version = env!("CARGO_PKG_VERSION").to_string();
        match serde_json::to_string_pretty(&report) {
            Ok(text) => println!("{text}"),
            Err(e) => {
                eprintln!("{{\"ok\":false,\"code\":\"LOG_WRITE_FAILED\",\"message\":\"{e}\"}}");
                std::process::exit(2);
            }
        }
        std::process::exit(if report.ok { 0 } else { 2 });
    }

    configure_webview_cache();

    let hidden_launch = args.hidden;
    let quit_launch = args.quit;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let wants_hidden = argv.iter().any(|a| a == "--hidden");
            let wants_probe = argv.iter().any(|a| a == "--probe");
            let wants_quit = argv.iter().any(|a| a == "--quit");
            if wants_quit {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(paths) = state.paths.lock() {
                        if let Some(paths) = paths.as_ref() {
                            let _ = write_log(paths, "info", "APP_QUIT", &[("reason", "cli")]);
                        }
                    }
                }
                app.exit(0);
                return;
            }
            if !wants_hidden && !wants_probe {
                lifecycle::show_main_window(app);
            }
            if let Some(paths) = app
                .try_state::<AppState>()
                .and_then(|s| s.paths.lock().ok().and_then(|p| p.clone()))
            {
                let _ = write_log(
                    &paths,
                    "info",
                    "INSTANCE_REACTIVATED",
                    &[("hidden", if wants_hidden { "true" } else { "false" })],
                );
            }
        }))
        .manage(AppState {
            host: Mutex::new(None),
            ipc: Mutex::new(None),
            host_error: Mutex::new(None),
            paths: Mutex::new(HostPaths::resolve().ok()),
            store: Arc::new(Mutex::new(None)),
            store_error: Mutex::new(None),
            hidden_launch,
            reminders: reminders::scheduler(),
            credentials: Box::new(ai_credentials::KeyringStore),
            ai_inflight: ai_commands::InflightRegistry::default(),
            native_messaging: Mutex::new(Vec::new()),
            latest_update: Mutex::new(None),
        })
        .setup(move |app| {
            if quit_launch {
                app.handle().exit(0);
                return Ok(());
            }
            match DataHost::initialize() {
                Ok(host) => {
                    if let Ok(mut paths) = app.state::<AppState>().paths.lock() {
                        *paths = Some(host.paths().clone());
                    }
                    match open_store(&host.paths().archive_dir, &host.paths().current_pointer) {
                        Ok(store) => {
                            if let Ok(mut slot) = app.state::<AppState>().store.lock() {
                                *slot = Some(store);
                            }
                        }
                        Err(err) => {
                            if let Ok(mut slot) = app.state::<AppState>().store_error.lock() {
                                *slot = Some(err);
                            }
                        }
                    }
                    // Only now: holding host.lock is what entitles this process to be
                    // the one listening (D01 decision 3).
                    let application = Arc::new(ipc_server::OpenArchive::new(Arc::clone(
                        &app.state::<AppState>().store,
                    )));
                    match ipc_server::start(&host.paths().data_root, application) {
                        Ok(service) => {
                            eprintln!("ipc: serving on {}", service.endpoint());
                            if let Ok(mut slot) = app.state::<AppState>().ipc.lock() {
                                *slot = Some(service);
                            }
                        }
                        Err(err) => {
                            // The window and the archive still work; only the browser
                            // connection is unavailable, and it says so on its own.
                            eprintln!("ipc: not serving: {err}");
                        }
                    }
                    if let Ok(mut slot) = app.state::<AppState>().host.lock() {
                        *slot = Some(host);
                    }
                }
                Err(err) => {
                    if err.code() == data_service::INSTANCE_LOCK_FAILED {
                        lifecycle::show_main_window(app.handle());
                        app.handle().exit(0);
                        return Ok(());
                    }
                    if let Ok(mut slot) = app.state::<AppState>().host_error.lock() {
                        *slot = Some(err.to_dto());
                    }
                }
            }

            // 浏览器要靠这份清单才找得到 host。放在这里：paths 已经有了，窗口还没显示。
            refresh_native_messaging(&app.state::<AppState>());

            lifecycle::install_window_close_handler(app.handle());
            build_tray(app.handle())?;

            if hidden_launch {
                lifecycle::hide_main_window(app.handle());
            } else if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            export_diagnostics,
            save_pairing_draft,
            register_native_messaging_cmd,
            open_extension_store_cmd,
            open_plugin_release_cmd,
            check_update_cmd,
            open_update_page_cmd,
            get_update_preference_cmd,
            set_update_preference_cmd,
            hide_main_window_cmd,
            quit_app,
            list_applications_cmd,
            create_application_cmd,
            get_application_cmd,
            get_snapshot_cmd,
            import_evidence_cmd,
            list_inbox_cmd,
            get_evidence_preview_cmd,
            associate_evidence_cmd,
            unassociate_evidence_cmd,
            classify_evidence_cmd,
            open_evidence_cmd,
            resume_overview_cmd,
            get_resume_template_cmd,
            import_resume_template_cmd,
            export_resume_template_cmd,
            rename_resume_template_cmd,
            delete_resume_template_cmd,
            set_active_resume_template_cmd,
            get_profile_cmd,
            save_profile_cmd,
            create_todo_cmd,
            edit_todo_cmd,
            set_todo_status_cmd,
            list_todos_cmd,
            overdue_digest_cmd,
            reminder_capability_cmd,
            export_archive_cmd,
            preview_restore_cmd,
            restore_archive_cmd,
            list_rollback_points_cmd,
            rollback_to_cmd,
            list_recycled_cmd,
            set_recycled_cmd,
            purge_preview_cmd,
            purge_application_cmd,
            orphan_report_cmd,
            remove_orphan_cmd,
            update_application_cmd,
            add_note_cmd,
            confirm_submit_cmd,
            record_assessment_cmd,
            record_interview_cmd,
            record_offer_cmd,
            record_rejected_cmd,
            record_withdrawn_cmd,
            record_closed_cmd,
            correct_stage_cmd,
            set_recycle_cmd,
            query_candidates_cmd,
            get_ai_settings_cmd,
            save_ai_settings_cmd,
            set_ai_key_cmd,
            clear_ai_key_cmd,
            preview_analysis_cmd,
            analyze_evidence_cmd,
            cancel_analysis_cmd,
            list_suggestions_cmd,
            confirm_suggestion_cmd,
            reject_suggestion_cmd,
            defer_suggestion_cmd
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(paths) = state.paths.lock() {
                        if let Some(paths) = paths.as_ref() {
                            let _ = write_log(
                                paths,
                                "info",
                                "WINDOW_HIDDEN",
                                &[("reason", "close-requested")],
                            );
                        }
                    }
                }
                #[cfg(target_os = "macos")]
                {
                    let _ = window
                        .app_handle()
                        .set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Resume Pro Desktop");
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开", true, None::<&str>)?;
    // §5.4：退出会撤销还没到点的提醒。托盘上弹不了确认框，所以把结果写进菜单项本身。
    let quit = MenuItem::with_id(app, "quit", "退出（提醒也会停）", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Resume Pro Desktop")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => lifecycle::show_main_window(app),
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(paths) = state.paths.lock() {
                        if let Some(paths) = paths.as_ref() {
                            let _ = write_log(paths, "info", "APP_QUIT", &[("reason", "tray")]);
                        }
                    }
                    // 和设置页那个退出走同一条路：撤销所有还没到点的提醒。
                    if let Err(error) = todo_commands::cancel_all_reminders(state.reminders.as_ref())
                    {
                        if let Ok(paths) = state.paths.lock() {
                            if let Some(paths) = paths.as_ref() {
                                let _ = write_log(
                                    paths,
                                    "error",
                                    "REMINDER_CANCEL_FAILED",
                                    &[("at", "tray"), ("code", &error.code)],
                                );
                            }
                        }
                    }
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                lifecycle::show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    } else {
        builder = builder.icon(Image::from_bytes(include_bytes!("../icons/icon.png")).unwrap());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod newer_than_tests {
    use super::newer_than;

    #[test]
    fn a_higher_release_is_newer_and_an_equal_or_lower_one_is_not() {
        assert!(newer_than("0.4.1", "0.4.0"));
        assert!(!newer_than("0.4.0", "0.4.0"));
        assert!(!newer_than("0.3.9", "0.4.0"));
        // 按数字比，不是按字符串：0.10.0 比 0.9.0 新。
        assert!(newer_than("0.10.0", "0.9.0"));
    }

    #[test]
    fn a_beta_build_is_not_told_to_upgrade() {
        // 目前测试版只面向我们自己：它认不出自己带 -beta 的版本号，于是不提示升级。
        // 想换到新的测试版或回到正式版，要自己到 Releases 页下载（见 install-and-update.md 5.1）。
        // 开放给用户选装测试版时，这里要改成按通道比较，并同步改这条测试。
        assert!(!newer_than("0.4.0", "0.4.0-beta.1"));
        assert!(!newer_than("0.4.1", "0.4.0-beta.1"));
    }

    #[test]
    fn a_beta_release_is_never_offered_to_a_stable_build() {
        assert!(!newer_than("0.4.1-beta.1", "0.4.0"));
    }
}
