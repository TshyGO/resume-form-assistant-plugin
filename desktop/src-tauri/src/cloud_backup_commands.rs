//! Tauri API for #306. Configuration persistence and visible controls belong to
//! the UI issue; this boundary never serializes credentials or response bodies.
use crate::{
    cloud_backup::{self, model::*, Service},
    cloud_credentials::{Binding, ConnectionDescriptor, Kind},
    commands::CommandError,
    AppState,
};
use std::sync::Arc;
use webdav_client::Client;
type Result<T> = std::result::Result<T, CommandError>;

pub fn service(state: &AppState) -> Result<Arc<Service>> {
    state
        .cloud_backups
        .lock()
        .map_err(|_| cloud_backup::fail("LOCAL_STATE"))?
        .clone()
        .ok_or_else(|| cloud_backup::fail("WORKSPACE_UNAVAILABLE"))
}
pub fn client(state: &AppState, descriptor: &ConnectionDescriptor) -> Result<(Client, Binding)> {
    let binding = Binding::checked(descriptor)?;
    let password = state
        .cloud_credentials
        .read(&binding, Kind::WebdavPassword)?
        .ok_or_else(|| cloud_backup::fail("MISSING_WEBDAV_PASSWORD"))?;
    Ok((
        Client::new(&descriptor.endpoint, descriptor.username.clone(), password)?,
        binding,
    ))
}
pub fn start(
    state: &AppState,
    connection: ConnectionDescriptor,
    options: Options,
    retry: bool,
) -> Result<Job> {
    let service = service(state)?;
    let credentials_guard = service.credential_guard()?;
    let (client, binding) = client(state, &connection)?;
    let passphrase = if options.encrypted && !retry {
        Some(
            state
                .cloud_credentials
                .read(&binding, Kind::BackupPassphrase)?
                .ok_or_else(|| cloud_backup::fail("MISSING_PASSPHRASE"))?,
        )
    } else {
        None
    };
    let scope = Service::scope(&binding);
    let (job, lease) = if retry {
        service.retry(&scope, &options)?
    } else {
        service.begin(options, scope)?
    };
    if let Err(e) = service.manual_job() { service.start_failed(e.clone(), &lease.cancel); return Err(e); }
    drop(credentials_guard);
    tauri::async_runtime::spawn(service.run(lease, client, passphrase, !retry));
    Ok(job)
}
