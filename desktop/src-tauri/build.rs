fn main() {
    println!("cargo:rerun-if-env-changed=RESUME_USAGE_METRICS_READY");
    println!("cargo:rerun-if-env-changed=RESUME_USAGE_METRICS_ENDPOINT");
    println!("cargo:rerun-if-env-changed=CI");
    tauri_build::build()
}
