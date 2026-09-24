//! Confirm or reject a staged import. The archive and OS credential store cannot share
//! a transaction, so the archive records `applied_at` and retries skip template writes.

use archive_store::{ArchiveStore, LegacyImportStatus, StoreError, MAX_TEMPLATES};
use resume_pro_protocol::ErrorCode;

use crate::bridge_services::BridgeServices;
use crate::commands::CommandError;

fn code_of(err: StoreError) -> ErrorCode {
    match err {
        StoreError::Conflict(_) => ErrorCode::Conflict,
        StoreError::NotFound(_) | StoreError::Validation(_) => ErrorCode::InvalidPayload,
        _ => ErrorCode::Unavailable,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfirmError {
    Protocol(ErrorCode),
    /// Confirming would take the desktop past [MAX_TEMPLATES]; the user has to make room.
    TooManyTemplates { existing: usize, incoming: usize },
}

impl From<ErrorCode> for ConfirmError {
    fn from(code: ErrorCode) -> Self { Self::Protocol(code) }
}

/// What the desktop shows for a failed confirm or reject. Fixed wording: nothing from the
/// staged data or the credential store reaches the message.
pub fn command_error(err: ConfirmError) -> CommandError {
    let (code, message) = match err {
        ConfirmError::TooManyTemplates { existing, incoming } => ("template_limit".to_string(), format!(
            "桌面已有 {existing} 个模板，再导入 {incoming} 个会超过 {MAX_TEMPLATES} 个上限，请先在桌面删掉一些再确认。"
        )),
        ConfirmError::Protocol(code) => (code.as_str().to_string(), match code {
            ErrorCode::Conflict => "旧数据与当前档案冲突，需要在桌面核对后再确认。",
            ErrorCode::InvalidPayload => "旧数据导入的清单或分片不符合协议。",
            _ => "旧数据导入暂时无法完成，请检查档案与系统凭据库后重试。",
        }.to_string()),
    };
    CommandError { code, message }
}

/// Delete an import's temporary key and remember that it is gone. A failure is logged
/// (without the key or the import's content) and left for the next startup cleanup.
pub fn clear_key_best_effort(store: &ArchiveStore, services: &dyn BridgeServices, import_id: &str) -> bool {
    match services.clear_import_key(import_id) {
        Ok(()) => {
            if let Err(err) = store.mark_legacy_key_cleaned(import_id) {
                eprintln!("legacy import: temporary key deleted but not recorded ({})", err.code());
            }
            true
        }
        Err(code) => {
            eprintln!("legacy import: temporary key not deleted yet ({})", code.as_str());
            false
        }
    }
}

fn clear_key(store: &ArchiveStore, services: &dyn BridgeServices, import_id: &str) -> Result<(), ErrorCode> {
    services.clear_import_key(import_id)?;
    store.mark_legacy_key_cleaned(import_id).map_err(code_of)
}

pub fn confirm(store: &ArchiveStore, services: &dyn BridgeServices, import_id: &str) -> Result<LegacyImportStatus, ConfirmError> {
    let current = store.legacy_import_status(import_id).map_err(code_of)?;
    if current.state == "imported" {
        if store.legacy_ai_config(import_id).map_err(code_of)?.is_some() {
            clear_key(store, services, import_id)?;
        }
        return Ok(current);
    }
    if current.state != "awaiting_confirmation" { return Err(ErrorCode::Conflict.into()); }
    if let Some((existing, incoming)) = store.legacy_template_overflow(import_id).map_err(code_of)? {
        return Err(ConfirmError::TooManyTemplates { existing, incoming });
    }
    let ai_config = store.legacy_ai_config(import_id).map_err(code_of)?;
    let key = if ai_config.is_some() {
        Some(services.get_import_key(import_id)?.ok_or(ErrorCode::Unavailable)?)
    } else { None };
    if let Some(ai) = &ai_config {
        services.validate_import_provider(
            import_id,
            ai["apiUrl"].as_str().ok_or(ErrorCode::InvalidPayload)?,
            ai["model"].as_str().ok_or(ErrorCode::InvalidPayload)?,
        )?;
    }
    let applied = store.apply_legacy_confirmation(import_id).map_err(code_of)?;
    let Some(ai) = applied.ai_config else { return Ok(applied.status); };
    let key = key.ok_or(ErrorCode::Unavailable)?;
    let api_url = ai["apiUrl"].as_str().ok_or(ErrorCode::InvalidPayload)?;
    let model = ai["model"].as_str().ok_or(ErrorCode::InvalidPayload)?;
    services.install_import_provider(import_id, api_url, model, &key)?;
    let finished = store.finish_legacy_confirmation(import_id).map_err(code_of)?;
    clear_key(store, services, import_id)?;
    Ok(finished)
}

/// Reject a staged import. If templates/profile were already applied, retain those
/// rows but report rejected so the plugin keeps its old copy and Key. The temporary
/// desktop Key is cleared either way.
pub fn reject(store: &ArchiveStore, services: &dyn BridgeServices, import_id: &str) -> Result<LegacyImportStatus, ErrorCode> {
    let status = store.reject_legacy_import(import_id).map_err(code_of)?;
    clear_key(store, services, import_id)?;
    Ok(status)
}

/// Startup: expire stale batches and delete every temporary key not yet deleted. One key
/// the OS store refuses to delete does not stop the others; it is retried next time.
pub fn expire(store: &ArchiveStore, services: &dyn BridgeServices) -> Result<(), ErrorCode> {
    let mut ids = store.expire_legacy_imports(&archive_store::timeutil::now_utc()).map_err(code_of)?;
    let cleanup = store.legacy_import_cleanup_ids().map_err(code_of)?;
    if cleanup.skipped > 0 {
        eprintln!("legacy import cleanup: skipped {} unreadable import rows", cleanup.skipped);
    }
    ids.extend(cleanup.ids);
    ids.sort();
    ids.dedup();
    for id in ids { clear_key_best_effort(store, services, &id); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge_services::AiReply;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};

    const IMPORT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Default)]
    struct FakeServices {
        keys: Mutex<HashMap<String, String>>,
        providers: Mutex<Vec<String>>,
        fail_install: AtomicBool,
        fail_validate: AtomicBool,
        fail_clear: AtomicBool,
    }

    impl BridgeServices for FakeServices {
        fn ai_complete(&self, _: &str, _: &str, _: &str) -> AiReply { AiReply::Ok(String::new()) }
        fn open_view(&self, _: &str) -> bool { false }
        fn stage_import_key(&self, id: &str, key: &str) -> Result<(), ErrorCode> {
            self.keys.lock().unwrap().insert(id.into(), key.into()); Ok(())
        }
        fn get_import_key(&self, id: &str) -> Result<Option<String>, ErrorCode> {
            Ok(self.keys.lock().unwrap().get(id).cloned())
        }
        fn clear_import_key(&self, id: &str) -> Result<(), ErrorCode> {
            if self.fail_clear.load(Ordering::Relaxed) { return Err(ErrorCode::Unavailable); }
            self.keys.lock().unwrap().remove(id); Ok(())
        }
        fn install_import_provider(&self, id: &str, _: &str, _: &str, _: &str) -> Result<(), ErrorCode> {
            if self.fail_install.load(Ordering::Relaxed) { return Err(ErrorCode::Unavailable); }
            let mut providers = self.providers.lock().unwrap();
            if !providers.contains(&id.to_string()) { providers.push(id.into()); }
            Ok(())
        }
        fn validate_import_provider(&self, _: &str, _: &str, _: &str) -> Result<(), ErrorCode> {
            if self.fail_validate.load(Ordering::Relaxed) { Err(ErrorCode::InvalidPayload) } else { Ok(()) }
        }
    }

    fn store() -> (tempfile::TempDir, ArchiveStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::commands::open_store(&dir.path().join("archive"), &dir.path().join("current.json")).unwrap();
        (dir, store)
    }

    fn staged(store: &ArchiveStore) {
        store.receive_legacy_manifest(IMPORT, json!({"pluginVersion":"0.4.0","total":2,"parts":[
            {"index":1,"kind":"template","sha256":HASH},{"index":2,"kind":"aiConfig","sha256":HASH}
        ]})).unwrap();
        store.receive_legacy_part(IMPORT, 1, "template", HASH,
            json!({"name":"First","wasActive":true,"groups":[{"name":"Basic","fields":[{"key":"Name","value":"Alice"}]}]})).unwrap();
        store.receive_legacy_part(IMPORT, 2, "aiConfig", HASH,
            json!({"apiUrl":"https://api.example.com/v1","model":"m","hasKey":true})).unwrap();
    }

    #[test]
    fn retrying_after_a_credential_failure_never_imports_the_template_twice() {
        let (_dir, store) = store();
        staged(&store);
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        services.fail_install.store(true, Ordering::Relaxed);
        assert_eq!(confirm(&store, &services, IMPORT).err(), Some(ConfirmError::Protocol(ErrorCode::Unavailable)));
        assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");
        assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
        services.fail_install.store(false, Ordering::Relaxed);
        assert_eq!(confirm(&store, &services, IMPORT).unwrap().state, "imported");
        assert_eq!(confirm(&store, &services, IMPORT).unwrap().state, "imported");
        assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
        assert_eq!(services.providers.lock().unwrap().len(), 1);
        assert!(services.keys.lock().unwrap().is_empty());
    }

    #[test]
    fn rejection_clears_the_temporary_key_without_importing_anything() {
        let (_dir, store) = store();
        staged(&store);
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        assert_eq!(reject(&store, &services, IMPORT).unwrap().state, "rejected");
        assert!(services.keys.lock().unwrap().is_empty());
        assert!(store.resume_overview().unwrap().templates.is_empty());
    }

    #[test]
    fn invalid_ai_settings_stop_confirmation_before_any_template_is_applied() {
        let (_dir, store) = store();
        staged(&store);
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        services.fail_validate.store(true, Ordering::Relaxed);
        assert_eq!(confirm(&store, &services, IMPORT).err(), Some(ConfirmError::Protocol(ErrorCode::InvalidPayload)));
        assert!(store.resume_overview().unwrap().templates.is_empty());
        assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");
        assert_eq!(reject(&store, &services, IMPORT).unwrap().state, "rejected");
    }

    #[test]
    fn a_previous_expiration_still_cleans_up_its_temporary_key_on_startup() {
        let (_dir, store) = store();
        // Only a batch that never finished arriving expires: the template never came.
        store.receive_legacy_manifest(IMPORT, json!({"pluginVersion":"0.4.0","total":2,"parts":[
            {"index":1,"kind":"template","sha256":HASH},{"index":2,"kind":"aiConfig","sha256":HASH}
        ]})).unwrap();
        store.receive_legacy_part(IMPORT, 2, "aiConfig", HASH,
            json!({"apiUrl":"https://api.example.com/v1","model":"m","hasKey":true})).unwrap();
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        let later = (time::OffsetDateTime::now_utc() + time::Duration::hours(25))
            .format(&time::format_description::well_known::Rfc3339).unwrap();
        store.expire_legacy_imports(&later).unwrap();
        expire(&store, &services).unwrap();
        assert!(services.keys.lock().unwrap().is_empty());
    }

    const OTHER: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    #[test]
    fn an_applied_import_whose_ai_step_cannot_finish_is_rejected_without_dropping_the_old_key() {
        let (_dir, store) = store();
        staged(&store);
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        services.fail_install.store(true, Ordering::Relaxed);
        assert_eq!(confirm(&store, &services, IMPORT).err(), Some(ConfirmError::Protocol(ErrorCode::Unavailable)));
        assert_eq!(store.resume_overview().unwrap().templates.len(), 1);

        assert_eq!(reject(&store, &services, IMPORT).unwrap().state, "rejected");
        assert!(services.keys.lock().unwrap().is_empty());
        assert!(services.providers.lock().unwrap().is_empty());
        assert_eq!(store.resume_overview().unwrap().templates.len(), 1);
        assert!(store.legacy_import_cleanup_ids().unwrap().ids.is_empty());
        let next = store.receive_legacy_manifest(OTHER, json!({"pluginVersion":"0.4.0","total":1,"parts":[
            {"index":1,"kind":"template","sha256":HASH}
        ]})).unwrap();
        assert_eq!(next.state, "receiving");
    }

    #[test]
    fn confirmation_names_both_counts_when_templates_would_pass_the_limit() {
        let (_dir, store) = store();
        for i in 0..archive_store::MAX_TEMPLATES {
            store.create_template(&format!("Existing {i}"), vec![archive_store::TemplateGroup {
                name: "Basic".into(),
                fields: vec![archive_store::TemplateField { key: "Name".into(), value: "Alice".into() }],
            }]).unwrap();
        }
        staged(&store);
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        let err = confirm(&store, &services, IMPORT).unwrap_err();
        assert_eq!(err, ConfirmError::TooManyTemplates { existing: 25, incoming: 1 });
        let shown = command_error(err);
        assert_eq!(shown.code, "template_limit");
        assert_eq!(shown.message, "桌面已有 25 个模板，再导入 1 个会超过 25 个上限，请先在桌面删掉一些再确认。");
        assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");
        assert_eq!(services.keys.lock().unwrap().len(), 1);
    }

    #[test]
    fn startup_cleanup_keeps_going_past_a_key_it_cannot_delete_and_retries_it_later() {
        let (_dir, store) = store();
        staged(&store);
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        services.fail_clear.store(true, Ordering::Relaxed);
        assert!(reject(&store, &services, IMPORT).is_err());
        assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "rejected");

        expire(&store, &services).unwrap();
        assert_eq!(store.legacy_import_cleanup_ids().unwrap().ids, vec![IMPORT.to_string()]);
        services.fail_clear.store(false, Ordering::Relaxed);
        expire(&store, &services).unwrap();
        assert!(services.keys.lock().unwrap().is_empty());
        assert!(store.legacy_import_cleanup_ids().unwrap().ids.is_empty());
    }
}
