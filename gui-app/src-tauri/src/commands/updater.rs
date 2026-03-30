use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::vpn::{AppState, kill_sidecar_from_state, kill_stale_sidecar};

#[derive(Clone, Serialize)]
struct UpdateProgress {
    stage: String,
    percent: u32,
    message: String,
}

/// Self-update: download new ZIP, verify checksum, extract, create updater script, restart.
#[tauri::command]
pub async fn self_update(
    app: tauri::AppHandle,
    download_url: String,
    expected_sha256: Option<String>,
) -> Result<(), String> {
    use std::io::Write;
    use tokio::io::AsyncWriteExt;

    let emit = |stage: &str, percent: u32, msg: &str| {
        app.emit("update-progress", UpdateProgress {
            stage: stage.to_string(),
            percent,
            message: msg.to_string(),
        }).ok();
    };

    emit("download", 0, "Starting download...");

    // Determine paths
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot determine exe path: {e}"))?;
    let app_dir = exe_path.parent()
        .ok_or("Cannot determine app directory")?;
    let temp_dir = std::env::temp_dir();
    let zip_path = temp_dir.join("trusttunnel_update.zip");
    let extract_dir = temp_dir.join("trusttunnel_update");

    // Clean up previous update artifacts
    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::remove_dir_all(&extract_dir);

    // Download the ZIP with progress
    emit("download", 5, "Connecting to server...");
    let client = reqwest::Client::new();
    let resp = client.get(&download_url)
        .header("User-Agent", "TrustTunnel-Updater")
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Download HTTP error: {}", resp.status()));
    }

    let total_size = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .map_err(|e| format!("Cannot create temp file: {e}"))?;

    let mut stream = resp.bytes_stream();
    use tokio_stream::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| format!("Write error: {e}"))?;
        downloaded += chunk.len() as u64;
        if total_size > 0 {
            let pct = ((downloaded as f64 / total_size as f64) * 80.0) as u32 + 5;
            emit("download", pct.min(85), &format!("Downloading: {:.1} MB / {:.1} MB",
                downloaded as f64 / 1_048_576.0,
                total_size as f64 / 1_048_576.0));
        }
    }
    file.flush().await.ok();
    drop(file);

    // Verify SHA256 checksum if provided
    if let Some(ref expected) = expected_sha256 {
        emit("verify", 86, "Verifying file integrity...");
        let zip_for_hash = zip_path.to_string_lossy().to_string();
        let hash_output = tokio::process::Command::new("powershell")
            .args([
                "-NoProfile", "-Command",
                &format!("(Get-FileHash -Path '{}' -Algorithm SHA256).Hash", zip_for_hash),
            ])
            .creation_flags(crate::sidecar::CREATE_NO_WINDOW)
            .output()
            .await
            .map_err(|e| format!("Checksum verification failed: {e}"))?;

        let actual_hash = String::from_utf8_lossy(&hash_output.stdout).trim().to_string();
        if !actual_hash.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&zip_path);
            return Err(format!(
                "Checksum mismatch! Expected: {expected}, Got: {actual_hash}. Download may be corrupted or tampered with."
            ));
        }
        eprintln!("[self_update] SHA256 verified: {actual_hash}");
    } else {
        eprintln!("[self_update] WARNING: No checksum provided, skipping integrity verification");
    }

    emit("extract", 88, "Extracting update...");

    // Extract ZIP using PowerShell
    let extract_dir_str = extract_dir.to_string_lossy().to_string();
    let zip_path_str = zip_path.to_string_lossy().to_string();
    let ps_output = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile", "-Command",
            &format!(
                "Remove-Item '{}' -Recurse -Force -ErrorAction SilentlyContinue; \
                 Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                extract_dir_str, zip_path_str, extract_dir_str
            ),
        ])
        .creation_flags(crate::sidecar::CREATE_NO_WINDOW)
        .output()
        .await
        .map_err(|e| format!("Extract failed: {e}"))?;

    if !ps_output.status.success() {
        let err = String::from_utf8_lossy(&ps_output.stderr);
        return Err(format!("Extraction failed: {err}"));
    }

    // Find the extracted files — could be in a subfolder
    let source_dir = {
        let mut src = extract_dir.clone();
        // If there's a single subfolder, use that
        if let Ok(mut entries) = std::fs::read_dir(&extract_dir) {
            let first = entries.next();
            let second = entries.next();
            if second.is_none() {
                if let Some(Ok(entry)) = first {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        src = entry.path();
                    }
                }
            }
        }
        src
    };

    // Verify the extracted folder has trusttunnel.exe
    if !source_dir.join("trusttunnel.exe").exists() {
        return Err("Update does not contain trusttunnel.exe. Archive corrupted?".into());
    }

    emit("install", 92, "Preparing to install...");

    // Create the updater batch script
    let bat_path = temp_dir.join("trusttunnel_updater.bat");
    let pid = std::process::id();
    let app_dir_str = app_dir.to_string_lossy().to_string();
    let source_dir_str = source_dir.to_string_lossy().to_string();
    let vbs_path_str = temp_dir.join("trusttunnel_updater.vbs").to_string_lossy().to_string();
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
echo Copying update files...
xcopy /Y /E /I "{source_dir_str}\*" "{app_dir_str}\" >nul 2>&1
if errorlevel 1 (
    echo Copy failed! Please update manually.
    pause
    exit /b 1
)
echo Starting updated version...
start "" "{app_dir_str}\TrustTunnel.exe"
echo Cleaning up temp files...
rd /s /q "{extract_dir_str}" >nul 2>&1
del "{zip_path_str}" >nul 2>&1
del "{vbs_path_str}" >nul 2>&1
(goto) 2>nul & del "%~f0"
"#
    );

    {
        let mut bat_file = std::fs::File::create(&bat_path)
            .map_err(|e| format!("Cannot create updater script: {e}"))?;
        bat_file.write_all(bat_content.as_bytes())
            .map_err(|e| format!("Cannot write updater script: {e}"))?;
    }

    emit("install", 96, "Launching updater, app will restart...");

    // Kill VPN sidecar before exit
    if let Some(state) = app.try_state::<AppState>() {
        kill_sidecar_from_state(&state);
    }
    kill_stale_sidecar();

    // Launch the updater bat completely hidden via a VBS wrapper
    let vbs_path = temp_dir.join("trusttunnel_updater.vbs");
    let vbs_content = format!(
        "CreateObject(\"Wscript.Shell\").Run \"{}\", 0, False",
        bat_path.to_string_lossy().replace('\\', "\\\\").replace('"', "\"\"")
    );
    std::fs::write(&vbs_path, &vbs_content)
        .map_err(|e| format!("Cannot create VBS launcher: {e}"))?;

    std::process::Command::new("wscript.exe")
        .arg(&vbs_path)
        .creation_flags(crate::sidecar::CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Cannot launch updater: {e}"))?;

    // Give the bat a moment to start, then exit the app
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    app.exit(0);

    Ok(())
}
