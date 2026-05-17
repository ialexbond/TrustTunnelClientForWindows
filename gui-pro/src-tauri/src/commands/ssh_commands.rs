// SSH command functions intentionally take many flat parameters because
// they mirror the frontend `invoke()` argument shape (host, port, user,
// password, key_path, key_data + per-command extras). Bundling them into
// a struct would force the React layer to construct it on every call site
// without functional benefit, so we silence `too_many_arguments` for the
// whole module.
#![allow(clippy::too_many_arguments)]

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

// ─── Phase 15: vpn.toml Quick Settings + Bundle reader (REQ-15.0, 15.2) ───
ssh_pool_command!(server_get_config_bundle, ssh::get_config_bundle);
ssh_pool_command!(server_update_listen_address, ssh::update_listen_address, address: String);
ssh_pool_command!(server_update_log_level, ssh::update_log_level, level: String);
ssh_pool_command!(server_update_allow_private, ssh::update_allow_private, enabled: bool);
ssh_pool_command!(server_update_auth_status, ssh::update_auth_status, code: u16);
ssh_pool_command!(server_update_ping_path, ssh::update_ping_path, path: String);
ssh_pool_command!(server_update_speedtest_path, ssh::update_speedtest_path, path: String);

// ─── Phase 15: Advanced raw TOML write (REQ-15.3) ─────────────────────────
ssh_pool_command!(server_write_vpn_toml_raw, ssh::write_vpn_toml_raw, content: String);

// ─── Phase 15: hosts.toml allowed_sni mutation (REQ-15.A) ─────────────────
ssh_pool_command!(
    server_update_hosts_allowed_sni,
    ssh::update_hosts_allowed_sni,
    hostname: String,
    allowed_sni: Vec<String>
);

// ─── Phase 15.1: schema-driven generic save (REQ-15.0, 15.7, 15.8) ────────
ssh_pool_command!(
    server_save_config_file,
    ssh::save_config_file,
    file_name: String,
    raw_content: String
);

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
    let result = ssh::get_security_status(&app, &handle, port).await?;
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
    ssh::install_firewall(&app, &handle, port, keep_http_open).await?;
    Ok(serde_json::Value::Null)
}

ssh_pool_command!(security_install_fail2ban, ssh::install_fail2ban);
ssh_pool_command!(security_uninstall_fail2ban, ssh::uninstall_fail2ban);
ssh_pool_command!(security_start_fail2ban, ssh::start_fail2ban);
ssh_pool_command!(security_stop_fail2ban, ssh::stop_fail2ban);
// P UAT 2026-05-04: security_start_firewall — manual (extra ssh_port param).
// Previously macro-based; now нужен SSH port для defensive rule add перед enable.
#[tauri::command]
pub async fn security_start_firewall(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<(), String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::start_firewall(&app, &handle, port).await
}
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
    let actual_port = ssh::change_ssh_port(&app, &handle, new_port, port).await?;
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
    let result = ssh::mtproto_get_status(&app, &handle, &host).await?;
    serde_json::to_value(&result).map_err(|e| format!("Serialize error: {e}"))
}

// ─── BBR optimization commands ───────────────────────────────────────

ssh_pool_command!(detect_bbr_status, ssh::detect_bbr_status);
ssh_pool_command!(enable_bbr, ssh::enable_bbr);
ssh_pool_command!(disable_bbr, ssh::disable_bbr);

// ─── Server Benchmark (Phase 17) — streaming SSH execution ──────────

