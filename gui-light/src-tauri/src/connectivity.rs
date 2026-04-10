use socket2::{Socket, Domain, Type, Protocol, SockAddr};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

use crate::logging::log_app;

/// Periodically check internet connectivity while VPN is connected.
/// Emits "internet-status" events with { online: bool } payload.
/// When internet drops, waits for the primary network adapter to come back
/// before signaling the frontend to reconnect.
///
/// Uses multiple check methods to avoid false positives:
/// 1. TCP connect via socket2 bound to physical adapter (bypasses VPN routing)
/// 2. HTTP captive portal endpoints as fallback
pub fn start_monitor(
    app: tauri::AppHandle,
    is_connected: Arc<Mutex<bool>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures: u32 = 0;
        let mut was_online = true;
        // Wait a bit before starting checks (let VPN establish)
        tokio::time::sleep(Duration::from_secs(15)).await;

        log_app("INFO", "[connectivity] Monitor started");

        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;

            // Only check when VPN is connected
            let vpn_up = is_connected.lock().map(|g| *g).unwrap_or(false);
            if !vpn_up {
                consecutive_failures = 0;
                was_online = true;
                continue;
            }

            let online = check_connectivity().await;

            if online {
                if !was_online {
                    eprintln!("[connectivity] Internet restored");
                    log_app("INFO", "[connectivity] Internet restored");
                    app.emit("internet-status", serde_json::json!({ "online": true })).ok();
                }
                consecutive_failures = 0;
                was_online = true;
            } else {
                consecutive_failures += 1;
                eprintln!("[connectivity] Check failed ({consecutive_failures}/3)");
                // Declare offline after 3 consecutive failures (~45 seconds)
                if consecutive_failures >= 3 && was_online {
                    eprintln!("[connectivity] Internet appears down — telling frontend to disconnect VPN");
                    log_app("WARN", "[connectivity] Declaring offline after 3 failures");
                    was_online = false;

                    // Tell frontend: disconnect VPN, then we'll monitor adapter recovery
                    app.emit("internet-status", serde_json::json!({
                        "online": false,
                        "action": "disconnect"
                    })).ok();

                    // Now wait for the physical network adapter to come back
                    // VPN is being disconnected by frontend, so is_connected will go false
                    // We poll until basic connectivity (without VPN) is restored
                    eprintln!("[connectivity] Waiting for network adapter to recover...");
                    let mut adapter_wait = 0u32;
                    let mut recovered = false;
                    loop {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        adapter_wait += 1;

                        if check_adapter_online().await {
                            eprintln!("[connectivity] Network adapter back online after {adapter_wait} checks");
                            log_app("INFO", &format!("[connectivity] Adapter recovered after {} checks", adapter_wait));
                            // Give adapter a moment to fully stabilize
                            tokio::time::sleep(Duration::from_secs(3)).await;
                            app.emit("internet-status", serde_json::json!({
                                "online": true,
                                "action": "reconnect"
                            })).ok();
                            recovered = true;
                            break;
                        }

                        // Give up after 5 minutes of waiting (60 checks × 5 s)
                        if adapter_wait >= 60 {
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
                    // Only mark as online if adapter actually recovered;
                    // otherwise keep was_online=false to avoid re-triggering disconnect
                    was_online = recovered;
                }
            }
        }
    });
}

