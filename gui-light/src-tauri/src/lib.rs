mod commands;
mod connectivity;
mod diagnostics;
mod geodata;
mod geodata_v2ray;
mod job_object;
mod lifecycle;
mod logging;
mod processes;
mod routing_rules;
mod sidecar;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::image::Image;
use tauri::RunEvent;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Portable data directory: same folder as the executable.
/// Standalone helper replacing the old ssh_deploy::portable_data_dir.
pub fn portable_data_dir() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf()
}

/// Per-edition PID-file basename (D-07 / Gemini HIGH edition isolation).
///
/// Light MUST NOT share `.sidecar.pid` with Pro (`.sidecar-pro.pid`): if the two
/// editions shared a PID file in a co-installed data directory, one edition's
/// stale-cleanup (kill-by-saved-PID) could kill the OTHER edition's live VPN. A
/// distinct basename makes the two editions' PID files mutually invisible. Mirrors
/// Pro's `lifecycle::SIDECAR_PID_BASENAME` (`.sidecar-pro.pid`), but DISTINCT.
const SIDECAR_PID_BASENAME: &str = ".sidecar-light.pid";

/// Full path to Light's per-edition PID file (in the portable data dir shared with
/// Pro, but with a Light-only basename so the two never collide — D-07).
fn sidecar_pid_path() -> std::path::PathBuf {
    portable_data_dir().join(SIDECAR_PID_BASENAME)
}

/// OS image name of Light's spawned VPN sidecar. Tauri spawns it via
/// `.sidecar("trusttunnel_client")` (same binary name as Pro), so on Windows the
/// running process is `trusttunnel_client.exe`. Used as the
/// `taskkill /FI "IMAGENAME eq ..."` filter in `kill_stale_sidecar` (02-10,
/// Tier-1 A) so a reboot-recycled PID belonging to an unrelated process is never
/// force-killed. Mirror of Pro's `SIDECAR_IMAGE_NAME`.
const SIDECAR_IMAGE_NAME: &str = "trusttunnel_client.exe";

/// Save the sidecar PID so a later launch can clean up a crashed session's
/// process. PID is non-secret (it's the same PID `taskkill /PID` already targets).
///
/// 02-10 (Tier-1 A, T-10-02) mirror of Pro: the write is now CHECKED. On failure
/// (disk full / read-only data dir) we log a FIXED, secret-free phrase (no path —
/// D-29) and CONTINUE — a PID-write failure must never block the connect. The
/// consequence is a DEGRADED crash-cleanup mode (the next launch has no saved PID
/// to sweep), but the Windows Job Object (`job_object.rs`, `KILL_ON_JOB_CLOSE`)
/// still kills the sidecar on parent death, so no orphan survives. Surfacing the
/// failure makes that degraded mode visible instead of silently swallowed.
fn save_sidecar_pid(pid: u32) {
    if let Err(e) = std::fs::write(sidecar_pid_path(), pid.to_string()) {
        logging::log_app(
            "WARN",
            &format!(
                "Failed to persist sidecar PID ({}) — crash cleanup relies on the Job Object",
                e.kind()
            ),
        );
    }
}

/// Build the `taskkill` argument vector for an image-validated, PID-scoped kill of
/// Light's stale sidecar (02-10, T-10-01). Pure fn so the filter shape is
/// unit-testable without spawning `taskkill`. Per memory, Light's image-name kill
/// was previously DELETED for edition isolation (the old `taskkill /IM` killed
/// EVERY edition's sidecar). This re-adds the image filter ONLY in its VALIDATED,
/// PID-scoped form — the `PID eq` filter still scopes the kill to Light's own
/// saved PID, so isolation is preserved while a recycled PID on another image is a
/// no-op. Mirror of Pro's `stale_kill_args`.
fn stale_kill_args(pid: u32) -> Vec<String> {
    vec![
        "/FI".to_string(),
        format!("IMAGENAME eq {SIDECAR_IMAGE_NAME}"),
        "/FI".to_string(),
        format!("PID eq {pid}"),
        "/F".to_string(),
    ]
}

/// Kill a stale sidecar left over from a previous CRASHED session, using ONLY the
/// saved PID from Light's per-edition PID file (D-07). This is the PID-scoped
/// replacement for the old image-name `taskkill /IM trusttunnel_client.exe`, which
/// killed EVERY edition's sidecar (and any other process with that image name) and
/// so broke edition isolation. By reading only `.sidecar-light.pid` we can never
/// target Pro's process. Called before connecting to release a WinTUN adapter that
/// a crashed Light sidecar may still hold.
pub fn kill_stale_sidecar() {
    let pid_path = sidecar_pid_path();
    if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            eprintln!("[cleanup] Killing stale sidecar PID {pid} (image-validated)");
            logging::log_app("WARN", &format!("Killing stale sidecar PID {pid}"));
            // 02-10 (T-10-01) mirror of Pro: image-name + PID filters. A reboot-
            // recycled PID belonging to a DIFFERENT image matches neither filter pair
            // and is left untouched; the `PID eq` filter still scopes the kill to
            // Light's own saved PID, preserving edition isolation. `/F` forces the
            // kill only when both filters match Light's own crashed sidecar.
            let _ = std::process::Command::new("taskkill")
                .args(stale_kill_args(pid))
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output();
        }
        let _ = std::fs::remove_file(&pid_path);
    }
}

/// Emit a `vpn-status` event with a status string + optional error/reason code.
///
/// Light is a monolith with no `VpnStatus` enum (status is the wire string the
/// frontend already consumes). This is the single status emitter the Phase-2
/// connect-timeout watchdog and reconnect supervisor route through, so the reason
/// code carried on a timeout / give-up Error is set in ONE place (mirror of Pro's
/// `set_vpn_status`). `error` MUST be a STABLE ASCII reason code (e.g.
/// `"connect-timeout"`, `"reconnect-gave-up"`) — NEVER a Russian display string; the
/// frontend localizes it via i18n (CLAUDE.md i18n rule + D-29).
///
/// Keeps `is_connected` in sync: only a "connected" status sets it true; every other
/// status clears it, so readers (tray, connectivity monitor, check_vpn_status) never
/// disagree with what listeners were just told.
pub(crate) fn emit_vpn_status(app: &tauri::AppHandle, status: &str, error: Option<&str>) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut c) = state.is_connected.lock() {
            *c = status == "connected";
        }
        // 02-10 (Tier-3): record the published status + error so the watchdog
        // (T-10-04) and the supervisor (T-10-03) can read the current truth. Poison-
        // recover like the other guards so the record always lands.
        {
            let mut s = state.last_status.lock().unwrap_or_else(|e| e.into_inner());
            *s = (status.to_string(), error.map(|e| e.to_string()));
        }
    }
    app.emit(
        "vpn-status",
        serde_json::json!({ "status": status, "error": error }),
    )
    .ok();
}

/// Spawn the connect-timeout watchdog for a freshly-started session (D-05, F1).
///
/// Races `CONNECT_TIMEOUT` (60s) against the `Connected` signal (Light tracks it via
/// the `is_connected` bool). If the session has NOT connected within the window, it
/// kills the hung sidecar and moves to an honest Error carrying the STABLE reason
/// code `"connect-timeout"` (localized on the frontend). Lives at the COMMAND layer
/// (not the sidecar stdout loop — D-05) and is GENERATION-GUARDED so a stale watchdog
/// can never kill a session it no longer owns (Codex HIGH). Shared by both the
/// command (`vpn_connect`) and tray (`tray_vpn_connect`) connect paths so a
/// tray-started session is just as protected (mirror of Pro's vpn.rs watchdog).
/// Should the connect-timeout watchdog ABORT the session (kill + honest Error)?
/// Returns `true` only when the session is still NOT connected, NOT disconnecting,
/// NOT already in a specific Error, and this watchdog still owns the live generation.
/// Mirror of Pro's `decide_timeout_action` (Pro returns a `WatchdogDecision` enum;
/// Light is a monolith so a bool is enough). Pure so it is unit-testable.
///
/// 02-10 (T-10-04): `is_already_error` was added so the generic connect-timeout can
/// NEVER clobber a SPECIFIC Error (auth / config / Wintun) that landed first via the
/// fatal-marker path within the 60s window — when already Error, the watchdog NoOps.
fn decide_timeout_action(
    is_connected: bool,
    disconnecting: bool,
    is_already_error: bool,
    captured_generation: u64,
    live_generation: u64,
) -> bool {
    let still_owns_session = lifecycle::is_current_generation(captured_generation, live_generation);
    !is_connected && !disconnecting && !is_already_error && still_owns_session
}