/// Start an IP.Check.Place benchmark on the remote server.
///
/// Streaming command: emits `benchmark-progress` and `benchmark-stdout-chunk` Tauri events
/// per chunk/milestone during execution (may run 1-3 minutes).
///
/// **B7 Tauri camelCase ↔ snake_case convention:**
/// TypeScript caller sends `{ host, port, user, password, keyPath, keyData }` (camelCase).
/// Tauri 2 default auto-rename converts to snake_case in this Rust signature.
/// Matches existing `security_install_firewall` and `mtproto_install` patterns.
///
/// **Single-flight invariant (D-1.1):**
/// Returns `Err("BENCHMARK_ALREADY_RUNNING")` immediately if another benchmark is in progress.
/// The `benchmark_cancel_tx` slot in `AppState` is cleared on ALL exit paths.
///
/// **Cancel support:**
/// `server_cancel_benchmark` sends a `()` through the oneshot channel stored in `AppState`,
/// which triggers the biased cancel branch in `run_benchmark`.
///
/// **B5:** Returns `BenchmarkResult { raw_stdout, duration_seconds }` — NO parsed sections.
/// Frontend TypeScript owns section parsing via `parseBenchmarkOutput()` (Plan 17-02).
#[tauri::command]
pub async fn server_run_benchmark(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    cancel_state: tauri::State<'_, crate::AppState>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<serde_json::Value, String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;

    // Single-flight guard: reject concurrent benchmark invocations (D-1.1 / T-17-01).
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = cancel_state.benchmark_cancel_tx.lock().await;
        if guard.is_some() {
            return Err("BENCHMARK_ALREADY_RUNNING".into());
        }
        *guard = Some(tx);
    }

    // Run the streaming benchmark (may take 1-3 minutes).
    // run_benchmark is re-exported via ssh::server::mod.rs pub use server_benchmark::*
    let result = ssh::run_benchmark(&app, &handle, rx).await;

    // Cleanup on ALL exit paths: success / cancel / error / watchdog-forced (cleanup invariant).
    *cancel_state.benchmark_cancel_tx.lock().await = None;

    // Surface error to TypeScript (BENCHMARK_CANCELLED|dur=N or BENCHMARK_CANCELLED|dur=N|forced).
    let res: ssh::BenchmarkResult = result?;
    serde_json::to_value(&res).map_err(|e| format!("Serialize error: {e}"))
}

