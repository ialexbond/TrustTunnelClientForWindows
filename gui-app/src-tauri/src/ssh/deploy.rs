use super::*;
use super::sanitize::*;

/// Validate all user-supplied fields in EndpointSettings before building shell commands.
fn validate_endpoint_settings(settings: &EndpointSettings) -> Result<(), String> {
    validate_vpn_username(&settings.vpn_username)?;
    validate_vpn_password(&settings.vpn_password)?;
    validate_domain(&settings.domain)?;
    validate_email(&settings.email)?;
    validate_listen_address(&settings.listen_address)?;
    if !settings.cert_chain_path.is_empty() {
        validate_server_path(&settings.cert_chain_path)?;
    }
    if !settings.cert_key_path.is_empty() {
        validate_server_path(&settings.cert_key_path)?;
    }
    Ok(())
}

/// Build the shell command that directly creates all TrustTunnel config files.
/// This bypasses setup_wizard entirely (no TTY required).
pub(crate) fn build_configure_commands(settings: &EndpointSettings, sudo: &str) -> String {
    let dir = ENDPOINT_DIR;
    let hostname = if !settings.domain.is_empty() {
        settings.domain.clone()
    } else {
        "trusttunnel.local".to_string()
    };

    // 1. credentials.toml (escape backslashes for TOML)
    let escaped_user = settings.vpn_username.replace('\\', "\\\\");
    let escaped_pass = settings.vpn_password.replace('\\', "\\\\");
    let credentials = format!(
        r#"[[client]]
username = "{}"
password = "{}""#,
        escaped_user, escaped_pass
    );

    // 2. rules.toml (empty = allow all)
    let rules = r#"# No filtering rules — all connections allowed"#;

    // 3. vpn.toml (main settings)
    let vpn = format!(
        r#"listen_address = "{}"
ipv6_available = {}
ping_enable = {}
speedtest_enable = {}
allow_private_network_connections = false
tls_handshake_timeout_secs = 10
client_listener_timeout_secs = 600
connection_establishment_timeout_secs = 30
tcp_connections_timeout_secs = 604800
udp_connections_timeout_secs = 300
credentials_file = "credentials.toml"
rules_file = "rules.toml"

[listen_protocols]

[listen_protocols.http1]
upload_buffer_size = 32768

[listen_protocols.http2]
initial_connection_window_size = 8388608
initial_stream_window_size = 131072
max_concurrent_streams = 1000
max_frame_size = 16384
header_table_size = 65536

[listen_protocols.quic]
recv_udp_payload_size = 1350
send_udp_payload_size = 1350
initial_max_data = 104857600
initial_max_stream_data_bidi_local = 1048576
initial_max_stream_data_bidi_remote = 1048576
initial_max_stream_data_uni = 1048576
initial_max_streams_bidi = 4096
initial_max_streams_uni = 4096
max_connection_window = 25165824
max_stream_window = 16777216
disable_active_migration = true
enable_early_data = true
message_queue_capacity = 4096

[forward_protocol]
direct = {{}}"#,
        settings.listen_address,
        settings.ipv6_available,
        settings.ping_enable,
        settings.speedtest_enable,
    );

    // 4. hosts.toml (TLS certs — main hosts only, ping_hosts requires unique hostname)
    let hosts = format!(
        r#"[[main_hosts]]
hostname = "{hostname}"
cert_chain_path = "certs/cert.pem"
private_key_path = "certs/key.pem""#
    );

    // Build the full shell script
    let email_flag = if !settings.email.is_empty() {
        format!("-m {}", settings.email)
    } else {
        "--register-unsafely-without-email".to_string()
    };
    let cert_cmd = match settings.cert_type.as_str() {
        "letsencrypt" => {
            // For Let's Encrypt: install certbot and get cert
            format!(
                r#"
# Install certbot and get Let's Encrypt certificate
if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    {sudo}apt-get -y -qq -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install certbot 2>/dev/null
elif command -v dnf >/dev/null 2>&1; then
    {sudo}dnf install -y -q certbot 2>/dev/null
elif command -v yum >/dev/null 2>&1; then
    {sudo}yum install -y -q certbot 2>/dev/null
fi
# Kill any lingering certbot processes and remove lock files
{sudo}pkill -9 certbot 2>/dev/null || true
{sudo}rm -f /tmp/.certbot.lock 2>/dev/null || true
sleep 1
{sudo}certbot certonly --standalone -d {hostname} --non-interactive --agree-tos {email_flag} --http-01-port 80
{sudo}mkdir -p {dir}/certs
{sudo}cp /etc/letsencrypt/live/{hostname}/fullchain.pem {dir}/certs/cert.pem
{sudo}cp /etc/letsencrypt/live/{hostname}/privkey.pem {dir}/certs/key.pem

# Setup auto-renewal cron (renew + copy certs + restart service)
{sudo}bash -c 'cat > /etc/cron.d/trusttunnel-cert-renew << CRON_EOF
0 3 * * * root certbot renew --quiet --deploy-hook "cp /etc/letsencrypt/live/{hostname}/fullchain.pem {dir}/certs/cert.pem && cp /etc/letsencrypt/live/{hostname}/privkey.pem {dir}/certs/key.pem && systemctl restart trusttunnel"
CRON_EOF'
"#
            )
        }
        "provided" => {
            // User-provided certificate — copy from specified paths on the server
            let chain = &settings.cert_chain_path;
            let key = &settings.cert_key_path;
            format!(
                r#"
# Use provided certificate files
{sudo}mkdir -p {dir}/certs
{sudo}cp {chain} {dir}/certs/cert.pem
{sudo}cp {key} {dir}/certs/key.pem
echo "Copied provided certificate files"
"#
            )
        }
        _ => {
            // Self-signed certificate via openssl
            format!(
                r#"
# Generate self-signed certificate
{sudo}mkdir -p {dir}/certs
{sudo}openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout {dir}/certs/key.pem -out {dir}/certs/cert.pem \
    -days 3650 -nodes -subj '/CN={hostname}'
"#
            )
        }
    };

    format!(
        r#"set -e

# Write config files
{sudo}tee {dir}/credentials.toml > /dev/null << 'CREDS_EOF'
{credentials}
CREDS_EOF

{sudo}tee {dir}/rules.toml > /dev/null << 'RULES_EOF'
{rules}
RULES_EOF

{sudo}tee {dir}/vpn.toml > /dev/null << 'VPN_EOF'
{vpn}
VPN_EOF

{sudo}tee {dir}/hosts.toml > /dev/null << 'HOSTS_EOF'
{hosts}
HOSTS_EOF
{cert_cmd}
echo "Configuration files created successfully"
"#
    )
}

