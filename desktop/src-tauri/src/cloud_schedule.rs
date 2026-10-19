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
    let credentials = (|| {
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
        loop {
            let now = time::OffsetDateTime::now_utc().unix_timestamp();
            let handle = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                tick(&handle.state::<AppState>(), previous)
            })
            .await;
            previous = Some(now);
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}
