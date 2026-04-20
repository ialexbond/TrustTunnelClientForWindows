---
phase: 06-cleanup
plan: 02
subsystem: design-system
tags: [tailwind, css, cleanup, tokens, documentation]
dependency_graph:
  requires:
    - phase: 06-cleanup-01
      provides: tint tokens in tokens.css
  provides:
    - clean tailwind.config.js without legacy surface palette
    - zero !important overrides in index.css
    - updated design system documentation with tint tokens
  affects: [all-tailwind-consumers, design-system-docs]
tech_stack:
  added: []
  patterns: [specificity-via-attribute-selector, semantic-token-classes]
key_files:
  created: []
  modified:
    - gui-pro/tailwind.config.js
    - gui-pro/src/index.css
    - gui-pro/src/components/ConfigPanel.tsx
    - memory/v3/design-system/known-issues.md
    - memory/v3/design-system/tokens.md
key-decisions:
  - "memory/ files are gitignored -- documentation updates are local-only, not committed"
patterns-established:
  - "Use [data-theme] attribute for specificity boost instead of !important"
  - "Use bg-[var(--color-bg-primary)] for native select option elements"
requirements-completed: [DS-09, DS-10, QA-05, DOC-06]
metrics:
  duration: 132s
  completed: "2026-04-15T05:08:45Z"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 5
---

# Phase 06 Plan 02: Legacy Cleanup & Documentation Summary

**Removed surface palette from tailwind.config.js, eliminated all !important overrides from index.css, and documented tint token architecture in design system docs.**

## Performance

- **Duration:** 2 min 12s
- **Started:** 2026-04-15T05:06:33Z
- **Completed:** 2026-04-15T05:08:45Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Removed entire surface.* color palette (11 colors) from tailwind.config.js -- config now contains only fontSize token bridge
- Eliminated last 2 !important overrides in index.css (window close button hover + webkit credentials button)
- Replaced legacy bg-surface-900 class in ConfigPanel with semantic bg-[var(--color-bg-primary)]
- Updated known-issues.md with 4 completed cleanup targets
- Added comprehensive tint token documentation to tokens.md with categories, naming convention, and cross-references (DOC-06)

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove surface palette and fix !important overrides** - `2de47dbe` (refactor)
2. **Task 2: Update design system documentation** - not committed (memory/ is gitignored per CLAUDE.md)

## Files Created/Modified
- `gui-pro/tailwind.config.js` - Removed surface.* color palette, kept fontSize token bridge
- `gui-pro/src/index.css` - Removed 2 !important overrides, used [data-theme] for specificity
- `gui-pro/src/components/ConfigPanel.tsx` - Replaced bg-surface-900 with semantic token class
- `memory/v3/design-system/known-issues.md` - Marked 4 cleanup targets as completed (local only)
- `memory/v3/design-system/tokens.md` - Added Tint Tokens section and Cross-References (local only)

## Decisions Made
- memory/ documentation files are gitignored per project policy -- changes applied locally but not committed
- Used [data-theme] attribute selector for webkit-credentials specificity boost instead of !important -- [data-theme] is always present on root element
- Kept #fff for close button hover color (platform convention, not a theme token)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All legacy artifacts cleaned: zero surface palette, zero !important, zero bg-surface-* classes
- Design system documentation reflects final token state
- Ready for Phase 06 Plan 03 (todo closure)

## Self-Check: PASSED

- All 5 target files: FOUND
- Commit 2de47dbe: FOUND
- tailwind.config.js surface count: 0
- index.css !important count: 0
- bg-surface-* in components: 0
- known-issues.md [x] count: 4
- tokens.md tint references: 5

---
*Phase: 06-cleanup*
*Completed: 2026-04-15*
