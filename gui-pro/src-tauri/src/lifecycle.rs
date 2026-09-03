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

/// Reconnect attempts a SINGLE failover candidate gets before the walk moves to the next
/// server in priority order (Phase 28 D-02; owner ruling 2026-08-22, `28-RESEARCH.md` OQ-2).
///
/// This deliberately OVERRIDES `RECONNECT_MAX_ATTEMPTS` on the failover path, and the owner
/// accepted the trade knowingly. The 10-attempt budget above exists because «a rebooting server
/// often does not come back within 3 tries»; with ONE attempt per candidate an ordinary server
/// restart (updates, a manual reboot) is no longer survived — the app moves the user to the next
/// server, and because there is NO automatic return (27 D-09) that move is permanent until the
/// user goes back by hand. The owner was shown that consequence and chose speed of restored
/// internet over staying put.
///
/// Do NOT silently «fix» this back. If real use shows people displaced by routine restarts, the
/// remedy named in `28-CONTEXT.md` is the deferred auto-return, not a quiet raise of this number.
/// The origin server is a candidate like any other — it gets exactly this budget too (OQ-2).
pub const FAILOVER_ATTEMPTS_PER_CANDIDATE: u32 = 1;

/// Wait between reconnect attempts. Sub-minute on purpose so a SINGLE attempt's
/// inter-try gap stays short; the TOTAL budget is bounded by RECONNECT_MAX_ATTEMPTS
/// (10) and is allowed to run a few minutes (user decision) — the user can «Отмена»
/// at any point (D-02 / D-05, RESEARCH A3).
pub const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

/// Per-attempt CEILING for a single reconnect try (3.8 F-2 — was a flat 15s window).
///
/// The respawned child's `Connected` edge is now traffic-readiness-gated (up to
/// `sidecar::TRAFFIC_READINESS_CAP` = 45s on http3 — the 3.8 delay-green). A flat 15s window
/// counted every still-warming respawn as a FAILED attempt, and the NEXT attempt killed the
/// warming child — so auto-reconnect became STRUCTURALLY unable to succeed on a slow-warmup
/// protocol (Fable-5 F-2). `respawn_and_wait` now polls until the child CONNECTS, the child DIES,
/// or the status goes terminal, and only falls back to this ceiling for a WEDGED-but-alive child.
/// It must EXCEED the traffic-readiness cap (so a slow warmup can finish) yet stay sub-minute (so
/// one hung try can't stall the bounded sequence). The early-exit keeps the real common case short.
pub const RECONNECT_ATTEMPT_WINDOW: Duration = Duration::from_secs(55);

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

/// Stable, secret-free ASCII reason code emitted when `routing_rules.json` exists but
/// cannot be parsed, so the app does not know what the user asked it to route
/// (D-02, 30.1 milestone review blocker 2).
///
/// Distinct from every neighbour above, and the distinction is the whole point. The
/// codes above all describe a TUNNEL that would not come up — no internet, a sidecar
/// that died, an adapter that never returned. This one describes a tunnel we refuse to
/// bring up: the machinery is fine, but the ROUTING POLICY is unreadable, and a tunnel
/// carrying rules the user never wrote is worse than no tunnel. Collapsing it into
/// `sidecar-exit` would tell somebody to retry the connection when the thing they must
/// actually do is repair or reset their rule list — a message that sends the user to the
/// wrong screen is not a smaller version of the right one.
///
/// The wording lives as `errors.routing_rules_unreadable` on the frontend
/// (`vpnEventHelpers.ts` `REASON_CODE_I18N`), which points the user at the Routing tab
/// where the reset affordance lives. D-09/D-29: FIXED lowercase-kebab ASCII — never the
/// serde error text (English and unbounded), never a path, never Cyrillic.
///
/// TERMINAL (see `is_terminal_reason`): the file is byte-identical on every retry.
pub const ROUTING_RULES_UNREADABLE_REASON: &str = "routing-rules-unreadable";

