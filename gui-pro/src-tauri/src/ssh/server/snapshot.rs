//! UN-2 pre-install server snapshot (Phase 18, D-04).
//!
//! Before the very first install touches a server, we capture the pre-install
//! system state — occupied ports, presence + enabled-state of ufw / Fail2ban /
//! MTProto, existing ufw rules, whether the ufw/fail2ban packages pre-existed,
//! and the BBR sysctl value — and persist it as JSON to our install marker dir
//! (`/opt/trusttunnel/.tt-preinstall-snapshot.json`). The uninstall side (D-06 /
//! D-07) reads this evidence to decide "ours vs the admin's": a package is only
//! purged if the snapshot PROVES it was absent before us.
//!
//! ## Invariants
//! - **First-install-only:** a re-install / idempotent re-run NEVER overwrites an
//!   existing snapshot (the original pre-install truth is immutable). Mirrors the
//!   `dns_guard::snapshot_system_dns` snapshot-once guard.
//! - **No secrets (D-INV-2 / D-29):** the snapshot captures ONLY ports / booleans /
//!   sysctl string / ufw rule-comment strings — it has NO secret-bearing field, so
//!   nothing it holds can leak into the log channel. This is enforced by construction
//!   (there is no field to put a credential or the telemt secret into).
//! - **UUID heredocs (D-INV-3):** every multi-line SSH command uses a dynamically
//!   generated `SNAPSHOT_EOF_<uuid>` heredoc delimiter, never a static one.
//! - **Capture precedes mutation (Pitfall 3):** the writer is invoked as the FIRST
//!   server-touch in `deploy_server`, before any apt/ufw change — a snapshot taken
//!   after a mutation would be worthless.

use super::super::*;
use russh::client;
use serde::{Deserialize, Serialize};

/// Server-side path of the pre-install snapshot JSON, inside our install marker dir.
pub(crate) const SNAPSHOT_PATH: &str = "/opt/trusttunnel/.tt-preinstall-snapshot.json";

/// Server-side path of the PENDING pre-install snapshot (WR-5, Phase-18 re-review). The capture
/// writes HERE first; `promote_preinstall_snapshot` renames it to the authoritative
/// `SNAPSHOT_PATH` ONLY after the deploy that captured it fully succeeds. A deploy that fails or
/// is abandoned therefore leaves at most a `.pending` file — never an authoritative snapshot — so
/// a stale pre-install record can never outlive its install attempt and later authorize
/// destroying a component the admin installed in the gap. The next deploy overwrites `.pending`
/// with a fresh capture of the CURRENT state before promoting.
pub(crate) const SNAPSHOT_PENDING_PATH: &str =
    "/opt/trusttunnel/.tt-preinstall-snapshot.json.pending";

/// The pre-install system state captured before the first install mutation (D-04).
///
/// Serialized to `/opt/trusttunnel/.tt-preinstall-snapshot.json`. `#[serde(default)]`
/// on the whole struct + `deny`-free deserialization make it forward-compatible: an
/// older snapshot missing a newly-added field parses fine, and an unknown extra field
/// from a future schema is ignored.
///
/// SECURITY (D-INV-2 / D-29): every field is a port list, a boolean, a sysctl string,
/// or a ufw rule-comment string. There is deliberately NO field that could carry a
/// credential, password, or the telemt secret — the snapshot is secret-free by shape.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PreInstallSnapshot {
    /// Schema version. Serialized as `v` for compactness; defaults to 1.
    #[serde(rename = "v", default = "default_schema_version")]
    pub schema_version: u32,
    /// Listening (occupied) ports observed before install (from `ss -tulnH`).
    pub occupied_ports: Vec<u16>,
    /// Was the `ufw` package installed before us?
    pub ufw_present: bool,
    /// Was ufw active before us?
    pub ufw_active: bool,
    /// Existing ufw numbered rules (raw lines), so uninstall never deletes non-ours.
    pub ufw_rules: Vec<String>,
    /// Was the `fail2ban` package installed before us?
    pub fail2ban_present: bool,
    /// Was fail2ban enabled before us?
    pub fail2ban_enabled: bool,
    /// Was an MTProto proxy binary (`/bin/telemt`) present before us?
    pub mtproto_present: bool,
    /// The `net.ipv4.tcp_congestion_control` value before us (e.g. `cubic`/`bbr`).
    pub bbr_value: String,
    /// Was `ufw` apt-manually-installed before us (`apt-mark showmanual`)? Evidence
    /// for D-07: only purge a package the snapshot proves was absent/not-ours.
    pub ufw_manual: bool,
    /// Was `fail2ban` apt-manually-installed before us? (D-07 evidence.)
    pub fail2ban_manual: bool,
}

fn default_schema_version() -> u32 {
    1
}

// Labels emitted by the capture script, one per captured category, so the parser can
// line-scan the raw blob back into the struct. Kept as consts so the test can assert
// every label appears in BOTH the script and is honored by the parser.
const L_PORT: &str = "PORT ";
const L_UFW_PRESENT: &str = "UFW_PRESENT ";
const L_UFW_ACTIVE: &str = "UFW_ACTIVE ";
const L_UFW_RULE: &str = "UFW_RULE ";
const L_F2B_PRESENT: &str = "F2B_PRESENT ";
const L_F2B_ENABLED: &str = "F2B_ENABLED ";
const L_MTPROTO: &str = "MTPROTO ";
const L_BBR: &str = "BBR ";
const L_UFW_MANUAL: &str = "UFW_MANUAL ";
const L_F2B_MANUAL: &str = "F2B_MANUAL ";

