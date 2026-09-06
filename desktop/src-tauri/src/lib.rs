mod cli;
mod commands;
mod lifecycle;

use archive_store::ArchiveStore;
use commands::{
    add_note, application_manager_loop, confirm_submit, correct_stage, create_application,
    get_application, list_applications, open_store, query_candidates, record_assessment,
    record_closed, record_interview, record_offer, record_rejected, record_withdrawn, set_recycle,
    update_application, CommandError, CorrectStageArgs, CreateApplicationArgs, ListApplicationsArgs,
    NoteArgs, ProgressEventArgs, SubmitArgs, UpdateApplicationArgs,
};
use data_service::{
    diagnostics_from, probe, write_diagnostics_file, write_log, DataHost, HostErrorDto, HostPaths,
    PairingDraft,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

pub use cli::prepare_stdio;

struct AppState {
    host: Mutex<Option<DataHost>>,
    host_error: Mutex<Option<HostErrorDto>>,
    paths: Mutex<Option<HostPaths>>,
    store: Mutex<Option<ArchiveStore>>,
    store_error: Mutex<Option<CommandError>>,
    hidden_launch: bool,
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
        writable: host
            .as_ref()
            .map(|h| h.is_writable().is_ok())
            .unwrap_or(false),
        unique_writer,
        window_visible,
        hidden_launch: state.hidden_launch,
        autostart_enabled: false,
        native_messaging_registered: false,
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
        ("hiddenLaunch", if state.hidden_launch { "true" } else { "false" }),
    ];
    let body = diagnostics_from(&paths, unique, &extra);
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
fn get_application_cmd(state: State<AppState>, id: String) -> Result<commands::ApplicationView, CommandError> {
    with_store(&state, |store| get_application(store, &id))
}

#[tauri::command]
fn update_application_cmd(
    state: State<AppState>,
    args: UpdateApplicationArgs,
) -> Result<archive_store::ApplicationDetail, CommandError> {
    with_store(&state, |store| update_application(store, args))
}

#[tauri::command]
fn add_note_cmd(state: State<AppState>, args: NoteArgs) -> Result<commands::ApplicationView, CommandError> {
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
    with_store(&state, |store| query_candidates(store, &company, &title, source_url.as_deref()))
}

#[tauri::command]
fn hide_main_window_cmd(app: AppHandle) -> Result<(), String> {
    lifecycle::hide_main_window(&app);
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if let Ok(paths) = state.paths.lock() {
        if let Some(paths) = paths.as_ref() {
            let _ = write_log(paths, "info", "APP_QUIT", &[("reason", "explicit")]);
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
    let base = std::env::var_os("RESUMEPRO_DATA_DIR")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "resumepro-d04-loop-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ))
        });
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
    if args.apps_loop {
        match run_apps_loop() {
            Ok(report) => {
                println!("{}", serde_json::to_string_pretty(&report).unwrap_or_else(|e| e.to_string()));
                std::process::exit(0);
            }
            Err(err) => {
                eprintln!("{}", serde_json::to_string(&err).unwrap_or_else(|_| err.message.clone()));
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
            host_error: Mutex::new(None),
            paths: Mutex::new(HostPaths::resolve().ok()),
            store: Mutex::new(None),
            store_error: Mutex::new(None),
            hidden_launch,
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
            hide_main_window_cmd,
            quit_app,
            list_applications_cmd,
            create_application_cmd,
            get_application_cmd,
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
            query_candidates_cmd
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
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
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
