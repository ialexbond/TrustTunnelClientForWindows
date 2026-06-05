use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Emitter;
use tauri::Manager; // CR-02: `try_state` to read the single-supervisor guard
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Map a fatal sidecar log marker to a short, DERIVED error message for the
/// authoritative `error` status event (CR-04 / WR-01 — mirror of Pro's
/// `fatal_marker_error`). So the Light frontend can stop guessing the error
/// STATUS from log text (it now only enriches the user-facing MESSAGE).
///
/// D-29 / D-10 invariant: the returned string is a FIXED phrase keyed off the
/// marker kind — it NEVER echoes the raw matched log line, so it can never carry
/// a credential. The user-facing Russian text is still rendered by the frontend
/// i18n layer (from the log line); this backend string is the authoritative,
/// secret-free STATUS signal.
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

/// WR-01 (D-29 leak fix): the config-parse path USED to forward a sliced RAW
/// backend message (`&trimmed[pos..]` — everything from "Failed parsing
/// configuration" onward) wrapped as "⚠ Ошибка конфигурации: ...". A malformed
/// config TOML can embed a credential (the sidecar echoes the offending text), so
/// that raw slice could carry a secret into the `error` field of the `vpn-status`
/// event AND into the frontend trace log — breaking D-29's "no secrets in the log
/// channel". The fix mirrors Pro: hold this branch to the SAME rule as the four
/// fatal markers — emit a fixed, secret-free DERIVED phrase, never the raw text.
const CONFIG_PARSE_ERROR: &str = "Configuration parse error. Check your config file.";

fn config_parse_error(line: &str) -> Option<&'static str> {
    if line.contains("Failed parsing configuration") {
        Some(CONFIG_PARSE_ERROR)
    } else {
        None
    }
}

/// Authoritative backend `error` status detection for the fatal markers the
/// frontend used to guess from log text (CR-04). Routing these through
/// `emit_vpn_status` is the safety pre-condition that let the frontend log-parse
/// `setStatus("error")` calls be deleted without regressing error visibility.
///
/// Called from BOTH the Stdout and Stderr arms — a fatal marker on EITHER stream
/// now sets `error` status (the deleted frontend code matched on every `vpn-log`
/// event regardless of source, so "errors only go to stderr" was an unverified
/// assumption about the external sidecar binary — mirror of Pro's CR-01).
///
/// WR-01: the fatal-marker check and the config-parse check are mutually exclusive
/// (`else if` + single early return) so one line can never emit two conflicting
/// status events, and the config-parse branch surfaces a fixed DERIVED phrase
/// (never the raw `&trimmed[pos..]` slice — D-29).
fn handle_fatal_markers(trimmed: &str, app: &tauri::AppHandle) {
    if let Some(derived) = fatal_marker_error(trimmed) {
        crate::emit_vpn_status(app, "error", Some(derived));
    } else if let Some(derived) = config_parse_error(trimmed) {
        crate::emit_vpn_status(app, "error", Some(derived));
    }
}

pub struct SidecarChild {
    pub child: CommandChild,
    pub disconnecting: Arc<Mutex<bool>>,
    /// RAII handle to the KILL_ON_JOB_CLOSE Job Object this sidecar is assigned to
    /// (D-06 / STATUS-04). Keeping it alive == the OS kill stays armed for the
    /// connection's lifetime; dropping the `SidecarChild` closes the handle exactly
    /// once via `OwnedJobHandle::drop` — so there is NO manual `CloseHandle` anywhere
    /// (Codex MEDIUM). `None` is the explicit DEGRADED MODE (job could not be
    /// assigned: parent already in a job under a debugger / CI / some launchers) —
    /// logged + tolerated, never fatal; the per-edition PID-file fallback still
    /// cleans up.
    ///
    /// `#[allow(dead_code)]`: this field is a DROP-GUARD. It is never *read* — it
    /// lives only so `OwnedJobHandle::drop` runs at the right moment. clippy can't
    /// see the Drop side-effect, so we silence the lint deliberately rather than
    /// weaken the type (mirror of Pro's `SidecarChild.job`).
    #[allow(dead_code)]
    pub job: Option<crate::job_object::OwnedJobHandle>,
}

