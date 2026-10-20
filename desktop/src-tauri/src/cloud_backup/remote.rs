use super::{fail, model::*, Result};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::Path,
};
use webdav_client::{CancellationToken, Client, ErrorKind, Listing, ObjectInfo, RemotePath};

// Static dispatch keeps the production adapter and fault-injection fake on the
// exact same publication/retention code, without a second HTTP implementation.
pub trait Remote: Send + Sync {
    fn list(
        &self,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Listing>> + Send;
    /// Object size/ETag from WebDAV properties, never HEAD `Content-Length` (#316).
    fn stat(
        &self,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Option<ObjectInfo>>> + Send;
    fn read(
        &self,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<Option<Vec<u8>>>> + Send;
    fn mkdir(
        &self,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<()>> + Send;
    fn put(
        &self,
        path: &RemotePath,
        source: &Path,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<()>> + Send;
    fn put_meta(
        &self,
        path: &RemotePath,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<()>> + Send;
    fn move_new(
        &self,
        from: &RemotePath,
        to: &RemotePath,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<()>> + Send;
    fn delete(
        &self,
        path: &RemotePath,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<()>> + Send;
    fn download(
        &self,
        path: &RemotePath,
        target: &Path,
        max: u64,
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<String>> + Send;
}
fn optional<T>(result: std::result::Result<T, webdav_client::Error>) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
impl Remote for Client {
    async fn list(&self, p: &RemotePath, c: &CancellationToken) -> Result<Listing> {
        Ok(Client::list(self, p, c).await?)
    }
    async fn stat(&self, p: &RemotePath, c: &CancellationToken) -> Result<Option<ObjectInfo>> {
        optional(Client::stat(self, p, c).await)
    }
    async fn read(&self, p: &RemotePath, c: &CancellationToken) -> Result<Option<Vec<u8>>> {
        optional(self.get_bytes(p, META_LIMIT, c).await)
    }
    async fn mkdir(&self, p: &RemotePath, c: &CancellationToken) -> Result<()> {
        // MKCOL on existing collections is 405. Verify the collection with a
        // Depth:1 listing; do not treat arbitrary permissions/409 as success.
        match self.mkcol(p, c).await {
            Ok(()) => Ok(()),
            Err(e) if e.status == Some(405) => {
                Client::list(self, p, c).await?;
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }
    async fn put(&self, p: &RemotePath, s: &Path, c: &CancellationToken) -> Result<()> {
        Ok(self
            .put_file_new(p, s, webdav_client::NUTSTORE_MAX_FILE_BYTES, c)
            .await?)
    }
    async fn put_meta(&self, p: &RemotePath, b: Vec<u8>, c: &CancellationToken) -> Result<()> {
        Ok(self.put_bytes_new(p, b, c).await?)
    }
    async fn move_new(&self, f: &RemotePath, t: &RemotePath, c: &CancellationToken) -> Result<()> {
        Ok(Client::move_new(self, f, t, c).await?)
    }
    async fn delete(&self, p: &RemotePath, c: &CancellationToken) -> Result<()> {
        match Client::delete(self, p, c).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    async fn download(
        &self,
        p: &RemotePath,
        t: &Path,
        max: u64,
        c: &CancellationToken,
    ) -> Result<String> {
        let result = self.download_new(p, t, max, c).await?;
        Ok(result.sha256.iter().map(|b| format!("{b:02x}")).collect())
    }
}
pub async fn mkdirs(
    remote: &impl Remote,
    folder: &RemotePath,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut current = RemotePath::root();
    for part in folder.segments() {
        current = current.child(part)?;
        remote.mkdir(&current, cancel).await?;
    }
    Ok(())
}

/// Sequential metadata reads (concurrency=1) go through Client's shared 3-second
/// throttle. Never download a package merely to render a catalog.
pub async fn catalog(
    remote: &impl Remote,
    root: &RemotePath,
    archive: &str,
    device: &str,
    cancel: &CancellationToken,
) -> Result<Catalog> {
    catalog_with_owned(remote, root, archive, device, cancel, &HashSet::new()).await
}
pub async fn catalog_with_owned(
    remote: &impl Remote,
    root: &RemotePath,
    archive: &str,
    device: &str,
    cancel: &CancellationToken,
    owned_loose: &HashSet<RemotePath>,
) -> Result<Catalog> {
    let device_path = device_folder(root, archive, device)?;
    let listing = remote.list(&device_path, cancel).await?;
    if listing.entries.len() > MAX_MONTHS {
        return Err(fail("CATALOG_LIMIT"));
    }
    let mut safe = listing.safe_for_cleanup();
    let mut entries = Vec::new();
    let mut ids = HashSet::new();
    let mut reads = 0usize;
    for entry in listing.entries {
        let segments = entry.path.segments();
        let valid_month = segments.last().is_some_and(|name| {
            name.len() == 7
                && name.as_bytes()[4] == b'-'
                && date(&format!("{name}-01T00:00:00Z")).is_ok()
        });
        if !entry.collection || !valid_month || !direct_child(&device_path, &entry.path) {
            safe = false;
            continue;
        }
        let month_listing = remote.list(&entry.path, cancel).await?;
        safe &= month_listing.safe_for_cleanup();
        if month_listing.entries.len() > MAX_CATALOG * 2 {
            return Err(fail("CATALOG_LIMIT"));
        }
        // The PROPFIND listing already carries each file's size; Nutstore HEAD
        // would report 0 (#316), and a per-package request costs a throttle slot.
        let sizes: HashMap<String, Option<u64>> = month_listing
            .entries
            .iter()
            .filter(|item| !item.collection && direct_child(&entry.path, &item.path))
            .filter_map(|item| Some((item.path.segments().last()?.clone(), item.size)))
            .collect();
        let mut packages = HashSet::new();
        let mut loose = Vec::new();
        for item in month_listing.entries {
            if !direct_child(&entry.path, &item.path) || item.collection {
                safe = false;
                continue;
            }
            let name = item.path.segments().last().unwrap();
            if !name.ends_with(".meta.json") {
                loose.push(name.clone());
                continue;
            }
            reads += 1;
            if reads > MAX_CATALOG {
                return Err(fail("CATALOG_LIMIT"));
            }
            let raw = remote
                .read(&item.path, cancel)
                .await?
                .ok_or_else(|| fail("CATALOG_CHANGED"))?;
            let metadata = match Metadata::parse(&raw) {
                Ok(m) => m,
                Err(_) => {
                    safe = false;
                    continue;
                }
            };
            if metadata.archive_id != archive
                || metadata.device_id != device
                || metadata.folder(root)? != entry.path
                || metadata.meta_name()? != *name
                || !ids.insert(metadata.backup_id.clone())
            {
                safe = false;
                continue;
            }
            if sizes.get(&metadata.package) != Some(&Some(metadata.size_bytes)) {
                safe = false;
                continue;
            }
            packages.insert(metadata.package.clone());
            entries.push(metadata);
        }
        // Unknown user files, parts, malformed JSON and orphan packages disable
        // deletion for this pass; they remain untouched.
        for name in loose {
            if !packages.contains(&name) && !owned_loose.contains(&entry.path.child(&name)?) {
                safe = false;
            }
        }
    }
    entries.sort_by(|a, b| {
        date(&b.created_at)
            .unwrap()
            .cmp(&date(&a.created_at).unwrap())
            .then_with(|| b.backup_id.cmp(&a.backup_id))
    });
    Ok(Catalog {
        entries,
        cleanup_safe: safe,
        content_hash_verified: false,
    })
}
fn direct_child(parent: &RemotePath, child: &RemotePath) -> bool {
    child.segments().len() == parent.segments().len() + 1
        && child.segments().starts_with(parent.segments())
}
