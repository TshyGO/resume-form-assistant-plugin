use std::sync::{Condvar, Mutex};
use std::time::Duration;

use data_service::launch_policy::LaunchGuard;
use tauri::{AppHandle, Manager, WindowEvent};

/// Mark the user's intent durably before any cleanup or exit request. Keep the gate
/// locked until process death: a manual reopen must wait for this instance to finish.
pub fn request_quit(app: &AppHandle, reason: &str) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let mut quitting = state
        .quit_guard
        .lock()
        .map_err(|_| "退出状态不可用，请重试。")?;
    if quitting.is_some() {
        return Ok(());
    }
    let paths = state
        .paths
        .lock()
        .map_err(|_| "无法读取数据目录。")?
        .clone()
        .ok_or("无法定位数据目录，未退出。")?;
    let policy = LaunchGuard::acquire(&paths.data_root, Duration::from_secs(3)).and_then(|guard| {
        guard.record_quit()?;
        Ok(guard)
    });
    let policy = policy.map_err(|error| {
        let _ = data_service::write_log(
            &paths,
            "error",
            "APP_QUIT_STATE_FAILED",
            &[("reason", reason)],
        );
        if error.kind() == std::io::ErrorKind::WouldBlock {
            "程序正在处理启动或退出，请稍后重试。".to_string()
        } else {
            "无法保存退出状态，软件暂未退出。请检查数据目录权限和磁盘空间后重试。".to_string()
        }
    })?;
    *quitting = Some(policy);
    let _ = data_service::write_log(&paths, "info", "APP_QUIT", &[("reason", reason)]);
    if let Err(error) = crate::todo_commands::cancel_all_reminders(state.reminders.as_ref()) {
        let _ = data_service::write_log(
            &paths,
            "error",
            "REMINDER_CANCEL_FAILED",
            &[("at", reason), ("code", &error.code)],
        );
    }
    app.exit(0);
    Ok(())
}

pub fn quit_or_report(app: &AppHandle, reason: &str) {
    if let Err(message) = request_quit(app, reason) {
        use tauri_plugin_dialog::DialogExt;
        app.dialog()
            .message(message)
            .title("无法退出")
            .kind(tauri_plugin_dialog::MessageDialogKind::Error)
            .show(|_| {});
    }
}

/// Whether the main window has been built.
///
/// It is built after the archive and the browser's endpoint are up, and on Windows building
/// it waits for WebView2, so on a cold start a request to show it can arrive first.
#[derive(Default)]
pub struct MainWindowReady {
    ready: Mutex<bool>,
    became_ready: Condvar,
}

impl MainWindowReady {
    pub fn set(&self) {
        *self.ready.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        self.became_ready.notify_all();
    }

    /// Wait up to `budget` for the window. False if it is still not built by then.
    pub fn wait(&self, budget: Duration) -> bool {
        let ready = self.ready.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (ready, _) = self
            .became_ready
            .wait_timeout_while(ready, budget, |ready| !*ready)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *ready
    }
}

/// The view the browser last asked the window for, kept until the page takes it.
///
/// The navigation event reaches only a page that is already listening. On a cold start the
/// request comes before the page has loaded, so the page takes it once it listens (#183).
#[derive(Default)]
pub struct RequestedView(Mutex<Option<String>>);

impl RequestedView {
    pub fn request(&self, view: &str) {
        *self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(view.to_string());
    }

    pub fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take()
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
}

pub fn hide_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

pub fn install_window_close_handler(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let handle = app.clone();
        win.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_main_window(&handle);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn a_wait_ends_as_soon_as_the_window_is_built() {
        let window = Arc::new(MainWindowReady::default());
        let builder = {
            let window = Arc::clone(&window);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                window.set();
            })
        };
        let started = Instant::now();
        assert!(window.wait(Duration::from_secs(30)));
        assert!(started.elapsed() < Duration::from_secs(10), "it must not run out the budget");
        builder.join().unwrap();
    }

    #[test]
    fn a_built_window_is_not_waited_for() {
        let window = MainWindowReady::default();
        window.set();
        assert!(window.wait(Duration::ZERO));
    }

    #[test]
    fn a_requested_view_is_taken_once() {
        let requested = RequestedView::default();
        assert_eq!(requested.take(), None);
        requested.request("resume");
        assert_eq!(requested.take().as_deref(), Some("resume"));
        assert_eq!(requested.take(), None, "a page that reloads must not be sent there again");
    }

    #[test]
    fn the_latest_request_wins() {
        let requested = RequestedView::default();
        requested.request("resume");
        requested.request("settings-ai");
        assert_eq!(requested.take().as_deref(), Some("settings-ai"));
    }

    #[test]
    fn the_wait_gives_up_at_the_budget() {
        let window = MainWindowReady::default();
        let started = Instant::now();
        assert!(!window.wait(Duration::from_millis(100)));
        assert!(started.elapsed() >= Duration::from_millis(100));
    }
}
