use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::commands::{AppState, vpn::{VpnStatus, set_vpn_status}};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─── Phase 2 Plan 05 (D-08/D-09/D-11): lifecycle markers ─────────────────────
//
// The observability slice surfaces the minimum lifecycle event set on the
// existing `vpn-log` channel so a DEV build can mirror them to the F12 console
// (D-08) and the user can paste them back. EVERY new marker is a FIXED/derived
// phrase — built only from compile-time text + a non-secret PID (A2) — so a
// credential or raw config text can NEVER reach the channel (D-09 / D-29 /
// CR-01 / Pitfall 6). The marker builders below are the single source of those
// phrases; their secret-safety is spy-tested in this module's `tests`.
//
// D-11: these verbose lifecycle markers are a DEV-build-only aid. The emit sites
// gate the `vpn-log` emission behind `cfg!(debug_assertions)` (via
// `emit_lifecycle_marker`) so a shipped RELEASE build never streams them — only
// the markers that already drive REAL behavior (e.g. the connect-timeout /
// reconnect-gave-up status flow) keep emitting unconditionally.

/// Fixed "connect start" marker (no config path / credential — D-09).
fn connect_start_marker() -> &'static str {
    "[vpn] connect start"
}

/// Derived "sidecar spawned, pid {pid}" marker. The PID is the real OS PID of
/// trusttunnel_client.exe — non-secret (A2, already taskkill'd by PID elsewhere)
/// — and is the ONLY interpolated value; the config path is never included.
fn spawn_pid_marker(pid: u32) -> String {
    format!("[vpn] sidecar spawned, pid {pid}")
}

/// Fixed "handshake / connected" marker. ASCII-only (the markers are ASCII
/// diagnostic phrases — the user-facing wording lives in frontend i18n, not here).
fn handshake_marker() -> &'static str {
    "[vpn] handshake complete - connection up"
}

/// Fixed "connection drop detected" marker.
fn drop_detected_marker() -> &'static str {
    "[vpn] connection drop detected"
}

/// Fixed "sidecar killed on exit" marker.
fn killed_on_exit_marker() -> &'static str {
    "[vpn] sidecar killed on exit"
}

/// D-08 lifecycle marker (1): emit "connect start" on the `vpn-log` channel.
/// Public so `vpn_connect` (commands/vpn.rs) can fire it. Fixed phrase — no
/// config path / credential (D-09). DEV-gated (D-11).
pub fn emit_connect_start_marker(app: &tauri::AppHandle) {
    emit_lifecycle_marker(app, connect_start_marker(), "info");
}

/// D-08 lifecycle marker (8): emit "sidecar killed on exit" on the `vpn-log`
/// channel. Public so the kill call sites (vpn_disconnect command + tray quit
/// path) can fire it next to `kill_sidecar`, where the `AppHandle` is in scope
/// (`kill_sidecar` itself takes only the `SidecarChild`). DEV-gated (D-11).
pub fn emit_killed_on_exit_marker(app: &tauri::AppHandle) {
    emit_lifecycle_marker(app, killed_on_exit_marker(), "info");
}

/// Fixed "pre-flight offline" marker (02-09, UAT Gap #2). Emitted by `vpn_connect`
/// when the non-blocking pre-flight saw the network as unreachable. A FIXED phrase
/// — no config / server text (D-09/D-29) — DEV-gated (D-11). Public so the command
/// layer can fire it.
fn preflight_offline_marker() -> &'static str {
    "[vpn] pre-flight: network appears offline (connecting anyway)"
}

/// 02-09 (UAT Gap #2): emit the pre-flight-offline warning marker on the `vpn-log`
/// channel. WARNING ONLY — the connect proceeds regardless (cross-AI: never block).
pub fn emit_preflight_offline_marker(app: &tauri::AppHandle) {
    emit_lifecycle_marker(app, preflight_offline_marker(), "warn");
}

/// Emit a DEV-only verbose lifecycle marker on the `vpn-log` channel (D-11).
///
/// The marker is ALSO routed through `logging::sanitize()` as a defence-in-depth
/// belt (D-09) — the builders already produce fixed/derived phrases, so this is a
/// no-op in practice but guarantees the invariant holds even if a builder is
/// later edited carelessly. In a RELEASE build (`debug_assertions` off) this is a
/// no-op: the verbose mirror never streams in production.
fn emit_lifecycle_marker(app: &tauri::AppHandle, message: &str, level: &str) {
    if !cfg!(debug_assertions) {
        return;
    }
    let safe = crate::logging::sanitize(message);
    crate::logging::log_app(level.to_uppercase().as_str(), &safe);
    app.emit(
        "vpn-log",
        serde_json::json!({ "message": safe, "level": level }),
    )
    .ok();
}

/// Map a fatal sidecar log marker to a short, DERIVED error message for the
/// authoritative `VpnStatus::Error` event (RESEARCH A3, so the frontend can stop
/// guessing status from log text in plan 03).
///
/// D-29 / D-10 invariant: the returned string is a FIXED phrase keyed off the
/// marker kind — it NEVER echoes the raw matched log line, so it can never carry
/// a credential. The user-facing Russian text is still rendered by the frontend
/// i18n layer from the same status; this backend string is the authoritative,
/// secret-free signal.
///
/// Returns `None` when the line matches no known fatal marker.
///
/// The WinTUN adapter failure is deliberately NOT a fatal marker any more (G-03.1-7): it is not
/// final, so the app restarts the core instead of writing an immediate Error — see
/// `adapter_creation_failed` and the Terminated arm. Its trailing «Failed to create listener»
/// line is silenced by `handle_fatal_markers` when the reader task already saw the adapter failure.
fn fatal_marker_error(line: &str) -> Option<&'static str> {
    if line.contains("Authorization Required") {
        Some("Authorization failed")
    } else if line.contains("Failed to create listener") {
        Some("Failed to start VPN tunnel")
    } else if line.contains("Connection refused") || line.contains("connection refused") {
        Some("Server refused the connection")
    } else {
        None
    }
}

/// Authoritative backend `VpnStatus::Error` detection for the fatal markers the
/// frontend used to guess from log text (RESEARCH A3 / CR-01). Routing these
/// through `set_vpn_status` is the safety pre-condition that lets the frontend
/// log-parse be deleted without regressing error visibility.
///
/// CR-01 fix: the sidecar emits and parses log lines on BOTH stdout and stderr,
/// and the deleted frontend code matched these markers on EVERY `vpn-log` event
/// regardless of source. Relying on "errors only go to stderr" was an unverified
/// assumption about the external sidecar binary, so this helper is called from
/// both the Stdout and Stderr arms — a fatal marker on EITHER stream now sets
/// `VpnStatus::Error`.
///
/// WR-02 fix: the fatal-marker check and the config-parse check are mutually
/// exclusive (`else if` + single early return) so one line can never emit two
/// conflicting status events.
///
/// D-29 / D-10 invariant: the surfaced message is a fixed DERIVED phrase keyed off
/// the marker kind — it NEVER echoes a raw credential.
///
/// HIGH (Codex review, 01-REVIEWS.md): the config-parse branch USED to forward a
/// sliced RAW backend message (`&trimmed[pos..]` — everything from "Failed parsing
/// configuration" onward) wrapped as "Config error: ...". A malformed config TOML
/// can embed a credential (e.g. an auth/password field), so that raw slice could
/// carry a secret into the `error` field of the `vpn-status` event AND into the
/// frontend trace log (useVpnEvents.ts). That broke D-29's "no secrets in the log
/// channel" the same way an un-sanitized fatal marker would. The fix: hold the
/// config-parse branch to the SAME rule as the four fatal markers — emit a fixed,
/// secret-free DERIVED phrase, never the raw backend text.
const CONFIG_PARSE_ERROR: &str = "Configuration parse error. Check your config file.";

fn config_parse_error(line: &str) -> Option<&'static str> {
    if line.contains("Failed parsing configuration") {
        Some(CONFIG_PARSE_ERROR)
    } else {
        None
    }
}

/// The core's own tag on the line it prints when Windows did not create the WinTUN adapter
/// (`os_tunnel_win.cpp`: `WintunCreateAdapter: <strerror>`).
const ADAPTER_CREATE_TAG: &str = "WintunCreateAdapter:";

/// The core's own text on the follow-up line of the same failure
/// (`client.cpp`: `Failed to initialize tunnel: Unable to create wintun adapter`).
const ADAPTER_UNABLE_TAG: &str = "Unable to create wintun adapter";

/// Is this core log line part of the «Windows did not create the WinTUN adapter» failure
/// (G-03.1-7)?
///
/// Matches the core's own fixed tags only. The `<strerror>` half of the first line is the text
/// Windows itself produces, so it is localized (English «cannot find the file», Russian «Не удается
/// найти указанный файл»); depending on it would make the classifier work on one Windows language
/// only. The normal path's `WintunOpenAdapter:` debug line carries a similar strerror but is NOT a
/// failure, and «Unable to init wintun library» is a missing DLL, a different failure that a
/// retry cannot fix — neither contains these tags.
fn adapter_creation_failed(line: &str) -> bool {
    line.contains(ADAPTER_CREATE_TAG) || line.contains(ADAPTER_UNABLE_TAG)
}

/// The fixed app.log phrase for one scheduled adapter retry. D-29: numbers only — no core text,
/// no path, no secret.
fn adapter_retry_log_line(attempt: u32, max: u32) -> String {
    format!(
        "[vpn] WinTUN adapter was not created — restarting the core, retry {attempt} of {max} (G-03.1-7)"
    )
}

/// Latch the adapter failure for this reader task and log the first sighting once.
///
/// Called from both stream arms before `handle_fatal_markers`, so a failure line on either stream
/// counts and the trailing «Failed to create listener» that follows it is already silenced. The
/// phrase is fixed (D-29); the core's own line stays in the sidecar log where it already goes.
fn note_adapter_failure(line: &str, adapter_failure_seen: &mut bool) {
    if !*adapter_failure_seen && adapter_creation_failed(line) {
        *adapter_failure_seen = true;
        crate::logging::log_app(
            "INFO",
            "[vpn] Windows did not create the WinTUN adapter — the core will exit; the app decides on a retry (G-03.1-7)",
        );
    }
}

/// Parse the core's own `Error: <code> <text>` line (`errlog(g_logger, "Error: {} {}",
/// event->error.code, text)` in `trusttunnel_client.cpp`, emitted right before
/// `stop_trusttunnel_client()`) into a stable, secret-free ASCII reason code (AUD-08 /
/// D-04). Only a FIXED set of `VpnErrorCode` values (`core/include/vpn/vpn.h`) map to a
/// known reason; every other code — AND the code itself, AND the `text` half of the
/// line — is discarded (D-29/D-10). `None` means either no `"Error: "` marker was found
/// on this line, or the code after it is not one of the six this function knows.
///
/// Deliberately does NOT match the recovery line's `error=N` shape (`Waiting recovery:
/// to next=…ms error=N …`) — that string never contains the literal `"Error: "` marker
/// (different case, no colon-space after the field name), so the search finds nothing
/// on it and this function correctly returns `None`.
///
/// The marker must also START a word: the core writes it after `": "` or a space, while a
/// Win32 diagnostic such as `GetLastError: 5 (Access is denied.)` ends in the same seven
/// bytes with a letter before them — and 5 there is ERROR_ACCESS_DENIED, not the core's
/// auth failure. A bare substring search would have named the wrong cause (deep review of
/// AUD-08, L-1), so an occurrence glued to a preceding letter or digit is skipped and the
/// next one on the line is tried.
fn core_exit_error_reason(line: &str) -> Option<&'static str> {
    const MARKER: &str = "Error: ";
    let (at, _) = line.match_indices(MARKER).find(|(i, _)| {
        *i == 0 || !line.as_bytes()[*i - 1].is_ascii_alphanumeric()
    })?;
    let after = &line[at + MARKER.len()..];
    let bytes = after.as_bytes();
    // At most 2 ASCII digits (every known VpnErrorCode is 0-10) — longer runs (e.g. a
    // Windows socket error like "10054") must NOT truncate-match a shorter known code.
    let mut len = 0usize;
    while len < bytes.len() && len < 2 && bytes[len].is_ascii_digit() {
        len += 1;
    }
    if len == 0 {
        return None;
    }
    if bytes.get(len).is_some_and(u8::is_ascii_digit) {
        return None; // a 3rd digit follows — this is a longer number, not a known code
    }
    // IN-01 (03-REVIEW.md): a zero-padded 2-digit run ("07") is not, strictly, one of the
    // exact textual codes this function's own doc comment promises to recognise — the core
    // never emits a leading zero in practice, but reject it explicitly rather than silently
    // parsing it the same as its unpadded form ("7").
    if len == 2 && bytes[0] == b'0' {
        return None;
    }
    // The digit run must end at whitespace or end-of-line (the format is "N text" or
    // just "N"), never run straight into other characters ("Error: abc" has zero
    // leading digits already caught above; this guards a form like "Error: 6x").
    if !matches!(bytes.get(len), None | Some(b' ')) {
        return None;
    }
    let code: u8 = after[..len].parse().ok()?;
    match code {
        6 | 9 => Some(crate::lifecycle::CORE_SERVER_UNREACHABLE_REASON),
        5 => Some(crate::lifecycle::CORE_AUTH_FAILED_REASON),
        7 => Some(crate::lifecycle::CORE_CERTIFICATE_FAILED_REASON),
        2 => Some(crate::lifecycle::CORE_INVALID_SETTINGS_REASON),
        3 => Some(crate::lifecycle::CORE_ADDRESS_IN_USE_REASON),
        10 => Some(crate::lifecycle::CORE_FATAL_CONNECTIVITY_REASON),
        _ => None,
    }
}

fn handle_fatal_markers(
    trimmed: &str,
    app: &tauri::AppHandle,
    my_generation: u64,
    // Phase 19 UAT (G-19-6, Option B): THIS session's config DISPLAY NAME, captured at reader-task
    // spawn, so a SUPERSEDED session's failure plate can name the server that ACTUALLY failed rather
    // than the live config_path (which has moved to the fallback server). D-29: display name only.
    my_config_name: &str,
    // G-19-6 (Option B): a per-reader-task latch so a burst of fatal lines from a dead session fires
    // the superseded error plate AT MOST ONCE (the normal-path Error write is edge-triggered by
    // maybe_fire, so only the superseded direct-fire path needs this).
    superseded_error_plate_fired: &mut bool,
    // G-03.1-7: the reader task already saw this core's WinTUN adapter failure. Its exit is decided
    // by the retry logic in the Terminated arm (restart, or one honest error when the budget is
    // used up), so the trailing «Failed to create listener» line of the same failure must write
    // no Error of its own — that would end «Подключение...» before the retry could run.
    adapter_failure_seen: bool,
    // G-03.1-10 (deep review #4): a user stop is in progress. The core now stops through its own
    // Ctrl+C handler and prints its teardown lines; one of them may carry a pending error. A stop
    // the user asked for must never raise an error plate or an Error status.
    user_stop_in_progress: bool,
) {
    if adapter_failure_seen {
        return;
    }
    if user_stop_in_progress {
        return;
    }
    // A fatal marker (auth/refused/…) OR the config-parse marker. Both write the SAME fixed DERIVED
    // phrase — NEVER the raw `&trimmed[pos..]` slice, which could carry a credential out of a malformed
    // config (D-29 / Codex HIGH). `.or_else` keeps the original precedence (fatal markers first) and the
    // single early return keeps a line from double-emitting (WR-02).
    let Some(derived) = fatal_marker_error(trimmed).or_else(|| config_parse_error(trimmed)) else {
        return;
    };
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    // 3.1 R-GEN (Phase 19 UAT G-19-6): gate the fatal-marker Error write on THIS session's
    // generation, exactly like the Terminated arm (terminated_arm_may_write_status) and the
    // connect-timeout watchdog already do. This was the ONE Error writer missing the guard. Without
    // it, a SUPERSEDED sidecar's late fatal log line — drained by this reader task AFTER a newer
    // connect (a fallback / seamless-switch revert / auto-switch to a healthy server) bumped the
    // generation and repointed AppState.config_path — wrote Error onto a session it no longer owns.
    // That both (a) NAMED THE WRONG SERVER in the desktop error plate (notify::maybe_fire resolves the
    // plate name from the LIVE config_path, now the healthy server) and (b) flipped the fresh session's
    // Connecting/Connected back to Error.
    let live_generation = state
        .connection_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    if !crate::lifecycle::is_current_generation(my_generation, live_generation) {
        // SUPERSEDED: this session is dead — its pid-gated housekeeping still runs in the Terminated
        // arm. Do NOT write vpn_status (it would corrupt the fresh session that now owns the adapter).
        // Option B (owner): still tell the user the FAILED server's name via a dedicated plate path
        // that names `my_config_name` (the config THIS session connected), NOT the live config_path.
        // Fire at most once per reader task (the latch) so a fatal-line burst cannot spam.
        crate::logging::log_app(
            "INFO",
            "[sidecar] superseded sidecar fatal marker — dropping Error status; firing a correctly-named error plate for the failed server (3.1 R-GEN, G-19-6)",
        );
        if !*superseded_error_plate_fired {
            *superseded_error_plate_fired = true;
            crate::notify::fire_superseded_error_plate(app, my_config_name);
        }
        return;
    }
    // R3/WR-01 + G-19-6 v5 (Fable D2): a terminal Error already on `vpn_status` is AUTHORITATIVE — the
    // FIRST specific reason wins. A SECOND fatal marker from the SAME process must NOT re-stamp or
    // re-write: an Error→Error is not an edge, so maybe_fire's edge-triggered take would NOT consume the
    // re-stamp — it would LINGER with this dead server's name for a later unrelated Error to inherit.
    // Mirror the Terminated arm's `already_error` guard (which exists for the same reason) so the
    // CURRENT branch also stamps + writes AT MOST ONCE per failure.
    let already_error = state
        .vpn_status
        .lock()
        .ok()
        .map(|g| *g == VpnStatus::Error)
        .unwrap_or(false);
    if already_error {
        crate::logging::log_app(
            "INFO",
            "[sidecar] repeat fatal marker after a terminal Error — keeping the authoritative reason + stamp (R3/WR-01, G-19-6 D2)",
        );
        return;
    }
    // CURRENT session's genuine failure. G-19-6 v5: stamp THIS session's captured name so
    // notify::maybe_fire names the ConnectionError plate after the config that FAILED — NOT the live
    // config_path, which a CONCURRENT reconnect/switch-back can repoint to the healthy server between
    // this Error being decided and maybe_fire resolving the name (the wrong-server-name bug the log
    // proved: [fatal CURRENT my_name="16166"] → [maybe_fire … resolved_name="US relay7 PL"]). The
    // stamp is take-once (maybe_fire's edge-triggered take consumes/clears it). D-29: a display name only.
    if let Ok(mut g) = state.pending_error_config_name.lock() {
        *g = Some(my_config_name.to_string());
    }
    set_vpn_status(app, &state, VpnStatus::Error, Some(derived.to_string()));
}

