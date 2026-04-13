---
phase: 02-ssh-port-change-core-engine
plan: 03
subsystem: ui
tags: [react, tailwind, storybook, vitest, design-tokens, modal, toggle, card, tooltip, confirm-dialog]

requires:
  - phase: 02-ssh-port-change-core-engine
    provides: tokens.css with --z-modal, --z-dropdown, --color-toggle-on/off, --color-bg-surface, --focus-ring tokens

provides:
  - Modal component with sm/md/lg size variants, --z-modal token, forwardRef, Portal
  - ConfirmDialog using redesigned Modal + Button with Russian defaults
  - Toggle with role=switch, aria-checked, focus-visible ring, --color-toggle-on/off
  - Card with --color-bg-surface, --color-border, --radius-lg, --shadow-sm tokens
  - Tooltip with --z-dropdown token (z-index conflict fixed)
  - 5 Storybook story files with autodocs tags
  - 57 tests across all 5 components

affects: [screens using Modal, ConfirmDialog, Toggle, Card, Tooltip]

tech-stack:
  added: []
  patterns:
    - "Backwards-compat dual props: isOpen/open, checked/value, confirmText/confirmLabel"
    - "Token-driven Tailwind: bg-[var(--token)], z-[var(--token)] throughout"
    - "forwardRef on interactive primitives (Toggle)"
    - "CVA-free size variants via plain Record<Size, string> maps"

key-files:
  created:
    - gui-app/src/shared/ui/Modal.stories.tsx
    - gui-app/src/shared/ui/ConfirmDialog.stories.tsx
    - gui-app/src/shared/ui/Toggle.stories.tsx
    - gui-app/src/shared/ui/Card.stories.tsx
    - gui-app/src/shared/ui/Tooltip.stories.tsx
  modified:
    - gui-app/src/shared/ui/Modal.tsx
    - gui-app/src/shared/ui/Modal.test.tsx
    - gui-app/src/shared/ui/ConfirmDialog.tsx
    - gui-app/src/shared/ui/ConfirmDialog.test.tsx
    - gui-app/src/shared/ui/Toggle.tsx
    - gui-app/src/shared/ui/Toggle.test.tsx
    - gui-app/src/shared/ui/Card.tsx
    - gui-app/src/shared/ui/Card.test.tsx
    - gui-app/src/shared/ui/Tooltip.tsx
    - gui-app/src/shared/ui/Tooltip.test.tsx

key-decisions:
  - "No clsx/CVA dependency — project uses plain template strings, kept consistent"
  - "Dual props pattern for backwards compat: isOpen+open, checked+value, confirmText+confirmLabel"
  - "Toggle uses forwardRef to support ref forwarding in form contexts"
  - "Card switches from inline style backgroundColor to Tailwind bg-[var()] class for token class testability"

patterns-established:
  - "Size variants: Record<Size, className> map, no external library"
  - "Token classes: bg-[var(--token)] / z-[var(--token)] preferred over inline style for testability"
  - "Accessibility: role=switch + aria-checked on Toggle, Escape key on Modal"
  - "Backwards compat: deprecated props aliased, not removed"

requirements-completed: [COMP-01, COMP-06, COMP-14, SB-04, SB-05]

duration: 15min
completed: 2026-04-14
---

# Phase 02 Plan 03: Modal/ConfirmDialog/Toggle/Card/Tooltip Primitive Redesign Summary

**5 token-driven UI primitives redesigned with z-index fix (9500→--z-dropdown), size variants (Modal), focus-visible accessibility (Toggle), and full Storybook stories**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-14T01:14:00Z
- **Completed:** 2026-04-14T01:20:00Z
- **Tasks:** 2
- **Files modified:** 15 (10 modified, 5 created)

## Accomplishments

- Modal: hardcoded `zIndex: 9000` удалён, заменён на `z-[var(--z-modal)]`; добавлены размеры sm/md/lg
- ConfirmDialog: дефолты "Удалить"/"Отмена", использует обновлённый Modal с `size="sm"`
- Toggle: добавлен `role="switch"` + `aria-checked`, `focus-visible:shadow-[var(--focus-ring)]` (отсутствовал согласно Research-аудиту)
- Card: `backgroundColor` inline style заменён на `bg-[var(--color-bg-surface)]` Tailwind-класс; добавлен `shadow-[var(--shadow-sm)]`
- Tooltip: `z-[9500]` заменён на `z-[var(--z-dropdown)]`
- 5 story-файлов с тегом `autodocs` для Storybook
- 57 тестов прошло

