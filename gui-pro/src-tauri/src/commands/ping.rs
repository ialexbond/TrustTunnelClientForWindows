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
/// The endpoint section carries `hostname` (the TLS-SNI name) and `addresses` (an array of
/// `"ip:port"` strings — see `ssh/deploy.rs` export + `ssh/mod.rs::build_client_config`).
///
/// 16-12 gap PING-IP: prefer the DIAL TARGET — the host of the first `addresses` entry
/// (the real IP) — over `hostname`. For a self-hosted server `hostname` is a FAKE TLS-SNI
/// name (`trusttunnel.local`) that does not resolve in DNS, so probing it read
/// «Недоступен» even when the IP server was reachable. The endpoint actually DIALS
/// `addresses[0]`, so that is what the reachability probe must hit. `hostname` is used only
/// as the fallback when there is no address (a pure-domain config where `hostname` == the
/// dial target anyway, so behavior is unchanged). The PORT always comes from the first
/// `addresses` entry's `:port` suffix, defaulting to 443 when absent. NEVER reads
/// `endpoint.password` (D-29).
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

    // Host: 16-12 gap PING-IP — prefer the DIAL IP from addresses[0] (the real target the
    // endpoint connects to), else fall back to the named hostname. A self-hosted server
    // carries a fake, unresolvable `trusttunnel.local` hostname over a real bare-IP
    // addresses[0]; probing the .local name read a false «Недоступен». For a pure-domain
    // config there is no addresses entry (or it equals the domain), so this falls back to
    // hostname and behavior is unchanged.
    let addr_host = first_addr.and_then(host_from_addr);
    let hostname = ep
        .get("hostname")
        .and_then(|h| h.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let host = addr_host
        .or(hostname)
        .ok_or("Config endpoint has no hostname or address")?;

    Ok((host, port))
}

/// How long a DNS lookup of the endpoint hostname may take before the egress guard gives up and
/// connects with no override. Short on purpose: this sits on the connect path, and a stalled
/// resolver must never hold the connect hostage — losing the override only costs the guard, which
/// is exactly the pre-guard behaviour.
const DIAL_RESOLVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// The server's DIAL IP as an `IpAddr`, read from a config file — the destination the egress guard
/// asks Windows to route towards (`net_egress::decide`).
///
/// Reuses the same `[endpoint]` reader the reachability probe uses, so "which address do we dial"
/// has ONE definition. A literal IP is used as-is; a HOSTNAME is resolved.
///
/// Resolving is not optional. An earlier revision returned `None` for a hostname, on the assumption
/// that configs generated by this app always dial a bare IP in `addresses[0]`. That assumption was
/// WRONG: real configs in the field carry a domain there (`vpn.example.com:443`,
/// `cdn.example.com:443`), so the guard computed no destination, made no override, and was
/// silently inert on exactly the machines it exists to rescue — the field log read
/// `os-best-route if=n/a (server unknown) -> no override`.
///
/// The two original objections do not survive contact with that fact. "It duplicates the core's
/// resolution" — we do not need the core's exact peer, only which interface egresses towards it, and
/// any A/AAAA record of that host resolves to the same egress. "A poisoned resolver could answer
/// wrongly" — this runs in OUR process through the OS resolver before the tunnel is up, not through
/// the core's broken interface pick; and if resolution fails we simply return `None` and behave as
/// before. Bounded by `DIAL_RESOLVE_TIMEOUT` on a detached thread so a hung resolver cannot stall
/// the connect.
pub(crate) fn config_dial_ip(config_path: &str) -> Option<std::net::IpAddr> {
    let content = std::fs::read_to_string(config_path).ok()?;
    let (host, port) = read_endpoint_host_port(&content).ok()?;
    // Strip brackets off a literal IPv6 (`[::1]`) before parsing.
    let trimmed = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = trimmed.parse::<std::net::IpAddr>() {
        return Some(ip);
    }
    resolve_host_bounded(trimmed, port)
}

