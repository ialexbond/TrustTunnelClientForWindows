#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::logging::sanitize;
use crate::ssh::user_data_dir;

/// Run a PowerShell command and return stdout (empty string on failure).
#[cfg(windows)]
fn ps(cmd: &str) -> String {
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", cmd])
        .creation_flags(0x08000000)
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
    let config_path = user_data_dir().join("trusttunnel_client.toml");
    if config_path.exists() {
        if let Ok(config_text) = std::fs::read_to_string(&config_path) {
            let sanitized = sanitize(&config_text);
            info.push_str(&format!("--- VPN Config (sanitized) ---\n{sanitized}\n\n"));
        }
    } else {
        info.push_str("--- VPN Config ---\nNo config file found\n\n");
    }

    // Where the app's data actually lives, which source answered, and WHO this process is.
    //
    // The path is a directory name, never file contents — nothing here can carry a credential.
    {
        let (root, origin) = crate::ssh::user_data_dir_with_origin();
        info.push_str(&data_root_report(&root, &format!("{origin:?}"), &process_account()));
    }

    // Disk space
    #[cfg(windows)]
    {
        // Measures the volume the DATA lives on, resolved through the shared helper rather than
        // assumed to be C:. Since phase 32 the install and the data are two separate roots —
        // `Program Files` for the binaries, `%LOCALAPPDATA%\TrustTunnel Client Pro` for
        // everything written at runtime — and on a machine with a redirected user profile those
        // are two different VOLUMES. The one that can actually fill up is the data volume: logs,
        // geodata `.dat` files, the webview profile.
        let data_drive = user_data_dir()
            .to_str()
            .map(|s| s.chars().next().unwrap_or('C').to_string());
        let drive = data_drive.unwrap_or_else(|| "C".to_string());
        let space = ps(&format!(
            "Get-PSDrive {drive} | Select-Object @{{N='Free(GB)';E={{[math]::Round($_.Free/1GB,2)}}}}, @{{N='Used(GB)';E={{[math]::Round($_.Used/1GB,2)}}}} | Format-List | Out-String"
        ));
        info.push_str(&format!("--- Disk Space ({drive}:) ---\n{space}\n\n"));
    }

    info
}

/// The account this process is actually running as, for the data-root report.
///
/// **This is a statement, not a guess** — it reads `GetTokenInformation(TokenUser)` off the
/// process token through the helper the logon task binds its principal with, so it says who we
/// ARE. It deliberately does not attempt to work out who the person at the keyboard is; every
/// candidate for that is the heuristic `32-CONTEXT.md` D-08 rejected, and D-08's grounds apply
/// with more force here, not less (`memory/security-posture.md`, «повышение через плечо»).
#[cfg(windows)]
fn process_account() -> String {
    match crate::task_scheduler::current_user_id() {
        Ok(id) => format!("{} ({})", id.account, id.sid),
        Err(e) => format!("<unresolved: {e}>"),
    }
}

#[cfg(not(windows))]
fn process_account() -> String {
    "<unresolved: not Windows>".to_string()
}

/// The `--- Data Root ---` block, factored out so it is assertable without running PowerShell.
///
/// **Why the process account is in the diagnostics at all** (32-FIX-03). The manifest is
/// `requireAdministrator`, so under over-the-shoulder UAC on a standard-user machine — the person
/// using the computer is not an administrator and someone else supplies the credentials — this
/// process runs as the SUPPLYING ADMINISTRATOR. The data root, the `HKCU` adoption lookup and the
/// logon task's user id then all resolve to that administrator rather than to the person who will
/// use the app. Before phase 32 that could not happen: the data root was one fixed absolute path,
/// identical for every account.
///
/// That substitution is a RECORDED LIMITATION, not something this function fixes — the reasoning,
/// including why D-08 forbids recovering the real interactive user, is in
/// `memory/security-posture.md`. What this line buys is that the state stops being INVISIBLE: it
/// is undetectable on a real Windows install and on every machine where the user is a local
/// administrator, because split-token elevation keeps the same SID, the same `%LOCALAPPDATA%` and
/// the same `HKCU`. One line in a bundle the user can copy is what makes it diagnosable at all.
///
/// D-29: an account name and a SID, never a password and never file contents.
fn data_root_report(root: &std::path::Path, origin: &str, account: &str) -> String {
    format!(
        "--- Data Root ---\n{}\nresolved from: {origin}\nprocess account: {account}\n\n",
        root.display()
    )
}

/// Write system diagnostics snapshot to logs/system.txt.
pub fn write_system_snapshot() {
    let dir = user_data_dir().join("logs");
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

#[cfg(test)]
mod tests {
    use super::*;

    /// **The elevated-identity substitution must be VISIBLE in a diagnostics bundle** (32-FIX-03).
    ///
    /// Under over-the-shoulder UAC the process runs as the supplying administrator, so the data
    /// root, the `HKCU` adoption lookup and the logon task's principal all belong to that
    /// administrator rather than to the person using the app. The state is undetectable on the
    /// a real machine and on every machine where the user is a local administrator — split-token
    /// elevation keeps the same SID, the same `%LOCALAPPDATA%` and the same `HKCU` — so no gate
    /// can see it and one line in a copyable bundle is what makes it diagnosable at all.
    ///
    /// The substitution is a RECORDED limitation, argued in `memory/security-posture.md`; this
    /// test pins the recording's one machine-checkable half — that the report names the account,
    /// and that it never becomes a place a secret could be printed (D-29).
    #[test]
    fn the_data_root_report_names_who_the_process_is() {
        let report = data_root_report(
            std::path::Path::new("C:\\Users\\alice\\AppData\\Local\\TrustTunnel Client Pro"),
            "LocalAppData",
            "MACHINE\\admin (S-1-5-21-0-0-0-500)",
        );

        assert!(
            report.contains("process account: MACHINE\\admin (S-1-5-21-0-0-0-500)"),
            "the bundle must name the account the process actually runs as — under \
             over-the-shoulder elevation that is the ONLY place the substitution shows: {report}"
        );
        assert!(
            report.contains("C:\\Users\\alice\\AppData\\Local\\TrustTunnel Client Pro")
                && report.contains("resolved from: LocalAppData"),
            "the root and the source that answered must both stay in the report: {report}"
        );

        // D-29. The report carries a directory name, an origin and an identity — never contents.
        // Asserted because this block is the one place in diagnostics that sits a line away from
        // the folder holding ssh_credentials.json.
        for forbidden in ["password", "пароль", "ssh_credentials", "PRIVATE KEY"] {
            assert!(
                !report.to_lowercase().contains(&forbidden.to_lowercase()),
                "the data-root report must never carry «{forbidden}»: {report}"
            );
        }
    }
}