fn spawn_connect_timeout_watchdog(app: &tauri::AppHandle, captured_gen: u64) {
    let Some(state) = app.try_state::<AppState>() else { return; };
    let app_wd = app.clone();
    let conn_arc = Arc::clone(&state.is_connected);
    let disc_arc = Arc::clone(&state.disconnecting);
    let child_arc = Arc::clone(&state.sidecar_child);
    let gen_arc = Arc::clone(&state.connection_generation);
    // 02-10 (T-10-04): the published status so the watchdog can detect an
    // already-set specific Error and not overwrite it with connect-timeout.
    let status_arc = Arc::clone(&state.last_status);

    tauri::async_runtime::spawn(async move {
        // Poll for `Connected` up to CONNECT_TIMEOUT. If connected first → no-op.
        let deadline = std::time::Instant::now() + lifecycle::CONNECT_TIMEOUT;
        loop {
            let connected = conn_arc.lock().map(|g| *g).unwrap_or(false);
            if connected {
                return; // connected within the window — nothing to do
            }
            if std::time::Instant::now() >= deadline {
                break; // deadline elapsed — evaluate the guards below
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        // Deadline elapsed. Re-check ALL guards (Pitfall 5 + Codex HIGH + 02-10
        // T-10-04) before any kill / status-write.
        let is_connected = conn_arc.lock().map(|g| *g).unwrap_or(false);
        let disconnecting = disc_arc.lock().map(|g| *g).unwrap_or(false);
        let live_gen = gen_arc.load(Ordering::SeqCst);
        // 02-10 (T-10-04) mirror of Pro: a SPECIFIC Error (auth / config / Wintun) may
        // have landed within the window via the fatal-marker path. Do NOT overwrite it
        // with the generic connect-timeout — read the published status and NoOp if it
        // is already "error". Routed through the same `decide_timeout_action` shape Pro
        // unit-tests (the `is_already_error` argument).
        let is_already_error = status_arc
            .lock()
            .map(|s| s.0 == "error")
            .unwrap_or(false);
        if !decide_timeout_action(is_connected, disconnecting, is_already_error, captured_gen, live_gen) {
            return; // connected, user-disconnecting, already-error, or stale → leave it
        }

        // FIXED lifecycle marker (no config text / no raw sidecar line — D-09/D-29).
        logging::log_app("WARN", "connect-timeout fired (60s, no handshake)");
        app_wd.emit("vpn-log", VpnLogPayload {
            message: "connect-timeout fired (60s, no handshake)".into(),
            level: "warn".into(),
        }).ok();

        // Release the WinTUN adapter: kill the PID-scoped child we still own, then
        // sweep any stale saved-PID sidecar (Pitfall 3). Both per-edition (D-07).
        if let Ok(mut guard) = child_arc.lock() {
            if let Some(child) = guard.take() {
                child.child.kill().ok();
            }
        }
        kill_stale_sidecar();

        // Honest failure carrying a STABLE, secret-free ASCII REASON CODE — the
        // user-facing wording is the i18n key on the frontend (CLAUDE.md i18n rule),
        // NOT a Russian string here. Routes through the single emitter.
        emit_vpn_status(&app_wd, "error", Some("connect-timeout"));
    });
}

// ─── Phase 2 (D-08/D-09/D-11): dev-gated secret-free lifecycle markers ──────────
//
// The observability slice surfaces the minimum lifecycle event set on the existing
// `vpn-log` channel so a DEV build can mirror them to the F12 console (D-08). EVERY
// new marker is a FIXED/derived phrase — built only from compile-time text + a
// non-secret PID / attempt count — so a credential or raw config text can NEVER
// reach the channel (D-09 / D-29). The builders below are the single source of those
// phrases; their secret-safety is spy-tested in `reconnect_supervisor_tests`.
//
// D-11: these verbose markers are a DEV-build-only aid. `emit_lifecycle_marker`
// early-returns in a RELEASE build (`!cfg!(debug_assertions)`), so a shipped build
// never streams them. Markers that drive REAL behavior (the connect-timeout /
// reconnect-gave-up status flow) keep emitting their STATUS unconditionally — only
// these pure-observability verbose markers are dev-gated. Mirror of Pro Plan 02-05.

/// Fixed "connect start" marker (no config path / credential — D-09).
fn connect_start_marker() -> &'static str {
    "[vpn] connect start"
}

/// Derived "sidecar spawned, pid {pid}" marker. The PID is the only interpolated
/// value (non-secret — A2); the config path is never included.
pub(crate) fn spawn_pid_marker(pid: u32) -> String {
    format!("[vpn] sidecar spawned, pid {pid}")
}

/// Fixed "handshake / connected" marker (ASCII-only diagnostic phrase).
pub(crate) fn handshake_marker() -> &'static str {
    "[vpn] handshake complete - connection up"
}

/// Fixed "connection drop detected" marker.
pub(crate) fn drop_detected_marker() -> &'static str {
    "[vpn] connection drop detected"
}

/// Derived "reconnect attempt n/3" marker. The attempt count is non-secret (D-09).
fn reconnect_attempt_marker(attempt: u32) -> String {
    format!("[vpn] reconnect attempt {attempt}/{}", lifecycle::RECONNECT_MAX_ATTEMPTS)
}

/// Fixed "reconnect gave up" marker.
fn reconnect_gave_up_marker() -> String {
    format!(
        "[vpn] reconnect gave up after {}/{}",
        lifecycle::RECONNECT_MAX_ATTEMPTS,
        lifecycle::RECONNECT_MAX_ATTEMPTS
    )
}

/// Fixed "sidecar killed on exit" marker.
fn killed_on_exit_marker() -> &'static str {
    "[vpn] sidecar killed on exit"
}

/// Fixed "pre-flight offline" marker (02-09, UAT Gap #2). Emitted by `vpn_connect`
/// when the non-blocking pre-flight saw the network as unreachable; the connect
/// proceeds regardless (cross-AI: never block). FIXED phrase, no config / server
/// text (D-09/D-29), DEV-gated (D-11). Mirror of Pro's preflight_offline_marker.
fn preflight_offline_marker() -> &'static str {
    "[vpn] pre-flight: network appears offline (connecting anyway)"
}

/// Emit a DEV-only verbose lifecycle marker on the `vpn-log` channel (D-11).
///
/// The marker is ALSO routed through `logging::sanitize()` as a defence-in-depth belt
/// (D-09) — the builders already produce fixed/derived phrases, so this is a no-op in
/// practice but guarantees the invariant holds even if a builder is later edited
/// carelessly. In a RELEASE build (`debug_assertions` off) this is a no-op: the
/// verbose mirror never streams in production. Mirror of Pro's emit_lifecycle_marker.
pub(crate) fn emit_lifecycle_marker(app: &tauri::AppHandle, message: &str, level: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    let safe = logging::sanitize(message);
    logging::log_app(level.to_uppercase().as_str(), &safe);
    app.emit("vpn-log", serde_json::json!({ "message": safe, "level": level })).ok();
}

// ─── Phase 2 (STATUS-05 / D-01..D-04): window-independent reconnect supervisor ───

/// Stable, secret-free ASCII reason code for the terminal "couldn't reconnect"
/// failure (D-02). This is the value the supervisor passes to the single status
/// emitter on give-up — NEVER a Russian display string (CLAUDE.md i18n rule +
/// D-09/D-29). The user-facing wording lives as the `errors.reconnect_gave_up` i18n
/// key on the frontend. Mirror of Pro's RECONNECT_GAVE_UP_REASON.
const RECONNECT_GAVE_UP_REASON: &str = "reconnect-gave-up";

/// Outcome of one run of the bounded-3 reconnect loop (D-02 / D-04 / Codex HIGH).
/// Returned by the pure-ish `run_reconnect_loop` core so tests can assert the
/// terminal state WITHOUT a real sidecar. Mirror of Pro's SupervisorOutcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SupervisorOutcome {
    /// A respawn reached `Connected` within the attempt window — recovery done.
    Recovered,
    /// All `RECONNECT_MAX_ATTEMPTS` failed — caller surfaces the terminal Error
    /// carrying `RECONNECT_GAVE_UP_REASON`.
    GaveUp,
    /// The user disconnected, or the captured generation was advanced — the
    /// supervisor is stale and must NOT act (D-04 + Codex HIGH). No respawn, no write.
    Aborted,
}

