---
phase: 11-screen-ux-redesign
plan: "05"
subsystem: server-panel, shared-ui, memory-docs
tags: [tests, documentation, overview-section, server-settings, service-section, overflow-menu]
dependency_graph:
  requires: ["11-04"]
  provides: ["test coverage for all 4 new server panel sections", "updated memory documentation"]
  affects:
    - gui-pro/src/components/server/OverviewSection.test.tsx
    - gui-pro/src/components/server/ServerSettingsSection.test.tsx
    - gui-pro/src/components/server/ServiceSection.test.tsx
    - gui-pro/src/shared/ui/OverflowMenu.test.tsx
    - gui-pro/src/components/server/ServerStatusSection.test.tsx
    - memory/v3/screens/control-panel.md
    - memory/v3/design-system/components.md
tech_stack:
  added: []
  patterns: ["vitest render/screen/fireEvent", "vi.mock for sub-components and hooks", "ARIA role queries"]
key_files:
  created:
    - gui-pro/src/components/server/OverviewSection.test.tsx
    - gui-pro/src/components/server/ServerSettingsSection.test.tsx
    - gui-pro/src/components/server/ServiceSection.test.tsx
    - gui-pro/src/shared/ui/OverflowMenu.test.tsx
    - memory/v3/screens/control-panel.md
    - memory/v3/design-system/components.md
  modified:
    - gui-pro/src/components/server/ServerStatusSection.test.tsx
decisions:
  - "ServerStatusSection.test.tsx: removed tests for stop/restart/reboot buttons (moved to ServiceSection per Phase 11 redesign)"
  - "UsersSection.test.tsx: already updated in 11-04 with OverflowMenu ARIA queries — not modified in 11-05"
  - "pre-existing ProcessFilterSection test failure is out-of-scope and not fixed"
  - "memory/ directory is gitignored per project design — files created but not tracked in git"
metrics:
  duration: "~8 min"
  completed: "2026-04-15"
  tasks_completed: 2
  files_changed: 5
---

# Phase 11 Plan 05: Tests + Memory Documentation Summary

**One-liner:** Test coverage for all 4 redesigned server panel sections (OverviewSection/ServerSettingsSection/ServiceSection/OverflowMenu) plus updated memory documentation reflecting the new 4-tab architecture.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create tests for new components + update existing tests | 748b75e1 | 5 test files (4 new + 1 updated) |
| 2 | Update memory documentation for new 4-tab structure | (gitignored) | memory/v3/screens/control-panel.md, memory/v3/design-system/components.md |
| 3 | Visual verification checkpoint | — | Awaiting manual verification |

## What Was Built

### New Test Files

**OverviewSection.test.tsx** (12 tests):
- Status indicator renders (running/stopped), rebooting state
- 4 StatCards present (version/protocol/port/users)
- CertSection sub-component rendered
- NO danger buttons rendered (DC-01 enforcement)
- NO host IP in status row (DC-03 enforcement)
- null serverInfo → empty render
- Ping badge async display
- Refresh button calls loadServerInfo

**ServerSettingsSection.test.tsx** (7 tests):
- Feature toggles section title present
- BBR toggle in network section
- Advanced Accordion collapsed by default
- Save settings button uses `server.config.save_settings` key
- SshPortSection rendered
- Feature items (Ping/Speedtest/IPv6) when configRaw loaded
- Loading indicator when configRaw is null

**ServiceSection.test.tsx** (11 tests):
- Service controls title present
- Restart button present
- Stop/Start buttons conditional on serviceActive
- DangerZone in collapsed Accordion
- SecuritySection rendered (diagnostics)
- `aria-live="polite"` wrapper present (R-02 a11y)
- Stop button opens ConfirmDialog
- Restart calls runAction
- LogsSection rendered

**OverflowMenu.test.tsx** (15 tests):
- Trigger has `aria-haspopup="menu"`, `aria-expanded=false/true`
- Opens on click, shows `role="menu"`
- All items render with `role="menuitem"`
- Closes on Escape key, click outside, item selection
- onSelect callback called
- Destructive item has `color: var(--color-destructive)`
- Disabled item not triggered (toBeDisabled)
- ArrowDown/Up keyboard navigation
- Loading spinner for loading item
- Menu label matches triggerAriaLabel

