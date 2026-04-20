/// Check if another trusttunnel_client process is running.
pub fn check_process_conflict() -> Option<String> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq trusttunnel_client*", "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        if text.contains("trusttunnel_client") {
            return Some("Running TrustTunnel process detected. Kill it?".into());
        }
    }
    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("pgrep")
            .args(["-f", "trusttunnel_client"])
            .output()
            .ok()?;
        if output.status.success() {
            return Some("Running TrustTunnel process detected. Kill it?".into());
        }
    }
    None
}

/// Kill any running trusttunnel_client processes.
pub fn kill_existing_process() -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/IM", "trusttunnel_client*"])
            .output()
            .map_err(|e| format!("SSH_KILL_PROCESS_FAILED|{e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("pkill")
            .args(["-f", "trusttunnel_client"])
            .output()
            .map_err(|e| format!("SSH_KILL_PROCESS_FAILED|{e}"))?;
    }
    Ok(())
}
