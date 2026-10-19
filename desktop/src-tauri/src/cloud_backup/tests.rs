use super::{model::*, remote::Remote, *};
use std::collections::{BTreeMap, BTreeSet};
use webdav_client::{Completeness, Entry, Listing, ObjectInfo, RemotePath};

#[derive(Default)]
struct Server {
    files: BTreeMap<Vec<String>, Vec<u8>>,
    dirs: BTreeSet<Vec<String>>,
    events: Vec<(String, Vec<String>)>,
    fault: Option<(String, bool)>,
    truncated: bool,
}
#[derive(Default, Clone)]
struct Fake(Arc<Mutex<Server>>);
impl Fake {
    fn fail_next(&self, method: &str, after: bool) {
        self.0.lock().unwrap().fault = Some((method.into(), after));
    }
    fn act<T>(
        &self,
        method: &str,
        path: &RemotePath,
        c: &CancellationToken,
        operation: impl FnOnce(&mut Server) -> Result<T>,
    ) -> Result<T> {
        if c.is_cancelled() {
            return Err(fail("CANCELLED"));
        }
        let mut s = self.0.lock().unwrap();
        s.events.push((method.into(), path.segments().to_vec()));
        let trip = s.fault.as_ref().is_some_and(|(m, _)| m == method);
        let after = s.fault.as_ref().is_some_and(|(_, a)| *a);
        if trip {
            s.fault = None;
            if !after {
                return Err(fail("NETWORK_UNKNOWN"));
            }
        }
        let result = operation(&mut s)?;
        if trip {
            return Err(fail("NETWORK_UNKNOWN"));
        }
        Ok(result)
    }
    fn put_raw(&self, p: &RemotePath, bytes: Vec<u8>) {
        self.0
            .lock()
            .unwrap()
            .files
            .insert(p.segments().to_vec(), bytes);
    }
    fn count(&self, method: &str) -> usize {
        self.0
            .lock()
            .unwrap()
            .events
            .iter()
            .filter(|(m, _)| m == method)
            .count()
    }
}
impl Remote for Fake {
    async fn list(&self, p: &RemotePath, c: &CancellationToken) -> Result<Listing> {
        self.act("LIST", p, c, |s| {
            let mut entries = Vec::new();
            for d in &s.dirs {
                if d.len() == p.segments().len() + 1 && d.starts_with(p.segments()) {
                    entries.push(Entry {
                        path: RemotePath::new(&d.iter().map(String::as_str).collect::<Vec<_>>())?,
                        collection: true,
                        size: None,
                        etag: None,
                    });
                }
            }
            for (path, bytes) in &s.files {
                if path.len() == p.segments().len() + 1 && path.starts_with(p.segments()) {
                    entries.push(Entry {
                        path: RemotePath::new(
                            &path.iter().map(String::as_str).collect::<Vec<_>>(),
                        )?,
                        collection: false,
                        size: Some(bytes.len() as u64),
                        etag: None,
                    });
                }
            }
            Ok(Listing {
                entries,
                completeness: if s.truncated {
                    Completeness::PossiblyTruncated
                } else {
                    Completeness::Complete
                },
            })
        })
    }
    async fn head(&self, p: &RemotePath, c: &CancellationToken) -> Result<Option<ObjectInfo>> {
        self.act("HEAD", p, c, |s| {
            Ok(s.files.get(p.segments()).map(|b| ObjectInfo {
                size: Some(b.len() as u64),
                etag: None,
            }))
        })
    }
    async fn read(&self, p: &RemotePath, c: &CancellationToken) -> Result<Option<Vec<u8>>> {
        self.act("GET_META", p, c, |s| {
            let value = s.files.get(p.segments()).cloned();
            if value.as_ref().is_some_and(|b| b.len() > META_LIMIT) {
                return Err(fail("INVALID_METADATA"));
            }
            Ok(value)
        })
    }
    async fn mkdir(&self, p: &RemotePath, c: &CancellationToken) -> Result<()> {
        self.act("MKCOL", p, c, |s| {
            s.dirs.insert(p.segments().to_vec());
            Ok(())
        })
    }
    async fn put(
        &self,
        p: &RemotePath,
        path: &std::path::Path,
        c: &CancellationToken,
    ) -> Result<()> {
        let bytes = fs::read(path)?;
        self.act("PUT_PACKAGE", p, c, |s| {
            if s.files.contains_key(p.segments()) {
                return Err(fail("REMOTE_CONFLICT"));
            }
            s.files.insert(p.segments().to_vec(), bytes);
            Ok(())
        })
    }
    async fn put_meta(&self, p: &RemotePath, bytes: Vec<u8>, c: &CancellationToken) -> Result<()> {
        self.act("PUT_META", p, c, |s| {
            if s.files.contains_key(p.segments()) {
                return Err(fail("REMOTE_CONFLICT"));
            }
            s.files.insert(p.segments().to_vec(), bytes);
            Ok(())
        })
    }
    async fn move_new(&self, f: &RemotePath, t: &RemotePath, c: &CancellationToken) -> Result<()> {
        self.act("MOVE", t, c, |s| {
            if s.files.contains_key(t.segments()) {
                return Err(fail("REMOTE_CONFLICT"));
            }
            let bytes = s
                .files
                .remove(f.segments())
                .ok_or_else(|| fail("NOT_FOUND"))?;
            s.files.insert(t.segments().to_vec(), bytes);
            Ok(())
        })
    }
    async fn delete(&self, p: &RemotePath, c: &CancellationToken) -> Result<()> {
        self.act("DELETE", p, c, |s| {
            s.files.remove(p.segments());
            Ok(())
        })
    }
    async fn download(
        &self,
        p: &RemotePath,
        t: &std::path::Path,
        max: u64,
        c: &CancellationToken,
    ) -> Result<String> {
        self.act("DOWNLOAD", p, c, |s| {
            let bytes = s.files.get(p.segments()).ok_or_else(|| fail("NOT_FOUND"))?;
            if bytes.len() as u64 > max {
                return Err(fail("TOO_LARGE"));
            }
            fs::write(t, bytes)?;
            Ok(local::hash(t, c)?.1)
        })
    }
}
struct Layout {
    _dir: tempfile::TempDir,
    paths: RestorePaths,
    store: Arc<Mutex<Option<ArchiveStore>>>,
    service: Arc<Service>,
}
fn layout() -> Layout {
    let dir = tempfile::tempdir().unwrap();
    let paths = RestorePaths {
        data_root: dir.path().to_owned(),
        archive_dir: dir.path().join("archive"),
        current_pointer: dir.path().join("current.json"),
        archives_retired_dir: dir.path().join("archives-retired"),
        settings_file: dir.path().join("settings.json"),
    };
    let store = Arc::new(Mutex::new(Some(
        crate::commands::open_store(&paths.archive_dir, &paths.current_pointer).unwrap(),
    )));
    let workspace = PreparedWorkspace::prepare(dir.path()).unwrap();
    let service = Service::open(paths.clone(), store.clone(), workspace).unwrap();
    Layout {
        _dir: dir,
        paths,
        store,
        service,
    }
}
fn options() -> Options {
    serde_json::from_value(serde_json::json!({"encrypted":false,"keepLast":null})).unwrap()
}
fn candidate(l: &Layout, move_verified: bool, keep: Option<usize>) -> (Job, Lease) {
    let mut o = options();
    o.keep_last = keep;
    let (_, lease) = l.service.begin(o, "synthetic-scope".into()).unwrap();
    l.service.prepare(&lease.cancel, None).unwrap();
    l.service
        .update(|s| s.job.as_mut().unwrap().move_verified = move_verified)
        .unwrap();
    (l.service.job().unwrap(), lease)
}
fn reopened(l: &Layout) -> Arc<Service> {
    Service::open(
        l.paths.clone(),
        l.store.clone(),
        PreparedWorkspace::prepare(&l.paths.data_root).unwrap(),
    )
    .unwrap()
}

