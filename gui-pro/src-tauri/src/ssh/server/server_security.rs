use super::super::*;
use russh::client;
use serde::{Deserialize, Serialize};

// ═══════════════════════════════════════════════════════════════
//   Data structures (mirrored on TS side)
// ═══════════════════════════════════════════════════════════════

#[derive(Clone, Serialize)]
pub struct SecurityStatus {
    pub fail2ban: Fail2banStatus,
    pub firewall: FirewallStatus,
}

#[derive(Clone, Serialize)]
pub struct Fail2banStatus {
    pub installed: bool,
    pub active: bool,
    pub jails: Vec<JailInfo>,
}

#[derive(Clone, Serialize)]
pub struct JailInfo {
    pub name: String,
    pub enabled: bool,
    pub currently_failed: u32,
    pub total_failed: u32,
    pub currently_banned: u32,
    pub total_banned: u32,
    pub banned_ips: Vec<String>,
    pub maxretry: u32,
    pub bantime: String,
    pub findtime: String,
}

#[derive(Clone, Serialize)]
pub struct FirewallStatus {
    pub installed: bool,
    pub active: bool,
    pub default_in: String,
    pub default_out: String,
    pub default_routed: String,
    pub logging: String,
    pub rules: Vec<FirewallRule>,
    /// Detected SSH port we used for the current connection — informational, used by UI to warn user.
    pub current_ssh_port: u16,
    /// Detected VPN port from vpn.toml.
    pub vpn_port: Option<u16>,
}

