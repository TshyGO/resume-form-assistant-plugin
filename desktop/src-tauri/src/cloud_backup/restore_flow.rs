//! Only a backend-owned verified task can authorize a cloud restore.
use super::*;
use crate::backup_commands::{self, RestorePreview, StoreSlot};
use serde::Serialize;
use std::time::{Duration, Instant};

pub(super) struct Pending {
    pub(super) token: String,
    _task: TaskDirectory,
    pub(super) package: PathBuf,
    hash: String,
    pub(super) expires: Instant,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub backup_id: String,
    expires_at: String,
    preview: RestorePreview,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub report: crate::restore::RestoreReport,
    pub cleanup_warning: bool,
    pub refresh_warning: bool,
}
impl Service {
    fn close_preview_task(&self, task: TaskDirectory) -> bool {
        let failed = task.close().is_err();
        if failed {
            self.preview_cleanup_warning
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        failed
    }
    pub async fn download_preview(
        self: &Arc<Self>,
        client: &impl remote::Remote,
        options: &Options,
        metadata: Metadata,
        passphrase: Option<SecretString>,
    ) -> Result<Preview> {
        let lease = self.reserve()?;
        // A new selection invalidates the previous confirmation, including on failure.
        self.clear_preview_inner()?;
        let id = metadata.backup_id.clone();
        let (task, package) = self
            .download_inner(client, options, metadata, passphrase, &lease.cancel)
            .await?;
        let service = self.clone();
        let cancel = lease.cancel.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (_, hash) = local::hash(&package, &cancel)?;
            let store = service.store.lock().map_err(|_| fail("LOCAL_STATE"))?;
            let preview =
                backup_commands::preview_optional(store.as_ref(), &service.paths, &package)?;
            drop(store);
            if cancel.is_cancelled() {
                return Err(fail("CANCELLED"));
            }
            let token = uuid::Uuid::new_v4().to_string();
            let expires_at = (time::OffsetDateTime::now_utc() + time::Duration::minutes(10))
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| fail("INVALID_DATE"))?;
            *service.preview.lock().map_err(|_| fail("LOCAL_STATE"))? = Some(Pending {
                token: token.clone(),
                _task: task,
                package,
                hash,
                expires: Instant::now() + Duration::from_secs(600),
            });
            let expiry_service = service.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(600)).await;
                let _ =
                    tauri::async_runtime::spawn_blocking(move || expiry_service.expire_preview())
                        .await;
            });
            Ok(Preview {
                token,
                backup_id: id,
                expires_at,
                preview,
            })
        })
        .await
        .map_err(|_| fail("WORKER_FAILED"))?
    }
    fn clear_preview_inner(&self) -> Result<()> {
        let pending = self.preview.lock().map_err(|_| fail("LOCAL_STATE"))?.take();
        if let Some(pending) = pending {
            if self.close_preview_task(pending._task) {
                return Err(fail("CLEANUP_UNCONFIRMED"));
            }
        }
        Ok(())
    }
    pub(super) fn expire_preview(&self) -> Result<()> {
        let mut guard = self.preview.lock().map_err(|_| fail("LOCAL_STATE"))?;
        if guard.as_ref().is_some_and(|p| Instant::now() >= p.expires) {
            let pending = guard.take().unwrap();
            drop(guard);
            if self.close_preview_task(pending._task) {
                return Err(fail("CLEANUP_UNCONFIRMED"));
            }
        }
        Ok(())
    }
    pub fn clear_preview(self: &Arc<Self>) -> Result<()> {
        let _lease = self.reserve()?;
        self.clear_preview_inner()
    }
    pub fn confirm_restore(
        self: &Arc<Self>,
        token: &str,
        before_activation: impl FnOnce() -> Result<()>,
    ) -> Result<RestoreOutcome> {
        let lease = self.reserve()?;
        let pending = self
            .preview
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .take()
            .ok_or_else(|| fail("PREVIEW_EXPIRED"))?;
        let outcome = (|| {
            if pending.token != token || Instant::now() >= pending.expires {
                return Err(fail("PREVIEW_EXPIRED"));
            }
            let (_, hash) = local::hash(&pending.package, &lease.cancel)?;
            if hash != pending.hash {
                return Err(fail("PREVIEW_CHANGED"));
            }
            let prepared = crate::restore::prepare_restore(&self.paths, &pending.package)?;
            let (_, hash) = local::hash(&pending.package, &lease.cancel)?;
            if hash != pending.hash {
                return Err(fail("PREVIEW_CHANGED"));
            }
            if lease.cancel.is_cancelled() {
                return Err(fail("CANCELLED"));
            }
            if Instant::now() >= pending.expires {
                return Err(fail("PREVIEW_EXPIRED"));
            }
            before_activation()?;
            backup_commands::restore_prepared(
                &StoreSlot { slot: &self.store },
                &self.paths,
                prepared,
                &model::now(),
            )
        })();
        let cleanup_warning = self.close_preview_task(pending._task);
        match outcome {
            Ok(report) => Ok(RestoreOutcome {
                report,
                cleanup_warning,
                refresh_warning: false,
            }),
            Err(mut error) => {
                if cleanup_warning {
                    error.code.push_str("_CLEANUP_UNCONFIRMED");
                }
                Err(error)
            }
        }
    }
    /// Bounded hierarchy discovery; no device ID is required on a new machine.
    /// Discovery grants no deletion rights and downloads no package bodies.
    pub async fn discover(
        self: &Arc<Self>,
        remote: &impl remote::Remote,
        options: &Options,
    ) -> Result<Discovery> {
        let lease = self.reserve()?;
        let root = options.check()?.child("ResumePro")?;
        let archives = match remote.list(&root, &lease.cancel).await {
            Ok(l) => l,
            Err(e) if e.code == "CLOUD_DAV_NotFound" => {
                return Ok(Discovery {
                    sources: vec![],
                    warnings: vec![],
                })
            }
            Err(e) => return Err(e),
        };
        if archives.entries.len() > 64 {
            return Err(fail("CATALOG_LIMIT"));
        }
        let mut result = vec![];
        let mut warnings = vec![];
        let mut first_error = None;
        for archive in archives.entries {
            let parts = archive.path.segments();
            let Some(id) = parts.last() else { continue };
            if !archive.collection
                || parts.len() != root.segments().len() + 1
                || !parts.starts_with(root.segments())
                || model::uuid(id).is_err()
            {
                continue;
            }
            let devices = match remote.list(&archive.path, &lease.cancel).await {
                Ok(devices) => devices,
                Err(error) if lease.cancel.is_cancelled() || error.code == "CLOUD_CANCELLED" => {
                    return Err(error)
                }
                Err(error) => {
                    warnings.push(error.code.clone());
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                    continue;
                }
            };
            if devices.entries.len() + result.len() > 128 {
                return Err(fail("CATALOG_LIMIT"));
            }
            for device in devices.entries {
                let d = device.path.segments();
                let Some(device_id) = d.last() else { continue };
                if device.collection
                    && d.len() == parts.len() + 1
                    && d.starts_with(parts)
                    && model::uuid(device_id).is_ok()
                {
                    result.push(Namespace {
                        archive_id: id.clone(),
                        device_id: device_id.clone(),
                    });
                }
            }
        }
        if result.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
        }
        Ok(Discovery {
            sources: result,
            warnings,
        })
    }
    /// Connection test reads only the selected root; it never publishes user data.
    pub async fn test_connection(
        self: &Arc<Self>,
        client: &Client,
        options: &Options,
    ) -> Result<()> {
        let lease = self.reserve()?;
        client.list(&options.check()?, &lease.cancel).await?;
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Namespace {
    archive_id: String,
    device_id: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub sources: Vec<Namespace>,
    pub warnings: Vec<String>,
}
