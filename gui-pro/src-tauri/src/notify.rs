//! Custom in-app / desktop connection notification model — Phase 13 (Plan 13-01, Wave 0).
//!
//! This module owns the PURE firing/copy/gating policy for the connection notification
//! plate: given a VPN status transition (`prev` → `next`), the origin of a connect
//! (manual / auto-switch / auto-connect-on-launch), and the master notifications gate,
//! it decides WHICH notification kind (if any) fires. It performs NO window I/O and emits
//! NO event — the window/emit wiring lands in a later wave; this module stays a pure,
//! unit-testable decider so the whole policy is Nyquist-testable before the window exists.
//!
//! D-29 CONTRACT (T-13-SEC-01): this module carries ONLY a notification KIND plus the
//! config DISPLAY NAME. It NEVER carries the `.toml` content, the endpoint host, or the
//! endpoint password, and it emits NO log line that interpolates config content. The
//! notification payload the later waves build from a `NotifyKind` is (kind + display-name)
//! only. A named `d29_no_secret_in_notify_payload_or_log` test guards this from the first
//! commit so the Wave-1 implementation is forced to fill a real leak test — mirroring the
//! ping.rs SUPER-SECRET fixture discipline.

use crate::commands::vpn::AppState;
use crate::commands::vpn::VpnStatus;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// The SEVEN production notification kinds the plate can render (D-01, D-25).
///
/// These are OUTCOME states only — the two transient wire-states (`Connecting`,
/// `Disconnecting`) are deliberately NOT kinds (D-01 drops them; a plate that fired on
/// every transient flicker would be noise). The auto-mode kinds (`AutoSwitched`,
/// `AutoConnectLaunch`) are distinguished from a plain `Connected` by the `ConnectOrigin`
/// carried alongside the transition, NOT by any VPN wire-state (Pitfall 2 — the sidecar
/// exposes no "was this auto?" bit).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum NotifyKind {
    /// Manual connect reached `Connected` — «Подключено».
    Connected,
    /// A connect attempt ended in `Error` — «Ошибка подключения» (sticky, D-02).
    ConnectionError,
    /// The tunnel is being re-established (`Reconnecting`) — «Переподключение».
    Reconnecting,
    /// Local-network loss wait (`Recovering`) — «Восстановление сети» (IN-02: aligned to the
    /// rendered FE title in `notificationCopy.ts` and D-01's CONTEXT list; the two source-of-truth
    /// strings were drifting — «связи» here vs «сети» in the plate).
    Recovering,
    /// The auto-switch engine moved to a healthier server (origin = AutoSwitch).
    AutoSwitched,
    /// Auto-connect-on-launch reached `Connected` (origin = AutoConnectLaunch).
    AutoConnectLaunch,
    /// The tunnel went down to `Disconnected` — «Отключено».
    Disconnected,
    /// The user CANCELLED an in-flight connect (pressed «Отмена» while Connecting/Recovering) —
    /// «Подключение отменено». This is a DIFFERENT event from `Disconnected` (owner requirement): a
    /// cancel aborts a connect that never completed, so «Отключено» («the tunnel went down») would be
    /// wrong copy. It is classified NEUTRAL exactly like `Disconnected` (not a success). Distinguished
    /// from a plain `Disconnected` by the FE-raised `pending_cancel` intent the caller threads into
    /// `decide_notification` — the sidecar/VpnStatus alone cannot tell a user-cancel from a teardown.
    Cancelled,
}

impl NotifyKind {
    /// The wire key the plate's `notificationCopy` map is keyed by (the FE `NotifyKind` string).
    /// These MUST match the camelCase keys in `notificationCopy.ts` exactly — the `notify-plate`
    /// event carries this string and the plate looks the copy up by it. Kept as an explicit,
    /// audited mapping (not a serde derive) so a Rust rename can never silently drift the FE key.
    fn wire_key(self) -> &'static str {
        match self {
            NotifyKind::Connected => "connected",
            NotifyKind::ConnectionError => "connectionError",
            NotifyKind::Reconnecting => "reconnecting",
            NotifyKind::Recovering => "recovering",
            NotifyKind::AutoSwitched => "autoSwitched",
            NotifyKind::AutoConnectLaunch => "autoConnected",
            NotifyKind::Disconnected => "disconnected",
            NotifyKind::Cancelled => "cancelled",
        }
    }

    /// Phase 13 (13-08): is this a CONNECT kind — the ones that carry the richer detail block
    /// (address / login / ping)? Only the three "we reached a connected server" outcomes qualify:
    /// a manual `Connected`, an `AutoSwitched`, and an `AutoConnectLaunch`. The compact kinds
    /// (disconnect / error / reconnect / recovering) NEVER carry details (owner: reconnecting etc.
    /// stay compact) — for them the plate reads a config name only, no async ping.
    fn is_connect(self) -> bool {
        matches!(
            self,
            NotifyKind::Connected | NotifyKind::AutoSwitched | NotifyKind::AutoConnectLaunch
        )
    }
}

/// Why a connect happened — the missing bit the VPN wire-state cannot express (Pitfall 2).
///
/// A `Connected` transition alone cannot tell «пользователь нажал» from «движок сам
/// переключил» from «автоподключение при запуске»; the caller supplies the origin so the
/// decider can map an otherwise-identical `Connecting → Connected` onto the right kind.
/// Serde-derived because a later-wave command (`set_pending_connect_origin`) accepts it
/// over the Tauri IPC boundary.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectOrigin {
    /// The user pressed connect / switch in the UI.
    Manual,
    /// The auto-switch engine picked a healthier server.
    AutoSwitch,
    /// Auto-connect-on-launch fired at startup.
    AutoConnectLaunch,
}

/// Pure decider: given a status transition, the connect origin, the master gate, and whether a
/// compound switch/reconnect teardown is in flight, return the notification kind that should fire —
/// or `None` when nothing should.
///
/// It is edge-triggered (a `prev == next` snapshot must fire nothing — Pitfall 3), gated
/// (`notifications_on == false` → always `None`), and maps the auto-mode kinds via `origin`
/// (Pitfall 2).
///
/// BL-01/WR-01/WR-02: it SUPPRESSES a `Disconnected` that is not a genuine user disconnect — either
/// the teardown half of a compound action (switch / manual reconnect), signalled by
/// `switch_teardown_pending` (a durable AppState intent the FE raises before the teardown; the true
/// state mid-switch is "switching", never "disconnected"), OR an error-acknowledge (`clear_vpn_error`
/// routes `Error → Disconnected` to clear the banner, detected purely from `prev == Error`). A
/// GENUINE user disconnect (`prev != Error`, no teardown in flight) STILL fires «Отключено».
///
/// F17 (14-UAT round 2): `switch_teardown_pending` is now an AGGREGATE the caller (`maybe_fire`)
/// computes as `switch_or_reconnect_pending || seamless_switch_active` — see `maybe_fire` for why the
/// whole-switch-window flag must also suppress the intermediate «Отключено» (a failed B / the revert
/// leg produce transient `→ Disconnected` edges after the teardown flag has already been dropped).
/// The pure policy is unchanged: a `Disconnected` under this aggregate (or an error-acknowledge) is
/// suppressed; a genuine user disconnect still fires «Отключено».
///
/// Part B (cancel notification): `cancel_pending` (the FE-raised user-cancel intent the caller
/// threads in) maps a `Disconnected` that ends an in-flight connect the user cancelled to
/// `NotifyKind::Cancelled` («Подключение отменено») INSTEAD of `Disconnected` («Отключено») — a cancel
/// and a disconnect are DIFFERENT events (owner requirement). It applies ONLY when neither existing
/// suppression wins (`!switch_teardown_pending && prev != Error`), so a switch/reconnect teardown and
/// an error-acknowledge still take precedence.
///
/// It reads NO I/O and touches NO window.
pub fn decide_notification(
    prev: VpnStatus,
    next: VpnStatus,
    origin: ConnectOrigin,
    notifications_on: bool,
    switch_teardown_pending: bool,
    cancel_pending: bool,
) -> Option<NotifyKind> {
    // The master gate dominates: with notifications off the plate never fires (D-04).
    if !notifications_on {
        return None;
    }

    // Edge-detection (Pitfall 3): the decider is edge-triggered. A `prev == next` snapshot
    // is a status poll re-reporting the SAME level, not a transition — it must fire nothing,
    // so a repeated status read never re-surfaces the plate. Only a genuine level change
    // (prev != next) is a candidate to fire.
    if prev == next {
        return None;
    }

    // The transient wire-states `Connecting` and (3.4 R-DCT) `Disconnecting` are deliberately NOT
    // NotifyKinds (D-01): a plate that fired on every in-flight flicker would be noise. A transition
    // LANDING on either fires nothing — the genuine outcome plate fires on the SETTLED edge
    // (`Disconnecting → Disconnected` fires «Отключено» via the `Disconnected` arm below, gated by
    // `switch_teardown_pending` exactly as before). Before 3.4 the «отключение…» phase was only a
    // boolean (`AppState.disconnecting`) and its terminal wire-state was `Disconnected`; now the
    // teardown is a real transient status, so BOTH `Connecting` and `Disconnecting` reach this decider
    // and both map to None.
    match next {
        VpnStatus::Connecting => None,
        VpnStatus::Disconnecting => None,

        // A genuine transition to an OUTCOME state maps `next` to a NotifyKind.
        VpnStatus::Error => Some(NotifyKind::ConnectionError),
        VpnStatus::Reconnecting => Some(NotifyKind::Reconnecting),
        VpnStatus::Recovering => Some(NotifyKind::Recovering),

        // BL-01/WR-01/WR-02: a `Disconnected` fires «Отключено» ONLY when it is a genuine user
        // disconnect. Suppress it when it is merely the teardown half of a compound switch/reconnect
        // (the FE-raised `switch_teardown_pending`) or an error-acknowledge (`prev == Error`, the
        // `clear_vpn_error` path). Otherwise a switch/reconnect flashed «Отключено» before its real
        // destination plate, and dismissing an error banner popped a phantom «Отключено» — both
        // contradicting D-03 ("one plate reflecting the CURRENT state") and D-01 (fire on the OUTCOME).
        VpnStatus::Disconnected => {
            // Part B (cancel notification): a USER CANCEL of an in-flight connect must show
            // «Подключение отменено» (Cancelled), NOT «Отключено» (Disconnected) — they are DIFFERENT
            // events (owner requirement): a cancel aborts a connect that never completed. The FE raises
            // `pending_cancel` when the user presses «Отмена» while Connecting/Recovering, and the caller
            // threads it here. A cancel lands in THIS arm as Connecting→Disconnected OR
            // Disconnecting→Disconnected (either teardown path of an aborted connect). It takes priority
            // over the plain Disconnected copy, BUT NOT over the two existing suppressions:
            //   - `switch_teardown_pending` still wins (a switch/reconnect teardown is not a cancel — its
            //     real destination plate follows; guarding on it also means a seamless switch that somehow
            //     set cancel_pending is treated as a teardown, never a phantom «Подключение отменено»),
            //   - `prev == Error` still wins (an error-acknowledge is not a cancel — WR-02).
            if cancel_pending && !switch_teardown_pending && prev != VpnStatus::Error {
                Some(NotifyKind::Cancelled)
            } else if switch_teardown_pending || prev == VpnStatus::Error {
                None
            } else {
                Some(NotifyKind::Disconnected)
            }
        }

        // Connected is the one outcome whose KIND depends on WHY the connect happened
        // (Pitfall 2 — auto-vs-manual is not observable from VpnStatus alone; the caller
        // supplies it via `origin`). An otherwise-identical Connecting → Connected maps to
        // AutoSwitched / AutoConnectLaunch / Connected purely by origin.
        VpnStatus::Connected => Some(match origin {
            ConnectOrigin::AutoSwitch => NotifyKind::AutoSwitched,
            ConnectOrigin::AutoConnectLaunch => NotifyKind::AutoConnectLaunch,
            ConnectOrigin::Manual => NotifyKind::Connected,
        }),
    }
}

/// Pure predicate: does THIS transition consume the pending connect origin?
///
/// The origin (`AppState.pending_connect_origin`) is a one-shot signal an auto action sets before
/// its connect; it must be spent (reset to `Manual`) by exactly the ONE attempt it was set for,
/// regardless of that attempt's outcome (Pitfall 2 + CR-01). An auto attempt sets the origin BEFORE
/// the connect, and the connect can end THREE ways: `Connected` (worked), `Error` (bad config /
/// timeout / sidecar exit) OR `Disconnected` (torn down without connecting). Consuming ONLY on
/// `Connected` was the CR-01 leak — a FAILED auto attempt left the origin set and the NEXT manual
/// connect read the stale auto origin and mislabelled itself «Автоподключение при запуске» /
/// «Переключено автоматически». So a genuine transition (prev != next) landing on ANY of the three
/// terminal outcomes consumes it; a `prev == next` snapshot (no real transition) or a transition to
/// a still-in-flight state (`Connecting` / `Reconnecting` / `Recovering`) does NOT — the attempt is
/// not finished. Kept pure (no AppState, no locks) so it is unit-testable exactly like
/// `decide_notification`; `maybe_fire` owns the actual lock+reset.
fn origin_consumed_on(prev: VpnStatus, next: VpnStatus) -> bool {
    prev != next
        && matches!(
            next,
            VpnStatus::Connected | VpnStatus::Error | VpnStatus::Disconnected
        )
}

