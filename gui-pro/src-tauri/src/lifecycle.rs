//! Process-lifecycle decision helpers (Phase 2 Wave 0).
//!
//! This module holds the *pure-logic* decisions the connect-timeout watchdog
//! (Plan 02), the Job Object handling (Plan 03), and the window-independent
//! reconnect supervisor (Plan 04) will call. Keeping these as free functions
//! with no `AppHandle` / sidecar dependency is deliberate: it makes the
//! bounded reconnect, the 60 s connect timeout, the session-generation guard,
//! and the fast-fail decision unit-testable WITHOUT spawning a real process
//! (RESEARCH Wave 0 Gaps — "inject a try-connect closure / a clock").
//!
//! Nothing here is consumed yet (Plans 02/03/04 wire it in), so items are
//! `dead_code`-allowed at the module level. The module compiling + its tests
//! passing now means no later production task ships a `MISSING` verify — it
//! already has a green test target to satisfy (D-10: the app stays fully
//! connectable while this dead-but-tested module sits in the crate).
#![allow(dead_code)]

use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Named timing constants (D-02 / D-05).
//
// Promoted from inline literals so the rationale in the comments and the actual
// value can never drift apart — same convention as `connectivity.rs`
// (`POLL_INTERVAL_SECS` / `MAX_FAILURES`).
// ---------------------------------------------------------------------------

/// Maximum reconnect attempts before the supervisor gives up and surfaces an
/// honest failure (D-02). 10 (user decision, UAT fd63ec): 3 was too few — a
/// rebooting server often does not come back within 3 tries; 10 covers a server
/// restart, and the «Отмена» button lets the user bail at any point. Still BOUNDED
/// so we never loop forever on a permanently-dead server — after 10 the user sees
/// "Не удалось переподключиться" instead of a perpetual "Connecting…". Surfaced to
/// the UI as «Попытка N/10».
pub const RECONNECT_MAX_ATTEMPTS: u32 = 10;

/// Wait between reconnect attempts. Sub-minute on purpose so a SINGLE attempt's
/// inter-try gap stays short; the TOTAL budget is bounded by RECONNECT_MAX_ATTEMPTS
/// (10) and is allowed to run a few minutes (user decision) — the user can «Отмена»
/// at any point (D-02 / D-05, RESEARCH A3).
pub const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

/// Per-attempt budget for a single reconnect try. Kept short (sub-minute) so a
/// hung try does not stall the whole bounded sequence — a try that has not
/// connected within this window is treated as a failed attempt and we move on.
pub const RECONNECT_ATTEMPT_WINDOW: Duration = Duration::from_secs(15);

/// Hard ceiling for the *initial* connect before the watchdog declares the
/// "Connecting…" hung and forces an Error (D-05). 60 s is the agreed snappy-but-
/// tolerant bound from CONTEXT.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

/// If a freshly-respawned sidecar dies sooner than this, the supervisor counts
/// the failure *immediately* instead of sleeping the full
/// `RECONNECT_ATTEMPT_WINDOW` (Gemini fast-fail blindspot). Covers the
/// binary-missing / instant-crash case where waiting the full window would just
/// waste time before the inevitable retry.
pub const FAST_FAIL_GRACE: Duration = Duration::from_secs(2);

/// Per-edition PID-file basename (Gemini HIGH isolation, D-07).
///
/// Pro and Light must NEVER share `.sidecar.pid`: if they did, one edition's
/// stale-cleanup (kill-by-saved-PID) could kill the *other* edition's live VPN
/// when both are installed in the same directory. Pro writes `.sidecar-pro.pid`;
/// Light's mirror will use `.sidecar-light.pid`. Distinct names make the two
/// editions' PID files mutually invisible.
pub const SIDECAR_PID_BASENAME: &str = ".sidecar-pro.pid";

/// Stable, secret-free ASCII reason code emitted when a never-connected sidecar
/// exits non-zero AND the per-attempt pre-flight connectivity check also failed —
/// i.e. the most likely cause is "no internet" (adapter down / gateway
/// unreachable). The frontend (useVpnEvents `REASON_CODE_I18N`) maps it to the
/// localized `errors.no_internet` message — the user never sees a raw exit code.
///
/// 02-09 (UAT Gap #2): replaces the old `format!("Process exited with code {N}")`
/// passthrough. D-09/D-29: a FIXED token, never an exit code, config text, or
/// Cyrillic — so nothing the sidecar prints can leak into the UI/log channel.
pub const NO_INTERNET_REASON: &str = "no-internet";

