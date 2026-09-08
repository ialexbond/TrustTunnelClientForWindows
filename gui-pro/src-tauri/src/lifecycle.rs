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
// 32-FIX-15 — the note this installation leaves about WHERE it keeps the data.
//
// This is the one item in this module that touches the filesystem, and it sits here rather than
// in a module of its own for the reason the two basenames above it exist at all: the name of a
// file that BOTH ends of the product read has to live in one place, and the writer has to be
// beside the name. `SIDECAR_PID_BASENAME` and the survivor marker each learned that the hard way
// (D-07) — a second spelling anywhere is how two ends drift while nothing watches.
// ---------------------------------------------------------------------------

/// Basename of the file the application writes beside its own binaries on every start, holding
/// the absolute path of the folder THIS installation keeps the user's data in.
///
/// **WHY THIS FILE EXISTS.** The data folder lives under the profile of whichever account
/// approved the program's elevation prompt (`trusttunnel.exe.manifest:18` asks for
/// administrator, so under over-the-shoulder UAC that is the supplying administrator and not the
/// person at the keyboard). The uninstaller asks for the same rights and gets its OWN answer to
/// «my profile», which need not be the same account; and Windows will not tell an elevated
/// process which account owns the data of another elevated process. So the account that KNOWS
/// writes the fact down, and the account that NEEDS it reads the note back. No identity is
/// recovered anywhere: one side records a fact, the other checks it against a second fact — its
/// own profile directory — and refuses on any mismatch. That is how D-08 is honoured here rather
/// than evaded. Owner decision `D32-16` = `route-record`, 2026-09-06.
///
/// **WHAT IT IS NOT.** It is not a configuration input. Nothing reads it to DECIDE where data
/// goes — `ssh::user_data_dir()` remains the single funnel for that, and it derives nothing from
/// this file. The note is only ever read to check where the data ALREADY went, and every reader
/// validates it before use, because a file in a world-readable folder is input and never
/// instruction.
///
/// **THE CONFIDENTIALITY CONSEQUENCE, STATED RATHER THAN DISCOVERED.** The install directory is
/// under Program Files, whose ACL grants `BUILTIN\Users` read by inheritance, so every account on
/// the machine can read this note — and what it tells them is which account uses the program.
/// That is exactly the class of path the survivor marker written by 32-FIX-10 already carries,
/// for the same reason and with the same acceptance (T-32-59). What it does NOT carry: no
/// credential, no key, no host, and no filename the user chose. One line, one path, composed by
/// this program from its own rule.
///
/// **PER-EDITION, like the pid file and for its reason.** Pro and Light must never read each
/// other's note if they ever share a directory; distinct names make the two editions' records
/// mutually invisible (D-07).
pub const DATA_ROOT_RECORD_BASENAME: &str = ".data-root-pro.txt";

/// What one attempt to write the record did. Every degraded case is a VARIANT rather than a
/// swallowed error, so each one has a test instead of a hope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataRootRecordOutcome {
    /// The note is on disk and its single line is the data root.
    Written,
    /// There is no directory to write it into — the executable could not be resolved, or what was
    /// handed in was relative. Nothing was written ANYWHERE; see the writer for why a relative
    /// answer is worse than no answer.
    NoExecutableDirectory,
    /// The data root was not an absolute path, so the note would only ever produce a refusal.
    NotAbsolute,
    /// The write itself failed. Path-free reason (D-29), because this string reaches `app.log`.
    Failed(String),
}

/// Write the record: the data root, on one line, in the executable's own directory.
///
/// Both roots are PARAMETERS rather than resolved in here, for the reason `sidecar_pid_dir` and
/// `report_legacy_leftovers` both state at their own sites: under `cargo test --lib` the
/// executable is a test binary somewhere in the build tree, so a function that resolved its own
/// inputs could only be asserted about wherever that binary happened to live. The production
/// answers are supplied by [`record_data_root_on_startup`] and nowhere else.
///
/// **A RELATIVE DESTINATION IS REFUSED, NOT SUBSTITUTED.** A relative directory is composed
/// against the process WORKING directory, which is chosen by whoever launched the process — and
/// the launcher that matters here is the logon scheduled task, whose working directory is
/// `%WINDIR%\System32`. That would put a dotfile naming the user's profile into the Windows
/// system directory, written by an elevated process, where the uninstaller can never read it and
/// the user will never find it. This is 32-FIX-08's rule for the pid file, one file over
/// (G-32-2e): declining is strictly better than misfiling.
///
/// **THE WRITE TRUNCATES.** `fs::write` opens with truncation, so a shorter root after a longer
/// one leaves no tail of the longer one behind. A record carrying two paths spliced together
/// would fail the uninstaller's ladder and silently cost the user the erasure they asked for.
pub fn write_data_root_record(
    data_root: &std::path::Path,
    exe_dir: Option<&std::path::Path>,
) -> DataRootRecordOutcome {
    let Some(dir) = exe_dir.filter(|d| d.is_absolute()) else {
        return DataRootRecordOutcome::NoExecutableDirectory;
    };
    if !data_root.is_absolute() {
        return DataRootRecordOutcome::NotAbsolute;
    }
    // No trailing newline: the note is the path and nothing else, the same shape `save_sidecar_pid`
    // writes and the uninstall hook already reads with a bare `FileRead`.
    match std::fs::write(
        dir.join(DATA_ROOT_RECORD_BASENAME),
        data_root.to_string_lossy().as_bytes(),
    ) {
        Ok(()) => DataRootRecordOutcome::Written,
        Err(e) => DataRootRecordOutcome::Failed(record_failure_reason(&e.to_string())),
    }
}

/// A write error with anything path-shaped taken out.
///
/// The same predicate `legacy_sweep::reason_without_path` applies and for the same reason (D-29):
/// today `fs::write` formats its errors from the operation and never from the destination, but
/// «never today» is not a guard, and this string reaches `app.log` — where the destination would
/// carry the Windows account name.
fn record_failure_reason(reason: &str) -> String {
    if reason.contains('\\') || reason.contains('/') {
        return "the record could not be written".to_string();
    }
    reason.to_string()
}

/// The production entry point: resolve both roots through the accessors that already own them,
/// write the note, and say in `app.log` what happened.
///
/// The data root comes from `ssh::user_data_dir()` — the single accessor every path-confinement
/// root in this crate derives from — and the program's folder from `sidecar_pid_dir`, which
/// already answers «the directory the executable is in» for the pid file the installer reads.
/// Neither is re-derived here; a second lookup is how the two ends of a path come to disagree.
///
/// **LOSING THE NOTE MAY NEVER STOP THE APPLICATION STARTING.** Nothing the user asked for
/// depends on it, so nothing it fails at may interrupt anybody: every outcome is one line in
/// `app.log`, never a dialog and never an abort. The cost of a missing note is a later REFUSAL in
/// the uninstaller, which is the safe direction — the same trade `report_legacy_leftovers` makes
/// one call site below (T-32-60).
///
/// **THE LOG LINE NAMES NO PATH.** The note's whole content is a profile-relative folder, i.e.
/// the account name; `legacy_sweep::folder_for_report` exists because that is not printable as-is.
/// Here it is simply not printed: what a reader of `app.log` needs is whether the note was
/// written, and the note itself is the place the path belongs.
pub(crate) fn record_data_root_on_startup() -> DataRootRecordOutcome {
    let data_root = crate::ssh::user_data_dir();
    let exe_dir = crate::commands::vpn::sidecar_pid_dir(std::env::current_exe().ok());
    let outcome = write_data_root_record(&data_root, exe_dir.as_deref());

    let line = match &outcome {
        DataRootRecordOutcome::Written => "[data-root] wrote down, beside the program's own files, \
             which folder this installation keeps your data in"
            .to_string(),
        DataRootRecordOutcome::NoExecutableDirectory => {
            "[data-root] not written down: the program's own folder could not be resolved, and a \
             note anywhere else is a note nothing reads"
                .to_string()
        }
        DataRootRecordOutcome::NotAbsolute => {
            "[data-root] not written down: the data folder did not resolve to an absolute path"
                .to_string()
        }
        DataRootRecordOutcome::Failed(reason) => {
            format!("[data-root] not written down - {reason}")
        }
    };
    // Two channels, copied from the leftover report and for its reason: `log_app` is the durable
    // one and is a no-op when file logging is off.
    crate::logging::log_app("info", &line);
    eprintln!("{line}");

    outcome
}

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

// `pub(crate)` since 32-FIX-11, for ONE item: `USER_DATA`. The startup leftover report keeps a
// closed allow-list of legacy binaries, and the property that makes that list safe is that it is
// disjoint from everything the user owns — which is this list, not a copy of it. A second copy
// beside this one is how two lists drift and one of them quietly stops being enforced, which is the
// argument this module's own comments make about the NSIS hook. Nothing else here is exported.
#[cfg(test)]
pub(crate) mod tests {
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
    /// The pid file sits beside the binaries, which the installer spells `$INSTDIR` — an NSIS
    /// variable that has no value until the uninstaller runs, so Rust cannot resolve it.
    /// The agreement is therefore pinned in three parts, each of which alone would be too weak:
    /// the hook's root is the install directory (not some other folder), the pid path is COMPOSED
    /// from that root plus the constant production code uses, and Rust's own pid directory really
    /// is the executable's directory — which is what makes `$INSTDIR` the correct spelling of it.
    ///
    /// **Re-derived in phase 32, not string-flipped.** The subject of part (3) changed: the data
    /// root left the install directory in that phase, so asserting on `resolve_data_root` here
    /// would now pin the wrong function — it would keep passing while the pid file wandered off
    /// on its own. The subject is the pid-directory accessor, which is what `$INSTDIR` now
    /// spells. The divergence the phase introduced has its own test below.
    #[test]
    fn the_uninstall_hook_reads_the_pid_file_the_app_writes() {
        let hook = include_str!("../nsis/installer-hooks.nsh");

        // (1) The hook's root is the install directory. Pinning the literal is the point: any
        //     other value — a $LOCALAPPDATA subfolder, a vendor\edition pair — means the hook is
        //     looking somewhere the app does not write. `$LOCALAPPDATA` in particular is a trap
        //     here: under `installMode: perMachine` NSIS resolves it to %ProgramData%, a folder
        //     nothing writes, and the kill would silently become a no-op.
        assert!(
            hook.contains("!define TT_INSTALL_DIR \"$INSTDIR\""),
            "the uninstall hook must define the install directory as $INSTDIR — that is where \
             the app writes its pid file"
        );

        // (2) The pid path is composed from THAT root plus the SAME constant production code
        //     uses (`commands/vpn.rs::sidecar_pid_path` joins it onto `sidecar_pid_dir`).
        //     Hard-coding the basename here would make this test agree with itself rather than
        //     with the application.
        let want_pid =
            format!("!define TT_SIDECAR_PID_FILE \"${{TT_INSTALL_DIR}}\\{SIDECAR_PID_BASENAME}\"");
        assert!(
            hook.contains(&want_pid),
            "the uninstall hook's pid path must be built from the install directory plus \
             {SIDECAR_PID_BASENAME}; expected the line: {want_pid}"
        );

        // (3) Rust's end of the agreement: the pid directory really is the executable's own
        //     directory, so `$INSTDIR` is the right NSIS spelling of it. Without this the first
        //     two assertions would keep passing if the Rust helper moved the pid file elsewhere.
        let install = std::path::Path::new("C:\\Program Files\\TrustTunnel Client Pro");
        assert_eq!(
            crate::commands::vpn::sidecar_pid_dir(Some(install.join("trusttunnel.exe"))).as_deref(),
            Some(install),
            "the pid file must live in the executable's own directory, else $INSTDIR is the \
             wrong spelling of it and the hook is reading the wrong folder"
        );

        // (4) Every pid read composes its path from the SAME constant. A hand-written path is how
        //     the two ends drift back apart.
        //
        //     RE-DERIVED IN 32-FIX-09, BECAUSE THE PREMISE «THERE IS ONE PID PATH» STOPPED BEING
        //     TRUE. The pre-install hook now stops this edition's VPN core before it removes the
        //     binaries that core holds open (UAT gap G-32-2), and it must read the pid file of the
        //     LEGACY folder — `$R9`, the discovered and validated path — not of `$INSTDIR`, which
        //     is the folder being installed INTO. `${TT_SIDECAR_PID_FILE}` is rooted at
        //     `${TT_INSTALL_DIR}` by construction, so it is the wrong path there and the correct
        //     read could not be spelled with it.
        //
        //     The rule is re-derived rather than deleted or string-flipped, and it is STRONGER
        //     than it was on two counts. (i) The second root is not merely tolerated: the whole
        //     composition is built here from `SIDECAR_PID_BASENAME`, so renaming that constant
        //     reddens the pre-install read exactly as it already reddens the uninstall one — the
        //     basename cannot acquire a second spelling in this file. (ii) It is no longer
        //     VACUOUS. The trigger used to be `.contains(".pid")`, and after the define was
        //     introduced no read line carried that text any more, so this loop matched ZERO lines
        //     and passed over nothing. It now recognises a read either way and reports an
        //     inability to measure when it finds none.
        let legacy_read = format!("\"$R9\\{SIDECAR_PID_BASENAME}\"");
        let mut pid_reads = 0usize;
        for line in hook.lines() {
            let l = line.trim();
            let is_read = (l.starts_with("IfFileExists") || l.starts_with("FileOpen"))
                && (l.contains(".pid") || l.contains("${TT_SIDECAR_PID_FILE}"));
            if !is_read {
                continue;
            }
            pid_reads += 1;
            assert!(
                l.contains("${TT_SIDECAR_PID_FILE}") || l.contains(&legacy_read),
                "the hook reads the pid file through a hand-written path. Exactly two \
                 compositions are legitimate — `${{TT_SIDECAR_PID_FILE}}` for the uninstaller, \
                 which runs inside the install directory, and {legacy_read} for the pre-install \
                 hook, which must read the DISCOVERED legacy folder rather than the one being \
                 installed into. Anything else is a third spelling of {SIDECAR_PID_BASENAME} that \
                 nothing keeps in step with Rust: {l}"
            );
        }
        assert!(
            pid_reads > 0,
            "CANNOT MEASURE: the hook reads no pid file at all. Both the uninstall kill and the \
             pre-install core termination depend on that read, so zero reads means this rule lost \
             its subject — not that every read is well composed."
        );
    }

    /// **The user's data and the binaries are two different places, and must stay that way.**
    ///
    /// This is the invariant phase 32 exists to install, written down where it goes red rather
    /// than where it is explained. Before that phase ONE noun served as both: `user_data_dir()`
    /// returned the executable's own folder, and that was tolerable only because the install
    /// itself lived under `%LOCALAPPDATA%`. With `installMode: perMachine` the binaries move to
    /// Program Files, whose ACL grants `BUILTIN\Users` read by inheritance over child objects —
    /// so re-identifying the two would put the plaintext `ssh_credentials.json` in a directory
    /// every account on the machine can read. It is a confidentiality regression with no error
    /// message, no failing build, and nothing else watching for it.
    ///
    /// The two accessors are asked about the SAME executable deliberately: that shared input is
    /// what makes the answer a statement about the RULES rather than about two unrelated paths
    /// that happen to differ today.
    #[test]
    fn the_data_root_and_the_pid_directory_are_not_the_same_place() {
        let exe = std::path::Path::new("C:\\Program Files\\TrustTunnel Client Pro\\trusttunnel.exe");

        let data_root = crate::ssh::resolve_data_root(Some(exe.to_path_buf()))
            .expect("a Windows test host always has an absolute local-app-data location")
            .0;
        // 32-FIX-08: the accessor answers an OPTION now — it declines rather than substituting the
        // process working directory when the executable cannot be resolved. Here the executable is
        // given, so an absent answer would itself be the failure this contract is about.
        let pid_dir = crate::commands::vpn::sidecar_pid_dir(Some(exe.to_path_buf()))
            .expect("an absolute executable path always has a parent directory");

        assert_eq!(
            pid_dir,
            exe.parent().unwrap(),
            "the pid file follows the binaries — that is what makes $INSTDIR readable by the \
             uninstaller whichever administrator elevated it"
        );
        assert_ne!(
            data_root, pid_dir,
            "the data root must NOT be the install directory again: under Program Files that \
             folder is world-readable and the credential store is plaintext. If this assertion \
             fails, the data root has been re-derived from the executable somewhere."
        );
    }

    /// The two full-line markers 32-FIX-15 wrote around the one region permitted to erase the
    /// user's data. The region is found by NAME, never by line number: a rule keyed to a line
    /// number stops describing the file the first time somebody adds a paragraph above it.
    const ERASE_REGION_BEGIN: &str = "BEGIN REGION TT_ERASE_DATA_ROOT";
    const ERASE_REGION_END: &str = "END REGION TT_ERASE_DATA_ROOT";

    /// The register the resolution ladder leaves the validated data root in, and the only removal
    /// target the erasure region is allowed to name.
    ///
    /// **WHY `$R8` AND NOT `$R9`, which the ladder used while it removed nothing.** `$R9` is
    /// spoken for: in `NSIS_HOOK_PREINSTALL` it holds the DISCOVERED LEGACY INSTALL PATH, and
    /// `remediation-hygiene.sh` rule 12 arm (c) forbids `RMDir /r "$R9"` across the whole file
    /// because on every pre-32 machine that folder is the user's data root. That gate scans
    /// statements file-wide and cannot tell the two meanings of `$R9` apart, so leaving the
    /// erasure on `$R9` would have made a deliberate, guarded branch indistinguishable from the
    /// single most dangerous line this installer could contain. The answer is to give the data
    /// root its own name rather than to teach the gate an exception: rule 12 keeps its full
    /// strength over the legacy path, and arm (2) below watches this register instead.
    const DATA_ROOT_REGISTER: &str = "$R8";

    /// How the hook spells the framework's bundle-identifier folder. Always the define, never the
    /// expansion: `${BUNDLEID}` comes from `installer.nsi` and a rule matching the expanded
    /// `com.trusttunnel.gui` would go quiet the moment the identifier changed.
    const BUNDLE_ID_REF: &str = "${BUNDLEID}";

    /// The per-user variable the erasure region must NEVER compose a path from.
    ///
    /// Under `perMachine` this uninstaller runs elevated, and `SetShellVarContext current` then
    /// resolves the profile of whichever administrator approved the elevation prompt — not
    /// necessarily the person uninstalling. That is D-08, and it is why the folder is taken from
    /// the note the APPLICATION wrote instead. The template's own erasure composes from this
    /// variable, which is exactly why its removal of the local bundle folder cannot be relied on.
    const UNTRUSTED_PER_USER_VAR: &str = "$LOCALAPPDATA";

    /// The other edition's product name, which is also its key name in the programs list.
    ///
    /// NOT read from `gui-light/src-tauri/tauri.conf.json`, deliberately: that tree does not
    /// travel to the release branch, so an `include_str!` of it would compile here and fail
    /// there. Measured instead, on a real Windows install on 2026-09-07, under both hives:
    /// `HKCU\...\Uninstall\TrustTunnel Client Light` → DisplayName `TrustTunnel Client Light`
    /// (Light installs per-user), nothing under HKLM. Recorded in `32-ERASURE-EVIDENCE.md` (e).
    pub(crate) const OTHER_EDITION_PRODUCT_NAME: &str = "TrustTunnel Client Light";

    /// The two registry keys the two editions SHARE, and which Pro's uninstaller removed
    /// unconditionally until 32-FIX-16 — breaking Light's `trusttunnel://` and `tt://` handling
    /// on any machine that still had Light installed. That is `T-24`, and the evidence measured
    /// it live on a real disk rather than reasoning about it.
    const SHARED_SCHEME_KEYS: [&str; 2] = [
        "DeleteRegKey HKCU \"Software\\Classes\\trusttunnel\"",
        "DeleteRegKey HKCU \"Software\\Classes\\tt\"",
    ];

    /// The region's head, in order, exactly as it must be written: the two conditions as one
    /// conjunction with NOTHING between them.
    ///
    /// Neither is decoration. `$DeleteAppDataCheckboxState` is assigned in exactly one place, the
    /// confirm page's leave function, so it is 0 on every path that shows no pages — it is what
    /// actually holds during an update. `$UpdateMode <> 1` guards a manually invoked
    /// `uninstall.exe /UPDATE`, which is the only way that variable is ever 1 (32-FIX-14 measured
    /// it: a real in-app update runs the installer as `/S` and never starts the uninstaller at
    /// all). Do not call the second one «the update guard»; a contract pinned to the wrong
    /// mechanism is a green test guarding nothing.
    const ERASE_CONDITIONS: [&str; 2] = [
        "${If} $DeleteAppDataCheckboxState = 1",
        "${AndIf} $UpdateMode <> 1",
    ];

