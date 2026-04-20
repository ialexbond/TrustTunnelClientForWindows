---
phase: 05-layout-shell
plan: "01"
subsystem: frontend-shell
tags: [layout, borders, a11y, animation, tab-navigation, sidebar]
dependency_graph:
  requires: []
  provides:
    - border-free shell (D-01)
    - sidebar bg-secondary separation (D-03)
    - tab max-width 640px (D-05)
    - roving focus tablist (D-06)
    - sidebar animation at 2+ servers (D-08, D-11)
    - status dots removed (D-09)
    - display:none tab caching (D-13, D-14)
    - a11y disconnect button (D-19)
    - Add Server VPN safety fix (D-10)
  affects:
    - gui-pro/src/components/layout/TabNavigation.tsx
    - gui-pro/src/components/ServerSidebar.tsx
    - gui-pro/src/components/ServerTabs.tsx
    - gui-pro/src/components/ControlPanelPage.tsx
tech_stack:
  added: []
  patterns:
    - WAI-ARIA tablist roving focus (ArrowLeft/ArrowRight/Home/End)
    - CSS transition asymmetric timing (appear: --transition-normal, disappear: --transition-fast)
    - display:none tab caching (mount once, toggle visibility)
    - group-focus-within for keyboard-accessible opacity-0 buttons
key_files:
  created: []
  modified:
    - gui-pro/src/components/layout/TabNavigation.tsx
    - gui-pro/src/components/ServerSidebar.tsx
    - gui-pro/src/components/ServerTabs.tsx
    - gui-pro/src/components/ControlPanelPage.tsx
decisions:
  - D-01 implemented: all border-[var(--color-border)] removed from shell components
  - D-10 safety fix: onAddServer no longer calls handleDisconnect
  - showAddForm state removed (was unused — TS6133 warning resolved)
  - sidebarVisible logic placed in ControlPanelPage (has direct access to servers array)
metrics:
  duration: "~20 minutes"
  completed_date: "2026-04-14"
  tasks_completed: 3
  files_modified: 4
  commits: 4
---

# Phase 05 Plan 01: Shell Polish + TODO Closure — Summary

**One-liner:** Borderless shell with WAI-ARIA roving focus, bg-secondary sidebar separation, display:none tab caching, sidebar animation at 2+ servers, and Add Server VPN safety fix.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | TabNavigation — border, max-width, roving focus | f01eb264 | TabNavigation.tsx |
| 2 | ServerSidebar — borders, bg-secondary, no dots, a11y | 0cb42530 | ServerSidebar.tsx |
| 3 | Sidebar animation + display:none caching + D-10 fix | ecd40321 | ControlPanelPage.tsx, ServerTabs.tsx |
| — | Fix remaining color-border in ControlPanelPage header | e1896bac | ControlPanelPage.tsx |

## What Was Built

**TabNavigation.tsx:**
- Removed `borderTop: "1px solid var(--color-border)"` from nav element (D-01)
- Added `justify-center` to nav, wrapped TABS.map in `<div style={{ maxWidth: 640 }}>` (D-05)
- Added WAI-ARIA roving focus: `useRef<HTMLElement>`, `onKeyDown` handler with ArrowLeft/ArrowRight/Home/End (D-06)
- `tabIndex={active ? 0 : -1}` — only active tab in natural tab order

**ServerSidebar.tsx:**
- Removed `border-r`, `border-b`, `border-t` — all `border-[var(--color-border)]` gone (D-01)
- Width changed 200px → 220px per UI-SPEC; `backgroundColor: "var(--color-bg-secondary)"` for visual separation (D-03)
- `statusDotStyle` constant and status dot `<div>` removed entirely (D-09)
- Disconnect button: added `group-focus-within:opacity-100` alongside existing `group-hover:opacity-100` (D-19)
- Hover class fixed: `hover:bg-[var(--color-bg-hover)]` replacing `/50` opacity hack (D-16)

**ServerTabs.tsx:**
- Tab bar `border-b border-[var(--color-border)]` removed (D-01)
- Replaced conditional rendering (`{activeTab === "status" && ...}`) with display:none pattern for all 6 tabs (D-13, D-14)
- Outer wrapper: `flex-1 min-h-0 overflow-hidden`; each tab: `h-full flex flex-col overflow-hidden scroll-overlay py-3 px-4 space-y-4` — scroll preserved

**ControlPanelPage.tsx:**
- `ServerSidebar` now wrapped in animation div: `width/opacity` driven by `sidebarVisible = servers.length >= 2` (D-08, D-11)
- Asymmetric CSS transition: appear uses `--transition-normal` (200ms), disappear uses `--transition-fast` (150ms) per Motion Contract
- `onAddServer` handler no longer calls `handleDisconnect()` — Add Server is safe while VPN is active (D-10)
- Removed unused `showAddForm` state (was never read in JSX — Rule 1 auto-fix)
- Removed `border-b border-[var(--color-border)]` from connected server header (D-01)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused showAddForm state from ControlPanelPage**
- **Found during:** Task 3
- **Issue:** `showAddForm` state was declared and set (`setShowAddForm(true)`) but never read in JSX — TypeScript reported TS6133 unused variable warning
- **Fix:** Removed the state entirely. The Add Server button now triggers `setRefreshKey(k => k + 1)` only, which refreshes the panel
- **Files modified:** gui-pro/src/components/ControlPanelPage.tsx
- **Commit:** ecd40321

**2. [Rule 2 - Missing coverage] Removed color-border from ControlPanelPage server header**
- **Found during:** Post-task verification
- **Issue:** Connected server header bar still had `border-b border-[var(--color-border)]` — plan verification step 2 requires zero occurrences
- **Fix:** Removed the class from the header div
- **Files modified:** gui-pro/src/components/ControlPanelPage.tsx
- **Commit:** e1896bac

## Known Stubs

None — all implemented functionality is wired to real data.

Note: `sidebarVisible = servers.length >= 2` will always be `false` in the current single-server build (sidebar stays hidden). This is correct behavior per D-08 — sidebar only appears when multi-server support is added in a future plan.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary changes introduced.

## Self-Check: PASSED

Files exist:
- gui-pro/src/components/layout/TabNavigation.tsx — FOUND
- gui-pro/src/components/ServerSidebar.tsx — FOUND
- gui-pro/src/components/ServerTabs.tsx — FOUND
- gui-pro/src/components/ControlPanelPage.tsx — FOUND

Commits exist:
- f01eb264 — FOUND
- 0cb42530 — FOUND
- ecd40321 — FOUND
- e1896bac — FOUND
