use super::super::*;
use super::super::sanitize::{validate_client_name, validate_display_name, validate_fqdn_sni, validate_dns_list, validate_ssh_host};
use russh::client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use super::users_advanced::UserAdvanced;

/// S-5 (04-SECURITY-REVIEW.md): the `endpoint_hostname` we read from the server's
/// `hosts.toml` (and the `hostname -f` fallback) is server-controlled and gets
/// interpolated UNQUOTED into the `-a {host:port}` arg of the deeplink-export
/// command. A malicious / compromised server could return a hostname containing
/// shell metacharacters (`a.com; rm -rf /`) and run arbitrary commands under the
/// operator's `sudo`. Before using such a hostname we run it through the existing
/// whitelist `validate_ssh_host` (hostname / IPv4 / IPv6 charset only). On failure
/// we return `None` so the caller falls through to its safe fallback instead of
/// interpolating attacker-controlled bytes. Whitelist-first per CLAUDE.md SAFETY-01.
fn validated_server_host(hostname: &str) -> Option<&str> {
    let h = hostname.trim();
    if h.is_empty() || h == "trusttunnel.local" {
        return None;
    }
    match validate_ssh_host(h) {
        Ok(()) => Some(h),
        Err(_) => None,
    }
}

/// WR-01 (04-REVIEW.md): the anti-DPI `client_random_prefix` we read back from the
/// server's `rules.toml` (via `find_user_rule`) is interpolated UNQUOTED into the
/// export command as `-r {prefix}`. Like `validated_server_host` (S-5), this value
/// crosses back from the remote host into a shell argument, so it MUST be
/// whitelist-validated before interpolation — not merely assumed-hex because of who
/// is supposed to have written the file. `rules.toml` lives on the remote and can be
/// edited out-of-band; a value like `aa; reboot` would otherwise inject a command
/// under the same `sudo` context. We require a non-empty, <=64-char string of ASCII
/// hex digits (the canonical shape `server_rules.rs` emits via `format!("{:02x}", ...)`)
/// and return `None` otherwise so the caller simply omits the `-r` flag.
/// Whitelist-first per CLAUDE.md SAFETY-01.
fn validated_hex_prefix(p: &str) -> Option<&str> {
    (!p.is_empty() && p.len() <= 64 && p.chars().all(|c| c.is_ascii_hexdigit())).then_some(p)
}

// ── REQ-15.1: Typed vpn.toml parser with extras preservation ───────────────
//
// Pattern follows `commands/config.rs::ClientConfig` (Phase 14.1 — known fields
// typed for safety, unknown fields preserved via `#[serde(flatten)] extra` so
// upstream sidecar additions don't get silently dropped on roundtrip).

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(default)]
pub struct VpnConfigKnown {
    // Quick Settings (D-1) — фокус Plan 04
    pub listen_address: String,
    pub ipv6_available: bool,
    pub allow_private_network_connections: bool,
    pub log_level: Option<String>,
    pub auth_failure_status_code: u16,

    // Already-shipped Overview toggles (D-1 — НЕ дублировать в Quick Settings UI;
    // парсятся для полноты bundle, но frontend Configuration не редактирует)
    pub ping_enable: bool,
    pub speedtest_enable: bool,
    pub ping_path: String,
    pub speedtest_path: String,

    // Required paths
    pub credentials_file: String,

    // Catch-all для всего остального (timeouts, listen_protocols.*, forward_protocol,
    // reverse_proxy, icmp, metrics) — preserved verbatim для Advanced editor
    #[serde(flatten)]
    pub extra: HashMap<String, toml::Value>,
}

impl Default for VpnConfigKnown {
    fn default() -> Self {
        Self {
            listen_address: "0.0.0.0:443".into(),
            ipv6_available: true,
            allow_private_network_connections: false,
            log_level: None,
            auth_failure_status_code: 407,
            ping_enable: false,
            speedtest_enable: false,
            ping_path: "/ping".into(),
            speedtest_path: "/speedtest".into(),
            credentials_file: "credentials.toml".into(),
            extra: HashMap::new(),
        }
    }
}

// REQ-15.1 extended: ConfigBundle covers 4 TOML files + service status (Phase 15.1).
// Plan 15.1-01 D-PRE-1: schema-driven editor reads vpn.toml + hosts.toml +
// credentials.toml + rules.toml in a single SSH channel (Pitfall 4 mitigation).
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfigBundle {
    pub vpn_toml: String,
    pub hosts_toml: String,
    pub credentials_toml: String, // NEW Phase 15.1 — D-2.1 read-only preview (full content, masked at frontend D-11.1)
    pub rules_toml: String,       // NEW Phase 15.1 — D-2.3 editable с frontend-side ownership merge
    pub typed: VpnConfigKnown,
    pub allowed_sni: Vec<AllowedSniHost>,
    pub service_status: String,
}

/// Pure helper: parse raw vpn.toml string into typed struct, soft-failing to default
/// (so a corrupt server config doesn't break the entire UI).
pub fn parse_vpn_config_known(raw: &str) -> VpnConfigKnown {
    toml::from_str::<VpnConfigKnown>(raw).unwrap_or_default()
}

/// Pure helper: format-preserving listen_address mutation. Tested in isolation.
/// Layer 1 = char whitelist (returns Err with shell-metachar); Layer 2 = toml_edit parse (returns Err on malformed TOML).
pub fn update_listen_address_in_toml(raw_toml: &str, new_addr: &str) -> Result<String, String> {
    crate::ssh::sanitize::validate_listen_address(new_addr)?;
    let mut doc: toml_edit::DocumentMut = raw_toml
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse vpn.toml: {e}"))?;
    doc["listen_address"] = toml_edit::value(new_addr);
    Ok(doc.to_string())
}

/// Bundle parser: split raw &&-chained shell output into 5 sections by markers.
/// Returns (vpn_toml, hosts_toml, credentials_toml, rules_toml, service_status).
/// All five default to "" if marker missing (forward-compatible — Phase 15.1).
pub fn parse_config_bundle_output(raw: &str) -> (String, String, String, String, String) {
    let mut vpn = String::new();
    let mut hosts = String::new();
    let mut credentials = String::new();
    let mut rules = String::new();
    let mut service = String::new();
    let mut state: u8 = 0; // 0=skip, 1=vpn, 2=hosts, 3=credentials, 4=rules, 5=service
    for line in raw.lines() {
        match line.trim() {
            "---VPN_TOML---" => {
                state = 1;
                continue;
            }
            "---HOSTS_TOML---" => {
                state = 2;
                continue;
            }
            "---CREDENTIALS_TOML---" => {
                state = 3;
                continue;
            }
            "---RULES_TOML---" => {
                state = 4;
                continue;
            }
            "---SERVICE---" => {
                state = 5;
                continue;
            }
            _ => {}
        }
        match state {
            1 => {
                vpn.push_str(line);
                vpn.push('\n');
            }
            2 => {
                hosts.push_str(line);
                hosts.push('\n');
            }
            3 => {
                credentials.push_str(line);
                credentials.push('\n');
            }
            4 => {
                rules.push_str(line);
                rules.push('\n');
            }
            5 => {
                service.push_str(line.trim());
            }
            _ => {}
        }
    }
    (vpn, hosts, credentials, rules, service)
}

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

/// Render a REJECTED client name so it is safe to put in a `CODE|detail` payload.
///
/// Phase 25 (WR-01): `SSH_CLIENT_NAME_INVALID|{name}` exists to tell the user WHICH name was
/// refused — but the name is here precisely because it failed `validate_client_name`'s
/// whitelist, so it may hold anything the frontend (or a hand-edited server
/// `credentials.toml`) put there: the `|` that separates code from detail, newlines, or
/// megabytes of text. Both would be at the sender's discretion in the user's snackbar.
///
/// Per the project's whitelist-not-blacklist rule this keeps only the characters the
/// validator itself accepts and replaces every other one with `?`, then caps the result at
/// the validator's own 64-character limit (a name longer than that is invalid by definition,
/// so nothing legitimate is ever truncated). The `…` marks the cut so the user can tell a
/// truncated echo from a short name.
fn echo_safe_client_name(s: &str) -> String {
    const MAX_ECHO: usize = 64; // == validate_client_name's own upper bound
    let mut out: String = s
        .chars()
        .take(MAX_ECHO)
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '?' })
        .collect();
    if s.chars().nth(MAX_ECHO).is_some() {
        out.push('…');
    }
    out
}

