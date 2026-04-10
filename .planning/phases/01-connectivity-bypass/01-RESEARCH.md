# Phase 1: Connectivity Bypass - Research

**Researched:** 2026-04-10
**Domain:** Rust / socket2 / ipconfig / Tauri 2 connectivity monitoring
**Confidence:** HIGH (source code confirmed from git history)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Restore connectivity.rs from git commit `798ce8e7` (253-line version with socket2 + ipconfig). Do not rewrite from scratch.
- **D-02:** Restore socket2/ipconfig dependencies from commit `308583b6` into both gui-app and gui-light Cargo.toml.
- **D-03:** When no physical adapter is found, silently fall back to default routing — no UI notification, no user action required.
- **D-04:** `find_physical_adapter_ip()` is called every monitoring cycle (not cached). If adapter disappears mid-session (Wi-Fi off), automatic switch to default routing. When adapter returns, automatic switch back to bind mode.
- **D-05:** Hybrid logging — detailed diagnostics to file log (adapter IP, bind result, endpoint responses), key state changes to UI via emit_log_i18n.
- **D-06:** Verbose file log: every cycle logs found adapter IP, bind success/failure, which endpoint responded.
- **D-07:** Keep existing 4-consecutive-failure threshold (~80 seconds) before declaring offline. No additional complexity.
- **D-08:** No extra adapter state checking via ipconfig before declaring offline — the multi-endpoint check (TCP + HTTP fallback) is sufficient.

### Claude's Discretion
- Which specific events emit to UI via emit_log_i18n (recommended: monitor start with adapter name, state transitions online/offline, fallback activation/deactivation)
- Bind fallback strategy when socket2 bind fails due to firewall/split-tunnel (recommended: try without bind as fallback, matching commit 798ce8e7 approach)
- gui-light porting approach: adapt Pro's 253-line version for Light (Light currently has simpler 131-line version with shorter timeouts — maintain Light's lighter behavior profile or unify with Pro)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CONN-01 | Приложение определяет IP физического адаптера (Ethernet/WiFi), исключая VPN/WinTUN | `find_physical_adapter_ip()` in commit 798ce8e7 uses ipconfig to filter by IfType::EthernetCsmacd and Ieee80211, excludes "wintun"/"vpn"/"virtual"/"tap-" by description |
| CONN-02 | TCP-проверки связи привязываются к физическому адаптеру через socket2 bind() | `check_connectivity()` in 798ce8e7 uses socket2 `Socket::new(Domain::IPV4, Type::STREAM)` + `socket.bind()` to the physical IP, run via `spawn_blocking` |
| CONN-03 | HTTP-проверки используют reqwest с local_address(physical_ip) | `reqwest::Client::builder().local_address(physical_ip).build()` already used in 798ce8e7 as HTTP fallback |
| CONN-04 | При отсутствии физического адаптера — fallback на дефолтную маршрутизацию | 798ce8e7 pattern: `if let Some(ip) = tcp_ip { socket.bind(...) }` — bind is skipped when None, socket connects through default routing |
| CONN-05 | Монитор связи не вызывает ложных переподключений VPN | 4-consecutive-failure threshold already in both current code and 798ce8e7; socket2 binding ensures checks bypass VPN tunnel so they return true while VPN is active |
</phase_requirements>

---

## Summary

This is a restoration task, not new development. The complete target implementation already exists in git commit `798ce8e7` for gui-app (253 lines, using socket2 + ipconfig). The current working branch has regressed to the old 172-line version without socket2 binding.

The core problem being fixed: when VPN is active, connectivity checks that use default routing go through the VPN tunnel. If the VPN itself has a problem, these checks falsely return "offline" and trigger unnecessary VPN reconnects. The fix routes all TCP and HTTP connectivity checks through the physical network adapter (Ethernet/WiFi) via socket2 `bind()` and reqwest `local_address()`, bypassing VPN routing entirely.

