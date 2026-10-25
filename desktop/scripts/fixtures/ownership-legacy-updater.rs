// Compiled against the exact released updater source fetched by the CI helper.
// This is algorithm replay, not installation or real-device acceptance.
mod commands {
    #[derive(Debug)]
    pub struct CommandError {
        pub code: String,
        pub message: String,
    }
}

#[allow(dead_code)]
#[path = "ownership-legacy/released_update_check.rs"]
mod released_update_check;

#[test]
fn ownership_legacy_044_can_offer_a_bridge_before_transfer_but_rejects_new_owner() {
    use released_update_check::{latest_desktop_release, offer_from, Pick};
    use serde_json::json;
    let old = json!([{
        "tag_name": "desktop-v0.4.5",
        "draft": false,
        "prerelease": false,
        "html_url": "https://github.com/TshyGO/resume-form-assistant-plugin/releases/tag/desktop-v0.4.5"
    }]);
    assert!(matches!(latest_desktop_release(&old), Pick::Found(_)));
    assert_eq!(offer_from(&old).unwrap().unwrap().version, "0.4.5");
    let mut moved = old;
    moved[0]["html_url"] = json!("https://github.com/ptjworks/resume-form-assistant-plugin/releases/tag/desktop-v0.4.5");
    assert_eq!(latest_desktop_release(&moved), Pick::Unusable);
    assert_eq!(offer_from(&moved).unwrap_err().code, "UPDATE_FAILED");
}
