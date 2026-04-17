use super::super::*;
use russh::client;

/// Fast standalone uptime fetch — `cat /proc/uptime`.
///
/// Отдельная lightweight команда вместо использования server_get_stats.uptime_seconds,
/// потому что server_get_stats тормозится `sleep 1` для CPU sampling (~2s total).
/// `cat /proc/uptime` возвращает за <100ms.
///
/// Returns: { uptime_seconds: f64 }
pub async fn server_get_uptime(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<serde_json::Value, String> {
    let (output, _) = exec_command(handle, app, "cat /proc/uptime").await?;

    let uptime_seconds: f64 = output
        .split_whitespace()
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    Ok(serde_json::json!({
        "uptime_seconds": uptime_seconds,
    }))
}
