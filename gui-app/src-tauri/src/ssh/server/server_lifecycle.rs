use super::super::*;
use russh::client;

/// Restart the TrustTunnel service on the remote server.
pub async fn server_restart_service(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    let (_, code) = exec_command(handle, app, &format!("{sudo}systemctl --no-block restart trusttunnel")).await?;

    if code != 0 {
        return Err("SSH_SERVICE_RESTART_FAILED".into());
    }

    Ok(())
}

/// Stop the TrustTunnel service on the remote server.
pub async fn server_stop_service(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    let (_, code) = exec_command(handle, app, &format!("{sudo}systemctl stop trusttunnel")).await?;

    if code != 0 {
        return Err("SSH_SERVICE_STOP_FAILED".into());
    }

    Ok(())
}

/// Start the TrustTunnel service on the remote server.
pub async fn server_start_service(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    let (_, code) = exec_command(handle, app, &format!("{sudo}systemctl start trusttunnel")).await?;

    if code != 0 {
        return Err("SSH_SERVICE_START_FAILED".into());
    }

    Ok(())
}

/// Reboot the remote server (fire and forget).
pub async fn server_reboot(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<(), String> {
    let sudo = detect_sudo(handle, app).await;

    // Fire and forget — the connection will drop when the server reboots
    let _ = exec_command(handle, app, &format!("{sudo}reboot")).await;

    Ok(())
}