    /// The project's definition of a removal statement, in ONE place: a non-comment line whose
    /// first token is `Delete ` or `RMDir`. `DeleteRegKey` and `DeleteRegValue` are deliberately
    /// NOT removals here — they take registry keys, not the user's files, and the scheme-key
    /// contract in this module judges them by their own rule.
    fn is_removal_statement(line: &str) -> bool {
        let l = line.trim();
        !l.starts_with(';') && (l.starts_with("Delete ") || l.starts_with("RMDir"))
    }

    /// **THE SHARED PREDICATE.** For one line of the hook, plus the fact of which region it sits
    /// in, answer whether that line is forbidden — and say why.
    ///
    /// Everything the narrowed user-data guard asserts goes through here, so the arms can be
    /// exercised against written-out fixtures as well as against the shipped file. That is the
    /// discipline 32-FIX-09 established when it narrowed the D-06 rule: a narrowed safety rule
    /// that can no longer reject the thing it was written to reject is worse than no rule at all,
    /// because it reads as coverage. Fixtures keep the arms red-capable whatever the real file
    /// happens to contain today.
    fn erasure_violation(line: &str, inside_region: bool) -> Option<String> {
        let l = line.trim();
        if !is_removal_statement(l) {
            return None;
        }
        let names_install_dir = l.contains("$INSTDIR") || l.contains("${TT_INSTALL_DIR}");

        // (1) UNCHANGED AND UNWEAKENED, IN EVERY REGION. No removal aimed at an install-directory
        //     spelling may name an artifact the user owns. Under D-05 the install directory IS
        //     the data root on every machine installed before phase 32, and an UPDATE runs this
        //     uninstaller. This is the rule that was missing until phase 30.1.
        if names_install_dir && USER_DATA.iter().any(|name| l.contains(name)) {
            return Some(format!(
                "removes a user artifact from the install directory — under D-05 that folder is \
                 the data root on every pre-32 machine, and an UPDATE runs this uninstaller: {l}"
            ));
        }

        // (1b) AND THE RECURSIVE FORM, ANYWHERE. `RMDir /r "$INSTDIR"` takes the servers, the
        //      saved passwords, the known hosts and the browser profile in one statement and
        //      names none of them, so arm (1) would report nothing. Permitting this INSIDE the
        //      erasure region would be no better: the region is for the data root the application
        //      recorded, and on a pre-32 machine that is not the install directory but the folder
        //      the ladder refuses (rung 5).
        if l.starts_with("RMDir /r")
            && (l.contains("\"$INSTDIR\"") || l.contains("\"${TT_INSTALL_DIR}\""))
        {
            return Some(format!(
                "recursively removes the install directory — everything an existing user has, in \
                 one line, and D-06 exists to prevent exactly this: {l}"
            ));
        }

        // (2) THE HOLE THIS ARM CLOSES, and it is new in 32-FIX-16. The rule above only ever
        //     examined removals naming an install-directory spelling, so a removal aimed at the
        //     register holding the RESOLVED DATA ROOT would not have been looked at anywhere in
        //     the file. Now exactly one region may name it; everywhere else it is forbidden.
        //
        //     The bundle-identifier folder goes with it, and for the same reason: it lives in the
        //     uninstalling person's profile, so a removal of it outside the conjunction would run
        //     during an update too.
        if !inside_region && (l.contains(DATA_ROOT_REGISTER) || l.contains(BUNDLE_ID_REF)) {
            return Some(format!(
                "removes a per-user folder ({DATA_ROOT_REGISTER} or {BUNDLE_ID_REF}) OUTSIDE the \
                 TT_ERASE_DATA_ROOT region, so it runs without the ticked-and-not-updating \
                 conjunction — i.e. during a routine update: {l}"
            ));
        }

        // (2b) INSIDE the region the data root goes by NAME, as one recursive removal — but no
        //      line may ENUMERATE a file the user owns. The permission is for the folder the
        //      application recorded, not for a list of the user's filenames growing back beside
        //      a destructive step. Same `USER_DATA` list as arm (1), never a second copy of it:
        //      a name added for either guard is enforced by both.
        if inside_region {
            if let Some(name) = USER_DATA.iter().find(|name| l.contains(*name)) {
                return Some(format!(
                    "the erasure region names the user artifact `{name}` on a removal line. The \
                     region removes the recorded data root as a whole; a list of the user's own \
                     filenames beside a recursive delete is the pre-30.1 shape growing back: {l}"
                ));
            }
        }

        None
    }

    /// **ARM (3) AS A PREDICATE.** Given the region's executable statements in order, is its head
    /// exactly the two conditions, conjoined, with nothing between them?
    ///
    /// Taking a slice rather than reading the file is what lets the arm be fed a head that lost
    /// the not-updating conjunct and a head with a statement wedged between the two conditions —
    /// the two shapes that would arm this branch during an update.
    fn erase_region_head_violation(statements: &[String]) -> Option<String> {
        let head: Vec<&str> = statements.iter().take(2).map(String::as_str).collect();
        if head.len() == 2 && head[0] == ERASE_CONDITIONS[0] && head[1] == ERASE_CONDITIONS[1] {
            return None;
        }
        Some(format!(
            "the erasure region must OPEN with `{}` immediately followed by `{}` and nothing \
             between them; its first statements are {:?}. A region that lost the second conjunct, \
             or grew a statement between the two, erases a live user's servers and saved \
             passwords during what they experience as maintenance — this project did exactly that \
             for years before phase 30.1",
            ERASE_CONDITIONS[0], ERASE_CONDITIONS[1], head
        ))
    }

    /// Every line of the hook, paired with whether it sits INSIDE the erasure region.
    ///
    /// The markers themselves are reported as outside: they are comments, so nothing is judged by
    /// them anyway, and counting them as inside would let a removal be smuggled onto the same
    /// line as a marker. Panics when either marker is missing — a scan that lost its subject must
    /// report an inability to measure, never an absence of violations.
    fn hook_lines_by_region(hook: &str) -> Vec<(String, bool)> {
        let mut inside = false;
        let mut saw_begin = false;
        let mut saw_end = false;
        let mut out = Vec::new();
        for line in hook.lines() {
            if line.contains(ERASE_REGION_BEGIN) {
                saw_begin = true;
                inside = true;
                out.push((line.to_string(), false));
                continue;
            }
            if line.contains(ERASE_REGION_END) {
                saw_end = true;
                inside = false;
                out.push((line.to_string(), false));
                continue;
            }
            out.push((line.to_string(), inside));
        }
        assert!(
            saw_begin && saw_end,
            "CANNOT MEASURE: the hook has no `{ERASE_REGION_BEGIN}` / `{ERASE_REGION_END}` pair \
             (begin seen: {saw_begin}, end seen: {saw_end}). Every arm below is about where a \
             line sits relative to that region, so a missing marker means the scan lost its \
             subject rather than that the file is clean."
        );
        out
    }

    /// **The uninstaller deletes the user's data in exactly ONE branch, and nowhere else.**
    /// An UPDATE runs the uninstaller.
    ///
    /// This is not hypothetical and it is not new: until phase 30.1 this hook unconditionally
    /// deleted `ssh_credentials.json`, `known_hosts.json`, `routing_rules.json` and the rest on
    /// every uninstall, so every routine update silently wiped the user's saved SSH passwords and
    /// routing rules. The server list survived only by accident — `configs.json` and the
    /// per-server `.toml` files were never in that list.
    ///
    /// **WHAT 32-FIX-16 CHANGED, AND IN WHICH DIRECTION.** The owner ticked a box captioned
    /// «удалить остатки» and got a folder still full of the saved configs and passwords, and said what
    /// he expects of it in one line: «галочка должна работать как "Удалить полностью"». So the
    /// rule is NARROWED — the TT_ERASE_DATA_ROOT region may now remove the data root the
    /// application itself recorded — and WIDENED in the same edit, because the old rule only ever
    /// looked at removals naming an install-directory spelling and would not have examined a
    /// data-root removal placed anywhere in the file. Narrowing without arm (2) would have opened
    /// the file, not one branch of it.
    ///
    /// Four arms:
    ///   1. every removal, in every region, still obeys the pre-30.1 rule and the recursive-form
    ///      rule — neither becomes permissible anywhere;
    ///   2. outside the region, no removal may name the register holding the resolved data root;
    ///   3. the region opens with the two conditions as one conjunction with nothing between them;
    ///   4. and the region actually CONTAINS the erasure, because a guard around an empty branch
    ///      is the shape this phase keeps finding — a check that cannot fail.
    #[test]
    fn the_uninstaller_never_deletes_user_data() {
        let hook = include_str!("../nsis/installer-hooks.nsh");
        let lines = hook_lines_by_region(hook);

        // Arms (1), (1b) and (2), over the shipped file.
        let offenders: Vec<String> = lines
            .iter()
            .filter_map(|(l, inside)| erasure_violation(l, *inside))
            .collect();
        assert!(
            offenders.is_empty(),
            "the uninstaller reaches the user's data outside the one branch that is allowed to:\n  \
             {}",
            offenders.join("\n  ")
        );

        // The statements of the region itself, in order, prose removed.
        let region: Vec<String> = lines
            .iter()
            .filter(|(_, inside)| *inside)
            .map(|(l, _)| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with(';'))
            .collect();
        assert!(
            !region.is_empty(),
            "CANNOT MEASURE: the TT_ERASE_DATA_ROOT region contains no statements at all"
        );

        // Arm (3): the head is the conjunction, and nothing sits between the two conditions.
        assert!(
            erase_region_head_violation(&region).is_none(),
            "{}",
            erase_region_head_violation(&region).unwrap_or_default()
        );

        // Arm (4): the erasure EXISTS. Everything above constrains where the removal may be; this
        // is the arm that says there is one. Without it the whole contract would stay green over
        // a checkbox that promises «Удалить полностью» and removes nothing — which is precisely
        // the defect the owner reported, wearing a full set of passing tests.
        let erasure = format!("RMDir /r \"{DATA_ROOT_REGISTER}\"");
        assert!(
            region.iter().any(|l| l == &erasure),
            "the TT_ERASE_DATA_ROOT region does not contain `{erasure}`, so ticking the box \
             removes nothing of the user's data. The caption promises a clean machine; a guard \
             around an empty branch is how that promise is broken silently."
        );

        // The default stance must be STATED, not merely true by accident: an undocumented absence
        // is what the next reader "fixes" by adding a tidy-up list back.
        //
        // Named through the language files since 32-FIX-18 (G-32-6): the sentence the owner read
        // in a real uninstall log was English inside a Russian pane. The key is asserted, not the
        // text — the text lives in `Russian.nsh` and is free to be reworded there.
        assert!(
            hook.contains("DetailPrint \"$(uninstallDataKept)\""),
            "the hook must say out loud that the user's data is kept, so the omission reads as a \
             decision rather than as something forgotten"
        );

        // ── THE ARMS MUST STILL BE ABLE TO FAIL, AND THAT IS ASSERTED HERE RATHER THAN TRUSTED ──
        //
        // Copied discipline from 32-FIX-09: the fixtures are written out in full and checked
        // against the SHARED predicates, so every arm stays red-capable regardless of what the
        // real hook file contains today. Without them this test would quietly become a tautology
        // the day somebody restructures the hook — and it would keep printing PASS beside a
        // recursive delete running as Administrator.
        for (fixture, inside, what) in [
            (
                "RMDir /r \"$R8\"",
                false,
                "a data-root removal OUTSIDE the region — it would run during a routine update",
            ),
            (
                "RMDir /r \"$INSTDIR\"",
                false,
                "a recursive removal of the install directory, which is the data root on every \
                 pre-32 machine",
            ),
            (
                "RMDir /r \"$INSTDIR\"",
                true,
                "the same recursive removal, smuggled INSIDE the region — the narrowing must not \
                 have made it permissible there",
            ),
            (
                "Delete \"${TT_INSTALL_DIR}\\ssh_credentials.json\"",
                false,
                "a named removal of the credential store from the install directory",
            ),
            (
                "RMDir /r \"$LOCALAPPDATA\\${BUNDLEID}\"",
                false,
                "a bundle-identifier removal OUTSIDE the region — a per-user folder taken \
                 without the conjunction",
            ),
            (
                "Delete \"$R8\\ssh_credentials.json\"",
                true,
                "an enumerated user filename INSIDE the region — the pre-30.1 list growing back \
                 beside the recursive delete",
            ),
        ] {
            assert!(
                erasure_violation(fixture, inside).is_some(),
                "the narrowed user-data rule no longer rejects {what}: `{fixture}`. Narrowing a \
                 safety rule until it accepts everything is the failure this block exists to \
                 catch — the rule would keep passing while the erasure ran on every update."
            );
        }
        // …and the one shape the owner asked for must still be permitted, or the box does nothing.
        assert!(
            erasure_violation("RMDir /r \"$R8\"", true).is_none(),
            "the rule rejects the data-root removal INSIDE its own region, so the checkbox cannot \
             be armed at all and G-32-3 reopens"
        );

        // The same treatment for arm (3): two heads that must be rejected, and the real one that
        // must be accepted.
        for (head, what) in [
            (
                vec![ERASE_CONDITIONS[0].to_string(), "Push $0".to_string()],
                "a region head that lost the not-updating conjunct",
            ),
            (
                vec![
                    ERASE_CONDITIONS[0].to_string(),
                    "DetailPrint \"resolving\"".to_string(),
                    ERASE_CONDITIONS[1].to_string(),
                ],
                "a region head with a statement wedged between the two conditions",
            ),
            (
                vec![ERASE_CONDITIONS[1].to_string(), ERASE_CONDITIONS[0].to_string()],
                "a region head with the two conditions in the wrong order",
            ),
        ] {
            assert!(
                erase_region_head_violation(&head).is_some(),
                "the region-head rule no longer rejects {what}: {head:?}. That shape is how a \
                 routine update walks into the erasure branch."
            );
        }
    }

    /// The two language files the hook's `$(name)` references are resolved against, verbatim.
    ///
    /// Both travel to the release branch under `gui-pro/src-tauri/**`, so `include_str!` of them
    /// compiles here and there alike. Read rather than transcribed: a list of key names typed into
    /// this file would go stale the first time somebody adds a string, and would then certify a
    /// reference `makensis` cannot resolve.
    const RUSSIAN_NSH: &str = include_str!("../nsis/Russian.nsh");
    const ENGLISH_NSH: &str = include_str!("../nsis/English.nsh");

    /// Every key declared by a language file: `LangString name ${LANG_X} "text"` -> `name`.
    fn langstring_keys(language_file: &str) -> Vec<String> {
        language_file
            .lines()
            .filter_map(|l| l.trim().strip_prefix("LangString "))
            .filter_map(|rest| rest.split_whitespace().next())
            .map(str::to_string)
            .collect()
    }

    /// **THE SHARED PREDICATE for G-32-6.** For one line of the hook, is it a log line the
    /// installer prints as a hard-coded literal rather than through a `LangString`?
    ///
    /// The details pane is Russian for a Russian user and English for an English one, and every
    /// line in it that is not routed through the language files is Russian for nobody: it is a
    /// fragment of source text wedged into a translated log. The owner read four of them in his
    /// own uninstall (G-32-6). Written as a predicate rather than as a grep over the file so the
    /// arm can be exercised against fixtures — a rule that can no longer reject the shape it was
    /// written to reject is worse than no rule, because it reads as coverage.
    ///
    /// A translated line is `DetailPrint "$(name)"` or `DetailPrint "$(name) $SOMETHING"` — the
    /// argument must OPEN with the reference. Trailing runtime values (a path, a register) are
    /// exactly how the existing lines are written and are not text to translate.
    fn untranslated_log_line(line: &str) -> Option<String> {
        let l = line.trim();
        if l.starts_with(';') {
            return None;
        }
        let arg = l.strip_prefix("DetailPrint ")?.trim();
        if arg.starts_with("\"$(") {
            return None;
        }
        Some(format!(
            "prints a hard-coded literal into a translated details pane: {l}. Move the text to \
             nsis/Russian.nsh, mirror it in nsis/English.nsh and reference it as $(name)."
        ))
    }

    /// Which of the two language files, if any, fail to declare a key the hook references.
    fn undeclared_langstring(key: &str) -> Option<String> {
        let missing: Vec<&str> = [("Russian.nsh", RUSSIAN_NSH), ("English.nsh", ENGLISH_NSH)]
            .iter()
            .filter(|(_, file)| !langstring_keys(file).iter().any(|k| k == key))
            .map(|(name, _)| *name)
            .collect();
        if missing.is_empty() {
            return None;
        }
        Some(format!(
            "the hook references $({key}), which {} does not declare. `makensis` answers an \
             unresolved LangString with a warning and an EMPTY line in the details pane — the user \
             reads nothing at all where a sentence was meant to be.",
            missing.join(" and ")
        ))
    }

    /// **Every line this installer prints is translatable, and every reference resolves.**
    ///
    /// G-32-6: real install and uninstall logs carried four English sentences —
    /// «Refreshing icon cache...», «Keeping user data», «Cleaning registry entries...»,
    /// «Removing temporary update files...» — in the middle of an otherwise Russian pane. Every
    /// other line of those same macros had gone through a `LangString` for phases; these four were
    /// simply missed, and nothing was watching for the next one.
    ///
    /// Two arms, and the second is not decoration: routing a line through `$(name)` without
    /// declaring the key in BOTH language files trades an English sentence for an EMPTY one, which
    /// is worse — `makensis` emits a warning nobody reads and the pane prints a blank.
    #[test]
    fn every_log_line_the_installer_prints_is_translatable() {
        let hook = include_str!("../nsis/installer-hooks.nsh");

        // The scan must have a subject. A hook with no `DetailPrint` at all would pass both arms
        // while telling the user nothing, so an empty set is reported as an inability to measure.
        let log_lines: Vec<&str> = hook
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with(';') && l.starts_with("DetailPrint "))
            .collect();
        assert!(
            log_lines.len() > 20,
            "CANNOT MEASURE: the hook has only {} `DetailPrint` statement(s). This macro pair \
             announces a legacy sweep, an erasure and five uninstall steps; a count that low means \
             the scan lost its subject rather than that the file is clean.",
            log_lines.len()
        );

        // Arm (1): no literal survives.
        let literals: Vec<String> = log_lines
            .iter()
            .filter_map(|l| untranslated_log_line(l))
            .collect();
        assert!(
            literals.is_empty(),
            "the installer prints untranslated text into the details pane:\n  {}",
            literals.join("\n  ")
        );

        // Arm (2): every reference resolves, in both languages.
        let undeclared: Vec<String> = log_lines
            .iter()
            .filter_map(|l| {
                let start = l.find("\"$(")? + 3;
                let end = l[start..].find(')')? + start;
                undeclared_langstring(&l[start..end])
            })
            .collect();
        assert!(
            undeclared.is_empty(),
            "the installer references language keys that do not exist:\n  {}",
            undeclared.join("\n  ")
        );

