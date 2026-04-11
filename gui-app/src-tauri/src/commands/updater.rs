use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tauri::Manager;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::vpn::{AppState, kill_sidecar_from_state};

#[derive(Clone, Serialize)]
struct UpdateProgress {
    stage: String,
    percent: u32,
    message: String,
}

/// Validate download URL is from trusted domains only.
fn validate_download_url(url: &str) -> Result<(), String> {
    let allowed_hosts = ["github.com", "objects.githubusercontent.com"];
    let lower = url.to_lowercase();
    if !lower.starts_with("https://") {
        return Err("Download URL must use HTTPS".into());
    }
    // Extract host from URL
    let host = lower.trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("");
    if !allowed_hosts.iter().any(|d| host == *d || host.ends_with(&format!(".{d}"))) {
        return Err(format!("Downloads only allowed from: {}", allowed_hosts.join(", ")));
    }
    Ok(())
}

/// Self-update: download NSIS setup.exe, verify checksum, launch silent install, restart.
#[tauri::command]
pub async fn self_update(
    app: tauri::AppHandle,
    download_url: String,
    expected_sha256: String,
    language: Option<String>,
    theme: Option<String>,
) -> Result<(), String> {
    use std::io::Write as StdWrite;
    use tokio::io::AsyncWriteExt;

    let emit = |stage: &str, percent: u32, msg: &str| {
        app.emit(
            "update-progress",
            UpdateProgress {
                stage: stage.to_string(),
                percent,
                message: msg.to_string(),
            },
        )
        .ok();
    };

    validate_download_url(&download_url)?;

    let _lang = language.as_deref().unwrap_or("ru");
    let _theme = theme.as_deref().unwrap_or("dark");

    emit("download", 0, "update.starting");

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot determine exe path: {e}"))?;
    let app_dir = exe_path
        .parent()
        .ok_or("Cannot determine app directory")?;
    let temp_dir = std::env::temp_dir();
    let setup_path = temp_dir.join("trusttunnel_setup.exe");

    // Clean up previous update artifact
    let _ = std::fs::remove_file(&setup_path);

    // Download setup.exe with progress
    emit("download", 5, "update.connecting");
    let client = reqwest::Client::new();
    let resp = client
        .get(&download_url)
        .header("User-Agent", "TrustTunnel-Updater")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download HTTP error: {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&setup_path)
        .await
        .map_err(|e| format!("Cannot create temp file: {e}"))?;

    let mut stream = resp.bytes_stream();
    use tokio_stream::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if total_size > 0 {
            let pct = ((downloaded as f64 / total_size as f64) * 80.0) as u32 + 5;
            emit(
                "download",
                pct.min(85),
                &format!(
                    "update.downloading|{:.1}|{:.1}",
                    downloaded as f64 / 1_048_576.0,
                    total_size as f64 / 1_048_576.0
                ),
            );
        }
    }
    file.flush().await.ok();
    drop(file);

    // Verify SHA256 checksum (if provided)
    if !expected_sha256.is_empty() {
        emit("verify", 88, "update.verifying");
        let bytes =
            std::fs::read(&setup_path).map_err(|e| format!("Cannot read downloaded file: {e}"))?;
        let hash = Sha256::digest(&bytes);
        let actual = format!("{:x}", hash);
        if !actual.eq_ignore_ascii_case(&expected_sha256) {
            let _ = std::fs::remove_file(&setup_path);
            return Err(format!(
                "Checksum mismatch! Expected: {expected_sha256}, Got: {actual}. Download may be corrupted or tampered with."
            ));
        }
        eprintln!("[self_update] SHA256 verified: {actual}");
    } else {
        eprintln!("[self_update] WARNING: No checksum provided, skipping verification");
    }

    emit("install", 92, "update.preparing");

    // Kill only our own VPN sidecar before exit (not other app's processes)
    if let Some(state) = app.try_state::<AppState>() {
        kill_sidecar_from_state(&state);
    }

    emit("install", 96, "update.launching");

    // Create updater batch script: run setup /S → wait → launch app
    let bat_path = temp_dir.join("trusttunnel_updater.bat");
    let pid = std::process::id();
    let app_exe = app_dir.join(exe_path.file_name().unwrap_or_default());
    let setup_str = setup_path.to_string_lossy();
    let app_str = app_exe.to_string_lossy();
    let vbs_path = temp_dir.join("trusttunnel_updater.vbs");

    let bat_content = format!(
        r#"@echo off
title TrustTunnel Updater
echo Waiting for TrustTunnel to exit (PID {pid})...
:waitloop
tasklist /FI "PID eq {pid}" 2>NUL | find "{pid}" >NUL
if not errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto waitloop
)
echo Installing update...
"{setup_str}" /S
echo Starting TrustTunnel...
timeout /t 2 /nobreak >nul
start "" "{app_str}"
echo Cleaning up...
del "{vbs_str}" >nul 2>&1
(goto) 2>nul & del "%~f0"
"#,
        vbs_str = vbs_path.to_string_lossy(),
    );

    {
        let mut bat_file = std::fs::File::create(&bat_path)
            .map_err(|e| format!("Cannot create updater script: {e}"))?;
        bat_file
            .write_all(bat_content.as_bytes())
            .map_err(|e| format!("Cannot write updater script: {e}"))?;
    }

    // Launch bat hidden via VBS wrapper
    let vbs_content = format!(
        "CreateObject(\"Wscript.Shell\").Run \"{}\", 0, False",
        bat_path
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\"\"")
    );
    std::fs::write(&vbs_path, &vbs_content)
        .map_err(|e| format!("Cannot create VBS launcher: {e}"))?;

    std::process::Command::new("wscript.exe")
        .arg(&vbs_path)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("Cannot launch updater: {e}"))?;

    // Launch a small loader window (parallel to bat, cosmetic only)
    let is_ru = _lang != "en";
    let is_light = _theme == "light";
    let loader_text = if is_ru { "Обновление TrustTunnel..." } else { "Updating TrustTunnel..." };
    let wait_text = if is_ru { "Подождите..." } else { "Please wait..." };
    let (bg, fg, sub_c, bar_bg) = if is_light {
        ("245,246,250", "26,26,46", "100,100,120", "220,220,230")
    } else {
        ("24,24,31", "240,240,245", "120,120,140", "40,40,50")
    };

    let loader_ps = temp_dir.join("trusttunnel_loader.ps1");
    let loader_content = format!(
        "Add-Type -AssemblyName System.Windows.Forms\n\
         Add-Type -AssemblyName System.Drawing\n\
         $f=New-Object Windows.Forms.Form\n\
         $f.FormBorderStyle='None'\n\
         $f.Size=New-Object Drawing.Size(320,90)\n\
         $f.StartPosition='CenterScreen'\n\
         $f.TopMost=$true\n\
         $f.ShowInTaskbar=$false\n\
         $f.BackColor=[Drawing.Color]::FromArgb({bg})\n\
         $l=New-Object Windows.Forms.Label\n\
         $l.Text='{loader_text}'\n\
         $l.ForeColor=[Drawing.Color]::FromArgb({fg})\n\
         $l.Font=New-Object Drawing.Font('Segoe UI Semibold',11)\n\
         $l.AutoSize=$true\n\
         $l.Location=New-Object Drawing.Point(20,14)\n\
         $f.Controls.Add($l)\n\
         $s=New-Object Windows.Forms.Label\n\
         $s.Text='{wait_text}'\n\
         $s.ForeColor=[Drawing.Color]::FromArgb({sub_c})\n\
         $s.Font=New-Object Drawing.Font('Segoe UI',8.5)\n\
         $s.AutoSize=$true\n\
         $s.Location=New-Object Drawing.Point(20,58)\n\
         $f.Controls.Add($s)\n\
         $bgp=New-Object Windows.Forms.Panel\n\
         $bgp.BackColor=[Drawing.Color]::FromArgb({bar_bg})\n\
         $bgp.Size=New-Object Drawing.Size(280,3)\n\
         $bgp.Location=New-Object Drawing.Point(20,46)\n\
         $f.Controls.Add($bgp)\n\
         $b=New-Object Windows.Forms.Panel\n\
         $b.BackColor=[Drawing.Color]::FromArgb(99,102,241)\n\
         $b.Size=New-Object Drawing.Size(80,3)\n\
         $b.Location=New-Object Drawing.Point(20,46)\n\
         $f.Controls.Add($b)\n\
         $b.BringToFront()\n\
         $script:d=1; $script:x=0\n\
         $anim=New-Object Windows.Forms.Timer\n\
         $anim.Interval=30\n\
         $anim.Add_Tick({{$script:x+=$script:d*4; if($script:x -gt 200){{$script:d=-1}}; if($script:x -lt 0){{$script:d=1;$script:x=0}}; $b.Location=New-Object Drawing.Point((20+$script:x),46); $b.Size=New-Object Drawing.Size(80,3)}})\n\
         $anim.Start()\n\
         $close=New-Object Windows.Forms.Timer\n\
         $close.Interval=30000\n\
         $close.Add_Tick({{$f.Close()}})\n\
         $close.Start()\n\
         $f.ShowDialog()\n\
         Remove-Item $MyInvocation.MyCommand.Path -Force -EA 0\n"
    );
    std::fs::write(&loader_ps, &loader_content).ok();
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &loader_ps.to_string_lossy()])
        .creation_flags(0x08000000)
        .spawn()
        .ok(); // Non-critical — if loader fails, update still works

    // Give bat a moment to start, then exit
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    app.exit(0);

    Ok(())
}
