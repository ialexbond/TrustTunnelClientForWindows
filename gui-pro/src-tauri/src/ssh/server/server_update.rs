//! Phase 18 — atomic-swap sidecar update pipeline (REQ-18-UPDATE-FLOW-03..07).
//!
//! Реализует 7-step pipeline для обновления `trusttunnel_endpoint` binary
//! на сервере с автоматическим rollback при verify failure. Wave 3 backend
//! consumer — Plan 18-06 frontend listens на `update-protocol-step` events.
//!
//! ## Pipeline (7 steps emitted в `update-protocol-step` Tauri event):
//!
//! 1. `download_tarball` — wget tarball из GitHub releases в `/tmp/tt_update.tar.gz`
//! 2. `extract` — `tar -xzf` + `find -name trusttunnel_endpoint -type f` в `/tmp/tt_update_extract/`
//! 3. `backup` — `cp ENDPOINT_BINARY ENDPOINT_BINARY.bak` (defensive: BACKUP_SKIPPED если binary missing)
//! 4. `swap` — `mv extracted ENDPOINT_BINARY && chmod +x`
//! 5. `restart` — `systemctl restart trusttunnel` (NOT start — Phase 17.1 lesson)
//! 6. `verify` — 6×2s retry `systemctl is-active trusttunnel` (12s total) WITH cancel checkpoint
//! 7. `complete` — success → cleanup `/tmp`; verify-fail → rollback `mv .bak обратно`
//!
//! ## Reuse mapping (Phase 17.1 → Phase 18, target ≥70%)
//!
//! - `check_cancel` mirrors `server_mtproto.rs:15-22`
//! - `emit_update_step` mirrors `emit_mtproto_step` (server_mtproto.rs:51-62)
//! - `download_release_tarball` mirrors `download_telemt` (server_mtproto.rs:672-708)
//! - `restart_trusttunnel_and_wait` mirrors `start_telemt_and_wait` (server_mtproto.rs:820-846),
//!   parameterized 6×1s → 6×2s per D-3.5; **plus cancel_flag check** (PLAN-REVIEW Blocker #4)
//! - `rollback_to_bak` mirrors `rollback_telemt_install` (server_mtproto.rs:1038-1074),
//!   simplified — single binary restore vs full subsystem teardown
//! - UUID heredoc S-04 invariant: random `EOF_<uuid>` delimiter (mirrors download_telemt pattern)
//!
//! ## Critical invariants
//!
//! - **S-02 char-whitelist:** `validate_version(target_version)` первая строка `update_sidecar`
//! - **D-29:** `emit_update_step` принимает ТОЛЬКО literal/i18n keys в `message` — НЕ paths/secrets
//! - **D-3.7 surgical:** pipeline touches ТОЛЬКО `ENDPOINT_BINARY` + `.bak` + `/tmp/tt_update*`.
//!   НЕ ТРОГАЕТ vpn.toml, credentials.toml, Let's Encrypt, certbot, ufw rules, telemt service.
//!   Verified static-grep test `pipeline_surgical_invariant_static_grep`.
//! - **Cancel rollback asymmetry (D-3.4):** ТОЛЬКО `UPDATE_VERIFY_TIMEOUT` + `UPDATE_CANCELLED`
//!   trigger rollback; download/extract/swap errors preserve partial state для idempotent retry.
//! - **Service name `trusttunnel`** (systemd unit), НЕ `trusttunnel_endpoint` (researcher Finding 3)
//! - **Single-flight guard:** `AppState.update_sidecar_cancel` AtomicBool (REQ-18-UPDATE-FLOW-07)

use super::super::sanitize::validate_version;
use super::super::{detect_sudo, exec_command, SshHandler, SshParams, ENDPOINT_BINARY};
use russh::client;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

// ═══════════════════════════════════════════════════════════════
//   Cancel checkpoint
// ═══════════════════════════════════════════════════════════════

