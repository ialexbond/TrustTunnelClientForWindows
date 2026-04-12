use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

pub struct SidecarChild {
    pub child: CommandChild,
    pub disconnecting: Arc<Mutex<bool>>,
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

                    // Detect config parse errors and surface them clearly
                    if trimmed.contains("Failed parsing configuration") {
                        let err_msg = if let Some(pos) = trimmed.find("Failed parsing configuration") {
                            &trimmed[pos..]
                        } else {
                            "Ошибка разбора конфигурации. Проверьте файл .toml"
                        };
                        app_handle
                            .emit(
                                "vpn-status",
                                serde_json::json!({
                                    "status": "error",
                                    "error": format!("⚠ Ошибка конфигурации: {err_msg}"),
                                }),
                            )
                            .ok();
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let was_connected = is_connected.lock().map(|g| *g).unwrap_or(false);
                    if let Ok(mut g) = is_connected.lock() { *g = false; }
                    let exit_code = payload.code.unwrap_or(-1);
                    let was_intentional = disconnecting.lock().map(|g| *g).unwrap_or(false);
                    eprintln!("[sidecar] Process terminated with code {exit_code} (intentional={was_intentional}, was_connected={was_connected})");
                    crate::logging::log_app("INFO", &format!("Sidecar terminated: code={exit_code}, intentional={was_intentional}, was_connected={was_connected}"));

                    let (status, error_msg): (&str, Option<String>) = if was_intentional || exit_code == 0 {
                        ("disconnected", None)
                    } else if was_connected {
                        // VPN was working but dropped — not a startup error
                        ("disconnected", None)
                    } else {
                        ("error", Some(format!("Процесс завершился с кодом {exit_code}")))
                    };

                    // Clear the sidecar child so VPN can be reconnected
                    if let Ok(mut guard) = child_state.lock() {
                        *guard = None;
                        eprintln!("[sidecar] Cleared sidecar_child state");
                    }

                    app_handle
                        .emit(
                            "vpn-status",
                            serde_json::json!({
                                "status": status,
                                "error": error_msg,
                            }),
                        )
                        .ok();
                }
                _ => {}
            }
        }
    });

    Ok(SidecarChild { child, disconnecting: disc_for_child })
}

pub async fn kill_sidecar(sidecar: SidecarChild) -> Result<(), Box<dyn std::error::Error>> {
    sidecar
        .child
        .kill()
        .map_err(|e| format!("Failed to kill sidecar: {e}"))?;
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
    app.emit("vpn-status", serde_json::json!({ "status": "connected" })).ok();
}

/// Probe DNS by resolving a lightweight domain. Returns true as soon as DNS works.
async fn dns_probe(max_wait: std::time::Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < max_wait {
        match tokio::net::lookup_host("clients3.google.com:443").await {
            Ok(mut addrs) => {
                if addrs.next().is_some() {
                    return true;
                }
            }
            Err(_) => {}
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
