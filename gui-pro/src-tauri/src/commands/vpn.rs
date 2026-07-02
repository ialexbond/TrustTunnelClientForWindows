use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::sidecar;
use crate::routing_rules;
use crate::geodata_v2ray::GeoDataState;
use crate::ssh;

/// The single source of truth for VPN connection status (D-01).
///
/// First serde-tagged enum in the tree — `rename_all = "lowercase"` makes each
/// variant serialize to the exact wire string the `"vpn-status"` event already
/// uses, so introducing the typed owner does not touch the cross-process contract
/// ({status, error}) that the main window, tray webview and Rust `listen_any`
/// consume. The round-trip test in this file locks that mapping (RESEARCH A1).
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VpnStatus {
    Disconnected,
    Connecting,
    Connected,
    /// LOCAL-NETWORK loss (02-20 status-UX split). «Восстановление» — there is no
    /// physical adapter at all (Ethernet unplugged / Wi-Fi off), so there is nothing
    /// to (re)connect to yet; the connectivity monitor WAITS for the adapter to
    /// return (`await_adapter_recovery`) rather than burning the bounded reconnect
    /// attempts. Wire string `"recovering"` — the SAME token the frontend, tray and
    /// snapshots already speak, so the local-net case keeps its existing string.
    ///
    /// Until 02-20 a SINGLE `Reconnecting` variant served BOTH this local-net wait
    /// AND the tunnel re-establish, collapsing two semantically distinct states onto
    /// one wire string ("recovering"). The split below (`Recovering` vs
    /// `Reconnecting`) lets the UI show «Восстановление» (red, waiting for the net)
    /// apart from «Переподключение» (yellow, actively re-establishing the tunnel).
    /// The serde round-trip test locks BOTH wire strings so a future rename cannot
    /// drift the cross-process consumers (T-08-01).
    #[serde(rename = "recovering")]
    Recovering,
    /// TUNNEL RE-ESTABLISH (02-20 status-UX split). «Переподключение» — the physical
    /// adapter is UP but the tunnel/server is being re-established: the server-silent
    /// auto-retry supervisor (bounded), a respawn after a process-death drop, or
    /// the manual save+reconnect path. Wire string `"reconnecting"` (the serde
    /// `rename_all = "lowercase"` default for this variant) — a NEW token distinct
    /// from `Recovering`'s `"recovering"`, so the frontend can render the yellow
    /// «Переподключение» state and «Попытка N/N» counter. Locked by the round-trip
    /// test alongside `Recovering` (T-08-01).
    Reconnecting,
    Error,
}

/// Shared application state for VPN lifecycle management.
pub struct AppState {
    pub sidecar_child: Arc<Mutex<Option<sidecar::SidecarChild>>>,
    pub disconnecting: Arc<Mutex<bool>>,
    /// The single owner of VPN status (D-01). Written ONLY through `set_vpn_status`.
    /// This fully replaces the former legacy boolean status flag (removed in plan 02
    /// once every reader was flipped to read this enum — the compiler proved no
    /// straggler remained).
    pub vpn_status: Arc<Mutex<VpnStatus>>,
    /// The last error detail that accompanied `vpn_status`, persisted alongside it
    /// (Codex MEDIUM — late-mount loses the error reason). Written ONLY through
    /// `set_vpn_status` from the same sanitized `error` argument, so it can never
    /// carry a raw credential (D-29). A window mounting AFTER an `error` event can
    /// restore BOTH the status AND its reason via the snapshot command, instead of
    /// rendering "error" with no detail. `None` whenever the current status carries
    /// no error (connected / connecting / a clean disconnect clears it).
    pub last_error: Arc<Mutex<Option<String>>>,
    pub tray_notified: Arc<Mutex<bool>>,
    /// Last-used config path for tray-initiated connect.
    pub config_path: Arc<Mutex<Option<String>>>,
    /// Last-used log level for tray-initiated connect.
    pub log_level: Arc<Mutex<String>>,
    /// Current UI locale ("ru" or "en") for tray menu text.
    pub locale: Arc<Mutex<String>>,
    /// Phase 17 — Server Benchmark single-flight cancel channel.
    ///
    /// Holds the sending half of the oneshot channel used to signal cancellation
    /// to an in-progress `run_benchmark` call. `Some` while a benchmark is running,
    /// `None` at rest. Uses `tokio::sync::Mutex` (NOT `std::sync::Mutex`) so it can
    /// be `.lock().await`-ed inside async Tauri commands.
    ///
    /// Single-flight invariant: `server_run_benchmark` rejects concurrent calls with
    /// `"BENCHMARK_ALREADY_RUNNING"` when this field is `Some`. Cleared to `None` on
    /// ALL exit paths (success / cancel / error / watchdog-forced) in `server_run_benchmark`.
    pub benchmark_cancel_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// Phase 17 UAT 2026-05-20 — cooperative MTProto install cancel flag.
    ///
    /// Set to `true` by `mtproto_cancel_install` Tauri command; checked between
    /// each `exec_command` call inside `ssh::server::server_mtproto::mtproto_install`.
    /// Reset to `false` on every install start AND every exit path. AtomicBool
    /// (not oneshot) because checks are sync between awaits — no need to .await
    /// the cancel signal.
    pub mtproto_install_cancel: Arc<AtomicBool>,
    /// Phase 18 — cooperative sidecar-update cancel flag (REQ-18-UPDATE-FLOW-07).
    ///
    /// Set to `true` by `cancel_update_sidecar` Tauri command; checked between
    /// each pipeline step inside `ssh::server::server_update::update_sidecar`
    /// AND inside `restart_trusttunnel_and_wait` 12s verify retry loop
    /// (PLAN-REVIEW Blocker #4 — без этого user Cancel click в verify window dead).
    /// Reset to `false` on every install start AND every exit path. AtomicBool
    /// pattern mirror Phase 17.1 `mtproto_install_cancel` precedent.
    pub update_sidecar_cancel: Arc<AtomicBool>,
    /// Phase 2 — monotonic connection generation (Codex HIGH stale-actor guard).
    ///
    /// Bumped with `fetch_add(1, SeqCst)` on every connect AND every disconnect, so
    /// each VPN session owns a distinct generation number. The connect-timeout
    /// watchdog (and the Plan 04 reconnect supervisor) captures the value at spawn
    /// and re-checks it via `lifecycle::is_current_generation` before any kill /
    /// status-write: if a manual reconnect or a user disconnect advanced the live
    /// generation past the captured one, the stale actor aborts instead of killing a
    /// session it no longer owns. Starts at 0.
    pub connection_generation: Arc<AtomicU64>,
    /// Phase 2 — single-supervisor guard (CR-02 nested-supervisor race).
    ///
    /// Set to `true` by `start_reconnect_supervisor` BEFORE its bounded loop and
    /// cleared on EVERY exit path (Recovered / Aborted / GaveUp). While it is `true`
    /// a supervisor is live and OWNS recovery for the current drop, so the sidecar's
    /// `Terminated` arm must NOT spawn a SECOND supervisor when the supervisor's own
    /// respawned child dies again (server still down). Without this guard, a
    /// supervisor-respawned child that connected (`was_connected = true`) then died
    /// re-fired `should_reconnect` → a brand-new supervisor, so two supervisors
    /// raced (both respawning, both killing each other's child) — the generation
    /// guard did NOT separate them because `respawn_sidecar` shares the captured
    /// generation. A genuine NEW drop AFTER the supervisor gives up still starts a
    /// fresh supervisor, because the flag is cleared on GaveUp. Starts at `false`.
    pub reconnect_in_progress: Arc<AtomicBool>,
    /// Phase 2 Plan 09 (UAT Gap #2) — per-attempt pre-flight connectivity result.
    ///
    /// Set on EVERY `vpn_connect` BEFORE the sidecar spawns: `true` when the
    /// non-blocking pre-flight (`connectivity::check_adapter_online`) saw the
    /// network as unreachable (adapter down / gateway unreachable), `false` when it
    /// was reachable. The pre-flight NEVER blocks the connect (cross-AI: corporate /
    /// captive nets that block gateway TCP but still allow the VPN must connect) — it
    /// only records this flag. The sidecar's `Terminated` arm reads it to CLASSIFY a
    /// never-connected non-zero exit: offline → `NO_INTERNET_REASON`, else
    /// `SIDECAR_EXIT_REASON`. Starts at `false`.
    pub last_preflight_offline: Arc<AtomicBool>,
    /// T-31 — DURABLE user-disconnect intent (a user-initiated Disconnect must WIN
    /// over an in-flight auto-reconnect).
    ///
    /// Distinct from `disconnecting`: that flag is cleared at the END of
    /// `vpn_disconnect` (the WR-01 "latent landmine" reset), so a supervisor that
    /// re-reads it AFTER the disconnect completes sees a stale `false` and can let an
    /// in-flight respawn flip the session back to Connected — the user then had to
    /// press Disconnect twice (UAT). This flag instead PERSISTS from `vpn_disconnect`
    /// until the next `vpn_connect` clears it, giving the reconnect supervisor a
    /// durable "the user wants to be disconnected" signal it can check at EVERY
    /// decision point (including AFTER a successful respawn) to abort to a clean
    /// Disconnected instead of Connected. Starts at `false`.
    pub user_disconnect_requested: Arc<AtomicBool>,
    /// Phase 13 (D-06 / §C) — the master notifications gate, MIRRORED from the FE.
    ///
    /// The «Авто-режим» → «Уведомления» toggle lives in the main webview's localStorage
    /// (`tt_notifications_enabled`), but a notification plate must be GATED even with the
    /// main window closed to tray — and localStorage is NOT shared across webview windows
    /// (Pitfall 5). So the FE pushes the toggle value into this AtomicBool mirror via the
    /// `set_notifications_enabled` command (on change AND once at startup), and the Rust
    /// firing seam (`notify::maybe_fire`) reads THIS mirror — never localStorage — so the
    /// gate holds window-closed. Default `true` matches the D-06 locked default, so the
    /// gate is correct BEFORE the first FE mirror push lands (a safe pre-seed: nothing is
    /// silenced that the user did not silence). AtomicBool because the read/write is a
    /// single bool with no compound invariant.
    pub notifications_enabled: Arc<AtomicBool>,
    /// Phase 13 (Pitfall 2 / §B) — the pending connect ORIGIN the next `Connected` consumes.
    ///
    /// A `Connecting → Connected` transition alone cannot tell «пользователь нажал» from
    /// «движок сам переключил» from «автоподключение при запуске» — the sidecar exposes no
    /// "was this auto?" bit. Before an AUTO action (auto-switch or launch auto-connect) the
    /// FE sets this durable signal via `set_pending_connect_origin`; `notify::maybe_fire`
    /// reads it on the next `Connected` to pick «Переключено автоматически» /
    /// «Автоподключение при запуске» over the generic «Подключено», then RESETS it back to
    /// `Manual` so it marks ONLY the one intended auto action and every subsequent manual
    /// connect reads `Manual`. `Mutex` (not Atomic) because `ConnectOrigin` is a 3-variant
    /// enum, not a bool. Starts at `Manual`.
    pub pending_connect_origin: Arc<Mutex<crate::notify::ConnectOrigin>>,
    /// Phase 13 (13-08b) — the pending connect-time reachability PING (ms) the next `Connected`
    /// consumes for the plate's detail block.
    ///
    /// FOLLOW-UP fix (build 2cr041 defect): the plate USED to ping the ACTIVE endpoint fresh at
    /// connect time via `ping_config_endpoint`, but a direct TCP connect to the active/connected
    /// endpoint reads Unreachable while the tunnel is up — BY DESIGN (see `usePerConfigPing.ts`
    /// "the active/connected config is NOT pinged here" and `ping.rs` "a tunnel-internal IP will
    /// fail a direct TCP connect and read Unreachable forever, even [connected]"). So the fresh
    /// connect-time ping of the active server was architecturally wrong and always rendered «—».
    /// The RELIABLE source is the config's reachability ping measured JUST BEFORE connecting (while
    /// it was still INACTIVE), which the FE already has in the `usePerConfigPing` map. The FE pushes
    /// that known ping here via `set_pending_connect_ping` right before each connect (at the SAME
    /// sites that set `pending_connect_origin`), and `notify::maybe_fire` READS AND CONSUMES it on
    /// the terminal Connected edge — exactly like the origin — using it as the plate's `ping_ms`.
    /// `None` → the plate renders «—» (honest no-data). Consumed (reset to `None`) whenever the
    /// origin is consumed so a failed attempt cannot leak a stale ping into the next connect.
    /// `Mutex<Option<u32>>` mirrors `pending_connect_origin`'s lock shape. D-29: a numeric ms — no
    /// config content or password. Starts at `None`.
    pub pending_connect_ping: Arc<Mutex<Option<u32>>>,
    /// Phase 13 (BL-01/WR-01) — a compound switch/reconnect TEARDOWN is in flight.
    ///
    /// `switchTo` and `handleReconnect` are plain `disconnect → connect`; their teardown leg writes
    /// a genuine `Connected → Disconnected` transition through the single status writer. Without a
    /// signal, `notify::maybe_fire` fired a spurious «Отключено» plate on that intermediate step
    /// before the real destination plate («Переключено автоматически» / «Подключено») — the true
    /// state mid-switch is "switching", never "disconnected" (D-03 / D-01). The FE raises THIS
    /// durable flag via `set_switch_or_reconnect_pending(true)` BEFORE the teardown-disconnect and
    /// clears it on the destination terminal outcome; `maybe_fire` reads it to SUPPRESS the
    /// intermediate «Отключено», and ALSO clears it on the terminal outcome (Connected / Error) as a
    /// durable backstop so a dropped FE promise can never wedge it `true` and swallow a later genuine
    /// user disconnect. AtomicBool because it is a single bool with no compound invariant. Auto-
    /// recovery does NOT set it (that path's Reconnecting/Recovering plates are intended — D-01), so
    /// it never blocks recovery notifications. Starts at `false`.
    pub switch_or_reconnect_pending: Arc<AtomicBool>,
    /// Phase 13 (13-05) — the LATEST notify-plate payload staged by `maybe_fire` before its emit.
    ///
    /// This closes the emit-before-listener race behind the UAT test-1 blocker (the empty black
    /// plate at launch): `maybe_fire` emits `notify-plate` then `win.show()` unconditionally, but
    /// the plate webview subscribes only in a post-mount effect, and Tauri v2 does not buffer
    /// events for a not-yet-subscribed webview — so a startup auto-connect fire that beats the
    /// mount is dropped while the window still shows. `maybe_fire` now stages the payload here
    /// BEFORE it emits; the plate PULLS-and-clears it once (`pull_pending_plate`, read-and-clear via
    /// `take()`) after its listener attaches, so a fire that beat the mount is redelivered — the
    /// same read-and-clear pattern the deep-link `poll_pending_deeplink` uses, here staged IN-MEMORY
    /// on AppState (like `pending_connect_origin`) rather than on disk. Process-scoped AppState
    /// resets it to `None` at every launch, so nothing stale survives a restart. Latest-wins (each
    /// fire overwrites) so a pull always redelivers the CURRENT state (D-03). `Mutex<Option<…>>`
    /// mirrors `pending_connect_origin`'s lock shape. D-29: `PendingPlate` carries only the kind
    /// wire_key + the config display name — no `.toml` content, host, or password. Starts at `None`.
    pub pending_plate: Arc<Mutex<Option<crate::notify::PendingPlate>>>,
    /// Phase 13 (13-06) — the app's EFFECTIVE theme ("dark" | "light"), MIRRORED from the FE.
    ///
    /// The theme lives in the MAIN webview's localStorage (`tt_theme`) and `useTheme` applies it as
    /// `data-theme` only on the MAIN window's `<html>`. The notification plate is a SEPARATE webview
    /// with its OWN (empty) localStorage, so it never learns the theme and its tokens fall back to the
    /// `:root` dark defaults — the plate stays dark even when the app is in the light theme (UAT
    /// round-2 defect 1). Same shape as the notifications gate (Pitfall 5: localStorage is not shared
    /// across webview windows), so the FE pushes the effective theme into this mirror via
    /// `set_plate_theme` (on change AND once at startup), and `notify::maybe_fire` includes it in the
    /// emitted payload so the plate applies the correct `data-theme` before every render. `Mutex`
    /// (not Atomic) because it holds a `String`. Starts `"dark"` — a safe default: the pre-seed dark
    /// value matches the `:root` fallback, so the plate looks correct BEFORE the first FE mirror push
    /// lands. Only ever holds one of the two whitelisted values ("dark"/"light") — `set_plate_theme`
    /// coerces any other input to "dark" (never trust a raw FE string blindly). D-29: a 2-value theme
    /// enum-like string, no secret.
    pub plate_theme: Arc<Mutex<String>>,
    /// Phase 13 (13-07) — the app's UI language ("ru" | "en") MIRRORED from the FE, so the desktop
    /// plate picks the right-language copy. The plate copy was hardcoded Russian and the plate webview
    /// has its OWN (empty) localStorage (Pitfall 5), so it stayed Russian on the English app language
    /// (UAT round-3 defect 2). Same shape as `plate_theme`: the FE (`useLanguage`) pushes the language
    /// into this mirror via `set_plate_language` (on change AND once at startup), and
    /// `notify::maybe_fire` includes it in the emitted payload so the plate selects the correct-language
    /// copy before every render. Starts `"ru"` — the app's primary language, matching the previously
    /// hardcoded copy, so the plate is correct BEFORE the first FE mirror push lands. Only ever holds
    /// one of the two whitelisted values ("ru"/"en") — `set_plate_language` coerces any other input to
    /// "ru". D-29: a 2-value language enum-like string, no secret.
    pub plate_language: Arc<Mutex<String>>,
}

