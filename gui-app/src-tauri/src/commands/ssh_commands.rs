use crate::ssh;

// ─── Macro to eliminate SshParams boilerplate (direct connect) ─────

/// Generates a `#[tauri::command]` that constructs `SshParams` from the
/// standard (host, port, user, password, key_path) arguments and delegates
/// to an `ssh::` function.  Used for long-running / one-shot commands
/// (deploy, install, upgrade, uninstall) that should NOT reuse pooled connections.
macro_rules! ssh_command {
    ($name:ident, $method:path $(, $extra_param:ident : $extra_type:ty)*) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            host: String,
            port: u16,
            user: String,
            password: String,
            key_path: Option<String>,
            key_data: Option<String>,
            $($extra_param: $extra_type,)*
        ) -> Result<impl serde::Serialize, String> {
            let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data };
            $method(&app, params $(, $extra_param)*).await
        }
    };
}

// ─── Macro for pooled SSH commands ────────────────────────────────

/// Like `ssh_command!` but uses the SshPool to reuse persistent connections.
/// Acquires a connection from the pool (creating one if needed) and passes
/// `&Handle` to the server function. Does NOT disconnect after — pool manages lifecycle.
macro_rules! ssh_pool_command {
    ($name:ident, $method:path $(, $extra_param:ident : $extra_type:ty)*) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            pool: tauri::State<'_, crate::ssh::SshPool>,
            host: String,
            port: u16,
            user: String,
            password: String,
            key_path: Option<String>,
            key_data: Option<String>,
            $($extra_param: $extra_type,)*
        ) -> Result<serde_json::Value, String> {
            let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data };
            let handle = pool.acquire(&params, Some(app.clone())).await?;
            let result = $method(&app, &*handle $(, $extra_param)*).await?;
            serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
        }
    };
}

// ─── Direct-connect commands (long-running / one-shot) ────────────

ssh_command!(deploy_server, ssh::deploy_server, settings: ssh::EndpointSettings);
ssh_command!(diagnose_server, ssh::diagnose_server);
ssh_command!(check_server_installation, ssh::check_server_installation);
ssh_command!(uninstall_server, ssh::uninstall_server);
ssh_command!(fetch_server_config, ssh::fetch_server_config, client_name: String);
ssh_command!(server_upgrade, ssh::server_upgrade, version: String);

// ─── Pooled server management commands ────────────────────────────

ssh_pool_command!(server_get_stats, ssh::server_get_stats);
ssh_pool_command!(server_get_uptime, ssh::server_get_uptime);
ssh_pool_command!(server_get_config, ssh::get_server_config);
ssh_pool_command!(server_get_cert_info, ssh::get_cert_info);
ssh_pool_command!(server_get_logs, ssh::server_get_logs);
ssh_pool_command!(server_renew_cert, ssh::renew_cert);
ssh_pool_command!(server_update_config_feature, ssh::update_config_feature, feature: String, enabled: bool);
ssh_pool_command!(server_export_config_deeplink, ssh::export_config_deeplink, client_name: String);
ssh_pool_command!(server_restart_service, ssh::server_restart_service);
ssh_pool_command!(server_stop_service, ssh::server_stop_service);
ssh_pool_command!(server_start_service, ssh::server_start_service);
ssh_pool_command!(server_reboot, ssh::server_reboot);
ssh_pool_command!(server_remove_user, ssh::server_remove_user, vpn_username: String);
ssh_pool_command!(add_server_user, ssh::add_server_user, vpn_username: String, vpn_password: String);

// ─── Pooled security commands ─────────────────────────────────────

// security_get_status and security_install_firewall are manual because they
// need `port` (the SSH port) passed as an extra parameter to the server function,
// but `port` is already part of the standard SSH params (no extra frontend field needed).

#[tauri::command]
pub async fn security_get_status(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let result = ssh::get_security_status(&app, &*handle, port).await?;
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
}