/// H-05: final sentinel echoed by the capture heredoc. Its presence (plus a clean
/// exit) PROVES the capture ran to completion — a `sudo bash` that failed (needs a
/// password / policy denies bash) or a truncated capture never emits it. We refuse to
/// persist a snapshot without it, so a failed probe can never be minted into a
/// fabricated "everything absent = everything ours" snapshot.
const CAPTURE_OK_SENTINEL: &str = "SNAPSHOT_CAPTURE_OK";

/// Build the pre-install capture SHELL CONSTRUCTION (pure fn, mirrors
/// `server_install::build_probe_script`). Unit-testable under `cargo test --lib`
/// so a snapshot test can pin every captured category WITHOUT a live SSH server.
///
/// `delim` is a dynamically-generated `SNAPSHOT_EOF_<uuid>` heredoc delimiter
/// (D-INV-3 — never a static delimiter). The body is single-quoted so the writing
/// shell performs no expansion; the labels are literal and parsed back out by
/// `parse_preinstall_snapshot`.
///
/// Each category emits `LABEL VALUE` lines. Presence checks emit `1`/`0`; a category
/// whose probe produces no output simply omits its line → parses to its absent/false
/// default (tolerant).
pub(crate) fn build_snapshot_capture_script(sudo: &str, delim: &str) -> String {
    format!(
        r#"{sudo}bash << '{delim}'
# occupied listening ports — one "PORT <local-addr>:<port>" line each. H-02: emit the
# LOCAL ADDRESS COLUMN ($5 of `ss -tulnH`) VERBATIM. The old blind digit-grep matched
# the Recv-Q/Send-Q queue columns (0/4096/128/511…), the loopback resolver
# (127.0.0.53:53) and ephemeral ports as "occupied ports" — then the D-05 fold punched
# blind `ufw allow` holes for all that junk. The address column is kept so
# `parse_preinstall_snapshot` can apply the SAME loopback+ephemeral filters as the live
# `parse_listening_ports` (single filtering implementation for both sources).
ss -tulnH 2>/dev/null | awk '{{print "PORT " $5}}' | sort -u
# ufw package present? (dpkg -s exits 0 + "Status: install ok installed")
if dpkg -s ufw 2>/dev/null | grep -q "install ok installed"; then echo "UFW_PRESENT 1"; else echo "UFW_PRESENT 0"; fi
# ufw active? (first line of `ufw status`: "Status: active")
if ufw status 2>/dev/null | head -1 | grep -q "active"; then echo "UFW_ACTIVE 1"; else echo "UFW_ACTIVE 0"; fi
# existing ufw numbered rules — one "UFW_RULE <line>" each (verbatim, so uninstall
# can tell non-ours apart). Skipped silently when ufw absent/inactive.
ufw status numbered 2>/dev/null | grep -E '^\[' | sed 's/^/UFW_RULE /'
# fail2ban package present?
if dpkg -s fail2ban 2>/dev/null | grep -q "install ok installed"; then echo "F2B_PRESENT 1"; else echo "F2B_PRESENT 0"; fi
# fail2ban enabled? (systemctl is-enabled prints "enabled")
if systemctl is-enabled fail2ban >/dev/null 2>&1; then echo "F2B_ENABLED 1"; else echo "F2B_ENABLED 0"; fi
# MTProto proxy binary present?
if test -f /bin/telemt; then echo "MTPROTO 1"; else echo "MTPROTO 0"; fi
# BBR / congestion control value.
echo "BBR $(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo unknown)"
# apt-ownership: was the package apt-mark showmanual before us? (D-07 evidence)
if apt-mark showmanual 2>/dev/null | grep -qx ufw; then echo "UFW_MANUAL 1"; else echo "UFW_MANUAL 0"; fi
if apt-mark showmanual 2>/dev/null | grep -qx fail2ban; then echo "F2B_MANUAL 1"; else echo "F2B_MANUAL 0"; fi
# H-05: LAST line — a completion sentinel. If the `sudo bash` never ran (password/
# policy) or the capture was truncated, this line is absent → the writer refuses to
# persist a fabricated all-absent snapshot.
echo "{CAPTURE_OK_SENTINEL}"
{delim}"#
    )
}

