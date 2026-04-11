---
phase: 01-connectivity-bypass
reviewed: 2026-04-10T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - gui-app/src-tauri/src/connectivity.rs
  - gui-light/src-tauri/src/connectivity.rs
findings:
  critical: 0
  warning: 5
  info: 3
  total: 8
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-04-10
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Both files implement the same connectivity monitor pattern: a loop that detects internet loss while the VPN is active, signals the frontend to disconnect, then polls for physical adapter recovery. The Light version differs only in timing constants (15 s vs 20/30 s) and target count (2 TCP targets vs 3). The implementation is generally sound, but there are five logic/correctness warnings and three informational items that could cause silent failures, incorrect behavior on multi-homed adapters, or double-emit of reconnect events.

---

## Warnings

### WR-01: `adapter_wait > 60` timeout boundary is off by one — adapter gets 61 polls, not 60

**File:** `gui-app/src-tauri/src/connectivity.rs:86` / `gui-light/src-tauri/src/connectivity.rs:87`

**Issue:** The guard condition is `adapter_wait > 60`, but `adapter_wait` is incremented *before* the check. So the loop runs for adapter_wait values 1..=61, which is 61 iterations × 5 s = 305 s (~5 min 5 s). The comment says "5 minutes". This is a minor off-by-one but it means the timeout is slightly longer than documented and is inconsistent with the stated intent.

**Fix:**
```rust
// Change > 60 to >= 60 to match "60 checks × 5 s = 5 minutes"
if adapter_wait >= 60 {
```

---

### WR-02: `was_online` is reset to `true` after adapter recovery regardless of actual connectivity

**File:** `gui-app/src-tauri/src/connectivity.rs:98-99` / `gui-light/src-tauri/src/connectivity.rs:98-99`

**Issue:** After the inner recovery loop exits (either via successful reconnect or give_up), `was_online` is unconditionally set to `true` (line 99). If the loop exited via `give_up` (adapter never came back), `was_online = true` causes the outer loop to immediately re-enter the "4 consecutive failures" path on the next cycle without any real reconnection, emitting a second `"action": "disconnect"` to the frontend even though the VPN was never reconnected. This can cause repeated disconnect signals to an already-disconnected frontend.

**Fix:** Only reset `was_online` to `true` when the adapter actually recovered (i.e., inside the `check_adapter_online()` success branch), not after `give_up`:

```rust
// Inside the inner loop, in the give_up branch:
app.emit("internet-status", serde_json::json!({
    "online": false,
    "action": "give_up"
})).ok();
// Leave was_online = false so the outer loop doesn't re-trigger disconnect
// was_online = true;   // <-- remove from here
break;

// After the inner loop:
consecutive_failures = 0;
// was_online = true;   // Remove the unconditional reset
// was_online is now true only if set inside the adapter-recovered branch
```

Alternatively, track recovery success with a boolean flag:

```rust
let mut recovered = false;
loop {
    // ...
    if check_adapter_online().await {
        // ...
        recovered = true;
        break;
    }
    if adapter_wait > 60 {
        // emit give_up
        break;
    }
}
consecutive_failures = 0;
was_online = recovered;
```

---

### WR-03: `reqwest::Client::builder().build().unwrap_or_default()` silently falls back to an unbound client

**File:** `gui-app/src-tauri/src/connectivity.rs:197-202` / `gui-light/src-tauri/src/connectivity.rs:198-202`
Also: `gui-app/src-tauri/src/connectivity.rs:261-265` / `gui-light/src-tauri/src/connectivity.rs:261-265`

**Issue:** When `local_address(physical_ip)` is set and the client `.build()` fails, `.unwrap_or_default()` creates a client with no `local_address` binding. The entire purpose of building with `local_address` is to bypass VPN routing. A default client routes through the VPN, producing a false positive "online" result when the physical adapter is actually down. There is no log entry for this fallback, so it is silent.

**Fix:**
```rust
let client = match reqwest::Client::builder()
    .timeout(Duration::from_secs(5))
    .local_address(physical_ip)
    .build()
{
    Ok(c) => c,
    Err(e) => {
        log_app("WARN", &format!("[connectivity] Failed to build bound HTTP client: {e}"));
        // Skip HTTP check entirely — a default-routed client would give false positives
        return false;
    }
};
```

---

### WR-04: `find_physical_adapter_ip` returns only the first IPv4 address of the first matching adapter — can bind to a secondary address on a dual-NIC machine

**File:** `gui-app/src-tauri/src/connectivity.rs:108-139` / `gui-light/src-tauri/src/connectivity.rs:109-140`

**Issue:** The iterator calls `.flat_map(|a| a.ip_addresses().iter().copied()).find(|ip| ip.is_ipv4())`. This flattens IP addresses across *all* matching adapters and returns the first IPv4 found. On machines with two physical adapters (e.g., Ethernet + WiFi both up with gateways), the selected IP may belong to the secondary adapter that has no actual default route, causing bind-based checks to fail and fall through to default routing. There is no way to distinguish the adapter with the lowest metric/default gateway.

