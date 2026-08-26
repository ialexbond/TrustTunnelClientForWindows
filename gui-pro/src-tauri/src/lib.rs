mod app_settings;
mod autostart;
mod commands;
mod connectivity;
mod diagnostics;
mod dns_guard;
mod geodata;
mod geodata_scheduler;
mod geodata_v2ray;
mod job_object;
mod lifecycle;
mod logging;
pub mod notify;
mod processes;
mod routing_rules;
mod net_egress;
mod sidecar;
pub mod ssh;
mod tray;

use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::Emitter;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::image::Image;
use tauri::RunEvent;

use commands::{AppState, begin_shutdown, kill_sidecar_from_state};

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

/// Marker for the one-time "the app keeps running in the tray" hint.
///
/// Sits in `portable_data_dir()` — which IS the exe's own directory, the same place the configs,
/// logs and dns snapshot live (the NSIS installer is per-user, into LocalAppData, so this is
/// writable without admin). An earlier version of this comment claimed the data dir was separate
/// from the exe dir; it is not.
///
/// Scope of the guarantee: the hint is shown once and never again for as long as this directory
/// survives. An installer that wipes the install directory would let it appear one more time —
/// acceptable, since the point is to stop nagging on every LAUNCH, which is what actually happened.
fn tray_hint_marker() -> std::path::PathBuf {
    ssh::portable_data_dir().join("tray_hint_shown")
}

/// Has the tray hint already been shown to this user, ever?
fn tray_hint_already_shown() -> bool {
    tray_hint_marker().exists()
}

/// Record that the tray hint was shown, so it never appears again on a later launch.
fn mark_tray_hint_shown() {
    let path = tray_hint_marker();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, "1");
}

