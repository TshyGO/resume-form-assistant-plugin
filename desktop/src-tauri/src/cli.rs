pub struct Args {
    pub probe: bool,
    pub hidden: bool,
    pub quit: bool,
    pub help: bool,
    pub apps_loop: bool,
    /// Speak the Native Messaging stdio protocol instead of starting the UI.
    pub nm_host: bool,
    /// The calling browser origin, when the browser supplied one.
    pub origin: Option<String>,
}

/// Origin schemes a browser may pass as the caller.
const ORIGIN_SCHEMES: [&str; 2] = ["chrome-extension://", "moz-extension://"];

pub fn parse() -> Args {
    parse_from(std::env::args().collect())
}

/// The Native Messaging manifest has no `args` field, so a browser cannot pass a flag of
/// ours. It launches the executable and passes the calling origin as the first argument
/// after it. Detection therefore scans argv for an origin token.
///
/// `argv[0]` is skipped throughout: it is the executable path, and an install directory
/// containing the scheme must not be read as a caller (ADR 3.7).
pub fn parse_from(argv: Vec<String>) -> Args {
    let mut probe = false;
    let mut hidden = false;
    let mut quit = false;
    let mut help = false;
    let mut apps_loop = false;
    let mut nm_host = false;
    let mut origin = None;
    for arg in argv.iter().skip(1) {
        match arg.as_str() {
            "--probe" => probe = true,
            "--hidden" => hidden = true,
            "--quit" => quit = true,
            "--apps-loop" => apps_loop = true,
            "--nm-host" => nm_host = true,
            "--help" | "-h" => help = true,
            other => {
                if ORIGIN_SCHEMES.iter().any(|s| other.starts_with(s)) {
                    nm_host = true;
                    origin = Some(other.to_string());
                }
            }
        }
    }
    Args {
        probe,
        hidden,
        quit,
        help,
        apps_loop,
        nm_host,
        origin,
    }
}

pub fn print_help() {
    println!(
        "Resume Pro Desktop 0.1.0 (D02 shell)

Usage:
  resume-pro-desktop [--hidden] [--probe] [--apps-loop] [--nm-host] [--quit] [--help]

  --probe      Print host status JSON and exit. Does not remain as the unique writer.
  --hidden     Start the unique-writer host without showing the main window.
  --apps-loop  Run the D04 application-manager persistence loop on an isolated directory and exit.
  --nm-host    Speak the Native Messaging stdio protocol on stdin/stdout. A browser
               selects this mode by passing its origin instead; this flag exists so
               tests can reach it without one.
  --quit       Ask the existing unique-writer process to exit. Do not start a second host.
  --help       Show this message.

Closing the window hides to the tray/menu bar. Use 退出 to quit.
This build does not register Native Messaging, autostart, or reminders.
"
    );
}

/// Native Messaging mode must never attach a console: it would put a stream on stdout,
/// and stdout carries protocol frames only.
///
/// `argv[0]` is skipped for the same reason as in `parse_from` — an executable path is
/// not an argument.
fn wants_console(argv: &[String]) -> bool {
    if parse_from(argv.to_vec()).nm_host {
        return false;
    }
    argv.iter()
        .skip(1)
        .any(|a| a == "--probe" || a == "--help" || a == "-h" || a == "--apps-loop")
}

/// GUI-subsystem binaries have no console unless we attach one for --probe/--help.
pub fn prepare_stdio() {
    if !wants_console(&std::env::args().collect::<Vec<_>>()) {
        return;
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AllocConsole, AttachConsole, ATTACH_PARENT_PROCESS};
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            let _ = AllocConsole();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn help_text_does_not_claim_reminders() {
        let text = include_str!("cli.rs");
        assert!(text.contains("does not register Native Messaging"));
        assert!(text.contains("reminders"));
    }

    #[test]
    fn a_browser_origin_argument_selects_native_messaging_mode() {
        // Chrome passes the calling origin as the first argument after the executable.
        let parsed = parse_from(args(&[
            "resume-pro-desktop.exe",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
        ]));
        assert!(parsed.nm_host);
        assert_eq!(
            parsed.origin.as_deref(),
            Some("chrome-extension://abcdefghijklmnopabcdefghijklmnop/")
        );
    }

    #[test]
    fn a_windows_parent_window_argument_does_not_disturb_detection() {
        let parsed = parse_from(args(&[
            "resume-pro-desktop.exe",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
            "--parent-window=0",
        ]));
        assert!(parsed.nm_host);
    }

    #[test]
    fn a_firefox_origin_also_selects_native_messaging_mode() {
        let parsed = parse_from(args(&[
            "host",
            "moz-extension://11111111-2222-3333-4444-555555555555/",
        ]));
        assert!(parsed.nm_host);
    }

    #[test]
    fn the_executable_path_is_never_read_as_an_origin() {
        // ADR 3.7: argv[0] is the executable path. An install directory containing the
        // scheme must not be mistaken for a caller.
        let parsed = parse_from(args(&[r"C:\apps\chrome-extension://weird\host.exe"]));
        assert!(!parsed.nm_host);
        assert!(parsed.origin.is_none());
    }

    #[test]
    fn the_test_entry_point_selects_the_mode_without_an_origin() {
        let parsed = parse_from(args(&["host", "--nm-host"]));
        assert!(parsed.nm_host);
        assert!(parsed.origin.is_none());
    }

    #[test]
    fn an_ordinary_launch_is_not_native_messaging_mode() {
        assert!(!parse_from(args(&["host"])).nm_host);
        assert!(!parse_from(args(&["host", "--hidden"])).nm_host);
    }

    #[test]
    fn native_messaging_mode_never_attaches_a_console() {
        // A console puts a stream on stdout, and a host whose stdout carries anything but
        // protocol frames fails as an unexplained disconnect in the browser.
        assert!(!wants_console(&args(&["host", "--nm-host"])));
        assert!(!wants_console(&args(&[
            "host",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"
        ])));
        assert!(wants_console(&args(&["host", "--probe"])));
    }

    #[test]
    fn help_lists_the_native_messaging_entry_point() {
        let text = include_str!("cli.rs");
        assert!(text.contains("--nm-host"));
    }
}
