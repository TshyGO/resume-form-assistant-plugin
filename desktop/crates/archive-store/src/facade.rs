//! `&self` 便捷方法:内部各包一个事务。批量操作用
//! [ArchiveStore::transaction] 显式组合,避免跨调用事务。

use crate::applications::{
    ApplicationFilter, Candidates, Page, PurgeReport, UpdateApplicationInput,
};
use crate::error::StoreError;
use crate::evidence::AttachmentRefReport;
use crate::model::*;
use crate::receipts::{SnapshotCompletion, SnapshotProgress, SnapshotState};
use crate::store::ArchiveStore;
use crate::suggestions::{ConfirmOutcome, ConfirmSuggestionInput};
use crate::todos::TodoPatch;

impl ArchiveStore {
    // ---- 申请 ----

    pub fn create_application(
        &self,
        input: NewApplication,
    ) -> Result<ApplicationDetail, StoreError> {
        self.transaction(|tx| tx.create_application(input))
    }

    pub fn get_application(&self, id: &str) -> Result<Option<ApplicationDetail>, StoreError> {
        self.transaction(|tx| tx.get_application(id))
    }

    pub fn update_application(
        &self,
        id: &str,
        input: UpdateApplicationInput,
    ) -> Result<ApplicationDetail, StoreError> {
        self.transaction(|tx| tx.update_application(id, input))
    }

    pub fn set_recycle_state(
        &self,
        id: &str,
        state: RecycleState,
    ) -> Result<ApplicationDetail, StoreError> {
        self.transaction(|tx| tx.set_recycle_state(id, state))
    }

    pub fn list_applications(
        &self,
        filter: &ApplicationFilter,
    ) -> Result<Page<ApplicationSummary>, StoreError> {
        self.transaction(|tx| tx.list_applications(filter))
    }

    pub fn query_candidates(
        &self,
        company: &str,
        title: &str,
        source_url: Option<&str>,
    ) -> Result<Candidates, StoreError> {
        self.transaction(|tx| tx.query_candidates(company, title, source_url))
    }

    pub fn purge_application(&self, id: &str) -> Result<PurgeReport, StoreError> {
        self.transaction(|tx| tx.purge_application(id))
    }

    // ---- 事件 ----

    pub fn append_event(
        &self,
        application_id: Option<&str>,
        draft: EventDraft,
    ) -> Result<StoredEvent, StoreError> {
        self.transaction(|tx| tx.append_event(application_id, draft))
    }

    pub fn list_events(&self, application_id: &str) -> Result<Vec<StoredEvent>, StoreError> {
        self.transaction(|tx| tx.list_events(application_id))
    }

    pub fn list_inbox_events(&self) -> Result<Vec<StoredEvent>, StoreError> {
        self.transaction(|tx| tx.list_inbox_events())
    }

    pub fn get_event(&self, event_id: &str) -> Result<StoredEvent, StoreError> {
        self.transaction(|tx| tx.get_event(event_id))
    }

    // ---- 证据 ----

    pub fn import_evidence(&self, input: NewEvidence) -> Result<ReplyEvidence, StoreError> {
        self.transaction(|tx| tx.import_evidence(input))
    }

    pub fn associate_evidence(
        &self,
        evidence_id: &str,
        to_application: &str,
    ) -> Result<ReplyEvidence, StoreError> {
        self.transaction(|tx| tx.associate_evidence(evidence_id, to_application))
    }

    pub fn classify_evidence(
        &self,
        evidence_id: &str,
        reply_class: ReplyClass,
        send_mode: SendMode,
    ) -> Result<ReplyEvidence, StoreError> {
        self.transaction(|tx| tx.classify_evidence(evidence_id, reply_class, send_mode))
    }

    pub fn get_evidence(&self, id: &str) -> Result<Option<ReplyEvidence>, StoreError> {
        self.transaction(|tx| tx.get_evidence(id))
    }

    pub fn list_evidence(
        &self,
        application_id: Option<&str>,
    ) -> Result<Vec<ReplyEvidence>, StoreError> {
        self.transaction(|tx| tx.list_evidence(application_id))
    }

    pub fn check_attachment_refs(&self) -> Result<AttachmentRefReport, StoreError> {
        self.transaction(|tx| tx.check_attachment_refs())
    }

    // ---- 待办 ----

    pub fn get_todo(&self, id: &str) -> Result<Option<Todo>, StoreError> {
        self.transaction(|tx| tx.get_todo(id))
    }

    pub fn create_todo(&self, input: NewTodo) -> Result<Todo, StoreError> {
        self.transaction(|tx| tx.create_todo(input))
    }

    pub fn update_todo(&self, id: &str, patch: TodoPatch) -> Result<Todo, StoreError> {
        self.transaction(|tx| tx.update_todo(id, patch))
    }

    pub fn complete_todo(&self, id: &str) -> Result<Todo, StoreError> {
        self.transaction(|tx| tx.complete_todo(id))
    }

    pub fn cancel_todo(&self, id: &str) -> Result<Todo, StoreError> {
        self.transaction(|tx| tx.cancel_todo(id))
    }

