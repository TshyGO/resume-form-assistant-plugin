//! 申请(§8.2):身份是 UUID,同公司多岗与同岗重复申请并存;
//! 列表归档/回收不删除任何历史;永久删除在 [StoreTx::purge_application]。

use rusqlite::params;

use crate::error::StoreError;
use crate::model::*;
use crate::normalize::{
    normalize_company, normalize_dedupe_url, normalize_title, sanitize_source_url,
};
use crate::timeutil::now_utc;
use crate::tx::{new_uuid, StoreTx};

#[derive(Debug, Clone, Default)]
pub struct UpdateApplicationInput {
    pub company: Option<String>,
    pub title: Option<String>,
    /// None = 不变;Some(None) = 清除;Some(Some(v)) = 更新。
    pub source_url: Option<Option<String>>,
    pub location: Option<Option<String>>,
    pub notes: Option<Option<String>>,
    /// 列表归档(非回收)。
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ListSort {
    #[default]
    UpdatedAt,
    Company,
    Title,
    Stage,
}

#[derive(Debug, Clone, Default)]
pub struct ApplicationFilter {
    /// None hides list-archived records; Some(true) shows archived, Some(false) shows both.
    pub archived: Option<bool>,
    pub stages: Vec<Stage>,
    /// 默认只看 active;传 Some(state) 过滤,Some(None) = 全部。
    pub recycle_state: Option<Option<RecycleState>>,
    pub reply_state: Option<ReplyEvidenceState>,
    /// 公司规范化前缀/包含匹配(用规范化值,不碰原始 PII 排序)。
    pub company_contains: Option<String>,
    /// 列表搜索:公司、岗位或地点(SQL 内完成,不在内存过滤)。
    pub query: Option<String>,
    pub sort: ListSort,
    pub order_updated_desc: bool,
    pub limit: u32,
    pub offset: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: usize,
}

/// 两层候选查询结果(§7):精确层 + 同公司提示层。默认由用户选择,
/// 数据层永不自动绑定。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Candidates {
    pub exact: Vec<ApplicationCandidate>,
    pub same_company: Vec<ApplicationCandidate>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ApplicationCandidate {
    pub id: String,
    pub company: String,
    pub title: String,
    pub current_stage: Stage,
    pub source_url: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PurgeReport {
    pub application_id: String,
    pub events_removed: usize,
    pub todos_removed: usize,
    pub evidence_removed: usize,
    pub snapshots_removed: usize,
    /// 已置为墓碑的提交回执数量。
    pub tombstoned_receipts: usize,
    /// 引用计数降为 0 的 blob(库行已删;文件删除归 D09/D12)。
    pub blobs_released: Vec<String>,
}

impl StoreTx<'_> {
    pub fn create_application(
        &mut self,
        input: NewApplication,
    ) -> Result<ApplicationDetail, StoreError> {
        if input.company.trim().is_empty() {
            return Err(StoreError::Validation("company is required".into()));
        }
        if input.title.trim().is_empty() {
            return Err(StoreError::Validation("title is required".into()));
        }
        let id = new_uuid();
        let now = now_utc();
        let (source_url, dedupe_url) = match input.source_url.as_deref() {
            Some(raw) if !raw.trim().is_empty() => (
                Some(sanitize_source_url(raw)).filter(|s| !s.is_empty()),
                Some(normalize_dedupe_url(raw)).filter(|s| !s.is_empty()),
            ),
            _ => (None, None),
        };

        self.conn().execute(
            "INSERT INTO applications (id, company, company_normalized, title, title_normalized, \
             source_url, dedupe_url, location, notes, current_stage, last_event_sequence, \
             reply_evidence_state, created_at, updated_at, recycle_state, origin) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'saved', 0, 'none_imported', ?10, ?10, 'active', ?11)",
            params![
                id,
                input.company.trim(),
                normalize_company(&input.company),
                input.title.trim(),
                normalize_title(&input.title),
                source_url,
                dedupe_url,
                input.location.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                input.notes.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                now,
                input.origin.as_str(),
            ],
        )?;

        let source = match input.origin {
            ApplicationOrigin::Plugin => EventSource::Plugin,
            ApplicationOrigin::Manual => EventSource::Manual,
        };
        let draft = EventDraft {
            occurred: input.occurred_at.clone(),
            source,
            source_request_id: None,
            actor: Actor::System,
            payload: EventPayload::ApplicationCreated {
                company: input.company.trim().to_string(),
                title: input.title.trim().to_string(),
                source_url: source_url.clone(),
                location: input.location.clone(),
                origin: input.origin,
            },
        };
        self.append_events(Some(&id), &[draft], &now)?;
        self.get_application(&id)?
            .ok_or_else(|| StoreError::Internal("application vanished in same transaction".into()))
    }

    pub fn get_application(&self, id: &str) -> Result<Option<ApplicationDetail>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT id, company, company_normalized, title, title_normalized, source_url, \
             dedupe_url, location, notes, current_stage, last_event_sequence, \
             reply_evidence_state, created_at, updated_at, archived_at, recycle_state, origin \
             FROM applications WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], map_application_row)?;
        match rows.next() {
            Some(row) => row.map(Some).map_err(StoreError::from),
            None => Ok(None),
        }
    }

    pub fn update_application(
        &mut self,
        id: &str,
        input: UpdateApplicationInput,
    ) -> Result<ApplicationDetail, StoreError> {
        let current = self
            .get_application(id)?
            .ok_or_else(|| StoreError::NotFound(format!("application {id}")))?;
        let now = now_utc();

        let mut company = current.company.clone();
        let mut title = current.title.clone();
        let mut source_url = current.source_url.clone();
        let mut location = current.location.clone();
        let mut notes = current.notes.clone();
        let mut archived_at = current.archived_at.clone();
        let mut changes: Vec<FieldChange> = Vec::new();

        if let Some(c) = &input.company {
            let t = c.trim();
            if !t.is_empty() && t != current.company {
                changes.push(FieldChange {
                    field: "company".into(),
                    from: Some(current.company.clone()),
                    to: Some(t.to_string()),
                });
                company = t.to_string();
            }
        }
        if let Some(t) = &input.title {
            let tt = t.trim();
            if !tt.is_empty() && tt != current.title {
                changes.push(FieldChange {
                    field: "title".into(),
                    from: Some(current.title.clone()),
                    to: Some(tt.to_string()),
                });
                title = tt.to_string();
            }
        }
        if let Some(src) = &input.source_url {
            let nv = src
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(sanitize_source_url)
                .filter(|s| !s.is_empty());
            if nv != current.source_url {
                changes.push(FieldChange {
                    field: "source_url".into(),
                    from: current.source_url.clone(),
                    to: nv.clone(),
                });
                source_url = nv;
            }
        }
        if let Some(loc) = &input.location {
            let nv = loc
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            if nv != current.location {
                changes.push(FieldChange {
                    field: "location".into(),
                    from: current.location.clone(),
                    to: nv.clone(),
                });
                location = nv;
            }
        }
        if let Some(n) = &input.notes {
            let nv = n
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            if nv != current.notes {
                changes.push(FieldChange {
                    field: "notes".into(),
                    from: current.notes.clone(),
                    to: nv.clone(),
                });
                notes = nv;
            }
        }
        if let Some(arch) = input.archived {
            let nv = if arch { Some(now.clone()) } else { None };
            if nv != current.archived_at {
                changes.push(FieldChange {
                    field: "archived".into(),
                    from: current.archived_at.clone(),
                    to: nv.clone(),
                });
                archived_at = nv;
            }
        }

        if changes.is_empty() {
            return self
                .get_application(id)?
                .ok_or_else(|| StoreError::NotFound(id.to_string()));
        }

        let company_n = normalize_company(&company);
        let title_n = normalize_title(&title);
        let dedupe_url = source_url
            .as_deref()
            .map(normalize_dedupe_url)
            .filter(|s| !s.is_empty());

        self.conn().execute(
            "UPDATE applications SET company = ?1, company_normalized = ?2, title = ?3, \
             title_normalized = ?4, source_url = ?5, location = ?6, notes = ?7, dedupe_url = ?8, \
             archived_at = ?9, updated_at = ?10 WHERE id = ?11",
            params![
                company,
                company_n,
                title,
                title_n,
                source_url,
                location,
                notes,
                dedupe_url,
                archived_at,
                now,
                id
            ],
        )?;

        let draft = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload: EventPayload::ApplicationUpdated { changes },
        };
        self.append_events(Some(id), &[draft], &now)?;
        self.get_application(id)?
            .ok_or_else(|| StoreError::NotFound(id.to_string()))
    }

    /// 回收/恢复(非永久删除):历史、证据、附件全部保留。
    pub fn set_recycle_state(
        &mut self,
        id: &str,
        state: RecycleState,
    ) -> Result<ApplicationDetail, StoreError> {
        if state == RecycleState::Purged {
            return Err(StoreError::Validation(
                "use purge_application for permanent deletion".into(),
            ));
        }
        let current = self
            .get_application(id)?
            .ok_or_else(|| StoreError::NotFound(format!("application {id}")))?;
        let now = now_utc();
        self.conn().execute(
            "UPDATE applications SET recycle_state = ?1, updated_at = ?2 WHERE id = ?3",
            params![state.as_str(), now, id],
        )?;
        let event_type = match state {
            RecycleState::Recycled => "application_recycled",
            _ => "application_restored",
        };
        let draft = EventDraft {
            occurred: Occurred::DateTime {
                rfc3339: now.clone(),
                time_zone: None,
            },
            source: EventSource::Manual,
            source_request_id: None,
            actor: Actor::User,
            payload: EventPayload::Custom {
                event_type: event_type.into(),
                data: serde_json::json!({ "from": current.recycle_state.as_str(), "to": state.as_str() }),
                stage_update_mode: StageUpdateMode::HistoryOnly,
            },
        };
        self.append_events(Some(id), &[draft], &now)?;
        self.get_application(id)?
            .ok_or_else(|| StoreError::NotFound(id.to_string()))
    }

    /// 列表/过滤/分页:SQL 层完成,不依赖全量读入内存。
    pub fn list_applications(
        &self,
        filter: &ApplicationFilter,
    ) -> Result<Page<ApplicationSummary>, StoreError> {
        let mut where_clauses: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        match filter.archived {
            None => where_clauses.push("archived_at IS NULL".into()),
            Some(true) => where_clauses.push("archived_at IS NOT NULL".into()),
            Some(false) => {}
        }
        match &filter.recycle_state {
            Some(None) => {}
            Some(Some(state)) => {
                args.push(Box::new(state.as_str().to_string()));
                where_clauses.push(format!("recycle_state = ?{}", args.len()));
            }
            None => {
                where_clauses.push("recycle_state = 'active'".to_string());
            }
        }
        if !filter.stages.is_empty() {
            let placeholders = filter
                .stages
                .iter()
                .map(|s| {
                    args.push(Box::new(s.as_str().to_string()));
                    "?".to_string()
                })
                .collect::<Vec<_>>()
                .join(", ");
            where_clauses.push(format!("current_stage IN ({placeholders})"));
        }
        if let Some(rs) = filter.reply_state {
            args.push(Box::new(rs.as_str().to_string()));
            where_clauses.push(format!("reply_evidence_state = ?{}", args.len()));
        }
        if let Some(cc) = &filter.company_contains {
            let norm = normalize_company(cc);
            if !norm.is_empty() {
                args.push(Box::new(format!("%{norm}%")));
                where_clauses.push(format!("company_normalized LIKE ?{}", args.len()));
            }
        }
        if let Some(q) = &filter.query {
            let trimmed = q.trim();
            if !trimmed.is_empty() {
                let company_like = format!("%{}%", normalize_company(trimmed));
                let title_like = format!("%{}%", normalize_title(trimmed));
                let loc_like = format!("%{}%", trimmed.to_lowercase());
                args.push(Box::new(company_like));
                let c = args.len();
                args.push(Box::new(title_like));
                let t = args.len();
                args.push(Box::new(loc_like));
                let l = args.len();
                where_clauses.push(format!(
                    "(company_normalized LIKE ?{c} OR title_normalized LIKE ?{t} OR lower(IFNULL(location, '')) LIKE ?{l})"
                ));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let total: usize = {
            let sql = format!("SELECT COUNT(*) FROM applications {where_sql}");
            let map = args.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
            self.conn()
                .query_row(&sql, rusqlite::params_from_iter(map.iter().copied()), |r| {
                    r.get::<_, i64>(0)
                })? as usize
        };

        let col = match filter.sort {
            ListSort::UpdatedAt => "updated_at",
            ListSort::Company => "company_normalized",
            ListSort::Title => "title_normalized",
            ListSort::Stage => "current_stage",
        };
        let dir = if filter.order_updated_desc {
            "DESC"
        } else {
            "ASC"
        };
        let order = format!("{col} {dir}, id ASC");
        let limit = filter.limit.clamp(1, 1000);
        let sql = format!(
            "SELECT id, company, company_normalized, title, title_normalized, source_url, \
             dedupe_url, location, notes, current_stage, last_event_sequence, reply_evidence_state, \
             created_at, updated_at, archived_at, recycle_state, origin \
             FROM applications {where_sql} ORDER BY {order} LIMIT {limit} OFFSET {}",
            filter.offset
        );
        let map = args.iter().map(|b| b.as_ref()).collect::<Vec<_>>();
        let mut stmt = self.conn().prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(map.iter().copied()), |r| {
            map_application_row(r).map(|d| d.summary)
        })?;
        let items = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(Page { items, total })
    }

    /// 两层候选查询(§7)。输入是用户确认过的原始字段;规范化在这里完成。
    pub fn query_candidates(
        &self,
        company: &str,
        title: &str,
        source_url: Option<&str>,
    ) -> Result<Candidates, StoreError> {
        let company_n = normalize_company(company);
        let title_n = normalize_title(title);
        let dedupe = source_url
            .map(normalize_dedupe_url)
            .filter(|s| !s.is_empty());

        let map_candidate = |r: &rusqlite::Row<'_>| -> rusqlite::Result<ApplicationCandidate> {
            let stage_raw: String = r.get(3)?;
            Ok(ApplicationCandidate {
                id: r.get(0)?,
                company: r.get(1)?,
                title: r.get(2)?,
                current_stage: Stage::parse(&stage_raw).unwrap_or(Stage::Saved),
                source_url: r.get(4)?,
                updated_at: r.get(5)?,
            })
        };
        let sql =
            "SELECT id, company, title, current_stage, source_url, updated_at FROM applications \
                   WHERE recycle_state != 'purged' AND ";

        let exact;
        {
            let sql_exact = if dedupe.is_some() {
                format!(
                    "{sql} company_normalized = ?1 AND title_normalized = ?2 AND dedupe_url = ?3"
                )
            } else {
                format!("{sql} company_normalized = ?1 AND title_normalized = ?2 AND (dedupe_url IS NULL OR dedupe_url = '')")
            };
            let mut stmt = self.conn().prepare(&sql_exact)?;
            let rows = if let Some(d) = &dedupe {
                stmt.query_map(params![company_n, title_n, d], map_candidate)?
            } else {
                stmt.query_map(params![company_n, title_n], map_candidate)?
            };
            exact = rows.collect::<Result<Vec<_>, _>>()?;
        }

        let mut same_company;
        {
            let sql_company = format!("{sql} company_normalized = ?1");
            let mut stmt = self.conn().prepare(&sql_company)?;
            let rows = stmt.query_map(params![company_n], map_candidate)?;
            same_company = rows.collect::<Result<Vec<_>, _>>()?;
        }
        let exact_ids: Vec<String> = exact.iter().map(|c| c.id.clone()).collect();
        same_company.retain(|c| !exact_ids.contains(&c.id));

        Ok(Candidates {
            exact,
            same_company,
        })
    }

    /// 永久删除(二次确认在 UI 层):删除申请及其时间线/待办/证据/快照行,
    /// 在同一事务保留最小幂等墓碑(消息身份 + 摘要 + purged 标记),
    /// 旧请求重试得到 previously_purged,不得复活数据(隐私 §5、§8.11)。
    pub fn purge_application(&mut self, id: &str) -> Result<PurgeReport, StoreError> {
        let _app = self
            .get_application(id)?
            .ok_or_else(|| StoreError::NotFound(format!("application {id}")))?;
        let mut report = PurgeReport {
            application_id: id.to_string(),
            ..Default::default()
        };

        let event_ids: Vec<String> = {
            let mut stmt = self
                .conn()
                .prepare("SELECT id FROM events WHERE application_id = ?1")?;
            let rows = stmt.query_map(params![id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let evidence_ids: Vec<String> = {
            let mut stmt = self
                .conn()
                .prepare("SELECT id FROM reply_evidence WHERE application_id = ?1")?;
            let rows = stmt.query_map(params![id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let evidence_blobs: Vec<String> = {
            let mut stmt = self
                .conn()
                .prepare("SELECT blob_sha256 FROM reply_evidence WHERE application_id = ?1")?;
            let rows = stmt.query_map(params![id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let snapshot_ids: Vec<String> = {
            let mut stmt = self
                .conn()
                .prepare("SELECT snapshot_id FROM resume_snapshots WHERE application_id = ?1 UNION SELECT snapshot_id FROM snapshot_uploads WHERE application_id = ?1")?;
            let rows = stmt.query_map(params![id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        // 1. 墓碑:覆盖申请 id、事件 id、快照 id,以及这些快照的 chunk 回执。
        {
            let mut tombstoned = 0usize;
            for key in event_ids
                .iter()
                .chain(snapshot_ids.iter())
                .map(String::as_str)
                .chain(std::iter::once(id))
            {
                tombstoned += self.conn().execute(
                    "UPDATE message_receipts SET purged = 1 WHERE result_id = ?1 AND purged = 0",
                    params![key],
                )?;
            }
            for sid in &snapshot_ids {
                tombstoned += self.conn().execute(
                    "UPDATE message_receipts SET purged = 1 WHERE snapshot_id = ?1 AND purged = 0",
                    params![sid],
                )?;
            }
            report.tombstoned_receipts = tombstoned;
        }

        // 2. AI 建议(挂在证据上)。
        for ev in &evidence_ids {
            self.conn().execute(
                "DELETE FROM ai_suggestions WHERE evidence_id = ?1",
                params![ev],
            )?;
        }
        report.evidence_removed = evidence_ids.len();
        // 3. 证据与 blob 引用计数。
        for blob in &evidence_blobs {
            self.conn().execute(
                "UPDATE attachment_blobs SET ref_count = ref_count - 1 WHERE sha256 = ?1",
                params![blob],
            )?;
        }
        for ev in &evidence_ids {
            self.conn()
                .execute("DELETE FROM reply_evidence WHERE id = ?1", params![ev])?;
        }
        // 4. Each shared blob is checked once after all reference decrements.
        for blob in evidence_blobs
            .iter()
            .collect::<std::collections::HashSet<_>>()
        {
            let released: bool = self.conn().query_row(
                "SELECT ref_count = 0 FROM attachment_blobs WHERE sha256 = ?1",
                params![blob],
                |r| r.get(0),
            )?;
            if released {
                self.conn().execute(
                    "DELETE FROM attachment_blobs WHERE sha256 = ?1",
                    params![blob],
                )?;
                if !report.blobs_released.contains(blob) {
                    report.blobs_released.push(blob.clone());
                }
            }
        }
        // 5. 快照与分片账本(回执墓碑已保留)。
        for sid in &snapshot_ids {
            self.conn().execute(
                "DELETE FROM snapshot_chunks WHERE snapshot_id = ?1",
                params![sid],
            )?;
            self.conn().execute(
                "DELETE FROM snapshot_uploads WHERE snapshot_id = ?1",
                params![sid],
            )?;
        }
        report.snapshots_removed = snapshot_ids.len();
        self.conn().execute(
            "DELETE FROM resume_snapshots WHERE application_id = ?1",
            params![id],
        )?;
        // 6. 待办。
        report.todos_removed = self
            .conn()
            .execute("DELETE FROM todos WHERE application_id = ?1", params![id])?;
        // 7. 事件与申请行。
        report.events_removed = self
            .conn()
            .execute("DELETE FROM events WHERE application_id = ?1", params![id])?;
        self.conn()
            .execute("DELETE FROM applications WHERE id = ?1", params![id])?;

        Ok(report)
    }
}

#[allow(clippy::type_complexity)]
pub(crate) fn map_application_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ApplicationDetail> {
    let stage_raw: String = r.get(9)?;
    let reply_raw: String = r.get(11)?;
    let recycle_raw: String = r.get(15)?;
    let origin_raw: String = r.get(16)?;
    Ok(ApplicationDetail {
        summary: ApplicationSummary {
            id: r.get(0)?,
            company: r.get(1)?,
            title: r.get(3)?,
            source_url: r.get(5)?,
            location: r.get(7)?,
            current_stage: Stage::parse(&stage_raw).unwrap_or(Stage::Saved),
            reply_evidence_state: ReplyEvidenceState::parse(&reply_raw)
                .unwrap_or(ReplyEvidenceState::NoneImported),
            created_at: r.get(12)?,
            updated_at: r.get(13)?,
            archived_at: r.get(14)?,
            recycle_state: RecycleState::parse(&recycle_raw).unwrap_or(RecycleState::Active),
            origin: ApplicationOrigin::parse(&origin_raw).unwrap_or(ApplicationOrigin::Manual),
        },
        company_normalized: r.get(2)?,
        title_normalized: r.get(4)?,
        dedupe_url: r.get(6)?,
        notes: r.get(8)?,
        last_event_sequence: r.get(10)?,
    })
}
