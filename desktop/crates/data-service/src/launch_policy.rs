//! Persist explicit quit across browser/host restarts, independently of the archive.
//!
//! All launch decisions and quit writes share an OS file lock. A quitting application
//! keeps its guard until process exit, so a manual reopen cannot connect to that dying
//! instance or clear its marker before it is gone. Never remove the lock file itself.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MARKER: &str = "explicit-quit";

pub struct LaunchGuard {
    _lock: fslock::LockFile,
    root: PathBuf,
}

impl LaunchGuard {
    pub fn acquire(root: &Path, budget: Duration) -> io::Result<Self> {
        fs::create_dir_all(root)?;
        let mut lock = fslock::LockFile::open(&root.join("launch-policy.lock"))?;
        let started = Instant::now();
        while !lock.try_lock()? {
            if started.elapsed() >= budget {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "launch policy is busy",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Ok(Self {
            _lock: lock,
            root: root.to_path_buf(),
        })
    }

    pub fn ensure_background_allowed(&self) -> io::Result<()> {
        Self::check_marker(&self.root)
    }

    /// Wait for ordinary initialization, but stop promptly when a quitting process
    /// writes its marker and holds the gate until process death. The unlocked check
    /// can only reject; permission is checked again after acquiring the gate.
    pub fn acquire_background(root: &Path, budget: Duration) -> io::Result<Self> {
        let started = Instant::now();
        loop {
            Self::check_marker(root)?;
            match Self::acquire(root, Duration::ZERO) {
                Ok(guard) => {
                    guard.ensure_background_allowed()?;
                    return Ok(guard);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock
                    && started.elapsed() < budget => {
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn check_marker(root: &Path) -> io::Result<()> {
        // exists() hides permission/I/O errors. Only a confirmed missing marker allows
        // a background start; even a malformed marker is a reason to stay stopped.
        match fs::symlink_metadata(root.join(MARKER)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "desktop was explicitly quit",
            )),
        }
    }

    pub fn record_quit(&self) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(self.root.join(MARKER))?;
        file.write_all(b"User explicitly quit. Only a manual open may resume.\n")?;
        file.sync_all()?;
        self.sync_directory()
    }

    pub fn resume(&self) -> io::Result<()> {
        match fs::remove_file(self.root.join(MARKER)) {
            Ok(()) => self.sync_directory(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn sync_directory(&self) -> io::Result<()> {
        #[cfg(unix)]
        std::fs::File::open(&self.root)?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_survives_new_hosts_and_only_manual_resume_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let guard = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        guard.ensure_background_allowed().unwrap();
        guard.record_quit().unwrap();
        drop(guard);
        for _ in 0..3 {
            let host = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
            assert!(host.ensure_background_allowed().is_err());
        }
        let manual = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        manual.resume().unwrap();
        manual.ensure_background_allowed().unwrap();
    }

    #[test]
    fn a_quitting_process_excludes_concurrent_background_and_manual_launches() {
        let dir = tempfile::tempdir().unwrap();
        let quitting = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        quitting.record_quit().unwrap();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let root = dir.path();
                scope.spawn(move || {
                    assert!(
                        matches!(LaunchGuard::acquire(root, Duration::from_millis(50)),
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock)
                    );
                });
            }
        });
        drop(quitting);
        let delayed_child = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        assert!(delayed_child.ensure_background_allowed().is_err());
    }

    #[test]
    fn background_waits_for_startup_but_observes_quit_while_gate_is_still_held() {
        let dir = tempfile::tempdir().unwrap();
        let startup = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        std::thread::scope(|scope| {
            let pending = scope.spawn(|| LaunchGuard::acquire_background(dir.path(), Duration::from_secs(2)));
            std::thread::sleep(Duration::from_millis(75));
            drop(startup);
            assert!(pending.join().unwrap().is_ok());
        });
        let quitting = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        std::thread::scope(|scope| {
            let pending = scope.spawn(|| LaunchGuard::acquire_background(dir.path(), Duration::from_secs(10)));
            std::thread::sleep(Duration::from_millis(75));
            quitting.record_quit().unwrap();
            let started = Instant::now();
            assert!(pending.join().unwrap().is_err());
            assert!(started.elapsed() < Duration::from_secs(2));
            // The quitting process still owns the guard here.
        });
    }

    #[test]
    fn failed_writes_and_unreadable_state_do_not_turn_into_permission_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let guard = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        fs::create_dir(dir.path().join(MARKER)).unwrap();
        assert!(guard.record_quit().is_err());
        assert!(guard.resume().is_err());
        assert!(guard.ensure_background_allowed().is_err());
        let file = dir.path().join("not-a-directory");
        fs::write(&file, b"x").unwrap();
        assert!(LaunchGuard::acquire(&file, Duration::ZERO).is_err());
    }

    #[test]
    #[ignore = "helper launched by the cross-process test"]
    fn child_probe() {
        let root = std::env::var_os("QUIT_POLICY_TEST_ROOT").unwrap();
        let outcome = match LaunchGuard::acquire(Path::new(&root), Duration::ZERO) {
            Ok(guard) if guard.ensure_background_allowed().is_ok() => "allowed",
            Ok(_) => "stopped",
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => "busy",
            Err(error) => panic!("unexpected policy error: {error}"),
        };
        assert_eq!(outcome, std::env::var("QUIT_POLICY_TEST_EXPECT").unwrap());
    }

    #[test]
    fn new_processes_observe_the_shutdown_lock_and_persistent_quit() {
        let dir = tempfile::tempdir().unwrap();
        let probe = |expected| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "launch_policy::tests::child_probe", "--ignored"])
                .env("QUIT_POLICY_TEST_ROOT", dir.path())
                .env("QUIT_POLICY_TEST_EXPECT", expected)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        };
        let quitting = LaunchGuard::acquire(dir.path(), Duration::ZERO).unwrap();
        quitting.record_quit().unwrap();
        probe("busy");
        drop(quitting);
        probe("stopped");
        LaunchGuard::acquire(dir.path(), Duration::ZERO)
            .unwrap()
            .resume()
            .unwrap();
        probe("allowed");
    }
}
