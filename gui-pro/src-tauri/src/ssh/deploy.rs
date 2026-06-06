use super::*;
use super::sanitize::*;

// CONF-M-05 (T-04-06 supply-chain) — install.sh is pinned to a specific release
// TAG and integrity-checked against a SHA-256 that is PINNED HERE IN THE REPO.
//
// Why an in-repo constant and not a remotely-served checksum: a checksum fetched
// from the same channel as the script (e.g. a sibling `install.sh.sha256` on the
// same CDN/repo) adds nothing — an attacker who can tamper with one can tamper
// with the other. Pinning the hash in our own source means a compromised upstream
// script no longer matches and the install aborts.
//
// HOW TO BUMP: when raising TRUSTTUNNEL_INSTALL_SH_TAG to a newer release, fetch
//   curl -fsSL https://raw.githubusercontent.com/TrustTunnel/TrustTunnel/<tag>/scripts/install.sh | sha256sum
// and update TRUSTTUNNEL_INSTALL_SH_SHA256 to the new value IN THE SAME COMMIT.
// The tag and the hash must always move together.
const TRUSTTUNNEL_INSTALL_SH_TAG: &str = "v1.0.33";
const TRUSTTUNNEL_INSTALL_SH_SHA256: &str =
    "40eddf99a1214b681ef4c2c6404262303e1980c963cbe0fbbf44b9beb2904d12";

/// Validate all user-supplied fields in EndpointSettings before building shell commands.
fn validate_endpoint_settings(settings: &EndpointSettings) -> Result<(), String> {
    validate_vpn_username(&settings.vpn_username)?;
    validate_vpn_password(&settings.vpn_password)?;
    validate_domain(&settings.domain)?;
    validate_email(&settings.email)?;
    validate_listen_address(&settings.listen_address)?;
    if !settings.cert_chain_path.is_empty() {
        validate_server_path(&settings.cert_chain_path)?;
    }
    if !settings.cert_key_path.is_empty() {
        validate_server_path(&settings.cert_key_path)?;
    }
    Ok(())
}