// ─── Deploy Sub-steps ──────────────────────────────

/// Check OS, architecture, root/sudo availability.
/// Returns the sudo prefix string ("" for root, "sudo " otherwise).
async fn deploy_check_env(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    emit_step(app, "check", "progress", "Checking server...");

    let (os_info, _) = exec_command(
        handle,
        app,
        "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"' || echo 'Unknown OS'",
    )
    .await?;

    let (arch_info, _) = exec_command(handle, app, "uname -m").await?;

    // Check if running as root
    let sudo = detect_sudo(handle, app).await;
    let is_root = sudo.is_empty();

    let (whoami_out, _) = exec_command(handle, app, "whoami").await.unwrap_or_default();
    emit_log(
        app,
        "info",
        &format!(
            "Server: {} ({}) / user: {}",
            os_info.trim(),
            arch_info.trim(),
            whoami_out.trim()
        ),
    );

    if !is_root {
        // Check if sudo is available without password
        let (_, sudo_code) = exec_command(handle, app, "sudo -n true 2>/dev/null").await?;
        if sudo_code != 0 {
            let msg = "Root privileges required. Connect as root or configure passwordless sudo.";
            emit_step(app, "check", "error", msg);
            return Err(msg.into());
        }
    }

    emit_step(app, "check", "ok", "Server ready");

    Ok(sudo.to_string())
}

/// Update system packages (apt/dnf/yum).
async fn deploy_update_packages(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "update", "progress", "Updating system packages...");

    let update_cmd = format!(
        "if command -v apt-get >/dev/null 2>&1; then \
             export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a && \
             {sudo}apt-get update -qq && \
             {sudo}apt-get -y -qq -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' upgrade && \
             {sudo}apt-get -y -qq -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install curl iptables; \
         elif command -v dnf >/dev/null 2>&1; then \
             {sudo}dnf upgrade -y -q && \
             {sudo}dnf install -y -q curl iptables; \
         elif command -v yum >/dev/null 2>&1; then \
             {sudo}yum update -y -q && \
             {sudo}yum install -y -q curl iptables; \
         fi"
    );

    let (_, update_code) = exec_command(handle, app, &update_cmd).await?;

    if update_code != 0 {
        emit_log(app, "warn", "Failed to update packages. Continuing installation...");
    }

    emit_step(app, "update", "ok", "System updated");
    Ok(())
}

