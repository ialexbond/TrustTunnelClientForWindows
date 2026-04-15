---
phase: 06-cleanup
plan: 01
subsystem: design-system
tags: [tokens, rgba, css-variables, cleanup]
dependency_graph:
  requires: []
  provides: [tint-tokens, overlay-tokens]
  affects: [all-components-using-rgba]
tech_stack:
  added: []
  patterns: [css-custom-property-tints, theme-aware-tint-tokens]
key_files:
  created: []
  modified:
    - gui-app/src/shared/styles/tokens.css
    - gui-app/src/components/AboutPanel.tsx
    - gui-app/src/components/ChangelogModal.tsx
    - gui-app/src/components/wizard/DoneStep.tsx
    - gui-app/src/components/wizard/ErrorStep.tsx
    - gui-app/src/components/wizard/EndpointStep.tsx
    - gui-app/src/components/wizard/ImportConfigModal.tsx
    - gui-app/src/components/wizard/FoundStep.tsx
    - gui-app/src/components/wizard/StepBar.tsx
    - gui-app/src/components/wizard/WelcomeStep.tsx
    - gui-app/src/components/routing/ProcessPickerModal.tsx
    - gui-app/src/components/routing/RuleEntryRow.tsx
    - gui-app/src/components/settings/ConnectionSection.tsx
    - gui-app/src/components/server/FirewallSection.tsx
    - gui-app/src/components/server/ExportSection.tsx
    - gui-app/src/components/server/DangerZoneSection.tsx
    - gui-app/src/components/server/_securityHelpers.tsx
    - gui-app/src/components/server/UsersSection.tsx
    - gui-app/src/components/server/UsersSection.test.tsx
    - gui-app/src/components/server/VersionSection.tsx
    - gui-app/src/index.css
decisions:
  - "Added --color-accent-tint-40 token (not in original plan) to support rgba(99,102,241,0.4) in EndpointStep.tsx"
metrics:
  duration: 425s
  completed: "2026-04-15T04:57:00Z"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 21
---

# Phase 06 Plan 01: rgba() Tokenization Summary

**One-liner:** Tokenized all 42 inline rgba() values across 17 components into 24 CSS custom property tint tokens with dark/light theme variants.

## What Was Done

### Task 1: Create tint and overlay tokens in tokens.css
- Added 22 tint tokens (accent: 8, success: 7, warning: 7, danger: 5) to dark theme section
- Added matching 22 tint tokens with light-theme-appropriate base colors (600-tier)
- Added 2 overlay tokens (--color-overlay-40, --color-overlay-50)
- Token naming follows `--color-{status}-tint-{opacity}` pattern per D-02
- Tokens placed after "Status surfaces" and before "Glass" in both theme sections
- **Commit:** 7f243815

### Task 2: Migrate all 42 inline rgba() in components to token vars
- Replaced all rgba() in 17 component .tsx files with `var(--color-*-tint-*)` references
- Updated 2 test assertions in UsersSection.test.tsx to check for var() instead of rgba()
- Migrated wizard-input focus shadow in index.css to `var(--color-accent-tint-15)`
- Migrated Tailwind arbitrary value in RuleEntryRow.tsx: `hover:bg-[var(--color-danger-tint-10)]`
- **Commit:** 24192141

## Verification Results

1. `grep -rn "rgba(" gui-app/src/components/ --include="*.tsx"` -- **0 matches** (zero rgba remain)
2. `npx vitest run` -- 87 passed, 7 failed (all pre-existing, unrelated to this plan)
3. `npm run typecheck` -- pre-existing errors only (IconButton, PanelErrorBoundary, etc.), none from this plan
4. tokens.css contains tint tokens in both `[data-theme="dark"]` and `[data-theme="light"]` sections

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing token] Added --color-accent-tint-40**
- **Found during:** Task 1 analysis
- **Issue:** Plan specified accent tint tokens 06/08/10/15/20/30/50 but EndpointStep.tsx uses `rgba(99, 102, 241, 0.4)` requiring an accent-tint-40 token
- **Fix:** Added `--color-accent-tint-40` to both dark and light theme sections
- **Files modified:** gui-app/src/shared/styles/tokens.css
- **Commit:** 7f243815

## Pre-existing Issues (Out of Scope)

- 7 test files with 13 failing tests (Button, ConfirmDialog, Section, ControlPanelPage, etc.) -- pre-existing before this plan
- 5 TypeScript errors (IconButton, PanelErrorBoundary, Section.test, SnackBar.stories, Tooltip) -- pre-existing

## Known Stubs

None -- all rgba() values fully migrated to token references.

## Self-Check: PASSED