/// The bounded-3, fast-fail, generation-guarded reconnect loop — a pure-ish async
/// core so it runs in unit tests with injected closures instead of a real sidecar.
///
/// Behavior (D-02 / D-04 / Gemini fast-fail / Codex HIGH):
/// - Loops `attempt` over `1..=RECONNECT_MAX_ATTEMPTS` (no inline `3`).
/// - BEFORE each attempt re-checks intent + generation: if `user_disconnected()` OR
///   `!is_current_generation(captured, live_generation())`, returns `Aborted`.
/// - Marks the session `Reconnecting` (via `on_reconnecting`) and runs
///   `try_connect(attempt)` → `(succeeded, elapsed, failure_reason)`.
/// - On success → `Recovered`.
/// - On a failure whose `failure_reason` is `is_terminal_reason` (bad creds /
///   bad config / missing adapter) → `GaveUp` immediately, WITHOUT burning the
///   remaining attempts (02-10, T-10-03).
/// - On a transient failure: if `is_fast_fail(elapsed)` count it WITHOUT sleeping the
///   full window; otherwise `sleep(RECONNECT_INTERVAL)`. The last attempt never sleeps.
/// - After the budget is exhausted → `GaveUp`.
///
/// Mirror of Pro's connectivity::run_reconnect_loop.
#[allow(clippy::too_many_arguments)]
async fn run_reconnect_loop<TC, TCFut, UD, LG, RC, SL, SLFut>(
    captured_generation: u64,
    mut try_connect: TC,
    user_disconnected: UD,
    live_generation: LG,
    mut on_reconnecting: RC,
    mut sleep_interval: SL,
) -> SupervisorOutcome
where
    TC: FnMut(u32) -> TCFut,
    TCFut: std::future::Future<Output = (bool, std::time::Duration, Option<String>)>,
    UD: Fn() -> bool,
    LG: Fn() -> u64,
    RC: FnMut(u32),
    SL: FnMut() -> SLFut,
    SLFut: std::future::Future<Output = ()>,
{
    for attempt in 1..=lifecycle::RECONNECT_MAX_ATTEMPTS {
        // D-04 + Codex HIGH: user disconnect or an advanced generation means we no
        // longer own this session — abort before any respawn / status-write.
        if user_disconnected()
            || !lifecycle::is_current_generation(captured_generation, live_generation())
        {
            return SupervisorOutcome::Aborted;
        }

        on_reconnecting(attempt);

        let (succeeded, elapsed, failure_reason) = try_connect(attempt).await;
        if succeeded {
            return SupervisorOutcome::Recovered;
        }

        // 02-10 (T-10-03) mirror of Pro: a TERMINAL failure (bad creds / bad config /
        // missing adapter) fails identically on every retry — short-circuit and surface
        // the honest Error now instead of burning the remaining attempts.
        if failure_reason
            .as_deref()
            .is_some_and(lifecycle::is_terminal_reason)
        {
            logging::log_app(
                "INFO",
                "[reconnect] terminal failure reason — short-circuiting retries (02-10)",
            );
            return SupervisorOutcome::GaveUp;
        }

        // Failure. Fast-fail an instant death (skip the inter-attempt sleep); the last
        // attempt never sleeps (we're about to give up).
        let is_last = lifecycle::gave_up(attempt);
        if !is_last && !lifecycle::is_fast_fail(elapsed) {
            sleep_interval().await;
        }
    }

    SupervisorOutcome::GaveUp
}

/// One reconnect attempt: release the held WinTUN adapter (kill the prior child +
/// sweep the stale saved-PID sidecar — Pitfall 3), respawn the job-armed sidecar, and
/// wait up to `RECONNECT_ATTEMPT_WINDOW` for `is_connected` to flip true. Returns
/// `(connected, failure_reason)`: `failure_reason` is the specific Error this attempt
/// landed (read from `last_status` when status is "error") so the supervisor can
/// short-circuit a terminal one (02-10, T-10-03). Mirror of Pro's respawn_sidecar +
/// respawn_and_wait.
async fn respawn_and_wait(
    app: &tauri::AppHandle,
    config_path: &str,
    log_level: &str,
) -> (bool, Option<String>) {
    let Some(state) = app.try_state::<AppState>() else { return (false, None); };

    // 1. Kill the prior child (PID/job) so the WinTUN adapter is released before the
    //    new spawn (Pitfall 3). On a process-death drop this is already None; on a
    //    live-sidecar connectivity loss this kills the dead-tunnel child.
    {
        let prior = state.sidecar_child.lock().ok().and_then(|mut g| g.take());
        if let Some(child) = prior {
            child.child.kill().ok();
        }
    }
    // 2. Sweep any stale saved-PID sidecar (per-edition, never image-name — D-07).
    kill_stale_sidecar();

    // 3. Reset flags + spawn the job-armed sidecar.
    //
    // WR-05 (mirror of Pro): re-check intent IMMEDIATELY before clearing the flag /
    // spawning. The bounded-3 loop re-checks user intent before each attempt, but a
    // user can click Disconnect in the small window after that guard passed and before
    // we get here. Without this, respawn would clear the `disconnecting` flag the user
    // just set and spawn a sidecar they did not want. Bail WITHOUT clearing the flag if
    // a disconnect is observed now; the next loop iteration's guard then aborts.
    if state.disconnecting.lock().map(|g| *g).unwrap_or(false) {
        logging::log_app(
            "INFO",
            "[reconnect] disconnect observed before respawn — aborting respawn (WR-05)",
        );
        return (false, None);
    }
    if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
    if let Ok(mut c) = state.is_connected.lock() { *c = false; }
    let sidecar_log_level = match log_level {
        "error" | "warn" => "info",
        other => other,
    };
    let child_arc = Arc::clone(&state.sidecar_child);
    let disc_arc = Arc::clone(&state.disconnecting);
    let conn_arc = Arc::clone(&state.is_connected);
    let child = match sidecar::spawn_trusttunnel(
        app, config_path, sidecar_log_level, child_arc, disc_arc, conn_arc,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            logging::log_app("WARN", &format!("[reconnect] respawn failed: {e}"));
            return (false, None);
        }
    };

    // 02-10 (T-10-05) mirror of Pro: re-check intent AFTER the spawn `.await`, BEFORE
    // storing the child. The WR-05 guard above closes the PRE-spawn window, but
    // spawn_trusttunnel is async — a user can press Disconnect WHILE the spawn is in
    // flight. Without this, we'd store a child for a sidecar the user no longer wants
    // (vpn_disconnect already took `None`), leaving a live sidecar behind a
    // "disconnected" UI — a zombie tunnel. If a disconnect arrived, kill the fresh
    // child and bail without storing it.
    if state.disconnecting.lock().map(|g| *g).unwrap_or(false) {
        logging::log_app(
            "INFO",
            "[reconnect] disconnect observed after spawn — killing fresh child, not storing (T-10-05)",
        );
        child.child.kill().ok();
        return (false, None);
    }

    save_sidecar_pid(child.child.pid());
    if let Ok(mut guard) = state.sidecar_child.lock() {
        *guard = Some(child);
    }

    // 4. Wait up to the attempt window for the connection to come up.
    let conn_arc = Arc::clone(&state.is_connected);
    let deadline = std::time::Instant::now() + lifecycle::RECONNECT_ATTEMPT_WINDOW;
    while std::time::Instant::now() < deadline {
        if conn_arc.lock().map(|g| *g).unwrap_or(false) {
            return (true, None);
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    // Window elapsed without a connect. Read the specific Error reason the attempt
    // landed (if status is "error") so the supervisor can short-circuit a terminal one
    // (02-10, T-10-03). The reason is the already-secret-free code / derived phrase.
    let reason = {
        let s = state.last_status.lock().unwrap_or_else(|e| e.into_inner());
        if s.0 == "error" { s.1.clone() } else { None }
    };
    (false, reason)
}

/// Window-independent auto-reconnect supervisor (STATUS-05 / D-01) — mirror of Pro's
/// `start_reconnect_supervisor`. Spawned on an UNEXPECTED drop from BOTH triggers:
/// the sidecar Terminated arm (process death) AND the connectivity-loss path
/// (live-sidecar drop). Retries exactly `RECONNECT_MAX_ATTEMPTS` at a fixed snappy
/// interval, emits `Reconnecting` per attempt through the single emitter (D-03),
/// fast-fails instant deaths, is generation-guarded (Codex HIGH), and after 3
/// failures sets a terminal Error carrying the STABLE secret-free
/// `RECONNECT_GAVE_UP_REASON` — never a Russian string.
/// CR-02 single-supervisor guard (mirror of Pro's `ReconnectInProgressGuard`). Sets
/// `reconnect_in_progress = true` on `claim` and clears it on Drop, so the flag is
/// reset on EVERY supervisor exit path (Recovered / Aborted / GaveUp, and the
/// GaveUp-suppression early return) without threading a manual clear through each
/// branch.
struct ReconnectInProgressGuard(Arc<AtomicBool>);

impl ReconnectInProgressGuard {
    fn claim(flag: Arc<AtomicBool>) -> Self {
        flag.store(true, Ordering::SeqCst);
        ReconnectInProgressGuard(flag)
    }
}

impl Drop for ReconnectInProgressGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn start_reconnect_supervisor(
    app: tauri::AppHandle,
    config_path: String,
    log_level: String,
    generation: u64,
) {
    tauri::async_runtime::spawn(async move {
        logging::log_app("INFO", &format!("[reconnect] supervisor started (generation {generation})"));

        let Some(state) = app.try_state::<AppState>() else {
            logging::log_app("WARN", "[reconnect] AppState unavailable — supervisor aborting");
            return;
        };
        let gen_arc = Arc::clone(&state.connection_generation);
        let disc_arc = Arc::clone(&state.disconnecting);

        // CR-02: claim the single-supervisor slot for THIS supervisor's lifetime so the
        // Terminated arm / connectivity-loss path cannot spawn a second while we own
        // recovery. The RAII guard clears the flag on every exit path. The trigger
        // sites already checked the flag was free before spawning us; this re-asserts.
        let _guard = ReconnectInProgressGuard::claim(Arc::clone(&state.reconnect_in_progress));

        // Injected predicates for the testable core.
        let live_generation = {
            let gen_arc = Arc::clone(&gen_arc);
            move || gen_arc.load(Ordering::SeqCst)
        };
        let user_disconnected = {
            let disc_arc = Arc::clone(&disc_arc);
            move || disc_arc.lock().map(|g| *g).unwrap_or(false)
        };

        // Per-attempt Reconnecting status via the single emitter (D-03). The attempt
        // count is non-secret (D-09). The DEV-gated verbose marker mirrors to F12.
        let on_reconnecting = {
            let app = app.clone();
            move |attempt: u32| {
                emit_lifecycle_marker(&app, &reconnect_attempt_marker(attempt), "info");
                emit_vpn_status(&app, "recovering", None);
            }
        };

        let try_connect = {
            let app = app.clone();
            let config_path = config_path.clone();
            let log_level = log_level.clone();
            move |_attempt: u32| {
                let app = app.clone();
                let config_path = config_path.clone();
                let log_level = log_level.clone();
                async move {
                    let start = std::time::Instant::now();
                    let (ok, reason) = respawn_and_wait(&app, &config_path, &log_level).await;
                    (ok, start.elapsed(), reason)
                }
            }
        };

        let sleep_interval = || async { tokio::time::sleep(lifecycle::RECONNECT_INTERVAL).await };

        let outcome = run_reconnect_loop(
            generation,
            try_connect,
            user_disconnected,
            live_generation,
            on_reconnecting,
            sleep_interval,
        )
        .await;

        match outcome {
            SupervisorOutcome::Recovered => {
                logging::log_app("INFO", "[reconnect] reconnect succeeded");
            }
            SupervisorOutcome::Aborted => {
                logging::log_app("INFO", "[reconnect] supervisor aborted (user intent / generation advanced)");
            }
            SupervisorOutcome::GaveUp => {
                // One final generation + intent re-check before the terminal write so a
                // session reconnected/disconnected during the last attempt is not
                // clobbered with an Error (Codex HIGH).
                let still_ours = lifecycle::is_current_generation(generation, gen_arc.load(Ordering::SeqCst));
                let user_disconnecting = disc_arc.lock().map(|g| *g).unwrap_or(false);
                if !still_ours || user_disconnecting {
                    logging::log_app("INFO", "[reconnect] gave up but session no longer ours — suppressing terminal Error");
                    return;
                }
                emit_lifecycle_marker(&app, &reconnect_gave_up_marker(), "warn");
                // Terminal Error through the single emitter carrying the STABLE
                // secret-free reason code — the wording is the i18n key on the
                // frontend, NOT a Russian literal here.
                emit_vpn_status(&app, "error", Some(RECONNECT_GAVE_UP_REASON));
            }
        }
    });
}

/// Convenience trigger: read the saved config/log level + current generation from
/// AppState and start the reconnect supervisor (window-independent). Returns `false`
/// if there is no saved config path to respawn from (the caller then falls back to an
/// honest Disconnected). Used by BOTH triggers: the sidecar Terminated arm (process
/// death) and the connectivity-loss path (live-sidecar drop).
pub(crate) fn start_reconnect_supervisor_from_state(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else { return false; };
    let config_path = state.config_path.lock().ok().and_then(|g| g.clone());
    let Some(config_path) = config_path else { return false; };
    let log_level = state
        .log_level
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "info".to_string());
    let generation = state.connection_generation.load(Ordering::SeqCst);
    logging::log_app("INFO", "[reconnect] unexpected drop — starting supervisor");
    start_reconnect_supervisor(app.clone(), config_path, log_level, generation);
    true
}

