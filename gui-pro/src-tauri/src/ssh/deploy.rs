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

// 06-uat install-wizard slimming: the ICMP / IPv6 / Allow-private toggles were removed
// from the wizard UI (ICMP+IPv6 HIDDEN with the feature kept ON; Allow-private REMOVED).
// Their values are no longer user-driven — the safe defaults are hard-coded here so the
// generated vpn.toml is unchanged (icmp_enable = true, ipv6_available = true,
// allow_private_network_connections = false). A future need to expose them again would
// re-add the EndpointSettings fields + the wizard rows.
const ICMP_ENABLE_DEFAULT: bool = true;
const IPV6_AVAILABLE_DEFAULT: bool = true;
const ALLOW_PRIVATE_NETWORK_DEFAULT: bool = false;

// ─── Backend single-flight guard for deploy_server (06-uat cancel→reinstall race) ───
//
// Two concurrent deploy_server runs on the same server корёжат /opt/trusttunnel — run
// A's `configure` (cd /opt/trusttunnel, systemctl enable) interleaves with run B's
// `install` that re-creates the dir (the exact log the user reported). The frontend is
// single-flight, but a CANCELLED run's local future used to keep executing on the
// server. This static makes a second deploy_server STRUCTURALLY refuse to start until
// the first has fully unwound; the cancellable exec (exec_command_cancellable) releases
// it fast on cancel so a legitimate re-install is never locked out for long.
static DEPLOY_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// RAII release for `DEPLOY_IN_FLIGHT`: clears the flag on EVERY deploy_server exit path
/// (Ok, any `?` early-return, cancellation, or a panic unwind) so a failed/cancelled run
/// can never leave the guard stuck "busy".
struct DeployInFlightGuard;
impl Drop for DeployInFlightGuard {
    fn drop(&mut self) {
        DEPLOY_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Wait (bounded) until no `deploy_server` is in flight. `uninstall_server` (the cancel
/// rollback) calls this BEFORE its destructive `rm -rf /opt/trusttunnel` so the removal
/// can never race a still-running `configure` stage — the precise 06-uat signature
/// (configs written, then `cd /opt/trusttunnel` fails because uninstall removed the dir
/// mid-configure). `cancel_deploy` is fired first by the frontend, so the in-flight run
/// aborts within ~250 ms; this only confirms it. Best-effort: returns after `max_ms`
/// even if a run is somehow still active (the PID-group kill is the backstop).
pub(crate) async fn await_deploy_idle(max_ms: u64) {
    let mut waited = 0u64;
    while DEPLOY_IN_FLIGHT.load(std::sync::atomic::Ordering::SeqCst) && waited < max_ms {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        waited += 100;
    }
}

// install-wizard camouflage REMOVED: the `[reverse_proxy]` / decoy feature (both the AUTO
// local-decoy provisioning and the older MANUAL host:port reverse-proxy) was dropped — it
// does not work against the prebuilt core (v1.0.33). Its DECOY_* constants, the
// DECOY_SERVER_PY origin script, build_decoy_provision_block, the deploy_configure
// camouflage phase, the build_intended_vpn_toml `[reverse_proxy]` emission and the
// validate_endpoint_settings reverse-proxy gate were all removed together. The generated
// vpn.toml NEVER contains a `[reverse_proxy]` section.

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
    // D-10 (06-09): the 407/405 chooser is always enum-constrained (reuse the EXISTING
    // validate_auth_status_code — no duplicate validator, review C3).
    validate_auth_status_code(settings.auth_failure_status_code)?;
    // 06-uat install-wizard slimming: the Metrics + SOCKS5 settings (and their
    // validate_metrics_address / validate_socks5_address calls) were removed with those
    // wizard options. The reverse-proxy / camouflage settings (and their
    // validate_reverse_proxy_address / validate_url_path gate) were likewise removed —
    // that feature was dropped (it does not work on the prebuilt core v1.0.33). The
    // shared validate_url_path validator still exists for other callers; it is just no
    // longer called from here. validate_auth_status_code stays (407/405 chooser).
    Ok(())
}

/// Build the intended vpn.toml BASE content (without the server-side autodetected
/// `[icmp]` section, which is appended at deploy time). Pure fn so the divergence
/// detector and the writer agree on the same content (Codex #3, finding C).
///
/// D-09 (06-08): `ping_enable` and `speedtest_enable` are NO LONGER written. Both
/// were inert/dishonest (research §0/§2/§3) and are schema-Optional/default-false
/// per CONFIGURATION.md v1.0.33, so omitting them is valid — and re-adding an inert
/// line would re-introduce the dishonesty D-09 removes. The user-facing "ping"
/// control is now the `icmp_enable` gate on the `[icmp]` section (see
/// build_configure_commands). This is the FIRST round-2 schema break, so a re-deploy
/// against a pre-round-2 server (whose vpn.toml still carries those two lines) is
/// kept divergence-honest by `strip_legacy_feature_keys` (review C2).
pub(crate) fn build_intended_vpn_toml(settings: &EndpointSettings) -> String {
    // D-10 (06-09): `auth_failure_status_code` (top-level) is the 407/405 chooser,
    // enum-constrained by validate_auth_status_code (no free-text reaches here).
    //
    // 06-uat install-wizard slimming:
    // - `ipv6_available` is hard-coded from IPV6_AVAILABLE_DEFAULT (= true) — the IPv6
    //   toggle was hidden, the feature stays ON, so the written value is unchanged.
    // - `allow_private_network_connections` is hard-coded from ALLOW_PRIVATE_NETWORK_DEFAULT
    //   (= false, safe) — the Allow-private toggle was removed; this matches the original
    //   pre-06-09 hard-coded `= false` line, so LAN exposure is no longer opt-in.
    // - The Metrics (`[metrics]`) and SOCKS5 (`[forward_protocol.socks5]`) sections were
    //   removed with those wizard settings; egress is always the default direct mode.
    let toml = format!(
        r#"listen_address = "{}"
ipv6_available = {}
allow_private_network_connections = {}
auth_failure_status_code = {}
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
        IPV6_AVAILABLE_DEFAULT,
        ALLOW_PRIVATE_NETWORK_DEFAULT,
        settings.auth_failure_status_code,
    );
    // 06-uat install-wizard slimming: egress is always the default direct mode now (the
    // SOCKS5 alternative was removed with its wizard setting), so the `[forward_protocol]`
    // / `direct = {}` table is written unconditionally as part of the base TOML above. The
    // `[metrics]` section was likewise removed with the Metrics wizard setting.
    //
    // CAMOUFLAGE REMOVED: the `[reverse_proxy]` section (both the AUTO local-decoy branch
    // and the MANUAL user-supplied host:port branch) was dropped — the feature does not
    // work on the prebuilt core (v1.0.33). The generated vpn.toml therefore NEVER contains
    // a `[reverse_proxy]` section, and there is no longer any per-mode append below.
    toml
}

/// Build the intended hosts.toml content. Pure fn for the same divergence-compare
/// reason as `build_intended_vpn_toml`.
///
/// CONF-C-01 (new-installs-only, D-11): for the Let's Encrypt path, point cert
/// paths directly at certbot's managed `live/` symlink. certbot rotates the
/// symlink target on renewal, so TrustTunnel serves the fresh cert after a
/// graceful reload (SIGHUP) with NO local `cp` step. Self-signed / provided-cert
/// keep the local `certs/` copy paths.
pub(crate) fn build_intended_hosts_toml(settings: &EndpointSettings) -> String {
    let hostname = if !settings.domain.is_empty() {
        settings.domain.clone()
    } else {
        "trusttunnel.local".to_string()
    };
    let (cert_chain_path, private_key_path) = if settings.cert_type == "letsencrypt" {
        (
            format!("/etc/letsencrypt/live/{hostname}/fullchain.pem"),
            format!("/etc/letsencrypt/live/{hostname}/privkey.pem"),
        )
    } else {
        ("certs/cert.pem".to_string(), "certs/key.pem".to_string())
    };
    format!(
        r#"[[main_hosts]]
hostname = "{hostname}"
cert_chain_path = "{cert_chain_path}"
private_key_path = "{private_key_path}""#
    )
}

/// Strip the server-side-appended `[icmp]` section from a vpn.toml so a divergence
/// compare against the wizard's INTENDED base content does not false-positive on
/// the autodetected `interface_name` (which the writer appends at deploy time and
/// the intended-content helper deliberately omits). Returns everything before the
/// first `[icmp]` line, trimmed.
pub(crate) fn strip_icmp_section(vpn_toml: &str) -> String {
    match vpn_toml.find("[icmp]") {
        Some(idx) => vpn_toml[..idx].trim_end().to_string(),
        None => vpn_toml.trim_end().to_string(),
    }
}

/// Strip the legacy `ping_enable`/`speedtest_enable` assignment lines from an
/// EXISTING server vpn.toml before a divergence compare (C-05 / review C2, D-09).
///
/// 06-08 is the FIRST round-2 schema break: `build_intended_vpn_toml` no longer
/// emits those two keys. A pre-round-2 server still has them on disk, so an EXACT
/// trimmed compare in `deploy_configure` would false-positive a divergence and
/// dead-end a NORMAL reinstall on `SSH_CONFIG_DIVERGES`. We normalize the inert
/// legacy keys OUT of the existing side so they no longer count as divergence.
/// Applied to a COPY used only for the compare — never written back to the server,
/// so a malicious server file can at worst suppress a (correct) divergence=false on
/// these two inert keys (the intended behavior). Simple line-prefix match → no
/// regex backtracking. vpn.toml side only (the two keys never appear in hosts.toml).
pub(crate) fn strip_legacy_feature_keys(vpn_toml: &str) -> String {
    vpn_toml
        .lines()
        .filter(|line| {
            let t = line.trim_start();
            !t.starts_with("ping_enable") && !t.starts_with("speedtest_enable")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

/// Classify a FAILED configure command's captured output into a translatable
/// SSH_* code (06-14 C-06).
///
/// WHY: the install script writes a precise `SSH_CERTBOT_PORT80_BUSY:` marker to
/// stderr (deploy.rs build_configure_commands) when certbot cannot bind :80 and
/// the webroot fallback also fails. exec_command (mod.rs) MERGES stderr into the
/// returned String, so that marker is present in the captured configure output.
/// Previously deploy_configure discarded the output and returned the opaque
/// `SSH_CONFIG_CREATE_FAILED`, so the user saw a generic dead-end instead of the
/// actionable "switch to self-signed" path. This pure helper preserves the marker
/// as a dedicated code and otherwise falls back to the generic config-create code.
///
/// Pure (substring test only) — the server-controlled text is never executed,
/// re-interpolated into a shell command, or written to a file (T-06-42).
fn classify_configure_failure(output: &str) -> String {
    if output.contains("SSH_CERTBOT_PORT80_BUSY") {
        "SSH_CERTBOT_PORT80_BUSY".to_string()
    } else {
        "SSH_CONFIG_CREATE_FAILED".to_string()
    }
}

/// Classify a FAILED package-update command's captured output (06-14 C-14).
///
/// WHY: `deploy_update_packages` previously swallowed ANY apt/dnf failure into a
/// warn-and-continue, so a server busy with `unattended-upgrades` (a held dpkg
/// frontend lock) caused a confusing LATE failure further down the install. This
/// helper detects ONLY the held-lock case from the captured output and returns a
/// specific recoverable code; for any other (genuinely transient) update failure
/// it returns None so the existing warn-and-continue path is preserved (T-06-43).
///
/// Matches the stable apt/dpkg lock phrases (lowercased) so it is robust across
/// apt versions. Pure (substring test only) — server text never executed (T-06-42).
fn classify_update_failure(output: &str) -> Option<String> {
    let lower = output.to_lowercase();
    let lock_phrases = [
        "could not get lock",
        "unable to acquire",
        "dpkg frontend lock",
        "lock::timeout",
    ];
    if lock_phrases.iter().any(|p| lower.contains(p)) {
        Some("SSH_DPKG_LOCKED".to_string())
    } else {
        None
    }
}

/// Detect whether an existing server config file DIVERGES from the content the
/// wizard intends to write (Codex #3, round-2 finding C). Returns true when the
/// trimmed existing content differs from the trimmed intended content.
///
/// D-02: vpn.toml/hosts.toml are NEVER silently overwritten — divergence is
/// DETECTED here and surfaced as `configDiverges` so the 05-03 recovery fork can
/// offer an explicit "apply my settings" action; only an explicit
/// `overwrite_config` opt-in (carried by the real `deploy_server` command) rewrites
/// them. Trimming makes the compare resilient to trailing-newline noise from
/// different writers (tee vs editors).
pub(crate) fn config_diverges(existing: &str, intended: &str) -> bool {
    existing.trim() != intended.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// COCOON MANIFEST (06-16 C-18) — authoritative install-write ↔ uninstall-remove map
// ─────────────────────────────────────────────────────────────────────────────
//
// The redesign sells the install as a painless, TRACELESS, ownership-scoped
// experience: «Начать заново» must leave the server in a genuinely clean state —
// removing EVERYTHING we wrote and NOTHING we don't own. This manifest is the SINGLE
// SOURCE OF TRUTH for every server path the install can write, each cross-referenced
// to WHO removes it on uninstall. The `cocoon_manifest_symmetry_every_owned_path_is_
// removed` unit test (server_install.rs) asserts every OWNED path below appears in
// `build_uninstall_script`, so a future install-side write that forgets a matching
// removal fails CI — the C-15/C-16 drift class cannot silently recur. This list also
// feeds the D-18 «что будет удалено (только наше)» confirmation UI (built in 06-17).
//
// OWNED — written by us, removed on uninstall:
//   /opt/trusttunnel                                   (ENDPOINT_DIR — all config +
//                                                       certs/ + binaries; written via
//                                                       tee vpn.toml/hosts.toml/
//                                                       credentials.toml/rules.toml +
//                                                       openssl/cp certs/ in
//                                                       build_configure_commands)
//        └─ removed: build_uninstall_script Step 4  `rm -rfv /opt/trusttunnel`
//   /etc/systemd/system/trusttunnel.service            (systemd unit — upstream
//                                                       install.sh)
//        └─ removed: build_uninstall_script Step 3  `rm -f .../trusttunnel.service`
//   /etc/systemd/system/trusttunnel.service.d/10-execreload.conf
//                                                      (OUR zero-downtime ExecReload
//                                                       drop-in; mkdir -p + cat in the
//                                                       letsencrypt cert block above)
//        └─ removed: build_uninstall_script Step 3  `rm -rf .../trusttunnel.service.d`
//                    (C-15 — rm -rf the whole .d DIR, before daemon-reload)
//   /usr/local/sbin/trusttunnel-cert-renew.sh          (OUR cron cert-renew helper;
//                                                       cat + chmod 755 in the
//                                                       letsencrypt cert block above)
//        └─ removed: build_uninstall_script Step 6  `rm -fv /usr/local/sbin/trusttunnel*`
//                    (C-16 — was orphaned; Step 6 only swept /usr/local/bin + /usr/bin)
//   /etc/cron.d/trusttunnel-cert-renew                 (OUR cron entry; cat in the
//                                                       letsencrypt cert block above)
//        └─ removed: build_uninstall_script Step 5  `rm -f /etc/cron.d/trusttunnel-cert-renew`
//   /etc/letsencrypt/live/{host}, /etc/letsencrypt/archive/{host},
//   /etc/letsencrypt/renewal/{host}.conf               (LE cert STATE for OUR host;
//                                                       certbot certonly in the
//                                                       letsencrypt cert block above)
//        └─ removed: build_uninstall_extras Step 5b `certbot delete` + `rm -rf` of the
//                    live/archive/renewal entries for {host}
//   firewall ownership tags trusttunnel-acme (80/tcp), trusttunnel-tls (443/tcp),
//   trusttunnel-managed (iptables)                      (ufw `comment` + iptables
//                                                       `-m comment --comment`,
//                                                       inserted in the letsencrypt
//                                                       cert block above)
//        └─ removed: build_uninstall_extras Step 5c/5d — ufw delete-by-comment +
//                    iptables delete-by-tag (OWNERSHIP-SCOPED; never a broad delete)
//
// NOT OWNED — deliberately NOT removed (C-20 boundary):
//   apt PACKAGES certbot / curl / iptables are ADMIN-SHARED. Purging a package an
//   admin may rely on is an over-deletion violation. We remove only the host's cert
//   STATE + our own files; the shared tooling stays installed. `build_uninstall_script`
//   carries no `apt-get purge`/`apt purge`/`dpkg --purge` (asserted by
//   `uninstall_does_not_purge_admin_shared_apt_packages`).
//
// INVARIANT: install-writes(OWNED) ⊆ uninstall-removals. Add a new OWNED write here?
// Add its removal to build_uninstall_script/extras AND its path to the symmetry test's
// owned set — or CI goes red.
// ─────────────────────────────────────────────────────────────────────────────

/// Build the shell command that directly creates all TrustTunnel config files.
/// This bypasses setup_wizard entirely (no TTY required).
///
/// D-02 no-clobber (Codex #3/#12, round-2 finding C, round-3 LOW C):
/// - `credentials_exist=true` ⇒ the `credentials.toml` write is SKIPPED ENTIRELY,
///   ALWAYS — even when `overwrite_config=true`. Credentials are sacred: an
///   existing credentials.toml is never re-issued (an in-use VPN password must not
///   be clobbered). The skip is logged by the caller (`deploy_configure`).
/// - `overwrite_config=false` (default) ⇒ vpn.toml/hosts.toml are written for a
///   FRESH install (the divergence guard lives in `deploy_configure`, which only
///   calls this with `overwrite_config=true` once the user has opted in via the
///   05-03 "apply my settings" action — `deploy_server(overwrite_config=true)`,
///   the ONLY frontend overwrite surface; `deploy_configure` stays internal).
/// - `overwrite_config=true` ⇒ vpn.toml/hosts.toml ARE (re)written even if they
///   exist (the explicit overwrite path), but credentials.toml is STILL never
///   written when `credentials_exist=true`.
pub(crate) fn build_configure_commands(
    settings: &EndpointSettings,
    sudo: &str,
    credentials_exist: bool,
    overwrite_config: bool,
) -> String {
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

    // 3. vpn.toml (main settings) — extracted into a pure helper so the
    //    divergence detector (config_diverges) can compute the SAME intended
    //    content it writes (Codex #3, finding C).
    let vpn = build_intended_vpn_toml(settings);

    // 4. hosts.toml — extracted into a pure helper for the same divergence-compare
    //    reason.
    let hosts = build_intended_hosts_toml(settings);

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
    # UAT 2026-06-09 — WAIT for the apt/dpkg lock instead of failing instantly
    # (DPkg::Lock::Timeout). A fresh Ubuntu VPS runs its OWN unattended-upgrades /
    # apt-daily on boot (observed holding the lock as a low boot pid, e.g. 687),
    # and a cancelled prior run can orphan an apt-get too. Without the wait the
    # certbot install errored out (2>/dev/null swallowed it), certbot stayed
    # missing, and the cert step then failed as the opaque SSH_CONFIG_CREATE_FAILED.
    # Refresh the lists too: the update stage may have skipped on a held lock,
    # leaving no install candidate for certbot.
    {sudo}apt-get update -qq -o DPkg::Lock::Timeout=300 2>/dev/null || true
    {sudo}apt-get -y -qq -o DPkg::Lock::Timeout=300 -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' install certbot 2>/dev/null
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
# round-3 HIGH A: TAG the iptables openings with `-m comment --comment
# trusttunnel-managed` so uninstall ("Start over") can delete them by OWNERSHIP,
# not by port shape. A bare `iptables -D INPUT -p tcp --dport 80 -j ACCEPT` would
# ALSO match a pre-existing admin ACCEPT rule on port 80 and clobber the user's own
# firewall. The `-C` idempotence guard includes the SAME comment, so it only matches
# OUR tagged rule — re-running install never grows the chain. (ufw rules already
# carry their `trusttunnel-acme`/`trusttunnel-tls` comments above.)
if command -v iptables >/dev/null 2>&1; then
  {sudo}iptables -C INPUT -p tcp --dport 80 -j ACCEPT -m comment --comment trusttunnel-managed 2>/dev/null || {sudo}iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT -m comment --comment trusttunnel-managed 2>/dev/null || true
  {sudo}iptables -C INPUT -p tcp --dport 443 -j ACCEPT -m comment --comment trusttunnel-managed 2>/dev/null || {sudo}iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT -m comment --comment trusttunnel-managed 2>/dev/null || true
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

    // ── No-clobber credentials (D-02, Codex #12) ──
    // credentials.toml is SACRED — never re-written when it already exists, even
    // under overwrite_config. The caller (deploy_configure) emits a sanitized
    // warn-on-skip log when this branch is taken so an "my updated creds were
    // ignored on resume" complaint is debuggable. WR-04 / finding J: dynamically
    // generated UUID heredoc delimiters per write.
    let creds_delim = format!("CREDS_EOF_{}", uuid::Uuid::new_v4().simple());
    let credentials_block = if credentials_exist {
        // D-02: existing credentials.toml preserved — write nothing.
        String::new()
    } else {
        format!(
            "{sudo}tee {dir}/credentials.toml > /dev/null << '{creds_delim}'\n{credentials}\n{creds_delim}\n"
        )
    };

    // ── No-clobber vpn.toml/hosts.toml (D-02, Codex #3, finding C, round-3 LOW C) ──
    // vpn.toml/hosts.toml are written for a FRESH install (the divergence guard in
    // deploy_configure gates this) OR on an EXPLICIT overwrite_config opt-in carried
    // by the real deploy_server command (the 05-03 "apply my settings" path — there
    // is NO deploy_configure IPC). When neither applies the caller never reaches
    // here with the write; this builder always emits the writes it is asked for and
    // deploy_configure owns the decision of WHICH builder call to make.
    let rules_delim = format!("RULES_EOF_{}", uuid::Uuid::new_v4().simple());
    let vpn_delim = format!("VPN_EOF_{}", uuid::Uuid::new_v4().simple());
    let icmp_delim = format!("ICMP_EOF_{}", uuid::Uuid::new_v4().simple());
    let hosts_delim = format!("HOSTS_EOF_{}", uuid::Uuid::new_v4().simple());
    let _ = overwrite_config; // decision lives in deploy_configure; documented above.

    // 06-uat install-wizard slimming — the `[icmp]` section is written UNCONDITIONALLY.
    // The honest icmp_enable toggle (D-09 06-08) was HIDDEN from the wizard, but the
    // feature stays ON: ICMP_ENABLE_DEFAULT (= true) is hard-coded so the SAME CONF-H-06
    // autodetect+tee-a block as before is always emitted (dev-keyword awk match + eth0
    // fallback, inside a heredoc — do NOT regress its contents). The `if` is kept against
    // the constant so re-exposing the toggle later only means restoring the field. The
    // generated vpn.toml is byte-for-byte unchanged from the previous default-ON path.
    let icmp_block = if ICMP_ENABLE_DEFAULT {
        format!(
            r#"# CONF-H-06 — provision ICMP tunnelling. The endpoint only serves the `_icmp`
# pseudo-host when vpn.toml has an [icmp] section with a valid interface_name.
# Autodetect the default-route interface via a DEV-KEYWORD match so it is robust
# across distros where the interface is not at a fixed positional column (e.g.
# `default dev venet0 scope link` on some OpenVZ images breaks a fixed-column parse).
# Fall back to eth0 if the parse yields nothing. Appended after the heredoc so
# the autodetect runs server-side (the VPN_EOF heredoc is quoted = no expansion).
TT_ICMP_IFACE="$(ip route show default | awk '/default/ {{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}}' | head -1)"
[ -z "$TT_ICMP_IFACE" ] && TT_ICMP_IFACE="eth0"
{sudo}tee -a {dir}/vpn.toml > /dev/null << {icmp_delim}

[icmp]
interface_name = "$TT_ICMP_IFACE"
{icmp_delim}
"#
        )
    } else {
        String::new()
    };

    // Record this configure stage's process group too — a cancel during the
    // certbot step must be able to stop exactly this group (05-UAT 2026-06-09).
    let pidrec = build_pidfile_record();
    format!(
        r#"set -e
{pidrec}
# 06-uat: fail fast (clear marker) if the install dir vanished mid-run — e.g. a racing
# uninstall_server rollback removed it while this configure was still running. Without
# the guard the config writes recreate a half-dir and the log reads as the confusing
# "configure before install" interleave the user reported.
[ -d {dir} ] || {{ echo "SSH_INSTALL_DIR_MISSING" >&2; exit 1; }}

# Write config files
{credentials_block}
{sudo}tee {dir}/rules.toml > /dev/null << '{rules_delim}'
{rules}
{rules_delim}

{sudo}tee {dir}/vpn.toml > /dev/null << '{vpn_delim}'
{vpn}
{vpn_delim}

{icmp_block}
{sudo}tee {dir}/hosts.toml > /dev/null << '{hosts_delim}'
{hosts}
{hosts_delim}
{cert_cmd}
echo "Configuration files created successfully"
"#
    )
}

/// Shell snippet recorded at the START of each long-running deploy stage. It
/// writes THIS stage's process-group id to /tmp/tt_deploy.pid so a later cancel
/// (uninstall_server's `build_stop_in_progress` preamble, 05-UAT 2026-06-09) can
/// TERM/KILL exactly this deploy's group — never the system's own apt /
/// unattended-upgrades. `ps -o pgid=` emits leading spaces, so `tr -dc 0-9`
/// strips everything but digits with no quoting (safe inside both a single-quoted
/// `bash -c '…'` body and a `set -e` script). Always succeeds (`|| true`).
pub(crate) fn build_pidfile_record() -> &'static str {
    "echo $(ps -o pgid= -p $$ | tr -dc 0-9) > /tmp/tt_deploy.pid 2>/dev/null || true"
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
    let pidrec = build_pidfile_record();
    format!(
        "{pidrec}; \
         curl -fsSL https://raw.githubusercontent.com/TrustTunnel/TrustTunnel/{tag}/scripts/install.sh -o /tmp/tt_install.sh \
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
            // 06-14 C-07: emit a translatable code instead of raw English so the
            // frontend renders friendly RU (translateSshError → sshErrors.rootRequired).
            let msg = "SSH_ROOT_REQUIRED";
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
    // build_pidfile_record records THIS stage's process group so a cancel can kill
    // exactly our apt run; `dpkg --configure -a` self-heals a dpkg left half-
    // configured by a PRIOR interrupted install (05-UAT 2026-06-09).
    let pidrec = build_pidfile_record();
    let update_cmd = format!(
        "if command -v apt-get >/dev/null 2>&1; then \
             {sudo}bash -c '{pidrec}; dpkg --configure -a 2>/dev/null || true; export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 APT_LISTCHANGES_FRONTEND=none; \
                apt-get update -qq -o DPkg::Lock::Timeout=300 && \
                apt-get -y -qq -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\" upgrade && \
                apt-get -y -qq -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=\"--force-confdef\" -o Dpkg::Options::=\"--force-confold\" install curl iptables'; \
         elif command -v dnf >/dev/null 2>&1; then \
             {sudo}dnf upgrade -y -q && \
             {sudo}dnf install -y -q curl iptables; \
         elif command -v yum >/dev/null 2>&1; then \
             {sudo}yum update -y -q && \
             {sudo}yum install -y -q curl iptables; \
         fi"
    );

    // 06-14 C-14: capture the update output so a held dpkg/apt lock can be detected
    // and surfaced as a specific recoverable code instead of being swallowed by the
    // generic warn-and-continue (which caused a confusing LATE failure when a server
    // was busy with unattended-upgrades). Only the lock case fails fast; any other
    // (transient) update failure keeps the existing warn-and-continue (T-06-43).
    // 06-uat: cancellable — a long apt/dpkg span must abort the instant the run is cancelled.
    let (update_out, update_code) = exec_command_cancellable(handle, app, &update_cmd).await?;

    if update_code != 0 {
        if let Some(code) = classify_update_failure(&update_out) {
            emit_step(app, "update", "error", &code);
            return Err(code);
        }
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

    // 06-uat: cancellable — the download+install.sh span must abort on cancel.
    let (_, install_code) = exec_command_cancellable(handle, app, &install_cmd).await?;

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
    overwrite_config: bool,
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

    // ── No-clobber probe (D-02, Codex #3/#12, finding C, round-3 LOW C) ──
    // Probe existing config artifacts BEFORE writing so the configure stage never
    // silently overwrites in-use server config:
    //   • credentials.toml: if present → SKIP the credential write ENTIRELY
    //     (ALWAYS, even under overwrite_config — credentials are sacred, D-02) and
    //     emit a SANITIZED warn-on-skip log so an "my updated creds were ignored on
    //     resume" complaint is debuggable (Codex #12). The message routes through
    //     emit_log → logging::sanitize and carries NO password (D-29).
    //   • vpn.toml/hosts.toml: if present AND the existing content DIVERGES from the
    //     intended content (config_diverges), do NOT overwrite by default — surface
    //     the divergence (the 05-03 recovery fork resolves it via an explicit
    //     deploy_server(overwrite_config=true), the ONLY frontend overwrite surface;
    //     deploy_configure stays internal). When overwrite_config=true the user has
    //     opted in, so we proceed to rewrite vpn.toml/hosts.toml (but never creds).
    let dir = ENDPOINT_DIR;
    let (creds_probe, _) = exec_command(
        handle, app,
        &format!("test -f {dir}/credentials.toml && echo TT_EXISTS || echo TT_MISSING"),
    ).await?;
    let credentials_exist = creds_probe.trim().contains("TT_EXISTS");
    if credentials_exist {
        // D-29: NO password in the message — pure status, routed through the
        // sanitized seam regardless.
        emit_log(
            app,
            "warn",
            "configure: existing credentials.toml preserved — UI credential edits NOT applied on resume (D-02 no-clobber)",
        );
    }

    // Detect vpn.toml/hosts.toml divergence (Codex #3, finding C). When they exist
    // and diverge from the intended content AND the user has NOT opted into an
    // explicit overwrite, refuse to silently rewrite — surface a clear, actionable
    // error the recovery fork (05-03) turns into the "apply my settings" action.
    if !overwrite_config {
        // Build the intended vpn/hosts content the same way build_configure_commands
        // does, to compare against what is already on the server.
        let intended_vpn = build_intended_vpn_toml(settings);
        let intended_hosts = build_intended_hosts_toml(settings);
        for (fname, intended) in [("vpn.toml", &intended_vpn), ("hosts.toml", &intended_hosts)] {
            let (existing_raw, _) = exec_command(
                handle, app,
                &format!("{sudo}cat {dir}/{fname} 2>/dev/null || echo ''"),
            ).await?;
            // For vpn.toml, normalize the existing content before comparing:
            //  (a) strip the server-appended [icmp] section so the autodetected
            //      interface_name does not false-positive a divergence, AND
            //  (b) strip the legacy ping_enable/speedtest_enable lines (D-09 / review
            //      C2) so a pre-round-2 server (whose vpn.toml still carries them)
            //      does not dead-end a NORMAL reinstall on SSH_CONFIG_DIVERGES — the
            //      new intended content no longer emits those keys (research §0/§2/§6).
            let existing = if fname == "vpn.toml" {
                strip_legacy_feature_keys(&strip_icmp_section(&existing_raw))
            } else {
                existing_raw.clone()
            };
            // Only a NON-EMPTY existing file that diverges blocks (an absent file is
            // a fresh write, not a clobber).
            if !existing.trim().is_empty() && config_diverges(&existing, intended) {
                let msg = format!(
                    "SSH_CONFIG_DIVERGES|{fname}|existing server config differs from the wizard's intended settings — apply your settings explicitly to overwrite (D-02)"
                );
                emit_step(app, "configure", "error", &msg);
                return Err(msg);
            }
        }
    }

    let configure_cmd = build_configure_commands(settings, sudo, credentials_exist, overwrite_config);

    // 06-14 C-06: capture the configure output (exec_command merges stderr, mod.rs)
    // so the install script's SSH_CERTBOT_PORT80_BUSY: marker is preserved and
    // classified into a translatable code instead of collapsing to the opaque
    // SSH_CONFIG_CREATE_FAILED. classify_configure_failure is a pure substring test.
    // 06-uat: cancellable — certbot can run for many seconds; a cancel here must stop it
    // (and the local future) BEFORE uninstall_server's rollback removes /opt/trusttunnel.
    let (cfg_out, cfg_code) = exec_command_cancellable(handle, app, &configure_cmd).await?;

    if cfg_code != 0 {
        let code = classify_configure_failure(&cfg_out);
        emit_step(app, "configure", "error", &code);
        return Err(code);
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
        // 06-14 C-07: translatable code → translateSshError → sshErrors.certNotCreated.
        let msg = "SSH_CERT_NOT_CREATED";
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

    // CAMOUFLAGE REMOVED: the AUTO local-decoy provisioning phase (its own progress step
    // that ran build_decoy_provision_block) was dropped together with the rest of the
    // camouflage / `[reverse_proxy]` feature — it does not work on the prebuilt core
    // (v1.0.33). deploy_configure now ends right after the configure step.

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
        // 06-uat: fail fast with a clear marker if the install dir is gone (racing
        // uninstall rollback) instead of the confusing "cd: No such file / Unit does not
        // exist" pair the user saw.
        "[ -d {dir} ] || {{ echo \"SSH_INSTALL_DIR_MISSING\" >&2; exit 1; }}; \
         cd {dir} && \
         {sudo}cp -f trusttunnel.service.template /etc/systemd/system/trusttunnel.service 2>/dev/null; \
         {sudo}systemctl daemon-reload && \
         {sudo}systemctl enable --now trusttunnel",
        dir = ENDPOINT_DIR
    );

    // 06-uat: cancellable — the systemctl enable span aborts on cancel.
    let (_, svc_code) = exec_command_cancellable(handle, app, &service_cmds).await?;

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

        // 06-uat install-wizard slimming: the C-11 metrics-bind diagnostic marker was
        // removed with the Metrics wizard setting (no metrics_enable/metrics_address to
        // key on; the matching ErrorStep hint + metrics_bind_hint i18n key were removed too).

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

        // 06-14 C-07: REUSE the existing SSH_SERVICE_START_FAILED code (translateSshError
        // → sshErrors.serviceStartFailed). The rich diagnostics emit_log lines ABOVE stay
        // unchanged (and the raw service status is shown behind «Подробнее»); only the
        // returned Err string becomes the translatable code so the LEAD sentence is RU.
        let msg = "SSH_SERVICE_START_FAILED";
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

/// Derive the LOCAL client-config filename from the first user's login (R1) using the
/// SAME branded convention the Save-As dialog defaults to: `[<CC>_]TrustTunnel_<login>.toml`.
///
/// This MUST stay byte-identical to the frontend reference
/// `buildConfigFileName(username, country)` (src/shared/utils/configFileName.ts) for the
/// same (username, country): the on-disk active config the install / Users-tab re-export
/// writes is then exactly the file the Save-As dialog offers by default, so the «Всё
/// готово» screen's shown path and the file on disk match the branded Save-As name.
///
/// UAT 2026-06-19: the wizard used to always write a fixed `trusttunnel_client.toml`,
/// so re-installing for a different user silently overwrote the previous user's saved
/// config (and could clobber the config the «Подключение» tab was pointed at). Branding
/// the file `TrustTunnel_<username>.toml` (optionally country-prefixed) makes per-user
/// configs coexist on disk, which — together with the conditional-activation gate on the
/// frontend (R2/R3) — means a fresh install never replaces an existing, different config.
///
/// Country prefix (mirrors normalizeCountry in the reference): when `country` is
/// `Some(c)` and `c` is EXACTLY two ASCII letters, prefix `<UPPERCASE_CC>_`. Any other
/// value (None, empty, wrong length, non-alpha) yields NO prefix — defensive so a junk
/// country can never corrupt the path. (The reference also accepts 3-letter codes; we
/// only emit the 2-letter shape that the callers actually pass, and a 3-letter value
/// simply produces no prefix here — still a valid, safe filename.)
///
/// Path-traversal safety: the result is ONLY ever JOINED as a bare filename onto the
/// config dir by the caller; it is never interpolated into a path string. `username`
/// reaches here already whitelist-validated by `validate_vpn_username` (no `/`, no `\`,
/// no whitespace, no shell metachars), so it cannot contain a separator — but this
/// helper is independently defensive:
///   - empty / degenerate username (only dots, e.g. "" or "." or "..") → fall back to
///     the legacy `trusttunnel_client` stem so we never produce a hidden/dotfile or a
///     traversal token as the whole name (fallback file stays `trusttunnel_client.toml`,
///     unchanged, with NO TrustTunnel_ branding and NO country prefix);
///   - a Windows reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, case-
///     insensitive) → suffix with `_` so the OS can actually create the file. With the
///     `TrustTunnel_` prefix the branded stem can never match a reserved name, but the
///     guard is kept defensively (it still applies to the degenerate fallback stem).
///
/// Returns the full filename including the `.toml` extension.
///
/// `pub(crate)`: also called by `ssh::server::server_config::fetch_server_config`
/// so an install-time deploy and a later Users-tab re-export both target the SAME
/// branded per-login file (UAT 2026-06-19 R1 — see onboarding.md). Keep the branding +
/// degenerate / Windows-reserved guards here as the single source of truth.
pub(crate) fn client_config_filename(username: &str, country: Option<&str>) -> String {
    const FALLBACK_STEM: &str = "trusttunnel_client";

    // Degenerate guard: empty, or a value made up only of dots ("." / ".." — which are
    // path tokens, not real names). validate_vpn_username already rejects path
    // separators, so we only have to defend against an all-dots / empty stem here.
    // A degenerate username keeps the legacy unbranded fallback (no TrustTunnel_ prefix,
    // no country) so the safe generic file is unchanged.
    let trimmed = username.trim();
    let degenerate = trimmed.is_empty() || trimmed.chars().all(|c| c == '.');
    let mut stem = if degenerate {
        FALLBACK_STEM.to_string()
    } else {
        // Branded stem, mirroring the frontend buildConfigFileName: an optional
        // `<UPPERCASE_CC>_` prefix (only for an exactly-two-ASCII-letter country) in
        // front of `TrustTunnel_<username>`. Any other country value → no prefix, so a
        // bad/short/None value never corrupts the name.
        let prefix = match country {
            Some(c) if c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) => {
                format!("{}_", c.to_ascii_uppercase())
            }
            _ => String::new(),
        };
        format!("{prefix}TrustTunnel_{trimmed}")
    };

    // Windows reserved device names cannot be used as a file stem regardless of
    // extension (`NUL.toml` still resolves to the NUL device). Compare case-insensitively
    // against the stem only; append `_` to disambiguate when matched.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
        "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
        "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&stem)) {
        stem.push('_');
    }

    format!("{stem}.toml")
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

    // UAT 2026-06-19 (R1): name the client config after the first user's login so a
    // re-install for a DIFFERENT user can never silently clobber an existing config.
    // The name uses the BRANDED `[<CC>_]TrustTunnel_<login>.toml` convention so the
    // on-disk active config equals the Save-As dialog default (the «Всё готово» path and
    // the file on disk match the branded Save-As name). `vpn_username` is whitelist-
    // validated (sanitize.rs validate_vpn_username — no path separators, no whitespace,
    // no shell metachars), and we JOIN a BARE filename onto config_dir (never interpolate
    // into a path string), so this cannot path-traverse. `client_config_filename` adds
    // the empty/degenerate + Windows reserved-name guards and ignores a malformed
    // country. country_code is the best-effort GeoIP code threaded from the frontend
    // (None when unknown → no prefix). See memory/v3/screens/onboarding.md.
    let client_config_path = config_dir.join(client_config_filename(
        &settings.vpn_username,
        settings.country_code.as_deref(),
    ));
    std::fs::write(&client_config_path, &client_toml)
        .map_err(|e| format!("SSH_WRITE_CONFIG_FAILED|{e}"))?;

    let config_path_str = client_config_path.to_string_lossy().to_string();
    emit_log(app, "info", &format!("Config saved: {config_path_str}"));
    emit_step(app, "save", "ok", "Configuration saved");

    Ok(config_path_str)
}

// ─── Main Deploy Function ──────────────────────────

/// Deploy (install + configure + start + export) TrustTunnel onto a server.
///
/// `overwrite_config` (round-3 LOW C, finding C): the ONLY frontend overwrite
/// surface. Default false → a fresh-install configure that REFUSES to silently
/// overwrite divergent vpn.toml/hosts.toml (it errors with SSH_CONFIG_DIVERGES so
/// the 05-03 recovery fork can offer "apply my settings"). The 05-03 action calls
/// `invoke("deploy_server", { ..., overwriteConfig: true })` to opt into rewriting
/// vpn.toml/hosts.toml. credentials.toml is NEVER overwritten regardless (D-02).
/// `deploy_configure` stays an INTERNAL stage fn — it is not a Tauri command.
/// WIZARD-06 / D-04: the install-time hardening gate, extracted as a pure fn so the
/// "provision only when the toggle is ON" contract is unit-testable without a live
/// `AppHandle`. Returns `(run_firewall, run_fail2ban)` straight from the deploy settings.
fn provision_plan(settings: &EndpointSettings) -> (bool, bool) {
    (settings.enable_firewall, settings.enable_fail2ban)
}

/// WIZARD-06 / D-04 (Open Q #1): port 80 stays open for the firewall ONLY on Let's-Encrypt
/// installs, where ACME HTTP-01 renewal needs it. Self-signed / operator-provided certs do
/// NOT renew over HTTP, so 80 stays closed. Pure fn so the derivation is unit-testable.
fn provision_keep_http_open(cert_type: &str) -> bool {
    cert_type == "letsencrypt"
}

pub async fn deploy_server(
    app: &tauri::AppHandle,
    params: SshParams,
    settings: EndpointSettings,
    overwrite_config: bool,
    // #22: the frontend's per-run generation. Stored as the active deploy op id so every
    // emit_step / emit_log below is stamped with it; the frontend drops any event whose
    // opId does not match the run it is currently showing — so a late event from a
    // cancelled run can never bleed into a fresh run's progress map.
    op_id: u64,
) -> Result<String, String> {
    // Layer 2 (06-uat): structural single-flight. Refuse a second deploy_server while one
    // is already running on this process, so two runs can NEVER race on the server. The
    // RAII guard releases the flag on every exit path (Ok / `?` / cancellation / panic).
    if DEPLOY_IN_FLIGHT
        .compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
        .is_err()
    {
        return Err("SSH_DEPLOY_IN_PROGRESS|another install is already running".to_string());
    }
    let _in_flight = DeployInFlightGuard;

    // Mark THIS run as the active deploy generation before the first event is emitted.
    super::set_deploy_op_id(op_id);
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

    // Layer 3 (06-uat): bail at every stage boundary too, so a cancel that lands between
    // stages (not inside a long exec) also stops before the next destructive stage.
    if super::deploy_superseded(op_id) { return Err("SSH_DEPLOY_CANCELLED|superseded".to_string()); }

    // ── Step 4: Install TrustTunnel Endpoint ──
    deploy_install_binary(&handle, app, &sudo).await?;

    if super::deploy_superseded(op_id) { return Err("SSH_DEPLOY_CANCELLED|superseded".to_string()); }

    // ── Step 5: Create config files + TLS certs ──
    // No-clobber + divergence-aware (D-02); overwrite_config carried from the
    // frontend deploy_server command (the only overwrite surface, round-3 LOW C).
    deploy_configure(&handle, app, &settings, &sudo, overwrite_config).await?;

    if super::deploy_superseded(op_id) { return Err("SSH_DEPLOY_CANCELLED|superseded".to_string()); }

    // ── Step 6: Start systemd service ──
    deploy_start_service(&handle, app, &settings, &sudo).await?;

    // A cancel that lands here must stop BEFORE we touch the firewall (Pitfall 5) — mirror
    // the existing stage-boundary bails so provisioning never runs on a superseded run.
    if super::deploy_superseded(op_id) { return Err("SSH_DEPLOY_CANCELLED|superseded".to_string()); }

    // ── Step 6.5: Optional server hardening (WIZARD-06 / D-04) ──
    // Reuse the EXISTING lockout-safe install_firewall / install_fail2ban on the already-open
    // handle (D-01). D-02: provisioning routes ONLY through install_firewall, which opens the
    // SSH port BEFORE `ufw --force enable` and tags rules — we NEVER add a bare `ufw enable`.
    // D-04: a firewall/fail2ban hiccup must NEVER brick the install — the protocol still works
    // even if hardening failed, so these calls are NON-blocking: on Err we emit a friendly
    // warn step + a secret-free skip log and CONTINUE to export. No `?`-propagation here.
    //
    // keep_http_open: port 80 must stay open ONLY on Let's-Encrypt installs (ACME HTTP-01
    // renewal). The configure stage already tagged 80/443 with trusttunnel-acme/trusttunnel-tls,
    // so install_firewall only ADDS the SSH-port + VPN-port allow rules (Open Q #1 resolved).
    let (run_firewall, run_fail2ban) = provision_plan(&settings);
    let keep_http_open = provision_keep_http_open(&settings.cert_type);
    if run_firewall || run_fail2ban {
        // post-UAT: surface a dedicated "security" PROGRESS step so the wizard never
        // shows a silent gap between "service" and "export" while apt installs
        // ufw/fail2ban (tens of seconds over SSH). Before this, install_firewall /
        // install_fail2ban emitted "security" events but "security" was absent from the
        // frontend STEPS_ORDER, so the progress map sat at "service" done → "тишина".
        emit_step(app, "security", "progress", "Setting up server protection...");
        let mut provision_failed = false;
        if run_firewall {
            if let Err(e) = install_firewall(app, &handle, params.port, keep_http_open).await {
                provision_failed = true;
                // Secret-free: interpolates only the error `e`; routed through emit_log's
                // logging::sanitize seam (D-29) like every other deploy log line.
                emit_log(app, "warn", &format!("firewall provision skipped: {e}"));
            }
        }
        if run_fail2ban {
            if let Err(e) = install_fail2ban(app, &handle).await {
                provision_failed = true;
                emit_log(app, "warn", &format!("fail2ban provision skipped: {e}"));
            }
        }
        // Deterministic FINAL status: a later sub-step's "ok" must not mask an earlier
        // failure, and an internal "error" emit must not leave the step looking fatal.
        // NON-blocking either way — we always continue to export (D-04): a hardening
        // hiccup never bricks the install, it just shows a warn on the step.
        if provision_failed {
            emit_step(app, "security", "warn", "SECURITY_PROVISION_PARTIAL");
        } else {
            emit_step(app, "security", "ok", "Server protection configured");
        }
    }
    // Neither toggle on → emit NOTHING for "security". The wizard hides the step
    // entirely when both toggles are off (DeployingStep filters STEPS_ORDER on
    // enableFirewall/enableFail2ban), so a phantom «Защита сервера ✓» never shows
    // when no protection was actually installed (post-UAT — visually misleading).

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
            email: "test@example.com".to_string(),
            cert_chain_path: String::new(),
            cert_key_path: String::new(),
            auth_failure_status_code: 407,
            country_code: None,
            // WIZARD-06 / D-01: default ON, mirroring the serde default_true. Tests that
            // need the OFF case override these explicitly.
            enable_firewall: true,
            enable_fail2ban: true,
        }
    }

    // ─── WIZARD-06 / D-04: install-time hardening provision contract ──────────

    /// D-04 gate: the Step 6.5 provision block calls install_firewall only when
    /// `enable_firewall` is ON and install_fail2ban only when `enable_fail2ban` is ON,
    /// each independently. `provision_plan` is the pure seam that the live block reads,
    /// so testing it pins ON→called / OFF→skipped without a live AppHandle.
    #[test]
    fn provision_plan_gates_each_toggle_independently() {
        let mut s = test_settings();

        s.enable_firewall = true;
        s.enable_fail2ban = true;
        assert_eq!(provision_plan(&s), (true, true), "both ON → both provisioned");

        s.enable_firewall = false;
        s.enable_fail2ban = false;
        assert_eq!(provision_plan(&s), (false, false), "both OFF → both skipped");

        // Independence: firewall ON, fail2ban OFF must not couple.
        s.enable_firewall = true;
        s.enable_fail2ban = false;
        assert_eq!(provision_plan(&s), (true, false), "toggles are independent");
    }

    /// D-04 / Open Q #1: keep_http_open is true ONLY for Let's-Encrypt installs (ACME
    /// HTTP-01 renewal needs port 80). Self-signed / operator-provided certs do not renew
    /// over HTTP, so 80 stays closed.
    #[test]
    fn provision_keep_http_open_only_for_letsencrypt() {
        assert!(provision_keep_http_open("letsencrypt"), "letsencrypt keeps port 80 open");
        assert!(!provision_keep_http_open("selfsigned"), "selfsigned does not keep 80 open");
        assert!(!provision_keep_http_open("provided"), "provided cert does not keep 80 open");
    }

    /// SAFETY-02 / D-29 spy: the Step 6.5 provision skip-log lines must never carry a
    /// secret. The live block interpolates ONLY the provisioning error `e` (a ufw/fail2ban
    /// command failure — never a credential) and emits via `emit_log`, which routes through
    /// `crate::logging::sanitize` (the SAME seam every deploy log line uses). This pins two
    /// things: (1) the templates themselves name no credential field, and (2) if a streamed
    /// `password = "…"` assignment line ever rode along in the error, the sanitize seam
    /// redacts it before it reaches either sink.
    #[test]
    fn provision_skip_logs_are_secret_free() {
        // (1) The format templates carry only the error `e` — no secret field name.
        let benign_err = "Unit ufw.service could not be found";
        let firewall_line = format!("firewall provision skipped: {benign_err}");
        let fail2ban_line = format!("fail2ban provision skipped: {benign_err}");
        for line in [&firewall_line, &fail2ban_line] {
            assert!(!line.to_lowercase().contains("password"), "template must not name a secret: {line}");
            assert!(!line.contains("vpn_password"), "template must not name a credential field: {line}");
        }

        // (2) Should a `password = "…"` assignment line ever be carried in the error and
        // streamed through emit_log, the sanitize seam redacts it (D-29). Model the real
        // streamed case: the assignment is its own line, exactly as cat'd config arrives.
        let secret = "S3cr3tP@ss";
        let streamed = format!("fail2ban provision skipped: failure\npassword = \"{secret}\"");
        let sanitized = crate::logging::sanitize(&streamed);
        assert!(
            !sanitized.contains(secret),
            "sanitize seam must redact a streamed password line in a provision log: {sanitized}"
        );
    }

    // ─── R1: client config filename derived from the first-user login ──────────
    // The output mirrors the frontend buildConfigFileName(username, country) so the
    // on-disk active config equals the branded Save-As default.
    #[test]
    fn client_config_filename_uses_branded_username() {
        // Normal logins map to the branded `TrustTunnel_<username>.toml` (no country).
        assert_eq!(client_config_filename("alice", None), "TrustTunnel_alice.toml");
        assert_eq!(
            client_config_filename("user-name_01", None),
            "TrustTunnel_user-name_01.toml"
        );
        assert_eq!(
            client_config_filename("user@domain.com", None),
            "TrustTunnel_user@domain.com.toml"
        );
    }

    #[test]
    fn client_config_filename_prefixes_valid_country() {
        // A valid 2-letter country code is UPPERCASED and prefixed:
        // `<CC>_TrustTunnel_<username>.toml`.
        assert_eq!(
            client_config_filename("alice", Some("DE")),
            "DE_TrustTunnel_alice.toml"
        );
        // Lowercase is normalized to uppercase (mirrors normalizeCountry).
        assert_eq!(
            client_config_filename("alice", Some("de")),
            "DE_TrustTunnel_alice.toml"
        );
    }

    #[test]
    fn client_config_filename_ignores_bad_country() {
        // Any non-2-ASCII-letter country yields NO prefix — a junk value must never
        // corrupt the name. (None already covered above.)
        assert_eq!(
            client_config_filename("alice", Some("bad")),
            "TrustTunnel_alice.toml"
        );
        assert_eq!(
            client_config_filename("alice", Some("")),
            "TrustTunnel_alice.toml"
        );
        // Wrong length / non-alpha shapes all fall through to no prefix.
        assert_eq!(
            client_config_filename("alice", Some("D")),
            "TrustTunnel_alice.toml"
        );
        assert_eq!(
            client_config_filename("alice", Some("D1")),
            "TrustTunnel_alice.toml"
        );
    }

    #[test]
    fn client_config_filename_falls_back_when_degenerate() {
        // Empty / whitespace / all-dots stems must NOT become a hidden dotfile or a
        // path-traversal token — fall back to the legacy UNBRANDED stem instead (no
        // TrustTunnel_ prefix, no country), so the safe generic file is unchanged.
        assert_eq!(client_config_filename("", None), "trusttunnel_client.toml");
        assert_eq!(client_config_filename("   ", None), "trusttunnel_client.toml");
        assert_eq!(client_config_filename(".", None), "trusttunnel_client.toml");
        assert_eq!(client_config_filename("..", None), "trusttunnel_client.toml");
        assert_eq!(client_config_filename("...", None), "trusttunnel_client.toml");
        // Even with a valid country, a degenerate username keeps the unbranded fallback.
        assert_eq!(client_config_filename("", Some("DE")), "trusttunnel_client.toml");
    }

    #[test]
    fn client_config_filename_never_traverses() {
        // Defense-in-depth: even if a separator somehow reached this helper (it cannot,
        // validate_vpn_username rejects `/` and `\`), the OUTPUT is a single filename
        // the caller joins onto the config dir — it must contain no separator and no
        // parent-dir token as the whole stem. We assert the common safe shapes hold,
        // including the country-prefixed shape.
        let f = client_config_filename("alice", None);
        assert!(!f.contains('/') && !f.contains('\\'), "filename must not contain a separator");
        assert!(f.ends_with(".toml"));
        let g = client_config_filename("alice", Some("DE"));
        assert!(!g.contains('/') && !g.contains('\\'), "filename must not contain a separator");
        assert!(g.ends_with(".toml"));
    }

    #[test]
    fn client_config_filename_guards_windows_reserved_names() {
        // The `TrustTunnel_` prefix means a branded stem can never equal a reserved
        // device name, so reserved usernames now produce the safe branded form (no `_`
        // suffix is needed — the stem is `TrustTunnel_CON`, not `CON`).
        assert_eq!(client_config_filename("CON", None), "TrustTunnel_CON.toml");
        assert_eq!(client_config_filename("nul", None), "TrustTunnel_nul.toml");
        assert_eq!(client_config_filename("Com1", None), "TrustTunnel_Com1.toml");
        assert_eq!(client_config_filename("LPT9", None), "TrustTunnel_LPT9.toml");
        // A username that merely CONTAINS a reserved word is likewise just branded.
        assert_eq!(client_config_filename("console", None), "TrustTunnel_console.toml");
        assert_eq!(client_config_filename("connor", None), "TrustTunnel_connor.toml");
    }

    #[test]
    fn test_backslash_escaping() {
        let mut settings = test_settings();
        settings.vpn_username = r"domain\user".to_string();
        settings.vpn_password = r"pass\word".to_string();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains(r"domain\\user"), "username backslash not escaped");
        assert!(output.contains(r"pass\\word"), "password backslash not escaped");
    }

    #[test]
    fn test_heredoc_uses_quoted_dynamic_delimiter() {
        // WR-04 / finding J: the credentials heredoc delimiter is now a
        // dynamically-generated UUID (CREDS_EOF_<uuid>), still single-quoted so the
        // writing shell performs no expansion. The static "CREDS_EOF" must be gone.
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains("<< 'CREDS_EOF_"), "credentials heredoc delimiter not a quoted dynamic delimiter");
        // The bare static delimiter must NOT appear (every write uses a uuid suffix).
        assert!(!output.contains("<< 'CREDS_EOF'"), "static CREDS_EOF delimiter must be replaced by a dynamic one");
    }

    #[test]
    fn test_letsencrypt_cert_type() {
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains("certbot"), "letsencrypt should use certbot");
    }

    #[test]
    fn test_selfsigned_cert_type() {
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains("openssl req"), "selfsigned should use openssl");
    }

