use socket2::{Socket, Domain, Type, Protocol, SockAddr};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;

use crate::logging::log_app;

// WR-03 / IN-03: recovery timing promoted from inline literals to named consts
// mirroring Pro's values, so the rationale in the comments and the actual value
// can never drift apart across editions.
//
// 02-07 (UAT Gap #1, tests 6/7/8): the OLD cadence (POLL=20s × MAX_FAILURES=4)
// gave an ~80s sleep floor before a drop could be declared, plus per-check
// timeouts — a ~95-140s "phantom connected" window. The cadence is now tightened
// so a real drop is declared in ~10-15s. The probe was ALSO retargeted from the
// local gateway to the TUNNEL/SERVER path (see `check_tunnel_alive`), so a
// server-silent drop is caught at the same speed as an Ethernet unplug. Byte-for-
// byte mirror of Pro's connectivity.rs so both editions behave identically.
/// How often the monitor checks tunnel liveness while VPN is connected.
const POLL_INTERVAL_SECS: u64 = 4;
/// Consecutive failed tunnel probes before declaring the tunnel down (~12-15s).
/// Requiring N>1 failures tolerates one transient probe miss under heavy load so
/// a busy-but-healthy tunnel is never false-killed (T-07-01).
const MAX_FAILURES: u32 = 3;
/// Per-probe timeout for the active tunnel-path liveness check. Tight (a few
/// seconds) so a dead tunnel is noticed quickly; the MAX_FAILURES counter, not a
/// single timeout, is what declares offline.
const TUNNEL_PROBE_TIMEOUT_SECS: u64 = 3;
/// Sleep/hibernate/resume re-baseline threshold (02-10, Tier-3) — mirror of Pro. A
/// wall-clock gap across one monitor iteration far larger than the normal cadence
/// means the machine was suspended and just resumed; acting on the now-stale deadlines
/// would either hold a stale "connected" too long or burst-fail. A gap past this many
/// SECONDS is treated as a resume. Set well above the worst-case normal iteration
/// (~10s) so a slow probe is never mistaken for a resume, but low enough to catch a
/// real suspend (≥30s).
const RESUME_GAP_THRESHOLD_SECS: u64 = 30;

/// Pure resume detector — did the gap across one monitor iteration exceed the resume
/// threshold? Free of clock/IO so it is unit-testable. Mirror of Pro's `is_resume_gap`.
fn is_resume_gap(gap: Duration) -> bool {
    gap >= Duration::from_secs(RESUME_GAP_THRESHOLD_SECS)
}

/// How often, during recovery, the monitor polls for the physical adapter.
const ADAPTER_POLL_INTERVAL_SECS: u64 = 5;
/// Give up waiting for the adapter after this many recovery polls
/// (ADAPTER_RECOVERY_TIMEOUT_CHECKS × ADAPTER_POLL_INTERVAL_SECS ≈ 5 minutes).
const ADAPTER_RECOVERY_TIMEOUT_CHECKS: u32 = 60;

/// Stable, secret-free ASCII reason code emitted when the TUNNEL/SERVER path is
/// dead but the local network is still reachable (server-silent drop). D-09/D-29:
/// a FIXED token, never a config/server string and never Cyrillic. Byte-identical
/// to Pro so the shared frontend i18n mapping (Plan 02-09) works for both editions.
pub const TUNNEL_LOST_REASON: &str = "tunnel-lost";
/// Stable, secret-free ASCII reason code emitted when even the LOCAL network is
/// unreachable (Ethernet unplug / Wi-Fi off). Byte-identical to Pro.
pub const INTERNET_LOST_REASON: &str = "internet-lost";