/// Phase 18 — cancel checkpoint mirror Phase 17.1 (`server_mtproto.rs:15-22`).
///
/// Returns `Err("UPDATE_CANCELLED")` если `cancel_flag` установлен.
/// Called между каждым pipeline step + внутри `restart_trusttunnel_and_wait` retry loop
/// (PLAN-REVIEW Blocker #4 fix — без этого user Cancel click в 12s verify window dead button).
#[inline]
pub(super) fn check_cancel(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        Err("UPDATE_CANCELLED".into())
    } else {
        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════
//   Event payload (frozen contract с Plan 18-06 frontend)
// ═══════════════════════════════════════════════════════════════

/// Phase 18 — `update-protocol-step` event payload.
///
/// **Frozen contract** с Plan 18-06 frontend listener. 7 backend step keys:
/// - `download_tarball` → UI «Скачивание» (percent 5..15)
/// - `extract`          → UI «Скачивание» (percent 18..25)
/// - `backup`           → UI «Резервная копия» (percent 30..50)
/// - `swap`             → UI «Применение» (percent 55..70)
/// - `restart`          → UI «Применение» (percent 72..80)
/// - `verify`           → UI «Проверка» (percent 80..100)
/// - `complete`         → финал (percent 100, status `completed` | `failed`)
///
/// Status values: `running` | `completed` | `failed`.
///
/// **D-29 invariant:** `message` ВСЕГДА metadata либо i18n key — НИКОГДА paths/secrets/.bak refs.
#[derive(Clone, Serialize)]
pub struct UpdateStep {
    pub step: String,
    pub status: String,
    pub percent: u32,
    pub message: String,
}

/// Phase 18 — emit update step event на frontend listener.
/// Mirrors Phase 17.1 `emit_mtproto_step` (server_mtproto.rs:51-62).
fn emit_update_step(app: &tauri::AppHandle, step: &str, status: &str, percent: u32, msg: &str) {
    app.emit(
        "update-protocol-step",
        UpdateStep {
            step: step.into(),
            status: status.into(),
            percent,
            message: msg.into(),
        },
    )
    .ok();
}

// ═══════════════════════════════════════════════════════════════
//   Pure helpers (testable без AppHandle / SSH session)
// ═══════════════════════════════════════════════════════════════

/// Phase 18 — backup operation status parser (pure helper).
///
/// Pipeline emits literal markers `BACKUP_OK` / `BACKUP_SKIPPED` (researcher §OQ-2 defensive).
/// Unknown output → `BackupStatus::Failed` (caller decides escalation).
#[derive(Debug, PartialEq, Eq)]
pub enum BackupStatus {
    Ok,
    Skipped,
    Failed,
}

pub fn parse_backup_status(stdout: &str) -> BackupStatus {
    if stdout.contains("BACKUP_OK") {
        BackupStatus::Ok
    } else if stdout.contains("BACKUP_SKIPPED") {
        BackupStatus::Skipped
    } else {
        BackupStatus::Failed
    }
}

/// Phase 18 — architecture selection (researcher §OQ-6).
///
/// Default `x86_64` для first ship — same simplification как Plan 18-03 asset selection.
/// ARM64 deferred. Если нужно auto-detect — invoke `uname -m` over SSH в caller, передать сюда.
///
/// Pure function для testability.
pub fn compute_arch_for_asset(detected: Option<&str>) -> &'static str {
    match detected {
        Some("aarch64") | Some("arm64") => "aarch64",
        _ => "x86_64",
    }
}

// ═══════════════════════════════════════════════════════════════
//   ASYNC HELPERS (8 functions, mirror Phase 17.1 patterns)
// ═══════════════════════════════════════════════════════════════

/// Phase 18 — download release tarball through wget + UUID heredoc (S-04).
///
/// Mirrors Phase 17.1 `download_telemt` (`server_mtproto.rs:672-708`).
/// URL pattern (researcher §Finding 1 verified live 2026-05-21):
/// `https://github.com/TrustTunnel/TrustTunnel/releases/download/v{TAG}/trusttunnel-v{TAG}-linux-{arch}.tar.gz`
///
/// **Preconditions:** `clean_version` already passed `validate_version()` upstream;
/// `arch` from `compute_arch_for_asset`. Sanity check: tarball size > 1 MB.
async fn download_release_tarball(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
    clean_version: &str,
    arch: &str,
) -> Result<(), String> {
    let delim = format!("UPD_DL_{}", uuid::Uuid::new_v4().simple());
    let cmd = format!(
        "{sudo}bash <<'{delim}'\n\
set -e\n\
URL=\"https://github.com/TrustTunnel/TrustTunnel/releases/download/v{ver}/trusttunnel-v{ver}-linux-{arch}.tar.gz\"\n\
wget -q -O /tmp/tt_update.tar.gz \"$URL\"\n\
test -s /tmp/tt_update.tar.gz\n\
SIZE=$(stat -c%s /tmp/tt_update.tar.gz 2>/dev/null || echo 0)\n\
if [ \"$SIZE\" -lt 1000000 ]; then\n\
  echo DOWNLOAD_TOO_SMALL\n\
  exit 1\n\
fi\n\
echo DOWNLOAD_OK\n\
{delim}",
        sudo = sudo,
        delim = delim,
        ver = clean_version,
        arch = arch,
    );
    let (out, _) = exec_command(handle, app, &cmd).await?;
    if !out.contains("DOWNLOAD_OK") {
        return Err("UPDATE_DOWNLOAD_FAILED".into());
    }
    Ok(())
}

