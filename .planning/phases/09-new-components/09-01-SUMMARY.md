---
phase: 09-new-components
plan: "01"
subsystem: shared-ui
tags: [components, skeleton, status-indicator, cva, storybook, tests]
dependency_graph:
  requires: []
  provides: [Skeleton, StatusIndicator, skeleton-pulse-keyframe]
  affects: [StatCard (Plan 03), Security tab (Phase 11)]
tech_stack:
  added: []
  patterns: [CVA variants, forwardRef + displayName, aria-hidden decorative, role=img accessibility]
key_files:
  created:
    - gui-app/src/shared/ui/Skeleton.tsx
    - gui-app/src/shared/ui/Skeleton.stories.tsx
    - gui-app/src/shared/ui/Skeleton.test.tsx
    - gui-app/src/shared/ui/StatusIndicator.tsx
    - gui-app/src/shared/ui/StatusIndicator.stories.tsx
    - gui-app/src/shared/ui/StatusIndicator.test.tsx
  modified:
    - gui-app/src/index.css
decisions:
  - "Skeleton uses aria-hidden=true — decorative element, no semantic meaning"
  - "StatusIndicator uses role=img + aria-label for screen reader accessibility"
  - "--color-status-info token exists in tokens.css, used directly for info variant"
  - "Pulse animation uses existing --pulse-duration/--pulse-easing tokens for reduced-motion support"
metrics:
  duration: "~8m"
  completed: "2026-04-15"
  tasks_completed: 2
  files_created: 6
  files_modified: 1
  tests_added: 13
---

# Phase 09 Plan 01: Skeleton and StatusIndicator Components Summary

Two foundational shared/ui primitives built with CVA, forwardRef, Storybook stories, and behavior tests. These components unblock downstream Phase 10-11 work (StatCard, Security tab).

## What Was Built

### Skeleton component (`Skeleton.tsx`)

Loading placeholder with three CVA variants:
- `line` — rounded rectangle with fixed `h-3` height, for text rows
- `circle` — rounded-full shape, for avatars
- `card` — rounded-lg rectangle, for card skeletons

Key implementation details:
- `animate-[skeleton-pulse_var(--pulse-duration)_var(--pulse-easing)_infinite]` references the new keyframe and existing motion tokens
- `prefers-reduced-motion` handled automatically: `--pulse-duration: 0s` in tokens.css stops animation
- `aria-hidden="true"` — decorative element, correct per WCAG (no content, purely visual)
- `forwardRef + displayName` matching Button.tsx pattern
- Width/height via `style` prop (not CVA) for flexible numeric/string values

### @keyframes skeleton-pulse (index.css)

Added after `slideInUp` in the Animations section:
```css
@keyframes skeleton-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

### StatusIndicator component (`StatusIndicator.tsx`)

Colored status dot with five semantic states and three sizes:

| Status  | Token                         |
|---------|-------------------------------|
| success | `--color-status-connected`    |
| warning | `--color-status-connecting`   |
| danger  | `--color-status-error`        |
| neutral | `--color-text-muted`          |
| info    | `--color-status-info`         |

| Size | Tailwind   | Pixels |
|------|------------|--------|
| sm   | w-1.5 h-1.5 | 6px   |
| md   | w-2 h-2    | 8px    |
| lg   | w-2.5 h-2.5 | 10px  |

Key implementation details:
- `role="img"` + `aria-label` for accessibility (screen readers announce the status)
- `label` prop overrides aria-label; falls back to status string
- `pulse` prop adds Tailwind `animate-pulse` (reuses browser animation, no custom keyframe needed)
- `forwardRef + displayName` matching Button.tsx pattern

### Storybook Stories

**Skeleton.stories.tsx** (`Primitives/Skeleton`, autodocs):
- `Default` — controlled story with args
- `Variants` — all three variants side by side
- `TextBlock` — realistic multi-line text skeleton

**StatusIndicator.stories.tsx** (`Primitives/StatusIndicator`, autodocs):
- `Default` — success state with label
- `AllStatuses` — all 5 statuses in a row
- `Sizes` — sm/md/lg comparison
- `WithPulse` — animated success and warning

## Tests

| File | Tests | Result |
|------|-------|--------|
| Skeleton.test.tsx | 6 | PASS |
| StatusIndicator.test.tsx | 7 | PASS |
| **Total** | **13** | **13/13** |

Skeleton tests: aria-hidden, style width/height, percentage width, forwardRef, className, div nodeName.

StatusIndicator tests: role=img + custom label, fallback to status string, animate-pulse present/absent, forwardRef, span nodeName, custom className.

## Deviations from Plan

None — plan executed exactly as written.

The plan noted to verify `--color-status-info` token existence. Confirmed in tokens.css line 163 (dark theme) and line 272 (light theme). Used directly without fallback.

## Known Stubs

None — both components are complete presentational primitives with no data dependencies.

## Threat Flags

None — both components are purely presentational with no external data flow (consistent with T-09-01, T-09-02 in plan threat model).

## Self-Check: PASSED

Files created:
- FOUND: gui-app/src/shared/ui/Skeleton.tsx
- FOUND: gui-app/src/shared/ui/Skeleton.stories.tsx
- FOUND: gui-app/src/shared/ui/Skeleton.test.tsx
- FOUND: gui-app/src/shared/ui/StatusIndicator.tsx
- FOUND: gui-app/src/shared/ui/StatusIndicator.stories.tsx
- FOUND: gui-app/src/shared/ui/StatusIndicator.test.tsx
- FOUND: @keyframes skeleton-pulse in gui-app/src/index.css
- FOUND: opacity: 0.4 in skeleton-pulse keyframe

Commits:
- FOUND: 27c4ec19 (feat(09-01): Skeleton component)
- FOUND: 79e3d512 (feat(09-01): StatusIndicator component)