#[test]
fn defaults_and_metadata_are_strict_private_and_directory_bound() {
    let o: Options = serde_json::from_str("{}").unwrap();
    assert!(o.encrypted);
    assert_eq!(o.keep_last, Some(5));
    let l = layout();
    let (job, _lease) = candidate(&l, false, None);
    let raw = serde_json::to_vec(&job.metadata).unwrap();
    assert_eq!(Metadata::parse(&raw).unwrap(), job.metadata);
    for forbidden in [
        "entries",
        "counts",
        "company",
        "password",
        "passphrase",
        "endpoint",
        "username",
    ] {
        assert!(!String::from_utf8_lossy(&raw).contains(forbidden));
        assert!(!fs::read_to_string(l.service.root.join("state.json"))
            .unwrap()
            .contains(forbidden));
    }
    let mut v = serde_json::to_value(&job.metadata).unwrap();
    for (key, value) in [
        ("package", serde_json::json!("../foreign")),
        ("format", serde_json::json!("another-program")),
        ("counts", serde_json::json!({})),
    ] {
        let old = v.clone();
        v[key] = value;
        assert!(Metadata::parse(&serde_json::to_vec(&v).unwrap()).is_err());
        v = old;
    }
}

#[tokio::test]
async fn plain_roundtrip_publishes_metadata_last_and_only_verified_download_is_exposed() {
    let l = layout();
    let remote = Fake::default();
    let (job, lease) = candidate(&l, false, None);
    l.service.publish(&remote, &lease.cancel).await.unwrap();
    assert_eq!(l.service.job().unwrap().phase, Phase::Succeeded);
    assert!(l
        .service
        .status()
        .unwrap()
        .latest_package
        .unwrap()
        .ends_with("local.rpbak"));
    let events = remote.0.lock().unwrap().events.clone();
    let package = events.iter().position(|(m, _)| m == "PUT_PACKAGE").unwrap();
    let meta = events.iter().position(|(m, _)| m == "PUT_META").unwrap();
    assert!(package < meta);
    drop(lease);
    let catalog = l
        .service
        .list(
            &remote,
            &job.options,
            &job.metadata.archive_id,
            &job.metadata.device_id,
        )
        .await
        .unwrap();
    assert_eq!(catalog.entries, vec![job.metadata.clone()]);
    assert!(!catalog.content_hash_verified);
    assert_eq!(
        remote.count("DOWNLOAD"),
        0,
        "listing must never fetch large package bodies"
    );
    let path = l
        .service
        .download(&remote, &job.options, job.metadata.clone(), None)
        .await
        .unwrap();
    assert!(backup::read_manifest(std::path::Path::new(&path)).is_ok());
    let repeated = l
        .service
        .download(&remote, &job.options, job.metadata.clone(), None)
        .await
        .unwrap();
    assert_eq!(
        repeated, path,
        "a second successful download atomically replaces the verified output"
    );
    // A corrupt remote body cannot replace the previous verified download.
    let before = fs::read(&path).unwrap();
    remote.put_raw(
        &job.metadata
            .folder(&RemotePath::root())
            .unwrap()
            .child(&job.metadata.package)
            .unwrap(),
        b"bad bytes".to_vec(),
    );
    assert!(l
        .service
        .download(&remote, &job.options, job.metadata, None)
        .await
        .is_err());
    assert_eq!(fs::read(path).unwrap(), before);
}

