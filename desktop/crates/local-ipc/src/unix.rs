//! Unix domain socket transport.
//!
//! The socket sits inside the data directory, which is already private to the user, and
//! is narrowed to `0600` immediately after binding.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

use crate::IpcError;

/// `sun_path` is 104 bytes on macOS including the terminator, so 103 usable. Linux allows
/// 108; the smaller limit is used on both so a path that works on one works on the other.
const SUN_PATH_LIMIT: usize = 103;

const SOCKET_NAME: &str = "host.sock";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    path: PathBuf,
}

impl Endpoint {
    pub fn for_data_root(data_root: &Path) -> Result<Self, IpcError> {
        let path = data_root.join(SOCKET_NAME);
        // Checked here rather than at bind time: an over-long path fails inside libc with
        // an error that says nothing about which path or which limit.
        if path.as_os_str().len() > SUN_PATH_LIMIT {
            return Err(IpcError::PathTooLong {
                path,
                limit: SUN_PATH_LIMIT,
            });
        }
        Ok(Self { path })
    }

    pub fn display(&self) -> String {
        self.path.display().to_string()
    }
}

pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
}

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> Result<Self, IpcError> {
        // A crash leaves the socket file behind. Only the holder of host.lock listens, so
        // this process may replace a stale file — but not one someone is still serving.
        if endpoint.path.exists() {
            match UnixStream::connect(&endpoint.path) {
                Ok(_) => return Err(IpcError::AlreadyListening),
                Err(_) => {
                    std::fs::remove_file(&endpoint.path)?;
                }
            }
        }
        // bind() creates the socket under the process umask and only then can it be
        // narrowed, so the pathname is briefly reachable. Closing the directory to others
        // first means nobody can traverse to it during that window. The default data
        // directory is already private; RESUMEPRO_DATA_DIR can point anywhere.
        if let Some(parent) = endpoint.path.parent() {
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
        let inner = UnixListener::bind(&endpoint.path)?;
        std::fs::set_permissions(&endpoint.path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self {
            inner,
            path: endpoint.path.clone(),
        })
    }

    pub fn accept(&mut self) -> Result<Stream, IpcError> {
        let (stream, _addr) = self.inner.accept()?;
        Ok(Stream { inner: stream })
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        // Leaving the file behind would make the next start take the stale-file path for
        // no reason.
        let _ = std::fs::remove_file(&self.path);
    }
}

pub struct Stream {
    inner: UnixStream,
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub fn connect(endpoint: &Endpoint) -> Result<Stream, IpcError> {
    match UnixStream::connect(&endpoint.path) {
        Ok(inner) => Ok(Stream { inner }),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            Err(IpcError::NotRunning)
        }
        Err(e) => Err(IpcError::Io(e)),
    }
}