/// Kill the sidecar stored in AppState, if any (PID-scoped, own-child only — D-07).
fn kill_sidecar_from_state(state: &AppState) {
    if let Ok(mut guard) = state.sidecar_child.lock() {
        if let Some(child) = guard.take() {
            child.child.kill().ok();
        }
    }
    // Also sweep any stale saved-PID sidecar from a crashed prior session, and clear
    // Light's per-edition PID file so it never targets a future (or other-edition)
    // process. Per-edition + PID-scoped — never image-name (D-07).
    let _ = std::fs::remove_file(sidecar_pid_path());
}


/// Load a tray icon PNG from the icons directory embedded at compile time.
/// Red shield = disconnected/connecting, Green shield = connected.
fn load_tray_icon(status: &str) -> Image<'static> {
    let png_bytes: &[u8] = match status {
        "connected" => include_bytes!("../icons/tray_connected.png"),
        _ => include_bytes!("../icons/tray_disconnected.png"),
    };
    Image::from_bytes(png_bytes).expect("Failed to load tray icon PNG")
}

/// Get current locale from AppState, defaulting to "ru".
fn get_locale(app: &tauri::AppHandle) -> String {
    app.try_state::<AppState>()
        .and_then(|s| s.locale.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "ru".to_string())
}

/// Build the tray context menu based on current VPN status and locale.
fn build_tray_menu(app: &tauri::AppHandle, status: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let locale = get_locale(app);
    let is_ru = locale == "ru";

    let (status_text, toggle_id, toggle_text, toggle_enabled) = match status {
        "connected" => (
            if is_ru { "Подключен" } else { "Connected" },
            "disconnect",
            if is_ru { "Отключиться" } else { "Disconnect" },
            true,
        ),
        "connecting" => (
            if is_ru { "Подключение..." } else { "Connecting..." },
            "disconnect",
            if is_ru { "Отменить" } else { "Cancel" },
            true,
        ),
        "recovering" => (
            if is_ru { "Переподключение..." } else { "Reconnecting..." },
            "disconnect",
            if is_ru { "Отключиться" } else { "Disconnect" },
            true,
        ),
        "disconnecting" => (
            if is_ru { "Отключение..." } else { "Disconnecting..." },
            "noop",
            if is_ru { "Отключение..." } else { "Disconnecting..." },
            false,
        ),
        "error" => (
            if is_ru { "Ошибка" } else { "Error" },
            "connect",
            if is_ru { "Подключиться" } else { "Connect" },
            true,
        ),
        _ => (
            if is_ru { "Отключен" } else { "Disconnected" },
            "connect",
            if is_ru { "Подключиться" } else { "Connect" },
            true,
        ),
    };

    let status_item = MenuItemBuilder::with_id("status", status_text)
        .enabled(false)
        .build(app)?;
    let toggle_item = MenuItemBuilder::with_id(toggle_id, toggle_text)
        .enabled(toggle_enabled)
        .build(app)?;
    let show_item = MenuItemBuilder::with_id(
        "show",
        if is_ru { "Показать окно" } else { "Show Window" },
    ).build(app)?;
    let quit_item = MenuItemBuilder::with_id(
        "quit",
        if is_ru { "Выход" } else { "Quit" },
    ).build(app)?;

    MenuBuilder::new(app)
        .item(&status_item)
        .separator()
        .item(&toggle_item)
        .separator()
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()
}

/// Update tray icon, tooltip, and menu based on VPN status.
fn update_tray_icon(app: &tauri::AppHandle, status: &str) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let icon_status = match status {
            "connected" => "connected",
            _ => "disconnected",
        };
        let locale = get_locale(app);
        let is_ru = locale == "ru";
        let tooltip = match status {
            "connected" => if is_ru { "TrustTunnel Light — Подключен" } else { "TrustTunnel Light — Connected" },
            "connecting" => if is_ru { "TrustTunnel Light — Подключение..." } else { "TrustTunnel Light — Connecting..." },
            "recovering" => if is_ru { "TrustTunnel Light — Переподключение..." } else { "TrustTunnel Light — Reconnecting..." },
            "disconnecting" => if is_ru { "TrustTunnel Light — Отключение..." } else { "TrustTunnel Light — Disconnecting..." },
            "error" => if is_ru { "TrustTunnel Light — Ошибка" } else { "TrustTunnel Light — Error" },
            _ => if is_ru { "TrustTunnel Light — Отключен" } else { "TrustTunnel Light — Disconnected" },
        };
        tray.set_icon(Some(load_tray_icon(icon_status))).ok();
        tray.set_tooltip(Some(tooltip)).ok();

        // Rebuild menu to reflect new status
        if let Ok(menu) = build_tray_menu(app, status) {
            tray.set_menu(Some(menu)).ok();
        }
    }
}