#[tokio::test]
async fn lost_responses_and_process_restart_reconcile_without_duplicate_or_overwriting() {
    for use_move in [false, true] {
        let methods = if use_move {
            vec!["PUT_PACKAGE", "MOVE", "PUT_META"]
        } else {
            vec!["PUT_PACKAGE", "PUT_META"]
        };
        for method in methods {
            for after in [false, true] {
                let l = layout();
                let remote = Fake::default();
                let (job, lease) = candidate(&l, use_move, None);
                remote.fail_next(method, after);
                let result = l.service.publish(&remote, &lease.cancel).await;
                assert!(result.is_err(), "{method} {after}");
                l.service.finish(result, &lease.cancel);
                assert!(l.service.status().unwrap().latest_package.is_none());
                assert!(l.service.status().unwrap().retry_package.is_some());
                drop(lease);
                let service = reopened(&l);
                let (retry, lease) = service.retry("synthetic-scope", &job.options).unwrap();
                assert_eq!(retry.id, job.id);
                service.publish(&remote, &lease.cancel).await.unwrap();
                assert!(service.job().unwrap().published);
                let files = &remote.0.lock().unwrap().files;
                assert_eq!(files.len(), 2, "{method} {after}: no duplicate names/parts");
                assert_eq!(
                    files
                        .values()
                        .filter(|v| Metadata::parse(v).is_ok())
                        .count(),
                    1
                );
            }
        }
    }
}

#[tokio::test]
async fn missing_or_partial_metadata_is_not_a_success_and_unknown_foreign_objects_are_never_overwritten(
) {
    let l = layout();
    let remote = Fake::default();
    let (job, lease) = candidate(&l, false, None);
    let folder = job.metadata.folder(&RemotePath::root()).unwrap();
    remote::mkdirs(&remote, &folder, &lease.cancel)
        .await
        .unwrap();
    remote.put_raw(
        &folder.child(&job.metadata.package).unwrap(),
        b"other user file".to_vec(),
    );
    assert_eq!(
        l.service
            .publish(&remote, &lease.cancel)
            .await
            .unwrap_err()
            .code,
        "CLOUD_REMOTE_CONFLICT"
    );
    assert_eq!(remote.count("PUT_PACKAGE"), 0);
    assert_eq!(remote.count("DELETE"), 0);
    let listing = remote::catalog(
        &remote,
        &RemotePath::root(),
        &job.metadata.archive_id,
        &job.metadata.device_id,
        &lease.cancel,
    )
    .await
    .unwrap();
    assert!(listing.entries.is_empty());
    assert!(!listing.cleanup_safe);
    remote.put_raw(
        &folder.child(&job.metadata.meta_name().unwrap()).unwrap(),
        b"{\"formatVersion\":".to_vec(),
    );
    let listing = remote::catalog(
        &remote,
        &RemotePath::root(),
        &job.metadata.archive_id,
        &job.metadata.device_id,
        &lease.cancel,
    )
    .await
    .unwrap();
    assert!(listing.entries.is_empty());
    assert!(!listing.cleanup_safe);
}

