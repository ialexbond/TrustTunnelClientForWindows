//! Egress-interface guard: make the connect immune to OTHER installed network/VPN software.
//!
//! # The defect this works around
//!
//! The C++ core picks, ONCE per process, the single Windows interface every handshake socket is
//! bound to. The picker lives in the `native_libs_common` conan dependency
//! (`utils::win_detect_active_if`, wrapped at `net/src/utils.cpp:598`, called from
//! `trusttunnel/src/auto_network_monitor.cpp:71` and again by `set_system_dns`,
//! `trusttunnel/src/client.cpp:229`). Its algorithm (read from the conan cache source):
//!
//!   1. "physical" adapters := `IfType ∈ {6 Ethernet, 71 Wi-Fi, 243/244 WWAN}` AND
//!      `OperStatus ∈ {Up, Dormant}` AND has a unicast address (`is_physical_adapter`); BOTH the
//!      IPv4 and IPv6 interface indices of each such adapter are recorded;
//!   2. ∩ interfaces holding ANY default route (`0.0.0.0/0` or `::/0`) — the route's OWN metric is
//!      never read (`get_default_route_ifs`);
//!   3. winner := lowest **interface** metric per family, `row.Connected` required
//!      (`get_min_metric_if`); a tie between families is awarded to IPv6.
//!
//! Nothing there branches on the Windows version, and no gateway/reachability check is made. A
//! Hamachi-class virtual NIC — **Radmin VPN** is the confirmed real-world case — registers as
//! `IfType 6` Ethernet, is kept `Up` by its boot-started service even when the product's GUI is
//! closed, and (being "fast") gets a low auto interface metric. It therefore wins the pick, and the
//! core then hard-binds every location ping to it (`bind()` to that adapter's source address +
//! `IP_UNICAST_IF`, `net/src/os_tunnel_win.cpp:521-577`). The pings black-hole →
//! `Failed to ping location` ×5 → `Error: 9 Number of connection attempts exceeded`, while the
//! WinTUN adapter itself came up fine. Windows' own routing never makes this mistake because it
//! sums route+interface metric; the core looks at the interface metric alone.
//!
//! Empirically confirmed by the owner: uninstalling the Radmin VPN drivers (product not even
//! running) flipped the connect from always-fail to working. This is NOT a Windows-10 bug — it is
//! machine-correlated; a Win11 box with such an adapter is affected identically.
//!
//! # The fix
//!
//! `[listener.tun] bound_if` already exists in the core's config and, when set, **disables the
//! auto-detection entirely** (`auto_network_monitor.cpp:54-66`); on Windows it accepts a plain
//! decimal interface index (`:39-44`). So we ask Windows itself which interface reaches the server
//! (`GetBestInterfaceEx`, the same lookup the OS routing uses) and pass that index down.
//!
//! Two honest limits of the `bound_if` contract, so nobody later relies on more than it gives
//! (`auto_network_monitor.cpp:33-46`): only a NON-NUMERIC value fails fast — a numeric index for an
//! adapter that has since vanished is accepted and stored unchecked, so a stale index costs one
//! failed connect cycle before the supervisor respawns and recomputes; and with `bound_if` set the
//! core stops following network changes, so an overridden session does not adapt to Wi-Fi→Ethernet
//! roaming until it respawns. Both are acceptable because on Windows the core has no live
//! re-detection to lose in the first place, and we recompute at every connect and every respawn.
//!
//! Safety gate: we inject ONLY when our answer differs from what the core's algorithm could pick
//! (replicated below). When they provably agree — the healthy majority — nothing is written and the
//! spawned config is byte-identical to today, so a machine that connects now structurally cannot
//! regress. The override goes to a THROWAWAY COPY; the user's real `.toml` is never modified.

use std::collections::HashSet;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Interface descriptions that indicate a virtual / VPN-ish adapter which has no business being the
/// machine's Internet egress. Matched case-insensitively against the adapter description. Used ONLY
/// for logging — never to make the egress decision itself (that is destination-driven, so it needs
/// no vendor list and covers products we have never heard of).
const SUSPECT_ADAPTER_PATTERNS: &[&str] = &[
    "radmin", "famatech", "hamachi", "logmein", "zerotier", "tailscale", "wireguard", "wintun",
    "tap-windows", "openvpn", "amnezia", "anyconnect", "virtualbox", "vmware", "hyper-v",
    "virtual ethernet", "vethernet", "npcap", "nordlynx", "proton", "surfshark", "expressvpn",
];

/// The core's sentinel for "no metric found" (`NL_MAX_METRIC_COMPONENT`).
#[cfg(windows)]
const NL_MAX_METRIC_COMPONENT: u32 = 0x7FFF_FFFF;