/// Connect VPN from tray menu (no frontend involvement).
fn tray_vpn_connect(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return; };

    // Check if already running
    if let Ok(guard) = state.sidecar_child.lock() {
        if guard.is_some() { return; }
    }

    // Get config path: stored from last connect, or auto-detect
    let config_path = state.config_path.lock().ok()
        .and_then(|g| g.clone())
        .or_else(|| commands::config::auto_detect_config());

    let Some(config_path) = config_path else {
        // No config found — show the window so user can configure
        if let Some(w) = app.get_webview_window("main") {
            w.show().ok();
            w.set_focus().ok();
        }
        return;
    };

    let log_level = state.log_level.lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "info".to_string());

    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else { return; };

        // Emit connecting status
        app.emit("vpn-status", serde_json::json!({"status": "connecting"})).ok();

        // Kill ONLY our own stale sidecar from a crashed prior session (PID-scoped,
        // per-edition — never image-name, D-07). This releases a WinTUN adapter a
        // crashed Light sidecar may still hold, without touching Pro's process.
        kill_stale_sidecar();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Reset flags
        if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
        if let Ok(mut c) = state.is_connected.lock() { *c = false; }

        // Bump generation so this tray-started session owns a distinct number; the
        // watchdog below captures it (Codex HIGH).
        let connect_generation = state.connection_generation.fetch_add(1, Ordering::SeqCst) + 1;

        let child_arc = Arc::clone(&state.sidecar_child);
        let disc_arc = Arc::clone(&state.disconnecting);
        let conn_arc = Arc::clone(&state.is_connected);

        let sidecar_log_level = match log_level.as_str() {
            "error" | "warn" => "info",
            other => other,
        };

        match sidecar::spawn_trusttunnel(&app, &config_path, sidecar_log_level, child_arc, disc_arc, conn_arc).await {
            Ok(child) => {
                eprintln!("[tray_vpn_connect] Sidecar spawned OK");
                // Save PID for per-edition stale-cleanup after a crash (D-07).
                save_sidecar_pid(child.child.pid());
                if let Ok(mut guard) = state.sidecar_child.lock() {
                    *guard = Some(child);
                }
                app.emit("vpn-status", serde_json::json!({"status": "connecting"})).ok();
                // Connect-timeout watchdog for the tray-started session (D-05), same
                // generation-guarded 60s escape as the command path.
                spawn_connect_timeout_watchdog(&app, connect_generation);
            }
            Err(e) => {
                eprintln!("[tray_vpn_connect] Failed: {e}");
                app.emit("vpn-status", serde_json::json!({"status": "error", "error": e.to_string()})).ok();
            }
        }
    });
}

/// Disconnect VPN from tray menu.
fn tray_vpn_disconnect(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return; };

    let child = {
        let Ok(mut guard) = state.sidecar_child.lock() else { return; };
        guard.take()
    };

    if let Some(child) = child {
        if let Ok(mut d) = child.disconnecting.lock() { *d = true; }
        if let Ok(mut d) = state.disconnecting.lock() { *d = true; }
        // Bump the generation so any in-flight watchdog / supervisor neutralizes
        // itself (Codex HIGH) — a tray disconnect must never be fought.
        state.connection_generation.fetch_add(1, Ordering::SeqCst);
        // D-08 lifecycle marker (8): sidecar killed on exit — fixed phrase, DEV-gated.
        emit_lifecycle_marker(&app, killed_on_exit_marker(), "info");

        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            sidecar::kill_sidecar(child).await.ok();
            app_clone.emit("vpn-status", serde_json::json!({"status": "disconnected"})).ok();
        });
    }
}

#[derive(Clone, Serialize)]
struct VpnLogPayload {
    message: String,
    level: String,
}

#[derive(Clone, Serialize)]
struct VpnStatusPayload {
    status: String,
    error: Option<String>,
}

struct AppState {
    sidecar_child: Arc<Mutex<Option<sidecar::SidecarChild>>>,
    disconnecting: Arc<Mutex<bool>>,
    is_connected: Arc<Mutex<bool>>,
    /// Phase 2 Plan 10 (Tier-3) — the last status string + error the single emitter
    /// `emit_vpn_status` published, so two race guards have a source of truth Light
    /// otherwise lacks (it has no `VpnStatus` enum / `last_error` like Pro):
    /// - the connect-timeout watchdog reads it to avoid OVERWRITING a specific Error
    ///   (auth / config / Wintun) with the generic connect-timeout (T-10-04), and
    /// - the reconnect supervisor reads the error reason after a failed attempt to
    ///   SHORT-CIRCUIT a terminal failure instead of burning all 3 retries (T-10-03).
    ///
    /// `(status, error)` mirrors the exact `{status, error}` shape every consumer reads;
    /// `error` is the already-secret-free reason code / derived phrase (D-29).
    last_status: Arc<Mutex<(String, Option<String>)>>,
    tray_notified: Arc<Mutex<bool>>,
    /// Last-used config path for tray-initiated connect.
    config_path: Arc<Mutex<Option<String>>>,
    /// Last-used log level for tray-initiated connect.
    log_level: Arc<Mutex<String>>,
    /// Current UI locale ("ru" or "en") for tray menu text.
    locale: Arc<Mutex<String>>,
    /// Phase 2 — monotonic connection generation (Codex HIGH stale-actor guard).
    ///
    /// Bumped with `fetch_add(1, SeqCst)` on every connect AND every disconnect, so
    /// each VPN session owns a distinct generation number. The connect-timeout
    /// watchdog and the reconnect supervisor capture the value at spawn and re-check
    /// it via `lifecycle::is_current_generation` before any kill / status-write: if a
    /// manual reconnect or a user disconnect advanced the live generation past the
    /// captured one, the stale actor aborts instead of acting on a session it no
    /// longer owns. Starts at 0. Mirror of Pro's `AppState.connection_generation`.
    connection_generation: Arc<AtomicU64>,
    /// Phase 2 — single-supervisor guard (CR-02 nested-supervisor race).
    ///
    /// Set to `true` by `start_reconnect_supervisor` BEFORE its bounded-3 loop and
    /// cleared on EVERY exit path via an RAII guard. While `true` a supervisor is live
    /// and OWNS recovery for the current drop, so the sidecar's `Terminated` arm and
    /// the connectivity-loss path must NOT spawn a SECOND supervisor when the
    /// supervisor's own respawned child dies again (server still down). A genuine NEW
    /// drop AFTER the supervisor gives up still starts a fresh supervisor (the flag is
    /// cleared on GaveUp). Starts at `false`. Mirror of Pro's `reconnect_in_progress`.
    reconnect_in_progress: Arc<AtomicBool>,
    /// Phase 2 Plan 09 (UAT Gap #2) — per-attempt pre-flight connectivity result.
    ///
    /// Set on EVERY `vpn_connect` BEFORE the sidecar spawns: `true` when the
    /// non-blocking pre-flight (`connectivity::check_adapter_online`) saw the network
    /// as unreachable, `false` otherwise. The pre-flight NEVER blocks the connect
    /// (cross-AI: captive / corporate nets that block gateway TCP still connect) — it
    /// only records this flag, which the sidecar's `Terminated` arm reads to classify
    /// a never-connected non-zero exit (no-internet vs sidecar-exit). Starts at
    /// `false`. Mirror of Pro's `last_preflight_offline`.
    last_preflight_offline: Arc<AtomicBool>,
}

#[tauri::command]
fn set_start_minimized(enabled: bool) -> Result<(), String> {
    let flag_path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no parent dir")?
        .join(".start_minimized");
    if enabled {
        std::fs::write(&flag_path, "1").map_err(|e| e.to_string())?;
    } else {
        let _ = std::fs::remove_file(&flag_path);
    }
    Ok(())
}

#[tauri::command]
fn get_start_minimized() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(".start_minimized")))
        .map(|p| p.exists())
        .unwrap_or(false)
}

