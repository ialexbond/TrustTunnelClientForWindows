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
fn fatal_marker_error(line: &str) -> Option<&'static str> {
    if line.contains("Authorization Required") {
        Some("Authorization failed")
    } else if line.contains("WintunCreateAdapter") && line.contains("cannot find") {
        Some("VPN adapter creation failed")
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

fn handle_fatal_markers(trimmed: &str, app: &tauri::AppHandle) {
    if let Some(derived) = fatal_marker_error(trimmed) {
        if let Some(state) = app.try_state::<AppState>() {
            set_vpn_status(app, &state, VpnStatus::Error, Some(derived.to_string()));
        }
    } else if let Some(derived) = config_parse_error(trimmed) {
        // Fixed DERIVED phrase — NEVER the raw `&trimmed[pos..]` slice, which could
        // carry a credential out of a malformed config (D-29 / Codex HIGH).
        if let Some(state) = app.try_state::<AppState>() {
            set_vpn_status(app, &state, VpnStatus::Error, Some(derived.to_string()));
        }
    }
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
) -> Result<SidecarChild, Box<dyn std::error::Error>> {
    let shell = app.shell();

    eprintln!("[sidecar] Spawning trusttunnel_client with args: -c {config_path} -l {log_level}");
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
    tokio::spawn(async move {
        let mut handshake_done = false;
        let mut dns_proxy_ready = false;
        // Latch: this sidecar emits Connected EXACTLY ONCE per process lifetime. Without
        // it, `check_sidecar_markers` re-asserted Connected on the NEXT stdout line after
        // the connectivity monitor had moved the status to Recovering/Reconnecting on a
        // drop. A still-alive sidecar (e.g. the physical adapter was disabled but the
        // process is not dead yet) keeps logging; each line saw status != Connected and
        // re-emitted Connected, overwriting «Восстановление» back to «Подключено» — the
        // stuck-green bug from UAT build 65692c test 4 (status said Connected while the
        // network was gone). The monitor/supervisor own every status transition after the
        // first connect; a respawned sidecar gets its own fresh task with a fresh latch
        // and emits Connected for the new session.
        let mut connected_emitted = false;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim();
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

                    check_sidecar_markers(
                        trimmed, &app_handle, &disc_for_task,
                        &mut handshake_done, &mut dns_proxy_ready,
                        &mut connected_emitted, &spawn_time,
                    ).await;

                    // CR-01: a fatal marker can arrive on stdout too — run the
                    // authoritative Error detection here as well, not only on stderr.
                    handle_fatal_markers(trimmed, &app_handle);
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
                        &mut handshake_done, &mut dns_proxy_ready,
                        &mut connected_emitted, &spawn_time,
                    ).await;

                    // Authoritative backend Error for the fatal markers the frontend
                    // used to guess from log text (RESEARCH A3). Same helper as the
                    // Stdout arm (CR-01) — one place, both streams, single early
                    // return so a line can never double-emit (WR-02).
                    handle_fatal_markers(trimmed, &app_handle);
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
                    let pid_path = crate::ssh::portable_data_dir()
                        .join(crate::lifecycle::SIDECAR_PID_BASENAME);
                    let _ = std::fs::remove_file(&pid_path);

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

                    // Clear the sidecar child so VPN can be reconnected
                    if let Ok(mut guard) = child_state.lock() {
                        *guard = None;
                        eprintln!("[sidecar] Cleared sidecar_child state");
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
                                    crate::connectivity::start_reconnect_supervisor(
                                        app_handle.clone(),
                                        config_path,
                                        log_level,
                                        generation,
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
                        // Intentional disconnect / clean exit → Disconnected; a
                        // never-connected non-zero exit → honest Error carrying a STABLE,
                        // secret-free ASCII REASON CODE.
                        //
                        // 02-09 (UAT Gap #2, T-09-01): the old branch surfaced
                        // `format!("Process exited with code {exit_code}")` — a raw
                        // passthrough that (a) showed the user a meaningless number and
                        // (b) is exactly the kind of untrusted sidecar text D-09/D-29
                        // forbid on the UI/log channel. We now emit ONE of two fixed
                        // tokens the frontend localizes (CLAUDE.md i18n rule):
                        //   - `NO_INTERNET_REASON` when the per-attempt pre-flight saw the
                        //     network as offline (most likely "no internet"),
                        //   - `SIDECAR_EXIT_REASON` otherwise (generic VPN-core failure).
                        // This SAME branch already covers an AV-kill / manual Task-Manager
                        // kill of the sidecar during connect (the same never-connected
                        // non-zero exit), so no separate path is needed.
                        let (status, error_msg): (VpnStatus, Option<String>) =
                            if was_intentional || exit_code == 0 {
                                (VpnStatus::Disconnected, None)
                            } else {
                                use std::sync::atomic::Ordering;
                                let preflight_offline = state_opt
                                    .as_ref()
                                    .map(|s| s.last_preflight_offline.load(Ordering::SeqCst))
                                    .unwrap_or(false);
                                let reason = if preflight_offline {
                                    crate::lifecycle::NO_INTERNET_REASON
                                } else {
                                    crate::lifecycle::SIDECAR_EXIT_REASON
                                };
                                (VpnStatus::Error, Some(reason.to_string()))
                            };
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
                        if already_error {
                            crate::logging::log_app(
                                "INFO",
                                "[sidecar] exit after a terminal Error — keeping the authoritative reason (R3/WR-01)",
                            );
                        } else if let Some(state) = state_opt {
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

pub async fn kill_sidecar(sidecar: SidecarChild) -> Result<(), Box<dyn std::error::Error>> {
    let pid = sidecar.child.pid();
    // Try graceful kill first.
    let graceful_ok = sidecar.child.kill().is_ok();
    // Force-kill by PID to ensure the process is dead.
    let taskkill_ok = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    // IN-04: if BOTH the graceful kill AND taskkill report failure, the sidecar may
    // still be alive holding the WinTUN adapter, which the NEXT connect would trip
    // over (only partially mitigated by kill_stale_sidecar). Log a WARN so a stuck
    // adapter is at least diagnosable. The PID is non-secret (A2) — no D-29 concern.
    if !graceful_ok && !taskkill_ok {
        crate::logging::log_app(
            "WARN",
            &format!("[vpn] kill_sidecar: both graceful kill and taskkill failed for PID {pid} — adapter may still be held"),
        );
    }
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

/// Check sidecar log lines for connection milestones and emit "connected" only
/// after both handshake AND DNS proxy are ready (or DNS probe succeeds).
async fn check_sidecar_markers(
    line: &str,
    app: &tauri::AppHandle,
    disconnecting: &Arc<Mutex<bool>>,
    handshake_done: &mut bool,
    dns_proxy_ready: &mut bool,
    connected_emitted: &mut bool,
    spawn_time: &Instant,
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

    // Track VPN handshake completion
    if !*handshake_done && line.contains("Successfully connected to endpoint") {
        *handshake_done = true;
        let elapsed = spawn_time.elapsed().as_millis();
        let msg = format!("[vpn] T+{elapsed}ms: handshake complete");
        eprintln!("{msg}");
        crate::logging::log_app("INFO", &msg);
    }

    // Emit "connected" when handshake is done — ONCE per sidecar lifetime (the
    // `connected_emitted` latch). The old guard was ONLY `!is_already_connected`, so
    // after the connectivity monitor moved the status to Recovering/Reconnecting on a
    // drop, the NEXT stdout line from this still-alive sidecar saw status != Connected
    // and re-emitted Connected — overwriting «Восстановление»/«Переподключение» back to
    // «Подключено» (the stuck-green bug, UAT 65692c test 4). Latching the emit means the
    // monitor and the reconnect supervisor own every status transition after the first
    // connect; a respawned sidecar has its own fresh latch and connects the new session.
    if *handshake_done && !*connected_emitted && !is_already_connected(app) {
        // Latch immediately so a burst of stdout lines (or the async DNS-probe branch
        // below) cannot double-enter; emit_connected's own is_already_connected guard
        // still prevents a duplicate "vpn-status" event.
        *connected_emitted = true;
        if *dns_proxy_ready {
            // DNS proxy already reported ready — emit immediately
            emit_connected(app, spawn_time);
        } else {
            // DNS proxy not yet ready — run a quick probe instead of waiting for log line
            let app_clone = app.clone();
            let t = *spawn_time;
            tokio::spawn(async move {
                let probe_ok = dns_probe(std::time::Duration::from_secs(10)).await;
                let elapsed = t.elapsed().as_millis();
                if probe_ok {
                    crate::logging::log_app("INFO", &format!("[vpn] T+{elapsed}ms: DNS probe success"));
                } else {
                    crate::logging::log_app("WARN", &format!("[vpn] T+{elapsed}ms: DNS probe timeout — emitting connected anyway"));
                }
                emit_connected(&app_clone, &t);
            });
        }
    }
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

/// Probe DNS by resolving a lightweight domain. Returns true as soon as DNS works.
async fn dns_probe(max_wait: std::time::Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < max_wait {
        if let Ok(mut addrs) = tokio::net::lookup_host("clients3.google.com:443").await {
            if addrs.next().is_some() {
                return true;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    false
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

    #[test]
    fn fatal_markers_map_to_derived_messages() {
        // Each of the 4 fatal markers the frontend currently parses must now have
        // an authoritative backend error message (RESEARCH A3).
        assert_eq!(fatal_marker_error("ERROR: Authorization Required"), Some("Authorization failed"));
        assert_eq!(
            fatal_marker_error("WintunCreateAdapter failed: cannot find device"),
            Some("VPN adapter creation failed")
        );
        assert_eq!(fatal_marker_error("Failed to create listener on tun0"), Some("Failed to start VPN tunnel"));
        assert_eq!(fatal_marker_error("tcp connect: Connection refused"), Some("Server refused the connection"));
        assert_eq!(fatal_marker_error("some unrelated info line"), None);
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
        assert!(!marker.is_empty());
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
        assert!(!marker.is_empty());
    }

    #[test]
    fn drop_detected_marker_is_fixed_phrase() {
        let marker = drop_detected_marker();
        assert_no_secret(marker, SAMPLE_SECRET);
        assert_eq!(crate::logging::sanitize(marker), marker);
        assert!(!marker.is_empty());
    }

    #[test]
    fn killed_on_exit_marker_is_fixed_phrase() {
        // The killed-on-exit marker is a fixed phrase with no interpolated secret.
        let marker = killed_on_exit_marker();
        assert_no_secret(marker, SAMPLE_SECRET);
        assert_eq!(crate::logging::sanitize(marker), marker);
        assert!(!marker.is_empty());
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
}
