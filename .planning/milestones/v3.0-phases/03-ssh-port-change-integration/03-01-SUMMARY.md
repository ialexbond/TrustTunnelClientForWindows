---
phase: 03-ssh-port-change-integration
plan: 01
subsystem: ssh-port-change
tags: [firewall, ufw, fail2ban, ssh-port, security]
dependency_graph:
  requires: [02-01]
  provides: [change_ssh_port with firewall + fail2ban integration]
  affects: [frontend ssh port change flow]
tech_stack:
  added: []
  patterns: [safe-order firewall orchestration, conditional fail2ban jail update]
key_files:
  created: []
  modified:
    - gui-pro/src-tauri/src/ssh/server/server_security.rs
    - gui-pro/src-tauri/src/commands/ssh_commands.rs
decisions:
  - "UFW firewall steps are conditional on ufw_active — skipped entirely if UFW not installed or inactive"
  - "Fail2Ban jail update is best-effort — failure does not block port change success"
  - "Old port firewall rule removal is non-fatal — rule format may differ from what we try to delete"
metrics:
  duration: 189s
  completed: 2026-04-12T19:19:10Z
  tasks: 1/1
  files_modified: 2
---

# Phase 03 Plan 01: Firewall & Fail2Ban Integration Summary

Extended `change_ssh_port` with UFW safe-order firewall orchestration (open new -> change sshd -> verify -> close old) and automatic Fail2Ban sshd jail port update.

## Completed Tasks

| # | Task | Commit | Key Changes |
|---|------|--------|-------------|
| 1 | Extend change_ssh_port with firewall orchestration and Fail2Ban update | 3efe34ec | server_security.rs: added ssh_port param, Result<u16>, UFW open/verify/close, Fail2Ban jail update; ssh_commands.rs: return { "newPort": u16 } |

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

- `cargo check` passes with no errors (warnings only, pre-existing)
- `change_ssh_port` signature: `Result<u16, String>` with `ssh_port: u16` parameter
- Firewall steps conditional on `ufw_active`
- Old port cleanup only after verification succeeds
- Fail2Ban update only when `fail2ban-client` is installed
- Command handler returns `json!({ "newPort": actual_port })`

## Self-Check: PASSED
