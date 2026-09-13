//! Windows：把到期登记成**计划 Toast**，进程退出之后由系统负责弹。
//!
//! 用的是 `ScheduledToastNotification` + `AddToSchedule`（ADR §3.8 指定）。
//!
//! 这条路在本机实测过（2026-09-13，Windows 11 26200，结论回填进 ADR §3.8）：
//!
//! - `CreateToastNotifierWithId` 对**没有注册过的 AUMID 直接抛「无效的
//!   applicationId」**。所以能力检查就是这一次调用，不需要去猜快捷方式在不在。
//!   AUMID 由安装器写进开始菜单快捷方式（D13 / issue #29）；开发时直接跑没有它，
//!   这里会如实返回 `Unavailable`，**不假装登记成功**。
//! - 登记之后**计划脱离登记它的进程**：原进程退出后，另一个进程仍能列出这条计划；
//!   到点后它从计划列表里消失并出现在通知中心。这正是 ADR 要求验证的那一条。
//! - **勿扰 / 专注助手会压掉横幅**，通知照样进通知中心。所以「没弹出来」不等于
//!   「没送到」，界面措辞不要把两者混为一谈。
//! - 官方说明计划通知有大约 **5 分钟的投递窗口**，关机时间过长可能被丢弃。这条
//!   要写进界面文案，不得承诺「关机期间也一定送到」。

use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::DateTime as WinDateTime;
use windows::UI::Notifications::{
    NotificationSetting, ScheduledToastNotification, ToastNotificationManager,
};

use crate::{Capability, ReminderError, ReminderRequest, ReminderScheduler, ScheduledHandle};

/// 应用用户模型 ID。**必须和安装器写进开始菜单快捷方式的那个一致**，
/// 否则系统认不出这些通知是谁的（D13 / #29）。
pub const AUMID: &str = "TshyGO.ResumePro.Desktop";

/// 本应用登记的全部计划通知共用一个 group，退出时靠它一次撤干净。
const GROUP: &str = "resume-pro-todos";

/// 1601-01-01 到 1970-01-01 之间的秒数。WinRT 的 `DateTime` 以 100 纳秒为单位、
/// 从 1601 起算。
const EPOCH_DIFFERENCE_SECONDS: i64 = 11_644_473_600;

pub struct WindowsToasts;

impl WindowsToasts {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WindowsToasts {
    fn default() -> Self {
        Self::new()
    }
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 通知的 XML。只有标题和一行正文——公司、岗位、待办标题，没有别的
/// （data-privacy §4：锁屏上会显示，不许带简历或邮件正文）。
fn toast_xml(request: &ReminderRequest) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\">\
         <text>{}</text><text>{}</text>\
         </binding></visual></toast>",
        escape_xml(&request.notification_title()),
        escape_xml(&request.title),
    )
}

fn to_win_datetime(unix_seconds: i64) -> WinDateTime {
    WinDateTime {
        UniversalTime: (unix_seconds + EPOCH_DIFFERENCE_SECONDS) * 10_000_000,
    }
}

fn platform(e: windows::core::Error) -> ReminderError {
    ReminderError::Platform(e.message().to_string())
}

