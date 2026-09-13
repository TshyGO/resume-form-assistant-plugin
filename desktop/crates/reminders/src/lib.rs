//! 待办提醒的登记与撤销（D10）。
//!
//! 这个 crate 只认三个动词：能不能提醒、登记一条、撤销一条。它不知道待办是什么、
//! 不碰数据库、不依赖 Tauri，因此时间语义那部分可以用普通 `cargo test` 覆盖。
//!
//! **这就是 issue #81 要求留的那道缝。** 今天唯一的实现是操作系统的本地通知；
//! 以后要往邮件或者飞书机器人推，是在这里多写一个 [`ReminderScheduler`]，不是
//! 回头去改命令层。所以命令层和前端不该出现 `Toast` 这类词——它们只说
//! 「登记 / 撤销某条待办的提醒」。

pub mod plan;

mod unsupported;
pub use unsupported::Unsupported;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::WindowsToasts;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::MacCalendarNotifications;

pub use plan::{fire_at, is_past, to_storage, Due, FireAt, PlanError};

/// 要提醒的内容。
///
/// 时刻在进来之前就已经算好了（见 [`plan::fire_at`]），平台实现不做时间语义。
///
/// 字段刻意只有这些：标题是公司加岗位，正文是待办标题。**不带**简历正文、
/// 邮件正文或证据摘录——通知会出现在锁屏上，data-privacy §4 与走查 10.11
/// 都要求这里最小化。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderRequest {
    pub todo_id: String,
    /// 待办标题，进通知正文。
    pub title: String,
    pub company: Option<String>,
    pub position: Option<String>,
    pub fire_at: FireAt,
}

impl ReminderRequest {
    /// 通知标题：公司 + 岗位，都没有就退回应用名。
    pub fn notification_title(&self) -> String {
        match (self.company.as_deref(), self.position.as_deref()) {
            (Some(c), Some(p)) if !c.is_empty() && !p.is_empty() => format!("{c} · {p}"),
            (Some(c), _) if !c.is_empty() => c.to_string(),
            (_, Some(p)) if !p.is_empty() => p.to_string(),
            _ => "Resume Pro".to_string(),
        }
    }
}

/// OS 侧的句柄，原样存进 `todos.reminder_handle`。
///
/// 内容由平台实现自己定（Windows 是 tag/group，macOS 是 request identifier），
/// 上层只负责存下来再传回来——改期时要靠它撤销上一次登记的那条。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledHandle(String);

impl ScheduledHandle {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

/// 这台机器现在能不能弹提醒。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Capability {
    Available,
    /// 做不到，`reason` 是可以直接显示给用户的一句话。
    ///
    /// 未授权、平台不支持、未打包——都走这条。**不允许**用「假装登记成功」
    /// 代替它：界面必须能如实说出提醒现在不会响（产品需求 §5.4）。
    Unavailable { reason: String },
}

impl Capability {
    pub fn is_available(&self) -> bool {
        matches!(self, Capability::Available)
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            Capability::Available => None,
            Capability::Unavailable { reason } => Some(reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReminderError {
    /// 这台机器做不到，原因同 [`Capability::Unavailable`]。
    Unavailable(String),
    /// 时刻算不出来。
    Plan(PlanError),
    /// 平台调用失败。
    Platform(String),
}

impl std::fmt::Display for ReminderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReminderError::Unavailable(r) => write!(f, "{r}"),
            ReminderError::Plan(e) => write!(f, "{e}"),
            ReminderError::Platform(e) => write!(f, "系统通知登记失败：{e}"),
        }
    }
}

impl std::error::Error for ReminderError {}

impl From<PlanError> for ReminderError {
    fn from(value: PlanError) -> Self {
        ReminderError::Plan(value)
    }
}

pub trait ReminderScheduler: Send + Sync {
    fn capability(&self) -> Capability;

    /// 登记一条。失败要返回错误，**不许**静默当成功——上层会据此把
    /// `reminder_state` 记成 `unsupported` 而不是 `scheduled`。
    fn schedule(&self, request: &ReminderRequest) -> Result<ScheduledHandle, ReminderError>;

    /// 撤销一条。句柄对应的计划已经不在了（已经弹过、被系统清掉）算成功：
    /// 调用方要的是「之后不会再弹」这个结果。
    fn cancel(&self, handle: &ScheduledHandle) -> Result<(), ReminderError>;

    /// 撤销这个应用登记的全部未触发计划。主动退出时调（产品需求 §5.4）。
    fn cancel_all(&self) -> Result<(), ReminderError>;
}

/// 当前平台的实现。
///
/// 平台实现在后续 PR 里填（Windows 计划 Toast、macOS 日历触发）。在那之前，
/// 以及在没有实现的平台上，返回的是会如实说明原因的 [`Unsupported`]。
pub fn scheduler() -> Box<dyn ReminderScheduler> {
    #[cfg(windows)]
    {
        Box::new(WindowsToasts::new())
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(MacCalendarNotifications::new())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Box::new(Unsupported::new(
            "这个系统上还没有接入定时通知，待办和逾期汇总照常可用。",
        ))
    }
}