#[derive(Clone, Serialize)]
struct VpnLogPayload {
    message: String,
    level: String,
}

#[derive(Clone, Serialize)]
pub struct VpnStatusPayload {
    // Typed status — serializes to the same lowercase wire strings as before.
    status: VpnStatus,
    // Kept a SEPARATE flat field (D-05) — never collapsed into the enum, because
    // every consumer reads `{status, error}` as two fields.
    error: Option<String>,
    // 02-20 status-UX split: the per-attempt reconnect index («Попытка N/N») the
    // server-silent auto-retry supervisor surfaces so the UI can show progress.
    // BOTH are `skip_serializing_if = "Option::is_none"` so EVERY existing emit (and
    // the byte-identical snapshot tests) stay exactly `{status, error}` — the two
    // fields appear on the wire ONLY for a `reconnecting` event that carries an
    // attempt. Secret-free (a small integer index — D-09), never a credential.
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<u32>,
}

/// The ONLY writer of VPN status and the ONLY emitter of the `"vpn-status"` event
/// (D-01 / STATUS-02). Every Rust status writer (vpn.rs connect/disconnect, sidecar
/// milestones, tray actions) routes through here.
///
/// Writes the canonical `vpn_status` field — the SINGLE source of truth (D-01) —
/// then does the one `app.emit` fan-out, which reaches the main window, the tray
/// webview, and the Rust `listen_any` in lib.rs that drives the tray icon.
///
/// D-29 / D-10: `error` MUST be a derived/sanitized message — never a raw sidecar
/// or config line that could carry a credential.
pub fn set_vpn_status(
    app: &tauri::AppHandle,
    state: &AppState,
    status: VpnStatus,
    error: Option<String>,
) {
    // Delegate to the Arc-based core so callers that hold the `AppState` borrow
    // and callers that only hold cloned Arcs (the connect-timeout watchdog, which
    // cannot move a `tauri::State` borrow across a spawn) BOTH route through the
    // exact same single writer + emitter. There is still only one place that
    // writes `vpn_status`/`last_error` and one place that emits `"vpn-status"`.
    set_vpn_status_inner(app, &state.vpn_status, &state.last_error, status, error);
}

/// The actual single writer of `vpn_status`/`last_error` + the single emitter of
/// the `"vpn-status"` event (D-01 / STATUS-02). Takes the two Arcs directly so it
/// can be called from a spawned task that owns cloned handles rather than the
/// `AppState` borrow. `set_vpn_status` is the thin convenience wrapper over this.
pub fn set_vpn_status_inner(
    app: &tauri::AppHandle,
    vpn_status: &Arc<Mutex<VpnStatus>>,
    last_error: &Arc<Mutex<Option<String>>>,
    status: VpnStatus,
    error: Option<String>,
) {
    // No attempt index on the generic path — only the reconnect supervisor's
    // per-attempt writer (`set_vpn_status_reconnecting_attempt`) populates those, so
    // this emit stays the byte-identical `{status, error}` shape every consumer reads.
    write_vpn_status_and_emit(app, vpn_status, last_error, status, error, None, None);
}

/// The actual canonical write of `vpn_status`/`last_error` followed by the ONE
/// `"vpn-status"` emit. Both `set_vpn_status_inner` (the generic path) and
/// `set_vpn_status_reconnecting_attempt` (02-20 per-attempt counter) funnel through
/// here, so there remains EXACTLY ONE place that writes `vpn_status` and ONE place
/// that emits `"vpn-status"` (D-01 / STATUS-02) — the attempt path does not duplicate
/// the lock/emit logic or introduce a second writer; it only supplies the optional
/// `attempt`/`max` fields.
fn write_vpn_status_and_emit(
    app: &tauri::AppHandle,
    vpn_status: &Arc<Mutex<VpnStatus>>,
    last_error: &Arc<Mutex<Option<String>>>,
    status: VpnStatus,
    error: Option<String>,
    attempt: Option<u32>,
    max: Option<u32>,
) {
    // WR-01: recover the poisoned guard so the canonical write ALWAYS lands
    // before we emit. The previous `if let Ok` silently dropped the write on a
    // poisoned mutex but still emitted, so every reader (check_vpn_status, tray,
    // connectivity monitor) would disagree with what listeners were just told —
    // the exact status drift this phase exists to eliminate. Mirrors the
    // `unwrap_or_else(|e| e.into_inner())` pattern already used for tray_notified
    // in lib.rs. Drop the guard before emit so no listener can observe a held lock.
    // Phase 13: capture the PREVIOUS status BEFORE overwriting it — the notification decider is
    // edge-triggered (it fires on a genuine prev != next transition, Pitfall 3), so it needs the
    // value this write is about to replace. Reading it inside the same guarded scope keeps the
    // single-writer invariant intact.
    let prev = {
        let mut g = vpn_status.lock().unwrap_or_else(|e| e.into_inner());
        let prev = *g;
        *g = status;
        prev
    };
    // Persist the error detail alongside the status so a late-mounting window can
    // restore BOTH via the snapshot (Codex MEDIUM). `error` is already the derived/
    // sanitized message every caller passes (D-29), so the stored copy is safe too.
    // Same poison-recovery pattern as the status write (WR-01) — the snapshot must
    // never disagree with what listeners were just told.
    {
        let mut e = last_error.lock().unwrap_or_else(|e| e.into_inner());
        *e = error.clone();
    }
    app.emit(
        "vpn-status",
        VpnStatusPayload { status, error, attempt, max },
    )
    .ok();

    // Phase 13: fire the desktop connection-notification plate from the SINGLE status writer,
    // AFTER the vpn-status emit — the same seam the tray fans out from, so a fired plate inherits
    // the "survives the main window closed to tray" property (Pattern 3 / Pitfall 1: the trigger
    // is Rust-owned, never a main-webview React effect). maybe_fire runs the pure decider (a
    // prev == next snapshot or a transient landing fires nothing) and only shows the plate on a
    // real outcome transition. The snapshot path (check_vpn_status_full) does NOT route through
    // this writer, so it never reaches the decider (Pitfall 3).
    crate::notify::maybe_fire(app, prev, status);
}

/// 02-20 status-UX split: write+emit a `Reconnecting` status carrying the per-attempt
/// index «Попытка N/N» for the server-silent auto-retry supervisor. Routes through the
/// SAME single owner + emitter (`write_vpn_status_and_emit`) as `set_vpn_status` (D-01
/// / STATUS-02) — it does NOT introduce a second status writer — but populates the
/// optional `attempt`/`max` fields so the UI can show progress. There is exactly ONE
/// `"vpn-status"` emit per call (no double-emit / flicker). `error` is left `None` (a
/// healthy retry is not an error; the descriptive «Связь с сервером потеряна» banner is
/// the frontend's job in Stage 2). `attempt`/`max` are a small integer index
/// (secret-free, D-09), never a credential.
pub fn set_vpn_status_reconnecting_attempt(
    app: &tauri::AppHandle,
    state: &AppState,
    attempt: u32,
    max: u32,
) {
    write_vpn_status_and_emit(
        app,
        &state.vpn_status,
        &state.last_error,
        VpnStatus::Reconnecting,
        None,
        Some(attempt),
        Some(max),
    );
}

/// Path to the PID file used to track the sidecar process across restarts.
///
/// Built on the per-edition `lifecycle::SIDECAR_PID_BASENAME` (`.sidecar-pro.pid`)
/// instead of the formerly-shared `.sidecar.pid` (Gemini HIGH isolation, D-07):
/// Pro and Light must never read or stale-kill each other's sidecar PID when both
/// are installed in the same data dir.
fn sidecar_pid_path() -> std::path::PathBuf {
    ssh::portable_data_dir().join(crate::lifecycle::SIDECAR_PID_BASENAME)
}

/// OS image name of the spawned VPN sidecar (Tauri spawns it via
/// `.sidecar("trusttunnel_client")`, so on Windows the running process is
/// `trusttunnel_client.exe`). Used as the `taskkill /FI "IMAGENAME eq ..."`
/// filter in `kill_stale_sidecar` so a saved PID that Windows recycled to an
/// UNRELATED process after a reboot/crash is never force-killed (02-10, Tier-1 A).
/// Centralized here as the single source so the filter and the spawn name cannot
/// drift apart.
const SIDECAR_IMAGE_NAME: &str = "trusttunnel_client.exe";

/// Build the `taskkill` argument vector for an image-validated, PID-scoped kill of
/// our stale sidecar (02-10, T-10-01). Factored out as a pure function so the
/// filter shape (both an `IMAGENAME` filter AND a `PID` filter must be present, so
/// a recycled PID on a different image is a no-op) is unit-testable without
/// spawning `taskkill`.
fn stale_kill_args(pid: u32) -> Vec<String> {
    vec![
        "/FI".to_string(),
        format!("IMAGENAME eq {SIDECAR_IMAGE_NAME}"),
        "/FI".to_string(),
        format!("PID eq {pid}"),
        "/F".to_string(),
    ]
}

/// Save the sidecar PID so we can clean it up after a crash.
///
/// 02-10 (Tier-1 A, T-10-02): the write is now CHECKED instead of `let _ = …`.
/// On failure (disk full / read-only data dir / permissions) we log a FIXED,
/// secret-free phrase (the path is NOT included — D-29) and CONTINUE: the connect
/// must never be blocked by a PID-write failure. The consequence of a missing PID
/// file is a DEGRADED crash-cleanup mode — the next launch's `kill_stale_sidecar`
/// has no saved PID to sweep — but the Windows Job Object (`job_object.rs`,
/// `KILL_ON_JOB_CLOSE`) still terminates the sidecar on parent death, so no
/// orphan survives. Surfacing the failure makes that degraded mode VISIBLE in the
/// log instead of silently swallowed.
fn save_sidecar_pid(pid: u32) {
    if let Err(e) = std::fs::write(sidecar_pid_path(), pid.to_string()) {
        // FIXED phrase + the std::io::Error kind only (no path / no PID beyond the
        // generic kind — D-29). Degraded mode: crash cleanup now leans entirely on
        // the Job Object (job_object.rs).
        crate::logging::log_app(
            "WARN",
            &format!(
                "Failed to persist sidecar PID ({}) — crash cleanup relies on the Job Object",
                e.kind()
            ),
        );
    }
}