// ─── Dev-only aggregated log window (T-14, Light mirror of Pro) ───
//
// Opens a SEPARATE window pointed at the `log-window.html` Vite entry, rendering
// the aggregated log viewer (sanitized `vpn-log` stream + select/copy/export).
// Replaces the F12 DevTools need (F12 stays disabled per D-11).
//
// CRITICAL — release safety: BOTH this command AND its registration in the
// invoke_handler below are gated behind `#[cfg(feature = "devtools")]`. A public
// build (`cargo build` WITHOUT `--features devtools`) contains neither the command
// nor any path that constructs the window, so the dev log window provably cannot
// ship. The `devtools` feature is newly added to Cargo.toml to match Pro's gate.
#[cfg(feature = "devtools")]
#[tauri::command]
fn open_log_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    if let Some(existing) = app.get_webview_window("log-window") {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        &app,
        "log-window",
        WebviewUrl::App("log-window.html".into()),
    )
    .title("TrustTunnel Light — Логи (dev)")
    .inner_size(900.0, 600.0)
    .min_inner_size(500.0, 300.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn vpn_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config_path: String,
    log_level: String,
) -> Result<(), String> {
    eprintln!("[vpn_connect] Called with config_path={config_path}, log_level={log_level}");
    logging::log_app("INFO", &format!("VPN connect: config={config_path}, log_level={log_level}"));

    // Write system diagnostics snapshot (if logging enabled)
    if logging::is_logging_enabled() {
        diagnostics::write_system_snapshot();
    }

    // Remember config for tray-initiated reconnect
    if let Ok(mut cp) = state.config_path.lock() { *cp = Some(config_path.clone()); }
    if let Ok(mut ll) = state.log_level.lock() { *ll = log_level.clone(); }

    // D-08 lifecycle marker (1): connect start. A FIXED phrase — the old
    // "Connecting with config: {config_path}" emit leaked the path onto the vpn-log
    // channel the DEV F12 mirror prints, so it is replaced with a secret-free marker
    // (D-09/D-29). DEV-gated via emit_lifecycle_marker (D-11). The config path is
    // still recorded in app.log via the sanitized log_app call above.
    emit_lifecycle_marker(&app, connect_start_marker(), "info");

    // Check and drop guard before async call
    {
        let guard = state
            .sidecar_child
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        if guard.is_some() {
            return Err("VPN is already running".into());
        }
    }

    // Kill ONLY our own stale sidecar (per-edition saved PID) that might hold the
    // WinTUN adapter — never every edition's sidecar by image name (D-07). This is
    // the PID-scoped replacement for the deleted `kill_all_sidecar_processes`.
    kill_stale_sidecar();
    // Give OS a moment to release the adapter
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    app.emit("vpn-log", VpnLogPayload {
        message: "Spawning trusttunnel_client process...".into(),
        level: "info".into(),
    }).ok();

    // Reset flags for new connection
    if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
    if let Ok(mut c) = state.is_connected.lock() { *c = false; }

    // ── Non-blocking pre-flight connectivity check (02-09, UAT Gap #2) ──────
    //
    // cross-AI REWORK (mirror of Pro): we do NOT block the connect on this. Captive
    // / corporate nets that block gateway TCP but allow the VPN must still connect
    // (T-09-03, disposition: accept). WARNING ONLY — it records the per-attempt flag
    // the sidecar Terminated arm reads to classify a never-connected non-zero exit as
    // `no-internet` vs `sidecar-exit`, and emits a DEV-gated fixed-phrase marker. It
    // NEVER returns early / blocks the spawn.
    let preflight_offline = !connectivity::check_adapter_online().await;
    state.last_preflight_offline.store(preflight_offline, Ordering::SeqCst);
    if preflight_offline {
        emit_lifecycle_marker(&app, preflight_offline_marker(), "warn");
    }

    // Bump the connection generation so THIS session owns a distinct number (Codex
    // HIGH stale-actor guard). The connect-timeout watchdog spawned below captures
    // the post-bump value and re-checks it before any kill / status-write; a later
    // manual reconnect / disconnect bumps it again and neutralizes this watchdog.
    // `fetch_add` returns the PRE-increment value, so this session's generation is
    // that + 1.
    let connect_generation = state.connection_generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Pass Arc clones so sidecar can clear itself on termination
    let child_arc = Arc::clone(&state.sidecar_child);
    let disc_arc = Arc::clone(&state.disconnecting);
    let conn_arc = Arc::clone(&state.is_connected);

    // Always use at least "info" for sidecar — "Successfully connected to endpoint"
    // is an INFO message; suppressing it breaks connection status detection.
    let sidecar_log_level = match log_level.as_str() {
        "error" | "warn" => "info",
        other => other,
    };

    let child = sidecar::spawn_trusttunnel(&app, &config_path, sidecar_log_level, child_arc, disc_arc, conn_arc)
        .await
        .map_err(|e| {
            let msg = format!("Failed to start sidecar: {e}");
            eprintln!("[vpn_connect] {msg}");
            logging::log_app("ERROR", &msg);
            app.emit("vpn-log", VpnLogPayload {
                message: msg.clone(),
                level: "error".into(),
            }).ok();
            msg
        })?;

    // Save PID for per-edition stale-cleanup after a crash (D-07).
    save_sidecar_pid(child.child.pid());

    eprintln!("[vpn_connect] Sidecar spawned OK, storing child handle");
    logging::log_app("INFO", "Sidecar spawned OK");
    app.emit("vpn-log", VpnLogPayload {
        message: "Sidecar process started successfully".into(),
        level: "info".into(),
    }).ok();

    // Re-acquire lock to store child
    {
        let mut guard = state
            .sidecar_child
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        *guard = Some(child);
    }

    // Status stays "connecting" until sidecar detects "Successfully connected to endpoint"
    app.emit(
        "vpn-status",
        VpnStatusPayload {
            status: "connecting".into(),
            error: None,
        },
    )
    .ok();

    // Connect-timeout watchdog (D-05, F1) — generation-guarded 60s escape from a hung
    // "Connecting…", mirror of Pro. Captures this session's generation so a later
    // manual reconnect / disconnect neutralizes it (Codex HIGH).
    spawn_connect_timeout_watchdog(&app, connect_generation);

    Ok(())
}

#[tauri::command]
async fn vpn_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Always set disconnecting first so a stale watchdog / supervisor sees user
    // intent (D-04), and bump the generation so any in-flight watchdog from the
    // session being torn down sees a mismatch and neutralizes itself (Codex HIGH).
    if let Ok(mut d) = state.disconnecting.lock() { *d = true; }
    state.connection_generation.fetch_add(1, Ordering::SeqCst);

    // Take child out and drop guard before async call
    let child = {
        let mut guard = state
            .sidecar_child
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        guard.take()
    };

    if let Some(child) = child {
        // Signal intentional disconnect before killing
        if let Ok(mut d) = child.disconnecting.lock() { *d = true; }
        if let Ok(mut d) = state.disconnecting.lock() { *d = true; }
        // D-08 lifecycle marker (8): sidecar killed on exit — fixed phrase, DEV-gated.
        emit_lifecycle_marker(&app, killed_on_exit_marker(), "info");
        sidecar::kill_sidecar(child)
            .await
            .map_err(|e| format!("Failed to stop sidecar: {e}"))?;
    }

    logging::log_app("INFO", "VPN disconnected");

    app.emit(
        "vpn-status",
        VpnStatusPayload {
            status: "disconnected".into(),
            error: None,
        },
    )
    .ok();

    Ok(())
}

#[tauri::command]
async fn test_sidecar(
    app: tauri::AppHandle,
) -> Result<String, String> {
    eprintln!("[test_sidecar] Spawning sidecar with -v flag...");
    let result = sidecar::spawn_with_args(&app, &["-v"])
        .await
        .map_err(|e| {
            let msg = format!("Failed to run sidecar: {e}");
            eprintln!("[test_sidecar] {msg}");
            msg
        })?;
    eprintln!("[test_sidecar] Got response: {result}");

    // Emit each line as a vpn-log event so it shows in the LogPanel
    for line in result.lines() {
        app.emit(
            "vpn-log",
            VpnLogPayload {
                message: line.to_string(),
                level: "info".to_string(),
            },
        )
        .ok();
    }

    Ok(result)
}

#[tauri::command]
fn check_vpn_status(state: tauri::State<'_, AppState>) -> String {
    // WR-07: recover a poisoned mutex instead of panicking the command. Every other
    // lock site in this phase uses `unwrap_or_else(|e| e.into_inner())` poison
    // recovery — this bare `.unwrap()` was the lone straggler that would panic (and
    // poison-cascade) if `sidecar_child` was ever poisoned by a panic in another
    // holder.
    let guard = state.sidecar_child.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        let connected = state.is_connected.lock().map(|g| *g).unwrap_or(false);
        if connected { "connected" } else { "connecting" }.to_string()
    } else {
        "disconnected".to_string()
    }
}

/// Clear a VPN error from ALL windows (02-09, UAT Gap #3) — mirror of Pro's
/// `clear_vpn_error`.
///
/// The React error banner used to dismiss with LOCAL state only, so the error
/// lingered on every OTHER window. This command broadcasts the clear through the
/// single `emit_vpn_status` writer (status `"disconnected"`, error `None`) so every
/// window's `vpn-status` listener clears the error at once.
///
/// T-09-02 (Tampering): NO-OP while a live session exists. Light has no persisted
/// backend `Error` state to gate on (unlike Pro's `VpnStatus` enum), so the closest
/// safe analogue is: only clear when NO sidecar is running — i.e. the error is a
/// dead, never-connected / dropped-session error, never a live connect / connection.
/// A stray dismiss from a stale window can therefore never knock a running session
/// offline.
#[tauri::command]
fn clear_vpn_error(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    let session_live = state
        .sidecar_child
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if session_live {
        // A sidecar is running (connecting / connected / recovering) — do NOT clobber
        // it (T-09-02). The dismiss is only legal for a dead error state.
        return;
    }
    emit_vpn_status(&app, "disconnected", None);
}