#[tokio::test]
async fn cancellation_keeps_one_candidate_and_protects_latest_and_other_devices() {
    let l = layout();
    let remote = Fake::default();
    let (first, lease) = candidate(&l, false, None);
    l.service.publish(&remote, &lease.cancel).await.unwrap();
    drop(lease);
    let latest = l.service.status().unwrap().latest_package.unwrap();
    let before = fs::read(&latest).unwrap();
    let (second, lease) = candidate(&l, false, Some(5));
    lease.cancel.cancel();
    let result = l.service.publish(&remote, &lease.cancel).await;
    assert!(result.is_err());
    l.service.finish(result, &lease.cancel);
    drop(lease);
    assert_eq!(fs::read(latest).unwrap(), before);
    assert_eq!(l.service.job().unwrap().phase, Phase::Cancelled);
    assert!(l
        .service
        .begin(options(), "synthetic-scope".into())
        .is_err());
    assert!(l
        .service
        .retry("different-account", &second.options)
        .is_err());
    let other_device = uuid::Uuid::new_v4().to_string();
    assert_ne!(first.metadata.device_id, other_device);
    l.service.discard().unwrap();
    assert!(!l.service.root.join(second.id).exists());
    assert!(l.service.status().unwrap().latest_package.is_some());
    assert_eq!(remote.count("DELETE"), 0);
}

fn old_owned(
    l: &Layout,
    remote: &Fake,
    job: &Job,
    created: &str,
    device: Option<String>,
    receipt: bool,
) -> Metadata {
    let mut m = job.metadata.clone();
    m.backup_id = uuid::Uuid::new_v4().to_string();
    m.created_at = created.into();
    if let Some(device) = device {
        m.device_id = device;
    }
    m.package = m.package_name().unwrap();
    let folder = m.folder(&RemotePath::root()).unwrap();
    {
        let mut s = remote.0.lock().unwrap();
        for len in 1..=folder.segments().len() {
            s.dirs.insert(folder.segments()[..len].to_vec());
        }
    }
    remote.put_raw(
        &folder.child(&m.package).unwrap(),
        fs::read(local::payload(&l.service.root, &job.id)).unwrap(),
    );
    remote.put_raw(
        &folder.child(&m.meta_name().unwrap()).unwrap(),
        serde_json::to_vec(&m).unwrap(),
    );
    if receipt {
        l.service
            .update(|s| {
                s.receipts.push(Receipt {
                    scope: job.scope.clone(),
                    root: job.options.root.clone(),
                    metadata: m.clone(),
                    deleting: false,
                    orphan: false,
                    part_intent: false,
                    package_intent: true,
                    touched_at: created.into(),
                })
            })
            .unwrap();
    }
    m
}

#[tokio::test]
async fn retention_is_across_months_and_metadata_is_removed_before_body_other_device_is_untouched()
{
    let l = layout();
    let remote = Fake::default();
    let (job, lease) = candidate(&l, false, Some(2));
    let oldest = old_owned(&l, &remote, &job, "2026-07-01T00:00:00Z", None, true);
    let second = old_owned(&l, &remote, &job, "2026-08-01T00:00:00Z", None, true);
    let recent = old_owned(&l, &remote, &job, "2026-09-01T00:00:00Z", None, true);
    let other = old_owned(
        &l,
        &remote,
        &job,
        "2026-06-01T00:00:00Z",
        Some(uuid::Uuid::new_v4().to_string()),
        false,
    );
    l.service.publish(&remote, &lease.cancel).await.unwrap();
    let s = remote.0.lock().unwrap();
    for m in [oldest, second] {
        let p = m.folder(&RemotePath::root()).unwrap();
        let meta = p.child(&m.meta_name().unwrap()).unwrap();
        let package = p.child(&m.package).unwrap();
        assert!(!s.files.contains_key(meta.segments()));
        assert!(!s.files.contains_key(package.segments()));
        let a = s
            .events
            .iter()
            .position(|(op, path)| op == "DELETE" && path == meta.segments())
            .unwrap();
        let b = s
            .events
            .iter()
            .position(|(op, path)| op == "DELETE" && path == package.segments())
            .unwrap();
        assert!(a < b);
    }
    for m in [recent, other, job.metadata] {
        assert!(s.files.contains_key(
            m.folder(&RemotePath::root())
                .unwrap()
                .child(&m.package)
                .unwrap()
                .segments()
        ));
    }
}