/// Serial number for override files, so two overlapping spawns can never write the same path.
static OVERRIDE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Subdirectory (under the portable data dir) for throwaway runtime files.
///
/// It MUST NOT be the data-dir root: `commands::manifest` treats that root as the source of truth
/// for server cards and adopts every config-shaped `.toml` it finds there (`looks_like_config` +
/// the adopt loop). An override copy dropped in the root would show up as a phantom duplicate
/// server card carrying the endpoint password, and deleting the card would delete a file the next
/// connect recreates. `read_dir` there is non-recursive, so a subdirectory is invisible to both the
/// adoption scan and the folder watcher.
const RUNTIME_SUBDIR: &str = "runtime";

/// What we learned about this machine's egress, and what we decided to do about it.
#[derive(Debug, Clone, Default)]
pub struct EgressDecision {
    /// The interface Windows itself would use to reach the server (`GetBestInterfaceEx`).
    pub best_if: Option<u32>,
    /// Every index the core's algorithm COULD pick. Usually one; more than one when interfaces tie
    /// on metric, where the core's winner depends on hash-set iteration order and is therefore not
    /// predictable. `{0}` mirrors the core's "detection failed" result.
    pub core_picks: HashSet<u32>,
    /// The index to write as `bound_if`, when an override is warranted.
    pub inject: Option<u32>,
    /// Foreign virtual adapters found holding a default route (descriptions, for the log).
    pub suspects: Vec<String>,
}

