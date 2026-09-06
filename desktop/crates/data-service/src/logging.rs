use crate::error::HostError;
use crate::paths::HostPaths;
use crate::redact::sanitize_context;
use serde_json::{json, Map, Value};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub const LOG_FILE_NAME: &str = "app.jsonl";

pub fn log_path(paths: &HostPaths) -> PathBuf {
    paths.logs_dir.join(LOG_FILE_NAME)
}

pub fn write_log(paths: &HostPaths, level: &str, code: &str, pairs: &[(&str, &str)]) -> Result<(), HostError> {
    let file_path = log_path(paths);
    let ts = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_string());
    let mut ctx = Map::new();
    for (k, v) in sanitize_context(pairs) {
        ctx.insert(k, Value::String(v));
    }
    let line = json!({
        "ts": ts,
        "level": level,
        "code": code,
        "ctx": ctx,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| HostError::log_write_failed(file_path.clone(), format!("open failed: {e}")))?;
    writeln!(file, "{line}")
        .map_err(|e| HostError::log_write_failed(file_path, format!("write failed: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::HostPaths;
    use std::fs;

    #[test]
    fn log_line_has_code_and_redacts_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = HostPaths::resolve_with(Some(tmp.path().join("data")), None).unwrap();
        paths.ensure_layout().unwrap();
        write_log(
            &paths,
            "info",
            "HOST_STARTED",
            &[
                ("platform", "windows"),
                ("api_key", "sk-should-not-appear"),
                ("cookie", "secret-cookie"),
            ],
        )
        .unwrap();
        let text = fs::read_to_string(log_path(&paths)).unwrap();
        assert!(text.contains("HOST_STARTED"));
        assert!(!text.contains("sk-should-not-appear"));
        assert!(!text.contains("secret-cookie"));
        assert!(!text.contains("api_key"));
    }
}
