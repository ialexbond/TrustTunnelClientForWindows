---
phase: 03-control-panel
plan: "03"
subsystem: gui-app/storybook
tags: [storybook, stories, behavior-spec, control-panel, documentation]
dependency_graph:
  requires: [03-01, 03-02]
  provides: [storybook-stories-control-panel, behavior-spec-control-panel]
  affects: [gui-app/src/components]
tech_stack:
  added: []
  patterns: [storybook-story-per-state, fullscreen-layout, snackbar-decorator]
key_files:
  created:
    - gui-app/src/components/server/SshConnectForm.stories.tsx
    - gui-app/src/components/StatusPanel.stories.tsx
    - gui-app/src/components/ControlPanelPage.stories.tsx
    - memory/v3/screens/control-panel.md
  modified:
    - gui-app/.storybook/tauri-mocks/plugin-dialog.ts
decisions:
  - SshConnectForm key modes are interactive (user clicks auth toggle in live story) — no separate stories needed
  - ControlPanelPage NoCredentials is the primary verifiable state in Storybook (Tauri mock returns null)
  - memory/ is gitignored per project policy — behavior spec exists on disk but not in git
metrics:
  duration: "~30 min"
  completed: "2026-04-14"
  tasks_completed: 2
  tasks_total: 3
  files_created: 4
  files_modified: 1
---

# Phase 03 Plan 03: Storybook Stories + Behavior Spec Summary

One-liner: Storybook stories for all 3 Control Panel components (SshConnectForm, StatusPanel, ControlPanelPage) with all VPN states, plus behavior specification document establishing Phase 4 template.

## Tasks Completed

### Task 1: Storybook stories for SshConnectForm, StatusPanel, ControlPanelPage

Created three story files following Phase 2 patterns:

**SshConnectForm.stories.tsx** (`Screens/SshConnectForm`):
- SnackBarProvider decorator (required for toast system)
- fullscreen layout
- Default, PasswordMode, KeyMode stories
- Key modes are interactive — user clicks auth toggle in live story

**StatusPanel.stories.tsx** (`Screens/StatusPanel`):
- All 6 VPN states: Disconnected, Connected, Connecting, Disconnecting, Recovering, Error
- Connected story passes `connectedSince` with Date value (1h 1m 1s ago)
- Error story passes Russian error text
- AllStates composite render story
- argTypes for status select control and error text

**ControlPanelPage.stories.tsx** (`Screens/ControlPanelPage`):
- SnackBarProvider decorator
- fullscreen layout
- NoCredentials story (primary verifiable state — Tauri mock returns null -> shows SshConnectForm)
- Comment documenting why connected state requires running app

Storybook build: SUCCESS (5.70s, 1838 modules transformed)

### Task 2: Behavior specification document

Created `memory/v3/screens/control-panel.md` (gitignored per project policy):
- ## Overview: 3-component structure
- ## Components: table with file paths and roles
- ## Dependencies: design system primitives per component
- ## States: Page States, SshConnectForm States (8 states), StatusPanel VPN States (6 states), Error Display
- ## Transitions: No creds -> Connected, Connected -> No creds, Auto-refresh
- ## Edge Cases: 8 edge cases documented
- ## Accessibility: 6 elements with a11y features
- ## i18n Keys: all keys for SshConnectForm, StatusPanel, ControlPanelPage
- ## Test Coverage: counts from ControlPanelPage.test.tsx (16), StatusPanel.test.tsx (9), SshConnectForm.test.tsx (20)
- ## Storybook Stories: cross-reference to created story files

Establishes template structure for Phase 4 screen specs.

### Task 3: Visual checkpoint (PENDING — human verification required)

Not executed — checkpoint task awaiting user visual verification.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `save()` export to plugin-dialog Tauri mock**
- **Found during:** Task 1 verification (Storybook build)
- **Issue:** `UsersSection.tsx` imports `save` from `@tauri-apps/plugin-dialog` but the Storybook mock only exported `open`. This caused Storybook build to fail with rollup error: "save is not exported".
- **Fix:** Added `save` mock function to `.storybook/tauri-mocks/plugin-dialog.ts` with warning log.
- **Files modified:** `gui-app/.storybook/tauri-mocks/plugin-dialog.ts`
- **Commit:** 0696e9d5

**2. [Rule 3 - Blocking] Installed missing npm dependencies**
- **Found during:** Task 1 verification
- **Issue:** `remark-gfm` was in package.json but not installed in node_modules. Storybook failed with ERR_MODULE_NOT_FOUND.
- **Fix:** `npm install --legacy-peer-deps` (needed due to peer dep conflict in eslint-plugin-react-hooks)
- **Scope:** Pre-existing issue, installation was not committed (node_modules gitignored)

## Pre-existing Test Failures (Deferred)

Not introduced by this plan — existed before our changes:
- `src/shared/ui/Section.test.tsx`: 2 tests failing (collapsible visibility behavior)
- `src/components/routing/ProcessFilterSection.test.tsx`: 2 tests failing (modal/picker behavior)
- `src/shared/utils/credentialGenerator.test.ts`: 1 test flaky (username collision probability)

Logged for future attention — out of scope for Phase 3 Plan 3.

## Self-Check

### Files Created
- [x] `gui-app/src/components/server/SshConnectForm.stories.tsx` — EXISTS
- [x] `gui-app/src/components/StatusPanel.stories.tsx` — EXISTS
- [x] `gui-app/src/components/ControlPanelPage.stories.tsx` — EXISTS
- [x] `memory/v3/screens/control-panel.md` — EXISTS (gitignored, on disk)

### Commits
- [x] `0696e9d5` — feat(03-03): add Storybook stories

### Storybook Build
- [x] Build completed successfully (exit code 0)

## Self-Check: PASSED
