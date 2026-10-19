//! Pure, controllable-clock scheduling policy. All times are UTC Unix seconds;
//! slots use an explicitly confirmed fixed UTC offset, not ambient OS timezone.
use super::{fail, model::*, Result};
use serde::{Deserialize, Serialize};

pub const CYCLE: i64 = 30 * 86400;
pub const GRACE: i64 = 120;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub minute: u16,
    pub every_days: u16,
    pub utc_offset_minutes: i16,
    pub budget_bytes: u64,
    pub pause_at_budget: bool,
}
impl Plan {
    pub fn check(&self) -> Result<()> {
        if self.minute >= 1440
            || !(1..=30).contains(&self.every_days)
            || !(-720..=840).contains(&self.utc_offset_minutes)
            || !(1_000_000..=1_000_000_000_000).contains(&self.budget_bytes)
        {
            return Err(fail("INVALID_SCHEDULE"));
        }
        Ok(())
    }
    pub fn first(&self, now: i64) -> i64 {
        let offset = i64::from(self.utc_offset_minutes) * 60;
        let today = (now + offset).div_euclid(86400) * 86400 + i64::from(self.minute) * 60 - offset;
        if today > now {
            today
        } else {
            today + 86400
        }
    }
    pub fn advance(&self, slot: i64, now: i64) -> i64 {
        let period = i64::from(self.every_days) * 86400;
        slot + ((now - slot).div_euclid(period) + 1).max(1) * period
    }
    pub fn estimate(&self, size: u64) -> u64 {
        size.saturating_mul(30u64.div_ceil(u64::from(self.every_days)))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Automatic {
    pub plan: Option<Plan>,
    pub binding: String,
    pub next_at: Option<i64>,
    pub paused: Option<String>,
    pub message: Option<String>,
    pub pending_job: Option<String>,
    pub retry_at: Option<i64>,
    pub retries: u8,
    pub cycle_started_at: Option<i64>,
    pub upload_bytes: u64,
    pub budget_warning: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Baseline {
    pub binding: String,
    pub fingerprint: String,
    pub manual_confirmed: bool,
    pub size_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub requires_confirmation: bool,
    pub state: Automatic,
    pub recent_size: Option<u64>,
    pub estimated_cycle_bytes: Option<u64>,
}
#[derive(Debug, PartialEq)]
pub enum Decision {
    None,
    Start,
    Retry,
}

impl Automatic {
    pub fn cycle(&mut self, now: i64) {
        match self.cycle_started_at {
            None => self.cycle_started_at = Some(now),
            Some(start) if now >= start + CYCLE => {
                self.cycle_started_at = Some(start + (now - start).div_euclid(CYCLE) * CYCLE);
                self.upload_bytes = 0;
                self.budget_warning = false;
            }
            _ => {}
        }
    }
    /// Reserve full payload bytes before each actual PUT, including unknown
    /// outcomes and manual attempts. Reconciliation itself does not charge PUT.
    pub fn charge(&mut self, now: i64, bytes: u64, automatic: bool) -> Result<()> {
        self.cycle(now);
        let next = self.upload_bytes.saturating_add(bytes);
        if let Some(plan) = &self.plan {
            self.budget_warning = next >= plan.budget_bytes.saturating_mul(80) / 100;
            if automatic && plan.pause_at_budget && next > plan.budget_bytes {
                self.paused = Some("BUDGET_PAUSED".into());
                return Err(fail("BUDGET_PAUSED"));
            }
        }
        self.upload_bytes = next;
        Ok(())
    }
    /// Caller persists every changed decision before starting work. `previous`
    /// is process-local: reopening or waking never silently catches up.
    pub fn tick(&mut self, now: i64, previous: Option<i64>, job: Option<&Job>) -> Decision {
        let Some(plan) = self.plan.clone() else {
            return Decision::None;
        };
        if self.paused.is_some() {
            return Decision::None;
        }
        if previous.is_some_and(|p| now < p) {
            self.paused = Some("CLOCK_CHANGED".into());
            return Decision::None;
        }
        if let Some(id) = self.pending_job.clone() {
            let Some(job) = job.filter(|j| j.id == id) else {
                self.paused = Some("JOB_CHANGED".into());
                return Decision::None;
            };
            if job.published || job.phase == Phase::Skipped {
                self.message = Some(
                    if job.published {
                        "SUCCEEDED"
                    } else {
                        "UNCHANGED"
                    }
                    .into(),
                );
                self.pending_job = None;
                self.retry_at = None;
            } else if previous.is_none()
                || matches!(job.phase, Phase::Cancelled | Phase::Interrupted)
            {
                self.paused = Some("INTERRUPTED_CONFIRM".into());
                return Decision::None;
            } else if job.phase == Phase::Failed {
                if let Some(at) = self.retry_at {
                    if now >= at {
                        if previous.is_some_and(|p| now - p > GRACE) {
                            self.paused = Some("MISSED_RETRY".into());
                            return Decision::None;
                        }
                        self.retry_at = None;
                        self.retries += 1;
                        return Decision::Retry;
                    }
                    return Decision::None;
                }
                let code = job.error_code.as_deref().unwrap_or("");
                let retryable = [
                    "CLOUD_DAV_Network",
                    "CLOUD_DAV_Timeout",
                    "CLOUD_DAV_RateLimited",
                    "CLOUD_DAV_Server",
                ]
                .iter()
                .any(|prefix| code == *prefix || code == format!("{prefix}_UNKNOWN"));
                if retryable && job.candidate_ready && self.retries < 3 {
                    let delay = 60 * (1i64 << self.retries);
                    let at = (now + delay).max(job.retry_not_before.unwrap_or(0));
                    if at > 253402300799 {
                        self.paused = Some("RETRY_AFTER_TOO_LONG".into());
                        return Decision::None;
                    }
                    self.retry_at = Some(at);
                    self.message = Some("RETRY_WAIT".into());
                } else {
                    self.paused = Some(if retryable {
                        "RETRIES_EXHAUSTED".into()
                    } else {
                        code.into()
                    });
                }
                return Decision::None;
            } else {
                return Decision::None;
            }
        }
        if let Some(slot) = self.next_at.filter(|s| now >= *s) {
            self.next_at = Some(plan.advance(slot, now));
            self.retries = 0;
            if previous.is_none() || previous.is_some_and(|p| now - p > GRACE) || now - slot > GRACE
            {
                self.message = Some("MISSED_MANUAL".into());
                return Decision::None;
            }
            self.message = Some("CHECKING".into());
            return Decision::Start;
        }
        Decision::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> Plan {
        Plan {
            minute: 60,
            every_days: 1,
            utc_offset_minutes: 480,
            budget_bytes: 1_000_000,
            pause_at_budget: true,
        }
    }
    fn state() -> Automatic {
        Automatic {
            plan: Some(plan()),
            next_at: Some(1000),
            ..Default::default()
        }
    }
    #[test]
    fn due_duplicate_reopen_wake_clock_and_cross_date() {
        let mut s = state();
        assert_eq!(s.tick(1000, Some(980), None), Decision::Start);
        assert_eq!(s.tick(1000, Some(1000), None), Decision::None);
        assert_eq!(s.next_at, Some(87400));
        for previous in [None, Some(100)] {
            let mut s = state();
            assert_eq!(s.tick(1010, previous, None), Decision::None);
            assert_eq!(s.message.as_deref(), Some("MISSED_MANUAL"));
        }
        let mut s = state();
        s.tick(900, Some(950), None);
        assert_eq!(s.paused.as_deref(), Some("CLOCK_CHANGED"));
        let p = plan();
        assert_eq!(p.first(0), 61200); // next 01:00 at UTC+08
        assert_eq!(p.advance(1000, 200000), 260200);
        assert_eq!(p.estimate(10), 300);
    }
    #[test]
    fn budget_counts_unknown_attempts_manual_bypasses_pause_and_cycle_is_not_calendar() {
        let mut s = state();
        s.charge(10, 800000, true).unwrap();
        assert!(s.budget_warning);
        assert!(s.charge(20, 300000, true).is_err());
        assert_eq!(s.upload_bytes, 800000);
        s.charge(20, 300000, false).unwrap();
        assert_eq!(s.upload_bytes, 1100000);
        s.cycle(10 + CYCLE - 1);
        assert_eq!(s.upload_bytes, 1100000);
        s.cycle(10 + CYCLE);
        assert_eq!(s.upload_bytes, 0);
        s.charge(5, 100, false).unwrap();
        assert_eq!(s.upload_bytes, 100); // backwards clock cannot reset
    }
}
