---
phase: 02-ssh-port-change-core-engine
plan: 05
subsystem: ui
tags: [react, typescript, cva, storybook, vitest, tailwind, css-custom-properties]

# Dependency graph
requires:
  - phase: 02-ssh-port-change-core-engine
    provides: cn() utility at shared/lib/cn.ts, tokens.css with all CSS custom properties
  - phase: 02-ssh-port-change-core-engine
    provides: CVA infrastructure (class-variance-authority, clsx, tailwind-merge installed)

provides:
  - Section component with SectionHeader, collapsible support, action slot
  - FormField composition component with label/required/error/hint
  - StatusBadge with 4 CVA VPN-state variants and Russian labels
  - EmptyState with Russian defaults and icon/heading/body/action slots
  - Full Storybook stories for all 4 new components (autodocs)
  - Vitest tests for all 4 components (24 tests total, all passing)

affects:
  - Phase 3+ screen migration (uses Section, FormField, StatusBadge, EmptyState)
  - Any screen showing VPN connection state (uses StatusBadge)
  - Any screen with form inputs (uses FormField)
  - Any screen with zero-data states (uses EmptyState)

# Tech tracking
tech-stack:
  added:
    - class-variance-authority ^0.7.1 (CVA for variant management)
    - clsx ^2.1.1 (class merging helper)
    - tailwind-merge ^3.5.0 (Tailwind class deduplication)
  patterns:
    - TDD (RED→GREEN) for all new components
    - CVA variant pattern: statusBadgeVariants exported alongside component
    - Token-only styling: all colors via CSS custom property vars, zero hardcoded hex
    - Collapsible with local useState — no external state library needed
    - Error takes priority over hint in FormField (conditional rendering)
    - Dot indicator with data-testid for testable visual elements

key-files:
  created:
    - gui-app/src/shared/ui/Section.tsx
    - gui-app/src/shared/ui/Section.test.tsx
    - gui-app/src/shared/ui/Section.stories.tsx
    - gui-app/src/shared/ui/FormField.tsx
    - gui-app/src/shared/ui/FormField.test.tsx
    - gui-app/src/shared/ui/FormField.stories.tsx
    - gui-app/src/shared/ui/StatusBadge.tsx
    - gui-app/src/shared/ui/StatusBadge.test.tsx
    - gui-app/src/shared/ui/StatusBadge.stories.tsx
    - gui-app/src/shared/ui/EmptyState.tsx
    - gui-app/src/shared/ui/EmptyState.test.tsx
    - gui-app/src/shared/ui/EmptyState.stories.tsx
  modified:
    - gui-app/package.json (added CVA dependencies)
    - gui-app/package-lock.json

key-decisions:
  - "CVA installed in this plan (Wave 3) since it was missing from worktree despite Wave 1 building it — worktree isolation requires re-installing dependencies"
  - "StatusBadge dot indicator uses data-testid='status-dot' for reliable test targeting without relying on CSS class inspection"
  - "FormField error/hint pattern: error takes priority — only one helper text shown at a time"
  - "Section collapsible uses conditional rendering (not visibility:hidden) so hidden content is removed from DOM and tab order"

patterns-established:
  - "CVA pattern: export both component and variantsFunction (e.g. StatusBadge + statusBadgeVariants)"
  - "Dot indicators: data-testid attribute for testability"
  - "Section collapsible: local useState with defaultOpen prop"
  - "FormField: error > hint priority via conditional render"

requirements-completed: [COMP-07, COMP-08, COMP-09, COMP-10, COMP-14, SB-04, SB-05]

# Metrics
duration: 12min
completed: 2026-04-14
---

# Phase 02 Plan 05: Section, FormField, StatusBadge, EmptyState Summary

**4 composition + state-display primitives (Section/FormField/StatusBadge/EmptyState) with CVA, Russian copy, token-only styling, 24 vitest tests, and Storybook stories**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-14T01:36:00Z
- **Completed:** 2026-04-14T01:48:00Z
- **Tasks:** 2
- **Files modified:** 14

## Accomplishments

- Section component with collapsible support (chevron toggle, defaultOpen), SectionHeader exported separately with action slot
- FormField wrapping label + input + error (role="alert") + hint, with required indicator (`*`, aria-hidden, --color-danger-500)
- StatusBadge with CVA variants (connected/connecting/error/disconnected), Russian labels, pulsing dot indicator
- EmptyState with Russian defaults ("Ничего нет" / "Здесь появятся элементы после добавления."), icon/heading/body/action slots
- 24 vitest tests across 4 suites, all passing (TDD RED→GREEN)
- 6 stories per component pair in Storybook (autodocs enabled)
- Zero hardcoded hex colors in any component file