// ─── Windows implementation ──────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        FreeMibTable, GetAdaptersAddresses, GetBestInterfaceEx, GetIpForwardTable2,
        GetIpInterfaceEntry, InitializeIpInterfaceEntry, GAA_FLAG_INCLUDE_GATEWAYS,
        GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
        MIB_IPFORWARD_ROW2, MIB_IPFORWARD_TABLE2, MIB_IPINTERFACE_ROW,
    };
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6,
    };

    /// `IfType` values the core accepts as "physical" (`is_physical_adapter`). Note that virtual
    /// NDIS miniports (Radmin, Hamachi, host-only adapters…) all report `6` — which is exactly why
    /// the core's filter fails to exclude them.
    const PHYSICAL_IF_TYPES: [u32; 4] = [6, 71, 243, 244];
    /// `IfOperStatusUp` / `IfOperStatusDormant`.
    const OPER_STATUS_UP: i32 = 1;
    const OPER_STATUS_DORMANT: i32 = 5;
    /// `ERROR_BUFFER_OVERFLOW` — the expected result of the sizing call.
    const ERROR_BUFFER_OVERFLOW: u32 = 111;

    /// One adapter, reduced to the fields the core's algorithm (and our logging) cares about.
    pub struct AdapterRow {
        /// IPv4 interface index (`IfIndex`); `0` when the adapter is not IPv4-bound.
        pub index: u32,
        /// IPv6 interface index (`Ipv6IfIndex`); `0` when not IPv6-bound. The core records BOTH, so
        /// omitting this would make our replica blind to an IPv6-only foreign adapter.
        pub ipv6_index: u32,
        pub if_type: u32,
        pub oper_status: i32,
        pub has_unicast: bool,
        pub has_gateway: bool,
        pub description: String,
        /// The connection name Windows shows the user (what `Get-NetAdapter` calls `Name`). Ours is
        /// `TrustTunnel (<host>)`, which is how we tell our own tunnel from a foreign one — the
        /// DESCRIPTION cannot do that job, because WireGuard ships the very same `wintun` driver and
        /// therefore the same description as us.
        pub friendly_name: String,
        pub dns: Vec<String>,
    }

    impl AdapterRow {
        /// Faithful port of the dependency's `is_physical_adapter`.
        pub fn is_physical(&self) -> bool {
            PHYSICAL_IF_TYPES.contains(&self.if_type)
                && (self.oper_status == OPER_STATUS_UP || self.oper_status == OPER_STATUS_DORMANT)
                && self.has_unicast
        }

        /// Does this adapter own `index` under either address family?
        pub fn owns(&self, index: u32) -> bool {
            (self.index != 0 && self.index == index)
                || (self.ipv6_index != 0 && self.ipv6_index == index)
        }

        pub fn looks_virtual(&self) -> bool {
            let lower = self.description.to_lowercase();
            SUSPECT_ADAPTER_PATTERNS.iter().any(|p| lower.contains(p))
        }

        /// Is this OUR tunnel adapter? Matched on the connection NAME (`TrustTunnel (<host>)`),
        /// never the description: our description is plain `wintun Tunnel`, which WireGuard also
        /// produces because it ships the same driver — excluding by description would hide a
        /// genuine WireGuard conflict. Once our tunnel is up it holds the default route, so without
        /// this it would report itself as a foreign adapter.
        pub fn is_own_tunnel(&self) -> bool {
            self.friendly_name.to_lowercase().contains("trusttunnel")
        }
    }

    fn wide_to_string(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        // SAFETY: Windows hands us NUL-terminated UTF-16; we walk to the terminator.
        unsafe {
            let mut len = 0usize;
            while *p.add(len) != 0 {
                len += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
        }
    }

    /// Render a `SOCKADDR` as a plain IP string (no port). Only v4/v6 are recognised.
    fn sockaddr_to_ip(sa: *const SOCKADDR) -> Option<String> {
        if sa.is_null() {
            return None;
        }
        // SAFETY: we only read the family, then the matching concrete struct.
        unsafe {
            match (*sa).sa_family {
                f if f == AF_INET => {
                    let v4 = &*(sa as *const SOCKADDR_IN);
                    let b = v4.sin_addr.S_un.S_addr.to_ne_bytes();
                    Some(std::net::Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string())
                }
                f if f == AF_INET6 => {
                    let v6 = &*(sa as *const SOCKADDR_IN6);
                    Some(std::net::Ipv6Addr::from(v6.sin6_addr.u.Byte).to_string())
                }
                _ => None,
            }
        }
    }

    /// Enumerate adapters with the same flags the core uses — EXCEPT that we keep DNS servers
    /// (the core passes `GAA_FLAG_SKIP_DNS_SERVER`; we surface them in the diagnostic dump).
    pub fn enumerate_adapters() -> Vec<AdapterRow> {
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_INCLUDE_GATEWAYS;
        let mut size: u32 = 0;
        // SAFETY: documented two-call pattern — first call sizes the buffer, second fills it. The
        // backing store is a `Vec<u64>` (not `Vec<u8>`) so the allocation is 8-byte aligned as
        // `IP_ADAPTER_ADDRESSES_LH` requires; relying on the allocator to over-align a `u8` buffer
        // would be an implementation detail, not a guarantee.
        unsafe {
            if GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                std::ptr::null(),
                std::ptr::null_mut(),
                &mut size,
            ) != ERROR_BUFFER_OVERFLOW
            {
                return Vec::new();
            }
            let mut buf: Vec<u64> = vec![0; (size as usize).div_ceil(8)];
            let head = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
            if GetAdaptersAddresses(AF_UNSPEC as u32, flags, std::ptr::null(), head, &mut size) != 0
            {
                return Vec::new();
            }
            let mut out = Vec::new();
            let mut cur = head;
            while !cur.is_null() {
                let a = &*cur;
                let mut dns = Vec::new();
                let mut d = a.FirstDnsServerAddress;
                while !d.is_null() {
                    if let Some(ip) = sockaddr_to_ip((*d).Address.lpSockaddr) {
                        dns.push(ip);
                    }
                    d = (*d).Next;
                }
                out.push(AdapterRow {
                    index: a.Anonymous1.Anonymous.IfIndex,
                    ipv6_index: a.Ipv6IfIndex,
                    if_type: a.IfType,
                    oper_status: a.OperStatus,
                    has_unicast: !a.FirstUnicastAddress.is_null(),
                    has_gateway: !a.FirstGatewayAddress.is_null(),
                    description: wide_to_string(a.Description),
                    friendly_name: wide_to_string(a.FriendlyName),
                    dns,
                });
                cur = a.Next;
            }
            out
        }
    }

    /// Every interface index the core would treat as "physical" — BOTH families, zeros skipped,
    /// exactly like the dependency's `win_get_physical_interfaces`.
    pub fn physical_indices(adapters: &[AdapterRow]) -> HashSet<u32> {
        let mut set = HashSet::new();
        for a in adapters.iter().filter(|a| a.is_physical()) {
            if a.index != 0 {
                set.insert(a.index);
            }
            if a.ipv6_index != 0 {
                set.insert(a.ipv6_index);
            }
        }
        set
    }

    /// Interfaces holding a default route, per family — faithful port of `get_default_route_ifs`
    /// (any `0.0.0.0/0` / `::/0` row counts; the route's own metric is deliberately NOT considered,
    /// exactly like the core, so that our replica reproduces the core's candidate set).
    pub fn default_route_ifs() -> (HashSet<u32>, HashSet<u32>) {
        (collect_default_routes(AF_INET), collect_default_routes(AF_INET6))
    }

    fn collect_default_routes(family: u16) -> HashSet<u32> {
        let mut set = HashSet::new();
        let mut table: *mut MIB_IPFORWARD_TABLE2 = std::ptr::null_mut();
        // SAFETY: GetIpForwardTable2 allocates; we read NumEntries rows then FreeMibTable exactly
        // once. `Table` is a flexible array member declared as `[T; 1]`, so we take its address
        // rather than a reference to the 1-element array (whose provenance would not cover row 1+).
        unsafe {
            if GetIpForwardTable2(family, &mut table) != 0 || table.is_null() {
                return set;
            }
            let n = (*table).NumEntries as usize;
            let rows = std::ptr::addr_of!((*table).Table) as *const MIB_IPFORWARD_ROW2;
            for i in 0..n {
                let row = &*rows.add(i);
                if row.DestinationPrefix.PrefixLength == 0 {
                    set.insert(row.InterfaceIndex);
                }
            }
            FreeMibTable(table as *const c_void);
        }
        set
    }

    /// `(metric, connected)` for one interface+family — the input to `get_min_metric_if`.
    fn interface_metric(family: u16, index: u32) -> Option<(u32, bool)> {
        let mut row: MIB_IPINTERFACE_ROW = unsafe { std::mem::zeroed() };
        // SAFETY: documented Initialize→fill-keys→Get pattern.
        unsafe {
            InitializeIpInterfaceEntry(&mut row);
            row.Family = family;
            row.InterfaceIndex = index;
            if GetIpInterfaceEntry(&mut row) != 0 {
                return None;
            }
        }
        Some((row.Metric, row.Connected != 0))
    }

    /// `get_min_metric_if`, but returning EVERY candidate tied at the minimum metric rather than
    /// one winner.
    ///
    /// The dependency keeps the first candidate seen with a strictly-smaller metric while iterating
    /// an `unordered_set`, so when two interfaces tie the winner depends on hash iteration order —
    /// unpredictable from the outside. Ties are common, not exotic: Windows assigns bucketed
    /// automatic metrics (e.g. 25 for every link ≥200 Mb), so a virtual NIC and the real NIC
    /// routinely share one. Returning the whole tied set lets the caller treat an ambiguous pick as
    /// "cannot prove agreement" instead of guessing — guessing wrong in the "agree" direction would
    /// silently skip the fix on exactly the machines that need it.
    fn min_metric_candidates(candidates: &HashSet<u32>, family: u16) -> (u32, HashSet<u32>) {
        let mut min = NL_MAX_METRIC_COMPONENT;
        let mut winners: HashSet<u32> = HashSet::new();
        for &i in candidates {
            if let Some((metric, connected)) = interface_metric(family, i) {
                if !connected {
                    continue;
                }
                if metric < min {
                    min = metric;
                    winners.clear();
                    winners.insert(i);
                } else if metric == min {
                    winners.insert(i);
                }
            }
        }
        (min, winners)
    }

    /// Every index `utils::win_detect_active_if()` could return on this machine.
    ///
    /// Mirrors the dependency step for step, except that a metric tie yields the whole tied set
    /// (see `min_metric_candidates`). `{0}` is the core's own "detection failed" outcome.
    pub fn possible_core_picks(adapters: &[AdapterRow]) -> HashSet<u32> {
        let physical = physical_indices(adapters);
        if physical.is_empty() {
            return HashSet::from([0]);
        }
        let (mut v4, mut v6) = default_route_ifs();
        v4.retain(|i| physical.contains(i));
        v6.retain(|i| physical.contains(i));

        let (min_v4, win_v4) = min_metric_candidates(&v4, AF_INET);
        let (min_v6, win_v6) = min_metric_candidates(&v6, AF_INET6);
        if min_v4 == NL_MAX_METRIC_COMPONENT && min_v6 == NL_MAX_METRIC_COMPONENT {
            return HashSet::from([0]);
        }
        // The core returns the v4 winner ONLY when v4's metric is strictly smaller; every other
        // case (including an exact tie between families) returns the v6 winner. Replicate that
        // asymmetry rather than "improving" it.
        if min_v4 < min_v6 { win_v4 } else { win_v6 }
    }

    /// Ask Windows which interface reaches `ip` — the same routing decision the OS itself makes
    /// (route metric + interface metric), which is what the core's picker fails to do.
    pub fn best_interface_for(ip: IpAddr) -> Option<u32> {
        let mut index: u32 = 0;
        // SAFETY: we build a properly-sized sockaddr for the address family and pass it by pointer.
        let rc = unsafe {
            match ip {
                IpAddr::V4(v4) => {
                    let mut sa: SOCKADDR_IN = std::mem::zeroed();
                    sa.sin_family = AF_INET;
                    sa.sin_addr.S_un.S_addr = u32::from_ne_bytes(v4.octets());
                    GetBestInterfaceEx(&sa as *const _ as *const SOCKADDR, &mut index)
                }
                IpAddr::V6(v6) => {
                    let mut sa: SOCKADDR_IN6 = std::mem::zeroed();
                    sa.sin6_family = AF_INET6;
                    sa.sin6_addr.u.Byte = v6.octets();
                    GetBestInterfaceEx(&sa as *const _ as *const SOCKADDR, &mut index)
                }
            }
        };
        if rc == 0 && index != 0 { Some(index) } else { None }
    }
}

