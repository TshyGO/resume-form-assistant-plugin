use std::sync::{Condvar, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, WindowEvent};

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
    fn the_wait_gives_up_at_the_budget() {
        let window = MainWindowReady::default();
        let started = Instant::now();
        assert!(!window.wait(Duration::from_millis(100)));
        assert!(started.elapsed() >= Duration::from_millis(100));
    }
}