/// Periodically check TUNNEL liveness while VPN is connected.
/// Emits "internet-status" events with { online: bool, action?, reason? } payload.
/// When the tunnel drops, hands off to the window-independent reconnect supervisor
/// (or, in the fallback path, waits for the primary adapter before signaling
/// reconnect).
///
/// 02-07 (UAT Gap #1) mirror of Pro: the liveness signal is now an ACTIVE probe of
/// the TUNNEL/SERVER path (`check_tunnel_alive`), NOT the local gateway. While VPN
/// is up that probe travels THROUGH the tunnel via default routing, so a
/// server-silent drop is detected as fast as an Ethernet unplug. The local gateway
/// is still probed, but ONLY as a cheap secondary GATE to classify the reason code.
///
/// TODO (post-Pro-redesign): mirror the Pro real-time link-state detection
/// (NotifyIpInterfaceChange → immediate monitor re-check, Plan 02-14) so a LOCAL
/// network loss (Ethernet unplugged / Wi-Fi off) is surfaced in well under a second
/// instead of on the next poll cycle (~10-15s). Pro-only for now per the current
/// refactor scope; Light keeps the poll cadence above until the redesign reaches it.
pub fn start_monitor(
    app: tauri::AppHandle,
    is_connected: Arc<Mutex<bool>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures: u32 = 0;
        let mut was_online = true;
        let mut was_connected = false;

        log_app("INFO", "[connectivity] Monitor started");

        loop {
            // 02-10 (Tier-3) mirror of Pro: measure the wall-clock gap ACROSS the
            // per-iteration sleep. A gap far larger than POLL_INTERVAL_SECS means the
            // machine was suspended and just resumed (the sleep "overslept" while frozen).
            let before_sleep = std::time::Instant::now();
            tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
            let slept_for = before_sleep.elapsed();

            // Only check when VPN is connected
            let vpn_up = is_connected.lock().map(|g| *g).unwrap_or(false);
            if !vpn_up {
                consecutive_failures = 0;
                was_online = true;
                was_connected = false;
                continue;
            }

            // 02-10 (Tier-3) mirror of Pro — sleep/hibernate/resume re-baseline. On a
            // resume while VPN was connected, the in-flight failure count + post-connect
            // grace are stale. Re-baseline: reset consecutive_failures, re-arm the grace
            // skip (so we don't instantly declare offline off deadlines that elapsed while
            // asleep), and force ONE immediate out-of-band re-check (NOT counted toward
            // MAX_FAILURES) so a stale "connected" is corrected within seconds. A mid-retry
            // supervisor is generation-guarded and its attempt count is untouched.
            if is_resume_gap(slept_for) {
                log_app(
                    "INFO",
                    "[connectivity] resume from suspend detected — re-baselining monitor (02-10)",
                );
                consecutive_failures = 0;
                was_connected = false; // re-arm the post-connect grace skip
                let online_now = check_tunnel_alive().await;
                if online_now {
                    if !was_online {
                        app.emit("internet-status", serde_json::json!({ "online": true })).ok();
                    }
                    was_online = true;
                } else {
                    was_online = false;
                }
                continue;
            }

            // Skip the first check cycle after VPN connects — DNS proxy needs
            // time to restart with new system DNS servers. Without this grace
            // period the monitor sees DNS failures and kills the VPN.
            if !was_connected {
                was_connected = true;
                log_app("INFO", "[connectivity] VPN just connected — skipping first check cycle");
                continue;
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
            } else {
                consecutive_failures += 1;
                eprintln!("[connectivity] Tunnel probe failed ({consecutive_failures}/{MAX_FAILURES})");
                // Declare offline after MAX_FAILURES consecutive failed probes (~12-15s)
                // — requiring N>1 failures tolerates one transient miss under heavy load
                // so a busy-but-healthy tunnel is never false-killed (T-07-01). Mirror of Pro.
                if consecutive_failures >= MAX_FAILURES && was_online {
                    // WR-03 (mirror of Pro): no `was_online = false;` here — both the
                    // supervisor-handoff `continue` and the fallback reset below set
                    // was_online explicitly, so an assignment here is dead (and clippy
                    // flagged it as never-read).

                    // Secondary gate: is the LOCAL network still reachable? This does NOT
                    // gate the offline decision (the tunnel probe already failed N times);
                    // it only classifies the reason code so the UI can distinguish a
                    // server-silent drop (gateway up, tunnel dead) from a whole-internet
                    // outage (gateway also down). Mirror of Pro.
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

                    // Tell frontend: connectivity dropped — drives the UI `recovering`
                    // label. The `reconnect` recovery is now DRIVEN IN RUST below; its
                    // old React consumer (useVpnEvents `action==="reconnect"`) is deleted,
                    // so leaving it would orphan recovery. `reason` is a STABLE ASCII code
                    // byte-identical to Pro (Plan 02-09 maps it) — never a Russian string.
                    app.emit("internet-status", serde_json::json!({
                        "online": false,
                        "action": "disconnect",
                        "reason": reason
                    })).ok();

                    // STATUS-05 / criterion 3 (trigger B — LIVE-SIDECAR DROP): the tunnel
                    // is dead but the sidecar PROCESS is still alive (no Terminated event
                    // fires), so trigger A (sidecar.rs) never runs for this class of drop.
                    // Hand off to the SAME window-independent Rust supervisor here —
                    // gated on intent (`disconnecting == false`). The supervisor's respawn
                    // kills the stale-but-alive sidecar before restarting it (Pitfall 3).
                    // Mirror of Pro's connectivity loss path.
                    if let Some(state) = app.try_state::<crate::AppState>() {
                        let user_disconnecting = state
                            .disconnecting
                            .lock()
                            .map(|g| *g)
                            .unwrap_or(false);
                        let has_config = state
                            .config_path
                            .lock()
                            .ok()
                            .map(|g| g.is_some())
                            .unwrap_or(false);
                        let _ = state.connection_generation.load(Ordering::SeqCst);
                        // CR-02: don't start a second supervisor if one is already live
                        // (e.g. the sidecar Terminated arm already handed this drop off).
                        let supervisor_live =
                            state.reconnect_in_progress.load(Ordering::SeqCst);
                        if !user_disconnecting
                            && !supervisor_live
                            && has_config
                            && crate::start_reconnect_supervisor_from_state(&app)
                        {
                            // The supervisor now owns recovery for this drop. Reset monitor
                            // state and resume polling; do NOT also run the adapter-recovery
                            // wait + `reconnect` emit below (the React-driven path the
                            // supervisor replaces).
                            consecutive_failures = 0;
                            was_online = false;
                            was_connected = false;
                            continue;
                        }
                    }

                    // Fallback path (no AppState / no saved config / user disconnecting):
                    // keep the legacy adapter-recovery wait so the UI still gets a recovery
                    // signal. Now wait for the physical network adapter to come back.
                    eprintln!("[connectivity] Waiting for network adapter to recover...");
                    let mut adapter_wait = 0u32;
                    let mut recovered = false;
                    loop {
                        tokio::time::sleep(Duration::from_secs(ADAPTER_POLL_INTERVAL_SECS)).await;
                        adapter_wait += 1;

                        // If user reconnected VPN manually, exit recovery without emitting reconnect
                        let already_reconnected = is_connected.lock().map(|g| *g).unwrap_or(false);
                        if already_reconnected {
                            log_app("INFO", "[connectivity] VPN reconnected externally, exiting recovery loop");
                            recovered = true;
                            break;
                        }

                        if check_adapter_online().await {
                            eprintln!("[connectivity] Network adapter back online after {adapter_wait} checks");
                            log_app("INFO", &format!("[connectivity] Adapter recovered after {adapter_wait} checks"));
                            // Give adapter a moment to fully stabilize
                            tokio::time::sleep(Duration::from_secs(3)).await;
                            app.emit("internet-status", serde_json::json!({
                                "online": true,
                                "action": "reconnect"
                            })).ok();
                            recovered = true;
                            break;
                        }

                        // Give up after ~5 minutes of waiting
                        // (ADAPTER_RECOVERY_TIMEOUT_CHECKS × ADAPTER_POLL_INTERVAL_SECS)
                        if adapter_wait >= ADAPTER_RECOVERY_TIMEOUT_CHECKS {
                            eprintln!("[connectivity] Gave up waiting for adapter after 5 minutes");
                            log_app("WARN", "[connectivity] Gave up waiting for adapter after 5 minutes");
                            app.emit("internet-status", serde_json::json!({
                                "online": false,
                                "action": "give_up"
                            })).ok();
                            break;
                        }
                    }

                    // Reset state for next monitoring cycle
                    consecutive_failures = 0;
                    was_online = recovered;
                    // WR-05 (mirror of Pro): re-arm the post-connect grace skip. If
                    // recovery exited because the user reconnected externally, leaving
                    // was_connected=true would bypass the "skip first check cycle after
                    // connect" grace period, letting the monitor probe a freshly-restarted
                    // DNS proxy and false-positive an offline drop right after a
                    // recovery-driven reconnect. Resetting it forces the next connected
                    // cycle to re-arm the grace skip.
                    was_connected = false;
                }
            }
        }
    });
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
            a.ip_addresses().iter().any(|ip| ip.is_ipv4())
                && a.gateways().iter().any(|gw| gw.is_ipv4())
        })?;

    let ip = adapter.ip_addresses().iter().copied().find(|ip| ip.is_ipv4())?;
    let gateway = adapter.gateways().iter().copied().find(|gw| gw.is_ipv4())?;

    log_app("DEBUG", &format!("[connectivity] Physical adapter: ip={ip}, gateway={gateway}"));
    Some(AdapterInfo { ip, gateway })
}

