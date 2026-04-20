use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri::Emitter;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::image::Image;

use crate::commands::{AppState, kill_stale_sidecar};
use crate::{routing_rules, geodata_v2ray, sidecar};

/// Tray icon theme — hardcoded `"dark"` (контрастный шилд).
///
/// Ранее читали Windows registry SystemUsesLightTheme для auto-swap,
/// но пользователь решил что dark-variant читается одинаково хорошо
/// на любой системной теме, а живая смена (requires WM_SETTINGCHANGE
/// watcher) — overkill для маленького tray glyph. Сохраняем функцию
/// как константу, чтобы `load_tray_icon(..., "dark")` не менять
/// везде, где зовётся.
pub fn detect_windows_system_theme() -> &'static str {
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

/// Load a tray icon PNG embedded at compile time. Picks the right asset
/// based on VPN-status bucket × Windows system theme (не app theme).
///
/// Tauri `Image::from_bytes` ожидает PNG (не .ico контейнер). Берём
/// 32×32 версии из `logo/tray/png/` — standard size для Windows taskbar
/// при 100% DPI. Файлы встраиваются в бинарь через include_bytes!.
pub fn load_tray_icon(status: &str, theme: &str) -> Image<'static> {
    let bytes: &[u8] = match (status_bucket(status), theme) {
        ("connected", "light") => include_bytes!("../icons/tray/tray-light-connected-32.png"),
        ("connected", _)       => include_bytes!("../icons/tray/tray-dark-connected-32.png"),
        ("reconnect", "light") => include_bytes!("../icons/tray/tray-light-reconnect-32.png"),
        ("reconnect", _)       => include_bytes!("../icons/tray/tray-dark-reconnect-32.png"),
        (_, "light")           => include_bytes!("../icons/tray/tray-light-off-32.png"),
        (_, _)                 => include_bytes!("../icons/tray/tray-dark-off-32.png"),
    };
    Image::from_bytes(bytes).expect("Failed to load tray icon PNG")
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

        // Rebuild native menu to reflect new status (Connect ↔ Disconnect).
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

/// Cached tray icon rect — saved при right click, читается из
/// `tray_menu_reposition` когда frontend домерял content и просит
/// пересчитать позицию под новый size.
static TRAY_ICON_RECT: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

/// Compute anchored position для меню размера (mw×mh physical px) с
/// учётом icon rect (ix, iy, iw, ih — physical).
///
/// Anchor:
///   - horizontal: меню **справа от иконки** (left edge menu = right edge icon + gap),
///     fallback — слева от иконки если не помещается справа
///   - vertical: над иконкой (taskbar обычно снизу), fallback снизу
fn compute_menu_position(
    win: &tauri::WebviewWindow,
    ix: f64, iy: f64, iw: f64, ih: f64,
    mw: i32, mh: i32,
) -> (i32, i32) {
    let gap = 2_i32;
    let icon_left = ix as i32;
    let icon_right = (ix + iw) as i32;
    let icon_top = iy as i32;
    let icon_bottom = (iy + ih) as i32;

    let mut x = icon_right + gap;
    let mut y = icon_top - mh - gap;

    if let Ok(Some(monitor)) = win.primary_monitor() {
        let ms = monitor.size();
        let sw = ms.width as i32;
        let sh = ms.height as i32;

        if x + mw > sw - 4 {
            x = icon_left - mw - gap;
        }
        if x < 4 { x = 4; }
        if y < 4 { y = icon_bottom + gap; }
        if y + mh > sh - 4 { y = sh - mh - 4; }
    }
    (x, y)
}

/// Show custom tray context menu. Caches icon rect для последующего
/// `tray_menu_reposition` после auto-size измерения на фронте.
pub fn show_custom_tray_menu(
    app: &tauri::AppHandle,
    icon_x: f64,
    icon_y: f64,
    icon_w: f64,
    icon_h: f64,
) {
    let Some(win) = app.get_webview_window("tray-menu") else { return; };

    if let Ok(mut guard) = TRAY_ICON_RECT.lock() {
        *guard = Some((icon_x, icon_y, icon_w, icon_h));
    }

    // Fallback size до того как frontend измерит content и позовёт
    // tray_menu_reposition. Matches tauri.conf.json initial values.
    let scale = win.scale_factor().unwrap_or(1.0);
    let mw = (180.0 * scale) as i32;
    let mh = (130.0 * scale) as i32;

    let (x, y) = compute_menu_position(&win, icon_x, icon_y, icon_w, icon_h, mw, mh);
    let _ = win.set_position(tauri::PhysicalPosition::<i32> { x, y });
    let _ = win.show();
    let _ = win.set_focus();
}

