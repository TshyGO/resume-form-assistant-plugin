//! Unique-writer host surface for Resume Pro Desktop (D02).
//!
//! D03 opens SQLite under [`HostPaths::archive_dir`] and writes `current.json`
//! at [`HostPaths::current_pointer`]. D06 should start the same application
//! process (`--hidden` if no window is needed). This crate does not implement
//! Native Messaging, schema, or application CRUD.

mod error;
mod host;
mod logging;
mod paths;
mod redact;
mod webview;

pub use error::{HostError, HostErrorDto, DIR_CREATE_FAILED, DIR_NOT_WRITABLE, INSTANCE_LOCK_FAILED, LOG_WRITE_FAILED, PATH_INVALID};
pub use host::{diagnostics_from, probe, probe_with, write_diagnostics_file, DataHost, PairingDraft, ProbeReport};
pub use logging::{log_path, write_log, LOG_FILE_NAME};
pub use paths::{program_dir, HostPaths, DATA_DIR_NAME};
pub use redact::{is_forbidden_key, path_replacements, redact_path, redact_value, sanitize_context};
pub use webview::{webview_storage, WebViewStorage};
