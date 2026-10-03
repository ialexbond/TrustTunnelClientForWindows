//! Process-lifecycle decision helpers for Light (Phase 2 — mirror of Pro's
//! `lifecycle.rs`).
//!
//! Holds the *pure-logic* decisions the connect-timeout watchdog (Task 2) and the
//! window-independent reconnect supervisor (Task 3) call. Keeping these as free
//! functions with no `AppHandle` / sidecar dependency is deliberate: it makes the
//! bounded-3 reconnect, the 60 s connect timeout, the session-generation guard, and
//! the fast-fail decision unit-testable WITHOUT spawning a real process (RESEARCH
//! Wave 0 — "inject a try-connect closure / a clock").
//!
//! Light is a monolith (no module split like Pro's vpn.rs/connectivity.rs), so the
//! production wiring lives in `lib.rs`; this module only owns the pure helpers +
//! their tests. Light's per-edition PID basename lives in `lib.rs`
//! (`SIDECAR_PID_BASENAME = ".sidecar-light.pid"`), NOT here, so it stays next to
//! its read/write/clear sites.
//!
//! Some helpers are wired in across Task 2 (watchdog) and Task 3 (supervisor); the
//! module-level `allow(dead_code)` mirrors Pro's `lifecycle.rs` so the constants and
//! pure helpers can land together without a clippy `-D warnings` failure on the
//! not-yet-wired ones.
#![allow(dead_code)]

use std::time::Duration;

// ---------------------------------------------------------------------------
// Named timing constants (D-02 / D-05) — mirror of Pro's values so Light is
// exactly as snappy. Promoted from inline literals so the rationale and the value
// can never drift apart.
// ---------------------------------------------------------------------------

/// Maximum reconnect attempts before the supervisor gives up and surfaces an honest
/// failure (D-02). Bounded to 3 so we never loop forever on a dead server.
pub const RECONNECT_MAX_ATTEMPTS: u32 = 3;

/// Wait between reconnect attempts. Sub-minute on purpose: three attempts plus their
/// per-attempt windows must stay snappy in total (D-02 / D-05).
pub const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

/// Per-attempt budget for a single reconnect try. Short (sub-minute) so a hung try
/// does not stall the whole bounded-3 sequence.
pub const RECONNECT_ATTEMPT_WINDOW: Duration = Duration::from_secs(15);

/// Hard ceiling for the *initial* connect before the watchdog declares the
/// "Connecting…" hung and forces an Error (D-05). 60 s — the agreed bound.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// If a freshly-respawned sidecar dies sooner than this, the supervisor counts the
/// failure *immediately* instead of sleeping the full `RECONNECT_ATTEMPT_WINDOW`
/// (Gemini fast-fail blindspot).
pub const FAST_FAIL_GRACE: Duration = Duration::from_secs(2);

/// Stable, secret-free ASCII reason code emitted when a never-connected sidecar
/// exits non-zero AND the per-attempt pre-flight connectivity check also failed —
/// i.e. the most likely cause is "no internet". Mirror of Pro's
/// `lifecycle::NO_INTERNET_REASON`; the string is BYTE-IDENTICAL across editions so
/// the shared frontend `REASON_CODE_I18N` map localizes both the same way (02-09,
/// UAT Gap #2). D-09/D-29: a FIXED token, never an exit code / config text / Cyrillic.
pub const NO_INTERNET_REASON: &str = "no-internet";

/// Stable, secret-free ASCII reason code emitted when a never-connected sidecar
/// exits non-zero but the pre-flight saw the network as reachable — a generic
/// sidecar failure (also covers an AV / Task-Manager kill mid-connect). Mirror of
/// Pro's `lifecycle::SIDECAR_EXIT_REASON`, byte-identical (02-09, UAT Gap #2).
pub const SIDECAR_EXIT_REASON: &str = "sidecar-exit";

