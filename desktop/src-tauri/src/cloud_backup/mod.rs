//! #305: one persisted, resumable job; metadata is the remote commit record.
mod local;
pub mod model;
mod publish;
mod remote;
#[cfg(test)]
mod tests;

use crate::{commands::CommandError, restore::RestorePaths};
use archive_store::ArchiveStore;
use backup_crypt::{
    workspace::{PreparedWorkspace, TaskDirectory},
    SecretString,
};
use model::*;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use webdav_client::{CancellationToken, Client};
pub type Result<T> = std::result::Result<T, CommandError>;
pub fn fail(code: &str) -> CommandError {
    CommandError {
        code: format!("CLOUD_{code}"),
        message: match code {
            "BUSY" => "已有云备份任务进行中。",
            "RETRY_REQUIRED" => "有完整候选包等待重试；请重试或明确放弃后再创建新备份。",
            "SCOPE_MISMATCH" => "连接、账号或目录已改变，不能重试这个作业。",
            "INSUFFICIENT_DISK_SPACE" => "磁盘可用空间不足，没有开始上传。",
            "TOO_LARGE" => "备份超过上传上限；未开始新的上传。",
            "CANCELLED" => "任务已取消；完整候选包仍可重试。",
            "REMOTE_CONFLICT" => "远端对象与本作业不一致；没有覆盖，请先对账。",
            "INCOMPLETE_LIST" => "目录完整性未经验证，已跳过自动删除。",
            "NO_RETRY_PACKAGE" => "没有完整的可重试候选包，请放弃此作业后重新创建。",
            "LOCAL_IO" => "本地备份文件或任务记录读写失败。",
            _ => "云备份未完成，请根据错误码检查后重试。",
        }
        .into(),
    }
}
impl From<std::io::Error> for CommandError {
    fn from(_: std::io::Error) -> Self {
        fail("LOCAL_IO")
    }
}
impl From<webdav_client::Error> for CommandError {
    fn from(e: webdav_client::Error) -> Self {
        if e.kind == webdav_client::ErrorKind::Cancelled {
            return fail("CANCELLED");
        }
        CommandError {
            code: format!(
                "CLOUD_DAV_{:?}{}",
                e.kind,
                if e.outcome_unknown { "_UNKNOWN" } else { "" }
            ),
            message: e.to_string(),
        }
    }
}
impl From<backup_crypt::Error> for CommandError {
    fn from(e: backup_crypt::Error) -> Self {
        CommandError {
            code: format!("CLOUD_CRYPT_{e:?}"),
            message: e.to_string(),
        }
    }
}

