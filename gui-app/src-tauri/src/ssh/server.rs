use super::*;

// ─── Check & Uninstall ────────────────────────────

/// Check if TrustTunnel is already installed on the server.
/// Returns JSON: { installed: bool, version: String, service_active: bool }
pub async fn check_server_installation(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<serde_json::Value, String> {
    let handle = params.connect().await?;

    // Check for binary
    let (bin_check, _bin_code) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/trusttunnel_endpoint && echo TT_EXISTS || echo TT_MISSING"
    ).await?;
    let installed = bin_check.trim().contains("TT_EXISTS");

    // Get version if installed
    let version = if installed {
        let (ver, _) = exec_command(
            &handle, app,
            "/opt/trusttunnel/trusttunnel_endpoint --version 2>/dev/null || echo unknown"
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
        let (whoami, _) = exec_command(&handle, app, "whoami").await?;
        let sudo = if whoami.trim() == "root" { "" } else { "sudo " };
        let (creds_raw, _) = exec_command(
            &handle, app,
            &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' /opt/trusttunnel/credentials.toml 2>/dev/null || echo ''")
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
pub async fn uninstall_server(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    emit_step(app, "uninstall", "progress", "Connecting to server...");

    let handle = params.connect().await
        .map_err(|e| { emit_step(app, "uninstall", "error", &e); e })?;

    // Determine sudo
    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    emit_step(app, "uninstall", "progress", "Removing TrustTunnel...");

    // Run full uninstall as a single script for reliability
    let uninstall_script = format!(
        r#"set -x
echo "=== BEFORE: listing /opt/trusttunnel ==="
ls -la /opt/trusttunnel/ 2>&1 || echo "(dir does not exist)"

echo "=== Step 1: Stop systemd service ==="
{sudo}systemctl stop trusttunnel 2>/dev/null || true
{sudo}systemctl disable trusttunnel 2>/dev/null || true

echo "=== Step 2: Kill processes ==="
{sudo}killall -9 trusttunnel_endpoint 2>/dev/null || true
{sudo}killall -9 setup_wizard 2>/dev/null || true
sleep 1

echo "=== Step 3: Remove systemd units ==="
{sudo}rm -f /etc/systemd/system/trusttunnel.service
{sudo}rm -f /etc/systemd/system/trusttunnel*.service
{sudo}systemctl daemon-reload

echo "=== Step 4: Remove /opt/trusttunnel ==="
{sudo}rm -rfv /opt/trusttunnel

echo "=== Step 5: Remove certbot cron ==="
{sudo}rm -f /etc/cron.d/trusttunnel-cert-renew 2>/dev/null || true

echo "=== Step 6: Remove binaries from PATH ==="
{sudo}rm -fv /usr/local/bin/trusttunnel* 2>/dev/null || true
{sudo}rm -fv /usr/bin/trusttunnel* 2>/dev/null || true

echo "=== Step 7: Search for any remaining trusttunnel files ==="
find / -maxdepth 4 -name '*trusttunnel*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null || true

echo "=== VERIFY ==="
if test -d /opt/trusttunnel; then
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

// ─── Fetch existing config from server ────────────

/// Connect to a server where TrustTunnel is already installed,
/// export the client config via trusttunnel_endpoint, and save it locally.
pub async fn fetch_server_config(
    app: &tauri::AppHandle,
    params: SshParams,
    client_name: String,
) -> Result<String, String> {
    emit_step(app, "connect", "progress", "Connecting to server...");
    let handle = params.connect().await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    // Check TrustTunnel is installed
    emit_step(app, "check", "progress", "Checking TrustTunnel on server...");

    let (bin_check, _) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/trusttunnel_endpoint && echo TT_EXISTS || echo TT_MISSING"
    ).await?;

    if !bin_check.contains("TT_EXISTS") {
        let msg = "TrustTunnel not found on server (/opt/trusttunnel/trusttunnel_endpoint)";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    // Check config files exist
    let (cfg_check, _) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/vpn.toml && test -f /opt/trusttunnel/hosts.toml && echo CFG_OK || echo CFG_MISSING"
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        let msg = "Configuration files not found on server (vpn.toml / hosts.toml)";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "check", "ok", "TrustTunnel installed, config found");

    // Determine the server's listen address for the export command
    let (listen_raw, _) = exec_command(
        &handle, app,
        r#"grep -oP 'listen_address\s*=\s*"\K[^"]+' /opt/trusttunnel/vpn.toml 2>/dev/null || echo '0.0.0.0:443'"#
    ).await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').last().unwrap_or("443");

    // Try to determine the address the endpoint uses (domain from hosts.toml or fallback to host IP)
    let (hostname_raw, _) = exec_command(
        &handle, app,
        r#"grep -oP 'hostname\s*=\s*"\K[^"]+' /opt/trusttunnel/hosts.toml 2>/dev/null | head -1"#
    ).await?;
    let endpoint_hostname = hostname_raw.trim();
    let export_address = if !endpoint_hostname.is_empty() && endpoint_hostname != "trusttunnel.local" {
        format!("{endpoint_hostname}:{listen_port}")
    } else {
        format!("{}:{listen_port}", params.host)
    };

    emit_step(app, "export", "progress", "Exporting client config...");

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Pre-check: list available usernames from credentials.toml
    let (creds_raw, _) = exec_command(
        &handle, app,
        &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' /opt/trusttunnel/credentials.toml 2>/dev/null || echo ''")
    ).await?;
    let available_users: Vec<&str> = creds_raw.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    // Use provided client_name, or auto-pick first available user from credentials.toml
    let name = if !client_name.trim().is_empty() {
        client_name.trim().to_string()
    } else if let Some(first) = available_users.first() {
        emit_log(app, "info", &format!("Client name not specified, using: {first}"));
        first.to_string()
    } else {
        "client".to_string()
    };

    if !available_users.is_empty() {
        emit_log(app, "info", &format!("Available users: {}", available_users.join(", ")));
        if !available_users.iter().any(|u| *u == name.as_str()) {
            let msg = format!(
                "User '{}' not found in credentials.toml. Available: {}",
                name,
                available_users.join(", ")
            );
            emit_step(app, "export", "error", &msg);
            return Err(msg);
        }
    }

    let export_cmd = format!(
        "cd /opt/trusttunnel && {sudo}./trusttunnel_endpoint vpn.toml hosts.toml -c {name} -a {export_address} --format toml 2>&1"
    );

    let (export_output, export_code) = exec_command(&handle, app, &export_cmd).await?;

    if export_code != 0 || export_output.trim().is_empty() {
        emit_log(app, "error", &format!("Export failed (code {export_code}): {export_output}"));
        let msg = if !available_users.is_empty() {
            format!("SSH_EXPORT_FAILED|{}|{}", export_code, available_users.join(", "))
        } else {
            format!("SSH_EXPORT_FAILED|{}", export_code)
        };
        emit_step(app, "export", "error", &msg);
        return Err(msg);
    }

    // Extract only the TOML part
    let endpoint_section: String = export_output
        .lines()
        .skip_while(|l| !l.starts_with('#') && !l.starts_with("hostname"))
        .collect::<Vec<_>>()
        .join("\n");

    let server_host = &params.host;
    let client_toml = format!(
        r#"# TrustTunnel Client Configuration
# Fetched from server {server_host}

loglevel = "info"
vpn_mode = "general"
killswitch_enabled = true
killswitch_allow_ports = [67, 68]
post_quantum_group_enabled = true

[endpoint]
{endpoint_section}

[listener.tun]
mtu_size = 1280
change_system_dns = true
included_routes = ["0.0.0.0/0"]
excluded_routes = []
"#
    );

    // Enable anti_dpi by default
    let client_toml = client_toml.replace("anti_dpi = false", "anti_dpi = true");

    emit_step(app, "export", "ok", "Config received");

    // Save locally
    emit_step(app, "save", "progress", "Saving configuration...");

    let config_dir = portable_data_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("SSH_MKDIR_FAILED|{e}"))?;

    let client_config_path = config_dir.join("trusttunnel_client.toml");
    std::fs::write(&client_config_path, &client_toml)
        .map_err(|e| format!("SSH_WRITE_CONFIG_FAILED|{e}"))?;

    let config_path_str = client_config_path.to_string_lossy().to_string();
    emit_log(app, "info", &format!("Config saved: {config_path_str}"));
    emit_step(app, "save", "ok", "Configuration saved");

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "done", "ok", "Config successfully fetched from server!");

    Ok(config_path_str)
}

// ─── Add user to server ────────────────────────────

/// SSH to the server, append a new [[client]] entry to credentials.toml,
/// restart the service, export the client config, and save it locally.
pub async fn add_server_user(
    app: &tauri::AppHandle,
    params: SshParams,
    vpn_username: String,
    vpn_password: String,
) -> Result<String, String> {
    emit_step(app, "connect", "progress", "Connecting to server...");
    let handle = params.connect().await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Check that credentials.toml exists
    emit_step(app, "check", "progress", "Checking configuration...");

    let (cfg_check, _) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/credentials.toml && echo CFG_OK || echo CFG_MISSING"
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        let msg = "credentials.toml not found on server";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    // Check if username already exists
    let (creds_raw, _) = exec_command(
        &handle, app,
        &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' /opt/trusttunnel/credentials.toml 2>/dev/null || echo ''")
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

    // Append new [[client]] block to credentials.toml
    emit_step(app, "configure", "progress", &format!("Adding user '{}'...", vpn_username));

    let escaped_user = vpn_username.replace('\\', "\\\\").replace('"', "\\\"");
    let escaped_pass = vpn_password.replace('\\', "\\\\").replace('"', "\\\"");
    let append_cmd = format!(
        r#"{sudo}bash -c 'printf "\n\n[[client]]\nusername = \"{escaped_user}\"\npassword = \"{escaped_pass}\"\n" >> /opt/trusttunnel/credentials.toml'"#
    );

    let (_, append_code) = exec_command(&handle, app, &append_cmd).await?;

    if append_code != 0 {
        let msg = "SSH_ADD_USER_FAILED";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "configure", "ok", "User added");

    // Restart service to pick up new credentials
    emit_step(app, "service", "progress", "Restarting service...");

    let (_, restart_code) = exec_command(
        &handle, app,
        &format!("{sudo}systemctl restart trusttunnel 2>&1")
    ).await?;

    if restart_code != 0 {
        emit_log(app, "warn", "Failed to restart service. Manual restart may be needed.");
    }

    // Wait for service to start
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    emit_step(app, "service", "ok", "Service restarted");

    // User added — config download is done separately via UI
    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "done", "ok", &format!("User '{}' added!", vpn_username));

    Ok(vpn_username)
}

// ─── Server Management Functions ──────────────────

/// Restart the TrustTunnel service on the remote server.
pub async fn server_restart_service(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (_, code) = exec_command(&handle, app, &format!("{sudo}systemctl restart trusttunnel")).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err("SSH_SERVICE_RESTART_FAILED".into());
    }

    Ok(())
}

/// Stop the TrustTunnel service on the remote server.
pub async fn server_stop_service(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (_, code) = exec_command(&handle, app, &format!("{sudo}systemctl stop trusttunnel")).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err("SSH_SERVICE_STOP_FAILED".into());
    }

    Ok(())
}

/// Start the TrustTunnel service on the remote server.
pub async fn server_start_service(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (_, code) = exec_command(&handle, app, &format!("{sudo}systemctl start trusttunnel")).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err("SSH_SERVICE_START_FAILED".into());
    }

    Ok(())
}

