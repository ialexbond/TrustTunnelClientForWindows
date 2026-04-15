---
phase: 02-ssh-port-change-core-engine
plan: 04
subsystem: ui-primitives
tags: [react, ui, accessibility, tokens, storybook, select, snackbar, iconbutton, dropoverlay]
dependency_graph:
  requires: [02-01]
  provides:
    - Select custom dropdown with keyboard navigation and ARIA
    - SnackBar with correct color-status-error token
    - IconButton with required aria-label
    - DropOverlay with token-driven typography
    - PanelErrorBoundary with correct token references
    - cn() utility in shared/lib/cn.ts
  affects:
    - gui-app/src/shared/ui/Select.tsx
    - gui-app/src/shared/ui/SnackBar.tsx
    - gui-app/src/shared/ui/IconButton.tsx
    - gui-app/src/shared/ui/DropOverlay.tsx
    - gui-app/src/shared/ui/PanelErrorBoundary.tsx
tech_stack:
  added: []
  patterns:
    - "forwardRef + combobox/listbox ARIA pattern for custom dropdown"
    - "Keyboard navigation: ArrowUp/Down/Home/End/Enter/Escape/Tab"
    - "Token-driven z-index via CSS custom properties (var(--z-dropdown), var(--z-snackbar))"
    - "Required aria-label on IconButton enforced via TypeScript interface"
    - "Dev-mode console.error for accessibility violations"
key_files:
  created:
    - gui-app/src/shared/lib/cn.ts
    - gui-app/src/shared/ui/Select.stories.tsx
    - gui-app/src/shared/ui/SnackBar.stories.tsx
    - gui-app/src/shared/ui/IconButton.stories.tsx
    - gui-app/src/shared/ui/DropOverlay.stories.tsx
    - gui-app/src/shared/ui/PanelErrorBoundary.stories.tsx
  modified:
    - gui-app/src/shared/ui/Select.tsx
    - gui-app/src/shared/ui/Select.test.tsx
    - gui-app/src/shared/ui/SnackBar.tsx
    - gui-app/src/shared/ui/SnackBar.test.tsx
    - gui-app/src/shared/ui/SnackBarContext.tsx (verified clean — no changes needed)
    - gui-app/src/shared/ui/IconButton.tsx
    - gui-app/src/shared/ui/DropOverlay.tsx
    - gui-app/src/shared/ui/DropOverlay.test.tsx
    - gui-app/src/shared/ui/PanelErrorBoundary.tsx
decisions:
  - "cn() implemented as minimal string-join utility without clsx/tailwind-merge (Plan 01 installs those; this is a stub that works correctly for these components)"
  - "DropOverlay keeps pointerEvents: 'none' as inline style (not Tailwind class) to keep test-observable behavior"
  - "SnackBar close button changed from hover:bg-white/10 to hover:bg-[var(--color-bg-hover)] to avoid hardcoded color"
  - "IconButton accepts both icon prop and legacy children prop for backward compatibility"
  - "node_modules junction link created in worktree to enable vitest execution"
metrics:
  duration: ~300s
  completed: 2026-04-13T20:29:00Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 14
---

# Phase 02 Plan 04: Select/SnackBar/IconButton/DropOverlay/PanelErrorBoundary Redesign Summary

Token-driven redesign of 5 remaining existing UI primitives: custom Select dropdown with full keyboard navigation and ARIA, SnackBar with fixed broken color token, IconButton with TypeScript-enforced aria-label, DropOverlay and PanelErrorBoundary with corrected token references.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Redesign Select + story + tests | f0bdb897 | Select.tsx, Select.test.tsx, Select.stories.tsx, cn.ts |
| 2 | Redesign SnackBar, IconButton, DropOverlay, PanelErrorBoundary + stories | ea3ba10e | 10 files |

## Implementation Details

### Task 1: Select

Full rewrite of `Select.tsx`:
- Removed `import { colors } from "./colors"` — zero colors.ts dependency
- Added `forwardRef` with combined internal `triggerRef` + external `ref` support
- Keyboard navigation: `ArrowDown/Up` (navigate), `Home/End` (jump to first/last), `Enter` (select), `Escape` (close), `Tab` (close and move focus)
- ARIA: `role="combobox"` on trigger, `aria-expanded`, `aria-haspopup="listbox"`, `aria-activedescendant`; `role="listbox"` on portal; `role="option"` + `aria-selected` per item; unique IDs via `useId()`
- `placeholder` prop added (default: `"Выберите..."`)
- `zIndex: "var(--z-dropdown)"` replaces hardcoded `9500`
- `colors.dropdownShadow` replaced with `var(--shadow-md)`
- `colors.accentBg` / `color-accent-500` replaced with `color-bg-active` / `color-accent-interactive`
- `useDropdownPortal` preserved as-is per plan constraint

