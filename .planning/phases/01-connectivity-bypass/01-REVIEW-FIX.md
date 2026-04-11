---
phase: 01-connectivity-bypass
fixed_at: 2026-04-10T00:00:00Z
review_path: .planning/phases/01-connectivity-bypass/01-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 01: Code Review Fix Report

**Fixed at:** 2026-04-10
**Source review:** .planning/phases/01-connectivity-bypass/01-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5
- Fixed: 5
- Skipped: 0

## Fixed Issues

### WR-01: `adapter_wait > 60` timeout boundary is off by one

**Files modified:** `gui-app/src-tauri/src/connectivity.rs`, `gui-light/src-tauri/src/connectivity.rs`
**Commit:** d9f5ab6d
**Applied fix:** Changed `adapter_wait > 60` to `adapter_wait >= 60` so the timeout matches the documented "60 checks x 5 s = 5 minutes" intent. Updated comment to clarify the math.

### WR-02: `was_online` is reset to `true` after adapter recovery regardless of actual connectivity

**Files modified:** `gui-app/src-tauri/src/connectivity.rs`, `gui-light/src-tauri/src/connectivity.rs`
**Commit:** 3e1563e9
**Applied fix:** Introduced `let mut recovered = false` flag, set to `true` only when `check_adapter_online()` succeeds. After the inner loop, `was_online = recovered` replaces the unconditional `was_online = true`. This prevents double disconnect signals when the adapter never recovers (give_up path). Status: fixed: requires human verification (logic change).

### WR-03: `reqwest::Client::builder().build().unwrap_or_default()` silently falls back to unbound client

**Files modified:** `gui-app/src-tauri/src/connectivity.rs`, `gui-light/src-tauri/src/connectivity.rs`
**Commit:** e0468f0b
**Applied fix:** Replaced `.unwrap_or_default()` with explicit `match` that logs a warning and returns `false` on build failure. Applied to both `check_connectivity` and `check_adapter_online` functions in both files (4 occurrences total). A default-routed client would produce false positive "online" results, so returning false is the correct fallback.

### WR-04: `find_physical_adapter_ip` returns only the first IPv4 address — can bind to wrong adapter on multi-NIC

**Files modified:** `gui-app/src-tauri/src/connectivity.rs`, `gui-light/src-tauri/src/connectivity.rs`
**Commit:** 004f0776
**Applied fix:** Added doc comment to `find_physical_adapter_ip` documenting the multi-homed limitation: the `ipconfig` crate does not expose route metrics, so the function returns the first matching adapter's IP. This ensures future maintainers understand the constraint.

### WR-05: Inner recovery loop does not check `is_connected`

**Files modified:** `gui-app/src-tauri/src/connectivity.rs`, `gui-light/src-tauri/src/connectivity.rs`
**Commit:** f69df60f
**Applied fix:** Added `is_connected.lock()` check at the top of the inner recovery loop. If the VPN was reconnected externally (by the user), the loop exits early with `recovered = true` and without emitting a duplicate "reconnect" event. The `is_connected` Arc is already available inside the spawn closure. Status: fixed: requires human verification (logic change).

## Skipped Issues

None.

---

_Fixed: 2026-04-10_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
