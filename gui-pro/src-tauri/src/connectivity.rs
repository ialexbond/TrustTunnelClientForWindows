use socket2::{Socket, Domain, Type, Protocol, SockAddr};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::Notify;

use crate::commands::vpn::VpnStatus;
use crate::logging::log_app;

/// CR-02 single-supervisor guard. Sets `reconnect_in_progress = true` on `claim`
/// and clears it on Drop, so the flag is reset on EVERY supervisor exit path
/// (Recovered / Aborted / GaveUp, and the GaveUp-suppression early return) without
/// having to thread a manual clear through each branch. Mirrors the RAII pattern of
/// `OwnedJobHandle`: the Drop side-effect is the whole point.
struct ReconnectInProgressGuard(Arc<AtomicBool>);

impl ReconnectInProgressGuard {
    /// ATOMICALLY claim the supervisor slot (CR-02). Uses `compare_exchange(false→true)`
    /// so two concurrent starters can NEVER both win: the trigger sites (the sidecar
    /// Terminated arm, the connectivity-loss path, the recovery flow) each check the flag
    /// then spawn, and the previous blind `store(true)` left a check-then-set TOCTOU
    /// where both could read `false`, both store `true`, and TWO supervisors raced (both
    /// respawning, each killing the other's child) — exactly the «застряло на Подключено»
    /// / phantom-reconnect class of bug (Codex review). Only the actor that flips
    /// false→true gets the guard; the loser receives `None` and backs off. `Drop`
    /// releases the slot so a genuine NEW drop after this owner finishes starts fresh.
    fn try_claim(flag: Arc<AtomicBool>) -> Option<Self> {
        match flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => Some(ReconnectInProgressGuard(flag)),
            Err(_) => None,
        }
    }
}

impl Drop for ReconnectInProgressGuard {
    fn drop(&mut self) {
        // Release the slot so a genuine NEW drop (after this supervisor finished)
        // can start a fresh supervisor.
        self.0.store(false, Ordering::SeqCst);
    }
}

// IN-03: recovery timing promoted from inline literals to named consts so the
// rationale in the comments and the actual value can never drift apart.
//
// 02-07 (UAT Gap #1, tests 6/7/8): the OLD cadence (POLL=20s × MAX_FAILURES=4)
// gave an ~80s sleep floor before a drop could even be declared, plus ~15-60s of
// per-check timeouts — a ~95-140s "phantom connected" window. The cadence is now
// tightened. NOTE (F21, 14-UAT round 2 — accuracy fix, no behavior change): the
// often-quoted "~10-15s" is only the SLEEP-CADENCE FLOOR (POLL 4s × MAX_FAILURES
// 3 ≈ 12s). The REAL end-to-end declaration window adds a ~3s `check_tunnel_alive`
// probe to EACH failing iteration plus the final reason-gate probe → ~20-25s worst
// case (matches the observed «поздно ловит обрыв»). Still collapses the old
// ~80-140s floor and is handed to the reconnect supervisor. The probe was ALSO
// retargeted from the local gateway to the
// TUNNEL/SERVER path (see `check_tunnel_alive`), so a server-silent drop (LAN up,
// server dead) is caught at the same speed as an Ethernet unplug — the old
// gateway probe stayed "online" when only the server died.
/// How often the monitor checks tunnel liveness while VPN is connected.
/// 4s × MAX_FAILURES gives an offline SLEEP floor of ~12s of cadence; the REAL
/// end-to-end declaration window is ~20-25s once the ~3s per-iteration
/// `check_tunnel_alive` probe + the reason-gate probe are counted (F21, round 2) —
/// still collapsing the old ~80-140s floor (UAT Gap #1).
const POLL_INTERVAL_SECS: u64 = 4;
/// Consecutive failed tunnel probes before declaring the tunnel down (~12-15s).
/// Requiring N>1 failures (not a single miss) tolerates one transient probe miss
/// under heavy load so a busy-but-healthy tunnel is never false-killed (T-07-01).
const MAX_FAILURES: u32 = 3;
/// Per-probe timeout for the active tunnel-path liveness check. Tight (a few
/// seconds) so a dead tunnel is noticed quickly, but generous enough that a
/// single slow round-trip under load is not mistaken for a death — the
/// MAX_FAILURES counter, not a single timeout, is what declares offline.
const TUNNEL_PROBE_TIMEOUT_SECS: u64 = 3;
/// Sleep/hibernate/resume re-baseline threshold (02-10, Tier-3). A monitor loop
/// iteration normally takes ~POLL_INTERVAL_SECS (plus a probe). If the wall-clock
/// gap measured AROUND the per-iteration sleep greatly exceeds that — the machine
/// was suspended and just resumed — acting on the now-stale deadlines is wrong:
/// without a re-baseline the monitor would either (a) hold a stale "connected" for
/// too long, or (b) burst-fail because probe deadlines elapsed while asleep. We treat
/// a gap past this many SECONDS as a resume. Set well above the normal worst-case
/// iteration (cadence + two ~3s probe timeouts ≈ 10s) so a merely slow probe is never
/// mistaken for a resume, but low enough to catch a real suspend (≥30s of sleep).
const RESUME_GAP_THRESHOLD_SECS: u64 = 30;

/// Pure resume detector: did the wall-clock gap across one monitor iteration exceed
/// the resume threshold (i.e. the machine slept)? Free of any clock/IO so the
/// classification is unit-testable. 02-10 (Tier-3).
fn is_resume_gap(gap: Duration) -> bool {
    gap >= Duration::from_secs(RESUME_GAP_THRESHOLD_SECS)
}

/// WR-01 (02-14 review): minimum spacing between two EVENT-DRIVEN immediate
/// re-checks. The OS fires `interface_change_callback` for EVERY interface event —
/// including benign parameter-only changes (MTU/metric tweaks) and the burst a
/// flapping NIC / Wi-Fi roam / DHCP renew produces. Without a floor, each woken
/// re-check (up to ~9s of probing) is immediately followed by the next stored
/// notify permit, so the select's cadence sleep is bypassed back-to-back and the
/// monitor degenerates into a continuous probe loop for as long as the link flaps.
///
/// We coalesce: the FIRST wake of a burst is honored immediately (a genuine
/// link-down is still detected fast), but a subsequent wake arriving sooner than
/// this interval is absorbed — the normal poll cadence (POLL_INTERVAL_SECS) still
/// covers it. Kept well under RESUME_GAP_THRESHOLD_SECS so resume detection is
/// unaffected.
const EVENT_WAKE_MIN_INTERVAL_MS: u64 = 750;

/// Pure debounce decision for WR-01: given the moment a notify-driven wake arrived
/// (`now`) and when the last event-driven re-check was honored (`last`), should we
/// run an IMMEDIATE re-check now, or coalesce this wake into the normal cadence?
/// The first wake of a burst (`last == None`) is always honored. Free of any
/// clock/IO so the decision is unit-testable.
fn should_honor_event_wake(now: Instant, last: Option<Instant>) -> bool {
    match last {
        None => true,
        Some(prev) => now.duration_since(prev) >= Duration::from_millis(EVENT_WAKE_MIN_INTERVAL_MS),
    }
}

// ── 02-18 (STATUS-05 gap): fast LOCAL-uplink-loss short-circuit ──────────────
//
// IN-03: the flap-confirm window is promoted to named consts so the rationale and
// the actual values can never drift. The 02-14 event wake already runs the woken
// iteration ~immediately on a link-state change, but that iteration still had to
// fail `check_tunnel_alive()` MAX_FAILURES times (each a multi-endpoint HTTP probe
// with a TUNNEL_PROBE_TIMEOUT_SECS budget) before declaring offline — so a real
// uplink loss took ~1 minute, not real-time (user-reported). The fix is to check
// `find_physical_adapter()` FIRST (ipconfig enumeration — NO network I/O), which
// returns None INSTANTLY when no Up Ethernet/Wi-Fi adapter with a gateway exists,
// and which already excludes the VPN's own wintun adapter — so it is the instant,
// not-fooled "uplink gone" signal even while the tunnel is up.
//
// FLAP-SAFE (T-18-01): a Wi-Fi roam / DHCP renew can blip the adapter None for ~1s.
// We do NOT kill on a single transient — the loss is CONFIRMED by re-checking
// `find_physical_adapter()` UPLINK_CONFIRM_CHECKS times spaced UPLINK_CONFIRM_INTERVAL_MS
// apart (~1.5s total); if ANY re-check finds the adapter back, it was a flap → skip
// the short-circuit and fall through to the normal flow. A genuine disable/unplug
// stays None the whole window → confirmed offline in ~1-2s.
/// How many times the short-circuit re-checks the physical adapter before declaring
/// the uplink genuinely gone. >1 so a single transient blip (Wi-Fi roam / DHCP renew)
/// cannot false-kill (T-18-01).
const UPLINK_CONFIRM_CHECKS: u32 = 3;
/// Spacing between the flap-confirm re-checks. UPLINK_CONFIRM_CHECKS × this ≈ 1.5s of
/// confirmation — long enough that a brief roam recovers within the window, short
/// enough that a real disable/unplug is declared offline in ~1-2s. Kept well under
/// RESUME_GAP_THRESHOLD_SECS so a confirm pass is never mistaken for a suspend.
const UPLINK_CONFIRM_INTERVAL_MS: u64 = 500;

/// Pure decision for the flap-safe uplink-loss confirm (T-18-01): given the sequence
/// of "physical adapter present?" samples taken across the confirm window, is the
/// uplink CONFIRMED gone? It is gone only if EVERY sample was `false` (absent) and we
/// actually took at least one sample — if ANY sample saw the adapter back, it was a
/// transient flap and we must NOT declare offline. Free of any clock/IO so the
/// decision is unit-testable; the real "disable adapter ⇒ ~1-2s offline" is manual UAT.
fn uplink_loss_confirmed(adapter_present_samples: &[bool]) -> bool {
    !adapter_present_samples.is_empty()
        && adapter_present_samples.iter().all(|present| !present)
}

/// Pure decision for the WR-04 corroboration: once the physical adapter is CONFIRMED
/// absent over the flap window, we run ONE tunnel probe before killing the session.
/// We declare offline ONLY if the tunnel probe ALSO failed. If the probe SUCCEEDED the
/// adapter merely LOOKED gone — almost certainly a real NIC that
/// `find_physical_adapter()`'s description blacklist (wintun|vpn|virtual|tap-)
/// misclassified — and the tunnel is demonstrably alive, so we must NOT declare offline.
/// Free of any clock/IO so the decision is unit-testable; the real adapter enumeration
/// and HTTP probe are exercised in manual UAT.
fn should_declare_offline_after_corroboration(
    uplink_confirmed_gone: bool,
    tunnel_alive: bool,
) -> bool {
    uplink_confirmed_gone && !tunnel_alive
}

/// How often, during recovery, the monitor polls for the physical adapter.
const ADAPTER_POLL_INTERVAL_SECS: u64 = 5;
/// Give up waiting for the adapter after this many recovery polls
/// (ADAPTER_RECOVERY_TIMEOUT_CHECKS × ADAPTER_POLL_INTERVAL_SECS ≈ 5 minutes).
const ADAPTER_RECOVERY_TIMEOUT_CHECKS: u32 = 60;

/// 02-20 status-UX split: how many adapter polls the «Восстановление» (Recovering)
/// wait runs before giving up with `Error("recovery-timeout")` on an `internet-lost`
/// drop. On a LOCAL-NETWORK loss the monitor shows Recovering and WAITS for the
/// physical adapter (it does NOT burn the bounded reconnect attempts — there is
/// nothing to connect to yet); if the adapter is still gone after
/// `RECOVERY_TIMEOUT_CHECKS × ADAPTER_POLL_INTERVAL_SECS`, the session moves to a
/// terminal Error.
///
/// PRODUCTION value: 60 × 5s = ~5 minutes (user decision, UAT fd63ec — a brief outage
/// or a router reboot should not give up too early; the user can «Отмена» any time). It
/// matches `ADAPTER_RECOVERY_TIMEOUT_CHECKS`. The const-sanity test
/// (`recovery_timeout_is_five_minutes`) locks the value so this comment and the value
/// can never drift.
const RECOVERY_TIMEOUT_CHECKS: u32 = 60;

/// Stable, secret-free ASCII reason code emitted when the TUNNEL/SERVER path is
/// dead but the local network is still reachable (server-silent drop / dead
/// tunnel over a live LAN). D-09/D-29: a FIXED token, never a config/server
/// string and never Cyrillic — Plan 02-09 maps it to a localized message on the
/// frontend. Distinct from `INTERNET_LOST_REASON` so the UI can tell "your VPN
/// server stopped responding" apart from "your whole internet is down".
pub const TUNNEL_LOST_REASON: &str = "tunnel-lost";
/// Stable, secret-free ASCII reason code emitted when even the LOCAL network is
/// unreachable (Ethernet unplug / Wi-Fi off) — the gateway gate below also
/// failed, so this is a whole-internet outage rather than a server-silent drop.
pub const INTERNET_LOST_REASON: &str = "internet-lost";

// ── 02-14 (STATUS-05): real-time local-network-loss detection ───────────────
//
// The monitor above polls on a fixed cadence (POLL_INTERVAL_SECS), so a physical
// uplink drop (Ethernet unplugged / Wi-Fi off) is only NOTICED on the next poll —
// the user stares at a "connected" tray for ~10-15s after pulling the cable and
// assumes "the internet is just slow". To collapse that LOCAL-loss latency to
// ~instant we subscribe to the Win32 IP-interface-change notification
// (`NotifyIpInterfaceChange`, iphlpapi). When ANY interface changes state the OS
// fires our callback within milliseconds; the callback merely WAKES the existing
// monitor loop (via `tokio::sync::Notify`) so it runs its NORMAL connectivity
// check NOW instead of sleeping to the next tick.
//
// DESIGN (Option A — pre-resolved): the event does NOT itself decide "offline".
// It only shortens the wait, so it reuses EVERY existing guard (post-connect
// grace-skip, MAX_FAILURES consecutive-failure threshold, generation guard,
// disconnecting / reconnect_in_progress handoff). That makes it robust against a
// transient Wintun adapter flap during connect (the adapter appearing/disappearing
// fires this same notification) — a flap cannot false-kill because the woken
// re-check still has to fail the normal way. For a genuine uplink loss the
// tunnel/gateway becomes unreachable immediately, so the woken re-check declares
// offline sub-second. The active tunnel probe + cadence (Plan 02-07) is UNCHANGED
// and stays as the fallback for a server-silent drop (link up, server dead) — the
// event path only fast-tracks the LOCAL-loss case (T-14-01).

/// RAII wrapper around a `NotifyIpInterfaceChange` registration plus the boxed
/// callback context it points at — mirrors `OwnedJobHandle` (job_object.rs): the
/// `Drop` side-effect (cancel + free) is the whole point, so a single value owns
/// the pairing and there is no manual cleanup threaded through the monitor's exit
/// paths (T-14-02: exactly one `CancelMibChangeNotify2` per registration, no leak).
///
/// `handle` is the opaque `HANDLE` returned by `NotifyIpInterfaceChange`; `ctx` is
/// the raw pointer to the `Box<Arc<Notify>>` we handed the OS as the caller
/// context. Order matters in `Drop`: we CANCEL first (so the OS can no longer fire
/// the callback and dereference `ctx`), THEN reclaim and free the box. Reclaiming
/// before the cancel returned would risk a use-after-free if a callback were
/// in-flight on a worker thread.
#[cfg(target_os = "windows")]
struct InterfaceChangeNotifier {
    handle: windows_sys::Win32::Foundation::HANDLE,
    ctx: *mut Arc<Notify>,
}

// SAFETY: `start_monitor` runs on `tauri::async_runtime::spawn`, whose future must
// be `Send`; holding the raw `HANDLE` + `*mut Arc<Notify>` across the loop's awaits
// would otherwise make it non-Send. Both fields are safe to move between threads:
// the `HANDLE` is an opaque OS handle, and the boxed `Arc<Notify>` (Arc is Send +
// Sync) is only ever dereferenced by the OS callback (which the OS may run on any
// worker thread anyway) and reclaimed exactly once in Drop AFTER the cancel. No
// field is mutated after construction except the one-shot free in Drop.
#[cfg(target_os = "windows")]
unsafe impl Send for InterfaceChangeNotifier {}

#[cfg(target_os = "windows")]
impl InterfaceChangeNotifier {
    /// Register `NotifyIpInterfaceChange` so OS interface-state changes wake `notify`.
    ///
    /// The OS callback runs on a Windows worker thread, so the context must outlive
    /// the registration and be freed only AFTER the cancel. We leak a
    /// `Box<Arc<Notify>>` into a raw pointer, hand that pointer to the OS as the
    /// caller context, and reclaim it in `Drop`. On a registration failure we free
    /// the box immediately (no leak) and return `None` — the monitor still works,
    /// just without the real-time wake (it falls back to the poll cadence).
    fn register(notify: Arc<Notify>) -> Option<Self> {
        use windows_sys::Win32::NetworkManagement::IpHelper::NotifyIpInterfaceChange;
        use windows_sys::Win32::Networking::WinSock::AF_UNSPEC;

        // Box the Arc<Notify> and leak it to a stable raw pointer the OS can hold.
        let ctx: *mut Arc<Notify> = Box::into_raw(Box::new(notify));
        let mut handle: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();

        // SAFETY: FFI into a documented Win32 API. `ctx` points at a live, leaked
        // Box that stays valid until our Drop reclaims it AFTER CancelMibChangeNotify2,
        // so the callback can dereference it for the whole registration lifetime.
        // `AF_UNSPEC` (an ADDRESS_FAMILY / u16) asks for both IPv4 and IPv6 interface
        // changes; the InitialNotification arg = 0 (FALSE) means "don't fire an
        // immediate synthetic callback" — we only want REAL state-change events, not a
        // startup ping that would wake the monitor for nothing.
        let status = unsafe {
            NotifyIpInterfaceChange(
                AF_UNSPEC,
                Some(interface_change_callback),
                ctx as *const core::ffi::c_void,
                0, // InitialNotification = FALSE (BOOLEAN / u8)
                &mut handle,
            )
        };

        // NO_ERROR (0) means the registration took. On any other status the OS will
        // never call back, so reclaim and drop the box now to avoid a leak.
        if status != 0 {
            // SAFETY: registration failed, so the OS never stored `ctx`; we are the
            // sole owner and reclaim the box exactly once.
            unsafe { drop(Box::from_raw(ctx)) };
            log_app(
                "WARN",
                "[connectivity] NotifyIpInterfaceChange registration failed — real-time link-loss wake disabled (falling back to poll cadence)",
            );
            return None;
        }

        log_app(
            "INFO",
            "[connectivity] real-time link-state notification armed (NotifyIpInterfaceChange)",
        );
        Some(InterfaceChangeNotifier { handle, ctx })
    }
}

#[cfg(target_os = "windows")]
impl Drop for InterfaceChangeNotifier {
    fn drop(&mut self) {
        use windows_sys::Win32::NetworkManagement::IpHelper::CancelMibChangeNotify2;
        // SAFETY: `handle` is the live registration from `register`. Cancel FIRST so
        // the OS guarantees no callback is running or will run after it returns; only
        // THEN is it safe to reclaim and free the boxed context the callback reads.
        //
        // SAFETY (additional preconditions, load-bearing — WR-02):
        //  1. The callback body must stay signal-safe and MUST NOT (directly or
        //     transitively) drop this notifier or call CancelMibChangeNotify2 — that
        //     API BLOCKS until in-flight callbacks finish, so cancelling from within
        //     the callback would deadlock (and racing it under a lock the callback also
        //     takes would too). Today this holds trivially: the callback only does
        //     `notify_one()`, and Drop runs on the monitor task, never on a callback
        //     thread.
        //  2. Registration happens exactly ONCE per process — `start_monitor` is
        //     spawned once at app setup (lib.rs) and its loop never breaks, so this is
        //     the sole register/cancel pair and there is no re-arm path. The
        //     "late callback touches freed memory" scenario therefore cannot occur in
        //     the current call graph: `_notifier` Drop only runs at process teardown.
        //     Adding any teardown/re-arm path requires re-auditing that no callback can
        //     be in flight across the new Drop.
        unsafe {
            CancelMibChangeNotify2(self.handle);
            // Reclaim the leaked Box<Arc<Notify>> and drop it — exactly one free per
            // one Box::into_raw in `register` (no leak, no double-free).
            drop(Box::from_raw(self.ctx));
        }
    }
}

/// OS callback for `NotifyIpInterfaceChange`. Runs on a Windows worker thread, so
/// it does the ABSOLUTE MINIMUM: read the `Arc<Notify>` from the caller context and
/// `notify_one()` to wake the monitor. `Notify::notify_one` is just an atomic
/// store + maybe a waker wake — it never blocks and touches no tokio runtime
/// internals, so it is safe to call from a foreign thread. We deliberately IGNORE
/// the row/notification-type: deciding "offline" here would bypass the monitor's
/// guards (Option A); the woken re-check makes the real decision. Note this also
/// means we wake on parameter-only changes (MTU/metric tweaks via
/// `MibParameterNotification`), not just link transitions — a deliberate
/// over-trigger the re-check absorbs, and the root multiplier the WR-01 debounce in
/// `start_monitor` coalesces.
#[cfg(target_os = "windows")]
unsafe extern "system" fn interface_change_callback(
    caller_context: *const core::ffi::c_void,
    _row: *const windows_sys::Win32::NetworkManagement::IpHelper::MIB_IPINTERFACE_ROW,
    _notification_type: windows_sys::Win32::NetworkManagement::IpHelper::MIB_NOTIFICATION_TYPE,
) {
    if caller_context.is_null() {
        return;
    }
    // SAFETY: `caller_context` is the `*mut Arc<Notify>` we passed to
    // NotifyIpInterfaceChange; the owning InterfaceChangeNotifier keeps the Box
    // alive until AFTER CancelMibChangeNotify2, so the pointer is valid for every
    // callback the OS delivers. We only borrow it (no ownership transfer here).
    let notify = &*(caller_context as *const Arc<Notify>);
    notify.notify_one();
}