gui-light never received the socket2 upgrade — the version in commit `798ce8e7` is identical to the current 131-line version (HTTP-only checks, 15s timeouts). Light needs to be ported from the Pro version for the first time, preserving its lighter timing profile (15s intervals vs. Pro's 20/30s).

**Primary recommendation:** Git-restore 798ce8e7:gui-app/src-tauri/src/connectivity.rs, add socket2/ipconfig to both Cargo.toml files, then adapt the same logic for gui-light while preserving Light's 15s timeout behavior.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| socket2 | 0.5 | Raw socket creation with bind() for adapter-pinned TCP | Only crate that exposes POSIX-level socket bind before connect on Windows |
| ipconfig | 0.3 | Windows network adapter enumeration with IfType, OperStatus, gateways | Only maintained Windows-specific adapter enumeration crate; ipconfig 0.3 is the version already verified in commit 308583b6 |
| reqwest | 0.13.2 | HTTP connectivity checks with `local_address()` support | Already in both Cargo.toml files; 0.13.x added stable `local_address()` on the ClientBuilder |
| tokio | 1 (full) | Async runtime, `spawn_blocking` for socket2 sync calls | Already in project |

[VERIFIED: git show 308583b6:gui-app/src-tauri/Cargo.toml — socket2 = { version = "0.5", features = ["all"] }, ipconfig = "0.3"]

### Crate Feature Requirements
- `socket2` must have `features = ["all"]` — this enables `connect_timeout()` and `SockAddr` conversions used in the target code [VERIFIED: 308583b6 Cargo.toml]
- `ipconfig` 0.3 has no required features beyond default

**Installation (gui-app Cargo.toml addition):**
```toml
ipconfig = "0.3"
socket2 = { version = "0.5", features = ["all"] }
```

**Installation (gui-light Cargo.toml addition):**
```toml
ipconfig = "0.3"
socket2 = { version = "0.5", features = ["all"] }
```

---

## Architecture Patterns

### Key Pattern: Adapter Detection + Bind-per-Cycle

`find_physical_adapter_ip()` is a sync function called at the top of both `check_connectivity()` and `check_adapter_online()`. It is NOT cached — called fresh each cycle so that Wi-Fi toggling during a session automatically switches bind mode. [VERIFIED: 798ce8e7 source]

```rust
// Source: git show 798ce8e7:gui-app/src-tauri/src/connectivity.rs
fn find_physical_adapter_ip() -> Option<IpAddr> {
    let adapters = ipconfig::get_adapters().ok()?;
    adapters
        .iter()
        .filter(|a| a.oper_status() == ipconfig::OperStatus::IfOperStatusUp)
        .filter(|a| !a.gateways().is_empty())
        .filter(|a| {
            let if_type = a.if_type();
            if_type == ipconfig::IfType::EthernetCsmacd
                || if_type == ipconfig::IfType::Ieee80211
        })
        .filter(|a| {
            let desc = a.description().to_lowercase();
            !desc.contains("wintun")
                && !desc.contains("vpn")
                && !desc.contains("virtual")
                && !desc.contains("tap-")
        })
        .flat_map(|a| a.ip_addresses().iter().copied())
        .find(|ip| ip.is_ipv4())
}
```

### Key Pattern: socket2 in spawn_blocking

socket2 is a sync API. It must run inside `tokio::task::spawn_blocking`. The target code wraps the entire TCP check loop in spawn_blocking and moves the `Option<IpAddr>` into the closure. [VERIFIED: 798ce8e7]

```rust
// Source: git show 798ce8e7:gui-app/src-tauri/src/connectivity.rs
let tcp_ip = physical_ip;
let tcp_ok = tokio::task::spawn_blocking(move || {
    // ... socket creation and bind inside here
}).await.unwrap_or(false);
```

### Key Pattern: Graceful Bind Fallback

When `tcp_ip` is `None` (no physical adapter found), the bind call is simply skipped — the socket connects through default routing. This is the CONN-04 fallback. No error is surfaced to the user. [VERIFIED: 798ce8e7]

```rust
if let Some(ip) = tcp_ip {
    if socket.bind(&SockAddr::from(SocketAddr::new(ip, 0))).is_err() {
        continue;  // skip this target if bind fails
    }
}
// if tcp_ip is None: no bind, connect via default routing
```

### Key Pattern: reqwest local_address Fallback

The HTTP fallback path uses `reqwest::Client::builder().local_address(physical_ip)`. The `local_address()` method accepts `Option<IpAddr>` — passing `None` silently uses default routing. [VERIFIED: 798ce8e7]

```rust
let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(5))
    .local_address(physical_ip)  // Option<IpAddr>, None = default routing
    .build()
    .unwrap_or_default();
```

### Pattern: Logging Integration

The project uses `crate::logging::log_app(level, message)` for file logging (calls `sanitize()` automatically). For UI events the established pattern is `app.emit("internet-status", serde_json::json!({...}))`. [VERIFIED: grep of gui-app/src-tauri/src/]

There is no `emit_log_i18n` macro in the current codebase — the CONTEXT.md D-05 reference to it appears to be aspirational (from an earlier planning discussion). The actual logging infrastructure is `crate::logging::log_app()` for file and `app.emit()` for UI. The planner should use `crate::logging::log_app()` for the verbose file logging requirement (D-06).

[VERIFIED: grep results show no macro_rules emit_log_i18n exists in gui-app or gui-light; only `emit_log` function exists in ssh/mod.rs for deploy logs]

### Anti-Patterns to Avoid

- **Caching find_physical_adapter_ip()**: Decision D-04 explicitly requires per-cycle calls. Caching would break the auto-recovery when Wi-Fi toggles.
- **Sync socket2 in async context**: Must use `spawn_blocking`. Calling socket2 directly in async will block the Tauri async runtime.
- **Using `tokio::net::TcpStream::connect()` for bound checks**: Tokio's TcpStream has no bind support — socket2 is required for this.
- **Panicking on spawn_blocking failure**: Use `.await.unwrap_or(false)` as in the target — never `.unwrap()`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Windows adapter enumeration | Custom WinAPI calls | ipconfig 0.3 | Handles IfType, OperStatus, gateway enumeration correctly; WinAPI requires FFI and complex struct handling |
| Adapter-bound TCP connections | Custom socket setup | socket2 0.5 | Handles platform differences for bind-before-connect; extensive edge case handling |
| HTTP with source IP binding | Custom HTTP implementation | reqwest 0.13.2 with local_address() | Already in project; local_address() does the right thing across TLS too |

---

## Runtime State Inventory

> Not applicable — this is a code restoration/upgrade, no rename or data migration involved.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust toolchain | cargo build | Must be present | Not probed (CI/dev machine) | None |
| socket2 crate | CONN-02 | Will be added to Cargo.toml | 0.5.x (from crates.io) | None — required |
| ipconfig crate | CONN-01 | Will be added to Cargo.toml | 0.3.x (from crates.io) | None — required |
| reqwest crate | CONN-03 | Already present | 0.13.2 | N/A |
| tokio crate | spawn_blocking | Already present | 1.x full | N/A |

[VERIFIED: both Cargo.toml files confirmed — reqwest 0.13.2 and tokio 1 full already present]

---

## Common Pitfalls

### Pitfall 1: socket2 features = ["all"] Missing
**What goes wrong:** `connect_timeout()` method does not exist, `SockAddr` conversions unavailable — compile error.
**Why it happens:** These methods are gated behind the `"all"` feature flag in socket2 0.5.
**How to avoid:** Add exactly `socket2 = { version = "0.5", features = ["all"] }` — not just `socket2 = "0.5"`.
**Warning signs:** Compile error mentioning `connect_timeout` not found or `SockAddr` not in scope.

### Pitfall 2: ipconfig IfType Variants Change Between Versions
**What goes wrong:** `ipconfig::IfType::EthernetCsmacd` or `Ieee80211` not found at compile time.
**Why it happens:** ipconfig crate API changed between versions. Version 0.3 has these exact names.
**How to avoid:** Use `ipconfig = "0.3"` exactly as in commit 308583b6. Do not use 0.4+ without verifying variant names.
**Warning signs:** Compile error on IfType enum variants.

### Pitfall 3: spawn_blocking Return Type Confusion
**What goes wrong:** Type mismatch between the inner return type and `.await` result.
**Why it happens:** `spawn_blocking` returns `Result<T, JoinError>`, so `.await` yields `Result<bool, JoinError>`.
**How to avoid:** Always chain `.unwrap_or(false)` after `.await` — matches the pattern in 798ce8e7.

### Pitfall 4: gui-light Missing logging Module
**What goes wrong:** Using `crate::logging::log_app()` in gui-light connectivity.rs fails to compile because gui-light has its own logging.rs that may have a different or missing API.
**Why it happens:** Light's logging.rs is a separate copy. Need to verify it exposes the same `log_app()` function.
**How to avoid:** Read gui-light/src-tauri/src/logging.rs before adding logging calls; mirror exactly the same API as Pro, or use only `eprintln!()` in Light if the API differs.

### Pitfall 5: Version Bump Required Before First Commit
**What goes wrong:** Commit goes out without version bump — violates project memory rule feedback_version_bump.md.
**Why it happens:** Forgetting the first-change-in-branch rule.
**How to avoid:** Wave 0 task must bump version from 2.3.0 to 2.5.0 in all 6 files (gui-app/Cargo.toml, gui-app/tauri.conf.json, gui-app/package.json, gui-light/Cargo.toml, gui-light/tauri.conf.json, gui-light/package.json).

---

## Code Examples

### Complete Target: gui-app connectivity.rs (253 lines)
[VERIFIED: git show 798ce8e7:gui-app/src-tauri/src/connectivity.rs]

The full file is retrievable with:
```bash
git show 798ce8e7:gui-app/src-tauri/src/connectivity.rs
```

Key sections:
- Lines 1-5: `use socket2::{Socket, Domain, Type, Protocol, SockAddr};` + `use std::net::{IpAddr, SocketAddr};`
- `find_physical_adapter_ip()` — sync fn returning `Option<IpAddr>`
- `check_connectivity()` — async, calls find_physical_adapter_ip, then spawn_blocking for TCP, then reqwest with local_address
- `check_adapter_online()` — same pattern as check_connectivity but a single target (1.1.1.1:443)
- `start_monitor()` — identical structure to current 172-line version; 30s initial sleep, 20s cycle, 4-failure threshold

### gui-light Adaptation Pattern

gui-light in commit 798ce8e7 is the SAME as the current 131-line version — it was never upgraded. The port requires:

1. Add the same imports: `use socket2::{Socket, Domain, Type, Protocol, SockAddr}; use std::net::{IpAddr, SocketAddr};`
2. Add `find_physical_adapter_ip()` function (identical to Pro version)
3. Replace `check_connectivity()` to use socket2 TCP first, then reqwest with `local_address()`
4. Replace `check_adapter_online()` to use socket2 TCP first, then reqwest with `local_address()`
5. Keep Light's timing profile: 15s initial sleep, 15s cycle, 3-failure threshold (not the Pro 30s/20s/4-failure values)
6. Keep Light's lighter endpoint list (2 HTTP endpoints vs Pro's 3 TCP + 3 HTTP)

