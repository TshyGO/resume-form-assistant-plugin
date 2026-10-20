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

/// Deletion remains available when cloud journal/workspace/config is broken.
/// Missing secrets prevent future starts; replacements still require durable
/// baseline invalidation through the stricter write path.
pub fn clear_credential(
    service: Option<&Arc<Service>>,
    kind: Kind,
    suspend: impl FnOnce() -> Result<()>,
    clear: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let _guard = service.map(|s| s.credential_guard()).transpose()?;
    let suspended = suspend().is_ok();
    if let Some(service) = service {
        if !suspended {
            let _ = service.cancel_automatic();
            service.scheduler_failed();
        }
        if matches!(kind, Kind::BackupPassphrase) {
            // Failure to update the journal must not prevent OS-key deletion.
            // A future replacement cannot bypass the strict invalidation path.
            let _ = service.invalidate_passphrase();
        }
    }
    clear()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleting_secrets_does_not_require_a_working_cloud_service_or_settings() {
        let removed = std::cell::Cell::new(false);
        clear_credential(
            None,
            Kind::BackupPassphrase,
            || Err(cloud_backup::fail("INVALID_SETTINGS")),
            || {
                removed.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(removed.get());
        let error = clear_credential(
            None,
            Kind::WebdavPassword,
            || Ok(()),
            || Err(cloud_backup::fail("CREDENTIAL_STORE_UNAVAILABLE")),
        )
        .unwrap_err();
        assert_eq!(error.code, "CLOUD_CREDENTIAL_STORE_UNAVAILABLE");
    }
}

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
    if let Err(e) = service.manual_job() {
        service.start_failed(e.clone(), &lease.cancel);
        return Err(e);
    }
    drop(credentials_guard);
    tauri::async_runtime::spawn(service.run(lease, client, passphrase, !retry));
    Ok(job)
}