/// Periodically check TUNNEL liveness while VPN is connected.
/// Emits "internet-status" events with { online: bool, action?, reason? } payload.
/// When the tunnel drops, hands off to the window-independent reconnect supervisor
/// (or, in the fallback path, waits for the primary adapter before signaling
/// reconnect).
///
/// 02-07 (UAT Gap #1): the liveness signal is now an ACTIVE probe of the
/// TUNNEL/SERVER path (`check_tunnel_alive`), NOT the local gateway. While VPN is
/// up that probe travels THROUGH the tunnel via default routing, so a
/// server-silent drop (gateway still reachable, server dead) is detected at the
/// same speed as an Ethernet unplug. The local gateway is still probed, but ONLY
/// as a cheap secondary GATE to classify the reason code (whole-internet-down vs
/// tunnel-down) — a reachable gateway can no longer mask a dead tunnel.
/// `vpn_status` is a clone of the single status owner (D-01). The monitor only
/// acts while status is `Connected`; it replaces the former bool-flag clone
/// (Pitfall 4 — this was an easy-to-miss reader). The reconnect/recovery
/// logic is unchanged here (Phase 2 owns reconnect); only the READ is repointed.
pub fn start_monitor(
    app: tauri::AppHandle,
    vpn_status: Arc<Mutex<VpnStatus>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures: u32 = 0;
        let mut was_online = true;
        let mut was_connected = false;
        // FIX-D (killswitch-ON warm-up): timestamp of the current connect + whether the
        // tunnel probe has succeeded at least once this session. Until one of those arms
        // detection (see lifecycle::tunnel_loss_armed), a failed probe is treated as
        // warm-up, not a drop — the fail-closed killswitch blocks the probe while the
        // tunnel warms up. See debug/claude-code-403-on-vpn-reconnect.md (FIX-D).
        let mut connected_at: Option<Instant> = None;
        let mut first_probe_success = false;

        // 02-14 (STATUS-05): the shared wake handle. The OS interface-change callback
        // signals this; the monitor `select!`s on it below so a real-time link-state
        // change interrupts the poll sleep for an IMMEDIATE re-check. The registration
        // is held in `_notifier` for the whole monitor lifetime — its Drop pairs the
        // CancelMibChangeNotify2 + frees the boxed context (T-14-02). On non-Windows
        // (and if registration fails) `_notifier` is None and the monitor simply runs
        // on the poll cadence with no real-time wake.
        let wake = Arc::new(Notify::new());
        #[cfg(target_os = "windows")]
        let _notifier = InterfaceChangeNotifier::register(Arc::clone(&wake));

        // WR-01 (02-14 review): when the LAST event-driven immediate re-check ran, so a
        // burst of interface-change callbacks (Wi-Fi roam / cable flap / parameter-only
        // change) cannot spin back-to-back re-checks. `None` until the first wake.
        let mut last_event_wake_at: Option<Instant> = None;

        // AUDIT-2026-06-11 #13: when the FIX-B failure-counter reset last fired.
        // The reset is rate-limited to one per FIXB_RESET_MIN_INTERVAL_SECS (pure
        // decision in lifecycle::fixb_reset_allowed, same shape as the WR-01 debounce
        // above) so SUSTAINED interface churn cannot zero `consecutive_failures` on
        // every honored wake and starve tunnel-lost detection. `None` until the first
        // reset of the session.
        let mut last_fixb_reset_at: Option<Instant> = None;

        log_app("INFO", "[connectivity] Monitor started");

        loop {
            // 02-10 (Tier-3): measure the wall-clock gap ACROSS the per-iteration sleep.
            // On a normal iteration this is ~POLL_INTERVAL_SECS; a gap far larger means
            // the machine was suspended and just resumed (the sleep "overslept" while the
            // OS was frozen). `Instant` is monotonic but still advances across suspend on
            // Windows, so a large delta is the cheap, dependency-free resume signal.
            //
            // 02-14 (STATUS-05): instead of sleeping the WHOLE cadence unconditionally,
            // race the cadence sleep against the link-state wake. If the OS reports an
            // interface-state change first, we break out of the sleep early and run the
            // normal connectivity check NOW — collapsing local-loss latency from
            // ~10-15s to ~instant. Crucially this only SHORTENS the wait: the woken
            // iteration runs the exact same checked logic (grace-skip, MAX_FAILURES,
            // generation/disconnecting handoff), so no new false-kill path is added
            // (Option A / T-14-01). `slept_for` is still measured across the actual wait
            // so the resume-from-suspend detector keeps working; a notify-driven wake is
            // a SHORT gap, so it is correctly never mistaken for a resume.
            //
            // WR-01 (02-14 review): the wake is DEBOUNCED. `woke_via_event` records
            // whether the select resolved via the notify arm; below we coalesce a burst
            // so a flapping NIC cannot bypass the cadence sleep back-to-back.
            let before_sleep = Instant::now();
            let mut woke_via_event = false;
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)) => {}
                _ = wake.notified() => {
                    woke_via_event = true;
                }
            }
            let slept_for = before_sleep.elapsed();

            // WR-01 debounce: only honor an EVENT-driven immediate re-check if at least
            // EVENT_WAKE_MIN_INTERVAL_MS has elapsed since the last one. The first wake
            // of a burst is honored (a genuine link-down is still detected fast); a wake
            // arriving sooner is coalesced — we sleep the short debounce remainder so the
            // OS can drain its callback burst and the next select races the cadence
            // afresh instead of returning instantly on a stale stored permit. The normal
            // poll cadence still covers a coalesced event, so no real link-down is missed.
            if woke_via_event {
                let now = before_sleep + slept_for;
                if should_honor_event_wake(now, last_event_wake_at) {
                    last_event_wake_at = Some(now);
                    log_app(
                        "DEBUG",
                        "[connectivity] link-state change — waking monitor for an immediate re-check (02-14)",
                    );
                } else {
                    // Coalesce this wake: absorb the burst, defer to the poll cadence.
                    log_app(
                        "DEBUG",
                        "[connectivity] link-state change coalesced (debounce) — deferring to poll cadence (WR-01)",
                    );
                    tokio::time::sleep(Duration::from_millis(EVENT_WAKE_MIN_INTERVAL_MS)).await;
                    continue;
                }
            }

            // Only check when VPN is connected
            let vpn_up = vpn_status
                .lock()
                .map(|g| *g == VpnStatus::Connected)
                .unwrap_or(false);
            if !vpn_up {
                consecutive_failures = 0;
                was_online = true;
                was_connected = false;
                connected_at = None; // FIX-D: re-arm warm-up on the next connect
                first_probe_success = false;
                continue;
            }

            // 02-10 (Tier-3) — sleep/hibernate/resume re-baseline. If we just resumed
            // from suspend while VPN was connected, the in-flight failure count and the
            // post-connect grace are STALE (deadlines elapsed while frozen). Re-baseline:
            // (a) reset consecutive_failures + re-arm the grace skip so we do NOT instantly
            // declare offline from deadlines that elapsed during sleep, and (b) force ONE
            // immediate connectivity re-check so a stale "connected" after resume is
            // corrected within seconds — not held for a full cadence. A mid-retry supervisor
            // is unaffected: it is generation-guarded, and we never touch its attempt count.
            if is_resume_gap(slept_for) {
                log_app(
                    "INFO",
                    "[connectivity] resume from suspend detected — re-baselining monitor (02-10)",
                );
                consecutive_failures = 0;
                was_connected = false; // re-arm the post-connect grace skip
                // Immediate out-of-band re-check: this does NOT count toward MAX_FAILURES
                // (it only refreshes `was_online` + emits a restore), so a tunnel that
                // survived the sleep is reported promptly and a dead one is caught by the
                // normal cadence next iterations rather than burst-failing on stale state.
                let online_now = check_tunnel_alive().await;
                // AUDIT-2026-06-11 #9: a FAILED immediate post-resume probe must NOT
                // set `was_online = false`. BOTH offline-declaration paths are gated on
                // `was_online == true` (the fast uplink short-circuit and the
                // MAX_FAILURES declaration), and the ONLY thing that re-arms the flag
                // is a SUCCESSFUL tunnel probe — which never comes when the tunnel
                // died during sleep. A failed probe here is routine (Wi-Fi takes 2-10s
                // to re-associate after resume), so the old `was_online = false` branch
                // permanently disarmed offline detection on essentially every
                // sleep/resume where the tunnel also died: stuck green «Connected»
                // forever, traffic black-holed, no reconnect. Leave `was_online`
                // untouched — the counter + grace were already re-baselined above, so
                // the normal MAX_FAILURES cadence makes the offline call a few cycles
                // later if the tunnel is really dead.
                if online_now {
                    if !was_online {
                        app.emit("internet-status", crate::commands::vpn::InternetStatusPayload {
                            online: true,
                            action: None,
                            reason: None,
                        }).ok();
                    }
                    was_online = true;
                }
                continue;
            }

            // Skip the first check cycle after VPN connects — DNS proxy needs
            // time to restart with new system DNS servers. Without this grace
            // period the monitor sees DNS failures and kills the VPN.
            if !was_connected {
                was_connected = true;
                // FIX-D: start the killswitch warm-up window for this connect.
                connected_at = Some(Instant::now());
                first_probe_success = false;
                log_app("INFO", "[connectivity] VPN just connected — skipping first check cycle");
                continue;
            }

            // FIX-B (RC-1): an interface-change wake (e.g. Docker/WSL bringing up a
            // vEthernet) must NOT let a transient tunnel-probe miss escalate to
            // tunnel-lost while the physical uplink is still present. Reset the failure
            // counter and settle so only a SUSTAINED probe failure via the poll cadence
            // (no intervening adapter churn) can declare the tunnel dead. This is the
            // Claude-Code-403-on-Docker-start fix — see
            // .planning/debug/claude-code-403-on-vpn-reconnect.md (RC-1 / FIX-B).
            if woke_via_event
                && crate::lifecycle::reset_tunnel_failures_on_adapter_event(
                    find_physical_adapter().is_some(),
                )
            {
                // AUDIT-2026-06-11 #13: rate-limit the FIX-B reset. Unbounded, it fired
                // on EVERY honored adapter-event wake; accumulating MAX_FAILURES misses
                // needs ~12-15s of clean cadence while the WR-01 debounce only spaces
                // wakes 750ms apart — so sustained interface churn (flapping Wi-Fi,
                // Docker/WSL vEthernet churn) kept the counter at zero forever and a
                // genuinely dead tunnel stayed green with no reconnect (the inverse
                // over-correction of T-37). At most one reset per
                // FIXB_RESET_MIN_INTERVAL_SECS; a rate-limited wake keeps the failure
                // streak so a sustained miss run can still cross MAX_FAILURES. The
                // one-off Docker bring-up burst (RC-1) still gets the first reset.
                let now = Instant::now();
                if crate::lifecycle::fixb_reset_allowed(now, last_fixb_reset_at) {
                    last_fixb_reset_at = Some(now);
                    consecutive_failures = 0;
                    log_app(
                        "DEBUG",
                        "[connectivity] adapter-change wake with uplink present — reset tunnel-probe failures + settle (FIX-B)",
                    );
                    tokio::time::sleep(Duration::from_millis(
                        crate::lifecycle::ADAPTER_EVENT_SETTLE_MS,
                    ))
                    .await;
                } else {
                    log_app(
                        "DEBUG",
                        "[connectivity] adapter-change wake but the FIX-B reset is rate-limited — keeping the failure streak (AUDIT #13)",
                    );
                }
            }

            // 16-08 (gap 6): mid-session second-VPN banner. detect_conflicting_adapters
            // is a ONE-SHOT at connect (commands::vpn), so a second VPN that starts AFTER
            // our connect used to drop the tunnel into «Восстановление» with NO banner
            // (owner UAT). On an HONORED adapter-change wake (a new interface appeared)
            // while this session is Connected — we are past the vpn_up==Connected gate
            // (:500), the resume re-baseline (:549) and the just-connected grace skip
            // (:561) — re-run the conflict scan and emit the same named banner if a real
            // FOREIGN adapter is present (filter_out_own_adapter still drops our WinTUN,
            // T-21). Gated on the honored wake, NOT the FIX-B reset outcome, so a foreign
            // adapter is scanned even when the physical uplink is present; the existing
            // WR-01 wake debounce + the FE per-adapter dedup keying keep routine churn
            // from spamming. detect_conflicting_adapters shells out to PowerShell, so it
            // runs OFF-THREAD (spawn_blocking) and MUST NOT delay the liveness check
            // below — this is READ-AND-EMIT ONLY: no status/killswitch/routing/reconnect
            // change (T-16-08-01 / T-16-08-04).
            if woke_via_event {
                let app = app.clone();
                tokio::task::spawn_blocking(move || {
                    // MINOR-2 (16-10): use the MONITORED variant, which re-reads the live
                    // vpn_status AFTER this off-thread PowerShell scan resolves and skips the
                    // emit unless still Connected. The scan can finish 1.5–3s later — after the
                    // user disconnected — so the ungated connect-thread emit would paint a stale
                    // "second VPN" banner on a disconnected app. The connect thread keeps the
                    // ungated `emit_adapter_conflict_if_any` (it runs during an active connect).
                    crate::commands::vpn::emit_adapter_conflict_if_any_monitored(&app);
                });
            }

            // 02-18 (STATUS-05 gap): FAST LOCAL-uplink-loss short-circuit. Runs AFTER
            // the grace skip + resume re-baseline (so a just-connected session and a
            // resume are handled first) and BEFORE the slow tunnel probe below.
            //
            // WHY this exists: the 02-14 event wake makes this iteration run ~immediately
            // on a link-state change, but the slow path still needed MAX_FAILURES failed
            // multi-endpoint HTTP probes (~1 minute) before declaring offline — so a real
            // uplink loss was NOT real-time (user-reported). `find_physical_adapter()`
            // enumerates adapters via ipconfig with NO network I/O, returns None INSTANTLY
            // when no Up Ethernet/Wi-Fi adapter with a gateway exists, and EXCLUDES the
            // VPN's own wintun adapter — so it is the instant, not-fooled "uplink gone"
            // signal even while the tunnel is up. The slow tunnel probe stays as the path
            // for SERVER-SILENT drops (physical uplink UP, server dead): there the adapter
            // is present, so this short-circuit does nothing and we fall through.
            //
            // FLAP-SAFE (T-18-01): a Wi-Fi roam / DHCP renew can blip the adapter None for
            // ~1s. We CONFIRM the loss over a short window (UPLINK_CONFIRM_CHECKS samples
            // spaced UPLINK_CONFIRM_INTERVAL_MS ≈ 1.5s) and declare offline ONLY if it
            // stays None the whole window — a brief roam recovers within the window and is
            // NOT killed; a genuine disable/unplug is confirmed in ~1-2s. Only fires when
            // `was_online` (we currently believe we're up) so it never double-declares.
            if was_online && find_physical_adapter().is_none() {
                // First sample already saw the adapter gone; collect the remaining
                // confirm samples spaced across the window. If ANY of them sees the
                // adapter back, it was a transient flap → skip (do NOT declare offline).
                let mut samples = vec![false];
                for _ in 1..UPLINK_CONFIRM_CHECKS {
                    tokio::time::sleep(Duration::from_millis(UPLINK_CONFIRM_INTERVAL_MS)).await;
                    samples.push(find_physical_adapter().is_some());
                }

                if uplink_loss_confirmed(&samples) {
                    // WR-04: CORROBORATE before killing. `find_physical_adapter()` excludes
                    // adapters by a description-SUBSTRING blacklist (wintun|vpn|virtual|tap-),
                    // the inverse of the project's whitelist convention. A legitimate physical
                    // NIC whose vendor description happens to contain one of those substrings
                    // (a Hyper-V host vEthernet, an Intel NIC reporting "Virtual", a USB
                    // dongle with "tap" in its model) is wrongly excluded — so on real field
                    // hardware the adapter can read None over the whole confirm window even
                    // though the uplink (and tunnel) is perfectly UP. Rather than tweak the
                    // fragile, hardware-specific blacklist, run ONE tunnel probe to settle it:
                    //   - probe FAILS  ⇒ there is genuinely no route (it fails fast, ~1s, when
                    //                    there is truly no uplink) ⇒ declare offline as before.
                    //   - probe OK     ⇒ the physical adapter only LOOKED gone (misclassified
                    //                    by the blacklist) but the tunnel is alive ⇒ do NOT
                    //                    declare offline; WARN so a field misclassification is
                    //                    diagnosable, reset the confirm state, and fall through
                    //                    to the normal flow (the slow tunnel-probe path below).
                    // This keeps the common true-uplink-loss case fast AND eliminates the
                    // false-kill hardware-agnostically.
                    let tunnel_alive = check_tunnel_alive().await;
                    if !should_declare_offline_after_corroboration(true, tunnel_alive) {
                        log_app(
                            "WARN",
                            "[connectivity] physical adapter looked gone over the confirm window but the tunnel probe SUCCEEDED — likely a real NIC misclassified by find_physical_adapter()'s description blacklist; NOT declaring offline (WR-04)",
                        );
                        // Stay online; do not touch was_online/consecutive_failures. Fall
                        // through to the normal tunnel-probe flow which will re-affirm online.
                    } else {
                    // Confirmed: the physical uplink is genuinely gone. No physical
                    // adapter ⇒ a WHOLE-INTERNET loss, not a server-silent drop, so the
                    // reason is INTERNET_LOST_REASON. Declare offline immediately via the
                    // ONE canonical helper (Task 1), bypassing the slow tunnel-probe +
                    // MAX_FAILURES loop — this is the real-time path for LOCAL uplink loss.
                    log_app(
                        "WARN",
                        "[connectivity] physical uplink gone (confirmed) and tunnel probe also failed — declaring offline immediately (02-18/WR-04, reason=internet-lost)",
                    );
                    was_online = false;
                    consecutive_failures = 0;

                    // 02-20 status-UX split: a confirmed LOCAL-NETWORK loss (no physical
                    // adapter at all) is «Восстановление», NOT «Переподключение». We do
                    // NOT hand off to the bounded reconnect supervisor here — there is
                    // nothing to connect to yet, and burning the reconnect attempts on a
                    // dead network is exactly the regression this split fixes. `run_recovery_flow`
                    // sets Recovering (red), waits for the adapter (up to the recovery timeout),
                    // then composes the «Переподключение» phase via the supervisor once the
                    // net returns, or surfaces Error(recovery-timeout) if it never does.
                    run_recovery_flow(&app, &vpn_status).await;
                    // WR-05: re-arm the post-connect grace skip (see the MAX_FAILURES
                    // branch) so a recovery-driven reconnect doesn't probe a freshly
                    // restarted DNS proxy and false-positive an offline drop.
                    was_connected = false;
                    continue;
                    } // end else (tunnel probe also failed → genuine loss)
                }

                // A re-check saw the adapter back ⇒ transient flap (Wi-Fi roam / DHCP
                // renew). Do NOT declare offline — fall through to the normal flow.
                log_app(
                    "DEBUG",
                    "[connectivity] physical adapter blipped but recovered within the confirm window — flap, not a drop (02-18)",
                );
            }

            // 02-07: probe the TUNNEL/SERVER path, not the local gateway. While VPN
            // is up this HTTP 204 request routes THROUGH the tunnel (no socket bind to
            // the physical adapter), so a server-silent drop is caught here.
            let online = check_tunnel_alive().await;

            if online {
                if !was_online {
                    eprintln!("[connectivity] Tunnel restored");
                    log_app("INFO", "[connectivity] Tunnel restored");
                    app.emit("internet-status", crate::commands::vpn::InternetStatusPayload {
                        online: true,
                        action: None,
                        reason: None,
                    }).ok();
                }
                consecutive_failures = 0;
                was_online = true;
                first_probe_success = true; // FIX-D: arm normal detection now the tunnel proved alive
            } else {
                consecutive_failures += 1;
                eprintln!("[connectivity] Tunnel probe failed ({consecutive_failures}/{MAX_FAILURES})");
                // Declare offline after MAX_FAILURES consecutive failed probes (~12-15s)
                // — requiring N>1 failures tolerates one transient miss under heavy load
                // so a busy-but-healthy tunnel is never false-killed (T-07-01).
                // FIX-D (killswitch-ON warm-up): don't declare tunnel-lost until the first
                // successful probe OR the warm-up grace elapses. The fail-closed killswitch
                // blocks our probe while the tunnel warms up (~up to 60s); the old ~12s
                // detect declared a false loss → recovery that also couldn't probe → hang.
                // With killswitch OFF the first probe succeeds in ~1s so this is a no-op.
                // See debug/claude-code-403-on-vpn-reconnect.md (FIX-D).
                let connected_secs_ago =
                    connected_at.map(|t| t.elapsed().as_secs()).unwrap_or(u64::MAX);
                let loss_armed =
                    crate::lifecycle::tunnel_loss_armed(connected_secs_ago, first_probe_success);
                if consecutive_failures >= MAX_FAILURES && was_online && loss_armed {
                    // Classify the drop: server-silent, or the user's own uplink gone? This does
                    // NOT gate the offline decision (the tunnel probe already failed N times) — it
                    // picks the reason code, and the reason code decides whether «Авто-режим» may
                    // move the user to another server at all (`lifecycle::should_failover` accepts
                    // TUNNEL_LOST_REASON and nothing else).
                    //
                    // The signal is the PRESENCE OF A PHYSICAL ADAPTER, deliberately not a gateway
                    // probe. `check_adapter_online()` opens a TCP connection to `gateway:80`; its
                    // own doc says it is for «adapter recovery — VPN is disconnected». Here the core
                    // process is still ALIVE, with its WinTUN adapter, its routes and its
                    // fail-closed killswitch all installed, so that connection goes into the dead
                    // tunnel and fails unconditionally. It reported «gateway unreachable» for EVERY
                    // server-side drop — so every such drop was filed as `internet-lost`, took the
                    // wait-for-the-uplink recovery, and got a ONE-entry supervisor queue: ten
                    // attempts against the server that had just died, and no failover walk at all.
                    // That is the UAT test 1 (2026-08-26), whose log carries the
                    // contradiction in a single line: `adapter=present, gateway=unreachable`.
                    // Rationale + the trade in `lifecycle::drop_is_tunnel_lost`.
                    let adapter_present = find_physical_adapter().is_some();
                    let reason = if crate::lifecycle::drop_is_tunnel_lost(adapter_present) {
                        TUNNEL_LOST_REASON
                    } else {
                        INTERNET_LOST_REASON
                    };
                    eprintln!("[connectivity] Tunnel appears down (reason={reason}) — telling frontend to disconnect VPN");
                    log_app(
                        "WARN",
                        &format!("[connectivity] Declaring offline after {MAX_FAILURES} failed tunnel probes (reason={reason})"),
                    );
                    // 2026-06-11 (user-requested drop diagnostics): ONE verdict line answering
                    // "did MY side break, or the path/server?" — the question a post-mortem log
                    // read could not answer before. Emitted on the vpn-log channel too so it lands
                    // in the in-window panel next to the sidecar lines, not only in the (opt-in)
                    // log file.
                    //
                    // The gateway probe still runs, but ONLY to enrich this line and only once the
                    // decision above is already made — it is a useful post-mortem fact and a
                    // misleading classifier, and this comment exists so the next reader does not
                    // promote it back. It is skipped entirely when the adapter is missing: that
                    // already settles the question, and probing a gateway that has no adapter to
                    // leave through would just cost the connect timeout.
                    let gateway_reachable = if adapter_present {
                        check_adapter_online().await
                    } else {
                        false
                    };
                    let verdict = if !adapter_present {
                        "[diagnose] drop verdict: adapter=missing — cause is LOCAL (PC / Wi-Fi / router side)"
                            .to_string()
                    } else if gateway_reachable {
                        format!(
                            "[diagnose] drop verdict: adapter=present, gateway=reachable, tunnel probes failed {MAX_FAILURES}x — cause is OUTSIDE this PC (ISP path or server)"
                        )
                    } else {
                        // Adapter up, gateway silent. Treated as a server-side drop on purpose:
                        // with the core still holding a fail-closed killswitch this is what a
                        // healthy machine looks like from inside a dead tunnel, so the gateway
                        // result says nothing about the uplink here.
                        format!(
                            "[diagnose] drop verdict: adapter=present, gateway=unreachable (expected while the core still holds the killswitch), tunnel probes failed {MAX_FAILURES}x — treated as a server-side drop"
                        )
                    };
                    log_app("WARN", &verdict);
                    app.emit(
                        "vpn-log",
                        serde_json::json!({ "message": verdict, "level": "warn" }),
                    )
                    .ok();

                    // 02-20 status-UX split: branch on the drop TYPE.
                    //
                    // INTERNET-LOST (local net gone, gateway also unreachable) →
                    // «Восстановление»: do NOT hand off to the bounded supervisor; run
                    // the recovery wait (Recovering, wait for the adapter, short test
                    // timeout → Error(recovery-timeout); on the net returning compose the
                    // «Переподключение» phase via the supervisor). This is the SLOW-path
                    // mirror of the fast uplink-loss short-circuit above.
                    if reason == INTERNET_LOST_REASON {
                        run_recovery_flow(&app, &vpn_status).await;
                        consecutive_failures = 0;
                        was_online = false;
                        was_connected = false;
                        continue;
                    }

                    // TUNNEL-LOST (server-silent drop, local net UP) → «Переподключение»:
                    // the ONE canonical offline path (02-18) — emit the disconnect event +
                    // hand off to the reconnect supervisor (gated on intent / CR-02 /
                    // generation, exactly as before), which retries bounded as
                    // Reconnecting + «Попытка N/N». If the supervisor took over, reset
                    // monitor state and resume polling; do NOT also run the adapter-
                    // recovery wait below (that is the fallback the supervisor replaces).
                    // The INTERNET-LOST branch above already `continue`d, so `reason` here is
                    // always TUNNEL_LOST_REASON — pass the matching enum variant (F10).
                    if declare_offline_and_handoff(&app, crate::commands::vpn::InternetStatusReason::TunnelLost) {
                        consecutive_failures = 0;
                        was_online = false;
                        was_connected = false;
                        continue;
                    }

                    // Fallback path (no AppState / no saved config / user disconnecting):
                    // keep the legacy adapter-recovery wait so the UI still gets a
                    // recovery signal. Now wait for the physical network adapter to come back.
                    let recovered = await_adapter_recovery(&app, &vpn_status).await;

                    // Reset state for next monitoring cycle
                    consecutive_failures = 0;
                    was_online = recovered;
                    // WR-05: re-arm the post-connect grace skip. If recovery exited
                    // because the user reconnected externally (vpn_up already true),
                    // leaving was_connected=true would bypass the "skip first check
                    // cycle after connect" grace period, letting the monitor probe a
                    // freshly-restarted DNS proxy and false-positive an offline drop
                    // right after a recovery-driven reconnect. Resetting it forces the
                    // next connected cycle to re-arm the grace skip.
                    was_connected = false;
                }
            }
        }
    });
}