#[derive(Clone, Serialize)]
pub struct FirewallRule {
    pub number: u32,
    pub to: String,
    pub from: String,
    pub action: String,
    pub proto: String,
    pub comment: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFirewallRule {
    pub port: String,           // "443", "80:90", "443"
    pub proto: String,          // "tcp" | "udp" | "any"
    pub action: String,         // "allow" | "deny" | "limit" | "reject"
    #[serde(default)]
    pub from: String,           // "any" or "1.2.3.4" or "1.2.3.0/24"
    #[serde(default)]
    pub comment: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JailConfigUpdate {
    pub enabled: bool,
    pub maxretry: u32,
    pub bantime: String,
    pub findtime: String,
}

// ═══════════════════════════════════════════════════════════════
//   SSH Service Type (socket activation vs classic service)
// ═══════════════════════════════════════════════════════════════

#[derive(Copy, Clone)]
enum SshServiceType {
    /// Ubuntu 24.04+ uses systemd socket activation (ssh.socket)
    Socket,
    /// Ubuntu 22.04, Debian 11/12 use classic ssh.service
    Service,
}

async fn detect_ssh_service_type(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<SshServiceType, String> {
    // Check ssh.socket first (Ubuntu 24.04+)
    let (socket_raw, _) = exec_command(
        handle, app,
        &format!("{sudo}systemctl is-active ssh.socket 2>/dev/null || echo inactive"),
    ).await?;
    if socket_raw.trim() == "active" {
        return Ok(SshServiceType::Socket);
    }

    // Check classic ssh.service (Ubuntu 22.04, Debian 11/12)
    let (service_raw, _) = exec_command(
        handle, app,
        &format!("{sudo}systemctl is-active ssh.service 2>/dev/null || echo inactive"),
    ).await?;
    if service_raw.trim() == "active" {
        return Ok(SshServiceType::Service);
    }

    Err("SSH_UNSUPPORTED_OS".into())
}

// ═══════════════════════════════════════════════════════════════
//   Helpers
// ═══════════════════════════════════════════════════════════════

// detect_sudo() is now centralized in ssh/mod.rs

// ─── Input validators (reject shell metacharacters BEFORE building commands) ──

/// Port, port-range "80:90", or numeric port. Max 11 chars.
fn is_safe_port(s: &str) -> bool {
    !s.is_empty() && s.len() <= 11 && s.chars().all(|c| c.is_ascii_digit() || c == ':')
}
/// "tcp" | "udp" | "any"
fn is_safe_proto(s: &str) -> bool { matches!(s, "tcp" | "udp" | "any" | "") }
/// "allow" | "deny" | "limit" | "reject"
fn is_safe_action(s: &str) -> bool { matches!(s, "allow" | "deny" | "limit" | "reject") }
/// IPv4/IPv6/CIDR or "any" or empty. Only digits, letters (a–f for v6), dots, colons, slash.
fn is_safe_source(s: &str) -> bool {
    if s.is_empty() || s == "any" { return true; }
    if s.len() > 43 { return false; }
    s.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':' || c == '/')
}
/// Comment: any printable unicode (Cyrillic, CJK, etc.) except characters that would
/// break the double-quoted shell string we embed it in. Max 80 characters (not bytes).
fn is_safe_comment(s: &str) -> bool {
    if s.chars().count() > 80 { return false; }
    s.chars().all(|c| {
        !c.is_control()
            && !matches!(c, '"' | '`' | '$' | '\\' | '\n' | '\r')
    })
}
/// Jail name (fail2ban jail identifier)
fn is_safe_jail(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
/// Single IPv4/IPv6 address — same chars as source, no slash.
fn is_safe_ip(s: &str) -> bool {
    !s.is_empty() && s.len() <= 45 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':')
}
/// Bantime/findtime value: numeric with optional suffix (s/m/h/d/w/y), e.g. "1h", "600", "10m"
fn is_safe_duration(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16 && s.chars().all(|c| c.is_ascii_digit() || matches!(c, 's' | 'm' | 'h' | 'd' | 'w' | 'y'))
}

/// Correctly detect `Status: active` vs `Status: inactive` from the first line of
/// `ufw status [verbose]`. A naive `.contains("active")` returns true for BOTH strings
/// because "inactive" ends with "active" — that bug caused the UI to show no rules
/// after any re-install/toggle sequence, because we'd try to parse the rules table
/// out of output that was just "Status: inactive".
fn ufw_line_is_active(first_line: &str) -> bool {
    first_line
        .split(':')
        .nth(1)
        .map(|s| s.trim() == "active")
        .unwrap_or(false)
}

async fn read_vpn_port(handle: &client::Handle<SshHandler>, app: &tauri::AppHandle, sudo: &str) -> Option<u16> {
    let (raw, _) = exec_command(
        handle, app,
        &format!(r#"{sudo}sed -n 's/^[[:space:]]*listen_address[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' {cfg} 2>/dev/null"#, cfg = ENDPOINT_CONFIG),
    ).await.ok()?;
    raw.trim().split(':').next_back().and_then(|p| p.parse::<u16>().ok())
}

// ═══════════════════════════════════════════════════════════════
//   SSH PORT CHANGE — backup / validate / apply / rollback
// ═══════════════════════════════════════════════════════════════

pub async fn change_ssh_port(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    new_port: u16,
    ssh_port: u16,
) -> Result<u16, String> {
    // ── Input validation (T-02-01: port range check) ──
    // u16 max is 65535, so only lower bound needs checking
    if new_port < 1024 {
        return Err("SSH_PORT_CHANGE_FAILED|port_out_of_range".into());
    }

    emit_log(app, "info", "Detecting SSH service type...");
    let sudo = detect_sudo(handle, app).await;
    let service_type = detect_ssh_service_type(handle, app, sudo).await?;

    // ── Firewall: detect UFW status ──
    let (ufw_raw, _) = exec_command(
        handle, app,
        &format!("{sudo}ufw status 2>/dev/null || echo 'Status: inactive'"),
    ).await?;
    let ufw_active = ufw_raw.lines().next().map(ufw_line_is_active).unwrap_or(false);

    // ── Firewall: open new port FIRST (safe order per D-01) ──
    if ufw_active && new_port != ssh_port {
        emit_log(app, "info", &format!("Opening port {new_port}/tcp in UFW..."));
        let (_, code) = exec_command(
            handle, app,
            &format!("{sudo}ufw allow {new_port}/tcp comment 'SSH'"),
        ).await?;
        if code != 0 {
            return Err("SSH_PORT_CHANGE_FAILED|firewall_open_failed".into());
        }
    }

    match service_type {
        // ── Socket activation path (Ubuntu 24.04+) ──
        SshServiceType::Socket => {
            emit_log(app, "info", "Detected ssh.socket (systemd socket activation)");

            // Backup existing override.conf (best-effort)
            emit_log(app, "info", "Backing up current socket override...");
            let _ = exec_command(
                handle, app,
                &format!("{sudo}cp /etc/systemd/system/ssh.socket.d/override.conf /etc/systemd/system/ssh.socket.d/override.conf.bak 2>/dev/null; echo ok"),
            ).await;

            // Ensure override directory exists
            let (_, mkdir_code) = exec_command(
                handle, app,
                &format!("{sudo}mkdir -p /etc/systemd/system/ssh.socket.d/"),
            ).await?;
            if mkdir_code != 0 {
                return Err("SSH_PORT_CHANGE_FAILED|cannot_create_override_dir".into());
            }

            // Write override.conf (CRITICAL: empty ListenStream= clears inherited value)
            emit_log(app, "info", &format!("Writing socket override for port {new_port}..."));
            let write_cmd = format!(
                r#"{sudo}bash -c 'cat > /etc/systemd/system/ssh.socket.d/override.conf << EOF
[Socket]
ListenStream=
ListenStream={new_port}
EOF'"#
            );
            let (_, write_code) = exec_command(handle, app, &write_cmd).await?;
            if write_code != 0 {
                return Err("SSH_PORT_CHANGE_FAILED|cannot_write_override".into());
            }

            // Reload systemd and restart ssh.socket
            emit_log(app, "info", "Reloading systemd and restarting ssh.socket...");
            let (restart_out, restart_code) = exec_command(
                handle, app,
                &format!("{sudo}systemctl daemon-reload && {sudo}systemctl restart ssh.socket"),
            ).await?;

            if restart_code != 0 {
                // Rollback from backup
                emit_log(app, "warn", "Restart failed, rolling back...");
                let _ = exec_command(
                    handle, app,
                    &format!(
                        "{sudo}cp /etc/systemd/system/ssh.socket.d/override.conf.bak /etc/systemd/system/ssh.socket.d/override.conf 2>/dev/null; {sudo}systemctl daemon-reload; {sudo}systemctl restart ssh.socket"
                    ),
                ).await;
                // Rollback UFW: remove the rule we opened for new_port
                if ufw_active && new_port != ssh_port {
                    let _ = exec_command(
                        handle, app,
                        &format!("{sudo}ufw --force delete allow {new_port}/tcp"),
                    ).await;
                }
                return Err(format!("SSH_PORT_CHANGE_FAILED|socket_restart_failed|{}", restart_out.trim()));
            }

            emit_log(app, "info", &format!("SSH port changed to {new_port} via socket activation"));
        }

        // ── Classic service path (Ubuntu 22.04, Debian 11/12) ──
        SshServiceType::Service => {
            emit_log(app, "info", "Detected ssh.service (classic sshd)");

            // Backup sshd_config with deterministic timestamp name
            let backup_name = format!("/etc/ssh/sshd_config.bak.{}", chrono::Utc::now().timestamp());
            emit_log(app, "info", "Backing up /etc/ssh/sshd_config...");
            let (_, bak_code) = exec_command(
                handle, app,
                &format!("{sudo}cp /etc/ssh/sshd_config '{backup_name}'"),
            ).await?;
            if bak_code != 0 {
                return Err("SSH_PORT_CHANGE_FAILED|backup_failed".into());
            }

            // Edit Port line (handle: existing Port, commented #Port, or missing)
            emit_log(app, "info", &format!("Setting Port {new_port} in sshd_config..."));
            let edit_cmd = format!(
                r#"{sudo}bash -c 'if grep -q "^Port " /etc/ssh/sshd_config; then
  sed -i "s/^Port .*/Port {new_port}/" /etc/ssh/sshd_config
elif grep -q "^#Port " /etc/ssh/sshd_config; then
  sed -i "s/^#Port .*/Port {new_port}/" /etc/ssh/sshd_config
else
  echo "Port {new_port}" >> /etc/ssh/sshd_config
fi'"#
            );
            let (_, edit_code) = exec_command(handle, app, &edit_cmd).await?;
            if edit_code != 0 {
                return Err("SSH_PORT_CHANGE_FAILED|edit_failed".into());
            }

            // Validate with sshd -t
            emit_log(app, "info", "Validating sshd config with sshd -t...");
            let (sshd_out, sshd_code) = exec_command(
                handle, app,
                &format!("{sudo}sshd -t 2>&1"),
            ).await?;

            if sshd_code != 0 {
                // Rollback: restore from our deterministic backup
                emit_log(app, "warn", "sshd -t validation failed, rolling back...");
                let _ = exec_command(
                    handle, app,
                    &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
                ).await;
                return Err(format!("SSH_PORT_VALIDATION_FAILED|{}", sshd_out.trim()));
            }

            // Restart ssh.service
            emit_log(app, "info", "Restarting ssh.service...");
            let (restart_out, restart_code) = exec_command(
                handle, app,
                &format!("{sudo}systemctl restart ssh.service"),
            ).await?;

            if restart_code != 0 {
                // Rollback: restore from our deterministic backup
                emit_log(app, "warn", "Service restart failed, rolling back...");
                let _ = exec_command(
                    handle, app,
                    &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
                ).await;
                let _ = exec_command(
                    handle, app,
                    &format!("{sudo}systemctl restart ssh.service"),
                ).await;
                // Rollback UFW: remove the rule we opened for new_port
                if ufw_active && new_port != ssh_port {
                    let _ = exec_command(
                        handle, app,
                        &format!("{sudo}ufw --force delete allow {new_port}/tcp"),
                    ).await;
                }
                return Err(format!("SSH_PORT_CHANGE_FAILED|service_restart_failed|{}", restart_out.trim()));
            }

            emit_log(app, "info", &format!("SSH port changed to {new_port} via sshd_config"));
        }
    }

    // ── Firewall: verify new port and close old port ──
    if ufw_active && new_port != ssh_port {
        emit_log(app, "info", &format!("Verifying sshd on port {new_port}..."));
        let verify_cmd = match service_type {
            SshServiceType::Socket => format!(
                "{sudo}systemctl show ssh.socket --property=Listen 2>/dev/null | grep -q '{new_port}' && echo OK || echo FAIL"
            ),
            SshServiceType::Service => format!(
                "{sudo}ss -tlnp 2>/dev/null | grep ':{new_port}' | head -1 | grep -q . && echo OK || echo FAIL"
            ),
        };
        let (verify, _) = exec_command(handle, app, &verify_cmd).await?;
        if !verify.trim().contains("OK") {
            // Rollback: remove new firewall rule
            emit_log(app, "warn", &format!("Verification failed on port {new_port}, removing firewall rule..."));
            let _ = exec_command(
                handle, app,
                &format!("{sudo}ufw --force delete allow {new_port}/tcp"),
            ).await;
            return Err("SSH_PORT_CHANGE_FAILED|verification_failed".into());
        }

        // Close old port in firewall
        emit_log(app, "info", &format!("Closing old port {ssh_port}/tcp in UFW..."));
        let _ = exec_command(
            handle, app,
            &format!("{sudo}ufw --force delete allow {ssh_port}/tcp"),
        ).await;
        // Non-fatal if delete fails (rule might have different format)
    }

    // ── Fail2Ban: update sshd jail port if installed (D-10) ──
    let (f2b_check, _) = exec_command(
        handle, app,
        "command -v fail2ban-client >/dev/null 2>&1 && echo F2B_OK || echo F2B_NO",
    ).await?;
    if f2b_check.trim().contains("F2B_OK") {
        emit_log(app, "info", "Updating Fail2Ban sshd jail port...");
        let (has_port, _) = exec_command(
            handle, app,
            &format!("{sudo}grep -c '^port' /etc/fail2ban/jail.local 2>/dev/null || echo 0"),
        ).await?;
        if has_port.trim() != "0" {
            // Update existing port line in [sshd] section
            let _ = exec_command(
                handle, app,
                &format!(r#"{sudo}sed -i '/^\[sshd\]/,/^\[/ s/^port[[:space:]]*=.*/port     = {new_port}/' /etc/fail2ban/jail.local"#),
            ).await;
        } else {
            // Append port line after [sshd] header if it exists
            let _ = exec_command(
                handle, app,
                &format!(r#"{sudo}sed -i '/^\[sshd\]/a port     = {new_port}' /etc/fail2ban/jail.local 2>/dev/null"#),
            ).await;
        }
        let _ = exec_command(
            handle, app,
            &format!("{sudo}fail2ban-client reload sshd 2>/dev/null"),
        ).await;
    }

    Ok(new_port)
}

// ═══════════════════════════════════════════════════════════════
//   Phase 16 — Disable PasswordAuthentication SSH (D-2.2)
// ═══════════════════════════════════════════════════════════════

/// Phase 16 — Disable `PasswordAuthentication` в `/etc/ssh/sshd_config`.
///
/// Per CONTEXT.md D-2.2 + RESEARCH.md CQ-3 (sshd_config.d/*.conf strip step).
///
/// Steps:
///
/// 1. Backup main `/etc/ssh/sshd_config` с deterministic timestamp suffix.
/// 2. **CQ-3 strip step** — `sed -i '/^[[:space:]]*PasswordAuthentication/d' /etc/ssh/sshd_config.d/*.conf`
///    удаляет любые override-entries в drop-in directory (cloud-init, DigitalOcean snap-installs).
///    Без этого шага Ubuntu 24.04 sshd берёт первое значение из `Include` directive
///    → main config edit бы не сработал.
/// 3. Idempotent edit main config (handle existing/commented/missing line).
/// 4. Validate с `sshd -t` → rollback at failure.
/// 5. Restart appropriate service (`ssh.socket` Ubuntu 24.04+ или `ssh.service` Ubuntu 22.04 / Debian 11/12).
///
/// **Caller MUST invoke `pool.invalidate()` после success** — sshd restart kills existing handles
/// (mirrors `change_ssh_port` pattern в `commands/ssh_commands.rs:194`).
pub async fn disable_password_auth(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;
    let service_type = detect_ssh_service_type(handle, app, sudo).await?;

    // Step 1: Backup main /etc/ssh/sshd_config с deterministic timestamp name.
    let backup_name = format!(
        "/etc/ssh/sshd_config.bak.{}",
        chrono::Utc::now().timestamp()
    );
    emit_log(app, "info", "Backing up /etc/ssh/sshd_config (PasswordAuth disable)...");
    let (_, bak_code) = exec_command(
        handle,
        app,
        &format!("{sudo}cp /etc/ssh/sshd_config '{backup_name}'"),
    )
    .await?;
    if bak_code != 0 {
        return Err("PWAUTH_DISABLE_FAILED|backup_failed".into());
    }

    // Step 2 (CQ-3): strip any conflicting PasswordAuthentication entry from sshd_config.d/*.conf.
    // Cloud-init / 60-cloudimg-settings.conf etc. могут содержать `PasswordAuthentication yes`
    // который wins precedence через `Include` directive в main config.
    // Failure здесь non-fatal (`; true`) — files могут не существовать на legacy systems.
    emit_log(
        app,
        "info",
        "Stripping PasswordAuthentication overrides из sshd_config.d/*.conf (CQ-3)...",
    );
    let _ = exec_command(
        handle,
        app,
        &format!(
            r#"{sudo}sed -i '/^[[:space:]]*PasswordAuthentication/d' /etc/ssh/sshd_config.d/*.conf 2>/dev/null; true"#
        ),
    )
    .await;

    // Step 3: Edit main /etc/ssh/sshd_config — idempotent (handle existing/commented/missing).
    emit_log(app, "info", "Setting PasswordAuthentication no in main sshd_config...");
    let edit_cmd = format!(
        r#"{sudo}bash -c 'if grep -q "^PasswordAuthentication" /etc/ssh/sshd_config; then
  sed -i "s/^PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config
elif grep -q "^#PasswordAuthentication" /etc/ssh/sshd_config; then
  sed -i "s/^#PasswordAuthentication.*/PasswordAuthentication no/" /etc/ssh/sshd_config
else
  echo "PasswordAuthentication no" >> /etc/ssh/sshd_config
fi'"#
    );
    let (_, edit_code) = exec_command(handle, app, &edit_cmd).await?;
    if edit_code != 0 {
        // Rollback main config from backup.
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
        )
        .await;
        return Err("PWAUTH_DISABLE_FAILED|edit_failed".into());
    }

    // Step 4: Validate с sshd -t.
    emit_log(app, "info", "Validating sshd config с sshd -t...");
    let (sshd_out, sshd_code) =
        exec_command(handle, app, &format!("{sudo}sshd -t 2>&1")).await?;
    if sshd_code != 0 {
        emit_log(app, "warn", "sshd -t validation failed, rolling back...");
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
        )
        .await;
        return Err(format!("PWAUTH_DISABLE_FAILED|sshd_validation|{}", sshd_out.trim()));
    }

    // Step 5: Restart appropriate service.
    let restart_target = match service_type {
        SshServiceType::Socket => "ssh.socket",
        SshServiceType::Service => "ssh.service",
    };
    emit_log(app, "info", &format!("Restarting {restart_target}..."));
    let (restart_out, restart_code) = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl restart {restart_target}"),
    )
    .await?;
    if restart_code != 0 {
        // Rollback both config + restart again.
        emit_log(app, "warn", "Service restart failed, rolling back...");
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
        )
        .await;
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}systemctl restart {restart_target}"),
        )
        .await;
        return Err(format!(
            "PWAUTH_DISABLE_FAILED|restart_failed|{}",
            restart_out.trim()
        ));
    }

    emit_log(app, "info", "PasswordAuthentication disabled — login по SSH-key only");
    Ok(())
}