/// Run a simple speed test using Cloudflare endpoints.
/// Returns { download_mbps, upload_mbps } or an error.
#[tauri::command]
async fn speedtest_run() -> Result<serde_json::Value, String> {
    use std::time::Instant;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Download test: fetch 5MB from Cloudflare
    let dl_bytes: usize = 5_000_000;
    let dl_url = format!("https://speed.cloudflare.com/__down?bytes={dl_bytes}");
    let dl_start = Instant::now();
    let dl_resp = client
        .get(&dl_url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;
    let dl_data = dl_resp
        .bytes()
        .await
        .map_err(|e| format!("Download read failed: {e}"))?;
    let dl_elapsed = dl_start.elapsed().as_secs_f64();
    let dl_actual = dl_data.len() as f64;
    let download_mbps = if dl_elapsed > 0.0 {
        (dl_actual * 8.0) / (dl_elapsed * 1_000_000.0)
    } else {
        0.0
    };

    // Upload test: send 2MB to Cloudflare
    let ul_size: usize = 2_000_000;
    let ul_payload = vec![0u8; ul_size];
    let ul_start = Instant::now();
    let _ul_resp = client
        .post("https://speed.cloudflare.com/__up")
        .body(ul_payload)
        .send()
        .await
        .map_err(|e| format!("Upload request failed: {e}"))?;
    let ul_elapsed = ul_start.elapsed().as_secs_f64();
    let upload_mbps = if ul_elapsed > 0.0 {
        (ul_size as f64 * 8.0) / (ul_elapsed * 1_000_000.0)
    } else {
        0.0
    };

    Ok(serde_json::json!({
        "download_mbps": (download_mbps * 10.0).round() / 10.0,
        "upload_mbps": (upload_mbps * 10.0).round() / 10.0,
    }))
}

/// Measure TCP connect latency to a host:port (in milliseconds).
/// Returns -1 if unreachable.
#[tauri::command]
async fn ping_endpoint(host: String, port: u16) -> i64 {
    use std::net::ToSocketAddrs;
    use std::time::Instant;

    let addr_str = format!("{host}:{port}");
    let addr = match addr_str.to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(a) => a,
            None => return -1,
        },
        Err(_) => return -1,
    };

    let start = Instant::now();
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(_stream)) => start.elapsed().as_millis() as i64,
        _ => -1,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                w.show().ok();
                w.set_focus().ok();
            }
            if let Some(url) = args.iter().find(|a| a.starts_with("trusttunnel://") || a.starts_with("tt://")) {
                app.emit("deep-link-url", serde_json::json!({ "url": url })).ok();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(AppState {
            sidecar_child: Arc::new(Mutex::new(None)),
            disconnecting: Arc::new(Mutex::new(false)),
            is_connected: Arc::new(Mutex::new(false)),
            // 02-10 (Tier-3): start at the disconnected baseline with no error.
            last_status: Arc::new(Mutex::new(("disconnected".to_string(), None))),
            tray_notified: Arc::new(Mutex::new(false)),
            config_path: Arc::new(Mutex::new(None)),
            log_level: Arc::new(Mutex::new("info".to_string())),
            locale: Arc::new(Mutex::new("ru".to_string())),
            connection_generation: Arc::new(AtomicU64::new(0)),
            // Phase 2 — single-supervisor guard (CR-02). Starts false; the reconnect
            // supervisor sets it while live so the Terminated arm / connectivity-loss
            // path cannot spawn a second.
            reconnect_in_progress: Arc::new(AtomicBool::new(false)),
            // Phase 2 Plan 09 (UAT Gap #2) — per-attempt pre-flight connectivity result.
            // Starts false; vpn_connect sets it before spawn so the sidecar Terminated
            // arm classifies a never-connected exit (no-internet vs sidecar-exit). The
            // pre-flight is warning-only and never blocks connecting.
            last_preflight_offline: Arc::new(AtomicBool::new(false)),
        })
        .manage(Arc::new(geodata_v2ray::GeoDataState::new()))
        .setup(|app| {
            // Initialize file logging (if enabled via flag file)
            logging::init_logging();

            // Show window unless start_minimized flag file exists next to exe
            if let Some(window) = app.get_webview_window("main") {
                // Force decorations off (window-state plugin may restore old value)
                window.set_decorations(false).ok();

                let start_minimized = std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.parent().map(|d| d.join(".start_minimized")))
                    .map(|p| p.exists())
                    .unwrap_or(false);
                if !start_minimized {
                    window.show().ok();
                }
            }

            // Build tray context menu
            let tray_menu = build_tray_menu(app.handle(), "disconnected")?;

            // Load disconnected tray icon (red) as initial state
            let initial_icon = load_tray_icon("disconnected");

            // Create tray icon with ID so we can update it later
            TrayIconBuilder::with_id("main-tray")
                .icon(initial_icon)
                .tooltip("TrustTunnel Light — Отключен")
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                w.show().ok();
                                w.set_focus().ok();
                            }
                        }
                        "connect" => {
                            tray_vpn_connect(app.clone());
                        }
                        "disconnect" => {
                            tray_vpn_disconnect(app.clone());
                        }
                        "quit" => {
                            // Kill only our own sidecar, not other app's processes
                            if let Some(state) = app.try_state::<AppState>() {
                                kill_sidecar_from_state(&state);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            w.show().ok();
                            w.set_focus().ok();
                        }
                    }
                })
                .build(app)?;

            // Set window icon (taskbar)
            if let Some(w) = app.get_webview_window("main") {
                let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))
                    .expect("Failed to load window icon");
                w.set_icon(icon).ok();
            }

            // Start connectivity monitor
            let is_conn_for_monitor = Arc::clone(&app.state::<AppState>().is_connected);
            connectivity::start_monitor(app.handle().clone(), is_conn_for_monitor);

            // Start geodata file watcher
            let geodata_state = app.state::<Arc<geodata_v2ray::GeoDataState>>().inner().clone();
            geodata_v2ray::start_geodata_watcher(app.handle().clone(), geodata_state);

            // Listen for vpn-status events to update tray icon color
            use tauri::Listener;
            let app_handle = app.handle().clone();
            app.listen_any("vpn-status", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if let Some(status) = payload.get("status").and_then(|s| s.as_str()) {
                        update_tray_icon(&app_handle, status);
                    }
                }
            });

            // Listen for language changes from frontend to rebuild tray menu
            let app_handle2 = app.handle().clone();
            app.listen_any("update-tray-language", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if let Some(lang) = payload.get("language").and_then(|l| l.as_str()) {
                        if let Some(state) = app_handle2.try_state::<AppState>() {
                            if let Ok(mut locale) = state.locale.lock() {
                                *locale = lang.to_string();
                            }
                        }
                        // Rebuild tray menu with new language, current status
                        let status = app_handle2.try_state::<AppState>()
                            .map(|s| {
                                let has_child = s.sidecar_child.lock().map(|g| g.is_some()).unwrap_or(false);
                                let connected = s.is_connected.lock().map(|g| *g).unwrap_or(false);
                                if has_child {
                                    if connected { "connected" } else { "connecting" }
                                } else {
                                    "disconnected"
                                }
                            })
                            .unwrap_or("disconnected");
                        update_tray_icon(&app_handle2, status);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();

                // Show notification once that app is still running in tray
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let mut notified = state.tray_notified.lock().unwrap_or_else(|e| e.into_inner());
                    if !*notified {
                        *notified = true;
                        use tauri_plugin_notification::NotificationExt;
                        window.app_handle().notification()
                            .builder()
                            .title("TrustTunnel Light")
                            .body("Приложение свёрнуто в трей. Нажмите на иконку, чтобы открыть.")
                            .show()
                            .ok();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            vpn_connect,
            vpn_disconnect,
            check_vpn_status,
            clear_vpn_error,
            test_sidecar,
            set_start_minimized,
            get_start_minimized,
            // Dev-only log window (T-14) — gated identically to the command so a
            // release build registers no handler and cannot construct the window.
            #[cfg(feature = "devtools")]
            open_log_window,
            logging::set_logging_enabled,
            logging::get_logging_enabled,
            logging::open_logs_folder,
            commands::config::copy_file,
            commands::config::copy_config_to_app_dir,
            commands::config::auto_detect_config,
            commands::config::import_dropped_content,
            commands::config::config_file_exists,
            commands::config::watch_config_file,
            commands::config::unwatch_config_file,
            commands::config::read_client_config,
            commands::config::save_client_config,
            commands::deeplink::decode_deeplink,
            commands::deeplink::import_config_from_string,
            commands::updater::self_update,
            geodata::load_exclusion_list,
            geodata::save_exclusion_list,
            geodata::load_exclusion_json,
            geodata::save_exclusion_json,
            geodata::fetch_whitelist_domains,
            geodata::get_iplist_groups,
            geodata::fetch_iplist_group_domains,
            geodata::load_active_groups,
            geodata::save_active_groups,
            geodata::load_group_cache,
            geodata_v2ray::download_geodata,
            geodata_v2ray::get_geodata_status,
            geodata_v2ray::check_geodata_updates,
            geodata_v2ray::load_geodata_categories,
            routing_rules::load_routing_rules,
            routing_rules::save_routing_rules,
            routing_rules::export_routing_rules,
            routing_rules::import_routing_rules,
            routing_rules::migrate_legacy_exclusions,
            routing_rules::resolve_and_apply,
            routing_rules::update_vpn_mode,
            routing_rules::cleanup_hosts_block,
            processes::list_running_processes,
            ping_endpoint,
            speedtest_run,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Final cleanup: kill only our own sidecar (not other app's processes)
                if let Some(state) = app.try_state::<AppState>() {
                    kill_sidecar_from_state(&state);
                }
                // Clean up hosts file blocked entries
                routing_rules::cleanup_hosts_block().ok();
            }
        });
}

