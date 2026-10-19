//! Application-only scheduler; no OS tasks, webview timer or background service.
use crate::{
    cloud_backup::{
        self,
        schedule::{Plan, Status},
        Service,
    },
    cloud_backup_commands as commands,
    cloud_credentials::{Binding, Kind},
    cloud_settings,
    commands::CommandError,
    AppState,
};
use tauri::{AppHandle, Manager};
type Result<T> = std::result::Result<T, CommandError>;

pub fn status(state: &AppState) -> Result<Status> {
    let guard = state
        .host
        .lock()
        .map_err(|_| cloud_backup::fail("LOCAL_STATE"))?;
    let host = guard
        .as_ref()
        .ok_or_else(|| cloud_backup::fail("WORKSPACE_UNAVAILABLE"))?;
    let config = cloud_settings::load(&host.paths().settings_file)?;
    let service = commands::service(state)?;
    let binding = config
        .as_ref()
        .map(|c| -> Result<String> {
            Ok(Service::binding(
                &Service::scope(&Binding::checked(&c.connection)?),
                &c.options,
                &service.identity()?,
            ))
        })
        .transpose()?;
    service.schedule_status(
        config.as_ref().is_some_and(|c| c.automatic_enabled),
        config.as_ref().is_some_and(|c| c.requires_confirmation),
        binding.as_deref(),
    )
}

pub fn configure(state: &AppState, plan: Option<Plan>) -> Result<()> {
    let guard = state
        .host
        .lock()
        .map_err(|_| cloud_backup::fail("LOCAL_STATE"))?;
    let host = guard
        .as_ref()
        .ok_or_else(|| cloud_backup::fail("WORKSPACE_UNAVAILABLE"))?;
    let path = &host.paths().settings_file;
    let mut config =
        cloud_settings::load(path)?.ok_or_else(|| cloud_backup::fail("INVALID_SETTINGS"))?;
    config.automatic_enabled = false;
    cloud_settings::save(path, &config)?;
    let service = commands::service(state)?;
    service.cancel_automatic()?;
    if let Some(plan) = plan {
        let (_, binding) = commands::client(state, &config.connection)?;
        if config.options.encrypted
            && state
                .cloud_credentials
                .read(&binding, Kind::BackupPassphrase)?
                .is_none()
        {
            return Err(cloud_backup::fail("MISSING_PASSPHRASE"));
        }
        service.configure(
            plan,
            &Service::scope(&binding),
            &config.options,
            time::OffsetDateTime::now_utc().unix_timestamp(),
        )?;
        config.automatic_enabled = true;
        config.requires_confirmation = false;
        cloud_settings::save(path, &config)?;
    }
    Ok(())
}

fn tick(state: &AppState, previous: Option<i64>) -> Result<()> {
    if state
        .quit_guard
        .lock()
        .map_err(|_| cloud_backup::fail("LOCAL_STATE"))?
        .is_some()
    {
        return Ok(());
    }
    let guard = state
        .host
        .lock()
        .map_err(|_| cloud_backup::fail("LOCAL_STATE"))?;
    let host = guard
        .as_ref()
        .ok_or_else(|| cloud_backup::fail("WORKSPACE_UNAVAILABLE"))?;
    let Some(config) = cloud_settings::load(&host.paths().settings_file)? else {
        return Ok(());
    };
    if !config.automatic_enabled || config.requires_confirmation {
        return Ok(());
    }
    let service = commands::service(state)?;
    let scope = Service::scope(&Binding::checked(&config.connection)?);
    let Some((job, lease, fresh)) =
        service.automatic_action_clock(&scope, &config.options, previous, || {
            time::OffsetDateTime::now_utc().unix_timestamp()
        })?
    else {
        return Ok(());
    };
    drop(guard); // OS credential prompts must not hold the settings/restore gate.
    let credentials = (|| {
        let _credentials_guard = service.credential_guard()?;
        let (client, binding) = commands::client(state, &config.connection)?;
        let passphrase = if fresh && job.options.encrypted {
            Some(
                state
                    .cloud_credentials
                    .read(&binding, Kind::BackupPassphrase)?
                    .ok_or_else(|| cloud_backup::fail("MISSING_PASSPHRASE"))?,
            )
        } else {
            None
        };
        // Recheck the authoritative gate after a possibly blocking OS read.
        // Credential edits/restore can proceed meanwhile and cancel this lease.
        let guard = state
            .host
            .lock()
            .map_err(|_| cloud_backup::fail("LOCAL_STATE"))?;
        let host = guard
            .as_ref()
            .ok_or_else(|| cloud_backup::fail("WORKSPACE_UNAVAILABLE"))?;
        let current = cloud_settings::load(&host.paths().settings_file)?;
        if !current.as_ref().is_some_and(|c| {
            c.automatic_enabled
                && !c.requires_confirmation
                && c.connection.connection_id == config.connection.connection_id
                && c.connection.endpoint == config.connection.endpoint
                && c.connection.username == config.connection.username
                && c.options.root == config.options.root
                && c.options.encrypted == config.options.encrypted
        }) || lease.cancel.is_cancelled()
            || Service::binding(&scope, &config.options, &service.identity()?) != job.binding
        {
            return Err(cloud_backup::fail("CANCELLED"));
        }
        Ok((client, passphrase))
    })();
    match credentials {
        Ok((client, passphrase)) => {
            tauri::async_runtime::spawn(service.run(lease, client, passphrase, fresh));
        }
        Err(e) => {
            service.start_failed(e, &lease.cancel);
        }
    }
    Ok(())
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut previous = None;
        let mut last_failure: Option<String> = None;
        loop {
            let now = time::OffsetDateTime::now_utc().unix_timestamp();
            let handle = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                tick(&handle.state::<AppState>(), previous)
            })
            .await;
            let failure = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error.code),
                Err(_) => Some("CLOUD_SCHEDULER_WORKER_FAILED".into()),
            };
            if failure != last_failure {
                if let Some(code) = failure.as_ref() {
                    let handle = app.clone();
                    let code = code.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        let state = handle.state::<AppState>();
                        if let Ok(service) = commands::service(&state) {
                            service.scheduler_failed();
                        }
                        // Only safe error codes, never settings, paths or secrets.
                        if let Ok(paths) = state.paths.lock() {
                            if let Some(paths) = paths.as_ref() {
                                let _ = data_service::write_log(
                                    paths,
                                    "warn",
                                    "CLOUD_SCHEDULER_ERROR",
                                    &[("code", code.as_str())],
                                );
                            }
                        };
                    })
                    .await;
                }
            }
            last_failure = failure; // Suppress repeated identical failures/logs.
            previous = Some(now);
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}
