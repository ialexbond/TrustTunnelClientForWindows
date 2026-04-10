use super::super::*;
use super::super::sanitize::validate_client_name;
use russh::client;

/// Connect to a server where TrustTunnel is already installed,
/// export the client config via trusttunnel_endpoint, and save it locally.
/// NOTE: This function uses direct connect (NOT pooled) — deploy-style flow with emit_step.
pub async fn fetch_server_config(
    app: &tauri::AppHandle,
    params: SshParams,
    client_name: String,
) -> Result<String, String> {
    emit_step(app, "connect", "progress", "Connecting to server...");
    let handle = params.connect_with_app(app.clone()).await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    // Check TrustTunnel is installed
    emit_step(app, "check", "progress", "Checking TrustTunnel on server...");

    let (bin_check, _) = exec_command(
        &handle, app,
        &format!("test -f {bin} && echo TT_EXISTS || echo TT_MISSING", bin = ENDPOINT_BINARY)
    ).await?;

    if !bin_check.contains("TT_EXISTS") {
        let msg = &format!("TrustTunnel not found on server ({bin})", bin = ENDPOINT_BINARY);
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    // Check config files exist
    let (cfg_check, _) = exec_command(
        &handle, app,
        &format!("test -f {dir}/vpn.toml && test -f {dir}/hosts.toml && echo CFG_OK || echo CFG_MISSING", dir = ENDPOINT_DIR)
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
        &format!(r#"grep -oP 'listen_address\s*=\s*"\K[^"]+' {cfg} 2>/dev/null || echo '0.0.0.0:443'"#, cfg = ENDPOINT_CONFIG)
    ).await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').last().unwrap_or("443");

    // Try to determine the address the endpoint uses (domain from hosts.toml or fallback to host IP)
    let (hostname_raw, _) = exec_command(
        &handle, app,
        &format!(r#"grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR)
    ).await?;
    let endpoint_hostname = hostname_raw.trim();
    let export_address = if !endpoint_hostname.is_empty() && endpoint_hostname != "trusttunnel.local" {
        format!("{endpoint_hostname}:{listen_port}")
    } else {
        format!("{}:{listen_port}", params.host)
    };

    emit_step(app, "export", "progress", "Exporting client config...");

    let sudo = detect_sudo(&handle, app).await;

    // Pre-check: list available usernames from credentials.toml
    let (creds_raw, _) = exec_command(
        &handle, app,
        &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' {dir}/credentials.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR)
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

    // Validate client name before interpolating into shell command
    validate_client_name(&name)?;

    let export_cmd = format!(
        "cd {dir} && {sudo}./{svc} vpn.toml hosts.toml -c {name} -a {export_address} --format toml 2>&1",
        dir = ENDPOINT_DIR, svc = ENDPOINT_SERVICE
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
    let client_toml = build_client_config(&endpoint_section, &format!("Fetched from server {server_host}"));

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

/// Read the raw vpn.toml configuration from the remote server.
pub async fn get_server_config(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;

    let (output, code) = exec_command(
        handle,
        app,
        &format!("{sudo}cat {cfg}", cfg = ENDPOINT_CONFIG),
    )
    .await?;

    if code != 0 {
        return Err("SSH_READ_CONFIG_FAILED".into());
    }

    Ok(output)
}

/// Export a client configuration as a deeplink URL from the remote server.
pub async fn export_config_deeplink(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    client_name: String,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;

    // Get listen address from vpn.toml
    let (listen_raw, _) = exec_command(
        handle,
        app,
        &format!(r#"{sudo}grep -oP 'listen_address\s*=\s*"\K[^"]+' {cfg} 2>/dev/null || echo '0.0.0.0:443'"#, cfg = ENDPOINT_CONFIG),
    )
    .await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').last().unwrap_or("443");

    // Try to determine hostname from hosts.toml, fallback to connection host
    let (hostname_raw, _) = exec_command(
        handle,
        app,
        &format!(r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR),
    )
    .await?;
    let endpoint_hostname = hostname_raw.trim();
    // Use hostname from hosts.toml; if unavailable, the caller must provide the host
    // via a different mechanism. Since the pool always connects to the same host,
    // the hostname from hosts.toml is the correct fallback.
    let export_address = if !endpoint_hostname.is_empty() && endpoint_hostname != "trusttunnel.local" {
        format!("{endpoint_hostname}:{listen_port}")
    } else {
        // Fallback: use the hostname from the server's perspective
        let (host_raw, _) = exec_command(handle, app, "hostname -f 2>/dev/null || hostname").await.unwrap_or_default();
        let fallback = host_raw.trim();
        if fallback.is_empty() {
            format!("localhost:{listen_port}")
        } else {
            format!("{fallback}:{listen_port}")
        }
    };

    let export_cmd = format!(
        "cd {dir} && {sudo}./{svc} vpn.toml hosts.toml -c {client_name} -a {export_address} --format deeplink 2>&1",
        dir = ENDPOINT_DIR, svc = ENDPOINT_SERVICE
    );

    let (export_output, export_code) = exec_command(handle, app, &export_cmd).await?;

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
    handle: &client::Handle<SshHandler>,
    feature: String,
    enabled: bool,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    let value = if enabled { "true" } else { "false" };

    // Try to replace the key if it already exists; if not, append it at the top of the file
    // (before any [section] headers). This handles both fresh configs that lack the key
    // entirely and configs where the key was previously set.
    let cmd = format!(
        r#"{sudo}grep -q "^[[:space:]]*{feature}[[:space:]]*=" {cfg} && \
           {sudo}sed -i "s/^[[:space:]]*{feature}[[:space:]]*=.*/{feature} = {value}/" {cfg} || \
           {sudo}sed -i "1i {feature} = {value}" {cfg}"#,
        cfg = ENDPOINT_CONFIG
    );

    let (_, code) = exec_command(handle, app, &cmd).await?;

    if code != 0 {
        return Err(format!("Failed to update {feature} in vpn.toml (code {code})"));
    }

    // Restart TrustTunnel to apply — --no-block prevents SSH channel from hanging
    let _ = exec_command(handle, app, &format!("{sudo}systemctl --no-block restart trusttunnel")).await;

    Ok(())
}
