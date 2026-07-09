use super::super::*;
use russh::client;

// ═══════════════════════════════════════════════════════════════
//   BBR TCP congestion control — detect / enable / disable
// ═══════════════════════════════════════════════════════════════

/// Check whether BBR congestion control is currently active on the server.
/// Returns `true` if `net.ipv4.tcp_congestion_control` is set to `bbr`.
pub async fn detect_bbr_status(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<bool, String> {
    let (out, _) = exec_command(
        handle,
        app,
        "sysctl net.ipv4.tcp_congestion_control 2>/dev/null || echo ''",
    )
    .await?;
    Ok(out.to_lowercase().contains("bbr"))
}

/// Phase 18 (18-10) — durable ownership marker recording the congestion-control
/// algorithm that was active BEFORE we first enabled BBR. Mirrors the MTProto
/// `.tt-installed-mtproto` marker (18-09). WR-8: this marker is now the SOLE authorization
/// for the uninstall BBR revert (the pre-install snapshot no longer authorizes) AND it
/// carries the exact prior algo to restore. It is captured just BEFORE the sysctl mutation
/// in `enable_bbr` (a narrow window); if that capture ever fails, the uninstall revert
/// cannot fire — but the standalone `disable_bbr` toggle-off still works, so BBR is never
/// stranded with no in-app escape.
///
/// NON-SECRET: contains only a congestion-control algo token (e.g. `cubic`), never a
/// credential. The read probe streams only that token; nothing secret can leak (D-29).
pub(crate) const BBR_PRIOR_MARKER_PATH: &str = "/opt/trusttunnel/.tt-bbr-prior";

/// Build the FIRST-WRITE-WINS capture of the current congestion-control algorithm into
/// the `.tt-bbr-prior` marker (run by `enable_bbr` BEFORE mutating sysctl). Pure fn →
/// unit-testable under `cargo test --lib`.
///
/// First-write-wins (`test -f` guard): a SECOND «enable BBR» must NOT overwrite the true
/// pre-install algo with `bbr` — so the marker always records what the admin had before
/// our very first enable. `mkdir -p /opt/trusttunnel` guards a server where our dir does
/// not exist yet. The algo is read with `sysctl -n` and written via `{sudo}tee` (sudo
/// opens the root-owned marker — the unprivileged-redirect trap, snapshot.rs H-05); an
/// empty read writes nothing (nothing to revert, and `bbr_revert_target("")` is None).
pub(crate) fn build_bbr_prior_capture(sudo: &str) -> String {
    format!(
        "{sudo}mkdir -p /opt/trusttunnel 2>/dev/null || true; \
         if ! {sudo}test -f {BBR_PRIOR_MARKER_PATH}; then \
         tt_cur=$({sudo}sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo ''); \
         [ -n \"$tt_cur\" ] && printf '%s' \"$tt_cur\" | {sudo}tee {BBR_PRIOR_MARKER_PATH} >/dev/null 2>&1 || true; \
         fi"
    )
}

/// Build the command that reads the `.tt-bbr-prior` marker content (or empty when the
/// marker is absent — a legacy server we never enabled BBR on, or an already-reverted
/// one). Pure fn → unit-testable.
pub(crate) fn build_bbr_prior_read(sudo: &str) -> String {
    format!("{sudo}cat {BBR_PRIOR_MARKER_PATH} 2>/dev/null || echo ''")
}

/// Parse the `.tt-bbr-prior` marker content into the recorded prior algo token. Trims
/// surrounding whitespace/newline; an empty/blank marker → `None` (nothing to restore).
/// The token is still passed through `bbr_revert_target`'s whitelist by the caller
/// before it reaches any `sysctl -w`, so this never widens the injection surface.
pub(crate) fn parse_bbr_prior_marker(raw: &str) -> Option<String> {
    let v = raw.trim();
    if v.is_empty() { None } else { Some(v.to_string()) }
}

/// Enable BBR: load kernel module, set sysctl values, persist to /etc/sysctl.conf.
/// Returns `true` on success after verifying BBR is actually active.
pub async fn enable_bbr(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<bool, String> {
    let sudo = detect_sudo(handle, app).await;

    // ─── Phase 18 (18-10): capture the PRIOR congestion-control algo BEFORE mutating ──
    // Durable, first-write-wins marker so «Удалить протокол» can revert BBR on a LEGACY
    // server (no pre-install snapshot) — mirrors the MTProto ownership marker (18-09).
    // Best-effort (like the MTProto marker write): a failed capture must not fail an
    // otherwise-working enable. A second enable never overwrites the marker, so it always
    // records the TRUE pre-install algorithm (never `bbr`); `bbr_revert_target` still
    // refuses to revert to `bbr`/unknown, so an admin's own BBR is never reverted even if
    // the marker somehow captured it (D-02b preserved).
    exec_command(handle, app, &build_bbr_prior_capture(sudo)).await.ok();

    // Apply BBR + persist to sysctl.conf (grep-then-sed avoids duplicates per T-05-03)
    let (out, code) = exec_command(
        handle,
        app,
        &format!(
            "{sudo}bash -c 'set -e; \
             modprobe tcp_bbr 2>/dev/null || true; \
             sysctl -w net.core.default_qdisc=fq; \
             sysctl -w net.ipv4.tcp_congestion_control=bbr; \
             grep -q \"net.core.default_qdisc\" /etc/sysctl.conf && \
               sed -i \"s/^net\\.core\\.default_qdisc=.*/net.core.default_qdisc=fq/\" /etc/sysctl.conf || \
               echo \"net.core.default_qdisc=fq\" >> /etc/sysctl.conf; \
             grep -q \"net.ipv4.tcp_congestion_control\" /etc/sysctl.conf && \
               sed -i \"s/^net\\.ipv4\\.tcp_congestion_control=.*/net.ipv4.tcp_congestion_control=bbr/\" /etc/sysctl.conf || \
               echo \"net.ipv4.tcp_congestion_control=bbr\" >> /etc/sysctl.conf; \
             echo BBR_OK'"
        ),
    )
    .await?;

    if !out.contains("BBR_OK") {
        return Err(format!("BBR_ENABLE_FAILED|exit_code={code}"));
    }

    // Verify BBR is active
    let (verify_out, _) = exec_command(
        handle,
        app,
        "sysctl net.ipv4.tcp_congestion_control 2>/dev/null",
    )
    .await?;

    if !verify_out.to_lowercase().contains("bbr") {
        return Err("BBR_ENABLE_FAILED|verification".into());
    }

    Ok(true)
}

/// Build the BBR revert as a reusable shell fragment.
///
/// Phase 18 / D-02b: extracted from `disable_bbr` so plan 18-04 can FOLD the BBR
/// revert into the SINGLE uninstall script (`build_uninstall_script`). The fragment
/// sets `net.ipv4.tcp_congestion_control=cubic` and deletes the two lines we appended
/// in `enable_bbr` from `/etc/sysctl.conf` (`net.core.default_qdisc=fq` and
/// `net.ipv4.tcp_congestion_control=bbr`). The sed deletes are ANCHORED (`^…$`) so
/// only OUR exact lines are removed — never a substring of an admin's own config.
/// `default_qdisc` is not reverted via `sysctl -w` (fq is harmless without BBR),
/// matching the historical `disable_bbr` behavior.
///
/// Per-command `{sudo}` (rather than a `sudo bash -c` wrapper) so plan 18-04 can drop
/// these lines straight into the per-command-sudo uninstall script; this is the
/// dominant sudo pattern in the teardown code (build_uninstall_extras etc.) and is
/// equivalent under the passwordless-sudo the deploy path assumes.
///
/// WHY (18-04 ownership gate): the single uninstall script must interpolate this
/// fragment ONLY when the pre-install snapshot proves BBR was OFF before us. BBR is
/// system-global (`net.ipv4.tcp_congestion_control`) → we must NEVER revert an
/// admin's pre-existing BBR (D-02b, T-18-10). This fragment is pure/unconditional;
/// the gate lives in the CALLER.
///
/// M-02: the congestion-control algorithm to RESTORE on a BBR revert is now passed in
/// (was hardcoded `cubic`). The uninstall fold passes the snapshot's recorded
/// pre-install value so we restore exactly what the admin had; `disable_bbr` passes
/// `cubic` (the kernel default) for its standalone "turn BBR off" action. `restore_algo`
/// is a whitelisted algo token (see `bbr_revert_target`) — never free user input.
///
/// 18-10: the revert ALSO `rm -f`s the `.tt-bbr-prior` ownership marker as its last step.
/// The marker's whole job was to prove — on a legacy server with no snapshot — that WE
/// enabled BBR and what the prior algo was; once reverted that proof is spent, so both
/// callers (the uninstall fold AND standalone `disable_bbr`) drop it so a later re-enable
/// re-captures a fresh prior. Placed AFTER the restore so a mid-script failure never
/// deletes the marker without also reverting.
///
/// Pure fn → unit-testable under `cargo test --lib` with no live server.
pub(crate) fn build_bbr_revert(sudo: &str, restore_algo: &str) -> String {
    format!(
        "{sudo}sysctl -w net.ipv4.tcp_congestion_control={restore_algo}; \
         {sudo}sed -i \"/^net\\.core\\.default_qdisc=fq$/d\" /etc/sysctl.conf; \
         {sudo}sed -i \"/^net\\.ipv4\\.tcp_congestion_control=bbr$/d\" /etc/sysctl.conf; \
         {sudo}rm -f {BBR_PRIOR_MARKER_PATH}"
    )
}

/// M-02: decide whether the pre-install snapshot POSITIVELY proves BBR was off before us
/// and, if so, WHICH algorithm to restore. Returns `Some(algo)` only when `bbr_value` is
/// a KNOWN, non-BBR congestion-control algorithm — so an inconclusive capture (`""` or
/// `"unknown"` when `sysctl` failed) is treated as "do NOT revert" rather than proof of
/// absence. This stops a failed probe from clobbering an admin's own BBR (and, via the
/// whitelist, keeps only a vetted token flowing into the `sysctl -w` above).
///
/// The whitelist is the set of in-tree Linux TCP congestion modules a server could have
/// had before us; `bbr`/`bbr2` are deliberately excluded (system-global — never revert
/// an admin's BBR, D-02b / T-18-15).
pub(crate) fn bbr_revert_target(bbr_value: &str) -> Option<&'static str> {
    const KNOWN_NON_BBR: &[&str] = &[
        "cubic", "reno", "htcp", "vegas", "westwood", "illinois", "dctcp", "cdg",
        "hybla", "highspeed", "nv", "lp", "scalable", "veno", "yeah", "bic",
    ];
    let v = bbr_value.trim();
    KNOWN_NON_BBR.iter().copied().find(|&algo| algo == v)
}

/// Disable BBR: revert to cubic, remove BBR/fq lines from /etc/sysctl.conf.
/// Note: default_qdisc is not reverted via sysctl -w (fq is harmless without BBR),
/// but both lines are removed from sysctl.conf for cleanliness.
pub async fn disable_bbr(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<bool, String> {
    let sudo = detect_sudo(handle, app).await;

    // Revert body is built by the reusable `build_bbr_revert` (D-02b, plan 18-03) so
    // plan 18-04 can fold the SAME revert into the single uninstall script. The
    // fragment carries per-command sudo, so the wrapper here is a plain (non-sudo)
    // `bash -c 'set -e; …'` — behavior is identical to the historical
    // `{sudo}bash -c 'set -e; …'` under the passwordless sudo the deploy path uses.
    //
    // WR-7 (Phase-18 re-review): restore the RECORDED pre-install algorithm, not a hardcoded
    // `cubic`. `enable_bbr` captured the admin's prior algo into `.tt-bbr-prior` (first-write-
    // wins); M-02 taught the UNINSTALL fold to honor it, but this standalone toggle-off still
    // hardcoded cubic AND (via build_bbr_revert) deleted the marker — so on a server whose real
    // prior was e.g. `reno`, toggling BBR off set cubic and destroyed the only record of `reno`,
    // making it permanently unrecoverable. Read the marker, whitelist it, and fall back to cubic
    // (the kernel default) only when the marker is absent/blank/non-whitelisted. build_bbr_revert
    // then rm's the now-spent marker — correct, because it was consumed by an actual restore.
    let (prior_out, _) = exec_command(handle, app, &build_bbr_prior_read(sudo)).await?;
    let restore_algo = parse_bbr_prior_marker(&prior_out)
        .as_deref()
        .and_then(bbr_revert_target)
        .unwrap_or("cubic");
    let revert = build_bbr_revert(sudo, restore_algo);
    let (out, code) = exec_command(
        handle,
        app,
        &format!("bash -c 'set -e; {revert}; echo BBR_DISABLED'"),
    )
    .await?;

    if !out.contains("BBR_DISABLED") {
        return Err(format!("BBR_DISABLE_FAILED|exit_code={code}"));
    }

    Ok(true)
}

// ═══════════════════════════════════════════════════════════════
//   Tests for pure helpers (no SSH / no AppHandle required)
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bbr_revert_restores_requested_algo_and_deletes_both_anchored_sysctl_lines() {
        let s = build_bbr_revert("sudo ", "cubic");
        // Revert the RUNNING congestion control back to the requested algo.
        assert!(s.contains("sysctl -w net.ipv4.tcp_congestion_control=cubic"));
        // Remove BOTH persisted lines, ANCHORED (^…$) so ONLY the exact lines we
        // appended in enable_bbr are deleted — never a substring match on an
        // admin's pre-existing sysctl.conf entry.
        assert!(s.contains(r#"sed -i "/^net\.core\.default_qdisc=fq$/d" /etc/sysctl.conf"#));
        assert!(s.contains(r#"sed -i "/^net\.ipv4\.tcp_congestion_control=bbr$/d" /etc/sysctl.conf"#));
    }

    #[test]
    fn bbr_revert_restores_the_recorded_pre_install_algo_m02() {
        // M-02: the fold restores the snapshot's recorded algo, not a hardcoded cubic.
        assert!(build_bbr_revert("sudo ", "reno").contains("tcp_congestion_control=reno"));
        assert!(build_bbr_revert("sudo ", "htcp").contains("tcp_congestion_control=htcp"));
    }

    #[test]
    fn bbr_revert_target_requires_positive_proof_m02() {
        // M-02: revert only when the snapshot records a KNOWN non-BBR algo.
        assert_eq!(bbr_revert_target("cubic"), Some("cubic"));
        assert_eq!(bbr_revert_target("reno"), Some("reno"));
        assert_eq!(bbr_revert_target(" htcp "), Some("htcp")); // trimmed
        // An admin's own BBR is never reverted.
        assert_eq!(bbr_revert_target("bbr"), None);
        assert_eq!(bbr_revert_target("bbr2"), None);
        // A FAILED/absent probe is NOT proof of absence → do not revert.
        assert_eq!(bbr_revert_target(""), None);
        assert_eq!(bbr_revert_target("unknown"), None);
        assert_eq!(bbr_revert_target("something-weird"), None);
    }

    #[test]
    fn bbr_revert_carries_sudo_prefix_for_fold_in() {
        // Per-command sudo-prefixed so plan 18-04 can fold the fragment straight
        // into the per-command-sudo uninstall script (build_uninstall_script).
        let s = build_bbr_revert("sudo ", "cubic");
        assert!(s.contains("sudo sysctl -w"));
        assert!(s.contains("sudo sed -i"));
    }

    // ── 18-10: .tt-bbr-prior ownership marker (revert BBR on a legacy server) ──

    #[test]
    fn bbr_revert_removes_the_prior_marker_last_18_10() {
        // 18-10: after restoring the algo + deleting our sysctl lines, the revert drops
        // the `.tt-bbr-prior` marker so a later re-enable re-captures a fresh prior. The
        // rm must be the LAST op (a mid-script failure must never delete the marker without
        // also reverting).
        let s = build_bbr_revert("sudo ", "cubic");
        assert!(s.contains(&format!("rm -f {BBR_PRIOR_MARKER_PATH}")), "revert must rm the prior marker: {s}");
        let rm_off = s.rfind("rm -f").expect("rm present");
        let restore_off = s.find("sysctl -w").expect("restore present");
        assert!(restore_off < rm_off, "marker rm must come AFTER the algo restore");
    }

    #[test]
    fn bbr_prior_capture_is_first_write_wins_and_writes_via_sudo_tee_18_10() {
        let s = build_bbr_prior_capture("sudo ");
        // Targets the marker path inside our dir + ensures the dir exists.
        assert!(s.contains(BBR_PRIOR_MARKER_PATH), "must target the marker path: {s}");
        assert!(s.contains("mkdir -p /opt/trusttunnel"), "must ensure the marker dir: {s}");
        // First-write-wins: only capture when the marker does NOT already exist, so a
        // second enable never overwrites the true pre-install algo with "bbr".
        assert!(s.contains(&format!("test -f {BBR_PRIOR_MARKER_PATH}")), "must guard on marker absence: {s}");
        // Reads the CURRENT algo and writes it via `sudo tee` (privileged write) — never an
        // unprivileged `> marker` redirect (would fail for a non-root sudo admin, H-05).
        assert!(s.contains("sysctl -n net.ipv4.tcp_congestion_control"), "must read the current algo: {s}");
        assert!(s.contains(&format!("tee {BBR_PRIOR_MARKER_PATH}")), "must write via sudo tee: {s}");
        assert!(!s.contains(&format!("> {BBR_PRIOR_MARKER_PATH}")), "must NOT use an unprivileged redirect: {s}");
    }

    #[test]
    fn bbr_prior_read_cats_marker_defaulting_empty_18_10() {
        let s = build_bbr_prior_read("sudo ");
        assert!(s.contains(&format!("cat {BBR_PRIOR_MARKER_PATH}")), "must cat the marker: {s}");
        assert!(s.contains("|| echo ''"), "absent marker must read as empty: {s}");
    }

    #[test]
    fn parse_bbr_prior_marker_trims_and_treats_blank_as_none_18_10() {
        assert_eq!(parse_bbr_prior_marker("cubic\n"), Some("cubic".to_string()));
        assert_eq!(parse_bbr_prior_marker("  reno  "), Some("reno".to_string()));
        // A blank / empty marker is not proof of a revertable prior → None.
        assert_eq!(parse_bbr_prior_marker(""), None);
        assert_eq!(parse_bbr_prior_marker("   \n"), None);
        // Content is returned verbatim (the caller applies the bbr_revert_target whitelist).
        assert_eq!(parse_bbr_prior_marker("bbr"), Some("bbr".to_string()));
    }
}
