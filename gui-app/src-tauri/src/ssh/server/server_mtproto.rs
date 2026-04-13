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

/// Parse mtg TOML config to extract secret and bind port.
fn parse_mtg_config(raw: &str) -> (String, u16) {
    let mut secret = String::new();
    let mut port: u16 = 0;
    for line in raw.lines() {
        let line = line.trim();
        if line.starts_with("secret") {
            if let Some(val) = line.split('=').nth(1) {
                secret = val.trim().trim_matches('"').to_string();
            }
        }
        if line.starts_with("bind-to") {
            if let Some(val) = line.split('=').nth(1) {
                let bind = val.trim().trim_matches('"');
                if let Some(port_str) = bind.rsplit(':').next() {
                    port = port_str.parse().unwrap_or(0);
                }
            }
        }
    }
    (secret, port)
}

/// Build tg:// proxy link.
fn build_proxy_link(host: &str, port: u16, secret: &str) -> String {
    format!("tg://proxy?server={host}&port={port}&secret={secret}")
}

/// Validate hex secret format (STRIDE T-04-02 mitigation).
fn is_valid_hex_secret(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && s.chars().all(|c| c.is_ascii_hexdigit())
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
        "test -f /usr/local/bin/mtg && echo INSTALLED || echo NOT_INSTALLED",
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
        &format!("{sudo}systemctl is-active mtg 2>/dev/null || echo inactive"),
    )
    .await?;
    let active = svc_out.trim() == "active";

    // Read config
    let (cfg_out, _) =
        exec_command(handle, app, "cat /etc/mtg/config.toml 2>/dev/null || echo ''").await?;
    let (secret, port) = parse_mtg_config(&cfg_out);

    // Validate secret and build link
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
        // Auto-select a random free port
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
        // Validate range
        if mtproto_port < 1024 {
            return Err(format!("MTPROTO_INVALID_PORT|{mtproto_port}"));
        }
        // Check port is free
        let (busy_out, _) = exec_command(
            &handle,
            app,
            &format!(
                "ss -tlnp | grep -q ':{mtproto_port} ' && echo BUSY || echo FREE"
            ),
        )
        .await?;
        if busy_out.trim().contains("BUSY") {
            return Err(format!("MTPROTO_PORT_BUSY|{mtproto_port}"));
        }
        mtproto_port
    };

    // ── Step: download ──
    emit_mtproto_step(app, "download", "running", "");
    let (dl_out, _) = exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'set -e; \
             ASSET_URL=$(curl -sL https://api.github.com/repos/9seconds/mtg/releases/latest \
             | grep browser_download_url | grep linux-amd64.tar.gz | grep -v amd64-v3 | head -1 \
             | cut -d\"\\\"\" -f4); \
             if [ -z \"$ASSET_URL\" ]; then echo DOWNLOAD_FAILED; exit 1; fi; \
             curl -sL -o /tmp/mtg.tar.gz \"$ASSET_URL\" && \
             rm -rf /tmp/mtg-extract && mkdir -p /tmp/mtg-extract && \
             tar -xzf /tmp/mtg.tar.gz -C /tmp/mtg-extract --strip-components=1 && \
             mv /tmp/mtg-extract/mtg /usr/local/bin/mtg && \
             chmod +x /usr/local/bin/mtg && \
             rm -rf /tmp/mtg.tar.gz /tmp/mtg-extract && echo DOWNLOAD_OK'"
        ),
    )
    .await?;
    if !dl_out.contains("DOWNLOAD_OK") {
        emit_mtproto_step(app, "download", "error", "Download failed");
        return Err("MTPROTO_DOWNLOAD_FAILED".into());
    }
    emit_mtproto_step(app, "download", "done", "");

    // ── Step: configure ──
    emit_mtproto_step(app, "configure", "running", "");

    // Check existing config for secret reuse
    let (cfg_out, _) =
        exec_command(&handle, app, "cat /etc/mtg/config.toml 2>/dev/null || echo ''").await?;
    let (existing_secret, _) = parse_mtg_config(&cfg_out);

    let secret = if is_valid_hex_secret(&existing_secret) {
        existing_secret
    } else {
        // Generate new secret
        let (secret_out, _) = exec_command(
            &handle,
            app,
            &format!("{sudo}/usr/local/bin/mtg generate-secret --hex google.com"),
        )
        .await?;
        let gen_secret = secret_out.trim().to_string();
        if !is_valid_hex_secret(&gen_secret) {
            emit_mtproto_step(app, "configure", "error", "Invalid secret generated");
            return Err("MTPROTO_SECRET_INVALID".into());
        }
        gen_secret
    };

    // Create config directory and write config
    exec_command(&handle, app, &format!("{sudo}mkdir -p /etc/mtg")).await?;
    exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'cat > /etc/mtg/config.toml << MTGEOF\nsecret = \"{secret}\"\nbind-to = \"0.0.0.0:{port}\"\nMTGEOF'"
        ),
    )
    .await?;
    emit_mtproto_step(app, "configure", "done", "");

    // ── Step: generate_secret (emit for UI, creates systemd unit) ──
    emit_mtproto_step(app, "generate_secret", "running", "");
    exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'cat > /etc/systemd/system/mtg.service << MTGEOF\n\
             [Unit]\n\
             Description=mtg MTProto proxy\n\
             After=network.target\n\
             \n\
             [Service]\n\
             ExecStart=/usr/local/bin/mtg run /etc/mtg/config.toml\n\
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
    emit_mtproto_step(app, "generate_secret", "done", "");

    // ── Step: start_service ──
    emit_mtproto_step(app, "start_service", "running", "");

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
            "{sudo}systemctl daemon-reload && {sudo}systemctl enable mtg && {sudo}systemctl start mtg"
        ),
    )
    .await?;

    // Verify active
    let (active_out, _) =
        exec_command(&handle, app, &format!("{sudo}systemctl is-active mtg")).await?;
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

    // Read config to get port for firewall cleanup
    let (cfg_out, _) =
        exec_command(&handle, app, "cat /etc/mtg/config.toml 2>/dev/null || echo ''").await?;
    let (_, port) = parse_mtg_config(&cfg_out);

    // Stop and disable service
    exec_command(
        &handle,
        app,
        &format!("{sudo}systemctl stop mtg 2>/dev/null; {sudo}systemctl disable mtg 2>/dev/null; echo STOP_OK"),
    )
    .await?;

    // Remove systemd unit
    exec_command(
        &handle,
        app,
        &format!("{sudo}rm -f /etc/systemd/system/mtg.service && {sudo}systemctl daemon-reload"),
    )
    .await?;

    // Remove binary
    exec_command(&handle, app, &format!("{sudo}rm -f /usr/local/bin/mtg")).await?;

    // Remove config directory
    exec_command(&handle, app, &format!("{sudo}rm -rf /etc/mtg")).await?;

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