/// Phase 18 — extract tarball + locate trusttunnel_endpoint binary inside.
///
/// Per researcher §Assumption A2 — `find -name -type f` robust against nested layouts.
/// Extracts to `/tmp/tt_update_extract/`. Returns absolute path of located binary.
async fn extract_tarball_and_find_binary(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<String, String> {
    let delim = format!("UPD_EX_{}", uuid::Uuid::new_v4().simple());
    let cmd = format!(
        "{sudo}bash <<'{delim}'\n\
set -e\n\
mkdir -p /tmp/tt_update_extract\n\
tar -xzf /tmp/tt_update.tar.gz -C /tmp/tt_update_extract\n\
EXTRACTED=$(find /tmp/tt_update_extract -name trusttunnel_endpoint -type f | head -1)\n\
test -n \"$EXTRACTED\"\n\
echo \"EXTRACT_OK $EXTRACTED\"\n\
{delim}",
        sudo = sudo,
        delim = delim,
    );
    let (out, _) = exec_command(handle, app, &cmd).await?;
    let trimmed = out.trim();
    let extracted_line = trimmed
        .lines()
        .find(|line| line.trim().starts_with("EXTRACT_OK "))
        .ok_or_else(|| "UPDATE_EXTRACT_FAILED".to_string())?;
    let extracted_path = extracted_line
        .trim()
        .strip_prefix("EXTRACT_OK ")
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "UPDATE_EXTRACT_FAILED".to_string())?;
    if extracted_path.is_empty() {
        return Err("UPDATE_EXTRACT_FAILED".into());
    }
    Ok(extracted_path)
}

