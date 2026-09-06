pub struct Args {
    pub probe: bool,
    pub hidden: bool,
    pub quit: bool,
    pub help: bool,
}

pub fn parse() -> Args {
    let mut probe = false;
    let mut hidden = false;
    let mut quit = false;
    let mut help = false;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--probe" => probe = true,
            "--hidden" => hidden = true,
            "--quit" => quit = true,
            "--help" | "-h" => help = true,
            _ => {}
        }
    }
    Args {
        probe,
        hidden,
        quit,
        help,
    }
}

pub fn print_help() {
    println!(
        "Resume Pro Desktop 0.1.0 (D02 shell)

Usage:
  resume-pro-desktop [--hidden] [--probe] [--quit] [--help]

  --probe    Print host status JSON and exit. Does not remain as the unique writer.
  --hidden   Start the unique-writer host without showing the main window.
  --quit     Ask the existing unique-writer process to exit. Do not start a second host.
  --help     Show this message.

Closing the window hides to the tray/menu bar. Use 退出 to quit.
This build does not register Native Messaging, autostart, or reminders.
"
    );
}

/// GUI-subsystem binaries have no console unless we attach one for --probe/--help.
pub fn prepare_stdio() {
    let needs_console = std::env::args().any(|a| a == "--probe" || a == "--help" || a == "-h");
    if !needs_console {
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
    #[test]
    fn help_text_does_not_claim_reminders() {
        let text = include_str!("cli.rs");
        assert!(text.contains("does not register Native Messaging"));
        assert!(text.contains("reminders"));
    }
}