    pub fn list_todos(
        &self,
        application_id: Option<&str>,
        status: Option<TodoStatus>,
        due_before_utc: Option<&str>,
        limit: u32,
        offset: u64,
    ) -> Result<Vec<Todo>, StoreError> {
        self.transaction(|tx| tx.list_todos(application_id, status, due_before_utc, limit, offset))
    }

    // ---- AI 建议 ----

    pub fn create_suggestion(&self, input: NewAiSuggestion) -> Result<AiSuggestion, StoreError> {
        self.transaction(|tx| tx.create_suggestion(input))
    }

    pub fn get_suggestion(&self, id: &str) -> Result<Option<AiSuggestion>, StoreError> {
        self.transaction(|tx| tx.get_suggestion(id))
    }

    pub fn list_suggestions(
        &self,
        evidence_id: Option<&str>,
        status: Option<SuggestionStatus>,
    ) -> Result<Vec<AiSuggestion>, StoreError> {
        self.transaction(|tx| tx.list_suggestions(evidence_id, status))
    }

    pub fn confirm_suggestion(
        &self,
        input: ConfirmSuggestionInput,
    ) -> Result<ConfirmOutcome, StoreError> {
        self.transaction(|tx| tx.confirm_suggestion(input))
    }

    pub fn set_suggestion_status(
        &self,
        id: &str,
        status: SuggestionStatus,
    ) -> Result<AiSuggestion, StoreError> {
        self.transaction(|tx| tx.set_suggestion_status(id, status))
    }

    // ---- 快照 ----

    pub fn finalize_snapshot_upload(
        &self,
        client_instance_id: &str,
        snapshot_id: &str,
        stored_rel_path: &str,
    ) -> Result<ResumeSnapshotMeta, StoreError> {
        self.transaction(|tx| {
            tx.finalize_snapshot_upload(client_instance_id, snapshot_id, stored_rel_path)
        })
    }

    /// Turn a fully staged upload into the snapshot file and its row (D08).
    ///
    /// One transaction: assemble the staged chunks and check them against the declared size
    /// and digest, write `snapshots/<id>.json` atomically, commit the snapshot row and drop the
    /// staged bytes. Any failure rolls the rows back and leaves the chunks staged, so the next
    /// chunk the plugin sends — a resend is what it does when no complete ACK arrives — tries
    /// again. A file left behind by a failed commit is overwritten with the same bytes.
    pub fn complete_snapshot_upload(
        &self,
        client_instance_id: &str,
        snapshot_id: &str,
    ) -> Result<SnapshotCompletion, StoreError> {
        self.transaction(|tx| {
            let progress = tx.snapshot_progress(client_instance_id, snapshot_id)?;
            if progress.full_acked {
                let meta = tx.get_snapshot(snapshot_id)?.ok_or_else(|| {
                    StoreError::Internal("upload marked complete without a snapshot row".into())
                })?;
                // A replay is answered with the complete ACK, and on that ACK the plugin deletes
                // its only copy. Say it only while the file is really there and intact; the
                // staged bytes are gone by now, so a missing file is an archive fault, never a
                // fault in what the plugin sent.
                crate::tx::verify_file(
                    &tx.archive_dir,
                    &meta.stored_rel_path,
                    meta.byte_size,
                    &meta.sha256,
                )
                .map_err(|err| {
                    StoreError::Internal(format!("stored snapshot failed verification: {err}"))
                })?;
                return Ok(SnapshotCompletion::AlreadyComplete(meta));
            }
            let Some(bytes) = tx.assemble_staged_snapshot(client_instance_id, snapshot_id)? else {
                return Ok(SnapshotCompletion::Incomplete(progress));
            };
            let rel = crate::snapshot_file::rel_path_for(snapshot_id)?;
            crate::snapshot_file::write_atomically(&tx.archive_dir, &rel, &bytes)?;
            let template = crate::snapshot_file::template_of(&bytes);
            let meta = tx.finalize_snapshot_upload_with(
                client_instance_id,
                snapshot_id,
                &rel,
                Some(template),
            )?;
            Ok(SnapshotCompletion::Completed(meta))
        })
    }

    pub fn snapshot_progress(
        &self,
        client_instance_id: &str,
        snapshot_id: &str,
    ) -> Result<SnapshotProgress, StoreError> {
        self.transaction(|tx| tx.snapshot_progress(client_instance_id, snapshot_id))
    }

    pub fn get_snapshot(
        &self,
        snapshot_id: &str,
    ) -> Result<Option<ResumeSnapshotMeta>, StoreError> {
        self.transaction(|tx| tx.get_snapshot(snapshot_id))
    }

    pub fn snapshot_state(
        &self,
        application_id: &str,
        snapshot_id: &str,
    ) -> Result<SnapshotState, StoreError> {
        self.transaction(|tx| tx.snapshot_state(application_id, snapshot_id))
    }

    pub fn read_snapshot(&self, snapshot_id: &str) -> Result<(ResumeSnapshotMeta, Vec<u8>), StoreError> {
        self.transaction(|tx| tx.read_snapshot(snapshot_id))
    }

    pub fn list_snapshots(
        &self,
        application_id: &str,
    ) -> Result<Vec<ResumeSnapshotMeta>, StoreError> {
        self.transaction(|tx| tx.list_snapshots(application_id))
    }
}
