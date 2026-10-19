use super::{fail, model::*, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn linked(meta: &fs::Metadata) -> bool {
    let linked = meta.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return linked || meta.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    linked
}
pub fn plain_dir(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if linked(&meta) || !meta.is_dir() {
        return Err(fail("INVALID_LOCAL_DIRECTORY"));
    }
    Ok(())
}
pub fn directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    let made = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    };
    #[cfg(not(unix))]
    let made = fs::create_dir(path);
    match made {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    plain_dir(path)
}
pub fn atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().ok_or_else(|| fail("LOCAL_IO"))?;
    plain_dir(parent)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".state-")
        .rand_bytes(32)
        .tempfile_in(parent)?;
    let bytes = serde_json::to_vec(value).map_err(|_| fail("LOCAL_IO"))?;
    if bytes.len() >= 512 * 1024 {
        return Err(fail("LOCAL_STATE_LIMIT"));
    }
    temp.as_file_mut().write_all(&bytes)?;
    temp.as_file_mut().write_all(b"\n")?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|_| fail("LOCAL_IO"))?;
    // The intent must reach the directory as well as the temporary file before
    // the caller starts a remote mutation. Otherwise a power loss may lose rename.
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn load(path: &Path) -> Result<Journal> {
    let file = fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(512 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 512 * 1024 {
        return Err(fail("INVALID_LOCAL_STATE"));
    }
    let state: Journal = serde_json::from_slice(&bytes).map_err(|_| fail("INVALID_LOCAL_STATE"))?;
    uuid(&state.device_id)?;
    if state.receipts.len() > 256 || state.local_garbage.len() > 8 {
        return Err(fail("INVALID_LOCAL_STATE"));
    }
    for id in &state.local_garbage {
        uuid(id)?;
    }
    if let Some(id) = &state.latest {
        uuid(id)?;
    }
    if let Some(job) = &state.job {
        uuid(&job.id)?;
        if job.id != job.metadata.backup_id || job.metadata.device_id != state.device_id {
            return Err(fail("INVALID_LOCAL_STATE"));
        }
        job.options.check()?;
        // A packing journal has not got a size/hash yet.
        if job.candidate_ready {
            job.metadata.check()?;
        }
    }
    for receipt in &state.receipts {
        receipt.metadata.check()?;
        date(&receipt.touched_at)?;
    }
    Ok(state)
}
pub fn hash(path: &Path, cancel: &webdav_client::CancellationToken) -> Result<(u64, String)> {
    let mut file = fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err(fail("INVALID_PACKAGE"));
    }
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(fail("CANCELLED"));
        }
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| fail("TOO_LARGE"))?;
        if size > webdav_client::NUTSTORE_MAX_FILE_BYTES {
            return Err(fail("TOO_LARGE"));
        }
        hasher.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}
pub fn space(path: &Path, needed: u64) -> Result<()> {
    if fs2::available_space(path)? < needed.saturating_add(64 * 1024 * 1024) {
        return Err(fail("INSUFFICIENT_DISK_SPACE"));
    }
    Ok(())
}
pub fn payload(root: &Path, id: &str) -> PathBuf {
    root.join(id).join("payload")
}
/// Fallback for filesystems without hard links. A partial copy is never exposed
/// at the requested path, and an existing output is never overwritten.
pub fn copy_new(
    source: &Path,
    target: &Path,
    max: u64,
    cancel: &webdav_client::CancellationToken,
) -> Result<()> {
    let mut input = fs::File::open(source)?;
    if !input.metadata()?.is_file() || input.metadata()?.len() > max {
        return Err(fail("TOO_LARGE"));
    }
    let mut output =
        tempfile::NamedTempFile::new_in(target.parent().ok_or_else(|| fail("LOCAL_IO"))?)?;
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(fail("CANCELLED"));
        }
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| fail("TOO_LARGE"))?;
        if total > max {
            return Err(fail("TOO_LARGE"));
        }
        output.as_file_mut().write_all(&buffer[..count])?;
    }
    output.as_file().sync_all()?;
    output
        .persist_noclobber(target)
        .map_err(|_| fail("LOCAL_IO"))?;
    Ok(())
}
pub fn cleanup_temporaries(root: &Path) -> Result<()> {
    plain_dir(root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let suffix = name
            .strip_prefix(".state-")
            .or_else(|| name.strip_prefix(".verified-"));
        if suffix.is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_alphanumeric())) {
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_file() && !linked(&metadata) {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}
/// Delete only an explicitly tracked UUID directory under the dedicated state root.
pub fn remove_owned(root: &Path, id: &str) -> Result<()> {
    uuid(id)?;
    plain_dir(root)?;
    let path = root.join(id);
    if path.exists() {
        plain_dir(&path)?;
        fs::remove_dir_all(path)?;
    }
    Ok(())
}