### Updated Test Files

**ServerStatusSection.test.tsx** (19 tests → removed danger button tests):
- Removed: "shows restart and stop buttons when service is active"
- Removed: "always shows reboot server button regardless of service state"
- Removed: related stop/start/restart/reboot button interaction tests
- Kept: status display, ping badge, rebooting state, soft refresh, ping variants

**UsersSection.test.tsx** (unchanged in 11-05):
- Already updated in 11-04 with OverflowMenu ARIA queries (38 tests, all pass)

### Memory Documentation

**memory/v3/screens/control-panel.md** (new file):
- Documents new 4-tab structure: Обзор/Пользователи/Настройки/Сервис
- Component tree, block-by-block content description
- State management table, user flows UF-01 through UF-04
- Cross-fade tab switching pattern
- i18n keys table
- A11y fixes applied summary

**memory/v3/design-system/components.md** (new file in worktree):
- OverflowMenu entry: props, trigger, ARIA, keyboard nav, usage
- Phase 9 components: Skeleton, StatusIndicator, StatCard, Accordion
- Phase 11 accent color fix documentation
- Updated index exports list (33 total components)

### Visual Verification (Task 3 — Checkpoint)

Task 3 is a `checkpoint:human-verify` — requires manual visual approval. The redesign is complete and tests pass. User should verify:

1. `cd gui-pro && npm run dev` to start dev server
2. Connect to SSH server in the app
3. Verify 4 tabs: Обзор, Пользователи, Настройки, Сервис
4. **Обзор:** StatusIndicator dot, 4 StatCards 2×2 grid, TLS cert. No danger buttons.
5. **Пользователи:** ⋯ overflow menu per user row, dropdown with 4 actions, Delete in red.
6. **Настройки:** Feature toggles with descriptions, BBR toggle, "Дополнительно" accordion collapsed.
7. **Сервис:** Restart/stop buttons, SecuritySection, LogsSection, "Опасная зона" collapsed.
8. Tab cross-fade animation smooth.
9. Keyboard Tab through bottom nav bar — focus ring visible.
10. Light theme — accent buttons readable (accent-500 fix).
11. Dark theme — all elements readable.

## Test Results

```
Test Files  104 passed | 1 failed (pre-existing) | 3 skipped (105)
Tests       1406 passed | 1 failed (pre-existing) | 21 todo (1427)
```

The 1 failing test (`ProcessFilterSection.test.tsx > calls onLoadProcesses and opens picker on add click`) is a **pre-existing failure** unrelated to Plan 05 changes. It existed before this plan and is out of scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ServerSettingsSection.test.tsx — getByText found multiple elements for "Загрузка..."**
- **Found during:** Task 1, ServerSettingsSection tests
- **Issue:** `configRaw = null` causes the component to show loading text in both the features section AND the warning banner. `getByText` throws "multiple elements found".
- **Fix:** Changed to `getAllByText(...)` + `expect(loadingElements.length).toBeGreaterThanOrEqual(1)`
- **Files modified:** `ServerSettingsSection.test.tsx`
- **Commit:** 748b75e1

### Implementation Note: memory/ is gitignored

Per CLAUDE.md and project convention, the `memory/` directory is gitignored. Memory files are created in the worktree but not tracked in git. This is expected behaviour — the files exist at the filesystem level and serve their documentation purpose.

## Known Stubs

None — this plan creates test and documentation files only, no production code changes.

## Threat Flags

None — test files and documentation only, no new runtime surfaces introduced.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| OverviewSection.test.tsx exists (12 tests) | FOUND |
| ServerSettingsSection.test.tsx exists (7 tests) | FOUND |
| ServiceSection.test.tsx exists (11 tests) | FOUND |
| OverflowMenu.test.tsx exists (15 tests) | FOUND |
| ServerStatusSection.test.tsx updated | FOUND |
| danger button tests removed from ServerStatusSection.test.tsx | CONFIRMED (grep: 0 matches) |
| OverflowMenu/actions_menu in UsersSection.test.tsx | CONFIRMED (17 matches) |
| All new tests pass (1406/1427) | CONFIRMED |
| memory/v3/screens/control-panel.md created | FOUND |
| memory/v3/design-system/components.md created | FOUND |
| Commit 748b75e1 (Task 1) | FOUND |
