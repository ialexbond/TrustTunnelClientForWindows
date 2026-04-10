---
phase: 01-connectivity-bypass
plan: 01
subsystem: connectivity
tags: [socket2, ipconfig, network-bypass, logging]
dependency_graph:
  requires: []
  provides: [socket2-bound-connectivity, physical-adapter-detection, verbose-connectivity-logging]
  affects: [gui-app-connectivity, gui-light-dependencies]
tech_stack:
  added: [socket2 0.5, ipconfig 0.3]
  patterns: [spawn_blocking-for-sync-socket2, reqwest-local_address-binding]
key_files:
  created: []
  modified:
    - gui-app/src-tauri/src/connectivity.rs
    - gui-app/src-tauri/Cargo.toml
    - gui-app/src-tauri/tauri.conf.json
    - gui-app/package.json
    - gui-light/src-tauri/Cargo.toml
    - gui-light/src-tauri/tauri.conf.json
    - gui-light/package.json
decisions:
  - socket2 bind in spawn_blocking for sync TCP checks bypassing VPN routing
  - ipconfig crate for Windows adapter enumeration with if_type and description filtering
  - 14 log_app calls for comprehensive file-level connectivity diagnostics
metrics:
  duration: 285s
  completed: 2026-04-10T16:18:32Z
  tasks: 2/2
  files: 7
---

# Phase 01 Plan 01: Restore Connectivity Bypass Summary

Socket2/ipconfig-based connectivity monitoring restored from git history (798ce8e7), binding TCP/HTTP checks to physical adapter IP to bypass VPN routing, with 14 verbose file logging calls for diagnostics.

## Task Results

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Version bump 2.4.0 -> 2.5.0 + socket2/ipconfig deps | 6e979cc6 | 6 version files + 2 Cargo.toml |
| 2 | Restore connectivity.rs with verbose logging | b35fbaa6 | gui-app/src-tauri/src/connectivity.rs |

## Key Implementation Details

### Task 1: Version Bump + Dependencies
- Bumped version from 2.4.0 to 2.5.0 in all 6 files (plan said 2.3.0->2.5.0 but actual was 2.4.0)
- Added `socket2 = { version = "0.5", features = ["all"] }` and `ipconfig = "0.3"` to both gui-app and gui-light Cargo.toml

### Task 2: Connectivity Bypass Restoration
- Replaced 172-line old connectivity.rs with 271-line socket2-bound version
- `find_physical_adapter_ip()` filters adapters by: oper_status UP, has gateway, if_type Ethernet/WiFi, excludes wintun/vpn/virtual/tap descriptions
- TCP checks: socket2 Socket bound to physical IP, connect_timeout 4s, targets 1.1.1.1/8.8.8.8/208.67.222.222 on port 443
- HTTP checks: reqwest Client with local_address(physical_ip), 3 captive portal endpoints
- Fallback: when no physical adapter found, bind is skipped (default routing)
- 4-consecutive-failure threshold preserved before declaring offline
- 14 log_app calls covering: monitor start, adapter detection, cycle info, TCP/HTTP results, state transitions, adapter recovery, give-up

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Version was 2.4.0 not 2.3.0**
- **Found during:** Task 1
- **Issue:** Plan assumed current version 2.3.0, but actual version was 2.4.0 (from v2.4.0 milestone work)
- **Fix:** Bumped 2.4.0 -> 2.5.0 instead of 2.3.0 -> 2.5.0
- **Files modified:** All 6 version files

## Verification Results

- cargo check passes in gui-app/src-tauri (warnings only, no errors)
- connectivity.rs contains: use socket2, find_physical_adapter_ip (3 refs), spawn_blocking (3 refs), local_address (2 refs), 14 log_app calls, ipconfig::get_adapters, consecutive_failures >= 4

## Known Stubs

None - all functionality is fully wired.

## Self-Check: PASSED