/// Stable, secret-free ASCII reason code emitted when a never-connected sidecar
/// exits non-zero but the pre-flight DID see the network as reachable — a generic
/// sidecar failure rather than a connectivity outage. The same code is emitted
/// when the sidecar is killed mid-connect by AV / Task Manager (same never-
/// connected non-zero exit; no separate path is needed). Maps to
/// `errors.sidecar_exit` on the frontend. D-09/D-29: FIXED ASCII, no exit code.
pub const SIDECAR_EXIT_REASON: &str = "sidecar-exit";

/// Stable, secret-free ASCII reason code emitted when the LOCAL network adapter does
/// NOT return within the recovery-wait window (02-20 status-UX split). The
/// connectivity monitor shows «Восстановление» (Recovering) and WAITS for the
/// physical adapter on an `internet-lost` drop instead of burning the bounded
/// reconnect attempts; if the adapter is still gone after `RECOVERY_TIMEOUT`, the
/// session moves to a terminal `Error` carrying THIS code. The frontend (Stage 2)
/// maps it to the localized «Не удалось восстановить связь. Проверьте подключение к
/// интернету.» — the user never sees a raw token. D-09/D-29: FIXED ASCII, no
/// Cyrillic, no config/server text. Distinct from `RECONNECT_GAVE_UP_REASON`
/// (tunnel re-establish gave up) so the UI can tell "your internet never came back"
/// apart from "the server stopped responding".
pub const RECOVERY_TIMEOUT_REASON: &str = "recovery-timeout";

// ---------------------------------------------------------------------------
// Pure decision helpers.
//
// All free of any sidecar / `AppHandle` dependency so they can be exercised by
// `cargo test` without a real process (RESEARCH Wave 0 — "inject a try-connect
// closure").
// ---------------------------------------------------------------------------

/// Should the supervisor auto-reconnect after a sidecar terminated? (D-04)
///
/// Reconnect ONLY when the drop was *unexpected* (`!was_intentional`) AND the
/// VPN had actually been *connected* (`was_connected`). A user-initiated
/// Disconnect (`was_intentional`) or a never-connected startup failure
/// (`!was_connected`) must NOT trigger a reconnect loop.
pub fn should_reconnect(was_intentional: bool, was_connected: bool) -> bool {
    !was_intentional && was_connected
}

/// Has the supervisor exhausted its bounded budget? (D-02)
///
/// `attempt` is 1-based (the first try is attempt 1). Returns true once we have
/// reached the cap, so the caller stops at attempt 3 and never starts a 4th.
pub fn gave_up(attempt: u32) -> bool {
    attempt >= RECONNECT_MAX_ATTEMPTS
}

/// Session-generation guard (Codex HIGH race concern).
///
/// Every connect bumps a monotonically-increasing "generation". A watchdog or
/// supervisor captures the generation it was started for; before it performs any
/// side effect (kill / `set_vpn_status` / respawn) it must prove it still owns
/// the live session by checking `captured == live`. If a manual reconnect or
/// disconnect advanced `live` past `captured`, this returns false and the stale
/// actor must abort — it no longer owns the session it was watching.
pub fn is_current_generation(captured: u64, live: u64) -> bool {
    captured == live
}

