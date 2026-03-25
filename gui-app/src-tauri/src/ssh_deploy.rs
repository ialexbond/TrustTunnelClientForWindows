use std::sync::Arc;
use russh::client;
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::Emitter;

// ─── Portable data directory (next to exe) ─────────

pub fn portable_data_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

// ─── Event Payloads ────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct DeployStepPayload {
    pub step: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, serde::Serialize)]
pub struct DeployLogPayload {
    pub message: String,
    pub level: String,
}

// ─── Endpoint Settings (from GUI wizard) ───────────

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSettings {
    pub listen_address: String,
    pub vpn_username: String,
    pub vpn_password: String,
    pub cert_type: String,
    pub domain: String,
    #[allow(dead_code)]
    pub client_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub ping_enable: bool,
    #[serde(default)]
    pub speedtest_enable: bool,
    #[serde(default = "default_true")]
    pub ipv6_available: bool,
    #[serde(default)]
    pub cert_chain_path: String,
    #[serde(default)]
    pub cert_key_path: String,
}

fn default_true() -> bool { true }

// ─── SSH Handler ───────────────────────────────────

struct SshHandler;

#[async_trait::async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

// ─── Helpers ───────────────────────────────────────

fn emit_step(app: &tauri::AppHandle, step: &str, status: &str, message: &str) {
    eprintln!("[deploy] step={step} status={status} msg={message}");
    app.emit(
        "deploy-step",
        DeployStepPayload {
            step: step.into(),
            status: status.into(),
            message: message.into(),
        },
    )
    .ok();
}

fn emit_log(app: &tauri::AppHandle, level: &str, message: &str) {
    if message.trim().is_empty() {
        return;
    }
    eprintln!("[deploy-log] [{level}] {message}");
    app.emit(
        "deploy-log",
        DeployLogPayload {
            message: message.into(),
            level: level.into(),
        },
    )
    .ok();
}

/// Universal SSH connect — supports password or private key authentication.
pub async fn ssh_connect(
    host: &str,
    port: u16,
    ssh_user: &str,
    ssh_password: &str,
    key_path: Option<&str>,
) -> Result<client::Handle<SshHandler>, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });

    let connect_fut = client::connect(config, (host, port), SshHandler);
    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        connect_fut,
    )
    .await
    .map_err(|_| format!("SSH_TIMEOUT|{host}:{port}"))?
    .map_err(|e| format!("SSH_CONNECT_FAILED|{e}"))?;

    // Try key-based auth if key_path provided
    if let Some(kp) = key_path {
        if !kp.is_empty() {
            let key = russh_keys::load_secret_key(kp, None)
                .map_err(|e| format!("SSH_KEY_LOAD_FAILED|{kp}|{e}"))?;
            let auth_ok = handle
                .authenticate_publickey(ssh_user, Arc::new(key))
                .await
                .map_err(|e| format!("SSH_KEY_AUTH_ERROR|{e}"))?;
            if !auth_ok {
                return Err("SSH_KEY_REJECTED".into());
            }
            return Ok(handle);
        }
    }

    // Fallback to password auth
    let auth_ok = handle
        .authenticate_password(ssh_user, ssh_password)
        .await
        .map_err(|e| format!("SSH_AUTH_ERROR|{e}"))?;

    if !auth_ok {
        return Err("SSH_AUTH_FAILED".into());
    }

    Ok(handle)
}

/// Execute a command on the remote server, streaming output to the frontend.
async fn exec_command(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    command: &str,
) -> Result<(String, i32), String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut stdout = String::new();
    let mut exit_code: i32 = -1;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                let text = String::from_utf8_lossy(data);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        emit_log(app, "info", trimmed);
                    }
                }
                stdout.push_str(&text);
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                let text = String::from_utf8_lossy(data);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        emit_log(app, "warn", trimmed);
                    }
                }
                stdout.push_str(&text);
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = exit_status as i32;
            }
            _ => {}
        }
    }

    Ok((stdout, exit_code))
}

