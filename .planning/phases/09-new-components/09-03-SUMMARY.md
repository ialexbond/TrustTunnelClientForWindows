---
phase: 09-new-components
plan: "03"
subsystem: shared-ui
tags: [component, stat-card, skeleton, barrel-export, storybook]
dependency_graph:
  requires: [09-01, 09-02]
  provides: [StatCard, barrel-exports-phase-9]
  affects: [phase-11-dashboard]
tech_stack:
  added: []
  patterns: [Card-wrapper, Skeleton-loading-state, CVA-variants, auto-color-trend]
key_files:
  created:
    - gui-app/src/shared/ui/StatCard.tsx
    - gui-app/src/shared/ui/StatCard.stories.tsx
    - gui-app/src/shared/ui/StatCard.test.tsx
  modified:
    - gui-app/src/shared/ui/index.ts
decisions:
  - "StatCard wraps Card (padding=md) rather than reimplementing card styles — consistent with existing Card component"
  - "Trend value 0 is hidden (not shown as 0%) — zero trend is irrelevant visually"
  - "AccordionItem exported as type from index.ts — follows UI-SPEC barrel export contract"
metrics:
  duration: "~5 min"
  completed: "2026-04-15T11:52:16Z"
  tasks_completed: 2
  files_created: 3
  files_modified: 1
---

# Phase 09 Plan 03: StatCard + Barrel Exports Summary

StatCard component wrapping Card with value/label/trend/icon layout and Skeleton loading state; all 4 Phase 9 components barrel-exported from shared/ui/index.ts.

## What Was Built

### Task 1: StatCard component + story + test

**StatCard.tsx** — презентационный компонент для Dashboard метрик (Phase 11):
- Оборачивает `Card` с `padding="md"` (не переопределяет card-стили)
- Layout: icon (top-left, `aria-hidden="true"`) + trend (top-right), value (xl semibold), label (sm muted)
- Тренд: positive → `+N%` зелёным (`--color-status-connected`), negative → `-N%` красным (`--color-status-error`), 0 → скрыт
- Loading-состояние: 3 Skeleton-плейсхолдера (circle 16x16 + line 60% + line 40%)
- Все цвета через CSS-токены, без hardcoded hex

**StatCard.stories.tsx** — 5 историй: Default, WithIcon, WithTrend (3 варианта), Loading, DashboardGrid (2x2 grid)

**StatCard.test.tsx** — 10 тестов: рендер value/label, Skeleton при loading, aria-hidden иконки, форматирование тренда (+/-/0/undefined)

### Task 2: Barrel export update

**index.ts** обновлён с 25 до 29 экспортов. Добавлено в алфавитном порядке:
- `Accordion, type AccordionItem` (позиция: перед ActionInput)
- `Skeleton` (после Separator)
- `StatCard` (после SnackBarProvider)
- `StatusIndicator` (после StatusBadge)

Полный тест-сюит: **1373 тестов из 1373 прошли** (98 test-файлов). TypeScript ошибки — только предсуществующие (FoundStep.tsx, IconButton.tsx и др.), наши файлы без ошибок.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1    | e296b448 | feat(09-03): add StatCard component with Skeleton loading state and Storybook stories |
| 2    | d381b9c0 | feat(09-03): barrel-export all 4 new Phase 9 components from shared/ui/index.ts |

## Deviations from Plan

None — план выполнен точно по спецификации.

## Known Stubs

None — StatCard получает данные через props, без заглушек.

## Threat Flags

None — StatCard презентационный, данные передаются как примитивы (string/number), нет новых сетевых/auth поверхностей.

## Self-Check: PASSED

- [x] gui-app/src/shared/ui/StatCard.tsx — создан (e296b448)
- [x] gui-app/src/shared/ui/StatCard.stories.tsx — создан (e296b448)
- [x] gui-app/src/shared/ui/StatCard.test.tsx — создан (e296b448)
- [x] gui-app/src/shared/ui/index.ts — обновлён (d381b9c0)
- [x] 10 тестов StatCard — все прошли
- [x] Полный тест-сюит 1373/1373 — зелёный
- [x] index.ts содержит 29 экспортов
