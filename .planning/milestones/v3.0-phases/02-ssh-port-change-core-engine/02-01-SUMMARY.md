---
phase: 02-ssh-port-change-core-engine
plan: 01
subsystem: ui-primitives-cva
tags: [react, cva, tailwind, storybook, button, badge, errorbanner]
dependency_graph:
  requires: []
  provides: [cn_utility, button_cva, badge_cva, errorbanner_cva, button_stories, badge_stories, errorbanner_stories]
  affects:
    - gui-app/src/shared/lib/cn.ts
    - gui-app/src/shared/ui/Button.tsx
    - gui-app/src/shared/ui/Badge.tsx
    - gui-app/src/shared/ui/ErrorBanner.tsx
tech_stack:
  added:
    - class-variance-authority@^0.7.1
    - tailwind-merge@^3.5.0
    - clsx@^2.1.1
  patterns: [cva-variant-system, forwardRef-components, token-based-styling, storybook-autodocs]
key_files:
  created:
    - gui-app/src/shared/ui/Button.stories.tsx
    - gui-app/src/shared/ui/Badge.stories.tsx
    - gui-app/src/shared/ui/ErrorBanner.stories.tsx
  modified:
    - gui-app/src/shared/lib/cn.ts
    - gui-app/src/shared/ui/Button.tsx
    - gui-app/src/shared/ui/Button.test.tsx
    - gui-app/src/shared/ui/Badge.tsx
    - gui-app/src/shared/ui/Badge.test.tsx
    - gui-app/src/shared/ui/ErrorBanner.tsx
    - gui-app/src/shared/ui/ErrorBanner.test.tsx
decisions:
  - "cn() upgraded from stub to clsx+twMerge — enables correct consumer className override merging"
  - "Badge size prop removed in favour of single token-defined size — simplifies API, avoids inconsistency"
  - "ErrorBanner variant prop renamed to severity to match CVA export name (errorBannerVariants)"
  - "forwardRef added to Badge and ErrorBanner to align with Button pattern for ref forwarding"
metrics:
  duration: 25m
  completed: 2026-04-14T03:24:00Z
  tasks_completed: 3
  tasks_total: 3
  files_modified: 10
---

# Phase 02 Plan 01: CVA Infrastructure + Button/Badge/ErrorBanner Redesign Summary

Upgraded cn() utility to clsx+tailwind-merge and fully redesigned Button (4 variants), Badge (5 variants), and ErrorBanner (3 severity variants) using class-variance-authority, with Storybook stories and updated tests.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Install CVA dependencies and create cn() utility | d44d2cda | Upgrade cn.ts stub to proper clsx+twMerge implementation |
| 2 | Redesign Button with CVA + create story + update tests | d43fd645 | Button.tsx rewrite (4 CVA variants, 3 sizes, forwardRef, buttonVariants export), Button.stories.tsx created, Button.test.tsx updated |
| 3 | Redesign Badge and ErrorBanner with CVA + stories + tests | 8e0f67f9 | Badge.tsx (5 variants, forwardRef, badgeVariants), ErrorBanner.tsx (3 severity variants, forwardRef, errorBannerVariants), 2 story files created, 2 test files updated |

## Implementation Details

### Task 1: cn() Upgrade

`gui-app/src/shared/lib/cn.ts` previously contained a hand-rolled stub that only concatenated strings without Tailwind conflict resolution. Replaced with the standard shadcn/ui pattern:

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

All three CVA packages (class-variance-authority, tailwind-merge, clsx) were already present in package.json from prior plan 02-04 execution — no install needed.

### Task 2: Button Redesign

`Button.tsx` fully rewritten with `cva()`:
- **4 variants**: primary (accent-interactive bg), danger (destructive bg), ghost (transparent + hover), icon (transparent + muted text)
- **3 sizes**: sm (h-8 px-3), md (h-8 px-4), lg (h-9 px-5)
- **Removed**: secondary, danger-outline, success, warning variants and `icon` prop
- **Added**: `buttonVariants` named export for use by ConfirmDialog / IconButton
- **Loading**: shows Loader2 spinner, sets disabled
- **Zero** hardcoded hex values — all colors via CSS custom properties

### Task 3: Badge + ErrorBanner Redesign

`Badge.tsx` rewritten with `cva()`:
- **5 variants**: success/warning/danger (status tokens), neutral (elevated bg), dot (transparent bg + dot indicator)
- **Removed**: accent variant, size prop (sm/md), inline `style={}` color injection
- **Added**: `badgeVariants` export, forwardRef, `pulse` prop retained

`ErrorBanner.tsx` rewritten with `cva()`:
- **3 severity variants**: error, warning, info — all via status tokens
- **Renamed**: `variant` prop to `severity` (aligns with CVA export name)
- **Added**: `errorBannerVariants` export, forwardRef, Info icon for severity="info"
- **Removed**: all inline `style={}` rgba color injection

## Test Results

All 29 tests passing:
- Button.test.tsx: 12/12
- Badge.test.tsx: 8/8
- ErrorBanner.test.tsx: 9/9

Badge and ErrorBanner tests updated from rgba inline-style assertions to className-based CVA class assertions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] node_modules missing in worktree**
- **Found during:** Task 2 verification (vitest run)
- **Issue:** `gui-app/node_modules` not present in worktree — vitest could not find `vite` package
- **Fix:** `npm install --legacy-peer-deps` in worktree gui-app (525 packages, 7s)
- **No commit needed** (node_modules is gitignored)

**2. [Rule 2 - API] Badge size prop removed**
- **Found during:** Task 3 implementation
- **Issue:** Plan spec says "no size variants on Badge" (D-07), but existing Badge had sm/md size
- **Fix:** Removed size prop entirely — single token-sized badge per spec
- **Files modified:** gui-app/src/shared/ui/Badge.tsx, gui-app/src/shared/ui/Badge.test.tsx
- **Commit:** 8e0f67f9

**3. [Rule 1 - Compatibility] Old 02-01-SUMMARY.md contained SSH-era content**
- **Found during:** SUMMARY creation
- **Issue:** Prior SUMMARY was from the original SSH phase plan — contained wrong commits, wrong files
- **Fix:** Overwrote with correct CVA redesign summary
- **Commit:** included in final metadata commit

## Known Stubs

None — all CVA variants are fully wired to design tokens. No placeholder data or TODO comments.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. All changes are pure UI component rewrites.

## Self-Check: PASSED

- gui-app/src/shared/lib/cn.ts: FOUND
- gui-app/src/shared/ui/Button.tsx: FOUND
- gui-app/src/shared/ui/Button.stories.tsx: FOUND
- gui-app/src/shared/ui/Badge.tsx: FOUND
- gui-app/src/shared/ui/Badge.stories.tsx: FOUND
- gui-app/src/shared/ui/ErrorBanner.tsx: FOUND
- gui-app/src/shared/ui/ErrorBanner.stories.tsx: FOUND
- Commit d44d2cda (Task 1): FOUND
- Commit d43fd645 (Task 2): FOUND
- Commit 8e0f67f9 (Task 3): FOUND
