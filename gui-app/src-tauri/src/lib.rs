mod connectivity;
mod geodata;
mod sidecar;
mod ssh_deploy;

use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::image::Image;
use tauri::RunEvent;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Force-kill ALL trusttunnel_client.exe processes system-wide.
/// Called before connecting and on app exit to avoid stale WinTUN locks.
fn kill_all_sidecar_processes() {
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "trusttunnel_client.exe"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
}

/// Kill the sidecar stored in AppState, if any.
fn kill_sidecar_from_state(state: &AppState) {
    if let Ok(mut guard) = state.sidecar_child.lock() {
        if let Some(child) = guard.take() {
            child.child.kill().ok();
        }
    }
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

/// Update tray icon and tooltip based on VPN status.
fn update_tray_icon(app: &tauri::AppHandle, status: &str) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let icon_status = match status {
            "connected" => "connected",
            _ => "disconnected",
        };
        let tooltip = match status {
            "connected" => "TrustTunnel — Подключен",
            "connecting" => "TrustTunnel — Подключение...",
            "recovering" => "TrustTunnel — Переподключение...",
            "disconnecting" => "TrustTunnel — Отключение...",
            "error" => "TrustTunnel — Ошибка",
            _ => "TrustTunnel — Отключен",
        };
        tray.set_icon(Some(load_tray_icon(icon_status))).ok();
        tray.set_tooltip(Some(tooltip)).ok();
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
    tray_notified: Arc<Mutex<bool>>,
}