/// Stable, secret-free ASCII reason code emitted when the CA-2 path-confinement guard
/// REFUSES a connect because the `.toml` it was handed does not live inside the app's data
/// root (`commands::paths::validate_app_path_canonical`).
///
/// **Why this code had to exist.** The guard used to abort with `set_vpn_status(…, None)`, and
/// a terminal `Error` carrying no reason renders the frontend's generic fallback —
/// «Не удалось выполнить подключение к серверу». That sentence blames the SERVER, which was
/// never contacted: the app refused before a single packet left the machine. The 30.1
/// regression diagnosis caught six real refusals on a real Windows install reported that way.
/// A wrong cause is not a milder version of the right one — it sends the user to restart a
/// server that is fine while the actual fix (the config file is not in the app's folder) goes
/// unmentioned.
///
/// Distinct from `ROUTING_RULES_UNREADABLE_REASON` above for the same reason that one is
/// distinct from its neighbours: that code means «I cannot read your ROUTING POLICY», this one
/// means «I will not open THIS FILE». Different file, different recovery, different sentence.
///
/// The wording lives as `errors.config_outside_data_dir` on the frontend
/// (`vpnEventHelpers.ts` `REASON_CODE_I18N`). D-09/D-29: FIXED lowercase-kebab ASCII — never
/// the guard's English sentence, never the offending path (that goes to the log, which is a
/// developer channel), never Cyrillic.
///
/// **Deliberately NOT registered in `is_terminal_reason`.** That predicate is consulted by the
/// reconnect supervisor over the RECORDED failure cause, and no path records this one: the
/// window guard returns `Err` straight to the caller, and the reconnect twin bails with a log
/// line and no recorded cause (`vpn.rs`, `respawn_sidecar` step 3). Registering a code nothing
/// records would be a guard over an empty set — the vacuous shape this phase keeps finding.
pub const CONFIG_OUTSIDE_DATA_DIR_REASON: &str = "config-outside-data-dir";

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
/// reached the cap, so the caller stops at the cap and never starts one more.
///
/// 28-02: `max_attempts` is a PARAMETER rather than the bare `RECONNECT_MAX_ATTEMPTS`, because
/// the failover walk hands each candidate `FAILOVER_ATTEMPTS_PER_CANDIDATE` while the
/// internet-lost recovery path keeps the full budget (D-01). Both callers must share ONE
/// give-up rule so the «the last attempt never sleeps» property holds identically on each —
/// on a 1-attempt candidate that means the walk moves to the next server immediately instead
/// of burning an inter-attempt sleep it will never use.
pub fn gave_up(attempt: u32, max_attempts: u32) -> bool {
    attempt >= max_attempts
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
        // D-02 (30.1 blocker 2): the ROUTING RULES file could not be parsed, so the app does
        // not know what the user asked it to route. Same argument as the malformed config one
        // line above — the bytes on disk are identical on the second read — but a different
        // file and a different recovery, which is why it is its own code and not a reuse.
        // Registering it here is what stops the supervisor spending three attempts of about a
        // minute each re-reading a file that cannot change while it reads it.
        //
        // NOTE this list is ALSO the sidecar's derived English fatal markers. Ours is the first
        // of our own kebab codes to join them; the two kinds coexist because this predicate is
        // deliberately the SINGLE source of the terminal set (see the doc above). What must NOT
        // follow from that is the inverse — see `connectivity::terminal_reason_for_give_up`,
        // whose allowlist stays narrow precisely so a sidecar English string cannot ride this
        // list onto a Russian screen.
        | ROUTING_RULES_UNREADABLE_REASON
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

/// FAB-R1 (Fable-5 review of Phase 14) — may a supervisor respawn STORE its
/// freshly-spawned child and write `Reconnecting`?
///
/// The window-independent reconnect supervisor captures `connection_generation`
/// at the drop and passes it down to `respawn_sidecar`. But `respawn_sidecar`
/// spawns the sidecar asynchronously, and during that `.await` a config switch's
/// `vpn_connect(B)` can run: it BUMPS `connection_generation` and — because the
/// child slot is momentarily empty mid-attempt — sails past the R8
/// "already running" guard and spawns its OWN B sidecar. If the supervisor then
/// blindly stores its A-retry child, TWO live sidecars coexist: the orphaned one
/// still owns the WinTUN adapter + the fail-closed killswitch and is invisible to
/// `kill_stale_sidecar` (different PID), or both bounce off R8 into a red error
/// over the live session. The generation guard the loop runs BEFORE each attempt
/// cannot catch this because the bump lands mid-attempt.
///
/// So `respawn_sidecar` RE-CHECKS this predicate immediately before it stores the
/// child into `sidecar_child` AND before `set_vpn_status(Reconnecting)`: the store
/// is allowed ONLY when the supervisor still owns the session — i.e. the captured
/// generation still equals the live one (`is_current_generation`) AND no durable
/// user-disconnect intent is set. Any mismatch means a `vpn_connect(B)` (or a
/// manual reconnect / a user disconnect) took over → the retry is STALE, so the
/// caller must kill the freshly-spawned child (drop its handle → KILL_ON_JOB_CLOSE
/// fires) and return WITHOUT overwriting the slot or the PID file.
///
/// Pure (mirrors `is_current_generation` / `respawn`-guard shape) so the
/// exhaustive gen-equal / gen-bumped / user-disconnect-set matrix is unit-tested
/// without a real sidecar.
pub fn respawn_may_store(
    captured_generation: u64,
    live_generation: u64,
    user_disconnect_requested: bool,
) -> bool {
    is_current_generation(captured_generation, live_generation) && !user_disconnect_requested
}

/// 3.1 R-GEN (Fable-5 Phase-14 investigation, F12) — may the sidecar reader task's `Terminated`
/// arm perform SESSION-STATUS side effects (write `vpn_status`, hand off to the reconnect
/// supervisor) for the child that just exited?
///
/// The arm already gates the pid-file cleanup + the `sidecar_child` slot clear on process IDENTITY
/// (`terminated_arm_owns_state` — a superseded child never strips a newer session's slot). But under
/// a rapid disconnect→connect churn the OLD child's `Terminated` is delivered while the slot is
/// TRANSIENTLY EMPTY (the disconnect took the child out; the new `vpn_connect` has already bumped the
/// generation and emitted `Connecting`, but not yet stored its own child). An empty slot reads as
/// "owns", so without a generation check the old child's non-zero exit writes `Error("sidecar-exit")`
/// onto the fresh `Connecting` — exactly the F12 window in the churn log (the error lands between
/// "Spawning..." and the new PID line). So the status side effects require BOTH: this child still owns
/// the shared-state slot AND its captured generation is still the live one. The pid-gated cleanup runs
/// regardless (this child's own housekeeping); only the session-scoped status/supervisor writes are
/// suppressed for a superseded exit.
///
/// Pure (mirrors `respawn_may_store` / `is_current_generation`) so the owns × generation matrix is
/// unit-tested without a real sidecar.
pub fn terminated_arm_may_write_status(
    owns_shared_state: bool,
    captured_generation: u64,
    live_generation: u64,
) -> bool {
    owns_shared_state && is_current_generation(captured_generation, live_generation)
}

/// FAB-R4 (Fable-5 review of Phase 14) — should `vpn_connect` BAIL to a clean
/// `Disconnected` instead of spawning the destination sidecar, because a genuine
/// user disconnect landed DURING a config switch (or a save-and-reconnect)?
///
/// A config switch A→B is a plain `vpn_disconnect(A)` → `vpn_connect(B)` on the
/// frontend. `switchTo` (and `handleReconnect` for a save-and-reconnect) raises
/// `set_switch_or_reconnect_pending(pending:true, …)` BEFORE its teardown; that
/// teardown's `vpn_disconnect` legitimately sets the durable
/// `user_disconnect_requested`; then `vpn_connect(B)` clears it. That clear is
/// CORRECT for the switch's OWN teardown intent — but it also erases a GENUINE
/// tray/manual «Отключить» that the user pressed in the teardown→connect gap, so
/// the app ends CONNECTED against an explicit Disconnect (inverting the
/// status-lifecycle «ручной Отключить побеждает» invariant).
///
/// **DECOUPLE-STAMP-FROM-BOOL (FAB-R4 re-fix, Fable option b):** the ORIGINAL
/// wiring keyed this decision on the `switch_or_reconnect_pending` BOOL — but that
/// bool is DEAD by the time `vpn_connect(B)` reads it: the FE sends
/// `set_switch_or_reconnect_pending(pending:false)` (the BL-01 plate-suppression
/// clear) BEFORE `vpn_connect(B)`, and that clear-edge also RESET the stamp to the
/// sentinel — so the guard saw `switch_pending=false, stamp=None` and NEVER fired
/// (the dead-guard defect Fable verified). The re-fix (a) leaves the stamp ALIVE
/// across the FE's `pending:false` clear (the clear only drops the BL-01 bool now),
/// and (b) keys this decision PURELY on the STAMP presence + the generation delta,
/// NOT on the transient bool. The stamp is CONSUMED (reset to the sentinel) by the
/// connect entry point that reads it, so it can influence at most the ONE
/// immediately-following connect and can never leak into a later unrelated one.
///
/// The fix distinguishes the two disconnect classes by a monotonic sequence
/// stamped from `connection_generation` at the moment the switch/save-and-reconnect
/// is authorized (the `set_switch_or_reconnect_pending(pending:true)` raise): we
/// record the LIVE generation THEN. The switch's OWN teardown-disconnect bumps the
/// generation exactly ONCE past the stamp (`stamped → stamped + 1`); a genuine tray
/// disconnect in the teardown→connect gap adds an EXTRA bump on top. So
/// `vpn_connect` bails iff a stamp exists AND the durable disconnect intent is set
/// AND the live generation has advanced PAST `stamped + 1` (an extra disconnect
/// landed after authorization). If no stamp exists, or the only generation advance
/// is the switch's own expected teardown (`live == stamped + 1` with intent from
/// that teardown), the normal switch/save-and-reconnect completes untouched.
///
/// `durable_disconnect_requested` — the T-31 durable intent flag.
/// `switch_authorized_generation` — the generation stamped when the switch /
///   save-and-reconnect was authorized (`None` = sentinel = "no switch stamped",
///   e.g. a plain manual connect or the supervisor-reconnect path). This is the
///   SOLE gate now (the transient `switch_pending` bool is no longer consulted here
///   — it is dead by connect time, which was the whole defect).
/// `live_generation` — the current `connection_generation` at the `vpn_connect`
///   decision point, read BEFORE this connect's own `fetch_add` bump (i.e. it
///   reflects every teardown/disconnect that has landed so far, but not yet this
///   connect's own increment).
///
/// The switch's OWN teardown-disconnect advances the generation exactly ONCE past
/// the stamp (`stamped → stamped + 1`), so `live == stamped + 1` is the expected,
/// normal switch — do NOT bail. A GENUINE tray/manual disconnect in the
/// teardown→connect gap adds an EXTRA bump, so `live > stamped + 1` → the user's
/// Disconnect landed after the switch was authorized and must win → bail.
///
/// Pure so the switch-completes / genuine-disconnect-wins / manual-connect /
/// supervisor-reconnect / stale-stamp matrix is unit-tested without a real sidecar.
pub fn switch_disconnect_wins(
    durable_disconnect_requested: bool,
    switch_authorized_generation: Option<u64>,
    live_generation: u64,
) -> bool {
    match switch_authorized_generation {
        // A switch/save-and-reconnect is authorized (a live stamp exists) AND the
        // durable intent is still set: bail ONLY if an EXTRA disconnect landed after
        // authorization. The switch's own single teardown advances the live
        // generation to exactly `stamped + 1`, so a live generation PAST that means a
        // genuine extra tray/manual disconnect bumped in between → the user's
        // Disconnect must win. Keyed on the STAMP (not the transient bool), because
        // the FE clears that bool BEFORE this connect runs (the dead-guard defect).
        Some(stamped) => {
            durable_disconnect_requested && live_generation > stamped.saturating_add(1)
        }
        // No stamp (sentinel → None): a plain manual connect, or the supervisor
        // reconnect which never stamps → NEVER bail here; the existing
        // connect_cancelled / generation guards own those paths. A normal manual
        // connect after a manual disconnect is the user RE-connecting on purpose.
        None => false,
    }
}

// ─── Phase 28 (27 D-06 / D-08, 28 D-01 / D-02): the failover decision pair ───
//
// «Авто-режим» stops choosing a server by measured latency and starts switching when the
// connection actually DROPS. The two decisions that steers — «is this drop a failover?» and
// «which servers, in what order?» — live here as pure functions for the same reason as every
// neighbour above: they can be exercised exhaustively by `cargo test` with no sidecar, no
// manifest on disk and no `AppHandle`, leaving only the real A→B→C path to manual UAT.

/// One failover candidate as the queue builder sees it: the three manifest facts the decision
/// needs, copied out of `commands::manifest::ConfigEntry` (`id`, `path`, `order`).
///
/// Deliberately a local shape rather than the manifest type — the builder must stay free of the
/// manifest module (and of `serde`, and of the filesystem) so it takes plain slices and returns
/// owned config paths. The caller does the one lossy step, reading the manifest and projecting
/// each entry onto this struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailoverCandidate {
    /// `ConfigEntry.id` — the stable id the exclusion set is expressed in (27 D-08).
    pub id: String,
    /// `ConfigEntry.path` — the absolute `.toml` path a respawn is given.
    pub path: String,
    /// `ConfigEntry.order` — the priority the user arranged in «Авто-режим» (lower = earlier).
    pub order: u32,
}

/// A stable identity key for a Windows config path — the ONLY form two paths may be compared in.
///
/// CR-02 (Phase 28 review). The queue used to de-duplicate by raw byte equality, and on Windows
/// that is a lie the frontend had already been bitten by and fixed: `useConfigPingSource.ts` (the
/// F2 defect, Phase 17) records that the ACTIVE path arrives from `tt_config_path` — written by
/// the tray adopt / deeplink / legacy paths — in a DIFFERENT string form than the manifest's own
/// `path` for the SAME file (`\` vs `/`, drive-letter case). `origin_path` here is
/// `state.config_path`, i.e. whatever string `vpn_connect` was handed; the tail is always the
/// Rust-written manifest form. So the two sides of the comparison genuinely disagree in the field.
///
/// What that cost: the origin was NOT filtered out of the tail, so it entered the queue twice —
/// burning two of the walk's one-attempt slots (D-02) on the same dead server — and
/// `failover_switch_target` then returned the origin's own path, in its other spelling, as a
/// «switch», firing the «Переключено автоматически» plate for a move that never happened. That is
/// exactly what `failover_connect_origin(0) → None` exists to prevent, defeated by a string form.
///
/// Deliberately byte-identical in behaviour to the frontend's `normalizePath`
/// (`gui-pro/src/shared/utils/samePath.ts`): trim, `\` → `/`, lowercase. Both ends of the IPC must
/// answer «same file?» the same way or the desync just moves. Like its frontend twin this is a
/// PRESENTATION-layer identity key, never a security boundary — confinement to the portable data
/// dir stays with `validate_app_path_canonical` (V12), which is unaffected.
pub fn canonical_path_key(path: &str) -> String {
    path.trim().replace('\\', "/").to_lowercase()
}

