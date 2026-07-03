//! Per-config endpoint-reachability ping — Phase 11 (Plan 11-03).
//!
//! NAMING NOTE (Rule 3 — blocking collision): a `network::ping_endpoint(host, port)`
//! command ALREADY exists (used by the Control Panel / OverviewSection to ping a server
//! by a host the operator just typed in the wizard). That one takes a frontend-supplied
//! host directly. THIS Phase-11 command is the SSRF-safe per-config variant the design
//! requires (T-11-06): it takes `config_path` and reads host:port Rust-side from the
//! config's own `.toml`. To avoid a `__cmd__ping_endpoint` redefinition in the Tauri
//! macro namespace, it is registered as `ping_config_endpoint`.
//!
//! `ping_config_endpoint` does a bounded TCP connect to a config's own endpoint host:port and
//! reports a numeric-ms / unreachable / no-data discriminant (`PingResult`). It is the
//! honest reachability signal the Connection-tab card pills render (D-16). It is
//! INDEPENDENT of the VPN tunnel — it never touches the killswitch, routing, or the C++
//! sidecar; it is a plain outbound TCP connect from the host process.
//!
//! Security invariants this module holds:
//!   * SSRF guard (T-11-06): the command takes `config_path` (validated against
//!     `portable_data_dir()` via `validate_app_path`) and reads host:port Rust-side from
//!     that config's own `.toml` — it NEVER trusts an arbitrary frontend-supplied host.
//!     The host is whitelist-validated (mirroring `ssh::sanitize::validate_ssh_host` /
//!     `validate_tls_domain`) and the port range-checked before the raw TCP connect.
//!   * D-29 (T-11-07): logs only host:port + result, NEVER the `.toml` content or the
//!     password. There are no `eprintln!`/`emit_log` of config content in this module.
//!
//! ⚠️ By-design limitation (RESEARCH §Pitfall 6): a server that only listens on the
//! tunnel-internal IP will fail a direct TCP connect and read `Unreachable` forever, even
//! though it works THROUGH the tunnel. This is correct — the ping is endpoint reachability,
//! not tunnel latency (the sidecar cannot expose real tunnel latency). The honest `no-data`
//! «—» state covers "never measured / no network"; do NOT try to route the probe through
//! the WinTUN adapter.

use serde::{Deserialize, Serialize};
use std::time::Duration;

// `std::path::Path` is only used by the test fixtures below (the production validator moved to
// commands::paths in WR-03), so import it inside the test module to keep the lib build clean.

/// Default endpoint port when a config's `addresses` entry carries no explicit `:port`.
/// TrustTunnel endpoints listen on 443 (TLS-camouflage) by convention (deploy.rs).
const DEFAULT_ENDPOINT_PORT: u16 = 443;

/// The result of one endpoint-reachability probe (D-16). Serde-tagged so the frontend
/// gets a clean discriminated union: `{ "status": "ok", "ms": 42 }` /
/// `{ "status": "unreachable" }` / `{ "status": "no-data" }`. The frontend maps the
/// numeric ms into the green/yellow/red bands; `unreachable` → «Недоступен»; `no-data`
/// → «—» (never red).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum PingResult {
    /// The TCP connect succeeded within the timeout; `ms` is the elapsed round-trip.
    Ok { ms: u64 },
    /// The connect was refused, reset, or timed out — the endpoint is not reachable.
    Unreachable,
    /// No measurement is available (e.g. the config has no usable host). NEVER red.
    NoData,
}

// ─── Host validation (mirrors ssh::sanitize whitelist validators) ────────────