/// Reboot the remote server (fire and forget).
pub async fn server_reboot(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Fire and forget — the connection will drop when the server reboots
    let _ = exec_command(&handle, app, &format!("{sudo}reboot")).await;

    Ok(())
}

/// Fetch service logs from the remote server.
pub async fn server_get_logs(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<String, String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (logs, _) = exec_command(
        &handle,
        app,
        &format!("{sudo}journalctl -u trusttunnel --no-pager -n 100 2>/dev/null || {sudo}tail -100 /opt/trusttunnel/logs/*.log 2>/dev/null || echo 'No logs found'"),
    )
    .await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(logs)
}

/// Remove a VPN user from credentials.toml on the remote server and restart the service.
pub async fn server_remove_user(
    app: &tauri::AppHandle,
    params: SshParams,
    vpn_username: String,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Use sed to remove the [[client]] block matching the username.
    // Pattern: delete from [[client]] line through the next blank line (or EOF)
    // when the block contains the target username.
    let escaped_user = vpn_username.replace('\'', "'\\''");
    let remove_cmd = format!(
        r#"{sudo}python3 -c "
import re, sys
with open('/opt/trusttunnel/credentials.toml', 'r') as f:
    content = f.read()
# Split into blocks by [[client]]
blocks = re.split(r'(?=\[\[client\]\])', content)
filtered = [b for b in blocks if not re.search(r'username\s*=\s*\"{}\"', b)]
with open('/opt/trusttunnel/credentials.toml', 'w') as f:
    f.write(''.join(filtered).strip() + '\n')
" 2>/dev/null || {sudo}sed -i '/\[\[client\]\]/,/^$/{{/username\s*=\s*\"{escaped_user}\"/{{:a;N;/\n\s*$/!ba;d}}}}' /opt/trusttunnel/credentials.toml"#,
        escaped_user
    );

    let (_, remove_code) = exec_command(&handle, app, &remove_cmd).await?;

    if remove_code != 0 {
        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        return Err("SSH_DELETE_USER_FAILED".into());
    }

    // Restart service to apply changes
    let (_, restart_code) = exec_command(
        &handle, app,
        &format!("{sudo}systemctl restart trusttunnel 2>&1"),
    ).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if restart_code != 0 {
        return Err("User removed, but failed to restart service".into());
    }

    Ok(())
}

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