/// Is this failure reason TERMINAL — i.e. never recoverable by simply retrying the
/// same connect? (02-10, Tier-3, T-10-03)
///
/// The reconnect supervisor's bounded loop should NOT burn all three attempts on a
/// failure that a retry cannot fix: wrong credentials, an invalid config, or a
/// missing/unusable VPN adapter will fail identically every time. Short-circuiting on
/// these surfaces the honest error to the user IMMEDIATELY instead of after ~45s of
/// pointless retries (a worse UX and a DoS-ish waste).
///
/// This is the SINGLE source of the terminal set — both editions match on the exact
/// derived error strings the sidecar fatal-marker path sets (`sidecar.rs`
/// `fatal_marker_error` / `config_parse_error`), so the supervisor and the marker
/// path can never disagree on what counts as terminal. TRANSIENT reasons
/// (tunnel-lost, internet-lost, sidecar-exit, no-internet, connect-timeout, a refused
/// connection, a listener that failed to bind) are deliberately EXCLUDED — those can
/// succeed on a later attempt (the server may come back, the port may free up), so the
/// loop must keep retrying them.
///
/// Pure + unit-tested so the terminal/transient classification can be exercised
/// without a real sidecar.
pub fn is_terminal_reason(reason: &str) -> bool {
    matches!(
        reason,
        // Auth failure — same credentials will fail identically on every retry.
        "Authorization failed"
        // WinTUN adapter could not be created — a missing/blocked adapter does not
        // heal between two back-to-back respawns.
        | "VPN adapter creation failed"
        // Malformed config — the file is the same on every attempt.
        | "Configuration parse error. Check your config file."
    )
}

