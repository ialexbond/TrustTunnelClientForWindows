use super::super::*;
use super::super::sanitize::*;
use russh::client;

/// Check if TrustTunnel is already installed on the server.
/// Returns JSON: { installed: bool, version: String, service_active: bool }
/// NOTE: Uses direct connect (NOT pooled) — initial check before pool exists.
pub async fn check_server_installation(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<serde_json::Value, String> {
    let handle = params.connect_with_app(app.clone()).await?;

    // Check for binary
    let (bin_check, _bin_code) = exec_command(
        &handle, app,
        &format!("test -f {bin} && echo TT_EXISTS || echo TT_MISSING", bin = ENDPOINT_BINARY)
    ).await?;
    let installed = bin_check.trim().contains("TT_EXISTS");

    // Get version if installed
    let version = if installed {
        let (ver, _) = exec_command(
            &handle, app,
            &format!("{bin} --version 2>/dev/null || echo unknown", bin = ENDPOINT_BINARY)
        ).await?;
        ver.trim().to_string()
    } else {
        String::new()
    };

    // Check service status
    let (svc_status, _) = exec_command(
        &handle, app,
        "systemctl is-active trusttunnel 2>/dev/null || echo inactive"
    ).await?;
    let service_active = svc_status.trim() == "active";

    // Get list of VPN users from credentials.toml
    let users: Vec<String> = if installed {
        let sudo = detect_sudo(&handle, app).await;
        let (creds_raw, _) = exec_command(
            &handle, app,
            &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' {dir}/credentials.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR)
        ).await?;
        creds_raw.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    } else {
        vec![]
    };

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(serde_json::json!({
        "installed": installed,
        "version": version,
        "serviceActive": service_active,
        "users": users,
    }))
}

/// Completely remove TrustTunnel from the server.
/// NOTE: Uses direct connect (NOT pooled) — destructive one-shot operation.
pub async fn uninstall_server(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    emit_step(app, "uninstall", "progress", "Connecting to server...");

    let handle = params.connect_with_app(app.clone()).await
        .map_err(|e| { emit_step(app, "uninstall", "error", &e); e })?;

    // Determine sudo
    let sudo = detect_sudo(&handle, app).await;

    emit_step(app, "uninstall", "progress", "Removing TrustTunnel...");

    // Run full uninstall as a single script for reliability
    let dir = ENDPOINT_DIR;
    let svc = ENDPOINT_SERVICE;
    let uninstall_script = format!(
        r#"set -x
echo "=== BEFORE: listing {dir} ==="
ls -la {dir}/ 2>&1 || echo "(dir does not exist)"

echo "=== Step 1: Stop systemd service ==="
{sudo}systemctl stop trusttunnel 2>/dev/null || true
{sudo}systemctl disable trusttunnel 2>/dev/null || true

echo "=== Step 2: Kill processes ==="
{sudo}killall -9 {svc} 2>/dev/null || true
{sudo}killall -9 setup_wizard 2>/dev/null || true
sleep 1

echo "=== Step 3: Remove systemd units ==="
{sudo}rm -f /etc/systemd/system/trusttunnel.service
{sudo}rm -f /etc/systemd/system/trusttunnel*.service
{sudo}systemctl daemon-reload

echo "=== Step 4: Remove {dir} ==="
{sudo}rm -rfv {dir}

echo "=== Step 5: Remove certbot cron ==="
{sudo}rm -f /etc/cron.d/trusttunnel-cert-renew 2>/dev/null || true

echo "=== Step 6: Remove binaries from PATH ==="
{sudo}rm -fv /usr/local/bin/trusttunnel* 2>/dev/null || true
{sudo}rm -fv /usr/bin/trusttunnel* 2>/dev/null || true

echo "=== Step 7: Search for any remaining trusttunnel files ==="
find / -maxdepth 4 -name '*trusttunnel*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null || true

echo "=== VERIFY ==="
if test -d {dir}; then
    echo "UNINSTALL_FAILED"
else
    echo "UNINSTALL_OK"
fi
"#
    );

    let (output, code) = exec_command(&handle, app, &uninstall_script).await?;

    if output.contains("UNINSTALL_FAILED") || code != 0 {
        let msg = format!("SSH_UNINSTALL_FAILED|{code}");
        emit_step(app, "uninstall", "error", &msg);
        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        return Err(msg);
    }

    emit_log(app, "info", "TrustTunnel completely removed from server");

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "uninstall", "ok", "TrustTunnel removed");
    Ok(())
}

