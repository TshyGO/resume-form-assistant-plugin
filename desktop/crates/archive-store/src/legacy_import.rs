//! Durable staging for a one-time plugin import. API keys never enter these tables.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::error::StoreError;
use crate::store::ArchiveStore;
use crate::timeutil::now_utc;
use crate::tx::StoreTx;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegacyImportStatus {
    pub state: String,
    pub received: i64,
    pub total: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportPending {
    pub import_id: String,
    pub state: String,
    pub received: i64,
    pub total: i64,
    pub plugin_version: String,
}

#[derive(Debug, Clone)]
pub struct LegacyImportApply {
    pub status: LegacyImportStatus,
    /// Sanitized body: apiUrl, model and hasKey only. The key is in the OS store.
    pub ai_config: Option<Value>,
}

fn invalid(message: &str) -> StoreError { StoreError::Validation(message.into()) }
fn conflict(message: &str) -> StoreError { StoreError::Conflict(message.into()) }

fn validate_manifest(body: &Value) -> Result<(i64, &str), StoreError> {
    let total = body.get("total").and_then(Value::as_i64).ok_or_else(|| invalid("manifest total is missing"))?;
    let version = body.get("pluginVersion").and_then(Value::as_str).filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("manifest pluginVersion is missing"))?;
    let parts = body.get("parts").and_then(Value::as_array).ok_or_else(|| invalid("manifest parts are missing"))?;
    if !(1..=63).contains(&total) || parts.len() != total as usize {
        return Err(invalid("manifest parts must cover 1..total"));
    }
    let mut seen = HashSet::new();
    for part in parts {
        let index = part.get("index").and_then(Value::as_i64).ok_or_else(|| invalid("part index missing"))?;
        let kind = part.get("kind").and_then(Value::as_str).ok_or_else(|| invalid("part kind missing"))?;
        let sha = part.get("sha256").and_then(Value::as_str).ok_or_else(|| invalid("part sha256 missing"))?;
        if !(1..=total).contains(&index) || !seen.insert(index)
            || !matches!(kind, "template" | "profile" | "aiConfig")
            || sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(invalid("manifest part is not valid"));
        }
    }
    Ok((total, version))
}

impl ArchiveStore {
    pub fn receive_legacy_manifest(&self, import_id: &str, body: Value) -> Result<LegacyImportStatus, StoreError> {
        self.transaction(|tx| tx.receive_legacy_manifest(import_id, body))
    }

    pub fn receive_legacy_part(&self, import_id: &str, index: i64, kind: &str, digest: &str, body: Value) -> Result<LegacyImportStatus, StoreError> {
        self.transaction(|tx| tx.receive_legacy_part(import_id, index, kind, digest, body))
    }

    pub fn check_legacy_part(&self, import_id: &str, index: i64, kind: &str, digest: &str) -> Result<(), StoreError> {
        self.transaction(|tx| tx.checked_part(import_id, index, kind, digest).map(|_| ()))
    }

    pub fn legacy_import_status(&self, import_id: &str) -> Result<LegacyImportStatus, StoreError> {
        self.transaction(|tx| tx.legacy_import_status(import_id))
    }

    pub fn legacy_ai_config(&self, import_id: &str) -> Result<Option<Value>, StoreError> {
        self.transaction(|tx| {
            tx.legacy_import_status(import_id)?;
            tx.ai_config_body(import_id)
        })
    }

    pub fn list_pending_legacy_imports(&self) -> Result<Vec<LegacyImportPending>, StoreError> {
        self.transaction(|tx| tx.list_pending_legacy_imports())
    }

    pub fn expire_legacy_imports(&self, now: &str) -> Result<Vec<String>, StoreError> {
        self.transaction(|tx| tx.expire_legacy_imports(now))
    }

    pub fn legacy_import_cleanup_ids(&self) -> Result<Vec<String>, StoreError> {
        self.transaction(|tx| tx.legacy_import_cleanup_ids())
    }

    pub fn apply_legacy_confirmation(&self, import_id: &str) -> Result<LegacyImportApply, StoreError> {
        self.transaction(|tx| tx.apply_legacy_confirmation(import_id))
    }

