use super::super::*;
use russh::client;

/// Server-side speedtest via SSH + curl against Cloudflare endpoints.
///
/// Измеряет пропускную способность канала **сервера** (а не клиента).
/// Это разумный proxy для VPN-throughput: server bandwidth = bottleneck для всех VPN-клиентов.
///
/// Возвращает: { download_mbps, upload_mbps }.
///
/// Workflow:
/// 1. Download — `curl -w '%{speed_download}'` качает 25 МБ с speed.cloudflare.com/__down,
///    выводит bytes/sec.
/// 2. Upload — `dd | curl -w '%{speed_upload}'` пушит 10 МБ на speed.cloudflare.com/__up,
///    выводит bytes/sec.
/// 3. Конвертация bytes/sec → Mbps (× 8 / 1_000_000).
///
/// Timeout: --max-time 30 для каждого запроса (общий budget ~60s).
pub async fn server_speedtest_run(
    app: &tauri::AppHandle,
    handle: &client::Handle<SshHandler>,
) -> Result<serde_json::Value, String> {
    let cmd = concat!(
        "DL=$(curl -s -o /dev/null -w '%{speed_download}' --max-time 30 ",
        "'https://speed.cloudflare.com/__down?bytes=25000000' 2>/dev/null) && ",
        "UP=$(dd if=/dev/zero bs=1M count=10 2>/dev/null | ",
        "curl -s -o /dev/null -w '%{speed_upload}' --max-time 30 ",
        "-X POST -T - 'https://speed.cloudflare.com/__up' 2>/dev/null) && ",
        "echo \"DL=$DL\" && echo \"UP=$UP\""
    );

    let (output, _) = exec_command(handle, app, cmd).await?;

    let mut download_bps: f64 = 0.0;
    let mut upload_bps: f64 = 0.0;

    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(val) = trimmed.strip_prefix("DL=") {
            download_bps = val.parse().unwrap_or(0.0);
        } else if let Some(val) = trimmed.strip_prefix("UP=") {
            upload_bps = val.parse().unwrap_or(0.0);
        }
    }

    if download_bps <= 0.0 && upload_bps <= 0.0 {
        return Err(format!(
            "SPEEDTEST_FAILED|curl returned zero/empty output: {output}"
        ));
    }

    // Convert bytes/sec → Mbps (× 8 / 1_000_000), round to 1 decimal.
    let download_mbps = (download_bps * 8.0 / 1_000_000.0 * 10.0).round() / 10.0;
    let upload_mbps = (upload_bps * 8.0 / 1_000_000.0 * 10.0).round() / 10.0;

    Ok(serde_json::json!({
        "download_mbps": download_mbps,
        "upload_mbps": upload_mbps,
    }))
}