#[tokio::test]
async fn ambiguous_ownership_malformed_user_files_and_truncated_lists_disable_all_retention() {
    for case in 0..4 {
        let l = layout();
        let remote = Fake::default();
        let (job, lease) = candidate(&l, false, Some(1));
        let old = old_owned(&l, &remote, &job, "2026-07-01T00:00:00Z", None, case != 0);
        if case == 1 {
            remote.0.lock().unwrap().truncated = true;
        }
        if case == 2 {
            remote.put_raw(
                &old.folder(&RemotePath::root())
                    .unwrap()
                    .child("my-notes.txt")
                    .unwrap(),
                b"user data".to_vec(),
            );
        }
        if case == 3 {
            remote.put_raw(
                &old.folder(&RemotePath::root())
                    .unwrap()
                    .child("fake.meta.json")
                    .unwrap(),
                b"{}".to_vec(),
            );
        }
        l.service.publish(&remote, &lease.cancel).await.unwrap();
        assert_eq!(l.service.job().unwrap().phase, Phase::CleanupWarning);
        assert_eq!(remote.count("DELETE"), 0, "case {case}");
    }
}

#[tokio::test]
async fn failed_upload_never_prunes_and_lost_delete_response_is_only_a_cleanup_warning() {
    let l = layout();
    let remote = Fake::default();
    let (job, lease) = candidate(&l, false, Some(1));
    let old = old_owned(&l, &remote, &job, "2026-07-01T00:00:00Z", None, true);
    remote.fail_next("PUT_PACKAGE", false);
    assert!(l.service.publish(&remote, &lease.cancel).await.is_err());
    assert_eq!(remote.count("DELETE"), 0);
    remote.fail_next("DELETE", true);
    l.service.publish(&remote, &lease.cancel).await.unwrap();
    assert_eq!(l.service.job().unwrap().phase, Phase::CleanupWarning);
    assert!(l.service.job().unwrap().published);
    // Lost metadata DELETE response must not delete the still-recoverable body.
    assert!(remote.0.lock().unwrap().files.contains_key(
        old.folder(&RemotePath::root())
            .unwrap()
            .child(&old.package)
            .unwrap()
            .segments()
    ));
    assert!(l.service.status().unwrap().latest_package.is_some());
}

#[test]
fn oversized_candidate_never_reaches_network_and_pending_package_survives_restart_cleanup() {
    let l = layout();
    let mut o = options();
    o.max_upload_bytes = 1;
    let (_, lease) = l.service.begin(o, "scope".into()).unwrap();
    assert_eq!(
        l.service.prepare(&lease.cancel, None).unwrap_err().code,
        "CLOUD_TOO_LARGE"
    );
    drop(lease);
    l.service.discard().unwrap();
    let (job, lease) = candidate(&l, false, None);
    drop(lease);
    let service = reopened(&l);
    assert!(local::payload(&service.root, &job.id).is_file());
    assert_eq!(service.job().unwrap().phase, Phase::Interrupted);
    assert!(service.status().unwrap().retry_package.is_some());
}

#[test]
fn preparation_releases_store_before_encryption_and_candidate_ids_are_machine_local() {
    let a = layout();
    let b = layout();
    assert_ne!(
        a.service.journal.lock().unwrap().device_id,
        b.service.journal.lock().unwrap().device_id
    );
    let (job, _lease) = candidate(&a, false, None);
    assert!(a.store.try_lock().is_ok());
    let bytes = fs::read(a.service.root.join(&job.id).join("local.rpbak")).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains(&job.metadata.device_id));
    assert!(
        a.service.reserve().is_err(),
        "only one job/list/download/cleanup at once"
    );
}

#[tokio::test]
async fn encrypted_roundtrip_uses_age_authentication_and_inner_package_validation() {
    let l = layout();
    let remote = Fake::default();
    let mut o = options();
    o.encrypted = true;
    let (_, lease) = l.service.begin(o, "synthetic-scope".into()).unwrap();
    let secret = "  synthetic cloud password that must never be journaled  ";
    l.service
        .prepare(&lease.cancel, Some(SecretString::from(secret.to_owned())))
        .unwrap();
    let job = l.service.job().unwrap();
    assert!(!fs::read_to_string(l.service.root.join("state.json"))
        .unwrap()
        .contains(secret));
    l.service.publish(&remote, &lease.cancel).await.unwrap();
    drop(lease);
    assert!(l
        .service
        .download(
            &remote,
            &job.options,
            job.metadata.clone(),
            Some(SecretString::from("wrong".to_owned()))
        )
        .await
        .is_err());
    assert!(!l.service.root.join("verified-download.rpbak").exists());
    let path = l
        .service
        .download(
            &remote,
            &job.options,
            job.metadata,
            Some(SecretString::from(secret.to_owned())),
        )
        .await
        .unwrap();
    assert!(backup::read_manifest(std::path::Path::new(&path)).is_ok());
}