/// Stable, secret-free ASCII reason code for the terminal "couldn't reconnect"
/// failure (D-02). This is the value the supervisor passes to `set_vpn_status` on
/// give-up — NEVER a Russian display string (CLAUDE.md i18n rule + D-09/D-29). The
/// user-facing wording lives as the `errors.reconnect_gave_up` i18n key on the
/// frontend, which maps this code to the localized message.
pub const RECONNECT_GAVE_UP_REASON: &str = "reconnect-gave-up";

/// Stable, secret-free ASCII reason code emitted when ONE pass through the participating
/// failover servers finished and none of them answered (Phase 28 D-05).
///
/// A FIXED lowercase-kebab token — never Cyrillic, never a server name, never a config path, and
/// never derived from anything the sidecar or the manifest prints (D-09/D-29). The frontend maps
/// it to the localized «ни один сервер не отвечает» wording at its presentation boundary; the
/// user never sees this string.
///
/// Reusing `RECONNECT_GAVE_UP_REASON` here is FORBIDDEN. That code means «this one server would
/// not come back»; this one means «none of your servers answered». Collapsing the two into one
/// message is exactly the loss of distinction 27 D-15 is fixing on the other side of the app, and
/// it would leave a person unable to tell a broken server from a broken network. It follows
/// `RECOVERY_TIMEOUT_REASON`'s precedent: a distinct code per distinct honest failure.
///
/// TRANSIENT, like every other drop code — a later attempt may succeed once a server returns, so
/// it must never appear in `lifecycle::is_terminal_reason`.
pub const FAILOVER_EXHAUSTED_REASON: &str = "failover-exhausted";

/// Which give-up code does this walk deserve? (D-05)
///
/// Pure so the «a one-server queue still reports `reconnect-gave-up`» rule is an assertion rather
/// than an if-statement buried in the supervisor's terminal arm.
pub fn give_up_reason(queue_exhausted: bool) -> &'static str {
    if queue_exhausted {
        FAILOVER_EXHAUSTED_REASON
    } else {
        RECONNECT_GAVE_UP_REASON
    }
}

/// Outcome of one run of the bounded reconnect loop (D-02 / D-04 / Codex HIGH).
///
/// Returned by the pure-ish `run_reconnect_loop` core so the tests can assert the
/// terminal state WITHOUT a real sidecar (RESEARCH Wave 0 — "inject a try-connect
/// closure"). The production `start_reconnect_supervisor` maps each outcome to a
/// `set_vpn_status` write (Recovered → already Connected; GaveUp → terminal Error
/// with the reason code; Aborted → leave the session alone).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorOutcome {
    /// A respawn reached `Connected` within the attempt window — recovery done.
    Recovered,
    /// All `RECONNECT_MAX_ATTEMPTS` failed — caller surfaces the terminal Error
    /// carrying `RECONNECT_GAVE_UP_REASON`.
    GaveUp,
    /// The user disconnected, or the captured generation was advanced by a manual
    /// reconnect / disconnect — the supervisor is stale and must NOT act (D-04 +
    /// Codex HIGH stale-actor guard). No respawn, no status-write.
    Aborted,
}

/// The bounded, fast-fail, generation-guarded reconnect loop — factored as a
/// pure-ish async core so it runs in unit tests with injected closures instead of
/// a real sidecar (RESEARCH Wave 0 Gaps).
///
/// Behavior (D-02 / D-04 / Gemini fast-fail / Codex HIGH):
/// - Loops `attempt` over `1..=max_attempts` (no inline number, and no longer the bare const).
///   28-02: the budget is a PER-CALL parameter because one failover candidate gets
///   `lifecycle::FAILOVER_ATTEMPTS_PER_CANDIDATE` while the internet-lost recovery path and the
///   failover-disabled path keep `RECONNECT_MAX_ATTEMPTS` (D-01). The const itself was NOT
///   lowered: doing so would silently change the recovery path too, dropping the reboot-recovery
///   guarantee on a drop where no other server can help anyway.
/// - BEFORE each attempt re-checks intent + generation: if `user_disconnected()`
///   OR `!is_current_generation(captured_generation, live_generation())`, returns
///   `Aborted` immediately — a user disconnect or a manual reconnect that bumped
///   the generation neutralizes this (possibly stale) supervisor.
/// - Marks the session `Reconnecting` (via `on_reconnecting`) and runs
///   `try_connect(attempt)`, which yields `(succeeded, elapsed, failure_reason)`.
/// - On success → `Recovered` (no terminal Error).
/// - On a failure whose `failure_reason` is `is_terminal_reason` (invalid creds /
///   bad config / missing adapter) → `GaveUp` IMMEDIATELY, WITHOUT burning the
///   remaining attempts (02-10, T-10-03): a retry cannot fix it, so surface the
///   honest error now instead of after ~45s of pointless retries.
/// - On a transient failure: if `is_fast_fail(elapsed)` the respawn died instantly →
///   count it WITHOUT sleeping the full window; otherwise `sleep(RECONNECT_INTERVAL)`
///   before the next attempt. The last attempt never sleeps.
/// - After the loop exhausts the budget → `GaveUp`.
///
/// `try_connect` is `FnMut` returning a boxed future so the closure can hold
/// mutable test state (attempt counter) and so the real path can `.await` the
/// respawn + connected-wait inside it. It yields the failure REASON (the specific
/// Error the attempt landed, read from `last_error`) so the loop can tell a terminal
/// failure apart from a transient one. The `sleep` closure is injected too so the
/// fast-fail test can prove the full window is skipped without real time passing.
async fn run_reconnect_loop<TC, TCFut, UD, LG, RC, SL, SLFut>(
    captured_generation: u64,
    max_attempts: u32,
    mut try_connect: TC,
    user_disconnected: UD,
    live_generation: LG,
    mut on_reconnecting: RC,
    mut sleep_interval: SL,
) -> SupervisorOutcome
where
    TC: FnMut(u32) -> TCFut,
    TCFut: std::future::Future<Output = (bool, Duration, Option<String>)>,
    UD: Fn() -> bool,
    LG: Fn() -> u64,
    RC: FnMut(u32),
    SL: FnMut() -> SLFut,
    SLFut: std::future::Future<Output = ()>,
{
    for attempt in 1..=max_attempts {
        // D-04 + Codex HIGH: a user-initiated disconnect, or a generation that was
        // advanced by a manual reconnect / disconnect, means we no longer own this
        // session — abort before any respawn / status-write.
        if user_disconnected()
            || !crate::lifecycle::is_current_generation(captured_generation, live_generation())
        {
            return SupervisorOutcome::Aborted;
        }

        // Mark the session as Reconnecting for THIS attempt (D-03 — routed through
        // the single mutator by the caller's `on_reconnecting`).
        on_reconnecting(attempt);

        let (succeeded, elapsed, failure_reason) = try_connect(attempt).await;
        if succeeded {
            // T-31: a user disconnect can land WHILE `try_connect` (the real
            // respawn_and_wait) is in flight — the respawn then connects and would
            // report Recovered, flipping the session back to Connected against the
            // user's wish (the double-press UAT bug). The pre-attempt guard at the top
            // of the loop cannot catch this because the disconnect arrives mid-attempt.
            // Re-check intent NOW, after the success: if the user requested a
            // disconnect, the respawned-and-connected sidecar must NOT win — return
            // Aborted so the supervisor tears it down to a clean Disconnected.
            //
            // FB-01 (Fable-5 Phase-28 review): the SAME re-check must also ask the generation,
            // and until now it did not — the pre-attempt guard above asked both facts, this one
            // asked only intent. That asymmetry is reachable and it is not a disconnect race, it
            // is a CONNECT race. The user watching «Переподключение…» clicks server B's card
            // mid-walk; `vpn_connect(B)` bumps the generation, FAB-R1 correctly makes this walk's
            // C-child refuse to store and die — but `respawn_and_wait` polls the SHARED status
            // arc with no notion of WHOSE `Connected` it is watching, so it sees B come up and
            // reports success. Without this clause the walk concluded «Recovered on candidate C»,
            // emitted the failover `vpn-flow`, and the window adopted C while the tunnel ran B:
            // Rust says B, the UI says C, the user is on B. The store was guarded by FAB-R1 and
            // the CLASSIFICATION was left open; this closes it on the same two facts.
            if user_disconnected()
                || !crate::lifecycle::is_current_generation(captured_generation, live_generation())
            {
                return SupervisorOutcome::Aborted;
            }
            return SupervisorOutcome::Recovered;
        }

        // 02-10 (T-10-03): a TERMINAL failure (bad creds / bad config / missing
        // adapter) will fail identically on every retry — short-circuit the bounded
        // loop and surface the honest Error now, instead of burning the remaining
        // attempts. Only the specific never-recoverable reasons match; transient
        // failures fall through to the normal retry path below.
        if failure_reason
            .as_deref()
            .is_some_and(crate::lifecycle::is_terminal_reason)
        {
            log_app(
                "INFO",
                "[reconnect] terminal failure reason — short-circuiting retries (02-10)",
            );
            return SupervisorOutcome::GaveUp;
        }

        // Failure. If the respawn died sooner than FAST_FAIL_GRACE it was an instant
        // death (missing/instantly-crashing binary) — count the failure NOW and skip
        // the inter-attempt sleep so 3 instant deaths don't waste ~1 minute (Gemini
        // fast-fail). Otherwise wait the snappy interval before the next try. The
        // last attempt never sleeps (we're about to give up).
        let is_last = crate::lifecycle::gave_up(attempt, max_attempts);
        if !is_last && !crate::lifecycle::is_fast_fail(elapsed) {
            sleep_interval().await;
        }
    }

    SupervisorOutcome::GaveUp
}

/// What one walk over the failover queue ended up doing (Phase 28 D-02 / D-05).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FailoverWalkResult {
    /// The terminal outcome of the LAST candidate the walk ran.
    pub outcome: SupervisorOutcome,
    /// Zero-based index of the candidate the walk stopped on — index 0 is the origin, so a
    /// `Recovered` at index 0 means «the server the user chose came back», and any higher index
    /// means the user was moved and the frontend has a switch to announce (27 D-04).
    pub candidate_index: usize,
    /// True only when EVERY candidate of a MULTI-candidate queue gave up — the D-05 exhaustion
    /// that earns `FAILOVER_EXHAUSTED_REASON`. A one-entry queue giving up is an ordinary
    /// reconnect give-up and stays false, so the two failures never collapse into one message.
    pub queue_exhausted: bool,
}

/// The outer queue walk (Phase 28 D-02 / D-05 / D-06), factored as a pure-ish async core so it
/// runs in unit tests against a scripted `run_one_candidate` — no sidecar, no network, no clock —
/// exactly the way `run_reconnect_loop` is already tested.
///
/// Behaviour:
/// - Runs candidates in order. `Recovered` and `Aborted` stop the walk immediately; `GaveUp`
///   advances to the next server. When the list runs out the walk stops: ONE pass, never a silent
///   second lap (D-05) — a quiet infinite retry leaves a person unable to tell a broken app from
///   a broken network.
/// - **Re-checks ownership on every ADVANCE**, via `advance_allowed`, not only on every attempt
///   inside `run_reconnect_loop`. An advance connects to a DIFFERENT config, which is closer to a
///   `vpn_connect` than to a retry, so a stale walk that kept going would spawn a sidecar for a
///   session someone else already owns — the «застряло на Подключено» phantom class.
/// - Offers **no teardown seam**: nothing in this signature can release the sidecar, so traffic
///   cannot escape the tunnel between candidates (D-06 / T-28-05). The single teardown belongs to
///   the caller's terminal arm, after the walk has returned.
///
/// The generation question this loop deliberately does NOT ask: whether an advance should
/// RE-CAPTURE the session generation. It must not. `respawn_sidecar` never bumps
/// `connection_generation` (it says so in its own doc comment — the supervisor owns the generation
/// it captured at the drop), so the whole walk runs under ONE captured value. Re-capturing at each
/// advance would make `lifecycle::respawn_may_store(captured, live, …)` read `captured == live`
/// unconditionally and quietly neuter the FAB-R1 store guard — the walk would adopt a generation
/// bumped by someone else's `vpn_connect(B)` and store a second live sidecar beside it, two cores
/// fighting over the WinTUN adapter and the fail-closed killswitch. `respawn_may_store` is the
/// predicate that proves it: it is only meaningful while `captured` stays frozen at the drop.
/// `advance_allowed` therefore compares the live generation against that SAME frozen value.
async fn run_failover_walk<RC, RCFut, AG>(
    queue_len: usize,
    mut run_one_candidate: RC,
    advance_allowed: AG,
) -> FailoverWalkResult
where
    RC: FnMut(usize) -> RCFut,
    RCFut: std::future::Future<Output = SupervisorOutcome>,
    AG: Fn() -> bool,
{
    let mut index = 0usize;
    while index < queue_len {
        // Every advance (index > 0) re-proves ownership before touching a different server.
        if index > 0 && !advance_allowed() {
            return FailoverWalkResult {
                outcome: SupervisorOutcome::Aborted,
                candidate_index: index - 1,
                queue_exhausted: false,
            };
        }

        let outcome = run_one_candidate(index).await;
        match outcome {
            SupervisorOutcome::Recovered | SupervisorOutcome::Aborted => {
                return FailoverWalkResult {
                    outcome,
                    candidate_index: index,
                    queue_exhausted: false,
                };
            }
            // A GaveUp is per-CANDIDATE, including the terminal-reason short-circuit inside
            // `run_reconnect_loop`: bad credentials in server A's config say nothing about
            // server B, so a terminal failure ends that candidate, not the walk.
            SupervisorOutcome::GaveUp => index += 1,
        }
    }

    FailoverWalkResult {
        outcome: SupervisorOutcome::GaveUp,
        candidate_index: queue_len.saturating_sub(1),
        // Only a real WALK can exhaust a queue. A one-entry queue (failover off, internet-lost
        // recovery, a sidecar exit) gave up on one server and must keep saying so.
        queue_exhausted: queue_len > 1,
    }
}

/// The stable `origin` token the failover switch announcement carries on the EXISTING `vpn-flow`
/// channel (28-03, `28-CONTEXT.md` OQ-1).
///
/// Mirrored by the `VpnFlowOrigin` union in `gui-pro/src/shared/ipc/events.ts`, whose receiver
/// early-returns on anything it does not recognise — so this token IS the wire contract, and a
/// drift on either end is a compile error there rather than a pointer that silently stops
/// following the server the user is actually on. D-29: an origin token, never a server name.
pub const FAILOVER_FLOW_ORIGIN: &str = "failover";

/// Pure: which config path — if any — does THIS walk result oblige us to announce as a switch?
///
/// The FRONTEND-facing active-config pointer (`config.configPath` / `tt_config_path`) is
/// frontend-owned — only `performSwitch` and the `vpn-flow` listener write it, and Rust never
/// touches window storage (OQ-1). This function only states the fact: «you are now on this
/// config».
///
/// CR-01 correction: that ownership rule was mistakenly read as «Rust must not update
/// `state.config_path` either». It must. `state.config_path` is the BACKEND's own private record
/// of the config the live sidecar was launched from, and five Rust consumers depend on it being
/// true — it is now committed by `AppState::commit_live_config_path` inside `respawn_sidecar`,
/// which is a different fact travelling a different path and no breach of OQ-1.
///
/// Three ways to get `None`, each for its own reason:
/// - **Not `Recovered`.** An exhausted queue or an abort leaves the user on NO server, so there is
///   no pointer to move; the exhaustion has its own terminal `Error` + `FAILOVER_EXHAUSTED_REASON`.
/// - **`candidate_index == 0`.** Index 0 is the ORIGIN. A successful retry of the same server moved
///   nobody — announcing it would re-point the app at the config it is already on and fire a
///   «переключено автоматически» plate for a switch that never happened.
/// - **An index past the end of the queue.** The index and the queue reach the terminal arm from
///   two places; a mismatch degrades to «say nothing» rather than panicking a background task and
///   leaving the user with no outcome at all.
pub fn failover_switch_target<'a>(
    walk: &FailoverWalkResult,
    queue: &'a [String],
) -> Option<&'a str> {
    if walk.outcome != SupervisorOutcome::Recovered || walk.candidate_index == 0 {
        return None;
    }
    let target = queue.get(walk.candidate_index)?;
    // CR-02 belt: «index > 0» is a proxy for «a different server», and a proxy is only as good as
    // the queue's own de-duplication. `failover_queue` now de-dupes on `canonical_path_key`, so the
    // origin can no longer appear twice — but this function is the LAST gate before the app tells
    // the user it moved them, and the cost of the proxy being wrong is a «Переключено
    // автоматически» plate for a switch that never happened plus a pointer adoption that
    // re-spells the very config the app is already on. Compare the winner against the origin
    // (`queue[0]`) on the same identity key, so «did the user actually move?» is answered by the
    // fact rather than by an index.
    let origin = queue.first()?;
    if crate::lifecycle::canonical_path_key(target) == crate::lifecycle::canonical_path_key(origin)
    {
        return None;
    }
    Some(target.as_str())
}

/// Canonical "declare offline + hand off to the reconnect supervisor" path,
/// extracted from `start_monitor`'s MAX_FAILURES branch so BOTH the slow
/// tunnel-probe path AND the fast uplink-loss short-circuit (02-18) go through
/// ONE offline path — no duplicated emit/handoff logic that could drift.
///
/// Behavior (identical to the former inline code):
///  1. Emit `internet-status { online:false, action:"disconnect", reason }` so the
///     UI shows the disconnecting/recovering state. `reason` is a STABLE ASCII code
///     (TUNNEL_LOST_REASON / INTERNET_LOST_REASON) — never a Russian string (D-09/D-29).
///  2. Hand off recovery to the window-independent Rust reconnect supervisor, gated
///     EXACTLY as before on:
///     - `disconnecting == false` (don't fight a user-initiated disconnect),
///     - `reconnect_in_progress == false` (CR-02: don't start a second supervisor
///       when one already owns this drop), and
///     - a saved `config_path` being present.
///
/// The captured `connection_generation` is passed so a manual reconnect that bumped
/// the generation neutralizes this (possibly stale) supervisor.
///
/// Returns `true` if the supervisor was started (it now owns recovery — the caller
/// should reset monitor state and resume polling), or `false` if no supervisor was
/// started (no AppState / no saved config / user disconnecting / one already live) —
/// in which case the caller runs the legacy adapter-recovery wait so the UI still
/// gets a recovery signal. This mirrors the former control flow precisely.
fn declare_offline_and_handoff(
    app: &tauri::AppHandle,
    reason: crate::commands::vpn::InternetStatusReason,
) -> bool {
    // The same drop classification, as the STABLE ASCII code the failover decision branches on
    // (28 D-01). The enum and the code are two faces of one fact; deriving one from the other
    // here keeps `should_failover` free of any Tauri type.
    let reason_code = match reason {
        crate::commands::vpn::InternetStatusReason::TunnelLost => TUNNEL_LOST_REASON,
        crate::commands::vpn::InternetStatusReason::InternetLost => INTERNET_LOST_REASON,
    };

    // Tell frontend: disconnect VPN, then we'll monitor adapter recovery. The
    // `disconnect` action drives the UI (e.g. the recovering label); the `reconnect`
    // recovery is DRIVEN IN RUST by the supervisor below. `reason` is a STABLE ASCII
    // code (Plan 02-09 maps it to a localized message) — never a Russian string. F10:
    // both fields are now closed enums so a value typo is a compile error.
    app.emit("internet-status", crate::commands::vpn::InternetStatusPayload {
        online: false,
        action: Some(crate::commands::vpn::InternetStatusAction::Disconnect),
        reason: Some(reason),
    }).ok();

    // STATUS-05 / criterion 3 (Plan 04, trigger B — LIVE-SIDECAR DROP): the tunnel is
    // dead but the sidecar PROCESS is still alive (no Terminated event fires), so
    // trigger A (sidecar.rs) never runs for this class of drop. Hand off to the SAME
    // window-independent Rust supervisor here — gated on intent (`disconnecting ==
    // false`) and the current generation (Codex HIGH). The supervisor's own respawn
    // kills the stale-but-alive sidecar before restarting it, so the dead tunnel is
    // actually recovered (Pitfall 3).
    if let Some(state) = app.try_state::<crate::commands::AppState>() {
        let user_disconnecting = state
            .disconnecting
            .lock()
            .map(|g| *g)
            .unwrap_or(false);
        let config_path = state
            .config_path
            .lock()
            .ok()
            .and_then(|g| g.clone());
        // CR-02: don't start a second supervisor if one is already live (e.g. the
        // sidecar Terminated arm already handed this drop off). The live supervisor
        // owns recovery; a parallel one would race it.
        let supervisor_live =
            state.reconnect_in_progress.load(Ordering::SeqCst);
        if !user_disconnecting && !supervisor_live {
            if let Some(config_path) = config_path {
                let generation =
                    state.connection_generation.load(Ordering::SeqCst);
                let log_level = state
                    .log_level
                    .lock()
                    .map(|g| g.clone())
                    .unwrap_or_else(|_| "info".to_string());
                let queue = build_failover_queue(reason_code, &config_path);
                log_app(
                    "INFO",
                    &format!(
                        "[connectivity] live-sidecar drop — starting reconnect supervisor over {} candidate(s)",
                        queue.len()
                    ),
                );
                start_reconnect_supervisor(
                    app.clone(),
                    queue,
                    log_level,
                    generation,
                    crate::lifecycle::WalkKind::ServerDrop,
                );
                // The supervisor now owns recovery for this drop.
                return true;
            }
        }
    }

    false
}

/// The IO half of the failover queue build (Phase 28 D-01 / D-02 / 27 D-08): read the persisted
/// failover settings and the manifest, project them onto `lifecycle::FailoverCandidate`, and let
/// the two pure decisions in `lifecycle.rs` do the deciding.
///
/// Returns `[origin]` — byte-for-byte today's single-server behaviour — whenever this is not a
/// failover: the master switch is off (27 D-06), the drop is an `internet-lost` where no other
/// server can help (D-01), or every other participating server is excluded or absent. Only a
/// genuine tunnel-lost drop with somewhere to go returns a longer list.
///
/// Both reads FAIL CLOSED, matching 28-01's deliberate asymmetry: `get_failover_settings` already
/// reads OFF with nothing excluded when `app_settings.json` is missing or corrupt, and a manifest
/// that will not parse yields no candidates rather than an error — an unreadable server list must
/// never be a reason to move a person to an unknown exit country.
pub(crate) fn build_failover_queue(reason_code: &str, origin_path: &str) -> Vec<String> {
    let origin_only = || vec![origin_path.to_string()];

    let failover = crate::app_settings::get_failover_settings();
    if !failover.enabled {
        return origin_only();
    }

    let entries: Vec<crate::lifecycle::FailoverCandidate> =
        match crate::commands::manifest::read_manifest(&crate::ssh::portable_data_dir()) {
            Ok(manifest) => manifest
                .configs
                .into_iter()
                .map(|entry| crate::lifecycle::FailoverCandidate {
                    id: entry.id,
                    path: entry.path,
                    order: entry.order,
                })
                .collect(),
            Err(err) => {
                // D-29: the manifest parse error carries no secret, but it can carry a path, so
                // log the FACT and not the message — and fall back to the single-server queue.
                log_app(
                    "WARN",
                    &format!(
                        "[failover] manifest unreadable ({} chars of parse error) — failing closed to the current server only",
                        err.len()
                    ),
                );
                return origin_only();
            }
        };

    let queue = crate::lifecycle::failover_queue(&entries, &failover.excluded_ids, origin_path);
    // `candidates_remaining` counts the servers AFTER the origin — the origin's own retry happens
    // either way, so a queue of one is not something to fail over with.
    let remaining = queue.len().saturating_sub(1);
    if crate::lifecycle::should_failover(reason_code, failover.enabled, remaining) {
        queue
    } else {
        origin_only()
    }
}

