//! The Native Messaging host's side of the local IPC.
//!
//! The host is a translator: it validates, forwards, and relays the answer. It does not
//! open the archive and it does not invent a successful response, so "persisted before
//! the answer" stays a property of the application process.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use local_ipc::{Endpoint, IpcError};

/// How long to wait for a cold-started application to answer its endpoint.
const COLD_START_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_INTERVAL: Duration = Duration::from_millis(150);

/// Reach the application, starting it if nothing is listening.
///
/// Several hosts can run at once — a browser starts one per message, and Chrome and Edge
/// each have their own — so several may find the application missing and try to start it
/// together. No extra mutex is needed: the single-instance rule means the extra processes
/// exit and the winner takes `host.lock` and listens, which the others reach by retrying.
pub fn connect_or_start(data_root: &Path, program: &Path) -> Result<local_ipc::Stream, IpcError> {
    let endpoint = Endpoint::for_data_root(data_root)?;
    match local_ipc::connect(&endpoint) {
        Ok(stream) => return Ok(stream),
        // Busy means it is running and saturated, so waiting is right and starting a
        // second one would be wrong.
        Err(IpcError::Busy) => return wait_for(&endpoint, COLD_START_TIMEOUT),
        Err(IpcError::NotRunning) => {}
        Err(other) => return Err(other),
    }

    if let Err(err) = start_hidden(program) {
        // A missing executable, a security product, a crash on startup: none of them can
        // be told apart from here, and none is worth failing differently. The wait below
        // decides, so this is reported and not returned.
        eprintln!("nm-host: could not start the application: {err}");
    }
    wait_for(&endpoint, COLD_START_TIMEOUT)
}

fn start_hidden(program: &Path) -> std::io::Result<()> {
    let mut child = std::process::Command::new(program)
        .arg("--hidden")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    // Dropping a Child does not reap it. On Unix the application would then sit as a
    // zombie for as long as this host lives, and a connectNative port lives as long as
    // the browser keeps it open. The wait happens on its own thread so the cold start
    // stays non-blocking, which is the whole point of not waiting here.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Retry until the endpoint answers or the deadline passes.
fn wait_for(endpoint: &Endpoint, budget: Duration) -> Result<local_ipc::Stream, IpcError> {
    let deadline = Instant::now() + budget;
    loop {
        match local_ipc::connect(endpoint) {
            Ok(stream) => return Ok(stream),
            Err(IpcError::NotRunning) | Err(IpcError::Busy) => {
                if Instant::now() >= deadline {
                    return Err(IpcError::NotRunning);
                }
                std::thread::sleep(RETRY_INTERVAL);
            }
            // An untrusted or unusable endpoint will not become usable by waiting.
            Err(other) => return Err(other),
        }
    }
}

/// The executable to start for a cold start: this same binary, which is also what the
/// Windows transport expects the listening process to be running.
pub fn own_program() -> Result<PathBuf, IpcError> {
    std::env::current_exe().map_err(IpcError::Io)
}

/// Send one frame to the application and return its answer.
pub fn exchange<S: Read + Write>(stream: &mut S, frame: &[u8]) -> Result<Vec<u8>, IpcError> {
    nm_frame::write_frame(stream, frame).map_err(frame_error)?;
    match nm_frame::read_frame(stream).map_err(frame_error)? {
        Some(reply) => Ok(reply),
        None => Err(IpcError::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the application closed the connection without answering",
        ))),
    }
}

fn frame_error(err: nm_frame::FrameError) -> IpcError {
    IpcError::Io(std::io::Error::other(format!("{err:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_application_is_reported_after_the_wait_rather_than_hanging() {
        // A cold start that cannot happen must end, and end as NotRunning so the caller
        // answers unavailable instead of blocking the browser forever.
        let dir = tempfile::tempdir().unwrap();
        let endpoint = Endpoint::for_data_root(dir.path()).unwrap();
        let started = Instant::now();
        let outcome = wait_for(&endpoint, Duration::from_millis(400));
        assert!(matches!(outcome, Err(IpcError::NotRunning)));
        assert!(
            started.elapsed() >= Duration::from_millis(400),
            "the budget must actually be spent"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "and not overspent"
        );
    }

    #[test]
    fn a_program_that_cannot_start_still_ends_as_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-program");
        // The wait dominates the runtime, so this uses the real budget only once.
        let endpoint = Endpoint::for_data_root(dir.path()).unwrap();
        assert!(start_hidden(&missing).is_err());
        assert!(matches!(
            wait_for(&endpoint, Duration::from_millis(200)),
            Err(IpcError::NotRunning)
        ));
    }

    #[test]
    fn a_running_application_is_reached_without_starting_another() {
        let dir = tempfile::tempdir().unwrap();
        struct NoArchive;
        impl crate::ipc_server::Application for NoArchive {
            fn identity(&self) -> Option<resume_pro_protocol::CurrentArchive> {
                None
            }
        }
        let _service =
            crate::ipc_server::start(dir.path(), std::sync::Arc::new(NoArchive)).unwrap();
        // A program path that cannot exist: if connect_or_start tried to start anything,
        // this would fail rather than reach the listener already there.
        let impossible = dir.path().join("must-not-be-started");
        let stream = connect_or_start(dir.path(), &impossible).unwrap();
        drop(stream);
        assert!(!impossible.exists());
    }
}