// ─── Non-Windows stubs (the whole guard is a Windows concern) ────────────────────────────────

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub struct AdapterRow {
        pub index: u32,
        pub ipv6_index: u32,
        pub description: String,
        pub friendly_name: String,
        pub has_gateway: bool,
        pub dns: Vec<String>,
    }
    impl AdapterRow {
        pub fn is_physical(&self) -> bool { false }
        pub fn owns(&self, _index: u32) -> bool { false }
        pub fn looks_virtual(&self) -> bool { false }
        pub fn is_own_tunnel(&self) -> bool { false }
    }
    pub fn enumerate_adapters() -> Vec<AdapterRow> { Vec::new() }
    pub fn default_route_ifs() -> (HashSet<u32>, HashSet<u32>) { (HashSet::new(), HashSet::new()) }
    pub fn possible_core_picks(_adapters: &[AdapterRow]) -> HashSet<u32> { HashSet::from([0]) }
    pub fn best_interface_for(_ip: IpAddr) -> Option<u32> { None }
}

// ─── Decision ────────────────────────────────────────────────────────────────────────────────

/// In-tunnel resolvers pinned when we override on a machine whose DNS bootstrap is poisoned.
///
/// Public resolvers ON PURPOSE: `dns_upstreams` are reached THROUGH the tunnel, so pinning the
/// machine's own LAN servers (`192.168.x.1`, an RA link-local…) would be unreachable from the
/// server side and would trade a broken connect for a connected-but-no-DNS session.
const FALLBACK_DNS: &[&str] = &["tls://1.1.1.1", "tls://8.8.8.8"];

