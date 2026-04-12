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
/// Connectivity checks use the physical adapter's gateway (local subnet)
/// instead of public IPs. This avoids routing conflicts: when VPN is active,
/// public IPs route through the tunnel, but gateway is always on the local
/// subnet and never routed through VPN.
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
            tokio::time::sleep(Duration::from_secs(15)).await;

            // Only check when VPN is connected
            let vpn_up = is_connected.lock().map(|g| *g).unwrap_or(false);
            if !vpn_up {
                consecutive_failures = 0;
                was_online = true;
                was_connected = false;
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
                    eprintln!("[connectivity] Waiting for network adapter to recover...");
                    let mut adapter_wait = 0u32;
                    let mut recovered = false;
                    loop {
                        tokio::time::sleep(Duration::from_secs(5)).await;
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
                    was_online = recovered;
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

    log_app("DEBUG", &format!("[connectivity] Physical adapter: ip={}, gateway={}", ip, gateway));
    Some(AdapterInfo { ip, gateway })
}

/// Check connectivity by probing the physical adapter's gateway.
/// Gateway is on the local subnet — never routed through VPN.
async fn check_connectivity() -> bool {
    let adapter = find_physical_adapter();

    match &adapter {
        Some(info) => {
            eprintln!("[connectivity] Using physical adapter: {} -> gateway {}", info.ip, info.gateway);
            log_app("DEBUG", &format!("[connectivity] Cycle: ip={}, gateway={}", info.ip, info.gateway));
        }
        None => {
            eprintln!("[connectivity] No physical adapter found, using default routing");
            log_app("DEBUG", "[connectivity] Cycle: no physical adapter");
        }
    }

    // Method 1: TCP connect to gateway via socket2 bound to physical adapter.
    // Gateway is on local subnet — traffic never goes through VPN tunnel.
    if let Some(ref info) = adapter {
        let adapter_ip = info.ip;
        let gateway_ip = info.gateway;
        let tcp_ok = tokio::task::spawn_blocking(move || {
            let ports = [80u16, 443, 53];
            for port in ports {
                let target = SocketAddr::new(gateway_ip, port);
                let socket = match Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                if socket.bind(&SockAddr::from(SocketAddr::new(adapter_ip, 0))).is_err() {
                    continue;
                }

                if socket
                    .connect_timeout(&SockAddr::from(target), Duration::from_secs(3))
                    .is_ok()
                {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);

        log_app("DEBUG", &format!("[connectivity] Gateway TCP result: {}", tcp_ok));

        if tcp_ok {
            return true;
        }
    }

    // Method 2: HTTP endpoints via default routing (fallback)
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
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
/// Used during adapter recovery — VPN is disconnected, so we check gateway directly.
async fn check_adapter_online() -> bool {
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
