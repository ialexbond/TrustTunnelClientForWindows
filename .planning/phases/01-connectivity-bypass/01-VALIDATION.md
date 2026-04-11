---
phase: 1
slug: connectivity-bypass
status: audited
nyquist_compliant: false
wave_0_complete: true
manual_only: [CONN-01, CONN-02, CONN-03, CONN-04, CONN-05]
created: 2026-04-10
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo check / cargo build (no unit test framework for connectivity module) |
| **Config file** | gui-app/src-tauri/Cargo.toml, gui-light/src-tauri/Cargo.toml |
| **Quick run command** | `cd gui-app/src-tauri && cargo check && cd ../../gui-light/src-tauri && cargo check` |
| **Full suite command** | `cd gui-app/src-tauri && cargo build && cd ../../gui-light/src-tauri && cargo build` |
| **Estimated runtime** | ~30 seconds (check), ~120 seconds (build) |

---

## Sampling Rate

- **After every task commit:** Run quick cargo check in both editions
- **After every plan wave:** Run full cargo build in both editions
- **Before `/gsd-verify-work`:** Full build must succeed for both gui-app and gui-light
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------|-------------------|--------|
| T1 | 01 | 1 | CONN-01,02,03,04,05 | compile | `cargo check` in gui-app | pending |
| T2 | 01 | 1 | CONN-01,02,03,04,05 | compile | `cargo check` in gui-light | pending |
| T3 | 01 | 1 | - | compile | `cargo check` deps | pending |

---

## Manual-Only Requirements

| Requirement | Reason | How to Verify |
|-------------|--------|---------------|
| CONN-01 | OS-level ipconfig::get_adapters() — cannot mock without trait refactor | Check logs: `[connectivity] Physical adapter: ip=X, gateway=Y` |
| CONN-02 | socket2 bind requires real adapter | Check logs: `Gateway TCP result: true` |
| CONN-03 | Gateway TCP bypasses VPN routing — requires active VPN session | Connect VPN, wait 2+ minutes, no disconnect |
| CONN-04 | Disable WiFi/Ethernet, verify no crash | Disconnect adapter, check app stays stable |
| CONN-05 | Runtime false-reconnect prevention | VPN stays connected 10+ minutes, no `Declaring offline` in logs |

## Validation Audit 2026-04-11

| Metric | Count |
|--------|-------|
| Gaps found | 5 |
| Resolved | 0 |
| Escalated to manual-only | 5 |

All 5 requirements (CONN-01..05) are OS-level network operations depending on real adapters, sockets, and VPN state. Automated unit testing would require mocking the entire Windows network stack (ipconfig, socket2, routing tables). Marked manual-only — verification via runtime logs and observation.

## Notes

- No automated unit tests for connectivity module — validation is compile + manual smoke test
- CONN-01 through CONN-05 require runtime observation with a real VPN session for full verification
- Cargo check confirms type correctness and API compliance at compile time
- Gateway-based approach (v2.5.0 hotfix) replaces public-IP approach — gateway on local subnet never routes through VPN
