# Roadmap: TrustTunnel v2.5.0

## Overview

Restore connectivity bypass (lost in v2.4.0 catch-all commit), add markdown rendering to update dialog, add credential generators to VPN user forms, then build release installers. Four sequential phases — Rust changes first, frontend second and third, release last.

## Milestones

- **v2.5.0 UX & Connectivity** - Phases 1-4 (in progress)

## Phases

- [ ] **Phase 1: Connectivity Bypass** - Restore socket2/ipconfig bind to physical adapter in gui-app and gui-light
- [ ] **Phase 2: Update UX** - Render markdown changelog in update dialog with scrollable view
- [ ] **Phase 3: Credential Generator** - Add random username/password generator icons inside VPN user form inputs
- [ ] **Phase 4: Release** - Build and deliver NSIS installers for Pro and Light to desktop

## Phase Details

### Phase 1: Connectivity Bypass
**Goal**: VPN connectivity checks route through the physical adapter, not the VPN tunnel
**Depends on**: Nothing (first phase)
**Requirements**: CONN-01, CONN-02, CONN-03, CONN-04, CONN-05
**Success Criteria** (what must be TRUE):
  1. App identifies the physical adapter IP (Ethernet/WiFi), excluding WinTUN interfaces
  2. TCP checks bind to the physical adapter via socket2, not through VPN routing
  3. HTTP checks use reqwest with local_address set to the physical adapter IP
  4. When no physical adapter is found, app falls back to default routing without crashing
  5. Connectivity monitor does not trigger false VPN reconnects while VPN is active
**Plans**: 2 plans
Plans:
- [ ] 01-01-PLAN.md — Version bump, add socket2/ipconfig deps, restore gui-app connectivity.rs from 798ce8e7 with verbose logging
- [ ] 01-02-PLAN.md — Port socket2 connectivity bypass to gui-light (Light timing profile), verify both editions compile

### Phase 2: Update UX
**Goal**: Users can read formatted release notes in the update dialog
**Depends on**: Phase 1
**Requirements**: UPD-01, UPD-02
**Success Criteria** (what must be TRUE):
  1. Update dialog renders markdown headers, lists, and bold/italic — no raw `#` or `*` characters visible
  2. Long changelogs scroll within the dialog rather than being truncated
**Plans**: TBD
**UI hint**: yes

### Phase 3: Credential Generator
**Goal**: Users can generate random credentials directly from VPN user form inputs
**Depends on**: Phase 2
**Requirements**: CRED-01, CRED-02, CRED-03
**Success Criteria** (what must be TRUE):
  1. Username input field shows a generator icon that fills the field with a random value on click
  2. Password input field shows a generator icon that fills the field with a random value on click
  3. Generator icons appear in both the deploy wizard (ServerStep) and the server panel add-user form
**Plans**: TBD
**UI hint**: yes

### Phase 4: Release
**Goal**: Both Pro and Light installers are built and ready for distribution
**Depends on**: Phase 3
**Requirements**: REL-01, REL-02
**Success Criteria** (what must be TRUE):
  1. TrustTunnel Pro NSIS installer is built and placed on the desktop
  2. TrustTunnel Light NSIS installer is built and placed on the desktop
**Plans**: TBD

## Progress

**Execution Order:** 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Connectivity Bypass | 0/2 | Planning complete | - |
| 2. Update UX | 0/TBD | Not started | - |
| 3. Credential Generator | 0/TBD | Not started | - |
| 4. Release | 0/TBD | Not started | - |
