use super::super::*;
use super::super::sanitize::{validate_client_name, validate_display_name, validate_fqdn_sni, validate_dns_list};
use russh::client;
use serde::{Deserialize, Serialize};
use super::users_advanced::UserAdvanced;

// ── M-01: allowed_sni discovery for Custom SNI autocomplete ─────────────────

/// One `[[main_hosts]]` entry from `/opt/trusttunnel/hosts.toml`, trimmed to the
/// two fields the frontend autocomplete needs: the hostname (implicitly always
/// valid as SNI) and the explicit `allowed_sni` whitelist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowedSniHost {
    pub hostname: String,
    pub allowed_sni: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct HostsFile {
    #[serde(default)]
    main_hosts: Vec<HostsEntry>,
}

#[derive(Debug, Deserialize)]
struct HostsEntry {
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    allowed_sni: Vec<String>,
}

/// Read `/opt/trusttunnel/hosts.toml`, parse `[[main_hosts]]` blocks, return the
/// hostname + allowed_sni list per host. Powers Custom SNI autocomplete in
/// UserModal (M-01) — so the user doesn't have to guess which SNI values the
/// server will accept before FIX-OO-14 rolls them back.
///
/// Soft-fail: empty file / parse error returns `Ok(vec![])` so the UI falls
/// back to "no suggestions, validator silent" instead of blocking the modal.
pub async fn get_allowed_sni_list(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<Vec<AllowedSniHost>, String> {
    let sudo = detect_sudo(handle, app).await;
    let dir = ENDPOINT_DIR;
    let (content, _) = exec_command(
        handle, app,
        &format!("{sudo}cat {dir}/hosts.toml 2>/dev/null || echo ''"),
    ).await?;
    Ok(parse_allowed_sni_from_hosts_toml(&content))
}

fn parse_allowed_sni_from_hosts_toml(content: &str) -> Vec<AllowedSniHost> {
    let Ok(parsed) = toml::from_str::<HostsFile>(content) else {
        return Vec::new();
    };
    parsed
        .main_hosts
        .into_iter()
        .filter(|h| !h.hostname.is_empty())
        .map(|h| AllowedSniHost {
            hostname: h.hostname,
            allowed_sni: h.allowed_sni,
        })
        .collect()
}

/// Connect to a server where TrustTunnel is already installed,
/// export the client config via trusttunnel_endpoint, and save it locally.
/// NOTE: This function uses direct connect (NOT pooled) — deploy-style flow with emit_step.
pub async fn fetch_server_config(
    app: &tauri::AppHandle,
    params: SshParams,
    client_name: String,
) -> Result<String, String> {
    emit_step(app, "connect", "progress", "Connecting to server...");
    let handle = params.connect_with_app(app.clone()).await
        .map_err(|e| { emit_step(app, "connect", "error", &e); e })?;
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    // Check TrustTunnel is installed
    emit_step(app, "check", "progress", "Checking TrustTunnel on server...");

    let (bin_check, _) = exec_command(
        &handle, app,
        &format!("test -f {bin} && echo TT_EXISTS || echo TT_MISSING", bin = ENDPOINT_BINARY)
    ).await?;

    if !bin_check.contains("TT_EXISTS") {
        let msg = &format!("TrustTunnel not found on server ({bin})", bin = ENDPOINT_BINARY);
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    // Check config files exist
    let (cfg_check, _) = exec_command(
        &handle, app,
        &format!("test -f {dir}/vpn.toml && test -f {dir}/hosts.toml && echo CFG_OK || echo CFG_MISSING", dir = ENDPOINT_DIR)
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        let msg = "Configuration files not found on server (vpn.toml / hosts.toml)";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "check", "ok", "TrustTunnel installed, config found");

    // Determine the server's listen address for the export command
    let (listen_raw, _) = exec_command(
        &handle, app,
        &format!(r#"grep -oP 'listen_address\s*=\s*"\K[^"]+' {cfg} 2>/dev/null || echo '0.0.0.0:443'"#, cfg = ENDPOINT_CONFIG)
    ).await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').last().unwrap_or("443");

    // Try to determine the address the endpoint uses (domain from hosts.toml or fallback to host IP)
    let (hostname_raw, _) = exec_command(
        &handle, app,
        &format!(r#"grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR)
    ).await?;
    let endpoint_hostname = hostname_raw.trim();
    let export_address = if !endpoint_hostname.is_empty() && endpoint_hostname != "trusttunnel.local" {
        format!("{endpoint_hostname}:{listen_port}")
    } else {
        format!("{}:{listen_port}", params.host)
    };

    emit_step(app, "export", "progress", "Exporting client config...");

    let sudo = detect_sudo(&handle, app).await;

    // Pre-check: list available usernames from credentials.toml
    let (creds_raw, _) = exec_command(
        &handle, app,
        &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' {dir}/credentials.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR)
    ).await?;
    let available_users: Vec<&str> = creds_raw.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    // Use provided client_name, or auto-pick first available user from credentials.toml
    let name = if !client_name.trim().is_empty() {
        client_name.trim().to_string()
    } else if let Some(first) = available_users.first() {
        emit_log(app, "info", &format!("Client name not specified, using: {first}"));
        first.to_string()
    } else {
        "client".to_string()
    };

    if !available_users.is_empty() {
        emit_log(app, "info", &format!("Available users: {}", available_users.join(", ")));
        if !available_users.iter().any(|u| *u == name.as_str()) {
            let msg = format!(
                "User '{}' not found in credentials.toml. Available: {}",
                name,
                available_users.join(", ")
            );
            emit_step(app, "export", "error", &msg);
            return Err(msg);
        }
    }

    // Validate client name before interpolating into shell command
    validate_client_name(&name)?;

    // FIX-OO-4: pull the user's anti-DPI prefix out of rules.toml so we can
    // pass it to the CLI via `-r <prefix>`. Same reason as the deeplink
    // export path — without the flag, the CLI emits `client_random_prefix = ""`
    // (empty), the overlay-normalizer leaves `client_random = ""`, sidecar
    // sends no prefix, and a prefix-requiring server rule rejects the
    // connection during TLS handshake with "Failed to verify certificate".
    let (rules_content_for_prefix, _) = exec_command(
        &handle, app,
        &format!("{sudo}cat {dir}/rules.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR),
    ).await.unwrap_or((String::new(), 0));
    let stored_prefix = super::find_user_rule(&rules_content_for_prefix, &name)
        .ok()
        .flatten()
        .and_then(|r| r.client_random_prefix);
    let r_flag = stored_prefix
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| format!(" -r {p}"))
        .unwrap_or_default();

    let export_cmd = format!(
        "cd {dir} && {sudo}./{svc} vpn.toml hosts.toml -c {name} -a {export_address}{r_flag} --format toml 2>&1",
        dir = ENDPOINT_DIR, svc = ENDPOINT_SERVICE
    );

    let (export_output, export_code) = exec_command(&handle, app, &export_cmd).await?;

    if export_code != 0 || export_output.trim().is_empty() {
        emit_log(app, "error", &format!("Export failed (code {export_code}): {export_output}"));
        let msg = if !available_users.is_empty() {
            format!("SSH_EXPORT_FAILED|{}|{}", export_code, available_users.join(", "))
        } else {
            format!("SSH_EXPORT_FAILED|{}", export_code)
        };
        emit_step(app, "export", "error", &msg);
        return Err(msg);
    }

    // Extract only the TOML part
    let endpoint_section: String = export_output
        .lines()
        .skip_while(|l| !l.starts_with('#') && !l.starts_with("hostname"))
        .collect::<Vec<_>>()
        .join("\n");

    let server_host = &params.host;
    let mut client_toml = build_client_config(&endpoint_section, &format!("Fetched from server {server_host}"));

    // FIX-OO-3: upstream naming drift. The endpoint CLI's `compose_toml`
    // (lib/src/client_config.rs v1.0.33) writes the anti-DPI hex value as
    // `client_random_prefix = "..."`, but the client sidecar parses
    // `client_random = "..."` (trusttunnel/src/config.cpp:140 — also what
    // the client-side README documents). Result: every client downloaded
    // from `--format toml` silently has the prefix stripped on parse,
    // anti-DPI goes unused, and if the server's rules require matching
    // prefix the connection is rejected before TLS settles. Rename here
    // so the written file matches the parser's expectation.
    //
    // Same class of upstream divergence: `server_display_name` → `name`
    // and `dns_servers` → `dns_upstreams` (upstream PR 668 renamed them).
    // Handle both legacy emissions just in case the server is on a
    // pre-rename endpoint build.
    client_toml = normalize_legacy_field_names(&client_toml);

    // FIX-NN: overlay stored TLV params from users-advanced.toml. Without
    // this, the downloaded .toml always reflects the CLI-default endpoint
    // shape (anti_dpi=true forced by build_client_config, no SNI, etc.)
    // rather than what the user actually saved via Add/Edit. If the user
    // never saved advanced params the overlay is a no-op.
    let advanced = super::users_advanced::get_user_advanced(app, &handle, name.clone())
        .await
        .unwrap_or(None);
    if let Some(adv) = advanced {
        match inject_advanced_into_endpoint(&client_toml, &adv) {
            Ok(updated) => client_toml = updated,
            Err(e) => emit_log(app, "warn", &format!("users-advanced overlay failed: {e}")),
        }
    }

    emit_step(app, "export", "ok", "Config received");

    // Save locally
    emit_step(app, "save", "progress", "Saving configuration...");

    let config_dir = portable_data_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("SSH_MKDIR_FAILED|{e}"))?;

    let client_config_path = config_dir.join("trusttunnel_client.toml");
    std::fs::write(&client_config_path, &client_toml)
        .map_err(|e| format!("SSH_WRITE_CONFIG_FAILED|{e}"))?;

    let config_path_str = client_config_path.to_string_lossy().to_string();
    emit_log(app, "info", &format!("Config saved: {config_path_str}"));
    emit_step(app, "save", "ok", "Configuration saved");

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "done", "ok", "Config successfully fetched from server!");

    Ok(config_path_str)
}

/// Read the raw vpn.toml configuration from the remote server.
pub async fn get_server_config(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;

    let (output, code) = exec_command(
        handle,
        app,
        &format!("{sudo}cat {cfg}", cfg = ENDPOINT_CONFIG),
    )
    .await?;

    if code != 0 {
        return Err("SSH_READ_CONFIG_FAILED".into());
    }

    Ok(output)
}

/// Export a client configuration as a deeplink URL from the remote server.
pub async fn export_config_deeplink(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    client_name: String,
) -> Result<String, String> {
    let sudo = detect_sudo(handle, app).await;

    // Get listen address from vpn.toml
    let (listen_raw, _) = exec_command(
        handle,
        app,
        &format!(r#"{sudo}grep -oP 'listen_address\s*=\s*"\K[^"]+' {cfg} 2>/dev/null || echo '0.0.0.0:443'"#, cfg = ENDPOINT_CONFIG),
    )
    .await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').last().unwrap_or("443");

    // Try to determine hostname from hosts.toml, fallback to connection host
    let (hostname_raw, _) = exec_command(
        handle,
        app,
        &format!(r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR),
    )
    .await?;
    let endpoint_hostname = hostname_raw.trim();
    // Use hostname from hosts.toml; if unavailable, the caller must provide the host
    // via a different mechanism. Since the pool always connects to the same host,
    // the hostname from hosts.toml is the correct fallback.
    let export_address = if !endpoint_hostname.is_empty() && endpoint_hostname != "trusttunnel.local" {
        format!("{endpoint_hostname}:{listen_port}")
    } else {
        // Fallback: use the hostname from the server's perspective
        let (host_raw, _) = exec_command(handle, app, "hostname -f 2>/dev/null || hostname").await.unwrap_or_default();
        let fallback = host_raw.trim();
        if fallback.is_empty() {
            format!("localhost:{listen_port}")
        } else {
            format!("{fallback}:{listen_port}")
        }
    };

    // Validate client name before interpolating into shell command
    validate_client_name(&client_name)?;

    let export_cmd = format!(
        "cd {dir} && {sudo}./{svc} vpn.toml hosts.toml -c {client_name} -a {export_address} --format deeplink 2>&1",
        dir = ENDPOINT_DIR, svc = ENDPOINT_SERVICE
    );

    let (export_output, export_code) = exec_command(handle, app, &export_cmd).await?;

    if export_code != 0 || export_output.trim().is_empty() {
        return Err(format!(
            "SSH_DEEPLINK_EXPORT_FAILED|{export_code}|{client_name}"
        ));
    }

    // Extract the deeplink URL (skip any warning/log lines)
    let deeplink = export_output
        .lines()
        .filter(|l| l.starts_with("trusttunnel://") || l.starts_with("tt://"))
        .last()
        .unwrap_or(export_output.trim());

    Ok(deeplink.trim().to_string())
}

/// Toggle a boolean feature in vpn.toml (ping_enable, speedtest_enable, ipv6_available)
pub async fn update_config_feature(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    feature: String,
    enabled: bool,
) -> Result<(), String> {
    // Whitelist: only known feature names may be interpolated into shell commands
    let allowed_features = ["ping_enable", "speedtest_enable", "ipv6_available"];
    if !allowed_features.contains(&feature.as_str()) {
        return Err(format!("Invalid feature name: {}", feature));
    }

    let sudo = detect_sudo(handle, app).await;

    let value = if enabled { "true" } else { "false" };

    // Try to replace the key if it already exists; if not, append it at the top of the file
    // (before any [section] headers). This handles both fresh configs that lack the key
    // entirely and configs where the key was previously set.
    let cmd = format!(
        r#"{sudo}grep -q "^[[:space:]]*{feature}[[:space:]]*=" {cfg} && \
           {sudo}sed -i "s/^[[:space:]]*{feature}[[:space:]]*=.*/{feature} = {value}/" {cfg} || \
           {sudo}sed -i "1i {feature} = {value}" {cfg}"#,
        cfg = ENDPOINT_CONFIG
    );

    let (_, code) = exec_command(handle, app, &cmd).await?;

    if code != 0 {
        return Err(format!("Failed to update {feature} in vpn.toml (code {code})"));
    }

    // Restart TrustTunnel to apply — --no-block prevents SSH channel from hanging
    let _ = exec_command(handle, app, &format!("{sudo}systemctl --no-block restart trusttunnel")).await;

    Ok(())
}

/// Advanced deeplink export with all 7 optional TLV fields.
///
/// # Path branching (per memory/users-tab-upstream-audit-phase14.1.md — Path A chosen)
///
/// Path A (active): CLI produces base deeplink via supported CLI flags (0x03, 0x0B, 0x0C, 0x0D),
/// then `tlv_encoder::append_missing_tlvs` post-appends the 4 gap TLVs:
/// - 0x07 skip_verification
/// - 0x08 certificate DER
/// - 0x09 upstream_protocol
/// - 0x0A anti_dpi
///
/// Path B (not active): Would return base deeplink only; 4 gap params discarded.
/// Path C: Phase paused; this function would not ship.
#[allow(clippy::too_many_arguments)]
pub async fn export_config_deeplink_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    client_name: String,
    custom_sni: Option<String>,
    name: Option<String>,
    upstream_protocol: Option<String>,
    anti_dpi: bool,
    skip_verification: bool,
    // CR-01: Base64-encoded DER leaf cert. Decoded once via `decode_cert_der_b64`
    // (which enforces MAX_CERT_DER_BYTES) before being handed to `tlv_encoder`.
    pin_certificate_der: Option<String>,
    dns_upstreams: Vec<String>,
) -> Result<String, String> {
    validate_client_name(&client_name)?;
    if let Some(sni) = &custom_sni {
        validate_fqdn_sni(sni)?;
    }
    if let Some(n) = &name {
        // CR-02 mitigation — block shell metachars in display name before interpolating
        // into the `-n "..."` arg of the endpoint CLI.
        validate_display_name(n)?;
    }
    validate_dns_list(&dns_upstreams)?;

    let sudo = detect_sudo(handle, app).await;

    // FIX-N: mirror the proven basic `export_config_deeplink` flow —
    // without `-a <host:port>` the upstream CLI silently emits nothing on
    // `--format deeplink`, which we previously mis-classified as a corrupted
    // deeplink. Read listen_address from vpn.toml and hostname from
    // hosts.toml (fallback: `hostname -f`) and pass them together as `-a`.
    let (listen_raw, _) = exec_command(
        handle,
        app,
        &format!(
            r#"{sudo}grep -oP 'listen_address\s*=\s*"\K[^"]+' {cfg} 2>/dev/null || echo '0.0.0.0:443'"#,
            cfg = ENDPOINT_CONFIG
        ),
    )
    .await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').next_back().unwrap_or("443");

    let (hostname_raw, _) = exec_command(
        handle,
        app,
        &format!(
            r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#,
            dir = ENDPOINT_DIR
        ),
    )
    .await?;
    let endpoint_hostname = hostname_raw.trim();
    let export_address = if !endpoint_hostname.is_empty() && endpoint_hostname != "trusttunnel.local" {
        format!("{endpoint_hostname}:{listen_port}")
    } else {
        let (host_raw, _) =
            exec_command(handle, app, "hostname -f 2>/dev/null || hostname").await.unwrap_or_default();
        let fallback = host_raw.trim();
        if fallback.is_empty() {
            format!("localhost:{listen_port}")
        } else {
            format!("{fallback}:{listen_port}")
        }
    };

    // FIX-OO-4: read the user's anti-DPI prefix from rules.toml so we can
    // pass it to the CLI via `-r <prefix>`. Without this flag the CLI emits
    // a deeplink WITHOUT TLV 0x0B — clients end up with `client_random = ""`,
    // no prefix is sent on the wire, and any rule that requires a matching
    // prefix rejects the handshake before TLS completes. The prefix exists
    // in rules.toml (Pro wrote it during server_add_user_advanced) — we
    // just need to carry it forward to every deeplink export path.
    let (rules_content, _) = exec_command(
        handle, app,
        &format!("{sudo}cat {dir}/rules.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR),
    ).await.unwrap_or((String::new(), 0));
    let stored_prefix = super::find_user_rule(&rules_content, &client_name)
        .ok()
        .flatten()
        .and_then(|r| r.client_random_prefix);

    // Build CLI args for fields supported by upstream CLI.
    // All interpolated values are pre-validated above (validate_*). No additional escaping
    // is performed: validators reject every shell metachar so the unquoted form is safe.
    let mut cli_args = format!("-c {client_name} -a {export_address}");
    if let Some(sni) = &custom_sni {
        if !sni.is_empty() {
            cli_args.push_str(&format!(" -s {sni}"));
        }
    }
    if let Some(n) = &name {
        if !n.is_empty() {
            // Quoted form preserves spaces in display names. Validator rejects ", `, $, \,
            // newlines and shell metachars, so `n` cannot escape the double-quoted context.
            cli_args.push_str(&format!(" -n \"{n}\""));
        }
    }
    if let Some(prefix) = stored_prefix.as_deref() {
        // rules.toml stored prefix is always hex (server_rules.rs generates
        // via `format!("{:02x}", ...)`). CLI validates hex format again on
        // its side via `hex::decode` and matches against rules.toml — we
        // pass the exact same value we just read from rules.toml, so the
        // round-trip match is guaranteed.
        if !prefix.is_empty() {
            cli_args.push_str(&format!(" -r {prefix}"));
        }
    }
    for dns in &dns_upstreams {
        let t = dns.trim();
        if !t.is_empty() {
            cli_args.push_str(&format!(" -d {t}"));
        }
    }

    let dir = ENDPOINT_DIR;
    let svc = ENDPOINT_SERVICE;
    // FIX-N: drop the ad-hoc `grep -oE 'tt://...' | head -1` pipeline.
    // Basic export_config_deeplink parses lines and accepts BOTH `tt://`
    // AND `trusttunnel://` prefixes — mirror that so a CLI whose output
    // format rotates does not silently return empty strings.
    let export_cmd = format!(
        "cd {dir} && {sudo}./{svc} vpn.toml hosts.toml {cli_args} --format deeplink 2>&1"
    );

    let (output, code) = exec_command(handle, app, &export_cmd).await?;
    if code != 0 {
        // FIX-GG: the bare `SSH_EXPORT_FAILED|1` error was useless — users
        // saw "exit code 1" with no hint what the CLI actually printed.
        // Now surface up to 240 chars of output (snippet is sanitized
        // downstream by logging::sanitize before hitting activity.log).
        let snippet: String = output.trim().chars().take(240).collect();
        return Err(format!("SSH_EXPORT_FAILED|{code}|{snippet}"));
    }
    // Accept either upstream scheme; normalize to `tt://` because tlv_encoder
    // expects that prefix exactly.
    let mut base_deeplink = output
        .lines()
        .filter(|l| l.starts_with("tt://") || l.starts_with("trusttunnel://"))
        .next_back()
        .map(|l| l.trim().to_string())
        .unwrap_or_default();
    if let Some(rest) = base_deeplink.strip_prefix("trusttunnel://") {
        base_deeplink = format!("tt://{rest}");
    }
    if base_deeplink.is_empty() || !base_deeplink.starts_with("tt://") {
        // FIX-L: the generic "empty or malformed deeplink" message left users
        // with nothing actionable when the endpoint CLI misbehaved. Surface
        // the exit code plus a bounded output snippet (sensitive values are
        // sanitised downstream by logging::sanitize before hitting activity.log).
        let snippet: String = output.trim().chars().take(240).collect();
        return Err(format!(
            "empty or malformed deeplink returned by endpoint CLI. exit_code={code} output={:?}",
            snippet
        ));
    }

    // CR-01: decode the base64 DER cert here so the tlv_encoder sees raw bytes.
    let pin_certificate_der_bytes: Option<Vec<u8>> = match pin_certificate_der {
        Some(ref s) if !s.is_empty() => Some(super::decode_cert_der_b64(s)?),
        _ => None,
    };

    // PATH A — post-encode the 4 gap TLVs via tlv_encoder
    super::tlv_encoder::append_missing_tlvs(
        &base_deeplink,
        anti_dpi,
        skip_verification,
        upstream_protocol.as_deref(),
        pin_certificate_der_bytes.as_deref(),
    )
}

/// Overlay saved TLV params onto the `[endpoint]` table of a client .toml.
///
/// Used by `fetch_server_config` so the downloaded config carries everything
/// the user entered on Add/Edit — otherwise the endpoint CLI's `--format toml`
/// output would only know about username / password / anti_dpi (CLI-default),
/// losing display_name / custom_sni / upstream_protocol / skip_verification /
/// pin_cert / dns_upstreams.
///
/// # Endpoint field names
/// The sidecar's `Endpoint` struct (in `trusttunnel/settings/src/lib.rs`) is
/// the consumer of this file. Field naming quirks:
/// - `name` (not `display_name`) — matches TLV 0x0C target field.
/// - `certificate` is PEM (not DER base64) — we convert on write.
/// - `upstream_protocol` values are `"http2"` / `"http3"` — our UI carries
///   `"h2"` / `"h3"` (shorthand from the deeplink encoder); we remap here.
///
/// # Conservative contract (FIX-OO revision)
/// Post-FIX-NN UAT surfaced a regression: adding `skip_verification = false`
/// explicitly to a TOML that previously omitted it changed the sidecar's
/// cert-verification behaviour on self-signed endpoints — the pre-FIX-NN
/// omission defaulted to "lenient", the explicit-`false` after FIX-NN
/// switched to "strict" and broke the handshake.
///
/// Lesson: this overlay must be **additive, not authoritative**. Only write
/// a field when the user explicitly set it to a NON-DEFAULT value; otherwise
/// leave whatever the CLI produced (or absent) as-is, matching pre-FIX-NN
/// behaviour for default-only users.
///
/// Field-by-field rules:
/// - `anti_dpi`: default = true (`build_client_config` forces it). Only
///   override to `false` when user explicitly opted out.
/// - `skip_verification`: default = false / absent. Only write when user
///   opted in (true).
/// - `name`, `custom_sni`, `certificate`, `upstream_protocol`, `dns_upstreams`:
///   Write when user provided a value; otherwise do not touch.
///
/// Empty-string / `"auto"` values are treated as "not set" and skipped.
pub fn inject_advanced_into_endpoint(
    client_toml: &str,
    advanced: &UserAdvanced,
) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = client_toml
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse client.toml: {e}"))?;
    let endpoint = doc
        .get_mut("endpoint")
        .and_then(|v| v.as_table_mut())
        .ok_or("client.toml missing [endpoint] table")?;

    // anti_dpi: only override the upstream force-true when user opted OUT.
    if !advanced.anti_dpi {
        endpoint.insert("anti_dpi", toml_edit::value(false));
    }
    // skip_verification: only write when user opted IN.
    if advanced.skip_verification {
        endpoint.insert("skip_verification", toml_edit::value(true));
    }

    if let Some(s) = advanced.display_name.as_deref() {
        if !s.is_empty() {
            endpoint.insert("name", toml_edit::value(s));
        }
    }
    if let Some(s) = advanced.custom_sni.as_deref() {
        if !s.is_empty() {
            endpoint.insert("custom_sni", toml_edit::value(s));
        }
    }
    // "h2"/"h3" TLV shorthand → sidecar's "http2"/"http3" identifier.
    let proto_value = match advanced.upstream_protocol.as_deref() {
        Some("h2") => Some("http2"),
        Some("h3") => Some("http3"),
        Some(other) if !other.is_empty() && other != "auto" => Some(other),
        _ => None,
    };
    if let Some(v) = proto_value {
        endpoint.insert("upstream_protocol", toml_edit::value(v));
    }
    // Certificate handling — four states, all feeding the same two outcomes
    // ("pin it" or "strip it"):
    //
    // 1. `pin_cert_der_b64 = Some(self-signed leaf)` → pin it. OpenSSL
    //    treats a self-signed cert as both leaf and trust anchor, so
    //    verification succeeds without reaching for a CA.
    //
    // 2. `pin_cert_der_b64 = Some(leaf + intermediate chain)` → STRIP.
    //    FIX-OO-9/10: pinning an intermediate doesn't work without the
    //    root in the X509_STORE (OpenSSL can't stop chain-walking at an
    //    intermediate — see `X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT`). Since
    //    the only case where a chain appears is a CA-issued cert, and
    //    CA-issued certs are by definition trusted by the OS store,
    //    falling through to `wcrypt_validate_cert` / `tls_verify_cert_0`
    //    with the platform anchors does the right thing.
    //
    // 3. `pin_cert_der_b64 = None` → user opted out of pin (or FIX-OO-7/10
    //    stripped a system-verifiable cert before storage). Strip so the
    //    sidecar uses the OS trust store.
    //
    // 4. No advanced entry at all → handled by the overlay early-return in
    //    `fetch_server_config`. This function never runs.
    //
    // Count PEM blocks to discriminate cases 1 vs 2: one block = self-signed
    // leaf, multiple blocks = chain. Goes through `der_to_pem` (which
    // splits on ASN.1 SEQUENCE boundaries) so the count is structural, not
    // string-match-based.
    match advanced.pin_cert_der_b64.as_deref() {
        Some(s) if !s.is_empty() => {
            let pem = der_b64_to_pem(s)?;
            let block_count = pem.matches("-----BEGIN CERTIFICATE-----").count();
            if block_count > 1 {
                // Chain: strip and let the platform verifier do its job.
                endpoint.remove("certificate");
            } else {
                endpoint.insert("certificate", toml_edit::value(pem));
            }
        }
        _ => {
            endpoint.remove("certificate");
        }
    }
    if !advanced.dns_upstreams.is_empty() {
        let mut arr = toml_edit::Array::new();
        for dns in &advanced.dns_upstreams {
            arr.push(dns.as_str());
        }
        endpoint.insert("dns_upstreams", toml_edit::value(arr));
    }
    Ok(doc.to_string())
}

/// Rename legacy upstream field names to the ones the sidecar actually parses.
///
/// Upstream `client_config.rs` uses `client_random_prefix` when writing the
/// exported client .toml, but the shipped sidecar (`trusttunnel/src/config.cpp`
/// line 140 and the client-side README §Settings) reads `client_random`.
/// Without this rename the anti-DPI prefix never reaches the sidecar and any
/// server rule that requires a matching prefix rejects the handshake — a
/// long-standing upstream divergence we patch client-side.
///
/// `server_display_name` → `name` and `dns_servers` → `dns_upstreams` are the
/// second class of rename (upstream PR 668). Older endpoint builds may still
/// emit the legacy keys; normalize them so all four fields (name,
/// dns_upstreams, client_random, certificate) land under the parser's
/// expected identifiers.
///
/// Uses `toml_edit` rather than string replace so a substring match inside
/// a value (e.g. a display_name containing the literal word
/// "client_random_prefix") cannot corrupt the document.
pub fn normalize_legacy_field_names(client_toml: &str) -> String {
    let Ok(mut doc) = client_toml.parse::<toml_edit::DocumentMut>() else {
        // Unparseable input: leave as-is, the caller will surface the parse
        // failure downstream. Normalization is a belt-and-braces pass.
        return client_toml.to_string();
    };
    if let Some(endpoint) = doc.get_mut("endpoint").and_then(|v| v.as_table_mut()) {
        rename_key(endpoint, "client_random_prefix", "client_random");
        rename_key(endpoint, "server_display_name", "name");
        rename_key(endpoint, "dns_servers", "dns_upstreams");
    }
    doc.to_string()
}

fn rename_key(table: &mut toml_edit::Table, from: &str, to: &str) {
    if table.contains_key(to) {
        // Parser already has the canonical key — drop the legacy one so
        // duplicates don't shadow each other.
        table.remove(from);
        return;
    }
    if let Some(item) = table.remove(from) {
        table.insert(to, item);
    }
}

/// Convert a Base64-encoded DER certificate bundle into PEM armor.
///
/// The input may be a single cert OR a concatenation of leaf + intermediates
/// (which is what `fetch_endpoint_cert` returns post-FIX-OO-6). We delegate
/// to `trusttunnel_deeplink::cert::der_to_pem` — it walks ASN.1 SEQUENCE
/// boundaries in the decoded bytes and emits a separate
/// `-----BEGIN CERTIFICATE-----` block per cert. The sidecar's
/// `PEM_read_bio_X509` loop then loads each block into `X509_STORE`,
/// so OpenSSL has every link of the chain (leaf + intermediate) as trust
/// anchors and verification succeeds.
///
/// FIX-OO-8 (prior bug): earlier revision re-base64'd the whole decoded
/// buffer as a single PEM block. `PEM_read_bio_X509` stopped after the
/// first ASN.1 SEQUENCE (the leaf) and silently dropped the intermediate,
/// leaving the store with just the leaf — which then failed verification
/// with `unable to get local issuer certificate` the moment the sidecar
/// tried to walk the chain.
fn der_b64_to_pem(der_b64: &str) -> Result<String, String> {
    // Round-trip through decode_cert_der_b64 so we reject bad/oversized
    // payloads before shipping them into the client config.
    let bytes = super::decode_cert_der_b64(der_b64)?;
    trusttunnel_settings::trusttunnel_deeplink::cert::der_to_pem(&bytes)
        .map_err(|e| format!("der → pem: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::UserAdvanced;

    fn sample_toml() -> String {
        // Minimal client toml with [endpoint] block produced by build_client_config.
        "# header\n\nloglevel = \"info\"\n\n[endpoint]\nhost = \"1.2.3.4\"\nport = 443\nusername = \"alice\"\npassword = \"secret\"\nanti_dpi = true\n\n[listener.tun]\nmtu_size = 1280\n".to_string()
    }

    fn sample_advanced() -> UserAdvanced {
        UserAdvanced {
            username: "alice".into(),
            display_name: Some("Home".into()),
            custom_sni: Some("cdn.example.com".into()),
            upstream_protocol: Some("h2".into()),
            skip_verification: true,
            // FIX-OO-8: minimum valid ASN.1 SEQUENCE so `der_to_pem` from
            // `trusttunnel_deeplink::cert` can walk the structure. Matches the
            // same synthetic shape used by the upstream crate's own tests
            // (`vec![0x30, 0x03, 0x01, 0x02, 0x03]`). Base64-STANDARD encoded
            // with padding because `decode_cert_der_b64` requires `=`-padding.
            pin_cert_der_b64: Some("MAMBAgM=".into()),
            dns_upstreams: vec!["8.8.8.8".into(), "1.1.1.1".into()],
            anti_dpi: false,
        }
    }

    fn default_advanced() -> UserAdvanced {
        // User who opened Add modal, didn't touch any field, hit Submit.
        // This is the common case — overlay must be a no-op for these users.
        UserAdvanced {
            username: "alice".into(),
            display_name: None,
            custom_sni: None,
            upstream_protocol: None, // UI "auto" → None
            skip_verification: false,
            pin_cert_der_b64: None,
            dns_upstreams: vec![],
            anti_dpi: true, // default_deeplink in UserModal
        }
    }

    #[test]
    fn inject_writes_all_user_customized_fields() {
        let out = inject_advanced_into_endpoint(&sample_toml(), &sample_advanced()).unwrap();
        // `name` (not `display_name`) — sidecar field.
        assert!(out.contains("name = \"Home\""));
        assert!(out.contains("custom_sni = \"cdn.example.com\""));
        // h2 → http2 remapping for sidecar.
        assert!(out.contains("upstream_protocol = \"http2\""));
        assert!(out.contains("skip_verification = true"));
        // Certificate is wrapped as PEM, not DER base64.
        assert!(out.contains("-----BEGIN CERTIFICATE-----"));
        assert!(out.contains("-----END CERTIFICATE-----"));
        assert!(out.contains("\"8.8.8.8\""));
        assert!(out.contains("\"1.1.1.1\""));
        // Boolean overrides the build_client_config anti_dpi=true force.
        assert!(out.contains("anti_dpi = false"));
        // Listener table preserved.
        assert!(out.contains("[listener.tun]"));
    }

    #[test]
    fn inject_remaps_h3_to_http3() {
        let mut adv = sample_advanced();
        adv.upstream_protocol = Some("h3".into());
        let out = inject_advanced_into_endpoint(&sample_toml(), &adv).unwrap();
        assert!(out.contains("upstream_protocol = \"http3\""));
    }

    #[test]
    fn inject_is_noop_for_default_user() {
        // FIX-OO regression test: a user with no advanced customization
        // must get the exact same TOML as pre-FIX-NN flow — in particular,
        // no `skip_verification = false` (which switches sidecar from
        // lenient to strict mode on self-signed endpoints).
        let before = sample_toml();
        let after = inject_advanced_into_endpoint(&before, &default_advanced()).unwrap();
        // No new booleans added (anti_dpi stays where build_client_config put it).
        assert!(!after.contains("skip_verification"));
        // No optional strings added.
        assert!(!after.contains("\nname = "));
        assert!(!after.contains("custom_sni"));
        assert!(!after.contains("upstream_protocol"));
        assert!(!after.contains("certificate"));
        assert!(!after.contains("dns_upstreams"));
        // anti_dpi line is untouched from input (build_client_config wrote true).
        assert!(after.contains("anti_dpi = true"));
    }

    #[test]
    fn inject_writes_anti_dpi_false_only_when_user_opted_out() {
        let mut adv = default_advanced();
        adv.anti_dpi = false;
        let out = inject_advanced_into_endpoint(&sample_toml(), &adv).unwrap();
        // Override: build_client_config forced true, user opted out → we write false.
        assert!(out.contains("anti_dpi = false"));
    }

    #[test]
    fn inject_writes_skip_verification_only_when_user_opted_in() {
        let mut adv = default_advanced();
        adv.skip_verification = true;
        let out = inject_advanced_into_endpoint(&sample_toml(), &adv).unwrap();
        assert!(out.contains("skip_verification = true"));
    }

    #[test]
    fn inject_preserves_existing_endpoint_fields() {
        let out = inject_advanced_into_endpoint(&sample_toml(), &sample_advanced()).unwrap();
        assert!(out.contains("host = \"1.2.3.4\""));
        assert!(out.contains("username = \"alice\""));
        assert!(out.contains("password = \"secret\""));
    }

    #[test]
    fn inject_errors_when_endpoint_missing() {
        let broken = "[other]\nfoo = 1\n";
        assert!(inject_advanced_into_endpoint(broken, &sample_advanced()).is_err());
    }

    #[test]
    fn inject_errors_on_bad_cert_b64() {
        let mut adv = sample_advanced();
        adv.pin_cert_der_b64 = Some("!!!not-base64!!!".into());
        assert!(inject_advanced_into_endpoint(&sample_toml(), &adv).is_err());
    }

    #[test]
    fn normalize_renames_client_random_prefix_to_client_random() {
        let input = "[endpoint]\nhostname = \"h\"\nclient_random_prefix = \"aabbccdd\"\n";
        let out = normalize_legacy_field_names(input);
        assert!(out.contains("client_random = \"aabbccdd\""));
        assert!(!out.contains("client_random_prefix"));
    }

    #[test]
    fn normalize_renames_server_display_name_and_dns_servers() {
        let input = "[endpoint]\nhostname = \"h\"\nserver_display_name = \"Home\"\ndns_servers = [\"1.1.1.1\"]\n";
        let out = normalize_legacy_field_names(input);
        assert!(out.contains("name = \"Home\""));
        assert!(out.contains("dns_upstreams ="));
        assert!(!out.contains("server_display_name"));
        assert!(!out.contains("dns_servers"));
    }

    #[test]
    fn normalize_keeps_canonical_wins_over_legacy() {
        // If both the new name and the legacy name appear (unusual but
        // possible during a migration window) keep the canonical and drop
        // the legacy one — the sidecar only reads the canonical.
        let input = "[endpoint]\nclient_random = \"canonical\"\nclient_random_prefix = \"legacy\"\n";
        let out = normalize_legacy_field_names(input);
        assert!(out.contains("client_random = \"canonical\""));
        assert!(!out.contains("client_random_prefix"));
        assert!(!out.contains("\"legacy\""));
    }

    #[test]
    fn normalize_is_noop_when_no_legacy_keys() {
        let input = "[endpoint]\nhostname = \"h\"\nclient_random = \"aabb\"\nname = \"Home\"\n";
        let out = normalize_legacy_field_names(input);
        assert!(out.contains("client_random = \"aabb\""));
        assert!(out.contains("name = \"Home\""));
    }

    #[test]
    fn normalize_handles_unparseable_input() {
        // Malformed TOML shouldn't panic; return unchanged so the caller
        // surfaces the parse error downstream.
        let input = "not = [valid toml";
        assert_eq!(normalize_legacy_field_names(input), input);
    }

    #[test]
    fn inject_strips_cli_certificate_when_user_did_not_pin() {
        // FIX-OO-9 regression guard. When the endpoint CLI writes the full
        // chain into `certificate = """..."""` (it does this when its
        // server-side `is_system_verifiable` check fails for whatever
        // reason), the client ends up with a multi-cert PEM that OpenSSL
        // can't walk without ISRG Root X1 as a trust anchor. If the user
        // explicitly chose NOT to pin (advanced entry exists but
        // pin_cert_der_b64 is None), strip the field so the sidecar falls
        // back to the OS trust store.
        let with_cli_cert = "[endpoint]\nhostname = \"h\"\ncertificate = \"\"\"-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----\\n\"\"\"\nanti_dpi = true\n";
        let out = inject_advanced_into_endpoint(with_cli_cert, &default_advanced()).unwrap();
        assert!(!out.contains("certificate"), "certificate must be stripped; got: {out}");
    }

    #[test]
    fn der_b64_to_pem_single_cert() {
        // Minimal ASN.1 SEQUENCE: tag 0x30, length 3, body 0x01 0x02 0x03.
        let der_b64 = "MAMBAgM=";
        let pem = der_b64_to_pem(der_b64).unwrap();
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\n"));
        assert!(pem.trim_end().ends_with("-----END CERTIFICATE-----"));
        assert_eq!(pem.matches("-----BEGIN CERTIFICATE-----").count(), 1);
    }

    // ── M-01: allowed_sni parser tests ──────────────────────────────────

    #[test]
    fn allowed_sni_parses_single_host_with_whitelist() {
        let content = r#"
[[main_hosts]]
hostname = "abphotography.ru"
cert_chain_path = "certs/cert.pem"
private_key_path = "certs/key.pem"
allowed_sni = ["cdn.example.com", "www.google.com"]
"#;
        let parsed = parse_allowed_sni_from_hosts_toml(content);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hostname, "abphotography.ru");
        assert_eq!(parsed[0].allowed_sni, vec!["cdn.example.com", "www.google.com"]);
    }

    #[test]
    fn allowed_sni_defaults_to_empty_when_omitted() {
        // Pristine deploy.rs output has hostname + cert paths, no allowed_sni.
        let content = r#"
[[main_hosts]]
hostname = "abphotography.ru"
cert_chain_path = "certs/cert.pem"
private_key_path = "certs/key.pem"
"#;
        let parsed = parse_allowed_sni_from_hosts_toml(content);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hostname, "abphotography.ru");
        assert!(parsed[0].allowed_sni.is_empty());
    }

    #[test]
    fn allowed_sni_parses_multiple_hosts() {
        let content = r#"
[[main_hosts]]
hostname = "vpn1.example.com"
cert_chain_path = "certs/cert.pem"
private_key_path = "certs/key.pem"
allowed_sni = ["cdn1.example.com"]

[[main_hosts]]
hostname = "vpn2.example.com"
cert_chain_path = "certs/cert.pem"
private_key_path = "certs/key.pem"
"#;
        let parsed = parse_allowed_sni_from_hosts_toml(content);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].hostname, "vpn1.example.com");
        assert_eq!(parsed[0].allowed_sni, vec!["cdn1.example.com"]);
        assert_eq!(parsed[1].hostname, "vpn2.example.com");
        assert!(parsed[1].allowed_sni.is_empty());
    }

    #[test]
    fn allowed_sni_ignores_ping_and_speedtest_hosts() {
        // Only [[main_hosts]] feeds the Custom SNI whitelist — ping_hosts
        // / speedtest_hosts / reverse_proxy_hosts are for different flows
        // and the CLI doesn't consult them for the `custom_sni` check.
        let content = r#"
[[main_hosts]]
hostname = "main.example.com"

[[ping_hosts]]
hostname = "ping.example.com"
allowed_sni = ["should.be.ignored"]

[[speedtest_hosts]]
hostname = "speed.example.com"
"#;
        let parsed = parse_allowed_sni_from_hosts_toml(content);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hostname, "main.example.com");
    }

    #[test]
    fn allowed_sni_returns_empty_on_malformed_input() {
        // Soft-fail: empty file, blank string, garbage — UI falls back to
        // "no suggestions" rather than blocking the modal with a parse error.
        assert!(parse_allowed_sni_from_hosts_toml("").is_empty());
        assert!(parse_allowed_sni_from_hosts_toml("not = [valid toml").is_empty());
    }

    #[test]
    fn allowed_sni_skips_entries_without_hostname() {
        // Defensive: an empty hostname would be useless in an autocomplete
        // list. toml's `#[serde(default)]` fills in "", we filter those out.
        let content = r#"
[[main_hosts]]
allowed_sni = ["orphan.example.com"]

[[main_hosts]]
hostname = "valid.example.com"
"#;
        let parsed = parse_allowed_sni_from_hosts_toml(content);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hostname, "valid.example.com");
    }

    #[test]
    fn der_b64_to_pem_splits_concatenated_chain() {
        // FIX-OO-8 regression guard: input bytes are TWO ASN.1 SEQUENCEs
        // concatenated (leaf + intermediate). Output MUST emit two separate
        // PEM blocks so the sidecar's `PEM_read_bio_X509` loop loads both
        // into X509_STORE. Earlier revision re-base64'd the whole buffer
        // into a single block and lost the intermediate, breaking cert
        // pinning with `unable to get local issuer certificate`.
        //
        // Concat of 5-byte [0x30, 0x03, 0x01, 0x02, 0x03] + 6-byte
        // [0x30, 0x04, 0x04, 0x05, 0x06, 0x07]. Base64-STANDARD (padding
        // required by decode_cert_der_b64) → "MAMBAgMwBAQFBgc=".
        let der_b64 = "MAMBAgMwBAQFBgc=";
        let pem = der_b64_to_pem(der_b64).unwrap();
        assert_eq!(pem.matches("-----BEGIN CERTIFICATE-----").count(), 2);
        assert_eq!(pem.matches("-----END CERTIFICATE-----").count(), 2);
    }
}
