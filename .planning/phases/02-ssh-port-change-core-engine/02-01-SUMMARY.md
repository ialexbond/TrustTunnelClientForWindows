---
phase: 02-ssh-port-change-core-engine
plan: 01
subsystem: ssh-server-security
tags: [ssh, port-change, backend, rust, i18n]
dependency_graph:
  requires: []
  provides: [change_ssh_port, security_change_ssh_port_command, ssh_port_i18n_keys]
  affects: [gui-app/src-tauri/src/ssh/server/server_security.rs, gui-app/src-tauri/src/ssh/mod.rs, gui-app/src-tauri/src/commands/ssh_commands.rs, gui-app/src-tauri/src/lib.rs]
tech_stack:
  added: []
  patterns: [backup-validate-apply-rollback, socket-activation-override, sshd-config-edit]
key_files:
  created: []
  modified:
    - gui-app/src-tauri/src/ssh/server/server_security.rs
    - gui-app/src-tauri/src/ssh/mod.rs
    - gui-app/src-tauri/src/commands/ssh_commands.rs
    - gui-app/src-tauri/src/lib.rs
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-app/src/shared/i18n/locales/en.json
decisions:
  - "Port validation uses < 1024 only (u16 max is 65535, upper bound implicit)"
  - "Socket path uses override.conf with empty ListenStream= clearing line per systemd convention"
  - "Classic path uses sed with three-case handling: existing Port, commented #Port, or appended"
metrics:
  duration: 846s
  completed: 2026-04-12T17:35:42Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 6
---

# Phase 02 Plan 01: SSH Port Change Core Engine Summary

Rust backend for SSH port change with dual-path support (socket activation vs classic service), backup/validate/rollback workflow, Tauri command registration, and full i18n coverage.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Implement change_ssh_port backend logic | 0a88be92 | SshServiceType enum, detect_ssh_service_type, change_ssh_port with socket/classic paths, security_change_ssh_port Tauri command |
| 2 | Add i18n keys for SSH port section | 55504384 | ssh_port section, snack.port_changed, 3 error keys in both ru.json and en.json |

## Implementation Details

### Task 1: Backend Logic

Added to `server_security.rs`:
- `SshServiceType` enum with `Socket` and `Service` variants
- `detect_ssh_service_type()` -- checks `ssh.socket` then `ssh.service` via systemctl, returns `SSH_UNSUPPORTED_OS` if neither active
- `change_ssh_port()` -- main function with two paths:
  - **Socket path** (Ubuntu 24.04+): Creates `/etc/systemd/system/ssh.socket.d/override.conf` with empty `ListenStream=` clearing line followed by new port, daemon-reload, restart. Rollback from backup on failure.
  - **Classic path** (Ubuntu 22.04, Debian 11/12): Edits `/etc/ssh/sshd_config` Port line (handles existing, commented, or missing), validates with `sshd -t`, restarts service. Rollback from timestamped backup on failure.

Added to `ssh_commands.rs`: Manual `security_change_ssh_port` Tauri command (pooled connection pattern).
Added to `lib.rs`: Command registered in `invoke_handler`.
Added to `mod.rs`: `change_ssh_port` re-export.

### Task 2: i18n Keys

Added to both `ru.json` and `en.json`:
- `server.security.ssh_port`: title, current, new_port, apply, changing, range_hint
- `server.security.snack.port_changed`: success notification
- `server.security.errors`: port_change_failed, port_validation_failed, unsupported_os

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed u16 comparison warning**
- **Found during:** Task 1 verification (cargo check)
- **Issue:** `new_port > 65535` comparison is useless for u16 type (max value is 65535)
- **Fix:** Removed upper bound check, kept `new_port < 1024` only
- **Files modified:** gui-app/src-tauri/src/ssh/server/server_security.rs
- **Commit:** 0a88be92

**2. [Rule 3 - Blocking] Worktree missing sidecar binary for cargo check**
- **Found during:** Task 1 verification
- **Issue:** Tauri build.rs requires `trusttunnel_client-x86_64-pc-windows-msvc.exe` in manifest dir
- **Fix:** Copied sidecar binary from main repo to worktree (not committed, binary is gitignored)
- **No commit needed** (build artifact, not source)

## Known Stubs

None -- all code is fully wired and functional.

## Self-Check: PASSED

All 6 modified files verified present. Both task commits (0a88be92, 55504384) confirmed in git log.