Created `gui-app/src/shared/lib/cn.ts`: minimal string-merge utility (Plan 01 will upgrade to clsx+tailwind-merge; this stub is forward-compatible).

Tests expanded from 8 to 18: added ARIA role assertions, aria-expanded, listbox/option roles, aria-selected, keyboard nav (ArrowDown, Enter, Escape).

### Task 2: SnackBar, IconButton, DropOverlay, PanelErrorBoundary

**SnackBar** — key bug fix:
- `var(--color-error, #f97316)` → `var(--color-status-error)` (removes broken nonexistent token with orange fallback)
- `z-[10000]` → `zIndex: "var(--z-snackbar)"`
- `color-bg-secondary` → `color-bg-elevated`
- `hover:bg-white/10` → `hover:bg-[var(--color-bg-hover)]`
- Added `border-l-2 border-[var(--color-status-error)]` left accent for error items

**IconButton** — accessibility enforcement:
- `"aria-label": string` is now a required TypeScript prop
- `console.error("IconButton requires aria-label for accessibility")` in dev mode when missing
- Redesigned: `h-8 w-8`, `bg-transparent hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-active)]`
- `focus-visible:shadow-[var(--focus-ring)]`, `disabled:opacity-[var(--opacity-disabled)]`
- `forwardRef` added; accepts both `icon` and legacy `children` props

**DropOverlay** — token migration:
- `color: "#fff"` → `text-[var(--color-text-inverse)]`
- `fontSize: "18px"` → `text-[var(--font-size-lg)]`
- `fontWeight: 500` → `font-[var(--font-weight-semibold)]`
- `pointerEvents: "none"` kept as inline style (test-observable)

**PanelErrorBoundary** — token fixes:
- `text-red-500` → `text-[var(--color-danger-400)]`
- `var(--color-bg-tertiary)` (nonexistent) → `var(--color-bg-surface)` (correct token)
- `componentDidCatch` only logs stack trace in dev mode

**SnackBarContext** — verified clean, no changes needed.

### Infrastructure

Created `node_modules` junction link in worktree (`mklink /J`) to allow vitest execution from worktree directory.

## Test Results

| Test File | Tests | Result |
|-----------|-------|--------|
| Select.test.tsx | 18 | All pass |
| SnackBar.test.tsx | 8 | All pass |
| DropOverlay.test.tsx | 8 | All pass |
| **Total** | **34** | **34/34** |

## Deviations from Plan

### Auto-created Infrastructure (Rule 3)

**[Rule 3 - Blocking Issue] Created cn.ts stub before Plan 01 ran**
- **Found during:** Task 1
- **Issue:** Plan 01 (wave 1) was supposed to create `gui-app/src/shared/lib/cn.ts` and install clsx+tailwind-merge, but Plan 01 had not been executed when this wave 2 agent ran
- **Fix:** Created minimal `cn()` implementation that joins class strings without external dependencies. Compatible with future upgrade to clsx+tailwind-merge
- **Files modified:** `gui-app/src/shared/lib/cn.ts` (created)
- **Commit:** f0bdb897

### Rule 1 Fix: DropOverlay pointer-events

**[Rule 1 - Bug] Tailwind class vs inline style for pointer-events**
- **Found during:** Task 2 test run
- **Issue:** `pointer-events-none` Tailwind class not inspectable via `element.style.pointerEvents` in JSDOM — test `has pointer-events none to not block drag events` failed
- **Fix:** Kept `pointerEvents: "none"` as inline style alongside Tailwind class removal. The pointer-events behavior is functionally correct via either approach; inline style makes it test-observable
- **Commit:** ea3ba10e (part of Task 2 commit)

## Known Stubs

**cn.ts** (`gui-app/src/shared/lib/cn.ts`): Minimal implementation without clsx/tailwind-merge. Will not deduplicate conflicting Tailwind classes (e.g., `text-sm text-lg` → keeps both). Plan 01 should replace this with the full implementation. No runtime issues for current components.

## Threat Flags

None. Components render consumer-provided data with no new network endpoints, auth paths, or trust boundary crossings.

## Self-Check: PASSED

All 15 created/modified files verified present on disk. Both task commits (f0bdb897, ea3ba10e) confirmed in git log. No unexpected file deletions in either commit.