/// The whole override decision, as a pure function so every branch is unit-testable without a live
/// network stack.
///
/// Returns `Some(index)` — the value to write as `bound_if` — ONLY when all three hold:
/// * Windows gave us an answer for "which interface reaches the server" (`best_if`);
/// * that interface is one the core itself would treat as a real egress (`best_is_usable`) — this
///   rejects a tunnel/loopback answer, which as `bound_if` would be a routing loop;
/// * agreement with the core cannot be PROVEN, i.e. the set of indices the core could pick is not
///   exactly `{best_if}`. Requiring proof (rather than "differs from our single guess") is what
///   makes a metric tie — where the core's winner is genuinely unpredictable — resolve towards
///   fixing the machine instead of silently skipping it. `{0}` (detection failed) is never equal to
///   a real index, so it too resolves towards injecting.
fn should_inject(best_if: Option<u32>, best_is_usable: bool, core_picks: &HashSet<u32>) -> Option<u32> {
    let best = best_if?;
    if !best_is_usable {
        return None;
    }
    let provably_agrees = core_picks.len() == 1 && core_picks.contains(&best);
    if provably_agrees { None } else { Some(best) }
}

/// The adapters that can actually steal the core's egress pick: a FOREIGN (not ours) virtual NIC
/// that the core's own filter would accept as "physical" AND that holds a default route.
///
/// All three conditions matter. Without the physical-by-IfType filter we would list adapters the
/// core could never choose; without the default-route condition we would list every virtual NIC on
/// the machine, most of which are idle and harmless; and without the own-tunnel exclusion we would
/// report ourselves the moment our tunnel comes up and takes the default route.
fn foreign_rows<'a>(
    adapters: &'a [imp::AdapterRow],
    route_v4: &'a HashSet<u32>,
    route_v6: &'a HashSet<u32>,
) -> impl Iterator<Item = &'a imp::AdapterRow> {
    adapters
        .iter()
        .filter(|a| a.is_physical() && a.looks_virtual() && !a.is_own_tunnel())
        .filter(move |a| {
            route_v4.contains(&a.index)
                || route_v6.contains(&a.index)
                || route_v6.contains(&a.ipv6_index)
        })
}

/// Foreign VPN-ish adapters currently able to hijack our egress, by the name Windows shows the user.
///
/// This is the single definition of "another VPN is in the way", shared by the connect-time egress
/// guard and the UI's second-VPN banner (`commands::vpn::detect_conflicting_adapters`). The banner
/// used to run its own PowerShell scan with a substring match on
/// `WireGuard|Wintun|TAP-Windows|tun|Amnezia|OpenVPN`, which was wrong in three ways at once: the
/// bare `tun` matched Windows' own hidden `… Tunneling Adapter` pseudo-devices and any description
/// that merely contained those letters; it fired on adapters that were merely INSTALLED and idle
/// (an `OpenVPN Data Channel Offload` driver is not a running client); and it could not match the
/// one product that provably breaks connects — Radmin VPN's adapter contains none of those words.
/// Reading the names through `GetAdaptersAddresses` (UTF-16) also fixes the mojibake the PowerShell
/// path produced for non-ASCII names, since its stdout is the console codepage, not UTF-8.
pub fn foreign_adapters_on_default_route() -> Vec<String> {
    let adapters = imp::enumerate_adapters();
    let (route_v4, route_v6) = imp::default_route_ifs();
    foreign_rows(&adapters, &route_v4, &route_v6)
        .map(|a| {
            if a.friendly_name.is_empty() {
                a.description.clone()
            } else {
                a.friendly_name.clone()
            }
        })
        .collect()
}

