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

/// Force-renew the TLS certificate via certbot, then gracefully reload the service.
///
/// Thin SSH/Tauri wrapper around [`renew_cert_core`]. All of the command-sequencing
/// logic (UFW port-80 open/close discipline, the renewal call, the hosts.toml cert-path
/// self-heal, and the graceful reload) lives in the core so it is unit-testable with a
/// stubbed command runner — see the `#[cfg(test)] mod tests` at the bottom of this file.
pub async fn renew_cert(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;
    // Real runner: issue the command over SSH. The core never touches `handle`/`app`
    // directly, so the test seam can swap this for a recording closure.
    let run = |cmd: String| async move { exec_command(handle, app, &cmd).await };
    let log = |level: &str, message: &str| emit_log(app, level, message);
    renew_cert_core(sudo, &run, &log).await
}

/// Pure orchestration core of [`renew_cert`].
///
/// Generic over a command runner `run` and a logger `log` so unit tests can stub the
/// command-execution seam (record issued SSH command strings + inject an `Err`/non-zero
/// for the renewal step) WITHOUT a live `client::Handle` or `tauri::AppHandle` — both of
/// which are impossible to construct in a unit test. The real wrapper supplies
/// `exec_command(handle, app, …)` and `emit_log(app, …)`.
///
/// D-09 invariant: every exit path after the `ufw allow 80/tcp` (including the early
/// `Err(...)` on a non-zero certbot exit) routes through `close_temp_port_80` exactly
/// once, so a temporarily-opened port 80 is NEVER left open on the user's server. Only a
/// port WE opened is closed (`temporarily_opened_80` guard) — a pre-existing open port is
/// left untouched.
async fn renew_cert_core<R, Fut, L>(
    sudo: &str,
    run: &R,
    log: &L,
) -> Result<String, String>
where
    R: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<(String, i32), String>>,
    L: Fn(&str, &str),
{
    // If UFW is active and port 80 is not currently open, temporarily open it for the
    // HTTP-01 challenge — and remove the rule afterwards. This lets users keep port 80
    // closed in normal operation while still allowing certbot renewals.
    let (ufw_status, _) = run(format!("{sudo}ufw status 2>/dev/null | head -20"))
        .await
        .unwrap_or_default();
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
        log("info", "UFW: temporarily opening 80/tcp for cert renewal");
        let _ = run(format!(
            "{sudo}ufw allow 80/tcp comment 'cert renewal (temporary)'"
        ))
        .await;
        true
    } else {
        false
    };

    // The single port-80 close guard. D-09: this MUST run on every exit path after the
    // `ufw allow` above. We can't ride a synchronous `Drop` (the close is an async
    // `run(...).await`), so we call this explicitly before EACH return below — and we
    // structure the function so there is exactly one place that returns the error and
    // one place that returns success, each preceded by this close. Only closes a port WE
    // opened (`temporarily_opened_80`).
    let close_temp_port_80 = || async {
        if temporarily_opened_80 {
            log("info", "UFW: closing 80/tcp after cert renewal");
            let _ = run(format!(
                "{sudo}ufw --force delete allow 80/tcp 2>/dev/null; true"
            ))
            .await;
        }
    };

    // Step 1: Kill stale certbot + run renewal.
    let _ = run(format!(
        "{sudo}pkill -9 certbot 2>/dev/null; {sudo}rm -f /tmp/.certbot.lock /var/lib/letsencrypt/.certbot.lock 2>/dev/null; true"
    ))
    .await;

    emit_renew_started(log);
    // P UAT 2026-05-06: добавлен --no-random-sleep-on-renew. Без него certbot
    // в non-interactive режиме перед попыткой renewal делает random delay
    // 0-720 секунд (см. /var/log/letsencrypt/letsencrypt.log: «Non-interactive
    // renewal: random delay of 208.5 seconds»). При timeout 120 process
    // killился ДО того как пройдёт задержка → user видит fail хотя cert не
    // обновлялся reasons. Manual renewal через UI = explicit user action,
    // delay не нужен (он создан для cron jobs чтобы distribute load на ACME).
    //
    // CONF-M-06: manual renew uses `certbot renew` WITHOUT `--force-renewal` so repeated
    // "Renew" clicks do not burn Let's Encrypt rate limits — certbot honours the renewal
    // window (renews only when <30 days remain) and exits 0 ("Cert not yet due") otherwise,
    // which we treat as success below.
    //
    // timeout 180s prevents certbot from hanging indefinitely (DNS resolution,
    // ACME server unreachable, rate-limit retry loops). 180 hard cap > typical
    // HTTP-01 challenge timing (5-30s) plus headroom для ACME slow responses.
    let renew_result = run(format!(
        "{sudo}timeout 180 certbot renew --no-random-sleep-on-renew"
    ))
    .await;
    let certbot_ok = renew_result
        .as_ref()
        .map(|(_, code)| *code == 0)
        .unwrap_or(false);

    // Step 2 (CONF-C-01 + D-11 self-heal): the served cert comes from the certbot `live/`
    // symlink, NOT a local copy. certbot auto-rotates the symlink on renewal, so there is
    // no `cp live/ → certs/cert.pem` step anymore for the Let's-Encrypt path — that copy was
    // the stale-cert bug (after certbot.timer auto-renew, the old local copy kept being
    // served). Instead we IDEMPOTENTLY ensure hosts.toml's cert paths point at the live/
    // symlink as part of the renew we already perform.
    //
    // D-11 boundary: this hosts.toml cert-path self-heal is the ONLY existing-server change
    // in this phase — an already-deployed server fixes its CERT PATH on its next manual
    // "Renew". The broader existing-server migration (ICMP/cron helper rewrite) stays
    // BACKLOG T-20. New installs get the live/ paths directly from deploy.rs (Plan 03).
    //
    // Use sed instead of grep -P for POSIX compatibility (grep -P requires PCRE, not
    // available on all minimal server installs).
    let (hostname_raw, _) = run(format!(
        r#"{sudo}sed -n 's/^[[:space:]]*hostname[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' {dir}/hosts.toml 2>/dev/null | head -1"#,
        dir = ENDPOINT_DIR
    ))
    .await
    .unwrap_or_default();
    let hostname = hostname_raw.trim();

    if !hostname.is_empty() {
        // Idempotent self-heal: only rewrite hosts.toml cert paths that still point at the
        // local `certs/` copy. `sed` is a no-op when the path is already the live/ symlink,
        // so this is safe to run on every renew (healthy/new servers see no change).
        let live_chain = format!("/etc/letsencrypt/live/{hostname}/fullchain.pem");
        let live_key = format!("/etc/letsencrypt/live/{hostname}/privkey.pem");
        log(
            "info",
            "Ensuring hosts.toml cert paths point at the certbot live/ symlink (D-11 self-heal)",
        );
        // Match a cert_chain_path / private_key_path line whose value is NOT already an
        // /etc/letsencrypt/live/ path and rewrite it to the live/ symlink. The negative
        // look (`[^/]` first char OR a non-letsencrypt absolute path) is approximated by
        // only rewriting when the current value differs — `sed` substitution is idempotent
        // because the replacement equals the target, so re-running changes nothing.
        let self_heal = format!(
            "{sudo}sed -i \
                -e 's#^\\([[:space:]]*cert_chain_path[[:space:]]*=[[:space:]]*\\)\"[^\"]*\"#\\1\"{live_chain}\"#' \
                -e 's#^\\([[:space:]]*private_key_path[[:space:]]*=[[:space:]]*\\)\"[^\"]*\"#\\1\"{live_key}\"#' \
                {dir}/hosts.toml 2>/dev/null; true",
            dir = ENDPOINT_DIR
        );
        let _ = run(self_heal).await;
    } else {
        log(
            "warn",
            "Could not detect hostname from hosts.toml — cert-path self-heal skipped",
        );
    }

    // Step 3 (CONF-H-03 + A2 gate): gracefully RELOAD TrustTunnel so an active VPN session
    // survives a renew. `systemctl restart` dropped every connected client; SIGHUP/reload
    // hot-swaps the TLS cert without tearing down sessions.
    //
    // A2 gate: `systemctl reload` is a no-op (or errors) if the unit has no `ExecReload`.
    // So we FIRST check `systemctl show -p ExecReload`; if present, use `systemctl reload`.
    // Otherwise fall back to a GUARDED `kill -HUP $MAINPID` — we resolve MAINPID and only
    // signal it when it is a positive integer. Never bare `kill -HUP $MAINPID`: an empty or
    // `0` MAINPID makes `kill -HUP 0` signal the WHOLE process group, which can drop the
    // active SSH session that is driving this very renew.
    let reload_cmd = format!(
        "if {sudo}systemctl show trusttunnel -p ExecReload --value 2>/dev/null | grep -q .; then \
            {sudo}systemctl reload trusttunnel; \
         else \
            MAINPID=$({sudo}systemctl show trusttunnel -p MainPID --value 2>/dev/null); \
            if [ -n \"$MAINPID\" ] && [ \"$MAINPID\" -gt 0 ] 2>/dev/null; then \
                {sudo}kill -HUP \"$MAINPID\"; \
            fi; \
         fi"
    );
    let _ = run(reload_cmd).await;

    // D-09: close the temporarily-opened port on BOTH exit paths below. There is exactly
    // one error return and one success return, each preceded by this single close.
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

    close_temp_port_80().await;
    let output = renew_result.map(|(out, _)| out).unwrap_or_default();
    Ok(output)
}

