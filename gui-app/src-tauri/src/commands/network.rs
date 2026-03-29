/// Run a simple speed test using Cloudflare endpoints.
/// Returns { download_mbps, upload_mbps } or an error.
#[tauri::command]
pub async fn speedtest_run() -> Result<serde_json::Value, String> {
    use std::time::Instant;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Download test: fetch 5MB from Cloudflare
    let dl_bytes: usize = 5_000_000;
    let dl_url = format!("https://speed.cloudflare.com/__down?bytes={dl_bytes}");
    let dl_start = Instant::now();
    let dl_resp = client
        .get(&dl_url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;
    let dl_data = dl_resp
        .bytes()
        .await
        .map_err(|e| format!("Download read failed: {e}"))?;
    let dl_elapsed = dl_start.elapsed().as_secs_f64();
    let dl_actual = dl_data.len() as f64;
    let download_mbps = if dl_elapsed > 0.0 {
        (dl_actual * 8.0) / (dl_elapsed * 1_000_000.0)
    } else {
        0.0
    };

    // Upload test: send 2MB to Cloudflare
    let ul_size: usize = 2_000_000;
    let ul_payload = vec![0u8; ul_size];
    let ul_start = Instant::now();
    let _ul_resp = client
        .post("https://speed.cloudflare.com/__up")
        .body(ul_payload)
        .send()
        .await
        .map_err(|e| format!("Upload request failed: {e}"))?;
    let ul_elapsed = ul_start.elapsed().as_secs_f64();
    let upload_mbps = if ul_elapsed > 0.0 {
        (ul_size as f64 * 8.0) / (ul_elapsed * 1_000_000.0)
    } else {
        0.0
    };

    Ok(serde_json::json!({
        "download_mbps": (download_mbps * 10.0).round() / 10.0,
        "upload_mbps": (upload_mbps * 10.0).round() / 10.0,
    }))
}

/// HTTP-based health check using the TrustTunnel _check endpoint.
/// Returns { ok: bool, latency_ms: i64, error?: string }.
/// This is more reliable than TCP ping — verifies the VPN endpoint is actually serving.
#[tauri::command]
pub async fn health_check(host: String, port: u16) -> serde_json::Value {
    use std::time::Instant;

    let url = format!("https://{host}:{port}/_check");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(7))
        .danger_accept_invalid_certs(true) // self-signed certs are common
        .build()
        .unwrap_or_default();

    let start = Instant::now();
    match client.get(&url).send().await {
        Ok(resp) => {
            let latency = start.elapsed().as_millis() as i64;
            serde_json::json!({
                "ok": resp.status().is_success() || resp.status().as_u16() == 407,
                "latency_ms": latency,
                "status": resp.status().as_u16(),
            })
        }
        Err(e) => {
            serde_json::json!({
                "ok": false,
                "latency_ms": -1,
                "error": e.to_string(),
            })
        }
    }
}

/// Measure TCP connect latency to a host:port (in milliseconds).
/// Returns -1 if unreachable.
#[tauri::command]
pub async fn ping_endpoint(host: String, port: u16) -> i64 {
    use std::net::ToSocketAddrs;
    use std::time::Instant;

    let addr_str = format!("{host}:{port}");
    let addr = match addr_str.to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(a) => a,
            None => return -1,
        },
        Err(_) => return -1,
    };

    let start = Instant::now();
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    {
        Ok(Ok(_stream)) => start.elapsed().as_millis() as i64,
        _ => -1,
    }
}
