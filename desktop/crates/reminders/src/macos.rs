//! macOS：把到期登记成 `UNCalendarNotificationTrigger`，由系统在当地墙钟时间投递。
//!
//! 和 Windows 那边的关键差别：这里交给系统的是**墙钟分量**（几月几号几点几分），
//! 夏令时由系统自己处理；Windows 收的是绝对时刻，得我们算。所以 [`crate::FireAt`]
//! 两样都带，各取所需。
//!
//! **未打包运行时不可用。** `UNUserNotificationCenter::currentNotificationCenter()`
//! 在没有 bundle identifier 的进程里会直接崩，所以下面每条路径都先看有没有 bundle
//! id，没有就返回 `Unavailable` —— 开发时 `cargo run` 出来的二进制正是这种情况。
//!
//! **本文件没有在真机上验证过。** CI 只保证它在 macOS 上编得过。授权弹窗、投递、
//! 重启后是否还在，都要等有 Mac 的时候按 D10 的走查跑一遍（issue #26；和 #16 卡的
//! 是同一件事）。在那之前不要在任何地方说 macOS 的提醒「已经能用」。

use block2::RcBlock;
use objc2_foundation::{NSArray, NSBundle, NSCalendar, NSDate, NSDateComponents, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNCalendarNotificationTrigger, UNMutableNotificationContent,
    UNNotificationRequest, UNUserNotificationCenter,
};

use crate::{Capability, ReminderError, ReminderRequest, ReminderScheduler, ScheduledHandle};

pub struct MacCalendarNotifications;

impl MacCalendarNotifications {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MacCalendarNotifications {
    fn default() -> Self {
        Self::new()
    }
}

/// 有没有 bundle identifier。没有就说明这是个裸二进制（`cargo run`），
/// 碰 `UNUserNotificationCenter` 会崩，必须提前拦住。
fn bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

const UNBUNDLED: &str =
    "开发运行（未打包成 .app）时 macOS 不提供定时通知；装成应用之后才会提醒。";

fn components_for(request: &ReminderRequest) -> objc2::rc::Retained<NSDateComponents> {
    let wall = request.fire_at.wall_clock;
    let components = unsafe { NSDateComponents::new() };
    unsafe {
        components.setYear(wall.year() as isize);
        components.setMonth(u8::from(wall.month()) as isize);
        components.setDay(wall.day() as isize);
        components.setHour(wall.hour() as isize);
        components.setMinute(wall.minute() as isize);
        components.setSecond(0);
    }
    components
}

impl ReminderScheduler for MacCalendarNotifications {
    fn capability(&self) -> Capability {
        if !bundled() {
            return Capability::Unavailable {
                reason: UNBUNDLED.into(),
            };
        }
        Capability::Available
    }

    fn schedule(&self, request: &ReminderRequest) -> Result<ScheduledHandle, ReminderError> {
        if !bundled() {
            return Err(ReminderError::Unavailable(UNBUNDLED.into()));
        }

        let center = UNUserNotificationCenter::currentNotificationCenter();

        // 授权只要一次；系统会记住用户的选择，这里不阻塞等待结果——没授权的话
        // 下面的 add 会失败，照样走「登记不上」那条路，不会假装成功。
        let noop = RcBlock::new(|_granted: objc2::runtime::Bool, _error: *mut objc2_foundation::NSError| {});
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &noop,
        );

        let content = unsafe { UNMutableNotificationContent::new() };
        unsafe {
            content.setTitle(&NSString::from_str(&request.notification_title()));
            content.setBody(&NSString::from_str(&request.title));
        }

        let trigger = UNCalendarNotificationTrigger::triggerWithDateMatchingComponents_repeats(
            &components_for(request),
            false,
        );

        let identifier = NSString::from_str(&request.todo_id);
        let notification = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier,
            &content,
            Some(&trigger),
        );

        center.addNotificationRequest_withCompletionHandler(&notification, None);
        Ok(ScheduledHandle::new(request.todo_id.clone()))
    }

    fn cancel(&self, handle: &ScheduledHandle) -> Result<(), ReminderError> {
        if !bundled() {
            // 没登记过就没有要撤的，说成功是老实话。
            return Ok(());
        }
        let ids = NSArray::from_retained_slice(&[NSString::from_str(handle.as_str())]);
        UNUserNotificationCenter::currentNotificationCenter()
            .removePendingNotificationRequestsWithIdentifiers(&ids);
        Ok(())
    }

    fn cancel_all(&self) -> Result<(), ReminderError> {
        if !bundled() {
            return Ok(());
        }
        UNUserNotificationCenter::currentNotificationCenter().removeAllPendingNotificationRequests();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{fire_at, Due};
    use time::macros::time;
    use time::UtcOffset;

    fn request() -> ReminderRequest {
        ReminderRequest {
            todo_id: "todo-1".into(),
            title: "一面".into(),
            company: Some("合成公司".into()),
            position: Some("后端".into()),
            fire_at: fire_at(
                &Due::Date("2026-09-20".into()),
                Some("Asia/Shanghai"),
                None,
                time!(09:00),
                UtcOffset::UTC,
            )
            .unwrap()
            .unwrap(),
        }
    }

    #[test]
    fn the_calendar_trigger_uses_local_wall_clock_not_utc() {
        // 上海 9 月 20 日早九点。交给系统的必须是「9-20 09:00」这个墙钟，
        // 不是 UTC 的 01:00——否则 macOS 会在当地下午五点提醒。
        let components = components_for(&request());
        unsafe {
            assert_eq!(components.year(), 2026);
            assert_eq!(components.month(), 9);
            assert_eq!(components.day(), 20);
            assert_eq!(components.hour(), 9);
            assert_eq!(components.minute(), 0);
        }
    }

    #[test]
    fn an_unbundled_binary_reports_unavailable_instead_of_crashing() {
        // cargo test 出来的就是裸二进制，没有 bundle id。
        let scheduler = MacCalendarNotifications::new();
        if !bundled() {
            assert!(matches!(scheduler.capability(), Capability::Unavailable { .. }));
            assert!(scheduler.schedule(&request()).is_err());
            // 撤销仍然是成功的：调用方要的是「之后不会再弹」。
            assert!(scheduler.cancel(&ScheduledHandle::new("todo-1")).is_ok());
            assert!(scheduler.cancel_all().is_ok());
        }
    }
}