/// Build the shell command that directly creates all TrustTunnel config files.
/// This bypasses setup_wizard entirely (no TTY required).
fn build_configure_commands(settings: &EndpointSettings, sudo: &str) -> String {
    let dir = "/opt/trusttunnel";
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

// ─── Main Deploy Function ──────────────────────────

pub async fn deploy_server(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
    settings: EndpointSettings,
) -> Result<String, String> {
    // ── Step 1: SSH Connect + Authenticate ──
    emit_step(app, "connect", "progress", "Подключение к серверу...");
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Подключено к серверу");
    emit_step(app, "auth", "ok", "Авторизация успешна");

    // ── Step 3: Check environment ──
    emit_step(app, "check", "progress", "Проверка сервера...");

    let (os_info, _) = exec_command(
        &handle,
        app,
        "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"' || echo 'Unknown OS'",
    )
    .await?;

    let (arch_info, _) = exec_command(&handle, app, "uname -m").await?;

    // Check if running as root
    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let is_root = whoami.trim() == "root";

    emit_log(
        app,
        "info",
        &format!(
            "Сервер: {} ({}) / пользователь: {}",
            os_info.trim(),
            arch_info.trim(),
            whoami.trim()
        ),
    );

    if !is_root {
        // Check if sudo is available without password
        let (_, sudo_code) = exec_command(&handle, app, "sudo -n true 2>/dev/null").await?;
        if sudo_code != 0 {
            let msg = "Нужны права root. Подключитесь как root или настройте sudo без пароля.";
            emit_step(app, "check", "error", msg);
            return Err(msg.into());
        }
    }

    let sudo = if is_root { "" } else { "sudo " };

    emit_step(app, "check", "ok", "Сервер готов");

    // ── Step 3.5: Update system packages ──
    emit_step(app, "update", "progress", "Обновление системных пакетов...");

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

    let (_, update_code) = exec_command(&handle, app, &update_cmd).await?;

    if update_code != 0 {
        emit_log(app, "warn", "Failed to update packages. Continuing installation...");
    }

    emit_step(app, "update", "ok", "Система обновлена");

    // ── Step 4: Install TrustTunnel Endpoint ──
    emit_step(app, "install", "progress", "Установка TrustTunnel Endpoint...");

    // Stop existing service if running (ignore errors)
    let stop_cmd = format!("{sudo}systemctl stop trusttunnel 2>/dev/null; sleep 1; true");
    exec_command(&handle, app, &stop_cmd).await.ok();

    // Use -a y flag to auto-answer interactive prompts (built into the install script)
    let install_cmd = format!(
        "curl -fsSL https://raw.githubusercontent.com/TrustTunnel/TrustTunnel/refs/heads/master/scripts/install.sh -o /tmp/tt_install.sh && {sudo}sh /tmp/tt_install.sh -a y -v && rm -f /tmp/tt_install.sh"
    );

    let (_, install_code) = exec_command(&handle, app, &install_cmd).await?;

    if install_code != 0 {
        let msg = format!("Установка завершилась с ошибкой (код {install_code})");
        emit_step(app, "install", "error", &msg);
        return Err(msg);
    }

    // Verify installation
    let (_, verify_code) = exec_command(
        &handle,
        app,
        "test -f /opt/trusttunnel/setup_wizard && test -f /opt/trusttunnel/trusttunnel_endpoint",
    )
    .await?;

    if verify_code != 0 {
        let msg = "Файлы TrustTunnel не найдены в /opt/trusttunnel/ после установки";
        emit_step(app, "install", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "install", "ok", "TrustTunnel Endpoint установлен");

    // ── Step 5: Create config files directly (no TTY needed) ──
    emit_step(app, "configure", "progress", "Создание конфигурации Endpoint...");

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
                "Let's Encrypt не может выдать сертификат для '{}'. Укажите публичный домен или выберите самоподписанный сертификат.",
                domain
            );
            emit_step(app, "configure", "error", &msg);
            return Err(msg);
        }
    }

    let configure_cmd = build_configure_commands(&settings, sudo);

    let (_, cfg_code) = exec_command(&handle, app, &configure_cmd).await?;

    if cfg_code != 0 {
        let msg = "SSH_CONFIG_CREATE_FAILED";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }

    // Verify certs were created
    let (cert_check, cert_code) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/certs/cert.pem && test -f /opt/trusttunnel/certs/key.pem && echo OK"
    ).await?;

    if cert_code != 0 || !cert_check.contains("OK") {
        let msg = "Сертификаты не были созданы. Проверьте логи (openssl/certbot).";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }
    emit_log(app, "info", "Сертификаты созданы ✓");

    // Pre-flight: run endpoint briefly to verify config is valid
    let (preflight, _preflight_code) = exec_command(
        &handle, app,
        &format!("cd /opt/trusttunnel && timeout 2 {sudo}./trusttunnel_endpoint vpn.toml hosts.toml 2>&1 || true")
    ).await?;
    emit_log(app, "debug", &format!("Pre-flight output: {preflight}"));

    // Check for fatal config errors (but ignore timeout exit which is expected)
    if preflight.to_lowercase().contains("error") && preflight.to_lowercase().contains("pars") {
        let msg = format!("SSH_ENDPOINT_CONFIG_ERROR|{}", preflight.trim());
        emit_step(app, "configure", "error", &msg);
        return Err(msg);
    }

    emit_step(app, "configure", "ok", "Конфигурация Endpoint создана и проверена");

    // ── Step 6: Start systemd service ──
    emit_step(app, "service", "progress", "Запуск сервиса...");

    // Stop existing service first, then copy template and restart
    let service_cmds = format!(
        "{sudo}systemctl stop trusttunnel 2>/dev/null; \
         cd /opt/trusttunnel && \
         {sudo}cp -f trusttunnel.service.template /etc/systemd/system/trusttunnel.service 2>/dev/null; \
         {sudo}systemctl daemon-reload && \
         {sudo}systemctl enable --now trusttunnel"
    );

    let (_, svc_code) = exec_command(&handle, app, &service_cmds).await?;

    if svc_code != 0 {
        emit_log(app, "warn", "Failed to start systemd service. Manual setup may be needed.");
    }

    // Wait for service to start and verify it's running
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Check service status
    let (svc_status, _) = exec_command(
        &handle, app,
        &format!("{sudo}systemctl is-active trusttunnel 2>&1")
    ).await?;
    let is_active = svc_status.trim() == "active";

    if !is_active {
        // Get journal logs to diagnose the issue
        let (journal, _) = exec_command(
            &handle, app,
            &format!("{sudo}journalctl -u trusttunnel --no-pager -n 30 2>&1")
        ).await?;
        emit_log(app, "error", &format!("Сервис не запустился. Статус: {}", svc_status.trim()));
        for line in journal.lines().take(30) {
            emit_log(app, "warn", line);
        }

        // Also check the service file contents for debugging
        let (svc_file, _) = exec_command(
            &handle, app,
            "cat /etc/systemd/system/trusttunnel.service 2>&1"
        ).await?;
        emit_log(app, "debug", &format!("Service file:\n{svc_file}"));

        // Check what config files exist
        let (ls_output, _) = exec_command(
            &handle, app,
            "ls -la /opt/trusttunnel/*.toml /opt/trusttunnel/certs/ 2>&1"
        ).await?;
        emit_log(app, "debug", &format!("Config files:\n{ls_output}"));

        let msg = "TrustTunnel Endpoint не запустился. Смотрите логи для диагностики.";
        emit_step(app, "service", "error", msg);
        return Err(msg.into());
    }

    // Check if the port is actually listening
    let listen_port = settings.listen_address.split(':').last().unwrap_or("443");
    let (port_check, _) = exec_command(
        &handle, app,
        &format!("ss -tlnp | grep :{listen_port} || echo 'PORT_NOT_LISTENING'")
    ).await?;

    if port_check.contains("PORT_NOT_LISTENING") {
        emit_log(app, "warn", &format!("Порт {listen_port} ещё не слушает. Возможно, сервису нужно больше времени."));
    } else {
        emit_log(app, "info", &format!("Порт {listen_port} слушает ✓"));
    }

    emit_step(app, "service", "ok", "Сервис запущен и работает");

    // ── Step 7: Generate client config via trusttunnel_endpoint export ──
    emit_step(app, "export", "progress", "Генерация клиентского конфига...");

    // Use the endpoint's own export to get proper config with certificate PEM
    let export_address = if !settings.domain.is_empty() {
        format!("{}:{}", settings.domain, settings.listen_address.split(':').last().unwrap_or("443"))
    } else {
        let port = settings.listen_address.split(':').last().unwrap_or("443");
        format!("{host}:{port}")
    };

    let export_cmd = format!(
        "cd /opt/trusttunnel && {sudo}./trusttunnel_endpoint vpn.toml hosts.toml -c {user} -a {addr} --format toml 2>&1",
        sudo = sudo,
        user = settings.vpn_username,
        addr = export_address,
    );

    let (export_output, export_code) = exec_command(&handle, app, &export_cmd).await?;

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
    let client_toml = format!(
        r#"# TrustTunnel Client Configuration
# Generated by TrustTunnel Setup Wizard

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

    emit_log(app, "debug", &format!("Generated client config:\n{client_toml}"));
    emit_step(app, "export", "ok", "Конфиг сгенерирован");

    // ── Step 8: Save config locally (portable — next to exe) ──
    emit_step(app, "save", "progress", "Сохранение конфигурации...");

    let config_dir = portable_data_dir();

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("SSH_MKDIR_FAILED|{e}"))?;

    let client_config_path = config_dir.join("trusttunnel_client.toml");
    std::fs::write(&client_config_path, &client_toml)
        .map_err(|e| format!("SSH_WRITE_CONFIG_FAILED|{e}"))?;

    let config_path_str = client_config_path.to_string_lossy().to_string();
    emit_log(app, "info", &format!("Конфиг сохранён: {config_path_str}"));
    emit_step(app, "save", "ok", "Конфигурация сохранена");

    // ── Disconnect ──
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();

    emit_step(app, "done", "ok", "Всё готово! Сервер настроен и запущен.");

    Ok(config_path_str)
}