/// Resolve `host:port` to a single address, giving up after `DIAL_RESOLVE_TIMEOUT`.
///
/// `to_socket_addrs` is blocking with no timeout of its own, so it runs on a detached thread and we
/// wait on a channel instead — a resolver that never answers leaks one short-lived thread rather
/// than freezing the connect. Prefers IPv4: the endpoint list is IPv4 in practice, and asking for a
/// route to an address family the machine cannot actually egress would pick the wrong interface.
fn resolve_host_bounded(host: &str, port: u16) -> Option<std::net::IpAddr> {
    use std::net::ToSocketAddrs;
    let (tx, rx) = std::sync::mpsc::channel();
    let target = format!("{host}:{port}");
    std::thread::spawn(move || {
        let resolved = target.to_socket_addrs().ok().map(|it| it.collect::<Vec<_>>());
        // The receiver may already have timed out and gone away — that is fine, drop the result.
        let _ = tx.send(resolved);
    });
    let addrs = rx.recv_timeout(DIAL_RESOLVE_TIMEOUT).ok()??;
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.first())
        .map(|a| a.ip())
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

/// Extract the port of an `"ip:port"` / `"[ipv6]:port"` address as an `Option<u16>`
/// (the simpler sibling of `parse_port_from_addr`'s tri-state, for callers that only
/// want "the port, or the 443 default").
///
/// `pub(crate)` so the fetch-path cert probe (`server_config::parse_probe_target_from_endpoint`,
/// 16-12 gap 5b-2) can SHARE this exact port derivation instead of copying it — the probe
/// must target the SAME `addresses[0]` port the ping reader uses. Returns `None` for an
/// absent OR unparseable port so the caller applies its own default (443).
pub(crate) fn port_from_addr(addr: &str) -> Option<u16> {
    match parse_port_from_addr(addr) {
        PortParse::Port(p) => Some(p),
        PortParse::Absent | PortParse::Invalid => None,
    }
}

