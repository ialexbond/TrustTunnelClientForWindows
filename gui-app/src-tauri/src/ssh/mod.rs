pub mod deploy;
pub mod pool;
pub mod sanitize;
pub mod server;
pub mod process;

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use russh::client;
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::oneshot;

// Re-export everything that lib.rs uses
pub use deploy::{deploy_server, diagnose_server};
pub use server::{
    check_server_installation, uninstall_server, fetch_server_config,
    add_server_user, server_restart_service, server_stop_service,
    server_start_service, server_reboot, server_get_logs, server_remove_user,
    server_get_available_versions, server_upgrade, server_get_stats,
    server_speedtest_run,
    get_server_config, get_cert_info, renew_cert, export_config_deeplink,
    update_config_feature,
    get_security_status, install_fail2ban, uninstall_fail2ban,
    start_fail2ban, stop_fail2ban, start_firewall, stop_firewall,
    fail2ban_unban, fail2ban_ban, fail2ban_set_jail_config, fail2ban_tail_log,
    install_firewall, uninstall_firewall, firewall_add_rule, firewall_delete_rule,
    firewall_set_logging, firewall_tail_log, firewall_set_http_port,
    change_ssh_port,
    NewFirewallRule, JailConfigUpdate,
    mtproto_install, mtproto_get_status, mtproto_uninstall,
    // MtProtoStatus, MtProtoInstallStep are re-exported via commands
    detect_bbr_status, enable_bbr, disable_bbr,
};
pub use pool::SshPool;
pub use process::{check_process_conflict, kill_existing_process};

// ── Server path constants ──
pub const ENDPOINT_DIR: &str = "/opt/trusttunnel";
pub const ENDPOINT_BINARY: &str = "/opt/trusttunnel/trusttunnel_endpoint";
pub const ENDPOINT_CONFIG: &str = "/opt/trusttunnel/vpn.toml";
pub const ENDPOINT_SERVICE: &str = "trusttunnel_endpoint";

// ─── SSH connection parameters ─────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub ssh_user: String,
    pub ssh_password: String,
    pub key_path: Option<String>,
    /// PEM-encoded private key content (alternative to key_path).
    #[serde(default)]
    pub key_data: Option<String>,
}

impl SshParams {
    #[allow(dead_code)]
    pub async fn connect(&self) -> Result<client::Handle<SshHandler>, String> {
        ssh_connect(&self.host, self.port, &self.ssh_user, &self.ssh_password, self.key_path.as_deref(), self.key_data.as_deref(), None).await
    }

    pub async fn connect_with_app(&self, app: tauri::AppHandle) -> Result<client::Handle<SshHandler>, String> {
        ssh_connect(&self.host, self.port, &self.ssh_user, &self.ssh_password, self.key_path.as_deref(), self.key_data.as_deref(), Some(app)).await
    }
}

// ─── Portable data directory (next to exe) ─────────

pub fn portable_data_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

// ── TOFU Host Key Verification ───────────────────
static PENDING_HOST_VERIFY: StdMutex<Option<oneshot::Sender<bool>>> = StdMutex::new(None);