/// Parse the labelled capture blob into a `PreInstallSnapshot` (pure fn). A category
/// whose probe produced no line parses to its absent/false default (tolerant — copies
/// the `line_for` line-scan idiom from `check_server_installation`).
pub(crate) fn parse_preinstall_snapshot(raw: &str) -> PreInstallSnapshot {
    // Returns the trailing value of the FIRST line starting with `label`, if any.
    let value_for = |label: &str| -> Option<String> {
        raw.lines()
            .map(str::trim)
            .find(|l| l.starts_with(label))
            .map(|l| l[label.len()..].trim().to_string())
    };
    let bool_for = |label: &str| -> bool { value_for(label).as_deref() == Some("1") };

    // H-02: each PORT line carries the socket's LOCAL address column (`<addr>:<port>`).
    // Feed those through the SAME parser the live fallback uses so the snapshot and the
    // live read apply IDENTICAL filters (drop 127.*/::1 loopback + >=32768 ephemeral,
    // dedup the v4/v6 pair). Reusing `parse_listening_ports` keeps ONE filtering rule
    // for both sources — the capture no longer records queue-depth/loopback/ephemeral
    // junk that the D-05 fold would blindly `ufw allow`.
    let occupied_ports: Vec<u16> = {
        let addr_lines: String = raw
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with(L_PORT))
            .map(|l| l[L_PORT.len()..].trim())
            .collect::<Vec<_>>()
            .join("\n");
        super::server_security::parse_listening_ports(&addr_lines)
    };

    let ufw_rules: Vec<String> = raw
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with(L_UFW_RULE))
        .map(|l| l[L_UFW_RULE.len()..].trim().to_string())
        .collect();

    PreInstallSnapshot {
        schema_version: 1,
        occupied_ports,
        ufw_present: bool_for(L_UFW_PRESENT),
        ufw_active: bool_for(L_UFW_ACTIVE),
        ufw_rules,
        fail2ban_present: bool_for(L_F2B_PRESENT),
        fail2ban_enabled: bool_for(L_F2B_ENABLED),
        mtproto_present: bool_for(L_MTPROTO),
        bbr_value: value_for(L_BBR).unwrap_or_default(),
        ufw_manual: bool_for(L_UFW_MANUAL),
        fail2ban_manual: bool_for(L_F2B_MANUAL),
    }
}

/// Build the JSON persist SHELL CONSTRUCTION that writes the serialized snapshot to the PENDING
/// path (pure fn → unit-testable). `delim` is a dynamic `SNAPSHOT_EOF_<uuid>` heredoc delimiter
/// (D-INV-3). The heredoc body is the JSON payload, interpolated exactly once; `tee` writes it
/// verbatim (no shell expansion of the JSON).
///
/// WR-5 (Phase-18 re-review): the target is `SNAPSHOT_PENDING_PATH`, NOT the authoritative
/// `SNAPSHOT_PATH`. `promote_preinstall_snapshot` renames it in only after the deploy succeeds,
/// so an abandoned/failed deploy never leaves an authoritative pre-install record.
///
/// The JSON carries no secret (see `PreInstallSnapshot`), so persisting it — and the fact that
/// `tee … > /dev/null` prints nothing to stdout — keeps the log channel clean (D-29).
///
/// H-05: writes via `{sudo}tee … > /dev/null` rather than `{sudo}cat > …`. With `cat >`, the
/// REDIRECT is performed by the UNPRIVILEGED outer shell, not by sudo — so for a non-root sudo
/// admin writing into root-owned `/opt/trusttunnel` it fails with permission denied. `tee` runs
/// UNDER sudo and opens the file itself, matching the privileged-write convention used everywhere
/// else in the teardown code.
pub(crate) fn build_snapshot_persist_script(sudo: &str, delim: &str, json: &str) -> String {
    format!(
        "{sudo}mkdir -p /opt/trusttunnel 2>/dev/null; {sudo}tee {SNAPSHOT_PENDING_PATH} > /dev/null << '{delim}'\n{json}\n{delim}"
    )
}

/// M-03/D-04: decide whether to SKIP capturing the pre-install snapshot, from the
/// combined guard-probe output. Returns `Some(reason)` to skip, `None` to capture.
///
/// Skip when:
/// - a snapshot already exists (`TT_SNAP_EXISTS`) — never overwrite the original
///   pre-install truth (mirrors `dns_guard` snapshot-once); OR
/// - an existing TrustTunnel install is detected (`TT_ALREADY_INSTALLED`) — a re-deploy
///   on a LEGACY server (installed before this feature: our binary + our ufw/fail2ban/
///   telemt/BBR present, but no snapshot). Capturing NOW would record OUR OWN components
///   as the admin's pre-existing ones, so the uninstall side would forever spare/blame
///   them — permanently defeating the phase goal for the whole existing install base.
///   The guard is "snapshot exists?" is NOT enough; it must also be "is this actually a
///   first install?".
///
/// Pure fn → unit-testable under `cargo test --lib`.
pub(crate) fn snapshot_capture_should_skip(guard_out: &str) -> Option<&'static str> {
    if guard_out.contains("TT_SNAP_EXISTS") {
        return Some("snapshot already exists (first-install-only)");
    }
    if guard_out.contains("TT_ALREADY_INSTALLED") {
        return Some(
            "existing TrustTunnel install detected (legacy re-deploy) — capturing now would \
             mislabel our own components as pre-existing",
        );
    }
    None
}

