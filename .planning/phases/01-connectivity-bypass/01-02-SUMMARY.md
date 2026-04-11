---
phase: 01-connectivity-bypass
plan: 02
subsystem: connectivity
tags: [socket2, ipconfig, gui-light, vpn-bypass, connectivity-monitor]
dependency_graph:
  requires: [01-01]
  provides: [gui-light-connectivity-bypass]
  affects: [gui-light/src-tauri/src/connectivity.rs]
tech_stack:
  added: []
  patterns: [socket2-adapter-binding, ipconfig-adapter-detection, reqwest-local-address]
key_files:
  created: []
  modified:
    - gui-light/src-tauri/src/connectivity.rs
    - gui-app/src-tauri/Cargo.lock
    - gui-light/src-tauri/Cargo.lock
decisions:
  - "Light uses 2 TCP targets (Cloudflare + Google) vs Pro's 3 — sufficient for Light's simpler profile"
  - "Preserved Light's 15s/15s/3-failure timing vs Pro's 30s/20s/4-failure"
metrics:
  duration: "4m 41s"
  completed: "2026-04-10"
  tasks_completed: 2
  tasks_total: 2
---

# Phase 1 Plan 2: Port socket2 Connectivity Bypass to gui-light Summary

Socket2/ipconfig connectivity bypass ported to gui-light with Light's timing profile (15s initial, 15s cycle, 3-failure threshold) and 2 TCP targets

## What Was Done

### Task 1: Port socket2 connectivity bypass to gui-light
- Rewrote `gui-light/src-tauri/src/connectivity.rs` from 131 lines (HTTP-only) to ~250 lines with socket2 binding
- Added `find_physical_adapter_ip()` function (identical to gui-app) using ipconfig crate
- Added socket2-bound TCP connectivity checks via `spawn_blocking` (2 targets: Cloudflare 1.1.1.1, Google 8.8.8.8)
- Added reqwest HTTP fallback with `local_address(physical_ip)` binding (2 endpoints: Google 204, Cloudflare)
- Added `check_adapter_online()` with socket2 TCP + HTTP fallback bound to physical adapter
- Preserved Light timing profile: 15s initial sleep, 15s cycle interval, 3 consecutive failure threshold
- Added 14 `log_app()` calls for verbose file logging across all functions
- **Commit:** `09d2152a`

### Task 2: Verify both editions compile
- `cargo check` in gui-app/src-tauri: passed (5 warnings, 0 errors)
- `cargo check` in gui-light/src-tauri: passed (2 warnings, 0 errors)
- Updated Cargo.lock files with resolved socket2/ipconfig dependency trees
- **Commit:** `c605137e`

## Verification Results

| Check | Result |
|-------|--------|
| `use socket2` in gui-light connectivity.rs | PASS (2 occurrences) |
| `find_physical_adapter_ip` present | PASS (3 occurrences) |
| `spawn_blocking` present | PASS (3 occurrences) |
| `local_address` present | PASS (2 occurrences) |
| `log_app` calls | PASS (14 calls) |
| `Duration::from_secs(15)` for timing | PASS (2 occurrences) |
| `consecutive_failures >= 3` | PASS |
| No `Duration::from_secs(30)` (Pro timing) | PASS (not found) |
| No `Duration::from_secs(20)` (Pro timing) | PASS (not found) |
| gui-app cargo check | PASS |
| gui-light cargo check | PASS |

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

1. **2 TCP targets for Light vs 3 for Pro** — Light uses Cloudflare (1.1.1.1) and Google (8.8.8.8) only, omitting OpenDNS. This is consistent with Light's lighter profile and the plan specification.
2. **Preserved exact gui-app pattern for find_physical_adapter_ip()** — No modifications needed; the adapter detection logic is edition-agnostic.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `09d2152a` | feat(01-02): port socket2 connectivity bypass to gui-light |
| 2 | `c605137e` | chore(01-02): update Cargo.lock files after cargo check |

## Self-Check: PASSED

- [x] gui-light/src-tauri/src/connectivity.rs exists
- [x] Commit 09d2152a found
- [x] Commit c605137e found
- [x] SUMMARY.md exists