/// Build the shell command that directly creates all TrustTunnel config files.
/// This bypasses setup_wizard entirely (no TTY required).
pub(crate) fn build_configure_commands(settings: &EndpointSettings, sudo: &str) -> String {
    let dir = ENDPOINT_DIR;
    let hostname = if !settings.domain.is_empty() {
        settings.domain.clone()
    } else {
        "trusttunnel.local".to_string()
    };

    // 1. credentials.toml (escape backslashes for TOML)
    let escaped_user = settings.vpn_username.replace('\\', "\\\\");
    let escaped_pass = settings.vpn_password.replace('\\', "\\\\");
    let credentials = format!(
        r#"[[client]]
username = "{}"
password = "{}""#,
        escaped_user, escaped_pass
    );

    // 2. rules.toml (empty = allow all)
    let rules = r#"# No filtering rules — all connections allowed"#;

    // 3. vpn.toml (main settings)
    let vpn = format!(
        r#"listen_address = "{}"
ipv6_available = {}
ping_enable = {}
speedtest_enable = {}
allow_private_network_connections = false
tls_handshake_timeout_secs = 10
client_listener_timeout_secs = 600
connection_establishment_timeout_secs = 30
tcp_connections_timeout_secs = 604800
udp_connections_timeout_secs = 300
credentials_file = "credentials.toml"
rules_file = "rules.toml"

[listen_protocols]

[listen_protocols.http1]
upload_buffer_size = 32768

[listen_protocols.http2]
initial_connection_window_size = 8388608
initial_stream_window_size = 131072
max_concurrent_streams = 1000
max_frame_size = 16384
header_table_size = 65536

[listen_protocols.quic]
recv_udp_payload_size = 1350
send_udp_payload_size = 1350
initial_max_data = 104857600
initial_max_stream_data_bidi_local = 1048576
initial_max_stream_data_bidi_remote = 1048576
initial_max_stream_data_uni = 1048576
initial_max_streams_bidi = 4096
initial_max_streams_uni = 4096
max_connection_window = 25165824
max_stream_window = 16777216
disable_active_migration = true
enable_early_data = true
message_queue_capacity = 4096

[forward_protocol]
direct = {{}}"#,
        settings.listen_address,
        settings.ipv6_available,
        settings.ping_enable,
        settings.speedtest_enable,
    );

    // 4. hosts.toml (TLS certs — main hosts only, ping_hosts requires unique hostname)
    //
    // CONF-C-01 (new-installs-only, D-11): for the Let's Encrypt path, point cert
    // paths directly at certbot's managed `live/` symlink. certbot rotates the
    // symlink target on renewal, so TrustTunnel serves the fresh cert after a
    // graceful reload (SIGHUP) with NO local `cp` step — the spec's zero-copy /
    // zero-downtime design. Self-signed and provided-cert branches have no live/
    // directory, so they keep the local `certs/` copy paths.
    //
    // D-11: this is the GENERATOR (new installs) side only. Existing-server
    // migration to the live/ symlink is handled separately by Plan 02's
    // renew_cert self-heal — we do NOT migrate already-deployed servers here.
    let (cert_chain_path, private_key_path) = if settings.cert_type == "letsencrypt" {
        (
            format!("/etc/letsencrypt/live/{hostname}/fullchain.pem"),
            format!("/etc/letsencrypt/live/{hostname}/privkey.pem"),
        )
    } else {
        ("certs/cert.pem".to_string(), "certs/key.pem".to_string())
    };
    let hosts = format!(
        r#"[[main_hosts]]
hostname = "{hostname}"
cert_chain_path = "{cert_chain_path}"
private_key_path = "{private_key_path}""#
    );

    // Build the full shell script
    let email_flag = if !settings.email.is_empty() {
        format!("-m {}", settings.email)
    } else {
        "--register-unsafely-without-email".to_string()
    };
    let cert_cmd = match settings.cert_type.as_str() {
        "letsencrypt" => {
            // For Let's Encrypt: install certbot and get cert
            format!(
                r#"
# Install certbot and get Let's Encrypt certificate
if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    {sudo}apt-get -y -qq -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install certbot 2>/dev/null
elif command -v dnf >/dev/null 2>&1; then
    {sudo}dnf install -y -q certbot 2>/dev/null
elif command -v yum >/dev/null 2>&1; then
    {sudo}yum install -y -q certbot 2>/dev/null
fi
# Kill any lingering certbot processes and remove lock files
{sudo}pkill -9 certbot 2>/dev/null || true
{sudo}rm -f /tmp/.certbot.lock 2>/dev/null || true
sleep 1

# UAT 2026-05-20 — open 80/443 BEFORE certbot. Without this, a VPS with
# ufw=active + default deny INPUT (or upstream iptables policy DROP from
# cloud-init / provider preconfig) makes Let's Encrypt's external probe
# time out → `Timeout during connect` in challenge log → install fails.
# User-facing complaint: «домен правильный, я не спамлю Let's Encrypt,
# почему не работает». Answer: VPS firewall was silently dropping inbound 80.
#
# All ops are idempotent — safe to run on already-open ports:
#   • `ufw allow 80/tcp` writes the rule whether ufw is enabled or not.
#   • `iptables -C ... || -I ...` only inserts if the exact rule isn't
#     already present, so we don't grow the chain on every install retry.
#
# 443 is opened alongside because the endpoint will need it post-install
# (TLS listener) and we'd hit the same firewall on first connect anyway.
if command -v ufw >/dev/null 2>&1; then
  {sudo}ufw allow 80/tcp comment 'trusttunnel-acme' >/dev/null 2>&1 || true
  {sudo}ufw allow 443/tcp comment 'trusttunnel-tls' >/dev/null 2>&1 || true
fi
if command -v iptables >/dev/null 2>&1; then
  {sudo}iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || {sudo}iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
  {sudo}iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || {sudo}iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
fi

# CONF-H-02 — certbot issuance with webroot fallback.
# `--standalone` binds port 80 itself, so it fails ("port 80 already in use")
# on the common VPS layout where nginx/apache/caddy already serves :80. The
# spec (CERT_RENEWAL.md §Certificate Issuance Methods) says: standalone only
# when nothing occupies :80, otherwise webroot. We probe :80 first and pick:
#   • free  → --standalone (binds :80 directly)
#   • busy  → --webroot against the common docroots
# If both fail, surface a specific, actionable error.
if {sudo}ss -tlnp 2>/dev/null | grep -qE ':80[[:space:]]'; then
  echo "Port 80 is in use — attempting certbot --webroot fallback"
  tt_cert_ok=0
  for tt_webroot in /var/www/html /usr/share/nginx/html; do
    if [ -d "$tt_webroot" ]; then
      if {sudo}certbot certonly --webroot -w "$tt_webroot" -d {hostname} --non-interactive --agree-tos {email_flag}; then
        tt_cert_ok=1
        break
      fi
    fi
  done
  if [ "$tt_cert_ok" != "1" ]; then
    echo "SSH_CERTBOT_PORT80_BUSY: certbot could not issue a certificate — port 80 is occupied by another HTTP server and the webroot fallback failed. Temporarily stop your HTTP server (nginx/apache/caddy) and retry, or switch to a self-signed certificate." >&2
    exit 1
  fi
else
  {sudo}certbot certonly --standalone -d {hostname} --non-interactive --agree-tos {email_flag} --http-01-port 80
fi
# CONF-C-01: no local cp — hosts.toml points directly at the live/ symlink so
# certbot's renewal-time symlink rotation is served after a graceful reload.

# CONF-H-03 / A2 — ensure the systemd unit can reload (SIGHUP) so cert renewal
# is zero-downtime instead of restarting and dropping every VPN session.
# We provision ExecReload via a systemd DROP-IN (not an in-place edit of the
# shipped unit file) so we never mutate the upstream template:
#   /etc/systemd/system/trusttunnel.service.d/10-execreload.conf
# Rewriting the drop-in is idempotent (same bytes every run). We only create it
# when `systemctl show -p ExecReload` reports no ExecReload, then daemon-reload.
if [ -z "$({sudo}systemctl show trusttunnel -p ExecReload --value 2>/dev/null)" ]; then
  {sudo}mkdir -p /etc/systemd/system/trusttunnel.service.d
  {sudo}bash -c 'cat > /etc/systemd/system/trusttunnel.service.d/10-execreload.conf << '"'"'EXECRELOAD_EOF'"'"'
[Service]
ExecReload=/bin/kill -HUP $MAINPID
EXECRELOAD_EOF'
  {sudo}systemctl daemon-reload
fi

# Setup auto-renewal helper script — открывает 80 если UFW активен + закрыт,
# обновляет cert, закрывает 80. Без скрипта cron renewal провалится если
# user закрыл 80 в firewall (только manual «Обновить» через UI открывал).
# P UAT 2026-05-06: --no-random-sleep-on-renew не нужен в cron (cron сам
# распределяет load), но если user запустит script вручную — defaults sane.
# S-6 — RENEW_EOF is single-quoted so the heredoc body is written VERBATIM.
# No field in the body is expanded by the writing shell, which keeps the
# generated script structurally safe even if a future field is added here.
# Because the delimiter is now quoted, in-body shell variables ($opened_80)
# are NO LONGER escaped with a backslash — they reach the file as-is.
{sudo}bash -c 'cat > /usr/local/sbin/trusttunnel-cert-renew.sh << '"'"'RENEW_EOF'"'"'
#!/bin/bash
# Auto-generated by TrustTunnel deploy. Re-runs idempotent.
set -e
opened_80=0
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | head -1 | grep -q "active"; then
  if ! ufw status 2>/dev/null | grep -qE "^(80/tcp|80 )" ; then
    ufw allow 80/tcp comment "trusttunnel-cert-renewal" >/dev/null 2>&1 || true
    opened_80=1
  fi
fi
# CONF-H-03: deploy-hook issues a graceful reload (SIGHUP via ExecReload),
# never a restart — active VPN sessions survive cert renewal. No cp step:
# hosts.toml points at the live/ symlink, which certbot rotates in place.
certbot renew --quiet \
  --deploy-hook "systemctl reload trusttunnel" || true
if [ "$opened_80" = "1" ]; then
  ufw --force delete allow 80/tcp >/dev/null 2>&1 || true
fi
RENEW_EOF'
{sudo}chmod 755 /usr/local/sbin/trusttunnel-cert-renew.sh

# Cron entry — вызывает helper script. Раньше всё было inline в cron line
# (без open/close 80 → renewal провалится если firewall закрыл 80).
# S-6 — CRON_EOF single-quoted: body written verbatim, no shell expansion.
{sudo}bash -c 'cat > /etc/cron.d/trusttunnel-cert-renew << '"'"'CRON_EOF'"'"'
0 3 * * * root /usr/local/sbin/trusttunnel-cert-renew.sh
CRON_EOF'
"#
            )
        }
        "provided" => {
            // User-provided certificate — copy from specified paths on the server
            let chain = &settings.cert_chain_path;
            let key = &settings.cert_key_path;
            format!(
                r#"
# Use provided certificate files
{sudo}mkdir -p {dir}/certs
{sudo}cp {chain} {dir}/certs/cert.pem
{sudo}cp {key} {dir}/certs/key.pem
echo "Copied provided certificate files"
"#
            )
        }
        _ => {
            // Self-signed certificate via openssl
            format!(
                r#"
# Generate self-signed certificate
{sudo}mkdir -p {dir}/certs
{sudo}openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout {dir}/certs/key.pem -out {dir}/certs/cert.pem \
    -days 3650 -nodes -subj '/CN={hostname}'
"#
            )
        }
    };

    format!(
        r#"set -e

# Write config files
{sudo}tee {dir}/credentials.toml > /dev/null << 'CREDS_EOF'
{credentials}
CREDS_EOF

{sudo}tee {dir}/rules.toml > /dev/null << 'RULES_EOF'
{rules}
RULES_EOF

{sudo}tee {dir}/vpn.toml > /dev/null << 'VPN_EOF'
{vpn}
VPN_EOF

# CONF-H-06 — provision ICMP tunnelling. The endpoint only serves the `_icmp`
# pseudo-host when vpn.toml has an [icmp] section with a valid interface_name.
# Autodetect the default-route interface via a DEV-KEYWORD match so it is robust
# across distros where the interface is not at a fixed positional column (e.g.
# `default dev venet0 scope link` on some OpenVZ images breaks a fixed-column parse).
# Fall back to eth0 if the parse yields nothing. Appended after the heredoc so
# the autodetect runs server-side (the VPN_EOF heredoc is quoted = no expansion).
TT_ICMP_IFACE="$(ip route show default | awk '/default/ {{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}}' | head -1)"
[ -z "$TT_ICMP_IFACE" ] && TT_ICMP_IFACE="eth0"
{sudo}tee -a {dir}/vpn.toml > /dev/null << ICMP_EOF

[icmp]
interface_name = "$TT_ICMP_IFACE"
ICMP_EOF

{sudo}tee {dir}/hosts.toml > /dev/null << 'HOSTS_EOF'
{hosts}
HOSTS_EOF
{cert_cmd}
echo "Configuration files created successfully"
"#
    )
}