impl ReminderScheduler for WindowsToasts {
    fn capability(&self) -> Capability {
        // 实测：AUMID 没注册过时这一步就抛「无效的 applicationId」，所以它本身
        // 就是最准的能力检查——比去猜快捷方式文件在不在可靠。
        match ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID)) {
            Ok(notifier) => match notifier.Setting() {
                // 用户在系统设置里关掉了本应用的通知。
                Ok(NotificationSetting::DisabledForApplication) => Capability::Unavailable {
                    reason: "系统设置里关掉了这个应用的通知。打开之后到期才会提醒。".into(),
                },
                Ok(NotificationSetting::DisabledForUser) => Capability::Unavailable {
                    reason: "系统设置里关掉了通知。打开之后到期才会提醒。".into(),
                },
                Ok(NotificationSetting::DisabledByGroupPolicy)
                | Ok(NotificationSetting::DisabledByManifest) => Capability::Unavailable {
                    reason: "系统策略禁用了通知，这台机器上到期不会提醒。".into(),
                },
                _ => Capability::Available,
            },
            Err(_) => Capability::Unavailable {
                reason: "还没安装到开始菜单，Windows 不会投递定时提醒；用安装包装一次之后就会。"
                    .into(),
            },
        }
    }

    fn schedule(&self, request: &ReminderRequest) -> Result<ScheduledHandle, ReminderError> {
        if let Capability::Unavailable { reason } = self.capability() {
            return Err(ReminderError::Unavailable(reason));
        }

        let xml = XmlDocument::new().map_err(platform)?;
        xml.LoadXml(&HSTRING::from(toast_xml(request)))
            .map_err(platform)?;

        let at = to_win_datetime(request.fire_at.utc.unix_timestamp());
        let scheduled =
            ScheduledToastNotification::CreateScheduledToastNotification(&xml, at).map_err(platform)?;

        // tag 有长度和字符限制，用待办 id 的前 16 位（UUID 的前缀已经足够唯一）。
        let tag = request.todo_id.replace('-', "");
        let tag = &tag[..tag.len().min(16)];
        scheduled.SetTag(&HSTRING::from(tag)).map_err(platform)?;
        scheduled.SetGroup(&HSTRING::from(GROUP)).map_err(platform)?;

        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
            .map_err(platform)?
            .AddToSchedule(&scheduled)
            .map_err(platform)?;

        Ok(ScheduledHandle::new(tag))
    }

    fn cancel(&self, handle: &ScheduledHandle) -> Result<(), ReminderError> {
        let Ok(notifier) = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
        else {
            // 拿不到通知器就没有计划可撤，调用方要的「之后不会再弹」是成立的。
            return Ok(());
        };
        let Ok(pending) = notifier.GetScheduledToastNotifications() else {
            return Ok(());
        };
        for item in pending {
            let matches = item
                .Tag()
                .map(|tag| tag.to_string_lossy() == handle.as_str())
                .unwrap_or(false);
            if matches {
                notifier.RemoveFromSchedule(&item).map_err(platform)?;
            }
        }
        Ok(())
    }

    fn cancel_all(&self) -> Result<(), ReminderError> {
        let Ok(notifier) = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
        else {
            return Ok(());
        };
        let Ok(pending) = notifier.GetScheduledToastNotifications() else {
            return Ok(());
        };
        for item in pending {
            let ours = item
                .Group()
                .map(|group| group.to_string_lossy() == GROUP)
                .unwrap_or(false);
            if ours {
                notifier.RemoveFromSchedule(&item).map_err(platform)?;
            }
        }
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
            todo_id: "11111111-2222-4333-8444-555555555555".into(),
            title: "一面 <script>".into(),
            company: Some("合成 & 公司".into()),
            position: Some("后端".into()),
            fire_at: fire_at(
                &Due::DateTime("2026-09-14T02:00:00Z".into()),
                None,
                None,
                time!(09:00),
                UtcOffset::UTC,
            )
            .unwrap()
            .unwrap(),
        }
    }

    #[test]
    fn the_toast_xml_escapes_everything_the_user_typed() {
        let xml = toast_xml(&request());
        assert!(xml.contains("&lt;script&gt;"), "{xml}");
        assert!(xml.contains("&amp;"), "{xml}");
        assert!(!xml.contains("<script>"), "{xml}");
    }

    #[test]
    fn the_toast_carries_nothing_but_the_company_role_and_title() {
        let xml = toast_xml(&request());
        assert!(xml.contains("合成 &amp; 公司 · 后端"));
        assert!(xml.contains("一面"));
        // 两个 text 节点，不多不少。
        assert_eq!(xml.matches("<text>").count(), 2, "{xml}");
    }

    #[test]
    fn the_windows_epoch_conversion_matches_a_known_instant() {
        // 1970-01-01T00:00:00Z 就是两个纪元之间的差值。
        assert_eq!(
            to_win_datetime(0).UniversalTime,
            EPOCH_DIFFERENCE_SECONDS * 10_000_000
        );
        // 往后一秒就是多一千万个 100 纳秒。
        assert_eq!(
            to_win_datetime(1).UniversalTime - to_win_datetime(0).UniversalTime,
            10_000_000
        );
    }

    #[test]
    fn an_unregistered_aumid_is_reported_as_unavailable_not_as_scheduled() {
        // 开发机（以及 CI）上没装过安装包，AUMID 没注册，能力检查必须说不行；
        // 装过的机器上走另一条分支。两种情况都不能是「登记成功但什么都不弹」。
        let scheduler = WindowsToasts::new();
        match scheduler.capability() {
            Capability::Unavailable { reason } => {
                assert!(!reason.trim().is_empty(), "说不行就要说得出为什么");
                assert!(
                    scheduler.schedule(&request()).is_err(),
                    "不可用的时候登记必须失败，上层才会记成 unsupported"
                );
            }
            Capability::Available => {
                // 真装过的机器：登记与撤销要能走通，并且给回一个非空句柄。
                let handle = scheduler.schedule(&request()).unwrap();
                assert!(!handle.as_str().is_empty());
                scheduler.cancel(&handle).unwrap();
            }
        }
    }
}