// IN-01: `clear_sidecar_pid` removed — it was dead code. The PID file is cleared
// inline at the two real sites (sidecar.rs on Terminated, kill_stale_sidecar
// below), so a parallel unused helper only invited the cleanup paths to drift.

/// Full path of THIS edition's own sidecar executable. Resolved the SAME way the
/// spawn does: tauri-plugin-shell's `.sidecar("trusttunnel_client")` runs the binary
/// that sits NEXT TO the app executable, so `current_exe().with_file_name(...)` is
/// byte-for-byte the path the spawned process reports as its image path
/// (AUDIT-2026-06-11 #21). Deliberately NOT canonicalized: `fs::canonicalize` returns
/// a `\\?\`-prefixed verbatim path while `QueryFullProcessImageNameW(PROCESS_NAME_WIN32)`
/// returns the plain Win32 form — the comparison normalizes the prefix instead.
fn own_sidecar_path() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()
        .map(|exe| exe.with_file_name(SIDECAR_IMAGE_NAME))
}

/// Query the full executable path of a live process by PID.
///
/// AUDIT-2026-06-11 #21: follows the same windows-sys FFI pattern as
/// `sidecar::process_is_alive` (open with PROCESS_QUERY_LIMITED_INFORMATION, always
/// close the handle, treat ANY failure as "unknown"). Returns `None` when the process
/// is gone, access is denied, or the query fails — the caller must treat `None` as
/// "do not kill" (doubt ⇒ no-op).
#[cfg(windows)]
fn query_process_image_path(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: FFI into documented Win32 APIs. We open the process for limited query
    // only, read the image path into a stack buffer, and always close the handle.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None; // gone or no rights — the caller skips the kill
        }
        // MAX_PATH-plus buffer; QueryFullProcessImageNameW updates `len` in place to
        // the number of characters written (without the trailing NUL).
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 || len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

#[cfg(not(windows))]
fn query_process_image_path(_pid: u32) -> Option<String> {
    // Non-Windows builds never run the real sidecar; "unknown" keeps the kill a no-op.
    None
}

/// Normalize a Windows path for identity comparison: strip the `\\?\` verbatim
/// prefix (canonicalized paths carry it, Win32 query results do not) and lowercase
/// (NTFS paths are case-insensitive). Pure — unit-tested below.
fn normalize_win_path(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_lowercase()
}

/// AUDIT-2026-06-11 #21: the stale-PID kill decision, pure and unit-testable.
///
/// The IMAGENAME+PID taskkill filters (T-10-01) cannot tell Pro's sidecar from the
/// co-installed Light edition's — BOTH editions run the identical image name
/// `trusttunnel_client.exe`, just from different install directories. After a Pro
/// crash + reboot, Windows can recycle Pro's stale saved PID onto Light's LIVE
/// sidecar, which then passes both filters and gets force-killed mid-session (the
/// exact cross-edition kill D-07 was added to prevent). So the kill is allowed ONLY
/// when the candidate process's full executable path provably equals OUR OWN sidecar
/// path. Any doubt — query failed (`None`), own path unresolvable (`None`), or a path
/// mismatch — means "skip the kill"; the caller still removes the stale PID file, and
/// the Job Object already guarantees no orphan of our own survives a crash.
fn stale_pid_kill_allowed(
    candidate_exe_path: Option<&str>,
    own_sidecar_path: Option<&str>,
) -> bool {
    match (candidate_exe_path, own_sidecar_path) {
        (Some(candidate), Some(own)) => normalize_win_path(candidate) == normalize_win_path(own),
        _ => false,
    }
}

/// Kill a stale sidecar from a previous crashed session using the saved PID file.
/// Only kills the specific process, not all processes with the same name.
///
/// 02-10 (Tier-1 A, T-10-01): the kill is now VALIDATED against the sidecar image
/// name, not a blind `taskkill /F /PID <pid>`. After a hard reboot/crash Windows
/// can RECYCLE the saved PID to an entirely unrelated process; a blind `/F` kill
/// would then terminate that innocent process. By gating the kill on BOTH an
/// `IMAGENAME eq trusttunnel_client.exe` filter AND the `PID eq <pid>` filter,
/// `taskkill` becomes a NO-OP whenever the recycled PID no longer belongs to our
/// sidecar — it only ever kills a process that is BOTH our image AND that PID. The
/// PID file is still removed afterward so a one-shot stale entry never lingers.
///
/// AUDIT-2026-06-11 #21: image+PID filtering is NOT enough when Pro and Light are
/// co-installed — both spawn the identical image name, so a recycled PID landing on
/// the OTHER edition's live sidecar passed both filters. The kill is now additionally
/// gated on the candidate process's full executable PATH equaling THIS edition's own
/// sidecar path (`stale_pid_kill_allowed`); any doubt skips the kill.
pub fn kill_stale_sidecar() {
    let pid_path = sidecar_pid_path();
    if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
        if let Ok(pid) = pid_str.trim().parse::<u32>() {
            // AUDIT-2026-06-11 #21: gate the kill on the candidate's FULL EXECUTABLE
            // PATH, not just IMAGENAME+PID. Both editions (Pro/Light) spawn the same
            // image name, so a PID recycled onto the OTHER edition's live sidecar
            // passed both taskkill filters and was force-killed mid-session. Only
            // kill when the live process at that PID verifiably runs OUR OWN sidecar
            // binary; on any doubt skip the kill and just drop the stale PID file.
            let candidate = query_process_image_path(pid);
            let own = own_sidecar_path();
            let own_str = own.as_ref().map(|p| p.to_string_lossy().to_string());
            if stale_pid_kill_allowed(candidate.as_deref(), own_str.as_deref()) {
                eprintln!("[cleanup] Killing stale sidecar PID {pid} (image+path-validated)");
                crate::logging::log_app("WARN", &format!("Killing stale sidecar PID {pid}"));
                // Image-name + PID filters kept as defense-in-depth (T-10-01) under
                // the new path gate. `/F` still forces the kill when everything
                // matches our own crashed sidecar.
                let _ = std::process::Command::new("taskkill")
                    .args(stale_kill_args(pid))
                    .creation_flags(crate::sidecar::CREATE_NO_WINDOW) // CREATE_NO_WINDOW
                    .output();
            } else {
                // FIXED phrase, no executable path in the log (D-29). The stale PID
                // file is removed below either way, so this one-shot entry never
                // re-triggers the check.
                crate::logging::log_app(
                    "INFO",
                    &format!(
                        "Stale sidecar PID {pid} does not belong to our own sidecar (exited or recycled) — skipping kill, removing PID file (#21)"
                    ),
                );
            }
        }
        let _ = std::fs::remove_file(&pid_path);
    }
}

/// Substring that identifies THIS client's OWN WinTUN adapter (T-21). The C++ sidecar
/// (not in this tree) creates its tunnel adapter with a `Name` of the form
/// "TrustTunnel (<server-host>)" (e.g. "TrustTunnel (vpn.example.com)"). Matched
/// case-insensitively so a casing change in the sidecar can't slip our own adapter
/// back into the conflict list.
const OWN_ADAPTER_IDENTITY: &str = "trusttunnel";

/// Pure, testable filter for the conflict list (T-21).
///
/// `detect_conflicting_adapters` enumerates VPN/TUN adapters via PowerShell, but the
/// raw enumeration ALSO returns this client's OWN WinTUN adapter — its `Name` is
/// "TrustTunnel (<host>)", while its `InterfaceDescription` is the generic WinTUN
/// driver string ("Wintun Userspace Tunnel"). The PowerShell `-notmatch 'TrustTunnel'`
/// only checked the DESCRIPTION, so our own adapter (identified by NAME) slipped
/// through and was reported as "active VPN adapters from other software: TrustTunnel
/// (vpn.example.com)" (UAT). This drops any entry whose name contains our own identity,
/// while preserving genuine third-party adapters (NordVPN, WireGuard, OpenVPN/TAP,
/// Amnezia, …) so a real conflict is still surfaced.
fn filter_out_own_adapter(names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .filter(|name| !name.to_lowercase().contains(OWN_ADAPTER_IDENTITY))
        .collect()
}

/// Detect conflicting VPN/TUN adapters that may block WinTUN creation.
/// Returns a list of adapter names that look like they belong to other VPN software.
///
/// T-21: the app's OWN WinTUN adapter is excluded via `filter_out_own_adapter` AFTER
/// enumeration. We filter by NAME in Rust (not only the PowerShell description match)
/// because the own adapter carries the "TrustTunnel" identity in its `Name`, not its
/// `InterfaceDescription` — so the previous description-only `-notmatch` let it through.
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
            let names = text
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            // T-21: drop our own "TrustTunnel (<host>)" adapter (matched by Name).
            filter_out_own_adapter(names)
        }
        Err(_) => vec![],
    }
}

#[cfg(not(windows))]
fn detect_conflicting_adapters() -> Vec<String> { vec![] }

/// Kill the sidecar stored in AppState, if any.
///
/// IN-02: this intentionally does NOT route through `set_vpn_status`, so it leaves
/// `vpn_status` stale (e.g. `Connected`). That is safe ONLY because it is an
/// EXIT-ONLY path — called from `app.exit(0)` / `RunEvent::Exit` (lib.rs, tray.rs)
/// where the process is dying and stale status is harmless. Do NOT reuse this
/// mid-session: doing so would reintroduce the status drift this phase eliminates.
/// Any in-session kill must go through `set_vpn_status` (see `vpn_disconnect`).
pub fn kill_sidecar_from_state(state: &AppState) {
    if let Ok(mut guard) = state.sidecar_child.lock() {
        if let Some(child) = guard.take() {
            child.child.kill().ok();
        }
    }
}

/// R3 (UAT build 65692c test 7): force-release the session's sidecar on a TERMINAL,
/// non-user-initiated failure — the reconnect supervisor gave up, the recovery wait
/// timed out, or the network came back with nothing to reconnect to.
///
/// The sidecar process OWNS the WinTUN adapter, the routing hijack AND the killswitch.
/// Before this, a give-up left the last respawned sidecar ALIVE: the killswitch stayed
/// fail-closed with no working tunnel, so ALL traffic (even non-VPN) was blocked until
/// the app was restarted — and `sidecar_child.is_some()` made the next `vpn_connect`
/// refuse with "VPN is already running". Killing the sidecar closes its adapter, which
/// drops the routes + killswitch exactly like a normal `vpn_disconnect`, and clears the
/// stored handle so a reconnect works. Mirrors `vpn_disconnect`'s take+kill (minus the
/// user-intent bookkeeping). Caller sets the terminal status (Error/Disconnected)
/// BEFORE calling this — the resulting intentional Terminated event must not clobber it
/// (the Terminated arm keeps an already-set Error; see sidecar.rs).
pub async fn teardown_session_sidecar(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return; };
    let child = match state.sidecar_child.lock() {
        Ok(mut g) => g.take(),
        Err(p) => p.into_inner().take(),
    };
    if let Some(child) = child {
        // Mark the child's own intent flag so its Terminated arm classifies this kill
        // as intentional (no reconnect-supervisor re-spawn from the teardown itself).
        if let Ok(mut d) = child.disconnecting.lock() { *d = true; }
        crate::logging::log_app(
            "INFO",
            "[reconnect] terminal failure — releasing the session sidecar so the killswitch/adapter can't strand the machine (R3)",
        );
        sidecar::kill_sidecar(child).await.ok();
    }
    // Remove the hosts-file DNS block the session installed (same as vpn_disconnect),
    // so a give-up never leaves a stale DNS override behind.
    routing_rules::cleanup_hosts_block().ok();
    // FIX-A (RC-2): restore pre-VPN system DNS on terminal teardown too (mirror of
    // vpn_disconnect) so a give-up never strands the resolver.
    crate::dns_guard::restore_system_dns();
    // AUDIT-2026-06-11 #12: clear the process-wide `disconnecting` intent now that the
    // teardown is complete. `child.disconnecting` IS `state.disconnecting` (the same Arc,
    // passed in by spawn_trusttunnel), so the `*d = true` above latched the PROCESS-WIDE
    // flag — and unlike vpn_disconnect (its WR-01 end-of-fn reset) this fn never cleared
    // it. A stale `true` at rest made the tray show «Отключение…» indefinitely
    // (tray_menu_current_status maps Disconnected + disconnecting=true to that bucket)
    // and misled every other intent reader (recovery polls, respawn's WR-05 bail).
    // Ordering mirrors vpn_disconnect's WR-01 argument: the Terminated arm reads
    // `was_intentional` DURING `kill_sidecar` above, which has fully returned by this
    // point, so resetting here cannot race the arm into a spurious reconnect.
    // (Trailing semicolon: the lock Result temporary must drop BEFORE `state` — E0597.)
    if let Ok(mut d) = state.disconnecting.lock() {
        *d = false;
    };
}

/// R4 (UAT build 65692c test 7 — quit hang): signal shutdown BEFORE killing the sidecar
/// on app exit. Sets the `disconnecting` intent and bumps `connection_generation`, so
/// any live reconnect supervisor or connectivity-monitor loop — both re-check intent +
/// generation each iteration — cooperatively bails and CANNOT respawn a sidecar after
/// the user asked to quit. Without this, a supervisor mid-`respawn` could relaunch a
/// sidecar while the exit handler was blocked in `pool.invalidate()`, leaving the app
/// frozen with the tray menu unresponsive (only Task Manager could close it). Pure
/// flag/atomic writes — no `.await`, no lock held across a kill — so it is safe to call
/// from the synchronous quit handlers and `RunEvent::Exit`.
pub fn begin_shutdown(state: &AppState) {
    if let Ok(mut d) = state.disconnecting.lock() {
        *d = true;
    }
    state.connection_generation.fetch_add(1, Ordering::SeqCst);
}

