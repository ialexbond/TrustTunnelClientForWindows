---
phase: "04-application-shell"
plan: "05"
subsystem: "gui-app"
tags: ["app-shell", "routing", "tab-navigation", "token-migration", "sidebar-deletion"]
dependency_graph:
  requires: ["04-04"]
  provides: ["04-06"]
  affects: ["gui-app/src/App.tsx", "gui-app/src/components/ServerSidebar.tsx"]
tech_stack:
  added: []
  patterns:
    - "AppTab union type replaces SidebarPage for 5-tab routing"
    - "TitleBar + TabNavigation composing the application shell"
    - "Design token vars replacing hardcoded Tailwind colors in ServerSidebar"
    - "EmptyState shared component for zero-server state"
key_files:
  created: []
  modified:
    - "gui-app/src/App.tsx"
    - "gui-app/src/components/ServerSidebar.tsx"
  deleted:
    - "gui-app/src/components/layout/Sidebar.tsx"
    - "gui-app/src/components/layout/Sidebar.test.tsx"
decisions:
  - "SetupWizard renders inside control tab when hasConfig=false (no separate server page)"
  - "handleClearConfig does not setActiveTab — control tab auto-shows wizard via hasConfig conditional"
  - "TitleBar receives WindowControls as children (matches wave 2 TitleBar interface)"
  - "vpnLogs state retained in App.tsx for potential future use despite LogPanel removal"
metrics:
  duration: "~20 min"
  completed: "2026-04-14"
  tasks_completed: 2
  files_changed: 4
requirements:
  - SCR-08
  - SCR-09
---

# Phase 04 Plan 05: Application Shell Integration Summary

**One-liner:** App.tsx refactored from 8-page SidebarPage routing to 5-tab AppTab shell with TitleBar + TabNavigation, ServerSidebar migrated to design token vars, Sidebar.tsx deleted.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Refactor App.tsx — TitleBar + TabNavigation + 5-tab routing | edf1a881 | gui-app/src/App.tsx |
| 2 | ServerSidebar token migration + delete Sidebar | 2649a986 | ServerSidebar.tsx, Sidebar.tsx (del), Sidebar.test.tsx (del) |

---

## What Was Built

### Task 1: App.tsx Refactor

The application shell was completely restructured:

- **Removed:** `import { Sidebar, type SidebarPage }` — hover-expand sidebar is gone
- **Removed:** `import DashboardPanel` (D-04 — Dashboard disbanded)
- **Removed:** `import LogPanel` (D-05 — Logs folded into connection)
- **Added:** `import { TitleBar }` — new title bar component from wave 2
- **Added:** `import { TabNavigation }` — 5-tab horizontal nav from wave 2
- **Added:** `import type { AppTab }` — 5-value union from shared/types.ts

**State rename:** `activePage: SidebarPage` → `activeTab: AppTab`

**localStorage migration guard** (tabMap):
```
server      → control
control     → control
settings    → connection   (old VPN settings → connection tab)
appSettings → settings     (old app settings → settings tab)
dashboard   → control      (disbanded D-04)
routing     → routing
logs        → connection   (folded per D-05)
about       → about
connection  → connection   (passthrough)
```

**Shell structure:** TitleBar (with WindowControls as children) → TabNavigation → 5 content slots using `display: flex/none` pattern.

**SetupWizard** now renders inside the `control` tab when `!hasConfig`, replacing the old separate `server` page.

**ControlPanelPage** received `onNavigateToSettings={() => setActiveTab("settings")}` — prop interface already existed.

### Task 2: ServerSidebar Token Migration

All hardcoded Tailwind color classes replaced with CSS token vars:

| Element | Old | New |
|---------|-----|-----|
| Connected dot | `bg-emerald-400` | `var(--color-status-connected)` |
| Connecting dot | `bg-amber-400 animate-pulse` | `var(--color-status-connecting)` + `animate-pulse` |
| Disconnected dot | `bg-neutral-500` | `var(--color-status-disconnected)` |
| Error dot | `bg-red-400` | `var(--color-status-error)` |
| Disconnect hover | `hover:bg-red-500/20` | `hover:bg-[var(--color-status-error-bg)]` |
| Disconnect icon | `text-red-400` | `color: var(--color-status-error)` |
| Connecting spinner | `text-amber-400` | `color: var(--color-status-connecting)` |

Additional changes:
- `EmptyState` component used for zero-server state (replaces inline div)
- Section header updated: `11px`, `font-weight: 400`, `letter-spacing: 0.02em` per UI-SPEC
- `aria-label` added to disconnect button: `"Отключить {server name}"`

### Sidebar Deletion

`Sidebar.tsx` and `Sidebar.test.tsx` deleted. The hover-expand sidebar is replaced by `TabNavigation`. All old tests for collapse/expand behavior are irrelevant.

---

## Deviations from Plan

### Auto-fixed Issues

None — plan executed with one minor adaptation:

**1. [Rule 2 - Adaptation] TitleBar children interface**
- **Found during:** Task 1
- **Issue:** Wave 2 TitleBar was created with `children?: ReactNode` interface, not `hasUpdate?: boolean` as specified in the plan's interface section. The plan's JSX guide showed `<TitleBar hasUpdate={updateInfo.available} />`.
- **Fix:** Used `<TitleBar><WindowControls /></TitleBar>` — passes WindowControls as children, matching the actual TitleBar interface from wave 2. This is semantically equivalent and correct.
- **Files modified:** gui-app/src/App.tsx
- **Commit:** edf1a881

**2. [Rule 2 - Adaptation] vpnLogs state retained**
- **Found during:** Task 1
- **Issue:** Plan specifies removing LogPanel import, but `vpnLogs` state is still populated by `useVpnEvents`. Removing it would require modifying the hook.
- **Fix:** Kept `vpnLogs` state in App.tsx. The `setVpnLogs` callback is still used by `useVpnEvents` — removing it would break the event hook. State is retained as future connection point for when Logs UI is integrated into Connection tab in a future phase.
- **Files modified:** none (no change made — retained as-is)

---

## Known Stubs

None — all functionality is wired. The `vpnLogs` state is retained but not rendered (not a stub — it's event-driven data accumulation).

---

## Threat Flags

No new security-relevant surface introduced. The localStorage tabMap uses a strict `Record<string, AppTab>` with `?? "control"` fallback — no arbitrary string accepted as AppTab (T-04-06 mitigated as planned).

---

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| gui-app/src/App.tsx exists | FOUND |
| gui-app/src/components/ServerSidebar.tsx exists | FOUND |
| gui-app/src/components/layout/Sidebar.tsx deleted | CONFIRMED |
| gui-app/src/components/layout/Sidebar.test.tsx deleted | CONFIRMED |
| Commit edf1a881 exists | CONFIRMED |
| Commit 2649a986 exists | CONFIRMED |
| TypeScript compiles (no errors beyond missing node_modules typeRoots) | CONFIRMED |
