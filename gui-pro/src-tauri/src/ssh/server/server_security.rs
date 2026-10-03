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
/// **Caller MUST invoke `pool.invalidate()` после success** — restarting sshd tears down every
/// TCP session it was serving, so every handle still sitting in the pool is already dead by the
/// time this returns. Reusing one yields an opaque transport error on the NEXT security action,
/// far from the cause; invalidating makes the next acquire dial a fresh connection instead.
/// The requirement belongs to the sshd restart itself — it holds for ANY command that restarts
/// the daemon, so do not treat it as a quirk of this one function.
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
//   STATUS — batched fetch (QE-02)
//
//   Background (QE-02, 09-RESEARCH-quality.md §J): `get_security_status`
//   previously fired ~9-11 SEQUENTIAL `exec_command` calls per panel mount and
//   per firewall/fail2ban toggle (detect_sudo, f2b presence/active/status, one
//   status + up-to-three jail.local reads PER jail, ufw presence/verbose/
//   numbered, read_vpn_port). Each call opens a fresh SSH channel — the dominant
//   panel latency.
//
//   Fix: run every probe in ONE `bash -c` over a single channel, emitting each
//   probe's output between unique section markers, then split the combined stdout
//   by marker and feed each chunk to the EXISTING parsers (parsing is unchanged —
//   only the fetching is batched). The jail list is dynamic, so we use at most a
//   SECOND batched pass for the per-jail probes once the jail names are known
//   (1-2 round-trips total instead of ~10).
//
//   Injection safety (T-09-14): the `bash -c` body is a single-quoted heredoc
//   delivered with a UUID-randomized delimiter (`SEC_EOF_<uuid>` — see CLAUDE.md
//   SSH rule, mirrors deploy.rs:613-633 / server_config.rs:1035). Server-named
//   jails are whitelisted via `is_safe_jail` before being interpolated, exactly
//   as the old path did, and the `sudo` prefix is preserved on every sub-command
//   that originally had it.
// ═══════════════════════════════════════════════════════════════

/// Section marker name used by the first-pass batch. The combined stdout is split
/// by `=== <NAME> ===` lines; each NAME maps to one probe's raw output.
mod sec_marker {
    pub const F2B_PRESENCE: &str = "F2B_PRESENCE";
    pub const F2B_ACTIVE: &str = "F2B_ACTIVE";
    pub const F2B_STATUS: &str = "F2B_STATUS";
    pub const UFW_PRESENCE: &str = "UFW_PRESENCE";
    pub const UFW_VERBOSE: &str = "UFW_VERBOSE";
    pub const UFW_NUMBERED: &str = "UFW_NUMBERED";
    pub const VPN_PORT: &str = "VPN_PORT";
}

/// Split a combined batched-stdout blob into named sections. Each section begins
/// at a marker line of the exact form `=== <NAME> ===` (trimmed) and runs until
/// the next marker (or EOF). Returns a map from NAME → that section's body (the
/// trailing newline before the next marker is dropped so the chunk matches what a
/// standalone `exec_command` would have returned).
///
/// Pure + side-effect-free so the parser path is unit-testable without SSH.
fn split_marked_sections(blob: &str) -> std::collections::HashMap<String, String> {
    let mut out: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    let mut buf: Vec<&str> = Vec::new();

    let flush = |name: &Option<String>, buf: &mut Vec<&str>, out: &mut std::collections::HashMap<String, String>| {
        if let Some(n) = name {
            // Join with '\n'; this reproduces the body between two markers minus the
            // separator newlines that bracket the marker lines themselves.
            out.insert(n.clone(), buf.join("\n"));
        }
        buf.clear();
    };

    for line in blob.lines() {
        let t = line.trim();
        if let Some(name) = t.strip_prefix("===").and_then(|s| s.strip_suffix("===")) {
            let name = name.trim();
            if !name.is_empty() {
                flush(&current, &mut buf, &mut out);
                current = Some(name.to_string());
                continue;
            }
        }
        buf.push(line);
    }
    flush(&current, &mut buf, &mut out);
    out
}

/// Build the first-pass batch command: every static-shaped probe in ONE `bash -c`
/// single-quoted heredoc, each output fenced by `=== <NAME> ===` markers. The
/// `run_id` keeps the heredoc delimiter unique per invocation (T-09-14). Returns
/// the full command string ready for `exec_command`.
fn build_security_batch_command(sudo: &str, run_id: &str) -> String {
    use sec_marker::*;
    let delim = format!("SEC_EOF_{run_id}");
    // Each probe mirrors its old standalone form 1:1 (same flags, same `2>/dev/null`
    // / `|| echo` fallbacks, same `sudo` prefix where the original had it). The
    // markers are echoed literals; bodies are produced by the sub-commands.
    format!(
        "bash -s <<'{delim}'\n\
         echo '=== {F2B_PRESENCE} ==='\n\
         command -v fail2ban-client >/dev/null 2>&1 && echo F2B_OK || echo F2B_NO\n\
         echo '=== {F2B_ACTIVE} ==='\n\
         {sudo}systemctl is-active fail2ban 2>/dev/null || echo inactive\n\
         echo '=== {F2B_STATUS} ==='\n\
         {sudo}fail2ban-client status 2>/dev/null\n\
         echo '=== {UFW_PRESENCE} ==='\n\
         command -v ufw >/dev/null 2>&1 && echo UFW_OK || echo UFW_NO\n\
         echo '=== {UFW_VERBOSE} ==='\n\
         {sudo}ufw status verbose 2>/dev/null\n\
         echo '=== {UFW_NUMBERED} ==='\n\
         {sudo}ufw status numbered 2>/dev/null\n\
         echo '=== {VPN_PORT} ==='\n\
         {sudo}sed -n 's/^[[:space:]]*listen_address[[:space:]]*=[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p' {cfg} 2>/dev/null\n\
         {delim}\n",
        cfg = ENDPOINT_CONFIG,
    )
}

/// Pure parser for the first-pass batch sections. Reuses the EXISTING parsers
/// (`ufw_line_is_active`, the Default:/Logging: loop, `parse_ufw_numbered`) so the
/// produced firewall fields are byte-identical to the old multi-call path. The
/// jail LIST is extracted here; per-jail details are filled by the second pass.
///
/// Returns `(f2b_installed, f2b_active, jail_names, FirewallStatus)`.
fn parse_security_first_pass(
    sections: &std::collections::HashMap<String, String>,
    current_ssh_port: u16,
) -> (bool, bool, Vec<String>, FirewallStatus) {
    let get = |k: &str| sections.get(k).map(String::as_str).unwrap_or("");

    // ── fail2ban presence / active / jail list ──
    let f2b_installed = get(sec_marker::F2B_PRESENCE).contains("F2B_OK");
    let mut f2b_active = false;
    let mut jail_names: Vec<String> = Vec::new();
    if f2b_installed {
        f2b_active = get(sec_marker::F2B_ACTIVE).trim() == "active";
        if f2b_active {
            // Parse: "  `- Jail list: sshd, sshd-ddos" (unchanged from old path).
            jail_names = get(sec_marker::F2B_STATUS)
                .lines()
                .find(|l| l.contains("Jail list:"))
                .and_then(|l| l.split("Jail list:").nth(1))
                .map(|s| s.split(',').map(|j| j.trim().to_string()).filter(|j| !j.is_empty()).collect())
                .unwrap_or_default();
        }
    }

    // ── ufw presence / rules ──
    let ufw_installed = get(sec_marker::UFW_PRESENCE).contains("UFW_OK");
    let mut ufw_active = false;
    let mut default_in = "unknown".to_string();
    let mut default_out = "unknown".to_string();
    let mut default_routed = "unknown".to_string();
    let mut logging = "off".to_string();
    let mut rules: Vec<FirewallRule> = Vec::new();

    if ufw_installed {
        let verbose = get(sec_marker::UFW_VERBOSE);
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
            rules = parse_ufw_numbered(get(sec_marker::UFW_NUMBERED));
        }
    }

    // read_vpn_port equivalent — same sed output, same parse.
    let vpn_port = get(sec_marker::VPN_PORT)
        .trim()
        .split(':')
        .next_back()
        .and_then(|p| p.parse::<u16>().ok());

    let firewall = FirewallStatus {
        installed: ufw_installed, active: ufw_active,
        default_in, default_out, default_routed, logging, rules,
        current_ssh_port, vpn_port,
    };

    (f2b_installed, f2b_active, jail_names, firewall)
}

