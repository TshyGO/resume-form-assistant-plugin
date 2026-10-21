use super::{fail, model::*, Result};
use std::{
    collections::HashMap,
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

/// File name -> listed size for the direct, non-collection children of one
/// month folder. A missing folder is an empty month. A listing may omit entries
/// (#322), so callers only draw positive conclusions from what it contains.
pub async fn month_files(
    remote: &impl Remote,
    folder: &RemotePath,
    cancel: &CancellationToken,
) -> Result<HashMap<String, Option<u64>>> {
    let listing = match remote.list(folder, cancel).await {
        Ok(listing) => listing,
        Err(e) if e.code == "CLOUD_DAV_NotFound" => return Ok(HashMap::new()),
        Err(e) => return Err(e),
    };
    if listing.entries.len() > MAX_CATALOG * 2 {
        return Err(fail("CATALOG_LIMIT"));
    }
    Ok(listing
        .entries
        .into_iter()
        .filter(|item| !item.collection && direct_child(folder, &item.path))
        .filter_map(|item| Some((item.path.segments().last()?.clone(), item.size)))
        .collect())
}

/// One page of the catalog from PROPFIND alone (#322): whole months, newest
/// first, until at least `want` entries. No metadata GET and no package body;
/// a row is a `.meta.json` name plus exactly one matching package with a size.
/// Months strictly older than `before` only, so each month is listed once.
pub async fn page(
    remote: &impl Remote,
    root: &RemotePath,
    archive: &str,
    device: &str,
    before: Option<&str>,
    want: usize,
    cancel: &CancellationToken,
) -> Result<Page> {
    let device_path = device_folder(root, archive, device)?;
    if before.is_some_and(|month| !valid_month(month)) {
        return Err(fail("INVALID_CURSOR"));
    }
    let listing = remote.list(&device_path, cancel).await?;
    if listing.entries.len() > MAX_MONTHS {
        return Err(fail("CATALOG_LIMIT"));
    }
    let mut months: Vec<String> = listing
        .entries
        .iter()
        .filter(|entry| entry.collection && direct_child(&device_path, &entry.path))
        .filter_map(|entry| entry.path.segments().last().cloned())
        .filter(|name| valid_month(name) && before.is_none_or(|month| name.as_str() < month))
        .collect();
    months.sort_unstable_by(|a, b| b.cmp(a));
    let mut entries = Vec::new();
    let mut next = None;
    let mut months = months.into_iter().peekable();
    while let Some(month) = months.next() {
        let files = month_files(remote, &device_path.child(&month)?, cancel).await?;
        let mut found: Vec<Listed> = files
            .keys()
            .filter_map(|name| listed(archive, device, &month, name, &files))
            .collect();
        // Fixed-width UTC names: string order is time order.
        found.sort_unstable_by(|a, b| {
            (&b.created_at, &b.backup_id).cmp(&(&a.created_at, &a.backup_id))
        });
        entries.extend(found);
        if entries.len() >= want && months.peek().is_some() {
            next = Some(month);
            break;
        }
    }
    Ok(Page {
        entries,
        next,
        content_hash_verified: false,
    })
}
fn valid_month(name: &str) -> bool {
    name.len() == 7
        && name.as_bytes()[4] == b'-'
        && date(&format!("{name}-01T00:00:00Z")).is_ok()
}
/// `<YYYYMMDDTHHMMSSZ>-<uuid>.meta.json` written by this app into its own month.
/// Unknown files, parts and half-published pairs are simply not rows.
fn listed(
    archive: &str,
    device: &str,
    folder_month: &str,
    name: &str,
    files: &HashMap<String, Option<u64>>,
) -> Option<Listed> {
    let stem_name = name.strip_suffix(".meta.json")?;
    let (time, id) = stem_name.split_once('-')?;
    let t = time.as_bytes();
    if t.len() != 16 || !time.is_ascii() || t[8] != b'T' || t[15] != b'Z' {
        return None;
    }
    let created_at = format!(
        "{}-{}-{}T{}:{}:{}Z",
        &time[0..4], &time[4..6], &time[6..8], &time[9..11], &time[11..13], &time[13..15]
    );
    if stem(&created_at, id).ok()? != stem_name || month(&created_at).ok()? != folder_month {
        return None;
    }
    let mut found = None;
    for (encryption_format, package) in [
        (Encryption::None, format!("{stem_name}.rpbak")),
        (Encryption::AgeV1Scrypt, format!("{stem_name}.rpbak.age")),
    ] {
        if let Some(size) = files.get(&package) {
            let size = (*size).filter(|n| *n > 0 && *n <= webdav_client::NUTSTORE_MAX_FILE_BYTES)?;
            if found.is_some() {
                return None;
            }
            found = Some((encryption_format, package, size));
        }
    }
    let (encryption_format, package, size_bytes) = found?;
    Some(Listed {
        backup_id: id.to_owned(),
        created_at,
        archive_id: archive.to_owned(),
        device_id: device.to_owned(),
        package,
        size_bytes,
        encryption_format,
    })
}
fn direct_child(parent: &RemotePath, child: &RemotePath) -> bool {
    child.segments().len() == parent.segments().len() + 1
        && child.segments().starts_with(parent.segments())
}
