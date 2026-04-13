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

/// Enable BBR: load kernel module, set sysctl values, persist to /etc/sysctl.conf.
/// Returns `true` on success after verifying BBR is actually active.
pub async fn enable_bbr(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<bool, String> {
    let sudo = detect_sudo(handle, app).await;

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

/// Disable BBR: revert to cubic, remove BBR/fq lines from /etc/sysctl.conf.
/// Note: default_qdisc is not reverted via sysctl -w (fq is harmless without BBR),
/// but both lines are removed from sysctl.conf for cleanliness.
pub async fn disable_bbr(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<bool, String> {
    let sudo = detect_sudo(handle, app).await;

    let (out, code) = exec_command(
        handle,
        app,
        &format!(
            "{sudo}bash -c 'set -e; \
             sysctl -w net.ipv4.tcp_congestion_control=cubic; \
             sed -i \"/^net\\.core\\.default_qdisc=fq$/d\" /etc/sysctl.conf; \
             sed -i \"/^net\\.ipv4\\.tcp_congestion_control=bbr$/d\" /etc/sysctl.conf; \
             echo BBR_DISABLED'"
        ),
    )
    .await?;

    if !out.contains("BBR_DISABLED") {
        return Err(format!("BBR_DISABLE_FAILED|exit_code={code}"));
    }

    Ok(true)
}
