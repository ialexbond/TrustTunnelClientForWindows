use super::super::*;
use russh::client;

/// Fetch service logs from the remote server.
pub async fn server_get_logs(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;

    let (logs, _) = exec_command(
        handle,
        app,
        &format!("{sudo}journalctl -u trusttunnel --no-pager -n 100 2>/dev/null || {sudo}tail -100 {dir}/logs/*.log 2>/dev/null || echo 'No logs found'", dir = ENDPOINT_DIR),
    )
    .await?;

    Ok(logs)
}

/// Get server resource stats: CPU, RAM, disk, active VPN connections.
pub async fn server_get_stats(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<serde_json::Value, String> {
    // Single compound command to minimize SSH roundtrips
    // CPU: two /proc/stat samples 1s apart for actual current usage
    let cmd = format!(concat!(
        "echo '---CPU---' && ",
        "C1=$(grep 'cpu ' /proc/stat) && sleep 1 && C2=$(grep 'cpu ' /proc/stat) && echo \"$C1\" && echo \"$C2\" && ",
        "echo '---LOAD---' && ",
        "cat /proc/loadavg && ",
        "echo '---MEM---' && ",
        "free -b | grep Mem && ",
        "echo '---DISK---' && ",
        "df -B1 / | tail -1 && ",
        "echo '---CONNS---' && ",
        "TT_PID=$(pgrep -f '{dir}/bin/trusttunnel' 2>/dev/null | head -1); ",
        "if [ -n \"$TT_PID\" ]; then ",
        "  ss -tnp state established 2>/dev/null | grep \"pid=$TT_PID\" | awk '{{print $NF}}' | rev | cut -d: -f2- | rev | sort -u | wc -l; ",
        "else echo 0; fi && ",
        "echo '---CONNS_TOTAL---' && ",
        "if [ -n \"$TT_PID\" ]; then ",
        "  ss -tnp state established 2>/dev/null | grep \"pid=$TT_PID\" | wc -l; ",
        "else echo 0; fi && ",
        "echo '---UPTIME---' && ",
        "cat /proc/uptime"
    ), dir = ENDPOINT_DIR);

    let (output, _) = exec_command(handle, app, &cmd).await?;

    // Parse output
    let mut cpu_usage: f64 = 0.0;
    let mut cpu_samples: Vec<Vec<f64>> = Vec::new();
    let mut load_1m: f64 = 0.0;
    let mut load_5m: f64 = 0.0;
    let mut load_15m: f64 = 0.0;
    let mut mem_total: u64 = 0;
    let mut mem_used: u64 = 0;
    let mut disk_total: u64 = 0;
    let mut disk_used: u64 = 0;
    let mut unique_ips: u64 = 0;
    let mut total_conns: u64 = 0;
    let mut server_uptime: f64 = 0.0;

    let mut section = "";
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("---") && trimmed.ends_with("---") {
            section = trimmed;
            continue;
        }
        match section {
            "---CPU---" => {
                // Two samples: cpu  user nice system idle iowait irq softirq steal
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 5 && parts[0] == "cpu" {
                    let vals: Vec<f64> = parts[1..].iter().map(|s| s.parse().unwrap_or(0.0)).collect();
                    cpu_samples.push(vals);
                    if cpu_samples.len() == 2 {
                        let total1: f64 = cpu_samples[0].iter().sum();
                        let total2: f64 = cpu_samples[1].iter().sum();
                        let idle1 = cpu_samples[0].get(3).copied().unwrap_or(0.0);
                        let idle2 = cpu_samples[1].get(3).copied().unwrap_or(0.0);
                        let total_diff = total2 - total1;
                        let idle_diff = idle2 - idle1;
                        if total_diff > 0.0 {
                            cpu_usage = (((total_diff - idle_diff) / total_diff) * 100.0 * 10.0).round() / 10.0;
                        }
                    }
                }
            }
            "---LOAD---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    load_1m = parts[0].parse().unwrap_or(0.0);
                    load_5m = parts[1].parse().unwrap_or(0.0);
                    load_15m = parts[2].parse().unwrap_or(0.0);
                }
            }
            "---MEM---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 3 {
                    mem_total = parts[1].parse().unwrap_or(0);
                    mem_used = parts[2].parse().unwrap_or(0);
                }
            }
            "---DISK---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if parts.len() >= 4 {
                    disk_total = parts[1].parse().unwrap_or(0);
                    disk_used = parts[2].parse().unwrap_or(0);
                }
            }
            "---CONNS---" => {
                unique_ips = trimmed.parse().unwrap_or(0);
            }
            "---CONNS_TOTAL---" => {
                total_conns = trimmed.parse().unwrap_or(0);
            }
            "---UPTIME---" => {
                let parts: Vec<&str> = trimmed.split_whitespace().collect();
                if !parts.is_empty() {
                    server_uptime = parts[0].parse().unwrap_or(0.0);
                }
            }
            _ => {}
        }
    }

    Ok(serde_json::json!({
        "cpu_percent": cpu_usage,
        "load_1m": load_1m,
        "load_5m": load_5m,
        "load_15m": load_15m,
        "mem_total": mem_total,
        "mem_used": mem_used,
        "disk_total": disk_total,
        "disk_used": disk_used,
        "unique_ips": unique_ips,
        "total_connections": total_conns,
        "uptime_seconds": server_uptime,
    }))
}