/// Build the pinned-tag, integrity-checked install.sh fetch+run command.
///
/// CONF-M-05 (T-04-06): pulls install.sh from `TRUSTTUNNEL_INSTALL_SH_TAG` (a
/// release tag, never `refs/heads/master`) and verifies it against the in-repo
/// `TRUSTTUNNEL_INSTALL_SH_SHA256` via `sha256sum -c` before executing. The temp
/// script is always removed, and a non-zero result surfaces a clear marker.
pub(crate) fn build_install_command(sudo: &str) -> String {
    let tag = TRUSTTUNNEL_INSTALL_SH_TAG;
    let expected_sha = TRUSTTUNNEL_INSTALL_SH_SHA256;
    format!(
        "curl -fsSL https://raw.githubusercontent.com/TrustTunnel/TrustTunnel/{tag}/scripts/install.sh -o /tmp/tt_install.sh \
         && echo '{expected_sha}  /tmp/tt_install.sh' | sha256sum -c - \
         && {sudo}sh /tmp/tt_install.sh -a y -v; \
         tt_rc=$?; rm -f /tmp/tt_install.sh; \
         if [ \"$tt_rc\" -ne 0 ]; then echo 'SSH_INSTALL_SH_INTEGRITY_OR_RUN_FAILED' >&2; fi; \
         exit $tt_rc"
    )
}

// ─── Deploy Sub-steps ──────────────────────────────

/// Check OS, architecture, root/sudo availability.
/// Returns the sudo prefix string ("" for root, "sudo " otherwise).
async fn deploy_check_env(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    emit_step(app, "check", "progress", "Checking server...");

    let (os_info, _) = exec_command(
        handle,
        app,
        "cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"' || echo 'Unknown OS'",
    )
    .await?;

    let (arch_info, _) = exec_command(handle, app, "uname -m").await?;

    // Check if running as root
    let sudo = detect_sudo(handle, app).await;
    let is_root = sudo.is_empty();

    let (whoami_out, _) = exec_command(handle, app, "whoami").await.unwrap_or_default();
    emit_log(
        app,
        "info",
        &format!(
            "Server: {} ({}) / user: {}",
            os_info.trim(),
            arch_info.trim(),
            whoami_out.trim()
        ),
    );

    if !is_root {
        // Check if sudo is available without password
        let (_, sudo_code) = exec_command(handle, app, "sudo -n true 2>/dev/null").await?;
        if sudo_code != 0 {
            let msg = "Root privileges required. Connect as root or configure passwordless sudo.";
            emit_step(app, "check", "error", msg);
            return Err(msg.into());
        }
    }

    emit_step(app, "check", "ok", "Server ready");

    Ok(sudo.to_string())
}