#[tokio::test]
async fn two_devices_share_an_archive_without_sharing_ids_or_deletion_authority() {
    let a = layout();
    let b = layout();
    let remote = Fake::default();
    let (a_job, a_lease) = candidate(&a, false, Some(1));
    // A restored archive keeps archiveId but uses the receiving machine's ID.
    b.store.lock().unwrap().take().unwrap().close().unwrap();
    let package = a.service.root.join(&a_job.id).join("local.rpbak");
    let (report, store) =
        crate::restore::restore_archive_open(&b.paths, &package, &now(), || Ok(())).unwrap();
    *b.store.lock().unwrap() = Some(store);
    assert!(std::path::Path::new(&report.archive_dir).is_dir());
    let (b_job, b_lease) = candidate(&b, false, Some(1));
    assert_eq!(a_job.metadata.archive_id, b_job.metadata.archive_id);
    assert_ne!(a_job.metadata.device_id, b_job.metadata.device_id);
    let (a_result, b_result) = tokio::join!(
        a.service.publish(&remote, &a_lease.cancel),
        b.service.publish(&remote, &b_lease.cancel)
    );
    a_result.unwrap();
    b_result.unwrap();
    assert_eq!(remote.0.lock().unwrap().files.len(), 4);
    assert_eq!(remote.count("DELETE"), 0);
    assert_eq!(remote.count("PUT_PACKAGE"), 2);
}

#[tokio::test]
async fn owned_orphans_require_grace_and_hash_while_unowned_parts_are_never_deleted() {
    for expired in [false, true] {
        let l = layout();
        let remote = Fake::default();
        let (job, lease) = candidate(&l, false, Some(5));
        let orphan = old_owned(&l, &remote, &job, "2026-07-01T00:00:00Z", None, true);
        let folder = orphan.folder(&RemotePath::root()).unwrap();
        remote.0.lock().unwrap().files.remove(
            folder
                .child(&orphan.meta_name().unwrap())
                .unwrap()
                .segments(),
        );
        let part = folder.child(&format!("{}.part", orphan.package)).unwrap();
        remote.put_raw(
            &part,
            fs::read(local::payload(&l.service.root, &job.id)).unwrap(),
        );
        l.service
            .update(|s| {
                let r = s
                    .receipts
                    .iter_mut()
                    .find(|r| r.metadata.backup_id == orphan.backup_id)
                    .unwrap();
                r.orphan = true;
                r.part_intent = true;
                r.touched_at = if expired {
                    "2026-07-01T00:00:00Z".into()
                } else {
                    now()
                };
            })
            .unwrap();
        l.service.publish(&remote, &lease.cancel).await.unwrap();
        let s = remote.0.lock().unwrap();
        assert_eq!(s.files.contains_key(part.segments()), !expired);
        assert_eq!(
            s.files
                .contains_key(folder.child(&orphan.package).unwrap().segments()),
            !expired
        );
    }
    let l = layout();
    let remote = Fake::default();
    let (job, lease) = candidate(&l, false, Some(1));
    let folder = job.metadata.folder(&RemotePath::root()).unwrap();
    remote::mkdirs(&remote, &folder, &lease.cancel)
        .await
        .unwrap();
    remote.put_raw(
        &folder.child("someone-else.rpbak.part").unwrap(),
        b"keep this".to_vec(),
    );
    l.service.publish(&remote, &lease.cancel).await.unwrap();
    assert_eq!(remote.count("DELETE"), 0);
}

#[test]
fn disk_budget_and_failed_local_cleanup_block_unbounded_new_candidates() {
    let l = layout();
    assert_eq!(
        local::space(&l.service.root, u64::MAX).unwrap_err().code,
        "CLOUD_INSUFFICIENT_DISK_SPACE"
    );
    let id = uuid::Uuid::new_v4().to_string();
    // A file, link or unreadable directory cannot be recursively removed.
    fs::write(l.service.root.join(&id), b"unexpected file").unwrap();
    l.service
        .update(|s| s.local_garbage.push(id.clone()))
        .unwrap();
    assert!(l.service.begin(options(), "scope".into()).is_err());
    assert!(fs::read(l.service.root.join(id)).is_ok());
}