#[tauri::command]
pub async fn security_install_firewall(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
    keep_http_open: bool,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::install_firewall(&app, &*handle, port, keep_http_open).await?;
    Ok(serde_json::Value::Null)
}

ssh_pool_command!(security_install_fail2ban, ssh::install_fail2ban);
ssh_pool_command!(security_uninstall_fail2ban, ssh::uninstall_fail2ban);
ssh_pool_command!(security_start_fail2ban, ssh::start_fail2ban);
ssh_pool_command!(security_stop_fail2ban, ssh::stop_fail2ban);
ssh_pool_command!(security_start_firewall, ssh::start_firewall);
ssh_pool_command!(security_stop_firewall, ssh::stop_firewall);
ssh_pool_command!(security_fail2ban_unban, ssh::fail2ban_unban, jail: String, ip: String);
ssh_pool_command!(security_fail2ban_ban, ssh::fail2ban_ban, jail: String, ip: String);
ssh_pool_command!(security_fail2ban_set_jail, ssh::fail2ban_set_jail_config, jail: String, config: ssh::JailConfigUpdate);
ssh_pool_command!(security_fail2ban_tail_log, ssh::fail2ban_tail_log, lines: u32);
ssh_pool_command!(security_uninstall_firewall, ssh::uninstall_firewall);
ssh_pool_command!(security_firewall_add_rule, ssh::firewall_add_rule, rule: ssh::NewFirewallRule);
ssh_pool_command!(security_firewall_delete_rule, ssh::firewall_delete_rule, number: u32);
ssh_pool_command!(security_firewall_set_logging, ssh::firewall_set_logging, level: String);
ssh_pool_command!(security_firewall_tail_log, ssh::firewall_tail_log, lines: u32);
ssh_pool_command!(security_firewall_set_http_port, ssh::firewall_set_http_port, open: bool);

// ─── Manual pooled security commands (port reuse) ────────────────

#[tauri::command]
pub async fn security_change_ssh_port(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
    new_port: u16,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host, port, ssh_user: user, ssh_password: password, key_path, key_data };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let actual_port = ssh::change_ssh_port(&app, &*handle, new_port, port).await?;
    // Drop stale handle and invalidate pool — the SSH daemon restarted on a new port
    drop(handle);
    pool.invalidate().await;
    Ok(serde_json::json!({ "newPort": actual_port }))
}

// ─── MTProto proxy commands ──────────────────────────────────────

ssh_command!(mtproto_install, ssh::mtproto_install, mtproto_port: u16);
ssh_command!(mtproto_uninstall, ssh::mtproto_uninstall);

// mtproto_get_status needs host for proxy link construction -- manual command like security_get_status
#[tauri::command]
pub async fn mtproto_get_status(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams { host: host.clone(), port, ssh_user: user, ssh_password: password, key_path, key_data };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    let result = ssh::mtproto_get_status(&app, &*handle, &host).await?;
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
}

// ─── BBR optimization commands ───────────────────────────────────────

ssh_pool_command!(detect_bbr_status, ssh::detect_bbr_status);
ssh_pool_command!(enable_bbr, ssh::enable_bbr);
ssh_pool_command!(disable_bbr, ssh::disable_bbr);

// ─── Non-macro SSH commands ────────────────────────────────────────

#[tauri::command]
pub async fn server_get_available_versions() -> Result<Vec<String>, String> {
    ssh::server_get_available_versions().await
}

#[tauri::command]
pub fn forget_ssh_host_key(host: String, port: u16) {
    ssh::forget_known_host(&host, port);
}

// ─── SSH Credential Storage (keyring + JSON metadata) ────────────

use base64::Engine;
use keyring::Entry;

const KEYRING_SERVICE: &str = "TrustTunnel";

fn ssh_creds_path() -> std::path::PathBuf {
    ssh::portable_data_dir().join("ssh_credentials.json")
}