/// Phase 16 P0-3 #E — Re-enable PasswordAuthentication (companion to `disable_password_auth`).
///
/// Mirror of `disable_password_auth`:
///   1. Backup main /etc/ssh/sshd_config с timestamp.
///   2. Edit: `PasswordAuthentication yes` (idempotent).
///   3. Validate с `sshd -t`. Rollback on failure.
///   4. Restart ssh.service / ssh.socket. Rollback if restart fails.
///
/// **NOT** strip-overrides из sshd_config.d/*.conf (CQ-3 was disable-specific —
/// при enable cloud-init defaults уже устанавливают `yes`, лишних edit'ов
/// не нужно). Если кто-то явно положил `PasswordAuthentication no` в drop-in,
/// мы оставляем его в покое — пользователь должен править его сам.
///
/// **Caller MUST invoke `pool.invalidate()` после success** — sshd restart
/// kills existing handles (mirrors `disable_password_auth` pattern).
pub async fn enable_password_auth(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;
    let service_type = detect_ssh_service_type(handle, app, sudo).await?;

    // Step 1: Backup main /etc/ssh/sshd_config с deterministic timestamp name.
    let backup_name = format!(
        "/etc/ssh/sshd_config.bak.{}",
        chrono::Utc::now().timestamp()
    );
    emit_log(app, "info", "Backing up /etc/ssh/sshd_config (PasswordAuth enable)...");
    let (_, bak_code) = exec_command(
        handle,
        app,
        &format!("{sudo}cp /etc/ssh/sshd_config '{backup_name}'"),
    )
    .await?;
    if bak_code != 0 {
        return Err("PWAUTH_ENABLE_FAILED|backup_failed".into());
    }

    // Step 2: Edit main /etc/ssh/sshd_config — idempotent (handle existing/commented/missing).
    emit_log(app, "info", "Setting PasswordAuthentication yes in main sshd_config...");
    let edit_cmd = format!(
        r#"{sudo}bash -c 'if grep -q "^PasswordAuthentication" /etc/ssh/sshd_config; then
  sed -i "s/^PasswordAuthentication.*/PasswordAuthentication yes/" /etc/ssh/sshd_config
elif grep -q "^#PasswordAuthentication" /etc/ssh/sshd_config; then
  sed -i "s/^#PasswordAuthentication.*/PasswordAuthentication yes/" /etc/ssh/sshd_config
else
  echo "PasswordAuthentication yes" >> /etc/ssh/sshd_config
fi'"#
    );
    let (_, edit_code) = exec_command(handle, app, &edit_cmd).await?;
    if edit_code != 0 {
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
        )
        .await;
        return Err("PWAUTH_ENABLE_FAILED|edit_failed".into());
    }

    // Step 3: Validate с sshd -t.
    emit_log(app, "info", "Validating sshd config с sshd -t...");
    let (sshd_out, sshd_code) =
        exec_command(handle, app, &format!("{sudo}sshd -t 2>&1")).await?;
    if sshd_code != 0 {
        emit_log(app, "warn", "sshd -t validation failed, rolling back...");
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
        )
        .await;
        return Err(format!("PWAUTH_ENABLE_FAILED|sshd_validation|{}", sshd_out.trim()));
    }

    // Step 4: Restart appropriate service.
    let restart_target = match service_type {
        SshServiceType::Socket => "ssh.socket",
        SshServiceType::Service => "ssh.service",
    };
    emit_log(app, "info", &format!("Restarting {restart_target}..."));
    let (restart_out, restart_code) = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl restart {restart_target}"),
    )
    .await?;
    if restart_code != 0 {
        emit_log(app, "warn", "Service restart failed, rolling back...");
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}cp '{backup_name}' /etc/ssh/sshd_config"),
        )
        .await;
        let _ = exec_command(
            handle,
            app,
            &format!("{sudo}systemctl restart {restart_target}"),
        )
        .await;
        return Err(format!(
            "PWAUTH_ENABLE_FAILED|restart_failed|{}",
            restart_out.trim()
        ));
    }

    emit_log(app, "info", "PasswordAuthentication enabled — login доступен через ключ ИЛИ пароль");
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
//   Phase 16 — certbot.timer status (D-5.3)
// ═══════════════════════════════════════════════════════════════

/// Pure helper — parses systemctl is-enabled / is-active outputs and cron-file presence
/// into structured timer status. Extracted для unit-test isolation (no SSH/AppHandle setup).
///
/// Inputs:
///  - `enabled_out`: stdout `systemctl is-enabled certbot.timer` (`"enabled"` | `"disabled"` | `"not-found"` | etc.)
///  - `active_out`: stdout `systemctl is-active certbot.timer` (`"active"` | `"inactive"` | etc.)
///  - `cron_out`: literal `"true"` / `"false"` от `test -f /etc/cron.d/certbot && echo true || echo false`
///
/// Output JSON object:
///  - `timer_enabled`: `enabled_out.trim() == "enabled"`
///  - `timer_active`: `active_out.trim() == "active"`
///  - `cron_present`: `cron_out.trim() == "true"`
///  - `auto_renewal_active`: `(timer_enabled && timer_active) || cron_present`
pub fn parse_certbot_timer_outputs(
    enabled_out: &str,
    active_out: &str,
    cron_out: &str,
) -> serde_json::Value {
    let timer_enabled = enabled_out.trim() == "enabled";
    let timer_active = active_out.trim() == "active";
    let cron_present = cron_out.trim() == "true";
    let auto_renewal_active = (timer_enabled && timer_active) || cron_present;

    serde_json::json!({
        "timer_enabled": timer_enabled,
        "timer_active": timer_active,
        "cron_present": cron_present,
        "auto_renewal_active": auto_renewal_active,
    })
}

/// Phase 16 — Read certbot.timer status (D-5.3).
///
/// Returns `{ timer_enabled, timer_active, cron_present, auto_renewal_active }`.
/// Дополнительно к systemd timer проверяет legacy `/etc/cron.d/certbot` для non-systemd installs.
pub async fn get_certbot_timer_status(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<serde_json::Value, String> {
    let sudo = detect_sudo(handle, app).await;

    // is-enabled: "enabled" | "disabled" | "not-found" | "static" etc.
    let (timer_enabled_out, _) = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl is-enabled certbot.timer 2>&1 || echo not-found"),
    )
    .await?;

    // Check active state (timer can be enabled but not running yet).
    let (timer_active_out, _) = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl is-active certbot.timer 2>&1 || echo inactive"),
    )
    .await?;

    // Fallback: check legacy /etc/cron.d/certbot для non-systemd installs.
    let (cron_out, _) = exec_command(
        handle,
        app,
        &format!("{sudo}test -f /etc/cron.d/certbot && echo true || echo false"),
    )
    .await?;

    Ok(parse_certbot_timer_outputs(
        &timer_enabled_out,
        &timer_active_out,
        &cron_out,
    ))
}