/// Inspect this machine and decide whether the core needs its egress interface pinned.
///
/// `server_ip` is the resolved dial address of the server we are about to connect to. Without it we
/// cannot ask "which interface reaches the server", so no override is made (behaviour as today).
pub fn decide(server_ip: Option<IpAddr>) -> EgressDecision {
    let adapters = imp::enumerate_adapters();
    let (route_v4, route_v6) = imp::default_route_ifs();
    let core_picks = imp::possible_core_picks(&adapters);

    // Suspicious = a virtual/VPN-ish adapter that the core WOULD consider (physical-by-IfType and
    // holding a default route). A virtual adapter without a default route can never win the pick,
    // so flagging it would be noise. This drives LOGGING only — never the decision.
    let suspects: Vec<String> = foreign_rows(&adapters, &route_v4, &route_v6)
        .map(|a| format!("{} (if {})", a.description, a.index))
        .collect();

    let best_if = server_ip.and_then(imp::best_interface_for);

    // The OS answer is only USABLE as `bound_if` if it names an interface the core itself would
    // consider a real egress (its own `is_physical_adapter` set). This guard is not cosmetic: a
    // live smoke test on the dev machine had `GetBestInterfaceEx` return the WINTUN TUNNEL
    // (`IfType 53`) while a tunnel was up — pinning that would bind the handshake to the tunnel
    // being established, i.e. a routing loop. It also rules out loopback (`IfType 24`). When the OS
    // best route is not a physical adapter we make NO override (behaviour exactly as today) rather
    // than guessing a replacement.
    let best_is_usable = best_if
        .and_then(|idx| adapters.iter().find(|a| a.owns(idx)))
        .map(|a| a.is_physical())
        .unwrap_or(false);

    let inject = should_inject(best_if, best_is_usable, &core_picks);
    if best_if.is_some() && !best_is_usable {
        crate::logging::log_app(
            "INFO",
            "[egress] OS best route points at a non-physical interface (tunnel/loopback) — leaving the core's own choice alone",
        );
    }

    let decision = EgressDecision { best_if, core_picks, inject, suspects };
    log_decision(&decision, server_ip, &adapters);
    decision
}

/// One compact, always-emitted line per connect (plus detail only when something is off), so a
/// field failure is attributable from a single log read. Interface indices and adapter descriptions
/// are not secrets (D-29); the server IP is never logged.
fn log_decision(d: &EgressDecision, server_ip: Option<IpAddr>, adapters: &[imp::AdapterRow]) {
    let mut picks: Vec<String> = d.core_picks.iter().map(|v| v.to_string()).collect();
    picks.sort();
    let best = d.best_if.map(|v| v.to_string()).unwrap_or_else(|| "n/a".into());
    let target = if server_ip.is_some() { "resolved" } else { "unknown" };
    crate::logging::log_app(
        "INFO",
        &format!(
            "[egress] core-could-pick if={{{}}}, os-best-route if={best} (server {target}) -> {}",
            picks.join(","),
            match d.inject {
                Some(i) => format!("PINNING bound_if={i}"),
                None => "no override".to_string(),
            }
        ),
    );
    if !d.suspects.is_empty() {
        crate::logging::log_app(
            "WARN",
            &format!(
                "[egress] foreign virtual adapter(s) on a default route — a known cause of failed connects: {}",
                d.suspects.join("; ")
            ),
        );
    }
    if d.inject.is_some() {
        // The mismatch IS the bug firing. Dump the candidate set once so the cause is provable.
        for a in adapters.iter().filter(|a| a.is_physical()) {
            crate::logging::log_app(
                "INFO",
                &format!(
                    "[egress]   if {} | gw={} | dns={} | {}",
                    a.index,
                    a.has_gateway,
                    a.dns.len(),
                    a.description
                ),
            );
        }
    }
}

// ─── Applying the decision ───────────────────────────────────────────────────────────────────

fn runtime_dir() -> PathBuf {
    crate::ssh::user_data_dir().join(RUNTIME_SUBDIR)
}