// ─── Diagnose Server ──────────────────────────────

pub async fn diagnose_server(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    let (ls, _) = exec_command(&handle, app, "ls -la /opt/trusttunnel/ 2>&1").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== /opt/trusttunnel/ ===\n{ls}\n"));

    // Service file
    let (svc, _) = exec_command(&handle, app, "cat /etc/systemd/system/trusttunnel.service 2>&1").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== Service file ===\n{svc}\n"));

    // vpn.toml
    let (vpn_cfg, _) = exec_command(&handle, app, "cat /opt/trusttunnel/vpn.toml 2>&1").await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== vpn.toml ===\n{vpn_cfg}\n"));

    // hosts.toml
    let (hosts_cfg, _) = exec_command(&handle, app, "cat /opt/trusttunnel/hosts.toml 2>&1").await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== hosts.toml ===\n{hosts_cfg}\n"));

    // Certs
    let (certs, _) = exec_command(&handle, app, "ls -la /opt/trusttunnel/certs/ 2>&1").await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== Certs ===\n{certs}\n"));

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(report)
}

// ─── Check & Uninstall ────────────────────────────

/// Check if TrustTunnel is already installed on the server.
/// Returns JSON: { installed: bool, version: String, service_active: bool }
pub async fn check_server_installation(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    emit_step(app, "uninstall", "progress", "Подключение к серверу...");

    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await
        .map_err(|e| { emit_step(app, "uninstall", "error", &e); e })?;

    // Determine sudo
    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    emit_step(app, "uninstall", "progress", "Удаление TrustTunnel...");

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

    emit_log(app, "info", "TrustTunnel полностью удалён с сервера");

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "uninstall", "ok", "TrustTunnel удалён");
    Ok(())
}