/// Active TUNNEL-path liveness probe (02-07, UAT Gap #1) — mirror of Pro.
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
    // upstream through the tunnel. NOT bound to the physical adapter, so while VPN
    // is up these travel through the tunnel (the whole point). Endpoints match Pro.
    let http_endpoints = [
        "https://clients3.google.com/generate_204",
        "https://cp.cloudflare.com",
        "http://www.msftconnecttest.com/connecttest.txt",
    ];

    for url in http_endpoints {
        let result = tokio::time::timeout(
            Duration::from_secs(TUNNEL_PROBE_TIMEOUT_SECS),
            client.get(url).send(),
        )
        .await;

        match result {
            Ok(Ok(resp)) => {
                if resp.status().is_success() || resp.status().as_u16() == 204 {
                    log_app("DEBUG", &format!("[connectivity] Tunnel probe {url} => OK"));
                    return true;
                }
            }
            _ => continue,
        }
    }

    log_app("DEBUG", "[connectivity] Tunnel probe: all endpoints failed");
    false
}

/// Check if the physical network adapter has connectivity (without VPN).
/// Used during adapter recovery — VPN is disconnected, so we check gateway directly.
///
/// 02-09 (UAT Gap #2): ALSO reused by `vpn_connect` as a NON-BLOCKING pre-flight to
/// classify a never-connected sidecar exit as `no-internet` vs `sidecar-exit`. Made
/// `pub(crate)` for that reuse (mirror of Pro); the body is unchanged.
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

        log_app("DEBUG", &format!("[connectivity] adapter_online gateway TCP: {tcp_ok}"));

        if tcp_ok {
            return true;
        }
    }

    // Fallback: HTTP without bind (VPN is disconnected during recovery)
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
        // 02-07 (UAT Gap #1) mirror of Pro: assert the tightened cadence keeps the
        // worst-case declaration window ~10-15s, collapsing the old ~80s floor. Byte-
        // identical assertions to Pro so the two editions can never drift apart.
        let cadence_floor = Duration::from_secs(POLL_INTERVAL_SECS) * MAX_FAILURES;
        assert!(
            cadence_floor <= Duration::from_secs(15),
            "cadence floor must be ~10-15s, got {cadence_floor:?}",
        );
        assert!(
            cadence_floor < Duration::from_secs(20),
            "cadence floor must collapse the old ~80s floor",
        );
        assert!(TUNNEL_PROBE_TIMEOUT_SECS <= 5);
        let worst_case = cadence_floor + Duration::from_secs(TUNNEL_PROBE_TIMEOUT_SECS * 2);
        assert!(
            worst_case < Duration::from_secs(30),
            "worst-case detection window must be far below the old ~95-140s, got {worst_case:?}",
        );
        assert!(MAX_FAILURES >= 2, "must tolerate at least one transient miss");
    }

    #[test]
    fn resume_gap_detects_suspend_not_a_slow_probe() {
        // 02-10 (Tier-3) mirror of Pro: a normal iteration gap (cadence + slow probe)
        // must NOT be read as a resume, but a real multi-minute suspend must.
        assert!(!is_resume_gap(Duration::from_secs(POLL_INTERVAL_SECS)));
        assert!(!is_resume_gap(Duration::from_secs(10)));
        assert!(!is_resume_gap(Duration::from_secs(RESUME_GAP_THRESHOLD_SECS - 1)));
        assert!(is_resume_gap(Duration::from_secs(RESUME_GAP_THRESHOLD_SECS)));
        assert!(is_resume_gap(Duration::from_secs(600)));
        let worst_case_iteration =
            Duration::from_secs(POLL_INTERVAL_SECS) + Duration::from_secs(TUNNEL_PROBE_TIMEOUT_SECS * 2);
        assert!(
            !is_resume_gap(worst_case_iteration),
            "a worst-case normal iteration must never be mistaken for a resume",
        );
    }

    #[test]
    fn reason_codes_are_ascii_and_cyrillic_free() {
        // T-07-02 / D-09/D-29: offline reason codes are STABLE ASCII tokens — and
        // BYTE-IDENTICAL to Pro so the shared frontend i18n mapping works for both.
        for reason in [TUNNEL_LOST_REASON, INTERNET_LOST_REASON] {
            assert!(reason.is_ascii(), "reason code {reason:?} must be ASCII");
            assert!(
                !reason.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)),
                "reason code {reason:?} must contain NO Cyrillic",
            );
        }
        assert_ne!(TUNNEL_LOST_REASON, INTERNET_LOST_REASON);
        assert_eq!(TUNNEL_LOST_REASON, "tunnel-lost");
        assert_eq!(INTERNET_LOST_REASON, "internet-lost");
    }
}