### Cargo.toml Diff (both editions)
```toml
# Add these two lines to [dependencies]:
ipconfig = "0.3"
socket2 = { version = "0.5", features = ["all"] }
```

### File Logging Pattern (existing project standard)
```rust
// Source: verified from gui-app/src-tauri/src/commands/vpn.rs
crate::logging::log_app("INFO", &format!("[connectivity] Using physical adapter: {ip}"));
crate::logging::log_app("DEBUG", "[connectivity] No physical adapter found, default routing");
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Default routing TCP/HTTP checks | socket2 bind + reqwest local_address | Commit 798ce8e7 (then lost) | Bypasses VPN tunnel — eliminates false "offline" detections while VPN active |
| HTTP-only checks in Light | TCP-first + HTTP fallback | This phase (first time for Light) | Faster detection; TCP connect is lighter than full HTTP |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | emit_log_i18n does not exist in current codebase; use crate::logging::log_app() instead | Architecture Patterns | Low — if macro exists somewhere else, compile will succeed but wrong logging path used |
| A2 | gui-light/src-tauri/src/logging.rs exposes the same log_app() API as gui-app | Common Pitfalls | Medium — if Light has no log_app(), logging calls in Light connectivity.rs will fail to compile |
| A3 | Light's 15s/3-failure timing profile should be preserved per Claude's Discretion | Standard Stack | Low — this is explicitly noted as discretionary; planner should document the decision |

---

## Open Questions

1. **gui-light logging.rs API**
   - What we know: gui-light has its own logging.rs (confirmed by ls of src/)
   - What's unclear: whether it exposes `log_app()` with the same signature
   - Recommendation: Planner's Wave 0 or first task should read gui-light/src-tauri/src/logging.rs before adding logging calls; fall back to `eprintln!()` if API differs

2. **UI Events for Connectivity State**
   - What we know: D-05 mentions emit_log_i18n but this macro does not exist in the codebase
   - What's unclear: intended UI notification mechanism for adapter state changes
   - Recommendation: Use existing `app.emit("internet-status", ...)` for state transitions (already done in start_monitor); use `crate::logging::log_app()` for file-only diagnostics. No new events needed.

---

## Validation Architecture

No automated test framework detected for Rust backend (no `#[cfg(test)]` in connectivity.rs, no test directory for Tauri commands). Validation is manual/smoke-test only for this phase.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | Notes |
|--------|----------|-----------|-------------------|-------|
| CONN-01 | find_physical_adapter_ip returns non-VPN IP | manual | `cargo check` (compile only) | Requires real network adapter to validate at runtime |
| CONN-02 | TCP checks bind to physical adapter | manual | `cargo check` | Observable via Wireshark/netstat during VPN session |
| CONN-03 | HTTP checks use local_address | manual | `cargo check` | reqwest API enforces at compile time |
| CONN-04 | Fallback when no adapter | manual | `cargo check` | Testable by disabling all physical adapters |
| CONN-05 | No false reconnects while VPN active | manual | integration run | Observe during 10-min VPN session |

