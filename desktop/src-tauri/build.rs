fn main() {
    println!("cargo:rerun-if-env-changed=RESUME_USAGE_METRICS_READY");
    println!("cargo:rerun-if-env-changed=RESUME_USAGE_METRICS_ENDPOINT");
    println!("cargo:rerun-if-env-changed=RESUME_USAGE_METRICS_RELEASE_BUILD");
    println!("cargo:rerun-if-env-changed=CI");
    println!("cargo:rerun-if-env-changed=RESUME_USAGE_METRICS_ACCEPTANCE_BUILD");
    println!("cargo:rerun-if-env-changed=RESUME_MICROSOFT_CLIENT_ID");
    tauri_build::build()
}
