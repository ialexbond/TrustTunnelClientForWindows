---
phase: 01-infrastructure-release-setup
plan: "05"
subsystem: design-system
tags: [css, tokens, theme, flash-prevention, deprecation]
dependency_graph:
  requires: [01-04]
  provides: [clean-index-css, deprecated-glows, flash-free-html, memory-v3-docs]
  affects: [gui-app/src/index.css, gui-app/src/shared/ui/colors.ts, gui-app/index.html]
tech_stack:
  added: []
  patterns: [data-theme attribute, IIFE theme script, JSDoc @deprecated]
key_files:
  modified:
    - gui-app/src/index.css
    - gui-app/src/shared/ui/colors.ts
    - gui-app/index.html
  created:
    - memory/v3/design-system/tokens.md (gitignored, local-only)
    - memory/v3/decisions/phase-1-decisions.md (gitignored, local-only)
decisions:
  - "[data-theme] overrides removed from index.css; theme switching delegated entirely to tokens.css"
  - "Glow values (successGlow, dangerGlow, accentLogoGlow) deprecated to 'none' with @deprecated JSDoc for Phase 6 removal"
  - "Theme flash prevention via IIFE script in <head> reading tt_theme localStorage key"
  - "memory/v3/ docs are gitignored local-only files per project policy"
metrics:
  duration: "3 minutes"
  completed: "2026-04-13"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
  files_created: 2
---

# Phase 01 Plan 05: CSS Cleanup and Flash Prevention Summary

**One-liner:** Removed all 55 `[data-theme]` overrides from index.css, deprecated glow values in colors.ts to `"none"`, added IIFE theme flash prevention script to index.html, and created local memory/v3/ documentation.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Remove [data-theme] overrides from index.css, deprecate glow in colors.ts | `3a725104` | gui-app/src/index.css, gui-app/src/shared/ui/colors.ts |
| 2 | Add theme flash prevention script, create memory/v3/ docs | `e8e94358` | gui-app/index.html, memory/v3/ (local) |

## What Was Built

### Task 1: index.css cleanup + colors.ts deprecation

**index.css (DS-02):**
- Removed all 55 `[data-theme]` selector blocks (lines 119-372 of original)
- Retained: `@tailwind` directives, `@layer base`, `@layer components` (glass-card, btn-primary, btn-danger, status-dots, wizard-input), `.border` token rule, animations, scrollbar rules, scroll-gutter-match
- Result: 183 lines (down from 379), zero `[data-theme]` occurrences
- Theme switching now handled exclusively by `tokens.css` semantic blocks

**colors.ts (DS-08, D-13):**
- `successGlow`: `"0 0 12px rgba(16, 185, 129, 0.6)"` → `"none"`
- `dangerGlow`: `"0 0 12px rgba(239, 68, 68, 0.4)"` → `"none"`
- `accentLogoGlow`: `"rgba(99, 102, 241, 0.15)"` → `"none"`
- All three annotated with `@deprecated v3.0` JSDoc, scheduled for Phase 6 removal
- All other values (successBg, warningBg, dangerBg, accentBg, dropdownShadow, etc.) unchanged

### Task 2: Flash prevention + memory/v3/ docs

**index.html (QA-01):**
- Removed `class="dark"` from `<html>` element
- Added IIFE inline `<script>` inside `<head>` reading `tt_theme` from localStorage
- Handles three modes: `"light"` → light, `"system"` → prefers-color-scheme check, default → `"dark"`
- `try/catch` for private browsing safety (T-01-05-02 mitigation)
- `document.documentElement.setAttribute('data-theme', theme)` matches `useTheme.ts` behavior

**memory/v3/ (local-only, gitignored):**
- `memory/v3/design-system/tokens.md` — Two-tier token architecture, accent/status/spacing/typography/z-index/shadow/motion scales, file references
- `memory/v3/decisions/phase-1-decisions.md` — D-01 through D-13 decision log, #0d0d0d/#f9f9f7 palette decisions, glow removal rationale

## Deviations from Plan

### Minor: Line count 183 vs target 140-170

**Found during:** Task 1 verification
**Issue:** Plan expected ~155 lines, result is 183. The file retains all required sections (wizard-input, number input spinners, scroll-overlay) which together account for the additional lines.
**Fix:** Removed duplicate `input::-ms-reveal` block that was outside `@layer components`. No functional content was removed beyond the [data-theme] blocks.
**Impact:** None — all acceptance criteria (zero data-theme, retained components, retained scrollbar rules) are met. Line count is a soft target.

### Skipped: `npx vitest run` verification

**Found during:** Task 2 verification
**Issue:** worktree has no `node_modules/` (known limitation documented in MEMORY.md: "В worktree нужно копировать sidecar/DLL и собирать фронтенд перед cargo check"). Vitest cannot load vite config without installed dependencies.
**Resolution:** Confirmed via grep that no tests reference the changed CSS/HTML content functionally. `main.test.tsx` only mocks `index.css` (not its content). `Badge.test.tsx` tests component class variants, not glow values. Changes are safe: CSS structure, HTML attribute, deprecated TS constants.

## Known Stubs

None. All changes are complete implementations, not placeholders.

## Threat Flags

None. The localStorage read in index.html is local-only (no external data), sanitized to known values (`dark`/`light`/`system`), and protected by try/catch (T-01-05-02 mitigated).

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| gui-app/src/index.css exists | FOUND |
| gui-app/src/shared/ui/colors.ts exists | FOUND |
| gui-app/index.html exists | FOUND |
| memory/v3/design-system/tokens.md exists | FOUND |
| memory/v3/decisions/phase-1-decisions.md exists | FOUND |
| Commit 3a725104 exists | FOUND |
| Commit e8e94358 exists | FOUND |
| data-theme count in index.css | 0 (pass) |
| @deprecated count in colors.ts | 3 (pass) |
| tt_theme in index.html | 1 (pass) |
