mod commands;
mod connectivity;
mod diagnostics;
mod geodata;
mod geodata_v2ray;
mod logging;
mod processes;
mod routing_rules;
mod sidecar;
pub mod ssh;
mod tray;

use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::Emitter;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::image::Image;
use tauri::RunEvent;

use commands::{AppState, kill_sidecar_from_state};

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
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::SIZE
                | tauri_plugin_window_state::StateFlags::POSITION
                | tauri_plugin_window_state::StateFlags::MAXIMIZED
                | tauri_plugin_window_state::StateFlags::FULLSCREEN
            )
            .build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(AppState {
            sidecar_child: Arc::new(Mutex::new(None)),
            disconnecting: Arc::new(Mutex::new(false)),
            is_connected: Arc::new(Mutex::new(false)),
            tray_notified: Arc::new(Mutex::new(false)),
            config_path: Arc::new(Mutex::new(None)),
            log_level: Arc::new(Mutex::new("info".to_string())),
            locale: Arc::new(Mutex::new("ru".to_string())),
        })
        .manage(Arc::new(geodata_v2ray::GeoDataState::new()))
        .manage(ssh::SshPool::new())
        .setup(|app| {
            // Initialize file logging (if enabled via flag file)
            logging::init_logging();
            // Initialize activity log (always active, fire-and-forget from UI)
            commands::activity_log::init_activity_log();

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

            // Open devtools in release builds
            #[cfg(feature = "devtools")]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
            // Build tray context menu
            let tray_menu = tray::build_tray_menu(app.handle(), "disconnected")?;

            // Load disconnected tray icon (red) as initial state
            let initial_icon = tray::load_tray_icon("disconnected");

            // Create tray icon with ID so we can update it later
            TrayIconBuilder::with_id("main-tray")
                .icon(initial_icon)
                .tooltip("TrustTunnel Pro — Отключен")
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
                            tray::tray_vpn_connect(app.clone());
                        }
                        "disconnect" => {
                            tray::tray_vpn_disconnect(app.clone());
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

            // Deep-link URL protocol support is disabled for portable builds.
            // For installer builds, uncomment to auto-register trusttunnel:// and tt://
            // std::thread::spawn(|| { let _ = commands::protocol::register_url_protocols(); });

            // Listen for vpn-status events to update tray icon color
            use tauri::Listener;
            let app_handle = app.handle().clone();
            app.listen_any("vpn-status", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if let Some(status) = payload.get("status").and_then(|s| s.as_str()) {
                        tray::update_tray_icon(&app_handle, status);
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
                        tray::update_tray_icon(&app_handle2, status);
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
                            .title("TrustTunnel Pro")
                            .body("Приложение свёрнуто в трей. Нажмите на иконку, чтобы открыть.")
                            .show()
                            .ok();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_start_minimized,
            get_start_minimized,
            logging::set_logging_enabled,
            logging::get_logging_enabled,
            logging::open_logs_folder,
            commands::vpn::vpn_connect,
            commands::vpn::vpn_disconnect,
            commands::vpn::check_vpn_status,
            commands::vpn::test_sidecar,
            commands::ssh_commands::deploy_server,
            commands::ssh_commands::diagnose_server,
            commands::ssh_commands::forget_ssh_host_key,
            ssh::confirm_host_key,
            commands::ssh_commands::save_ssh_credentials,
            commands::ssh_commands::load_ssh_credentials,
            commands::ssh_commands::clear_ssh_credentials,
            commands::ssh_commands::check_process_conflict,
            commands::ssh_commands::kill_existing_process,
            commands::config::copy_file,
            commands::config::copy_config_to_app_dir,
            commands::config::auto_detect_config,
            commands::config::import_dropped_content,
            commands::config::config_file_exists,
            commands::config::watch_config_file,
            commands::config::unwatch_config_file,
            commands::config::read_client_config,
            commands::config::save_client_config,
            commands::ssh_commands::check_server_installation,
            commands::ssh_commands::uninstall_server,
            commands::ssh_commands::fetch_server_config,
            commands::ssh_commands::add_server_user,
            commands::ssh_commands::server_restart_service,
            commands::ssh_commands::server_stop_service,
            commands::ssh_commands::server_start_service,
            commands::ssh_commands::server_reboot,
            commands::ssh_commands::server_get_logs,
            commands::ssh_commands::server_remove_user,
            commands::ssh_commands::server_get_config,
            commands::ssh_commands::server_get_cert_info,
            commands::ssh_commands::server_renew_cert,
            commands::ssh_commands::server_update_config_feature,
            commands::ssh_commands::server_export_config_deeplink,
            commands::ssh_commands::server_get_available_versions,
            commands::ssh_commands::server_upgrade,
            commands::ssh_commands::server_get_stats,
            commands::ssh_commands::server_get_uptime,
            commands::ssh_commands::security_get_status,
            commands::ssh_commands::security_install_fail2ban,
            commands::ssh_commands::security_uninstall_fail2ban,
            commands::ssh_commands::security_start_fail2ban,
            commands::ssh_commands::security_stop_fail2ban,
            commands::ssh_commands::security_start_firewall,
            commands::ssh_commands::security_stop_firewall,
            commands::ssh_commands::security_fail2ban_unban,
            commands::ssh_commands::security_fail2ban_ban,
            commands::ssh_commands::security_fail2ban_set_jail,
            commands::ssh_commands::security_fail2ban_tail_log,
            commands::ssh_commands::security_install_firewall,
            commands::ssh_commands::security_uninstall_firewall,
            commands::ssh_commands::security_firewall_add_rule,
            commands::ssh_commands::security_firewall_delete_rule,
            commands::ssh_commands::security_firewall_set_logging,
            commands::ssh_commands::security_firewall_tail_log,
            commands::ssh_commands::security_firewall_set_http_port,
            commands::ssh_commands::security_change_ssh_port,
            commands::ssh_commands::mtproto_install,
            commands::ssh_commands::mtproto_get_status,
            commands::ssh_commands::mtproto_uninstall,
            commands::ssh_commands::detect_bbr_status,
            commands::ssh_commands::enable_bbr,
            commands::ssh_commands::disable_bbr,
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
            commands::network::ping_endpoint,
            commands::network::health_check,
            commands::history::record_session_start,
            commands::history::record_session_end,
            commands::history::get_connection_history,
            commands::history::clear_connection_history,
            commands::network::speedtest_run,
            commands::geoip::get_server_geoip,
            commands::updater::self_update,
            commands::deeplink::decode_deeplink,
            commands::deeplink::import_config_from_string,
            commands::protocol::register_url_protocols,
            commands::protocol::check_url_protocols,
            commands::protocol::poll_pending_deeplink,
            commands::activity_log::write_activity_log,
            commands::activity_log::export_activity_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Disconnect pooled SSH connection
                if let Some(pool) = app.try_state::<ssh::SshPool>() {
                    tauri::async_runtime::block_on(pool.invalidate());
                }
                // Final cleanup: kill only our own sidecar (not other app's processes)
                if let Some(state) = app.try_state::<AppState>() {
                    kill_sidecar_from_state(&state);
                }
                // Flush pending log entries before exit
                logging::shutdown_logging();
                // Clean up hosts file blocked entries
                routing_rules::cleanup_hosts_block().ok();
            }
        });
}
