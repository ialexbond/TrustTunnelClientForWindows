#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The WebView2 profile is the application's ENTIRE browser-side storage: feature toggles,
    // failover exclusions, language, theme, tab memory. Nothing in the milestone review named it,
    // and that is exactly why it is dangerous — its failure mode is not an error dialog but
    // AMNESIA, the app quietly forgetting every setting the user ever chose.
    //
    // The work is delegated to the library so the resolution rule lives in ONE place
    // (`ssh::user_data_dir`) instead of being re-derived here from `current_exe()` — which is
    // what keeps the profile in step with the rest of the data if the root ever moves. It must
    // run BEFORE Tauri/WebView2 initializes — WebView2 reads the variable once, at startup, and
    // locks the directory — which is the whole reason this sits in `main()` and not in `.setup()`.
    trusttunnel_lib::init_data_root_early();

    trusttunnel_lib::run()
}