/// Capture + persist the pre-install snapshot — FIRST-INSTALL-ONLY (D-04).
///
/// A no-op when a snapshot already exists OR an existing TrustTunnel install is detected
/// (M-03 — a legacy re-deploy must not mint a snapshot that records our own components as
/// the admin's). Otherwise it runs the capture script, parses it to a `PreInstallSnapshot`,
/// and persists the JSON.
///
/// SECURITY: nothing captured is a secret (by struct shape), so no secret can reach the
/// log channel via `exec_command`'s line echoing (D-INV-2 / D-29).
pub(crate) async fn write_preinstall_snapshot(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    sudo: &str,
) -> Result<(), String> {
    // First-install-only guard: bail before capturing if the snapshot already exists OR
    // if TrustTunnel is already installed (M-03 legacy re-deploy — the binary or one of
    // our install markers is present). `ls .tt-installed-*` covers the ufw/fail2ban
    // ownership markers; `/opt/trusttunnel/setup_wizard` is the always-present endpoint
    // binary that proves a prior install regardless of which extras were chosen.
    // IN-2 (Phase-18 re-review): probe WITH {sudo}, like every other access to the root-owned
    // /opt/trusttunnel in this file (persist `{sudo}tee`, read `{sudo}cat`, uninstall marker
    // probes `{sudo}test -f`). If an admin hardens /opt/trusttunnel to 0700 and the login is a
    // non-root sudo account, an UNPRIVILEGED probe sees neither the snapshot nor the install
    // markers → the guard would let a re-deploy recapture and OVERWRITE the immutable
    // first-install snapshot with post-install state.
    let (guard_out, _) = exec_command(
        handle,
        app,
        // fix-review REG-3: the marker glob must expand UNDER sudo — `{sudo}ls .tt-installed-*`
        // lets the unprivileged outer shell expand the glob first, which fails (unmatched, passed
        // literally) on a 0700-hardened dir accessed by a non-root sudo login (the very case IN-2
        // targets). `{sudo}sh -c '…'` runs the glob as root so it matches.
        &format!(
            "if {sudo}test -f {SNAPSHOT_PATH}; then echo TT_SNAP_EXISTS; fi; \
             if {sudo}test -f /opt/trusttunnel/setup_wizard || {sudo}sh -c 'ls /opt/trusttunnel/.tt-installed-* >/dev/null 2>&1'; then echo TT_ALREADY_INSTALLED; fi; \
             echo TT_GUARD_DONE"
        ),
    )
    .await?;
    if let Some(reason) = snapshot_capture_should_skip(&guard_out) {
        emit_log(app, "info", &format!("Pre-install snapshot skipped: {reason}"));
        return Ok(());
    }

    let capture_delim = format!("SNAPSHOT_EOF_{}", uuid::Uuid::new_v4().simple());
    let capture_script = build_snapshot_capture_script(sudo, &capture_delim);
    let (raw, capture_code) = exec_command(handle, app, &capture_script).await?;

    // H-05: persist ONLY when the capture PROVABLY completed — the final
    // `SNAPSHOT_CAPTURE_OK` sentinel AND a clean exit. A failed/denied `sudo bash`
    // (needs a password, policy denies bash) or a truncated capture yields tolerant
    // all-false parse output; persisting THAT mints a snapshot claiming "everything
    // absent = everything ours", and a later uninstall would tear down the admin's
    // telemt/BBR on fabricated evidence. On any capture doubt: write NOTHING →
    // read_preinstall_snapshot returns None → the conservative D-06 marker-only path.
    if capture_code != 0 || !raw.contains(CAPTURE_OK_SENTINEL) {
        emit_log(
            app,
            "warn",
            "Pre-install snapshot capture incomplete — no snapshot written (uninstall stays conservative)",
        );
        return Ok(());
    }

    let snapshot = parse_preinstall_snapshot(&raw);

    let json = serde_json::to_string(&snapshot)
        .map_err(|e| format!("SNAPSHOT_SERIALIZE_FAILED|{e}"))?;
    let persist_delim = format!("SNAPSHOT_EOF_{}", uuid::Uuid::new_v4().simple());
    let persist_script = build_snapshot_persist_script(sudo, &persist_delim, &json);
    let (_, persist_code) = exec_command(handle, app, &persist_script).await?;
    if persist_code != 0 {
        emit_log(
            app,
            "warn",
            "Pre-install snapshot write failed — no snapshot written (uninstall stays conservative)",
        );
        return Ok(());
    }

    // Read the PENDING file back to confirm it actually landed (a silently-failed privileged
    // write must not leave the promote step trusting a non-existent capture). The grep echoes
    // only OK/BAD — the JSON body (secret-free anyway) is never streamed.
    let (verify_out, _) = exec_command(
        handle,
        app,
        &format!("{sudo}grep -q '\"v\":1' {SNAPSHOT_PENDING_PATH} 2>/dev/null && echo SNAP_OK || echo SNAP_BAD"),
    )
    .await?;
    if !verify_out.contains("SNAP_OK") {
        emit_log(
            app,
            "warn",
            "Pre-install snapshot verify failed — removing partial file (uninstall stays conservative)",
        );
        let _ = exec_command(handle, app, &format!("{sudo}rm -f {SNAPSHOT_PENDING_PATH} 2>/dev/null || true")).await;
        return Ok(());
    }
    Ok(())
}

/// WR-5 (Phase-18 re-review): promote the pending pre-install snapshot to the authoritative path,
/// called ONCE at the end of a fully-successful `deploy_server`. First-install-only + fail-safe:
///   - authoritative already exists (idempotent re-deploy / prior first install) → keep it
///     immutable, drop any stale pending;
///   - authoritative absent + pending present (this run's fresh capture) → `mv` it in;
///   - neither → nothing to do.
///
/// A deploy that failed or was abandoned never reaches this call, so its pending capture never
/// becomes authoritative — the next deploy overwrites the pending with a fresh capture of the
/// current state and promotes THAT. Any failure is non-fatal (best-effort): a missing
/// authoritative snapshot merely selects the conservative D-06 legacy uninstall path
/// (over-preserve), never a destructive one.
pub(crate) async fn promote_preinstall_snapshot(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    sudo: &str,
) -> Result<(), String> {
    let cmd = format!(
        "if {sudo}test -f {SNAPSHOT_PENDING_PATH}; then \
           if {sudo}test -f {SNAPSHOT_PATH}; then {sudo}rm -f {SNAPSHOT_PENDING_PATH} 2>/dev/null || true; \
           else {sudo}mv {SNAPSHOT_PENDING_PATH} {SNAPSHOT_PATH} 2>/dev/null || true; fi; \
         fi; true"
    );
    let _ = exec_command(handle, app, &cmd).await;
    Ok(())
}