**Fix:** Prefer the adapter whose gateway list is non-empty AND which has the lowest route metric. Since `ipconfig` does not expose metric, a simpler heuristic is to return the IP per *adapter* (not globally flattened), so callers can try each adapter in sequence:

```rust
// Return first IP of the first suitable adapter (current behavior, but documented)
// Document the limitation:
/// NOTE: On multi-homed systems this returns the first matching adapter's IP.
/// If that adapter lacks a default route, TCP bind checks will fail and the
/// function falls back to VPN-routed checks via HTTP unwrap_or_default.
```

At minimum, add a comment noting this limitation so future maintainers understand why false-negatives may occur on dual-NIC setups.

---

### WR-05: Inner recovery loop does not check `is_connected` — can loop until timeout even after user manually reconnects

**File:** `gui-app/src-tauri/src/connectivity.rs:69-95` / `gui-light/src-tauri/src/connectivity.rs:70-95`

**Issue:** Once the outer loop enters the adapter-recovery inner loop, it never checks `is_connected`. If the user manually reconnects the VPN from the frontend while the inner loop is still polling (e.g., they had a brief network blip and reconnected quickly), the inner loop continues to poll `check_adapter_online()` and will eventually emit `"action": "reconnect"` — potentially triggering a second VPN connection attempt from the already-connected state.

**Fix:** Add an `is_connected` check at the top of the inner loop:

```rust
loop {
    tokio::time::sleep(Duration::from_secs(5)).await;
    adapter_wait += 1;

    // If user reconnected manually, exit recovery loop without emitting reconnect
    let already_reconnected = is_connected.lock().map(|g| *g).unwrap_or(false);
    if already_reconnected {
        log_app("INFO", "[connectivity] VPN reconnected externally, exiting recovery loop");
        break;
    }

    if check_adapter_online().await {
        // ...
    }
}
```

Note: `is_connected` must be cloned into the spawn closure for this to work — it already is (Arc<Mutex<bool>>), so no structural change needed.

---

## Info

### IN-01: `eprintln!` used alongside `log_app` — debug output goes to stderr but not to the log file

**File:** `gui-app/src-tauri/src/connectivity.rs:44,52,56,67,74,87` / `gui-light/src-tauri/src/connectivity.rs:44,52,55,68,75,87`

**Issue:** Several messages are logged with both `eprintln!` and `log_app`, but some `eprintln!` calls have no corresponding `log_app` call (e.g., line 147-150 in both files: "Using physical adapter" / "No physical adapter found"). These messages appear in stderr but not in the structured log file. Given that the project uses structured logging (`log_app`), `eprintln!` should either be removed or consolidated.

**Fix:** Replace all standalone `eprintln!` calls with `log_app` at the appropriate level. The paired ones (lines 44+45, 56+57) can drop the `eprintln!` entirely.

---

### IN-02: Timing constants differ between Pro and Light without a shared constant

**File:** `gui-app/src-tauri/src/connectivity.rs:25,30` vs `gui-light/src-tauri/src/connectivity.rs:25,30`

**Issue:** Pro uses 30 s startup delay + 20 s polling interval + 4 failure threshold; Light uses 15 s + 15 s + 3 failures. These are hardcoded magic numbers with no named constants. When either file needs tuning, both must be updated manually and it is easy to miss one.

**Fix:** Define named constants at the top of each file:

```rust
const STARTUP_DELAY_SECS: u64 = 30;   // Pro value
const POLL_INTERVAL_SECS: u64 = 20;
const FAILURE_THRESHOLD: u32 = 4;
const ADAPTER_TIMEOUT_CHECKS: u32 = 60;
const ADAPTER_POLL_SECS: u64 = 5;
const ADAPTER_STABILIZE_SECS: u64 = 3;
```

---

### IN-03: `check_adapter_online` HTTP fallback uses plain HTTP (`http://`) while `check_connectivity` uses HTTPS

**File:** `gui-app/src-tauri/src/connectivity.rs:269` / `gui-light/src-tauri/src/connectivity.rs:269`

**Issue:** The adapter recovery check uses `http://clients3.google.com/generate_204` (plain HTTP), but `check_connectivity` uses `https://`. The inconsistency is intentional for captive portal detection (captive portals intercept HTTP more reliably), but it is not documented. Additionally, plain HTTP over a non-VPN path exposes the probe URL to passive observers (a minor privacy concern, not a security vulnerability since no credentials are sent).

**Fix:** Add a comment explaining the intentional HTTP usage:

```rust
// Plain HTTP is intentional: captive portals intercept HTTP but not HTTPS.
// No credentials are sent in this request.
client.get("http://clients3.google.com/generate_204").send()
```

---

_Reviewed: 2026-04-10_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