/// Phase 16 — Enable certbot.timer (modern Ubuntu/Debian path) с fallback на /etc/cron.d/certbot.
///
/// `systemctl enable --now certbot.timer` запускает + auto-enable boot.
/// Если systemd unit отсутствует → fallback пишет cron file для legacy installs.
pub async fn enable_certbot_timer(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    emit_log(app, "info", "Enabling certbot.timer (systemd)...");
    let (out, code) = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl enable --now certbot.timer 2>&1"),
    )
    .await?;

    if code != 0 {
        // Fallback: legacy cron file (для non-systemd / minimal installs).
        emit_log(
            app,
            "warn",
            "systemd timer unavailable, falling back to /etc/cron.d/certbot",
        );
        let cron_cmd = format!(
            "{sudo}tee /etc/cron.d/certbot >/dev/null <<'CRONEOF'\n0 */12 * * * root certbot renew --quiet --no-self-upgrade\nCRONEOF"
        );
        let (_, cron_code) = exec_command(handle, app, &cron_cmd).await?;
        if cron_code != 0 {
            return Err(format!("CERTBOT_TIMER_ENABLE_FAILED|{}", out.trim()));
        }
    }

    emit_log(app, "info", "certbot auto-renewal enabled");
    Ok(())
}

/// Phase 16 P UAT 2026-05-04 — verify certbot auto-renewal без реального
/// обновления сертификата. Использует `certbot renew --dry-run --quiet`
/// который полностью эмулирует процесс (проверяет ACME + DNS + cert chain)
/// но не consume rate limit и не пишет новый cert.
///
/// Returns:
///   - Ok(message) с success info
///   - Err("CERTBOT_DRY_RUN_FAILED|<exit_code>|<output>")
pub async fn verify_certbot_renewal(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;
    // Thin wrapper — see `verify_certbot_renewal_core` for the UFW port-80 discipline
    // and the testable command sequence.
    let run = |cmd: String| async move { exec_command(handle, app, &cmd).await };
    let log = |level: &str, message: &str| emit_log(app, level, message);
    verify_certbot_renewal_core(sudo, &run, &log).await
}

/// Pure orchestration core of [`verify_certbot_renewal`].
///
/// CONF-M-07: the dry-run needs port 80 reachable, exactly like a real renewal. On a
/// correctly-configured server UFW blocks port 80 at rest (the post-install steady state),
/// so the dry-run would FALSE-FAIL with an ACME HTTP-01 timeout. We replicate the
/// `renew_cert` open/close discipline here: decide whether port 80 is ALREADY legitimately
/// in use with `ss -tlnp | grep :80` (a server actually bound to it) instead of parsing
/// flaky `ufw status` text; if nothing is bound, open the port; run the dry-run; then close
/// it ONLY if we opened it — on EVERY exit path (D-09 guard discipline mirrored here).
///
/// Generic over a `run`/`log` seam so it is unit-testable without a live SSH handle or
/// AppHandle (see `#[cfg(test)] mod tests`).
async fn verify_certbot_renewal_core<R, Fut, L>(
    sudo: &str,
    run: &R,
    log: &L,
) -> Result<String, String>
where
    R: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<(String, i32), String>>,
    L: Fn(&str, &str),
{
    log("info", "Running certbot renew --dry-run...");

    // CONF-M-07: is port 80 already bound by a real server? Use `ss -tlnp | grep :80`
    // (authoritative — something is actually LISTENing) rather than ufw-status text.
    // If a server already owns port 80 we must NOT open/close a UFW rule around it.
    let (ss_out, _) = run(format!("{sudo}ss -tlnp 2>/dev/null | grep ':80 ' || true"))
        .await
        .unwrap_or_default();
    let port80_already_bound = ss_out.lines().any(|l| l.contains(":80 "));

    let temporarily_opened_80 = if !port80_already_bound {
        // Nothing bound — open the UFW rule so the ACME HTTP-01 probe can reach us.
        log("info", "UFW: temporarily opening 80/tcp for cert dry-run");
        let _ = run(format!(
            "{sudo}ufw allow 80/tcp comment 'cert dry-run (temporary)' 2>/dev/null; true"
        ))
        .await;
        true
    } else {
        false
    };

    // D-09 discipline: single close guard, run on EVERY exit path, only closes what we opened.
    let close_temp_port_80 = || async {
        if temporarily_opened_80 {
            log("info", "UFW: closing 80/tcp after cert dry-run");
            let _ = run(format!(
                "{sudo}ufw --force delete allow 80/tcp 2>/dev/null; true"
            ))
            .await;
        }
    };

    // timeout 120 — typical dry-run finishes in 10-30s, 120s safe margin.
    let dry_run = run(format!(
        "{sudo}timeout 120 certbot renew --dry-run --quiet 2>&1; echo EXITCODE=$?"
    ))
    .await;

    let (output, code) = match dry_run {
        Ok(v) => v,
        Err(e) => {
            // SSH-level failure: still close the port before bubbling up.
            close_temp_port_80().await;
            return Err(e);
        }
    };

    // Parse exit code from echo'ed marker (timeout не пропускает code обратно
    // через ssh stream — приходится grep'ать stdout).
    let exit_code: i32 = output
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix("EXITCODE=").and_then(|s| s.parse().ok()))
        .unwrap_or(code);

    // Close the temporarily-opened port on every remaining exit path below.
    close_temp_port_80().await;

    if exit_code == 0 {
        Ok("Dry-run succeeded — auto-renewal будет работать.".into())
    } else if exit_code == 124 {
        Err("CERTBOT_DRY_RUN_FAILED|124|timeout — certbot не ответил за 120 секунд".into())
    } else {
        // Сжимаем output — keep last 5 lines (где обычно error cause)
        let snippet: Vec<&str> = output.lines().rev().take(5).collect();
        let snippet = snippet.into_iter().rev().collect::<Vec<_>>().join("\n");
        Err(format!("CERTBOT_DRY_RUN_FAILED|{exit_code}|{snippet}"))
    }
}

// ═══════════════════════════════════════════════════════════════
//   STATUS — single roundtrip, fetches everything
// ═══════════════════════════════════════════════════════════════

pub async fn get_security_status(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    ssh_port: u16,
) -> Result<SecurityStatus, String> {
    let current_ssh_port = ssh_port;
    let sudo = detect_sudo(handle, app).await;

    // ── fail2ban presence & jails ──
    let (f2b_installed_raw, _) = exec_command(
        handle, app,
        "command -v fail2ban-client >/dev/null 2>&1 && echo F2B_OK || echo F2B_NO",
    ).await?;
    let f2b_installed = f2b_installed_raw.contains("F2B_OK");

    let mut f2b_active = false;
    let mut jails: Vec<JailInfo> = Vec::new();

    if f2b_installed {
        let (active_raw, _) = exec_command(
            handle, app,
            &format!("{sudo}systemctl is-active fail2ban 2>/dev/null || echo inactive"),
        ).await?;
        f2b_active = active_raw.trim() == "active";

        if f2b_active {
            let (status_raw, _) = exec_command(
                handle, app,
                &format!("{sudo}fail2ban-client status 2>/dev/null"),
            ).await?;
            // Parse: "  `- Jail list: sshd, sshd-ddos"
            let jail_names: Vec<String> = status_raw
                .lines()
                .find(|l| l.contains("Jail list:"))
                .and_then(|l| l.split("Jail list:").nth(1))
                .map(|s| s.split(',').map(|j| j.trim().to_string()).filter(|j| !j.is_empty()).collect())
                .unwrap_or_default();

            for name in jail_names {
                let info = parse_jail(handle, app, sudo, &name).await;
                jails.push(info);
            }
        }
    }

    // ── ufw presence & rules ──
    let (ufw_installed_raw, _) = exec_command(
        handle, app,
        "command -v ufw >/dev/null 2>&1 && echo UFW_OK || echo UFW_NO",
    ).await?;
    let ufw_installed = ufw_installed_raw.contains("UFW_OK");

    let mut ufw_active = false;
    let mut default_in = "unknown".to_string();
    let mut default_out = "unknown".to_string();
    let mut default_routed = "unknown".to_string();
    let mut logging = "off".to_string();
    let mut rules: Vec<FirewallRule> = Vec::new();

    if ufw_installed {
        let (verbose, _) = exec_command(
            handle, app,
            &format!("{sudo}ufw status verbose 2>/dev/null"),
        ).await?;
        ufw_active = verbose.lines().next().map(ufw_line_is_active).unwrap_or(false);

        for line in verbose.lines() {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("Default:") {
                // e.g. "deny (incoming), allow (outgoing), disabled (routed)"
                for part in rest.split(',') {
                    let p = part.trim();
                    if p.contains("(incoming)") { default_in = p.split_whitespace().next().unwrap_or("unknown").to_string(); }
                    else if p.contains("(outgoing)") { default_out = p.split_whitespace().next().unwrap_or("unknown").to_string(); }
                    else if p.contains("(routed)") { default_routed = p.split_whitespace().next().unwrap_or("unknown").to_string(); }
                }
            } else if let Some(rest) = l.strip_prefix("Logging:") {
                logging = rest.split_whitespace().next().unwrap_or("off").to_string();
            }
        }

        if ufw_active {
            let (numbered, _) = exec_command(
                handle, app,
                &format!("{sudo}ufw status numbered 2>/dev/null"),
            ).await?;
            rules = parse_ufw_numbered(&numbered);
        }
    }

    let vpn_port = read_vpn_port(handle, app, sudo).await;

    Ok(SecurityStatus {
        fail2ban: Fail2banStatus { installed: f2b_installed, active: f2b_active, jails },
        firewall: FirewallStatus {
            installed: ufw_installed, active: ufw_active,
            default_in, default_out, default_routed, logging, rules,
            current_ssh_port, vpn_port,
        },
    })
}

