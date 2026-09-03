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
// disconnect, session teardown, app exit (RunEvent::Exit, AUDIT-2026-06-11 #10), AND a
// startup sweep that catches the previous session hard-dying without restore. The
// snapshot is taken only when no snapshot already exists,
// so a reconnect / connect-while-connected never overwrites the baseline with the tunnel
// resolver. The restore-command builder is a pure function so it is unit-tested without
// touching the live system.
//
// See .planning/debug/claude-code-403-on-vpn-reconnect.md (RC-2 / FIX-A).

use crate::ssh::user_data_dir;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn snap_path() -> PathBuf {
    user_data_dir().join("dns_snapshot.json")
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
    // AUDIT-2026-06-11 #17: previously this returned Ok(stdout) even when PowerShell
    // exited non-zero, so a failed Set-DnsClientServerAddress (absent interface, AV /
    // AppLocker blocking) was indistinguishable from success and restore_system_dns
    // deleted the pre-VPN baseline anyway. Surface the failure so callers can react;
    // callers that genuinely don't care (flush_dns_cache) still discard it explicitly.
    if !out.status.success() {
        return Err(format!(
            "powershell exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
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

// PURE + unit-tested: builds the restore PowerShell commands — ONE command per interface.
//
// AUDIT-2026-06-11 #18: the snapshot stores one entry per (interface, address family),
// but Set-DnsClientServerAddress has NO address-family scope: `-ServerAddresses` replaces
// the interface's FULL static server list (both families) and `-ResetServerAddresses`
// resets BOTH families to automatic. The previous shape (one command per entry) made the
// later IPv6 dhcp entry's reset wipe a just-restored static IPv4 list on dual-stack
// adapters (Pi-hole / corporate static-DNS setups). So entries are grouped by
// InterfaceIndex: if ANY family was static, emit a single `-ServerAddresses` with the
// combined static-family server list (the cmdlet accepts mixed families; the family with
// no addresses in the list falls back to automatic, which is exactly what dhcp means);
// `-ResetServerAddresses` only when ALL families for that interface were dhcp. Servers
// snapshotted for a dhcp family are deliberately NOT included — freezing DHCP-provided
// servers as static would corrupt the baseline the other way.
//
// Server addresses are whitelist-filtered (hex/./: only) so a malformed value can never
// inject shell into the command we run.
fn build_restore_commands(entries: &[DnsEntry]) -> Vec<String> {
    // (InterfaceIndex, combined static servers), preserving first-seen interface order
    // (SNAPSHOT_PS emits all IPv4 entries first, then IPv6 — so combined lists are
    // IPv4-then-IPv6, matching the cmdlet's conventional ordering).
    let mut groups: Vec<(u32, Vec<String>)> = Vec::new();
    for e in entries {
        if !groups.iter().any(|(i, _)| *i == e.index) {
            groups.push((e.index, Vec::new()));
        }
        if e.mode != "static" {
            continue;
        }
        let clean = e
            .servers
            .iter()
            .filter(|s| s.chars().all(|c| c.is_ascii_hexdigit() || c == '.' || c == ':'))
            .cloned();
        if let Some((_, servers)) = groups.iter_mut().find(|(i, _)| *i == e.index) {
            servers.extend(clean);
        }
    }
    groups
        .iter()
        .map(|(index, servers)| {
            if servers.is_empty() {
                // All families dhcp (or "static" with no usable servers — must not emit
                // an empty -ServerAddresses): reset the whole interface to automatic.
                format!("Set-DnsClientServerAddress -InterfaceIndex {index} -ResetServerAddresses")
            } else {
                let list = servers
                    .iter()
                    .map(|s| format!("'{s}'"))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("Set-DnsClientServerAddress -InterfaceIndex {index} -ServerAddresses {list}")
            }
        })
        .collect()
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

/// Restore the snapshotted DNS exactly (any static family → set combined servers; all
/// dhcp → reset to automatic), flush the resolver cache, then drop the snapshot file —
/// but ONLY when every interface restored cleanly. No-op when no snapshot exists.
pub fn restore_system_dns() {
    let raw = match std::fs::read_to_string(snap_path()) {
        Ok(r) => r,
        Err(_) => return,
    };
    // ConvertTo-Json emits a bare object (not an array) for a single entry — accept both.
    // A corrupt/unparseable snapshot yields zero commands and IS deleted below: retrying
    // can never repair it, and keeping it would block future baseline snapshots forever.
    let entries: Vec<DnsEntry> = serde_json::from_str(&raw)
        .or_else(|_| serde_json::from_str::<DnsEntry>(&raw).map(|e| vec![e]))
        .unwrap_or_default();
    // AUDIT-2026-06-11 #17: the snapshot file is the ONLY copy of the pre-VPN baseline.
    // Previously every restore result was discarded and the file unconditionally deleted,
    // so one failed run (interface temporarily absent — undocked laptop, unplugged USB
    // NIC — or PowerShell blocked by AV) destroyed the baseline permanently. Now we track
    // per-command success and keep the snapshot on any failure so the next teardown or
    // startup sweep retries. Keeping the file is safe: snapshot_system_dns's exists-guard
    // means it can never be overwritten with tunnel-resolver state.
    let mut all_restored = true;
    for cmd in build_restore_commands(&entries) {
        if run_ps(&cmd).is_err() {
            all_restored = false;
        }
    }
    // Cache flush is best-effort and must not gate baseline deletion.
    let _ = run_ps("Clear-DnsClientCache");
    if all_restored {
        let _ = std::fs::remove_file(snap_path());
    }
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

    fn entry(index: u32, family: &str, mode: &str, servers: &[&str]) -> DnsEntry {
        DnsEntry {
            index,
            family: family.into(),
            mode: mode.into(),
            servers: servers.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn static_sets_exact_servers() {
        let cmds =
            build_restore_commands(&[entry(12, "IPv4", "static", &["1.1.1.1", "8.8.8.8"])]);
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].contains("-InterfaceIndex 12"));
        assert!(cmds[0].contains("-ServerAddresses '1.1.1.1','8.8.8.8'"));
        assert!(!cmds[0].contains("-ResetServerAddresses"));
    }

    #[test]
    fn dhcp_resets_to_automatic() {
        let cmds = build_restore_commands(&[entry(12, "IPv4", "dhcp", &[])]);
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].contains("-ResetServerAddresses"));
        assert!(!cmds[0].contains("-ServerAddresses '"));
    }

    #[test]
    fn static_but_no_servers_falls_back_to_reset() {
        // A "static" mode with no captured servers must not emit an empty -ServerAddresses.
        let cmds = build_restore_commands(&[entry(12, "IPv4", "static", &[])]);
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].contains("-ResetServerAddresses"));
    }

    #[test]
    fn injection_chars_are_filtered_out() {
        let cmds = build_restore_commands(&[entry(12, "IPv4", "static", &["1.1.1.1'; rm -rf /"])]);
        assert_eq!(cmds.len(), 1);
        assert!(!cmds[0].contains("rm"));
        assert!(!cmds[0].contains(';'));
    }

    // AUDIT-2026-06-11 #18: the four dual-stack interleavings. The per-entry shape used
    // to emit two commands for one interface, where the second (IPv6) clobbered the
    // first because Set-DnsClientServerAddress has no address-family scope.

    #[test]
    fn static_v4_plus_dhcp_v6_keeps_static_v4() {
        let cmds = build_restore_commands(&[
            entry(12, "IPv4", "static", &["192.168.1.5"]),
            entry(12, "IPv6", "dhcp", &["fe80::1"]),
        ]);
        // ONE command for the interface: static v4 wins; the dhcp v6 reset must NOT run
        // (it would wipe the just-restored static IPv4 — the original #18 bug).
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].contains("-ServerAddresses '192.168.1.5'"));
        assert!(!cmds[0].contains("-ResetServerAddresses"));
        // DHCP-provided v6 servers must not be frozen as static.
        assert!(!cmds[0].contains("fe80::1"));
    }

    #[test]
    fn dhcp_v4_plus_static_v6_keeps_static_v6() {
        let cmds = build_restore_commands(&[
            entry(12, "IPv4", "dhcp", &["10.0.0.1"]),
            entry(12, "IPv6", "static", &["2606:4700:4700::1111"]),
        ]);
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].contains("-ServerAddresses '2606:4700:4700::1111'"));
        assert!(!cmds[0].contains("-ResetServerAddresses"));
        // DHCP-provided v4 servers must not be frozen as static.
        assert!(!cmds[0].contains("10.0.0.1"));
    }

    #[test]
    fn all_dhcp_emits_single_reset() {
        let cmds = build_restore_commands(&[
            entry(12, "IPv4", "dhcp", &["10.0.0.1"]),
            entry(12, "IPv6", "dhcp", &["fe80::1"]),
        ]);
        // Both families automatic → exactly one reset, not one per family.
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].contains("-InterfaceIndex 12"));
        assert!(cmds[0].contains("-ResetServerAddresses"));
    }

    #[test]
    fn all_static_combines_both_families_in_one_command() {
        let cmds = build_restore_commands(&[
            entry(12, "IPv4", "static", &["1.1.1.1"]),
            entry(12, "IPv6", "static", &["2606:4700:4700::1111"]),
        ]);
        // Mixed-family list in ONE -ServerAddresses (the cmdlet accepts it); two separate
        // commands would each erase the other family's static list.
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].contains("-ServerAddresses '1.1.1.1','2606:4700:4700::1111'"));
        assert!(!cmds[0].contains("-ResetServerAddresses"));
    }

    #[test]
    fn interfaces_are_grouped_independently() {
        let cmds = build_restore_commands(&[
            entry(12, "IPv4", "static", &["192.168.1.5"]),
            entry(7, "IPv4", "dhcp", &[]),
            entry(12, "IPv6", "dhcp", &[]),
            entry(7, "IPv6", "dhcp", &[]),
        ]);
        // One command per interface, first-seen order: 12 (static wins), then 7 (reset).
        assert_eq!(cmds.len(), 2);
        assert!(cmds[0].contains("-InterfaceIndex 12"));
        assert!(cmds[0].contains("-ServerAddresses '192.168.1.5'"));
        assert!(cmds[1].contains("-InterfaceIndex 7"));
        assert!(cmds[1].contains("-ResetServerAddresses"));
    }
}