/// Which KIND of drop is this: the server went silent, or the user's own uplink is gone? (owner
/// UAT 2026-08-26, test 1)
///
/// The answer decides everything downstream. `TUNNEL_LOST_REASON` is the ONLY reason
/// `should_failover` accepts, so a drop classified as `INTERNET_LOST_REASON` never even builds a
/// failover queue: it goes to the wait-for-the-uplink recovery, which hands the supervisor a
/// ONE-entry queue and therefore the full `RECONNECT_MAX_ATTEMPTS` against the server that just
/// died. That is exactly the failure the owner hit — «Попытка 1 из 10» on a dead server with
/// «Авто-режим» on and a perfectly healthy Wi-Fi, and not one `[failover]` line in the log.
///
/// **Why the signal is the ADAPTER and not a gateway probe.** The classification used to call
/// `check_adapter_online()`, which opens a TCP connection to `gateway:80`. Its own doc says it is
/// for «adapter recovery — VPN is disconnected», and that is the context it is honest in. At THIS
/// seam the core process is still alive: its WinTUN adapter, its routes and its fail-closed
/// killswitch are all still installed, so the probe travels into the dead tunnel and fails
/// UNCONDITIONALLY. It therefore reported «gateway unreachable» for every server-side drop, and
/// the app concluded the user's own internet was gone. The real log says it in one line:
///
/// ```text
/// [diagnose] drop verdict: adapter=present, gateway=unreachable — cause is LOCAL (PC / Wi-Fi …)
/// ```
///
/// `adapter=present` and `gateway=unreachable` in the same breath IS the contradiction: a machine
/// with a live physical adapter carrying a default gateway has not lost its uplink.
///
/// This is the same defect, at a third seam, that the recovery wait already fixed when it moved
/// off `check_adapter_online()` and onto `find_physical_adapter()` for the «has the adapter come
/// back?» question (see `memory/v3/status-lifecycle.md`), and the same signal the fast
/// uplink-loss short-circuit has always used. All three seams now agree on one no-I/O fact,
/// which is what stops them drifting apart again.
///
/// **What this trades.** A live adapter whose ROUTER is dead now reads as `tunnel-lost`, so the
/// walk tries the other servers and fails them all before reporting `failover-exhausted`. That
/// costs time on a fault no server could have fixed. It is the right side to err on: the opposite
/// error — the one shipping today — makes «Авто-режим» do nothing at all on the single drop it
/// exists for, which is a feature that silently does not work.
///
/// Pure, so the truth table is a unit test rather than a four-minute UAT.
pub fn drop_is_tunnel_lost(physical_adapter_present: bool) -> bool {
    physical_adapter_present
}

/// Is this drop a failover, or a plain reconnect? (28 D-01)
///
/// True on exactly one row: the tunnel went silent (`TUNNEL_LOST_REASON`) while the user's own
/// uplink is still alive, the master switch is on, and at least one candidate remains BEYOND the
/// origin. Everything else is false, by construction:
///
/// - `INTERNET_LOST_REASON` — the local uplink is gone, so NO server can help. Walking the queue
///   would burn the whole list against a fault that is not the servers'; that drop keeps the
///   wait-for-the-uplink recovery it ships with today, at the full `RECONNECT_MAX_ATTEMPTS`.
/// - master off — the user turned «Авто-режим» off; nothing may move them.
/// - `candidates_remaining == 0` — there is nowhere to fail over TO. An empty list must never be
///   a failover: it is a plain reconnect of the one server the user is on, and it keeps the full
///   budget. This is also what makes the failover-disabled path byte-for-byte today's behaviour.
/// - anything unrecognised — default-deny, mirroring `is_terminal_reason`. A reason this
///   predicate has never heard of must not silently move a user to another exit country.
///
/// `candidates_remaining` counts the servers AFTER the origin — i.e. `queue.len() - 1` for the
/// list `failover_queue` built — because the origin's own retry happens either way.
///
/// Pure (no clock, no IO) so the truth table is unit-tested exhaustively; the real drop is UAT.
pub fn should_failover(reason: &str, failover_enabled: bool, candidates_remaining: usize) -> bool {
    failover_enabled
        && candidates_remaining > 0
        && reason == crate::connectivity::TUNNEL_LOST_REASON
}

/// Build the ordered failover queue: the origin first, then the remaining participating servers
/// in ascending manifest order (28 D-02 + 27 D-08).
///
/// - **The origin leads, always, exactly once.** The server the user is ON gets its one attempt
///   before the walk begins — even when its own id is in `excluded_ids`, because an opt-out means
///   «do not fail over TO me», not «do not try to keep me connected». It is then filtered out of
///   the tail so the walk can never spend two of its attempts on the same dead server.
/// - **An excluded id contributes nothing** to the tail (27 D-08, the per-row switch).
/// - **An excluded id matching no entry is inert** (T-28-10): ids are matched AGAINST the
///   manifest, never used as a lookup key, so a hand-edited exclusion set naming a deleted config
///   cannot steer the walk anywhere or raise an error.
/// - **An unknown origin is still retried first.** A config removed from the list while it was
///   connected must not be silently abandoned.
/// - **An empty origin contributes no head** — an empty string is not a config path and must
///   never reach `respawn_sidecar`.
/// - **Ties keep manifest order** (the sort is stable), and a duplicated path yields once.
/// - **Identity is `canonical_path_key`, never `==`** (CR-02). Both de-duplication steps compare
///   normalized keys while the queue still carries the ORIGINAL strings, because `respawn_sidecar`
///   must be handed a real path and the manifest form is the one the rest of Rust reads back. See
///   `canonical_path_key` for the defect a byte comparison caused.
///
/// Takes plain slices and returns owned paths, so it needs no `AppHandle` and no manifest module.
pub fn failover_queue(
    entries: &[FailoverCandidate],
    excluded_ids: &[String],
    origin_path: &str,
) -> Vec<String> {
    let origin_key = canonical_path_key(origin_path);
    let mut tail: Vec<&FailoverCandidate> = entries
        .iter()
        .filter(|entry| canonical_path_key(&entry.path) != origin_key)
        .filter(|entry| !excluded_ids.iter().any(|excluded| excluded == &entry.id))
        .collect();
    // Stable so two rows the user dragged to the same rank stay in the order the list shows them.
    tail.sort_by_key(|entry| entry.order);

    let mut queue: Vec<String> = Vec::with_capacity(tail.len() + 1);
    // Identity keys of what is already queued, parallel to `queue` — so the queue keeps the
    // caller's original spellings while the «have I already got this server?» question is asked
    // on the normalized form.
    let mut seen: Vec<String> = Vec::with_capacity(tail.len() + 1);
    if !origin_path.is_empty() {
        queue.push(origin_path.to_string());
        seen.push(origin_key);
    }
    for entry in tail {
        // One attempt per SERVER, not per manifest row: a manifest carrying the same path twice
        // (a legacy duplicate, or the same file spelled two ways) must not consume two candidates.
        let key = canonical_path_key(&entry.path);
        if !seen.iter().any(|existing| existing == &key) {
            queue.push(entry.path.clone());
            seen.push(key);
        }
    }
    queue
}

/// May the walk advance to the NEXT candidate? (T-28-07 + FB-03)
///
/// Three facts, all re-proved per advance, because an advance connects to a DIFFERENT server —
/// closer to a `vpn_connect` than to a retry:
///
/// - **`user_intent`** — the user asked to be disconnected (transient OR durable flag). Nothing may
///   raise a tunnel behind their back.
/// - **`still_ours`** — the live generation still equals the one captured AT THE DROP. Someone
///   else's connect owns the session now. Note this compares against the FROZEN captured value on
///   purpose; see `run_failover_walk` for why re-capturing would neuter `respawn_may_store`.
/// - **`failover_enabled`** — FB-03 (Fable-5 Phase-28 review). `get_failover_settings()` was read
///   ONCE, when the queue was built, and never again. So a user alarmed at the app hopping servers
///   who opened «Настройки» and switched «Авто-режим» OFF mid-walk was ignored: the walk kept going
///   for up to N × 55 s and could still move them to another exit country, immediately after they
///   revoked consent for exactly that. (The frontend `locked` prop guards frontend switches only —
///   a Rust walk never sets `isSwitching`, so the toggle was live and apparently disregarded.) The
///   only escape was «Отключить», which is not an obvious answer to «stop moving me».
///
/// Pure, so the truth table is exhaustive here rather than in a four-minute UAT. Only ever consulted
/// for `index > 0`, i.e. on a real multi-candidate walk — a one-entry recovery queue never advances,
/// so re-reading the master switch cannot affect the internet-lost or sidecar-exit paths.
pub fn failover_advance_allowed(
    user_intent: bool,
    still_ours: bool,
    failover_enabled: bool,
) -> bool {
    !user_intent && still_ours && failover_enabled
}

/// Reconnect attempts the ORIGIN server gets once a real failover walk is under way.
///
/// Zero — owner ruling 2026-08-26 (UAT test 1), which REVERSES the 2026-08-22 D-02 ruling that
/// gave the origin one attempt like every other candidate.
///
/// What the owner saw and why he changed his mind: a single attempt is not a moment. A dead
/// server does not refuse the connection, it swallows it, so the attempt runs until the
/// per-attempt ceiling expires — ~53 s in his log, three times over. His words: «проще было бы
/// уже переключиться» — and a failover that is slower than doing it by hand is a failover
/// nobody will leave switched on. With zero, the walk reaches the SECOND server immediately, and
/// a healthy second server greens in seconds.
///
/// What this gives up, stated plainly: a server that merely rebooted is no longer waited for. The
/// user is moved off it and (by the shipped rule the settings screen states) not moved back. The
/// owner was told this is the cost and chose it: «лучше трогать».
///
/// This applies ONLY on a real walk. A one-entry queue — auto-mode off, one server, the
/// internet-lost recovery, the sidecar-exit path — is not a failover and keeps the full
/// `RECONNECT_MAX_ATTEMPTS`, so the reboot-survival guarantee is untouched everywhere it is the
/// only thing that can help.
pub const FAILOVER_ORIGIN_ATTEMPTS: u32 = 0;