fn keyring_key(host: &str, port: &str, user: &str) -> String {
    format!("ssh-{host}:{port}-{user}")
}

fn keyring_save(host: &str, port: &str, user: &str, password: &str) -> Result<(), String> {
    let key = keyring_key(host, port, user);
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("Keyring error: {e}"))?;
    entry.set_password(password).map_err(|e| format!("Cannot store password: {e}"))?;
    Ok(())
}

fn keyring_load(host: &str, port: &str, user: &str) -> Result<Option<String>, String> {
    let key = keyring_key(host, port, user);
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("Keyring error: {e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Cannot load password: {e}")),
    }
}

fn keyring_clear(host: &str, port: &str, user: &str) -> Result<(), String> {
    let key = keyring_key(host, port, user);
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| format!("Keyring error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Cannot clear password: {e}")),
    }
}

#[tauri::command]
pub fn save_ssh_credentials(
    host: String,
    port: String,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    // Store password in Windows Credential Manager (DPAPI-backed)
    if !password.is_empty() {
        keyring_save(&host, &port, &user, &password)?;
    }
    // Store metadata only in JSON (no password)
    let data = serde_json::json!({
        "host": host,
        "port": port,
        "user": user,
        "keyPath": key_path.unwrap_or_default(),
    });
    // WR-06 fix: propagate serialization error instead of writing "" (which
    // would silently clobber any existing valid credentials file).
    let data_str = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    std::fs::write(ssh_creds_path(), data_str)
        .map_err(|e| format!("Failed to save credentials: {e}"))
}

#[tauri::command]
pub fn load_ssh_credentials() -> Option<serde_json::Value> {
    let path = ssh_creds_path();
    let content = std::fs::read_to_string(&path).ok()?;
    let mut obj: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&content).ok()?;

    let host = obj.get("host").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let port = obj.get("port").and_then(|v| v.as_str()).unwrap_or("22").to_string();
    let user = obj.get("user").and_then(|v| v.as_str()).unwrap_or("root").to_string();

    // Migration: if JSON still has a "password" field, move it to keyring
    if let Some(pwd_val) = obj.remove("password") {
        if let Some(pwd_str) = pwd_val.as_str() {
            if !pwd_str.is_empty() {
                let decoded = if pwd_str.starts_with("b64:") {
                    // Decode base64-obfuscated password
                    base64::engine::general_purpose::STANDARD
                        .decode(&pwd_str[4..])
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .unwrap_or_else(|| pwd_str.to_string())
                } else {
                    // Plaintext legacy password
                    pwd_str.to_string()
                };
                // Store decoded password in keyring (best-effort migration)
                let _ = keyring_save(&host, &port, &user, &decoded);
                // Rewrite JSON without password field.
                // WR-06 fix: skip write on serialization failure instead of
                // clobbering the file with an empty string. Migration is best-
                // effort — if we can't rewrite cleanly we leave the legacy file
                // alone; next load_ssh_credentials pass retries migration.
                if let Ok(stripped_json) = serde_json::to_string_pretty(&obj) {
                    let _ = std::fs::write(&path, stripped_json);
                }
            }
        }
    }

    // Load password from keyring
    let password = keyring_load(&host, &port, &user).ok().flatten().unwrap_or_default();

    // Return combined object with password from keyring + metadata from JSON
    let mut result = serde_json::Map::new();
    result.insert("host".into(), serde_json::Value::String(host));
    result.insert("port".into(), serde_json::Value::String(port));
    result.insert("user".into(), serde_json::Value::String(user));
    result.insert("password".into(), serde_json::Value::String(password));
    result.insert(
        "keyPath".into(),
        obj.get("keyPath").cloned().unwrap_or(serde_json::Value::String(String::new())),
    );

    Some(serde_json::Value::Object(result))
}