pub struct SidecarChild {
    pub child: CommandChild,
    pub disconnecting: Arc<Mutex<bool>>,
    /// RAII handle to the KILL_ON_JOB_CLOSE Job Object this sidecar is assigned
    /// to (D-06 / STATUS-04). Keeping it alive == the OS kill stays armed for the
    /// connection's lifetime; dropping the `SidecarChild` (on kill or session
    /// end) closes the handle exactly once via `OwnedJobHandle::drop` — so there
    /// is NO manual `CloseHandle` anywhere (Codex MEDIUM).
    ///
    /// `None` is the explicit DEGRADED MODE: the job could not be assigned (the
    /// parent is already in a job under a debugger / CI / some launchers). That
    /// is logged + tolerated, never fatal — the PID-file fallback still cleans up.
    ///
    /// `#[allow(dead_code)]`: this field is a DROP-GUARD. It is never *read* — its
    /// entire purpose is to live as long as the `SidecarChild` so that
    /// `OwnedJobHandle::drop` runs (closing the handle == arming/triggering the OS
    /// kill) at exactly the right moment. clippy's dead-code lint can't see the
    /// Drop side-effect, so we silence it deliberately rather than weaken the type.
    #[allow(dead_code)]
    pub job: Option<crate::job_object::OwnedJobHandle>,
}

