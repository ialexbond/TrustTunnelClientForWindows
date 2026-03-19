use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

/// Periodically check internet connectivity while VPN is connected.
/// Emits "internet-status" events with { online: bool } payload.
/// When internet drops, waits for the primary network adapter to come back
/// before signaling the frontend to reconnect.
pub fn start_monitor(
    app: tauri::AppHandle,
    is_connected: Arc<Mutex<bool>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures: u32 = 0;
        let mut was_online = true;
        // Wait a bit before starting checks (let VPN establish)
        tokio::time::sleep(Duration::from_secs(15)).await;

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

/// Check internet connectivity via lightweight HTTP endpoints.
async fn check_connectivity() -> bool {
    let endpoints = [
        "https://clients3.google.com/generate_204",
        "https://cp.cloudflare.com",
    ];

    for url in endpoints {
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
/// Uses a simple DNS resolution + TCP check to verify the adapter is up.
async fn check_adapter_online() -> bool {
    // After VPN disconnect, try to reach a simple endpoint over plain internet
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        reqwest::get("http://clients3.google.com/generate_204"),
    ).await;

    match result {
        Ok(Ok(resp)) => resp.status().as_u16() == 204 || resp.status().is_success(),
        _ => false,
    }
}