#[derive(Clone, serde::Serialize)]
struct HostKeyVerifyPayload {
    host: String,
    fingerprint: String,
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

#[tauri::command]
pub fn confirm_host_key(accepted: bool) {
    let mut pending = PENDING_HOST_VERIFY.lock().unwrap();
    if let Some(tx) = pending.take() {
        let _ = tx.send(accepted);
    }
}

// ─── SSH Handler ───────────────────────────────────

pub struct SshHandler {
    host_key: String,
    app: Option<tauri::AppHandle>,
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
                if let Some(ref app) = self.app {
                    // Create oneshot channel for user response
                    let (tx, rx) = oneshot::channel();
                    {
                        let mut pending = PENDING_HOST_VERIFY.lock().unwrap();
                        *pending = Some(tx);
                    }

                    // Emit event to frontend
                    app.emit("ssh-host-key-verify", HostKeyVerifyPayload {
                        host: self.host_key.clone(),
                        fingerprint: fingerprint.clone(),
                    }).ok();

                    // Wait for user response with 60-second timeout
                    let accepted = tokio::time::timeout(
                        std::time::Duration::from_secs(60),
                        rx,
                    ).await
                        .unwrap_or(Ok(false))   // timeout -> reject
                        .unwrap_or(false);       // channel dropped -> reject

                    if accepted {
                        hosts.insert(self.host_key.clone(), fingerprint);
                        save_known_hosts(&hosts);
                    }
                    Ok(accepted)
                } else {
                    // No AppHandle (e.g. test context) — auto-accept
                    eprintln!("[SSH] New host {}: fingerprint {fingerprint} (auto-accepted, no UI)", self.host_key);
                    hosts.insert(self.host_key.clone(), fingerprint);
                    save_known_hosts(&hosts);
                    Ok(true)
                }
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

// ─── Shared SSH helpers ──────────────────────────────

/// Detect whether the SSH session is root. Returns "" if root, "sudo " otherwise.
pub async fn detect_sudo(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
) -> &'static str {
    let (whoami, _) = exec_command(handle, app, "whoami")
        .await
        .unwrap_or_default();
    if whoami.trim() == "root" { "" } else { "sudo " }
}

/// Build a complete client TOML config wrapping an endpoint section.
/// `source_comment` is embedded in the file header (e.g. "Setup Wizard", "server 1.2.3.4").
/// Applies anti_dpi=true normalization automatically.
pub fn build_client_config(endpoint_section: &str, source_comment: &str) -> String {
    let config = format!(
        r#"# TrustTunnel Client Configuration
# {source_comment}

loglevel = "info"
vpn_mode = "general"
killswitch_enabled = true
killswitch_allow_ports = [67, 68]
post_quantum_group_enabled = true

[endpoint]
{endpoint_section}

[listener.tun]
mtu_size = 1280
change_system_dns = true
included_routes = ["0.0.0.0/0"]
excluded_routes = []
"#
    );
    config.replace("anti_dpi = false", "anti_dpi = true")
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
    key_data: Option<&str>,
    app: Option<tauri::AppHandle>,
) -> Result<client::Handle<SshHandler>, String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(300)),
        ..Default::default()
    });

    let connect_fut = client::connect(config, (host, port), SshHandler {
        host_key: format!("{host}:{port}"),
        app,
    });
    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        connect_fut,
    )
    .await
    .map_err(|_| format!("SSH_TIMEOUT|{host}:{port}"))?
    .map_err(|e| {
        let msg = e.to_string();
        let lower = msg.to_lowercase();
        if msg.contains("UnknownKey") || msg.contains("unknown key") {
            "SSH_HOST_KEY_CHANGED".to_string()
        } else if lower.contains("failed to lookup address")
            || lower.contains("dns error")
            || lower.contains("name or service not known")
            || lower.contains("no such host is known")
        {
            format!("SSH_DNS_FAILED|{host}")
        } else if lower.contains("network is unreachable")
            || lower.contains("enetunreach")
        {
            format!("SSH_NETWORK_UNREACHABLE|{host}")
        } else if lower.contains("connection refused")
            || lower.contains("econnrefused")
            || lower.contains("actively refused")
        {
            format!("SSH_CONNECTION_REFUSED|{host}|{port}")
        } else if lower.contains("handshake")
            || lower.contains("key exchange")
            || lower.contains("kex")
            || lower.contains("negotiate")
        {
            format!("SSH_TLS_HANDSHAKE_FAILED|{host}")
        } else {
            format!("SSH_CONNECT_FAILED|{e}")
        }
    })?;

    // Try key-based auth: file path or pasted PEM content
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
    if let Some(kd) = key_data {
        if !kd.is_empty() {
            let key = russh_keys::decode_secret_key(kd, None)
                .map_err(|e| format!("SSH_KEY_LOAD_FAILED|pasted|{e}"))?;
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