/// The connect-timeout watchdog's three-way decision (D-05, Codex HIGH).
///
/// Pure, side-effect-free outcome so the abort logic can be unit-tested without a
/// real sidecar (RESEARCH Wave 0 — "inject a clock"). The watchdog evaluates this
/// AFTER `CONNECT_TIMEOUT` elapses without a `Connected` signal, then only acts on
/// `Abort`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchdogDecision {
    /// Kill the sidecar and move to an honest Error (the `connect-timeout` reason).
    Abort,
    /// Do nothing — the session connected, the user is disconnecting, or this
    /// watchdog is stale (its generation was advanced by a newer session).
    NoOp,
}

/// Decide whether the connect-timeout watchdog should abort the session.
///
/// Re-checks ALL THREE guards under the caller's locks before any side effect
/// (Pitfall 5 + Codex HIGH):
/// - `is_connected`: the session reached `Connected` in time → never kill it.
/// - `disconnecting`: a user-initiated Disconnect is in flight → never fight it (D-04).
/// - generation match (`lifecycle::is_current_generation`): a manual reconnect /
///   disconnect bumped the live generation past the one captured at spawn → this
///   watchdog is stale and must abort acting (it no longer owns the session).
///
/// Returns `Abort` ONLY when the session is still NOT connected, NOT disconnecting,
/// NOT already in a specific Error, and this watchdog still owns the live generation.
///
/// 02-10 (Tier-3, T-10-04): `is_already_error` was added so the generic
/// `connect-timeout` Error can NEVER clobber a SPECIFIC Error (auth / config /
/// Wintun) that landed first. The fatal-marker path (`sidecar.rs`) can set
/// `VpnStatus::Error` with a precise reason within the 60s window; if the watchdog
/// then fired and overwrote it with `connect-timeout`, the user would lose the real
/// diagnosis. When the status is already `Error`, the watchdog is a NoOp.
pub fn decide_timeout_action(
    is_connected: bool,
    disconnecting: bool,
    is_already_error: bool,
    captured_generation: u64,
    live_generation: u64,
) -> WatchdogDecision {
    let still_owns_session =
        crate::lifecycle::is_current_generation(captured_generation, live_generation);
    if !is_connected && !disconnecting && !is_already_error && still_owns_session {
        WatchdogDecision::Abort
    } else {
        WatchdogDecision::NoOp
    }
}

/// Resolve once the single `vpn_status` owner (D-01) reads `Connected`, OR once the
/// session is no longer this watchdog's to wait on (user disconnect / generation
/// advanced past `captured_gen`).
///
/// A short poll loop over the existing status lock (poison-recover with
/// `unwrap_or_else(|e| e.into_inner())` like `set_vpn_status`) instead of a new
/// channel — it reuses the one status source of truth and never introduces a
/// parallel signal. Raced against `CONNECT_TIMEOUT` by `tokio::time::timeout` in
/// the watchdog: if this future resolves first, the connect succeeded (or the
/// session was disconnected / superseded) and the post-timeout guards make the
/// watchdog a no-op; if the timeout fires first, the deadline elapsed.
///
/// WR-04: the loop now ALSO returns early when `disconnecting` is set or the
/// generation advanced past the captured one, so a user-disconnect at second 5 ends
/// this polling task promptly instead of keeping it alive for the full 60s. The
/// post-timeout guards already catch these cases, so correctness is unchanged — this
/// only stops the task from lingering and from masking future logic changes.
async fn wait_for_connected(
    vpn_status: Arc<Mutex<VpnStatus>>,
    disconnecting: Arc<Mutex<bool>>,
    connection_generation: Arc<AtomicU64>,
    captured_gen: u64,
) {
    loop {
        let connected = vpn_status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .eq(&VpnStatus::Connected);
        if connected {
            return;
        }
        // WR-04: end early on a user disconnect or a newer session taking over —
        // no point polling for `Connected` on a session we no longer own.
        let disconnecting_now = *disconnecting.lock().unwrap_or_else(|e| e.into_inner());
        let live_gen = connection_generation.load(Ordering::SeqCst);
        if disconnecting_now
            || !crate::lifecycle::is_current_generation(captured_gen, live_gen)
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Spawn the connect-timeout watchdog for a freshly-started session (D-05, F1).
///
/// Races `CONNECT_TIMEOUT` (60s) against the `Connected` signal. If the session has
/// NOT reached `Connected` within the window, it kills the hung sidecar and moves to
/// an honest Error carrying the STABLE reason code `"connect-timeout"` (localized on
/// the frontend). Lives at the COMMAND layer (not the sidecar stdout loop — D-05) and
/// is GENERATION-GUARDED so a stale watchdog can never kill a session it no longer
/// owns (Codex HIGH).
///
/// CR-03: factored out of `vpn_connect` so the tray connect path (`tray_vpn_connect`)
/// can arm the SAME watchdog — previously only the command path was protected, so a
/// tray-started session that never handshaked hung on "Connecting…" forever (D-05
/// unmet for tray connects). Mirror of Light's `spawn_connect_timeout_watchdog`.
pub fn spawn_connect_timeout_watchdog(app: &tauri::AppHandle, captured_gen: u64) {
    let Some(state) = app.try_state::<AppState>() else { return; };
    let app_wd = app.clone();
    let status_arc = Arc::clone(&state.vpn_status);
    let last_error_arc = Arc::clone(&state.last_error);
    let disc_arc = Arc::clone(&state.disconnecting);
    let child_arc = Arc::clone(&state.sidecar_child);
    let gen_arc = Arc::clone(&state.connection_generation);

    tauri::async_runtime::spawn(async move {
        // Wait up to CONNECT_TIMEOUT for `Connected`. If `wait_for_connected`
        // resolves first, the connect succeeded (or the session was disconnected /
        // superseded — WR-04) → the guards below make this a no-op.
        let timed_out = tokio::time::timeout(
            crate::lifecycle::CONNECT_TIMEOUT,
            wait_for_connected(
                Arc::clone(&status_arc),
                Arc::clone(&disc_arc),
                Arc::clone(&gen_arc),
                captured_gen,
            ),
        )
        .await
        .is_err();

        if !timed_out {
            return; // connected / disconnected / superseded within the window
        }

        // Deadline elapsed. Re-acquire the locks and re-check ALL guards under them
        // (Pitfall 5 + Codex HIGH + 02-10 T-10-04) before any kill / status-write.
        let current_status = *status_arc.lock().unwrap_or_else(|e| e.into_inner());
        let is_connected = current_status == VpnStatus::Connected;
        // 02-10 (T-10-04): a SPECIFIC Error (auth / config / Wintun) may have landed
        // within the window via the fatal-marker path. If so, do NOT overwrite it with
        // the generic connect-timeout — the watchdog becomes a NoOp.
        let is_already_error = current_status == VpnStatus::Error;
        let disconnecting = *disc_arc.lock().unwrap_or_else(|e| e.into_inner());
        let live_gen = gen_arc.load(Ordering::SeqCst);

        let decision = decide_timeout_action(
            is_connected,
            disconnecting,
            is_already_error,
            captured_gen,
            live_gen,
        );
        if decision == WatchdogDecision::NoOp {
            return; // connected, user-disconnecting, or stale — leave it alone
        }

        // FIXED lifecycle marker (no config text / no raw sidecar line — D-09/D-29).
        crate::logging::log_app("WARN", "connect-timeout fired (60s, no handshake)");
        app_wd.emit("vpn-log", VpnLogPayload {
            message: "connect-timeout fired (60s, no handshake)".into(),
            level: "warn".into(),
        }).ok();

        // Release the WinTUN adapter: kill the PID-scoped child we still own, then
        // sweep any stale saved-PID sidecar (Pitfall 3). Both are PID-scoped (never
        // image-name, D-07) and per-edition (Gemini HIGH).
        //
        // WR-06: re-check `is_connected` one LAST time under the child lock,
        // immediately before the kill. The guard reads above are three separate lock
        // acquisitions; a `Connected` event could land between the first read and the
        // kill (sub-250ms TOCTOU on a 60s-boundary connect). Re-reading the status
        // here, while holding the child lock, closes that window — a session that just
        // connected is never killed.
        if let Ok(mut guard) = child_arc.lock() {
            let connected_now = status_arc
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .eq(&VpnStatus::Connected);
            if connected_now {
                return; // connected in the TOCTOU window — do NOT kill
            }
            if let Some(child) = guard.take() {
                child.child.kill().ok();
            }
        }
        kill_stale_sidecar();

        // Honest failure through the single mutator (D-03) carrying a STABLE,
        // secret-free ASCII REASON CODE — the user-facing wording is the i18n key on
        // the frontend (CLAUDE.md i18n rule), NOT a Russian string here. Routes
        // through `set_vpn_status_inner` (the same single writer + emitter
        // `set_vpn_status` uses) so the timeout path never writes `vpn_status` or
        // emits `"vpn-status"` on its own.
        set_vpn_status_inner(
            &app_wd,
            &status_arc,
            &last_error_arc,
            VpnStatus::Error,
            Some("connect-timeout".to_string()),
        );
    });
}

/// AUDIT-2026-06-11 #19: the connect-path cancel predicate, pure and unit-testable.
///
/// A user Cancel must be visible to `vpn_connect` through EITHER intent flag:
/// - `disconnecting` (transient) — a `vpn_disconnect` still in flight;
/// - `user_disconnect_requested` (durable, T-31) — a `vpn_disconnect` that already
///   RAN TO COMPLETION (it resets the transient flag back to `false` at its end —
///   WR-01 — so checking the transient flag alone misses a completed cancel; the
///   durable flag persists until the next `vpn_connect` clears it).
///
/// Factored out so the OR of both flags is locked by tests — dropping the durable
/// leg would silently reintroduce the "Cancel during spawn is overridden" bug.
fn connect_cancelled(transient_disconnecting: bool, durable_disconnect_requested: bool) -> bool {
    transient_disconnecting || durable_disconnect_requested
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
    crate::logging::log_app("INFO", &format!("VPN connect: config={config_path}, log_level={log_level}"));

    // Write system diagnostics snapshot (if logging enabled) — in a BACKGROUND thread so
    // it never blocks the connect path. It shells out to PowerShell (~1s startup), which
    // previously delayed EVERYTHING after it — including the «Подключение» status emit, so
    // the tray icon stayed gray for ~a second before turning yellow (UAT fd63ec test 9).
    // Nothing here depends on the snapshot's result; it is pure debug capture.
    if crate::logging::is_logging_enabled() {
        std::thread::spawn(crate::diagnostics::write_system_snapshot);
    }

    // Remember config for tray-initiated reconnect
    if let Ok(mut cp) = state.config_path.lock() { *cp = Some(config_path.clone()); }
    if let Ok(mut ll) = state.log_level.lock() { *ll = log_level.clone(); }

    // D-08 lifecycle marker (1): connect start. A FIXED phrase (no config path —
    // the old "Connecting with config: {config_path}" emit leaked the path onto
    // the vpn-log channel, which the DEV F12 mirror would print; replaced with a
    // secret-free marker per D-09/D-29). DEV-gated via emit_lifecycle_marker
    // (D-11) so the verbose stream never ships. The config path is still recorded
    // in the file log (app.log) through the sanitized log_app call above.
    sidecar::emit_connect_start_marker(&app);

    // R8 (UAT build 65692c test 7): refuse a connect ONLY when a session is genuinely
    // live. The handle could be left as a STALE `Some` after a failed recovery (a
    // supervisor that gave up before R3 landed, or a respawned child that died without
    // delivering a clean Terminated), which made EVERY later connect fail with "VPN is
    // already running" until the app was restarted. So: refuse only when the slot is
    // Some AND the status is an ACTIVE one (a real session owns the adapter). Otherwise
    // the handle is stale (status Disconnected/Error) → take + kill it and proceed, so
    // the user recovers without restarting the app. Gating on the status (not just
    // presence) is the liveness check Codex flagged — a bare presence check is unsafe.
    {
        let status_now = *state.vpn_status.lock().unwrap_or_else(|e| e.into_inner());
        let session_active = matches!(
            status_now,
            VpnStatus::Connecting
                | VpnStatus::Connected
                | VpnStatus::Reconnecting
                | VpnStatus::Recovering
        );
        let mut guard = state
            .sidecar_child
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        if guard.is_some() {
            if session_active {
                return Err("VPN is already running".into());
            }
            if let Some(child) = guard.take() {
                child.child.kill().ok();
            }
            crate::logging::log_app(
                "WARN",
                "[vpn] stale sidecar handle on an idle/failed session — cleared it and proceeding with connect (R8)",
            );
        }
    }

    // R7 (UAT fd63ec test 9): emit «Подключение» NOW — right after the fast R8 liveness
    // check and BEFORE any slow work (kill_stale's taskkill, canonicalize, the awaited
    // pre-flight + spawn) — so the TRAY icon turns yellow the instant the user clicks, in
    // lock-step with the window. The diagnostics snapshot above is now detached, so nothing
    // slow runs before this point. Every early-error path below moves the status to
    // Error / Disconnected so the tray can never get stuck on this yellow.
    set_vpn_status(&app, &state, VpnStatus::Connecting, None);

    // Kill any stale sidecar processes that might hold the WinTUN adapter
    kill_stale_sidecar();

    // Warn about conflicting VPN adapters (non-blocking — runs in background)
    let app_bg = app.clone();
    std::thread::spawn(move || {
        let conflicts = detect_conflicting_adapters();
        if !conflicts.is_empty() {
            let names = conflicts.join(", ");
            let warn_msg = format!("Warning: detected active VPN adapters from other software: {names}. This may cause connection issues. Consider disabling them before connecting.");
            eprintln!("[vpn_connect] {warn_msg}");
            crate::logging::log_app("WARN", &warn_msg);
            app_bg.emit("vpn-log", VpnLogPayload {
                message: warn_msg.clone(),
                level: "warn".into(),
            }).ok();
            app_bg.emit("vpn-adapter-conflict", serde_json::json!({
                "adapters": conflicts,
                "message": warn_msg,
            })).ok();
        }
    });

    app.emit("vpn-log", VpnLogPayload {
        message: "Spawning trusttunnel_client process...".into(),
        level: "info".into(),
    }).ok();

    // Canonicalize config_path to prevent path traversal before passing to sidecar.
    // R7: «Подключение» was emitted above, so a failure here must move the status off the
    // yellow tray icon — to Error. The FE also surfaces the returned Err in its catch.
    let config_path = match std::fs::canonicalize(&config_path) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            set_vpn_status(&app, &state, VpnStatus::Error, None);
            return Err(format!("Invalid config path: {e}"));
        }
    };

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
    // T-31: a fresh connect clears the durable user-disconnect intent so a prior
    // Disconnect can never suppress THIS new session's reconnects. Pairs with the
    // store(true) in vpn_disconnect — the only two writers of this flag.
    state.user_disconnect_requested.store(false, Ordering::SeqCst);

    // ── Non-blocking pre-flight connectivity check (02-09, UAT Gap #2) ──────
    //
    // cross-AI REWORK: we do NOT block the connect on this. Corporate / hotel /
    // captive networks routinely block the local gateway on TCP 80/443 while still
    // allowing the VPN to establish — blocking here would wrongly refuse a
    // connection that would have worked (T-09-03, disposition: accept). So this is
    // a WARNING ONLY: it records a per-attempt flag (`last_preflight_offline`) the
    // sidecar's Terminated arm reads to CLASSIFY a never-connected non-zero exit as
    // `no-internet` vs the generic `sidecar-exit`, and emits a DEV-gated fixed-phrase
    // marker. It NEVER returns early / blocks the spawn.
    let preflight_offline = !crate::connectivity::check_adapter_online().await;
    state.last_preflight_offline.store(preflight_offline, Ordering::SeqCst);
    if preflight_offline {
        // FIXED phrase (no config / server text — D-09/D-29), DEV-gated so the
        // verbose marker never ships. We CONTINUE to spawn regardless (cross-AI).
        sidecar::emit_preflight_offline_marker(&app);
    }

    // Bump the connection generation so THIS session owns a distinct number
    // (Codex HIGH stale-actor guard). The connect-timeout watchdog spawned below
    // captures the post-bump value and re-checks it before any kill / status-write;
    // a later manual reconnect / disconnect bumps it again and neutralizes this
    // watchdog. `fetch_add` returns the PRE-increment value, so the captured
    // generation for this session is that + 1.
    let connect_generation = state.connection_generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Check if user cancelled during routing rules resolution / the awaited pre-flight.
    // AUDIT-2026-06-11 #19: ALSO consult the durable T-31 flag — a vpn_disconnect that
    // ran to completion during the pre-flight `.await` above already reset the transient
    // `disconnecting` back to false (WR-01), so the transient flag alone misses it.
    if connect_cancelled(
        state.disconnecting.lock().map(|g| *g).unwrap_or(false),
        state.user_disconnect_requested.load(Ordering::SeqCst),
    ) {
        eprintln!("[vpn_connect] Cancelled before sidecar spawn");
        set_vpn_status(&app, &state, VpnStatus::Disconnected, None);
        return Ok(());
    }

    // Pass Arc clones so sidecar can clear itself on termination. The sidecar
    // routes all status through set_vpn_status (AppState looked up via try_state),
    // so it owns no status flag of its own.
    let child_arc = Arc::clone(&state.sidecar_child);
    let disc_arc = Arc::clone(&state.disconnecting);

    // Always use at least "info" for sidecar — "Successfully connected to endpoint"
    // is an INFO message; suppressing it breaks connection status detection.
    let sidecar_log_level = match log_level.as_str() {
        "error" | "warn" => "info",
        other => other,
    };

    // FIX-A (RC-2): snapshot the pre-VPN system DNS ONCE before the tunnel comes up, so we
    // can restore it on teardown even though the C++ sidecar is hard-killed and never
    // restores it itself (guarded against overwrite on reconnect). Flush stale resolver
    // entries so resolution is clean across the transition.
    crate::dns_guard::snapshot_system_dns();
    crate::dns_guard::flush_dns_cache();

    let child = sidecar::spawn_trusttunnel(&app, &config_path, sidecar_log_level, child_arc, disc_arc)
        .await
        .map_err(|e| {
            let msg = format!("Failed to start sidecar: {e}");
            eprintln!("[vpn_connect] {msg}");
            crate::logging::log_app("ERROR", &msg);
            app.emit("vpn-log", VpnLogPayload {
                message: msg.clone(),
                level: "error".into(),
            }).ok();
            // R7: move the status off the yellow «Подключение» the early emit set, so the
            // tray doesn't stay yellow after a spawn failure.
            set_vpn_status(&app, &state, VpnStatus::Error, None);
            msg
        })?;

    // AUDIT-2026-06-11 #19: post-spawn cancel re-check — the mirror of respawn_sidecar's
    // T-10-05 guard, which the first-connect path never received. `spawn_trusttunnel` is
    // async: a user can press Cancel WHILE the spawn is in flight, and vpn_disconnect can
    // run TO COMPLETION in that window (it takes `None` from the child slot — the child
    // is not stored yet, so its kill is a no-op — writes Disconnected, sets the durable
    // T-31 flag, and clears the transient flag back to false). Without this re-check the
    // fresh child was stored anyway and the sidecar markers flipped the session to
    // Connected — silently overriding the user's completed Cancel (the T-31 double-press
    // class on the first-connect path). Placed BEFORE save_sidecar_pid so the PID file
    // never records a child we immediately tear down.
    if connect_cancelled(
        state.disconnecting.lock().map(|g| *g).unwrap_or(false),
        state.user_disconnect_requested.load(Ordering::SeqCst),
    ) {
        crate::logging::log_app(
            "INFO",
            "[vpn] cancel observed after spawn — killing fresh child, not storing it (#19, mirrors T-10-05)",
        );
        // Mark the kill as INTENTIONAL for the child's Terminated arm (same contract
        // as vpn_disconnect / teardown_session_sidecar). In the completed-cancel
        // scenario the transient flag is already back to false (WR-01 reset at the
        // end of vpn_disconnect), so without re-raising it the arm would classify
        // this never-connected non-zero exit as a failure and write
        // Error("sidecar-exit") over the user's clean Disconnected.
        if let Ok(mut d) = child.disconnecting.lock() { *d = true; }
        // Graceful-then-hard kill (same teardown as everywhere else) so the fresh
        // sidecar can drop any WFP/route state it already installed.
        sidecar::kill_sidecar(child).await.ok();
        // Through the single mutator (D-01); vpn_disconnect already wrote Disconnected,
        // re-asserting it keeps every surface consistent even if the cancel is still
        // mid-flight.
        set_vpn_status(&app, &state, VpnStatus::Disconnected, None);
        // WR-01-style reset: the Terminated arm read `was_intentional` during the
        // kill_sidecar await above, so clearing now cannot race it into a spurious
        // reconnect — and a stale `true` at rest is the known landmine.
        if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
        return Ok(());
    }

    // Save PID for stale-process cleanup after crashes
    save_sidecar_pid(child.child.pid());

    eprintln!("[vpn_connect] Sidecar spawned OK (PID {}), storing child handle", child.child.pid());
    crate::logging::log_app("INFO", &format!("Sidecar spawned OK (PID {})", child.child.pid()));
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

    // Status is ALREADY «Подключение» — emitted at the top of this fn for an immediate
    // tray sync (R7) — and stays there until the sidecar detects "Successfully connected
    // to endpoint" and flips it to Connected. No re-emit here: it would be a redundant
    // duplicate `vpn-status` event (Codex dedup note).

    // ── Connect-timeout watchdog (D-05, F1) ────────────────────────────────
    //
    // CR-03: extracted into `spawn_connect_timeout_watchdog` so the tray connect
    // path arms the SAME watchdog. It races CONNECT_TIMEOUT (60s) against the
    // `Connected` signal, lives at the COMMAND layer (not the sidecar stdout loop —
    // D-05), and is generation-guarded so a stale watchdog can never kill a session
    // it no longer owns (Codex HIGH).
    spawn_connect_timeout_watchdog(&app, connect_generation);

    Ok(())
}