/// Did the respawned sidecar die "too soon"? (Gemini fast-fail blindspot)
///
/// When a respawn dies in less than `FAST_FAIL_GRACE`, the supervisor should
/// count the failure right away and proceed to the next attempt instead of
/// sleeping the full `RECONNECT_ATTEMPT_WINDOW`. Returns true for an
/// instant-death respawn (e.g. missing binary, immediate crash).
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
    fn attempts_bounded_to_max() {
        // D-02: gave_up(attempt) is the give-up boundary (used to skip the sleep after the
        // last attempt) — true AT and beyond RECONNECT_MAX_ATTEMPTS, false before it. The
        // real loop runs `for attempt in 1..=RECONNECT_MAX_ATTEMPTS`. Asserted against the
        // const (not a hard-coded number) so a future retune can't silently drift the test.
        let mut yielded = Vec::new();
        let mut attempt: u32 = 1;
        while !gave_up(attempt) {
            yielded.push(attempt);
            attempt += 1;
        }
        let expected: Vec<u32> = (1..RECONNECT_MAX_ATTEMPTS).collect();
        assert_eq!(yielded, expected);
        assert!(!gave_up(RECONNECT_MAX_ATTEMPTS - 1));
        assert!(gave_up(RECONNECT_MAX_ATTEMPTS)); // give up AT the cap
        assert!(gave_up(RECONNECT_MAX_ATTEMPTS + 1)); // and anything beyond
        assert_eq!(RECONNECT_MAX_ATTEMPTS, 10);
    }

    #[test]
    fn reconnect_budget_is_bounded_and_per_attempt_snappy() {
        // The user chose up to 10 reconnect attempts (UAT fd63ec): a rebooting server needs
        // more than 3 tries, and «Отмена» lets the user bail. So the TOTAL is allowed to be
        // a few minutes — but each SINGLE attempt must stay sub-minute so one hung try can't
        // stall the whole sequence, and the total stays hard-BOUNDED (never infinite).
        assert_eq!(RECONNECT_MAX_ATTEMPTS, 10);
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(60));
        assert!(RECONNECT_ATTEMPT_WINDOW < Duration::from_secs(60));
        assert!(RECONNECT_INTERVAL < Duration::from_secs(60));
        // Worst case (every attempt burns its full window + interval) stays bounded;
        // fast-fail skips the interval for instant deaths, so the real worst case is lower.
        let worst_case = (RECONNECT_ATTEMPT_WINDOW + RECONNECT_INTERVAL) * RECONNECT_MAX_ATTEMPTS;
        assert!(worst_case <= Duration::from_secs(180));
    }

    #[test]
    fn generation_guard_blocks_stale_actor() {
        // Codex HIGH: a watchdog/supervisor that captured generation 7 must only
        // act while the live generation is still 7. Once a manual reconnect /
        // disconnect bumps live to 8, the stale actor must abort.
        assert!(is_current_generation(7, 7)); // same generation → still owns the session
        assert!(!is_current_generation(7, 8)); // live advanced → stale, must NOT act
        assert!(!is_current_generation(8, 7)); // any mismatch → not current
    }

    #[test]
    fn fast_fail_counts_failure_without_full_wait() {
        // Gemini fast-fail: a respawn that died sooner than FAST_FAIL_GRACE is an
        // instant death — count the failure now, skip the full attempt window.
        assert!(is_fast_fail(Duration::from_millis(50))); // instant crash → fast-fail
        assert!(is_fast_fail(FAST_FAIL_GRACE - Duration::from_millis(1))); // just under grace
        assert!(!is_fast_fail(FAST_FAIL_GRACE)); // at the grace boundary → not fast-fail
        assert!(!is_fast_fail(RECONNECT_ATTEMPT_WINDOW)); // survived the window → not fast-fail
    }

    #[test]
    fn terminal_reasons_short_circuit_transient_ones_retry() {
        // 02-10 (T-10-03): the never-recoverable-by-retry class returns true so the
        // supervisor stops after attempt 1; everything a retry COULD fix returns false.
        // Terminal — match the exact derived strings sidecar.rs fatal markers set.
        assert!(is_terminal_reason("Authorization failed"));
        assert!(is_terminal_reason("VPN adapter creation failed"));
        assert!(is_terminal_reason("Configuration parse error. Check your config file."));
        // Transient — a later attempt may succeed, so the loop must keep retrying.
        assert!(!is_terminal_reason("tunnel-lost"));
        assert!(!is_terminal_reason("internet-lost"));
        assert!(!is_terminal_reason("sidecar-exit"));
        assert!(!is_terminal_reason("no-internet"));
        assert!(!is_terminal_reason("connect-timeout"));
        assert!(!is_terminal_reason("reconnect-gave-up"));
        // A refused connection / failed listener are transient (server may recover).
        assert!(!is_terminal_reason("Server refused the connection"));
        assert!(!is_terminal_reason("Failed to start VPN tunnel"));
        // Unknown / empty → not terminal (default to retrying, never short-circuit
        // on something we do not recognize).
        assert!(!is_terminal_reason(""));
        assert!(!is_terminal_reason("some unrecognized failure"));
    }

    #[test]
    fn pid_basename_is_per_edition() {
        // Gemini HIGH isolation: Pro must use its OWN PID basename so it can never
        // read or stale-kill Light's sidecar (and vice-versa) when co-installed.
        assert_eq!(SIDECAR_PID_BASENAME, ".sidecar-pro.pid");
        assert_ne!(SIDECAR_PID_BASENAME, ".sidecar.pid"); // NOT the shared basename
        assert_ne!(SIDECAR_PID_BASENAME, ".sidecar-light.pid"); // distinct from Light
    }

    #[test]
    fn never_connected_exit_reason_codes_are_ascii_and_cyrillic_free() {
        // 02-09 (UAT Gap #2) — mirror of vpn.rs `timeout_error_uses_reason_code_not_cyrillic`.
        // CLAUDE.md i18n rule + D-29: the value the sidecar Terminated arm passes to
        // the single mutator for a never-connected non-zero exit is a STABLE ASCII
        // reason code, never a user-facing string and never the raw exit code. Lock
        // the exact codes + their ASCII/Cyrillic-free invariant so a future edit can
        // never reintroduce a Russian string or an exit-code passthrough.
        for reason in [NO_INTERNET_REASON, SIDECAR_EXIT_REASON] {
            assert!(reason.is_ascii(), "reason code {reason:?} must be ASCII");
            assert!(
                !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
                "reason code {reason:?} must contain NO Cyrillic",
            );
            // It must not embed a stray exit-code digit pattern — these are pure tokens.
            assert!(!reason.chars().any(|c| c.is_ascii_digit()), "reason code {reason:?} must carry no exit code");
        }
        assert_eq!(NO_INTERNET_REASON, "no-internet");
        assert_eq!(SIDECAR_EXIT_REASON, "sidecar-exit");
        assert_ne!(NO_INTERNET_REASON, SIDECAR_EXIT_REASON);
    }

    #[test]
    fn recovery_timeout_reason_is_ascii_cyrillic_free_and_distinct() {
        // 02-20 status-UX split: the recovery-wait give-up code is a STABLE ASCII
        // token (Stage 2 localizes it), never a Russian string and never an exit code.
        // It must also be DISTINCT from the tunnel-reconnect give-up so the UI can tell
        // "internet never returned" apart from "server stopped responding".
        assert_eq!(RECOVERY_TIMEOUT_REASON, "recovery-timeout");
        assert!(RECOVERY_TIMEOUT_REASON.is_ascii(), "reason code must be ASCII");
        assert!(
            !RECOVERY_TIMEOUT_REASON
                .chars()
                .any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic",
        );
        assert_ne!(RECOVERY_TIMEOUT_REASON, crate::connectivity::RECONNECT_GAVE_UP_REASON);
    }
}