async fn parse_jail(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
    name: &str,
) -> JailInfo {
    let mut info = JailInfo {
        name: name.to_string(), enabled: true,
        currently_failed: 0, total_failed: 0, currently_banned: 0, total_banned: 0,
        banned_ips: Vec::new(),
        maxretry: 0, bantime: String::new(), findtime: String::new(),
    };

    // Jail names are validated on the way in from the UI; when called from get_security_status
    // they come from `fail2ban-client status` output which we also control.
    if !is_safe_jail(name) { return info; }
    let (status, _) = exec_command(
        handle, app,
        &format!("{sudo}fail2ban-client status {name} 2>/dev/null"),
    ).await.unwrap_or_default();

    // Loose keyword-based parsing: tolerates version drift in fail2ban-client output format
    // (which changes tree-drawing characters "|-", "`-", "|  |-" between 0.11/0.10/1.x).
    for line in status.lines() {
        // Extract value after the last ':' on the line.
        let Some(col) = line.rfind(':') else { continue };
        let value = line[col + 1..].trim();
        let key = line[..col].trim().to_ascii_lowercase();
        if value.is_empty() { continue; }

        if key.ends_with("currently failed") {
            info.currently_failed = value.parse().unwrap_or(0);
        } else if key.ends_with("total failed") {
            info.total_failed = value.parse().unwrap_or(0);
        } else if key.ends_with("currently banned") {
            info.currently_banned = value.parse().unwrap_or(0);
        } else if key.ends_with("total banned") {
            info.total_banned = value.parse().unwrap_or(0);
        } else if key.ends_with("banned ip list") || key.ends_with("ip list") {
            info.banned_ips = value
                .split_whitespace()
                .map(|s| s.to_string())
                .filter(|s| is_safe_ip(s))
                .collect();
        }
    }

    // Read persisted config from jail.local (preserves "1h" / "10m" human format).
    // Falls back to fail2ban-client get (numeric seconds) if the file key is absent.
    info.maxretry  = read_jail_key(handle, app, sudo, name, "maxretry").await
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    info.bantime   = read_jail_key(handle, app, sudo, name, "bantime").await.unwrap_or_default();
    info.findtime  = read_jail_key(handle, app, sudo, name, "findtime").await.unwrap_or_default();

    info
}

/// Extract `key = value` from a specific [jail] section of /etc/fail2ban/jail.local.
/// Falls back to `fail2ban-client get` if the key isn't persisted in the file.
async fn read_jail_key(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
    jail: &str,
    key: &str,
) -> Option<String> {
    if !is_safe_jail(jail) || key.contains('\'') { return None; }
    // Use sed to extract lines between [jail] and the next [section], then grep the key.
    // Simpler and more portable than awk with variable interpolation.
    let cmd = format!(
        "{sudo}sed -n '/^\\[{jail}\\]/,/^\\[/p' /etc/fail2ban/jail.local 2>/dev/null \
         | grep -m1 '^[[:space:]]*{key}[[:space:]]*=' \
         | sed 's/^[^=]*=[[:space:]]*//'",
    );
    let (raw, _) = exec_command(handle, app, &cmd).await.ok()?;
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        return Some(trimmed.to_string());
    }
    // Fallback — fail2ban-client get, which returns seconds for durations.
    let (raw, _) = exec_command(
        handle, app,
        &format!("{sudo}fail2ban-client get {jail} {key} 2>/dev/null"),
    ).await.ok()?;
    let v = raw.trim();
    if v.is_empty() { None } else { Some(v.to_string()) }
}

fn parse_ufw_numbered(text: &str) -> Vec<FirewallRule> {
    let mut out = Vec::new();
    for line in text.lines() {
        // Lines look like:  "[ 1] 22/tcp                     ALLOW IN    Anywhere                   # SSH"
        // IPv6 twins look like: "[ 2] 22/tcp (v6)                ALLOW IN    Anywhere (v6)"
        let line = line.trim();
        let Some(rest) = line.strip_prefix('[') else { continue };
        let Some(end) = rest.find(']') else { continue };
        let num: u32 = rest[..end].trim().parse().unwrap_or(0);
        if num == 0 { continue; }
        let rest = rest[end + 1..].trim();

        // Skip IPv6 twin rules — UFW creates one per rule per address family and we don't
        // want the UI to show duplicate rows that share semantics but differ in numbering.
        if rest.contains("(v6)") { continue; }

        // Optional comment after '#'
        let (body, comment) = match rest.find('#') {
            Some(i) => (rest[..i].trim(), rest[i + 1..].trim().to_string()),
            None => (rest, String::new()),
        };

        // Body: TO  ACTION  FROM     where ACTION is one of ALLOW IN/OUT, DENY IN/OUT, LIMIT IN/OUT, REJECT IN/OUT
        let actions = ["ALLOW IN", "ALLOW OUT", "ALLOW FWD", "DENY IN", "DENY OUT", "LIMIT IN", "LIMIT OUT", "REJECT IN", "REJECT OUT"];
        let mut split_at: Option<(usize, &str)> = None;
        for a in actions {
            if let Some(idx) = body.find(a) { split_at = Some((idx, a)); break; }
        }
        let (to, action, from) = if let Some((idx, action)) = split_at {
            let to = body[..idx].trim().to_string();
            let from = body[idx + action.len()..].trim().to_string();
            (to, action.to_string(), from)
        } else {
            (body.to_string(), String::new(), String::new())
        };
        // Try to extract proto from "443/tcp", "443/udp".
        // IN-03: only treat the segment after '/' as a proto when it is exactly
        // "tcp" or "udp". For a `to` that is not `port/proto` shaped — an
        // app-profile / "Anywhere" / bare range like "80:90" — the segment after
        // any stray '/' is garbage and was previously rendered as a bogus proto
        // in the rules table. Anything else leaves proto empty.
        let proto = to
            .split('/')
            .nth(1)
            .filter(|seg| *seg == "tcp" || *seg == "udp")
            .unwrap_or("")
            .to_string();
        out.push(FirewallRule {
            number: num, to, from, action, proto, comment,
        });
    }
    out
}

// ═══════════════════════════════════════════════════════════════
//   FAIL2BAN — install / uninstall / control
// ═══════════════════════════════════════════════════════════════

pub async fn install_fail2ban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Installing fail2ban...");
    let sudo = detect_sudo(handle, app).await;

    let (_, code) = exec_command(
        handle, app,
        &format!("{sudo}DEBIAN_FRONTEND=noninteractive apt-get update -qq && {sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban"),
    ).await?;
    if code != 0 {
        emit_step(app, "security", "error", "apt install failed");
        return Err("SECURITY_F2B_INSTALL_FAILED".into());
    }

    // Default jail.local — sshd enabled, balanced preset defaults.
    // P UAT 2026-05-04: install template aligned с frontend FAIL2BAN_PRESETS.balanced
    // (maxretry=5, bantime=600s=10m, findtime=600s=10m). Раньше bantime=1h не совпадал
    // с balanced preset (600s) → UI install snack «balanced» но settings показывали
    // «custom» при открытии. Now post-install state matches presets.balanced exactly.
    //
    // backend = auto: fail2ban auto-detects the best available backend.
    // On systems with python3-systemd -> uses journald. Without it -> falls back to
    // polling /var/log/auth.log.
    let jail_local = "[DEFAULT]\nbackend  = auto\n\n[sshd]\nenabled  = true\nport     = ssh\nfilter   = sshd\nmaxretry = 5\nbantime  = 10m\nfindtime = 10m\n";
    // Pipe heredoc directly to `tee` — no bash -c wrapping. The quoted delimiter 'F2BEOF'
    // disables parameter expansion inside the body, so arbitrary characters are safe.
    let cmd = format!(
        "{sudo}tee /etc/fail2ban/jail.local >/dev/null <<'F2BEOF'\n{jail_local}F2BEOF\n"
    );
    let (_, code) = exec_command(handle, app, &cmd).await?;
    if code != 0 {
        return Err("SECURITY_F2B_CONFIG_FAILED".into());
    }

    let _ = exec_command(handle, app, &format!("{sudo}systemctl enable fail2ban && {sudo}systemctl restart fail2ban")).await?;
    emit_step(app, "security", "ok", "fail2ban installed");
    Ok(())
}

pub async fn uninstall_fail2ban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Uninstalling fail2ban...");
    let sudo = detect_sudo(handle, app).await;

    // Full removal: stop service -> purge (removes config) -> autoremove deps -> wipe
    // /etc/fail2ban directory just in case any local files remain. Each step is its own
    // command so a failure in one (e.g. service already stopped) doesn't mask the rest.
    let _ = exec_command(handle, app, &format!("{sudo}systemctl stop fail2ban 2>/dev/null; true")).await?;
    let _ = exec_command(handle, app, &format!("{sudo}systemctl disable fail2ban 2>/dev/null; true")).await?;
    let (_, code) = exec_command(
        handle, app,
        &format!("{sudo}DEBIAN_FRONTEND=noninteractive apt-get purge -y fail2ban"),
    ).await?;
    if code != 0 {
        emit_step(app, "security", "error", "apt purge failed");
        return Err("SECURITY_F2B_PURGE_FAILED".into());
    }
    let _ = exec_command(handle, app, &format!("{sudo}DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>/dev/null; true")).await?;
    let _ = exec_command(handle, app, &format!("{sudo}rm -rf /etc/fail2ban")).await?;

    emit_step(app, "security", "ok", "fail2ban removed");
    Ok(())
}