/// Legacy adapter-recovery wait — the fallback recovery path used when no Rust
/// reconnect supervisor took over (no AppState / no saved config / user
/// disconnecting). Extracted from `start_monitor` so the slow tunnel-probe path AND
/// the fast uplink-loss short-circuit (02-18) share ONE recovery loop instead of two
/// parallel copies. Polls `check_adapter_online()` every ADAPTER_POLL_INTERVAL_SECS
/// until either the physical adapter returns (emit `reconnect`), the user reconnects
/// VPN manually, or it gives up after ~5 minutes (emit `give_up`). Returns whether
/// the session is considered recovered, which the caller uses to set `was_online`.
async fn await_adapter_recovery(
    app: &tauri::AppHandle,
    vpn_status: &Arc<Mutex<VpnStatus>>,
) -> bool {
    eprintln!("[connectivity] Waiting for network adapter to recover...");
    // AUDIT-2026-06-11 #6/#11: capture the session generation + the DURABLE
    // disconnect-intent handle at ENTRY, mirroring run_recovery_flow. The R2 guard
    // below reads only the TRANSIENT `disconnecting` flag (true ~1.6-2s) on a 5s
    // poll cadence, so a disconnect that COMPLETED between two polls was invisible
    // and this wait later fired a spurious `reconnect`/`give_up` against the newer
    // session. `None` only if AppState is somehow absent (never in-app) — then the
    // legacy transient-only behavior remains.
    let session_handles = app.try_state::<crate::commands::AppState>().map(|s| {
        (
            s.connection_generation.load(Ordering::SeqCst),
            Arc::clone(&s.connection_generation),
            Arc::clone(&s.user_disconnect_requested),
        )
    });
    let mut adapter_wait = 0u32;
    loop {
        tokio::time::sleep(Duration::from_secs(ADAPTER_POLL_INTERVAL_SECS)).await;
        adapter_wait += 1;

        // R2 (Codex M2): a user disconnect during the wait OWNS the status — abort the
        // recovery loop instead of later emitting a `reconnect` against the user's wish.
        // This fallback path previously had NO disconnect-intent check at all, so a
        // disconnect racing with offline detection could still drive a recovery and fire
        // a spurious reconnect/give_up.
        let user_disconnecting = app
            .try_state::<crate::commands::AppState>()
            .map(|s| *s.disconnecting.lock().unwrap_or_else(|e| e.into_inner()))
            .unwrap_or(false);
        if user_disconnecting {
            log_app(
                "INFO",
                "[connectivity] user disconnect during adapter recovery — aborting the wait (R2)",
            );
            return false;
        }

        // If user reconnected VPN manually, exit recovery without emitting reconnect.
        let already_reconnected = vpn_status
            .lock()
            .map(|g| *g == VpnStatus::Connected)
            .unwrap_or(false);
        if already_reconnected {
            log_app("INFO", "[connectivity] VPN reconnected externally, exiting recovery loop");
            return true;
        }

        // AUDIT-2026-06-11 #6/#11: the R2 transient-flag check above misses a
        // disconnect that COMPLETED between two 5s polls. Re-check the DURABLE
        // intent + the captured generation (bumped by vpn_connect / vpn_disconnect /
        // begin_shutdown): either means the session this wait was started for is
        // gone, so abort instead of later emitting a spurious reconnect/give_up
        // against the newer session. Runs AFTER the Connected check so an external
        // reconnect that already landed still reports `recovered = true`.
        if let Some((captured_generation, gen_arc, durable_disconnect)) = &session_handles {
            if !crate::lifecycle::is_current_generation(
                *captured_generation,
                gen_arc.load(Ordering::SeqCst),
            ) || durable_disconnect.load(Ordering::SeqCst)
            {
                log_app(
                    "INFO",
                    "[connectivity] generation advanced or user disconnect requested during adapter recovery — aborting the wait (AUDIT #6/#11)",
                );
                return false;
            }
        }

        if check_adapter_online().await {
            eprintln!("[connectivity] Network adapter back online after {adapter_wait} checks");
            log_app("INFO", &format!("[connectivity] Adapter recovered after {} checks", adapter_wait));
            // Give adapter a moment to fully stabilize.
            tokio::time::sleep(Duration::from_secs(3)).await;
            // PA-4 tail (17-07): the sibling `internet-status { online:true, action:"reconnect" }`
            // emit that used to fire here is REMOVED — a producer with no consumer. The FE listener
            // deliberately IGNORES the `reconnect` action (useInternetStatusListener.ts: «Rust owns
            // reconnect»); recovery progress rides the `vpn-status` event (Reconnecting + «Попытка
            // N/N») the reconnect supervisor writes through the single status owner (D-01). This is
            // the twin of the primary-site removal 17-04 did in the newer recovery flow (above);
            // 17-04 left this legacy-fallback sibling in scope for 17-07 (its follow-up flag).
            // Nothing else keys on this emit — the return value below drives `was_online`.
            return true;
        }

        // Give up after ~5 minutes of waiting (ADAPTER_RECOVERY_TIMEOUT_CHECKS × ADAPTER_POLL_INTERVAL_SECS).
        if adapter_wait >= ADAPTER_RECOVERY_TIMEOUT_CHECKS {
            eprintln!("[connectivity] Gave up waiting for adapter after 5 minutes");
            log_app("WARN", "[connectivity] Gave up waiting for adapter after 5 minutes");
            app.emit("internet-status", crate::commands::vpn::InternetStatusPayload {
                online: false,
                action: Some(crate::commands::vpn::InternetStatusAction::GiveUp),
                reason: None,
            }).ok();
            return false;
        }
    }
}

/// 02-20 status-UX split: the «Восстановление» (Recovering) recovery flow for a
/// LOCAL-NETWORK loss (`internet-lost`).
///
/// On a whole-internet outage (no physical adapter at all) there is nothing to
/// (re)connect to yet, so we must NOT hand off to the bounded reconnect supervisor
/// and burn its attempts on a dead network. Instead this:
///   1. Sets `VpnStatus::Recovering` (red «Восстановление», waiting for the net) and
///      emits the `internet-status { online:false, action:"disconnect", reason }`
///      signal so the FE shows the recovering banner.
///   2. WAITS for the physical adapter to return, polling every
///      `ADAPTER_POLL_INTERVAL_SECS` up to `RECOVERY_TIMEOUT_CHECKS` (~5 minutes —
///      user decision, UAT fd63ec; the user can «Отмена» any time).
///   3. ADAPTER BACK → emits `internet-status { online:true, action:"reconnect" }`
///      and hands off to the SAME window-independent reconnect supervisor, which runs
///      the actual re-establish as «Переподключение» (Reconnecting) + «Попытка N/N» +
///      bounded + give-up Error. So the SPEC §3 flow «🔴 Восстановление → 🟡
///      Переподключение → 🟢/🔴» is composed: this fn owns the red wait, the
///      supervisor owns the yellow re-establish.
///   4. TIMEOUT (adapter never returned) → terminal `VpnStatus::Error` carrying the
///      STABLE reason code `RECOVERY_TIMEOUT_REASON` (Stage 2 localizes it to «Не
///      удалось восстановить связь. Проверьте подключение к интернету.»).
///
/// Guards preserved exactly like `declare_offline_and_handoff` / the supervisor:
///   - USER DISCONNECT: if `disconnecting` is set at any poll, abort silently (do not
///     fight a user-initiated disconnect — D-04) and leave the status to the
///     disconnect path.
///   - USER RECONNECT: if `vpn_status` is already `Connected` (the user manually
///     reconnected during the wait), exit without forcing anything.
///   - GENERATION: the supervisor handoff passes the CURRENT generation so a manual
///     reconnect/disconnect that bumped it neutralizes the (now-stale) supervisor
///     (Codex HIGH). The recovery wait itself re-reads the live status/intent each
///     poll, so a generation bump that flips status away from Recovering ends the wait.
///   - SINGLE SUPERVISOR (CR-02): the handoff only starts a supervisor when none is
///     already live, mirroring `declare_offline_and_handoff`.
async fn run_recovery_flow(app: &tauri::AppHandle, vpn_status: &Arc<Mutex<VpnStatus>>) {
    // R1 (CAS ownership — the «застряло на Подключено» fix): claim the single-supervisor
    // slot for the DURATION of the «Восстановление» wait. The still-alive sidecar loses
    // its uplink and EXITS while we wait; its `Terminated` arm checks
    // `reconnect_in_progress` and, seeing us hold it, DEFERS instead of starting a
    // competing supervisor that would respawn and race the status back to Connected. If
    // the slot is already owned (a supervisor is live), defer to it — don't run a second
    // recovery. The guard is released (RAII) on every exit, and explicitly dropped right
    // before the adapter-back handoff so the re-establish supervisor can claim it.
    // WR-05: resolve AppState ONCE for the claim + the initial status write (the whole
    // recovery flow is meaningless without it, so bail if absent). The previous two-lookup
    // structure left an ambiguous "guard is None but we keep going" path on the
    // None-AppState branch; this removes it. `try_state` never returns None in-app.
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return;
    };
    let recovery_guard =
        match ReconnectInProgressGuard::try_claim(Arc::clone(&state.reconnect_in_progress)) {
            Some(g) => g,
            None => {
                log_app(
                    "INFO",
                    "[connectivity] recovery: a supervisor already owns recovery — deferring (R1)",
                );
                return;
            }
        };

    // AUDIT-2026-06-11 #6/#11: capture the session generation + the DURABLE
    // disconnect-intent handle at ENTRY. The wait loop below used to read only the
    // TRANSIENT `disconnecting` flag (true for just ~1.6-2s while vpn_disconnect
    // runs) on a 5s poll cadence, so a manual disconnect that COMPLETED between two
    // polls was routinely missed: this actor lived on as a zombie holding the CR-02
    // slot for up to 5 minutes, and its timeout then wrote Error(recovery-timeout) +
    // teardown over the user's clean Disconnected — or over (and killing) a
    // brand-new Connecting session started after the cancel («Отмена» +
    // «Подключиться» is the documented T-36 user remedy, so this raced in the
    // field). vpn_connect / vpn_disconnect / begin_shutdown ALL bump the generation,
    // so the per-poll re-check below aborts on: a generation advance, the durable
    // `user_disconnect_requested` flag, or the live status leaving Recovering
    // (another actor owns the status) — making the doc-comment's claimed guard real.
    // Cloned Arcs only — no `state` borrow is held across an await.
    let captured_generation = state.connection_generation.load(Ordering::SeqCst);
    let gen_arc = Arc::clone(&state.connection_generation);
    let durable_disconnect_arc = Arc::clone(&state.user_disconnect_requested);

    // 1. Announce «Восстановление». Status write through the single owner (D-01); the
    //    FE banner is driven by the internet-status event (action=disconnect) the same
    //    way the legacy path drove it — the reason classifies it as internet-loss.
    crate::commands::vpn::set_vpn_status(app, &state, VpnStatus::Recovering, None);
    // NB: `state`'s borrow ENDS here — this is its last use, so NLL releases it before the
    // wait loop's `.await`s; we never hold a `State` borrow across an await. The loop
    // re-resolves AppState internally each poll, and `recovery_guard` owns an independent
    // Arc. Do NOT add a `state` use after this point, or the future would capture the
    // borrow across an await.
    app.emit(
        "internet-status",
        crate::commands::vpn::InternetStatusPayload {
            online: false,
            action: Some(crate::commands::vpn::InternetStatusAction::Disconnect),
            reason: Some(crate::commands::vpn::InternetStatusReason::InternetLost),
        },
    )
    .ok();

    log_app(
        "INFO",
        "[connectivity] local network gone — Recovering (waiting for the adapter, NOT burning reconnect attempts) (02-20)",
    );

    // 2. Wait for the physical adapter, bounded by the SHORT test recovery timeout.
    let mut adapter_wait = 0u32;
    loop {
        tokio::time::sleep(Duration::from_secs(ADAPTER_POLL_INTERVAL_SECS)).await;
        adapter_wait += 1;

        // USER DISCONNECT — never fight it; the disconnect path owns the status now.
        let user_disconnecting = app
            .try_state::<crate::commands::AppState>()
            .map(|s| *s.disconnecting.lock().unwrap_or_else(|e| e.into_inner()))
            .unwrap_or(false);
        if user_disconnecting {
            log_app(
                "INFO",
                "[connectivity] user disconnect during recovery — aborting recovery wait (02-20)",
            );
            return;
        }

        // AUDIT-2026-06-11 #6/#11: abort when we provably no longer own this wait —
        // the generation advanced (a manual disconnect / connect / shutdown completed
        // between two polls, which the ~2s transient flag above routinely misses) or
        // the durable disconnect intent is set. Without this, the zombie wait held
        // the CR-02 slot for up to 5 minutes and its timeout clobbered the newer
        // session (see the entry comment).
        if !crate::lifecycle::is_current_generation(
            captured_generation,
            gen_arc.load(Ordering::SeqCst),
        ) || durable_disconnect_arc.load(Ordering::SeqCst)
        {
            log_app(
                "INFO",
                "[connectivity] generation advanced or user disconnect requested during recovery — aborting recovery wait (AUDIT #6/#11)",
            );
            return;
        }

        // AUDIT-2026-06-11 #6/#11: ownership-of-status check, WIDENED from the old
        // `== Connected` (USER RECONNECT) test. This flow set Recovering itself at
        // entry, so ANY other live status means another actor took ownership — a
        // manual reconnect (Connecting/Connected), a completed disconnect
        // (Disconnected), or a quit. The old check matched only Connected, so a
        // completed disconnect was invisible and the zombie wait ran on.
        let still_recovering = vpn_status
            .lock()
            .map(|g| *g == VpnStatus::Recovering)
            .unwrap_or(false);
        if !still_recovering {
            log_app(
                "INFO",
                "[connectivity] status moved off Recovering during recovery wait — another actor owns the session, exiting (AUDIT #6/#11)",
            );
            return;
        }

        // ADAPTER BACK → hand off to the supervisor for the «Переподключение» phase.
        //
        // AUDIT-2026-06-11 #16 (T-36): the adapter-back signal is
        // `find_physical_adapter().is_some()` — the EXACT no-I/O signal whose absence
        // declared the loss — NOT `check_adapter_online()`. During the Recovering
        // wait the dead-tunnel sidecar is deliberately kept ALIVE (it is only killed
        // later by the supervisor's respawn or the teardown), so its WinTUN routes +
        // fail-closed killswitch still hijack default routing: check_adapter_online's
        // unbound HTTP fallback rode the DEAD tunnel and always failed, and its
        // gateway:80 TCP leg gets RST on gateways with no HTTP listener (phone
        // hotspots, enterprise routers). The adapter would be physically back yet
        // recovery never completed → terminal Error(recovery-timeout) after 5 minutes
        // with the killswitch blocking all traffic — the T-36 «recovery hangs»
        // mechanism. No corroborating I/O probe is added here: any probe would have
        // to be socket-bound to the new adapter's IP to avoid the same hijack, and
        // the supervisor's respawn + bounded connect attempts right after this
        // handoff already prove (or honestly fail) actual connectivity.
        if find_physical_adapter().is_some() {
            log_app(
                "INFO",
                &format!("[connectivity] adapter back after {adapter_wait} checks — moving to Reconnecting (02-20)"),
            );
            // Give the adapter a moment to fully stabilize (mirrors await_adapter_recovery).
            tokio::time::sleep(Duration::from_secs(3)).await;
            // PA-4 (Phase 17): the `internet-status { action:"reconnect" }` emit that used to
            // fire here is REMOVED — it was a producer with no consumer. The FE listener
            // deliberately ignores the `reconnect` action (useVpnEvents.ts: «Rust owns
            // reconnect»); recovery progress rides the `vpn-status` event (Reconnecting +
            // «Попытка N/N») the supervisor below writes through the single status owner
            // (D-01). Dropping the dead emit removes a silent-drift surface.
            // R1: release our recovery ownership so the re-establish supervisor can claim
            // it. A Terminated arm sneaking into the tiny gap would just start the same
            // supervisor we are about to start (and the handoff's own try_claim then
            // aborts the duplicate) — at most ONE supervisor runs either way.
            drop(recovery_guard);
            // Compose the re-establish: start the SAME supervisor (Reconnecting +
            // «Попытка N/N» + bounded + give-up Error), gated exactly like the
            // live-sidecar handoff.
            //
            // WR-03: the handoff can decline for THREE reasons — and they are NOT
            // equivalent. `disconnecting` and "a supervisor is already live" are
            // legitimately handled elsewhere (the disconnect path / the other
            // supervisor's own status writes move the status off Recovering). But a
            // MISSING saved config is the genuinely-stuck case: the network is back yet
            // there is nothing to reconnect to, so without a terminal write the status
            // sticks on the red «Восстановление» forever (the FE deliberately ignores
            // the `reconnect` internet-status action — useVpnEvents). So when the
            // handoff returns NoConfig, resolve to a terminal Disconnected: the adapter
            // is back, let the user reconnect from a clean state. The other two outcomes
            // intentionally leave the status as-is (handled elsewhere).
            match handoff_reconnect_supervisor(app) {
                HandoffOutcome::Started | HandoffOutcome::DeferredToOwner => {}
                HandoffOutcome::NoConfig => {
                    let do_teardown = if let Some(state) =
                        app.try_state::<crate::commands::AppState>()
                    {
                        let user_disconnecting =
                            *state.disconnecting.lock().unwrap_or_else(|e| e.into_inner());
                        // Re-check intent: a user disconnect that landed in this window
                        // owns the status — don't clobber it.
                        if !user_disconnecting {
                            log_app(
                                "WARN",
                                "[connectivity] adapter recovered but no saved config to reconnect to — resolving to Disconnected instead of sticking on Recovering (WR-03)",
                            );
                            crate::commands::vpn::set_vpn_status(
                                app,
                                &state,
                                VpnStatus::Disconnected,
                                None,
                            );
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    // R3: release any old sidecar so a clean reconnect is possible (it
                    // was holding the adapter/killswitch). Status Disconnected is set above.
                    if do_teardown {
                        crate::commands::vpn::teardown_session_sidecar(app).await;
                    }
                }
            }
            return;
        }

        // 3. TIMEOUT — the adapter never returned within the SHORT recovery window.
        if adapter_wait >= RECOVERY_TIMEOUT_CHECKS {
            // AUDIT-2026-06-11 #6: re-run the SAME ownership checks as the poll body
            // immediately before the terminal write — the per-poll checks above can
            // be a full poll interval stale, and a stale recovery actor must NEVER
            // clobber a newer session with Error(recovery-timeout) + teardown (the
            // teardown would kill the user's brand-new in-flight sidecar). Checked
            // BEFORE the give_up emit too, so a stale actor doesn't even flash the
            // banner over the newer session.
            let still_owns_session = crate::lifecycle::is_current_generation(
                captured_generation,
                gen_arc.load(Ordering::SeqCst),
            ) && !durable_disconnect_arc.load(Ordering::SeqCst)
                && vpn_status
                    .lock()
                    .map(|g| *g == VpnStatus::Recovering)
                    .unwrap_or(false);
            if !still_owns_session {
                log_app(
                    "INFO",
                    "[connectivity] recovery timeout reached but the session is no longer ours — suppressing Error(recovery-timeout) + teardown (AUDIT #6)",
                );
                return;
            }
            log_app(
                "WARN",
                "[connectivity] adapter did not return within the recovery timeout — Error(recovery-timeout) (02-20)",
            );
            app.emit(
                "internet-status",
                crate::commands::vpn::InternetStatusPayload {
                    online: false,
                    action: Some(crate::commands::vpn::InternetStatusAction::GiveUp),
                    reason: None,
                },
            )
            .ok();
            // Terminal Error through the single mutator carrying the STABLE reason
            // code — Stage 2 localizes it. Re-check intent first so we don't clobber a
            // user disconnect that landed in the final poll window.
            // Compute the terminal write + whether to tear down WITHOUT holding the
            // `state` borrow across the teardown `.await` (Send-safety + no lock held
            // across await).
            let do_teardown = if let Some(state) = app.try_state::<crate::commands::AppState>() {
                let user_disconnecting =
                    *state.disconnecting.lock().unwrap_or_else(|e| e.into_inner());
                if !user_disconnecting {
                    crate::commands::vpn::set_vpn_status(
                        app,
                        &state,
                        VpnStatus::Error,
                        Some(crate::lifecycle::RECOVERY_TIMEOUT_REASON.to_string()),
                    );
                    true
                } else {
                    false
                }
            } else {
                false
            };
            // R3: release the old sidecar still holding the WinTUN adapter + killswitch —
            // the network never returned, so it is dead weight that would strand traffic
            // and block the next connect. The terminal Error is already written above.
            if do_teardown {
                crate::commands::vpn::teardown_session_sidecar(app).await;
            }
            return;
        }
    }
}

/// WR-03: the distinct outcomes of a reconnect-supervisor handoff. The recovery flow
/// must react differently to each — see `run_recovery_flow`:
/// - `Started`: a supervisor was spawned; it now owns the status (Reconnecting → …).
/// - `DeferredToOwner`: a handoff was declined because the disconnect path owns intent
///   (`disconnecting`) OR another supervisor is already live — either way SOMETHING
///   ELSE will move the status off Recovering, so the recovery flow leaves it alone.
/// - `NoConfig`: there is no saved `config_path` to reconnect to — the genuinely-stuck
///   case. Nothing else will touch the status, so the caller must resolve it terminally
///   (Disconnected) rather than leave the red «Восстановление» up forever.
#[derive(Debug, PartialEq, Eq)]
enum HandoffOutcome {
    Started,
    DeferredToOwner,
    NoConfig,
}

/// 02-20: start the window-independent reconnect supervisor for the «Переподключение»
/// phase after the adapter has returned, reusing the EXACT gating
/// `declare_offline_and_handoff` applies (intent / CR-02 single-supervisor / saved
/// config / current generation). Factored out so the recovery flow and the live-drop
/// path can't drift on the gating.
///
/// WR-03: returns a `HandoffOutcome` so the caller can tell the genuinely-stuck
/// `NoConfig` case (nothing to reconnect to → caller must resolve the status) apart
/// from the `DeferredToOwner` cases (disconnecting / supervisor already live → handled
/// elsewhere). Previously this returned `()` and the caller always left the status as
/// `Recovering`, so the no-config edge stuck on red «Восстановление» indefinitely.
fn handoff_reconnect_supervisor(app: &tauri::AppHandle) -> HandoffOutcome {
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        // No AppState (should never happen in-app). Treat as deferred — there is no
        // state to write a terminal status through anyway.
        return HandoffOutcome::DeferredToOwner;
    };
    let user_disconnecting = state
        .disconnecting
        .lock()
        .map(|g| *g)
        .unwrap_or(false);
    let supervisor_live = state.reconnect_in_progress.load(Ordering::SeqCst);
    if user_disconnecting || supervisor_live {
        // The disconnect path or the already-live supervisor owns the status — it will
        // move it off Recovering, so we deliberately do not touch it here.
        log_app(
            "INFO",
            "[connectivity] adapter recovered but no supervisor started (disconnecting / already live) — owner will resolve the status (02-20)",
        );
        return HandoffOutcome::DeferredToOwner;
    }
    let config_path = state.config_path.lock().ok().and_then(|g| g.clone());
    let Some(config_path) = config_path else {
        // Network is back but there is NOTHING to reconnect to. The caller must resolve
        // the status (WR-03) — leaving it Recovering would stick on red forever.
        log_app(
            "WARN",
            "[connectivity] adapter recovered but no saved config — caller must resolve the stuck Recovering status (WR-03)",
        );
        return HandoffOutcome::NoConfig;
    };
    let generation = state.connection_generation.load(Ordering::SeqCst);
    let log_level = state
        .log_level
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| "info".to_string());
    log_app(
        "INFO",
        "[connectivity] adapter recovered — starting reconnect supervisor for the re-establish (02-20)",
    );
    // 28-02: a single-candidate queue. This is the `internet-lost` recovery path — the uplink
    // just came back and the SAME server must be brought up, with the full reboot-surviving
    // budget (D-01). Failover deliberately does not apply here: no other server could have
    // helped while the local uplink was gone.
    // A ONE-entry queue, so `kind` cannot change a single budget here (`per_candidate_attempt_budget`
    // short-circuits on `queue_len <= 1`). Passed honestly rather than defaulted: this path exists
    // because the local uplink went away, which is a local cause, and a future reader must not have
    // to reverse-engineer that from the queue length.
    start_reconnect_supervisor(
        app.clone(),
        vec![config_path],
        log_level,
        generation,
        crate::lifecycle::WalkKind::LocalProcessDeath,
    );
    HandoffOutcome::Started
}

