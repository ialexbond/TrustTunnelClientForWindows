pub mod deploy;
pub mod pool;
pub mod sanitize;
pub mod server;
pub mod process;

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use russh::client;
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::Emitter;
use tokio::sync::{oneshot, Semaphore};

// Re-export everything that lib.rs uses
pub use deploy::{deploy_server, diagnose_server};
pub use server::{
    check_server_installation, uninstall_server, fetch_server_config,
    add_server_user, server_restart_service, server_stop_service,
    server_start_service, server_reboot, server_get_logs, server_remove_user,
    server_get_available_versions, server_upgrade, server_get_stats,
    server_get_uptime,
    get_server_config, get_cert_info, renew_cert, export_config_deeplink,
    update_config_feature,
    get_security_status, install_fail2ban, uninstall_fail2ban,
    start_fail2ban, stop_fail2ban, start_firewall, stop_firewall,
    fail2ban_unban, fail2ban_ban, fail2ban_set_jail_config, fail2ban_tail_log,
    install_firewall, uninstall_firewall, firewall_add_rule, firewall_delete_rule,
    firewall_set_logging, firewall_tail_log, firewall_set_http_port,
    change_ssh_port,
    // Phase 16 — disable PasswordAuthentication + certbot.timer (D-2.2 + D-5.3)
    disable_password_auth,
    // Phase 16 P0-3 #E — re-enable PasswordAuthentication (rollback companion)
    enable_password_auth,
    get_certbot_timer_status, enable_certbot_timer, verify_certbot_renewal,
    NewFirewallRule, JailConfigUpdate,
    mtproto_install, mtproto_get_status, mtproto_uninstall,
    // UAT 2026-05-21 — pooled toggle verbs for the new Start/Stop buttons.
    mtproto_start, mtproto_stop,
    // UAT 2026-05-20 — re-export MtProtoStatus so the manual #[tauri::command]
    // for `mtproto_install` in commands/ssh_commands.rs can name its return type.
    MtProtoStatus,
    // MtProtoInstallStep is internal-only (emitted via app.emit, not used in signatures)
    detect_bbr_status, enable_bbr, disable_bbr,
    // Phase 14.1 — advanced user config
    server_rotate_user_password, server_add_user_advanced, AddUserRequest,
    server_update_user_config, server_regenerate_client_prefix,
    server_fetch_endpoint_cert, server_get_user_config,
    export_config_deeplink_advanced,
    // M-01 — Custom SNI autocomplete
    get_allowed_sni_list, AllowedSniHost,
    UserRule, EndpointCertInfo,
    // FIX-NN — server-side TLV persistence
    users_advanced,
    UserAdvanced,
    // Phase 15 — vpn.toml bundle reader + raw write (Plan 01). The per-field typed
    // setters (update_listen_address / _log_level / _allow_private / _auth_status /
    // _ping_path / _speedtest_path) were REMOVED — superseded by the generic
    // save_config_file path, zero frontend callers remained.
    get_config_bundle, write_vpn_toml_raw,
    // Phase 15 — hosts.toml allowed_sni mutation (Plan 02, REQ-15.A)
    update_hosts_allowed_sni,
    // Phase 15.1 — generic per-file config save (REQ-15.0 + 15.7 + 15.8)
    save_config_file,
    // Phase 17 — Server Benchmark Check.Place (simplified: no parse_signal/BenchmarkProgress)
    run_benchmark, BenchmarkResult,
    // Phase 18 — sidecar update flow (Plan 18-05, REQ-18-UPDATE-FLOW-03..07)
    update_sidecar, update_sidecar_cancel, UpdateStep, BackupStatus,
};
// Phase 16 — SSH-key feature (D-1.1..D-2.3, REQ-16-SSH-KEY-*).
// Re-exported under namespaced names so commands::ssh_commands может вызывать
// `ssh::ssh_key_*` без prefix collision с existing `keyring_save/load/clear`
// password helpers (различные KEYRING_SERVICE namespaces).
pub use server::server_ssh_key::{
    generate_and_deploy as ssh_key_generate_and_deploy,
    get_ssh_key_status as ssh_key_get_status,
    import_pem_and_persist as ssh_key_import_pem,
    keyring_clear_pem as ssh_key_keyring_clear_pem,
    keyring_load_pem as ssh_key_keyring_load_pem,
    keyring_save_pem as ssh_key_keyring_save_pem,
    validate_pem_format as ssh_key_validate_pem,
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
    /// EXPLICIT single auth choice from the wizard ("password" | "key"), D-06.
    /// When `Some`, `ssh_connect` attempts ONLY that method — sending BOTH a
    /// password and a key was the root cause of "key rejected even though the
    /// password works" (the backend silently preferred the key). `#[serde(default)]`
    /// keeps every existing internal caller (which never sets it) backward-compatible:
    /// `None` ⇒ the legacy try-key-then-password sequence (Codex #2 / Pitfall 2).
    #[serde(default)]
    pub auth_method: Option<String>,
}

impl SshParams {
    #[allow(dead_code)]
    pub async fn connect(&self) -> Result<client::Handle<SshHandler>, String> {
        ssh_connect(&self.host, self.port, &self.ssh_user, &self.ssh_password, self.key_path.as_deref(), self.key_data.as_deref(), self.auth_method.as_deref(), None).await
    }