pub async fn spawn_trusttunnel(
    app: &tauri::AppHandle,
    config_path: &str,
    log_level: &str,
    child_state: Arc<Mutex<Option<SidecarChild>>>,
    disconnecting: Arc<Mutex<bool>>,
    // 3.1 R-GEN (F12): the connection_generation of the session this sidecar belongs to (captured by
    // the caller AFTER its pre-spawn generation bump). The reader task uses it to drop the status
    // side effects of a SUPERSEDED child's late exit (see terminated_arm_may_write_status).
    session_generation: u64,
) -> Result<SidecarChild, Box<dyn std::error::Error>> {
    let shell = app.shell();

    eprintln!("[sidecar] Spawning trusttunnel_client with args: -c {config_path} -l {log_level}");
    // G-03.1-10: never start a core while an earlier one is still running its own cleanup — it
    // would reuse the adapter that cleanup is about to remove (see CORE_STOPS_IN_FLIGHT).
    wait_for_core_stops_in_flight().await;
    // G-03.1-10: the core must inherit "Ctrl+C enabled", or `kill_sidecar`'s graceful stop never
    // reaches its SIGINT handler (console_ctrl.rs).
    crate::console_ctrl::prepare_spawn();
    let (mut rx, child) = shell
        .sidecar("trusttunnel_client")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(["-c", config_path, "-l", log_level])
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;
    eprintln!("[sidecar] Process spawned successfully");

    // D-08 lifecycle marker (2): sidecar spawn + PID. The PID is the only
    // interpolated value (non-secret — A2); the config path is never logged here.
    // DEV-gated via emit_lifecycle_marker (D-11).
    emit_lifecycle_marker(app, &spawn_pid_marker(child.pid()), "info");

    // D-06 / STATUS-04 — assign the freshly-spawned sidecar to a KILL_ON_JOB_CLOSE
    // Job Object so the OS terminates it whenever this app dies for ANY reason
    // (graceful quit, tray quit, panic, hard crash). `child.pid()` is the real OS
    // PID of trusttunnel_client.exe — the same PID `kill_sidecar` already taskkills
    // (A2). We keep the returned handle alive in `SidecarChild.job`.
    //
    // Codex MEDIUM — EXPLICIT degraded mode: if the assign fails (parent already
    // in a job under a debugger / CI / some launchers), we DO NOT abort the
    // connect. We log a fixed phrase + the failed Win32 call name (no secret, the
    // PID is non-secret — D-09) noting the Job Object is unavailable and cleanup
    // falls back to the PID file, then continue with `job: None`. A Job failure
    // must NEVER block connecting (D-06); the PID-file stale-cleanup still applies.
    let job = match crate::job_object::assign_to_kill_on_close_job(child.pid()) {
        Ok(handle) => {
            let msg = format!(
                "[vpn] sidecar PID {} assigned to KILL_ON_JOB_CLOSE job",
                child.pid()
            );
            eprintln!("{msg}");
            crate::logging::log_app("INFO", &msg);
            app.emit(
                "vpn-log",
                serde_json::json!({ "message": msg, "level": "info" }),
            )
            .ok();
            Some(handle)
        }
        Err(call) => {
            // `call` is a FIXED phrase naming the failed Win32 call (e.g.
            // "AssignProcessToJobObject failed") — never config text or a secret.
            let msg = format!(
                "[vpn] Job Object unavailable ({call}); falling back to PID-file cleanup (degraded mode)"
            );
            eprintln!("{msg}");
            crate::logging::log_app("WARN", &msg);
            app.emit(
                "vpn-log",
                serde_json::json!({ "message": msg, "level": "warn" }),
            )
            .ok();
            None
        }
    };

    let app_handle = app.clone();
    let disc_for_child = Arc::clone(&disconnecting);
    let disc_for_task = Arc::clone(&disc_for_child);
    let spawn_time = Instant::now();
    // AUDIT-2026-06-11 #4: capture THIS child's pid before spawning its reader
    // task. The Terminated arm uses it as the identity key for every shared-state
    // side effect (PID-file removal / sidecar_child slot clear / status write), so
    // a LATE Terminated from an OLD child can never act on a NEWER session's state.
    let my_pid = child.pid();
    // 3.1 R-GEN (F12): capture THIS session's generation alongside my_pid; the Terminated arm gates
    // its status writes on it so a superseded child's late exit cannot corrupt a newer session.
    let my_generation = session_generation;
    // Phase 19 UAT (G-19-6, Option B): capture THIS session's config DISPLAY NAME at spawn — resolved
    // from the config path this sidecar connected — so a SUPERSEDED session's fatal marker can fire an
    // error plate naming the server that ACTUALLY failed. By the time a superseded marker is drained,
    // the live AppState.config_path (what notify::maybe_fire reads) has moved to the fallback server,
    // so the live path names the WRONG server. D-29: display name only (never the .toml/host/password).
    let my_config_name =
        crate::commands::manifest::current_display_name(config_path).unwrap_or_default();
    tokio::spawn(async move {
        let mut dns_proxy_ready = false;
        // Connected gate: this sidecar starts the readiness probe (and so emits Connected) EXACTLY
        // ONCE per process lifetime, and only after it reported BOTH the endpoint handshake and its
        // TUN listener ready, in either order (G-03.1-7). The core creates the WinTUN adapter in
        // parallel with the endpoint connect, so the endpoint line alone does not prove a tunnel
        // exists. Without the once-per-process latch, `check_sidecar_markers` re-asserted Connected
        // on the NEXT stdout line after the connectivity monitor had moved the status to
        // Recovering/Reconnecting on a drop. A still-alive sidecar (e.g. the physical adapter was
        // disabled but the process is not dead yet) keeps logging; each line saw status !=
        // Connected and re-emitted Connected, overwriting «Восстановление» back to «Подключено» —
        // the stuck-green bug from UAT build 65692c test 4 (status said Connected while the network
        // was gone). The monitor/supervisor own every status transition after the first connect; a
        // respawned sidecar gets its own fresh task with a fresh gate and emits Connected for the
        // new session. Both stream arms feed the same value.
        let mut readiness = ConnectReadiness::default();

        // G-19-6 (Option B): fire the SUPERSEDED-session error plate AT MOST ONCE per reader task, so
        // a burst of fatal log lines from a dead session cannot spam the desktop with duplicate error
        // plates. The normal (current-generation) Error write is already edge-triggered by maybe_fire.
        let mut superseded_error_plate_fired = false;

        // G-03.1-7: latched when this core reported that Windows did not create the WinTUN adapter.
        // The core exits right after, never having connected; the Terminated arm reads the latch to
        // decide on a bounded restart. Both stream arms feed it, before `handle_fatal_markers`.
        let mut adapter_failure_seen = false;

        // AUD-08 / D-04: the core's own parsed reason, latched per reader task. A never-connected
        // exit's `Error: <code> <text>` line arrives on Stdout/Stderr BEFORE the `Terminated` event
        // that reads this latch, so it is captured here (last one wins — mirrors `noisy_key`'s
        // last-write-wins latch above) and consumed once in the Terminated arm below.
        let mut core_exit_reason: Option<&'static str> = None;

        // T-32 (2026-06-11): collapse the core's noisy-line floods. When the tunnel
        // dies the C++ core emits THOUSANDS of identical "DNS proxy request id=N
        // failed" lines (one per in-flight query) within milliseconds — they push
        // every useful line out of the 500-line panel buffer and bloat the file.
        // The FIRST line of a burst passes through, repeats are counted; a summary
        // ("... repeated ×N") is emitted every NOISY_FLUSH_EVERY repeats and when
        // the burst ends. Marker/fatal parsing below is NOT gated — it still sees
        // every line.
        let mut noisy_key: Option<&'static str> = None;
        let mut noisy_count: u64 = 0;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim();

                    let key = noisy_line_key(trimmed);
                    let mut suppress = false;
                    let mut summary: Option<String> = None;
                    match (key, noisy_key) {
                        (Some(k), Some(prev)) if k == prev => {
                            noisy_count += 1;
                            if noisy_count.is_multiple_of(NOISY_FLUSH_EVERY) {
                                summary = Some(format!(
                                    "[noise] {k} — repeated ×{noisy_count} (collapsed, T-32)"
                                ));
                            }
                            suppress = true;
                        }
                        (new_key, prev) => {
                            // Burst boundary: flush the previous burst's total (if any
                            // repeats were swallowed), then let the current line pass.
                            if let Some(prev_k) = prev {
                                if noisy_count > 1 {
                                    summary = Some(format!(
                                        "[noise] {prev_k} — repeated ×{noisy_count} total (collapsed, T-32)"
                                    ));
                                }
                            }
                            noisy_key = new_key;
                            noisy_count = u64::from(new_key.is_some());
                        }
                    }
                    if let Some(s) = summary {
                        eprintln!("[sidecar stdout] {s}");
                        crate::logging::log_sidecar(&s);
                        app_handle
                            .emit("vpn-log", serde_json::json!({ "message": s, "level": "info" }))
                            .ok();
                    }

                    if !suppress {
                        eprintln!("[sidecar stdout] {trimmed}");
                        crate::logging::log_sidecar(trimmed);
                        app_handle
                            .emit(
                                "vpn-log",
                                serde_json::json!({
                                    "message": trimmed,
                                    "level": parse_log_level(trimmed),
                                }),
                            )
                            .ok();
                    }

                    check_sidecar_markers(
                        trimmed, &app_handle, &disc_for_task,
                        &mut dns_proxy_ready, &mut readiness,
                        &spawn_time, my_generation,
                    ).await;

                    // G-03.1-7: latch the WinTUN adapter failure BEFORE the fatal-marker check so the
                    // trailing «Failed to create listener» of the same failure writes no Error.
                    note_adapter_failure(trimmed, &mut adapter_failure_seen);

                    // CR-01: a fatal marker can arrive on stdout too — run the
                    // authoritative Error detection here as well, not only on stderr.
                    // G-19-6: pass this session's generation + captured config name so a
                    // superseded child's late marker names the failed server (see handle_fatal_markers).
                    handle_fatal_markers(
                        trimmed,
                        &app_handle,
                        my_generation,
                        &my_config_name,
                        &mut superseded_error_plate_fired,
                        adapter_failure_seen,
                        disc_for_task.lock().map(|g| *g).unwrap_or(false),
                    );

                    // AUD-08 / D-04: latch the core's own parsed reason (if this line is one).
                    if let Some(r) = core_exit_error_reason(trimmed) {
                        core_exit_reason = Some(r);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    eprintln!("[sidecar stderr] {trimmed}");
                    crate::logging::log_sidecar(trimmed);
                    app_handle
                        .emit(
                            "vpn-log",
                            serde_json::json!({
                                "message": trimmed,
                                "level": parse_log_level(trimmed),
                            }),
                        )
                        .ok();

                    check_sidecar_markers(
                        trimmed, &app_handle, &disc_for_task,
                        &mut dns_proxy_ready, &mut readiness,
                        &spawn_time, my_generation,
                    ).await;

                    // G-03.1-7: same latch as the Stdout arm, before the fatal-marker check.
                    note_adapter_failure(trimmed, &mut adapter_failure_seen);

                    // Authoritative backend Error for the fatal markers the frontend
                    // used to guess from log text (RESEARCH A3). Same helper as the
                    // Stdout arm (CR-01) — one place, both streams, single early
                    // return so a line can never double-emit (WR-02).
                    // G-19-6: superseded-marker guard + captured config name (Option B).
                    handle_fatal_markers(
                        trimmed,
                        &app_handle,
                        my_generation,
                        &my_config_name,
                        &mut superseded_error_plate_fired,
                        adapter_failure_seen,
                        disc_for_task.lock().map(|g| *g).unwrap_or(false),
                    );

                    // AUD-08 / D-04: latch the core's own parsed reason (if this line is one) —
                    // same latch as the Stdout arm (both streams, CR-01's precedent).
                    if let Some(r) = core_exit_error_reason(trimmed) {
                        core_exit_reason = Some(r);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    // Clear PID file — process is gone.
                    //
                    // CR-01 (Phase 2 review): the PID is SAVED to the per-edition file
                    // `.sidecar-pro.pid` (via `sidecar_pid_path()` →
                    // `lifecycle::SIDECAR_PID_BASENAME`), but this arm used to remove the
                    // OLD shared name `.sidecar.pid`. That file never exists, so the
                    // removal was a no-op and `.sidecar-pro.pid` was left on disk pointing
                    // at a now-dead (and possibly OS-recycled) PID. The next connect's
                    // `kill_stale_sidecar()` would then `taskkill /F /PID <stale>` — which
                    // on Windows (PIDs recycle) could hit ANOTHER process, including a
                    // co-installed Light sidecar: exactly the cross-edition kill D-07 was
                    // added to prevent. Clean up the SAME per-edition basename we wrote.
                    //
                    // Phase 32: this used to compose the path itself by joining the basename
                    // onto the data root. It now calls the ONE accessor, because the data root
                    // and the pid directory stopped being the same folder in that phase — a
                    // second composition site here would have silently kept writing the pid
                    // file where the uninstaller no longer looks.
                    //
                    // 32-FIX-08: the accessor answers `None` when the executable's own directory
                    // cannot be resolved, in which case nothing was ever written — «no path» and
                    // «no file» are the same fact here, so both take the same do-nothing branch.
                    if let Some(pid_path) = crate::commands::vpn::sidecar_pid_path() {
                        // AUDIT-2026-06-11 #4: delete the PID file ONLY when it still records
                        // OUR OWN pid. A supervisor respawn (`respawn_sidecar`) or a fast
                        // manual reconnect may have already saved the NEW child's pid into the
                        // same per-edition file; this OLD child's late Terminated removing it
                        // unconditionally would strip the new session's crash-cleanup fallback
                        // (the next launch's `kill_stale_sidecar` would find nothing to sweep).
                        let pid_file_is_ours = std::fs::read_to_string(&pid_path)
                            .map(|contents| pid_file_records_pid(&contents, my_pid))
                            .unwrap_or(false);
                        if pid_file_is_ours {
                            let _ = std::fs::remove_file(&pid_path);
                        }
                    }

                    // Read "was connected" from the single owner (vpn_status), not a
                    // parallel bool — the mutator keeps both in sync this phase.
                    let state_opt = app_handle.try_state::<AppState>();
                    let was_connected = state_opt
                        .as_ref()
                        .and_then(|s| s.vpn_status.lock().ok().map(|g| *g == VpnStatus::Connected))
                        .unwrap_or(false);
                    let exit_code = payload.code.unwrap_or(-1);
                    let was_intentional = disconnecting.lock().map(|g| *g).unwrap_or(false);
                    eprintln!("[sidecar] Process terminated with code {exit_code} (intentional={was_intentional}, was_connected={was_connected})");
                    crate::logging::log_app("INFO", &format!("Sidecar terminated: code={exit_code}, intentional={was_intentional}, was_connected={was_connected}"));

                    // Clear the sidecar child so VPN can be reconnected — but ONLY when
                    // the slot is empty (this child was already taken out: intentional
                    // disconnect / respawn kill) or still holds OUR OWN pid.
                    //
                    // AUDIT-2026-06-11 #4: this clear used to be UNCONDITIONAL. A LATE
                    // Terminated from an OLD child (its reader task can be queued behind
                    // a backlog of buffered Stdout events — the T-32 log spam) can run
                    // AFTER `respawn_sidecar` stored the NEW session's child. `*guard =
                    // None` then DROPS that new `SidecarChild`; the drop closes its
                    // KILL_ON_JOB_CLOSE `OwnedJobHandle` and the OS kills the freshly
                    // respawned sidecar mid-handshake — each killed child's late
                    // Terminated could poison the next attempt until the supervisor burnt
                    // all 10 attempts → Error("reconnect-gave-up"). Identity-gate the
                    // clear (and, below, every trailing side effect). Check + clear run
                    // under ONE lock acquisition so a respawn storing the new child can
                    // never interleave between them (same TOCTOU rule as WR-05).
                    let owns_shared_state = {
                        let mut guard = child_state.lock().unwrap_or_else(|e| e.into_inner());
                        let stored_pid = guard.as_ref().map(|c| c.child.pid());
                        let owns = terminated_arm_owns_state(my_pid, stored_pid);
                        if owns && stored_pid.is_some() {
                            *guard = None;
                            eprintln!("[sidecar] Cleared sidecar_child state");
                        }
                        owns
                    };
                    // 3.1 R-GEN (F12): the pid-gated PID-file cleanup + slot clear above are this
                    // child's own housekeeping and run regardless. But the SESSION-STATUS side effects
                    // below (Error/Disconnected write, supervisor handoff) must fire ONLY when this
                    // child still owns the LIVE session — it owns the slot (identity) AND its captured
                    // generation is still live. Under a rapid disconnect→connect churn the slot is
                    // TRANSIENTLY empty (owns==true) yet the generation has already advanced, so an OLD
                    // child's late non-zero exit would otherwise write Error("sidecar-exit") onto the
                    // fresh Connecting (the churn-log F12 window: the error lands between "Spawning..."
                    // and the new PID line). Read the live generation and gate both dimensions.
                    let live_generation = state_opt
                        .as_ref()
                        .map(|s| {
                            use std::sync::atomic::Ordering;
                            s.connection_generation.load(Ordering::SeqCst)
                        })
                        .unwrap_or(my_generation); // no AppState (unit context) → treat as current
                    if !crate::lifecycle::terminated_arm_may_write_status(
                        owns_shared_state,
                        my_generation,
                        live_generation,
                    ) {
                        if !owns_shared_state {
                            // AUDIT-2026-06-11 #4: a NEWER live child is STORED — that session owns
                            // the shared state now and its OWN reader task reports for it. Acting here
                            // would flip the new session's fresh Connecting to Error("sidecar-exit"),
                            // or hand a competing supervisor a drop that belongs to a dead session.
                            crate::logging::log_app(
                                "INFO",
                                "[sidecar] late Terminated from an old child — a newer child owns the state; skipping cleanup/status (AUDIT #4)",
                            );
                        } else {
                            // 3.1 R-GEN (F12): this child owns the (transiently empty) slot, but a
                            // newer session generation is live — a disconnect→connect churn superseded
                            // it. Drop the status write / supervisor handoff so its exit cannot corrupt
                            // the fresh Connecting. Its pid-gated cleanup already ran above.
                            crate::logging::log_app(
                                "INFO",
                                "[sidecar] superseded sidecar exit — a newer session generation is live; dropping status/supervisor (3.1 R-GEN, F12)",
                            );
                        }
                        continue;
                    }

                    // STATUS-05 / D-04 (Plan 04, trigger A — PROCESS DEATH): an
                    // UNEXPECTED drop of a working VPN (the user did NOT disconnect AND
                    // we were Connected) hands off to the WINDOW-INDEPENDENT Rust
                    // reconnect supervisor instead of just setting Disconnected — so a
                    // closed-to-tray / tray-started session recovers without a mounted
                    // React effect (the old React reconnect is deleted in this same
                    // plan, Task 3). `should_reconnect` gates exactly the
                    // `was_connected && !was_intentional` case (D-04); a user disconnect
                    // or a never-connected startup failure keeps the old behavior below.
                    // CR-02: if a reconnect supervisor is ALREADY live, it OWNS recovery
                    // for this drop — this Terminated event is its OWN respawned child
                    // dying again (server still down). Do NOT spawn a SECOND supervisor:
                    // two supervisors would race (both respawning, both killing each
                    // other's child), and the generation guard does NOT separate them
                    // because respawn_sidecar shares the captured generation. The live
                    // supervisor's own bounded-3 loop will retry this drop. A genuine NEW
                    // drop AFTER the supervisor gave up clears the flag (RAII guard), so
                    // this branch fires normally then.
                    let supervisor_live = state_opt
                        .as_ref()
                        .map(|s| {
                            use std::sync::atomic::Ordering;
                            s.reconnect_in_progress.load(Ordering::SeqCst)
                        })
                        .unwrap_or(false);

                    if supervisor_live {
                        // WR-01 (G-03.1-7): a supervised respawn that died on the WinTUN adapter
                        // writes NO status here (the supervisor owns it), but it must say WHY: the
                        // loop reads `last_error` after the attempt to bound its adapter retries
                        // and to keep the diagnosis for its final Error. `record_failure_cause`
                        // touches `last_error` alone — it is not a second status writer (D-01).
                        // Past the generation/identity gate above, so only the live session's own
                        // core records. Done BEFORE the log write below on purpose: the slot was
                        // cleared a few statements ago and the supervisor's poll may already see
                        // the core gone, so the cause should land as close to that as possible.
                        if adapter_failure_seen {
                            if let Some(state) = state_opt.as_ref() {
                                crate::commands::vpn::record_failure_cause(
                                    state,
                                    crate::lifecycle::ADAPTER_CREATION_FAILED_REASON,
                                );
                            }
                        }
                        crate::logging::log_app(
                            "INFO",
                            "[reconnect] sidecar exit while supervisor live — supervisor owns recovery, not spawning a second",
                        );
                    } else if crate::lifecycle::should_reconnect(was_intentional, was_connected) {
                        // D-08 lifecycle marker (4): connection drop detected —
                        // fixed phrase (no exit code / config text), DEV-gated.
                        emit_lifecycle_marker(&app_handle, drop_detected_marker(), "warn");
                        if let Some(state) = state_opt.as_ref() {
                            // Capture the CURRENT generation (window-independent — read
                            // from AppState, NOT localStorage) so the supervisor
                            // neutralizes itself if a manual reconnect / disconnect bumps
                            // it (Codex HIGH). Read the saved config/log level the same
                            // way a tray-initiated connect does.
                            use std::sync::atomic::Ordering;
                            let generation = state.connection_generation.load(Ordering::SeqCst);
                            let config_path = state
                                .config_path
                                .lock()
                                .ok()
                                .and_then(|g| g.clone());
                            let log_level = state
                                .log_level
                                .lock()
                                .map(|g| g.clone())
                                .unwrap_or_else(|_| "info".to_string());
                            match config_path {
                                Some(config_path) => {
                                    crate::logging::log_app(
                                        "INFO",
                                        "[reconnect] unexpected sidecar exit — starting supervisor",
                                    );
                                    // OWNER RULING (28-UAT test 9) — the hybrid. The sidecar PROCESS
                                    // died, which says nothing about whether the user's servers are
                                    // reachable, so the origin is retried FIRST with the full
                                    // RECONNECT_MAX_ATTEMPTS budget — that is what preserves the
                                    // reboot-recovery guarantee, and the origin is the server the user
                                    // actually chose. Only when it has genuinely refused to come back
                                    // does the walk move on to the other participating servers.
                                    //
                                    // WHAT THIS REPLACES, AND WHY. The queue used to be a single entry,
                                    // on an executor's reading of D-01: that decision contrasts
                                    // `tunnel-lost` (failover) with `internet-lost` (no failover) and
                                    // never mentions this THIRD drop class, so «no failover» here was a
                                    // guess nobody had been asked to confirm. Its failure mode was the
                                    // bad one: with «Авто-режим» ON, a crash the origin could not
                                    // recover from ended in a dead session and untried servers, and the
                                    // user watching it had every reason to think the feature was broken.
                                    //
                                    // The opposite extreme was rejected too — walking immediately would
                                    // move a person to a different exit country over a local process
                                    // crash, and would break reboot recovery, where waiting for the
                                    // origin is exactly right. `WalkKind` is what lets one walk
                                    // machine serve both: it changes ONLY the origin's budget.
                                    //
                                    // `build_failover_queue` still applies every existing guard — the
                                    // master toggle, per-server participation, `should_failover` — so a
                                    // user with failover off, or with no other participating server,
                                    // gets the one-entry queue and byte-identical behaviour.
                                    let queue = crate::connectivity::build_failover_queue(
                                        crate::connectivity::TUNNEL_LOST_REASON,
                                        &config_path,
                                    );
                                    crate::logging::log_app(
                                        "INFO",
                                        &format!(
                                            "[reconnect] sidecar exit — retrying the same server first, then {} other candidate(s) (owner ruling 2026-08-26)",
                                            queue.len().saturating_sub(1)
                                        ),
                                    );
                                    crate::connectivity::start_reconnect_supervisor(
                                        app_handle.clone(),
                                        queue,
                                        log_level,
                                        generation,
                                        crate::lifecycle::WalkKind::LocalProcessDeath,
                                    );
                                }
                                None => {
                                    // No saved config to respawn from — fall back to an
                                    // honest Disconnected rather than leaving the UI hung.
                                    crate::logging::log_app(
                                        "WARN",
                                        "[reconnect] no saved config path — cannot supervise; setting Disconnected",
                                    );
                                    set_vpn_status(
                                        &app_handle,
                                        state,
                                        VpnStatus::Disconnected,
                                        None,
                                    );
                                }
                            }
                        }
                    } else {
                        // AUD-08 / D-03: a never-connected exit is classified by the
                        // program's OWN INTENT STATE, never by the exit code. The C++
                        // core exits 0 on a terminal failure (upstream
                        // `trusttunnel_client.cpp`, not changed here), so a zero code
                        // says nothing about who ended the session — the old condition
                        // (an OR of `was_intentional` with a zero-exit-code comparison)
                        // read that zero as "the person disconnected" on every
                        // never-connected startup failure, which is exactly the «VPN
                        // отключён» lie AUD-08 reports. `was_intentional` here is the
                        // TRANSIENT `disconnecting` flag — process-wide, the same Arc
                        // every spawn door passes in, NOT owned by this child; reading
                        // it is safe only because every deliberate kill of an older
                        // child also bumps the generation, which dropped that child's
                        // exit above. `durable_intent` below reads the
                        // DURABLE `AppState.user_disconnect_requested` flag (same
                        // transient-OR-durable shape `connect_cancelled` already uses)
                        // — either one means the person asked, and the exit is an
                        // honest `Disconnected`. Nobody asked → an honest `Error`
                        // carrying a STABLE, secret-free ASCII REASON CODE:
                        //   - the core's own parsed reason (D-04,
                        //     `core_exit_error_reason`) when the reader task's latch
                        //     caught an `Error: <code> <text>` line and the code is one
                        //     the server answered with or a local one — the pre-flight
                        //     probe's guess never overrides those,
                        //   - `NO_INTERNET_REASON` when the pre-flight saw the network
                        //     as offline and the core said only "server unreachable" or
                        //     nothing (offline makes every server look unreachable),
                        //   - "server unreachable" itself when the pre-flight was online,
                        //   - `SIDECAR_EXIT_REASON` otherwise (generic VPN-core
                        //     failure — also covers an AV-kill / manual Task-Manager
                        //     kill of the sidecar during connect, the same
                        //     never-connected non-zero exit).
                        //
                        // G-03.1-7: ONE never-connected failure is not final and is decided before
                        // that classification runs — Windows did not create the WinTUN adapter (the
                        // core's own lines, `adapter_failure_seen`). Windows finishes or releases the
                        // adapter within seconds, so the app restarts the core up to
                        // `ADAPTER_RETRY_MAX_ATTEMPTS` times per connect and writes NO status while it
                        // does: «Подключение...» holds, and the only Error is the exhausted one below.
                        // The restart goes through `respawn_sidecar` (`start_adapter_retry`), the
                        // existing reconnect door, so no fourth spawn door exists and its intent and
                        // generation re-checks apply. A live supervisor never reaches this branch (the
                        // `supervisor_live` arm above defers to its own bounded loop).
                        let durable_intent = state_opt
                            .as_ref()
                            .map(|s| {
                                s.user_disconnect_requested
                                    .load(std::sync::atomic::Ordering::SeqCst)
                            })
                            .unwrap_or(false);
                        // R3 / WR-01: a terminal Error already on `vpn_status` is
                        // AUTHORITATIVE — the FIRST specific reason wins. Whatever set it
                        // (the connect-timeout watchdog, a fatal marker, the reconnect
                        // supervisor give-up, or the recovery-timeout) chose a precise
                        // reason code; a later process-exit Terminated must NOT overwrite it
                        // with the generic `sidecar-exit` / `no-internet` (or a Disconnected).
                        // The earlier guard also required `was_intentional`, but the
                        // connect-timeout watchdog kills WITHOUT setting the (shared) intent
                        // flag — so its precise reason could be clobbered depending on the
                        // kill/Terminated ordering. Gating on `already_error` alone closes
                        // that without touching the process-wide `disconnecting` flag.
                        let already_error = state_opt
                            .as_ref()
                            .and_then(|s| s.vpn_status.lock().ok().map(|g| *g == VpnStatus::Error))
                            .unwrap_or(false);
                        // WR-02: the whole decision — including «an Error already stands» — is the
                        // pure `adapter_arm_outcome`; this match only maps its answer to effects.
                        let adapter_outcome = match state_opt.as_ref() {
                            Some(state) => {
                                let used = crate::lifecycle::adapter_retries_used(
                                    *state
                                        .adapter_retry_ledger
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner()),
                                    my_generation,
                                );
                                crate::lifecycle::adapter_arm_outcome(
                                    already_error,
                                    adapter_failure_seen,
                                    was_intentional,
                                    durable_intent,
                                    used,
                                )
                            }
                            None => crate::lifecycle::AdapterFailureOutcome::NotAdapter,
                        };
                        match (adapter_outcome, state_opt.as_ref()) {
                            (crate::lifecycle::AdapterFailureOutcome::Retry { attempt }, Some(state)) => {
                                // Record the attempt for THIS generation BEFORE scheduling, so the
                                // restarted core's own exit reads it and the budget cannot loop.
                                *state
                                    .adapter_retry_ledger
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner()) = (my_generation, attempt);
                                crate::logging::log_app(
                                    "INFO",
                                    &adapter_retry_log_line(
                                        attempt,
                                        crate::lifecycle::ADAPTER_RETRY_MAX_ATTEMPTS,
                                    ),
                                );
                                crate::commands::vpn::start_adapter_retry(
                                    app_handle.clone(),
                                    my_generation,
                                    attempt,
                                    my_config_name.clone(),
                                );
                                continue;
                            }
                            (crate::lifecycle::AdapterFailureOutcome::Exhausted, Some(state)) => {
                                crate::logging::log_app(
                                    "INFO",
                                    &format!(
                                        "[vpn] WinTUN adapter was not created after {} retries — showing the error (G-03.1-7)",
                                        crate::lifecycle::ADAPTER_RETRY_MAX_ATTEMPTS
                                    ),
                                );
                                // Same stamp the generic Error path below writes (G-19-6 v3): the
                                // error plate names the config that FAILED.
                                if let Ok(mut g) = state.pending_error_config_name.lock() {
                                    *g = Some(my_config_name.to_string());
                                }
                                set_vpn_status(
                                    &app_handle,
                                    state,
                                    VpnStatus::Error,
                                    Some(crate::lifecycle::ADAPTER_CREATION_FAILED_REASON.to_string()),
                                );
                                continue;
                            }
                            _ => {}
                        }
                        let (status, error_msg): (VpnStatus, Option<String>) = {
                            use std::sync::atomic::Ordering;
                            let preflight_offline = state_opt
                                .as_ref()
                                .map(|s| s.last_preflight_offline.load(Ordering::SeqCst))
                                .unwrap_or(false);
                            match crate::lifecycle::never_connected_exit_reason(
                                was_intentional,
                                durable_intent,
                                preflight_offline,
                                core_exit_reason,
                            ) {
                                None => (VpnStatus::Disconnected, None),
                                Some(reason) => (VpnStatus::Error, Some(reason.to_string())),
                            }
                        };
                        // `already_error` (R3 / WR-01, read above the adapter decision) keeps the
                        // authoritative first reason.
                        if already_error {
                            crate::logging::log_app(
                                "INFO",
                                "[sidecar] exit after a terminal Error — keeping the authoritative reason (R3/WR-01)",
                            );
                        } else if let Some(state) = state_opt {
                            // G-19-6 v3: for an Error exit, stamp THIS session's captured name so
                            // maybe_fire names the ConnectionError plate after the config that FAILED,
                            // not a config_path a concurrent reconnect/switch-back already repointed.
                            if status == VpnStatus::Error {
                                if let Ok(mut g) = state.pending_error_config_name.lock() {
                                    *g = Some(my_config_name.to_string());
                                }
                            }
                            set_vpn_status(&app_handle, &state, status, error_msg);
                        }
                    }
                }
                _ => {}
            }
        }
    });

    // `job` is kept alive here for the connection's lifetime — dropping the
    // SidecarChild (on kill / session end) closes the handle once and arms the
    // OS kill. No manual CloseHandle anywhere (OwnedJobHandle::drop owns it).
    Ok(SidecarChild { child, disconnecting: disc_for_child, job })
}