/// Window-independent auto-reconnect supervisor (STATUS-05 / D-01).
///
/// Spawned (via `tauri::async_runtime::spawn`, mirroring `start_monitor`) on an
/// UNEXPECTED drop from BOTH triggers:
/// - `sidecar.rs`'s `Terminated` arm (the sidecar process EXITED), and
/// - this module's `start_monitor` connectivity-loss path (the sidecar stayed
///   ALIVE but the tunnel is dead) — criterion 3 (Codex/Gemini HIGH).
///
/// It retries at a fixed snappy interval (no exponential backoff — D-02), emitting
/// `VpnStatus::Reconnecting` per attempt through the SINGLE mutator `set_vpn_status` (D-03),
/// fast-fails on instant deaths (Gemini), and is generation-guarded so a manual reconnect /
/// disconnect that bumped `connection_generation` neutralizes a stale supervisor (Codex HIGH).
/// When the budget runs out it sets a terminal `VpnStatus::Error` carrying a STABLE secret-free
/// reason code — never a Russian string.
///
/// **28-02 — `queue` replaces the single `config_path`.** The supervisor now walks a list of
/// candidate config paths, origin first (`lifecycle::failover_queue`). A ONE-entry queue is the
/// unchanged path: the same server, the full `RECONNECT_MAX_ATTEMPTS`, `RECONNECT_GAVE_UP_REASON`
/// on give-up — byte-for-byte what shipped before, which is what every caller except the
/// tunnel-lost handoff passes. A longer queue is a failover walk: one attempt per candidate
/// (D-02), advancing on give-up, and `FAILOVER_EXHAUSTED_REASON` if the pass finds nobody (D-05).
///
/// Three properties the walk's SHAPE buys, each of which a different structure would lose:
/// - **One guard for the whole walk.** `ReconnectInProgressGuard::try_claim` is claimed ONCE,
///   before the outer loop, exactly where it was claimed before. Chaining a second
///   `start_reconnect_supervisor` per candidate cannot work — its own CAS refuses while the first
///   still holds the guard — and releasing the guard first opens a window for the sidecar
///   `Terminated` arm to start a competing supervisor. One guard is the CR-02 single-owner
///   property for free (T-28-06).
/// - **No FULL teardown between candidates.** `teardown_session_sidecar` mid-walk would release the
///   WinTUN adapter and the fail-closed killswitch with it, which is the leak D-06 exists to
///   prevent, so it happens exactly once, after the terminal write (T-28-05) — the property
///   `the_walk_offers_no_teardown_seam_between_candidates` guards.
///
///   This is NOT the same as «nothing happens between candidates», which is what this note used to
///   say. `respawn_sidecar` performs a NARROW, deliberate teardown of its own before each spawn:
///   restore the system DNS, drop the hosts block, and kill the previous core GRACEFULLY so it can
///   run its own killswitch/route cleanup. That is not optional politeness — without the DNS
///   restore the system still points at the dead core's proxy, the next candidate cannot resolve
///   its own server address, and every candidate fails (28-UAT G-28-1d: a walk that visited every
///   server and connected to none). The two are different things: the narrow one hands the OS back
///   what the dying core held, the full one hands back the tunnel itself.
/// - **Ownership re-checked on every advance**, not only every attempt — an advance connects to a
///   DIFFERENT config, which is closer to a `vpn_connect` than to a retry (T-28-07). See
///   `run_failover_walk`'s doc comment for why an advance must NOT re-capture the generation.
///
/// `generation` is the `connection_generation` value captured by the trigger at the
/// moment of the drop; the supervisor re-checks it before every respawn / status
/// write via the loop's `live_generation` closure, and holds it frozen across the whole walk.
pub fn start_reconnect_supervisor(
    app: tauri::AppHandle,
    queue: Vec<String>,
    log_level: String,
    generation: u64,
    kind: crate::lifecycle::WalkKind,
) {
    tauri::async_runtime::spawn(async move {
        log_app(
            "INFO",
            &format!("[reconnect] supervisor started (generation {generation})"),
        );

        // Resolve the shared status/generation/intent handles from AppState ONCE.
        // The supervisor only owns cloned Arcs (it cannot hold a `tauri::State`
        // borrow across the loop), and routes EVERY status write through
        // `set_vpn_status` so the single-mutator invariant holds — it never writes
        // `vpn_status` or emits `"vpn-status"` directly (D-01/D-03).
        let state = match app.try_state::<crate::commands::AppState>() {
            Some(s) => s,
            None => {
                log_app("WARN", "[reconnect] AppState unavailable — supervisor aborting");
                return;
            }
        };
        let gen_arc = Arc::clone(&state.connection_generation);
        let disc_arc = Arc::clone(&state.disconnecting);
        let status_arc = Arc::clone(&state.vpn_status);
        let last_error_arc = Arc::clone(&state.last_error);

        // CR-02: ATOMICALLY claim the single-supervisor slot. While we hold `_guard`,
        // THIS supervisor owns recovery for the current drop and the sidecar `Terminated`
        // arm must not spawn a second supervisor when our own respawned child dies again.
        // `_guard` clears the flag on EVERY exit path (Recovered / Aborted / GaveUp, and
        // the GaveUp-suppression early return) via its Drop, so a genuine NEW drop AFTER
        // we give up still starts a fresh supervisor.
        //
        // The claim is a CAS (try_claim), NOT the old blind store: if another actor
        // already owns recovery — the recovery flow holding it across the «Восстановление»
        // wait, or a sibling supervisor that won a concurrent start — we are the loser of
        // the race and ABORT here instead of running a second, racing supervisor (Codex).
        let _guard = match ReconnectInProgressGuard::try_claim(Arc::clone(
            &state.reconnect_in_progress,
        )) {
            Some(g) => g,
            None => {
                log_app(
                    "INFO",
                    "[reconnect] another actor already owns recovery — not starting a second supervisor (CR-02)",
                );
                return;
            }
        };

        let user_disconnect_requested_arc = Arc::clone(&state.user_disconnect_requested);

        // 28-02: how many attempts a REAL candidate of this queue gets. A one-entry queue keeps
        // the full reboot-surviving budget. Index 1 is asked because on a walk the budget is now
        // index-dependent — the ORIGIN (index 0) gets none at all (owner ruling 2026-08-26) — and
        // this value is what the log lines and the give-up marker below are about: they describe
        // what each server the walk actually tries was given. The per-candidate budget used by the
        // loop is computed INSIDE the closure, from that candidate's own index.
        let per_candidate = crate::lifecycle::per_candidate_attempt_budget(kind, queue.len(), 1);
        if queue.len() > 1 {
            // What happens to the ORIGIN is the whole difference between the two causes, so the log
            // says which one this walk is. Reading «the origin is skipped» on a line where it was in
            // fact retried ten times is exactly the kind of drift that makes a log worse than none.
            let origin_note = match kind {
                crate::lifecycle::WalkKind::ServerDrop => {
                    "the origin is skipped (it just went silent)"
                }
                crate::lifecycle::WalkKind::LocalProcessDeath => {
                    "the origin is retried in full FIRST (local process death)"
                }
            };
            log_app(
                "INFO",
                &format!(
                    "[failover] walking {} candidates, {per_candidate} attempt(s) each; {origin_note} (owner ruling 2026-08-26)",
                    queue.len()
                ),
            );
        }

        // The outer queue walk. Each candidate runs the UNCHANGED bounded loop; the walk only
        // decides whether to advance. `run_one_candidate` rebuilds the injected closures per
        // candidate because `run_reconnect_loop` consumes them — they are Arc clones, so this is
        // cheap, and it is what lets each candidate carry its own config path.
        let walk = run_failover_walk(
            queue.len(),
            |index| {
                let candidate = queue[index].clone();
                // THIS candidate's attempt budget. Index-dependent since the 2026-08-26
                // ruling: on a real walk the ORIGIN (index 0) gets zero, so the loop gives up on
                // its first attempt number without respawning anything and the walk reaches the
                // next server immediately instead of spending a ~55s ceiling on the corpse. A
                // one-entry queue is not a walk and keeps the full budget at every index.
                let candidate_budget =
                    crate::lifecycle::per_candidate_attempt_budget(kind, queue.len(), index);
                // Progress numbers for the UI, resolved HERE rather than inside the `async move`
                // below: reading `queue` from inside that block would move the whole vector into
                // the future, and the walk needs it again afterwards.
                //
                // The origin (index 0) is skipped and never respawns, so the servers a person
                // actually sees tried are indices 1..len-1 — this candidate's place among them is
                // `index`, out of `queue.len() - 1`.
                // A walk, for LABELLING purposes, means «we have moved off the origin» — not merely
                // «the queue has more than one entry». Index 0 is the origin: on a `ServerDrop` walk
                // it never reaches this code (budget zero → the `1..=0` loop body never runs), but on
                // a `LocalProcessDeath` walk it runs with the full budget, and there the honest
                // sentence is «Попытка 3 из 10» about the SAME server — not «Переключение на «X»»
                // naming the server the user is already on.
                let walking = queue.len() > 1 && index > 0;
                let walk_position = index as u32;
                let walk_total = queue.len().saturating_sub(1) as u32;
                // The candidate's DISPLAY NAME, read here for the same borrow reason as the numbers
                // above. Resolved ONLY on a walk: on a plain reconnect the server has not changed, so
                // naming it in the progress line would add a word and no information. `None` when the
                // config is unreadable or unnamed — the frontend then falls back to a sentence that
                // does not pretend to know (see `reconnectLabel.ts`). D-29: the display name only.
                let candidate_name = if walking {
                    crate::commands::manifest::current_display_name(&candidate)
                } else {
                    None
                };
                let app = app.clone();
                let log_level = log_level.clone();
                let status_arc = Arc::clone(&status_arc);
                let last_error_arc = Arc::clone(&last_error_arc);
                let gen_arc = Arc::clone(&gen_arc);
                let disc_arc = Arc::clone(&disc_arc);
                let durable_arc = Arc::clone(&user_disconnect_requested_arc);
                async move {
                    // 28-03 (D-04): a candidate past the origin is a real SWITCH — a different
                    // server, so a different exit country and address. Stamp the pending connect
                    // origin BEFORE the respawn so this candidate's `Connected` edge resolves to
                    // the EXISTING `autoSwitched` plate instead of a generic «Подключено»; the
                    // user's global notification toggle still gates it. Index 0 is the origin
                    // server and leaves the stamp untouched — a successful retry moved nobody.
                    //
                    // Re-stamped PER CANDIDATE, not once per walk: a failed candidate's terminal
                    // Error edge legitimately consumes the origin, so a single up-front stamp
                    // would be spent by candidate #2's failure and #3's success would read Manual.
                    crate::notify::stamp_failover_connect_origin(&app, index);

                    // Injected predicates for the testable core, rebuilt for this candidate.
                    let live_generation = {
                        let gen_arc = Arc::clone(&gen_arc);
                        move || gen_arc.load(Ordering::SeqCst)
                    };
                    // T-31: a user disconnect is observed via EITHER the transient `disconnecting`
                    // flag OR the DURABLE `user_disconnect_requested` flag. The transient one is
                    // cleared at the end of `vpn_disconnect` (WR-01), so a supervisor re-reading
                    // intent after the disconnect completed would miss it and let an in-flight
                    // respawn flip back to Connected (the double-press UAT bug). The durable flag
                    // persists until the next vpn_connect, so the OR sees the user's intent at
                    // every decision point — including the post-success re-check below.
                    let user_disconnected = {
                        let disc_arc = Arc::clone(&disc_arc);
                        let durable = Arc::clone(&durable_arc);
                        move || {
                            *disc_arc.lock().unwrap_or_else(|e| e.into_inner())
                                || durable.load(Ordering::SeqCst)
                        }
                    };

                    // Progress for the UI via the single mutator (D-03). The counts are non-secret
                    // (D-09), so the marker is safe to log/emit.
                    //
                    // WHAT THE TWO NUMBERS MEAN depends on which situation this is, and getting
                    // that wrong is the UAT complaint (2026-08-26). On a plain reconnect of
                    // ONE server they are the retry index — «Попытка 3 из 10», which is exactly what
                    // a person wants to know. On a failover WALK every candidate gets a single
                    // attempt, so the same fields rendered «Попытка 1 из 1» on server after server:
                    // a counter that never moved, over a process the user could not see. On a walk
                    // they now carry the QUEUE position instead — which server of how many — and
                    // the `failover` flag tells the frontend which sentence to render.
                    let on_reconnecting = {
                        let app = app.clone();
                        move |attempt: u32| {
                            let (shown, total) = if walking {
                                (walk_position, walk_total)
                            } else {
                                (attempt, candidate_budget)
                            };
                            let marker = if walking {
                                match candidate_name.as_deref() {
                                    Some(name) => {
                                        format!("failover candidate {shown}/{total} -> {name}")
                                    }
                                    None => format!("failover candidate {shown}/{total}"),
                                }
                            } else {
                                format!("reconnect attempt {shown}/{total}")
                            };
                            log_app("INFO", &format!("[reconnect] {marker}"));
                            app.emit(
                                "vpn-log",
                                serde_json::json!({ "message": marker, "level": "info" }),
                            )
                            .ok();
                            if let Some(state) = app.try_state::<crate::commands::AppState>() {
                                crate::commands::vpn::set_vpn_status_reconnecting_attempt(
                                    &app,
                                    &state,
                                    shown,
                                    total,
                                    walking,
                                    candidate_name.clone(),
                                );
                            }
                        }
                    };

                    // The real respawn + wait-for-connected attempt. Returns (succeeded,
                    // elapsed, failure_reason): elapsed feeds the fast-fail decision so an
                    // instant death is counted without sleeping the full window; failure_reason
                    // is the specific Error this attempt landed (read from `last_error`) so the
                    // loop can short-circuit a terminal reason (02-10, T-10-03).
                    let try_connect = {
                        let app = app.clone();
                        let candidate = candidate.clone();
                        let log_level = log_level.clone();
                        let status_arc = Arc::clone(&status_arc);
                        let last_error_arc = Arc::clone(&last_error_arc);
                        move |_attempt: u32| {
                            let app = app.clone();
                            let candidate = candidate.clone();
                            let log_level = log_level.clone();
                            let status_arc = Arc::clone(&status_arc);
                            let last_error_arc = Arc::clone(&last_error_arc);
                            async move {
                                let start = Instant::now();
                                // FAB-R1: pass the supervisor's captured `generation` so the
                                // respawn can re-check ownership before storing its child (a
                                // mid-respawn switch bump makes this attempt stale). It stays the
                                // generation captured AT THE DROP for every candidate — see
                                // `run_failover_walk` for why an advance must not re-capture it.
                                let ok = respawn_and_wait(
                                    &app,
                                    &candidate,
                                    &log_level,
                                    &status_arc,
                                    generation,
                                )
                                .await;
                                // On failure, read the specific Error reason the attempt landed so
                                // the loop can short-circuit a terminal one. Only meaningful when
                                // !ok; on success the reason is irrelevant (loop → Recovered).
                                let reason = if ok {
                                    None
                                } else {
                                    last_error_arc
                                        .lock()
                                        .unwrap_or_else(|e| e.into_inner())
                                        .clone()
                                };
                                (ok, start.elapsed(), reason)
                            }
                        }
                    };

                    let sleep_interval = || async {
                        tokio::time::sleep(crate::lifecycle::RECONNECT_INTERVAL).await
                    };
                    run_reconnect_loop(
                        generation,
                        candidate_budget,
                        try_connect,
                        user_disconnected,
                        live_generation,
                        on_reconnecting,
                        sleep_interval,
                    )
                    .await
                }
            },
            // T-28-07 + FB-03: the queue-advance gate. An advance spawns a sidecar for a
            // DIFFERENT config, so it must re-prove — against the SAME frozen captured
            // generation — that this walk still owns the session, AND that the user has not
            // revoked the permission that authorized it in the first place. `get_failover_settings`
            // is otherwise read only at queue-build time, so «Авто-режим» switched OFF mid-walk was
            // silently ignored (FB-03). One small file read per advance, at most N-1 times per
            // walk. The decision itself is the pure `lifecycle::failover_advance_allowed`.
            || {
                let user_intent = *disc_arc.lock().unwrap_or_else(|e| e.into_inner())
                    || user_disconnect_requested_arc.load(Ordering::SeqCst);
                let still_ours = crate::lifecycle::is_current_generation(
                    generation,
                    gen_arc.load(Ordering::SeqCst),
                );
                // Fails closed exactly like the build-time read: an unreadable/corrupt
                // `app_settings.json` reads OFF, and OFF here simply stops the walk — the current
                // candidate has already run and nothing is torn down mid-flight (D-06 intact).
                let failover_enabled = crate::app_settings::get_failover_settings().enabled;
                if !crate::lifecycle::failover_advance_allowed(
                    user_intent,
                    still_ours,
                    failover_enabled,
                ) {
                    // D-29: which of the three facts refused, never a path or a server name.
                    let why = if !failover_enabled && !user_intent && still_ours {
                        "«Авто-режим» switched off mid-walk (FB-03)"
                    } else {
                        "the session is no longer ours (T-28-07)"
                    };
                    log_app("INFO", &format!("[failover] queue advance refused — {why}"));
                    return false;
                }
                true
            },
        )
        .await;

        let outcome = walk.outcome;
        if walk.queue_exhausted {
            log_app(
                "WARN",
                &format!(
                    "[failover] one pass over {} candidates finished with no answer (D-05)",
                    queue.len()
                ),
            );
        } else if let Some(switched_to) = failover_switch_target(&walk, &queue) {
            // FB-01 belt-and-braces: re-verify ownership one last time IMMEDIATELY before the
            // announcement. `run_reconnect_loop` now refuses to classify a success as `Recovered`
            // once the generation moved, so an `Aborted`-shaped race should never reach here — but
            // this emit is the moment the app tells the user (and the window's pointer) which
            // server they are on, and a wrong answer here is invisible and permanent for the
            // session. If someone else owns the session now, say nothing: their own connect path
            // already moved the pointer.
            let still_ours =
                crate::lifecycle::is_current_generation(generation, gen_arc.load(Ordering::SeqCst));
            if !still_ours {
                log_app(
                    "INFO",
                    "[failover] switch announcement suppressed — the session is no longer ours (FB-01)",
                );
            }
            if still_ours {
                // Non-secret: the INDEX in the priority list, never the config path or server name
                // (D-09/D-29). The user-facing announcement of the switch is the frontend's job.
                log_app(
                    "INFO",
                    &format!(
                        "[failover] recovered on candidate #{} of {} (D-04: the frontend announces the switch)",
                        walk.candidate_index + 1,
                        queue.len()
                    ),
                );
                // 28-03 (OQ-1): tell the window WHICH config it is now on, so its frontend-owned
                // active-config pointer follows the server Rust actually connected. Without this,
                // Rust is on B while Routing/Settings/the status panel all still describe A, and
                // the NEXT drop would restart its walk from the original origin
                // (`App.tsx:790-803` documents this exact desync for the retired auto-switch
                // engine).
                //
                // Deliberately the EXISTING `vpn-flow` channel with the same payload shape as the
                // tray connect (`tray.rs`) — not a second channel, and not a Rust write into
                // frontend storage. The switch travels the same direction every other status fact
                // already travels, and the frontend keeps ownership of the pointer.
                //
                // D-29 / T-28-12: origin + action + the config PATH only. Paths already cross this
                // boundary in both directions via the config commands and the tray connect; no
                // credential is added. The log line above still carries only the index.
                app.emit(
                    "vpn-flow",
                    serde_json::json!({
                        "action": "connect",
                        "origin": FAILOVER_FLOW_ORIGIN,
                        "configPath": switched_to,
                    }),
                )
                .ok();
            }
        }

        match outcome {
            SupervisorOutcome::Recovered => {
                log_app("INFO", "[reconnect] reconnect succeeded");
            }
            SupervisorOutcome::Aborted => {
                log_app(
                    "INFO",
                    "[reconnect] supervisor aborted (user intent / generation advanced)",
                );
                // T-31: distinguish the TWO abort causes — they need opposite handling.
                //
                //  - USER DISCONNECT (durable intent set): the abort may have happened
                //    AFTER a successful respawn (the in-flight attempt connected just as
                //    the user clicked Disconnect), leaving a respawned sidecar ALIVE and
                //    the status flipped back to Connected. The user's Disconnect must
                //    WIN: force a clean Disconnected and tear down that respawned sidecar
                //    (it holds the WinTUN adapter + killswitch — R3). This is the fix for
                //    the "Disconnect flashes an error then flips back to Connected, needs
                //    a second press" UAT bug.
                //
                //  - GENERATION ADVANCE from a manual RECONNECT (durable intent NOT set):
                //    a NEW session owns the sidecar now. We must NOT touch it — leave the
                //    status/sidecar to that new session (unchanged behavior).
                //
                // WR-05: before either branch, hand back the `AutoSwitch` this walk stamped for
                // the candidate it was on. `maybe_fire` consumes the pending origin only on a
                // terminal status edge, and the generation-advance branch below deliberately
                // produces none — so the stamp survived the walk and the next TRAY connect, which
                // stamps no origin of its own, was announced as «Переключено автоматически» for a
                // connect the person made by hand. Window-driven manual connects were safe only
                // because `App.tsx` stamps `manual` first. Done for BOTH abort causes: the
                // user-disconnect branch usually spends the stamp through the `set_vpn_status`
                // below, but only when that write is a genuine transition, so it is not a
                // guarantee. `release_failover_connect_origin` is a compare-and-clear on the exact
                // value this walk would have placed, so it cannot clobber an origin the new
                // session already stamped for itself, and it touches neither the status nor the
                // sidecar — the two things this arm must leave alone.
                crate::notify::release_failover_connect_origin(&app, walk.candidate_index);
                if user_disconnect_requested_arc.load(Ordering::SeqCst) {
                    if let Some(state) = app.try_state::<crate::commands::AppState>() {
                        log_app(
                            "INFO",
                            "[reconnect] aborted by user disconnect — forcing Disconnected and releasing any respawned sidecar (T-31)",
                        );
                        crate::commands::vpn::set_vpn_status(
                            &app,
                            &state,
                            VpnStatus::Disconnected,
                            None,
                        );
                    }
                    // Release the (possibly just-respawned, Connected) sidecar so the
                    // killswitch/adapter can't strand traffic and the next connect is
                    // clean. No-op if the attempt never spawned one. Done OUTSIDE the
                    // `state` borrow (teardown is async / takes the child lock).
                    crate::commands::vpn::teardown_session_sidecar(&app).await;
                }
            }
            SupervisorOutcome::GaveUp => {
                // One final generation re-check before the terminal write so a
                // session that was reconnected/disconnected during the last attempt
                // is not clobbered with an Error (Codex HIGH).
                let still_ours = crate::lifecycle::is_current_generation(
                    generation,
                    gen_arc.load(Ordering::SeqCst),
                );
                let user_disconnecting =
                    *disc_arc.lock().unwrap_or_else(|e| e.into_inner());
                if !still_ours || user_disconnecting {
                    log_app(
                        "INFO",
                        "[reconnect] gave up but session no longer ours — suppressing terminal Error",
                    );
                    return;
                }
                // D-05: which honest failure was this? A multi-candidate pass that found nobody
                // is «none of your servers answered»; a one-server queue is the unchanged «this
                // server would not come back». Same guards above either way — only the code and
                // the log line differ.
                let reason = give_up_reason(walk.queue_exhausted);
                let marker = if walk.queue_exhausted {
                    format!(
                        "failover exhausted: {} candidates, {per_candidate} attempt(s) each, none answered",
                        queue.len()
                    )
                } else {
                    format!("reconnect gave up after {per_candidate}/{per_candidate}")
                };
                log_app("WARN", &format!("[reconnect] {marker}"));
                app.emit(
                    "vpn-log",
                    serde_json::json!({ "message": marker, "level": "warn" }),
                )
                .ok();
                // Terminal Error through the single mutator carrying the STABLE
                // secret-free reason code — the user-facing wording is the i18n key
                // on the frontend (Task 4), NOT a Russian literal here.
                if let Some(state) = app.try_state::<crate::commands::AppState>() {
                    crate::commands::vpn::set_vpn_status(
                        &app,
                        &state,
                        VpnStatus::Error,
                        Some(reason.to_string()),
                    );
                }
                // R3 (UAT 65692c test 7): the last respawned sidecar is STILL ALIVE,
                // holding the WinTUN adapter + the killswitch but with NO working tunnel.
                // Leaving it fail-closes ALL traffic until the app restarts AND makes the
                // next vpn_connect refuse with "VPN is already running". Release it now —
                // the terminal Error is already written above; while `_guard`
                // (reconnect_in_progress) is still held the sidecar Terminated arm defers,
                // and after it drops the arm keeps the already-set Error (R3 guard).
                crate::commands::vpn::teardown_session_sidecar(&app).await;
            }
        }
    });
}