/// Cancel an in-progress benchmark by sending through the oneshot channel.
///
/// The `run_benchmark` loop observes the cancel signal via its biased `tokio::select!`
/// branch, then sends `Sig::TERM` to the remote process group and drains remaining
/// messages with a 5-second B8 watchdog timeout.
///
/// Safe to call when no benchmark is running — `guard.take()` on `None` is a no-op.
#[tauri::command]
pub async fn server_cancel_benchmark(
    cancel_state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let mut guard = cancel_state.benchmark_cancel_tx.lock().await;
    if let Some(tx) = guard.take() {
        let _ = tx.send(());
    }
    Ok(())
}

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
                let decoded = if let Some(b64_payload) = pwd_str.strip_prefix("b64:") {
                    // Decode base64-obfuscated password
                    base64::engine::general_purpose::STANDARD
                        .decode(b64_payload)
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

// ─── Phase 16 — SSH-key feature commands (D-1.1..D-2.3) ──────────
//
// Two-tier shape:
//   1. SSH-using commands (ssh_pool_command!) — pool ensures `CHANNEL_OPEN_GATE`
//      semaphore + retry. host_arg duplicates SshParams.host because the
//      orchestrator function `generate_and_deploy` нужен host для keyring
//      target name (frontend передаёт тот же host обоим путям).
//   2. Local-only commands (manual #[tauri::command]) — DPAPI / fs ops без SSH.

// security_generate_ssh_key — generate Ed25519 + persist в keyring + upload pub.
// Returns: { fingerprint, publicKey, generated }
ssh_pool_command!(
    security_generate_ssh_key,
    ssh::ssh_key_generate_and_deploy,
    host_arg: String
);

// security_get_ssh_key_status — check keyring entry + authorized_keys + sshd_config state.
// Returns: { generated, authorized_on_server, pubkey_fingerprint, password_auth_disabled }
ssh_pool_command!(
    security_get_ssh_key_status,
    ssh::ssh_key_get_status,
    host_arg: String
);

/// security_export_ssh_key_backup — read keyring → write PEM to user-selected dest_path.
/// Per D-2.1 forced backup export flow. NO SSH required (local-only operation).
#[tauri::command]
pub async fn security_export_ssh_key_backup(host: String, dest_path: String) -> Result<(), String> {
    let pem = ssh::ssh_key_keyring_load_pem(&host)?
        .ok_or_else(|| "KEY_NOT_FOUND".to_string())?;

    // Write PEM bytes to user-chosen path (LF line endings preserved)
    std::fs::write(&dest_path, pem.as_bytes())
        .map_err(|e| format!("KEY_BACKUP_WRITE_FAILED|{e}"))?;

    Ok(())
}

/// security_import_ssh_key — validate user-provided .pem + persist в keyring.
/// Per D-2.3 recovery flow (SshConnectForm "Загрузить SSH-ключ" button).
/// NO SSH required.
#[tauri::command]
pub async fn security_import_ssh_key(host: String, pem_path: String) -> Result<(), String> {
    let pem = std::fs::read_to_string(&pem_path)
        .map_err(|e| format!("KEY_IMPORT_READ_FAILED|{e}"))?;
    ssh::ssh_key_import_pem(&host, &pem)
}

/// load_ssh_key_for_host — read keyring entry → return plaintext PEM in-memory.
/// Frontend uses this to pass keyData to connect_ssh (per D-1.4 — frontend
/// does NOT persist plaintext to disk, just hold in JS memory briefly).
#[tauri::command]
pub async fn load_ssh_key_for_host(host: String) -> Result<String, String> {
    ssh::ssh_key_keyring_load_pem(&host)?.ok_or_else(|| "KEY_NOT_FOUND".to_string())
}

/// P UAT 2026-05-04 — extract OpenSSH public key from keyring's stored
/// private PEM. Used для recovery UX: пользователь копирует pubkey текст
/// и manually добавляет в `~/.ssh/authorized_keys` через VPS web console
/// если pubkey upload silently failed на server-side.
///
/// Returns Err("KEY_NOT_FOUND") если keyring entry missing.
/// Returns Err("PUBKEY_DERIVE_FAILED|...") если PEM corrupted.
#[tauri::command]
pub async fn security_get_pubkey_for_recovery(host: String) -> Result<String, String> {
    crate::ssh::server::server_ssh_key::keyring_extract_pubkey(&host)?
        .ok_or_else(|| "KEY_NOT_FOUND".to_string())
}

// ─── Phase 16 — Disable PasswordAuth, Certbot Timer (D-2.2 + D-5.3) ─

/// security_disable_password_auth — sshd_config edit + restart с rollback.
///
/// MANUAL command (NOT macro) because needs `pool.invalidate()` after success
/// — sshd restart kills existing pool handles. Mirrors `security_change_ssh_port` pattern.
#[tauri::command]
pub async fn security_disable_password_auth(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<(), String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::disable_password_auth(&app, &handle).await?;
    // sshd restarted — all pool handles stale, force re-acquire on next call.
    drop(handle);
    pool.invalidate().await;
    Ok(())
}

/// security_enable_password_auth — sshd_config edit + restart с rollback.
///
/// P0-3 #E rollback companion для disable_password_auth. MANUAL command (NOT macro)
/// because needs `pool.invalidate()` after success — sshd restart kills existing
/// pool handles.
#[tauri::command]
pub async fn security_enable_password_auth(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::ssh::SshPool>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_path: Option<String>,
    key_data: Option<String>,
) -> Result<(), String> {
    let params = ssh::SshParams {
        host,
        port,
        ssh_user: user,
        ssh_password: password,
        key_path,
        key_data,
    };
    let handle = pool.acquire(&params, Some(app.clone())).await?;
    ssh::enable_password_auth(&app, &handle).await?;
    // sshd restarted — all pool handles stale, force re-acquire on next call.
    drop(handle);
    pool.invalidate().await;
    Ok(())
}

// server_get_certbot_timer_status — read systemctl + cron file state (D-5.3).
ssh_pool_command!(server_get_certbot_timer_status, ssh::get_certbot_timer_status);

// server_enable_certbot_timer — systemctl enable --now + fallback к cron file.
ssh_pool_command!(server_enable_certbot_timer, ssh::enable_certbot_timer);

// P UAT 2026-05-04 — verify auto-renewal works (certbot renew --dry-run, no rate limit hit).
ssh_pool_command!(server_verify_certbot_renewal, ssh::verify_certbot_renewal);

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

// M-11: sweep orphan entries from users-advanced.toml. Pro calls this from
// UsersSection when the tab is activated — hygiene, no functional effect.
ssh_pool_command!(
    server_reconcile_users_advanced,
    ssh::users_advanced::reconcile_users_advanced
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