/// Update system packages (apt/dnf/yum).
async fn deploy_update_packages(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "update", "progress", "Updating system packages...");

    // UAT 2026-05-20 — `export VAR && {sudo}apt-get ...` does NOT propagate
    // VAR through sudo (env_reset strips it). On Ubuntu 24.04 that means
    // needrestart's TUI prompt fires and hangs the SSH channel → install
    // dies with SSH_CHANNEL_FAILED|Channel send error. Fix: elevate via
    // `{sudo}bash -c '...'` FIRST, then export envs inside the elevated
    // shell so they reach every apt-get / dpkg invocation.
    let update_cmd = format!(
        "if command -v apt-get >/dev/null 2>&1; then \
             {sudo}bash -c 'export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 APT_LISTCHANGES_FRONTEND=none; \
                apt-get update -qq && \
                apt-get -y -qq -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\" upgrade && \
                apt-get -y -qq -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\" install curl iptables'; \
         elif command -v dnf >/dev/null 2>&1; then \
             {sudo}dnf upgrade -y -q && \
             {sudo}dnf install -y -q curl iptables; \
         elif command -v yum >/dev/null 2>&1; then \
             {sudo}yum update -y -q && \
             {sudo}yum install -y -q curl iptables; \
         fi"
    );

    let (_, update_code) = exec_command(handle, app, &update_cmd).await?;

    if update_code != 0 {
        emit_log(app, "warn", "Failed to update packages. Continuing installation...");
    }

    emit_step(app, "update", "ok", "System updated");
    Ok(())
}

/// Download and install the TrustTunnel Endpoint binary.
async fn deploy_install_binary(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "install", "progress", "Installing TrustTunnel Endpoint...");

    // Stop existing service if running (ignore errors)
    let stop_cmd = format!("{sudo}systemctl stop trusttunnel 2>/dev/null; sleep 1; true");
    exec_command(handle, app, &stop_cmd).await.ok();

    // CONF-M-05 — fetch install.sh from a PINNED release tag (not refs/heads/master)
    // and verify it against the in-repo SHA-256 before running it. A breaking or
    // malicious upstream change to the script no longer silently reaches the server:
    // the `sha256sum -c` fails the install with a clear error instead.
    // Use -a y flag to auto-answer interactive prompts (built into the install script).
    let install_cmd = build_install_command(sudo);

    let (_, install_code) = exec_command(handle, app, &install_cmd).await?;

    if install_code != 0 {
        let msg = format!("Installation failed with error (code {install_code})");
        emit_step(app, "install", "error", &msg);
        return Err(msg);
    }

    // Verify installation
    let (_, verify_code) = exec_command(
        handle,
        app,
        &format!("test -f {dir}/setup_wizard && test -f {bin}", dir = ENDPOINT_DIR, bin = ENDPOINT_BINARY),
    )
    .await?;

    if verify_code != 0 {
        let msg = &format!("TrustTunnel files not found in {dir}/ after installation", dir = ENDPOINT_DIR);
        emit_step(app, "install", "error", msg);
        return Err(msg.into());
    }

    emit_step(app, "install", "ok", "TrustTunnel Endpoint installed");
    Ok(())
}

/// Create config files and TLS certificates, then run pre-flight check.
async fn deploy_configure(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    settings: &EndpointSettings,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "configure", "progress", "Creating Endpoint configuration...");

    // Validate domain for Let's Encrypt before attempting
    if settings.cert_type == "letsencrypt" {
        let domain = if !settings.domain.is_empty() {
            settings.domain.clone()
        } else {
            "trusttunnel.local".to_string()
        };
        let invalid = domain.ends_with(".local")
            || domain.ends_with(".localhost")
            || domain.ends_with(".test")
            || domain.ends_with(".example")
            || domain.ends_with(".invalid")
            || !domain.contains('.');
        if invalid {
            let msg = format!(
                "Let's Encrypt cannot issue a certificate for '{}'. Specify a public domain or choose a self-signed certificate.",
                domain
            );
            emit_step(app, "configure", "error", &msg);
            return Err(msg);
        }
    }

    validate_endpoint_settings(settings)?;
    let configure_cmd = build_configure_commands(settings, sudo);

    let (_, cfg_code) = exec_command(handle, app, &configure_cmd).await?;

    if cfg_code != 0 {
        let msg = "SSH_CONFIG_CREATE_FAILED";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }

    // Verify certs were created. CONF-C-01: for the Let's Encrypt path the cert
    // lives at certbot's live/ symlink (no local certs/ copy), so verify the
    // live/ path instead of certs/. Self-signed / provided-cert keep certs/.
    let cert_check_cmd = if settings.cert_type == "letsencrypt" {
        let hostname = if !settings.domain.is_empty() {
            settings.domain.clone()
        } else {
            "trusttunnel.local".to_string()
        };
        format!(
            "test -f /etc/letsencrypt/live/{hostname}/fullchain.pem && test -f /etc/letsencrypt/live/{hostname}/privkey.pem && echo OK"
        )
    } else {
        format!(
            "test -f {dir}/certs/cert.pem && test -f {dir}/certs/key.pem && echo OK",
            dir = ENDPOINT_DIR
        )
    };
    let (cert_check, cert_code) = exec_command(handle, app, &cert_check_cmd).await?;

    if cert_code != 0 || !cert_check.contains("OK") {
        let msg = "Certificates were not created. Check logs (openssl/certbot).";
        emit_step(app, "configure", "error", msg);
        return Err(msg.into());
    }
    emit_log(app, "info", "Certificates created");

    // Pre-flight: run endpoint briefly to verify config is valid
    let (preflight, _preflight_code) = exec_command(
        handle, app,
        &format!("cd {dir} && timeout 2 {sudo}./{svc} vpn.toml hosts.toml 2>&1 || true", dir = ENDPOINT_DIR, svc = ENDPOINT_SERVICE)
    ).await?;
    emit_log(app, "debug", &format!("Pre-flight output: {preflight}"));

    // Check for fatal config errors (but ignore timeout exit which is expected)
    if preflight.to_lowercase().contains("error") && preflight.to_lowercase().contains("pars") {
        let msg = format!("SSH_ENDPOINT_CONFIG_ERROR|{}", preflight.trim());
        emit_step(app, "configure", "error", &msg);
        return Err(msg);
    }

    emit_step(app, "configure", "ok", "Endpoint configuration created and verified");
    Ok(())
}

