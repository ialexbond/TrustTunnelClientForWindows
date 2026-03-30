use super::super::*;

/// Fetch available TrustTunnel versions from GitHub releases API.
pub async fn server_get_available_versions() -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent("TrustTunnel-Client")
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let resp = client
        .get("https://api.github.com/repos/TrustTunnel/TrustTunnel/releases")
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

/// Upgrade TrustTunnel on the remote server to a specific version.
pub async fn server_upgrade(
    app: &tauri::AppHandle,
    params: SshParams,
    version: String,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Stop existing service before upgrade
    let _ = exec_command(&handle, app, &format!("{sudo}systemctl stop trusttunnel 2>/dev/null; sleep 1; true")).await;

    // Run install script with version flag
    let escaped_version = version.replace('\'', "'\\''");
    let install_cmd = format!(
        "curl -fsSL https://raw.githubusercontent.com/TrustTunnel/TrustTunnel/refs/heads/master/scripts/install.sh | {sudo}sh -s -- -V '{escaped_version}' -a y"
    );

    let (_, install_code) = exec_command(&handle, app, &install_cmd).await?;

    if install_code != 0 {
        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        return Err(format!("Upgrade failed with error (code {install_code})"));
    }

    // Restart service
    let (_, restart_code) = exec_command(
        &handle, app,
        &format!("{sudo}systemctl restart trusttunnel 2>&1"),
    ).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if restart_code != 0 {
        return Err("Upgrade completed, but failed to restart service".into());
    }

    Ok(())
}
