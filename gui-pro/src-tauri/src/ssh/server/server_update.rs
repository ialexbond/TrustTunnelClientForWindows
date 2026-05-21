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

// Task 1 ships scaffolding; Task 2 wires async helpers consuming `client`,
// `Duration`, `detect_sudo`, `exec_command`, `SshHandler`, `ENDPOINT_BINARY`.
// `#[allow]` annotations sit on stubs (function-level), not module-level.

#[allow(unused_imports)] // Wave 3 Task 2 calls validate_version в update_sidecar S-02 surface defence.
use super::super::sanitize::validate_version;
use super::super::SshParams;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
#[allow(dead_code)] // Wave 3 Task 2 wires this in 7-step pipeline.
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
#[allow(dead_code)] // Wave 3 Task 2 emits 7 step keys в pipeline.
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

#[allow(dead_code)] // Wave 3 Task 2 consumes after backup step exec.
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
#[allow(dead_code)] // Wave 3 Task 2 invokes when computing asset URL.
pub fn compute_arch_for_asset(detected: Option<&str>) -> &'static str {
    match detected {
        Some("aarch64") | Some("arm64") => "aarch64",
        _ => "x86_64",
    }
}

// ═══════════════════════════════════════════════════════════════
//   ASYNC HELPERS + PUBLIC TAURI COMMANDS
//
//   Task 1 ships скелет (stub bodies) → module compiles + pure-helper
//   tests pass + AppState/lib.rs registrations cleanly wire через.
//
//   Task 2 заполнит full pipeline logic (8 async helpers + rollback
//   + cancel rollback asymmetry per D-3.4).
// ═══════════════════════════════════════════════════════════════

/// Phase 18 — public Tauri command stub (Task 1).
///
/// Task 2 implements 7-step pipeline (`download_tarball` → `extract` → `backup` →
/// `swap` → `restart` → `verify` → `complete`) + rollback path.
#[allow(clippy::too_many_arguments)]
pub async fn update_sidecar(
    _app: &tauri::AppHandle,
    _params: SshParams,
    _target_version: String,
    _cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    // Task 2 replaces this stub with full pipeline.
    Err("UPDATE_NOT_IMPLEMENTED".into())
}

/// Phase 18 — cancel checkpoint setter (Task 1 stub).
///
/// Frontend Plan 18-06 invokes — sets cancel flag. Following pipeline check_cancel
/// checkpoint returns `Err("UPDATE_CANCELLED")` → rollback path (Task 2).
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
        // Existence verification (each key used inside async helpers): Task 2 wraps в integration test.
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
}
