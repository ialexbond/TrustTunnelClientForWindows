use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;

use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::image::Image;

use crate::commands::{AppState, kill_stale_sidecar};
use crate::commands::vpn::{VpnStatus, set_vpn_status, spawn_connect_timeout_watchdog};
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

/// Normalize a VPN status to the 4 tray-icon buckets (02-22 redesign — solid
/// color-coded shield glyphs, see new_icon_design):
/// - `connected`  → 🟢 zelyonyy — tunnel up
/// - `reconnect`  → 🟡 zhyoltyy — ВСЕ активные состояния: `connecting` (первый
///   коннект), `reconnecting` («Переподключение», re-establish после обрыва) и
///   `recovering` («Восстановление», ждём возврата локальной сети). Жёлтый =
///   «что-то происходит, работаем».
/// - `error`      → 🔴 krasnyy — терминальная ошибка (собственный красный glyph)
/// - `off`        → ⚪ seryy — `disconnected` / `disconnecting` / unknown
///
/// ОТЛИЧИЕ от Stage 3 (02-20): раньше `recovering` сидел в отдельном красном
/// bucket'е вместе с `error`. По новому дизайну пользователя у `error` свой
/// красный shield, а `recovering` объединён с остальными «активными» статусами
/// в жёлтый `reconnect`. Иконки теперь СТАТИЧНЫЕ (без пульса) — это просто
/// цветовой код состояния, см. `update_tray_icon`.
fn status_bucket(status: &str) -> &'static str {
    match status {
        "connected" => "connected",
        "connecting" | "reconnecting" | "recovering" => "reconnect",
        "error" => "error",
        // disconnected | disconnecting | unknown
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
        // 🔴 RED bucket — терминальная ошибка. Собственный красный shield glyph
        // (02-22 redesign): пользователь сгенерировал tray-{dark,light}-error-32.png
        // из своего .ico. Раньше (Stage 3) красного PNG не было — был placeholder на
        // жёлтый reconnect-asset; теперь это настоящие красные иконки.
        ("error", "light")     => include_bytes!("../icons/tray/tray-light-error-32.png"),
        ("error", _)           => include_bytes!("../icons/tray/tray-dark-error-32.png"),
        (_, "light")           => include_bytes!("../icons/tray/tray-light-off-32.png"),
        (_, _)                 => include_bytes!("../icons/tray/tray-dark-off-32.png"),
    };
    Image::from_bytes(bytes).expect("Failed to load tray icon PNG")
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
        // 02-20 status-UX split: «Переподключение» (re-establish туннеля) и
        // «Восстановление» (ждём локальную сеть) — теперь РАЗНЫЕ статусы. Раньше
        // единый recovering показывал «Переподключение…»; теперь у каждого свой
        // ярлык. Toggle во время обоих — «Отмена» (можно прервать ожидание/ретрай,
        // см. 02-STATUS-SPEC.md §4). Без отдельной ветки `reconnecting` падал бы в
        // `_` → «Отключен»/«Подключиться» (неверный текст и действие).
        "reconnecting" => (
            if is_ru { "Переподключение..." } else { "Reconnecting..." },
            "disconnect",
            if is_ru { "Отмена" } else { "Cancel" },
            true,
        ),
        "recovering" => (
            if is_ru { "Восстановление..." } else { "Recovering..." },
            "disconnect",
            if is_ru { "Отмена" } else { "Cancel" },
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
/// Иконка СТАТИЧНАЯ — это просто цветовой код состояния (02-22 redesign):
/// 🟢 connected, 🟡 reconnect (все активные: connecting/reconnecting/recovering),
/// 🔴 error, ⚪ off. Пульсация (мерцание 550ms из Stage 3) убрана — пользователь
/// заменил indicator-стиль на solid color-coded shield glyphs, для которых
/// мерцание не нужно: цвет shield'а сам по себе сообщает состояние.
pub fn update_tray_icon(app: &tauri::AppHandle, status: &str) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let system_theme = detect_windows_system_theme().to_string();

        // Всегда статичная иконка — bucket резолвится из status в load_tray_icon.
        // `disconnecting` (WR-06, FE-local transient, D-09) попадает в off bucket.
        tray.set_icon(Some(load_tray_icon(status, &system_theme))).ok();

        let locale = get_locale(app);
        let is_ru = locale == "ru";
        // 02-20 status-UX split: `recovering` и `reconnecting` теперь РАЗНЫЕ статусы.
        // Раньше единый «recovering» показывал «Переподключение…» — теперь:
        //   recovering   → «Восстановление…» (ждём возврата локальной сети),
        //   reconnecting → «Переподключение…» (re-establish туннеля).
        // Без отдельной ветки `reconnecting` падал в `_` → «Отключен» (неверно).
        let tooltip = match status {
            "connected" => if is_ru { "TrustTunnel Pro — Подключен" } else { "TrustTunnel Pro — Connected" },
            "connecting" => if is_ru { "TrustTunnel Pro — Подключение..." } else { "TrustTunnel Pro — Connecting..." },
            "reconnecting" => if is_ru { "TrustTunnel Pro — Переподключение..." } else { "TrustTunnel Pro — Reconnecting..." },
            "recovering" => if is_ru { "TrustTunnel Pro — Восстановление..." } else { "TrustTunnel Pro — Recovering..." },
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

    // R8 / WR-02: refuse a connect ONLY when a session is genuinely live. A bare
    // `guard.is_some()` was the same unsafe presence-only check R8 removed from the command
    // path: a STALE `Some` (a supervisor that gave up before R3, or a respawned child that
    // died without a clean Terminated) made the tray «Подключиться» silently no-op until
    // the app was restarted. Refuse only when the status is active; otherwise the handle is
    // stale → take + kill it and proceed (mirrors vpn_connect's R8 guard).
    {
        let status_now = *state.vpn_status.lock().unwrap_or_else(|e| e.into_inner());
        let session_active = matches!(
            status_now,
            VpnStatus::Connecting
                | VpnStatus::Connected
                | VpnStatus::Reconnecting
                | VpnStatus::Recovering
        );
        if let Ok(mut guard) = state.sidecar_child.lock() {
            if guard.is_some() {
                if session_active {
                    return;
                }
                if let Some(child) = guard.take() {
                    child.child.kill().ok();
                }
                crate::logging::log_app(
                    "WARN",
                    "[tray] stale sidecar handle on an idle/failed session — cleared it and proceeding with connect (R8/WR-02)",
                );
            }
        }
    }

    // Get config path: stored from last connect, or auto-detect
    let config_path = state.config_path.lock().ok()
        .and_then(|g| g.clone())
        .or_else(crate::commands::config::auto_detect_config);

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

        // Emit connecting status through the single mutator (STATUS-02).
        set_vpn_status(&app, &state, VpnStatus::Connecting, None);

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

        // CR-03: bump the connection generation so THIS tray-started session owns a
        // distinct number, exactly like `vpn_connect` does. Without this bump a stale
        // reconnect supervisor from a previous session is NOT neutralized by a
        // tray-initiated connect (the Codex HIGH stale-actor guard was bypassed on
        // the tray path) — the old supervisor could still fire and kill/respawn over
        // the tray-started session. `fetch_add` returns the PRE-increment value, so
        // the captured generation for this session is that + 1. Mirror of Light's
        // tray path.
        let connect_generation =
            state.connection_generation.fetch_add(1, Ordering::SeqCst) + 1;

        let child_arc = Arc::clone(&state.sidecar_child);
        let disc_arc = Arc::clone(&state.disconnecting);

        let sidecar_log_level = match log_level.as_str() {
            "error" | "warn" => "info",
            other => other,
        };

        match sidecar::spawn_trusttunnel(&app, &config_path, sidecar_log_level, child_arc, disc_arc).await {
            Ok(child) => {
                eprintln!("[tray_vpn_connect] Sidecar spawned OK (PID {})", child.child.pid());
                if let Ok(mut guard) = state.sidecar_child.lock() {
                    *guard = Some(child);
                }
                set_vpn_status(&app, &state, VpnStatus::Connecting, None);

                // CR-03: arm the same 60s connect-timeout watchdog `vpn_connect` uses,
                // so a tray-started session that never completes the handshake escapes
                // "Connecting…" to an honest Error instead of hanging forever (D-05).
                // Generation-guarded with the value captured above.
                spawn_connect_timeout_watchdog(&app, connect_generation);
            }
            Err(e) => {
                eprintln!("[tray_vpn_connect] Failed: {e}");
                // e is a derived spawn error string, not a credential (D-29).
                set_vpn_status(&app, &state, VpnStatus::Error, Some(e.to_string()));
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
///
/// Dead reference per CLAUDE.md «Tray menu = native only» — Tauri issue
/// #13859 блокирует custom webview tray-menu в dark theme Win11. Оставлено
/// для возможного восстановления если upstream issue будет закрыт.
#[allow(dead_code)]
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
///
/// Dead reference per CLAUDE.md «Tray menu = native only» — оставлено как
/// шаблон для восстановления custom-webview tray, если Tauri issue #13859
/// будет закрыт.
#[cfg(target_os = "windows")]
#[allow(dead_code)]
pub fn apply_win11_rounded_corners(win: &tauri::WebviewWindow) {
    #[link(name = "dwmapi")]
    unsafe extern "system" {
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
#[allow(dead_code)]
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
                // R4: signal shutdown (intent + generation bump) before the kill so a
                // live reconnect supervisor can't respawn a sidecar after the user quit.
                crate::commands::begin_shutdown(&state);
                crate::commands::kill_sidecar_from_state(&state);
            }
            app.exit(0);
        }
        _ => {}
    }
}

/// Current VPN status for tray-menu initial render (before listener
/// catches any vpn-status event). Reads the single `vpn_status` owner (D-01)
/// instead of the legacy bool — enough to pick Connect vs Disconnect button label.
///
/// The `disconnecting` fallback is kept: "disconnecting" is a FE-local transient
/// label that the Rust enum never carries (D-09), so when `vpn_status` is still
/// `Disconnected` but the user just hit disconnect, the tray shows the transitional
/// label. Command NAME + `String` return are unchanged (frontend caller untouched).
#[tauri::command]
pub fn tray_menu_current_status(app: tauri::AppHandle) -> String {
    if let Some(state) = app.try_state::<AppState>() {
        let status = state
            .vpn_status
            .lock()
            .map(|g| *g)
            .unwrap_or(VpnStatus::Disconnected);
        match status {
            VpnStatus::Connected => return "connected".into(),
            VpnStatus::Connecting => return "connecting".into(),
            VpnStatus::Error => return "error".into(),
            // 02-20 status-UX split: surface the TRUE state from the tray-webview
            // snapshot so a tray menu opened mid-recovery/mid-reconnect shows the right
            // label, not the disconnected fallback and not a merged one. Each maps to
            // its OWN canonical wire string. The tray bucket/label refinement (yellow
            // for "reconnecting", red for "recovering") is Stage 3 of 02-20; this
            // backend mapping only keeps the strings honest + the build green here.
            VpnStatus::Recovering => return "recovering".into(),
            VpnStatus::Reconnecting => return "reconnecting".into(),
            VpnStatus::Disconnected => {}
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

        // WR-06: kill_sidecar can take seconds (it force-runs taskkill). The tray
        // icon is driven only by vpn-status events, and no event fires until the
        // kill completes — so without this the icon would keep showing the previous
        // (e.g. green "connected") state while the menu text already says
        // "Отключение...". Proactively move the icon to the "disconnecting"
        // (reconnect bucket) so icon and menu agree during the kill. No visible
        // vocabulary change (D-09): "disconnecting" is the existing FE-local
        // transient label, not a new backend status — vpn_status stays untouched.
        update_tray_icon(&app, "disconnecting");

        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            // D-08 lifecycle marker (8): sidecar killed on exit (tray quit path) —
            // fixed phrase, DEV-gated (D-11).
            sidecar::emit_killed_on_exit_marker(&app_clone);
            sidecar::kill_sidecar(child).await.ok();
            routing_rules::cleanup_hosts_block().ok();
            // Re-look up state inside the 'static task and route through the mutator.
            if let Some(state) = app_clone.try_state::<AppState>() {
                set_vpn_status(&app_clone, &state, VpnStatus::Disconnected, None);
                // WR-01: clear the process-wide `disconnecting` intent flag after the
                // disconnect completes (mirrors `vpn_disconnect`). The sidecar's
                // Terminated arm already read `was_intentional == true` DURING the
                // `kill_sidecar` above, so resetting after the final Disconnected
                // status write cannot trigger a spurious reconnect. This prevents a
                // stale `true` from outliving the tray-initiated disconnect.
                if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
            }
        });
    }
}
