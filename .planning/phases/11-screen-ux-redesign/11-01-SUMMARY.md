---
phase: 11-screen-ux-redesign
plan: "01"
subsystem: design-system / a11y
tags: [a11y, wcag, tokens, focus-ring, contrast]
requires: []
provides:
  - light-theme-accent-contrast-fix
  - focus-visible-ring-tab-navigation
  - focus-visible-ring-inputs
affects:
  - gui-pro/src/shared/styles/tokens.css
  - gui-pro/src/components/layout/TabNavigation.tsx
  - gui-pro/src/components/LogPanel.tsx
  - gui-pro/src/components/routing/AddRuleInput.tsx
  - gui-pro/src/components/server/ConfigSection.tsx
  - gui-pro/src/components/settings/TunnelSection.tsx
  - gui-pro/src/components/routing/ProcessPickerModal.tsx
  - gui-pro/src/components/server/VersionSection.tsx
  - gui-pro/src/components/server/SshConnectForm.tsx
tech-stack:
  added: []
  patterns:
    - focus-visible:shadow-[var(--focus-ring)] paired with outline-none
    - CSS custom property cascade for accent-500 in light theme
key-files:
  created: []
  modified:
    - gui-pro/src/shared/styles/tokens.css
    - gui-pro/src/components/layout/TabNavigation.tsx
    - gui-pro/src/components/LogPanel.tsx
    - gui-pro/src/components/routing/AddRuleInput.tsx
    - gui-pro/src/components/server/ConfigSection.tsx
    - gui-pro/src/components/settings/TunnelSection.tsx
    - gui-pro/src/components/routing/ProcessPickerModal.tsx
    - gui-pro/src/components/server/VersionSection.tsx
    - gui-pro/src/components/server/SshConnectForm.tsx
decisions:
  - "Light theme accent-500 (#2d7a76) selected — passes WCAG AA 4.5:1 contrast with white text"
  - "focus-visible:shadow-[var(--focus-ring)] added to outer button in TabNavigation (not just inner span)"
  - "ConfigSection toggle uses focus:outline-none pattern — added focus-visible:shadow alongside it"
metrics:
  duration: "182s (~3 min)"
  completed: "2026-04-15"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 9
---

# Phase 11 Plan 01: A11y Contrast + Focus Rings Summary

Light theme accent-500 WCAG AA contrast fix and focus-visible rings on TabNavigation + 8 inputs/buttons.

## What Was Built

### Task 1: Light theme accent contrast fix (tokens.css)

Исправлен критический WCAG AA баг P-03/BUG-01: акцентный цвет в светлой теме был `accent-600` (#236260 + white = ~4.2:1 — ниже порога 4.5:1). Изменено на `accent-500` (#2d7a76 + white ≥ 4.5:1).

Изменения в `tokens.css` (секция светлой темы):
- `--color-accent-interactive`: `accent-600` → `accent-500`
- `--color-input-focus`: `accent-600` → `accent-500`
- `--color-toggle-on`: `accent-600` → `accent-500`
- `--color-accent-hover`: `accent-700` → `accent-600` (hover остаётся темнее interactive)
- `--color-accent-active`: `accent-800` → `accent-700`

Тёмная тема не изменена (`accent-400` остаётся).

### Task 2: Focus-visible rings (9 элементов)

Добавлен `focus-visible:shadow-[var(--focus-ring)]` к 9 интерактивным элементам с `outline-none`:

| Файл | Элемент | Issue |
|------|---------|-------|
| `TabNavigation.tsx` | `<button role="tab">` (нижний tab bar) | O-01/O-03 критичный |
| `LogPanel.tsx` | `<input>` поиск логов | O-02 |
| `AddRuleInput.tsx` | `<input>` добавление правила | O-02 |
| `ConfigSection.tsx` | `<button>` переключатель фичей | O-02 |
| `TunnelSection.tsx` | `<input>` MTU size | O-02 |
| `ProcessPickerModal.tsx` | `<input>` поиск процессов | O-02 |
| `VersionSection.tsx` | `<button>` trigger dropdown | O-02 |
| `SshConnectForm.tsx` | `<textarea>` SSH-ключ | O-02 |

## Verification

- `grep -c "focus-visible:shadow-\[var(--focus-ring)\]" TabNavigation.tsx` → 1 ✓
- Автоматическая проверка: `grep -rn "outline-none" <8 файлов> | grep -v "focus-visible"` → пусто ✓
- Тесты: 98 файлов пройдено, 0 провалов ✓

## Deviations from Plan

### Auto-fixed Issues

None — план выполнен точно как написан.

### Замечания

- `LogPanel.tsx` находится в `gui-pro/src/components/` (не в `components/dashboard/` как указано в плане). Исправлено автоматически при поиске файла.
- `TunnelSection.tsx` находится в `gui-pro/src/components/settings/` (не в `components/connection/`). Исправлено автоматически.
- `ConfigSection.tsx` использует `focus:outline-none` (не просто `outline-none`) на toggle button — добавлен `focus-visible:shadow-[var(--focus-ring)]` рядом.
- В worktree отсутствовали node_modules — установлены через `npm install --legacy-peer-deps` перед запуском тестов (Rule 3).

## Known Stubs

None — изменения чисто CSS/className, без данных или плейсхолдеров.

## Threat Flags

None — чисто CSS/className изменения, нет новых trust boundaries или network поверхностей.

## Commits

| Hash | Описание |
|------|---------|
| `b5fdf87c` | fix(11-01): light theme accent-500 contrast fix (P-03/BUG-01 WCAG AA) |
| `455f499f` | fix(11-01): add focus-visible ring to TabNavigation + 8 inputs (O-01/O-02 WCAG AA) |

## Self-Check: PASSED

- tokens.css: FOUND
- TabNavigation.tsx: FOUND
- 11-01-SUMMARY.md: FOUND
- commit b5fdf87c: FOUND
- commit 455f499f: FOUND
