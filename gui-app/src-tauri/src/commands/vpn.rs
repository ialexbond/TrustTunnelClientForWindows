use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::sidecar;
use crate::routing_rules;
use crate::geodata_v2ray::GeoDataState;
use crate::ssh;

/// Shared application state for VPN lifecycle management.
pub struct AppState {
    pub sidecar_child: Arc<Mutex<Option<sidecar::SidecarChild>>>,
    pub disconnecting: Arc<Mutex<bool>>,
    pub is_connected: Arc<Mutex<bool>>,
    pub tray_notified: Arc<Mutex<bool>>,
    /// Last-used config path for tray-initiated connect.
    pub config_path: Arc<Mutex<Option<String>>>,
    /// Last-used log level for tray-initiated connect.
    pub log_level: Arc<Mutex<String>>,
    /// Current UI locale ("ru" or "en") for tray menu text.
    pub locale: Arc<Mutex<String>>,
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

/// Path to the PID file used to track the sidecar process across restarts.
fn sidecar_pid_path() -> std::path::PathBuf {
    ssh::portable_data_dir().join(".sidecar.pid")
}

/// Save the sidecar PID so we can clean it up after a crash.
fn save_sidecar_pid(pid: u32) {
    let _ = std::fs::write(sidecar_pid_path(), pid.to_string());
}

/// Remove the PID file (called on normal sidecar exit).
fn clear_sidecar_pid() {
    let _ = std::fs::remove_file(sidecar_pid_path());
}

/// Kill a stale sidecar from a previous crashed session using the saved PID file.
/// Only kills the specific process, not all processes with the same name.
pub fn kill_stale_sidecar() {
    let pid_path = sidecar_pid_path();
    if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            eprintln!("[cleanup] Killing stale sidecar PID {pid}");
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .creation_flags(crate::sidecar::CREATE_NO_WINDOW) // CREATE_NO_WINDOW
                .output();
        }
        let _ = std::fs::remove_file(&pid_path);
    }
}

/// Detect conflicting VPN/TUN adapters that may block WinTUN creation.
/// Returns a list of adapter names that look like they belong to other VPN software.
#[cfg(windows)]
fn detect_conflicting_adapters() -> Vec<String> {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            "Get-NetAdapter -IncludeHidden | Where-Object { \
                $_.InterfaceDescription -match 'WireGuard|Wintun|TAP-Windows|tun|Amnezia|OpenVPN' -and \
                $_.InterfaceDescription -notmatch 'TrustTunnel' \
            } | Select-Object -ExpandProperty Name"
        ])
        .creation_flags(crate::sidecar::CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        }
        Err(_) => vec![],
    }
}

#[cfg(not(windows))]
fn detect_conflicting_adapters() -> Vec<String> { vec![] }

/// Kill the sidecar stored in AppState, if any.
pub fn kill_sidecar_from_state(state: &AppState) {
    if let Ok(mut guard) = state.sidecar_child.lock() {
        if let Some(child) = guard.take() {
            child.child.kill().ok();
        }
    }
}

#[tauri::command]
pub async fn vpn_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    geodata_state: tauri::State<'_, Arc<GeoDataState>>,
    config_path: String,
    log_level: String,
) -> Result<(), String> {
    eprintln!("[vpn_connect] Called with config_path={config_path}, log_level={log_level}");

    // Remember config for tray-initiated reconnect
    if let Ok(mut cp) = state.config_path.lock() { *cp = Some(config_path.clone()); }
    if let Ok(mut ll) = state.log_level.lock() { *ll = log_level.clone(); }

    // Emit log so user sees something immediately
    app.emit("vpn-log", VpnLogPayload {
        message: format!("Connecting with config: {config_path}"),
        level: "info".into(),
    }).ok();

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

    // Kill any stale sidecar processes that might hold the WinTUN adapter
    kill_stale_sidecar();
    // Give OS a moment to release the adapter
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Warn about conflicting VPN adapters from other software
    let conflicts = detect_conflicting_adapters();
    if !conflicts.is_empty() {
        let names = conflicts.join(", ");
        let warn_msg = format!("Warning: detected active VPN adapters from other software: {names}. This may cause connection issues. Consider disabling them before connecting.");
        eprintln!("[vpn_connect] {warn_msg}");
        app.emit("vpn-log", VpnLogPayload {
            message: warn_msg.clone(),
            level: "warn".into(),
        }).ok();
        // Also emit as a warning event the frontend can display as snackbar
        app.emit("vpn-adapter-conflict", serde_json::json!({
            "adapters": conflicts,
            "message": warn_msg,
        })).ok();
    }

    app.emit("vpn-log", VpnLogPayload {
        message: "Spawning trusttunnel_client process...".into(),
        level: "info".into(),
    }).ok();

    // Resolve routing rules and write config files before starting sidecar
    let rules = routing_rules::load_routing_rules().unwrap_or_default();
    if let Err(e) = routing_rules::resolve_and_apply_inner(&config_path, &rules, geodata_state.as_ref()) {
        eprintln!("[vpn_connect] Warning: failed to resolve routing rules: {e}");
        app.emit("vpn-log", VpnLogPayload {
            message: format!("Warning: routing rules resolve failed: {e}"),
            level: "warn".into(),
        }).ok();
    }

    // Reset flags for new connection
    if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
    if let Ok(mut c) = state.is_connected.lock() { *c = false; }

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
            app.emit("vpn-log", VpnLogPayload {
                message: msg.clone(),
                level: "error".into(),
            }).ok();
            msg
        })?;

    // Save PID for stale-process cleanup after crashes
    save_sidecar_pid(child.child.pid());

    eprintln!("[vpn_connect] Sidecar spawned OK (PID {}), storing child handle", child.child.pid());
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

    Ok(())
}

#[tauri::command]
pub async fn vpn_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
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
        sidecar::kill_sidecar(child)
            .await
            .map_err(|e| format!("Failed to stop sidecar: {e}"))?;
    }

    // Clean up hosts file blocked entries on disconnect
    routing_rules::cleanup_hosts_block().ok();

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
pub async fn test_sidecar(
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
pub fn check_vpn_status(state: tauri::State<'_, AppState>) -> String {
    let guard = state.sidecar_child.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        let connected = state.is_connected.lock().map(|g| *g).unwrap_or(false);
        if connected { "connected" } else { "connecting" }.to_string()
    } else {
        "disconnected".to_string()
    }
}
