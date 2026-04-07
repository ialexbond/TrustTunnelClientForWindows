#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::logging::sanitize;
use crate::portable_data_dir;

/// Run a PowerShell command and return stdout (empty string on failure).
#[cfg(windows)]
fn ps(cmd: &str) -> String {
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", cmd])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Run a simple command and return stdout.
#[cfg(windows)]
fn cmd_run(program: &str, args: &[&str]) -> String {
    std::process::Command::new(program)
        .args(args)
        .creation_flags(0x08000000)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Collect system diagnostic information for troubleshooting.
pub fn collect_system_info() -> String {
    let mut info = String::new();

    info.push_str("=== TrustTunnel System Diagnostics ===\n");
    info.push_str(&format!("Timestamp: {}\n\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")));

    // OS version
    #[cfg(windows)]
    {
        let ver = cmd_run("cmd", &["/c", "ver"]);
        info.push_str(&format!("--- OS Version ---\n{ver}\n\n"));
    }

    // Network adapters
    #[cfg(windows)]
    {
        let adapters = ps("Get-NetAdapter | Format-Table Name, Status, InterfaceDescription, LinkSpeed -AutoSize | Out-String -Width 200");
        info.push_str(&format!("--- Network Adapters ---\n{adapters}\n\n"));
    }

    // DNS settings
    #[cfg(windows)]
    {
        let dns = ps("Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses.Count -gt 0 } | Format-Table InterfaceAlias, ServerAddresses -AutoSize | Out-String -Width 200");
        info.push_str(&format!("--- DNS Configuration ---\n{dns}\n\n"));
    }

    // Conflicting VPN adapters
    #[cfg(windows)]
    {
        let conflicts = ps(
            "Get-NetAdapter -IncludeHidden | Where-Object { \
                $_.InterfaceDescription -match 'WireGuard|Wintun|TAP-Windows|tun|Amnezia|OpenVPN' \
            } | Format-Table Name, Status, InterfaceDescription -AutoSize | Out-String -Width 200"
        );
        if conflicts.is_empty() {
            info.push_str("--- VPN Adapters ---\nNone detected\n\n");
        } else {
            info.push_str(&format!("--- VPN Adapters ---\n{conflicts}\n\n"));
        }
    }

    // VPN config (sanitized)
    let config_path = portable_data_dir().join("trusttunnel_client.toml");
    if config_path.exists() {
        if let Ok(config_text) = std::fs::read_to_string(&config_path) {
            let sanitized = sanitize(&config_text);
            info.push_str(&format!("--- VPN Config (sanitized) ---\n{sanitized}\n\n"));
        }
    } else {
        info.push_str("--- VPN Config ---\nNo config file found\n\n");
    }

    // Disk space
    #[cfg(windows)]
    {
        let exe_drive = std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(|s| s.chars().next().unwrap_or('C').to_string()));
        let drive = exe_drive.unwrap_or_else(|| "C".to_string());
        let space = ps(&format!(
            "Get-PSDrive {drive} | Select-Object @{{N='Free(GB)';E={{[math]::Round($_.Free/1GB,2)}}}}, @{{N='Used(GB)';E={{[math]::Round($_.Used/1GB,2)}}}} | Format-List | Out-String"
        ));
        info.push_str(&format!("--- Disk Space ({drive}:) ---\n{space}\n\n"));
    }

    info
}

/// Write system diagnostics snapshot to logs/system.txt.
pub fn write_system_snapshot() {
    let dir = portable_data_dir().join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        eprintln!("[diagnostics] Failed to create logs directory");
        return;
    }
    let info = collect_system_info();
    let path = dir.join("system.txt");
    if let Err(e) = std::fs::write(&path, &info) {
        eprintln!("[diagnostics] Failed to write system.txt: {e}");
    }
}

