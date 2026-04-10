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
            let handle = pool.acquire(&params).await?;
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
    let handle = pool.acquire(&params).await?;
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
    let handle = pool.acquire(&params).await?;
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

// ─── Non-macro SSH commands ────────────────────────────────────────

#[tauri::command]
pub async fn server_get_available_versions() -> Result<Vec<String>, String> {
    ssh::server_get_available_versions().await
}

#[tauri::command]
pub fn forget_ssh_host_key(host: String, port: u16) {
    ssh::forget_known_host(&host, port);
}

// ─── SSH Credential Storage (file-based, not localStorage) ─────────

fn ssh_creds_path() -> std::path::PathBuf {
    ssh::portable_data_dir().join("ssh_credentials.json")
}

#[tauri::command]
pub fn save_ssh_credentials(
    host: String,
    port: String,
    user: String,
    password: String,
    key_path: Option<String>,
) -> Result<(), String> {
    let data = serde_json::json!({
        "host": host,
        "port": port,
        "user": user,
        "password": password, // already obfuscated (b64:...) by frontend
        "keyPath": key_path.unwrap_or_default(),
    });
    std::fs::write(ssh_creds_path(), serde_json::to_string_pretty(&data).unwrap_or_default())
        .map_err(|e| format!("Failed to save credentials: {e}"))
}

#[tauri::command]
pub fn load_ssh_credentials() -> Option<serde_json::Value> {
    std::fs::read_to_string(ssh_creds_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

#[tauri::command]
pub fn clear_ssh_credentials() {
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
