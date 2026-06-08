// Rust-owned system-DNS lifecycle safety net (FIX-A, RC-2).
//
// The C++ sidecar sets system DNS on connect (client config `change_system_dns = true`,
// see ssh/mod.rs build_client_config) and is supposed to restore it on shutdown. But the
// prebuilt sidecar does NOT honour a graceful signal, so we always hard-kill it
// (see sidecar.rs kill path) — its DNS teardown never runs, and system DNS is left
// pointing at the now-dead tunnel resolver until something re-sets it. That stranded
// resolver is the prime cause of Claude Code returning 403 after a VPN off→on (it only
// recovers on a full CC restart). A normal VPN client GUARANTEES the original DNS is
// restored regardless of how the tunnel process dies — so we own that guarantee here
// instead of trusting the unreliable core.
//
// Design: snapshot the pre-VPN system DNS ONCE (before the first tunnel), persist it next
// to the exe (mirrors known_hosts.json), and restore it on EVERY teardown path —
// disconnect, session teardown, AND a startup sweep that catches the previous session
// hard-dying without restore. The snapshot is taken only when no snapshot already exists,
// so a reconnect / connect-while-connected never overwrites the baseline with the tunnel
// resolver. The restore-command builder is a pure function so it is unit-tested without
// touching the live system.
//
// See .planning/debug/claude-code-403-on-vpn-reconnect.md (RC-2 / FIX-A).

use crate::ssh::portable_data_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn snap_path() -> PathBuf {
    portable_data_dir().join("dns_snapshot.json")
}

#[derive(Serialize, Deserialize, Clone)]
struct DnsEntry {
    index: u32,
    family: String,
    mode: String,
    servers: Vec<String>,
}

fn run_ps(script: &str) -> Result<String, String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// Reads pre-VPN DNS per adapter, skipping our own wintun/tunnel adapter. mode is
// "static" when the registry NameServer is set, else "dhcp". Per address family.
const SNAPSHOT_PS: &str = r#"$r=@()
foreach($f in 'IPv4','IPv6'){ Get-DnsClientServerAddress -AddressFamily $f -EA SilentlyContinue | %{
 $ad=Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -EA SilentlyContinue; if(-not $ad){return}
 if($ad.InterfaceDescription -match 'wintun|trusttunnel'){return}
 $b= if($f -eq 'IPv4'){'Tcpip'}else{'Tcpip6'}
 $ns=(Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$b\Parameters\Interfaces\$($ad.InterfaceGuid)" -Name NameServer -EA SilentlyContinue).NameServer
 $r+=[pscustomobject]@{index=$_.InterfaceIndex;family=$f;mode= if($ns){'static'}else{'dhcp'};servers=@($_.ServerAddresses)} } }
$r | ConvertTo-Json -Compress"#;

// PURE + unit-tested: builds the restore PowerShell command for one snapshot entry.
// Server addresses are whitelist-filtered (hex/./: only) so a malformed value can never
// inject shell into the command we run.
fn build_restore_script(e: &DnsEntry) -> String {
    let clean: Vec<String> = e
        .servers
        .iter()
        .filter(|s| s.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':'))
        .cloned()
        .collect();
    if e.mode == "static" && !clean.is_empty() {
        let list = clean
            .iter()
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "Set-DnsClientServerAddress -InterfaceIndex {} -ServerAddresses {list}",
            e.index
        )
    } else {
        format!(
            "Set-DnsClientServerAddress -InterfaceIndex {} -ResetServerAddresses",
            e.index
        )
    }
}

/// Snapshot the current system DNS ONCE, before the first tunnel comes up. Guarded so a
/// reconnect / connect-while-connected can never overwrite the pre-VPN baseline.
pub fn snapshot_system_dns() {
    if snap_path().exists() {
        return;
    }
    if let Ok(json) = run_ps(SNAPSHOT_PS) {
        let json = json.trim();
        if !json.is_empty() {
            let _ = std::fs::write(snap_path(), json);
        }
    }
}

/// Restore the snapshotted DNS exactly (static → set servers; dhcp → reset to automatic),
/// flush the resolver cache, then drop the snapshot file. No-op when no snapshot exists.
pub fn restore_system_dns() {
    let raw = match std::fs::read_to_string(snap_path()) {
        Ok(r) => r,
        Err(_) => return,
    };
    // ConvertTo-Json emits a bare object (not an array) for a single entry — accept both.
    let entries: Vec<DnsEntry> = serde_json::from_str(&raw)
        .or_else(|_| serde_json::from_str::<DnsEntry>(&raw).map(|e| vec![e]))
        .unwrap_or_default();
    for e in &entries {
        let _ = run_ps(&build_restore_script(e));
    }
    let _ = run_ps("Clear-DnsClientCache");
    let _ = std::fs::remove_file(snap_path());
}

/// Flush the OS resolver cache. Called on connect so an app that cached a pre-tunnel /
/// stale resolution re-resolves cleanly through the new tunnel.
pub fn flush_dns_cache() {
    let _ = run_ps("Clear-DnsClientCache");
}

/// Startup crash-sweep: a snapshot surviving across launches means the previous session
/// hard-died without restoring DNS — the system is still on the dead tunnel resolver.
/// Restore it now (mirrors kill_stale_sidecar's leftover-cleanup role).
pub fn sweep_stale_dns_on_startup() {
    if snap_path().exists() {
        restore_system_dns();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(mode: &str, servers: &[&str]) -> DnsEntry {
        DnsEntry {
            index: 12,
            family: "IPv4".into(),
            mode: mode.into(),
            servers: servers.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn static_sets_exact_servers() {
        let cmd = build_restore_script(&entry("static", &["1.1.1.1", "8.8.8.8"]));
        assert!(cmd.contains("-InterfaceIndex 12"));
        assert!(cmd.contains("-ServerAddresses '1.1.1.1','8.8.8.8'"));
        assert!(!cmd.contains("-ResetServerAddresses"));
    }

    #[test]
    fn dhcp_resets_to_automatic() {
        let cmd = build_restore_script(&entry("dhcp", &[]));
        assert!(cmd.contains("-ResetServerAddresses"));
        assert!(!cmd.contains("-ServerAddresses '"));
    }

    #[test]
    fn static_but_no_servers_falls_back_to_reset() {
        // A "static" mode with no captured servers must not emit an empty -ServerAddresses.
        assert!(build_restore_script(&entry("static", &[])).contains("-ResetServerAddresses"));
    }

    #[test]
    fn injection_chars_are_filtered_out() {
        let cmd = build_restore_script(&entry("static", &["1.1.1.1'; rm -rf /"]));
        assert!(!cmd.contains("rm"));
        assert!(!cmd.contains(';'));
    }
}