## Task Commits

Each task was committed atomically (TDD: test commit → implementation commit):

1. **RED Task 1** - `2c50a012` (test: add failing tests for Section and FormField)
2. **GREEN Task 1** - `83013ddc` (feat: create Section and FormField components + stories)
3. **RED Task 2** - `87a098a7` (test: add failing tests for StatusBadge and EmptyState)
4. **GREEN Task 2** - `3ccb03c7` (feat: create StatusBadge and EmptyState components + stories)

## Files Created/Modified

- `gui-app/src/shared/ui/Section.tsx` — Section + SectionHeader components, collapsible with chevron
- `gui-app/src/shared/ui/Section.test.tsx` — 6 vitest tests (renders, collapsible, defaultOpen, action)
- `gui-app/src/shared/ui/Section.stories.tsx` — Default, WithDescription, Collapsible, CollapsedByDefault, WithAction, NestedSections
- `gui-app/src/shared/ui/FormField.tsx` — FormField with label/required/error/hint composition
- `gui-app/src/shared/ui/FormField.test.tsx` — 6 vitest tests (label, required, error role=alert, hint priority)
- `gui-app/src/shared/ui/FormField.stories.tsx` — Default, Required, WithHint, WithError, WithInputAndError, MultipleFields
- `gui-app/src/shared/ui/StatusBadge.tsx` — CVA badge with 4 VPN state variants + exported statusBadgeVariants
- `gui-app/src/shared/ui/StatusBadge.test.tsx` — 6 vitest tests (4 variant labels, custom label, dot indicator)
- `gui-app/src/shared/ui/StatusBadge.stories.tsx` — Default, AllVariants, Connected, Connecting, Error, Disconnected, WithCustomLabel
- `gui-app/src/shared/ui/EmptyState.tsx` — EmptyState with Russian defaults, icon/heading/body/action
- `gui-app/src/shared/ui/EmptyState.test.tsx` — 6 vitest tests (defaults, custom props, icon, action)
- `gui-app/src/shared/ui/EmptyState.stories.tsx` — Default, WithIcon, WithAction, CustomText, MinimalNoIcon
- `gui-app/package.json` — added class-variance-authority, clsx, tailwind-merge
- `gui-app/package-lock.json` — lockfile update

## Decisions Made

- CVA dependencies re-installed (class-variance-authority, clsx, tailwind-merge) — Wave 1 built them in a separate worktree but worktree isolation requires each agent to install independently
- StatusBadge dot uses `data-testid="status-dot"` for reliable test targeting (not class inspection)
- Section collapsible removes content from DOM entirely (not visibility:hidden) — keyboard focus not trapped in hidden content
- FormField: when both `error` and `hint` are provided, only `error` renders (one helper text at a time)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed missing CVA dependencies in worktree**
- **Found during:** Task 2 (StatusBadge creation)
- **Issue:** class-variance-authority, clsx, tailwind-merge not present in worktree node_modules despite Wave 1 context saying they were built
- **Fix:** `npm install --legacy-peer-deps class-variance-authority clsx tailwind-merge` in gui-app
- **Files modified:** gui-app/package.json, gui-app/package-lock.json
- **Verification:** StatusBadge imports `cva` successfully, all tests pass
- **Committed in:** 3ccb03c7 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — missing dependency)
**Impact on plan:** Necessary for StatusBadge CVA variants. No scope creep.

## Issues Encountered

- npm install initially failed with peer dependency conflict for eslint-plugin-react-hooks — resolved with `--legacy-peer-deps` flag (same approach used throughout Phase 2 Wave execution)

## Known Stubs

None — all components are fully implemented with no placeholder data.

## Threat Flags

None — these are display-only presentation components with no network endpoints, auth paths, or schema changes.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Section, FormField, StatusBadge, EmptyState ready for use in Phase 3 screen migration
- All 4 components use only CSS custom property vars — safe for both dark and light themes
- Storybook stories present for visual review before Phase 3 begins

---
*Phase: 02-ssh-port-change-core-engine*
*Completed: 2026-04-14*
