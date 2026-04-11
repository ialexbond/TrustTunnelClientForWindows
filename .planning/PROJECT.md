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
- Connectivity bypass — socket2 bind to gateway, bypasses VPN routing — v2.5.0
- Markdown changelog modal (react-markdown) in update dialog — v2.5.0
- Random username/password generator in VPN user forms — v2.5.0
- ActionInput/ActionPasswordInput reusable components — v2.5.0

### Active

(None — next milestone needed)

### Out of Scope

- TrustTunnel Light feature parity with Pro — separate milestone
- Mobile apps — desktop-first
- Real-time server metrics dashboard — v2.0 redesign scope

## Shipped: v2.5.0 UX & Connectivity (2026-04-11)

**Delivered:**
- Connectivity bypass via gateway TCP (socket2 bind to physical adapter, probe gateway not public IPs)
- ChangelogModal with react-markdown — formatted release notes in modal dialog
- Credential generator — Shuffle icons in username/password fields (word-based + random)
- ActionInput/ActionPasswordInput — reusable input components with action icon slots
- NSIS installers (Pro + Light) built and verified

## Context

- Connectivity uses gateway TCP instead of public IPs (1.1.1.1) — gateway on local subnet never routes through VPN
- react-markdown ^9.0.1 for changelog rendering
- credentialGenerator.ts uses crypto.getRandomValues() — no external deps
- 14 ChangelogModal tests + 6 credentialGenerator tests (vitest)

## Constraints

- **Tech stack**: Tauri 2 + React 19 + Rust 1.88 — no framework changes
- **Two editions**: Changes to shared logic must be mirrored in gui-app and gui-light
- **Portable**: All data stored next to executable, no AppData
- **i18n**: All user-facing strings in ru.json + en.json

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Gateway TCP instead of public IPs | Public IPs route through VPN tunnel; gateway is local subnet | ✓ VPN stable 7+ hours |
| react-markdown for changelog | React-idiomatic, no innerHTML/sanitization | ✓ Shipped v2.5.0 |
| ActionInput/ActionPasswordInput | Reusable components vs rightIcon hack | ✓ Clean icon slots |
| crypto.getRandomValues() | Secure randomness, no external deps | ✓ Shipped v2.5.0 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

---
*Last updated: 2026-04-11 after v2.5.0 milestone*

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