/// Get server resource stats: CPU, RAM, disk, active VPN connections.
pub async fn server_get_stats(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<serde_json::Value, String> {
    let handle = params.connect().await?;

    // Single compound command to minimize SSH roundtrips
    // CPU: two /proc/stat samples 1s apart for actual current usage
    let cmd = concat!(
        "echo '---CPU---' && ",
        "C1=$(grep 'cpu ' /proc/stat) && sleep 1 && C2=$(grep 'cpu ' /proc/stat) && echo \"$C1\" && echo \"$C2\" && ",
        "echo '---LOAD---' && ",
        "cat /proc/loadavg && ",
        "echo '---MEM---' && ",
        "free -b | grep Mem && ",
        "echo '---DISK---' && ",
        "df -B1 / | tail -1 && ",
        "echo '---CONNS---' && ",
        "TT_PID=$(pgrep -f '/opt/trusttunnel/bin/trusttunnel' 2>/dev/null | head -1); ",
        "if [ -n \"$TT_PID\" ]; then ",
        "  ss -tnp state established 2>/dev/null | grep \"pid=$TT_PID\" | awk '{print $NF}' | rev | cut -d: -f2- | rev | sort -u | wc -l; ",
        "else echo 0; fi && ",
        "echo '---CONNS_TOTAL---' && ",
        "if [ -n \"$TT_PID\" ]; then ",
        "  ss -tnp state established 2>/dev/null | grep \"pid=$TT_PID\" | wc -l; ",
        "else echo 0; fi && ",
        "echo '---UPTIME---' && ",
        "cat /proc/uptime"
    );

    let (output, _) = exec_command(&handle, app, cmd).await?;
    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    // Parse output
    let mut cpu_usage: f64 = 0.0;
    let mut cpu_samples: Vec<Vec<f64>> = Vec::new();
    let mut load_1m: f64 = 0.0;
    let mut load_5m: f64 = 0.0;
    let mut load_15m: f64 = 0.0;
    let mut mem_total: u64 = 0;
    let mut mem_used: u64 = 0;
    let mut disk_total: u64 = 0;
    let mut disk_used: u64 = 0;
    let mut unique_ips: u64 = 0;
    let mut total_conns: u64 = 0;
    let mut server_uptime: f64 = 0.0;

    let mut section = "";
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("---") && trimmed.ends_with("---") {
            section = trimmed;
            continue;
        }
        match section {
            "---CPU---" => {
                // Two samples: cpu  user nice system idle iowait irq softirq steal
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 5 && parts[0] == "cpu" {
                    let vals: Vec<f64> = parts[1..].iter().map(|s| s.parse().unwrap_or(0.0)).collect();
                    cpu_samples.push(vals);
                    if cpu_samples.len() == 2 {
                        let total1: f64 = cpu_samples[0].iter().sum();
                        let total2: f64 = cpu_samples[1].iter().sum();
                        let idle1 = cpu_samples[0].get(3).copied().unwrap_or(0.0);
                        let idle2 = cpu_samples[1].get(3).copied().unwrap_or(0.0);
                        let total_diff = total2 - total1;
                        let idle_diff = idle2 - idle1;
                        if total_diff > 0.0 {
                            cpu_usage = (((total_diff - idle_diff) / total_diff) * 100.0 * 10.0).round() / 10.0;
                        }
                    }
                }
            }
            "---LOAD---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    load_1m = parts[0].parse().unwrap_or(0.0);
                    load_5m = parts[1].parse().unwrap_or(0.0);
                    load_15m = parts[2].parse().unwrap_or(0.0);
                }
            }
            "---MEM---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    mem_total = parts[1].parse().unwrap_or(0);
                    mem_used = parts[2].parse().unwrap_or(0);
                }
            }
            "---DISK---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 4 {
                    disk_total = parts[1].parse().unwrap_or(0);
                    disk_used = parts[2].parse().unwrap_or(0);
                }
            }
            "---CONNS---" => {
                unique_ips = trimmed.parse().unwrap_or(0);
            }
            "---CONNS_TOTAL---" => {
                total_conns = trimmed.parse().unwrap_or(0);
            }
            "---UPTIME---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if !parts.is_empty() {
                    server_uptime = parts[0].parse().unwrap_or(0.0);
                }
            }
            _ => {}
        }
    }

    Ok(serde_json::json!({
        "cpu_percent": cpu_usage,
        "load_1m": load_1m,
        "load_5m": load_5m,
        "load_15m": load_15m,
        "mem_total": mem_total,
        "mem_used": mem_used,
        "disk_total": disk_total,
        "disk_used": disk_used,
        "unique_ips": unique_ips,
        "total_connections": total_conns,
        "uptime_seconds": server_uptime,
    }))
}