/// Repositioner: frontend после useLayoutEffect замеряет content и
/// вызывает этот command с logical width/height. Пересчитываем position
/// под новый размер + applies setSize + setPosition.
#[tauri::command]
pub fn tray_menu_reposition(app: tauri::AppHandle, width: u32, height: u32) {
    let Some(win) = app.get_webview_window("tray-menu") else { return; };
    let rect = {
        let Ok(guard) = TRAY_ICON_RECT.lock() else { return; };
        *guard
    };
    let Some((ix, iy, iw, ih)) = rect else { return; };

    let scale = win.scale_factor().unwrap_or(1.0);
    let mw_phys = (width as f64 * scale).ceil() as i32;
    let mh_phys = (height as f64 * scale).ceil() as i32;

    let _ = win.set_size(tauri::LogicalSize::<u32> { width, height });
    let (x, y) = compute_menu_position(&win, ix, iy, iw, ih, mw_phys, mh_phys);
    let _ = win.set_position(tauri::PhysicalPosition::<i32> { x, y });
}

/// Apply native Windows 11 rounded corners через DwmSetWindowAttribute.
///
/// Работает без transparent (который сломан в dark theme Win11 — see
/// Tauri issue #13859). DWM рендерит rounded corners на самом окне,
/// независимо от CSS content внутри WebView. На Win10 и ниже — no-op
/// (атрибут unsupported, вызов просто вернёт HRESULT error).
///
/// Raw FFI (вместо `windows` crate) — чтобы HWND type не конфликтовал
/// с версией, которую использует Tauri 2 internally: Tauri пригвождён
/// к конкретной windows-crate версии, а cross-version HWND types в
/// Rust считаются разными нарошно даже если ABI identical.
#[cfg(target_os = "windows")]
pub fn apply_win11_rounded_corners(win: &tauri::WebviewWindow) {
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attribute: u32,
            pv_attribute: *const core::ffi::c_void,
            cb_attribute: u32,
        ) -> i32;
    }
    const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
    const DWMWCP_ROUND: u32 = 2;

    if let Ok(hwnd) = win.hwnd() {
        // hwnd — это `windows::Win32::Foundation::HWND` от Tauri-bundled
        // crate. Унифицируем через raw isize — FFI signature выше
        // принимает именно isize, совместимо с любой HWND newtype
        // обёрткой (tuple struct HWND(isize)).
        let raw: isize = hwnd.0 as isize;
        unsafe {
            let pref: u32 = DWMWCP_ROUND;
            let _ = DwmSetWindowAttribute(
                raw,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn apply_win11_rounded_corners(_win: &tauri::WebviewWindow) {}

/// Tauri command: menu item clicked — dispatches the action and hides
/// the menu window. Called from src/tray-menu.tsx React code.
#[tauri::command]
pub fn tray_menu_action(app: tauri::AppHandle, action: String) {
    match action.as_str() {
        "connect" => tray_vpn_connect(app.clone()),
        "disconnect" => tray_vpn_disconnect(app.clone()),
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                w.show().ok();
                w.set_focus().ok();
            }
        }
        "quit" => {
            if let Some(state) = app.try_state::<AppState>() {
                crate::commands::kill_sidecar_from_state(&state);
            }
            app.exit(0);
        }
        _ => {}
    }
}

/// Current VPN status for tray-menu initial render (before listener
/// catches any vpn-status event). Derived from AppState.is_connected —
/// enough to pick Connect vs Disconnect button label.
#[tauri::command]
pub fn tray_menu_current_status(app: tauri::AppHandle) -> String {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(c) = state.is_connected.lock() {
            if *c {
                return "connected".into();
            }
        }
        if let Ok(d) = state.disconnecting.lock() {
            if *d {
                return "disconnecting".into();
            }
        }
    }
    "disconnected".into()
}

/// Current UI locale for tray-menu text.
#[tauri::command]
pub fn tray_menu_current_locale(app: tauri::AppHandle) -> String {
    get_locale(&app)
}

/// Can the user trigger VPN connect from tray? True если сохранён
/// config path (из AppState.config_path) или auto-detect найдёт файл.
/// False — «Подключиться» должен быть disabled: нечего подключать.
#[tauri::command]
pub fn tray_menu_has_config(app: tauri::AppHandle) -> bool {
    // Same resolution как в tray_vpn_connect — если здесь true,
    // значит clicked "Подключиться" реально подключит VPN.
    let stored = app.try_state::<AppState>()
        .and_then(|s| s.config_path.lock().ok().and_then(|g| g.clone()));
    if stored.is_some() {
        return true;
    }
    crate::commands::config::auto_detect_config().is_some()
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