/// Find the local IP of the primary physical network adapter (not VPN, not loopback).
/// Returns None if no suitable adapter found — caller should fall back to default routing.
fn find_physical_adapter_ip() -> Option<IpAddr> {
    let adapters = ipconfig::get_adapters().ok()?;

    let result = adapters
        .iter()
        .filter(|a| a.oper_status() == ipconfig::OperStatus::IfOperStatusUp)
        .filter(|a| !a.gateways().is_empty())
        .filter(|a| {
            // Only physical adapter types: Ethernet (6) and WiFi (71)
            // Excludes WinTUN (53), PPP (23), loopback, etc.
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
        .flat_map(|a| a.ip_addresses().iter().copied())
        .find(|ip| ip.is_ipv4());

    if let Some(ip) = result {
        log_app("DEBUG", &format!("[connectivity] Physical adapter found: {}", ip));
    } else {
        log_app("DEBUG", "[connectivity] No physical adapter found");
    }

    result
}

/// Check internet connectivity using multiple methods, binding to the physical
/// network adapter to bypass VPN routing. Returns true if ANY method succeeds.
async fn check_connectivity() -> bool {
    let physical_ip = find_physical_adapter_ip();

    if let Some(ip) = physical_ip {
        eprintln!("[connectivity] Using physical adapter: {ip}");
    } else {
        eprintln!("[connectivity] No physical adapter found, using default routing");
    }

    log_app("DEBUG", &format!("[connectivity] Cycle: physical_ip={:?}", physical_ip));

    // Method 1: TCP connect via socket2 bound to physical adapter.
    // Uses spawn_blocking because socket2 is synchronous.
    // Light uses 2 targets (Pro uses 3).
    let tcp_ip = physical_ip;
    let tcp_ok = tokio::task::spawn_blocking(move || {
        let targets = [
            SocketAddr::new([1, 1, 1, 1].into(), 443),  // Cloudflare DNS
            SocketAddr::new([8, 8, 8, 8].into(), 443),  // Google DNS
        ];

        for target in targets {
            let socket = match Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) {
                Ok(s) => s,
                Err(_) => continue,
            };

            // Bind to physical adapter IP (port 0 = OS picks ephemeral port)
            if let Some(ip) = tcp_ip {
                if socket.bind(&SockAddr::from(SocketAddr::new(ip, 0))).is_err() {
                    continue;
                }
            }

            if socket
                .connect_timeout(&SockAddr::from(target), Duration::from_secs(4))
                .is_ok()
            {
                return true;
            }
        }

        false
    })
    .await
    .unwrap_or(false);

    log_app("DEBUG", &format!("[connectivity] TCP result: {}", tcp_ok));

    if tcp_ok {
        return true;
    }

    // Method 2: HTTP captive portal endpoints bound to physical adapter (fallback)
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .local_address(physical_ip)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log_app("WARN", &format!("[connectivity] Failed to build bound HTTP client: {e}"));
            // A default client routes through VPN, producing false positives — skip HTTP check
            return false;
        }
    };

    let http_endpoints = [
        "https://clients3.google.com/generate_204",
        "https://cp.cloudflare.com",
    ];

    for url in http_endpoints {
        let result = tokio::time::timeout(Duration::from_secs(5), client.get(url).send()).await;

        match result {
            Ok(Ok(resp)) => {
                if resp.status().is_success() || resp.status().as_u16() == 204 {
                    log_app("DEBUG", &format!("[connectivity] HTTP {} => OK", url));
                    return true;
                }
            }
            _ => continue,
        }
    }

    log_app("DEBUG", "[connectivity] All checks failed");
    false
}

/// Check if the physical network adapter has connectivity (without VPN).
/// Uses TCP connect + HTTP check bound to the physical adapter IP.
async fn check_adapter_online() -> bool {
    let physical_ip = find_physical_adapter_ip();

    // Quick TCP check first via socket2 bound to physical adapter
    let tcp_ip = physical_ip;
    let tcp_ok = tokio::task::spawn_blocking(move || {
        let target = SocketAddr::new([1, 1, 1, 1].into(), 443);
        let socket = match Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) {
            Ok(s) => s,
            Err(_) => return false,
        };

        if let Some(ip) = tcp_ip {
            if socket.bind(&SockAddr::from(SocketAddr::new(ip, 0))).is_err() {
                return false;
            }
        }

        socket
            .connect_timeout(&SockAddr::from(target), Duration::from_secs(3))
            .is_ok()
    })
    .await
    .unwrap_or(false);

    log_app("DEBUG", &format!("[connectivity] adapter_online TCP: {}", tcp_ok));

    if tcp_ok {
        return true;
    }

    // Fallback: HTTP captive portal bound to physical adapter
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .local_address(physical_ip)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log_app("WARN", &format!("[connectivity] Failed to build bound HTTP client: {e}"));
            return false;
        }
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