// ─── FIX-B (RC-1): false-tunnel-loss hardening ─────────────────────────────
// A new virtual adapter appearing (Docker/WSL/Hyper-V vEthernet) wakes the
// connectivity monitor via the OS interface-change notification; a single
// transient tunnel-probe miss during that network churn must NOT accumulate
// toward MAX_FAILURES and trigger a reconnect that breaks live app sessions
// (the Claude Code 403-on-Docker-start regression). While the physical uplink
// is still present we reset the probe failure counter and settle, so only a
// SUSTAINED failure with no intervening adapter event declares the tunnel dead.
// See .planning/debug/claude-code-403-on-vpn-reconnect.md (RC-1 / FIX-B).

/// Settle delay after an interface-change wake before counting tunnel-probe
/// misses again. Long enough to outlast Docker/WSL NIC bring-up churn.
pub const ADAPTER_EVENT_SETTLE_MS: u64 = 1500;

/// Whether an interface-change wake should reset the tunnel-probe failure
/// counter: true when the physical uplink is still present (the event is a NIC
/// add / parameter change, not a loss of the real uplink).
pub fn reset_tunnel_failures_on_adapter_event(physical_uplink_present: bool) -> bool {
    physical_uplink_present
}

/// AUDIT-2026-06-11 #13: minimum spacing between two FIX-B failure-counter resets.
///
/// Unbounded, the FIX-B reset fired on EVERY honored adapter-event wake. Accumulating
/// MAX_FAILURES (3) probe misses needs ~12-15s of clean cadence, while the WR-01
/// debounce only enforces 750ms between honored wakes — so SUSTAINED interface churn
/// (a flapping Wi-Fi driver roaming between APs, Docker/WSL repeatedly recreating
/// vEthernet adapters, a failing USB NIC in a reconnect loop) firing at least once per
/// ~12s zeroed the counter forever: a genuinely dead tunnel stayed green «Connected»
/// with NO reconnect for as long as the churn persisted — the inverse over-correction
/// of the T-37 fix. 60s is comfortably above the worst-case detection window
/// (~12-15s), so between two allowed resets a sustained probe-failure streak ALWAYS
/// has room to cross MAX_FAILURES, while a one-off Docker/WSL bring-up burst (the
/// RC-1 case FIX-B exists for) is still absorbed by the first, allowed reset.
pub const FIXB_RESET_MIN_INTERVAL_SECS: u64 = 60;

/// AUDIT-2026-06-11 #13: pure rate-limit decision for the FIX-B counter reset —
/// at most one reset per `FIXB_RESET_MIN_INTERVAL_SECS`. Mirrors the WR-01
/// `should_honor_event_wake` debounce shape (now + last-honored Option) so the
/// decision stays clock/IO-free and unit-testable. The first reset of a session
/// (`last_reset == None`) is always allowed.
pub fn fixb_reset_allowed(now: Instant, last_reset: Option<Instant>) -> bool {
    match last_reset {
        None => true,
        Some(prev) => {
            now.duration_since(prev) >= Duration::from_secs(FIXB_RESET_MIN_INTERVAL_SECS)
        }
    }
}

#[cfg(test)]
mod adapter_event_tests {
    use super::*;

    #[test]
    fn virtual_add_with_uplink_present_resets() {
        // Docker/WSL vEthernet appears, real uplink still there → reset + settle.
        assert!(reset_tunnel_failures_on_adapter_event(true));
    }

    #[test]
    fn real_uplink_loss_does_not_reset() {
        // Physical uplink genuinely gone → do NOT mask it; let the loss path run.
        assert!(!reset_tunnel_failures_on_adapter_event(false));
    }

    #[test]
    fn settle_delay_is_sane() {
        assert!((500..=5000).contains(&ADAPTER_EVENT_SETTLE_MS));
    }

    // ── AUDIT-2026-06-11 #13: FIX-B reset rate-limit ────────────────────────