pub async fn spawn_trusttunnel(
    app: &tauri::AppHandle,
    config_path: &str,
    log_level: &str,
    child_state: Arc<Mutex<Option<SidecarChild>>>,
    disconnecting: Arc<Mutex<bool>>,
    is_connected: Arc<Mutex<bool>>,
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

    // D-08 lifecycle marker (2): sidecar spawn + PID. The PID is the only interpolated
    // value (non-secret — A2); the config path is never logged here. DEV-gated (D-11).
    crate::emit_lifecycle_marker(app, &crate::spawn_pid_marker(child.pid()), "info");

    // D-06 / STATUS-04 — assign the freshly-spawned sidecar to a KILL_ON_JOB_CLOSE
    // Job Object so the OS terminates it whenever this app dies for ANY reason
    // (graceful quit, tray quit, panic, hard crash). `child.pid()` is the real OS PID
    // of trusttunnel_client.exe — the same PID the PID-file cleanup uses (A2). We keep
    // the returned handle alive in `SidecarChild.job`.
    //
    // Codex MEDIUM — EXPLICIT degraded mode: if assign fails (parent already in a job
    // under a debugger / CI / some launchers), we DO NOT abort the connect. We log a
    // fixed phrase + the failed Win32 call name (no secret — D-09) and continue with
    // `job: None`. A Job failure must NEVER block connecting (D-06); the per-edition
    // PID-file stale-cleanup still applies. Mirror of Pro's spawn_trusttunnel.
    let job = match crate::job_object::assign_to_kill_on_close_job(child.pid()) {
        Ok(handle) => {
            let msg = format!(
                "[vpn] sidecar PID {} assigned to KILL_ON_JOB_CLOSE job",
                child.pid()
            );
            eprintln!("{msg}");
            crate::logging::log_app("INFO", &msg);
            Some(handle)
        }
        Err(call) => {
            // `call` is a FIXED phrase naming the failed Win32 call — never a secret.
            let msg = format!(
                "[vpn] Job Object unavailable ({call}); falling back to PID-file cleanup (degraded mode)"
            );
            eprintln!("{msg}");
            crate::logging::log_app("WARN", &msg);
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
                        trimmed, &app_handle, &disc_for_task, &is_connected,
                        &mut handshake_done, &mut dns_proxy_ready, &spawn_time,
                    ).await;

                    // CR-04: a fatal marker can arrive on stdout too — run the
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
                        trimmed, &app_handle, &disc_for_task, &is_connected,
                        &mut handshake_done, &mut dns_proxy_ready, &spawn_time,
                    ).await;

                    // Authoritative backend Error for the fatal markers + config-parse
                    // failure (CR-04). Same helper as the Stdout arm — one place, both
                    // streams, single early return so a line can never double-emit, and
                    // the config-parse branch surfaces a fixed DERIVED phrase instead of
                    // the old raw `&trimmed[pos..]` slice that could leak a credential
                    // out of a malformed config (WR-01 / D-29).
                    handle_fatal_markers(trimmed, &app_handle);
                }
                CommandEvent::Terminated(payload) => {
                    // Clear Light's per-edition PID file — the process is gone, so the
                    // saved PID is stale and must never be used to kill a future (or
                    // other-edition) process (D-07).
                    let _ = std::fs::remove_file(
                        crate::portable_data_dir().join(crate::SIDECAR_PID_BASENAME),
                    );

                    let was_connected = is_connected.lock().map(|g| *g).unwrap_or(false);
                    if let Ok(mut g) = is_connected.lock() { *g = false; }
                    let exit_code = payload.code.unwrap_or(-1);
                    let was_intentional = disconnecting.lock().map(|g| *g).unwrap_or(false);
                    eprintln!("[sidecar] Process terminated with code {exit_code} (intentional={was_intentional}, was_connected={was_connected})");
                    crate::logging::log_app("INFO", &format!("Sidecar terminated: code={exit_code}, intentional={was_intentional}, was_connected={was_connected}"));

                    // Clear the sidecar child so VPN can be reconnected
                    if let Ok(mut guard) = child_state.lock() {
                        *guard = None;
                        eprintln!("[sidecar] Cleared sidecar_child state");
                    }

                    // STATUS-05 / D-04 (trigger A — PROCESS DEATH): an UNEXPECTED drop
                    // of a working VPN (user did NOT disconnect AND we were Connected)
                    // hands off to the WINDOW-INDEPENDENT Rust reconnect supervisor
                    // instead of just setting Disconnected — so a closed-to-tray /
                    // tray-started session recovers without a mounted React effect
                    // (mirror of Pro). A user disconnect / never-connected startup
                    // failure keeps the old behavior below.
                    // CR-02: if a reconnect supervisor is ALREADY live, it OWNS recovery
                    // for this drop — this Terminated event is its OWN respawned child
                    // dying again (server still down). Do NOT spawn a SECOND supervisor:
                    // two supervisors would race, and the generation guard does NOT
                    // separate them because respawn shares the captured generation. The
                    // live supervisor's bounded-3 loop retries this drop; a genuine NEW
                    // drop AFTER it gives up clears the flag (RAII guard). Mirror of Pro.
                    let supervisor_live = app_handle
                        .try_state::<crate::AppState>()
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
                        // DEV-gated drop-detected marker (D-08/D-11).
                        crate::emit_lifecycle_marker(
                            &app_handle,
                            crate::drop_detected_marker(),
                            "warn",
                        );
                        // Capture the CURRENT generation (window-independent — read from
                        // AppState, NOT localStorage) + saved config/log level so the
                        // supervisor neutralizes itself if a manual reconnect / disconnect
                        // bumps it (Codex HIGH).
                        let started = crate::start_reconnect_supervisor_from_state(&app_handle);
                        if !started {
                            // No saved config to respawn from — honest Disconnected rather
                            // than a hung UI.
                            crate::logging::log_app(
                                "WARN",
                                "[reconnect] no saved config path — cannot supervise; setting Disconnected",
                            );
                            crate::emit_vpn_status(&app_handle, "disconnected", None);
                        }
                    } else {
                        // Intentional disconnect / clean exit → Disconnected; a
                        // never-connected non-zero exit → honest Error carrying a STABLE,
                        // secret-free ASCII REASON CODE.
                        //
                        // 02-09 (UAT Gap #2, T-09-01): this branch USED to emit a raw
                        // Cyrillic status string `format!("Процесс завершился с кодом N")`
                        // straight onto the UI — both meaningless to the user AND a
                        // CLAUDE.md i18n violation (UI strings belong in i18n, never
                        // hardcoded in the backend). Mirror of Pro: emit ONE of two fixed
                        // ASCII tokens the shared frontend localizes —
                        //   - `NO_INTERNET_REASON` when the per-attempt pre-flight saw the
                        //     network as offline,
                        //   - `SIDECAR_EXIT_REASON` otherwise (generic VPN-core failure).
                        // This SAME branch already covers an AV / Task-Manager kill of the
                        // sidecar mid-connect (the same never-connected non-zero exit), so
                        // no separate path is needed.
                        // WR-02: gate on `was_intentional || exit_code == 0` only — the old
                        // `|| was_connected` was dead here (this `else` is only reached when
                        // `should_reconnect` already returned false).
                        let (status, error_msg): (&str, Option<&'static str>) =
                            if was_intentional || exit_code == 0 {
                                ("disconnected", None)
                            } else {
                                let preflight_offline = app_handle
                                    .try_state::<crate::AppState>()
                                    .map(|s| {
                                        use std::sync::atomic::Ordering;
                                        s.last_preflight_offline.load(Ordering::SeqCst)
                                    })
                                    .unwrap_or(false);
                                let reason = if preflight_offline {
                                    crate::lifecycle::NO_INTERNET_REASON
                                } else {
                                    crate::lifecycle::SIDECAR_EXIT_REASON
                                };
                                ("error", Some(reason))
                            };
                        crate::emit_vpn_status(&app_handle, status, error_msg);
                    }
                }
                _ => {}
            }
        }
    });

    // `job` is kept alive here for the connection's lifetime — dropping the
    // SidecarChild (on kill / session end) closes the handle once and arms the OS
    // kill. No manual CloseHandle anywhere (OwnedJobHandle::drop owns it).
    Ok(SidecarChild { child, disconnecting: disc_for_child, job })
}

