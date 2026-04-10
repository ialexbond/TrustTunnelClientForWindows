use socket2::{Socket, Domain, Type, Protocol, SockAddr};
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;
use tokio::net::TcpStream;

/// Periodically check internet connectivity while VPN is connected.
/// Emits "internet-status" events with { online: bool } payload.
/// When internet drops, waits for the primary network adapter to come back
/// before signaling the frontend to reconnect.
///
/// Uses multiple check methods to avoid false positives:
/// 1. TCP connect to well-known endpoints (doesn't depend on VPN routing rules)
/// 2. HTTP captive portal endpoints as fallback
pub fn start_monitor(
    app: tauri::AppHandle,
    is_connected: Arc<Mutex<bool>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures: u32 = 0;
        let mut was_online = true;
        // Wait a bit before starting checks (let VPN fully establish)
        tokio::time::sleep(Duration::from_secs(30)).await;

        loop {
            tokio::time::sleep(Duration::from_secs(20)).await;

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
                    app.emit("internet-status", serde_json::json!({ "online": true })).ok();
                }
                consecutive_failures = 0;
                was_online = true;
            } else {
                consecutive_failures += 1;
                eprintln!("[connectivity] Check failed ({consecutive_failures}/4)");
                // Declare offline after 4 consecutive failures (~80+ seconds)
                // to avoid false positives from transient network hiccups
                if consecutive_failures >= 4 && was_online {
                    eprintln!("[connectivity] Internet appears down — telling frontend to disconnect VPN");
                    was_online = false;

                    // Tell frontend: disconnect VPN, then we'll monitor adapter recovery
                    app.emit("internet-status", serde_json::json!({
                        "online": false,
                        "action": "disconnect"
                    })).ok();

                    // Now wait for the physical network adapter to come back
                    eprintln!("[connectivity] Waiting for network adapter to recover...");
                    let mut adapter_wait = 0u32;
                    loop {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        adapter_wait += 1;

                        if check_adapter_online().await {
                            eprintln!("[connectivity] Network adapter back online after {adapter_wait} checks");
                            // Give adapter a moment to fully stabilize
                            tokio::time::sleep(Duration::from_secs(3)).await;
                            app.emit("internet-status", serde_json::json!({
                                "online": true,
                                "action": "reconnect"
                            })).ok();
                            break;
                        }

                        // Give up after 5 minutes of waiting
                        if adapter_wait > 60 {
                            eprintln!("[connectivity] Gave up waiting for adapter after 5 minutes");
                            app.emit("internet-status", serde_json::json!({
                                "online": false,
                                "action": "give_up"
                            })).ok();
                            break;
                        }
                    }

                    // Reset state for next monitoring cycle
                    consecutive_failures = 0;
                    was_online = true;
                }
            }
        }
    });
}

/// Find the local IP of the primary physical network adapter (not VPN, not loopback).
/// Returns None if no suitable adapter found — caller should fall back to default routing.
fn find_physical_adapter_ip() -> Option<IpAddr> {
    let adapters = ipconfig::get_adapters().ok()?;

    adapters
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
        .find(|ip| ip.is_ipv4())
}

/// Check internet connectivity using multiple methods.
/// Returns true if ANY method succeeds — prevents false "offline" from VPN routing.
async fn check_connectivity() -> bool {
    // Method 1: TCP connect to well-known reliable hosts on port 443.
    // This works even when VPN routing doesn't allow HTTP to these hosts,
    // because TCP SYN/ACK proves the network path is alive.
    let tcp_targets = [
        ("1.1.1.1", 443),       // Cloudflare DNS
        ("8.8.8.8", 443),       // Google DNS
        ("208.67.222.222", 443), // OpenDNS
    ];

    for (host, port) in tcp_targets {
        if let Ok(addr) = format!("{host}:{port}").to_socket_addrs() {
            for a in addr {
                let result = tokio::time::timeout(
                    Duration::from_secs(4),
                    TcpStream::connect(a),
                ).await;
                if let Ok(Ok(_)) = result {
                    return true;
                }
            }
        }
    }

    // Method 2: HTTP captive portal endpoints (fallback)
    let http_endpoints = [
        "https://clients3.google.com/generate_204",
        "https://cp.cloudflare.com",
        "http://www.msftconnecttest.com/connecttest.txt",
    ];

    for url in http_endpoints {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            reqwest::get(url),
        ).await;

        match result {
            Ok(Ok(resp)) => {
                if resp.status().is_success() || resp.status().as_u16() == 204 {
                    return true;
                }
            }
            _ => continue,
        }
    }
    false
}

/// Check if the physical network adapter has connectivity (without VPN).
/// Uses a simple TCP connect + HTTP check to verify the adapter is up.
async fn check_adapter_online() -> bool {
    // Quick TCP check first
    let tcp_result = tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect("1.1.1.1:443"),
    ).await;
    if let Ok(Ok(_)) = tcp_result {
        return true;
    }

    // Fallback: HTTP captive portal
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        reqwest::get("http://clients3.google.com/generate_204"),
    ).await;

    match result {
        Ok(Ok(resp)) => resp.status().as_u16() == 204 || resp.status().is_success(),
        _ => false,
    }
}