/// Connect to a server where TrustTunnel is already installed,
/// export the client config via trusttunnel_endpoint, and save it locally.
/// NOTE: This function uses direct connect (NOT pooled) — deploy-style flow with emit_step.
pub async fn fetch_server_config(
    app: &tauri::AppHandle,
    params: SshParams,
    client_name: String,
    // #22: the frontend's per-run generation (same stamp rationale as deploy_server). The
    // post-deploy FINALIZE re-export passes the SAME op_id as the deploy run so its
    // re-emitted connect/auth/check/export/save/done cycle is stamped with the run that is
    // on screen; a standalone fetch passes its own fresh op_id.
    op_id: u64,
    // Best-effort GeoIP country code (Tauri maps JS `countryCode`) used ONLY to brand the
    // LOCAL config filename `[<CC>_]TrustTunnel_<login>.toml` so a re-export writes the
    // SAME branded name the Save-As dialog defaults to. None when unknown → no prefix.
    // client_config_filename ignores any non-2-ASCII-letter value, so it is safe unvalidated.
    country_code: Option<String>,
    // Phase 19 UAT: the Users-tab «Скачать конфиг» is a SAVE-to-a-chosen-location action, NOT an
    // "add to app". When Some(true) the export stages into the OS temp dir instead of
    // user_data_dir(), so the folder-as-truth adoption scan (which only reads the data dir) never
    // sees it → no unwanted Connection-tab card, and no in-place overwrite of a same-named tracked
    // config. The wizard's FINALIZE re-export omits this (None) → still writes the active config into
    // the data dir as before. (Tauri maps JS `stageToTemp`.)
    stage_to_temp: Option<bool>,
) -> Result<String, String> {
    super::super::set_deploy_op_id(op_id);
    emit_step(app, "connect", "progress", "Connecting to server...");
    let handle = params.connect_with_app(app.clone()).await
        .inspect_err(|e| { emit_step(app, "connect", "error", e); })?;
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    // Check TrustTunnel is installed
    emit_step(app, "check", "progress", "Checking TrustTunnel on server...");

    let (bin_check, _) = exec_command(
        &handle, app,
        &format!("test -f {bin} && echo TT_EXISTS || echo TT_MISSING", bin = ENDPOINT_BINARY)
    ).await?;

    if !bin_check.contains("TT_EXISTS") {
        // Phase 25 (WR-01 / D-05): the STEP channel and the RETURN value deliberately carry
        // different text — do not "simplify" them back into one `msg` binding.
        //   • The step payload keeps the human sentence, because `DeployingStep.tsx:233`
        //     renders `step.message` VERBATIM for an errored row. Feeding it a bare
        //     `SSH_…|…` would put machine text on the wizard's progress list.
        //   • The Err is what reaches the Users-tab download snackbar, which translates by
        //     stable code (`translateSshError`). Before this it returned English prose with
        //     no code at all, so neither translator could touch it and the user read
        //     «TrustTunnel not found on server (/opt/…)» in English.
        // The binary path stays in the code's detail slot so the activity log keeps
        // everything the old message carried; the Russian copy does not render it (a
        // non-technical reader cannot act on an absolute server path).
        emit_step(
            app,
            "check",
            "error",
            &format!("TrustTunnel not found on server ({bin})", bin = ENDPOINT_BINARY),
        );
        return Err(format!("SSH_ENDPOINT_NOT_INSTALLED|{bin}", bin = ENDPOINT_BINARY));
    }

    // Check config files exist
    let (cfg_check, _) = exec_command(
        &handle, app,
        &format!("test -f {dir}/vpn.toml && test -f {dir}/hosts.toml && echo CFG_OK || echo CFG_MISSING", dir = ENDPOINT_DIR)
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        // Same step/return split as the binary check above. No detail slot: the two file
        // names are a compile-time constant of the endpoint layout, so the Russian sentence
        // can name them itself instead of interpolating a value that never varies.
        emit_step(
            app,
            "check",
            "error",
            "Configuration files not found on server (vpn.toml / hosts.toml)",
        );
        return Err("SSH_ENDPOINT_CONFIG_MISSING".into());
    }

    emit_step(app, "check", "ok", "TrustTunnel installed, config found");

    // Determine the server's listen address for the export command
    let (listen_raw, _) = exec_command(
        &handle, app,
        &format!(r#"grep -oP 'listen_address\s*=\s*"\K[^"]+' {cfg} 2>/dev/null || echo '0.0.0.0:443'"#, cfg = ENDPOINT_CONFIG)
    ).await?;
    let listen_addr = listen_raw.trim();
    let listen_port = listen_addr.split(':').next_back().unwrap_or("443");

    // Try to determine the address the endpoint uses (domain from hosts.toml or fallback to host IP)
    let (hostname_raw, _) = exec_command(
        &handle, app,
        &format!(r#"grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR)
    ).await?;
    // S-5: validate the server-returned hostname before interpolating it into
    // the `-a` flag; on reject, fall back to the operator-provided `params.host`
    // (which is itself validated by validate_ssh_host at the connect layer).
    let export_address = match validated_server_host(hostname_raw.trim()) {
        Some(h) => format!("{h}:{listen_port}"),
        None => format!("{}:{listen_port}", params.host),
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
        first.to_string()
    } else {
        "client".to_string()
    };

    // IN-04 (04-REVIEW.md): validate the client name BEFORE it is logged or used.
    // When `name` is auto-picked from `available_users` it is a value read off the
    // server's credentials.toml — a malicious username there would otherwise reach
    // the deploy-log event (emit_log is sanitized for `key = value` secrets, but a
    // username is not secret-shaped) before the validation gate. Validate first so
    // the auto-picked username is never logged unvalidated.
    //
    // Phase 25 (WR-01 / D-05): wrap the shared validator's English prose in a stable code.
    // `validate_client_name` itself is left ALONE on purpose. Its other two production
    // callers are the deeplink exports (`export_config_deeplink` / `..._advanced`), whose
    // failure lands in `UserConfigModal`'s `setDeeplinkError(formatError(e))` and is rendered
    // RAW (`message={effectiveError}`, UserConfigModal.tsx:414). Changing the validator
    // globally would swap an English sentence for a bare machine code on that surface —
    // a regression, not a fix. So the code is minted at THIS call site only.
    validate_client_name(&name).map_err(|e| {
        // The log/step channel keeps the validator's own reason (which of the two rules
        // was broken); the returned code carries the refused NAME, which is what the user
        // has to change. Neither channel loses information the other had.
        emit_step(app, "export", "error", &format!("Invalid client name: {e}"));
        format!("SSH_CLIENT_NAME_INVALID|{}", echo_safe_client_name(&name))
    })?;

    if client_name.trim().is_empty() && !available_users.is_empty() {
        emit_log(app, "info", &format!("Client name not specified, using: {name}"));
    }

    if !available_users.is_empty() {
        emit_log(app, "info", &format!("Available users: {}", available_users.join(", ")));
        if !available_users.contains(&name.as_str()) {
            let available = available_users.join(", ");
            // Same step/return split. BOTH details survive into the code — which user was
            // asked for and which ones the server actually has is the whole actionable
            // content of this failure, so the Russian copy renders them (dropping them
            // would leave the user with "not found" and nothing to do about it).
            // `name` is whitelist-validated above; the available list is server-controlled
            // and echoed the same way `SSH_EXPORT_FAILED|{code}|{users}` already echoes it
            // (the frontend rejoins everything past the second `|`, so a username
            // containing a separator cannot truncate the list — see translateSshError).
            emit_step(
                app,
                "export",
                "error",
                &format!("User '{name}' not found in credentials.toml. Available: {available}"),
            );
            return Err(format!("SSH_USER_NOT_IN_CREDENTIALS|{name}|{available}"));
        }
    }

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
    // WR-01: whitelist-validate the server-read prefix (hex only) before it
    // becomes an unquoted shell argument. An out-of-band-edited rules.toml could
    // otherwise smuggle `aa; reboot` into the sudo'd export command.
    let r_flag = stored_prefix
        .as_deref()
        .and_then(validated_hex_prefix)
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
    // (lib/src/client_config.rs — first seen at v1.0.33, re-checked at the
    // v1.1.0 pin on 2026-09-04 and STILL the case) writes the anti-DPI hex value as
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

    // ── gap 5b-2: auto-apply the self-signed cert policy on the FETCH path ────
    //
    // ROOT CAUSE (16-UAT round 3): the config the owner gets after install is
    // produced by THIS fetch path (header "Fetched from server <ip>"), which
    // DoneStep re-invokes when adding the config (same command as the Users-tab
    // "save config"). Before this, the fetch path applied skip_verification /
    // cert-pin / custom_sni ONLY from the user's MANUALLY-saved advanced options
    // (users-advanced.toml). The owner set none → a self-hosted (self-signed)
    // config shipped WITHOUT them → OS-store validation rejected the self-signed
    // cert → stuck on «Переключение». 16-06 fixed only `deploy_export_config`
    // (a DIFFERENT function). We must ALSO auto-apply here, keyed on the actual
    // cert trust (is_system_verifiable), not manual toggles — mirroring
    // deploy_export_config (deploy.rs:1386-1440).
    //
    // Derive the probe target from the built [endpoint]:
    //   - sni        = the endpoint hostname (e.g. trusttunnel.local); NEVER a
    //                  bare IP (fetch_endpoint_cert rejects IP SNI).
    //   - probe_host = the host part of addresses[0] (the real dial IP),
    //                  fallback to params.host.
    //   - probe_port = the port from addresses[0], default 443.
    // The probe is NON-FATAL: on error we degrade to skip_verification-only
    // (the minimum working state), never fail the fetch. LE (is_system_verifiable
    // == true) is left untouched (OS store), matching today's behavior.
    {
        let (sni, probe_host, probe_port) =
            parse_probe_target_from_endpoint(&client_toml, &params.host);
        let probe = match crate::ssh::server::fetch_endpoint_cert(&probe_host, probe_port, &sni).await {
            Ok(info) => {
                let pinned_pem = if info.is_system_verifiable {
                    None
                } else {
                    match der_b64_to_pem(&info.leaf_der_b64) {
                        Ok(pem) => Some(pem),
                        Err(e) => {
                            emit_log(app, "warn", &format!(
                                "Cert probe returned an unusable certificate; \
                                 degrading to skip_verification only: {e}"
                            ));
                            None
                        }
                    }
                };
                Some(FetchProbeOutcome {
                    is_system_verifiable: info.is_system_verifiable,
                    pinned_pem,
                    pin_verifiable: info.pin_verifiable,
                })
            }
            Err(e) => {
                emit_log(app, "warn", &format!(
                    "Cert probe failed; degrading to skip_verification only: {e}"
                ));
                None
            }
        };
        match apply_fetched_self_signed_policy(&client_toml, probe) {
            Ok(updated) => client_toml = updated,
            Err(e) => emit_log(app, "warn", &format!("self-signed policy apply failed: {e}")),
        }
    }

    emit_step(app, "export", "ok", "Config received");

    // Save locally
    emit_step(app, "save", "progress", "Saving configuration...");

    // Phase 19 UAT: a DOWNLOAD stages outside the data dir (temp) so adoption never turns it into a
    // card; the wizard re-export keeps writing the active config into the data dir.
    let config_dir = if stage_to_temp.unwrap_or(false) {
        std::env::temp_dir()
    } else {
        user_data_dir()
    };
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("SSH_MKDIR_FAILED|{e}"))?;

    // UAT 2026-06-19 (R1 consistency): write the SAME branded per-login
    // `[<CC>_]TrustTunnel_<login>.toml` that an install-time deploy writes (deploy.rs
    // deploy_export_config), instead of a hardcoded `trusttunnel_client.toml`. Otherwise
    // a post-deploy advanced re-export (anti-DPI / Custom SNI / DNS / display name) lands
    // in a DIFFERENT file than the basic one deploy just wrote, and the active install-time
    // config stays basic — and the on-disk name would diverge from the Save-As default.
    // `name` is the validated first-user login (validate_client_name above); we JOIN a
    // BARE filename onto config_dir — never interpolate into a path — and
    // `client_config_filename` adds the branding + empty/degenerate + Windows
    // reserved-name guards and ignores a malformed country.
    let client_config_path = config_dir.join(super::super::deploy::client_config_filename(
        &name,
        country_code.as_deref(),
    ));
    // PP-1: the re-exported client config carries the endpoint password — write it atomically so
    // a crash / power-loss mid-write can never leave it truncated (same guarantee as deploy.rs).
    crate::commands::manifest::write_bytes_atomic(&client_config_path, client_toml.as_bytes())
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
    let listen_port = listen_addr.split(':').next_back().unwrap_or("443");

    // Try to determine hostname from hosts.toml, fallback to connection host
    let (hostname_raw, _) = exec_command(
        handle,
        app,
        &format!(r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#, dir = ENDPOINT_DIR),
    )
    .await?;
    // S-5: validate the server-returned hostname from hosts.toml; if it is absent
    // or fails the whitelist, fall back to the server's own `hostname -f` (also
    // server-controlled → validated too); if that is unusable, default to localhost.
    let export_address = match validated_server_host(hostname_raw.trim()) {
        Some(h) => format!("{h}:{listen_port}"),
        None => {
            // Fallback: use the hostname from the server's perspective
            let (host_raw, _) = exec_command(handle, app, "hostname -f 2>/dev/null || hostname").await.unwrap_or_default();
            match validated_server_host(host_raw.trim()) {
                Some(fb) => format!("{fb}:{listen_port}"),
                None => format!("localhost:{listen_port}"),
            }
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
        .rfind(|l| l.starts_with("trusttunnel://") || l.starts_with("tt://"))
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

    // CF-02: read the server's `ipv6_available` flag from vpn.toml so we can
    // forward it into the deeplink. Spec default is `true` (TLV 0x04 omitted);
    // we only emit `has_ipv6 = false` when the server has IPv6 disabled. The grep
    // matches `ipv6_available = false` (whitespace-tolerant); anything else
    // (true, missing, malformed) leaves the default `true` — the safe assumption
    // that keeps existing servers behaving exactly as before this change.
    let (ipv6_raw, _) = exec_command(
        handle,
        app,
        &format!(
            r#"{sudo}grep -oP 'ipv6_available\s*=\s*\K(true|false)' {cfg} 2>/dev/null | head -1 || echo 'true'"#,
            cfg = ENDPOINT_CONFIG
        ),
    )
    .await
    .unwrap_or((String::from("true"), 0));
    let ipv6_available = ipv6_raw.trim() != "false";

    let (hostname_raw, _) = exec_command(
        handle,
        app,
        &format!(
            r#"{sudo}grep -oP 'hostname\s*=\s*"\K[^"]+' {dir}/hosts.toml 2>/dev/null | head -1"#,
            dir = ENDPOINT_DIR
        ),
    )
    .await?;
    // S-5: validate the server-returned hostname before it crosses into the
    // unquoted `-a {host:port}` arg of the deeplink-export command; reject →
    // fall back to the server's `hostname -f` (validated) → localhost.
    let export_address = match validated_server_host(hostname_raw.trim()) {
        Some(h) => format!("{h}:{listen_port}"),
        None => {
            let (host_raw, _) =
                exec_command(handle, app, "hostname -f 2>/dev/null || hostname").await.unwrap_or_default();
            match validated_server_host(host_raw.trim()) {
                Some(fb) => format!("{fb}:{listen_port}"),
                None => format!("localhost:{listen_port}"),
            }
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
    // WR-01: the stored prefix is server-controlled (read from rules.toml on the
    // remote host) and interpolated UNQUOTED as `-r {prefix}`. Do NOT trust the
    // "always hex because server_rules.rs wrote it" assumption — rules.toml can be
    // edited out-of-band. Whitelist-validate (hex only) before interpolation; a
    // non-hex value simply drops the `-r` flag instead of injecting under sudo.
    if let Some(prefix) = stored_prefix.as_deref().and_then(validated_hex_prefix) {
        cli_args.push_str(&format!(" -r {prefix}"));
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
        .rfind(|l| l.starts_with("tt://") || l.starts_with("trusttunnel://"))
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

    // PATH A — post-encode the gap TLVs via tlv_encoder. `ipv6_available` is
    // forwarded so CF-02 (0x04 has_ipv6=false) emits when the server has IPv6
    // disabled; CF-01 (0x00 version=1) is prepended inside append_missing_tlvs.
    super::tlv_encoder::append_missing_tlvs(
        &base_deeplink,
        ipv6_available,
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

    if let Some(s) = advanced.display_name.as_deref() {
        if !s.is_empty() {
            endpoint.insert("name", toml_edit::value(s));
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
    if !advanced.dns_upstreams.is_empty() {
        let mut arr = toml_edit::Array::new();
        for dns in &advanced.dns_upstreams {
            arr.push(dns.as_str());
        }
        endpoint.insert("dns_upstreams", toml_edit::value(arr));
    }

    // The three INSTALL-relevant fields (skip_verification / certificate /
    // custom_sni) are written through the shared `apply_install_cert_policy`
    // helper so the fetch path (here) and the install path (deploy_export_config)
    // stay a single source of truth (gap 5b). The four-state
    // certificate discrimination — Some(self-signed leaf) ⇒ pin,
    // Some(leaf+intermediate chain) ⇒ strip (FIX-OO-9/10: pinning an
    // intermediate breaks OpenSSL chain-walking; a CA-issued chain is trusted
    // by the OS store), None ⇒ strip — now lives inside the helper. We convert
    // the DER-b64 to PEM here (preserving the bad-b64 → Err contract) and hand
    // the PEM to the helper, which counts BEGIN-blocks to pick pin-vs-strip.
    let pinned_pem = match advanced.pin_cert_der_b64.as_deref() {
        Some(s) if !s.is_empty() => Some(der_b64_to_pem(s)?),
        _ => None,
    };
    let policy = InstallCertPolicy {
        // skip_verification: only write when user opted IN (additive contract).
        skip_verification: advanced.skip_verification,
        pinned_pem,
        // custom_sni: only written when non-empty (empty ⇒ untouched).
        custom_sni: advanced
            .custom_sni
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string(),
    };
    apply_install_cert_policy(&doc.to_string(), &policy)
}

/// The three install-relevant `[endpoint]` cert-policy fields, shared by the
/// Users-tab fetch path (`inject_advanced_into_endpoint`) and the install path
/// (`deploy_export_config`). Introduced for gap 5b so a fresh self-hosted
/// install ships the exact config the owner previously had to hand-edit.
///
/// This is the single source of truth for how `skip_verification`,
/// `certificate` and `custom_sni` are written into a client TOML's `[endpoint]`
/// table; both call sites feed it here so the leaf-vs-chain discrimination and
/// the additive-write contract (FIX-OO: never emit an explicit `false`) cannot
/// drift apart between the two flows.
pub(crate) struct InstallCertPolicy {
    /// `true` ⇒ write `skip_verification = true`. `false` ⇒ leave the key
    /// ABSENT (never write an explicit `false` — FIX-OO additive contract:
    /// an explicit `false` flips the sidecar from lenient to strict mode).
    pub skip_verification: bool,
    /// `None` ⇒ strip `[endpoint].certificate`. `Some(pem)` ⇒ pin it when the
    /// PEM is a single BEGIN-block (self-signed leaf); strip it when the PEM is
    /// a multi-block chain (a CA chain is handled by the OS trust store —
    /// pinning an intermediate fails OpenSSL chain-walking, see
    /// `inject_advanced_into_endpoint` case 2).
    pub pinned_pem: Option<String>,
    /// Written only when non-empty; empty leaves the key untouched.
    pub custom_sni: String,
}

/// Apply the install-time cert policy to a client TOML's `[endpoint]` table.
///
/// Reuses the leaf-vs-chain discrimination already proven in
/// `inject_advanced_into_endpoint`:
///   - `Some(pem)` with exactly one `-----BEGIN CERTIFICATE-----` block ⇒
///     insert as-is (self-signed leaf, pin it). `toml_edit` renders a value
///     containing newlines as a multi-line (triple-quoted) string, so the PEM
///     lands as `certificate = """…"""` and re-parses byte-for-byte.
///   - `Some(pem)` with more than one block ⇒ strip `certificate` (a chain —
///     let the OS store verify; pinning an intermediate breaks chain-walking).
///   - `None` ⇒ strip `certificate`.
///
/// Only these three `[endpoint]` scalar fields are touched. `[listener.tun]`,
/// `killswitch_enabled`, routing, and every other field are left untouched
/// (T-16-06-01) — the C++ core owns the tunnel.
pub(crate) fn apply_install_cert_policy(
    client_toml: &str,
    policy: &InstallCertPolicy,
) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = client_toml
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse client.toml: {e}"))?;
    let endpoint = doc
        .get_mut("endpoint")
        .and_then(|v| v.as_table_mut())
        .ok_or("client.toml missing [endpoint] table")?;

    // skip_verification. This used to be an additive contract — write `true`, never write
    // or clear a `false` — which was safe only because `false` used to mean "Let's Encrypt",
    // a path whose config never carried the key in the first place.
    //
    // SEC-01 makes it load-bearing. A config that ALREADY says `skip_verification = true`
    // (every self-signed install this app has ever produced) must come out of here without
    // it once the probe has proven the endpoint verifiable — otherwise the stale `true`
    // survives, the core keeps skipping every check, and the fix delivers exactly nothing
    // while looking correct at every other layer.
    //
    // Removing rather than writing `false` is deliberate: the core reads this key as
    // `value_or(false)` (`trusttunnel/src/config.cpp`), so absence IS false, and a config
    // without the key cannot be misread by an older build either.
    if policy.skip_verification {
        endpoint.insert("skip_verification", toml_edit::value(true));
    } else {
        endpoint.remove("skip_verification");
    }

    // Certificate: identical leaf-vs-chain logic to inject_advanced_into_endpoint
    // — one BEGIN-block = self-signed leaf (pin), >1 = chain (strip).
    match policy.pinned_pem.as_deref() {
        Some(pem) if !pem.is_empty() => {
            let block_count = pem.matches("-----BEGIN CERTIFICATE-----").count();
            if block_count > 1 {
                endpoint.remove("certificate");
            } else {
                endpoint.insert("certificate", toml_edit::value(pem));
            }
        }
        _ => {
            endpoint.remove("certificate");
        }
    }

    // custom_sni: written only when non-empty.
    if !policy.custom_sni.is_empty() {
        endpoint.insert("custom_sni", toml_edit::value(policy.custom_sni.as_str()));
    }

    Ok(doc.to_string())
}

/// Parse the fetch-path cert-probe target `(sni, probe_host, probe_port)` from a
/// built client TOML's `[endpoint]` table (gap 5b-2). Pure — unit-testable
/// without SSH.
///
///   - `sni`        = the endpoint `hostname` (e.g. `trusttunnel.local`). This is
///     the TLS-SNI name the probe sends; it must be a name, never a bare IP
///     (`fetch_endpoint_cert` rejects an IP SNI). When the hostname is empty we
///     fall back to `params_host` (the operator-typed SSH host) so the probe still
///     has a name to send.
///   - `probe_host` = the host part of `addresses[0]` (the real dial IP,
///     e.g. `203.0.113.141`) — the TCP destination, which CAN be an IP. Falls
///     back to `params_host` when there is no address.
///   - `probe_port` = the port from `addresses[0]`, default 443.
pub(crate) fn parse_probe_target_from_endpoint(
    client_toml: &str,
    params_host: &str,
) -> (String, String, u16) {
    let doc = client_toml.parse::<toml_edit::DocumentMut>().ok();
    let endpoint = doc
        .as_ref()
        .and_then(|d| d.get("endpoint"))
        .and_then(|v| v.as_table());

    let hostname = endpoint
        .and_then(|e| e.get("hostname"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let first_addr = endpoint
        .and_then(|e| e.get("addresses"))
        .and_then(|v| v.as_array())
        .and_then(|a| a.get(0))
        .and_then(|v| v.as_str());

    // SNI = the endpoint hostname (a name, never an IP), fallback to params_host.
    let sni = hostname.unwrap_or(params_host).to_string();

    // probe_host = the IP from addresses[0] (the real dial target), fallback to
    // params_host. probe_port = the port from addresses[0], default 443. Reuse
    // the ping module's shared address parsers so this cannot drift.
    let probe_host = first_addr
        .and_then(crate::commands::ping::host_from_addr)
        .unwrap_or_else(|| params_host.to_string());
    let probe_port = first_addr
        .and_then(crate::commands::ping::port_from_addr)
        .unwrap_or(443);

    (sni, probe_host, probe_port)
}

/// The outcome of a fetch-path TLS cert probe, reduced to the two facts the
/// self-signed policy decision needs (gap 5b-2). Keeps the pure decision core
/// (`self_signed_policy_from_probe`) testable without the async probe / SSH.
///
///   - `None`                 ⇒ the probe FAILED (network / handshake error).
///     Degrade to `skip_verification = true` with no pin — the minimum working
///     state — never abort the fetch.
///   - `Some((true,  _))`     ⇒ the endpoint cert IS system-verifiable
///     (Let's-Encrypt / public CA). Do NOTHING extra — OS-store validation,
///     identical to today's LE behavior.
///   - `Some((false, pem))`   ⇒ the endpoint cert is NOT system-verifiable
///     (self-signed / private CA). Apply the self-signed policy:
///     `skip_verification = true` + pin the leaf PEM (`Some`) + custom_sni.
pub(crate) struct FetchProbeOutcome {
    pub is_system_verifiable: bool,
    pub pinned_pem: Option<String>,
    /// SEC-01: the probe proved the pinned leaf verifies this endpoint under its SNI.
    /// Only then may `skip_verification` be cleared — see `install_cert_policy_for`.
    pub pin_verifiable: bool,
}

/// Auto-apply the self-signed cert policy on the Users-tab / DoneStep FETCH path
/// (gap 5b-2), keyed on the ACTUAL cert trust (not manual per-user toggles).
///
/// This is the pure decision+merge core of `fetch_server_config`'s new auto step,
/// factored out so it is unit-testable without SSH or the async cert probe. It
/// runs AFTER the user-advanced overlay (`inject_advanced_into_endpoint`), so it
/// only fills the AUTO defaults a self-hosted install needs to connect
/// out-of-the-box; a user who explicitly set `custom_sni` keeps theirs.
///
/// Root cause it closes (16-UAT round 3): the config the owner gets after install
/// is produced by THIS fetch path (header "Fetched from server <ip>"), which
/// DoneStep re-invokes when adding the config. Before this, that path applied
/// skip_verification / cert-pin / custom_sni ONLY from the user's manually-saved
/// advanced options — the owner set none, so a self-hosted config shipped without
/// them and would not connect. Now the fetch path mirrors `deploy_export_config`:
/// probe the endpoint leaf and, when it is not system-verifiable, apply the
/// self-signed policy automatically.
///
/// # Arguments
/// - `client_toml`: the built + normalized + user-overlaid client TOML.
/// - `probe`: the reduced probe outcome (`None` ⇒ probe failed ⇒ degrade).
///
/// # SNI selection
/// The SNI is the endpoint's own `hostname` (e.g. `trusttunnel.local`), NEVER a
/// bare IP (the probe rejects an IP SNI). When the doc already carries a non-empty
/// `custom_sni` (user set it, via the overlay) we KEEP it; otherwise we use the
/// hostname. A doc with an empty hostname AND no custom_sni gets no custom_sni.
///
/// Let's-Encrypt (`is_system_verifiable == true`) is left untouched (OS store).
pub(crate) fn apply_fetched_self_signed_policy(
    client_toml: &str,
    probe: Option<FetchProbeOutcome>,
) -> Result<String, String> {
    // Read the endpoint hostname + any existing custom_sni from the built doc so
    // we can choose the SNI without a second parse in the async caller.
    let doc: toml_edit::DocumentMut = client_toml
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse client.toml: {e}"))?;
    let endpoint = doc
        .get("endpoint")
        .and_then(|v| v.as_table())
        .ok_or("client.toml missing [endpoint] table")?;
    let hostname = endpoint
        .get("hostname")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    let existing_sni = endpoint
        .get("custom_sni")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // LE / public-CA endpoint: OS-store validation, nothing to add (matches
    // today's LE behavior). A probe that came back system-verifiable is the
    // "do nothing" branch.
    if let Some(FetchProbeOutcome { is_system_verifiable: true, .. }) = probe {
        return Ok(client_toml.to_string());
    }

    // Self-signed (probe said not-system-verifiable) OR the probe failed
    // (degrade to skip_verification-only). In both cases we apply the self-signed
    // policy — the difference is only whether we have a leaf PEM to pin.
    let pin_verifiable = probe.as_ref().map(|p| p.pin_verifiable).unwrap_or(false);
    let pinned_pem = probe.and_then(|p| p.pinned_pem);

    // custom_sni: keep the user's explicit value if present; else use the
    // endpoint hostname (never a bare IP — the hostname IS the SNI name).
    let chosen_sni = existing_sni.unwrap_or(hostname);
    let policy = install_cert_policy_for("selfsigned", chosen_sni, pinned_pem, pin_verifiable);
    apply_install_cert_policy(client_toml, &policy)
}

#[cfg(test)]
mod sec01_writer_tests {
    use super::*;

    /// Truth: a config that already carries `skip_verification = true` loses it when the
    /// policy says the endpoint is verifiable. This is the step between "decided correctly"
    /// and "the core actually behaves differently", and it is where the fix would have
    /// silently evaporated — every policy test still passes with the stale key left in place.
    #[test]
    fn a_stale_skip_verification_is_cleared_when_the_pin_is_proven() {
        let before = "[endpoint]\nhostname = \"trusttunnel.local\"\nskip_verification = true\n";
        let policy = install_cert_policy_for(
            "selfsigned",
            "trusttunnel.local",
            Some("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n".to_string()),
            true,
        );
        let after = apply_install_cert_policy(before, &policy).expect("policy must apply");

        assert!(
            !after.contains("skip_verification"),
            "the stale skip_verification survived — the core would keep verifying nothing:\n{after}"
        );
        assert!(
            after.contains("certificate"),
            "the pin must be written; it is the trust anchor once verification is on:\n{after}"
        );
    }

    /// Truth: the unproven path is untouched. An endpoint we could not prove keeps the key,
    /// so nothing that works today stops working.
    #[test]
    fn an_unproven_endpoint_keeps_skipping_verification() {
        let before = "[endpoint]\nhostname = \"trusttunnel.local\"\n";
        let policy = install_cert_policy_for("selfsigned", "trusttunnel.local", None, false);
        let after = apply_install_cert_policy(before, &policy).expect("policy must apply");

        assert!(
            after.contains("skip_verification = true"),
            "an unprovable endpoint must keep today's behaviour verbatim:\n{after}"
        );
    }
}

/// Derive the install-time cert policy from the cert type (gap 5b).
///
/// This is the PURE decision core of `deploy_export_config`'s cert-type branch,
/// factored out so both branches (+ the empty-domain → "trusttunnel.local"
/// rule) are unit-testable without SSH or the async cert probe:
///   - `letsencrypt` ⇒ OS-store path: no skip_verification, no pin,
///     `custom_sni = sni_or_domain` (the domain the user entered). Keeps as
///     close to today's effective output as possible (FIX-OO caution).
///   - anything else (`selfsigned` / `provided`) ⇒ pin the probed leaf when present,
///     `custom_sni = sni_or_domain` (domain, or "trusttunnel.local" when there is no
///     real domain). Whether verification is left ON depends on `pin_verifiable`:
///
/// SEC-01. Writing `skip_verification = true` next to a pinned certificate was not a
/// belt-and-braces pairing, it was a hole: the core reads the pin ONLY when
/// `skip_verification` is false (`trusttunnel/src/config.cpp`), and the flag short-circuits
/// the whole verification callback before the host-name comparison
/// (`core/src/vpn_manager.cpp`). So the pin was dead and NOTHING was checked — no chain, no
/// name — while the UI showed an ordinary green «Подключено». Anyone able to sit between the
/// client and the endpoint could present any certificate at all and be accepted silently.
///
/// The fix cannot simply clear the flag: certificates this app issued before the SAN fix
/// carry only a CN, which no modern verifier consults, so verification would fail and every
/// such server would go off the air. `pin_verifiable` is therefore a PROOF obtained by
/// handshaking against the endpoint with the leaf as the sole trust anchor
/// (`cert_probe::fetch_endpoint_cert`). Verification is enabled only where it demonstrably
/// works; everywhere else the old behaviour is preserved exactly.
///
/// `pinned_pem` is the caller's already-probed leaf PEM (`None` on probe
/// failure ⇒ degrade to skip_verification-only, the minimum working state).
/// The Let's-Encrypt branch ignores `pinned_pem` (it never pins).
pub(crate) fn install_cert_policy_for(
    cert_type: &str,
    sni_or_domain: &str,
    pinned_pem: Option<String>,
    pin_verifiable: bool,
) -> InstallCertPolicy {
    if cert_type == "letsencrypt" {
        InstallCertPolicy {
            skip_verification: false,
            pinned_pem: None,
            custom_sni: sni_or_domain.to_string(),
        }
    } else if pin_verifiable && pinned_pem.is_some() {
        // SEC-01: the probe proved this endpoint verifies against its own leaf under this
        // SNI, so the pin becomes a real trust anchor instead of dead text.
        InstallCertPolicy {
            skip_verification: false,
            pinned_pem,
            custom_sni: sni_or_domain.to_string(),
        }
    } else {
        // Unproven: either the probe failed, or the certificate cannot be verified (issued
        // before the SAN fix, or supplied by the user). Keep today's behaviour verbatim —
        // an unverified tunnel is bad, a tunnel that cannot connect at all is worse, and
        // flipping this blind would take every such server off the air at once.
        InstallCertPolicy {
            skip_verification: true,
            pinned_pem,
            custom_sni: sni_or_domain.to_string(),
        }
    }
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
pub(crate) fn der_b64_to_pem(der_b64: &str) -> Result<String, String> {
    // Round-trip through decode_cert_der_b64 so we reject bad/oversized
    // payloads before shipping them into the client config.
    let bytes = super::decode_cert_der_b64(der_b64)?;
    trusttunnel_settings::trusttunnel_deeplink::cert::der_to_pem(&bytes)
        .map_err(|e| format!("der → pem: {e}"))
}

// ── REQ-15.2: Phase 15 typed mutation commands ─────────────────────────────
//
// Each mutation:
//   1. Validate input via char-whitelist (sanitize.rs) — S-02 layer 1
//   2. Read current vpn.toml via SSH (single channel)
//   3. Edit via toml_edit::DocumentMut (preserves comments + order) — S-02 layer 2
//   4. Write via UUID-randomized heredoc tee — S-04
//   5. systemctl --no-block restart trusttunnel (existing pattern)
//   6. Return Ok or detailed error code

async fn write_vpn_toml_via_heredoc(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    new_content: &str,
    field_label: &str,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;
    let delim = format!("VPN_TOML_EOF_{}", uuid::Uuid::new_v4().simple());
    let cmd = format!(
        "{sudo}tee {cfg} > /dev/null << '{delim}'\n{new_content}\n{delim}",
        cfg = ENDPOINT_CONFIG
    );
    let (_, code) = exec_command(handle, app, &cmd).await?;
    if code != 0 {
        return Err(format!("VPN_TOML_WRITE_FAILED|{field_label}|code={code}"));
    }
    let _ = exec_command(
        handle,
        app,
        &format!("{sudo}systemctl --no-block restart trusttunnel"),
    )
    .await;
    Ok(())
}

// The six per-field vpn.toml setters (update_listen_address / update_log_level /
// update_allow_private / update_auth_status / update_ping_path /
// update_speedtest_path) were REMOVED — the Configuration tab now persists vpn.toml
// exclusively via the generic save_config_file path, so they had zero frontend
// invoke() callers. Their shared helpers stay because they have other live callers:
// update_listen_address_in_toml (above) is still exercised by unit tests,
// write_vpn_toml_via_heredoc backs write_vpn_toml_raw, and the validators
// (validate_listen_address / validate_auth_status_code / validate_url_path) are still
// used by deploy.rs.

// ── REQ-15.3: Raw write fallback for Advanced editor ───────────────────────
//
// Frontend can supply a fully edited vpn.toml string (e.g. from "Show raw TOML"
// modal). Backend re-parses for validation (corrupt TOML rejected) then writes
// + restarts. Used ONLY for edge cases not covered by typed mutations above.
pub async fn write_vpn_toml_raw(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    content: String,
) -> Result<(), String> {
    if content.is_empty() {
        return Err("vpn.toml content cannot be empty".into());
    }
    if content.len() > 65536 {
        return Err("vpn.toml content too large (max 64 KiB)".into());
    }
    // Validate TOML syntax before writing — refuse to commit corrupt config
    let _: toml_edit::DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Invalid TOML: {e}"))?;
    write_vpn_toml_via_heredoc(app, handle, &content, "raw_write").await
}

// ── REQ-15.0 + REQ-15.7 + REQ-15.8: Generic per-file save (Phase 15.1) ─────
//
// Schema-driven editor (Phase 15.1) batches edits across vpn.toml / hosts.toml /
// rules.toml через единый IPC. file_name accepts "vpn" / "hosts" / "rules" only —
// credentials.toml rejected at this layer to enforce D-2.1 (read-only preview,
// edited via Users tab). After successful rules.toml write, emits Tauri event
// `rules-toml-changed` for cross-tab cache invalidation (Users tab subscribes
// per REQ-15.8 D-2.3).
//
// Defence stack (S-02 + S-04):
//   - file_name whitelist {"vpn", "hosts", "rules"} blocks path traversal /
//     credentials write (D-2.1 + T-15.1-04 + T-15.1-08).
//   - Per-file content validator (sanitize.rs) — size cap + toml_edit parse +
//     defence-in-depth checks (e.g. cidr fields в rules.toml).
//   - UUID-randomized heredoc delimiter `{prefix}_EOF_{uuid}` — user content
//     cannot collide с delimiter (T-15.1-01).
//
// V13 invariant: backend re-validates даже если frontend pre-validated. Tauri IPC
// is the trust boundary; frontend is untrusted at this layer.
//
// NOTE: This function does NOT trigger systemctl restart automatically. The
// Configuration tab orchestrates batch save + single restart via the existing
// `server_restart_service` command (D-4.1 unified batch flow).

// Discriminator tuple for save_config_file: (filename on disk, heredoc prefix,
// validator fn). Extracted to a named alias to satisfy `clippy::type_complexity`
// (Phase 19 post-ship regression — single-site signature, fields stable per D-2.1).
type ConfigFileSpec = (&'static str, &'static str, fn(&str) -> Result<(), String>);

pub async fn save_config_file(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    file_name: String,
    raw_content: String,
) -> Result<(), String> {
    // Step 1: validate file_name whitelist (V13 trust boundary).
    // Tuple maps file_name → (filename on disk, heredoc prefix, validator).
    let (filename, prefix, validator): ConfigFileSpec =
        match file_name.as_str() {
            "vpn" => (
                "vpn.toml",
                "VPN_TOML",
                crate::ssh::sanitize::validate_vpn_toml_content,
            ),
            "hosts" => (
                "hosts.toml",
                "HOSTS_TOML",
                crate::ssh::sanitize::validate_hosts_toml_content,
            ),
            "rules" => (
                "rules.toml",
                "RULES_TOML",
                crate::ssh::sanitize::validate_rules_toml_content,
            ),
            "credentials" => {
                return Err("credentials.toml is read-only — edit via Users tab (D-2.1)".into());
            }
            other => {
                return Err(format!(
                    "Invalid file_name '{other}' (allowed: vpn, hosts, rules)"
                ));
            }
        };

    // Step 2: per-file content validator (S-02 Layer 1 size cap + Layer 2 toml_edit parse).
    validator(&raw_content)?;

    // Step 3: heredoc write via UUID delim (S-04 invariant) — same pattern as
    // write_vpn_toml_via_heredoc helper above, generalized for arbitrary file.
    let sudo = detect_sudo(handle, app).await;
    let delim = format!("{prefix}_EOF_{}", uuid::Uuid::new_v4().simple());
    let cmd = format!(
        "{sudo}tee {dir}/{filename} > /dev/null << '{delim}'\n{raw_content}\n{delim}",
        dir = ENDPOINT_DIR
    );
    let (_, code) = exec_command(handle, app, &cmd).await?;
    if code != 0 {
        return Err(format!("CONFIG_FILE_WRITE_FAILED|{filename}|code={code}"));
    }

    // Step 4: emit cross-tab event for rules.toml only (REQ-15.8 D-2.3).
    // Users tab listens to `rules-toml-changed` and refetches cached entries
    // when this event fires after a Configuration-tab save.
    if file_name == "rules" {
        use tauri::Emitter;
        let _ = app.emit(
            "rules-toml-changed",
            serde_json::json!({ "file": "rules.toml" }),
        );
    }

    // Step 5: NO automatic restart here — frontend orchestrates batch + restart
    // via server_restart_service after all pending file writes succeed (D-4.1).
    Ok(())
}

// ── REQ-15.0 + REQ-15.1: Single-channel bundle reader (Pitfall 4 mitigation) ─────
//
// Mount of the Configuration tab would naively fire 3-5 parallel SSH commands
// (vpn.toml read, hosts.toml read, service status). With CHANNEL_OPEN_GATE=5
// and other tabs already in flight (Overview, Users), this risks
// `SSH_CHANNEL_FAILED|ConnectFailed`. Bundle reads everything in ONE channel
// via && shell pipeline.
//
// Phase 15.1 extension: bundle now covers 4 TOML files (vpn / hosts / credentials
// / rules) + service status — all through ONE SSH channel. Configuration tab
// fires только ОДИН SSH command вместо 4 — устраняет channel stampede (Pitfall 4).
pub async fn get_config_bundle(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<ConfigBundle, String> {
    let sudo = detect_sudo(handle, app).await;
    let dir = ENDPOINT_DIR;
    let cmd = format!(
        "echo '---VPN_TOML---' && {sudo}cat {dir}/vpn.toml && \
         echo '---HOSTS_TOML---' && {sudo}cat {dir}/hosts.toml 2>/dev/null && \
         echo '---CREDENTIALS_TOML---' && {sudo}cat {dir}/credentials.toml 2>/dev/null && \
         echo '---RULES_TOML---' && {sudo}cat {dir}/rules.toml 2>/dev/null && \
         echo '---SERVICE---' && systemctl is-active trusttunnel"
    );
    let (output, _) = exec_command(handle, app, &cmd).await?;
    let (vpn_toml, hosts_toml, credentials_toml, rules_toml, service_status) =
        parse_config_bundle_output(&output);
    let typed = parse_vpn_config_known(&vpn_toml);
    let allowed_sni = parse_allowed_sni_from_hosts_toml(&hosts_toml);
    Ok(ConfigBundle {
        vpn_toml,
        hosts_toml,
        credentials_toml,
        rules_toml,
        typed,
        allowed_sni,
        service_status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::UserAdvanced;

    fn sample_toml() -> String {
        // Minimal client toml with [endpoint] block produced by build_client_config.
        "# header\n\nloglevel = \"info\"\n\n[endpoint]\nhost = \"1.2.3.4\"\nport = 443\nusername = \"alice\"\npassword = \"secret\"\nanti_dpi = true\n\n[listener.tun]\nmtu_size = 1280\n".to_string()
    }

    // ── S-5: server-returned hostname validation ───────────────────────────
    #[test]
    fn validated_server_host_accepts_clean_host() {
        assert_eq!(validated_server_host("vpn.example.com"), Some("vpn.example.com"));
        assert_eq!(validated_server_host("203.0.113.7"), Some("203.0.113.7"));
        assert_eq!(validated_server_host("  vpn.example.com  "), Some("vpn.example.com"));
        assert_eq!(validated_server_host("[2001:db8::1]"), Some("[2001:db8::1]"));
    }

    #[test]
    fn validated_server_host_rejects_injection_and_placeholders() {
        // A compromised server cannot smuggle shell metachars into the `-a` arg.
        assert_eq!(validated_server_host("host; rm -rf /"), None);
        assert_eq!(validated_server_host("$(whoami)"), None);
        assert_eq!(validated_server_host("a`id`b"), None);
        assert_eq!(validated_server_host("host with space"), None);
        // Empty and the local placeholder fall through to the caller's fallback.
        assert_eq!(validated_server_host(""), None);
        assert_eq!(validated_server_host("   "), None);
        assert_eq!(validated_server_host("trusttunnel.local"), None);
    }

    // ── WR-01: server-read anti-DPI prefix validation ──────────────────────
    #[test]
    fn validated_hex_prefix_accepts_hex() {
        assert_eq!(validated_hex_prefix("aabbcc"), Some("aabbcc"));
        assert_eq!(validated_hex_prefix("0011ff"), Some("0011ff"));
        assert_eq!(validated_hex_prefix("ABCDEF0123"), Some("ABCDEF0123"));
        // 64-char boundary (max length) is accepted.
        let max = "a".repeat(64);
        assert_eq!(validated_hex_prefix(&max), Some(max.as_str()));
    }

    #[test]
    fn validated_hex_prefix_rejects_injection_and_malformed() {
        // The injection payload from the finding: a non-hex prefix must NOT
        // produce a `-r` flag (returns None → caller omits the flag).
        assert_eq!(validated_hex_prefix("aa; reboot"), None);
        assert_eq!(validated_hex_prefix("$(whoami)"), None);
        assert_eq!(validated_hex_prefix("aa bb"), None);
        // 'g' is not a hex digit.
        assert_eq!(validated_hex_prefix("aagg"), None);
        // Empty and over-length are rejected.
        assert_eq!(validated_hex_prefix(""), None);
        assert_eq!(validated_hex_prefix(&"a".repeat(65)), None);
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

    // ── gap 5b: apply_install_cert_policy shared helper ───────────────────
    //
    // These cover the install-time cert policy in isolation from the async
    // probe. A single-block leaf PEM is produced via the same der_b64_to_pem
    // the fetch path uses ("MAMBAgM=" ⇒ one BEGIN block); a two-block chain
    // via the FIX-OO-8 fixture ("MAMBAgMwBAQFBgc=" ⇒ two blocks).

    fn leaf_pem() -> String {
        // Single-block self-signed leaf PEM (same fixture as der_b64_to_pem_single_cert).
        der_b64_to_pem("MAMBAgM=").unwrap()
    }

    fn chain_pem() -> String {
        // Two-block chain PEM (leaf + intermediate) — must be STRIPPED, not pinned.
        der_b64_to_pem("MAMBAgMwBAQFBgc=").unwrap()
    }

    #[test]
    fn policy_writes_skip_verification_only_when_true() {
        let on = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy { skip_verification: true, pinned_pem: None, custom_sni: String::new() },
        )
        .unwrap();
        assert!(on.contains("skip_verification = true"));

        let off = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy { skip_verification: false, pinned_pem: None, custom_sni: String::new() },
        )
        .unwrap();
        // FIX-OO additive contract: skip_verification=false ⇒ key ABSENT, never explicit false.
        assert!(!off.contains("skip_verification"), "false must not emit the key; got: {off}");
    }

    #[test]
    fn policy_pins_single_block_leaf() {
        let out = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy {
                skip_verification: true,
                pinned_pem: Some(leaf_pem()),
                custom_sni: String::new(),
            },
        )
        .unwrap();
        // Exactly one BEGIN block, present as a triple-quoted multi-line TOML string.
        assert_eq!(out.matches("-----BEGIN CERTIFICATE-----").count(), 1);
        assert!(out.contains("certificate = \"\"\""), "leaf must be a triple-quoted string; got: {out}");
        // Re-parse: valid TOML and the PEM round-trips byte-for-byte.
        let doc: toml_edit::DocumentMut = out.parse().expect("output must re-parse as valid TOML");
        let cert = doc["endpoint"]["certificate"].as_str().expect("certificate is a string");
        assert_eq!(cert, leaf_pem(), "PEM must survive the TOML round-trip byte-for-byte");
    }

    #[test]
    fn policy_strips_multi_block_chain() {
        let out = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy {
                skip_verification: false,
                pinned_pem: Some(chain_pem()),
                custom_sni: String::new(),
            },
        )
        .unwrap();
        // Chain ⇒ stripped (let the OS store verify), matching inject case 2.
        assert!(!out.contains("certificate"), "chain must be stripped; got: {out}");
    }

    #[test]
    fn policy_strips_certificate_when_pem_none() {
        // sample_toml has no certificate, but a config that DID carry one must
        // get it removed when policy.pinned_pem is None.
        let with_cert = "[endpoint]\nhostname = \"h\"\ncertificate = \"\"\"-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----\\n\"\"\"\nanti_dpi = true\n";
        let out = apply_install_cert_policy(
            with_cert,
            &InstallCertPolicy { skip_verification: false, pinned_pem: None, custom_sni: String::new() },
        )
        .unwrap();
        assert!(!out.contains("certificate"), "None must strip certificate; got: {out}");
    }

    #[test]
    fn policy_writes_custom_sni_only_when_non_empty() {
        let with_sni = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy {
                skip_verification: false,
                pinned_pem: None,
                custom_sni: "trusttunnel.local".to_string(),
            },
        )
        .unwrap();
        assert!(with_sni.contains("custom_sni = \"trusttunnel.local\""));

        let no_sni = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy { skip_verification: false, pinned_pem: None, custom_sni: String::new() },
        )
        .unwrap();
        assert!(!no_sni.contains("custom_sni"), "empty custom_sni must not write the key; got: {no_sni}");
    }

    #[test]
    fn policy_leaves_listener_tun_untouched() {
        let out = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy {
                skip_verification: true,
                pinned_pem: Some(leaf_pem()),
                custom_sni: "trusttunnel.local".to_string(),
            },
        )
        .unwrap();
        // The C++ core owns the tunnel — [listener.tun] scalars are never touched.
        assert!(out.contains("[listener.tun]"));
        assert!(out.contains("mtu_size = 1280"));
    }

    #[test]
    fn policy_errors_when_endpoint_missing() {
        let broken = "[other]\nfoo = 1\n";
        assert!(apply_install_cert_policy(
            broken,
            &InstallCertPolicy { skip_verification: true, pinned_pem: None, custom_sni: String::new() },
        )
        .is_err());
    }

    #[test]
    fn policy_matches_owner_confirmed_self_hosted_shape() {
        // STRUCTURAL fixture for the confirmed-working self-hosted config
        // (build q4m8xt): the generated config PLUS exactly three [endpoint] fields —
        //   custom_sni = "trusttunnel.local"  (= hostname, no real domain)
        //   skip_verification = true
        //   certificate = """<single-block self-signed leaf PEM>"""
        //
        // We assert the SHAPE, not a byte-exact owner PEM (transcription/staleness
        // risk). A real q4m8xt leaf began
        //   MIIBjjCCATOgAwIBAgIU...
        // — kept here as an ILLUSTRATIVE reference only, never the asserted value.
        let out = apply_install_cert_policy(
            &sample_toml(),
            &InstallCertPolicy {
                skip_verification: true,
                pinned_pem: Some(leaf_pem()),
                custom_sni: "trusttunnel.local".to_string(),
            },
        )
        .unwrap();

        // (a) skip_verification == true
        assert!(out.contains("skip_verification = true"));
        // (b) custom_sni == "trusttunnel.local"
        assert!(out.contains("custom_sni = \"trusttunnel.local\""));
        // (c) certificate present as a SINGLE triple-quoted PEM block, re-parsing
        //     as valid TOML with the PEM preserved.
        assert!(out.contains("certificate = \"\"\""));
        assert_eq!(out.matches("-----BEGIN CERTIFICATE-----").count(), 1);
        let doc: toml_edit::DocumentMut = out.parse().expect("owner-shape output must re-parse");
        assert_eq!(doc["endpoint"]["certificate"].as_str().unwrap(), leaf_pem());
        assert_eq!(doc["endpoint"]["skip_verification"].as_bool(), Some(true));
        assert_eq!(doc["endpoint"]["custom_sni"].as_str(), Some("trusttunnel.local"));
        // (d) [listener.tun] + its scalars unchanged.
        assert!(out.contains("[listener.tun]"));
        assert!(out.contains("mtu_size = 1280"));
    }

    // ── M-01: allowed_sni parser tests ──────────────────────────────────

    #[test]
    fn allowed_sni_parses_single_host_with_whitelist() {
        let content = r#"
[[main_hosts]]
hostname = "main.example.com"
cert_chain_path = "certs/cert.pem"
private_key_path = "certs/key.pem"
allowed_sni = ["cdn.example.com", "www.google.com"]
"#;
        let parsed = parse_allowed_sni_from_hosts_toml(content);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hostname, "main.example.com");
        assert_eq!(parsed[0].allowed_sni, vec!["cdn.example.com", "www.google.com"]);
    }

    #[test]
    fn allowed_sni_defaults_to_empty_when_omitted() {
        // Pristine deploy.rs output has hostname + cert paths, no allowed_sni.
        let content = r#"
[[main_hosts]]
hostname = "main.example.com"
cert_chain_path = "certs/cert.pem"
private_key_path = "certs/key.pem"
"#;
        let parsed = parse_allowed_sni_from_hosts_toml(content);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hostname, "main.example.com");
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

    // ── REQ-15.1 / REQ-15.2: VpnConfigKnown + ConfigBundle + helpers ──

    #[test]
    fn vpn_config_known_default_listen_is_0_0_0_0_443() {
        let cfg = VpnConfigKnown::default();
        assert_eq!(cfg.listen_address, "0.0.0.0:443");
        assert_eq!(cfg.auth_failure_status_code, 407);
        assert!(cfg.ipv6_available);
    }

    #[test]
    fn vpn_config_known_parses_minimal_config() {
        let raw = r#"
listen_address = "0.0.0.0:8443"
ipv6_available = false
"#;
        let cfg = parse_vpn_config_known(raw);
        assert_eq!(cfg.listen_address, "0.0.0.0:8443");
        assert!(!cfg.ipv6_available);
        // Defaults remain for unspecified fields
        assert_eq!(cfg.auth_failure_status_code, 407);
    }

    #[test]
    fn vpn_config_known_preserves_extras() {
        let raw = r#"
listen_address = "0.0.0.0:443"

[forward_protocol]
foo = "bar"
"#;
        let cfg = parse_vpn_config_known(raw);
        assert!(cfg.extra.contains_key("forward_protocol"));
    }

    #[test]
    fn parse_config_bundle_extracts_three_sections() {
        // Plan 15-01 carry-forward — verify 3-section subset still works after
        // Phase 15.1 5-marker extension (forward-compatibility for legacy fixtures).
        let raw = "---VPN_TOML---\nlisten_address = \"0.0.0.0:443\"\n---HOSTS_TOML---\n[[main_hosts]]\nhostname = \"a.example.com\"\n---SERVICE---\nactive";
        let (vpn, hosts, _creds, _rules, service) = parse_config_bundle_output(raw);
        assert!(vpn.contains("listen_address"));
        assert!(hosts.contains("main_hosts"));
        assert_eq!(service, "active");
    }

    #[test]
    fn parse_config_bundle_output_handles_5_markers() {
        // REQ-15.1 extended (Phase 15.1): bundle reader covers vpn / hosts /
        // credentials / rules + service status — all через единую &&-цепочку.
        let input = "\
---VPN_TOML---
listen_address = \"0.0.0.0:443\"
---HOSTS_TOML---
[[main_hosts]]
hostname = \"a.com\"
---CREDENTIALS_TOML---
[[client]]
username = \"u\"
password = \"p\"
---RULES_TOML---
[[rule]]
cidr = \"10.0.0.0/8\"
action = \"allow\"
---SERVICE---
active
";
        let (vpn, hosts, creds, rules, svc) = parse_config_bundle_output(input);
        assert!(vpn.contains("listen_address"));
        assert!(hosts.contains("main_hosts"));
        assert!(creds.contains("username"));
        assert!(rules.contains("cidr"));
        assert!(svc.contains("active"));
    }

    #[test]
    fn parse_config_bundle_output_missing_markers_returns_empty() {
        // Forward-compatibility: missing markers (e.g. server без credentials.toml
        // or rules.toml) → empty string, NOT error. Lets bundle reader survive
        // partial-config servers.
        let input = "---VPN_TOML---\nlisten_address = \"0.0.0.0:443\"\n---SERVICE---\nactive\n";
        let (vpn, hosts, creds, rules, svc) = parse_config_bundle_output(input);
        assert!(vpn.contains("listen_address"));
        assert!(hosts.is_empty());
        assert!(creds.is_empty());
        assert!(rules.is_empty());
        assert!(svc.contains("active"));
    }

    #[test]
    fn toml_edit_roundtrip_preserves_listen_address_change() {
        let raw = "# my server\nlisten_address = \"0.0.0.0:443\"\nipv6_available = true\n";
        let updated = update_listen_address_in_toml(raw, "0.0.0.0:8443").unwrap();
        assert!(updated.contains("listen_address = \"0.0.0.0:8443\""));
        assert!(updated.contains("# my server"), "comment must be preserved");
        assert!(updated.contains("ipv6_available"), "other fields must remain");
    }

    #[test]
    fn validators_called_before_shell_interpolation_listen_address() {
        let raw = "listen_address = \"0.0.0.0:443\"\n";
        let result = update_listen_address_in_toml(raw, "0.0.0.0:443; rm -rf /");
        assert!(result.is_err(), "shell metachars must reject before parser runs");
    }

    // ── gap 5b-2: fetch-path auto self-signed policy (the round-3 blocker) ────
    //
    // These prove the FETCH path (fetch_server_config / DoneStep re-export /
    // Users-tab save) now ships a self-hosted config ready-to-connect —
    // skip_verification=true + pinned leaf + custom_sni — WITHOUT any manual
    // per-user advanced toggles, keyed on the ACTUAL cert trust. LE (system-
    // verifiable) stays untouched. The pure decision core is tested here without
    // SSH or the async probe.

    /// A built client TOML shaped like build_client_config output for a bare-IP,
    /// fake-SNI self-hosted server: hostname = the .local SNI, addresses[0] = the
    /// real dial IP:port. This is exactly the self-hosted shape.
    fn fetched_toml(hostname: &str, address: &str) -> String {
        format!(
            "# TrustTunnel Client Configuration\n\
             # Fetched from server 203.0.113.141\n\n\
             loglevel = \"info\"\n\n\
             [endpoint]\n\
             hostname = \"{hostname}\"\n\
             addresses = [\"{address}\"]\n\
             username = \"alice\"\n\
             password = \"secret\"\n\
             anti_dpi = true\n\n\
             [listener.tun]\n\
             mtu_size = 1280\n"
        )
    }

    #[test]
    fn fetch_self_signed_probe_pins_and_sets_sni() {
        // A self-signed endpoint (is_system_verifiable=false) with a probed leaf:
        // the resulting TOML has skip_verification=true + a single BEGIN block +
        // custom_sni = the hostname (trusttunnel.local). This is the
        // known-good target shape produced automatically on the fetch path.
        let probe = Some(FetchProbeOutcome {
            is_system_verifiable: false,
            pinned_pem: Some(der_b64_to_pem("MAMBAgM=").unwrap()),
            pin_verifiable: false,
        });
        let out = apply_fetched_self_signed_policy(
            &fetched_toml("trusttunnel.local", "203.0.113.141:443"),
            probe,
        )
        .unwrap();

        assert!(out.contains("skip_verification = true"));
        assert_eq!(out.matches("-----BEGIN CERTIFICATE-----").count(), 1);
        assert!(out.contains("certificate = \"\"\""), "leaf pinned as triple-quoted; got: {out}");
        assert!(out.contains("custom_sni = \"trusttunnel.local\""));
        // Re-parses as valid TOML with all three fields set.
        let doc: toml_edit::DocumentMut = out.parse().expect("must re-parse");
        assert_eq!(doc["endpoint"]["skip_verification"].as_bool(), Some(true));
        assert_eq!(doc["endpoint"]["custom_sni"].as_str(), Some("trusttunnel.local"));
        assert!(doc["endpoint"]["certificate"].as_str().unwrap().contains("BEGIN CERTIFICATE"));
        // C++-core-owned tunnel table untouched.
        assert!(out.contains("[listener.tun]"));
    }

    #[test]
    fn fetch_letsencrypt_leaves_config_untouched() {
        // A system-verifiable (Let's Encrypt / public-CA) endpoint gets NOTHING
        // extra — no skip_verification, no pin, no custom_sni change. OS-store
        // validation, matching today's LE behavior.
        let before = fetched_toml("vpn.example.com", "203.0.113.7:443");
        let probe = Some(FetchProbeOutcome {
            is_system_verifiable: true,
            pinned_pem: None,
            pin_verifiable: false,
        });
        let out = apply_fetched_self_signed_policy(&before, probe).unwrap();
        assert_eq!(out, before, "LE config must be returned byte-for-byte unchanged");
        assert!(!out.contains("skip_verification"));
        assert!(!out.contains("custom_sni"));
        assert!(!out.contains("certificate"));
    }

    #[test]
    fn fetch_probe_failure_degrades_to_skip_verification_only() {
        // Probe failed (None) ⇒ degrade to the minimum working state:
        // skip_verification=true, custom_sni set, but NO pinned cert.
        let out = apply_fetched_self_signed_policy(
            &fetched_toml("trusttunnel.local", "203.0.113.141:443"),
            None,
        )
        .unwrap();
        assert!(out.contains("skip_verification = true"));
        assert!(out.contains("custom_sni = \"trusttunnel.local\""));
        assert!(!out.contains("certificate"), "no pin on probe failure; got: {out}");
    }

    #[test]
    fn fetch_self_signed_keeps_user_custom_sni() {
        // A user who explicitly set custom_sni (via the users-advanced overlay
        // that ran BEFORE this step) keeps theirs — the auto step only fills the
        // default when none is present.
        let mut toml = fetched_toml("trusttunnel.local", "203.0.113.141:443");
        toml = toml.replace(
            "anti_dpi = true\n",
            "anti_dpi = true\ncustom_sni = \"my.custom.sni\"\n",
        );
        let probe = Some(FetchProbeOutcome {
            is_system_verifiable: false,
            pinned_pem: Some(der_b64_to_pem("MAMBAgM=").unwrap()),
            pin_verifiable: false,
        });
        let out = apply_fetched_self_signed_policy(&toml, probe).unwrap();
        assert!(out.contains("custom_sni = \"my.custom.sni\""));
        // The user SNI wins — custom_sni must NOT be overwritten with the hostname.
        assert!(
            !out.contains("custom_sni = \"trusttunnel.local\""),
            "must not overwrite the user SNI; got: {out}"
        );
    }

    #[test]
    fn parse_probe_target_uses_hostname_sni_and_address_ip() {
        // The probe SNI is the endpoint hostname (a name, never an IP); the probe
        // host is the real dial IP from addresses[0]; the port is the address port.
        let (sni, host, port) = parse_probe_target_from_endpoint(
            &fetched_toml("trusttunnel.local", "203.0.113.141:8443"),
            "params.fallback.host",
        );
        assert_eq!(sni, "trusttunnel.local", "SNI = the endpoint hostname, never an IP");
        assert_eq!(host, "203.0.113.141", "probe host = the real dial IP from addresses[0]");
        assert_eq!(port, 8443, "probe port = the addresses[0] port");
    }

    #[test]
    fn parse_probe_target_defaults_and_fallbacks() {
        // No addresses at all → probe host falls back to params_host, port 443.
        let (sni, host, port) = parse_probe_target_from_endpoint(
            "[endpoint]\nhostname = \"trusttunnel.local\"\nusername = \"u\"\n",
            "203.0.113.99",
        );
        assert_eq!(sni, "trusttunnel.local");
        assert_eq!(host, "203.0.113.99", "no address → fall back to params_host");
        assert_eq!(port, 443, "no address port → default 443");

        // Empty hostname → SNI falls back to params_host (still a name to send).
        let (sni2, _h2, _p2) = parse_probe_target_from_endpoint(
            "[endpoint]\nhostname = \"\"\naddresses = [\"1.2.3.4:443\"]\n",
            "fallback.example.com",
        );
        assert_eq!(sni2, "fallback.example.com");
    }

    // ── Phase 25 (WR-01): the echo carried by SSH_CLIENT_NAME_INVALID|{name} ────────────
    //
    // The detail slot exists so the snackbar can name the refused value, but the value is
    // by definition one that failed the whitelist. These pin the two properties the
    // `CODE|detail` wire format depends on: the separator can never appear in the echo,
    // and the echo can never be unbounded.

    #[test]
    fn echo_safe_client_name_keeps_the_validator_whitelist_verbatim() {
        // A name that only LOOKS invalid to the caller (e.g. it was too long, or the
        // rejection came from a different rule) must round-trip unchanged — the echo is a
        // diagnostic, not a second validator.
        assert_eq!(echo_safe_client_name("client-01"), "client-01");
        assert_eq!(echo_safe_client_name("my_device.2"), "my_device.2");
    }

    #[test]
    fn echo_safe_client_name_neutralizes_the_code_separator() {
        // The `|` is the ONLY character whose survival would corrupt the payload shape:
        // translateSshError splits on it, so an echoed `|` would fabricate a third field.
        // `_` is inside the validator's whitelist, so only the separator itself changes —
        // the echo is not a sanitizer with its own opinion, it is the SAME whitelist.
        assert_eq!(echo_safe_client_name("evil|SSH_AUTH_FAILED"), "evil?SSH_AUTH_FAILED");
        // Newlines / spaces / shell metacharacters get the same treatment — one whitelist,
        // no per-character special cases to keep in sync.
        assert_eq!(echo_safe_client_name("a b\nc;d"), "a?b?c?d");
        assert!(!echo_safe_client_name("пользователь|x").contains('|'));
    }

    #[test]
    fn echo_safe_client_name_is_bounded_at_the_validators_own_limit() {
        // 64 == validate_client_name's upper bound, so nothing VALID is ever truncated…
        let exactly_64 = "a".repeat(64);
        assert_eq!(echo_safe_client_name(&exactly_64), exactly_64);
        assert!(!echo_safe_client_name(&exactly_64).ends_with('…'));

        // …but a megabyte of text cannot become a megabyte of snackbar.
        let huge = "a".repeat(10_000);
        let echoed = echo_safe_client_name(&huge);
        assert_eq!(echoed.chars().count(), 65, "64 kept chars + the truncation marker");
        assert!(echoed.ends_with('…'), "the cut is visible to the reader");
    }
}