/// Phase 18 — defensive backup of existing binary (researcher §OQ-2 / §Pitfall 5).
///
/// If ENDPOINT_BINARY missing (first ever update on server) — emit BACKUP_SKIPPED,
/// pipeline continues but rollback path falls through gracefully.
///
/// Returns `BackupStatus::Ok` | `BackupStatus::Skipped` | `BackupStatus::Failed`.
async fn backup_current_binary(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<BackupStatus, String> {
    let bin = ENDPOINT_BINARY;
    let cmd = format!(
        "{sudo}bash -c 'if [ -f {bin} ]; then \
            cp {bin} {bin}.bak && echo BACKUP_OK; \
          else echo BACKUP_SKIPPED; fi'",
        sudo = sudo,
        bin = bin,
    );
    let (out, _) = exec_command(handle, app, &cmd).await?;
    Ok(parse_backup_status(&out))
}

/// Phase 18 — atomic swap: `mv extracted_path → ENDPOINT_BINARY` + `chmod +x`.
///
/// Filesystem-atomic operation (mv within same FS, both /tmp and /opt typically on root FS).
/// Defence: validates extracted_path is within /tmp/tt_update_extract/ before touching swap.
async fn atomic_swap_binary(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
    extracted_path: &str,
) -> Result<(), String> {
    if !extracted_path.starts_with("/tmp/tt_update_extract/") {
        return Err("UPDATE_INVALID_EXTRACT_PATH".into());
    }
    let bin = ENDPOINT_BINARY;
    let cmd = format!(
        "{sudo}bash -c 'mv {extracted} {bin} && chmod +x {bin} && echo SWAP_OK'",
        sudo = sudo,
        extracted = extracted_path,
        bin = bin,
    );
    let (out, _) = exec_command(handle, app, &cmd).await?;
    if !out.contains("SWAP_OK") {
        return Err("UPDATE_SWAP_FAILED".into());
    }
    Ok(())
}

/// Phase 18 — `systemctl restart trusttunnel` + retry-loop is-active.
///
/// Mirrors Phase 17.1 `start_telemt_and_wait` (`server_mtproto.rs:820-846`) parameterized:
/// `attempts × sleep_between` window. Plan default: 6 × 2s = 12s window per D-3.5.
///
/// **PLAN-REVIEW Blocker #4 fix:** `cancel_flag` checked between sleep attempts so user
/// Cancel click reacts within ≤2 seconds inside the 12s verify window. Without this,
/// the Cancel button would be dead until full verify timeout.
///
/// Service name: `trusttunnel` (researcher §Finding 3 — systemd unit name; NOT `trusttunnel_endpoint`).
///
/// Returns `Ok(true)` if active within window, `Ok(false)` if timeout (caller triggers rollback).
async fn restart_trusttunnel_and_wait(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
    attempts: u32,
    sleep_between: Duration,
    cancel_flag: &AtomicBool,
) -> Result<bool, String> {
    // restart (NOT start — Phase 17.1 post-UAT lesson: start is no-op if active,
    // so swapped binary wouldn't actually run until next reboot).
    exec_command(handle, app, &format!("{sudo}systemctl restart trusttunnel")).await?;
    for attempt in 0..attempts {
        // PLAN-REVIEW Blocker #4 fix — cancel checkpoint inside verify loop.
        // User's Cancel click reacts within ≤ sleep_between latency, not stuck for 12s.
        check_cancel(cancel_flag)?;
        let (out, _) = exec_command(
            handle,
            app,
            &format!("{sudo}systemctl is-active trusttunnel"),
        )
        .await?;
        if out.trim() == "active" {
            return Ok(true);
        }
        if attempt < attempts - 1 {
            tokio::time::sleep(sleep_between).await;
        }
    }
    Ok(false)
}

/// Phase 18 — rollback path: restore `.bak` → ENDPOINT_BINARY + restart.
///
/// Mirrors Phase 17.1 `rollback_telemt_install` (`server_mtproto.rs:1038-1074`),
/// simplified — single binary restore vs full subsystem teardown.
///
/// Best-effort: if `.bak` absent (BACKUP_SKIPPED on forward path), emits ROLLBACK_NO_BAK
/// silently. Caller treats this as acceptable — pipeline already broke forward path,
/// restore impossible but errors swallowed (mirror Phase 17.1 cleanup posture).
async fn rollback_to_bak(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<(), String> {
    let bin = ENDPOINT_BINARY;
    let cmd = format!(
        "{sudo}bash -c 'if [ -f {bin}.bak ]; then \
            mv {bin}.bak {bin} && \
            chmod +x {bin} && \
            systemctl restart trusttunnel && \
            echo ROLLBACK_OK; \
          else echo ROLLBACK_NO_BAK; fi'",
        sudo = sudo,
        bin = bin,
    );
    exec_command(handle, app, &cmd).await.ok();
    Ok(())
}

/// Phase 18 — best-effort cleanup `/tmp` scratch after successful update.
///
/// Called ONLY on success path (per Phase 17.1 forensics pattern — keep artifacts
/// on error so operator can diagnose). Errors swallowed via `.ok()` and `2>/dev/null`.
async fn cleanup_tmp_artifacts(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) {
    let cmd = format!(
        "{sudo}rm -rf /tmp/tt_update.tar.gz /tmp/tt_update_extract 2>/dev/null; true",
        sudo = sudo,
    );
    exec_command(handle, app, &cmd).await.ok();
}

// ═══════════════════════════════════════════════════════════════
//   PUBLIC ENTRY — update_sidecar 7-step pipeline (REQ-18-UPDATE-FLOW-03..07)
// ═══════════════════════════════════════════════════════════════

/// Phase 18 — atomic-swap sidecar update with rollback (REQ-18-UPDATE-FLOW-03..07).
///
/// 7-step pipeline:
/// 1. `download_tarball` — wget tarball into `/tmp/tt_update.tar.gz`
/// 2. `extract` — `tar -xzf` + `find -name trusttunnel_endpoint -type f`
/// 3. `backup` — `cp ENDPOINT_BINARY ENDPOINT_BINARY.bak` (defensive, BACKUP_SKIPPED ok)
/// 4. `swap` — `mv extracted ENDPOINT_BINARY && chmod +x`
/// 5. `restart` — `systemctl restart trusttunnel`
/// 6. `verify` — 6×2s retry `systemctl is-active trusttunnel` (12s window) WITH cancel checks
/// 7. `complete` — success → cleanup `/tmp`; verify-fail → rollback `mv .bak обратно`
///
/// **Cancel rollback asymmetry (D-3.4 / Phase 17.1 mirror):** Only `UPDATE_VERIFY_TIMEOUT`
/// + `UPDATE_CANCELLED` trigger `rollback_to_bak`. Download/extract/swap errors preserve
///   partial state for idempotent retry (researcher §OQ-5).
///
/// **AtomicBool single-flight:** wrapper Tauri command in `commands/ssh_commands.rs::update_sidecar`
/// owns the AppState flag lifecycle (reset on start, reset on every exit path).
pub async fn update_sidecar(
    app: &tauri::AppHandle,
    params: SshParams,
    target_version: String,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    // ─── 1. S-02 surface defence — char-whitelist validation ────────
    validate_version(&target_version)?;
    let clean_version = target_version
        .strip_prefix('v')
        .unwrap_or(&target_version)
        .to_string();

    // ─── 2. Connect + detect privilege ──────────────────────────────
    let handle = params.connect_with_app(app.clone()).await?;
    let sudo = detect_sudo(&handle, app).await;
    check_cancel(&cancel_flag)?;
    let arch = compute_arch_for_asset(None); // x86_64 default; ARM64 deferred

    // ─── 3. Pipeline (async block — errors propagate for rollback decision) ─
    let pipeline_result: Result<(), String> = async {
        // ─── Step 1: download_tarball ───────────────────────────────
        emit_update_step(app, "download_tarball", "running", 5, "");
        check_cancel(&cancel_flag)?;
        download_release_tarball(&handle, app, sudo, &clean_version, arch).await?;
        emit_update_step(app, "download_tarball", "completed", 15, "");
        check_cancel(&cancel_flag)?;

        // ─── Step 2: extract ────────────────────────────────────────
        emit_update_step(app, "extract", "running", 18, "");
        let extracted_path = extract_tarball_and_find_binary(&handle, app, sudo).await?;
        emit_update_step(app, "extract", "completed", 25, "");
        check_cancel(&cancel_flag)?;

        // ─── Step 3: backup (defensive — researcher §OQ-2) ──────────
        emit_update_step(app, "backup", "running", 30, "");
        let backup_status = backup_current_binary(&handle, app, sudo).await?;
        // D-29 invariant — message MUST be i18n key, not paths/secrets.
        let backup_msg = match backup_status {
            BackupStatus::Ok => "backup.ok",
            BackupStatus::Skipped => "backup.skipped",
            BackupStatus::Failed => "backup.failed",
        };
        emit_update_step(app, "backup", "completed", 50, backup_msg);
        check_cancel(&cancel_flag)?;

        // ─── Step 4: swap (atomic mv + chmod) ───────────────────────
        emit_update_step(app, "swap", "running", 55, "");
        atomic_swap_binary(&handle, app, sudo, &extracted_path).await?;
        emit_update_step(app, "swap", "completed", 70, "");
        check_cancel(&cancel_flag)?;

        // ─── Step 5: restart + Step 6: verify (combined under retry helper) ──
        emit_update_step(app, "restart", "running", 72, "");
        // PLAN-REVIEW Blocker #4 — cancel_flag passed inside restart_trusttunnel_and_wait;
        // restart loop checks between sleeps so Cancel reacts within ≤2s in 12s window.
        let active = restart_trusttunnel_and_wait(
            &handle,
            app,
            sudo,
            6,
            Duration::from_secs(2),
            &cancel_flag,
        )
        .await?;
        if !active {
            emit_update_step(app, "verify", "failed", 95, "verify.timeout");
            return Err("UPDATE_VERIFY_TIMEOUT".into());
        }
        emit_update_step(app, "restart", "completed", 80, "");
        emit_update_step(app, "verify", "completed", 100, "");

        Ok(())
    }
    .await;

    // ─── 4. Disposition (success / rollback / preserve partial) ─────
    //
    // Phase 17.1 D-3.4 cancel rollback asymmetry pattern:
    //
    //   UPDATE_VERIFY_TIMEOUT → rollback (binary swapped but service won't start
    //     → must restore previous binary so server isn't dead)
    //   UPDATE_CANCELLED → rollback (user explicit cancel; expects clean state)
    //   Other errors (download/extract/swap fail) → preserve partial state
    //     (mostly happens before binary swap → no broken state to roll back from;
    //     allows idempotent retry without manual cleanup)
    let final_result = match pipeline_result {
        Ok(()) => {
            emit_update_step(app, "complete", "completed", 100, "");
            cleanup_tmp_artifacts(&handle, app, sudo).await;
            Ok(())
        }
        Err(ref e) if e == "UPDATE_VERIFY_TIMEOUT" || e == "UPDATE_CANCELLED" => {
            rollback_to_bak(&handle, app, sudo).await.ok();
            emit_update_step(app, "complete", "failed", 100, "complete.rolled_back");
            Err(e.clone())
        }
        Err(e) => {
            // Partial state preserved for idempotent retry (researcher §OQ-5 / D-3.4).
            emit_update_step(app, "complete", "failed", 100, "complete.partial_failure");
            Err(e)
        }
    };

    // Best-effort disconnect — pipeline used a direct (non-pooled) handle.
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();

    final_result
}

/// Phase 18 — cancel checkpoint setter (REQ-18-UPDATE-FLOW-07).
///
/// Frontend Plan 18-06 invokes via Tauri command wrapper `cancel_update_sidecar`.
/// Sets cancel flag; next `check_cancel` checkpoint in pipeline (including inside
/// `restart_trusttunnel_and_wait` verify loop per PLAN-REVIEW Blocker #4) returns
/// `Err("UPDATE_CANCELLED")` → rollback path.
pub fn update_sidecar_cancel(flag: &AtomicBool) {
    flag.store(true, Ordering::SeqCst);
}

// ═══════════════════════════════════════════════════════════════
//   UNIT TESTS
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Pure-helper tests (Task 1) ───────────────────────────────

    #[test]
    fn validate_version_rejects_injection_attempts() {
        // S-02 surface defence — REUSE existing validate_version.
        assert!(validate_version("1.0.33").is_ok());
        assert!(validate_version("v1.0.33").is_ok());
        assert!(validate_version("2.0.0-beta.1").is_ok());
        assert!(validate_version("1.0; rm -rf /").is_err());
        assert!(validate_version("$(whoami)").is_err());
        assert!(validate_version("").is_err());
        assert!(validate_version("`evil`").is_err());
    }

    #[test]
    fn parse_backup_status_matches_known_markers() {
        assert_eq!(parse_backup_status("BACKUP_OK"), BackupStatus::Ok);
        assert_eq!(parse_backup_status("some output\nBACKUP_OK\n"), BackupStatus::Ok);
        assert_eq!(parse_backup_status("BACKUP_SKIPPED"), BackupStatus::Skipped);
        assert_eq!(parse_backup_status("no marker"), BackupStatus::Failed);
        assert_eq!(parse_backup_status(""), BackupStatus::Failed);
    }

    #[test]
    fn compute_arch_returns_x86_64_default() {
        assert_eq!(compute_arch_for_asset(None), "x86_64");
        assert_eq!(compute_arch_for_asset(Some("x86_64")), "x86_64");
        assert_eq!(compute_arch_for_asset(Some("unknown")), "x86_64");
    }

    #[test]
    fn compute_arch_detects_aarch64_variants() {
        assert_eq!(compute_arch_for_asset(Some("aarch64")), "aarch64");
        assert_eq!(compute_arch_for_asset(Some("arm64")), "aarch64");
    }

    #[test]
    fn update_step_keys_frozen_contract() {
        // Plan 18-06 frontend STEP_INDEX matches these 7 keys exactly.
        // Adding key → must update frontend simultaneously (frozen contract / Option B mirror).
        let expected_keys = [
            "download_tarball",
            "extract",
            "backup",
            "swap",
            "restart",
            "verify",
            "complete",
        ];
        assert_eq!(expected_keys.len(), 7);

        // Existence verification — each key MUST appear at least once в body
        // (caller of emit_update_step). Module source self-reflection.
        let source = include_str!("./server_update.rs");
        let body = strip_comments_and_tests(source);
        for key in expected_keys.iter() {
            let needle = format!("\"{key}\"");
            assert!(
                body.contains(&needle),
                "Frozen contract violation: key '{key}' is declared в STEP_INDEX но не emitted \
                 в pipeline body. emit_update_step(..., \"{key}\", ...) missing.",
            );
        }
    }

    // ─── Surgical invariant static-grep (REQ-18-UPDATE-FLOW-05 / D-3.9) ───

    #[test]
    fn pipeline_surgical_invariant_static_grep() {
        // D-3.7 / D-3.9 / Phase 17.1 invariant — pipeline NEVER touches files outside
        // trusttunnel_endpoint* and its .bak + /tmp/tt_update* scratch.
        //
        // Forbidden substrings внутри ИСПОЛНЯЕМОГО кода (не комментариев и не tests):
        //   - vpn.toml (config preservation)
        //   - credentials.toml (D-29 cross-cut)
        //   - letsencrypt (cert preservation)
        //   - certbot (timer preservation)
        //   - .pem / .crt / .key (cert preservation)
        //
        // NOTE: doc-comments (`//!`, `///`) и body внутри `mod tests` legitimately могут
        // упоминать forbidden strings (e.g. "DOES NOT TOUCH vpn.toml" doc, test fixtures).
        // strip_comments_and_tests удаляет оба.

        let source = include_str!("./server_update.rs");
        let body_only = strip_comments_and_tests(source);

        let forbidden = [
            "vpn.toml",
            "credentials.toml",
            "letsencrypt",
            "certbot",
            "/etc/telemt",
            ".pem",
            ".crt",
            // ".key" excluded: "key_path" / "ssh-key" rust identifiers contain ".key" substring → false positive.
            // Verify .key cert mention manually if needed via explicit `*.key` filename pattern.
        ];

        for needle in forbidden.iter() {
            assert!(
                !body_only.contains(needle),
                "REQ-18-UPDATE-FLOW-05 violation: forbidden substring '{needle}' в pipeline body. \
                 Surgical invariant: pipeline touches ONLY ENDPOINT_BINARY + .bak + /tmp/tt_update*",
            );
        }
    }

    /// Strip Rust comments (`//`, `/* */`, `///`, `//!`) and entire `#[cfg(test)] mod tests { ... }` block.
    /// Used by surgical / D-29 invariant tests so legitimate doc-mentions of forbidden strings
    /// (e.g. "DOES NOT TOUCH .pem") don't trigger false positives.
    fn strip_comments_and_tests(src: &str) -> String {
        let bytes = src.as_bytes();
        let mut out = String::with_capacity(bytes.len());
        let mut i = 0;

        // Locate `#[cfg(test)]` once — everything from this marker до конца module — skip.
        let test_marker = "#[cfg(test)]";
        let cutoff = src.find(test_marker).unwrap_or(src.len());

        while i < cutoff {
            let c = bytes[i] as char;

            // Line comment `// ...` (includes `///` and `//!`)
            if c == '/' && i + 1 < cutoff && bytes[i + 1] as char == '/' {
                while i < cutoff && bytes[i] as char != '\n' {
                    i += 1;
                }
                continue;
            }

            // Block comment `/* ... */` (includes `/** ... */` and `/*! ... */`)
            if c == '/' && i + 1 < cutoff && bytes[i + 1] as char == '*' {
                i += 2;
                while i + 1 < cutoff && !(bytes[i] as char == '*' && bytes[i + 1] as char == '/') {
                    i += 1;
                }
                i = (i + 2).min(cutoff);
                continue;
            }

            out.push(c);
            i += 1;
        }

        out
    }

    // ─── D-29 invariant ─────────────────────────────────────────────

    #[test]
    fn d29_invariant_no_secrets_in_emit_update_step_calls() {
        // D-29: emit_update_step argument expressions ДОЛЖНЫ быть literal либо i18n keys,
        // НЕ format!() с paths/versions/secrets.
        //
        // Heuristic: для каждой строки исходника содержащей `emit_update_step` —
        // запретить упоминания `.bak` / `ENDPOINT_BINARY` / `.pem` / `credentials` в той же строке.
        // Перед сканом убираем comments + test block.

        let source = include_str!("./server_update.rs");
        let body_only = strip_comments_and_tests(source);

        for line in body_only.lines() {
            if !line.contains("emit_update_step") {
                continue;
            }
            let bad_patterns = [".bak", "ENDPOINT_BINARY", ".pem", "credentials"];
            for p in bad_patterns.iter() {
                assert!(
                    !line.contains(p),
                    "D-29 violation: emit_update_step line contains forbidden substring '{p}'. \
                     Message arg MUST be literal либо i18n key. Line: {}",
                    line.trim()
                );
            }
        }
    }

    // ─── PLAN-REVIEW Blocker #4 fix — cancel check inside verify loop ───

    #[test]
    fn restart_helper_signature_accepts_cancel_flag() {
        // PLAN-REVIEW Blocker #4 — `restart_trusttunnel_and_wait` MUST accept
        // `cancel_flag: &AtomicBool` so user Cancel reacts in ≤2s inside the 12s
        // verify window (not stuck for full timeout).
        //
        // Static-grep: the helper signature must list `cancel_flag:` parameter
        // AND the body must contain `check_cancel(cancel_flag)` invocation inside
        // the retry loop.

        let source = include_str!("./server_update.rs");

        // Helper signature contains `cancel_flag` parameter:
        assert!(
            source.contains("async fn restart_trusttunnel_and_wait"),
            "restart_trusttunnel_and_wait helper missing"
        );
        // The signature line lists `cancel_flag` parameter (after refactor по plan).
        let restart_signature_block = source
            .split("async fn restart_trusttunnel_and_wait")
            .nth(1)
            .unwrap_or("");
        let first_brace = restart_signature_block.find('{').unwrap_or(0);
        let signature = &restart_signature_block[..first_brace];
        assert!(
            signature.contains("cancel_flag"),
            "PLAN-REVIEW Blocker #4 violation: restart_trusttunnel_and_wait MUST accept \
             cancel_flag parameter so the verify retry loop is interruptible. \
             Without this fix, user Cancel click is dead during 12s verify window."
        );

        // Function body has check_cancel(cancel_flag) call inside attempts loop:
        let body = &restart_signature_block[first_brace..];
        assert!(
            body.contains("check_cancel(cancel_flag)"),
            "PLAN-REVIEW Blocker #4 violation: restart_trusttunnel_and_wait body MUST call \
             check_cancel(cancel_flag) between sleep attempts. Cancel checkpoint missing."
        );
    }

    // ─── Surgical invariant runtime check (post Task 2 — async helpers wrote) ───

    #[test]
    fn surgical_invariant_after_async_helpers_implemented() {
        // Re-run static-grep after Task 2 wired async helpers — module body now contains
        // real bash strings (mv / cp / rm). Verify each `mv`/`cp`/`rm` line operates on
        // ALLOWED paths only: ENDPOINT_BINARY (and .bak), /tmp/tt_update*.

        let source = include_str!("./server_update.rs");
        let body_only = strip_comments_and_tests(source);

        for line in body_only.lines() {
            let trimmed = line.trim();
            if !(trimmed.contains("mv ")
                || trimmed.contains("cp ")
                || trimmed.contains("rm -")
                || trimmed.contains("rm \"")
                || trimmed.contains("rm '"))
            {
                continue;
            }
            // Lines that touch fs MUST NOT mention forbidden paths.
            let forbidden_op_targets = [
                "/etc/",
                "letsencrypt",
                "certbot",
                "credentials.toml",
                "vpn.toml",
                "hosts.toml",
            ];
            for f in forbidden_op_targets.iter() {
                assert!(
                    !line.contains(f),
                    "Surgical invariant (REQ-18-UPDATE-FLOW-05 / D-3.7 / D-3.9) violation: \
                     mv/cp/rm operation targets forbidden path '{f}'. \
                     Pipeline MUST touch only ENDPOINT_BINARY + .bak + /tmp/tt_update*. Line: {}",
                    trimmed
                );
            }
        }
    }
}
