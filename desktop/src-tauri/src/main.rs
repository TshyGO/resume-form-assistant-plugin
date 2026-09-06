#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    resume_pro_desktop_lib::prepare_stdio();
    resume_pro_desktop_lib::run();
}
