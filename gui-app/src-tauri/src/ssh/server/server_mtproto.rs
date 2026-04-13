use super::super::*;
use russh::client;
use serde::Serialize;

// ═══════════════════════════════════════════════════════════════
//   Data structures (mirrored on TS side)
// ═══════════════════════════════════════════════════════════════

#[derive(Clone, Serialize)]
pub struct MtProtoStatus {
    pub installed: bool,
    pub active: bool,
    pub port: u16,
    pub secret: String,
    pub proxy_link: String,
}

#[derive(Clone, Serialize)]
pub struct MtProtoInstallStep {
    pub step: String,   // "download" | "configure" | "generate_secret" | "start_service" | "complete"
    pub status: String, // "running" | "done" | "error"
    pub message: String,
}

// ═══════════════════════════════════════════════════════════════
//   Helpers
// ═══════════════════════════════════════════════════════════════

fn emit_mtproto_step(app: &tauri::AppHandle, step: &str, status: &str, msg: &str) {
    use tauri::Emitter;
    app.emit(
        "mtproto-install-step",
        MtProtoInstallStep {
            step: step.into(),
            status: status.into(),
            message: msg.into(),
        },
    )
    .ok();
}

/// Parse MTProxy environment file to extract secret and port.
/// Format: KEY=VALUE lines (SECRET=..., PORT=..., TAG=...)
fn parse_mtproxy_env(raw: &str) -> (String, u16) {
    let mut secret = String::new();
    let mut port: u16 = 0;
    for line in raw.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("SECRET=") {
            secret = val.trim().to_string();
        }
        if let Some(val) = line.strip_prefix("PORT=") {
            port = val.trim().parse().unwrap_or(0);
        }
    }
    (secret, port)
}

/// Build tg:// proxy link with dd prefix for random padding (anti-DPI).
fn build_proxy_link(host: &str, port: u16, secret: &str) -> String {
    format!("tg://proxy?server={host}&port={port}&secret=dd{secret}")
}

/// Validate hex secret format (32 hex chars = 16 bytes).
fn is_valid_hex_secret(s: &str) -> bool {
    s.len() == 32 && s.chars().all(|c| c.is_ascii_hexdigit())
}

// ═══════════════════════════════════════════════════════════════
//   mtproto_get_status — pooled, quick status check
// ═══════════════════════════════════════════════════════════════

pub async fn mtproto_get_status(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    host: &str,
) -> Result<MtProtoStatus, String> {
    let sudo = detect_sudo(handle, app).await;

    // Check binary
    let (out, _) = exec_command(
        handle,
        app,
        "test -f /opt/MTProxy/mtproto-proxy && echo INSTALLED || echo NOT_INSTALLED",
    )
    .await?;
    if out.trim().contains("NOT_INSTALLED") {
        return Ok(MtProtoStatus {
            installed: false,
            active: false,
            port: 0,
            secret: String::new(),
            proxy_link: String::new(),
        });
    }

    // Check service active
    let (svc_out, _) = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl is-active MTProxy 2>/dev/null || echo inactive"),
    )
    .await?;
    let active = svc_out.trim() == "active";

    // Read env config
    let (cfg_out, _) = exec_command(
        handle,
        app,
        "cat /etc/mtproxy.env 2>/dev/null || echo ''",
    )
    .await?;
    let (secret, port) = parse_mtproxy_env(&cfg_out);

    // Build link
    let proxy_link = if is_valid_hex_secret(&secret) && port > 0 {
        build_proxy_link(host, port, &secret)
    } else {
        String::new()
    };

    Ok(MtProtoStatus {
        installed: true,
        active,
        port,
        secret,
        proxy_link,
    })
}

// ═══════════════════════════════════════════════════════════════
//   mtproto_install — direct connect, long-running
//   Uses official TelegramMessenger/MTProxy (C implementation)
// ═══════════════════════════════════════════════════════════════

