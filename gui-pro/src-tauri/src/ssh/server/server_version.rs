/// Fetch available TrustTunnel versions from GitHub releases API.
pub async fn server_get_available_versions() -> Result<Vec<String>, String> {
    // THE THIRD UNTIMED VERSION PROBE (30.1 item 10). The milestone review named two —
    // both in `commands/updater.rs` — and the class sweep found this one, which nobody had
    // looked at. It is the quieter defect of the three: the builder here SET something
    // (a user agent) and so read as configured, while carrying no timeout at all. A
    // GitHub endpoint that accepts the connection and then never answers left this call
    // outstanding for the rest of the session, and the version list it feeds never
    // resolved.
    //
    // The budgets and the builder are imported, not re-declared: one place decides how
    // long a version probe may wait, and `no_version_probe_builds_its_own_untimed_client`
    // in `updater.rs` scans this function's body by name to keep it that way. A local
    // `reqwest::Client::builder()` here — even one that remembered `.timeout(..)` today —
    // is a second budget waiting to drift, so the guard rejects it outright.
    //
    // The user agent moves to the request. `build_update_check_client` sets no default
    // one, and GitHub's API refuses a request without it; the two sibling probes already
    // pass theirs as a header, so this is the shape the class already uses.
    let client = crate::commands::updater::build_update_check_client(
        crate::commands::updater::UPDATE_CHECK_CONNECT_TIMEOUT,
        crate::commands::updater::UPDATE_CHECK_TIMEOUT,
    )?;

    let resp = client
        .get("https://api.github.com/repos/TrustTunnel/TrustTunnel/releases")
        .header("User-Agent", "TrustTunnel-Client")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("GitHub API returned status {}", resp.status()));
    }

    let releases: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse releases: {e}"))?;

    let versions: Vec<String> = releases
        .iter()
        .filter_map(|r| r.get("tag_name").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    Ok(versions)
}