/// How long the sidecar is given to run its OWN cleanup-on-exit (WFP / route /
/// killswitch teardown, all owned by the C++ sidecar — Rust cannot remove those
/// filters itself) after a GRACEFUL terminate signal, before we fall back to the
/// guaranteed hard kill. Short and bounded (T-22 B1): a hung sidecar must still be
/// hard-killed promptly so a stuck adapter / killswitch never strands the machine.
/// The hard kill + the KILL_ON_JOB_CLOSE Job Object remain the guaranteed fallback;
/// this window only ADDS a chance for a graceful self-teardown FIRST, it never
/// replaces the hard kill.
///
/// G-03.1-10: the stop request is now a Ctrl+C the core really receives (console_ctrl.rs), and
/// the core answers it by running `client->disconnect()` — adapter, routes and killswitch
/// removed — before it exits with 0. The old request (`taskkill /PID` without `/F`) never
/// reached the windowless core, so this window used to be pure dead-wait and was cut to
/// 1500ms; now it is the time the core's own cleanup may take, so it must be long enough not
/// to cut that cleanup off with a hard kill halfway through. The loop below breaks the moment
/// the core exits, so a normal disconnect costs only the cleanup itself; the full ceiling is
/// paid only by a core that is stuck (e.g. blocked inside a failing adapter creation), which
/// then gets the same hard kill as before.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS: u64 = 5000;
/// Poll cadence while waiting for the graceful terminate to take effect.
const GRACEFUL_SHUTDOWN_POLL_MS: u64 = 100;

/// 3.2 R-KILL (F13): after the HARD kill, how long to poll for the process to actually EXIT before
/// reporting the teardown complete. `child.kill()` (TerminateProcess) only INITIATES termination and
/// `taskkill /F` waits for the taskkill TOOL, not the target's exit — so a fast reconnect that lands
/// while the .exe is still terminating (and the WinTUN adapter still releasing) races the teardown
/// (F13). 5s is a generous ceiling for a TerminateProcess to finish; the common case breaks out of
/// the poll in a few ticks.
const HARD_KILL_CONFIRM_TIMEOUT_MS: u64 = 5000;
/// Poll cadence while confirming the hard kill took effect.
const HARD_KILL_CONFIRM_POLL_MS: u64 = 100;

/// G-03.1-10: the app-exit paths get a shorter graceful window than a disconnect. They block the
/// event-loop thread (and Windows gives a session end only a few seconds), while the core's own
/// cleanup takes a fraction of a second; a core that needs longer is stuck and gets the hard kill.
const EXIT_GRACEFUL_TIMEOUT_MS: u64 = 2500;

/// G-03.1-10 (deep review #1): core stops still in progress. The core opens its WinTUN adapter by a
/// fixed name, so a new core started while the previous one is still running its graceful cleanup
/// would reuse that adapter — and the old core's cleanup would then remove it from under the new
/// one. With the old hard kill the overlap was the few milliseconds of TerminateProcess; the graceful
/// stop takes as long as the core's cleanup. Every stop counts itself here for its whole duration,
/// and every spawn waits until the count is zero (`wait_for_core_stops_in_flight`), whichever path
/// (window, tray, supervisor, exit) started the stop.
static CORE_STOPS_IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Longest a spawn waits for earlier stops: a full graceful window, the hard-kill confirm poll and
/// a margin. Past it the spawn proceeds anyway — never worse than before the gate existed.
const WAIT_FOR_CORE_STOPS_MAX_MS: u64 = GRACEFUL_SHUTDOWN_TIMEOUT_MS + HARD_KILL_CONFIRM_TIMEOUT_MS + 1000;

/// RAII count of one stop in progress (dropped on every return path of the stop).
struct CoreStopInFlight;

impl CoreStopInFlight {
    fn begin() -> Self {
        CORE_STOPS_IN_FLIGHT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        CoreStopInFlight
    }
}

impl Drop for CoreStopInFlight {
    fn drop(&mut self) {
        CORE_STOPS_IN_FLIGHT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Wait (bounded) until no earlier core is still stopping. Returns at once in the common case.
async fn wait_for_core_stops_in_flight() {
    let in_flight = || CORE_STOPS_IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst);
    if in_flight() == 0 {
        return;
    }
    let mut waited_ms: u64 = 0;
    while in_flight() > 0 && waited_ms < WAIT_FOR_CORE_STOPS_MAX_MS {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        waited_ms += 50;
    }
    crate::logging::log_app(
        "INFO",
        &format!(
            "[vpn] spawn waited {waited_ms}ms for the previous core to finish its own cleanup (still stopping: {}) (G-03.1-10)",
            in_flight()
        ),
    );
}

/// 3.8 delay-green (owner decision): how long to HOLD «Подключение» while waiting for real
/// traffic-readiness (a DNS-INDEPENDENT raw-IP HTTPS round-trip through the tunnel) after the C++ core's "Successfully connected"
/// handshake edge, before emitting Connected anyway as an honest fallback. The handshake edge is
/// tunnel-UP, not traffic-READY — on http3/QUIC the tunnel can be up while real traffic does not flow
/// for ~30-40s. `dns_probe` polls every 500ms and returns the moment traffic works, so http2 (already
/// traffic-ready) flips green ~instantly; only http3's warmup shows «Подключение» up to this cap. We
/// cannot wait forever, so at the cap we flip green regardless (better than an endless «Подключение»).
///
/// MUST stay BELOW `lifecycle::CONNECT_TIMEOUT` (60s): the connect-timeout watchdog waits for the
/// Connected STATUS and kills the session if it never arrives within 60s. Since delay-green DELAYS
/// that status, the cap has to emit Connected (at the latest) before the watchdog's deadline — 45s
/// leaves a comfortable margin while still covering the ~30-40s http3 warmup.
/// 28-02: `pub(crate)` so the relationship can be ASSERTED rather than described.
/// `lifecycle::RECONNECT_ATTEMPT_WINDOW`'s doc comment already names this constant as if it were
/// reachable — but while it was private that reference resolved to nothing, so the comment
/// described a link the compiler could not see and nothing stopped a future edit from breaking it.
/// The `attempt_window_must_stay_above_the_traffic_readiness_cap` tripwire now holds it.
pub(crate) const TRAFFIC_READINESS_CAP: std::time::Duration = std::time::Duration::from_secs(45);

/// 3.8 F-3 (Fable-5 review): safety margin between the traffic-readiness fallback emit and the
/// connect-timeout watchdog's deadline. The honest Connected fallback must land at least this
/// long BEFORE the watchdog would fire, so a nearly-ready session is never killed a hair before
/// it flips green.
const TRAFFIC_READINESS_WATCHDOG_MARGIN: std::time::Duration = std::time::Duration::from_secs(5);

/// 3.8 F-3: the ACTUAL traffic-readiness probe budget, bounded so the honest fallback emit always
/// precedes the connect-timeout watchdog deadline.
///
/// The watchdog (`lifecycle::CONNECT_TIMEOUT`, 60s) runs from the CONNECT and kills the session if
/// the Connected STATUS never arrives. This probe, however, starts at the HANDSHAKE — `elapsed`
/// after the child spawned. The old code always waited the flat `TRAFFIC_READINESS_CAP` (45s) from
/// the handshake, so a LATE handshake (e.g. flaky QUIC retries land it at T+20s) pushed the honest
/// fallback emit to T+65s — PAST the 60s deadline — and the watchdog killed a healthy, nearly-ready
/// session (the "45s < 60s" comment was a wrong-origin invariant: it only held when the handshake
/// landed within the first ~15s). Budget = min(CAP, CONNECT_TIMEOUT − elapsed − margin): a late
/// handshake SHRINKS the budget instead of overrunning the watchdog. Pure so the cap-vs-watchdog
/// invariant is unit-tested (`traffic_readiness_budget_stays_under_watchdog`).
fn traffic_readiness_budget(elapsed_since_spawn: std::time::Duration) -> std::time::Duration {
    let watchdog_budget = crate::lifecycle::CONNECT_TIMEOUT
        .saturating_sub(elapsed_since_spawn)
        .saturating_sub(TRAFFIC_READINESS_WATCHDOG_MARGIN);
    std::cmp::min(TRAFFIC_READINESS_CAP, watchdog_budget)
}

/// Pure decision for T-22 B2 (honest `kill_sidecar`): given the outcomes of the
/// two HARD-kill paths (the in-process `child.kill()` == `TerminateProcess`, and
/// the out-of-band `taskkill /F /PID`), should `kill_sidecar` report FAILURE?
///
/// It is a failure ONLY when BOTH hard paths reported failure — in that case the
/// sidecar may still be alive holding the fail-closed killswitch / WinTUN adapter,
/// and the caller (`vpn_disconnect`) MUST surface that instead of believing the
/// teardown succeeded (the old code returned `Ok(())` unconditionally — T-22 leak,
/// deferred IN-02). If EITHER hard path succeeded the process is dead, so it is a
/// success regardless of the graceful attempt's outcome. Free of any IO so the
/// decision is unit-testable without a real process.
fn kill_succeeded(hard_kill_ok: bool, taskkill_ok: bool) -> bool {
    hard_kill_ok || taskkill_ok
}

/// 3.2 R-KILL (F13): after the bounded post-hard-kill liveness poll, is the sidecar teardown
/// CONFIRMED complete? `child.kill()`/`taskkill` only INITIATE termination, so the ONLY authoritative
/// signal is the process actually being GONE (`!alive_after_poll`). The kill-call outcomes are
/// advisory (the caller logs them): a reported success with the process still alive is NOT confirmed
/// (it did not take — a fast reconnect would race a live sidecar holding the killswitch/adapter); a
/// reported failure with the process gone IS confirmed (it exited on its own between the poll and the
/// calls). Pure + IO-free so the alive/gone decision is unit-testable without a real process.
fn hard_kill_confirmed(alive_after_poll: bool) -> bool {
    !alive_after_poll
}

/// Is the process with `pid` still alive? Windows-only liveness probe used to tell
/// whether the GRACEFUL terminate (T-22 B1) let the sidecar exit on its own before
/// we escalate to the hard kill. Returns `false` (treat as gone) on any probe error
/// so we never BLOCK escalation on a flaky query — a false "gone" only means we skip
/// the redundant hard kill on an already-dead process, and the Job Object still
/// guarantees no zombie.
// 3.8 F-2: pub(crate) so the reconnect supervisor (connectivity.rs) can detect a respawned
// child's death directly. During a reconnect attempt the supervisor holds `reconnect_in_progress`,
// so the Terminated arm DEFERS and the status stays `Reconnecting` — a dead respawn is invisible
// via status alone, so respawn_and_wait probes the PID's liveness to fail the attempt promptly.
#[cfg(windows)]
pub(crate) fn process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };
    // SAFETY: FFI into documented Win32 APIs. We open the process for query +
    // synchronize, check both the wait state and the exit code, and always close
    // the handle. A null handle (process gone / access denied) ⇒ treat as not alive.
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if handle.is_null() {
            // Could not open ⇒ most likely already exited (or no rights). Either way
            // we do not block escalation: report "not alive" so the caller proceeds.
            return false;
        }
        // WaitForSingleObject(0) returns WAIT_TIMEOUT while the process is still
        // running, and WAIT_OBJECT_0 (0) once it has signaled (exited).
        let waited = WaitForSingleObject(handle, 0);
        let mut exit_code: u32 = 0;
        let got_code = GetExitCodeProcess(handle, &mut exit_code) != 0;
        CloseHandle(handle);
        // Alive == the wait timed out AND the exit code is still STILL_ACTIVE.
        waited == WAIT_TIMEOUT && got_code && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(windows))]
pub(crate) fn process_is_alive(_pid: u32) -> bool {
    // Non-Windows builds don't run the real sidecar; assume gone so the kill path
    // is a no-op-friendly success (mirrors the job_object non-windows twin).
    false
}

/// G-03.1-10: ask the core to stop through its own Ctrl+C handler (delivered by the one-shot
/// helper, `console_ctrl::send_ctrl_c`) and log the outcome. Returns whether the request was
/// delivered; a `false` means waiting for a graceful exit is pointless and the caller goes straight
/// to the hard kill. Blocks for the helper (normally tens of milliseconds, at most 3 s), so async
/// callers run it on the blocking pool. Only the PID and numbers are logged (D-29).
fn request_graceful_stop(pid: u32) -> bool {
    match crate::console_ctrl::send_ctrl_c(pid) {
        Ok(()) => {
            crate::logging::log_app(
                "INFO",
                &format!(
                    "[vpn] kill_sidecar: requested graceful shutdown for PID {pid} (requested=true, Ctrl+C) — waiting up to {GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms for the sidecar to run its own adapter/route/killswitch cleanup (T-22 B1, G-03.1-10)"
                ),
            );
            true
        }
        Err(e) => {
            crate::logging::log_app(
                "WARN",
                &format!("[vpn] kill_sidecar: graceful shutdown request for PID {pid} not delivered ({e}) — hard kill"),
            );
            false
        }
    }
}

/// Blocking twin of `kill_sidecar` for the app-exit paths (`kill_sidecar_from_state`: tray
/// «Выход», the exit events, the update install), which run on the event-loop thread with nothing
/// to await on. Until G-03.1-10 they hard-killed the core outright, so every quit left the adapter,
/// routes and killswitch for Windows to clean up, and a connect right after the next start could
/// hit the WinTUN adapter failure. Now the core gets the same graceful stop as a disconnect, and
/// the hard kill stays as the fallback (the KILL_ON_JOB_CLOSE job still ends it with the app).
pub fn stop_sidecar_on_exit(sidecar: SidecarChild) {
    let pid = sidecar.child.pid();
    // The shared `disconnecting` flag is deliberately NOT latched here (review WR-05): the update
    // path keeps running when the install fails after this call, and a latched flag would leave the
    // tray on «Отключение…». Quit already bumps the generation (`begin_shutdown`), which silences the
    // core's late exit; the other callers are the process exiting.
    let _in_flight = CoreStopInFlight::begin();
    if request_graceful_stop(pid) {
        let mut waited_ms: u64 = 0;
        while waited_ms < EXIT_GRACEFUL_TIMEOUT_MS {
            if !process_is_alive(pid) {
                crate::logging::log_app(
                    "INFO",
                    &format!("[vpn] kill_sidecar: PID {pid} exited gracefully on app exit — its own cleanup ran (G-03.1-10)"),
                );
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(GRACEFUL_SHUTDOWN_POLL_MS));
            waited_ms += GRACEFUL_SHUTDOWN_POLL_MS;
        }
        crate::logging::log_app(
            "WARN",
            &format!("[vpn] kill_sidecar: PID {pid} did not exit gracefully within {EXIT_GRACEFUL_TIMEOUT_MS}ms on app exit — hard kill"),
        );
    }
    sidecar.child.kill().ok();
}