/// Reconnect-safe respawn of the sidecar for the Plan 04 supervisor (STATUS-05).
///
/// This is the respawn step the window-independent reconnect supervisor
/// (`connectivity::start_reconnect_supervisor`) calls per attempt. It deliberately
/// REUSES the exact pre-spawn sequence `vpn_connect` runs so a respawn never trips
/// over a held WinTUN adapter (Pitfall 3):
/// 1. Take + kill the prior child handle (the stale-but-alive sidecar on a
///    connectivity-loss drop, or a no-op when the process already exited).
/// 2. `kill_stale_sidecar()` — sweep any saved-PID sidecar (per-edition, D-07).
/// 3. Canonicalize the config path (path-traversal guard, same as connect).
/// 4. Re-resolve + apply routing rules.
/// 5. Reset `disconnecting=false`, then spawn the JOB-ARMED sidecar (Plan 03) and
///    store the new child.
/// 6. Set `VpnStatus::Reconnecting` through the single mutator so the UI shows the
///    in-flight RE-establish («Переподключение», 02-20) — a respawn is never a FIRST
///    connect; the sidecar's own markers flip it to `Connected` on success (the
///    supervisor then waits on that).
///
/// It does NOT bump `connection_generation` — the supervisor OWNS the generation it
/// captured at the drop; bumping here would make the supervisor's own next
/// generation re-check fail and abort itself. A genuine user reconnect goes through
/// `vpn_connect` (which bumps) and that is exactly what neutralizes a stale
/// supervisor (Codex HIGH).
///
/// All failures are logged + tolerated (the supervisor counts the attempt as failed
/// when `wait_for_connected` times out); this fn never returns an error to keep the
/// bounded loop simple.
pub async fn respawn_sidecar(app: &tauri::AppHandle, config_path: &str, log_level: &str) {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => {
            crate::logging::log_app("WARN", "[reconnect] AppState unavailable — respawn skipped");
            return;
        }
    };

    // 1. Fully kill the prior child (PID/job) so the WinTUN adapter is released
    //    before the new spawn (Pitfall 3). On a process-death drop this is already
    //    None; on a live-sidecar connectivity loss this kills the dead-tunnel child.
    {
        let prior = state.sidecar_child.lock().ok().and_then(|mut g| g.take());
        if let Some(child) = prior {
            child.child.kill().ok();
        }
    }
    // 2. Sweep any stale saved-PID sidecar (per-edition, never image-name — D-07).
    kill_stale_sidecar();

    // 3. Canonicalize the config path (path-traversal guard — same as vpn_connect).
    let config_path = match std::fs::canonicalize(config_path) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            crate::logging::log_app("WARN", &format!("[reconnect] invalid config path: {e}"));
            return;
        }
    };

    // 4. Re-resolve + apply routing rules (reuse the GeoData state from AppState).
    if let Some(geodata_state) = app.try_state::<Arc<GeoDataState>>() {
        let rules = routing_rules::load_routing_rules().unwrap_or_default();
        if let Err(e) =
            routing_rules::resolve_and_apply_inner(&config_path, &rules, geodata_state.as_ref())
        {
            crate::logging::log_app(
                "WARN",
                &format!("[reconnect] routing rules resolve failed: {e}"),
            );
        }
    }

    // 5. Reset disconnecting + spawn the job-armed sidecar (Plan 03).
    //
    // WR-05: re-check intent IMMEDIATELY before clearing the flag / spawning. The
    // bounded loop already re-checks `user_disconnected()` before each attempt, but
    // a user can click Disconnect in the small window AFTER that pre-attempt guard
    // passed and BEFORE we get here. Without this re-check, `respawn_sidecar` would
    // clear the `disconnecting` flag the user just set and spawn a sidecar they did
    // not want. If a disconnect is observed now, bail WITHOUT clearing the flag — the
    // next loop iteration's generation/intent guard then aborts the supervisor.
    // WR-05 + Codex BLOCKER (UAT 65692c): check the disconnect intent and clear it under
    // ONE lock acquisition. The old code took the lock to CHECK `*d`, released it, then
    // re-took it to WRITE `*d = false` — a user vpn_disconnect / quit that set
    // `disconnecting = true` in that gap was immediately overwritten back to `false`, so
    // the supervisor spawned + STORED a fresh sidecar AFTER the cancel: a leaked session
    // with a stuck killswitch (exactly the class of drop-vs-recovery race this phase
    // fixes). Holding the guard across the check+clear closes the TOCTOU.
    // T-31: also honor the DURABLE user-disconnect intent here. `disconnecting` may
    // already have been cleared by a completed `vpn_disconnect` (its end-of-fn reset),
    // so checking it alone can miss a user disconnect that landed during this respawn.
    // The durable flag persists until the next vpn_connect, so it closes that gap: if
    // the user requested disconnect, do NOT spawn a sidecar they don't want — bail so
    // the loop's post-attempt intent guard aborts the supervisor to Disconnected.
    if state.user_disconnect_requested.load(Ordering::SeqCst) {
        crate::logging::log_app(
            "INFO",
            "[reconnect] durable user-disconnect intent set before respawn — aborting respawn (T-31)",
        );
        return;
    }
    {
        let mut d = state
            .disconnecting
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *d {
            crate::logging::log_app(
                "INFO",
                "[reconnect] disconnect observed before respawn — aborting respawn (WR-05)",
            );
            return;
        }
        *d = false;
    }
    let sidecar_log_level = match log_level {
        "error" | "warn" => "info",
        other => other,
    };
    let child_arc = Arc::clone(&state.sidecar_child);
    let disc_arc = Arc::clone(&state.disconnecting);
    let child = match sidecar::spawn_trusttunnel(
        app,
        &config_path,
        sidecar_log_level,
        child_arc,
        disc_arc,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => {
            crate::logging::log_app("WARN", &format!("[reconnect] respawn failed: {e}"));
            return;
        }
    };
    // 02-10 (Tier-3, T-10-05): re-check intent AFTER the spawn `.await`, BEFORE storing
    // the child. WR-05 above closes the PRE-spawn window, but spawn_trusttunnel is async
    // — a user can press Disconnect WHILE the spawn is in flight. Without this post-await
    // re-check, we would store `Some(child)` for a sidecar the user no longer wants:
    // vpn_disconnect already ran and took `None` (the child wasn't stored yet), so its
    // kill is a no-op, and the freshly-spawned sidecar stays ALIVE behind a UI that says
    // "disconnected" (a zombie tunnel — Gemini's deeper post-await window). If a
    // disconnect arrived, kill the fresh child and RETURN without storing it.
    if state.disconnecting.lock().map(|g| *g).unwrap_or(false) {
        crate::logging::log_app(
            "INFO",
            "[reconnect] disconnect observed after spawn — killing fresh child, not storing (T-10-05)",
        );
        child.child.kill().ok();
        return;
    }

    save_sidecar_pid(child.child.pid());
    {
        if let Ok(mut guard) = state.sidecar_child.lock() {
            *guard = Some(child);
        }
    }

    // 6. Mark Reconnecting through the single mutator; the sidecar markers flip it to
    //    Connected on a successful handshake, which the supervisor waits on.
    //
    // 02-20 status-UX split: a respawn is a RE-establish, not a FIRST connect, so it
    // is «Переподключение» (Reconnecting), NOT «Подключение» (Connecting). The
    // server-silent supervisor already set the per-attempt Reconnecting+«Попытка N/N»
    // before calling us; this keeps the status on Reconnecting through the actual
    // sidecar (re)spawn rather than briefly flipping it to the first-connect label.
    set_vpn_status(app, &state, VpnStatus::Reconnecting, None);
}

