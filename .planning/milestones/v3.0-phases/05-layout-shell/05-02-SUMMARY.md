---
phase: 05-layout-shell
plan: "02"
subsystem: server-panel-ui
tags: [variant-fix, badge, button, cva, typescript]
one_liner: "Replace all invalid CVA variants (secondary/success/danger-outline/default/accent) in 8 server section components"
dependency_graph:
  requires: []
  provides: [valid-cva-variants-server]
  affects: [gui-pro/src/components/server]
tech_stack:
  added: []
  patterns: [CVA variant enforcement]
key_files:
  modified:
    - gui-pro/src/components/server/Fail2banSection.tsx
    - gui-pro/src/components/server/CertSection.tsx
    - gui-pro/src/components/server/ServerStatusSection.tsx
    - gui-pro/src/components/server/DiagnosticsSection.tsx
    - gui-pro/src/components/server/LogsSection.tsx
    - gui-pro/src/components/server/FirewallSection.tsx
    - gui-pro/src/components/server/UsersSection.tsx
    - gui-pro/src/components/server/VersionSection.tsx
decisions:
  - "danger-outline -> danger: план указывал только secondary/success, но danger-outline тоже несуществующий вариант — исправлен по Rule 1"
  - "pingVariant default -> neutral: исправлено в вычисляемой функции и type cast одновременно"
metrics:
  duration_minutes: 2
  completed_date: "2026-04-15"
  tasks_completed: 2
  files_modified: 8
---

# Phase 5 Plan 02: Fix Invalid CVA Variants in Server Sections Summary

Replace all invalid CVA Button and Badge variants across 8 ServerPanel section components, eliminating TypeScript type errors and ensuring correct visual rendering on both light and dark themes.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Fix Button variants in all server sections (D-12) | 76a67886 |
| 2 | Fix Badge variants + pingVariant type cast (D-12, D-15) | 35fa40fd |

## Changes Made

### Task 1 — Button variants (76a67886)

**Replacement rule: `secondary` -> `ghost`, `success` -> `primary`, `danger-outline` -> `danger`**

| File | Location | Old | New |
|------|----------|-----|-----|
| Fail2banSection.tsx | stop button | secondary | ghost |
| Fail2banSection.tsx | ban IP button | secondary | ghost |
| Fail2banSection.tsx | uninstall button | danger-outline | danger |
| CertSection.tsx | renew cert button | secondary | ghost |
| ServerStatusSection.tsx | restart service button | secondary | ghost |
| ServerStatusSection.tsx | stop service button | danger-outline | danger |
| ServerStatusSection.tsx | start service button | success | primary |
| ServerStatusSection.tsx | reboot server button | danger-outline | danger |
| DiagnosticsSection.tsx | run diagnostics button | secondary | ghost |
| DiagnosticsSection.tsx | collapse button | secondary | ghost |
| LogsSection.tsx | load/collapse logs button | secondary | ghost |
| FirewallSection.tsx | stop firewall button | secondary | ghost |
| FirewallSection.tsx | uninstall firewall button | danger-outline | danger |
| UsersSection.tsx | conditional connect button | secondary (in ternary) | ghost |
| UsersSection.tsx | add user button | success | primary |

### Task 2 — Badge variants + pingVariant (35fa40fd)

**Replacement rule: `default` -> `neutral`, `accent` -> `neutral`**

| File | Location | Old | New |
|------|----------|-----|-----|
| CertSection.tsx | certTypeBadge unknown case | default | neutral |
| CertSection.tsx | domain badge ternary | "default" in ternary | neutral |
| CertSection.tsx | autoRenew badge | default (in ternary) | neutral |
| ServerStatusSection.tsx | pingVariant null/<=0 returns | "default" | "neutral" |
| ServerStatusSection.tsx | ping Badge type cast | "default" in union | "neutral" |
| ServerStatusSection.tsx | no-connection Badge | default | neutral |
| VersionSection.tsx | current version badge | accent | neutral |

## Acceptance Criteria Verification

- `grep -rn 'variant="secondary"' server/` — **0 matches**
- `grep -rn 'variant="success"' server/` — only Badge usages (CertSection, VersionSection), **no Button usages**
- `grep -rn 'variant="default"' server/` — **0 matches**
- `grep -rn 'variant="accent"' server/` — **0 matches**
- All type casts using `"default"` updated to `"neutral"`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Also fixed `variant="danger-outline"` (plan only mentioned secondary/success)**
- **Found during:** Task 1 — reading all server section files
- **Issue:** Plan listed `secondary` and `success` as invalid Button variants, but files also contained `variant="danger-outline"` which does not exist in Button CVA (valid values: primary, danger, ghost, icon)
- **Files modified:** Fail2banSection.tsx (uninstall), FirewallSection.tsx (uninstall), ServerStatusSection.tsx (stop, reboot)
- **Fix:** danger-outline -> danger (destructive action)
- **Commits:** 76a67886

## Pre-existing Issues (Out of Scope)

The following TS errors exist throughout `server/` but are **not caused by this plan** and require architectural decisions:

1. **`Property 'icon' does not exist on ButtonProps`** — Button component does not declare `icon` prop, but it is used pervasively across all server components. This is a pre-existing interface mismatch.
2. **`Property 'size' does not exist on BadgeProps`** — Badge component does not declare `size` prop, but it is used in CertSection and ServerStatusSection.
3. **`Property 'aria-label' required in IconButtonProps`** — UsersSection IconButton calls missing required prop.
4. **`variant="danger-outline"` in DangerZoneSection and MtProtoSection** — outside plan scope (not in `files_modified`).

These are logged to deferred-items for Phase 6 or a dedicated cleanup plan.

## Threat Flags

None — all changes are visual-only CVA variant string replacements with no security surface impact (confirmed by threat model T-05-04, T-05-05).

## Self-Check: PASSED

- Files modified: all 8 server section files confirmed changed
- Commits exist: 76a67886, 35fa40fd confirmed in git log
- Zero `variant="secondary"`, `variant="default"`, `variant="accent"` in server/ directory
- Badge `variant="success"` remains (valid — only Button success was removed)