/// SSH to the server, append a new [[client]] entry to credentials.toml,
/// restart the service, export the client config, and save it locally.
pub async fn add_server_user(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
    vpn_password: String,
) -> Result<String, String> {
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    let sudo = detect_sudo(handle, app).await;

    // Check that credentials.toml exists
    emit_step(app, "check", "progress", "Checking configuration...");

    let (cfg_check, _) = exec_command(
        handle, app,
        &format!("test -f {dir}/credentials.toml && echo CFG_OK || echo CFG_MISSING", dir = ENDPOINT_DIR)
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        let msg = "credentials.toml not found on server";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    // Check if username already exists
    let (creds_raw, _) = exec_command(
        handle, app,
        &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' {dir}/credentials.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR)
    ).await?;
    let existing_users: Vec<&str> = creds_raw.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    if existing_users.iter().any(|u| *u == vpn_username.as_str()) {
        let msg = format!("User '{}' already exists on server", vpn_username);
        emit_step(app, "check", "error", &msg);
        return Err(msg);
    }

    emit_step(app, "check", "ok", "Configuration verified");

    // Validate user inputs before constructing shell commands
    validate_vpn_username(&vpn_username)?;
    validate_vpn_password(&vpn_password)?;

    // Append new [[client]] block to credentials.toml using heredoc (safe from injection)
    emit_step(app, "configure", "progress", &format!("Adding user '{}'...", vpn_username));

    let escaped_user = vpn_username.replace('\\', "\\\\");
    let escaped_pass = vpn_password.replace('\\', "\\\\");
    let append_cmd = format!(
        r#"{sudo}tee -a {dir}/credentials.toml > /dev/null << 'USER_EOF'

[[client]]
username = "{escaped_user}"
password = "{escaped_pass}"
USER_EOF"#,
        dir = ENDPOINT_DIR
    );

    let (_, append_code) = exec_command(handle, app, &append_cmd).await?;

    if append_code != 0 {
        let msg = "SSH_ADD_USER_FAILED";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "configure", "ok", "User added");

    // Restart service to pick up new credentials
    emit_step(app, "service", "progress", "Restarting service...");

    let (_, restart_code) = exec_command(
        handle, app,
        &format!("{sudo}systemctl --no-block restart trusttunnel 2>&1")
    ).await?;

    if restart_code != 0 {
        emit_log(app, "warn", "Failed to restart service. Manual restart may be needed.");
    }

    // Wait for service to start
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    emit_step(app, "service", "ok", "Service restarted");

    // User added — config download is done separately via UI
    emit_step(app, "done", "ok", &format!("User '{}' added!", vpn_username));

    Ok(vpn_username)
}

/// Remove a VPN user from credentials.toml on the remote server and restart the service.
pub async fn server_remove_user(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    // Use sed to remove the [[client]] block matching the username.
    let escaped_user = vpn_username.replace('\'', "'\\''");
    let dir = ENDPOINT_DIR;
    let remove_cmd = format!(
        r#"{sudo}python3 -c "
import re, sys
with open('{dir}/credentials.toml', 'r') as f:
    content = f.read()
# Split into blocks by [[client]]
blocks = re.split(r'(?=\[\[client\]\])', content)
filtered = [b for b in blocks if not re.search(r'username\s*=\s*\"{}\"', b)]
with open('{dir}/credentials.toml', 'w') as f:
    f.write(''.join(filtered).strip() + '\n')
" 2>/dev/null || {sudo}sed -i '/\[\[client\]\]/,/^$/{{/username\s*=\s*\"{escaped_user}\"/{{:a;N;/\n\s*$/!ba;d}}}}' {dir}/credentials.toml"#,
        escaped_user
    );

    let (_, remove_code) = exec_command(handle, app, &remove_cmd).await?;

    if remove_code != 0 {
        return Err("SSH_DELETE_USER_FAILED".into());
    }

    // Restart service to apply changes
    let (_, restart_code) = exec_command(
        handle, app,
        &format!("{sudo}systemctl --no-block restart trusttunnel 2>&1"),
    ).await?;

    if restart_code != 0 {
        return Err("User removed, but failed to restart service".into());
    }

    Ok(())
}
