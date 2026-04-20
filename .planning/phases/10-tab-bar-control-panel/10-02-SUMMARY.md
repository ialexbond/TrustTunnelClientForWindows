---
phase: 10-tab-bar-control-panel
plan: "02"
subsystem: server-tabs-ui
tags: [server-tabs, accordion, cross-fade, status-panel, stat-card, refactor]
completed: "2026-04-15T13:32:54Z"
duration: 5m
tasks_completed: 2
files_modified: 4
requirements: [CP-03, CP-04, CP-05]

dependency_graph:
  requires: []
  provides:
    - ServerTabs 5-tab navigation with DangerZone in Accordion
    - cross-fade opacity transitions for server tab panels
    - StatusPanel box-shadow visual separation
    - ServerStatsCard StatCard-based loading skeleton
  affects:
    - gui-pro/src/components/ServerPanel.tsx (renders ServerTabs)
    - gui-pro/src/components/dashboard/DashboardPage.tsx (renders ServerStatsCard)

tech_stack:
  added: []
  patterns:
    - visibility+opacity cross-fade for tab panels (D-06)
    - Accordion with ReactNode title for DangerZone (D-13, D-14)
    - StatCard skeletons replacing generic spinner in loading state (CP-05)

key_files:
  created: []
  modified:
    - gui-pro/src/shared/ui/Accordion.tsx
    - gui-pro/src/components/ServerTabs.tsx
    - gui-pro/src/components/StatusPanel.tsx
    - gui-pro/src/components/dashboard/ServerStatsCard.tsx

decisions:
  - Accordion.title: string→ReactNode — backward-compatible, enables JSX icon in DangerZone header
  - DangerZone moved into Tools tab Accordion (closed by default) — simplifies tab bar from 6 to 5
  - cross-fade via visibility+opacity instead of display:none — preserves React state, adds smooth transition
  - StatCard loading skeletons show CPU/RAM/Disk layout preview instead of generic spinner
---

# Phase 10 Plan 02: ServerTabs Consolidation & Polish Summary

**One-liner:** ServerTabs reduced from 6 to 5 tabs — DangerZone folded into Tools Accordion with danger-colored ReactNode title, tab panels cross-fade via visibility+opacity, StatusPanel gets shadow-sm, ServerStatsCard loading replaced with StatCard skeletons.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Accordion ReactNode title + ServerTabs 6→5 + cross-fade + DangerZone Accordion | 6b581790 | Accordion.tsx, ServerTabs.tsx |
| 2 | StatusPanel box-shadow + ServerStatsCard StatCard loading | 6b457371 | StatusPanel.tsx, ServerStatsCard.tsx |

## Verification

All 27 tests pass:
- `Accordion.test.tsx` — 10/10
- `StatusPanel.test.tsx` — 9/9
- `ServerStatsCard.test.tsx` — 8/8 (7 existing + cached stats test)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added role=region + aria-labelledby to Accordion content div**
- **Found during:** Task 1, running Accordion.test.tsx
- **Issue:** Two tests failed — `aria-hidden toggles on content region` and `content has role=region with aria-labelledby` — because the content `<div>` lacked `role="region"` and `aria-labelledby={headerId}`. These attributes were already expected by the test file (pre-existing gap).
- **Fix:** Added `role="region"` and `aria-labelledby={headerId}` to the content div in `AccordionItemComponent`.
- **Files modified:** `gui-pro/src/shared/ui/Accordion.tsx`
- **Commit:** 6b581790 (included in Task 1 commit)

**2. [Rule 3 - Blocking] Installed npm dependencies in worktree**
- **Found during:** Task 1, running first vitest
- **Issue:** `gui-pro/node_modules` in worktree contained only `.vite-temp` — full packages absent. Tests could not start.
- **Fix:** Ran `npm install --legacy-peer-deps` in worktree `gui-pro/`. 526 packages installed.
- **Impact:** No code changes, only worktree setup.

## Known Stubs

None — all changes are fully functional.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundary crossings.

## Self-Check: PASSED

- [x] `gui-pro/src/shared/ui/Accordion.tsx` — exists, title: ReactNode, role=region added
- [x] `gui-pro/src/components/ServerTabs.tsx` — exists, 5 tabs, Accordion imported, cross-fade
- [x] `gui-pro/src/components/StatusPanel.tsx` — exists, shadow-sm applied
- [x] `gui-pro/src/components/dashboard/ServerStatsCard.tsx` — exists, StatCard loading state
- [x] Commit 6b581790 exists
- [x] Commit 6b457371 exists
- [x] 27 tests pass