## Task Commits

1. **Task 1: Modal + ConfirmDialog + stories + tests** — `a6959450` (feat)
2. **Task 2: Toggle + Card + Tooltip + stories + tests** — `b642701a` (feat)

## Files Created/Modified

- `gui-app/src/shared/ui/Modal.tsx` — размеры sm/md/lg, --z-modal токен, isOpen/open dual props
- `gui-app/src/shared/ui/Modal.test.tsx` — 13 тестов: size variants, z-index, overlay/escape/content click
- `gui-app/src/shared/ui/Modal.stories.tsx` — Default, Small, Large, WithTitle, WithLongContent
- `gui-app/src/shared/ui/ConfirmDialog.tsx` — "Удалить"/"Отмена" дефолты, confirmText/confirmLabel dual props
- `gui-app/src/shared/ui/ConfirmDialog.test.tsx` — 13 тестов: defaults, legacy props, variants
- `gui-app/src/shared/ui/ConfirmDialog.stories.tsx` — Default, CustomText, WithLongMessage
- `gui-app/src/shared/ui/Toggle.tsx` — role=switch, aria-checked, focus-visible, checked/value dual props
- `gui-app/src/shared/ui/Toggle.test.tsx` — 12 тестов: accessibility, focus-visible, opacity-disabled
- `gui-app/src/shared/ui/Toggle.stories.tsx` — Default, Checked, Disabled, WithLabel, AllStates
- `gui-app/src/shared/ui/Card.tsx` — bg-surface токен класс, shadow-sm, radius-lg
- `gui-app/src/shared/ui/Card.test.tsx` — 12 тестов: token classes, no hex colors, CardHeader
- `gui-app/src/shared/ui/Card.stories.tsx` — Default, WithHeader, WithContent, Empty
- `gui-app/src/shared/ui/Tooltip.tsx` — z-[var(--z-dropdown)] вместо z-[9500]
- `gui-app/src/shared/ui/Tooltip.test.tsx` — 7 тестов: hover/leave/delay + z-index проверка
- `gui-app/src/shared/ui/Tooltip.stories.tsx` — Default, Positions, LongText

## Decisions Made

- **No clsx/CVA:** проект не использует эти библиотеки, сохранён единый стиль шаблонных строк
- **Dual props для backwards compat:** `isOpen`/`open`, `checked`/`value`, `confirmText`/`confirmLabel` — deprecated props алиасируются, не удаляются
- **Card: class вместо inline style:** `bg-[var(--color-bg-surface)]` как Tailwind-класс позволяет тестировать через `className` без jsdom CSSOM
- **Toggle: forwardRef:** добавлен для поддержки ref в форм-контекстах

## Deviations from Plan

None — план выполнен точно как описан. Дополнительно сохранена обратная совместимость через dual-props паттерн (не нарушает plan-контракт, расширяет его).

## Issues Encountered

- **node_modules в worktree:** при сбросе базы до `d7af542a` в worktree отсутствовали node_modules. Решено созданием Windows junction на `gui-app/node_modules` из основного репозитория через `New-Item -ItemType Junction`. Тесты запустились корректно.

## Known Stubs

None — все компоненты полностью реализованы с реальными токенами.

## Threat Flags

None — компоненты рендерят пользовательский React children/text. Угрозы T-02-03-01 и T-02-03-02 из threat model плана приняты (accept disposition).

## Next Phase Readiness

- Все 5 примитивов готовы для использования в redesigned экранах
- Modal/ConfirmDialog используются в существующих экранах — обратная совместимость обеспечена через dual props
- Storybook stories готовы для визуального review
- Никаких блокеров для следующих планов Phase 02

---
*Phase: 02-ssh-port-change-core-engine*
*Completed: 2026-04-14*

## Self-Check: PASSED

- All 15 source files exist
- All 5 story files exist
- Commit a6959450 (Task 1) found
- Commit b642701a (Task 2) found
- SUMMARY.md created