#[tauri::command]
async fn vpn_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config_path: String,
    log_level: String,
) -> Result<(), String> {
    eprintln!("[vpn_connect] Called with config_path={config_path}, log_level={log_level}");

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
    kill_all_sidecar_processes();
    // Give OS a moment to release the adapter
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    app.emit("vpn-log", VpnLogPayload {
        message: "Spawning trusttunnel_client process...".into(),
        level: "info".into(),
    }).ok();

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

    eprintln!("[vpn_connect] Sidecar spawned OK, storing child handle");
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
async fn vpn_disconnect(
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
async fn deploy_server(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    settings: ssh_deploy::EndpointSettings,
) -> Result<String, String> {
    ssh_deploy::deploy_server(&app, host, port, user, password, key_path, settings).await
}

#[tauri::command]
fn check_vpn_status(state: tauri::State<'_, AppState>) -> String {
    let guard = state.sidecar_child.lock().unwrap();
    if guard.is_some() {
        let connected = state.is_connected.lock().map(|g| *g).unwrap_or(false);
        if connected { "connected" } else { "connecting" }.to_string()
    } else {
        "disconnected".to_string()
    }
}

#[tauri::command]
async fn diagnose_server(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    ssh_deploy::diagnose_server(&app, host, port, user, password, key_path).await
}

#[tauri::command]
fn check_process_conflict() -> Option<String> {
    ssh_deploy::check_process_conflict()
}

#[tauri::command]
fn kill_existing_process() -> Result<(), String> {
    ssh_deploy::kill_existing_process()
}

#[tauri::command]
async fn check_server_installation(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<serde_json::Value, String> {
    ssh_deploy::check_server_installation(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn uninstall_server(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    ssh_deploy::uninstall_server(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn fetch_server_config(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    client_name: String,
) -> Result<String, String> {
    ssh_deploy::fetch_server_config(&app, host, port, user, password, key_path, client_name).await
}

#[tauri::command]
async fn add_server_user(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    vpn_username: String,
    vpn_password: String,
) -> Result<String, String> {
    ssh_deploy::add_server_user(&app, host, port, user, password, key_path, vpn_username, vpn_password).await
}

#[tauri::command]
async fn server_restart_service(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    ssh_deploy::server_restart_service(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_stop_service(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    ssh_deploy::server_stop_service(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_start_service(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    ssh_deploy::server_start_service(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_reboot(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    ssh_deploy::server_reboot(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_get_logs(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    ssh_deploy::server_get_logs(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_remove_user(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    vpn_username: String,
) -> Result<(), String> {
    ssh_deploy::server_remove_user(&app, host, port, user, password, key_path, vpn_username).await
}

#[tauri::command]
async fn server_get_config(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    ssh_deploy::get_server_config(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_get_cert_info(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<serde_json::Value, String> {
    ssh_deploy::get_cert_info(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_renew_cert(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<String, String> {
    ssh_deploy::renew_cert(&app, host, port, user, password, key_path).await
}

#[tauri::command]
async fn server_update_config_feature(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    feature: String,
    enabled: bool,
) -> Result<(), String> {
    ssh_deploy::update_config_feature(&app, host, port, user, password, key_path, feature, enabled).await
}

#[tauri::command]
async fn server_export_config_deeplink(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    client_name: String,
) -> Result<String, String> {
    ssh_deploy::export_config_deeplink(&app, host, port, user, password, key_path, client_name).await
}

#[tauri::command]
async fn server_get_available_versions() -> Result<Vec<String>, String> {
    ssh_deploy::server_get_available_versions().await
}

#[tauri::command]
async fn server_upgrade(
    app: tauri::AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    version: String,
) -> Result<(), String> {
    ssh_deploy::server_upgrade(&app, host, port, user, password, key_path, version).await
}

/// Copy a file to a user-chosen destination (for "Save As" functionality).
#[tauri::command]
fn copy_file(source: String, destination: String) -> Result<(), String> {
    std::fs::copy(&source, &destination)
        .map_err(|e| format!("Не удалось скопировать файл: {e}"))?;
    Ok(())
}

/// Copy a config file into the app directory (next to the executable).
/// Returns the new path. If the file is already in the app dir, returns it as-is.
#[tauri::command]
fn copy_config_to_app_dir(source_path: String) -> Result<String, String> {
    let src = std::path::Path::new(&source_path);
    if !src.exists() {
        return Err(format!("Source file does not exist: {source_path}"));
    }
    let exe = std::env::current_exe().map_err(|e| format!("Cannot find exe path: {e}"))?;
    let app_dir = exe.parent().ok_or("Cannot determine app directory")?;
    let src_dir = src.parent().unwrap_or(std::path::Path::new(""));

    // Already in app dir — no copy needed
    if src_dir == app_dir {
        return Ok(source_path);
    }

    let file_name = src
        .file_name()
        .ok_or("Cannot determine file name")?;
    let dest = app_dir.join(file_name);

    std::fs::copy(src, &dest)
        .map_err(|e| format!("Failed to copy config: {e}"))?;

    Ok(dest.to_string_lossy().to_string())
}

/// Find .toml config files next to the executable
#[tauri::command]
fn auto_detect_config() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for entry in std::fs::read_dir(dir).ok()? {
        if let Ok(e) = entry {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) == Some("toml")
                && path.file_name().and_then(|s| s.to_str()) != Some("Cargo.toml")
            {
                // Verify it looks like a trusttunnel config (has [endpoint] or [listener])
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if content.contains("[endpoint]") || content.contains("[listener") {
                        return Some(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
fn read_client_config(config_path: String) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;
    let table: toml::Value = match content.parse() {
        Ok(v) => v,
        Err(e) => {
            // Attempt recovery: strip all exclusions blocks and re-parse
            eprintln!("[config] Parse error: {e}. Attempting recovery by stripping exclusions...");
            let mut lines: Vec<&str> = Vec::new();
            let mut skip = false;
            for line in content.lines() {
                let t = line.trim();
                if t.starts_with("exclusions") && t.contains('[') {
                    skip = true;
                    continue;
                }
                if skip {
                    if t == "]" { skip = false; continue; }
                    if t.starts_with('"') || t.is_empty() || t.starts_with('#') { continue; }
                    skip = false;
                }
                lines.push(line);
            }
            let fixed = lines.join("\n");
            // Write the fixed config back to disk so future reads succeed
            if let Ok(parsed) = fixed.parse::<toml::Value>() {
                let _ = std::fs::write(&config_path, &fixed);
                eprintln!("[config] Recovery successful, fixed config saved");
                parsed
            } else {
                return Err(format!("Failed to parse TOML: {e}"));
            }
        }
    };
    // Auto-patch: ensure killswitch_allow_ports includes DHCP ports (67, 68)
    // so Kill Switch doesn't block DHCP lease renewal on existing configs
    if table.get("killswitch_allow_ports").is_none() {
        if let Ok(mut doc) = std::fs::read_to_string(&config_path)
            .unwrap_or_default()
            .parse::<toml_edit::DocumentMut>()
        {
            let mut ports = toml_edit::Array::new();
            ports.push(67);
            ports.push(68);
            doc["killswitch_allow_ports"] = toml_edit::value(ports);
            let _ = std::fs::write(&config_path, doc.to_string());
            eprintln!("[config] Auto-patched: added killswitch_allow_ports = [67, 68]");
        }
    }

    // Convert toml::Value to serde_json::Value
    let json = serde_json::to_value(&table)
        .map_err(|e| format!("Failed to convert: {e}"))?;
    Ok(json)
}

#[tauri::command]
fn save_client_config(config_path: String, config: serde_json::Value) -> Result<(), String> {
    // Read existing exclusions before overwriting — they are managed by RoutingPanel
    // via save_exclusion_list and must not be lost when SettingsPanel saves.
    let existing_exclusions: Vec<String> = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|c| c.parse::<toml_edit::DocumentMut>().ok())
        .and_then(|doc| {
            doc.get("exclusions")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        })
        .unwrap_or_default();

    // Convert JSON back to toml::Value then serialize
    let toml_val: toml::Value = serde_json::from_value(config)
        .map_err(|e| format!("Failed to convert config: {e}"))?;
    let content = toml::to_string_pretty(&toml_val)
        .map_err(|e| format!("Failed to serialize TOML: {e}"))?;
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    // Re-apply exclusions and ensure killswitch_allow_ports includes DHCP
    {
        let fresh = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to re-read config: {e}"))?;
        let mut doc: toml_edit::DocumentMut = fresh
            .parse()
            .map_err(|e: toml_edit::TomlError| format!("Failed to re-parse config: {e}"))?;

        if !existing_exclusions.is_empty() {
            let mut arr = toml_edit::Array::new();
            for d in &existing_exclusions {
                arr.push(d.as_str());
            }
            doc["exclusions"] = toml_edit::value(arr);
        }

        // Ensure DHCP ports (67, 68) are always in killswitch_allow_ports
        // so Kill Switch doesn't block DHCP lease renewal
        let mut ports = toml_edit::Array::new();
        ports.push(67);
        ports.push(68);
        doc["killswitch_allow_ports"] = toml_edit::value(ports);

        std::fs::write(&config_path, doc.to_string())
            .map_err(|e| format!("Failed to write config back: {e}"))?;
    }

    Ok(())
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

#[derive(Clone, Serialize)]
struct UpdateProgress {
    stage: String,
    percent: u32,
    message: String,
}

/// Self-update: download new ZIP, extract, create updater script, restart.
#[tauri::command]
async fn self_update(
    app: tauri::AppHandle,
    download_url: String,
) -> Result<(), String> {
    use std::io::Write;
    use tokio::io::AsyncWriteExt;

    let emit = |stage: &str, percent: u32, msg: &str| {
        app.emit("update-progress", UpdateProgress {
            stage: stage.to_string(),
            percent,
            message: msg.to_string(),
        }).ok();
    };

    emit("download", 0, "Начинаем загрузку...");

    // Determine paths
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot determine exe path: {e}"))?;
    let app_dir = exe_path.parent()
        .ok_or("Cannot determine app directory")?;
    let temp_dir = std::env::temp_dir();
    let zip_path = temp_dir.join("trusttunnel_update.zip");
    let extract_dir = temp_dir.join("trusttunnel_update");

    // Clean up previous update artifacts
    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::remove_dir_all(&extract_dir);

    // Download the ZIP with progress
    emit("download", 5, "Подключение к серверу...");
    let client = reqwest::Client::new();
    let resp = client.get(&download_url)
        .header("User-Agent", "TrustTunnel-Updater")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download HTTP error: {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .map_err(|e| format!("Cannot create temp file: {e}"))?;

    let mut stream = resp.bytes_stream();
    use tokio_stream::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if total_size > 0 {
            let pct = ((downloaded as f64 / total_size as f64) * 80.0) as u32 + 5;
            emit("download", pct.min(85), &format!("Загрузка: {:.1} МБ / {:.1} МБ",
                downloaded as f64 / 1_048_576.0,
                total_size as f64 / 1_048_576.0));
        }
    }
    file.flush().await.ok();
    drop(file);

    emit("extract", 88, "Распаковка обновления...");

    // Extract ZIP using PowerShell
    let extract_dir_str = extract_dir.to_string_lossy().to_string();
    let zip_path_str = zip_path.to_string_lossy().to_string();
    let ps_output = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile", "-Command",
            &format!(
                "Remove-Item '{}' -Recurse -Force -ErrorAction SilentlyContinue; \
                 Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                extract_dir_str, zip_path_str, extract_dir_str
            ),
        ])
        .creation_flags(0x08000000)
        .output()
        .await
        .map_err(|e| format!("Extract failed: {e}"))?;

    if !ps_output.status.success() {
        let err = String::from_utf8_lossy(&ps_output.stderr);
        return Err(format!("Extraction failed: {err}"));
    }

    // Find the extracted files — could be in a subfolder
    let source_dir = {
        let mut src = extract_dir.clone();
        // If there's a single subfolder, use that
        if let Ok(mut entries) = std::fs::read_dir(&extract_dir) {
            let first = entries.next();
            let second = entries.next();
            if second.is_none() {
                if let Some(Ok(entry)) = first {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        src = entry.path();
                    }
                }
            }
        }
        src
    };

    // Verify the extracted folder has trusttunnel.exe
    if !source_dir.join("trusttunnel.exe").exists() {
        return Err("Обновление не содержит trusttunnel.exe. Архив повреждён?".into());
    }

    emit("install", 92, "Подготовка к установке...");

    // Create the updater batch script
    let bat_path = temp_dir.join("trusttunnel_updater.bat");
    let pid = std::process::id();
    let app_dir_str = app_dir.to_string_lossy().to_string();
    let source_dir_str = source_dir.to_string_lossy().to_string();
    let vbs_path_str = temp_dir.join("trusttunnel_updater.vbs").to_string_lossy().to_string();
    let bat_content = format!(
        r#"@echo off
title TrustTunnel Updater
echo Waiting for TrustTunnel to exit (PID {pid})...
:waitloop
tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto waitloop
)
echo Copying update files...
xcopy /Y /E /I "{source_dir_str}\*" "{app_dir_str}\" >nul 2>&1
if errorlevel 1 (
    echo Copy failed! Please update manually.
    pause
    exit /b 1
)
echo Starting updated version...
start "" "{app_dir_str}\TrustTunnel.exe"
echo Cleaning up temp files...
rd /s /q "{extract_dir_str}" >nul 2>&1
del "{zip_path_str}" >nul 2>&1
del "{vbs_path_str}" >nul 2>&1
(goto) 2>nul & del "%~f0"
"#
    );

    {
        let mut bat_file = std::fs::File::create(&bat_path)
            .map_err(|e| format!("Cannot create updater script: {e}"))?;
        bat_file.write_all(bat_content.as_bytes())
            .map_err(|e| format!("Cannot write updater script: {e}"))?;
    }

    emit("install", 96, "Запуск обновления, приложение перезапустится...");

    // Kill VPN sidecar before exit
    if let Some(state) = app.try_state::<AppState>() {
        kill_sidecar_from_state(&state);
    }
    kill_all_sidecar_processes();

    // Launch the updater bat completely hidden via a VBS wrapper
    let vbs_path = temp_dir.join("trusttunnel_updater.vbs");
    let vbs_content = format!(
        "CreateObject(\"Wscript.Shell\").Run \"{}\", 0, False",
        bat_path.to_string_lossy().replace('\\', "\\\\").replace('"', "\"\"")
    );
    std::fs::write(&vbs_path, &vbs_content)
        .map_err(|e| format!("Cannot create VBS launcher: {e}"))?;

    std::process::Command::new("wscript.exe")
        .arg(&vbs_path)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("Cannot launch updater: {e}"))?;

    // Give the bat a moment to start, then exit the app
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    app.exit(0);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second instance launched — focus existing window instead
            if let Some(w) = app.get_webview_window("main") {
                w.show().ok();
                w.set_focus().ok();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            sidecar_child: Arc::new(Mutex::new(None)),
            disconnecting: Arc::new(Mutex::new(false)),
            is_connected: Arc::new(Mutex::new(false)),
            tray_notified: Arc::new(Mutex::new(false)),
        })
        .setup(|app| {
            // Open devtools in release builds
            #[cfg(feature = "devtools")]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
            // Build tray context menu
            let show_item = MenuItemBuilder::with_id("show", "Показать").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Выход").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Load disconnected tray icon (red) as initial state
            let initial_icon = load_tray_icon("disconnected");

            // Create tray icon with ID so we can update it later
            TrayIconBuilder::with_id("main-tray")
                .icon(initial_icon)
                .tooltip("TrustTunnel — Отключен")
                .menu(&tray_menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                w.show().ok();
                                w.set_focus().ok();
                            }
                        }
                        "quit" => {
                            // Kill sidecar + all stale processes before exiting
                            if let Some(state) = app.try_state::<AppState>() {
                                kill_sidecar_from_state(&state);
                            }
                            kill_all_sidecar_processes();
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
                            .title("TrustTunnel")
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
            test_sidecar,
            deploy_server,
            diagnose_server,
            check_process_conflict,
            kill_existing_process,
            copy_file,
            copy_config_to_app_dir,
            auto_detect_config,
            read_client_config,
            save_client_config,
            check_server_installation,
            uninstall_server,
            fetch_server_config,
            add_server_user,
            server_restart_service,
            server_stop_service,
            server_start_service,
            server_reboot,
            server_get_logs,
            server_remove_user,
            server_get_config,
            server_get_cert_info,
            server_renew_cert,
            server_update_config_feature,
            server_export_config_deeplink,
            server_get_available_versions,
            server_upgrade,
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
            ping_endpoint,
            speedtest_run,
            self_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Final cleanup: kill sidecar from state + any stale processes
                if let Some(state) = app.try_state::<AppState>() {
                    kill_sidecar_from_state(&state);
                }
                kill_all_sidecar_processes();
            }
        });
}