#[tauri::command]
pub async fn vpn_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    // Always set disconnecting flag first — even if sidecar hasn't spawned yet.
    // This prevents vpn_connect from spawning a sidecar after cancel.
    if let Ok(mut d) = state.disconnecting.lock() { *d = true; }

    // T-31: also raise the DURABLE user-disconnect intent. Unlike `disconnecting`
    // (cleared at the end of this fn — WR-01), this stays set until the next
    // `vpn_connect`, so a reconnect supervisor that re-reads intent AFTER this
    // disconnect completes still sees "the user wants to be disconnected" and aborts
    // an in-flight respawn to a clean Disconnected instead of letting it flip the
    // session back to Connected (the double-press UAT bug). Set BEFORE the generation
    // bump so the supervisor can never observe the bump without also seeing the intent.
    state.user_disconnect_requested.store(true, Ordering::SeqCst);

    // Bump the connection generation so any in-flight connect-timeout watchdog from
    // the session being torn down sees a generation mismatch and neutralizes itself
    // (Codex HIGH stale-actor guard) — a user disconnect must never be fought, and
    // the watchdog must never kill the next session a fast reconnect may start.
    state.connection_generation.fetch_add(1, Ordering::SeqCst);

    // Take child out and drop guard before async call
    let child = {
        let mut guard = state
            .sidecar_child
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        guard.take()
    };

    // AUDIT-2026-06-11 #20/#22: capture the kill result instead of `?`-returning on it.
    // The old `?` bailed out BEFORE the hosts cleanup, the DNS restore, the Disconnected
    // status write AND the WR-01 `disconnecting=false` reset — so a kill failure (both
    // hard paths denied, e.g. AV interference) left the session in a stuck partial
    // state: tray frozen on «Отключение…», `disconnecting` latched true forever (which
    // suppressed every future recovery — the WR-01 landmine), hosts block and stranded
    // DNS never cleaned, and the already-taken child handle made a retry-press a no-op.
    // Once a disconnect has BEGUN, the teardown steps below must be unconditional —
    // the same always-cleanup principle the tray disconnect path already follows.
    let mut kill_error: Option<String> = None;
    if let Some(child) = child {
        if let Ok(mut d) = child.disconnecting.lock() { *d = true; }
        // WR-06: kill_sidecar can take seconds (force taskkill). The tray icon is
        // driven only by vpn-status events and none fires until the kill returns,
        // so without this the tray icon stays on the previous (e.g. "connected")
        // state while the main window already shows "disconnecting". Proactively
        // refresh the tray icon to the transient bucket so the two surfaces agree
        // during the kill. No new backend status (D-09): "disconnecting" is the
        // existing FE-local transient label; vpn_status is untouched here.
        crate::tray::update_tray_icon(&app, "disconnecting");
        // D-08 lifecycle marker (8): sidecar killed on exit — fixed phrase,
        // DEV-gated (D-11). Emitted next to the kill where `app` is in scope.
        sidecar::emit_killed_on_exit_marker(&app);
        if let Err(e) = sidecar::kill_sidecar(child).await {
            kill_error = Some(format!("Failed to stop sidecar: {e}"));
        }
    }

    if kill_error.is_none() {
        crate::logging::log_app("INFO", "VPN disconnected");
    } else {
        // FIXED phrase (no raw error text on this line — the mapped Err carries the
        // detail back to the frontend; D-29).
        crate::logging::log_app(
            "WARN",
            "VPN disconnect: kill_sidecar failed — running unconditional cleanup anyway (#20)",
        );
    }

    // Clean up hosts file blocked entries on disconnect — ALWAYS, even on kill failure.
    routing_rules::cleanup_hosts_block().ok();

    // FIX-A (RC-2): restore the pre-VPN system DNS (+flush). The hard-killed C++ sidecar
    // never restores it, so without this the system stays on the dead tunnel resolver and
    // Claude Code keeps returning 403 until a CC restart. ALWAYS runs (#20).
    crate::dns_guard::restore_system_dns();

    if let Some(err) = kill_error {
        // AUDIT-2026-06-11 #20: an HONEST terminal status through the single mutator
        // (D-01) instead of the stale pre-disconnect status. The sidecar may genuinely
        // still be alive holding the killswitch (kill_sidecar errs only when BOTH hard
        // paths failed), so Disconnected would be a lie — Error with the STABLE ASCII
        // reason code "disconnect-failed" (D-29: fixed token, no secrets; display text
        // is the frontend's i18n job) tells the truth and un-sticks the tray from the
        // transient "disconnecting" bucket forced above.
        set_vpn_status(
            &app,
            &state,
            VpnStatus::Error,
            Some("disconnect-failed".to_string()),
        );
        // WR-01 reset still applies on the failure path: leaving `disconnecting`
        // latched true at rest would suppress every future recovery decision
        // (declare_offline_and_handoff / run_recovery_flow read it as "user is
        // disconnecting"). The Terminated arm's `was_intentional` read happened
        // DURING kill_sidecar above, so clearing here cannot race it.
        if let Ok(mut d) = state.disconnecting.lock() { *d = false; }
        return Err(err);
    }

    set_vpn_status(&app, &state, VpnStatus::Disconnected, None);

    // WR-01: clear the process-wide `disconnecting` intent flag now that the
    // disconnect is fully complete. The flag was set `true` at the top of this fn
    // (and the sidecar's own copy, set in the take+kill block above) so the Terminated arm
    // could classify the kill as INTENTIONAL and suppress the reconnect supervisor.
    // That read happens DURING `kill_sidecar` above (sidecar.rs reads
    // `was_intentional` while the process is being torn down), which completes
    // before this final `set_vpn_status(Disconnected)` — so clearing AFTER it
    // cannot race the Terminated arm into a spurious reconnect. Without this reset
    // the flag would outlive the operation and any FUTURE reader of `disconnecting`
    // on an at-rest session would see a stale `true` (latent landmine).
    if let Ok(mut d) = state.disconnecting.lock() { *d = false; }

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

/// Snapshot command — returns the current status as the existing wire string so a
/// late-mounting window can sync (D-08). Reads the single `vpn_status` owner (D-01)
/// instead of deriving from `sidecar_child.is_some()` + the legacy bool. The command
/// NAME and `String` return shape are kept identical so the frontend caller
/// (`useVpnEvents.ts` invoke("check_vpn_status")) is untouched in this plan — the
/// wire string is byte-identical (Pattern 3: rename only with the caller).
///
/// 02-20: `Recovering` → `"recovering"` (local-net wait) and `Reconnecting` →
/// `"reconnecting"` (tunnel re-establish) map to their OWN wire strings — NEITHER is
/// collapsed to "disconnected", and they are no longer collapsed onto each other. A
/// window mounting mid-recovery or mid-reconnect must read the true state from the
/// snapshot. Each string is byte-identical to its `VpnStatus` serde wire string, so
/// the snapshot and the live `"vpn-status"` event agree.
#[tauri::command]
pub fn check_vpn_status(state: tauri::State<'_, AppState>) -> String {
    let status = state
        .vpn_status
        .lock()
        .map(|g| *g)
        .unwrap_or(VpnStatus::Disconnected);
    match status {
        VpnStatus::Connected => "connected",
        VpnStatus::Connecting => "connecting",
        VpnStatus::Error => "error",
        // 02-20: the two distinct states map to their OWN wire strings — no collapse.
        VpnStatus::Recovering => "recovering",
        VpnStatus::Reconnecting => "reconnecting",
        VpnStatus::Disconnected => "disconnected",
    }
    .to_string()
}

/// Snapshot command that returns BOTH the status AND its error detail (Codex
/// MEDIUM — late-mount loses the error reason). `check_vpn_status` above is kept
/// untouched (still returns a bare `String`) so existing callers don't break; this
/// companion command is additive. The returned payload reuses the EXACT
/// `{ status, error }` shape of the `"vpn-status"` event (D-05), so a window
/// mounting after an `error` event can restore the reason the same way a live
/// event would deliver it. `error` is the already-sanitized stored copy (D-29).
///
/// 02-20: `Recovering` ("recovering") and `Reconnecting` ("reconnecting") are
/// preserved intact and serialize to their OWN wire strings — the snapshot NEVER
/// collapses either to "disconnected" nor onto each other. A window mounting
/// mid-recovery or mid-reconnect restores the true state (and the reason, if any)
/// from this snapshot, exactly as a live `"vpn-status"` event would deliver it
/// (T-08-02).
#[tauri::command]
pub fn check_vpn_status_full(state: tauri::State<'_, AppState>) -> VpnStatusPayload {
    let status = state
        .vpn_status
        .lock()
        .map(|g| *g)
        .unwrap_or(VpnStatus::Disconnected);
    let error = state
        .last_error
        .lock()
        .map(|g| g.clone())
        .unwrap_or(None);
    // The snapshot never carries a live per-attempt counter — `attempt`/`max` are a
    // transient progress signal on the live event, not persisted state (a window that
    // mounts mid-reconnect reads the status + reason from here and starts its counter
    // at the next live attempt event). Both `None` → the snapshot serializes to the
    // byte-identical `{status, error}` shape (the skip_serializing_if drops them).
    VpnStatusPayload { status, error, attempt: None, max: None }
}

/// Clear a VPN error from ALL windows (02-09, UAT Gap #3).
///
/// The React error banner used to dismiss the error with LOCAL state only
/// (`setErrorDismissed(true)`), so the error lingered on every OTHER window and
/// could re-surface from the `check_vpn_status_full` snapshot on the next mount.
/// This command is the single backend source of truth for the dismiss: it routes
/// `VpnStatus::Disconnected` through the ONE `set_vpn_status` writer, which clears
/// `last_error` to `None` and fans the `"vpn-status"` event out to the main window,
/// the tray webview, and the Rust `listen_any` (tray icon) — so the error clears
/// EVERYWHERE at once, and a late-mounting window's snapshot no longer carries it.
///
/// T-09-02 (Tampering): this is a NO-OP unless the current status is `Error`. A
/// window must never be able to clobber a live `Connecting` / `Connected` /
/// `Recovering` / `Reconnecting` session by calling this — the dismiss is only legal from `Error`,
/// the one state where moving to `Disconnected` is the correct "acknowledge and
/// clear" transition.
#[tauri::command]
pub fn clear_vpn_error(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    let is_error = state
        .vpn_status
        .lock()
        .map(|g| *g == VpnStatus::Error)
        .unwrap_or(false);
    if !is_error {
        // Not in Error → do NOT clobber an active session (T-09-02). A stray dismiss
        // from a stale window can never knock a live connect/connection offline.
        return;
    }
    // Legal Error → Disconnected acknowledge: route through the single writer so the
    // clear (status + last_error=None) broadcasts to every window + the tray.
    set_vpn_status(&app, &state, VpnStatus::Disconnected, None);
}

/// Phase 13 (D-06 / §C) — mirror the FE master notifications toggle into the Rust gate.
///
/// The FE calls this whenever `useAppSettings.setNotificationsOn` writes the toggle AND once at
/// startup, so the Rust firing seam (`notify::maybe_fire`) can gate the plate even with the main
/// window closed to tray (localStorage is NOT shared across webview windows — Pitfall 5). This
/// carries ONLY a `bool` — never config content or a password (D-29 / T-13-SEC-01), and it writes
/// no log line. The mirror is `Relaxed`: there is no ordering dependency between this store and the
/// status write; a fire either sees the pre- or post-toggle value, both consistent.
#[tauri::command]
pub fn set_notifications_enabled(enabled: bool, state: tauri::State<'_, AppState>) {
    state.notifications_enabled.store(enabled, Ordering::Relaxed);
}

