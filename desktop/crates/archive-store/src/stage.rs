//! 阶段模型与折叠函数(产品需求 §6.1/§6.2,冻结)。
//!
//! `currentStage` 按 `eventSequence` 升序折叠,并在写入那条事件的同一事务内更新。
//! `recordedAt`/`occurredAt` 只表示时间,不参与折叠并列打破。

use serde::{Deserialize, Serialize};

pub const ALL_STAGES: &[Stage] = &[
    Stage::Saved,
    Stage::Filling,
    Stage::Submitted,
    Stage::Assessment,
    Stage::Interview,
    Stage::Offer,
    Stage::Rejected,
    Stage::Withdrawn,
    Stage::Closed,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Saved,
    Filling,
    Submitted,
    Assessment,
    Interview,
    Offer,
    Rejected,
    Withdrawn,
    Closed,
}

impl Stage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Stage::Saved => "saved",
            Stage::Filling => "filling",
            Stage::Submitted => "submitted",
            Stage::Assessment => "assessment",
            Stage::Interview => "interview",
            Stage::Offer => "offer",
            Stage::Rejected => "rejected",
            Stage::Withdrawn => "withdrawn",
            Stage::Closed => "closed",
        }
    }

    pub fn parse(s: &str) -> Option<Stage> {
        ALL_STAGES.iter().copied().find(|st| st.as_str() == s)
    }

    fn is_terminated(&self) -> bool {
        matches!(self, Stage::Offer | Stage::Rejected | Stage::Withdrawn | Stage::Closed)
    }
}

impl std::fmt::Display for Stage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 阶段相关事件 payload 持久化的更新模式(§6.2 历史补录约束)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StageUpdateMode {
    /// 导入通知与历史补录默认:仍分配 eventSequence,但所有阶段效应为 no-op。
    #[default]
    HistoryOnly,
    /// 用户明确选择更新当前进度时使用,应用折叠表。
    UpdateProgress,
}

/// 一次折叠的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fold {
    /// 投影为新阶段。
    To(Stage),
    /// 保持不变。
    NoOp,
}

/// `submit_confirmed` 可进入的当前阶段集合。
const SUBMIT_FROM: &[Stage] = &[Stage::Saved, Stage::Filling];
/// fill_completed / fill_partial 的 advance 集合:仅 saved → filling。
const FILL_ADVANCE_FROM: &[Stage] = &[Stage::Saved];
/// assessment_recorded 显式推进集合。
const ASSESS_FROM: &[Stage] = &[Stage::Saved, Stage::Filling, Stage::Submitted, Stage::Assessment];
/// interview_recorded 显式推进集合。
const INTERVIEW_FROM: &[Stage] = &[
    Stage::Saved,
    Stage::Filling,
    Stage::Submitted,
    Stage::Assessment,
    Stage::Interview,
];
/// interview_rescheduled 集合(从拒绝等恢复须 stage_corrected)。
const RESCHEDULE_FROM: &[Stage] = &[Stage::Saved, Stage::Filling, Stage::Submitted, Stage::Assessment];

/// 单个事件的折叠效应(§6.2 表)。`mode` 只对"阶段相关事件"有意义;
/// `history_only` 时所有阶段效应均为 no-op。
///
/// 注意:`stage_corrected` 是显式纠正,**不受** `history_only` 影响——
/// 它本身就是用户明确的阶段操作,作为 set-absolute 应用。
pub fn fold_stage(current: Stage, event_type: &str, mode: StageUpdateMode, payload_to: Option<Stage>) -> Fold {
    match event_type {
        "application_created" => Fold::To(Stage::Saved),
        "application_updated" | "fill_started" | "fill_failed" | "fill_cancelled"
        | "evidence_imported" | "evidence_associated" | "association_changed" | "evidence_classified"
        | "note_added" | "todo_created" | "todo_completed" | "todo_cancelled" => Fold::NoOp,
        "job_saved" => {
            if matches!(current, Stage::Saved) || current_is_initially_empty(current) {
                Fold::To(Stage::Saved)
            } else {
                Fold::NoOp
            }
        }
        "fill_completed" | "fill_partial" => {
            if mode == StageUpdateMode::HistoryOnly {
                Fold::NoOp
            } else if FILL_ADVANCE_FROM.contains(&current) {
                Fold::To(Stage::Filling)
            } else {
                Fold::NoOp
            }
        }
        "submit_confirmed" => {
            if mode == StageUpdateMode::HistoryOnly {
                Fold::NoOp
            } else if SUBMIT_FROM.contains(&current) {
                Fold::To(Stage::Submitted)
            } else {
                Fold::NoOp
            }
        }
        "assessment_recorded" => {
            if mode == StageUpdateMode::HistoryOnly {
                Fold::NoOp
            } else if ASSESS_FROM.contains(&current) {
                Fold::To(Stage::Assessment)
            } else {
                Fold::NoOp
            }
        }
        "interview_recorded" => {
            if mode == StageUpdateMode::HistoryOnly {
                Fold::NoOp
            } else if INTERVIEW_FROM.contains(&current) {
                Fold::To(Stage::Interview)
            } else {
                Fold::NoOp
            }
        }
        "interview_rescheduled" => {
            if mode == StageUpdateMode::HistoryOnly {
                Fold::NoOp
            } else if RESCHEDULE_FROM.contains(&current) {
                Fold::To(Stage::Interview)
            } else {
                Fold::NoOp
            }
        }
        "offer_recorded" => apply_absolute(mode, current, Stage::Offer),
        "rejected" => apply_absolute(mode, current, Stage::Rejected),
        "withdrawn" => apply_absolute(mode, current, Stage::Withdrawn),
        "closed" => apply_absolute(mode, current, Stage::Closed),
        "stage_corrected" => match payload_to {
            Some(to) => Fold::To(to),
            // payload 缺 to:载荷校验在写入入口完成;此处防御性 no-op。
            None => Fold::NoOp,
        },
        // D03 增补的自定义事件默认不改阶段。
        _ => Fold::NoOp,
    }
}

