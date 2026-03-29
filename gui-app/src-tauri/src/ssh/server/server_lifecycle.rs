use super::super::*;

/// Restart the TrustTunnel service on the remote server.
pub async fn server_restart_service(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (_, code) = exec_command(&handle, app, &format!("{sudo}systemctl restart trusttunnel")).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err("SSH_SERVICE_RESTART_FAILED".into());
    }

    Ok(())
}

/// Stop the TrustTunnel service on the remote server.
pub async fn server_stop_service(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (_, code) = exec_command(&handle, app, &format!("{sudo}systemctl stop trusttunnel")).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err("SSH_SERVICE_STOP_FAILED".into());
    }

    Ok(())
}

/// Start the TrustTunnel service on the remote server.
pub async fn server_start_service(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    let (_, code) = exec_command(&handle, app, &format!("{sudo}systemctl start trusttunnel")).await?;

    handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();

    if code != 0 {
        return Err("SSH_SERVICE_START_FAILED".into());
    }

    Ok(())
}

/// Reboot the remote server (fire and forget).
pub async fn server_reboot(
    app: &tauri::AppHandle,
    params: SshParams,
) -> Result<(), String> {
    let handle = params.connect().await?;

    let (whoami, _) = exec_command(&handle, app, "whoami").await?;
    let sudo = if whoami.trim() == "root" { "" } else { "sudo " };

    // Fire and forget — the connection will drop when the server reboots
    let _ = exec_command(&handle, app, &format!("{sudo}reboot")).await;

    Ok(())
}