/// Read the pre-install snapshot back. Returns `Ok(None)` when the file is absent —
/// a legacy server installed before this feature (D-06 conservative fallback path) —
/// and `Ok(Some(_))` when it exists and parses.
///
/// Consumed by `uninstall_server` (plan 18-04, D-06/D-07): the returned evidence gates the
/// snapshot-driven package purge + the MTProto/BBR folds; `None` selects the conservative
/// legacy path.
pub(crate) async fn read_preinstall_snapshot(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    sudo: &str,
) -> Result<Option<PreInstallSnapshot>, String> {
    let (raw, _) = exec_command(
        handle,
        app,
        &format!("{sudo}cat {SNAPSHOT_PATH} 2>/dev/null || echo ''"),
    )
    .await?;
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None); // D-06: legacy server, no snapshot → conservative uninstall.
    }
    let snapshot: PreInstallSnapshot = serde_json::from_str(raw)
        .map_err(|e| format!("SNAPSHOT_PARSE_FAILED|{e}"))?;
    Ok(Some(snapshot))
}

// ═══════════════════════════════════════════════════════════════
//   18-10: ownership markers surfaced to the uninstall dialog frontend
// ═══════════════════════════════════════════════════════════════

/// The install/enable ownership markers the uninstall dialog needs to offer removal of a
/// component on a LEGACY server (no snapshot). Serialized camelCase for the frontend
/// `read_server_ownership_markers` command. NON-SECRET by shape (three presence bools +
/// one derived bool) — nothing here can carry a credential (D-INV-2 / D-29).
///
/// `bbr_snapshot_revertable` is computed on the BACKEND (via `server_bbr::bbr_revert_target`)
/// so the "known non-bbr algo" whitelist lives in ONE place (Rust) and the frontend never
/// re-implements it — avoiding drift that could offer a revert of an admin's own BBR (D-02b).
#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnershipMarkers {
    /// `/opt/trusttunnel/.tt-installed-ufw` present (WE apt-installed ufw — it was absent).
    pub ufw_installed_marker: bool,
    /// `/opt/trusttunnel/.tt-installed-fail2ban` present (WE apt-installed fail2ban).
    pub fail2ban_installed_marker: bool,
    /// `/opt/trusttunnel/.tt-bbr-prior` present AND its recorded algo is whitelist-revertable
    /// (WE enabled BBR over a KNOWN non-bbr prior — 18-10 / IN-3). A marker recording "bbr"
    /// (admin already ran BBR when we pressed enable) reports FALSE — the backend gate would
    /// no-op the revert, so the dialog must not offer it.
    pub bbr_prior_marker: bool,
    /// The snapshot POSITIVELY proves a known non-bbr algo was active before us (so a BBR
    /// revert is safe). Backend-computed whitelist — the frontend does not re-implement it.
    pub bbr_snapshot_revertable: bool,
}

/// Probe presence of the three ownership markers (bare `test -f` → reads no file content,
/// so nothing can leak, D-29). Emits fixed tokens parsed by `parse_ownership_marker_probe`.
/// Pure fn → unit-testable under `cargo test --lib`.
pub(crate) fn build_ownership_marker_probe(sudo: &str) -> String {
    format!(
        "{sudo}test -f /opt/trusttunnel/.tt-installed-ufw && echo UFW_MARKER || true; \
         {sudo}test -f /opt/trusttunnel/.tt-installed-fail2ban && echo F2B_MARKER || true; \
         {sudo}test -f {bbr} && echo BBR_MARKER || true",
        bbr = super::server_bbr::BBR_PRIOR_MARKER_PATH
    )
}

/// Parse the ownership-marker probe output into `(ufw, fail2ban, bbr)` presence. Pure fn.
pub(crate) fn parse_ownership_marker_probe(raw: &str) -> (bool, bool, bool) {
    (
        raw.contains("UFW_MARKER"),
        raw.contains("F2B_MARKER"),
        raw.contains("BBR_MARKER"),
    )
}

