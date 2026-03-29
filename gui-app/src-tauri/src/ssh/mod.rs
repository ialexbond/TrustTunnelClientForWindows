pub mod deploy;
pub mod server;
pub mod process;

use std::sync::Arc;
use russh::client;
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::Emitter;

// Re-export everything that lib.rs uses
pub use deploy::{deploy_server, diagnose_server};
pub use server::{
    check_server_installation, uninstall_server, fetch_server_config,
    add_server_user, server_restart_service, server_stop_service,
    server_start_service, server_reboot, server_get_logs, server_remove_user,
    server_get_available_versions, server_upgrade, server_get_stats,
    get_server_config, get_cert_info, renew_cert, export_config_deeplink,
    update_config_feature,
};
pub use process::{check_process_conflict, kill_existing_process};

// ─── SSH connection parameters ─────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub ssh_user: String,
    pub ssh_password: String,
    pub key_path: Option<String>,
}

impl SshParams {
    pub async fn connect(&self) -> Result<client::Handle<SshHandler>, String> {
        ssh_connect(&self.host, self.port, &self.ssh_user, &self.ssh_password, self.key_path.as_deref()).await
    }
}

// ─── Portable data directory (next to exe) ─────────

pub fn portable_data_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

// ─── Event Payloads ────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct DeployStepPayload {
    pub step: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, serde::Serialize)]
pub struct DeployLogPayload {
    pub message: String,
    pub level: String,
}

// ─── Endpoint Settings (from GUI wizard) ───────────

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSettings {
    pub listen_address: String,
    pub vpn_username: String,
    pub vpn_password: String,
    pub cert_type: String,
    pub domain: String,
    #[allow(dead_code)]
    pub client_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub ping_enable: bool,
    #[serde(default)]
    pub speedtest_enable: bool,
    #[serde(default = "default_true")]
    pub ipv6_available: bool,
    #[serde(default)]
    pub cert_chain_path: String,
    #[serde(default)]
    pub cert_key_path: String,
}

fn default_true() -> bool { true }

// ─── Known Hosts (TOFU) ───────────────────────────

fn known_hosts_path() -> std::path::PathBuf {
    portable_data_dir().join("known_hosts.json")
}

fn load_known_hosts() -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(known_hosts_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_known_hosts(hosts: &std::collections::HashMap<String, String>) {
    if let Ok(json) = serde_json::to_string_pretty(hosts) {
        let _ = std::fs::write(known_hosts_path(), json);
    }
}

pub fn forget_known_host(host: &str, port: u16) {
    let key = format!("{host}:{port}");
    let mut hosts = load_known_hosts();
    if hosts.remove(&key).is_some() {
        save_known_hosts(&hosts);
    }
}

// ─── SSH Handler ───────────────────────────────────

pub struct SshHandler {
    host_key: String,
}

#[async_trait::async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint();
        let mut hosts = load_known_hosts();

        match hosts.get(&self.host_key) {
            None => {
                eprintln!("[SSH] New host {}: fingerprint {fingerprint}", self.host_key);
                hosts.insert(self.host_key.clone(), fingerprint);
                save_known_hosts(&hosts);
                Ok(true)
            }
            Some(stored) if stored == &fingerprint => {
                eprintln!("[SSH] Host {} fingerprint verified", self.host_key);
                Ok(true)
            }
            Some(stored) => {
                eprintln!(
                    "[SSH] WARNING: Host key for {} has CHANGED!\n  Expected: {stored}\n  Got:      {fingerprint}\n  \
                     Connection rejected. If the server was reinstalled, remove the old key via settings.",
                    self.host_key
                );
                Ok(false)
            }
        }
    }
}

// ─── Helpers ───────────────────────────────────────

pub(crate) fn emit_step(app: &tauri::AppHandle, step: &str, status: &str, message: &str) {
    eprintln!("[deploy] step={step} status={status} msg={message}");
    app.emit(
        "deploy-step",
        DeployStepPayload {
            step: step.into(),
            status: status.into(),
            message: message.into(),
        },
    )
    .ok();
}

pub(crate) fn emit_log(app: &tauri::AppHandle, level: &str, message: &str) {
    if message.trim().is_empty() {
        return;
    }
    eprintln!("[deploy-log] [{level}] {message}");
    app.emit(
        "deploy-log",
        DeployLogPayload {
            message: message.into(),
            level: level.into(),
        },
    )
    .ok();
}

// ─── SSH Connection ────────────────────────────────

pub async fn ssh_connect(
    host: &str,
    port: u16,
    ssh_user: &str,
    ssh_password: &str,
    key_path: Option<&str>,
) -> Result<client::Handle<SshHandler>, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });

    let connect_fut = client::connect(config, (host, port), SshHandler {
        host_key: format!("{host}:{port}"),
    });
    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        connect_fut,
    )
    .await
    .map_err(|_| format!("SSH_TIMEOUT|{host}:{port}"))?
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("UnknownKey") || msg.contains("unknown key") {
            "SSH_HOST_KEY_CHANGED".to_string()
        } else {
            format!("SSH_CONNECT_FAILED|{e}")
        }
    })?;

    if let Some(kp) = key_path {
        if !kp.is_empty() {
            let key = russh_keys::load_secret_key(kp, None)
                .map_err(|e| format!("SSH_KEY_LOAD_FAILED|{kp}|{e}"))?;
            let auth_ok = handle
                .authenticate_publickey(ssh_user, Arc::new(key))
                .await
                .map_err(|e| format!("SSH_KEY_AUTH_ERROR|{e}"))?;
            if !auth_ok {
                return Err("SSH_KEY_REJECTED".into());
            }
            return Ok(handle);
        }
    }

    let auth_ok = handle
        .authenticate_password(ssh_user, ssh_password)
        .await
        .map_err(|e| format!("SSH_AUTH_ERROR|{e}"))?;

    if !auth_ok {
        return Err("SSH_AUTH_FAILED".into());
    }

    Ok(handle)
}

// ─── Command Execution ─────────────────────────────

pub(crate) async fn exec_command(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    command: &str,
) -> Result<(String, i32), String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut stdout = String::new();
    let mut exit_code: i32 = -1;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                let text = String::from_utf8_lossy(data);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        emit_log(app, "info", trimmed);
                    }
                }
                stdout.push_str(&text);
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                let text = String::from_utf8_lossy(data);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        emit_log(app, "warn", trimmed);
                    }
                }
                stdout.push_str(&text);
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = exit_status as i32;
            }
            _ => {}
        }
    }

    Ok((stdout, exit_code))
}