    pub async fn connect_with_app(&self, app: tauri::AppHandle) -> Result<client::Handle<SshHandler>, String> {
        ssh_connect(&self.host, self.port, &self.ssh_user, &self.ssh_password, self.key_path.as_deref(), self.key_data.as_deref(), self.auth_method.as_deref(), Some(app)).await
    }
}

// ─── Single-auth-method decision (D-06 root fix) ───
//
// The PURE decision of which auth method `ssh_connect` should attempt, factored
// out so the D-06 fix is unit-testable WITHOUT a live SSH server (the live
// `authenticate_*` calls need a server; the DECISION does not). russh 0.46
// returns only `Result<bool>` — there is NO server method list — so D-07 steering
// downstream is a heuristic keyed on WHICH method we attempted, never a read of a
// permitted-method list (RESEARCH Priority Finding / Pitfall 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthAttempt {
    /// Attempt publickey ONLY (from key_path or key_data) — never fall through.
    KeyOnly,
    /// Attempt password ONLY — never try the key.
    PasswordOnly,
    /// Legacy back-compat: try key (path/data) then password in sequence.
    /// Used by every internal (non-wizard) caller that passes no auth_method.
    LegacySequence,
}

/// Pure decision helper: given the explicit `auth_method` (if any) and which
/// credentials are present, decide what `ssh_connect` attempts. The wizard always
/// passes `Some("password")` / `Some("key")` so exactly one method crosses the
/// boundary (D-06); internal callers pass `None` and keep the legacy sequence.
pub fn auth_plan(auth_method: Option<&str>, _has_key: bool, _has_password: bool) -> AuthAttempt {
    match auth_method {
        Some("key") => AuthAttempt::KeyOnly,
        Some("password") => AuthAttempt::PasswordOnly,
        _ => AuthAttempt::LegacySequence,
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

// #22 (06-uat) per-run generation stamp. The deploy-step / deploy-log events carry
// NO information about WHICH install run produced them, so the frontend listener could
// not distinguish a late/buffered event from a just-cancelled run from a fresh run's
// own event. After cancel→re-install that bled the old run's step rows into the new
// run's progress map (two yellow steps at once, a stale green/skipped row). The fix
// stamps every deploy event with the CURRENT run's opId; the frontend captures the
// opId it passed to deploy_server / fetch_server_config and drops any event whose opId
// does not match — so cross-run bleed is structurally impossible.
//
// CURRENT_DEPLOY_OP_ID holds the opId of the run that is allowed to emit right now.
// deploy_server / fetch_server_config STORE their op_id here at entry (before the first
// emit_step), and emit_step / emit_log READ it when building the payload. This is safe
// against a stale-run overwrite because the frontend is single-flight (the no-overlap
// guard in handleDeploy means only one deploy command runs at a time) AND cancel awaits
// uninstall_server, which kills the old deploy's server-side process group BEFORE the
// new run starts — so the old emitter is dead before the new run sets this value. A
// value of 0 means "unstamped" (no deploy run has set it, or a legacy caller that did
// not pass an opId); the frontend treats 0 as "accept" so existing flows are unchanged.
pub static CURRENT_DEPLOY_OP_ID: AtomicU64 = AtomicU64::new(0);

/// Set the active deploy generation so subsequent emit_step / emit_log events are
/// stamped with this run's opId. Called once at the top of deploy_server /
/// fetch_server_config, before any event is emitted.
pub(crate) fn set_deploy_op_id(op_id: u64) {
    CURRENT_DEPLOY_OP_ID.store(op_id, Ordering::SeqCst);
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployStepPayload {
    pub step: String,
    pub status: String,
    pub message: String,
    // #22: the run generation this event belongs to (0 = unstamped; see CURRENT_DEPLOY_OP_ID).
    pub op_id: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployLogPayload {
    pub message: String,
    pub level: String,
    // #22: the run generation this event belongs to (0 = unstamped; see CURRENT_DEPLOY_OP_ID).
    pub op_id: u64,
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
    // DC-01: the `client_name` field was REMOVED — nothing read it. The client config
    // filename is derived from `vpn_username` via client_config_filename(&vpn_username).
    // Serde has no deny_unknown_fields, so a frontend still sending `clientName` is
    // harmlessly ignored.
    #[serde(default)]
    pub email: String,
    // 06-uat install-wizard slimming: the ICMP and IPv6 toggles were HIDDEN in the
    // wizard (rarely useful for a non-technical operator) but their feature stays ON.
    // Their `icmp_enable` / `ipv6_available` EndpointSettings fields were REMOVED — the
    // safe ON defaults are now hard-coded as the constants ICMP_ENABLE_DEFAULT /
    // IPV6_AVAILABLE_DEFAULT in deploy.rs's build_intended_vpn_toml + build_configure_commands,
    // so the written vpn.toml ([icmp] section + ipv6_available = true) is unchanged. The
    // Metrics (Prometheus), SOCKS5 upstream and Allow-private-network settings were
    // REMOVED from the wizard entirely (UI + state + validators + their fields here);
    // allow_private_network_connections is now hard-coded `false` in build_intended_vpn_toml.
    #[serde(default)]
    pub cert_chain_path: String,
    #[serde(default)]
    pub cert_key_path: String,
    // D-10 (06-09): the 407/405 auth-failure chooser (top-level, default 407; 405|407),
    // value-constrained by the EXISTING sanitize::validate_auth_status_code (no duplicate
    // validator). Schema-exact per CONFIGURATION.md v1.0.33.
    #[serde(default = "default_407")]
    pub auth_failure_status_code: u16,
    // CAMOUFLAGE REMOVED: the reverse-proxy / camouflage fields (reverse_proxy_enable,
    // reverse_proxy_auto, reverse_proxy_address, reverse_proxy_path_mask,
    // reverse_proxy_h3_compat) were removed along with the rest of the camouflage feature —
    // it does not work on the prebuilt core (v1.0.33). build_intended_vpn_toml no longer
    // emits a `[reverse_proxy]` section. Serde has no deny_unknown_fields, so a frontend
    // still sending the old `reverseProxy*` keys is harmlessly ignored.
    // Best-effort GeoIP country code (serde camelCase → JS key `countryCode`) used ONLY
    // to brand the LOCAL client-config filename `[<CC>_]TrustTunnel_<login>.toml` in
    // deploy_export_config, matching the Save-As dialog default. Optional/unvalidated
    // here on purpose: client_config_filename only accepts an exactly-two-ASCII-letter
    // value and ignores anything else, so a junk/None value never reaches the path.
    #[serde(default)]
    pub country_code: Option<String>,
    // WIZARD-06 / D-01: install-time server-hardening toggles, default ON. These are the
    // recommended secure baseline (ufw + fail2ban), so a legacy/omitting payload must STILL
    // provision them — hence `#[serde(default = "default_true")]`, not bare `#[serde(default)]`
    // (which would default a missing key to `false` and silently skip hardening).
    //
    // SAFETY-01 rationale (RESEARCH Pitfall 2): these are `bool` — they cannot carry shell
    // metacharacters and only GATE a call, so they add NO new SSH-reaching string surface and
    // need NO new `sanitize.rs` validator. The only string reaching the firewall command is
    // `params.port: u16`, already typed and validated at the `ssh_connect` chokepoint.
    #[serde(default = "default_true")]
    pub enable_firewall: bool,
    #[serde(default = "default_true")]
    pub enable_fail2ban: bool,
}

fn default_407() -> u16 { 407 }
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

/// Whether a STORED host fingerprint differs from the LIVE one presented by the
/// server (D-09, Gemini #11). Pure fn so the changed-key decision is unit-testable
/// under `cargo test --lib` without a live SSH session. A differing fingerprint means
/// the server's host key changed (reinstall — or, in the worst case, a MITM), which
/// `check_server_key` records on the SshHandler flag so `ssh_connect` can surface
/// `SSH_HOST_KEY_CHANGED` distinctly from an unknown (never-seen) key.
pub(crate) fn fingerprints_differ(stored: &str, live: &str) -> bool {
    stored != live
}

#[tauri::command]
pub fn confirm_host_key(accepted: bool) {
    // WR-05 fix: tolerate poisoned Mutex. If a prior thread panicked while
    // holding this lock, `.unwrap()` would panic again (process crash triggered
    // by frontend IPC input). Recover the inner value as other call sites do
    // (see lib.rs:225, logging.rs:156, commands/activity_log.rs:66).
    let mut pending = PENDING_HOST_VERIFY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = pending.take() {
        let _ = tx.send(accepted);
    }
}

// ─── SSH Handler ───────────────────────────────────

pub struct SshHandler {
    host_key: String,
    app: Option<tauri::AppHandle>,
    // D-09 / Gemini #11: `check_server_key` is a russh trait method that can only
    // return a bool — when it detects a CHANGED host key it returns Ok(false) but the
    // "why" never reaches `ssh_connect`. This shared flag carries that signal out: the
    // changed-key arm sets it true before returning Ok(false), and `ssh_connect` reads
    // it AFTER the connection aborts to map the failure to SSH_HOST_KEY_CHANGED
    // (authoritative — does NOT depend on the unreliable russh 0.46 error string,
    // RESEARCH Pitfall 5). An Arc<AtomicBool> so it survives the move into russh and is
    // readable from the connecting task after the handler is consumed.
    host_key_changed: Arc<AtomicBool>,
}

// russh 0.60 switched `client::Handler` to native `async fn` (RPITIT, returning
// `impl Future + Send`) — it is no longer an `#[async_trait]` trait. Applying the
// async_trait attribute here boxes the future and produces a lifetime/signature
// mismatch against the trait (E0195). We implement the method as a plain `async fn`.
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        // russh 0.60 merged russh-keys into `russh::keys` and the host-key param is now
        // the re-exported ssh-key `PublicKey` (was `&russh_keys::key::PublicKey` in 0.46).
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // ssh-key's `fingerprint` takes a HashAlg and returns a `Fingerprint` (was a bare
        // `String` in russh-keys 0.46). Mirror server_ssh_key.rs:51 exactly: SHA-256.
        let fingerprint = server_public_key
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let mut hosts = load_known_hosts();

        match hosts.get(&self.host_key) {
            None => {
                if let Some(ref app) = self.app {
                    // Create oneshot channel for user response
                    let (tx, rx) = oneshot::channel();
                    {
                        // WR-05 fix: tolerate poisoned Mutex (see confirm_host_key).
                        let mut pending = PENDING_HOST_VERIFY.lock().unwrap_or_else(|e| e.into_inner());
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
            // A stored fingerprint that DIFFERS from the live one → CHANGED host key
            // (the equal case is handled above). fingerprints_differ is the pure,
            // unit-tested predicate (D-09 / Gemini #11).
            Some(stored) if fingerprints_differ(stored, &fingerprint) => {
                eprintln!(
                    "[SSH] WARNING: Host key for {} has CHANGED!\n  Expected: {stored}\n  Got:      {fingerprint}\n  \
                     Connection rejected. If the server was reinstalled, trust the new key via the recovery screen.",
                    self.host_key
                );
                // D-09 / Gemini #11: record the CHANGED-key signal so ssh_connect can
                // surface SSH_HOST_KEY_CHANGED after the connection aborts. We return
                // Ok(false) (reject) — trust is NEVER granted silently here; it happens
                // only via the explicit RecoveryStep "trust the new key" action
                // (round-2 finding B: the old auto-forget is removed).
                self.host_key_changed.store(true, Ordering::SeqCst);
                Ok(false)
            }
            // Logically unreachable (the two guards above partition the Some space on
            // equality), but the compiler cannot prove guard exhaustiveness — a safe
            // reject keeps the match total without ever silently accepting a key.
            Some(_) => Ok(false),
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
    // #22: stamp the event with the active run generation so the frontend can drop a
    // late/stale event from a previous (cancelled) run instead of bleeding it into a
    // fresh run's progress map.
    let op_id = CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst);
    app.emit(
        "deploy-step",
        DeployStepPayload {
            step: step.into(),
            status: status.into(),
            message: message.into(),
            op_id,
        },
    )
    .ok();
}

/// Sink-formatting seam for the deploy-log channel (S-3 / SAFETY-02 / D-29).
///
/// This is the single point that produces the FINAL strings handed to BOTH
/// deploy-log sinks. It returns the two shapes the sinks actually consume:
///
/// - `.0` = the `eprintln!` stderr line, `[deploy-log] [{level}] {message}`
///   (prefix preserved byte-identical so nothing that scrapes stderr changes
///   shape).
/// - `.1` = the bare message that goes into the `deploy-log` Tauri event
///   payload's `message` field (the frontend renders this verbatim and parses
///   `\b(\d+)\s*%`; it must stay prefix-free, so we keep it bare).
///
/// `emit_log` routes both sinks through this seam so the redaction below cannot
/// be bypassed on one of the two paths.
///
/// `diagnose_server` / `get_server_config` stream the output of
/// `cat .../vpn.toml` (which contains `password = "…"` lines) through `emit_log`
/// line by line. Before this seam sanitized, the raw line reached stderr and the
/// frontend event unredacted. We apply `crate::logging::sanitize` here — the SAME
/// redaction the activity-log file-writer (`commands::activity_log`) uses — so the
/// secret never crosses the host log boundary on either sink. sanitize() is a
/// no-op on lines that are not `key = value`-shaped, so non-secret log lines are
/// unchanged.
///
/// Returns `(stderr_line, event_message)`.
fn format_deploy_log_line(level: &str, message: &str) -> (String, String) {
    let safe = crate::logging::sanitize(message);
    let stderr_line = format!("[deploy-log] [{level}] {safe}");
    (stderr_line, safe)
}

pub(crate) fn emit_log(app: &tauri::AppHandle, level: &str, message: &str) {
    if message.trim().is_empty() {
        return;
    }
    // Both sinks consume the seam's sanitized output so the redaction is
    // identical and cannot be bypassed on one path (S-3 / SAFETY-02).
    let (stderr_line, event_message) = format_deploy_log_line(level, message);
    eprintln!("{stderr_line}");
    // #22: stamp the log event with the active run generation (same rationale as emit_step).
    let op_id = CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst);
    app.emit(
        "deploy-log",
        DeployLogPayload {
            // Bare sanitized message — frontend renders this verbatim and parses
            // it for percent; the stderr prefix must NOT leak into the UI.
            message: event_message,
            level: level.into(),
            op_id,
        },
    )
    .ok();
}

// ─── SSH Connection ────────────────────────────────

// Adding the D-06 `auth_method` param pushed this past clippy's 7-arg threshold.
// These are flat connection inputs mirroring the SSH handshake (host/port/user/
// password/key_path/key_data/auth_method/app); bundling them into a struct buys
// nothing here, so we silence the lint for this one function (matches the
// module-wide allow on ssh_commands.rs).
#[allow(clippy::too_many_arguments)]
pub async fn ssh_connect(
    host: &str,
    port: u16,
    ssh_user: &str,
    ssh_password: &str,
    key_path: Option<&str>,
    key_data: Option<&str>,
    auth_method: Option<&str>,
    app: Option<tauri::AppHandle>,
) -> Result<client::Handle<SshHandler>, String> {
    // SAFETY-01 (S-04) — validate the operator-typed connect inputs at the IPC
    // boundary BEFORE they are used. `host` reaches a remote shell command later
    // (the `-a {addr}` export, deploy.rs) and `ssh_user` crosses into russh's native
    // userauth + the pool cache key; whitelist-validate both here so a metacharacter
    // payload (`host;rm -rf /`) is refused at the single connect chokepoint rather
    // than relying on each downstream call site to re-validate. `auth_method` is
    // constrained to the explicit enum here (finding H) — `None` is allowed (the
    // legacy/internal Option<String> back-compat path, round-3 LOW E).
    sanitize::validate_ssh_host(host).map_err(|e| format!("SSH_INVALID_HOST|{e}"))?;
    sanitize::validate_ssh_user(ssh_user).map_err(|e| format!("SSH_INVALID_USER|{e}"))?;
    sanitize::validate_auth_method(auth_method).map_err(|e| format!("SSH_INVALID_AUTH_METHOD|{e}"))?;

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(300)),
        ..Default::default()
    });

    // D-09 / Gemini #11: share a host_key_changed flag with the handler so we can read
    // it AFTER the connection aborts and surface SSH_HOST_KEY_CHANGED authoritatively
    // (the russh error string does not cleanly separate changed-vs-unknown keys —
    // RESEARCH Pitfall 5). The Arc lets the flag outlive the handler's move into russh.
    let host_key_changed = Arc::new(AtomicBool::new(false));
    let connect_fut = client::connect(config, (host, port), SshHandler {
        host_key: format!("{host}:{port}"),
        app,
        host_key_changed: host_key_changed.clone(),
    });
    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        connect_fut,
    )
    .await
    .map_err(|_| format!("SSH_TIMEOUT|{host}:{port}"))?
    .map_err(|e| {
        // AUTHORITATIVE changed-key signal (Gemini #11): if check_server_key recorded a
        // CHANGED host key, the connection aborts here — read the flag first and map to
        // SSH_HOST_KEY_CHANGED regardless of what the russh error string says. The
        // UnknownKey string match below stays only as a best-effort fallback.
        if host_key_changed.load(Ordering::SeqCst) {
            return "SSH_HOST_KEY_CHANGED".to_string();
        }
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

    // D-06: send ONLY the chosen auth method. Sending both a password AND a key
    // (the legacy sequence below) was the root cause of "key rejected even though
    // the password works" — the backend tried the key first and reported its
    // rejection. The wizard now passes an explicit `auth_method`; internal callers
    // pass None and keep the legacy sequence (back-compat). russh 0.46 returns only
    // `Ok(bool)` from `authenticate_*`, so D-07 steering downstream is a HEURISTIC
    // on which method we attempted, never a read of a server method list (Pitfall 3).
    let has_key = key_path.map(|k| !k.is_empty()).unwrap_or(false)
        || key_data.map(|k| !k.is_empty()).unwrap_or(false);
    let has_password = !ssh_password.is_empty();
    let plan = auth_plan(auth_method, has_key, has_password);

    // D-08: a missing key file / undecodable pasted key returns an ACTIONABLE
    // re-enter signal (`SSH_KEY_REENTER_REQUIRED`) instead of the opaque
    // `SSH_KEY_LOAD_FAILED` dead end. Never interpolate the key material itself into
    // the error (D-29/D-10) — only a stable code (the path/`pasted` tag is safe).
    async fn try_key_auth(
        handle: &mut client::Handle<SshHandler>,
        ssh_user: &str,
        key_path: Option<&str>,
        key_data: Option<&str>,
    ) -> Result<Option<bool>, String> {
        if let Some(kp) = key_path {
            if !kp.is_empty() {
                let key = russh::keys::load_secret_key(kp, None)
                    .map_err(|_| "SSH_KEY_REENTER_REQUIRED|file".to_string())?;
                // russh 0.60: authenticate_publickey takes a `PrivateKeyWithHashAlg`
                // (None hash-alg works for Ed25519; RSA would need Sha256/Sha512) and
                // returns an `AuthResult` enum instead of a bare `bool`. We map
                // Success → true so the downstream Some(true)/Some(false) arms (and
                // their exact error codes) stay byte-for-byte unchanged.
                let result = handle
                    .authenticate_publickey(
                        ssh_user,
                        russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| format!("SSH_KEY_AUTH_ERROR|{e}"))?;
                let ok = matches!(result, russh::client::AuthResult::Success);
                return Ok(Some(ok));
            }
        }
        if let Some(kd) = key_data {
            if !kd.is_empty() {
                let key = russh::keys::decode_secret_key(kd, None)
                    .map_err(|_| "SSH_KEY_REENTER_REQUIRED|pasted".to_string())?;
                let result = handle
                    .authenticate_publickey(
                        ssh_user,
                        russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| format!("SSH_KEY_AUTH_ERROR|{e}"))?;
                let ok = matches!(result, russh::client::AuthResult::Success);
                return Ok(Some(ok));
            }
        }
        Ok(None) // no key material present
    }

    match plan {
        AuthAttempt::KeyOnly => {
            // Explicit "key" choice: attempt ONLY publickey, NEVER fall through to
            // password. Absent/undecodable key ⇒ re-enter (D-08), not a password try.
            match try_key_auth(&mut handle, ssh_user, key_path, key_data).await? {
                Some(true) => Ok(handle),
                Some(false) => Err("SSH_KEY_REJECTED".into()),
                // The user chose "key" but no usable key material reached us — ask
                // them to re-select/re-paste rather than silently using a password.
                None => Err("SSH_KEY_REENTER_REQUIRED|missing".into()),
            }
        }
        AuthAttempt::PasswordOnly => {
            // Explicit "password" choice: attempt ONLY the password, NEVER the key.
            // russh 0.60: authenticate_password returns `AuthResult` not `bool`.
            let result = handle
                .authenticate_password(ssh_user, ssh_password)
                .await
                .map_err(|e| format!("SSH_AUTH_ERROR|{e}"))?;
            if !matches!(result, russh::client::AuthResult::Success) {
                // DISTINCT from SSH_KEY_REJECTED so D-07 can steer toward the key.
                return Err("SSH_PASSWORD_REJECTED".into());
            }
            Ok(handle)
        }
        AuthAttempt::LegacySequence => {
            // Back-compat for internal (non-wizard) callers: key (path/data) then
            // password in sequence. Preserved verbatim so existing flows are unchanged.
            match try_key_auth(&mut handle, ssh_user, key_path, key_data).await? {
                Some(true) => return Ok(handle),
                Some(false) => return Err("SSH_KEY_REJECTED".into()),
                None => { /* no key material — fall through to password */ }
            }
            // russh 0.60: authenticate_password returns `AuthResult` not `bool`.
            let result = handle
                .authenticate_password(ssh_user, ssh_password)
                .await
                .map_err(|e| format!("SSH_AUTH_ERROR|{e}"))?;
            if !matches!(result, russh::client::AuthResult::Success) {
                return Err("SSH_AUTH_FAILED".into());
            }
            Ok(handle)
        }
    }
}

// ─── Command Execution ─────────────────────────────

/// Global limiter на одновременные channel_open. sshd default MaxSessions=10 —
/// без ограничения ~10 параллельных panel-mount команд упирались в этот
/// лимит и получали `Error::ChannelOpenFailure(ConnectFailed)`, даже при
/// успешной установленной SSH-сессии (например `users.displayname_fetch_failed`
/// и `overview.security.failed` через 400ms после panel.load.completed при
/// первой авторизации в новый сервер, см. D-bug-ssh-pool-stampede).
///
/// Permit=5 оставляет 5 слотов в запас для keepalive heartbeats + ad-hoc
/// команд (kill-sidecar, cancel operations). Semaphore гарантирует что
/// стампиду 10+ команд physically не перегружают sshd — retry остаётся
/// как mitigation для реальных transient failures (network hiccup, forking
/// latency при cold sshd).
static CHANNEL_OPEN_GATE: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(5));

/// Open a session channel with a global concurrency gate + transient-failure retries.
///
/// Panel mount fires ~10 parallel pooled SSH commands on the shared handle
/// (OverviewSection: stats + uptime + security, UsersSection: displayname,
/// ServerSettings + SecurityTab each re-load security via useSecurityState,
/// Utilities: BBR + MTProto). When sshd can't keep up (small VPS, default
/// MaxSessions=10, fork latency) it replies SSH_MSG_CHANNEL_OPEN_FAILURE
/// with reason=ConnectFailed or ResourceShortage — russh surfaces these as
/// `Error::ChannelOpenFailure(_)`.
///
/// Two-layer defence:
///   1. **Gate (Semaphore):** физически ограничивает parallel channel_open до
///      5. Остальные команды ждут permit. Никогда не перегружаем sshd.
///   2. **Retry with jittered backoff:** для случаев когда sshd всё-равно
///      вернул transient failure (gate не защищает от sshd-side race).
///      6 attempts × (50/100/200/400/800 ms + 0-99ms jitter) = up to ~1.8s
///      total retry window — достаточно для cold fork latency recovery.
pub(crate) async fn open_session_with_retry(
    handle: &client::Handle<SshHandler>,
) -> Result<russh::Channel<russh::client::Msg>, russh::Error> {
    const MAX_ATTEMPTS: u32 = 6; // 1 initial try + 5 retries

    // Acquire permit ДО попытки. Если gate закрыт — ждём пока освободится
    // слот. Permit дропается при return (через RAII) => следующая команда
    // сможет войти.
    let _permit = CHANNEL_OPEN_GATE.acquire().await
        .expect("CHANNEL_OPEN_GATE never closed");

    let mut attempt: u32 = 0;
    loop {
        match handle.channel_open_session().await {
            Ok(ch) => return Ok(ch),
            Err(e) => {
                let transient = matches!(&e, russh::Error::ChannelOpenFailure(_));
                attempt += 1;
                if !transient || attempt >= MAX_ATTEMPTS {
                    return Err(e);
                }
                // Exponential backoff 50/100/200/400/800 ms + 0-99ms jitter
                // so parallel retries fan out instead of thundering together.
                let base_ms: u64 = 50u64 * (1u64 << (attempt - 1));
                let jitter_ms: u64 = rand::random::<u64>() % 100;
                let delay_ms = base_ms + jitter_ms;
                eprintln!(
                    "[SSH] channel_open_session transient fail ({e}); retry {attempt}/{} in {delay_ms}ms",
                    MAX_ATTEMPTS - 1
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }
}

pub(crate) async fn exec_command(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    command: &str,
) -> Result<(String, i32), String> {
    let mut channel = open_session_with_retry(handle)
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

/// True when the active deploy generation no longer matches `expected` — the run was
/// cancelled (`cancel_deploy` bumps `CURRENT_DEPLOY_OP_ID`) or superseded by a newer
/// deploy. `expected == 0` means "no run captured" → never superseded (so non-deploy
/// callers and legacy unstamped flows are unaffected).
pub(crate) fn deploy_superseded(expected: u64) -> bool {
    expected != 0 && CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst) != expected
}

/// Like [`exec_command`], but ABORTS the moment the active deploy generation changes.
///
/// 06-uat cancel→reinstall blocker: plain `exec_command` blocks on `channel.wait()`
/// with no cancellation branch, so a cancelled `deploy_server` kept running its long
/// server-side stages (apt / install.sh / certbot). Its `configure` then raced the
/// cancel's `uninstall_server` rollback (`rm -rf /opt/trusttunnel` mid-configure) and
/// a fresh install piled on top → "наслоение процессов". This variant polls
/// `CURRENT_DEPLOY_OP_ID` every 250 ms via `tokio::select!`; on a generation change it
/// drops the channel (russh closes it on drop) and returns `SSH_DEPLOY_CANCELLED` so
/// the local future unwinds immediately — freeing the backend single-flight guard. The
/// remote process tree is killed separately by `uninstall_server`'s
/// `build_stop_in_progress` (the negative-PGID kill). Used only by the long deploy
/// stages; the short probes keep plain `exec_command`.
pub(crate) async fn exec_command_cancellable(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    command: &str,
) -> Result<(String, i32), String> {
    // Capture the generation this exec belongs to (the run's op_id, set by
    // set_deploy_op_id at deploy_server entry). 0 = unstamped → not cancellable.
    let expected = CURRENT_DEPLOY_OP_ID.load(Ordering::SeqCst);

    let mut channel = open_session_with_retry(handle)
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut stdout = String::new();
    let mut exit_code: i32 = -1;

    // A short cancellation poll. The first tick fires immediately, so consume it before
    // the loop — otherwise we would spuriously check before any work has begun.
    let mut poll = tokio::time::interval(std::time::Duration::from_millis(250));
    poll.tick().await;

    loop {
        tokio::select! {
            maybe_msg = channel.wait() => {
                match maybe_msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let text = String::from_utf8_lossy(data);
                        for line in text.lines() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() { emit_log(app, "info", trimmed); }
                        }
                        stdout.push_str(&text);
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        let text = String::from_utf8_lossy(data);
                        for line in text.lines() {
                            let trimmed = line.trim();
                            if !trimmed.is_empty() { emit_log(app, "warn", trimmed); }
                        }
                        stdout.push_str(&text);
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => { exit_code = exit_status as i32; }
                    Some(_) => {}
                    None => break,
                }
            }
            _ = poll.tick() => {
                if deploy_superseded(expected) {
                    // Cancelled / superseded — returning drops `channel`, which russh
                    // closes; the local future stops here. The server-side process is
                    // reaped by uninstall_server's PID-group kill.
                    return Err("SSH_DEPLOY_CANCELLED|superseded".to_string());
                }
            }
        }
    }

    Ok((stdout, exit_code))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── host-key-changed detection (D-09, Gemini #11) ──

    /// A DIFFERENT stored vs live fingerprint is a CHANGED host key (the reinstalled-
    /// server / MITM case) — fingerprints_differ returns true, which check_server_key
    /// uses to set the host_key_changed flag so ssh_connect surfaces
    /// SSH_HOST_KEY_CHANGED.
    #[test]
    fn host_key_changed_when_fingerprints_differ() {
        assert!(fingerprints_differ("SHA256:aaa", "SHA256:bbb"));
    }

    /// The SAME stored vs live fingerprint is NOT a change — an unchanged key must
    /// never be mis-flagged as changed (it would falsely route into the recovery
    /// trust-new-key path).
    #[test]
    fn host_key_unchanged_when_fingerprints_match() {
        assert!(!fingerprints_differ("SHA256:aaa", "SHA256:aaa"));
    }

    /// 06-uat cancel→reinstall: `deploy_superseded` drives `exec_command_cancellable`'s
    /// abort. A run is superseded when the active generation changed from the one the
    /// exec captured (cancel_deploy bumps it / a newer deploy sets its own). An
    /// `expected == 0` (unstamped) exec is NEVER superseded so non-deploy callers and
    /// legacy flows are unaffected.
    #[test]
    fn deploy_superseded_tracks_generation_changes() {
        set_deploy_op_id(7);
        assert!(!deploy_superseded(7), "matching generation is not superseded");
        assert!(deploy_superseded(6), "an older captured generation is superseded");
        // cancel_deploy bumps the active generation → the in-flight exec (captured 7) aborts.
        CURRENT_DEPLOY_OP_ID.fetch_add(1, Ordering::SeqCst);
        assert!(deploy_superseded(7), "after a cancel bump, the captured run is superseded");
        // expected == 0 is the unstamped sentinel — never cancellable.
        assert!(!deploy_superseded(0), "unstamped (0) exec is never superseded");
    }

    /// S-3 / SAFETY-02 / D-29 regression: a `password = "…"` line streamed from
    /// `cat vpn.toml` through `emit_log` must NOT carry the secret into either
    /// deploy-log sink. We assert on the REAL sink output — the exact `(stderr,
    /// event)` strings produced by `format_deploy_log_line`, the single seam both
    /// `eprintln!` and the event emit consume — not on `sanitize()` in isolation,
    /// so a future change that bypasses the seam fails this test.
    #[test]
    fn deploy_log_seam_redacts_password_before_both_sinks() {
        let secret = "S3cr3t";
        let message = format!("password = \"{secret}\"");

        let (stderr_line, event_message) = format_deploy_log_line("info", &message);

        assert!(
            !stderr_line.contains(secret),
            "stderr sink leaked the password: {stderr_line}"
        );
        assert!(
            !event_message.contains(secret),
            "deploy-log event sink leaked the password: {event_message}"
        );
    }

    /// The seam must not mangle ordinary (non-secret) log lines — sanitize is a
    /// no-op on lines that are not `key = value`-shaped, and the stderr prefix
    /// stays byte-identical so nothing scraping stderr/percent-parsing changes.
    #[test]
    fn deploy_log_seam_preserves_plain_lines() {
        let (stderr_line, event_message) =
            format_deploy_log_line("info", "Installing systemd unit 60%");

        assert_eq!(stderr_line, "[deploy-log] [info] Installing systemd unit 60%");
        assert_eq!(event_message, "Installing systemd unit 60%");
    }

    // ── WIZARD-06 / D-01: enable_firewall / enable_fail2ban serde defaults ──

    /// D-01: a deploy payload that OMITS the two hardening keys must still default
    /// them to ON — a legacy wizard (pre-WIZARD-06) that never sends them must STILL
    /// provision ufw + fail2ban, not silently skip them. A payload that explicitly
    /// sends `false` must be honoured (operator opted out). This pins the
    /// `#[serde(default = "default_true")]` contract: missing → true, false → false.
    #[test]
    fn endpoint_settings_security_defaults() {
        // Minimal payload OMITTING enable_firewall / enable_fail2ban → both default ON.
        let omitted = r#"{
            "listenAddress": "0.0.0.0:443",
            "vpnUsername": "user",
            "vpnPassword": "secret",
            "certType": "letsencrypt",
            "domain": "vpn.example.com"
        }"#;
        let s: EndpointSettings = serde_json::from_str(omitted).expect("omitted payload deserializes");
        assert!(s.enable_firewall, "omitted enable_firewall must default to true (D-01)");
        assert!(s.enable_fail2ban, "omitted enable_fail2ban must default to true (D-01)");

        // Payload that explicitly opts OUT → both false (operator's choice honoured).
        let disabled = r#"{
            "listenAddress": "0.0.0.0:443",
            "vpnUsername": "user",
            "vpnPassword": "secret",
            "certType": "selfsigned",
            "domain": "",
            "enableFirewall": false,
            "enableFail2ban": false
        }"#;
        let s: EndpointSettings = serde_json::from_str(disabled).expect("disabled payload deserializes");
        assert!(!s.enable_firewall, "explicit enableFirewall=false must be honoured");
        assert!(!s.enable_fail2ban, "explicit enableFail2ban=false must be honoured");
    }

    // ── single-auth-method decision (D-06 — the auth-bleed root fix) ──

    /// D-06: an explicit "password" choice attempts ONLY the password — even if a
    /// key is ALSO present (the wizard's pre-fix bleed: both fields populated). This
    /// is the exact "key rejected even though the password works" scenario: with the
    /// fix, the key is never tried.
    #[test]
    fn auth_plan_password_attempts_password_only_even_with_key_present() {
        assert_eq!(
            auth_plan(Some("password"), /*has_key=*/ true, /*has_password=*/ true),
            AuthAttempt::PasswordOnly
        );
    }

    /// D-06: an explicit "key" choice attempts ONLY the key — even if a password is
    /// ALSO present. The backend never falls through to the password.
    #[test]
    fn auth_plan_key_attempts_key_only_even_with_password_present() {
        assert_eq!(
            auth_plan(Some("key"), /*has_key=*/ true, /*has_password=*/ true),
            AuthAttempt::KeyOnly
        );
    }

    /// Back-compat: an internal caller passing no auth_method keeps the legacy
    /// try-key-then-password sequence (so existing non-wizard flows are unchanged).
    #[test]
    fn auth_plan_none_is_legacy_sequence() {
        assert_eq!(
            auth_plan(None, true, true),
            AuthAttempt::LegacySequence
        );
        // An unrecognized value is treated conservatively as legacy, not a panic.
        assert_eq!(
            auth_plan(Some("bogus"), true, true),
            AuthAttempt::LegacySequence
        );
    }
}