/// Temporarily stop the fail2ban service without removing the package or config.
/// Reversible via `start_fail2ban`.
pub async fn stop_fail2ban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Stopping fail2ban...");
    let sudo = detect_sudo(handle, app).await;
    let (_, code) = exec_command(handle, app, &format!("{sudo}systemctl disable --now fail2ban")).await?;
    if code != 0 { return Err("SECURITY_F2B_STOP_FAILED".into()); }
    emit_step(app, "security", "ok", "fail2ban stopped");
    Ok(())
}

/// Start/enable a previously-installed fail2ban service.
pub async fn start_fail2ban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Starting fail2ban...");
    let sudo = detect_sudo(handle, app).await;
    let (_, code) = exec_command(handle, app, &format!("{sudo}systemctl enable --now fail2ban")).await?;
    if code != 0 { return Err("SECURITY_F2B_START_FAILED".into()); }
    emit_step(app, "security", "ok", "fail2ban started");
    Ok(())
}

/// Disable UFW without removing the package — all rules are preserved and can be
/// re-enabled later via `start_firewall` in exactly the same state.
pub async fn stop_firewall(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Disabling firewall...");
    let sudo = detect_sudo(handle, app).await;
    let (_, code) = exec_command(handle, app, &format!("{sudo}ufw --force disable")).await?;
    if code != 0 { return Err("SECURITY_UFW_STOP_FAILED".into()); }
    emit_step(app, "security", "ok", "Firewall disabled");
    Ok(())
}

/// Enable a previously-installed UFW — re-activates saved rules.
/// P UAT 2026-05-04 fix: defensive rules ensure перед enable. Раньше
/// `start_firewall` был просто `ufw --force enable` — если у user'а пустые
/// правила (no SSH allow), включение → lockout по SSH моментально.
///
/// Now: idempotently добавляем SSH+VPN ports BEFORE enable. UFW skip'ает
/// duplicate rules, поэтому safe для already-configured firewall'ов.
pub async fn start_firewall(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    ssh_port: u16,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    // Defense against lockout: SSH port allow PRIOR to enable.
    emit_log(app, "info", &format!("Ensuring SSH port {ssh_port}/tcp is allowed before enable..."));
    let _ = exec_command(
        handle,
        app,
        &format!("{sudo}ufw allow {ssh_port}/tcp comment 'SSH (TrustTunnel)'"),
    )
    .await?;

    // Best-effort VPN port allow — read from hosts.toml. Если parse fail,
    // fallback to standard 443.
    let vpn_port = read_vpn_port(handle, app, sudo).await.unwrap_or(443);
    emit_log(app, "info", &format!("Ensuring VPN port {vpn_port}/tcp is allowed..."));
    let _ = exec_command(
        handle,
        app,
        &format!("{sudo}ufw allow {vpn_port}/tcp comment 'VPN (TrustTunnel)'"),
    )
    .await?;

    // Default policies — defensive: if firewall enabled fresh без default deny,
    // user никогда не получит ожидаемой security. Idempotent.
    let _ = exec_command(handle, app, &format!("{sudo}ufw default deny incoming")).await?;
    let _ = exec_command(handle, app, &format!("{sudo}ufw default allow outgoing")).await?;

    emit_step(app, "security", "progress", "Enabling firewall...");
    let (_, code) = exec_command(handle, app, &format!("{sudo}ufw --force enable")).await?;
    if code != 0 {
        return Err("SECURITY_UFW_START_FAILED".into());
    }
    emit_step(app, "security", "ok", "Firewall enabled");
    Ok(())
}

pub async fn fail2ban_unban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    jail: String,
    ip: String,
) -> Result<(), String> {
    if !is_safe_jail(&jail) { return Err("SECURITY_F2B_INVALID_JAIL".into()); }
    if !is_safe_ip(&ip)     { return Err("SECURITY_F2B_INVALID_IP".into()); }
    let sudo = detect_sudo(handle, app).await;
    let (_, code) = exec_command(
        handle, app,
        &format!("{sudo}fail2ban-client set {jail} unbanip {ip}"),
    ).await?;
    if code != 0 { return Err("SECURITY_F2B_UNBAN_FAILED".into()); }
    Ok(())
}

pub async fn fail2ban_ban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    jail: String,
    ip: String,
) -> Result<(), String> {
    if !is_safe_jail(&jail) { return Err("SECURITY_F2B_INVALID_JAIL".into()); }
    if !is_safe_ip(&ip)     { return Err("SECURITY_F2B_INVALID_IP".into()); }
    let sudo = detect_sudo(handle, app).await;
    let (_, code) = exec_command(
        handle, app,
        &format!("{sudo}fail2ban-client set {jail} banip {ip}"),
    ).await?;
    if code != 0 { return Err("SECURITY_F2B_BAN_FAILED".into()); }
    Ok(())
}

pub async fn fail2ban_set_jail_config(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    jail: String,
    config: JailConfigUpdate,
) -> Result<(), String> {
    // Strict validation — all fields end up in shell/sed, nothing else gets through.
    if !is_safe_jail(&jail)                  { return Err("SECURITY_F2B_INVALID_JAIL".into()); }
    // BUG-06 fix: wire validate_fail2ban_int (was dead code). Rejects maxretry=0
    // (would silently disable jail) и enforces upper bound 1..=1000. Старая
    // проверка `> 1000` пропускала 0.
    crate::ssh::sanitize::validate_fail2ban_int("maxretry", config.maxretry, 1000)
        .map_err(|_| "SECURITY_F2B_INVALID_MAXRETRY".to_string())?;
    if !is_safe_duration(&config.bantime)    { return Err("SECURITY_F2B_INVALID_BANTIME".into()); }
    if !is_safe_duration(&config.findtime)   { return Err("SECURITY_F2B_INVALID_FINDTIME".into()); }

    let sudo = detect_sudo(handle, app).await;

    let enabled = if config.enabled { "true" } else { "false" };
    let maxretry = config.maxretry;
    let bantime = &config.bantime;
    let findtime = &config.findtime;

    // Persist into /etc/fail2ban/jail.local with sed. The default template (install_fail2ban)
    // already contains enabled/maxretry/bantime/findtime inside [sshd], so an address-range
    // replace finds them. For other jails (added by user later), sed is a no-op if the key
    // isn't present — but we still call `fail2ban-client set` below for runtime updates.
    // Range address: from "[jail]" until the next "[" section header (exclusive).
    let sed_script = format!(
        "sed -i -e '/^\\[{jail}\\]/,/^\\[/ {{ \
            s/^enabled[[:space:]]*=.*/enabled  = {enabled}/; \
            s/^maxretry[[:space:]]*=.*/maxretry = {maxretry}/; \
            s/^bantime[[:space:]]*=.*/bantime  = {bantime}/; \
            s/^findtime[[:space:]]*=.*/findtime = {findtime}/; \
        }}' /etc/fail2ban/jail.local"
    );
    let (_, code) = exec_command(handle, app, &format!("{sudo}{sed_script}")).await?;
    if code != 0 {
        return Err("SECURITY_F2B_PERSIST_FAILED".into());
    }

    // Runtime update — affects the running daemon without needing a restart.
    // These are best-effort: a jail may not accept a key at runtime if it's disabled.
    let _ = exec_command(handle, app, &format!("{sudo}fail2ban-client set {jail} maxretry {maxretry}")).await?;
    let _ = exec_command(handle, app, &format!("{sudo}fail2ban-client set {jail} bantime {bantime}")).await?;
    let _ = exec_command(handle, app, &format!("{sudo}fail2ban-client set {jail} findtime {findtime}")).await?;
    let _ = exec_command(handle, app, &format!("{sudo}fail2ban-client reload {jail}")).await?;

    Ok(())
}

pub async fn fail2ban_tail_log(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    lines: u32,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;
    let n = lines.clamp(10, 5000);
    let (out, _) = exec_command(
        handle, app,
        &format!("{sudo}tail -n {n} /var/log/fail2ban.log 2>/dev/null || true"),
    ).await?;
    Ok(out)
}

// ═══════════════════════════════════════════════════════════════
//   UFW — install / uninstall / rules / logs
// ═══════════════════════════════════════════════════════════════

pub async fn install_firewall(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    ssh_port: u16,
    keep_http_open: bool,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Installing UFW...");
    let sudo = detect_sudo(handle, app).await;

    // Install (no-op if already present)
    let (_, code) = exec_command(
        handle, app,
        &format!("{sudo}DEBIAN_FRONTEND=noninteractive apt-get update -qq && {sudo}DEBIAN_FRONTEND=noninteractive apt-get install -y ufw"),
    ).await?;
    if code != 0 {
        emit_step(app, "security", "error", "apt install failed");
        return Err("SECURITY_UFW_INSTALL_FAILED".into());
    }

    // Detect whether UFW is already enabled. If yes, we only *add* rules required for
    // TrustTunnel and the SSH port — we must not reset default policies or touch unrelated
    // rules that the sysadmin configured manually.
    let (status_raw, _) = exec_command(handle, app, &format!("{sudo}ufw status 2>/dev/null")).await?;
    let already_active = status_raw.lines().next().map(ufw_line_is_active).unwrap_or(false);

    // CRITICAL: allow the current SSH port BEFORE any enable, so we don't lock ourselves out.
    let _ = exec_command(handle, app, &format!("{sudo}ufw allow {ssh_port}/tcp comment 'SSH (TrustTunnel)'")).await?;

    if !already_active {
        // Only set default policies on fresh install. On an already-enabled firewall the
        // admin's existing default policy is preserved.
        let _ = exec_command(handle, app, &format!("{sudo}ufw default deny incoming")).await?;
        let _ = exec_command(handle, app, &format!("{sudo}ufw default allow outgoing")).await?;
    } else {
        emit_log(app, "info", "UFW already active — appending TrustTunnel rules without resetting policies");
    }

    if let Some(vpn) = read_vpn_port(handle, app, sudo).await {
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow {vpn}/tcp comment 'TrustTunnel VPN'")).await?;
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow {vpn}/udp comment 'TrustTunnel QUIC'")).await?;
    } else {
        // fallback default 443
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 443/tcp comment 'TrustTunnel VPN'")).await?;
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 443/udp comment 'TrustTunnel QUIC'")).await?;
    }

    if keep_http_open {
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 80/tcp comment 'HTTP cert renewal'")).await?;
    }

    if !already_active {
        let (_, code) = exec_command(handle, app, &format!("{sudo}ufw --force enable")).await?;
        if code != 0 {
            emit_step(app, "security", "error", "ufw enable failed");
            return Err("SECURITY_UFW_ENABLE_FAILED".into());
        }
    }

    emit_step(app, "security", "ok", "Firewall enabled");
    Ok(())
}