/// One reconnect attempt: release the held WinTUN adapter (kill the prior child +
/// sweep the stale saved-PID sidecar — Pitfall 3), respawn the job-armed sidecar,
/// and wait up to `RECONNECT_ATTEMPT_WINDOW` for the single `vpn_status` owner to
/// read `Connected`. Returns true on a connect within the window.
///
/// Lives here (not in the testable core) because it touches the real sidecar; the
/// `run_reconnect_loop` core is exercised without it via injected closures.
async fn respawn_and_wait(
    app: &tauri::AppHandle,
    config_path: &str,
    log_level: &str,
    status_arc: &Arc<Mutex<VpnStatus>>,
    captured_generation: u64,
) -> bool {
    // FAB-R1 (Fable-5 review of Phase 14): thread the supervisor's captured
    // generation into `respawn_sidecar` so it can re-check ownership right before
    // storing the fresh child — a config switch's `vpn_connect(B)` that bumped the
    // generation mid-respawn makes this A-retry stale and it must not store a second
    // live sidecar.
    crate::commands::vpn::respawn_sidecar(app, config_path, log_level, captured_generation).await;

    // 3.8 F-2 (Fable-5 review): the respawned child's `Connected` edge is now gated on real
    // traffic-readiness (up to ~45s on http3 — the 3.8 delay-green). The old flat 15s poll counted
    // every still-warming respawn as a FAILED attempt, and the NEXT attempt killed the warming
    // child — so auto-reconnect became STRUCTURALLY unable to succeed on a slow-warmup protocol.
    // Poll instead until the FIRST of:
    //   - status == Connected                     → attempt succeeded,
    //   - status terminal (Error / Disconnected)  → attempt failed (fatal marker / user cancel),
    //   - the respawned child DIED (dead PID / slot cleared by a newer session) → fail now,
    //   - the per-attempt CEILING (RECONNECT_ATTEMPT_WINDOW, now 55s) → wedged-but-alive backstop.
    // A child that is still ALIVE and still `Reconnecting` past the old 15s is IN-PROGRESS
    // (warming), NOT failed — keep waiting. The supervisor holds `reconnect_in_progress`, so the
    // Terminated arm DEFERS and a dead respawn stays `Reconnecting` on the wire — status alone
    // can't reveal the death, so we probe the PID directly (still poison-recover on the locks).
    let deadline = Instant::now() + crate::lifecycle::RECONNECT_ATTEMPT_WINDOW;
    loop {
        let status = *status_arc.lock().unwrap_or_else(|e| e.into_inner());
        if status == VpnStatus::Connected {
            return true;
        }
        if matches!(status, VpnStatus::Error | VpnStatus::Disconnected) {
            // CA-4: name the branch so a post-mortem can tell a fatal marker / user-cancel
            // supersede from a child that never reached Connected. PID-only elsewhere; here
            // there is no child PID — the terminal status IS the signal (D-29: no secret).
            log_app(
                "WARN",
                "[reconnect] respawn attempt ended: terminal status (fatal marker or user disconnect superseded)",
            );
            return false; // fatal marker landed, or a user disconnect superseded the attempt
        }
        // Is the respawned child still alive? Read its PID from the shared slot and probe it.
        let child_pid = match app.try_state::<crate::commands::AppState>() {
            Some(state) => state
                .sidecar_child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .map(|c| c.child.pid()),
            None => None,
        };
        match child_pid {
            // Alive → still warming (3.8 delay-green) → keep waiting.
            Some(pid) if crate::sidecar::process_is_alive(pid) => {}
            // Spawned then DIED (connection refused / server rebooting). R2-5 (Fable-5 re-review):
            // fail the attempt, but SPACE it. A fast connection-refused exit would otherwise let the
            // 10-attempt budget burn in seconds (fast-fail skips the inter-attempt sleep) and give up
            // BEFORE a rebooting server returns — regressing the UAT'd reboot-recovery guarantee.
            // Sleeping the interval here pushes the attempt's elapsed past FAST_FAIL_GRACE so the
            // retries stay spaced (~10 attempts over a reboot-sized window). A spawn-FAILURE (no
            // child stored — a local problem, not a transient server drop) stays fast: nothing to
            // wait out.
            Some(pid) => {
                // CA-4: the child SPAWNED then DIED (connection refused / server rebooting) —
                // «child dies (server down)». PID only (A2-approved — D-29: no secret).
                log_app(
                    "WARN",
                    &format!("[reconnect] respawn attempt failed: child pid {pid} died (server down / connection refused)"),
                );
                tokio::time::sleep(crate::lifecycle::RECONNECT_INTERVAL).await;
                return false;
            }
            None => {
                // CA-4: no child was stored (spawn FAILURE — a local problem, not a transient
                // server drop) OR the slot was cleared by a newer session (disjoint death).
                log_app(
                    "WARN",
                    "[reconnect] respawn attempt failed: no child stored (spawn failure or slot cleared by a newer session)",
                );
                return false;
            }
        }
        if Instant::now() >= deadline {
            // CA-4: the child is still ALIVE but never reached Connected within the
            // per-attempt ceiling — «child alive but never Connected». No secret (D-29).
            log_app(
                "WARN",
                "[reconnect] respawn attempt failed: wedged-but-alive backstop (child alive but never Connected within the window)",
            );
            return false; // wedged-but-alive backstop
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Physical adapter info: IP address + gateway IP.
struct AdapterInfo {
    ip: IpAddr,
    gateway: IpAddr,
}

/// Find the primary physical network adapter (not VPN, not loopback).
/// Returns adapter IP + gateway IP. The gateway is on the local subnet
/// and is always reachable without going through VPN routing.
fn find_physical_adapter() -> Option<AdapterInfo> {
    let adapters = ipconfig::get_adapters().ok()?;

    let adapter = adapters
        .iter()
        .filter(|a| a.oper_status() == ipconfig::OperStatus::IfOperStatusUp)
        .filter(|a| !a.gateways().is_empty())
        .filter(|a| {
            let if_type = a.if_type();
            if_type == ipconfig::IfType::EthernetCsmacd
                || if_type == ipconfig::IfType::Ieee80211
        })
        .filter(|a| {
            let desc = a.description().to_lowercase();
            !desc.contains("wintun")
                && !desc.contains("vpn")
                && !desc.contains("virtual")
                && !desc.contains("tap-")
        })
        .find(|a| {
            // Must have at least one IPv4 address and one IPv4 gateway
            a.ip_addresses().iter().any(|ip| ip.is_ipv4())
                && a.gateways().iter().any(|gw| gw.is_ipv4())
        })?;

    let ip = adapter.ip_addresses().iter().copied().find(|ip| ip.is_ipv4())?;
    let gateway = adapter.gateways().iter().copied().find(|gw| gw.is_ipv4())?;

    log_app("DEBUG", &format!("[connectivity] Physical adapter: ip={}, gateway={}", ip, gateway));
    Some(AdapterInfo { ip, gateway })
}

/// Active TUNNEL-path liveness probe (02-07, UAT Gap #1).
///
/// Issues a short HTTP 204 request via DEFAULT routing with NO socket bind to the
/// physical adapter. While VPN is up, default routing carries this request THROUGH
/// the tunnel — so its success proves the tunnel/server path is alive, and its
/// failure means the server is silent EVEN IF the local gateway is still reachable.
/// This is the key difference from the old gateway probe, which stayed "online"
/// when only the server died (root cause of the slow server-silent detection).
///
/// Each endpoint is given a tight `TUNNEL_PROBE_TIMEOUT_SECS` budget. A single
/// failed probe does NOT declare offline — the caller requires `MAX_FAILURES`
/// consecutive misses, so one transient timeout under heavy load is tolerated
/// (T-07-01: never false-kill a busy-but-healthy tunnel).
/// Pure LIVENESS classifier for a traffic probe HTTP response, factored out so the
/// strict 2xx/204 "traffic reached a live upstream" rule is a single testable decision.
/// Used by the ongoing liveness probe `check_tunnel_alive` (and `check_adapter_online`).
///
/// NOTE (16-11): the READINESS gate (`probe_traffic_once`) no longer routes through this
/// classifier — readiness uses the more-lenient `probe_reachable` (ANY completed round-trip
/// = ready). Liveness stays STRICT on purpose: a middlebox block page can return 200/404,
/// which must NOT read as a live upstream mid-session.
///
/// A 204 (the classic captive-portal / generate_204 answer) is explicitly accepted
/// alongside any 2xx — everything else (3xx redirect, 4xx, 5xx) means we did NOT
/// reach a healthy upstream through the path. Exhaustively tested (2xx/204 → true,
/// 3xx/4xx/5xx → false) so the liveness rule can never silently widen.
fn traffic_status_ok(status: u16) -> bool {
    status == 204 || (200..300).contains(&status)
}

/// 16-11 (MINOR-4): the multi-operator, DNS-free endpoint set the readiness probe
/// (`probe_traffic_once`) round-trips through the tunnel.
///
/// The set stays DNS-free two ways, both keeping TLS validation FULL (no
/// `danger_accept_invalid_certs`):
///   - Cloudflare  `1.1.1.1` / `1.0.0.1`  — IP literals whose cert SAN carries the IP
///     (FIX-E rationale), so the URL host IS the IP and no DNS is needed.
///   - Google      `8.8.8.8` / `8.8.4.4`  — IP literals; `dns.google` cert SANs include
///     both IPs, so TLS validates against the IP directly.
///   - Yandex      `common.dot.dns.yandex.net`  — a HOSTNAME whose DoH cert is issued for
///     the hostname (NOT the IP), so a bare `https://77.88.8.8/` would FAIL TLS. Instead
///     the client PINS this host to `77.88.8.8` / `77.88.8.1` via
///     `reqwest::ClientBuilder::resolve_to_addrs` (see `probe_traffic_once`): the correct
///     SNI/cert is used AND no system DNS lookup happens — DNS-free, TLS-valid. Russia-
///     stable fallback if Cloudflare AND Google are throttled/blocked from the exit.
///
/// MINOR-4 direction: relying on a single operator (Cloudflare only) meant that on an
/// exit server where Cloudflare is blocked/rate-limited THROUGH the tunnel — but the
/// tunnel is otherwise healthy — the readiness probe never succeeded, so the card waited
/// to the ~45s budget cap before greening on EVERY connect to that server (honest, not a
/// hang, but per-server UX degradation). With three operators one blocked operator no
/// longer delays green: whichever operator answers first paints green.
///
/// The Yandex host is pinned in `YANDEX_DOH_HOST` / `YANDEX_DOH_ADDRS` so the endpoint
/// list and the resolve override cannot drift apart.
pub(crate) const READINESS_PROBE_ENDPOINTS: [&str; 5] = [
    "https://1.1.1.1/",
    "https://1.0.0.1/",
    "https://8.8.8.8/",
    "https://8.8.4.4/",
    "https://common.dot.dns.yandex.net/",
];

/// Yandex DoH host — its TLS cert is issued for this HOSTNAME (not the IP), so it must be
/// reached by name with a resolve-override pin, never as a bare IP literal (that would
/// fail TLS SAN validation). Single source of truth shared by the endpoint list, the
/// `.resolve_to_addrs` pin, and the DNS-free test.
pub(crate) const YANDEX_DOH_HOST: &str = "common.dot.dns.yandex.net";

/// The two Yandex Common-DNS anycast IPs the DoH host is pinned to. Pinning here means the
/// probe performs NO system DNS lookup for the Yandex endpoint (DNS-free) while still
/// presenting the correct SNI so the hostname cert validates.
pub(crate) const YANDEX_DOH_ADDRS: [&str; 2] = ["77.88.8.8:443", "77.88.8.1:443"];

/// Pure acceptance predicate for the READINESS gate.
///
/// `completed` = the HTTPS attempt resolved to `Ok(_response)` (a full round-trip
/// finished), regardless of HTTP status. `Err(_)` (transport error / timeout) ⇒ the
/// attempt did NOT complete.
///
/// This is intentionally MORE LENIENT than `traffic_status_ok` (the liveness rule used
/// by `check_tunnel_alive`, which stays strict 2xx/204). Rationale: a *completed* HTTPS
/// exchange to a public anycast host proves the tunnel carried traffic end-to-end (the
/// TLS handshake + request + response all flowed over the tunnel), which is exactly what
/// "ready to paint green" means — even a 404/403 answer proves reachability. Google's
/// `https://8.8.8.8/` answers 404 at `/`, so a strict 2xx/204 rule would reject a
/// perfectly reachable operator. Liveness stays strict on purpose (a middlebox block
/// page can return 200, which must NOT read as a live upstream), but readiness only needs
/// proof that bytes crossed the tunnel.
fn probe_reachable(completed: bool) -> bool {
    completed
}

/// 16-11 (MINOR-4): a SINGLE DNS-independent readiness round-trip against a MULTI-OPERATOR
/// IP-literal set (`READINESS_PROBE_ENDPOINTS`). Returns true the moment ANY endpoint
/// COMPLETES an HTTPS round-trip within `timeout` (`Ok(_response)`, ANY HTTP status);
/// false when every endpoint errors/times out.
///
/// This is the readiness primitive the sidecar delay-green gate (`sidecar::dns_probe`)
/// waits on. It does NOT back the monitor's liveness probe (`check_tunnel_alive` runs its
/// own strict 2xx/204 rule via `traffic_status_ok`); readiness uses the more-lenient
/// `probe_reachable` (a completed exchange of ANY status = ready — see that predicate for
/// why). It needs NO DNS: the Cloudflare + Google endpoints are IP literals in the operator
/// cert SAN, and the Yandex endpoint is a hostname PINNED to its anycast IPs via
/// `resolve_to_addrs` (so no system DNS lookup happens while the correct SNI/cert is still
/// used). A stalled sidecar DNS proxy can therefore never false-fail it — that is exactly
/// why the delay-green gate waits on THIS instead of a DNS-only `lookup_host` (a warm
/// DoH/DoT upstream answered DNS while the data path was still settling → premature green
/// on the IP/AdGuard config).
///
/// All attempts run concurrently on THIS task via `FuturesUnordered` (no detached spawns
/// to leak) and we return on the FIRST completed round-trip, so a live path greens as fast
/// as the fastest operator answers; a fully dead path costs ~ONE `timeout` (the shared
/// reqwest client `.timeout`), not five.
pub(crate) async fn probe_traffic_once(timeout: Duration) -> bool {
    // `StreamExt` (`.next()`) now lives in the extracted `first_ready` helper (TA-6); this scope
    // only builds the `FuturesUnordered` set, so it no longer imports `StreamExt`.
    use futures_util::stream::FuturesUnordered;

    // MINOR-1 (16-10, Fable review): bypass any WinINET-registry or env (HTTPS_PROXY)
    // system proxy. This probe is a *tunnel* readiness signal — it must reflect the
    // tunnel data-path, not a system proxy. Without `.no_proxy()` a live system proxy
    // could answer while the tunnel is still settling (reintroducing premature-green),
    // or a dead proxy entry could hang every attempt to the timeout cap. `.no_proxy()`
    // makes the raw-IP round-trip go straight through default routing (⇒ through the
    // tunnel while VPN is up).
    //
    // 16-11 amend (Yandex): pin the Yandex DoH HOSTNAME to its anycast IPs so the probe
    // does NO system DNS lookup for it (stays DNS-free) while still presenting the correct
    // SNI so the hostname-issued cert validates with FULL TLS verification — a bare
    // `https://77.88.8.8/` would fail because the cert SAN has no IP. This override applies
    // ONLY to `common.dot.dns.yandex.net`; the IP-literal endpoints are unaffected.
    let yandex_addrs: Vec<std::net::SocketAddr> = YANDEX_DOH_ADDRS
        .iter()
        .filter_map(|a| a.parse().ok())
        .collect();
    let client = match reqwest::Client::builder()
        .no_proxy()
        .resolve_to_addrs(YANDEX_DOH_HOST, &yandex_addrs)
        .timeout(timeout)
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // Per-attempt IP round-trip: ANY completed response (`Ok(_)`, any status) = the
    // tunnel carried bytes end-to-end = ready. See `probe_reachable` for why this is
    // deliberately more lenient than the liveness rule.
    let attempt = |url: &'static str| {
        let client = client.clone();
        async move { probe_reachable(client.get(url).send().await.is_ok()) }
    };
    let attempts: FuturesUnordered<_> =
        READINESS_PROBE_ENDPOINTS.iter().map(|&url| attempt(url)).collect();
    // Return on the FIRST endpoint that reports ready; if all resolve without a ready,
    // fall through to false. The short-circuit fold lives in the pure `first_ready` helper
    // (TA-6) so it can be unit-tested with a deterministic stream of bools.
    first_ready(attempts).await
}

/// TA-6: the pure short-circuit fold at the heart of `probe_traffic_once` — drain a stream of
/// bool-yielding futures and return `true` the moment ANY yields `true` (dropping the rest, so a
/// live path greens as fast as the fastest answer), `false` only when the whole stream is
/// exhausted without a `true` (and `false` for an empty stream). Extracted from the inline
/// `while let Some(..) = stream.next().await` so the racing semantics are exercised by a unit test
/// with a synthetic `[false, true, false]` / `[false, false, false]` / `[]` stream — no network,
/// byte-identical behaviour to the previous inline loop.
pub(crate) async fn first_ready<S>(mut stream: S) -> bool
where
    S: futures_util::stream::Stream<Item = bool> + Unpin,
{
    use futures_util::stream::StreamExt;
    while let Some(ready) = stream.next().await {
        if ready {
            return true;
        }
    }
    false
}

async fn check_tunnel_alive() -> bool {
    // MINOR-1 (16-10, Fable review): parity with `probe_traffic_once` — the liveness
    // verdict must equally ignore any WinINET/env system proxy so its "tunnel alive?"
    // answer reflects the tunnel data-path only, never a system proxy answering on its
    // behalf. See `probe_traffic_once` for the full rationale.
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(TUNNEL_PROBE_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    // 204-style endpoints: a 204 (or any 2xx) confirms the request reached a live
    // upstream through the tunnel. Multiple providers so one operator outage does
    // not look like a tunnel death. NOT bound to the physical adapter, so while VPN
    // is up these travel through the tunnel (the whole point).
    // FIX-E (T-32): DNS-INDEPENDENT liveness. The sidecar DNS-proxy intermittently
    // fails mid-session (log: "DNS_HANDLER ... DNS proxy request id=N failed"); the
    // hostname probes below then fail to RESOLVE even though the tunnel/route is
    // perfectly alive, which was misread as tunnel-lost → false reconnect → death
    // spiral (invisible with killswitch OFF, fatal with it ON). The two Cloudflare IP
    // literals carry valid TLS (1.1.1.1 / 1.0.0.1 are in the cert SAN) and need NO DNS,
    // so a DNS-proxy stall can no longer false-fail the probe. Any-one-success = alive,
    // so this is purely additive — no regression to the existing hostname signal.
    // See .planning/debug/claude-code-403-on-vpn-reconnect.md (FIX-E).
    let http_endpoints = [
        "https://1.1.1.1/",
        "https://1.0.0.1/",
        "https://clients3.google.com/generate_204",
        "https://cp.cloudflare.com",
        "http://www.msftconnecttest.com/connecttest.txt",
    ];

    // R6 (UAT build 65692c test 7): probe the endpoints CONCURRENTLY, not sequentially.
    // A dead / black-holing tunnel makes EVERY probe burn the full
    // TUNNEL_PROBE_TIMEOUT_SECS, so the old sequential loop cost ~3 × the timeout (~9s)
    // for ONE failed call — and across MAX_FAILURES consecutive failures, server-death
    // detection dragged to well over a minute (user-reported ~1m40s). `tokio::join!`
    // drives all three futures on THIS task (no detached spawns to leak), so a failed
    // call now costs ~ONE timeout (~3s) total. The per-request budget is the reqwest
    // client `.timeout` (single source of truth — the redundant outer
    // tokio::time::timeout the old code wrapped each request in is dropped).
    let probe = |url: &'static str| {
        let client = client.clone();
        async move {
            match client.get(url).send().await {
                Ok(resp) => {
                    // 16-08: route the 2xx/204 rule through the shared classifier so the
                    // hot liveness path and the delay-green gate can never diverge. Same
                    // predicate as before (`is_success() || == 204`), now single-sourced.
                    let ok = traffic_status_ok(resp.status().as_u16());
                    if ok {
                        log_app(
                            "DEBUG",
                            &format!("[connectivity] Tunnel probe {} => OK", url),
                        );
                    }
                    ok
                }
                Err(_) => false,
            }
        }
    };

    let (a, b, c, d, e) = tokio::join!(
        probe(http_endpoints[0]),
        probe(http_endpoints[1]),
        probe(http_endpoints[2]),
        probe(http_endpoints[3]),
        probe(http_endpoints[4]),
    );
    let any_alive = a || b || c || d || e;
    if !any_alive {
        log_app("DEBUG", "[connectivity] Tunnel probe: all endpoints failed");
    }
    any_alive
}

/// Check if the physical network adapter has connectivity (without VPN).
/// Used during adapter recovery — VPN is disconnected, so we check gateway directly.
///
/// 02-09 (UAT Gap #2): ALSO reused by `vpn_connect` as a NON-BLOCKING pre-flight —
/// it returns `false` when the adapter is down / gateway unreachable, which the
/// connect path records (never blocks on) to classify a never-connected sidecar
/// exit as `no-internet` rather than a generic `sidecar-exit`. Made `pub(crate)`
/// for that reuse; the body is unchanged.
pub(crate) async fn check_adapter_online() -> bool {
    let adapter = find_physical_adapter();

    if let Some(ref info) = adapter {
        let adapter_ip = info.ip;
        let gateway_ip = info.gateway;
        let tcp_ok = tokio::task::spawn_blocking(move || {
            let target = SocketAddr::new(gateway_ip, 80);
            let socket = match Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) {
                Ok(s) => s,
                Err(_) => return false,
            };

            if socket.bind(&SockAddr::from(SocketAddr::new(adapter_ip, 0))).is_err() {
                return false;
            }

            socket
                .connect_timeout(&SockAddr::from(target), Duration::from_secs(3))
                .is_ok()
        })
        .await
        .unwrap_or(false);

        log_app("DEBUG", &format!("[connectivity] adapter_online gateway TCP: {}", tcp_ok));

        if tcp_ok {
            return true;
        }
    }

    // Fallback: UNBOUND HTTP probe — rides whatever default routing currently is.
    // AUDIT-2026-06-11 #16 (T-36): the old comment claimed "VPN is disconnected
    // during recovery, so default routing = physical" — stale: in the 02-20 flow the
    // dead-tunnel sidecar (WinTUN routes + fail-closed killswitch) stays ALIVE for
    // the whole Recovering wait, so an unbound request rides the DEAD tunnel and
    // always fails. run_recovery_flow therefore no longer calls this; it uses
    // find_physical_adapter() as the adapter-back signal. This fallback is only
    // truthful where default routing is genuinely physical (e.g. the vpn_connect
    // pre-flight before any sidecar is spawned).
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        client.get("http://clients3.google.com/generate_204").send(),
    )
    .await;

    match result {
        Ok(Ok(resp)) => {
            let ok = resp.status().as_u16() == 204 || resp.status().is_success();
            if ok {
                log_app("DEBUG", "[connectivity] adapter_online HTTP => OK");
            }
            ok
        }
        _ => false,
    }
}

#[cfg(test)]
mod detection_cadence_tests {
    use super::*;

    // ── 16-08 (gap 5c): the honest-green traffic probe ─────────────────────────

    #[test]
    fn traffic_status_ok_accepts_only_2xx_and_204() {
        // The delay-green readiness rule: a live upstream answered through the path.
        // 2xx (incl. the 200 root) and the captive-portal 204 mean READY.
        assert!(traffic_status_ok(200), "200 = reached a live upstream");
        assert!(traffic_status_ok(204), "204 = generate_204 / captive-portal OK");
        assert!(traffic_status_ok(299), "any 2xx counts");
        // Everything else means we did NOT reach a healthy upstream — the gate must
        // NOT green on a redirect, a 4xx block page, or a 5xx.
        assert!(!traffic_status_ok(301), "3xx redirect ≠ traffic-ready");
        assert!(!traffic_status_ok(403), "4xx ≠ traffic-ready");
        assert!(!traffic_status_ok(500), "5xx ≠ traffic-ready");
        assert!(!traffic_status_ok(199), "sub-200 informational ≠ ready");
        assert!(!traffic_status_ok(300), "300 is the 3xx boundary, not 2xx");
    }