pub async fn mtproto_install(
    app: &tauri::AppHandle,
    params: SshParams,
    mtproto_port: u16,
) -> Result<MtProtoStatus, String> {
    let handle = params.connect_with_app(app.clone()).await?;
    let sudo = detect_sudo(&handle, app).await;

    // ── Validate / resolve port ──
    let port: u16 = if mtproto_port == 0 {
        emit_mtproto_step(app, "download", "running", "Finding free port...");
        let (port_out, _) = exec_command(
            &handle,
            app,
            "port=0; for i in $(shuf -i 10000-60000 -n 20); do ss -tlnp | grep -q \":$i \" || { port=$i; break; }; done; echo $port",
        )
        .await?;
        let auto_port: u16 = port_out.trim().parse().unwrap_or(0);
        if auto_port == 0 {
            emit_mtproto_step(app, "download", "error", "No free port found");
            return Err("MTPROTO_NO_FREE_PORT".into());
        }
        auto_port
    } else {
        if mtproto_port < 1024 {
            return Err(format!("MTPROTO_INVALID_PORT|{mtproto_port}"));
        }
        let (busy_out, _) = exec_command(
            &handle,
            app,
            &format!("ss -tlnp | grep -q ':{mtproto_port} ' && echo BUSY || echo FREE"),
        )
        .await?;
        if busy_out.trim().contains("BUSY") {
            return Err(format!("MTPROTO_PORT_BUSY|{mtproto_port}"));
        }
        mtproto_port
    };

    // ── Step: download (install deps + clone + build) ──
    emit_mtproto_step(app, "download", "running", "");

    // Install build dependencies
    let (deps_out, deps_code) = exec_command(
        &handle,
        app,
        &format!("{sudo}apt-get update -qq && {sudo}apt-get install -y -qq git curl build-essential libssl-dev zlib1g-dev 2>&1 && echo DEPS_OK"),
    )
    .await?;
    if !deps_out.contains("DEPS_OK") {
        emit_mtproto_step(app, "download", "error", "Failed to install build dependencies");
        return Err(format!("MTPROTO_DEPS_FAILED|{}", deps_code));
    }

    // Clone and build MTProxy
    let (build_out, _) = exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'set -e; \
             rm -rf /opt/MTProxy && \
             git clone https://github.com/TelegramMessenger/MTProxy.git /opt/MTProxy && \
             cd /opt/MTProxy && \
             make -j$(nproc) 2>&1 && \
             test -f /opt/MTProxy/objs/bin/mtproto-proxy && \
             ln -sf /opt/MTProxy/objs/bin/mtproto-proxy /opt/MTProxy/mtproto-proxy && \
             echo BUILD_OK'"
        ),
    )
    .await?;
    if !build_out.contains("BUILD_OK") {
        emit_mtproto_step(app, "download", "error", "Build failed");
        return Err("MTPROTO_BUILD_FAILED".into());
    }
    emit_mtproto_step(app, "download", "done", "");

    // ── Step: configure (download proxy-secret + proxy-multi.conf) ──
    emit_mtproto_step(app, "configure", "running", "");

    let (cfg_ok, _) = exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'set -e; \
             curl -s https://core.telegram.org/getProxySecret -o /opt/MTProxy/proxy-secret && \
             curl -s https://core.telegram.org/getProxyConfig -o /opt/MTProxy/proxy-multi.conf && \
             test -s /opt/MTProxy/proxy-secret && \
             test -s /opt/MTProxy/proxy-multi.conf && \
             echo CONFIG_OK'"
        ),
    )
    .await?;
    if !cfg_ok.contains("CONFIG_OK") {
        emit_mtproto_step(app, "configure", "error", "Failed to download Telegram configs");
        return Err("MTPROTO_CONFIG_DOWNLOAD_FAILED".into());
    }
    emit_mtproto_step(app, "configure", "done", "");

    // ── Step: generate_secret ──
    emit_mtproto_step(app, "generate_secret", "running", "");

    // Check existing env for secret reuse (MTPROTO-07)
    let (env_out, _) = exec_command(
        &handle,
        app,
        "cat /etc/mtproxy.env 2>/dev/null || echo ''",
    )
    .await?;
    let (existing_secret, _) = parse_mtproxy_env(&env_out);

    let secret = if is_valid_hex_secret(&existing_secret) {
        existing_secret
    } else {
        // Generate new 16-byte hex secret (openssl is always available, xxd may not be)
        let (secret_out, _) = exec_command(
            &handle,
            app,
            "openssl rand -hex 16",
        )
        .await?;
        let gen_secret = secret_out.trim().to_string();
        if !is_valid_hex_secret(&gen_secret) {
            emit_mtproto_step(app, "generate_secret", "error", "Invalid secret generated");
            return Err("MTPROTO_SECRET_INVALID".into());
        }
        gen_secret
    };

    // Save env config for persistence
    exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'cat > /etc/mtproxy.env << ENVEOF\nSECRET={secret}\nPORT={port}\nENVEOF'"
        ),
    )
    .await?;
    emit_mtproto_step(app, "generate_secret", "done", "");

    // ── Step: start_service (create systemd unit + firewall + start) ──
    emit_mtproto_step(app, "start_service", "running", "");

    // Create systemd unit
    exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'cat > /etc/systemd/system/MTProxy.service << MTGEOF\n\
             [Unit]\n\
             Description=Telegram MTProxy\n\
             After=network.target\n\
             \n\
             [Service]\n\
             Type=simple\n\
             WorkingDirectory=/opt/MTProxy\n\
             ExecStart=/opt/MTProxy/mtproto-proxy -u nobody -p 8888 -H {port} -S {secret} --aes-pwd /opt/MTProxy/proxy-secret /opt/MTProxy/proxy-multi.conf -M 1\n\
             Restart=always\n\
             RestartSec=3\n\
             LimitNOFILE=65536\n\
             \n\
             [Install]\n\
             WantedBy=multi-user.target\n\
             MTGEOF'"
        ),
    )
    .await?;

    // Open firewall port
    exec_command(
        &handle,
        app,
        &format!("{sudo}ufw allow {port}/tcp comment 'MTProto' 2>/dev/null; echo FW_OK"),
    )
    .await?;

    // Enable and start service
    exec_command(
        &handle,
        app,
        &format!(
            "{sudo}systemctl daemon-reload && {sudo}systemctl enable MTProxy && {sudo}systemctl start MTProxy"
        ),
    )
    .await?;

    // Verify active
    let (active_out, _) =
        exec_command(&handle, app, &format!("{sudo}systemctl is-active MTProxy")).await?;
    if active_out.trim() != "active" {
        emit_mtproto_step(app, "start_service", "error", "Service failed to start");
        return Err("MTPROTO_START_FAILED".into());
    }
    emit_mtproto_step(app, "start_service", "done", "");

    // ── Step: complete ──
    emit_mtproto_step(app, "complete", "done", "");

    let proxy_link = build_proxy_link(&params.host, port, &secret);
    Ok(MtProtoStatus {
        installed: true,
        active: true,
        port,
        secret,
        proxy_link,
    })
}

