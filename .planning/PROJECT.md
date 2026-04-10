# TrustTunnel

## What This Is

Windows VPN client with two editions: Pro (server management via SSH + full dashboard) and Light (simple connect-only client). Built on Tauri 2 (Rust + React/TypeScript) with C++ WinTUN sidecar for VPN tunneling.

## Core Value

Reliable VPN connection with full server control from a single desktop app — deploy, manage, monitor, and connect without touching the terminal.

## Requirements

### Validated

- SSH server deploy wizard with step-by-step UI — v2.0
- Split-tunnel routing with geodata categories — v2.0
- System tray with VPN status and connect/disconnect — v2.3.0
- Drag-and-drop config/routing import — v2.3.0
- File logging with sensitive data sanitization — v2.3.0
- SSH key paste (PEM text) in connect forms — v2.3.0
- SSH error translations with auto host key reset — v2.3.0
- Server security panel (fail2ban + UFW firewall) — v2.3.0
- SSH input validation (sanitize.rs, 8 validators) — v2.4.0
- SHA256 mandatory + URL whitelist for self-update — v2.4.0
- Keyring DPAPI credential storage — v2.4.0
- TOFU host key verification dialog — v2.4.0
- Async mpsc logging with batched writes — v2.4.0
- SSH connection pool (29 commands, keepalive) — v2.4.0
- SecuritySection refactored + 41 tests — v2.4.0
- Frontend CI (GitHub Actions) — v2.4.0
- 54 Rust unit tests — v2.4.0

### Active

- [ ] Connectivity bypass — bind checks to physical adapter, bypass VPN routing
- [ ] Markdown changelog rendering in update dialog
- [ ] Random username/password generator in VPN user forms

### Out of Scope

- TrustTunnel Light feature parity with Pro — separate milestone
- Mobile apps — desktop-first
- Real-time server metrics dashboard — v2.0 redesign scope

## Current Milestone: v2.5.0 UX & Connectivity

**Goal:** Restore connectivity bypass VPN, improve update UX and user management forms

**Target features:**
- Connectivity bypass (socket2/ipconfig bind to physical adapter)
- Markdown changelog in update dialog
- Credential generator for VPN user forms

## Context

- Connectivity bypass code exists in git commit `798ce8e7` — was implemented in v2.4.0 Phase 5 but lost due to worktree catch-all commit overwriting connectivity.rs
- Current connectivity.rs (171 lines) is the old version without socket2 binding
- Correct version (253 lines) uses `find_physical_adapter_ip()` + socket2 `bind()` + reqwest `local_address()`
- Dependencies needed: `socket2 = { version = "0.5", features = ["all"] }`, `ipconfig = "0.3"`
- Update dialog currently shows raw markdown text with `#` headers and truncation
- VPN user forms exist in deploy wizard (ServerStep) and server panel (add user)

## Constraints

- **Tech stack**: Tauri 2 + React 19 + Rust 1.88 — no framework changes
- **Two editions**: Changes to shared logic must be mirrored in gui-app and gui-light
- **Portable**: All data stored next to executable, no AppData
- **i18n**: All user-facing strings in ru.json + en.json

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| socket2 for connectivity bypass | Bind TCP checks to physical adapter IP, bypass VPN routing table | -- Pending |
| Restore from git history | Code already written and tested, no need to rewrite | -- Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check -- still the right priority?
3. Audit Out of Scope -- reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-10 after milestone v2.5.0 initialization*