/// Phase 13 (Pitfall 2 / §B) — set the pending connect ORIGIN the next `Connected` consumes.
///
/// The FE calls this right BEFORE an AUTO action (auto-switch → `AutoSwitch`; launch auto-connect
/// → `AutoConnectLaunch`) so `notify::maybe_fire`, on the next `Connected`, emits the auto copy
/// instead of the generic «Подключено». `maybe_fire` RESETS the origin to `Manual` after that
/// connected, so it marks only the one intended auto action — a later manual connect reads
/// `Manual`. This carries ONLY a small `ConnectOrigin` enum (no config content / no password —
/// D-29), and writes no log line. Poison-recovering the lock (`into_inner`) so a prior panic on a
/// holder can never wedge the setter.
#[tauri::command]
pub fn set_pending_connect_origin(
    origin: crate::notify::ConnectOrigin,
    state: tauri::State<'_, AppState>,
) {
    let mut g = state
        .pending_connect_origin
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *g = origin;
}

/// Phase 13 (13-08b) — set the pending connect-time PING (ms) the next `Connected` consumes for
/// the plate's detail block.
///
/// FOLLOW-UP fix: the plate used to ping the ACTIVE endpoint fresh at connect time, but a direct
/// TCP connect to the active/connected endpoint reads Unreachable while the tunnel is up (BY DESIGN
/// — see `pending_connect_ping`'s doc on AppState). So the FE pushes the config's RELIABLE
/// reachability ping — measured JUST BEFORE connecting, while it was still inactive, from the
/// `usePerConfigPing` map — via THIS command right before each connect (at the SAME sites that set
/// `set_pending_connect_origin`). `notify::maybe_fire` reads AND consumes it on the terminal
/// `Connected` edge (exactly like the origin) as the plate's `ping_ms`. `None` → the plate renders
/// «—» (honest no-data — e.g. a launch auto-connect before any probe, or an unreachable config).
/// This carries ONLY a numeric ms (no config content / no password — D-29) and writes no log line.
/// Poison-recovering the lock (`into_inner`) mirrors `set_pending_connect_origin` so a prior panic
/// on a holder can never wedge the setter.
#[tauri::command]
pub fn set_pending_connect_ping(ms: Option<u32>, state: tauri::State<'_, AppState>) {
    let mut g = state
        .pending_connect_ping
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *g = ms;
}

/// Phase 13 (BL-01/WR-01) — mark whether a compound switch/reconnect TEARDOWN is in flight.
///
/// `switchTo` and `handleReconnect` are plain `disconnect → connect`; their teardown leg writes a
/// genuine `Connected → Disconnected` transition. The FE calls this with `true` BEFORE that teardown
/// so `notify::maybe_fire` SUPPRESSES the intermediate «Отключено» (the true state mid-switch is
/// "switching", not "disconnected" — D-03/D-01), and clears it (`false`) on the destination terminal
/// outcome. This is a SEPARATE command — it does NOT change `vpn_connect`/`vpn_disconnect`
/// signatures (the C++ sidecar and the connect contract stay untouched). It carries ONLY a `bool`
/// (no config content / no password — D-29) and writes no log line. `Relaxed`: no ordering
/// dependency with the status write — a fire either sees the pre- or post-toggle value, both correct
/// (maybe_fire also clears the flag on the terminal outcome as a durable backstop).
///
/// Phase 13 (13-10 / §A): on `pending == true` this ALSO fires a TRANSIENT START plate so the owner
/// SEES a deliberate switch / manual reconnect in progress (the terminal outcome plate then REPLACES
/// it via the latest-wins staging — D-03). The start kind is picked by the pure
/// `notify::start_plate_wire_key` from the FE-threaded `is_switch` hint (Fable-A review #6: a SERVER
/// SWITCH — manual or auto — fires the NEUTRAL `switching` kind; a same-server save-and-reconnect
/// fires the existing `reconnecting`; the hint exists because BOTH manual flows carry origin=Manual)
/// with the 13-10 pending-ORIGIN mapping as the hintless fallback. The fire is gated by the master
/// notifications mirror (OFF fires nothing) inside `notify::fire_start_plate`. On `false` (the
/// intent-clear leg) it fires nothing. The flag-store behaviour is UNCHANGED — the bool is still
/// stored on both edges. `app: tauri::AppHandle` is INJECTED by Tauri, not passed by the FE (the FE
/// invokes with `{ pending, isSwitch }`; `isSwitch` is an `Option` so the clear legs — and an older
/// FE — may omit it), so this stays a notification-side command: `vpn_connect`/`vpn_disconnect`
/// signatures are untouched. `is_switch` carries ONLY a bool — no config content / password (D-29).
#[tauri::command]
pub fn set_switch_or_reconnect_pending(
    app: tauri::AppHandle,
    pending: bool,
    is_switch: Option<bool>,
    state: tauri::State<'_, AppState>,
) {
    // Fire the start plate BEFORE storing the flag on the `true` edge. The FE `is_switch` hint picks
    // the start kind (switch → `switching`, reconnect → `reconnecting`); the pending origin (set by
    // the FE just before this) is only the hintless fallback. The gate + config-name/theme/language
    // threading live in `notify::fire_start_plate`.
    if pending {
        let origin = state
            .pending_connect_origin
            .lock()
            .map(|g| *g)
            .unwrap_or(crate::notify::ConnectOrigin::Manual);
        // The hint/origin→wire_key mapping is the pure `start_plate_wire_key` (single source of
        // truth, unit-tested): hint Some(true) → `switching`, Some(false) → `reconnecting`,
        // None → the 13-10 origin fallback (AutoSwitch → `switching`, else `reconnecting`).
        let wire_key = crate::notify::start_plate_wire_key(origin, is_switch);
        crate::notify::fire_start_plate(&app, wire_key);
    }

    state
        .switch_or_reconnect_pending
        .store(pending, Ordering::Relaxed);
}

/// Phase 13 (13-06) — coerce a raw FE theme string to one of the two whitelisted plate themes.
///
/// The notification plate's tokens must resolve to the app's EFFECTIVE theme, but a raw string
/// arriving over the IPC boundary must never be trusted blindly (it becomes a `data-theme` attribute
/// value the plate applies). Any value other than the two known-good themes is coerced to `"dark"`
/// — the safe default that matches the `:root` token fallback. Kept as a small pure helper so the
/// whitelist is unit-testable without a live Tauri `State`.
fn normalize_plate_theme(theme: &str) -> String {
    match theme {
        "light" => "light".to_string(),
        // "dark" and anything else (empty / junk / unexpected) → the safe dark default.
        _ => "dark".to_string(),
    }
}

/// Phase 13 (13-06) — mirror the FE effective theme ("dark" | "light") into the Rust plate-theme cell.
///
/// The FE (`useTheme`) calls this whenever the effective theme changes AND once at startup, so
/// `notify::maybe_fire` can stamp the plate's `data-theme` even with the main window closed to tray
/// (localStorage is NOT shared across webview windows — Pitfall 5; the plate webview has its own empty
/// store). Whitelisted to "dark"/"light" via `normalize_plate_theme` — a raw FE string is never
/// trusted blindly. This carries ONLY a short theme string (a 2-value enum-like — no config content
/// or password, D-29) and writes no log line. Poison-recovering the lock (`into_inner`) mirrors
/// `set_pending_connect_origin` so a prior panic on a holder can never wedge the setter.
#[tauri::command]
pub fn set_plate_theme(theme: String, state: tauri::State<'_, AppState>) {
    let mut g = state.plate_theme.lock().unwrap_or_else(|e| e.into_inner());
    *g = normalize_plate_theme(&theme);
}

/// Phase 13 (13-07) — coerce a raw FE language string to one of the two whitelisted plate languages.
///
/// Mirrors `normalize_plate_theme`: a raw string arriving over the IPC boundary must never be trusted
/// blindly (it selects which hardcoded copy the plate renders). Any value other than "en" is coerced
/// to "ru" — the safe default (the app's primary language, matching the previously-hardcoded copy).
/// A small pure helper so the whitelist is unit-testable without a live Tauri `State`.
fn normalize_plate_language(language: &str) -> String {
    match language {
        "en" => "en".to_string(),
        // "ru" and anything else (empty / junk / an unexpected locale) → the safe ru default.
        _ => "ru".to_string(),
    }
}

/// Phase 13 (13-07) — mirror the FE UI language ("ru" | "en") into the Rust plate-language cell.
///
/// The FE (`useLanguage`) calls this whenever the language changes AND once at startup, so
/// `notify::maybe_fire` can select the plate's copy language even with the main window closed to tray
/// (localStorage is NOT shared across webview windows — Pitfall 5; the plate webview has its own empty
/// store). Whitelisted to "ru"/"en" via `normalize_plate_language`. This carries ONLY a short language
/// string (a 2-value enum-like — no config content or password, D-29) and writes no log line.
/// Poison-recovering the lock (`into_inner`) mirrors `set_plate_theme`.
#[tauri::command]
pub fn set_plate_language(language: String, state: tauri::State<'_, AppState>) {
    let mut g = state.plate_language.lock().unwrap_or_else(|e| e.into_inner());
    *g = normalize_plate_language(&language);
}

#[cfg(test)]
mod tests {
    use super::*;

    // RESEARCH A1 — VpnStatus is the FIRST serde-tagged enum in the tree. Lock the
    // wire contract with a round-trip test so a future variant rename can never
    // silently drift the strings that 4 cross-process consumers depend on.

    #[test]
    fn vpn_status_serializes_to_existing_wire_strings() {
        // Each variant must serialize to the exact lowercase string the frontend
        // already expects (D-03 — preserve the current visible vocabulary).
        assert_eq!(serde_json::to_string(&VpnStatus::Connecting).unwrap(), "\"connecting\"");
        assert_eq!(serde_json::to_string(&VpnStatus::Connected).unwrap(), "\"connected\"");
        assert_eq!(serde_json::to_string(&VpnStatus::Disconnected).unwrap(), "\"disconnected\"");
        assert_eq!(serde_json::to_string(&VpnStatus::Error).unwrap(), "\"error\"");
        // 02-20 status-UX split: the former single "recovering" string is now TWO
        // distinct wire strings the frontend, tray and snapshots all speak —
        // `Recovering` → "recovering" (local-net wait, «Восстановление») and
        // `Reconnecting` → "reconnecting" (tunnel re-establish, «Переподключение»).
        // Locking BOTH here so a future rename can never silently drift the
        // cross-process consumers or re-collapse the two states onto one token (T-08-01).
        assert_eq!(serde_json::to_string(&VpnStatus::Recovering).unwrap(), "\"recovering\"");
        assert_eq!(serde_json::to_string(&VpnStatus::Reconnecting).unwrap(), "\"reconnecting\"");
    }

    #[test]
    fn vpn_status_payload_is_byte_identical_to_today() {
        // The flat {status, error} shape must round-trip byte-for-byte (D-05 —
        // error stays a separate Option<String>, never collapsed into the enum).
        // 02-20: the new optional attempt/max fields are `skip_serializing_if =
        // Option::is_none`, so a generic (non-attempt) event is STILL exactly
        // {status, error} — no `attempt`/`max` keys appear. This locks that.
        let payload = VpnStatusPayload {
            status: VpnStatus::Connecting,
            error: None,
            attempt: None,
            max: None,
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            "{\"status\":\"connecting\",\"error\":null}"
        );
    }

    #[test]
    fn reconnecting_attempt_payload_carries_counter_fields() {
        // 02-20 status-UX split: a `reconnecting` event from the server-silent retry
        // supervisor carries the per-attempt index «Попытка N/N». When `attempt`/`max`
        // are Some, they appear on the wire alongside {status, error} so the UI can show
        // progress. Lock the exact bytes so the Stage-2 frontend knows the field names
        // and shape to read.
        let payload = VpnStatusPayload {
            status: VpnStatus::Reconnecting,
            error: None,
            attempt: Some(2),
            max: Some(3),
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            "{\"status\":\"reconnecting\",\"error\":null,\"attempt\":2,\"max\":3}"
        );
    }

    #[test]
    fn snapshot_payload_carries_status_and_error_with_event_shape() {
        // Codex MEDIUM — the late-mount snapshot must expose BOTH status and error,
        // using the EXACT {status, error} wire shape of the "vpn-status" event (D-05),
        // so a window mounting after an error can restore the reason the same way a
        // live event would. Locking the bytes here mirrors the event round-trip test.
        let payload = VpnStatusPayload {
            status: VpnStatus::Error,
            error: Some("Configuration parse error. Check your config file.".to_string()),
            attempt: None,
            max: None,
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            "{\"status\":\"error\",\"error\":\"Configuration parse error. Check your config file.\"}"
        );
        // No-error snapshot still round-trips to the flat null shape.
        let clean = VpnStatusPayload {
            status: VpnStatus::Connected,
            error: None,
            attempt: None,
            max: None,
        };
        assert_eq!(
            serde_json::to_string(&clean).unwrap(),
            "{\"status\":\"connected\",\"error\":null}"
        );
    }

    #[test]
    fn recovering_and_reconnecting_serialize_to_distinct_wire_strings() {
        // 02-20 — the two states each have their OWN canonical wire string and must
        // never collapse onto each other or to "disconnected". `Recovering` is the
        // local-net wait («Восстановление», red); `Reconnecting` is the tunnel
        // re-establish («Переподключение», yellow). This is the contract a
        // late-mounting window, the tray webview and lib.rs `listen_any` all read;
        // locking it here proves the snapshot can never re-merge them or revert to the
        // disconnected collapse that hid an active recovery/reconnect (T-08-01 / T-08-02).
        assert_eq!(serde_json::to_string(&VpnStatus::Recovering).unwrap(), "\"recovering\"");
        assert_eq!(serde_json::to_string(&VpnStatus::Reconnecting).unwrap(), "\"reconnecting\"");
        assert_ne!(
            serde_json::to_string(&VpnStatus::Recovering).unwrap(),
            serde_json::to_string(&VpnStatus::Reconnecting).unwrap(),
            "the two states must be distinguishable on the wire",
        );
    }