#[cfg(test)]
mod reconnect_supervisor_tests {
    use super::*;
    use std::cell::Cell;
    use std::time::{Duration, Instant};

    fn never_sleeps() {}

    #[tokio::test]
    async fn light_reconnect_bounded_to_three() {
        // D-02: with a try-connect that always fails SLOWLY (past FAST_FAIL_GRACE so
        // the loop would normally sleep), the loop calls it exactly 3 times and ends
        // in GaveUp — never a 4th attempt. Mirror of Pro's attempts_bounded_to_three.
        let calls = Cell::new(0u32);
        let sleeps = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            7,
            |_attempt| {
                calls.set(calls.get() + 1);
                // Transient reason (None) so the terminal short-circuit does NOT fire.
                async { (false, lifecycle::FAST_FAIL_GRACE + Duration::from_secs(1), None) }
            },
            || false, // user not disconnecting
            || 7,      // generation unchanged
            |_attempt| {},
            || {
                sleeps.set(sleeps.get() + 1);
                async {}
            },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::GaveUp);
        assert_eq!(calls.get(), 3, "must attempt exactly RECONNECT_MAX_ATTEMPTS times");
        assert_eq!(lifecycle::RECONNECT_MAX_ATTEMPTS, 3);
        assert_eq!(sleeps.get(), 2, "snappy interval slept only between attempts");
    }

    #[tokio::test]
    async fn light_respects_disconnecting_flag() {
        // D-04: a user-initiated disconnect must NOT reconnect — abort before any
        // attempt or status-write.
        let calls = Cell::new(0u32);
        let reconnecting = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            1,
            |_attempt| {
                calls.set(calls.get() + 1);
                async { (false, Duration::from_secs(10), None) }
            },
            || true, // user disconnecting → abort
            || 1,
            |_attempt| reconnecting.set(reconnecting.get() + 1),
            || async { never_sleeps() },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::Aborted);
        assert_eq!(calls.get(), 0, "no respawn when the user is disconnecting");
        assert_eq!(reconnecting.get(), 0, "no Reconnecting status write either");
    }

    #[tokio::test]
    async fn light_stops_when_generation_advanced() {
        // Codex HIGH: a manual reconnect / disconnect that bumped the generation
        // neutralizes the stale supervisor.
        let calls = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            5,
            |_attempt| {
                calls.set(calls.get() + 1);
                async { (false, Duration::from_secs(10), None) }
            },
            || false,
            || 6, // live generation advanced past captured → stale
            |_attempt| {},
            || async { never_sleeps() },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::Aborted);
        assert_eq!(calls.get(), 0, "a stale supervisor must not respawn");
    }

    #[tokio::test]
    async fn light_fast_fail_skips_full_window() {
        // Gemini fast-fail: an instantly-dying respawn counts the failure without
        // sleeping the full window.
        let sleeps = Cell::new(0u32);
        let start = Instant::now();
        let outcome = run_reconnect_loop(
            1,
            |_attempt| async {
                // Instant death: elapsed below FAST_FAIL_GRACE → fast-fail. Transient
                // (None) so the fast-fail path is under test, not the terminal one.
                (false, Duration::from_millis(1), None)
            },
            || false,
            || 1,
            |_attempt| {},
            || {
                sleeps.set(sleeps.get() + 1);
                async { tokio::time::sleep(lifecycle::RECONNECT_INTERVAL).await }
            },
        )
        .await;
        let elapsed = start.elapsed();

        assert_eq!(outcome, SupervisorOutcome::GaveUp);
        assert_eq!(sleeps.get(), 0, "fast-fail must skip the inter-attempt sleep");
        assert!(
            elapsed < lifecycle::RECONNECT_ATTEMPT_WINDOW,
            "fast-fail path must not wait out even a single full window (elapsed={elapsed:?})",
        );
    }

    #[tokio::test]
    async fn light_terminal_reason_stops_after_first_attempt() {
        // 02-10 (T-10-03) mirror of Pro: a TERMINAL failure reason short-circuits the
        // bounded-3 loop after attempt 1 — the user sees the honest error immediately
        // instead of after three pointless retries. Outcome is GaveUp, calls == 1.
        let calls = Cell::new(0u32);
        let sleeps = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            7,
            |_attempt| {
                calls.set(calls.get() + 1);
                async {
                    (
                        false,
                        lifecycle::FAST_FAIL_GRACE + Duration::from_secs(1),
                        Some("Authorization failed".to_string()),
                    )
                }
            },
            || false,
            || 7,
            |_attempt| {},
            || {
                sleeps.set(sleeps.get() + 1);
                async {}
            },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::GaveUp);
        assert_eq!(calls.get(), 1, "terminal reason must stop after the FIRST attempt");
        assert_eq!(sleeps.get(), 0, "no inter-attempt sleep on a terminal short-circuit");
    }

    #[test]
    fn light_terminal_error_uses_reason_code_not_cyrillic() {
        // CLAUDE.md i18n rule + D-29: the give-up Error value is the stable ASCII
        // "reconnect-gave-up" — no Cyrillic / display string.
        let reason = RECONNECT_GAVE_UP_REASON;
        assert_eq!(reason, "reconnect-gave-up");
        assert!(reason.is_ascii(), "reason code must be ASCII");
        assert!(
            !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic",
        );
    }

    #[test]
    fn light_watchdog_decision_guards() {
        // 02-10 (T-10-04) mirror of Pro's watchdog tests. Abort only when not
        // connected, not disconnecting, not already-error, and still the live gen.
        // Abort case.
        assert!(decide_timeout_action(false, false, false, 5, 5));
        // Connected → NoOp.
        assert!(!decide_timeout_action(true, false, false, 5, 5));
        // Disconnecting → NoOp.
        assert!(!decide_timeout_action(false, true, false, 5, 5));
        // 02-10 (T-10-04): already a specific Error → NoOp (no connect-timeout clobber).
        assert!(!decide_timeout_action(false, false, true, 5, 5));
        // Generation advanced → stale → NoOp.
        assert!(!decide_timeout_action(false, false, false, 5, 6));
    }

    #[test]
    fn light_stale_kill_is_image_and_pid_filtered() {
        // 02-10 (T-10-01) mirror of Pro: the kill MUST carry BOTH an IMAGENAME filter
        // for Light's sidecar exe AND a PID filter, so a reboot-recycled PID on a
        // DIFFERENT image is never force-killed. The old blind `["/F","/PID",<pid>]`
        // form must NOT reappear; the `PID eq` filter preserves edition isolation.
        let args = stale_kill_args(4321);
        assert!(
            args.iter().any(|a| a == &format!("IMAGENAME eq {SIDECAR_IMAGE_NAME}")),
            "must filter on the sidecar image name so a recycled PID on another image is a no-op",
        );
        assert!(args.iter().any(|a| a == "PID eq 4321"), "must still scope to Light's own saved PID");
        assert!(args.iter().any(|a| a == "/F"), "force flag still present for Light's own crashed sidecar");
        assert!(
            !args.windows(2).any(|w| w[0] == "/PID"),
            "blind /PID kill must not return — it could /F-kill an unrelated recycled PID",
        );
        assert_eq!(SIDECAR_IMAGE_NAME, "trusttunnel_client.exe");
    }

    #[test]
    fn light_markers_carry_no_secret() {
        // D-09/D-29: every new Light lifecycle marker is a fixed/derived phrase —
        // assert no config/credential reaches the vpn-log channel, and that
        // sanitize() is a no-op (nothing to redact).
        //
        // The secret is DIGIT-FREE on purpose: the markers legitimately contain the
        // non-secret PID (1245) and attempt counts (2/3, 3/3), so a digit-bearing
        // secret would false-positive the char-level check on a legitimate count
        // digit (the same class of clash Pro avoided with PID 1245). Its unusual
        // chars (P S X Y Z @ _ !) appear in none of the markers.
        const SAMPLE_SECRET: &str = "P@sSw_rdXYZ!";
        let markers = [
            connect_start_marker().to_string(),
            spawn_pid_marker(1245),
            handshake_marker().to_string(),
            drop_detected_marker().to_string(),
            reconnect_attempt_marker(2),
            reconnect_gave_up_marker(),
            killed_on_exit_marker().to_string(),
        ];
        for m in markers {
            assert!(!m.contains(SAMPLE_SECRET), "marker leaked the secret: {m:?}");
            for ch in SAMPLE_SECRET
                .chars()
                .filter(|c| !c.is_ascii_alphabetic() || c.is_ascii_uppercase())
            {
                assert!(!m.contains(ch), "marker {m:?} leaked char {ch:?} from the secret");
            }
            assert_eq!(
                logging::sanitize(&m),
                m,
                "marker {m:?} contained something the sanitizer redacted — possible leak"
            );
        }
    }
}