/// Pure predicate (13-10b): does THIS edge consume the pending origin + connect-time ping?
///
/// It is `origin_consumed_on` EXCEPT it does NOT consume on the INTERMEDIATE teardown `Disconnected`
/// of a switch/reconnect (`switch_teardown_pending == true`). A switch/reconnect attempt terminates at
/// its DESTINATION `Connected` (or `Error`), NOT at the teardown `Disconnected` in the middle — so the
/// origin + ping must SURVIVE that teardown to reach the destination `Connected` edge. Consuming on the
/// teardown was the bug behind "an auto-switch shows «Подключено» + «—»": the teardown
/// `Connected → Disconnected` reset both, so the target `Connected` read `Manual`/`None` instead of
/// `AutoSwitch` + the target ping. A GENUINE user disconnect (no teardown pending) STILL consumes
/// (CR-01 preserved), and `Connected`/`Error` always consume — a failed switch/attempt never leaks a
/// stale origin/ping. Kept pure so it is unit-testable without an AppHandle, like `origin_consumed_on`.
fn origin_ping_consumed_on(prev: VpnStatus, next: VpnStatus, switch_teardown_pending: bool) -> bool {
    origin_consumed_on(prev, next) && !(next == VpnStatus::Disconnected && switch_teardown_pending)
}

/// Part A (visibility gate) — pure predicate: should the DESKTOP plate actually fire, given the
/// main window's current visibility?
///
/// The owner rule: the custom desktop notification plate exists to inform the user when the app is
/// NOT in front of them (minimized, hidden-to-tray, or closed-to-tray). When the main window IS
/// visible on screen and not minimized, the user is looking at the app and the in-app FE snackbar
/// already reports the same transition — a second desktop plate would be redundant noise. So the
/// plate fires ONLY when the main window is hidden OR minimized:
///   - visible AND not minimized → `false` (suppress — the FE snackbar covers it),
///   - hidden (any reason) → `true`,
///   - minimized → `true` (a minimized window is not "in front of the user" either).
///
/// This is the ONLY visibility policy Part A adds; it lives here (not in `decide_notification`,
/// which stays a PURE status/origin/gate decider with no window concept) so it is unit-testable
/// without a live window, mirroring the other pure predicates in this module. `maybe_fire` reads the
/// live main-window visibility and calls this to decide whether to run the plate-fire tail. It gates
/// ONLY the plate fire — every one-shot consume/reset step in `maybe_fire` (origin, ping,
/// switch-pending clear) runs REGARDLESS of visibility, exactly like the notifications-off path still
/// consumes.
fn should_fire_when(main_visible: bool, main_minimized: bool) -> bool {
    // Fire unless the window is genuinely in front of the user (visible AND not minimized).
    // De Morgan of `!(main_visible && !main_minimized)`: hidden OR minimized → fire.
    !main_visible || main_minimized
}

/// Pure predicate: does THIS transition CLEAR the `switch_or_reconnect_pending` intent?
///
/// The FE raises `AppState.switch_or_reconnect_pending` before a compound switch/reconnect teardown
/// so `maybe_fire` suppresses the intermediate «Отключено» (BL-01/WR-01). The signal must be
/// cleared on the compound action's DESTINATION terminal outcome — `Connected` (the switch/reconnect
/// worked) or `Error` (the destination failed to come up) — NOT on the intermediate teardown
/// `Disconnected` (that is exactly the state being suppressed while the signal is up; clearing there
/// would re-expose the flash on the following connect's own path). The FE ALSO clears it in its
/// terminal branches as a belt-and-suspenders; this Rust-side clear guarantees the signal cannot
/// wedge `true` and permanently swallow a later genuine user disconnect even if the FE never clears
/// (e.g. the connect leg's promise is dropped). A `prev == next` snapshot or a transition to an
/// in-flight state (`Connecting` / `Reconnecting` / `Recovering`) does NOT clear it. Kept pure so it
/// is unit-testable like `origin_consumed_on`; `maybe_fire` owns the actual lock+reset.
fn switch_pending_cleared_on(prev: VpnStatus, next: VpnStatus) -> bool {
    prev != next && matches!(next, VpnStatus::Connected | VpnStatus::Error)
}

/// What THIS status edge does to the `pending_error_config_name` stamp (G-19-6 v5).
///
/// Extracted as a PURE predicate — mirroring `origin_consumed_on` / `switch_pending_cleared_on` — so
/// the stamp policy is unit-testable WITHOUT an AppHandle. This is the exact regression the v3 defect
/// caused (an unconditional take on EVERY edge let the concurrent reconnect's `Connecting` edge drain
/// the stamp before the failed gen's `Error` edge read it); pinning the policy here stops it recurring.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum StampAction {
    /// An ERROR edge: TAKE the stamp and KEEP it — the failed gen stamped its own captured name right
    /// before this Error write, so this is the plate's correct name (used by the ConnectionError branch).
    Consume,
    /// A CONNECTED edge: TAKE the stamp only to CLEAR it (value discarded) — a success means no pending
    /// error name is relevant, bounding a stamp a prior failed attempt left that never hit an Error edge.
    Clear,
    /// Every other edge — CRUCIALLY the CONCURRENT reconnect's `Connecting` edge — leaves the stamp
    /// untouched, so it survives to reach the failed gen's own `Error` maybe_fire (the v3 drain fix).
    Leave,
}

/// Pure: map a status transition to its stamp action. Edge-triggered (`prev == next` snapshots leave
/// the stamp alone — an Error→Error second fatal marker must NOT re-consume). Only the two settled
/// terminal edges act; every in-flight edge (`Connecting` / `Reconnecting` / `Recovering`) and
/// `Disconnecting`/`Disconnected` leaves it — most importantly `Connecting`, whose maybe_fire fires in
/// the window between the failed gen's stamp and its own Error maybe_fire.
fn error_stamp_action(prev: VpnStatus, next: VpnStatus) -> StampAction {
    if prev == next {
        StampAction::Leave
    } else {
        match next {
            VpnStatus::Error => StampAction::Consume,
            VpnStatus::Connected => StampAction::Clear,
            _ => StampAction::Leave,
        }
    }
}

/// The `notify-plate` event payload — the ONLY thing that crosses from Rust into the plate
/// webview (Trust Boundary: Rust decider → plate window). It carries a notification KIND (as the
/// FE wire key) plus the config DISPLAY NAME only — NEVER the `.toml` content, the endpoint host,
/// or the password (D-29 / T-13-SEC-01). `config_name` is serialized as `configName` for the FE.
#[derive(Clone, Serialize)]
struct NotifyPlatePayload {
    kind: &'static str,
    #[serde(rename = "configName")]
    config_name: String,
    /// Phase 13 (13-06) — the app's effective theme ("dark" | "light"), mirrored from the FE via
    /// `set_plate_theme`. The plate webview has its OWN empty localStorage and never learns the theme,
    /// so it stays dark on the light app theme (UAT round-2 defect 1). Threading it in the payload
    /// lets the plate stamp `data-theme` before it renders, so its tokens resolve to the right theme.
    /// D-29: a 2-value theme string is not a secret (already whitelisted to "dark"/"light" Rust-side).
    theme: String,
    /// Phase 13 (13-07) — the app's UI language ("ru" | "en"), mirrored from the FE via
    /// `set_plate_language`. The plate copy was hardcoded Russian; the plate webview has its OWN empty
    /// localStorage and never learns the language, so it stayed Russian on the English app language
    /// (UAT round-3 defect 2). Threading it lets the plate pick the right-language copy before render.
    /// D-29: a 2-value language string is not a secret (whitelisted to "ru"/"en" Rust-side).
    language: String,
    /// Phase 13 (13-08) — the endpoint ADDRESS ("host:port") for a CONNECT kind, so the plate shows
    /// the richer detail block. `None` for the compact kinds (disconnect / error / reconnect) and for
    /// a connect whose config has no usable endpoint. D-29: the endpoint host — NEVER the password.
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
    /// Phase 13 (13-08) — the endpoint LOGIN (username) for a CONNECT kind. `None` for compact kinds.
    /// D-29: the username — NEVER the password.
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<String>,
    /// Phase 13 (13-08) — the connect-time reachability PING in ms for a CONNECT kind. `None` for
    /// compact kinds AND for a connect where the endpoint could not be measured (the plate renders
    /// «—»). Serialized as `pingMs` for the FE.
    #[serde(rename = "pingMs", skip_serializing_if = "Option::is_none")]
    ping_ms: Option<u32>,
}

/// The LATEST notify-plate payload staged by `maybe_fire` before its emit, so the plate can
/// PULL-and-redeliver a fire that beat its listener (13-05 — the emit-before-listener race).
///
/// Root fix (13-05 / UAT test-1 blocker): `maybe_fire` does `app.emit("notify-plate", …)` then
/// `win.show()` unconditionally, but the plate webview attaches its `listen("notify-plate")` only
/// inside a post-mount `useEffect`. Tauri v2 does NOT buffer events for a not-yet-subscribed
/// webview, so a startup auto-connect fire that beats the plate's mount is DROPPED while
/// `win.show()` still runs — an opaque window shown with no content and no auto-dismiss timer (the
/// empty black box). The repo already solves the identical race for deep-links via the
/// read-and-clear `poll_pending_deeplink` pull-model; this struct is the plate's equivalent, but
/// staged IN-MEMORY on `AppState` (like `pending_connect_origin`) rather than on disk. `AppState`
/// is process-scoped, so it resets to `None` at every launch — no stale-from-last-session risk.
///
/// D-29: it carries ONLY the notification KIND (the `wire_key()` string) plus the config DISPLAY
/// NAME — the exact two-display-string surface `NotifyPlatePayload` already emits. NEVER the
/// `.toml` content, the endpoint host, or the password. Its whole type surface is two `String`s,
/// so a secret cannot structurally reach it.
#[derive(Clone)]
pub struct PendingPlate {
    /// The notification kind's `wire_key()` string the FE `notificationCopy` map is keyed by.
    pub kind: String,
    /// The config DISPLAY NAME (D-29 — never the `.toml`, host, or password). May be empty.
    pub config_name: String,
    /// Phase 13 (13-06) — the effective theme ("dark" | "light") at stage time, so a REDELIVERED
    /// (pulled) plate carries the same theme a live event would. Already whitelisted Rust-side; D-29:
    /// a 2-value theme string, no secret.
    pub theme: String,
    /// Phase 13 (13-07) — the UI language ("ru" | "en") at stage time, so a REDELIVERED (pulled)
    /// plate picks the same-language copy a live event would. Whitelisted Rust-side; D-29: no secret.
    pub language: String,
    /// Phase 13 (13-08) — the endpoint ADDRESS ("host:port") for a CONNECT kind, so a REDELIVERED
    /// (pulled) plate carries the same detail block a live event would. `None` for compact kinds.
    /// D-29: the endpoint host — NEVER the password.
    pub address: Option<String>,
    /// Phase 13 (13-08) — the endpoint LOGIN (username) for a CONNECT kind. `None` for compact kinds.
    /// D-29: the username — NEVER the password.
    pub login: Option<String>,
    /// Phase 13 (13-08) — the connect-time reachability PING in ms for a CONNECT kind. `None` for
    /// compact kinds or an unmeasurable endpoint (the plate renders «—»).
    pub ping_ms: Option<u32>,
}

/// The read-and-clear serde payload `pull_pending_plate` returns to the plate — byte-identical in
/// shape to the live `notify-plate` event (`kind` + `configName`), so the plate applies a pulled
/// payload through the exact same render+timer path a live event uses. Owned `String` (not
/// `&'static str`) because it is mapped from the staged `PendingPlate`.
#[derive(Clone, Serialize)]
pub struct PulledPlatePayload {
    kind: String,
    #[serde(rename = "configName")]
    config_name: String,
    /// Phase 13 (13-06) — the effective theme ("dark" | "light") so a pulled redelivery applies the
    /// same `data-theme` a live event does. Serialized as `theme` (matches the live payload).
    theme: String,
    /// Phase 13 (13-07) — the UI language ("ru" | "en") so a pulled redelivery picks the same-language
    /// copy a live event does. Serialized as `language` (matches the live payload).
    language: String,
    /// Phase 13 (13-08) — the CONNECT detail fields so a pulled redelivery shows the same detail block
    /// a live event does. `None` for compact kinds. `address`/`login` serialize under their own names;
    /// `ping_ms` under `pingMs` (matches the live `NotifyPlatePayload`). D-29: never the password.
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    login: Option<String>,
    #[serde(rename = "pingMs", skip_serializing_if = "Option::is_none")]
    ping_ms: Option<u32>,
}

/// Read-and-CLEAR the staged pending plate (13-05) — the plate PULLS this once, AFTER its
/// `notify-plate` listener attaches, to redeliver a fire that beat its mount (the emit-before-
/// listener race). Mirrors the deep-link `poll_pending_deeplink` read-and-delete shape, but
/// over the in-memory `AppState.pending_plate` cell instead of a file.
///
/// Returns `Some({ kind, configName })` when a plate was staged (drained via `take()` so a later
/// mount does not re-pull a stale fire), else `None` (the plate then heals a stray empty window by
/// hiding). If `AppState` is somehow absent, returns `None`.
///
/// D-29: it returns ONLY the staged KIND + display name and writes NO log line — no secret can
/// reach it (the staged `PendingPlate`'s whole surface is two display strings).
#[tauri::command]
pub fn pull_pending_plate(state: tauri::State<'_, AppState>) -> Option<PulledPlatePayload> {
    // Poison-recover the lock like the other AppState locks in this file — a panicked holder must
    // not permanently wedge the pull (which would re-strand the empty-window bug).
    let mut guard = state
        .pending_plate
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // take() reads AND clears in one step: a pulled fire is spent, so a StrictMode re-mount (or any
    // later pull) sees None and does not redeliver a stale plate.
    guard.take().map(|p| PulledPlatePayload {
        kind: p.kind,
        config_name: p.config_name,
        theme: p.theme,
        language: p.language,
        address: p.address,
        login: p.login,
        ping_ms: p.ping_ms,
    })
}

