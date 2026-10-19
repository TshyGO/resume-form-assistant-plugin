use super::{model::*, schedule::*, *};
use sha2::{Digest, Sha256};

impl Service {
    pub fn start_failed(&self, error: crate::commands::CommandError, cancel: &CancellationToken) {
        self.finish(Err(error), cancel);
    }
    pub fn binding(
        scope: &str,
        options: &Options,
        identity: &archive_store::ArchiveIdentity,
    ) -> String {
        // Includes destination and plaintext/encryption policy. No account data
        // or archive paths are written into the scheduler journal.
        let value = serde_json::to_vec(&(
            scope,
            &options.root,
            options.encrypted,
            &identity.archive_id,
            &identity.restore_epoch,
        ))
        .unwrap();
        format!("{:x}", Sha256::digest(value))
    }
    pub fn identity(&self) -> Result<archive_store::ArchiveIdentity> {
        self.store
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .as_ref()
            .map(|s| s.identity())
            .ok_or_else(|| fail("STORE_UNAVAILABLE"))
    }
    pub fn configure(
        self: &Arc<Self>,
        plan: Plan,
        scope: &str,
        options: &Options,
        now: i64,
    ) -> Result<()> {
        plan.check()?;
        let _lease = self.reserve()?;
        let binding = Self::binding(scope, options, &self.identity()?);
        let state = self
            .journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .clone();
        if !state
            .baseline
            .as_ref()
            .is_some_and(|b| b.binding == binding && b.manual_confirmed)
        {
            return Err(fail("MANUAL_BACKUP_REQUIRED"));
        }
        if state
            .job
            .as_ref()
            .is_some_and(|j| j.candidate_ready && !j.published)
        {
            return Err(fail("RETRY_REQUIRED"));
        }
        self.update(|s| {
            let a = &mut s.automatic;
            a.next_at = Some(plan.first(now));
            a.plan = Some(plan);
            a.binding = binding;
            a.paused = None;
            a.message = Some("ENABLED".into());
            a.pending_job = None;
            a.retry_at = None;
            a.retries = 0;
            a.cycle(now); // Reconfirmation never resets observed traffic.
            a.budget_warning = a
                .plan
                .as_ref()
                .is_some_and(|p| a.upload_bytes >= p.budget_bytes.saturating_mul(80) / 100);
        })
    }
    pub fn schedule_status(
        &self,
        enabled: bool,
        requires_confirmation: bool,
        binding: Option<&str>,
    ) -> Result<schedule::Status> {
        let old = self
            .journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .automatic
            .clone();
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        if old
            .cycle_started_at
            .is_some_and(|start| now >= start + CYCLE)
        {
            self.update(|s| s.automatic.cycle(now))?;
        }
        let state = self.journal.lock().map_err(|_| fail("LOCAL_STATE"))?;
        let size = state
            .baseline
            .as_ref()
            .filter(|b| Some(b.binding.as_str()) == binding)
            .map(|b| b.size_bytes);
        Ok(schedule::Status {
            enabled,
            requires_confirmation,
            estimated_cycle_bytes: state
                .automatic
                .plan
                .as_ref()
                .and_then(|p| size.map(|n| p.estimate(n))),
            recent_size: size,
            state: state.automatic.clone(),
        })
    }
    pub fn pause_automatic(&self, reason: &str) -> Result<()> {
        self.update(|s| s.automatic.paused = Some(reason.into()))
    }
    pub fn manual_job(&self) -> Result<()> {
        self.update(|s| {
            if let Some(j) = s.job.as_mut() {
                j.automatic = false;
            }
            if s.automatic.pending_job.is_some() {
                if s.job
                    .as_ref()
                    .is_some_and(|j| Some(&j.id) == s.automatic.pending_job.as_ref())
                {
                    s.automatic.paused = Some("MANUAL_TAKEOVER".into());
                }
                s.automatic.pending_job = None;
                s.automatic.retry_at = None;
            }
        })
    }
    pub fn cancel_automatic(&self) -> Result<()> {
        if self.job().is_ok_and(|j| {
            j.automatic
                && matches!(
                    j.phase,
                    Phase::Packing | Phase::Encrypting | Phase::Uploading | Phase::Confirming
                )
        }) {
            self.cancel()?;
        }
        Ok(())
    }
    pub fn charge_upload(&self, bytes: u64) -> Result<()> {
        let automatic = self.job()?.automatic;
        let mut result = Ok(());
        self.update(|s| {
            result = s.automatic.charge(
                time::OffsetDateTime::now_utc().unix_timestamp(),
                bytes,
                automatic,
            )
        })?;
        result
    }
    /// Called with the settings host guard held, so the enabled gate cannot
    /// race an archive switch or configuration edit. Claims reach disk first.
    #[cfg(test)]
    pub fn automatic_action(
        self: &Arc<Self>,
        scope: &str,
        options: &Options,
        now: i64,
        previous: Option<i64>,
    ) -> Result<Option<(Job, Lease, bool)>> {
        self.automatic_action_clock(scope, options, previous, || now)
    }
    pub fn automatic_action_clock(
        self: &Arc<Self>,
        scope: &str,
        options: &Options,
        previous: Option<i64>,
        clock: impl FnOnce() -> i64,
    ) -> Result<Option<(Job, Lease, bool)>> {
        options.check()?;
        // Own the same operation lease before reading/planning. A manual job
        // cannot change the journal/budget between policy read and its commit.
        let lease = match self.reserve() {
            Ok(lease) => lease,
            Err(e) if e.code == "CLOUD_BUSY" => {
                if previous.is_some_and(|p| clock() < p) {
                    self.pause_automatic("CLOCK_CHANGED")?;
                }
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let binding = Self::binding(scope, options, &self.identity()?);
        let state = self
            .journal
            .lock()
            .map_err(|_| fail("LOCAL_STATE"))?
            .clone();
        if state.automatic.plan.is_none() {
            return Ok(None);
        }
        if state.automatic.binding != binding {
            if state.automatic.paused.as_deref() != Some("ARCHIVE_OR_CONFIG_CHANGED") {
                self.pause_automatic("ARCHIVE_OR_CONFIG_CHANGED")?;
            }
            return Ok(None);
        }
        let now = clock(); // Read after potentially blocking store/journal guards.
        let mut next = state.automatic.clone();
        if previous.is_none()
            && next.pending_job.is_none()
            && next.message.as_deref() == Some("CHECKING")
        {
            next.message = Some("MISSED_MANUAL".into());
        }
        let action = next.tick(now, previous, state.job.as_ref());
        if serde_json::to_vec(&next).ok() != serde_json::to_vec(&state.automatic).ok() {
            self.update(|s| s.automatic = next)?;
        }
        let started = match action {
            Decision::None => return Ok(None),
            Decision::Start => self.begin_reserved(options.clone(), scope.into(), lease),
            Decision::Retry => self.retry_reserved(scope, options, lease),
        };
        let (mut job, lease) = match started {
            Ok(v) => v,
            Err(e) => {
                self.pause_automatic(&e.code)?;
                return Err(e);
            }
        };
        job.automatic = true;
        if let Err(e) = self.update(|s| {
            s.job.as_mut().unwrap().automatic = true;
            s.automatic.pending_job = Some(job.id.clone());
        }) {
            self.start_failed(e.clone(), &lease.cancel);
            return Err(e);
        }
        Ok(Some((job, lease, action == Decision::Start)))
    }
}