/// Delete leftover override copies at startup. They are password-bearing throwaways whose only
/// reader is a sidecar that has long exited, so nothing should outlive the session that wrote it.
/// Mirrors the existing startup sweeps (`kill_stale_sidecar`, `sweep_stale_dns_on_startup`).
pub fn sweep_stale_overrides() {
    let dir = runtime_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("connect_override-") && name.ends_with(".toml") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write the connect config the sidecar should actually load, applying this decision. Returns the
/// path to a THROWAWAY override copy, or `None` when nothing needed changing (the caller then
/// spawns the user's real config, byte-identical to today).
pub fn apply_override(config_path: &str, decision: &EgressDecision) -> Option<PathBuf> {
    let index = decision.inject?;
    let content = match std::fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(e) => {
            crate::logging::log_app("WARN", &format!("[egress] read config failed: {e}"));
            return None;
        }
    };
    let mut doc = match content.parse::<toml_edit::DocumentMut>() {
        Ok(d) => d,
        Err(_) => {
            // D-29: `toml_edit`'s error Display quotes the OFFENDING SOURCE LINE, which for a
            // config corrupted at the password line would put that password in the log. Report
            // only that parsing failed.
            crate::logging::log_app("WARN", "[egress] config is not valid TOML — no override");
            return None;
        }
    };

    // [listener.tun] always exists in configs we generate (ssh/mod.rs build_client_config); for an
    // imported config that lacks it, create it rather than silently skipping the fix.
    let tun = doc
        .entry("listener")
        .or_insert(toml_edit::table())
        .as_table_mut()
        .and_then(|l| l.entry("tun").or_insert(toml_edit::table()).as_table_mut());
    match tun {
        Some(t) => t["bound_if"] = toml_edit::value(index.to_string()),
        None => {
            crate::logging::log_app(
                "WARN",
                "[egress] config has a non-table [listener.tun] — cannot pin bound_if",
            );
            return None;
        }
    }

    // DNS rider, ONLY on a machine we are already overriding (i.e. one whose interface detection is
    // provably wrong). `bound_if` does not fix DNS: `set_system_dns` calls the broken picker itself
    // and on Windows 10 falls back to the dead `fec0::` anycast servers. A user-chosen value always
    // wins; a healthy machine never reaches this code, so nobody's working DNS is touched.
    match doc.get_mut("endpoint").and_then(|e| e.as_table_mut()) {
        Some(endpoint) if endpoint.get("dns_upstreams").is_none() => {
            let mut arr = toml_edit::Array::new();
            for s in FALLBACK_DNS {
                arr.push(*s);
            }
            endpoint["dns_upstreams"] = toml_edit::value(arr);
        }
        _ => {}
    }

    // Throwaway copy, regenerated on every connect. It carries the endpoint password, so it lives
    // under the portable data dir (same protection as the real configs) and goes through the SAME
    // atomic (temp → fsync → rename) writer every other .toml save uses (PP-1); the writer never
    // logs bytes. The filename is unique per spawn so two overlapping connects — e.g. a stale
    // supervisor respawn racing a fresh manual connect to a DIFFERENT server — can never hand one
    // session the other's config.
    let dir = runtime_dir();
    let _ = std::fs::create_dir_all(&dir);
    let seq = OVERRIDE_SEQ.fetch_add(1, Ordering::SeqCst);
    let path = dir.join(format!("connect_override-{seq}.toml"));
    match crate::commands::manifest::write_bytes_atomic(&path, doc.to_string().as_bytes()) {
        Ok(()) => Some(path),
        Err(e) => {
            crate::logging::log_app(
                "WARN",
                &format!("[egress] failed to write override config (spawning the real one): {e}"),
            );
            None
        }
    }
}

