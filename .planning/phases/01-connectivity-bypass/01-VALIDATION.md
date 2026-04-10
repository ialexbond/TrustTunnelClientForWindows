---
phase: 1
slug: connectivity-bypass
status: draft
nyquist_compliant: false
wave_0_complete: false
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

## Notes

- No automated unit tests for connectivity module — validation is compile + manual smoke test
- CONN-01 through CONN-05 require runtime observation with a real VPN session for full verification
- Cargo check confirms type correctness and API compliance at compile time
