---
phase: 09-new-components
plan: "02"
subsystem: shared/ui
tags: [accordion, collapse, hook, storybook, aria, animation]
dependency_graph:
  requires: []
  provides:
    - useCollapse hook (shared/hooks/useCollapse.ts)
    - Accordion component (shared/ui/Accordion.tsx)
    - Accordion Storybook stories (shared/ui/Accordion.stories.tsx)
    - Accordion tests (shared/ui/Accordion.test.tsx)
  affects:
    - gui-pro/src/shared/ui/Section.tsx (refactored to use useCollapse)
    - Phase 10 CP-03 (Accordion used for DangerZone in Tools tab)
tech_stack:
  added:
    - useCollapse hook (useState + useCallback pattern)
    - Accordion component with Set<string> state for openIds
  patterns:
    - useId() for unique aria IDs per AccordionItem
    - grid-template-rows 0fr/1fr collapse animation (matches Section.tsx)
    - Set<string> for efficient multi-open tracking
    - single prop for exclusive open mode (next.clear() before add)
key_files:
  created:
    - gui-pro/src/shared/hooks/useCollapse.ts
    - gui-pro/src/shared/ui/Accordion.tsx
    - gui-pro/src/shared/ui/Accordion.stories.tsx
    - gui-pro/src/shared/ui/Accordion.test.tsx
  modified:
    - gui-pro/src/shared/ui/Section.tsx
decisions:
  - "useCollapse uses useCallback for toggle to avoid stale closure"
  - "AccordionItemComponent is internal (not exported) — only Accordion and AccordionItem interface are public"
  - "Set<string> for openIds — O(1) lookup for open state check"
  - "single mode calls next.clear() before adding new id — ensures exclusive open"
  - "aria-hidden on content div + role=region + aria-labelledby for full ARIA compliance"
  - "visibility:hidden when closed protects screen readers from hidden content"
metrics:
  duration: "~2m 8s"
  completed_date: "2026-04-15"
  tasks_completed: 2
  files_changed: 5
---

# Phase 09 Plan 02: Accordion Component Summary

**One-liner:** useCollapse hook extracted from Section.tsx; Accordion built with multi/single open modes, grid-template-rows animation, full ARIA, Storybook stories, and 10 passing tests.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extract useCollapse hook + refactor Section.tsx | 61502b91 | useCollapse.ts (new), Section.tsx (modified) |
| 2 | Accordion component + story + test | 98c86f46 | Accordion.tsx, Accordion.stories.tsx, Accordion.test.tsx |

## What Was Built

### Task 1: useCollapse hook + Section.tsx refactoring

`gui-pro/src/shared/hooks/useCollapse.ts` — новый хук:
- `useState(defaultOpen)` + `useCallback` для toggle
- Возвращает `{ open, toggle, setOpen }` — публичный контракт
- Паттерн совпадает с useTheme.ts: named export, return object

`gui-pro/src/shared/ui/Section.tsx` — рефакторинг:
- Убран `import { useState }` — заменён на `import { useCollapse }`
- `const [open, setOpen] = useState(defaultOpen)` → `const { open, setOpen } = useCollapse(defaultOpen)`
- Все 6 существующих тестов Section прошли без изменений (backward compatible)

### Task 2: Accordion component + Storybook + tests

`gui-pro/src/shared/ui/Accordion.tsx`:
- `AccordionItem` interface (экспортируется для использования в Phase 10)
- `Accordion` функция: `openIds: Set<string>`, `toggle(id)` с очисткой при `single` режиме
- `AccordionItemComponent` (внутренний, не экспортируется): `useId()` для aria IDs
- Анимация: `grid-template-rows: open ? "1fr" : "0fr"` + `transition duration-200 ease-out` (идентично Section.tsx)
- ARIA: `aria-expanded={open}` на кнопке, `aria-hidden={!open}` + `role="region"` + `aria-labelledby={headerId}` на контенте
- `visibility: hidden` при закрытом состоянии для защиты screen reader
- `ChevronDown` поворачивается на 180° при `open && "rotate-180"`
- `border-b border-[var(--color-border)]` разделитель между пунктами (кроме последнего)
- `focus-visible:shadow-[var(--focus-ring)]` на кнопке заголовка

`gui-pro/src/shared/ui/Accordion.stories.tsx`:
- `title: "Primitives/Accordion"` — в категории Primitives вместе с Section
- `tags: ["autodocs"]` — автоматическая документация
- 4 story: Default, MultiOpen (первые 2 открыты), SingleMode (эксклюзивный), AllClosed

`gui-pro/src/shared/ui/Accordion.test.tsx`:
- 10 тестов: renders headers, all closed by default, defaultOpen, expand on click, collapse on click, multi-open, single mode, aria-expanded, aria-hidden, role=region+aria-labelledby
- Все 10 тестов прошли; все 6 Section тестов прошли (16 из 16)

## Test Results

```
Test Files  2 passed (2)
     Tests  16 passed (16)
  Section   6 passed (backward compatible)
  Accordion 10 passed (new)
```

## Deviations from Plan

None — план выполнен точно как написан.

При старте ворктри не было `node_modules` — установлено `npm install --legacy-peer-deps` (peer deps конфликт с eslint-plugin-react-hooks ^7.0.1). Это стандартная процедура для ворктри, не отклонение от плана.

## Threat Flags

None — Accordion является чисто презентационным компонентом, без сетевых вызовов, аутентификации или файлового доступа. React escaping защищает от XSS в ReactNode content. useId() генерирует непрозрачные, не угадываемые IDs.

## Self-Check: PASSED

- [x] gui-pro/src/shared/hooks/useCollapse.ts — создан
- [x] gui-pro/src/shared/ui/Section.tsx — рефакторинг применён (useCollapse импортирован)
- [x] gui-pro/src/shared/ui/Accordion.tsx — создан
- [x] gui-pro/src/shared/ui/Accordion.stories.tsx — создан
- [x] gui-pro/src/shared/ui/Accordion.test.tsx — создан
- [x] Commit 61502b91 — Task 1 (useCollapse + Section.tsx)
- [x] Commit 98c86f46 — Task 2 (Accordion + stories + tests)
- [x] 16/16 tests pass
