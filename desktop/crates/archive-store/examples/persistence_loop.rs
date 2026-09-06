use archive_store::*;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let root = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| temp.path().to_path_buf());
    if !root.is_absolute() {
        return Err("demo directory must be absolute".into());
    }
    let cfg = ArchiveConfig::new(root.join("archive"), root.join("current.json"));
    let db = ArchiveStore::open(cfg.clone())?;
    let before = db
        .list_applications(&ApplicationFilter {
            limit: 100,
            ..Default::default()
        })?
        .total;
    let application = db.create_application(NewApplication {
        company: "合成示例公司".into(),
        title: "研发工程师".into(),
        source_url: None,
        location: None,
        notes: None,
        origin: ApplicationOrigin::Manual,
        occurred_at: Occurred::Unknown,
    })?;
    db.append_event(
        Some(&application.id),
        EventDraft::new(
            EventPayload::SubmitConfirmed {
                via: "desktop".into(),
                note: None,
                stage_update_mode: StageUpdateMode::UpdateProgress,
            },
            Occurred::Unknown,
            EventSource::Manual,
            Actor::User,
        ),
    )?;
    db.close()?;
    let reopened = ArchiveStore::open(cfg)?;
    let saved = reopened
        .get_application(&application.id)?
        .ok_or("application missing after reopen")?;
    let events = reopened.list_events(&application.id)?;
    assert_eq!(saved.current_stage, Stage::Submitted);
    assert_eq!(events.len(), 2);
    println!(
        "{}",
        serde_json::json!({"reopened":true,"existingApplications":before,
        "applicationId":saved.id,"stage":saved.current_stage,"events":events.len(),
        "totalApplications":reopened.list_applications(&ApplicationFilter{limit:100,..Default::default()})?.total})
    );
    reopened.close()?;
    Ok(())
}
