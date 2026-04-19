use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri::Emitter;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::image::Image;

use crate::commands::{AppState, kill_stale_sidecar};
use crate::{routing_rules, geodata_v2ray, sidecar};

/// Detect Windows system theme via registry.
///
/// `SystemUsesLightTheme` under
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`:
/// 1 = light, 0 = dark. Fallback → "dark" при любой ошибке. Apps-тема
/// отдельная (`AppsUseLightTheme`) — нам нужна system-wide (панель
/// задач), потому что tray-иконка рисуется именно там.
pub fn detect_windows_system_theme() -> &'static str {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let path = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
        if let Ok(key) = hkcu.open_subkey(path) {
            if let Ok(val) = key.get_value::<u32, _>("SystemUsesLightTheme") {
                return if val == 1 { "light" } else { "dark" };
            }
        }
    }
    "dark"
}

/// Normalize a VPN status to the 3 tray-icon buckets:
/// - `connected` → zelyonyy indicator
/// - `reconnect` → oranzhevyy indicator (connecting / recovering / disconnecting)
/// - `off` → seryy indicator (disconnected / error / unknown)
fn status_bucket(status: &str) -> &'static str {
    match status {
        "connected" => "connected",
        "connecting" | "recovering" | "disconnecting" => "reconnect",
        _ => "off",
    }
}

/// Load a tray icon .ico embedded at compile time. Picks the right asset
/// based on VPN-status bucket × Windows system theme (не app theme).
pub fn load_tray_icon(status: &str, theme: &str) -> Image<'static> {
    // 6 icons total: 3 buckets × 2 themes. include_bytes! вшивает файлы в
    // бинарь, runtime не читает диск.
    let bytes: &[u8] = match (status_bucket(status), theme) {
        ("connected", "light") => include_bytes!("../icons/tray/tray-light-connected.ico"),
        ("connected", _)       => include_bytes!("../icons/tray/tray-dark-connected.ico"),
        ("reconnect", "light") => include_bytes!("../icons/tray/tray-light-reconnect.ico"),
        ("reconnect", _)       => include_bytes!("../icons/tray/tray-dark-reconnect.ico"),
        (_, "light")           => include_bytes!("../icons/tray/tray-light-off.ico"),
        (_, _)                 => include_bytes!("../icons/tray/tray-dark-off.ico"),
    };
    Image::from_bytes(bytes).expect("Failed to load tray icon .ico")
}

/// Pulse task coordinator — для статуса `reconnect` tray иконка
/// мерцает между полным-цветом и dimmed (тусклый off-icon). Даёт
/// пользователю визуальный сигнал «что-то происходит» даже когда
/// окно свёрнуто в трей.
///
/// Cancel flag общий per-process — start_pulse ставит false в старый
/// флаг чтобы task чисто вышел, создаёт новый флаг для своего цикла.
static PULSE_CANCEL: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

fn stop_pulse() {
    if let Ok(mut guard) = PULSE_CANCEL.lock() {
        if let Some(flag) = guard.take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn start_pulse(app: tauri::AppHandle, theme: String) {
    stop_pulse();
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = PULSE_CANCEL.lock() {
        *guard = Some(Arc::clone(&cancel));
    }
    tauri::async_runtime::spawn(async move {
        // Чередуем reconnect-icon и off-icon каждые 550ms — это
        // subtle-пульсация, не раздражающая, но заметная краем глаза.
        let mut tick: u32 = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let icon_status = if tick % 2 == 0 { "reconnect" } else { "off" };
            if let Some(tray) = app.tray_by_id("main-tray") {
                tray.set_icon(Some(load_tray_icon(icon_status, &theme))).ok();
            }
            tick = tick.wrapping_add(1);
            tokio::time::sleep(std::time::Duration::from_millis(550)).await;
        }
    });
}

/// Get current locale from AppState, defaulting to "ru".
pub fn get_locale(app: &tauri::AppHandle) -> String {
    app.try_state::<AppState>()
        .and_then(|s| s.locale.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "ru".to_string())
}

/// Build the tray context menu based on current VPN status and locale.
pub fn build_tray_menu(app: &tauri::AppHandle, status: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
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
///
/// System theme (Windows Personalize) detects at each update —
/// user может переключить тему Windows, и в следующий update мы
/// подхватим. Live theme-change event (WM_SETTINGCHANGE) потребует
/// хука на Rust-side, отложен — обычный VPN-status update тоже
/// прилетает часто (коннект/реконнект/disconnect), так что иконка
/// refresh'ится в течение нескольких секунд после смены темы.
///
/// Reconnect bucket запускает pulse_task (мерцание 550ms) —
/// визуальный сигнал что VPN не в стабильном состоянии. Любой
/// другой status отменяет pulse и ставит статичную иконку.
pub fn update_tray_icon(app: &tauri::AppHandle, status: &str) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let system_theme = detect_windows_system_theme().to_string();
        let bucket = status_bucket(status);

        if bucket == "reconnect" {
            // Pulsing icon для connecting/recovering/disconnecting
            start_pulse(app.clone(), system_theme.clone());
        } else {
            // Static icon для connected / off
            stop_pulse();
            tray.set_icon(Some(load_tray_icon(bucket, &system_theme))).ok();
        }

        let locale = get_locale(app);
        let is_ru = locale == "ru";
        let tooltip = match status {
            "connected" => if is_ru { "TrustTunnel Pro — Подключен" } else { "TrustTunnel Pro — Connected" },
            "connecting" => if is_ru { "TrustTunnel Pro — Подключение..." } else { "TrustTunnel Pro — Connecting..." },
            "recovering" => if is_ru { "TrustTunnel Pro — Переподключение..." } else { "TrustTunnel Pro — Reconnecting..." },
            "disconnecting" => if is_ru { "TrustTunnel Pro — Отключение..." } else { "TrustTunnel Pro — Disconnecting..." },
            "error" => if is_ru { "TrustTunnel Pro — Ошибка" } else { "TrustTunnel Pro — Error" },
            _ => if is_ru { "TrustTunnel Pro — Отключен" } else { "TrustTunnel Pro — Disconnected" },
        };
        tray.set_tooltip(Some(tooltip)).ok();

        // Rebuild menu to reflect new status
        if let Ok(menu) = build_tray_menu(app, status) {
            tray.set_menu(Some(menu)).ok();
        }
    }
}

/// Connect VPN from tray menu (no frontend involvement).
pub fn tray_vpn_connect(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return; };

    // Check if already running
    if let Ok(guard) = state.sidecar_child.lock() {
        if guard.is_some() { return; }
    }

    // Get config path: stored from last connect, or auto-detect
    let config_path = state.config_path.lock().ok()
        .and_then(|g| g.clone())
        .or_else(|| crate::commands::config::auto_detect_config());

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

    let geodata_state = app.state::<Arc<geodata_v2ray::GeoDataState>>().inner().clone();

    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else { return; };

        // Emit connecting status
        app.emit("vpn-status", serde_json::json!({"status": "connecting"})).ok();

        // Kill stale sidecar processes
        kill_stale_sidecar();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Resolve routing rules
        let rules = routing_rules::load_routing_rules().unwrap_or_default();
        if let Err(e) = routing_rules::resolve_and_apply_inner(&config_path, &rules, &geodata_state) {
            eprintln!("[tray_vpn_connect] Warning: routing rules resolve failed: {e}");
        }

        // Reset flags
        if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
        if let Ok(mut c) = state.is_connected.lock() { *c = false; }

        let child_arc = Arc::clone(&state.sidecar_child);
        let disc_arc = Arc::clone(&state.disconnecting);
        let conn_arc = Arc::clone(&state.is_connected);

        let sidecar_log_level = match log_level.as_str() {
            "error" | "warn" => "info",
            other => other,
        };

        match sidecar::spawn_trusttunnel(&app, &config_path, sidecar_log_level, child_arc, disc_arc, conn_arc).await {
            Ok(child) => {
                eprintln!("[tray_vpn_connect] Sidecar spawned OK (PID {})", child.child.pid());
                if let Ok(mut guard) = state.sidecar_child.lock() {
                    *guard = Some(child);
                }
                app.emit("vpn-status", serde_json::json!({"status": "connecting"})).ok();
            }
            Err(e) => {
                eprintln!("[tray_vpn_connect] Failed: {e}");
                app.emit("vpn-status", serde_json::json!({"status": "error", "error": e.to_string()})).ok();
            }
        }
    });
}

/// Disconnect VPN from tray menu.
pub fn tray_vpn_disconnect(app: tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return; };

    let child = {
        let Ok(mut guard) = state.sidecar_child.lock() else { return; };
        guard.take()
    };

    if let Some(child) = child {
        if let Ok(mut d) = child.disconnecting.lock() { *d = true; }
        if let Ok(mut d) = state.disconnecting.lock() { *d = true; }

        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            sidecar::kill_sidecar(child).await.ok();
            routing_rules::cleanup_hosts_block().ok();
            app_clone.emit("vpn-status", serde_json::json!({"status": "disconnected"})).ok();
        });
    }
}