/// Section-marker key for a per-jail `fail2ban-client status <jail>` chunk.
fn jail_status_key(jail: &str) -> String { format!("JAIL_STATUS|{jail}") }
/// Section-marker key for a per-jail `key` value (jail.local OR get fallback).
fn jail_value_key(jail: &str, key: &str) -> String { format!("JAIL_VAL|{jail}|{key}") }

/// Build the second-pass batch: for every (whitelisted) jail, emit its
/// `fail2ban-client status <jail>` output and the three persisted config values
/// (maxretry / bantime / findtime) — each between markers. The value sub-command
/// preserves the OLD jail.local-first-then-`fail2ban-client get`-fallback logic
/// inline so the parsed value is identical to the old `read_jail_key`. Skips jails
/// that fail `is_safe_jail` (they would have parsed empty in the old path too).
///
/// Returns `None` when there are no safe jails (no second round-trip needed).
fn build_jail_batch_command(sudo: &str, jail_names: &[String], run_id: &str) -> Option<String> {
    let safe: Vec<&String> = jail_names.iter().filter(|j| is_safe_jail(j)).collect();
    if safe.is_empty() { return None; }

    let delim = format!("JAIL_EOF_{run_id}");
    let keys = ["maxretry", "bantime", "findtime"];
    let mut body = String::new();
    for jail in &safe {
        body.push_str(&format!("echo '=== {} ==='\n", jail_status_key(jail)));
        body.push_str(&format!("{sudo}fail2ban-client status {jail} 2>/dev/null\n"));
        for key in keys {
            body.push_str(&format!("echo '=== {} ==='\n", jail_value_key(jail, key)));
            // jail.local section value first; fall back to `fail2ban-client get`
            // (numeric seconds) when the file key is absent — identical to the old
            // read_jail_key two-step, collapsed into one `||` chain.
            body.push_str(&format!(
                "v=$({sudo}sed -n '/^\\[{jail}\\]/,/^\\[/p' /etc/fail2ban/jail.local 2>/dev/null \
                 | grep -m1 '^[[:space:]]*{key}[[:space:]]*=' \
                 | sed 's/^[^=]*=[[:space:]]*//'); \
                 if [ -z \"$v\" ]; then v=$({sudo}fail2ban-client get {jail} {key} 2>/dev/null); fi; \
                 printf '%s\\n' \"$v\"\n"
            ));
        }
    }
    Some(format!("bash -s <<'{delim}'\n{body}{delim}\n"))
}