/// Tear down the session's sidecar (T-22 B1 + B2).
///
/// CRITICAL invariant: the sidecar PROCESS owns the WinTUN adapter, the routing
/// hijack AND the fail-closed killswitch (WFP filters / routes) in C++. Rust has NO
/// independent path to remove those filters — the ONLY way they are torn down is the
/// sidecar running its OWN cleanup-on-exit. A hard `TerminateProcess` (what the old
/// code did FIRST, and what the KILL_ON_JOB_CLOSE Job Object does on app death) gives
/// the sidecar NO chance to run that cleanup, so a hard-only kill can LEAK the
/// all-traffic killswitch block (the T-22 "Docker hang" / "boot stall" mechanism).
///
/// So we now:
///   1. B1 — send a GRACEFUL stop first: a Ctrl+C into the core's own console
///      (`console_ctrl::send_ctrl_c`, G-03.1-10), which runs the core's SIGINT handler
///      and its `client->disconnect()` — adapter, routes and killswitch removed — and
///      WAIT a bounded window (`GRACEFUL_SHUTDOWN_TIMEOUT_MS`) for it to exit on its own.
///   2. FALLBACK (zombie-kill guarantee PRESERVED) — if it is still alive after that
///      window, escalate to the existing HARD kill: the in-process `child.kill()`
///      (`TerminateProcess`) AND `taskkill /F /PID`. The KILL_ON_JOB_CLOSE Job Object
///      (job_object.rs) remains armed via the `SidecarChild` drop, so a hung sidecar
///      is ALWAYS killed regardless — we only ADDED a graceful attempt before it.
///   3. B2 — if BOTH hard paths fail, the process may still be alive holding the
///      killswitch: return `Err` (the old code swallowed this as `Ok(())` — deferred
///      IN-02) so the caller surfaces the failure instead of believing teardown won.
///
/// The graceful leg is proven on a real windowless console process by the
/// `console_ctrl` tests; the stop request used until G-03.1-10 (`taskkill /PID`
/// without `/F`) never reached the windowless core and is kept there as a negative test.
pub async fn kill_sidecar(sidecar: SidecarChild) -> Result<(), Box<dyn std::error::Error>> {
    let pid = sidecar.child.pid();
    // G-03.1-10: counted until this function returns — no new core starts meanwhile.
    let _in_flight = CoreStopInFlight::begin();

    // ── 1. B1 — graceful stop FIRST, then a bounded wait ──────────
    // We do NOT consume `sidecar.child` here — we keep it so the hard `child.kill()`
    // fallback is still available if the graceful stop does not take.
    let requested = tokio::task::spawn_blocking(move || request_graceful_stop(pid))
        .await
        .unwrap_or(false);

    // Poll for the process to exit on its own within the bounded window. An undelivered request
    // skips the wait: nothing will make the core exit by itself, so waiting only delays the kill.
    let mut waited_ms: u64 = 0;
    let mut exited_gracefully = false;
    while requested && waited_ms < GRACEFUL_SHUTDOWN_TIMEOUT_MS {
        if !process_is_alive(pid) {
            exited_gracefully = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(GRACEFUL_SHUTDOWN_POLL_MS)).await;
        waited_ms += GRACEFUL_SHUTDOWN_POLL_MS;
    }

    if exited_gracefully {
        // The sidecar exited on its own → it had the chance to tear down its
        // WFP/route/killswitch filters. No hard kill needed; teardown succeeded.
        crate::logging::log_app(
            "INFO",
            &format!("[vpn] kill_sidecar: PID {pid} exited gracefully — its own cleanup ran (T-22 B1)"),
        );
        return Ok(());
    }

    // ── 2. FALLBACK — guaranteed HARD kill (zombie-kill guarantee preserved) ──
    // Still alive after the graceful window (or no graceful handler) → hard-kill.
    // This is the SAME guaranteed teardown as before, now reached only AFTER the
    // graceful attempt. The KILL_ON_JOB_CLOSE Job Object also stays armed via the
    // SidecarChild drop, so a hung sidecar can never become a zombie.
    if requested {
        crate::logging::log_app(
            "WARN",
            &format!("[vpn] kill_sidecar: PID {pid} did not exit gracefully within {GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms — escalating to hard kill (fallback preserved)"),
        );
    }
    // In-process TerminateProcess (consumes the child handle).
    let hard_kill_ok = sidecar.child.kill().is_ok();
    // Force-kill by PID as the belt-and-braces second hard path.
    let taskkill_ok = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    // ── 3. R-KILL (F13) — CONFIRM the process is actually GONE before reporting success ──
    // `child.kill()` (TerminateProcess) only INITIATES termination and `taskkill /F` waits for the
    // taskkill TOOL, not the target's exit — so both can "report success" while the .exe is still
    // terminating and the WinTUN adapter still releasing. The old code returned Ok as soon as EITHER
    // reported success (kill_succeeded), so `vpn_disconnect` wrote Disconnected while teardown was
    // still in flight → a fast reconnect raced it ("connection failed" + the churn-log WINTUN
    // "adapter not found" on the very next spawn — F13). Poll `process_is_alive` for a bounded window
    // and report success ONLY when the process is provably gone. The kill_succeeded outcomes are now
    // advisory (logged); the liveness poll is authoritative. The KILL_ON_JOB_CLOSE Job Object stays
    // armed via the SidecarChild drop as the last-resort guarantee. PID is non-secret (A2 / D-29 ok).
    let mut confirm_waited_ms: u64 = 0;
    let mut alive_after_poll = true;
    while confirm_waited_ms < HARD_KILL_CONFIRM_TIMEOUT_MS {
        if !process_is_alive(pid) {
            alive_after_poll = false;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(HARD_KILL_CONFIRM_POLL_MS)).await;
        confirm_waited_ms += HARD_KILL_CONFIRM_POLL_MS;
    }
    if !hard_kill_confirmed(alive_after_poll) {
        // Still alive after the confirm window → genuinely stuck; it may still hold the fail-closed
        // killswitch / WinTUN adapter. Surface the honest failure so the disconnect does not claim a
        // completed teardown (the Job Object remains the last-resort kill on app exit).
        let msg = format!(
            "[vpn] kill_sidecar: PID {pid} still alive {HARD_KILL_CONFIRM_TIMEOUT_MS}ms after hard kill (hard_kill_ok={hard_kill_ok}, taskkill_ok={taskkill_ok}) — sidecar may still hold the killswitch/adapter"
        );
        crate::logging::log_app("WARN", &msg);
        return Err(msg.into());
    }
    if !kill_succeeded(hard_kill_ok, taskkill_ok) {
        // Confirmed gone even though neither kill call reported success — it exited on its own
        // between the poll and the calls. Teardown still succeeded (the process is provably gone).
        crate::logging::log_app(
            "INFO",
            &format!("[vpn] kill_sidecar: PID {pid} confirmed gone though no kill path reported success (raced exit)"),
        );
    }
    crate::logging::log_app(
        "INFO",
        &format!("[vpn] kill_sidecar: PID {pid} confirmed gone after hard kill (T-22 B2 / 3.2 R-KILL)"),
    );
    Ok(())
}

/// Spawn the sidecar with given args, wait for it to finish, and return combined output.
pub async fn spawn_with_args(
    app: &tauri::AppHandle,
    args: &[&str],
) -> Result<String, Box<dyn std::error::Error>> {
    let shell = app.shell();

    let output = shell
        .sidecar("trusttunnel_client")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to execute sidecar: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let mut result = stdout;
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(&stderr);
    }

    Ok(result)
}

/// The core's own log text that marks its TUN listener (i.e. the WinTUN adapter) as ready. There are
/// TWO such lines, and either one is enough (WR-03):
/// - upstream `core/src/vpn_manager.cpp` `vpn_listen` logs «vpn_listen: [0] ...» when it starts and
///   «vpn_listen: [0] Done» after the start-listening transition returned;
/// - upstream `core/src/vpn_fsm.cpp` `start_listening` logs «start_listening: [0] Client has been
///   successfully prepared to run» only when `listen` returned without an error.
///
/// Both follow the creation of the adapter (`make_tun_listener` runs before `vpn_listen`) and neither
/// is printed on the failure path, so accepting both means a core update that rewords or re-levels
/// ONE of them cannot hold every connect on «Подключение...» until the 60 s timeout — the app would
/// need both to change at once.
///
/// **These literals, and `ENDPOINT_CONNECTED_MARKER`, are a contract with a binary that is not in
/// git.** A Rust test cannot read the core on `master`, so nothing here notices a core bump: the
/// core-sync checklist (`.planning/release/upstream-1.1.7-audit.md`, «Core log lines the app
/// parses», and the core section of `CLAUDE.md`) lists them, and re-checking them is a step of
/// every core sync.
const TUN_LISTENER_TAG: &str = "VPNCORE vpn_listen:";
const TUN_LISTENER_DONE_SUFFIX: &str = "] Done";
const TUN_LISTENER_PREPARED_TAG: &str = "VPNCORE start_listening:";
const TUN_LISTENER_PREPARED_SUFFIX: &str = "successfully prepared to run";
/// The core's endpoint-handshake line (upstream `trusttunnel_client.cpp`).
const ENDPOINT_CONNECTED_MARKER: &str = "Successfully connected to endpoint";

/// True for the core's two TUN-listener-ready lines — «VPNCORE vpn_listen: [0] Done» and «VPNCORE
/// start_listening: [0] Client has been successfully prepared to run» — and for nothing else: the
/// «...» openers, the failure line of `start_listening`, and every other «Done» line (vpn_open /
/// vpn_connect / vpn_stop / vpn_close) are rejected.
fn is_tun_listener_ready_line(line: &str) -> bool {
    let line = line.trim_end();
    (line.contains(TUN_LISTENER_TAG) && line.ends_with(TUN_LISTENER_DONE_SUFFIX))
        || (line.contains(TUN_LISTENER_PREPARED_TAG) && line.ends_with(TUN_LISTENER_PREPARED_SUFFIX))
}

/// G-03.1-7: the Connected gate of ONE core process. The core creates the WinTUN adapter on its main
/// thread in parallel with the endpoint connect, so the endpoint line alone does not mean a tunnel
/// exists: a traffic probe started on it can pass over the physical network while the adapter is
/// still being created, and the app would report a working VPN with no tunnel and no killswitch.
/// The gate therefore opens only once BOTH lines were seen, in either order, and opens exactly once
/// (the once-per-process latch that keeps a still-alive core's later log lines — including its own
/// recovery's second «Successfully connected to endpoint» — from re-asserting Connected).
/// A respawned core gets a fresh value (`Default` is closed). Pure, so the rule is unit-testable.
#[derive(Default)]
struct ConnectReadiness {
    endpoint_connected: bool,
    tun_listener_ready: bool,
    probe_started: bool,
}

impl ConnectReadiness {
    /// Feed one core log line. Returns true exactly once: on the first line after which both the
    /// endpoint and the listener have been seen.
    fn observe(&mut self, line: &str) -> bool {
        if line.contains(ENDPOINT_CONNECTED_MARKER) {
            self.endpoint_connected = true;
        }
        if is_tun_listener_ready_line(line) {
            self.tun_listener_ready = true;
        }
        if self.endpoint_connected && self.tun_listener_ready && !self.probe_started {
            self.probe_started = true;
            return true;
        }
        false
    }
}

/// Check sidecar log lines for connection milestones. The traffic-readiness probe starts only after the
/// SAME core process reported BOTH the endpoint handshake AND its TUN listener ready (`ConnectReadiness`,
/// either order — G-03.1-7); then "connected" is emitted once a real traffic-readiness probe succeeds
/// (3.8 delay-green) — a DNS-independent raw-IP HTTPS round-trip through the tunnel — capped
/// at TRAFFIC_READINESS_CAP, then emitted anyway as an honest fallback so http2 stays fast while http3
/// holds «Подключение» until traffic actually flows. A core that reaches the endpoint but never
/// reports its listener stays «Подключение...» and the connect-timeout watchdog ends it.
// Internal reader-task helper: the args are the line + the app handle + the shared disconnecting Arc +
// the per-lifetime state (dns flag + the Connected gate) + spawn_time + the session generation (3.1b).
// They are all genuinely distinct inputs threaded straight from the reader loop; bundling them into a
// struct would only move the noise, so allow the arg count here.
#[allow(clippy::too_many_arguments)]
async fn check_sidecar_markers(
    line: &str,
    app: &tauri::AppHandle,
    disconnecting: &Arc<Mutex<bool>>,
    dns_proxy_ready: &mut bool,
    readiness: &mut ConnectReadiness,
    spawn_time: &Instant,
    // 3.1b R-GEN (F14): the generation of the session this reader task belongs to. Used to gate the
    // Connected emit (both the sync and the detached-probe path) against a superseded/cancelled
    // session — a buffered "Successfully connected" from a dead session must not write a bogus
    // Connected (the sync path previously had no staleness guard at all).
    session_generation: u64,
) {
    let cancelled = disconnecting.lock().map(|g| *g).unwrap_or(false);
    if cancelled {
        return;
    }

    // Track DNS proxy readiness from sidecar logs
    if !*dns_proxy_ready && (line.contains("DNS proxy listening") || line.contains("System DNS proxy listening")) {
        *dns_proxy_ready = true;
        let elapsed = spawn_time.elapsed().as_millis();
        let msg = format!("[vpn] T+{elapsed}ms: DNS proxy ready");
        eprintln!("{msg}");
        crate::logging::log_app("INFO", &msg);
    }

    // Track the two Connected preconditions (endpoint handshake, TUN listener). The gate observes the
    // line; the fixed phrases below are logged once, when the matching flag flips (D-29: a
    // millisecond count only, never core log text).
    let had_endpoint = readiness.endpoint_connected;
    let had_listener = readiness.tun_listener_ready;
    let both_seen = readiness.observe(line);
    if !had_endpoint && readiness.endpoint_connected {
        let elapsed = spawn_time.elapsed().as_millis();
        let msg = format!("[vpn] T+{elapsed}ms: handshake complete");
        eprintln!("{msg}");
        crate::logging::log_app("INFO", &msg);
    }
    if !had_listener && readiness.tun_listener_ready {
        let elapsed = spawn_time.elapsed().as_millis();
        let msg = format!("[vpn] T+{elapsed}ms: TUN listener ready");
        eprintln!("{msg}");
        crate::logging::log_app("INFO", &msg);
    }

    // Start the readiness probe when the endpoint AND the TUN listener were both seen — ONCE per
    // sidecar lifetime (`ConnectReadiness::observe` opens exactly once). The old guard was ONLY
    // `!is_already_connected`, so after the connectivity monitor moved the status to
    // Recovering/Reconnecting on a drop, the NEXT stdout line from this still-alive sidecar saw
    // status != Connected and re-emitted Connected — overwriting «Восстановление»/«Переподключение»
    // back to «Подключено» (the stuck-green bug, UAT 65692c test 4). Latching the emit means the
    // monitor and the reconnect supervisor own every status transition after the first connect; a
    // respawned sidecar has its own fresh gate and connects the new session.
    if both_seen && !is_already_connected(app) {
        // The gate has already latched (a burst of stdout lines cannot re-enter);
        // emit_connected's own is_already_connected guard still prevents a duplicate
        // "vpn-status" event.
        // 3.8 delay-green (owner decision — HOLD «Подключение» until traffic actually flows): the
        // "Successfully connected" handshake edge is TUNNEL-UP, not TRAFFIC-READY. On http3/QUIC the
        // tunnel can be up while real traffic does not flow for ~30-40s (the «зелёная карточка
        // ≠ рабочий интернет»). So instead of flipping to Connected on the handshake edge, ALWAYS run a
        // traffic-readiness probe first (a DNS-independent raw-IP HTTPS round-trip through the tunnel — with killswitch ON it fails
        // exactly as long as real traffic fails, so it is honest by construction), capped at
        // TRAFFIC_READINESS_CAP, and emit Connected on success OR at the cap (honest fallback — we
        // cannot hold «Подключение» forever). For http2 the probe succeeds ~instantly, so it stays
        // fast; only http3's warmup shows «Подключение» longer. `dns_proxy_ready` is still tracked and
        // logged above but no longer gates the emit — the probe implicitly waits for the DNS proxy too
        // (it resolves through it).
        //
        // AUDIT-2026-06-11 #1 / 3.1b R-GEN: this probe task is DETACHED and calls emit_connected up to
        // TRAFFIC_READINESS_CAP later. It captures the SESSION identity NOW (the disconnecting Arc +
        // THIS session's generation) and re-checks it via probe_task_may_emit right before emitting —
        // a cancel / a newer session / a terminal Error during the window can never let a stale
        // Connected through (this is the risk Fable flagged for the delay-green variant).
        {
            let app_clone = app.clone();
            let t = *spawn_time;
            let disc_for_probe = Arc::clone(disconnecting);
            // 3.1b R-GEN (F14): gate the detached probe against THIS session's generation (captured by
            // the reader task at spawn) rather than re-reading the live generation here — if the
            // generation already advanced by the time this marker was processed, a re-read would
            // capture the NEW generation and wrongly pass the gate for a superseded session.
            let captured_generation = Some(session_generation);
            tokio::spawn(async move {
                // 3.8 F-3: bound the probe budget so the honest fallback emit precedes the 60s
                // connect-timeout watchdog. The cap alone (measured from the handshake) could
                // exceed the deadline on a late handshake and let the watchdog kill a nearly-ready
                // session. `t.elapsed()` here is the time since spawn at probe-start (≈ handshake).
                let probe_budget = traffic_readiness_budget(t.elapsed());
                let probe_ok = dns_probe(probe_budget).await;
                let elapsed = t.elapsed().as_millis();
                if probe_ok {
                    crate::logging::log_app("INFO", &format!("[vpn] T+{elapsed}ms: traffic-ready (probe ok) — emitting Connected (3.8 delay-green)"));
                } else {
                    crate::logging::log_app("WARN", &format!("[vpn] T+{elapsed}ms: traffic-readiness cap reached — emitting Connected anyway (3.8 delay-green)"));
                }
                // AUDIT-2026-06-11 #1: bail when the session this latch belonged to is
                // no longer live. All four signals are needed: the transient
                // `disconnecting` covers an IN-FLIGHT cancel; the durable
                // `user_disconnect_requested` covers a COMPLETED cancel (the transient
                // flag is reset at the end of vpn_disconnect — WR-01/T-31); the
                // generation covers any newer connect/disconnect; and the in-progress
                // status check covers a terminal Error (connect-timeout), which does
                // NOT bump the generation. Status writes still route ONLY through
                // set_vpn_status — this gate just stops a stale actor from writing
                // (D-01 single-mutator invariant untouched).
                let disconnecting_now = disc_for_probe.lock().map(|g| *g).unwrap_or(false);
                let may_emit = match (app_clone.try_state::<AppState>(), captured_generation) {
                    (Some(state), Some(captured)) => {
                        use std::sync::atomic::Ordering;
                        let durable = state.user_disconnect_requested.load(Ordering::SeqCst);
                        let live = state.connection_generation.load(Ordering::SeqCst);
                        let status = *state.vpn_status.lock().unwrap_or_else(|e| e.into_inner());
                        probe_task_may_emit(disconnecting_now, durable, captured, live, status)
                    }
                    // No AppState / no captured generation ⇒ the session's liveness
                    // cannot be proven — suppress rather than risk a stale Connected.
                    _ => false,
                };
                if !may_emit {
                    crate::logging::log_app(
                        "INFO",
                        &format!("[vpn] T+{elapsed}ms: readiness probe finished but the session is stale/cancelled — suppressing Connected (AUDIT #1)"),
                    );
                    return;
                }
                emit_connected(&app_clone, &t);
            });
        }
    }
}

