---
phase: 03-credential-generator
plan: 02
subsystem: frontend-forms
tags: [credential-generator, ui-wiring, shuffle-icon, i18n]
dependency_graph:
  requires: [credentialGenerator.ts from 03-01]
  provides: [Shuffle icons in AddUserForm and UsersSection]
  affects: [gui-app wizard, gui-app server panel]
tech_stack:
  added: []
  patterns: [Tooltip wrapping icon buttons, relative-positioned icon overlays]
key_files:
  created: []
  modified:
    - gui-app/src/shared/i18n/locales/en.json
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-app/src/components/wizard/AddUserForm.tsx
    - gui-app/src/components/server/UsersSection.tsx
decisions:
  - Shuffle icon at right-8 in password fields, Eye at right-2 (left-to-right order)
  - PasswordInput showIcon restored to true in UsersSection for Eye visibility
  - pr-14 in AddUserForm password, pr-16 in UsersSection password for dual icon space
metrics:
  duration: 199s
  completed: 2026-04-10
---

# Phase 03 Plan 02: Wire Credential Generator Icons Summary

Shuffle icons wired into both VPN user forms (wizard AddUserForm + server UsersSection) using credentialGenerator utility from Plan 01, with i18n tooltips in EN/RU.

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add i18n keys for generator tooltips | 74a7b40f | en.json, ru.json |
| 2 | Wire generator icons into AddUserForm and UsersSection | e8f34795 | AddUserForm.tsx, UsersSection.tsx |

## Changes Made

### Task 1: i18n Keys
- Added `common.generate_username` and `common.generate_password` to both en.json and ru.json
- EN: "Generate random username" / "Generate random password"
- RU: "Сгенерировать имя пользователя" / "Сгенерировать пароль"

### Task 2: Shuffle Icon Wiring

**AddUserForm.tsx (wizard):**
- Username input: wrapped in relative div, added pr-8, Shuffle button at right-2 with Tooltip
- Password input: changed pr-8 to pr-14, added Shuffle button at right-8 before existing Eye button
- Both Shuffle buttons disabled during `w.addingUser` state
- Imported Shuffle from lucide-react, Tooltip, generateUsername/generatePassword

**UsersSection.tsx (server panel):**
- Username Input: wrapped in `relative flex-1` div, added pr-8 className, Shuffle at right-2
- Password PasswordInput: removed `showIcon={false}` (Eye button now visible), wrapped in `relative flex-1` div, added pr-16 className, Shuffle at right-9
- Both Shuffle buttons disabled during `isAdding` state
- Added Shuffle to lucide import, imported Tooltip and credentialGenerator

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

- TypeScript `tsc --noEmit`: PASSED (zero errors)
- All grep acceptance criteria: PASSED
- i18n keys verified with Node.js require: PASSED

## Awaiting Human Verification

Task 3 (checkpoint:human-verify) requires visual/functional verification of Shuffle icons in both forms.