/// Phase 13 (D-04) — restore the main window from the tray and hide the notification plate.
///
/// Invoked by the plate's BODY click: show + focus the main window (reusing the EXACT tray "show"
/// path used elsewhere in this file — `get_webview_window("main").show()+set_focus()`), then hide
/// the plate so the two windows stay in step. The × close path does NOT call this (it only hides
/// the plate), so a dismiss never brings the window forward.
///
/// Phase 13 (13-09, Fix 2) — after showing the window, ALSO steer the FE to the Connection tab.
/// The plate is a CONNECTION notification, so a body-click should land the user on the Connection
/// section — not on whatever tab they were last on. We emit `navigate-to-tab` with the tab id the
/// FE App uses (`"connection"`); App listens via `useNavigateToTab` and switches the active tab.
/// The payload carries ONLY a bare tab-id string — no config content, no credentials (D-29). Emit
/// AFTER show/focus so the window is already up when the tab switch lands. The × path does NOT call
/// this, so a dismiss neither restores the window nor navigates.
#[tauri::command]
fn restore_main_window(app: tauri::AppHandle) {
    // Shared restore path (tray::restore_main_window_to_front): show + unminimize + focus. The old
    // show()+set_focus() pair left a MINIMIZED window minimized — on Windows such a window still
    // reports is_visible() == true, so nothing here noticed — and the plate click appeared to do
    // nothing but blink the taskbar button.
    tray::restore_main_window_to_front(&app);
    if let Some(p) = app.get_webview_window("notification") {
        p.hide().ok();
    }
    // Steer the FE to the Connection tab (the notification is about the connection). A bare tab-id
    // string only — no secret crosses (D-29). Emitted after the window is shown so the switch lands
    // on an already-visible window.
    app.emit("navigate-to-tab", "connection").ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the global panic hook FIRST — before Tauri builder runs.
    // Any panic from this point on (including during Tauri init / setup)
    // is routed through log_app + the default handler. See logging.rs
    // §install_panic_hook for rationale and audit reference (M-627-01).
    logging::install_panic_hook();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second instance launched — bring the existing window to the user. Shared restore
            // path: show + unminimize + focus. Launching the app again while it sat minimized must
            // produce a window on screen, not a second no-op (a minimized Windows window reports
            // is_visible() == true, so a bare show() is a no-op for it).
            tray::restore_main_window_to_front(app);
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
            // tray-menu — auto-sized popup, сохранять его size/position
            // нельзя: persisted state переопределяет tauri.conf.json
            // при следующем запуске (объясняет «работает только после
            // полного uninstall» — window-state.json хранит stale
            // размеры от предыдущей установки).
            //
            // notification — Phase 13 desktop-notification plate. Built at runtime in
            // .setup() (NOT from tauri.conf.json) and repositioned bottom-right of the
            // work area on every fire, so persisting its size/position would restore stale
            // geometry that fights the runtime placement — deny it for the same reason.
            .with_denylist(&["tray-menu", "notification"])
            .build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(AppState {
            sidecar_child: Arc::new(Mutex::new(None)),
            disconnecting: Arc::new(Mutex::new(false)),
            // Phase 1 — single source of truth for VPN status (D-01). Starts Disconnected.
            vpn_status: Arc::new(Mutex::new(commands::vpn::VpnStatus::Disconnected)),
            // Phase 1 (Codex MEDIUM) — last error detail persisted alongside vpn_status
            // so a late-mounting window can restore the reason, not just the status.
            last_error: Arc::new(Mutex::new(None)),
            tray_notified: Arc::new(Mutex::new(false)),
            config_path: Arc::new(Mutex::new(None)),
            pending_error_config_name: Arc::new(Mutex::new(None)),
            log_level: Arc::new(Mutex::new("info".to_string())),
            locale: Arc::new(Mutex::new("ru".to_string())),
            // Phase 17: benchmark cancel channel (None = no benchmark running)
            benchmark_cancel_tx: Arc::new(tokio::sync::Mutex::new(None)),
            // 3.3 R-SERIAL — the lifecycle-command serializer mutex (starts unlocked). Held for the
            // whole body of vpn_connect / vpn_disconnect + the tray twins so a connect cannot
            // interleave with an in-flight teardown (F13/F14).
            lifecycle_flow: Arc::new(tokio::sync::Mutex::new(())),
            // Phase 17 UAT 2026-05-20: MTProto install cancel flag (false = no install running / not cancelled)
            mtproto_install_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // Phase 18 Plan 05 — sidecar update cancel flag (REQ-18-UPDATE-FLOW-07)
            update_sidecar_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // Phase 2 — connection generation (Codex HIGH stale-actor guard). Starts at 0;
            // each connect/disconnect bumps it so a stale connect-timeout watchdog aborts.
            connection_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            // Phase 2 — single-supervisor guard (CR-02). Starts false; the reconnect
            // supervisor sets it while live so the Terminated arm cannot spawn a second.
            reconnect_in_progress: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // Phase 2 Plan 09 (UAT Gap #2) — per-attempt pre-flight connectivity result.
            // Starts false; vpn_connect sets it on every attempt before spawning so the
            // sidecar Terminated arm can classify a never-connected exit (no-internet vs
            // sidecar-exit). The pre-flight is warning-only and never blocks connecting.
            last_preflight_offline: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // T-31 — durable user-disconnect intent. Starts false; set true by
            // vpn_disconnect and cleared by the next vpn_connect, so a user disconnect
            // wins over an in-flight auto-reconnect (no flip back to Connected).
            user_disconnect_requested: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // Phase 13 (D-06) — master notifications gate mirror. Starts `true` (the D-06
            // locked default) so the Rust firing gate is correct BEFORE the FE's startup
            // mirror push lands — a safe pre-seed that silences nothing the user did not
            // silence. The FE overwrites it via set_notifications_enabled on toggle AND
            // once at startup; notify::maybe_fire reads THIS mirror (never localStorage,
            // which is not shared across webview windows — Pitfall 5) so the gate holds
            // with the main window closed to tray.
            notifications_enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            // Phase 13 (Pitfall 2) — pending connect origin the next Connected consumes.
            // Starts Manual; the FE sets it to AutoSwitch / AutoConnectLaunch right before
            // an auto action, and notify::maybe_fire resets it back to Manual after the
            // connected so it marks only the one intended auto action.
            pending_connect_origin: Arc::new(Mutex::new(notify::ConnectOrigin::Manual)),
            // Phase 13 (13-08b) — the pending connect-time ping (ms) the next Connected consumes
            // for the plate's detail block. Starts None; the FE pushes the config's known
            // reachability ping (measured while the config was still inactive) via
            // set_pending_connect_ping right before each connect, and notify::maybe_fire reads +
            // consumes it on the Connected edge (like the origin). None → the plate shows «—». This
            // replaces the fresh connect-time ping of the ACTIVE endpoint, which read Unreachable
            // BY DESIGN (a direct TCP connect to a tunnel-internal IP fails while connected).
            pending_connect_ping: Arc::new(Mutex::new(None)),
            // Phase 13 (BL-01/WR-01) — a compound switch/reconnect teardown is in flight.
            // Starts false; the FE raises it before switchTo/handleReconnect's teardown-
            // disconnect so notify::maybe_fire suppresses the intermediate «Отключено», and
            // both the FE and maybe_fire clear it on the destination terminal outcome.
            switch_or_reconnect_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // F17 (14-UAT round 2) — the FE mirrors its whole-switch-window isSwitching here so
            // maybe_fire (and, via the FE ref, the disconnect snackbars) stay silent across a
            // seamless switch+revert. Starts false; the FE owns its lifecycle (never cleared Rust-side).
            seamless_switch_active: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // Part B (cancel notification) — the FE-raised user-cancel intent the next terminal
            // Disconnected consumes to fire «Подключение отменено» instead of «Отключено». Starts
            // false; the FE raises it via set_pending_cancel(true) when handleUserCancel aborts an
            // in-flight connect, and notify::maybe_fire reads + consumes it on the Disconnected edge.
            pending_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            // FAB-R4 (Fable-5 review of Phase 14) — the connection_generation stamped when a
            // config switch is authorized (the isSwitch:true edge of
            // set_switch_or_reconnect_pending). u64::MAX = "no switch authorized"; lets
            // vpn_connect tell the switch's OWN teardown advance from a genuine tray disconnect
            // in the teardown→connect gap so an explicit «Отключить» is not erased. Starts at the
            // no-switch sentinel.
            switch_authorized_generation: Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX)),
            // Phase 13 (13-05) — staged pending plate for the pull-model redelivery. None until
            // the first fire; maybe_fire stages the latest {kind, config_name} before its emit and
            // the plate pull-and-clears it once its listener attaches, so a fire that beat the
            // plate's mount is redelivered instead of leaving an empty black window (UAT test-1).
            pending_plate: Arc::new(Mutex::new(None)),
            // Phase 13 (13-06) — the plate's effective theme mirror. Starts "dark" (the :root token
            // fallback) so the plate looks correct BEFORE the FE's startup mirror push lands. useTheme
            // pushes the effective "dark"/"light" via set_plate_theme on change AND once at startup;
            // notify::maybe_fire includes it in the emitted payload so the plate applies the right
            // data-theme (its own webview has an empty localStorage — Pitfall 5).
            plate_theme: Arc::new(Mutex::new("dark".to_string())),
            // Phase 13 (13-07) — the plate's UI language mirror. Starts "ru" (the app's primary
            // language, matching the previously-hardcoded copy) so the plate is correct BEFORE the
            // FE's startup mirror push lands. useLanguage pushes "ru"/"en" via set_plate_language on
            // change AND once at startup; notify::maybe_fire includes it in the payload so the plate
            // picks the right-language copy (its own webview has an empty localStorage — Pitfall 5).
            plate_language: Arc::new(Mutex::new("ru".to_string())),
        })
        .manage(Arc::new(geodata_v2ray::GeoDataState::new()))
        .manage(ssh::SshPool::new())
        .setup(|app| {
            // Initialize file logging (if enabled via flag file)
            logging::init_logging();
            // Initialize activity log (always active, fire-and-forget from UI)
            commands::activity_log::init_activity_log();

            // FIX-A (RC-2): crash-sweep. If the previous session hard-died without
            // restoring system DNS, the machine is still pointing at the dead tunnel
            // resolver (Claude Code 403 until restart). Restore the snapshot now.
            dns_guard::sweep_stale_dns_on_startup();

            // Egress guard: drop leftover throwaway connect-override copies from previous sessions.
            // Their only reader (that session's sidecar) is long gone, and they carry the endpoint
            // password, so nothing should outlive the session that wrote it.
            net_egress::sweep_stale_overrides();

            // T-44: the same argument, one directory over. Builds shipped BEFORE the phase-25
            // cleanup left their «Скачать конфиг» exports — password-bearing — in the OS temp dir,
            // and those never self-heal under a login the user does not download again. Detached
            // thread, unlike the sweeps above, because this one enumerates %TEMP% (see
            // `spawn_stale_staged_config_sweep`); it must not sit in front of the window.
            commands::config::spawn_stale_staged_config_sweep();

            // Owner bug 2026-08-26: an installer run (upgrade / uninstall-first reinstall) deletes
            // the HKCU Run autostart value, silently undoing the user's «Запуск вместе с системой»
            // choice. The choice now persists in app_settings.json; put the Run entry back when it
            // was wiped while that choice says ON. Sub-millisecond (one file read + one registry
            // probe), so it runs inline like the sweeps above.
            autostart::reconcile_autostart_on_startup(app.handle());

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
                    // Same shared restore path as every other reveal route, so a launch can never
                    // produce a window that is "shown" but minimized (the window-state plugin does
                    // not persist MINIMIZED today, but nothing here should depend on that).
                    tray::restore_main_window_to_front(app.handle());
                }
            }

            // Open devtools in release builds
            #[cfg(feature = "devtools")]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            // Build native tray context menu (OS-standard popup).
            let tray_menu = tray::build_tray_menu(app.handle(), "disconnected")?;

            // Load disconnected tray icon (red) as initial state
            let initial_icon = tray::load_tray_icon("disconnected", tray::detect_windows_system_theme());

            // Create tray icon with ID so we can update it later.
            //
            // Native Windows context menu через `.menu(&tray_menu)` —
            // рендерится OS, выглядит как standard system popup. Left
            // click оставляем для toggle main window (custom); right
            // click показывает native menu автоматически.
            TrayIconBuilder::with_id("main-tray")
                .icon(initial_icon)
                .tooltip("TrustTunnel Pro — Отключен")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        // Shared restore path — show + unminimize + focus (see
                        // tray::restore_main_window_to_front): «Показать» must always land a
                        // window the user can actually see, never a still-minimized one.
                        "show" => tray::restore_main_window_to_front(app),
                        "connect" => {
                            tray::tray_vpn_connect(app.clone());
                        }
                        "disconnect" => {
                            tray::tray_vpn_disconnect(app.clone());
                        }
                        "quit" => {
                            if let Some(state) = app.try_state::<AppState>() {
                                // R4: signal shutdown (intent + generation bump) BEFORE
                                // the kill so a live reconnect supervisor cooperatively
                                // bails and can't respawn a sidecar after the user quit.
                                begin_shutdown(&state);
                                kill_sidecar_from_state(&state);
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click Up → toggle the main window (Telegram-style):
                    // hidden OR minimized → restore to the front; genuinely on
                    // screen → hide to the tray. The predicate reads visible +
                    // minimized and deliberately IGNORES focus — clicking the
                    // tray icon itself takes focus off the main window, so a
                    // focused check was always false and broke the toggle
                    // (always show, never hide). See tray::decide_tray_click.
                    //
                    // Right click — native menu показывается OS автоматом
                    // (потому что `.menu(&tray_menu)` задано выше).
                    // Никакого custom handler не нужен.
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            // A MINIMIZED Windows window still reports is_visible() == true, so
                            // visibility alone cannot tell "on screen" from "minimized" — the
                            // decision needs both flags. tray::decide_tray_click owns it (and
                            // documents why focus stays out of the predicate).
                            //
                            // unwrap_or fallbacks: if a flag cannot be read, treat the window as
                            // hidden and not minimized → restore. Showing a window the user asked
                            // for is the safe failure; hiding one they wanted to see is not.
                            let visible = w.is_visible().unwrap_or(false);
                            let minimized = w.is_minimized().unwrap_or(false);
                            match tray::decide_tray_click(visible, minimized) {
                                tray::TrayClick::HideToTray => {
                                    let _ = w.hide();
                                }
                                tray::TrayClick::RestoreToFront => {
                                    tray::restore_main_window_to_front(tray.app_handle())
                                }
                            }
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

            // Phase 13 — build the desktop connection-notification plate window ONCE, hidden.
            // It is shown/hidden (never rebuilt) per VPN status change by notify::maybe_fire,
            // which repositions it bottom-right of the work area first. Flags (Research Pattern 1):
            //   - decorations(false)   — frameless plate (no titlebar/border)
            //   - transparent(false)   — OPAQUE: transparent Win11 windows render black in dark
            //                            theme (#13859, the bug that killed the custom tray-menu)
            //   - always_on_top(true)  — floats over other windows like an OS toast
            //   - skip_taskbar(true)   — never in the taskbar / Alt+Tab
            //   - focused(false)       — do NOT steal focus on show (non-activating)
            //   - resizable(false), shadow(false), visible(false) — fixed, built hidden
            //   - inner_size(360, 68)  — sized to the Storybook design's content height (360×67 for a
            //     2-line title+body; +1 so the 1px border is not clipped) so the plate FILLS the window
            //     with no «подложка». The plate content top-aligns (items-start); a rare 3-line wrap
            //     (a very long config name) is the only case that would clip — acceptable vs a taller
            //     window that would show empty space under short 2-line plates.
            // Build failures must not abort startup (the plate is non-critical), so log-and-continue.
            match tauri::WebviewWindowBuilder::new(
                app,
                "notification",
                tauri::WebviewUrl::App("notification.html".into()),
            )
            .decorations(false)
            .transparent(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .inner_size(360.0, 68.0)
            .build()
            {
                Ok(notification_win) => {
                    // 13-06 (UAT round-2 defect 2 — the "black square"): the plate is OPAQUE
                    // (transparent(false) — a transparent Win11 dark window renders black, #13859, an
                    // OS won't-fix), so ConnectionToast's CSS rounding/border/shadow are invisible
                    // against the same-coloured opaque window body and the plate reads as a hard
                    // rectangle. Give the WINDOW itself native Win11 rounded corners via DWM
                    // (DwmSetWindowAttribute / DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND) instead of
                    // enabling transparency — this rounds the opaque window without hitting #13859.
                    // Reuses the existing `tray::apply_win11_rounded_corners` helper (the same
                    // #13859-era DWM rounding shim, previously dead-code), which is best-effort
                    // (log-and-continue: a failed DWM call leaves square corners but never aborts
                    // startup — rounded corners are purely cosmetic). Windows-only (the app is
                    // Windows-only); the non-Windows stub is a no-op.
                    tray::apply_win11_rounded_corners(&notification_win);
                }
                Err(e) => {
                    eprintln!("[notify] failed to build notification plate window: {e}");
                }
            }

            // Phase 13 (D-06 / §C) — master notifications gate SEED ORDER.
            //
            // The gate mirror (`AppState.notifications_enabled`) is already pre-seeded to `true`
            // (the D-06 locked default) at `.manage(AppState{…})` above — a SAFE default: it
            // silences nothing the user did not silence, so a fire before the FE mirror lands is
            // correct-by-default. The LIVE value comes from the FE: `useAppSettings` reads
            // `tt_notifications_enabled` and pushes it once on mount via `set_notifications_enabled`
            // (Task 2). We deliberately do NOT read localStorage here in Rust — it lives only in the
            // main webview and is not reachable from the backend (Pitfall 5); the FE mirror push is
            // the single source that reconciles the pre-seed to the persisted value. Seed order is
            // therefore: (1) AppState default `true` (compile-time), (2) FE startup mirror push
            // (runtime, right after the main webview mounts) — so the only window where the gate
            // could differ from the persisted value is the sub-second before the FE mounts, during
            // which no VPN transition has fired yet.

            // Start connectivity monitor — reads the single vpn_status owner (D-01)
            let vpn_status_for_monitor = Arc::clone(&app.state::<AppState>().vpn_status);
            connectivity::start_monitor(app.handle().clone(), vpn_status_for_monitor);

            // Start geodata file watcher
            let geodata_state = app.state::<Arc<geodata_v2ray::GeoDataState>>().inner().clone();
            geodata_v2ray::start_geodata_watcher(app.handle().clone(), geodata_state);

            // Phase 23 (D-10/D-11) — start the window-independent geodata update loop. It replaces
            // the 30-minute `setInterval` that lived inside a React component and therefore only
            // ran while the Routing tab was mounted. A SECOND clone of the managed Arc is taken
            // here because the first one was moved into the watcher above.
            let geodata_state_for_scheduler =
                app.state::<Arc<geodata_v2ray::GeoDataState>>().inner().clone();
            let vpn_status_for_geodata = Arc::clone(&app.state::<AppState>().vpn_status);
            let config_path_for_geodata = Arc::clone(&app.state::<AppState>().config_path);
            // CR-01: the scheduler's re-resolve writes the SAME five resolved rule files the C++
            // core opens at spawn, so it must hold the same serializer the three lifecycle callers
            // (vpn_connect, the supervised respawn, the tray connect) already hold. Passing the
            // shared `lifecycle_flow` Arc is what makes the D-01 gate enforceable rather than
            // merely checked — see `geodata_scheduler::apply_if_safe`.
            let lifecycle_flow_for_geodata = Arc::clone(&app.state::<AppState>().lifecycle_flow);
            geodata_scheduler::start_geodata_scheduler(
                app.handle().clone(),
                geodata_state_for_scheduler,
                vpn_status_for_geodata,
                config_path_for_geodata,
                lifecycle_flow_for_geodata,
            );

            // Busy-flag relay. The scheduler holds no `AppHandle` on purpose (D-04 — with no handle
            // in scope it cannot grow a progress bar nobody asked for), so it cannot tell the UI
            // that a write is in flight. It only flips a process-wide flag; THIS task owns the
            // handle and turns each flip into one `geodata-busy` event.
            //
            // What it buys: the card's download button is disabled while any geodata write runs,
            // including a background one. Previously the button stayed enabled through the whole
            // background download and answered a click with GEODATA_ALREADY_UPDATING — an
            // explanation after the fact instead of a control that cannot be pressed.
            //
            // Not a D-04 breach: no notification, snackbar, badge or progress is produced. The one
            // event carries a bool and only ever disables an existing control.
            let busy_relay_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    // FAB-01: register the waiter BEFORE reading the flag. `notify_waiters()` stores
                    // no permit, so a flip that lands between the read and the next park vanishes —
                    // and if the lost flip is the `false` one, the card's button stays disabled with
                    // nothing the user can click to fix it, until the next flip up to a day later.
                    // The offline case makes this easy to hit: the cycle can fail in single-digit
                    // milliseconds, so `true` and `false` arrive almost together.
                    //
                    // Same idiom as the scheduler's wake future (`geodata_scheduler.rs`), for the
                    // same reason. Pinned + enabled so the registration happens now, not at the
                    // first poll of the await below.
                    let mut flipped = std::pin::pin!(geodata_v2ray::update_busy_notified());
                    flipped.as_mut().enable();
                    busy_relay_handle
                        .emit("geodata-busy", geodata_v2ray::is_update_in_flight())
                        .ok();
                    flipped.await;
                }
            });

            // SOCKS5 client mode was removed — the app is TUN-only. Convert any legacy on-disk
            // config that still declares `[listener.socks]` to a full-tunnel `[listener.tun]`
            // now, at startup: BEFORE the fs-watcher below (so the list loads normalized) and
            // while no VPN session is live (so it never races the connectivity monitor / FAB-05
            // switch logic). Idempotent — TUN-only configs are not rewritten.
            commands::config::normalize_all_configs_to_tun();

            // IN-31: watch the config data dir so the «Подключение» list refreshes the instant a
            // config .toml is added/removed on disk (e.g. deleted in the file manager).
            commands::manifest::start_configs_watcher(app.handle().clone());

            // Deep-link URL protocol wiring (C-22 / D-14). A clicked tt:// /
            // trusttunnel:// link must reach the app no matter HOW it arrives.
            // Three arrival channels all funnel into ONE `deep-link-url` event so
            // the frontend needs only a single listener:
            //   (a) single-instance arg — a second launch with a tt:// arg already
            //       emits `deep-link-url` (see plugin handler ~L64-67 above);
            //   (b) protocol-handler launcher — writes `.pending_deeplink` next to
            //       the exe (protocol.rs:40-48), drained by `poll_pending_deeplink`
            //       on the frontend and at startup here;
            //   (c) cold start launched BY the link — the file is written before
            //       the window mounts, so we drain it here at startup too.
            //
            // (1) Register the HKCU-only scheme DIRECTLY on the app exe (no admin / no UAC).
            //     A clicked tt:// link then prompts «Открыть TrustTunnel Client Pro?», NOT
            //     «Открыть Windows PowerShell?» (06-uat — the old powershell handler read as
            //     malware). Always overwrites so legacy installs migrate off the powershell
            //     command. Fire-and-forget + best-effort: a registration failure must NEVER
            //     block startup.
            std::thread::spawn(|| {
                let _ = commands::protocol::register_url_protocols();
            });
            // (2) Cold start launched BY the link: the URL is in OUR argv (the direct-exe
            //     handler passed "%1"). Stage it in .pending_deeplink so the frontend's
            //     startup poll (useDeepLinkImport channel 2) drains it once its listener is
            //     attached — avoiding the emit-before-listener race. Warm start (an already-
            //     running instance) is handled by the single-instance handler (~L64), which
            //     emits `deep-link-url` directly. The URL is untrusted external input — it is
            //     only carried to the frontend; it is NOT decoded/validated until the user
            //     clicks «Импортировать» (decode_deeplink, the trusted boundary). Never
            //     logged (D-29).
            let _ = commands::protocol::capture_cold_start_deeplink();

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
                        // Rebuild tray menu with new language, current status.
                        // Reads the single vpn_status owner (D-01).
                        use commands::vpn::VpnStatus;
                        let status = app_handle2.try_state::<AppState>()
                            .map(|s| {
                                let status = s.vpn_status.lock().map(|g| *g).unwrap_or(VpnStatus::Disconnected);
                                match status {
                                    VpnStatus::Connected => "connected",
                                    VpnStatus::Connecting => "connecting",
                                    // 3.4 R-DCT: teardown-in-progress is now a real wire status.
                                    VpnStatus::Disconnecting => "disconnecting",
                                    VpnStatus::Error => "error",
                                    // 02-20 status-UX split: a language change mid-recovery
                                    // or mid-reconnect must keep the TRUE state's icon/menu,
                                    // not collapse to "disconnected" nor merge the two. Each
                                    // maps to its OWN canonical string tray.rs
                                    // (status_bucket/build_tray_menu/update_tray_icon)
                                    // understands. Stage 3 (02-20) gives "reconnecting" its
                                    // yellow bucket and "recovering" its red bucket.
                                    VpnStatus::Recovering => "recovering",
                                    VpnStatus::Reconnecting => "reconnecting",
                                    VpnStatus::Disconnected => "disconnected",
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
            // Auto-hide кастомного tray-menu окна при потере фокуса —
            // эмулируем обычное поведение OS context menu (клик вне →
            // закрыть). JS-side listener tauri://blur не всегда
            // срабатывает на Windows, поэтому ловим здесь.
            if window.label() == "tray-menu" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
                // tray-menu не должен проходить через блоки ниже
                // (dblclick, CloseRequested-to-tray) — они для main window.
                return;
            }

            // Блок dblclick-to-maximize / fullscreen на титлбаре.
            // maximizable:false в config блокирует системную кнопку
            // maximize, но не double-click на data-tauri-drag-region —
            // тот попадает в WebView-обработчик до того как OS сверится
            // с флагом. Ловим событие Resized → если окно стало
            // maximized/fullscreen — немедленно откатываем.
            if let tauri::WindowEvent::Resized(_) = event {
                if let Ok(true) = window.is_maximized() {
                    let _ = window.unmaximize();
                }
                if let Ok(true) = window.is_fullscreen() {
                    let _ = window.set_fullscreen(false);
                }
            }
            // Minimize to tray on close instead of quitting
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();

                // One-time hint that closing the window does NOT quit the app.
                //
                // It used to be gated on `tray_notified` alone — an in-memory flag that resets on
                // every launch, so the toast reappeared after each restart. A user who has seen it
                // once already knows; repeating it forever is nagging. The memory flag is kept as a
                // cheap short-circuit (no filesystem hit on subsequent closes in the same run), and
                // a marker file makes the "already told them" fact survive restarts.
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let mut notified = state.tray_notified.lock().unwrap_or_else(|e| e.into_inner());
                    if !*notified {
                        *notified = true;
                        if !tray_hint_already_shown() {
                            mark_tray_hint_shown();
                            // Localized, not hardcoded Russian: an English user was shown Russian
                            // here. Same bilingual pattern the tray menu uses (tray::get_locale).
                            let app = window.app_handle();
                            let is_ru = tray::get_locale(app) == "ru";
                            use tauri_plugin_notification::NotificationExt;
                            app.notification()
                                .builder()
                                .title("TrustTunnel Pro")
                                .body(if is_ru {
                                    "Приложение свёрнуто в трей. Нажмите на иконку, чтобы открыть."
                                } else {
                                    "The app is minimized to the tray. Click the icon to reopen."
                                })
                                .show()
                                .ok();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Custom tray context menu (otdel'noe tray-menu window)
            tray::tray_menu_action,
            tray::tray_menu_current_status,
            tray::tray_menu_current_locale,
            tray::tray_menu_has_config,
            tray::tray_menu_reposition,
            set_start_minimized,
            get_start_minimized,
            // Phase 13 — desktop connection-notification plate: body-click → restore main + hide plate (D-04)
            restore_main_window,
            // Phase 13 — master notifications gate mirror (D-06) + auto-vs-manual origin (Pitfall 2).
            // The FE pushes the toggle + the pending origin so notify::maybe_fire gates/labels the
            // plate window-closed. Both carry only a bool / a small enum — no config content (D-29).
            commands::vpn::set_notifications_enabled,
            commands::vpn::set_pending_connect_origin,
            commands::vpn::set_pending_connect_ping,
            commands::vpn::set_switch_or_reconnect_pending,
            commands::vpn::set_seamless_switch_active,
            // Part B (cancel notification) — the FE mirrors its user-cancel intent so maybe_fire fires
            // «Подключение отменено» instead of «Отключено» on a cancelled in-flight connect (D-29: bool only).
            commands::vpn::set_pending_cancel,
            commands::vpn::set_plate_theme,
            // Phase 13 (13-07) — mirror the app UI language ("ru"/"en") so the plate copy follows it.
            commands::vpn::set_plate_language,
            // Phase 13 (13-05) — the plate pull-and-clears a fire that beat its listener (read-and-
            // clear, mirroring poll_pending_deeplink) so no empty black plate persists at launch.
            notify::pull_pending_plate,
            // F15 (14-UAT round 2) — the FE measures the plate's content height and asks Rust to
            // resize the notification window to fit (dynamic plate sizing; custom command, no per-
            // command capability needed — mirrors pull_pending_plate).
            notify::resize_notification_plate,
            logging::set_logging_enabled,
            logging::get_logging_enabled,
            logging::open_logs_folder,
            commands::vpn::vpn_connect,
            commands::vpn::vpn_disconnect,
            commands::vpn::check_vpn_status_full,
            commands::vpn::clear_vpn_error,
            commands::vpn::test_sidecar,
            commands::ssh_commands::deploy_server,
            commands::ssh_commands::cancel_deploy,
            commands::ssh_commands::diagnose_server,
            commands::ssh_commands::forget_ssh_host_key,
            ssh::confirm_host_key,
            commands::ssh_commands::save_ssh_credentials,
            commands::ssh_commands::load_ssh_credentials,
            commands::ssh_commands::load_ssh_credentials_for,
            commands::ssh_commands::clear_ssh_credentials,
            commands::ssh_commands::clear_ssh_credentials_for,
            commands::ssh_commands::check_process_conflict,
            commands::ssh_commands::kill_existing_process,
            commands::config::copy_file,
            // CR-01: the credential-cleanup half of the Users-tab download — removes the
            // password-carrying config that fetch_server_config staged in %TEMP%.
            commands::config::delete_staged_temp_file,
            commands::config::write_string_to_path,
            commands::config::copy_config_to_app_dir,
            commands::config::auto_detect_config,
            commands::config::import_dropped_content,
            commands::config::config_file_exists,
            commands::config::watch_config_file,
            commands::config::unwatch_config_file,
            commands::config::read_client_config,
            commands::config::save_client_config,
            // Phase 11 — multi-config manifest (configs.json) mutation funnel + safe
            // startup migration. Registered here in the foundation plan (11-02) so no
            // later Wave-2/3 plan needs to edit lib.rs for manifest ops.
            commands::manifest::migrate_configs,
            commands::manifest::list_configs,
            commands::manifest::summarize_config,
            commands::manifest::add_config,
            commands::manifest::delete_config,
            commands::manifest::duplicate_config,
            commands::manifest::rename_config,
            commands::manifest::set_last_used,
            // Phase 12 (Plan 12-02) — persist the «Авто-режим» priority order (D-02 / D-05)
            // through the SAME atomic manifest funnel (lock + temp+fsync+rename). The engine
            // reads this order on the next tick; last-used still leads via list_configs sort.
            commands::manifest::reorder_configs,
            // Phase 11 (Plan 11-03) — per-config endpoint-reachability ping. Reads
            // host:port Rust-side from the config's own .toml (path-validated, host
            // whitelist-validated); a bounded TCP connect, independent of the VPN core.
            // Named ping_config_endpoint to avoid colliding with the existing
            // network::ping_endpoint(host, port) used by the Control Panel.
            commands::ping::ping_config_endpoint,
            // F11 (17-review): `probe_tunnel_latency` (F23) was DELETED — PA-2 retired the
            // through-tunnel probe from the auto-switch decision, leaving 0 frontend callers, so
            // its registration is removed here (any lingering webview invoke would otherwise still
            // fire outbound TCP probes). Mirrors the earlier check_vpn_status removal.
            commands::ssh_commands::check_server_installation,
            commands::ssh_commands::uninstall_server,
            // Phase 18 (UN-2, plan 18-05): pooled read of the pre-install snapshot evidence
            // (D-06/D-07) so the uninstall dialog can gate the package-purge checkboxes.
            commands::ssh_commands::read_server_snapshot,
            // Phase 18 (18-10): pooled read of the install/enable ownership markers so the
            // uninstall dialog can offer ufw/fail2ban-package + BBR removal on a LEGACY server.
            commands::ssh_commands::read_server_ownership_markers,
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
            // Phase 15 (Configuration tab) — vpn.toml + hosts.toml mutations
            commands::ssh_commands::server_get_config_bundle,
            commands::ssh_commands::server_write_vpn_toml_raw,
            commands::ssh_commands::server_save_config_file,
            commands::ssh_commands::server_update_hosts_allowed_sni,
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
            // Phase 16 — SSH-key feature (D-1.1..D-2.3)
            commands::ssh_commands::security_generate_ssh_key,
            commands::ssh_commands::security_get_ssh_key_status,
            commands::ssh_commands::security_export_ssh_key_backup,
            commands::ssh_commands::security_import_ssh_key,
            commands::ssh_commands::load_ssh_key_for_host,
            commands::ssh_commands::security_get_pubkey_for_recovery,
            // Phase 16 — Disable PasswordAuth + Certbot Timer (D-2.2 + D-5.3)
            commands::ssh_commands::security_disable_password_auth,
            // Phase 16 P0-3 #E — re-enable PasswordAuth (rollback companion)
            commands::ssh_commands::security_enable_password_auth,
            commands::ssh_commands::server_get_certbot_timer_status,
            commands::ssh_commands::server_enable_certbot_timer,
            commands::ssh_commands::server_verify_certbot_renewal,
            commands::ssh_commands::mtproto_install,
            commands::ssh_commands::mtproto_cancel_install,
            commands::ssh_commands::mtproto_get_status,
            commands::ssh_commands::mtproto_uninstall,
            commands::ssh_commands::mtproto_start,
            commands::ssh_commands::mtproto_stop,
            // Phase 18 — sidecar atomic-swap update flow (Plan 18-05, REQ-18-UPDATE-FLOW-03..07)
            commands::ssh_commands::update_sidecar,
            commands::ssh_commands::cancel_update_sidecar,
            commands::ssh_commands::detect_bbr_status,
            commands::ssh_commands::enable_bbr,
            commands::ssh_commands::disable_bbr,
            // Phase 17 — Server Benchmark IP.Check.Place (streaming)
            commands::ssh_commands::server_run_benchmark,
            commands::ssh_commands::server_cancel_benchmark,
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
            geodata_v2ray::geodata_update_in_flight,
            geodata_v2ray::load_geodata_categories,
            // Phase 23 (D-12) — the persisted, Rust-side geodata auto-update toggle. It lives in
            // the backend rather than localStorage because the scheduler must read it with no
            // window open.
            app_settings::get_geodata_auto_update,
            app_settings::set_geodata_auto_update,
            app_settings::get_failover_settings,
            app_settings::set_failover_settings,
            // Owner bug 2026-08-26 — autostart moved behind plain commands (see autostart.rs):
            // the registry write and the persisted choice now travel together, and the row became
            // mockable through `invoke` like every other settings row (the 28-06 harness trap is
            // structurally gone for it).
            autostart::get_autostart,
            autostart::set_autostart,
            routing_rules::load_routing_rules,
            routing_rules::save_routing_rules,
            routing_rules::export_routing_rules,
            routing_rules::import_routing_rules,
            routing_rules::migrate_legacy_exclusions,
            routing_rules::resolve_and_apply,
            routing_rules::update_vpn_mode,
            routing_rules::cleanup_hosts_block,
            processes::list_running_processes,
            // Phase 24 (D-01) — real Windows application icons for the process filter. Separate
            // from list_running_processes on purpose: the picker must open instantly, so icons are
            // fetched afterwards. Takes process NAMES only and derives paths from its own
            // snapshot — a path-accepting signature would hand the webview an arbitrary-file
            // icon-read primitive.
            processes::get_process_icons,
            // Phase 24 (D-01 + D-04) — the ONE command in the app that resolves an icon from a
            // caller-supplied path. It exists because a program the user picked off the disk in
            // the file dialog is usually not running, so the name-based command above can never
            // resolve it. The dialog is only where the path comes from — nothing on this side can
            // verify a string ever passed through it — so what actually narrows the surface is the
            // command's own guard: a plain local-drive path to an .exe, checked before any
            // filesystem access, plus a drive-type check that refuses a network mapping. The
            // command above stays strictly name-only. Two surfaces, so the dangerous one is
            // separately auditable.
            processes::get_process_icon_for_path,
            commands::network::ping_endpoint,
            commands::network::health_check,
            // T-22 B3 (boot guard): network-readiness probe for auto-connect-on-launch
            commands::network::network_ready,
            commands::history::record_session_start,
            commands::history::record_session_end,
            commands::history::get_connection_history,
            commands::history::clear_connection_history,
            commands::network::speedtest_run,
            commands::geoip::get_server_geoip,
            commands::updater::self_update,
            // Phase 18 — dual update detection (REQ-18-UPDATE-DETECTION-01..02)
            commands::updater::check_sidecar_version,
            commands::updater::check_app_update_info,
            // Phase 19 — sidecar version listing for dropdown (REQ-19-LIST-VERSIONS-CMD)
            commands::updater::list_sidecar_versions,
            commands::deeplink::decode_deeplink,
            commands::deeplink::import_config_from_string,
            commands::deeplink::read_config_file_for_import,
            // Phase 15 — local (non-SSH) QR deeplink export from a stored config (D-01/D-03)
            commands::deeplink_local::export_config_deeplink_local,
            commands::protocol::register_url_protocols,
            commands::protocol::check_url_protocols,
            commands::protocol::poll_pending_deeplink,
            commands::activity_log::write_activity_log,
            commands::activity_log::export_activity_log,
            // Phase 14.1 — advanced user config
            commands::ssh_commands::server_add_user_advanced,
            commands::ssh_commands::server_update_user_config,
            commands::ssh_commands::server_rotate_user_password,
            commands::ssh_commands::server_regenerate_client_prefix,
            commands::ssh_commands::server_fetch_endpoint_cert,
            commands::ssh_commands::server_export_config_deeplink_advanced,
            commands::ssh_commands::server_get_user_config,
            // M-01 — Custom SNI autocomplete
            commands::ssh_commands::server_get_allowed_sni_list,
            // FIX-NN — server-side TLV persistence
            commands::ssh_commands::server_get_user_advanced,
            commands::ssh_commands::server_list_user_advanced,
            commands::ssh_commands::server_reconcile_users_advanced,
            commands::ssh_commands::server_set_user_advanced,
            commands::ssh_commands::server_delete_user_advanced,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // R4 (quit hang): signal shutdown FIRST so a live reconnect supervisor /
                // monitor can't respawn a sidecar during teardown (idempotent if the
                // quit menu handler already did it; other exit paths reach here directly).
                if let Some(state) = app.try_state::<AppState>() {
                    begin_shutdown(&state);
                }
                // Disconnect pooled SSH connection — BOUNDED. `pool.invalidate()` awaits a
                // graceful SSH disconnect with no internal timeout; on a half-dead socket
                // (plausible in an error state) the old unbounded `block_on` froze the main
                // thread and the app would not close (UAT 65692c test 7). Quit is teardown,
                // so a missed graceful disconnect is harmless — cap it at 2s.
                if let Some(pool) = app.try_state::<ssh::SshPool>() {
                    tauri::async_runtime::block_on(async {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(2),
                            pool.invalidate(),
                        )
                        .await;
                    });
                }
                // Final cleanup: kill only our own sidecar (not other app's processes)
                if let Some(state) = app.try_state::<AppState>() {
                    kill_sidecar_from_state(&state);
                }
                // AUDIT-2026-06-11 #10: the hard-killed sidecar never runs its own DNS
                // teardown (see dns_guard.rs header), so quit-while-connected used to leave
                // the whole machine pointing at the dead tunnel resolver until the NEXT
                // launch's sweep_stale_dns_on_startup. Restore here, AFTER the kill so the
                // sidecar can't re-set DNS behind us. No-op when no snapshot exists — safe
                // on every exit. Tray «Выйти» (tray.rs "quit") ends in app.exit(0), which
                // also dispatches RunEvent::Exit, so this single call covers that path too.
                dns_guard::restore_system_dns();
                // Flush pending log entries before exit
                logging::shutdown_logging();
                // Clean up hosts file blocked entries
                routing_rules::cleanup_hosts_block().ok();
            }
        });
}
