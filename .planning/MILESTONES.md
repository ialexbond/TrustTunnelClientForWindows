# Milestones

## Completed

### v2.3.0 — Tray, Logging, SSH UX (2026-04-07)

- Dynamic tray menu with VPN status and connect/disconnect
- File logging with sanitization and diagnostics
- Drag-and-drop config/routing import
- SSH key paste (PEM text)
- SSH error translations with auto host key reset

### v2.4.0 — Security, Performance, Quality (2026-04-10)

- SSH input validation (sanitize.rs)
- Self-update hardening (SHA256 + URL whitelist)
- Keyring DPAPI credential storage
- TOFU host key verification dialog
- Async mpsc logging with batched writes
- SSH connection pool (29 commands, keepalive)
- SecuritySection refactored (910->61 lines) + 41 tests
- Frontend CI (GitHub Actions)
- DRY cleanup (detect_sudo, build_client_config, tray.rs)
- 54 Rust unit tests
- 9 phases, 19 commits, 81 files, +5531/-793 lines
- Phase 5 (connectivity bypass) reverted — lost in catch-all commit

## Current

### v2.5.0 — UX & Connectivity (2026-04-10)

- Connectivity bypass restore (socket2/ipconfig)
- Markdown changelog in update dialog
- Credential generator for VPN user forms