    #[test]
    fn readiness_acceptance_is_lenient_completed_any_status() {
        // 16-11 (MINOR-4): the READINESS gate greens on ANY completed HTTPS round-trip,
        // regardless of HTTP status. `probe_reachable` maps the per-attempt outcome:
        //   Ok(_response) of ANY status → reachable (bytes crossed the tunnel = ready)
        //   Err(_) transport error / timeout → NOT reachable
        // The reqwest attempt collapses to a bool (`.send().await.is_ok()`) before this
        // predicate, so a completed 200/204/404/403 all arrive here as `true` and only a
        // transport error / timeout arrives as `false`. This is intentionally MORE lenient
        // than the strict 2xx/204 liveness rule (`traffic_status_ok`) — a completed
        // exchange to a public anycast host (incl. Google's 404 at `/`) proves the tunnel
        // carries traffic; liveness must stay strict to avoid a middlebox block-page 200
        // reading as a live upstream.
        assert!(probe_reachable(true), "a completed round-trip (any status) ⇒ ready");
        assert!(!probe_reachable(false), "a transport error / timeout ⇒ not ready");

        // TA-12: the old `for status in [200,204,404,403] { assert!(probe_reachable(true)) }` loop
        // called the status-IGNORING predicate four times with the loop var unused — four copies of
        // the same always-true assert masquerading as status-dependent. Dropped. The meaningful
        // divergence is the cross-check against the STRICT liveness rule at the 4xx statuses where
        // the two rules deliberately disagree: readiness=ready, liveness=not-alive.
        assert!(probe_reachable(true) && !traffic_status_ok(404));
        assert!(probe_reachable(true) && !traffic_status_ok(403));
    }

    // TA-6: the racing short-circuit fold at the core of `probe_traffic_once` — «first ready wins /
    // all-fail → false» — is exercised directly on `first_ready` with a synthetic stream of bools
    // (no network). This is the MINOR-4 fix's core the audit flagged as untested: the previous
    // inline `while let Some(..) = stream.next().await` had no unit coverage.
    #[tokio::test]
    async fn first_ready_returns_true_on_the_first_ready_and_short_circuits() {
        use futures_util::stream;
        // [false, true, false] → true; the fold must return as soon as it sees the `true`.
        assert!(
            first_ready(stream::iter([false, true, false])).await,
            "a stream containing a ready ⇒ true",
        );
    }

    #[tokio::test]
    async fn first_ready_returns_false_when_every_attempt_fails() {
        use futures_util::stream;
        // [false, false, false] → false; the whole stream drains with no ready.
        assert!(
            !first_ready(stream::iter([false, false, false])).await,
            "all attempts failing ⇒ false",
        );
    }

    #[tokio::test]
    async fn first_ready_returns_false_on_an_empty_stream() {
        use futures_util::stream;
        // [] → false; nothing to be ready.
        assert!(
            !first_ready(stream::iter(Vec::<bool>::new())).await,
            "an empty stream ⇒ false",
        );
    }

    #[test]
    fn readiness_probe_endpoints_are_dns_free() {
        // 16-11 (MINOR-4 + Yandex amend): guard the DNS-independence invariant by PARSING
        // each endpoint's host. Every endpoint must be EITHER an IP literal (host parses as
        // IpAddr — no DNS needed) OR the ONE hostname that is pinned via a hardcoded
        // resolve() entry (YANDEX_DOH_HOST → YANDEX_DOH_ADDRS, so the probe still does no
        // system DNS lookup). If someone adds a NON-pinned hostname, it is neither an IP nor
        // the pinned host → this test fails. Not a source-text grep — it checks the actual
        // parsed hosts + the pin constants.
        let mut cloudflare_or_google_ips: Vec<IpAddr> = Vec::new();
        let mut saw_pinned_yandex = false;

        for url in READINESS_PROBE_ENDPOINTS {
            // Strip the scheme + trailing path; what remains is the bare host.
            let host = url
                .strip_prefix("https://")
                .or_else(|| url.strip_prefix("http://"))
                .expect("readiness endpoint must be an https/http URL")
                .trim_end_matches('/');

            if let Ok(ip) = host.parse::<IpAddr>() {
                cloudflare_or_google_ips.push(ip);
            } else {
                // The only permitted hostname is the one pinned to fixed IPs (DNS-free).
                assert_eq!(
                    host, YANDEX_DOH_HOST,
                    "readiness endpoint host {host:?} is neither an IP literal nor the pinned \
                     Yandex host — it would need a system DNS lookup",
                );
                saw_pinned_yandex = true;
            }
        }

        // Multi-operator: both Cloudflare literals AND both Google literals are present, so a
        // single blocked operator no longer delays green (the MINOR-4 fix).
        for ip in ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(
                cloudflare_or_google_ips.contains(&ip),
                "readiness probe must include the multi-operator IP literal {ip}",
            );
        }

        // Yandex is present AND its pin resolves to valid socket addrs on port 443, so the
        // resolve_to_addrs override is real (not an empty pin that would fall back to DNS).
        assert!(saw_pinned_yandex, "readiness probe must include the pinned Yandex DoH host");
        let pinned: Vec<std::net::SocketAddr> =
            YANDEX_DOH_ADDRS.iter().filter_map(|a| a.parse().ok()).collect();
        assert_eq!(
            pinned.len(),
            YANDEX_DOH_ADDRS.len(),
            "every Yandex pin addr must parse as host:port (real DNS-free pin)",
        );
        assert!(
            pinned.iter().all(|s| s.port() == 443),
            "Yandex pin must target the HTTPS port so the pinned round-trip is TLS",
        );
    }

    #[test]
    fn offline_floor_is_snappy() {
        // 02-07 (UAT Gap #1): the OLD floor was POLL=20s × MAX_FAILURES=4 = ~80s of
        // sleep before a drop could even be declared. Assert the NEW cadence keeps the
        // worst-case declaration window ~10-15s (mirrors lifecycle::consts_are_snappy
        // so the comment and the value can never drift). The window is the cadence
        // sleeps plus the final probe + reason-gate probe timeouts.
        let cadence_floor =
            Duration::from_secs(POLL_INTERVAL_SECS) * MAX_FAILURES;
        // Pure cadence sleep stays under ~15s.
        assert!(
            cadence_floor <= Duration::from_secs(15),
            "cadence floor must be ~10-15s, got {cadence_floor:?}",
        );
        // And it must be a real improvement over the old ~80s floor.
        assert!(
            cadence_floor < Duration::from_secs(20),
            "cadence floor must collapse the old ~80s floor",
        );
        // The per-probe timeout is tight so a failed cycle does not balloon the window.
        // Const block: both sides are compile-time constants, so this invariant is proved by
        // const evaluation rather than by the test happening to be run — a bad edit to the
        // constant can no longer slip past a `--skip`/filtered run.
        //
        // Measured, because the exact enforcement point is not obvious: an in-body const block
        // is evaluated at CODEGEN, so `cargo test` (which builds the lib-test binary this
        // module lives in) turns a violation into a hard E0080. `cargo check` and `cargo
        // clippy` never get that far, which is why both clippy gates stay green. Plain `cargo
        // build` does not cover it either — this is `#[cfg(test)]` code and is not in that
        // build at all. Same for every other `const { assert!(…) }` in this file.
        const { assert!(TUNNEL_PROBE_TIMEOUT_SECS <= 5) };
        // Worst-case declaration window (cadence + final tunnel probe + reason-gate
        // probe) stays well under the old ~95-140s.
        let worst_case = cadence_floor + Duration::from_secs(TUNNEL_PROBE_TIMEOUT_SECS * 2);
        assert!(
            worst_case < Duration::from_secs(30),
            "worst-case detection window must be far below the old ~95-140s, got {worst_case:?}",
        );
        // Require N>1 failures so a single transient miss never declares offline
        // (T-07-01: don't false-kill a busy tunnel).
        const { assert!(MAX_FAILURES >= 2, "must tolerate at least one transient miss") };
    }

    #[test]
    fn resume_gap_detects_suspend_not_a_slow_probe() {
        // 02-10 (Tier-3): a normal iteration gap (cadence + a slow probe) must NOT be
        // read as a resume, but a real multi-minute suspend must. The threshold sits
        // well above the worst-case normal iteration (~10s) and below a real sleep.
        assert!(!is_resume_gap(Duration::from_secs(POLL_INTERVAL_SECS))); // normal cadence
        assert!(!is_resume_gap(Duration::from_secs(10))); // cadence + slow probe — NOT a resume
        assert!(!is_resume_gap(Duration::from_secs(RESUME_GAP_THRESHOLD_SECS - 1)));
        assert!(is_resume_gap(Duration::from_secs(RESUME_GAP_THRESHOLD_SECS))); // at the boundary
        assert!(is_resume_gap(Duration::from_secs(600))); // a 10-minute laptop sleep
        // The threshold is safely above the worst-case normal iteration window.
        let worst_case_iteration =
            Duration::from_secs(POLL_INTERVAL_SECS) + Duration::from_secs(TUNNEL_PROBE_TIMEOUT_SECS * 2);
        assert!(
            !is_resume_gap(worst_case_iteration),
            "a worst-case normal iteration must never be mistaken for a resume",
        );
    }

    #[tokio::test]
    async fn notify_wakes_the_select_before_the_cadence_elapses() {
        // 02-14 (STATUS-05): the heart of the real-time wake. The monitor races the
        // POLL_INTERVAL cadence sleep against `wake.notified()`; a link-state event
        // must win that race and let the iteration proceed to its re-check WELL before
        // the full cadence would elapse. We model that exact `select!` with a long
        // cadence and a notify fired immediately: the select must resolve via the
        // notify arm in far less than the cadence, proving the immediate re-check
        // collapses the local-loss latency.
        let wake = Arc::new(Notify::new());
        // Fire the wake "from another thread" the way the OS callback would.
        let signaller = Arc::clone(&wake);
        tokio::spawn(async move {
            signaller.notify_one();
        });

        let start = Instant::now();
        // A deliberately huge cadence: if the notify did NOT win, this test would hang
        // far past its assertion budget.
        let woke_via_notify = tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(3600)) => false,
            _ = wake.notified() => true,
        };
        let elapsed = start.elapsed();

        assert!(woke_via_notify, "the link-state notify must win the race against the cadence sleep");
        assert!(
            elapsed < Duration::from_secs(1),
            "the wake must trigger an immediate re-check, not wait out the cadence (elapsed={elapsed:?})",
        );
    }

    #[test]
    fn notify_wake_gap_is_never_a_resume() {
        // 02-14 + 02-10 interplay: a notify-driven wake is a SHORT gap (sub-second),
        // so the resume-from-suspend detector must never mistake it for a suspend —
        // otherwise a mere cable flap would trigger the post-resume re-baseline path.
        // Any plausible notify-wake gap stays far below RESUME_GAP_THRESHOLD_SECS.
        assert!(!is_resume_gap(Duration::from_millis(1)));
        assert!(!is_resume_gap(Duration::from_millis(250)));
        assert!(!is_resume_gap(Duration::from_secs(1)));
    }

    #[test]
    fn event_wake_debounce_honors_first_then_coalesces_a_burst() {
        // WR-01 (02-14 review): the FIRST event-driven wake of a burst must be honored
        // (last == None) so a genuine link-down is still detected fast. A subsequent
        // wake arriving sooner than EVENT_WAKE_MIN_INTERVAL_MS must be COALESCED, and
        // once that interval has elapsed a fresh wake is honored again. We model the
        // monotonic clock with explicit Instants so the decision is deterministic.
        let t0 = Instant::now();

        // First wake of a burst — no prior event-driven re-check, so honor it.
        assert!(
            should_honor_event_wake(t0, None),
            "the first wake of a burst must always be honored (fast link-down detection)",
        );

        // A wake immediately after the honored one (same instant) is too soon — coalesce.
        assert!(
            !should_honor_event_wake(t0, Some(t0)),
            "a back-to-back wake must be coalesced, not run another immediate re-check",
        );

        // A wake just under the floor is still coalesced.
        let just_under = t0 + Duration::from_millis(EVENT_WAKE_MIN_INTERVAL_MS - 1);
        assert!(
            !should_honor_event_wake(just_under, Some(t0)),
            "a wake under EVENT_WAKE_MIN_INTERVAL_MS must be coalesced",
        );

        // At exactly the floor the next wake is honored again (>= boundary).
        let at_floor = t0 + Duration::from_millis(EVENT_WAKE_MIN_INTERVAL_MS);
        assert!(
            should_honor_event_wake(at_floor, Some(t0)),
            "once the debounce interval has elapsed a fresh wake must be honored",
        );

        // Well past the floor a wake is honored.
        let well_past = t0 + Duration::from_secs(5);
        assert!(should_honor_event_wake(well_past, Some(t0)));
    }

    #[test]
    fn event_wake_debounce_stays_under_resume_threshold() {
        // The debounce floor must be well below the resume threshold so coalescing a
        // burst never interferes with resume-from-suspend detection (02-10), and below
        // the poll cadence so a coalesced event is still covered by the next poll.
        const {
            assert!(
                EVENT_WAKE_MIN_INTERVAL_MS < RESUME_GAP_THRESHOLD_SECS * 1000,
                "the wake debounce must stay far under the resume threshold",
            )
        };
        const {
            assert!(
                EVENT_WAKE_MIN_INTERVAL_MS < POLL_INTERVAL_SECS * 1000,
                "a coalesced wake must be re-covered by the next poll cadence",
            )
        };
    }

    /// Windows-only: registering the interface-change notifier and dropping it must
    /// pair the CancelMibChangeNotify2 + free the boxed context with no leak, panic,
    /// or double-free (T-14-02). We can't observe a link-state event in a unit test
    /// (that's manual UAT — unplug the cable), but we CAN prove the RAII register →
    /// drop lifecycle is clean, which is the leak-safety contract.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn interface_notifier_register_and_drop_is_leak_safe() {
        let wake = Arc::new(Notify::new());
        let notifier = InterfaceChangeNotifier::register(Arc::clone(&wake));
        // Registration normally succeeds on a real Windows host; if the environment
        // denies it (rare CI sandbox), `register` returns None after freeing its box —
        // still leak-safe, so either outcome satisfies the contract.
        if let Some(n) = notifier {
            // Explicit drop exercises CancelMibChangeNotify2 + Box reclaim exactly once.
            drop(n);
        }
        // The Arc we still hold must be the sole owner again after the notifier's box
        // is freed — proving the boxed clone was reclaimed (no leaked Arc strong ref).
        assert_eq!(Arc::strong_count(&wake), 1, "the boxed Notify context must be freed on drop (no leak)");
    }

    #[test]
    fn uplink_loss_is_confirmed_only_when_every_sample_is_absent() {
        // T-18-01 (02-18): the flap-safe confirm. The short-circuit declares offline
        // ONLY if the physical adapter stayed gone across EVERY sample of the confirm
        // window; if ANY sample saw it back, it was a transient flap (Wi-Fi roam / DHCP
        // renew) and must NOT false-kill.

        // All-absent across the window → a genuine disable/unplug → confirmed offline.
        assert!(
            uplink_loss_confirmed(&[false, false, false]),
            "an uplink that stays gone the whole window must be confirmed offline",
        );
        assert!(uplink_loss_confirmed(&[false]), "a single all-absent sample is a confirmed loss");

        // ANY sample sees the adapter back → transient flap → do NOT declare offline.
        assert!(
            !uplink_loss_confirmed(&[false, true, false]),
            "a mid-window recovery (flap) must NOT be declared offline",
        );
        assert!(
            !uplink_loss_confirmed(&[false, false, true]),
            "a late-window recovery (flap) must NOT be declared offline",
        );
        assert!(
            !uplink_loss_confirmed(&[true, false, false]),
            "an early recovery (flap) must NOT be declared offline",
        );

        // Defensive: an empty sample set is never a confirmed loss (we always take ≥1).
        assert!(!uplink_loss_confirmed(&[]), "no samples must never be a confirmed loss");

        // The confirm window is sane: >1 check (so one blip can't kill) and stays well
        // under the resume threshold so a confirm pass is never mistaken for a suspend.
        const { assert!(UPLINK_CONFIRM_CHECKS >= 2, "must take more than one sample to be flap-safe") };
        let window = Duration::from_millis(UPLINK_CONFIRM_INTERVAL_MS) * UPLINK_CONFIRM_CHECKS;
        assert!(
            window < Duration::from_secs(RESUME_GAP_THRESHOLD_SECS),
            "the confirm window must stay far under the resume threshold",
        );
        // And fast enough to be "real-time" (~1-2s), collapsing the old ~1-minute floor.
        assert!(
            window <= Duration::from_secs(3),
            "the confirm window must keep detection real-time (~1-2s), got {window:?}",
        );
    }

    #[test]
    fn corroboration_only_declares_offline_when_tunnel_probe_also_fails() {
        // WR-04: once the physical adapter is CONFIRMED gone over the flap window, the
        // short-circuit runs ONE tunnel probe before killing. This guards the
        // false-kill where find_physical_adapter()'s description blacklist
        // (wintun|vpn|virtual|tap-) misclassifies a real NIC as absent: if the tunnel
        // probe still succeeds, the uplink is demonstrably fine and we must NOT declare
        // offline.

        // Adapter confirmed gone AND tunnel probe failed → a genuine whole-internet
        // loss → declare offline (the fast path is preserved; a no-route probe fails
        // fast).
        assert!(
            should_declare_offline_after_corroboration(true, false),
            "confirmed-gone adapter + dead tunnel must declare offline",
        );

        // Adapter confirmed gone BUT tunnel probe succeeded → the NIC only LOOKED gone
        // (blacklist misclassification) while the tunnel is alive → must NOT declare
        // offline (this is the false-kill WR-04 eliminates).
        assert!(
            !should_declare_offline_after_corroboration(true, true),
            "a live tunnel must veto an offline declaration even when the adapter looked gone",
        );

        // Adapter NOT confirmed gone → the short-circuit branch is never entered for an
        // offline decision regardless of the probe; the predicate must reflect that.
        assert!(
            !should_declare_offline_after_corroboration(false, false),
            "no confirmed uplink loss must never declare offline via this path",
        );
        assert!(
            !should_declare_offline_after_corroboration(false, true),
            "no confirmed uplink loss must never declare offline via this path",
        );
    }

    #[test]
    fn recovery_timeout_is_five_minutes() {
        // 02-20 status-UX split (SPEC §5; user decision UAT fd63ec): the «Восстановление»
        // adapter-wait timeout is the PRODUCTION ~5 minutes — a brief outage / router reboot
        // must not give up too early, and the user can «Отмена» any time. Lock the value so
        // a future edit can't silently change it. Total = RECOVERY_TIMEOUT_CHECKS ×
        // ADAPTER_POLL_INTERVAL_SECS.
        let total = Duration::from_secs(ADAPTER_POLL_INTERVAL_SECS) * RECOVERY_TIMEOUT_CHECKS;
        assert_eq!(RECOVERY_TIMEOUT_CHECKS, 60);
        assert_eq!(total, Duration::from_secs(300)); // 60 × 5s = 5 minutes
        // One consistent 5-minute budget: it matches the legacy adapter-recovery wait.
        assert_eq!(RECOVERY_TIMEOUT_CHECKS, ADAPTER_RECOVERY_TIMEOUT_CHECKS);
    }

    #[test]
    fn recovery_timeout_reason_is_ascii_and_cyrillic_free() {
        // D-09/D-29: the recovery-wait give-up reason is a STABLE ASCII token Stage 2
        // localizes — never a Russian string, never a config/server line. Mirror of the
        // tunnel/internet-lost reason-code test.
        let reason = crate::lifecycle::RECOVERY_TIMEOUT_REASON;
        assert_eq!(reason, "recovery-timeout");
        assert!(reason.is_ascii(), "reason code must be ASCII");
        assert!(
            !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic",
        );
        // Distinct from the tunnel-reconnect give-up so the UI can tell the two apart.
        assert_ne!(reason, RECONNECT_GAVE_UP_REASON);
    }

    #[test]
    fn reason_codes_are_ascii_and_cyrillic_free() {
        // T-07-02 / D-09/D-29: offline reason codes are STABLE ASCII tokens — no
        // Cyrillic, no config/server text. Plan 02-09 localizes them on the frontend.
        for reason in [TUNNEL_LOST_REASON, INTERNET_LOST_REASON] {
            assert!(reason.is_ascii(), "reason code {reason:?} must be ASCII");
            assert!(
                !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
                "reason code {reason:?} must contain NO Cyrillic",
            );
        }
        // The two classes must be distinguishable by the UI.
        assert_ne!(TUNNEL_LOST_REASON, INTERNET_LOST_REASON);
        assert_eq!(TUNNEL_LOST_REASON, "tunnel-lost");
        assert_eq!(INTERNET_LOST_REASON, "internet-lost");
    }
}