/// Download and install the TrustTunnel Endpoint binary.
async fn deploy_install_binary(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "install", "progress", "Installing TrustTunnel Endpoint...");

    // Stop existing service if running (ignore errors)
    let stop_cmd = format!("{sudo}systemctl stop trusttunnel 2>/dev/null; sleep 1; true");
    exec_command(handle, app, &stop_cmd).await.ok();

    // Use -a y flag to auto-answer interactive prompts (built into the install script)
    let install_cmd = format!(
        "curl -fsSL https://raw.githubusercontent.com/TrustTunnel/TrustTunnel/refs/heads/master/scripts/install.sh -o /tmp/tt_install.sh && {sudo}sh /tmp/tt_install.sh -a y -v && rm -f /tmp/tt_install.sh"
    );

    let (_, install_code) = exec_command(handle, app, &install_cmd).await?;

    if install_code != 0 {
        let msg = format!("Installation failed with error (code {install_code})");
        emit_step(app, "install", "error", &msg);
        return Err(msg);
    }

    // Verify installation
    let (_, verify_code) = exec_command(
        handle,
        app,
        &format!("test -f {dir}/setup_wizard && test -f {bin}", dir = ENDPOINT_DIR, bin = ENDPOINT_BINARY),
    )
    .await?;

    if verify_code != 0 {
        let msg = &format!("TrustTunnel files not found in {dir}/ after installation", dir = ENDPOINT_DIR);
        emit_step(app, "install", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "install", "ok", "TrustTunnel Endpoint installed");
    Ok(())
}

/// Create config files and TLS certificates, then run pre-flight check.
async fn deploy_configure(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    settings: &EndpointSettings,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "configure", "progress", "Creating Endpoint configuration...");

    // Validate domain for Let's Encrypt before attempting
    if settings.cert_type == "letsencrypt" {
        let domain = if !settings.domain.is_empty() {
            settings.domain.clone()
        } else {
            "trusttunnel.local".to_string()
        };
        let invalid = domain.ends_with(".local")
            || domain.ends_with(".localhost")
            || domain.ends_with(".test")
            || domain.ends_with(".example")
            || domain.ends_with(".invalid")
            || !domain.contains('.');
        if invalid {
            let msg = format!(
                "Let's Encrypt cannot issue a certificate for '{}'. Specify a public domain or choose a self-signed certificate.",
                domain
            );
            emit_step(app, "configure", "error", &msg);
            return Err(msg);
        }
    }

    validate_endpoint_settings(settings)?;
    let configure_cmd = build_configure_commands(settings, sudo);

    let (_, cfg_code) = exec_command(handle, app, &configure_cmd).await?;

    if cfg_code != 0 {
        let msg = "SSH_CONFIG_CREATE_FAILED";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }

    // Verify certs were created
    let (cert_check, cert_code) = exec_command(
        handle, app,
        &format!("test -f {dir}/certs/cert.pem && test -f {dir}/certs/key.pem && echo OK", dir = ENDPOINT_DIR)
    ).await?;

    if cert_code != 0 || !cert_check.contains("OK") {
        let msg = "Certificates were not created. Check logs (openssl/certbot).";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }
    emit_log(app, "info", "Certificates created");

    // Pre-flight: run endpoint briefly to verify config is valid
    let (preflight, _preflight_code) = exec_command(
        handle, app,
        &format!("cd {dir} && timeout 2 {sudo}./{svc} vpn.toml hosts.toml 2>&1 || true", dir = ENDPOINT_DIR, svc = ENDPOINT_SERVICE)
    ).await?;
    emit_log(app, "debug", &format!("Pre-flight output: {preflight}"));

    // Check for fatal config errors (but ignore timeout exit which is expected)
    if preflight.to_lowercase().contains("error") && preflight.to_lowercase().contains("pars") {
        let msg = format!("SSH_ENDPOINT_CONFIG_ERROR|{}", preflight.trim());
        emit_step(app, "configure", "error", &msg);
        return Err(msg);
    }

    emit_step(app, "configure", "ok", "Endpoint configuration created and verified");
    Ok(())
}