        // ── BOTH ARMS MUST STILL BE ABLE TO FAIL ────────────────────────────────────────────
        //
        // Same discipline as the erasure contract above: the fixtures are written out in full and
        // pushed through the SHARED predicates, so neither arm can quietly become a tautology the
        // day the real file stops containing the shape it was written to catch.
        for (fixture, what) in [
            (
                "DetailPrint \"Keeping user data\"",
                "the exact line the owner read in his uninstall log",
            ),
            (
                "  DetailPrint \"Refreshing icon cache...\"",
                "an indented literal — indentation must not buy an exemption",
            ),
            (
                "DetailPrint \"Removing $R9\\wintun.dll\"",
                "a literal carrying a runtime value, which is still a literal sentence",
            ),
        ] {
            assert!(
                untranslated_log_line(fixture).is_some(),
                "the translation rule no longer rejects {what}: `{fixture}`"
            );
        }
        for (fixture, what) in [
            ("DetailPrint \"$(legacyDataKept)\"", "a plain reference"),
            (
                "  DetailPrint \"$(legacyRemoving) $R9\\wintun.dll\"",
                "a reference followed by a runtime value",
            ),
            (
                "; DetailPrint \"Keeping user data\"",
                "a COMMENTED-OUT literal, which prints nothing and must not be reported",
            ),
            ("Delete \"$TEMP\\trusttunnel_setup.exe\"", "a line that is not a log line at all"),
        ] {
            assert!(
                untranslated_log_line(fixture).is_none(),
                "the translation rule now rejects {what}, which is legitimate: `{fixture}`"
            );
        }
        assert!(
            undeclared_langstring("aKeyNobodyEverDeclared").is_some(),
            "the declaration lookup accepts a key neither language file declares, so arm (2) \
             would stay green over a reference that prints an empty line to the user"
        );
        assert!(
            undeclared_langstring("legacyDataKept").is_none(),
            "CANNOT MEASURE: the declaration lookup rejects `legacyDataKept`, which both language \
             files demonstrably declare — the parser is reading something other than the keys"
        );
    }

    /// The statement the uninstaller prints to say the user's data is being LEFT ALONE.
    ///
    /// Held as a whole statement rather than as a key name, because what this contract is about is
    /// WHERE that line is printed from, and only a whole statement can be located in the file.
    const DATA_KEPT_ANNOUNCEMENT: &str = "DetailPrint \"$(uninstallDataKept)\"";

    /// The LogicLib closer the guarded announcement must sit inside.
    const ENDIF: &str = "${EndIf}";

    /// **De Morgan, in NSIS.** Turn one conjunct of the erasure guard into the corresponding
    /// disjunct of its negation: `${If} $X = 1` -> `${If} $X <> 1`,
    /// `${AndIf} $Y <> 1` -> `${OrIf} $Y = 1`.
    ///
    /// **WHY THE INVERSE IS DERIVED AND NEVER TYPED OUT.** The announcement's guard has to be the
    /// exact complement of the erasure's guard — that is the whole content of G-32-7. A second,
    /// hand-written copy of those conditions would agree with the first only until somebody edited
    /// one of them, and the failure that follows is silent: the pane goes on printing «данные
    /// сохраняются» on the pass that destroys them, which is precisely the sentence the owner read
    /// over the deleted passwords. Deriving it means the region's conditions have exactly one
    /// definition, `ERASE_CONDITIONS`, and this contract reddens the moment the two drift.
    ///
    /// AND / OR IS NOT COSMETIC. `NOT (A AND B)` is `NOT A OR NOT B`. Written with `${AndIf}` the
    /// announcement would print only when the box was unticked AND the run was a manual
    /// `/UPDATE` — i.e. almost never — and an ordinary unticked uninstall, which is the one case
    /// the sentence exists for, would say nothing at all.
    fn negated_condition(condition: &str) -> String {
        let (keyword, test) = condition
            .split_once(' ')
            .unwrap_or_else(|| panic!("CANNOT MEASURE: `{condition}` is not `<keyword> <test>`"));
        let keyword = match keyword {
            "${If}" => "${If}",
            "${AndIf}" => "${OrIf}",
            "${OrIf}" => "${AndIf}",
            other => panic!(
                "CANNOT MEASURE: `{other}` is not a LogicLib keyword this negation understands, \
                 so the complement of the erasure guard cannot be derived and the announcement \
                 cannot be judged against anything"
            ),
        };
        let test = if test.contains(" <> ") {
            test.replace(" <> ", " = ")
        } else if test.contains(" = ") {
            test.replace(" = ", " <> ")
        } else {
            panic!(
                "CANNOT MEASURE: `{test}` uses neither ` = ` nor ` <> `, so it cannot be negated"
            )
        };
        format!("{keyword} {test}")
    }

    /// **THE SHARED PREDICATE for G-32-7.** Given every executable statement of the hook in order,
    /// each tagged with whether it sits inside the erasure region: is the kept-data announcement
    /// printed on exactly the path that keeps the data, and on no other?
    ///
    /// The required shape, and nothing looser:
    ///
    /// ```text
    ///   ${If} $DeleteAppDataCheckboxState <> 1
    ///   ${OrIf} $UpdateMode = 1
    ///     DetailPrint "$(uninstallDataKept)"
    ///   ${EndIf}
    /// ```
    ///
    /// Both surrounding conditions are DERIVED from `ERASE_CONDITIONS`, so this cannot drift away
    /// from the branch it is the complement of.
    fn kept_announcement_violation(statements: &[(String, bool)]) -> Option<String> {
        let guard = [
            negated_condition(ERASE_CONDITIONS[0]),
            negated_condition(ERASE_CONDITIONS[1]),
        ];
        let at: Vec<usize> = statements
            .iter()
            .enumerate()
            .filter(|(_, (s, _))| s == DATA_KEPT_ANNOUNCEMENT)
            .map(|(i, _)| i)
            .collect();

        if at.len() != 1 {
            return Some(format!(
                "the hook prints `{DATA_KEPT_ANNOUNCEMENT}` {} time(s); it must print it exactly \
                 once. Zero leaves the kept-data stance unstated, which reads as an oversight and \
                 gets «fixed» by somebody adding a tidy-up list. More than one puts the same claim \
                 on paths this rule cannot then tell apart.",
                at.len()
            ));
        }
        let i = at[0];

        if statements[i].1 {
            return Some(format!(
                "`{DATA_KEPT_ANNOUNCEMENT}` sits INSIDE the TT_ERASE_DATA_ROOT region, which is \
                 the one branch that destroys the data. That is the G-32-7 sentence with its sign \
                 flipped, not a fix."
            ));
        }

        if i < 2 || statements[i - 2].0 != guard[0] || statements[i - 1].0 != guard[1] {
            let before: Vec<&str> = statements[i.saturating_sub(2)..i]
                .iter()
                .map(|(s, _)| s.as_str())
                .collect();
            return Some(format!(
                "`{DATA_KEPT_ANNOUNCEMENT}` is not guarded by the complement of the erasure \
                 branch. It must be preceded, immediately, by `{}` then `{}`; it is preceded by \
                 {before:?}. Unguarded, this line announces that the user's servers and saved \
                 passwords are being kept on the very pass that deletes them — which is what the \
                 was read in a real log above the removal of the data folder (G-32-7).",
                guard[0], guard[1]
            ));
        }

        match statements.get(i + 1) {
            Some((s, _)) if s == ENDIF => None,
            other => Some(format!(
                "`{DATA_KEPT_ANNOUNCEMENT}` is not closed by `{ENDIF}` on the next statement; the \
                 next statement is {:?}. An unclosed guard swallows everything that follows into \
                 the keep-path branch, starting with the removals below it.",
                other.map(|(s, _)| s.as_str())
            )),
        }
    }

    /// Every executable statement of the hook, in order, tagged with whether it sits inside the
    /// erasure region. Comments and blank lines are dropped: they print nothing and guard nothing.
    fn hook_statements_by_region(hook: &str) -> Vec<(String, bool)> {
        hook_lines_by_region(hook)
            .into_iter()
            .map(|(l, inside)| (l.trim().to_string(), inside))
            .filter(|(l, _)| !l.is_empty() && !l.starts_with(';'))
            .collect()
    }

    /// **The uninstaller says it is keeping the data only where it is keeping the data.**
    ///
    /// G-32-7, and it is the narrowest possible defect with the widest possible consequence. The
    /// behaviour was already right: on a real uninstall pass everything he ticked the box for was
    /// correctly destroyed. The SENTENCE was wrong — printed unconditionally, eight lines above
    /// the erasure region, so his log read:
    ///
    /// ```text
    ///   Keeping user data
    ///   Удаление файла: C:\Program Files\TrustTunnel Client Pro\.sidecar-pro.pid
    ///   Удаляется папка с данными этой установки: C:\Users\<user>\AppData\Local\...
    /// ```
    ///
    /// The details pane is the only window in which a person learns what just happened to their
    /// saved passwords. A false sentence there is not cosmetic: it is the program stating the
    /// opposite of what it did, at the one moment the statement matters.
    ///
    /// **WHAT THIS CONTRACT DOES NOT DO.** It does not touch the removal, the guard, the ladder or
    /// the order of anything. It constrains WHERE ONE `DetailPrint` MAY BE PRINTED FROM, and it
    /// derives that place from `ERASE_CONDITIONS` so the answer cannot drift away from the branch
    /// it is the complement of.
    #[test]
    fn the_kept_data_announcement_prints_only_where_the_data_is_kept() {
        let hook = include_str!("../nsis/installer-hooks.nsh");
        let statements = hook_statements_by_region(hook);
        assert!(
            statements.len() > 100,
            "CANNOT MEASURE: the hook scan produced only {} statement(s) — it lost its subject",
            statements.len()
        );
        assert!(
            kept_announcement_violation(&statements).is_none(),
            "{}",
            kept_announcement_violation(&statements).unwrap_or_default()
        );

        // ── THE DERIVATION MUST BE RIGHT, AND THE ARM MUST STILL BE ABLE TO FAIL ─────────────
        assert_eq!(
            negated_condition("${If} $DeleteAppDataCheckboxState = 1"),
            "${If} $DeleteAppDataCheckboxState <> 1"
        );
        assert_eq!(
            negated_condition("${AndIf} $UpdateMode <> 1"),
            "${OrIf} $UpdateMode = 1"
        );
        for condition in ERASE_CONDITIONS {
            assert_eq!(
                negated_condition(&negated_condition(condition)),
                condition,
                "negating `{condition}` twice does not return it, so the derived complement is not \
                 the complement of anything"
            );
        }

        // Fixtures, written out in full and pushed through the SHARED predicate. Without them this
        // contract would quietly become a tautology the day somebody restructured the hook — and it
        // would keep printing PASS beside a sentence that lies about the user's passwords.
        let guard = [
            negated_condition(ERASE_CONDITIONS[0]),
            negated_condition(ERASE_CONDITIONS[1]),
        ];
        let stmt = |s: &str, inside: bool| (s.to_string(), inside);
        let well_formed = vec![
            stmt("Delete \"${TT_SIDECAR_PID_FILE}\"", false),
            stmt(&guard[0], false),
            stmt(&guard[1], false),
            stmt(DATA_KEPT_ANNOUNCEMENT, false),
            stmt(ENDIF, false),
            stmt(ERASE_CONDITIONS[0], true),
            stmt(ERASE_CONDITIONS[1], true),
            stmt("RMDir /r \"$R8\"", true),
        ];
        assert!(
            kept_announcement_violation(&well_formed).is_none(),
            "the rule rejects the shape it exists to require, so the announcement cannot be \
             written correctly at all: {:?}",
            kept_announcement_violation(&well_formed)
        );

        for (fixture, what) in [
            (
                vec![
                    stmt("Delete \"${TT_SIDECAR_PID_FILE}\"", false),
                    stmt(DATA_KEPT_ANNOUNCEMENT, false),
                    stmt(ERASE_CONDITIONS[0], true),
                    stmt(ERASE_CONDITIONS[1], true),
                    stmt("RMDir /r \"$R8\"", true),
                ],
                "THE G-32-7 DEFECT ITSELF: the announcement printed unconditionally, above the \
                 region that erases the data",
            ),
            (
                vec![
                    stmt(&guard[0], false),
                    stmt(DATA_KEPT_ANNOUNCEMENT, false),
                    stmt(ENDIF, false),
                ],
                "a guard that lost the not-updating disjunct, so a manual /UPDATE run prints \
                 nothing where the data is in fact kept",
            ),
            (
                vec![
                    stmt(&guard[0], false),
                    stmt("${AndIf} $UpdateMode = 1", false),
                    stmt(DATA_KEPT_ANNOUNCEMENT, false),
                    stmt(ENDIF, false),
                ],
                "De Morgan inverted -- AND where the complement needs OR, which silences the line \
                 on the ordinary unticked uninstall it exists for",
            ),
            (
                vec![
                    stmt(&guard[0], false),
                    stmt(&guard[1], false),
                    stmt("DetailPrint \"$(eraseDataRootRemoved)\"", false),
                    stmt(DATA_KEPT_ANNOUNCEMENT, false),
                    stmt(ENDIF, false),
                ],
                "a statement wedged between the guard and the announcement, so what the guard \
                 covers is no longer what this rule read",
            ),
            (
                vec![
                    stmt(&guard[0], false),
                    stmt(&guard[1], false),
                    stmt(DATA_KEPT_ANNOUNCEMENT, false),
                    stmt("Delete \"${TT_DATA_ROOT_RECORD}\"", false),
                ],
                "an unclosed guard, which swallows the statements below it into the keep path",
            ),
            (
                vec![
                    stmt(ERASE_CONDITIONS[0], true),
                    stmt(ERASE_CONDITIONS[1], true),
                    stmt(DATA_KEPT_ANNOUNCEMENT, true),
                    stmt("RMDir /r \"$R8\"", true),
                ],
                "the announcement moved INSIDE the erasure region -- the same lie, relocated",
            ),
            (
                vec![stmt("Delete \"${TT_SIDECAR_PID_FILE}\"", false)],
                "the announcement deleted altogether, leaving the kept-data stance unstated",
            ),
            (
                vec![
                    stmt(&guard[0], false),
                    stmt(&guard[1], false),
                    stmt(DATA_KEPT_ANNOUNCEMENT, false),
                    stmt(ENDIF, false),
                    stmt(&guard[0], false),
                    stmt(&guard[1], false),
                    stmt(DATA_KEPT_ANNOUNCEMENT, false),
                    stmt(ENDIF, false),
                ],
                "the announcement printed twice, which this rule must not average over",
            ),
        ] {
            assert!(
                kept_announcement_violation(&fixture).is_some(),
                "the kept-data rule no longer rejects {what}. A rule that accepts the defect it \
                 was written for reads as coverage and is worse than no rule."
            );
        }
    }

    /// **Neither scheme key is removed without first probing for the other edition.** This is
    /// `T-24`, compiled — and it was a PRESENT DEFECT, not a risk.
    ///
    /// `Software\Classes\trusttunnel` and `Software\Classes\tt` are registered at runtime by
    /// BOTH editions (`protocol.rs`), into the same per-user hive, under the same two names. Pro's
    /// uninstaller deleted them under no condition at all — not the checkbox, not `$UpdateMode`,
    /// not a presence check — so uninstalling Pro on a machine that still had Light installed
    /// broke Light's `trusttunnel://` and `tt://` handling. 32-ERASURE-EVIDENCE.md (e) measured
    /// both keys present and Light installed, on a real disk, on 2026-09-06.
    ///
    /// WHAT IS ASSERTED, and why it is two things rather than one:
    ///   1. a probe naming the OTHER EDITION precedes both removals — otherwise the gate could be
    ///      keyed to anything at all, including something always true;
    ///   2. the removals are CONDITIONAL — a probe whose answer nothing branches on is a read
    ///      with no effect, which is the shape a refactor leaves behind when it deletes the
    ///      `${If}` and keeps the `ReadRegStr`.
    #[test]
    fn the_uninstaller_spares_the_other_edition_s_scheme_keys() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_POSTUNINSTALL");
        assert!(
            scheme_key_violation(&body).is_none(),
            "{}",
            scheme_key_violation(&body).unwrap_or_default()
        );

        // The arm must still be able to fail. Fixtures, checked against the shared predicate, so
        // it stays red-capable whatever the hook contains today — the 32-FIX-09 discipline.
        for (fixture, what) in [
            (
                vec![
                    SHARED_SCHEME_KEYS[0].to_string(),
                    SHARED_SCHEME_KEYS[1].to_string(),
                ],
                "the unconditional pair as it stood before 32-FIX-16 — the measured T-24 defect",
            ),
            (
                vec![
                    "ReadRegStr $R0 HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TrustTunnel Client Light\" \"DisplayName\"".to_string(),
                    SHARED_SCHEME_KEYS[0].to_string(),
                    SHARED_SCHEME_KEYS[1].to_string(),
                ],
                "a probe whose answer nothing branches on — the removals still run unconditionally",
            ),
            (
                vec![
                    "${If} $R0 == \"\"".to_string(),
                    SHARED_SCHEME_KEYS[0].to_string(),
                    SHARED_SCHEME_KEYS[1].to_string(),
                    "${EndIf}".to_string(),
                ],
                "a condition with no probe behind it — gated on something that never names Light",
            ),
        ] {
            assert!(
                scheme_key_violation(&fixture).is_some(),
                "the T-24 rule no longer rejects {what}. A narrowed rule that accepts everything \
                 reads as coverage while Pro's uninstall keeps disarming Light's URL handler."
            );
        }
        // …and the shape the hook actually ships must be accepted, or the rule is unsatisfiable.
        assert!(
            scheme_key_violation(&[
                format!("ReadRegStr $R0 HKCU \"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{OTHER_EDITION_PRODUCT_NAME}\" \"DisplayName\""),
                "${If} $R0 == \"\"".to_string(),
                SHARED_SCHEME_KEYS[0].to_string(),
                SHARED_SCHEME_KEYS[1].to_string(),
                "${EndIf}".to_string(),
            ])
            .is_none(),
            "the T-24 rule rejects probe-then-gate, which is the only shape that both cleans up \
             after Pro and leaves Light's handler alone"
        );
    }

    /// For a macro body: is either shared scheme key removed without a preceding probe for the
    /// other edition, or without being gated on one?
    fn scheme_key_violation(body: &[String]) -> Option<String> {
        for key in SHARED_SCHEME_KEYS {
            let Some(at) = body.iter().position(|l| l.trim() == key) else {
                continue; // the key is not removed at all, which is also fine
            };
            let before = &body[..at];
            if !before
                .iter()
                .any(|l| l.starts_with("ReadRegStr") && l.contains(OTHER_EDITION_PRODUCT_NAME))
            {
                return Some(format!(
                    "`{key}` runs with no preceding probe naming `{OTHER_EDITION_PRODUCT_NAME}`. \
                     Both editions register those two schemes into the same per-user hive, so \
                     this line disarms the other edition's URL handler on a machine that still \
                     has it (T-24, measured live in 32-ERASURE-EVIDENCE.md (e))."
                ));
            }
            if !before.iter().any(|l| l.starts_with("${If}")) {
                return Some(format!(
                    "`{key}` is not gated on anything: a probe runs before it, but nothing \
                     branches on the answer, so the key is still removed unconditionally. A read \
                     with no effect is what a refactor leaves behind when it drops the `${{If}}`."
                ));
            }
        }
        None
    }

    /// **The per-user folders the erasure removes are composed from the RECORDED root, never from
    /// the elevated process's idea of «the current user».**
    ///
    /// The template's own erasure does `SetShellVarContext current` and removes
    /// `$LOCALAPPDATA\${BUNDLEID}`. Under `perMachine` that resolves the profile of whichever
    /// administrator approved the elevation prompt, which under over-the-shoulder UAC need not be
    /// the person uninstalling — D-08. On a real Windows install all three identities coincide and
    /// the template's line happens to hit the right folder; that is a property of that machine,
    /// not of the code, and 32-ERASURE-EVIDENCE.md (c) says so in as many words.
    ///
    /// So this region composes the bundle folder from the parent of the folder the ladder already
    /// validated — a path the application itself recorded and rung 7 checked against the
    /// uninstalling profile — and names `$LOCALAPPDATA` nowhere at all.
    #[test]
    fn the_erasure_composes_the_per_user_folders_from_the_resolved_root() {
        let region: Vec<String> = hook_lines_by_region(HOOK_NSH)
            .into_iter()
            .filter(|(_, inside)| *inside)
            .map(|(l, _)| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with(';'))
            .collect();

        assert!(
            region
                .iter()
                .any(|l| is_removal_statement(l) && l.contains(BUNDLE_ID_REF)),
            "the erasure region removes no `{BUNDLE_ID_REF}` folder. The framework creates one in \
             the user's profile on every start, so a «Удалить полностью» that leaves it behind \
             leaves a trace the owner asked to be gone."
        );
        for l in &region {
            assert!(
                untrusted_per_user_composition(l).is_none(),
                "{}",
                untrusted_per_user_composition(l).unwrap_or_default()
            );
        }

        // The arm has to be able to fail, and it has to keep letting the ONE legitimate mention
        // through — rung 5 refuses a note that names the folder itself, which is a comparison and
        // not a composition. A rule that could not tell those apart would have to be deleted the
        // first time it fired, and a deleted rule guards nothing.
        for (fixture, what) in [
            (
                "RMDir /r \"$LOCALAPPDATA\\${BUNDLEID}\"",
                "a removal composed from the elevated process's idea of «the current user»",
            ),
            (
                "StrCpy $R6 \"$LOCALAPPDATA\"",
                "the same path copied into a register first, which is the same mistake one line \
                 later",
            ),
        ] {
            assert!(
                untrusted_per_user_composition(fixture).is_some(),
                "the D-08 composition rule no longer rejects {what}: `{fixture}`"
            );
        }
        assert!(
            untrusted_per_user_composition("${OrIf} $R8 == \"$LOCALAPPDATA\"").is_none(),
            "the D-08 composition rule rejects rung 5's REFUSAL of a note naming the profile root \
             itself — that is a comparison, and refusing it is what the rung is for"
        );
    }

    /// Does this region line COMPOSE a path from the elevated process's idea of «the current
    /// user», rather than merely comparing against it?
    ///
    /// The distinction is the whole rule. Rung 5 legitimately names `$LOCALAPPDATA` in an
    /// `${OrIf}` to REFUSE a note pointing at the profile root itself. Everything else — a
    /// removal, a `StrCpy`, a printed path — is the D-08 mistake: under UAC that variable is the
    /// elevating administrator's profile, not the uninstalling person's.
    fn untrusted_per_user_composition(line: &str) -> Option<String> {
        let l = line.trim();
        if !l.contains(UNTRUSTED_PER_USER_VAR) {
            return None;
        }
        if l.starts_with("${If}") || l.starts_with("${OrIf}") || l.starts_with("${AndIf}") {
            return None; // a comparison, i.e. a refusal — see rung 5
        }
        Some(format!(
            "the erasure region composes a path from `{UNTRUSTED_PER_USER_VAR}`, which in an \
             elevated uninstaller resolves the ELEVATING administrator's profile rather than the \
             uninstalling person's (D-08). The folder must be composed from the root the ladder \
             validated: {l}"
        ))
    }

    // ── The pre-install hook's body, pinned from Rust ─────────────────────────────────────
    //
    // Phase 32 added `NSIS_HOOK_PREINSTALL`: it discovers the LEGACY install from the registry
    // and, in this plan, reports what it would remove without removing anything. The four tests
    // below are what keep it that way. They matter more than an ordinary contract test for one
    // reason: when plan 32-06 turns the removal live, this macro deletes files on a real user's
    // disk, one directory away from their SSH credentials and their browser profile — with no
    // rehearsal machine anywhere to catch a mistake first.
    //
    // `include_str!` binds every assertion at COMPILE time, so editing the `.nsh` alone cannot
    // leave any of them green.

    /// The installer hook file, bound at COMPILE time. Editing the `.nsh` rebuilds the test
    /// binary, so no assertion below can stay green while the file it is about moves underneath
    /// it. The two older tests spell their own `include_str!` inline; both forms read the same
    /// file, and this one exists so the four pre-install arms cannot drift onto a different path.
    const HOOK_NSH: &str = include_str!("../nsis/installer-hooks.nsh");

    /// The call-site spelling of the survivor-marker write, in ONE place because four rules read
    /// it: the two arms added by 32-FIX-10, the user-data guard whose reach they extend, and the
    /// stale-marker arm that has to prove the pre-install macro contains no such removal.
    const MARKER_WRITE: &str = "!insertmacro TT_MARK_SURVIVOR";

    /// The reference form of the survivor marker's path, as every statement that names it spells
    /// it. Never the expanded path: the define is what keeps the basename in one place, and a rule
    /// that matched the expansion would go quiet the moment the define did its job.
    const MARKER_PATH_REF: &str = "${TT_LEGACY_SURVIVOR_MARKER}";

    /// The flag `TT_MARK_SURVIVOR` raises when it writes, and `NSIS_HOOK_POSTINSTALL` reads when
    /// deciding whether a marker on disk belongs to THIS install or to an earlier one.
    const MARKER_SEEN_FLAG: &str = "$TT_LEGACY_SURVIVOR_SEEN";

    /// Every artifact the app persists into its data root.
    ///
    /// Two readers, deliberately: the uninstall hook must not delete any of these during what
    /// the user experiences as an update, and the pre-install hook must not name any of them in
    /// its removal enumeration. A name added here is enforced by both guards at once, and the
    /// shell gate (`remediation-hygiene.sh` rule 12) carries the same list as their backstop.
    ///
    /// Every name is read off the source that owns it, never recalled:
    /// `commands/manifest.rs` (`configs.json` + the per-server `.toml` files),
    /// `commands/ssh_commands.rs:741`, `ssh/mod.rs:291`, `routing_rules.rs:128,280`,
    /// `geodata.rs:57,61,82`, `commands/history.rs:15`, `app_settings.rs:121`,
    /// `dns_guard.rs:34`, `diagnostics.rs:73`, `net_egress.rs:83` (`runtime`),
    /// `logging.rs:181,221` (`logs`, `.enable_logs`), `lib.rs:35,98`
    /// (`.start_minimized`, `tray_hint_shown`), and `webview_data`, which Tauri owns.
    ///
    /// THE PER-SERVER `.toml` FILES CANNOT BE ENUMERATED AT ALL — the user names them. That is
    /// not a gap in this list; it is the argument for the shape of the thing this list guards.
    /// A removal built as a deny-list of known data names could never be safe, because the most
    /// numerous data files here have no known names. The enumeration is therefore a closed
    /// allow-list of binaries, and this const is the check on that list rather than a substitute
    /// for it.
    /// A THIRD reader since 32-FIX-11, and the reason this constant is `pub(crate)`:
    /// `legacy_sweep` asserts that its closed list of legacy binaries contains no name from this
    /// list, over the WHOLE list rather than over samples. It reads this one rather than keeping
    /// its own — a name added here is then enforced by three guards at once instead of by two and
    /// a copy that somebody forgot.
    pub(crate) const USER_DATA: &[&str] = &[
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
        "tray_hint_shown",
        ".start_minimized",
        ".enable_logs",
    ];

    /// The executable statements inside one hook macro, prose removed.
    ///
    /// Scoped to a SINGLE macro on purpose. A scan over the whole file would be satisfied — or
    /// violated — by the unrelated uninstall macros, which legitimately delete things; a rule
    /// that cannot say which macro it is judging is not evidence about either.
    ///
    /// Comment lines are dropped for the reason `the_uninstaller_never_deletes_user_data`
    /// already records: these hooks document BY NAME exactly what they deliberately do not
    /// remove, so a raw scan flags the hook's own explanation as the violation it explains.
    ///
    /// Panics when the macro is not found. That is the point — a scan that lost its subject
    /// must report an inability to measure, never an absence of violations.
    ///
    /// `pub(crate)` since 32-FIX-11 so the leftover report's own contract can read the SAME
    /// extraction — including this panic. A second extractor beside it would be a second opinion
    /// about where the macro ends, and the two could disagree without anything saying so.
    pub(crate) fn hook_macro_statements(hook: &str, macro_name: &str) -> Vec<String> {
        let opener = format!("!macro {macro_name}");
        let mut found = false;
        let mut inside = false;
        let mut out = Vec::new();
        for line in hook.lines() {
            let l = line.trim();
            if !inside && l == opener {
                found = true;
                inside = true;
                continue;
            }
            if inside && l == "!macroend" {
                inside = false;
                continue;
            }
            if !inside || l.is_empty() || l.starts_with(';') {
                continue;
            }
            out.push(l.to_string());
        }
        assert!(
            found,
            "CANNOT MEASURE: `!macro {macro_name}` is not in installer-hooks.nsh. The rule that \
             called this has lost its subject — it was renamed or deleted — so it can say nothing \
             about violations. Reporting PASS here would be a green tick over nothing."
        );
        out
    }

    /// The backslash-separated segments of the first double-quoted argument on an NSIS line,
    /// lower-cased for the case-insensitive comparison Windows paths require.
    ///
    /// WHY SEGMENTS AND NOT A SUBSTRING SEARCH, which is what the uninstall arm uses. The
    /// pre-install enumeration legitimately names `vcruntime140.dll` — a Microsoft runtime DLL
    /// this package no longer ships but every legacy folder still holds (owner decision
    /// `drop-now`, 2026-09-06) — whose filename CONTAINS the data-folder name `runtime`. A
    /// substring predicate
    /// would flag that correct line as a data deletion, permanently and falsely, and the usual
    /// repair for a rule that cries wolf is to delete the rule. The uninstall arm keeps its
    /// wider substring form because every subject it scans is a data filename, so there is
    /// nothing there for it to false-flag.
    fn quoted_path_segments(line: &str) -> Vec<String> {
        let inner = line.split('"').nth(1).unwrap_or(line);
        inner
            .split('\\')
            .map(|s| s.trim().to_ascii_lowercase())
            .collect()
    }

    /// The artifact ONE pre-install line is about, in a single normalised spelling — or `None`
    /// when the line is about no artifact at all.
    ///
    /// The whole point is that four line shapes name the SAME artifact four different ways, and a
    /// rule that cannot line them up cannot tell «this file was removed and its outcome reported»
    /// from «this file was removed and nobody looked»:
    ///
    /// | Shape | Example | Subject |
    /// |---|---|---|
    /// | announcement / outcome report | `DetailPrint "$(legacyRemoving) $R9\wintun.dll"` | `$R9\wintun.dll` |
    /// | file removal | `Delete "$R9\wintun.dll"` | `$R9\wintun.dll` |
    /// | file re-check | `${If} ${FileExists} "$R9\wintun.dll"` | `$R9\wintun.dll` |
    /// | registry removal / re-check | `DeleteRegKey HKCU "${UNINSTKEY}"` | `HKCU\${UNINSTKEY}` |
    ///
    /// THE REGISTRY CASE IS THE ONE THAT NEEDS THE REJOINING. NSIS spells a key as a bare root
    /// keyword followed by a quoted path, while the progress line the user reads spells it as one
    /// string, `HKCU\...`. Comparing the quoted parts alone would silently treat the announcement
    /// and the deletion as two unrelated artifacts, and the arm below would then pass while
    /// reporting nothing about the only removal that is not a file.
    ///
    /// A `DetailPrint` that carries neither removal key — the «found a previous install» header,
    /// the «your data stays» footer — yields `None` rather than a subject. Those lines are prose
    /// about the operation, not claims about an artifact, and counting them would inflate every
    /// set this arm compares.
    fn pre_install_subject(line: &str) -> Option<String> {
        let quoted = line.split('"').nth(1)?;

        // Checked FIRST, because a printed line can contain a registry root INSIDE its quotes and
        // must be read as the printed string, not re-parsed as an NSIS registry operation.
        if line.starts_with("DetailPrint") {
            let target = quoted
                .strip_prefix("$(legacyRemoving)")
                .or_else(|| quoted.strip_prefix("$(legacyRemoveFailed)"))?;
            return Some(target.trim().to_string());
        }

        for root in ["HKCU", "HKLM", "HKCR", "HKU", "SHCTX"] {
            if line.split_whitespace().any(|t| t == root) {
                return Some(format!("{root}\\{quoted}"));
            }
        }

        Some(quoted.to_string())
    }

    /// Whether an NSIS removal defers to the next restart.
    ///
    /// `/REBOOTOK` hands the path to the session manager's pending-rename list, which the kernel
    /// executes at the next boot. Matched case-insensitively as a whole token, never as a
    /// substring: a filename that happened to contain the word would otherwise pass for a
    /// scheduled deletion.
    fn is_deferred_removal(line: &str) -> bool {
        line.starts_with("Delete")
            && line
                .split_whitespace()
                .any(|t| t.eq_ignore_ascii_case("/REBOOTOK"))
    }

    /// Whether a subject `pre_install_subject` produced names a REGISTRY KEY rather than a file.
    ///
    /// Two rules below have to exclude it and for two different reasons that both stand alone:
    /// `DeleteRegKey` has no deferred form, so a registry key cannot be scheduled for the next
    /// restart; and a registry key is not a path on disk, so writing one into the survivor marker
    /// would hand the application something it cannot act on.
    fn is_registry_subject(subject: &str) -> bool {
        ["HKCU\\", "HKLM\\", "HKCR\\", "HKU\\", "SHCTX\\"]
            .iter()
            .any(|root| subject.starts_with(root))
    }

    /// One artifact's group inside the pre-install enumeration: where it is announced, where its
    /// own outcome report sits, and where the NEXT artifact's announcement begins.
    ///
    /// THE INTERVAL `(report, next_announce)` IS THE ONLY HANDLE A POSITIONAL RULE HAS ON «INSIDE
    /// ITS OWN FAILURE BRANCH». The statement list is flat — `${If}` and `${EndIf}` are ordinary
    /// statements to this scan, not a tree — so no rule here can literally see nesting. What it
    /// CAN see is that the outcome report is printed only inside the failure branch, and that the
    /// next artifact's announcement is outside it: anything strictly between the two belongs to
    /// this artifact's branch tail and to nothing else. That is weaker than parsing the
    /// conditional and it is stated as such rather than implied.
    struct PreInstallGroup {
        subject: String,
        /// `None` when the artifact is announced with no outcome report of its own. The
        /// set-equality arm reports that case in its own words; the rules below only need to know
        /// that there is no branch to look inside.
        report: Option<usize>,
        next_announce: usize,
    }

    /// The announced artifacts of `NSIS_HOOK_PREINSTALL`, in order, each with the bounds of its
    /// own failure branch. Built from `pre_install_subject`, so subjects line up with the existing
    /// set equality in exactly the same normalised spelling.
    fn pre_install_groups(body: &[String]) -> Vec<PreInstallGroup> {
        let announced: Vec<(usize, String)> = body
            .iter()
            .enumerate()
            .filter(|(_, l)| l.starts_with("DetailPrint") && l.contains("$(legacyRemoving)"))
            .filter_map(|(i, l)| pre_install_subject(l).map(|s| (i, s)))
            .collect();

        announced
            .iter()
            .enumerate()
            .map(|(n, (i, subject))| {
                let next_announce = announced.get(n + 1).map(|(j, _)| *j).unwrap_or(body.len());
                let report = (*i..next_announce).find(|k| {
                    let l = &body[*k];
                    l.starts_with("DetailPrint")
                        && l.contains("$(legacyRemoveFailed)")
                        && pre_install_subject(l).as_deref() == Some(subject.as_str())
                });
                PreInstallGroup {
                    subject: subject.clone(),
                    report,
                    next_announce,
                }
            })
            .collect()
    }

    /// **The pre-install hook never removes a directory recursively.**
    ///
    /// Aimed at the discovered legacy path, `RMDir /r` destroys the credentials, the known
    /// hosts, the routing rules, the geodata and the browser profile in one statement, with no
    /// second chance and no name written down that anyone could review. Under D-05 that path is
    /// the user's data root on a default install: the binaries are leaving the folder and the
    /// data is staying, which is exactly why the removal has to name files one at a time.
    ///
    /// This arm also catches the shape the name-based arm below cannot: a recursive removal
    /// mentions none of the files it takes.
    #[test]
    fn the_pre_install_hook_never_removes_a_directory_recursively() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        for l in &body {
            let recursive = l.starts_with("RMDir")
                && l.split_whitespace()
                    .any(|t| t.eq_ignore_ascii_case("/r"));
            assert!(
                !recursive,
                "the pre-install hook removes a directory recursively. Aimed at the discovered \
                 legacy path this takes the user's servers, saved passwords, known hosts, routing \
                 rules and browser profile in one line: {l}"
            );
        }
    }

    /// Whether an NSIS statement launches another program at all.
    ///
    /// Three doors, and all three have to be watched together: the built-in `Exec*` family, the
    /// `nsExec::` plugin the other hooks use, and `System::Call`, which is `ShellExecute` by
    /// another name and would otherwise walk straight past a rule that only knew the first two.
    fn executes_a_program(line: &str) -> bool {
        let first = line.split_whitespace().next().unwrap_or_default();
        first.starts_with("Exec")            // Exec, ExecWait, ExecShell(Wait)
            || first.starts_with("nsExec::") // the plugin the other hooks use
            || first.starts_with("System::Call") // FFI: ShellExecute by another name
    }

    /// The ONE invocation shape the pre-install hook is permitted (owner decision `route-b`,
    /// 2026-09-06): a process termination whose target is a REGISTER holding the validated
    /// process id — never a path, never a filename, never an image name.
    ///
    /// Every clause below is load-bearing, and each closes a different way the permission could
    /// be widened into uselessness:
    ///
    /// | Clause | Rejects |
    /// |---|---|
    /// | the command is single-quoted and starts with `taskkill` | `ExecWait '"$R9\uninstall.exe"'` — the whole subject of D-06 |
    /// | `/PID` present | `taskkill /F /IM trusttunnel_client.exe` — the image-name kill the owner rejected by name, because that filename is the Light edition's too |
    /// | the LAST token is a bare NSIS register | `taskkill /F /PID 1234` (a literal nobody validated) and any path smuggled in as the target |
    /// | plain `nsExec::Exec`, not its logging or capturing variants | both of those put the child's LOCALIZED console bytes somewhere a person reads: the capturing form onto the stack, the logging form straight into the details window, where code page 866 output is rendered as 1251 and the owner sees mojibake (G-32-4) |
    ///
    /// 32-FIX-16 tightened the last clause from «not the capturing form» to «the plain form
    /// only». Until then the logging form was the shape this project recommended, and it is what
    /// printed two lines of unreadable characters at the owner during a real uninstall.
    fn is_validated_pid_termination(line: &str) -> bool {
        let Some(cmd) = line.split('\'').nth(1) else {
            return false;
        };
        if !line.trim_start().starts_with("nsExec::Exec '") {
            return false;
        }
        let mut tokens = cmd.split_whitespace();
        if tokens.next() != Some("taskkill") {
            return false;
        }
        let rest: Vec<&str> = tokens.collect();
        if !rest.iter().any(|t| t.eq_ignore_ascii_case("/PID")) {
            return false;
        }
        // A bare register: `$R0`..`$R9` or `$0`..`$9`. Anything with a separator, a quote or a
        // dot in it is a path or a literal, and is not a process id this hook validated.
        let Some(target) = rest.last() else {
            return false;
        };
        let is_register = target.starts_with('$')
            && target.len() >= 2
            && target.len() <= 3
            && target[1..]
                .chars()
                .all(|c| c.is_ascii_digit() || c == 'R' || c == 'r');
        is_register
    }

    /// **The pre-install hook invokes nothing but a termination aimed at a validated process id.**
    /// This is D-06, compiled.
    ///
    /// The uninstall.exe sitting on existing users' disks belongs to the OLD build and cannot be
    /// patched. On every install predating the 30.1 fix it deletes `ssh_credentials.json`,
    /// `known_hosts.json`, `routing_rules.json` and the rest unconditionally — and under D-05
    /// that folder is the data root the new install is about to keep using. Running it would
    /// destroy the data in the very act of preserving it.
    ///
    /// The assertion pins the INVOCATION SHAPE, not the uninstaller's filename, and the
    /// difference is load-bearing: `uninstall.exe` legitimately appears in the removal
    /// enumeration, so a name-based rule would collide with the correct line and have to be
    /// weakened until it measured nothing.
    ///
    /// # NARROWED ON 2026-09-06, ON A RECORDED INSTRUCTION
    ///
    /// **What changed.** The rule used to read «executes nothing». It now reads «never invokes the
    /// legacy uninstaller, and invokes nothing whose target is not a literal process id read from
    /// this edition's own pid file» — one permitted shape, defined in
    /// `is_validated_pid_termination` above, and everything else still refused.
    ///
    /// **Why.** The VPN core was terminated by NOTHING in the installer, so it held its own image
    /// and (through a run-time `LoadLibrary`) `wintun.dll` mapped while the hook tried to delete
    /// them — two of the three binaries that survived a real install
    /// (G-32-2). Stopping it needs a kill, and killing the RIGHT one needs a process id, because
    /// both editions ship a binary named `trusttunnel_client`: an image-name kill would end the
    /// co-installed Light edition's live VPN session. The plugin bundled with the pinned bundler
    /// exports no kill-by-pid entry point (its whole export table is `FindProcess`,
    /// `FindProcessCurrentUser`, `KillProcess`, `KillProcessCurrentUser`, `RunAsUser`,
    /// `SemverCompare`, `StrReplace`), so a command invocation is the only remaining route — and
    /// the letter of the old rule forbade every invocation, including this one.
    ///
    /// **Why the SUBJECT is unchanged.** D-06's subject is that the legacy uninstaller is never
    /// run. It still cannot be: an invocation naming a path is not a pid termination, so the arm
    /// below rejects it, and the second assertion proves that against the exact shape rather than
    /// leaving it to be believed. Nor can the rejected image-name kill sneak back as a command
    /// line — `/IM` carries no `/PID` and its target is a filename, not a register.
    ///
    /// **Who authorised it.** The owner, on 2026-09-06, answering plan 32-FIX-09's blocking
    /// decision: «По номеру процесса» — option `route-b`. He was shown the cost of narrowing a
    /// compiled safety rule beside a destructive step and accepted it; he rejected the image-name
    /// route by name. Recorded in `32-FIX-09-SUMMARY.md`.
    #[test]
    fn the_pre_install_hook_never_executes_another_program() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        for l in &body {
            assert!(
                !executes_a_program(l) || is_validated_pid_termination(l),
                "the pre-install hook makes an invocation that is not a termination aimed at a \
                 validated process id. D-06's subject stands: the legacy uninstaller is the OLD \
                 build's, cannot be patched, and deletes the credentials, known hosts and routing \
                 rules that folder now holds as the data root — running it would destroy the data \
                 in the act of preserving it. The one shape permitted here (owner decision \
                 `route-b`, 2026-09-06) is `nsExec::Exec 'taskkill /F /PID $Rn'`, whose \
                 target is a register this hook validated as decimal digits: {l}"
            );
        }

        // THE RULE MUST STILL FAIL ON ITS ORIGINAL SUBJECT, AND THAT IS ASSERTED HERE RATHER THAN
        // TRUSTED. A narrowed safety rule that can no longer reject the thing it was written to
        // reject is worse than no rule: it reads as coverage. These fixtures are checked against
        // the predicate directly, so the arm stays falsifiable whatever the hook file happens to
        // contain today.
        for forbidden in [
            // The subject of D-06 itself, in each of the three shapes that could run it.
            "ExecWait '\"$R9\\uninstall.exe\" /S'",
            "Exec '\"$R9\\uninstall.exe\"'",
            "nsExec::Exec '\"$R9\\uninstall.exe\" /S'",
            "System::Call 'shell32::ShellExecuteW(i 0, t \"open\", t \"$R9\\uninstall.exe\")'",
            // The image-name kill the owner rejected by name: it would end the co-installed Light
            // edition's live VPN session, because that filename belongs to both editions.
            "nsExec::Exec 'taskkill /F /IM trusttunnel_client.exe'",
            // A process id nobody validated, and a target that is a path rather than a register.
            "nsExec::Exec 'taskkill /F /PID 1234'",
            "nsExec::Exec 'taskkill /F /PID $R9\\.sidecar-pro.pid'",
            // Capturing the tool's output — localized and code-page dependent on this platform.
            "nsExec::ExecToStack 'taskkill /F /PID $R0'",
            // And, since 32-FIX-16, the LOGGING form too: it copies the child's console bytes
            // into the details window, where a Russian console's code page 866 is rendered as
            // 1251 and the owner reads mojibake (G-32-4). Correct kill, unreadable log.
            "nsExec::ExecToLog 'taskkill /F /PID $R0'",
        ] {
            assert!(
                executes_a_program(forbidden) && !is_validated_pid_termination(forbidden),
                "the narrowed D-06 rule no longer rejects `{forbidden}`. Narrowing a safety rule \
                 until it accepts everything is the failure this assertion exists to catch — the \
                 rule would keep passing while the legacy uninstaller ran and destroyed the data \
                 root it was written to protect."
            );
        }
        assert!(
            is_validated_pid_termination("nsExec::Exec 'taskkill /F /PID $R0'"),
            "the narrowed D-06 rule rejects the ONE shape the owner authorised, so the hook cannot \
             stop the VPN core at all and G-32-2 reopens."
        );
    }

    /// **The pre-install hook stops the VPN core before it removes anything.**
    ///
    /// THE OTHER HALF OF G-32-2, AND THE HALF NOTHING IN THE INSTALLER EVER TOUCHED. Its sibling
    /// `the_pre_install_hook_closes_the_app_before_it_removes_anything` covers the main
    /// executable. The VPN core is a SECOND process, and the installer terminated it nowhere:
    /// `CheckIfAppIsRunning` (`utils.nsh:22`) takes one image name and is invoked only with
    /// `${MAINBINARYNAME}.exe`, and the string `trusttunnel_client.exe` occurs nowhere in the
    /// template or in `utils.nsh`. The only thing that ever stopped the core is the Windows Job
    /// Object (`job_object.rs:4`, KILL_ON_JOB_CLOSE), which fires AFTER the parent dies —
    /// asynchronously, after this hook has already finished, and with a documented degraded path
    /// at `job_object.rs:143-149`.
    ///
    /// So reordering alone would have fixed at most one of the three survivors. The core holds its
    /// own image mapped and, through a run-time `LoadLibrary`, holds `wintun.dll` too — neither
    /// binary IMPORTS wintun, which is why the core alone pins it. Those are the other two.
    ///
    /// WHAT IT MEASURES, in two parts, because either alone is satisfiable by the wrong thing:
    ///   1. a termination aimed at a VALIDATED PROCESS ID precedes the first `Delete` — the kill;
    ///   2. the core's image name appears in a process-level statement before that same `Delete` —
    ///      the wait, and the thing that aims this rule at the CORE rather than at some other pid.
    ///
    /// The image name comes from `SIDECAR_IMAGE_NAME` and is never retyped, so renaming the
    /// constant reddens this rule instead of silently un-aiming it. Part 2 is restricted to
    /// process-level statements on purpose: the enumeration below legitimately prints and deletes
    /// a path ending in that same filename, and a rule that counted those would pass over a hook
    /// that terminates nothing at all.
    #[test]
    fn the_pre_install_hook_stops_the_vpn_core_before_it_removes_anything() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");
        let core = crate::commands::vpn::SIDECAR_IMAGE_NAME;

        let Some(removal) = body
            .iter()
            .position(|l| l.split_whitespace().next() == Some("Delete"))
        else {
            panic!(
                "CANNOT MEASURE: `NSIS_HOOK_PREINSTALL` contains no `Delete` statement at all. \
                 The enumeration is the whole point of the macro, so zero removals means this \
                 rule lost its subject — reporting PASS here would be a green tick over nothing."
            );
        };

        let kill = body.iter().position(|l| is_validated_pid_termination(l));
        let waits_on_core = body.iter().position(|l| {
            let first = l.split_whitespace().next().unwrap_or_default();
            let process_level = first.starts_with("nsis_tauri_utils::")
                || first.starts_with("nsExec::")
                || first.starts_with("Exec");
            process_level && l.contains(core)
        });

        let survivors = format!(
            "{core} and wintun.dll survive on the user's disk when this does not run — the core \
             holds its own image mapped, and it holds wintun.dll through a run-time LoadLibrary \
             (neither binary imports it). NSIS `Delete` on a mapped image fails SILENTLY, so the \
             removal is a no-op nothing can notice, and 25 MB of the previous install stay beside \
             the user's credential store (G-32-2)."
        );

        let Some(kill) = kill else {
            panic!(
                "the pre-install hook NEVER STOPS THE VPN CORE: no termination aimed at a \
                 validated process id appears in the macro, while statement {removal} removes a \
                 file.\n  {survivors}\n  removal [{removal}]: {}",
                body[removal]
            );
        };
        let Some(waits) = waits_on_core else {
            panic!(
                "the pre-install hook names {core} in no process-level statement, so nothing here \
                 is aimed at the VPN CORE — a pid termination alone could be aimed at anything, \
                 and nothing waits for the core's images to be unmapped.\n  {survivors}"
            );
        };

        assert!(
            kill < removal && waits < removal,
            "the pre-install hook removes before it stops the VPN core. Core termination: \
             statement {kill}. Wait on {core}: statement {waits}. First `Delete`: statement \
             {removal}.\n  {survivors}\n  termination [{kill}]: {}\n  wait        [{waits}]: {}\n  \
             removal     [{removal}]: {}",
            body[kill],
            body[waits],
            body[removal]
        );
    }

    /// **The VPN core is stopped even when the registry knows nothing about a previous install.**
    ///
    /// G-32-11, AND THE HALF OF IT NOBODY HAD WRITTEN DOWN. The sibling rule above proves the
    /// core-stop step precedes the removals. It does NOT prove the step RUNS: the block it measures
    /// sits inside `${If} $R9 != ""`, and `$R9` is the legacy install discovered from HKCU. That
    /// probe is deliberately blind to HKLM — it exists to catch the pre-32 currentUser installs the
    /// template cannot see — so on a machine whose previous install was ALREADY the perMachine
    /// build there is no HKCU record, `$R9` stays empty, and the whole core-stop step stands down.
    /// In silence: the announcement is inside the same branch, so nothing is printed either.
    ///
    /// That is a real Windows install on build `h2vn6t`. His install log closes the program, carries
    /// no core line of any kind, and stops at `Extract: trusttunnel.exe` on the NSIS retry dialog;
    /// the app's own log next launch shows the pid file had held a dead process id. Two mechanisms
    /// fit that evidence and the log cannot tell them apart, which is why the fix closes both.
    ///
    /// WHAT IT MEASURES: a termination aimed at a validated process id, a read of THIS
    /// installation's pid file, and a process-level statement naming the core image — all three
    /// before the FIRST statement that mentions `$R9`. Position rather than nesting is the only
    /// handle a flat statement list gives, and here it is the right one: everything from the first
    /// mention of `$R9` onwards is downstream of a probe that legitimately comes back empty.
    ///
    /// The image name comes from `SIDECAR_IMAGE_NAME` and the pid path from the hook's own
    /// `${TT_SIDECAR_PID_FILE}` define, so neither can be retyped into a spelling nothing keeps in
    /// step with Rust — rule 13 of `remediation-hygiene.sh` guards the second from the other side.
    #[test]
    fn the_pre_install_hook_stops_the_vpn_core_before_it_knows_of_any_legacy_install() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");
        let core = crate::commands::vpn::SIDECAR_IMAGE_NAME;

        let Some(first_r9) = body.iter().position(|l| l.contains("$R9")) else {
            panic!(
                "CANNOT MEASURE: `NSIS_HOOK_PREINSTALL` never mentions $R9, so the legacy probe \
                 this rule is positioned against is gone. The rule would pass over anything."
            );
        };

        let kill = body
            .iter()
            .position(|l| is_validated_pid_termination(l.as_str()));
        let read = body.iter().position(|l| {
            (l.starts_with("IfFileExists") || l.starts_with("FileOpen"))
                && l.contains("${TT_SIDECAR_PID_FILE}")
        });
        let waits = body.iter().position(|l| {
            l.split_whitespace()
                .next()
                .unwrap_or_default()
                .starts_with("nsis_tauri_utils::")
                && l.contains(core)
        });

        let why = format!(
            "on a machine whose previous install was already the perMachine build there is NO \
             HKCU record, so every step keyed on $R9 stands down — including the one that stops \
             {core}. The core then still holds its own image, and wintun.dll through a run-time \
             LoadLibrary, while the script overwrites the folder: the installer shows the \
             file-in-use retry dialog and its log says nothing about why (G-32-11)."
        );

        for (what, at) in [
            ("termination aimed at a validated process id", kill),
            ("read of ${TT_SIDECAR_PID_FILE}", read),
            ("process-level statement naming the core image", waits),
        ] {
            let Some(at) = at else {
                panic!(
                    "the pre-install hook has NO unconditional core-stop step: no {what} appears \
                     anywhere in the macro.\n  {why}"
                );
            };
            assert!(
                at < first_r9,
                "the pre-install hook's only {what} is statement {at}, which is at or after the \
                 first mention of $R9 (statement {first_r9}) and is therefore reachable only when \
                 a LEGACY install was discovered.\n  {why}\n  step   [{at}]: {}\n  first \
                 $R9 [{first_r9}]: {}",
                body[at],
                body[first_r9]
            );
        }
    }

    /// **No path through the unconditional core-stop step is silent.**
    ///
    /// THE INVERSE OF THE RULE THE BLOCK WAS ALREADY WRITTEN TO OBEY. The core-stop announcement
    /// is printed only when a pid candidate survives validation, on the correct principle that a
    /// hook must not claim to be stopping the core while doing nothing. The hole that principle
    /// leaves is the one that made G-32-11 undiagnosable: a step that says nothing reads exactly
    /// like a step that never ran, and the real log — which is complete up to the retry dialog
    /// — cannot distinguish «no pid file», «a pid file naming a dead process» and «this code was
    /// never reached». All three were live hypotheses for a day.
    ///
    /// WHAT IT MEASURES, over the region from the pid read to the label every path leaves by:
    ///   1. every `Goto <done>` is IMMEDIATELY preceded by a `DetailPrint` — no branch escapes
    ///      without a sentence;
    ///   2. the statement immediately before the `<done>` label is a `DetailPrint` — the
    ///      fall-through path is covered too, and it is the one a new branch is most likely to
    ///      join by accident;
    ///   3. the branch the pid-file existence test jumps to when the file is ABSENT opens with a
    ///      `DetailPrint` — the real-world case, and the one the old block was silent about;
    ///   4. at least four DISTINCT `$(name)` references are printed in the region, so a block
    ///      that printed one sentence on every path could not satisfy the first three arms
    ///      vacuously.
    ///
    /// The label names are read from the file where it is possible — the absent-branch target is
    /// taken from the `IfFileExists` line itself — and named only where it is not. A rename of the
    /// terminator reports CANNOT MEASURE rather than passing over a region it can no longer find.
    #[test]
    fn no_path_through_the_pre_install_core_stop_is_silent() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");
        const DONE: &str = "tt_preinstall_target_core_done";

        let Some(start) = body.iter().position(|l| {
            l.starts_with("IfFileExists") && l.contains("${TT_SIDECAR_PID_FILE}")
        }) else {
            panic!(
                "CANNOT MEASURE: the pre-install hook never tests for ${{TT_SIDECAR_PID_FILE}}, so \
                 the unconditional core-stop region this rule is about does not exist. Its \
                 absence is a failure of the rule above, and a PASS here would paper over it."
            );
        };
        let Some(end) = body.iter().position(|l| l.trim() == format!("{DONE}:")) else {
            panic!(
                "CANNOT MEASURE: the core-stop region has no `{DONE}:` terminator. It was renamed \
                 or removed, so this rule cannot see the branches it exists to check."
            );
        };
        assert!(
            end > start,
            "CANNOT MEASURE: `{DONE}:` (statement {end}) precedes the pid read (statement \
             {start}), so the region between them is not the core-stop step."
        );

        let region = &body[start..=end];
        let is_print = |s: &String| s.starts_with("DetailPrint");
        let leaves = format!("Goto {DONE}");

        for (i, l) in region.iter().enumerate() {
            if l.trim() != leaves {
                continue;
            }
            let previous = i.checked_sub(1).map(|p| &region[p]);
            assert!(
                previous.is_some_and(is_print),
                "a path out of the core-stop step prints nothing: statement {i} of the region is \
                 `{l}` and the statement before it is `{}`. Silence here reads identically to a \
                 step that never ran, which is the whole of G-32-11 — the install log \
                 carries no core line at all and three different explanations fit it.",
                previous.map(String::as_str).unwrap_or("<the region's first statement>")
            );
        }

        let before_done = region
            .len()
            .checked_sub(2)
            .map(|p| &region[p])
            .expect("the region holds the read and the terminator, so it has at least 2 statements");
        assert!(
            is_print(before_done),
            "the fall-through path into `{DONE}:` prints nothing — the statement before the label \
             is `{before_done}`. A branch that reaches the terminator without a Goto says nothing \
             at all, and that is the shape G-32-11 was made of."
        );

        let absent_label = body[start]
            .split_whitespace()
            .last()
            .expect("an IfFileExists statement has tokens")
            .to_string();
        let Some(absent_at) = region
            .iter()
            .position(|l| l.trim() == format!("{absent_label}:"))
        else {
            panic!(
                "CANNOT MEASURE: the pid-file test jumps to `{absent_label}` when the file is \
                 absent, and no such label is declared inside the region. The branch cannot be \
                 checked, and it is the real-world case."
            );
        };
        assert!(
            region.get(absent_at + 1).is_some_and(is_print),
            "the branch taken when there is NO pid file prints nothing: `{absent_label}:` is \
             followed by `{}`. «There was no record of a core to stop» is a fact the log must \
             carry — its absence is indistinguishable from the step never running (G-32-11).",
            region
                .get(absent_at + 1)
                .map(String::as_str)
                .unwrap_or("<the end of the region>")
        );

        let mut printed: Vec<&str> = region
            .iter()
            .filter(|l| is_print(l))
            .filter_map(|l| l.split_once("$(").and_then(|(_, r)| r.split_once(')')))
            .map(|(key, _)| key)
            .collect();
        printed.sort_unstable();
        printed.dedup();
        assert!(
            printed.len() >= 4,
            "the core-stop step reports {} distinct sentence(s) ({printed:?}). One sentence on \
             every path would satisfy the arms above while telling the reader nothing — the point \
             is that «stopped», «no record», «the record names nothing alive» and «a core is \
             running that is not ours to stop by name» are DIFFERENT outcomes and the log has to \
             say which one happened.",
            printed.len()
        );
    }

    /// **The hook waits for the main binary's FILE to be writable, not merely for its process to
    /// leave the process list.**
    ///
    /// WHY THE PROCESS POLL IS NOT THE ANSWER TO THIS QUESTION. It asks the plugin whether the
    /// image name is still in the process list. What the script does three lines later is open
    /// each file with write access, and the two answers are allowed to differ: a scanner reading
    /// the freshly closed binary, or any other holder that denies write sharing, keeps the file
    /// busy after its process is gone. NSIS answers that with the file-in-use retry dialog, which
    /// is what the owner got on build `h2vn6t` (G-32-11) — his log closes the program and then
    /// stops dead at `Extract: trusttunnel.exe`.
    ///
    /// So the wait is made out of the same call the extraction makes, and both outcomes print.
    ///
    /// THE MODE IS ASSERTED, AND IT IS THE ONE ARM WITH TEETH OF ITS OWN. NSIS `FileOpen` mode
    /// `w` is CREATE_ALWAYS: pointed at `trusttunnel.exe` it would TRUNCATE the installed binary
    /// to zero bytes — a probe that destroys what it is probing. Mode `a` opens for read/write
    /// without changing a byte. The existence check in front of it is the other half: `a` is
    /// OPEN_ALWAYS, so without a guard it would CREATE the file on a clean machine and leave an
    /// empty executable behind if the install were cancelled.
    #[test]
    fn the_pre_install_hook_waits_for_the_main_binary_file_to_be_writable() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");
        let binary = "$INSTDIR\\${MAINBINARYNAME}.exe";

        let Some(open_at) = body
            .iter()
            .position(|l| l.starts_with("FileOpen") && l.contains(binary))
        else {
            panic!(
                "the pre-install hook never opens `{binary}` for writing, so nothing verifies the \
                 file can actually be overwritten before the script starts overwriting it. A \
                 process that has left the process list can still have its image file held by \
                 somebody else; NSIS answers that with the retry dialog the owner had to press \
                 through (G-32-11), and the log says only that the program was being closed."
            );
        };

        let mode = body[open_at]
            .split_whitespace()
            .last()
            .expect("a FileOpen statement has tokens");
        assert_eq!(
            mode, "a",
            "the writability probe opens `{binary}` in mode `{mode}`. Only `a` is safe here: `w` \
             is CREATE_ALWAYS and would TRUNCATE the installed binary to zero bytes, and `r` \
             asks for read access, which a mapped image grants — so the probe would report the \
             file free while the extraction below still fails.\n  probe: {}",
            body[open_at]
        );

        let guarded = body[..open_at]
            .iter()
            .any(|l| l.starts_with("IfFileExists") && l.contains(binary));
        assert!(
            guarded,
            "the writability probe is not guarded by an existence test. Mode `a` is OPEN_ALWAYS: \
             on a clean machine it CREATES `{binary}`, leaving an empty executable in the install \
             folder if the install is cancelled before extraction."
        );

        let process_poll = body
            .iter()
            .position(|l| {
                l.starts_with("nsis_tauri_utils::FindProcess") && l.contains("${MAINBINARYNAME}.exe")
            })
            .expect("the process poll is the subject of an older rule and must still be here");
        assert!(
            process_poll < open_at,
            "the writability probe (statement {open_at}) runs BEFORE the process poll (statement \
             {process_poll}). It would then spend its whole ceiling waiting for a program nobody \
             has asked to close yet."
        );

        let first_removal = body
            .iter()
            .position(|l| l.split_whitespace().next() == Some("Delete"));
        if let Some(removal) = first_removal {
            assert!(
                open_at < removal,
                "the writability probe (statement {open_at}) runs after the first removal \
                 (statement {removal}). `Delete` on a file another process holds open fails \
                 SILENTLY, so the removals are exactly what the wait exists to protect."
            );
        }

        let done = body[open_at + 1..]
            .iter()
            .take_while(|l| !l.starts_with("Pop"))
            .filter(|l| l.starts_with("DetailPrint"))
            .count();
        assert!(
            done >= 2,
            "the writability wait reports {done} outcome(s). Both have to print: a step that \
             speaks only when it fails cannot be told apart from a step that never ran, and \
             telling those apart is what G-32-11 needed."
        );
    }

    /// **Every polling loop in the pre-install hook has a counted ceiling.**
    ///
    /// A loop that sleeps is a loop waiting on the world — on a process to exit, on a file to be
    /// released — and the world is entitled never to oblige. Without a counter such a loop is an
    /// installer that hangs on a progress page with no cancel and no message, which is a worse
    /// outcome than the file-in-use dialog it was written to avoid. Every wait in this hook is
    /// therefore expressed as a counted loop of ~10 s that reports and walks on.
    ///
    /// WHAT IT MEASURES: each backward `Goto` whose label is declared earlier in the macro and
    /// whose span contains a `Sleep`. The `Sleep` is the discriminator, and it is what keeps the
    /// rule off the two character-at-a-time loops that trim and validate the pid — those consume
    /// their input and cannot spin. Inside each span the rule requires a counter increment and a
    /// comparison against a small literal ceiling.
    ///
    /// Zero polling loops is reported as an inability to measure, never as a pass: this rule is
    /// exactly the shape that goes quietly vacuous when the thing it guards is renamed.
    #[test]
    fn every_polling_loop_in_the_pre_install_hook_has_a_counted_ceiling() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        let mut loops = 0usize;
        for (i, l) in body.iter().enumerate() {
            let Some(target) = l.strip_prefix("Goto ") else {
                continue;
            };
            let label = format!("{}:", target.trim());
            let Some(head) = body[..i].iter().position(|s| s.trim() == label) else {
                continue; // a forward Goto: a branch, not a loop
            };
            let span = &body[head..=i];
            if !span.iter().any(|s| s.starts_with("Sleep")) {
                continue; // not a wait on the world
            }
            loops += 1;

            assert!(
                span.iter()
                    .any(|s| s.starts_with("IntOp") && s.contains("+ 1")),
                "the polling loop at `{label}` counts nothing, so nothing can bound it. An \
                 installer that waits forever on a process that never exits is stuck on a page \
                 with no cancel and no message."
            );

            let ceiling = span
                .iter()
                .filter(|s| s.starts_with("${If}") && s.contains(">="))
                .filter_map(|s| s.split_whitespace().last())
                .filter_map(|n| n.parse::<u32>().ok())
                .find(|n| *n > 0 && *n <= 200);
            assert!(
                ceiling.is_some(),
                "the polling loop at `{label}` has no `${{If}} $Rn >= <n>` ceiling with a small \
                 literal bound, so its only exit is the world obliging. Bound it and report the \
                 give-up, exactly as the other waits in this macro do."
            );
        }

        assert!(
            loops > 0,
            "CANNOT MEASURE: `NSIS_HOOK_PREINSTALL` contains no polling loop at all — no backward \
             `Goto` whose span sleeps. Either every wait has been removed, or the shape this rule \
             recognises has changed; reporting PASS over an empty set is the vacuous tick this \
             file refuses."
        );
    }

    /// **No file the user owns is removed, or even reported as removable, by the pre-install hook.**
    ///
    /// The defect class here is not a wholesale delete — arm 1 covers that — but a list that
    /// grows a data file by accident: someone adds a name that looks like an install artifact
    /// and is not. The report is scanned as well as the removals, deliberately. In this plan
    /// nothing is deleted, so scanning removals alone would measure an empty set and pass
    /// vacuously; and the report is what plan 32-06 promotes into the real removal list, so a
    /// data file that reaches the report is a data file that will reach the delete.
    #[test]
    fn the_pre_install_hook_never_names_a_file_the_user_owns() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        let mut subjects = 0usize;
        let mut offenders: Vec<String> = Vec::new();
        for l in &body {
            let removal =
                l.starts_with("Delete") || l.starts_with("RMDir") || l.starts_with("DeleteReg");
            // The report lines, keyed off the language strings they actually print — so renaming
            // a key without revisiting this rule takes the rule's subject away and trips the
            // locate-or-fail below rather than passing quietly. BOTH printed forms are scanned:
            // the announcement, and the outcome line plan 32-06 added. They name the same artifact
            // by construction, so a data file that reached one reached the other, and a rule that
            // watched only one half would be repairable by deleting the half it watched.
            //
            // EXTENDED BY 32-FIX-10, over one more printed form and one more statement kind:
            //   * `$(legacyRemoveOnReboot)` — the third printed line about an artifact. It names
            //     the same path the other two do, so it is the same class of subject and belongs
            //     in the same scan.
            //   * the survivor-marker WRITE. This one matters most: it is the only statement here
            //     that puts a path into a FILE that outlives the installer, in a folder the
            //     program-folder ACL grants every account on the machine read access to. The
            //     reach is extended rather than copied — a second list of user filenames beside
            //     this one is how the two drift and one of them stops being enforced.
            let reported = l.starts_with("DetailPrint")
                && (l.contains("$(legacyRemoving)")
                    || l.contains("$(legacyRemoveFailed)")
                    || l.contains("$(legacyRemoveOnReboot)"));
            let marker_write = l.starts_with(MARKER_WRITE);
            if !(removal || reported || marker_write) {
                continue;
            }
            subjects += 1;
            let segments = quoted_path_segments(l);
            for name in USER_DATA {
                if segments.iter().any(|s| s == &name.to_ascii_lowercase()) {
                    offenders.push(format!("{l}   <- names '{name}', which is the user's"));
                }
            }
        }

        assert!(
            subjects > 0,
            "CANNOT MEASURE: the pre-install hook names nothing removable at all. The whole point \
             of the macro is to enumerate the legacy install, so zero subjects means this rule \
             lost its subject — not that the hook is clean."
        );
        assert!(
            offenders.is_empty(),
            "the pre-install hook names the user's own files among the artifacts it would \
             remove. On a default install that folder is the data root (D-05), so these are the \
             servers, saved passwords, known hosts and browser profile the migration exists to \
             preserve:\n  {}",
            offenders.join("\n  ")
        );
    }

    /// **Every file the template installs appears in the pre-install enumeration.**
    ///
    /// The failure this guards is silent by construction: a resource added to `tauri.conf.json`
    /// later — a third DLL, a second sidecar — is installed by the template into the legacy
    /// folder on old machines and then left there forever, because nobody thought to add it
    /// here. Nothing fails; there is simply an orphan on disk. So the expectation is stated
    /// against the template's own installed-file list rather than against whatever the hook
    /// happens to say.
    ///
    /// Names come from constants wherever the crate owns one — `SIDECAR_IMAGE_NAME` for the VPN
    /// core — and the main binary is asserted as the DEFINE `${MAINBINARYNAME}`, not as the
    /// literal `trusttunnel.exe`. That is stronger than a literal: the main binary is
    /// `trusttunnel` while the product is `TrustTunnel Client Pro`, and a path built from the
    /// product name matches nothing on disk while looking exactly like a hook that had nothing
    /// to do. Requiring the define makes that mistake unrepresentable.
    ///
    /// The remaining literals (the two runtime DLLs, the adapter DLL, `uninstall.exe`) have no
    /// Rust constant to source from — they are bundler resources and an NSIS `WriteUninstaller`
    /// target. They were read off the emitted script at `installer.nsi:624-626` and `:636`.
    ///
    /// # Why two of these are no longer bundle resources, and are still required here
    ///
    /// Owner decision `drop-now` (2026-09-06, plan 32-FIX-13) removed `vcruntime140.dll` and
    /// `vcruntime140_1.dll` from `resources` in `tauri.conf.json`: neither shipped binary imports
    /// them statically (the main binary imports only the Universal CRT forwarders
    /// `api-ms-win-crt-*`, the VPN core is statically linked and imports no CRT at all), neither
    /// declares a delay-load import directory at all, and neither resolves them by name at run
    /// time. So the template no longer installs them.
    ///
    /// The expected list below deliberately did NOT shrink with the package, and this is the one
    /// place that has to say why, because the test's own name reads the other way. The subject of
    /// this rule is not "what the template installs today" — it is **"what a legacy folder on a
    /// user's disk can contain"**, and the template installed both libraries into every legacy
    /// folder that exists. Shrinking the enumeration in step with `resources` would strand roughly
    /// 170 KB in every one of those folders forever, silently, with nothing reporting it — which is
    /// a fresh instance of the exact defect (G-32-2) this whole remediation exists to close. A file
    /// stops being a removal target when no machine can still hold it, not when we stop shipping it.
    ///
    /// The practical consequence: the two entries below are now pinned by history rather than by a
    /// live `resources` line, so nothing upstream keeps them in step any more. That is the cost of
    /// the decision, recorded rather than smoothed over. They may be dropped from this list only
    /// when installs predating 2026-09-06 are no longer reachable — not before.
    #[test]
    fn the_pre_install_enumeration_names_every_file_the_template_installs() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        let enumerated: Vec<&String> = body
            .iter()
            .filter(|l| l.starts_with("DetailPrint") && l.contains("$(legacyRemoving)"))
            .collect();

        assert!(
            !enumerated.is_empty(),
            "CANNOT MEASURE: the pre-install hook enumerates ZERO artifacts. Either the macro was \
             emptied or the language key it prints was renamed. A scan that lost its subject must \
             say so — reporting PASS over an empty set is the vacuous shape this file refuses."
        );

        let sidecar = crate::commands::vpn::SIDECAR_IMAGE_NAME;
        let expected: Vec<(&str, &str)> = vec![
            (
                "${MAINBINARYNAME}.exe",
                "the main binary, taken from the template's define so a product-name path can \
                 never be substituted for it",
            ),
            (
                "vcruntime140.dll",
                "NOT a bundle resource any more (owner decision `drop-now`, 2026-09-06) — required \
                 here because every install made before that date put it in the legacy folder, and \
                 the installer is the only thing that will ever take it back out",
            ),
            (
                "vcruntime140_1.dll",
                "same as above: dropped from the package, kept as a removal target because copies \
                 already exist on disk",
            ),
            ("wintun.dll", "the network adapter DLL, installer.nsi:626"),
            (sidecar, "the VPN core, from commands::vpn::SIDECAR_IMAGE_NAME"),
            (
                "uninstall.exe",
                "the legacy uninstaller — left behind it keeps an Add/Remove-Programs entry alive \
                 that deletes the data root when clicked (installer.nsi:636)",
            ),
        ];

        let mut missing: Vec<String> = Vec::new();
        for (name, why) in &expected {
            if !enumerated.iter().any(|l| l.contains(name)) {
                missing.push(format!("{name}   ({why})"));
            }
        }

        assert!(
            missing.is_empty(),
            "the template installs files the pre-install enumeration does not name, so they \
             would be orphaned in the legacy folder forever with nothing reporting it:\n  {}\n\
             Enumeration as it stands:\n  {}",
            missing.join("\n  "),
            enumerated
                .iter()
                .map(|l| l.as_str())
                .collect::<Vec<_>>()
                .join("\n  ")
        );
    }

    /// **Every artifact the pre-install hook removes reports what actually happened to it.**
    ///
    /// THIS ARM EXISTS BECAUSE THE DRY RUN COULD NOT COVER IT, AND SAID SO. Plan 32-06 shipped the
    /// removal log-only first and the printed list was read against a real machine before
    /// anything could delete — that is the phase's whole safety mechanism, and it proved the
    /// *enumeration*. It structurally cannot prove the *deletion*: NSIS `Delete` on a file another
    /// process holds open fails silently, sets no error the surrounding code reads, and the install
    /// walks on. `trusttunnel.exe` and `trusttunnel_client.exe` are exactly the sort of thing that
    /// is running when somebody reinstalls, so this is the realistic case and not the exotic one.
    ///
    /// A progress list that prints the same line whether or not the file went is the application
    /// claiming what it did not do — the one thing this project's patterns forbid everywhere else.
    /// So the shape is pinned rather than reviewed: announce, remove, LOOK AGAIN, and print a
    /// distinct line if the artifact survived.
    ///
    /// The order is asserted, not merely the presence, and that is the difference between «the
    /// outcome was checked» and «the words appear somewhere in the macro». A re-check that runs
    /// before its own removal reports the state of the world beforehand, which is worse than no
    /// re-check at all because it looks like evidence.
    ///
    /// The set equality is what enforces the OTHER half of the decision. He approved a list
    /// of exactly nine artifacts, and explicitly declined a tenth (`.sidecar-pro.pid`) when offered
    /// it. A removal of something never announced, or an announcement never removed, breaks this
    /// arm — so the list a human read cannot be quietly grown or quietly shrunk afterwards.
    #[test]
    fn every_artifact_the_pre_install_hook_removes_reports_what_actually_happened() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        let mut announced: Vec<(usize, String)> = Vec::new();
        let mut removed: Vec<(usize, String)> = Vec::new();
        let mut rechecked: Vec<(usize, String)> = Vec::new();
        let mut reported: Vec<(usize, String)> = Vec::new();

        for (i, l) in body.iter().enumerate() {
            let Some(subject) = pre_install_subject(l) else {
                continue;
            };
            if l.starts_with("DetailPrint") {
                // `pre_install_subject` already refused every DetailPrint that carries neither
                // removal key, so this branch is exactly the two we care about.
                if l.contains("$(legacyRemoving)") {
                    announced.push((i, subject));
                } else {
                    reported.push((i, subject));
                }
            } else if l.starts_with("Delete") || l.starts_with("RMDir") {
                removed.push((i, subject));
            } else if l.contains("${FileExists}") || l.starts_with("EnumRegValue") {
                // Validation check (d) also spells `${FileExists}`, one branch above and long
                // before the enumeration. It lands in this list harmlessly: every lookup below is
                // «an entry for this subject AT A LATER INDEX than the removal», which an earlier
                // line can never satisfy.
                rechecked.push((i, subject));
            }
        }

        assert!(
            !announced.is_empty(),
            "CANNOT MEASURE: the pre-install hook announces ZERO artifacts, so this rule has no \
             subject and can say nothing about outcome reporting. Reporting PASS over an empty \
             set is the vacuous shape this file refuses."
        );

        let after = |v: &[(usize, String)], subject: &str, min: usize| -> Option<usize> {
            v.iter()
                .find(|(i, s)| *i > min && s == subject)
                .map(|(i, _)| *i)
        };

        let mut broken: Vec<String> = Vec::new();
        for (i, subject) in &announced {
            let Some(j) = after(&removed, subject, *i) else {
                broken.push(format!(
                    "{subject}   <- announced but never removed. The progress list tells the user \
                     it is going and it stays on disk."
                ));
                continue;
            };
            let Some(k) = after(&rechecked, subject, j) else {
                broken.push(format!(
                    "{subject}   <- removed with no existence re-check afterwards. A `Delete` on a \
                     file another process holds open fails SILENTLY, so without the second look \
                     there is nothing that could ever notice."
                ));
                continue;
            };
            if after(&reported, subject, k).is_none() {
                broken.push(format!(
                    "{subject}   <- re-checked but with no failure line to print when it survived. \
                     The check is then invisible and the install reports success either way."
                ));
            }
        }
        assert!(
            broken.is_empty(),
            "the pre-install hook removes artifacts without honestly reporting the outcome. The \
             dry run the owner read proved the ENUMERATION and explicitly could not prove the \
             DELETION — this arm is what closes that gap, and these artifacts fall through \
             it:\n  {}",
            broken.join("\n  ")
        );

        let names = |v: &[(usize, String)]| -> Vec<String> {
            let mut n: Vec<String> = v.iter().map(|(_, s)| s.clone()).collect();
            n.sort();
            n.dedup();
            n
        };
        let announced_names = names(&announced);
        assert_eq!(
            names(&removed),
            announced_names,
            "the set of artifacts REMOVED differs from the set ANNOUNCED. A reviewer approved a \
             list of exactly nine artifacts after reading it on a real machine, and declined a \
             tenth when it was offered; a removal that does not appear in the announcement is a \
             deletion no human ever reviewed."
        );
        assert_eq!(
            names(&reported),
            announced_names,
            "the set of artifacts whose FAILURE is reportable differs from the set announced — so \
             some artifact can fail to be removed and the install will still look like it worked."
        );
    }

    /// **Every artifact that survived its removal is scheduled for the next restart, and only
    /// those.**
    ///
    /// WHAT IS LEFT AFTER 32-FIX-07 AND 32-FIX-09, AND WHY IT IS NOT NOTHING. Those two plans
    /// terminate the application and this edition's VPN core and wait for both before the first
    /// `Delete`. That closes the ordinary case. It cannot close A HANDLE THAT OUTLIVES ITS
    /// PROCESS: `wintun.dll` is loaded by the core at run time through `LoadLibrary`, and the
    /// adapter driver can hold a reference to it after the loading process is gone. On such a
    /// machine every termination did its job and `Delete` still fails — silently, as it always
    /// does — and without a deferred attempt the file is orphaned in the legacy folder forever.
    ///
    /// TWO ASSERTIONS, AND THE SECOND IS THE IMPORTANT ONE.
    ///   1. COVERAGE — every announced FILE artifact has a deferred removal inside its own failure
    ///      branch. The registry artifact is excluded, and must be: `DeleteRegKey` has no deferred
    ///      form.
    ///   2. SCOPE — the set of deferred-removal subjects is a SUBSET of the announced set. A
    ///      deferred delete is executed at boot by the session manager with SYSTEM authority, in
    ///      no user session, and cannot be recalled between the install and the restart. A target
    ///      outside the nine artifacts the owner read on a real machine is therefore a
    ///      system-authority deletion nobody approved — which is a strictly worse failure than the
    ///      orphan this whole mechanism exists to prevent.
    ///
    /// A THIRD, SMALLER ONE: the reboot flag is raised in each of those branches. `/REBOOTOK`
    /// raises it by itself ONLY when the pending-rename registration succeeds; when it fails, NSIS
    /// sets the error flag and leaves the reboot flag down. A scheduled deletion with the flag
    /// down is a deletion the user is never offered the restart for, and therefore never
    /// completes — the mechanism silently reduced to nothing.
    ///
    /// «INSIDE ITS OWN FAILURE BRANCH» IS POSITIONAL AND SAYS SO. See `PreInstallGroup`: this
    /// scan is flat, so what is measured is «strictly between this artifact's outcome report and
    /// the next artifact's announcement», which brackets the branch tail without parsing the
    /// conditional. Do not credit it with more.
    #[test]
    fn every_survived_artifact_is_scheduled_for_the_next_restart() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");
        let groups = pre_install_groups(&body);

        assert!(
            !groups.is_empty(),
            "CANNOT MEASURE: the pre-install hook announces ZERO artifacts, so this rule has no \
             subject and can say nothing about deferred removals. Reporting PASS over an empty \
             set is the vacuous shape this file refuses."
        );

        let deferred: Vec<(usize, String)> = body
            .iter()
            .enumerate()
            .filter(|(_, l)| is_deferred_removal(l))
            .filter_map(|(i, l)| pre_install_subject(l).map(|s| (i, s)))
            .collect();

        // (1) COVERAGE, plus the reboot flag that makes a schedule reachable by the user.
        let mut broken: Vec<String> = Vec::new();
        for g in &groups {
            if is_registry_subject(&g.subject) {
                continue;
            }
            let Some(report) = g.report else {
                broken.push(format!(
                    "{}   <- announced with no outcome report of its own, so it has no failure \
                     branch for a deferred removal to live in",
                    g.subject
                ));
                continue;
            };
            let in_branch = |pred: &dyn Fn(&str) -> bool| {
                (report + 1..g.next_announce).any(|k| pred(&body[k]))
            };
            if !in_branch(&|l: &str| {
                is_deferred_removal(l) && pre_install_subject(l).as_deref() == Some(&g.subject)
            }) {
                broken.push(format!(
                    "{}   <- survives its removal and is then ORPHANED. A handle can outlive the \
                     process that opened it (the VPN core loads wintun.dll through LoadLibrary and \
                     a driver can hold it past the core's exit), so terminating everything is not \
                     enough: without `Delete /REBOOTOK` in this branch the file stays in the legacy \
                     folder forever, beside the user's credential store, with nothing that will \
                     ever try again.",
                    g.subject
                ));
            }
            if !in_branch(&|l: &str| l.starts_with("SetRebootFlag")) {
                broken.push(format!(
                    "{}   <- scheduled for the next restart with the reboot flag left down. \
                     `/REBOOTOK` raises it only when the pending-rename registration succeeds, so \
                     the flag is raised explicitly or the finish page never offers the restart — \
                     and a deletion waiting for a restart nobody is offered never happens.",
                    g.subject
                ));
            }
        }
        assert!(
            broken.is_empty(),
            "the pre-install hook leaves a survived artifact with no last resort:\n  {}",
            broken.join("\n  ")
        );

        // (2) SCOPE — the assertion that keeps a boot-time, system-authority deletion inside the
        //     list a human actually read.
        let announced: Vec<&String> = groups.iter().map(|g| &g.subject).collect();
        let strays: Vec<String> = deferred
            .iter()
            .filter(|(_, s)| !announced.iter().any(|a| *a == s))
            .map(|(i, s)| format!("{s}   <- statement {i}: {}", body[*i]))
            .collect();
        assert!(
            strays.is_empty(),
            "the pre-install hook schedules a deletion of something it never announced. A \
             deferred delete is executed at the next boot BY THE SESSION MANAGER, WITH SYSTEM \
             AUTHORITY, outside any user session, and cannot be recalled between the install and \
             the restart — so a target outside the nine artifacts read and approved on \
             a real machine is a system-authority deletion no human ever reviewed:\n  {}",
            strays.join("\n  ")
        );

        // (3) The registry artifact keeps none, because there is nothing for it to keep.
        let registry_deferred: Vec<&(usize, String)> = deferred
            .iter()
            .filter(|(_, s)| is_registry_subject(s))
            .collect();
        assert!(
            registry_deferred.is_empty(),
            "a registry key is scheduled for deferred deletion. `DeleteRegKey` has no deferred \
             form; the pending-rename list deletes FILES, so this schedules the removal of a file \
             whose path is a registry key — a no-op at best: {registry_deferred:?}"
        );
    }

    /// **The survivor marker is written only when something survived, and never carries anything
    /// but an announced artifact's path.**
    ///
    /// WHY A FILE AT ALL. The removal report is honest and, since 32-FIX-07, on screen. It is
    /// still ephemeral: it lives in a window that closes, it reaches no log, and it triggers no
    /// retry. That is exactly how three surviving binaries reached the owner as a green install
    /// (UAT gaps G-32-2 / G-32-2b). The marker is what makes the failure outlive the installer.
    ///
    /// ITS PRESENCE IS THE SIGNAL, WHICH IS THE WHOLE REASON IT MUST BE CONDITIONAL. A file
    /// written on every install carries no information at all; the application reading it at first
    /// launch (32-FIX-11) would have to parse it before it learned anything, and an empty one
    /// would be indistinguishable from a failure to write. So the writes must sit inside failure
    /// branches and nowhere else.
    ///
    /// WHAT IS ASSERTED, AND WHAT COULD NOT BE — stated rather than implied, because the weaker
    /// property is easy to read as the stronger one:
    ///   * ASSERTED: every marker write sits strictly between its own artifact's outcome report
    ///     and the next artifact's announcement, and every announced FILE artifact has exactly one.
    ///     That brackets the failure branch (see `PreInstallGroup`) without parsing the `${If}`.
    ///   * NOT ASSERTED: that the write is lexically nested inside the conditional. This scan is
    ///     flat and cannot see nesting. A statement placed between the report and the next
    ///     announcement but outside the `${EndIf}` would satisfy this rule; nothing here would
    ///     catch it.
    ///   * COUNT: the marker writes are compared against the DEFERRED REMOVALS, not against the
    ///     outcome reports. There are nine reports and eight file branches — the registry branch
    ///     reports and legitimately writes no marker, because a registry key is not a path the
    ///     application could act on. Comparing against the reports would build a permanent
    ///     off-by-one into the rule and the usual repair for that is to delete the rule.
    ///
    /// AND A STALE MARKER IS NOT THE SAME AS NO MARKER. The file sits in the install directory and
    /// survives an upgrade, so a run with no survivors must not leave the PREVIOUS install's list
    /// behind for the application to read as fresh. That removal is asserted in
    /// `NSIS_HOOK_POSTINSTALL`, guarded on the flag the write macro raises, and it is asserted to
    /// be ABSENT from `NSIS_HOOK_PREINSTALL` — where it would be a tenth removal target in a macro
    /// whose removal set is pinned equal to the nine artifacts the owner reviewed.
    #[test]
    fn the_survivor_marker_is_written_only_when_something_survived() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");
        let groups = pre_install_groups(&body);

        let writes: Vec<(usize, String)> = body
            .iter()
            .enumerate()
            .filter(|(_, l)| l.starts_with(MARKER_WRITE))
            .filter_map(|(i, l)| pre_install_subject(l).map(|s| (i, s)))
            .collect();

        assert!(
            !writes.is_empty(),
            "CANNOT MEASURE: the pre-install hook writes the survivor marker NOWHERE (looked for \
             `{MARKER_WRITE}`). Either the write was removed or its call-site spelling changed, so \
             this rule has lost its subject — reporting PASS over an empty set is the vacuous \
             shape this file refuses."
        );

        // (a) every write sits inside the failure branch of the artifact it names, and every file
        //     artifact has one.
        let mut broken: Vec<String> = Vec::new();
        for g in &groups {
            let file_artifact = !is_registry_subject(&g.subject);
            let inside = g.report.is_some_and(|report| {
                writes
                    .iter()
                    .any(|(i, s)| *i > report && *i < g.next_announce && s == &g.subject)
            });
            if file_artifact && !inside {
                broken.push(format!(
                    "{}   <- no marker write inside its failure branch. Either it survives without \
                     leaving a trace the installer window's closing cannot erase, or the write was \
                     moved OUT of the branch — and a marker written whether or not anything \
                     survived is always present, which means it carries no information at all.",
                    g.subject
                ));
            }
            if !file_artifact && inside {
                broken.push(format!(
                    "{}   <- a registry key is written into the survivor marker. The marker is a \
                     list of PATHS the application acts on; a registry key is not one.",
                    g.subject
                ));
            }
        }
        assert!(
            broken.is_empty(),
            "the survivor marker does not describe exactly the artifacts that survived:\n  {}",
            broken.join("\n  ")
        );

        // (b) COUNT — one write per deferred removal, so a write cannot be added anywhere else in
        //     the macro without also being a scheduled removal, and vice versa.
        let deferred = body.iter().filter(|l| is_deferred_removal(l)).count();
        assert_eq!(
            writes.len(),
            deferred,
            "the number of marker writes ({}) differs from the number of deferred removals ({}). \
             They are the same event seen twice — an artifact that survived — so a difference means \
             either a survivor is scheduled without being recorded, or something is recorded that \
             was never scheduled.",
            writes.len(),
            deferred
        );

        // (c) the stale-marker removal is NOT in the pre-install macro, and it is not an oversight
        //     that it is not. See the doc comment above.
        let stray_removal: Vec<&String> = body
            .iter()
            .filter(|l| l.starts_with("Delete") && l.contains(MARKER_PATH_REF))
            .collect();
        assert!(
            stray_removal.is_empty(),
            "the pre-install hook removes the survivor marker. That is a TENTH removal target in a \
             macro whose removal set is asserted equal to the NINE artifacts the owner read on his \
             own machine and approved — the arm that enforces it goes red the moment this line \
             exists. The stale-marker removal belongs in NSIS_HOOK_POSTINSTALL, guarded on \
             `{MARKER_SEEN_FLAG}`: {stray_removal:?}"
        );

        // (d) and it IS in the post-install macro, guarded, so a marker from an earlier install
        //     cannot be read as this one's.
        let post = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_POSTINSTALL");
        let guard = post
            .iter()
            .position(|l| l.starts_with("StrCmp") && l.contains(MARKER_SEEN_FLAG));
        let removal = post
            .iter()
            .position(|l| l.starts_with("Delete") && l.contains(MARKER_PATH_REF));
        match (guard, removal) {
            (Some(g), Some(r)) => assert!(
                g < r,
                "the post-install hook removes the survivor marker BEFORE it checks whether this \
                 install wrote it (guard at statement {g}, removal at statement {r}), so the file \
                 the pre-install hook just wrote is deleted before anything can read it."
            ),
            _ => panic!(
                "the post-install hook does not remove a stale survivor marker under the \
                 `{MARKER_SEEN_FLAG}` guard (guard: {guard:?}, removal: {removal:?}). The marker \
                 lives in the install directory and survives an upgrade, so without this a machine \
                 whose PREVIOUS install had a survivor hands the next install that old list, and \
                 the application reports artifacts that went long ago as fresh failures."
            ),
        }

        // (e) the write macro still TRUNCATES on the first survivor of a run.
        //
        //     ADDED AFTER A MUTATION THAT SHOULD HAVE GONE RED AND DID NOT. The stale-marker
        //     removal in POSTINSTALL only covers the run that wrote NOTHING; the run that DID
        //     write relies entirely on the first write truncating, or it appends to the previous
        //     install's list and the file describes two machines at once. Deleting the flag logic
        //     out of `TT_MARK_SURVIVOR` broke exactly that and every arm here stayed green,
        //     because no rule read inside a macro that is not a hook. It does now.
        //
        //     `hook_macro_statements` cannot be reused: it matches the opener EXACTLY and this
        //     macro takes a parameter, so it would report CANNOT MEASURE on a macro that is
        //     plainly there.
        let mark_macro: Vec<&str> = {
            let mut inside = false;
            let mut out = Vec::new();
            for raw in HOOK_NSH.lines() {
                let l = raw.trim();
                if !inside && l.starts_with("!macro TT_MARK_SURVIVOR") {
                    inside = true;
                    continue;
                }
                if inside && l == "!macroend" {
                    break;
                }
                if inside && !l.is_empty() && !l.starts_with(';') {
                    out.push(l);
                }
            }
            out
        };
        assert!(
            !mark_macro.is_empty(),
            "CANNOT MEASURE: `!macro TT_MARK_SURVIVOR` has no body in installer-hooks.nsh, so this \
             rule cannot say anything about how the marker is written."
        );
        for (needle, why) in [
            (
                "\" w",
                "the FIRST survivor of a run must open the marker in truncating mode, or this \
                 install appends to the PREVIOUS install's list and the file describes two \
                 machines at once — which the application would read as one",
            ),
            (
                "\" a",
                "the survivors after the first must APPEND, or each one overwrites the last and \
                 the marker names a single artifact however many survived",
            ),
            (
                "StrCpy $TT_LEGACY_SURVIVOR_SEEN",
                "the write must RAISE the flag, or NSIS_HOOK_POSTINSTALL deletes the marker this \
                 run just wrote, believing it belongs to an earlier install",
            ),
            (
                "StrCmp $TT_LEGACY_SURVIVOR_SEEN",
                "the write must READ the flag, or it cannot tell the first survivor of a run from \
                 the rest and one of the two modes above is unreachable",
            ),
        ] {
            assert!(
                mark_macro.iter().any(|l| l.contains(needle)),
                "`TT_MARK_SURVIVOR` no longer contains `{needle}`: {why}.\n  body: {mark_macro:?}"
            );
        }

        // (f) the marker's own filename is not something the user owns, and its path is composed
        //     on the install directory rather than on a profile-relative root.
        let basename_define = HOOK_NSH
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("!define TT_LEGACY_SURVIVOR_MARKER_BASENAME "))
            .and_then(|l| l.split('"').nth(1).map(str::to_string));
        let Some(basename) = basename_define else {
            panic!(
                "CANNOT MEASURE: installer-hooks.nsh carries no \
                 `!define TT_LEGACY_SURVIVOR_MARKER_BASENAME` — the marker's filename is not in one \
                 place, so nothing here can say what the installer writes."
            );
        };
        assert!(
            !basename.contains('\\') && !basename.contains('/'),
            "the survivor marker's basename carries a path separator ({basename}), so the define \
             below it composes a path this rule cannot reason about"
        );
        assert!(
            !USER_DATA.iter().any(|n| n.eq_ignore_ascii_case(&basename)),
            "the survivor marker is named after a file the USER owns ({basename}). The uninstaller \
             removes the marker as install state, so this would delete the user's own file during \
             what they experience as an update."
        );

        let defines: Vec<&str> = HOOK_NSH
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("!define TT_"))
            .collect();
        assert!(
            defines
                .iter()
                .any(|l| l.starts_with("!define TT_LEGACY_SURVIVOR_MARKER ")
                    && l.contains("${TT_INSTALL_DIR}")),
            "the survivor marker's path is not composed on ${{TT_INSTALL_DIR}}. It has to be: under \
             perMachine a profile-relative root resolves to the ELEVATING administrator's profile, \
             which under UAC need not be the person installing (D-08), and the application looking \
             for this file is in the install directory.\n  defines: {defines:?}"
        );
        assert!(
            !defines.iter().any(|l| l.contains("$LOCALAPPDATA")),
            "a define in this block names the local-profile variable. Under perMachine it resolves \
             to %ProgramData% — a folder nothing here writes — so the composed path would point \
             somewhere the installer never puts anything and the failure would be silent:\n  {}",
            defines
                .iter()
                .filter(|l| l.contains("$LOCALAPPDATA"))
                .copied()
                .collect::<Vec<_>>()
                .join("\n  ")
        );
    }

    /// **The pre-install hook closes the application before it removes anything.**
    ///
    /// THIS DEFECT WAS PREDICTED IN WRITING, ON THIS VERY FILE, AND DOWNGRADED TO A LOG LINE.
    /// The doc comment of `every_artifact_the_pre_install_hook_removes_reports_what_actually_happened`
    /// — thirty lines above — says outright that NSIS `Delete` on a file another process holds
    /// open «fails silently», that `trusttunnel.exe` and `trusttunnel_client.exe` are «exactly
    /// the sort of thing that is running when somebody reinstalls», and that this is «the
    /// realistic case and not the exotic one». The measure chosen was to REPORT the failure
    /// rather than to PREVENT it, and the report went into the installer's details pane, which
    /// is collapsed by default. On a real Windows install three binaries survived a real install
    /// and the three failure lines that said so were never on screen (UAT gaps G-32-2 /
    /// G-32-2b). Reporting is not a substitute for ordering, and this arm is the ordering.
    ///
    /// WHAT IT MEASURES: inside `NSIS_HOOK_PREINSTALL`, every termination step must precede the
    /// first removal. A termination step is the inserted macro (`!insertmacro
    /// CheckIfAppIsRunning`) or the plugin's process-finding entry point
    /// (`nsis_tauri_utils::FindProcess`) — matched on the statement's LEADING TOKENS, so the
    /// same words appearing inside a quoted string a `DetailPrint` hands the user cannot satisfy
    /// the rule.
    ///
    /// WHAT IT DELIBERATELY DOES NOT COVER, and it is the larger half of the defect. This reads
    /// the SOURCE hook. Where that hook's expansion sits relative to the TEMPLATE's own
    /// `CheckIfAppIsRunning` — `installer.nsi:614` against `:617` — is a cross-file fact about
    /// the GENERATED script, which is build output, is not git-tracked, and is therefore
    /// unreachable from `include_str!`. That fact is what actually put three binaries on the
    /// a real disk, and it is measured by `scripts/nsis-text-gate.cjs` rule 10 instead. Neither
    /// half is sufficient alone; do not credit this arm with the other one's property.
    #[test]
    fn the_pre_install_hook_closes_the_app_before_it_removes_anything() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_PREINSTALL");

        let is_termination = |l: &str| {
            let mut tokens = l.split_whitespace();
            match (tokens.next(), tokens.next()) {
                (Some("!insertmacro"), Some("CheckIfAppIsRunning")) => true,
                (Some("nsis_tauri_utils::FindProcess"), _) => true,
                _ => false,
            }
        };

        let first_removal = body
            .iter()
            .position(|l| l.split_whitespace().next() == Some("Delete"));
        let first_termination = body.iter().position(|l| is_termination(l.as_str()));

        // Checked BEFORE the termination arm, and the order matters: a macro with nothing to
        // remove says nothing about whether removal is safely ordered, so its verdict must be
        // «cannot measure» rather than either a pass or an ordering failure.
        let Some(removal) = first_removal else {
            panic!(
                "CANNOT MEASURE: `NSIS_HOOK_PREINSTALL` contains no `Delete` statement at all. \
                 The enumeration is the whole point of the macro, so zero removals means this \
                 rule lost its subject — reporting PASS here would be a green tick over nothing."
            );
        };

        let Some(termination) = first_termination else {
            panic!(
                "the pre-install hook TERMINATES NOTHING: neither `!insertmacro \
                 CheckIfAppIsRunning` nor `nsis_tauri_utils::FindProcess` appears in the macro, \
                 while statement {removal} removes a file. `Delete` on an image a live process \
                 has mapped fails SILENTLY, so that removal is a no-op nothing can notice:\n  \
                 removal: {}",
                body[removal]
            );
        };

        assert!(
            termination < removal,
            "the pre-install hook removes before it closes the application. First termination \
             step: statement {termination}. First `Delete`: statement {removal}. NSIS `Delete` \
             on a mapped image fails SILENTLY — this exact ordering left trusttunnel.exe, \
             trusttunnel_client.exe and wintun.dll on a real disk after a real install \
             (G-32-2), next to the credential store.\n  termination [{termination}]: {}\n  \
             removal     [{removal}]: {}",
            body[termination],
            body[removal]
        );
    }

    /// `lib.rs` must not forbid, in a comment, the mechanism it wires up twenty lines lower.
    ///
    /// WHY THIS IS A TEST AND NOT A NOTE. This is the same defect class the phase's design mirror
    /// already failed on once — a document describing a mechanism that does not exist — except
    /// this instance sits in the SOURCE, directly above the call it contradicts, on the migration
    /// path whose failure mode is data loss. A reader following this project's own commenting rule
    /// («comments explain why, and are to be trusted») would conclude `data_adoption` is the
    /// forbidden thing and delete it.
    ///
    /// IT LIVES IN `lifecycle.rs`, NOT IN `lib.rs`, AND THAT IS LOAD-BEARING. The banned sentences
    /// have to be written out somewhere for the assertion to name them; written inside `lib.rs`
    /// they would be part of the very text `include_str!` reads, so the test would fail on its own
    /// wording forever — a rule that invalidates itself. This module already owns the compiled
    /// `.nsh`↔Rust contracts, so a cross-file source contract is at home here.
    ///
    /// `include_str!` binds `lib.rs` at COMPILE time: editing that file alone cannot leave this
    /// green.
    #[test]
    fn the_startup_comment_does_not_forbid_the_adoption_the_same_file_wires_up() {
        const LIB_RS: &str = include_str!("lib.rs");

        // THE PREMISE, READ OFF THE FILE RATHER THAN ASSUMED. The prohibition would be perfectly
        // correct again if the adoption were removed, so this rule may only be asserted while the
        // wiring is actually there. Losing the premise is a FAILURE — «re-derive it», never «pass
        // quietly».
        assert!(
            LIB_RS.contains("data_adoption::run_first_launch_adoption()"),
            "lib.rs no longer runs the first-launch adoption, so this contract has lost its \
             subject and can no longer measure anything. Re-derive it against what the file now \
             does; do not delete it and do not flip its strings to keep it green."
        );

        // Each fragment is one line of the superseded comment, quoted exactly.
        const SUPERSEDED: &[&str] = &[
            "THERE IS NO DATA MIGRATION HERE",
            "to adopt FROM",
            "Do not reintroduce an adoption pass",
        ];
        let surviving: Vec<&str> = SUPERSEDED
            .iter()
            .copied()
            .filter(|needle| LIB_RS.contains(needle))
            .collect();
        assert!(
            surviving.is_empty(),
            "lib.rs still forbids the adoption pass it wires up. Phase 32 performed the root move \
             the prohibition was conditional on and reintroduced the adoption it serves, so these \
             fragments now describe a rule the file breaks itself:\n  {}",
            surviving.join("\n  ")
        );
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

    // ── The logon task the app registers is the logon task the uninstaller removes ────────
    //
    // Phase 32-05 gave «Запуск вместе с Windows» a logon Scheduled Task registered with
    // TASK_RUNLEVEL_HIGHEST. Nothing in the uninstaller removed it, because until that plan
    // there was no task to remove — so uninstalling left a HIGHEST-PRIVILEGES logon
    // registration pointing at an executable that had just been deleted. That is an orphaned
    // elevated-run entry aimed at a path in a directory whose ACL the uninstall may leave
    // writable, i.e. the mirror image of the elevation hazard this whole phase closes. Plan
    // 32-05 handed the teardown to this plan by name; these two arms are what make the handoff
    // machine-checked instead of remembered.

    /// **The uninstaller deletes the task by the name the application registers.**
    ///
    /// A mismatch here is SILENT, and that is the whole reason this is compiled rather than
    /// reviewed. A teardown naming a task that does not exist finds nothing and reports nothing
    /// — which is indistinguishable, in every log and on every screen, from a teardown that had
    /// nothing to do. The registration would simply survive, and the first person to notice
    /// would be whoever eventually investigated why a deleted program still ran something at
    /// logon.
    ///
    /// The expected string is COMPOSED from `task_scheduler::AUTOSTART_TASK_NAME`, never
    /// retyped. A hand-typed literal would make this test agree with itself instead of with the
    /// application — the same mechanism, and the same argument, as
    /// `the_uninstall_hook_reads_the_pid_file_the_app_writes` above, whose subject is the pid
    /// path. `include_str!` binds it at COMPILE time, so editing the `.nsh` alone cannot leave
    /// it green.
    #[cfg(windows)]
    #[test]
    fn the_uninstaller_removes_the_logon_task_the_app_registers() {
        let body = hook_macro_statements(HOOK_NSH, "NSIS_HOOK_POSTUNINSTALL");

        // ARM 1 — a teardown exists AT ALL. Without this, the arms below would be vacuously
        // true (they assert about the lines they find, and they would find none), which is the
        // failure mode every contract test in this file is written against.
        let teardown: Vec<&String> = body
            .iter()
            .filter(|l| l.contains("schtasks") && l.contains("/Delete"))
            .collect();
        assert!(
            !teardown.is_empty(),
            "NSIS_HOOK_POSTUNINSTALL contains no scheduled-task teardown. Uninstalling then \
             leaves highest-privileges logon tasks under `{}` registered against an executable \
             the uninstaller has just deleted.",
            crate::task_scheduler::AUTOSTART_TASK_FOLDER
        );

        let shown = || {
            teardown
                .iter()
                .map(|l| l.as_str())
                .collect::<Vec<_>>()
                .join("\n  ")
        };

        // ARM 2 — it sweeps the FOLDER, so EVERY user's registration goes.
        //
        // The registration is per-user now (two people on one per-machine install must not
        // overwrite each other's choice), so there is no single name for the teardown to
        // spell. It deletes the folder's contents with one wildcard instead. Note that a
        // wildcard reaches exactly one level, which is why
        // `task_scheduler::every_registration_lives_where_the_uninstaller_sweeps` asserts the
        // registration never nests below it — the two arms are one contract from two ends, and
        // neither alone is enough.
        let sweep = format!(
            "/TN \"{}\\*\"",
            crate::task_scheduler::AUTOSTART_TASK_FOLDER
        );
        assert!(
            teardown.iter().any(|l| l.contains(&sweep)),
            "the teardown does not sweep the per-user task folder. Expected a statement \
             containing {sweep}, found:\n  {}",
            shown()
        );

        // ARM 3 — and it still removes the ONE global task the pre-remediation builds wrote.
        //
        // Those builds registered a single machine-wide task in the scheduler's root. A machine
        // that carries one has it OUTSIDE the folder swept above, so dropping this line would
        // leave precisely the orphan this hook exists to prevent: a highest-privileges logon
        // task pointing at a deleted executable, on exactly the machines that tested the
        // feature before it was fixed.
        let legacy = format!(
            "/TN \"{}\"",
            crate::task_scheduler::LEGACY_AUTOSTART_TASK_NAME
        );
        assert!(
            teardown.iter().any(|l| l.contains(&legacy)),
            "the teardown does not remove the legacy global task. Expected a statement \
             containing {legacy}, found:\n  {}",
            shown()
        );
    }

    /// **No uninstall macro reads or branches on an external tool's output.**
    ///
    /// The project prohibition is on PARSING console output, and the reason is specific to this
    /// platform: the console code page is not the process code page, Windows localizes tool
    /// output, and a parser built against one machine's language silently mis-reads another's.
    /// A DELETION needs none of that — it either happened or the task was already absent, and
    /// «absent is a valid requested state» is settled practice in this codebase.
    ///
    /// So the rule is about the SHAPE of the call, not about which tool is called.
    /// `nsExec::ExecToStack` is the one NSIS form that CAPTURES the output, and a `Pop` after an
    /// exec is how a return code becomes a branch. Both are refused here. Written as its own arm
    /// because the teardown above is the first statement in these macros that had any temptation
    /// to check whether it worked.
    ///
    /// Its sibling `no_child_process_output_reaches_the_details_window` forbids the LOGGING form
    /// as well, over the whole file rather than these two macros — that one is about what the
    /// person watching the uninstall reads, not about what the script branches on.
    #[test]
    fn the_uninstall_macros_never_branch_on_a_tool_s_output() {
        for macro_name in ["NSIS_HOOK_PREUNINSTALL", "NSIS_HOOK_POSTUNINSTALL"] {
            let body = hook_macro_statements(HOOK_NSH, macro_name);
            for (i, l) in body.iter().enumerate() {
                assert!(
                    !l.contains("nsExec::ExecToStack") && !l.contains("ExecToStack"),
                    "{macro_name} captures a tool's output: {l}\n      Console output is \
                     localized and code-page-dependent on this platform — nothing here may read \
                     it. Use plain nsExec::Exec and ignore the result."
                );
                let follows_exec = i > 0
                    && (body[i - 1].contains("nsExec::") || body[i - 1].starts_with("Exec"));
                assert!(
                    !(follows_exec && l.starts_with("Pop ")),
                    "{macro_name} pops a value left by an external call: {l}\n      That is a \
                     branch on a tool's result, which this project does not do on Windows."
                );
            }
        }
    }

    /// **No child process's console output reaches the details window.** G-32-4, compiled.
    ///
    /// WHAT WAS OBSERVED, on 2026-09-07, during a real uninstall: between the localised
    /// autostart-task line and «Removing temporary update files…» the progress list printed two
    /// identical lines of unreadable characters. That was not our text. It was `schtasks.exe`
    /// saying, in its own words, that the task it was told to delete does not exist — which on
    /// that machine is TRUE and HARMLESS.
    ///
    /// THE MECHANISM, and it is not specific to `schtasks`. The logging variant of `nsExec::Exec`
    /// copies the child process's console bytes straight into the details window. A console on
    /// Russian Windows writes OEM code page 866; the details window renders ANSI code page 1251.
    /// Same bytes, different alphabet. So EVERY such call has this defect on every non-English
    /// Windows, whatever tool it runs — which is why this rule scans the whole file rather than
    /// the two `schtasks` lines that were reported.
    ///
    /// WHAT REPLACED IT: plain `nsExec::Exec`, whose output goes nowhere, plus a line of OURS
    /// through a `LangString`. We control our own strings; we do not control Microsoft's, and
    /// translating a foreign tool's message or converting code pages inside NSIS would both be
    /// attempts to.
    #[test]
    fn no_child_process_output_reaches_the_details_window() {
        // THE LOGGING FORM, OVER THE RAW FILE — COMMENTS INCLUDED. It has no remaining use here
        // and no rule needs to name it, so the honest state of this file is that the token is
        // simply gone. A comment recommending it is how the next reader brings it back; this
        // file's own history is the evidence, since the comment above the schtasks calls
        // recommended it right up until its output was read off a real screen.
        let logging_form: Vec<&str> = HOOK_NSH
            .lines()
            .filter(|l| l.contains("ExecToLog"))
            .map(str::trim)
            .collect();
        assert!(
            logging_form.is_empty(),
            "installer-hooks.nsh still names `ExecToLog`, which pipes the child's console bytes \
             into the details window — code page 866 rendered as 1251, i.e. the mojibake the \
             owner reported (G-32-4). Use plain `nsExec::Exec` and print a LangString of ours \
             for the outcome.\n  {}",
            logging_form.join("\n  ")
        );

        // THE CAPTURING FORM, OVER STATEMENTS ONLY — and the asymmetry is deliberate rather than
        // sloppy. `ExecToStack` still has a live prohibition that this file must be able to
        // EXPLAIN, so a comment naming it is the documentation of a decision, not a temptation.
        // Scanned over the whole file rather than over two macros, which is wider than
        // `the_uninstall_macros_never_branch_on_a_tool_s_output` reaches.
        let capturing_form: Vec<&str> = HOOK_NSH
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with(';') && l.contains("ExecToStack"))
            .collect();
        assert!(
            capturing_form.is_empty(),
            "installer-hooks.nsh captures a tool's output: console text on this platform is \
             localized and code-page dependent, so nothing here may read it.\n  {}",
            capturing_form.join("\n  ")
        );

        // The rule must be measuring something. A file with no external invocation at all would
        // satisfy the arms above vacuously — and the hook does invoke tools, so a zero here would
        // mean the scan lost its subject rather than that the file is clean.
        assert!(
            HOOK_NSH.contains("nsExec::Exec '"),
            "CANNOT MEASURE: installer-hooks.nsh contains no `nsExec::Exec` call at all, so the \
             absence of the logging form says nothing about how this file runs tools"
        );
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

// ─── 32-FIX-15: the note the application leaves about WHERE its data is ──────────────────────
//
// RED FIRST, and the order matters. Every test in this module was written and seen fail before
// `DATA_ROOT_RECORD_BASENAME`, `DataRootRecordOutcome` and `write_data_root_record` existed at
// all — one test per line of the plan's behaviour block, so no failure branch of the writer got
// its test written after the branch it was supposed to justify.
#[cfg(test)]
mod data_root_record_tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    static SANDBOX_SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh, empty directory under the OS temp dir, standing in for the folder the binaries
    /// live in.
    ///
    /// Deliberately NOT reached through `ssh::user_data_dir()`, for the reason `legacy_sweep`'s
    /// own sandbox states: the real answer names the folder holding the saved configs and
    /// plaintext credential store, and a test that can see real data is a test that can eat it.
    fn sandbox(tag: &str) -> PathBuf {
        let n = SANDBOX_SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tt-record-{}-{}-{}-{}",
            std::process::id(),
            tag,
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("sandbox");
        p
    }

    /// A plausible production data root, spelled here rather than resolved, so the ordinary-case
    /// tests do not depend on whatever profile the test host happens to have.
    fn a_data_root() -> PathBuf {
        PathBuf::from("C:\\Users\\somebody\\AppData\\Local\\TrustTunnel Client Pro")
    }

    #[test]
    fn the_record_is_the_data_root_on_one_line() {
        let exe_dir = sandbox("one-line");
        let root = a_data_root();

        assert_eq!(
            write_data_root_record(&root, Some(&exe_dir)),
            DataRootRecordOutcome::Written,
        );

        let body = std::fs::read_to_string(exe_dir.join(DATA_ROOT_RECORD_BASENAME))
            .expect("the record must be in the executable's own directory");
        assert_eq!(
            body,
            root.to_string_lossy(),
            "the record's content must be the data root and nothing else - the uninstaller reads \
             this byte for byte and hands the result to a path validator",
        );
        assert_eq!(body.lines().count(), 1, "the record is ONE line: {body}");
    }

    #[test]
    fn no_executable_directory_writes_nothing_and_says_so() {
        // 32-FIX-08's rule, one file over: a failure to resolve the executable means writing
        // NOTHING rather than writing somewhere useless. The uninstaller reads this file at
        // `$INSTDIR`; a copy anywhere else is unread litter written by an elevated process.
        assert_eq!(
            write_data_root_record(&a_data_root(), None),
            DataRootRecordOutcome::NoExecutableDirectory,
        );
    }

    #[test]
    fn a_directory_that_is_not_absolute_is_refused_rather_than_resolved_against_the_cwd() {
        // A relative destination is composed against the process WORKING directory, which is
        // chosen by whoever launched the process - and the launcher that matters is the logon
        // scheduled task, whose working directory is %WINDIR%\System32. Same argument
        // `sidecar_pid_dir` makes for declining rather than substituting (G-32-2e).
        let root = a_data_root();
        for relative in [Path::new("."), Path::new(""), Path::new("subdir")] {
            assert_eq!(
                write_data_root_record(&root, Some(relative)),
                DataRootRecordOutcome::NoExecutableDirectory,
                "a relative executable directory ({relative:?}) must be refused",
            );
        }
        assert!(
            !Path::new(DATA_ROOT_RECORD_BASENAME).exists(),
            "a record was written into the process working directory",
        );
    }

    #[test]
    fn a_data_root_that_is_not_absolute_writes_nothing() {
        let exe_dir = sandbox("relative-root");
        assert_eq!(
            write_data_root_record(Path::new("TrustTunnel Client Pro"), Some(&exe_dir)),
            DataRootRecordOutcome::NotAbsolute,
        );
        assert!(
            !exe_dir.join(DATA_ROOT_RECORD_BASENAME).exists(),
            "a relative data root must leave no record at all: the uninstaller's ladder would \
             refuse it anyway, and a file that only ever produces a refusal is worse than no file",
        );
    }

    #[test]
    fn an_unwritable_destination_is_reported_and_the_caller_carries_on() {
        // A directory occupying the record's own name is the cheapest real write failure, and it
        // is the one `legacy_sweep`'s marker tests already use.
        let exe_dir = sandbox("unwritable");
        std::fs::create_dir_all(exe_dir.join(DATA_ROOT_RECORD_BASENAME))
            .expect("a directory standing in the record's place");

        match write_data_root_record(&a_data_root(), Some(&exe_dir)) {
            DataRootRecordOutcome::Failed(reason) => {
                assert!(
                    !reason.contains('\\') && !reason.contains('/'),
                    "the failure reason carried a path, and such a path names a profile folder: \
                     {reason}",
                );
            }
            other => panic!("an unwritable destination must be REPORTED, not swallowed: {other:?}"),
        }
    }

    #[test]
    fn writing_twice_truncates_and_never_appends() {
        let exe_dir = sandbox("twice");
        let root = a_data_root();

        assert_eq!(write_data_root_record(&root, Some(&exe_dir)), DataRootRecordOutcome::Written);
        let first = std::fs::read_to_string(exe_dir.join(DATA_ROOT_RECORD_BASENAME)).expect("first");
        assert_eq!(write_data_root_record(&root, Some(&exe_dir)), DataRootRecordOutcome::Written);
        let second =
            std::fs::read_to_string(exe_dir.join(DATA_ROOT_RECORD_BASENAME)).expect("second");
        assert_eq!(first, second, "the same input twice must leave identical content");

        // And the shrinking case, which is the one an append would survive: a SHORTER root after a
        // longer one must leave no tail of the longer one behind. A record carrying two paths
        // spliced together is a record the uninstaller's ladder refuses - silently costing the
        // user the erasure they ticked a box for.
        let shorter = PathBuf::from("C:\\tt\\TrustTunnel Client Pro");
        assert_eq!(
            write_data_root_record(&shorter, Some(&exe_dir)),
            DataRootRecordOutcome::Written,
        );
        let third = std::fs::read_to_string(exe_dir.join(DATA_ROOT_RECORD_BASENAME)).expect("third");
        assert_eq!(third, shorter.to_string_lossy());
    }

    #[test]
    fn the_recorded_path_ends_with_the_product_data_folder() {
        // Asserted against `ssh::PRODUCT_DATA_FOLDER` rather than a retyped literal, because this
        // is the property the uninstaller's rung with teeth depends on: a record that does not end
        // with the product folder is refused rather than obeyed. If the production rule ever stops
        // composing the root that way, this goes red HERE - before the uninstaller starts refusing
        // every machine in the field.
        let (production_root, _origin) = crate::ssh::resolve_data_root(None)
            .expect("a Windows test host always has an absolute local-app-data location");
        assert!(
            production_root.ends_with(crate::ssh::PRODUCT_DATA_FOLDER),
            "the production data root no longer ends with the product folder name: {}",
            production_root.display(),
        );

        let exe_dir = sandbox("product-folder");
        assert_eq!(
            write_data_root_record(&production_root, Some(&exe_dir)),
            DataRootRecordOutcome::Written,
        );
        let body = std::fs::read_to_string(exe_dir.join(DATA_ROOT_RECORD_BASENAME)).expect("record");
        assert!(
            body.ends_with(crate::ssh::PRODUCT_DATA_FOLDER),
            "the recorded path must end with '{}', which is what the uninstaller matches on: {body}",
            crate::ssh::PRODUCT_DATA_FOLDER,
        );
    }

    /// **The uninstaller reads the record the app writes.**
    ///
    /// The same two-ended pin the pid path and the survivor marker already carry, and for the same
    /// recorded reason: the pid path's two ends drifted once (D-07), the kill became a silent
    /// no-op, and nothing was watching for months. Here the stake is larger - the file this pins
    /// is what a later plan hands to a recursive delete, so a drift does not merely lose a
    /// function, it aims one.
    ///
    /// `include_str!` binds the hook at COMPILE time: editing the `.nsh` alone cannot leave this
    /// green, because changing that file rebuilds this test binary.
    #[test]
    fn the_uninstall_hook_reads_the_data_root_record_the_app_writes() {
        const HOOK_NSH: &str = include_str!("../nsis/installer-hooks.nsh");

        // (1) The basename is COMPOSED from the Rust constant, never retyped here. A literal would
        //     make this test agree with itself rather than with the application.
        let want = format!("!define TT_DATA_ROOT_RECORD_BASENAME \"{DATA_ROOT_RECORD_BASENAME}\"");
        assert!(
            HOOK_NSH.contains(&want),
            "the uninstall hook does not define the record basename this application writes. Rust \
             writes '{DATA_ROOT_RECORD_BASENAME}'; the expected line is:\n  {want}",
        );

        // (2) ...and it is rooted at the INSTALL directory, which is where Rust puts it: the
        //     executable's own folder. `$INSTDIR` is the one root the uninstaller resolves
        //     correctly whichever administrator UAC elevated it to - a profile-relative root would
        //     name the ELEVATING account's folder and find nothing.
        assert!(
            HOOK_NSH.contains(
                "!define TT_DATA_ROOT_RECORD \"${TT_INSTALL_DIR}\\${TT_DATA_ROOT_RECORD_BASENAME}\""
            ),
            "the record is not composed on the install directory. The application writes it beside \
             its own binaries; anywhere else and the uninstaller reads nothing.",
        );

        // (3) Rust's end of the agreement: the record's directory really is the executable's own
        //     directory. Without this the first two assertions would keep passing while the writer
        //     moved the file somewhere the hook cannot name.
        let install = std::path::Path::new("C:\\Program Files\\TrustTunnel Client Pro");
        assert_eq!(
            crate::commands::vpn::sidecar_pid_dir(Some(install.join("trusttunnel.exe"))).as_deref(),
            Some(install),
            "the record follows the binaries, else $INSTDIR is the wrong spelling of its folder",
        );
    }

    /// **The product folder the uninstaller matches on is the one Rust composes the root from.**
    ///
    /// The uninstaller's rung with teeth requires the recorded path to end with `${PRODUCTNAME}`.
    /// That define comes from `tauri.conf.json`'s `productName` (emitted script :33), while the
    /// root Rust composes ends with `ssh::PRODUCT_DATA_FOLDER`. Nothing kept those two strings in
    /// step, and `ssh/mod.rs` says in prose that they must be - so this is that prose made
    /// checkable. Drift them and the rung refuses every record on every machine, which presents to
    /// a user as «the erase checkbox silently does nothing».
    #[test]
    fn the_product_folder_the_uninstaller_matches_is_the_one_rust_composes() {
        const TAURI_CONF: &str = include_str!("../tauri.conf.json");

        let want = format!("\"productName\": \"{}\"", crate::ssh::PRODUCT_DATA_FOLDER);
        assert!(
            TAURI_CONF.contains(&want),
            "`tauri.conf.json`'s productName is not `ssh::PRODUCT_DATA_FOLDER`. The installer's \
             ${{PRODUCTNAME}} is derived from productName and the uninstaller's ladder matches the \
             recorded path against it, so a difference of one character makes every record fail \
             that rung. Expected the file to contain:\n  {want}",
        );
    }
}
