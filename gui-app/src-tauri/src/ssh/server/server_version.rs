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

    // Run install script with version flag.
    // install.sh expects version WITHOUT "v" prefix — it adds "v" itself when building
    // the download URL. Passing "v1.0.33" would produce "vv1.0.33" → 404.
    let clean_version = version.strip_prefix('v').unwrap_or(&version);
    let escaped_version = clean_version.replace('\'', "'\\''");
    let install_cmd = format!(
        "curl -fsSL https://raw.githubusercontent.com/TrustTunnel/TrustTunnel/refs/heads/master/scripts/install.sh | {sudo}sh -s -- -V '{escaped_version}' -a y"
    );

    let (install_output, install_code) = exec_command(&handle, app, &install_cmd).await?;

    if install_code != 0 {
        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        // Extract last meaningful line from output for the error message.
        let hint = install_output
            .lines()
            .rev()
            .find(|l| {
                let t = l.trim().to_lowercase();
                !t.is_empty() && (t.contains("error") || t.contains("fail") || t.contains("not found") || t.contains("no such"))
            })
            .or_else(|| install_output.lines().rev().find(|l| !l.trim().is_empty()))
            .unwrap_or("unknown error")
            .trim();
        return Err(format!("UPGRADE_FAILED|{install_code}|{hint}"));
    }

    // Restart service — use --no-block so SSH channel doesn't hang
    let _ = exec_command(
        &handle, app,
        &format!("{sudo}systemctl --no-block restart trusttunnel"),
    ).await;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(())
}