/// Set up and start the systemd service, verify it is running.
async fn deploy_start_service(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    settings: &EndpointSettings,
    sudo: &str,
) -> Result<(), String> {
    emit_step(app, "service", "progress", "Starting service...");

    // UAT 2026-05-20 — `systemctl stop` alone is NOT enough on retry:
    //   1) `systemctl enable --now` re-enables auto-start on daemon-reload, and
    //      if the previous install left the unit `Restart=on-failure RestartSec=3`,
    //      the old binary is back inside 3s — still holding port 443.
    //   2) A stale endpoint process can outlive the unit (e.g. crash-loop kill -9).
    //
    // Result: new install boots, tries to bind 443 → "Address in use (os error 98)"
    // → systemd reports failure → wrapper mis-translates this as «Let's Encrypt
    // не смог выпустить сертификат» even though certbot succeeded earlier.
    //
    // Hard reset before install:
    //   • `stop` + `disable` the unit (kills auto-restart loop)
    //   • `pkill` any stale endpoint binary (in case it detached)
    //   • Poll `ss` until port 443 is actually free (max 5s)
    let preflight = format!(
        "{sudo}systemctl stop trusttunnel 2>/dev/null; \
         {sudo}systemctl disable trusttunnel 2>/dev/null; \
         {sudo}pkill -f trusttunnel_endpoint 2>/dev/null; \
         for i in 1 2 3 4 5; do \
           {sudo}ss -tlnp 2>/dev/null | grep -qE ':443[[:space:]]' || break; \
           sleep 1; \
         done; \
         true"
    );
    exec_command(handle, app, &preflight).await.ok();

    // Now copy template and start fresh.
    let service_cmds = format!(
        "cd {dir} && \
         {sudo}cp -f trusttunnel.service.template /etc/systemd/system/trusttunnel.service 2>/dev/null; \
         {sudo}systemctl daemon-reload && \
         {sudo}systemctl enable --now trusttunnel",
        dir = ENDPOINT_DIR
    );

    let (_, svc_code) = exec_command(handle, app, &service_cmds).await?;

    if svc_code != 0 {
        emit_log(app, "warn", "Failed to start systemd service. Manual setup may be needed.");
    }

    // Wait for service to start and verify it's running
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Check service status
    let (svc_status, _) = exec_command(
        handle, app,
        &format!("{sudo}systemctl is-active trusttunnel 2>&1")
    ).await?;
    let is_active = svc_status.trim() == "active";

    if !is_active {
        // Get journal logs to diagnose the issue
        let (journal, _) = exec_command(
            handle, app,
            &format!("{sudo}journalctl -u trusttunnel --no-pager -n 30 2>&1")
        ).await?;
        emit_log(app, "error", &format!("Service failed to start. Status: {}", svc_status.trim()));
        for line in journal.lines().take(30) {
            emit_log(app, "warn", line);
        }

        // UAT 2026-05-20 — port-conflict diagnostic.
        //
        // If endpoint died with "Address in use (os error 98)" the journal
        // tells us 443 is busy but NOT what's holding it. Without this the
        // ErrorStep hint can only guess "old TrustTunnel" — which is dead
        // wrong when the real culprit is nginx / apache / caddy.
        //
        // `ss -tlnp` output looks like:
        //   LISTEN 0  511  1.2.3.4:443  0.0.0.0:*  users:(("nginx",pid=163333,fd=5))
        // We emit it as `error` so ErrorStep's allText match catches the
        // process name and shows a tailored hint.
        let journal_lower = journal.to_lowercase();
        if journal_lower.contains("address in use") || journal_lower.contains("os error 98") {
            let (ss_out, _) = exec_command(
                handle, app,
                &format!("{sudo}ss -tlnp 2>/dev/null | grep -E ':(80|443)[[:space:]]' | head -10")
            ).await.unwrap_or((String::new(), -1));
            if !ss_out.trim().is_empty() {
                emit_log(app, "error", "Port-conflict diagnostic — process holding 80/443:");
                for line in ss_out.lines().take(10) {
                    emit_log(app, "error", line);
                }
            }
        }

        // Also check the service file contents for debugging
        let (svc_file, _) = exec_command(
            handle, app,
            "cat /etc/systemd/system/trusttunnel.service 2>&1"
        ).await?;
        emit_log(app, "debug", &format!("Service file:\n{svc_file}"));

        // Check what config files exist
        let (ls_output, _) = exec_command(
            handle, app,
            &format!("ls -la {dir}/*.toml {dir}/certs/ 2>&1", dir = ENDPOINT_DIR)
        ).await?;
        emit_log(app, "debug", &format!("Config files:\n{ls_output}"));

        let msg = "TrustTunnel Endpoint failed to start. Check logs for diagnostics.";
        emit_step(app, "service", "error", msg);
        return Err(msg.into());
    }

    // Check if the port is actually listening
    let listen_port = settings.listen_address.split(':').next_back().unwrap_or("443");
    let (port_check, _) = exec_command(
        handle, app,
        &format!("ss -tlnp | grep :{listen_port} || echo 'PORT_NOT_LISTENING'")
    ).await?;

    if port_check.contains("PORT_NOT_LISTENING") {
        emit_log(app, "warn", &format!("Port {listen_port} is not listening yet. The service may need more time."));
    } else {
        emit_log(app, "info", &format!("Port {listen_port} is listening"));
    }

    emit_step(app, "service", "ok", "Service started and running");
    Ok(())
}