    #[test]
    fn snapshot_payload_does_not_collapse_recovering_or_reconnecting_to_disconnected() {
        // 02-20 (T-08-02) — `check_vpn_status_full` never rewrites Recovering or
        // Reconnecting → Disconnected (and never onto each other), so the
        // {status, error} snapshot a late-mounting window reads carries the true wire
        // string. We lock the payload bytes here (the command itself needs AppState,
        // but the payload serialization is the cross-process contract that matters).
        let recovering = VpnStatusPayload {
            status: VpnStatus::Recovering,
            error: None,
            attempt: None,
            max: None,
        };
        assert_eq!(
            serde_json::to_string(&recovering).unwrap(),
            "{\"status\":\"recovering\",\"error\":null}"
        );
        let reconnecting = VpnStatusPayload {
            status: VpnStatus::Reconnecting,
            error: None,
            attempt: None,
            max: None,
        };
        assert_eq!(
            serde_json::to_string(&reconnecting).unwrap(),
            "{\"status\":\"reconnecting\",\"error\":null}"
        );
    }

    // ── Connect-timeout watchdog decision (Plan 02, D-05) ──────────────────
    // The watchdog's three-way abort decision is factored into the pure
    // `decide_timeout_action` so it can be exercised without a real sidecar
    // (RESEARCH Wave 0 — "inject a clock"). These tests drive that helper with the
    // SHORT injected duration the production path uses (`CONNECT_TIMEOUT`) replaced
    // by deciding directly from the post-deadline guard inputs.

    #[test]
    fn watchdog_aborts_when_not_connected_in_window() {
        // After the deadline elapsed with NO `Connected`, NOT disconnecting, and the
        // generation still ours → Abort (kill + honest Error).
        let captured = 5;
        let live = 5; // generation unchanged → still owns the session
        assert_eq!(
            decide_timeout_action(
                /*is_connected=*/ false,
                /*disconnecting=*/ false,
                /*is_already_error=*/ false,
                captured,
                live,
            ),
            WatchdogDecision::Abort,
        );
    }

    #[test]
    fn watchdog_no_op_when_connected() {
        // Reached `Connected` before the deadline → never kill, never Error.
        assert_eq!(
            decide_timeout_action(
                /*is_connected=*/ true,
                /*disconnecting=*/ false,
                /*is_already_error=*/ false,
                5,
                5,
            ),
            WatchdogDecision::NoOp,
        );
    }

    #[test]
    fn watchdog_no_op_when_disconnecting() {
        // Pitfall 5 / D-04: a user-initiated disconnect in flight must NEVER be
        // fought — even though the session is not `Connected` and the generation
        // still matches, `disconnecting == true` forces NoOp.
        assert_eq!(
            decide_timeout_action(
                /*is_connected=*/ false,
                /*disconnecting=*/ true,
                /*is_already_error=*/ false,
                5,
                5,
            ),
            WatchdogDecision::NoOp,
        );
    }

    #[test]
    fn watchdog_no_op_when_already_specific_error() {
        // 02-10 (T-10-04): a SPECIFIC Error (auth / config / Wintun) landed within the
        // window via the fatal-marker path. Even though the session is not `Connected`,
        // nobody is disconnecting, and the generation still matches, the watchdog must
        // NOT overwrite that specific Error with the generic connect-timeout → NoOp.
        assert_eq!(
            decide_timeout_action(
                /*is_connected=*/ false,
                /*disconnecting=*/ false,
                /*is_already_error=*/ true,
                5,
                5,
            ),
            WatchdogDecision::NoOp,
        );
    }

    #[test]
    fn watchdog_no_op_when_generation_advanced() {
        // Codex HIGH: a manual reconnect / disconnect bumped the live generation
        // past the captured one → this watchdog is stale and must NOT act, even
        // though the session is not `Connected` and nobody is disconnecting.
        assert_eq!(
            decide_timeout_action(
                /*is_connected=*/ false,
                /*disconnecting=*/ false,
                /*is_already_error=*/ false,
                /*captured=*/ 5,
                /*live=*/ 6,
            ),
            WatchdogDecision::NoOp,
        );
    }

    // ── Stale-sidecar kill is image-validated (02-10, T-10-01) ─────────────
    #[test]
    fn stale_kill_is_image_and_pid_filtered() {
        // The kill MUST carry BOTH an IMAGENAME filter for our sidecar exe AND a
        // PID filter, so a reboot-recycled PID that now belongs to a DIFFERENT
        // image is never force-killed. A blind `["/F","/PID",<pid>]` form (the old
        // behavior) must NOT reappear.
        let args = stale_kill_args(4321);
        assert!(
            args.iter().any(|a| a == &format!("IMAGENAME eq {SIDECAR_IMAGE_NAME}")),
            "must filter on the sidecar image name so a recycled PID on another image is a no-op",
        );
        assert!(
            args.iter().any(|a| a == "PID eq 4321"),
            "must still scope to the exact saved PID",
        );
        assert!(args.iter().any(|a| a == "/F"), "force flag still present for our own crashed sidecar");
        // Regression guard: the blind raw `/PID <pid>` pair must be gone.
        assert!(
            !args.windows(2).any(|w| w[0] == "/PID"),
            "blind /PID kill must not return — it could /F-kill an unrelated recycled PID",
        );
        assert_eq!(SIDECAR_IMAGE_NAME, "trusttunnel_client.exe");
    }

    // ── Stale-PID kill is PATH-validated (AUDIT-2026-06-11 #21) ─────────────
    // IMAGENAME+PID filtering alone cannot tell Pro's sidecar from the co-installed
    // Light edition's (identical image name, different install dir). The pure
    // `stale_pid_kill_allowed` decision must only allow the kill when the candidate
    // process's full executable path provably equals OUR OWN sidecar path; ANY doubt
    // (query failed / own path unresolvable / mismatch) must skip the kill.

    #[test]
    fn stale_pid_kill_allowed_only_for_exact_own_path() {
        let own = r"C:\Program Files\TrustTunnel Pro\trusttunnel_client.exe";
        assert!(
            stale_pid_kill_allowed(Some(own), Some(own)),
            "an exact path match is our own crashed sidecar — kill allowed",
        );
    }

    #[test]
    fn stale_pid_kill_denied_for_other_editions_sidecar() {
        // The cross-edition recycle scenario: Pro's stale PID now belongs to Light's
        // LIVE sidecar — same image name, DIFFERENT install directory. Must skip.
        let light = r"C:\Program Files\TrustTunnel Light\trusttunnel_client.exe";
        let own = r"C:\Program Files\TrustTunnel Pro\trusttunnel_client.exe";
        assert!(
            !stale_pid_kill_allowed(Some(light), Some(own)),
            "a recycled PID on the co-installed edition's live sidecar must NOT be killed",
        );
    }

    #[test]
    fn stale_pid_kill_denied_on_any_doubt() {
        let own = r"C:\Program Files\TrustTunnel Pro\trusttunnel_client.exe";
        // Query failed (process gone / access denied) → unknown identity → skip.
        assert!(!stale_pid_kill_allowed(None, Some(own)));
        // Our own path unresolvable → nothing to compare against → skip.
        assert!(!stale_pid_kill_allowed(Some(own), None));
        assert!(!stale_pid_kill_allowed(None, None));
    }

    #[test]
    fn stale_pid_kill_path_match_is_case_insensitive_and_verbatim_tolerant() {
        // NTFS paths are case-insensitive, and a canonicalized own-path may carry the
        // `\\?\` verbatim prefix while QueryFullProcessImageNameW(PROCESS_NAME_WIN32)
        // returns the plain Win32 form — neither difference is a real identity mismatch.
        assert!(stale_pid_kill_allowed(
            Some(r"c:\program files\trusttunnel pro\TRUSTTUNNEL_CLIENT.EXE"),
            Some(r"C:\Program Files\TrustTunnel Pro\trusttunnel_client.exe"),
        ));
        assert!(stale_pid_kill_allowed(
            Some(r"C:\Program Files\TrustTunnel Pro\trusttunnel_client.exe"),
            Some(r"\\?\C:\Program Files\TrustTunnel Pro\trusttunnel_client.exe"),
        ));
    }

    // ── Connect-path cancel predicate (AUDIT-2026-06-11 #19) ───────────────
    // vpn_connect's pre-spawn AND post-spawn cancel checks must see a Cancel through
    // EITHER flag: the transient `disconnecting` (a vpn_disconnect still in flight)
    // OR the durable `user_disconnect_requested` (a vpn_disconnect that already ran
    // to completion — it resets the transient flag at its end per WR-01, so the
    // transient flag alone misses a completed cancel).

    #[test]
    fn connect_cancelled_sees_transient_in_flight_disconnect() {
        assert!(connect_cancelled(true, false));
    }

    #[test]
    fn connect_cancelled_sees_completed_disconnect_via_durable_flag() {
        // The #19 scenario: Cancel completed during the spawn await — transient flag
        // already reset to false, only the durable T-31 flag remains. Must still
        // count as cancelled, or the fresh child gets stored and connects anyway.
        assert!(connect_cancelled(false, true));
    }

    #[test]
    fn connect_not_cancelled_when_no_intent_flag_set() {
        assert!(!connect_cancelled(false, false));
        // Both set (mid-disconnect) is trivially cancelled too.
        assert!(connect_cancelled(true, true));
    }

    #[test]
    fn disconnect_failed_error_uses_reason_code_not_cyrillic() {
        // AUDIT-2026-06-11 #20: the value vpn_disconnect passes to the single mutator
        // when BOTH kill paths failed is the STABLE ASCII reason code
        // "disconnect-failed" — no Cyrillic, no user-facing display string (that
        // wording is the i18n key on the frontend), no secrets (D-29). Mirrors the
        // connect-timeout reason-code lock below.
        let reason = "disconnect-failed";
        assert!(reason.is_ascii(), "reason code must be ASCII");
        assert!(
            !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic",
        );
        assert_eq!(reason, "disconnect-failed");
    }

    #[test]
    fn timeout_error_uses_reason_code_not_cyrillic() {
        // CLAUDE.md i18n rule + D-29: the value the watchdog passes to the single
        // mutator on timeout is the STABLE ASCII reason code "connect-timeout" — no
        // Cyrillic, no user-facing display string (that wording is the i18n key on
        // the frontend). Lock the exact reason code the watchdog emits.
        let reason = "connect-timeout";
        assert!(reason.is_ascii(), "reason code must be ASCII");
        assert!(
            !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic",
        );
        assert_eq!(reason, "connect-timeout");
    }

    // ── Conflict detection excludes our OWN WinTUN adapter (T-21) ──────────────
    #[test]
    fn conflict_filter_excludes_own_trusttunnel_adapter() {
        // UAT: the conflict detector reported "active VPN adapters from other software:
        // TrustTunnel (vpn.example.com)" — our OWN adapter. The own adapter (identified by
        // its "TrustTunnel (<host>)" Name) MUST be dropped, while a genuine third-party
        // VPN adapter is STILL reported so a real conflict is not hidden.
        let raw = vec![
            "TrustTunnel (vpn.example.com)".to_string(),
            "NordLynx".to_string(),
        ];
        let filtered = filter_out_own_adapter(raw);
        assert_eq!(
            filtered,
            vec!["NordLynx".to_string()],
            "own TrustTunnel adapter removed; third-party adapter preserved",
        );
    }

    #[test]
    fn conflict_filter_preserves_genuine_third_party_adapters() {
        // Over-filtering guard: real third-party VPN/TUN adapters (none carrying our
        // identity) must pass through UNCHANGED — the filter only ever drops our own.
        let raw = vec![
            "WireGuard Tunnel".to_string(),
            "OpenVPN TAP-Windows Adapter V9".to_string(),
            "AmneziaWG".to_string(),
        ];
        let filtered = filter_out_own_adapter(raw.clone());
        assert_eq!(filtered, raw, "no genuine third-party adapter must be over-filtered");
    }

    #[test]
    fn conflict_filter_is_case_insensitive_for_own_identity() {
        // The match is case-insensitive so a casing change in the C++ sidecar's adapter
        // Name (e.g. "trusttunnel (host)") can't slip our own adapter back into the list.
        let raw = vec!["trusttunnel (example.host)".to_string()];
        assert!(
            filter_out_own_adapter(raw).is_empty(),
            "own adapter must be excluded regardless of letter case",
        );
    }

    #[test]
    fn normalize_plate_theme_whitelists_to_dark_or_light() {
        // Truth (13-06): the plate-theme mirror is a 2-value whitelist. The two known-good themes
        // pass through unchanged; ANY other value (empty, junk, an unexpected string, or even a
        // markup-looking payload) is coerced to the safe "dark" default — the raw FE string that
        // becomes the plate's `data-theme` is never trusted blindly.
        assert_eq!(normalize_plate_theme("dark"), "dark");
        assert_eq!(normalize_plate_theme("light"), "light");
        // A junk value → the safe dark default (never echoed back into the attribute).
        assert_eq!(normalize_plate_theme("system"), "dark");
        assert_eq!(normalize_plate_theme(""), "dark");
        assert_eq!(normalize_plate_theme("<script>"), "dark");
        assert_eq!(normalize_plate_theme("DARK"), "dark", "case-sensitive: only exact 'light' passes");
    }

    #[test]
    fn normalize_plate_language_whitelists_to_ru_or_en() {
        // Truth (13-07): the plate-language mirror is a 2-value whitelist. The two known-good languages
        // pass through unchanged; ANY other value (empty, junk, an unexpected locale, or a
        // markup-looking payload) is coerced to the safe "ru" default (the app's primary language) —
        // the raw FE string that selects the plate's copy language is never trusted blindly.
        assert_eq!(normalize_plate_language("ru"), "ru");
        assert_eq!(normalize_plate_language("en"), "en");
        // A junk / unexpected value → the safe ru default.
        assert_eq!(normalize_plate_language("de"), "ru");
        assert_eq!(normalize_plate_language(""), "ru");
        assert_eq!(normalize_plate_language("<script>"), "ru");
        assert_eq!(normalize_plate_language("EN"), "ru", "case-sensitive: only exact 'en' passes");
    }
}