/// AUDIT-2026-06-11 #1: pure staleness gate for the detached DNS-probe task.
///
/// The probe task latches at handshake time (`check_sidecar_markers`) but emits up
/// to 10s later — after the user may have cancelled, or the connect-timeout
/// watchdog may have set a terminal Error. It may emit Connected ONLY while:
/// - no disconnect is in flight (transient `disconnecting` flag), AND
/// - no COMPLETED manual disconnect happened (durable `user_disconnect_requested`,
///   T-31 — the transient flag is already reset at the end of vpn_disconnect), AND
/// - the connection generation captured at latch time is still the live one (any
///   newer connect/disconnect advances it — `lifecycle::is_current_generation`), AND
/// - the live status is still an IN-PROGRESS connect state (Connecting for a first
///   connect, Reconnecting for a supervisor respawn). A terminal Error (e.g.
///   connect-timeout at T+60s with the handshake at ~T+55s) does NOT bump the
///   generation, so this status check is what protects it; Disconnected/Recovering/
///   Connected are owned by other actors and must not be overwritten either.
///
/// Pure (no IO / no locks) so the decision matrix is unit-testable.
fn probe_task_may_emit(
    disconnecting: bool,
    user_disconnect_requested: bool,
    captured_generation: u64,
    live_generation: u64,
    status: VpnStatus,
) -> bool {
    !disconnecting
        && !user_disconnect_requested
        && crate::lifecycle::is_current_generation(captured_generation, live_generation)
        && matches!(status, VpnStatus::Connecting | VpnStatus::Reconnecting)
}

/// AUDIT-2026-06-11 #4: pure identity gate for the reader task's Terminated arm.
///
/// The arm may act on the SHARED session state (clear the `sidecar_child` slot,
/// write a status, hand off to the reconnect supervisor) only when the slot is
/// EMPTY (this child was already taken out — intentional disconnect / respawn
/// kill, the legitimate own-child paths) or still holds THIS child's own pid.
/// When the slot holds a DIFFERENT pid, a newer session owns the state: clearing
/// the slot would DROP the new `SidecarChild` (closing its KILL_ON_JOB_CLOSE job
/// handle ⇒ the OS kills the fresh sidecar mid-handshake) and the trailing status
/// write would clobber the new session's status.
fn terminated_arm_owns_state(my_pid: u32, stored_pid: Option<u32>) -> bool {
    stored_pid.is_none() || stored_pid == Some(my_pid)
}

/// AUDIT-2026-06-11 #4: does the PID file's current contents record `my_pid`?
/// The Terminated arm deletes `.sidecar-pro.pid` only when this is true — a
/// respawn may have already saved the NEW child's pid into the same file, and an
/// old child's late Terminated must not strip the new session's crash-cleanup
/// fallback. Pure string→decision so it is unit-testable without touching disk.
fn pid_file_records_pid(contents: &str, my_pid: u32) -> bool {
    contents.trim().parse::<u32>().ok() == Some(my_pid)
}

/// True when the single owner already reports `Connected` — the double-emit guard.
fn is_already_connected(app: &tauri::AppHandle) -> bool {
    app.try_state::<AppState>()
        .and_then(|s| s.vpn_status.lock().ok().map(|g| *g == VpnStatus::Connected))
        .unwrap_or(false)
}

fn emit_connected(app: &tauri::AppHandle, spawn_time: &Instant) {
    // Guard against double-emit
    if is_already_connected(app) {
        return;
    }
    let total = spawn_time.elapsed().as_millis();
    let msg = format!("[vpn] T+{total}ms: VPN fully ready");
    eprintln!("{msg}");
    crate::logging::log_app("INFO", &msg);
    // D-08 lifecycle marker (3): handshake / connected — fixed phrase, DEV-gated.
    emit_lifecycle_marker(app, handshake_marker(), "info");
    // Route through the single mutator — normalizes to {status:"connected",error:null}.
    if let Some(state) = app.try_state::<AppState>() {
        set_vpn_status(app, &state, VpnStatus::Connected, None);
    }
}

