---
phase: 04-application-shell
plan: "03"
subsystem: frontend-types-i18n
tags: [apptab, i18n, keyboard-shortcuts, dead-code-removal, roadmap]
dependency_graph:
  requires: []
  provides:
    - AppTab 5-value union type in shared/types.ts
    - i18n keys for 5 tabs and ServerSidebar in en.json + ru.json
    - Updated keyboard shortcuts (Ctrl+1..5 = 5 tabs)
  affects:
    - gui-app/src/App.tsx (will use AppTab in Plan 05)
    - gui-app/src/components/layout/TabNavigation (Plan 04)
    - gui-app/src/components/layout/ServerSidebar (Plan 05)
tech_stack:
  added: []
  patterns:
    - i18n JSON locale files for tabs.* and sidebar.* keys
key_files:
  created: []
  modified:
    - gui-app/src/shared/types.ts
    - gui-app/src/shared/hooks/useKeyboardShortcuts.ts
    - gui-app/src/shared/i18n/locales/en.json
    - gui-app/src/shared/i18n/locales/ru.json
  deleted:
    - gui-app/src/components/Header.tsx
    - gui-app/src/components/Header.test.tsx
decisions:
  - "AppTab now 5-value union: control|connection|routing|settings|about (per D-03)"
  - "Header.tsx removed as dead code — was only imported by its own test file"
  - "Old tabs keys (server, serverSetup, etc.) kept for backward compat — cleanup in Phase 6"
  - "ROADMAP.md updated to reflect Phase 4 scope change: Application Shell (D-19)"
metrics:
  duration: "~15 min"
  completed: "2026-04-14"
  tasks_completed: 3
  files_changed: 6
---

# Phase 4 Plan 03: Foundation — AppTab + i18n + Keyboard Shortcuts Summary

**One-liner:** New AppTab 5-tab type union with full i18n keys (ru/en), keyboard shortcut update, Header.tsx dead code removal, and ROADMAP Phase 4 scope update to Application Shell.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Define AppTab type + update useKeyboardShortcuts | 68ddad58 | types.ts, useKeyboardShortcuts.ts |
| 2 | Add i18n keys + remove Header.tsx dead code | 6328b552 | en.json, ru.json, Header.tsx (deleted), Header.test.tsx (deleted) |
| 3 | Update ROADMAP.md for scope change | (gitignored) | .planning/ROADMAP.md |

## What Was Built

### Task 1: New AppTab type
- Replaced deprecated 4-value `AppTab = "setup" | "settings" | "routing" | "about"` with new 5-value `AppTab = "control" | "connection" | "routing" | "settings" | "about"` (per D-03)
- Removed `@deprecated` JSDoc comment
- Updated `useKeyboardShortcuts` pages array from 8 panels to 5 tabs: Ctrl+1=control, Ctrl+2=connection, Ctrl+3=routing, Ctrl+4=settings, Ctrl+5=about
- Updated JSDoc to document Ctrl+1..5 navigation

### Task 2: i18n keys
Added to both `en.json` and `ru.json`:
- `tabs.connection` — "Connection" / "Подключение"
- `tabs.requires_config` — "Set up connection first" / "Сначала настройте подключение"
- `sidebar.servers` — "Servers" / "Серверы"
- `sidebar.add_server` — "Add server" / "Добавить сервер"
- `sidebar.no_servers` — "No servers" / "Нет серверов"
- `sidebar.no_servers_hint` — ServerSidebar empty state body text

Deleted `Header.tsx` and `Header.test.tsx` — dead code using deprecated AppTab type, not imported anywhere in the app.

### Task 3: ROADMAP.md update
Updated `.planning/ROADMAP.md` Phase 4 entry:
- Title: "Remaining Panels" → "Application Shell"
- Goal reflects TitleBar + TabNavigation + ServerSidebar + App.tsx refactor
- Requirements note: SCR-07/DOC-04/DOC-05 partial; SCR-03 through SCR-09 deferred to future screen phases
- 4 plans listed: 04-03 through 04-06
- Progress table updated: "4. Application Shell | 0/4"

Note: `.planning/` is gitignored per project policy (no AI artifacts in git), so the ROADMAP.md change is not in a git commit. The file is updated on disk in this worktree for the orchestrator.

## Deviations from Plan

None — plan executed exactly as written. The ROADMAP.md change couldn't be git-committed (`.planning/` is gitignored by project policy), but the file was updated on disk as required.

## Known Stubs

None. This plan only modifies type definitions, i18n strings, keyboard shortcut config, and documentation.

## TypeScript Verification

Running `tsc --noEmit` shows pre-existing errors in other components (Button `icon` prop, Badge `size` prop, `"secondary"` variant — all from Phase 2 work not yet completed). The expected error from Header.tsx (`'"setup"' is not assignable to type 'AppTab'`) will disappear once Header.tsx is deleted (Task 2). Files modified in this plan (types.ts, useKeyboardShortcuts.ts) introduce no new TypeScript errors.

## Self-Check: PASSED

- `gui-app/src/shared/types.ts` — contains `export type AppTab = "control" | "connection" | "routing" | "settings" | "about"` ✓
- `gui-app/src/shared/hooks/useKeyboardShortcuts.ts` — pages array has 5 elements ✓
- `gui-app/src/shared/i18n/locales/en.json` — tabs.connection = "Connection", sidebar.servers = "Servers" ✓
- `gui-app/src/shared/i18n/locales/ru.json` — tabs.connection = "Подключение", sidebar.no_servers_hint starts with "Настройте" ✓
- `gui-app/src/components/Header.tsx` — does not exist ✓
- `gui-app/src/components/Header.test.tsx` — does not exist ✓
- `.planning/ROADMAP.md` — Phase 4 title "Application Shell", 4 plans listed, deferred note present ✓
- Commits exist: 68ddad58, 6328b552 ✓