/// Convenience for the three spawn sites: read the server's dial IP from the config, decide, apply.
/// Returns the path to spawn with `-c`, or `None` to spawn `config_path` unchanged.
pub fn override_for_connect(config_path: &str) -> Option<PathBuf> {
    let server_ip = crate::commands::ping::config_dial_ip(config_path);
    let decision = decide(server_ip);
    apply_override(config_path, &decision)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picks(v: &[u32]) -> HashSet<u32> {
        v.iter().copied().collect()
    }

    #[test]
    fn override_only_when_agreement_cannot_be_proven() {
        // The Radmin case: the core would bind to the foreign adapter (20) while Windows routes to
        // the real NIC (5) → pin 5.
        assert_eq!(should_inject(Some(5), true, &picks(&[20])), Some(5));
        // Healthy machine — provable agreement, so nothing is written and the config stays
        // byte-identical to today.
        assert_eq!(should_inject(Some(5), true, &picks(&[5])), None);
        // METRIC TIE: the core could pick either 5 or 20 and the winner depends on hash order.
        // "Probably fine" is not good enough — the machine that needs the fix must get it.
        assert_eq!(should_inject(Some(5), true, &picks(&[5, 20])), Some(5));
        // The core's own "detection failed" sentinel is never a real index → inject.
        assert_eq!(should_inject(Some(5), true, &picks(&[0])), Some(5));
        // Windows answered with a tunnel/loopback interface — pinning it would be a routing loop.
        // Observed for real: with a tunnel up, GetBestInterfaceEx returned the wintun adapter.
        assert_eq!(should_inject(Some(18), false, &picks(&[5])), None);
        // No answer at all (hostname-only config / API failure) → behave exactly as today.
        assert_eq!(should_inject(None, false, &picks(&[20])), None);
        assert_eq!(should_inject(None, true, &picks(&[0])), None);
    }

    /// Live smoke test against the real Windows APIs (the FFI is the risky part of this module —
    /// it can compile perfectly and still return garbage). Asserts only invariants that hold on any
    /// Windows box with a network, and prints the full picture under `--nocapture` so a developer
    /// can eyeball this machine's actual egress decision.
    #[cfg(windows)]
    #[test]
    fn live_enumeration_returns_sane_values() {
        let adapters = imp::enumerate_adapters();
        assert!(!adapters.is_empty(), "GetAdaptersAddresses returned nothing — FFI is wrong");
        for a in &adapters {
            assert!(
                a.index != 0 || a.ipv6_index != 0,
                "an adapter must carry at least one non-zero interface index"
            );
            println!(
                "if {:>3}/v6 {:>3} type={:<3} oper={} gw={} dns={:?} :: {}",
                a.index, a.ipv6_index, a.if_type, a.oper_status, a.has_gateway, a.dns, a.description
            );
        }
        assert!(
            adapters.iter().any(|a| a.is_physical()),
            "no adapter passed the core's physical filter — the filter port is wrong"
        );

        let (v4, v6) = imp::default_route_ifs();
        println!("default-route ifs: v4={v4:?} v6={v6:?}");

        let core_picks = imp::possible_core_picks(&adapters);
        let best = imp::best_interface_for("8.8.8.8".parse().unwrap());
        println!("core-could-pick={core_picks:?} os-best-route-to-8.8.8.8={best:?}");
        assert!(!core_picks.is_empty(), "the replica must always yield at least one candidate");
        if let Some(b) = best {
            assert!(
                adapters.iter().any(|a| a.owns(b)),
                "GetBestInterfaceEx returned index {b}, which is not a real adapter — FFI is wrong"
            );
        }
    }

    /// Our own tunnel must never be reported as "another VPN".
    ///
    /// It is excluded by connection NAME, not description: ours reads `wintun Tunnel`, exactly like
    /// a real WireGuard adapter, so a description-based exclusion would either nag about ourselves
    /// or hide a genuine WireGuard conflict. This matters the moment we connect — the tunnel then
    /// holds the default route and would otherwise qualify as a hijacker of our own egress.
    #[cfg(windows)]
    #[test]
    fn our_own_tunnel_is_identified_by_name_not_description() {
        fn row(friendly: &str, desc: &str) -> imp::AdapterRow {
            imp::AdapterRow {
                index: 18,
                ipv6_index: 18,
                if_type: 6,
                oper_status: 1,
                has_unicast: true,
                has_gateway: false,
                description: desc.into(),
                friendly_name: friendly.into(),
                dns: vec![],
            }
        }
        assert!(row("TrustTunnel (de1.example.com)", "wintun Tunnel").is_own_tunnel());
        // Same DRIVER, different product — must NOT be mistaken for ours.
        assert!(!row("WireGuard Tunnel", "wintun Tunnel").is_own_tunnel());
        assert!(!row("Ethernet", "Intel(R) Ethernet Controller I226-V").is_own_tunnel());
        // The description alone cannot tell the two tunnels apart — that is the whole point.
        assert_eq!(
            row("TrustTunnel (x)", "wintun Tunnel").description,
            row("WireGuard Tunnel", "wintun Tunnel").description,
        );
    }

    #[test]
    fn suspect_patterns_cover_the_confirmed_offender_and_the_class() {
        // Radmin VPN is the empirically confirmed case; the list must also catch its class without
        // matching an ordinary physical NIC.
        let hit = |s: &str| {
            let l = s.to_lowercase();
            SUSPECT_ADAPTER_PATTERNS.iter().any(|p| l.contains(p))
        };
        assert!(hit("Radmin VPN Ethernet Adapter"));
        assert!(hit("Hamachi Network Interface"));
        assert!(hit("VirtualBox Host-Only Ethernet Adapter"));
        assert!(hit("TAP-Windows Adapter V9"));
        assert!(!hit("Intel(R) Ethernet Connection I219-V"));
        assert!(!hit("Realtek PCIe GbE Family Controller"));
        assert!(!hit("Intel(R) Wi-Fi 6 AX201 160MHz"));
    }

    #[test]
    fn override_files_live_outside_the_config_adoption_scan() {
        // The data-dir ROOT is the folder-as-truth source for server cards: any config-shaped .toml
        // there is adopted as a card. An override copy must therefore live in a subdirectory, or a
        // phantom duplicate server (with the password inside) appears in the UI.
        let dir = runtime_dir();
        assert_eq!(dir.file_name().unwrap(), RUNTIME_SUBDIR);
        assert_eq!(dir.parent().unwrap(), crate::ssh::user_data_dir());
    }
}