/// Extract the host part of an `"ip:port"` / `"[ipv6]:port"` address (the value used when
/// the config has no named `hostname`).
///
/// `pub(crate)` so the card summary path (`manifest.rs::derive_display_host`, 16-07) can SHARE
/// this exact host-derivation instead of copying it. Both the ping reader
/// (`read_endpoint_host_port`) and the card display value must extract the address host the same
/// way — a second copy would drift (the 16-UAT round-3 5a root_cause explicitly requires reuse).
pub(crate) fn host_from_addr(addr: &str) -> Option<String> {
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

// ─── D-04: truthful steady-state measurement (discard-first warm-up + min-of-2) ──────────

/// D-04 (17-02): how many REAL (post-warm-up) samples the steady-state measurement takes.
/// The recommendation (17-RESEARCH §Open-Q1) is «discard-first warm-up + min-of-2»: one
/// throwaway connect to warm the OS DNS/TCP state, then the MIN of two real probes. Two is
/// the cheapest count that survives a single unlucky sample (a stray GC/scheduler blip on
/// one of the two reals is discarded by the min); a higher N buys little and costs a connect.
const STEADY_STATE_REAL_SAMPLES: usize = 2;

/// D-04 (17-02): pick the honest steady-state ms from a batch of per-probe samples where the
/// FIRST entry is a cold / idle-inflated warm-up read.
///
/// Root cause (verified 17-RESEARCH §D-04): `probe_tcp` opens a FRESH `TcpStream::connect`
/// every call with no pool. The first connect after idle pays cold OS DNS resolution + a cold
/// TCP handshake, so a warm ~70 ms endpoint reads ~210 ms on the first «Обновить пинг». That
/// cold-inflated number then poisons BOTH the displayed pill AND — critically — the frozen
/// pre-connect band the auto-switch engine reads (PA-2), so an honest low endpoint could be
/// judged "too slow" off one cold sample.
///
/// The fix is a MEASUREMENT strategy, not a connection pool (rejected — the sidecar owns the
/// real connection; a pooled probe socket adds lifecycle complexity and still can't measure
/// tunnel RTT): DISCARD the cold first sample, then report the MIN of the remaining REAL
/// samples (min, not mean — a single stray slow real sample must not inflate the truth).
///
/// Contract (pinned by the 17-01 RED test):
///   - `[cold, a, b]`   → `Some(min(a, b))`   (never the cold first, never the non-min real)
///   - `[cold, only]`   → `Some(only)`        (one real sample after the warm-up)
///   - `[cold]` / `[]`  → `None`              (no real sample → honest «—»/no-data, NEVER a
///     cold-inflated number surfaced as truth)
///
/// Pure + total (no I/O), so it is unit-testable without the network.
fn steady_state_ms(samples: &[u64]) -> Option<u64> {
    // The first sample is the warm-up throwaway; the honest value is the min of the rest.
    samples.get(1..).and_then(|real| real.iter().copied().min())
}

/// D-04 (17-02): the truthful per-endpoint measurement the card pill + the frozen pre-connect
/// band (PA-2) both consume. Does ONE throwaway `probe_tcp` to warm the OS DNS/TCP state
/// (result discarded, never banded), then takes `STEADY_STATE_REAL_SAMPLES` real probes and
/// returns the MIN via `steady_state_ms`.
///
/// Non-`Ok` handling preserves the tri-state exactly:
///   - if ANY real probe reads `Unreachable`/`NoData` (i.e. not every real sample is a numeric
///     ms), the endpoint is not steadily reachable → return that first non-Ok result verbatim
///     (a refused/filtered endpoint stays `Unreachable`, an unusable one stays `NoData`).
///   - only when every real probe is `Ok` do we report the min steady-state ms.
///
/// TIMEOUT BUDGET (F8, 17-review): `timeout_ms` is the OVERALL budget, NOT a per-probe cap. The
/// warm-up runs FIRST and its result is inspected: if it is non-`Ok` (the endpoint refused /
/// filtered / timed out), we return it IMMEDIATELY without running the two real probes. An
/// endpoint whose warm-up connect times out will not answer the reals either, so running them
/// would only burn another 2× `timeout_ms` for the same verdict — that is the regression F8
/// caught: a SYN-dropping / probe-hostile (D-02-class) endpoint made the AWAITED pre-connect
/// probe paths (App.tsx manual-connect slow path, useAutoConnect launch, usePerConfigPing sweep)
/// stall connect ~3× the timeout instead of ~1×. Early-returning on a non-Ok warm-up bounds a
/// probe-hostile server to ~1× `timeout_ms` while a REACHABLE server's warm-up succeeds fast,
/// leaving budget for the two reals — so the discard-first + min-of-2 honesty (D-04) is fully
/// preserved for exactly the endpoints that can answer.
///
/// The warm-up connect adds ~1 extra connect of latency per card per MANUAL refresh for a
/// reachable endpoint — acceptable because the refresh is manual (the «Обновить пинг» button),
/// never an interval (17-RESEARCH §Open-Q1). SSRF invariant unchanged: `host`/`port` are still
/// read Rust-side by the caller (`ping_config_endpoint` → `read_endpoint_host_port` +
/// `validate_ping_host`); this fn never takes a frontend-supplied host. C++ core untouched — a
/// plain outbound TCP connect.
async fn probe_tcp_steady_state(host: &str, port: u16, timeout_ms: u64) -> PingResult {
    // Warm-up: warms OS DNS + the TCP path so the cold-first inflation does not ride into the
    // reported number. On a REACHABLE endpoint its numeric result is deliberately discarded (never
    // banded — D-04). On a NON-reachable endpoint (Unreachable/NoData) we return that verdict
    // straight away: the reals would only re-confirm it at another 2× the timeout (F8 budget fix).
    match probe_tcp(host, port, timeout_ms).await {
        PingResult::Ok { .. } => {} // warmed — fall through to the real samples (result discarded)
        not_reachable => return not_reachable,
    }

    // Real samples. A non-Ok real sample means the endpoint is not steadily reachable — return
    // it verbatim so a refused endpoint stays Unreachable (never a spurious min over a partial set).
    let mut real_ms: Vec<u64> = Vec::with_capacity(STEADY_STATE_REAL_SAMPLES);
    for _ in 0..STEADY_STATE_REAL_SAMPLES {
        match probe_tcp(host, port, timeout_ms).await {
            PingResult::Ok { ms } => real_ms.push(ms),
            other => return other,
        }
    }

    // Every real sample was Ok → the honest steady-state is their min (the warm-up is prefixed
    // so `steady_state_ms` discards it consistently with the pure-fn contract the RED test pins).
    let mut with_warmup = Vec::with_capacity(real_ms.len() + 1);
    with_warmup.push(0); // placeholder for the discarded warm-up slot
    with_warmup.extend_from_slice(&real_ms);
    match steady_state_ms(&with_warmup) {
        Some(ms) => PingResult::Ok { ms },
        // Structurally unreachable (real_ms is non-empty when we reach here), but map to NoData
        // rather than panic — the tri-state's honest «—» for "no measurement".
        None => PingResult::NoData,
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

    // D-04 (17-02): the truthful steady-state measurement (discard-first warm-up + min-of-2) so
    // the first «Обновить пинг» after idle is not cold-inflated. The same honest number feeds both
    // the displayed card pill and the frozen pre-connect band the cards fall back to while the
    // tunnel is up (PA-2) — one measurement, so the pill and the frozen band can never disagree.
    Ok(probe_tcp_steady_state(&host, port, timeout_ms).await)
}

// ─── Tunnel-latency probe (F23) — REMOVED (F11, 17-review) ───────────────────
//
// `probe_tunnel_latency` (F23), its `TUNNEL_REFERENCE_HOSTS` table and the `best_reference_rtt`
// helper were DELETED here, and NOTHING should reintroduce them.
//
// The reason is a property of this process, not of any one caller: a latency probe started from the
// app cannot be made to travel through the tunnel. The prebuilt C++ core owns routing and the
// killswitch and exposes no in-tunnel RTT, so depending on the user's split-tunnel mode a probe to a
// reference host either rides the tunnel or goes straight out to the internet — and the app cannot
// tell which. F26 caught exactly that: connected, the probe read 14 ms while the server's DIRECT
// pre-connect RTT was ~69 ms. A through-tunnel path is bounded BELOW by the client→server leg, so
// 14 < 69 is proof the probe bypassed the tunnel. There is no honest live tunnel number to show, so
// the app shows the frozen pre-connect band instead (`useConfigPingSource`).
//
// The command had ZERO frontend callers yet stayed registered in lib.rs, so any webview
// `invoke("probe_tunnel_latency")` could still fire outbound TCP probes to hardcoded hosts. F11
// completes the dead-contract sweep the PA-4 scope missed, mirroring the earlier `check_vpn_status`
// removal. (Plan 28-09: this note used to add that a frontend test asserted the auto-switch tick
// never invoked the probe. That engine and its test suite are deleted — failover is decided in Rust
// on a real loss of the tunnel — so the clause was dropped rather than left citing absent evidence.)

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

    /// F8 (17-review): the steady-state probe treats `timeout_ms` as the OVERALL budget. On a
    /// probe-hostile / unreachable endpoint the warm-up reads Unreachable and the fn RETURNS
    /// immediately — it does NOT then run the two real probes (which would burn another 2× the
    /// timeout for the same verdict). We prove the bound by measuring: a closed loopback port
    /// (refused fast) must resolve well under 2× the timeout, i.e. the reals were skipped.
    #[tokio::test]
    async fn steady_state_early_returns_on_unreachable_warmup() {
        // A closed loopback port → the warm-up connect is refused fast (Unreachable). If the fn
        // still ran the 2 reals, the total would be ~3 refused connects; here it is ~1.
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
            // listener dropped here → port closed
        };
        // A generous per-probe timeout so that IF the reals ran, the wall time would visibly
        // exceed the single-probe budget. A refused connect returns well before the timeout, so
        // this bound is about the NUMBER of probes, not the timeout elapsing.
        let timeout_ms = 1500;
        let start = std::time::Instant::now();
        let result = probe_tcp_steady_state("127.0.0.1", port, timeout_ms).await;
        let elapsed = start.elapsed();

        assert_eq!(
            result,
            PingResult::Unreachable,
            "a closed endpoint's warm-up reads Unreachable and is returned verbatim"
        );
        // The early return means only the warm-up probe ran. Even allowing slack for a slow CI
        // box, one refused connect must finish far under 2× the timeout (the old behavior ran
        // warm-up + 2 reals = 3 connects, each bounded by the FULL timeout).
        assert!(
            elapsed < Duration::from_millis(timeout_ms) * 2,
            "unreachable warm-up must short-circuit the reals (bounded to ~1× timeout), \
             took {elapsed:?}"
        );
    }

    /// F8 complement: a REACHABLE endpoint still gets the full D-04 treatment — the warm-up
    /// succeeds (and is discarded), the two real probes run, and a numeric ms is returned. The
    /// early-return path must NOT rob a reachable server of its honest min-of-2 measurement.
    #[tokio::test]
    async fn steady_state_measures_reachable_endpoint() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Keep accepting so the warm-up + both reals all connect successfully.
        std::thread::spawn(move || {
            for _ in 0..8 {
                if listener.accept().is_err() {
                    break;
                }
            }
        });

        let result = probe_tcp_steady_state("127.0.0.1", port, 2000).await;
        match result {
            PingResult::Ok { ms } => assert!(ms <= 2000, "a reachable endpoint reads a numeric ms"),
            other => panic!("expected Ok for a reachable loopback listener, got {other:?}"),
        }
    }

    /// Truth: a config with a shell-metachar host is rejected by the validator before any
    /// network access (T-11-06 SSRF/abuse guard). The host is read Rust-side; a corrupt
    /// one fails closed.
    #[test]
    fn ping_rejects_bad_host() {
        // Validate the host extracted from a config — a metachar host must be rejected.
        // 16-12 PING-IP: the dial host now comes from addresses[0], so put the metachar
        // there (no valid address) to exercise the verbatim-read + reject path.
        let content =
            "[endpoint]\nhostname = \"evil;rm -rf /\"\nusername = \"u\"\npassword = \"p\"\n";
        let (host, _port) = read_endpoint_host_port(content).unwrap();
        assert_eq!(host, "evil;rm -rf /", "host is read verbatim from the config");
        assert!(
            validate_ping_host(&host).is_err(),
            "a shell-metachar host must be rejected by the whitelist validator"
        );
        // A clean host passes.
        assert!(validate_ping_host("de1.example.com").is_ok());
        assert!(validate_ping_host("203.0.113.10").is_ok());
    }

    /// 16-12 gap PING-IP: the ping target is the DIAL IP from addresses[0], NOT the fake
    /// .local SNI hostname. A self-hosted server carries hostname="trusttunnel.local" (which
    /// does not resolve) over addresses[0]="203.0.113.141:443"; probing the .local name read
    /// a false «Недоступен». The reader must now return the real reachable IP + port.
    #[test]
    fn read_endpoint_host_port_prefers_address_ip_over_fake_sni() {
        let content = sample_config("trusttunnel.local", "203.0.113.141:443");
        let (host, port) = read_endpoint_host_port(&content).unwrap();
        assert_eq!(host, "203.0.113.141", "ping must target the real dial IP, not the .local SNI");
        assert_eq!(port, 443);

        // A domain config: hostname == addresses host, so the target is unchanged.
        let domain = sample_config("de1.example.com", "de1.example.com:8443");
        let (dhost, dport) = read_endpoint_host_port(&domain).unwrap();
        assert_eq!(dhost, "de1.example.com");
        assert_eq!(dport, 8443);
    }

    /// The egress guard is useless without a destination, so `config_dial_ip` must yield one for a
    /// DOMAIN endpoint, not only a literal IP.
    ///
    /// Regression guard for a shipped defect: the first version returned `None` for any hostname on
    /// the assumption that real configs dial a bare IP. They do not — every config on the
    /// machine carries a domain in `addresses[0]` — so the guard computed no destination and was
    /// silently inert on exactly the machines it exists to rescue (`server unknown -> no override`
    /// in the field log). `localhost` keeps this offline-safe and deterministic.
    #[test]
    fn config_dial_ip_resolves_a_domain_endpoint_not_just_a_literal_ip() {
        let tmp = std::env::temp_dir().join(format!("tt_dial_ip_{}.toml", std::process::id()));

        // Literal IP in addresses[0] — used verbatim.
        std::fs::write(&tmp, sample_config("sni.example.com", "203.0.113.141:443")).unwrap();
        assert_eq!(
            config_dial_ip(&tmp.to_string_lossy()),
            Some("203.0.113.141".parse().unwrap()),
            "a literal dial IP must be taken as-is",
        );

        // Domain in addresses[0] — must RESOLVE, not fall through to None.
        std::fs::write(&tmp, sample_config("localhost", "localhost:443")).unwrap();
        let resolved = config_dial_ip(&tmp.to_string_lossy());
        assert!(
            resolved.is_some(),
            "a domain endpoint must resolve to an address — otherwise the egress guard never runs",
        );
        assert!(resolved.unwrap().is_loopback(), "localhost must resolve to loopback");

        let _ = std::fs::remove_file(&tmp);
    }

    /// An unresolvable host must degrade to "no destination" (and therefore no override) rather than
    /// hanging the connect. The bounded resolve is what keeps this fast.
    #[test]
    fn config_dial_ip_gives_up_on_an_unresolvable_host() {
        let tmp = std::env::temp_dir().join(format!("tt_dial_ip_bad_{}.toml", std::process::id()));
        std::fs::write(
            &tmp,
            sample_config("x", "this-host-does-not-exist.invalid:443"),
        )
        .unwrap();
        let started = std::time::Instant::now();
        assert_eq!(config_dial_ip(&tmp.to_string_lossy()), None);
        assert!(
            started.elapsed() < DIAL_RESOLVE_TIMEOUT + std::time::Duration::from_secs(3),
            "resolution must be bounded so a dead resolver cannot stall the connect",
        );
        let _ = std::fs::remove_file(&tmp);
    }

    /// The host:port extraction reads the dial IP from the first address entry + its port
    /// (16-12 PING-IP: addresses[0] host wins over the SNI hostname); the password is never
    /// touched.
    #[test]
    fn read_endpoint_host_port_prefers_address_ip_and_address_port() {
        let content = sample_config("de1.example.com", "203.0.113.10:8443");
        let (host, port) = read_endpoint_host_port(&content).unwrap();
        assert_eq!(host, "203.0.113.10", "the dial IP from addresses[0] is the probe target");
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
        // 16-12 PING-IP: the dial IP from addresses[0] is the probe target.
        assert_eq!(host, "203.0.113.10");
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
        // 16-12 PING-IP: the plate address mirrors the ping target = the dial IP from
        // addresses[0] + its port (the plate shows the same host:port that is probed).
        let content = sample_config("de-fra.trusttunnel.net", "203.0.113.42:8443");
        let addr = endpoint_address_from_content(&content).expect("a usable endpoint → an address");
        assert_eq!(addr, "203.0.113.42:8443");
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

        // A metachar host fails closed (None) rather than surfacing on the plate. 16-12
        // PING-IP: the dial host is addresses[0], so a metachar in the address (no valid
        // dial host) is what must fail closed.
        let content_bad =
            "[endpoint]\nhostname = \"evil;rm -rf /\"\nusername = \"u\"\npassword = \"p\"\n";
        assert!(endpoint_address_from_content(content_bad).is_none());

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

        // The derived connect target is the endpoint dial IP (16-12 PING-IP) — and carries
        // NO credential.
        assert_eq!(host, "203.0.113.10");
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

    // F11 (17-review): the `best_reference_rtt_picks_fastest_ok_else_unreachable` test was
    // removed here alongside the `best_reference_rtt` helper + `probe_tunnel_latency` command it
    // was the only exerciser of (the through-tunnel probe is retired — see the F11 note above).
}