// ═══════════════════════════════════════════════════════════════
//   mtproto_uninstall — direct connect
// ═══════════════════════════════════════════════════════════════

pub async fn mtproto_uninstall(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect_with_app(app.clone()).await?;
    let sudo = detect_sudo(&handle, app).await;

    // Read env config to get port for firewall cleanup
    let (cfg_out, _) = exec_command(
        &handle,
        app,
        "cat /etc/mtproxy.env 2>/dev/null || echo ''",
    )
    .await?;
    let (_, port) = parse_mtproxy_env(&cfg_out);

    // Stop and disable service
    exec_command(
        &handle,
        app,
        &format!("{sudo}systemctl stop MTProxy 2>/dev/null; {sudo}systemctl disable MTProxy 2>/dev/null; echo STOP_OK"),
    )
    .await?;

    // Remove systemd unit
    exec_command(
        &handle,
        app,
        &format!("{sudo}rm -f /etc/systemd/system/MTProxy.service && {sudo}systemctl daemon-reload"),
    )
    .await?;

    // Remove MTProxy directory (source + binary)
    exec_command(&handle, app, &format!("{sudo}rm -rf /opt/MTProxy")).await?;

    // Remove env config
    exec_command(&handle, app, &format!("{sudo}rm -f /etc/mtproxy.env")).await?;

    // Close firewall port
    if port > 0 {
        exec_command(
            &handle,
            app,
            &format!("{sudo}ufw delete allow {port}/tcp 2>/dev/null; echo FW_OK"),
        )
        .await?;
    }

    Ok(())
}