/// Phase 16 — Pure helper extracts cert fields from `openssl x509` output.
///
/// Pulled out для unit-test isolation (no SSH/AppHandle setup needed).
/// Output JSON object preserves backwards-compat keys (notAfter / issuer / subject)
/// и добавляет Phase 16 fields (notBefore / sha256Fingerprint).
///
/// Expected input format (from `openssl x509 ... -fingerprint -sha256 -subject -issuer -startdate -enddate`):
/// ```text
/// sha256 Fingerprint=AA:BB:...:ZZ
/// subject=CN = example.com
/// issuer=C = US, O = Let's Encrypt, CN = R3
/// notBefore=Apr 28 12:00:00 2026 GMT
/// notAfter=Jul 27 12:00:00 2026 GMT
/// ```
pub fn parse_openssl_cert_output(cert_info: &str) -> serde_json::Value {
    let mut not_after = String::new();
    let mut not_before = String::new();
    let mut issuer = String::new();
    let mut subject = String::new();
    let mut sha256_fingerprint = String::new();

    for line in cert_info.lines() {
        let trimmed = line.trim();
        if let Some(val) = trimmed.strip_prefix("notAfter=") {
            not_after = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("notBefore=") {
            not_before = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("issuer=") {
            issuer = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("subject=") {
            subject = val.trim().to_string();
        } else if let Some(val) = trimmed.strip_prefix("sha256 Fingerprint=") {
            sha256_fingerprint = val.trim().to_string();
        }
    }

    serde_json::json!({
        "notAfter": not_after,
        "notBefore": not_before,
        "issuer": issuer,
        "subject": subject,
        "sha256Fingerprint": sha256_fingerprint,
    })
}

/// Fetch TLS certificate information from the remote server.
///
/// Phase 16 (D-5.1) — extends additively с `sha256Fingerprint` + `notBefore`.
/// `notAfter` / `issuer` / `subject` / `autoRenew` keys preserved для backwards-compat
/// (per R-9 — OverviewSection security summary block consumes existing shape).
pub async fn get_cert_info(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<serde_json::Value, String> {
    let sudo = detect_sudo(handle, app).await;

    // Get hostname from hosts.toml
    let (hostname_raw, _) = exec_command(
        handle,
        app,
        &format!(r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR),
    )
    .await?;
    let hostname = hostname_raw.trim().to_string();

    // Get cert path from hosts.toml
    let (cert_path_raw, _) = exec_command(
        handle,
        app,
        &format!(r#"{sudo}grep -oP 'cert_chain_path\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR),
    )
    .await?;
    let cert_path = cert_path_raw.trim().to_string();

    // Resolve cert path (relative paths are relative to ENDPOINT_DIR)
    let resolved_cert_path = if cert_path.starts_with('/') {
        cert_path.clone()
    } else {
        format!("{}/{cert_path}", ENDPOINT_DIR)
    };

    // Phase 16: extended openssl call — добавляет -fingerprint -sha256 + -startdate.
    // Path A (RESEARCH.md CQ-4) — extend existing openssl call vs separate cert_probe.rs roundtrip.
    let (cert_info, cert_code) = exec_command(
        handle,
        app,
        &format!("{sudo}openssl x509 -in {resolved_cert_path} -noout -fingerprint -sha256 -subject -issuer -startdate -enddate 2>&1"),
    )
    .await?;

    // Parse via pure helper (testable без SSH setup).
    let parsed = if cert_code == 0 {
        parse_openssl_cert_output(&cert_info)
    } else {
        // Empty defaults preserved for failed parse — UI handles "unknown" state.
        serde_json::json!({
            "notAfter": "",
            "notBefore": "",
            "issuer": "",
            "subject": "",
            "sha256Fingerprint": "",
        })
    };
    let parsed_obj = parsed
        .as_object()
        .expect("parse_openssl_cert_output returns object");

    // Check auto-renewal cron
    let (renew_check, _) = exec_command(
        handle,
        app,
        &format!("{sudo}test -f /etc/cron.d/trusttunnel-cert-renew && echo \"true\" || echo \"false\""),
    )
    .await?;
    let auto_renew = renew_check.trim() == "true";

    Ok(serde_json::json!({
        "hostname": hostname,
        "certPath": resolved_cert_path,
        "notAfter": parsed_obj.get("notAfter").cloned().unwrap_or_default(),
        "notBefore": parsed_obj.get("notBefore").cloned().unwrap_or_default(),
        "issuer": parsed_obj.get("issuer").cloned().unwrap_or_default(),
        "subject": parsed_obj.get("subject").cloned().unwrap_or_default(),
        "sha256Fingerprint": parsed_obj
            .get("sha256Fingerprint")
            .cloned()
            .unwrap_or_default(),
        "autoRenew": auto_renew,
    }))
}

/// Force-renew the TLS certificate via certbot and restart the service.
pub async fn renew_cert(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;

    // If UFW is active and port 80 is not currently open, temporarily open it for the
    // HTTP-01 challenge — and remove the rule afterwards. This lets users keep port 80
    // closed in normal operation while still allowing certbot renewals.
    let (ufw_status, _) = exec_command(
        handle, app,
        &format!("{sudo}ufw status 2>/dev/null | head -20"),
    ).await.unwrap_or_default();
    // NOTE: `"inactive".contains("active")` is true — must parse exact value.
    let ufw_active = ufw_status
        .lines()
        .next()
        .and_then(|l| l.split(':').nth(1))
        .map(|s| s.trim() == "active")
        .unwrap_or(false);
    let port80_already_open = ufw_active && ufw_status.lines().any(|l| {
        let t = l.trim();
        t.starts_with("80/tcp") || t.starts_with("80 ") || t.contains(" 80/tcp ")
    });
    let temporarily_opened_80 = if ufw_active && !port80_already_open {
        emit_log(app, "info", "UFW: temporarily opening 80/tcp for cert renewal");
        let _ = exec_command(handle, app, &format!("{sudo}ufw allow 80/tcp comment 'cert renewal (temporary)'")).await;
        true
    } else { false };

    // Step 1: Kill stale certbot + run renewal.
    let _ = exec_command(
        handle, app,
        &format!("{sudo}pkill -9 certbot 2>/dev/null; {sudo}rm -f /tmp/.certbot.lock /var/lib/letsencrypt/.certbot.lock 2>/dev/null; true"),
    ).await;

    emit_log(app, "info", "Running certbot renew --force-renewal ...");
    // P UAT 2026-05-06: добавлен --no-random-sleep-on-renew. Без него certbot
    // в non-interactive режиме перед попыткой renewal делает random delay
    // 0-720 секунд (см. /var/log/letsencrypt/letsencrypt.log: «Non-interactive
    // renewal: random delay of 208.5 seconds»). При timeout 120 process
    // killился ДО того как пройдёт задержка → user видит fail хотя cert не
    // обновлялся reasons. Manual renewal через UI = explicit user action,
    // delay не нужен (он создан для cron jobs чтобы distribute load на ACME).
    //
    // timeout 180s prevents certbot from hanging indefinitely (DNS resolution,
    // ACME server unreachable, rate-limit retry loops). 180 hard cap > typical
    // HTTP-01 challenge timing (5-30s) plus headroom для ACME slow responses.
    let renew_result = exec_command(
        handle, app,
        &format!("{sudo}timeout 180 certbot renew --force-renewal --no-random-sleep-on-renew"),
    ).await;
    let certbot_ok = renew_result.as_ref().map(|(_, code)| *code == 0).unwrap_or(false);

    // Step 2: ALWAYS copy the cert from letsencrypt live dir to TrustTunnel's certs/.
    // This is a separate exec_command — no complex one-liner escaping that could silently fail.
    // Even if certbot returned non-zero (e.g. rate limit), the live cert may have been
    // updated by a previous successful run and needs to be synced.
    // Use sed instead of grep -P for POSIX compatibility (grep -P requires PCRE, not
    // available on all minimal server installs).
    let (hostname_raw, _) = exec_command(
        handle, app,
        &format!(r#"{sudo}sed -n 's/^[[:space:]]*hostname[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR),
    ).await.unwrap_or_default();
    let hostname = hostname_raw.trim();

    if !hostname.is_empty() {
        let le_dir = format!("/etc/letsencrypt/live/{hostname}");
        let tt_dir = ENDPOINT_DIR;
        emit_log(app, "info", &format!("Copying cert from {le_dir} to {tt_dir}/certs/"));
        let (_, cp_code) = exec_command(
            handle, app,
            &format!("{sudo}cp {le_dir}/fullchain.pem {tt_dir}/certs/cert.pem && {sudo}cp {le_dir}/privkey.pem {tt_dir}/certs/key.pem"),
        ).await.unwrap_or_default();
        if cp_code != 0 {
            emit_log(app, "warn", "Failed to copy cert files — check paths on server");
        }
    } else {
        emit_log(app, "warn", "Could not detect hostname from hosts.toml — cert not copied");
    }

    // Step 3: Restart TrustTunnel so it picks up the new cert.
    // `--no-block` tells systemd to queue the restart and return immediately —
    // no hanging SSH channel, no nohup/& tricks needed.
    let _ = exec_command(
        handle, app,
        &format!("{sudo}systemctl --no-block restart trusttunnel"),
    ).await;

    // Always close 80/tcp if we opened it — even if the renewal above failed at the SSH level.
    // Note: this runs on BOTH the happy path and before the early Err(...) below so that a
    // non-zero certbot exit code cannot leak the temporarily-opened port. Ideally this would
    // be wrapped in an RAII scope guard (so a panic/cancellation between the `ufw allow` and
    // here also closes the port), but Rust async closures + borrow checker on `handle`/`app`
    // make a clean Drop impl non-trivial. Best-effort duplicated close is pragmatic here.
    let close_temp_port_80 = || async {
        if temporarily_opened_80 {
            emit_log(app, "info", "UFW: closing 80/tcp after cert renewal");
            let _ = exec_command(handle, app, &format!("{sudo}ufw --force delete allow 80/tcp 2>/dev/null; true")).await;
        }
    };
    close_temp_port_80().await;

    // Return based on certbot's actual exit code.
    // P UAT 2026-05-04 fix: include actual certbot output (last 30 lines) в
    // error message — раньше user видел только exit code, не понимал что
    // конкретно упало (rate limit / port 80 conflict / DNS / network).
    if !certbot_ok {
        close_temp_port_80().await;
        let code = renew_result.as_ref().map(|(_, c)| *c).unwrap_or(-1);
        let output = renew_result.as_ref().map(|(out, _)| out.as_str()).unwrap_or("");
        // Take last 30 lines (где обычно error cause) and trim длину.
        let tail: Vec<&str> = output.lines().rev().take(30).collect();
        let tail_text = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
        // Use special separator («\u{1F}» — Information Separator One, ASCII 31)
        // вместо «|» — certbot output может содержать pipe characters.
        return Err(format!("SSH_CERT_RENEW_FAILED|{code}\u{1F}{tail_text}"));
    }

    let output = renew_result.map(|(out, _)| out).unwrap_or_default();
    Ok(output)
}

// ═══════════════════════════════════════════════════════════════
//   Phase 16 — Tests for pure parser helpers
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    /// Read fixture relative to crate root (cargo test sets cwd = src-tauri/).
    fn read_fixture(name: &str) -> String {
        let path = format!("tests/fixtures/{name}");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("fixture {name} unreadable from cwd: {e}"))
    }

    #[test]
    fn cert_extended_parsing_letsencrypt() {
        let raw = read_fixture("openssl_x509_letsencrypt.txt");
        let parsed = parse_openssl_cert_output(&raw);
        let obj = parsed.as_object().unwrap();

        assert_eq!(
            obj["sha256Fingerprint"],
            serde_json::json!(
                "A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90"
            )
        );
        assert_eq!(obj["subject"], serde_json::json!("CN = vpn.example.com"));
        assert_eq!(
            obj["issuer"],
            serde_json::json!("C = US, O = Let's Encrypt, CN = R3")
        );
        assert_eq!(
            obj["notBefore"],
            serde_json::json!("Apr 28 12:00:00 2026 GMT")
        );
        assert_eq!(
            obj["notAfter"],
            serde_json::json!("Jul 27 12:00:00 2026 GMT")
        );
    }

    #[test]
    fn cert_extended_parsing_self_signed() {
        let raw = read_fixture("openssl_x509_self_signed.txt");
        let parsed = parse_openssl_cert_output(&raw);
        let obj = parsed.as_object().unwrap();

        // Self-signed indicator: subject == issuer.
        assert_eq!(obj["subject"], obj["issuer"]);
        assert_eq!(
            obj["sha256Fingerprint"],
            serde_json::json!(
                "DE:AD:BE:EF:CA:FE:BA:BE:11:22:33:44:55:66:77:88:99:00:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:77:88"
            )
        );
        assert_eq!(obj["subject"], serde_json::json!("CN = self-signed.local"));
    }

    #[test]
    fn cert_parse_handles_empty_input() {
        // Defense in depth: empty / malformed openssl output → all fields empty (no panic).
        let parsed = parse_openssl_cert_output("");
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj["sha256Fingerprint"], serde_json::json!(""));
        assert_eq!(obj["notAfter"], serde_json::json!(""));
        assert_eq!(obj["notBefore"], serde_json::json!(""));
        assert_eq!(obj["subject"], serde_json::json!(""));
        assert_eq!(obj["issuer"], serde_json::json!(""));
    }

    #[test]
    fn cert_parse_ignores_unrelated_lines() {
        // Real openssl output может содержать `unable to load certificate` на error path.
        // Parser должен tolerate это без panic (silently fields останутся пустыми).
        let raw = "unable to load certificate\nsome random output\n";
        let parsed = parse_openssl_cert_output(raw);
        let obj = parsed.as_object().unwrap();
        assert_eq!(obj["sha256Fingerprint"], serde_json::json!(""));
    }
}
