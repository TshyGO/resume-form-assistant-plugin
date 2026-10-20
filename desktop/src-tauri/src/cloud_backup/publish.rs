use super::{
    fail, local,
    model::*,
    remote::{self, Remote},
    Result, Service,
};
use std::collections::HashSet;
use webdav_client::{CancellationToken, RemotePath};

impl Service {
    async fn verify_remote(
        &self,
        remote: &impl Remote,
        path: &RemotePath,
        metadata: &Metadata,
        cancel: &CancellationToken,
    ) -> Result<bool> {
        let Some(info) = remote.stat(path, cancel).await? else {
            return Ok(false);
        };
        if info.size != Some(metadata.size_bytes) {
            return Err(fail("REMOTE_CONFLICT"));
        }
        let task = self.task()?;
        local::space(&self.root, metadata.size_bytes)?;
        let hash = remote
            .download(
                path,
                &task.path().join("reconcile"),
                metadata.size_bytes,
                cancel,
            )
            .await?;
        if hash != metadata.package_sha256 {
            return Err(fail("REMOTE_CONFLICT"));
        }
        Ok(true)
    }
    async fn upload_object(
        &self,
        remote: &impl Remote,
        path: &RemotePath,
        part: bool,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let job = self.job()?;
        let intended = if part {
            job.part_intent
        } else {
            job.package_intent
        };
        if remote.stat(path, cancel).await?.is_some() {
            if !intended {
                return Err(fail("REMOTE_CONFLICT"));
            }
            self.verify_remote(remote, path, &job.metadata, cancel)
                .await?;
            return Ok(());
        }
        self.update(|s| {
            let j = s.job.as_mut().unwrap();
            if part {
                j.part_intent = true;
            } else {
                j.package_intent = true;
            }
        })?;
        // On a lost response we stop here. The next attempt uses the same backup
        // ID and verifies existing content, never overwrites or invents a new ID.
        remote
            .put(path, &local::payload(&self.root, &job.id), cancel)
            .await?;
        let info = remote
            .stat(path, cancel)
            .await?
            .ok_or_else(|| fail("PUBLISH_UNCONFIRMED"))?;
        if info.size != Some(job.metadata.size_bytes) {
            return Err(fail("PUBLISH_UNCONFIRMED"));
        }
        Ok(())
    }
    pub(super) async fn publish(
        &self,
        remote: &impl Remote,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let job = self.job()?;
        job.metadata.check()?;
        if job.metadata.size_bytes > job.options.max_upload_bytes {
            return Err(fail("TOO_LARGE"));
        }
        let root = job.options.check()?;
        let folder = job.metadata.folder(&root)?;
        let package = folder.child(&job.metadata.package)?;
        let meta_path = folder.child(&job.metadata.meta_name()?)?;
        let bytes = serde_json::to_vec(&job.metadata).map_err(|_| fail("INVALID_METADATA"))?;
        if bytes.len() > META_LIMIT {
            return Err(fail("INVALID_METADATA"));
        }
        self.phase(Phase::Uploading)?;
        remote::mkdirs(remote, &folder, cancel).await?;
        if let Some(existing) = remote.read(&meta_path, cancel).await? {
            if !job.meta_intent || Metadata::parse(&existing)? != job.metadata {
                return Err(fail("REMOTE_CONFLICT"));
            }
            if !self
                .verify_remote(remote, &package, &job.metadata, cancel)
                .await?
            {
                return Err(fail("PUBLISH_UNCONFIRMED"));
            }
        } else {
            if job.move_verified {
                // A retry after a successful MOVE may already have the final.
                if remote.stat(&package, cancel).await?.is_some() {
                    if !job.package_intent {
                        return Err(fail("REMOTE_CONFLICT"));
                    }
                    self.verify_remote(remote, &package, &job.metadata, cancel)
                        .await?;
                } else {
                    let part = folder.child(&format!("{}.part", job.metadata.package))?;
                    self.upload_object(remote, &part, true, cancel).await?;
                    self.update(|s| s.job.as_mut().unwrap().package_intent = true)?;
                    remote.move_new(&part, &package, cancel).await?;
                }
            } else {
                self.upload_object(remote, &package, false, cancel).await?;
            }
            self.phase(Phase::Confirming)?;
            let info = remote
                .stat(&package, cancel)
                .await?
                .ok_or_else(|| fail("PUBLISH_UNCONFIRMED"))?;
            if info.size != Some(job.metadata.size_bytes) {
                return Err(fail("PUBLISH_UNCONFIRMED"));
            }
            self.update(|s| s.job.as_mut().unwrap().meta_intent = true)?;
            remote.put_meta(&meta_path, bytes, cancel).await?;
            let confirmed = remote
                .read(&meta_path, cancel)
                .await?
                .ok_or_else(|| fail("PUBLISH_UNCONFIRMED"))?;
            if Metadata::parse(&confirmed)? != job.metadata {
                return Err(fail("PUBLISH_UNCONFIRMED"));
            }
        }
        // Remote commit is confirmed before changing latest or invoking deletion.
        let old_latest = self
            .journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .latest
            .clone();
        self.update(|s| {
            let j = s.job.as_mut().unwrap();
            j.published = true;
            j.phase = Phase::Succeeded;
            if !j.warnings.is_empty() {
                j.phase = Phase::CleanupWarning;
            }
            j.error_code = None;
            s.latest = Some(j.id.clone());
            if let Some(old) = old_latest.as_ref().filter(|id| *id != &j.id) {
                if !s.local_garbage.contains(old) {
                    s.local_garbage.push(old.clone());
                }
            }
            if !s.receipts.iter().any(|r| r.metadata.backup_id == j.id) {
                s.receipts.push(Receipt {
                    scope: j.scope.clone(),
                    root: j.options.root.clone(),
                    metadata: j.metadata.clone(),
                    deleting: false,
                    orphan: false,
                    part_intent: j.part_intent,
                    package_intent: j.package_intent,
                    touched_at: now(),
                });
            }
        })?;
        if let Some(old) = old_latest.filter(|id| id != &job.id) {
            if local::remove_owned(&self.root, &old).is_err() {
                self.warning("LOCAL_CLEANUP_FAILED")?;
            } else {
                self.update(|s| s.local_garbage.retain(|id| id != &old))?;
            }
        }
        // A cleanup error is a warning on a successful backup, never a failure.
        if let Err(error) = self.retention(remote, &root, cancel).await {
            self.warning(&error.code)?;
        }
        Ok(())
    }
    fn warning(&self, code: &str) -> Result<()> {
        self.update(|s| {
            let j = s.job.as_mut().unwrap();
            j.phase = Phase::CleanupWarning;
            if j.warnings.len() < 16 && !j.warnings.iter().any(|w| w == code) {
                j.warnings.push(code.into());
            }
        })
    }
    async fn retention(
        &self,
        remote: &impl Remote,
        root: &RemotePath,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let job = self.job()?;
        let Some(keep) = job.options.keep_last else {
            return Ok(());
        };
        // Destructive decisions use both remote structure and local job receipts.
        // No metadata alone can confer this machine's deletion authority.
        let receipts = self
            .journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .receipts
            .clone();
        let mut owned_loose = HashSet::new();
        let current_time = date(&now())?;
        for r in receipts.iter().filter(|r| {
            (r.orphan || r.deleting)
                && r.scope == job.scope
                && r.root == job.options.root
                && r.metadata.device_id == job.metadata.device_id
                && r.metadata.archive_id == job.metadata.archive_id
        }) {
            if (current_time - date(&r.touched_at)?).whole_hours() < 24 {
                continue;
            }
            let folder = r.metadata.folder(root)?;
            if r.part_intent {
                owned_loose.insert(folder.child(&format!("{}.part", r.metadata.package))?);
            }
            if r.package_intent {
                owned_loose.insert(folder.child(&r.metadata.package)?);
            }
        }
        let catalog = remote::catalog_with_owned(
            remote,
            root,
            &job.metadata.archive_id,
            &job.metadata.device_id,
            cancel,
            &owned_loose,
        )
        .await?;
        if !catalog.cleanup_safe {
            return Err(fail("INCOMPLETE_LIST"));
        }
        if catalog.entries.iter().any(|m| {
            !receipts.iter().any(|r| {
                !r.orphan && r.scope == job.scope && r.root == job.options.root && r.metadata == *m
            })
        }) {
            return Err(fail("OWNERSHIP_UNPROVEN"));
        }
        for metadata in catalog.entries.iter().skip(keep) {
            if metadata.backup_id == job.id {
                continue;
            }
            let Some(receipt) = receipts.iter().find(|r| {
                !r.orphan
                    && r.scope == job.scope
                    && r.root == job.options.root
                    && r.metadata == *metadata
            }) else {
                return Err(fail("OWNERSHIP_UNPROVEN"));
            };
            let folder = metadata.folder(root)?;
            let meta_path = folder.child(&metadata.meta_name()?)?;
            // Re-read directly before deleting. A list snapshot is not sufficient.
            let raw = remote
                .read(&meta_path, cancel)
                .await?
                .ok_or_else(|| fail("CATALOG_CHANGED"))?;
            if Metadata::parse(&raw)? != receipt.metadata {
                return Err(fail("CATALOG_CHANGED"));
            }
            self.update(|s| {
                if let Some(r) = s
                    .receipts
                    .iter_mut()
                    .find(|r| r.metadata.backup_id == metadata.backup_id)
                {
                    r.deleting = true;
                    r.touched_at = now();
                }
            })?;
            remote.delete(&meta_path, cancel).await?;
            // Confirm absence even after an acknowledged DELETE. If unknown, stop
            // with a warning; never remove the body of still-visible metadata.
            if remote.read(&meta_path, cancel).await?.is_some() {
                return Err(fail("DELETE_UNCONFIRMED"));
            }
            let package = folder.child(&metadata.package)?;
            if let Some(info) = remote.stat(&package, cancel).await? {
                if info.size != Some(metadata.size_bytes) {
                    return Err(fail("CATALOG_CHANGED"));
                }
                remote.delete(&package, cancel).await?;
            }
            self.update(|s| {
                s.receipts
                    .retain(|r| r.metadata.backup_id != metadata.backup_id)
            })?;
        }
        // Conservative orphan recovery: local evidence + >24h grace + no public
        // metadata + full content hash. Never touch the active candidate/latest.
        for receipt in receipts.iter().filter(|r| r.orphan || r.deleting) {
            if receipt.scope != job.scope
                || receipt.root != job.options.root
                || receipt.metadata.device_id != job.metadata.device_id
                || receipt.metadata.archive_id != job.metadata.archive_id
                || receipt.metadata.backup_id == job.id
                || (current_time - date(&receipt.touched_at)?).whole_hours() < 24
            {
                continue;
            }
            let metadata = &receipt.metadata;
            let folder = metadata.folder(root)?;
            if remote
                .read(&folder.child(&metadata.meta_name()?)?, cancel)
                .await?
                .is_some()
            {
                continue;
            }
            for (allowed, name) in [
                (receipt.part_intent, format!("{}.part", metadata.package)),
                (receipt.package_intent, metadata.package.clone()),
            ] {
                if allowed {
                    let path = folder.child(&name)?;
                    if self.verify_remote(remote, &path, metadata, cancel).await? {
                        remote.delete(&path, cancel).await?;
                    }
                }
            }
            self.update(|s| {
                s.receipts
                    .retain(|r| r.metadata.backup_id != metadata.backup_id)
            })?;
        }
        Ok(())
    }
}
