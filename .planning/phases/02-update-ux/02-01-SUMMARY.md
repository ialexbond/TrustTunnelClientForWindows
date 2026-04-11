---
phase: 02-update-ux
plan: 01
subsystem: frontend
tags: [react-markdown, changelog, modal, i18n]
dependency_graph:
  requires: []
  provides: [ChangelogModal-component, react-markdown-dependency]
  affects: [gui-app, gui-light]
tech_stack:
  added: [react-markdown@^9.0.1]
  patterns: [CSS-variables-theming, ReactMarkdown-custom-components, tauri-shell-open]
key_files:
  created:
    - gui-app/src/components/ChangelogModal.tsx
    - gui-light/src/components/ChangelogModal.tsx
  modified:
    - gui-app/package.json
    - gui-light/package.json
    - gui-app/src/shared/i18n/locales/en.json
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-light/src/shared/i18n/locales/en.json
    - gui-light/src/shared/i18n/locales/ru.json
    - gui-app/package-lock.json
decisions:
  - react-markdown v9 (React-idiomatic, no innerHTML/sanitization concerns per D-01)
  - Added i18n keys modal.changelog_title and buttons.close to all 4 locale files (Rule 2 - missing i18n keys would cause runtime fallback text)
metrics:
  duration: 247s
  completed: 2026-04-10
  tasks: 2
  files: 9
---

# Phase 02 Plan 01: ChangelogModal + react-markdown Summary

react-markdown ^9.0.1 added to both apps; ChangelogModal renders markdown release notes with styled headers, lists, code blocks, and links via shell open()

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add react-markdown to both package.json | d2bc6515 | gui-app/package.json, gui-light/package.json |
| 2 | Create ChangelogModal component | fc2582f0 | gui-app/src/components/ChangelogModal.tsx, gui-light/src/components/ChangelogModal.tsx |
| - | Lock file update | 9e47a3bd | gui-app/package-lock.json |

## Implementation Details

### react-markdown dependency
- Added `"react-markdown": "^9.0.1"` to dependencies in both gui-app and gui-light package.json
- v9 ships own TypeScript types, no @types package needed

### ChangelogModal component
- Identical implementation in both gui-app and gui-light
- Wraps existing `Modal` component (closeOnBackdrop=true, closeOnEscape=true)
- Custom ReactMarkdown components for: h1, h2, h3, p, strong, em, ul, ol, li, hr, code (inline + block), a
- All colors via CSS variables (--color-bg-surface, --color-text-primary, etc.)
- Scrollable content: `overflow-y-auto` with `maxHeight: 320px` and `scroll-visible` class
- Links intercepted with `e.preventDefault()` and opened via `@tauri-apps/plugin-shell open()` (T-02-01 mitigation)
- i18n: `modal.changelog_title` with version interpolation, `buttons.close`

### i18n keys added (Rule 2 deviation)
- `modal.changelog_title`: "What's new in v{{version}}" / "Что нового в v{{version}}"
- `buttons.close`: "Close" / "Закрыть"
- Added to all 4 locale files (gui-app en/ru, gui-light en/ru)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] Added i18n keys for ChangelogModal**
- **Found during:** Task 2
- **Issue:** Component references `modal.changelog_title` and `buttons.close` i18n keys that did not exist in any locale file
- **Fix:** Added both keys to en.json and ru.json in gui-app and gui-light
- **Files modified:** gui-app/src/shared/i18n/locales/{en,ru}.json, gui-light/src/shared/i18n/locales/{en,ru}.json
- **Commit:** fc2582f0

## Threat Mitigations Applied

| Threat | Mitigation |
|--------|-----------|
| T-02-01 (link href tampering) | All links use `e.preventDefault()` + `@tauri-apps/plugin-shell open()`. No window.open or location changes. |
| T-02-02 (HTML injection via markdown) | react-markdown default behavior strips raw HTML. No rehype-raw plugin added. |

## Verification

- TypeScript `tsc --noEmit` passes with zero errors (gui-app)
- react-markdown found in both package.json files
- Both ChangelogModal.tsx files export named `ChangelogModal` function
- All acceptance criteria grep checks pass

## Self-Check: PASSED