pub async fn kill_sidecar(sidecar: SidecarChild) -> Result<(), Box<dyn std::error::Error>> {
    let pid = sidecar.child.pid();
    // Graceful kill first.
    let graceful_ok = sidecar.child.kill().is_ok();
    // Force-kill by PID to ensure the process is dead (PID-scoped, never image-name —
    // D-07). Mirror of Pro's kill_sidecar.
    #[cfg(windows)]
    {
        let taskkill_ok = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        // IN-04: if BOTH the graceful kill AND taskkill report failure, the sidecar
        // may still be alive holding the WinTUN adapter (the next connect would trip
        // over it — only partially mitigated by kill_stale_sidecar). Log a WARN so a
        // stuck adapter is diagnosable. The PID is non-secret (A2) — no D-29 concern.
        if !graceful_ok && !taskkill_ok {
            crate::logging::log_app(
                "WARN",
                &format!("[vpn] kill_sidecar: both graceful kill and taskkill failed for PID {pid} — adapter may still be held"),
            );
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        let _ = graceful_ok;
    }
    // Dropping `sidecar` here closes the Job Object handle (OwnedJobHandle::drop),
    // arming/triggering the OS kill of any remaining job member as belt-and-braces.
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
    is_connected: &Arc<Mutex<bool>>,
    handshake_done: &mut bool,
    dns_proxy_ready: &mut bool,
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

    // Emit "connected" when handshake is done
    if *handshake_done && !is_connected.lock().map(|g| *g).unwrap_or(false) {
        if *dns_proxy_ready {
            // DNS proxy already reported ready — emit immediately
            emit_connected(app, is_connected, spawn_time);
        } else {
            // DNS proxy not yet ready — run a quick probe instead of waiting for log line
            let app_clone = app.clone();
            let is_conn = Arc::clone(is_connected);
            let t = *spawn_time;
            tokio::spawn(async move {
                let probe_ok = dns_probe(std::time::Duration::from_secs(10)).await;
                let elapsed = t.elapsed().as_millis();
                if probe_ok {
                    crate::logging::log_app("INFO", &format!("[vpn] T+{elapsed}ms: DNS probe success"));
                } else {
                    crate::logging::log_app("WARN", &format!("[vpn] T+{elapsed}ms: DNS probe timeout — emitting connected anyway"));
                }
                emit_connected(&app_clone, &is_conn, &t);
            });
        }
    }
}

fn emit_connected(app: &tauri::AppHandle, is_connected: &Arc<Mutex<bool>>, spawn_time: &Instant) {
    // Guard against double-emit
    if is_connected.lock().map(|g| *g).unwrap_or(false) {
        return;
    }
    if let Ok(mut g) = is_connected.lock() { *g = true; }
    let total = spawn_time.elapsed().as_millis();
    let msg = format!("[vpn] T+{total}ms: VPN fully ready");
    eprintln!("{msg}");
    crate::logging::log_app("INFO", &msg);
    // D-08 lifecycle marker (3): handshake / connected — fixed phrase, DEV-gated.
    crate::emit_lifecycle_marker(app, crate::handshake_marker(), "info");
    app.emit("vpn-status", serde_json::json!({ "status": "connected" })).ok();
}

/// Probe DNS by resolving a lightweight domain. Returns true as soon as DNS works.
async fn dns_probe(max_wait: std::time::Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < max_wait {
        // IN-01: `if let Ok` mirrors Pro's dns_probe and avoids clippy `single_match`
        // (the old `match` had an empty `Err(_) => {}` arm).
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