/// Gather the ownership markers + the snapshot-derived BBR revertability for the uninstall
/// dialog (18-10). Mirrors `read_preinstall_snapshot`'s exec shape; the `bbr_snapshot_revertable`
/// bit reuses the SAME `bbr_revert_target` whitelist the backend uninstall gate uses, so the
/// frontend ownership signal can never drift from the backend's actual revert decision.
pub(crate) async fn read_ownership_markers(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
    sudo: &str,
) -> Result<OwnershipMarkers, String> {
    let (probe_out, _) = exec_command(handle, app, &build_ownership_marker_probe(sudo)).await?;
    let (ufw_m, f2b_m, bbr_m) = parse_ownership_marker_probe(&probe_out);
    // IN-3 (Phase-18 re-review): the BBR marker's VALUE decides revertability, not bare presence.
    // build_bbr_prior_capture is first-write-wins on the CURRENT algo, so on a server the admin
    // already ran BBR on, pressing «enable» mints a marker containing "bbr" — bare presence would
    // tell the dialog «WE enabled BBR» and pre-check «Revert BBR», but the backend gate
    // (bbr_revert_target("bbr") = None) silently no-ops. Report the marker as revertable ownership
    // ONLY when its content passes the SAME whitelist the uninstall gate uses (mirrors
    // bbr_snapshot_revertable). The marker holds a non-secret algo token, so reading it is D-29-safe.
    let bbr_prior_marker = if bbr_m {
        let (bbr_content, _) =
            exec_command(handle, app, &super::server_bbr::build_bbr_prior_read(sudo)).await?;
        super::server_bbr::parse_bbr_prior_marker(&bbr_content)
            .as_deref()
            .and_then(super::server_bbr::bbr_revert_target)
            .is_some()
    } else {
        false
    };
    // Legacy servers have no snapshot → `None` → not snapshot-revertable (the marker is then
    // the only BBR ownership signal). A present snapshot is run through the whitelist.
    let snapshot = read_preinstall_snapshot(app, handle, sudo).await.unwrap_or(None);
    let bbr_snapshot_revertable = snapshot
        .as_ref()
        .map(|s| super::server_bbr::bbr_revert_target(&s.bbr_value).is_some())
        .unwrap_or(false);
    Ok(OwnershipMarkers {
        ufw_installed_marker: ufw_m,
        fail2ban_installed_marker: f2b_m,
        bbr_prior_marker,
        bbr_snapshot_revertable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 18-10: ownership-marker probe (surfaced to the uninstall dialog frontend) ──

    #[test]
    fn ownership_marker_probe_is_bare_test_f_on_all_three_markers_18_10() {
        let s = build_ownership_marker_probe("sudo ");
        assert!(s.contains("test -f /opt/trusttunnel/.tt-installed-ufw"), "ufw marker probe: {s}");
        assert!(s.contains("test -f /opt/trusttunnel/.tt-installed-fail2ban"), "fail2ban marker probe: {s}");
        assert!(s.contains("test -f /opt/trusttunnel/.tt-bbr-prior"), "bbr marker probe: {s}");
        // Bare test -f only — never reads marker content (no leak, D-29).
        assert!(!s.contains("cat "), "must not read marker content: {s}");
    }

    #[test]
    fn parse_ownership_marker_probe_maps_tokens_18_10() {
        assert_eq!(parse_ownership_marker_probe("UFW_MARKER\nF2B_MARKER\nBBR_MARKER"), (true, true, true));
        assert_eq!(parse_ownership_marker_probe("BBR_MARKER"), (false, false, true));
        assert_eq!(parse_ownership_marker_probe(""), (false, false, false));
        // Distinct tokens — no substring collision between the three.
        assert_eq!(parse_ownership_marker_probe("UFW_MARKER"), (true, false, false));
    }

    #[test]
    fn ownership_markers_serialize_camelcase_and_carry_no_secret_18_10() {
        let m = OwnershipMarkers {
            ufw_installed_marker: true,
            fail2ban_installed_marker: false,
            bbr_prior_marker: true,
            bbr_snapshot_revertable: true,
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"ufwInstalledMarker\":true"), "camelCase ufw: {json}");
        assert!(json.contains("\"fail2banInstalledMarker\":false"), "camelCase fail2ban: {json}");
        assert!(json.contains("\"bbrPriorMarker\":true"), "camelCase bbr marker: {json}");
        assert!(json.contains("\"bbrSnapshotRevertable\":true"), "camelCase bbr revertable: {json}");
        let low = json.to_lowercase();
        for forbidden in ["password", "secret", "credential", "token", "passwd"] {
            assert!(!low.contains(forbidden), "ownership markers JSON must carry no secret key: {json}");
        }
    }

    // ── build_snapshot_capture_script: pins every captured category + probe token ──

    #[test]
    fn capture_script_references_every_category_label() {
        let s = build_snapshot_capture_script("sudo ", "SNAPSHOT_EOF_test");
        for label in [
            L_PORT, L_UFW_PRESENT, L_UFW_ACTIVE, L_UFW_RULE, L_F2B_PRESENT, L_F2B_ENABLED,
            L_MTPROTO, L_BBR, L_UFW_MANUAL, L_F2B_MANUAL,
        ] {
            assert!(s.contains(label.trim_end()), "capture script missing label {label:?}: {s}");
        }
    }

    #[test]
    fn capture_script_references_every_probe_command_token() {
        let s = build_snapshot_capture_script("sudo ", "SNAPSHOT_EOF_test");
        for token in [
            "ss -tulnH",                              // occupied ports
            "dpkg -s ufw",                            // ufw present
            "ufw status",                             // ufw active
            "ufw status numbered",                    // existing rules
            "dpkg -s fail2ban",                       // fail2ban present
            "systemctl is-enabled fail2ban",          // fail2ban enabled
            "test -f /bin/telemt",                    // mtproto present
            "sysctl -n net.ipv4.tcp_congestion_control", // BBR value
            "apt-mark showmanual",                    // apt ownership
        ] {
            assert!(s.contains(token), "capture script missing probe token {token:?}: {s}");
        }
    }

    #[test]
    fn capture_script_uses_dynamic_uuid_heredoc_delim_not_static() {
        // D-INV-3 / mirror probe_script_uses_dynamic_uuid_heredoc_delim_not_static:
        // the helper interpolates WHATEVER delim it is given — assert it uses THAT
        // delim to open + close the heredoc, and carries no static delimiter literal.
        let s = build_snapshot_capture_script("sudo ", "SNAPSHOT_EOF_deadbeef");
        assert!(s.contains("<< 'SNAPSHOT_EOF_deadbeef'"), "delim not used in heredoc open: {s}");
        assert!(s.trim_end().ends_with("SNAPSHOT_EOF_deadbeef"), "delim not used to close heredoc");
        assert!(!s.contains("USER_EOF"), "static heredoc delimiter must not appear");
        assert!(!s.contains("SNAPSHOT_EOF_\n"), "no empty/static SNAPSHOT_EOF token");
    }

    // ── build_snapshot_persist_script: dynamic delim + target path + JSON once ──

    #[test]
    fn persist_script_uses_dynamic_delim_target_path_and_interpolates_json_once() {
        let json = r#"{"v":1,"occupiedPorts":[22]}"#;
        let s = build_snapshot_persist_script("sudo ", "SNAPSHOT_EOF_cafef00d", json);
        // Dynamic UUID delimiter (D-INV-3), used to open the heredoc.
        assert!(s.contains("<< 'SNAPSHOT_EOF_cafef00d'"), "persist delim not used: {s}");
        assert!(s.trim_end().ends_with("SNAPSHOT_EOF_cafef00d"), "persist delim not used to close");
        assert!(!s.contains("USER_EOF"), "static persist delimiter must not appear");
        // WR-5: writes to the PENDING path inside our marker dir (promoted only on deploy success).
        assert!(s.contains(SNAPSHOT_PENDING_PATH), "persist target must be the pending path: {s}");
        assert!(s.contains("mkdir -p /opt/trusttunnel"), "marker dir not ensured: {s}");
        // JSON payload interpolated exactly once.
        assert_eq!(s.matches(json).count(), 1, "JSON payload not interpolated exactly once: {s}");
    }

    #[test]
    fn persist_script_writes_via_sudo_tee_not_an_unprivileged_redirect_h05() {
        // H-05: the write must go through `{sudo}tee` (sudo opens the file) — NOT
        // `{sudo}cat > file`, whose redirect is done by the unprivileged outer shell
        // and fails for a non-root sudo admin writing into root-owned /opt/trusttunnel.
        let s = build_snapshot_persist_script("sudo ", "SNAPSHOT_EOF_x", r#"{"v":1}"#);
        assert!(s.contains(&format!("sudo tee {SNAPSHOT_PENDING_PATH} > /dev/null")), "must write via sudo tee to the pending path: {s}");
        assert!(!s.contains(&format!("cat > {SNAPSHOT_PENDING_PATH}")), "must NOT use an unprivileged cat-redirect: {s}");
    }

    #[test]
    fn capture_script_emits_completion_sentinel_last_h05() {
        // H-05: the capture heredoc's LAST echoed line is the completion sentinel, so a
        // truncated/failed capture can be detected (and never persisted).
        let s = build_snapshot_capture_script("sudo ", "SNAPSHOT_EOF_test");
        assert!(s.contains(CAPTURE_OK_SENTINEL), "capture must echo the completion sentinel: {s}");
        // It is the final echo before the closing heredoc delimiter.
        let sentinel_pos = s.rfind(CAPTURE_OK_SENTINEL).unwrap();
        let close_pos = s.rfind("SNAPSHOT_EOF_test").unwrap();
        assert!(sentinel_pos < close_pos, "sentinel must precede the heredoc close");
        // No capture probe line comes after the sentinel echo.
        assert!(
            !s[sentinel_pos..close_pos].contains("echo \"PORT"),
            "no probe output may follow the completion sentinel"
        );
    }

    // ── parse_preinstall_snapshot: full mapping + tolerance ──

    #[test]
    fn parse_maps_full_capture_blob() {
        // H-02: PORT lines now carry the local-address column (`<addr>:<port>`).
        let raw = "\
PORT 0.0.0.0:22
PORT [::]:443
UFW_PRESENT 1
UFW_ACTIVE 1
UFW_RULE [ 1] 22/tcp ALLOW IN Anywhere
UFW_RULE [ 2] 443/tcp ALLOW IN Anywhere
F2B_PRESENT 1
F2B_ENABLED 0
MTPROTO 1
BBR bbr
UFW_MANUAL 1
F2B_MANUAL 0
";
        let snap = parse_preinstall_snapshot(raw);
        assert_eq!(snap.occupied_ports, vec![22, 443]);
        assert!(snap.ufw_present);
        assert!(snap.ufw_active);
        assert_eq!(snap.ufw_rules.len(), 2);
        assert!(snap.ufw_rules[0].contains("22/tcp"));
        assert!(snap.fail2ban_present);
        assert!(!snap.fail2ban_enabled);
        assert!(snap.mtproto_present);
        assert_eq!(snap.bbr_value, "bbr");
        assert!(snap.ufw_manual);
        assert!(!snap.fail2ban_manual);
    }

    #[test]
    fn parse_excludes_queue_columns_and_loopback_keeps_high_ports_h02_wr6() {
        // H-02: the capture emits `PORT <$5>` (local address column). Simulate what
        // `awk '{print "PORT " $5}'` produces from a realistic `ss -tulnH` — the parser
        // must keep ONLY the real, externally-reachable listening ports and drop:
        //   • queue-depth columns (they are NEVER in $5, so they can't appear) — proven
        //     by the absence of 4096/128/511 below;
        //   • loopback-only binds (127.0.0.53 resolver, ::1).
        // WR-6 (Phase-18 re-review): a high external bind (44321) is now KEPT — `ss -tulnH`
        // lists only LISTENING/bound sockets, so a high port here is a real service (Docker
        // publishes 32768+, WireGuard binds 51820/udp), not a transient client socket.
        let raw = "\
PORT 0.0.0.0:22
PORT [::]:443
PORT 0.0.0.0:8080
PORT 127.0.0.53%lo:53
PORT [::1]:11211
PORT 0.0.0.0:44321
PORT [::]:8080
UFW_PRESENT 1
";
        let snap = parse_preinstall_snapshot(raw);
        // Real external ports, deduped across v4/v6 (8080 bound on both → once); 44321 kept (WR-6).
        assert_eq!(snap.occupied_ports, vec![22, 443, 8080, 44321], "got {:?}", snap.occupied_ports);
        // The junk queue-depth values + loopback-only binds must still be absent.
        for junk in [4096u16, 128, 511, 53, 11211] {
            assert!(!snap.occupied_ports.contains(&junk), "junk port {junk} leaked into occupied_ports");
        }
    }

    #[test]
    fn capture_emits_local_address_column_not_a_blind_digit_grep_h02() {
        // H-02: the capture command must read the address column, not blind-grep digits.
        let s = build_snapshot_capture_script("sudo ", "SNAPSHOT_EOF_test");
        assert!(s.contains(r#"awk '{print "PORT " $5}'"#), "must emit the $5 local-addr column: {s}");
        assert!(!s.contains(r#"grep -oE '[0-9]+ '"#), "must NOT use the broken digit grep: {s}");
    }

    #[test]
    fn snapshot_capture_skips_on_existing_snapshot_or_legacy_install_m03() {
        // M-03: a genuine first install (no snapshot, no install markers) → capture.
        assert_eq!(snapshot_capture_should_skip("TT_GUARD_DONE"), None);
        // Snapshot already exists → never overwrite.
        assert!(snapshot_capture_should_skip("TT_SNAP_EXISTS\nTT_GUARD_DONE").is_some());
        // Legacy re-deploy: our install already present, but no snapshot → SKIP, so we
        // never record our own components as the admin's pre-existing ones.
        let reason = snapshot_capture_should_skip("TT_ALREADY_INSTALLED\nTT_GUARD_DONE");
        assert!(reason.is_some(), "legacy re-deploy must skip capture");
        assert!(reason.unwrap().contains("legacy"), "reason should explain the legacy skip");
        // Both present → still skip (snapshot-exists wins, either way no capture).
        assert!(snapshot_capture_should_skip("TT_SNAP_EXISTS\nTT_ALREADY_INSTALLED").is_some());
    }

    #[test]
    fn parse_tolerates_empty_probe_output() {
        // A category whose probe produced no output parses to its absent/false default.
        let snap = parse_preinstall_snapshot("");
        assert_eq!(snap, PreInstallSnapshot::default_with_version());
        assert!(snap.occupied_ports.is_empty());
        assert!(!snap.ufw_present);
        assert!(!snap.ufw_active);
        assert!(snap.ufw_rules.is_empty());
        assert!(!snap.fail2ban_present);
        assert!(!snap.mtproto_present);
        assert_eq!(snap.bbr_value, "");
    }

    // ── serde round-trip + forward-compat ──

    #[test]
    fn snapshot_serde_round_trips() {
        let snap = PreInstallSnapshot {
            schema_version: 1,
            occupied_ports: vec![22, 80, 443],
            ufw_present: true,
            ufw_active: false,
            ufw_rules: vec!["[ 1] 22/tcp ALLOW IN Anywhere".to_string()],
            fail2ban_present: true,
            fail2ban_enabled: true,
            mtproto_present: false,
            bbr_value: "cubic".to_string(),
            ufw_manual: true,
            fail2ban_manual: false,
        };
        let json = serde_json::to_string(&snap).unwrap();
        // schema_version is serialized as compact `v`.
        assert!(json.contains("\"v\":1"), "schema_version not renamed to v: {json}");
        // camelCase field naming.
        assert!(json.contains("\"occupiedPorts\""), "not camelCase: {json}");
        let back: PreInstallSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snap, back);
    }

    #[test]
    fn snapshot_ignores_unknown_extra_field() {
        // Forward-compat: a future schema's extra field is ignored (serde default tolerance).
        let json = r#"{"v":1,"occupiedPorts":[22],"someFutureField":"whatever"}"#;
        let snap: PreInstallSnapshot = serde_json::from_str(json).unwrap();
        assert_eq!(snap.occupied_ports, vec![22]);
    }

    #[test]
    fn snapshot_has_no_secret_bearing_field() {
        // D-INV-2 / D-29 by construction: serializing a fully-populated snapshot yields
        // JSON that carries only ports/booleans/sysctl/rule-comment strings. There is no
        // field into which a credential/password/telemt secret could be placed. This test
        // documents that invariant so a future field addition that introduces one fails
        // review here (the JSON must never contain a secret-looking key).
        let snap = PreInstallSnapshot {
            bbr_value: "bbr".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&snap).unwrap().to_lowercase();
        for forbidden in ["password", "secret", "credential", "token", "passwd"] {
            assert!(!json.contains(forbidden), "snapshot JSON must carry no secret key: {json}");
        }
    }

    impl PreInstallSnapshot {
        /// Default value with the canonical schema version (parse() always sets v=1).
        fn default_with_version() -> Self {
            PreInstallSnapshot { schema_version: 1, ..Default::default() }
        }
    }
}