/// Pure parser for one jail from the second-pass sections. Identical key matching
/// to the old `parse_jail` (loose, version-drift-tolerant) + the same `is_safe_ip`
/// filter on banned IPs. The maxretry/bantime/findtime come from the pre-fetched
/// value sections (old read_jail_key result, batched).
fn parse_jail_from_sections(
    name: &str,
    sections: &std::collections::HashMap<String, String>,
) -> JailInfo {
    let mut info = JailInfo {
        name: name.to_string(), enabled: true,
        currently_failed: 0, total_failed: 0, currently_banned: 0, total_banned: 0,
        banned_ips: Vec::new(),
        maxretry: 0, bantime: String::new(), findtime: String::new(),
    };

    // Jails come from `fail2ban-client status` output which we control; an unsafe
    // name would not have been queried (build_jail_batch_command skips it) so it
    // parses to the same empty default the old path produced.
    if !is_safe_jail(name) { return info; }

    let status = sections.get(&jail_status_key(name)).map(String::as_str).unwrap_or("");

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

    // Pre-fetched persisted config (jail.local-first, get-fallback already applied
    // server-side). Empty string ↔ old `unwrap_or_default()`.
    let val = |key: &str| -> String {
        sections
            .get(&jail_value_key(name, key))
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    info.maxretry = val("maxretry").parse().unwrap_or(0);
    info.bantime = val("bantime");
    info.findtime = val("findtime");

    info
}

pub async fn get_security_status(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    ssh_port: u16,
) -> Result<SecurityStatus, String> {
    let current_ssh_port = ssh_port;
    let sudo = detect_sudo(handle, app).await;

    // ── Round-trip 1: every static-shaped probe in one batched channel ──
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let (blob, _) = exec_command(handle, app, &build_security_batch_command(sudo, &run_id)).await?;
    let sections = split_marked_sections(&blob);
    let (f2b_installed, f2b_active, jail_names, firewall) =
        parse_security_first_pass(&sections, current_ssh_port);

    // ── Round-trip 2 (only if jails exist): per-jail status + config in one channel ──
    let mut jails: Vec<JailInfo> = Vec::new();
    if let Some(jail_cmd) = build_jail_batch_command(sudo, &jail_names, &run_id) {
        let (jail_blob, _) = exec_command(handle, app, &jail_cmd).await?;
        let jail_sections = split_marked_sections(&jail_blob);
        for name in &jail_names {
            jails.push(parse_jail_from_sections(name, &jail_sections));
        }
    }

    Ok(SecurityStatus {
        fail2ban: Fail2banStatus { installed: f2b_installed, active: f2b_active, jails },
        firewall,
    })
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

/// Build the `[sshd]` jail body written to `/etc/fail2ban/jail.local`.
///
/// Blocker 3 (30.1 milestone review): this body used to hard-code `port     = ssh` — the
/// /etc/services alias, i.e. port 22. On a server hardened onto a non-standard SSH port
/// the jail therefore watched a port nothing listens on: brute-force attempts against the
/// REAL port were never counted and never banned, while the wizard reported the server
/// «защищён». Writing the numeric port the SSH session is actually using makes the claim
/// and the behaviour agree. Note this only NARROWS what fail2ban bans — it opens and
/// closes no firewall rule (sacred SSH-port invariant untouched; see the write-command
/// test that asserts the generated text carries no ufw verb).
///
/// Extracted as a PURE function so the property "the jail watches the port SSH actually
/// listens on" is an assertion over a string, provable without a live server — the same
/// shape as the command-text tests further down this module.
fn build_fail2ban_jail_local(ignoreip: &str, ssh_port: u16) -> String {
    format!(
        "[DEFAULT]\nbackend  = auto\nignoreip = {ignoreip}\n\n[sshd]\nenabled  = true\nport     = {ssh_port}\nfilter   = sshd\nmaxretry = 5\nbantime  = 10m\nfindtime = 10m\n"
    )
}

/// Build the shell command that writes `jail.local`.
///
/// Pipe heredoc directly to `tee` — no bash -c wrapping. The quoted delimiter disables
/// parameter expansion inside the body, so arbitrary characters are safe.
///
/// The delimiter is a per-call UUID (`F2BEOF_<uuid>`) matching the project-wide heredoc
/// convention (`deploy.rs` CREDS_EOF_<uuid>, `server_config.rs`, `server_install.rs`);
/// this was the last static one. To be precise about what that buys: a `u16` port cannot
/// break out of a heredoc, so this is convention-matching, NOT a security fix. The value
/// that genuinely needs guarding here is `ignoreip`, and it is validated upstream through
/// the `is_safe_ip` whitelist before it ever reaches this builder (T-06-42).
fn build_fail2ban_jail_write_cmd(sudo: &str, ignoreip: &str, ssh_port: u16) -> String {
    let jail_local = build_fail2ban_jail_local(ignoreip, ssh_port);
    let delim = format!("F2BEOF_{}", uuid::Uuid::new_v4().simple());
    format!(
        "{sudo}tee /etc/fail2ban/jail.local >/dev/null <<'{delim}'\n{jail_local}{delim}\n"
    )
}

pub async fn install_fail2ban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    ssh_port: u16,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Installing fail2ban...");
    let sudo = detect_sudo(handle, app).await;

    // De-provisioning marker (post-UAT): detect whether fail2ban is ALREADY present
    // (admin had it) BEFORE we apt-install it. The full uninstall purges the package
    // ONLY when WE installed it — never an admin's pre-existing fail2ban. The marker
    // is written below after a successful install; read by build_uninstall_script.
    let (f2b_pre, _) = exec_command(
        handle, app,
        &format!("{sudo}dpkg -s fail2ban >/dev/null 2>&1 && echo PRESENT || echo ABSENT"),
    ).await?;
    let we_installed_f2b = f2b_pre.contains("ABSENT");

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
    // ── ignoreip: whitelist the admin's own IP so a self-ban can't lock everyone out
    // (post-UAT server-brick fix). With NO ignoreip, 5 failed logins from the admin's
    // own machine — or the app's own repeated SSH attempts during a flaky deploy — banned
    // that IP for 10m (a DROP that reads as an SSH timeout, indistinguishable from the
    // firewall brick). Capture the client IP as the server sees THIS session (sshd sets
    // SSH_CONNECTION for exec channels; first field = client IP, v4 or v6), validate it
    // against the strict is_safe_ip whitelist, and bake it into ignoreip with loopback.
    // Validation is MANDATORY — the value lands in a config file, so an unvalidated
    // shell-captured value would be an injection seam (T-06-42). The heredoc is quoted
    // (single-quoted 'F2BEOF_<uuid>') so nothing in the body is shell-expanded — the IP
    // is a literal we build. Body + write command live in the two pure builders above.
    let (client_ip_raw, _) = exec_command(
        handle, app,
        "echo \"${SSH_CONNECTION:-}\" | awk '{print $1}'",
    ).await.unwrap_or_default();
    let client_ip = client_ip_raw.trim();
    let ignoreip = if !client_ip.is_empty() && is_safe_ip(client_ip) {
        format!("127.0.0.1/8 ::1 {client_ip}")
    } else {
        // Fallback: loopback only. The uninstall unban + orphan-chain sweep is the net.
        "127.0.0.1/8 ::1".to_string()
    };
    let cmd = build_fail2ban_jail_write_cmd(sudo, &ignoreip, ssh_port);
    let (_, code) = exec_command(handle, app, &cmd).await?;
    if code != 0 {
        return Err("SECURITY_F2B_CONFIG_FAILED".into());
    }

    let _ = exec_command(handle, app, &format!("{sudo}systemctl enable fail2ban && {sudo}systemctl restart fail2ban")).await?;

    if we_installed_f2b {
        // WE apt-installed fail2ban (it was absent) → drop an ownership marker so a
        // full uninstall purges the package. Never marked when the admin had it. Do NOT
        // clear on the else path: a re-run sees the package present because WE installed it,
        // so an else-clear would erase a marker we own (fix-review REG-1). The stale-marker
        // cycle is closed by consuming the marker in uninstall_fail2ban + the dir removal.
        let _ = exec_command(
            handle, app,
            &format!("{sudo}mkdir -p /opt/trusttunnel 2>/dev/null; {sudo}touch /opt/trusttunnel/.tt-installed-fail2ban 2>/dev/null; true"),
        ).await?;
    }
    emit_step(app, "security", "ok", "fail2ban installed");
    Ok(())
}

pub async fn uninstall_fail2ban(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Uninstalling fail2ban...");
    let sudo = detect_sudo(handle, app).await;

    // Full removal: unban -> stop -> purge (removes config) -> autoremove deps -> wipe
    // /etc/fail2ban AND the ban DB, then sweep orphan DROP chains. Each step is its own
    // command so a failure in one (e.g. service already stopped) doesn't mask the rest.
    //
    // SACRED SSH (post-UAT brick fix): a fail2ban ban is an iptables/nft DROP that can
    // OUTLIVE `apt purge` and the ban DB restores bans on reboot. So UNBAN first (only a
    // live daemon can), drop the ban DB, and sweep any orphan f2b chain — otherwise a
    // self-ban of the admin's IP survives removing the very tool that made it.
    let _ = exec_command(handle, app, &format!("{sudo}fail2ban-client unban --all 2>/dev/null; true")).await?;
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
    // WR-4 (Phase-18 re-review): the bare system-wide `apt-get autoremove -y` cascade is GONE
    // here too — M-01 removed it from the scripted uninstall for over-reaching (it removed EVERY
    // apt-orphaned package, incl. the admin's own), but this standalone panel path still ran it.
    // Purge only the named package; never cascade-remove system orphans.
    let _ = exec_command(handle, app, &format!("{sudo}rm -rf /etc/fail2ban")).await?;
    // Drop the persisted ban DB so a residual boot-time restore can't re-ban the admin.
    let _ = exec_command(handle, app, &format!("{sudo}rm -rf /var/lib/fail2ban 2>/dev/null; true")).await?;
    // WR-3 (Phase-18 re-review): consume the ownership marker. 18-10 made
    // `.tt-installed-fail2ban` AUTHORITATIVE proof for the full-uninstall package purge — but if
    // this standalone remove leaves the marker behind, a later admin-installed fail2ban would be
    // wrongly classified as ours and purged. Mirror build_telemt_teardown's marker cleanup.
    let _ = exec_command(handle, app, &format!("{sudo}rm -f /opt/trusttunnel/.tt-installed-fail2ban 2>/dev/null; true")).await?;
    // Backend-agnostic orphan-DROP sweep (daemon is now gone → safe to flush f2b chains).
    let orphan_sweep = format!(
        "if command -v iptables >/dev/null 2>&1; then \
           for tt_ch in $({sudo}iptables -S 2>/dev/null | grep -oE 'f2b-[A-Za-z0-9_.-]+' | sort -u); do \
             {sudo}iptables -F \"$tt_ch\" 2>/dev/null || true; \
             {sudo}iptables -S INPUT 2>/dev/null | grep -- \"-j $tt_ch\" | sed 's/^-A/-D/' | while read -r tt_rule; do {sudo}iptables $tt_rule 2>/dev/null || true; done; \
             {sudo}iptables -X \"$tt_ch\" 2>/dev/null || true; \
           done; \
         fi; \
         if command -v nft >/dev/null 2>&1; then \
           {sudo}nft list tables 2>/dev/null | grep -E '[[:space:]]f2b-' | while read -r _tt_kw tt_fam tt_tname; do \
             [ -n \"$tt_fam\" ] && [ -n \"$tt_tname\" ] && {sudo}nft delete table \"$tt_fam\" \"$tt_tname\" 2>/dev/null || true; \
           done; \
         fi; true"
    );
    let _ = exec_command(handle, app, &orphan_sweep).await?;

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

/// Parse `ss -tulnH` output into the distinct, externally-reachable, non-ephemeral
/// listening ports (pure fn — unit-testable, no live SSH). Generalizes the
/// `ss -tlnp | grep ':80 '` authoritative-listen idiom used by the cert dry-run.
///
/// `-H` drops the header row; each line is a socket whose LOCAL address column is
/// `ADDR:PORT` (IPv4 `0.0.0.0:8080`/`127.0.0.1:5432`, IPv6 `[::]:8080`). The peer
/// column is always a wildcard (`*`) for listening sockets, so scanning every field
/// for a numeric trailing `:PORT` matches ONLY the local column regardless of the
/// tcp/udp column offset.
///
/// Filters, so we never pin the wrong thing into a `ufw allow`:
/// - loopback binds (`127.*` / `::1`) — not reachable from outside, firewalling them
///   off harms nothing, so they are excluded;
/// - duplicates (a port bound on both IPv4 and IPv6) — folded once.
///
/// WR-6 (Phase-18 re-review): the former `>= 32768` "ephemeral" floor was DROPPED. The input
/// is `ss -tulnH` — LISTENING/bound sockets ONLY (no established client connections), so a high
/// port here is a genuine service, not a transient socket: a TCP LISTEN on 40000 (Docker
/// publishes 32768+) or WireGuard's default `51820/udp` are real admin services. The floor
/// silently excluded them from the D-05 pre-allow, so a fresh `ufw default deny incoming` +
/// `--force enable` blackholed the admin's VPN/service. The cost of NOT flooring is at worst a
/// few harmless unused `ufw allow` rules for a UDP source port that happened to be bound at
/// snapshot time; the cost of flooring is a locked-out running service — a strictly worse
/// failure, so reachability wins. (SSH + VPN ports are still excluded downstream by
/// `ports_to_preallow`; loopback stays filtered here.)
pub(crate) fn parse_listening_ports(ss_out: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = Vec::new();
    for line in ss_out.lines() {
        for field in line.split_whitespace() {
            // The local-address column is `ADDR:PORT`; split on the LAST ':' so IPv6
            // `[::]:8080` keeps its address intact. Peer columns end in `:*` and fail
            // the numeric parse below, so only the local column is ever matched.
            let Some(idx) = field.rfind(':') else { continue };
            let (addr, port_str) = (&field[..idx], &field[idx + 1..]);
            let Ok(port) = port_str.parse::<u16>() else { continue };

            // Loopback-only binds are unreachable from outside — excluded so we never
            // fold a rule for a service that no remote client could reach anyway.
            let addr = addr.trim_start_matches('[').trim_end_matches(']');
            if addr == "::1" || addr.starts_with("127.") {
                continue;
            }
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports
}

/// Extract the admin-occupied ports from the pre-install snapshot JSON (pure,
/// self-contained serde read — deliberately NOT dependent on 18-01's
/// `PreInstallSnapshot` type, so this plan carries no cross-plan compile edge).
///
/// Returns:
/// - `Some(ports)` when the input is valid snapshot JSON (the pre-mutation truth —
///   an empty `occupiedPorts` legitimately yields `Some(vec![])`, meaning "snapshot
///   present, nothing to fold" — the caller then folds nothing rather than falling
///   back to a live read);
/// - `None` when the input is absent (empty string) or malformed — the ONLY case in
///   which the caller engages the live `ss -tulnH` fallback.
pub(crate) fn snapshot_occupied_ports(snapshot_json: &str) -> Option<Vec<u16>> {
    // A private minimal view over the snapshot JSON — only the one field we need.
    // Kept local (not 18-01's `PreInstallSnapshot`) so this plan compiles without a
    // dependency on the snapshot module's types. `default` tolerates a snapshot that
    // predates the field; unknown extra fields are ignored by serde.
    #[derive(serde::Deserialize)]
    struct OccupiedPortsView {
        #[serde(rename = "occupiedPorts", default)]
        occupied_ports: Vec<u16>,
    }
    // Empty/malformed input → Err → None → caller uses the live-`ss` fallback.
    serde_json::from_str::<OccupiedPortsView>(snapshot_json)
        .ok()
        .map(|v| v.occupied_ports)
}

/// Decide which occupied ports to pre-allow before a fresh `ufw --force enable`
/// (pure fn — the unit-testable core of the D-05 fold). Drops the SSH port and the
/// VPN port (both get their own explicit rules) and de-duplicates.
fn ports_to_preallow(listening: &[u16], ssh_port: u16, vpn_port: Option<u16>) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for &port in listening {
        // The SSH port (D-INV-1 SACRED) and the VPN port are already allowed by their
        // own explicit rules — never re-fold them here. Dedup the rest.
        if port != ssh_port && Some(port) != vpn_port && !out.contains(&port) {
            out.push(port);
        }
    }
    out
}

/// M-04: build the D-05 occupied-port pre-allow ufw commands. Emits BOTH `/tcp` AND
/// `/udp` for each folded port. The snapshot records only the port NUMBER (not the
/// protocol), and `ss -tulnH` captures TCP + UDP listeners alike — so an admin UDP
/// service (DNS 53/udp, WireGuard on a sub-32768 port, a game server) would otherwise be
/// silently blocked by `default deny incoming` while only its TCP twin was opened. Both
/// protocols is slightly over-permissive but preserves reachability; the shared
/// ownership comment lets the uninstall sweep spare BOTH rules (H-03). Only numeric u16
/// ports reach the shell. Pure fn → unit-testable.
fn preallow_ufw_commands(sudo: &str, ports: &[u16]) -> Vec<String> {
    let mut cmds = Vec::new();
    for &port in ports {
        for proto in ["tcp", "udp"] {
            cmds.push(format!(
                "{sudo}ufw allow {port}/{proto} comment 'pre-existing admin service (TrustTunnel)'"
            ));
        }
    }
    cmds
}

pub async fn install_firewall(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    ssh_port: u16,
    keep_http_open: bool,
) -> Result<(), String> {
    emit_step(app, "security", "progress", "Installing UFW...");
    let sudo = detect_sudo(handle, app).await;

    // De-provisioning marker (post-UAT): detect whether the ufw PACKAGE is already
    // present BEFORE we apt-install it. ufw ships on most Ubuntu base images, so this
    // is usually PRESENT (admin's base tool) → we must NOT purge it on uninstall. The
    // full uninstall purges ufw ONLY when WE installed it (package was absent).
    let (ufw_pre, _) = exec_command(
        handle, app,
        &format!("{sudo}dpkg -s ufw >/dev/null 2>&1 && echo PRESENT || echo ABSENT"),
    ).await?;
    let we_installed_ufw = ufw_pre.contains("ABSENT");

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

    // Read the VPN port once: reused both to EXCLUDE it from the occupied-ports fold
    // below (it gets its own explicit rule) and to emit that explicit rule further down.
    let vpn_port = read_vpn_port(handle, app, sudo).await;

    if !already_active {
        // Only set default policies on fresh install. On an already-enabled firewall the
        // admin's existing default policy is preserved.
        let _ = exec_command(handle, app, &format!("{sudo}ufw default deny incoming")).await?;
        let _ = exec_command(handle, app, &format!("{sudo}ufw default allow outgoing")).await?;

        // D-05 / Pitfall 1 fix: on a FRESH ufw, `default deny incoming` + `--force enable`
        // would silently cut off any admin service listening on another port. Before the
        // enable, fold an `ufw allow` for each admin-occupied port so default-deny never
        // firewalls off a running service the admin already had.
        //
        // SOURCE OF TRUTH (WARNING): take the port list from the PRE-INSTALL SNAPSHOT,
        // captured before ANY mutation (18-01). By the time we reach `enable`, our own
        // deploy has already started its listeners — a live read HERE would treat a
        // service we just started as if it had always belonged to the admin and pin an
        // allow for it. So we read the snapshot's occupied ports (the state as it was
        // BEFORE we touched the server); a live `ss -tulnH` read is the fallback ONLY
        // when no snapshot exists (a legacy server installed before the snapshot feature).
        // Path mirrors snapshot::SNAPSHOT_PATH; kept as a literal so this plan stays free
        // of a compile-time dependency on the snapshot module's types.
        //
        // fix-review REG-2: during THIS deploy the capture lives at the `.pending` path (WR-5
        // promotes it to the authoritative name only after the deploy fully succeeds, which is
        // AFTER this Step 6.5). So read the authoritative file first (re-deploys), then fall back
        // to `.pending` (the in-flight first install) — that pending file IS this run's verified
        // pre-mutation capture, exactly the D-05 source of truth. Only a genuine legacy server
        // (neither file) drops to the forbidden live-`ss` read.
        let (snap_raw, _) = exec_command(
            handle, app,
            &format!("{sudo}cat /opt/trusttunnel/.tt-preinstall-snapshot.json 2>/dev/null || {sudo}cat /opt/trusttunnel/.tt-preinstall-snapshot.json.pending 2>/dev/null || true"),
        ).await?;
        let occupied = match snapshot_occupied_ports(snap_raw.trim()) {
            Some(ports) => ports,
            None => {
                // Legacy server: no snapshot → read the live listen map as a fallback.
                let (ss_out, _) = exec_command(
                    handle, app,
                    &format!("{sudo}ss -tulnH 2>/dev/null || true"),
                ).await?;
                parse_listening_ports(&ss_out)
            }
        };
        // Folded rules carry an ownership comment so the uninstall sweep (18-04) can
        // identify and remove them by comment. M-04: emit BOTH /tcp and /udp per folded
        // port so an admin UDP service is not silently blocked. Only numeric u16 ports
        // reach the shell.
        let preallow = ports_to_preallow(&occupied, ssh_port, vpn_port);
        for cmd in preallow_ufw_commands(sudo, &preallow) {
            let _ = exec_command(handle, app, &cmd).await?;
        }
    } else {
        emit_log(app, "info", "UFW already active — appending TrustTunnel rules without resetting policies");
    }

    if let Some(vpn) = vpn_port {
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow {vpn}/tcp comment 'TrustTunnel VPN'")).await?;
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow {vpn}/udp comment 'TrustTunnel QUIC'")).await?;
    } else {
        // fallback default 443
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 443/tcp comment 'TrustTunnel VPN'")).await?;
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 443/udp comment 'TrustTunnel QUIC'")).await?;
    }

    if keep_http_open {
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 80/tcp comment 'HTTP cert renewal (TrustTunnel)'")).await?;
    }

    if !already_active {
        let (_, code) = exec_command(handle, app, &format!("{sudo}ufw --force enable")).await?;
        if code != 0 {
            emit_step(app, "security", "error", "ufw enable failed");
            return Err("SECURITY_UFW_ENABLE_FAILED".into());
        }
    }

    // Ownership markers for the smart full-uninstall:
    //   • `.tt-installed-ufw` — WE apt-installed the package (was absent) → purge it.
    //   • `.tt-enabled-ufw`   — ufw was INACTIVE and WE enabled it → disable it again
    //     on uninstall (back to its prior off state), keeping the package.
    // Write the marker ONLY when WE own the action (package was absent / ufw was inactive). Do
    // NOT clear a marker on the else path: on an idempotent re-deploy the package is present /
    // ufw is active BECAUSE WE installed/enabled it last time, so an else-clear would erase a
    // marker we legitimately own and permanently defeat the uninstall's in-shell purge/disable
    // gate (fix-review REG-1). The stale-marker cycle WR-3 targeted is already closed by consuming
    // the markers in uninstall_firewall/uninstall_fail2ban + the full uninstall's dir removal.
    let _ = exec_command(handle, app, &format!("{sudo}mkdir -p /opt/trusttunnel 2>/dev/null; true")).await?;
    if we_installed_ufw {
        let _ = exec_command(handle, app, &format!("{sudo}touch /opt/trusttunnel/.tt-installed-ufw 2>/dev/null; true")).await?;
    }
    if !already_active {
        let _ = exec_command(handle, app, &format!("{sudo}touch /opt/trusttunnel/.tt-enabled-ufw 2>/dev/null; true")).await?;
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
    // WR-4 (Phase-18 re-review): the system-wide `apt-get autoremove -y` cascade is GONE here too
    // (M-01 removed it from the scripted uninstall for over-reaching; this panel path kept it).
    // WR-3: consume the ownership markers — 18-10 made `.tt-installed-ufw` AUTHORITATIVE proof for
    // the full-uninstall purge, so a marker outliving the package would later authorize purging an
    // admin's own re-installed ufw. Mirror build_telemt_teardown's marker cleanup.
    let _ = exec_command(handle, app, &format!("{sudo}rm -f /opt/trusttunnel/.tt-installed-ufw /opt/trusttunnel/.tt-enabled-ufw 2>/dev/null; true")).await?;
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

/// Pure: does the ufw `To` token (first column of a `ufw status numbered` line) refer to
/// the active SSH port? Handles every shape that can carry the SSH port so the delete
/// guard cannot be bypassed (Fable HIGH-1):
///   • exact `<port>` or `<port>/tcp` (with or without a trailing ` (v6)` — the marker is
///     a separate whitespace token, so the port token itself is unaffected),
///   • the `OpenSSH` / `ssh` APP PROFILE (the canonical `ufw allow OpenSSH`), which opens
///     port 22 — matched only when the active SSH port IS 22,
///   • a port RANGE `a:b` that CONTAINS the SSH port (`ufw allow 2222:2230/tcp`).
fn ufw_to_token_is_ssh_port(to: &str, ssh_port: u16) -> bool {
    // Strip the proto suffix (/tcp,/udp); the `(v6)` marker is a separate token, not here.
    let base = to.split('/').next().unwrap_or(to);
    let lower = base.to_ascii_lowercase();
    if (lower == "openssh" || lower == "ssh") && ssh_port == 22 {
        return true;
    }
    if base == ssh_port.to_string() {
        return true;
    }
    if let Some((a, b)) = base.split_once(':') {
        if let (Ok(a), Ok(b)) = (a.parse::<u16>(), b.parse::<u16>()) {
            return a <= ssh_port && ssh_port <= b;
        }
    }
    false
}

/// Pure: does ufw rule `number` (as listed by `ufw status numbered`) target `ssh_port`?
/// Used to REFUSE deleting the active SSH port's allow so the admin can never be locked
/// out. Scans the raw listing directly (NOT via `parse_ufw_numbered`, which drops `(v6)`
/// twins — a v6 SSH row must still be protected, Fable MEDIUM-2) and matches the `To`
/// token via `ufw_to_token_is_ssh_port` (exact / OpenSSH / range / v6). Unit-testable.
fn ufw_rule_number_is_ssh_port(status: &str, number: u32, ssh_port: u16) -> bool {
    for line in status.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('[') else { continue };
        let Some(end) = rest.find(']') else { continue };
        if rest[..end].trim().parse::<u32>().ok() != Some(number) {
            continue;
        }
        // The `To` column is the first whitespace-delimited token after `]`
        // (split_whitespace already skips leading spaces — no trim needed).
        let to = rest[end + 1..].split_whitespace().next().unwrap_or("");
        return ufw_to_token_is_ssh_port(to, ssh_port);
    }
    false
}

pub async fn firewall_delete_rule(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    number: u32,
    ssh_port: u16,
) -> Result<(), String> {
    if number == 0 || number > 10_000 { return Err("SECURITY_UFW_INVALID_NUMBER".into()); }
    let sudo = detect_sudo(handle, app).await;
    // SACRED SSH PORT (post-UAT brick fix): never delete the ufw rule the CURRENT SSH
    // session rides on. The Security-tab firewall table renders a delete button for every
    // rule; deleting the active SSH allow while ufw default-denies locks the admin out —
    // no app, no terminal. Resolve the target number to its port via `ufw status numbered`
    // and REFUSE when it is the connected SSH port. The frontend also disables the trash
    // on that row; this backend guard is the hard guarantee that it can never happen.
    let (status, _) = exec_command(handle, app, &format!("{sudo}ufw status numbered 2>/dev/null")).await?;
    if ufw_rule_number_is_ssh_port(&status, number, ssh_port) {
        return Err("SECURITY_UFW_REFUSE_DELETE_SSH".into());
    }
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

    // ── Blocker 3 (30.1 milestone review): the fail2ban sshd jail must name the REAL
    //    SSH port. It used to hard-code `port = ssh`, the /etc/services alias for 22, so
    //    on a server hardened onto a non-standard port the jail watched a port nothing
    //    listens on — brute-force on the real port went unbanned while the wizard
    //    reported «сервер защищён». ──

    #[test]
    fn f2b_jail_names_the_real_ssh_port_not_the_service_alias() {
        let body = build_fail2ban_jail_local("127.0.0.1/8 ::1", 2222);
        assert!(
            body.contains("port     = 2222"),
            "the sshd jail must name the numeric SSH port, got:\n{body}"
        );
        assert!(
            !body.contains("port     = ssh"),
            "the `ssh` service alias resolves to 22 and must be gone entirely:\n{body}"
        );
    }

    #[test]
    fn f2b_jail_names_the_port_even_when_it_is_the_default() {
        // There must be NO path left that reaches the old behaviour — the default port
        // is written as a number too, so `port = ssh` cannot reappear via a "22 is
        // special" branch.
        let body = build_fail2ban_jail_local("127.0.0.1/8 ::1", 22);
        assert!(body.contains("port     = 22"), "got:\n{body}");
        // NB: matched on the `port` key, not on a bare "= ssh" — `filter   = sshd` is a
        // legitimate line in this template and must not trip the guard.
        assert!(
            !body.contains("port     = ssh"),
            "the alias must not survive for port 22:\n{body}"
        );
    }

    #[test]
    fn f2b_jail_keeps_the_ignoreip_whitelist_and_balanced_preset() {
        // The port change must not disturb the rest of the template: the admin's own IP
        // stays whitelisted (the anti-self-ban net) and the values still match the
        // frontend FAIL2BAN_PRESETS.balanced.
        let body = build_fail2ban_jail_local("127.0.0.1/8 ::1 203.0.113.7", 2222);
        assert!(body.contains("ignoreip = 127.0.0.1/8 ::1 203.0.113.7"), "got:\n{body}");
        assert!(body.contains("maxretry = 5"), "got:\n{body}");
        assert!(body.contains("bantime  = 10m"), "got:\n{body}");
        assert!(body.contains("findtime = 10m"), "got:\n{body}");
    }

    #[test]
    fn f2b_jail_write_cmd_carries_no_firewall_verb() {
        // SACRED SSH-PORT INVARIANT, made machine-checkable. This change only narrows
        // what fail2ban BANS; it must not open, close, reorder or delete a single ufw
        // rule. If a future edit smuggles a firewall verb into the fail2ban config path,
        // this fails rather than shipping a teardown that can brick the server.
        let cmd = build_fail2ban_jail_write_cmd("sudo ", "127.0.0.1/8 ::1", 2222);
        for verb in ["ufw ", " allow", " deny", " enable", " delete", "iptables"] {
            assert!(
                !cmd.contains(verb),
                "the fail2ban jail write command must carry no firewall verb ({verb:?}):\n{cmd}"
            );
        }
    }

    #[test]
    fn f2b_jail_write_cmd_uses_a_quoted_dynamic_heredoc_delimiter() {
        // Convention-matching, NOT a security fix: a u16 port cannot break out of a
        // heredoc. But this codebase writes every heredoc with a per-call UUID delimiter
        // (deploy.rs:640, server_config.rs, server_install.rs) and this one was the last
        // static `F2BEOF`. Kept single-quoted so the writing shell expands nothing.
        let cmd = build_fail2ban_jail_write_cmd("sudo ", "127.0.0.1/8 ::1", 2222);
        assert!(cmd.contains("<<'F2BEOF_"), "delimiter must be dynamic, got:\n{cmd}");
        assert!(
            !cmd.contains("<<'F2BEOF'"),
            "the static F2BEOF delimiter must be replaced by a dynamic one:\n{cmd}"
        );
        // Two occurrences of the SAME uuid delimiter (open + close), never a mismatch.
        let delim = cmd
            .split("<<'")
            .nth(1)
            .and_then(|s| s.split('\'').next())
            .unwrap_or_default()
            .to_string();
        assert!(!delim.is_empty(), "could not locate the delimiter in:\n{cmd}");
        assert_eq!(cmd.matches(&delim).count(), 2, "delimiter must open and close once:\n{cmd}");
    }

    // ── Both doors. install_fail2ban has TWO callers; fixing one and calling the class
    //    closed is the failure mode this phase exists to remove. The signature change
    //    alone would let a caller pass a constant 22 and stay green, so each door is
    //    pinned to the port IT actually connected on. ──

    #[test]
    fn wizard_door_threads_the_deploy_port_into_the_fail2ban_install() {
        let source = include_str!("../deploy.rs");
        let body = source
            .split("if run_fail2ban {")
            .nth(1)
            .and_then(|s| s.split("provision_failed = true;").next())
            .unwrap_or("");
        assert!(
            !body.is_empty(),
            "the wizard's fail2ban call was not found — this guard has lost its subject"
        );
        assert!(
            body.contains("install_fail2ban(app, &handle, params.port)"),
            "the wizard must pass the deploy params' port, exactly like the firewall call \
             one line above; got:\n{body}"
        );
    }

    #[test]
    fn control_panel_door_threads_the_ssh_port_into_the_fail2ban_install() {
        let source = include_str!("../../commands/ssh_commands.rs");
        assert!(
            !source.contains("ssh_pool_command!(security_install_fail2ban"),
            "the Control Panel door must NOT be macro-bound — the macro cannot deliver the \
             SSH port, which is exactly how this door stayed on port 22"
        );
        let body = source
            .split("pub async fn security_install_fail2ban")
            .nth(1)
            .and_then(|s| s.split("\n#[tauri::command]").next())
            .unwrap_or("");
        assert!(
            !body.is_empty(),
            "security_install_fail2ban not found — this guard has lost its subject"
        );
        assert!(
            body.contains("install_fail2ban(&app, &handle, port)"),
            "the Control Panel door must pass the SSH connection's own port; got:\n{body}"
        );
    }

    // ── parse_listening_ports (occupied-ports live-fallback parser) ──

    #[test]
    fn parse_listening_ports_folds_external_and_high_ports_drops_loopback() {
        // Representative `ss -tulnH` blob: an external admin service on 8080 (IPv4 +
        // its IPv6 twin — must dedup), a loopback-only Postgres on 5432 (excluded), a
        // high-port TCP LISTEN service on 51000 (Docker publishes 32768+ — MUST be kept,
        // WR-6), WireGuard on 51820/udp (a real bound service — MUST be kept, WR-6), and
        // sshd on :22 (external, kept — the caller, not this parser, excludes the SSH port).
        let ss_out = "\
tcp   LISTEN 0      128          0.0.0.0:8080        0.0.0.0:*
tcp   LISTEN 0      128        127.0.0.1:5432        0.0.0.0:*
tcp   LISTEN 0      128             [::]:8080           [::]:*
tcp   LISTEN 0      128          0.0.0.0:51000       0.0.0.0:*
udp   UNCONN 0      0            0.0.0.0:51820       0.0.0.0:*
tcp   LISTEN 0      128          0.0.0.0:22          0.0.0.0:*
udp   UNCONN 0      0            0.0.0.0:22          0.0.0.0:*
";
        let ports = parse_listening_ports(ss_out);
        assert!(ports.contains(&8080), "external admin port must be folded: {ports:?}");
        assert!(!ports.contains(&5432), "loopback-only bind must be excluded: {ports:?}");
        // WR-6: high-port LISTEN services must NO LONGER be dropped (they are real services).
        assert!(ports.contains(&51000), "high-port TCP LISTEN service must be kept (WR-6): {ports:?}");
        assert!(ports.contains(&51820), "WireGuard 51820/udp must be kept (WR-6): {ports:?}");
        // dedup: 8080 appears on IPv4 + IPv6 but must be listed once.
        assert_eq!(ports.iter().filter(|&&p| p == 8080).count(), 1, "8080 not deduped: {ports:?}");
    }

    // ── ports_to_preallow (D-05 fold core) ──

    #[test]
    fn ports_to_preallow_excludes_ssh_and_vpn_keeps_admin_ports() {
        // Given the admin's occupied set {22, 8080, 443}, ssh=22, vpn=443 → only the
        // genuine admin service (8080) is folded; ssh + vpn get their own explicit rules.
        let got = ports_to_preallow(&[22, 8080, 443], 22, Some(443));
        assert_eq!(got, vec![8080]);
    }

    #[test]
    fn ports_to_preallow_dedups_and_tolerates_absent_vpn() {
        // No detected VPN port → nothing excluded on that axis; duplicates folded once.
        let got = ports_to_preallow(&[8080, 8080, 22, 9000], 22, None);
        assert_eq!(got, vec![8080, 9000]);
    }

    #[test]
    fn preallow_ufw_commands_open_both_tcp_and_udp_m04() {
        // M-04: each folded occupied port must be pre-allowed for BOTH /tcp AND /udp, so
        // an admin UDP service is not silently blocked by `default deny incoming`.
        let cmds = preallow_ufw_commands("sudo ", &[53, 8080]);
        assert_eq!(cmds.len(), 4, "two protocols per port: {cmds:?}");
        assert!(cmds.iter().any(|c| c.contains("ufw allow 53/tcp")), "53/tcp missing");
        assert!(cmds.iter().any(|c| c.contains("ufw allow 53/udp")), "53/udp missing (the M-04 gap)");
        assert!(cmds.iter().any(|c| c.contains("ufw allow 8080/tcp")), "8080/tcp missing");
        assert!(cmds.iter().any(|c| c.contains("ufw allow 8080/udp")), "8080/udp missing");
        // All carry the ownership comment so the uninstall sweep spares BOTH (H-03).
        assert!(cmds.iter().all(|c| c.contains("pre-existing admin service (TrustTunnel)")));
        // Empty input → no commands.
        assert!(preallow_ufw_commands("sudo ", &[]).is_empty());
    }

    // ── snapshot_occupied_ports (snapshot-first source, live-ss fallback gate) ──

    #[test]
    fn snapshot_occupied_ports_reads_valid_snapshot() {
        // A valid pre-install snapshot JSON (camelCase `occupiedPorts`, compact `v`) →
        // Some(ports). Extra/unknown fields are ignored (self-contained view struct).
        let json = r#"{"v":1,"occupiedPorts":[22,8080,443],"ufwPresent":true,"bbrValue":"bbr"}"#;
        assert_eq!(snapshot_occupied_ports(json), Some(vec![22, 8080, 443]));
    }

    #[test]
    fn snapshot_occupied_ports_none_on_absent_or_malformed() {
        // Absent (empty — `cat ... || true` on a legacy server) and malformed both yield
        // None, so ONLY then does install_firewall fall back to a live `ss -tulnH` read.
        assert_eq!(snapshot_occupied_ports(""), None);
        assert_eq!(snapshot_occupied_ports("not json {"), None);
    }

    // ── ufw_rule_number_is_ssh_port (SACRED SSH PORT guard) ──

    #[test]
    fn ufw_rule_number_is_ssh_port_matches_only_the_ssh_port_line() {
        // `ufw status numbered` sample: rule 1 is the active SSH port, rule 2 is a VPN
        // port, rule 3 is the SSH port's IPv6 twin. The guard must refuse deleting rule 1
        // AND rule 3 (would lock the admin out) and allow deleting rule 2. A non-standard
        // SSH port (2222) proves the match is by exact port token, not a hardcoded 22.
        let status = "Status: active\n\n     To                         Action      From\n     --                         ------      ----\n[ 1] 2222/tcp                    ALLOW IN    Anywhere                   # SSH (TrustTunnel)\n[ 2] 443/tcp                     ALLOW IN    Anywhere                   # TrustTunnel VPN\n[ 3] 2222/tcp (v6)               ALLOW IN    Anywhere (v6)              # SSH (TrustTunnel)\n";
        assert!(ufw_rule_number_is_ssh_port(status, 1, 2222), "rule 1 IS the SSH port → must refuse");
        assert!(!ufw_rule_number_is_ssh_port(status, 2, 2222), "rule 2 is a VPN port → deletable");
        assert!(!ufw_rule_number_is_ssh_port(status, 1, 22), "a different SSH port must not match the 2222 row");
        // Fable MEDIUM-2: the v6 twin (rule 3) of the SSH port must ALSO be protected.
        assert!(ufw_rule_number_is_ssh_port(status, 3, 2222), "the v6 SSH twin must be protected too");
    }

    #[test]
    fn ufw_to_token_openssh_profile_and_ranges_are_protected() {
        // Fable HIGH-1: `ufw allow OpenSSH` (the canonical way to open SSH) yields a `To`
        // token "OpenSSH", not "22" — it must still be protected when the SSH port is 22.
        assert!(ufw_to_token_is_ssh_port("OpenSSH", 22));
        assert!(ufw_to_token_is_ssh_port("ssh", 22));
        assert!(!ufw_to_token_is_ssh_port("OpenSSH", 2222), "OpenSSH profile only maps to port 22");
        // Exact port (with/without proto).
        assert!(ufw_to_token_is_ssh_port("22/tcp", 22));
        assert!(ufw_to_token_is_ssh_port("2222", 2222));
        // A port RANGE that CONTAINS the SSH port must be protected; one that excludes it must not.
        assert!(ufw_to_token_is_ssh_port("2222:2230/tcp", 2225));
        assert!(ufw_to_token_is_ssh_port("20:22/tcp", 22));
        assert!(!ufw_to_token_is_ssh_port("2000:2100/tcp", 2222), "range excluding the SSH port → deletable");
        assert!(!ufw_to_token_is_ssh_port("443/tcp", 22), "a different port never matches");
    }

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

    // ═══════════════════════════════════════════════════════════════
    //   QE-02 — batched get_security_status splitter + parser parity.
    //
    //   These prove the batched fetch produces the SAME SecurityStatus the old
    //   ~10-round-trip path did, for the jail/ufw edge cases called out in
    //   09-RESEARCH-quality.md §J Pitfall 3 (0 / 1 / 2+ jails, ufw inactive).
    //   The blobs are exactly what the markered `bash -c` would print, so the
    //   splitter → parser path is exercised end-to-end without SSH.
    // ═══════════════════════════════════════════════════════════════

    /// Build a first-pass combined blob from the individual probe outputs, in the
    /// same marker order `build_security_batch_command` emits them.
    fn first_pass_blob(
        f2b_presence: &str,
        f2b_active: &str,
        f2b_status: &str,
        ufw_presence: &str,
        ufw_verbose: &str,
        ufw_numbered: &str,
        vpn_port: &str,
    ) -> String {
        format!(
            "=== {} ===\n{f2b_presence}\n\
             === {} ===\n{f2b_active}\n\
             === {} ===\n{f2b_status}\n\
             === {} ===\n{ufw_presence}\n\
             === {} ===\n{ufw_verbose}\n\
             === {} ===\n{ufw_numbered}\n\
             === {} ===\n{vpn_port}\n",
            sec_marker::F2B_PRESENCE,
            sec_marker::F2B_ACTIVE,
            sec_marker::F2B_STATUS,
            sec_marker::UFW_PRESENCE,
            sec_marker::UFW_VERBOSE,
            sec_marker::UFW_NUMBERED,
            sec_marker::VPN_PORT,
        )
    }

    const UFW_VERBOSE_ACTIVE: &str = "Status: active\n\
        Logging: on (low)\n\
        Default: deny (incoming), allow (outgoing), disabled (routed)\n\
        New profiles: skip\n\n\
        To                         Action      From\n\
        --                         ------      ----\n\
        22/tcp                     ALLOW IN    Anywhere";

    const UFW_NUMBERED_ACTIVE: &str = "Status: active\n\n\
        \u{20}    To                         Action      From\n\
        \u{20}    --                         ------      ----\n\
        [ 1] 22/tcp                     ALLOW IN    Anywhere                   # SSH\n\
        [ 2] 443/tcp                    ALLOW IN    Anywhere";

    /// 1-jail, ufw-active server — the common case.
    #[test]
    fn batch_first_pass_one_jail_ufw_active() {
        let f2b_status = "Status\n\
            |- Number of jail:      1\n\
            `- Jail list:   sshd";
        let blob = first_pass_blob(
            "F2B_OK",
            "active",
            f2b_status,
            "UFW_OK",
            UFW_VERBOSE_ACTIVE,
            UFW_NUMBERED_ACTIVE,
            "0.0.0.0:51820",
        );
        let sections = split_marked_sections(&blob);
        let (installed, active, jails, fw) = parse_security_first_pass(&sections, 22);

        assert!(installed);
        assert!(active);
        assert_eq!(jails, vec!["sshd".to_string()]);

        assert!(fw.installed);
        assert!(fw.active);
        assert_eq!(fw.default_in, "deny");
        assert_eq!(fw.default_out, "allow");
        assert_eq!(fw.default_routed, "disabled");
        assert_eq!(fw.logging, "on");
        assert_eq!(fw.rules.len(), 2);
        assert_eq!(fw.rules[0].to, "22/tcp");
        assert_eq!(fw.rules[0].proto, "tcp");
        assert_eq!(fw.rules[0].comment, "SSH");
        assert_eq!(fw.rules[1].to, "443/tcp");
        assert_eq!(fw.current_ssh_port, 22);
        assert_eq!(fw.vpn_port, Some(51820));
    }

    /// 0 jails (fail2ban active but empty jail list) — Pitfall 3 edge.
    #[test]
    fn batch_first_pass_zero_jails() {
        let f2b_status = "Status\n\
            |- Number of jail:      0\n\
            `- Jail list:";
        let blob = first_pass_blob(
            "F2B_OK", "active", f2b_status,
            "UFW_OK", UFW_VERBOSE_ACTIVE, UFW_NUMBERED_ACTIVE, "0.0.0.0:443",
        );
        let sections = split_marked_sections(&blob);
        let (installed, active, jails, fw) = parse_security_first_pass(&sections, 22);
        assert!(installed);
        assert!(active);
        assert!(jails.is_empty(), "empty Jail list must yield no jail names");
        assert_eq!(fw.vpn_port, Some(443));
    }

    /// 2 jails — Pitfall 3 multi-jail edge.
    #[test]
    fn batch_first_pass_two_jails() {
        let f2b_status = "Status\n\
            |- Number of jail:      2\n\
            `- Jail list:   sshd, recidive";
        let blob = first_pass_blob(
            "F2B_OK", "active", f2b_status,
            "UFW_OK", UFW_VERBOSE_ACTIVE, UFW_NUMBERED_ACTIVE, "10.0.0.1:8443",
        );
        let sections = split_marked_sections(&blob);
        let (_, _, jails, _) = parse_security_first_pass(&sections, 22);
        assert_eq!(jails, vec!["sshd".to_string(), "recidive".to_string()]);
    }

    /// ufw INSTALLED but inactive — must NOT parse a rules table (the "inactive ends
    /// with active" trap) and must skip the numbered fetch path.
    #[test]
    fn batch_first_pass_ufw_inactive() {
        let f2b_status = "Status\n`- Jail list:   sshd";
        let blob = first_pass_blob(
            "F2B_OK", "active", f2b_status,
            "UFW_OK", "Status: inactive", "", "0.0.0.0:443",
        );
        let sections = split_marked_sections(&blob);
        let (_, _, _, fw) = parse_security_first_pass(&sections, 22);
        assert!(fw.installed);
        assert!(!fw.active, "ufw 'Status: inactive' must NOT read as active");
        assert!(fw.rules.is_empty(), "no rules table parsed when inactive");
    }

    /// fail2ban / ufw both ABSENT — installed=false, everything defaults.
    #[test]
    fn batch_first_pass_nothing_installed() {
        let blob = first_pass_blob(
            "F2B_NO", "inactive", "",
            "UFW_NO", "", "", "",
        );
        let sections = split_marked_sections(&blob);
        let (installed, active, jails, fw) = parse_security_first_pass(&sections, 2222);
        assert!(!installed);
        assert!(!active);
        assert!(jails.is_empty());
        assert!(!fw.installed);
        assert!(!fw.active);
        assert_eq!(fw.current_ssh_port, 2222);
        assert_eq!(fw.vpn_port, None);
    }

    // ── Second pass: per-jail status + config parsing ──

    /// Build a second-pass blob for one jail from its status + the three config
    /// values, in the marker order `build_jail_batch_command` emits them.
    fn jail_blob(jail: &str, status: &str, maxretry: &str, bantime: &str, findtime: &str) -> String {
        format!(
            "=== {} ===\n{status}\n\
             === {} ===\n{maxretry}\n\
             === {} ===\n{bantime}\n\
             === {} ===\n{findtime}\n",
            jail_status_key(jail),
            jail_value_key(jail, "maxretry"),
            jail_value_key(jail, "bantime"),
            jail_value_key(jail, "findtime"),
        )
    }

    #[test]
    fn batch_jail_parse_full() {
        let status = "Status for the jail: sshd\n\
            |- Filter\n\
            |  |- Currently failed: 3\n\
            |  |- Total failed:     42\n\
            |  `- File list:        /var/log/auth.log\n\
            `- Actions\n\
            \u{20}  |- Currently banned: 2\n\
            \u{20}  |- Total banned:     7\n\
            \u{20}  `- Banned IP list:   1.2.3.4 5.6.7.8";
        let blob = jail_blob("sshd", status, "5", "10m", "10m");
        let sections = split_marked_sections(&blob);
        let info = parse_jail_from_sections("sshd", &sections);

        assert_eq!(info.name, "sshd");
        assert_eq!(info.currently_failed, 3);
        assert_eq!(info.total_failed, 42);
        assert_eq!(info.currently_banned, 2);
        assert_eq!(info.total_banned, 7);
        assert_eq!(info.banned_ips, vec!["1.2.3.4".to_string(), "5.6.7.8".to_string()]);
        assert_eq!(info.maxretry, 5);
        assert_eq!(info.bantime, "10m");
        assert_eq!(info.findtime, "10m");
    }

    /// Jail with empty config values (jail.local absent AND get returned nothing) →
    /// numeric maxretry defaults to 0, durations stay empty (old unwrap_or_default).
    #[test]
    fn batch_jail_parse_empty_config() {
        let status = "Status for the jail: recidive\n\
            \u{20}  `- Banned IP list:";
        let blob = jail_blob("recidive", status, "", "", "");
        let sections = split_marked_sections(&blob);
        let info = parse_jail_from_sections("recidive", &sections);
        assert_eq!(info.maxretry, 0);
        assert_eq!(info.bantime, "");
        assert_eq!(info.findtime, "");
        assert!(info.banned_ips.is_empty());
    }

    // ── Command builders: heredoc discipline + safety (T-09-14) ──

    #[test]
    fn batch_command_uses_uuid_heredoc_no_static_eof() {
        let cmd = build_security_batch_command("sudo ", "deadbeefcafe");
        // UUID-delimited single-quoted heredoc (CLAUDE.md SSH rule).
        assert!(cmd.contains("SEC_EOF_deadbeefcafe"), "must use UUID-suffixed delimiter");
        assert!(cmd.contains("<<'SEC_EOF_deadbeefcafe'"), "delimiter must be single-quoted");
        // Never the static delimiters the rule forbids.
        assert!(!cmd.contains("USER_EOF"));
        assert!(!cmd.contains("<<'EOF'"));
        assert!(!cmd.contains("<<EOF"));
        // sudo prefix preserved on the sub-commands that originally had it.
        assert!(cmd.contains("sudo systemctl is-active fail2ban"));
        assert!(cmd.contains("sudo ufw status verbose"));
        // presence checks intentionally have NO sudo (they didn't before).
        assert!(cmd.contains("command -v fail2ban-client"));
    }

    #[test]
    fn jail_batch_command_skips_unsafe_jails_and_is_none_when_empty() {
        // No jails → no second round-trip.
        assert!(build_jail_batch_command("sudo ", &[], "x").is_none());
        // Only an unsafe jail name → nothing safe to query → None.
        assert!(build_jail_batch_command("sudo ", &["bad; rm -rf /".to_string()], "x").is_none());
        // A safe jail produces a UUID-heredoc command with status + 3 value markers.
        let cmd = build_jail_batch_command("sudo ", &["sshd".to_string()], "feed").unwrap();
        assert!(cmd.contains("<<'JAIL_EOF_feed'"));
        assert!(cmd.contains(&jail_status_key("sshd")));
        assert!(cmd.contains(&jail_value_key("sshd", "maxretry")));
        assert!(cmd.contains(&jail_value_key("sshd", "bantime")));
        assert!(cmd.contains(&jail_value_key("sshd", "findtime")));
        assert!(cmd.contains("sudo fail2ban-client status sshd"));
    }

    /// The splitter must round-trip arbitrary section bodies including blank lines.
    #[test]
    fn splitter_preserves_multiline_bodies() {
        let blob = "=== A ===\nline1\nline2\n=== B ===\n\n=== C ===\nx";
        let s = split_marked_sections(blob);
        assert_eq!(s.get("A").map(String::as_str), Some("line1\nline2"));
        assert_eq!(s.get("B").map(String::as_str), Some(""));
        assert_eq!(s.get("C").map(String::as_str), Some("x"));
    }
}
