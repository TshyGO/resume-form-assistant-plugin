//! Local IPC between the Native Messaging host and the application process.
//!
//! Byte streams only: this crate does not know the protocol spoken over them. Callers
//! layer `nm-frame` on top, so transport and framing stay independently testable.
//!
//! The ADR requires that a local endpoint not be trusted merely for being local. On
//! Windows the pipe carries a DACL naming only the current user; on Unix the socket is
//! `0600` inside the already-private data directory.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as platform;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[derive(Debug)]
pub enum IpcError {
    /// A Unix socket path longer than `sun_path` allows. Reported before binding so the
    /// cause is legible, rather than surfacing as an opaque bind failure.
    PathTooLong { path: PathBuf, limit: usize },
    /// Something already listens on this endpoint. Only the holder of `host.lock` should
    /// be listening, so this means either a second application process or, on Windows, a
    /// squatted pipe name.
    AlreadyListening,
    /// Nothing is listening. The caller decides whether to start the application.
    NotRunning,
    /// Someone is listening but every instance is taken. Distinct from `NotRunning` on
    /// purpose: a caller that conflated them would start a second application process
    /// because the first one was merely busy.
    Busy,
    /// Windows only: the pipe was created by a process that is not this executable.
    UntrustedServer { reason: String },
    Io(std::io::Error),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::PathTooLong { path, limit } => write!(
                f,
                "socket path is {} bytes, over the {limit} byte limit: {}",
                path.as_os_str().len(),
                path.display()
            ),
            IpcError::AlreadyListening => write!(f, "another process already listens here"),
            IpcError::NotRunning => write!(f, "nothing is listening"),
            IpcError::Busy => write!(f, "the listener is running but every instance is taken"),
            IpcError::UntrustedServer { reason } => {
                write!(f, "the listening process is not trusted: {reason}")
            }
            IpcError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl std::error::Error for IpcError {}

impl From<std::io::Error> for IpcError {
    fn from(value: std::io::Error) -> Self {
        IpcError::Io(value)
    }
}

/// Where the application listens and the host connects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint(platform::Endpoint);

impl Endpoint {
    /// Derive the endpoint for a data directory.
    ///
    /// On Unix this is a socket inside that directory. On Windows it is a named pipe
    /// whose name carries the current user's SID, so two users on one machine never
    /// collide; the directory is not used.
    pub fn for_data_root(data_root: &Path) -> Result<Self, IpcError> {
        platform::Endpoint::for_data_root(data_root).map(Endpoint)
    }

    /// A form safe to put in diagnostics.
    pub fn display(&self) -> String {
        self.0.display()
    }
}

/// Accepts connections. Created only by the process holding `host.lock`.
///
/// `Debug` is derived because these appear in `Result`s that tests and callers unwrap;
/// the platform types print only their endpoint, never a handle value.
#[derive(Debug)]
pub struct Listener(platform::Listener);

impl Listener {
    pub fn bind(endpoint: &Endpoint) -> Result<Self, IpcError> {
        platform::Listener::bind(&endpoint.0).map(Listener)
    }