// ---------------------------------------------------------------------------
// Pure decision helpers — free of any sidecar / `AppHandle` dependency so they can
// be exercised by `cargo test` without a real process (RESEARCH Wave 0).
// ---------------------------------------------------------------------------

/// Should the supervisor auto-reconnect after a sidecar terminated? (D-04)
///
/// Reconnect ONLY when the drop was *unexpected* (`!was_intentional`) AND the VPN
/// had actually been *connected* (`was_connected`). A user-initiated Disconnect or a
/// never-connected startup failure must NOT trigger a reconnect loop.
pub fn should_reconnect(was_intentional: bool, was_connected: bool) -> bool {
    !was_intentional && was_connected
}

/// Has the supervisor exhausted its bounded-3 budget? (D-02)
///
/// `attempt` is 1-based. Returns true once we have reached the cap, so the caller
/// stops at attempt 3 and never starts a 4th.
pub fn gave_up(attempt: u32) -> bool {
    attempt >= RECONNECT_MAX_ATTEMPTS
}

/// Session-generation guard (Codex HIGH race concern).
///
/// Every connect bumps a monotonically-increasing "generation". A watchdog or
/// supervisor captures the generation it was started for; before any side effect
/// (kill / status-write / respawn) it must prove it still owns the live session by
/// checking `captured == live`. If a manual reconnect or disconnect advanced `live`
/// past `captured`, this returns false and the stale actor must abort.
pub fn is_current_generation(captured: u64, live: u64) -> bool {
    captured == live
}

/// Is this failure reason TERMINAL — never recoverable by simply retrying? (02-10,
/// Tier-3, T-10-03). Mirror of Pro's `lifecycle::is_terminal_reason`.
///
/// The reconnect supervisor must NOT burn all three attempts on a failure a retry
/// cannot fix (wrong creds / invalid config / missing adapter) — those fail
/// identically every time, so the honest error should surface immediately. The
/// terminal set matches the exact derived error strings Light's sidecar fatal-marker
/// path sets (`sidecar.rs`), byte-identical to Pro so both editions classify the same.
/// TRANSIENT reasons (tunnel-lost / internet-lost / sidecar-exit / no-internet /
/// connect-timeout / a refused connection) are EXCLUDED — a later attempt may succeed.
pub fn is_terminal_reason(reason: &str) -> bool {
    matches!(
        reason,
        "Authorization failed"
        | "VPN adapter creation failed"
        | "Configuration parse error. Check your config file."
    )
}