    #[test]
    fn fixb_first_reset_is_always_allowed() {
        // The first honored adapter-event wake of a session must still get its
        // reset — the RC-1 Docker/WSL bring-up case FIX-B exists for.
        assert!(fixb_reset_allowed(Instant::now(), None));
    }

    #[test]
    fn fixb_reset_is_rate_limited_within_the_window() {
        // Sustained interface churn (flapping Wi-Fi / vEthernet churn) firing
        // honored wakes faster than the window must NOT keep zeroing the failure
        // counter — otherwise tunnel-lost detection is starved indefinitely.
        let t0 = Instant::now();
        assert!(!fixb_reset_allowed(t0, Some(t0))); // immediate repeat → denied
        let just_under =
            t0 + Duration::from_secs(FIXB_RESET_MIN_INTERVAL_SECS) - Duration::from_millis(1);
        assert!(
            !fixb_reset_allowed(just_under, Some(t0)),
            "a reset under FIXB_RESET_MIN_INTERVAL_SECS must be denied",
        );
    }

    #[test]
    fn fixb_reset_allowed_again_after_the_window() {
        let t0 = Instant::now();
        let at_floor = t0 + Duration::from_secs(FIXB_RESET_MIN_INTERVAL_SECS);
        assert!(
            fixb_reset_allowed(at_floor, Some(t0)),
            "AT the window boundary the next reset is allowed again",
        );
        let well_past = t0 + Duration::from_secs(FIXB_RESET_MIN_INTERVAL_SECS * 3);
        assert!(fixb_reset_allowed(well_past, Some(t0)));
    }

    #[test]
    fn fixb_window_outlasts_the_detection_cadence() {
        // The whole point: between two ALLOWED resets there must be enough room for
        // a sustained probe-failure streak to cross MAX_FAILURES (~12-15s of clean
        // cadence in connectivity.rs). A window at or below the detection cadence
        // would reintroduce the starvation this fix removes.
        assert!(
            FIXB_RESET_MIN_INTERVAL_SECS >= 60,
            "rate-limit window must comfortably exceed the ~12-15s detection window",
        );
    }
}

// ─── FIX-D (RC: killswitch-ON warm-up grace) ───────────────────────────────
// The C++ fail-closed killswitch blocks ALL non-tunnel traffic — including our
// tunnel-liveness probe — while the tunnel is still warming up (handshake +
// routes + DNS proxy, up to ~1 min). The aggressive detect (POLL 4s × 3 ≈ 12s)
// declared a FALSE tunnel-lost before warm-up finished → recovery that also
// couldn't probe through the killswitch → hang. Tunnel-lost detection must be
// "armed" only AFTER the first successful probe, or after a warm-up grace has
// elapsed since connect. This is additive: with killswitch OFF the first probe
// succeeds in ~1s, so the grace ends immediately and behavior is unchanged
// (the killswitch-OFF 403 fix is not regressed). See
// .planning/debug/claude-code-403-on-vpn-reconnect.md (FIX-D).

/// Warm-up window after connect during which a failed tunnel probe does NOT
/// declare the tunnel dead (covers killswitch fail-closed warm-up).
pub const WARMUP_GRACE_SECS: u64 = 60;

/// Whether tunnel-lost detection is armed: a probe has succeeded at least once,
/// or the warm-up grace has elapsed since connect.
pub fn tunnel_loss_armed(connected_secs_ago: u64, first_probe_success: bool) -> bool {
    first_probe_success || connected_secs_ago >= WARMUP_GRACE_SECS
}

#[cfg(test)]
mod warmup_grace_tests {
    use super::*;

    #[test]
    fn not_armed_during_warmup_without_a_success() {
        // killswitch blocks the probe during warm-up → must NOT declare lost.
        assert!(!tunnel_loss_armed(0, false));
        assert!(!tunnel_loss_armed(WARMUP_GRACE_SECS - 1, false));
    }

    #[test]
    fn armed_immediately_after_first_success() {
        // Once the tunnel has proven alive, normal fast detection resumes.
        assert!(tunnel_loss_armed(0, true));
    }

    #[test]
    fn armed_after_grace_even_without_success() {
        // A tunnel that never warms up within the grace is then honestly declared dead.
        assert!(tunnel_loss_armed(WARMUP_GRACE_SECS, false));
        assert!(tunnel_loss_armed(WARMUP_GRACE_SECS + 10, false));
    }
}