/// Export client config from the endpoint binary and save it locally.
/// Returns the path to the saved config file.
async fn deploy_export_config(
    handle: &client::Handle<SshHandler>,
    app: &tauri::AppHandle,
    params: &SshParams,
    settings: &EndpointSettings,
    sudo: &str,
) -> Result<String, String> {
    emit_step(app, "export", "progress", "Generating client config...");

    // Use the endpoint's own export to get proper config with certificate PEM.
    // S-4: the export_address is interpolated unquoted into the `-a {addr}` shell
    // arg. settings.domain is already whitelist-validated by validate_endpoint_settings;
    // params.host (operator-typed SSH host) is NOT, so when it is used as the
    // address we whitelist-validate it first (CLAUDE.md SAFETY-01, whitelist-first).
    let export_address = if !settings.domain.is_empty() {
        format!("{}:{}", settings.domain, settings.listen_address.split(':').next_back().unwrap_or("443"))
    } else {
        validate_ssh_host(&params.host)
            .map_err(|e| format!("SSH_EXPORT_INVALID_HOST|{e}"))?;
        let port = settings.listen_address.split(':').next_back().unwrap_or("443");
        format!("{}:{port}", params.host)
    };

    let export_cmd = format!(
        "cd {dir} && {sudo}./{svc} vpn.toml hosts.toml -c {user} -a {addr} --format toml 2>&1",
        dir = ENDPOINT_DIR,
        svc = ENDPOINT_SERVICE,
        sudo = sudo,
        user = settings.vpn_username,
        addr = export_address,
    );

    let (export_output, export_code) = exec_command(handle, app, &export_cmd).await?;

    if export_code != 0 || export_output.trim().is_empty() {
        emit_log(app, "error", &format!("Export failed (code {export_code}): {export_output}"));
        let msg = format!(
            "SSH_EXPORT_FAILED|{}|{}",
            export_code, settings.vpn_username
        );
        emit_step(app, "export", "error", &msg);
        return Err(msg);
    }

    // Extract only the TOML part (skip warning lines starting with timestamp or empty lines before TOML)
    let endpoint_section: String = export_output
        .lines()
        .skip_while(|l| !l.starts_with('#') && !l.starts_with("hostname"))
        .collect::<Vec<_>>()
        .join("\n");

    // Wrap with client-side settings
    let client_toml = build_client_config(&endpoint_section, "Generated by TrustTunnel Setup Wizard");

    emit_log(app, "debug", &format!("Generated client config:\n{client_toml}"));
    emit_step(app, "export", "ok", "Config generated");

    // ── Save config locally (portable — next to exe) ──
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

    Ok(config_path_str)
}

// ─── Main Deploy Function ──────────────────────────

pub async fn deploy_server(
    app: &tauri::AppHandle,
    params: SshParams,
    settings: EndpointSettings,
) -> Result<String, String> {
    // ── Step 1: SSH Connect + Authenticate ──
    emit_step(app, "connect", "progress", "Connecting to server...");
    let handle = params.connect_with_app(app.clone()).await
        .inspect_err(|e| { emit_step(app, "connect", "error", e); })?;
    emit_step(app, "connect", "ok", "Connected to server");
    emit_step(app, "auth", "ok", "Authentication successful");

    // ── Step 2: Check environment ──
    let sudo = deploy_check_env(&handle, app).await?;

    // ── Step 3: Update system packages ──
    deploy_update_packages(&handle, app, &sudo).await?;

    // ── Step 4: Install TrustTunnel Endpoint ──
    deploy_install_binary(&handle, app, &sudo).await?;

    // ── Step 5: Create config files + TLS certs ──
    deploy_configure(&handle, app, &settings, &sudo).await?;

    // ── Step 6: Start systemd service ──
    deploy_start_service(&handle, app, &settings, &sudo).await?;

    // ── Step 7: Export client config + save locally ──
    let config_path_str = deploy_export_config(&handle, app, &params, &settings, &sudo).await?;

    // ── Disconnect ──
    handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .ok();

    emit_step(app, "done", "ok", "All done! Server configured and running.");

    Ok(config_path_str)
}