// ─── Get server vpn.toml config ───────────────────

/// Read the raw vpn.toml configuration from the remote server.
pub async fn get_server_config(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<String, String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (output, code) = exec_command(
        &handle,
        app,
        &format!("{sudo}cat /opt/trusttunnel/vpn.toml"),
    )
    .await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err("SSH_READ_CONFIG_FAILED".into());
    }

    Ok(output)
}

// ─── Get certificate info ─────────────────────────

/// Fetch TLS certificate information from the remote server.
pub async fn get_cert_info(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<serde_json::Value, String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Get hostname from hosts.toml
    let (hostname_raw, _) = exec_command(
        &handle,
        app,
        &format!(r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' /opt/trusttunnel/hosts.toml 2>/dev/null | head -1"#),
    )
    .await?;
    let hostname = hostname_raw.trim().to_string();

    // Get cert path from hosts.toml
    let (cert_path_raw, _) = exec_command(
        &handle,
        app,
        &format!(r#"{sudo}grep -oP 'cert_chain_path\s*=\s*"\K[^"]+' /opt/trusttunnel/hosts.toml 2>/dev/null | head -1"#),
    )
    .await?;
    let cert_path = cert_path_raw.trim().to_string();

    // Resolve cert path (relative paths are relative to /opt/trusttunnel)
    let resolved_cert_path = if cert_path.starts_with('/') {
        cert_path.clone()
    } else {
        format!("/opt/trusttunnel/{cert_path}")
    };

    // Get cert details via openssl
    let (cert_info, cert_code) = exec_command(
        &handle,
        app,
        &format!("{sudo}openssl x509 -enddate -subject -issuer -noout -in {resolved_cert_path} 2>&1"),
    )
    .await?;

    let mut not_after = String::new();
    let mut issuer = String::new();
    let mut subject = String::new();

    if cert_code == 0 {
        for line in cert_info.lines() {
            let trimmed = line.trim();
            if let Some(val) = trimmed.strip_prefix("notAfter=") {
                not_after = val.trim().to_string();
            } else if let Some(val) = trimmed.strip_prefix("issuer=") {
                issuer = val.trim().to_string();
            } else if let Some(val) = trimmed.strip_prefix("subject=") {
                subject = val.trim().to_string();
            }
        }
    }

    // Check auto-renewal cron
    let (renew_check, _) = exec_command(
        &handle,
        app,
        &format!("{sudo}test -f /etc/cron.d/trusttunnel-cert-renew && echo \"true\" || echo \"false\""),
    )
    .await?;
    let auto_renew = renew_check.trim() == "true";

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(serde_json::json!({
        "hostname": hostname,
        "certPath": resolved_cert_path,
        "notAfter": not_after,
        "issuer": issuer,
        "subject": subject,
        "autoRenew": auto_renew,
    }))
}

// ─── Renew TLS certificate ───────────────────────

/// Force-renew the TLS certificate via certbot and restart the service.
pub async fn renew_cert(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<String, String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (output, code) = exec_command(
        &handle,
        app,
        &format!("{sudo}pkill -9 certbot 2>/dev/null; {sudo}rm -f /tmp/.certbot.lock 2>/dev/null; sleep 1; {sudo}certbot renew --force-renewal && {sudo}systemctl restart trusttunnel"),
    )
    .await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err(format!("SSH_CERT_RENEW_FAILED|{code}"));
    }

    Ok(output)
}

// ─── Export config as deeplink ────────────────────

/// Export a client configuration as a deeplink URL from the remote server.
pub async fn export_config_deeplink(
    app: &tauri::AppHandle,
    params: SshParams,
    client_name: String,
) -> Result<String, String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Get listen address from vpn.toml
    let (listen_raw, _) = exec_command(
        &handle,
        app,
        &format!(r#"{sudo}grep -oP 'listen_address\s*=\s*"\K[^"]+' /opt/trusttunnel/vpn.toml 2>/dev/null || echo '0.0.0.0:443'"#),
    )
    .await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').last().unwrap_or("443");

    // Try to determine hostname from hosts.toml, fallback to host IP
    let (hostname_raw, _) = exec_command(
        &handle,
        app,
        &format!(r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' /opt/trusttunnel/hosts.toml 2>/dev/null | head -1"#),
    )
    .await?;
    let endpoint_hostname = hostname_raw.trim();
    let export_address = if !endpoint_hostname.is_empty() && endpoint_hostname != "trusttunnel.local" {
        format!("{endpoint_hostname}:{listen_port}")
    } else {
        format!("{}:{listen_port}", params.host)
    };

    let export_cmd = format!(
        "cd /opt/trusttunnel && {sudo}./trusttunnel_endpoint vpn.toml hosts.toml -c {client_name} -a {export_address} --format deeplink 2>&1"
    );

    let (export_output, export_code) = exec_command(&handle, app, &export_cmd).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if export_code != 0 || export_output.trim().is_empty() {
        return Err(format!(
            "SSH_DEEPLINK_EXPORT_FAILED|{export_code}|{client_name}"
        ));
    }

    // Extract the deeplink URL (skip any warning/log lines)
    let deeplink = export_output
        .lines()
        .filter(|l| l.starts_with("trusttunnel://") || l.starts_with("tt://"))
        .last()
        .unwrap_or(export_output.trim());

    Ok(deeplink.trim().to_string())
}

/// Toggle a boolean feature in vpn.toml (ping_enable, speedtest_enable, ipv6_available)
pub async fn update_config_feature(
    app: &tauri::AppHandle,
    params: SshParams,
    feature: String,
    enabled: bool,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let value = if enabled { "true" } else { "false" };

    // Use sed to toggle the feature in vpn.toml
    let cmd = format!(
        r#"{sudo}sed -i 's/^{feature}\s*=\s*\(true\|false\)/{feature} = {value}/' /opt/trusttunnel/vpn.toml"#
    );

    let (_, code) = exec_command(&handle, app, &cmd).await?;

    if code != 0 {
        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        return Err(format!("Failed to update {feature} in vpn.toml (code {code})"));
    }

    // Restart TrustTunnel to apply
    let _ = exec_command(&handle, app, &format!("{sudo}systemctl restart trusttunnel")).await;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
    Ok(())
}
