//! 兜底实现：这台机器上弹不了定时通知。
//!
//! 它存在的意义是**把「做不到」变成一个能显示给用户的句子**，而不是让上层
//! 拿到一个看起来成功的结果。产品需求 §5.4 要求界面能区分「未授权」「已退出」
//! 「平台不支持」，靠的就是这里带回去的 `reason`。

use crate::{Capability, ReminderError, ReminderRequest, ReminderScheduler, ScheduledHandle};

#[derive(Debug, Clone)]
pub struct Unsupported {
    reason: String,
}

impl Unsupported {
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

impl ReminderScheduler for Unsupported {
    fn capability(&self) -> Capability {
        Capability::Unavailable {
            reason: self.reason.clone(),
        }
    }

    fn schedule(&self, _request: &ReminderRequest) -> Result<ScheduledHandle, ReminderError> {
        Err(ReminderError::Unavailable(self.reason.clone()))
    }

    // 没登记过就没有要撤的，说成功是老实话：调用方要的是「之后不会再弹」。
    fn cancel(&self, _handle: &ScheduledHandle) -> Result<(), ReminderError> {
        Ok(())
    }

    fn cancel_all(&self) -> Result<(), ReminderError> {
        Ok(())
    }
}