pub async fn diagnose_server(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<String, String> {
    let handle = params.connect_with_app(app.clone()).await?;

    let mut report = String::new();

    // Service status
    let (status, _) = exec_command(&handle, app, "systemctl is-active trusttunnel 2>&1").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("Service status: {}\n", status.trim()));

    // Journal logs
    let (journal, _) = exec_command(&handle, app, "journalctl -u trusttunnel --no-pager -n 30 2>&1").await
        .unwrap_or(("no logs".into(), -1));
    report.push_str(&format!("\n=== Journal (last 30 lines) ===\n{journal}\n"));

    // Port check
    let (ports, _) = exec_command(&handle, app, "ss -tlnp 2>&1 | head -20").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== Listening ports ===\n{ports}\n"));

    // Config files
    let (ls, _) = exec_command(&handle, app, &format!("ls -la {dir}/ 2>&1", dir = ENDPOINT_DIR)).await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== {dir}/ ===\n{ls}\n", dir = ENDPOINT_DIR));

    // Service file
    let (svc, _) = exec_command(&handle, app, "cat /etc/systemd/system/trusttunnel.service 2>&1").await
        .unwrap_or(("unknown".into(), -1));
    report.push_str(&format!("\n=== Service file ===\n{svc}\n"));

    // vpn.toml
    let (vpn_cfg, _) = exec_command(&handle, app, &format!("cat {cfg} 2>&1", cfg = ENDPOINT_CONFIG)).await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== vpn.toml ===\n{vpn_cfg}\n"));

    // hosts.toml
    let (hosts_cfg, _) = exec_command(&handle, app, &format!("cat {dir}/hosts.toml 2>&1", dir = ENDPOINT_DIR)).await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== hosts.toml ===\n{hosts_cfg}\n"));

    // Certs
    let (certs, _) = exec_command(&handle, app, &format!("ls -la {dir}/certs/ 2>&1", dir = ENDPOINT_DIR)).await
        .unwrap_or(("not found".into(), -1));
    report.push_str(&format!("\n=== Certs ===\n{certs}\n"));

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    Ok(report)
}

