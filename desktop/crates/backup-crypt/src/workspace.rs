//! Private job directories live beside archives, never inside the active archive.
//! The caller must hold the application's unique-writer host lock before startup
//! cleanup, and must not run cleanup while any jobs are active.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn linked(metadata: &fs::Metadata) -> bool {
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || metadata.file_attributes() & 0x400 != 0 // reparse point / junction
    };
    linked
}
fn plain_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if linked(&metadata) || !metadata.is_dir() {
        return Err(io::Error::other(
            "backup workspace must be a plain directory",
        ));
    }
    Ok(())
}
fn root(data_root: &Path) -> io::Result<PathBuf> {
    plain_directory(data_root)?;
    let root = data_root.join("cloud-backup-work");
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&root)
    };
    #[cfg(not(unix))]
    let created = fs::create_dir(&root);
    match created {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    plain_directory(&root)?;
    Ok(root)
}

/// Run once after acquiring the host lock. Deletes only this adapter's task names
/// in its dedicated directory; unrelated files and links cause no traversal.
pub fn cleanup_abandoned_jobs(data_root: &Path) -> io::Result<()> {
    let root = root(data_root)?;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("job-")
            && name.len() == 36
            && name[4..].bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() && !linked(&metadata) {
                fs::remove_dir_all(entry.path())?;
            }
        }
    }
    Ok(())
}

/// RAII cleanup for success, failure and cancellation. Windows inherits the
/// application-data ACL; Unix directories are 0700 and task files are 0600.
pub struct TaskDirectory(tempfile::TempDir);
impl TaskDirectory {
    pub fn new(data_root: &Path) -> io::Result<Self> {
        let root = root(data_root)?;
        // tempfile adds randomness atomically. A fixed suffix length also lets
        // startup cleanup recognize exactly our own directory namespace.
        let mut builder = tempfile::Builder::new();
        builder.prefix("job-").rand_bytes(32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o700));
        }
        builder.tempdir_in(root).map(Self)
    }
    pub fn path(&self) -> &Path {
        self.0.path()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normal_drop_and_next_start_clean_only_owned_task_directories() {
        let root = tempfile::tempdir().unwrap();
        let job = TaskDirectory::new(root.path()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(job.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::write(job.path().join("partial.rpbak"), b"synthetic plaintext").unwrap();
        let path = job.path().to_owned();
        drop(job);
        assert!(!path.exists());
        let abandoned = TaskDirectory::new(root.path()).unwrap().0.keep();
        fs::write(abandoned.join("partial"), b"synthetic").unwrap();
        let unrelated = root.path().join("cloud-backup-work/unrelated");
        fs::create_dir(&unrelated).unwrap();
        let alien = root
            .path()
            .join(format!("cloud-backup-work/job-{}", "a".repeat(32)));
        fs::write(&alien, b"unrelated file").unwrap();
        cleanup_abandoned_jobs(root.path()).unwrap();
        assert!(!abandoned.exists());
        assert!(unrelated.exists());
        assert!(alien.exists());
    }
}
