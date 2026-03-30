mod commands;
mod connectivity;
mod geodata;
mod geodata_v2ray;
mod routing_rules;
mod sidecar;

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

/// Portable data directory: same folder as the executable.
/// Standalone helper replacing the old ssh_deploy::portable_data_dir.
pub fn portable_data_dir() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or(std::path::Path::new(".")).to_path_buf()
}

/// Force-kill ALL trusttunnel_client.exe processes system-wide.
/// Called before connecting and on app exit to avoid stale WinTUN locks.
pub fn kill_all_sidecar_processes() {
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
            "connected" => "TrustTunnel Light — Подключен",
            "connecting" => "TrustTunnel Light — Подключение...",
            "recovering" => "TrustTunnel Light — Переподключение...",
            "disconnecting" => "TrustTunnel Light — Отключение...",
            "error" => "TrustTunnel Light — Ошибка",
            _ => "TrustTunnel Light — Отключен",
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

#[tauri::command]
fn set_logging_enabled(enabled: bool) -> Result<(), String> {
    let flag_path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("no parent dir")?
        .join(".enable_logs");
    if enabled {
        std::fs::write(&flag_path, "1").map_err(|e| e.to_string())?;
    } else {
        let _ = std::fs::remove_file(&flag_path);
    }
    Ok(())
}

#[tauri::command]
fn get_logging_enabled() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(".enable_logs")))
        .map(|p| p.exists())
        .unwrap_or(false)
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
fn check_vpn_status(state: tauri::State<'_, AppState>) -> String {
    let guard = state.sidecar_child.lock().unwrap();
    if guard.is_some() {
        let connected = state.is_connected.lock().map(|g| *g).unwrap_or(false);
        if connected { "connected" } else { "connecting" }.to_string()
    } else {
        "disconnected".to_string()
    }
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
            // Second instance launched — focus existing window
            if let Some(w) = app.get_webview_window("main") {
                w.show().ok();
                w.set_focus().ok();
            }
            // Check if second instance was launched with a deep-link URL
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
            tray_notified: Arc::new(Mutex::new(false)),
        })
        .manage(Arc::new(geodata_v2ray::GeoDataState::new()))
        .setup(|app| {
            // Show window unless start_minimized flag file exists next to exe
            if let Some(window) = app.get_webview_window("main") {
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
            test_sidecar,
            set_start_minimized,
            set_logging_enabled,
            get_logging_enabled,
            get_start_minimized,
            commands::config::copy_file,
            commands::config::copy_config_to_app_dir,
            commands::config::auto_detect_config,
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
            ping_endpoint,
            speedtest_run,
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
                // Clean up hosts file blocked entries
                routing_rules::cleanup_hosts_block().ok();
            }
        });
}
