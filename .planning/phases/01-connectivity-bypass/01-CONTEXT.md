# Phase 1: Connectivity Bypass - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Restore VPN connectivity bypass: checks route through the physical network adapter (Ethernet/WiFi), not through the VPN tunnel. Applies to both gui-app and gui-light editions.

</domain>

<decisions>
## Implementation Decisions

### Restoration Strategy
- **D-01:** Restore connectivity.rs from git commit `798ce8e7` (253-line version with socket2 + ipconfig). Do not rewrite from scratch.
- **D-02:** Restore socket2/ipconfig dependencies from commit `308583b6` into both gui-app and gui-light Cargo.toml.

### Fallback Behavior (CONN-04)
- **D-03:** When no physical adapter is found, silently fall back to default routing — no UI notification, no user action required.
- **D-04:** `find_physical_adapter_ip()` is called every monitoring cycle (not cached). If adapter disappears mid-session (Wi-Fi off), automatic switch to default routing. When adapter returns, automatic switch back to bind mode.

### Logging
- **D-05:** Hybrid logging — detailed diagnostics to file log (adapter IP, bind result, endpoint responses), key state changes to UI via emit_log_i18n.
- **D-06:** Verbose file log: every cycle logs found adapter IP, bind success/failure, which endpoint responded.

### Claude's Discretion
- Which specific events emit to UI via emit_log_i18n (recommended: monitor start with adapter name, state transitions online/offline, fallback activation/deactivation)
- Bind fallback strategy when socket2 bind fails due to firewall/split-tunnel (recommended: try without bind as fallback, matching commit 798ce8e7 approach)
- gui-light porting approach: adapt Pro's 253-line version for Light (Light currently has simpler 131-line version with shorter timeouts — maintain Light's lighter behavior profile or unify with Pro)

### False Reconnect Prevention (CONN-05)
- **D-07:** Keep existing 4-consecutive-failure threshold (~80 seconds) before declaring offline. No additional complexity.
- **D-08:** No extra adapter state checking via ipconfig before declaring offline — the multi-endpoint check (TCP + HTTP fallback) is sufficient.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source Code (restore targets)
- `gui-app/src-tauri/src/connectivity.rs` — Current 172-line version WITHOUT socket2 (to be replaced)
- `gui-light/src-tauri/src/connectivity.rs` — Current 131-line Light version WITHOUT socket2 (to be upgraded)

### Git History (restoration source)
- Commit `798ce8e7` — gui-app connectivity.rs with socket2/ipconfig (253 lines, the target version)
- Commit `308583b6` — Cargo.toml with socket2 and ipconfig dependencies

### Requirements
- `.planning/REQUIREMENTS.md` — CONN-01 through CONN-05 acceptance criteria

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `gui-app/src-tauri/src/connectivity.rs` — existing monitor structure (start_monitor, check_connectivity, check_adapter_online)
- `emit_log_i18n` macro — existing i18n logging infrastructure for UI events
- Async logging system (mpsc + batched writes) — file logging already set up

### Established Patterns
- `eprintln!("[connectivity] ...")` — existing prefix pattern for file log messages
- `app.emit("internet-status", json!({...}))` — existing IPC event pattern for frontend
- i18n keys in `ru.json` / `en.json` — new log messages need i18n entries

### Integration Points
- `start_monitor()` called from `lib.rs` in both gui-app and gui-light with `Arc<Mutex<bool>>` for VPN state
- Frontend listens to `internet-status` events for disconnect/reconnect actions
- Cargo.toml in both editions needs socket2 + ipconfig dependencies

</code_context>

<specifics>
## Specific Ideas

- Code already exists in git history — this is a restoration task, not a new implementation
- gui-light version in 798ce8e7 was NOT upgraded (still 131 lines) — Light needs the socket2 binding ported for the first time
- Current gui-light has shorter timeouts (15s vs 20/30s in Pro) — consider preserving this difference

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-connectivity-bypass*
*Context gathered: 2026-04-10*
