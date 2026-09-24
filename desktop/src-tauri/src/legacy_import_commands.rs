//! Confirm or reject a staged import. The archive and OS credential store cannot share
//! a transaction, so the archive records `applied_at` and retries skip template writes.

use archive_store::{ArchiveStore, LegacyImportStatus, StoreError};
use resume_pro_protocol::ErrorCode;

use crate::bridge_services::BridgeServices;

fn code_of(err: StoreError) -> ErrorCode {
    match err {
        StoreError::Conflict(_) => ErrorCode::Conflict,
        StoreError::NotFound(_) | StoreError::Validation(_) => ErrorCode::InvalidPayload,
        _ => ErrorCode::Unavailable,
    }
}

pub fn confirm(store: &ArchiveStore, services: &dyn BridgeServices, import_id: &str) -> Result<LegacyImportStatus, ErrorCode> {
    let current = store.legacy_import_status(import_id).map_err(code_of)?;
    if current.state == "imported" {
        if store.legacy_ai_config(import_id).map_err(code_of)?.is_some() {
            services.clear_import_key(import_id)?;
        }
        return Ok(current);
    }
    if current.state != "awaiting_confirmation" { return Err(ErrorCode::Conflict); }
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
    services.clear_import_key(import_id)?;
    Ok(finished)
}

pub fn reject(store: &ArchiveStore, services: &dyn BridgeServices, import_id: &str) -> Result<LegacyImportStatus, ErrorCode> {
    let status = store.reject_legacy_import(import_id).map_err(code_of)?;
    services.clear_import_key(import_id)?;
    Ok(status)
}

pub fn expire(store: &ArchiveStore, services: &dyn BridgeServices) -> Result<(), ErrorCode> {
    let mut ids = store.expire_legacy_imports(&archive_store::timeutil::now_utc()).map_err(code_of)?;
    ids.extend(store.legacy_import_cleanup_ids().map_err(code_of)?);
    ids.sort();
    ids.dedup();
    for id in ids { services.clear_import_key(&id)?; }
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
        assert_eq!(confirm(&store, &services, IMPORT).err(), Some(ErrorCode::Unavailable));
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
        assert_eq!(confirm(&store, &services, IMPORT).err(), Some(ErrorCode::InvalidPayload));
        assert!(store.resume_overview().unwrap().templates.is_empty());
        assert_eq!(store.legacy_import_status(IMPORT).unwrap().state, "awaiting_confirmation");
        assert_eq!(reject(&store, &services, IMPORT).unwrap().state, "rejected");
    }

    #[test]
    fn a_previous_expiration_still_cleans_up_its_temporary_key_on_startup() {
        let (_dir, store) = store();
        staged(&store);
        let services = FakeServices::default();
        services.stage_import_key(IMPORT, "sk-synthetic").unwrap();
        let later = (time::OffsetDateTime::now_utc() + time::Duration::hours(25))
            .format(&time::format_description::well_known::Rfc3339).unwrap();
        store.expire_legacy_imports(&later).unwrap();
        expire(&store, &services).unwrap();
        assert!(services.keys.lock().unwrap().is_empty());
    }
}
