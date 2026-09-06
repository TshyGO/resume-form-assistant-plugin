//! Bounded application-manager commands. The WebView never sees SQL or paths.

use archive_store::{
    timeutil::now_utc, Actor, ApplicationDetail, ApplicationFilter, ApplicationOrigin,
    ApplicationSummary, ArchiveConfig, ArchiveStore, Candidates, EventDraft, EventPayload,
    EventSource, ListSort, NewApplication, Occurred, RecycleState, Stage, StageUpdateMode,
    StoreError, StoredEvent, UpdateApplicationInput,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<StoreError> for CommandError {
    fn from(err: StoreError) -> Self {
        let code = match &err {
            StoreError::Validation(_) => "VALIDATION",
            StoreError::NotFound(_) => "NOT_FOUND",
            StoreError::Conflict(_) => "CONFLICT",
            StoreError::PathInvalid(_) | StoreError::NotWritable(_) => "STORE_OPEN_FAILED",
            _ => "STORE_ERROR",
        };
        Self {
            code: code.into(),
            message: err.to_string(),
        }
    }
}

pub fn open_store(
    archive_dir: &std::path::Path,
    current_pointer: &std::path::Path,
) -> Result<ArchiveStore, CommandError> {
    ArchiveStore::open(ArchiveConfig::new(archive_dir, current_pointer)).map_err(CommandError::from)
}

fn occurred_now() -> Occurred {
    Occurred::DateTime {
        rfc3339: now_utc(),
        time_zone: None,
    }
}

fn stage_mode(update_progress: bool) -> StageUpdateMode {
    if update_progress {
        StageUpdateMode::UpdateProgress
    } else {
        StageUpdateMode::HistoryOnly
    }
}

fn parse_stage(value: &str) -> Result<Stage, CommandError> {
    Stage::parse(value).ok_or_else(|| CommandError {
        code: "VALIDATION".into(),
        message: format!("unknown stage `{value}`"),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApplicationArgs {
    pub company: String,
    pub title: String,
    pub source_url: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub confirm_duplicate: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApplicationResult {
    pub created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application: Option<ApplicationDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Candidates>,
}

pub fn create_application(
    store: &ArchiveStore,
    args: CreateApplicationArgs,
) -> Result<CreateApplicationResult, CommandError> {
    if args.company.trim().is_empty() || args.title.trim().is_empty() {
        return Err(CommandError {
            code: "VALIDATION".into(),
            message: "公司与岗位为必填".into(),
        });
    }
    let candidates = store.query_candidates(
        args.company.trim(),
        args.title.trim(),
        args.source_url.as_deref(),
    )?;
    if !args.confirm_duplicate
        && (!candidates.exact.is_empty() || !candidates.same_company.is_empty())
    {
        return Ok(CreateApplicationResult {
            created: false,
            application: None,
            candidates: Some(candidates),
        });
    }
    let detail = store.create_application(NewApplication {
        company: args.company,
        title: args.title,
        source_url: args.source_url,
        location: args.location,
        notes: args.notes,
        origin: ApplicationOrigin::Manual,
        occurred_at: occurred_now(),
    })?;
    Ok(CreateApplicationResult {
        created: true,
        application: Some(detail),
        candidates: None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListApplicationsArgs {
    pub query: Option<String>,
    pub stage: Option<String>,
    /// `active` (default), `recycled`, `all`
    pub recycle: Option<String>,
    /// `updatedAt` | `company` | `title` | `stage`
    pub sort: Option<String>,
    pub desc: Option<bool>,
    pub limit: Option<u32>,
    pub offset: Option<u64>,
}

pub fn list_applications(
    store: &ArchiveStore,
    args: ListApplicationsArgs,
) -> Result<archive_store::Page<ApplicationSummary>, CommandError> {
    let mut filter = ApplicationFilter {
        order_updated_desc: args.desc.unwrap_or(true),
        limit: args.limit.unwrap_or(50),
        offset: args.offset.unwrap_or(0),
        query: args.query.filter(|s| !s.trim().is_empty()),
        ..ApplicationFilter::default()
    };
    if let Some(stage) = args.stage.filter(|s| !s.is_empty() && s != "all") {
        filter.stages = vec![parse_stage(&stage)?];
    }
    filter.recycle_state = match args.recycle.as_deref() {
        Some("all") => Some(None),
        Some("recycled") => Some(Some(RecycleState::Recycled)),
        Some("active") | None => None,
        Some(other) => {
            return Err(CommandError {
                code: "VALIDATION".into(),
                message: format!("unknown recycle filter `{other}`"),
            })
        }
    };
    filter.sort = match args.sort.as_deref() {
        Some("company") => ListSort::Company,
        Some("title") => ListSort::Title,
        Some("stage") => ListSort::Stage,
        Some("updatedAt") | None => ListSort::UpdatedAt,
        Some(other) => {
            return Err(CommandError {
                code: "VALIDATION".into(),
                message: format!("unknown sort `{other}`"),
            })
        }
    };
    Ok(store.list_applications(&filter)?)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationView {
    pub application: ApplicationDetail,
    pub events: Vec<StoredEvent>,
}

pub fn get_application(store: &ArchiveStore, id: &str) -> Result<ApplicationView, CommandError> {
    let application = store.get_application(id)?.ok_or_else(|| CommandError {
        code: "NOT_FOUND".into(),
        message: format!("申请不存在: {id}"),
    })?;
    let events = store.list_events(id)?;
    Ok(ApplicationView {
        application,
        events,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApplicationArgs {
    pub id: String,
    pub company: Option<String>,
    pub title: Option<String>,
    pub source_url: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub archived: Option<bool>,
}

fn optional_clear(value: Option<String>) -> Option<Option<String>> {
    value.map(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub fn update_application(
    store: &ArchiveStore,
    args: UpdateApplicationArgs,
) -> Result<ApplicationDetail, CommandError> {
    if args.company.as_ref().is_some_and(|s| s.trim().is_empty())
        || args.title.as_ref().is_some_and(|s| s.trim().is_empty())
    {
        return Err(CommandError {
            code: "VALIDATION".into(),
            message: "公司与岗位不能为空".into(),
        });
    }
    Ok(store.update_application(
        &args.id,
        UpdateApplicationInput {
            company: args.company,
            title: args.title,
            source_url: optional_clear(args.source_url),
            location: optional_clear(args.location),
            notes: optional_clear(args.notes),
            archived: args.archived,
        },
    )?)
}

fn append_progress_event(
    store: &ArchiveStore,
    id: &str,
    occurred: Occurred,
    payload: EventPayload,
) -> Result<ApplicationView, CommandError> {
    occurred.to_columns().map_err(CommandError::from)?;
    store.append_event(
        Some(id),
        EventDraft {
            occurred,
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload,
        },
    )?;
    get_application(store, id)
}

fn append_user_event(
    store: &ArchiveStore,
    id: &str,
    payload: EventPayload,
) -> Result<ApplicationView, CommandError> {
    store.append_event(
        Some(id),
        EventDraft {
            occurred: occurred_now(),
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload,
        },
    )?;
    get_application(store, id)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteArgs {
    pub id: String,
    pub text: String,
}

pub fn add_note(store: &ArchiveStore, args: NoteArgs) -> Result<ApplicationView, CommandError> {
    let text = args.text.trim();
    if text.is_empty() {
        return Err(CommandError {
            code: "VALIDATION".into(),
            message: "备注不能为空".into(),
        });
    }
    append_user_event(
        store,
        &args.id,
        EventPayload::NoteAdded { text: text.into() },
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitArgs {
    pub id: String,
    pub note: Option<String>,
}

pub fn confirm_submit(
    store: &ArchiveStore,
    args: SubmitArgs,
) -> Result<ApplicationView, CommandError> {
    append_user_event(
        store,
        &args.id,
        EventPayload::SubmitConfirmed {
            via: "desktop".into(),
            note: args.note.filter(|s| !s.trim().is_empty()),
            stage_update_mode: StageUpdateMode::UpdateProgress,
        },
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEventArgs {
    #[serde(default)]
    pub occurred: Option<Occurred>,
    pub id: String,
    pub name: Option<String>,
    pub round: Option<i64>,
    pub label: Option<String>,
    pub note: Option<String>,
    pub reason: Option<String>,
    #[serde(default)]
    pub update_progress: bool,
}

pub fn record_assessment(
    store: &ArchiveStore,
    args: ProgressEventArgs,
) -> Result<ApplicationView, CommandError> {
    append_progress_event(
        store,
        &args.id,
        args.occurred.unwrap_or(Occurred::Unknown),
        EventPayload::AssessmentRecorded {
            name: args.name.filter(|s| !s.trim().is_empty()),
            due: None,
            stage_update_mode: stage_mode(args.update_progress),
        },
    )
}

pub fn record_interview(
    store: &ArchiveStore,
    args: ProgressEventArgs,
) -> Result<ApplicationView, CommandError> {
    if args.round.is_some_and(|n| n < 1 || n > 99) {
        return Err(CommandError {
            code: "VALIDATION".into(),
            message: "面试轮次须为 1–99".into(),
        });
    }
    append_progress_event(
        store,
        &args.id,
        args.occurred.unwrap_or(Occurred::Unknown),
        EventPayload::InterviewRecorded {
            round: args.round,
            label: args.label.or(args.name).filter(|s| !s.trim().is_empty()),
            stage_update_mode: stage_mode(args.update_progress),
        },
    )
}

pub fn record_offer(
    store: &ArchiveStore,
    args: ProgressEventArgs,
) -> Result<ApplicationView, CommandError> {
    append_progress_event(
        store,
        &args.id,
        args.occurred.unwrap_or(Occurred::Unknown),
        EventPayload::OfferRecorded {
            note: args.note.filter(|s| !s.trim().is_empty()),
            stage_update_mode: stage_mode(args.update_progress),
        },
    )
}

pub fn record_rejected(
    store: &ArchiveStore,
    args: ProgressEventArgs,
) -> Result<ApplicationView, CommandError> {
    append_progress_event(
        store,
        &args.id,
        args.occurred.unwrap_or(Occurred::Unknown),
        EventPayload::Rejected {
            reason: args.reason.or(args.note).filter(|s| !s.trim().is_empty()),
            stage_update_mode: stage_mode(args.update_progress),
        },
    )
}

pub fn record_withdrawn(
    store: &ArchiveStore,
    args: ProgressEventArgs,
) -> Result<ApplicationView, CommandError> {
    append_progress_event(
        store,
        &args.id,
        args.occurred.unwrap_or(Occurred::Unknown),
        EventPayload::Withdrawn {
            reason: args.reason.or(args.note).filter(|s| !s.trim().is_empty()),
            stage_update_mode: stage_mode(args.update_progress),
        },
    )
}

pub fn record_closed(
    store: &ArchiveStore,
    args: ProgressEventArgs,
) -> Result<ApplicationView, CommandError> {
    append_progress_event(
        store,
        &args.id,
        args.occurred.unwrap_or(Occurred::Unknown),
        EventPayload::Closed {
            note: args.note.filter(|s| !s.trim().is_empty()),
            stage_update_mode: stage_mode(args.update_progress),
        },
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectStageArgs {
    pub id: String,
    pub from: String,
    pub to: String,
    pub reason: String,
}

pub fn correct_stage(
    store: &ArchiveStore,
    args: CorrectStageArgs,
) -> Result<ApplicationView, CommandError> {
    if args.reason.trim().is_empty() {
        return Err(CommandError {
            code: "VALIDATION".into(),
            message: "纠正阶段必须填写原因".into(),
        });
    }
    append_user_event(
        store,
        &args.id,
        EventPayload::StageCorrected {
            from: parse_stage(&args.from)?,
            to: parse_stage(&args.to)?,
            reason: args.reason.trim().into(),
            actor: Actor::User,
        },
    )
}

pub fn set_recycle(
    store: &ArchiveStore,
    id: &str,
    recycled: bool,
) -> Result<ApplicationDetail, CommandError> {
    let state = if recycled {
        RecycleState::Recycled
    } else {
        RecycleState::Active
    };
    Ok(store.set_recycle_state(id, state)?)
}

pub fn query_candidates(
    store: &ArchiveStore,
    company: &str,
    title: &str,
    source_url: Option<&str>,
) -> Result<Candidates, CommandError> {
    Ok(store.query_candidates(company, title, source_url)?)
}

/// Offline manager loop used by `--apps-loop` and integration tests.
pub fn application_manager_loop(store: &ArchiveStore) -> Result<serde_json::Value, CommandError> {
    let a = create_application(
        store,
        CreateApplicationArgs {
            company: "合成公司".into(),
            title: "后端实习".into(),
            source_url: Some("https://jobs.example.test/apply?utm_source=mail".into()),
            location: Some("上海".into()),
            notes: None,
            confirm_duplicate: false,
        },
    )?;
    let first = a.application.expect("created");
    let b = create_application(
        store,
        CreateApplicationArgs {
            company: "合成公司".into(),
            title: "前端实习".into(),
            source_url: None,
            location: Some("上海".into()),
            notes: None,
            confirm_duplicate: true,
        },
    )?;
    let second = b.application.expect("created");
    confirm_submit(
        store,
        SubmitArgs {
            id: first.id.clone(),
            note: Some("已在官网提交".into()),
        },
    )?;
    record_interview(
        store,
        ProgressEventArgs {
            occurred: None,
            id: first.id.clone(),
            name: None,
            round: Some(1),
            label: Some("一面".into()),
            note: None,
            reason: None,
            update_progress: true,
        },
    )?;
    add_note(
        store,
        NoteArgs {
            id: first.id.clone(),
            text: "面试官提到项目经历".into(),
        },
    )?;
    record_offer(
        store,
        ProgressEventArgs {
            occurred: None,
            id: first.id.clone(),
            name: None,
            round: None,
            label: None,
            note: Some("口头 offer".into()),
            reason: None,
            update_progress: true,
        },
    )?;
    let after_history = record_assessment(
        store,
        ProgressEventArgs {
            occurred: None,
            id: first.id.clone(),
            name: Some("线上测评".into()),
            round: None,
            label: None,
            note: None,
            reason: None,
            update_progress: false,
        },
    )?;
    assert_eq!(after_history.application.current_stage, Stage::Offer);
    set_recycle(store, &first.id, true)?;
    set_recycle(store, &first.id, false)?;
    let restored = get_application(store, &first.id)?;
    Ok(serde_json::json!({
        "ok": true,
        "firstId": first.id,
        "secondId": second.id,
        "stage": restored.application.current_stage,
        "events": restored.events.len(),
        "secondTitle": second.title,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store() -> (TempDir, ArchiveStore) {
        let dir = TempDir::new().unwrap();
        let archive = dir.path().join("archive");
        let pointer = dir.path().join("current.json");
        std::fs::create_dir_all(&archive).unwrap();
        let store = open_store(&archive, &pointer).unwrap();
        (dir, store)
    }

    #[test]
    fn create_list_edit_and_reject_empty() {
        let (_dir, store) = store();
        let created = create_application(
            &store,
            CreateApplicationArgs {
                company: "合成公司".into(),
                title: "后端实习".into(),
                source_url: Some("https://jobs.example.test/a?access_token=secret".into()),
                location: Some("上海".into()),
                notes: Some("初稿".into()),
                confirm_duplicate: false,
            },
        )
        .unwrap();
        let app = created.application.unwrap();
        assert!(app
            .source_url
            .as_deref()
            .unwrap()
            .contains("jobs.example.test"));
        assert!(!app.source_url.as_deref().unwrap().contains("access_token"));
        let page = list_applications(
            &store,
            ListApplicationsArgs {
                query: Some("后端".into()),
                stage: None,
                recycle: None,
                sort: Some("title".into()),
                desc: Some(false),
                limit: Some(10),
                offset: Some(0),
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        let err = create_application(
            &store,
            CreateApplicationArgs {
                company: " ".into(),
                title: "x".into(),
                source_url: None,
                location: None,
                notes: None,
                confirm_duplicate: false,
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        let updated = update_application(
            &store,
            UpdateApplicationArgs {
                id: app.id.clone(),
                company: None,
                title: Some("后端实习（更新）".into()),
                source_url: None,
                location: None,
                notes: Some("仍在编辑".into()),
                archived: None,
            },
        )
        .unwrap();
        assert!(updated.title.contains("更新"));
        assert_eq!(updated.current_stage, Stage::Saved);
    }

    #[test]
    fn submit_interview_history_and_recycle() {
        let (_dir, store) = store();
        let report = application_manager_loop(&store).unwrap();
        assert_eq!(report["ok"], true);
        assert_eq!(report["stage"], "offer");
        assert!(report["events"].as_u64().unwrap() >= 6);
        let first = report["firstId"].as_str().unwrap();
        let view = get_application(&store, first).unwrap();
        assert_eq!(view.application.recycle_state, RecycleState::Active);
        let types: Vec<_> = view.events.iter().map(|e| e.event_type.as_str()).collect();
        assert!(types.contains(&"submit_confirmed"));
        assert!(types.contains(&"assessment_recorded"));
        let seqs: Vec<_> = view.events.iter().map(|e| e.event_sequence).collect();
        let mut sorted = seqs.clone();
        sorted.sort();
        assert_eq!(seqs, sorted);
    }

    #[test]
    fn duplicate_hint_then_explicit_create() {
        let (_dir, store) = store();
        create_application(
            &store,
            CreateApplicationArgs {
                company: "合成公司".into(),
                title: "后端实习".into(),
                source_url: None,
                location: None,
                notes: None,
                confirm_duplicate: false,
            },
        )
        .unwrap();
        let hint = create_application(
            &store,
            CreateApplicationArgs {
                company: "合成公司".into(),
                title: "后端实习".into(),
                source_url: None,
                location: None,
                notes: None,
                confirm_duplicate: false,
            },
        )
        .unwrap();
        assert!(!hint.created);
        assert!(hint.candidates.is_some());
        let forced = create_application(
            &store,
            CreateApplicationArgs {
                company: "合成公司".into(),
                title: "后端实习".into(),
                source_url: None,
                location: None,
                notes: None,
                confirm_duplicate: true,
            },
        )
        .unwrap();
        assert!(forced.created);
        let page = list_applications(
            &store,
            ListApplicationsArgs {
                query: Some("合成".into()),
                stage: None,
                recycle: None,
                sort: None,
                desc: None,
                limit: Some(20),
                offset: Some(0),
            },
        )
        .unwrap();
        assert_eq!(page.total, 2);
    }

    #[test]
    fn reopen_preserves_timeline() {
        let dir = TempDir::new().unwrap();
        let archive = dir.path().join("archive");
        let pointer = dir.path().join("current.json");
        std::fs::create_dir_all(&archive).unwrap();
        let first_id;
        {
            let store = open_store(&archive, &pointer).unwrap();
            let report = application_manager_loop(&store).unwrap();
            first_id = report["firstId"].as_str().unwrap().to_string();
        }
        let store = open_store(&archive, &pointer).unwrap();
        let view = get_application(&store, &first_id).unwrap();
        assert_eq!(view.application.current_stage, Stage::Offer);
        assert!(view.events.len() >= 6);
        assert_eq!(view.application.title, "后端实习");
    }

    #[test]
    fn offer_back_requires_correction() {
        let (_dir, store) = store();
        let created = create_application(
            &store,
            CreateApplicationArgs {
                company: "合成公司".into(),
                title: "后端实习".into(),
                source_url: None,
                location: None,
                notes: None,
                confirm_duplicate: false,
            },
        )
        .unwrap()
        .application
        .unwrap();
        confirm_submit(
            &store,
            SubmitArgs {
                id: created.id.clone(),
                note: None,
            },
        )
        .unwrap();
        record_offer(
            &store,
            ProgressEventArgs {
                occurred: None,
                id: created.id.clone(),
                name: None,
                round: None,
                label: None,
                note: None,
                reason: None,
                update_progress: true,
            },
        )
        .unwrap();
        let err = correct_stage(
            &store,
            CorrectStageArgs {
                id: created.id.clone(),
                from: "offer".into(),
                to: "interview".into(),
                reason: " ".into(),
            },
        )
        .unwrap_err();
        assert_eq!(err.code, "VALIDATION");
        let view = correct_stage(
            &store,
            CorrectStageArgs {
                id: created.id.clone(),
                from: "offer".into(),
                to: "interview".into(),
                reason: "录错阶段".into(),
            },
        )
        .unwrap();
        assert_eq!(view.application.current_stage, Stage::Interview);
    }
}