/// Set up and start the systemd service, verify it is running.
async fn deploy_start_service(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    settings: &EndpointSettings,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "service", "progress", "Starting service...");

    // Stop existing service first, then copy template and restart
    let service_cmds = format!(
        "{sudo}systemctl stop trusttunnel 2>/dev/null; \
         cd {dir} && \
         {sudo}cp -f trusttunnel.service.template /etc/systemd/system/trusttunnel.service 2>/dev/null; \
         {sudo}systemctl daemon-reload && \
         {sudo}systemctl enable --now trusttunnel",
        dir = ENDPOINT_DIR
    );

    let (_, svc_code) = exec_command(handle, app, &service_cmds).await?;

    if svc_code != 0 {
        emit_log(app, "warn", "Failed to start systemd service. Manual setup may be needed.");
    }

    // Wait for service to start and verify it's running
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Check service status
    let (svc_status, _) = exec_command(
        handle, app,
        &format!("{sudo}systemctl is-active trusttunnel 2>&1")
    ).await?;
    let is_active = svc_status.trim() == "active";

    if !is_active {
        // Get journal logs to diagnose the issue
        let (journal, _) = exec_command(
            handle, app,
            &format!("{sudo}journalctl -u trusttunnel --no-pager -n 30 2>&1")
        ).await?;
        emit_log(app, "error", &format!("Service failed to start. Status: {}", svc_status.trim()));
        for line in journal.lines().take(30) {
            emit_log(app, "warn", line);
        }

        // Also check the service file contents for debugging
        let (svc_file, _) = exec_command(
            handle, app,
            "cat /etc/systemd/system/trusttunnel.service 2>&1"
        ).await?;
        emit_log(app, "debug", &format!("Service file:\n{svc_file}"));

        // Check what config files exist
        let (ls_output, _) = exec_command(
            handle, app,
            &format!("ls -la {dir}/*.toml {dir}/certs/ 2>&1", dir = ENDPOINT_DIR)
        ).await?;
        emit_log(app, "debug", &format!("Config files:\n{ls_output}"));

        let msg = "TrustTunnel Endpoint failed to start. Check logs for diagnostics.";
        emit_step(app, "service", "error", msg);
        return Err(msg.into());
    }

    // Check if the port is actually listening
    let listen_port = settings.listen_address.split(':').last().unwrap_or("443");
    let (port_check, _) = exec_command(
        handle, app,
        &format!("ss -tlnp | grep :{listen_port} || echo 'PORT_NOT_LISTENING'")
    ).await?;

    if port_check.contains("PORT_NOT_LISTENING") {
        emit_log(app, "warn", &format!("Port {listen_port} is not listening yet. The service may need more time."));
    } else {
        emit_log(app, "info", &format!("Port {listen_port} is listening"));
    }

    emit_step(app, "service", "ok", "Service started and running");
    Ok(())
}

/// Export client config from the endpoint binary and save it locally.
/// Returns the path to the saved config file.
async fn deploy_export_config(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    params: &SshParams,
    settings: &EndpointSettings,
    sudo: &str,
) -> Result<String, String> {
    emit_step(app, "export", "progress", "Generating client config...");

    // Use the endpoint's own export to get proper config with certificate PEM
    let export_address = if !settings.domain.is_empty() {
        format!("{}:{}", settings.domain, settings.listen_address.split(':').last().unwrap_or("443"))
    } else {
        let port = settings.listen_address.split(':').last().unwrap_or("443");
        format!("{}:{port}", params.host)
    };

    let export_cmd = format!(
        "cd {dir} && {sudo}./{svc} vpn.toml hosts.toml -c {user} -a {addr} --format toml 2>&1",
        dir = ENDPOINT_DIR,
        svc = ENDPOINT_SERVICE,
        sudo = sudo,
        user = settings.vpn_username,
        addr = export_address,
    );

    let (export_output, export_code) = exec_command(handle, app, &export_cmd).await?;

    if export_code != 0 || export_output.trim().is_empty() {
        emit_log(app, "error", &format!("Export failed (code {export_code}): {export_output}"));
        let msg = format!(
            "SSH_EXPORT_FAILED|{}|{}",
            export_code, settings.vpn_username
        );
        emit_step(app, "export", "error", &msg);
        return Err(msg);
    }

    // Extract only the TOML part (skip warning lines starting with timestamp or empty lines before TOML)
    let endpoint_section: String = export_output
        .lines()
        .skip_while(|l| !l.starts_with('#') && !l.starts_with("hostname"))
        .collect::<Vec<_>>()
        .join("\n");

    // Wrap with client-side settings
    let client_toml = build_client_config(&endpoint_section, "Generated by TrustTunnel Setup Wizard");

    emit_log(app, "debug", &format!("Generated client config:\n{client_toml}"));
    emit_step(app, "export", "ok", "Config generated");

    // ── Save config locally (portable — next to exe) ──
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

    Ok(config_path_str)
}

// ─── Main Deploy Function ──────────────────────────

