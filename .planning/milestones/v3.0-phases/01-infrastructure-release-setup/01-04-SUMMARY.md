---
phase: 01-infrastructure-release-setup
plan: 04
subsystem: ui
tags: [css, design-tokens, theming, slate-teal, two-tier-architecture]

# Dependency graph
requires: []
provides:
  - Complete two-tier CSS design token system in tokens.css
  - Slate-teal accent palette replacing indigo (#4d9490 dark, #236260 light)
  - All 8 non-color token scales: spacing, typography, z-index, opacity, border-width, motion, shadows-xl, focus ring
  - Dark and light semantic theme blocks with exact UI-SPEC values
  - Status semantic tokens (connected/connecting/error/info/disconnected) with surface variants
  - Accent semantic aliases (interactive/hover/active) per theme
  - prefers-reduced-motion block zeroing all transitions
affects: [02-ssh-port-change-core-engine, 03-ssh-port-change-integration, 04-mtproto-proxy, all phases consuming CSS tokens]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-tier CSS token architecture: primitives in :root, semantics in [data-theme] blocks"
    - "Slate-teal accent (desaturated, professional) instead of indigo AI-look"
    - "Motion tokens as duration-only (150ms), easing composed separately via --ease-out"
    - "Status surface tokens using rgba() with hardcoded 0.08/0.15 opacity over status-500 RGB"
    - "Focus ring: double-ring 2px/4px via box-shadow for WCAG AA compliance on both themes"

key-files:
  created: []
  modified:
    - gui-pro/src/shared/styles/tokens.css

key-decisions:
  - "Preserve all 19 existing backward-compatible semantic token names (no component breakage)"
  - "Transition tokens changed from shorthand (150ms ease) to duration-only (150ms) — easing composed separately"
  - "Status surface tokens hardcoded as rgba() values rather than var(--opacity-hover-overlay) due to CSS variable limitation in rgba()"
  - "Dark default: [data-theme=dark], :root block ensures dark theme works without JS"

patterns-established:
  - "Two-tier: Tier 1 primitives (:root) are raw values; Tier 2 semantics ([data-theme]) map to primitives"
  - "Components reference ONLY semantic tokens, never primitive hex values directly"
  - "All motion via duration token + easing token composed: transition: color var(--transition-fast) var(--ease-out)"

requirements-completed: [DS-01, DS-03, DS-04, DS-05, DS-06, DS-07, DS-11]

# Metrics
duration: 8min
completed: 2026-04-13
---

# Phase 01 Plan 04: Design Token Foundation Summary

**Two-tier CSS token system with slate-teal accent, 8 non-color scales, dark/light semantics, status surfaces, and WCAG AA focus ring — replacing old indigo system entirely**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-04-13T00:00:00Z
- **Completed:** 2026-04-13T00:08:00Z
- **Tasks:** 1 of 1
- **Files modified:** 1

## Accomplishments

- Rewrote tokens.css from 131 to 262 lines with complete two-tier architecture
- Replaced indigo accent scale with slate-teal (#4d9490 dark interactive, #236260 light interactive)
- Added 8 non-color token scales: spacing (--space-1..8), typography (--font-size-xs..lg, weights, tracking), z-index (--z-base..titlebar), opacity, border-width, motion (duration-only + easing + pulse), shadows (--shadow-xl added), focus ring
- Added status semantic tokens (text + surface bg/border) for connected/connecting/error/disconnected/info in both themes
- Added accent semantic aliases (--color-accent-interactive/hover/active) per theme
- Added destructive tokens (#e05545 dark, #b03020 light) with WCAG AA contrast
- Added prefers-reduced-motion block zeroing all --transition-* and --pulse-duration
- Removed all old indigo values (#818cf8, #6366f1, #4f46e5) and blue-tint dark bg (#0a0a0f)
- Preserved all 19 backward-compatible semantic token names used by existing components

## Task Commits

1. **Task 1: Rewrite tokens.css with two-tier token architecture** — `f0c14168` (feat)

## Files Created/Modified

- `gui-pro/src/shared/styles/tokens.css` — Complete two-tier design token system (262 lines)

## Decisions Made

- Transition tokens changed from shorthand `150ms ease` to duration-only `150ms` — easing is now composed separately via `--ease-out` / `--ease-in-out` tokens, enabling flexible usage patterns
- Status surface tokens use hardcoded `rgba(R, G, B, 0.08)` values (not `rgba(var(...), 0.08)`) because CSS custom properties cannot be used inside rgba() channels without color-mix() — this is intentional and correct
- `[data-theme="dark"], :root` dual selector ensures dark theme is active by default even before JS sets the data-theme attribute, preventing flash

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- tokens.css is the CSS foundation consumed by all subsequent phases (2-6)
- All 19 existing components in shared/ui/ remain fully functional (backward-compatible token names preserved)
- Storybook MDX pages (Colors, Typography, Spacing, Shadows) can now reference these tokens visually
- Phase 2+ can use new token scales (--space-*, --font-size-*, --z-*, --focus-ring, --color-accent-interactive) without CSS-side changes

## Self-Check

- [x] `f0c14168` commit exists and contains tokens.css changes
- [x] All acceptance criteria verified via grep (262 lines, all tokens present, 0 old indigo values)
- [x] SUMMARY.md created in correct directory

## Self-Check: PASSED

---
*Phase: 01-infrastructure-release-setup*
*Completed: 2026-04-13*