    /// Wait for one connection.
    pub fn accept(&mut self) -> Result<Stream, IpcError> {
        self.0.accept().map(Stream)
    }
}

/// One connection. Implements `Read` and `Write`; framing is the caller's business.
#[derive(Debug)]
pub struct Stream(platform::Stream);

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

/// Connect to a listening application process.
///
/// On Windows this also checks that the pipe was created by this same executable, which
/// is a partial defence against a squatted pipe name: a copy of the binary at the same
/// path would still pass. See the design note in the D06 local IPC spec.
pub fn connect(endpoint: &Endpoint) -> Result<Stream, IpcError> {
    platform::connect(&endpoint.0).map(Stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> (tempfile::TempDir, Endpoint) {
        let dir = tempfile::tempdir().unwrap();
        let endpoint = Endpoint::for_data_root(dir.path()).unwrap();
        (dir, endpoint)
    }

    #[test]
    fn a_stream_carries_bytes_in_both_directions() {
        let (_dir, endpoint) = endpoint();
        let mut listener = Listener::bind(&endpoint).unwrap();

        let client = {
            let endpoint = endpoint.clone();
            std::thread::spawn(move || {
                let mut stream = connect(&endpoint).unwrap();
                stream.write_all(b"ping").unwrap();
                stream.flush().unwrap();
                let mut reply = [0u8; 4];
                stream.read_exact(&mut reply).unwrap();
                reply
            })
        };

        let mut served = listener.accept().unwrap();
        let mut request = [0u8; 4];
        served.read_exact(&mut request).unwrap();
        assert_eq!(&request, b"ping");
        served.write_all(b"pong").unwrap();
        served.flush().unwrap();

        assert_eq!(&client.join().unwrap(), b"pong");
    }

    #[test]
    fn nothing_listening_is_reported_as_not_running() {
        let (_dir, endpoint) = endpoint();
        assert!(matches!(connect(&endpoint), Err(IpcError::NotRunning)));
    }

    #[test]
    fn a_second_listener_on_the_same_endpoint_is_refused() {
        // Only the holder of host.lock should listen. A second one means either a second
        // application process or, on Windows, a squatted name.
        let (_dir, endpoint) = endpoint();
        let _first = Listener::bind(&endpoint).unwrap();
        assert!(matches!(
            Listener::bind(&endpoint),
            Err(IpcError::AlreadyListening)
        ));
    }

    #[test]
    fn a_closed_peer_ends_the_stream_rather_than_erroring() {
        let (_dir, endpoint) = endpoint();
        let mut listener = Listener::bind(&endpoint).unwrap();
        let client = {
            let endpoint = endpoint.clone();
            std::thread::spawn(move || {
                let stream = connect(&endpoint).unwrap();
                drop(stream);
            })
        };
        let mut served = listener.accept().unwrap();
        client.join().unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(served.read(&mut buf).unwrap(), 0, "a closed peer reads as EOF");
    }

    #[test]
    fn the_endpoint_has_a_diagnostic_form() {
        let (_dir, endpoint) = endpoint();
        assert!(!endpoint.display().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_socket_is_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, endpoint) = endpoint();
        let _listener = Listener::bind(&endpoint).unwrap();
        let mode = std::fs::metadata(dir.path().join("host.sock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "the socket must not be readable by others");
    }

    #[cfg(unix)]
    #[test]
    fn a_path_over_the_sun_path_limit_says_so_instead_of_failing_to_bind() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("d".repeat(120));
        let err = Endpoint::for_data_root(&deep).unwrap_err();
        assert!(
            matches!(err, IpcError::PathTooLong { .. }),
            "expected a legible error, got {err:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_socket_file_does_not_block_the_lock_holder() {
        // A crash leaves the file behind. Listening is gated on holding host.lock, so the
        // holder may safely replace it.
        let (dir, endpoint) = endpoint();
        std::fs::write(dir.path().join("host.sock"), b"stale").unwrap();
        let _listener = Listener::bind(&endpoint).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn the_pipe_name_carries_the_current_user() {
        let (_dir, endpoint) = endpoint();
        let name = endpoint.display();
        assert!(name.starts_with(r"\\.\pipe\resume-pro-"), "{name}");
        assert!(name.contains("S-1-"), "the name must carry a SID: {name}");
    }

    #[cfg(windows)]
    #[test]
    fn the_pipe_grants_access_to_the_current_user_only() {
        let (_dir, endpoint) = endpoint();
        let _listener = Listener::bind(&endpoint).unwrap();
        let granted = super::platform::granted_sids(&endpoint.0).unwrap();
        let sid = super::platform::current_user_sid().unwrap();
        assert_eq!(
            granted,
            vec![sid],
            "exactly the current user must be granted, nobody else"
        );
    }

    #[test]
    fn a_saturated_listener_is_not_mistaken_for_a_stopped_one() {
        // A listener holds one unconnected instance at a time. Several hosts can connect
        // before it accepts, and the extra ones must not read as "the application is not
        // running" -- the caller would start a second application on the strength of it.
        let (_dir, endpoint) = endpoint();
        let _listener = Listener::bind(&endpoint).unwrap();
        let _first = connect(&endpoint).expect("the first client connects");
        match connect(&endpoint) {
            Ok(_) => {}
            Err(IpcError::Busy) => {}
            Err(other) => panic!("a busy listener must not read as stopped: {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_socket_directory_is_closed_to_others_before_the_socket_appears() {
        // bind() creates the socket under the process umask and only narrows it
        // afterwards, so the pathname is briefly reachable. Keeping the directory
        // owner-only means nobody can traverse to it during that window.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let endpoint = Endpoint::for_data_root(dir.path()).unwrap();
        let _listener = Listener::bind(&endpoint).unwrap();
        let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "the directory must not be traversable by others");
    }

    #[cfg(unix)]
    #[test]
    fn a_socket_that_cannot_be_probed_is_left_alone() {
        // A permission error says nothing about whether someone is serving. Removing the
        // file on the strength of one would put a second listener behind the same path,
        // which is exactly what the host.lock rule exists to prevent.
        use std::os::unix::fs::PermissionsExt;
        let (dir, endpoint) = endpoint();
        let listener = Listener::bind(&endpoint).unwrap();
        let socket = dir.path().join("host.sock");
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o000)).unwrap();

        let err = Listener::bind(&endpoint).unwrap_err();
        assert!(
            !matches!(err, IpcError::NotRunning),
            "an unprobeable socket must not read as absent: {err:?}"
        );
        assert!(socket.exists(), "the socket file must survive");
        drop(listener);
    }

    #[cfg(windows)]
    #[test]
    fn a_listener_that_stops_while_we_wait_reads_as_stopped_not_busy() {
        // Callers use Busy to conclude the application is still running and skip the cold
        // start. If it exited while we waited for a free instance, saying Busy would
        // leave the request unserved forever.
        let (_dir, endpoint) = endpoint();
        let listener = Listener::bind(&endpoint).unwrap();
        let _saturate = connect(&endpoint).expect("the only free instance is taken");

        let stopper = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            drop(listener);
        });
        let outcome = connect(&endpoint);
        stopper.join().unwrap();

        match outcome {
            Err(IpcError::NotRunning) => {}
            Err(IpcError::Busy) => panic!("a stopped listener must not read as busy"),
            Err(other) => panic!("unexpected error: {other:?}"),
            Ok(_) => panic!("the listener was dropped, so no stream should be handed out"),
        }
    }
}