pub async fn deploy_server(
    app: &tauri::AppHandle,
    params: SshParams,
    settings: EndpointSettings,
) -> Result<String, String> {
    // ── Step 1: SSH Connect + Authenticate ──
    emit_step(app, "connect", "progress", "Connecting to server...");
    let handle = params.connect().await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    // ── Step 2: Check environment ──
    let sudo = deploy_check_env(&handle, app).await?;

    // ── Step 3: Update system packages ──
    deploy_update_packages(&handle, app, &sudo).await?;

    // ── Step 4: Install TrustTunnel Endpoint ──
    deploy_install_binary(&handle, app, &sudo).await?;

    // ── Step 5: Create config files + TLS certs ──
    deploy_configure(&handle, app, &settings, &sudo).await?;

    // ── Step 6: Start systemd service ──
    deploy_start_service(&handle, app, &settings, &sudo).await?;

    // ── Step 7: Export client config + save locally ──
    let config_path_str = deploy_export_config(&handle, app, &params, &settings, &sudo).await?;

    // ── Disconnect ──
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();

    emit_step(app, "done", "ok", "All done! Server configured and running.");

    Ok(config_path_str)
}

pub async fn diagnose_server(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<String, String> {
    let handle = params.connect().await?;

    let mut report = String::new();

    // Service status
    let (status, _) = exec_command(&handle, app, "systemctl is-active trusttunnel 2>&1").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("Service status: {}\n", status.trim()));

    // Journal logs
    let (journal, _) = exec_command(&handle, app, "journalctl -u trusttunnel --no-pager -n 30 2>&1").await
        .unwrap_or(("no logs".into(), -1));
    report.push_str(&format!("\n=== Journal (last 30 lines) ===\n{journal}\n"));

    // Port check
    let (ports, _) = exec_command(&handle, app, "ss -tlnp 2>&1 | head -20").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== Listening ports ===\n{ports}\n"));

    // Config files
    let (ls, _) = exec_command(&handle, app, &format!("ls -la {dir}/ 2>&1", dir = ENDPOINT_DIR)).await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== {dir}/ ===\n{ls}\n", dir = ENDPOINT_DIR));

    // Service file
    let (svc, _) = exec_command(&handle, app, "cat /etc/systemd/system/trusttunnel.service 2>&1").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== Service file ===\n{svc}\n"));

    // vpn.toml
    let (vpn_cfg, _) = exec_command(&handle, app, &format!("cat {cfg} 2>&1", cfg = ENDPOINT_CONFIG)).await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== vpn.toml ===\n{vpn_cfg}\n"));

    // hosts.toml
    let (hosts_cfg, _) = exec_command(&handle, app, &format!("cat {dir}/hosts.toml 2>&1", dir = ENDPOINT_DIR)).await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== hosts.toml ===\n{hosts_cfg}\n"));

    // Certs
    let (certs, _) = exec_command(&handle, app, &format!("ls -la {dir}/certs/ 2>&1", dir = ENDPOINT_DIR)).await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== Certs ===\n{certs}\n"));

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(report)
}

// ═══════════════════════════════════════════════════════════════
//   Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn test_settings() -> EndpointSettings {
        EndpointSettings {
            listen_address: "0.0.0.0:443".to_string(),
            vpn_username: "testuser".to_string(),
            vpn_password: "testpass".to_string(),
            cert_type: "selfsigned".to_string(),
            domain: "example.com".to_string(),
            client_name: "testclient".to_string(),
            email: "test@example.com".to_string(),
            ping_enable: false,
            speedtest_enable: false,
            ipv6_available: true,
            cert_chain_path: String::new(),
            cert_key_path: String::new(),
        }
    }

    #[test]
    fn test_backslash_escaping() {
        let mut settings = test_settings();
        settings.vpn_username = r"domain\user".to_string();
        settings.vpn_password = r"pass\word".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains(r"domain\\user"), "username backslash not escaped");
        assert!(output.contains(r"pass\\word"), "password backslash not escaped");
    }

    #[test]
    fn test_heredoc_uses_quoted_delimiter() {
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("<< 'CREDS_EOF'"), "heredoc delimiter not quoted");
    }

    #[test]
    fn test_letsencrypt_cert_type() {
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("certbot"), "letsencrypt should use certbot");
    }

    #[test]
    fn test_selfsigned_cert_type() {
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("openssl req"), "selfsigned should use openssl");
    }

    #[test]
    fn test_provided_cert_type() {
        let mut settings = test_settings();
        settings.cert_type = "provided".to_string();
        settings.cert_chain_path = "/etc/ssl/cert.pem".to_string();
        settings.cert_key_path = "/etc/ssl/key.pem".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("cp /etc/ssl/cert.pem"), "provided should copy cert");
        assert!(output.contains("cp /etc/ssl/key.pem"), "provided should copy key");
    }
}