pub async fn uninstall_firewall(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Uninstalling firewall...");
    let sudo = detect_sudo(handle, app).await;
    let _ = exec_command(handle, app, &format!("{sudo}ufw --force disable 2>/dev/null; true")).await?;
    let (_, code) = exec_command(
        handle, app,
        &format!("{sudo}DEBIAN_FRONTEND=noninteractive apt-get purge -y ufw"),
    ).await?;
    if code != 0 {
        emit_step(app, "security", "error", "apt purge failed");
        return Err("SECURITY_UFW_PURGE_FAILED".into());
    }
    let _ = exec_command(handle, app, &format!("{sudo}DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>/dev/null; true")).await?;
    emit_step(app, "security", "ok", "Firewall removed");
    Ok(())
}

pub async fn firewall_add_rule(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    rule: NewFirewallRule,
) -> Result<(), String> {
    // Validate BEFORE connecting — reject anything that could inject shell metacharacters.
    let cmd = build_ufw_rule_cmd(&rule)
        .ok_or_else(|| "SECURITY_UFW_INVALID_RULE".to_string())?;

    let sudo = detect_sudo(handle, app).await;
    let (_, code) = exec_command(handle, app, &format!("{sudo}{cmd}")).await?;
    if code != 0 { return Err("SECURITY_UFW_ADD_FAILED".into()); }
    Ok(())
}

/// Build a UFW command string. Returns None if any input fails validation.
/// All inputs are validated against strict whitelists — nothing shell-special can slip through.
fn build_ufw_rule_cmd(rule: &NewFirewallRule) -> Option<String> {
    if !is_safe_action(&rule.action) { return None; }
    if !is_safe_port(&rule.port) { return None; }
    if !is_safe_proto(&rule.proto) { return None; }
    if !is_safe_source(&rule.from) { return None; }
    if !is_safe_comment(&rule.comment) { return None; }

    let action = &rule.action;
    let proto_suffix = match rule.proto.as_str() {
        "tcp" | "udp" => format!("/{}", rule.proto),
        _ => String::new(),
    };
    let comment_clause = if rule.comment.is_empty() {
        String::new()
    } else {
        format!(" comment \"{}\"", rule.comment) // safe: validated
    };

    let has_from = !rule.from.is_empty() && rule.from != "any";
    Some(if !has_from {
        format!("ufw {action} {}{}{}", rule.port, proto_suffix, comment_clause)
    } else {
        let proto_clause = if rule.proto == "tcp" || rule.proto == "udp" {
            format!(" proto {}", rule.proto)
        } else { String::new() };
        format!(
            "ufw {action} from {} to any port {}{}{}",
            rule.from, rule.port, proto_clause, comment_clause
        )
    })
}

pub async fn firewall_delete_rule(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    number: u32,
) -> Result<(), String> {
    if number == 0 || number > 10_000 { return Err("SECURITY_UFW_INVALID_NUMBER".into()); }
    let sudo = detect_sudo(handle, app).await;
    // `ufw --force delete N` skips the "Proceed?" confirmation without piping anything.
    // Previous attempt (`yes | sudo ufw delete N`) broke because `yes` fed its stdin to
    // `sudo`, not to `ufw`, so the prompt was never answered.
    let (_, code) = exec_command(
        handle, app,
        &format!("{sudo}ufw --force delete {number}"),
    ).await?;
    if code != 0 { return Err("SECURITY_UFW_DELETE_FAILED".into()); }
    Ok(())
}

pub async fn firewall_set_logging(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    level: String,
) -> Result<(), String> {
    let lvl = match level.as_str() {
        "off" | "low" | "medium" | "high" | "full" => level,
        _ => return Err("SECURITY_UFW_BAD_LEVEL".into()),
    };
    let sudo = detect_sudo(handle, app).await;
    let (_, code) = exec_command(handle, app, &format!("{sudo}ufw logging {lvl}")).await?;
    if code != 0 { return Err("SECURITY_UFW_LOGGING_FAILED".into()); }
    Ok(())
}

pub async fn firewall_tail_log(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    lines: u32,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;
    let n = lines.clamp(10, 5000);
    let (out, _) = exec_command(
        handle, app,
        &format!("{sudo}grep -h 'UFW' /var/log/ufw.log /var/log/kern.log /var/log/syslog 2>/dev/null | tail -n {n} || true"),
    ).await?;
    Ok(out)
}