/// Window I/O for the notification plate — kept SEPARATE from the pure `decide_notification`
/// decider above so the policy stays unit-testable without a window. Called from the single VPN
/// status writer (`write_vpn_status_and_emit`) AFTER the `vpn-status` emit, so a fired plate
/// inherits the same "survives the main window closed to tray" property the tray already has
/// (Pattern 3 / Pitfall 1 — the trigger lives in Rust, never in a main-webview React effect).
///
/// On a fire-worthy transition it:
///   1. resolves the active config's DISPLAY NAME from `AppState.config_path` (D-29 — display name
///      only, via `manifest::current_display_name`; empty when there is no active config),
///   2. positions the pre-built hidden `"notification"` window at the bottom-right of the primary
///      monitor's WORK AREA (taskbar-excluded — Pattern 2),
///   3. emits `notify-plate` { kind, configName } and `show()`s the window (never rebuilt).
///
/// Plan 13-04 threads the REAL gate + origin through the decider (replacing 13-03's safe
/// defaults):
///   - the master gate is read from `AppState.notifications_enabled` — the FE-mirrored AtomicBool
///     (Pitfall 5: the plate must gate with the main window closed, and localStorage is not shared
///     across webview windows, so the gate lives in Rust, not localStorage),
///   - the connect origin is read from `AppState.pending_connect_origin` and, on a genuine
///     `Connected` transition, CONSUMED — reset back to `Manual` so it marks ONLY the one intended
///     auto action (auto-switch / launch auto-connect) and every subsequent manual connect reads
///     `Manual` (Pitfall 2). The reset happens after a `Connected` edge regardless of whether the
///     gate suppressed the emit, so a gate-off auto-connect still consumes its origin and cannot
///     bleed into a later manual connect.
///
/// D-29: this function adds NO log line that interpolates config content.
pub fn maybe_fire(app: &tauri::AppHandle, prev: VpnStatus, next: VpnStatus) {
    // Read the live gate + origin from AppState. Missing state (should not happen in production —
    // AppState is managed before .setup) falls back to the safe defaults (gate on, Manual) so a
    // fire is never silently swallowed by a lookup miss.
    let state = app.try_state::<AppState>();
    let notifications_on = state
        .as_ref()
        .map(|s| s.notifications_enabled.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(true);
    // Read the pending origin (peek — the consume/reset below is a SEPARATE, unconditional step so
    // a gate-off auto-connect still resets, never bleeding into a later manual connect).
    let origin = state
        .as_ref()
        .and_then(|s| s.pending_connect_origin.lock().ok().map(|g| *g))
        .unwrap_or(ConnectOrigin::Manual);

    // 13-08b: read the pending connect-time PING (ms) the FE pushed right before this connect (peek —
    // consumed below on the SAME terminal edge the origin is, so a failed attempt cannot leak a stale
    // ping into the next connect). This REPLACES the fresh `ping_config_endpoint` probe of the ACTIVE
    // endpoint (removed below), which read Unreachable BY DESIGN while the tunnel is up and always
    // rendered «—». The reliable source is the config's reachability ping measured JUST BEFORE
    // connecting, while it was still inactive. `None` → the plate renders «—» (honest no-data).
    let pending_ping = state
        .as_ref()
        .and_then(|s| s.pending_connect_ping.lock().ok().map(|g| *g))
        .unwrap_or(None);

    // BL-01/WR-01: read the durable "a compound switch/reconnect teardown is in flight" intent the
    // FE raises before `switchTo`/`handleReconnect`'s teardown-disconnect. When set, the decider
    // suppresses the intermediate «Отключено» — the true state mid-switch is "switching". Missing
    // state falls back to `false` (no suppression) so a lookup miss never hides a genuine disconnect.
    let switch_teardown_pending = state
        .as_ref()
        .map(|s| {
            s.switch_or_reconnect_pending
                .load(std::sync::atomic::Ordering::Relaxed)
        })
        .unwrap_or(false);

    // F17: read the whole-switch-window intent the FE mirrors from `isSwitching` (raised on switch
    // start, cleared in performSwitch's finally after the whole switch+revert). While set, a transient
    // `→ Disconnected` from a failed B or the revert leg is suppressed so the seamless revert stays
    // calm (amber card + embedded «…восстановлено» banner only). NOT cleared Rust-side — the FE owns it.
    let seamless_switch_active = state
        .as_ref()
        .map(|s| {
            s.seamless_switch_active
                .load(std::sync::atomic::Ordering::Relaxed)
        })
        .unwrap_or(false);

    // Part B (cancel notification): read the FE-raised user-cancel intent (peek — the consume/reset
    // below is a SEPARATE, unconditional step on the terminal edge, so a stale cancel flag can never
    // leak into a LATER disconnect). Set by `set_pending_cancel(true)` from the FE's `handleUserCancel`
    // when the user presses «Отмена» on an IN-FLIGHT connect; the decider maps the resulting terminal
    // `Disconnected` to `Cancelled` («Подключение отменено») instead of `Disconnected` («Отключено»).
    // Missing state falls back to `false` (no cancel) so a lookup miss never mislabels a genuine
    // disconnect as a cancel.
    let cancel_pending = state
        .as_ref()
        .map(|s| {
            s.pending_cancel
                .load(std::sync::atomic::Ordering::Relaxed)
        })
        .unwrap_or(false);

    // Consume the origin on ANY terminal outcome of the attempt it was set for (Connected / Error /
    // Disconnected) — reset it to `Manual` so it marks only the one intended auto action (Pitfall 2
    // + CR-01: a FAILED auto attempt must not leave a stale origin for a later manual connect to
    // read). Done BEFORE the gate check so gate-off does not leave a stale AutoSwitch/
    // AutoConnectLaunch origin either. The "should this edge consume?" predicate is the pure
    // `origin_consumed_on` (unit-tested without an AppHandle, mirroring `decide_notification`).
    // 13-10b: do NOT consume on the INTERMEDIATE teardown Disconnected of a switch/reconnect (when
    // `switch_teardown_pending` is set). The attempt terminates at its DESTINATION Connected (or Error),
    // NOT at the teardown — so the origin + ping must SURVIVE the teardown to reach the destination
    // Connected edge. Consuming here was the bug behind "switch shows «Подключено» + «—»": the teardown
    // Connected→Disconnected reset both, so the target Connected read Manual/None instead of AutoSwitch +
    // the target ping. A GENUINE user Disconnect (no teardown pending) STILL consumes (CR-01 preserved),
    // and Connected/Error always consume — so a failed switch/attempt never leaks a stale origin/ping.
    if origin_ping_consumed_on(prev, next, switch_teardown_pending) {
        if let Some(s) = state.as_ref() {
            if let Ok(mut g) = s.pending_connect_origin.lock() {
                *g = ConnectOrigin::Manual;
            }
            // 13-08b: consume the pending connect-time ping on the SAME terminal edge the origin is
            // consumed. The peeked `pending_ping` above still holds THIS connect's value for the fire
            // below; this only clears the cell for the next attempt.
            if let Ok(mut g) = s.pending_connect_ping.lock() {
                *g = None;
            }
        }
    }

    // BL-01/WR-01: clear the switch/reconnect intent on the compound action's DESTINATION terminal
    // outcome (Connected / Error) — NOT on the intermediate teardown Disconnected (that is exactly
    // what we suppress while the flag is up). Done here (before the gate check) as a Rust-side
    // guarantee the flag cannot wedge `true` and permanently swallow a later genuine user disconnect,
    // even if the FE never clears it (e.g. its connect-leg promise is dropped). The FE also clears it
    // in its terminal branches; this is the durable backstop. `switch_teardown_pending` was peeked
    // ABOVE, so THIS transition's suppression still uses the pre-clear value.
    if switch_pending_cleared_on(prev, next) {
        if let Some(s) = state.as_ref() {
            s.switch_or_reconnect_pending
                .store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }

    // Part B (cancel notification): CONSUME the user-cancel intent on the SAME terminal edges the
    // origin is consumed (a genuine `Connected` / `Error` / `Disconnected` transition — the pure
    // `origin_consumed_on`), so a cancel flag can NEVER leak into a later disconnect (a cancel that
    // ended a connect must not relabel the NEXT genuine «Отключить» as «Подключение отменено»). The
    // peeked `cancel_pending` above still holds THIS edge's value for the decider below; this only
    // clears the cell for the next attempt. Unlike the origin/ping (which must SURVIVE a switch
    // teardown to reach the destination Connected), a cancel HAS no destination — its terminal
    // `Disconnected` IS where it fires — so it uses the plain `origin_consumed_on` (consumes on ANY
    // terminal edge, teardown included), which is strictly safer against a leak. Done BEFORE the gate
    // check so a gate-off / visibility-suppressed cancel still spends its flag.
    if origin_consumed_on(prev, next) {
        if let Some(s) = state.as_ref() {
            s.pending_cancel
                .store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }

    // The pure decider owns the whole firing policy (edge-detect, gate, origin-map, Disconnected
    // suppression). It gets the real mirrored gate, the peeked origin (already consumed above for a
    // terminal edge), and the peeked teardown intent (used to suppress an intermediate «Отключено»).
    // F17: fold the whole-switch-window flag into the intermediate-«Отключено» suppression the
    // decider already applies for `switch_teardown_pending`. The teardown flag is dropped before
    // vpn_connect(B), so a failed B / the revert-to-A leg's transient Disconnected edges would
    // otherwise fire a phantom «Отключено» mid-seamless-switch; `seamless_switch_active` (mirrored
    // from the FE's isSwitching, held across the whole switch+revert) keeps them silent. The REAL
    // `switch_teardown_pending` value above is still used for the origin/ping consume + clear logic.
    // Part B: `cancel_pending` (peeked above, consumed on this terminal edge) relabels a user-cancel
    // Disconnected to «Подключение отменено» — but only when NOT a switch teardown (which
    // `suppress_intermediate_disconnected` folds seamless_switch_active into: a seamless switch that
    // somehow set the cancel intent is treated as a teardown, never a phantom cancel plate).
    let suppress_intermediate_disconnected = switch_teardown_pending || seamless_switch_active;

    // G-19-6 v5: manage the pending error-config-name stamp with EDGE-TRIGGERED, take-once semantics —
    // computed HERE, BEFORE `decide_notification` and the visibility gate, so those gates can NEVER
    // leave a stamp un-consumed to linger (Fable D1: the v4 take sat INSIDE the ConnectionError branch,
    // which is AFTER the visibility gate — so a failed connect with the main window OPEN, the common
    // case, suppressed the plate and returned BEFORE the take, stranding the stamp for a later
    // non-stamping Error writer, e.g. the 60s connect-timeout watchdog, to inherit).
    //
    // The stamp is touched ONLY on the two terminal edges that matter — NEVER on the CONCURRENT
    // reconnect's `Connecting` edge (that was the v3 drain: a Connecting-edge maybe_fire fires in the
    // window between the failed gen's stamp and its OWN Error maybe_fire, and must not touch the stamp):
    //   - an ERROR edge (`prev != next && next == Error`) CONSUMES the stamp — the failed gen stamped its
    //     OWN captured name (in `sidecar::handle_fatal_markers`) immediately before THIS Error status
    //     write, so `take()` yields exactly that name for the ConnectionError plate below, regardless of
    //     whether the notifications/visibility gates later suppress the actual desktop fire (a suppressed
    //     fire STILL spends the stamp — a later non-stamping Error can never inherit it).
    //   - a CONNECTED edge (`prev != next && next == Connected`) CLEARS any stamp a prior failed attempt
    //     left that never hit an Error edge (e.g. a suppressed Error→Error second fatal marker). Cleared
    //     on a SETTLED success (a handshake after connect-start — it never interleaves between a failed
    //     gen's stamp and that gen's Error maybe_fire), NEVER on `Connecting`.
    // Only an Error edge KEEPS the taken value (for the ConnectionError branch); a Connected edge takes
    // purely to clear (the value is discarded — no non-error kind reads it). The pure `error_stamp_action`
    // owns the Consume/Clear/Leave policy (unit-tested without an AppHandle) so a v3-style regression is
    // caught by a test, not by the owner.
    let stamp_action = error_stamp_action(prev, next);
    let taken_stamp = if matches!(stamp_action, StampAction::Consume | StampAction::Clear) {
        app.try_state::<AppState>()
            .and_then(|s| {
                s.pending_error_config_name
                    .lock()
                    .ok()
                    .and_then(|mut g| g.take())
            })
            .filter(|s| !s.is_empty())
    } else {
        None
    };
    // KEEP the taken name only for an Error edge (the ConnectionError plate uses it); a Clear (Connected)
    // discards it — the take above already cleared the cell, which is the whole point of the Clear edge.
    let stamped_error_name = match stamp_action {
        StampAction::Consume => taken_stamp,
        _ => None,
    };

    let Some(kind) = decide_notification(
        prev,
        next,
        origin,
        notifications_on,
        suppress_intermediate_disconnected,
        cancel_pending,
    ) else {
        return;
    };

    // Part A (visibility gate): fire the DESKTOP plate ONLY when the main window is NOT in front of
    // the user (minimized / hidden-to-tray / closed-to-tray). When it is visible-and-not-minimized
    // the user is looking at the app and the FE snackbar already reports this transition, so a second
    // desktop plate is redundant — suppress it. CRITICAL: this gate is placed AFTER `decide_notification`
    // AND after ALL the one-shot consume/reset steps above (pending_connect_origin, pending_connect_ping,
    // switch_or_reconnect_pending clear) — those ran unconditionally and MUST NOT be skipped by
    // visibility (exactly like the notifications-off path in `decide_notification` still lets them run).
    // Only the plate FIRE itself is gated here.
    //
    // Lookup miss → default to FIRING (`main_hidden = true`): AppState/window may be absent in a unit
    // test (the maybe_fire path uses no real window) or during a narrow startup window — never silently
    // swallow a notification on a lookup miss. `is_visible()` / `is_minimized()` unwrap to the
    // fire-safe side (visible-unknown → true so `should_fire_when` does not suppress on a read error;
    // minimized-unknown → false). The pure `should_fire_when(visible, minimized)` owns the policy
    // (visible AND not-minimized → suppress; hidden OR minimized → fire) so it is unit-tested without a
    // live window; here we only read the two live bits and negate to the "should this fire?" answer.
    let main_hidden = match app.get_webview_window("main") {
        Some(w) => {
            should_fire_when(w.is_visible().unwrap_or(true), w.is_minimized().unwrap_or(false))
        }
        None => true, // lookup miss → default to FIRING (never silently swallow a notification).
    };
    // Only fire the plate when the main window is hidden/minimized (or a lookup miss). A visible-and-
    // not-minimized main window skips the fire — but NOT the consume/reset logic above.
    if !main_hidden {
        return;
    }

    // Resolve the active config's PATH once (the source for the display name AND — for a connect kind
    // — the endpoint address + login). D-29: only display strings are ever derived from it.
    let config_path = app
        .try_state::<AppState>()
        .and_then(|state| state.config_path.lock().ok().and_then(|g| g.clone()));

    // Resolve the active config's DISPLAY NAME only (D-29). `current_display_name` reads the name
    // from the `.toml` (never the password); empty string when there is no active config or it is
    // unreadable — the plate copy then renders without a name rather than leaking anything.
    let config_name = config_path
        .as_deref()
        .and_then(crate::commands::manifest::current_display_name)
        .unwrap_or_default();

    // G-19-6 v4 (THE wrong-server-name fix): a ConnectionError plate names the config that FAILED — the
    // name the error-writing sidecar task captured at its OWN spawn and stamped into
    // `pending_error_config_name` right before its Error status write — NOT the live `config_path`
    // (which a CONCURRENT reconnect/switch-back repoints to the healthy server the instant the failed
    // attempt errors; PROVEN by app.log — gen=3's Error maybe_fire read config_path already repointed to
    // gen=4's calm-otter7, so it wrongly resolved the healthy server's name).
    //
    // The stamp was already TAKEN (edge-triggered, take-once) at the top of maybe_fire — before the
    // gates — into `stamped_error_name`, so it is spent even when the visibility gate suppressed the
    // desktop fire (Fable D1). Here the ConnectionError plate just USES that already-taken name. Falls
    // back to config_path when unset (non-sidecar preflight errors, whose config_path is still the
    // failing config — a preflight failure is not concurrent with any reconnect, so it is never
    // repointed to a healthy server).
    let config_name = if matches!(kind, NotifyKind::ConnectionError) {
        stamped_error_name.unwrap_or(config_name)
    } else {
        config_name
    };

    // 13-06: read the FE-mirrored effective theme ("dark" | "light") so the plate stamps the right
    // `data-theme` before it renders (its own webview localStorage is empty — Pitfall 5, UAT round-2
    // defect 1). Missing state / a poisoned lock falls back to the safe "dark" default (the :root
    // token fallback), so a lookup miss never renders a mis-themed plate. Already whitelisted to
    // "dark"/"light" by `set_plate_theme`, so no re-validation is needed here.
    let theme = state
        .as_ref()
        .and_then(|s| s.plate_theme.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "dark".to_string());

    // 13-07: read the FE-mirrored UI language ("ru" | "en") so the plate picks the right-language copy
    // before it renders (its own webview localStorage is empty — same Pitfall 5 as the theme, UAT
    // round-3 defect 2). Missing state / a poisoned lock falls back to the safe "ru" default (the
    // app's primary language, matching the previously-hardcoded copy), so a lookup miss never renders
    // a wrong-language plate. Already whitelisted to "ru"/"en" by `set_plate_language`.
    let language = state
        .as_ref()
        .and_then(|s| s.plate_language.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "ru".to_string());

    let wire_key = kind.wire_key();

    // 13-08 / 13-08b: split the fire tail by kind.
    //   - CONNECT kinds (connected / autoSwitched / autoConnected) carry the richer detail block
    //     (address / login / ping) and the TALLER connect window height. The address + login are
    //     SYNC reads from the active config `.toml` (D-29 — host/port/username, NEVER the password),
    //     and — as of 13-08b — the ping is ALSO a SYNC read: the FE-mirrored `pending_connect_ping`
    //     (peeked above), NOT a fresh async probe. The OLD path spawned a task to ping the ACTIVE
    //     endpoint via `ping_config_endpoint`, but a direct TCP connect to the active/connected
    //     endpoint reads Unreachable BY DESIGN while the tunnel is up (a tunnel-internal IP fails a
    //     direct connect forever, even connected — see ping.rs / usePerConfigPing.ts), so it always
    //     rendered «—». Now every field is a synchronous read, so the whole fire tail is synchronous
    //     again — the `tauri::async_runtime::spawn` is GONE.
    //   - COMPACT kinds keep the synchronous path (no details, no ping) with the compact height.
    // The gate, origin consume/reset, ping consume/reset, and switch-teardown clear ALL ran above;
    // latest-wins / D-03 semantics are unchanged (each fire stages+emits the CURRENT state).
    if kind.is_connect() {
        // Read the endpoint address + login SYNCHRONOUSLY from the active config path (D-29 — the
        // helpers read host/port/username, NEVER the password). Absent config path or an unreadable
        // endpoint → None (the plate omits that row).
        let address = config_path
            .as_deref()
            .and_then(crate::commands::ping::endpoint_address_for_config);
        let login = config_path
            .as_deref()
            .and_then(crate::commands::manifest::username_for_config);

        // 13-08b: the ping is the FE-mirrored `pending_connect_ping` (the config's reachability ping
        // measured JUST BEFORE connecting, while it was still inactive) — NOT a fresh probe of the
        // active endpoint (which reads Unreachable by design). `None` → the plate renders «—».
        fire_plate_tail(
            app,
            wire_key,
            config_name,
            theme,
            language,
            address,
            login,
            pending_ping,
            CONNECT_PLATE_HEIGHT,
        );
    } else {
        // Compact kind — no details, no ping; the synchronous tail with the compact height.
        fire_plate_tail(
            app, wire_key, config_name, theme, language, None, None, None, COMPACT_PLATE_HEIGHT,
        );
    }
}

/// Phase 13 (13-10 / §A) — fire a TRANSIENT START plate the moment the app KNOWS a deliberate
/// switch / manual reconnect begins, so the owner SEES it in progress. Called from
/// `set_switch_or_reconnect_pending(true)` (the FE raises that intent BEFORE the teardown-disconnect
/// of a compound switch/reconnect). The terminal outcome plate («Переключено автоматически» /
/// «Подключено») then REPLACES this start plate via the existing latest-wins staging in
/// `fire_plate_tail` (D-03) — so the owner sees TWO plates per switch (start → result) and per manual
/// save-and-reconnect (reconnecting → connected).
///
/// The start kind: the FE now threads an explicit SWITCH-vs-RECONNECT hint (`is_switch`) on the
/// intent raise (Fable-A review #6) — a SERVER SWITCH (manual or auto) fires the NEUTRAL `switching`
/// kind, a same-server save-and-reconnect fires the EXISTING `reconnecting` kind. Without the hint
/// (older FE / hintless callers) the seam falls back to the 13-10 pending-ORIGIN mapping. `switching`
/// is FE-only — it is NOT a `NotifyKind` in the pure `decide_notification` decider (which stays at
/// its 7 outcome kinds); this seam fires the wire key directly, so `wire_key` here is a plain
/// `&'static str` literal, not a `NotifyKind::wire_key()`.
///
/// GATED by the master `notifications_enabled` mirror — with notifications OFF this fires NOTHING
/// (mirrors `maybe_fire`'s gate). It is a COMPACT start plate: NO details (address/login/ping), just
/// kind + the CURRENT active config display name (for the `reconnecting` body) + the mirrored
/// theme/language. D-29: it carries only display strings — never the `.toml`, host, or password.
///
/// Pure (13-10 / §A, reworked Fable-A #6): pick the START plate's wire key.
///
/// The FE-threaded `is_switch` hint WINS when present: a deliberate SERVER SWITCH — manual
/// («Переключиться» on another card) or auto (the engine) — is `Some(true)` → the NEUTRAL
/// `switching` plate («Переключаю сервер…»); a same-server save-and-reconnect is `Some(false)` →
/// `reconnecting` («Переподключение», owner-accepted in UAT test 12). The hint exists because a
/// MANUAL switch and a save-and-reconnect both carry origin=Manual — before it, a manual switch
/// fell into `reconnecting`, whose body «Связь прервалась — восстанавливаю» falsely claimed the
/// link dropped when the user had just picked another healthy server (review #6, owner decision:
/// neutral copy for a switch).
///
/// `None` (no hint — an older FE or a hintless caller) falls back to the original 13-10
/// origin mapping: AutoSwitch → `switching`, everything else → `reconnecting`. Kept pure so the
/// mapping is unit-testable without a live AppHandle, exactly like the other pure predicates in
/// this module.
pub fn start_plate_wire_key(origin: ConnectOrigin, is_switch: Option<bool>) -> &'static str {
    match is_switch {
        Some(true) => "switching",
        Some(false) => "reconnecting",
        None => match origin {
            ConnectOrigin::AutoSwitch => "switching",
            _ => "reconnecting",
        },
    }
}

/// `false` (the intent-clear leg) fires nothing — the caller only invokes this on `pending == true`.
pub fn fire_start_plate(app: &tauri::AppHandle, wire_key: &'static str) {
    let state = app.try_state::<AppState>();

    // Master gate: with notifications off, fire nothing (same gate `maybe_fire` reads). Missing state
    // (should not happen in production — AppState is managed before .setup) falls back to the safe
    // "on" default so a lookup miss never silently swallows a start plate.
    let notifications_on = state
        .as_ref()
        .map(|s| {
            s.notifications_enabled
                .load(std::sync::atomic::Ordering::Relaxed)
        })
        .unwrap_or(true);
    if !notifications_on {
        return;
    }

    // Resolve the active config's DISPLAY NAME only (D-29) — same path as `maybe_fire`. The
    // `reconnecting` start body ignores the name, but the CURRENT active config is the honest name to
    // thread for it (empty when there is no active config). No detail fields on a start plate.
    let config_name = state
        .as_ref()
        .and_then(|s| s.config_path.lock().ok().and_then(|g| g.clone()))
        .as_deref()
        .and_then(crate::commands::manifest::current_display_name)
        .unwrap_or_default();

    // Thread the FE-mirrored theme + language exactly like `maybe_fire`, so the start plate renders in
    // the right theme/language on its own (empty-localStorage) webview (Pitfall 5). Safe defaults on a
    // lookup miss: "dark" (the :root token fallback) and "ru" (the app's primary language).
    let theme = state
        .as_ref()
        .and_then(|s| s.plate_theme.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "dark".to_string());
    let language = state
        .as_ref()
        .and_then(|s| s.plate_language.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "ru".to_string());

    // Compact start plate: no details, compact height. Latest-wins staging in `fire_plate_tail` lets
    // the terminal outcome plate replace it (D-03).
    fire_plate_tail(
        app,
        wire_key,
        config_name,
        theme,
        language,
        None,
        None,
        None,
        COMPACT_PLATE_HEIGHT,
    );
}

/// Phase 19 UAT (G-19-6, Option B) — fire the ConnectionError plate for a SUPERSEDED session's
/// failure, naming the config that ACTUALLY failed (`config_name`, captured at that session's spawn)
/// rather than the live `config_path` `maybe_fire` reads. After a fallback / seamless-switch revert /
/// auto-switch moves the app onto the healthy server, `config_path` names the WRONG server; and the
/// sidecar's generation guard now DROPS the superseded Error STATUS write (so it cannot corrupt the
/// fresh session), which means `maybe_fire` never runs for it. This dedicated path lets the user still
/// learn «Не удалось подключиться к «<failed server>»» with the correct name WITHOUT touching
/// `vpn_status`.
///
/// It applies the SAME two gates `maybe_fire` does for the plate FIRE: the master
/// `notifications_enabled` mirror, and the visibility rule (fire ONLY when the main window is
/// hidden/minimized — a visible window is covered by the FE snackbar). Compact plate (no
/// address/login/ping). D-29: carries only the display name — never the `.toml`, host, or password.
/// The caller (`sidecar::handle_fatal_markers`) latches this to fire AT MOST ONCE per dead session.
pub fn fire_superseded_error_plate(app: &tauri::AppHandle, config_name: &str) {
    let state = app.try_state::<AppState>();

    // Master gate: with notifications off, fire nothing (same gate maybe_fire / fire_start_plate read).
    let notifications_on = state
        .as_ref()
        .map(|s| {
            s.notifications_enabled
                .load(std::sync::atomic::Ordering::Relaxed)
        })
        .unwrap_or(true);
    if !notifications_on {
        return;
    }

    // Visibility gate (mirror maybe_fire): fire ONLY when the main window is NOT in front of the user
    // (hidden / minimized / lookup miss). A visible-and-not-minimized window is covered by the FE
    // snackbar, so a desktop plate would be redundant. Lookup miss → fire (never silently swallow).
    let main_hidden = match app.get_webview_window("main") {
        Some(w) => should_fire_when(
            w.is_visible().unwrap_or(true),
            w.is_minimized().unwrap_or(false),
        ),
        None => true,
    };
    if !main_hidden {
        return;
    }

    // Thread the FE-mirrored theme + language exactly like maybe_fire / fire_start_plate so the plate
    // renders in the right theme/language on its own empty-localStorage webview (Pitfall 5). Safe
    // defaults on a lookup miss: "dark" (:root token fallback) and "ru" (the app's primary language).
    let theme = state
        .as_ref()
        .and_then(|s| s.plate_theme.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "dark".to_string());
    let language = state
        .as_ref()
        .and_then(|s| s.plate_language.lock().ok().map(|g| g.clone()))
        .unwrap_or_else(|| "ru".to_string());

    // Compact ConnectionError plate — no details, compact height. Latest-wins staging in
    // fire_plate_tail (D-03). The wire key is the ConnectionError kind's key (matches maybe_fire).
    fire_plate_tail(
        app,
        NotifyKind::ConnectionError.wire_key(),
        config_name.to_string(),
        theme,
        language,
        None,
        None,
        None,
        COMPACT_PLATE_HEIGHT,
    );
}

/// 13-08: the plate window heights, in LOGICAL px. The compact plate is the 2-line title+body
/// (matching the original `inner_size(360, 68)` in lib.rs). The connect plate adds the ~132px detail
/// block; 140 gives it a small buffer (measured detailed plate height = 132 @ width 360).
const COMPACT_PLATE_HEIGHT: f64 = 68.0;
const CONNECT_PLATE_HEIGHT: f64 = 140.0;
/// The plate window width (LOGICAL px) — unchanged from the lib.rs `inner_size` (360). Kept here so
/// the shared fire tail resizes both dimensions consistently before positioning.
const PLATE_WIDTH: f64 = 360.0;

/// F15 (14-UAT round 2): the fixed per-kind heights (68/140) clip the plate when a long config name
/// wraps to extra lines — `overflow:hidden` bottom-clips the content so the ping row's bottom padding
/// is eaten (owner: «не хватает отступа снизу»). The FE measures its rendered content height after
/// layout and calls `resize_notification_plate` to grow/shrink the window to fit, preserving the
/// design paddings for ANY content length. The measured value is clamped to a sane band so a bogus
/// measurement (0 / NaN / absurd) can never create an off-screen, zero, or giant window.
const MIN_PLATE_HEIGHT: f64 = 56.0;
const MAX_PLATE_HEIGHT: f64 = 320.0;

/// Pure: coerce a raw FE-measured height to the safe plate band. NaN / non-finite / below-min → MIN;
/// above-max → MAX; otherwise passthrough. Unit-tested without a live window.
fn clamp_plate_height(raw: f64) -> f64 {
    if !raw.is_finite() || raw < MIN_PLATE_HEIGHT {
        MIN_PLATE_HEIGHT
    } else if raw > MAX_PLATE_HEIGHT {
        MAX_PLATE_HEIGHT
    } else {
        raw
    }
}

/// F15: shared "position the plate bottom-right of the work area" step, extracted so BOTH the initial
/// fire (`fire_plate_tail`) and the FE-driven `resize_notification_plate` size FIRST then position —
/// `outer_size()` reflects the just-set height, so the plate stays flush to the bottom-right corner at
/// any height. WR-04 `center()` fallback preserved (an unresolved monitor/size must not leave the
/// plate off-screen).
fn anchor_plate_bottom_right(win: &tauri::WebviewWindow) {
    let positioned = match (win.primary_monitor(), win.outer_size()) {
        (Ok(Some(monitor)), Ok(win_size)) => {
            let wa = monitor.work_area();
            let margin = (12.0 * monitor.scale_factor()) as i32;
            let x = wa.position.x + wa.size.width as i32 - win_size.width as i32 - margin;
            let y = wa.position.y + wa.size.height as i32 - win_size.height as i32 - margin;
            win.set_position(tauri::PhysicalPosition::<i32> { x, y }).is_ok()
        }
        _ => false,
    };
    if !positioned {
        // Positioning could not be resolved — at least keep the plate on-screen (Tauri 2 center()).
        let _ = win.center();
    }
}

/// F15: resize the `notification` plate window to the FE-measured content height, then re-anchor
/// bottom-right (size FIRST so `outer_size()` reads the new height). Runs on EVERY applyPlate render
/// (latest-wins, D-03: a shorter next plate must SHRINK the window too). Custom app command → needs no
/// per-command capability entry (mirrors `pull_pending_plate`). Best-effort: a missing window no-ops,
/// the clamp guards a bogus height, and the DWM-rounded opaque window is untouched (no transparency —
/// #13859 — only `set_size`/`set_position` are called).
#[tauri::command]
pub fn resize_notification_plate(height: f64, app: tauri::AppHandle) {
    let Some(win) = app.get_webview_window("notification") else {
        return;
    };
    let clamped = clamp_plate_height(height);
    let _ = win.set_size(tauri::LogicalSize::new(PLATE_WIDTH, clamped));
    anchor_plate_bottom_right(&win);
}

/// 13-08: the SHARED "resize + position + stage + emit + show" tail both fire paths (connect / compact)
/// reuse. It takes the fully-resolved payload fields plus the target window HEIGHT so the connect
/// plate (with details) gets a taller window and the compact plate keeps the short one.
///
/// It (1) RESIZES the single pre-built `notification` window to 360×height BEFORE positioning (so the
/// bottom-right anchor uses the NEW height — the existing math reads `outer_size()`, which reflects
/// the just-set size), (2) positions bottom-right of the work area (WR-04 center() fallback),
/// (3) STAGES the PendingPlate for the pull-model redelivery (13-05, latest-wins / D-03), (4) emits
/// `notify-plate`, and (5) shows the window. D-29: it only ever carries display strings.
#[allow(clippy::too_many_arguments)]
fn fire_plate_tail(
    app: &tauri::AppHandle,
    wire_key: &'static str,
    config_name: String,
    theme: String,
    language: String,
    address: Option<String>,
    login: Option<String>,
    ping_ms: Option<u32>,
    window_height: f64,
) {
    let Some(win) = app.get_webview_window("notification") else {
        return;
    };

    // 13-08: size the window to the kind's height BEFORE positioning. Rust-side `set_size` needs NO
    // capability (capabilities gate FE IPC only) and works on a `resizable(false)` window (that flag
    // only blocks USER drag-resize, not a programmatic resize). Keep the width fixed at 360. If the
    // resize fails we still position/show at whatever the current size is (best-effort — never abort).
    let _ = win.set_size(tauri::LogicalSize::new(PLATE_WIDTH, window_height));

    // Position bottom-right of the primary monitor's WORK AREA (excludes the taskbar). Shared with the
    // F15 resize command via `anchor_plate_bottom_right` — size FIRST (above) so `outer_size()` reflects
    // the new height and the plate sits flush to the bottom-right corner (WR-04 center() fallback inside).
    anchor_plate_bottom_right(&win);

    // 13-05: STAGE the pending plate BEFORE the emit so a fire whose emit beats the plate's
    // not-yet-attached listener is recoverable via `pull_pending_plate` (the emit-before-listener
    // race — the UAT test-1 empty-black-plate blocker). Latest-wins: each fire overwrites whatever
    // is staged, so a pull always redelivers the CURRENT state (D-03). Poison-recover the lock like
    // the other locks here. The plate's mount-time pull drains a fire that beat the mount; a fire
    // landing in the narrow post-listen/pre-pull window may be seen by BOTH the live listener AND
    // the pull — that is SAFE because the FE's applyPlate is idempotent (same {kind, configName, …} →
    // identical state; only the auto-dismiss timer restarts from full duration). We deliberately do
    // NOT make emit + stage mutually exclusive — the idempotence is the intended, lower-risk
    // contract for this frozen-version fix.
    if let Some(s) = app.try_state::<AppState>() {
        let mut guard = s.pending_plate.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(PendingPlate {
            kind: wire_key.to_string(),
            config_name: config_name.clone(),
            theme: theme.clone(),
            language: language.clone(),
            address: address.clone(),
            login: login.clone(),
            ping_ms,
        });
    }

    // Emit the KIND + display-name (+ optional connect details) payload, then show the pre-built
    // window (never rebuilt). The plate's own React root listens for `notify-plate` and renders
    // ConnectionToast.
    let _ = app.emit(
        "notify-plate",
        NotifyPlatePayload {
            kind: wire_key,
            config_name,
            theme,
            language,
            address,
            login,
            ping_ms,
        },
    );

    // 13-verify (UAT test 6): RE-ASSERT topmost on every show so the plate floats ABOVE the current
    // foreground window. The window is built `.always_on_top(true)` (lib.rs), but tao only issues
    // SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE) when the ALWAYS_ON_TOP flag *changes*
    // (apply_diff gates on `diff.contains(ALWAYS_ON_TOP)`); a plain `win.show()` flips only VISIBLE,
    // so a plate shown from hidden while another app is foreground is never re-inserted into the
    // topmost Z-band and renders BEHIND the active window. A bare `set_always_on_top(true)` is a NO-OP
    // (flag already true → empty diff → early return), so we TOGGLE false→true to force a non-empty
    // diff and make tao emit the SetWindowPos. SWP_NOACTIVATE + the persisted MARKER_DONT_FOCUS keep
    // the show NON-activating: no focus steal, still absent from Alt+Tab (skip_taskbar unaffected).
    // Root cause + fix adversarially verified against vendored tao 0.34.6 — see 13-UAT.md test 6.
    let _ = win.set_always_on_top(false);
    let _ = win.set_always_on_top(true);
    let _ = win.show();
}

#[cfg(test)]
mod tests {
    // Wave-1 GREEN (Plan 13-02): the `#[ignore]` + `todo!()` scaffolds are now filled — each
    // named seam calls the real `decide_notification` with explicit args (no locks, no sidecar),
    // mirroring the vpn.rs `decide_timeout_action` test-module shape.
    use super::*;
    use crate::commands::vpn::VpnStatus;

    // F15 (14-UAT round 2): the FE-measured plate height is clamped to a safe band before it resizes
    // the window, so a bogus measurement can never create an off-screen / zero / giant plate.
    #[test]
    fn clamp_plate_height_coerces_to_the_safe_band() {
        // A normal measured height passes through.
        assert_eq!(clamp_plate_height(132.0), 132.0);
        assert_eq!(clamp_plate_height(MIN_PLATE_HEIGHT), MIN_PLATE_HEIGHT);
        assert_eq!(clamp_plate_height(MAX_PLATE_HEIGHT), MAX_PLATE_HEIGHT);
        // Below-min / zero / negative → MIN (never a zero or off-screen window).
        assert_eq!(clamp_plate_height(10.0), MIN_PLATE_HEIGHT);
        assert_eq!(clamp_plate_height(0.0), MIN_PLATE_HEIGHT);
        assert_eq!(clamp_plate_height(-50.0), MIN_PLATE_HEIGHT);
        // Absurd finite → MAX (never a giant window). Non-finite (NaN / ±∞) is a garbage measurement
        // → MIN (conservative: a small plate is safer than a giant/off-screen one).
        assert_eq!(clamp_plate_height(5000.0), MAX_PLATE_HEIGHT);
        assert_eq!(clamp_plate_height(f64::NAN), MIN_PLATE_HEIGHT);
        assert_eq!(clamp_plate_height(f64::INFINITY), MIN_PLATE_HEIGHT);
    }

    #[test]
    fn should_fire_when_gates_the_plate_on_main_window_visibility() {
        // Part A (visibility gate): the DESKTOP plate fires ONLY when the main window is NOT in front
        // of the user. `should_fire_when(main_visible, main_minimized)` is the pure policy `maybe_fire`
        // consults after the decider + all the one-shot consumes: a plate is redundant when the window
        // is visible-and-not-minimized (the FE snackbar already reports the transition), so suppress
        // ONLY that case; a hidden window (any reason) OR a minimized window still fires.
        //
        // visible + not minimized → the user is looking at the app → SUPPRESS (false).
        assert!(!should_fire_when(true, false), "a visible, non-minimized main window suppresses the plate");
        // hidden (not visible) → the user is not looking at the app → FIRE.
        assert!(should_fire_when(false, false), "a hidden main window fires the plate");
        // minimized (even if the OS still reports it 'visible') → not in front of the user → FIRE.
        assert!(should_fire_when(true, true), "a minimized main window fires the plate");
        // hidden AND minimized (belt and suspenders) → FIRE.
        assert!(should_fire_when(false, true), "a hidden+minimized main window fires the plate");
        // NOTE: a REAL visible main window suppresses the plate (the `true,false` case above); the
        // full maybe_fire integration (reading the live window + the lookup-miss → fire default) is
        // exercised in-app, since maybe_fire needs a live AppHandle/window the unit layer lacks. The
        // one-shot consumes in maybe_fire are proven independent of this gate by the origin/ping
        // consume tests, which model the exact peek→consume rule maybe_fire runs BEFORE this gate.
    }

    #[test]
    fn fires_on_seven_outcome_states() {
        // Truth: each of the 7 production outcome states maps to its NotifyKind when the
        // transition + origin match (D-01, D-25). Every case is a genuine edge (prev != next)
        // with the master gate ON.
        // Manual connect: Connecting → Connected ⇒ Connected.
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connected,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            Some(NotifyKind::Connected),
        );
        // Auto-switch: Reconnecting → Connected with AutoSwitch origin ⇒ AutoSwitched.
        assert_eq!(
            decide_notification(
                VpnStatus::Reconnecting,
                VpnStatus::Connected,
                ConnectOrigin::AutoSwitch,
                true,
                false,
                false,
            ),
            Some(NotifyKind::AutoSwitched),
        );
        // Auto-connect-on-launch: Connecting → Connected with AutoConnectLaunch ⇒ AutoConnectLaunch.
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connected,
                ConnectOrigin::AutoConnectLaunch,
                true,
                false,
                false,
            ),
            Some(NotifyKind::AutoConnectLaunch),
        );
        // Error from any non-Error prev ⇒ ConnectionError.
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Error,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            Some(NotifyKind::ConnectionError),
        );
        // Edge to Reconnecting ⇒ Reconnecting.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Reconnecting,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            Some(NotifyKind::Reconnecting),
        );
        // Edge to Recovering ⇒ Recovering.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Recovering,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            Some(NotifyKind::Recovering),
        );
        // Edge to Disconnected from an active prev ⇒ Disconnected.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            Some(NotifyKind::Disconnected),
        );
    }

    #[test]
    fn does_not_fire_on_two_transient_states() {
        // Truth (D-01): the transient wire-state `Connecting` is NOT a notification kind — a
        // transition landing on it must return None. (At the VpnStatus level there is no
        // `Disconnecting` variant; the "отключение…" phase is a boolean flag whose terminal
        // status is `Disconnected`, so `Connecting` is the only transient status the decider
        // can receive. The D-01 "two transient states" pair is a UI-copy concept.)
        assert_eq!(
            decide_notification(
                VpnStatus::Disconnected,
                VpnStatus::Connecting,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            None,
        );
        assert_eq!(
            decide_notification(
                VpnStatus::Error,
                VpnStatus::Connecting,
                ConnectOrigin::AutoSwitch,
                true,
                false,
                false,
            ),
            None,
        );
    }

    #[test]
    fn auto_switch_and_auto_connect_map_via_origin() {
        // Truth (D-01, Pitfall 2): an otherwise-identical Connecting→Connected maps to
        // AutoSwitched / AutoConnectLaunch / Connected based ONLY on ConnectOrigin, never on
        // any VPN wire-state (the sidecar has no "was this auto?" bit). Same prev/next/gate;
        // only `origin` differs.
        let prev = VpnStatus::Connecting;
        let next = VpnStatus::Connected;
        assert_eq!(
            decide_notification(prev, next, ConnectOrigin::Manual, true, false, false),
            Some(NotifyKind::Connected),
        );
        assert_eq!(
            decide_notification(prev, next, ConnectOrigin::AutoSwitch, true, false, false),
            Some(NotifyKind::AutoSwitched),
        );
        assert_eq!(
            decide_notification(prev, next, ConnectOrigin::AutoConnectLaunch, true, false, false),
            Some(NotifyKind::AutoConnectLaunch),
        );
    }

    #[test]
    fn gate_off_returns_none() {
        // Truth (D-04): notifications_on == false → decide_notification returns None for every
        // transition (the master gate suppresses the plate entirely), including transitions that
        // WOULD fire with the gate on.
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connected,
                ConnectOrigin::Manual,
                false,
                false,
                false,
            ),
            None,
        );
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Error,
                ConnectOrigin::Manual,
                false,
                false,
                false,
            ),
            None,
        );
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::AutoSwitch,
                false,
                false,
                false,
            ),
            None,
        );
    }

    #[test]
    fn snapshot_level_prev_equals_next_returns_none() {
        // Truth (Pitfall 3): the decider is edge-triggered — a prev == next snapshot (no actual
        // transition) must fire nothing, so a status poll re-reporting the same state never
        // re-fires the plate. Checked across an outcome state AND a transient one, gate ON.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Connected,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            None,
        );
        assert_eq!(
            decide_notification(
                VpnStatus::Error,
                VpnStatus::Error,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            None,
        );
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connecting,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            None,
        );
    }

    #[test]
    fn teardown_disconnected_is_suppressed_but_a_genuine_user_disconnect_still_fires() {
        // Truth (BL-01 / WR-01): the intermediate `Disconnected` that is only the teardown half of a
        // compound action (switch / manual reconnect) must NOT fire «Отключено» — mid-switch the true
        // state is "switching", never "disconnected". The FE raises `switch_teardown_pending` before
        // that teardown, and the decider suppresses the Disconnected fire while it is set.
        // Auto-switch teardown: Connected → Disconnected with the teardown flag set ⇒ suppressed.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::AutoSwitch,
                true,
                true, // switch_teardown_pending
                false,
            ),
            None,
            "a switch/reconnect teardown Disconnected must not fire «Отключено»",
        );
        // Manual reconnect teardown: same shape, Manual origin.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                true,
                false,
            ),
            None,
        );
        // REGRESSION GUARD: a GENUINE user disconnect (teardown flag NOT set, prev != Error) STILL
        // fires «Отключено» — do not over-suppress.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false, // no teardown in flight — a real user Disconnect
                false,
            ),
            Some(NotifyKind::Disconnected),
            "a genuine user disconnect must still fire «Отключено» (no over-suppression)",
        );
    }

    #[test]
    fn user_cancel_disconnected_fires_cancelled_not_disconnected() {
        // Part B (cancel notification): a USER CANCEL of an in-flight connect (the FE raised
        // `cancel_pending`) must fire «Подключение отменено» (Cancelled), NOT «Отключено»
        // (Disconnected) — they are DIFFERENT events (owner requirement). A cancel can arrive as
        // Connecting→Disconnected OR Disconnecting→Disconnected (both teardown paths of an aborted
        // connect); both land in the Disconnected arm and both map to Cancelled when cancel_pending is
        // set and neither existing suppression applies.
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false, // no switch teardown
                true,  // cancel_pending — the user pressed «Отмена» on an in-flight connect
            ),
            Some(NotifyKind::Cancelled),
            "a user-cancel Connecting→Disconnected must fire «Подключение отменено», not «Отключено»",
        );
        // The other teardown path of an aborted connect: Disconnecting→Disconnected.
        assert_eq!(
            decide_notification(
                VpnStatus::Disconnecting,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false,
                true,
            ),
            Some(NotifyKind::Cancelled),
            "a user-cancel Disconnecting→Disconnected also fires «Подключение отменено»",
        );
        // REGRESSION GUARD: WITHOUT cancel_pending, the SAME edge is a plain «Отключено» — the cancel
        // kind is opt-in via the FE-raised intent, never a default relabel of every disconnect.
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false,
                false, // no cancel intent
            ),
            Some(NotifyKind::Disconnected),
            "without the cancel intent a Disconnected stays «Отключено» (no accidental relabel)",
        );
        // A genuine connected disconnect (Connected→Disconnected, no cancel intent) stays «Отключено».
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            Some(NotifyKind::Disconnected),
        );
    }

    #[test]
    fn cancel_pending_does_not_override_teardown_or_error_acknowledge() {
        // Part B: the cancel relabel is subordinate to the two existing Disconnected suppressions —
        // it applies ONLY when `!switch_teardown_pending && prev != Error`. A switch/reconnect teardown
        // is NOT a cancel (its real destination plate follows) and an error-acknowledge is NOT a cancel
        // (WR-02). Guarding on switch_teardown_pending ALSO means the maybe_fire aggregate
        // (switch_or_reconnect_pending || seamless_switch_active) suppresses a phantom cancel plate if a
        // seamless switch ever set cancel_pending — a cancel during a seamless switch is treated as a
        // teardown, staying silent, exactly like «Отключено» is there.
        // Switch teardown wins over cancel → suppressed (None), not Cancelled.
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::AutoSwitch,
                true,
                true, // switch_teardown_pending (or the seamless aggregate) — wins over cancel
                true, // cancel_pending also set
            ),
            None,
            "a switch teardown must NOT fire a cancel plate even if cancel_pending is set",
        );
        // Error-acknowledge wins over cancel → suppressed (None), not Cancelled.
        assert_eq!(
            decide_notification(
                VpnStatus::Error,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false,
                true, // cancel_pending set, but prev == Error is an error-acknowledge, not a cancel
            ),
            None,
            "an error-acknowledge must NOT fire a cancel plate even if cancel_pending is set (WR-02)",
        );
    }

    #[test]
    fn cancelled_kind_is_neutral_and_has_the_cancelled_wire_key() {
        // Part B: Cancelled is a NEUTRAL kind (like Disconnected) — it is NOT a connect kind (no
        // address/login/ping detail block) and its wire_key is the stable "cancelled" the FE copy map
        // is keyed by.
        assert_eq!(NotifyKind::Cancelled.wire_key(), "cancelled");
        assert!(
            !NotifyKind::Cancelled.is_connect(),
            "Cancelled is neutral — it carries no connect detail block (mirrors Disconnected)",
        );
    }

    #[test]
    fn pending_cancel_is_consumed_on_the_terminal_edge_no_leak_into_next_disconnect() {
        // Part B: the user-cancel intent is a ONE-SHOT the FE raises before an in-flight-connect
        // cancel; maybe_fire consumes it (resets to false) on the SAME terminal edge the origin is
        // consumed (`origin_consumed_on` — a genuine Connected / Error / Disconnected transition), so a
        // cancel flag can NEVER leak into a LATER genuine disconnect (which must stay «Отключено», not
        // relabel to «Подключение отменено»). Model the AppState AtomicBool cell as a local and run the
        // exact maybe_fire consume rule (peek → consume-on-terminal-edge) so the round-trip is
        // unit-testable without a live Tauri AppHandle/State.
        let cell = std::sync::atomic::AtomicBool::new(true);

        // (1) The cancel's own terminal Disconnected edge: the fire peeks the flag (true → Cancelled),
        //     then consumes it.
        let peeked = cell.load(std::sync::atomic::Ordering::Relaxed);
        assert!(peeked, "the cancel fire reads the raised intent");
        if origin_consumed_on(VpnStatus::Connecting, VpnStatus::Disconnected) {
            cell.store(false, std::sync::atomic::Ordering::Relaxed);
        }
        assert!(
            !cell.load(std::sync::atomic::Ordering::Relaxed),
            "the cancel intent is consumed on its terminal Disconnected edge",
        );

        // (2) A LATER genuine connected disconnect reads the reset false → plain «Отключено».
        let peeked2 = cell.load(std::sync::atomic::Ordering::Relaxed);
        assert_eq!(
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false,
                peeked2,
            ),
            Some(NotifyKind::Disconnected),
            "after the cancel intent is consumed, the next genuine disconnect is «Отключено»",
        );
    }

    #[test]
    fn error_acknowledge_disconnected_fires_no_plate() {
        // Truth (WR-02): `clear_vpn_error` routes Error → Disconnected through the single writer to
        // clear the error everywhere. That is NOT a disconnect — the user merely acknowledged a past
        // error. The decider suppresses «Отключено» whenever `prev == Error`, independent of the
        // teardown flag (an error-acknowledge is not a switch teardown).
        assert_eq!(
            decide_notification(
                VpnStatus::Error,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false, // no teardown flag — clear_vpn_error does not raise it
                false,
            ),
            None,
            "an Error → Disconnected error-acknowledge must fire no plate (WR-02)",
        );
        // And it is STILL suppressed even if the teardown flag also happened to be set (belt and
        // suspenders — prev == Error alone suffices).
        assert_eq!(
            decide_notification(
                VpnStatus::Error,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                true,
                false,
            ),
            None,
        );
    }

    #[test]
    fn switch_pending_cleared_on_terminal_destination_outcome() {
        // Truth (BL-01 mechanism): the `switch_or_reconnect_pending` signal marks ONE compound
        // action; it is cleared on the DESTINATION terminal outcome (`Connected` — switch worked, or
        // `Error` — the destination failed), NOT on the intermediate teardown `Disconnected` (which
        // is the state being suppressed while the signal is up). A prev==next snapshot or an
        // in-flight state never clears it.
        assert!(switch_pending_cleared_on(VpnStatus::Connecting, VpnStatus::Connected));
        assert!(switch_pending_cleared_on(VpnStatus::Reconnecting, VpnStatus::Connected));
        assert!(switch_pending_cleared_on(VpnStatus::Connecting, VpnStatus::Error));
        // The intermediate teardown Disconnected must NOT clear it (else the following connect's
        // own teardown would re-expose the flash) — the FE clears it on the terminal outcome.
        assert!(!switch_pending_cleared_on(VpnStatus::Connected, VpnStatus::Disconnected));
        // Snapshot / in-flight never clears.
        assert!(!switch_pending_cleared_on(VpnStatus::Connected, VpnStatus::Connected));
        assert!(!switch_pending_cleared_on(VpnStatus::Connected, VpnStatus::Reconnecting));
    }

    #[test]
    fn error_stamp_action_survives_connecting_consumes_error_clears_connected() {
        // Truth (G-19-6 v5, the wrong-server-name fix): the pending error-config-name stamp is
        // EDGE-TRIGGERED. Only the failed gen's own Error edge may CONSUME it, and a success CLEARS it;
        // EVERYTHING else — most importantly the CONCURRENT reconnect's `Connecting` edge — LEAVES it.
        //
        // This is the exact policy the v3 defect got wrong: v3 took the stamp on EVERY status write, so
        // the reconnect's `Connecting` maybe_fire (which fires between the failed gen's stamp and its own
        // Error maybe_fire) drained the stamp first, and the Error then fell back to the live config_path
        // — already repointed to the healthy server — naming the WRONG server. Pinning it here means a
        // future edit that reintroduces a non-edge take fails this test, not the UAT.

        // The failed gen's Error edge CONSUMES (keeps its own stamped name for the plate).
        assert_eq!(
            error_stamp_action(VpnStatus::Connecting, VpnStatus::Error),
            StampAction::Consume
        );
        assert_eq!(
            error_stamp_action(VpnStatus::Reconnecting, VpnStatus::Error),
            StampAction::Consume
        );

        // THE v3 REGRESSION GUARD: the concurrent reconnect's Connecting edge must LEAVE the stamp so it
        // survives to the failed gen's Error maybe_fire. (Any prev → Connecting.)
        assert_eq!(
            error_stamp_action(VpnStatus::Error, VpnStatus::Connecting),
            StampAction::Leave
        );
        assert_eq!(
            error_stamp_action(VpnStatus::Disconnected, VpnStatus::Connecting),
            StampAction::Leave
        );
        assert_eq!(
            error_stamp_action(VpnStatus::Connected, VpnStatus::Connecting),
            StampAction::Leave
        );

        // A settled success CLEARS a stale stamp a prior failed attempt left (linger guard).
        assert_eq!(
            error_stamp_action(VpnStatus::Connecting, VpnStatus::Connected),
            StampAction::Clear
        );

        // Error→Error is NOT an edge (a repeat fatal marker) — LEAVE, so the re-stamp is not
        // mis-consumed on a non-edge (mirrors the sidecar `already_error` D2 guard).
        assert_eq!(
            error_stamp_action(VpnStatus::Error, VpnStatus::Error),
            StampAction::Leave
        );
        // Other in-flight / teardown edges leave the stamp untouched.
        assert_eq!(
            error_stamp_action(VpnStatus::Connected, VpnStatus::Disconnected),
            StampAction::Leave
        );
        assert_eq!(
            error_stamp_action(VpnStatus::Connecting, VpnStatus::Recovering),
            StampAction::Leave
        );
    }

    #[test]
    fn origin_consumed_on_any_terminal_outcome_of_the_attempt() {
        // Truth (Pitfall 2 + CR-01): the pending origin marks EXACTLY ONE connect attempt, and it
        // must be spent on ANY terminal outcome of that attempt — `Connected` (it worked), `Error`
        // (bad config / timeout / sidecar exit) OR `Disconnected` (attempt torn down without
        // connecting). Consuming ONLY on `Connected` was the CR-01 leak: a FAILED auto attempt left
        // the origin set, and the NEXT manual connect read the stale auto origin and mislabelled
        // itself. A genuine transition (prev != next) landing on any of the three consumes; a
        // prev==next snapshot or a transition landing on a transient (`Connecting`) or intermediate
        // (`Reconnecting`/`Recovering`) state does NOT — the attempt is still in flight.
        assert!(origin_consumed_on(VpnStatus::Connecting, VpnStatus::Connected));
        assert!(origin_consumed_on(VpnStatus::Reconnecting, VpnStatus::Connected));
        // CR-01: a failed auto attempt ending in Error consumes the origin (was the leak).
        assert!(origin_consumed_on(VpnStatus::Connecting, VpnStatus::Error));
        // CR-01: an attempt torn down to Disconnected without connecting also consumes.
        assert!(origin_consumed_on(VpnStatus::Connecting, VpnStatus::Disconnected));
        assert!(origin_consumed_on(VpnStatus::Connected, VpnStatus::Disconnected));
        // prev == next snapshot on a terminal — NOT a transition, so no consume.
        assert!(!origin_consumed_on(VpnStatus::Connected, VpnStatus::Connected));
        assert!(!origin_consumed_on(VpnStatus::Error, VpnStatus::Error));
        assert!(!origin_consumed_on(VpnStatus::Disconnected, VpnStatus::Disconnected));
        // Transitions to a still-in-flight state never consume (the attempt is not done).
        assert!(!origin_consumed_on(VpnStatus::Connected, VpnStatus::Reconnecting));
        assert!(!origin_consumed_on(VpnStatus::Connected, VpnStatus::Recovering));
        assert!(!origin_consumed_on(VpnStatus::Disconnected, VpnStatus::Connecting));
    }

    #[test]
    fn origin_and_ping_survive_the_switch_teardown_disconnect_but_a_genuine_disconnect_consumes() {
        // Truth (13-10b): during a switch/reconnect the intermediate teardown Connected→Disconnected
        // must NOT consume the origin + ping — they have to reach the DESTINATION Connected so the
        // switch reads «Переключено автоматически» + the target ping (not «Подключено» + «—»). The
        // teardown is marked by switch_teardown_pending=true.
        assert!(
            !origin_ping_consumed_on(VpnStatus::Connected, VpnStatus::Disconnected, true),
            "a switch teardown Disconnected must NOT consume the origin/ping",
        );
        // The destination Connected (still mid-switch, flag peeked true) consumes normally.
        assert!(origin_ping_consumed_on(VpnStatus::Connecting, VpnStatus::Connected, true));
        // Error at the destination consumes too (a failed switch never leaks a stale origin/ping).
        assert!(origin_ping_consumed_on(VpnStatus::Connecting, VpnStatus::Error, true));
        // REGRESSION GUARD (CR-01): a GENUINE user disconnect (no teardown pending) STILL consumes.
        assert!(
            origin_ping_consumed_on(VpnStatus::Connected, VpnStatus::Disconnected, false),
            "a genuine user disconnect must still consume (no leak into the next connect)",
        );
        // A failed auto-connect torn down to Disconnected (no switch teardown flag) also consumes.
        assert!(origin_ping_consumed_on(VpnStatus::Connecting, VpnStatus::Disconnected, false));
    }

    #[test]
    fn failed_auto_origin_does_not_leak_into_the_next_manual_connect() {
        // Truth (CR-01): an auto attempt that ends in Error (never Connected) must NOT leave the
        // auto origin set for a later MANUAL connect to mislabel. Model the AppState origin cell as
        // a local and run the exact maybe_fire consume rule (peek → consume-on-terminal → decide):
        // (1) set AutoConnectLaunch, the attempt fails to Error → the origin is consumed on that
        //     terminal Error edge (the CR-01 fix), and
        // (2) a later manual connect reaches Connected reading the reset Manual → «Подключено»,
        //     NOT «Автоподключение при запуске».
        let mut origin = ConnectOrigin::AutoConnectLaunch;

        // (1) Auto-connect-on-launch fails: Connecting → Error. Consume on this terminal edge.
        if origin_consumed_on(VpnStatus::Connecting, VpnStatus::Error) {
            origin = ConnectOrigin::Manual;
        }
        assert_eq!(
            origin,
            ConnectOrigin::Manual,
            "a failed auto attempt (Error outcome) must consume the origin (CR-01)",
        );

        // (2) A later MANUAL connect reaches Connected — reads the reset Manual → generic Connected.
        assert_eq!(
            decide_notification(VpnStatus::Connecting, VpnStatus::Connected, origin, true, false, false),
            Some(NotifyKind::Connected),
            "after a failed auto attempt consumes the origin, the next manual connect is Connected",
        );
    }

    #[test]
    fn failed_auto_switch_origin_does_not_leak_into_the_next_manual_connect() {
        // Truth (CR-01, auto-switch variant): an auto-switch whose target fails to come up ends in
        // Error, and the origin must be consumed there too so a later manual connect is not
        // mislabelled «Переключено автоматически».
        let mut origin = ConnectOrigin::AutoSwitch;
        // The auto-switch target fails: the connect leg ends Connecting → Error.
        if origin_consumed_on(VpnStatus::Connecting, VpnStatus::Error) {
            origin = ConnectOrigin::Manual;
        }
        assert_eq!(origin, ConnectOrigin::Manual, "a failed auto-switch must consume the origin");
        assert_eq!(
            decide_notification(VpnStatus::Connecting, VpnStatus::Connected, origin, true, false, false),
            Some(NotifyKind::Connected),
            "after a failed auto-switch consumes the origin, the next manual connect is Connected",
        );
    }

    #[test]
    fn gate_off_silences_but_still_consumes_the_auto_origin() {
        // Truth: the master gate and the origin-consume are INDEPENDENT (the reason maybe_fire
        // resets the origin BEFORE the gate check). Model the two AppState cells as locals and run
        // the exact maybe_fire logic (peek origin → consume-on-Connected-edge → decide) so a
        // gate-off auto-connect (1) fires NOTHING and (2) still spends its origin, so the NEXT
        // (manual) connect with the gate back ON reads Manual → «Подключено», never the stale auto
        // copy. This is the window-closed silence + no-origin-bleed contract of Plan 13-04.
        let mut origin = ConnectOrigin::AutoConnectLaunch;

        // (1) Gate OFF, launch auto-connect reaches Connected: decider suppresses (gate dominates),
        //     but the origin is consumed on this genuine Connected edge.
        let notifications_off = false;
        let peeked = origin;
        if origin_consumed_on(VpnStatus::Connecting, VpnStatus::Connected) {
            origin = ConnectOrigin::Manual;
        }
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connected,
                peeked,
                notifications_off,
                false,
                false,
            ),
            None,
            "gate-off must silence even the auto-connect-on-launch plate",
        );
        assert_eq!(
            origin,
            ConnectOrigin::Manual,
            "the auto origin must be consumed even when the gate suppressed the emit",
        );

        // (2) Gate back ON, a subsequent manual connect: the origin was already reset, so it maps
        //     to the generic Connected — the auto copy did NOT bleed into the manual connect.
        let notifications_on = true;
        let peeked2 = origin;
        assert_eq!(
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connected,
                peeked2,
                notifications_on,
                false,
                false,
            ),
            Some(NotifyKind::Connected),
            "after the auto origin is consumed, the next manual connect reads Manual → Connected",
        );
    }

    #[test]
    fn disconnecting_is_transient_and_settled_disconnect_fires() {
        // 3.4 R-DCT: a transition INTO the new Disconnecting wire-state fires NOTHING (transient, like
        // Connecting). The genuine «Отключено» fires on the SETTLED Disconnecting → Disconnected edge
        // for a real user disconnect, and stays suppressed for a switch/reconnect teardown.
        assert_eq!(
            decide_notification(VpnStatus::Connected, VpnStatus::Disconnecting, ConnectOrigin::Manual, true, false, false),
            None,
            "a transition INTO Disconnecting is transient — fires nothing",
        );
        assert_eq!(
            decide_notification(VpnStatus::Disconnecting, VpnStatus::Disconnected, ConnectOrigin::Manual, true, false, false),
            Some(NotifyKind::Disconnected),
            "a real user disconnect fires «Отключено» on the settled Disconnecting → Disconnected edge",
        );
        assert_eq!(
            decide_notification(VpnStatus::Disconnecting, VpnStatus::Disconnected, ConnectOrigin::Manual, true, true, false),
            None,
            "the teardown half of a switch/reconnect must not flash «Отключено»",
        );
    }

    #[test]
    fn auto_switch_origin_maps_then_resets_to_manual() {
        // Truth (D-01 / Pitfall 2): an auto-switch sets AutoSwitch, its Connected edge maps to
        // AutoSwitched AND consumes the origin, so the FOLLOWING manual connect reads Manual.
        let mut origin = ConnectOrigin::AutoSwitch;

        // The auto-switch's own Connected edge, gate on → AutoSwitched, and it consumes the origin.
        let peeked = origin;
        if origin_consumed_on(VpnStatus::Reconnecting, VpnStatus::Connected) {
            origin = ConnectOrigin::Manual;
        }
        assert_eq!(
            decide_notification(
                VpnStatus::Reconnecting,
                VpnStatus::Connected,
                peeked,
                true,
                false,
                false,
            ),
            Some(NotifyKind::AutoSwitched),
        );
        assert_eq!(origin, ConnectOrigin::Manual, "origin consumed after the auto-switch connected");

        // A subsequent manual connect reads the reset Manual → generic Connected.
        assert_eq!(
            decide_notification(VpnStatus::Connecting, VpnStatus::Connected, origin, true, false, false),
            Some(NotifyKind::Connected),
        );
    }

    #[test]
    fn d29_no_secret_in_notify_payload_or_log() {
        // Truth (D-29 / T-13-SEC-01): the firing policy carries a KIND only — it takes neither
        // config content nor a password, and produces no log line interpolating config content.
        // The decider's entire type surface (VpnStatus + ConnectOrigin + bool in, NotifyKind out)
        // is string-free, so a secret CANNOT structurally reach its inputs or output.
        //
        // The fixture below is the distinctive token a leak would surface (mirroring ping.rs
        // SUPER-SECRET discipline). We format the decider's output — the only value a later-wave
        // payload builder derives from this module — and assert the SECRET appears nowhere in it,
        // proving the (kind + display-name)-only contract holds at the policy seam.
        const SECRET: &str = "SUPER-SECRET-NOTIFY-XYZ";

        // Exercise the full firing surface; collect the Debug render of every decision.
        let decisions = [
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connected,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            decide_notification(
                VpnStatus::Reconnecting,
                VpnStatus::Connected,
                ConnectOrigin::AutoSwitch,
                true,
                false,
                false,
            ),
            decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Error,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
            decide_notification(
                VpnStatus::Connected,
                VpnStatus::Disconnected,
                ConnectOrigin::Manual,
                true,
                false,
                false,
            ),
        ];
        for decision in decisions {
            let rendered = format!("{decision:?}");
            assert!(
                !rendered.contains(SECRET),
                "decide_notification output leaked the secret: {rendered}",
            );
        }

        // The stronger guarantee is STRUCTURAL, not a string scan: `decide_notification`'s
        // entire type surface is `(VpnStatus, VpnStatus, ConnectOrigin, bool) -> Option<NotifyKind>`
        // — there is no `&str`/`String`/config path anywhere in it, so a password CANNOT enter
        // the policy at all. The module is pure (no `eprintln!`/`emit_log`/`emit` of config
        // content anywhere in the non-test code above), so there is no log sink to leak through.
        // These two facts together satisfy the D-29 / T-13-SEC-01 contract at the policy seam;
        // the payload builder that maps a `NotifyKind` to (kind + display-name) lands in Wave 2
        // and carries its own leak test.
    }

    #[test]
    fn pending_plate_stage_then_pull_take_is_read_and_clear() {
        // Truth (13-05): the staged pending-plate cell is drained by `take()` — a pull reads the
        // staged plate exactly once, and a SECOND pull sees `None` (so a StrictMode re-mount or a
        // later pull never redelivers a stale fire). Model the AppState `Mutex<Option<PendingPlate>>`
        // cell directly (the same read-and-clear `take()` `pull_pending_plate` performs) so the
        // round-trip is unit-testable without a live Tauri AppHandle/State.
        let cell: std::sync::Mutex<Option<PendingPlate>> = std::sync::Mutex::new(None);

        // maybe_fire stages the latest plate before its emit (latest-wins overwrite).
        *cell.lock().unwrap() = Some(PendingPlate {
            kind: NotifyKind::AutoConnectLaunch.wire_key().to_string(),
            config_name: "Германия — Frankfurt".to_string(),
            theme: "dark".to_string(),
            language: "ru".to_string(),
            address: None,
            login: None,
            ping_ms: None,
        });
        // A later fire overwrites — the pull must redeliver the CURRENT state (D-03). 13-08: this one
        // is a CONNECT fire, so it also carries the address/login/ping detail fields.
        *cell.lock().unwrap() = Some(PendingPlate {
            kind: NotifyKind::Connected.wire_key().to_string(),
            config_name: "США — New York".to_string(),
            theme: "light".to_string(),
            language: "en".to_string(),
            address: Some("ny.example.net:443".to_string()),
            login: Some("ivan_petrov".to_string()),
            ping_ms: Some(42),
        });

        // First pull drains the CURRENT (latest) staged plate.
        let pulled = cell.lock().unwrap().take();
        let pulled = pulled.expect("a staged plate must be pulled");
        assert_eq!(pulled.kind, "connected");
        assert_eq!(pulled.config_name, "США — New York");
        // 13-06: the redelivered plate carries the theme staged with it (latest-wins).
        assert_eq!(pulled.theme, "light");
        // 13-07: it also carries the language staged with it (latest-wins).
        assert_eq!(pulled.language, "en");
        // 13-08: it carries the CONNECT detail fields staged with it (latest-wins).
        assert_eq!(pulled.address.as_deref(), Some("ny.example.net:443"));
        assert_eq!(pulled.login.as_deref(), Some("ivan_petrov"));
        assert_eq!(pulled.ping_ms, Some(42));

        // Second pull sees None — the stage was cleared by the first take() (no stale redelivery).
        assert!(
            cell.lock().unwrap().take().is_none(),
            "a second pull must see None — the stage is read-and-clear",
        );
    }

    #[test]
    fn pending_plate_carries_no_secret_only_kind_and_display_name() {
        // Truth (D-29 / T-13-05-01): the staged PendingPlate — the new surface that crosses the
        // Rust→plate boundary via `pull_pending_plate` — carries ONLY the kind wire_key + the
        // config DISPLAY NAME. Its whole type surface is two Strings; a `.toml`, host, or password
        // cannot structurally reach it. Build one from the same values `maybe_fire` stages and
        // assert the distinctive secret token appears nowhere in either field (mirroring the
        // `d29_no_secret_in_notify_payload_or_log` / ping.rs SUPER-SECRET discipline).
        const SECRET: &str = "SUPER-SECRET-NOTIFY-XYZ";
        let staged = PendingPlate {
            kind: NotifyKind::Connected.wire_key().to_string(),
            config_name: "Германия — Frankfurt".to_string(),
            theme: "light".to_string(),
            language: "en".to_string(),
            // 13-08: a CONNECT plate carries the address + login + ping — all DISPLAY values.
            address: Some("de-fra.trusttunnel.net:443".to_string()),
            login: Some("ivan_petrov".to_string()),
            ping_ms: Some(42),
        };
        assert!(!staged.kind.contains(SECRET), "kind must be a wire_key only");
        assert!(
            !staged.config_name.contains(SECRET),
            "config_name is a display name — never the .toml, host, or password",
        );
        // 13-06: the theme is a whitelisted 2-value string — never free-form config content / secret.
        assert!(!staged.theme.contains(SECRET), "theme is a 2-value enum-like — no secret");
        assert!(staged.theme == "dark" || staged.theme == "light");
        // 13-07: the language is a whitelisted 2-value string — never free-form config content / secret.
        assert!(!staged.language.contains(SECRET), "language is a 2-value enum-like — no secret");
        assert!(staged.language == "ru" || staged.language == "en");
        // 13-08: the CONNECT detail fields are DISPLAY strings (address host:port + login) — NEVER the
        // password. The ping is a numeric u32 that cannot structurally carry a string secret.
        assert!(
            !staged.address.as_deref().unwrap_or_default().contains(SECRET),
            "the plate address is host:port — never the password (D-29)",
        );
        assert!(
            !staged.login.as_deref().unwrap_or_default().contains(SECRET),
            "the plate login is the username — never the password (D-29)",
        );
        // The kind is always one of the audited wire keys — never free-form config content.
        assert_eq!(staged.kind, "connected");
    }

    #[test]
    fn start_plate_wire_key_honours_the_fe_switch_hint_over_origin() {
        // Truth (Fable-A review #6): the FE-threaded switch-vs-reconnect hint WINS over the origin.
        // A MANUAL server switch and a save-and-reconnect BOTH carry origin=Manual, so the origin
        // alone cannot tell them apart — before the hint, a deliberate manual switch fired the
        // `reconnecting` start plate whose body («Связь прервалась — восстанавливаю») falsely
        // claimed the link dropped. With the hint: a SWITCH (manual or auto, Some(true)) fires the
        // NEUTRAL `switching` plate; a same-server RECONNECT (Some(false)) keeps `reconnecting`
        // (owner-accepted in UAT test 12) — regardless of what the origin cell holds.
        assert_eq!(
            start_plate_wire_key(ConnectOrigin::Manual, Some(true)),
            "switching",
            "a MANUAL server switch must show the neutral switching plate",
        );
        assert_eq!(
            start_plate_wire_key(ConnectOrigin::Manual, Some(false)),
            "reconnecting",
            "a manual save-and-reconnect keeps the reconnecting plate",
        );
        assert_eq!(
            start_plate_wire_key(ConnectOrigin::AutoSwitch, Some(true)),
            "switching",
            "the auto-switch keeps the switching plate",
        );
        // Defensive: an explicit reconnect hint beats even a stale AutoSwitch origin.
        assert_eq!(
            start_plate_wire_key(ConnectOrigin::AutoSwitch, Some(false)),
            "reconnecting",
        );
    }

    #[test]
    fn start_plate_wire_key_without_hint_falls_back_to_origin_mapping() {
        // Truth (13-10 / §A, kept as the hintless fallback): without the FE hint (an older FE or a
        // hintless caller) the seam maps the pending origin. An AutoSwitch shows the `switching`
        // kind; a Manual origin reuses the existing `reconnecting` start plate. AutoConnectLaunch
        // never raises the teardown intent, but if it somehow did it falls through to `reconnecting`
        // (the safe non-`switching` default) — the mapping is total. This is the exact mapping the
        // command threads into `fire_start_plate`.
        assert_eq!(
            start_plate_wire_key(ConnectOrigin::AutoSwitch, None),
            "switching",
        );
        assert_eq!(start_plate_wire_key(ConnectOrigin::Manual, None), "reconnecting");
        assert_eq!(
            start_plate_wire_key(ConnectOrigin::AutoConnectLaunch, None),
            "reconnecting",
        );
    }

    #[test]
    fn start_plate_wire_keys_are_valid_fe_kinds() {
        // Truth (13-10 / §A): every reachable start wire key must be a REAL FE `notificationCopy`
        // key the plate can render. `reconnecting` is one of the 7 outcome kinds (also emitted by
        // the decider); `switching` is the FE-only start kind added in `notificationCopy.ts`.
        // Neither is free-form — this guards the seam from drifting to a key the FE cannot render
        // (an invisible start plate). Exhaustive over origin × hint. (The FE side asserts the copy
        // map actually contains both keys; here we lock the Rust literals.)
        for origin in [
            ConnectOrigin::AutoSwitch,
            ConnectOrigin::Manual,
            ConnectOrigin::AutoConnectLaunch,
        ] {
            for hint in [None, Some(true), Some(false)] {
                let key = start_plate_wire_key(origin, hint);
                assert!(
                    matches!(key, "switching" | "reconnecting"),
                    "start wire key must be a known FE kind, got {key}",
                );
            }
        }
    }

    #[test]
    fn is_connect_marks_only_the_three_connect_kinds() {
        // Truth (13-08): only the three "reached a connected server" outcomes carry the detail block;
        // the compact kinds (disconnect / error / reconnect / recovering) never do (owner: reconnecting
        // etc. stay compact). `is_connect` is the predicate maybe_fire branches on (async detail path
        // vs the synchronous compact path).
        assert!(NotifyKind::Connected.is_connect());
        assert!(NotifyKind::AutoSwitched.is_connect());
        assert!(NotifyKind::AutoConnectLaunch.is_connect());
        assert!(!NotifyKind::Disconnected.is_connect());
        assert!(!NotifyKind::ConnectionError.is_connect());
        assert!(!NotifyKind::Reconnecting.is_connect());
        assert!(!NotifyKind::Recovering.is_connect());
    }

    #[test]
    fn pending_connect_ping_is_consumed_on_the_terminal_edge_no_leak_into_next_connect() {
        // Truth (13-08b): the pending connect-time ping is a ONE-SHOT the FE pushes right before a
        // connect; it must be spent (reset to None) on the SAME terminal edge the origin is consumed
        // (`origin_consumed_on` — a genuine Connected / Error / Disconnected transition), so a FAILED
        // attempt cannot leak a stale ping into the NEXT connect. Model the AppState `Mutex<Option<u32>>`
        // cell as a local and run the exact maybe_fire consume rule (peek → consume-on-terminal-edge)
        // so the round-trip is unit-testable without a live Tauri AppHandle/State.
        let cell: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

        // (1) The FE pushes a ping (42 ms) before an auto attempt, which then FAILS to Error.
        *cell.lock().unwrap() = Some(42);
        // maybe_fire peeks the ping for THIS fire...
        let peeked = *cell.lock().unwrap();
        assert_eq!(peeked, Some(42), "the fire uses the pushed ping");
        // ...then consumes it on the terminal Error edge (mirrors the origin consume).
        if origin_consumed_on(VpnStatus::Connecting, VpnStatus::Error) {
            *cell.lock().unwrap() = None;
        }
        assert_eq!(
            *cell.lock().unwrap(),
            None,
            "a failed attempt (Error outcome) must consume the ping — no leak (13-08b)",
        );

        // (2) A later MANUAL connect that pushes NO ping reaches Connected reading None → «—», NOT the
        // stale 42 ms from the failed attempt above.
        let peeked2 = *cell.lock().unwrap();
        assert_eq!(
            peeked2, None,
            "after a failed attempt consumes the ping, the next connect with no push reads None → «—»",
        );
    }

    #[test]
    fn pending_connect_ping_consumed_on_connected_and_disconnected_edges_too() {
        // Truth (13-08b): the ping is consumed on ANY terminal outcome of the attempt (Connected —
        // it worked; Disconnected — torn down without connecting), exactly like the origin. A
        // prev==next snapshot or an in-flight state never consumes it. This mirrors
        // `origin_consumed_on_any_terminal_outcome_of_the_attempt` for the ping cell.
        // Connected edge consumes.
        let cell: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(Some(88));
        if origin_consumed_on(VpnStatus::Connecting, VpnStatus::Connected) {
            *cell.lock().unwrap() = None;
        }
        assert_eq!(*cell.lock().unwrap(), None, "a Connected edge consumes the ping");

        // Disconnected edge (attempt torn down) consumes.
        let cell: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(Some(88));
        if origin_consumed_on(VpnStatus::Connecting, VpnStatus::Disconnected) {
            *cell.lock().unwrap() = None;
        }
        assert_eq!(*cell.lock().unwrap(), None, "a torn-down Disconnected edge consumes the ping");

        // An in-flight transition (→ Reconnecting) does NOT consume — the attempt is not finished.
        let cell: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(Some(88));
        if origin_consumed_on(VpnStatus::Connected, VpnStatus::Reconnecting) {
            *cell.lock().unwrap() = None;
        }
        assert_eq!(
            *cell.lock().unwrap(),
            Some(88),
            "an in-flight transition must NOT consume the ping (attempt still running)",
        );
    }

    #[test]
    fn connect_plate_carries_the_mirrored_ping_not_a_fresh_probe() {
        // Truth (13-08b): the CONNECT plate's ping is the FE-mirrored `pending_connect_ping` value
        // (peeked in maybe_fire), NOT a fresh probe of the active endpoint. maybe_fire threads the
        // peeked ping straight into the NotifyPlatePayload's `ping_ms` for a connect kind, and None
        // for a compact kind. Assert the payload shape both ways (a numeric ping renders «{n} мс»;
        // None → «—» on the FE). The value here stands in for the mirrored `pending_ping` local.
        let mirrored: Option<u32> = Some(37);
        let connect = NotifyPlatePayload {
            kind: NotifyKind::Connected.wire_key(),
            config_name: "Германия".to_string(),
            theme: "dark".to_string(),
            language: "ru".to_string(),
            address: Some("de-fra.trusttunnel.net:443".to_string()),
            login: Some("ivan_petrov".to_string()),
            ping_ms: mirrored,
        };
        assert_eq!(connect.ping_ms, Some(37), "the connect plate carries the mirrored ping");

        // A connect whose config had NO known ping (None pushed / unreachable) renders «—».
        let no_ping: Option<u32> = None;
        let connect_no_ping = NotifyPlatePayload {
            kind: NotifyKind::AutoConnectLaunch.wire_key(),
            config_name: "США".to_string(),
            theme: "dark".to_string(),
            language: "ru".to_string(),
            address: Some("ny.example.net:443".to_string()),
            login: Some("ivan_petrov".to_string()),
            ping_ms: no_ping,
        };
        assert_eq!(
            connect_no_ping.ping_ms, None,
            "a connect with no mirrored ping carries None → the plate renders «—» (honest no-data)",
        );
    }

    #[test]
    fn notify_plate_payload_serializes_connect_details_camelcase_without_password() {
        // Truth (13-08 / D-29): the emitted NotifyPlatePayload serializes the CONNECT detail fields as
        // camelCase (`address`, `login`, `pingMs`) and NEVER carries the password. A compact payload
        // (all detail fields None) omits them entirely (skip_serializing_if). Serialize both shapes and
        // assert the wire JSON.
        const SECRET: &str = "SUPER-SECRET-NOTIFY-XYZ";

        // A CONNECT payload — the detail fields present, camelCase on the wire.
        let connect = NotifyPlatePayload {
            kind: NotifyKind::Connected.wire_key(),
            config_name: "Германия".to_string(),
            theme: "dark".to_string(),
            language: "ru".to_string(),
            address: Some("de-fra.trusttunnel.net:443".to_string()),
            login: Some("ivan_petrov".to_string()),
            ping_ms: Some(42),
        };
        let json = serde_json::to_string(&connect).expect("payload serializes");
        assert!(json.contains("\"address\":\"de-fra.trusttunnel.net:443\""));
        assert!(json.contains("\"login\":\"ivan_petrov\""));
        assert!(json.contains("\"pingMs\":42"));
        assert!(json.contains("\"configName\":\"Германия\""));
        // D-29: the wire JSON must never carry the password.
        assert!(!json.contains(SECRET), "the emitted payload must never carry the password (D-29)");

        // A COMPACT payload — the detail fields are None and are OMITTED from the wire (not null).
        let compact = NotifyPlatePayload {
            kind: NotifyKind::Disconnected.wire_key(),
            config_name: "Германия".to_string(),
            theme: "dark".to_string(),
            language: "ru".to_string(),
            address: None,
            login: None,
            ping_ms: None,
        };
        let json = serde_json::to_string(&compact).expect("payload serializes");
        assert!(!json.contains("address"), "a compact payload omits the address field");
        assert!(!json.contains("login"), "a compact payload omits the login field");
        assert!(!json.contains("pingMs"), "a compact payload omits the pingMs field");
    }
}