    pub fn finish_legacy_confirmation(&self, import_id: &str) -> Result<LegacyImportStatus, StoreError> {
        self.transaction(|tx| tx.finish_legacy_confirmation(import_id))
    }

    pub fn reject_legacy_import(&self, import_id: &str) -> Result<LegacyImportStatus, StoreError> {
        self.transaction(|tx| tx.reject_legacy_import(import_id))
    }
}

impl StoreTx<'_> {
    pub fn legacy_import_status(&self, import_id: &str) -> Result<LegacyImportStatus, StoreError> {
        self.conn().query_row(
            "SELECT i.state, (SELECT COUNT(*) FROM legacy_import_parts p WHERE p.import_id = i.import_id), i.total \
             FROM legacy_imports i WHERE i.import_id = ?1",
            [import_id],
            |row| Ok(LegacyImportStatus { state: row.get(0)?, received: row.get(1)?, total: row.get(2)? }),
        ).optional()?.ok_or_else(|| StoreError::NotFound("legacy import not found".into()))
    }

    pub fn receive_legacy_manifest(&mut self, import_id: &str, body: Value) -> Result<LegacyImportStatus, StoreError> {
        let (total, version) = validate_manifest(&body)?;
        let manifest = serde_json::to_string(&body)?;
        let existing: Option<String> = self.conn().query_row(
            "SELECT manifest_json FROM legacy_imports WHERE import_id = ?1", [import_id], |row| row.get(0),
        ).optional()?;
        if let Some(existing) = existing {
            if existing != manifest { return Err(conflict("same importId has a different manifest")); }
            return self.legacy_import_status(import_id);
        }
        let active: Option<String> = self.conn().query_row(
            "SELECT import_id FROM legacy_imports WHERE state IN ('receiving','awaiting_confirmation') LIMIT 1",
            [], |row| row.get(0),
        ).optional()?;
        if active.is_some() { return Err(conflict("another legacy import is still active")); }
        let now = now_utc();
        self.conn().execute(
            "INSERT INTO legacy_imports (import_id, state, total, manifest_json, plugin_version, created_at, updated_at, applied_at) \
             VALUES (?1, 'receiving', ?2, ?3, ?4, ?5, ?5, NULL)",
            params![import_id, total, manifest, version, now],
        )?;
        self.legacy_import_status(import_id)
    }

    fn checked_part(&self, import_id: &str, index: i64, kind: &str, digest: &str) -> Result<(i64, bool), StoreError> {
        let (manifest_json, total, state): (String, i64, String) = self.conn().query_row(
            "SELECT manifest_json, total, state FROM legacy_imports WHERE import_id = ?1",
            [import_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound("legacy manifest not found".into()))?;
        let manifest: Value = serde_json::from_str(&manifest_json)?;
        let declared = manifest["parts"].as_array().unwrap().iter()
            .find(|part| part["index"].as_i64() == Some(index))
            .ok_or_else(|| conflict("part index is absent from manifest"))?;
        if !(1..=total).contains(&index) || declared["kind"] != kind || declared["sha256"] != digest {
            return Err(conflict("part differs from manifest"));
        }
        let existing: Option<(String, String)> = self.conn().query_row(
            "SELECT kind, sha256 FROM legacy_import_parts WHERE import_id = ?1 AND idx = ?2",
            params![import_id, index], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((old_kind, old_digest)) = existing {
            if old_kind != kind || old_digest != digest { return Err(conflict("part changed on retry")); }
            return Ok((total, true));
        }
        if state != "receiving" { return Err(conflict("import no longer accepts new parts")); }
        Ok((total, false))
    }

    pub fn receive_legacy_part(&mut self, import_id: &str, index: i64, kind: &str, digest: &str, body: Value) -> Result<LegacyImportStatus, StoreError> {
        let (total, existing) = self.checked_part(import_id, index, kind, digest)?;
        if existing { return self.legacy_import_status(import_id); }
        if kind == "aiConfig" {
            let obj = body.as_object().ok_or_else(|| invalid("AI config body must be an object"))?;
            if obj.get("hasKey") != Some(&Value::Bool(true)) || obj.contains_key("apiKey")
                || obj.keys().any(|key| !matches!(key.as_str(), "apiUrl" | "model" | "hasKey"))
            {
                return Err(invalid("AI config must be staged without its API key"));
            }
        }
        self.conn().execute(
            "INSERT INTO legacy_import_parts (import_id, idx, kind, sha256, body_json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![import_id, index, kind, digest, serde_json::to_string(&body)?],
        )?;
        let status = self.legacy_import_status(import_id)?;
        if status.received == total {
            self.conn().execute(
                "UPDATE legacy_imports SET state = 'awaiting_confirmation', updated_at = ?2 WHERE import_id = ?1",
                params![import_id, now_utc()],
            )?;
        }
        self.legacy_import_status(import_id)
    }

    pub fn list_pending_legacy_imports(&self) -> Result<Vec<LegacyImportPending>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT i.import_id, i.state, (SELECT COUNT(*) FROM legacy_import_parts p WHERE p.import_id = i.import_id), \
             i.total, i.plugin_version FROM legacy_imports i \
             WHERE i.state IN ('receiving','awaiting_confirmation') ORDER BY i.created_at",
        )?;
        let rows = stmt.query_map([], |row| Ok(LegacyImportPending {
            import_id: row.get(0)?, state: row.get(1)?, received: row.get(2)?,
            total: row.get(3)?, plugin_version: row.get(4)?,
        }))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    pub fn expire_legacy_imports(&mut self, now: &str) -> Result<Vec<String>, StoreError> {
        let instant = crate::timeutil::parse_rfc3339(now)?;
        let cutoff = crate::timeutil::format_timestamp(instant - time::Duration::hours(24));
        let mut stmt = self.conn().prepare(
            "SELECT import_id FROM legacy_imports WHERE state IN ('receiving','awaiting_confirmation') \
             AND applied_at IS NULL AND created_at < ?1",
        )?;
        let ids = stmt.query_map([cutoff], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        for id in &ids {
            self.conn().execute("DELETE FROM legacy_import_parts WHERE import_id = ?1", [id])?;
            self.conn().execute(
                "UPDATE legacy_imports SET state = 'expired', updated_at = ?2 WHERE import_id = ?1",
                params![id, now],
            )?;
        }
        Ok(ids)
    }

    pub fn legacy_import_cleanup_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT import_id, manifest_json FROM legacy_imports WHERE state IN ('imported','rejected','expired')",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        let mut ids = Vec::new();
        for row in rows {
            let (id, manifest) = row?;
            let value: Value = serde_json::from_str(&manifest)?;
            if value["parts"].as_array().is_some_and(|parts| parts.iter().any(|part| part["kind"] == "aiConfig")) {
                ids.push(id);
            }
        }
        Ok(ids)
    }

    fn ai_config_body(&self, import_id: &str) -> Result<Option<Value>, StoreError> {
        let raw: Option<String> = self.conn().query_row(
            "SELECT body_json FROM legacy_import_parts WHERE import_id = ?1 AND kind = 'aiConfig' LIMIT 1",
            [import_id], |row| row.get(0),
        ).optional()?;
        raw.map(|body| serde_json::from_str(&body).map_err(StoreError::from)).transpose()
    }

    pub fn apply_legacy_confirmation(&mut self, import_id: &str) -> Result<LegacyImportApply, StoreError> {
        let (state, applied_at): (String, Option<String>) = self.conn().query_row(
            "SELECT state, applied_at FROM legacy_imports WHERE import_id = ?1",
            [import_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound("legacy import not found".into()))?;
        if state == "imported" {
            return Ok(LegacyImportApply { status: self.legacy_import_status(import_id)?, ai_config: None });
        }
        if state != "awaiting_confirmation" { return Err(conflict("legacy import is not ready for confirmation")); }
        let ai_config = self.ai_config_body(import_id)?;
        if applied_at.is_some() {
            return Ok(LegacyImportApply { status: self.legacy_import_status(import_id)?, ai_config });
        }
        let mut stmt = self.conn().prepare(
            "SELECT kind, body_json FROM legacy_import_parts WHERE import_id = ?1 ORDER BY idx",
        )?;
        let parts = stmt.query_map([import_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        // Check profile conflict before creating any template. The transaction would roll
        // changes back anyway, but this keeps the failure's meaning unambiguous.
        for (kind, raw) in &parts {
            if kind == "profile" {
                let current = self.get_profile()?;
                if current.revision != 0 || current.profile != crate::resume::empty_profile() {
                    return Err(conflict("existing profile requires a user choice"));
                }
                let profile: Value = serde_json::from_str(raw)?;
                crate::resume::validate_profile(&profile)?;
                crate::resume::reject_profile_secrets(&profile)?;
            }
        }
        let mut active_template = None;
        for (kind, raw) in &parts {
            let body: Value = serde_json::from_str(raw)?;
            match kind.as_str() {
                "template" => {
                    let name = body["name"].as_str().ok_or_else(|| invalid("template name missing"))?;
                    let groups: Vec<crate::resume::TemplateGroup> = serde_json::from_value(body["groups"].clone())?;
                    let saved = self.create_template(name, groups)?;
                    if body["wasActive"] == true { active_template = Some(saved.template.id); }
                }
                "profile" => {
                    self.save_profile(body, 0)?;
                }
                "aiConfig" => {}
                _ => return Err(invalid("unknown legacy part kind")),
            }
        }
        if let Some(id) = active_template { self.set_active_template(&id)?; }
        let now = now_utc();
        let next = if ai_config.is_some() { "awaiting_confirmation" } else { "imported" };
        self.conn().execute(
            "UPDATE legacy_imports SET applied_at = ?2, state = ?3, updated_at = ?2 WHERE import_id = ?1",
            params![import_id, now, next],
        )?;
        if ai_config.is_none() {
            self.conn().execute("UPDATE legacy_import_parts SET body_json = '{}' WHERE import_id = ?1", [import_id])?;
        }
        Ok(LegacyImportApply { status: self.legacy_import_status(import_id)?, ai_config })
    }

    pub fn finish_legacy_confirmation(&mut self, import_id: &str) -> Result<LegacyImportStatus, StoreError> {
        let (state, applied_at): (String, Option<String>) = self.conn().query_row(
            "SELECT state, applied_at FROM legacy_imports WHERE import_id = ?1",
            [import_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound("legacy import not found".into()))?;
        if state == "imported" { return self.legacy_import_status(import_id); }
        if state != "awaiting_confirmation" || applied_at.is_none() {
            return Err(conflict("legacy import has not been applied"));
        }
        self.conn().execute(
            "UPDATE legacy_imports SET state = 'imported', updated_at = ?2 WHERE import_id = ?1",
            params![import_id, now_utc()],
        )?;
        self.conn().execute("UPDATE legacy_import_parts SET body_json = '{}' WHERE import_id = ?1", [import_id])?;
        self.legacy_import_status(import_id)
    }

    pub fn reject_legacy_import(&mut self, import_id: &str) -> Result<LegacyImportStatus, StoreError> {
        let (state, applied_at): (String, Option<String>) = self.conn().query_row(
            "SELECT state, applied_at FROM legacy_imports WHERE import_id = ?1",
            [import_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?.ok_or_else(|| StoreError::NotFound("legacy import not found".into()))?;
        if state == "rejected" { return self.legacy_import_status(import_id); }
        if !matches!(state.as_str(), "receiving" | "awaiting_confirmation") || applied_at.is_some() {
            return Err(conflict("applied legacy import cannot be rejected"));
        }
        self.conn().execute("DELETE FROM legacy_import_parts WHERE import_id = ?1", [import_id])?;
        self.conn().execute(
            "UPDATE legacy_imports SET state = 'rejected', updated_at = ?2 WHERE import_id = ?1",
            params![import_id, now_utc()],
        )?;
        self.legacy_import_status(import_id)
    }
}