pub async fn firewall_set_http_port(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    open: bool,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;
    if open {
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 80/tcp comment 'HTTP cert renewal'")).await?;
    } else {
        let _ = exec_command(handle, app, &format!("{sudo}ufw --force delete allow 80/tcp 2>/dev/null; true")).await?;
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
//   Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_safe_port ──

    #[test]
    fn safe_port_accepts_valid() {
        assert!(is_safe_port("80"));
        assert!(is_safe_port("443"));
        assert!(is_safe_port("80:90"));
        assert!(is_safe_port("65535"));
    }

    #[test]
    fn safe_port_rejects_invalid() {
        assert!(!is_safe_port(""));
        assert!(!is_safe_port("80; rm -rf /"));
        assert!(!is_safe_port("$(whoami)"));
        assert!(!is_safe_port("abc"));
        assert!(!is_safe_port(&"1".repeat(12))); // > 11 chars
    }

    // ── is_safe_proto ──

    #[test]
    fn safe_proto_accepts_valid() {
        assert!(is_safe_proto("tcp"));
        assert!(is_safe_proto("udp"));
        assert!(is_safe_proto("any"));
        assert!(is_safe_proto(""));
    }

    #[test]
    fn safe_proto_rejects_invalid() {
        assert!(!is_safe_proto("tcp; ls"));
        assert!(!is_safe_proto("$(id)"));
        assert!(!is_safe_proto("icmp"));
    }

    // ── is_safe_action ──

    #[test]
    fn safe_action_accepts_valid() {
        assert!(is_safe_action("allow"));
        assert!(is_safe_action("deny"));
        assert!(is_safe_action("limit"));
        assert!(is_safe_action("reject"));
    }

    #[test]
    fn safe_action_rejects_invalid() {
        assert!(!is_safe_action(""));
        assert!(!is_safe_action("allow; rm"));
        assert!(!is_safe_action("drop"));
    }

    // ── is_safe_source ──

    #[test]
    fn safe_source_accepts_valid() {
        assert!(is_safe_source(""));
        assert!(is_safe_source("any"));
        assert!(is_safe_source("192.168.1.0/24"));
        assert!(is_safe_source("10.0.0.1"));
        assert!(is_safe_source("::1"));
        assert!(is_safe_source("fe80::1"));
    }

    #[test]
    fn safe_source_rejects_invalid() {
        assert!(!is_safe_source("192.168.1.1; rm -rf /"));
        assert!(!is_safe_source("$(whoami)"));
        assert!(!is_safe_source(&"a".repeat(44))); // > 43 chars
    }

    // ── is_safe_comment ──

    #[test]
    fn safe_comment_accepts_valid() {
        assert!(is_safe_comment("Block SSH brute force"));
        assert!(is_safe_comment("test 123"));
    }

    #[test]
    fn safe_comment_rejects_dangerous_chars() {
        assert!(!is_safe_comment(r#"test" && rm -rf /"#));
        assert!(!is_safe_comment("test`whoami`"));
        assert!(!is_safe_comment("test$HOME"));
        assert!(!is_safe_comment("test\\path"));
        assert!(!is_safe_comment("line1\nline2"));
        assert!(!is_safe_comment(&"x".repeat(81))); // > 80 chars
    }

    // ── is_safe_jail ──

    #[test]
    fn safe_jail_accepts_valid() {
        assert!(is_safe_jail("sshd"));
        assert!(is_safe_jail("apache-auth"));
        assert!(is_safe_jail("custom_jail"));
    }

    #[test]
    fn safe_jail_rejects_invalid() {
        assert!(!is_safe_jail(""));
        assert!(!is_safe_jail("jail; ls"));
        assert!(!is_safe_jail(&"a".repeat(65))); // > 64 chars
        assert!(!is_safe_jail("jail name")); // space
    }

    // ── is_safe_ip ──

    #[test]
    fn safe_ip_accepts_valid() {
        assert!(is_safe_ip("192.168.1.1"));
        assert!(is_safe_ip("10.0.0.1"));
        assert!(is_safe_ip("::1"));
        assert!(is_safe_ip("fe80::1"));
    }

    #[test]
    fn safe_ip_rejects_invalid() {
        assert!(!is_safe_ip(""));
        assert!(!is_safe_ip("192.168.1.1; rm"));
        assert!(!is_safe_ip(&"a".repeat(46))); // > 45 chars
        assert!(!is_safe_ip("/")); // slash not allowed in IP (unlike source)
    }

    // ── is_safe_duration ──

    #[test]
    fn safe_duration_accepts_valid() {
        assert!(is_safe_duration("600"));
        assert!(is_safe_duration("1h"));
        assert!(is_safe_duration("10m"));
        assert!(is_safe_duration("30d"));
        assert!(is_safe_duration("1w"));
    }

    #[test]
    fn safe_duration_rejects_invalid() {
        assert!(!is_safe_duration(""));
        assert!(!is_safe_duration("1h; rm"));
        assert!(!is_safe_duration("abc"));
        assert!(!is_safe_duration(&"1".repeat(17))); // > 16 chars
    }

    // ── ufw_line_is_active ──

    #[test]
    fn ufw_active_detection() {
        assert!(ufw_line_is_active("Status: active"));
        assert!(!ufw_line_is_active("Status: inactive"));
        assert!(!ufw_line_is_active(""));
        assert!(ufw_line_is_active("Status:    active")); // extra spaces — trim handles it
    }

    // ── Phase 16: disable_password_auth — CQ-3 sshd_config.d strip regex ──

    /// Phase 16 — sshd_config.d/*.conf strip pattern verification (CQ-3).
    ///
    /// `disable_password_auth` использует POSIX `[[:space:]]*PasswordAuthentication` regex
    /// внутри `sed` для удаления override entries. Этот тест эмулирует regex через
    /// rust `regex` crate и проверяет что match'ит ВСЕ возможные leading-whitespace варианты:
    /// space-prefix / tab-prefix / mixed / no-prefix — но NOT comments или unrelated keys.
    #[test]
    fn sshd_config_strip_regex_matches_overrides() {
        // POSIX `[[:space:]]*PasswordAuthentication` ↔ rust `^\s*PasswordAuthentication`.
        let pattern = regex::Regex::new(r"^\s*PasswordAuthentication").expect("regex compiles");

        // Should be stripped — все variants leading whitespace.
        let lines_should_match = [
            "PasswordAuthentication yes",
            "  PasswordAuthentication no",
            "\tPasswordAuthentication yes",
            "PasswordAuthentication\tno",
            "    PasswordAuthentication yes # comment",
        ];
        for line in lines_should_match {
            assert!(pattern.is_match(line), "Should match: {line:?}");
        }

        // Should NOT be stripped — comments + unrelated SSH options.
        let lines_should_not_match = [
            "# PasswordAuthentication yes",
            "  # PasswordAuthentication yes",
            "PubkeyAuthentication yes",
            "MaxAuthTries 3",
            "PermitRootLogin yes",
        ];
        for line in lines_should_not_match {
            assert!(!pattern.is_match(line), "Should NOT match: {line:?}");
        }
    }

    // ── Phase 16: parse_certbot_timer_outputs (D-5.3) ──

    #[test]
    fn parse_certbot_timer_status_active() {
        let parsed = parse_certbot_timer_outputs("enabled\n", "active\n", "false\n");
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj["timer_enabled"], serde_json::json!(true));
        assert_eq!(obj["timer_active"], serde_json::json!(true));
        assert_eq!(obj["cron_present"], serde_json::json!(false));
        assert_eq!(obj["auto_renewal_active"], serde_json::json!(true));
    }

    #[test]
    fn parse_certbot_timer_status_disabled_no_cron() {
        let parsed = parse_certbot_timer_outputs("disabled\n", "inactive\n", "false\n");
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj["timer_enabled"], serde_json::json!(false));
        assert_eq!(obj["timer_active"], serde_json::json!(false));
        assert_eq!(obj["auto_renewal_active"], serde_json::json!(false));
    }

    #[test]
    fn parse_certbot_timer_status_cron_fallback() {
        // Legacy install: systemd timer не установлен, но cron file есть.
        let parsed = parse_certbot_timer_outputs("not-found\n", "inactive\n", "true\n");
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj["timer_enabled"], serde_json::json!(false));
        assert_eq!(obj["timer_active"], serde_json::json!(false));
        assert_eq!(obj["cron_present"], serde_json::json!(true));
        // Auto-renewal active because cron picks up the slack.
        assert_eq!(obj["auto_renewal_active"], serde_json::json!(true));
    }

    #[test]
    fn parse_certbot_timer_status_enabled_but_inactive() {
        // Edge case: timer enabled (boot autostart) но не active сейчас (только что перезагружен).
        // auto_renewal_active = false потому что timer должен быть active для current renewal.
        let parsed = parse_certbot_timer_outputs("enabled\n", "inactive\n", "false\n");
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj["auto_renewal_active"], serde_json::json!(false));
    }

    // ═══════════════════════════════════════════════════════════════
    //   CONF-M-07 — verify_certbot_renewal_core UFW port-80 discipline.
    //
    //   The dry-run needs port 80; on a UFW-steady server it false-fails.
    //   These tests stub the command seam (record issued commands + script the
    //   `ss -tlnp` probe result) to assert the open/close discipline — including
    //   the ss-based "already bound" check and "only close what we opened".
    // ═══════════════════════════════════════════════════════════════

    use std::cell::RefCell;

    struct DryRunRecorder {
        cmds: RefCell<Vec<String>>,
        // What the `ss -tlnp | grep :80` probe returns (empty = nothing bound).
        ss_output: &'static str,
    }

    impl DryRunRecorder {
        fn new(ss_output: &'static str) -> Self {
            DryRunRecorder {
                cmds: RefCell::new(Vec::new()),
                ss_output,
            }
        }

        fn run(
            &self,
        ) -> impl Fn(String) -> std::future::Ready<Result<(String, i32), String>> + '_ {
            move |cmd: String| {
                let out = if cmd.contains("ss -tlnp") {
                    self.ss_output.to_string()
                } else if cmd.contains("certbot renew --dry-run") {
                    "Congratulations, all simulated renewals succeeded\nEXITCODE=0".to_string()
                } else {
                    String::new()
                };
                self.cmds.borrow_mut().push(cmd);
                std::future::ready(Ok((out, 0)))
            }
        }

        fn recorded(&self) -> Vec<String> {
            self.cmds.borrow().clone()
        }
    }

    fn drive_verify(rec: &DryRunRecorder) -> Result<String, String> {
        let run = rec.run();
        let log = |_l: &str, _m: &str| {};
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(verify_certbot_renewal_core("sudo ", &run, &log))
    }

    /// CONF-M-07: when nothing is bound to port 80 (ss probe empty), the dry-run must
    /// open port 80, run, then close it. The detection MUST use `ss -tlnp`, not ufw text.
    #[test]
    fn dry_run_opens_and_closes_port_80_when_unbound() {
        let rec = DryRunRecorder::new(""); // nothing bound
        let result = drive_verify(&rec);
        assert!(result.is_ok(), "dry-run with EXITCODE=0 should succeed");

        let cmds = rec.recorded();
        assert!(
            cmds.iter().any(|c| c.contains("ss -tlnp")),
            "must probe with ss -tlnp, not ufw status: {cmds:#?}"
        );
        assert!(
            cmds.iter().any(|c| c.contains("ufw allow 80/tcp")),
            "must open port 80 before the dry-run when nothing is bound: {cmds:#?}"
        );
        assert!(
            cmds.iter()
                .any(|c| c.contains("ufw --force delete allow 80/tcp")),
            "must close the port we opened after the dry-run: {cmds:#?}"
        );
    }

    /// CONF-M-07 edge: if a real server is ALREADY bound to port 80 (ss shows a LISTEN),
    /// we must NOT open or close a UFW rule around it (only touch what we opened).
    #[test]
    fn dry_run_does_not_touch_port_80_when_already_bound() {
        let rec = DryRunRecorder::new(
            "LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:((\"nginx\",pid=1,fd=6))\n",
        );
        let _ = drive_verify(&rec);
        let cmds = rec.recorded();
        assert!(
            !cmds.iter().any(|c| c.contains("ufw allow 80/tcp")),
            "must not open port 80 when a server already owns it: {cmds:#?}"
        );
        assert!(
            !cmds.iter().any(|c| c.contains("ufw --force delete allow 80/tcp")),
            "must not close a port we never opened: {cmds:#?}"
        );
    }

    // ── parse_ufw_numbered proto classification (IN-03) ──

    /// Helper: parse a single `ufw status numbered`-style body line and return
    /// the proto the parser assigned to it.
    fn proto_of(line: &str) -> String {
        let rules = parse_ufw_numbered(line);
        assert_eq!(rules.len(), 1, "expected exactly one parsed rule for {line:?}");
        rules[0].proto.clone()
    }

    #[test]
    fn ufw_proto_classifies_tcp_and_udp() {
        // "443/tcp" → tcp, "53/udp" → udp.
        assert_eq!(proto_of("[ 1] 443/tcp                    ALLOW IN    Anywhere"), "tcp");
        assert_eq!(proto_of("[ 2] 53/udp                     ALLOW IN    Anywhere"), "udp");
    }

    #[test]
    fn ufw_proto_empty_for_bare_port_range() {
        // "80:90" has no '/', proto must be empty.
        assert_eq!(proto_of("[ 3] 80:90                      ALLOW IN    Anywhere"), "");
    }

    #[test]
    fn ufw_proto_empty_for_non_proto_slash_value() {
        // IN-03: a '/'-containing `to` whose segment after '/' is NOT tcp/udp
        // (an app profile / CIDR-shaped value) must NOT be rendered as a proto.
        assert_eq!(proto_of("[ 4] 10.0.0.0/8                 ALLOW IN    Anywhere"), "");
        assert_eq!(proto_of("[ 5] Anywhere                   ALLOW IN    192.168.0.0/24"), "");
    }
}