#[tauri::command]
pub fn clear_ssh_credentials() {
    // Read JSON to get host/port/user for keyring cleanup
    if let Ok(content) = std::fs::read_to_string(ssh_creds_path()) {
        if let Ok(obj) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&content) {
            let host = obj.get("host").and_then(|v| v.as_str()).unwrap_or_default();
            let port = obj.get("port").and_then(|v| v.as_str()).unwrap_or("22");
            let user = obj.get("user").and_then(|v| v.as_str()).unwrap_or("root");
            let _ = keyring_clear(host, port, user);
        }
    }
    let _ = std::fs::remove_file(ssh_creds_path());
}

#[tauri::command]
pub fn check_process_conflict() -> Option<String> {
    ssh::check_process_conflict()
}

#[tauri::command]
pub fn kill_existing_process() -> Result<(), String> {
    ssh::kill_existing_process()
}

// ─── Phase 14.1 — advanced user config commands ──────────────────

ssh_pool_command!(
    server_rotate_user_password,
    ssh::server_rotate_user_password,
    vpn_username: String,
    new_password: String
);

ssh_pool_command!(
    server_add_user_advanced,
    ssh::server_add_user_advanced,
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
    // CR-01: Base64-encoded DER bytes (string), not Vec<u8>. See cert_probe.rs.
    pin_certificate_der: Option<String>,
    dns_upstreams: Vec<String>
);

ssh_pool_command!(
    server_update_user_config,
    ssh::server_update_user_config,
    username: String,
    cidr: Option<String>,
    anti_dpi: bool,
    regenerate_prefix: bool
);

ssh_pool_command!(
    server_regenerate_client_prefix,
    ssh::server_regenerate_client_prefix,
    vpn_username: String,
    prefix_length: u32,
    prefix_percent: u32
);

ssh_pool_command!(
    server_fetch_endpoint_cert,
    ssh::server_fetch_endpoint_cert,
    hostname: String,
    cert_port: u16,
    // FIX-OO-13: optional TLS SNI distinct from the TCP destination.
    // Frontend passes `customSni` here when the user opted into an
    // anti-DPI setup; omitted/empty means "use hostname for both".
    sni_host: Option<String>
);

ssh_pool_command!(
    server_export_config_deeplink_advanced,
    ssh::export_config_deeplink_advanced,
    client_name: String,
    custom_sni: Option<String>,
    name: Option<String>,
    upstream_protocol: Option<String>,
    anti_dpi: bool,
    skip_verification: bool,
    // CR-01: Base64-encoded DER bytes (string).
    pin_certificate_der: Option<String>,
    dns_upstreams: Vec<String>
);

ssh_pool_command!(
    server_get_user_config,
    ssh::server_get_user_config,
    vpn_username: String
);

// M-01 — Custom SNI autocomplete: feed the Add/Edit modal with the server's
// actual allowed_sni whitelist so the user doesn't have to guess what
// hosts.toml accepts before the FIX-OO-14 rollback trips.
ssh_pool_command!(
    server_get_allowed_sni_list,
    ssh::get_allowed_sni_list
);

// FIX-NN — server-side TLV persistence (/opt/trusttunnel/users-advanced.toml)
// The upstream protocol doesn't store display_name / SNI / skip_verify /
// upstream_protocol / pin_cert / dns_upstreams, so we keep them in our own
// sidecar file. Edit / FileText reopen / Download .toml all read back from it.

ssh_pool_command!(
    server_get_user_advanced,
    ssh::users_advanced::get_user_advanced,
    username: String
);

// A: batch read of users-advanced.toml for the Users tab list view
// (renders display_name next to the username, one SSH roundtrip for all).
ssh_pool_command!(
    server_list_user_advanced,
    ssh::users_advanced::list_user_advanced
);

ssh_pool_command!(
    server_set_user_advanced,
    ssh::users_advanced::upsert_user_advanced,
    params: ssh::UserAdvanced
);

ssh_pool_command!(
    server_delete_user_advanced,
    ssh::users_advanced::delete_user_advanced,
    username: String
);