fn apply_absolute(mode: StageUpdateMode, current: Stage, target: Stage) -> Fold {
    if mode == StageUpdateMode::HistoryOnly {
        Fold::NoOp
    } else {
        // set-absolute:无论当前是什么阶段(包括终止态)都设为目标。
        // 「Offer 后补录旧测评不回退」由 assessment/interview 的集合约束保证,
        // 而非这里——这里只处理显式 set-absolute 类型。
        let _ = current;
        Fold::To(target)
    }
}

fn current_is_initially_empty(current: Stage) -> bool {
    // 防御:行已创建则 current 不会为空;保留语义说明。
    let _ = current;
    false
}

/// 纠正目标合法性:任意阶段到任意阶段都允许,但必须带原因(写入入口校验)。
pub fn correction_allowed(_from: Stage, to: Stage) -> Result<(), String> {
    if Stage::parse(to.as_str()).is_none() {
        return Err(format!("unknown target stage `{}`", to.as_str()));
    }
    Ok(())
}

/// 折叠表自检:关键反例(冻结规则)。
#[cfg(test)]
mod tests {
    use super::*;

    fn fold(cur: Stage, ev: &str, mode: StageUpdateMode) -> Fold {
        fold_stage(cur, ev, mode, None)
    }

    #[test]
    fn fill_never_reaches_submitted() {
        assert_eq!(fold(Stage::Saved, "fill_completed", StageUpdateMode::UpdateProgress), Fold::To(Stage::Filling));
        assert_eq!(fold(Stage::Filling, "fill_completed", StageUpdateMode::UpdateProgress), Fold::NoOp);
        assert_eq!(fold(Stage::Saved, "fill_partial", StageUpdateMode::UpdateProgress), Fold::To(Stage::Filling));
        assert_eq!(fold(Stage::Saved, "fill_failed", StageUpdateMode::UpdateProgress), Fold::NoOp);
        // 绝不 → submitted
        assert_ne!(fold(Stage::Saved, "fill_completed", StageUpdateMode::UpdateProgress), Fold::To(Stage::Submitted));
    }

    #[test]
    fn submit_only_from_saved_or_filling() {
        assert_eq!(fold(Stage::Saved, "submit_confirmed", StageUpdateMode::UpdateProgress), Fold::To(Stage::Submitted));
        assert_eq!(fold(Stage::Filling, "submit_confirmed", StageUpdateMode::UpdateProgress), Fold::To(Stage::Submitted));
        assert_eq!(fold(Stage::Interview, "submit_confirmed", StageUpdateMode::UpdateProgress), Fold::NoOp);
        assert_eq!(fold(Stage::Rejected, "submit_confirmed", StageUpdateMode::UpdateProgress), Fold::NoOp);
    }

    #[test]
    fn history_only_is_noop() {
        for ev in ["fill_completed", "submit_confirmed", "assessment_recorded", "interview_recorded", "offer_recorded", "rejected"] {
            assert_eq!(fold(Stage::Saved, ev, StageUpdateMode::HistoryOnly), Fold::NoOp, "{ev}");
            assert_eq!(fold(Stage::Submitted, ev, StageUpdateMode::HistoryOnly), Fold::NoOp, "{ev}");
        }
    }

    #[test]
    fn offer_later_backfill_assessment_no_regress() {
        // Offer 后补录旧测评:显式推进也不得从 offer 回到 assessment。
        assert_eq!(fold(Stage::Offer, "assessment_recorded", StageUpdateMode::UpdateProgress), Fold::NoOp);
        assert_eq!(fold(Stage::Offer, "interview_recorded", StageUpdateMode::UpdateProgress), Fold::NoOp);
        // 从终止阶段恢复须 stage_corrected。
        assert_eq!(
            fold_stage(Stage::Rejected, "stage_corrected", StageUpdateMode::HistoryOnly, Some(Stage::Interview)),
            Fold::To(Stage::Interview)
        );
    }

    #[test]
    fn reschedule_rules() {
        assert_eq!(fold(Stage::Assessment, "interview_rescheduled", StageUpdateMode::UpdateProgress), Fold::To(Stage::Interview));
        assert_eq!(fold(Stage::Rejected, "interview_rescheduled", StageUpdateMode::UpdateProgress), Fold::NoOp);
        assert_eq!(fold(Stage::Interview, "interview_rescheduled", StageUpdateMode::UpdateProgress), Fold::NoOp);
    }

    #[test]
    fn job_saved_never_regress() {
        assert_eq!(fold(Stage::Saved, "job_saved", StageUpdateMode::UpdateProgress), Fold::To(Stage::Saved));
        assert_eq!(fold(Stage::Submitted, "job_saved", StageUpdateMode::UpdateProgress), Fold::NoOp);
    }

    #[test]
    fn set_absolute_types() {
        assert_eq!(fold(Stage::Saved, "offer_recorded", StageUpdateMode::UpdateProgress), Fold::To(Stage::Offer));
        assert_eq!(fold(Stage::Offer, "rejected", StageUpdateMode::UpdateProgress), Fold::To(Stage::Rejected));
        assert_eq!(fold(Stage::Rejected, "withdrawn", StageUpdateMode::UpdateProgress), Fold::To(Stage::Withdrawn));
        assert_eq!(fold(Stage::Interview, "closed", StageUpdateMode::UpdateProgress), Fold::To(Stage::Closed));
    }
}