// ─── Fetch existing config from server ────────────

/// Connect to a server where TrustTunnel is already installed,
/// export the client config via trusttunnel_endpoint, and save it locally.
pub async fn fetch_server_config(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
    client_name: String,
) -> Result<String, String> {
    emit_step(app, "connect", "progress", "Подключение к серверу...");
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Подключено к серверу");
    emit_step(app, "auth", "ok", "Авторизация успешна");

    // Check TrustTunnel is installed
    emit_step(app, "check", "progress", "Проверка TrustTunnel на сервере...");

    let (bin_check, _) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/trusttunnel_endpoint && echo TT_EXISTS || echo TT_MISSING"
    ).await?;

    if !bin_check.contains("TT_EXISTS") {
        let msg = "TrustTunnel не найден на сервере (/opt/trusttunnel/trusttunnel_endpoint)";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    // Check config files exist
    let (cfg_check, _) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/vpn.toml && test -f /opt/trusttunnel/hosts.toml && echo CFG_OK || echo CFG_MISSING"
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        let msg = "Конфигурационные файлы не найдены на сервере (vpn.toml / hosts.toml)";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "check", "ok", "TrustTunnel установлен, конфиг найден");

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
        format!("{host}:{listen_port}")
    };

    emit_step(app, "export", "progress", "Экспорт клиентского конфига...");

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
        emit_log(app, "info", &format!("Имя клиента не указано, используется: {first}"));
        first.to_string()
    } else {
        "client".to_string()
    };

    if !available_users.is_empty() {
        emit_log(app, "info", &format!("Доступные пользователи: {}", available_users.join(", ")));
        if !available_users.iter().any(|u| *u == name.as_str()) {
            let msg = format!(
                "Пользователь '{}' не найден в credentials.toml. Доступные: {}",
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

    let client_toml = format!(
        r#"# TrustTunnel Client Configuration
# Fetched from server {host}

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

    emit_step(app, "export", "ok", "Конфиг получен");

    // Save locally
    emit_step(app, "save", "progress", "Сохранение конфигурации...");

    let config_dir = portable_data_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("SSH_MKDIR_FAILED|{e}"))?;

    let client_config_path = config_dir.join("trusttunnel_client.toml");
    std::fs::write(&client_config_path, &client_toml)
        .map_err(|e| format!("SSH_WRITE_CONFIG_FAILED|{e}"))?;

    let config_path_str = client_config_path.to_string_lossy().to_string();
    emit_log(app, "info", &format!("Конфиг сохранён: {config_path_str}"));
    emit_step(app, "save", "ok", "Конфигурация сохранена");

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "done", "ok", "Конфиг успешно получен с сервера!");

    Ok(config_path_str)
}

// ─── Add user to server ────────────────────────────

/// SSH to the server, append a new [[client]] entry to credentials.toml,
/// restart the service, export the client config, and save it locally.
pub async fn add_server_user(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
    vpn_username: String,
    vpn_password: String,
) -> Result<String, String> {
    emit_step(app, "connect", "progress", "Подключение к серверу...");
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Подключено к серверу");
    emit_step(app, "auth", "ok", "Авторизация успешна");

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Check that credentials.toml exists
    emit_step(app, "check", "progress", "Проверка конфигурации...");

    let (cfg_check, _) = exec_command(
        &handle, app,
        "test -f /opt/trusttunnel/credentials.toml && echo CFG_OK || echo CFG_MISSING"
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        let msg = "credentials.toml не найден на сервере";
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
        let msg = format!("Пользователь '{}' уже существует на сервере", vpn_username);
        emit_step(app, "check", "error", &msg);
        return Err(msg);
    }

    emit_step(app, "check", "ok", "Конфигурация проверена");

    // Append new [[client]] block to credentials.toml
    emit_step(app, "configure", "progress", &format!("Добавление пользователя '{}'...", vpn_username));

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

    emit_step(app, "configure", "ok", "Пользователь добавлен");

    // Restart service to pick up new credentials
    emit_step(app, "service", "progress", "Перезапуск сервиса...");

    let (_, restart_code) = exec_command(
        &handle, app,
        &format!("{sudo}systemctl restart trusttunnel 2>&1")
    ).await?;

    if restart_code != 0 {
        emit_log(app, "warn", "Failed to restart service. Manual restart may be needed.");
    }

    // Wait for service to start
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    emit_step(app, "service", "ok", "Сервис перезапущен");

    // User added — config download is done separately via UI
    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "done", "ok", &format!("Пользователь '{}' добавлен!", vpn_username));

    Ok(vpn_username)
}

