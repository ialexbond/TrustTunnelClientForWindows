---
phase: 04-application-shell
plan: "06"
subsystem: frontend
tags: [storybook, documentation, shell, ui]
dependency_graph:
  requires: ["04-05"]
  provides: ["DOC-04", "DOC-05"]
  affects: []
tech_stack:
  added: []
  patterns: ["Storybook CSF3 stories", "memory/v3 use-case documentation"]
key_files:
  created:
    - gui-app/src/components/layout/TitleBar.stories.tsx
    - gui-app/src/components/layout/TabNavigation.stories.tsx
    - gui-app/src/components/layout/WindowControls.stories.tsx
    - gui-app/src/components/ServerSidebar.stories.tsx
    - memory/v3/use-cases/application-shell.md (gitignored, local only)
    - memory/v3/test-cases/application-shell.md (gitignored, local only)
  modified: []
decisions:
  - "Used plain arrow functions () => {} instead of fn() from @storybook/test — package not in devDependencies"
  - "TitleBar WithWindowControls story added instead of WithUpdate (component has no hasUpdate prop)"
  - "TabNavigation has no hasUpdate prop — AboutWithUpdate story omitted, 6 stories cover all real states"
metrics:
  duration: "~20 min"
  completed: "2026-04-14"
  tasks_completed: 2
  tasks_total: 3
  files_created: 6
---

# Phase 04 Plan 06: Application Shell — Stories & Documentation Summary

One-liner: Storybook stories for 4 shell components (TitleBar, TabNavigation, WindowControls, ServerSidebar) plus DOC-04/DOC-05 use-case and test-case documentation.

## Tasks Completed

### Task 1: Storybook Stories (DONE — commit 07362f3a)

Created 4 story files following existing project patterns (StatusPanel.stories.tsx, ControlPanelPage.stories.tsx):

| File | Stories | States covered |
|------|---------|----------------|
| `layout/TitleBar.stories.tsx` | 2 | Default (brand only), WithWindowControls (full title bar) |
| `layout/TabNavigation.stories.tsx` | 6 | AllEnabled, NoConfig, ConnectionActive, RoutingActive, SettingsActive, AboutActive |
| `layout/WindowControls.stories.tsx` | 1 | Default (hover-interactive: min/max/close states) |
| `ServerSidebar.stories.tsx` | 5 | Empty, SingleConnected, MixedStatuses, ErrorState, Connecting |

TypeScript compiles clean across all 4 new story files (pre-existing errors in unrelated files not fixed per scope rules).

### Task 2: Use-Case and Test-Case Documentation (DONE — local memory only)

Created in `memory/v3/` (gitignored per PROJECT.md policy):

- **`memory/v3/use-cases/application-shell.md`** — 6 use cases (UC-SHELL-01 through UC-SHELL-06) covering tab navigation, config-gated nav, keyboard navigation, server selection, window management, update notification
- **`memory/v3/test-cases/application-shell.md`** — 10 positive test cases (TC-SHELL-P01..P10) + 4 negative test cases (TC-SHELL-N01..N04)

Acceptance criteria met:
- [x] 6 use cases with UC-SHELL IDs
- [x] 10 positive test cases
- [x] 4 negative test cases
- [x] Test cases reference UC IDs
- [x] Token-specific checks included (--color-status-connected, --color-destructive)

### Task 3: Visual Verification (PENDING — checkpoint awaiting user)

This task is a `checkpoint:human-verify` gate. Automated work (Tasks 1-2) is complete. User verification of the visual result is required.

**Steps for user:**
1. Run Storybook: `cd gui-app && npm run storybook` — verify `Layout/` stories render correctly
2. Check TabNavigation stories: AllEnabled (5 tabs), NoConfig (3 disabled), each active state
3. Check ServerSidebar stories: Empty (EmptyState), SingleConnected (green dot), MixedStatuses, ErrorState
4. Check TitleBar: "TrustTunnel" + "PRO" badge, WithWindowControls variant shows all 3 buttons
5. Switch theme in Storybook toolbar (dark/light): verify both themes render correctly
6. In the running app: verify tab navigation works, ServerSidebar on control tab only
7. Verify title bar is draggable, window controls work (minimize/maximize/close)
8. Verify close button turns red on hover

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] @storybook/test not in dependencies**
- **Found during:** Task 1 TypeScript check
- **Issue:** Plan template used `import { fn } from "@storybook/test"` but this package is not installed in the project (not listed in devDependencies)
- **Fix:** Replaced `fn()` calls with plain arrow functions `() => {}` following the pattern in StatusPanel.stories.tsx
- **Files modified:** TabNavigation.stories.tsx, ServerSidebar.stories.tsx
- **Commit:** 07362f3a (included in initial commit)

**2. [Rule 1 - Deviation] TitleBar props differ from plan spec**
- **Found during:** Task 1 component reading
- **Issue:** Plan spec shows `TitleBarProps { hasUpdate?: boolean }` but actual component has `TitleBarProps { children?: ReactNode }` — no hasUpdate prop
- **Fix:** Created `WithWindowControls` story (renders TitleBar with WindowControls as children) instead of `WithUpdate` story
- **Files modified:** TitleBar.stories.tsx
- **Commit:** 07362f3a

**3. [Rule 1 - Deviation] TabNavigation has no hasUpdate prop**
- **Found during:** Task 1 component reading
- **Issue:** Plan spec includes `AboutWithUpdate` story with `hasUpdate: true` but TabNavigation interface only has `{ activeTab, onTabChange, hasConfig }` — no hasUpdate
- **Fix:** Omitted `AboutWithUpdate` story; added `Connecting` story to ServerSidebar.stories.tsx instead to maintain 5 meaningful states
- **Files modified:** TabNavigation.stories.tsx
- **Commit:** 07362f3a

**4. [Rule 3 - Blocking] Worktree on wrong base commit**
- **Found during:** Pre-execution worktree base check
- **Issue:** Worktree HEAD was at `16f6a804` (MTProto proxy branch), not at expected base `bcbb69a2` (Application Shell)
- **Fix:** `git reset --hard bcbb69a2` — reset to correct base before creating any files
- **Impact:** None; no work was lost

## Known Stubs

None — story files render real components with complete prop data. Documentation files are complete.

## Threat Flags

None — plan creates only Storybook stories and gitignored documentation files. No runtime trust boundaries.

## Self-Check

### Files created:
- [x] `gui-app/src/components/layout/TitleBar.stories.tsx` — FOUND
- [x] `gui-app/src/components/layout/TabNavigation.stories.tsx` — FOUND
- [x] `gui-app/src/components/layout/WindowControls.stories.tsx` — FOUND
- [x] `gui-app/src/components/ServerSidebar.stories.tsx` — FOUND
- [x] `memory/v3/use-cases/application-shell.md` — FOUND (gitignored, local)
- [x] `memory/v3/test-cases/application-shell.md` — FOUND (gitignored, local)

### Commits:
- [x] `07362f3a` — feat(04-06): Storybook stories

## Self-Check: PASSED

Task 3 (visual checkpoint) is pending user verification.