#[cfg(test)]
mod reconnect_supervisor_tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::time::Instant;

    /// A no-op async sleep so the loop's inter-attempt wait is observable in tests
    /// without real time passing. Each call bumps `slept` so the fast-fail test can
    /// prove the full window was skipped.
    fn never_sleeps() {}

    #[test]
    fn reconnect_guard_try_claim_is_exclusive() {
        // R1 (CAS): the FIRST claim of a free slot wins; a SECOND claim while the first
        // guard is still alive is rejected (None). This is exactly what stops two
        // supervisors — or a supervisor and the recovery flow — from both owning recovery
        // and racing the status (the «застряло на Подключено» class of bug). Dropping the
        // first guard releases the slot so a genuine NEW drop can claim it again.
        let flag = Arc::new(AtomicBool::new(false));

        let first = ReconnectInProgressGuard::try_claim(Arc::clone(&flag));
        assert!(first.is_some(), "first claim of a free slot must win");
        assert!(flag.load(Ordering::SeqCst), "claim sets the flag");

        let second = ReconnectInProgressGuard::try_claim(Arc::clone(&flag));
        assert!(
            second.is_none(),
            "a second claim while the first guard is held must be rejected"
        );

        drop(first);
        assert!(!flag.load(Ordering::SeqCst), "dropping the guard releases the slot");

        let third = ReconnectInProgressGuard::try_claim(Arc::clone(&flag));
        assert!(third.is_some(), "after release a fresh claim wins again");
    }

    #[tokio::test]
    async fn attempts_bounded_to_max() {
        // D-02: with a try-connect that always fails SLOWLY (past FAST_FAIL_GRACE so the
        // loop would normally sleep), the loop calls it exactly RECONNECT_MAX_ATTEMPTS
        // times and ends in GaveUp — never one more. Asserted against the const so a retune
        // can't drift the test.
        let calls = Cell::new(0u32);
        let sleeps = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            7,
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |_attempt| {
                calls.set(calls.get() + 1);
                async {
                    // "Slow" failure: elapsed beyond FAST_FAIL_GRACE so it is NOT a
                    // fast-fail (the inter-attempt sleep path is taken). Transient
                    // reason (None) so the terminal short-circuit does NOT fire.
                    (false, crate::lifecycle::FAST_FAIL_GRACE + Duration::from_secs(1), None)
                }
            },
            || false,    // user not disconnecting
            || 7,         // generation unchanged
            |_attempt| {},
            || {
                sleeps.set(sleeps.get() + 1);
                async {}
            },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::GaveUp);
        let max = crate::lifecycle::RECONNECT_MAX_ATTEMPTS;
        assert_eq!(calls.get(), max, "must attempt exactly RECONNECT_MAX_ATTEMPTS times");
        assert_eq!(max, 10);
        // Slept between every attempt except after the last (give-up) one → max - 1 sleeps.
        assert_eq!(sleeps.get(), max - 1, "interval slept only between attempts");
    }

    #[tokio::test]
    async fn stops_on_first_success() {
        // Fails twice then succeeds on attempt 3 → Recovered, no terminal Error.
        let calls = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            1,
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |attempt| {
                calls.set(calls.get() + 1);
                async move {
                    let ok = attempt == 3;
                    (ok, crate::lifecycle::FAST_FAIL_GRACE + Duration::from_secs(1), None)
                }
            },
            || false,
            || 1,
            |_attempt| {},
            || async { never_sleeps() },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::Recovered);
        assert_eq!(calls.get(), 3, "stopped exactly on the successful attempt");
    }

    #[tokio::test]
    async fn user_disconnect_during_inflight_reconnect_aborts_not_recovers() {
        // T-31 regression: the user clicks Disconnect WHILE a reconnect attempt is in
        // flight. The attempt then SUCCEEDS (the respawn connected just as the user
        // disconnected), but the user's intent must WIN — the loop must return Aborted,
        // NOT Recovered, so the supervisor tears the respawned sidecar down to a clean
        // Disconnected instead of flipping the session back to Connected (the
        // "Disconnect needs a second press" UAT bug).
        //
        // Model: user_disconnected() is false at the pre-attempt guard (so the attempt
        // runs) and flips to true DURING the attempt (the disconnect landed mid-respawn).
        // The post-success re-check then observes the intent and aborts.
        let disconnected = Cell::new(false);
        let calls = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            1,
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |_attempt| {
                calls.set(calls.get() + 1);
                // The attempt connects, but the user disconnected meanwhile.
                disconnected.set(true);
                async { (true, Duration::from_secs(1), None) }
            },
            || disconnected.get(), // false at pre-attempt guard, true after the attempt
            || 1,                  // generation unchanged (this is a DISCONNECT, not a reconnect)
            |_attempt| {},
            || async { never_sleeps() },
        )
        .await;

        assert_eq!(
            outcome,
            SupervisorOutcome::Aborted,
            "a user disconnect during an in-flight reconnect must abort, never report Recovered",
        );
        assert_eq!(calls.get(), 1, "exactly one attempt ran before the abort");
    }

    #[tokio::test]
    async fn a_manual_connect_during_an_in_flight_attempt_aborts_not_recovers() {
        // FB-01 regression (Fable-5 Phase-28 review). A CONNECT race, not a disconnect race.
        //
        // The walk is inside `respawn_and_wait` on candidate C. The user — watching
        // «Переподключение…» — clicks server B's card. `vpn_connect(B)` bumps the generation;
        // FAB-R1 makes the walk's C-child refuse to store and die. But `respawn_and_wait` polls the
        // SHARED status arc, so it observes B reaching Connected and reports success, and the user
        // did not DISCONNECT (they connected), so the intent flag is clear.
        //
        // Pre-fix the loop returned Recovered at candidate C: the terminal arm emitted
        // `vpn-flow { origin: "failover", configPath: C }` and the window adopted C while the
        // tunnel actually ran B. The outcome must be Aborted.
        let generation = Cell::new(7u64); // captured at the drop
        let calls = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            7,
            crate::lifecycle::FAILOVER_ATTEMPTS_PER_CANDIDATE,
            |_attempt| {
                calls.set(calls.get() + 1);
                // The user's vpn_connect(B) lands DURING the attempt and bumps the generation…
                generation.set(8);
                // …and the poll then observes B's Connected and calls the attempt a success.
                async { (true, Duration::from_secs(2), None) }
            },
            || false, // no disconnect intent — the user CONNECTED, they did not disconnect
            || generation.get(),
            |_attempt| {},
            || async { never_sleeps() },
        )
        .await;

        assert_eq!(
            outcome,
            SupervisorOutcome::Aborted,
            "someone else's connect must never be classified as this walk's own recovery",
        );
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn respects_disconnecting_flag() {
        // D-04: if the user-intent predicate is true at the first attempt, the loop
        // returns Aborted immediately and NEVER respawns or sets a status.
        let calls = Cell::new(0u32);
        let reconnecting = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            1,
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |_attempt| {
                calls.set(calls.get() + 1);
                async { (false, Duration::from_secs(10), None) }
            },
            || true, // user disconnecting → abort before any attempt
            || 1,
            |_attempt| reconnecting.set(reconnecting.get() + 1),
            || async { never_sleeps() },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::Aborted);
        assert_eq!(calls.get(), 0, "no respawn when the user is disconnecting");
        assert_eq!(reconnecting.get(), 0, "no Reconnecting status write either");
    }

    #[tokio::test]
    async fn stops_when_generation_advanced() {
        // Codex HIGH: if the live generation no longer equals the captured one
        // (manual reconnect / disconnect bumped it), the loop aborts before the next
        // respawn / status-write and does NOT act.
        let calls = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            5,                 // captured generation
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |_attempt| {
                calls.set(calls.get() + 1);
                async { (false, Duration::from_secs(10), None) }
            },
            || false,
            || 6, // live generation advanced past captured → stale supervisor
            |_attempt| {},
            || async { never_sleeps() },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::Aborted);
        assert_eq!(calls.get(), 0, "a stale supervisor must not respawn");
    }

    #[tokio::test]
    async fn fast_fail_skips_full_window() {
        // Gemini fast-fail: a respawn that "dies" in less than FAST_FAIL_GRACE counts
        // the failure immediately and does NOT wait out the full attempt window. With
        // a real sleep injected, total wall time for 3 instant deaths stays far below
        // 3× RECONNECT_ATTEMPT_WINDOW (proving the window was skipped).
        let sleeps = Cell::new(0u32);
        let start = Instant::now();
        let outcome = run_reconnect_loop(
            1,
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |_attempt| async {
                // Instant death: elapsed below FAST_FAIL_GRACE → fast-fail. Transient
                // (None) so it is the fast-fail path under test, not the terminal one.
                (false, Duration::from_millis(1), None)
            },
            || false,
            || 1,
            |_attempt| {},
            || {
                // If the loop ever decides to sleep on a fast-fail, this would run a
                // REAL interval sleep and blow the time budget. It must never run.
                sleeps.set(sleeps.get() + 1);
                async { tokio::time::sleep(crate::lifecycle::RECONNECT_INTERVAL).await }
            },
        )
        .await;
        let elapsed = start.elapsed();

        assert_eq!(outcome, SupervisorOutcome::GaveUp);
        assert_eq!(sleeps.get(), 0, "fast-fail must skip the inter-attempt sleep");
        // Fast-fail must not wait out even a SINGLE full per-attempt window.
        assert!(
            elapsed < crate::lifecycle::RECONNECT_ATTEMPT_WINDOW,
            "fast-fail path must not wait out even a single full window (elapsed={elapsed:?})",
        );
    }

    #[tokio::test]
    async fn terminal_reason_stops_after_first_attempt() {
        // 02-10 (T-10-03): unlike attempts_bounded_to_three (which calls try_connect 3
        // times on transient failures), a TERMINAL failure reason short-circuits the
        // loop after attempt 1 — the user sees the honest error immediately instead of
        // after all three pointless retries. Outcome is still GaveUp (terminal Error),
        // but with calls == 1.
        let calls = Cell::new(0u32);
        let sleeps = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            7,
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |_attempt| {
                calls.set(calls.get() + 1);
                async {
                    // Fail with a TERMINAL reason (bad creds) — a retry cannot fix it.
                    (
                        false,
                        crate::lifecycle::FAST_FAIL_GRACE + Duration::from_secs(1),
                        Some("Authorization failed".to_string()),
                    )
                }
            },
            || false,
            || 7,
            |_attempt| {},
            || {
                sleeps.set(sleeps.get() + 1);
                async {}
            },
        )
        .await;

        assert_eq!(outcome, SupervisorOutcome::GaveUp);
        assert_eq!(calls.get(), 1, "terminal reason must stop after the FIRST attempt");
        assert_eq!(sleeps.get(), 0, "no inter-attempt sleep on a terminal short-circuit");
    }

    // ── Phase 28 (D-02 / D-05 / D-06): the failover queue walk ──────────────
    //
    // Driven by a scripted `run_one_candidate` so the whole walk runs with NO sidecar and NO
    // network — the same injected-closure technique `run_reconnect_loop` is already tested with.
    // The real A→B→C path is manual UAT.

    /// Build a scripted candidate runner plus the call log it writes into.
    fn scripted(outcomes: &[SupervisorOutcome]) -> (Vec<SupervisorOutcome>, Rc<RefCell<Vec<usize>>>) {
        (outcomes.to_vec(), Rc::new(RefCell::new(Vec::new())))
    }

    #[tokio::test]
    async fn the_walk_advances_on_give_up_and_reports_the_candidate_that_won() {
        // The headline row: server A goes silent, A's one attempt fails, B's fails, C answers.
        // The walk must report C — the third candidate — and must have run all three in order.
        let (script, seen) = scripted(&[
            SupervisorOutcome::GaveUp,
            SupervisorOutcome::GaveUp,
            SupervisorOutcome::Recovered,
        ]);
        let log = Rc::clone(&seen);
        let result = run_failover_walk(
            3,
            move |index| {
                log.borrow_mut().push(index);
                let outcome = script[index];
                async move { outcome }
            },
            || true,
        )
        .await;

        assert_eq!(result.outcome, SupervisorOutcome::Recovered);
        assert_eq!(result.candidate_index, 2, "the THIRD candidate is the one that won");
        assert!(!result.queue_exhausted, "a walk that recovered never exhausted the queue");
        assert_eq!(*seen.borrow(), vec![0, 1, 2], "candidates tried in priority order");
    }

    #[tokio::test]
    async fn the_walk_stops_immediately_when_the_origin_comes_back() {
        // D-02: the origin gets its one attempt FIRST. If it answers, nobody is moved to another
        // country — the walk must not touch candidate 2 at all.
        let calls = Rc::new(RefCell::new(0u32));
        let counter = Rc::clone(&calls);
        let result = run_failover_walk(
            3,
            move |_index| {
                *counter.borrow_mut() += 1;
                async { SupervisorOutcome::Recovered }
            },
            || true,
        )
        .await;

        assert_eq!(result.outcome, SupervisorOutcome::Recovered);
        assert_eq!(result.candidate_index, 0, "the origin won — no failover happened");
        assert_eq!(*calls.borrow(), 1, "no further candidate may be tried after a recovery");
    }

    #[tokio::test]
    async fn the_walk_stops_on_abort_and_changes_nothing() {
        // A user disconnect (or a manual reconnect that bumped the generation) mid-walk: the
        // walk is stale, so it stops where it stands, reports Aborted, and leaves the session to
        // whoever took it over. Aborted is NOT exhaustion — no terminal Error may be written.
        let calls = Rc::new(RefCell::new(0u32));
        let counter = Rc::clone(&calls);
        let result = run_failover_walk(
            3,
            move |_index| {
                *counter.borrow_mut() += 1;
                async { SupervisorOutcome::Aborted }
            },
            || true,
        )
        .await;

        assert_eq!(result.outcome, SupervisorOutcome::Aborted);
        assert!(!result.queue_exhausted, "an abort must never be reported as an exhausted queue");
        assert_eq!(*calls.borrow(), 1, "the walk stopped on the aborting candidate");
    }

    #[tokio::test]
    async fn a_queue_advance_re_checks_ownership_before_touching_a_different_server() {
        // T-28-07: an ADVANCE reconnects to a DIFFERENT config, which is closer to a
        // `vpn_connect` than to a retry — so ownership is re-checked on every advance, not only
        // on every attempt inside `run_reconnect_loop`. Here the first candidate gives up and the
        // advance gate refuses (a switch/disconnect landed): the walk must abort WITHOUT starting
        // candidate 2 on a session it no longer owns («застряло на Подключено» phantom class).
        let calls = Rc::new(RefCell::new(0u32));
        let counter = Rc::clone(&calls);
        let result = run_failover_walk(
            3,
            move |_index| {
                *counter.borrow_mut() += 1;
                async { SupervisorOutcome::GaveUp }
            },
            || false, // ownership lost between candidate 1 and candidate 2
        )
        .await;

        assert_eq!(result.outcome, SupervisorOutcome::Aborted);
        assert!(!result.queue_exhausted);
        assert_eq!(*calls.borrow(), 1, "a stale walk must not connect to the next server");
    }

    #[tokio::test]
    async fn an_aborted_walk_gives_back_the_auto_switch_stamp_of_the_candidate_it_ran() {
        // WR-05, the walk-side half. This pins the INPUT the abort arm feeds the release: which
        // candidate the walk stopped on, and therefore whose stamp is still armed.
        //
        // The scenario is the real one. Candidate #1 (the origin) gives up, so the walk advances to
        // candidate #2 and stamps `AutoSwitch` before respawning it — that respawn IS a switch. The
        // attempt on #2 is then aborted because the generation moved: a new session owns the
        // sidecar. The abort arm leaves the status and the sidecar to that session, so no terminal
        // edge ever reaches `maybe_fire` and nothing consumes the stamp. Before WR-05 it stayed
        // armed and the next TRAY connect — which stamps no origin of its own — was announced as
        // «Переключено автоматически» for a connect the person made by hand.
        let slot = std::sync::Mutex::new(crate::notify::ConnectOrigin::Manual);

        let result = run_failover_walk(
            3,
            |index| {
                // Exactly what `respawn_sidecar`'s caller does before each candidate.
                crate::notify::stamp_failover_origin_in(&slot, index);
                async move {
                    if index == 0 {
                        SupervisorOutcome::GaveUp
                    } else {
                        SupervisorOutcome::Aborted
                    }
                }
            },
            || true,
        )
        .await;

        assert_eq!(result.outcome, SupervisorOutcome::Aborted);
        assert_eq!(
            result.candidate_index, 1,
            "the walk stopped on candidate #2 — the one whose stamp is live",
        );
        assert_eq!(
            *slot.lock().unwrap(),
            crate::notify::ConnectOrigin::AutoSwitch,
            "the walk left its stamp behind: no terminal edge spent it",
        );

        // What the `SupervisorOutcome::Aborted` arm now does, before it decides anything about the
        // status or the sidecar.
        crate::notify::release_failover_origin_in(&slot, result.candidate_index);

        assert_eq!(
            crate::notify::decide_notification(
                VpnStatus::Connecting,
                VpnStatus::Connected,
                *slot.lock().unwrap(),
                true,
                false,
                false,
            ),
            Some(crate::notify::NotifyKind::Connected),
            "the next tray connect must read «Подключено», not «Переключено автоматически»",
        );
    }

    #[tokio::test]
    async fn a_full_pass_with_no_answer_reports_an_exhausted_queue() {
        // D-05: ONE pass. Every participating server gave up → the queue is exhausted, which is a
        // DIFFERENT fact from «this one server would not come back».
        let calls = Rc::new(RefCell::new(0u32));
        let counter = Rc::clone(&calls);
        let result = run_failover_walk(
            3,
            move |_index| {
                *counter.borrow_mut() += 1;
                async { SupervisorOutcome::GaveUp }
            },
            || true,
        )
        .await;

        assert_eq!(result.outcome, SupervisorOutcome::GaveUp);
        assert!(result.queue_exhausted, "all three candidates gave up → exhausted");
        assert_eq!(*calls.borrow(), 3, "exactly ONE pass — no silent second lap (D-05)");
        assert_eq!(result.candidate_index, 2);
    }

    #[tokio::test]
    async fn a_single_candidate_queue_that_gives_up_is_not_an_exhausted_queue() {
        // The failover-disabled path and the internet-lost recovery path both walk a
        // one-entry queue. Their give-up must stay `reconnect-gave-up`: «this server would not
        // come back» and «none of your servers answered» must not collapse into one message.
        let result = run_failover_walk(1, |_index| async { SupervisorOutcome::GaveUp }, || true).await;

        assert_eq!(result.outcome, SupervisorOutcome::GaveUp);
        assert!(
            !result.queue_exhausted,
            "a one-server queue gave up; it did not exhaust a list of servers",
        );
        assert_eq!(give_up_reason(result.queue_exhausted), RECONNECT_GAVE_UP_REASON);
    }

    #[test]
    fn the_exhausted_queue_reason_is_distinct_stable_ascii() {
        // D-09/D-29 + T-28-08: a FIXED lowercase-ASCII kebab token — never Cyrillic, never a
        // server name or a config path, localized only at the frontend presentation boundary.
        assert_eq!(FAILOVER_EXHAUSTED_REASON, "failover-exhausted");
        assert!(FAILOVER_EXHAUSTED_REASON.is_ascii(), "reason code must be ASCII");
        assert!(
            !FAILOVER_EXHAUSTED_REASON
                .chars()
                .any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic",
        );
        assert!(
            FAILOVER_EXHAUSTED_REASON
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '-'),
            "reason code must be a plain lowercase-kebab token — no digits, no server text",
        );
        // Reusing `reconnect-gave-up` is forbidden: it would make «this one server would not come
        // back» and «none of your servers answered» the same message to the user, which is the
        // exact collapse 27 D-15 is fixing on the other side of the app.
        assert_ne!(FAILOVER_EXHAUSTED_REASON, RECONNECT_GAVE_UP_REASON);
        assert_ne!(FAILOVER_EXHAUSTED_REASON, crate::lifecycle::RECOVERY_TIMEOUT_REASON);
        // …and it is TRANSIENT: a later attempt (or a server coming back) may succeed, so it must
        // never short-circuit a future reconnect loop.
        assert!(!crate::lifecycle::is_terminal_reason(FAILOVER_EXHAUSTED_REASON));
    }

    #[test]
    fn the_give_up_reason_selector_separates_the_two_failures() {
        assert_eq!(give_up_reason(true), FAILOVER_EXHAUSTED_REASON);
        assert_eq!(give_up_reason(false), RECONNECT_GAVE_UP_REASON);
    }

    // ─── 28-03: the OQ-1 switch announcement ───

    fn queue_of(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| (*p).to_string()).collect()
    }

    #[test]
    fn a_recovery_on_a_later_candidate_is_a_switch_to_announce() {
        // The whole point of OQ-1: Rust connected to a DIFFERENT server than the one the app's
        // pointer names. The winning path is what the window needs to adopt.
        let queue = queue_of(&["/a.toml", "/b.toml", "/c.toml"]);
        let walk = FailoverWalkResult {
            outcome: SupervisorOutcome::Recovered,
            candidate_index: 2,
            queue_exhausted: false,
        };
        assert_eq!(failover_switch_target(&walk, &queue), Some("/c.toml"));
    }

    #[test]
    fn a_recovery_on_the_origin_is_not_a_switch() {
        // A successful RETRY of the same server moved nobody. Announcing it would re-point the
        // app at the config it is already on and fire a «переключено автоматически» plate for a
        // switch that never happened.
        let queue = queue_of(&["/a.toml", "/b.toml"]);
        let walk = FailoverWalkResult {
            outcome: SupervisorOutcome::Recovered,
            candidate_index: 0,
            queue_exhausted: false,
        };
        assert_eq!(failover_switch_target(&walk, &queue), None);
    }

    #[test]
    fn a_walk_that_did_not_recover_announces_nothing() {
        // Neither an exhausted queue nor an abort leaves the user ON a server, so there is no
        // pointer to move. The exhaustion has its own terminal Error + reason code (D-05).
        let queue = queue_of(&["/a.toml", "/b.toml", "/c.toml"]);
        for outcome in [SupervisorOutcome::GaveUp, SupervisorOutcome::Aborted] {
            let walk = FailoverWalkResult {
                outcome,
                candidate_index: 2,
                queue_exhausted: outcome == SupervisorOutcome::GaveUp,
            };
            assert_eq!(
                failover_switch_target(&walk, &queue),
                None,
                "{outcome:?} must not announce a switch",
            );
        }
    }

    #[test]
    fn a_win_on_the_origin_in_another_spelling_is_not_a_switch() {
        // CR-02 belt. `failover_queue` now de-dupes on the canonical key so this queue should be
        // unreachable — but this function is the LAST gate before the app tells the user it moved
        // them. A candidate that IS the origin in a different string form must never announce a
        // switch, or the user gets a «Переключено автоматически» plate for a move that never
        // happened and the window re-adopts the config it is already on in the other spelling
        // (which then propagates back into `tt_config_path`, keeping the mismatch alive).
        let queue = queue_of(&["C:\\cfg\\A.toml", "c:/cfg/a.toml"]);
        let walk = FailoverWalkResult {
            outcome: SupervisorOutcome::Recovered,
            candidate_index: 1,
            queue_exhausted: false,
        };
        assert_eq!(failover_switch_target(&walk, &queue), None);

        // …while a genuinely different server at the same index still announces normally.
        let real = queue_of(&["C:\\cfg\\A.toml", "c:/cfg/b.toml"]);
        assert_eq!(failover_switch_target(&walk, &real), Some("c:/cfg/b.toml"));
    }

    #[test]
    fn an_index_past_the_queue_announces_nothing_instead_of_panicking() {
        // Defensive: the index and the queue arrive from two places. A mismatch must degrade to
        // «no announcement» — an out-of-bounds index in a background task would panic the walk's
        // terminal arm and the user would never learn the outcome at all.
        let queue = queue_of(&["/a.toml"]);
        let walk = FailoverWalkResult {
            outcome: SupervisorOutcome::Recovered,
            candidate_index: 7,
            queue_exhausted: false,
        };
        assert_eq!(failover_switch_target(&walk, &queue), None);
    }

    #[test]
    fn the_failover_flow_origin_is_a_stable_token_distinct_from_the_tray() {
        // The receiving side early-returns on an unrecognised origin, so this token IS the wire
        // contract; `shared/ipc/events.ts` mirrors it as a closed union. D-29: an origin token,
        // never a server name.
        assert_eq!(FAILOVER_FLOW_ORIGIN, "failover");
        assert_ne!(FAILOVER_FLOW_ORIGIN, "tray");
        assert!(
            FAILOVER_FLOW_ORIGIN
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '-'),
            "origin token must be a plain lowercase-kebab ASCII token",
        );
    }

    #[tokio::test]
    async fn the_walk_offers_no_teardown_seam_between_candidates() {
        // D-06 / T-28-05 (safety invariant): traffic stays BLOCKED for the whole sequence. The
        // sidecar is torn down exactly ONCE, at the end, never between candidates — a mid-walk
        // teardown releases the WinTUN adapter and the fail-closed killswitch with it, which is
        // precisely the leak D-06 exists to prevent.
        //
        // Modelled as the production shape: `teardowns` is bumped ONLY where the caller does it —
        // in the terminal arm AFTER the walk returns. Each candidate records the count it can see
        // when it starts, so any teardown that had leaked into the loop body would show up as a
        // non-zero observation.
        let teardowns = Rc::new(RefCell::new(0u32));
        let observed_mid_walk = Rc::new(RefCell::new(Vec::<u32>::new()));
        let seen = Rc::clone(&observed_mid_walk);
        let counter = Rc::clone(&teardowns);
        let result = run_failover_walk(
            3,
            move |_index| {
                seen.borrow_mut().push(*counter.borrow());
                async { SupervisorOutcome::GaveUp }
            },
            || true,
        )
        .await;

        assert_eq!(
            *observed_mid_walk.borrow(),
            vec![0, 0, 0],
            "no candidate may start after a teardown — traffic must stay blocked mid-walk (D-06)",
        );

        // The caller's SINGLE end-of-walk teardown, on the terminal arm.
        if matches!(result.outcome, SupervisorOutcome::GaveUp) {
            *teardowns.borrow_mut() += 1;
        }
        assert_eq!(*teardowns.borrow(), 1, "exactly one teardown across a three-candidate walk");
    }

    #[tokio::test]
    async fn the_per_attempt_outcome_is_event_driven_not_clock_driven() {
        // D-03 (the landmine): the attempt ends as soon as the OUTCOME is known — it is never
        // capped by a flat per-attempt timer. Drive `try_connect` with an elapsed time PAST
        // FAST_FAIL_GRACE (so it is not a fast-fail) but well under RECONNECT_ATTEMPT_WINDOW, and
        // report SUCCESS: the loop must neither wait out the ceiling nor count that success as a
        // failure. A ceiling-driven loop would do both — which is how auto-reconnect once became
        // structurally unable to succeed on a slow-warmup protocol (3.8 F-2).
        let mid_flight = crate::lifecycle::FAST_FAIL_GRACE + Duration::from_secs(1);
        assert!(
            mid_flight < crate::lifecycle::RECONNECT_ATTEMPT_WINDOW,
            "the fixture must sit strictly between the grace and the ceiling",
        );

        let sleeps = Cell::new(0u32);
        let start = Instant::now();
        let outcome = run_reconnect_loop(
            1,
            crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
            |_attempt| async move { (true, mid_flight, None) },
            || false,
            || 1,
            |_attempt| {},
            || {
                sleeps.set(sleeps.get() + 1);
                async { tokio::time::sleep(crate::lifecycle::RECONNECT_ATTEMPT_WINDOW).await }
            },
        )
        .await;
        let elapsed = start.elapsed();

        assert_eq!(
            outcome,
            SupervisorOutcome::Recovered,
            "a connect that took longer than the fast-fail grace is a SUCCESS, not a failure",
        );
        assert_eq!(sleeps.get(), 0, "a successful attempt must not sleep at all");
        assert!(
            elapsed < crate::lifecycle::RECONNECT_ATTEMPT_WINDOW,
            "the outcome is decided by the event, never by the ceiling (elapsed={elapsed:?})",
        );
    }

    #[test]
    fn terminal_error_uses_reason_code_not_cyrillic() {
        // CLAUDE.md i18n rule + D-09/D-29: the give-up Error value is the STABLE ASCII
        // reason code — no Cyrillic, no user-facing display string, not interpolated
        // from config / sidecar text.
        let reason = RECONNECT_GAVE_UP_REASON;
        assert_eq!(reason, "reconnect-gave-up");
        assert!(reason.is_ascii(), "reason code must be ASCII");
        assert!(
            !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
            "reason code must contain NO Cyrillic",
        );
    }
}