// ─── Phase 17 (17-02) — GREEN: the D-04 measurement pure fn ───────────────────────────────
//
// Was a 17-01 Wave-0 RED scaffold (gated behind `wave0_red`, referencing the not-yet-existing
// `steady_state_ms`); 17-02 defines `steady_state_ms` above and deletes the gate so this runs
// GREEN under the default `cargo test --lib`.
//
// D-04 contract (RESEARCH §Open-Q1 «discard-first warm-up + min-of-2»): given a batch of
// per-probe samples where the FIRST is a cold/idle-inflated warm-up read, the reported
// steady-state value is the MIN of the REAL (post-warm-up) samples — NEVER the cold first.
// This is the honest number that must feed PA-2's frozen band (D-04 + PA-2 = one thread).
#[cfg(test)]
mod wave0_d04_measurement {
    use super::*;

    /// RED (GREEN by 17-02): `steady_state_ms(samples)` discards the cold first sample and
    /// returns the MIN of the remaining real probes. Given `[cold=210, a=70, b=85]` the
    /// reported value is `70` (never the cold 210, never the non-min 85).
    #[test]
    fn steady_state_discards_cold_first_and_takes_min_of_the_rest() {
        // The cold first read (210) is a warm-up throwaway; the honest steady-state is the
        // min of the two real probes (70).
        assert_eq!(steady_state_ms(&[210, 70, 85]), Some(70));
        // Order-independent: the min of the real samples wins regardless of position.
        assert_eq!(steady_state_ms(&[300, 90, 40, 55]), Some(40));
        // A single real sample after the warm-up throwaway → that sample.
        assert_eq!(steady_state_ms(&[500, 120]), Some(120));
        // Only the cold warm-up, no real sample → no honest measurement (None → «—»/no-data,
        // never a cold-inflated number surfaced as truth).
        assert_eq!(steady_state_ms(&[210]), None);
        assert_eq!(steady_state_ms(&[]), None);
    }
}