fn paths_at(root: &std::path::Path) -> RestorePaths {
    RestorePaths {
        data_root: root.to_owned(),
        archive_dir: root.join("archive"),
        current_pointer: root.join("current.json"),
        archives_retired_dir: root.join("archives-retired"),
        settings_file: root.join("settings.json"),
    }
}

#[test]
fn process_exit_child() {
    let Some(root) = std::env::var_os("RESUME_PRO_CLOUD_TEST_CRASH_ROOT") else {
        return;
    };
    let paths = paths_at(std::path::Path::new(&root));
    let store = Arc::new(Mutex::new(Some(
        crate::commands::open_store(&paths.archive_dir, &paths.current_pointer).unwrap(),
    )));
    let service = Service::open(
        paths.clone(),
        store,
        PreparedWorkspace::prepare(&paths.data_root).unwrap(),
    )
    .unwrap();
    let (_, lease) = service.begin(options(), "scope".into()).unwrap();
    service.prepare(&lease.cancel, None).unwrap();
    service
        .update(|s| s.job.as_mut().unwrap().package_intent = true)
        .unwrap();
    // Deliberately bypass all RAII destructors, as a killed process would.
    std::process::exit(17);
}

#[test]
fn actual_process_exit_keeps_the_complete_candidate_and_restart_does_not_rotate_its_id() {
    let dir = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg("cloud_backup::tests::process_exit_child")
        .env("RESUME_PRO_CLOUD_TEST_CRASH_ROOT", dir.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(17));
    let paths = paths_at(dir.path());
    let saved = local::load(&dir.path().join("cloud-backup-state/state.json")).unwrap();
    let id = saved.job.as_ref().unwrap().id.clone();
    let store = Arc::new(Mutex::new(Some(
        crate::commands::open_current_store(&paths.archive_dir, &paths.current_pointer).unwrap(),
    )));
    let service = Service::open(
        paths,
        store,
        PreparedWorkspace::prepare(dir.path()).unwrap(),
    )
    .unwrap();
    assert_eq!(service.job().unwrap().id, id);
    assert_eq!(service.job().unwrap().phase, Phase::Interrupted);
    assert!(service.status().unwrap().retry_package.is_some());
    let (job, _lease) = service.retry("scope", &options()).unwrap();
    assert_eq!(job.id, id);
}

#[test]
fn journal_write_failure_still_reports_failure_instead_of_a_permanently_running_job() {
    let l = layout();
    let (_, lease) = candidate(&l, false, None);
    let state = l.service.root.join("state.json");
    fs::remove_file(&state).unwrap();
    fs::create_dir(&state).unwrap();
    l.service.finish(Err(fail("LOCAL_IO")), &lease.cancel);
    let job = l.service.status().unwrap().job.unwrap();
    assert_eq!(job.phase, Phase::Failed);
    assert_eq!(job.error_code.as_deref(), Some("CLOUD_LOCAL_IO"));
    assert!(job.warnings.iter().any(|w| w == "JOURNAL_WRITE_FAILED"));
    assert!(l.service.status().unwrap().retry_package.is_some());
}

#[test]
fn json_wire_shapes_match_the_typescript_cloud_contract() {
    assert_eq!(
        serde_json::to_value(Encryption::AgeV1Scrypt).unwrap(),
        "ageV1Scrypt"
    );
    assert_eq!(
        serde_json::to_value(Phase::CleanupWarning).unwrap(),
        "cleanupWarning"
    );
    let l = layout();
    let (job, _lease) = candidate(&l, false, None);
    let value = serde_json::to_value(l.service.status().unwrap()).unwrap();
    assert_eq!(value["deviceId"], job.metadata.device_id);
    assert_eq!(value["job"]["candidateReady"], true);
    assert!(value.get("retryPackage").is_some());
    assert_eq!(
        serde_json::to_value(job.metadata).unwrap()["formatVersion"],
        1
    );
}

