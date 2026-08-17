use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;

use tauri::Manager;
use tauri::Emitter;
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
            // F22 (14-UAT round 2): the tray toggle must match the Connection-tab buttons
            // (buttons.disconnect = «Отключить»), not the reflexive «Отключиться».
            if is_ru { "Отключить" } else { "Disconnect" },
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
        // `_` → «Отключен»/«Подключить» (неверный текст и действие).
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
            if is_ru { "Подключить" } else { "Connect" },
            true,
        ),
        _ => (
            if is_ru { "Отключен" } else { "Disconnected" },
            "connect",
            if is_ru { "Подключить" } else { "Connect" },
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
                // 3.4 R-DCT: teardown-in-progress counts as active (defense-in-depth; 3.3 serialization
                // makes a tray connect wait for the teardown, so status is Disconnected here).
                | VpnStatus::Disconnecting
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
        // No config found — show the window so user can configure.
        //
        // C-26 (round-2 audit fix): раньше мы только показывали окно — и
        // пользователь без конфига попадал на пустую/последнюю вкладку без
        // подсказки куда идти, чтобы установить сервер. Теперь СНАЧАЛА
        // отправляем navigation-событие `tray-navigate`, которое фронтенд
        // (useTrayNavigate) ловит и переводит на «Панель управления» — вход в
        // установку. Payload несёт ТОЛЬКО строку-цель навигации — никаких
        // учётных данных, никакого пути к конфигу (граница threat-model).
        // Зеркалит форму emit'а `deep-link-url` из lib.rs:66.
        app.emit("tray-navigate", serde_json::json!({ "target": "install" })).ok();
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

    // 3.6 F-TRAY (F10): mirror the tray connect to the window so its active-config pointer + hero
    // follow the config the tray actually connected, instead of a stale/reverted FE pointer (the
    // owner's "tray icon green while the tab shows all «Подключить» / no active card" split). Carries
    // origin + the config PATH only — paths already cross this boundary via the config commands; no
    // secret (D-29).
    app.emit(
        "vpn-flow",
        serde_json::json!({ "action": "connect", "origin": "tray", "configPath": config_path }),
    )
    .ok();

    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else { return; };

        // 3.3 R-SERIAL (F13/F14): serialize this tray connect body against vpn_connect / vpn_disconnect
        // and the tray disconnect twin (the shared lifecycle_flow mutex) so it cannot interleave with
        // an in-flight teardown. Held across the whole spawned body; dropped when the task ends.
        let flow = Arc::clone(&state.lifecycle_flow);
        let _flow_guard = flow.lock().await;

        // Fable R3 (MAJOR-A belt): re-check liveness INSIDE the lock, mirroring `vpn_connect`'s R8 guard
        // which sits AFTER its `_flow_guard` (vpn.rs:1191). The ENTRY guard (top of this fn) reads status
        // OUTSIDE `lifecycle_flow`, so between it passing and this body acquiring the lock a RIVAL connect
        // (a second tray click, or a window `vpn_connect`) can have gone live and released the lock.
        // Proceeding would then run a FULL second connect whose `kill_stale_sidecar` reads the PID file the
        // rival just wrote and force-kills the rival's LIVE child mid-handshake. If a session is already
        // active here, bail — the rival owns the adapter.
        {
            let status_now = *state.vpn_status.lock().unwrap_or_else(|e| e.into_inner());
            let session_active = matches!(
                status_now,
                VpnStatus::Connecting
                    | VpnStatus::Connected
                    | VpnStatus::Reconnecting
                    | VpnStatus::Recovering
                    | VpnStatus::Disconnecting
            );
            if session_active {
                crate::logging::log_app(
                    "INFO",
                    "[tray] a session went live while awaiting lifecycle_flow — aborting this duplicate tray connect (MAJOR-A belt)",
                );
                return;
            }
        }

        // Phase 19 UAT (G-19-2, all-entry-points): bump the connection generation HERE — right
        // after the in-lock liveness re-check (which already bailed on an active session, so there
        // is no bump-after-refuse) and BEFORE emit Connecting, the pre-connect ping await, and
        // kill_stale_sidecar + its 500ms sleep. The bump used to sit at the pre-spawn point (AFTER
        // kill_stale + the sleep), which was TOO LATE: a stale sidecar from a prior idle/failed
        // session, killed by kill_stale_sidecar, delivered its Terminated during the 500ms sleep
        // with `live == its captured generation`, so the F12 guard (terminated_arm_may_write_status)
        // let its non-zero exit write Error("sidecar-exit") onto this fresh Connecting — and the new
        // tray sidecar could never emit Connected through that stale Error (probe_task_may_emit gates
        // on Connecting/Reconnecting). Same root cause the window `vpn_connect` R8-block fix closes;
        // this is the tray entry point (owner rule: fix ALL paths to the same behaviour). Bumping
        // while holding the `sidecar_child` lock orders it before the reader task's Terminated
        // owns-check, which re-acquires that lock before it reads the live generation. `connect_
        // generation` (post-bump) is used for the connect-timeout watchdog / supervisor below.
        // (The FAB-R4 stamp is separately reset below; a tray connect never bails on it.)
        let connect_generation;
        {
            let _slot = state
                .sidecar_child
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            connect_generation =
                state.connection_generation.fetch_add(1, Ordering::SeqCst) + 1;
        }

        // Fable R3 (MAJOR-A): emit `Connecting` FIRST — BEFORE the pre-connect ping probe below. The probe
        // eats its FULL 1.5s timeout on an unreachable endpoint, and it used to run while status was still
        // `Disconnected` → up to 1.5s of ZERO feedback (grey tray icon, menu still «Подключить») AND an
        // extended window where an impatient second «Подключить» click passes the entry R8 guard (which
        // reads status OUTSIDE `lifecycle_flow`) and queues a full second connect. Staging the ping is only
        // read by the FAR-LATER Connected edge (`maybe_fire`, after spawn + handshake), so emitting
        // Connecting first still lands the ping before Connected — while collapsing the guard window back
        // to ~ms and giving instant feedback.
        set_vpn_status(&app, &state, VpnStatus::Connecting, None);

        // F23 (14-UAT round 2): stage the config's DIRECT pre-connect ping so the connect notification
        // shows a REAL number, not «—». A tray-initiated connect never set it (the window paths push it
        // from the FE, the tray path runs entirely in Rust), so the plate rendered «—» on every tray
        // connect. The endpoint is still DISCONNECTED here (the tunnel comes up only when the sidecar
        // spawns below), so a direct probe measures the real RTT — the SAME reachability ping the cards
        // use (SSRF-safe, D-29: never the password). Bounded 1.5s; any non-ok result stages None → the
        // plate keeps the honest «—». Done SYNCHRONOUSLY before the tunnel comes up so it is set before
        // the Connected edge `maybe_fire` reads it — no race, no leak into the next connect.
        let tray_connect_ping: Option<u32> =
            match crate::commands::ping::ping_config_endpoint(config_path.clone(), 1500).await {
                Ok(crate::commands::ping::PingResult::Ok { ms }) => Some(ms as u32),
                _ => None,
            };
        if let Ok(mut g) = state.pending_connect_ping.lock() {
            *g = tray_connect_ping;
        }

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
        // AUDIT-2026-06-11 #3: also clear the DURABLE user-disconnect intent, exactly
        // like `vpn_connect` does (T-31 contract: set by a disconnect, cleared by the
        // NEXT connect — on EVERY connect entry point). Without this a tray-started
        // session ran with a stale `true` from an earlier window disconnect, and the
        // reconnect supervisor's very first intent check aborted to a forced
        // Disconnected on the first drop — i.e. tray sessions silently lost ALL
        // auto-reconnect.
        state.user_disconnect_requested.store(false, Ordering::SeqCst);
        // FAB-R4 (Fable-5 review of Phase 14) — CONSUME the switch-authorized stamp on
        // this connect entry point too. A tray «Подключиться» is a fresh user-initiated
        // connect, NOT a switch destination, so it must NEVER bail on the stamp — but a
        // stamp left alive by an aborted switch (whose `vpn_connect(B)` never ran, so it
        // never consumed the stamp) must not survive PAST this connect into a later
        // `vpn_connect` and false-bail it. Resetting the stamp to the sentinel here makes
        // that leftover harmless (mirrors the consume-once reset `vpn_connect` performs at
        // its guard read). `swap` to keep it a single atomic op.
        state
            .switch_authorized_generation
            .swap(u64::MAX, Ordering::SeqCst);

        // CR-03: the connection-generation bump moved UP (Phase 19 UAT G-19-2) — to right after
        // the in-lock liveness re-check, BEFORE kill_stale_sidecar + the 500ms sleep — so a
        // superseded child's late Terminated is suppressed by F12 (see the long note above). It
        // still neutralizes a stale reconnect supervisor from a previous session (the Codex HIGH
        // stale-actor guard), just earlier; `connect_generation` was captured there. Mirror of the
        // window `vpn_connect` R8-block fix and of Light's tray path.

        let child_arc = Arc::clone(&state.sidecar_child);
        let disc_arc = Arc::clone(&state.disconnecting);

        let sidecar_log_level = match log_level.as_str() {
            "error" | "warn" => "info",
            other => other,
        };

        // AUDIT-2026-06-11 #5 / FIX-A (RC-2): snapshot the pre-VPN system DNS before the
        // tunnel comes up, mirroring `vpn_connect` (same direct sync calls in an async
        // body). The C++ sidecar flips system DNS on connect and is always hard-killed,
        // so without a baseline taken HERE a tray-started session has nothing to restore
        // on teardown — the machine stays pointed at the dead tunnel resolver. The
        // snapshot is self-guarded against overwriting an existing baseline, so a
        // reconnect can never capture the tunnel resolver as "pre-VPN".
        crate::dns_guard::snapshot_system_dns();
        crate::dns_guard::flush_dns_cache();

        // Egress guard — MUST mirror vpn_connect (a tray-started session is a full connect, so
        // without this a tray user on a machine with a foreign virtual adapter would still fail).
        let egress_override = crate::net_egress::override_for_connect(&config_path)
            .map(|p| p.to_string_lossy().into_owned());

        // F-6: map the non-Send `Box<dyn StdError>` spawn error to a Send `String` BEFORE the match.
        // The Ok arm's new cancel-re-check kill (`kill_sidecar(child).await`) is an await point, and a
        // `match` keeps the scrutinee temporary (the whole Result, incl. its non-Send Err) alive
        // across the arm body — so without this the spawned task's future is no longer `Send`.
        let spawn_config_path = egress_override.as_deref().unwrap_or(config_path.as_str());
        let spawn_result = sidecar::spawn_trusttunnel(&app, spawn_config_path, sidecar_log_level, child_arc, disc_arc, connect_generation)
            .await
            .map_err(|e| e.to_string());
        match spawn_result {
            Ok(child) => {
                eprintln!("[tray_vpn_connect] Sidecar spawned OK (PID {})", child.child.pid());
                // 3.3 F-6 (Fable-5): mirror vpn_connect's #19 post-spawn cancel re-check on the tray
                // path. `spawn_trusttunnel` is async; a tray/window disconnect can land (and complete)
                // WHILE the spawn is in flight — and even under the 3.3 lock the tray-DISCONNECT twin's
                // intent preamble + child-take run OUTSIDE the lock, so it can set the durable intent +
                // take None while THIS connect still holds the lock. Without this re-check the fresh
                // child is stored anyway → a live sidecar behind a Disconnected status (a zombie the
                // probe/watchdog then suppress, killed only by the next connect's stale-sweep). On
                // cancel: mark the kill intentional, kill the fresh child, write Disconnected, don't
                // store. Placed BEFORE save_sidecar_pid so the PID file never records a child we tear
                // down immediately.
                if crate::commands::vpn::connect_cancelled(
                    state.disconnecting.lock().map(|g| *g).unwrap_or(false),
                    state.user_disconnect_requested.load(Ordering::SeqCst),
                ) {
                    crate::logging::log_app(
                        "INFO",
                        "[tray] cancel observed after spawn — killing fresh child, not storing it (F-6, mirrors #19)",
                    );
                    if let Ok(mut d) = child.disconnecting.lock() { *d = true; }
                    sidecar::kill_sidecar(child).await.ok();
                    set_vpn_status(&app, &state, VpnStatus::Disconnected, None);
                    if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
                    return;
                }
                // 3.6 F-TRAY: save the PID file for crash-cleanup fallback, exactly like vpn_connect
                // does — this was the drift Fable found: a tray-started session had NO PID-file sweep,
                // so a crash between spawn and app-death could leave an orphan the next launch missed.
                crate::commands::vpn::save_sidecar_pid(child.child.pid());
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
/// 13-06: теперь ЖИВОЙ вызов — применяется к OPAQUE notification-plate окну в
/// `lib.rs .setup()`, чтобы round-corners без transparency обошли #13859 (transparent
/// Win11 dark window рендерится чёрным). Изначально был шаблоном для custom-webview
/// tray (native-only per CLAUDE.md); тот сценарий остаётся заблокированным #13859, но
/// сам DWM-шим здесь и переиспользуется плитой уведомления.
#[cfg(target_os = "windows")]
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
            // 3.4 R-DCT: teardown-in-progress is now a real wire status — surface it directly
            // (supersedes the `disconnecting` bool fallback below, kept as a legacy backstop).
            VpnStatus::Disconnecting => return "disconnecting".into(),
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

    // 3.6 F-TRAY (F10/F11): mirror the tray disconnect to the window at the START of the teardown so a
    // config switch in flight ABORTS its FE settle-park WITHOUT a revert (the user's disconnect wins —
    // no stuck amber, no phantom «остались на A» notice) and the window shows the teardown truthfully.
    // Origin only — no path, no secret (D-29).
    app.emit(
        "vpn-flow",
        serde_json::json!({ "action": "disconnect", "origin": "tray" }),
    )
    .ok();

    // AUDIT-2026-06-11 #2: mirror `vpn_disconnect`'s intent preamble UNCONDITIONALLY,
    // BEFORE the child slot is even inspected. Previously ALL bookkeeping (including
    // `disconnecting=true`) lived inside `if let Some(child)`, so a tray cancel during
    // a supervisor respawn gap was either a silent no-op or left no durable trace —
    // and the supervisor's next pre-attempt intent check happily reconnected against
    // the user's explicit cancel (the exact T-31 double-press bug, on the tray path).
    if let Ok(mut d) = state.disconnecting.lock() { *d = true; }
    // T-31: raise the DURABLE user-disconnect intent. Unlike the transient
    // `disconnecting` (cleared at the end of the task below — WR-01), this stays set
    // until the next connect, so a supervisor that re-reads intent AFTER this
    // disconnect completes still aborts instead of flipping the session back on.
    state.user_disconnect_requested.store(true, Ordering::SeqCst);
    // Codex HIGH stale-actor guard: bump the generation so any in-flight
    // connect-timeout watchdog / supervisor attempt from the session being torn down
    // sees a mismatch and neutralizes itself (mirrors `vpn_disconnect`). 3.3 F-5 (Fable-5): CAPTURE
    // the post-bump generation so the spawned task's DNS/hosts/status tail can re-check it — the
    // preamble + child-take run OUTSIDE the lock, so a vpn_connect(B) that WINS the lock race can
    // store a live B before this tail runs; the guard stops us from tearing B's state down.
    let teardown_generation = state.connection_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let child = {
        // Poison-recovery instead of the old `else { return; }`: bailing here AFTER
        // the preamble above would leave `disconnecting` latched true forever.
        let mut guard = state
            .sidecar_child
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    // Captured before `child` moves into the task: the empty-slot path gates its
    // status write on the live status (see below), the kill path keeps the
    // unconditional Disconnected write it always had.
    let had_child = child.is_some();

    if let Some(ref child) = child {
        if let Ok(mut d) = child.disconnecting.lock() { *d = true; }

        // WR-06 / 3.4 R-DCT: kill_sidecar can take seconds (graceful wait + confirm-exit poll). The
        // tray icon AND the window are driven by vpn-status events, and previously no event fired
        // until the kill completed — so the UI kept showing the previous (e.g. green "connected")
        // state during the whole teardown while the menu text already said "Отключение...". Emit the
        // REAL `Disconnecting` wire status now (was an out-of-band `update_tray_icon` hack that only
        // moved the icon, leaving the window stale — F10 mechanism #1): the single mutator drives BOTH
        // the icon (via the status→icon handler) and the window truthfully. Kill path only; the
        // empty-slot path below writes Disconnected promptly, so a settled Error is never masked.
        set_vpn_status(&app, &state, VpnStatus::Disconnecting, None);
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        // 3.3 R-SERIAL (F13/F14): serialize this tray teardown against vpn_connect / vpn_disconnect and
        // the tray connect twin (shared lifecycle_flow) so the kill cannot interleave with a connect.
        // The preamble above already ran (fast sync cancel + generation bump); this gates the actual
        // kill. OwnedMutexGuard so it is held for the whole 'static task; if AppState is gone, proceed
        // ungated (best-effort teardown — a stuck lock must never strand a disconnect).
        let _flow_guard = match app_clone.try_state::<AppState>() {
            Some(state) => Some(Arc::clone(&state.lifecycle_flow).lock_owned().await),
            None => None,
        };
        if let Some(child) = child {
            // D-08 lifecycle marker (8): sidecar killed on exit (tray quit path) —
            // fixed phrase, DEV-gated (D-11). Our own child C_A — killing it is idempotent (a
            // newer session's stale-sweep may have already reaped it), so it is safe to run
            // regardless of the generation guard below.
            sidecar::emit_killed_on_exit_marker(&app_clone);
            sidecar::kill_sidecar(child).await.ok();
        }
        // Re-look up state inside the 'static task and route through the mutator.
        if let Some(state) = app_clone.try_state::<AppState>() {
            // 3.3 F-5 (Fable-5): the preamble + child-take ran OUTSIDE the lock, so a vpn_connect(B)
            // that was already in flight can WIN this lock race — sweep C_A, reset the intent flags,
            // and store a live B — before this tail runs. If a NEWER session now owns the shared
            // state, restoring DNS / clearing hosts / writing Disconnected here would tear down B's
            // LIVE tunnel behind a "disconnected" UI (DNS restore under B's killswitch = no-DNS).
            // Re-check the generation bumped in the preamble: on mismatch SKIP the state-owning
            // teardown entirely — B's own connect owns the DNS/hosts/status now, and B's own later
            // teardown will restore them. (B's connect also already reset `disconnecting=false`.)
            let live_gen = state.connection_generation.load(Ordering::SeqCst);
            if !crate::lifecycle::is_current_generation(teardown_generation, live_gen) {
                // R2-4 (Fable-5 re-review): normally the newer session owns the DNS/hosts (its own
                // connect applied them; its later teardown restores them), so we skip. BUT if that
                // newer connect's SPAWN FAILED it left NO live child AND never restored the pre-VPN
                // DNS — the machine would stay on the dead tunnel resolver until the next user action.
                // So when the newer session has no live child, restore DNS here (safe: no tunnel to
                // break). Still skip the status write — the newer session owns vpn_status.
                let newer_has_live_child = state
                    .sidecar_child
                    .lock()
                    .map(|g| g.is_some())
                    .unwrap_or(false);
                if !newer_has_live_child {
                    crate::dns_guard::restore_system_dns();
                }
                crate::logging::log_app(
                    "INFO",
                    "[tray] disconnect superseded by a newer session — skipping status teardown (F-5/R2-4)",
                );
                return;
            }
            // AUDIT-2026-06-11 #7: cleanup runs even when the child slot was empty — a tray cancel
            // mid-respawn / mid-recovery must still tear the session down (the supervisor's T-31
            // Aborted branch handles any in-flight respawn). Moved INSIDE the state block so the
            // generation guard above covers it (F-5): DNS/hosts belong to whichever session is live.
            routing_rules::cleanup_hosts_block().ok();
            // AUDIT-2026-06-11 #5 / FIX-A (RC-2): restore the pre-VPN system DNS, exactly like
            // `vpn_disconnect`. The hard-killed sidecar never restores it itself.
            crate::dns_guard::restore_system_dns();
            // AUDIT-2026-06-11 #7: on the empty-slot path only write Disconnected
            // when the session is genuinely active (the supervisor/recovery states a
            // tray «Отмена» is cancelling). A settled Disconnected/Error stays put —
            // overwriting a terminal Error here would erase its reason for nothing.
            // R2-1 (Fable-5 re-review): `Disconnecting` is ACTIVE here too — when a rapid twin tray
            // disconnect already wrote «Отключение» and THIS surviving actor's slot is empty, the
            // settling Disconnected must still be written, else the wire strands on «Отключение».
            let write_disconnected = had_child || {
                let status_now = *state
                    .vpn_status
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                matches!(
                    status_now,
                    VpnStatus::Connecting
                        | VpnStatus::Connected
                        | VpnStatus::Reconnecting
                        | VpnStatus::Recovering
                        | VpnStatus::Disconnecting
                )
            };
            if write_disconnected {
                set_vpn_status(&app_clone, &state, VpnStatus::Disconnected, None);
            }
            // WR-01: clear the process-wide `disconnecting` intent flag after the
            // disconnect completes (mirrors `vpn_disconnect`). The sidecar's
            // Terminated arm already read `was_intentional == true` DURING the
            // `kill_sidecar` above, so resetting after the final Disconnected
            // status write cannot trigger a spurious reconnect. This prevents a
            // stale `true` from outliving the tray-initiated disconnect — and per
            // AUDIT-2026-06-11 #2/#7 it now runs on the empty-slot path too, so the
            // unconditional preamble can never strand the flag.
            if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
        } else {
            // AppState gone (app shutting down): best-effort cleanup, nothing to gate or write.
            routing_rules::cleanup_hosts_block().ok();
            crate::dns_guard::restore_system_dns();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Phase 19 (19-01, Bug 1 / D-04) — lock the status→tray-icon bucket mapping that the
    // gray-on-acknowledge chain depends on. When the desktop error plate's × acknowledges
    // (`clear_vpn_error` → `Error → Disconnected` → `vpn-status` emit → lib.rs listener →
    // `update_tray_icon("disconnected")`), the icon MUST land in the gray `"off"` bucket, never
    // stay in the red `"error"` bucket. `status_bucket` is the pure function that decides this;
    // pinning its mapping here is the automated proof of the D-04 "gray, not stuck red" contract
    // (the live-tray render is the Manual-Only item — the bucket math is what makes it correct).

    #[test]
    fn status_bucket_maps_error_to_the_red_bucket() {
        // A live connection error → the dedicated red shield glyph (02-22 redesign).
        assert_eq!(status_bucket("error"), "error");
    }

    #[test]
    fn status_bucket_maps_disconnected_to_the_gray_off_bucket() {
        // D-04: the post-acknowledge status is `disconnected`; it must resolve to the gray
        // `"off"` bucket so the tray icon turns gray the moment the error is acknowledged —
        // never left red. This is the exact bucket the acknowledge chain drives the icon into.
        assert_eq!(status_bucket("disconnected"), "off");
    }

    #[test]
    fn status_bucket_never_leaves_a_non_error_status_in_the_red_bucket() {
        // Guard the D-04 invariant across every non-error status: only a genuine `error` may
        // land in the red bucket. A stuck-red tray after a non-error transition is exactly the
        // bug this phase fixes — so no non-error status may ever map to `"error"`.
        for status in [
            "connected",
            "connecting",
            "reconnecting",
            "recovering",
            "disconnected",
            "disconnecting",
            "unknown-future-status",
        ] {
            assert_ne!(
                status_bucket(status),
                "error",
                "non-error status {status:?} must never resolve to the red bucket",
            );
        }
    }
}
