---
phase: 02-update-ux
plan: 02
subsystem: frontend-ui
tags: [i18n, changelog, modal, about-panel]
dependency_graph:
  requires: [02-01]
  provides: [changelog-modal-wired, whats-new-button]
  affects: [gui-app/AboutPanel, gui-light/AboutScreen]
tech_stack:
  added: []
  patterns: [conditional-render, state-toggle, i18n-interpolation]
key_files:
  created: []
  modified:
    - gui-app/src/shared/i18n/locales/en.json
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-light/src/shared/i18n/locales/en.json
    - gui-light/src/shared/i18n/locales/ru.json
    - gui-app/src/components/AboutPanel.tsx
    - gui-light/src/components/AboutScreen.tsx
decisions:
  - Added whats_new key only (close and changelog_title already existed from plan 02-01)
metrics:
  duration: 251s
  completed: 2026-04-10T18:18:44Z
  tasks_completed: 2
  tasks_total: 2
requirements: [UPD-01, UPD-02]
---

# Phase 02 Plan 02: Wire ChangelogModal + i18n Keys Summary

Added buttons.whats_new i18n key to all 4 locale files and wired ChangelogModal into AboutPanel (gui-app) and AboutScreen (gui-light) with conditional "What's new" button and open/close state management.

## Tasks Completed

### Task 1: Add i18n keys to all four locale files
- **Commit:** 471b3340
- Added `buttons.whats_new` key to all 4 locale files (en: "What's new", ru: "Что нового")
- `buttons.close` and `modal.changelog_title` already present from plan 02-01 -- skipped to avoid duplication
- All 4 JSON files validated (parse without errors)

### Task 2: Wire ChangelogModal into AboutPanel and AboutScreen
- **Commit:** 4e314a4e
- Imported `ChangelogModal` and `FileText` icon in both components
- Added `changelogOpen` state variable for modal visibility toggle
- Added "What's new" button conditionally rendered only when `updateInfo.releaseNotes` is non-empty
- Button follows UI-SPEC: h-8, px-3, rounded-lg, var(--color-bg-hover) background, text-xs
- Rendered `<ChangelogModal>` with `version` (latestVersion fallback to currentVersion) and `releaseNotes` props
- Existing single-line truncated preview (releaseNotes.split("\n")[0]) preserved unchanged (D-09)
- TypeScript compiles cleanly for both gui-app and gui-light

## Deviations from Plan

None - plan executed exactly as written, except buttons.close and modal.changelog_title keys were already present from plan 02-01 execution (skipped to avoid duplication per instructions).

## Verification Results

- `grep "whats_new"` all 4 locale files: PASS (4 matches)
- `grep "changelog_title"` all 4 locale files: PASS (4 matches)
- `grep "ChangelogModal"` AboutPanel.tsx: 2 matches (import + render)
- `grep "ChangelogModal"` AboutScreen.tsx: 2 matches (import + render)
- `grep "releaseNotes.split"` both files: PASS (existing preview intact)
- `tsc --noEmit` gui-app: PASS (exit 0)
- `tsc --noEmit` gui-light: PASS (exit 0)
- All 4 JSON locale files: valid JSON (node parse check)

## Commit Log

| Task | Commit | Message |
|------|--------|---------|
| 1 | 471b3340 | feat(02-02): add buttons.whats_new i18n key to all 4 locale files |
| 2 | 4e314a4e | feat(02-02): wire ChangelogModal into AboutPanel and AboutScreen |