/// 16-08 (gap 5c): the delay-green readiness gate. Returns true the moment a real
/// DNS-INDEPENDENT traffic round-trip succeeds through the tunnel, or false when
/// `max_wait` elapses first.
///
/// Historically this resolved a hostname via `tokio::net::lookup_host` — a DNS-ONLY
/// signal. But the connectivity monitor itself already rejects DNS as unreliable
/// (FIX-E, connectivity.rs): the sidecar DNS proxy (a DoH/DoT AdGuard upstream on
/// the IP/self-hosted config) warms and ANSWERS DNS while the data path is still
/// settling → «Подключено» flipped green before real traffic flowed (owner UAT:
/// «зелёная карточка ≠ рабочий интернет» on the IP variant). Now this loops the
/// shared `connectivity::probe_traffic_once` (raw-IP HTTPS to 1.1.1.1 / 1.0.0.1,
/// 2xx/204 = ready) on the SAME 500ms cadence, so green fires only after a genuine
/// round-trip — the same DNS-independent primitive the monitor's liveness probe uses.
///
/// The name is kept so the single caller (delay-green probe task) and the
/// `traffic_readiness_budget` cap + `probe_task_may_emit` staleness gate around it
/// stay byte-for-byte. `max_wait` (the budget) still caps total time, so the honest
/// fallback emit always precedes the 60s connect-timeout watchdog (proven by
/// `traffic_readiness_budget_stays_under_watchdog`). Each attempt is bounded by a
/// short per-attempt timeout so a black-holing path cannot overrun `max_wait`.
async fn dns_probe(max_wait: std::time::Duration) -> bool {
    // Per-attempt round-trip budget: deliberately MIRRORS the monitor's tight liveness
    // timeout `connectivity::TUNNEL_PROBE_TIMEOUT_SECS` (= 3s). The literal is kept local
    // (rather than importing the constant) only to avoid widening that constant's private
    // visibility for a single mirror; if the monitor's timeout ever changes, update this to
    // match. It is additionally clamped to what remains of `max_wait` on the final attempt,
    // so total time never exceeds the budget cap.
    const PER_ATTEMPT: std::time::Duration = std::time::Duration::from_secs(3);
    let start = Instant::now();
    while start.elapsed() < max_wait {
        let remaining = max_wait.saturating_sub(start.elapsed());
        let attempt_timeout = std::cmp::min(PER_ATTEMPT, remaining);
        if crate::connectivity::probe_traffic_once(attempt_timeout).await {
            return true;
        }
        // Same 500ms inter-attempt cadence as the historical DNS loop — but only
        // sleep if the budget still has room, so we never overshoot max_wait waiting.
        if start.elapsed() + std::time::Duration::from_millis(500) >= max_wait {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    false
}

/// T-32: every NOISY_FLUSH_EVERY-th swallowed repeat emits a liveness summary so a
/// long-running burst is still visible in the panel/file without flooding either.
const NOISY_FLUSH_EVERY: u64 = 1000;

/// T-32 (2026-06-11): classify a sidecar stdout line as known flood noise.
/// Returns the burst key (a STABLE label used for counting + the summary line)
/// for lines that arrive thousands-at-a-time when the tunnel dies, None for
/// everything else. Deliberately narrow — only patterns CONFIRMED to flood are
/// collapsed, so novel diagnostics are never hidden. The id=N varies per line,
/// which is why dedup is keyed on this label, not on the raw line.
fn noisy_line_key(line: &str) -> Option<&'static str> {
    if line.contains("DNS proxy request id=") && line.contains("failed") {
        return Some("DNS_HANDLER: DNS proxy request failed");
    }
    None
}

fn parse_log_level(line: &str) -> &str {
    let lower = line.to_lowercase();
    if lower.contains("[error]") || lower.contains("error:") {
        "error"
    } else if lower.contains("[warn]") || lower.contains("warning:") {
        "warn"
    } else if lower.contains("[debug]") || lower.contains("dbg") {
        "debug"
    } else if lower.contains("[trace]") {
        "trace"
    } else {
        "info"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── G-03.1-7: Connected needs the endpoint AND the TUN listener ──
    // Synthetic lines shaped like the core's INFO output (prefix: `[time] date time INFO [tid]`).

    const L_ENDPOINT: &str =
        "[2026-09-30 15:33:19] 30.09.2026 15:33:19.100000 INFO  [62004] TRUSTTUNNEL_CLIENT_APP operator (): Successfully connected to endpoint";
    const L_LISTEN_DONE: &str =
        "[2026-09-30 15:33:19] 30.09.2026 15:33:19.152511 INFO  [62004] VPNCORE vpn_listen: [0] Done";
    const L_LISTEN_OPEN: &str =
        "[2026-09-30 15:33:19] 30.09.2026 15:33:19.050000 INFO  [62004] VPNCORE vpn_listen: [0] ...";

    #[test]
    fn tun_listener_ready_line_matches_only_the_two_listener_ready_lines() {
        assert!(is_tun_listener_ready_line(L_LISTEN_DONE));
        // trailing whitespace / CR from the pipe must not matter
        assert!(is_tun_listener_ready_line(&format!("{L_LISTEN_DONE}\r")));
        assert!(!is_tun_listener_ready_line(L_LISTEN_OPEN));
        for other in [
            "30.09.2026 15:33:19.000000 INFO  [62004] VPNCORE vpn_open: [0] Done",
            "30.09.2026 15:33:19.000000 INFO  [62004] VPNCORE vpn_connect: [0] Done",
            "30.09.2026 15:33:19.000000 INFO  [62004] VPNCORE vpn_stop: [0] Done",
            "30.09.2026 15:33:19.000000 INFO  [62004] VPNCORE vpn_close: [0] Done",
            "",
        ] {
            assert!(!is_tun_listener_ready_line(other), "must not match: {other:?}");
        }
    }

    /// The core's OTHER listener-ready line: `start_listening` logs it only when `listen` returned
    /// without an error (`core/src/vpn_fsm.cpp`), right before `vpn_listen` logs its own «Done».
    const L_PREPARED: &str =
        "[2026-09-30 15:33:19] 30.09.2026 15:33:19.060000 INFO  [62004] VPNCORE start_listening: [0] Client has been successfully prepared to run";

    #[test]
    fn the_prepared_to_run_line_is_the_other_tun_listener_ready_marker() {
        // WR-03: the Connected gate must not hang on ONE exact wording. Either of the core's two
        // lines that follow a successful `listen` proves the adapter exists.
        assert!(is_tun_listener_ready_line(L_PREPARED));
        assert!(is_tun_listener_ready_line(&format!("{L_PREPARED}\r")));
        for other in [
            // the opener of the same function and the failure it logs instead
            "30.09.2026 15:33:19.000000 INFO  [62004] VPNCORE start_listening: [0] ...",
            "30.09.2026 15:33:19.000000 ERROR [62004] VPNCORE start_listening: [0] Client run failed: Failed to create listener (1)",
            // the words without the core's function tag are somebody else's line
            "some other component: Client has been successfully prepared to run",
            "VPNCORE vpn_fsm: [0] Client has been successfully prepared to run",
        ] {
            assert!(!is_tun_listener_ready_line(other), "must not match: {other:?}");
        }
    }

    #[test]
    fn a_reworded_listener_line_does_not_hold_connected_while_the_other_one_arrives() {
        // WR-03: a core update may reword or re-level one of the two lines. Whichever survives
        // opens the gate; both together still open it exactly once.
        let mut only_prepared = ConnectReadiness::default();
        assert!(!only_prepared.observe(L_ENDPOINT));
        assert!(only_prepared.observe(L_PREPARED));
        assert!(!only_prepared.observe(L_LISTEN_DONE), "the second listener line must not reopen it");

        let mut prepared_first = ConnectReadiness::default();
        assert!(!prepared_first.observe(L_PREPARED));
        assert!(prepared_first.observe(L_ENDPOINT));

        let mut only_done = ConnectReadiness::default();
        assert!(!only_done.observe(L_ENDPOINT));
        assert!(only_done.observe(L_LISTEN_DONE));

        // The recorded failure transcript contains neither listener line, so it still never opens.
        let mut failed = ConnectReadiness::default();
        for line in [
            L_LISTEN_OPEN,
            L_ENDPOINT,
            "30.09.2026 15:33:19.000000 INFO  [62004] VPNCORE start_listening: [0] ...",
            "make_tun_listener: Failed to initialize tunnel: Unable to create wintun adapter",
            "30.09.2026 15:33:19.000000 ERROR [62004] VPNCORE start_listening: [0] Client run failed: Failed to create listener (1)",
        ] {
            assert!(!failed.observe(line), "gate must stay closed on: {line}");
        }
    }

    #[test]
    fn readiness_endpoint_first_then_listener_opens_once() {
        let mut r = ConnectReadiness::default();
        assert!(!r.observe(L_ENDPOINT), "endpoint alone must not open the gate");
        assert!(r.observe(L_LISTEN_DONE), "the listener line completes the pair");
        // every later line, including repeats of both markers, stays closed
        assert!(!r.observe(L_ENDPOINT));
        assert!(!r.observe(L_LISTEN_DONE));
        assert!(!r.observe("some unrelated line"));
    }

    #[test]
    fn readiness_listener_first_then_endpoint_opens_once() {
        let mut r = ConnectReadiness::default();
        assert!(!r.observe(L_LISTEN_OPEN));
        assert!(!r.observe(L_LISTEN_DONE), "listener alone must not open the gate");
        assert!(r.observe(L_ENDPOINT), "the endpoint line completes the pair");
        assert!(!r.observe(L_ENDPOINT));
        assert!(!r.observe(L_LISTEN_DONE));
    }

    /// The recorded adapter-failure transcript: the endpoint is reached, the listener never is.
    #[test]
    fn readiness_endpoint_without_listener_never_opens() {
        let mut r = ConnectReadiness::default();
        for line in [
            L_LISTEN_OPEN,
            L_ENDPOINT,
            "OS_TUNNEL_WIN create_wintun_adapter: WintunCreateAdapter: The system cannot find the file specified",
            "make_tun_listener: Failed to initialize tunnel: Unable to create wintun adapter",
            "30.09.2026 15:33:34.000000 INFO  [62004] VPNCORE vpn_stop: [0] Done",
            "30.09.2026 15:33:34.000000 INFO  [62004] VPNCORE vpn_close: [0] Done",
            "run_client: Error at ag::TrustTunnelClient::vpn_runner:295: Failed to create listener",
            L_ENDPOINT,
        ] {
            assert!(!r.observe(line), "gate must stay closed on: {line}");
        }
    }

    #[test]
    fn readiness_default_is_closed_so_a_respawn_starts_fresh() {
        let mut first = ConnectReadiness::default();
        assert!(!first.observe(L_ENDPOINT));
        assert!(first.observe(L_LISTEN_DONE));
        // a new core process gets a new value: it needs its own pair of lines
        let mut second = ConnectReadiness::default();
        assert!(!second.observe(L_ENDPOINT));
        assert!(second.observe(L_LISTEN_DONE));
    }

    #[test]
    fn readiness_full_transcripts_open_exactly_once_on_the_completing_line() {
        // In the recorded success order the core logs «prepared to run» (a listener-ready line
        // too, WR-03) BEFORE the endpoint line, so the endpoint line completes the pair.
        let success_endpoint_first = [
            L_LISTEN_OPEN,
            "30.09.2026 15:33:19.060000 INFO  [62004] VPNCORE start_listening: [0] Client has been successfully prepared to run",
            L_ENDPOINT,
            L_LISTEN_DONE,
            "30.09.2026 15:33:19.200000 INFO  [62004] VPNCORE raise_state: [0] VPN_SS_CONNECTED",
        ];
        let success_listener_first = [
            L_LISTEN_OPEN,
            L_LISTEN_DONE,
            L_ENDPOINT,
            "30.09.2026 15:33:19.200000 INFO  [62004] VPNCORE raise_state: [0] VPN_SS_CONNECTED",
        ];
        for (transcript, completing) in [
            (&success_endpoint_first[..], 2usize),
            (&success_listener_first[..], 2usize),
        ] {
            let mut r = ConnectReadiness::default();
            let opened: Vec<usize> = transcript
                .iter()
                .enumerate()
                .filter_map(|(i, l)| r.observe(l).then_some(i))
                .collect();
            assert_eq!(opened, vec![completing]);
        }
    }

    // ── G-03.1-7: the adapter-creation failure is classified from the core's own tags ──

    #[test]
    fn adapter_creation_failure_is_recognised_whatever_language_windows_speaks() {
        for line in [
            "OS_TUNNEL_WIN create_wintun_adapter: WintunCreateAdapter: The system cannot find the file specified",
            // The strerror half is localized by Windows; the classifier must not depend on it.
            "OS_TUNNEL_WIN create_wintun_adapter: WintunCreateAdapter: Не удается найти указанный файл.",
            "TRUSTTUNNEL_CLIENT make_tun_listener: Failed to initialize tunnel: Unable to create wintun adapter",
        ] {
            assert!(adapter_creation_failed(line), "must match: {line}");
        }
    }

    #[test]
    fn adapter_creation_failure_ignores_lines_that_are_not_that_failure() {
        for line in [
            // The normal path logs this at debug level before creating the adapter.
            "OS_TUNNEL_WIN open_wintun_adapter: WintunOpenAdapter: The system cannot find the file specified",
            // A missing DLL is a different failure and is not retried.
            "OS_TUNNEL_WIN init: Unable to init wintun library",
            "run_client: Error at ag::TrustTunnelClient::vpn_runner:295: Failed to create listener",
            "some unrelated info line",
            "",
        ] {
            assert!(!adapter_creation_failed(line), "must not match: {line}");
        }
    }

    #[test]
    fn adapter_retry_log_lines_carry_numbers_only() {
        // D-29 / T-3.1-44: fixed phrases, no core text, no path, no secret.
        let line = adapter_retry_log_line(1, 2);
        assert!(line.contains('1') && line.contains('2'), "attempt and maximum are named: {line}");
        for forbidden in ["WintunCreateAdapter", "cannot find", "\\", "/"] {
            assert!(!line.contains(forbidden), "log line must not contain {forbidden:?}: {line}");
        }
    }

    // ── G-03.1-7 wiring guards (review WR-02) ──
    //
    // The reader task needs a live AppHandle, so its wiring cannot be called from a unit test. These
    // guards read the PRODUCTION source instead, the same technique `commands::vpn`'s D-02 scans
    // use: each needle is one the wiring cannot lose without the retry silently never running.
    // The scanned text is everything before the test module with whole-line `//` comments dropped,
    // so neither this module's own literals nor the prose explaining the wiring can satisfy a guard.

    fn production_source() -> String {
        let src = include_str!("./sidecar.rs");
        let production = src.split("\n#[cfg(test)]").next().unwrap_or(src);
        production
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The text between the ONLY occurrence of `start` and the next `end` after it. A missing or
    /// duplicated `start` is a failure of the guard, never a pass.
    fn span_between(source: &str, start: &str, end: &str) -> String {
        let hits = source.matches(start).count();
        assert_eq!(
            hits, 1,
            "cannot measure: {hits} matches for `{start}`, expected exactly 1 — renamed, removed \
             or duplicated. This is a FAILURE, not a pass.",
        );
        let after = source.split(start).nth(1).unwrap_or("");
        let stop = after.find(end).unwrap_or_else(|| {
            panic!("cannot measure: no `{end}` after `{start}` — the code was restructured")
        });
        after[..stop].to_string()
    }

    // G-03.1-10: the stop request itself is proven on a real windowless console process in
    // `console_ctrl::tests`. These guards pin the wiring those tests cannot reach: every place that
    // stops the core asks it through Ctrl+C first, and every spawn lets the core receive it.

    #[test]
    fn g10_disconnect_stops_the_core_through_ctrl_c_before_any_hard_kill() {
        let src = production_source();
        let body = span_between(&src, "pub async fn kill_sidecar(", "\n}\n");
        let graceful = body.find("request_graceful_stop(pid)").expect("kill_sidecar lost the graceful stop");
        let hard = body.find(".child.kill()").expect("kill_sidecar lost the hard-kill fallback");
        assert!(graceful < hard, "the graceful stop must come before the hard kill");
        assert!(
            !body.contains("[\"/PID\""),
            "the old stop request (`taskkill /PID` without /F) never reaches the windowless core",
        );
        let request = span_between(&src, "fn request_graceful_stop(", "\n}\n");
        assert!(request.contains("console_ctrl::send_ctrl_c(pid)"));
    }

    #[test]
    fn g10_app_exit_stops_the_core_through_ctrl_c_before_any_hard_kill() {
        let src = production_source();
        let body = span_between(&src, "pub fn stop_sidecar_on_exit(", "\n}\n");
        let graceful = body.find("request_graceful_stop(pid)").expect("exit lost the graceful stop");
        let hard = body.find(".child.kill()").expect("exit lost the hard-kill fallback");
        assert!(graceful < hard);
        assert!(!body.contains("*d = true"), "the exit stop must not latch the shared intent flag (WR-05)");

        let vpn = include_str!("./commands/vpn.rs");
        let exit_body = vpn
            .split("pub fn kill_sidecar_from_state(")
            .nth(1)
            .and_then(|rest| rest.split("\n}").next())
            .expect("kill_sidecar_from_state moved");
        assert!(exit_body.contains("sidecar::stop_sidecar_on_exit(child)"));
        assert!(!exit_body.contains(".child.kill()"), "the exit path must not hard-kill first");
    }

    #[test]
    fn g10_main_hands_over_to_the_ctrl_c_helper_before_anything_else() {
        // The release helper is trusttunnel.exe itself: main() must hand over before the data
        // root, WebView2 or Tauri start (a normal launch gets None — console_ctrl's own test).
        let main = include_str!("./main.rs");
        let helper = main
            .find("trusttunnel_lib::ctrl_c_helper_exit_code()")
            .expect("main lost the helper dispatch");
        let early = main.find("trusttunnel_lib::init_data_root_early()").expect("init moved");
        let run = main.find("trusttunnel_lib::run()").expect("run moved");
        assert!(helper < early && helper < run);
        let request = span_between(&production_source(), "fn request_graceful_stop(", "\n}\n");
        assert!(request.contains("console_ctrl::send_ctrl_c(pid)"));
    }

    #[test]
    fn g10_no_core_starts_while_an_earlier_one_is_still_stopping() {
        // Deep review #1: the core reuses its adapter by name, so a core started during another
        // core's graceful cleanup would lose the adapter that cleanup removes.
        let src = production_source();
        let spawn = span_between(&src, "pub async fn spawn_trusttunnel(", "\n}\n");
        let wait = spawn
            .find("wait_for_core_stops_in_flight().await")
            .expect("spawn lost the wait for stops in progress");
        let create = spawn.find(".sidecar(\"trusttunnel_client\")").expect("spawn call moved");
        assert!(wait < create);
        for stop in ["pub async fn kill_sidecar(", "pub fn stop_sidecar_on_exit("] {
            let body = span_between(&src, stop, "\n}\n");
            let begin = body.find("CoreStopInFlight::begin()").expect("a stop is not counted");
            let graceful = body.find("request_graceful_stop(pid)").expect("graceful stop moved");
            assert!(begin < graceful, "{stop} must count itself before it asks the core to stop");
        }
        let load = || CORE_STOPS_IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst);
        let before = load();
        {
            let _stop = CoreStopInFlight::begin();
            assert_eq!(load(), before + 1);
        }
        assert_eq!(load(), before, "every return path of a stop must release the count");
    }

    #[test]
    fn g10_every_spawn_lets_the_core_receive_ctrl_c() {
        let src = production_source();
        let body = span_between(&src, "pub async fn spawn_trusttunnel(", "\n}\n");
        let prepare = body.find("console_ctrl::prepare_spawn()").expect("spawn lost prepare_spawn");
        let spawn = body.find(".sidecar(\"trusttunnel_client\")").expect("spawn call moved");
        assert!(prepare < spawn, "the Ctrl+C flag must be cleared before the core is created");
    }

    #[test]
    fn a_supervised_adapter_failure_records_its_cause_for_the_supervisor_loop() {
        // WR-01: under a live supervisor the Terminated arm defers, but it must still say WHY the
        // respawned core died — the loop reads that cause from `last_error` to bound its adapter
        // retries and to keep the diagnosis for the final Error.
        let source = production_source();
        let live_branch = span_between(
            &source,
            "if supervisor_live {",
            "} else if crate::lifecycle::should_reconnect(",
        );
        assert!(
            live_branch.contains("adapter_failure_seen"),
            "the supervisor_live branch must look at this core's adapter latch",
        );
        assert!(
            live_branch.contains("record_failure_cause("),
            "the supervisor_live branch must record the cause without claiming a status",
        );
        assert!(
            live_branch.contains("ADAPTER_CREATION_FAILED_REASON"),
            "the recorded cause is the adapter reason the frontend maps",
        );
        assert!(
            !live_branch.contains("set_vpn_status("),
            "the deferring branch must stay a NON-writer of status (D-01, CR-02)",
        );
    }

    #[test]
    fn the_adapter_latch_is_set_before_the_fatal_markers_are_read_on_both_streams() {
        // WR-02: if `note_adapter_failure` is removed from an arm, or moves below
        // `handle_fatal_markers`, the latch is still false when the trailing «Failed to create
        // listener» arrives. That line then writes `Error("Failed to start VPN tunnel")` at once,
        // `already_error` is true in the Terminated arm, and the retry silently never runs — with
        // every pure-function test still green.
        let source = production_source();
        let stdout_arm = span_between(
            &source,
            "CommandEvent::Stdout(line) => {",
            "CommandEvent::Stderr(line) => {",
        );
        let stderr_arm = span_between(
            &source,
            "CommandEvent::Stderr(line) => {",
            "CommandEvent::Terminated(payload) => {",
        );
        for (name, arm) in [("Stdout", &stdout_arm), ("Stderr", &stderr_arm)] {
            let note = arm.find("note_adapter_failure(").unwrap_or_else(|| {
                panic!("the {name} arm no longer latches the adapter failure")
            });
            let fatal = arm.find("handle_fatal_markers(").unwrap_or_else(|| {
                panic!("the {name} arm no longer reads the fatal markers")
            });
            assert!(
                note < fatal,
                "in the {name} arm the adapter latch must be set BEFORE the fatal markers are read",
            );
            assert!(
                arm[fatal..].contains("adapter_failure_seen"),
                "the {name} arm must hand the latch to `handle_fatal_markers`",
            );
        }
    }

    #[test]
    fn a_seen_adapter_failure_makes_the_fatal_marker_reader_return_before_any_write() {
        // WR-02: the early `return` needs an AppHandle for everything after it, so it is guarded by
        // reading the source: it must be the FIRST decision, ahead of the marker lookup and of every
        // status write.
        let source = production_source();
        let body = span_between(&source, "\nfn handle_fatal_markers(", "\n}\n");
        let early = body
            .find("if adapter_failure_seen {")
            .expect("handle_fatal_markers lost its adapter early return");
        let lookup = body.find("fatal_marker_error(trimmed)").expect("marker lookup moved");
        let write = body.find("set_vpn_status(").expect("status write moved");
        assert!(early < lookup && early < write, "the early return must precede lookup and write");
        assert!(
            body[early..lookup].contains("return;"),
            "the adapter branch must return, not merely log",
        );
    }

    #[test]
    fn the_terminated_arm_records_the_budget_before_scheduling_and_never_falls_through() {
        // WR-02: the ledger write before `start_adapter_retry`, the `continue` that skips the
        // generic classification, and the exhausted branch's single Error are all in a task that
        // owns a live AppHandle. Order and shape are pinned here.
        let source = production_source();
        let arm = span_between(
            &source,
            "CommandEvent::Terminated(payload) => {",
            // The reader task's closing brace (column 4): every line inside the arm is indented
            // deeper, so this is the end of the task and cannot match earlier.
            "\n    });",
        );
        let decision = arm
            .find("adapter_arm_outcome(")
            .expect("the arm no longer asks the pure adapter decision");
        let classification = arm
            .find("never_connected_exit_reason(")
            .expect("the never-connected classification moved");
        assert!(
            decision < classification,
            "the adapter decision must run BEFORE the generic never-connected classification",
        );

        let retry_branch = span_between(
            &arm,
            "AdapterFailureOutcome::Retry { attempt }",
            "AdapterFailureOutcome::Exhausted",
        );
        let ledger = retry_branch
            .find("adapter_retry_ledger")
            .expect("the retry branch no longer records the attempt");
        let schedule = retry_branch
            .find("start_adapter_retry(")
            .expect("the retry branch no longer schedules the restart");
        assert!(ledger < schedule, "the budget must be written BEFORE the retry is scheduled");
        assert!(
            retry_branch[schedule..].contains("continue;"),
            "after scheduling, the arm must skip the generic Error classification",
        );
        assert!(
            retry_branch[schedule..].contains("my_config_name"),
            "the retry must be handed THIS session's config name for its own Error stamps (IN-02)",
        );
        assert!(
            !retry_branch.contains("set_vpn_status("),
            "a scheduled retry writes NO status — «Подключение...» must hold",
        );

        let exhausted_branch = span_between(
            &arm,
            "AdapterFailureOutcome::Exhausted, Some(state)",
            "_ => {}",
        );
        assert_eq!(
            exhausted_branch.matches("set_vpn_status(").count(),
            1,
            "the exhausted branch writes exactly one Error",
        );
        assert!(exhausted_branch.contains("ADAPTER_CREATION_FAILED_REASON"));
        assert!(
            exhausted_branch.contains("pending_error_config_name"),
            "the exhausted Error names the config that failed",
        );
        assert!(exhausted_branch.contains("continue;"));
    }

    // ── T-32 noisy-line collapse ──

    /// The confirmed flood shape (thousands per second on tunnel death) must be
    /// classified as noise regardless of the varying id.
    #[test]
    fn noisy_key_matches_dns_proxy_flood_lines() {
        let l1 = "11.06.2026 20:51:58.349505 INFO  [46044] DNS_HANDLER client_handler: System DNS proxy request id=41953 failed";
        let l2 = "11.06.2026 20:51:58.349509 INFO  [46044] DNS_HANDLER client_handler: System DNS proxy request id=99999 failed";
        assert_eq!(noisy_line_key(l1), noisy_line_key(l2));
        assert!(noisy_line_key(l1).is_some());
    }

    /// Narrowness guard: normal lines — including OTHER DNS_HANDLER lines and the
    /// connect markers — must never be collapsed (hiding novel info is worse than
    /// some noise).
    #[test]
    fn noisy_key_ignores_normal_lines() {
        for line in [
            "DNS_HANDLER start_system_dns_proxy: System DNS proxy listening on 127.0.0.1:56606/TCP",
            "TRUSTTUNNEL_CLIENT_APP operator (): Successfully connected to endpoint",
            "VPNCORE raise_state: [0] VPN_SS_CONNECTED",
            "DNS proxy init: Initializing proxy module...",
        ] {
            assert_eq!(noisy_line_key(line), None, "line must not be collapsed: {line}");
        }
    }

    #[test]
    fn fatal_markers_map_to_derived_messages() {
        // Each of the 4 fatal markers the frontend currently parses must now have
        // an authoritative backend error message (RESEARCH A3).
        assert_eq!(fatal_marker_error("ERROR: Authorization Required"), Some("Authorization failed"));
        // G-03.1-7: the adapter failure is no longer an immediate fatal marker — the app decides on
        // a retry (see `adapter_creation_failed`) and only reports the error when it is exhausted.
        assert_eq!(fatal_marker_error("WintunCreateAdapter failed: cannot find device"), None);
        assert_eq!(
            fatal_marker_error(
                "OS_TUNNEL_WIN create_wintun_adapter: WintunCreateAdapter: The system cannot find the file specified"
            ),
            None
        );
        assert_eq!(fatal_marker_error("Failed to create listener on tun0"), Some("Failed to start VPN tunnel"));
        assert_eq!(fatal_marker_error("tcp connect: Connection refused"), Some("Server refused the connection"));
        assert_eq!(fatal_marker_error("some unrelated info line"), None);
    }

    #[test]
    fn core_exit_reason_maps_only_known_codes_and_never_echoes_text() {
        // D-04: the core's own `Error: <code> <text>` line (errlog, trusttunnel_client.cpp)
        // is parsed into a FIXED reason code — never the code, never the text.
        assert_eq!(
            core_exit_error_reason("2026-09-25 12:00:00.000 ERROR [main] Error: 6 Location unavailable"),
            Some(crate::lifecycle::CORE_SERVER_UNREACHABLE_REASON)
        );
        // D-29/D-10: the returned code carries none of the line's text — even a
        // password embedded in the core's own text must never survive the parse.
        let line_with_secret = "... Error: 9 some text with password=hunter2";
        let reason = core_exit_error_reason(line_with_secret).expect("code 9 should map");
        assert_eq!(reason, crate::lifecycle::CORE_SERVER_UNREACHABLE_REASON);
        assert!(!reason.contains("hunter2"));
        assert!(!reason.contains("password"));

        assert_eq!(core_exit_error_reason("Error: 5 auth failed"), Some(crate::lifecycle::CORE_AUTH_FAILED_REASON));
        assert_eq!(
            core_exit_error_reason("Error: 7 cert verification failed"),
            Some(crate::lifecycle::CORE_CERTIFICATE_FAILED_REASON)
        );
        assert_eq!(
            core_exit_error_reason("Error: 2 invalid settings"),
            Some(crate::lifecycle::CORE_INVALID_SETTINGS_REASON)
        );
        assert_eq!(
            core_exit_error_reason("Error: 3 address in use"),
            Some(crate::lifecycle::CORE_ADDRESS_IN_USE_REASON)
        );
        assert_eq!(
            core_exit_error_reason("Error: 10 fatal connectivity"),
            Some(crate::lifecycle::CORE_FATAL_CONNECTIVITY_REASON)
        );

        // Unmapped / generic codes fall back to None (classifier then uses sidecar-exit).
        for code in [0, 1, 4, 8] {
            assert_eq!(core_exit_error_reason(&format!("Error: {code} generic")), None, "code {code} must not map");
        }
        // A longer digit run than any known code — must not truncate-match "10".
        assert_eq!(core_exit_error_reason("Error: 10054 winsock error"), None);
        // The recovery line uses a DIFFERENT shape (no "Error: " prefix) and must not match.
        assert_eq!(core_exit_error_reason("Waiting recovery: to next=5000ms error=6 x"), None);
        // Deep review of AUD-08, L-1: the marker must start a word. A Win32 diagnostic such
        // as `GetLastError: 5 (Access is denied.)` ends in the same seven bytes, and 5 there
        // is ERROR_ACCESS_DENIED, not the core's auth failure.
        assert_eq!(
            core_exit_error_reason("WaitForMultipleObjects: 0x102, GetLastError: 5 (Access is denied.)"),
            None
        );
        // ...while a later, genuine marker on the same line is still found.
        assert_eq!(
            core_exit_error_reason("GetLastError: 5 (x); Error: 7 cert"),
            Some(crate::lifecycle::CORE_CERTIFICATE_FAILED_REASON)
        );
        // The marker at the very start of the line is a word start.
        assert_eq!(core_exit_error_reason("Error: 5"), Some(crate::lifecycle::CORE_AUTH_FAILED_REASON));
        // Non-numeric / missing marker.
        assert_eq!(core_exit_error_reason("Error: abc"), None);
        assert_eq!(core_exit_error_reason("no marker on this line at all"), None);
    }

    #[test]
    fn core_exit_reason_rejects_zero_padded_two_digit_code() {
        // IN-01 (03-REVIEW.md): the core's own errlog never zero-pads its integer code, so
        // "Error: 07" never occurs in practice — but before this guard the digit-run parser
        // would parse `"07"` as `7` via `after[..len].parse::<u8>()` and accept it as
        // CORE_CERTIFICATE_FAILED_REASON, which is wider than the function's own doc comment
        // promises ("a FIXED set of ... exact textual codes"). A zero-padded code is not one
        // of those exact strings and must be rejected.
        assert_eq!(core_exit_error_reason("Error: 07 cert verification failed"), None);
        assert_eq!(core_exit_error_reason("Error: 05 auth failed"), None);
        // "0" alone (not zero-padded, not a known code) still falls through to None via the
        // match's `_` arm, unaffected by this guard.
        assert_eq!(core_exit_error_reason("Error: 0 generic"), None);
    }

    #[test]
    fn auth_marker_error_carries_no_secret() {
        // D-29 / D-10 — the error string emitted for a fatal marker must be a fixed
        // DERIVED phrase, never the raw log line. Even if the offending sidecar line
        // embedded a credential, the message we surface must not contain it.
        let sample_password = "S3cr3tP@ssw0rd";
        let raw_line = format!("ERROR: Authorization Required (password={sample_password})");
        let derived = fatal_marker_error(&raw_line).expect("auth marker should match");
        // The derived message must not leak the password, nor any unusual char from it.
        assert!(!derived.contains(sample_password));
        for ch in sample_password.chars().filter(|c| !c.is_ascii_alphabetic() || c.is_ascii_uppercase()) {
            assert!(!derived.contains(ch), "derived message leaked char {ch:?} from the secret");
        }
        // And it must not be the raw line.
        assert_ne!(derived, raw_line.as_str());
    }

    // ─── Phase 2 Plan 05 (D-08/D-09/D-11): lifecycle marker secret-safety ───
    //
    // Every NEW lifecycle marker is a FIXED/derived phrase routed through
    // logging::sanitize() (or built only from compile-time text + a non-secret
    // PID) so a credential or raw config text can NEVER reach the vpn-log channel
    // (D-29 / CR-01 / Pitfall 6). These spy-tests construct each marker from a
    // credential-shaped / config-path input and assert the secret never appears —
    // the same precedent as auth_marker_error_carries_no_secret above.

    /// A password-shaped sample reused across the marker spy-tests.
    const SAMPLE_SECRET: &str = "S3cr3tP@ssw0rd";

    /// Assert a marker string carries none of the secret (nor its unusual chars).
    fn assert_no_secret(marker: &str, secret: &str) {
        assert!(!marker.contains(secret), "marker leaked the secret: {marker:?}");
        for ch in secret
            .chars()
            .filter(|c| !c.is_ascii_alphabetic() || c.is_ascii_uppercase())
        {
            assert!(
                !marker.contains(ch),
                "marker {marker:?} leaked char {ch:?} from the secret"
            );
        }
    }

    #[test]
    fn connect_start_marker_carries_no_secret() {
        // The connect-start marker is a FIXED phrase — it must not embed the
        // config path contents or any credential, even if those were in scope.
        let marker = connect_start_marker();
        assert_no_secret(marker, SAMPLE_SECRET);
        // Sanitizing a fixed ASCII phrase is a no-op (idempotent) — proves it
        // carries nothing the sanitizer would have to redact.
        assert_eq!(crate::logging::sanitize(marker), marker);
        // NIT-5 (16-12): strengthen the trivial `!is_empty()` into a meaningful
        // assertion on the actual marker content — the [vpn] prefix + the fixed
        // phrase — so a future edit that empties or mangles the marker is caught.
        assert_eq!(marker, "[vpn] connect start");
    }

    #[test]
    fn spawn_marker_logs_pid_not_config() {
        // The spawn marker includes the numeric PID (non-secret — A2) but NEVER
        // the config path contents or a TOML field value. Build it with a PID and
        // assert a config-path-shaped secret can't appear.
        let marker = spawn_pid_marker(4242);
        assert!(marker.contains("4242"), "PID must be present (non-secret)");
        // A config path / credential never reaches the marker — it is built only
        // from the constant phrase + the PID.
        let leaky_path = format!("C:/configs/{SAMPLE_SECRET}/wg.conf");
        assert_no_secret(&marker, SAMPLE_SECRET);
        assert!(!marker.contains(&leaky_path));
        // Sanitize is a no-op on the fixed-phrase + PID marker.
        assert_eq!(crate::logging::sanitize(&marker), marker);
    }

    #[test]
    fn handshake_marker_is_fixed_phrase() {
        let marker = handshake_marker();
        assert_no_secret(marker, SAMPLE_SECRET);
        assert_eq!(crate::logging::sanitize(marker), marker);
        // NIT-5 (16-12): assert the actual phrase, not just non-empty.
        assert_eq!(marker, "[vpn] handshake complete - connection up");
    }

    #[test]
    fn drop_detected_marker_is_fixed_phrase() {
        let marker = drop_detected_marker();
        assert_no_secret(marker, SAMPLE_SECRET);
        assert_eq!(crate::logging::sanitize(marker), marker);
        // NIT-5 (16-12): assert the actual phrase, not just non-empty.
        assert_eq!(marker, "[vpn] connection drop detected");
    }

    #[test]
    fn killed_on_exit_marker_is_fixed_phrase() {
        // The killed-on-exit marker is a fixed phrase with no interpolated secret.
        let marker = killed_on_exit_marker();
        assert_no_secret(marker, SAMPLE_SECRET);
        assert_eq!(crate::logging::sanitize(marker), marker);
        // NIT-5 (16-12): assert the actual phrase, not just non-empty.
        assert_eq!(marker, "[vpn] sidecar killed on exit");
    }

    #[test]
    fn lifecycle_markers_routed_through_sanitize() {
        // D-29 / CR-01: every new lifecycle marker is either a compile-time
        // constant phrase or built from constants + a non-secret PID, so passing
        // it through logging::sanitize() changes nothing (there is nothing to
        // redact). If a future edit interpolated a credential / config path /
        // bare IP into a marker, sanitize() would alter it and this test would
        // fail — locking the "no secret can reach the channel" invariant.
        // PID 1245 shares no digit with SAMPLE_SECRET (S3cr3tP@ssw0rd → 3, 0) so
        // the char-level secret check below is a true negative, not a digit clash.
        let markers = [
            connect_start_marker().to_string(),
            spawn_pid_marker(1245),
            handshake_marker().to_string(),
            drop_detected_marker().to_string(),
            killed_on_exit_marker().to_string(),
        ];
        for m in markers {
            assert_eq!(
                crate::logging::sanitize(&m),
                m,
                "marker {m:?} contained something the sanitizer redacted — possible secret/IP leak"
            );
            assert_no_secret(&m, SAMPLE_SECRET);
        }
    }

    #[test]
    fn config_parse_error_carries_no_secret() {
        // D-29 / D-10 (Codex HIGH) — the config-parse error path USED to forward a
        // sliced RAW backend message. A malformed config TOML can embed a credential
        // (the sidecar echoes the offending text), so the surfaced message must be a
        // fixed DERIVED phrase that never reproduces the raw line or its secret.
        let sample_password = "S3cr3tP@ssw0rd";
        let raw_line = format!(
            "ERROR: Failed parsing configuration: invalid value for key auth = \"{sample_password}\""
        );
        let derived = config_parse_error(&raw_line).expect("config-parse marker should match");
        // Must not leak the password, nor any unusual char from it.
        assert!(!derived.contains(sample_password));
        for ch in sample_password.chars().filter(|c| !c.is_ascii_alphabetic() || c.is_ascii_uppercase()) {
            assert!(!derived.contains(ch), "derived message leaked char {ch:?} from the secret");
        }
        // And it must not echo the raw line.
        assert_ne!(derived, raw_line.as_str());
        // A non-matching line returns None (mutually exclusive with fatal markers).
        assert_eq!(config_parse_error("some unrelated info line"), None);
    }

    // ── T-22 B2: honest kill_sidecar — Err when BOTH hard paths fail ─────────
    #[test]
    fn kill_succeeds_when_either_hard_path_works() {
        // The process is dead if EITHER the in-process TerminateProcess OR the
        // out-of-band `taskkill /F` reported success — so kill_sidecar must report
        // success (Ok) in all three of those cases.
        assert!(kill_succeeded(true, true), "both hard kills succeeded ⇒ success");
        assert!(kill_succeeded(true, false), "in-process kill succeeded ⇒ success");
        assert!(kill_succeeded(false, true), "taskkill /F succeeded ⇒ success");
    }

    #[test]
    fn hard_kill_confirmed_only_when_process_is_gone() {
        // 3.2 R-KILL (F13): after the bounded liveness poll, the teardown is confirmed ONLY when the
        // process is provably gone — child.kill()/taskkill merely INITIATE termination, so a
        // "reported success" is not proof and disconnect must not complete while the .exe lingers.
        assert!(hard_kill_confirmed(false), "process gone after poll ⇒ confirmed teardown");
        assert!(!hard_kill_confirmed(true), "still alive after poll ⇒ NOT confirmed (F13 race)");
    }

    // ── 3.8 F-3: traffic-readiness budget stays under the connect-timeout watchdog ──

    #[test]
    fn traffic_readiness_budget_stays_under_watchdog() {
        use std::time::Duration;
        // Early handshake (the common case): the full cap fits under the watchdog, so the budget
        // is the cap unchanged — http3 warmup still gets its ~45s.
        assert_eq!(traffic_readiness_budget(Duration::ZERO), TRAFFIC_READINESS_CAP);
        assert_eq!(
            traffic_readiness_budget(Duration::from_secs(3)),
            TRAFFIC_READINESS_CAP,
            "a 3s handshake still leaves room for the full cap (60-3-5=52 > 45)"
        );
        // Late handshake: the budget SHRINKS so the fallback emit still precedes the 60s deadline.
        assert_eq!(
            traffic_readiness_budget(Duration::from_secs(20)),
            Duration::from_secs(35),
            "handshake at T+20 ⇒ 60-20-5 = 35s budget (< cap), fallback lands at T+55 < T+60"
        );
        // The core invariant (this is what F-3 fixes): for ANY handshake time, the fallback emit
        // (handshake + budget) always lands at least the margin before the watchdog deadline.
        for e_secs in [0u64, 1, 5, 10, 15, 20, 30, 45, 55, 60, 90] {
            let e = Duration::from_secs(e_secs);
            let emit_at = e + traffic_readiness_budget(e);
            assert!(
                emit_at + TRAFFIC_READINESS_WATCHDOG_MARGIN <= crate::lifecycle::CONNECT_TIMEOUT
                    || traffic_readiness_budget(e) == Duration::ZERO,
                "handshake at {e_secs}s: emit_at {emit_at:?} must precede watchdog by the margin"
            );
        }
    }

    // ── AUDIT-2026-06-11 #1: DNS-probe staleness gate ────────────────────────

    #[test]
    fn probe_emit_allowed_only_for_live_in_progress_session() {
        // Happy path: nothing changed during the ≤10s probe window — same
        // generation, no cancel, status still Connecting (first connect) or
        // Reconnecting (supervisor respawn). The probe may emit Connected.
        assert!(probe_task_may_emit(false, false, 7, 7, VpnStatus::Connecting));
        assert!(probe_task_may_emit(false, false, 7, 7, VpnStatus::Reconnecting));
    }

    #[test]
    fn probe_emit_suppressed_on_any_staleness_signal() {
        // Cancel IN FLIGHT (transient flag): the user pressed «Отмена» while the
        // probe was still running.
        assert!(!probe_task_may_emit(true, false, 7, 7, VpnStatus::Connecting));
        // COMPLETED cancel: the transient flag was reset at the end of
        // vpn_disconnect (WR-01), but the durable T-31 intent persists until the
        // next connect — the audit #1 primary scenario (probe resolves via the
        // restored system DNS and would flip Disconnected back to Connected).
        assert!(!probe_task_may_emit(false, true, 7, 7, VpnStatus::Disconnected));
        // A newer connect/disconnect advanced the generation — stale actor.
        assert!(!probe_task_may_emit(false, false, 7, 8, VpnStatus::Connecting));
        // Terminal Error (connect-timeout) does NOT bump the generation — the
        // in-progress status check is what protects it (audit #1 scenario B:
        // handshake at ~T+55s, watchdog kills at T+60s, probe fires at ~T+62s).
        assert!(!probe_task_may_emit(false, false, 7, 7, VpnStatus::Error));
        // Disconnected with no flags set must still suppress — only an
        // in-progress connect state may be promoted to Connected.
        assert!(!probe_task_may_emit(false, false, 7, 7, VpnStatus::Disconnected));
        // Recovering / already-Connected are owned by the monitor; not ours.
        assert!(!probe_task_may_emit(false, false, 7, 7, VpnStatus::Recovering));
        assert!(!probe_task_may_emit(false, false, 7, 7, VpnStatus::Connected));
    }

    // ── AUDIT-2026-06-11 #4: Terminated-arm identity gate ───────────────────

    #[test]
    fn terminated_arm_acts_on_own_or_empty_slot() {
        // Slot still holds OUR child (unexpected crash / sidecar self-exit) → the
        // arm must act: clear the slot, classify the exit, write the status.
        assert!(terminated_arm_owns_state(1111, Some(1111)));
        // Slot already EMPTY: vpn_disconnect / respawn_sidecar took the child out
        // before killing it — the legitimate intentional-disconnect and
        // error-preservation paths must keep running.
        assert!(terminated_arm_owns_state(1111, None));
    }

    #[test]
    fn terminated_arm_skips_when_a_newer_child_is_stored() {
        // A LATE Terminated from an OLD child while the slot holds the NEW
        // session's child: clearing the slot would drop the new child's
        // KILL_ON_JOB_CLOSE handle (OS kills the fresh sidecar) and the trailing
        // status write would clobber the new session — must NOT act.
        assert!(!terminated_arm_owns_state(1111, Some(2222)));
    }

    #[test]
    fn pid_file_removed_only_when_it_records_our_pid() {
        // save_sidecar_pid writes bare digits; tolerate surrounding whitespace.
        assert!(pid_file_records_pid("1111", 1111));
        assert!(pid_file_records_pid(" 1111\r\n", 1111));
        // The respawn already saved the NEW child's pid → the old child's late
        // Terminated must keep its hands off the file.
        assert!(!pid_file_records_pid("2222", 1111));
        // Unreadable / corrupt contents ⇒ identity unproven ⇒ do not delete.
        assert!(!pid_file_records_pid("", 1111));
        assert!(!pid_file_records_pid("not-a-pid", 1111));
    }

    #[test]
    fn kill_fails_only_when_both_hard_paths_fail() {
        // T-22 B2 / deferred IN-02: the ONLY failure case is BOTH hard paths failing —
        // there the sidecar may still be alive holding the fail-closed killswitch, so
        // kill_sidecar must report FAILURE (the old code swallowed this as Ok(())). The
        // graceful attempt's outcome does NOT enter this decision: it is purely about
        // whether the guaranteed hard fallback actually killed the process.
        assert!(
            !kill_succeeded(false, false),
            "both hard kill AND taskkill failed ⇒ kill_sidecar must surface an error (no silent Ok)",
        );
    }
}