/// WHY a walk was started, which is the only thing that decides what the ORIGIN is worth trying.
///
/// The two causes look identical once the tunnel is down and are opposite in what they imply about
/// the server. Collapsing them is how the origin ends up either uselessly retried or wrongly
/// abandoned, so the cause travels with the walk rather than being re-guessed at the budget call.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WalkKind {
    /// The tunnel died while the core process stayed alive — the server went silent. The origin is
    /// known bad: it just failed, and nothing local changed that could make an immediate retry
    /// behave differently.
    ServerDrop,
    /// The core PROCESS exited on this machine while the session was up. This says nothing about
    /// the server: the tunnel died because the thing holding it died, and the far end is probably
    /// still healthy. Owner ruling (28-UAT test 9): retry the origin fully FIRST, and only walk if
    /// it truly will not come back.
    LocalProcessDeath,
}

/// How many reconnect attempts the candidate at `index` of this queue gets.
///
/// A queue of ONE is not a failover at all — `should_failover` already refused it — so it keeps
/// the full `RECONNECT_MAX_ATTEMPTS`: the internet-lost recovery path and the failover-disabled
/// path both walk a one-entry queue and must behave byte-for-byte as they ship today,
/// reboot-recovery guarantee intact (D-01). `index` and `kind` are ignored there — the only index
/// such a queue has IS the origin, and it is not a walk.
///
/// On a real walk, every candidate PAST the origin gets `FAILOVER_ATTEMPTS_PER_CANDIDATE`
/// regardless of cause. The origin is where the two causes diverge:
///
/// - `ServerDrop` — `FAILOVER_ORIGIN_ATTEMPTS` (zero). The server just went silent; spending a
///   per-attempt ceiling on the corpse is the delay the owner rejected outright.
/// - `LocalProcessDeath` — the FULL `RECONNECT_MAX_ATTEMPTS`. The process died locally, so the
///   origin is the most likely server to work, and it is also the one the user chose. Only after
///   it has genuinely refused to come back does the walk move on.
///
/// That second arm is the 28-UAT test 9 ruling, and it replaces a strictly worse pair of
/// alternatives. Retrying the origin forever (what shipped) meant a crash that the origin could
/// not recover from ended in a dead session with failover ON and other servers untried. Walking
/// immediately would have thrown away the reboot-recovery guarantee and moved the user to another
/// exit country over a local process crash. The hybrid keeps the guarantee and still has somewhere
/// to go when it does not hold.
///
/// The origin deliberately KEEPS its slot in the queue rather than being filtered out of it. Index
/// 0 means «the origin» to `notify::failover_connect_origin` (which returns `None` there, so a
/// same-server landing is never announced as an automatic switch), to the stamp/release pair, and
/// to `build_failover_queue`'s `queue.len() - 1` count of real candidates. Dropping the entry
/// would have moved every one of those meanings by one and turned a budget change into a
/// notification bug.
///
/// Expressed as a function rather than inline so «the recovery path still receives the full
/// budget» is an assertion rather than a claim.
pub fn per_candidate_attempt_budget(kind: WalkKind, queue_len: usize, index: usize) -> u32 {
    if queue_len <= 1 {
        return RECONNECT_MAX_ATTEMPTS;
    }
    if index > 0 {
        return FAILOVER_ATTEMPTS_PER_CANDIDATE;
    }
    match kind {
        WalkKind::ServerDrop => FAILOVER_ORIGIN_ATTEMPTS,
        WalkKind::LocalProcessDeath => RECONNECT_MAX_ATTEMPTS,
    }
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
        // D-02: gave_up(attempt, budget) is the give-up boundary (used to skip the sleep after
        // the last attempt) — true AT and beyond the budget, false before it. The real loop runs
        // `for attempt in 1..=budget`. Asserted against the const (not a hard-coded number) so a
        // future retune can't silently drift the test.
        //
        // 28-02: the budget is now a PARAMETER rather than the bare const, because the failover
        // walk gives each candidate its own (much smaller) budget while the internet-lost
        // recovery path keeps RECONNECT_MAX_ATTEMPTS. Driving the loop off the parameter keeps
        // this test honest for BOTH callers.
        let budget = RECONNECT_MAX_ATTEMPTS;
        let mut yielded = Vec::new();
        let mut attempt: u32 = 1;
        while !gave_up(attempt, budget) {
            yielded.push(attempt);
            attempt += 1;
        }
        let expected: Vec<u32> = (1..RECONNECT_MAX_ATTEMPTS).collect();
        assert_eq!(yielded, expected);
        assert!(!gave_up(RECONNECT_MAX_ATTEMPTS - 1, budget));
        assert!(gave_up(RECONNECT_MAX_ATTEMPTS, budget)); // give up AT the cap
        assert!(gave_up(RECONNECT_MAX_ATTEMPTS + 1, budget)); // and anything beyond
        assert_eq!(RECONNECT_MAX_ATTEMPTS, 10);

        // The failover candidate's budget: attempt 1 IS the last attempt, so it never sleeps
        // before moving on to the next server (D-02, owner ruling 2026-08-22).
        assert!(gave_up(1, FAILOVER_ATTEMPTS_PER_CANDIDATE));
    }

    #[test]
    fn reconnect_budget_is_bounded_and_per_attempt_snappy() {
        // The user chose up to 10 reconnect attempts (UAT fd63ec): a rebooting server needs
        // more than 3 tries, and «Отмена» lets the user bail. So the TOTAL is allowed to be
        // a few minutes — but each SINGLE attempt must stay sub-minute so one hung try can't
        // stall the whole sequence, and the total stays hard-BOUNDED (never infinite).
        assert_eq!(RECONNECT_MAX_ATTEMPTS, 10);
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(60));
        // 3.8 F-2: the per-attempt ceiling grew from 15s to 55s so a traffic-readiness-gated
        // (http3, ~45s warmup) respawn is not killed before it can green — but it stays sub-minute.
        assert!(RECONNECT_ATTEMPT_WINDOW < Duration::from_secs(60));
        assert!(
            RECONNECT_ATTEMPT_WINDOW >= Duration::from_secs(50),
            "must exceed the ~45s http3 traffic-readiness warmup (3.8 F-2)"
        );
        assert!(RECONNECT_INTERVAL < Duration::from_secs(60));
        // Worst case = every attempt burns the FULL ceiling + interval (a wedged-but-alive child
        // every time). respawn_and_wait's early-exit on connect / child-death / terminal status
        // makes the REAL common case far shorter; this only bounds the pathological ceiling. Still
        // finite and user-cancellable (D-02/D-05 «Отмена»).
        let worst_case = (RECONNECT_ATTEMPT_WINDOW + RECONNECT_INTERVAL) * RECONNECT_MAX_ATTEMPTS;
        assert!(worst_case <= Duration::from_secs(600));
    }

    #[test]
    fn attempt_window_must_stay_above_the_traffic_readiness_cap() {
        // D-03 TRIPWIRE (28-02). The relationship `RECONNECT_ATTEMPT_WINDOW` describes in prose
        // is now asserted against the real constant instead of a comment that cannot be checked.
        //
        // A per-attempt ceiling AT or BELOW the traffic-readiness cap counts a still-warming
        // respawn as a FAILURE, and the next attempt kills the warming child — which made
        // auto-reconnect STRUCTURALLY unable to succeed on a slow-warmup protocol (http3 takes up
        // to `sidecar::TRAFFIC_READINESS_CAP` = 45s to green). That is `3.8 F-2`, found by Fable.
        //
        // The failure mode is SILENT — it looks like «it just does not reconnect» — which is
        // exactly how it survived the first time. A const-sanity test is how this codebase makes
        // such a regression loud: lower the window to 40s and this goes red before any user sees
        // a tunnel that will not come back.
        assert!(
            RECONNECT_ATTEMPT_WINDOW > crate::sidecar::TRAFFIC_READINESS_CAP,
            "RECONNECT_ATTEMPT_WINDOW ({:?}) must EXCEED sidecar::TRAFFIC_READINESS_CAP ({:?}): a \
             ceiling at or below the readiness cap counts a still-warming respawn as a failure and \
             the next attempt kills it, so auto-reconnect becomes structurally unable to succeed \
             on a slow-warmup protocol (3.8 F-2). Raise the window, do not lower it.",
            RECONNECT_ATTEMPT_WINDOW,
            crate::sidecar::TRAFFIC_READINESS_CAP,
        );
        // …and it still stays sub-minute, so one wedged-but-alive child cannot stall the bounded
        // sequence. Both halves must hold at once; this is the narrow band the value lives in.
        assert!(
            RECONNECT_ATTEMPT_WINDOW < Duration::from_secs(60),
            "the ceiling must stay sub-minute so a single hung try cannot stall the sequence",
        );
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

    // ── FAB-R1 (Fable-5 review of Phase 14): respawn store guard ────────────

    #[test]
    fn respawn_may_store_only_when_generation_current_and_no_disconnect() {
        // The supervisor captured generation 5 at the drop. Its respawn may STORE its
        // fresh child ONLY while it still owns the session: generation unchanged AND no
        // durable user-disconnect.
        assert!(respawn_may_store(5, 5, false)); // still ours → store

        // A config switch's vpn_connect(B) bumped the live generation past the captured
        // one during the respawn's spawn await → this A-retry is STALE, must NOT store
        // (else two live sidecars / orphaned killswitch-owning core — FAB-R1).
        assert!(!respawn_may_store(5, 6, false)); // gen bumped by a switch → stale
        assert!(!respawn_may_store(5, 99, false)); // any advance → stale

        // A durable user-disconnect landed during the respawn → the user wins; do NOT
        // store a sidecar they no longer want, even if the generation still matches.
        assert!(!respawn_may_store(5, 5, true)); // user disconnect set → do not store

        // Both a bump AND a disconnect → still must not store.
        assert!(!respawn_may_store(5, 6, true));
    }

    #[test]
    fn respawn_may_store_matches_generation_guard_semantics() {
        // The store guard's generation dimension is exactly `is_current_generation`,
        // so the two can never drift: current gen ⇒ may store (no disconnect); any
        // mismatch ⇒ must not store, regardless of direction.
        for (captured, live) in [(0u64, 0u64), (7, 7), (3, 4), (10, 2)] {
            assert_eq!(
                respawn_may_store(captured, live, false),
                is_current_generation(captured, live),
                "respawn store guard must track is_current_generation for captured={captured} live={live}",
            );
        }
    }

    // ── 3.1 R-GEN (Fable-5 Phase-14 investigation, F12): superseded-exit status gate ──

    #[test]
    fn terminated_arm_may_write_status_requires_owns_and_current_generation() {
        // The reader task's Terminated arm may write session status / hand off to the supervisor
        // ONLY when it still owns the slot AND its captured generation is live.
        assert!(terminated_arm_may_write_status(true, 7, 7)); // owns + current → may write

        // F12: this child owns the (transiently empty) slot, but a disconnect+connect churn bumped
        // the generation past its captured one → its late non-zero exit must NOT write
        // Error("sidecar-exit") onto the fresh Connecting.
        assert!(!terminated_arm_may_write_status(true, 7, 8)); // owns but superseded → drop
        assert!(!terminated_arm_may_write_status(true, 7, 99)); // any advance → drop

        // A newer child is stored (does not own the slot) → already dropped by the identity gate;
        // the combined predicate agrees regardless of generation.
        assert!(!terminated_arm_may_write_status(false, 7, 7));
        assert!(!terminated_arm_may_write_status(false, 7, 8));
    }

    #[test]
    fn terminated_arm_status_gate_tracks_generation_guard() {
        // When it owns the slot, the status gate's generation dimension is exactly
        // is_current_generation — the two can never drift.
        for (captured, live) in [(0u64, 0u64), (7, 7), (3, 4), (10, 2)] {
            assert_eq!(
                terminated_arm_may_write_status(true, captured, live),
                is_current_generation(captured, live),
                "status gate must track is_current_generation when owns for captured={captured} live={live}",
            );
        }
    }

    // ── FAB-R4 (Fable-5 review of Phase 14): switch-vs-tray-disconnect ──────

    #[test]
    fn switch_disconnect_wins_lets_a_normal_switch_complete() {
        // Normal A→B switch: stamped at authorization = G (say 4). The switch's OWN
        // teardown-disconnect advances the live generation to exactly G+1 (=5) and sets
        // the durable intent — that is EXPECTED, not a genuine user disconnect. So
        // vpn_connect must NOT bail: the switch completes and B connects.
        //
        // DECOUPLE-STAMP-FROM-BOOL (FAB-R4 re-fix): the decision is keyed on the STAMP
        // presence, NOT on the transient switch_pending bool — the FE clears that bool
        // (BL-01) BEFORE vpn_connect(B) runs, so a bool-keyed guard was DEAD. Here the
        // stamp is alive at connect time; live == stamped + 1 → complete.
        assert!(!switch_disconnect_wins(true, Some(4), 5)); // live == stamped + 1 → complete
        // Even with intent set but the live gen exactly at the switch's own single
        // teardown advance, we complete.
        assert!(!switch_disconnect_wins(true, Some(0), 1));
    }

    #[test]
    fn switch_disconnect_wins_lets_a_save_and_reconnect_complete() {
        // Save-and-reconnect (handleReconnect, isSwitch:false) has the SAME teardown
        // arithmetic as a switch: stamp = G at authorization, its own teardown bumps to
        // G+1, then vpn_connect reads live = G+1 → complete. It ALSO stamps now (Fable
        // Defect 2 — the same intent-inversion class), so this path must complete on the
        // own-teardown delta exactly like a switch.
        assert!(!switch_disconnect_wins(true, Some(7), 8)); // own teardown = +1 → complete
    }

    #[test]
    fn switch_disconnect_wins_when_a_genuine_disconnect_lands_after_authorization() {
        // A genuine tray/manual «Отключить» in the teardown→connect gap adds an EXTRA
        // generation bump: stamped = 4, switch teardown → 5, tray disconnect → 6. The
        // live generation (6) is now PAST stamped+1 (5) with the durable intent still
        // set → the user's Disconnect must WIN: bail to a clean Disconnected, no B.
        assert!(switch_disconnect_wins(true, Some(4), 6)); // live > stamped + 1 → bail
        assert!(switch_disconnect_wins(true, Some(4), 9)); // further advance → still bail

        // If the durable intent is somehow NOT set (e.g. the extra disconnect's intent
        // was already consumed), there is no user disconnect to honor → do not bail.
        assert!(!switch_disconnect_wins(false, Some(4), 6));
    }

    #[test]
    fn switch_disconnect_wins_never_bails_a_plain_manual_connect() {
        // No switch authorized (sentinel → None): a plain manual connect after a manual
        // disconnect is the user RE-connecting on purpose. The connect_cancelled /
        // generation guards own those paths — this predicate must never bail here, even
        // with the durable intent still set and the generation advanced.
        assert!(!switch_disconnect_wins(true, None, 100));
        assert!(!switch_disconnect_wins(false, None, 0));
    }

    #[test]
    fn switch_disconnect_wins_stale_stamp_after_aborted_switch_is_harmless() {
        // Stale-stamp harmlessness (FAB-R4 re-fix point 3): an ABORTED switch (teardown
        // vpn_disconnect REJECTED) leaves the stamp alive (the FE abort sends only
        // pending:false, which no longer resets the stamp) but never runs vpn_connect(B),
        // so the stamp survives to the NEXT connect. The realistic follow-up — a plain
        // manual connect right after the aborted switch — must NOT be falsely bailed:
        //   stamp = G (say 3), the aborted teardown's own bump → live = G+1 (=4).
        // A connect reading (durable set by that teardown, stamp 3, live 4) sees
        // live == stamped + 1 → COMPLETE, not bail. The stamp is then consumed by that
        // connect (reset to sentinel) so it can never leak further.
        assert!(!switch_disconnect_wins(true, Some(3), 4)); // own teardown only → complete
        // With NO durable intent (the abort's intent was already consumed elsewhere),
        // there is nothing to honor regardless of the delta → do not bail.
        assert!(!switch_disconnect_wins(false, Some(3), 9));
    }

    #[test]
    fn switch_disconnect_wins_leaves_the_supervisor_reconnect_path_untouched() {
        // The reconnect supervisor's respawn NEVER calls set_switch_or_reconnect_pending,
        // so no stamp exists → this predicate is a no-op for the auto-reconnect path (its
        // ownership is the generation guard in the loop), regardless of the durable intent
        // / live generation.
        assert!(!switch_disconnect_wins(true, None, 42));
        assert!(!switch_disconnect_wins(false, None, 42));
    }

    #[test]
    fn pid_basename_is_per_edition() {
        // Gemini HIGH isolation: Pro must use its OWN PID basename so it can never
        // read or stale-kill Light's sidecar (and vice-versa) when co-installed.
        assert_eq!(SIDECAR_PID_BASENAME, ".sidecar-pro.pid");
        assert_ne!(SIDECAR_PID_BASENAME, ".sidecar.pid"); // NOT the shared basename
        assert_ne!(SIDECAR_PID_BASENAME, ".sidecar-light.pid"); // distinct from Light
    }

    /// **The uninstaller reads the pid file the app writes.**
    ///
    /// The uninstall hook reads that file BY PATH in order to kill only this edition's VPN core.
    /// If the two ends drift, uninstalling and updating stop killing the core and the tunnel
    /// outlives the app — no error, no dialog, on a security product. It was ALREADY broken once:
    /// the hook read `.sidecar.pid` while Rust had moved to the per-edition `.sidecar-pro.pid`
    /// (D-07), so the kill had been a silent no-op and nothing was watching.
    ///
    /// `include_str!` binds the assertion to the real file at COMPILE time, so editing either end
    /// alone cannot leave this green — the test binary is rebuilt when the `.nsh` changes.
    ///
    /// **Why this asserts on a prefix and a basename rather than on a resolved absolute path.**
    /// The data root is the executable's own directory, which the installer spells `$INSTDIR` —
    /// an NSIS variable that has no value until the uninstaller runs, so Rust cannot resolve it.
    /// The agreement is therefore pinned in three parts, each of which alone would be too weak:
    /// the hook's root is the install directory (not some other folder), the pid path is COMPOSED
    /// from that root plus the constant production code uses, and Rust's own root really is the
    /// executable's directory — which is what makes `$INSTDIR` the correct spelling of it.
    #[test]
    fn the_uninstall_hook_reads_the_pid_file_the_app_writes() {
        let hook = include_str!("../nsis/installer-hooks.nsh");

        // (1) The hook's root is the install directory. Pinning the literal is the point: any
        //     other value — a $LOCALAPPDATA subfolder, a vendor\edition pair — means the hook is
        //     looking somewhere the app does not write.
        assert!(
            hook.contains("!define TT_DATA_ROOT \"$INSTDIR\""),
            "the uninstall hook must define the data root as the install directory — that is \
             where the app writes"
        );

        // (2) The pid path is composed from THAT root plus the SAME constant production code
        //     uses (`commands/vpn.rs::sidecar_pid_path` joins it onto `ssh::user_data_dir()`).
        //     Hard-coding the basename here would make this test agree with itself rather than
        //     with the application.
        let want_pid =
            format!("!define TT_SIDECAR_PID_FILE \"${{TT_DATA_ROOT}}\\{SIDECAR_PID_BASENAME}\"");
        assert!(
            hook.contains(&want_pid),
            "the uninstall hook's pid path must be built from the data root plus \
             {SIDECAR_PID_BASENAME}; expected the line: {want_pid}"
        );

        // (3) Rust's end of the agreement: the data root really is the executable's directory,
        //     so `$INSTDIR` is the right NSIS spelling of it. Without this the first two
        //     assertions would keep passing if the Rust helper moved the data elsewhere.
        let install = std::path::Path::new("C:\\Users\\u\\AppData\\Local\\TrustTunnel Client Pro");
        assert_eq!(
            crate::ssh::resolve_data_root(Some(install.join("trusttunnel.exe"))).0,
            install,
            "the app's data root must be the executable's own directory, else $INSTDIR is the \
             wrong spelling of it and the hook is reading the wrong folder"
        );

        // (4) The hook must READ the pid file through the composed define, never through a
        //     hand-written path. A second, literal path is how the two ends drift back apart.
        for line in hook.lines() {
            let l = line.trim();
            if (l.starts_with("IfFileExists") || l.starts_with("FileOpen")) && l.contains(".pid") {
                assert!(
                    l.contains("${TT_SIDECAR_PID_FILE}"),
                    "the hook must read the pid file through TT_SIDECAR_PID_FILE, not a literal \
                     path: {l}"
                );
            }
        }
    }

    /// **The uninstaller must not delete the user's data.** An UPDATE runs the uninstaller.
    ///
    /// This is not hypothetical and it is not new: until phase 30.1 this hook unconditionally
    /// deleted `ssh_credentials.json`, `known_hosts.json`, `routing_rules.json` and the rest on
    /// every uninstall, so every routine update silently wiped the user's saved SSH passwords and
    /// routing rules. The server list survived only by accident — `configs.json` and the
    /// per-server `.toml` files were never in that list.
    ///
    /// The subjects are ALL of it: the data root is the install directory, so a `Delete` or
    /// `RMDir` naming any user artifact under `$INSTDIR` — or under `${TT_DATA_ROOT}`, which is
    /// the same folder — destroys live data. Comment lines are excluded, because the hook
    /// documents by name exactly what it no longer deletes and a raw scan would flag its own
    /// explanation.
    #[test]
    fn the_uninstaller_never_deletes_user_data() {
        let hook = include_str!("../nsis/installer-hooks.nsh");

        // Every artifact the app persists into its data root. Anything the uninstaller removes
        // from this list is data the user loses on a routine update.
        const USER_DATA: &[&str] = &[
            "configs.json",
            "ssh_credentials.json",
            "known_hosts.json",
            "routing_rules.json",
            "exclusions.json",
            "active_groups.json",
            "connection_history.json",
            "app_settings.json",
            "dns_snapshot.json",
            "trusttunnel_client.toml",
            "webview_data",
            "geodata",
            "resolved",
            "group_cache",
            "runtime",
            "logs",
        ];

        let mut offenders: Vec<String> = Vec::new();
        for line in hook.lines() {
            let l = line.trim();
            if l.starts_with(';') {
                continue; // prose, including the record of what used to be deleted here
            }
            let is_removal = l.starts_with("Delete ") || l.starts_with("RMDir");
            if !is_removal {
                continue;
            }
            // Only removals aimed at the data root can destroy user data. $TEMP leftovers and
            // the icon caches under $LOCALAPPDATA are install-scoped and stay.
            if !(l.contains("$INSTDIR") || l.contains("${TT_DATA_ROOT}")) {
                continue;
            }
            if USER_DATA.iter().any(|name| l.contains(name)) {
                offenders.push(l.to_string());
            }
        }

        assert!(
            offenders.is_empty(),
            "the uninstaller deletes user data from the data root — an UPDATE runs the \
             uninstaller, so these lines wipe the user's servers, passwords and routing rules \
             during what they experience as an update:\n  {}",
            offenders.join("\n  ")
        );

        // The stance must be stated, not merely true by accident: an undocumented absence is what
        // the next reader "fixes" by adding a tidy-up list back.
        assert!(
            hook.contains("DetailPrint \"Keeping user data in ${TT_DATA_ROOT}\""),
            "the hook must say out loud that the user's data is kept, so the omission reads as a \
             decision rather than as something forgotten"
        );

        // And the recursive form must never be aimed at the data root at all. `RMDir /r
        // \"$INSTDIR\"` takes everything in one line and would not be caught by the name list.
        for line in hook.lines() {
            let l = line.trim();
            if l.starts_with(';') {
                continue;
            }
            assert!(
                !(l.starts_with("RMDir /r")
                    && (l.contains("\"$INSTDIR\"") || l.contains("\"${TT_DATA_ROOT}\""))),
                "a recursive removal of the data root deletes everything the user has: {l}"
            );
        }
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

    /// 30.1 regression defect 1 — the refused connect's reason code.
    ///
    /// Same three facts as its D-02 neighbour below, with the third INVERTED and that inversion
    /// is the point of writing the test at all: this code is deliberately NOT terminal, because
    /// nothing records it as a failure cause for the reconnect supervisor to read. Registering
    /// it would be a guard over an empty set — and an empty-set guard reads as coverage while
    /// measuring nothing, which is the exact shape this phase has now caught six times.
    #[test]
    fn config_outside_data_dir_reason_is_a_distinct_ascii_token_and_is_not_registered_terminal() {
        assert_eq!(CONFIG_OUTSIDE_DATA_DIR_REASON, "config-outside-data-dir");
        assert!(CONFIG_OUTSIDE_DATA_DIR_REASON.is_ascii());
        assert!(
            !CONFIG_OUTSIDE_DATA_DIR_REASON
                .chars()
                .any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic — the Russian wording is an i18n key, not this",
        );
        // Distinct from every sibling: each sends the user to a different action, and this one's
        // action («add the server again») is nothing like «check your internet» or «retry».
        for sibling in [
            NO_INTERNET_REASON,
            SIDECAR_EXIT_REASON,
            RECOVERY_TIMEOUT_REASON,
            ROUTING_RULES_UNREADABLE_REASON,
            crate::connectivity::RECONNECT_GAVE_UP_REASON,
            crate::connectivity::FAILOVER_EXHAUSTED_REASON,
        ] {
            assert_ne!(CONFIG_OUTSIDE_DATA_DIR_REASON, sibling);
        }
        assert!(
            !is_terminal_reason(CONFIG_OUTSIDE_DATA_DIR_REASON),
            "no path records this code as a failure cause, so registering it terminal would add \
             a branch nothing can reach — if a future change DOES record it, register it then \
             and delete this assertion with the reason written down"
        );
    }

    #[test]
    fn routing_rules_unreadable_reason_is_ascii_cyrillic_free_distinct_and_terminal() {
        // D-02 (30.1 blocker 2). Three separate facts, and the third is the one with teeth.
        //
        // (a) It is a token, not a sentence — the serde parse error is English and unbounded, so
        //     nothing derived from it may ever be what crosses IPC (D-09/D-29).
        assert_eq!(ROUTING_RULES_UNREADABLE_REASON, "routing-rules-unreadable");
        assert!(ROUTING_RULES_UNREADABLE_REASON.is_ascii());
        assert!(
            !ROUTING_RULES_UNREADABLE_REASON
                .chars()
                .any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic — the Russian wording is an i18n key, not this",
        );
        // (b) Distinct from every sibling. Each of these sends the user somewhere different, and a
        //     collision would send them to the wrong screen with a confident message.
        for sibling in [
            NO_INTERNET_REASON,
            SIDECAR_EXIT_REASON,
            RECOVERY_TIMEOUT_REASON,
            crate::connectivity::RECONNECT_GAVE_UP_REASON,
            crate::connectivity::FAILOVER_EXHAUSTED_REASON,
        ] {
            assert_ne!(ROUTING_RULES_UNREADABLE_REASON, sibling);
        }
        // (c) TERMINAL. A corrupt file is byte-identical on the second read and the third, so the
        //     bounded reconnect loop must stop after ONE attempt rather than spend its budget —
        //     roughly a minute per attempt of «Переподключение…» that cannot possibly succeed.
        assert!(
            is_terminal_reason(ROUTING_RULES_UNREADABLE_REASON),
            "an unreadable rules file cannot heal between two respawns — retrying it is pure delay",
        );
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

    // ── Phase 28 (D-01 / D-02 / 27 D-08): the failover decision pair ─────────

    /// Terse builder so a truth-table row stays one readable line.
    fn candidate(id: &str, path: &str, order: u32) -> FailoverCandidate {
        FailoverCandidate { id: id.to_string(), path: path.to_string(), order }
    }

    /// Three servers whose manifest order (0, 1, 2) is deliberately NOT their declaration
    /// order — a queue builder that merely preserved input order would pass by accident.
    fn three_servers() -> Vec<FailoverCandidate> {
        vec![
            candidate("c", "C.toml", 2),
            candidate("a", "A.toml", 0),
            candidate("b", "B.toml", 1),
        ]
    }

    #[test]
    fn should_failover_only_on_a_tunnel_lost_drop_with_the_master_on_and_a_candidate_left() {
        use crate::connectivity::{INTERNET_LOST_REASON, TUNNEL_LOST_REASON};

        // The ONE true row: the server went silent while the user's own uplink is alive, the
        // master switch is on, and there is somewhere to go.
        assert!(should_failover(TUNNEL_LOST_REASON, true, 1));
        assert!(should_failover(TUNNEL_LOST_REASON, true, 7)); // more candidates → still true

        // D-01: on an internet-lost drop the LOCAL uplink is gone, so NO server can help.
        // Walking the queue would burn the whole list against a fault that is not the servers';
        // that case keeps the wait-for-the-uplink recovery it ships with today.
        assert!(!should_failover(INTERNET_LOST_REASON, true, 1));

        // Master switch off → never a failover, whatever the drop was.
        assert!(!should_failover(TUNNEL_LOST_REASON, false, 1));
        assert!(!should_failover(INTERNET_LOST_REASON, false, 1));

        // An EMPTY candidate list must NEVER be a failover: there is nothing to fail over TO, so
        // this is a plain reconnect and keeps the full RECONNECT_MAX_ATTEMPTS budget. All four
        // master × reason combinations are false once the list is empty.
        assert!(!should_failover(TUNNEL_LOST_REASON, true, 0));
        assert!(!should_failover(INTERNET_LOST_REASON, true, 0));
        assert!(!should_failover(TUNNEL_LOST_REASON, false, 0));
        assert!(!should_failover(INTERNET_LOST_REASON, false, 0));

        // Default-deny on anything we do not recognise (mirrors `is_terminal_reason`): a reason
        // this predicate has never heard of must not silently move the user to another country.
        assert!(!should_failover(SIDECAR_EXIT_REASON, true, 3));
        assert!(!should_failover(NO_INTERNET_REASON, true, 3));
        assert!(!should_failover(RECOVERY_TIMEOUT_REASON, true, 3));
        assert!(!should_failover("", true, 3));
    }

    #[test]
    fn failover_queue_puts_the_origin_first_then_the_manifest_order() {
        // D-02: the server the user is ON is retried FIRST (its one attempt), and only then does
        // the walk begin — in ascending manifest order, which is the priority list the user sees
        // in «Авто-режим», not the order the manifest happens to store rows in.
        let queue = failover_queue(&three_servers(), &[], "B.toml");
        assert_eq!(queue, ["B.toml", "A.toml", "C.toml"]);
    }

    #[test]
    fn failover_queue_drops_excluded_ids_and_treats_an_unknown_id_as_inert() {
        // 27 D-08: a per-row opt-out contributes NOTHING to the queue.
        // T-28-10: an id matching no entry is INERT — never an error, never used as a lookup key,
        // so a hand-edited exclusion set naming a deleted config cannot steer the walk anywhere.
        let queue = failover_queue(
            &three_servers(),
            &["a".to_string(), "ghost-config-id".to_string()],
            "B.toml",
        );
        assert_eq!(queue, ["B.toml", "C.toml"]);
    }

    #[test]
    fn failover_queue_always_retries_the_origin_once_even_when_it_is_excluded() {
        // An opt-out means «do not fail over TO me», not «do not try to keep me connected». The
        // server the user chose is always retried once before the walk begins.
        let queue = failover_queue(&three_servers(), &["b".to_string()], "B.toml");
        assert_eq!(queue, ["B.toml", "A.toml", "C.toml"]);

        // …and it appears EXACTLY once — never duplicated into the tail, which would silently
        // spend two of the walk's attempts on the same dead server.
        let plain = failover_queue(&three_servers(), &[], "B.toml");
        assert_eq!(plain.iter().filter(|p| p.as_str() == "B.toml").count(), 1);
    }

    #[test]
    fn failover_queue_edge_rows_never_produce_a_bogus_candidate() {
        // No manifest entries at all → just the origin: a single-candidate queue, i.e. exactly
        // today's behaviour.
        assert_eq!(failover_queue(&[], &[], "B.toml"), ["B.toml"]);

        // Every non-origin entry excluded → a single-candidate queue again, so `should_failover`
        // sees zero remaining candidates and the recovery budget is kept.
        let all_but_origin_out = failover_queue(
            &three_servers(),
            &["a".to_string(), "c".to_string()],
            "B.toml",
        );
        assert_eq!(all_but_origin_out, ["B.toml"]);

        // An origin the manifest does not know (a config removed from the list while it was
        // connected) is STILL retried first — dropping it would silently abandon the server the
        // user is actually on.
        let unknown_origin = failover_queue(&three_servers(), &[], "Z.toml");
        assert_eq!(unknown_origin, ["Z.toml", "A.toml", "B.toml", "C.toml"]);

        // An EMPTY origin contributes no head: an empty string is not a config path and must
        // never reach `respawn_sidecar`.
        assert_eq!(failover_queue(&three_servers(), &[], ""), ["A.toml", "B.toml", "C.toml"]);

        // Equal orders keep manifest order (stable sort), so two rows the user dragged to the
        // same rank stay in the order the list shows them.
        let ties = vec![candidate("x", "X.toml", 5), candidate("y", "Y.toml", 5)];
        assert_eq!(failover_queue(&ties, &[], ""), ["X.toml", "Y.toml"]);

        // A manifest carrying the same path twice yields it once — the walk spends one attempt
        // per SERVER, not per row.
        let dupes = vec![candidate("p", "P.toml", 0), candidate("p-again", "P.toml", 1)];
        assert_eq!(failover_queue(&dupes, &[], ""), ["P.toml"]);
    }

    #[test]
    fn a_queue_advance_needs_ownership_and_a_still_granted_permission() {
        // The one true row: nobody disconnected, the session is still ours, and «Авто-режим» is
        // still on.
        assert!(failover_advance_allowed(false, true, true));

        // FB-03 regression: the master switch flipped OFF mid-walk. `get_failover_settings` used
        // to be read only at queue-build time, so a user alarmed at the app hopping servers who
        // opened «Настройки» and switched auto-mode off was ignored — the walk kept going and
        // could still move them to another exit country right after they revoked consent.
        assert!(!failover_advance_allowed(false, true, false));

        // The two ownership facts, unchanged (T-28-07).
        assert!(!failover_advance_allowed(true, true, true)); // user asked to disconnect
        assert!(!failover_advance_allowed(false, false, true)); // someone else owns the session

        // Any combination of refusals still refuses — the gate is an AND, never a majority vote.
        assert!(!failover_advance_allowed(true, false, false));
        assert!(!failover_advance_allowed(true, true, false));
        assert!(!failover_advance_allowed(false, false, false));
        assert!(!failover_advance_allowed(true, false, true));
    }

    #[test]
    fn canonical_path_key_matches_the_frontends_normalize_path() {
        // CR-02. Both ends of the IPC must answer «same file?» identically, or the desync just
        // moves: this is the Rust twin of `gui-pro/src/shared/utils/samePath.ts` `normalizePath`
        // (trim, `\` → `/`, lowercase). Windows filesystems are case-insensitive, so lowercasing
        // is the correct equality here.
        assert_eq!(canonical_path_key("C:\\cfg\\A.toml"), "c:/cfg/a.toml");
        assert_eq!(canonical_path_key("  c:/CFG/a.TOML  "), "c:/cfg/a.toml");
        assert_eq!(
            canonical_path_key("C:\\cfg\\A.toml"),
            canonical_path_key("c:/cfg/a.toml"),
            "the SAME file in the two spellings the field actually produces must be one key",
        );
        // Different files stay different — normalization must not collapse anything real.
        assert_ne!(canonical_path_key("C:/cfg/a.toml"), canonical_path_key("C:/cfg/b.toml"));
    }

    #[test]
    fn failover_queue_does_not_queue_the_origin_twice_when_the_manifest_spells_it_differently() {
        // CR-02 regression — THE row the suite was missing, and the one the field hits.
        //
        // `origin_path` is `state.config_path`, the string `vpn_connect` was handed, which reaches
        // it from `tt_config_path` (tray adopt / deeplink / legacy writers). The manifest entry for
        // the SAME file is written by Rust in its own form. The frontend documented this exact
        // divergence as the Phase-17 F2 defect; the Rust queue had no equivalent, so the origin
        // entered the queue twice — spending two of the walk's one-attempt slots (D-02) on one
        // dead server, and letting `failover_switch_target` report the origin as a «switch».
        let manifest = vec![
            candidate("a", "C:/cfg/a.toml", 0),
            candidate("b", "C:/cfg/b.toml", 1),
        ];
        let queue = failover_queue(&manifest, &[], "C:\\cfg\\A.toml");
        assert_eq!(
            queue,
            ["C:\\cfg\\A.toml", "C:/cfg/b.toml"],
            "the origin must appear ONCE (in the caller's spelling) and never again from the manifest",
        );

        // The same claim stated as the invariant, so a future change that breaks it fails here
        // rather than in a UAT four minutes into a killswitched walk.
        let origin_hits = queue
            .iter()
            .filter(|p| canonical_path_key(p) == canonical_path_key("C:\\cfg\\A.toml"))
            .count();
        assert_eq!(origin_hits, 1);
    }

    #[test]
    fn failover_queue_dedupes_manifest_rows_that_spell_the_same_file_differently() {
        // The tail-side half of the same rule: two manifest rows pointing at one file (a legacy
        // duplicate that survived a path rewrite) must yield one candidate, not two.
        let dupes = vec![
            candidate("p", "C:\\cfg\\P.toml", 0),
            candidate("p-again", "c:/cfg/p.toml", 1),
        ];
        assert_eq!(failover_queue(&dupes, &[], ""), ["C:\\cfg\\P.toml"]);
    }

    #[test]
    fn per_candidate_budget_skips_the_origin_on_a_walk_and_keeps_the_full_budget_off_it() {
        // D-02 (owner ruling 2026-08-22, OQ-2 option-a): ONE attempt per candidate past the
        // origin. The owner was shown that this stops surviving a routine server reboot and chose
        // speed of restored internet over staying put; the remedy if that bites is the deferred
        // auto-return (27 D-09), NOT a quiet raise of this number.
        use WalkKind::{LocalProcessDeath, ServerDrop};

        assert_eq!(FAILOVER_ATTEMPTS_PER_CANDIDATE, 1);
        // Past the origin the cause is irrelevant — whatever killed the session, these servers are
        // untried and each gets one shot.
        for kind in [ServerDrop, LocalProcessDeath] {
            assert_eq!(
                per_candidate_attempt_budget(kind, 3, 1),
                FAILOVER_ATTEMPTS_PER_CANDIDATE
            );
            assert_eq!(
                per_candidate_attempt_budget(kind, 3, 2),
                FAILOVER_ATTEMPTS_PER_CANDIDATE
            );
            assert_eq!(
                per_candidate_attempt_budget(kind, 2, 1),
                FAILOVER_ATTEMPTS_PER_CANDIDATE
            );
        }

        // Product ruling 2026-08-26 (UAT test 1), reversing the 2026-08-22 call: on a SERVER DROP
        // the ORIGIN gets NOTHING. A dead server swallows the connection rather than refusing it,
        // so its one attempt cost the full per-attempt ceiling (~53s in his log) before the walk
        // could reach a server that was actually up.
        assert_eq!(FAILOVER_ORIGIN_ATTEMPTS, 0);
        assert_eq!(per_candidate_attempt_budget(ServerDrop, 3, 0), FAILOVER_ORIGIN_ATTEMPTS);
        assert_eq!(per_candidate_attempt_budget(ServerDrop, 2, 0), FAILOVER_ORIGIN_ATTEMPTS);
        // …and a zero budget is a give-up on the FIRST attempt number, i.e. no respawn at all,
        // which is what makes the walk reach index 1 immediately rather than after a ceiling.
        assert!(gave_up(1, per_candidate_attempt_budget(ServerDrop, 3, 0)));

        // A SINGLE-candidate queue is not a failover at all (`should_failover` says so), so it
        // keeps the full reboot-surviving budget REGARDLESS of index OR cause: the internet-lost
        // recovery path and the failover-disabled path stay byte-for-byte what ships today (D-01).
        // This is the row that proves the origin skip cannot leak onto them.
        for kind in [ServerDrop, LocalProcessDeath] {
            assert_eq!(per_candidate_attempt_budget(kind, 1, 0), RECONNECT_MAX_ATTEMPTS);
            assert_eq!(per_candidate_attempt_budget(kind, 0, 0), RECONNECT_MAX_ATTEMPTS);
        }
    }

    /// Owner ruling 28-UAT test 9 — the hybrid, and the ONE row that separates the two causes.
    ///
    /// The core process dying on this machine says nothing about the server, so the origin is the
    /// most likely thing to work AND the server the user picked. It therefore keeps the full budget
    /// — which is also what preserves reboot recovery — and the walk exists only as the exit for
    /// when that genuinely fails. Collapsing this back onto the ServerDrop rule would silently
    /// reintroduce the behaviour the owner rejected: a crash the origin could not recover from
    /// ending in a dead session with other servers untried.
    #[test]
    fn a_local_process_death_retries_the_origin_in_full_before_walking() {
        // The origin: full budget, NOT the ServerDrop skip.
        assert_eq!(
            per_candidate_attempt_budget(WalkKind::LocalProcessDeath, 3, 0),
            RECONNECT_MAX_ATTEMPTS
        );
        // …so it does NOT give up on attempt 1 — the walk cannot race past the origin here.
        assert!(!gave_up(
            1,
            per_candidate_attempt_budget(WalkKind::LocalProcessDeath, 3, 0)
        ));
        // The two causes genuinely disagree at the origin, which is the whole point of the enum.
        assert_ne!(
            per_candidate_attempt_budget(WalkKind::LocalProcessDeath, 3, 0),
            per_candidate_attempt_budget(WalkKind::ServerDrop, 3, 0)
        );
        // But the walk still HAS somewhere to go once the origin is exhausted — the failure mode
        // that prompted the ruling was untried servers, not a wrong budget.
        assert_eq!(
            per_candidate_attempt_budget(WalkKind::LocalProcessDeath, 3, 1),
            FAILOVER_ATTEMPTS_PER_CANDIDATE
        );
    }

    #[test]
    fn a_drop_with_a_live_adapter_is_a_tunnel_loss_not_an_internet_loss() {
        // The UAT test 1 in one assertion. The classifier used to ask a gateway PROBE,
        // which travels through the dead tunnel while the core still holds its fail-closed
        // killswitch and therefore always failed — so a server-side drop on a healthy Wi-Fi was
        // filed as `internet-lost`, which `should_failover` refuses, which meant «Авто-режим»
        // never moved anybody.
        assert!(drop_is_tunnel_lost(true));
        assert!(!drop_is_tunnel_lost(false));

        // And the row that matters end-to-end: adapter present + failover on + somewhere to go
        // must now reach a real walk.
        let reason = if drop_is_tunnel_lost(true) {
            crate::connectivity::TUNNEL_LOST_REASON
        } else {
            crate::connectivity::INTERNET_LOST_REASON
        };
        assert!(should_failover(reason, true, 1));
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
        // Const block: `FIXB_RESET_MIN_INTERVAL_SECS` is a compile-time constant, so shrinking
        // it back under the detection cadence fails while the test binary compiles rather than
        // on one test run. See connectivity.rs `offline_floor_is_snappy` for the enforcement point.
        const {
            assert!(
                FIXB_RESET_MIN_INTERVAL_SECS >= 60,
                "rate-limit window must comfortably exceed the ~12-15s detection window",
            )
        };
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

// ─── Phase 16 (plan 16-04): T-32 transient-miss debounce decision ───
//
// T-32 — a SINGLE tunnel-probe miss that lands right after an adapter settle (the FIX-B/E RC-1
// case: Docker/WSL/Wi-Fi NIC churn briefly starves the probe) may be treated as TRANSIENT and NOT
// escalate, while a miss that brings the streak to MAX_FAILURES is a genuine drop that MUST
// escalate — the debounce may NEVER delay a real drop. This is the pure decision the 16-01 RED
// module (`probe_miss_tests`) pinned; 16-04 lands it here so that module compiles + goes GREEN.
//
// WHY it exists: reduce residual false «tunnel-lost» churn on a transient DNS-proxy/adapter blip
// while preserving the praised ~10× faster real-drop detection. The transient case is defined as
// «inside the adapter-settle window AND below max_failures» — the SAME two facts the FIX-B reset
// already keys on, expressed as one testable predicate. Two invariants make it real-drop-safe by
// construction:
//   1. `consecutive_failures >= max_failures` ⇒ ALWAYS false — a streak that reaches the escalation
//      threshold is a genuine sustained drop and is NEVER masked, even inside the settle window.
//   2. `within_settle_window == false` ⇒ ALWAYS false — outside the window there is NO debounce;
//      the steady-state MAX_FAILURES cadence owns the decision exactly as today (defaults to
//      current behavior). This is why the helper cannot regress the aggressive real-drop timing.
//
// Clock/IO-free, mirroring `fixb_reset_allowed`'s pure shape (`max_failures` is a PARAMETER, not
// the cross-module private `connectivity::MAX_FAILURES`). VPN-core-adjacent → Fable deep-review
// post-execution. Rationale: .planning/debug/claude-code-403-on-vpn-reconnect.md (FIX-B / FIX-E).
//
// NOTE (16-04 boundary): this helper is deliberately NOT wired into the live `connectivity.rs`
// escalation loop — see 16-04-SUMMARY.md. At the only candidate seam (the MAX_FAILURES escalation
// gate) the FIX-B reset already zeros the counter + sleeps ADAPTER_EVENT_SETTLE_MS (1500 ms), so by
// the time a streak could reach MAX_FAILURES (~12-15 s of cadence) the settle window is long
// expired — the predicate would be `false` there anyway (invariants 1 AND 2 both bite). Wiring
// would be a provable no-op, and the residual false-drop it targets cannot be demonstrated without
// the live `app.log` (unavailable). The helper ships tested + ready for a future
// demonstrable-log fix; the globals are NOT loosened.
pub fn probe_miss_is_transient(
    consecutive_failures: u32,
    max_failures: u32,
    within_settle_window: bool,
) -> bool {
    within_settle_window && consecutive_failures < max_failures
}

#[cfg(test)]
mod probe_miss_tests {
    use super::*;

    // Small self-contained MAX (mirrors connectivity::MAX_FAILURES = 3) passed as a parameter — do
    // NOT reach across modules for the private const; the pure fn takes it as an argument.
    const MAX: u32 = 3;

    #[test]
    fn probe_miss_transient_within_settle_window_is_transient() {
        // A single miss (failures below MAX) that lands inside a recent adapter-settle window is
        // transient — absorb it, do not escalate.
        assert!(probe_miss_is_transient(1, MAX, true));
    }

    #[test]
    fn probe_miss_at_max_failures_is_not_transient() {
        // A miss that brings the streak to MAX is a real, sustained drop — it must escalate even
        // inside a settle window. The debounce NEVER delays a genuine drop (defaults to current
        // behavior once the streak is real).
        assert!(!probe_miss_is_transient(MAX, MAX, true));
    }

    #[test]
    fn probe_miss_outside_settle_window_is_not_transient() {
        // Outside the settle window there is NO debounce — the steady-state MAX_FAILURES cadence
        // owns the decision (current behavior). Even a below-max streak is NOT masked here.
        assert!(!probe_miss_is_transient(2, MAX, false));
    }

    #[test]
    fn probe_miss_zero_failures_in_window_is_transient() {
        // Below max, inside the window → transient (the very first miss after a settle).
        assert!(probe_miss_is_transient(0, MAX, true));
    }

    #[test]
    fn probe_miss_max_max_is_never_transient_for_any_max() {
        // Boundary invariant: (max, max, _) is ALWAYS false for any max >= 1, regardless of the
        // window flag — a streak that reaches the escalation threshold is a genuine drop that a
        // real-drop-safe debounce may NEVER delay. This is the core anti-mask guarantee.
        for max in 1u32..=10 {
            assert!(
                !probe_miss_is_transient(max, max, true),
                "(max={max}, max, true) must never be transient",
            );
            assert!(
                !probe_miss_is_transient(max, max, false),
                "(max={max}, max, false) must never be transient",
            );
        }
    }

    #[test]
    fn probe_miss_above_max_is_never_transient() {
        // A streak that has already overshot MAX is likewise never transient — the `<` comparison
        // holds for any over-threshold count, so a real drop can never be re-classified transient.
        assert!(!probe_miss_is_transient(MAX + 1, MAX, true));
        assert!(!probe_miss_is_transient(u32::MAX, MAX, true));
    }
}
