---
phase: 03-control-panel
plan: 01
subsystem: ui/ssh-connect-form
tags: [form-migration, card-layout, token-redesign, i18n, phase2-primitives]
dependency_graph:
  requires: []
  provides: [SshConnectForm-v3, vpnErrors-i18n-namespace]
  affects: [ControlPanelPage (renders SshConnectForm), StatusPanel (uses vpnErrors namespace in Plan 02)]
tech_stack:
  added: []
  patterns: [Card-centered login layout, Button primary/ghost toggle pattern, loading prop (no manual Loader2), Tailwind h-[100px] for fixed height, token-only styling]
key_files:
  created: []
  modified:
    - gui-app/src/components/server/SshConnectForm.tsx
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-app/src/shared/i18n/locales/en.json
decisions:
  - "Card padding=lg wraps entire form — provides surface/border/radius without inline style"
  - "icons placed as children of Button (not icon= prop) per Phase 2 API"
  - "loading={connecting} on connect CTA — no manual Loader2 child to avoid double spinner"
  - "buttons.cancel already existed in both locales — no override needed"
  - "npm install --legacy-peer-deps required in worktree (node_modules absent)"
metrics:
  duration: ~20min
  completed: 2026-04-14
  tasks_completed: 2
  files_changed: 3
---

# Phase 03 Plan 01: SshConnectForm Redesign Summary

**One-liner:** Card-centered login form migrated to Phase 2 primitives — zero colors.ts, zero raw buttons, zero inline layout styles; vpnErrors i18n namespace added to both locales.

## What Was Built

### Task 1: vpnErrors i18n namespace

Added `vpnErrors` namespace to both `ru.json` and `en.json` locale files, inserted after the existing `sshErrors` block.

**ru.json additions:**
```json
"vpnErrors": {
  "tunnelDown": "VPN-соединение потеряно. Проверьте подключение к серверу и нажмите Подключить.",
  "authFailed": "Ошибка аутентификации VPN. Проверьте конфигурацию сервера.",
  "generic": "Не удалось подключиться к VPN. Попробуйте снова."
}
```

**en.json additions:**
```json
"vpnErrors": {
  "tunnelDown": "VPN connection lost. Check server connectivity and press Connect.",
  "authFailed": "VPN authentication failed. Check server configuration.",
  "generic": "Failed to connect to VPN. Try again."
}
```

`buttons.cancel` was already present in both locale files — no change needed.

### Task 2: SshConnectForm Redesign

`SshConnectForm.tsx` fully migrated to Phase 2 design system:

| Change | Before | After |
|--------|--------|-------|
| Outer container | `<div className="flex-1...py-8">` + `<div className="w-full max-w-md">` | `Card padding="lg"` + centered wrapper with bg-primary |
| Server icon bg | `colors.accentLogoGlow` import | `bg-[var(--color-bg-elevated)]` token |
| Form surface | `style={{ backgroundColor: ..., border: ... }}` | Card provides surface/border/radius |
| Auth mode toggle | `variant="secondary"` Button + `icon={}` prop | `variant="ghost"` / `"primary"` Button with icon as child |
| Key mode toggle | Raw `<button>` elements with inline style | `Button variant="ghost"/"primary"` |
| Connect CTA | manual `Loader2` as child + `icon={}` | `loading={connecting}` prop (Button auto-renders Loader2) |
| Textarea height | `style={{ height: 100 }}` | `h-[100px]` Tailwind class |
| Security note | `style={{ color: "var(...)" }}` | `text-[var(--color-text-muted)]` token class |

Zero legacy patterns remain:
- `import { colors }` — REMOVED
- `style={{ backgroundColor:` on form container — REMOVED
- `style={{ border:` on form container — REMOVED
- `<button` raw elements — REMOVED (0 instances)
- `icon={}` prop on Button — REMOVED (0 instances)

## Verification Results

All tests passing:
- SshConnectForm.test.tsx: 21/21 (all 20 existing + 1 bonus test)

Acceptance criteria met:
- No `import { colors }` in SshConnectForm.tsx
- `import { Card } from "../../shared/ui/Card"` present
- `<Card padding="lg"` present
- `bg-[var(--color-bg-elevated)]` present on server icon container
- No `style={{ backgroundColor:` on form container
- No raw `<button` elements (0 instances)
- No `icon={` prop on Button (0 instances)
- `loading={connecting}` on connect CTA
- `h-[100px]` on textarea (no inline style)
- `variant="ghost"` on all inactive toggle Buttons
- vpnErrors namespace in both locale files

## Task Commits

1. **Task 1: vpnErrors i18n keys** — `37997511` (feat)
2. **Task 2: SshConnectForm redesign** — `c6c6351f` (feat)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] npm dependencies absent from worktree**
- **Found during:** Task 2 verification
- **Issue:** `node_modules` not present in worktree gui-app — `npx vitest run` failed with `ERR_MODULE_NOT_FOUND`
- **Fix:** Ran `npm install --legacy-peer-deps` in worktree `gui-app/`
- **Commit:** no separate commit (setup only, same pattern as Phase 2 agents)

## Known Stubs

None — SshConnectForm fully functional with real Phase 2 primitives.

## Threat Surface Scan

No new trust boundaries introduced. Phase 3 Plan 01 is visual-only migration — zero behavior or data flow changes. The SSH key paste textarea already existed; no new exposure vector.

## Self-Check: PASSED

Files verified to exist:
- gui-app/src/components/server/SshConnectForm.tsx (Card import, loading prop, no colors.ts)
- gui-app/src/shared/i18n/locales/ru.json (vpnErrors namespace present)
- gui-app/src/shared/i18n/locales/en.json (vpnErrors namespace present)

Commits verified:
- 37997511 present in git log
- c6c6351f present in git log