#[test]
fn retry_can_change_retention_and_limits_without_rotating_or_reencrypting_the_candidate() {
    let l = layout();
    let (job, lease) = candidate(&l, true, Some(5));
    let original = fs::read(local::payload(&l.service.root, &job.id)).unwrap();
    drop(lease);
    let mut changed = job.options.clone();
    changed.keep_last = None;
    changed.max_upload_bytes = job.metadata.size_bytes;
    changed.prefer_move = false;
    let (retried, lease) = l.service.retry("synthetic-scope", &changed).unwrap();
    assert_eq!(retried.id, job.id);
    assert_eq!(retried.metadata, job.metadata);
    assert_eq!(retried.options.keep_last, None);
    assert!(!retried.move_verified);
    assert_eq!(
        fs::read(local::payload(&l.service.root, &job.id)).unwrap(),
        original
    );
    drop(lease);
    changed.max_upload_bytes = job.metadata.size_bytes - 1;
    assert_eq!(
        l.service
            .retry("synthetic-scope", &changed)
            .err()
            .unwrap()
            .code,
        "CLOUD_TOO_LARGE"
    );
    changed.max_upload_bytes = job.metadata.size_bytes;
    changed.root.push("another-root".into());
    assert_eq!(
        l.service
            .retry("synthetic-scope", &changed)
            .err()
            .unwrap()
            .code,
        "CLOUD_SCOPE_MISMATCH"
    );
    changed.root.clear();
    changed.encrypted = true;
    assert_eq!(
        l.service
            .retry("synthetic-scope", &changed)
            .err()
            .unwrap()
            .code,
        "CLOUD_SCOPE_MISMATCH"
    );
    changed.encrypted = false;
    l.service
        .update(|s| {
            let j = s.job.as_mut().unwrap();
            j.part_intent = true;
            j.move_verified = true;
        })
        .unwrap();
    let (retried, _lease) = l.service.retry("synthetic-scope", &changed).unwrap();
    assert!(
        retried.move_verified,
        "an in-progress MOVE strategy must remain fixed"
    );
}

#[test]
fn bounded_plaintext_copy_fallback_preserves_existing_outputs_and_cleans_partial_files() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("input");
    let target = dir.path().join("output");
    fs::write(&source, vec![7; 200_000]).unwrap();
    let cancel = CancellationToken::new();
    local::copy_new(&source, &target, 200_000, &cancel).unwrap();
    assert_eq!(fs::read(&target).unwrap(), fs::read(&source).unwrap());
    fs::write(&source, b"replacement").unwrap();
    assert!(local::copy_new(&source, &target, 200_000, &cancel).is_err());
    assert_eq!(fs::metadata(&target).unwrap().len(), 200_000);
    fs::remove_file(&target).unwrap();
    assert_eq!(
        local::copy_new(&source, &target, 1, &cancel)
            .unwrap_err()
            .code,
        "CLOUD_TOO_LARGE"
    );
    cancel.cancel();
    assert_eq!(
        local::copy_new(&source, &target, 200_000, &cancel)
            .unwrap_err()
            .code,
        "CLOUD_CANCELLED"
    );
    assert!(!target.exists());
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn invalid_receipt_time_stops_cleanup_with_a_warning_instead_of_panicking() {
    let l = layout();
    let remote = Fake::default();
    let (job, lease) = candidate(&l, false, Some(1));
    let old = old_owned(&l, &remote, &job, "2026-07-01T00:00:00Z", None, true);
    l.service
        .update(|s| {
            let r = s
                .receipts
                .iter_mut()
                .find(|r| r.metadata.backup_id == old.backup_id)
                .unwrap();
            r.orphan = true;
            r.touched_at = "invalid date".into();
        })
        .unwrap();
    l.service.publish(&remote, &lease.cancel).await.unwrap();
    assert_eq!(remote.count("DELETE"), 0);
    assert!(l.service.job().unwrap().published);
    assert_eq!(l.service.job().unwrap().phase, Phase::CleanupWarning);
    assert!(l
        .service
        .job()
        .unwrap()
        .warnings
        .iter()
        .any(|w| w == "CLOUD_INVALID_DATE"));
}

#[test]
fn startup_cleanup_matches_actual_tempfile_names_and_preserves_unrelated_entries() {
    let root = tempfile::tempdir().unwrap();
    let unrelated = root.path().join(".state-keep-this");
    fs::write(&unrelated, b"keep").unwrap();
    let directory = root.path().join(format!(".state-{}", "a".repeat(32)));
    fs::create_dir(&directory).unwrap();
    let mut abandoned = Vec::new();
    for prefix in [".state-", ".verified-"] {
        let temporary = tempfile::Builder::new()
            .prefix(prefix)
            .rand_bytes(32)
            .tempfile_in(root.path())
            .unwrap();
        let (file, path) = temporary.keep().unwrap();
        drop(file);
        assert_eq!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .strip_prefix(prefix)
                .unwrap()
                .len(),
            32
        );
        abandoned.push(path);
    }
    local::cleanup_temporaries(root.path()).unwrap();
    for path in abandoned {
        assert!(!path.exists());
    }
    assert!(unrelated.is_file());
    assert!(directory.is_dir());
}
