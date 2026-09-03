//! Register trusttunnel:// and tt:// URL protocol handlers in the Windows registry.
//! Uses HKEY_CURRENT_USER (no admin rights needed).
//!
//! Strategy: register the app EXE DIRECTLY as the handler (`"<exe>" "%1"`). A clicked
//! `tt://` link then makes the browser/OS prompt show the app name («Открыть TrustTunnel
//! Client Pro?») — NOT powershell.exe. (The previous design registered a hidden
//! powershell.exe one-liner that wrote the URL to a file; for a VPN app, a browser prompt
//! to "open Windows PowerShell" reads as malware and scared users off — 06-uat.) The URL
//! reaches the running app via the single-instance handler (warm start) or via argv on a
//! cold start (`capture_cold_start_deeplink` writes `.pending_deeplink`, drained by the
//! frontend's startup poll once its listener is attached).

#[cfg(windows)]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(windows)]
use winreg::RegKey;

/// Path where an incoming deep-link URL is staged for the frontend's startup poll
/// (`poll_pending_deeplink`). Lives in the per-user data root.
///
/// D-03 C: this doc comment used to read "lives next to the exe (per-user install dir,
/// writable)". That premise DIED when the install moved to Program Files — the install
/// directory is no longer a per-user writable location — and a comment that outlives its premise
/// is precisely how the next reader puts the file back where it cannot be written. The staging
/// file is user-written runtime state, so it moves with the rest of the data.
fn deeplink_pending_path() -> std::path::PathBuf {
    crate::ssh::user_data_dir().join(".pending_deeplink")
}

/// Cold-start capture: if THIS process was launched by the protocol handler
/// (`"<exe>" "%1"`), the URL is in our own argv. Stage it in `.pending_deeplink` so the
/// frontend's startup poll (`useDeepLinkImport` channel 2) drains it AFTER its listener
/// is attached — avoiding the emit-before-listener race. Warm start (an already-running
/// instance) is handled by the single-instance handler instead, so this only fires on a
/// genuine cold launch. Best-effort; returns the captured URL if any.
pub fn capture_cold_start_deeplink() -> Option<String> {
    let url = std::env::args()
        .find(|a| a.starts_with("trusttunnel://") || a.starts_with("tt://"))?;
    let _ = std::fs::write(deeplink_pending_path(), &url);
    Some(url)
}

/// Register a URL protocol scheme pointing DIRECTLY at the app exe (`"<exe>" "%1"`), so
/// the OS handler-prompt shows the app — not powershell.exe. HKCU = no UAC.
#[cfg(windows)]
fn register_protocol(scheme: &str, exe_path: &str) -> Result<(), String> {
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

    // Launch the app directly with the URL as %1. The running app receives it via the
    // single-instance handler (warm) or argv at startup (cold). Quoted so a path with
    // spaces is one argument.
    cmd_key
        .set_value("", &build_protocol_command(exe_path))
        .map_err(|e| format!("Failed to set command: {e}"))?;

    Ok(())
}

/// The registry `shell\open\command` value for a scheme: the app exe launched directly
/// with the URL as `%1`. Pure (testable) — locks the "direct exe, never powershell"
/// contract so the malware-looking «Открыть Windows PowerShell?» prompt cannot regress.
#[cfg(windows)]
fn build_protocol_command(exe_path: &str) -> String {
    format!("\"{exe_path}\" \"%1\"")
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
        let exe_path = exe.to_string_lossy().to_string();

        // Always (re)write the command — this MIGRATES installs whose registry still holds
        // the old powershell.exe handler to the direct-exe command. create_subkey +
        // set_value overwrites; it is idempotent and cheap, so no is_protocol_registered
        // short-circuit (that guard is exactly why legacy installs never got the fix).
        for scheme in &["trusttunnel", "tt"] {
            register_protocol(scheme, &exe_path)?;
        }

        Ok("Registered: trusttunnel, tt".into())
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
    // D-03 C: reads through the SAME helper the writer uses. This site used to re-derive the
    // path from `current_exe()`, so writer and reader were two independent answers to "where is
    // the staging file" — a drift that would present as deep links silently never arriving.
    let pending = deeplink_pending_path();
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    // 06-uat regression: the protocol handler must launch the app DIRECTLY, never via
    // powershell.exe — a clicked tt:// link prompting «Открыть Windows PowerShell?» reads
    // as malware for a VPN app and scared users off.
    #[test]
    fn protocol_command_launches_exe_directly_not_powershell() {
        let cmd = build_protocol_command(r"C:\Users\me\AppData\Local\TrustTunnel\trusttunnel.exe");
        assert!(
            cmd.to_lowercase().contains("trusttunnel.exe"),
            "command must launch the app exe directly"
        );
        assert!(cmd.contains("\"%1\""), "command must pass the URL as %1");
        assert!(
            !cmd.to_lowercase().contains("powershell"),
            "command must NEVER route through powershell"
        );
    }

    #[test]
    fn protocol_command_quotes_a_path_with_spaces() {
        let cmd = build_protocol_command(r"C:\Program Files\TrustTunnel Client Pro\trusttunnel.exe");
        // The exe path is quoted as one argument, then a separate quoted %1.
        assert!(cmd.starts_with("\"C:\\Program Files\\TrustTunnel Client Pro\\trusttunnel.exe\""));
        assert!(cmd.ends_with("\"%1\""));
    }
}