pub struct Service {
    root: PathBuf,
    paths: RestorePaths,
    store: Arc<Mutex<Option<ArchiveStore>>>,
    workspace: PreparedWorkspace,
    journal: Mutex<Journal>,
    active: Mutex<Option<CancellationToken>>,
}
pub struct Lease {
    service: Arc<Service>,
    pub cancel: CancellationToken,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.service.active.lock() {
            *active = None;
        }
    }
}
impl Service {
    /// Caller owns the application's host lock. Startup workspace cleanup has
    /// already removed incomplete temporaries; persistent candidates live here.
    pub fn open(
        paths: RestorePaths,
        store: Arc<Mutex<Option<ArchiveStore>>>,
        workspace: PreparedWorkspace,
    ) -> Result<Arc<Self>> {
        let root = paths.data_root.join("cloud-backup-state");
        local::directory(&root)?;
        local::cleanup_temporaries(&root)?;
        let state_file = root.join("state.json");
        let mut state = if state_file.exists() {
            local::load(&state_file)?
        } else {
            if fs::read_dir(&root)?.next().is_some() {
                return Err(fail("INVALID_LOCAL_STATE"));
            }
            Journal {
                device_id: uuid::Uuid::new_v4().to_string(),
                job: None,
                latest: None,
                receipts: vec![],
                local_garbage: vec![],
            }
        };
        if let Some(job) = state.job.as_mut() {
            if !matches!(
                job.phase,
                Phase::Succeeded | Phase::CleanupWarning | Phase::Failed | Phase::Cancelled
            ) {
                job.phase = Phase::Interrupted;
            }
        }
        local::atomic(&state_file, &state)?;
        for id in &state.local_garbage {
            if state.latest.as_ref() == Some(id) || state.job.as_ref().map(|j| &j.id) == Some(id) {
                return Err(fail("INVALID_LOCAL_STATE"));
            }
            local::remove_owned(&root, id)?;
        }
        state.local_garbage.clear();
        local::atomic(&state_file, &state)?;
        // Known old local payloads only. Never infer ownership from an arbitrary
        // directory name and never delete the latest or pending candidate.
        for receipt in &state.receipts {
            let id = &receipt.metadata.backup_id;
            if state.latest.as_ref() != Some(id) && state.job.as_ref().map(|j| &j.id) != Some(id) {
                local::remove_owned(&root, id)?;
            }
        }
        Ok(Arc::new(Self {
            root,
            paths,
            store,
            workspace,
            journal: Mutex::new(state),
            active: Mutex::new(None),
        }))
    }
    fn reserve(self: &Arc<Self>) -> Result<Lease> {
        let mut active = self.active.lock().map_err(|_| fail("LOCAL_STATE"))?;
        if active.is_some() {
            return Err(fail("BUSY"));
        }
        let cancel = CancellationToken::new();
        *active = Some(cancel.clone());
        Ok(Lease {
            service: self.clone(),
            cancel,
        })
    }
    fn update(&self, change: impl FnOnce(&mut Journal)) -> Result<()> {
        let mut state = self.journal.lock().map_err(|_| fail("LOCAL_STATE"))?;
        let mut next = state.clone();
        change(&mut next);
        // Forgetting old evidence never grants deletion rights to those objects.
        if next.receipts.len() > 256 {
            next.receipts.drain(..next.receipts.len() - 256);
        }
        local::atomic(&self.root.join("state.json"), &next)?;
        *state = next;
        Ok(())
    }
    pub fn status(&self) -> Result<Status> {
        let state = self.journal.lock().map_err(|_| fail("LOCAL_STATE"))?;
        Ok(Status {
            device_id: state.device_id.clone(),
            job: state.job.clone(),
            retry_package: state
                .job
                .as_ref()
                .filter(|j| j.candidate_ready && !j.published)
                .map(|j| local::payload(&self.root, &j.id).display().to_string()),
            latest_package: state
                .latest
                .as_ref()
                .map(|id| self.root.join(id).join("local.rpbak").display().to_string()),
        })
    }
    pub fn cancel(&self) -> Result<()> {
        if let Some(token) = self
            .active
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .as_ref()
        {
            token.cancel();
        }
        Ok(())
    }
    fn task(&self) -> Result<TaskDirectory> {
        Ok(self.workspace.new_task()?)
    }
    fn job(&self) -> Result<Job> {
        self.journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .job
            .clone()
            .ok_or_else(|| fail("NO_JOB"))
    }
    fn phase(&self, phase: Phase) -> Result<()> {
        self.update(|s| {
            if let Some(j) = s.job.as_mut() {
                j.phase = phase;
                j.error_code = None;
            }
        })
    }
    /// Scope is a hash of the normalized credential binding, with no endpoint,
    /// username, passphrase, business counts or attachment names in the journal.
    pub fn scope(binding: &crate::cloud_credentials::Binding) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(binding.scope().as_bytes()))
    }
    pub fn begin(self: &Arc<Self>, options: Options, scope: String) -> Result<(Job, Lease)> {
        options.check()?;
        let lease = self.reserve()?;
        let state = self
            .journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .clone();
        for id in &state.local_garbage {
            local::remove_owned(&self.root, id)?;
        }
        if !state.local_garbage.is_empty() {
            self.update(|s| s.local_garbage.clear())?;
        }
        if state
            .job
            .as_ref()
            .is_some_and(|j| j.candidate_ready && !j.published)
        {
            return Err(fail("RETRY_REQUIRED"));
        }
        if let Some(old) = state
            .job
            .as_ref()
            .filter(|j| !j.candidate_ready && state.latest.as_ref() != Some(&j.id))
        {
            local::remove_owned(&self.root, &old.id)?;
        }
        let archive = self
            .store
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .as_ref()
            .ok_or_else(|| fail("STORE_UNAVAILABLE"))?
            .identity()
            .archive_id;
        uuid(&archive)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut metadata = Metadata {
            format: MARKER.into(),
            format_version: 1,
            backup_id: id.clone(),
            created_at: now(),
            archive_id: archive,
            device_id: state.device_id,
            package: String::new(),
            size_bytes: 0,
            package_sha256: String::new(),
            encryption_format: if options.encrypted {
                Encryption::AgeV1Scrypt
            } else {
                Encryption::None
            },
        };
        metadata.package = metadata.package_name()?;
        let job = Job {
            id,
            scope,
            options,
            metadata,
            phase: Phase::Packing,
            candidate_ready: false,
            move_verified: false,
            part_intent: false,
            package_intent: false,
            meta_intent: false,
            published: false,
            error_code: None,
            warnings: vec![],
        };
        self.update(|s| s.job = Some(job.clone()))?;
        Ok((job, lease))
    }
    pub fn retry(self: &Arc<Self>, scope: &str, options: &Options) -> Result<(Job, Lease)> {
        let lease = self.reserve()?;
        let job = self.job()?;
        if job.scope != scope
            || serde_json::to_vec(&job.options).ok() != serde_json::to_vec(options).ok()
        {
            return Err(fail("SCOPE_MISMATCH"));
        }
        if !job.candidate_ready {
            return Err(fail("NO_RETRY_PACKAGE"));
        }
        Ok((job, lease))
    }
    pub fn discard(self: &Arc<Self>) -> Result<()> {
        let _lease = self.reserve()?;
        let job = self.job()?;
        self.update(|state| {
            if job.candidate_ready && !job.published && (job.part_intent || job.package_intent) {
                state.receipts.retain(|r| r.metadata.backup_id != job.id);
                state.receipts.push(Receipt {
                    scope: job.scope.clone(),
                    root: job.options.root.clone(),
                    metadata: job.metadata.clone(),
                    deleting: false,
                    orphan: true,
                    part_intent: job.part_intent,
                    package_intent: job.package_intent,
                    touched_at: now(),
                });
            }
        })?;
        let latest = self
            .journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .latest
            .clone();
        if latest.as_ref() != Some(&job.id) {
            local::remove_owned(&self.root, &job.id)?;
        }
        self.update(|state| state.job = None)?;
        Ok(())
    }
    /// Runs in spawn_blocking. The only store lock covers consistent export;
    /// KDF, hashes and every WebDAV request happen after releasing that guard.
    fn prepare(&self, cancel: &CancellationToken, passphrase: Option<SecretString>) -> Result<()> {
        let job = self.job()?;
        let task = self.task()?;
        let package = task.path().join("local.rpbak");
        {
            let store = self.store.lock().map_err(|_| fail("LOCAL_STATE"))?;
            let store = store.as_ref().ok_or_else(|| fail("STORE_UNAVAILABLE"))?;
            if store.identity().archive_id != job.metadata.archive_id {
                return Err(fail("ARCHIVE_CHANGED"));
            }
            // Reserve room for SQLite snapshot + ZIP + encrypted candidate. This
            // is conservative; actual space is checked again before encryption.
            let mut size = 0u64;
            let mut pending = vec![store.archive_dir().to_owned()];
            let mut count = 0usize;
            while let Some(path) = pending.pop() {
                for entry in fs::read_dir(path)? {
                    let entry = entry?;
                    let meta = entry.metadata()?;
                    count += 1;
                    if count > 200_000 {
                        return Err(fail("TOO_LARGE"));
                    }
                    if cancel.is_cancelled() {
                        return Err(fail("CANCELLED"));
                    }
                    if local::linked(&fs::symlink_metadata(entry.path())?) {
                        continue;
                    }
                    if meta.is_dir() {
                        pending.push(entry.path());
                    } else {
                        size = size.saturating_add(meta.len());
                    }
                }
            }
            local::space(&self.root, size.saturating_mul(3))?;
            crate::backup_commands::export(store, &self.paths, &package, &job.metadata.created_at)?;
        }
        if cancel.is_cancelled() {
            return Err(fail("CANCELLED"));
        }
        let output = task.path().join("payload");
        if job.options.encrypted {
            self.phase(Phase::Encrypting)?;
            local::space(
                &self.root,
                fs::metadata(&package)?
                    .len()
                    .saturating_add(4 * 1024 * 1024),
            )?;
            backup_crypt::encrypt_file(
                &package,
                &output,
                passphrase.ok_or_else(|| fail("MISSING_PASSPHRASE"))?,
                backup_crypt::Limits {
                    max_input_bytes: job.options.max_upload_bytes,
                    max_output_bytes: job.options.max_upload_bytes,
                    ..Default::default()
                },
                &|| cancel.is_cancelled(),
            )?;
        } else {
            if fs::metadata(&package)?.len() > job.options.max_upload_bytes {
                return Err(fail("TOO_LARGE"));
            }
            fs::hard_link(&package, &output)?;
        }
        let (size, hash) = local::hash(&output, cancel)?;
        if size > job.options.max_upload_bytes {
            return Err(fail("TOO_LARGE"));
        }
        // Publish the complete local candidate before recording candidate_ready.
        let directory = self.root.join(&job.id);
        local::directory(&directory)?;
        fs::rename(&package, directory.join("local.rpbak"))?;
        fs::rename(&output, directory.join("payload"))?;
        self.update(|s| {
            let j = s.job.as_mut().unwrap();
            j.metadata.size_bytes = size;
            j.metadata.package_sha256 = hash;
            j.candidate_ready = true;
            j.phase = Phase::Uploading;
        })
    }
    pub async fn run(
        self: Arc<Self>,
        lease: Lease,
        client: Client,
        passphrase: Option<SecretString>,
        fresh: bool,
    ) {
        let cancel = lease.cancel.clone();
        let result: Result<()> = async {
            if fresh {
                let service = self.clone();
                let token = cancel.clone();
                tauri::async_runtime::spawn_blocking(move || service.prepare(&token, passphrase))
                    .await
                    .map_err(|_| fail("WORKER_FAILED"))??;
            }
            if cancel.is_cancelled() {
                return Err(fail("CANCELLED"));
            }
            // Verify the retained bytes before any retry mutation.
            let service = self.clone();
            let token = cancel.clone();
            let job = self.job()?;
            let (size, hash) = tauri::async_runtime::spawn_blocking(move || {
                local::hash(&local::payload(&service.root, &job.id), &token)
            })
            .await
            .map_err(|_| fail("WORKER_FAILED"))??;
            let job = self.job()?;
            if size != job.metadata.size_bytes || hash != job.metadata.package_sha256 {
                return Err(fail("INVALID_PACKAGE"));
            }
            let job = self.job()?;
            if job.options.prefer_move && !job.part_intent && !job.package_intent {
                let folder = job.metadata.folder(&job.options.check()?)?;
                remote::mkdirs(&client, &folder, &cancel).await?;
                // The persisted job ID also records the synthetic probe location.
                let caps = client
                    .probe_capabilities(&folder, uuid::Uuid::parse_str(&job.id).unwrap(), &cancel)
                    .await;
                if cancel.is_cancelled() {
                    return Err(fail("CANCELLED"));
                }
                self.update(|s| {
                    let j = s.job.as_mut().unwrap();
                    j.move_verified = caps.as_ref().is_ok_and(|c| {
                        c.move_support == webdav_client::MoveSupport::Supported
                            && c.move_no_overwrite == Some(true)
                    });
                    if !caps.as_ref().is_ok_and(|c| c.cleanup_complete) {
                        j.warnings.push("PROBE_CLEANUP_UNCONFIRMED".into());
                    }
                })?;
            }
            self.publish(&client, &cancel).await
        }
        .await;
        self.finish(result, &cancel);
        drop(lease);
    }
    fn finish(&self, result: Result<()>, cancel: &CancellationToken) {
        if let Err(error) = result {
            let apply = |s: &mut Journal| {
                if let Some(job) = s.job.as_mut() {
                    if job.published {
                        job.phase = Phase::CleanupWarning;
                        if job.warnings.len() < 16 {
                            job.warnings.push("POST_PUBLISH_INTERRUPTED".into());
                        }
                    } else {
                        job.phase = if cancel.is_cancelled() {
                            Phase::Cancelled
                        } else {
                            Phase::Failed
                        };
                        job.error_code = Some(error.code.clone());
                    }
                }
            };
            if self.update(apply).is_err() {
                // Disk failure must not leave the live UI polling a fictitious
                // running job forever. This fallback grants no new durable intent
                // or publication rights; restart still reconciles the old journal.
                if let Ok(mut state) = self.journal.lock() {
                    apply(&mut state);
                    if let Some(job) = state.job.as_mut() {
                        if job.warnings.len() < 16 {
                            job.warnings.push("JOURNAL_WRITE_FAILED".into());
                        }
                    }
                }
            }
        }
    }
    pub async fn list(
        self: &Arc<Self>,
        client: &impl remote::Remote,
        options: &Options,
        archive: &str,
        device: &str,
    ) -> Result<Catalog> {
        let lease = self.reserve()?;
        remote::catalog(client, &options.check()?, archive, device, &lease.cancel).await
    }
    /// Fully verify an isolated download; do not change current or the live store.
    pub async fn download(
        self: &Arc<Self>,
        client: &impl remote::Remote,
        options: &Options,
        metadata: Metadata,
        passphrase: Option<SecretString>,
    ) -> Result<String> {
        let lease = self.reserve()?;
        let root = options.check()?;
        metadata.check()?;
        let folder = metadata.folder(&root)?;
        let actual = client
            .read(&folder.child(&metadata.meta_name()?)?, &lease.cancel)
            .await?
            .ok_or_else(|| fail("NOT_FOUND"))?;
        if Metadata::parse(&actual)? != metadata {
            return Err(fail("REMOTE_CONFLICT"));
        }
        let task = self.task()?;
        local::space(&self.root, metadata.size_bytes.saturating_mul(2))?;
        let payload = task.path().join("download");
        let hash = client
            .download(
                &folder.child(&metadata.package)?,
                &payload,
                metadata.size_bytes,
                &lease.cancel,
            )
            .await?;
        if hash != metadata.package_sha256 || fs::metadata(&payload)?.len() != metadata.size_bytes {
            return Err(fail("HASH_MISMATCH"));
        }
        let service = self.clone();
        let token = lease.cancel.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let package = task.path().join("verified.rpbak");
            if metadata.encryption_format == Encryption::AgeV1Scrypt {
                backup_crypt::decrypt_file(
                    &payload,
                    &package,
                    passphrase.ok_or_else(|| fail("MISSING_PASSPHRASE"))?,
                    backup_crypt::Limits {
                        max_output_bytes: webdav_client::NUTSTORE_MAX_FILE_BYTES,
                        ..Default::default()
                    },
                    &|| token.is_cancelled(),
                )?;
            } else {
                fs::rename(&payload, &package)?;
            }
            let manifest = backup::read_manifest(&package).map_err(|_| fail("INVALID_PACKAGE"))?;
            if manifest.archive_id != metadata.archive_id {
                return Err(fail("INVALID_PACKAGE"));
            }
            let needed = manifest.entries.iter().try_fold(0u64, |n, e| {
                n.checked_add(e.size_bytes).ok_or_else(|| fail("TOO_LARGE"))
            })?;
            local::space(
                &service.root,
                needed.saturating_add(fs::metadata(&package)?.len()),
            )?;
            backup::extract_to_staging(&package, &task.path().join("verify"))
                .map_err(|_| fail("INVALID_PACKAGE"))?;
            if token.is_cancelled() {
                return Err(fail("CANCELLED"));
            }
            let destination = service.root.join("verified-download.rpbak");
            let mut output = tempfile::Builder::new()
                .prefix(".verified-")
                .rand_bytes(32)
                .tempfile_in(&service.root)?;
            std::io::copy(&mut fs::File::open(&package)?, output.as_file_mut())?;
            output.as_file().sync_all()?;
            output.persist(&destination).map_err(|_| fail("LOCAL_IO"))?;
            Ok(destination.display().to_string())
        })
        .await
        .map_err(|_| fail("WORKER_FAILED"))?
    }
}