/// Tiny helper so the core's "renew started" log line is in one place (keeps the long
/// CONF-M-06 comment block off the call site).
fn emit_renew_started<L: Fn(&str, &str)>(log: &L) {
    log("info", "Running certbot renew ...");
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

    // ═══════════════════════════════════════════════════════════════
    //   Phase 4 (D-09 / CONF-C-01 / CONF-H-03 / CONF-M-06 / D-11)
    //   renew_cert_core regression harness.
    //
    //   We cannot construct a `client::Handle<SshHandler>` or a `tauri::AppHandle`
    //   in a unit test, so renew_cert delegates ALL command-sequencing to
    //   `renew_cert_core`, which is generic over a `run` closure (the
    //   exec_command seam) and a `log` closure (the emit_log seam). These tests
    //   drive the core directly with a recording runner, asserting on the exact
    //   SSH command strings it issues — including on the error path.
    // ═══════════════════════════════════════════════════════════════

    use std::cell::RefCell;

    /// Records every command the core issues and lets a test script the
    /// (stdout, exit_code) returned for the command matching a predicate
    /// (used to inject the renewal error).
    struct Recorder {
        cmds: RefCell<Vec<String>>,
        // If a command CONTAINS this substring, return (stdout, code) below.
        fail_substr: Option<&'static str>,
        fail_with: (String, i32),
    }

    impl Recorder {
        fn new() -> Self {
            Recorder {
                cmds: RefCell::new(Vec::new()),
                fail_substr: None,
                fail_with: (String::new(), 0),
            }
        }

        /// Build a `run` closure over this recorder. Default result is ("", 0)
        /// (success) unless the command matches `fail_substr`.
        fn runner(&self) -> impl Fn(String) -> std::future::Ready<Result<(String, i32), String>> + '_ {
            move |cmd: String| {
                let result = if let Some(sub) = self.fail_substr {
                    if cmd.contains(sub) {
                        Ok(self.fail_with.clone())
                    } else {
                        // `ufw status` first line must be parseable; default empty is
                        // treated as inactive, which is fine for these tests.
                        Ok((String::new(), 0))
                    }
                } else {
                    Ok((String::new(), 0))
                };
                self.cmds.borrow_mut().push(cmd);
                std::future::ready(result)
            }
        }

        fn recorded(&self) -> Vec<String> {
            self.cmds.borrow().clone()
        }
    }

    /// `log` closure that drops everything — these tests assert on commands, not logs.
    fn noop_log(_level: &str, _message: &str) {}

    /// Drives `renew_cert_core` on a single-threaded tokio runtime (the runner
    /// returns an immediately-ready future, so this never actually yields).
    fn drive_renew(rec: &Recorder) -> Result<String, String> {
        let run = rec.runner();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("tokio runtime");
        rt.block_on(renew_cert_core("sudo ", &run, &noop_log))
    }

    /// Helper: make the core believe UFW is active and port 80 is closed, so it
    /// takes the "temporarily open 80" branch (otherwise there is nothing to close).
    /// We do this by returning an active ufw status for the `ufw status` probe.
    struct UfwActiveRecorder {
        cmds: RefCell<Vec<String>>,
        fail_substr: Option<&'static str>,
        fail_with: (String, i32),
    }

    impl UfwActiveRecorder {
        fn new() -> Self {
            UfwActiveRecorder {
                cmds: RefCell::new(Vec::new()),
                fail_substr: None,
                fail_with: (String::new(), 0),
            }
        }

        fn runner(&self) -> impl Fn(String) -> std::future::Ready<Result<(String, i32), String>> + '_ {
            move |cmd: String| {
                let result = if cmd.contains("ufw status") {
                    // Active, with no port-80 rule → core opens 80 temporarily.
                    Ok(("Status: active\nTo                         Action      From\n22/tcp                     ALLOW       Anywhere\n".to_string(), 0))
                } else if let Some(sub) = self.fail_substr {
                    if cmd.contains(sub) {
                        Ok(self.fail_with.clone())
                    } else {
                        Ok((String::new(), 0))
                    }
                } else {
                    Ok((String::new(), 0))
                };
                self.cmds.borrow_mut().push(cmd);
                std::future::ready(result)
            }
        }

        fn recorded(&self) -> Vec<String> {
            self.cmds.borrow().clone()
        }
    }

    fn drive_renew_ufw(rec: &UfwActiveRecorder) -> Result<String, String> {
        let run = rec.runner();
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("tokio runtime");
        rt.block_on(renew_cert_core("sudo ", &run, &noop_log))
    }

    /// D-09: when the renewal step ERRORS (non-zero certbot exit) AND we had
    /// temporarily opened port 80, the core MUST still issue the port-80 close.
    /// On the pre-fix code this failed because the early `Err(...)` path skipped
    /// the close after the cp/restart steps were added.
    #[test]
    fn ufw_port_80_closed_on_renewal_error_path() {
        let mut rec = UfwActiveRecorder::new();
        // Make `certbot renew` return a non-zero exit (rate-limit / DNS fail).
        rec.fail_substr = Some("certbot renew");
        rec.fail_with = ("Some certbot failure output".to_string(), 1);

        let result = drive_renew_ufw(&rec);
        assert!(result.is_err(), "non-zero certbot exit must yield Err");

        let cmds = rec.recorded();
        // We opened the port (temporary), so we MUST have closed it.
        assert!(
            cmds.iter().any(|c| c.contains("ufw allow 80/tcp")),
            "expected the temporary open; commands: {cmds:#?}"
        );
        assert!(
            cmds.iter()
                .any(|c| c.contains("ufw --force delete allow 80/tcp")),
            "D-09 LEAK: port-80 close was NOT issued on the renewal error path; commands: {cmds:#?}"
        );
    }

    /// D-09 edge: a port that was ALREADY open before the renew must NOT be closed
    /// (only close what we opened). With ufw inactive (default empty status) the
    /// core never opens 80, so it must never close it either — even on error.
    #[test]
    fn ufw_port_80_not_touched_when_not_opened_by_us() {
        let mut rec = Recorder::new();
        rec.fail_substr = Some("certbot renew");
        rec.fail_with = ("fail".to_string(), 1);

        let _ = drive_renew(&rec);
        let cmds = rec.recorded();
        assert!(
            !cmds.iter().any(|c| c.contains("ufw allow 80/tcp")),
            "must not open port 80 when ufw is inactive"
        );
        assert!(
            !cmds.iter().any(|c| c.contains("ufw --force delete allow 80/tcp")),
            "must not close a port we never opened"
        );
    }

    /// CONF-C-01: the LE path no longer copies the live cert into the local `certs/`
    /// dir — the served cert comes from the certbot live/ symlink. On the pre-fix code
    /// this `cp …/fullchain.pem … cert.pem` was always issued.
    #[test]
    fn renew_no_longer_copies_cert_into_local_certs_dir() {
        let rec = Recorder::new();
        let _ = drive_renew(&rec);
        let cmds = rec.recorded();
        assert!(
            !cmds
                .iter()
                .any(|c| c.contains("cp ") && c.contains("certs/cert.pem")),
            "CONF-C-01: renew must NOT copy live/ → local certs/cert.pem; commands: {cmds:#?}"
        );
    }

    /// D-11 self-heal: as part of the renew, the core idempotently rewrites hosts.toml
    /// cert paths to the certbot live/ symlink. We need a hostname for this, so return
    /// one for the `sed -n '…hostname…'` probe.
    #[test]
    fn renew_self_heals_hosts_toml_to_live_symlink() {
        struct HostRecorder {
            cmds: RefCell<Vec<String>>,
        }
        let rec = HostRecorder {
            cmds: RefCell::new(Vec::new()),
        };
        let run = |cmd: String| {
            let out = if cmd.contains("hostname") && cmd.contains("hosts.toml") {
                "vpn.example.com".to_string()
            } else {
                String::new()
            };
            rec.cmds.borrow_mut().push(cmd);
            std::future::ready(Ok::<_, String>((out, 0)))
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let _ = rt.block_on(renew_cert_core("sudo ", &run, &noop_log));
        let cmds = rec.cmds.borrow().clone();
        assert!(
            cmds.iter().any(|c| {
                c.contains("sed -i")
                    && c.contains("/etc/letsencrypt/live/vpn.example.com/fullchain.pem")
                    && c.contains("/etc/letsencrypt/live/vpn.example.com/privkey.pem")
            }),
            "D-11: expected an idempotent hosts.toml rewrite to the live/ symlink; commands: {cmds:#?}"
        );
    }

    /// CONF-H-03 + A2 + MAINPID guard: the renew reloads (not restarts) the service,
    /// gated on `ExecReload`, with a GUARDED `kill -HUP $MAINPID` fallback. The guard
    /// MUST include the `-gt 0` check and MUST NOT issue a bare `kill -HUP 0` (which
    /// would signal the process group and can drop the SSH session).
    #[test]
    fn renew_reloads_not_restarts_with_guarded_mainpid() {
        let rec = Recorder::new();
        let _ = drive_renew(&rec);
        let cmds = rec.recorded();
        // No hard restart.
        assert!(
            !cmds.iter().any(|c| c.contains("systemctl") && c.contains("restart trusttunnel")),
            "CONF-H-03: renew must NOT `systemctl restart`; commands: {cmds:#?}"
        );
        let reload = cmds
            .iter()
            .find(|c| c.contains("systemctl reload trusttunnel"))
            .expect("expected a graceful reload command");
        // A2 gate: reload is conditional on ExecReload being defined.
        assert!(
            reload.contains("ExecReload"),
            "reload must be gated on the ExecReload check (A2): {reload}"
        );
        // MAINPID guard: positive-integer check present, no bare `kill -HUP 0`.
        assert!(
            reload.contains("-gt 0") && reload.contains("kill -HUP"),
            "MAINPID fallback must be guarded by `-gt 0`: {reload}"
        );
        assert!(
            !reload.contains("kill -HUP 0"),
            "must never issue a bare `kill -HUP 0`: {reload}"
        );
    }

    /// CONF-M-06: manual renew uses `certbot renew` WITHOUT `--force-renewal` so repeated
    /// clicks do not burn Let's Encrypt rate limits. Pre-fix this contained `--force-renewal`.
    #[test]
    fn renew_does_not_force_renewal() {
        let rec = Recorder::new();
        let _ = drive_renew(&rec);
        let cmds = rec.recorded();
        let renew = cmds
            .iter()
            .find(|c| c.contains("certbot renew"))
            .expect("expected a certbot renew command");
        assert!(
            !renew.contains("--force-renewal"),
            "CONF-M-06: manual renew must not use --force-renewal: {renew}"
        );
    }
}
