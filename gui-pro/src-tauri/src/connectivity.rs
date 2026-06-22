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
// tightened so a real drop is declared in ~10-15s and handed to the reconnect
// supervisor. The probe was ALSO retargeted from the local gateway to the
// TUNNEL/SERVER path (see `check_tunnel_alive`), so a server-silent drop (LAN up,
// server dead) is caught at the same speed as an Ethernet unplug — the old
// gateway probe stayed "online" when only the server died.
/// How often the monitor checks tunnel liveness while VPN is connected.
/// 4s × MAX_FAILURES gives an offline floor of ~12s of cadence; with the tight
/// per-probe timeout (`TUNNEL_PROBE_TIMEOUT_SECS`) the worst-case declaration
/// window stays ~10-15s — collapsing the old ~80-140s floor (UAT Gap #1).
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
                        app.emit("internet-status", serde_json::json!({ "online": true })).ok();
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
                    app.emit("internet-status", serde_json::json!({ "online": true })).ok();
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
                    // Secondary gate: is the LOCAL network still reachable? This does NOT
                    // gate the offline decision (the tunnel probe already failed N times);
                    // it only classifies the reason code so the UI can distinguish a
                    // server-silent drop (gateway up, tunnel dead) from a whole-internet
                    // outage (gateway also down). A reachable gateway can NOT mask a dead
                    // tunnel — by this point we have already decided to go offline.
                    let local_up = check_adapter_online().await;
                    let reason = if local_up {
                        TUNNEL_LOST_REASON
                    } else {
                        INTERNET_LOST_REASON
                    };
                    eprintln!("[connectivity] Tunnel appears down (reason={reason}) — telling frontend to disconnect VPN");
                    log_app(
                        "WARN",
                        &format!("[connectivity] Declaring offline after {MAX_FAILURES} failed tunnel probes (reason={reason})"),
                    );
                    // 2026-06-11 (user-requested drop diagnostics): ONE verdict line
                    // answering "did MY side break, or the path/server?" — the question a
                    // post-mortem log read could not answer before. By this point the
                    // tunnel probe failed MAX_FAILURES times; local_up says whether the
                    // physical side (adapter + gateway) still works. Emitted on the
                    // vpn-log channel too so it lands in the in-window panel next to the
                    // sidecar lines, not only in the (opt-in) log file.
                    let adapter_present = find_physical_adapter().is_some();
                    let verdict = if local_up {
                        format!(
                            "[diagnose] drop verdict: adapter=present, gateway=reachable, tunnel probes failed {MAX_FAILURES}x — cause is OUTSIDE this PC (ISP path or server)"
                        )
                    } else {
                        format!(
                            "[diagnose] drop verdict: adapter={}, gateway=unreachable — cause is LOCAL (PC / Wi-Fi / router side)",
                            if adapter_present { "present" } else { "missing" }
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
                    if declare_offline_and_handoff(&app, reason) {
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
/// - Loops `attempt` over `1..=RECONNECT_MAX_ATTEMPTS` (no inline `3`).
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
    for attempt in 1..=crate::lifecycle::RECONNECT_MAX_ATTEMPTS {
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
            if user_disconnected() {
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
        let is_last = crate::lifecycle::gave_up(attempt);
        if !is_last && !crate::lifecycle::is_fast_fail(elapsed) {
            sleep_interval().await;
        }
    }

    SupervisorOutcome::GaveUp
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
    reason: &'static str,
) -> bool {
    // Tell frontend: disconnect VPN, then we'll monitor adapter recovery. The
    // `disconnect` action drives the UI (e.g. the recovering label); the `reconnect`
    // recovery is DRIVEN IN RUST by the supervisor below. `reason` is a STABLE ASCII
    // code (Plan 02-09 maps it to a localized message) — never a Russian string.
    app.emit("internet-status", serde_json::json!({
        "online": false,
        "action": "disconnect",
        "reason": reason
    })).ok();

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
                log_app(
                    "INFO",
                    "[connectivity] live-sidecar drop — starting reconnect supervisor",
                );
                start_reconnect_supervisor(
                    app.clone(),
                    config_path,
                    log_level,
                    generation,
                );
                // The supervisor now owns recovery for this drop.
                return true;
            }
        }
    }

    false
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
            app.emit("internet-status", serde_json::json!({
                "online": true,
                "action": "reconnect"
            })).ok();
            return true;
        }

        // Give up after ~5 minutes of waiting (ADAPTER_RECOVERY_TIMEOUT_CHECKS × ADAPTER_POLL_INTERVAL_SECS).
        if adapter_wait >= ADAPTER_RECOVERY_TIMEOUT_CHECKS {
            eprintln!("[connectivity] Gave up waiting for adapter after 5 minutes");
            log_app("WARN", "[connectivity] Gave up waiting for adapter after 5 minutes");
            app.emit("internet-status", serde_json::json!({
                "online": false,
                "action": "give_up"
            })).ok();
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
        serde_json::json!({
            "online": false,
            "action": "disconnect",
            "reason": INTERNET_LOST_REASON,
        }),
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
            app.emit(
                "internet-status",
                serde_json::json!({ "online": true, "action": "reconnect" }),
            )
            .ok();
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
                serde_json::json!({ "online": false, "action": "give_up" }),
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
    start_reconnect_supervisor(app.clone(), config_path, log_level, generation);
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
/// It retries exactly `RECONNECT_MAX_ATTEMPTS` times at a fixed snappy interval
/// (no exponential backoff — D-02), emitting `VpnStatus::Reconnecting` per attempt
/// through the SINGLE mutator `set_vpn_status` (D-03), fast-fails on instant deaths
/// (Gemini), and is generation-guarded so a manual reconnect / disconnect that
/// bumped `connection_generation` neutralizes a stale supervisor (Codex HIGH).
/// After 3 failures it sets a terminal `VpnStatus::Error` carrying the STABLE
/// secret-free reason code `RECONNECT_GAVE_UP_REASON` — never a Russian string.
///
/// `generation` is the `connection_generation` value captured by the trigger at the
/// moment of the drop; the supervisor re-checks it before every respawn / status
/// write via the loop's `live_generation` closure.
pub fn start_reconnect_supervisor(
    app: tauri::AppHandle,
    config_path: String,
    log_level: String,
    generation: u64,
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

        // Injected predicates for the testable core.
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
        let user_disconnect_requested_arc = Arc::clone(&state.user_disconnect_requested);
        let user_disconnected = {
            let disc_arc = Arc::clone(&disc_arc);
            let durable = Arc::clone(&user_disconnect_requested_arc);
            move || {
                *disc_arc.lock().unwrap_or_else(|e| e.into_inner())
                    || durable.load(Ordering::SeqCst)
            }
        };

        // Per-attempt Reconnecting status via the single mutator (D-03). The
        // attempt count is non-secret (D-09), so the marker is safe to log/emit.
        //
        // 02-20 status-UX split: this is the SERVER-SILENT auto-retry path
        // («Переподключение»), so each attempt routes through the per-attempt writer
        // that surfaces «Попытка N/N» on the `"vpn-status"` event (attempt/max fields)
        // for the UI — still the SINGLE status owner (D-01), just with the optional
        // counter populated.
        let on_reconnecting = {
            let app = app.clone();
            move |attempt: u32| {
                let max = crate::lifecycle::RECONNECT_MAX_ATTEMPTS;
                let marker = format!("reconnect attempt {attempt}/{max}");
                log_app("INFO", &format!("[reconnect] {marker}"));
                app.emit(
                    "vpn-log",
                    serde_json::json!({ "message": marker, "level": "info" }),
                )
                .ok();
                if let Some(state) = app.try_state::<crate::commands::AppState>() {
                    crate::commands::vpn::set_vpn_status_reconnecting_attempt(
                        &app, &state, attempt, max,
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
            let config_path = config_path.clone();
            let log_level = log_level.clone();
            let status_arc = Arc::clone(&status_arc);
            let last_error_arc = Arc::clone(&last_error_arc);
            move |_attempt: u32| {
                let app = app.clone();
                let config_path = config_path.clone();
                let log_level = log_level.clone();
                let status_arc = Arc::clone(&status_arc);
                let last_error_arc = Arc::clone(&last_error_arc);
                async move {
                    let start = Instant::now();
                    let ok = respawn_and_wait(&app, &config_path, &log_level, &status_arc).await;
                    // On failure, read the specific Error reason the attempt landed so
                    // the loop can short-circuit a terminal one. Only meaningful when
                    // !ok; on success the reason is irrelevant (loop returns Recovered).
                    let reason = if ok {
                        None
                    } else {
                        last_error_arc.lock().unwrap_or_else(|e| e.into_inner()).clone()
                    };
                    (ok, start.elapsed(), reason)
                }
            }
        };

        let sleep_interval =
            || async { tokio::time::sleep(crate::lifecycle::RECONNECT_INTERVAL).await };

        let outcome = run_reconnect_loop(
            generation,
            try_connect,
            user_disconnected,
            live_generation,
            on_reconnecting,
            sleep_interval,
        )
        .await;

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
                let marker = format!(
                    "reconnect gave up after {}/{}",
                    crate::lifecycle::RECONNECT_MAX_ATTEMPTS,
                    crate::lifecycle::RECONNECT_MAX_ATTEMPTS
                );
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
                        Some(RECONNECT_GAVE_UP_REASON.to_string()),
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
) -> bool {
    crate::commands::vpn::respawn_sidecar(app, config_path, log_level).await;

    // Poll the single status owner for up to the attempt window. A short poll over
    // the existing lock (poison-recover like set_vpn_status) reuses the one status
    // source of truth instead of a parallel channel.
    let deadline = Instant::now() + crate::lifecycle::RECONNECT_ATTEMPT_WINDOW;
    while Instant::now() < deadline {
        let connected = status_arc
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .eq(&VpnStatus::Connected);
        if connected {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
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
async fn check_tunnel_alive() -> bool {
    let client = match reqwest::Client::builder()
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
                    let ok = resp.status().is_success() || resp.status().as_u16() == 204;
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
        assert!(TUNNEL_PROBE_TIMEOUT_SECS <= 5);
        // Worst-case declaration window (cadence + final tunnel probe + reason-gate
        // probe) stays well under the old ~95-140s.
        let worst_case = cadence_floor + Duration::from_secs(TUNNEL_PROBE_TIMEOUT_SECS * 2);
        assert!(
            worst_case < Duration::from_secs(30),
            "worst-case detection window must be far below the old ~95-140s, got {worst_case:?}",
        );
        // Require N>1 failures so a single transient miss never declares offline
        // (T-07-01: don't false-kill a busy tunnel).
        assert!(MAX_FAILURES >= 2, "must tolerate at least one transient miss");
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
        assert!(
            EVENT_WAKE_MIN_INTERVAL_MS < RESUME_GAP_THRESHOLD_SECS * 1000,
            "the wake debounce must stay far under the resume threshold",
        );
        assert!(
            EVENT_WAKE_MIN_INTERVAL_MS < POLL_INTERVAL_SECS * 1000,
            "a coalesced wake must be re-covered by the next poll cadence",
        );
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
        assert!(UPLINK_CONFIRM_CHECKS >= 2, "must take more than one sample to be flap-safe");
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
    use std::cell::Cell;
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
    async fn respects_disconnecting_flag() {
        // D-04: if the user-intent predicate is true at the first attempt, the loop
        // returns Aborted immediately and NEVER respawns or sets a status.
        let calls = Cell::new(0u32);
        let reconnecting = Cell::new(0u32);
        let outcome = run_reconnect_loop(
            1,
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