// ═══════════════════════════════════════════════════════════════
//   Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn test_settings() -> EndpointSettings {
        EndpointSettings {
            listen_address: "0.0.0.0:443".to_string(),
            vpn_username: "testuser".to_string(),
            vpn_password: "testpass".to_string(),
            cert_type: "selfsigned".to_string(),
            domain: "example.com".to_string(),
            client_name: "testclient".to_string(),
            email: "test@example.com".to_string(),
            ping_enable: false,
            speedtest_enable: false,
            ipv6_available: true,
            cert_chain_path: String::new(),
            cert_key_path: String::new(),
        }
    }

    #[test]
    fn test_backslash_escaping() {
        let mut settings = test_settings();
        settings.vpn_username = r"domain\user".to_string();
        settings.vpn_password = r"pass\word".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains(r"domain\\user"), "username backslash not escaped");
        assert!(output.contains(r"pass\\word"), "password backslash not escaped");
    }

    #[test]
    fn test_heredoc_uses_quoted_delimiter() {
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("<< 'CREDS_EOF'"), "heredoc delimiter not quoted");
    }

    #[test]
    fn test_letsencrypt_cert_type() {
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("certbot"), "letsencrypt should use certbot");
    }

    #[test]
    fn test_selfsigned_cert_type() {
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("openssl req"), "selfsigned should use openssl");
    }

    #[test]
    fn test_letsencrypt_hosts_toml_points_at_live_symlink() {
        // CONF-C-01: LE hosts.toml must reference certbot's live/ symlink, not
        // a local certs/ copy — so renewal-time symlink rotation is served after
        // a graceful reload with no cp step.
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        settings.domain = "vpn.example.com".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(
            output.contains("/etc/letsencrypt/live/vpn.example.com/fullchain.pem"),
            "LE hosts.toml should point cert_chain at the live/ symlink"
        );
        assert!(
            output.contains("/etc/letsencrypt/live/vpn.example.com/privkey.pem"),
            "LE hosts.toml should point private_key at the live/ symlink"
        );
        // The LE path must NOT keep a local cp of the cert into certs/.
        assert!(
            !output.contains("cp /etc/letsencrypt/live/vpn.example.com/fullchain.pem"),
            "LE path should not cp cert into local certs/ (CONF-C-01)"
        );
    }

    #[test]
    fn test_selfsigned_hosts_toml_keeps_local_certs() {
        // Self-signed has no live/ dir — must keep the local certs/ paths.
        let settings = test_settings(); // cert_type = selfsigned
        let output = build_configure_commands(&settings, "sudo ");
        assert!(
            output.contains("cert_chain_path = \"certs/cert.pem\""),
            "self-signed hosts.toml should keep local certs/cert.pem"
        );
        assert!(
            output.contains("private_key_path = \"certs/key.pem\""),
            "self-signed hosts.toml should keep local certs/key.pem"
        );
        assert!(
            !output.contains("/etc/letsencrypt/live/"),
            "self-signed must not reference the LE live/ symlink"
        );
    }

    #[test]
    fn test_letsencrypt_renew_hook_reloads_not_restarts() {
        // CONF-H-03: the auto-renewal deploy-hook must issue a graceful reload
        // (SIGHUP), never a restart that drops active VPN sessions.
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(
            output.contains("--deploy-hook \"systemctl reload trusttunnel\""),
            "renew deploy-hook should reload, got: {output}"
        );
        assert!(
            !output.contains("systemctl restart trusttunnel"),
            "renew deploy-hook must not restart (drops sessions)"
        );
    }

    #[test]
    fn test_letsencrypt_provisions_execreload_via_dropin() {
        // A2 / CONF-H-03: ExecReload must be provisioned via a systemd drop-in
        // + daemon-reload, NOT an in-place edit of the shipped unit file.
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(
            output.contains("/etc/systemd/system/trusttunnel.service.d/10-execreload.conf"),
            "ExecReload should be provisioned via a service.d/ drop-in"
        );
        assert!(
            output.contains("ExecReload=/bin/kill -HUP $MAINPID"),
            "drop-in should define a MAINPID-guarded SIGHUP ExecReload"
        );
        assert!(
            output.contains("systemctl daemon-reload"),
            "drop-in write must be followed by daemon-reload"
        );
        // Must not mutate the upstream unit file in place.
        assert!(
            !output.contains(">> /etc/systemd/system/trusttunnel.service")
                && !output.contains(">>/etc/systemd/system/trusttunnel.service"),
            "must not append to the shipped unit file in place"
        );
    }

    #[test]
    fn test_vpn_toml_provisions_icmp_with_dev_keyword_autodetect() {
        // CONF-H-06: vpn.toml must gain an [icmp] section with an autodetected
        // interface_name, and the autodetect must use the dev-keyword match
        // (distro-robust), NOT the column-positional `awk '{print $5}'`.
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("[icmp]"), "vpn.toml should gain an [icmp] section");
        assert!(
            output.contains("interface_name = \"$TT_ICMP_IFACE\""),
            "[icmp] should set interface_name from the autodetected interface"
        );
        // Dev-keyword match — robust across distros.
        assert!(
            output.contains(r#"if($i=="dev")"#),
            "autodetect must use the dev-keyword match, got: {output}"
        );
        // Must NOT use the fragile column-positional approach.
        assert!(
            !output.contains("{print $5}") && !output.contains("{ print $5 }"),
            "autodetect must not use the column-positional awk '{{print $5}}'"
        );
        // Sensible fallback when the parse yields empty.
        assert!(
            output.contains(r#"TT_ICMP_IFACE="eth0""#),
            "autodetect should fall back to eth0 when parse is empty"
        );
    }

    #[test]
    fn test_letsencrypt_has_webroot_fallback_on_port80_busy() {
        // CONF-H-02: when :80 is occupied the certbot flow must fall back to
        // --webroot instead of failing opaquely on --standalone.
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        // Probes :80 occupancy before choosing an issuance method.
        assert!(
            output.contains("ss -tlnp") && output.contains(":80[[:space:]]"),
            "certbot flow should probe whether :80 is occupied"
        );
        // Webroot branch present with common docroots.
        assert!(
            output.contains("certbot certonly --webroot"),
            "certbot flow should have a --webroot fallback branch"
        );
        assert!(
            output.contains("/var/www/html") && output.contains("/usr/share/nginx/html"),
            "webroot fallback should try the common docroots"
        );
        // Standalone still used on the free-port path.
        assert!(
            output.contains("certbot certonly --standalone"),
            "standalone should still be used when :80 is free"
        );
        // Specific, actionable error when both methods fail.
        assert!(
            output.contains("SSH_CERTBOT_PORT80_BUSY"),
            "a specific port-80-busy error should be surfaced when issuance fails"
        );
    }

    #[test]
    fn test_install_command_pins_tag_not_master() {
        // CONF-M-05: install.sh must be fetched from a release tag, not master.
        let cmd = build_install_command("sudo ");
        assert!(
            !cmd.contains("refs/heads/master"),
            "install.sh must not be fetched from refs/heads/master"
        );
        assert!(
            cmd.contains(&format!(
                "TrustTunnel/TrustTunnel/{}/scripts/install.sh",
                TRUSTTUNNEL_INSTALL_SH_TAG
            )),
            "install.sh URL must be pinned to the release tag"
        );
    }

    #[test]
    fn test_install_command_verifies_in_repo_sha256() {
        // CONF-M-05: the integrity check must compare against the IN-REPO hash
        // constant via sha256sum -c (not a remotely-fetched checksum).
        let cmd = build_install_command("sudo ");
        assert!(
            cmd.contains(TRUSTTUNNEL_INSTALL_SH_SHA256),
            "integrity check must use the in-repo pinned SHA-256 constant"
        );
        assert!(
            cmd.contains("sha256sum -c -"),
            "integrity check must run sha256sum -c against the downloaded script"
        );
        // The hash must come from our own constant, not a sibling .sha256 download.
        assert!(
            !cmd.contains("install.sh.sha256"),
            "must not fetch the checksum from the same remote channel as the script"
        );
        // Pinned hash is a valid 64-char lowercase hex digest.
        assert_eq!(TRUSTTUNNEL_INSTALL_SH_SHA256.len(), 64);
        assert!(
            TRUSTTUNNEL_INSTALL_SH_SHA256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && (!c.is_alphabetic() || c.is_lowercase())),
            "pinned SHA-256 must be 64 lowercase hex chars"
        );
    }

    #[test]
    fn test_renew_and_cron_heredocs_are_single_quoted() {
        // S-6: RENEW_EOF and CRON_EOF delimiters must be single-quoted so a
        // future field added to the body cannot be shell-expanded by the writer.
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        // The helper scripts are written inside `bash -c '...'`, so the quoted
        // heredoc delimiter is emitted via the `'"'"'` single-quote-escape dance.
        // After the outer shell unquotes it, the cat sees `<< 'RENEW_EOF'`.
        assert!(
            output.contains(r#"<< '"'"'RENEW_EOF'"'"'"#),
            "RENEW_EOF delimiter must be single-quoted (via the '\"'\"' escape)"
        );
        assert!(
            output.contains(r#"<< '"'"'CRON_EOF'"'"'"#),
            "CRON_EOF delimiter must be single-quoted (via the '\"'\"' escape)"
        );
        // Guard against the un-quoted form ever coming back.
        assert!(
            !output.contains("<< RENEW_EOF") && !output.contains("<< CRON_EOF"),
            "delimiters must never be emitted unquoted"
        );
        // With a quoted delimiter the in-body var must NOT be backslash-escaped
        // (otherwise the literal `\$opened_80` would be written to the script).
        assert!(
            output.contains(r#"[ "$opened_80" = "1" ]"#),
            "in-body var must be unescaped under a quoted heredoc"
        );
        assert!(
            !output.contains(r#"\$opened_80"#),
            "in-body var must not keep the backslash escape"
        );
    }

    #[test]
    fn test_provided_cert_type() {
        let mut settings = test_settings();
        settings.cert_type = "provided".to_string();
        settings.cert_chain_path = "/etc/ssl/cert.pem".to_string();
        settings.cert_key_path = "/etc/ssl/key.pem".to_string();
        let output = build_configure_commands(&settings, "sudo ");
        assert!(output.contains("cp /etc/ssl/cert.pem"), "provided should copy cert");
        assert!(output.contains("cp /etc/ssl/key.pem"), "provided should copy key");
    }
}