    #[test]
    fn test_install_command_records_deploy_pgid() {
        // 05-UAT 2026-06-09 — the install stage records its process group to
        // /tmp/tt_deploy.pid so a cancel can stop exactly THIS deploy (never the
        // system's own apt / unattended-upgrades). Spaces from `ps -o pgid=` are
        // stripped with `tr -dc 0-9`.
        let cmd = build_install_command("sudo ");
        assert!(cmd.contains("/tmp/tt_deploy.pid"), "install cmd must record the deploy PGID");
        assert!(cmd.contains("ps -o pgid= -p $$"), "PGID is taken from the stage's own $$");
    }

    #[test]
    fn test_configure_command_records_deploy_pgid() {
        // The configure stage (cert step) must also record its PGID so a cancel
        // during certbot can stop it.
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains("/tmp/tt_deploy.pid"), "configure cmd must record the deploy PGID");
    }

    #[test]
    fn test_configure_command_has_install_dir_guard() {
        // 06-uat cancel→reinstall race: configure must fail FAST with a clear marker if
        // the install dir vanished mid-run (a racing uninstall rollback removed it),
        // instead of silently recreating a half-dir and producing the confusing
        // "configure before install" interleaved log.
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(
            output.contains("[ -d /opt/trusttunnel ]"),
            "configure must guard on the install dir existing"
        );
        assert!(
            output.contains("SSH_INSTALL_DIR_MISSING"),
            "configure must emit the classified marker when the dir is gone"
        );
        // The guard must come BEFORE the first config-file write so a missing dir aborts
        // before any half-write. Anchor on the rules.toml write (a stable, unambiguous
        // string that never appears in a comment).
        let guard_at = output.find("SSH_INSTALL_DIR_MISSING").unwrap();
        let first_write = output.find("rules.toml").unwrap();
        assert!(guard_at < first_write, "dir guard must precede the first config write");
    }

    #[test]
    fn test_deploy_single_flight_guard_blocks_second_run() {
        use std::sync::atomic::Ordering::SeqCst;
        // Start clean (no other --lib test runs a real deploy_server).
        DEPLOY_IN_FLIGHT.store(false, SeqCst);

        // First acquire succeeds.
        assert!(
            DEPLOY_IN_FLIGHT.compare_exchange(false, true, SeqCst, SeqCst).is_ok(),
            "first deploy acquires the single-flight guard"
        );
        {
            let _g = DeployInFlightGuard;
            // A concurrent second acquire is refused while the first holds it.
            assert!(
                DEPLOY_IN_FLIGHT.compare_exchange(false, true, SeqCst, SeqCst).is_err(),
                "second deploy is refused while one is in flight"
            );
        } // guard drops here → flag cleared
        assert!(
            !DEPLOY_IN_FLIGHT.load(SeqCst),
            "the RAII guard releases the flag on drop (every exit path)"
        );
        // After release a fresh deploy can acquire again.
        assert!(
            DEPLOY_IN_FLIGHT.compare_exchange(false, true, SeqCst, SeqCst).is_ok(),
            "a new deploy acquires after the prior one released"
        );
        DEPLOY_IN_FLIGHT.store(false, SeqCst); // leave clean
    }

    #[tokio::test]
    async fn test_await_deploy_idle_returns_immediately_when_idle() {
        use std::sync::atomic::Ordering::SeqCst;
        DEPLOY_IN_FLIGHT.store(false, SeqCst);
        // Must not hang when no deploy is running (uninstall's normal path).
        await_deploy_idle(1000).await;
        assert!(!DEPLOY_IN_FLIGHT.load(SeqCst));
    }

    #[test]
    fn test_letsencrypt_hosts_toml_points_at_live_symlink() {
        // CONF-C-01: LE hosts.toml must reference certbot's live/ symlink, not
        // a local certs/ copy — so renewal-time symlink rotation is served after
        // a graceful reload with no cp step.
        let mut settings = test_settings();
        settings.cert_type = "letsencrypt".to_string();
        settings.domain = "vpn.example.com".to_string();
        let output = build_configure_commands(&settings, "sudo ", false, false);
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
        let output = build_configure_commands(&settings, "sudo ", false, false);
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
        let output = build_configure_commands(&settings, "sudo ", false, false);
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
        let output = build_configure_commands(&settings, "sudo ", false, false);
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
        let output = build_configure_commands(&settings, "sudo ", false, false);
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
        let output = build_configure_commands(&settings, "sudo ", false, false);
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
    fn test_classify_configure_failure_detects_port80_marker() {
        // 06-14 C-06: the configure command's captured output (incl. merged stderr)
        // carries the SSH_CERTBOT_PORT80_BUSY: marker when certbot cannot bind :80.
        let marker_output =
            "some apt noise\nSSH_CERTBOT_PORT80_BUSY: certbot could not issue a certificate — port 80 is occupied\nmore noise";
        assert_eq!(
            classify_configure_failure(marker_output),
            "SSH_CERTBOT_PORT80_BUSY",
            "the port-80-busy marker must be preserved as its own code"
        );
    }

    #[test]
    fn test_classify_configure_failure_falls_back_to_generic() {
        // No marker → the opaque generic config-create code (unchanged behavior).
        assert_eq!(
            classify_configure_failure(""),
            "SSH_CONFIG_CREATE_FAILED",
            "empty output should fall back to the generic config-create code"
        );
        assert_eq!(
            classify_configure_failure("E: Unable to locate package foo"),
            "SSH_CONFIG_CREATE_FAILED",
            "an unrelated apt error should fall back to the generic code"
        );
    }

    #[test]
    fn test_classify_update_failure_detects_held_dpkg_lock() {
        // 06-14 C-14: a held dpkg/apt lock must surface a specific recoverable code.
        for phrase in [
            "E: Could not get lock /var/lib/dpkg/lock-frontend",
            "Unable to acquire the dpkg frontend lock",
            "dpkg frontend lock is held by process 1234",
            "Lock::Timeout exceeded waiting for the lock",
        ] {
            assert_eq!(
                classify_update_failure(phrase),
                Some("SSH_DPKG_LOCKED".to_string()),
                "held-lock phrase should map to SSH_DPKG_LOCKED: {phrase}"
            );
        }
    }

    #[test]
    fn test_classify_update_failure_preserves_warn_and_continue_for_non_lock() {
        // Non-lock update failures must return None so the existing warn-and-continue
        // path is preserved (only the lock case fails fast) — T-06-43.
        assert_eq!(
            classify_update_failure(""),
            None,
            "empty update output should not fail fast"
        );
        assert_eq!(
            classify_update_failure("W: Some packages could not be upgraded (transient)"),
            None,
            "a transient non-lock warning should keep warn-and-continue"
        );
    }

    #[test]
    fn test_deploy_emits_translatable_codes_not_raw_english() {
        // 06-14 C-07: the five raw-English deploy/install failures must be emitted as
        // SSH_* codes the frontend can translate. This guard asserts the exact code
        // strings are present in the source (string-assertion discipline mirroring
        // 04-03) and that the old raw-English LEAD strings are gone, so a regression
        // that reverts a code back to raw English fails this test.
        let src = include_str!("deploy.rs");
        for code in [
            "\"SSH_ROOT_REQUIRED\"",
            "\"SSH_CERT_NOT_CREATED\"",
            "\"SSH_SERVICE_START_FAILED\"",
        ] {
            assert!(
                src.contains(code),
                "deploy.rs must emit the translatable code {code}"
            );
        }
        // The old raw-English LEAD sentences must NOT be returned as Err strings.
        for raw in [
            "let msg = \"Root privileges required",
            "let msg = \"Certificates were not created",
            "let msg = \"TrustTunnel Endpoint failed to start",
        ] {
            assert!(
                !src.contains(raw),
                "deploy.rs must not return the raw-English LEAD string: {raw}"
            );
        }
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
        let output = build_configure_commands(&settings, "sudo ", false, false);
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
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains("cp /etc/ssl/cert.pem"), "provided should copy cert");
        assert!(output.contains("cp /etc/ssl/key.pem"), "provided should copy key");
    }

    // ── No-clobber credentials (D-02, Codex #12) ──────────────────────────

    #[test]
    fn test_fresh_install_writes_credentials() {
        // credentials_exist=false (fresh install) ⇒ the credential write IS present.
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(
            output.contains(&format!("tee {}/credentials.toml", ENDPOINT_DIR)),
            "fresh install must write credentials.toml"
        );
        assert!(output.contains("[[client]]"), "fresh install must write the [[client]] block");
        assert!(output.contains("password = "), "fresh install must write the password line");
    }

    #[test]
    fn test_existing_credentials_are_not_clobbered() {
        // credentials_exist=true ⇒ the credential write is SKIPPED ENTIRELY (D-02).
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", true, false);
        assert!(
            !output.contains(&format!("tee {}/credentials.toml", ENDPOINT_DIR)),
            "existing credentials.toml must NOT be re-written (D-02 no-clobber)"
        );
        assert!(
            !output.contains("[[client]]"),
            "no [[client]] block when credentials already exist"
        );
        // The OTHER config files are still written on a fresh-config path.
        assert!(output.contains(&format!("tee {}/vpn.toml", ENDPOINT_DIR)), "vpn.toml still written");
        assert!(output.contains(&format!("tee {}/hosts.toml", ENDPOINT_DIR)), "hosts.toml still written");
    }

    #[test]
    fn test_overwrite_config_still_never_writes_credentials_when_present() {
        // FINDING C / D-02: overwrite_config=true bypasses the vpn/hosts divergence
        // skip, but credentials_exist=true STILL means credentials are never written.
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", true, true);
        assert!(
            !output.contains("[[client]]"),
            "credentials.toml must NEVER be overwritten, even with overwrite_config=true"
        );
        // overwrite path still writes vpn.toml/hosts.toml (the "apply my settings"
        // path the 05-03 recovery action triggers).
        assert!(output.contains(&format!("tee {}/vpn.toml", ENDPOINT_DIR)), "overwrite writes vpn.toml");
        assert!(output.contains(&format!("tee {}/hosts.toml", ENDPOINT_DIR)), "overwrite writes hosts.toml");
    }

    // ── vpn.toml/hosts.toml divergence detection (Codex #3, finding C) ────

    #[test]
    fn test_config_diverges_detects_different_content() {
        assert!(config_diverges("a = 1\n", "a = 2\n"), "different content must diverge");
    }

    #[test]
    fn test_config_diverges_false_on_identical_content() {
        // Trim-resilient: trailing-newline-only differences are NOT divergence.
        assert!(!config_diverges("a = 1", "a = 1\n"), "identical content (modulo trim) must not diverge");
        assert!(!config_diverges("a = 1\n", "a = 1\n"), "identical content must not diverge");
    }

    #[test]
    fn test_strip_icmp_section_removes_appended_block() {
        // The server-appended [icmp] section must be removed before a divergence
        // compare so the autodetected interface_name does not false-positive.
        let with_icmp = "listen_address = \"0.0.0.0:443\"\n\n[icmp]\ninterface_name = \"eth0\"\n";
        let stripped = strip_icmp_section(with_icmp);
        assert!(!stripped.contains("[icmp]"), "[icmp] section must be stripped");
        assert!(stripped.contains("listen_address"), "base content must survive");
    }

    #[test]
    fn test_intended_vpn_toml_matches_what_configure_writes() {
        // The divergence detector compares against build_intended_vpn_toml, so it
        // must equal the base vpn content build_configure_commands writes.
        let settings = test_settings();
        let intended = build_intended_vpn_toml(&settings);
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(
            output.contains(&intended),
            "the intended vpn.toml base content must be exactly what configure writes"
        );
    }

    // ── D-09 (06-08): speedtest/ping_enable removal + icmp_enable gate ────

    #[test]
    fn test_vpn_toml_has_no_speedtest_enable() {
        // D-09: the inert speedtest_enable key must be gone from the generated config.
        let settings = test_settings();
        let vpn = build_intended_vpn_toml(&settings);
        assert!(
            !vpn.contains("speedtest_enable"),
            "vpn.toml must NOT contain speedtest_enable (D-09 removal)"
        );
    }

    #[test]
    fn test_vpn_toml_has_no_ping_enable() {
        // D-09: the now-meaningless ping_enable key must be gone (the [icmp] gate
        // replaces the user-facing ping control; the key is schema-optional).
        let settings = test_settings();
        let vpn = build_intended_vpn_toml(&settings);
        assert!(
            !vpn.contains("ping_enable"),
            "vpn.toml must NOT contain ping_enable (D-09 removal)"
        );
    }

    #[test]
    fn test_icmp_section_always_written() {
        // 06-uat install-wizard slimming: the ICMP toggle was HIDDEN but the feature
        // stays ON — ICMP_ENABLE_DEFAULT (= true) is hard-coded, so the [icmp] heredoc
        // block (with its autodetect snippet) is ALWAYS emitted regardless of payload.
        let settings = test_settings();
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains("[icmp]"), "[icmp] section must always be written (feature hidden but kept ON)");
        assert!(output.contains("interface_name"), "[icmp] block must carry interface_name");
        assert!(
            output.contains("TT_ICMP_IFACE"),
            "the [icmp] autodetect snippet must be present"
        );
    }

    #[test]
    fn test_default_constructed_settings_keep_icmp_on() {
        // A legacy IPC payload that sends no icmp flag must still get the always-on ICMP
        // behavior — the field was removed but ICMP_ENABLE_DEFAULT keeps the [icmp]
        // section unconditional, so the written vpn.toml is unchanged.
        let json = r#"{
            "listenAddress": "0.0.0.0:443",
            "vpnUsername": "u",
            "vpnPassword": "p",
            "certType": "selfsigned",
            "domain": "example.com"
        }"#;
        let settings: EndpointSettings = serde_json::from_str(json).expect("legacy payload must deserialize");
        let output = build_configure_commands(&settings, "sudo ", false, false);
        assert!(output.contains("[icmp]"), "default (legacy) payload must keep [icmp] always-on");
    }

    #[test]
    fn test_strip_legacy_feature_keys_removes_legacy_lines() {
        // The normalizer drops the two inert legacy keys, keeps everything else.
        let legacy = "listen_address = \"0.0.0.0:443\"\nping_enable = false\nspeedtest_enable = false\nipv6_available = true\n";
        let stripped = strip_legacy_feature_keys(legacy);
        assert!(!stripped.contains("ping_enable"), "ping_enable must be stripped");
        assert!(!stripped.contains("speedtest_enable"), "speedtest_enable must be stripped");
        assert!(stripped.contains("listen_address"), "other keys must survive");
        assert!(stripped.contains("ipv6_available"), "other keys must survive");
    }

    #[test]
    fn test_pre_round2_vpn_toml_does_not_false_diverge() {
        // C-05 / review C2: a pre-round-2 server vpn.toml carries the two legacy lines
        // AND an appended [icmp] section. After normalization (strip_icmp_section +
        // strip_legacy_feature_keys) it must NOT diverge from the new intended content
        // so a NORMAL reinstall does not dead-end on SSH_CONFIG_DIVERGES.
        let settings = test_settings();
        let intended = build_intended_vpn_toml(&settings);
        // Reconstruct what a pre-round-2 server would have on disk: the intended base
        // with the two legacy lines re-inserted after ipv6_available, plus an appended
        // [icmp] section the writer adds server-side.
        let legacy_existing = intended.replace(
            "ipv6_available = true",
            "ipv6_available = true\nping_enable = false\nspeedtest_enable = false",
        ) + "\n\n[icmp]\ninterface_name = \"eth0\"\n";
        let normalized = strip_legacy_feature_keys(&strip_icmp_section(&legacy_existing));
        assert!(
            !config_diverges(&normalized, &intended),
            "a pre-round-2 vpn.toml (legacy keys + appended [icmp]) must NOT diverge after normalization"
        );
    }

    // ── D-10 (06-09): auth_failure_status_code / allow_private / [metrics] ──

    #[test]
    fn test_vpn_toml_auth_failure_status_code_default_407() {
        let settings = test_settings();
        let vpn = build_intended_vpn_toml(&settings);
        assert!(
            vpn.contains("auth_failure_status_code = 407"),
            "default auth_failure_status_code must be 407"
        );
    }

    #[test]
    fn test_vpn_toml_auth_failure_status_code_405_when_chosen() {
        let mut settings = test_settings();
        settings.auth_failure_status_code = 405;
        let vpn = build_intended_vpn_toml(&settings);
        assert!(
            vpn.contains("auth_failure_status_code = 405"),
            "auth_failure_status_code must reflect the chosen 405"
        );
    }

    #[test]
    fn test_vpn_toml_allow_private_network_is_constant_false() {
        // 06-uat install-wizard slimming: the Allow-private toggle was REMOVED. The
        // value is now hard-coded from ALLOW_PRIVATE_NETWORK_DEFAULT (= false, safe) —
        // LAN exposure is no longer opt-in. The written line is always `= false`.
        let settings = test_settings();
        let vpn = build_intended_vpn_toml(&settings);
        assert!(
            vpn.contains("allow_private_network_connections = false"),
            "allow_private_network_connections must always be the hard-coded false"
        );
        assert!(
            !vpn.contains("allow_private_network_connections = true"),
            "allow_private_network_connections must never be true (toggle removed)"
        );
    }

    #[test]
    fn test_vpn_toml_ipv6_available_is_constant_true() {
        // 06-uat install-wizard slimming: the IPv6 toggle was HIDDEN but the feature
        // stays ON — the value is hard-coded from IPV6_AVAILABLE_DEFAULT (= true), so
        // the written vpn.toml is unchanged.
        let settings = test_settings();
        let vpn = build_intended_vpn_toml(&settings);
        assert!(
            vpn.contains("ipv6_available = true"),
            "ipv6_available must always be the hard-coded true (feature hidden but kept ON)"
        );
    }

    #[test]
    fn test_vpn_toml_no_metrics_or_socks5_sections() {
        // 06-uat install-wizard slimming: the Metrics + SOCKS5 settings were removed
        // end-to-end, so neither section can ever appear and egress is always direct.
        let settings = test_settings();
        let vpn = build_intended_vpn_toml(&settings);
        assert!(!vpn.contains("[metrics]"), "[metrics] section must never be written (setting removed)");
        assert!(!vpn.contains("socks5"), "no socks5 may ever appear (setting removed)");
        assert!(
            vpn.contains("[forward_protocol]") && vpn.contains("direct = {}"),
            "egress must always be the default direct [forward_protocol] table"
        );
    }

    #[test]
    fn test_validate_endpoint_settings_rejects_bad_auth_code() {
        let mut settings = test_settings();
        settings.auth_failure_status_code = 200;
        assert!(
            validate_endpoint_settings(&settings).is_err(),
            "a non-407/405 auth_failure_status_code must be rejected"
        );
    }
}
