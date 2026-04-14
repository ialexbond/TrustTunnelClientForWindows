---
phase: 04-application-shell
plan: "04"
subsystem: frontend-layout-shell
tags: [titlebar, tab-navigation, window-controls, css-tokens, tdd, layout]
dependency_graph:
  requires:
    - AppTab 5-value union type in shared/types.ts (Plan 04-03)
    - i18n keys: tabs.controlPanel, tabs.connection, tabs.routing, tabs.appSettings, tabs.about (Plan 04-03)
    - CSS token variables in tokens.css (Phase 1)
  provides:
    - TitleBar component: app branding + drag region + children slot
    - TabNavigation component: 5-tab bar using AppTab with i18n + disabled state
    - WindowControls redesign: all colors via CSS tokens
  affects:
    - gui-app/src/App.tsx (will use TitleBar + TabNavigation in Plan 04-06)
tech_stack:
  added: []
  patterns:
    - TDD: RED (tests first) → GREEN (implementation) cycle
    - CSS token vars only — zero hardcoded color values in new/modified components
    - aria-selected + role="tablist" for accessible tab navigation
key_files:
  created:
    - gui-app/src/components/layout/TitleBar.tsx
    - gui-app/src/components/layout/TitleBar.test.tsx
    - gui-app/src/components/layout/TabNavigation.tsx
    - gui-app/src/components/layout/TabNavigation.test.tsx
  modified:
    - gui-app/src/components/layout/WindowControls.tsx
decisions:
  - "TitleBar extracted as standalone component with children slot for WindowControls"
  - "TabNavigation settings tab uses tabs.appSettings key (matches existing Sidebar behavior)"
  - "WindowControls hover color: rgba(255,255,255,0.08) → var(--color-bg-hover) for theme compatibility"
  - "WindowControls close: #e81123 → var(--color-destructive), supports both dark/light themes"
metrics:
  duration: "~15 min"
  completed: "2026-04-14T15:00:47Z"
  tasks_completed: 2
  files_changed: 5
---

# Phase 4 Plan 04: Application Shell — TitleBar + TabNavigation + WindowControls Summary

**One-liner:** TDD-built TitleBar (app branding + drag region) and TabNavigation (5-tab AppTab bar with i18n + disabled state), plus WindowControls redesign replacing all hardcoded colors with CSS token variables.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | TitleBar + TabNavigation (TDD: RED→GREEN) | f1acb6e5 | TitleBar.tsx, TitleBar.test.tsx, TabNavigation.tsx, TabNavigation.test.tsx |
| 2 | WindowControls CSS token redesign | eecb7369 | WindowControls.tsx |

## What Was Built

### Task 1: TitleBar + TabNavigation (TDD)

**RED phase**: Wrote 20 failing tests for TitleBar (7 tests) and TabNavigation (13 tests) before any implementation. Tests confirmed failure with "Cannot find module" errors.

**GREEN phase**: Implemented both components to pass all 20 tests.

**TitleBar** (`TitleBar.tsx`):
- Renders "TrustTunnel" brand text + "PRO" badge
- `data-tauri-drag-region` on root element and brand area
- `height: 32px` matching titlebar spec
- All colors via CSS tokens: `--color-bg-secondary`, `--color-border`, `--color-text-secondary`, `--color-accent-interactive`
- `children` prop as slot for WindowControls

**TabNavigation** (`TabNavigation.tsx`):
- `role="tablist"` nav container
- 5 tab buttons for `AppTab` union: control/connection/routing/settings/about
- i18n labels: tabs.controlPanel, tabs.connection, tabs.routing, tabs.appSettings, tabs.about
- `aria-selected={active}` on each button
- Tabs with `requiresConfig: true` (connection, routing, settings) disabled when `hasConfig=false`
- Active tab: `borderBottom: 2px solid var(--color-accent-interactive)`
- All colors via CSS tokens only

### Task 2: WindowControls CSS Token Redesign

Replaced all hardcoded color values with CSS custom property references:

| Before | After | Purpose |
|--------|-------|---------|
| `rgba(255,255,255,0.08)` | `var(--color-bg-hover)` | Min/max hover background |
| `#e81123` | `var(--color-destructive)` | Close hover background |
| `#fff` | `var(--color-text-inverse)` | Close hover icon color |
| `undefined` | `var(--color-text-secondary)` | Default icon color |

Added `transition` tokens to all three buttons for smooth hover animation.

## Test Results

```
Layout tests: 38 passed (Sidebar: 18, TitleBar: 7, TabNavigation: 13)
```

## Deviations from Plan

None — plan executed exactly as specified.

Note: Plan file (04-04-PLAN.md) was not present on disk in this worktree, but the task description in the execution prompt provided sufficient specification. All work matches the documented requirements from the prompt context and prior wave summaries.

## Known Stubs

None. Both new components are fully implemented and wired up. App.tsx integration (replacing the hardcoded titlebar div) is deferred to Plan 04-06 as stated in the ROADMAP scope.

## Self-Check: PASSED

- `gui-app/src/components/layout/TitleBar.tsx` — exists, renders "TrustTunnel" + "PRO", has data-tauri-drag-region, uses CSS vars ✓
- `gui-app/src/components/layout/TitleBar.test.tsx` — 7 tests passing ✓
- `gui-app/src/components/layout/TabNavigation.tsx` — exists, role=tablist, 5 TABS, uses AppTab type ✓
- `gui-app/src/components/layout/TabNavigation.test.tsx` — 13 tests passing ✓
- `gui-app/src/components/layout/WindowControls.tsx` — no hardcoded colors, all CSS vars ✓
- Commit f1acb6e5 exists ✓
- Commit eecb7369 exists ✓
