/// Register trusttunnel:// and tt:// URL protocol handlers in Windows registry.
/// Uses HKEY_CURRENT_USER (no admin rights needed).
///
/// Strategy: register a small launcher script that writes the URL to a temp file,
/// then the main app picks it up via file watcher. This avoids UAC for the protocol handler.

#[cfg(windows)]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(windows)]
use winreg::RegKey;

/// Get the path where incoming deep-link URLs are written.
#[cfg(windows)]
fn deeplink_pending_path() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().unwrap_or(std::path::Path::new(".")).join(".pending_deeplink")
}

/// Register a URL protocol scheme using a PowerShell one-liner that writes
/// the URL to a file next to the exe (no UAC needed).
#[cfg(windows)]
fn register_protocol(scheme: &str, exe_dir: &str) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let class_path = format!("Software\\Classes\\{scheme}");

    let (key, _) = hkcu
        .create_subkey(&class_path)
        .map_err(|e| format!("Failed to create registry key: {e}"))?;

    key.set_value("", &format!("URL:{scheme} Protocol"))
        .map_err(|e| format!("Failed to set default value: {e}"))?;
    key.set_value("URL Protocol", &"")
        .map_err(|e| format!("Failed to set URL Protocol: {e}"))?;

    let (cmd_key, _) = hkcu
        .create_subkey(format!("{class_path}\\shell\\open\\command"))
        .map_err(|e| format!("Failed to create command key: {e}"))?;

    // Write URL to .pending_deeplink file — the running app polls for it
    let pending_path = exe_dir.replace('\\', "\\\\");
    let cmd = format!(
        "powershell.exe -NoProfile -WindowStyle Hidden -Command \"Set-Content -Path '{pending_path}\\\\.pending_deeplink' -Value '%1' -NoNewline\"",
    );

    cmd_key
        .set_value("", &cmd)
        .map_err(|e| format!("Failed to set command: {e}"))?;

    Ok(())
}

/// Check if a URL protocol is registered.
#[cfg(windows)]
fn is_protocol_registered(scheme: &str) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let class_path = format!("Software\\Classes\\{scheme}\\shell\\open\\command");
    hkcu.open_subkey(&class_path).is_ok()
}

/// Register both trusttunnel:// and tt:// protocols.
#[tauri::command]
pub fn register_url_protocols() -> Result<String, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Failed to get exe path: {e}"))?;
        let exe_dir = exe.parent()
            .ok_or("Failed to get exe directory")?
            .to_string_lossy()
            .to_string();

        let mut registered = Vec::new();

        for scheme in &["trusttunnel", "tt"] {
            if !is_protocol_registered(scheme) {
                register_protocol(scheme, &exe_dir)?;
                registered.push(*scheme);
            }
        }

        if registered.is_empty() {
            Ok("Protocols already registered".into())
        } else {
            Ok(format!("Registered: {}", registered.join(", ")))
        }
    }

    #[cfg(not(windows))]
    {
        Ok("URL protocol registration not supported on this platform".into())
    }
}

/// Check if protocols are registered.
#[tauri::command]
pub fn check_url_protocols() -> bool {
    #[cfg(windows)]
    {
        is_protocol_registered("trusttunnel") && is_protocol_registered("tt")
    }

    #[cfg(not(windows))]
    {
        false
    }
}

/// Poll for pending deep-link URL (written by the protocol handler).
/// Returns the URL and deletes the file, or None if no pending URL.
#[tauri::command]
pub fn poll_pending_deeplink() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let pending = exe.parent()?.join(".pending_deeplink");
    if pending.exists() {
        let url = std::fs::read_to_string(&pending).ok()?;
        let _ = std::fs::remove_file(&pending);
        let trimmed = url.trim().to_string();
        if trimmed.starts_with("trusttunnel://") || trimmed.starts_with("tt://") {
            Some(trimmed)
        } else {
            None
        }
    } else {
        None
    }
}