### Sampling Rate
- **Per task commit:** `cargo check` in both gui-app/src-tauri and gui-light/src-tauri
- **Phase gate:** Full `cargo build` in both editions before marking complete

### Wave 0 Gaps
- No test file gaps — this phase has no automated unit tests; cargo check is the verification gate

---

## Security Domain

No new attack surface introduced. This phase:
- Reads network adapter info via ipconfig (read-only OS API)
- Makes outbound TCP/HTTP connections to well-known public IPs (1.1.1.1, 8.8.8.8, etc.)
- Does not accept inbound connections
- Does not handle user input or credentials

No ASVS categories apply to this phase.

---

## Sources

### Primary (HIGH confidence)
- `git show 798ce8e7:gui-app/src-tauri/src/connectivity.rs` — complete 253-line target implementation, verified line by line
- `git show 308583b6:gui-app/src-tauri/Cargo.toml` — confirmed socket2 0.5 features=["all"] and ipconfig 0.3
- `git show 308583b6:gui-light/src-tauri/Cargo.toml` — confirmed socket2/ipconfig NOT in Light's historical Cargo.toml
- `git show 798ce8e7:gui-light/src-tauri/src/connectivity.rs` — confirmed Light was NOT upgraded in that commit (131-line HTTP-only version)
- Current `gui-app/src-tauri/Cargo.toml` — confirmed socket2/ipconfig missing from current branch
- Current `gui-light/src-tauri/Cargo.toml` — confirmed socket2/ipconfig missing from current branch
- grep of gui-app/src-tauri/src/ — confirmed crate::logging::log_app() is the file logging pattern; no emit_log_i18n macro exists

### Secondary (MEDIUM confidence)
- CONTEXT.md D-01 through D-08 — locked decisions from discuss-phase

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions verified directly from git history
- Architecture: HIGH — entire target implementation available from git, no guessing
- Pitfalls: HIGH for socket2 feature flag (confirmed from source); MEDIUM for gui-light logging API (not yet read)

**Research date:** 2026-04-10
**Valid until:** 2026-05-10 (stable Rust ecosystem)
