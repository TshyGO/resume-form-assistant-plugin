//! Unix domain socket transport.
//!
//! The socket sits inside the data directory, which is already private to the user, and
//! is narrowed to `0600` immediately after binding.

use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
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

#[derive(Debug)]
pub struct Listener {
    inner: UnixListener,
    path: PathBuf,
}

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> Result<Self, IpcError> {
        // A crash leaves the socket file behind. Only the holder of host.lock listens, so
        // this process may replace a stale file — but only once it knows the file is
        // stale. Treating every connect failure as proof of that was wrong: a permission
        // error says nothing about whether someone is serving, and unlinking on the
        // strength of it would put a second listener behind the same path.
        if endpoint.path.exists() {
            let is_socket = std::fs::metadata(&endpoint.path)
                .map(|meta| meta.file_type().is_socket())
                .unwrap_or(false);
            if !is_socket {
                // Something that is not a socket sits where ours belongs. Deleting it
                // would silently destroy a user file if the data directory were ever
                // pointed somewhere wrong, and nothing here can tell those cases apart.
                return Err(IpcError::Io(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "{} exists and is not a socket; refusing to remove it",
                        endpoint.path.display()
                    ),
                )));
            } else {
                match UnixStream::connect(&endpoint.path) {
                    Ok(_) => return Err(IpcError::AlreadyListening),
                    // Refused means the socket outlived its listener.
                    Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                        std::fs::remove_file(&endpoint.path)?;
                    }
                    // Vanished between the check and the connect; nothing to remove.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    // Anything else leaves the question open, so the file stays.
                    Err(e) => return Err(IpcError::Io(e)),
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

#[derive(Debug)]
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

/// SAFETY: `geteuid` takes no arguments, touches no memory, and cannot fail. Declared
/// here rather than pulled from a crate to keep this transport dependency-free.
extern "C" {
    fn geteuid() -> u32;
}

/// Refuse a socket this user does not own or that others could reach.
///
/// The Windows side checks the server process; without this the Unix side checked
/// nothing. The cold-start flow connects before anything binds, so a directory another
/// user can write to lets them put their own `host.sock` there first and receive résumé
/// frames. Ownership and mode are what can be established from the client side.
fn verify_socket(path: &Path) -> Result<(), IpcError> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path)?;
    // SAFETY: see the declaration above.
    let ours = unsafe { geteuid() };
    if meta.uid() != ours {
        return Err(IpcError::UntrustedServer {
            reason: format!("socket is owned by uid {}, not {ours}", meta.uid()),
        });
    }
    let mode = meta.permissions().mode() & 0o077;
    if mode != 0 {
        return Err(IpcError::UntrustedServer {
            reason: format!("socket is reachable by others, mode {:o}", meta.mode() & 0o777),
        });
    }
    Ok(())
}

pub fn connect(endpoint: &Endpoint) -> Result<Stream, IpcError> {
    match UnixStream::connect(&endpoint.path) {
        Ok(inner) => {
            verify_socket(&endpoint.path)?;
            Ok(Stream { inner })
        }
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