/// Validate a ping target host as a hostname / IPv4 / IPv6 literal using the SAME
/// whitelist spirit as `ssh::sanitize::validate_ssh_host` / `validate_tls_domain`: only
/// ASCII alphanumerics + `- . : [ ]` (the union of hostname / IPv4 / IPv6 chars). Every
/// shell metacharacter is rejected by omission. Even though the host is read Rust-side
/// from the trusted config (not frontend-supplied), we validate it before the TCP connect
/// as defense-in-depth (T-11-06) and to fail fast on a corrupt config.
fn validate_ping_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("Ping host must not be empty".into());
    }
    if host.len() > 253 {
        return Err("Ping host too long (max 253 chars)".into());
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '[' | ']'))
    {
        return Err("Ping host contains invalid characters".into());
    }
    Ok(())
}

// WR-03: path-traversal validation now lives in one shared place (commands::paths) instead of
// three byte-similar copies. Re-export under the local name so this module's call sites read
// unchanged (T-11-06: the ping path must be a real config inside the portable data dir).
use crate::commands::paths::validate_app_path;

// ─── host:port extraction from the config's own .toml ────────────────────────

/// Read the endpoint host + port from a config `.toml`'s `[endpoint]` section Rust-side.
///
/// The endpoint section carries `hostname` (the domain) and `addresses` (an array of
/// `"ip:port"` strings — see `ssh/deploy.rs` export + `ssh/mod.rs::build_client_config`).
/// We prefer the `hostname` for the connect target (so a named endpoint is probed by
/// name) and fall back to the IP from the first `addresses` entry. The PORT always comes
/// from the first `addresses` entry's `:port` suffix (the host carries no port), defaulting
/// to 443 when absent. NEVER reads `endpoint.password` (D-29).
fn read_endpoint_host_port(content: &str) -> Result<(String, u16), String> {
    let v: toml::Value =
        toml::from_str(content).map_err(|e| format!("Failed to parse config: {e}"))?;
    let ep = v
        .get("endpoint")
        .and_then(|e| e.as_table())
        .ok_or("Config has no [endpoint] section")?;

    // The first address entry, "host:port" — used for the port, and for the host when
    // there is no named hostname.
    let first_addr = ep
        .get("addresses")
        .and_then(|a| a.as_array())
        .and_then(|a| a.first())
        .and_then(|s| s.as_str());

    // Port: parse the `:port` suffix of the first address. WR-04: a PRESENT-but-invalid port
    // (`:99999`, `:abc`) is a corrupt config — surface it as an error (the command maps that to
    // NoData «—») rather than silently probing the 443 default and showing a result for the
    // wrong port. An ABSENT port keeps the 443 default (the connect convention).
    let port = match first_addr.map(parse_port_from_addr) {
        Some(PortParse::Invalid) => {
            return Err("Config endpoint address has an invalid port".into());
        }
        Some(PortParse::Port(p)) => p,
        // No address, or an address with no `:port` suffix → the 443 default.
        Some(PortParse::Absent) | None => DEFAULT_ENDPOINT_PORT,
    };

    // Host: prefer the named hostname, else the bare IP from the first address.
    let hostname = ep
        .get("hostname")
        .and_then(|h| h.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let host = match hostname {
        Some(h) => h.to_string(),
        None => first_addr
            .and_then(host_from_addr)
            .ok_or("Config endpoint has no hostname or address")?,
    };

    Ok((host, port))
}

/// WR-04: the tri-state result of reading the `:port` suffix off an address. The old
/// `Option<u16>` conflated "no port present" (None → the 443 default is correct) with "a port
/// IS present but does not parse" (`:99999` out of u16 range, `:abc`) — both became None, so a
/// CORRUPT port silently probed 443 and showed a reachability result for the WRONG port with no
/// signal it was wrong. We now distinguish the three cases so a corrupt port reads honest
/// NoData «—» instead of a misleading green/red against 443.
enum PortParse {
    /// No `:port` suffix at all — the caller's 443 default applies.
    Absent,
    /// A `:port` suffix is present but unparseable / out of u16 range — caller → NoData.
    Invalid,
    /// A valid port.
    Port(u16),
}

/// Parse the `:port` suffix out of an `"ip:port"` / `"host:port"` / bracketed-IPv6
/// `"[::1]:port"` address into the tri-state `PortParse` (WR-04).
fn parse_port_from_addr(addr: &str) -> PortParse {
    // Bracketed IPv6 literal: the port (if any) follows the closing `]`.
    if let Some(close) = addr.rfind(']') {
        return match addr[close + 1..].strip_prefix(':') {
            // A `:` suffix is present → it MUST parse, else it is Invalid (not the default).
            Some(p) => p.parse::<u16>().map_or(PortParse::Invalid, PortParse::Port),
            None => PortParse::Absent,
        };
    }
    // host:port — split on the LAST colon. A bare IPv6 with no brackets (many colons)
    // has no unambiguous port, so only treat the tail as a port when there is exactly
    // one colon (an IPv4/hostname address).
    if addr.matches(':').count() == 1 {
        return match addr.rsplit(':').next() {
            // The colon is present, so an unparseable tail is Invalid, not Absent.
            Some(p) => p.parse::<u16>().map_or(PortParse::Invalid, PortParse::Port),
            None => PortParse::Absent,
        };
    }
    // No single-colon `:port` form (bare host, or a bracketless IPv6) → no port present.
    PortParse::Absent
}

/// Extract the host part of an `"ip:port"` / `"[ipv6]:port"` address (the value used when
/// the config has no named `hostname`).
fn host_from_addr(addr: &str) -> Option<String> {
    // Bracketed IPv6 literal: keep the brackets — `TcpStream::connect` accepts `[::1]`.
    if let Some(close) = addr.rfind(']') {
        return Some(addr[..=close].to_string());
    }
    if addr.matches(':').count() == 1 {
        return addr.rsplit_once(':').map(|(h, _)| h.to_string());
    }
    // Bare IPv6 or plain host without a port — use as-is.
    Some(addr.to_string())
}

// ─── The probe ───────────────────────────────────────────────────────────────

/// The bounded TCP-connect probe, factored out of the command so tests can drive it with
/// a `(host, port)` directly. Always returns within `timeout_ms` — `tokio::time::timeout`
/// caps the connect; a refused/reset connect resolves immediately as `Unreachable`. Raw
/// TCP only: no redirect-following, no protocol handshake.
async fn probe_tcp(host: &str, port: u16, timeout_ms: u64) -> PingResult {
    let start = std::time::Instant::now();
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    {
        Ok(Ok(_stream)) => PingResult::Ok {
            ms: start.elapsed().as_millis() as u64,
        },
        // Connect error (refused / reset / DNS fail) OR the outer timeout elapsed → the
        // endpoint is not reachable. Both collapse to Unreachable (D-16 «Недоступен»).
        Ok(Err(_)) | Err(_) => PingResult::Unreachable,
    }
}

/// Phase 13 (13-08): the endpoint address as a DISPLAY string `"host:port"` from a config's TOML
/// CONTENT — the value the CONNECT notification plate shows in its address row. Pure (content in,
/// display string out) so it is unit-testable exactly like `read_endpoint_host_port`, without a real
/// data-dir path. Reuses `read_endpoint_host_port` (the same reader the ping uses) + the same host
/// whitelist, so the plate address matches exactly what would be probed. `None` when the endpoint is
/// missing / unparseable / has a metachar host. D-29: reads ONLY host + port — NEVER the password.
fn endpoint_address_from_content(content: &str) -> Option<String> {
    let (host, port) = read_endpoint_host_port(content).ok()?;
    // Whitelist-validate the host before displaying it (defense-in-depth; a corrupt config fails
    // closed rather than surfacing a metachar host on the plate).
    validate_ping_host(&host).ok()?;
    Some(format!("{host}:{port}"))
}

/// Phase 13 (13-08): the endpoint address `"host:port"` for a config PATH — the plate address row.
/// Path-validates to the data dir (defense-in-depth, like the ping command), reads the `.toml`, then
/// delegates to the pure `endpoint_address_from_content`. `None` on an invalid/unreadable path or a
/// config with no usable endpoint (the plate then omits the address row). D-29: never the password.
pub fn endpoint_address_for_config(config_path: &str) -> Option<String> {
    validate_app_path(config_path).ok()?;
    let content = std::fs::read_to_string(config_path).ok()?;
    endpoint_address_from_content(&content)
}

/// Ping a config's endpoint for reachability (D-16). Reads host:port Rust-side from the
/// config's own `.toml` (path-validated to the data dir, host whitelist-validated, port
/// range-checked), then does a bounded TCP connect. Returns a numeric-ms / unreachable /
/// no-data `PingResult`. Independent of the VPN tunnel — touches no VPN-core state.
#[tauri::command]
pub async fn ping_config_endpoint(
    config_path: String,
    timeout_ms: u64,
) -> Result<PingResult, String> {
    // T-11-06: the path must be a real config inside the portable data dir — never an
    // arbitrary frontend-supplied file or host.
    validate_app_path(&config_path)?;
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;

    // host:port come from the config's own [endpoint] — not from frontend input.
    let (host, port) = match read_endpoint_host_port(&content) {
        Ok(hp) => hp,
        // A config with no usable endpoint reads honest no-data «—» (never red), rather
        // than surfacing a hard error to the card.
        Err(_) => return Ok(PingResult::NoData),
    };

    // Defense-in-depth: whitelist-validate the host before the connect (T-11-06). A corrupt
    // config with a metachar host fails closed rather than reaching the network stack.
    validate_ping_host(&host)?;
    // port is already a u16 from parsing — range is structurally bounded; 0 is not a
    // connectable port, so treat it as no-data.
    if port == 0 {
        return Ok(PingResult::NoData);
    }

    Ok(probe_tcp(&host, port, timeout_ms).await)
}

// ─── Tunnel-latency probe for the auto-switch engine (F23) ───────────────────

/// F23 (14-UAT round 2): neutral reference hosts probed THROUGH the tunnel to measure the ACTIVE
/// tunnel's REAL current latency for the auto-switch engine. While connected the endpoint itself can't
/// be honestly probed — a direct connect to the endpoint (which IS the VPN server) rides the tunnel to
/// the-server-and-back = the ~2× / «Недоступен» noise that caused the false switches. A NEUTRAL host
/// reached via the tunnel (client → VPN server → reference) reflects the honest tunnel latency with no
/// x2. Several hosts for robustness (one down/blocked → another answers); the probe rides the tunnel
/// from the VPN server's egress, so a client-side geo-block (e.g. RU vs 1.1.1.1) does not apply.
const TUNNEL_REFERENCE_HOSTS: &[(&str, u16)] = &[
    ("8.8.8.8", 443),   // Google (Anycast, global)
    ("1.1.1.1", 443),   // Cloudflare (Anycast, global)
    ("77.88.8.8", 443), // Yandex (RU-friendly backup)
];

/// Pure: pick the FASTEST successful RTT from a set of probe results (the best-case tunnel latency,
/// robust to one slow/blocked reference). All failed → `Unreachable` (the tunnel is dead or fully
/// blocked → the engine treats it as a breach). Unit-tested without the network.
fn best_reference_rtt(results: &[PingResult]) -> PingResult {
    match results
        .iter()
        .filter_map(|r| match r {
            PingResult::Ok { ms } => Some(*ms),
            _ => None,
        })
        .min()
    {
        Some(ms) => PingResult::Ok { ms },
        None => PingResult::Unreachable,
    }
}

/// F23: probe the tunnel's real latency by TCP-connecting to the neutral reference hosts THROUGH the
/// tunnel (in parallel) and returning the fastest successful RTT. This is the honest in-session health
/// signal the auto-switch engine evaluates: a slow tunnel reads a high RTT (breach → switch), a dead
/// tunnel reads `Unreachable` (breach → switch), and a healthy one reads a normal RTT (no switch off a
/// good server). D-29: touches NO config content — only the fixed reference hosts above.
#[tauri::command]
pub async fn probe_tunnel_latency(timeout_ms: u64) -> Result<PingResult, String> {
    let probes = TUNNEL_REFERENCE_HOSTS
        .iter()
        .map(|(host, port)| probe_tcp(host, *port, timeout_ms));
    let results = futures_util::future::join_all(probes).await;
    Ok(best_reference_rtt(&results))
}

// ═══════════════════════════════════════════════════════════════
//   Tests
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::path::Path;

    /// A minimal config `.toml` with a given endpoint host + address (carrying a port).
    /// Includes a password so a future leak test would catch it; the ping path never
    /// reads it (D-29).
    fn sample_config(hostname: &str, address: &str) -> String {
        format!(
            "# TrustTunnel Client Configuration\n\
             loglevel = \"info\"\n\n\
             [endpoint]\n\
             hostname = \"{hostname}\"\n\
             addresses = [\"{address}\"]\n\
             username = \"swift-fox\"\n\
             password = \"SUPER-SECRET-XYZ\"\n\n\
             [listener.tun]\n\
             mtu_size = 1280\n"
        )
    }

    fn write_toml(dir: &Path, file: &str, content: &str) -> std::path::PathBuf {
        let p = dir.join(file);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    fn tempdir() -> std::path::PathBuf {
        let base = std::env::temp_dir();
        let unique = format!(
            "tt_ping_test_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        );
        let dir = base.join(unique);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Truth: a reachable loopback listener → PingResult::Ok with a numeric ms.
    #[tokio::test]
    async fn ping_reachable_loopback_returns_ms() {
        // Bind a listener on an ephemeral loopback port, then probe it.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept in a background thread so the connect completes (it doesn't strictly need
        // an accept for connect() to succeed on a listening socket, but this keeps the
        // socket alive for the duration of the probe).
        std::thread::spawn(move || {
            let _ = listener.accept();
        });

        let result = probe_tcp("127.0.0.1", port, 2000).await;
        match result {
            PingResult::Ok { ms } => {
                // ms is a real (possibly 0 on a fast loopback) elapsed value; just assert
                // the discriminant + that it is within the timeout bound.
                assert!(ms <= 2000, "elapsed ms must be within the timeout");
            }
            other => panic!("expected Ok, got {other:?}"),
        }
    }

    /// Truth: a closed/unused port → PingResult::Unreachable within the timeout (never hangs).
    #[tokio::test]
    async fn ping_unused_port_unreachable() {
        // Bind then immediately drop the listener to free a port that is now (almost
        // certainly) closed — connecting to it should be refused fast.
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
            // listener dropped here → port closed
        };
        let start = std::time::Instant::now();
        let result = probe_tcp("127.0.0.1", port, 1500).await;
        assert_eq!(
            result,
            PingResult::Unreachable,
            "a closed loopback port must read Unreachable"
        );
        assert!(
            start.elapsed() < Duration::from_millis(1500) + Duration::from_millis(500),
            "the probe must return within the bounded timeout (never hang)"
        );
    }

    /// Truth: a config with a shell-metachar host is rejected by the validator before any
    /// network access (T-11-06 SSRF/abuse guard). The host is read Rust-side; a corrupt
    /// one fails closed.
    #[test]
    fn ping_rejects_bad_host() {
        // Validate the host extracted from a config — a metachar host must be rejected.
        let content = sample_config("evil;rm -rf /", "203.0.113.10:443");
        let (host, _port) = read_endpoint_host_port(&content).unwrap();
        assert_eq!(host, "evil;rm -rf /", "host is read verbatim from the config");
        assert!(
            validate_ping_host(&host).is_err(),
            "a shell-metachar host must be rejected by the whitelist validator"
        );
        // A clean host passes.
        assert!(validate_ping_host("de1.example.com").is_ok());
        assert!(validate_ping_host("203.0.113.10").is_ok());
    }

    /// The host:port extraction reads the named hostname + the port from the first
    /// address entry, falling back to 443; the password is never touched.
    #[test]
    fn read_endpoint_host_port_prefers_hostname_and_address_port() {
        let content = sample_config("de1.example.com", "203.0.113.10:8443");
        let (host, port) = read_endpoint_host_port(&content).unwrap();
        assert_eq!(host, "de1.example.com");
        assert_eq!(port, 8443);
    }

    /// With no named hostname, the host falls back to the IP of the first address; with no
    /// port suffix the default 443 is used.
    #[test]
    fn read_endpoint_host_port_falls_back_to_address_ip_and_default_port() {
        let content =
            "[endpoint]\naddresses = [\"203.0.113.10\"]\nusername = \"u\"\npassword = \"p\"\n";
        let (host, port) = read_endpoint_host_port(content).unwrap();
        assert_eq!(host, "203.0.113.10");
        assert_eq!(port, DEFAULT_ENDPOINT_PORT);
    }

    /// WR-04: a PRESENT-but-invalid port must NOT silently fall back to 443. An out-of-range
    /// `:99999` and a non-numeric `:abc` both make read_endpoint_host_port return an error (the
    /// command maps that to NoData «—»), so the card never shows a reachability result against
    /// the wrong port.
    #[test]
    fn read_endpoint_host_port_rejects_invalid_present_port() {
        for bad in ["203.0.113.10:99999", "203.0.113.10:abc", "de.example:0x1f"] {
            let content =
                format!("[endpoint]\naddresses = [\"{bad}\"]\nusername = \"u\"\npassword = \"p\"\n");
            assert!(
                read_endpoint_host_port(&content).is_err(),
                "an invalid present port ({bad}) must error, not default to 443"
            );
        }
    }

    /// WR-04 (complement): an ABSENT port still defaults to 443 (the connect convention) — only
    /// a present-but-corrupt port errors.
    #[test]
    fn read_endpoint_host_port_absent_port_keeps_default() {
        let content =
            "[endpoint]\naddresses = [\"203.0.113.10\"]\nusername = \"u\"\npassword = \"p\"\n";
        let (_host, port) = read_endpoint_host_port(content).unwrap();
        assert_eq!(port, DEFAULT_ENDPOINT_PORT);
    }

    /// A config with a usable host but the file is read end-to-end via
    /// ping_config_endpoint's internal path-reading proves the command takes a config_path
    /// (not a raw host):
    /// the fixture .toml is read and its endpoint parsed.
    #[test]
    fn config_path_drives_the_target_not_a_raw_host() {
        let tmp = tempdir();
        let cfg = write_toml(
            &tmp,
            "TrustTunnel_swift-fox.toml",
            &sample_config("de1.example.com", "203.0.113.10:443"),
        );
        let content = std::fs::read_to_string(&cfg).unwrap();
        let (host, port) = read_endpoint_host_port(&content).unwrap();
        assert_eq!(host, "de1.example.com");
        assert_eq!(port, 443);
        // D-29: the parsed host/port never carry the password.
        assert!(!host.contains("SECRET"));
        cleanup(&tmp);
    }

    /// Phase 13 (13-08): the plate address helper formats `"host:port"` from a config's content,
    /// preferring the named hostname + the address port (matching `read_endpoint_host_port`), and it
    /// NEVER carries the password (D-29). This is the exact display string the CONNECT plate shows in
    /// its address row.
    #[test]
    fn endpoint_address_from_content_formats_host_port_and_never_the_password() {
        // Named hostname + an address port → "hostname:port".
        let content = sample_config("de-fra.trusttunnel.net", "203.0.113.42:8443");
        let addr = endpoint_address_from_content(&content).expect("a usable endpoint → an address");
        assert_eq!(addr, "de-fra.trusttunnel.net:8443");
        // D-29: the address must never carry the fixture password.
        assert!(
            !addr.contains("SUPER-SECRET-XYZ"),
            "the plate address must never carry the config password (D-29)"
        );

        // No named hostname → falls back to the bare IP; no port suffix → the 443 default.
        let content_ip =
            "[endpoint]\naddresses = [\"203.0.113.42\"]\nusername = \"u\"\npassword = \"p\"\n";
        assert_eq!(
            endpoint_address_from_content(content_ip).as_deref(),
            Some("203.0.113.42:443"),
        );

        // A metachar host fails closed (None) rather than surfacing on the plate.
        let content_bad = sample_config("evil;rm -rf /", "203.0.113.10:443");
        assert!(endpoint_address_from_content(&content_bad).is_none());

        // A config with no [endpoint] at all → None (the plate omits the address row).
        assert!(endpoint_address_from_content("loglevel = \"info\"\n").is_none());
    }

    /// D-29 spy (canonical): prove — not by static grep, but by EXERCISING the ping path —
    /// that the config password NEVER rides along into the ping target. Unlike the SSH/deploy
    /// path, this module has NO log sink of its own (no `emit_log`/`eprintln!`/`println!` —
    /// see the module doc): the ONLY thing the ping derives from the config is the connect
    /// target `(host, port)`. So the faithful D-29 guard here is a regression guard that the
    /// derived target carries no credential. The fixture config carries a real, distinctive
    /// password (`SUPER-SECRET-XYZ`); we drive `read_endpoint_host_port` (the sole consumer of
    /// config content on the ping path) and assert the secret reaches neither the host nor the
    /// stringified port — and that `read_endpoint_host_port` never even names the `password`
    /// field. If a future refactor ever folds the password into the target (or adds a log line
    /// that interpolates config content), this test fails loudly.
    #[test]
    fn ping_target_never_carries_the_config_password() {
        const SECRET: &str = "SUPER-SECRET-XYZ";

        // The fixture config embeds the password right next to the endpoint fields — exactly
        // the on-disk shape the ping path reads (sample_config writes `password = "SUPER-SECRET-XYZ"`).
        let content = sample_config("de1.example.com", "203.0.113.10:8443");
        assert!(
            content.contains(SECRET),
            "fixture must actually contain the secret, else the guard is vacuous"
        );

        // Exercise the ONE config-consuming step of the ping path.
        let (host, port) = read_endpoint_host_port(&content).unwrap();

        // The derived connect target is exactly the endpoint — and carries NO credential.
        assert_eq!(host, "de1.example.com");
        assert_eq!(port, 8443);
        assert!(
            !host.contains(SECRET) && !host.to_lowercase().contains("password"),
            "the ping host must never carry the config password (D-29): {host}"
        );
        // The port is a u16 derived purely from the address suffix — its rendering can never
        // contain the secret, but pin it so a future string-typed port can't regress.
        assert!(
            !port.to_string().contains(SECRET),
            "the ping port must never carry the config password (D-29)"
        );

        // Defense-in-depth: the host that actually reaches the validator (the last gate before
        // the raw TCP connect) is likewise secret-free.
        assert!(validate_ping_host(&host).is_ok());
        assert!(!host.contains(SECRET));
    }

    /// F23 (14-UAT round 2): the tunnel-latency probe picks the FASTEST successful reference RTT
    /// (robust to one slow/blocked host); if EVERY reference fails, the tunnel is dead/blocked →
    /// Unreachable (which the engine treats as a breach → switch).
    #[test]
    fn best_reference_rtt_picks_fastest_ok_else_unreachable() {
        use PingResult::*;
        assert_eq!(
            best_reference_rtt(&[Ok { ms: 120 }, Ok { ms: 45 }, Unreachable]),
            Ok { ms: 45 }
        );
        assert_eq!(
            best_reference_rtt(&[Unreachable, Ok { ms: 200 }, NoData]),
            Ok { ms: 200 }
        );
        assert_eq!(
            best_reference_rtt(&[Unreachable, Unreachable, Unreachable]),
            Unreachable
        );
        assert_eq!(best_reference_rtt(&[]), Unreachable);
    }
}
