//! D08: the finished snapshot file, written once every chunk is staged.
//!
//! The file is the durable copy the complete ACK promises. It is written through a temporary
//! name, flushed, and renamed into place before the snapshot row is committed; a crash in
//! between leaves either no file or a complete one, and the next attempt rewrites the same
//! bytes under the same name.

use std::io::Write;
use std::path::Path;

use crate::error::StoreError;

/// Snapshot documents the plugin writes (link/snapshot.mjs).
const SNAPSHOT_FORMAT: &str = "resume-pro.snapshot";

/// `snapshots/<snapshotId>.json`. The id arrives as a protocol UUID; anything else is refused
/// rather than escaped, so a hostile id can never name a path.
pub(crate) fn rel_path_for(snapshot_id: &str) -> Result<String, StoreError> {
    if snapshot_id.is_empty()
        || snapshot_id.len() > 64
        || !snapshot_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(StoreError::Validation("unsafe snapshot id".into()));
    }
    Ok(format!("snapshots/{snapshot_id}.json"))
}

pub(crate) fn write_atomically(root: &Path, rel: &str, bytes: &[u8]) -> Result<(), StoreError> {
    let target = root.join(rel);
    let dir = target
        .parent()
        .ok_or_else(|| StoreError::PathInvalid("snapshot path has no directory".into()))?;
    std::fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| StoreError::PathInvalid("snapshot path has no file name".into()))?;
    let partial = dir.join(format!(".{name}.partial"));
    {
        let mut file = std::fs::File::create(&partial)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&partial, &target)?;
    // Make the rename itself durable where the platform allows it; Windows has no directory
    // handle to flush and commits the rename with the file system journal.
    #[cfg(unix)]
    std::fs::File::open(dir)?.sync_all()?;
    Ok(())
}

/// The template name and version recorded in a v1 snapshot, or `("unknown", None)` for
/// content in any other shape. Every byte was already acknowledged chunk by chunk, so an
/// unrecognised document is still kept; it is only its label that is unknown.
pub(crate) fn template_of(bytes: &[u8]) -> (String, Option<String>) {
    let unknown = || ("unknown".to_string(), None);
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return unknown();
    };
    if doc.get("format").and_then(|v| v.as_str()) != Some(SNAPSHOT_FORMAT) {
        return unknown();
    }
    let Some(name) = doc
        .get("templateName")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= 200)
    else {
        return unknown();
    };
    let version = doc
        .get("templateVersion")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty() && v.len() <= 64)
        .map(str::to_string);
    (name.to_string(), version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_protocol_shaped_ids_name_a_file() {
        assert_eq!(
            rel_path_for("66666666-6666-4666-8666-666666666666").unwrap(),
            "snapshots/66666666-6666-4666-8666-666666666666.json"
        );
        for hostile in ["../x", "a/b", "a\\b", "", "x.json", &"a".repeat(65)] {
            assert!(rel_path_for(hostile).is_err(), "{hostile}");
        }
    }

    #[test]
    fn a_file_left_by_an_attempt_that_never_committed_is_replaced() {
        // A crash between the rename and the SQLite commit leaves the target behind; the next
        // attempt has to be able to write over it on every platform, Windows included.
        let dir = tempfile::tempdir().unwrap();
        let rel = rel_path_for("66666666-6666-4666-8666-666666666666").unwrap();
        write_atomically(dir.path(), &rel, b"left over from a rolled-back attempt").unwrap();
        let partial = dir.path().join("snapshots").join(".66666666-6666-4666-8666-666666666666.json.partial");
        std::fs::write(&partial, b"torn").unwrap();

        write_atomically(dir.path(), &rel, b"the real bytes").unwrap();
        assert_eq!(std::fs::read(dir.path().join(&rel)).unwrap(), b"the real bytes");
        assert!(!partial.exists());
    }

    #[test]
    fn the_template_label_comes_only_from_a_v1_document() {
        let v1 = br#"{"format":"resume-pro.snapshot","formatVersion":1,"templateName":" A ","templateVersion":"abc"}"#;
        assert_eq!(template_of(v1), ("A".into(), Some("abc".into())));
        assert_eq!(template_of(b"{\"templateName\":\"A\"}"), ("unknown".into(), None));
        assert_eq!(template_of(b"not json"), ("unknown".into(), None));
        let blank = br#"{"format":"resume-pro.snapshot","templateName":"  "}"#;
        assert_eq!(template_of(blank), ("unknown".into(), None));
    }
}