// ─── Utility functions ─────────────────────────────

/// Check if another trusttunnel_client process is running.
pub fn check_process_conflict() -> Option<String> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq trusttunnel_client*", "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        if text.contains("trusttunnel_client") {
            return Some("Обнаружен запущенный процесс TrustTunnel. Завершить его?".into());
        }
    }
    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("pgrep")
            .args(["-f", "trusttunnel_client"])
            .output()
            .ok()?;
        if output.status.success() {
            return Some("Обнаружен запущенный процесс TrustTunnel. Завершить его?".into());
        }
    }
    None
}

// ─── Server Management Functions ──────────────────

/// Restart the TrustTunnel service on the remote server.
pub async fn server_restart_service(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Fire and forget — the connection will drop when the server reboots
    let _ = exec_command(&handle, app, &format!("{sudo}reboot")).await;

    Ok(())
}

/// Fetch service logs from the remote server.
pub async fn server_get_logs(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
    vpn_username: String,
) -> Result<(), String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
        return Err("Пользователь удалён, но не удалось перезапустить сервис".into());
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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
    version: String,
) -> Result<(), String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
        return Err(format!("Обновление завершилось с ошибкой (код {install_code})"));
    }

    // Restart service
    let (_, restart_code) = exec_command(
        &handle, app,
        &format!("{sudo}systemctl restart trusttunnel 2>&1"),
    ).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if restart_code != 0 {
        return Err("Обновление выполнено, но не удалось перезапустить сервис".into());
    }

    Ok(())
}

/// Get server resource stats: CPU, RAM, disk, active VPN connections.
pub async fn server_get_stats(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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

/// Kill any running trusttunnel_client processes.
pub fn kill_existing_process() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/IM", "trusttunnel_client*"])
            .output()
            .map_err(|e| format!("SSH_KILL_PROCESS_FAILED|{e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("pkill")
            .args(["-f", "trusttunnel_client"])
            .output()
            .map_err(|e| format!("SSH_KILL_PROCESS_FAILED|{e}"))?;
    }
    Ok(())
}

// ─── Get server vpn.toml config ───────────────────

/// Read the raw vpn.toml configuration from the remote server.
pub async fn get_server_config(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
    client_name: String,
) -> Result<String, String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
        format!("{host}:{listen_port}")
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
    host: String,
    port: u16,
    ssh_user: String,
    ssh_password: String,
    key_path: Option<String>,
    feature: String,
    enabled: bool,
) -> Result<(), String> {
    let handle = ssh_connect(&host, port, &ssh_user, &ssh_password, key_path.as_deref()).await?;

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