/// Did the respawned sidecar die "too soon"? (Gemini fast-fail blindspot)
///
/// When a respawn dies in less than `FAST_FAIL_GRACE`, the supervisor counts the
/// failure right away and proceeds to the next attempt instead of sleeping the full
/// `RECONNECT_ATTEMPT_WINDOW`.
pub fn is_fast_fail(elapsed: Duration) -> bool {
    elapsed < FAST_FAIL_GRACE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_reconnect_only_on_unexpected_drop() {
        // D-04: reconnect ONLY for an unexpected drop of a working VPN.
        assert!(should_reconnect(false, true)); // unexpected drop while connected → reconnect
        assert!(!should_reconnect(true, true)); // user disconnected → no reconnect
        assert!(!should_reconnect(false, false)); // never connected (startup fail) → no reconnect
        assert!(!should_reconnect(true, false)); // intentional + never connected → no reconnect
    }

    #[test]
    fn attempts_bounded_to_three() {
        // D-02: the attempt loop yields exactly 1, 2 inside the loop and gives up at 3.
        let mut yielded = Vec::new();
        let mut attempt: u32 = 1;
        while !gave_up(attempt) {
            yielded.push(attempt);
            attempt += 1;
        }
        assert_eq!(yielded, vec![1, 2]);
        assert!(!gave_up(1));
        assert!(!gave_up(2));
        assert!(gave_up(3)); // give up AT attempt 3
        assert!(gave_up(4));
        assert_eq!(RECONNECT_MAX_ATTEMPTS, 3);
    }

    #[test]
    fn consts_are_snappy() {
        // D-02 / D-05: snappy total reconnect, not 3× the 60 s initial timeout.
        assert_eq!(RECONNECT_MAX_ATTEMPTS, 3);
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(60));
        assert!(RECONNECT_ATTEMPT_WINDOW < Duration::from_secs(60));
        assert!(RECONNECT_INTERVAL < Duration::from_secs(60));
        let worst_case = (RECONNECT_ATTEMPT_WINDOW + RECONNECT_INTERVAL) * RECONNECT_MAX_ATTEMPTS;
        assert!(worst_case < Duration::from_secs(180));
    }

    #[test]
    fn generation_guard_blocks_stale_actor() {
        // Codex HIGH: a supervisor that captured generation 7 must only act while the
        // live generation is still 7.
        assert!(is_current_generation(7, 7));
        assert!(!is_current_generation(7, 8));
        assert!(!is_current_generation(8, 7));
    }

    #[test]
    fn fast_fail_counts_failure_without_full_wait() {
        // Gemini fast-fail: a respawn that died sooner than FAST_FAIL_GRACE is an
        // instant death — count it now, skip the full attempt window.
        assert!(is_fast_fail(Duration::from_millis(50)));
        assert!(is_fast_fail(FAST_FAIL_GRACE - Duration::from_millis(1)));
        assert!(!is_fast_fail(FAST_FAIL_GRACE));
        assert!(!is_fast_fail(RECONNECT_ATTEMPT_WINDOW));
    }

    #[test]
    fn terminal_reasons_short_circuit_transient_ones_retry() {
        // 02-10 (T-10-03) mirror of Pro: the never-recoverable-by-retry class returns
        // true so the supervisor stops after attempt 1; retryable failures return false.
        assert!(is_terminal_reason("Authorization failed"));
        assert!(is_terminal_reason("VPN adapter creation failed"));
        assert!(is_terminal_reason("Configuration parse error. Check your config file."));
        assert!(!is_terminal_reason("tunnel-lost"));
        assert!(!is_terminal_reason("internet-lost"));
        assert!(!is_terminal_reason("sidecar-exit"));
        assert!(!is_terminal_reason("no-internet"));
        assert!(!is_terminal_reason("connect-timeout"));
        assert!(!is_terminal_reason("reconnect-gave-up"));
        assert!(!is_terminal_reason("Server refused the connection"));
        assert!(!is_terminal_reason("Failed to start VPN tunnel"));
        assert!(!is_terminal_reason(""));
        assert!(!is_terminal_reason("some unrecognized failure"));
    }

    #[test]
    fn never_connected_exit_reason_codes_are_ascii_and_cyrillic_free() {
        // 02-09 (UAT Gap #2) — mirror of Pro's lifecycle test + vpn.rs
        // `timeout_error_uses_reason_code_not_cyrillic`. The value the sidecar
        // Terminated arm passes for a never-connected non-zero exit is a STABLE ASCII
        // reason code, never a user-facing Russian string (the old Light code emitted
        // Cyrillic "Процесс завершился с кодом N") and never the raw exit code.
        for reason in [NO_INTERNET_REASON, SIDECAR_EXIT_REASON] {
            assert!(reason.is_ascii(), "reason code {reason:?} must be ASCII");
            assert!(
                !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
                "reason code {reason:?} must contain NO Cyrillic",
            );
            assert!(!reason.chars().any(|c| c.is_ascii_digit()), "reason code {reason:?} must carry no exit code");
        }
        // Byte-identical to Pro so the shared frontend localizes both editions the same.
        assert_eq!(NO_INTERNET_REASON, "no-internet");
        assert_eq!(SIDECAR_EXIT_REASON, "sidecar-exit");
        assert_ne!(NO_INTERNET_REASON, SIDECAR_EXIT_REASON);
    }
}
