use super::super::*;
use russh::client;
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// UAT 2026-05-20 — cancel checkpoint for MTProto install.
///
/// Returns `Err("MTPROTO_INSTALL_CANCELLED")` if the cancel flag is set.
/// Called between each `exec_command` step in `mtproto_install` so the user's
/// «Отменить» click during install reacts as soon as the current ssh command
/// returns (typical latency: ≤ duration of one step like `apt-get install`).
#[inline]
fn check_cancel(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        Err("MTPROTO_INSTALL_CANCELLED".into())
    } else {
        Ok(())
    }
}

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
    cancel_flag: Arc<AtomicBool>,
) -> Result<MtProtoStatus, String> {
    let handle = params.connect_with_app(app.clone()).await?;
    let sudo = detect_sudo(&handle, app).await;
    check_cancel(&cancel_flag)?;

    // ── Preflight cleanup (UAT 2026-05-20) ──
    //
    // Aggressively dispose of anything left over from a previous install
    // attempt BEFORE we check the port for conflicts. Without this, a stale
    // MTProxy unit/binary holds the user's chosen port and the install dies
    // with `MTPROTO_PORT_BUSY` — leaving them to run cleanup commands by hand.
    //
    //   1) `systemctl stop MTProxy`     — graceful shutdown
    //   2) `systemctl disable MTProxy`  — kill Restart=always auto-revive loop
    //   3) `pkill -f mtproto-proxy`     — covers stale binaries that detached
    //                                     from the unit (manual kill -9, etc.)
    //   4) `rm -f /etc/systemd/system/MTProxy.service` + `daemon-reload`
    //                                   — purge the old unit so the new
    //                                     install starts from a clean slate
    //
    // Errors silenced (`|| true`) — preflight must never abort a fresh install.
    exec_command(
        &handle,
        app,
        &format!(
            "{sudo}systemctl stop MTProxy 2>/dev/null; \
             {sudo}systemctl disable MTProxy 2>/dev/null; \
             {sudo}pkill -f /opt/MTProxy/mtproto-proxy 2>/dev/null; \
             {sudo}rm -f /etc/systemd/system/MTProxy.service 2>/dev/null; \
             {sudo}systemctl daemon-reload 2>/dev/null; \
             true"
        ),
    )
    .await
    .ok();

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
        if auto_port == 0 || auto_port < 1024 {
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

    // Install build dependencies.
    //
    // UAT 2026-05-20 — wrapped in `bash -c` with explicit non-interactive envs
    // because on Ubuntu 24.04 `needrestart` (pulled in transitively by
    // build-essential) prints a TUI prompt asking which services to restart.
    // Over SSH that prompt blocks stdin forever → russh sees no progress on
    // the channel → SSH_CHANNEL_FAILED|Channel send error after ~60s timeout.
    //
    // sudo strips env vars by default (env_reset in sudoers), so setting
    // DEBIAN_FRONTEND/NEEDRESTART_MODE before `{sudo}apt-get` doesn't reach
    // dpkg. Doing `{sudo}bash -c '...'` first elevates, then exporting envs
    // INSIDE the elevated shell — they propagate to every subsequent
    // apt-get / dpkg invocation.
    //
    //   DEBIAN_FRONTEND=noninteractive — disable any debconf TUI prompts
    //   NEEDRESTART_MODE=a              — auto-restart services, no prompt
    //   NEEDRESTART_SUSPEND=1           — alt switch in case MODE is ignored
    //   --force-confdef/--force-confold — keep existing config files, don't
    //                                     ask user about changes
    let (deps_out, deps_code) = exec_command(
        &handle,
        app,
        &format!(
            "{sudo}bash -c 'export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 APT_LISTCHANGES_FRONTEND=none; \
             apt-get update -qq && \
             apt-get install -y -qq \
               -o Dpkg::Options::=\"--force-confdef\" \
               -o Dpkg::Options::=\"--force-confold\" \
               git curl build-essential libssl-dev zlib1g-dev 2>&1 && echo DEPS_OK'"
        ),
    )
    .await?;
    if !deps_out.contains("DEPS_OK") {
        emit_mtproto_step(app, "download", "error", "Failed to install build dependencies");
        return Err(format!("MTPROTO_DEPS_FAILED|{}", deps_code));
    }
    check_cancel(&cancel_flag)?;

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
    check_cancel(&cancel_flag)?;

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
    check_cancel(&cancel_flag)?;

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

    // Final validation guard: secret may come from existing env file (user-editable),
    // so re-validate right before embedding in shell heredoc to prevent injection.
    if !is_valid_hex_secret(&secret) {
        return Err("MTPROTO_SECRET_INVALID".into());
    }

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
    check_cancel(&cancel_flag)?;

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

    // Verify active — retry up to 6 times with 1s sleep between attempts.
    // UAT 2026-05-20: `systemctl is-active` immediately after `start` often
    // returns "activating" before the service binds to its port. Without
    // retries we returned MTPROTO_START_FAILED even though the service was
    // about to become healthy (reopening the modal showed it as installed).
    let mut active = false;
    for attempt in 0..6 {
        let (active_out, _) =
            exec_command(&handle, app, &format!("{sudo}systemctl is-active MTProxy")).await?;
        if active_out.trim() == "active" {
            active = true;
            break;
        }
        if attempt < 5 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    if !active {
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
//   mtproto_start / mtproto_stop — pooled, quick state toggles
// ═══════════════════════════════════════════════════════════════
//
// UAT 2026-05-21 — user sees status «Установлен, не запущен» after
// install (or after a reboot / crash-loop give-up by systemd). Without
// a Start button in the modal there's no recovery path — they'd have
// to ssh in and run `systemctl start MTProxy` by hand. These two verbs
// expose the toggle. Both pull a fresh MtProtoStatus on return so the
// caller can immediately re-render (no extra get_status round-trip).

pub async fn mtproto_start(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    host: &str,
) -> Result<MtProtoStatus, String> {
    let sudo = detect_sudo(handle, app).await;
    // `systemctl start` is fire-and-forget; service may take a beat to
    // bind its port. Same 6×1s retry pattern as install — accommodates
    // Ubuntu 24.04's «activating» → «active» window without flagging a
    // false START_FAILED for a service that's actually about to come up.
    exec_command(handle, app, &format!("{sudo}systemctl start MTProxy")).await?;
    for attempt in 0..6 {
        let (out, _) = exec_command(
            handle,
            app,
            &format!("{sudo}systemctl is-active MTProxy"),
        )
        .await?;
        if out.trim() == "active" {
            break;
        }
        if attempt < 5 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    // Re-read full status (port + secret + proxy_link).
    mtproto_get_status(app, handle, host).await
}

pub async fn mtproto_stop(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    host: &str,
) -> Result<MtProtoStatus, String> {
    let sudo = detect_sudo(handle, app).await;
    exec_command(handle, app, &format!("{sudo}systemctl stop MTProxy 2>/dev/null; echo STOP_OK")).await?;
    mtproto_get_status(app, handle, host).await
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

    // Close firewall port.
    //
    // UAT 2026-05-20 — switched from `ufw delete allow {port}/tcp` to
    // delete-by-number because the spec form silently fails when the rule
    // carries comment metadata (`ufw allow {port}/tcp comment 'MTProto'`
    // is what install adds). Symptom: user uninstalls, reopens Брандмауэр
    // modal, MTProto rule is still there.
    //
    // Approach:
    //   1) Enumerate every rule whose `to` column matches `{port}/tcp` via
    //      `ufw status numbered` (matches IPv4 + IPv6 pair, and rules with
    //      `comment '...'` since grep doesn't care about trailing fields).
    //   2) Sort numbers DESCENDING — deleting a rule renumbers everything
    //      below it, so we work from the bottom up to keep indices stable.
    //   3) `yes | ufw delete N` to bypass the interactive confirm prompt.
    //   4) Belt-and-suspenders: also try `ufw delete allow {port}/tcp` as a
    //      no-op fallback (covers edge cases where status output format
    //      drifts between distros).
    //
    // `<<'UFWEOF'` (single-quoted heredoc terminator) prevents the OUTER
    // shell from expanding $NUMBERS / $N — those get expanded by the bash
    // instance that receives the heredoc body via stdin, at execution time.
    if port > 0 {
        exec_command(
            &handle,
            app,
            &format!(
                "{sudo}bash <<'UFWEOF'\n\
NUMBERS=$({sudo}ufw status numbered 2>/dev/null | grep '{port}/tcp' | sed -E 's/^\\[ *([0-9]+)\\].*/\\1/' | sort -rn)\n\
for N in $NUMBERS; do\n\
  yes | {sudo}ufw delete $N >/dev/null 2>&1 || true\n\
done\n\
{sudo}ufw delete allow {port}/tcp >/dev/null 2>&1 || true\n\
echo FW_OK\n\
UFWEOF\n"
            ),
        )
        .await?;
    }

    Ok(())
}
